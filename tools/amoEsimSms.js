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
  let added = 0;
  for (const r of rows) {
    let p = {};
    try { p = JSON.parse(r.params || "{}"); } catch (_) { continue; }
    const text = String(p.text || "");
    if (!ESIM_RE.test(text)) continue;
    const smsId = (/##([0-9]+-[0-9]+)##/.exec(text) || [])[1] || null;
    const key = smsId || "note" + r.id;
    if (byId.has(key)) continue;
    const em = r.entity_type === "leads" ? qLeadEmails.all(r.entity_id).map((x) => x.emails).join(",")
      : r.entity_type === "contacts" ? ((qContactEmails.get(r.entity_id) || {}).emails || "") : "";
    // amo хранит почты списком в JSON («["a@b.ru"]») — вынимаем сами адреса
    const emails = Array.from(new Set(String(em).toLowerCase().match(/[^\s"',;\[\]]+@[^\s"',;\[\]]+\.[a-z]{2,}/g) || [])).slice(0, 3);
    byId.set(key, { smsId, noteId: r.id, at: r.created_at * 1000, phone10: digits(p.phone), emails,
      text: text.replace(/\s*##[^#]*##\s*/g, "").slice(0, 160), campaign: campaignOf(text), cost: null, costAt: 0 });
    added++;
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
  fs.writeFileSync(OUT + ".tmp", JSON.stringify({ builtAt: new Date().toISOString(), sends }));
  fs.renameSync(OUT + ".tmp", OUT);
  const total = sends.reduce((a, x) => a + (Number(x.cost) || 0), 0);
  console.log(new Date().toISOString(), "SMS про eSIM из amo:", sends.length, "(новых " + added + ")", "стоимость", Math.round(total), "₽,",
    "без цены", sends.filter((x) => x.cost == null).length);
})().catch((e) => { console.error("amoEsimSms:", e.message); process.exit(1); });
