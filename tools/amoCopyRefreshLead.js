#!/usr/bin/env node
/* Принудительное обновление сделок из amo по id (1 rps, read-only к amo).
 * Нужен, когда инкрементальный синк пропустил сделку (watermark ушёл вперёд),
 * например после разморозки псевдо-конфликта. Использование:
 *   node tools/amoCopyRefreshLead.js 32481618 32602658 ...
 */
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });
const axios = require("axios");
const Database = require(process.env.SQLITE_MODULE || "/var/www/voyo/crm-svc/node_modules/better-sqlite3");
const db = new Database(process.env.AMOCOPY_DB || "/var/www/voyo/.amocopy-db/crm.db");
db.pragma("journal_mode = WAL");
db.pragma("busy_timeout = 8000");

const TOK = process.env.AMO_ACCESS_TOKEN;
const SUB = (process.env.AMO_SUBDOMAIN || "").replace(/^https?:\/\//, "").replace(/\..*/, "");
const BASE = `https://${SUB}.amocrm.ru`;
const ids = process.argv.slice(2).map((x) => parseInt(x, 10)).filter(Boolean);
if (!ids.length) { console.error("укажите id сделок"); process.exit(1); }

const cfExtract = (o) => JSON.stringify(o.custom_fields_values || null);
const upLead = db.prepare(`INSERT INTO leads(id,name,price,status_id,pipeline_id,responsible_user_id,created_at,updated_at,closed_at,cf,tags,contact_ids)
  VALUES(@id,@name,@price,@status_id,@pipeline_id,@responsible_user_id,@created_at,@updated_at,@closed_at,@cf,@tags,@contact_ids)
  ON CONFLICT(id) DO UPDATE SET name=@name,price=@price,status_id=@status_id,pipeline_id=@pipeline_id,responsible_user_id=@responsible_user_id,updated_at=@updated_at,closed_at=@closed_at,cf=@cf,tags=@tags,contact_ids=@contact_ids`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  for (const id of ids) {
    const r = await axios.get(`${BASE}/api/v4/leads/${id}`, { params: { with: "contacts" }, headers: { Authorization: "Bearer " + TOK, "X-Requested-With": "XMLHttpRequest" }, validateStatus: null, timeout: 30000 });
    if (r.status !== 200 || !r.data) { console.log(`lead ${id}: HTTP ${r.status} — пропуск`); await sleep(1100); continue; }
    const l = r.data;
    const cids = ((l._embedded && l._embedded.contacts) || []).map((c) => c.id);
    upLead.run({ id: l.id, name: l.name || "", price: l.price || 0, status_id: l.status_id, pipeline_id: l.pipeline_id, responsible_user_id: l.responsible_user_id || 0, created_at: l.created_at || 0, updated_at: l.updated_at || 0, closed_at: l.closed_at || 0, cf: cfExtract(l), tags: JSON.stringify(((l._embedded && l._embedded.tags) || []).map((t) => t.name)), contact_ids: JSON.stringify(cids) });
    cids.forEach((cid) => db.prepare("INSERT OR IGNORE INTO lead_contacts(lead_id,contact_id) VALUES(?,?)").run(l.id, cid));
    console.log(`lead ${id}: обновлена из amo (updated_at ${new Date((l.updated_at || 0) * 1000).toISOString()})`);
    await sleep(1100); // строго ≤1 rps
  }
})().catch((e) => { console.error("ОШИБКА:", e.message); process.exit(1); });
