#!/usr/bin/env node
/* ─────────────────────────────────────────────────────────────────────────────
 * formAbandonWatch — брошенные формы и сторож заявок сайтов spb.visa-sc.ru, visa-sc.ru (+ visa-gum.ru),
 * ekb.visa-sc.ru (просьба Андрея и Андрея Петрова, 13.11.2026). Письма — Петрову (ap@spt1.ru),
 * Андрей в копии.
 *
 * 1) Брошенная форма. Счётчик на странице (stat.js копий) молча запоминает, что посетитель ввёл в форму;
 *    ушёл со страницы с телефоном или почтой и не отправил — событие form_abandon в stat/events-*.jsonl.
 *    Через 30 минут проверяем: не пришла ли от него заявка (тот же телефон, почта или посетитель) на любом
 *    из трёх сайтов, не звонил ли на номера сайта, не появилась ли у контакта с этим телефоном новая сделка
 *    в amoCRM (копия CRM). Если нет — письмо с введёнными данными: Петров создаёт лид вручную.
 *    Один номер — не чаще раза в сутки.
 * 2) Заявка не попала в amo: заявка пришла на сайт (боевой домен), а сделки за 5 минут не создалось.
 * 3) Сбой отправки формы (событие form_error: сервер не ответил или ответил ошибкой) — письмо сразу,
 *    с телефоном из черновика этого посетителя, если он есть.
 *
 * Клиент ничего не видит, сайт не нагружается: на странице — один фоновый запрос при уходе со страницы,
 * разбор — здесь, на сервере. Живой amo не трогаем (только копия CRM).
 * Запуск: node tools/formAbandonWatch.js [--dry]   cron: каждые 10 минут.
 * Состояние: /var/lib/form-abandon/state.json.
 * ───────────────────────────────────────────────────────────────────────────── */
"use strict";
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
require("dotenv").config({ path: path.join(__dirname, "..", ".env"), quiet: true });

const DRY = process.argv.includes("--dry");
const TO = process.env.FORM_WATCH_TO || "ap@spt1.ru";
const CC = process.env.FORM_WATCH_CC || "director@visa-sc.ru";
const STATE_DIR = "/var/lib/form-abandon", STATE = path.join(STATE_DIR, "state.json");
const GRACE = 30 * 60e3;            // ждём 30 минут: вдруг отправит или позвонит
const LEAD_LAG = 5 * 60e3;          // заявка без сделки дольше 5 минут — сбой выгрузки
const PER_PHONE = 24 * 3600e3;      // один номер — не чаще раза в сутки
const MAX_MAILS = 15;               // писем за один прогон
const SITES = [
  { id: "spb", name: "spb.visa-sc.ru", dir: "/var/www/spbcopy", host: /^(www\.)?spb\.visa-sc\.ru$/i, amo: "spb-amo" },
  { id: "msk", name: "visa-sc.ru", dir: "/var/www/mskcopy", host: /^(www\.)?visa-sc\.ru$|^(www\.)?visa-gum\.ru$/i, amo: "msk-amo" },
  { id: "ekb", name: "ekb.visa-sc.ru", dir: "/var/www/ekbcopy", host: /^(www\.)?ekb\.visa-sc\.ru$/i, amo: "ekb-amo" }
];

const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch (_) { return d; } };
const digits10 = (s) => { const d = String(s || "").replace(/\D/g, ""); return d.length >= 10 ? d.slice(-10) : ""; };
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const msk = (iso) => new Date(Date.parse(iso) + 3 * 3600e3).toISOString().slice(0, 16).replace("T", " ");
const fmtPhone = (p) => (p ? "+7 " + p.slice(0, 3) + " " + p.slice(3, 6) + "-" + p.slice(6, 8) + "-" + p.slice(8) : "");
const leadPhone = (l) => digits10(((l.data && l.data.fields) || []).filter((f) => f.type === "phone").map((f) => f.value).join(""));
const leadEmail = (l) => String((((l.data && l.data.fields) || []).find((f) => f.type === "email") || {}).value || "").trim().toLowerCase();

function events(site, sinceIso) {
  const out = [];
  const now = new Date();
  const months = [new Date(now.getFullYear(), now.getMonth() - 1, 15), now].map((d) => d.toISOString().slice(0, 7));
  for (const m of [...new Set(months)]) {
    const f = path.join(site.dir, "stat", `events-${m}.jsonl`);
    if (!fs.existsSync(f)) continue;
    for (const line of fs.readFileSync(f, "utf8").split("\n")) {
      if (!line || (line.indexOf("form_abandon") < 0 && line.indexOf("form_error") < 0)) continue;
      let e; try { e = JSON.parse(line); } catch (_) { continue; }
      if ((e.type === "form_abandon" || e.type === "form_error") && e.at > sinceIso) out.push(e);
    }
  }
  return out;
}

