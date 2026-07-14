#!/usr/bin/env node
/* Экспорт типов задач amoCRM в таблицу task_types (read-only, 1 запрос). */
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });
const axios = require("axios");
const Database = require(process.env.SQLITE_MODULE || "/var/www/voyo/crm-svc/node_modules/better-sqlite3");
const db = new Database(process.env.AMOCOPY_DB || "/var/www/voyo/.amocopy-db/crm.db");
db.pragma("journal_mode = WAL");
db.exec("CREATE TABLE IF NOT EXISTS task_types (id INTEGER PRIMARY KEY, name TEXT, icon_id INTEGER)");
const TOK = process.env.AMO_ACCESS_TOKEN;
const SUB = (process.env.AMO_SUBDOMAIN || "").replace(/^https?:\/\//, "").replace(/\..*/, "");
(async () => {
  const r = await axios.get(`https://${SUB}.amocrm.ru/api/v4/account`, { params: { with: "task_types" }, headers: { Authorization: "Bearer " + TOK, "X-Requested-With": "XMLHttpRequest" }, validateStatus: null, timeout: 30000 });
  const tt = (r.data && r.data._embedded && r.data._embedded.task_types) || [];
  const up = db.prepare("INSERT INTO task_types(id,name,icon_id) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,icon_id=excluded.icon_id");
  const tx = db.transaction((rows) => { for (const t of rows) up.run(t.id, t.name || "", t.icon_id || null); });
  tx(tt);
  console.log("типов задач сохранено:", db.prepare("SELECT COUNT(*) c FROM task_types").get().c);
})().catch((e) => { console.error("ОШИБКА:", e.message); process.exit(1); });
