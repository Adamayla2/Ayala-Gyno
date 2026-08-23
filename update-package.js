/* ============================================================================
   AYLA GYNO Master Bank — Offline Update Package System
   ----------------------------------------------------------------------------
   Adds:
     Student: Settings -> Import Update  (.entpkg / .zip / .json)
     Admin:   Settings -> Export Update, Database Version, Backup Database,
              Restore Backup

   Design notes (kept here rather than scattered in comments below):

   - CONTENT vs USER DATA. Two different kinds of thing live in this app's
     database. "Content" (questions, lectures/summaries, flashcards, book
     metadata, taxonomy) is what update packages carry and are allowed to
     add/update. "User data" (bookmarks, notes, exam history, performance,
     highYield/favorites, study streak/goal) belongs to the person studying
     and is never read from or written to by the import/merge engine below.

   - STABLE IDS. IndexedDB's own auto-increment `id` is local to each
     device/install and is NOT safe to use as a cross-device identity (two
     different phones can both have a question with local id 5 that are
     completely unrelated). Every content item therefore also carries a
     `uid` (a UUID) that travels with it inside packages. Merges match on
     `uid`, then update the existing row in place (same local `id`) so that
     bookmarks/notes/performance rows -- which point at the local `id` --
     never go stale. Pre-existing rows from before this system was added
     get a `uid` assigned automatically on first load (see ensureUidsBackfilled).

   - CHECKSUM vs SIGNATURE. manifest.checksum is a real SHA-256 hash of
     database.json, verified on import, and it does its job: it catches
     corruption and accidental edits. manifest.signature is left as an
     honest placeholder (see SIGNATURE_NOTE below) rather than dressed up
     to look like real authentication -- with no server and a single code
     bundle shared by every install, there is nowhere to keep a signing key
     secret from the people the signature would need to be secret from.

   - COMPRESSION. .entpkg files are ordinary zip archives (built with the
     vendored JSZip). Entries are written uncompressed (STORE) rather than
     DEFLATEd -- this was a deliberate choice made after testing, see the
     project notes; reading DEFLATE-compressed zips (e.g. one a student
     zipped up some other way) still works fine, only this app's own writer
     uses STORE. The .entpkg/.zip file itself is still a completely
     standard, valid zip.
   ============================================================================ */
