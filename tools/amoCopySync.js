#!/usr/bin/env node
/*
 * Инкрементальный дозабор из живой amoCRM в БД копии (.amocopy-db/crm.db).
 * СТРОГО read-only, 1 запрос/сек (аккаунт банили за лимиты — не трогаем скорость!).
 * Курсор по updated_at, состояние в .amocopy-db/sync-state.json.
 * Локальные правки НЕ затираются: если по сделке есть запись в changelog — амо-версию
 * не применяем, а помечаем конфликт (sync_conflicts), правку менеджера оставляем.
 *
 * Запуск: node tools/amoCopySync.js [--entity leads|contacts|tasks] [--max-pages N] [--since UNIX]
 * Без --since берёт lastSync из state (или момент слепка 06.07.2026).
 */
const fs = require("fs");
const path = require("path");
const axios = require("axios");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });
const Database = require(process.env.SQLITE_MODULE || "/var/www/voyo/crm-svc/node_modules/better-sqlite3");

const AMO_TOKEN = process.env.AMO_ACCESS_TOKEN;
const AMO_SUB = String(process.env.AMO_SUBDOMAIN || "").trim().replace(/^https?:\/\//i, "").replace(/\/.*$/, "").replace(/\.amocrm\.ru$/i, "");
const BASE = `https://${AMO_SUB}.amocrm.ru`;
const DB_PATH = process.env.AMOCOPY_DB || "/var/www/voyo/.amocopy-db/crm.db";
const STATE = path.join(path.dirname(DB_PATH), "sync-state.json");
const SNAPSHOT_TS = Math.floor(Date.UTC(2026, 6, 6, 0, 0, 0) / 1000); // 06.07.2026 — момент слепка
const RPS_MS = 1000; // строго 1 rps

function arg(n, d) { const i = process.argv.indexOf("--" + n); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; }
const ENTITY = arg("entity", "leads");
const MAX_PAGES = parseInt(arg("max-pages", "0"), 10) || Infinity;
const t0 = Date.now();
const log = (m) => console.log(`[+${Math.round((Date.now() - t0) / 1000)}s] ${m}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let state = {}; try { state = JSON.parse(fs.readFileSync(STATE, "utf8")); } catch (_) {}
const since = parseInt(arg("since", ""), 10) || state["last_" + ENTITY] || SNAPSHOT_TS;

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.exec("CREATE TABLE IF NOT EXISTS sync_conflicts (entity_type TEXT, entity_id INTEGER, ts INTEGER, note TEXT)");
const hasLocalEdit = db.prepare("SELECT 1 FROM changelog WHERE entity_type=? AND entity_id=? LIMIT 1");

let _last = 0;
async function amoGet(url, params) {
  for (let attempt = 1; attempt <= 5; attempt++) {
    const wait = _last + RPS_MS - Date.now(); if (wait > 0) await sleep(wait); _last = Date.now();
    const r = await axios.get(url, { headers: { Authorization: `Bearer ${AMO_TOKEN}`, "X-Requested-With": "XMLHttpRequest" }, params, timeout: 60000, validateStatus: null });
    if (r.status === 200) return r.data;
    if (r.status === 204) return null;
    if (r.status === 401 || r.status === 403) throw new Error(r.status + " — остановка (защита аккаунта)");
    if (r.status === 429) { log("429 — пауза 60с"); await sleep(60000); continue; }
    log(`HTTP ${r.status} — повтор ${attempt}/5`); await sleep(3000 * attempt);
  }
  throw new Error("исчерпаны попытки: " + url);
}

const cfExtract = (o) => JSON.stringify(o.custom_fields_values || null);
const phonesOf = (c) => { const r = []; (c.custom_fields_values || []).forEach((f) => { if (f.field_code === "PHONE") (f.values || []).forEach((v) => r.push(String(v.value))); }); return JSON.stringify(r); };
const emailsOf = (c) => { const r = []; (c.custom_fields_values || []).forEach((f) => { if (f.field_code === "EMAIL") (f.values || []).forEach((v) => r.push(String(v.value))); }); return JSON.stringify(r); };

const upLead = db.prepare(`INSERT INTO leads(id,name,price,status_id,pipeline_id,responsible_user_id,created_at,updated_at,closed_at,cf,tags,contact_ids)
  VALUES(@id,@name,@price,@status_id,@pipeline_id,@responsible_user_id,@created_at,@updated_at,@closed_at,@cf,@tags,@contact_ids)
  ON CONFLICT(id) DO UPDATE SET name=@name,price=@price,status_id=@status_id,pipeline_id=@pipeline_id,responsible_user_id=@responsible_user_id,updated_at=@updated_at,closed_at=@closed_at,cf=@cf,tags=@tags,contact_ids=@contact_ids`);
const upContact = db.prepare(`INSERT INTO contacts(id,name,responsible_user_id,created_at,updated_at,cf,phones,emails)
  VALUES(@id,@name,@responsible_user_id,@created_at,@updated_at,@cf,@phones,@emails)
  ON CONFLICT(id) DO UPDATE SET name=@name,responsible_user_id=@responsible_user_id,updated_at=@updated_at,cf=@cf,phones=@phones,emails=@emails`);

async function syncLeads() {
  let url = `${BASE}/api/v4/leads`, pages = 0, changed = 0, conflicts = 0, maxUpd = since;
  let params = { limit: 250, "order[updated_at]": "asc", "filter[updated_at][from]": since, with: "contacts" };
  while (url && pages < MAX_PAGES) {
    const data = await amoGet(url, params); params = undefined;
    if (!data) break;
    const items = (data._embedded && data._embedded.leads) || [];
    if (!items.length) break;
    const tx = db.transaction(() => {
      for (const l of items) {
        maxUpd = Math.max(maxUpd, l.updated_at || 0);
        if (hasLocalEdit.get("leads", l.id)) { db.prepare("INSERT INTO sync_conflicts VALUES('leads',?,?,?)").run(l.id, Math.floor(Date.now() / 1000), "локальная правка — амо-версия не применена"); conflicts++; continue; }
        const cids = ((l._embedded && l._embedded.contacts) || []).map((c) => c.id);
        upLead.run({ id: l.id, name: l.name || "", price: l.price || 0, status_id: l.status_id, pipeline_id: l.pipeline_id, responsible_user_id: l.responsible_user_id || 0, created_at: l.created_at || 0, updated_at: l.updated_at || 0, closed_at: l.closed_at || 0, cf: cfExtract(l), tags: JSON.stringify(((l._embedded && l._embedded.tags) || []).map((t) => t.name)), contact_ids: JSON.stringify(cids) });
        cids.forEach((cid) => db.prepare("INSERT OR IGNORE INTO lead_contacts(lead_id,contact_id) VALUES(?,?)").run(l.id, cid));
        changed++;
      }
    });
    tx();
    pages++;
    url = (data._links && data._links.next && data._links.next.href) || null;
    if (url) { const u = new URL(url); params = Object.fromEntries(u.searchParams); url = u.origin + u.pathname; }
    if (pages % 10 === 0) log(`leads: страниц ${pages}, обновлено ${changed}, конфликтов ${conflicts} (до ${new Date(maxUpd * 1000).toISOString().slice(0, 10)})`);
  }
  state.last_leads = maxUpd; fs.writeFileSync(STATE, JSON.stringify(state, null, 2));
  log(`leads ГОТОВО: страниц ${pages}, обновлено ${changed}, конфликтов ${conflicts}`);
}

async function syncContacts() {
  let url = `${BASE}/api/v4/contacts`, pages = 0, changed = 0, conflicts = 0, maxUpd = since;
  let params = { limit: 250, "order[updated_at]": "asc", "filter[updated_at][from]": since };
  while (url && pages < MAX_PAGES) {
    const data = await amoGet(url, params); params = undefined;
    if (!data) break;
    const items = (data._embedded && data._embedded.contacts) || [];
    if (!items.length) break;
    db.transaction(() => {
      for (const c of items) {
        maxUpd = Math.max(maxUpd, c.updated_at || 0);
        if (hasLocalEdit.get("contacts", c.id)) { conflicts++; continue; }
        upContact.run({ id: c.id, name: c.name || "", responsible_user_id: c.responsible_user_id || 0, created_at: c.created_at || 0, updated_at: c.updated_at || 0, cf: cfExtract(c), phones: phonesOf(c), emails: emailsOf(c) });
        changed++;
      }
    })();
    pages++;
    url = (data._links && data._links.next && data._links.next.href) || null;
    if (url) { const u = new URL(url); params = Object.fromEntries(u.searchParams); url = u.origin + u.pathname; }
    if (pages % 10 === 0) log(`contacts: страниц ${pages}, обновлено ${changed}`);
  }
  state.last_contacts = maxUpd; fs.writeFileSync(STATE, JSON.stringify(state, null, 2));
  log(`contacts ГОТОВО: страниц ${pages}, обновлено ${changed}, конфликтов ${conflicts}`);
}

const upTask = db.prepare(`INSERT INTO tasks(id,entity_type,entity_id,text,task_type,complete_till,is_completed,responsible_user_id,result,created_at)
  VALUES(@id,@entity_type,@entity_id,@text,@task_type,@complete_till,@is_completed,@responsible_user_id,@result,@created_at)
  ON CONFLICT(id) DO UPDATE SET text=@text,complete_till=@complete_till,is_completed=@is_completed,responsible_user_id=@responsible_user_id,result=@result`);
async function syncTasks() {
  // задачи создаём/обновляем только если у сделки нет локальной правки её задач нет смысла проверять — задачи амо приходят как есть,
  // локально созданные задачи имеют id>=1e9 и не пересекаются с амо-id
  let url = `${BASE}/api/v4/tasks`, pages = 0, changed = 0, maxUpd = since;
  let params = { limit: 250, "order[updated_at]": "asc", "filter[updated_at][from]": since };
  while (url && pages < MAX_PAGES) {
    const data = await amoGet(url, params); params = undefined;
    if (!data) break;
    const items = (data._embedded && data._embedded.tasks) || [];
    if (!items.length) break;
    db.transaction(() => {
      for (const t of items) {
        maxUpd = Math.max(maxUpd, t.updated_at || 0);
        upTask.run({ id: t.id, entity_type: t.entity_type || "leads", entity_id: t.entity_id || 0, text: t.text || "", task_type: t.task_type_id || 0, complete_till: t.complete_till || 0, is_completed: t.is_completed ? 1 : 0, responsible_user_id: t.responsible_user_id || 0, result: JSON.stringify(t.result || null), created_at: t.created_at || 0 });
        changed++;
      }
    })();
    pages++;
    url = (data._links && data._links.next && data._links.next.href) || null;
    if (url) { const u = new URL(url); params = Object.fromEntries(u.searchParams); url = u.origin + u.pathname; }
    if (pages % 10 === 0) log(`tasks: страниц ${pages}, обновлено ${changed}`);
  }
  state.last_tasks = maxUpd; fs.writeFileSync(STATE, JSON.stringify(state, null, 2));
  log(`tasks ГОТОВО: страниц ${pages}, обновлено ${changed}`);
}

(async () => {
  if (!AMO_TOKEN || !AMO_SUB) { console.error("нет AMO_ACCESS_TOKEN/AMO_SUBDOMAIN"); process.exit(1); }
  log(`Синк ${ENTITY} из ${BASE} с ${new Date(since * 1000).toISOString()} (1 rps, read-only, max-pages=${MAX_PAGES})`);
  if (ENTITY === "leads") await syncLeads();
  else if (ENTITY === "contacts") await syncContacts();
  else if (ENTITY === "tasks") await syncTasks();
  else { console.error("entity: leads|contacts|tasks"); process.exit(1); }
  db.close();
})().catch((e) => { log("ОСТАНОВКА: " + e.message); process.exit(2); });
