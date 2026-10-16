#!/usr/bin/env node
/* ─────────────────────────────────────────────────────────────────────────────
 * spbReturnVisits — «клиент из CRM зашёл на сайт и не связался» (просьба Андрея 06.10.2026).
 *
 * Каждый посетитель spb.visa-sc.ru помечен куки spb_vid (год). Когда он оставляет заявку
 * или звонит по клику на номер, метка связывается с контактом amoCRM (leads.json → amo,
 * calls.json → contactId). Если такой человек потом снова заходит на сайт, а за визит и
 * 30 минут после него не оставил заявку и не позвонил, — менеджеру нужна задача:
 * «заходил на сайт, позвонить, узнать, что хотел».
 *
 * «Связался» проверяем широко, чтобы не дёргать менеджера зря:
 *   • заявка с сайта (по метке, контакту или телефону);
 *   • звонок на питерские номера (calls.json) от этого контакта;
 *   • входящий звонок в amo на любой номер (amo_notes call_in) или новая сделка контакта
 *     (локальная копия CRM, crm.db) — с 10 минут до визита по 60 минут после.
 * Одному контакту — не чаще одной задачи в сутки.
 *
 * РЕЖИМ. Без SPB_RETURN_TASKS=1 в .env и флага --live — ТЕСТ: в amo НИЧЕГО не пишется, случаи
 * складываются в /var/www/spbcopy/stat/return-visits.json (их показывает аналитика сайта,
 * «Вернувшиеся клиенты»). С 06.10.2026 включено (решение Андрея): задача на контакт (с 16.10.2026 тип «Посещение сайта», RETURN_TASK_TYPE),
 * ответственная — Ксения Маслова (SPB_RETURN_RESPONSIBLE, по умолчанию 1605012). Выключить —
 * убрать SPB_RETURN_TASKS=1 из .env. Бережём amo: 1 запрос в 1,1 с, не больше 5 задач за прогон
 * и 30 в сутки, при 429/403 — стоп; удалённые контакты и уже открытые такие задачи — пропуск.
 *
 * SMS (просьба Андрея 14.10.2026). Тем же «не связался» — SMS клиенту на мобильный из CRM
 * (SMS.ru, отправитель visa-sc.ru). Включается ДВУМЯ строками в /var/www/voyo/.env:
 * SPB_RETURN_SMS=1 и SPB_RETURN_SMS_TEXT=<текст>; пока их нет — ничего не шлём, только
 * пишем, кому ушло бы («нет текста»). Бережём клиента: одному контакту не чаще раза в
 * SPB_RETURN_SMS_DAYS (30) дней, только 09:00–21:00 МСК (вечерний визит — SMS утром, если
 * он к тому времени сам не связался, и не позже 14 ч после визита), не больше 20 за прогон
 * и SPB_RETURN_SMS_MAX_DAY (100) в сутки. Цена — по ответу SMS.ru /sms/cost перед отправкой.
 * Выручка SMS: ПЕРВАЯ сделка контакта после SMS — новая (создана в течение 45 дней) или уже
 * открытая, успешно закрытая в эти 45 дней; её сумма, когда сделка успешна (статус 142).
 * Следующие покупки этого клиента в SMS не идут. Всё — в stat/sms.json, его читает аналитика
 * сайта (строка «SMS» в «Каналах трафика»).
 *
 * Москва (заготовка 14.10.2026, включить после переноса visa-sc.ru): тот же скрипт с
 * RETURN_PREFIX=MSK_RETURN SITE_NAME=visa-sc.ru SPBCOPY_STAT=/var/www/mskcopy/stat
 * SPBCOPY_LEADS=/var/www/mskcopy/leads.json — настройки MSK_RETURN_SMS / _SMS_TEXT / _TASKS.
 * Лимит «раз в 30 дней» общий для обоих сайтов (читаем sms.json обоих).
 *
 * ЗАМЕР ДЛЯ КАТИ ЗАЙЦЕВОЙ (16.10.2026, её ТЗ, решение Андрея «сделай всё, как Катя говорит»):
 *   • ответственный — менеджер из поля «Менеджер ОП» последней успешной сделки клиента;
 *     уволен по «Графику» Кати (data/grafik/employees.json, active:false) или сделки нет —
 *     Ксения Маслова;
 *   • группы закрепляются за контактом навсегда: «контроль» (20 %, случайно — ни задачи,
 *     ни SMS), остальные через одного — «задача+SMS» и «задача» (без SMS);
 *   • первая новая сделка контакта в 30 дней после визита получает тег «Сигнал с сайта»
 *     (у контроля — «Сигнал с сайта: контроль»), первый звонок и дозвон тоже пишутся;
 *   • выгрузка для Кати — /var/www/kateadmin/data/site-visits/<spb|msk>-visits.json и .csv.
 * Настройки — у Кати: /var/www/kateadmin/data/site-visits/settings.json (её Claude правит сам,
 * значения проверяются и обрезаются по границам ниже). Главные выключатели остаются в .env
 * (<PFX>_TASKS, <PFX>_SMS): её файл может выключить, но не включить сверх них.
 *
 * Запуск: node tools/spbReturnVisits.js [--live]   cron: каждые 10 минут (тест).
 * ───────────────────────────────────────────────────────────────────────────── */
"use strict";
const fs = require("fs");
const path = require("path");
require("dotenv").config({ path: "/var/www/voyo/.env", quiet: true });

