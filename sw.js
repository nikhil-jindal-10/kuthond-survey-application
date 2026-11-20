/*
 * Fieldwork PWA service worker
 *
 * RELEASE RULE:
 * Change CACHE_VERSION every time app.js, index.html,
 * style.css or any cached file changes on GitHub.
 * Phones get the new version on the next online open,
 * and show it on the open after that.
 */

const CACHE_VERSION = "v20.23";
const CACHE_PREFIX = "fieldwork-pwa-";
const CACHE = CACHE_PREFIX + CACHE_VERSION;

/* Caches from older versions of this app (deleted on activate). */
const APP_CACHE_PREFIXES = ["kuthond-pwa-", CACHE_PREFIX];

/* Must all succeed, otherwise this version is not installed
   and the previous version keeps working. */
const REQUIRED = [
  "./",
  "./index.html",
  "./app.js",
  "./style.css",
  "./progress.js",
  "./consumer-view.js"
];

/* Cached if present; a missing file does not block install. */




const OPTIONAL = [
  "./xlsx.full.min.js",
  "./jspdf.umd.min.js",
  "./jspdf.plugin.autotable.min.js",
  "./manifest.json",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-maskable-512.png"
];


function freshRequest(url) {
  /* Bypass the browser's HTTP cache so each version stores
     the files currently on GitHub. */
  return new Request(url, { cache: "reload" });
}

self.addEventListener("install", event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);

    await cache.addAll(REQUIRED.map(freshRequest));

    await Promise.allSettled(
      OPTIONAL.map(async url => {
        const res = await fetch(freshRequest(url));
        if (res.ok) {
          await cache.put(url, res);
        }
      })
    );

    await self.skipWaiting();
  })());
});

self.addEventListener("activate", event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();

    /* Only this app's caches are removed, never caches
       belonging to anything else on the same site. */
    await Promise.all(
      keys
        .filter(key =>
          key !== CACHE &&
          APP_CACHE_PREFIXES.some(prefix => key.startsWith(prefix))
        )
        .map(key => caches.delete(key))
    );

    await self.clients.claim();
  })());
});

self.addEventListener("fetch", event => {
  const req = event.request;

  if (req.method !== "GET") return;

  const url = new URL(req.url);

  /* Apps Script, R2 and CDN requests are never touched. */
  if (url.origin !== location.origin) return;

  /* Opening the app: serve the cached page so it works offline. */
  if (
    req.mode === "navigate" &&
    (url.pathname.endsWith("/") || url.pathname.endsWith("/index.html"))
  ) {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE);
      return (
        (await cache.match("./index.html")) ||
        (await cache.match("./")) ||
        fetch(req)
      );
    })());
    return;
  }

  /* App files: cached copy first (ignoring ?v=...), else network. */
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);

    const cached = await cache.match(req, { ignoreSearch: true });
    if (cached) return cached;

    const res = await fetch(req);

    /* Icons are cached on first use so they also work offline. */
    if (res.ok && url.pathname.includes("/icons/")) {
      cache.put(req, res.clone());
    }

    return res;
  })());
});

/*
 * v19.8: monthly master downloaded in the background (Chrome on Android).
 * The finished file waits in the cache "fieldwork-master-bg" (not removed
 * by new app versions) until the app loads it and deletes it.
 */
const MASTER_BG_CACHE = "fieldwork-master-bg";

async function tellApp(message) {
  const list = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  list.forEach(c => c.postMessage(message));
}

self.addEventListener("backgroundfetchsuccess", event => {
  event.waitUntil((async () => {
    const bg = event.registration;
    const records = await bg.matchAll();
    const cache = await caches.open(MASTER_BG_CACHE);
    for (const record of records) {
      const res = await record.responseReady;
      if (res && res.ok) {
        await cache.put(new Request("./__master-bg/" + encodeURIComponent(bg.id)), res);
      }
    }
    await event.updateUI({ title: "Master Data downloaded. Open the Fieldwork App to load it." });
    await tellApp({ type: "master-bg", id: bg.id, result: "success" });
  })());
});

self.addEventListener("backgroundfetchfail", event => {
  event.waitUntil((async () => {
    await event.updateUI({ title: "Master Data download failed. Open the Fieldwork App to try again." });
    await tellApp({ type: "master-bg", id: event.registration.id, result: "failure" });
  })());
});

self.addEventListener("backgroundfetchclick", event => {
  event.waitUntil(self.clients.openWindow("./"));
});

