// ═══════════════════════════════════════════════════════════════════════════
// Сторож баланса Anthropic (переписан 12.09.2026 после того, как деньги
// кончились молча и API отключили).
//
// Почему старый не сработал. Он жил в движке переводов, считал расход ТОЛЬКО
// по заказам переводов, стартовую сумму держал прибитой ($20 от 10.08) и слал
// РОВНО ОДНО письмо за всё время: после первого письма 26.08 ставился маркер
// alertedAt и сторож замолкал навсегда. Пополнения он не видел, расход сканера
// и служебных прогонов — тоже.
//
// Как считаем теперь. Обычному API-ключу баланс в Anthropic не виден, поэтому
// остаток = последнее пополнение минус ВЕСЬ расход после него. Расход берём из
// двух журналов, которые пишутся на нашей стороне:
//   • .engineBudget.json — шлюз /internal/anthropic в engine-proxy. Через него
//     идёт весь трафик движка переводов, включая служебные прогоны и сверки;
//   • .scanner/store.json — распознавание паспортов, оно ходит в Anthropic мимо
//     шлюза, своим ключом.
// День пополнения засчитываем в расход целиком: в журнале шлюза суток без часов,
// и лучше показать остаток чуть меньше реального, чем проспать ноль.
//
// Пороги и частота (слова Андрея 12.09.2026):
//   • остаток ≤ $7 — одно письмо, больше по этому порогу не тревожим;
//   • остаток ≤ $5 — письмо каждый день утром, пока не пополнят.
// Пополнение сбрасывает оба счётчика.
//
// Окно доставки — рабочее: с 08:00 понедельника до 15:00 пятницы МСК. Само окно
// и очередь отложенных писем уже реализованы в server.js, сюда они приходят
// функцией send: в выходные письмо не теряется, а ждёт утра понедельника.
//
// Пополнили счёт — записать сумму:  node tools/ai-topup.js 20
// ═══════════════════════════════════════════════════════════════════════════
const fs = require("fs");
const path = require("path");

const FILE = path.join(__dirname, ".aiBalance.json");
const ENGINE_BUDGET = path.join(__dirname, ".engineBudget.json");
const SCANNER_STORE = path.join(__dirname, ".scanner", "store.json");

// $ за 1M токенов: [вход, выход] — как в движке и сканере.
const PRICES = { "claude-opus-5": [5, 25], "claude-sonnet-5": [3, 15], "claude-haiku-4-5": [1, 5] };
const WARN_USD = Number(process.env.AI_BALANCE_WARN_USD || 7);
const ALERT_USD = Number(process.env.AI_BALANCE_ALERT_USD || 5);
const TO = "director@visa-sc.ru";

function load() {
  try { return JSON.parse(fs.readFileSync(FILE, "utf8")); } catch (_) { return null; }
}
function save(d) {
  try { fs.writeFileSync(FILE, JSON.stringify(d, null, 2), "utf8"); return true; }
  catch (e) { console.error("aiBalance save:", e.message); return false; }
}
function init() {
  let d = load();
  if (!d) { d = { topups: [], warnSentAt: null, lastDailyDay: null }; save(d); }
  return d;
}
// Пополнение: сумма в долларах. Сбрасывает маркеры, чтобы предупреждения
// заработали заново.
function addTopup(usd, note) {
  const d = init();
  d.topups.push({ at: Date.now(), usd: Number(usd), note: note || "" });
  d.warnSentAt = null;
  d.lastDailyDay = null;
  save(d);
  return d;
}
function lastTopup() {
  const d = init();
  if (!d.topups.length) return null;
  return d.topups[d.topups.length - 1];
}

// ── Расход после момента ts ──────────────────────────────────────────────────
function spendGatewayUsd(sinceTs) {
  // Журнал шлюза по дням: {"2026-09-12": {usd, calls}}. День пополнения берём целиком.
  let usd = 0, calls = 0;
  try {
    const b = JSON.parse(fs.readFileSync(ENGINE_BUDGET, "utf8"));
    const sinceDay = new Date(sinceTs + 3 * 3600 * 1000).toISOString().slice(0, 10);
    for (const [day, v] of Object.entries(b.days || {})) {
      if (day < sinceDay) continue;
      usd += v.usd || 0; calls += v.calls || 0;
    }
  } catch (_) {}
  return { usd, calls };
}
function spendScannerUsd(sinceTs) {
  let usd = 0, docs = 0;
  try {
    const st = JSON.parse(fs.readFileSync(SCANNER_STORE, "utf8"));
    for (const doc of st.docs || []) {
      if ((doc.at || 0) < sinceTs) continue;
      docs++;
      for (const e of doc.spend || []) {
        const p = PRICES[e.model] || PRICES["claude-haiku-4-5"];
        usd += ((e.in || 0) + (e.cr || 0) * 0.1 + (e.cw || 0) * 1.25) * p[0] / 1e6 + (e.out || 0) * p[1] / 1e6;
      }
    }
  } catch (_) {}
  return { usd, docs };
}
// Текущая картина: сколько положили, сколько потратили, сколько осталось.
function status() {
  const t = lastTopup();
  if (!t) return { known: false, message: "сумма пополнения не задана — node tools/ai-topup.js <сумма в $>" };
  const gw = spendGatewayUsd(t.at);
  const sc = spendScannerUsd(t.at);
  const spent = gw.usd + sc.usd;
  return {
    known: true, topupUsd: t.usd, topupAt: t.at,
    spentUsd: spent, leftUsd: t.usd - spent,
    gateway: gw, scanner: sc,
  };
}