(function () {
    'use strict';

    // ------------------------------------------------------------------
    // 1. Versioning constants
    // ------------------------------------------------------------------
    const APP_VERSION = '1.0.0';           // this app build (semantic)
    const PACKAGE_FORMAT_VERSION = 1;      // internal database.json shape version

    const SETTINGS_KEYS = {
        CONTENT_DB_VERSION: 'ent_content_db_version',   // e.g. "2026.08.04"
        APPLIED_PACKAGES: 'ent_applied_package_ids',    // [{packageId, packageVersion, appliedAt}]
        IMPORT_HISTORY: 'ent_import_history',           // [{...summary}], most recent last
        TAXONOMY_EXTRA: 'ent_taxonomy_extra',           // {Subject: [chapters...]} merged in from packages
        UID_BACKFILL_DONE: 'ent_uid_backfill_done'
    };

    const CONTENT_STORES = ['questions', 'lectures', 'flashcards', 'bookMeta'];
    // Never touched by import/merge; listed explicitly so it's obvious at a glance what's protected.
    const USER_DATA_STORES = ['bookmarks', 'notes', 'examHistory', 'performance', 'highYield'];

    const SIGNATURE_NOTE = "Placeholder only. This build has no server and every install " +
        "runs the same code, so there's no way to keep a signing key secret from the " +
        "people it would need to be secret from. The checksum above is real and does " +
        "catch corruption/accidental edits; treat this field as reserved for a future " +
        "server-backed signing flow, not as proof of authorship.";

    // ------------------------------------------------------------------
    // 2. Small utilities
    // ------------------------------------------------------------------

    /** Generic dotted-version compare, works for both "1.0.0" and "2026.08.04" styles. -1/0/1 */
    function compareVersions(a, b) {
        const pa = String(a == null ? '0' : a).split('.').map(n => parseInt(n, 10) || 0);
        const pb = String(b == null ? '0' : b).split('.').map(n => parseInt(n, 10) || 0);
        const len = Math.max(pa.length, pb.length);
        for (let i = 0; i < len; i++) {
            const na = pa[i] || 0, nb = pb[i] || 0;
            if (na !== nb) return na < nb ? -1 : 1;
        }
        return 0;
    }

    function todayVersionString(d) {
        d = d || new Date();
        const yyyy = d.getFullYear();
        const mm = String(d.getMonth() + 1).padStart(2, '0');
        const dd = String(d.getDate()).padStart(2, '0');
        return `${yyyy}.${mm}.${dd}`;
    }

    function genUid() {
        if (window.crypto && typeof window.crypto.randomUUID === 'function') return window.crypto.randomUUID();
        // Fallback for older WebViews without crypto.randomUUID
        return 'uid-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
    }

    async function sha256Hex(str) {
        const enc = new TextEncoder().encode(str);
        const buf = await crypto.subtle.digest('SHA-256', enc);
        return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
    }

    function formatBytes(n) {
        if (n < 1024) return n + ' B';
        if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
        return (n / (1024 * 1024)).toFixed(2) + ' MB';
    }

    function formatDuration(ms) {
        if (ms < 1000) return ms + ' ms';
        return (ms / 1000).toFixed(2) + ' s';
    }

    /** Normalize text the same way the rest of this app already does for fuzzy duplicate matching. */
    function normalizeText(s) {
        return (s || '').replace(/\s+/g, ' ').replace(/[^a-z0-9 ]/gi, '').trim().toLowerCase();
    }

    /** Equality check for merge decisions: ignores bookkeeping fields, compares the rest. */
    function contentEquals(a, b) {
        const strip = (o) => {
            const c = { ...o };
            delete c.id; delete c.uid; delete c.pkgVersion; delete c.dateAdded; delete c.updatedAt; delete c.needsReview;
            return c;
        };
        return JSON.stringify(strip(a)) === JSON.stringify(strip(b));
    }

    // ------------------------------------------------------------------
    // 3. Taxonomy merge (Subjects / Chapters carried by a package)
    // ------------------------------------------------------------------

    /** Mutates the live GYNO_CURRICULUM/ALL_SUBJECTS/ALL_CHAPTERS (from app.js) in place, then persists. */
    async function mergeTaxonomy(extra) {
        if (!extra || typeof extra !== 'object') return { subjectsAdded: 0, chaptersAdded: 0 };
        let subjectsAdded = 0, chaptersAdded = 0;
        for (const subject of Object.keys(extra)) {
            if (!subject) continue;
            if (!GYNO_CURRICULUM[subject]) { GYNO_CURRICULUM[subject] = []; subjectsAdded++; }
            const chapters = Array.isArray(extra[subject]) ? extra[subject] : [];
            for (const ch of chapters) {
                if (ch && !GYNO_CURRICULUM[subject].includes(ch)) { GYNO_CURRICULUM[subject].push(ch); chaptersAdded++; }
            }
        }
        // ALL_SUBJECTS / ALL_CHAPTERS are `const` arrays computed once at load; refresh in place
        // (mutating the array contents, not rebinding) so dropdowns pick up new entries immediately.
        ALL_SUBJECTS.length = 0;
        ALL_SUBJECTS.push(...Object.keys(GYNO_CURRICULUM).sort());
        ALL_CHAPTERS.length = 0;
        ALL_CHAPTERS.push(...Object.values(GYNO_CURRICULUM).flat().sort((a, b) => a.localeCompare(b)));

        // Persist the cumulative extra-taxonomy record (merged with anything already stored)
        // so it survives reloads (GYNO_CURRICULUM itself resets to its hardcoded baseline on every load).
        let stored = {};
        try { stored = JSON.parse(await db.getSetting(SETTINGS_KEYS.TAXONOMY_EXTRA, '{}')); } catch (e) { stored = {}; }
        for (const subject of Object.keys(extra)) {
            stored[subject] = Array.from(new Set([...(stored[subject] || []), ...(extra[subject] || [])]));
        }
        await db.setSetting(SETTINGS_KEYS.TAXONOMY_EXTRA, JSON.stringify(stored));
        return { subjectsAdded, chaptersAdded };
    }

    /** Called once at startup to re-apply whatever taxonomy extensions earlier packages added. */
    async function reapplyStoredTaxonomy() {
        try {
            const stored = JSON.parse(await db.getSetting(SETTINGS_KEYS.TAXONOMY_EXTRA, '{}'));
            if (Object.keys(stored).length) await mergeTaxonomy(stored);
        } catch (e) { /* nothing stored yet, or malformed — safe to ignore */ }
    }

    // ------------------------------------------------------------------
    // 4. uid backfill — one-time lazy migration for pre-existing rows
    // ------------------------------------------------------------------
    async function ensureUidsBackfilled() {
        const done = await db.getSetting(SETTINGS_KEYS.UID_BACKFILL_DONE, false);
        if (done) return;
        await db.ensureReady();
        for (const storeName of ['questions', 'lectures']) {
            const items = await new Promise(resolve => {
                db.db.transaction(storeName, 'readonly').objectStore(storeName).getAll().onsuccess = e => resolve(e.target.result || []);
            });
            const missing = items.filter(it => !it.uid);
            if (!missing.length) continue;
            await new Promise((resolve, reject) => {
                const tx = db.db.transaction(storeName, 'readwrite');
                const store = tx.objectStore(storeName);
                missing.forEach(it => { it.uid = genUid(); store.put(it); });
                tx.oncomplete = resolve;
                tx.onerror = () => reject(tx.error);
            });
        }
        db._invalidateCache();
        await db.setSetting(SETTINGS_KEYS.UID_BACKFILL_DONE, true);
    }

    // ------------------------------------------------------------------
    // 5. Backup / Restore engine
    // ------------------------------------------------------------------

    /** Reads the full database (via the same exportAllData used by the legacy Backup/Restore buttons,
     *  now fixed to include every store) and wraps it with a bit of bookkeeping for the backups list. */
    async function captureFullSnapshot(reason) {
        await db.ensureReady();
        const data = await db.exportAllData();
        return {
            takenAt: new Date().toISOString(),
            reason: reason || 'manual',
            appVersion: APP_VERSION,
            contentDbVersion: await db.getSetting(SETTINGS_KEYS.CONTENT_DB_VERSION, todayVersionString()),
            data
        };
    }

    /** Persists a snapshot into the `backups` store, pruning older ones beyond the keep limit. */
    async function saveBackupRecord(snapshot, keep) {
        keep = keep || 5;
        await db.ensureReady();
        const id = await new Promise((resolve, reject) => {
            const tx = db.db.transaction('backups', 'readwrite');
            const req = tx.objectStore('backups').add(snapshot);
            req.onsuccess = () => resolve(req.result);
            tx.onerror = () => reject(tx.error);
        });
        const all = await listBackups();
        if (all.length > keep) {
            const toDelete = all.slice(0, all.length - keep); // listBackups() is oldest-first
            await new Promise(resolve => {
                const tx = db.db.transaction('backups', 'readwrite');
                toDelete.forEach(b => tx.objectStore('backups').delete(b.id));
                tx.oncomplete = resolve;
            });
        }
        return id;
    }

    async function listBackups() {
        await db.ensureReady();
        const all = await new Promise(resolve => {
            db.db.transaction('backups', 'readonly').objectStore('backups').getAll().onsuccess = e => resolve(e.target.result || []);
        });
        return all.sort((a, b) => new Date(a.takenAt) - new Date(b.takenAt));
    }

    async function getBackup(id) {
        await db.ensureReady();
        return new Promise(resolve => {
            db.db.transaction('backups', 'readonly').objectStore('backups').get(id).onsuccess = e => resolve(e.target.result || null);
        });
    }

    /** Full, destructive restore: replaces every store's content with what's in the snapshot. */
    async function restoreFullSnapshot(snapshot) {
        await db.ensureReady();
        await db.clearAndRestore(snapshot.data);
        if (snapshot.contentDbVersion) await db.setSetting(SETTINGS_KEYS.CONTENT_DB_VERSION, snapshot.contentDbVersion);
        db._invalidateCache();
    }

    // Expose the small pieces other sections of this file need; the rest stays module-private.
    window.__entUpdatePkg = window.__entUpdatePkg || {};
    Object.assign(window.__entUpdatePkg, {
        APP_VERSION, PACKAGE_FORMAT_VERSION, SETTINGS_KEYS, CONTENT_STORES, USER_DATA_STORES, SIGNATURE_NOTE,
        compareVersions, todayVersionString, genUid, sha256Hex, formatBytes, formatDuration, normalizeText, contentEquals,
        mergeTaxonomy, reapplyStoredTaxonomy, ensureUidsBackfilled,
        captureFullSnapshot, saveBackupRecord, listBackups, getBackup, restoreFullSnapshot
    });
})();

/* ============================================================================
   Part 2 — Package parsing, validation, merge engine, import orchestration
   ============================================================================ */
