// ─────────────── Партнёрские промокоды eSIM (турагентства и прочие партнёры) ───────────────
// Андрей 29.09.2026: код VISAZEN для турагентства. Клиенту по нему сразу падает
// 100 ₽ на баланс, а партнёр получает 15% с каждой покупки приведённого клиента,
// не только с первой. Код бессрочный и применяется сколько угодно раз.
//
// Чем отличается от обычного промокода: скидки на цену он не даёт, поэтому
// маржа не режется. Клиент получает те же 100 ₽, но бонусами, которые спишутся
// с его следующей покупки, а партнёр зарабатывает на обороте.
//
// Хранилище: .esim/partners.json
//   { "VISAZEN": { name, pct, bonusRub, pass, ts,
//                  clients: { "почта": { firstAt, orders, spentRub, earnedRub } },
//                  log: [ { ts, orderId, cust, label, amountRub, earnedRub } ],
//                  payouts: [ { ts, rub, note } ] } }

const fs = require("fs");
const path = require("path");

const DIR = path.join(__dirname, ".esim");
const FILE = path.join(DIR, "partners.json");

function load() { try { return JSON.parse(fs.readFileSync(FILE, "utf8")); } catch (_) { return {}; } }
function save(all) {
  try { fs.mkdirSync(DIR, { recursive: true }); fs.writeFileSync(FILE, JSON.stringify(all, null, 1), "utf8"); }
  catch (e) { console.error("partners write:", e.message); }
}
const norm = (c) => String(c || "").trim().toUpperCase();

// Партнёр по коду. Настройки живут в промокоде (поле partner), чтобы у кода и
// партнёрской программы был один источник правды.
function ensure(code, cfg) {
  code = norm(code);
  const all = load();
  if (!all[code]) {
    all[code] = { name: (cfg && cfg.name) || code, pct: Number((cfg && cfg.pct) || 0),
      bonusRub: Number((cfg && cfg.bonusRub) || 0), pass: String((cfg && cfg.pass) || ""),
      ts: Date.now(), clients: {}, log: [], payouts: [] };
    save(all);
  } else if (cfg) {
    const p = all[code];
    let changed = false;
    ["name", "pass"].forEach((k) => { if (cfg[k] && p[k] !== cfg[k]) { p[k] = cfg[k]; changed = true; } });
    ["pct", "bonusRub"].forEach((k) => {
      if (cfg[k] != null && Number(p[k]) !== Number(cfg[k])) { p[k] = Number(cfg[k]); changed = true; }
    });
    if (changed) save(all);
  }
  return load()[code];
}

// К какому партнёру привязан клиент: один раз и навсегда, по первой покупке с кодом
function partnerOf(custKey) {
  const key = String(custKey || "").toLowerCase();
  if (!key) return null;
  const all = load();
  for (const code of Object.keys(all)) if (all[code].clients && all[code].clients[key]) return code;
  return null;
}

// Покупка оплачена: привязываем клиента, считаем процент партнёру, говорим,
// сколько бонусов начислить самому клиенту (первый раз по коду).
function onPaid({ code, custKey, orderId, label, amountRub }) {
  const key = String(custKey || "").toLowerCase();
  const sum = Math.max(0, Math.round(Number(amountRub) || 0));
  let c = norm(code);
  const all = load();
  if (!c || !all[c]) c = partnerOf(key) || "";        // покупка без кода, но клиент уже наш
  if (!c || !all[c] || !key) return null;
  const p = all[c];
  p.clients = p.clients || {};
  const first = !p.clients[key];
  if (first) p.clients[key] = { firstAt: Date.now(), orders: 0, spentRub: 0, earnedRub: 0 };
  const earned = Math.round(sum * Number(p.pct || 0)) / 100;
  const earnedRub = Math.round(earned);
  const cl = p.clients[key];
  cl.orders += 1; cl.spentRub += sum; cl.earnedRub += earnedRub; cl.lastAt = Date.now();
  p.log = [{ ts: Date.now(), orderId: orderId || null, cust: key, label: label || "",
    amountRub: sum, earnedRub }].concat(p.log || []).slice(0, 2000);
  save(all);
  return { code: c, earnedRub, first, bonusRub: first ? Number(p.bonusRub || 0) : 0, name: p.name };
}

// Сводка для страницы партнёра
const maskMail = (s) => {
  const m = /^([^@]+)@(.+)$/.exec(String(s || ""));
  if (!m) return String(s || "").replace(/\d(?=\d{2})/g, "*");
  const n = m[1];
  return (n.length <= 2 ? n[0] + "*" : n.slice(0, 2) + "*".repeat(Math.max(2, n.length - 2))) + "@" + m[2];
};
function stats(code) {
  code = norm(code);
  const p = load()[code];
  if (!p) return null;
  const clients = Object.keys(p.clients || {}).map((k) => Object.assign({ key: maskMail(k) }, p.clients[k]))
    .sort((a, b) => (b.lastAt || b.firstAt || 0) - (a.lastAt || a.firstAt || 0));
  const earned = clients.reduce((a, x) => a + (x.earnedRub || 0), 0);
  const spent = clients.reduce((a, x) => a + (x.spentRub || 0), 0);
  const orders = clients.reduce((a, x) => a + (x.orders || 0), 0);
  const paid = (p.payouts || []).reduce((a, x) => a + (Number(x.rub) || 0), 0);
  const month = new Date(Date.now() + 3 * 3600e3).toISOString().slice(0, 7);
  const earnedMonth = (p.log || []).filter((l) => new Date(l.ts + 3 * 3600e3).toISOString().slice(0, 7) === month)
    .reduce((a, l) => a + (l.earnedRub || 0), 0);
  return {
    code, name: p.name, pct: p.pct, bonusRub: p.bonusRub,
    clients, clientCount: clients.length, orders, spentRub: spent,
    earnedRub: earned, earnedMonth, paidRub: paid, dueRub: earned - paid,
    log: (p.log || []).slice(0, 100).map((l) => ({ ts: l.ts, cust: maskMail(l.cust), label: l.label,
      amountRub: l.amountRub, earnedRub: l.earnedRub })),
    payouts: p.payouts || [],
  };
}
function checkPass(code, pass) {
  const p = load()[norm(code)];
  return !!p && String(pass || "") === String(p.pass || "");
}
// Выплата партнёру: записываем, чтобы «к выплате» считалось само
function addPayout(code, rub, note) {
  const all = load();
  const p = all[norm(code)];
  if (!p) return null;
  p.payouts = [{ ts: Date.now(), rub: Math.round(Number(rub) || 0), note: String(note || "").slice(0, 120) }]
    .concat(p.payouts || []).slice(0, 500);
  save(all);
  return stats(code);
}

module.exports = { ensure, onPaid, stats, checkPass, addPayout, partnerOf, load };
