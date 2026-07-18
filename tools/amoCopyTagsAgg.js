#!/usr/bin/env node
/* Агрегат тегов сделок → .amocopy-db/tags_agg.json (для колонки «Теги» в панели фильтра, как в amo).
 * json_each по leads.tags = ~9с на 291k — поэтому файл + cron ежесуточно (03:40 МСК, после reconcile).
 */
const Database = require(process.env.SQLITE_MODULE || "/var/www/voyo/crm-svc/node_modules/better-sqlite3");
const fs = require("fs");
const db = new Database(process.env.AMOCOPY_DB || "/var/www/voyo/.amocopy-db/crm.db", { readonly: true });
const t0 = Date.now();
const rows = db.prepare("SELECT je.value v, COUNT(*) c FROM leads, json_each(leads.tags) je WHERE leads.tags IS NOT NULL AND leads.tags != '[]' GROUP BY je.value ORDER BY c DESC LIMIT 60").all();
fs.writeFileSync("/var/www/voyo/.amocopy-db/tags_agg.json", JSON.stringify(rows));
console.log("тегов:", rows.length, "за", Date.now() - t0, "мс; топ:", rows[0] && (rows[0].v + " " + rows[0].c));
