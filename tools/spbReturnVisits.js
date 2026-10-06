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
 * «Вернувшиеся клиенты»). С 06.10.2026 включено (решение Андрея): задача «Связаться» на контакт,
 * ответственная — Ксения Маслова (SPB_RETURN_RESPONSIBLE, по умолчанию 1605012). Выключить —
 * убрать SPB_RETURN_TASKS=1 из .env. Бережём amo: 1 запрос в 1,1 с, не больше 5 задач за прогон
 * и 30 в сутки, при 429/403 — стоп; удалённые контакты и уже открытые такие задачи — пропуск.
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
const LIVE = process.argv.includes("--live") && process.env.SPB_RETURN_TASKS === "1";
const SESSION_GAP = 30 * 60e3; // пауза, после которой визит считается законченным
const QUIET = 30 * 60e3; // ждём после визита: вдруг позвонит или оставит заявку
const PER_CONTACT = 24 * 3600e3; // не чаще одной задачи на контакт в сутки
const SITE = "spb.visa-sc.ru";
const RESPONSIBLE = Number(process.env.SPB_RETURN_RESPONSIBLE || 1605012); // Ксения Маслова
const MAX_RUN = 5, MAX_DAY = 30;

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

  const prev = readJson(OUT, { items: [], done: {} });
  const done = prev.done || {};
  const items = prev.items || [];
  const lastTaskAt = new Map();
  for (const it of items) if (it.decision === "задача") lastTaskAt.set(it.contactId, Math.max(lastTaskAt.get(it.contactId) || 0, it.end));

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
    const why = [];
    if (leads.some((l) => Date.parse(l.at) >= from && Date.parse(l.at) <= to && (l.vid === s.vid || Number((l.amo && l.amo.contactId) || 0) === k.contact || phones.includes(digits(((l.data && l.data.fields) || []).map((f) => (f.type === "phone" ? f.value : "")).join(""))))))
      why.push("оставил заявку на сайте");
    if (calls.some((x) => Number(x.contactId) === k.contact && Date.parse(x.at) >= from && Date.parse(x.at) <= to)) why.push("звонил на питерский номер");
    const fs_ = Math.floor(from / 1000), ts_ = Math.floor(to / 1000);
    if (qCallIn.get(k.contact, fs_, ts_).n + qCallInLead.get(k.contact, fs_, ts_).n) why.push("входящий звонок в amo");
    if (qNewLead.get(k.contact, fs_, ts_).n) why.push("новая сделка в amo");
    const recent = lastTaskAt.get(k.contact);
    let decision = "задача";
    if (!found) decision = "контакта нет в CRM (удалён)";
    else if (why.length) decision = "связался: " + why.join(", ");
    else if (recent && s.start - recent < PER_CONTACT) decision = "уже была задача за сутки";
    else if (qOurTask.get(k.contact).n) decision = "уже есть открытая такая задача";
    const src = s.first.utm && s.first.utm.utm_term ? "Директ «" + s.first.utm.utm_term + "»" : s.first.channel || "прямой заход";
    const item = {
      key, vid: s.vid, contactId: k.contact, contactName: c.name || "", responsibleId: RESPONSIBLE, responsible: respName,
      contactOwner: (c.responsible_user_id && (qUser.get(c.responsible_user_id) || {}).name) || "",
      knownBy: k.how, start: s.start, end: s.end, pages: s.pages.slice(0, 12), source: src,
      openTasks: qOpenTask.get(k.contact).n, decision, mode: LIVE ? "боевой" : "тест", taskId: null,
      text: `Клиент зашёл на сайт ${SITE} ${mskStr(s.start)}${s.end - s.start > 60e3 ? "–" + mskStr(s.end).slice(11) : ""} МСК, но не позвонил и не оставил заявку — связаться, узнать, что хотел.` +
        ` Смотрел: ${s.pages.slice(0, 4).join(", ")}${s.pages.length > 4 ? " и ещё " + (s.pages.length - 4) : ""}. Источник: ${src}.`
    };
    items.push(item);
    done[key] = 1;
    added++;
    if (decision === "задача") lastTaskAt.set(k.contact, s.end);
  }

  // 4. (выключено) постановка задач в amo — только SPB_RETURN_TASKS=1 и --live
  if (LIVE) {
    const axios = require("axios");
    const SUB = (process.env.AMO_SUBDOMAIN || "").replace(/^https?:\/\//, "").replace(/\..*/, "");
    const H = { Authorization: "Bearer " + process.env.AMO_ACCESS_TOKEN };
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    // срок: в рабочее время — через час, иначе — 11:00 следующего рабочего дня (МСК)
    const dueFor = (t) => {
      const m = new Date(t + 3 * 3600e3);
      const h = m.getUTCHours(), wd = m.getUTCDay();
      if (wd >= 1 && wd <= 5 && h >= 10 && h < 18) return Math.floor((t + 3600e3) / 1000);
      const d = new Date(Date.UTC(m.getUTCFullYear(), m.getUTCMonth(), m.getUTCDate() + (h >= 10 ? 1 : 0), 8, 0));
      while (d.getUTCDay() === 0 || d.getUTCDay() === 6) d.setUTCDate(d.getUTCDate() + 1);
      return Math.floor(d.getTime() / 1000);
    };
    let sentToday = items.filter((x) => typeof x.taskId === "number" && now - (x.taskAt || 0) < 86400e3).length, sentRun = 0;
    for (const it of items.filter((x) => x.decision === "задача" && !x.taskId && x.mode === "боевой" && now - x.end < 6 * 3600e3)) {
      if (sentRun >= MAX_RUN || sentToday >= MAX_DAY) { it.decision = "задача (отложена: лимит)"; continue; }
      await sleep(1100);
      try {
        const r = await axios.post(`https://${SUB}.amocrm.ru/api/v4/tasks`, [{
          task_type_id: 1, text: it.text, complete_till: dueFor(now), entity_type: "contacts", entity_id: it.contactId,
          responsible_user_id: RESPONSIBLE
        }], { headers: H, timeout: 30000, validateStatus: null });
        if (r.status === 429 || r.status === 403) { console.log("amo ответил " + r.status + " — стоп"); break; }
        it.taskId = (r.data && r.data._embedded && r.data._embedded.tasks && r.data._embedded.tasks[0] && r.data._embedded.tasks[0].id) || "ошибка " + r.status;
        if (typeof it.taskId === "number") { it.taskAt = Date.now(); sentRun++; sentToday++; }
      } catch (e) {
        it.taskId = "ошибка: " + e.message;
      }
    }
  }

  const keep = items.filter((x) => now - x.end < 60 * 86400e3).slice(-1000);
  const keepDone = Object.fromEntries(Object.entries(done).filter(([k]) => now - Number(k.split("|")[1]) < 70 * 86400e3));
  const out = { builtAt: new Date().toISOString(), mode: LIVE ? "боевой" : "тест", knownVisitors: known.size, items: keep, done: keepDone };
  fs.writeFileSync(OUT + ".tmp", JSON.stringify(out));
  fs.renameSync(OUT + ".tmp", OUT);
  try {
    const st = fs.statSync(STAT);
    fs.chownSync(OUT, st.uid, st.gid);
  } catch (_) {}
  console.log(`${out.builtAt} узнаваемых посетителей ${known.size}, посещений ${sessions.length}, новых случаев ${added}, задач ${keep.filter((x) => x.decision === "задача").length} (${out.mode})`);
})().catch((e) => {
  console.log("ошибка:", e.message);
  process.exit(1);
});
