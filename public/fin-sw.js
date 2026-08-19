// Life Investments (/fin): сервис-воркер офлайн-оболочки.
// Держит в кэше саму страницу и иконку, чтобы приложение открывалось без сети;
// записи в офлайне копятся в localStorage-очереди самой страницы и уходят на
// сервер при появлении связи. API-запросы не кэшируем — только оболочку.
const CACHE = "fin-shell-v1";

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(["/fin", "/fin-icon.png"])).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", (e) => {
  const u = new URL(e.request.url);
  // страница: сеть в приоритете (свежий код), офлайн — из кэша
  if (e.request.mode === "navigate" && u.pathname === "/fin") {
    e.respondWith(
      fetch(e.request).then((r) => {
        const cp = r.clone();
        caches.open(CACHE).then((c) => c.put("/fin", cp)).catch(() => {});
        return r;
      }).catch(() => caches.match("/fin"))
    );
    return;
  }
  if (u.pathname === "/fin-icon.png") {
    e.respondWith(caches.match(e.request).then((r) => r || fetch(e.request)));
  }
});
