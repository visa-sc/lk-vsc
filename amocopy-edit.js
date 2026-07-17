/*
 * amocopy-edit.js — слой ЗАПИСИ для crm.voyotravel.ru (копия становится рабочей CRM).
 * Монтируется в crm-svc. Пишет в ту же SQLite (.amocopy-db/crm.db), отдельное write-соединение.
 * Каждое изменение фиксируется в changelog (кто/когда/что) — как «История» в amoCRM.
 *
 * Новые локальные сущности получают id из счётчика начиная с 1_000_000_000
 * (реальные amo-id меньше — коллизий нет; при будущем синке легко отличить локальные).
 *
 * Только чтение живой amoCRM тут ни при чём — модуль работает исключительно с локальной БД.
 * Доступ — тот же guard (код 111).
 */
const fs = require("fs");
const path = require("path");
const Database = require(process.env.SQLITE_MODULE || "better-sqlite3");

const DB_PATH = process.env.AMOCOPY_DB || "/var/www/voyo/.amocopy-db/crm.db";
const RULES_PATH = process.env.AMOCOPY_RULES || path.join(path.dirname(DB_PATH), "rules.json");
const LOCAL_ID_BASE = 1000000000;

// правила автоматизаций (v1): при входе на этап — создать задачу / сменить ответственного.
// Пока список из rules.json (заполняется из описи с подтверждением). Внешние действия (письма/SMS) — заглушки-логи.
function loadRules() { try { return JSON.parse(fs.readFileSync(RULES_PATH, "utf8")).rules || []; } catch (_) { return []; } }

function nowSec() { return Math.floor(Date.now() / 1000); }

