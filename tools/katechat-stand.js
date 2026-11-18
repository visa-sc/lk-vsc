// Стенд чата Кати (work.voyotravel.ru/chat.html) для проверки правок до выкладки.
// Запуск: node tools/katechat-stand.js <страница.html> [задержка_мс]  → http://127.0.0.1:4790/chat.html
// Ключ входа — файл .vt рядом со страницей (служебная сессия director@ из /var/www/voyo/.lkManagerSessions.json),
// после работы файл удалить. Только GET: прочтения и любые записи на сервер не проходят. NOCACHE=1 — без кэша браузера.
const http = require("http"), https = require("https"), fs = require("fs"), path = require("path");
const DIR = process.env.STAND_DIR || path.dirname(path.resolve(process.argv[2] || "."));
const TOKEN = fs.readFileSync(path.join(DIR, ".vt"), "utf8").trim();
const PAGE = process.argv[2] || path.join(DIR, "katechat", "chat.new.html");
const DELAY = +(process.argv[3] || 0);   // искусственная задержка ответов сервера, мс (имитация медленной связи)
http.createServer((req, res) => {
  const u = req.url.split("?")[0];
  if (u === "/chat.html") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    return res.end(fs.readFileSync(PAGE));
  }
  // STAND_PAGES=<папка>: любые страницы и файлы из неё (fot.html, air-portal.css…) отдаются местные —
  // так проверяются правки остальных страниц площадки Кати до выкладки (18.11.2026).
  if (process.env.STAND_PAGES && /^\/[\w.-]+\.(html|css|js)$/.test(u)) {
    const lp = path.join(process.env.STAND_PAGES, u.slice(1));
    if (fs.existsSync(lp)) {
      const ct = u.endsWith(".css") ? "text/css" : u.endsWith(".js") ? "text/javascript" : "text/html";
      res.writeHead(200, { "Content-Type": ct + "; charset=utf-8", "Cache-Control": "no-store" });
      return res.end(fs.readFileSync(lp));
    }
  }
  if (req.method !== "GET") { res.writeHead(200, { "Content-Type": "application/json" }); return res.end('{"ok":false,"error":"стенд: только просмотр"}'); }
  const headers = { "User-Agent": "chat-local-check", Authorization: "Bearer " + TOKEN };
  if (req.headers["if-none-match"]) headers["If-None-Match"] = req.headers["if-none-match"];
  setTimeout(() => {
    const p = https.request({ host: "work.voyotravel.ru", path: req.url, method: "GET", headers }, (r) => {
      const h = Object.assign({}, r.headers); delete h["content-security-policy"]; delete h["strict-transport-security"]; if (process.env.NOCACHE) { delete h.etag; h["cache-control"] = "no-store"; }
      res.writeHead(r.statusCode, h); r.pipe(res);
    });
    p.on("error", () => { res.writeHead(502); res.end(); });
    p.end();
  }, u.startsWith("/api/") ? DELAY : 0);
}).listen(4790, "127.0.0.1", () => console.log("стенд чата: http://127.0.0.1:4790/chat.html  задержка " + DELAY + " мс"));
