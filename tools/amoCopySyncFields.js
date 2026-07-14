#!/usr/bin/env node
/*
 * Актуализация ОПРЕДЕЛЕНИЙ кастомных полей (cf_defs) из живой amoCRM.
 * Read-only к amo (1 rps), upsert в .amocopy-db/crm.db. Ловит поля, добавленные
 * в amo после слепка. Запуск: node tools/amoCopySyncFields.js
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
let last = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function amo(url, params) {
  for (let a = 1; a <= 5; a++) {
    const w = last + 1000 - Date.now(); if (w > 0) await sleep(w); last = Date.now();
    const r = await axios.get(BASE + url, { headers: { Authorization: "Bearer " + TOK, "X-Requested-With": "XMLHttpRequest" }, params, validateStatus: null, timeout: 60000 });
    if (r.status === 200) return r.data;
    if (r.status === 401 || r.status === 403) throw new Error(r.status + " — стоп (защита аккаунта)");
    if (r.status === 429) { console.log("429 — пауза 60с"); await sleep(60000); continue; }
    console.log("HTTP", r.status, "повтор", a); await sleep(3000 * a);
  }
  throw new Error("исчерпаны попытки " + url);
}
try { db.exec("ALTER TABLE cf_defs ADD COLUMN editable INTEGER DEFAULT 1"); } catch (_) {} // редактируемость (0 = только чтение)
const up = db.prepare(`INSERT INTO cf_defs(entity,id,name,type,code,enums,sort,editable) VALUES(@entity,@id,@name,@type,@code,@enums,@sort,@editable)
  ON CONFLICT(entity,id) DO UPDATE SET name=excluded.name,type=excluded.type,code=excluded.code,enums=excluded.enums,sort=excluded.sort,editable=excluded.editable`);
(async () => {
  for (const ent of ["leads", "contacts", "companies"]) {
    let page = 1, n = 0;
    while (true) {
      const d = await amo(`/api/v4/${ent}/custom_fields`, { limit: 250, page });
      const items = (d && d._embedded && d._embedded.custom_fields) || [];
      for (const f of items) {
        // нередактируемое в UI: is_api_only, вычисляемые (formula) и трекинговые
        const editable = (f.is_api_only || f.type === "formula" || f.type === "tracking_data") ? 0 : 1;
        up.run({ entity: ent, id: f.id, name: f.name || "", type: f.type || "", code: f.code || null,
          enums: JSON.stringify((f.enums || []).map((e) => ({ id: e.id, value: e.value, sort: e.sort }))), sort: f.sort || 0, editable });
        n++;
      }
      if (items.length < 250) break;
      page++;
    }
    console.log(`[${ent}] обработано полей: ${n}`);
  }
  console.log("cf_defs актуализированы");
})().catch((e) => { console.error("ОШИБКА:", e.message); process.exit(1); });
