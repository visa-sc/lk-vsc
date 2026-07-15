#!/usr/bin/env node
/* Экспорт ГРУПП полей amo (custom_field_groups) + group_id каждого поля.
 * Нужен для карточек 1:1: настоящие группы amo (Основная информация/Касса/...)
 * приходят из API, а поля «---X---» — лишь текстовые подразделители внутри групп.
 * ~6 запросов (3 сущности × groups+fields), строго 1 rps.
 */
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });
const axios = require("axios");
const Database = require(process.env.SQLITE_MODULE || "/var/www/voyo/crm-svc/node_modules/better-sqlite3");
const db = new Database(process.env.AMOCOPY_DB || "/var/www/voyo/.amocopy-db/crm.db");
db.pragma("journal_mode = WAL");
db.pragma("busy_timeout = 8000");

db.exec(`CREATE TABLE IF NOT EXISTS cf_groups (
  entity TEXT, id TEXT, name TEXT, sort INTEGER, PRIMARY KEY(entity,id)
)`);
try { db.exec("ALTER TABLE cf_defs ADD COLUMN group_id TEXT"); } catch (_) { /* уже есть */ }

const TOK = process.env.AMO_ACCESS_TOKEN;
const SUB = (process.env.AMO_SUBDOMAIN || "").replace(/^https?:\/\//, "").replace(/\..*/, "");
const BASE = `https://${SUB}.amocrm.ru`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let last = 0;
async function get(url, params) {
  const wait = last + 1100 - Date.now(); if (wait > 0) await sleep(wait); last = Date.now();
  const r = await axios.get(url, { params, headers: { Authorization: "Bearer " + TOK, "X-Requested-With": "XMLHttpRequest" }, validateStatus: null, timeout: 30000 });
  if (r.status !== 200) { console.log("HTTP", r.status, url); return null; }
  return r.data;
}

(async () => {
  const upG = db.prepare("INSERT INTO cf_groups(entity,id,name,sort) VALUES(?,?,?,?) ON CONFLICT(entity,id) DO UPDATE SET name=excluded.name,sort=excluded.sort");
  const upF = db.prepare("UPDATE cf_defs SET group_id=? WHERE entity=? AND id=?");
  for (const ent of ["leads", "contacts", "companies"]) {
    const g = await get(`${BASE}/api/v4/${ent}/custom_fields/groups`);
    const groups = (g && g._embedded && g._embedded.custom_field_groups) || [];
    const tx1 = db.transaction(() => { for (const x of groups) upG.run(ent, String(x.id), x.name || "", x.sort || 0); });
    tx1();
    // поля с group_id (постранично; у нас максимум 221 — 1 страница при limit=250)
    let url = `${BASE}/api/v4/${ent}/custom_fields`, params = { limit: 250 }, cnt = 0;
    while (url) {
      const d = await get(url, params); params = undefined;
      if (!d) break;
      const items = (d._embedded && d._embedded.custom_fields) || [];
      const tx2 = db.transaction(() => { for (const f of items) { upF.run(f.group_id == null ? null : String(f.group_id), ent, f.id); cnt++; } });
      tx2();
      url = (d._links && d._links.next && d._links.next.href) || null;
    }
    console.log(ent + ": групп " + groups.length + ", полей с group_id " + cnt);
  }
  console.log("cf_groups всего:", db.prepare("SELECT COUNT(*) c FROM cf_groups").get().c);
})().catch((e) => { console.error("ОШИБКА:", e.message); process.exit(1); });
