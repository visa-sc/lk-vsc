// ─────────────────────────────────────────────────────────────────────────
// Т-Касса — интернет-эквайринг Т-Банка (создан 03.09.2026 для VOYO eSIM).
//
// Зачем отдельный модуль: приём оплат нужен будет не только eSIM (дальше —
// топапы, лояльность, услуги), поэтому банк спрятан за тремя функциями:
// init() → ссылка на оплату, verifyNotification() → проверка вебхука,
// getState() → статус платежа. Ничего специфичного для eSIM здесь нет.
//
// Протокол (сверен с developer.tbank.ru 03.09.2026):
//  • POST {API}/Init — Amount в КОПЕЙКАХ, OrderId ≤50 симв., Token — подпись.
//  • Подпись: берём ТОЛЬКО корневые поля (вложенные Receipt/DATA не входят),
//    добавляем Password, сортируем по имени ключа, склеиваем ЗНАЧЕНИЯ подряд,
//    SHA-256 (utf8, hex).
//  • Вебхук приходит POST'ом на NotificationURL с теми же правилами подписи
//    (Token из тела исключается); в ответ банк ждёт строку "OK".
//  • Чек 54-ФЗ: Receipt обязателен, когда к магазину подключена онлайн-касса.
//    Состав чека передаётся в каждом запросе — номенклатуру в банке не заводим.
//
// ДВА ТЕРМИНАЛА (02.10.2026, переезд эквайринга с ИП Комиссаренко на ООО «Эй Кей
// Групп»). Новые платежи идут через «текущий» терминал, но вебхуки, статусы и
// возвраты по платежам, созданным раньше, должны жить на том терминале, где
// платёж создан. Поэтому у каждого терминала свои ключ, пароль и налоги чека, а
// модуль сам выбирает терминал по TerminalKey из вебхука или из заказа.
//
// env:
//   TBANK_TERMINAL_KEY, TBANK_TERMINAL_PASSWORD   — текущий (новые платежи);
//   TBANK_TAXATION (дефолт usn_income), TBANK_VAT (дефолт none),
//   TBANK_PAYMENT_METHOD (дефолт full_prepayment)  — чек текущего терминала;
//   TBANK_OLD_TERMINAL_KEY, TBANK_OLD_TERMINAL_PASSWORD — прежний терминал:
//     только приём вебхуков, статусы и возвраты по его старым платежам;
//   TBANK_ACQ_API (дефолт боевой securepay).
// Переключение на новый терминал = поменять ключи в .env, старые перенести в
// TBANK_OLD_*; откат — обратно. Без TBANK_OLD_* всё работает как раньше.
// ─────────────────────────────────────────────────────────────────────────
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const https = require("https");
const tls = require("tls");
const axios = require("axios");

const API = process.env.TBANK_ACQ_API || "https://securepay.tinkoff.ru/v2";

// securepay.tinkoff.ru отдаёт сертификат УЦ Минцифры («Russian Trusted Root CA»),
// которого нет в стандартном хранилище Node — без него запросы падают с
// «self-signed certificate in certificate chain». Добавляем корневой сертификат
// ТОЛЬКО для запросов к банку: системное хранилище и остальной трафик не трогаем.
// Файл — публичный корневой сертификат с gu-st.ru, отпечаток SHA-256:
// D2:6D:2D:02:31:B7:C3:9F:92:CC:73:85:12:BA:54:10:35:19:E4:40:5D:68:B5:BD:70:3E:97:88:CA:8E:CF:31
let _agent = null;
function agent() {
  if (_agent !== null) return _agent || undefined;
  try {
    const f = path.join(__dirname, "certs", "russian_trusted_root_ca.pem");
    const extra = fs.readFileSync(f, "utf8");
    _agent = new https.Agent({ ca: [].concat(tls.rootCertificates, [extra]) });
  } catch (e) {
    console.error("tbank: корневой сертификат Минцифры не найден —", e.message);
    _agent = false; // работаем на системных доверия; проверка сертификата НЕ отключается
  }
  return _agent || undefined;
}

