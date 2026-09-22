/* Хау мач — офлайн-кэш.
   Внешних адресов у приложения нет вообще: движок распознавания, языковая
   модель и шрифты либо лежат рядом, либо системные. Поэтому кэшируем только
   свой origin. Тяжёлые файлы движка (~13 МБ) не кладём в кэш при установке —
   они попадают туда при первом распознавании, чтобы установка не висела.
   Курсы валют не кэшируем никогда: они всегда идут в сеть, а без неё
   страница берёт последнее сохранённое значение из localStorage. */

var VERSION = "howmuch-v25";
var SHELL = VERSION + "-shell";
var HEAVY = VERSION + "-ocr";

var SHELL_FILES = ["./","index.html","manifest.webmanifest","icon-192.png","icon-512.png",
                   "fonts/pt-sans-caption-700-cyr.woff2","fonts/pt-sans-caption-700-lat.woff2"];
var NEVER = ["www.cbr-xml-daily.ru","cbr-xml-daily.ru"];

self.addEventListener("install", function(e){
  e.waitUntil(caches.open(SHELL).then(function(c){ return c.addAll(SHELL_FILES); })
    .then(function(){ return self.skipWaiting(); }));
});

self.addEventListener("activate", function(e){
  e.waitUntil(caches.keys().then(function(keys){
    return Promise.all(keys.map(function(k){
      if(k !== SHELL && k !== HEAVY) return caches.delete(k);
    }));
  }).then(function(){ return self.clients.claim(); }));
});

self.addEventListener("fetch", function(e){
  var req = e.request;
  if(req.method !== "GET") return;
  var url;
  try{ url = new URL(req.url); }catch(err){ return; }
  if(NEVER.indexOf(url.hostname) !== -1) return;
  if(url.origin !== self.location.origin) return;
  // Курс ЦБ отдаёт наш же сервер — адрес свой, но в кэш он не попадает
  // никогда: вчерашний курс хуже, чем честное «курс не загрузился».
  if(/\/howmuch\/rates$/.test(url.pathname)) return;

  if(req.mode === "navigate"){
    e.respondWith(fetch(req).catch(function(){
      return caches.match("index.html").then(function(r){ return r || caches.match("./"); });
    }));
    return;
  }

  var heavy = url.pathname.indexOf("/ocr/") !== -1;
  e.respondWith(caches.match(req).then(function(hit){
    var net = fetch(req).then(function(res){
      if(res && res.ok){
        var copy = res.clone();
        caches.open(heavy ? HEAVY : SHELL).then(function(c){ c.put(req, copy); });
      }
      return res;
    }).catch(function(){ return hit; });
    return hit || net;
  }));
});
