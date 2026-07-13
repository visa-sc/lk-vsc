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
  const qContactsPage = D.prepare("SELECT id,name,phones,emails,created_at,updated_at,responsible_user_id FROM contacts ORDER BY created_at DESC LIMIT ? OFFSET ?");
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
  // предстоящие+сегодня (возр.) и недавняя просрочка (убыв.) — с опц. фильтром по ответственному.
  // resp приводим к целому и подставляем как литерал (не через плейсхолдер), поэтому инъекция исключена.
  const prep = (base, resp) => D.prepare(base.replace("{RESP}", resp ? "AND t.responsible_user_id=" + (parseInt(resp, 10) || 0) : ""));
  const qTasksUpSrc = `SELECT t.id,t.text,t.complete_till,t.responsible_user_id,t.entity_type,t.entity_id, l.name lead_name
    FROM tasks t LEFT JOIN leads l ON l.id=t.entity_id AND t.entity_type='leads'
    WHERE t.is_completed=0 AND t.complete_till>=? {RESP} ORDER BY t.complete_till ASC LIMIT 300`;
  const qTasksOvSrc = `SELECT t.id,t.text,t.complete_till,t.responsible_user_id,t.entity_type,t.entity_id, l.name lead_name
    FROM tasks t LEFT JOIN leads l ON l.id=t.entity_id AND t.entity_type='leads'
    WHERE t.is_completed=0 AND t.complete_till<? AND t.complete_till>0 {RESP} ORDER BY t.complete_till DESC LIMIT 200`;
  app.get(`${api}/tasks_list`, guard, (req, res) => {
    const resp = parseInt(req.query.responsible, 10) || 0;
    const now = Math.floor(Date.now() / 1000);
    const dayStart = now - (now % 86400);
    const upcoming = prep(qTasksUpSrc, resp).all(dayStart);
    const overdue = prep(qTasksOvSrc, resp).all(dayStart);
    const rows = overdue.concat(upcoming); // просрочка (свежая сверху) + предстоящие
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

  // аналитика: воронки по этапам (кол-во+сумма) + по ответственным
  app.get(`${api}/analytics`, guard, (req, res) => {
    const statuses = D.prepare("SELECT pipeline_id,id,name,sort,color,type FROM statuses").all();
    const pipes = D.prepare("SELECT id,name,is_main,sort FROM pipelines ORDER BY sort").all();
    const kmap = {};
    for (const r of qKanban.all()) { (kmap[r.pipeline_id] = kmap[r.pipeline_id] || {})[r.status_id] = { c: r.c, s: r.s }; }
    const funnels = pipes.map((p) => {
      const sts = statuses.filter((s) => s.pipeline_id === p.id).sort((a, b) => (a.sort || 0) - (b.sort || 0));
      const stages = sts.map((s) => { const d = (kmap[p.id] || {})[s.id] || { c: 0, s: 0 }; return { name: s.name, color: s.color, count: d.c, sum: d.s }; });
      const total = stages.reduce((a, b) => a + b.count, 0);
      return { name: p.name, is_main: p.is_main, total, stages };
    }).filter((f) => f.total > 0);
    const byUser = D.prepare("SELECT responsible_user_id r, COUNT(*) c, COALESCE(SUM(price),0) s FROM leads GROUP BY responsible_user_id ORDER BY c DESC LIMIT 15").all()
      .map((x) => ({ name: uName[x.r] || ("ID " + x.r), count: x.c, sum: x.s }));
    res.json({ success: true, funnels, byUser });
  });

  // кастомные поля из cf_defs (единый источник правды — актуализируется amoCopySyncFields.js)
  app.get(`${api}/custom_fields`, guard, (req, res) => {
    const rows = D.prepare("SELECT entity,id,name,type,code,enums,sort FROM cf_defs WHERE entity IN ('leads','contacts','companies') ORDER BY entity, sort").all();
    const out = { leads: [], contacts: [], companies: [] };
    for (const r of rows) {
      if (!out[r.entity]) continue;
      out[r.entity].push({ id: r.id, name: r.name, type: r.type, code: r.code || null, enums: J(r.enums, []) });
    }
    res.json(out);
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

  // режим списка: все сделки воронки постранично (для табличного вида)
  const qLeadsAll = D.prepare("SELECT id,name,price,status_id,responsible_user_id,created_at,updated_at FROM leads WHERE pipeline_id=? ORDER BY updated_at DESC LIMIT 50 OFFSET ?");
  app.get(`${api}/leads_all`, guard, (req, res) => {
    const pid = String(req.query.pipeline || ""), page = String(req.query.page || "1");
    if (!PAGE_FILE_RE.test(pid) || !PAGE_FILE_RE.test(page)) return res.status(400).json({ success: false });
    const rows = qLeadsAll.all(+pid, (+page - 1) * 50);
    res.json(rows.map((l) => ({ id: l.id, name: l.name, price: l.price, sid: l.status_id, resp: uName[l.responsible_user_id] || "", created: l.created_at, updated: l.updated_at })));
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

  // Покупатели (модуль customers) — постранично
  let hasCustomers = false;
  try { hasCustomers = !!D.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='customers'").get(); } catch (_) {}
  if (hasCustomers) {
    const qCustPage = D.prepare("SELECT id,name,status_id,responsible_user_id,ltv,purchases_count,average_check,next_price,next_date,created_at FROM customers ORDER BY (ltv>0) DESC, created_at DESC LIMIT 50 OFFSET ?");
    const qCustCount = D.prepare("SELECT COUNT(*) c FROM customers");
    const qCustSearch = D.prepare("SELECT id,name,status_id,responsible_user_id,ltv,purchases_count,average_check,next_price,next_date,created_at FROM customers WHERE name LIKE ? ORDER BY created_at DESC LIMIT 50");
    app.get(`${api}/customers_page`, guard, (req, res) => {
      const page = Math.max(1, parseInt(req.query.page, 10) || 1);
      const q = String(req.query.q || "").trim();
      const rows = q ? qCustSearch.all("%" + q + "%") : qCustPage.all((page - 1) * 50);
      res.json({ success: true, total: page === 1 && !q ? qCustCount.get().c : null, items: rows.map((c) => ({
        id: c.id, name: c.name, resp: uName[c.responsible_user_id] || "", ltv: c.ltv, purchases: c.purchases_count,
        avg: c.average_check, next_price: c.next_price, next_date: c.next_date, created: c.created_at })) });
    });
    const qCust = D.prepare("SELECT * FROM customers WHERE id=?");
    app.get(`${api}/customer/:id`, guard, (req, res) => {
      const c = qCust.get(parseInt(req.params.id, 10));
      if (!c) return res.status(404).json({ success: false });
      res.json({ success: true, customer: { id: c.id, name: c.name, responsible_user_id: c.responsible_user_id,
        ltv: c.ltv, purchases_count: c.purchases_count, average_check: c.average_check, next_price: c.next_price,
        next_date: c.next_date, created_at: c.created_at, updated_at: c.updated_at, custom_fields_values: J(c.cf, null) } });
    });
  }

  // ФИЛЬТР сделок (как в amoCRM: клик по поиску → фильтр). Только по локальной БД копии.
  app.get(`${api}/leads_filter`, guard, (req, res) => {
    const q = req.query || {};
    const where = [], args = [];
    const intq = (v) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : null; };
    let v;
    if ((v = intq(q.pipeline)) !== null) { where.push("pipeline_id=?"); args.push(v); }
    if ((v = intq(q.status)) !== null) { where.push("status_id=?"); args.push(v); }
    if ((v = intq(q.responsible)) !== null) { where.push("responsible_user_id=?"); args.push(v); }
    if ((v = intq(q.price_min)) !== null) { where.push("price>=?"); args.push(v); }
    if ((v = intq(q.price_max)) !== null) { where.push("price<=?"); args.push(v); }
    if ((v = intq(q.date_from)) !== null) { where.push("created_at>=?"); args.push(v); }
    if ((v = intq(q.date_to)) !== null) { where.push("created_at<=?"); args.push(v); }
    if (q.tag && String(q.tag).trim()) { where.push("tags LIKE ?"); args.push("%" + String(q.tag).trim() + "%"); }
    if (q.q && String(q.q).trim()) { where.push("name LIKE ?"); args.push("%" + String(q.q).trim() + "%"); }
    const page = Math.max(1, intq(q.page) || 1);
    const sql = "SELECT id,name,price,pipeline_id,status_id,responsible_user_id,created_at,updated_at FROM leads" +
      (where.length ? " WHERE " + where.join(" AND ") : "") + " ORDER BY updated_at DESC LIMIT 50 OFFSET ?";
    try {
      const rows = D.prepare(sql).all(...args, (page - 1) * 50);
      let total = null;
      if (page === 1) { total = D.prepare("SELECT COUNT(*) c FROM leads" + (where.length ? " WHERE " + where.join(" AND ") : "")).get(...args).c; }
      res.json({ success: true, total, items: rows.map((l) => ({ id: l.id, name: l.name, price: l.price, pid: l.pipeline_id, sid: l.status_id, resp: uName[l.responsible_user_id] || "", created: l.created_at, updated: l.updated_at })) });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
  });

  // ФИЛЬТР контактов (клик по поиску → фильтр). Только по локальной БД копии.
  app.get(`${api}/contacts_filter`, guard, (req, res) => {
    const q = req.query || {};
    const where = [], args = [];
    const intq = (v) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : null; };
    let v;
    if ((v = intq(q.responsible)) !== null) { where.push("responsible_user_id=?"); args.push(v); }
    if ((v = intq(q.date_from)) !== null) { where.push("created_at>=?"); args.push(v); }
    if ((v = intq(q.date_to)) !== null) { where.push("created_at<=?"); args.push(v); }
    if (q.q && String(q.q).trim()) { where.push("(name LIKE ? OR phones LIKE ? OR emails LIKE ?)"); const s = "%" + String(q.q).trim() + "%"; args.push(s, s, s); }
    const page = Math.max(1, intq(q.page) || 1);
    const sql = "SELECT id,name,phones,emails,created_at,updated_at,responsible_user_id FROM contacts" +
      (where.length ? " WHERE " + where.join(" AND ") : "") + " ORDER BY created_at DESC LIMIT 50 OFFSET ?";
    try {
      const rows = D.prepare(sql).all(...args, (page - 1) * 50);
      let total = null;
      if (page === 1) { total = D.prepare("SELECT COUNT(*) c FROM contacts" + (where.length ? " WHERE " + where.join(" AND ") : "")).get(...args).c; }
      res.json({ success: true, total, items: rows.map((c) => ({ id: c.id, n: c.name, p: J(c.phones, []), e: J(c.emails, []), created: c.created_at, updated: c.updated_at, resp: uName[c.responsible_user_id] || "" })) });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
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
    res.json(rows.map((c) => ({ id: c.id, n: c.name, p: J(c.phones, []), e: J(c.emails, []), created: c.created_at, updated: c.updated_at, resp: uName[c.responsible_user_id] || "" })));
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
