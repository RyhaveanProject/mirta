/* Ryhavean PWA Service Worker */
const CACHE_VERSION = "ryhavean-v2.0.0";
const APP_SHELL = `${CACHE_VERSION}-shell`;
const RUNTIME   = `${CACHE_VERSION}-runtime`;
const IMAGES    = `${CACHE_VERSION}-images`;

const PRECACHE_URLS = [
  "/", "/index.html", "/manifest.json", "/offline.html",
  "/icons/icon-192.png", "/icons/icon-512.png", "/icons/apple-touch-icon.png"
];

self.addEventListener("install", (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(APP_SHELL).then((cache) =>
      Promise.all(PRECACHE_URLS.map((u) => cache.add(u).catch(() => null)))
    )
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => !k.startsWith(CACHE_VERSION)).map((k) => caches.delete(k)));
    if (self.registration.navigationPreload) {
      try { await self.registration.navigationPreload.enable(); } catch {}
    }
    await self.clients.claim();
  })());
});

const isYouTube = (url) =>
  /(^https?:\/\/(www\.)?youtube\.com)|((^https?:\/\/)?(i\.)?ytimg\.com)|(googlevideo\.com)|(youtu\.be)/i.test(url);

const isAPI = (url) => {
  try {
    const u = new URL(url);
    // Audio stream-lÉrini service worker-dÉn tamamilÉ keÃ§ir â iOS background-da Range request-lÉr
    // vÉ bÃ¶yÃ¼k axÄ±n service worker Ã¼zÉrindÉn keÃ§mÉmÉlidir.
    if (/\/api\/audio\//.test(u.pathname)) return false;
    return u.pathname.startsWith("/api") || /onrender\.com/.test(u.hostname) || /ryhavean-spotify-backend/.test(u.hostname);
  } catch { return false; }
};

const isAudioStream = (url) => {
  try {
    const u = new URL(url);
    return /\/api\/audio\//.test(u.pathname);
  } catch { return false; }
};

const isImage = (req) =>
  req.destination === "image" ||
  /\.(?:png|jpg|jpeg|webp|gif|svg|ico)$/i.test(new URL(req.url).pathname);

const isStatic = (req) => ["style", "script", "font", "manifest"].includes(req.destination);

const networkWithTimeout = (request, timeout = 8000) =>
  new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timeout")), timeout);
    fetch(request).then((r) => { clearTimeout(t); resolve(r); }).catch((e) => { clearTimeout(t); reject(e); });
  });

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = req.url;

  if (isYouTube(url)) return;
  if (isAudioStream(url)) return; // audio proxy stream-i SW-dan tam keÃ§ir
  if (url.startsWith("chrome-extension://")) return;
  if (req.headers.has("range")) return;

  if (req.mode === "navigate") {
    event.respondWith((async () => {
      try {
        const preload = await event.preloadResponse;
        if (preload) return preload;
        const fresh = await networkWithTimeout(req, 5000);
        const cache = await caches.open(APP_SHELL);
        cache.put("/", fresh.clone()).catch(() => {});
        return fresh;
      } catch {
        const cache = await caches.open(APP_SHELL);
        const cached = await cache.match("/") || await cache.match("/index.html");
        if (cached) return cached;
        const offline = await cache.match("/offline.html");
        if (offline) return offline;
        return new Response("Offline", { status: 503, statusText: "Offline" });
      }
    })());
    return;
  }

  if (isAPI(url)) {
    event.respondWith((async () => {
      try {
        const fresh = await networkWithTimeout(req, 10000);
        const cache = await caches.open(RUNTIME);
        cache.put(req, fresh.clone()).catch(() => {});
        return fresh;
      } catch {
        const cache = await caches.open(RUNTIME);
        const cached = await cache.match(req);
        if (cached) return cached;
        return new Response(JSON.stringify({ offline: true, error: "Network unavailable" }),
          { status: 503, headers: { "Content-Type": "application/json" } });
      }
    })());
    return;
  }

  if (isImage(req)) {
    event.respondWith((async () => {
      const cache = await caches.open(IMAGES);
      const cached = await cache.match(req);
      if (cached) return cached;
      try {
        const fresh = await fetch(req);
        if (fresh && fresh.ok) cache.put(req, fresh.clone()).catch(() => {});
        return fresh;
      } catch {
        return cached || new Response("", { status: 504 });
      }
    })());
    return;
  }

  if (isStatic(req)) {
    event.respondWith((async () => {
      const cache = await caches.open(APP_SHELL);
      const cached = await cache.match(req);
      const fetchPromise = fetch(req).then((res) => {
        if (res && res.ok) cache.put(req, res.clone()).catch(() => {});
        return res;
      }).catch(() => cached);
      return cached || fetchPromise;
    })());
    return;
  }

  event.respondWith((async () => {
    const cache = await caches.open(RUNTIME);
    const cached = await cache.match(req);
    const fetchPromise = fetch(req).then((res) => {
      if (res && res.ok && res.type !== "opaque") cache.put(req, res.clone()).catch(() => {});
      return res;
    }).catch(() => cached);
    return cached || fetchPromise;
  })());
});

self.addEventListener("message", (event) => {
  if (event.data === "SKIP_WAITING") self.skipWaiting();
});
