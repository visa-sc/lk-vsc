#!/usr/bin/env node
// Отчёт «откуда клиенты» по eSIM и картам за N дней (14.09.2026).
//
//   node tools/adsReport.js          — последние 7 дней
//   node tools/adsReport.js 30       — последние 30 дней
//   node tools/adsReport.js 30 --csv — оплаченные eSIM с Google-кликом в формате
//                                      загрузки офлайн-конверсий Google Ads
//
// Источники: .esim/orders.json (поле ads), .vscomClicks.json (просмотры и
// переходы со страницы visa-sc.com/virtual_card, поля utm/touch),
// .cards/clicks.json (кнопки карт в кабинете VOYO, с телефоном клиента).
// Запускать на проде из /var/www/voyo. Ничего не пишет.

const fs = require("fs");
const path = require("path");
const ads = require("../adsource");

const ROOT = path.join(__dirname, "..");
const days = Number(process.argv.find((a) => /^\d+$/.test(a))) || 7;
const since = Date.now() - days * 864e5;
const read = (f, d) => { try { return JSON.parse(fs.readFileSync(path.join(ROOT, f), "utf8")); } catch (_) { return d; } };
const msk = ads.mskTime;

// ── офлайн-конверсии для Google Ads ──
if (process.argv.includes("--csv")) {
  const name = process.env.ESIM_AW_OFFLINE_NAME || "Покупка eSIM";
  console.log("Parameters:TimeZone=Europe/Moscow");
  console.log("Google Click ID,Conversion Name,Conversion Time,Conversion Value,Conversion Currency");
  read(".esim/orders.json", []).filter((o) => o.status === "done" && (o.paidAt || o.ts) >= since).forEach((o) => {
    const g = ads.gclidOf(o.ads);
    if (!g) return;
    const d = new Date((o.paidAt || o.ts) + 3 * 3600e3).toISOString().replace("T", " ").slice(0, 19);
    console.log([g, name, d, o.priceRub || 0, "RUB"].join(","));
  });
  process.exit(0);
}

console.log("Откуда клиенты — последние " + days + " дн. (время МСК)\n");

// ── eSIM ──
const orders = read(".esim/orders.json", []).filter((o) => (o.ts || 0) >= since);
const paid = orders.filter((o) => o.status === "done");
console.log("eSIM: оплачено " + paid.length + ", всего попыток и заявок " + orders.length);
const byCh = {};
paid.forEach((o) => {
  const ch = o.tgChatId ? "телеграм-бот" : o.ads ? ads.channel(o.ads.last || o.ads.first) : "не определён";
  byCh[ch] = byCh[ch] || { n: 0, rub: 0 };
  byCh[ch].n++; byCh[ch].rub += o.priceRub || 0;
});
Object.entries(byCh).sort((a, b) => b[1].rub - a[1].rub)
  .forEach(([k, v]) => console.log("  " + k.padEnd(30) + v.n + " шт. · " + v.rub.toLocaleString("ru-RU") + " ₽"));
paid.forEach((o) => {
  console.log("  " + msk(o.paidAt || o.ts) + "  " + String(o.label || "").slice(0, 38).padEnd(38) + " " +
    String(o.priceRub || "").padStart(5) + " ₽  " + (o.tgChatId ? "телеграм-бот" : ads.describeAds(o.ads)));
});

// ── страница карт на visa-sc.com ──
const clicks = read(".vscomClicks.json", []).filter((c) => /virtual_card/.test(c.page || "") && Date.parse(c.at) >= since);
const chanOf = (c) => {
  const t = (c.touch && (c.touch.last || c.touch.first)) || (c.utm && Object.keys(c.utm).length ? c.utm : null);
  if (t) return ads.channel(t);
  // старые записи: метки остались только в адресе страницы
  try {
    const q = new URL(c.page).searchParams, u = {};
    ads.KEYS.forEach((k) => { if (q.get(k)) u[k] = q.get(k); });
    if (Object.keys(u).length) return ads.channel(u);
  } catch (_) {}
  return c.referrer ? ads.channel({ ref: c.referrer }) : "прямой заход";
};
const views = clicks.filter((c) => c.messenger === "view");
const cardGo = clicks.filter((c) => c.messenger === "card");
console.log("\nКарты, visa-sc.com/virtual_card: просмотров " + views.length + ", переходов к партнёру " + cardGo.length);
const tab = {};
views.forEach((c) => { const k = chanOf(c); tab[k] = tab[k] || { v: 0, c: 0 }; tab[k].v++; });
cardGo.forEach((c) => { const k = chanOf(c); tab[k] = tab[k] || { v: 0, c: 0 }; tab[k].c++; });
Object.entries(tab).sort((a, b) => b[1].v - a[1].v)
  .forEach(([k, v]) => console.log("  " + k.padEnd(30) + "просмотров " + String(v.v).padStart(3) + " · переходов " + v.c));
console.log("  Переходы к партнёру (сверять со временем регистрации в кабинете Anakondos):");
cardGo.forEach((c) => {
  const dev = /iPhone|Android/.test(c.ua || "") ? "телефон" : "компьютер";
  console.log("  " + msk(Date.parse(c.at)) + "  " + chanOf(c).padEnd(26) + " " + dev.padEnd(9) + " " + (c.ip || ""));
});

// ── раздел «Карты» в кабинете VOYO ──
const lk = read(".cards/clicks.json", []).filter((c) => (c.ts || 0) >= since && c.kind !== "call");
console.log("\nКарты, кабинет VOYO (/cards и /beta): переходов к партнёру " + lk.length);
lk.forEach((c) => console.log("  " + msk(c.ts) + "  " + c.kind.padEnd(12) + " " + (c.phone || "без входа")));

// ── языки телефонов (с 18.09.2026) ──
const langs = read(".esim/langs.json", { days: {} }).days || {};
const sinceDay = new Date(since + 3 * 3600e3).toISOString().slice(0, 10);
const byLang = {};
Object.keys(langs).filter((d) => d >= sinceDay).forEach((d) => {
  Object.entries(langs[d]).forEach(([l, v]) => {
    const k = l.split("-")[0].toLowerCase();
    const x = byLang[k] || (byLang[k] = { all: new Set(), ads: new Set(), paid: 0, rub: 0, fail: 0 });
    (v.all || []).forEach((id) => x.all.add(id));
    (v.ads || []).forEach((id) => x.ads.add(id));
  });
});
read(".esim/orders.json", []).filter((o) => (o.ts || 0) >= since && o.lang).forEach((o) => {
  const k = o.lang.split("-")[0].toLowerCase();
  const x = byLang[k] || (byLang[k] = { all: new Set(), ads: new Set(), paid: 0, rub: 0, fail: 0 });
  if (o.status === "done") { x.paid++; x.rub += o.priceRub || 0; } else x.fail++;
});
console.log("\neSIM по языку телефона (заходы на витрину / из них с рекламы / оплаты / не оплачено):");
Object.entries(byLang).sort((a, b) => b[1].all.size - a[1].all.size).forEach(([l, x]) =>
  console.log("  " + l.padEnd(4) + String(x.all.size).padStart(6) + String(x.ads.size).padStart(6) +
    String(x.paid).padStart(5) + " (" + x.rub + " ₽)" + String(x.fail).padStart(5)));
if (!Object.keys(byLang).length) console.log("  пока пусто: язык записывается с 18.09.2026");
