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
// Часов в журнале шлюза нет, только сутки, поэтому «расход после пополнения»
// считаем не по дате, а по срезу: в момент пополнения запоминаем, сколько всего
// потрачено за всё время, и потом вычитаем это число. Тогда траты того же дня до
// пополнения не приписываются новым деньгам.
//
// Пороги и частота (Андрей 21.09.2026, было $7/$5):
//   • остаток ≤ $20 — одно письмо, больше по этому порогу не тревожим;
//   • остаток ≤ $15 — письмо каждый день утром, пока не пополнят.
// Пополнение сбрасывает оба счётчика.
//
// Окно доставки — рабочее: с 08:00 понедельника до 15:00 пятницы МСК. Само окно
// и очередь отложенных писем уже реализованы в server.js, сюда они приходят
// функцией send: в выходные письмо не теряется, а ждёт утра понедельника.
//
// В письме: остаток, текущий и прошлый месяц с разбивкой по сервисам, какая
// модель работала в каждом, и кнопка пополнения. Остатка в API нет ни у
// обычного ключа, ни у админского (там только отчёты о расходе), поэтому
// точку отсчёта задаём руками по консоли:
//   node tools/ai-topup.js 6.98      ← ФАКТИЧЕСКИЙ остаток из консоли
// ═══════════════════════════════════════════════════════════════════════════
const fs = require("fs");
const path = require("path");

const FILE = path.join(__dirname, ".aiBalance.json");
const ENGINE_BUDGET = path.join(__dirname, ".engineBudget.json");
const SCANNER_STORE = path.join(__dirname, ".scanner", "store.json");

