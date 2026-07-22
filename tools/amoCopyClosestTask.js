#!/usr/bin/env node
/* Разовый бэкфилл closest_task_at для сделок и контактов.
 * Зачем: фильтры «без задач» в amo смотрят ИМЕННО на это денормализованное поле, а не на
 * таблицу задач (найдено 23.07 — контакты с закрытыми задачами и непустым closest_task_at
 * amo считает «с задачей»). Дальше поле поддерживает синк и ночной reconcile — бесплатно.
 * Строго 1 rps, read-only для amo. Возобновляемый: состояние в .amocopy-db/cta-state.json.
 * Запуск: node tools/amoCopyClosestTask.js [contacts|leads|all]
 */
const fs = require("fs");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });
const axios = require("axios");
const Database = require(process.env.SQLITE_MODULE || "/var/www/voyo/crm-svc/node_modules/better-sqlite3");
const DB_PATH = process.env.AMOCOPY_DB || "/var/www/voyo/.amocopy-db/crm.db";
const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("busy_timeout = 15000");
try { db.exec("ALTER TABLE leads ADD COLUMN closest_task_at INTEGER"); } catch (_) {}
try { db.exec("ALTER TABLE contacts ADD COLUMN closest_task_at INTEGER"); } catch (_) {}
const TOK = process.env.AMO_ACCESS_TOKEN;
const SUB = String(process.env.AMO_SUBDOMAIN || "").replace(/^https?:\/\//, "").replace(/\..*/, "");
const BASE = `https://${SUB}.amocrm.ru`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const STATE = path.join(path.dirname(DB_PATH), "cta-state.json");
const what = process.argv[2] || "all";
let st = {}; try { st = JSON.parse(fs.readFileSync(STATE, "utf8")); } catch (_) {}

let last = 0;
async function get(url, params) {
  for (let a = 1; a <= 4; a++) {
    const w = last + 1100 - Date.now(); if (w > 0) await sleep(w); last = Date.now();
    let r;
    try { r = await axios.get(url, { params, headers: { Authorization: "Bearer " + TOK }, validateStatus: null, timeout: 45000 }); }
    catch (e) { console.log(`сеть (${e.message}) — повтор ${a}/4`); await sleep(5000 * a); continue; }
    if (r.status === 429 || r.status === 403) { console.log("СТОП: HTTP " + r.status + " — лимит"); process.exit(2); }
    if (r.status === 204) return null;
    if (r.status !== 200) { console.log("HTTP " + r.status); await sleep(3000 * a); continue; }
    return r.data;
  }
  return null;
}

async function run(entity) {
  const upd = db.prepare(`UPDATE ${entity} SET closest_task_at=? WHERE id=?`);
  const key = "since_" + entity;
  let since = st[key] || 1, pages = 0, seen = 0, filled = 0;
  let url = `${BASE}/api/v4/${entity}`;
  let params = { limit: 250, "order[updated_at]": "asc", "filter[updated_at][from]": since };
  while (url) {
    const d = await get(url, params); params = undefined;
    if (!d) break;
    const items = ((d._embedded || {})[entity] || []);
    if (!items.length) break;
    db.transaction(() => {
      for (const it of items) { upd.run(it.closest_task_at || null, it.id); seen++; if (it.closest_task_at) filled++; }
    })();
    since = Math.max(since, ...items.map((i) => i.updated_at || 0));
    st[key] = since; fs.writeFileSync(STATE, JSON.stringify(st));
    pages++;
    if (pages % 50 === 0) console.log(`  ${entity}: страниц ${pages}, записей ${seen}, с задачей ${filled}, дошли до ${new Date(since * 1000).toISOString().slice(0, 10)}`);
    url = (d._links && d._links.next && d._links.next.href) || null;
    if (url) { const u = new URL(url); params = Object.fromEntries(u.searchParams); url = u.origin + u.pathname; }
  }
  const n = db.prepare(`SELECT COUNT(*) c FROM ${entity} WHERE closest_task_at IS NOT NULL`).get().c;
  console.log(`${entity} ГОТОВО: страниц ${pages}, обработано ${seen}, с непустым closest_task_at в копии: ${n}`);
}

(async () => {
  if (what === "all" || what === "contacts") await run("contacts");
  if (what === "all" || what === "leads") await run("leads");
})().catch((e) => { console.error("ОШИБКА:", e.message); process.exit(1); });