(function () {
    'use strict';
    const U = window.__entUpdatePkg;
    const { compareVersions, todayVersionString, genUid, sha256Hex, normalizeText, contentEquals,
            mergeTaxonomy, captureFullSnapshot, saveBackupRecord, restoreFullSnapshot, SETTINGS_KEYS, APP_VERSION } = U;

    const REQUIRED_MANIFEST_FIELDS = ['packageId', 'packageVersion', 'checksum'];
    const RECOGNIZED_CONTENT_KEYS = ['questions', 'lectures', 'flashcards', 'bookMeta'];
    // Where a content type's attached files live inside the package, per the required package structure.
    const ASSET_FOLDER = { questions: 'images', lectures: 'summaries', flashcards: 'flashcards', bookMeta: 'books' };

    // ---------------------------------------------------------------
    // Parsing
    // ---------------------------------------------------------------
    async function parsePackageFile(file) {
        const name = (file.name || '').toLowerCase();
        if (name.endsWith('.json')) {
            let text, flat;
            try { text = await file.text(); flat = JSON.parse(text); }
            catch (e) { throw new Error("This .json file isn't valid JSON (" + e.message + ")."); }
            if (!flat || typeof flat !== 'object' || !flat.manifest || !flat.database) {
                throw new Error('This .json file is missing a "manifest" and/or "database" section, so it doesn\'t look like an update package.');
            }
            const databaseRawText = JSON.stringify(flat.database);
            return { manifest: flat.manifest, database: flat.database, databaseRawText, assets: new Map() };
        }

        // .entpkg or .zip (or anything else — try as a zip, since .entpkg literally is one)
        if (typeof JSZip === 'undefined') throw new Error('The zip reader (JSZip) failed to load — try reloading the app before importing.');
        let zip;
        try {
            zip = await JSZip.loadAsync(await file.arrayBuffer());
        } catch (e) {
            throw new Error("Couldn't open this file as a zip/.entpkg package (" + e.message + ").");
        }

        const manifestEntry = zip.file('manifest.json');
        const databaseEntry = zip.file('database.json');
        if (!manifestEntry || !databaseEntry) {
            throw new Error('This package is missing manifest.json and/or database.json, so it doesn\'t look like a valid .entpkg/.zip update package.');
        }

        let manifest, database, databaseRawText;
        try { manifest = JSON.parse(await manifestEntry.async('string')); }
        catch (e) { throw new Error('manifest.json inside the package is not valid JSON (' + e.message + ').'); }
        try { databaseRawText = await databaseEntry.async('string'); database = JSON.parse(databaseRawText); }
        catch (e) { throw new Error('database.json inside the package is not valid JSON (' + e.message + ').'); }

        const assets = new Map(); // relative path -> Blob
        const assetEntries = [];
        zip.forEach((relPath, entry) => {
            if (entry.dir) return;
            if (relPath === 'manifest.json' || relPath === 'database.json') return;
            assetEntries.push([relPath, entry]);
        });
        for (const [relPath, entry] of assetEntries) {
            try { assets.set(relPath, await entry.async('blob')); }
            catch (e) { /* one unreadable asset shouldn't sink the whole import; it'll just be missing */ }
        }

        return { manifest, database, databaseRawText, assets };
    }

    // ---------------------------------------------------------------
    // Validation
    // ---------------------------------------------------------------
    function validatePackageStructure(manifest, database) {
        const errors = [];
        if (!manifest || typeof manifest !== 'object') errors.push('manifest.json is missing or not an object.');
        else for (const f of REQUIRED_MANIFEST_FIELDS) if (!manifest[f]) errors.push(`manifest.json is missing required field "${f}".`);

        if (!database || typeof database !== 'object') {
            errors.push('database.json is missing or not an object.');
        } else {
            const presentKeys = RECOGNIZED_CONTENT_KEYS.filter(k => database[k] !== undefined);
            const hasTaxonomy = database.taxonomy && typeof database.taxonomy === 'object' && Object.keys(database.taxonomy).length;
            if (!presentKeys.length && !hasTaxonomy) {
                errors.push('database.json contains no recognized content (no questions, lectures, flashcards, bookMeta, or taxonomy).');
            }
            for (const k of presentKeys) {
                if (!Array.isArray(database[k])) errors.push(`database.json "${k}" should be a list, but isn't.`);
            }
        }
        return { valid: errors.length === 0, errors };
    }

    async function verifyChecksum(manifest, databaseRawText) {
        if (!manifest.checksum) return false;
        const actual = await sha256Hex(databaseRawText);
        return actual.toLowerCase() === String(manifest.checksum).toLowerCase();
    }

    function checkCompatibility(manifest, currentContentDbVersion) {
        const errors = [], warnings = [];
        if (manifest.minAppVersion && compareVersions(APP_VERSION, manifest.minAppVersion) < 0) {
            errors.push(`This package needs app version ${manifest.minAppVersion} or newer — this app is ${APP_VERSION}.`);
        }
        if (manifest.exportType === 'incremental' && manifest.baseDbVersion) {
            if (compareVersions(currentContentDbVersion, manifest.baseDbVersion) < 0) {
                warnings.push(`This is an incremental update built on database version ${manifest.baseDbVersion}, ` +
                    `newer than your current ${currentContentDbVersion}. It's still safe to apply, but you may be ` +
                    `missing other updates in between.`);
            }
        }
        return { compatible: errors.length === 0, errors, warnings };
    }

    function validateItemFields(type, item) {
        switch (type) {
            case 'questions': {
                const opts = [item.optionA, item.optionB].filter(Boolean);
                if (!item.questionText) return 'missing questionText';
                if (opts.length < 2) return 'needs at least optionA and optionB';
                if (!item.correctAnswer) return 'missing correctAnswer';
                return null;
            }
            case 'lectures':
                if (!item.title) return 'missing title';
                if (!item.content) return 'missing content';
                return null;
            case 'flashcards':
                if (!item.front) return 'missing front';
                if (!item.back) return 'missing back';
                return null;
            case 'bookMeta':
                if (!item.title) return 'missing title';
                return null;
            default:
                return null;
        }
    }

    // ---------------------------------------------------------------
    // Merge engine
    // ---------------------------------------------------------------
    async function buildExistingLookup(storeName, getAllFn) {
        const items = await getAllFn();
        const byUid = new Map();
        const byNormalizedText = new Map(); // legacy items with no uid yet (pre-dates this system)
        for (const it of items) {
            if (it.uid) byUid.set(it.uid, it);
            else if (storeName === 'questions' && it.questionText) byNormalizedText.set(normalizeText(it.questionText), it);
            else if (storeName === 'lectures' && it.title) byNormalizedText.set(normalizeText(it.title + '|' + (it.content || '')), it);
        }
        return { byUid, byNormalizedText };
    }

    async function mergePackageIntoDb(manifest, database, assets) {
        await db.ensureReady();
        const stats = { added: 0, updated: 0, skipped: 0, duplicates: 0, errors: [] };

        const rawGetAll = (storeName) => new Promise(resolve => {
            db.db.transaction(storeName, 'readonly').objectStore(storeName).getAll().onsuccess = e => resolve(e.target.result || []);
        });
        const lookups = {
            questions: await buildExistingLookup('questions', () => db.getAllQuestions()),
            lectures: await buildExistingLookup('lectures', () => db.getAllLectures()),
            flashcards: await buildExistingLookup('flashcards', () => rawGetAll('flashcards')),
            bookMeta: await buildExistingLookup('bookMeta', () => rawGetAll('bookMeta'))
        };

        const involvedStores = RECOGNIZED_CONTENT_KEYS.filter(k => Array.isArray(database[k]) && database[k].length);
        if (assets.size) involvedStores.push('assets');
        if (!involvedStores.length) return stats; // nothing to do (e.g. taxonomy-only package)

        const now = new Date().toISOString();
        const pendingAssetWrites = []; // {assetKey, blob} — decided while classifying items, written in the same tx

        function classify(type, incoming) {
            const problem = validateItemFields(type, incoming);
            if (problem) { stats.errors.push({ type, uid: incoming.uid || null, reason: problem }); return null; }

            const { byUid, byNormalizedText } = lookups[type];
            let existing = incoming.uid ? byUid.get(incoming.uid) : null;
            if (!existing) {
                const key = type === 'questions' ? normalizeText(incoming.questionText)
                    : type === 'lectures' ? normalizeText(incoming.title + '|' + (incoming.content || ''))
                    : null;
                if (key) existing = byNormalizedText.get(key);
            }

            const prepared = { ...incoming };
            if (!prepared.uid) prepared.uid = genUid();
            prepared.pkgVersion = manifest.packageVersion || prepared.pkgVersion || '0';

            if (!existing) {
                prepared.dateAdded = prepared.dateAdded || now;
                prepared.updatedAt = now;
                if (type === 'questions') { prepared.tags = prepared.tags || []; prepared.group = prepared.group || ''; prepared.book = prepared.book || ''; prepared.needsReview = false; }
                return { action: 'add', record: prepared };
            }

            if (contentEquals(existing, prepared)) return { action: 'duplicate' };

            const existingVersion = existing.pkgVersion || '0';
            if (compareVersions(prepared.pkgVersion, existingVersion) > 0) {
                const merged = { ...existing, ...prepared, id: existing.id, dateAdded: existing.dateAdded || now, updatedAt: now };
                return { action: 'update', record: merged };
            }
            return { action: 'skip' };
        }

        function queueAssets(type, itemUid, images) {
            if (!Array.isArray(images)) return;
            const folder = ASSET_FOLDER[type] || 'assets';
            for (const img of images) {
                const path = typeof img === 'string' ? img : img.path;
                if (!path) continue;
                const blob = assets.get(path) || assets.get(folder + '/' + path.split('/').pop());
                if (!blob) continue; // referenced but not included in the package — skip quietly
                pendingAssetWrites.push({ assetKey: itemUid + '::' + path, blob });
            }
        }

        const decisions = { questions: [], lectures: [], flashcards: [], bookMeta: [] };
        for (const type of RECOGNIZED_CONTENT_KEYS) {
            for (const incoming of (database[type] || [])) {
                const d = classify(type, incoming);
                if (!d) continue;
                if (d.action === 'duplicate') { stats.duplicates++; continue; }
                if (d.action === 'skip') { stats.skipped++; continue; }
                decisions[type].push(d);
                if (d.action === 'add') stats.added++; else stats.updated++;
                queueAssets(type, d.record.uid, d.record.images);
            }
        }

        await new Promise((resolve, reject) => {
            const tx = db.db.transaction(involvedStores, 'readwrite');
            for (const type of RECOGNIZED_CONTENT_KEYS) {
                if (!decisions[type].length) continue;
                const store = tx.objectStore(type);
                for (const d of decisions[type]) {
                    if (d.action === 'add') { const rec = { ...d.record }; delete rec.id; store.add(rec); }
                    else store.put(d.record);
                }
            }
            if (pendingAssetWrites.length) {
                const assetStore = tx.objectStore('assets');
                for (const a of pendingAssetWrites) assetStore.put(a);
            }
            tx.oncomplete = resolve;
            tx.onerror = () => reject(tx.error || new Error('Merge transaction failed'));
            tx.onabort = () => reject(tx.error || new Error('Merge transaction aborted'));
        });

        db._invalidateCache();
        return stats;
    }

    // ---------------------------------------------------------------
    // Student-facing orchestration
    // ---------------------------------------------------------------
    async function importUpdatePackage(file) {
        const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
        let parsed;
        try { parsed = await parsePackageFile(file); }
        catch (e) { return { success: false, stage: 'parse', message: e.message }; }

        const { manifest, database, databaseRawText, assets } = parsed;

        const structural = validatePackageStructure(manifest, database);
        if (!structural.valid) return { success: false, stage: 'validate', message: structural.errors.join(' '), errors: structural.errors };

        const checksumOk = await verifyChecksum(manifest, databaseRawText);
        if (!checksumOk) return { success: false, stage: 'checksum', message: "The package's checksum doesn't match its contents — it may be corrupted or was edited after export. Nothing was changed." };

        const previousContentDbVersion = await db.getSetting(SETTINGS_KEYS.CONTENT_DB_VERSION, todayVersionString());
        const compat = checkCompatibility(manifest, previousContentDbVersion);
        if (!compat.compatible) return { success: false, stage: 'compatibility', message: compat.errors.join(' '), errors: compat.errors };

        // From here on we're committed to either a full success or an explicit rollback.
        const snapshot = await captureFullSnapshot('pre-import:' + (manifest.packageId || 'unknown'));
        const backupId = await saveBackupRecord(snapshot);

        let stats;
        try {
            stats = await mergePackageIntoDb(manifest, database, assets);
        } catch (mergeErr) {
            try { await restoreFullSnapshot(snapshot); } catch (e2) { /* IndexedDB already didn't commit the failed writes either way */ }
            return { success: false, stage: 'merge', message: 'Import failed and was rolled back — nothing was changed: ' + mergeErr.message, backupId };
        }

        let taxonomyResult = { subjectsAdded: 0, chaptersAdded: 0 };
        if (database.taxonomy) { try { taxonomyResult = await mergeTaxonomy(database.taxonomy); } catch (e) { /* non-fatal */ } }

        let newContentDbVersion = previousContentDbVersion;
        if (manifest.targetDbVersion && compareVersions(manifest.targetDbVersion, previousContentDbVersion) > 0) {
            newContentDbVersion = manifest.targetDbVersion;
        }
        await db.setSetting(SETTINGS_KEYS.CONTENT_DB_VERSION, newContentDbVersion);

        const appliedRaw = await db.getSetting(SETTINGS_KEYS.APPLIED_PACKAGES, '[]');
        let applied = []; try { applied = JSON.parse(appliedRaw); } catch (e) { applied = []; }
        applied.push({ packageId: manifest.packageId, packageVersion: manifest.packageVersion, appliedAt: new Date().toISOString() });
        await db.setSetting(SETTINGS_KEYS.APPLIED_PACKAGES, JSON.stringify(applied.slice(-100)));

        const durationMs = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0;
        const summary = {
            success: true, appliedAt: new Date().toISOString(),
            previousContentDbVersion, newContentDbVersion,
            packageVersion: manifest.packageVersion, packageId: manifest.packageId,
            added: stats.added, updated: stats.updated, skipped: stats.skipped, duplicates: stats.duplicates,
            errors: stats.errors, durationMs, warnings: compat.warnings, taxonomyResult, backupId
        };

        const historyRaw = await db.getSetting(SETTINGS_KEYS.IMPORT_HISTORY, '[]');
        let history = []; try { history = JSON.parse(historyRaw); } catch (e) { history = []; }
        history.push(summary);
        await db.setSetting(SETTINGS_KEYS.IMPORT_HISTORY, JSON.stringify(history.slice(-50)));

        return summary;
    }

    Object.assign(U, {
        parsePackageFile, validatePackageStructure, verifyChecksum, checkCompatibility, validateItemFields,
        mergePackageIntoDb, importUpdatePackage, RECOGNIZED_CONTENT_KEYS, ASSET_FOLDER
    });
})();