const STAT = process.env.SPBCOPY_STAT || "/var/www/spbcopy/stat";
const LEADS = process.env.SPBCOPY_LEADS || "/var/www/spbcopy/leads.json";
const OUT = path.join(STAT, "return-visits.json");
const DB_PATH = process.env.AMOCOPY_DB || "/var/www/voyo/.amocopy-db/crm.db";
const SQLITE = process.env.SQLITE_MODULE || "/var/www/voyo/crm-svc/node_modules/better-sqlite3";
const PFX = process.env.RETURN_PREFIX || "SPB_RETURN";            // SPB_RETURN | MSK_RETURN
const SITE_KEY = PFX === "MSK_RETURN" ? "msk" : "spb";

// Настройки Кати: common, поверх — spb / msk. Чего нет или что за границами — берём своё.
const KATE_DIR = process.env.RETURN_KATE_DIR || "/var/www/kateadmin/data/site-visits";
const CFG = (() => {
  let f = {};
  try { f = JSON.parse(fs.readFileSync(path.join(KATE_DIR, "settings.json"), "utf8")); } catch (_) {}
  const c = Object.assign({}, f.common || {}, f[SITE_KEY] || {});
  const num = (k, def, lo, hi) => { const v = Number(c[k]); return c[k] == null || c[k] === "" || !isFinite(v) ? def : Math.min(hi, Math.max(lo, v)); };
  const str = (k, def, max) => (typeof c[k] === "string" && c[k].trim() ? c[k].trim().slice(0, max) : def);
  return {
    tasks: c.tasks !== false, sms: c.sms !== false,
    // тип задачи: «Посещение сайта» (4391573, завела Катя 16.10.2026); без настройки — из .env, иначе 1 «Связаться»
    taskType: num("taskType", Number(process.env[PFX + "_TASK_TYPE"] || process.env.RETURN_TASK_TYPE || 1), 1, 1e9),
    fallbackResponsible: num("fallbackResponsible", Number(process.env.SPB_RETURN_RESPONSIBLE || 1605012), 1, 1e9), // Ксения Маслова
    managerField: str("managerField", "Менеджер ОП", 80),
    controlShare: num("controlShare", 0.2, 0, 0.9),
    smsSplit: ["через одного", "всем", "никому"].includes(c.smsSplit) ? c.smsSplit : "через одного",
    smsText: str("smsText", "", 160),
    smsEveryDays: num("smsEveryDays", Number(process.env[PFX + "_SMS_DAYS"] || 30), 7, 365),
    smsMaxDay: num("smsMaxDay", Number(process.env[PFX + "_SMS_MAX_DAY"] || 100), 0, 300),
    taskMaxRun: num("taskMaxRun", 5, 0, 20), taskMaxDay: num("taskMaxDay", 30, 0, 100),
    perContactHours: num("perContactHours", 24, 1, 24 * 30),
    quietMinutes: num("quietMinutes", 30, 10, 180),
    workFrom: num("workFrom", 10, 0, 23), workTo: num("workTo", 18, 1, 24),
    dueInWorkMinutes: num("dueInWorkMinutes", 60, 10, 24 * 60), dueNextDayHour: num("dueNextDayHour", 11, 0, 23),
    taskText: str("taskText", "", 1000),
    dealTag: str("dealTag", "Сигнал с сайта", 60), controlDealTag: str("controlDealTag", "Сигнал с сайта: контроль", 60),
    dealWindowDays: num("dealWindowDays", 30, 1, 90), callWindowDays: num("callWindowDays", 14, 1, 60)
  };
})();

const LIVE = process.argv.includes("--live") && process.env[PFX + "_TASKS"] === "1" && CFG.tasks;
const SESSION_GAP = 30 * 60e3; // пауза, после которой визит считается законченным
const QUIET = CFG.quietMinutes * 60e3; // ждём после визита: вдруг позвонит или оставит заявку
const PER_CONTACT = CFG.perContactHours * 3600e3; // не чаще одной задачи на контакт в сутки
const SITE = process.env.SITE_NAME || "spb.visa-sc.ru";
const RESPONSIBLE = CFG.fallbackResponsible; // запасной ответственный — Ксения Маслова
const MAX_RUN = CFG.taskMaxRun, MAX_DAY = CFG.taskMaxDay;
const TASK_TYPE = CFG.taskType;
const SMS_OUT = path.join(STAT, "sms.json");
const SMS_TEXT = CFG.smsText || String(process.env[PFX + "_SMS_TEXT"] || "").trim();
const SMS_ON = process.argv.includes("--live") && process.env[PFX + "_SMS"] === "1" && CFG.sms && !!SMS_TEXT;
const SMS_EVERY = CFG.smsEveryDays * 86400e3;
const SMS_MAX_RUN = 20, SMS_MAX_DAY = CFG.smsMaxDay;
const GROUP_CONTROL = "контроль", GROUP_SMS = "задача+SMS", GROUP_TASK = "задача без SMS";
// журналы SMS обоих сайтов — чтобы один человек не получил две SMS (Питер и Москва) за 30 дней
const SMS_ALL = ["/var/www/spbcopy/stat/sms.json", "/var/www/mskcopy/stat/sms.json"];
const SMS_ATTR = 45 * 86400e3; // окно, в котором первая сделка после SMS засчитывается SMS (Андрей 14.10: 45 дней)
const mskHour = (ms) => new Date(ms + 3 * 3600e3).getUTCHours();

const readJson = (f, d) => {
  try {
    return JSON.parse(fs.readFileSync(f, "utf8"));
  } catch (_) {
    return d;
  }
};
const readLines = (kind) => {
  const out = [];
  for (const f of fs.readdirSync(STAT).filter((x) => x.startsWith(kind + "-") && x.endsWith(".jsonl")).sort().slice(-3))
    for (const l of fs.readFileSync(path.join(STAT, f), "utf8").split("\n")) if (l.trim()) try { out.push(JSON.parse(l)); } catch (_) {}
  return out;
};
const digits = (s) => String(s || "").replace(/\D/g, "").slice(-10);
const mskStr = (ms) => new Date(ms + 3 * 3600e3).toISOString().slice(0, 16).replace("T", " ");

