#!/usr/bin/env node
/* Бэкап НЕВОССТАНОВИМОГО из копии amoCRM (crm.voyotravel.ru).
 *
 * Полный crm.db (1.7G) на 10G-диске не ротируется; но б0льшая часть БД восстановима
 * слепком 06.07 + инкрементальным синком из amo. Навсегда теряемы только:
 *   - changelog, notes_new, sync_conflicts (правки, сделанные В КОПИИ)
 *   - локальные сущности id>=1e9 (leads/contacts/companies/tasks + связи)
 *   - amo_events, amo_notes (живой журнал/примечания: историю amo заново не выкачать)
 *   - служебные json (учётки, роли, sync-state, calls_agg, tags_agg, badges)
 * Их и бэкапим: SQLite-дамп выбранных таблиц + json → tar.gz с ротацией 14 шт.
 * Запуск: node tools/amoCopyBackup.js  (cron 05:00 МСК)
 */
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const Database = require(process.env.SQLITE_MODULE || "/var/www/voyo/crm-svc/node_modules/better-sqlite3");

const SRC = process.env.AMOCOPY_DB || "/var/www/voyo/.amocopy-db/crm.db";
const DIR = path.dirname(SRC);
const OUT_DIR = "/var/backups/amocopy";
const LOCAL = 1000000000;
const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
const work = `/tmp/amocopy-backup-${stamp}`;
fs.mkdirSync(OUT_DIR, { recursive: true });
fs.rmSync(work, { recursive: true, force: true });
fs.mkdirSync(work, { recursive: true });

const dstPath = path.join(work, "precious.db");
const dst = new Database(dstPath);
dst.exec(`ATTACH '${SRC}' AS src`);
dst.pragma("busy_timeout = 15000");

const FULL_TABLES = ["changelog", "notes_new", "sync_conflicts", "amo_events", "amo_notes", "task_types", "users", "cf_defs", "cf_groups", "pipelines", "statuses", "customer_statuses", "local_seq"];
const LOCAL_ONLY = [["leads", "id"], ["contacts", "id"], ["companies", "id"], ["tasks", "id"], ["customers", "id"],
  ["lead_contacts", "lead_id"], ["lead_companies", "lead_id"], ["contact_companies", "contact_id"]];

let report = [];
for (const t of FULL_TABLES) {
  try { dst.exec(`CREATE TABLE ${t} AS SELECT * FROM src.${t}`); report.push(t + "=" + dst.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c); }
  catch (e) { report.push(t + ":skip(" + e.message.slice(0, 30) + ")"); }
}
for (const [t, col] of LOCAL_ONLY) {
  try { dst.exec(`CREATE TABLE local_${t} AS SELECT * FROM src.${t} WHERE ${col}>=${LOCAL}`); report.push("local_" + t + "=" + dst.prepare(`SELECT COUNT(*) c FROM local_${t}`).get().c); }
  catch (e) { report.push("local_" + t + ":skip"); }
}
dst.exec("DETACH src");
dst.close();

for (const f of fs.readdirSync(DIR)) if (f.endsWith(".json")) fs.copyFileSync(path.join(DIR, f), path.join(work, f));

const out = path.join(OUT_DIR, `amocopy-precious-${stamp}.tar.gz`);
execSync(`tar -czf '${out}' -C '${work}' .`);
fs.rmSync(work, { recursive: true, force: true });

// ротация: 14 последних
const files = fs.readdirSync(OUT_DIR).filter((f) => f.startsWith("amocopy-precious-")).sort();
while (files.length > 14) { fs.unlinkSync(path.join(OUT_DIR, files.shift())); }

const sz = (fs.statSync(out).size / 1e6).toFixed(1);
console.log(`бэкап ${out} (${sz} МБ): ${report.join(", ")}`);
