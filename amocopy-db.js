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
  db.pragma("busy_timeout = 8000"); // ждать снятия блокировки при параллельной записи, а не падать SQLITE_BUSY
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

  // кириллица в LIKE: SQLite lower() понижает только ASCII — «Иванова» не находил «ИВАНОВА».
  // Регистрируем JS-функцию lc() (toLowerCase знает кириллицу) для всех поисков по имени.
  try { D.function("lc", { deterministic: true }, (s) => (s == null ? null : String(s).toLowerCase())); } catch (_) {}
  const qLeadsPage = D.prepare("SELECT id,name,price,responsible_user_id,created_at,updated_at,tags FROM leads WHERE pipeline_id=? AND status_id=? ORDER BY updated_at DESC LIMIT ? OFFSET ?");
  // мин. срок ОТКРЫТОЙ задачи сделки — для индикатора «Нет задач/Просрочено/Сегодня» на карточке канбана (как в amo)
  const qLeadTaskMin = D.prepare("SELECT MIN(complete_till) m FROM tasks WHERE entity_type='leads' AND entity_id=? AND is_completed=0");
  // имя первого контакта — первой строкой канбан-карточки (как в amo; ix_lc_lead)
  const qLeadContactName = D.prepare("SELECT c.name FROM lead_contacts lc JOIN contacts c ON c.id=lc.contact_id WHERE lc.lead_id=? LIMIT 1");
  const qLead = D.prepare("SELECT * FROM leads WHERE id=?");
  const qLeadTasks = D.prepare("SELECT * FROM tasks WHERE entity_type='leads' AND entity_id=? ORDER BY complete_till DESC");
  // задачи любой сущности (для карточек контакта/компании) — как в amo
  const qTasksByEnt = D.prepare("SELECT * FROM tasks WHERE entity_type=? AND entity_id=? ORDER BY complete_till DESC");
  const tasksOut = (et, id) => { try { return qTasksByEnt.all(et, id).map((t) => ({ id: t.id, text: t.text, task_type: t.task_type, complete_till: t.complete_till, is_completed: t.is_completed, responsible_user_id: t.responsible_user_id, result: J(t.result, null), created_at: t.created_at })); } catch (_) { return []; } };
  const qContact = D.prepare("SELECT * FROM contacts WHERE id=?");
  const qContactLeads = D.prepare("SELECT l.id,l.name,l.price,l.pipeline_id,l.status_id FROM lead_contacts lc JOIN leads l ON l.id=lc.lead_id WHERE lc.contact_id=? LIMIT 200");
  const qContactsPage = D.prepare("SELECT id,name,phones,emails,created_at,updated_at,responsible_user_id,cf,tags FROM contacts ORDER BY created_at DESC LIMIT ? OFFSET ?");
  // единый вид контакта для таблицы: базовые поля + все кастомные (cf) + связанные сделки с цветами
  function contactOut(rows, withDeals) {
    const ids = rows.map((c) => c.id);
    const dmap = withDeals ? dealsByContact(ids) : {};
    return rows.map((c) => ({
      id: c.id, n: c.name, p: J(c.phones, []), e: J(c.emails, []), created: c.created_at, updated: c.updated_at,
      resp: uName[c.responsible_user_id] || "", cf: J(c.cf, []) || [], deals: dmap[c.id] || [],
      tags: J(c.tags, [])
    }));
  }
  const uName = {}; D.prepare("SELECT id,name FROM users").all().forEach((u) => { uName[u.id] = u.name; });
  // карта этапов: status_id -> {name,color,pipeline_id} (для цветных чипов сделок в таблицах)
  const stMap = {};
  try { for (const s of D.prepare("SELECT pipeline_id,id,name,color FROM statuses").all()) stMap[s.id] = { name: s.name, color: s.color || "#c1d5e0", pid: s.pipeline_id }; } catch (_) {}
  // сделки контакта (id, имя, статус, цвет) — для колонки «Сделки» в контактах
  const qDealsForContacts = D.prepare(`SELECT lc.contact_id cid, l.id, l.name, l.price, l.status_id, l.pipeline_id
    FROM lead_contacts lc JOIN leads l ON l.id=lc.lead_id WHERE lc.contact_id IN (SELECT value FROM json_each(?)) ORDER BY l.updated_at DESC`);
  // фильтр по кастомным полям (cf хранится JSON-текстом). Формат параметра: "<fieldId>:<значение>".
  // Требуем в одной записи и присутствие поля, и присутствие значения — практичный матч без парсинга JSON в SQL.
  function addCfFilters(cfParam, where, args) {
    if (!cfParam) return;
    const list = Array.isArray(cfParam) ? cfParam : [cfParam];
    for (const raw of list) {
      const s = String(raw || "");
      const i = s.indexOf(":");
      if (i < 0) continue;
      const fid = parseInt(s.slice(0, i), 10);
      const val = s.slice(i + 1).trim();
      if (!Number.isFinite(fid)) continue;
      where.push("cf LIKE ?"); args.push('%"field_id":' + fid + '%');
      if (val) { where.push("cf LIKE ?"); args.push('%"value":"%' + val + '%'); }
    }
  }
  function dealsByContact(ids) {
    const map = {};
    if (!ids.length) return map;
    try {
      for (const r of qDealsForContacts.all(JSON.stringify(ids))) {
        (map[r.cid] = map[r.cid] || []).push({ id: r.id, name: r.name, price: r.price, sid: r.status_id, pid: r.pipeline_id,
          st: (stMap[r.status_id] || {}).name || "", color: (stMap[r.status_id] || {}).color || "#c1d5e0" });
      }
    } catch (_) {}
    return map;
  }
  // ── связи (deal↔contact↔company). Функции устойчивы к отсутствию таблиц связей. ──
  const has = (t) => { try { return !!D.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t); } catch (_) { return false; } };
  const HAS_CC = has("contact_companies"), HAS_LC = has("lead_companies");
  const qNamesByIds = (ids) => { try { return D.prepare("SELECT id,name FROM contacts WHERE id IN (SELECT value FROM json_each(?))").all(JSON.stringify(ids)); } catch (_) { return []; } };
  const qCoName = D.prepare("SELECT id,name FROM companies WHERE id=?");
  function companyName(id) { const c = qCoName.get(id); return c ? c.name : ("Компания #" + id); }
  const qCompaniesForLead = HAS_LC ? D.prepare("SELECT company_id FROM lead_companies WHERE lead_id=?") : null;
  const qCompaniesForContact = HAS_CC ? D.prepare("SELECT company_id FROM contact_companies WHERE contact_id=?") : null;
  const qContactsForCompany = HAS_CC ? D.prepare("SELECT c.id,c.name FROM contact_companies cc JOIN contacts c ON c.id=cc.contact_id WHERE cc.company_id=? LIMIT 300") : null;
  const qLeadsForCompany = HAS_LC ? D.prepare("SELECT l.id,l.name,l.price,l.status_id FROM lead_companies lc JOIN leads l ON l.id=lc.lead_id WHERE lc.company_id=? ORDER BY l.updated_at DESC LIMIT 300") : null;
  function companiesForLead(id) { return qCompaniesForLead ? qCompaniesForLead.all(id).map((r) => ({ id: r.company_id, name: companyName(r.company_id) })) : []; }
  function companiesForContact(id) { return qCompaniesForContact ? qCompaniesForContact.all(id).map((r) => ({ id: r.company_id, name: companyName(r.company_id) })) : []; }
  function dealChip(sid) { return { st: (stMap[sid] || {}).name || "", color: (stMap[sid] || {}).color || "#c1d5e0" }; }

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
  const qTasksUpSrc = `SELECT t.id,t.text,t.complete_till,t.responsible_user_id,t.entity_type,t.entity_id,t.task_type, l.name lead_name
    FROM tasks t LEFT JOIN leads l ON l.id=t.entity_id AND t.entity_type='leads'
    WHERE t.is_completed=0 AND t.complete_till>=? {RESP} ORDER BY t.complete_till ASC LIMIT 300`;
  const qTasksOvSrc = `SELECT t.id,t.text,t.complete_till,t.responsible_user_id,t.entity_type,t.entity_id,t.task_type, l.name lead_name
    FROM tasks t LEFT JOIN leads l ON l.id=t.entity_id AND t.entity_type='leads'
    WHERE t.is_completed=0 AND t.complete_till<? AND t.complete_till>0 {RESP} ORDER BY t.complete_till DESC LIMIT 200`;
  // выполненные за 30 дней — для флага «показывать выполненные» (колонка Результат, как в amo)
  const qTasksDoneSrc = `SELECT t.id,t.text,t.complete_till,t.responsible_user_id,t.entity_type,t.entity_id,t.task_type,t.is_completed,t.result, l.name lead_name
    FROM tasks t LEFT JOIN leads l ON l.id=t.entity_id AND t.entity_type='leads'
    WHERE t.is_completed=1 AND t.complete_till>=? {RESP} ORDER BY t.complete_till DESC LIMIT 300`;
  app.get(`${api}/tasks_list`, guard, (req, res) => {
    const resp = parseInt(req.query.responsible, 10) || 0;
    const now = Math.floor(Date.now() / 1000);
    const dayStart = now - (now % 86400);
    if (String(req.query.done) === "1") {
      const rows = prep(qTasksDoneSrc, resp).all(dayStart - 30 * 86400);
      return res.json(rows.map((t) => ({
        id: t.id, text: t.text, till: t.complete_till, resp: uName[t.responsible_user_id] || "",
        resp_id: t.responsible_user_id, entity_type: t.entity_type, entity_id: t.entity_id, lead_name: t.lead_name || "",
        task_type: t.task_type, done: 1, result: (J(t.result, {}) || {}).text || ""
      })));
    }
    const upcoming = prep(qTasksUpSrc, resp).all(dayStart);
    const overdue = prep(qTasksOvSrc, resp).all(dayStart);
    const rows = overdue.concat(upcoming); // просрочка (свежая сверху) + предстоящие
    res.json(rows.map((t) => ({
      id: t.id, text: t.text, till: t.complete_till, resp: uName[t.responsible_user_id] || "",
      resp_id: t.responsible_user_id, entity_type: t.entity_type, entity_id: t.entity_id, lead_name: t.lead_name || "",
      task_type: t.task_type
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

  // живые счётчики сущностей (в UI вместо статичных из слепка)
  app.get(`${api}/counts`, guard, (req, res) => {
    const one = (sql, ...a) => { try { return D.prepare(sql).get(...a).c; } catch (_) { return null; } };
    const now = Math.floor(Date.now() / 1000);
    const dayEnd = now - (now % 86400) + 86400;
    // бейдж «Задачи» как в amo = просроченные + на сегодня (незавершённые)
    const tasksDue = one("SELECT COUNT(*) c FROM tasks WHERE is_completed=0 AND complete_till>0 AND complete_till<?", dayEnd);
    const tasksOpen = one("SELECT COUNT(*) c FROM tasks WHERE is_completed=0");
    const out = { success: true,
      leads: one("SELECT COUNT(*) c FROM leads"),
      contacts: one("SELECT COUNT(*) c FROM contacts"),
      companies: one("SELECT COUNT(*) c FROM companies"),
      customers: one("SELECT COUNT(*) c FROM customers"),
      tasksDue: tasksDue, tasksOpen: tasksOpen };
    // Бейджи отражают ТОЛЬКО реальную ситуацию в копии (требование Андрея 15.07).
    // Внешние разделы (imbox/mail/wazzup/market) не подключены → бейджей нет.
    // badges.json остаётся опциональным механизмом для БУДУЩИХ живых интеграций
    // (реальные счётчики непрочитанного будут писаться туда самими интеграциями).
    try {
      const b = JSON.parse(fs.readFileSync(path.join(path.dirname(process.env.AMOCOPY_DB || "/var/www/voyo/.amocopy-db/crm.db"), "badges.json"), "utf8"));
      if (b && b.live === true) for (const k of ["imbox", "mail", "wazzup", "market"]) if (b[k] != null) out[k] = b[k];
    } catch (_) {}
    // колокольчик = реальные уведомления копии (задачи, требующие внимания)
    out.notifications = tasksDue || 0;
    res.json(out);
  });

  // типы задач (для селектора при постановке задачи) — если таблица есть
  app.get(`${api}/task_types`, guard, (req, res) => {
    try { res.json({ success: true, types: D.prepare("SELECT id,name,icon_id FROM task_types ORDER BY name").all() }); }
    catch (_) { res.json({ success: true, types: [{ id: 1, name: "Связаться" }, { id: 2, name: "Встреча" }] }); }
  });

  // аналитика: воронки по этапам (кол-во+сумма) + по ответственным
  // теги сделок со счётчиками (правая колонка панели фильтра amo) — из tags_agg.json (пересчёт cron-скриптом)
  app.get(`${api}/tags_report`, guard, (req, res) => {
    try { res.json({ success: true, tags: JSON.parse(fs.readFileSync(path.join(path.dirname(DB_PATH), "tags_agg.json"), "utf8")) }); }
    catch (e) { res.json({ success: false, tags: [] }); }
  });

  // «Список событий» (как в amo Аналитика→Список событий): журнал changelog КОПИИ (события amo в слепок не выгружались)
  app.get(`${api}/events_list`, guard, (req, res) => {
    try {
      const rows = D.prepare("SELECT ts, actor, entity_type, entity_id, action, detail FROM changelog ORDER BY ts DESC, id DESC LIMIT 300").all();
      const nameOf = (et, id) => {
        try {
          if (et === "leads") { const r = D.prepare("SELECT name FROM leads WHERE id=?").get(id); return r && r.name; }
          if (et === "contacts") { const r = D.prepare("SELECT name FROM contacts WHERE id=?").get(id); return r && r.name; }
          if (et === "companies") { const r = D.prepare("SELECT name FROM companies WHERE id=?").get(id); return r && r.name; }
          if (et === "customers") { const r = D.prepare("SELECT name FROM customers WHERE id=?").get(id); return r && r.name; }
        } catch (_) {}
        return null;
      };
      res.json({ success: true, items: rows.map((r) => ({ ts: r.ts, actor: r.actor, et: r.entity_type, eid: r.entity_id, action: r.action, detail: J(r.detail, {}), name: nameOf(r.entity_type, r.entity_id) })) });
    } catch (e) { res.json({ success: false, message: e.message }); }
  });

  // «Отчёт по сотрудникам» (как в amo): за период — создано сделок (N+₽), успешные (N+₽), задач в работе, примечаний в копии
  app.get(`${api}/staff_report`, guard, (req, res) => {
    try {
      const now = Math.floor(Date.now() / 1000), day = now - (now % 86400);
      const from = ({ today: day, week: day - 6 * 86400, month: day - 29 * 86400 })[req.query.period] || (day - 6 * 86400);
      const rows = {};
      const row = (u) => rows[u] || (rows[u] = { name: uName[u] || ("id " + u), created: 0, createdSum: 0, won: 0, wonSum: 0, openTasks: 0, notes: 0 });
      D.prepare("SELECT responsible_user_id u, COUNT(*) c, COALESCE(SUM(price),0) s FROM leads WHERE created_at>=? GROUP BY u").all(from).forEach((r) => { const x = row(r.u); x.created = r.c; x.createdSum = r.s; });
      D.prepare("SELECT responsible_user_id u, COUNT(*) c, COALESCE(SUM(price),0) s FROM leads WHERE status_id=142 AND closed_at>=? GROUP BY u").all(from).forEach((r) => { const x = row(r.u); x.won = r.c; x.wonSum = r.s; });
      D.prepare("SELECT responsible_user_id u, COUNT(*) c FROM tasks WHERE is_completed=0 GROUP BY u").all().forEach((r) => { if (rows[r.u] || r.c > 5) row(r.u).openTasks = r.c; });
      try { D.prepare("SELECT created_by u, COUNT(*) c FROM notes_new WHERE created_at>=? GROUP BY u").all(from).forEach((r) => { row(r.u).notes = r.c; }); } catch (_) {}
      const out = Object.values(rows).filter((x) => x.name && !/^id /.test(x.name)).sort((a, b) => (b.created + b.won) - (a.created + a.won));
      res.json({ success: true, rows: out });
    } catch (e) { res.json({ success: false, message: e.message }); }
  });

  // «Сводный отчёт» (как в amo Аналитика→Сводный): график по неделям + кольцо + этапы + менеджеры. Кэш 120с.
  let summaryCache = null, summaryTs = 0;
  app.get(`${api}/summary_report`, guard, (req, res) => {
    try {
      if (summaryCache && Date.now() - summaryTs < 120000) return res.json(summaryCache);
      const weeks = D.prepare("SELECT strftime('%Y-%W', datetime(created_at,'unixepoch')) w, COUNT(*) c FROM leads WHERE created_at>0 GROUP BY w ORDER BY w DESC LIMIT 56").all().reverse();
      const closedW = {};
      D.prepare("SELECT strftime('%Y-%W', datetime(closed_at,'unixepoch')) w, COUNT(*) c FROM leads WHERE closed_at>0 GROUP BY w ORDER BY w DESC LIMIT 56").all().forEach((r) => { closedW[r.w] = r.c; });
      const total = D.prepare("SELECT COUNT(*) c, COALESCE(SUM(price),0) s FROM leads").get();
      const stages = D.prepare("SELECT status_id, COUNT(*) c, COALESCE(SUM(price),0) s FROM leads GROUP BY status_id ORDER BY c DESC LIMIT 8").all()
        .map((r) => ({ name: (stMap[r.status_id] || {}).name || ("этап " + r.status_id), color: (stMap[r.status_id] || {}).color || "#c1d5e0", c: r.c, s: r.s, pct: Math.round(r.c / total.c * 100) }));
      const mgrs = D.prepare("SELECT responsible_user_id u, COUNT(*) c, COALESCE(SUM(price),0) s FROM leads GROUP BY u ORDER BY c DESC LIMIT 8").all()
        .map((r) => ({ name: uName[r.u] || ("id " + r.u), c: r.c, s: r.s, pct: Math.round(r.c / total.c * 100) }));
      summaryCache = { success: true, weeks: weeks.map((r) => ({ w: r.w, created: r.c, closed: closedW[r.w] || 0 })), total: total.c, sum: total.s, stages, mgrs };
      summaryTs = Date.now();
      res.json(summaryCache);
    } catch (e) { res.json({ success: false, message: e.message }); }
  });

  // отчёт «Звонки» (как в amo Аналитика→Звонки): агрегат из calls_agg.json (bucket-примечания слепка, пересчёт tools-скриптом)
  app.get(`${api}/calls_report`, guard, (req, res) => {
    try {
      const agg = JSON.parse(fs.readFileSync(path.join(path.dirname(DB_PATH), "calls_agg.json"), "utf8"));
      const rows = Object.keys(agg).map((k) => {
        const a = agg[k];
        const name = /^\d+$/.test(k) ? (uName[+k] || ("id " + k)) : k;
        return { name, in_c: a.in_c, out_c: a.out_c, in_d: a.in_d, out_d: a.out_d, total: a.in_c + a.out_c, dur: a.in_d + a.out_d };
      }).filter((r2) => r2.total >= 5).sort((a, b) => b.total - a.total);
      res.json({ success: true, rows });
    } catch (e) { res.json({ success: false, message: "агрегат не построен: " + e.message }); }
  });

  app.get(`${api}/analytics`, guard, (req, res) => {
    const statuses = D.prepare("SELECT pipeline_id,id,name,sort,color,type FROM statuses").all();
    const pipes = D.prepare("SELECT id,name,is_main,sort FROM pipelines ORDER BY sort").all();
    // resp=CSV id-шников — срез «Мои/сотрудник/отдел» как на дашборде amo
    const rids = String(req.query.resp || "").split(",").filter((x) => /^\d+$/.test(x)).map(Number);
    const kmap = {};
    const krows = rids.length
      ? D.prepare("SELECT pipeline_id, status_id, COUNT(*) c, COALESCE(SUM(price),0) s FROM leads WHERE responsible_user_id IN (" + rids.map(() => "?").join(",") + ") GROUP BY pipeline_id, status_id").all(...rids)
      : qKanban.all();
    for (const r of krows) { (kmap[r.pipeline_id] = kmap[r.pipeline_id] || {})[r.status_id] = { c: r.c, s: r.s }; }
    const funnels = pipes.map((p) => {
      const sts = statuses.filter((s) => s.pipeline_id === p.id).sort((a, b) => (a.sort || 0) - (b.sort || 0));
      const stages = sts.map((s) => { const d = (kmap[p.id] || {})[s.id] || { c: 0, s: 0 }; return { name: s.name, color: s.color, count: d.c, sum: d.s }; });
      const total = stages.reduce((a, b) => a + b.count, 0);
      return { name: p.name, is_main: p.is_main, total, stages };
    }).filter((f) => rids.length ? true : f.total > 0); // при срезе по отв. воронку с нулями не прячем — иначе пропадёт выбранная
    const byUser = D.prepare("SELECT responsible_user_id r, COUNT(*) c, COALESCE(SUM(price),0) s FROM leads GROUP BY responsible_user_id ORDER BY c DESC LIMIT 15").all()
      .map((x) => ({ name: uName[x.r] || ("ID " + x.r), count: x.c, sum: x.s }));
    res.json({ success: true, funnels, byUser });
  });

  // кэш тяжёлых счётчиков виджетов (cf-LIKE по 291k сделок ~9с) — TTL 60с
  const WCACHE = new Map();
  const wcached = (key, ttlMs, fn) => {
    const hit = WCACHE.get(key);
    if (hit && Date.now() - hit.t < ttlMs) return hit.v;
    const v = fn();
    WCACHE.set(key, { t: Date.now(), v });
    if (WCACHE.size > 500) { const k0 = WCACHE.keys().next().value; WCACHE.delete(k0); }
    return v;
  };

  // статистика виджета рабочего стола: фильтр по сделкам → кол-во + сумма (как в amo)
  app.get(`${api}/widget_stat`, guard, (req, res) => {
    const q = req.query, where = [], args = [];
    if (/^\d+$/.test(String(q.pipeline || ""))) { where.push("pipeline_id=?"); args.push(+q.pipeline); }
    const sts = String(q.status || "").split(",").filter((x) => /^\d+$/.test(x));
    if (sts.length) { where.push("status_id IN (" + sts.map(() => "?").join(",") + ")"); sts.forEach((s) => args.push(+s)); }
    if (String(q.won) === "1") where.push("status_id=142");
    if (String(q.lost) === "1") where.push("status_id=143");
    const rids = String(q.resp || "").split(",").filter((x) => /^\d+$/.test(x));
    if (rids.length) { where.push("responsible_user_id IN (" + rids.map(() => "?").join(",") + ")"); rids.forEach((r) => args.push(+r)); }
    const now = Math.floor(Date.now() / 1000), day = now - (now % 86400);
    const field = ({ created: "created_at", closed: "closed_at", updated: "updated_at" })[q.field] || "created_at";
    let from = null, to = null;
    if (q.period === "today") { from = day; to = day + 86400; }
    else if (q.period === "yesterday") { from = day - 86400; to = day; }
    else if (q.period === "week") { from = day - 6 * 86400; to = day + 86400; }
    else if (q.period === "month") { const d = new Date(now * 1000); from = Math.floor(new Date(d.getFullYear(), d.getMonth(), 1).getTime() / 1000); to = now + 1; }
    if (from != null) { where.push("(" + field + ">=? AND " + field + "<?)"); args.push(from, to); }
    const w = where.length ? (" WHERE " + where.join(" AND ")) : "";
    try {
      const row = D.prepare("SELECT COUNT(*) c, COALESCE(SUM(price),0) s FROM leads" + w).get(...args);
      res.json({ success: true, count: row.c, sum: row.s });
    } catch (e) { res.json({ success: false, count: 0, sum: 0 }); }
  });

  // кастомные поля из cf_defs (единый источник правды — актуализируется amoCopySyncFields.js)
  app.get(`${api}/custom_fields`, guard, (req, res) => {
    const hasEditable = (() => { try { return !!D.prepare("SELECT editable FROM cf_defs LIMIT 1").get() || true; } catch (_) { return false; } })();
    const hasGroup = (() => { try { D.prepare("SELECT group_id FROM cf_defs LIMIT 1").get(); return true; } catch (_) { return false; } })();
    const cols = "entity,id,name,type,code,enums,sort" + (hasEditable ? ",editable" : "") + (hasGroup ? ",group_id" : "");
    const rows = D.prepare("SELECT " + cols + " FROM cf_defs WHERE entity IN ('leads','contacts','companies') ORDER BY entity, sort").all();
    const out = { leads: [], contacts: [], companies: [] };
    for (const r of rows) {
      if (!out[r.entity]) continue;
      out[r.entity].push({ id: r.id, name: r.name, type: r.type, code: r.code || null, enums: J(r.enums, []), editable: r.editable === 0 ? false : true, group_id: r.group_id || null });
    }
    res.json(out);
  });

  // группы полей amo (= табы карточки: Основное/Другие сделки/Услуги/Касса/Счета/Статистика/из API/...)
  app.get(`${api}/cf_groups`, guard, (req, res) => {
    try {
      const rows = D.prepare("SELECT entity,id,name,sort FROM cf_groups ORDER BY entity,sort").all();
      const out = { leads: [], contacts: [], companies: [] };
      for (const r of rows) if (out[r.entity]) out[r.entity].push({ id: r.id, name: r.name, sort: r.sort });
      res.json({ success: true, groups: out });
    } catch (_) { res.json({ success: true, groups: { leads: [], contacts: [], companies: [] } }); }
  });

  // список сделок этапа (как файловый, но из БД)
  app.get(`${api}/leads`, guard, (req, res) => {
    const pid = String(req.query.pipeline || ""), sid = String(req.query.status || ""), page = String(req.query.page || "1");
    if (!PAGE_FILE_RE.test(pid) || !PAGE_FILE_RE.test(sid) || !PAGE_FILE_RE.test(page)) return res.status(400).json({ success: false });
    const rows = qLeadsPage.all(+pid, +sid, PER_PAGE, (+page - 1) * PER_PAGE);
    res.json(rows.map((l) => ({
      id: l.id, name: l.name, price: l.price, resp: uName[l.responsible_user_id] || "",
      created: l.created_at, updated: l.updated_at, tags: J(l.tags, []),
      task_till: (qLeadTaskMin.get(l.id) || {}).m || 0,
      contact: (qLeadContactName.get(l.id) || {}).name || ""
    })));
  });

  // компании: список + карточка
  const qCompaniesPage = D.prepare("SELECT id,name,created_at,updated_at FROM companies ORDER BY updated_at DESC LIMIT ? OFFSET ?");
  const qCompaniesCount = D.prepare("SELECT COUNT(*) c FROM companies");
  const qCompany = D.prepare("SELECT * FROM companies WHERE id=?");
  app.get(`${api}/companies_page`, guard, (req, res) => {
    const page = String(req.query.page || "1");
    if (!PAGE_FILE_RE.test(page)) return res.status(400).json({ success: false });
    const q = String(req.query.q || "").trim();
    if (q) { // поиск компаний по названию (как в amo)
      const like = "%" + q + "%";
      const rows = D.prepare("SELECT id,name,created_at FROM companies WHERE lc(name) LIKE lc(?) ORDER BY updated_at DESC LIMIT 50 OFFSET ?").all(like, (+page - 1) * 50);
      const total = D.prepare("SELECT COUNT(*) c FROM companies WHERE lc(name) LIKE lc(?)").get(like).c;
      return res.json({ total, items: rows.map((c) => ({ id: c.id, name: c.name, created: c.created_at })) });
    }
    const rows = qCompaniesPage.all(50, (+page - 1) * 50);
    res.json({ total: qCompaniesCount.get().c, items: rows.map((c) => ({ id: c.id, name: c.name, created: c.created_at })) });
  });
  app.get(`${api}/company/:id`, guard, (req, res) => {
    const id = parseInt(req.params.id, 10);
    const c = qCompany.get(id);
    if (!c) return res.status(404).json({ success: false });
    const contacts = qContactsForCompany ? qContactsForCompany.all(id).map((x) => ({ id: x.id, name: x.name })) : [];
    const leads = qLeadsForCompany ? qLeadsForCompany.all(id).map((l) => ({ id: l.id, name: l.name, price: l.price, sid: l.status_id, st: dealChip(l.status_id).st, color: dealChip(l.status_id).color })) : [];
    // лента компании агрегирует события СВЯЗАННЫХ СДЕЛОК (как в amo): примечания+задачи первых 5 сделок с меткой __lead
    const top = leads.slice(0, 5);
    const allNotes = [], tasks = tasksOut("companies", id);
    const finish = () => res.json({ success: true, tasks, notes: allNotes, company: { id: c.id, name: c.name, created_at: c.created_at, updated_at: c.updated_at, custom_fields_values: J(c.cf, null), _embedded: { contacts, leads } } });
    const next = (i) => {
      if (i >= top.length) return finish();
      notesFromBucket("notes_leads", top[i].id, (ns) => {
        ns.forEach((n) => { n.__lead = { id: top[i].id, name: top[i].name }; allNotes.push(n); });
        tasksOut("leads", top[i].id).forEach((t) => { t.__lead = { id: top[i].id, name: top[i].name }; tasks.push(t); });
        next(i + 1);
      });
    };
    next(0);
  });

  // режим списка: все сделки воронки постранично (для табличного вида)
  // сортировка списка сделок по разрешённым колонкам (клик по заголовку)
  const LEAD_SORTS = { updated: "updated_at", created: "created_at", price: "price", name: "name", sid: "status_id" };
  app.get(`${api}/leads_all`, guard, (req, res) => {
    const pid = String(req.query.pipeline || ""), page = String(req.query.page || "1");
    if (!PAGE_FILE_RE.test(pid) || !PAGE_FILE_RE.test(page)) return res.status(400).json({ success: false });
    const sortCol = LEAD_SORTS[req.query.sort] || "updated_at";
    const dir = String(req.query.dir).toLowerCase() === "asc" ? "ASC" : "DESC";
    const rows = D.prepare("SELECT id,name,price,status_id,responsible_user_id,created_at,updated_at,cf FROM leads WHERE pipeline_id=? ORDER BY " + sortCol + " " + dir + " LIMIT 50 OFFSET ?").all(+pid, (+page - 1) * 50);
    res.json(rows.map((l) => ({ id: l.id, name: l.name, price: l.price, sid: l.status_id, resp: uName[l.responsible_user_id] || "", created: l.created_at, updated: l.updated_at, cf: J(l.cf, []) || [] })));
  });

  // поиск по сделкам (название/id) — из шапки
  const qLeadsSearch = D.prepare("SELECT id,name,price,status_id,pipeline_id,responsible_user_id FROM leads WHERE lc(name) LIKE lc(?) ORDER BY updated_at DESC LIMIT 50");
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
    const qCustSearch = D.prepare("SELECT id,name,status_id,responsible_user_id,ltv,purchases_count,average_check,next_price,next_date,created_at FROM customers WHERE lc(name) LIKE lc(?) ORDER BY created_at DESC LIMIT 50");
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
      res.json({ success: true, tasks: tasksOut("customers", c.id), customer: { id: c.id, name: c.name, responsible_user_id: c.responsible_user_id,
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
    // этап: одиночный id или CSV нескольких (мультиселект «Активные статусы», как в amo)
    if (q.status) {
      const sts = String(q.status).split(",").map((x) => parseInt(x, 10)).filter(Number.isFinite);
      if (sts.length === 1) { where.push("status_id=?"); args.push(sts[0]); }
      else if (sts.length > 1) { where.push("status_id IN (" + sts.map(() => "?").join(",") + ")"); args.push(...sts); }
    }
    if ((v = intq(q.responsible)) !== null) { where.push("responsible_user_id=?"); args.push(v); }
    if ((v = intq(q.price_min)) !== null) { where.push("price>=?"); args.push(v); }
    if ((v = intq(q.price_max)) !== null) { where.push("price<=?"); args.push(v); }
    if ((v = intq(q.date_from)) !== null) { where.push("created_at>=?"); args.push(v); }
    if ((v = intq(q.date_to)) !== null) { where.push("created_at<=?"); args.push(v); }
    if (q.tag && String(q.tag).trim()) { where.push("tags LIKE ?"); args.push("%" + String(q.tag).trim() + "%"); }
    if (q.q && String(q.q).trim()) { where.push("lc(name) LIKE lc(?)"); args.push("%" + String(q.q).trim() + "%"); }
    // быстрые системные пресеты (как левая колонка панели фильтра amo)
    const nowP = Math.floor(Date.now() / 1000);
    if (q.preset === "open") where.push("status_id NOT IN (142,143)");
    else if (q.preset === "won") where.push("status_id=142");
    else if (q.preset === "lost") where.push("status_id=143");
    else if (q.preset === "notasks") where.push("status_id NOT IN (142,143) AND NOT EXISTS(SELECT 1 FROM tasks t WHERE t.entity_type='leads' AND t.entity_id=leads.id AND t.is_completed=0)");
    else if (q.preset === "overdue") { where.push("status_id NOT IN (142,143) AND EXISTS(SELECT 1 FROM tasks t WHERE t.entity_type='leads' AND t.entity_id=leads.id AND t.is_completed=0 AND t.complete_till<?)"); args.push(nowP); }
    // фильтр по кастомным полям самой сделки
    addCfFilters(q.cf, where, args);
    // фильтр по полям СВЯЗАННОГО КОНТАКТА: ccf=<fieldId>:<значение> → подзапрос по lead_contacts+contacts
    if (q.ccf) {
      const cw = [], ca = [];
      addCfFilters(q.ccf, cw, ca);
      if (cw.length) { where.push("id IN (SELECT lc.lead_id FROM lead_contacts lc JOIN contacts c ON c.id=lc.contact_id WHERE " + cw.join(" AND ") + ")"); args.push(...ca); }
    }
    const page = Math.max(1, intq(q.page) || 1);
    const sql = "SELECT id,name,price,pipeline_id,status_id,responsible_user_id,created_at,updated_at FROM leads" +
      (where.length ? " WHERE " + where.join(" AND ") : "") + " ORDER BY updated_at DESC LIMIT 50 OFFSET ?";
    try {
      // count_only=1 — для виджетов рабочего стола по сохранённому фильтру (кол-во + сумма), с TTL-кэшем
      if (String(q.count_only) === "1") {
        const key = "lf:" + where.join("|") + ":" + args.join(",");
        const t = wcached(key, 60000, () => D.prepare("SELECT COUNT(*) c, COALESCE(SUM(price),0) s FROM leads" + (where.length ? " WHERE " + where.join(" AND ") : "")).get(...args));
        return res.json({ success: true, total: t.c, sum: t.s, items: [] });
      }
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
    if (q.q && String(q.q).trim()) { where.push("(lc(name) LIKE lc(?) OR phones LIKE ? OR emails LIKE ?)"); const s = "%" + String(q.q).trim() + "%"; args.push(s, s, s); }
    // фильтр по любому кастомному полю: cf=<fieldId>:<значение> (можно несколько)
    addCfFilters(q.cf, where, args);
    const page = Math.max(1, intq(q.page) || 1);
    const sql = "SELECT id,name,phones,emails,created_at,updated_at,responsible_user_id,cf,tags FROM contacts" +
      (where.length ? " WHERE " + where.join(" AND ") : "") + " ORDER BY created_at DESC LIMIT 50 OFFSET ?";
    try {
      if (String(q.count_only) === "1") {
        const key = "cf:" + where.join("|") + ":" + args.join(",");
        const t = wcached(key, 60000, () => D.prepare("SELECT COUNT(*) c FROM contacts" + (where.length ? " WHERE " + where.join(" AND ") : "")).get(...args));
        return res.json({ success: true, total: t.c, items: [] });
      }
      const rows = D.prepare(sql).all(...args, (page - 1) * 50);
      let total = null;
      if (page === 1) { total = D.prepare("SELECT COUNT(*) c FROM contacts" + (where.length ? " WHERE " + where.join(" AND ") : "")).get(...args).c; }
      res.json({ success: true, total, items: contactOut(rows, true) });
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
    const cids = J(l.contact_ids, []);
    // мини-карточка контакта (как в amo): телефоны/почты/поля контакта прямо в сделке
    const contactById = {};
    for (const cid of cids) { const c = qContact.get(cid); if (c) contactById[cid] = c; }
    // «Другие сделки» этих контактов (таб карточки amo)
    let otherLeads = [];
    if (cids.length) {
      try {
        const ph = cids.map(() => "?").join(",");
        otherLeads = D.prepare(`SELECT DISTINCT l.id,l.name,l.price,l.status_id FROM lead_contacts lc JOIN leads l ON l.id=lc.lead_id WHERE lc.contact_id IN (${ph}) AND l.id!=? ORDER BY l.updated_at DESC LIMIT 30`).all(...cids, id)
          .map((x) => ({ id: x.id, name: x.name, price: x.price, st: dealChip(x.status_id).st, color: dealChip(x.status_id).color }));
      } catch (_) {}
    }
    const lead = {
      id: l.id, name: l.name, price: l.price, status_id: l.status_id, pipeline_id: l.pipeline_id,
      responsible_user_id: l.responsible_user_id, created_at: l.created_at, updated_at: l.updated_at, closed_at: l.closed_at || null,
      custom_fields_values: J(l.cf, null),
      _embedded: {
        tags: J(l.tags, []).map((n) => ({ name: n })),
        contacts: cids.map((cid, i) => {
          const c = contactById[cid];
          return { id: cid, name: (c && c.name) || ("Контакт #" + cid), is_main: i === 0,
            phones: c ? J(c.phones, []) : [], emails: c ? J(c.emails, []) : [], cf: c ? J(c.cf, []) : [] };
        }),
        companies: companiesForLead(id)
      }
    };
    notesFromBucket("notes_leads", id, (notes) => res.json({ success: true, lead, notes, tasks, other_leads: otherLeads }));
  });

  // карточка контакта (поля из БД, сделки из lead_contacts, примечания из bucket)
  app.get(`${api}/contact/:id`, guard, (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ success: false });
    const c = qContact.get(id);
    if (!c) return res.status(404).json({ success: false, message: "Контакт не найден" });
    const leads = qContactLeads.all(id).map((l) => ({ id: l.id, name: l.name, price: l.price, pid: l.pipeline_id, sid: l.status_id, st: dealChip(l.status_id).st, color: dealChip(l.status_id).color }));
    const contact = {
      id: c.id, name: c.name, responsible_user_id: c.responsible_user_id, created_at: c.created_at, updated_at: c.updated_at,
      custom_fields_values: J(c.cf, null), tags: J(c.tags, []),
      _embedded: { companies: companiesForContact(id) }
    };
    // лента контакта агрегирует события связанных СДЕЛОК (как в amo): примечания+задачи первых 5 сделок с меткой __lead
    notesFromBucket("notes_contacts", id, (ownNotes) => {
      const top = leads.slice(0, 5);
      const allNotes = ownNotes.slice(), tasks = tasksOut("contacts", id);
      const finish = () => res.json({ success: true, contact, notes: allNotes, leads, tasks });
      const next = (i) => {
        if (i >= top.length) return finish();
        notesFromBucket("notes_leads", top[i].id, (ns) => {
          ns.forEach((n) => { n.__lead = { id: top[i].id, name: top[i].name }; allNotes.push(n); });
          tasksOut("leads", top[i].id).forEach((t) => { t.__lead = { id: top[i].id, name: top[i].name }; tasks.push(t); });
          next(i + 1);
        });
      };
      next(0);
    });
  });

  // постраничный список контактов (новые сверху)
  app.get(`${api}/contacts_page`, guard, (req, res) => {
    const page = String(req.query.page || "1");
    if (!PAGE_FILE_RE.test(page)) return res.status(400).json({ success: false });
    const CSORT = { created: "created_at", updated: "updated_at", n: "name" };
    const sortCol = CSORT[req.query.sort] || "created_at";
    const dir = String(req.query.dir).toLowerCase() === "asc" ? "ASC" : "DESC";
    const rows = D.prepare("SELECT id,name,phones,emails,created_at,updated_at,responsible_user_id,cf,tags FROM contacts ORDER BY " + sortCol + " " + dir + " LIMIT ? OFFSET ?").all(PER_PAGE, (+page - 1) * PER_PAGE);
    res.json(contactOut(rows, true));
  });

  // поиск контактов (имя LIKE, или телефон/email по цифрам/подстроке) — топ-50
  const qSearchName = D.prepare("SELECT id,name,phones,emails,created_at FROM contacts WHERE lc(name) LIKE lc(?) ORDER BY created_at DESC LIMIT 50");
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
