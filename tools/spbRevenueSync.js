#!/usr/bin/env node
/* ─────────────────────────────────────────────────────────────────────────────
 * spbRevenueSync — проставляет выручку заявкам копии питерского сайта
 * (spb.voyotravel.ru) по данным amoCRM.
 *
 * Зачем: в панели аналитики копии выручка показывается в разрезе каналов,
 * кампаний и ключевых слов. Руками её вбивать не нужно — берём из CRM.
 *
 * Откуда данные: из НАШЕЙ ЛОКАЛЬНОЙ КОПИИ amoCRM (.amocopy-db/crm.db). Живой
 * amo при этом не дёргаем вообще: ни одного запроса, ни капли лимита.
 *
 * Как сопоставляем: заявка → контакт amo (тот, что создала выгрузка заявки, плюс
 * найденные по телефону и почте) → все сделки контакта с момента заявки. Выручка =
 * сумма успешных (status_id 142): первая покупка и все повторные. Достаётся первой
 * заявке клиента (её ключевое слово привело контакт), повторные заявки — с нулём.
 * Пересчитываем каждый заход, поэтому повторные покупки дописываются сами. Сумму,
 * вписанную в карточке руками, не трогаем. Возвраты пока не вычитаем.
 *
 * Запуск: node tools/spbRevenueSync.js [--days=90] [--dry]
 * По cron каждый час (копия CRM своя, живой amo не трогаем). Настройки в .env: SPBCOPY_API_URL, SPBCOPY_API_TOKEN.
 * ───────────────────────────────────────────────────────────────────────────── */
"use strict";

const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const API = (process.env.SPBCOPY_API_URL || "http://127.0.0.1:3006").replace(/\/$/, "");
const TOKEN = process.env.SPBCOPY_API_TOKEN || "";
const DB_PATH = process.env.AMOCOPY_DB || "/var/www/voyo/.amocopy-db/crm.db";
const SQLITE = process.env.SQLITE_MODULE || "/var/www/voyo/crm-svc/node_modules/better-sqlite3";
const WON_STATUS = 142; // «Успешно реализовано» — одинаково во всех воронках amo

const args = process.argv.slice(2);
const flag = (n, d) => {
  const a = args.find((x) => x.startsWith(`--${n}=`));
  return a ? a.slice(n.length + 3) : d;
};
const DRY = args.includes("--dry");
const DAYS = Number(flag("days", 180));

const digits = (s) => String(s || "").replace(/\D/g, "");
const tail10 = (s) => digits(s).slice(-10);

async function api(pathname, options = {}) {
  const res = await fetch(`${API}${pathname}${pathname.includes("?") ? "&" : "?"}token=${encodeURIComponent(TOKEN)}`, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) }
  });
  if (!res.ok) throw new Error(`${pathname}: HTTP ${res.status}`);
  return res.json();
}