// ── Письма ───────────────────────────────────────────────────────────────────
function money(v) { return "$" + (Math.round(v * 100) / 100).toFixed(2); }
function html(s, daily) {
  const d = new Date(s.topupAt + 3 * 3600 * 1000);
  const p = (n) => String(n).padStart(2, "0");
  const when = p(d.getUTCDate()) + "." + p(d.getUTCMonth() + 1) + "." + d.getUTCFullYear();
  return '<p><b>Баланс Claude API подходит к концу.</b></p>'
    + '<p>Осталось примерно <b>' + money(s.leftUsd) + '</b>.'
    + (daily ? ' Это письмо будет приходить каждое утро, пока счёт не пополнят.' : '')
    + '</p>'
    + '<table style="border-collapse:collapse;font-size:14px;">'
    + '<tr><td style="padding:4px 12px 4px 0;">Пополнение от ' + when + '</td><td style="padding:4px 0;"><b>' + money(s.topupUsd) + '</b></td></tr>'
    + '<tr><td style="padding:4px 12px 4px 0;">Потрачено с тех пор</td><td style="padding:4px 0;"><b>' + money(s.spentUsd) + '</b></td></tr>'
    + '<tr><td style="padding:4px 12px 4px 0;">Переводы документов</td><td style="padding:4px 0;">' + money(s.gateway.usd) + ' за ' + s.gateway.calls + ' обращений</td></tr>'
    + '<tr><td style="padding:4px 12px 4px 0;">Сканер паспортов</td><td style="padding:4px 0;">' + money(s.scanner.usd) + ' за ' + s.scanner.docs + ' документов</td></tr>'
    + '</table>'
    + '<p style="color:#666;font-size:13px;">Когда пополните, скажите Клоду сумму — он запишет её, и счётчик пойдёт заново. '
    + 'Без этого остаток будет считаться от прошлого пополнения и уйдёт в минус.</p>';
}

// ── Проверка ─────────────────────────────────────────────────────────────────
// send(m) — функция отправки из server.js (sendOrQueueDirectorMail): она сама
// откладывает письмо, если сейчас нерабочее время.
function check(send, why) {
  const d = init();
  const s = status();
  if (!s.known) return s;
  const today = new Date(Date.now() + 3 * 3600 * 1000).toISOString().slice(0, 10);

  if (s.leftUsd <= ALERT_USD) {
    // Ниже $5 — письмо каждый день, но не чаще одного за сутки.
    if (d.lastDailyDay === today) return s;
    d.lastDailyDay = today; save(d);
    send({ to: TO, subject: "Claude API: осталось " + money(s.leftUsd) + " — пополните счёт", html: html(s, true) });
    console.log("AI BALANCE [" + (why || "cron") + "]: остаток " + money(s.leftUsd) + " ≤ " + money(ALERT_USD) + " — письмо (ежедневное)");
    return s;
  }
  if (s.leftUsd <= WARN_USD) {
    // Ниже $7 — одно письмо до следующего пополнения.
    if (d.warnSentAt) return s;
    d.warnSentAt = Date.now(); save(d);
    send({ to: TO, subject: "Claude API: осталось " + money(s.leftUsd) + "", html: html(s, false) });
    console.log("AI BALANCE [" + (why || "cron") + "]: остаток " + money(s.leftUsd) + " ≤ " + money(WARN_USD) + " — разовое письмо");
  }
  return s;
}

// Проверяем раз в час: расход идёт неравномерно, а письма всё равно уходят не
// чаще раза в сутки (ниже $5) или один раз (ниже $7).
function schedule(send) {
  init();
  setInterval(() => { try { check(send, "cron"); } catch (e) { console.error("aiBalance:", e.message); } }, 60 * 60 * 1000);
  setTimeout(() => { try { check(send, "startup"); } catch (_) {} }, 3 * 60 * 1000);
  console.log("AI BALANCE: сторож баланса Anthropic — проверка раз в час, пороги " + money(WARN_USD) + " (разово) и " + money(ALERT_USD) + " (ежедневно)");
}

module.exports = { init, addTopup, status, check, schedule, load, save };
