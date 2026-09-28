/*
 * Fieldwork PWA service worker
 *
 * RELEASE RULE:
 * Change CACHE_VERSION every time app.js, index.html,
 * style.css or any cached file changes on GitHub.
 * Phones get the new version on the next online open,
 * and show it on the open after that.
 */

const CACHE_VERSION = "v17.1";
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
  "./style.css"
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