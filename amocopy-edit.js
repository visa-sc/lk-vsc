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
  const getStatus = db.prepare("SELECT name FROM statuses WHERE pipeline_id=? AND id=?");
  const uName = {}; db.prepare("SELECT id,name FROM users").all().forEach((u) => { uName[u.id] = u.name; });

  const E = "/edit-api";

  // применение правил автоматизаций при входе сделки на этап
  function applyStageRules(req, leadId, pid, sid) {
    const rules = loadRules().filter((r) => r.pipeline_id === pid && r.status_id === sid);
    const applied = [];
    for (const r of rules) {
      if (r.action === "create_task") {
        const tid = nextId();
        db.prepare(`INSERT INTO tasks(id,entity_type,entity_id,text,task_type,complete_till,is_completed,responsible_user_id,result,created_at)
          VALUES(?,?,?,?,?,?,0,?,?,?)`).run(tid, "leads", leadId, r.text || "", r.task_type || 0, nowSec() + 86400, 0, "null", nowSec());
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
    const applied = applyStageRules(req, id, pid, sid);
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

  // ── правка контакта ──
  app.patch(`${E}/contact/:id`, guard, (req, res) => {
    const id = parseInt(req.params.id, 10);
    const c = getContact.get(id);
    if (!c) return res.status(404).json({ success: false });
    const upd = {}, changes = {};
    if (typeof req.body.name === "string") { upd.name = req.body.name.slice(0, 300); changes.name = [c.name, upd.name]; }
    if (Array.isArray(req.body.phones)) { upd.phones = JSON.stringify(req.body.phones.map(String).filter(Boolean)); changes.phones = JSON.parse(upd.phones); }
    if (Array.isArray(req.body.emails)) { upd.emails = JSON.stringify(req.body.emails.map(String).filter(Boolean)); changes.emails = JSON.parse(upd.emails); }
    if (!Object.keys(upd).length) return res.status(400).json({ success: false });
    upd.updated_at = nowSec();
    const set = Object.keys(upd).map((k) => `${k}=@${k}`).join(", ");
    db.prepare(`UPDATE contacts SET ${set} WHERE id=@id`).run(Object.assign({ id }, upd));
    audit(req, "contacts", id, "edit", changes);
    res.json({ success: true });
  });

  // ── создание задачи ──
  app.post(`${E}/task`, guard, (req, res) => {
    const entity_type = req.body.entity_type === "contacts" ? "contacts" : "leads";
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
    const till = parseInt(req.body.complete_till, 10);
    if (!till) return res.status(400).json({ success: false });
    db.prepare("UPDATE tasks SET complete_till=? WHERE id=?").run(till, id);
    audit(req, t.entity_type, t.entity_id, "task_reschedule", { task_id: id, complete_till: till });
    res.json({ success: true });
  });

  // ── добавление примечания ──
  app.post(`${E}/note`, guard, (req, res) => {
    const entity_type = req.body.entity_type === "contacts" ? "contacts" : "leads";
    const entity_id = parseInt(req.body.entity_id, 10);
    const text = String(req.body.text || "").trim();
    if (!entity_id || !text) return res.status(400).json({ success: false, message: "нужны entity_id и text" });
    const id = nextId(), now = nowSec();
    db.prepare("INSERT INTO notes_new(id,entity_type,entity_id,text,created_by,created_at) VALUES(?,?,?,?,?,?)").run(id, entity_type, entity_id, text.slice(0, 4000), actorOf(req), now);
    audit(req, entity_type, entity_id, "note_add", { note_id: id });
    res.json({ success: true, id, created_at: now });
  });

  // ── история изменений сущности ──
  app.get(`${E}/history`, guard, (req, res) => {
    const et = req.query.entity_type === "contacts" ? "contacts" : "leads";
    const eid = parseInt(req.query.entity_id, 10);
    if (!eid) return res.status(400).json({ success: false });
    const rows = db.prepare("SELECT ts,action,detail FROM changelog WHERE entity_type=? AND entity_id=? ORDER BY ts DESC LIMIT 200").all(et, eid);
    res.json({ success: true, items: rows.map((r) => ({ ts: r.ts, action: r.action, detail: JSON.parse(r.detail || "{}") })) });
  });

  // локальные примечания (добавленные в копии) — чтобы карточка их показывала
  app.get(`${E}/notes_new`, guard, (req, res) => {
    const et = req.query.entity_type === "contacts" ? "contacts" : "leads";
    const eid = parseInt(req.query.entity_id, 10);
    if (!eid) return res.status(400).json({ success: false });
    const rows = db.prepare("SELECT id,text,created_by,created_at FROM notes_new WHERE entity_type=? AND entity_id=? ORDER BY created_at DESC").all(et, eid);
    res.json({ success: true, items: rows });
  });

  console.log("amocopy-edit: слой записи активен (/edit-api/*)");
  return true;
};