// $ за 1M токенов: [вход, выход] — как в движке и сканере.
const PRICES = { "claude-opus-5": [5, 25], "claude-sonnet-5": [3, 15], "claude-haiku-4-5": [1, 5] };
const WARN_USD = Number(process.env.AI_BALANCE_WARN_USD || 20);
const ALERT_USD = Number(process.env.AI_BALANCE_ALERT_USD || 15);
// Получатели: Андрей и Катя Зайцева (её просьба Андрея 21.09.2026 — она первой
// замечает, что прослушка встала). Список через запятую, nodemailer это понимает.
const TO = process.env.AI_BALANCE_TO || "director@visa-sc.ru, ekaterina.z@visa-sc.ru";

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
  const gw = spendGatewayTotal(), sc = spendScannerTotal();
  d.topups.push({
    at: Date.now(), usd: Number(usd), note: note || "",
    // срез счётчиков на момент пополнения — от него считаем новый расход
    baseGatewayUsd: gw.usd, baseGatewayCalls: gw.calls,
    baseSvc: gw.svc || {},
    baseScannerUsd: sc.usd, baseScannerDocs: sc.docs,
  });
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
// Накопленный расход за всё время — по каждому журналу отдельно.
// Названия сервисов для письма. Идентификаторы ставит шлюз (engine-proxy.svcOf).
const SVC_TITLES = { translate: "Переводы документов", cq: "Прослушка (качество коммуникации)", scanner: "Сканер паспортов" };
function spendGatewayTotal() {
  let usd = 0, calls = 0; const svc = {};
  try {
    const b = JSON.parse(fs.readFileSync(ENGINE_BUDGET, "utf8"));
    for (const v of Object.values(b.days || {})) {
      usd += v.usd || 0; calls += v.calls || 0;
      for (const [id, t] of Object.entries(v.svc || {})) {
        const a = svc[id] || (svc[id] = { usd: 0, calls: 0 });
        a.usd += t.usd || 0; a.calls += t.calls || 0;
      }
    }
  } catch (_) {}
  return { usd, calls, svc };
}
function spendScannerTotal() {
  let usd = 0, docs = 0;
  try {
    const st = JSON.parse(fs.readFileSync(SCANNER_STORE, "utf8"));
    for (const doc of st.docs || []) {
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
  const t0 = lastTopup(), t = t0;
  if (!t) return { known: false, message: "сумма пополнения не задана — node tools/ai-topup.js <сумма в $>" };
  const gwAll = spendGatewayTotal(), scAll = spendScannerTotal();
  // Для пополнений, записанных до появления срезов, база — ноль: тогда расход
  // посчитается с начала журналов, остаток будет занижен, но не завышен.
  const gw = {
    usd: Math.max(0, gwAll.usd - (t.baseGatewayUsd || 0)),
    calls: Math.max(0, gwAll.calls - (t.baseGatewayCalls || 0)),
  };
  const sc = {
    usd: Math.max(0, scAll.usd - (t.baseScannerUsd || 0)),
    docs: Math.max(0, scAll.docs - (t.baseScannerDocs || 0)),
  };
  // Разбивка по сервисам. Дни до 16.09.2026 писались без неё — этот остаток
  // показываем отдельной строкой «до разделения», чтобы сумма всегда сходилась.
  const svc = [];
  let svcSum = 0;
  for (const [id, t] of Object.entries(gwAll.svc || {})) {
    const b = (t0.baseSvc && t0.baseSvc[id]) || { usd: 0, calls: 0 };
    const v = Math.max(0, (t.usd || 0) - (b.usd || 0));
    const c = Math.max(0, (t.calls || 0) - (b.calls || 0));
    if (v > 0 || c > 0) { svc.push({ id, title: SVC_TITLES[id] || id, usd: v, calls: c }); svcSum += v; }
  }
  svc.sort((a, b) => b.usd - a.usd);
  const undivided = Math.max(0, gw.usd - svcSum);
  const spent = gw.usd + sc.usd;
  return {
    known: true, topupUsd: t.usd, topupAt: t.at,
    spentUsd: spent, leftUsd: t.usd - spent,
    gateway: gw, scanner: sc, svc, undividedUsd: undivided,
  };
}

// ── Расход по месяцам ────────────────────────────────────────────────────────
// В письме нужны прошлый и текущий месяц, разложенные по сервисам так, чтобы
// строки складывались в итог месяца. Источник итога — журнал шлюза (он видит
// фактический usage от API) плюс сканер, который ходит своим ключом мимо шлюза.
//
// Загвоздка: шлюз помечает вызовы сервисами только с 16.09.2026. За более ранние
// дни разбивки нет, и раньше в письме висела отдельная строка «без разделения» —
// из-за неё сумма строк не сходилась с итогом. Теперь за такие дни прослушку
// берём из журналов Кати (у неё записана стоимость каждой проверки), а переводы
// считаем как остаток дня. Итог месяца при этом всегда равен сумме строк, а
// служебные прогоны движка попадают в переводы — что по смыслу верно.
const MONTH_NAMES = ["январь", "февраль", "март", "апрель", "май", "июнь",
  "июль", "август", "сентябрь", "октябрь", "ноябрь", "декабрь"];
const MODEL_NAMES = { "claude-opus-5": "Opus 5", "claude-sonnet-5": "Sonnet 5", "claude-haiku-4-5": "Haiku 4.5" };
const SVC_ORDER = ["translate", "cq", "scanner"];
const SVC_SHORT = { translate: "Переводы", cq: "Прослушка", scanner: "Сканер паспортов" };
// Единицы для счётчика: у каждого сервиса своя работа, «обращения» ни о чём не говорят.
const SVC_UNIT = {
  translate: ["перевод", "перевода", "переводов"],
  cq: ["проверка", "проверки", "проверок"],
  scanner: ["паспорт", "паспорта", "паспортов"],
};
const CQ_DIR = process.env.CQ_DATA_DIR || "/var/www/kateadmin/data";
const TRANSLATE_ORDERS = process.env.TRANSLATE_ORDERS_FILE || "/var/www/translate-engine/.translate/orders.json";
const RUB = Number(process.env.TRANSLATE_USD_RUB || 80);

function plural(n, forms) {
  const a = Math.abs(n) % 100, b = a % 10;
  if (a > 10 && a < 20) return forms[2];
  if (b > 1 && b < 5) return forms[1];
  if (b === 1) return forms[0];
  return forms[2];
}
function mskDay(t) { return new Date(new Date(t).getTime() + 3 * 3600 * 1000).toISOString().slice(0, 10); }
function ymShift(ym, n) {
  const [y, m] = ym.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1 + n, 1)).toISOString().slice(0, 7);
}
function ymTitle(ym) {
  const m = Number(ym.slice(5, 7));
  return (MONTH_NAMES[m - 1] || ym).replace(/^./, (c) => c.toUpperCase());
}
function readJson(p) { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch (_) { return null; } }

// Прослушка из журналов Кати: проверки диалогов, вычитка расшифровок звонков
// (поле cleanCost — отдельная статья, её легко упустить) и отчёты. Стоимость
// у неё в рублях по тому же курсу, что у нас.
function cqJournal() {
  const byDay = {}, byMonth = {};
  const put = (when, usd, isCheck, model) => {
    if (!when) return;
    const day = mskDay(when), ym = day.slice(0, 7);
    byDay[day] = (byDay[day] || 0) + usd;
    const m = byMonth[ym] || (byMonth[ym] = { usd: 0, n: 0, models: {} });
    m.usd += usd;
    if (isCheck) m.n++;
    if (model) m.models[model] = (m.models[model] || 0) + 1;
  };
  for (const x of readJson(CQ_DIR + "/cqChecks.json") || []) if (x) put(x.at, (x.cost || 0) / RUB, true, x.model);
  for (const x of readJson(CQ_DIR + "/cqCalls.json") || []) if (x && x.cleanCost) put(x.cleanAt || x.at, (x.cleanCost || 0) / RUB, false, null);
  for (const x of readJson(CQ_DIR + "/cqReports.json") || []) if (x) put(x.at, (x.cost || 0) / RUB, false, x.model);
  return { byDay, byMonth };
}

