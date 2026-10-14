#!/usr/bin/env node
// Ежедневный отчёт по тесту рекламы Meta (13.10.2026) — письмо на director@.
//
// Расписание (cron на проде): будни 08:00 МСК, с понедельника 08:00 до пятницы
// 15:00 — то есть в 08:00 пн–пт. По каждой кампании: вчера и всего с запуска —
// заходы с рекламы Meta, целевые действия, заявки/покупки. Расход и показы —
// только если в .env есть META_ADS_TOKEN (ключ из сетапа BroCard); без него
// письмо строится по нашему трафику.
//
// Сам отключается: когда трафика из Meta нет 3 дня подряд (кончились деньги,
// кампании остановлены) — шлёт последнее письмо «тест закончился» и больше не
// пишет (отметка в .metaReport.json). Сброс: удалить отметку или --force.
//
//   node tools/metaReport.js           — посчитать и отправить
//   node tools/metaReport.js --dry     — показать письмо в консоли, не отправлять
//   node tools/metaReport.js --force   — отправить, даже если тест помечен законченным
//
// Источники: .vscomClicks.json (заходы, начало формы, шаги ETA, звонки,
// мессенджеры), .vscomLeads.json (заявки), .esim/funnel.json (воронка eSIM по
// посетителям с меткой fb), .esim/orders.json (оплаченные eSIM с utm Meta).

require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });
const fs = require("fs");
const path = require("path");
const axios = require("axios");

const ROOT = path.join(__dirname, "..");
const STATE = path.join(ROOT, ".metaReport.json");
const START = Date.parse("2026-10-13T00:00:00+03:00");      // запуск теста
const QUIET_DAYS = 3;                                          // столько дней без трафика — тест закончен
const TO = process.env.META_REPORT_TO || "director@visa-sc.ru";
const AD_ACCOUNT = "act_967550992793200";
const dry = process.argv.includes("--dry"), force = process.argv.includes("--force");

const read = (f, d) => { try { return JSON.parse(fs.readFileSync(path.join(ROOT, f), "utf8")); } catch (_) { return d; } };
const mskDay = (t) => new Date(t + 3 * 3600e3).toISOString().slice(0, 10);
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const n = (v) => (v || 0).toLocaleString("ru-RU");

// Кампании теста: как узнать их трафик в наших журналах
const CAMPAIGNS = [
  // ВНЖ: две страницы — своя spain/fb и копия visa-sc.ru/spain_vnzh на visa-sc.com
  // (с 14.10.2026 обе крутятся в одной группе, через неделю сравнить и слабую выключить).
  { key: "vnj_ru", name: "ВНЖ Испании", kind: "lead", forms: ["spain-fb"], copy: /^\/spain_vnzh/, goal: "заявка" },
  // США и Великобритания (с 14.10.2026) — копии visa-sc.ru/usa и /britain на visa-sc.com
  { key: "usa_ru", name: "Виза в США", kind: "lead", forms: ["usa-fb"], copy: /^\/(usa|amerika)\b/, goal: "заявка" },
  { key: "uk_ru", name: "Виза в Великобританию", kind: "lead", forms: ["uk-fb"], copy: /^\/(britain|angliya)\b/, goal: "заявка" },
  // ETA (US/BR/ES/IT) выключены 14.10.2026 — в отчёт не включаем.
  // Включат — вернуть: { key: "eta_us", name: "ETA США", kind: "eta", forms: ["us-gb"], goal: "начал форму" }
  { key: "esim_ru", name: "eSIM VOYO mobile", kind: "esim", goal: "покупка" },
];

const isMeta = (u) => {
  if (!u) return false;
  const s = String(u.utm_source || "").toLowerCase();
  return !!u.fbclid || /^(facebook|instagram|fb|ig)$/.test(s);
};
const campOf = (u) => String((u && u.utm_campaign) || "").toLowerCase();

// ── сайты визовых услуг: клики и заявки ──
function siteStats(c, from, to) {
  const inR = (t) => t >= from && t < to;
  const clicks = read(".vscomClicks.json", []).filter((x) => {
    const t = Date.parse(x.at);
    return inR(t) && (c.forms.indexOf(x.form) >= 0 || campOf(x.utm) === c.key) &&
      (isMeta(x.utm) || campOf(x.utm) === c.key);
  });
  const leads = read(".vscomLeads.json", []).filter((x) => {
    const t = Date.parse(x.at);
    return inR(t) && (isMeta(x.utm) || campOf(x.utm) === c.key) &&
      (c.forms.indexOf(x.form) >= 0 || campOf(x.utm) === c.key) && !/тест|test|teste/i.test(x.name || "");
  });
  const cnt = (what) => clicks.filter((x) => x.messenger === what).length;
  return {
    visits: cnt("view"),
    formStart: cnt("form_start"),
    phone: cnt("phone"),
    msgr: cnt("whatsapp") + cnt("telegram"),
    leads: leads.length + copyLeads(c, from, to),
  };
}