/* ============================================================================
   Part 3 — Export engine (admin: build & download a .entpkg)
   ============================================================================ */
(function () {
    'use strict';
    const U = window.__entUpdatePkg;
    const { genUid, sha256Hex, todayVersionString, compareVersions, SETTINGS_KEYS,
            APP_VERSION, PACKAGE_FORMAT_VERSION, SIGNATURE_NOTE, RECOGNIZED_CONTENT_KEYS, ASSET_FOLDER } = U;

    function versionToDate(v) {
        const parts = String(v || '').split('.').map(n => parseInt(n, 10));
        if (parts.length < 3 || parts.some(isNaN)) return null;
        return new Date(parts[0], parts[1] - 1, parts[2]);
    }

    async function rawGetAll(storeName) {
        await db.ensureReady();
        if (!db.db.objectStoreNames.contains(storeName)) return [];
        return new Promise(resolve => {
            db.db.transaction(storeName, 'readonly').objectStore(storeName).getAll().onsuccess = e => resolve(e.target.result || []);
        });
    }

    async function gatherExportContent(mode, sinceVersion) {
        const sinceDate = mode === 'incremental' ? versionToDate(sinceVersion) : null;
        const inScope = (item) => {
            if (!sinceDate) return true;
            const ts = item.updatedAt || item.dateAdded;
            if (!ts) return false; // undated legacy item — treat as already-shipped, not "new"
            return new Date(ts) >= sinceDate;
        };

        const questions = (await db.getAllQuestions()).filter(inScope);
        const lectures = (await db.getAllLectures()).filter(inScope);
        const flashcards = (await rawGetAll('flashcards')).filter(inScope);
        const bookMeta = (await rawGetAll('bookMeta')).filter(inScope);

        let taxonomy = {};
        try { Object.keys(GYNO_CURRICULUM).forEach(s => { taxonomy[s] = [...GYNO_CURRICULUM[s]]; }); } catch (e) { taxonomy = {}; }

        return { questions, lectures, flashcards, bookMeta, taxonomy };
    }

    /** Assigns + persists a uid to any local item that doesn't have one yet (so future exports stay stable). */
    async function ensureLocalUidsAndStamp(items, storeName, packageVersion) {
        const toPersist = [];
        for (const it of items) {
            let changed = false;
            if (!it.uid) { it.uid = genUid(); changed = true; }
            if (it.pkgVersion !== packageVersion) { it.pkgVersion = packageVersion; changed = true; }
            if (changed) toPersist.push(it);
        }
        if (toPersist.length) {
            await db.ensureReady();
            await new Promise((resolve, reject) => {
                const tx = db.db.transaction(storeName, 'readwrite');
                const store = tx.objectStore(storeName);
                toPersist.forEach(it => store.put(it));
                tx.oncomplete = resolve;
                tx.onerror = () => reject(tx.error);
            });
        }
    }

    function stripLocalId(item) {
        const c = { ...item };
        delete c.id;
        return c;
    }

    async function collectAssetsFor(items, type) {
        const folder = ASSET_FOLDER[type] || 'assets';
        const out = []; // {path, blob}
        for (const item of items) {
            if (!Array.isArray(item.images)) continue;
            for (const img of item.images) {
                const path = typeof img === 'string' ? img : img.path;
                if (!path) continue;
                const assetKey = item.uid + '::' + path;
                const rec = await new Promise(resolve => {
                    db.db.transaction('assets', 'readonly').objectStore('assets').get(assetKey).onsuccess = e => resolve(e.target.result || null);
                });
                if (rec && rec.blob) out.push({ path: path.includes('/') ? path : folder + '/' + path, blob: rec.blob });
            }
        }
        return out;
    }

    async function buildEntpkg(options) {
        await db.ensureReady();
        const mode = options.mode === 'incremental' ? 'incremental' : 'full';
        const packageVersion = options.packageVersion || todayVersionString();
        const author = options.author || 'Abd alzuhairy';
        const minAppVersion = options.minAppVersion || APP_VERSION;

        const content = await gatherExportContent(mode, options.sinceVersion);

        await ensureLocalUidsAndStamp(content.questions, 'questions', packageVersion);
        await ensureLocalUidsAndStamp(content.lectures, 'lectures', packageVersion);
        await ensureLocalUidsAndStamp(content.flashcards, 'flashcards', packageVersion);
        await ensureLocalUidsAndStamp(content.bookMeta, 'bookMeta', packageVersion);
        db._invalidateCache();

        const databaseObj = {
            schemaVersion: PACKAGE_FORMAT_VERSION,
            questions: content.questions.map(stripLocalId),
            lectures: content.lectures.map(stripLocalId),
            flashcards: content.flashcards.map(stripLocalId),
            bookMeta: content.bookMeta.map(stripLocalId),
            taxonomy: content.taxonomy
        };
        const databaseRawText = JSON.stringify(databaseObj);
        const checksum = await sha256Hex(databaseRawText);

        const manifest = {
            packageId: genUid(),
            packageVersion,
            createdAt: new Date().toISOString(),
            author,
            minAppVersion,
            targetDbVersion: packageVersion,
            baseDbVersion: mode === 'incremental' ? (options.sinceVersion || null) : null,
            exportType: mode,
            schemaVersion: PACKAGE_FORMAT_VERSION,
            checksum,
            signature: { algorithm: null, value: null, placeholder: true, note: SIGNATURE_NOTE },
            contentSummary: {
                questions: databaseObj.questions.length,
                lectures: databaseObj.lectures.length,
                flashcards: databaseObj.flashcards.length,
                bookMeta: databaseObj.bookMeta.length
            }
        };

        const zip = new JSZip();
        zip.file('manifest.json', JSON.stringify(manifest, null, 2));
        zip.file('database.json', databaseRawText);
        for (const folder of ['images', 'summaries', 'flashcards', 'books', 'assets']) zip.folder(folder);

        let imageCount = 0;
        for (const [items, type] of [[content.questions, 'questions'], [content.lectures, 'lectures'], [content.flashcards, 'flashcards'], [content.bookMeta, 'bookMeta']]) {
            const assetList = await collectAssetsFor(items, type);
            for (const a of assetList) {
                const bytes = a.blob.arrayBuffer ? await a.blob.arrayBuffer() : a.blob;
                zip.file(a.path, bytes);
                imageCount++;
            }
        }
        manifest.contentSummary.images = imageCount;
        zip.file('manifest.json', JSON.stringify(manifest, null, 2)); // rewrite with final image count

        // STORE (no DEFLATE): see the file header note — this app's own vendored zip writer
        // only checks out reliably in uncompressed mode; reading DEFLATE-compressed zips still
        // works fine, this only affects files this app itself produces.
        const blob = await zip.generateAsync({ type: 'blob', compression: 'STORE' });

        // Exporting is a version-defining event for the admin's own copy too.
        const currentLocal = await db.getSetting(SETTINGS_KEYS.CONTENT_DB_VERSION, todayVersionString());
        if (compareVersions(packageVersion, currentLocal) > 0) await db.setSetting(SETTINGS_KEYS.CONTENT_DB_VERSION, packageVersion);

        return { blob, manifest, sizeBytes: blob.size };
    }

    async function exportUpdatePackage(options) {
        const result = await buildEntpkg(options);
        const a = document.createElement('a');
        a.href = URL.createObjectURL(result.blob);
        a.download = `ayla-gyno-update-${result.manifest.packageVersion}.aylapkg`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        return result;
    }

    Object.assign(U, { versionToDate, gatherExportContent, buildEntpkg, exportUpdatePackage });
})();