// Сколько переводов сделано за месяц — из журнала заказов движка. Деньги по
// переводам берём не отсюда, а из шлюза (он точнее), здесь только счётчик.
function translateOrdersByMonth() {
  const out = {};
  const j = readJson(TRANSLATE_ORDERS);
  const arr = Array.isArray(j) ? j : (j && j.orders) || [];
  for (const o of arr) {
    if (!o || !o.createdAt) continue;
    const ym = mskDay(o.createdAt).slice(0, 7);
    out[ym] = (out[ym] || 0) + 1;
  }
  return out;
}

// { "2026-09": { usd, svc: { id: {usd, n, models} } } }
function spendByMonth() {
  const out = {};
  const slot = (ym) => out[ym] || (out[ym] = { usd: 0, svc: {} });
  const bucket = (m, id) => m.svc[id] || (m.svc[id] = { usd: 0, n: 0, models: {} });
  const cq = cqJournal();

  const b = readJson(ENGINE_BUDGET) || { days: {} };
  for (const [day, v] of Object.entries(b.days || {})) {
    const m = slot(day.slice(0, 7));
    const total = v.usd || 0;
    m.usd += total;
    const svc = v.svc || {};
    const named = Object.values(svc).reduce((s, t) => s + (t.usd || 0), 0);
    for (const [id, t] of Object.entries(svc)) {
      const a = bucket(m, id);
      a.usd += t.usd || 0;
      for (const [mid, n] of Object.entries(t.models || {})) a.models[mid] = (a.models[mid] || 0) + n;
    }
    // День без пометок сервисов (до 16.09): прослушку знаем из её журнала,
    // остальное — движок переводов.
    const rest = Math.max(0, total - named);
    if (rest > 0.0001) {
      const cqDay = Math.min(rest, cq.byDay[day] || 0);
      if (cqDay > 0) bucket(m, "cq").usd += cqDay;
      bucket(m, "translate").usd += rest - cqDay;
    }
  }

  // Счётчики и модели прослушки — из её журнала (там и модель записана).
  for (const [ym, v] of Object.entries(cq.byMonth)) {
    const a = bucket(slot(ym), "cq");
    a.n += v.n;
    for (const [mid, n] of Object.entries(v.models)) a.models[mid] = (a.models[mid] || 0) + n;
  }
  for (const [ym, n] of Object.entries(translateOrdersByMonth())) bucket(slot(ym), "translate").n += n;

  // Сканер — свой ключ мимо шлюза, поэтому и деньги, и счётчик из его журнала.
  const st = readJson(SCANNER_STORE) || { docs: [] };
  for (const doc of st.docs || []) {
    if (!doc || !doc.at) continue;
    const m = slot(mskDay(doc.at).slice(0, 7));
    const a = bucket(m, "scanner");
    let usd = 0;
    for (const e of doc.spend || []) {
      const p = PRICES[e.model] || PRICES["claude-haiku-4-5"];
      usd += ((e.in || 0) + (e.cr || 0) * 0.1 + (e.cw || 0) * 1.25) * p[0] / 1e6 + (e.out || 0) * p[1] / 1e6;
      if (e.model) a.models[e.model] = (a.models[e.model] || 0) + 1;
    }
    a.usd += usd; a.n++;
    m.usd += usd;
  }
  return out;
}

// ── Письма ───────────────────────────────────────────────────────────────────
function money(v) { return "$" + (Math.round(v * 100) / 100).toFixed(2); }
const TOPUP_URL = "https://console.anthropic.com/settings/billing";

// Запасной ответ, пока журнал за месяц не накопил моделей (запись моделей в
// шлюзе включена 21.09.2026): берём то же, что берут сами сервисы при запуске.
function configModel(id) {
  if (id === "translate") return process.env.TRANSLATE_MODEL || "claude-opus-5";
  if (id === "scanner") return process.env.SCANNER_MODEL || "claude-haiku-4-5";
  if (id === "cq") return process.env.CQ_MODEL || "claude-haiku-4-5";
  return "";
}
// Показываем одну — ту, на которой сервис работает в основном. Вторая модель
// (у сканера это перепроверка на Sonnet) строку только удлиняет, а письмо
// должно читаться одним взглядом.
function modelTitle(models, id) {
  const top = Object.entries(models || {}).sort((a, b) => b[1] - a[1])[0];
  const m = top ? top[0] : configModel(id);
  return m ? (MODEL_NAMES[m] || m) : "";
}