// Выгрузка для Кати (её ТЗ 16.10.2026): каждый сигнал — визит, группа, задача, SMS, звонок, сделка.
// Копится по ключу визита 400 дней (рабочий журнал держит только 60). Плюс status-<сайт>.json —
// как всё настроено прямо сейчас: по нему Катин Claude отвечает «как это работает».
function exportForKate(items, out, mobileOf) {
  if (!fs.existsSync(KATE_DIR)) return;
  const own = (f) => { try { const st = fs.statSync(KATE_DIR); fs.chownSync(f, st.uid, st.gid); } catch (_) {} };
  const put = (name, text) => { const f = path.join(KATE_DIR, name); fs.writeFileSync(f + ".tmp", text); fs.renameSync(f + ".tmp", f); own(f); };
  const iso = (ms) => (ms ? mskStr(ms) : "");
  const fJson = path.join(KATE_DIR, SITE_KEY + "-visits.json");
  const old = readJson(fJson, { rows: [] }).rows || [];
  const byKey = new Map(old.map((r) => [r.key, r]));
  for (const it of items) {
    if (!["задача", "контроль"].includes(it.decision) && typeof it.taskId !== "number" && !/^задача/.test(it.decision)) continue;
    const { phones, mobile } = mobileOf(it.contactId);
    const c = it.call || {}, d = it.deal || {};
    byKey.set(it.key, {
      key: it.key, site: SITE, group: it.group || "", decision: it.decision, mode: it.mode,
      visitStart: iso(it.start), visitEnd: iso(it.end), pages: it.pages || [], source: it.source || "",
      contactId: it.contactId, contactName: it.contactName || "", phone: mobile ? "+" + mobile : (phones[0] ? "+7" + phones[0] : ""),
      contactUrl: `https://${(process.env.AMO_SUBDOMAIN || "").replace(/^https?:\/\//, "").replace(/\..*/, "")}.amocrm.ru/contacts/detail/${it.contactId}`,
      taskId: typeof it.taskId === "number" ? it.taskId : null, taskError: typeof it.taskId === "string" ? it.taskId : "",
      taskAt: iso(it.taskAt), taskDue: iso(it.taskDue), taskType: it.taskType || null,
      responsibleId: it.responsibleId || null, responsible: it.responsible || "", responsibleWhy: it.responsibleWhy || "",
      smsSent: !!(it.sms && it.sms.status === "отправлено"), smsAt: it.sms && it.sms.status === "отправлено" ? iso(it.sms.at) : "",
      smsStatus: (it.sms && it.sms.status) || "",
      firstCallAt: iso(c.firstAt), firstCallDir: c.firstDir || "", firstOutCallAt: iso(c.firstOutAt),
      talkAt: iso(c.talkAt), talkDir: c.talkDir || "", talkSec: c.talkSec || 0,
      minutesVisitToTalk: c.talkAt ? Math.round((c.talkAt - it.end) / 60e3) : null,
      dealId: d.id || null, dealCreatedAt: iso(d.createdAt), dealStatusId: d.statusId || null,
      dealWon: !!d.won, dealLost: !!d.lost, dealPrice: d.price || 0, dealClosedAt: iso(d.closedAt), dealTag: d.tagged || "",
      updatedAt: iso(Date.now())
    });
  }
  const rows = [...byKey.values()].filter((r) => Date.now() - Date.parse(r.visitEnd.replace(" ", "T") + ":00+03:00") < 400 * 86400e3)
    .sort((x, y) => (x.visitStart < y.visitStart ? -1 : 1));
  put(SITE_KEY + "-visits.json", JSON.stringify({ builtAt: out.builtAt, site: SITE, rows }, null, 1));
  const cols = ["visitStart", "visitEnd", "site", "group", "decision", "contactId", "contactName", "phone", "contactUrl", "taskId", "taskAt", "taskDue",
    "taskType", "responsible", "responsibleWhy", "smsSent", "smsAt", "firstCallAt", "firstCallDir", "talkAt", "talkDir", "talkSec",
    "minutesVisitToTalk", "dealId", "dealCreatedAt", "dealStatusId", "dealWon", "dealPrice", "dealClosedAt", "dealTag", "source", "pages", "mode", "key"];
  const cell = (v) => { const t = Array.isArray(v) ? v.join(" ") : v == null ? "" : String(v); return /[";\n]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t; };
  put(SITE_KEY + "-visits.csv", "\ufeff" + [cols.join(";")].concat(rows.map((r) => cols.map((k) => cell(r[k])).join(";"))).join("\n"));
  put("code-spbReturnVisits.js.txt", fs.readFileSync(__filename, "utf8"));   // копия кода — Катиному Claude для чтения
  const cnt = {};
  for (const r of rows) cnt[r.group || "без группы (до 16.10)"] = (cnt[r.group || "без группы (до 16.10)"] || 0) + 1;
  put("status-" + SITE_KEY + ".json", JSON.stringify({
    builtAt: out.builtAt, site: SITE, mode: out.mode,
    switches: {
      tasksEnv: process.env[PFX + "_TASKS"] === "1", tasksKate: CFG.tasks, tasksWorking: LIVE,
      smsEnv: process.env[PFX + "_SMS"] === "1", smsKate: CFG.sms, smsWorking: SMS_ON,
      note: "Работает, только если включено И в .env Андрея, И в settings.json Кати. Москва — после переноса visa-sc.ru."
    },
    effectiveSettings: Object.assign({}, CFG, { smsText: SMS_TEXT }),
    knownVisitors: out.knownVisitors, rowsByGroup: cnt, contactsInGroups: Object.keys(out.groups || {}).length
  }, null, 1));
}

(async () => {
  const now = Date.now();
  const leads = readJson(LEADS, []).filter((e) => e.host && e.host !== "flexbe-archive" && !/voyotravel\.ru$/.test(e.host));
  const calls = (readJson(path.join(STAT, "calls.json"), {}).calls || []);
  const visits = readLines("visits");
  const events = readLines("events");

  // 1. какие метки (vid) кому принадлежат: заявка или звонок, связанные с контактом amo
  const known = new Map(); // vid → { contact, since, how }
  const remember = (vid, contact, at, how) => {
    if (!vid || !contact) return;
    const t = Date.parse(at);
    const k = known.get(vid);
    if (!k || t < k.since) known.set(vid, { contact: Number(contact), since: t, how });
  };
  for (const l of leads) {
    const contact = (l.amo && l.amo.contactId) || (l.crm && l.crm.contactId);
    let vid = l.vid || "";
    if (!vid) {
      const e = events.find((x) => x.type === "form_submit" && x.page === l.pageUrl && Math.abs(Date.parse(x.at) - Date.parse(l.at)) < 3 * 60e3);
      if (e) vid = e.vid;
    }
    remember(vid, contact, l.at, "заявка #" + l.id);
  }
  for (const c of calls) remember(c.source && c.source.vid, c.contactId, c.at, "звонок по клику на номер");

  // 2. визиты этих людей, разбитые на посещения (пауза 30 минут)
  const byVid = new Map();
  for (const v of visits) if (known.has(v.vid)) (byVid.get(v.vid) || byVid.set(v.vid, []).get(v.vid)).push(v);
  const sessions = [];
  for (const [vid, list] of byVid) {
    list.sort((a, b) => (a.at < b.at ? -1 : 1));
    let cur = null;
    for (const v of list) {
      const t = Date.parse(v.at);
      if (!cur || t - cur.end > SESSION_GAP) {
        cur = { vid, start: t, end: t, pages: [], first: v };
        sessions.push(cur);
      }
      cur.end = t;
      if (cur.pages[cur.pages.length - 1] !== v.page) cur.pages.push(v.page);
    }
  }

  // 3. CRM: имя, ответственный, звонки и новые сделки контакта рядом с визитом
  const Database = require(SQLITE);
  const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
  db.pragma("busy_timeout = 5000");
  const qContact = db.prepare("SELECT id, name, responsible_user_id, phones FROM contacts WHERE id = ?");
  const qUser = db.prepare("SELECT name FROM users WHERE id = ?");
  const qCallIn = db.prepare("SELECT count(*) n FROM amo_notes WHERE entity_type = 'contacts' AND entity_id = ? AND note_type = 'call_in' AND created_at BETWEEN ? AND ?");
  const qCallInLead = db.prepare("SELECT count(*) n FROM amo_notes n JOIN lead_contacts lc ON lc.lead_id = n.entity_id WHERE n.entity_type = 'leads' AND lc.contact_id = ? AND n.note_type = 'call_in' AND n.created_at BETWEEN ? AND ?");
  const qNewLead = db.prepare("SELECT count(*) n FROM lead_contacts lc JOIN leads l ON l.id = lc.lead_id WHERE lc.contact_id = ? AND l.created_at BETWEEN ? AND ?");
  const qOpenTask = db.prepare("SELECT count(*) n FROM tasks WHERE entity_type = 'contacts' AND entity_id = ? AND is_completed = 0");
  const qOurTask = db.prepare("SELECT count(*) n FROM tasks WHERE entity_type = 'contacts' AND entity_id = ? AND is_completed = 0 AND text LIKE '%на сайт%не позвонил%'");
  const respName = (qUser.get(RESPONSIBLE) || {}).name || "";
  // Ответственный (ТЗ Кати): «Менеджер ОП» последней успешной сделки клиента, если он работает
  // по «Графику» Кати; иначе запасной (Маслова). why — пояснение для выгрузки.
  const norm = (s) => String(s || "").toLowerCase().replace(/ё/g, "е").replace(/\s+/g, " ").trim();
  const grafik = readJson("/var/www/kateadmin/data/grafik/employees.json", { list: [] }).list || [];
  const crmUsers = db.prepare("SELECT id, name, email FROM users").all();
  const fieldId = (db.prepare("SELECT id FROM cf_defs WHERE entity = 'leads' AND name = ?").get(CFG.managerField) || {}).id;
  const qWon = db.prepare("SELECT l.id, l.cf, l.closed_at FROM leads l JOIN lead_contacts lc ON lc.lead_id = l.id WHERE lc.contact_id = ? AND l.status_id = 142 ORDER BY l.closed_at DESC LIMIT 20");
  const managerFor = (contactId) => {
    const fb = (why) => ({ id: RESPONSIBLE, name: respName, why });
    if (!fieldId) return fb("поля «" + CFG.managerField + "» нет в amo");
    const deals = qWon.all(contactId);
    if (!deals.length) return fb("у клиента нет успешных сделок");
    for (const d of deals) {
      let cf = [];
      try { cf = JSON.parse(d.cf || "[]"); } catch (_) {}
      const f = cf.find((x) => x.field_id === fieldId);
      const name = f && f.values && f.values[0] && f.values[0].value;
      if (!name) continue;
      const u = crmUsers.find((x) => norm(x.name) === norm(name));
      if (!u) return fb(`${name} (сделка ${d.id}) — нет среди пользователей amo`);
      const e = grafik.find((x) => norm(x.name) === norm(name)) || grafik.find((x) => u.email && norm(x.email) === norm(u.email));
      if (!e) return fb(`${name} (сделка ${d.id}) — нет в «Графике»`);
      if (e.active === false) return fb(`${name} (сделка ${d.id}) — уволен(а) по «Графику»`);
      return { id: u.id, name: u.name, why: `менеджер ОП сделки ${d.id}`, dealId: d.id };
    }
    return fb("в успешных сделках не заполнено «" + CFG.managerField + "»");
  };
  // Связался ли клиент сам между from и to (мс): заявка, звонок на питерский номер,
  // входящий звонок или новая сделка в amo. Нужна и для задач, и перед отправкой SMS.
  const contactedWhy = (contactId, phones, vid, from, to) => {
    const why = [];
    if (leads.some((l) => Date.parse(l.at) >= from && Date.parse(l.at) <= to && ((vid && l.vid === vid) || Number((l.amo && l.amo.contactId) || 0) === contactId || phones.includes(digits(((l.data && l.data.fields) || []).map((f) => (f.type === "phone" ? f.value : "")).join(""))))))
      why.push("оставил заявку на сайте");
    if (calls.some((x) => Number(x.contactId) === contactId && Date.parse(x.at) >= from && Date.parse(x.at) <= to)) why.push("звонил на питерский номер");
    const fs_ = Math.floor(from / 1000), ts_ = Math.floor(to / 1000);
    if (qCallIn.get(contactId, fs_, ts_).n + qCallInLead.get(contactId, fs_, ts_).n) why.push("входящий звонок в amo");
    if (qNewLead.get(contactId, fs_, ts_).n) why.push("новая сделка в amo");
    return why;
  };

  const prev = readJson(OUT, { items: [], done: {} });
  const done = prev.done || {};
  const items = prev.items || [];
  // Группа замера закрепляется за контактом при первом его «задачном» визите и больше не меняется:
  // иначе один человек попадёт и в контроль, и в обработку, и сравнение потеряет смысл.
  const groups = prev.groups || {};          // contactId → { g, at }
  let groupSeq = Number(prev.groupSeq || 0); // счётчик «через одного» среди не-контроля
  const groupFor = (contactId) => {
    if (groups[contactId]) return groups[contactId].g;
    let g;
    if (Math.random() < CFG.controlShare) g = GROUP_CONTROL;
    else if (CFG.smsSplit === "всем") g = GROUP_SMS;
    else if (CFG.smsSplit === "никому") g = GROUP_TASK;
    else g = groupSeq++ % 2 === 0 ? GROUP_SMS : GROUP_TASK;
    groups[contactId] = { g, at: Date.now() };
    return g;
  };
  const lastTaskAt = new Map();
  for (const it of items) if (it.decision === "задача" || it.decision === "контроль") lastTaskAt.set(it.contactId, Math.max(lastTaskAt.get(it.contactId) || 0, it.end));

  let added = 0;
  for (const s of sessions.sort((a, b) => a.start - b.start)) {
    const key = s.vid + "|" + s.start;
    if (done[key]) continue;
    if (now - s.end < QUIET) continue; // визит ещё идёт или не прошло 30 минут
    const k = known.get(s.vid);
    if (s.start < k.since + 5 * 60e3) {
      done[key] = 1; // это тот самый визит, в котором он оставил заявку/позвонил
      continue;
    }
    const found = qContact.get(k.contact);
    const c = found || { id: k.contact, name: "", responsible_user_id: 0, phones: "" };
    const phones = String(c.phones || "").split(/[,;\s]+/).map(digits).filter((x) => x.length === 10);
    const from = s.start - 10 * 60e3, to = s.end + 60 * 60e3;
    const why = contactedWhy(k.contact, phones, s.vid, from, to);
    const recent = lastTaskAt.get(k.contact);
    let decision = "задача";
    if (!found) decision = "контакта нет в CRM (удалён)";
    else if (why.length) decision = "связался: " + why.join(", ");
    else if (recent && s.start - recent < PER_CONTACT) decision = "уже была задача за сутки";
    else if (qOurTask.get(k.contact).n) decision = "уже есть открытая такая задача";
    // группа замера — только у тех, кто прошёл все фильтры (иначе контроль и обработка несравнимы)
    let group = found && groups[k.contact] ? groups[k.contact].g : "";
    if (decision === "задача") {
      group = groupFor(k.contact);
      if (group === GROUP_CONTROL) decision = "контроль";
    }
    const src = s.first.utm && s.first.utm.utm_term ? "Директ «" + s.first.utm.utm_term + "»" : s.first.channel || "прямой заход";
    const mgr = decision === "задача" ? managerFor(k.contact) : { id: null, name: "", why: "" };
    const when = `${mskStr(s.start)}${s.end - s.start > 60e3 ? "–" + mskStr(s.end).slice(11) : ""}`;
    const pagesTxt = `${s.pages.slice(0, 4).join(", ")}${s.pages.length > 4 ? " и ещё " + (s.pages.length - 4) : ""}`;
    const item = {
      key, vid: s.vid, contactId: k.contact, contactName: c.name || "", group,
      responsibleId: mgr.id, responsible: mgr.name, responsibleWhy: mgr.why,
      contactOwner: (c.responsible_user_id && (qUser.get(c.responsible_user_id) || {}).name) || "",
      knownBy: k.how, start: s.start, end: s.end, pages: s.pages.slice(0, 12), source: src,
      openTasks: qOpenTask.get(k.contact).n, decision, mode: LIVE ? "боевой" : "тест", taskId: null,
      text: CFG.taskText
        ? CFG.taskText.replace(/\{site\}/g, SITE).replace(/\{when\}/g, when).replace(/\{pages\}/g, pagesTxt).replace(/\{source\}/g, src)
        : `Клиент зашёл на сайт ${SITE} ${when} МСК, но не позвонил и не оставил заявку — связаться, узнать, что хотел.` +
          ` Смотрел: ${pagesTxt}. Источник: ${src}.`
    };
    items.push(item);
    done[key] = 1;
    added++;
    if (decision === "задача" || decision === "контроль") lastTaskAt.set(k.contact, s.end); // контролю — то же правило «раз в сутки»
  }

  // 3b. SMS тем, кто не связался (см. шапку). Без SPB_RETURN_SMS=1 и текста — только запись.
  const smsStore = readJson(SMS_OUT, { sends: [] });
  const sends = smsStore.sends || [];
  const lastSms = new Map();
  for (const f of new Set(SMS_ALL.concat([SMS_OUT])))
    for (const x of (f === SMS_OUT ? sends : (readJson(f, { sends: [] }).sends || [])))
      lastSms.set(x.contactId, Math.max(lastSms.get(x.contactId) || 0, x.at));
  const saveSms = () => {
    fs.writeFileSync(SMS_OUT + ".tmp", JSON.stringify(Object.assign({}, readJson(SMS_OUT, {}), { sends })));
    fs.renameSync(SMS_OUT + ".tmp", SMS_OUT);
  };
  const qPhones = db.prepare("SELECT phones FROM contacts WHERE id = ?");
  const mobileOf = (contactId) => {
    const ph = String((qPhones.get(contactId) || {}).phones || "").split(/[,;\s]+/).map(digits).filter((x) => x.length === 10);
    const m = ph.find((x) => x[0] === "9");
    return { phones: ph, mobile: m ? "7" + m : "" };
  };
  const smsRu = SMS_ON ? require("/var/www/voyo/sms.js") : null;
  const axiosS = SMS_ON ? require("axios") : null;
  const sentDay = sends.filter((x) => now - x.at < 86400e3).length;
  let smsRun = 0;
  const hourNow = mskHour(now), dayTime = hourNow >= 9 && hourNow < 21;
  for (const it of items) {
    if (it.sms && it.sms.final) continue;
    if (!/^задача|^уже /.test(it.decision)) continue;            // связался сам, контроль или контакта нет — не пишем
    if (it.group === GROUP_TASK || it.group === GROUP_CONTROL) {  // замер Кати: SMS только группе «задача+SMS»
      it.sms = { status: "не положена: группа «" + it.group + "»", at: now, final: true };
      continue;
    }
    const he = mskHour(it.end), maxAge = (he >= 20 || he < 9) ? 14 * 3600e3 : 3 * 3600e3;
    if (now - it.end > maxAge) { if (!it.sms) it.sms = { status: "не отправлено: визит давно", final: true }; else it.sms.final = true; continue; }
    const { phones, mobile } = mobileOf(it.contactId);
    const mark = (status, extra) => { it.sms = Object.assign({ status, at: now }, extra || {}); };
    if (!mobile) { mark("нет мобильного номера", { final: true }); continue; }
    const masked = "+7 " + mobile.slice(1, 4) + " ***-**-" + mobile.slice(-2);
    const prevSms = lastSms.get(it.contactId);
    if (prevSms && now - prevSms < SMS_EVERY) { mark("уже была SMS за " + Math.round(SMS_EVERY / 86400e3) + " дней", { final: true }); continue; }
    const why = contactedWhy(it.contactId, phones, it.vid, it.start - 10 * 60e3, now);
    if (why.length) { mark("не нужна: " + why.join(", "), { final: true }); continue; }
    if (!SMS_ON) { mark(SMS_TEXT ? "выключено (" + PFX + "_SMS)" : "нет текста — ушла бы", { phone: masked }); continue; }
    if (!dayTime) { mark("ждёт 09:00 МСК", { phone: masked }); continue; }
    if (smsRun >= SMS_MAX_RUN || sentDay + smsRun >= SMS_MAX_DAY) { mark("ждёт: лимит", { phone: masked }); continue; }
    let cost = null;
    try {
      const c = await axiosS.get("https://sms.ru/sms/cost", { params: { api_id: process.env.SMS_RU_API_ID, to: mobile, msg: SMS_TEXT, json: 1 }, timeout: 15000 });
      cost = c.data && c.data.total_cost != null ? Number(c.data.total_cost) : null;
    } catch (_) {}
    const r = await smsRu.sendMessage(mobile, SMS_TEXT);
    const smsId = r.raw && r.raw.sms && r.raw.sms[mobile] && r.raw.sms[mobile].sms_id;
    if (r.ok) {
      smsRun++;
      lastSms.set(it.contactId, now);
      mark("отправлено", { phone: masked, smsId, cost, final: true });
      sends.push({ key: it.key, contactId: it.contactId, contactName: it.contactName, phone: masked, at: now, smsId, cost: cost || 0, text: SMS_TEXT, test: !!r.testMode });
      saveSms();   // сразу на диск: упади прогон дальше — повторной SMS не будет
    } else {
      mark("ошибка: " + (r.error || r.smsStatus || "SMS.ru"), { phone: masked });
    }
  }

  // 3c. выручка после SMS: первая сделка контакта в 45 дней после SMS (новая или закрытая успешно)
  const qDealsAfter = db.prepare("SELECT l.id, l.name, l.price, l.status_id, l.created_at, l.closed_at FROM leads l JOIN lead_contacts lc ON lc.lead_id = l.id WHERE lc.contact_id = ? AND ((l.created_at BETWEEN ? AND ?) OR (l.status_id = 142 AND l.closed_at BETWEEN ? AND ?))");
  for (const x of sends) {
    if (x.dealFinal) continue;
    const a = Math.floor(x.at / 1000), b = Math.floor((x.at + SMS_ATTR) / 1000);
    const deals = qDealsAfter.all(x.contactId, a, b, a, b)
      .map((d) => ({ ...d, evt: d.created_at >= a ? d.created_at : d.closed_at }))
      .sort((p_, q_) => p_.evt - q_.evt);
    const d = x.dealId ? deals.find((z) => z.id === x.dealId) || deals[0] : deals[0];
    if (d) {
      x.dealId = d.id; x.dealName = d.name || ""; x.convAt = d.evt * 1000;
      x.won = d.status_id === 142; x.revenue = x.won ? Number(d.price) || 0 : 0;
      if (d.status_id === 142 || d.status_id === 143) x.dealFinal = true;   // сделка закрыта — итог не меняется
    } else if (now - x.at > SMS_ATTR) x.dealFinal = true;                    // 45 дней прошло — обращения нет
  }
  const smsOut = {
    builtAt: new Date().toISOString(), enabled: SMS_ON, textSet: !!SMS_TEXT, text: SMS_TEXT,
    rules: { everyDays: SMS_EVERY / 86400e3, hours: "09–21 МСК", maxDay: SMS_MAX_DAY, attrDays: SMS_ATTR / 86400e3 },
    sends: sends.filter((x) => now - x.at < 400 * 86400e3)
  };
  fs.writeFileSync(SMS_OUT + ".tmp", JSON.stringify(smsOut));
  fs.renameSync(SMS_OUT + ".tmp", SMS_OUT);
  try { const st = fs.statSync(STAT); fs.chownSync(SMS_OUT, st.uid, st.gid); } catch (_) {}

  // 3d. замер (ТЗ Кати): первый звонок/дозвон и первая новая сделка контакта после визита —
  // одинаково для обработанных и контроля, по локальной копии CRM
  const qCalls = db.prepare(`SELECT n.note_type, n.params, n.created_at FROM amo_notes n
    WHERE n.note_type IN ('call_in','call_out') AND n.created_at BETWEEN ? AND ? AND (
      (n.entity_type = 'contacts' AND n.entity_id = ?) OR
      (n.entity_type = 'leads' AND n.entity_id IN (SELECT lead_id FROM lead_contacts WHERE contact_id = ?)))
    ORDER BY n.created_at`);
  const qFirstDeal = db.prepare("SELECT l.id, l.name, l.price, l.status_id, l.pipeline_id, l.created_at, l.closed_at, l.tags FROM leads l JOIN lead_contacts lc ON lc.lead_id = l.id WHERE lc.contact_id = ? AND l.created_at BETWEEN ? AND ? ORDER BY l.created_at LIMIT 1");
  const qDeal = db.prepare("SELECT id, name, price, status_id, created_at, closed_at, tags FROM leads WHERE id = ?");
  for (const it of items) {
    if (it.decision !== "контроль" && it.decision !== "задача" && typeof it.taskId !== "number") continue;
    const a = Math.floor(it.end / 1000);
    if (!it.call || !it.call.talkAt) {
      const calls_ = qCalls.all(a, a + CFG.callWindowDays * 86400, it.contactId, it.contactId);
      const dur = (x) => { try { return Number(JSON.parse(x.params || "{}").duration) || 0; } catch (_) { return 0; } };
      const first = calls_[0], talk = calls_.find((x) => dur(x) > 0), out_ = calls_.find((x) => x.note_type === "call_out");
      it.call = {
        firstAt: first ? first.created_at * 1000 : null, firstDir: first ? (first.note_type === "call_out" ? "исходящий" : "входящий") : "",
        firstOutAt: out_ ? out_.created_at * 1000 : null,
        talkAt: talk ? talk.created_at * 1000 : null, talkDir: talk ? (talk.note_type === "call_out" ? "исходящий" : "входящий") : "",
        talkSec: talk ? dur(talk) : 0
      };
    }
    if (!it.deal) {
      const d = qFirstDeal.get(it.contactId, a, a + CFG.dealWindowDays * 86400);
      if (d) it.deal = { id: d.id };
    }
    if (it.deal && !it.deal.final) {
      const d = qDeal.get(it.deal.id);
      if (d) Object.assign(it.deal, { name: d.name || "", createdAt: d.created_at * 1000, statusId: d.status_id,
        won: d.status_id === 142, lost: d.status_id === 143, price: Number(d.price) || 0, closedAt: d.closed_at ? d.closed_at * 1000 : null,
        final: d.status_id === 142 || d.status_id === 143 });
    }
  }

  // 4. (выключено) постановка задач в amo — только SPB_RETURN_TASKS=1 и --live
  if (LIVE) {
    const axios = require("axios");
    const SUB = (process.env.AMO_SUBDOMAIN || "").replace(/^https?:\/\//, "").replace(/\..*/, "");
    const H = { Authorization: "Bearer " + process.env.AMO_ACCESS_TOKEN };
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    // срок: в рабочее время (10–18 МСК, пн–пт) — через час, иначе — 11:00 следующего рабочего дня (МСК)
    const dueFor = (t) => {
      const m = new Date(t + 3 * 3600e3);
      const h = m.getUTCHours(), wd = m.getUTCDay();
      if (wd >= 1 && wd <= 5 && h >= CFG.workFrom && h < CFG.workTo) return Math.floor((t + CFG.dueInWorkMinutes * 60e3) / 1000);
      const d = new Date(Date.UTC(m.getUTCFullYear(), m.getUTCMonth(), m.getUTCDate() + (h >= CFG.workFrom ? 1 : 0), CFG.dueNextDayHour - 3, 0));
      while (d.getUTCDay() === 0 || d.getUTCDay() === 6) d.setUTCDate(d.getUTCDate() + 1);
      return Math.floor(d.getTime() / 1000);
    };
    let sentToday = items.filter((x) => typeof x.taskId === "number" && now - (x.taskAt || 0) < 86400e3).length, sentRun = 0;
    for (const it of items.filter((x) => x.decision === "задача" && !x.taskId && x.mode === "боевой" && now - x.end < 6 * 3600e3)) {
      if (sentRun >= MAX_RUN || sentToday >= MAX_DAY) { it.decision = "задача (отложена: лимит)"; continue; }
      await sleep(1100);
      try {
        const post = (type) => axios.post(`https://${SUB}.amocrm.ru/api/v4/tasks`, [{
          task_type_id: type, text: it.text, complete_till: dueFor(now), entity_type: "contacts", entity_id: it.contactId,
          responsible_user_id: it.responsibleId || RESPONSIBLE
        }], { headers: H, timeout: 30000, validateStatus: null });
        let r = await post(TASK_TYPE);
        it.taskType = TASK_TYPE;
        // свой тип удалили или переименовали в amo — задача не должна пропасть: ставим обычным «Связаться» и пишем в журнал
        if (r.status === 400 && TASK_TYPE !== 1) {
          console.log(`amo не принял тип задачи ${TASK_TYPE} (400) — ставлю «Связаться»`);
          await sleep(1100);
          r = await post(1);
          it.taskType = 1;
        }
        if (r.status === 429 || r.status === 403) { console.log("amo ответил " + r.status + " — стоп"); break; }
        it.taskId = (r.data && r.data._embedded && r.data._embedded.tasks && r.data._embedded.tasks[0] && r.data._embedded.tasks[0].id) || "ошибка " + r.status;
        if (typeof it.taskId === "number") { it.taskAt = Date.now(); it.taskDue = dueFor(now) * 1000; sentRun++; sentToday++; }
      } catch (e) {
        it.taskId = "ошибка: " + e.message;
      }
    }

    // 4b. тег на первой новой сделке после сигнала (ТЗ Кати): «Сигнал с сайта» / «… контроль»
    let tagged = 0;
    for (const it of items.filter((x) => x.deal && !x.deal.tagged && x.mode === "боевой" && (typeof x.taskId === "number" || x.decision === "контроль"))) {
      if (tagged >= 10) break;
      const tag = it.decision === "контроль" ? CFG.controlDealTag : CFG.dealTag;
      await sleep(1100);
      try {
        let r = await axios.patch(`https://${SUB}.amocrm.ru/api/v4/leads/${it.deal.id}`, { _embedded: { tags_to_add: [{ name: tag }] } },
          { headers: H, timeout: 30000, validateStatus: null });
        if (r.status === 400) {
          // старый способ: прочитать теги сделки из amo и записать их вместе с новым
          await sleep(1100);
          const g = await axios.get(`https://${SUB}.amocrm.ru/api/v4/leads/${it.deal.id}`, { headers: H, timeout: 30000, validateStatus: null });
          const old = ((g.data && g.data._embedded && g.data._embedded.tags) || []).map((t) => ({ id: t.id }));
          await sleep(1100);
          r = await axios.patch(`https://${SUB}.amocrm.ru/api/v4/leads/${it.deal.id}`, { _embedded: { tags: old.concat([{ name: tag }]) } },
            { headers: H, timeout: 30000, validateStatus: null });
        }
        if (r.status === 429 || r.status === 403) { console.log("amo ответил " + r.status + " на тег — стоп"); break; }
        if (r.status >= 200 && r.status < 300) { it.deal.tagged = tag; it.deal.taggedAt = Date.now(); tagged++; }
        else it.deal.tagError = "amo " + r.status;
      } catch (e) { it.deal.tagError = e.message; }
    }
  }

  const keep = items.filter((x) => now - x.end < 60 * 86400e3).slice(-1000);
  const keepDone = Object.fromEntries(Object.entries(done).filter(([k]) => now - Number(k.split("|")[1]) < 70 * 86400e3));
  const keepGroups = Object.fromEntries(Object.entries(groups).filter(([, v]) => now - v.at < 400 * 86400e3));
  const out = { builtAt: new Date().toISOString(), mode: LIVE ? "боевой" : "тест", knownVisitors: known.size, items: keep, done: keepDone,
    groups: keepGroups, groupSeq };
  fs.writeFileSync(OUT + ".tmp", JSON.stringify(out));
  fs.renameSync(OUT + ".tmp", OUT);
  try {
    const st = fs.statSync(STAT);
    fs.chownSync(OUT, st.uid, st.gid);
  } catch (_) {}
  try { exportForKate(keep, out, mobileOf); } catch (e) { console.log("выгрузка для Кати: " + e.message); }
  console.log(`${out.builtAt} SMS: ${SMS_ON ? "вкл" : "выкл"}, за прогон ${smsRun}; узнаваемых посетителей ${known.size}, посещений ${sessions.length}, новых случаев ${added}, задач ${keep.filter((x) => x.decision === "задача").length} (${out.mode})`);
})().catch((e) => {
  console.log("ошибка:", e.message);
  process.exit(1);
});
