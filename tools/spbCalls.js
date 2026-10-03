#!/usr/bin/env node
/* ─────────────────────────────────────────────────────────────────────────────
 * spbCalls — звонки на питерские номера: откуда пришёл звонящий и сколько он
 * принёс денег.
 *
 * 1. Звонки берём из АТС OnlinePBX (только чтение истории): входящие на номера,
 *    которые стоят на spb.visa-sc.ru (поле gateway — на какой наш номер звонили).
 * 2. Источник звонка. Счётчик сайта пишет клик по телефону (phone_click) вместе с
 *    номером, по которому кликнули, и метками посетителя (utm_term — ключевое
 *    слово Директа). Звонок на тот же номер в течение 5 минут после клика
 *    получает метки этого клика — так звонят с телефона, нажав на номер.
 *    Если клика нет, но звонящий раньше оставлял заявку на сайте, берём метки
 *    заявки. Остальное — «источник не определён»: номер набрали руками (обычно с
 *    компьютера). Точно определять все звонки умеет только подменный номер на
 *    каждого посетителя (коллтрекинг) — это отдельное решение.
 * 3. Выручка: номер звонящего → контакт в копии amoCRM → успешные сделки (142)
 *    контакта с момента звонка. Если контакт уже пришёл через заявку с сайта, его
 *    деньги посчитаны у заявки — звонку ноль, чтобы не задвоить. Повторные звонки
 *    того же контакта денег не добавляют. Возвраты не вычитаем.
 *
 * Живой amoCRM не трогаем: только локальная копия crm.db. Считаем звонки с
 * момента переезда домена (stat/start.json).
 * Результат — /var/www/spbcopy/stat/calls.json, его показывает аналитика.
 * Запуск: node tools/spbCalls.js [--dry]. Cron — каждые 15 минут.
 * ───────────────────────────────────────────────────────────────────────────── */
"use strict";

const fs = require("fs");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });
const axios = require("axios");

const STAT = process.env.SPBCOPY_STAT || "/var/www/spbcopy/stat";
const LEADS = process.env.SPBCOPY_LEADS || "/var/www/spbcopy/leads.json";
const OUT = path.join(STAT, "calls.json");
const DB_PATH = process.env.AMOCOPY_DB || "/var/www/voyo/.amocopy-db/crm.db";
const SQLITE = process.env.SQLITE_MODULE || "/var/www/voyo/crm-svc/node_modules/better-sqlite3";
const BASE = "https://api2.onlinepbx.ru/" + (process.env.PBX_DOMAIN || "visasc.onpbx.ru");
const WON = 142;
const CLICK_WINDOW = 5 * 60; // секунд между кликом по номеру и звонком
// Номера, которые стоят на питерском сайте (проверено по всем 243 страницам 02.10.2026)
const SPB_NUMBERS = (process.env.SPB_PHONE_NUMBERS || "78122440468,78122200365,78124673878,78122373387,78122408545,78122443427")
  .split(",")
  .map((s) => s.trim());
// Московские номера тоже стоят на питерских страницах, но на них звонят и с
// московского сайта. Их звонок берём, только если перед ним был клик по этому
// номеру на питерском сайте.
const SHARED_NUMBERS = (process.env.SPB_SHARED_NUMBERS || "74953691867,74999385358").split(",").map((s) => s.trim());
const DRY = process.argv.includes("--dry");

const tail10 = (s) => String(s || "").replace(/\D/g, "").slice(-10);
const spbSet = new Set(SPB_NUMBERS.map(tail10));
const sharedSet = new Set(SHARED_NUMBERS.map(tail10));

function readJson(f, d) {
  try {
    return JSON.parse(fs.readFileSync(f, "utf8"));
  } catch (_) {
    return d;
  }
}
function readEvents(sinceIso) {
  const out = [];
  for (const f of fs.readdirSync(STAT).filter((x) => /^events-\d{4}-\d{2}\.jsonl$/.test(x))) {
    for (const line of fs.readFileSync(path.join(STAT, f), "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line);
        if (e.type === "phone_click" && e.at >= sinceIso) out.push(e);
      } catch (_) {}
    }
  }
  return out;
}