// Заявки с копий visa-sc.ru на visa-sc.com: их принимает mskcopy (формы Flexbe),
// пишет в свой leads.json с host visa-sc.com; в amoCRM везёт pm2 «fb-amo».
const COPY_LEADS = process.env.META_COPY_LEADS || "/var/www/mskcopy/leads.json";
function copyLeads(c, from, to) {
  if (!c.copy) return 0;
  let list = [];
  try { list = JSON.parse(fs.readFileSync(COPY_LEADS, "utf8")); } catch (_) { return 0; }
  if (!Array.isArray(list)) list = list.leads || [];
  return list.filter((l) => {
    const t = Date.parse(l.at);
    if (!(t >= from && t < to) || !/(^|\.)visa-sc\.com$/.test(l.host || "")) return false;
    if (l.amo && l.amo.skipped) return false;                 // помеченные тестовыми
    let u = {};
    try { u = JSON.parse((l.data && l.data.utmData) || "{}"); } catch (_) {}
    if (/test/i.test(u.utm_campaign || "")) return false;
    return c.copy.test(l.pageUrl || "") && (isMeta(u) || campOf(u) === c.key);
  }).length;
}

// ── eSIM: воронка по посетителям с меткой fb ──
function esimStats(from, to) {
  const f = read(".esim/funnel.json", { days: {} });
  const fbVids = new Set(Object.keys(f.fb || {}));
  const days = Object.keys(f.days || {}).filter((d) => d >= mskDay(from) && d < mskDay(to));
  const step = (s) => {
    const u = new Set();
    days.forEach((d) => (((f.days[d] || {}).site || {})[s] || []).forEach((v) => { if (fbVids.has(v)) u.add(v); }));
    return u.size;
  };
  const orders = read(".esim/orders.json", []).filter((o) => {
    const t = o.paidAt || o.ts;
    const a = (o.ads && (o.ads.last || o.ads.first || o.ads)) || {};
    return t >= from && t < to && (o.status === "done" || o.status === "paid") &&
      (isMeta(a) || fbVids.has(o.vid));
  });
  return {
    visits: step("visit"), pack: step("pack"), checkout: step("buy"), pay: step("pay"),
    orders: orders.length, revenue: orders.reduce((s, o) => s + (o.priceRub || 0), 0),
  };
}

// ── расход и показы из Meta (если есть ключ) ──
async function metaInsights(since, until) {
  const token = process.env.META_ADS_TOKEN;
  if (!token) return null;
  try {
    const r = await axios.get("https://graph.facebook.com/v21.0/" + AD_ACCOUNT + "/insights", {
      params: { access_token: token, level: "campaign", time_range: JSON.stringify({ since, until }),
        fields: "campaign_name,spend,impressions,clicks,ctr,cpc", limit: 50 },
      timeout: 20000,
    });
    const out = {};
    (r.data.data || []).forEach((x) => { out[x.campaign_name] = x; });
    return out;
  } catch (e) {
    return { _error: (e.response && e.response.data && e.response.data.error && e.response.data.error.message) || e.message };
  }
}
const META_NAMES = { vnj_ru: "VSC VNJ Spain RU", usa_ru: "VSC USA RU", uk_ru: "VSC UK RU", eta_us: "VSC ETA US", eta_br: "VSC ETA BR",
  eta_es: "VSC ETA ES", eta_it: "VSC ETA IT", esim_ru: "VSC eSIM RU" };

function rowsFor(c, s) {
  if (c.kind === "esim") return [
    ["Заходы с рекламы", s.visits], ["Открыли пакет", s.pack], ["Открыли оформление", s.checkout],
    ["Ушли на оплату", s.pay], ["Оплатили", s.orders], ["Выручка", n(s.revenue) + " ₽"],
  ];
  const r = [["Заходы с рекламы", s.visits], ["Начали форму", s.formStart]];
  r.push(["Заявки", s.leads], ["Клики по телефону", s.phone], ["Мессенджеры", s.msgr]);
  return r;
}
const total = (c, s) => c.kind === "esim" ? s.visits + s.pack + s.orders : s.visits + s.formStart + s.leads + s.phone + s.msgr;

