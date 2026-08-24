// ── ak-co.ru: обособленный сервис личных финансов Андрея (переезд 24.08.2026) ──
// Полностью независим от основного приложения VOYO: свой процесс (pm2 «akfin»,
// порт 3005), свой каталог /var/www/akfin, свой nginx-vhost ak-co.ru, свои данные
// (.fin/). С доменами voyotravel/voyovoyo не пересекается ничем.
// Модуль fin.js — тот же, что жил в основном сервере; смонтирован без изменений.

const path = require("path");
const express = require("express");
const finMod = require("./fin");

const app = express();
const PORT = process.env.PORT || 3005;

app.disable("x-powered-by");
app.use(express.json({ limit: "1mb" }));

// Статика страницы (fin.html берётся модулем из public/)
const PUB = path.join(__dirname, "public");
app.get("/", (req, res) => res.redirect(302, "/fin"));
for (const f of ["fin-icon.png", "fin-bg.png", "fin-sw.js", "apple-touch-icon.png"]) {
  app.get("/" + f, (req, res) => res.sendFile(path.join(PUB, f)));
}

// Админского контура здесь нет — служебный /fin/api/status закрыт.
finMod.mount(app, { requireAdmin: (req, res) => res.status(403).json({ success: false, message: "Нет доступа" }) });

app.listen(PORT, "127.0.0.1", () => console.log("AKFIN: личные финансы на порту " + PORT));
