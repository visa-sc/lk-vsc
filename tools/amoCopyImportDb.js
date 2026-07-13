#!/usr/bin/env node
/*
 * Импорт слепка .amocopy → SQLite (.amocopy-db/crm.db) для crm.voyotravel.ru.
 * Фундамент под редактирование (ночь 2). Слепок .amocopy НЕ меняется (эталон, только чтение).
 * Примечания в БД НЕ грузим (экономия диска) — историю читаем из bucket-файлов слепка;
 *   новые примечания/правки будут писаться в отдельные таблицы.
 *
 * Запуск: node tools/amoCopyImportDb.js [--src /var/www/voyo/.amocopy] [--db /var/www/voyo/.amocopy-db/crm.db]
 * Идемпотентно: пересоздаёт таблицы данных из слепка (edits-таблицы не трогает).
 */
const fs = require("fs");
const path = require("path");
const readline = require("readline");
const Database = require(process.env.SQLITE_MODULE || "better-sqlite3");

function arg(name, def) {
  const i = process.argv.indexOf("--" + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
const SRC = path.resolve(arg("src", "/var/www/voyo/.amocopy"));
const DBPATH = path.resolve(arg("db", "/var/www/voyo/.amocopy-db/crm.db"));
fs.mkdirSync(path.dirname(DBPATH), { recursive: true });

const t0 = Date.now();
const log = (m) => console.log(`[+${Math.round((Date.now() - t0) / 1000)}s] ${m}`);
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(path.join(SRC, f), "utf8")); } catch (_) { return null; } };

const db = new Database(DBPATH);
db.pragma("journal_mode = WAL");
db.pragma("synchronous = NORMAL");

// ── схема: данные слепка (snapshot_*) отдельно от будущих правок (edit-таблицы не тут) ──
db.exec(`
CREATE TABLE IF NOT EXISTS pipelines (id INTEGER PRIMARY KEY, name TEXT, sort INTEGER, is_main INTEGER, data TEXT);
CREATE TABLE IF NOT EXISTS statuses (id INTEGER, pipeline_id INTEGER, name TEXT, sort INTEGER, color TEXT, type INTEGER, PRIMARY KEY(pipeline_id,id));
CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, name TEXT, email TEXT, role TEXT, grp TEXT, is_admin INTEGER);
CREATE TABLE IF NOT EXISTS cf_defs (entity TEXT, id INTEGER, name TEXT, type TEXT, code TEXT, enums TEXT, sort INTEGER, PRIMARY KEY(entity,id));
CREATE TABLE IF NOT EXISTS leads (
  id INTEGER PRIMARY KEY, name TEXT, price INTEGER, status_id INTEGER, pipeline_id INTEGER,
  responsible_user_id INTEGER, created_at INTEGER, updated_at INTEGER, closed_at INTEGER,
  cf TEXT, tags TEXT, contact_ids TEXT
);
CREATE TABLE IF NOT EXISTS contacts (
  id INTEGER PRIMARY KEY, name TEXT, responsible_user_id INTEGER, created_at INTEGER, updated_at INTEGER,
  cf TEXT, phones TEXT, emails TEXT
);
CREATE TABLE IF NOT EXISTS companies (id INTEGER PRIMARY KEY, name TEXT, created_at INTEGER, updated_at INTEGER, cf TEXT);
CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY, entity_type TEXT, entity_id INTEGER, text TEXT, task_type INTEGER,
  complete_till INTEGER, is_completed INTEGER, responsible_user_id INTEGER, result TEXT, created_at INTEGER
);
CREATE TABLE IF NOT EXISTS lead_contacts (lead_id INTEGER, contact_id INTEGER, PRIMARY KEY(lead_id,contact_id));
`);

// чистим только snapshot-таблицы (правки, если появятся, в других таблицах)
for (const t of ["pipelines", "statuses", "users", "cf_defs", "leads", "contacts", "companies", "tasks", "lead_contacts"]) db.exec(`DELETE FROM ${t}`);