(async () => {
  const st = read(".metaReport.json", {});
  if (st.finished && !force) { console.log("тест помечен законченным " + st.finished + " — письмо не шлём"); return; }

  const now = Date.now();
  const today0 = Date.parse(mskDay(now) + "T00:00:00+03:00");
  const y0 = today0 - 864e5;
  const yDay = mskDay(y0);

  const stats = CAMPAIGNS.map((c) => {
    const fn = c.kind === "esim" ? esimStats : (a, b) => siteStats(c, a, b);
    return { c, day: fn(y0, today0), all: fn(START, today0) };
  });
  const ins = await metaInsights(yDay, yDay);
  const insAll = await metaInsights(mskDay(START), yDay);

  // тишина: сколько последних дней подряд нет ни одного действия из Meta
  let quiet = 0;
  for (let d = 0; d < QUIET_DAYS; d++) {
    const a = today0 - (d + 1) * 864e5, b = today0 - d * 864e5;
    const any = CAMPAIGNS.some((c) => total(c, c.kind === "esim" ? esimStats(a, b) : siteStats(c, a, b)) > 0);
    if (any) break;
    quiet++;
  }
  const started = today0 - START >= QUIET_DAYS * 864e5;   // первые дни идёт модерация — не путать с концом
  const finishing = started && quiet >= QUIET_DAYS;

  const spendCell = (key, src) => {
    if (!src) return "";
    if (src._error) return "";
    const x = src[META_NAMES[key]];
    return x ? "$" + Number(x.spend || 0).toFixed(2) + " · " + n(+x.impressions) + " показов · " + n(+x.clicks) + " кликов" : "$0";
  };

  let html = '<div style="font-family:Arial,sans-serif;font-size:14px;color:#1b1f21;max-width:720px">' +
    "<h2 style=\"margin:0 0 6px;font-size:18px\">Реклама Meta: отчёт за " + esc(yDay) + "</h2>" +
    '<p style="margin:0 0 14px;color:#6b7280">Тест с 13.10.2026. Вчера / всего с запуска. Считаем только переходы из Facebook и Instagram.</p>';
  if (finishing) html += '<p style="margin:0 0 14px;padding:10px 12px;background:#fff4e5;border-radius:8px"><b>Трафика из Meta нет ' + QUIET_DAYS +
    " дня подряд — похоже, деньги закончились или кампании остановлены. Это последнее письмо.</b></p>";
  if (ins && ins._error) html += '<p style="margin:0 0 14px;color:#b8351a">Расход из Meta не получен: ' + esc(ins._error) + "</p>";
  if (!ins) html += '<p style="margin:0 0 14px;color:#6b7280">Расход и показы не подключены (нет ключа Meta) — цифры по нашему трафику.</p>';

  stats.forEach(({ c, day, all }) => {
    const rows = rowsFor(c, day), rowsAll = rowsFor(c, all);
    html += '<h3 style="margin:18px 0 6px;font-size:15px">' + esc(c.name) +
      ' <span style="font-weight:normal;color:#6b7280">· цель: ' + esc(c.goal) + (c.off ? " · кампания выключена" : "") + "</span></h3>";
    const sp = spendCell(c.key, ins), spAll = spendCell(c.key, insAll);
    if (sp || spAll) html += '<p style="margin:0 0 6px">Meta вчера: ' + esc(sp || "—") + "<br>Meta всего: " + esc(spAll || "—") + "</p>";
    html += '<table style="border-collapse:collapse">' + rows.map((r, i) =>
      '<tr><td style="padding:3px 14px 3px 0;color:#6b7280">' + esc(r[0]) + '</td><td style="padding:3px 14px 3px 0"><b>' +
      esc(r[1]) + '</b></td><td style="padding:3px 0;color:#6b7280">' + esc(rowsAll[i][1]) + "</td></tr>").join("") + "</table>";
  });
  html += '<p style="margin:18px 0 0;color:#9aa1ad;font-size:12px">Письмо приходит по будням в 08:00 МСК, пока идёт трафик из Meta. tools/metaReport.js</p></div>';

  const text = html.replace(/<br>/g, "\n").replace(/<\/(p|h2|h3|tr)>/g, "\n").replace(/<[^>]+>/g, " ").replace(/[ \t]+/g, " ");
  if (dry) { console.log(text); return; }

  const { sendMail } = require("../mail");
  const res = await sendMail({ to: TO, subject: (finishing ? "Meta: тест закончился · " : "Meta: отчёт за ") + yDay, html, text });
  if (!res.ok) { console.error("письмо не ушло:", res.error); process.exit(1); }
  st.lastSent = new Date().toISOString();
  if (finishing) st.finished = new Date().toISOString();
  fs.writeFileSync(STATE, JSON.stringify(st, null, 2));
  console.log("отправлено", TO, finishing ? "(последнее)" : "");
})();
