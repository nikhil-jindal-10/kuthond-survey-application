Kuthond Survey Application - V15.1.1-PWA deployment build
Developed by Nikhil JindaL

BASELINE: Kuthond Survey Application V15.1.1 (protected)

DEPLOYMENT-ONLY CHANGE:
- Replaced the 53.7 MB JSON master-data file with the approved 21.36 MB CSV master-data file.
- On first launch, the CSV is imported into IndexedDB on the phone.
- Account ID and Meter Number searches use IndexedDB indexes and do not require internet after the first import.
- Village data is cached locally after first load.
- Added a PWA manifest and service worker so the app shell can reopen offline after first successful load.
- Existing survey, login, save, upload, sync, collection and export logic is otherwise preserved.

IMPORTANT:
- Master data is read-only in the app.
- Internet is still required for server login when credentials/session need server validation, Google Sheet upload, and upload-status synchronization.
- Uninstalling/clearing app site data removes the local master database and requires the first-time import again.

V15.1.1-PWA-FIX:
- Built from protected V15.1.1-PWA.
- IndexedDB version 4 rebuilds ONLY the read-only masterConsumers store.
- Existing survey records store is preserved.
- Master data is accepted only after exact 190,081-record count and two sentinel lookups verify successfully.
- Partial/old master imports are rejected and rebuilt.
- Search is blocked until masterReady is true.
- No login, survey, local-record, upload, sync, collection, or export logic was intentionally changed.

V15.1.1-PWA-FIX2:
- Master CSV is processed incrementally from the fetch stream instead of loading the full parsed CSV into a giant JS array.
- Master records are written in 1,000-record IndexedDB batches.
- App initialization/login UI no longer waits for the entire master import.
- Search remains blocked until the full 190,081-record master has been verified.
- Existing survey records and all core application functions are preserved.

V15.1.1-PWA-FIX3:
- Added visible Master Data status card to Home screen.
- Shows Loading progress during first import.
- Shows READY / 190,081 consumers available offline after verification.
- Shows ERROR if import fails.
- Search button remains disabled until master data is verified.
- On later app openings, a completed local master immediately shows READY; no re-import is performed.
- Core survey/login/upload logic preserved.

V15.1.1-PWA-SETUP:
- Protected application DB ConsumerMobileApp is survey-only; master data is completely separate.
- New master DB: KuthondMasterData.
- First successful login starts master-data setup.
- User sees Master Data Setup with progress and must wait until 190,081 records are verified.
- Continue button appears only after successful verification.
- Subsequent openings reuse the local master DB and skip re-import.
- Logout does not clear master data.
- Existing survey records/upload logic remains in ConsumerMobileApp.

PWA-SETUP-FIX1:
- Fixed master import to parse complete CSV records, including quoted multiline fields.
- Uses versioned master URL consumer-master.csv?v=2 to avoid stale service-worker cache.
- Imports 500-record IndexedDB batches.
- Existing ConsumerMobileApp database remains isolated and unchanged.
- Core login/survey/save/upload/sync functions are preserved.

PWA-SETUP-FIX2:
- Fixed a master-only header normalization mismatch that caused every parsed row to have an empty Account ID, resulting in 0 imported records.
- No change to protected ConsumerMobileApp database or survey functions.

PWA-SETUP-FIX3:
- Fresh master import: Continue appears only after successful first-time import.
- Subsequent openings with verified local master: setup card closes automatically; no Continue button.
- No changes to protected survey database or core survey/upload functions.