// ── терминалы ──
function current() {
  return {
    key: process.env.TBANK_TERMINAL_KEY || "", password: process.env.TBANK_TERMINAL_PASSWORD || "",
    taxation: process.env.TBANK_TAXATION || "usn_income",
    vat: process.env.TBANK_VAT || "none",
    method: process.env.TBANK_PAYMENT_METHOD || "full_prepayment",
  };
}
// Тестовый терминал (DEMO) нового магазина: тесты банка до переключения.
// Налоги чека — как у будущего боевого терминала (TBANK_AKG_*).
function test() {
  const key = process.env.TBANK_TEST_TERMINAL_KEY || "";
  const password = process.env.TBANK_TEST_TERMINAL_PASSWORD || "";
  return key && password ? {
    key, password, test: true,
    taxation: process.env.TBANK_AKG_TAXATION || process.env.TBANK_TAXATION || "usn_income",
    vat: process.env.TBANK_AKG_VAT || process.env.TBANK_VAT || "none",
    method: process.env.TBANK_AKG_PAYMENT_METHOD || process.env.TBANK_PAYMENT_METHOD || "full_prepayment",
  } : null;
}
function old() {
  const key = process.env.TBANK_OLD_TERMINAL_KEY || "";
  const password = process.env.TBANK_OLD_TERMINAL_PASSWORD || "";
  return key && password ? { key, password } : null;
}
// терминал по его ключу: текущий, прежний или никакой
function byKey(terminalKey) {
  const k = String(terminalKey || "");
  const c = current();
  if (!k || k === c.key) return c;
  const o = old();
  if (o && k === o.key) return o;
  const t = test();
  if (t && k === t.key) return t;
  return null;
}
function key() { return current().key; }
function ready() { const c = current(); return Boolean(c.key && c.password); }

// Подпись: только корневые скалярные поля + Password, сортировка по ключу,
// склейка значений, SHA-256. Булевы сериализуются как "true"/"false".
function signature(params, pass) {
  const flat = Object.assign({}, params, { Password: pass != null ? pass : current().password });
  const src = Object.keys(flat)
    .filter((k) => k !== "Token" && flat[k] !== undefined && flat[k] !== null && typeof flat[k] !== "object")
    .sort()
    .map((k) => String(flat[k]))
    .join("");
  return crypto.createHash("sha256").update(src, "utf8").digest("hex");
}

// Чек для онлайн-кассы: одна позиция-услуга на всю сумму.
// letBankAsk — не подставлять наш запасной адрес: пусть банк спросит контакт
// на своей форме (так покупает телеграм-бот, где почту у клиента не берём).
function buildReceipt({ itemName, amountKop, email, phone, letBankAsk }, t) {
  const term = t || current();
  const r = {
    Taxation: term.taxation,
    Items: [{
      Name: String(itemName || "Услуга").slice(0, 128),
      Price: amountKop, Quantity: 1, Amount: amountKop,
      Tax: term.vat, PaymentMethod: term.method, PaymentObject: "service",
    }],
  };
  if (email) r.Email = email;
  if (phone) r.Phone = phone;         // хотя бы один контакт обязателен
  if (!r.Email && !r.Phone && !letBankAsk) r.Email = process.env.TBANK_RECEIPT_FALLBACK_EMAIL || "info@visa-sc.ru";
  return r;
}

