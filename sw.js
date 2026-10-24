// build-www.mjs replaces this token with a content hash so an app update can
// never silently keep serving an older cached shell.
const CACHE_NAME = "biandu-shell-__BUILD_ID__";
const APP_SHELL = [
  "./",
  "./index.html",
  "./tablet.css",
  "./tablet.js",
  "./features.css",
  "./features.js",
  "./runtime.css",
  "./src/web/repository.js",
  "./src/web/deepseek.js",
  "./src/web/embeddings.js",
  "./src/web/knowledge-engine.js",
  "./src/web/maintenance.js",
  "./src/web/board.js",
  "./src/web/pages.js",
  "./src/web/reader.js",
  "./src/web/runtime.js",
  "./src/web/vision.js",
  "./src/web/prompts.js",
  "./manifest.webmanifest",
  "./assets/icon.svg",
  "./assets/icon-180.png",
  "./assets/icon-192.png",
  "./assets/icon-512.png",
  "./vendor/pdfjs/pdf.min.mjs",
  "./vendor/pdfjs/pdf.worker.min.mjs"
];

self.addEventListener("install", event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(async cache => {
        await cache.addAll(APP_SHELL);
        try {
          const manifestUrl = new URL("./vendor/pdfjs/offline-manifest.json", self.location);
          const response = await fetch(manifestUrl, { cache: "no-cache" });
          if (response.ok) {
            const assets = await response.json();
            if (Array.isArray(assets) && assets.length) await cache.addAll([...new Set(assets)]);
          }
        } catch (error) {
          console.warn("PDF.js offline resource precache failed", error);
        }
        return cache;
      })
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys
          .filter(key => key !== CACHE_NAME)
          .map(key => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", event => {
  if (event.request.method !== "GET") return;
  if (new URL(event.request.url).origin !== self.location.origin) return;

  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached;

      return fetch(event.request).then(response => {
        if (!response || response.status !== 200) return response;
        const copy = response.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(event.request, copy));
        return response;
      }).catch(async () => {
        if (event.request.mode === "navigate") return caches.match("./index.html");
        throw new Error("Offline resource unavailable");
      });
    })
  );
});