async function send(subject, html) {
  if (DRY) { console.log("[dry] письмо:", subject); return true; }
  const { sendMail } = require(path.join(__dirname, "..", "mail.js"));
  const r = await sendMail({ to: TO, cc: CC, replyTo: CC, subject, html });
  console.log(new Date().toISOString(), "письмо:", subject, JSON.stringify(r).slice(0, 120));
  return !!(r && r.ok);
}
const box = (inner) => `<div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.5;color:#222;max-width:640px">${inner}</div>`;
const utmLine = (u) => { u = u || {}; const p = [u.utm_source, u.utm_medium, u.utm_campaign, u.utm_term].filter(Boolean); return p.length ? esc(p.join(" · ")) : "без меток (прямой заход или поиск)"; };

(async () => {
  const st = readJson(STATE, null) || { since: {}, phones: {}, leads: {}, errors: {} };
  const now = Date.now();
  const first = !fs.existsSync(STATE);
  // первый запуск — без писем о прошлом: только с этой минуты
  if (first) for (const s of SITES) st.since[s.id] = new Date(now).toISOString();

  // журналы заявок всех сайтов (для «отправил ли всё-таки»)
  const allLeads = [];
  for (const s of SITES) for (const l of readJson(path.join(s.dir, "leads.json"), [])) if (s.host.test(l.host || "")) allLeads.push({ ...l, _site: s });
  const allCalls = [];
  for (const s of SITES) for (const c of (readJson(path.join(s.dir, "stat", "calls.json"), {}).calls || [])) allCalls.push(c);

  let db = null, phoneIdx = null;
  const crmNewDeal = (phone, fromSec) => {
    try {
      if (!db) {
        const Database = require(process.env.SQLITE_MODULE || "/var/www/voyo/crm-svc/node_modules/better-sqlite3");
        db = new Database(process.env.AMOCOPY_DB || "/var/www/voyo/.amocopy-db/crm.db", { readonly: true, fileMustExist: true });
        phoneIdx = new Map();
        for (const c of db.prepare("SELECT id, phones FROM contacts").iterate())
          for (const p of String(c.phones || "").split(/[,;\s]+/).map(digits10).filter(Boolean)) (phoneIdx.get(p) || phoneIdx.set(p, []).get(p)).push(c.id);
      }
      const ids = phoneIdx.get(phone) || [];
      const q = db.prepare("SELECT count(*) n FROM lead_contacts lc JOIN leads l ON l.id = lc.lead_id WHERE lc.contact_id = ? AND l.created_at >= ?");
      return ids.some((id) => q.get(id, fromSec).n > 0);
    } catch (_) { return false; }
  };

  let mails = 0;
  for (const site of SITES) {
    const since = st.since[site.id] || new Date(now - GRACE).toISOString();
    const ev = events(site, since).sort((a, b) => (a.at < b.at ? -1 : 1));
    let newSince = since;
    const drafts = ev.filter((e) => e.type === "form_abandon");
    for (const e of ev) {
      const t = Date.parse(e.at);
      if (e.type === "form_abandon" && now - t < GRACE) break;      // ещё ждём — дальше по времени тоже
      newSince = e.at;
      if (mails >= MAX_MAILS) { newSince = since; break; }
      let d = {}; try { d = JSON.parse(e.value || "{}"); } catch (_) {}
      const phone = digits10(d.p), email = String(d.e || "").trim().toLowerCase();
      if (e.type === "form_error") {
        // сбой отправки: письмо сразу, с черновиком этого посетителя, если есть
        const key = (e.vid || "") + "|" + e.at.slice(0, 16);
        if (st.errors[key]) continue;
        const dr = drafts.filter((x) => x.vid && x.vid === e.vid).map((x) => { try { return JSON.parse(x.value || "{}"); } catch (_) { return {}; } }).pop() || {};
        const ph = digits10(dr.p);
        const sentLead = allLeads.some((l) => (ph && leadPhone(l) === ph) || (e.vid && l.vid === e.vid) ? Math.abs(Date.parse(l.at) - t) < 2 * 3600e3 : false);
        if (sentLead) { st.errors[key] = now; continue; }
        const ok = await send(`Сбой отправки формы на ${site.name}${ph ? " — " + fmtPhone(ph) : ""}`, box(
          `<p><b>Посетитель нажал «отправить», но заявка не ушла</b> (сервер не ответил или ответил ошибкой): «${esc(e.value)}».</p>
          <p>Сайт: <b>${esc(site.name)}</b>, страница <a href="https://${esc(site.name)}${esc(e.page)}">${esc(e.page)}</a>, ${esc(msk(e.at))} МСК.<br>Источник: ${utmLine(e.utm)}.</p>
          ${ph || dr.e ? `<p><b>Что он ввёл:</b> ${ph ? fmtPhone(ph) : ""} ${esc(dr.e || "")}<br>${(dr.fields || []).map((f) => esc(f[0]) + ": " + esc(f[1])).join("<br>")}</p><p>Создайте лид в amoCRM вручную.</p>` : `<p>Телефона в черновике нет — связаться не с кем, но стоит проверить форму на этой странице.</p>`}`));
        if (ok) { st.errors[key] = now; mails++; if (ph) st.phones[ph] = now; }
        continue;
      }
      // брошенная форма
      if (!phone && !/@.+\./.test(email)) continue;
      if (phone && st.phones[phone] && now - st.phones[phone] < PER_PHONE) continue;
      const from = t - 2 * 3600e3;
      const sent = allLeads.some((l) => { const lt = Date.parse(l.at); return lt >= from && lt <= now && ((phone && leadPhone(l) === phone) || (email && leadEmail(l) === email) || (e.vid && l.vid === e.vid)); });
      const called = phone && allCalls.some((c) => { const ct = Date.parse(c.at); return ct >= from && digits10(c.from || c.phone || c.caller) === phone; });
      const deal = phone && crmNewDeal(phone, Math.floor(from / 1000));
      if (sent || called || deal) { if (phone) st.phones[phone] = now; continue; }
      const fields = (d.fields || []).map((f) => `${esc(f[0])}: <b>${esc(f[1])}</b>`).join("<br>");
      const ok = await send(`Брошенная форма: ${phone ? fmtPhone(phone) : email} — ${site.name}`, box(
        `<p><b>Посетитель заполнил форму, но не отправил</b>. За 30 минут заявки, звонка и новой сделки в amoCRM от него нет — создайте лид вручную.</p>
        <p>${fields || (phone ? fmtPhone(phone) : esc(email))}</p>
        <p>Сайт: <b>${esc(site.name)}</b>, страница <a href="https://${esc(site.name)}${esc(e.page)}">${esc(e.page)}</a><br>
        Форма: ${esc(String(d.f || "").replace(/\s+/g, " ").slice(0, 80))}<br>
        Когда: ${esc(msk(e.at))} МСК<br>Источник: ${utmLine(e.utm)}</p>
        <p style="color:#888;font-size:12px">Письмо приходит, если введены телефон или почта и посетитель ушёл со страницы, не нажав «отправить» (или форма его не пустила). Один номер — не чаще раза в сутки.</p>`));
      if (ok) { mails++; if (phone) st.phones[phone] = now; }
    }
    st.since[site.id] = newSince;
  }

  // заявки, не попавшие в amo
  const pm2 = (() => { try { return JSON.parse(execSync("pm2 jlist", { encoding: "utf8", timeout: 20000, stdio: ["ignore", "pipe", "ignore"] })); } catch (_) { return []; } })();
  for (const site of SITES) {
    const L = readJson(path.join(site.dir, "leads.json"), []).filter((l) => site.host.test(l.host || ""));
    for (const l of L) {
      const t = Date.parse(l.at);
      if (now - t < LEAD_LAG || now - t > 48 * 3600e3) continue;
      if (first && t < now) { st.leads[site.id + ":" + l.id] = now; continue; }   // первый запуск: о прошлом не пишем
      if ((l.amo && (l.amo.leadId || l.amo.id || l.amo.skipped)) || st.leads[site.id + ":" + l.id]) continue;
      if (mails >= MAX_MAILS) break;
      const proc = pm2.find((p) => p.name === site.amo);
      const ph = leadPhone(l);
      const fields = ((l.data && l.data.fields) || []).map((f) => `${esc(f.name || f.type)}: <b>${esc(f.value)}</b>`).join("<br>");
      const ok = await send(`Заявка №${l.id} с ${site.name} не попала в amoCRM${ph ? " — " + fmtPhone(ph) : ""}`, box(
        `<p><b>Заявка пришла на сайт, но сделка в amoCRM за 5 минут не создалась.</b> Создайте лид вручную.</p>
        <p>${fields}</p>
        <p>Сайт: <b>${esc(site.name)}</b>, страница ${esc(l.pageUrl || l.page || "")}, форма «${esc((l.data && l.data.name) || "")}», ${esc(msk(l.at))} МСК.</p>
        <p style="color:#888;font-size:12px">Выгрузка в amo (${esc(site.amo)}): ${proc ? esc(proc.pm2_env.status) : "процесс не найден"}${l.amo && l.amo.error ? ", ошибка: " + esc(String(l.amo.error).slice(0, 200)) : ""}. Андрей в копии — разберёмся с причиной.</p>`));
      if (ok) { st.leads[site.id + ":" + l.id] = now; mails++; }
    }
  }

  // чистка состояния
  for (const k of Object.keys(st.phones)) if (now - st.phones[k] > 3 * PER_PHONE) delete st.phones[k];
  for (const m of ["leads", "errors"]) for (const k of Object.keys(st[m])) if (now - st[m][k] > 7 * 86400e3) delete st[m][k];
  if (!DRY) { fs.mkdirSync(STATE_DIR, { recursive: true }); fs.writeFileSync(STATE, JSON.stringify(st, null, 1)); }
  console.log(new Date().toISOString(), `писем ${mails}${first ? " (первый запуск: отметка «с этой минуты»)" : ""}`);
})().catch((e) => { console.error("formAbandonWatch:", e.message); process.exit(1); });
