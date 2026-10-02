#!/usr/bin/env node
/* ─────────────────────────────────────────────────────────────────────────────
 * spbHistory — историческая выручка питерского сайта по ключевым словам.
 *
 * Пока spb.visa-sc.ru жил на Flexbe (открыт в декабре 2023 — 02.10.2026), каждая
 * заявка с него падала в amoCRM сделкой с полем «Адрес страницы» на spb.visa-sc.ru и
 * метками utm_* в полях сделки. Тег «SPB» для отбора НЕ годится: им помечены и
 * звонки, и заявки питерского офиса из других мест, начиная с 2019 года.
 * По ним восстанавливаем, сколько денег принесло каждое ключевое слово:
 *
 *   заявка (тег SPB) → её контакт → все сделки контакта с момента этой заявки →
 *   выручка = сумма успешных (status_id 142): первая покупка и все повторные.
 *
 * Выручка клиента достаётся его ПЕРВОЙ заявке с сайта: её ключевое слово привело
 * контакт. Повторные заявки того же клиента считаются, но денег не добавляют —
 * иначе выручка задвоится. Возвраты не вычитаем (решение Андрея 02.10.2026).
 *
 * Источник — наша локальная копия amoCRM (.amocopy-db/crm.db), живой amo не
 * трогаем. Результат — /var/www/spbcopy/stat/history.json, его показывает блок
 * «Исторические данные» в аналитике /leads/stats.
 *
 * Запуск на сервере: node tools/spbHistory.js [--dry]. Cron — раз в сутки ночью:
 * старые сделки докрываются, повторные покупки старых клиентов добавляются.
 * ───────────────────────────────────────────────────────────────────────────── */
"use strict";

const fs = require("fs");
const path = require("path");

const DB_PATH = process.env.AMOCOPY_DB || "/var/www/voyo/.amocopy-db/crm.db";
const SQLITE = process.env.SQLITE_MODULE || "/var/www/voyo/crm-svc/node_modules/better-sqlite3";
const OUT = process.env.SPBCOPY_HISTORY || "/var/www/spbcopy/stat/history.json";
const WON = 142;
const UTM = { 447606: "source", 447608: "medium", 447610: "campaign", 447612: "term", 545395: "content" };
const DRY = process.argv.includes("--dry");

const Database = require(SQLITE);
const db = new Database(DB_PATH, { readonly: true });

// поля utm на всякий случай сверяем по названию, а не только по id
const fieldName = (f) => String(f.field_name || "").toLowerCase();
function utmOf(cf) {
  const out = {};
  for (const f of cf || []) {
    const v = f.values && f.values[0] && f.values[0].value;
    if (v == null || v === "") continue;
    const key = UTM[f.field_id] || (/^utm_(source|medium|campaign|term|content)$/.test(fieldName(f)) ? fieldName(f).slice(4) : null);
    if (key) out[key] = String(v).trim();
  }
  return out;
}

const SITE_FROM = Math.floor(Date.parse(process.env.SPB_SITE_FROM || "2023-12-01T00:00:00+03:00") / 1000);
const PAGE_FIELD = 568514; // «Адрес страницы»
const spb = db
  .prepare("SELECT id, created_at, cf, contact_ids FROM leads WHERE created_at >= ? AND cf LIKE '%spb.visa-sc.ru%' ORDER BY created_at")
  .all(SITE_FROM)
  .filter((r) => {
    try {
      const f = (JSON.parse(r.cf || "[]") || []).find((x) => x.field_id === PAGE_FIELD);
      return f && /^https?:\/\/(www\.)?spb\.visa-sc\.ru(\/|$)/i.test(String(f.values[0].value));
    } catch (_) {
      return false;
    }
  });

const contactsOf = db.prepare("SELECT contact_id FROM lead_contacts WHERE lead_id = ?");
const dealsOf = db.prepare(
  "SELECT l.id, l.price, l.status_id, l.created_at FROM lead_contacts lc JOIN leads l ON l.id = lc.lead_id WHERE lc.contact_id = ?"
);

