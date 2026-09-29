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
 * Как сопоставляем: телефон заявки → контакт в CRM (по последним 10 цифрам) →
 * связанные сделки → берём успешные (status_id 142) не раньше самой заявки.
 * Выручка = сумма их price. Если успешных нет, ставим 0 — заявка останется в
 * списке на следующий заход, и когда сделка закроется, сумма подтянется.
 *
 * Запуск: node tools/spbRevenueSync.js [--days=90] [--dry]
 * По cron раз в сутки. Настройки в .env: SPBCOPY_API_URL, SPBCOPY_API_TOKEN.
 * ───────────────────────────────────────────────────────────────────────────── */
"use strict";

const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const API = (process.env.SPBCOPY_API_URL || "https://spb.voyotravel.ru").replace(/\/$/, "");
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
    console.log("заявок без суммы нет");
    return;
  }
  console.log(`заявок без суммы: ${leads.length}`);

  const Database = require(SQLITE);
  const db = new Database(DB_PATH, { readonly: true });

  // Телефоны контактов лежат строкой — готовим индекс по последним 10 цифрам.
  const index = new Map();
  const rows = db.prepare("SELECT id, phones FROM contacts WHERE phones IS NOT NULL AND phones <> ''").all();
  for (const r of rows) {
    for (const p of String(r.phones).split(/[,;\s]+/)) {
      const t = tail10(p);
      if (t.length === 10) {
        if (!index.has(t)) index.set(t, []);
        index.get(t).push(r.id);
      }
    }
  }
  console.log(`в копии CRM телефонов: ${index.size}, контактов: ${rows.length}`);

  const dealsOf = db.prepare(
    "SELECT l.id, l.price, l.status_id, l.created_at, l.closed_at, l.name FROM lead_contacts lc JOIN leads l ON l.id = lc.lead_id WHERE lc.contact_id = ?"
  );

  const items = [];
  const since = Math.floor(Date.now() / 1000) - DAYS * 86400;
  for (const lead of leads) {
    const t = tail10(lead.phone);
    if (t.length !== 10) continue;
    const contactIds = index.get(t) || [];
    if (!contactIds.length) continue;

    const leadTs = Math.floor(new Date(lead.at).getTime() / 1000) - 3 * 86400; // небольшой запас назад
    let revenue = 0;
    let dealId = null;
    let status = "без сделки";
    for (const cid of contactIds) {
      for (const d of dealsOf.all(cid)) {
        if (d.created_at < Math.max(leadTs, since)) continue;
        if (d.status_id === WON_STATUS) {
          revenue += Number(d.price) || 0;
          dealId = dealId || d.id;
          status = "успешно";
        } else if (status === "без сделки") {
          dealId = dealId || d.id;
          status = "в работе";
        }
      }
    }
    if (dealId) items.push({ id: lead.id, amount: revenue, dealId, status });
  }

  console.log(`сопоставлено с CRM: ${items.length}, из них с выручкой: ${items.filter((i) => i.amount).length}`);
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