const CELL = "padding:5px 0;";
const C_NAME = 'style="' + CELL + 'padding-right:20px;white-space:nowrap;"';
const C_MODEL = 'style="' + CELL + 'padding-right:20px;white-space:nowrap;color:#8a8f98;"';
const C_USD = 'style="' + CELL + 'text-align:right;white-space:nowrap;"';
const C_N = 'style="' + CELL + 'white-space:nowrap;padding-left:20px;color:#8a8f98;"';

// Блок месяца: итог и строки сервисов. Сумма строк равна итогу — иначе письмо
// вызывает ровно тот вопрос, который Андрей и задал: «почему не сходится».
function monthBlock(ym, data, note) {
  const d = data || { usd: 0, svc: {} };
  const rows = SVC_ORDER.map(function (id) {
    const a = d.svc[id] || { usd: 0, n: 0, models: {} };
    return '<tr><td ' + C_NAME + '>' + SVC_SHORT[id] + '</td>'
      + '<td ' + C_MODEL + '>' + modelTitle(a.models, id) + '</td>'
      + '<td ' + C_USD + '>' + money(a.usd) + '</td>'
      + '<td ' + C_N + '>' + (a.n || 0) + ' ' + plural(a.n || 0, SVC_UNIT[id]) + '</td></tr>';
  }).join("");
  return '<p style="margin:22px 0 6px;"><b>' + ymTitle(ym) + '</b>'
    + (note ? ' <span style="color:#8a8f98;font-weight:normal;">' + note + '</span>' : "")
    + ' — <b>' + money(d.usd) + '</b></p>'
    + '<table style="border-collapse:collapse;font-size:14px;">' + rows + '</table>';
}

function html(s) {
  const cur = new Date(Date.now() + 3 * 3600 * 1000).toISOString().slice(0, 7);
  const prev = ymShift(cur, -1);
  const by = spendByMonth();
  return '<p style="font-size:15px;"><b>Баланс Claude API: ' + money(s.leftUsd) + '</b></p>'
    + monthBlock(cur, by[cur], "(текущий)")
    + monthBlock(prev, by[prev], "")
    + '<p style="margin:24px 0 0;"><a href="' + TOPUP_URL + '" style="background:#171c29;color:#fff;text-decoration:none;'
    + 'padding:10px 18px;border-radius:8px;display:inline-block;font-size:14px;">Пополнить счёт</a></p>'
    + '<p style="margin:8px 0 0;font-size:12px;color:#999;">' + TOPUP_URL + '</p>';
}

// ── Проверка ─────────────────────────────────────────────────────────────────
// send(m) — функция отправки из server.js (sendOrQueueDirectorMail): она сама
// откладывает письмо, если сейчас нерабочее время.
function check(send, why) {
  const d = init();
  const s = status();
  if (!s.known) return s;
  const msk = new Date(Date.now() + 3 * 3600 * 1000);
  const today = msk.toISOString().slice(0, 10);
  // Только утром и позже. Проверка идёт раз в час, и без этого ежедневное письмо
  // уходило в момент смены суток — Андрей видел его отправленным в 00:17.
  if (msk.getUTCHours() < 8) return s;

  if (s.leftUsd <= ALERT_USD) {
    // Ниже $5 — письмо каждый день, но не чаще одного за сутки.
    if (d.lastDailyDay === today) return s;
    d.lastDailyDay = today; save(d);
    send({ to: TO, subject: "Claude API: осталось " + money(s.leftUsd) + " — пополните счёт", html: html(s), noBanner: true });
    console.log("AI BALANCE [" + (why || "cron") + "]: остаток " + money(s.leftUsd) + " ≤ " + money(ALERT_USD) + " — письмо (ежедневное)");
    return s;
  }
  if (s.leftUsd <= WARN_USD) {
    // Ниже $7 — одно письмо до следующего пополнения.
    if (d.warnSentAt) return s;
    d.warnSentAt = Date.now(); save(d);
    send({ to: TO, subject: "Claude API: осталось " + money(s.leftUsd), html: html(s), noBanner: true });
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

// Разовая отправка письма «как есть» — для проверки вёрстки без ожидания порога.
function sendTest(send) {
  const s = status();
  if (!s.known) { console.log(s.message); return; }
  send({ to: TO, subject: "Claude API: осталось " + money(s.leftUsd), html: html(s), noBanner: true });
}

module.exports = { init, addTopup, status, check, schedule, sendTest, load, save };