// 1. Первая заявка каждого контакта
const firstLeadOfContact = new Map();
const leads = [];
for (const r of spb) {
  let cf = [];
  try {
    cf = JSON.parse(r.cf || "[]") || [];
  } catch (_) {}
  const utm = utmOf(cf);
  const contacts = contactsOf.all(r.id).map((x) => x.contact_id);
  const lead = { id: r.id, at: r.created_at, utm, contacts, owner: true };
  for (const c of contacts) {
    if (firstLeadOfContact.has(c)) lead.owner = false;
    else firstLeadOfContact.set(c, lead);
  }
  leads.push(lead);
}

// 2. Выручка: по каждой «первой» заявке — успешные сделки её контактов с её даты
const seenDeal = new Set();
for (const lead of leads) {
  lead.revenue = 0;
  lead.won = 0;
  if (!lead.owner) continue;
  for (const c of lead.contacts) {
    if (firstLeadOfContact.get(c) !== lead) continue;
    for (const d of dealsOf.all(c)) {
      if (d.status_id !== WON || d.created_at < lead.at - 86400 || seenDeal.has(d.id)) continue;
      seenDeal.add(d.id);
      lead.revenue += Number(d.price) || 0;
      lead.won++;
    }
  }
}

// 3. Сводим по ключевому слову, кампании и источнику
const norm = (s) => String(s || "").trim();
function group(keyFn) {
  const m = new Map();
  for (const l of leads) {
    const k = keyFn(l) || "—";
    if (!m.has(k)) m.set(k, { key: k, leads: 0, clients: 0, won: 0, revenue: 0, first: l.at, last: l.at, campaigns: new Set() });
    const o = m.get(k);
    o.leads++;
    if (l.owner) o.clients++;
    o.won += l.won;
    o.revenue += l.revenue;
    o.first = Math.min(o.first, l.at);
    o.last = Math.max(o.last, l.at);
    if (l.utm.campaign) o.campaigns.add(l.utm.campaign);
  }
  return [...m.values()]
    .map((o) => ({ ...o, campaigns: [...o.campaigns].slice(0, 5), first: new Date(o.first * 1000).toISOString().slice(0, 10), last: new Date(o.last * 1000).toISOString().slice(0, 10) }))
    .sort((a, b) => b.revenue - a.revenue || b.leads - a.leads);
}

const byYear = new Map();
for (const l of leads) {
  const y = new Date(l.at * 1000).getUTCFullYear();
  if (!byYear.has(y)) byYear.set(y, { year: y, leads: 0, revenue: 0, withTerm: 0 });
  const o = byYear.get(y);
  o.leads++;
  o.revenue += l.revenue;
  if (l.utm.term) o.withTerm++;
}

const result = {
  builtAt: new Date().toISOString(),
  from: leads.length ? new Date(leads[0].at * 1000).toISOString().slice(0, 10) : null,
  to: leads.length ? new Date(leads[leads.length - 1].at * 1000).toISOString().slice(0, 10) : null,
  totals: {
    leads: leads.length,
    clients: leads.filter((l) => l.owner).length,
    won: leads.reduce((a, l) => a + l.won, 0),
    revenue: leads.reduce((a, l) => a + l.revenue, 0),
    withTerm: leads.filter((l) => l.utm.term).length
  },
  years: [...byYear.values()].sort((a, b) => a.year - b.year),
  keywords: group((l) => norm(l.utm.term)).slice(0, 3000),
  campaigns: group((l) => norm(l.utm.campaign)).slice(0, 1000),
  sources: group((l) => norm(l.utm.source)).slice(0, 200)
};

console.log(
  `заявок SPB: ${result.totals.leads} (${result.from} — ${result.to}), клиентов: ${result.totals.clients}, ` +
    `успешных сделок: ${result.totals.won}, выручка: ${Math.round(result.totals.revenue).toLocaleString("ru-RU")} ₽, ` +
    `с ключевым словом: ${result.totals.withTerm}`
);
result.keywords.slice(0, 10).forEach((k) => console.log(`  ${k.key.slice(0, 60)} — заявок ${k.leads}, выручка ${Math.round(k.revenue)} ₽`));

if (!DRY) {
  fs.writeFileSync(OUT + ".tmp", JSON.stringify(result));
  fs.renameSync(OUT + ".tmp", OUT);
  try {
    const st = fs.statSync(path.dirname(OUT));
    fs.chownSync(OUT, st.uid, st.gid);
  } catch (_) {}
  console.log("записано:", OUT);
}
