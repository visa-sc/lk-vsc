#!/usr/bin/env node
// SMS про eSIM, которые шлёт amoCRM (рассылки Петрова: «закрытые — eSIM через 7 и через 30 дней»),
// — в журнал панели eSIM: расход по факту SMS.ru и выручка (Андрей, 14.10.2026).
//
// Откуда: локальная копия amoCRM (/var/www/voyo/.amocopy-db/crm.db), примечания sms_out.
// В тексте примечания amo пишет номер отправки SMS.ru (##202642-1002297##) — по нему
// у SMS.ru берём настоящую стоимость (/sms/status, поле cost). SMS про eSIM — те, где в
// тексте ссылка на витрину eSIM (sms.ru/88GPH и т. п.) или слово eSIM.
// Почты клиента берём из контакта сделки — по ним (и по телефону) панель находит покупку.
// Журнал: /var/www/voyo/.esim/amo-esim-sms.json → { sends: [ { smsId, at, phone10, emails, text, campaign, cost, costAt } ] }.
// Cron прода: 50 * * * * cd /var/www/voyo && /usr/bin/node tools/amoEsimSms.js >> /var/log/amo-esim-sms.log 2>&1
const fs = require("fs");
require("dotenv").config({ path: "/var/www/voyo/.env", quiet: true });
const axios = require("axios");
const OUT = "/var/www/voyo/.esim/amo-esim-sms.json";
const DB_PATH = process.env.AMOCOPY_DB || "/var/www/voyo/.amocopy-db/crm.db";
const SQLITE = process.env.SQLITE_MODULE || "/var/www/voyo/crm-svc/node_modules/better-sqlite3";
const ESIM_RE = /88GPH|voyomobile|voyotravel\.ru\/esim|\besim\b/i;
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch (_) { return d; } };
const digits = (s) => String(s || "").replace(/\D/g, "").slice(-10);
// кампания — по началу текста: так видно, какая из двух SMS сработала лучше
// Короткая ссылка (sms.ru/…, clck.ru/…) может вести на витрину eSIM без слова eSIM в тексте:
// раскрываем её один раз и запоминаем, куда ведёт (19.10.2026, Петров завёл свои короткие ссылки).
const SHORT_RE = /(?:https?:\/\/)?(?:sms\.ru|clck\.ru)\/[A-Za-z0-9_-]+/g;
const ESIM_TARGET_RE = /voyomobile\.(ru|com)|voyotravel\.ru\/esim|voyovoyo\.ru\/esim|t\.me\/esimvoyo_bot/i;
async function resolveShort(link, cache) {
  const u = /^https?:/.test(link) ? link : "https://" + link;
  if (cache[u] !== undefined) return cache[u];
  try {
    const r = await axios.get(u, { maxRedirects: 0, validateStatus: () => true, timeout: 15000 });
    cache[u] = String((r.headers && r.headers.location) || "");
  } catch (_) { cache[u] = null; }   // сеть подвела — попробуем в следующий раз
  // нет ответа или капча (clck.ru не пускает серверы) — не запоминаем, спросим в следующий раз
  if (cache[u] === null || /showcaptcha/.test(cache[u] || "")) { const v = cache[u]; delete cache[u]; return /showcaptcha/.test(v || "") ? "" : ""; }
  return cache[u] || "";
}
// Строка в панели — по статусу сделки (Андрей 19.10.2026): «SMS на статусе «Успешно реализовано»»,
// «SMS на статусе «Закрыто и не реализовано»», в скобках — вариант текста (цена), чтобы сравнивать тексты.
const SUCCESS_STATUS = 142, LOST_STATUS = 143;
function statusLabel(id, names) {
  if (Number(id) === SUCCESS_STATUS) return "Успешно реализовано";
  if (Number(id) === LOST_STATUS) return "Закрыто и не реализовано";
  // остальные (например, «Возврат») — SMS ушла, когда сделка была успешной, и сделку потом перевели
  return "Успешно реализовано";
}
function campaignName(text, statusName) {
  const price = (String(text).match(/ESIM\s+от\s+\d[\d\s]*₽/i) || [])[0];
  const variant = price ? price.replace(/\s+/g, " ") : campaignOf(text).slice(0, 30);
  return "SMS на статусе «" + statusName + "»" + (variant ? " (" + variant + ")" : "");
}
const campaignOf = (t) => String(t || "").replace(/##[^#]*##/g, "").replace(/https?:\/\/\S+|\S+\.(ru|com)\/\S+/g, "").replace(/\s+/g, " ").trim().slice(0, 40);

(async () => {
  const store = readJson(OUT, { sends: [] });
  const byId = new Map((store.sends || []).map((x) => [x.smsId || x.noteId, x]));
  const Database = require(SQLITE);
  const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
  db.pragma("busy_timeout = 5000");
  const rows = db.prepare("SELECT id, entity_type, entity_id, params, created_at FROM amo_notes WHERE note_type = 'sms_out' AND created_at > ?")
    .all(Math.floor(Date.parse("2026-09-01") / 1000));
  const qLeadEmails = db.prepare("SELECT c.emails FROM lead_contacts lc JOIN contacts c ON c.id = lc.contact_id WHERE lc.lead_id = ?");
  const qContactEmails = db.prepare("SELECT emails FROM contacts WHERE id = ?");
  const qLeadStatus = db.prepare("SELECT status_id FROM leads WHERE id = ?");
  const qNote = db.prepare("SELECT entity_type, entity_id FROM amo_notes WHERE id = ?");
  const stNames = {}; db.prepare("SELECT id, name FROM statuses").all().forEach((x) => { stNames[x.id] = x.name; });
  const links = store.links || {};
  let added = 0;
  for (const r of rows) {
    let p = {};
    try { p = JSON.parse(r.params || "{}"); } catch (_) { continue; }
    const text = String(p.text || "");
    const smsId = (/##([0-9]+-[0-9]+)##/.exec(text) || [])[1] || null;
    const key = smsId || "note" + r.id;
    if (byId.has(key)) continue;
    let target = "";
    const short = (text.match(SHORT_RE) || [])[0];
    if (short) target = await resolveShort(short, links);
    if (!ESIM_RE.test(text) && !ESIM_TARGET_RE.test(target)) continue;
    const ls = r.entity_type === "leads" ? qLeadStatus.get(r.entity_id) : null;
    const grey = !!(ls && Number(ls.status_id) !== SUCCESS_STATUS);
    const stName = ls ? statusLabel(ls.status_id, stNames) : "без сделки";
    const em = r.entity_type === "leads" ? qLeadEmails.all(r.entity_id).map((x) => x.emails).join(",")
      : r.entity_type === "contacts" ? ((qContactEmails.get(r.entity_id) || {}).emails || "") : "";
    // amo хранит почты списком в JSON («["a@b.ru"]») — вынимаем сами адреса
    const emails = Array.from(new Set(String(em).toLowerCase().match(/[^\s"',;\[\]]+@[^\s"',;\[\]]+\.[a-z]{2,}/g) || [])).slice(0, 3);
    byId.set(key, { smsId, noteId: r.id, at: r.created_at * 1000, phone10: digits(p.phone), emails,
      text: text.replace(/\s*##[^#]*##\s*/g, "").slice(0, 160), campaign: campaignName(text, stName),
      seg: grey ? "grey" : "success", statusId: ls ? ls.status_id : null, link: target ? target.slice(0, 200) : undefined, cost: null, costAt: 0 });
    added++;
  }
  // старые записи (до 19.10) — то же имя по статусу их сделки
  for (const x of byId.values()) {
    let sid = x.statusId;
    if (sid == null && x.noteId) { const n = qNote.get(x.noteId); const l = n && n.entity_type === "leads" ? qLeadStatus.get(n.entity_id) : null; sid = l ? l.status_id : null; }
    x.statusId = sid; x.seg = sid == null || Number(sid) === SUCCESS_STATUS ? "success" : "grey";
    x.campaign = campaignName(x.text, sid == null ? "без сделки" : statusLabel(sid, stNames));
  }
  // стоимость у SMS.ru: новые и те, где пока 0 (SMS.ru иногда дописывает цену позже) — не чаще раза в сутки
  const now = Date.now();
  const need = Array.from(byId.values()).filter((x) => x.smsId && (x.cost == null || (Number(x.cost) === 0 && now - x.costAt > 86400e3 && now - x.at < 7 * 86400e3)));
  for (let i = 0; i < need.length; i += 100) {
    const part = need.slice(i, i + 100);
    try {
      const r = await axios.get("https://sms.ru/sms/status", { params: { api_id: process.env.SMS_RU_API_ID, sms_id: part.map((x) => x.smsId).join(","), json: 1 }, timeout: 30000 });
      const sms = (r.data && r.data.sms) || {};
      part.forEach((x) => { const s = sms[x.smsId]; if (s && s.cost != null) { x.cost = Number(s.cost) || 0; x.costAt = now; x.status = s.status_text || ""; } });
    } catch (e) { console.error("sms.ru status:", e.message); break; }
    await new Promise((ok) => setTimeout(ok, 400));
  }
  const sends = Array.from(byId.values()).sort((a, b) => a.at - b.at).filter((x) => now - x.at < 400 * 86400e3);
  fs.writeFileSync(OUT + ".tmp", JSON.stringify({ builtAt: new Date().toISOString(), links, sends }));
  fs.renameSync(OUT + ".tmp", OUT);
  const total = sends.reduce((a, x) => a + (Number(x.cost) || 0), 0);
  console.log(new Date().toISOString(), "SMS про eSIM из amo:", sends.length, "(новых " + added + ")", "стоимость", Math.round(total), "₽,",
    "без цены", sends.filter((x) => x.cost == null).length);
})().catch((e) => { console.error("amoEsimSms:", e.message); process.exit(1); });
