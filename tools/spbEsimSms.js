#!/usr/bin/env node
// SMS с промокодом eSIM через 14 дней после захода на spb.visa-sc.ru (Андрей, 14.10.2026).
//
// Кому: клиенты из amoCRM, которых узнал питерский сайт (заявка или звонок раньше),
// зашли снова и не связались: ни заявки, ни звонка, ни новой сделки. Журнал заходов
// ведёт tools/spbReturnVisits.js (сессия VSC) в /var/www/spbcopy/stat/return-visits.json;
// сюда только читаем. Перед отправкой заново проверяем, не связался ли человек за эти
// 14 дней, не купил ли уже eSIM и не получал ли питерскую SMS недавно.
//
// Включение: ESIM_SPB_SMS=1 и ESIM_SPB_SMS_TEXT в /var/www/voyo/.env. Без них —
// только «ушла бы» в журнале. Журнал отправок: /var/www/voyo/.esim/spb-esim-sms.json,
// по нему панель eSIM считает расход (строка SMS) и выручку (первая покупка eSIM
// с этого номера или почты в 30 дней после SMS).
// Cron прода: 35 * * * * cd /var/www/voyo && /usr/bin/node tools/spbEsimSms.js >> /var/log/spb-esim-sms.log 2>&1
// С 14.10.2026 включено: текст «Интернет в поездках: ESIM от 69₽. Готовность 1 мин. → voyomobile.ru/v» (69 знаков, 1 SMS ≈ 12,5 ₽),
// voyomobile.ru/v → витрина VSC mobile (server.js, utm_source=sms, utm_campaign=spb14).
const fs = require("fs");
const path = require("path");
require("dotenv").config({ path: "/var/www/voyo/.env", quiet: true });

const STAT = process.env.SPBCOPY_STAT || "/var/www/spbcopy/stat";
const LEADS = process.env.SPBCOPY_LEADS || "/var/www/spbcopy/leads.json";
const VISITS = path.join(STAT, "return-visits.json");
const SPB_SMS = path.join(STAT, "sms.json");
const OUT = "/var/www/voyo/.esim/spb-esim-sms.json";
const ORDERS = "/var/www/voyo/.esim/orders.json";
const DB_PATH = process.env.AMOCOPY_DB || "/var/www/voyo/.amocopy-db/crm.db";
const SQLITE = process.env.SQLITE_MODULE || "/var/www/voyo/crm-svc/node_modules/better-sqlite3";
const TEXT = String(process.env.ESIM_SPB_SMS_TEXT || "").trim();
const ON = process.env.ESIM_SPB_SMS === "1" && !!TEXT;
const AFTER = 14 * 86400e3, WINDOW = 16 * 86400e3;                    // шлём на 14–16-й день после захода
const GAP = Number(process.env.ESIM_SPB_SMS_GAP_DAYS || 7) * 86400e3;  // не сразу после питерской SMS
const MAX_RUN = 20, MAX_DAY = Number(process.env.ESIM_SPB_SMS_MAX_DAY || 50);
const DRY = process.argv.includes("--dry");

const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch (_) { return d; } };
const digits = (s) => String(s || "").replace(/\D/g, "").slice(-10);
const mskHour = (ms) => new Date(ms + 3 * 3600e3).getUTCHours();

