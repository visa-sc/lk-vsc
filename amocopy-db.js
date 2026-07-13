/*
 * amocopy-db.js — чтение crm.voyotravel.ru из SQLite (.amocopy-db/crm.db).
 * Монтируется в crm-svc ПЕРЕД файловым amocopy.js — DB-маршруты выигрывают по приоритету
 * (express: первый зарегистрированный обработчик пути побеждает).
 *
 * Отдаёт те же контракты, что файловая версия: /leads, /lead/:id, /contact/:id,
 * /contacts_page, /contacts. Примечания по-прежнему из bucket-файлов слепка (в БД их нет).
 * Данные-справочники (meta/pipelines/users/custom_fields/kanban) остаются на файлах amocopy.js.
 *
 * Env: AMOCOPY_DB=/var/www/voyo/.amocopy-db/crm.db, AMOCOPY_DIR=/var/www/voyo/.amocopy,
 *      SQLITE_MODULE=/var/www/voyo/crm-svc/node_modules/better-sqlite3
 */
const fs = require("fs");
const path = require("path");
const readline = require("readline");
const Database = require(process.env.SQLITE_MODULE || "better-sqlite3");

const DB_PATH = process.env.AMOCOPY_DB || "/var/www/voyo/.amocopy-db/crm.db";
const DATA_DIR = process.env.AMOCOPY_DIR || "/var/www/voyo/.amocopy";
const PAGE_FILE_RE = /^[0-9]{1,12}$/;
const PER_PAGE = 50;

let db = null, BUCKETS = 500;
function open() {
  if (db) return db;
  db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
  db.pragma("query_only = true");
  try { BUCKETS = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "meta.json"), "utf8")).buckets || 500; } catch (_) {}
  return db;
}

// примечания из bucket-файлов слепка (в БД не грузили)
function notesFromBucket(dir, id, cb) {
  const b = Math.abs(Number(id)) % BUCKETS;
  const p = path.join(DATA_DIR, dir, `${b}.ndjson`);
  if (!fs.existsSync(p)) return cb([]);
  const out = [], needle = `"eid":${id}`;
  const rl = readline.createInterface({ input: fs.createReadStream(p, "utf8"), crlfDelay: Infinity });
  rl.on("line", (l) => { if (l.indexOf(needle) < 0) return; try { const o = JSON.parse(l); if (o.eid === id) out.push(o); } catch (_) {} });
  rl.on("close", () => cb(out));
  rl.on("error", () => cb([]));
}

const J = (s, d) => { try { return JSON.parse(s); } catch (_) { return d; } };

