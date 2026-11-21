// Life Investments (/fin): сервис-воркер офлайн-оболочки.
// Держит в кэше саму страницу и иконку, чтобы приложение открывалось без сети;
// записи в офлайне копятся в localStorage-очереди самой страницы и уходят на
// сервер при появлении связи. API-запросы не кэшируем — только оболочку.
const CACHE = "fin-shell-v4";
// Слабая сеть («значок есть, данные не идут»): ждём сервер не дольше 3 секунд,
// потом отдаём страницу из кэша, а свежую версию докладываем в кэш фоном (21.11).
const NET_WAIT_MS = 3000;

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
    const net = fetch(e.request).then((r) => {
      if (r && r.ok) { const cp = r.clone(); caches.open(CACHE).then((c) => c.put("/fin", cp)).catch(() => {}); }
      return r;
    });
    e.waitUntil(net.catch(() => {})); // докачка свежей версии в кэш, даже если отдали кэш
    e.respondWith((async () => {
      const cached = await caches.match("/fin");
      if (!cached) return net; // кэша ещё нет — только сеть
      const timeout = new Promise((res) => setTimeout(() => res(null), NET_WAIT_MS));
      const r = await Promise.race([net.catch(() => null), timeout]);
      return (r && r.ok) ? r : cached;
    })());
    return;
  }
  if (u.pathname === "/fin-icon.png") {
    e.respondWith(caches.match(e.request).then((r) => r || fetch(e.request)));
  }
});
