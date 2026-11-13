#!/usr/bin/env node
// Сторож оплат по клиентам ВНЖ из рекламы Facebook/Instagram (13.11.2026, просьба Андрея).
// Пятерых клиентов отдел продаж передал партнёру, сделки закрыты «не реализовано».
// Раз в день смотрим копию amoCRM: если у любого из этих контактов появилась сделка
// с оплатой (pay_ts), суммой или статусом «Успешно реализовано» — письмо Андрею,
// по каждой сделке один раз. amo API не трогаем, только копию (readonly).
"use strict";
process.chdir("/var/www/voyo");
require("/var/www/voyo/node_modules/dotenv").config({ path: "/var/www/voyo/.env", quiet: true });
const fs = require("fs");
const Database = require(process.env.SQLITE_MODULE || "/var/www/voyo/crm-svc/node_modules/better-sqlite3");
const { sendMail } = require("/var/www/voyo/mail");

const DB = process.env.AMOCOPY_DB || "/var/www/voyo/.amocopy-db/crm.db";
const STATE = "/var/www/voyo/.vnjPaidWatch.json";
const TO = "director@visa-sc.ru";
const WON = 142;   // «Успешно реализовано» в amo
// Сделки, с которых пришли клиенты (реклама ВНЖ, 13–19.10.2026).
const DEALS = [
  { deal: 32718054, who: "Viktar" },
  { deal: 32718874, who: "Мила" },
  { deal: 32722955, who: "Batir" },
  { deal: 32723549, who: "Sulton" },
  { deal: 32724348, who: "Ималудин" },
];

const state = (() => { try { return JSON.parse(fs.readFileSync(STATE, "utf8")); } catch (_) { return { sent: {} }; } })();
const db = new Database(DB, { readonly: true, fileMustExist: true });
db.pragma("query_only = 1");
const st = Object.fromEntries(db.prepare("SELECT id, name FROM statuses").all().map((r) => [r.id, r.name]));
const sub = String(process.env.AMO_SUBDOMAIN || "").replace(/^https?:\/\//, "").replace(/\..*/, "");
const link = (id) => `https://${sub}.amocrm.ru/leads/detail/${id}`;

const found = [];
for (const d of DEALS) {
  const lead = db.prepare("SELECT contact_ids FROM leads WHERE id = ?").get(d.deal);
  let cids = [];
  try { cids = JSON.parse(lead && lead.contact_ids || "[]"); } catch (_) {}
  for (const cid of cids) {
    const rows = db.prepare("SELECT id, name, status_id, price, pay_ts FROM leads WHERE contact_ids LIKE ?").all("%" + cid + "%");
    for (const r of rows) {
      if (!(r.pay_ts || (r.price || 0) > 0 || r.status_id === WON)) continue;
      if (state.sent[r.id]) continue;
      found.push({ ...d, id: r.id, name: r.name, status: st[r.status_id] || r.status_id, price: r.price || 0,
        paid: r.pay_ts ? new Date(r.pay_ts * 1000).toLocaleDateString("ru-RU", { timeZone: "Europe/Moscow" }) : "" });
    }
  }
}

(async () => {
  if (!found.length) { console.log(new Date().toISOString(), "оплат нет"); return; }
  const li = found.map((f) => `<li>${f.who}: <a href="${link(f.id)}">${f.name || "сделка " + f.id}</a> — ${f.status}` +
    `${f.price ? ", " + f.price.toLocaleString("ru-RU") + " ₽" : ""}${f.paid ? ", оплата " + f.paid : ""}</li>`).join("");
  const html = `<div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.5">
<p>По клиенту ВНЖ из рекламы Facebook/Instagram появилась оплата или успешная сделка в amoCRM:</p><ul>${li}</ul></div>`;
  const r = await sendMail({ to: TO, subject: "ВНЖ из рекламы Facebook/Instagram: есть оплата", html,
    text: html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ") });
  if (r && r.ok === false) { console.log("письмо не ушло:", r.error); process.exit(1); }
  found.forEach((f) => { state.sent[f.id] = new Date().toISOString(); });
  fs.writeFileSync(STATE, JSON.stringify(state, null, 1));
  console.log(new Date().toISOString(), "отправлено", found.map((f) => f.id).join(","));
})();