module.exports = function mountDbRoutes(app, guard, api) {
  let D;
  try { D = open(); } catch (e) { console.error("amocopy-db: БД недоступна, работаю на файлах:", e.message); return false; }

  const qLeadsPage = D.prepare("SELECT id,name,price,responsible_user_id,created_at,updated_at,tags FROM leads WHERE pipeline_id=? AND status_id=? ORDER BY updated_at DESC LIMIT ? OFFSET ?");
  const qLead = D.prepare("SELECT * FROM leads WHERE id=?");
  const qLeadTasks = D.prepare("SELECT * FROM tasks WHERE entity_type='leads' AND entity_id=? ORDER BY complete_till DESC");
  const qContact = D.prepare("SELECT * FROM contacts WHERE id=?");
  const qContactLeads = D.prepare("SELECT l.id,l.name,l.price,l.pipeline_id,l.status_id FROM lead_contacts lc JOIN leads l ON l.id=lc.lead_id WHERE lc.contact_id=? LIMIT 200");
  const qContactsPage = D.prepare("SELECT id,name,phones,emails,created_at FROM contacts ORDER BY created_at DESC LIMIT ? OFFSET ?");
  const uName = {}; D.prepare("SELECT id,name FROM users").all().forEach((u) => { uName[u.id] = u.name; });

  // счётчики канбана из БД (живые — отражают созданные/перемещённые сделки)
  const qKanban = D.prepare("SELECT pipeline_id, status_id, COUNT(*) c, COALESCE(SUM(price),0) s FROM leads GROUP BY pipeline_id, status_id");
  app.get(`${api}/kanban`, guard, (req, res) => {
    const kb = {};
    for (const r of qKanban.all()) {
      (kb[r.pipeline_id] = kb[r.pipeline_id] || {})[r.status_id] = { count: r.c, sum: r.s };
    }
    res.json({ kanban: kb, pages: {} });
  });

  // раздел «Задачи»: открытые задачи с именем сделки, фильтр по ответственному
  const qTasksAll = D.prepare(`SELECT t.id,t.text,t.complete_till,t.responsible_user_id,t.entity_type,t.entity_id, l.name lead_name
    FROM tasks t LEFT JOIN leads l ON l.id=t.entity_id AND t.entity_type='leads'
    WHERE t.is_completed=0 ORDER BY t.complete_till ASC LIMIT 500`);
  const qTasksBy = D.prepare(`SELECT t.id,t.text,t.complete_till,t.responsible_user_id,t.entity_type,t.entity_id, l.name lead_name
    FROM tasks t LEFT JOIN leads l ON l.id=t.entity_id AND t.entity_type='leads'
    WHERE t.is_completed=0 AND t.responsible_user_id=? ORDER BY t.complete_till ASC LIMIT 500`);
  app.get(`${api}/tasks_list`, guard, (req, res) => {
    const resp = parseInt(req.query.responsible, 10) || 0;
    const rows = resp ? qTasksBy.all(resp) : qTasksAll.all();
    res.json(rows.map((t) => ({
      id: t.id, text: t.text, till: t.complete_till, resp: uName[t.responsible_user_id] || "",
      resp_id: t.responsible_user_id, entity_type: t.entity_type, entity_id: t.entity_id, lead_name: t.lead_name || ""
    })));
  });

  // KPI рабочего стола из БД (живые)
  app.get(`${api}/dashboard`, guard, (req, res) => {
    const now = Math.floor(Date.now() / 1000);
    const dayStart = now - (now % 86400);
    const byPipe = {};
    for (const r of qKanban.all()) { byPipe[r.pipeline_id] = (byPipe[r.pipeline_id] || 0) + r.c; }
    const openTasks = D.prepare("SELECT COUNT(*) c FROM tasks WHERE is_completed=0").get().c;
    const overdue = D.prepare("SELECT COUNT(*) c FROM tasks WHERE is_completed=0 AND complete_till<? AND complete_till>0").get(now).c;
    const newLeadsToday = D.prepare("SELECT COUNT(*) c FROM leads WHERE created_at>=?").get(dayStart).c;
    const byManager = D.prepare(`SELECT responsible_user_id r, COUNT(*) c FROM leads GROUP BY responsible_user_id ORDER BY c DESC LIMIT 12`).all()
      .map((x) => ({ name: uName[x.r] || "—", count: x.c }));
    res.json({ byPipe, openTasks, overdue, newLeadsToday, byManager });
  });

  // список сделок этапа (как файловый, но из БД)
  app.get(`${api}/leads`, guard, (req, res) => {
    const pid = String(req.query.pipeline || ""), sid = String(req.query.status || ""), page = String(req.query.page || "1");
    if (!PAGE_FILE_RE.test(pid) || !PAGE_FILE_RE.test(sid) || !PAGE_FILE_RE.test(page)) return res.status(400).json({ success: false });
    const rows = qLeadsPage.all(+pid, +sid, PER_PAGE, (+page - 1) * PER_PAGE);
    res.json(rows.map((l) => ({
      id: l.id, name: l.name, price: l.price, resp: uName[l.responsible_user_id] || "",
      created: l.created_at, updated: l.updated_at, tags: J(l.tags, [])
    })));
  });

  // компании: список + карточка
  const qCompaniesPage = D.prepare("SELECT id,name,created_at,updated_at FROM companies ORDER BY updated_at DESC LIMIT ? OFFSET ?");
  const qCompaniesCount = D.prepare("SELECT COUNT(*) c FROM companies");
  const qCompany = D.prepare("SELECT * FROM companies WHERE id=?");
  app.get(`${api}/companies_page`, guard, (req, res) => {
    const page = String(req.query.page || "1");
    if (!PAGE_FILE_RE.test(page)) return res.status(400).json({ success: false });
    const rows = qCompaniesPage.all(50, (+page - 1) * 50);
    res.json({ total: qCompaniesCount.get().c, items: rows.map((c) => ({ id: c.id, name: c.name, created: c.created_at })) });
  });
  app.get(`${api}/company/:id`, guard, (req, res) => {
    const id = parseInt(req.params.id, 10);
    const c = qCompany.get(id);
    if (!c) return res.status(404).json({ success: false });
    // сделки/контакты компании — через lead_contacts не связаны; берём по company cf нет. Отдаём поля.
    res.json({ success: true, company: { id: c.id, name: c.name, created_at: c.created_at, updated_at: c.updated_at, custom_fields_values: J(c.cf, null) } });
  });

  // поиск по сделкам (название/id) — из шапки
  const qLeadsSearch = D.prepare("SELECT id,name,price,status_id,pipeline_id,responsible_user_id FROM leads WHERE name LIKE ? ORDER BY updated_at DESC LIMIT 50");
  app.get(`${api}/leads_search`, guard, (req, res) => {
    const q = String(req.query.q || "").trim();
    if (q.length < 2) return res.json({ success: true, items: [] });
    let items = [];
    if (/^\d+$/.test(q)) { const l = qLead.get(+q); if (l) items.push(l); }
    for (const l of qLeadsSearch.all("%" + q + "%")) { if (!items.find((x) => x.id === l.id)) items.push(l); }
    res.json({ success: true, items: items.slice(0, 50).map((l) => ({ id: l.id, name: l.name, price: l.price, pid: l.pipeline_id, sid: l.status_id, resp: uName[l.responsible_user_id] || "" })) });
  });

  // карточка сделки (поля/задачи из БД, примечания из bucket)
  app.get(`${api}/lead/:id`, guard, (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ success: false });
    const l = qLead.get(id);
    if (!l) return res.status(404).json({ success: false, message: "Сделка не найдена" });
    const tasks = qLeadTasks.all(id).map((t) => ({
      id: t.id, text: t.text, complete_till: t.complete_till, is_completed: !!t.is_completed,
      responsible_user_id: t.responsible_user_id, result: J(t.result, null)
    }));
    const lead = {
      id: l.id, name: l.name, price: l.price, status_id: l.status_id, pipeline_id: l.pipeline_id,
      responsible_user_id: l.responsible_user_id, created_at: l.created_at, updated_at: l.updated_at, closed_at: l.closed_at || null,
      custom_fields_values: J(l.cf, null),
      _embedded: { tags: J(l.tags, []).map((n) => ({ name: n })), contacts: J(l.contact_ids, []).map((cid, i) => ({ id: cid, is_main: i === 0 })) }
    };
    notesFromBucket("notes_leads", id, (notes) => res.json({ success: true, lead, notes, tasks }));
  });

  // карточка контакта (поля из БД, сделки из lead_contacts, примечания из bucket)
  app.get(`${api}/contact/:id`, guard, (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ success: false });
    const c = qContact.get(id);
    if (!c) return res.status(404).json({ success: false, message: "Контакт не найден" });
    const leads = qContactLeads.all(id).map((l) => ({ id: l.id, name: l.name, price: l.price, pid: l.pipeline_id, sid: l.status_id }));
    const contact = {
      id: c.id, name: c.name, responsible_user_id: c.responsible_user_id, created_at: c.created_at, updated_at: c.updated_at,
      custom_fields_values: J(c.cf, null)
    };
    notesFromBucket("notes_contacts", id, (notes) => res.json({ success: true, contact, notes, leads }));
  });

  // постраничный список контактов (новые сверху)
  app.get(`${api}/contacts_page`, guard, (req, res) => {
    const page = String(req.query.page || "1");
    if (!PAGE_FILE_RE.test(page)) return res.status(400).json({ success: false });
    const rows = qContactsPage.all(PER_PAGE, (+page - 1) * PER_PAGE);
    res.json(rows.map((c) => ({ id: c.id, n: c.name, p: J(c.phones, []), e: J(c.emails, []), created: c.created_at })));
  });

  // поиск контактов (имя LIKE, или телефон/email по цифрам/подстроке) — топ-50
  const qSearchName = D.prepare("SELECT id,name,phones,emails,created_at FROM contacts WHERE name LIKE ? ORDER BY created_at DESC LIMIT 50");
  app.get(`${api}/contacts`, guard, (req, res) => {
    const q = String(req.query.q || "").trim();
    if (q.length < 3) return res.json({ success: true, items: [], note: "Минимум 3 символа" });
    const qDigits = q.replace(/\D/g, "");
    const seen = new Set(), items = [];
    // 1) по имени (индексируемо через LIKE 'q%' было бы быстрее, но нужно и вхождение — LIKE '%q%')
    for (const c of qSearchName.all("%" + q + "%")) { if (!seen.has(c.id)) { seen.add(c.id); items.push({ id: c.id, n: c.name, p: J(c.phones, []), e: J(c.emails, []) }); } }
    // 2) по телефону/email — скан только если имени мало и есть цифры/@; ограничиваем работу
    if (items.length < 50 && (qDigits.length >= 5 || q.indexOf("@") >= 0)) {
      const like = qDigits.length >= 5 ? "%" + qDigits + "%" : "%" + q + "%";
      const col = qDigits.length >= 5 ? "phones" : "emails";
      const extra = D.prepare(`SELECT id,name,phones,emails FROM contacts WHERE replace(replace(replace(replace(${col},'+',''),'-',''),' ',''),'(','') LIKE ? LIMIT 50`).all(like);
      for (const c of extra) { if (items.length >= 50) break; if (!seen.has(c.id)) { seen.add(c.id); items.push({ id: c.id, n: c.name, p: J(c.phones, []), e: J(c.emails, []) }); } }
    }
    res.json({ success: true, items: items.slice(0, 50) });
  });

  console.log("amocopy-db: чтение из SQLite активно (", DB_PATH, ")");
  return true;
};