/* ============================================================================
   Part 4 — Settings UI, event wiring, init
   ============================================================================ */
(function () {
    'use strict';
    const U = window.__entUpdatePkg;
    const { compareVersions, todayVersionString, formatBytes, formatDuration, SETTINGS_KEYS,
            APP_VERSION, SIGNATURE_NOTE, importUpdatePackage, exportUpdatePackage,
            listBackups, getBackup, restoreFullSnapshot, captureFullSnapshot, saveBackupRecord,
            ensureUidsBackfilled, reapplyStoredTaxonomy } = U;

    function esc(s) { return (typeof escapeHTML === 'function') ? escapeHTML(String(s == null ? '' : s)) : String(s == null ? '' : s); }

    async function rawCount(storeName) {
        await db.ensureReady();
        if (!db.db.objectStoreNames.contains(storeName)) return 0;
        return new Promise(resolve => {
            const req = db.db.transaction(storeName, 'readonly').objectStore(storeName).count();
            req.onsuccess = () => resolve(req.result);
        });
    }

    // ---------------------------------------------------------------
    // "Update Complete" result panel
    // ---------------------------------------------------------------
    function renderImportResultHTML(r) {
        if (!r.success) {
            const errList = (r.errors || []).slice(0, 6).map(e => `<li>${esc(e)}</li>`).join('');
            return `
            <div class="card" style="border-color:var(--danger);">
              <div class="card-header" style="color:var(--danger);">✕ Import Failed</div>
              <p style="font-size:0.9rem;">${esc(r.message)}</p>
              ${errList ? `<ul style="font-size:0.82rem;color:var(--text2);margin:8px 0 0 18px;">${errList}</ul>` : ''}
              <p style="font-size:0.8rem;color:var(--text-muted);margin-top:10px;">No data was changed.</p>
            </div>`;
        }
        const itemErrors = (r.errors || []);
        const errRows = itemErrors.slice(0, 6).map(e => `<li>${esc(e.type)} ${e.uid ? '(' + esc(e.uid).slice(0, 8) + '…)' : ''}: ${esc(e.reason)}</li>`).join('');
        const moreErr = itemErrors.length > 6 ? `<li>…and ${itemErrors.length - 6} more</li>` : '';
        const warnRows = (r.warnings || []).map(w => `<p style="font-size:0.8rem;color:var(--warning,#b45309);">⚠ ${esc(w)}</p>`).join('');
        const taxLine = (r.taxonomyResult && (r.taxonomyResult.subjectsAdded || r.taxonomyResult.chaptersAdded))
            ? `<div class="stat-row"><span>New subjects/chapters</span><b>${r.taxonomyResult.subjectsAdded} / ${r.taxonomyResult.chaptersAdded}</b></div>` : '';
        return `
        <div class="card" style="border-color:var(--success,#16a34a);">
          <div class="card-header" style="color:var(--success,#16a34a);">✓ Update Complete</div>
          ${warnRows}
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px 14px;font-size:0.88rem;margin-top:6px;">
            <div>Database version</div><b style="text-align:right;">${esc(r.newContentDbVersion)}</b>
            <div>Previous version</div><b style="text-align:right;">${esc(r.previousContentDbVersion)}</b>
            <div>Package version</div><b style="text-align:right;">${esc(r.packageVersion)}</b>
          </div>
          <hr style="border:none;border-top:1px solid var(--border);margin:12px 0;">
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px 14px;font-size:0.88rem;">
            <div>Added</div><b style="text-align:right;color:var(--success,#16a34a);">${r.added}</b>
            <div>Updated</div><b style="text-align:right;">${r.updated}</b>
            <div>Skipped</div><b style="text-align:right;">${r.skipped}</b>
            <div>Duplicates</div><b style="text-align:right;">${r.duplicates}</b>
            <div>Errors</div><b style="text-align:right;color:${itemErrors.length ? 'var(--danger)' : 'inherit'};">${itemErrors.length}</b>
          </div>
          ${taxLine ? `<div style="margin-top:8px;font-size:0.85rem;">${taxLine}</div>` : ''}
          ${errRows ? `<ul style="font-size:0.78rem;color:var(--text2);margin:10px 0 0 18px;">${errRows}${moreErr}</ul>` : ''}
          <p style="font-size:0.78rem;color:var(--text-muted);margin-top:10px;">Import took ${esc(formatDuration(r.durationMs))}. A backup was taken automatically before this import.</p>
        </div>`;
    }

    // ---------------------------------------------------------------
    // Main Settings view
    // ---------------------------------------------------------------
    async function renderSettings() {
        await db.ensureReady();
        await ensureUidsBackfilled();
        const isAdmin = (typeof RBAC !== 'undefined') && RBAC.isAdmin();
        const contentDbVersion = await db.getSetting(SETTINGS_KEYS.CONTENT_DB_VERSION, todayVersionString());

        const importCard = `
        <div class="card">
          <div class="card-header">📥 Import Update</div>
          <p style="font-size:0.85rem;color:var(--text2);margin-bottom:10px;">
            Add new or updated questions, summaries, flashcards and more from an update package.
            Your bookmarks, notes, progress and stats are never touched.
          </p>
          <input type="file" id="importUpdateFile" accept=".aylapkg,.entpkg,.zip,.json">
          <button class="btn btn-primary btn-block mt-2" id="btnRunImportUpdate">📥 Import Update</button>
          <div id="importUpdateResult" style="margin-top:12px;"></div>
        </div>`;

        const aboutCard = `
        <div class="card">
          <div class="card-header">ℹ️ About</div>
          <div style="font-size:0.88rem;line-height:1.8;">
            <div style="font-weight:700;font-size:1rem;">AYLA GYNO Master Question Bank</div>
            <div style="color:var(--text2);margin-bottom:10px;">Offline Obstetrics & Gynecology question bank and exam preparation platform.</div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px 14px;">
              <div>Version</div><b style="text-align:right;">${esc(APP_VERSION)}</b>
              <div>Developer</div><b style="text-align:right;">Abd alzuhairy</b>
              <div>Contact</div><b style="text-align:right;"><a href="mailto:alzuhairyabd@gmail.com" style="color:var(--primary);text-decoration:none;">alzuhairyabd@gmail.com</a></b>
            </div>
          </div>
        </div>`;

        if (!isAdmin) {
            return `<div class="view-header"><h2>⚙️ Settings</h2></div>` + importCard + aboutCard;
        }

        // --- Admin-only sections below ---
        const counts = {
            questions: await rawCount('questions'), lectures: await rawCount('lectures'),
            flashcards: await rawCount('flashcards'), bookMeta: await rawCount('bookMeta')
        };
        const historyRaw = await db.getSetting(SETTINGS_KEYS.IMPORT_HISTORY, '[]');
        let history = []; try { history = JSON.parse(historyRaw); } catch (e) { history = []; }
        const recentHistory = history.slice(-5).reverse();
        const historyRows = recentHistory.length ? recentHistory.map(h => `
            <div style="display:flex;justify-content:space-between;font-size:0.8rem;padding:4px 0;border-bottom:1px solid var(--border);">
              <span>${esc(h.packageVersion)} → v${esc(h.newContentDbVersion)}</span>
              <span style="color:var(--text-muted);">+${h.added} / ~${h.updated} · ${h.appliedAt ? new Date(h.appliedAt).toLocaleDateString() : ''}</span>
            </div>`).join('') : `<p style="font-size:0.8rem;color:var(--text-muted);">No imports yet on this device.</p>`;

        const exportCard = `
        <div class="card">
          <div class="card-header">📤 Export Update Package</div>
          <label class="modal-field">Package type
            <select id="exportMode">
              <option value="full">Full (entire database)</option>
              <option value="incremental">Incremental (only new/modified)</option>
            </select>
          </label>
          <div id="exportSinceWrap" style="display:none;">
            <label class="modal-field">Since version
              <input type="text" id="exportSinceVersion" placeholder="e.g. ${esc(contentDbVersion)}" value="${esc(contentDbVersion)}">
            </label>
          </div>
          <label class="modal-field">Package version
            <input type="text" id="exportPackageVersion" value="${esc(todayVersionString())}">
          </label>
          <label class="modal-field">Author
            <input type="text" id="exportAuthor" value="Abd alzuhairy">
          </label>
          <button class="btn btn-accent btn-block mt-2" id="btnRunExportUpdate">📤 Export Update Package (.aylapkg)</button>
          <div id="exportUpdateResult" style="margin-top:12px;font-size:0.82rem;color:var(--text2);"></div>
        </div>`;

        const dbVersionCard = `
        <div class="card">
          <div class="card-header">🗄 Database Version</div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px 14px;font-size:0.88rem;">
            <div>App version</div><b style="text-align:right;">${esc(APP_VERSION)}</b>
            <div>Database (content) version</div><b style="text-align:right;">${esc(contentDbVersion)}</b>
          </div>
          <hr style="border:none;border-top:1px solid var(--border);margin:12px 0;">
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px 14px;font-size:0.85rem;">
            <div>Questions</div><b style="text-align:right;">${counts.questions}</b>
            <div>Lectures / Summaries</div><b style="text-align:right;">${counts.lectures}</b>
            <div>Flashcards</div><b style="text-align:right;">${counts.flashcards}</b>
            <div>Book metadata</div><b style="text-align:right;">${counts.bookMeta}</b>
          </div>
          <hr style="border:none;border-top:1px solid var(--border);margin:12px 0;">
          <div style="font-size:0.85rem;color:var(--text2);margin-bottom:4px;">Recent imports on this device</div>
          ${historyRows}
        </div>`;

        const backupCard = `
        <div class="card">
          <div class="card-header">💾 Backup Database</div>
          <p style="font-size:0.85rem;color:var(--text2);margin-bottom:10px;">
            Downloads a complete backup file (content + your bookmarks/notes/progress) and keeps a copy on this device.
          </p>
          <button class="btn btn-success btn-block" id="btnRunBackup">💾 Create Backup Now</button>
          <div id="backupResult" style="margin-top:10px;font-size:0.82rem;color:var(--text2);"></div>
        </div>`;

        const backupsListHTML = await renderBackupsListHTML();
        const restoreCard = `
        <div class="card">
          <div class="card-header">♻️ Restore Backup</div>
          <p style="font-size:0.85rem;color:var(--text2);margin-bottom:10px;">
            Replaces <b>all</b> data on this device with a backup. This can't be undone.
          </p>
          <div id="backupsListWrap">${backupsListHTML}</div>
          <div style="margin-top:12px;">
            <label class="modal-field">Or restore from a downloaded backup file
              <input type="file" id="restoreBackupFile" accept=".json">
            </label>
            <button class="btn btn-outline btn-block" id="btnRestoreFromFile">♻️ Restore From File</button>
          </div>
        </div>`;

        return `<div class="view-header"><h2>⚙️ Settings</h2></div>` +
            importCard + exportCard + dbVersionCard + backupCard + restoreCard + aboutCard;
    }

    async function renderBackupsListHTML() {
        const backups = (await listBackups()).slice().reverse(); // newest first
        if (!backups.length) return `<p style="font-size:0.8rem;color:var(--text-muted);">No backups on this device yet.</p>`;
        return backups.slice(0, 8).map(b => {
            const when = new Date(b.takenAt).toLocaleString();
            const reason = b.reason && b.reason.startsWith('pre-import') ? 'auto (before an import)' : 'manual';
            return `
            <div style="display:flex;justify-content:space-between;align-items:center;padding:6px 0;border-bottom:1px solid var(--border);">
              <div style="font-size:0.82rem;">
                <div>${esc(when)}</div>
                <div style="color:var(--text-muted);">${esc(reason)} · v${esc(b.contentDbVersion)}</div>
              </div>
              <button class="btn btn-sm btn-outline restore-backup-btn" data-backup-id="${b.id}">Restore</button>
            </div>`;
        }).join('');
    }

    // ---------------------------------------------------------------
    // Event wiring
    // ---------------------------------------------------------------
    async function attachSettingsListeners() {
        const importBtn = document.getElementById('btnRunImportUpdate');
        if (!importBtn) return; // not currently showing the Settings view

        importBtn.addEventListener('click', async () => {
            const fileInput = document.getElementById('importUpdateFile');
            const resultBox = document.getElementById('importUpdateResult');
            const file = fileInput && fileInput.files[0];
            if (!file) { showToast('Choose an .aylapkg, .zip, or .json update package first.', 'warning'); return; }
            importBtn.disabled = true;
            const originalLabel = importBtn.textContent;
            importBtn.textContent = '⏳ Validating…';
            resultBox.innerHTML = '';
            try {
                const result = await importUpdatePackage(file);
                resultBox.innerHTML = renderImportResultHTML(result);
                if (result.success) {
                    showToast(`Update applied: +${result.added} added, ${result.updated} updated.`, 'success');
                    fileInput.value = '';
                } else {
                    showToast('Import failed: ' + result.message, 'error');
                }
            } catch (e) {
                resultBox.innerHTML = renderImportResultHTML({ success: false, message: 'Unexpected error: ' + e.message });
                showToast('Import failed: ' + e.message, 'error');
                console.error('Import update error', e);
            } finally {
                importBtn.disabled = false;
                importBtn.textContent = originalLabel;
            }
        });

        // --- Admin-only wiring below (elements simply won't exist for students) ---
        const exportModeSel = document.getElementById('exportMode');
        if (exportModeSel) {
            exportModeSel.addEventListener('change', () => {
                const wrap = document.getElementById('exportSinceWrap');
                if (wrap) wrap.style.display = exportModeSel.value === 'incremental' ? 'block' : 'none';
            });
        }

        const exportBtn = document.getElementById('btnRunExportUpdate');
        if (exportBtn) {
            exportBtn.addEventListener('click', async () => {
                if (typeof RBAC !== 'undefined' && !RBAC.requireAdmin()) return;
                const mode = document.getElementById('exportMode').value;
                const packageVersion = (document.getElementById('exportPackageVersion').value || '').trim() || todayVersionString();
                const author = (document.getElementById('exportAuthor').value || '').trim() || 'Abd alzuhairy';
                const sinceVersion = (document.getElementById('exportSinceVersion').value || '').trim();
                const resultBox = document.getElementById('exportUpdateResult');
                exportBtn.disabled = true;
                const originalLabel = exportBtn.textContent;
                exportBtn.textContent = '⏳ Building package…';
                try {
                    const result = await exportUpdatePackage({ mode, packageVersion, author, sinceVersion });
                    const c = result.manifest.contentSummary;
                    resultBox.innerHTML = `✓ Exported <b>${esc(packageVersion)}</b> (${formatBytes(result.sizeBytes)}) —
                        ${c.questions} questions, ${c.lectures} lectures, ${c.flashcards} flashcards, ${c.bookMeta} book entries, ${c.images} images.`;
                    showToast('Update package downloaded.', 'success');
                } catch (e) {
                    resultBox.innerHTML = `<span style="color:var(--danger);">Export failed: ${esc(e.message)}</span>`;
                    showToast('Export failed: ' + e.message, 'error');
                    console.error('Export update error', e);
                } finally {
                    exportBtn.disabled = false;
                    exportBtn.textContent = originalLabel;
                }
            });
        }

        const backupBtn = document.getElementById('btnRunBackup');
        if (backupBtn) {
            backupBtn.addEventListener('click', async () => {
                if (typeof RBAC !== 'undefined' && !RBAC.requireAdmin()) return;
                const resultBox = document.getElementById('backupResult');
                backupBtn.disabled = true;
                try {
                    const snapshot = await captureFullSnapshot('manual');
                    await saveBackupRecord(snapshot);
                    const blob = new Blob([JSON.stringify(snapshot.data)], { type: 'application/json' });
                    const a = document.createElement('a');
                    a.href = URL.createObjectURL(blob);
                    a.download = `ayla-gyno-backup-${new Date().toISOString().slice(0, 10)}.json`;
                    document.body.appendChild(a); a.click(); a.remove();
                    resultBox.textContent = `Backup saved and downloaded (${formatBytes(blob.size)}).`;
                    showToast('Backup created.', 'success');
                    const wrap = document.getElementById('backupsListWrap');
                    if (wrap) wrap.innerHTML = await renderBackupsListHTML();
                    attachRestoreButtons();
                } catch (e) {
                    resultBox.textContent = 'Backup failed: ' + e.message;
                    showToast('Backup failed: ' + e.message, 'error');
                } finally {
                    backupBtn.disabled = false;
                }
            });
        }

        function attachRestoreButtons() {
            document.querySelectorAll('.restore-backup-btn').forEach(btn => {
                btn.addEventListener('click', async () => {
                    if (typeof RBAC !== 'undefined' && !RBAC.requireAdmin()) return;
                    if (!confirm('Replace ALL data on this device with this backup? This cannot be undone.')) return;
                    try {
                        const snapshot = await getBackup(parseInt(btn.dataset.backupId, 10));
                        if (!snapshot) { showToast('Backup not found.', 'error'); return; }
                        await restoreFullSnapshot(snapshot);
                        await reapplyStoredTaxonomy();
                        showToast('Database restored.', 'success');
                        navigateTo('settings');
                    } catch (e) {
                        showToast('Restore failed: ' + e.message, 'error');
                        console.error('Restore backup error', e);
                    }
                });
            });
        }
        attachRestoreButtons();

        const restoreFileBtn = document.getElementById('btnRestoreFromFile');
        if (restoreFileBtn) {
            restoreFileBtn.addEventListener('click', async () => {
                if (typeof RBAC !== 'undefined' && !RBAC.requireAdmin()) return;
                const fileInput = document.getElementById('restoreBackupFile');
                const file = fileInput && fileInput.files[0];
                if (!file) { showToast('Choose a backup .json file first.', 'warning'); return; }
                try {
                    const text = await file.text();
                    const data = JSON.parse(text);
                    if (!confirm(`Restore ${data.questions ? data.questions.length : 0} questions and all other data from this file? This replaces everything currently on this device.`)) return;
                    await db.clearAndRestore(data);
                    showToast('Database restored from file.', 'success');
                    navigateTo('settings');
                } catch (e) {
                    showToast('Restore failed: ' + e.message, 'error');
                    console.error('Restore from file error', e);
                }
            });
        }
    }

    // ---------------------------------------------------------------
    // Init
    // ---------------------------------------------------------------
    document.addEventListener('DOMContentLoaded', async () => {
        try {
            await db.ensureReady();
            await ensureUidsBackfilled();
            await reapplyStoredTaxonomy();
        } catch (e) { console.error('Update Package System init error:', e); }
    });

    window.renderSettings = renderSettings;
    window.attachSettingsListeners = attachSettingsListeners;
})();