(async () => {
  const now = Date.now();
  const visits = (readJson(VISITS, { items: [] }).items || []);
  const leads = readJson(LEADS, []);
  const calls = (readJson(path.join(STAT, "calls.json"), {}).calls || []);
  const spbSends = (readJson(SPB_SMS, { sends: [] }).sends || []);
  const orders = readJson(ORDERS, []).filter((o) => o.status === "done" && o.paidAt);
  const store = readJson(OUT, { sends: [], pending: [] });
  const sends = store.sends || [];
  const sentTo = new Set(sends.filter((x) => x.status === "отправлено").map((x) => x.contactId));

  const Database = require(SQLITE);
  const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
  db.pragma("busy_timeout = 5000");
  const qContact = db.prepare("SELECT phones, emails FROM contacts WHERE id = ?");
  const qCallIn = db.prepare("SELECT count(*) n FROM amo_notes WHERE entity_type = 'contacts' AND entity_id = ? AND note_type = 'call_in' AND created_at BETWEEN ? AND ?");
  const qCallInLead = db.prepare("SELECT count(*) n FROM amo_notes n JOIN lead_contacts lc ON lc.lead_id = n.entity_id WHERE n.entity_type = 'leads' AND lc.contact_id = ? AND n.note_type = 'call_in' AND n.created_at BETWEEN ? AND ?");
  const qNewLead = db.prepare("SELECT count(*) n FROM lead_contacts lc JOIN leads l ON l.id = lc.lead_id WHERE lc.contact_id = ? AND l.created_at BETWEEN ? AND ?");
  // те же проверки «связался», что у питерских задач (tools/spbReturnVisits.js)
  const contactedWhy = (contactId, phones, vid, from, to) => {
    const why = [];
    if (leads.some((l) => Date.parse(l.at) >= from && Date.parse(l.at) <= to && ((vid && l.vid === vid) ||
        Number((l.amo && l.amo.contactId) || 0) === contactId ||
        phones.includes(digits(((l.data && l.data.fields) || []).map((f) => (f.type === "phone" ? f.value : "")).join(""))))))
      why.push("заявка на сайте");
    if (calls.some((x) => Number(x.contactId) === contactId && Date.parse(x.at) >= from && Date.parse(x.at) <= to)) why.push("звонок на питерский номер");
    const a = Math.floor(from / 1000), b = Math.floor(to / 1000);
    if (qCallIn.get(contactId, a, b).n + qCallInLead.get(contactId, a, b).n) why.push("входящий звонок в amo");
    if (qNewLead.get(contactId, a, b).n) why.push("новая сделка в amo");
    return why;
  };

  // по одному решению на контакт: самый ранний подходящий заход
  const cands = new Map();
  for (const it of visits) {
    if (!/^задача|^уже /.test(String(it.decision || ""))) continue;   // связался сам или контакта нет
    const age = now - it.start;
    if (age < AFTER || age > WINDOW) continue;
    if (sentTo.has(it.contactId)) continue;
    if (!cands.has(it.contactId) || it.start < cands.get(it.contactId).start) cands.set(it.contactId, it);
  }

  const sms = ON && !DRY ? require("/var/www/voyo/sms.js") : null;
  const axios = ON && !DRY ? require("axios") : null;
  const sentDay = sends.filter((x) => x.status === "отправлено" && now - x.at < 86400e3).length;
  const dayTime = mskHour(now) >= 10 && mskHour(now) < 20;
  const pending = [];
  let run = 0;
  for (const it of cands.values()) {
    const c = qContact.get(it.contactId) || {};
    const phones = String(c.phones || "").split(/[,;\s]+/).map(digits).filter((x) => x.length === 10);
    const emails = String(c.emails || "").toLowerCase().split(/[,;\s]+/).filter((x) => x.indexOf("@") > 0);
    const mobile = phones.find((x) => x[0] === "9");
    const note = (status) => pending.push({ contactId: it.contactId, visit: it.start, status });
    if (!mobile) { note("нет мобильного"); continue; }
    const why = contactedWhy(it.contactId, phones, it.vid, it.start - 10 * 60e3, now);
    if (why.length) { note("не нужна: " + why.join(", ")); continue; }
    if (orders.some((o) => phones.includes(digits(o.phone)) || (o.email && emails.includes(String(o.email).toLowerCase())))) { note("уже покупал eSIM"); continue; }
    const spb = spbSends.filter((x) => x.contactId === it.contactId && x.status !== "ошибка").map((x) => x.at).sort().pop();
    if (spb && now - spb < GAP) { note("недавно была питерская SMS"); continue; }
    if (!ON || DRY) { note(TEXT ? "выключено (ESIM_SPB_SMS)" : "нет текста — ушла бы"); continue; }
    if (!dayTime) { note("ждёт 10:00 МСК"); continue; }
    if (run >= MAX_RUN || sentDay + run >= MAX_DAY) { note("ждёт: лимит"); continue; }
    let cost = 0;
    try {
      const r = await axios.get("https://sms.ru/sms/cost", { params: { api_id: process.env.SMS_RU_API_ID, to: "7" + mobile, msg: TEXT, json: 1 }, timeout: 15000 });
      cost = Number((r.data && r.data.total_cost) || 0);
    } catch (_) {}
    const r = await sms.sendMessage("7" + mobile, TEXT);
    const smsId = r.raw && r.raw.sms && r.raw.sms["7" + mobile] && r.raw.sms["7" + mobile].sms_id;
    sends.push({ contactId: it.contactId, visit: it.start, at: now, phone10: mobile, emails: emails.slice(0, 3),
      status: r.ok ? "отправлено" : "ошибка: " + (r.error || r.smsStatus || "SMS.ru"), smsId: smsId || null, cost: r.ok ? cost : 0, text: TEXT });
    if (r.ok) { run++; sentTo.add(it.contactId); }
  }
  const out = { builtAt: new Date().toISOString(), enabled: ON, textSet: !!TEXT, text: TEXT,
    rules: { afterDays: 14, gapAfterSpbSmsDays: GAP / 86400e3, hours: "10–20 МСК", maxDay: MAX_DAY },
    sends: sends.filter((x) => now - x.at < 400 * 86400e3), pending };
  if (!DRY) { fs.writeFileSync(OUT + ".tmp", JSON.stringify(out)); fs.renameSync(OUT + ".tmp", OUT); }
  console.log(new Date().toISOString(), "кандидатов", cands.size, "отправлено", run, ON ? "" : "(выключено)",
    JSON.stringify(pending.reduce((a, x) => { a[x.status] = (a[x.status] || 0) + 1; return a; }, {})));
})().catch((e) => { console.error("spbEsimSms:", e.message); process.exit(1); });