async function pbxCalls(from, to) {
  const r0 = await axios.post(BASE + "/auth.json", "auth_key=" + encodeURIComponent(process.env.PBX_KEY || ""), {
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    timeout: 45000
  });
  const a = r0.data && r0.data.data;
  if (!a || !a.key_id) throw new Error("АТС не авторизовала");
  const H = { "x-pbx-authentication": a.key_id + ":" + a.key, "Content-Type": "application/x-www-form-urlencoded" };
  const rows = [];
  // по суткам: выдача АТС без пагинации и обрезается на нескольких тысячах
  for (let t = from; t < to; t += 86400) {
    const r = await axios.post(BASE + "/mongo_history/search.json", `start_stamp_from=${t}&start_stamp_to=${Math.min(t + 86400, to)}&limit=5000`, {
      headers: H,
      timeout: 60000
    });
    rows.push(...((r.data && r.data.data) || []));
  }
  return rows;
}

(async () => {
  const start = readJson(path.join(STAT, "start.json"), null);
  if (!start || !start.at) {
    console.log("нет stat/start.json — звонки не считаем");
    return;
  }
  const since = Math.floor(Date.parse(start.at) / 1000);
  const now = Math.floor(Date.now() / 1000);

  const raw = await pbxCalls(since, now);
  const calls = raw
    .filter((c) => c.accountcode === "inbound" && (spbSet.has(tail10(c.gateway)) || sharedSet.has(tail10(c.gateway))) && c.start_stamp >= since)
    .map((c) => ({
      id: c.uuid,
      ts: c.start_stamp,
      at: new Date(c.start_stamp * 1000).toISOString(),
      number: tail10(c.gateway),
      caller: tail10(c.caller_id_number || c.caller_id_name),
      answered: (c.user_talk_time || 0) > 0,
      talk: c.user_talk_time || 0
    }))
    .sort((a, b) => a.ts - b.ts);

  // источник: клик по тому же номеру незадолго до звонка
  const clicks = readEvents(start.at).map((e) => ({ ...e, ts: Math.floor(Date.parse(e.at) / 1000), number: tail10(e.value) }));
  const usedClick = new Set();
  const leads = readJson(LEADS, []);
  const leadByPhone = new Map();
  for (const l of leads) {
    const f = (l.data && l.data.fields) || l.fields || [];
    const ph = (Array.isArray(f) ? f : []).find((x) => /phone|tel|телефон/i.test(String(x.type || "") + String(x.name || "")));
    const t = tail10(ph && ph.value);
    if (t.length === 10 && !leadByPhone.has(t)) leadByPhone.set(t, l);
  }
  for (const c of calls) {
    const cand = clicks
      .filter((k) => k.number === c.number && !usedClick.has(k) && k.ts <= c.ts + 30 && k.ts >= c.ts - CLICK_WINDOW)
      .sort((a, b) => b.ts - a.ts)[0];
    if (cand) {
      usedClick.add(cand);
      const u = cand.utm || {};
      // vid — посетитель сайта: по нему аналитика восстанавливает путь клиента до звонка (атрибуция)
      c.source = { how: "клик по номеру", term: u.utm_term || "", campaign: u.utm_campaign || "", src: u.utm_source || "", channel: cand.channel || "", page: cand.page || "", vid: cand.vid || "" };
      continue;
    }
    const l = leadByPhone.get(c.caller);
    if (l) {
      let u = {};
      try {
        const ud = l.data && l.data.utmData;
        u = typeof ud === "string" ? JSON.parse(ud || "{}") : ud || {};
      } catch (_) {}
      if (l.utm && typeof l.utm === "object") u = { ...u, ...l.utm };
      c.source = { how: "раньше оставлял заявку #" + (l.id || ""), term: u.utm_term || "", campaign: u.utm_campaign || "", src: u.utm_source || "", channel: "", page: l.pageUrl || "", vid: l.vid || "" };
      continue;
    }
    c.source = { how: "не определён", term: "", campaign: "", src: "", channel: "", page: "" };
  }
  // Клики по номеру, после которых звонок до АТС так и не дошёл (за 5 минут ни
  // одного входящего на этот номер). Не взяли трубку — это не сюда: такой звонок в АТС
  // есть. Сюда — когда звонка в АТС нет вовсе: связь, номер не набрался, человек
  // передумал. Показываем в «Формы заявок» (/vsc) и в аналитике сайта.
  const knownNumbers = new Set([...spbSet, ...sharedSet]);
  const clicksNoCall = clicks
    .filter((k) => !usedClick.has(k) && knownNumbers.has(k.number) && k.ts < now - CLICK_WINDOW)
    .filter((k) => !calls.some((c) => c.number === k.number && c.ts >= k.ts - 30 && c.ts <= k.ts + CLICK_WINDOW))
    .map((k) => ({ at: new Date(k.ts * 1000).toISOString(), page: k.page || "", number: k.number, term: (k.utm || {}).utm_term || "" }));

  // звонки на общие с Москвой номера без клика на питерском сайте — не наши
  for (let i = calls.length - 1; i >= 0; i--)
    if (sharedSet.has(calls[i].number) && calls[i].source.how !== "клик по номеру") calls.splice(i, 1);

  // выручка из копии amoCRM
  const Database = require(SQLITE);
  const db = new Database(DB_PATH, { readonly: true });
  const byPhone = new Map();
  for (const r of db.prepare("SELECT id, phones FROM contacts WHERE phones IS NOT NULL AND phones <> ''").all())
    for (const p of String(r.phones).split(/[,;\s]+/)) {
      const t = tail10(p);
      if (t.length === 10) (byPhone.get(t) || byPhone.set(t, new Set()).get(t)).add(r.id);
    }
  const dealsOf = db.prepare(
    "SELECT l.id, l.price, l.status_id, l.created_at FROM lead_contacts lc JOIN leads l ON l.id = lc.lead_id WHERE lc.contact_id = ?"
  );
  // контакты, чьи деньги уже у заявок с сайта
  const leadContacts = new Set();
  for (const l of leads) {
    if (l.amo && l.amo.contactId) leadContacts.add(Number(l.amo.contactId));
    if (l.crm && l.crm.contactId) leadContacts.add(Number(l.crm.contactId));
  }
  const ownedContact = new Set();
  for (const c of calls) {
    c.revenue = 0;
    c.won = 0;
    const ids = [...(byPhone.get(c.caller) || [])];
    c.contactId = ids[0] || null;
    if (!ids.length) continue;
    if (ids.some((id) => leadContacts.has(id))) {
      c.note = "контакт пришёл через заявку с сайта — выручка у заявки";
      continue;
    }
    if (ids.some((id) => ownedContact.has(id))) {
      c.note = "повторный звонок контакта";
      continue;
    }
    ids.forEach((id) => ownedContact.add(id));
    c.firstOfClient = true;
    const seen = new Set();
    for (const id of ids)
      for (const d of dealsOf.all(id)) {
        if (d.status_id !== WON || d.created_at < c.ts - 86400 || seen.has(d.id)) continue;
        seen.add(d.id);
        c.revenue += Number(d.price) || 0;
        c.won++;
      }
  }

  const out = {
    builtAt: new Date().toISOString(),
    since: start.at,
    numbers: SPB_NUMBERS,
    clicksNoCall,
    calls: calls.map((c) => ({ ...c, caller: c.caller ? "•••" + c.caller.slice(-4) : "" }))
  };
  const withSrc = calls.filter((c) => c.source.how !== "не определён").length;
  console.log(
    `звонков на питерские номера с ${start.at.slice(0, 16)}: ${calls.length}, источник найден: ${withSrc}, ` +
      `выручка: ${calls.reduce((a, c) => a + c.revenue, 0)} ₽, кликов без звонка: ${clicksNoCall.length}`
  );
  if (!DRY) {
    fs.writeFileSync(OUT + ".tmp", JSON.stringify(out));
    fs.renameSync(OUT + ".tmp", OUT);
    try {
      const st = fs.statSync(STAT);
      fs.chownSync(OUT, st.uid, st.gid);
    } catch (_) {}
  }
})().catch((e) => {
  console.log("ошибка подсчёта звонков:", e.message);
  process.exit(1);
});
