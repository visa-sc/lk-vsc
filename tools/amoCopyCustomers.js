#!/usr/bin/env node
/*
 * Экспорт модуля «Покупатели» (customers) из amoCRM в копию (.amocopy-db/crm.db).
 * READ-ONLY к amo, СТРОГО 1 rps (аккаунт банили за лимиты). Резюмируемый по page.
 * Создаёт таблицы customers + customer_statuses. Запуск: node tools/amoCopyCustomers.js
 */
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });
const axios = require("axios");
const Database = require(process.env.SQLITE_MODULE || "/var/www/voyo/crm-svc/node_modules/better-sqlite3");
const DB_PATH = process.env.AMOCOPY_DB || "/var/www/voyo/.amocopy-db/crm.db";
const TOK = process.env.AMO_ACCESS_TOKEN;
const SUB = (process.env.AMO_SUBDOMAIN || "").replace(/^https?:\/\//, "").replace(/\..*/, "");
const BASE = `https://${SUB}.amocrm.ru`;
const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.exec(`CREATE TABLE IF NOT EXISTS customers (id INTEGER PRIMARY KEY, name TEXT, status_id INTEGER, responsible_user_id INTEGER,
  next_price INTEGER, next_date INTEGER, ltv INTEGER, purchases_count INTEGER, average_check INTEGER,
  created_at INTEGER, updated_at INTEGER, cf TEXT)`);
db.exec("CREATE TABLE IF NOT EXISTS customer_statuses (id INTEGER PRIMARY KEY, name TEXT, sort INTEGER, color TEXT)");

let last = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function amo(url, params) {
  for (let a = 1; a <= 5; a++) {
    const w = last + 1000 - Date.now(); if (w > 0) await sleep(w); last = Date.now();
    const r = await axios.get(BASE + url, { headers: { Authorization: "Bearer " + TOK, "X-Requested-With": "XMLHttpRequest" }, params, validateStatus: null, timeout: 60000 });
    if (r.status === 200) return r.data;
    if (r.status === 204) return null;
    if (r.status === 401 || r.status === 403) throw new Error(r.status + " — стоп (защита аккаунта)");
    if (r.status === 429) { console.log("429 — пауза 60с"); await sleep(60000); continue; }
    console.log("HTTP", r.status, "повтор", a); await sleep(3000 * a);
  }
  throw new Error("исчерпаны попытки " + url);
}
const upC = db.prepare(`INSERT INTO customers(id,name,status_id,responsible_user_id,next_price,next_date,ltv,purchases_count,average_check,created_at,updated_at,cf)
  VALUES(@id,@name,@status_id,@responsible_user_id,@next_price,@next_date,@ltv,@purchases_count,@average_check,@created_at,@updated_at,@cf)
  ON CONFLICT(id) DO UPDATE SET name=excluded.name,status_id=excluded.status_id,responsible_user_id=excluded.responsible_user_id,
  next_price=excluded.next_price,next_date=excluded.next_date,ltv=excluded.ltv,purchases_count=excluded.purchases_count,
  average_check=excluded.average_check,updated_at=excluded.updated_at,cf=excluded.cf`);
const upS = db.prepare("INSERT INTO customer_statuses(id,name,sort,color) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,sort=excluded.sort,color=excluded.color");
(async () => {
  // статусы «Покупателей»
  try {
    const st = await amo("/api/v4/customers/statuses");
    const arr = (st && st._embedded && st._embedded.statuses) || [];
    for (const s of arr) upS.run(s.id, s.name || "", s.sort || 0, s.color || null);
    console.log("статусов Покупателей:", arr.length);
  } catch (e) { console.log("статусы не получены:", e.message); }
  // сами покупатели
  let page = 1, total = 0;
  while (true) {
    const d = await amo("/api/v4/customers", { limit: 250, page });
    const items = (d && d._embedded && d._embedded.customers) || [];
    const tx = db.transaction((rows) => { for (const c of rows) upC.run({
      id: c.id, name: c.name || "", status_id: c.status_id || 0, responsible_user_id: c.responsible_user_id || 0,
      next_price: c.next_price || 0, next_date: c.next_date || 0, ltv: c.ltv || 0,
      purchases_count: c.purchases_count || 0, average_check: c.average_check || 0,
      created_at: c.created_at || 0, updated_at: c.updated_at || 0, cf: JSON.stringify(c.custom_fields_values || null) }); });
    tx(items);
    total += items.length;
    console.log(`page ${page}: +${items.length} (всего ${total})`);
    if (!(d && d._links && d._links.next)) break;
    page++;
  }
  console.log("ГОТОВО. Покупателей в копии:", db.prepare("SELECT COUNT(*) c FROM customers").get().c);
})().catch((e) => { console.error("ОШИБКА:", e.message); process.exit(1); });
