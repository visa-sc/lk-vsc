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
//  • Чек 54-ФЗ: Receipt обязателен, когда к магазину подключена онлайн-касса
//    (у нас CloudKassir, ФФД 1.2). Состав чека передаётся в каждом запросе —
//    заводить номенклатуру в банке не нужно.
//
// env: TBANK_TERMINAL_KEY, TBANK_TERMINAL_PASSWORD — терминал Т-Кассы;
// TBANK_ACQ_API (дефолт боевой securepay), TBANK_TAXATION (дефолт usn_income),
// TBANK_VAT (дефолт none — УСН без НДС).
// ─────────────────────────────────────────────────────────────────────────
const crypto = require("crypto");
const axios = require("axios");

const API = process.env.TBANK_ACQ_API || "https://securepay.tinkoff.ru/v2";
const TAXATION = process.env.TBANK_TAXATION || "usn_income";
const VAT = process.env.TBANK_VAT || "none";

function key() { return process.env.TBANK_TERMINAL_KEY || ""; }
function password() { return process.env.TBANK_TERMINAL_PASSWORD || ""; }
function ready() { return Boolean(key() && password()); }

// Подпись: только корневые скалярные поля + Password, сортировка по ключу,
// склейка значений, SHA-256. Булевы сериализуются как "true"/"false".
function signature(params) {
  const flat = Object.assign({}, params, { Password: password() });
  const val = (v) => (typeof v === "boolean" ? String(v) : String(v));
  const src = Object.keys(flat)
    .filter((k) => k !== "Token" && flat[k] !== undefined && flat[k] !== null && typeof flat[k] !== "object")
    .sort()
    .map((k) => val(flat[k]))
    .join("");
  return crypto.createHash("sha256").update(src, "utf8").digest("hex");
}

// Чек для онлайн-кассы: одна позиция-услуга на всю сумму (предоплата 100%).
function buildReceipt({ itemName, amountKop, email, phone }) {
  const r = {
    Taxation: TAXATION,
    Items: [{
      Name: String(itemName || "Услуга").slice(0, 128),
      Price: amountKop, Quantity: 1, Amount: amountKop,
      Tax: VAT, PaymentMethod: "full_prepayment", PaymentObject: "service",
    }],
  };
  if (email) r.Email = email;
  if (phone) r.Phone = phone;         // хотя бы один контакт обязателен
  if (!r.Email && !r.Phone) r.Email = process.env.TBANK_RECEIPT_FALLBACK_EMAIL || "info@visa-sc.ru";
  return r;
}

// Создать платёж → { ok, url, paymentId } | { ok:false, message }
async function init({ orderId, amountRub, description, itemName, email, phone, successUrl, failUrl, notificationUrl }) {
  if (!ready()) return { ok: false, message: "Т-Касса не настроена (нет TBANK_TERMINAL_KEY/PASSWORD)." };
  const amountKop = Math.round(Number(amountRub) * 100);
  if (!amountKop || amountKop < 100) return { ok: false, message: "Некорректная сумма." };
  const body = {
    TerminalKey: key(),
    Amount: amountKop,
    OrderId: String(orderId).slice(0, 50),
    Description: String(description || "").slice(0, 140),
  };
  if (notificationUrl) body.NotificationURL = notificationUrl;
  if (successUrl) body.SuccessURL = successUrl;
  if (failUrl) body.FailURL = failUrl;
  body.Token = signature(body);                    // считается ДО добавления Receipt
  body.Receipt = buildReceipt({ itemName: itemName || description, amountKop, email, phone });
  try {
    const r = await axios.post(API + "/Init", body, { timeout: 30000, headers: { "Content-Type": "application/json" } });
    const d = r.data || {};
    if (!d.Success) return { ok: false, message: (d.Message || "") + " " + (d.Details || "") || d.ErrorCode || "Ошибка Т-Кассы" };
    return { ok: true, url: d.PaymentURL, paymentId: String(d.PaymentId || ""), status: d.Status };
  } catch (e) {
    return { ok: false, message: e.response ? JSON.stringify(e.response.data).slice(0, 300) : e.message };
  }
}

// Проверка подписи входящего вебхука
function verifyNotification(body) {
  if (!ready() || !body || !body.Token) return false;
  const mine = Buffer.from(signature(body));
  const theirs = Buffer.from(String(body.Token));
  return mine.length === theirs.length && crypto.timingSafeEqual(mine, theirs);
}

// Статус платежа (страховка, если вебхук не дошёл)
async function getState(paymentId) {
  if (!ready()) return null;
  const body = { TerminalKey: key(), PaymentId: String(paymentId) };
  body.Token = signature(body);
  try {
    const r = await axios.post(API + "/GetState", body, { timeout: 20000 });
    return r.data || null;
  } catch (e) { return null; }
}

// Оплата прошла и деньги списаны
function isPaid(status) { return status === "CONFIRMED" || status === "AUTHORIZED"; }

module.exports = { ready, init, verifyNotification, getState, isPaid, signature };
