// ─────────────────────────────────────────────────────────────────────────
// ak-co.ru/map — карта всего: домены, сервисы, страницы, разделы, задачи.
//
// Страница ничего не знает про инфраструктуру: она лишь показывает снимок
// .sitemap.json, который раз в час собирает сканер tools/sitemap-scan.js из
// живых источников (nginx, pm2, объявления маршрутов в коде, crontab).
// Поэтому карта не требует ручной поддержки и не может отстать от реальности
// больше чем на час.
//
// Вход — тот же, что у личных финансов: код 280992 и Face ID. Снимок
// показывает всю внутреннюю поверхность бизнеса, публичным ему быть незачем.
// ─────────────────────────────────────────────────────────────────────────

const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");

const SNAPSHOT = process.env.SITEMAP_OUT || path.join(__dirname, ".sitemap.json");
const SCANNER = "/var/www/voyo/tools/sitemap-scan.js";

function mount(app, deps) {
  const requireFin = deps.requireFin;

  app.get("/map", (req, res) => {
    res.set("Cache-Control", "no-store, no-cache, must-revalidate");
    res.sendFile(path.join(__dirname, "public", "map.html"));
  });

  app.get("/map/api/data", requireFin, (req, res) => {
    fs.readFile(SNAPSHOT, "utf8", (err, txt) => {
      if (err) return res.json({ success: false, message: "Снимок ещё не собран. Нажмите «Обновить»." });
      try { res.json({ success: true, data: JSON.parse(txt) }); }
      catch (e) { res.json({ success: false, message: "Снимок повреждён" }); }
    });
  });

  // Ручное пересобирание — на случай «только что выкатили, хочу видеть сейчас».
  // Без письма: письмо шлёт часовой прогон, иначе кнопка спамила бы почту.
  let running = false;
  app.post("/map/api/refresh", requireFin, (req, res) => {
    if (running) return res.json({ success: false, message: "Уже идёт" });
    running = true;
    execFile("/usr/bin/node", [SCANNER, "--quiet"], { timeout: 120000 }, (err, stdout, stderr) => {
      running = false;
      if (err) return res.json({ success: false, message: String((stderr || err.message || "").slice(0, 200)) });
      res.json({ success: true, log: String(stdout || "").trim() });
    });
  });

  console.log("MAP: /map смонтирован (карта инфраструктуры)");
}

module.exports = { mount };