// Создать платёж → { ok, url, paymentId, terminalKey } | { ok:false, message }
async function init({ orderId, amountRub, description, itemName, email, phone, successUrl, failUrl, notificationUrl, letBankAsk, useTest }) {
  if (!ready()) return { ok: false, message: "Т-Касса не настроена (нет TBANK_TERMINAL_KEY/PASSWORD)." };
  const t = useTest ? test() : current();
  if (!t) return { ok: false, message: "Тестовый терминал не настроен (TBANK_TEST_*)." };
  const amountKop = Math.round(Number(amountRub) * 100);
  if (!amountKop || amountKop < 100) return { ok: false, message: "Некорректная сумма." };
  const body = {
    TerminalKey: t.key,
    Amount: amountKop,
    OrderId: String(orderId).slice(0, 50),
    Description: String(description || "").slice(0, 140),
  };
  if (notificationUrl) body.NotificationURL = notificationUrl;
  if (successUrl) body.SuccessURL = successUrl;
  if (failUrl) body.FailURL = failUrl;
  body.Token = signature(body, t.password);         // считается ДО добавления Receipt
  body.Receipt = buildReceipt({ itemName: itemName || description, amountKop, email, phone, letBankAsk }, t);
  try {
    const r = await axios.post(API + "/Init", body, { timeout: 30000, httpsAgent: agent(), headers: { "Content-Type": "application/json" } });
    const d = r.data || {};
    if (!d.Success) return { ok: false, message: (d.Message || "") + " " + (d.Details || "") || d.ErrorCode || "Ошибка Т-Кассы" };
    return { ok: true, url: d.PaymentURL, paymentId: String(d.PaymentId || ""), status: d.Status, terminalKey: t.key };
  } catch (e) {
    return { ok: false, message: e.response ? JSON.stringify(e.response.data).slice(0, 300) : e.message };
  }
}

// Проверка подписи входящего вебхука: пароль берём того терминала, от
// которого вебхук пришёл (по TerminalKey), — текущего или прежнего.
function verifyNotification(body) {
  if (!body || !body.Token) return false;
  const t = byKey(body.TerminalKey);
  if (!t || !t.password) return false;
  const mine = Buffer.from(signature(body, t.password));
  const theirs = Buffer.from(String(body.Token));
  return mine.length === theirs.length && crypto.timingSafeEqual(mine, theirs);
}

// Статус платежа (страховка, если вебхук не дошёл). terminalKey — тот, через
// который платёж создан; без него сначала текущий, при неудаче — прежний.
async function getState(paymentId, terminalKey) {
  const tries = [];
  const want = byKey(terminalKey);
  if (terminalKey && want) tries.push(want);
  else { tries.push(current()); if (old()) tries.push(old()); }
  for (const t of tries) {
    if (!t.key || !t.password) continue;
    const body = { TerminalKey: t.key, PaymentId: String(paymentId) };
    body.Token = signature(body, t.password);
    try {
      const r = await axios.post(API + "/GetState", body, { timeout: 20000, httpsAgent: agent() });
      const d = r.data || null;
      if (d && d.Success !== false) return d;
      if (tries.length === 1) return d;
    } catch (e) { if (tries.length === 1) return null; }
  }
  return null;
}

// Возврат через API (метод Cancel): полный или частичный, с чеком возврата.
// Для боевых платежей возвраты делает человек в кабинете банка; здесь это
// нужно для тестов банка на DEMO-терминале («Возврат», «Чек возврата»).
async function cancel({ paymentId, terminalKey, amountRub, itemName, email, phone }) {
  const t = byKey(terminalKey);
  if (!t || !t.key) return { ok: false, message: "терминал не найден" };
  const body = { TerminalKey: t.key, PaymentId: String(paymentId) };
  if (amountRub) body.Amount = Math.round(Number(amountRub) * 100);
  body.Token = signature(body, t.password);
  if (body.Amount && (email || phone)) {
    body.Receipt = buildReceipt({ itemName, amountKop: body.Amount, email, phone }, t);
  }
  try {
    const r = await axios.post(API + "/Cancel", body, { timeout: 30000, httpsAgent: agent(), headers: { "Content-Type": "application/json" } });
    const d = r.data || {};
    return d.Success ? { ok: true, status: d.Status } : { ok: false, message: (d.Message || "") + " " + (d.Details || "") };
  } catch (e) {
    return { ok: false, message: e.response ? JSON.stringify(e.response.data).slice(0, 300) : e.message };
  }
}

// Оплата прошла и деньги списаны
function isPaid(status) { return status === "CONFIRMED" || status === "AUTHORIZED"; }

module.exports = { ready, init, verifyNotification, getState, isPaid, signature, agent, key, cancel, testReady: () => !!test() };
