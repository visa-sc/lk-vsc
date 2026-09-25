// SMS.ru integration (auth via SMS)
// Module is dormant by default — only used when SMS_AUTH_ENABLED=true.
// Docs: https://sms.ru/api/send

const axios = require("axios");

const API_BASE = "https://sms.ru";

function isEnabled() {
  return String(process.env.SMS_AUTH_ENABLED || "").toLowerCase() === "true";
}

function getApiId() {
  return process.env.SMS_RU_API_ID || "";
}

function getSender() {
  return process.env.SMS_RU_SENDER || "";
}

function isTestMode() {
  return String(process.env.SMS_RU_TEST_MODE || "").toLowerCase() === "true";
}

function normalizePhone(raw) {
  const digits = String(raw || "").replace(/\D/g, "");
  if (!digits) return "";
  if (digits.length === 11 && digits.startsWith("8")) return "7" + digits.slice(1);
  if (digits.length === 10) return "7" + digits;
  return digits;
}

function generateCode() {
  return String(Math.floor(1000 + Math.random() * 9000));
}

// Журнал отправленных смс: номер, id у оператора и статус. Без этого нельзя
// ответить на простой вопрос «дошла ли смс клиенту» (25.09.2026). Коды из смс
// авторизации не пишем — только сам факт отправки.
const SMS_LOG = require("path").join(__dirname, ".esim", "smslog.json");
function logSms(phone, message, smsId, status) {
  try {
    const fs = require("fs");
    const txt = /\b\d{4}\b/.test(String(message)) && String(message).length < 90
      ? "(код авторизации)" : String(message || "").slice(0, 160);
    let all = [];
    try { all = JSON.parse(fs.readFileSync(SMS_LOG, "utf8")); } catch (_) { all = []; }
    all.unshift({ ts: Date.now(), phone, text: txt, smsId: smsId || null, status: status || null });
    fs.mkdirSync(require("path").dirname(SMS_LOG), { recursive: true });
    fs.writeFileSync(SMS_LOG, JSON.stringify(all.slice(0, 2000), null, 1), "utf8");
  } catch (e) { console.error("sms log:", e.message); }
}

async function sendMessage(phone, message) {
  const apiId = getApiId();
  if (!apiId) {
    throw new Error("SMS_RU_API_ID is not set");
  }

  const normalizedPhone = normalizePhone(phone);
  if (!normalizedPhone) {
    throw new Error("Invalid phone number");
  }

  const params = {
    api_id: apiId,
    to: normalizedPhone,
    msg: String(message || ""),
    json: 1,
  };

  if (getSender()) params.from = getSender();
  if (isTestMode()) params.test = 1;

  try {
    const response = await axios.get(`${API_BASE}/sms/send`, { params, timeout: 10000 });
    const data = response.data || {};

    if (data.status === "OK") {
      const smsObj = data.sms && data.sms[normalizedPhone];
      const smsStatus = smsObj ? smsObj.status : "UNKNOWN";
      const smsCode = smsObj ? smsObj.status_code : null;
      const ok = smsStatus === "OK";
      logSms(normalizedPhone, message, smsObj && smsObj.sms_id, smsStatus);
      return {
        ok,
        smsStatus,
        smsCode,
        balance: data.balance,
        testMode: isTestMode(),
        raw: data,
      };
    }

    return {
      ok: false,
      error: data.status_text || "SMS.ru error",
      raw: data,
    };
  } catch (err) {
    return {
      ok: false,
      error: err.message || "Network error",
    };
  }
}

async function sendCode(phone, code) {
  return sendMessage(phone, `Код для входа в личный кабинет VOYO: ${code}`);
}

async function sendQuestionnaireLink(phone, link) {
  return sendMessage(phone, `Заполните опросный лист VOYO: ${link}`);
}

async function sendFeedbackLink(phone, link) {
  return sendMessage(phone, `Поделитесь вашим опытом использования личного кабинета VOYO: ${link}`);
}

async function getBalance() {
  const apiId = getApiId();
  if (!apiId) return null;
  try {
    const r = await axios.get(`${API_BASE}/my/balance`, {
      params: { api_id: apiId, json: 1 },
      timeout: 5000,
    });
    return r.data;
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

module.exports = {
  isEnabled,
  isTestMode,
  normalizePhone,
  generateCode,
  sendCode,
  sendMessage,
  sendQuestionnaireLink,
  sendFeedbackLink,
  getBalance,
};