function streamNd(dir, onItem) {
  return new Promise((resolve) => {
    const d = path.join(SRC, dir);
    if (!fs.existsSync(d)) return resolve(0);
    const files = fs.readdirSync(d).filter((f) => f.endsWith(".ndjson"));
    let n = 0, done = 0;
    if (!files.length) return resolve(0);
    files.forEach((f) => {
      const rl = readline.createInterface({ input: fs.createReadStream(path.join(d, f), "utf8"), crlfDelay: Infinity });
      rl.on("line", (l) => { if (!l.trim()) return; try { onItem(JSON.parse(l)); n++; } catch (_) {} });
      rl.on("close", () => { if (++done === files.length) resolve(n); });
    });
  });
}

const cfExtract = (obj) => (obj.custom_fields_values || null);
const phonesOf = (c) => { const r = []; (c.custom_fields_values || []).forEach((f) => { if (f.field_code === "PHONE") (f.values || []).forEach((v) => r.push(String(v.value))); }); return r; };
const emailsOf = (c) => { const r = []; (c.custom_fields_values || []).forEach((f) => { if (f.field_code === "EMAIL") (f.values || []).forEach((v) => r.push(String(v.value))); }); return r; };

(async () => {
  log(`Импорт слепка ${SRC} → ${DBPATH}`);

  // справочники
  const pipes = readJson("pipelines.json") || [];
  const insP = db.prepare("INSERT INTO pipelines(id,name,sort,is_main,data) VALUES(?,?,?,?,?)");
  const insS = db.prepare("INSERT INTO statuses(id,pipeline_id,name,sort,color,type) VALUES(?,?,?,?,?,?)");
  db.transaction(() => {
    pipes.forEach((p) => {
      insP.run(p.id, p.name, p.sort || 0, p.is_main ? 1 : 0, JSON.stringify(p));
      ((p._embedded && p._embedded.statuses) || []).forEach((s) => insS.run(s.id, p.id, s.name, s.sort || 0, s.color || "", s.type || 0));
    });
  })();
  log(`Воронки: ${pipes.length}`);

  const users = readJson("users.json") || [];
  const insU = db.prepare("INSERT INTO users(id,name,email,role,grp,is_admin) VALUES(?,?,?,?,?,?)");
  db.transaction(() => users.forEach((u) => insU.run(u.id, u.name, u.email, u.role || "", u.group || "", u.is_admin ? 1 : 0)))();
  log(`Пользователи: ${users.length}`);

  const cf = readJson("custom_fields.json") || {};
  const insCf = db.prepare("INSERT OR IGNORE INTO cf_defs(entity,id,name,type,code,enums,sort) VALUES(?,?,?,?,?,?,?)");
  db.transaction(() => {
    ["leads", "contacts", "companies", "customers"].forEach((ent) => {
      (cf[ent] || []).forEach((f) => insCf.run(ent, f.id, f.name, f.type, f.code || "", JSON.stringify(f.enums || []), f.sort || 0));
    });
  })();
  log("Кастомные поля импортированы");

  // сделки
  const insL = db.prepare(`INSERT OR REPLACE INTO leads(id,name,price,status_id,pipeline_id,responsible_user_id,created_at,updated_at,closed_at,cf,tags,contact_ids) VALUES(@id,@name,@price,@status_id,@pipeline_id,@responsible_user_id,@created_at,@updated_at,@closed_at,@cf,@tags,@contact_ids)`);
  const insLC = db.prepare("INSERT OR IGNORE INTO lead_contacts(lead_id,contact_id) VALUES(?,?)");
  let lbuf = [];
  const flushL = db.transaction((rows) => { rows.forEach((r) => { insL.run(r); (JSON.parse(r.contact_ids) || []).forEach((cid) => insLC.run(r.id, cid)); }); });
  const nL = await streamNd("leads_detail", (l) => {
    const cids = ((l._embedded && l._embedded.contacts) || []).map((c) => c.id);
    lbuf.push({
      id: l.id, name: l.name || "", price: l.price || 0, status_id: l.status_id, pipeline_id: l.pipeline_id,
      responsible_user_id: l.responsible_user_id || 0, created_at: l.created_at || 0, updated_at: l.updated_at || 0,
      closed_at: l.closed_at || 0, cf: JSON.stringify(cfExtract(l)), tags: JSON.stringify(((l._embedded && l._embedded.tags) || []).map((t) => t.name)),
      contact_ids: JSON.stringify(cids)
    });
    if (lbuf.length >= 5000) { flushL(lbuf); lbuf = []; }
  });
  if (lbuf.length) flushL(lbuf);
  log(`Сделки: ${nL}`);

  // контакты
  const insC = db.prepare(`INSERT OR REPLACE INTO contacts(id,name,responsible_user_id,created_at,updated_at,cf,phones,emails) VALUES(@id,@name,@responsible_user_id,@created_at,@updated_at,@cf,@phones,@emails)`);
  let cbuf = [];
  const flushC = db.transaction((rows) => rows.forEach((r) => insC.run(r)));
  const nC = await streamNd("contacts_detail", (c) => {
    cbuf.push({
      id: c.id, name: c.name || "", responsible_user_id: c.responsible_user_id || 0, created_at: c.created_at || 0,
      updated_at: c.updated_at || 0, cf: JSON.stringify(cfExtract(c)), phones: JSON.stringify(phonesOf(c)), emails: JSON.stringify(emailsOf(c))
    });
    if (cbuf.length >= 5000) { flushC(cbuf); cbuf = []; }
  });
  if (cbuf.length) flushC(cbuf);
  log(`Контакты: ${nC}`);

  // компании
  const comp = readJson("companies.json") || [];
  const insCo = db.prepare("INSERT OR REPLACE INTO companies(id,name,created_at,updated_at,cf) VALUES(?,?,?,?,?)");
  db.transaction(() => comp.forEach((c) => insCo.run(c.id, c.name || "", c.created_at || 0, c.updated_at || 0, JSON.stringify(cfExtract(c)))))();
  log(`Компании: ${comp.length}`);

  // задачи (по сделкам — из tasks_by_lead)
  const insT = db.prepare(`INSERT OR REPLACE INTO tasks(id,entity_type,entity_id,text,task_type,complete_till,is_completed,responsible_user_id,result,created_at) VALUES(@id,@entity_type,@entity_id,@text,@task_type,@complete_till,@is_completed,@responsible_user_id,@result,@created_at)`);
  let tbuf = [];
  const flushT = db.transaction((rows) => rows.forEach((r) => insT.run(r)));
  const nT = await streamNd("tasks_by_lead", (t) => {
    tbuf.push({
      id: t.id, entity_type: t.entity_type || "leads", entity_id: t.entity_id || 0, text: t.text || "", task_type: t.task_type_id || t.task_type || 0,
      complete_till: t.complete_till || 0, is_completed: t.is_completed ? 1 : 0, responsible_user_id: t.responsible_user_id || 0,
      result: JSON.stringify(t.result || null), created_at: t.created_at || 0
    });
    if (tbuf.length >= 5000) { flushT(tbuf); tbuf = []; }
  });
  if (tbuf.length) flushT(tbuf);
  log(`Задачи (на сделках): ${nT}`);

  // индексы
  log("Строю индексы…");
  db.exec(`
    CREATE INDEX IF NOT EXISTS ix_leads_ps ON leads(pipeline_id,status_id);
    CREATE INDEX IF NOT EXISTS ix_leads_upd ON leads(updated_at);
    CREATE INDEX IF NOT EXISTS ix_contacts_upd ON contacts(created_at);
    CREATE INDEX IF NOT EXISTS ix_tasks_ent ON tasks(entity_type,entity_id);
    CREATE INDEX IF NOT EXISTS ix_tasks_resp ON tasks(responsible_user_id,is_completed,complete_till);
    CREATE INDEX IF NOT EXISTS ix_lc_contact ON lead_contacts(contact_id);
  `);
  db.exec("ANALYZE");

  const counts = {
    pipelines: db.prepare("SELECT COUNT(*) c FROM pipelines").get().c,
    leads: db.prepare("SELECT COUNT(*) c FROM leads").get().c,
    contacts: db.prepare("SELECT COUNT(*) c FROM contacts").get().c,
    companies: db.prepare("SELECT COUNT(*) c FROM companies").get().c,
    tasks: db.prepare("SELECT COUNT(*) c FROM tasks").get().c,
    users: db.prepare("SELECT COUNT(*) c FROM users").get().c
  };
  db.close();
  log(`ГОТОВО за ${Math.round((Date.now() - t0) / 1000)}s. Записей: ${JSON.stringify(counts)}`);
})().catch((e) => { console.error("ОШИБКА:", e); process.exit(1); });
