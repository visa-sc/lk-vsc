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

async function sendCode(phone, code) {
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
    msg: `Код для входа в личный кабинет VOYO: ${code}`,
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
  getBalance,
};