(async () => {
  if (!TOKEN) {
    console.log("нет SPBCOPY_API_TOKEN в .env — сверка выручки пропущена");
    process.exit(0);
  }

  const { leads } = await api("/leads/api/pending");
  if (!leads.length) {
    console.log("заявок для сверки нет");
    return;
  }
  console.log(`заявок для сверки: ${leads.length}`);

  const Database = require(SQLITE);
  const db = new Database(DB_PATH, { readonly: true });

  // Телефоны и почты контактов лежат строкой — готовим индексы.
  const byPhone = new Map();
  const byEmail = new Map();
  const add = (m, k, id) => {
    if (!k) return;
    if (!m.has(k)) m.set(k, new Set());
    m.get(k).add(id);
  };
  const cols = db.prepare("PRAGMA table_info(contacts)").all().map((c) => c.name);
  const hasEmail = cols.includes("emails");
  const rows = db.prepare(`SELECT id, phones${hasEmail ? ", emails" : ""} FROM contacts`).all();
  for (const r of rows) {
    for (const p of String(r.phones || "").split(/[,;\s]+/)) {
      const t = tail10(p);
      if (t.length === 10) add(byPhone, t, r.id);
    }
    if (hasEmail) for (const e of String(r.emails || "").toLowerCase().split(/[,;\s]+/)) if (e.includes("@")) add(byEmail, e, r.id);
  }
  console.log(`в копии CRM контактов: ${rows.length}, телефонов: ${byPhone.size}`);

  const dealsOf = db.prepare(
    "SELECT l.id, l.price, l.status_id, l.created_at, l.closed_at FROM lead_contacts lc JOIN leads l ON l.id = lc.lead_id WHERE lc.contact_id = ?"
  );

  // 1. Каждой заявке — её контакты в amo: тот, что создала выгрузка заявки
  //    (точное совпадение), плюс найденные по телефону и почте (дубли контактов).
  for (const lead of leads) {
    const ids = new Set();
    if (lead.amoContactId) ids.add(Number(lead.amoContactId));
    const t = tail10(lead.phone);
    if (t.length === 10) for (const id of byPhone.get(t) || []) ids.add(id);
    const e = String(lead.email || "").toLowerCase().trim();
    if (e) for (const id of byEmail.get(e) || []) ids.add(id);
    lead.contactIds = [...ids];
    lead.ts = Math.floor(new Date(lead.at).getTime() / 1000);
  }

  // 2. Клиент = группа заявок, у которых общий контакт. Выручку клиента получает
  //    ПЕРВАЯ его заявка: её ключевое слово привело контакт. Повторные заявки того же
  //    клиента идут с нулём и ссылкой на первую, чтобы деньги не задвоились.
  const parent = new Map();
  const find = (x) => (parent.get(x) === x ? x : (parent.set(x, find(parent.get(x))), parent.get(x)));
  for (const l of leads) parent.set(l.id, l.id);
  const owner = new Map();
  for (const l of leads)
    for (const c of l.contactIds) {
      if (owner.has(c)) parent.set(find(l.id), find(owner.get(c)));
      else owner.set(c, l.id);
    }
  const groups = new Map();
  for (const l of leads) {
    const g = find(l.id);
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(l);
  }

  // 3. Сделки клиента: все сделки его контактов, созданные не раньше первой заявки
  //    (минус сутки — менеджер мог завести сделку по звонку чуть раньше формы).
  //    Выручка = сумма успешных (142): первая покупка плюс все повторные. Возвраты
  //    пока не вычитаем (решение Андрея 02.10.2026).
  const items = [];
  for (const group of groups.values()) {
    group.sort((a, b) => a.ts - b.ts);
    const first = group[0];
    const contactIds = [...new Set(group.flatMap((l) => l.contactIds))];
    if (!contactIds.length) continue;
    const from = first.ts - 86400;
    const seen = new Map();
    for (const cid of contactIds) for (const d of dealsOf.all(cid)) if (d.created_at >= from) seen.set(d.id, d);
    const deals = [...seen.values()].sort((a, b) => a.created_at - b.created_at);
    if (!deals.length) continue;
    const won = deals.filter((d) => d.status_id === WON_STATUS);
    const revenue = won.reduce((a, d) => a + (Number(d.price) || 0), 0);
    const firstDealId = (deals.find((d) => String(d.id) === String(first.amoLeadId)) || deals[0]).id;
    const status = won.length ? `успешных сделок: ${won.length}` : "в работе, успешных сделок пока нет";
    const list = deals.map((d) => ({
      id: d.id,
      price: Number(d.price) || 0,
      won: d.status_id === WON_STATUS,
      first: d.id === firstDealId,
      closedAt: d.closed_at || null
    }));
    items.push({ id: first.id, amount: revenue, dealId: firstDealId, contactId: contactIds[0], status, ownerId: first.id, deals: list });
    for (const other of group.slice(1))
      items.push({ id: other.id, amount: 0, dealId: firstDealId, contactId: contactIds[0], status: "повторная заявка контакта", ownerId: first.id, deals: [] });
  }

  console.log(`сопоставлено с CRM: ${items.length}, клиентов с выручкой: ${items.filter((i) => i.amount).length}, выручка всего: ${items.reduce((a, i) => a + i.amount, 0)} ₽`);
  items.slice(0, 10).forEach((i) => console.log(`  заявка #${i.id} → сделка ${i.dealId}, ${i.status}, ${i.amount} ₽`));

  if (DRY) {
    console.log("это был пробный заход, ничего не записано");
    return;
  }
  if (items.length) {
    const r = await api("/leads/api/revenue", { method: "POST", body: JSON.stringify({ items }) });
    console.log(`записано в копию: ${r.updated}`);
  }
})().catch((e) => {
  console.log("ошибка сверки выручки:", e.message);
  process.exit(1);
});
