const CACHE_NAME = "get-code-now-v3";

const APP_SHELL = [
  "./",
  "./index.html",
  "./manifest.json",
  "./icons/icon-192.png",
  "./icons/icon-512.png"
];

// Install new service worker
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

// Activate and remove all older caches
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((cacheNames) => {
        return Promise.all(
          cacheNames.map((cacheName) => {
            if (cacheName !== CACHE_NAME) {
              return caches.delete(cacheName);
            }
          })
        );
      })
      .then(() => self.clients.claim())
  );
});

// Network-first strategy
// This keeps the website updated while still supporting offline fallback.
self.addEventListener("fetch", (event) => {
  const request = event.request;

  // Only handle GET requests.
  if (request.method !== "GET") {
    return;
  }

  const requestURL = new URL(request.url);

  // Handle page/navigation requests.
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request, { cache: "no-store" })
        .then((networkResponse) => {
          return networkResponse;
        })
        .catch(() => {
          return caches.match("./index.html");
        })
    );

    return;
  }

  // Handle same-origin static files.
  if (requestURL.origin === self.location.origin) {
    event.respondWith(
      fetch(request)
        .then((networkResponse) => {

          if (networkResponse && networkResponse.ok) {
            const responseClone = networkResponse.clone();

            caches.open(CACHE_NAME).then((cache) => {
              cache.put(request, responseClone);
            });
          }

          return networkResponse;
        })
        .catch(() => {
          return caches.match(request);
        })
    );
  }
});
