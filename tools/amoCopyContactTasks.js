#!/usr/bin/env node
/* Добор КОНТАКТНЫХ задач из amo (дыра первичного экспорта: в копии было 985 задач контактов,
 * все с 03.2026, тогда как в amo они с 2018 г. — экспорт шёл по сделкам и контактные не забрал.
 * Из-за этого фильтр «контакт без задач» врал: amo снимал 85 сделок «Доплаты», мы 11).
 * Строго 1 rps, read-only для amo. Идемпотентно (upsert по id). Прогресс — в лог. */
const fs = require("fs");
const path = require("path");
require("dotenv").config({ path: "/var/www/voyo/.env" });
const axios = require("axios");
const Database = require("/var/www/voyo/crm-svc/node_modules/better-sqlite3");
const db = new Database("/var/www/voyo/.amocopy-db/crm.db");
db.pragma("journal_mode = WAL");
db.pragma("busy_timeout = 15000");
const TOK = process.env.AMO_ACCESS_TOKEN;
const SUB = (process.env.AMO_SUBDOMAIN || "").replace(/^https?:\/\//, "").replace(/\..*/, "");
const BASE = `https://${SUB}.amocrm.ru`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const STATE = "/var/www/voyo/.amocopy-db/ctasks-state.json";
const up = db.prepare(`INSERT INTO tasks(id,entity_type,entity_id,text,task_type,complete_till,is_completed,responsible_user_id,result,created_at)
  VALUES(@id,@entity_type,@entity_id,@text,@task_type,@complete_till,@is_completed,@responsible_user_id,@result,@created_at)
  ON CONFLICT(id) DO UPDATE SET text=@text,complete_till=@complete_till,is_completed=@is_completed,responsible_user_id=@responsible_user_id,result=@result`);
const row = (t) => ({ id: t.id, entity_type: t.entity_type || "contacts", entity_id: t.entity_id || 0, text: t.text || "",
  task_type: t.task_type_id || 0, complete_till: t.complete_till || 0, is_completed: t.is_completed ? 1 : 0,
  responsible_user_id: t.responsible_user_id || 0, result: JSON.stringify(t.result || null), created_at: t.created_at || 0 });
let st = { since: 1, pages: 0, added: 0 }; // from=0 amo отдаёт 204 — стартуем с 1
try { st = JSON.parse(fs.readFileSync(STATE, "utf8")); } catch (_) {}
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
(async () => {
  console.log(`старт: продолжаю с updated_at>=${st.since} (страниц ранее ${st.pages}, добавлено ${st.added})`);
  let url = `${BASE}/api/v4/tasks`;
  let params = { limit: 250, "filter[entity_type]": "contacts", "order[updated_at]": "asc", "filter[updated_at][from]": Math.max(1, st.since) };
  let pages = 0;
  while (url) {
    const d = await get(url, params); params = undefined;
    if (!d) break;
    const ts = ((d._embedded || {}).tasks || []);
    if (!ts.length) break;
    db.transaction(() => { for (const t of ts) { up.run(row(t)); st.added++; } })();
    st.since = Math.max(st.since, ...ts.map((t) => t.updated_at || 0));
    pages++; st.pages++;
    fs.writeFileSync(STATE, JSON.stringify(st));
    if (pages % 20 === 0) console.log(`  страниц ${pages}, всего записей ${st.added}, дошли до ${new Date(st.since * 1000).toISOString().slice(0, 10)}`);
    url = (d._links && d._links.next && d._links.next.href) || null;
    if (url) { const u = new URL(url); params = Object.fromEntries(u.searchParams); url = u.origin + u.pathname; }
  }
  const n = db.prepare("SELECT COUNT(*) c FROM tasks WHERE entity_type='contacts'").get().c;
  console.log(`ГОТОВО: страниц за прогон ${pages}, контактных задач в копии теперь ${n}`);
})().catch((e) => { console.error("ОШИБКА:", e.message); process.exit(1); });