/*
 * v20.20: pending videos upload in the background (Background Sync, Chrome on
 * Android): also after the app is closed or the phone is locked. Same steps as
 * the app: upload link from Apps Script, file to R2, confirm, remove the hidden
 * copy. Only videos whose entry is already on the server. One upload at a
 * time with the app (lock "fieldwork-video-upload").
 */
const BG_VIDEO_SYNC_TAG = "fieldwork-videos";

self.addEventListener("sync", event => {
  if (event.tag !== BG_VIDEO_SYNC_TAG) return;
  event.waitUntil(bgVideoSync());
});

function bgOpenDb(name) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(name);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
function bgAll(db, store) {
  return new Promise((resolve, reject) => {
    if (!db.objectStoreNames.contains(store)) return resolve([]);
    const req = db.transaction(store, "readonly").objectStore(store).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}
function bgDelete(db, store, key) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readwrite");
    tx.objectStore(store).delete(key);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}
async function bgSession() {
  try {
    const cache = await caches.open("fieldwork-bg-session");
    const res = await cache.match("./bg-session");
    return res ? await res.json() : null;
  } catch (e) { return null; }
}
async function bgPost(sess, action, extra) {
  const res = await fetch(sess.server, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify(Object.assign({ action: action, token: sess.token }, extra))
  });
  return JSON.parse(await res.text());
}

async function bgVideoSync() {
  const sess = await bgSession();
  if (!sess || !sess.token || !sess.server || sess.mode === "off") return;
  const c = self.navigator && self.navigator.connection;
  if (sess.mode === "wifi" && c && c.type === "cellular") return;

  let more = false;
  const run = async () => { more = await bgUploadVideos(sess); };
  if (self.navigator.locks && self.navigator.locks.request) {
    await self.navigator.locks.request("fieldwork-video-upload", { ifAvailable: true }, async lock => { if (lock) await run(); });
  } else {
    await run();
  }
  /* time was up with videos left: ask for another turn */
  if (more) await self.registration.sync.register(BG_VIDEO_SYNC_TAG);
}

async function bgUploadVideos(sess) {
  const vdb = await bgOpenDb("FieldworkVideos");
  let uploaded = 0, tooLarge = 0;
  try {
    const videos = (await bgAll(vdb, "videos"))
      .filter(v => v && v.blob && String(v.user_id || "") === String(sess.user_id || ""))
      .sort((a, b) => String(a.recorded_at || "").localeCompare(String(b.recorded_at || "")));
    if (!videos.length) return false;

    /* only videos whose entry is already on the server */
    const adb = await bgOpenDb("ConsumerMobileApp");
    const ready = new Set();
    try {
      for (const [store, field] of [["disconnections", "disconnection_id"], ["rechecks", "recheck_id"]]) {
        (await bgAll(adb, store)).forEach(r => {
          if (String(r.upload_status || "").toUpperCase() === "UPLOADED" && r[field]) ready.add(r[field]);
        });
      }
    } finally { adb.close(); }

    const deadline = Date.now() + 150000;      /* Chrome gives a background turn a few minutes */
    for (const v of videos) {
      if (!ready.has(v.record_id)) continue;
      if (Date.now() > deadline) return true;
      const link = await bgPost(sess, "video_upload_url", {
        record_id: v.record_id, account_id: v.account_id, video_user_id: v.user_id,
        activity_type: v.activity_type, size_bytes: v.blob.size || v.size_bytes,
        content_type: v.content_type, recorded_at: v.recorded_at
      });
      if (!link.success) {
        if (link.code === "VIDEO_BAD_REQUEST" && /size/i.test(String(link.message || ""))) {
          await bgDelete(vdb, "videos", v.record_id); tooLarge++; continue;
        }
        if (link.code === "VIDEO_UPLOAD_DISABLED") { await bgDelete(vdb, "videos", v.record_id); continue; }
        return false;                         /* daily limit, login expired...: the app will say why */
      }
      if (!link.already_uploaded) {
        const put = await fetch(link.upload_url, {
          method: "PUT",
          headers: { "Content-Type": link.content_type || v.content_type || "application/octet-stream" },
          body: v.blob
        });
        if (!put.ok) throw new Error("Video storage returned HTTP " + put.status);
        const ok = await bgPost(sess, "video_uploaded", { record_id: v.record_id, activity_type: v.activity_type, key: link.key });
        if (!ok.success) throw new Error(ok.message || "Video upload could not be confirmed.");
      }
      await bgDelete(vdb, "videos", v.record_id);
      uploaded++;
    }
    return false;
  } finally {
    vdb.close();
    if (uploaded || tooLarge) await tellApp({ type: "videos-bg", uploaded: uploaded, tooLarge: tooLarge });
  }
}