/*
 * amocopy-svc — изолированный сервис для crm.voyotravel.ru (копия amoCRM).
 *
 * ПОЛНОСТЬЮ отдельный процесс (pm2 "amocopy-svc", порт 3001), свои node_modules.
 * Основной прод (pm2 "voyo", server.js, клиентский ЛК) он НЕ трогает — рестарты этого
 * сервиса на прод не влияют. nginx для хоста crm.voyotravel.ru проксирует сюда.
 *
 * Переиспользует маршруты чтения из ../amocopy.js (единый источник логики).
 * Доступ — только по коду (AMOCRM_COPY_CODE, дефолт 111); vsc-вход тут не нужен.
 *
 * Env (задаются в pm2 ecosystem):
 *   PORT=3001
 *   AMOCOPY_BASE=/var/www/voyo         (где public/amocrm_copy.html, amocopy-automations.md, amocopy.js)
 *   AMOCOPY_DIR=/var/www/voyo/.amocopy (данные слепка)
 *   AMOCOPY_SESS_FILE=/var/www/voyo/crm-svc/.amocopySessions.json
 *   AMOCOPY_DB_DIR=/var/www/voyo/.amocopy-db  (БД правок — появится на ночи 1, шаг SQLite)
 */
const path = require("path");
const express = require("express");

const BASE = process.env.AMOCOPY_BASE || path.join(__dirname, "..");
const PORT = parseInt(process.env.PORT || "3001", 10);

const app = express();
app.set("trust proxy", true);
app.use(express.json({ limit: "2mb" }));

// health-check самого сервиса (для мониторинга и деплой-проверок)
app.get("/__svc_health", (req, res) => res.json({ ok: true, svc: "amocopy-svc", port: PORT, ts: Date.now() }));

// корень хоста crm.voyotravel.ru — сразу страница копии
app.get("/", (req, res) => {
  res.set("Cache-Control", "no-cache");
  res.sendFile(path.join(BASE, "public", "amocrm_copy.html"));
});

// SPA-пути как в amo: F5/прямая ссылка на /leads/detail/123, /contacts/list/... и т.п.
// отдают приложение (роутинг делает фронт по location.pathname). Regex-роуты Express
// здесь падают (PathError) — поэтому middleware с ручной проверкой пути.
app.use((req, res, next) => {
  if (req.method === "GET" && /^\/(leads|contacts|companies|customers|todo|dashboard|stats|settings|mail|imbox|fdoc|wazzup|market|auto|refs|devnotes|catalogs)(\/|$)/.test(req.path)) {
    res.set("Cache-Control", "no-cache");
    return res.sendFile(path.join(BASE, "public", "amocrm_copy.html"));
  }
  next();
});

// на этом сервисе доступ только по коду — vsc-fallback отклоняем
function noVscAccess(req, res) {
  return res.status(401).json({ success: false, message: "Нужен вход по коду" });
}

// монтируем все читающие маршруты /amocrm_copy и /amocrm_copy/api из общего модуля
require(path.join(BASE, "amocopy.js"))(app, noVscAccess);

app.listen(PORT, "127.0.0.1", () => {
  console.log(`amocopy-svc слушает 127.0.0.1:${PORT}, BASE=${BASE}`);
});