module.exports = function mountEditRoutes(app, guard) {
  let db;
  try {
    db = new Database(DB_PATH, { fileMustExist: true });
    db.pragma("journal_mode = WAL");
    db.pragma("synchronous = NORMAL");
    db.pragma("busy_timeout = 8000"); // не падать при параллельном чтении
  } catch (e) { console.error("amocopy-edit: БД для записи недоступна:", e.message); return false; }

  db.exec(`
    CREATE TABLE IF NOT EXISTS changelog (
      id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, actor TEXT,
      entity_type TEXT, entity_id INTEGER, action TEXT, detail TEXT
    );
    CREATE INDEX IF NOT EXISTS ix_chl_entity ON changelog(entity_type,entity_id,ts);
    CREATE TABLE IF NOT EXISTS local_seq (name TEXT PRIMARY KEY, val INTEGER);
    CREATE TABLE IF NOT EXISTS notes_new (
      id INTEGER PRIMARY KEY, entity_type TEXT, entity_id INTEGER, text TEXT, created_by TEXT, created_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS ix_notes_new ON notes_new(entity_type,entity_id,created_at);
    /* индексы сортировок длинных списков (имя контакта было 3.5с без индекса) */
    CREATE INDEX IF NOT EXISTS ix_contacts_name ON contacts(name);
    CREATE INDEX IF NOT EXISTS ix_contacts_created ON contacts(created_at);
    CREATE INDEX IF NOT EXISTS ix_leads_pipe_name ON leads(pipeline_id,name);
    CREATE INDEX IF NOT EXISTS ix_leads_pipe_price ON leads(pipeline_id,price);
    CREATE INDEX IF NOT EXISTS ix_leads_pipe_created ON leads(pipeline_id,created_at);
  `);
  const seqRow = db.prepare("SELECT val FROM local_seq WHERE name='id'").get();
  if (!seqRow) db.prepare("INSERT INTO local_seq(name,val) VALUES('id',?)").run(LOCAL_ID_BASE);

  const nextId = db.transaction(() => {
    const v = db.prepare("SELECT val FROM local_seq WHERE name='id'").get().val + 1;
    db.prepare("UPDATE local_seq SET val=? WHERE name='id'").run(v);
    return v;
  });
  const logChange = db.prepare("INSERT INTO changelog(ts,actor,entity_type,entity_id,action,detail) VALUES(?,?,?,?,?,?)");
  const actorOf = (req) => String((req.headers["x-real-ip"] || "") + "").slice(0, 40) || "crm";
  const audit = (req, et, eid, action, detail) => logChange.run(nowSec(), actorOf(req), et, eid, action, JSON.stringify(detail || {}));

  const getLead = db.prepare("SELECT * FROM leads WHERE id=?");
  const getContact = db.prepare("SELECT * FROM contacts WHERE id=?");
  const getCompany = db.prepare("SELECT * FROM companies WHERE id=?");
  const getStatus = db.prepare("SELECT name FROM statuses WHERE pipeline_id=? AND id=?");
  const uName = {}; db.prepare("SELECT id,name FROM users").all().forEach((u) => { uName[u.id] = u.name; });

  const E = "/edit-api";

  // серверный гейт прав ролей (аудит 18.07: раньше /edit-api проверял только аутентификацию —
  // любой сотрудник мог удалять сделки). Удаление/слияние — is_admin или право del; прочие правки — право edit.
  app.use(E, (req, res, next) => {
    if (req.method === "GET") return next();
    guard(req, res, () => {
      const c = req.crm || {};
      if (c.is_admin || c.kind === "admin") return next();
      const r = c.rights || {};
      const isDel = /\/delete$|\/merge$/.test(req.path);
      if (isDel ? r.del : r.edit) return next();
      return res.status(403).json({ success: false, message: isDel ? "Нет права удаления — обратитесь к администратору" : "Нет права редактирования" });
    });
  });

  // применение правил автоматизаций при входе сделки на этап
  function applyStageRules(req, leadId, pid, sid, leadResp) {
    const rules = loadRules().filter((r) => r.pipeline_id === pid && r.status_id === sid);
    const applied = [];
    for (const r of rules) {
      if (r.action === "create_task") {
        const tid = nextId();
        // авто-задача — на текущего ответственного сделки (как в amoCRM), если правило не задаёт иного
        const taskResp = r.responsible_user_id || leadResp || 0;
        db.prepare(`INSERT INTO tasks(id,entity_type,entity_id,text,task_type,complete_till,is_completed,responsible_user_id,result,created_at)
          VALUES(?,?,?,?,?,?,0,?,?,?)`).run(tid, "leads", leadId, r.text || "", r.task_type || 0, nowSec() + 86400, taskResp, "null", nowSec());
        audit(req, "leads", leadId, "auto_task", { rule: r.text, task_id: tid });
        applied.push("задача: " + (r.text || "").slice(0, 40));
      } else if (r.action === "set_responsible" && r.responsible_user_id) {
        db.prepare("UPDATE leads SET responsible_user_id=? WHERE id=?").run(r.responsible_user_id, leadId);
        audit(req, "leads", leadId, "auto_responsible", { rule: r.responsible_user_id });
        applied.push("ответственный сменён");
      }
    }
    return applied;
  }

  // просмотр активных правил автоматизаций
  app.get(`${E}/rules`, guard, (req, res) => {
    res.json({ success: true, rules: loadRules() });
  });

  // ── перемещение сделки по этапам (drag-n-drop) ──
  app.post(`${E}/lead/:id/stage`, guard, (req, res) => {
    const id = parseInt(req.params.id, 10);
    const pid = parseInt(req.body.pipeline_id, 10), sid = parseInt(req.body.status_id, 10);
    if (!id || !pid || !sid) return res.status(400).json({ success: false, message: "нужны pipeline_id, status_id" });
    const lead = getLead.get(id);
    if (!lead) return res.status(404).json({ success: false });
    const st = getStatus.get(pid, sid);
    if (!st) return res.status(400).json({ success: false, message: "нет такого этапа" });
    const fromP = lead.pipeline_id, fromS = lead.status_id;
    db.prepare("UPDATE leads SET pipeline_id=?, status_id=?, updated_at=? WHERE id=?").run(pid, sid, nowSec(), id);
    audit(req, "leads", id, "stage", { from: { pipeline_id: fromP, status_id: fromS }, to: { pipeline_id: pid, status_id: sid, name: st.name } });
    // движок автоматизаций v1: применяем правила входа на этап
    const applied = applyStageRules(req, id, pid, sid, lead.responsible_user_id);
    res.json({ success: true, status_id: sid, pipeline_id: pid, status_name: st.name, automations: applied });
  });

  // ── правка полей сделки (name, price, ответственный) ──
  app.patch(`${E}/lead/:id`, guard, (req, res) => {
    const id = parseInt(req.params.id, 10);
    const lead = getLead.get(id);
    if (!lead) return res.status(404).json({ success: false });
    const upd = {}, changes = {};
    if (typeof req.body.name === "string") { upd.name = req.body.name.slice(0, 500); changes.name = [lead.name, upd.name]; }
    if (req.body.price != null && !isNaN(+req.body.price)) { upd.price = Math.round(+req.body.price); changes.price = [lead.price, upd.price]; }
    if (req.body.responsible_user_id != null) { upd.responsible_user_id = parseInt(req.body.responsible_user_id, 10) || 0; changes.responsible = [uName[lead.responsible_user_id], uName[upd.responsible_user_id]]; }
    if (!Object.keys(upd).length) return res.status(400).json({ success: false, message: "нечего менять" });
    upd.updated_at = nowSec();
    const set = Object.keys(upd).map((k) => `${k}=@${k}`).join(", ");
    db.prepare(`UPDATE leads SET ${set} WHERE id=@id`).run(Object.assign({ id }, upd));
    audit(req, "leads", id, "edit", changes);
    res.json({ success: true, updated: Object.keys(changes) });
  });

  // ── правка кастомного поля сделки/контакта ──
  function updateCf(entity, id, fieldId, fieldName, value) {
    const getter = entity === "leads" ? getLead : (entity === "companies" ? getCompany : getContact);
    const row = getter.get(id);
    if (!row) return { ok: false, code: 404 };
    let cf = []; try { cf = JSON.parse(row.cf) || []; } catch (_) { cf = []; }
    if (!Array.isArray(cf)) cf = [];
    // multiselect (amo хранит массив values), boolean у чекбоксов, timestamp у дат — как в amo
    let vArr;
    if (Array.isArray(value)) vArr = value.filter((v) => v !== "" && v != null).map((v) => ({ value: v }));
    else vArr = (value === "" || value == null) ? [] : [{ value: value }];
    const ix = cf.findIndex((f) => f.field_id === fieldId);
    if (ix >= 0) { if (!vArr.length) cf.splice(ix, 1); else cf[ix].values = vArr; }
    else if (vArr.length) cf.push({ field_id: fieldId, field_name: fieldName || String(fieldId), values: vArr });
    db.prepare(`UPDATE ${entity} SET cf=?, updated_at=? WHERE id=?`).run(JSON.stringify(cf), nowSec(), id);
    return { ok: true };
  }
  app.patch(`${E}/lead/:id/cf`, guard, (req, res) => {
    const id = parseInt(req.params.id, 10), fid = parseInt(req.body.field_id, 10);
    if (!id || !fid) return res.status(400).json({ success: false });
    const r = updateCf("leads", id, fid, req.body.field_name, req.body.value);
    if (!r.ok) return res.status(r.code || 500).json({ success: false });
    audit(req, "leads", id, "edit_cf", { field_id: fid, field: req.body.field_name, value: req.body.value });
    res.json({ success: true });
  });
  app.patch(`${E}/contact/:id/cf`, guard, (req, res) => {
    const id = parseInt(req.params.id, 10), fid = parseInt(req.body.field_id, 10);
    if (!id || !fid) return res.status(400).json({ success: false });
    const r = updateCf("contacts", id, fid, req.body.field_name, req.body.value);
    if (!r.ok) return res.status(r.code || 500).json({ success: false });
    audit(req, "contacts", id, "edit_cf", { field_id: fid, field: req.body.field_name, value: req.body.value });
    res.json({ success: true });
  });
  // ── правка компании (название) + её кастомных полей (паритет с контактом) ──
  app.patch(`${E}/company/:id`, guard, (req, res) => {
    const id = parseInt(req.params.id, 10);
    const c = getCompany.get(id);
    if (!c) return res.status(404).json({ success: false });
    if (typeof req.body.name !== "string" || !req.body.name.trim()) return res.status(400).json({ success: false, message: "нужно название" });
    const name = req.body.name.slice(0, 500);
    db.prepare("UPDATE companies SET name=?, updated_at=? WHERE id=?").run(name, nowSec(), id);
    audit(req, "companies", id, "edit", { name: [c.name, name] });
    res.json({ success: true });
  });
  app.patch(`${E}/company/:id/cf`, guard, (req, res) => {
    const id = parseInt(req.params.id, 10), fid = parseInt(req.body.field_id, 10);
    if (!id || !fid) return res.status(400).json({ success: false });
    const r = updateCf("companies", id, fid, req.body.field_name, req.body.value);
    if (!r.ok) return res.status(r.code || 500).json({ success: false });
    audit(req, "companies", id, "edit_cf", { field_id: fid, field: req.body.field_name, value: req.body.value });
    res.json({ success: true });
  });

  // ── теги сделки (добавить/удалить) ──
  app.patch(`${E}/lead/:id/tags`, guard, (req, res) => {
    const id = parseInt(req.params.id, 10);
    const lead = getLead.get(id);
    if (!lead) return res.status(404).json({ success: false });
    if (!Array.isArray(req.body.tags)) return res.status(400).json({ success: false });
    let tags = req.body.tags.map((t) => String(t).trim()).filter(Boolean);
    if (req.body.append) { let cur = []; try { cur = JSON.parse(lead.tags) || []; } catch (_) {} tags = cur.concat(tags.filter((t) => cur.indexOf(t) < 0)); }
    tags = tags.slice(0, 30);
    db.prepare("UPDATE leads SET tags=?, updated_at=? WHERE id=?").run(JSON.stringify(tags), nowSec(), id);
    audit(req, "leads", id, "edit_tags", { tags });
    res.json({ success: true, tags });
  });

  // ── удаление сделки/контакта (мягкое: только локальные и по подтверждению) ──
  app.post(`${E}/lead/:id/delete`, guard, (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!getLead.get(id)) return res.status(404).json({ success: false });
    db.prepare("DELETE FROM leads WHERE id=?").run(id);
    db.prepare("DELETE FROM lead_contacts WHERE lead_id=?").run(id);
    // каскад как в amo: задачи и локальные примечания сделки уходят вместе с ней
    db.prepare("DELETE FROM tasks WHERE entity_type='leads' AND entity_id=?").run(id);
    db.prepare("DELETE FROM notes_new WHERE entity_type='leads' AND entity_id=?").run(id);
    audit(req, "leads", id, "delete", {});
    res.json({ success: true });
  });
  app.post(`${E}/contact/:id/delete`, guard, (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!getContact.get(id)) return res.status(404).json({ success: false });
    db.prepare("DELETE FROM contacts WHERE id=?").run(id);
    db.prepare("DELETE FROM lead_contacts WHERE contact_id=?").run(id);
    audit(req, "contacts", id, "delete", {});
    res.json({ success: true });
  });

  // ── создание сделки ──
  app.post(`${E}/lead`, guard, (req, res) => {
    const pid = parseInt(req.body.pipeline_id, 10), sid = parseInt(req.body.status_id, 10);
    if (!pid || !sid || !getStatus.get(pid, sid)) return res.status(400).json({ success: false, message: "нужны валидные pipeline_id/status_id" });
    const id = nextId();
    const now = nowSec();
    const rec = {
      id, name: String(req.body.name || "Новая сделка").slice(0, 500), price: Math.round(+req.body.price || 0),
      status_id: sid, pipeline_id: pid, responsible_user_id: parseInt(req.body.responsible_user_id, 10) || 0,
      created_at: now, updated_at: now, closed_at: 0, cf: "null", tags: "[]",
      contact_ids: JSON.stringify((req.body.contact_ids || []).map(Number).filter(Boolean))
    };
    db.prepare(`INSERT INTO leads(id,name,price,status_id,pipeline_id,responsible_user_id,created_at,updated_at,closed_at,cf,tags,contact_ids)
      VALUES(@id,@name,@price,@status_id,@pipeline_id,@responsible_user_id,@created_at,@updated_at,@closed_at,@cf,@tags,@contact_ids)`).run(rec);
    JSON.parse(rec.contact_ids).forEach((cid) => db.prepare("INSERT OR IGNORE INTO lead_contacts(lead_id,contact_id) VALUES(?,?)").run(id, cid));
    audit(req, "leads", id, "create", { name: rec.name, pipeline_id: pid, status_id: sid });
    res.json({ success: true, id });
  });

  // ── создание контакта ──
  app.post(`${E}/contact`, guard, (req, res) => {
    const id = nextId(), now = nowSec();
    const phones = (req.body.phones || []).map(String).filter(Boolean);
    const emails = (req.body.emails || []).map(String).filter(Boolean);
    db.prepare(`INSERT INTO contacts(id,name,responsible_user_id,created_at,updated_at,cf,phones,emails)
      VALUES(?,?,?,?,?,?,?,?)`).run(id, String(req.body.name || "Новый контакт").slice(0, 300), parseInt(req.body.responsible_user_id, 10) || 0, now, now, "null", JSON.stringify(phones), JSON.stringify(emails));
    audit(req, "contacts", id, "create", { name: req.body.name, phones, emails });
    res.json({ success: true, id });
  });

  // ── создание компании (для «＋ Добавить компанию» из карточки, как в amo) ──
  app.post(`${E}/company`, guard, (req, res) => {
    const name = String(req.body.name || "").trim();
    if (!name) return res.status(400).json({ success: false, message: "нужно название" });
    const id = nextId(), now = nowSec();
    db.prepare("INSERT INTO companies(id,name,created_at,updated_at,cf) VALUES(?,?,?,?,?)").run(id, name.slice(0, 500), now, now, "null");
    audit(req, "companies", id, "create", { name });
    res.json({ success: true, id });
  });

  // ── правка контакта ──
  app.patch(`${E}/contact/:id`, guard, (req, res) => {
    const id = parseInt(req.params.id, 10);
    const c = getContact.get(id);
    if (!c) return res.status(404).json({ success: false });
    const upd = {}, changes = {};
    if (typeof req.body.name === "string") { upd.name = req.body.name.slice(0, 300); changes.name = [c.name, upd.name]; }
    if (Array.isArray(req.body.phones)) { upd.phones = JSON.stringify(req.body.phones.map(String).filter(Boolean)); changes.phones = JSON.parse(upd.phones); }
    if (Array.isArray(req.body.emails)) { upd.emails = JSON.stringify(req.body.emails.map(String).filter(Boolean)); changes.emails = JSON.parse(upd.emails); }
    if (req.body.responsible_user_id != null) { upd.responsible_user_id = parseInt(req.body.responsible_user_id, 10) || 0; changes.responsible = [uName[c.responsible_user_id], uName[upd.responsible_user_id]]; }
    if (!Object.keys(upd).length) return res.status(400).json({ success: false });
    upd.updated_at = nowSec();
    const set = Object.keys(upd).map((k) => `${k}=@${k}`).join(", ");
    db.prepare(`UPDATE contacts SET ${set} WHERE id=@id`).run(Object.assign({ id }, upd));
    audit(req, "contacts", id, "edit", changes);
    res.json({ success: true });
  });

  // ── привязка/отвязка контакта к сделке (как в amo) ──
  app.post(`${E}/lead/:id/link_contact`, guard, (req, res) => {
    const id = parseInt(req.params.id, 10), cid = parseInt(req.body.contact_id, 10);
    if (!id || !cid) return res.status(400).json({ success: false });
    const lead = getLead.get(id);
    if (!lead) return res.status(404).json({ success: false, message: "сделка не найдена" });
    const c = getContact.get(cid);
    if (!c) return res.status(404).json({ success: false, message: "контакт не найден" });
    const unlink = req.body.unlink === true;
    let cids = []; try { cids = JSON.parse(lead.contact_ids) || []; } catch (_) {}
    if (unlink) {
      db.prepare("DELETE FROM lead_contacts WHERE lead_id=? AND contact_id=?").run(id, cid);
      cids = cids.filter((x) => x !== cid);
    } else {
      db.prepare("INSERT OR IGNORE INTO lead_contacts(lead_id,contact_id) VALUES(?,?)").run(id, cid);
      if (cids.indexOf(cid) < 0) cids.push(cid);
    }
    db.prepare("UPDATE leads SET contact_ids=?, updated_at=? WHERE id=?").run(JSON.stringify(cids), nowSec(), id);
    audit(req, "leads", id, unlink ? "unlink_contact" : "link_contact", { contact_id: cid, contact: c.name });
    res.json({ success: true });
  });

  // ── привязка/отвязка КОМПАНИИ к сделке (как «Добавить компанию» в amo) ──
  app.post(`${E}/lead/:id/link_company`, guard, (req, res) => {
    const id = parseInt(req.params.id, 10), coid = parseInt(req.body.company_id, 10);
    if (!id || !coid) return res.status(400).json({ success: false });
    if (!getLead.get(id)) return res.status(404).json({ success: false, message: "сделка не найдена" });
    const co = getCompany.get(coid);
    if (!co) return res.status(404).json({ success: false, message: "компания не найдена" });
    db.exec("CREATE TABLE IF NOT EXISTS lead_companies (lead_id INTEGER, company_id INTEGER)");
    if (req.body.unlink === true) db.prepare("DELETE FROM lead_companies WHERE lead_id=? AND company_id=?").run(id, coid);
    else { db.prepare("DELETE FROM lead_companies WHERE lead_id=? AND company_id=?").run(id, coid); db.prepare("INSERT INTO lead_companies(lead_id,company_id) VALUES(?,?)").run(id, coid); }
    audit(req, "leads", id, req.body.unlink === true ? "unlink_company" : "link_company", { company_id: coid, company: co.name });
    res.json({ success: true });
  });

  // ── слияние контактов (как «Объединить» в amo): дубли вливаются в основной ──
  app.post(`${E}/contacts/merge`, guard, (req, res) => {
    const ids = Array.isArray(req.body.ids) ? req.body.ids.map((x) => parseInt(x, 10)).filter(Boolean) : [];
    if (ids.length < 2) return res.status(400).json({ success: false, message: "нужно минимум 2 контакта" });
    const rows = ids.map((id) => getContact.get(id)).filter(Boolean);
    if (rows.length < 2) return res.status(404).json({ success: false, message: "контакты не найдены" });
    // основной — самый ранний (наименьший id, обычно самый старый в amo)
    rows.sort((a, b) => a.id - b.id);
    const target = rows[0], dupes = rows.slice(1);
    const JJ = (s, d) => { try { const v = JSON.parse(s); return v == null ? d : v; } catch (_) { return d; } };
    const tx = db.transaction(() => {
      // объединяем телефоны/почты/поля (недостающие у основного берём из дублей)
      let phones = JJ(target.phones, []), emails = JJ(target.emails, []), cf = JJ(target.cf, []);
      if (!Array.isArray(cf)) cf = [];
      const cfIds = new Set(cf.map((f) => f.field_id));
      for (const d of dupes) {
        for (const p of JJ(d.phones, [])) if (phones.indexOf(p) < 0) phones.push(p);
        for (const e of JJ(d.emails, [])) if (emails.indexOf(e) < 0) emails.push(e);
        for (const f of JJ(d.cf, []) || []) if (f && f.field_id && !cfIds.has(f.field_id)) { cf.push(f); cfIds.add(f.field_id); }
      }
      db.prepare("UPDATE contacts SET phones=?, emails=?, cf=?, updated_at=? WHERE id=?")
        .run(JSON.stringify(phones), JSON.stringify(emails), JSON.stringify(cf), nowSec(), target.id);
      for (const d of dupes) {
        // перевязка сделок (lead_contacts + JSON contact_ids в самих сделках)
        const leadRows = db.prepare("SELECT lead_id FROM lead_contacts WHERE contact_id=?").all(d.id);
        for (const lr of leadRows) {
          const has = db.prepare("SELECT 1 x FROM lead_contacts WHERE lead_id=? AND contact_id=?").get(lr.lead_id, target.id);
          if (has) db.prepare("DELETE FROM lead_contacts WHERE lead_id=? AND contact_id=?").run(lr.lead_id, d.id);
          else db.prepare("UPDATE lead_contacts SET contact_id=? WHERE lead_id=? AND contact_id=?").run(target.id, lr.lead_id, d.id);
          const lead = db.prepare("SELECT contact_ids FROM leads WHERE id=?").get(lr.lead_id);
          if (lead) {
            let cids = JJ(lead.contact_ids, []);
            cids = cids.map((x) => (x === d.id ? target.id : x)).filter((x, i, a) => a.indexOf(x) === i);
            db.prepare("UPDATE leads SET contact_ids=? WHERE id=?").run(JSON.stringify(cids), lr.lead_id);
          }
        }
        // перевязка компаний
        const coRows = db.prepare("SELECT company_id FROM contact_companies WHERE contact_id=?").all(d.id);
        for (const cr of coRows) {
          const has = db.prepare("SELECT 1 x FROM contact_companies WHERE contact_id=? AND company_id=?").get(target.id, cr.company_id);
          if (has) db.prepare("DELETE FROM contact_companies WHERE contact_id=? AND company_id=?").run(d.id, cr.company_id);
          else db.prepare("UPDATE contact_companies SET contact_id=? WHERE contact_id=? AND company_id=?").run(target.id, d.id, cr.company_id);
        }
        // задачи и локальные примечания дубля → основному
        db.prepare("UPDATE tasks SET entity_id=? WHERE entity_type='contacts' AND entity_id=?").run(target.id, d.id);
        db.prepare("UPDATE notes_new SET entity_id=? WHERE entity_type='contacts' AND entity_id=?").run(target.id, d.id);
        db.prepare("DELETE FROM contacts WHERE id=?").run(d.id);
      }
    });
    try { tx(); } catch (e) { return res.status(500).json({ success: false, message: e.message }); }
    audit(req, "contacts", target.id, "merge", { merged: dupes.map((d) => ({ id: d.id, name: d.name })) });
    res.json({ success: true, target_id: target.id, merged: dupes.length });
  });

  // допустимые типы сущностей для примечаний/задач/истории (как в amo)
  const ENT3 = (v) => (v === "contacts" || v === "companies" || v === "customers" ? v : "leads");
  // ── создание задачи ──
  app.post(`${E}/task`, guard, (req, res) => {
    const entity_type = ENT3(req.body.entity_type);
    const entity_id = parseInt(req.body.entity_id, 10);
    if (!entity_id) return res.status(400).json({ success: false, message: "нужен entity_id" });
    const id = nextId(), now = nowSec();
    const till = parseInt(req.body.complete_till, 10) || (now + 86400);
    db.prepare(`INSERT INTO tasks(id,entity_type,entity_id,text,task_type,complete_till,is_completed,responsible_user_id,result,created_at)
      VALUES(?,?,?,?,?,?,0,?,?,?)`).run(id, entity_type, entity_id, String(req.body.text || "").slice(0, 1000), parseInt(req.body.task_type, 10) || 0, till, parseInt(req.body.responsible_user_id, 10) || 0, "null", now);
    audit(req, entity_type, entity_id, "task_create", { task_id: id, text: req.body.text, complete_till: till });
    res.json({ success: true, id });
  });

  // ── выполнение задачи (с результатом) ──
  app.post(`${E}/task/:id/complete`, guard, (req, res) => {
    const id = parseInt(req.params.id, 10);
    const t = db.prepare("SELECT * FROM tasks WHERE id=?").get(id);
    if (!t) return res.status(404).json({ success: false });
    const result = req.body.result ? { text: String(req.body.result).slice(0, 1000) } : null;
    db.prepare("UPDATE tasks SET is_completed=1, result=? WHERE id=?").run(JSON.stringify(result), id);
    audit(req, t.entity_type, t.entity_id, "task_complete", { task_id: id, result: result && result.text });
    res.json({ success: true });
  });

  // ── правка срока задачи ──
  app.patch(`${E}/task/:id`, guard, (req, res) => {
    const id = parseInt(req.params.id, 10);
    const t = db.prepare("SELECT * FROM tasks WHERE id=?").get(id);
    if (!t) return res.status(404).json({ success: false });
    // правка срока и/или текста/типа (как в amo при редактировании задачи)
    const till = parseInt(req.body.complete_till, 10) || 0;
    const text = req.body.text != null ? String(req.body.text).trim().slice(0, 2000) : null;
    const ttype = req.body.task_type != null ? parseInt(req.body.task_type, 10) || 0 : null;
    if (!till && text === null && ttype === null) return res.status(400).json({ success: false });
    if (till) db.prepare("UPDATE tasks SET complete_till=? WHERE id=?").run(till, id);
    if (text !== null && text) db.prepare("UPDATE tasks SET text=? WHERE id=?").run(text, id);
    if (ttype !== null && ttype) db.prepare("UPDATE tasks SET task_type=? WHERE id=?").run(ttype, id);
    if (till) audit(req, t.entity_type, t.entity_id, "task_reschedule", { task_id: id, complete_till: till });
    if ((text !== null && text) || (ttype !== null && ttype)) audit(req, t.entity_type, t.entity_id, "task_edit", { task_id: id, text: text || undefined, task_type: ttype || undefined });
    res.json({ success: true });
  });

  // ── добавление примечания ──
  app.post(`${E}/note`, guard, (req, res) => {
    const entity_type = ENT3(req.body.entity_type);
    const entity_id = parseInt(req.body.entity_id, 10);
    const text = String(req.body.text || "").trim();
    if (!entity_id || !text) return res.status(400).json({ success: false, message: "нужны entity_id и text" });
    const id = nextId(), now = nowSec();
    db.prepare("INSERT INTO notes_new(id,entity_type,entity_id,text,created_by,created_at) VALUES(?,?,?,?,?,?)").run(id, entity_type, entity_id, text.slice(0, 4000), actorOf(req), now);
    audit(req, entity_type, entity_id, "note_add", { note_id: id });
    res.json({ success: true, id, created_at: now });
  });

  // ── правка/удаление СВОЕГО примечания (только локальные notes_new; примечания слепка amo не трогаем) ──
  app.patch(`${E}/note/:id`, guard, (req, res) => {
    const id = parseInt(req.params.id, 10);
    const n = db.prepare("SELECT * FROM notes_new WHERE id=?").get(id);
    if (!n) return res.status(404).json({ success: false });
    const text = String(req.body.text || "").trim();
    if (!text) return res.status(400).json({ success: false, message: "нужен text" });
    db.prepare("UPDATE notes_new SET text=? WHERE id=?").run(text.slice(0, 4000), id);
    audit(req, n.entity_type, n.entity_id, "note_edit", { note_id: id });
    res.json({ success: true });
  });
  app.post(`${E}/note/:id/delete`, guard, (req, res) => {
    const id = parseInt(req.params.id, 10);
    const n = db.prepare("SELECT * FROM notes_new WHERE id=?").get(id);
    if (!n) return res.status(404).json({ success: false });
    db.prepare("DELETE FROM notes_new WHERE id=?").run(id);
    audit(req, n.entity_type, n.entity_id, "note_delete", { note_id: id });
    res.json({ success: true });
  });

  // ── история изменений сущности ──
  app.get(`${E}/history`, guard, (req, res) => {
    const et = ENT3(req.query.entity_type);
    const eid = parseInt(req.query.entity_id, 10);
    if (!eid) return res.status(400).json({ success: false });
    const rows = db.prepare("SELECT ts,action,detail FROM changelog WHERE entity_type=? AND entity_id=? ORDER BY ts DESC LIMIT 200").all(et, eid);
    res.json({ success: true, items: rows.map((r) => ({ ts: r.ts, action: r.action, detail: JSON.parse(r.detail || "{}") })) });
  });

  // локальные примечания (добавленные в копии) — чтобы карточка их показывала
  app.get(`${E}/notes_new`, guard, (req, res) => {
    const et = ENT3(req.query.entity_type);
    const eid = parseInt(req.query.entity_id, 10);
    if (!eid) return res.status(400).json({ success: false });
    const rows = db.prepare("SELECT id,text,created_by,created_at FROM notes_new WHERE entity_type=? AND entity_id=? ORDER BY created_at DESC").all(et, eid);
    res.json({ success: true, items: rows });
  });

  console.log("amocopy-edit: слой записи активен (/edit-api/*)");
  return true;
};
