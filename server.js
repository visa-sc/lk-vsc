require("dotenv").config();

const express = require("express");
const path = require("path");
const fs = require("fs");
const os = require("os");
const axios = require("axios");
const multer = require("multer");
const PDFDocument = require("pdfkit");
const crypto = require("crypto");
const archiver = require("archiver");
const sms = require("./sms");

const app = express();
const PORT = process.env.PORT || 3000;

app.use((req, res, next) => {
  console.log("REQUEST:", req.method, req.path, req.query || {});
  next();
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));

app.get("/cabinet", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "cabinet.html"));
});

app.get("/search", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "search.html"));
});

app.get("/about", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "about.html"));
});

app.get("/about/v1", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "about-v1.html"));
});

// ──────────────────────────────────────────────────────────
// SMS-аутентификация (спящий режим). Включается флагом SMS_AUTH_ENABLED=true.
// Пока флаг false — эндпоинты возвращают 404, чтобы внешне ничего не светилось.
// ──────────────────────────────────────────────────────────

const smsCodeStore = new Map(); // phone(E.164 без +) -> { code, expiresAt, attempts, lastSentAt }
const SMS_CODE_TTL_MS = 5 * 60 * 1000; // 5 минут
const SMS_RESEND_COOLDOWN_MS = 60 * 1000; // 60 секунд
const SMS_MAX_ATTEMPTS = 5;

// ─── Rate limits ───────────────────────────────────────────
// Защита sms.ru-баланса и от перебора служебного кода.
// Все счётчики живут в памяти процесса — при рестарте сбрасываются.
// Для текущей нагрузки этого достаточно; persistent-хранение можно прикрутить позже.
const MS_10MIN = 10 * 60 * 1000;
const MS_1H = 60 * 60 * 1000;
const MS_24H = 24 * 60 * 60 * 1000;

const SMS_LIMIT_PER_PHONE_10MIN = 3;     // <= 3 SMS в 10 мин на номер
const SMS_LIMIT_PER_PHONE_1H = 5;        // <= 5 SMS в час на номер (значит после 3 в 10 мин — ещё максимум 2 за 50 мин)
const SMS_LIMIT_PER_PHONE_24H = 15;      // <= 15 SMS в сутки на номер
const SMS_LIMIT_PER_IP_24H = 15;         // <= 15 SMS в сутки с одного IP

const STAFF_BYPASS_CODE = (process.env.STAFF_BYPASS_CODE || "111");
const STAFF_BYPASS_FAIL_LIMIT_24H = 15;  // <= 15 неудачных попыток ввода служебного кода в сутки с одного IP

// История отправок SMS: ключ → массив timestamp'ов
const smsSendHistory = new Map();
// История неудачных попыток ввода служебного кода: IP → массив timestamp'ов
const staffBypassFailHistory = new Map();

function getClientIp(req) {
  const xff = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  return xff || req.ip || (req.connection && req.connection.remoteAddress) || "unknown";
}

function pruneHistory(store, key, cutoffMs) {
  const list = store.get(key) || [];
  const cutoff = Date.now() - cutoffMs;
  const fresh = list.filter((t) => t >= cutoff);
  if (fresh.length !== list.length) {
    if (fresh.length === 0) store.delete(key);
    else store.set(key, fresh);
  }
  return fresh;
}

function formatWait(sec) {
  if (sec >= 3600) return `${Math.ceil(sec / 3600)} ч`;
  if (sec >= 60) return `${Math.ceil(sec / 60)} мин`;
  return `${Math.max(1, sec)} с`;
}

function checkSmsRateLimit(phone, ip) {
  // Возвращает { ok: true } или { ok: false, message, retryAfterSec }
  const phoneKey = `p:${phone}`;
  const ipKey = `i:${ip}`;
  const phoneHist = pruneHistory(smsSendHistory, phoneKey, MS_24H);
  const ipHist = pruneHistory(smsSendHistory, ipKey, MS_24H);
  const now = Date.now();

  const in10min = phoneHist.filter((t) => t >= now - MS_10MIN);
  if (in10min.length >= SMS_LIMIT_PER_PHONE_10MIN) {
    const oldest = in10min[0];
    const wait = Math.ceil((oldest + MS_10MIN - now) / 1000);
    return { ok: false, retryAfterSec: wait, message: `Слишком много запросов SMS. Попробуйте через ${formatWait(wait)}.` };
  }
  const in1h = phoneHist.filter((t) => t >= now - MS_1H);
  if (in1h.length >= SMS_LIMIT_PER_PHONE_1H) {
    const oldest = in1h[0];
    const wait = Math.ceil((oldest + MS_1H - now) / 1000);
    return { ok: false, retryAfterSec: wait, message: `Превышен часовой лимит SMS на этот номер. Попробуйте через ${formatWait(wait)}.` };
  }
  if (phoneHist.length >= SMS_LIMIT_PER_PHONE_24H) {
    return { ok: false, retryAfterSec: 24 * 3600, message: "Превышен суточный лимит SMS на этот номер. Попробуйте завтра." };
  }
  if (ipHist.length >= SMS_LIMIT_PER_IP_24H) {
    return { ok: false, retryAfterSec: 24 * 3600, message: "Превышен суточный лимит SMS с вашего устройства. Попробуйте завтра." };
  }
  return { ok: true };
}

function recordSmsSent(phone, ip) {
  const phoneKey = `p:${phone}`;
  const ipKey = `i:${ip}`;
  const now = Date.now();
  smsSendHistory.set(phoneKey, [...(smsSendHistory.get(phoneKey) || []), now]);
  smsSendHistory.set(ipKey, [...(smsSendHistory.get(ipKey) || []), now]);
}

function checkStaffBypassRateLimit(ip) {
  const key = ip;
  const hist = pruneHistory(staffBypassFailHistory, key, MS_24H);
  if (hist.length >= STAFF_BYPASS_FAIL_LIMIT_24H) {
    return { ok: false, message: "Слишком много неудачных попыток. Попробуйте через сутки." };
  }
  return { ok: true };
}

function recordStaffBypassFail(ip) {
  const key = ip;
  staffBypassFailHistory.set(key, [...(staffBypassFailHistory.get(key) || []), Date.now()]);
}

function smsGate(req, res, next) {
  if (!sms.isEnabled()) {
    return res.status(404).send("Not found");
  }
  next();
}

app.post("/api/auth/has-leads", async (req, res) => {
  try {
    const phone = sms.normalizePhone((req.body && req.body.phone) || "");
    if (!phone || phone.length < 11) {
      return res.status(400).json({ success: false, message: "Некорректный номер телефона" });
    }
    if (!AMO_SUBDOMAIN || !AMO_ACCESS_TOKEN) {
      return res.status(500).json({ success: false, message: "Не настроены переменные amoCRM" });
    }
    const leads = await getLeadsByPhone(phone);
    return res.json({ success: true, hasLeads: Array.isArray(leads) && leads.length > 0 });
  } catch (err) {
    console.error("HAS-LEADS ERROR:", err.message);
    // Не блокируем поток — если проверка упала, пусть SMS уйдёт по обычному пути
    return res.status(500).json({ success: false, message: "Ошибка проверки" });
  }
});

// Регистрация нового клиента: создание контакта + сделки в воронке «Отдел продаж»,
// статус «Ещё не связывались». Опционально — закреплённый комментарий при валидном промокоде.
// Промокоды → размер скидки в %. Текст комментария формируется единообразно.
const PROMO_CODES = {
  "10OFFBRO": 10,
  "15OFFBRO": 15,
  "20OFFBRO": 20
};
function promoCommentText(percent) {
  return `-${percent}% скидка на услуги от Андрея К. Можно перекрыть сертификатом.`;
}

// Создание новой сделки для УЖЕ АВТОРИЗОВАННОГО клиента (из кабинета по кнопке
// «Новое обращение»). По логике аналогично /api/auth/register, но без промо
// (комментарий со скидкой не пишется).
app.post("/api/leads/new", async (req, res) => {
  try {
    const phone = sms.normalizePhone((req.body && req.body.phone) || "");
    if (!phone || phone.length < 11) {
      return res.status(400).json({ success: false, message: "Некорректный номер телефона" });
    }
    if (!AMO_SUBDOMAIN || !AMO_ACCESS_TOKEN) {
      return res.status(500).json({ success: false, message: "Не настроены переменные amoCRM" });
    }
    const result = await createAmoContactAndLeadForRegistration(phone, {
      promoApplied: false,
      promoText: ""
    });
    return res.json({
      success: true,
      contactId: result.contactId,
      leadId: result.leadId
    });
  } catch (err) {
    console.error("POST /api/leads/new error:", err.response?.data || err.message);
    return res.status(500).json({
      success: false,
      message: "Не удалось создать новое обращение. Попробуйте позже."
    });
  }
});

app.post("/api/auth/register", async (req, res) => {
  try {
    const phone = sms.normalizePhone((req.body && req.body.phone) || "");
    const promoCodeRaw = String((req.body && req.body.promoCode) || "").trim();
    if (!phone || phone.length < 11) {
      return res.status(400).json({ success: false, message: "Некорректный номер телефона" });
    }
    if (!AMO_SUBDOMAIN || !AMO_ACCESS_TOKEN) {
      return res.status(500).json({ success: false, message: "Не настроены переменные amoCRM" });
    }
    const promoPercent = Object.prototype.hasOwnProperty.call(PROMO_CODES, promoCodeRaw)
      ? PROMO_CODES[promoCodeRaw]
      : 0;
    const promoApplied = promoPercent > 0;
    const result = await createAmoContactAndLeadForRegistration(phone, {
      promoApplied,
      promoText: promoApplied ? promoCommentText(promoPercent) : ""
    });
    return res.json({
      success: true,
      contactId: result.contactId,
      leadId: result.leadId,
      promoApplied,
      promoPercent
    });
  } catch (err) {
    console.error("REGISTER ERROR:", err.response?.data || err.message);
    return res.status(500).json({
      success: false,
      message: "Не удалось зарегистрировать. Попробуйте позже."
    });
  }
});

app.post("/api/auth/request-code", smsGate, async (req, res) => {
  try {
    const phone = sms.normalizePhone((req.body && req.body.phone) || "");
    if (!phone || phone.length < 11) {
      return res.status(400).json({ success: false, message: "Некорректный номер телефона" });
    }

    const ip = getClientIp(req);
    const rateLimit = checkSmsRateLimit(phone, ip);
    if (!rateLimit.ok) {
      console.log(`SMS RATE LIMIT: phone=${phone} ip=${ip} → ${rateLimit.message}`);
      return res.status(429).json({ success: false, message: rateLimit.message, retryAfterSec: rateLimit.retryAfterSec });
    }

    const existing = smsCodeStore.get(phone);
    if (existing && Date.now() - (existing.lastSentAt || 0) < SMS_RESEND_COOLDOWN_MS) {
      const wait = Math.ceil((SMS_RESEND_COOLDOWN_MS - (Date.now() - existing.lastSentAt)) / 1000);
      return res.status(429).json({ success: false, message: `Подождите ${wait} с перед повторной отправкой` });
    }

    const code = sms.generateCode();
    const result = await sms.sendCode(phone, code);

    if (!result.ok) {
      return res.status(502).json({ success: false, message: result.error || "Не удалось отправить SMS" });
    }

    // Учитываем в лимитах только успешно ушедшую SMS — чтобы ошибки sms.ru
    // не сжигали клиенту его квоту 3/10мин и 5/час.
    recordSmsSent(phone, ip);

    smsCodeStore.set(phone, {
      code,
      expiresAt: Date.now() + SMS_CODE_TTL_MS,
      attempts: 0,
      lastSentAt: Date.now(),
    });

    return res.json({ success: true, testMode: !!result.testMode });
  } catch (err) {
    console.error("REQUEST CODE ERROR:", err);
    return res.status(500).json({ success: false, message: "Внутренняя ошибка" });
  }
});

// Серверная проверка служебного «обходного» кода входа.
// Раньше код хардкодился в HTML — каждый, кто открыл DevTools, видел его.
// Теперь код хранится только на сервере (env STAFF_BYPASS_CODE, дефолт «111»)
// и есть rate-limit 15 неудачных попыток в сутки на IP.
app.post("/api/auth/staff-bypass", (req, res) => {
  const ip = getClientIp(req);
  const limit = checkStaffBypassRateLimit(ip);
  if (!limit.ok) {
    return res.status(429).json({ success: false, message: limit.message });
  }
  const provided = String((req.body && req.body.code) || "").trim();
  if (!provided) {
    // Пустой ввод не считаем как неудачную попытку, чтобы случайные ENTER'ы
    // не сжигали лимит.
    return res.status(400).json({ success: false, message: "Введите код" });
  }
  if (provided !== STAFF_BYPASS_CODE) {
    recordStaffBypassFail(ip);
    return res.status(403).json({ success: false, message: "Неверный код" });
  }
  return res.json({ success: true });
});

app.post("/api/auth/verify", smsGate, (req, res) => {
  try {
    const phone = sms.normalizePhone((req.body && req.body.phone) || "");
    const code = String((req.body && req.body.code) || "").trim();

    if (!phone || !code) {
      return res.status(400).json({ success: false, message: "Введите код" });
    }

    const entry = smsCodeStore.get(phone);
    if (!entry) {
      return res.status(400).json({ success: false, message: "Запросите код заново" });
    }
    if (Date.now() > entry.expiresAt) {
      smsCodeStore.delete(phone);
      return res.status(400).json({ success: false, message: "Код истёк, запросите заново" });
    }
    if (entry.attempts >= SMS_MAX_ATTEMPTS) {
      smsCodeStore.delete(phone);
      return res.status(429).json({ success: false, message: "Слишком много попыток, запросите код заново" });
    }
    entry.attempts += 1;

    if (entry.code !== code) {
      return res.status(400).json({ success: false, message: "Неверный код" });
    }

    smsCodeStore.delete(phone);
    // TODO (этап 2): выдать session cookie / JWT здесь
    try { recordLkAuth(phone); } catch (_) {}
    return res.json({ success: true, phone });
  } catch (err) {
    console.error("VERIFY CODE ERROR:", err);
    return res.status(500).json({ success: false, message: "Внутренняя ошибка" });
  }
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 20 * 1024 * 1024
  }
});

const {
  AMO_ACCESS_TOKEN,
  YANDEX_DISK_TOKEN,
  YANDEX_DISK_ROOT = "Документы от клиентов из личного кабинета VSC"
} = process.env;

const AMO_SUBDOMAIN = String(process.env.AMO_SUBDOMAIN || "")
  .trim()
  .replace(/^https?:\/\//i, "")
  .replace(/\/.*$/, "")
  .replace(/\.amocrm\.ru$/i, "");

const STATUS_MAP = {
  "Отдел продаж": {
    "Ещё не связывались": { client_status: "Сбор документов" },
    "Ещё не связывались (для повторных сделок)": { client_status: "Сбор документов" },
    "Новый после Первой линии": { client_status: "Сбор документов" },
    "Недозвон": { client_status: "Сбор документов" },
    "Работа в одно касание": { client_status: "Сбор документов" },
    "Консультация": { client_status: "Сбор документов" },
    "Рабочая виза": { client_status: "Сбор документов" },
    "Юридическое лицо": { client_status: "Сбор документов" },
    "США через рф": { client_status: "Сбор документов" },
    "Отправлено на согласование партнеру": { client_status: "Сбор документов" },
    "Контакт передан партнеру": { client_status: "Сбор документов" },
    "Ожидаем оплату комиссии": { client_status: "Сбор документов" },
    "Пришлёт документы на почту": { client_status: "Сбор документов" },
    "Сбор Документов": { client_status: "Сбор документов" },
    "Часть оплаты по ВНЖ": { client_status: "Документы поданы на рассмотрение в Консульство" },
    "Успешно реализовано (для ВНЖ)": { client_status: "Рассмотрение завершено" },
    "Дубль": { hidden: true },
    "Партнеры и подрядчики": { hidden: true },
    "Мусор": { hidden: true },
    "Мусор Китай (тур и не рф)": { hidden: true },
    "МУСОР ВНЖ(для старых сделок, не использу...)": { hidden: true },
    "Спам": { hidden: true },
    "Закрыто и не реализовано": { hidden: true }
  },

  "Отдел Оформления": {
    "Принято в работу": { client_status: "Подготовка документов" },
    "Согласование документов": { client_status: "Подготовка документов" },
    "Сбор оплачен": { client_status: "Подготовка документов" },
    "Исправить": { client_status: "Подготовка документов" },
    "Пакет документов готов": { client_status: "Подготовка документов" },
    "Ожидает записи вручную": { client_status: "Ожидание записи / подачи" },
    "Ожидает записи через Бота": { client_status: "Ожидание записи / подачи" },
    "Запись сделана": { client_status: "Ожидание записи / подачи" },
    "Оформлен выкуп": { client_status: "Ожидание записи / подачи" },
    "Электронное рассмотрение": { client_status: "Документы поданы на рассмотрение в Консульство" },
    "На паузе по просьбе Клиента": { client_status: "Ожидание записи / подачи" },
    "ОЖИДАЕТ РЕШЕНИЯ О ВОЗВРАТЕ": { hidden: true },
    "Закрыто и не реализовано": { hidden: true }
  },

  "Отдел по работе с Клиентами": {
    "Визит в офис без оплаты": { client_status: "Сбор документов" },
    "Произведена оплата": { client_status: "Подготовка документов" },
    "Сбор документов для ОО": { client_status: "Подготовка документов" },
    "Сбор дополнительных документов для ОО": { client_status: "Подготовка документов" },
    "Электронные документы переданы в Отдел ...": { client_status: "Подготовка документов" },
    "Принято в работу после ОО": { client_status: "Подготовка документов" },
    "Ожидает передачи на рассмотрение в Консульство": { client_status: "Ожидание записи / подачи" },
    "Документы готовы к личной подаче": { client_status: "Ожидание записи / подачи" },
    "Передано Клиенту для личной подачи": { client_status: "Документы поданы на рассмотрение в Консульство" },
    "На рассмотрении в Консульстве": { client_status: "Документы поданы на рассмотрение в Консульство" },
    "Документы поданы лично Заявителем": { client_status: "Документы поданы на рассмотрение в Консульство" },
    "Паспорт готов": { client_status: "Рассмотрение завершено" },
    "Успешно реализовано": { client_status: "Рассмотрение завершено" },
    "Возврат": { client_status: "Рассмотрение завершено" },
    "Доплата": { hidden: true },
    "Закрыто и не реализовано": { hidden: true }
  }
};

const CABINET_STAGES = [
  "Сбор документов",
  "Подготовка документов",
  "Ожидание записи / подачи",
  "Документы поданы на рассмотрение в Консульство",
  "Рассмотрение завершено"
];

function normalizePhone(phone = "") {
  const digits = String(phone).replace(/\D/g, "");
  if (!digits) return "";
  if (digits.length === 11 && digits.startsWith("8")) {
    return `7${digits.slice(1)}`;
  }
  return digits;
}

function sanitizeFileName(name = "") {
  return String(name).replace(/[<>:"/\\|?*\x00-\x1F]/g, "_").trim();
}

function escapeHtml(value = "") {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function extractPhonesFromContact(contact) {
  const fields = contact?.custom_fields_values || [];
  const values = [];

  for (const field of fields) {
    const code = String(field.field_code || "").toUpperCase();
    const name = String(field.field_name || "").toLowerCase();

    if (code === "PHONE" || name.includes("тел")) {
      for (const item of field.values || []) {
        if (item?.value) {
          values.push(normalizePhone(item.value));
        }
      }
    }
  }

  return [...new Set(values.filter(Boolean))];
}

function contactMatchesPhone(contact, phone) {
  const normalizedPhone = normalizePhone(phone);
  const phones = extractPhonesFromContact(contact);

  return phones.some((p) => {
    return p === normalizedPhone || p.endsWith(normalizedPhone) || normalizedPhone.endsWith(p);
  });
}

function normalizeText(value = "") {
  return String(value || "").trim().toLowerCase();
}

function findStatusMapEntry(pipelineName = "", statusName = "") {
  const normalizedPipeline = normalizeText(pipelineName);
  const normalizedStatus = normalizeText(statusName);

  for (const [mapPipelineName, statuses] of Object.entries(STATUS_MAP)) {
    if (normalizeText(mapPipelineName) !== normalizedPipeline) continue;

    for (const [mapStatusName, config] of Object.entries(statuses)) {
      if (normalizeText(mapStatusName) === normalizedStatus) {
        return config;
      }
    }
  }

  return null;
}

function getCabinetStageIndexByName(clientStatus) {
  return CABINET_STAGES.findIndex((item) => item === clientStatus);
}

function getCustomFieldValue(entity, fieldName) {
  const fields = entity?.custom_fields_values || [];
  const normalizedTarget = normalizeText(fieldName);

  for (const field of fields) {
    if (normalizeText(field.field_name) !== normalizedTarget) continue;
    const values = field.values || [];
    const first = values[0];

    if (!first) return "";
    if (typeof first.value === "string") return first.value;
    if (typeof first.value === "number") return String(first.value);
    if (first.enum) return String(first.enum);
    return "";
  }

  return "";
}

async function amoGet(url, params = {}) {
  console.log("AMO GET:", url, params);

  const response = await axios.get(url, {
    headers: {
      Authorization: `Bearer ${AMO_ACCESS_TOKEN}`
    },
    params
  });

  return response.data;
}

async function amoGetByFullUrl(url) {
  console.log("AMO GET FULL URL:", url);

  const response = await axios.get(url, {
    headers: {
      Authorization: `Bearer ${AMO_ACCESS_TOKEN}`
    }
  });

  return response.data;
}

async function amoGetAllPages(url, params = {}) {
  let nextUrl = null;
  let page = 1;
  const limit = 250;
  const allItems = [];

  while (true) {
    const data = nextUrl
      ? await amoGetByFullUrl(nextUrl)
      : await amoGet(url, { ...params, page, limit });

    const embeddedKey = Object.keys(data._embedded || {})[0];
    const items = embeddedKey ? data._embedded?.[embeddedKey] || [] : [];

    allItems.push(...items);

    nextUrl = data?._links?.next?.href || null;
    if (!nextUrl) break;

    page += 1;
  }

  return allItems;
}

async function getEntityLinks(baseUrl, entityType, entityId) {
  try {
    const data = await amoGet(`${baseUrl}/api/v4/${entityType}/${entityId}/links`);
    return data?._embedded?.links || [];
  } catch (error) {
    console.error(`GET LINKS ERROR ${entityType}/${entityId}:`, error.response?.data || error.message);
    return [];
  }
}

async function getLeadById(baseUrl, leadId) {
  try {
    return await amoGet(`${baseUrl}/api/v4/leads/${leadId}`, { with: "contacts" });
  } catch (error) {
    console.error(`GET LEAD ERROR ${leadId}:`, error.response?.data || error.message);
    return null;
  }
}

async function getPipelinesMap(baseUrl) {
  const pipelines = await amoGetAllPages(`${baseUrl}/api/v4/leads/pipelines`);
  const statusMap = new Map();

  for (const pipeline of pipelines) {
    const pipelineId = pipeline.id;
    const pipelineName = pipeline.name || "";
    const statuses = await amoGetAllPages(`${baseUrl}/api/v4/leads/pipelines/${pipelineId}/statuses`);

    for (const status of statuses) {
      statusMap.set(`${pipelineId}:${status.id}`, {
        pipeline_id: pipelineId,
        status_id: status.id,
        pipeline_name: pipelineName,
        status_name: status.name || ""
      });
    }
  }

  return statusMap;
}

function enrichLeadWithMappedStatus(lead, statusesMap) {
  const statusMeta = statusesMap.get(`${lead.pipeline_id}:${lead.status_id}`) || {};
  const pipelineName = statusMeta.pipeline_name || lead.pipeline_name || "";
  const statusName = statusMeta.status_name || lead.status_name || "";

  const mapEntry = findStatusMapEntry(pipelineName, statusName);

  if (!mapEntry) {
    return {
      ...lead,
      pipeline_name: pipelineName,
      status_name: statusName,
      hidden_in_cabinet: false,
      cabinet_status: "Сбор документов",
      cabinet_stage_index: 0,
      country_service: getCustomFieldValue(lead, "Страна оформления/услуга")
    };
  }

  if (mapEntry.hidden) {
    return {
      ...lead,
      pipeline_name: pipelineName,
      status_name: statusName,
      hidden_in_cabinet: true,
      cabinet_status: null,
      cabinet_stage_index: null,
      country_service: getCustomFieldValue(lead, "Страна оформления/услуга")
    };
  }

  const cabinetStatus = mapEntry.client_status || "Сбор документов";
  const stageIndex = getCabinetStageIndexByName(cabinetStatus);

  return {
    ...lead,
    pipeline_name: pipelineName,
    status_name: statusName,
    hidden_in_cabinet: false,
    cabinet_status: cabinetStatus,
    cabinet_stage_index: stageIndex >= 0 ? stageIndex : 0,
    country_service: getCustomFieldValue(lead, "Страна оформления/услуга")
  };
}

async function yandexRequest(config) {
  // Я.Диск может ответить 423 (Resource is locked), если одну и ту же папку/ресурс
  // одновременно трогает другая операция (параллельные ensureYandexFolder/upload в одну папку).
  // Делаем мягкий retry с экспоненциальной паузой, чтобы не падать на гонке.
  const maxAttempts = 5;
  let attempt = 0;
  let lastError;
  while (attempt < maxAttempts) {
    try {
      return await axios({
        ...config,
        headers: {
          Authorization: `OAuth ${YANDEX_DISK_TOKEN}`,
          ...(config.headers || {})
        },
        maxBodyLength: Infinity,
        maxContentLength: Infinity
      });
    } catch (err) {
      lastError = err;
      const status = err.response?.status;
      // Ретраим только 423 и сетевые таймауты/5xx. 4xx-ошибки бизнес-логики не ретраим.
      const retryable = status === 423 || status === 429 || (status >= 500 && status < 600) || !status;
      if (!retryable) throw err;
      attempt++;
      if (attempt >= maxAttempts) break;
      const delay = Math.min(2000, 200 * Math.pow(2, attempt - 1)) + Math.floor(Math.random() * 150);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastError;
}

async function ensureYandexFolder(folderPath) {
  try {
    await yandexRequest({
      method: "PUT",
      url: "https://cloud-api.yandex.net/v1/disk/resources",
      params: {
        path: folderPath
      }
    });
  } catch (error) {
    if (error.response?.status === 409) {
      return;
    }
    throw error;
  }
}

async function uploadBufferToYandexDisk(buffer, diskPath, contentType = "application/octet-stream") {
  const uploadLinkResponse = await yandexRequest({
    method: "GET",
    url: "https://cloud-api.yandex.net/v1/disk/resources/upload",
    params: {
      path: diskPath,
      overwrite: "true"
    }
  });

  const uploadUrl = uploadLinkResponse.data.href;

  await axios.put(uploadUrl, buffer, {
    headers: {
      "Content-Type": contentType
    },
    maxBodyLength: Infinity,
    maxContentLength: Infinity
  });
}

async function listYandexFolderFiles(folderPath) {
  try {
    const r = await yandexRequest({
      method: "GET",
      url: "https://cloud-api.yandex.net/v1/disk/resources",
      params: { path: folderPath, limit: 1000, fields: "_embedded.items.name,_embedded.items.type" }
    });
    const items = r.data?._embedded?.items || [];
    return items.filter((i) => i.type === "file").map((i) => i.name);
  } catch (e) {
    if (e.response?.status === 404) return [];
    return [];
  }
}

async function downloadJsonFromYandexDisk(diskPath) {
  try {
    const linkResponse = await yandexRequest({
      method: "GET",
      url: "https://cloud-api.yandex.net/v1/disk/resources/download",
      params: { path: diskPath }
    });
    const downloadUrl = linkResponse.data.href;
    const fileResponse = await axios.get(downloadUrl, { responseType: "text" });
    return typeof fileResponse.data === "string"
      ? JSON.parse(fileResponse.data)
      : fileResponse.data;
  } catch (error) {
    if (error.response?.status === 404) return null;
    if (error.response?.data?.error === "DiskNotFoundError") return null;
    throw error;
  }
}

// ─── Тех. папка для JSON-стейта опросников ───
// С 2026-05-21 данные scope-ятся по (phone, leadId): "<phone>/<leadId>/TECH FOLDER/".
// До этой даты данные лежали по phone: "<phone>/TECH FOLDER/" — этот путь
// сохраняется как legacy и читается ТОЛЬКО для leadId-владельца (см. getLegacyOwnerLeadId).
// Ещё более старый legacy: "<phone>/Опросники/Технические файлы/".
const TECH_FOLDER_NAME = "TECH FOLDER";

function leadScopedFolder(phone, leadId) {
  return `${YANDEX_DISK_ROOT}/${phone}/${leadId}`;
}

function techFolderPath(phone, leadId) {
  // Новая схема (lead-scoped). Если leadId не передан — старый путь
  // (используется только при чтении legacy).
  if (leadId) return `${leadScopedFolder(phone, leadId)}/${TECH_FOLDER_NAME}`;
  return `${YANDEX_DISK_ROOT}/${phone}/${TECH_FOLDER_NAME}`;
}
function legacyTechFolderPath(phone) {
  return `${YANDEX_DISK_ROOT}/${phone}/Опросники/Технические файлы`;
}

// Список Опросник*.json для конкретного lead'а.
// Если leadId == legacy-owner → дополнительно мерджим файлы из legacy-папок.
async function listAllTechFiles(phone, leadId) {
  if (!phone) return [];
  const out = new Set();

  if (leadId) {
    const leadScoped = await listYandexFolderFiles(techFolderPath(phone, leadId));
    (leadScoped || []).forEach((n) => out.add(n));

    const ownerId = await getLegacyOwnerLeadId(phone);
    if (ownerId && String(ownerId) === String(leadId)) {
      const legacy1 = await listYandexFolderFiles(`${YANDEX_DISK_ROOT}/${phone}/${TECH_FOLDER_NAME}`);
      (legacy1 || []).forEach((n) => out.add(n));
      const legacy2 = await listYandexFolderFiles(legacyTechFolderPath(phone));
      (legacy2 || []).forEach((n) => out.add(n));
    }
  } else {
    // Backward compat: leadId не передан — читаем всё legacy
    const legacy1 = await listYandexFolderFiles(`${YANDEX_DISK_ROOT}/${phone}/${TECH_FOLDER_NAME}`);
    (legacy1 || []).forEach((n) => out.add(n));
    const legacy2 = await listYandexFolderFiles(legacyTechFolderPath(phone));
    (legacy2 || []).forEach((n) => out.add(n));
  }
  return Array.from(out);
}

async function loadApplicantJson(phone, leadId, applicantIndex) {
  const suf = applicantIndex > 1 ? ` ${applicantIndex}` : "";
  const fileName = `Опросник${suf}.json`;
  const candidates = [];

  if (leadId) {
    // Сначала пробуем lead-scoped
    candidates.push(`${techFolderPath(phone, leadId)}/${fileName}`);
    // Если этот leadId — legacy owner, добавляем legacy-пути как fallback
    const ownerId = await getLegacyOwnerLeadId(phone);
    if (ownerId && String(ownerId) === String(leadId)) {
      candidates.push(`${YANDEX_DISK_ROOT}/${phone}/${TECH_FOLDER_NAME}/${fileName}`);
      candidates.push(`${legacyTechFolderPath(phone)}/${fileName}`);
      candidates.push(`${YANDEX_DISK_ROOT}/${phone}/${fileName}`); // самый старый legacy
    }
  } else {
    // Backward compat
    candidates.push(`${YANDEX_DISK_ROOT}/${phone}/${TECH_FOLDER_NAME}/${fileName}`);
    candidates.push(`${legacyTechFolderPath(phone)}/${fileName}`);
    candidates.push(`${YANDEX_DISK_ROOT}/${phone}/${fileName}`);
  }

  for (const p of candidates) {
    try {
      const data = await downloadJsonFromYandexDisk(p);
      if (data) return data;
    } catch (_) {}
  }
  return null;
}

// ─── amoCRM↔Я.Диск интеграция: зеркалирование документов в папку сделки + zip ───
// Папки сделок лежат в /amoCRM/Сделки/<lead_id>/ (создаются интеграцией amoCRM↔Я.Диск),
// внутри сделки создаём свою папку «Документы из ЛК».
const AMO_DEALS_ROOT = "amoCRM/Сделки";
const AMO_DOCS_FOLDER_NAME = "Документы из ЛК";
const AMO_DOCS_ZIP_NAME = "Документы из ЛК.zip";
const TASK_RESPONSIBLE_FIELD_ID = 443488;

// ─── Лимит файлов на одно обращение (lead) ──────────────────
// 200 файлов в папке «Документы из ЛК» (т.е. в зеркале сделки на Я.Диске).
// Считаем рекурсивно по факту с Я.Диска и кешируем в памяти на короткий TTL.
// .zip-архив и системные файлы в счёт не идут — это автогенерация.
const LEAD_FILE_LIMIT = 200;
const LEAD_COUNT_CACHE_TTL_MS = 30 * 1000;
const leadFileCountCache = new Map(); // leadId -> { count, ts }

async function getAmoLeadFileCount(leadId, { forceFresh = false } = {}) {
  if (!leadId) return 0;
  const cached = leadFileCountCache.get(leadId);
  if (!forceFresh && cached && (Date.now() - cached.ts) < LEAD_COUNT_CACHE_TTL_MS) {
    return cached.count;
  }
  let count = 0;
  try {
    const items = await listYandexFolderRecursive(amoDocsFolder(leadId));
    // Исключаем .zip-архивы (это сам автособираемый «Документы из ЛК.zip»,
    // если он по какой-то причине окажется внутри подпапки).
    count = items.filter((it) => !/\.zip$/i.test(it.name)).length;
  } catch (e) {
    // Если папки ещё нет (свежий lead) — count = 0, fail-open.
    count = 0;
  }
  leadFileCountCache.set(leadId, { count, ts: Date.now() });
  return count;
}

function bumpAmoLeadFileCount(leadId, delta) {
  if (!leadId) return;
  const cached = leadFileCountCache.get(leadId);
  if (cached) {
    cached.count = Math.max(0, cached.count + delta);
    cached.ts = Date.now();
  }
}

function invalidateAmoLeadFileCount(leadId) {
  if (leadId) leadFileCountCache.delete(leadId);
}

function amoDealFolder(leadId) {
  return `${AMO_DEALS_ROOT}/${leadId}`;
}
function amoDocsFolder(leadId) {
  return `${amoDealFolder(leadId)}/${AMO_DOCS_FOLDER_NAME}`;
}

async function ensureNestedYandexFolder(absolutePath) {
  // Создаём весь путь по сегментам, пропуская существующие.
  const parts = absolutePath.split("/").filter(Boolean);
  let p = "";
  for (const part of parts) {
    p = p ? `${p}/${part}` : part;
    await ensureYandexFolder(p);
  }
}

async function uploadToAmoDealDocs(leadId, relativePath, buffer, contentType) {
  await ensureNestedYandexFolder(amoDocsFolder(leadId));
  const segments = String(relativePath).split("/").filter(Boolean);
  const fileName = segments.pop();
  if (!fileName) throw new Error("relativePath is empty");
  let current = amoDocsFolder(leadId);
  for (const seg of segments) {
    current = `${current}/${seg}`;
    await ensureYandexFolder(current);
  }
  const fullPath = `${current}/${fileName}`;
  await uploadBufferToYandexDisk(buffer, fullPath, contentType);
  return fullPath;
}

async function listYandexFolderRecursive(folderPath, basePath = folderPath) {
  const out = [];
  try {
    const r = await yandexRequest({
      method: "GET",
      url: "https://cloud-api.yandex.net/v1/disk/resources",
      params: {
        path: folderPath,
        limit: 1000,
        fields: "_embedded.items.name,_embedded.items.type,_embedded.items.path,_embedded.items.size"
      }
    });
    const items = r.data?._embedded?.items || [];
    for (const item of items) {
      if (item.type === "dir") {
        const sub = await listYandexFolderRecursive(`${folderPath}/${item.name}`, basePath);
        out.push(...sub);
      } else if (item.type === "file") {
        const fullPath = `${folderPath}/${item.name}`;
        out.push({
          name: item.name,
          fullPath,
          relativePath: fullPath.slice(basePath.length + 1),
          size: item.size
        });
      }
    }
  } catch (e) {
    if (e.response?.status !== 404) {
      console.error("LIST FOLDER ERROR:", folderPath, e.response?.data || e.message);
    }
  }
  return out;
}

async function downloadYandexFileBuffer(diskPath) {
  const linkResponse = await yandexRequest({
    method: "GET",
    url: "https://cloud-api.yandex.net/v1/disk/resources/download",
    params: { path: diskPath }
  });
  const downloadUrl = linkResponse.data.href;
  const response = await axios.get(downloadUrl, {
    responseType: "arraybuffer",
    maxBodyLength: Infinity,
    maxContentLength: Infinity
  });
  return Buffer.from(response.data);
}

async function deleteYandexResourceIfExists(diskPath) {
  try {
    await yandexRequest({
      method: "DELETE",
      url: "https://cloud-api.yandex.net/v1/disk/resources",
      params: { path: diskPath, permanently: "true" }
    });
  } catch (e) {
    if (e.response?.status === 404) return;
    console.error("DELETE Y.DISK ERROR:", diskPath, e.response?.data || e.message);
  }
}

async function rebuildAmoDocsZip(leadId) {
  const folder = amoDocsFolder(leadId);
  // Zip кладём в КОРЕНЬ папки сделки (а не внутрь «Документы из ЛК»), чтобы
  // интеграция amoCRM↔Я.Диск показывала его во вкладке «Файлы» сделки.
  const zipPath = `${amoDealFolder(leadId)}/${AMO_DOCS_ZIP_NAME}`;
  // Старый путь (внутри подпапки) тоже подчищаем — мог остаться от прошлых сборок.
  const legacyZipPath = `${folder}/${AMO_DOCS_ZIP_NAME}`;

  console.log(`AMO ZIP: rebuild start, folder=${folder}`);

  // Удаляем старые архивы, чтобы не попали в новый
  await deleteYandexResourceIfExists(zipPath);
  await deleteYandexResourceIfExists(legacyZipPath);

  const items = await listYandexFolderRecursive(folder);
  const filtered = items.filter((f) => !f.name.toLowerCase().endsWith(".zip"));
  console.log(`AMO ZIP: ${items.length} items found, ${filtered.length} after filtering .zip`);
  if (!filtered.length) {
    console.log(`AMO ZIP: nothing to zip, skipping upload`);
    return;
  }

  // Сначала качаем все буферы (последовательно, чтобы не словить 423/429 на Я.Диске).
  const entries = [];
  for (const item of filtered) {
    try {
      const buf = await downloadYandexFileBuffer(item.fullPath);
      entries.push({ buf, name: item.relativePath });
    } catch (e) {
      console.error("AMO ZIP fetch error:", item.fullPath, e.response?.data || e.message);
    }
  }
  console.log(`AMO ZIP: downloaded ${entries.length}/${filtered.length} files`);
  if (!entries.length) {
    console.log("AMO ZIP: no entries downloaded, skipping upload");
    return;
  }

  // Собираем zip в Buffer, надёжно дожидаясь end-события.
  const zipBuffer = await new Promise((resolve, reject) => {
    const archive = archiver("zip", { zlib: { level: 9 } });
    const chunks = [];
    archive.on("data", (chunk) => chunks.push(chunk));
    archive.on("warning", (w) => console.warn("AMO ZIP warning:", w.message || w));
    archive.on("error", reject);
    archive.on("end", () => resolve(Buffer.concat(chunks)));
    for (const e of entries) {
      archive.append(e.buf, { name: e.name });
    }
    archive.finalize().catch(reject);
  });

  console.log(`AMO ZIP: built ${zipBuffer.length} bytes, uploading to ${zipPath}`);
  await uploadBufferToYandexDisk(zipBuffer, zipPath, "application/zip");
  console.log(`AMO ZIP: uploaded successfully`);
}

async function amoPost(url, body) {
  console.log("AMO POST:", url, JSON.stringify(body));
  const response = await axios.post(url, body, {
    headers: {
      Authorization: `Bearer ${AMO_ACCESS_TOKEN}`,
      "Content-Type": "application/json"
    }
  });
  return response.data;
}

function getEntityCustomFieldValue(entity, fieldId) {
  const fields = entity?.custom_fields_values || [];
  for (const f of fields) {
    if (Number(f.field_id) === Number(fieldId)) {
      const values = f.values || [];
      if (values.length) return values[0].value;
    }
  }
  return null;
}

// ── Авто-обнаружение элементов amoCRM (id'шники, которые могут отличаться у разных аккаунтов) ──
// Кешируем в памяти на время жизни процесса. Sentinel undefined = ещё не искали.
let _cachedTaskTypeProveritDokiId = undefined;
let _cachedKtoPrinyalFieldId = undefined;
let _cachedVscUserId = undefined;

async function getProveritDokiTaskTypeId() {
  if (_cachedTaskTypeProveritDokiId !== undefined) return _cachedTaskTypeProveritDokiId;
  try {
    const baseUrl = `https://${AMO_SUBDOMAIN}.amocrm.ru`;
    const r = await amoGet(`${baseUrl}/api/v4/account`, { with: "task_types" });
    const taskTypes = (r && r._embedded && r._embedded.task_types) || [];
    const found = taskTypes.find((t) => {
      const name = String(t.name || "").toLowerCase().trim();
      return name === "проверить доки" || name.startsWith("проверить док");
    });
    if (found) {
      _cachedTaskTypeProveritDokiId = found.id;
      console.log(`AMO TASK TYPE «Проверить доки»: id=${found.id} name="${found.name}"`);
    } else {
      _cachedTaskTypeProveritDokiId = null;
      console.log(`AMO TASK TYPE «Проверить доки» NOT FOUND. Available: ${taskTypes.map((t) => `"${t.name}"(id=${t.id})`).join(", ")}`);
    }
  } catch (e) {
    console.error("getProveritDokiTaskTypeId error:", e.response?.data || e.message);
    _cachedTaskTypeProveritDokiId = null;
  }
  return _cachedTaskTypeProveritDokiId;
}

async function getKtoPrinyalFieldId() {
  if (_cachedKtoPrinyalFieldId !== undefined) return _cachedKtoPrinyalFieldId;
  try {
    const baseUrl = `https://${AMO_SUBDOMAIN}.amocrm.ru`;
    const fields = await amoGetAllPages(`${baseUrl}/api/v4/leads/custom_fields`);
    const found = (fields || []).find((f) => {
      const name = String(f.name || "").toLowerCase().trim();
      return name.indexOf("кто принял") === 0;
    });
    if (found) {
      _cachedKtoPrinyalFieldId = found.id;
      console.log(`AMO FIELD «Кто принял клиента»: id=${found.id} name="${found.name}" type="${found.type}"`);
    } else {
      _cachedKtoPrinyalFieldId = null;
      console.log("AMO FIELD «Кто принял клиента» NOT FOUND — задачи будут падать на Visa Services Center");
    }
  } catch (e) {
    console.error("getKtoPrinyalFieldId error:", e.response?.data || e.message);
    _cachedKtoPrinyalFieldId = null;
  }
  return _cachedKtoPrinyalFieldId;
}

async function getVscUserId() {
  if (_cachedVscUserId !== undefined) return _cachedVscUserId;
  try {
    const baseUrl = `https://${AMO_SUBDOMAIN}.amocrm.ru`;
    const users = await amoGetAllPages(`${baseUrl}/api/v4/users`);
    const found = (users || []).find((u) => {
      const name = String(u.name || "").toLowerCase().trim();
      return name === "visa services center" || name.indexOf("visa services center") >= 0;
    });
    if (found) {
      _cachedVscUserId = found.id;
      console.log(`AMO USER «Visa Services Center»: id=${found.id} name="${found.name}"`);
    } else {
      _cachedVscUserId = null;
      console.log("AMO USER «Visa Services Center» NOT FOUND — fallback не сработает, задачи будут без responsible");
    }
  } catch (e) {
    console.error("getVscUserId error:", e.response?.data || e.message);
    _cachedVscUserId = null;
  }
  return _cachedVscUserId;
}

// Возвращает {pipelineName, statusName} для (pipeline_id, status_id) сделки.
// Используется для определения, какой воронке принадлежит лид при выборе ответственного.
async function getLeadPipelineName(lead) {
  if (!lead || !lead.pipeline_id) return "";
  try {
    const baseUrl = `https://${AMO_SUBDOMAIN}.amocrm.ru`;
    const statusMap = await getPipelinesMap(baseUrl);
    const meta = statusMap.get(`${lead.pipeline_id}:${lead.status_id}`);
    if (meta && meta.pipeline_name) return meta.pipeline_name;
  } catch (_) {}
  return "";
}

async function createAmoUploadTask(leadId) {
  if (!AMO_ACCESS_TOKEN || !AMO_SUBDOMAIN) return;
  if (!leadId) return;
  try {
    const baseUrl = `https://${AMO_SUBDOMAIN}.amocrm.ru`;
    const lead = await getLeadById(baseUrl, leadId);
    if (!lead) return;

    // Тип задачи: «Проверить доки» (если есть в amoCRM), fallback — встроенный «Связаться» (id=1).
    let taskTypeId = await getProveritDokiTaskTypeId();
    if (!taskTypeId) taskTypeId = 1;

    // По воронке выбираем, кому ставим задачу.
    // «Отдел Продаж» (любые этапы, кроме hidden) → поле «Отв-ный/Ответственный» (TASK_RESPONSIBLE_FIELD_ID).
    // «Отдел Оформления» / «Отдел по работе с Клиентами» → поле «Кто принял клиента»;
    //                                                     пусто → пользователь «Visa Services Center».
    const pipelineName = await getLeadPipelineName(lead);
    const pipelineLow = String(pipelineName || "").toLowerCase().trim();
    const isSales = pipelineLow.indexOf("отдел продаж") === 0;

    let responsibleUserId = null;
    if (isSales) {
      const respRaw = getEntityCustomFieldValue(lead, TASK_RESPONSIBLE_FIELD_ID);
      const respNum = respRaw != null ? Number(respRaw) : NaN;
      if (Number.isFinite(respNum) && respNum > 0) responsibleUserId = respNum;
    } else {
      const ktoFieldId = await getKtoPrinyalFieldId();
      if (ktoFieldId) {
        const ktoRaw = getEntityCustomFieldValue(lead, ktoFieldId);
        const ktoNum = ktoRaw != null ? Number(ktoRaw) : NaN;
        if (Number.isFinite(ktoNum) && ktoNum > 0) responsibleUserId = ktoNum;
      }
      if (!responsibleUserId) {
        const vscId = await getVscUserId();
        if (vscId) responsibleUserId = vscId;
      }
    }

    const nowSec = Math.floor(Date.now() / 1000);
    const taskBody = [{
      task_type_id: taskTypeId,
      text: "Загрузились новые документы от клиента из ЛК.",
      complete_till: nowSec,
      entity_id: Number(leadId),
      entity_type: "leads"
    }];
    if (responsibleUserId) {
      taskBody[0].responsible_user_id = responsibleUserId;
    }
    console.log(`CREATE TASK lead=${leadId} pipeline="${pipelineName}" isSales=${isSales} taskTypeId=${taskTypeId} responsible=${responsibleUserId || "(default)"}`);
    await amoPost(`${baseUrl}/api/v4/tasks`, taskBody);
  } catch (e) {
    console.error("CREATE AMO TASK ERROR:", e.response?.data || e.message);
  }
}

// Per-leadId последовательная очередь: все операции с amoCRM/<lead_id>/Документы из ЛК/
// идут строго по порядку (зеркало файла → пересборка zip → задача), чтобы избежать гонок
// при загрузке батчем и race condition при пересборе zip.
const amoQueues = new Map();
function amoEnqueue(leadId, label, fn) {
  if (!leadId) return Promise.resolve();
  const key = String(leadId);
  const prev = amoQueues.get(key) || Promise.resolve();
  const next = prev.then(async () => {
    console.log(`AMO QUEUE START [lead ${key}] ${label}`);
    try {
      await fn();
      console.log(`AMO QUEUE DONE  [lead ${key}] ${label}`);
    } catch (e) {
      console.error(`AMO QUEUE ERROR [lead ${key}] ${label}:`, e.response?.data || e.message || e);
    }
  });
  amoQueues.set(key, next);
  return next;
}

// Зеркалирование одного или нескольких файлов в /amoCRM/Сделки/<lead_id>/Документы из ЛК/...
// БЕЗ пересборки zip и БЕЗ создания задачи — финализация делается отдельно.
function mirrorFilesToAmoFolder(leadId, files) {
  if (!leadId) {
    console.log("AMO MIRROR SKIP: no leadId");
    return;
  }
  const list = Array.isArray(files) ? files : [files];
  if (!list.length) return;
  for (const f of list) {
    if (!f || !f.relativePath || !f.buffer) continue;
    amoEnqueue(leadId, `mirror ${f.relativePath}`, async () => {
      await uploadToAmoDealDocs(leadId, f.relativePath, f.buffer, f.contentType || "application/octet-stream");
    });
  }
}

// Подходит ли файл под «поле заявителя» — имя начинается с "<targetName> - <safeFio>",
// дальше либо «.» (расширение сразу), либо « » (затем " (2).ext" / " (3).ext").
// Используется для очистки предыдущих версий загрузки при повторной загрузке того же поля.
function matchesFieldFile(filename, targetName, safeFio) {
  const prefix = `${targetName} - ${safeFio}`;
  if (!String(filename).startsWith(prefix)) return false;
  const next = String(filename).charAt(prefix.length);
  return next === "." || next === " ";
}

// Удаляет в зеркале сделки все ранее загруженные файлы этого поля для этого заявителя
// (любое расширение / любой partSuffix). Встаёт в очередь ПЕРЕД новыми mirror-операциями.
function cleanupAmoFieldFilesInMirror(leadId, safeFio, targetName) {
  if (!leadId) return;
  amoEnqueue(leadId, `cleanup ${safeFio}/${targetName}`, async () => {
    const folder = `${amoDocsFolder(leadId)}/${safeFio}`;
    try {
      const items = await listYandexFolderFiles(folder);
      for (const name of items) {
        if (matchesFieldFile(name, targetName, safeFio)) {
          await deleteYandexResourceIfExists(`${folder}/${name}`);
        }
      }
    } catch (e) {
      console.error("AMO MIRROR cleanup error:", e.message);
    }
  });
}

// Финализация: пересборка zip + (опционально) создание задачи в amoCRM.
// Встаёт в очередь ПОСЛЕ всех ранее поставленных mirror-операций для этого leadId.
function finalizeAmoUpload(leadId, options = {}) {
  if (!leadId) {
    console.log("AMO FINALIZE SKIP: no leadId");
    return Promise.resolve();
  }
  const { createTask = false } = options;
  return amoEnqueue(leadId, `finalize (zip${createTask ? "+task" : ""})`, async () => {
    await rebuildAmoDocsZip(leadId);
    if (createTask) {
      await createAmoUploadTask(leadId);
    }
  });
}

// Метка источника для leads, созданных через ЛК. Кладётся как тег amoCRM.
// Можно переопределить через .env: LK_SOURCE_VALUE (по умолчанию «VOYO»).
const LK_SOURCE_VALUE = process.env.LK_SOURCE_VALUE || "VOYO";

// Создание контакта (если ещё нет) + новой сделки в воронке «Отдел продаж»,
// статус «Ещё не связывались». При applyPromo — добавляем закреплённый комментарий.
async function createAmoContactAndLeadForRegistration(phone, { promoApplied = false, promoText = "" } = {}) {
  const baseUrl = `https://${AMO_SUBDOMAIN}.amocrm.ru`;

  // 1) Ищем существующий контакт по телефону, чтобы не дублировать.
  let contactId = null;
  try {
    const existing = await findMatchingContacts(baseUrl, phone);
    if (existing && existing.length) contactId = existing[0].id;
  } catch (e) {
    console.error("REGISTER find contact err:", e.message);
  }

  // 2) Если контакта нет — создаём.
  if (!contactId) {
    const displayPhone = `+${phone}`;
    const contactBody = [{
      name: displayPhone,
      custom_fields_values: [{
        field_code: "PHONE",
        values: [{ value: displayPhone, enum_code: "WORK" }]
      }]
    }];
    const createRes = await amoPost(`${baseUrl}/api/v4/contacts`, contactBody);
    contactId = createRes?._embedded?.contacts?.[0]?.id;
    if (!contactId) throw new Error("Не удалось создать контакт");
  }

  // 3) Находим воронку «Отдел продаж» и статус «Ещё не связывались».
  const pipelines = await amoGetAllPages(`${baseUrl}/api/v4/leads/pipelines`);
  let pipelineId = null, statusId = null;
  for (const p of pipelines) {
    const pname = normalizeText(p.name);
    if (pname === "отдел продаж" || pname.startsWith("отдел продаж")) {
      pipelineId = p.id;
      const statuses = await amoGetAllPages(`${baseUrl}/api/v4/leads/pipelines/${p.id}/statuses`);
      for (const s of statuses) {
        if (normalizeText(s.name) === "ещё не связывались") {
          statusId = s.id;
          break;
        }
      }
      break;
    }
  }
  if (!pipelineId || !statusId) {
    throw new Error("Не найдена воронка/статус «Отдел продаж» → «Ещё не связывались»");
  }

  // 4) Создаём сделку, привязанную к контакту, с тегом-источником «VOYO».
  //    Раньше пробовали писать в custom-поле utm_term — оно у пользователя
  //    оказалось типа tracking_data (служебное для UTM-аналитики Flexbe).
  //    Запись туда технически проходит, но в UI карточки не показывается,
  //    и плюс переписывает реальные UTM от Flexbe. Поэтому используем теги —
  //    они видны в шапке сделки, фильтруются и ни с чем не конфликтуют.
  const leadBody = [{
    name: "Новое обращение из ЛК",
    pipeline_id: pipelineId,
    status_id: statusId,
    _embedded: {
      contacts: [{ id: contactId }],
      tags: [{ name: LK_SOURCE_VALUE }]
    }
  }];
  const leadRes = await amoPost(`${baseUrl}/api/v4/leads`, leadBody);
  const leadId = leadRes?._embedded?.leads?.[0]?.id;
  if (!leadId) throw new Error("Не удалось создать сделку");

  console.log(`REGISTER OK: phone=${phone} contactId=${contactId} leadId=${leadId} promo=${promoApplied} tag=${LK_SOURCE_VALUE}`);

  // 5) При applyPromo — закреплённый комментарий на сделке.
  if (promoApplied && promoText) {
    try {
      const noteBody = [{
        note_type: "common",
        is_pinned: true,
        params: { text: promoText }
      }];
      await amoPost(`${baseUrl}/api/v4/leads/${leadId}/notes`, noteBody);
    } catch (e) {
      console.error("REGISTER promo note err:", e.response?.data || e.message);
    }
  }

  return { contactId, leadId };
}

const UPLOAD_FIELDS_WHITELIST = {
  mainPassport:         "Загран. паспорт (в который запрашиваем визу)",
  innerPassport:        "Внутренний паспорт (1-ый разворот, разворот с актуальной пропиской, последний разворот)",
  secondPassport:       "2-ой загран. паспорт",
  thirdCountryTickets:  "Билеты в 3-ю страну на второй загран. паспорт",
  invitation:           "Приглашение",
  activeSchengenPhoto:  "Фото действующей Шенгенской визы",
  prevSchengenPhoto:    "Фото последней Шенгенской визы",
  birthCertificate:     "Свидетельство о рождении",
  sponsorPassport:      "1-ый разворот внутреннего паспорта РФ спонсора",
  insurancePolicy:      "Страховой полис для въезда в Шенген",
  workCert:             "Справка с работы или учёбы"
};

async function findMatchingContacts(baseUrl, phone) {
  const normalized = normalizePhone(phone);

  const variants = [...new Set([
    normalized,
    normalized.slice(-10),
    normalized.startsWith("7") ? `8${normalized.slice(1)}` : normalized
  ].filter(Boolean))];

  const contactsMap = new Map();

  for (const query of variants) {
    const contacts = await amoGetAllPages(`${baseUrl}/api/v4/contacts`, {
      query
    });

    for (const contact of contacts) {
      if (!contact?.id) continue;
      if (!contactMatchesPhone(contact, normalized)) continue;
      contactsMap.set(contact.id, contact);
    }
  }

  return Array.from(contactsMap.values());
}

async function collectLeadIdsFromContacts(baseUrl, contacts) {
  const leadIds = new Set();

  for (const contact of contacts) {
    const contactFull = await amoGet(`${baseUrl}/api/v4/contacts/${contact.id}`, {
      with: "leads"
    });

    const embeddedLeads = contactFull?._embedded?.leads || [];
    for (const lead of embeddedLeads) {
      if (lead?.id) {
        leadIds.add(lead.id);
      }
    }

    const links = await getEntityLinks(baseUrl, "contacts", contact.id);
    for (const link of links) {
      const toType = String(link.to_entity_type || "").toLowerCase();
      if ((toType === "leads" || toType === "lead") && link.to_entity_id) {
        leadIds.add(link.to_entity_id);
      }
    }
  }

  return Array.from(leadIds);
}

async function loadLeadsByIds(baseUrl, leadIds, statusesMap) {
  const leadsMap = new Map();

  for (const leadId of leadIds) {
    const lead = await getLeadById(baseUrl, leadId);
    if (!lead?.id) continue;

    const enrichedLead = enrichLeadWithMappedStatus(lead, statusesMap);
    if (enrichedLead.hidden_in_cabinet) continue;

    leadsMap.set(enrichedLead.id, enrichedLead);
  }

  return Array.from(leadsMap.values()).sort((a, b) => {
    return (b.created_at || 0) - (a.created_at || 0);
  });
}

async function getLeadsByPhone(phone) {
  const normalized = normalizePhone(phone);

  console.log("PHONE RAW:", phone);
  console.log("PHONE NORMALIZED:", normalized);
  console.log("AMO_SUBDOMAIN:", AMO_SUBDOMAIN);

  if (!normalized) return [];

  const baseUrl = `https://${AMO_SUBDOMAIN}.amocrm.ru`;

  const statusesMap = await getPipelinesMap(baseUrl);
  const contacts = await findMatchingContacts(baseUrl, normalized);

  console.log("MATCHED CONTACTS:", contacts.map((c) => ({
    id: c.id,
    phones: extractPhonesFromContact(c)
  })));

  if (!contacts.length) {
    return [];
  }

  const leadIds = await collectLeadIdsFromContacts(baseUrl, contacts);
  console.log("COLLECTED LEAD IDS:", leadIds);

  if (!leadIds.length) {
    return [];
  }

  const leads = await loadLeadsByIds(baseUrl, leadIds, statusesMap);

  console.log("VISIBLE LEADS:", leads.map((lead) => ({
    id: lead.id,
    name: lead.name,
    created_at: lead.created_at,
    pipeline_name: lead.pipeline_name,
    status_name: lead.status_name,
    cabinet_status: lead.cabinet_status,
    cabinet_stage_index: lead.cabinet_stage_index,
    country_service: lead.country_service
  })));

  return leads;
}

function buildQuestionnaireHtml({ phone, leadId, countryService, applicantIndex = 1, totalApplicants = 1, prevApplicantName = "", prefill = null, isEdit = false, applicantCount = 0, visaType = "", shareToken = "", isMixed = false, selfFillCount = 0, selfStep = 0, existingFios = [] }) {
  const safePhone = escapeHtml(phone || "");
  const safeLeadId = escapeHtml(String(leadId || ""));
  const safeCountry = escapeHtml(countryService || "не указано");
  const idx = Math.max(1, parseInt(applicantIndex, 10) || 1);
  const total = Math.max(idx, parseInt(totalApplicants, 10) || 1);
  const safePrevName = escapeHtml(prevApplicantName || "");
  const isFirstApplicant = idx === 1;
  const safeApplicantCount = Math.max(0, parseInt(applicantCount, 10) || 0);
  const safeVisaType = escapeHtml(visaType || "");
  const safeShareToken = escapeHtml(String(shareToken || ""));
  const isShareMode = !!shareToken;
  const mixedFlag = isMixed ? "1" : "";
  const safeSelfFillCount = Math.max(0, parseInt(selfFillCount, 10) || 0);
  const safeSelfStep = Math.max(0, parseInt(selfStep, 10) || 0);

  const titleText = visaType === "Шенгенская виза"
    ? "Опросник на Шенгенскую визу"
    : `Опросный лист на ${safeCountry}`;

  const subtitleText = isEdit
    ? "Внесите изменения и нажмите «Отправить опросник»."
    : 'Заполните данные и нажмите "Отправить опросник" внизу страницы';

  // В обычном режиме handoff показывается со 2-го applicantIndex.
  // В mixed-режиме applicantIndex может быть любым (first-free), поэтому используем selfStep.
  const showHandoff = isMixed
    ? (safeSelfStep > 1 && !isEdit)
    : (!isFirstApplicant && !isEdit);
  const handoffNoticeHtml = !showHandoff ? "" : `
    <div class="handoff-notice">
      Опросник для <strong>${safePrevName || "предыдущего заявителя"}</strong> отправлен. Заполните опросник на следующего заявителя.
    </div>`;

  const applicantCountFieldHtml = (!isEdit && safeApplicantCount > 0) ? `
    <input type="hidden" name="applicantCount" value="${safeApplicantCount}" />` : "";
  const mixedFieldsHtml = isMixed ? `
    <input type="hidden" name="mixed" value="1" />
    <input type="hidden" name="selfFillCount" value="${safeSelfFillCount}" />
    <input type="hidden" name="selfStep" value="${safeSelfStep}" />` : "";

  return `<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Опросный лист</title>
  <style>
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif;
      background: #f3f2f7;
      color: #1d2330;
      padding: 24px;
    }
    .wrap {
      max-width: 760px;
      margin: 0 auto;
      background: #fff;
      border: 1px solid #ece7f2;
      border-radius: 24px;
      padding: 24px;
      box-shadow: 0 10px 30px rgba(34, 36, 52, 0.05);
    }
    h1 { margin: 0 0 8px; font-size: 28px; line-height: 1.15; color: #171c29; }
    .subtitle { margin: 0 0 22px; font-size: 14px; color: #737988; line-height: 1.5; }
    form { display: grid; gap: 14px; }
    .field { display: grid; gap: 6px; }
    .field > label { font-size: 14px; font-weight: 600; color: #3a4150; }
    .field input[type="text"],
    .field input[type="tel"],
    .field input[type="email"],
    .field input[type="date"],
    .field select,
    .field textarea {
      width: 100%;
      height: 50px;
      border: 1px solid #e8e2ee;
      border-radius: 14px;
      padding: 0 14px;
      font-size: 16px;
      outline: none;
      background: #fff;
      color: #1f2532;
      font-family: inherit;
    }
    .field textarea { height: auto; min-height: 80px; padding: 12px 14px; resize: vertical; }
    .field select {
      appearance: none;
      background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='8' viewBox='0 0 12 8'%3E%3Cpath d='M1 1l5 5 5-5' stroke='%239096a3' stroke-width='1.5' fill='none' stroke-linecap='round'/%3E%3C/svg%3E");
      background-repeat: no-repeat;
      background-position: right 14px center;
      padding-right: 36px;
    }
    .field input[type="file"] {
      height: auto;
      padding: 10px 14px;
      border: 1px solid #e8e2ee;
      border-radius: 14px;
      background: #fff;
      font-size: 14px;
      cursor: pointer;
      width: 100%;
    }
    .hint { font-size: 12px; color: #9096a3; line-height: 1.4; }
    .radio-group { display: flex; gap: 10px; flex-wrap: wrap; }
    .radio-group label {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 14px;
      font-weight: 400;
      color: #1d2330;
      cursor: pointer;
      padding: 10px 16px;
      border: 1px solid #e8e2ee;
      border-radius: 12px;
      background: #fff;
    }
    .radio-group input[type="radio"] { accent-color: #4f9f68; width: 16px; height: 16px; }
    .radio-group label:has(input:checked) { border-color: #4f9f68; background: #f0faf3; }
    .radio-group label:has(input[name="confirmAccuracy"][value="Нет"]:checked),
    .radio-group label:has(input[name="confirmPrevData"][value="Нет"]:checked),
    .radio-group label:has(input[name="personalDataConsent"][value="Нет"]:checked) {
      border-color: #d97a8a;
      background: #fbebee;
      color: #a15561;
    }
    .radio-group label:has(input[name="confirmAccuracy"][value="Нет"]:checked) input,
    .radio-group label:has(input[name="confirmPrevData"][value="Нет"]:checked) input,
    .radio-group label:has(input[name="personalDataConsent"][value="Нет"]:checked) input {
      accent-color: #d97a8a;
    }
    .cond { display: none; }
    .cond.show { display: grid; gap: 14px; }
    .message {
      display: none;
      padding: 12px 14px;
      border-radius: 14px;
      font-size: 14px;
      margin-bottom: 16px;
    }
    .message.error { background: #fbebee; border: 1px solid #efcfd5; color: #a15561; }
    .message.success { background: #edf8ef; border: 1px solid #cfe7d2; color: #2e7a43; }
    .handoff-notice {
      padding: 12px 14px;
      border-radius: 14px;
      font-size: 14px;
      line-height: 1.5;
      background: #f0f7fc;
      border: 1px solid #d3e7f4;
      color: #2f6e95;
      margin-bottom: 14px;
    }
    .submit-btn {
      height: 50px;
      border: none;
      border-radius: 14px;
      background: #3589BD;
      color: #fff;
      font-size: 16px;
      font-weight: 600;
      cursor: pointer;
      margin-top: 8px;
    }
    .submit-btn:disabled { opacity: 0.7; cursor: not-allowed; }
    .date-row { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
    .date-row > input { min-width: 0; width: 100%; }
    @media (max-width: 480px) {
      .date-row { grid-template-columns: 1fr; }
    }
    .field input.input-error,
    .date-row input.input-error {
      border-color: #d97a8a !important;
      background: #fbebee !important;
      box-shadow: 0 0 0 3px rgba(217, 122, 138, 0.18) !important;
    }

    .ack-row {
      display: flex;
      align-items: flex-start;
      gap: 10px;
      margin-top: 12px;
      font-size: 14px;
      color: #1d2330;
      line-height: 1.45;
      cursor: pointer;
    }
    .ack-row input[type="checkbox"] {
      margin: 3px 0 0;
      accent-color: #4f9f68;
      width: 16px;
      height: 16px;
      flex: 0 0 auto;
    }
    .ack-row.ack-error,
    .ack-row.ack-error span {
      color: #c4314b;
    }
    .ack-row.ack-error input[type="checkbox"] {
      outline: 2px solid #c4314b;
      outline-offset: 2px;
      border-radius: 3px;
    }
  </style>
</head>
<body>
<div class="wrap">
  <h1>${titleText}</h1>
  <p class="subtitle">${subtitleText}</p>

  <div id="successBox" class="message success"></div>
${handoffNoticeHtml}
  <form id="questionnaireForm">
    <input type="hidden" name="phone" value="${safePhone}" />
    <input type="hidden" name="leadId" value="${safeLeadId}" />
    <input type="hidden" name="applicantIndex" value="${idx}" />
    <input type="hidden" name="totalApplicants" value="${total}" />
    <input type="hidden" name="isEdit" value="${isEdit ? "1" : ""}" />
    <input type="hidden" name="visaType" value="${safeVisaType}" />
    <input type="hidden" name="shareToken" value="${safeShareToken}" />
${applicantCountFieldHtml}
${mixedFieldsHtml}
    <!-- 1 -->
    <div class="field">
      <label>Полное имя (ФИО) *</label>
      <input type="text" name="fullName" required />
    </div>

    <!-- 2 -->
    <div class="field">
      <label>У меня ранее были предыдущие фамилии</label>
      <div class="radio-group">
        <label><input type="radio" name="hadPrevSurnames" value="Да" /> Да</label>
        <label><input type="radio" name="hadPrevSurnames" value="Нет" /> Нет</label>
      </div>
    </div>

    <!-- 3 условно -->
    <div class="cond" id="c_prevSurnames">
      <div class="field">
        <label>Укажите все предыдущие фамилии *</label>
        <input type="text" name="prevSurnames" />
      </div>
    </div>

    <!-- 4 -->
    <div class="field">
      <label>Телефон *</label>
      <input type="tel" name="contactPhone" inputmode="tel" autocomplete="tel" placeholder="+7 (___) ___-__-__" data-phone-mask required />
      <span class="hint">Тот, по которому Консульство сможет связаться с заявителем</span>
    </div>

    <!-- 5 -->
    <div class="field">
      <label>Почта *</label>
      <input type="email" name="email" inputmode="email" autocomplete="email" placeholder="example@mail.ru" required />
      <span class="hint">Та, по которой Консульство сможет связаться с заявителем</span>
    </div>

    <!-- 6 -->
    <div class="field">
      <label>Семейное положение *</label>
      <select name="maritalStatus" required>
        <option value="">— выберите —</option>
        <option value="Не в браке">Не в браке</option>
        <option value="В браке">В браке</option>
        <option value="В разводе">В разводе</option>
        <option value="Вдовец/вдова">Вдовец/вдова</option>
      </select>
    </div>

    <!-- 7 -->
    <div class="field">
      <label>При рождении у меня было иное гражданство</label>
      <div class="radio-group">
        <label><input type="radio" name="hadOtherCitizenshipAtBirth" value="Да" /> Да</label>
        <label><input type="radio" name="hadOtherCitizenshipAtBirth" value="Нет" /> Нет</label>
      </div>
    </div>

    <!-- 8 условно -->
    <div class="cond" id="c_birthCitizenship">
      <div class="field">
        <label>Ваше гражданство при рождении *</label>
        <input type="text" name="birthCitizenship" />
      </div>
    </div>

    <!-- 9 -->
    <div class="field">
      <label>У меня в данный момент есть второе гражданство</label>
      <div class="radio-group">
        <label><input type="radio" name="hasSecondCitizenship" value="Да" /> Да</label>
        <label><input type="radio" name="hasSecondCitizenship" value="Нет" /> Нет</label>
      </div>
    </div>

    <!-- 10 условно -->
    <div class="cond" id="c_secondCitizenship">
      <div class="field">
        <label>Укажите второе гражданство *</label>
        <input type="text" name="secondCitizenship" />
      </div>
    </div>

    <!-- 11 -->
    <div class="field">
      <label>У меня есть второй заграничный паспорт</label>
      <div class="radio-group">
        <label><input type="radio" name="hasSecondPassport" value="Да" /> Да</label>
        <label><input type="radio" name="hasSecondPassport" value="Нет" /> Нет</label>
      </div>
    </div>

    <!-- 12, 13, 14 условно -->
    <div class="cond" id="c_secondPassport">
      <div class="field">
        <label>На какой паспорт мы оформляем все документы? *</label>
        <input type="text" name="whichPassport" />
      </div>
      <div class="field">
        <label>Можете ли вы сдать второй паспорт в ВЦ на период рассмотрения? *</label>
        <div class="radio-group">
          <label><input type="radio" name="canSurrenderPassport" value="Да" /> Да</label>
          <label><input type="radio" name="canSurrenderPassport" value="Нет" /> Нет</label>
        </div>
      </div>
      <div class="cond" id="c_surrenderReason">
        <div class="field">
          <label>Укажите, по какой причине не сдаете паспорт: *</label>
          <input type="text" name="surrenderReason" />
        </div>
      </div>
    </div>

    <!-- 15 -->
    <div class="field">
      <label>Фактический адрес проживания *</label>
      <input type="text" name="actualAddress" required />
      <span class="hint">Может не совпадать с адресом регистрации</span>
    </div>

    <!-- 16 -->
    <div class="field">
      <label>Род занятий (занимаемая должность) *</label>
      <input type="text" name="occupation" required />
      <span class="hint">Вносится в анкету только при предоставлении подтверждающего документа (справки, документов на бизнес, пенсионного и т. д.)</span>
    </div>

    <!-- 17 -->
    <div class="field">
      <label>Наименование работодателя/учебной организации *</label>
      <input type="text" name="employerName" required />
      <span class="hint">Если вы не учитесь и не работаете, укажите НЕТ.</span>
    </div>

    <!-- 18 -->
    <div class="field">
      <label>Адрес работодателя/учебной организации *</label>
      <input type="text" name="employerAddress" required />
      <span class="hint">Если вы не учитесь и не работаете, укажите НЕТ.</span>
    </div>

    <!-- 19 — скрываем, если employerName === «НЕТ» (любой регистр) -->
    <div class="cond" id="c_employerPhone">
      <div class="field">
        <label>Телефон работодателя *</label>
        <input type="tel" name="employerPhone" inputmode="tel" placeholder="+7 (___) ___-__-__" data-phone-mask required />
      </div>
    </div>

    <!-- 20 -->
    <div class="field">
      <label>Цель поездки *</label>
      <select name="tripPurpose" id="tripPurpose" required>
        <option value="">— выберите —</option>
        <option value="Туризм">Туризм</option>
        <option value="Бизнес">Бизнес</option>
        <option value="Частный визит">Частный визит</option>
        <option value="Лечение">Лечение</option>
        <option value="Обучение">Обучение</option>
        <option value="Иное">Иное</option>
      </select>
    </div>

    <!-- 21 условно -->
    <div class="cond" id="c_purposeOther">
      <div class="field">
        <label>Если Вы выбрали цель поездки "Иное", укажите подробности в этом поле *</label>
        <input type="text" name="tripPurposeOther" />
      </div>
    </div>

    <!-- 22 -->
    <div class="field">
      <label>Я делаю визу, чтобы пройти собеседование на США в Польше</label>
      <div class="radio-group">
        <label><input type="radio" name="usaInterviewPoland" value="Да" /> Да</label>
        <label><input type="radio" name="usaInterviewPoland" value="Нет" /> Нет</label>
      </div>
      <span class="hint">Если да, ваш паспорт обязан быть БИОМЕТРИЧЕСКИМ.</span>
    </div>

    <!-- 23 -->
    <div class="field">
      <label>Страна поездки *</label>
      <input type="text" name="travelCountry" required />
    </div>

    <!-- 24 -->
    <div class="field">
      <label>В какую страну запрашивается виза *</label>
      <input type="text" name="visaCountry" required />
    </div>

    <!-- 25 -->
    <div class="field">
      <label>Даты поездки *</label>
      <div class="date-row" id="tripDatesInputs">
        <input type="date" name="tripDateFrom" required />
        <input type="date" name="tripDateTo" required />
      </div>
      <label class="ack-row" id="tripDatesUnknownRow">
        <input type="checkbox" name="tripDatesUnknown" value="Да" />
        <span>Я ещё не знаю точных дат поездки.</span>
      </label>
      <label class="ack-row" id="tripDatesAckRow" style="display: none;">
        <input type="checkbox" name="tripDatesAck" value="Да" />
        <span>Я проинформирован (-а) о сроках рассмотрения, обязуюсь предоставить информацию о датах поездки минимум за неделю до подачи документов в Консульство.<br />Я так же и проинформирован (-а) о том, что при изменении дат поездки после того, как пакет документов уже подготовлен, может потребоваться дополнительная оплата.</span>
      </label>
    </div>

    <!-- 26 -->
    <div class="field">
      <label>У меня есть действующая шенгенская виза</label>
      <div class="radio-group">
        <label><input type="radio" name="hasActiveSchengen" value="Да" /> Да</label>
        <label><input type="radio" name="hasActiveSchengen" value="Нет" /> Нет</label>
      </div>
    </div>

    <!-- 27 условно -->
    <div class="cond" id="c_schengenExpiry">
      <div class="field">
        <label>Укажите дату окончания текущей визы *</label>
        <input type="date" name="schengenExpiry" />
      </div>
    </div>

    <!-- 28 -->
    <div class="field">
      <label>У меня были Шенгенские визы за последние 3 года</label>
      <div class="radio-group">
        <label><input type="radio" name="hadSchengen3Years" value="Да" /> Да</label>
        <label><input type="radio" name="hadSchengen3Years" value="Нет" /> Нет</label>
      </div>
    </div>

    <!-- 29, 30, 31, 32, 33 условно -->
    <div class="cond" id="c_prevSchengen">
      <div class="field">
        <label>Я не открыл/-а свою последнюю шенгенскую визу</label>
        <div class="radio-group">
          <label><input type="radio" name="didNotUseVisa" value="Да" /> Да</label>
          <label><input type="radio" name="didNotUseVisa" value="Нет" /> Нет</label>
        </div>
        <span class="hint">Отметьте, если вы ею не воспользовались</span>
      </div>
      <div class="cond" id="c_didNotUseReason">
        <div class="field">
          <label>Укажите причину, почему виза не была отъезжена *</label>
          <input type="text" name="didNotUseReason" />
        </div>
      </div>
      <div class="field">
        <label>Я открыл/-а свою последнюю шенгенскую визу не той страной, которая ее выдала</label>
        <div class="radio-group">
          <label><input type="radio" name="visaRefused" value="Да" /> Да</label>
          <label><input type="radio" name="visaRefused" value="Нет" /> Нет</label>
        </div>
      </div>
      <div class="cond" id="c_refusalReason">
        <div class="field">
          <label>Укажите причину *</label>
          <input type="text" name="refusalReason" />
        </div>
      </div>
    </div>

    <!-- 34 -->
    <div class="field">
      <label>У меня есть действительная страховка для въезда в Шенгенскую зону</label>
      <div class="radio-group">
        <label><input type="radio" name="hasInsurance" value="Да" /> Да</label>
        <label><input type="radio" name="hasInsurance" value="Нет" /> Нет</label>
      </div>
      <span class="hint">Покрывает все страны Шенгена и минимум €30,000, действительная минимум на даты поездки.</span>
    </div>

    <!-- 34а условно -->
    <div class="cond" id="c_wantBuyInsurance">
      <div class="field">
        <label>Я хочу приобрести страховку для оформления визы у вас</label>
        <div class="radio-group">
          <label><input type="radio" name="wantBuyInsurance" value="Да" /> Да</label>
          <label><input type="radio" name="wantBuyInsurance" value="Нет" /> Нет</label>
        </div>
      </div>
    </div>

    <!-- 35 -->
    <div class="field">
      <label>На момент подачи документов я буду младше 18 лет</label>
      <div class="radio-group">
        <label><input type="radio" name="isUnder18" value="Да" /> Да</label>
        <label><input type="radio" name="isUnder18" value="Нет" /> Нет</label>
      </div>
    </div>

    <!-- 36 условно -->
    <div class="cond" id="c_legalRep">
      <div class="field">
        <label>ФИО законного представителя *</label>
        <input type="text" name="legalRepresentative" />
        <span class="hint">Вносится в анкету для лиц младше 18 лет</span>
      </div>
    </div>

    <!-- 37 -->
    <div class="field">
      <label>Мою поездку спонсирует третье лицо/компания</label>
      <div class="radio-group">
        <label><input type="radio" name="hasSponsor" value="Да" /> Да</label>
        <label><input type="radio" name="hasSponsor" value="Нет" /> Нет</label>
      </div>
    </div>

    <!-- 38 условно -->
    <div class="cond" id="c_sponsorName">
      <div class="field">
        <label>Укажите ФИО/наименование спонсора *</label>
        <input type="text" name="sponsorName" />
      </div>
    </div>

    <!-- 39 -->
    <div class="field">
      <label>Тип подачи *</label>
      <select name="visitType" required>
        <option value="">— выберите —</option>
        <option value="Личная">Личная</option>
        <option value="Без присутствия">Без присутствия</option>
      </select>
    </div>

    <!-- 40 -->
    <div class="field">
      <label>Как вы хотите забрать готовые документы для подачи? *</label>
      <select name="pickupMethod" required>
        <option value="">— выберите —</option>
        <option value="В офисе">В офисе</option>
        <option value="Курьером">Курьером</option>
        <option value="Электронная почта">Электронная почта</option>
      </select>
    </div>

    <!-- 41 -->
    <div class="field">
      <label>У меня есть документы, подтверждающие льготную оплату консульского сбора</label>
      <div class="radio-group">
        <label><input type="radio" name="hasConsularFeeDoc" value="Да" /> Да</label>
        <label><input type="radio" name="hasConsularFeeDoc" value="Нет" /> Нет</label>
      </div>
    </div>

    <!-- 42 -->
    <div class="field">
      <label>Я хочу воспользоваться услугой записи ботом</label>
      <div class="radio-group">
        <label><input type="radio" name="useBotBooking" value="Да" /> Да</label>
        <label><input type="radio" name="useBotBooking" value="Нет" /> Нет</label>
      </div>
    </div>

    <!-- 43-47 условно -->
    <div class="cond" id="c_botBooking">
      <div class="field">
        <label>Диапазон записи *</label>
        <div class="date-row">
          <input type="date" name="bookingDateFrom" />
          <input type="date" name="bookingDateTo" />
        </div>
      </div>
      <div class="field">
        <label>Исключения *</label>
        <input type="text" name="bookingExclusions" />
        <span class="hint">Даты и дни, когда Вы не сможете пойти на подачу</span>
      </div>
      <div class="field">
        <label>Город для записи *</label>
        <input type="text" name="bookingCity" />
      </div>
      <div class="field">
        <label>Если у вас есть исключения или пожелания по датам, в которые вас можно или нельзя записывать, пропишите их здесь. *</label>
        <input type="text" name="bookingTimePrefs" />
        <span class="hint">Если нет - напишите "НЕТ".</span>
      </div>
      <div class="field">
        <label>При записи в случае наличия бизнес-залов/ускоренных записей (дополнительная услуга в ВЦ), какие из этих услуг вас интересуют? *</label>
        <input type="text" name="bookingLoungePrefs" />
      </div>
    </div>

    <!-- 48 -->
    <div class="field">
      <label>Откуда Вы о нас узнали? *</label>
      <select name="howFoundUs" required>
        <option value="">— выберите —</option>
        <option value="Instagram">Instagram</option>
        <option value="Telegram-канал">Telegram-канал</option>
        <option value="Поиск Google">Поиск Google</option>
        <option value="Поиск Yandex">Поиск Yandex</option>
        <option value="Яндекс Карты">Яндекс Карты</option>
        <option value="2Гис">2Гис</option>
        <option value="Google Maps">Google Maps</option>
        <option value="По рекомендации">По рекомендации</option>
        <option value="Реклама в Интернете">Реклама в Интернете</option>
      </select>
    </div>

    <!-- 49 -->
    <div class="field">
      <label>Примечания</label>
      <textarea name="notes" rows="3"></textarea>
      <span class="hint">Любые подробности, которые Вы хотите добавить к своей заявке.</span>
    </div>

    <!-- 50 -->
    <div class="field">
      <label>Я подтверждаю правильность и достоверность указанных мной сведений. *</label>
      <div class="radio-group">
        <label><input type="radio" name="confirmAccuracy" value="Да" required /> Да</label>
        <label><input type="radio" name="confirmAccuracy" value="Нет" /> Нет</label>
      </div>
    </div>

    <!-- 51 -->
    <div class="field">
      <label>Настоящим я соглашаюсь, что данные, внесенные в электронный опросник, являются частью заключенного со мной договора и в случае предоставления недостоверных сведений ответственность за возможные последствия несу лично я. *</label>
      <div class="radio-group">
        <label><input type="radio" name="confirmPrevData" value="Да" required /> Да</label>
        <label><input type="radio" name="confirmPrevData" value="Нет" /> Нет</label>
      </div>
    </div>

    <!-- 52 -->
    <div class="field">
      <label>Даю согласие на обработку персональных данных. *</label>
      <div class="radio-group">
        <label><input type="radio" name="personalDataConsent" value="Да" required /> Да</label>
        <label><input type="radio" name="personalDataConsent" value="Нет" /> Нет</label>
      </div>
    </div>

    <div id="errorBox" class="message error"></div>

    <button id="submitBtn" class="submit-btn" type="submit">Отправить опросник</button>
  </form>
</div>

<script>
  const form = document.getElementById("questionnaireForm");
  const submitBtn = document.getElementById("submitBtn");
  const errorBox = document.getElementById("errorBox");
  const successBox = document.getElementById("successBox");

  function showBox(el, msg) { el.style.display = "block"; el.textContent = msg || ""; }
  function hideBox(el) { el.style.display = "none"; el.textContent = ""; }

  function radio(name) {
    const el = form.querySelector('input[name="' + name + '"]:checked');
    return el ? el.value : null;
  }

  function toggle(id, show) {
    const el = document.getElementById(id);
    if (!el) return;
    el.classList.toggle("show", !!show);
  }

  function updateConditionals() {
    toggle("c_prevSurnames",      radio("hadPrevSurnames") === "Да");
    toggle("c_birthCitizenship",  radio("hadOtherCitizenshipAtBirth") === "Да");
    toggle("c_secondCitizenship", radio("hasSecondCitizenship") === "Да");
    toggle("c_secondPassport",    radio("hasSecondPassport") === "Да");
    toggle("c_surrenderReason",   radio("canSurrenderPassport") === "Нет");
    const purpose = form.querySelector('[name="tripPurpose"]');
    toggle("c_purposeOther",      purpose && purpose.value === "Иное");
    toggle("c_schengenExpiry",    radio("hasActiveSchengen") === "Да");
    toggle("c_prevSchengen",      radio("hadSchengen3Years") === "Да");
    toggle("c_didNotUseReason",   radio("didNotUseVisa") === "Да");
    toggle("c_refusalReason",     radio("visaRefused") === "Да");
    toggle("c_legalRep",          radio("isUnder18") === "Да");
    toggle("c_sponsorName",       radio("hasSponsor") === "Да");
    toggle("c_botBooking",        radio("useBotBooking") === "Да");
    // «Я хочу приобрести страховку у вас» — показываем, если у клиента нет своей страховки.
    toggle("c_wantBuyInsurance",  radio("hasInsurance") === "Нет");

    // «Телефон работодателя» — скрываем, если работодатель = «НЕТ» (любой регистр).
    const empNameEl = form.querySelector('input[name="employerName"]');
    const empNameVal = (empNameEl && empNameEl.value || "").trim().toUpperCase();
    const showEmployerPhone = empNameVal !== "НЕТ";
    toggle("c_employerPhone", showEmployerPhone);
    // Снимаем/возвращаем required, чтобы скрытое поле не блокировало сабмит браузером.
    const empPhoneEl = form.querySelector('input[name="employerPhone"]');
    if (empPhoneEl) {
      if (showEmployerPhone) {
        empPhoneEl.required = true;
      } else {
        empPhoneEl.required = false;
        empPhoneEl.classList.remove("input-error");
      }
    }
  }

  form.addEventListener("change", updateConditionals);
  // employerName — текстовое поле, нужно слушать input для мгновенной реакции.
  form.addEventListener("input", (e) => {
    if (e.target && e.target.name === "employerName") updateConditionals();
  });
  updateConditionals();

  // ─── Маска для телефонных полей: +7 (XXX) XXX-XX-XX ───
  function formatPhoneRu(rawDigits) {
    let d = String(rawDigits || "").replace(/\\D/g, "");
    if (d.length && d[0] === "8") d = "7" + d.slice(1);
    if (d.length && d[0] !== "7") d = "7" + d;
    d = d.slice(0, 11);
    const a = d.slice(1, 4);
    const b = d.slice(4, 7);
    const c = d.slice(7, 9);
    const e = d.slice(9, 11);
    let out = "+7";
    if (a) out += " (" + a;
    if (a.length === 3) out += ")";
    if (b) out += " " + b;
    if (c) out += "-" + c;
    if (e) out += "-" + e;
    return out;
  }
  function attachPhoneMask(input) {
    if (!input) return;
    function applyMask(skipIfEmpty) {
      const v = input.value || "";
      if (skipIfEmpty && !v.replace(/\\D/g, "")) return;
      input.value = formatPhoneRu(v);
    }
    if (input.value) applyMask(true);
    input.addEventListener("input", () => applyMask(false));
    input.addEventListener("focus", () => {
      if (!input.value) input.value = "+7 ";
    });
    input.addEventListener("blur", () => {
      if (input.value.replace(/\\D/g, "").length <= 1) input.value = "";
    });
  }
  document.querySelectorAll('input[data-phone-mask]').forEach(attachPhoneMask);

  // ─── Даты поездки: первая ≥ завтра, вторая ≥ первой ───
  function pad2(n) { return n < 10 ? "0" + n : String(n); }
  function ymd(date) {
    return date.getFullYear() + "-" + pad2(date.getMonth() + 1) + "-" + pad2(date.getDate());
  }
  function applyTripDateConstraints() {
    const tripFrom = form.querySelector('input[name="tripDateFrom"]');
    const tripTo = form.querySelector('input[name="tripDateTo"]');
    if (!tripFrom || !tripTo) return;
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const tomorrowStr = ymd(tomorrow);
    tripFrom.min = tomorrowStr;
    if (tripFrom.value && tripFrom.value < tomorrowStr) tripFrom.value = tomorrowStr;
    const fromVal = tripFrom.value || tomorrowStr;
    tripTo.min = fromVal;
    if (tripTo.value && tripTo.value < fromVal) tripTo.value = fromVal;
    tripFrom.addEventListener("change", () => {
      const v = tripFrom.value || tomorrowStr;
      tripTo.min = v;
      if (tripTo.value && tripTo.value < v) tripTo.value = v;
    });
  }
  applyTripDateConstraints();

  // ─── Логика «Я ещё не знаю точных дат поездки» ───
  const tripUnknownInput = form.querySelector('input[name="tripDatesUnknown"]');
  const tripAckInput = form.querySelector('input[name="tripDatesAck"]');
  const tripAckRow = document.getElementById("tripDatesAckRow");
  const tripDatesInputsEl = document.getElementById("tripDatesInputs");
  const tripFromInputEl = form.querySelector('input[name="tripDateFrom"]');
  const tripToInputEl = form.querySelector('input[name="tripDateTo"]');

  function applyTripDatesUnknownState() {
    if (!tripUnknownInput) return;
    const unknown = tripUnknownInput.checked;
    if (unknown) {
      if (tripDatesInputsEl) tripDatesInputsEl.style.display = "none";
      if (tripFromInputEl) {
        tripFromInputEl.required = false;
        tripFromInputEl.classList.remove("input-error");
      }
      if (tripToInputEl) {
        tripToInputEl.required = false;
        tripToInputEl.classList.remove("input-error");
      }
      if (tripAckRow) tripAckRow.style.display = "";
    } else {
      if (tripDatesInputsEl) tripDatesInputsEl.style.display = "";
      if (tripFromInputEl) tripFromInputEl.required = true;
      if (tripToInputEl) tripToInputEl.required = true;
      if (tripAckRow) {
        tripAckRow.style.display = "none";
        tripAckRow.classList.remove("ack-error");
      }
      if (tripAckInput) tripAckInput.checked = false;
    }
  }
  if (tripUnknownInput) {
    tripUnknownInput.addEventListener("change", applyTripDatesUnknownState);
  }
  if (tripAckInput && tripAckRow) {
    tripAckInput.addEventListener("change", () => {
      if (tripAckInput.checked) tripAckRow.classList.remove("ack-error");
    });
  }
  applyTripDatesUnknownState();

  // ─── Проверка дубликата ФИО в рамках этой сделки ───
  const EXISTING_FIOS = ${JSON.stringify(existingFios || []).replace(/</g, "\\u003c")};
  const CURRENT_APPLICANT_INDEX = ${JSON.stringify(applicantIndex)};
  function normFio(s) {
    return String(s || "").trim().replace(/\\s+/g, " ").toLowerCase();
  }
  const fullNameInput = form.querySelector('input[name="fullName"]');
  let fioDupErrEl = null;
  if (fullNameInput) {
    fioDupErrEl = document.createElement("div");
    fioDupErrEl.className = "field-inline-error";
    fioDupErrEl.style.color = "#c4314b";
    fioDupErrEl.style.fontSize = "13px";
    fioDupErrEl.style.marginTop = "6px";
    fioDupErrEl.style.lineHeight = "1.4";
    fioDupErrEl.style.display = "none";
    fioDupErrEl.textContent = "Опросник на это ФИО уже заполнен в этой сделке. Укажите другое ФИО.";
    fullNameInput.insertAdjacentElement("afterend", fioDupErrEl);
  }
  function checkFioDuplicate() {
    if (!fullNameInput) return false;
    const v = normFio(fullNameInput.value);
    if (!v) {
      if (fioDupErrEl) fioDupErrEl.style.display = "none";
      fullNameInput.classList.remove("input-error");
      if (submitBtn) submitBtn.disabled = false;
      return false;
    }
    const isDup = EXISTING_FIOS.some((it) => {
      const otherIdx = parseInt(it && it.idx, 10);
      const otherFio = normFio(it && it.fullName);
      if (!otherFio) return false;
      // В edit-режиме своё ФИО разрешено (тот же applicantIndex).
      if (otherIdx === CURRENT_APPLICANT_INDEX) return false;
      return otherFio === v;
    });
    if (isDup) {
      if (fioDupErrEl) fioDupErrEl.style.display = "block";
      fullNameInput.classList.add("input-error");
      if (submitBtn) submitBtn.disabled = true;
    } else {
      if (fioDupErrEl) fioDupErrEl.style.display = "none";
      fullNameInput.classList.remove("input-error");
      if (submitBtn) submitBtn.disabled = false;
    }
    return isDup;
  }
  if (fullNameInput) {
    fullNameInput.addEventListener("input", checkFioDuplicate);
    fullNameInput.addEventListener("blur", checkFioDuplicate);
    // Первичная проверка (например, при prefill)
    setTimeout(checkFioDuplicate, 0);
  }

  // Prefill (для режима "Скорректировать опросник")
  const PREFILL = ${JSON.stringify(prefill || null).replace(/</g, "\\u003c")};
  if (PREFILL && typeof PREFILL === "object") {
    Object.keys(PREFILL).forEach((name) => {
      const val = PREFILL[name];
      if (val === null || val === undefined || val === "") return;
      const inputs = form.querySelectorAll('[name="' + name + '"]');
      inputs.forEach((input) => {
        const t = (input.type || "").toLowerCase();
        if (t === "radio" || t === "checkbox") {
          input.checked = (input.value === String(val));
        } else if (t === "file" || t === "hidden") {
          return;
        } else {
          input.value = String(val);
        }
      });
    });
    updateConditionals();
    // После prefill пересинхронизируем UI чек-бокса «не знаю дат» (скрытие/показ полей дат)
    applyTripDatesUnknownState();
  }

  // Снимаем подсветку ошибки с поля при изменении/вводе
  form.addEventListener("input", (e) => {
    if (e.target && e.target.classList && e.target.classList.contains("input-error")) {
      e.target.classList.remove("input-error");
    }
  });
  form.addEventListener("change", (e) => {
    if (e.target && e.target.classList && e.target.classList.contains("input-error")) {
      e.target.classList.remove("input-error");
    }
  });

  function validateRequiredFields() {
    // Список пар «обязательных» дат — проверяем только те, что видимы (не внутри скрытого .cond)
    const datePairs = [
      ["tripDateFrom", "tripDateTo"],
      ["bookingDateFrom", "bookingDateTo"]
    ];
    let firstBad = null;
    datePairs.forEach((pair) => {
      pair.forEach((name) => {
        const el = form.querySelector('input[name="' + name + '"]');
        if (!el) return;
        // Проверяем только видимые поля
        if (el.offsetParent === null) return;
        if (!el.value) {
          el.classList.add("input-error");
          if (!firstBad) firstBad = el;
        }
      });
    });
    return firstBad;
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    hideBox(errorBox);
    hideBox(successBox);

    // Проверка дубликата ФИО — финальная страховка перед отправкой
    if (checkFioDuplicate()) {
      if (fullNameInput && fullNameInput.scrollIntoView) {
        fullNameInput.scrollIntoView({ behavior: "smooth", block: "center" });
      }
      try { if (fullNameInput) fullNameInput.focus({ preventScroll: true }); } catch (_) { if (fullNameInput) fullNameInput.focus(); }
      return;
    }

    // Если клиент выбрал «Я ещё не знаю точных дат поездки» — даты не обязательны,
    // зато требуется подтверждающий чек-бокс ниже. Если он не отмечен — блокируем сабмит,
    // подсвечиваем строку красным.
    if (tripUnknownInput && tripUnknownInput.checked) {
      if (tripAckInput && !tripAckInput.checked) {
        if (tripAckRow) {
          tripAckRow.classList.add("ack-error");
          if (tripAckRow.scrollIntoView) tripAckRow.scrollIntoView({ behavior: "smooth", block: "center" });
        }
        showBox(errorBox, "Поставьте галочку в чек-боксе подтверждения сроков.");
        return;
      }
    } else {
      // Обычный путь — обе даты обязательны (validateRequiredFields пропускает скрытые поля).
      const badDate = validateRequiredFields();
      if (badDate) {
        showBox(errorBox, "Заполните даты поездки — оба поля обязательны.");
        if (badDate.scrollIntoView) badDate.scrollIntoView({ behavior: "smooth", block: "center" });
        try { badDate.focus({ preventScroll: true }); } catch (_) { badDate.focus(); }
        return;
      }
    }

    // Проверка согласий — без сброса данных формы
    const accuracyVal = radio("confirmAccuracy");
    if (accuracyVal !== "Да") {
      showBox(errorBox, 'Чтобы отправить опросник, подтвердите правильность и достоверность указанных сведений (выберите "Да").');
      const el = form.querySelector('input[name="confirmAccuracy"]');
      if (el && el.scrollIntoView) el.scrollIntoView({ behavior: "smooth", block: "center" });
      return;
    }
    const prevDataVal = radio("confirmPrevData");
    if (prevDataVal !== "Да") {
      showBox(errorBox, 'Чтобы отправить опросник, согласитесь с условиями электронного опросника (выберите "Да").');
      const el = form.querySelector('input[name="confirmPrevData"]');
      if (el && el.scrollIntoView) el.scrollIntoView({ behavior: "smooth", block: "center" });
      return;
    }
    const consentVal = radio("personalDataConsent");
    if (consentVal !== "Да") {
      showBox(errorBox, 'Чтобы отправить опросник, согласитесь на обработку персональных данных (выберите "Да").');
      const el = form.querySelector('input[name="personalDataConsent"]');
      if (el && el.scrollIntoView) el.scrollIntoView({ behavior: "smooth", block: "center" });
      return;
    }

    submitBtn.disabled = true;
    submitBtn.textContent = "Отправка...";

    try {
      const formData = new FormData(form);

      const response = await fetch("/api/questionnaire", {
        method: "POST",
        body: formData
      });

      const data = await response.json();

      if (!response.ok || !data.success) {
        throw new Error(data.message || "Не удалось отправить опросник");
      }

      const IS_SHARE_MODE = ${JSON.stringify(isShareMode)};
      if (IS_SHARE_MODE) {
        showBox(successBox, "Спасибо! Опросник отправлен. Можете закрыть страницу.");
        submitBtn.style.display = "none";
        if (successBox.scrollIntoView) successBox.scrollIntoView({ behavior: "smooth", block: "center" });
        return;
      }

      showBox(successBox, "Опросник успешно отправлен");

      try {
        localStorage.setItem("vsc_questionnaire_updated", JSON.stringify({
          phone: "${safePhone}",
          leadId: "${safeLeadId}",
          ts: Date.now()
        }));
      } catch (_) {}

      setTimeout(() => {
        if (data.nextApplicantUrl) {
          window.location.href = data.nextApplicantUrl;
          return;
        }
        if (window.opener && !window.opener.closed) { window.close(); return; }
        if (window.history.length > 1) { window.history.back(); return; }
        window.location.href = "/";
      }, 700);
    } catch (error) {
      console.error("QUESTIONNAIRE SUBMIT ERROR:", error);
      showBox(errorBox, error.message || "Ошибка отправки опросника");
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = "Отправить опросник";
    }
  });
</script>
</body>
</html>`;
}

function getPdfFontPath() {
  const candidates = [
    path.join(__dirname, "fonts", "DejaVuSans.ttf"),
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/usr/share/fonts/TTF/DejaVuSans.ttf"
  ];

  for (const fontPath of candidates) {
    if (fs.existsSync(fontPath)) {
      return fontPath;
    }
  }

  return null;
}

async function generateQuestionnairePdfBuffer(data) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 40 });

    const chunks = [];
    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const fontPath = getPdfFontPath();
    if (fontPath) doc.font(fontPath);

    // ── Геометрия таблицы ──
    const MARGIN = 40;
    const TABLE_W = doc.page.width - 2 * MARGIN;
    const Q_W = Math.floor(TABLE_W * 0.55);
    const A_W = TABLE_W - Q_W;
    const PAD_X = 6;
    const PAD_Y = 5;
    const FS_Q = 10;
    const FS_A = 10;
    const FS_SECTION = 12;

    function ensureSpace(needed) {
      const bottom = doc.page.height - MARGIN;
      if (doc.y + needed > bottom) doc.addPage();
    }

    function drawSectionHeader(title) {
      doc.moveDown(0.4);
      const h = FS_SECTION + 8;
      ensureSpace(h + 4);
      const y = doc.y;
      doc.rect(MARGIN, y, TABLE_W, h).fillAndStroke("#3589BD", "#3589BD");
      doc.fillColor("#ffffff").fontSize(FS_SECTION).text(
        title,
        MARGIN + PAD_X,
        y + (h - FS_SECTION) / 2,
        { width: TABLE_W - 2 * PAD_X, lineBreak: false }
      );
      doc.fillColor("#000000");
      doc.y = y + h;
    }

    // Строка-«ячейка» опросника. Левая — вопрос (серый фон), правая — ответ (белый).
    // Если значение пустое — строка не рисуется.
    function drawRow(question, answer) {
      if (answer === undefined || answer === null) return;
      const a = String(answer);
      if (!a.trim()) return;
      const q = String(question || "");

      doc.fontSize(FS_Q);
      const qHeight = doc.heightOfString(q, { width: Q_W - 2 * PAD_X });
      doc.fontSize(FS_A);
      const aHeight = doc.heightOfString(a, { width: A_W - 2 * PAD_X });
      const rowHeight = Math.max(qHeight, aHeight) + 2 * PAD_Y;

      ensureSpace(rowHeight);
      const y = doc.y;

      doc.lineWidth(0.5).strokeColor("#c8ccd4");
      doc.rect(MARGIN, y, Q_W, rowHeight).fillAndStroke("#f3f2f7", "#c8ccd4");
      doc.rect(MARGIN + Q_W, y, A_W, rowHeight).fillAndStroke("#ffffff", "#c8ccd4");

      doc.fillColor("#1d2330").fontSize(FS_Q).text(
        q,
        MARGIN + PAD_X,
        y + PAD_Y,
        { width: Q_W - 2 * PAD_X }
      );
      doc.fillColor("#1d2330").fontSize(FS_A).text(
        a,
        MARGIN + Q_W + PAD_X,
        y + PAD_Y,
        { width: A_W - 2 * PAD_X }
      );

      doc.y = y + rowHeight;
    }

    // ── Шапка ──
    doc.fontSize(18).fillColor("#161d45").text("Опросный лист", { align: "left" });
    doc.fillColor("#1d2330").moveDown(0.3);
    doc.fontSize(11);
    doc.text(`Страна оформления/услуга: ${data.countryService || "не указано"}`);
    doc.text(`Телефон клиента: ${data.phone || ""}`);
    doc.text(`ID сделки: ${data.leadId || ""}`);
    doc.text(`Дата заполнения: ${new Date().toLocaleString("ru-RU")}`);

    // ── Личные данные ──
    drawSectionHeader("Личные данные");
    drawRow("Полное имя (ФИО)", data.fullName);
    drawRow("У меня ранее были предыдущие фамилии", data.hadPrevSurnames);
    drawRow("Укажите все предыдущие фамилии", data.prevSurnames);
    drawRow("Телефон", data.contactPhone);
    drawRow("Почта", data.email);
    drawRow("Семейное положение", data.maritalStatus);
    drawRow("При рождении у меня было иное гражданство", data.hadOtherCitizenshipAtBirth);
    drawRow("Ваше гражданство при рождении", data.birthCitizenship);
    drawRow("У меня в данный момент есть второе гражданство", data.hasSecondCitizenship);
    drawRow("Укажите второе гражданство", data.secondCitizenship);
    drawRow("У меня есть второй заграничный паспорт", data.hasSecondPassport);
    drawRow("На какой паспорт мы оформляем все документы", data.whichPassport);
    drawRow("Можете ли вы сдать второй паспорт в ВЦ на период рассмотрения", data.canSurrenderPassport);
    drawRow("Укажите, по какой причине не сдаете паспорт", data.surrenderReason);

    // ── Адрес и занятость ──
    drawSectionHeader("Адрес и занятость");
    drawRow("Фактический адрес проживания", data.actualAddress);
    drawRow("Род занятий (занимаемая должность)", data.occupation);
    drawRow("Наименование работодателя/учебной организации", data.employerName);
    drawRow("Адрес работодателя/учебной организации", data.employerAddress);
    drawRow("Телефон работодателя", data.employerPhone);

    // ── Поездка ──
    drawSectionHeader("Поездка");
    drawRow("Цель поездки", data.tripPurpose);
    drawRow('Подробности цели "Иное"', data.tripPurposeOther);
    drawRow("Виза для собеседования на США в Польше", data.usaInterviewPoland);
    drawRow("Страна поездки", data.travelCountry);
    drawRow("В какую страну запрашивается виза", data.visaCountry);
    if (data.tripDatesUnknown === "Да") {
      drawRow("Даты поездки", "Точные даты пока не известны");
      if (data.tripDatesAck === "Да") {
        drawRow(
          "Подтверждение клиента",
          "проинформирован о сроках рассмотрения; обязуется предоставить даты минимум за неделю до подачи в Консульство; в курсе о возможной доплате при изменении дат после подготовки пакета"
        );
      }
    } else if (data.tripDateFrom || data.tripDateTo) {
      drawRow("Даты поездки", `${data.tripDateFrom || "?"} — ${data.tripDateTo || "?"}`);
    }

    // ── История виз ──
    drawSectionHeader("История виз");
    drawRow("Есть действующая шенгенская виза", data.hasActiveSchengen);
    drawRow("Дата окончания текущей визы", data.schengenExpiry);
    drawRow("Были Шенгенские визы за последние 3 года", data.hadSchengen3Years);
    drawRow("Не открыл/-а последнюю шенгенскую визу", data.didNotUseVisa);
    drawRow("Причина, почему виза не была отъезжена", data.didNotUseReason);
    drawRow("Открыл/-а визу не той страной, которая её выдала", data.visaRefused);
    drawRow("Укажите причину", data.refusalReason);

    // ── Документы и услуги ──
    drawSectionHeader("Документы и услуги");
    drawRow("Есть действительная страховка для въезда в Шенгенскую зону", data.hasInsurance);
    if (data.hasInsurance === "Нет") {
      drawRow("Хочу приобрести страховку для оформления визы у вас", data.wantBuyInsurance);
    }
    drawRow("На момент подачи документов младше 18 лет", data.isUnder18);
    drawRow("ФИО законного представителя", data.legalRepresentative);
    drawRow("Поездку спонсирует третье лицо/компания", data.hasSponsor);
    drawRow("ФИО/наименование спонсора", data.sponsorName);
    drawRow("Тип подачи", data.visitType);
    drawRow("Способ получения готовых документов", data.pickupMethod);
    drawRow("Есть документы на льготную оплату консульского сбора", data.hasConsularFeeDoc);

    // ── Запись ботом ──
    drawSectionHeader("Запись ботом");
    drawRow("Хочу воспользоваться услугой записи ботом", data.useBotBooking);
    if (data.bookingDateFrom || data.bookingDateTo) {
      drawRow("Диапазон записи", `${data.bookingDateFrom || "?"} — ${data.bookingDateTo || "?"}`);
    }
    drawRow("Исключения", data.bookingExclusions);
    drawRow("Город для записи", data.bookingCity);
    drawRow("Пожелания по датам записи", data.bookingTimePrefs);
    drawRow("Дополнительные услуги в ВЦ (бизнес-залы/ускоренные)", data.bookingLoungePrefs);

    // ── Прочее ──
    drawSectionHeader("Прочее");
    drawRow("Откуда узнали о нас", data.howFoundUs);
    drawRow("Примечания", data.notes);
    drawRow("Подтверждаю правильность и достоверность сведений", data.confirmAccuracy);
    drawRow("Согласие с условиями договора по электронному опроснику", data.confirmPrevData);
    drawRow("Согласие на обработку персональных данных", data.personalDataConsent);

    doc.end();
  });
}

app.get("/api/leads", async (req, res) => {
  try {
    const phone = req.query.phone || "";

    console.log("HANDLER /api/leads phone =", phone);

    if (!phone) {
      return res.status(400).json({
        success: false,
        message: "Не передан phone"
      });
    }

    if (!AMO_SUBDOMAIN || !AMO_ACCESS_TOKEN) {
      return res.status(500).json({
        success: false,
        message: "Не настроены переменные amoCRM"
      });
    }

    const leads = await getLeadsByPhone(phone);

    // Триггер «обратная связь по ЛК»: одна SMS на номер за всё время, после того
    // как сделка перешла на этап «Подготовка документов». Не блокируем ответ —
    // если что-то пойдёт не так, кабинет всё равно покажется.
    maybeSendFeedbackSms(phone, leads).catch((e) => {
      console.error("FEEDBACK trigger error:", e && e.message);
    });

    return res.json({
      success: true,
      leads
    });
  } catch (error) {
    console.error("API /api/leads error:");
    console.error("message:", error.message);
    console.error("status:", error.response?.status);
    console.error("", error.response?.data);
    console.error("stack:", error.stack);

    return res.status(500).json({
      success: false,
      message: "Ошибка при получении сделок",
      error: error.response?.data || error.message
    });
  }
});

const VISA_TYPES = [
  "Шенгенская виза",
  "Виза в Японию",
  "Виза в США",
  "Виза в Великобританию",
  "Виза в Австралию",
  "Виза в Новую Зеландию",
  "Виза в Южную Корею (K-ETA)",
  "Виза в Саудовскую Аравию",
  "Виза в Индию",
  "Виза в Израиль (ETA)",
  "Виза в Азербайджан",
  "Виза в Россию (E-Visa)",
  "Виза в Северную Македонию",
  "Виза в Египет",
  "Виза в Мексику",
  "Виза во Вьетнам",
  "Виза на Сейшельские острова",
  "Виза в Уганду",
  "Виза на Шри-Ланку",
  "Виза в Бахрейн",
  "Виза в Эфиопию",
  "Виза в Кению"
];

function buildQuestionnaireStartHtml({ phone, leadId }) {
  const safePhone = escapeHtml(phone || "");
  const safeLeadId = escapeHtml(String(leadId || ""));
  const visaOptionsHtml = VISA_TYPES.map((v) => {
    const safe = escapeHtml(v);
    return `<option value="${safe}">${safe}</option>`;
  }).join("\n");

  return `<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Опросный лист — начало</title>
  <style>
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif;
      background: #f3f2f7;
      color: #1d2330;
      padding: 24px;
    }
    .wrap {
      max-width: 760px;
      margin: 0 auto;
      background: #fff;
      border: 1px solid #ece7f2;
      border-radius: 24px;
      padding: 24px;
      box-shadow: 0 10px 30px rgba(34, 36, 52, 0.05);
    }
    h1 { margin: 0 0 8px; font-size: 28px; line-height: 1.15; color: #171c29; }
    .subtitle { margin: 0 0 22px; font-size: 14px; color: #737988; line-height: 1.5; }
    form { display: grid; gap: 14px; }
    .field { display: grid; gap: 6px; }
    .field > label { font-size: 14px; font-weight: 600; color: #3a4150; }
    .field select {
      width: 100%;
      height: 50px;
      border: 1px solid #e8e2ee;
      border-radius: 14px;
      padding: 0 14px;
      font-size: 16px;
      outline: none;
      background: #fff;
      color: #1f2532;
      font-family: inherit;
      appearance: none;
      background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='8' viewBox='0 0 12 8'%3E%3Cpath d='M1 1l5 5 5-5' stroke='%239096a3' stroke-width='1.5' fill='none' stroke-linecap='round'/%3E%3C/svg%3E");
      background-repeat: no-repeat;
      background-position: right 14px center;
      padding-right: 36px;
    }
    .cond { display: none; }
    .cond.show { display: grid; gap: 14px; }
    .info-box {
      padding: 14px 16px;
      border-radius: 14px;
      background: #f0f7fc;
      border: 1px solid #d3e7f4;
      color: #2f6e95;
      font-size: 14px;
      line-height: 1.5;
    }
    .submit-btn {
      height: 50px;
      border: none;
      border-radius: 14px;
      background: #3589BD;
      color: #fff;
      font-size: 16px;
      font-weight: 600;
      cursor: pointer;
      margin-top: 8px;
    }
    .submit-btn:disabled { opacity: 0.55; cursor: not-allowed; }
    .radio-group { display: flex; gap: 10px; flex-wrap: wrap; }
    .radio-group label {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 14px;
      color: #1d2330;
      cursor: pointer;
      padding: 10px 16px;
      border: 1px solid #e8e2ee;
      border-radius: 12px;
      background: #fff;
      flex: 1 1 220px;
    }
    .radio-group input[type="radio"] { accent-color: #4f9f68; width: 16px; height: 16px; }
    .radio-group label:has(input:checked) { border-color: #4f9f68; background: #f0faf3; }
    #smsRows { display: grid; gap: 10px; }
    .sms-row {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      align-items: center;
    }
    .sms-row input[type="tel"] {
      flex: 1 1 200px;
      height: 44px;
      border: 1px solid #e8e2ee;
      border-radius: 12px;
      padding: 0 14px;
      font-size: 15px;
      outline: none;
      background: #fff;
      color: #1f2532;
      font-family: inherit;
      transition: border-color 0.2s ease, box-shadow 0.2s ease;
    }
    .sms-row input[type="tel"]:focus {
      border-color: #3589BD;
      box-shadow: 0 0 0 3px rgba(53, 137, 189, 0.12);
    }
    .sms-send-btn {
      flex: 0 0 auto;
      height: 44px;
      padding: 0 16px;
      border: 1.5px solid #3589BD;
      border-radius: 12px;
      background: #fff;
      color: #3589BD;
      font-size: 13px;
      font-weight: 600;
      cursor: pointer;
      white-space: nowrap;
      transition: background 0.2s ease, color 0.2s ease, border-color 0.2s ease, opacity 0.2s ease;
    }
    .sms-send-btn:hover:not(:disabled) { background: #f0f7fc; }
    .sms-send-btn:disabled { opacity: 0.55; cursor: not-allowed; }
    .sms-row.is-sent input[type="tel"] {
      background: #f6fbf8;
      border-color: #cfe7d2;
      color: #2e7a43;
    }
    .sms-row.is-sent .sms-send-btn {
      background: #f0faf3;
      border-color: #4f9f68;
      color: #4f9f68;
      cursor: default;
    }
    .sms-remove-btn {
      flex: 0 0 auto;
      width: 40px;
      height: 44px;
      padding: 0;
      border: 1px solid #e8e2ee;
      border-radius: 12px;
      background: #fff;
      color: #9096a3;
      font-size: 22px;
      line-height: 1;
      cursor: pointer;
      font-weight: 600;
      display: none;
      align-items: center;
      justify-content: center;
      transition: border-color 0.15s ease, color 0.15s ease, background 0.15s ease;
    }
    .sms-row.has-remove .sms-remove-btn { display: inline-flex; }
    .sms-remove-btn:hover {
      border-color: #d97a8a;
      color: #a15561;
      background: #fbebee;
    }
    .sms-add-btn {
      background: transparent;
      border: none;
      color: #3589BD;
      font-size: 14px;
      font-weight: 600;
      padding: 6px 0;
      margin-top: 4px;
      cursor: pointer;
      text-align: left;
      display: inline-block;
    }
    .sms-add-btn:disabled { opacity: 0.45; cursor: not-allowed; }
    .sms-msg {
      flex-basis: 100%;
      font-size: 13px;
      line-height: 1.4;
    }
    .sms-msg.error { color: #a15561; }
    .sms-msg.success { color: #2e7a43; }
    .sms-hint { font-size: 12px; color: #9096a3; line-height: 1.4; }
  </style>
</head>
<body>
<div class="wrap">
  <h1>Опросный лист</h1>
  <p class="subtitle">Выберите визу/услугу, на которую заполняем опросный лист.</p>

  <form id="startForm">
    <div class="field">
      <label>На какую визу/услугу заполняем опросник? *</label>
      <select name="visaType" id="visaType" required>
        <option value="" disabled selected>Выберите визу/услугу</option>
${visaOptionsHtml}
      </select>
    </div>

    <div class="cond" id="c_count">
      <div class="field">
        <label>На какое количество человек заполняем опросные листы? *</label>
        <select name="applicantCount" id="applicantCount">
          <option value="" disabled selected>Выберите количество</option>
          <option value="1">1</option>
          <option value="2">2</option>
          <option value="3">3</option>
          <option value="4">4</option>
          <option value="5">5</option>
          <option value="6">6</option>
          <option value="7">7</option>
          <option value="8">8</option>
          <option value="9">9</option>
          <option value="10">10</option>
        </select>
      </div>
    </div>

    <div class="cond" id="c_mode">
      <div class="field">
        <label>Вы будете заполнять опросники за всех заявителей, или хотите, чтобы кому-то из заявителей ушло SMS со ссылкой на заполнение опросника?</label>
        <div class="radio-group" id="modeGroup">
          <label><input type="radio" name="fillMode" value="self" /> Я заполню за всех</label>
          <label><input type="radio" name="fillMode" value="sms" /> Некоторым нужно отправить SMS со ссылкой на заполнение опросника</label>
        </div>
      </div>
      <div class="cond" id="c_smsBlock">
        <div class="field">
          <label>Отправьте SMS со ссылкой на заполнение опросника</label>
          <div id="smsRows"></div>
          <button type="button" class="sms-add-btn" id="smsAddBtn">+ Добавить поле</button>
          <p class="sms-hint" id="smsHint"></p>
        </div>
      </div>
    </div>

    <div class="cond" id="c_underdev">
      <div class="info-box">Раздел в разработке</div>
    </div>

    <button type="submit" class="submit-btn" id="continueBtn" disabled>Продолжить</button>
  </form>
</div>

<script>
  const PHONE = ${JSON.stringify(safePhone)};
  const LEAD_ID = ${JSON.stringify(safeLeadId)};

  const visaSelect = document.getElementById("visaType");
  const countSelect = document.getElementById("applicantCount");
  const countCond = document.getElementById("c_count");
  const modeCond = document.getElementById("c_mode");
  const smsBlockCond = document.getElementById("c_smsBlock");
  const underdevCond = document.getElementById("c_underdev");
  const continueBtn = document.getElementById("continueBtn");
  const smsRows = document.getElementById("smsRows");
  const smsAddBtn = document.getElementById("smsAddBtn");
  const smsHint = document.getElementById("smsHint");

  // sentSms: набор номеров (нормализованных), на которые уже отправили SMS
  const sentSms = new Set();

  function applicantCountVal() {
    return parseInt(countSelect.value, 10) || 0;
  }

  function fillModeVal() {
    const el = document.querySelector('input[name="fillMode"]:checked');
    return el ? el.value : null;
  }

  function normalizePhoneJs(raw) {
    const digits = String(raw || "").replace(/\\D/g, "");
    if (!digits) return "";
    if (digits.length === 11 && digits.startsWith("8")) return "7" + digits.slice(1);
    if (digits.length === 10) return "7" + digits;
    return digits;
  }

  function update() {
    const v = visaSelect.value;
    const isSchengen = v === "Шенгенская виза";
    countCond.classList.toggle("show", isSchengen);
    underdevCond.classList.toggle("show", !!v && !isSchengen);

    const countVal = applicantCountVal();
    const showMode = isSchengen && countVal > 1;
    modeCond.classList.toggle("show", showMode);
    if (!showMode) {
      // сбрасываем выбор режима, чтобы случайный «sms» не залип после смены количества
      const checked = document.querySelector('input[name="fillMode"]:checked');
      if (checked) checked.checked = false;
    }
    const isSmsMode = showMode && fillModeVal() === "sms";
    smsBlockCond.classList.toggle("show", isSmsMode);

    if (isSmsMode && smsRows.children.length === 0) addSmsRow();
    refreshSmsAddState();

    // Кнопка «Продолжить» доступна для:
    // — шенген + count >= 1 (один заявитель — без вопроса о режиме)
    // — count > 1 + выбран режим (любой)
    let canContinue = false;
    if (isSchengen && countVal > 0) {
      if (countVal === 1) canContinue = true;
      else if (fillModeVal()) canContinue = true;
    }
    continueBtn.disabled = !canContinue;

    // Текст кнопки: если все опросники уже разосланы SMS — «Готово»
    if (isSmsMode && sentSms.size >= countVal) {
      continueBtn.textContent = "Готово";
    } else {
      continueBtn.textContent = "Продолжить";
    }
  }

  function addSmsRow() {
    const countVal = applicantCountVal();
    if (smsRows.children.length >= countVal) return;
    const row = document.createElement("div");
    row.className = "sms-row";
    row.innerHTML = ''
      + '<input type="tel" placeholder="+7 999 123-45-67" autocomplete="off" inputmode="tel" />'
      + '<button type="button" class="sms-send-btn">Отправить SMS с опросником</button>'
      + '<button type="button" class="sms-remove-btn" aria-label="Убрать поле" title="Убрать поле">−</button>'
      + '<div class="sms-msg" style="display:none;"></div>';
    smsRows.appendChild(row);
    const input = row.querySelector('input[type="tel"]');
    const sendBtn = row.querySelector('.sms-send-btn');
    const removeBtn = row.querySelector('.sms-remove-btn');
    const msg = row.querySelector('.sms-msg');
    sendBtn.addEventListener("click", () => sendSms(row, input, sendBtn, msg));
    removeBtn.addEventListener("click", () => removeSmsRow(row));
    refreshRowsLayout();
    refreshSmsAddState();
  }

  function removeSmsRow(row) {
    // Если эта строка уже отправляла SMS — снимаем из набора
    if (row.classList.contains("is-sent")) {
      const input = row.querySelector('input[type="tel"]');
      const norm = input ? normalizePhoneJs(input.value.trim()) : "";
      if (norm) sentSms.delete(norm);
    }
    if (row.parentNode) row.parentNode.removeChild(row);
    refreshRowsLayout();
    refreshSmsAddState();
    update();
  }

  function refreshRowsLayout() {
    // Кнопка "−" отображается на каждой строке, кроме первой
    const rows = Array.from(smsRows.children);
    rows.forEach((row, idx) => {
      row.classList.toggle("has-remove", idx > 0);
    });
  }

  function refreshSmsAddState() {
    const countVal = applicantCountVal();
    const rows = smsRows.children.length;
    smsAddBtn.disabled = rows >= countVal;
    smsHint.textContent = countVal > 0
      ? "Добавлено полей: " + rows + " из " + countVal + " (по количеству заявителей)"
      : "";
  }

  async function sendSms(row, input, btn, msg) {
    msg.style.display = "none";
    msg.className = "sms-msg";
    const raw = input.value.trim();
    const norm = normalizePhoneJs(raw);
    if (!norm || norm.length < 11) {
      msg.style.display = "block";
      msg.className = "sms-msg error";
      msg.textContent = "Введите корректный номер телефона";
      return;
    }
    if (sentSms.has(norm)) {
      msg.style.display = "block";
      msg.className = "sms-msg error";
      msg.textContent = "На этот номер уже отправлено SMS";
      return;
    }
    btn.disabled = true;
    const prevText = btn.textContent;
    btn.textContent = "Отправка...";
    try {
      const r = await fetch("/api/questionnaire/share", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          phone: PHONE,
          leadId: LEAD_ID,
          applicantCount: applicantCountVal(),
          visaType: visaSelect.value,
          recipientPhone: norm
        })
      });
      const data = await r.json();
      if (!r.ok || !data.success) {
        throw new Error(data.message || "Не удалось отправить SMS");
      }
      sentSms.add(norm);
      input.value = norm;
      input.readOnly = true;
      row.classList.add("is-sent");
      btn.textContent = data.testMode ? "Отправлено (тестовый режим)" : "SMS отправлено";
      msg.style.display = "block";
      msg.className = "sms-msg success";
      msg.textContent = data.testMode
        ? "Тестовый режим SMS.ru — реальное сообщение не отправлено, но логика работает."
        : "Ссылка отправлена.";
      update();
    } catch (err) {
      btn.disabled = false;
      btn.textContent = prevText;
      msg.style.display = "block";
      msg.className = "sms-msg error";
      msg.textContent = err.message || "Ошибка отправки";
    }
  }

  smsAddBtn.addEventListener("click", addSmsRow);
  visaSelect.addEventListener("change", update);
  countSelect.addEventListener("change", () => {
    // Если количество уменьшили — удаляем лишние SMS-строки (только не отправленные)
    const target = applicantCountVal();
    while (smsRows.children.length > target) {
      const last = smsRows.lastElementChild;
      if (last && !last.classList.contains("is-sent")) {
        smsRows.removeChild(last);
      } else {
        break;
      }
    }
    update();
  });
  document.addEventListener("change", (e) => {
    if (e.target && e.target.name === "fillMode") update();
  });
  update();

  document.getElementById("startForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const v = visaSelect.value;
    if (v !== "Шенгенская виза") return;
    const count = applicantCountVal();
    if (count < 1) return;

    const sent = sentSms.size;
    const isMixed = count > 1 && fillModeVal() === "sms" && sent > 0;
    const selfFillCount = isMixed ? Math.max(0, count - sent) : count;

    // Если все опросники разосланы по SMS — возвращаемся в кабинет
    if (isMixed && selfFillCount === 0) {
      window.location.href = "/cabinet?phone=" + encodeURIComponent(PHONE);
      return;
    }

    const params = new URLSearchParams({
      phone: PHONE,
      leadId: LEAD_ID,
      applicantCount: String(count),
      visaType: v
    });
    if (isMixed) {
      params.set("mixed", "1");
      params.set("selfFillCount", String(selfFillCount));
      params.set("selfStep", "1");
    }
    window.location.href = "/questionnaire?" + params.toString();
  });
</script>
</body>
</html>`;
}

// ──────────────────────────────────────────────────────────
// Share-токены опросника (SMS-ссылки на заполнение)
// ──────────────────────────────────────────────────────────
const SHARE_TOKENS_FILE = path.join(__dirname, ".shareTokens.json");
const SHARE_TOKEN_TTL_MS = 14 * 24 * 60 * 60 * 1000; // 14 дней
const shareTokens = new Map();

function loadShareTokens() {
  try {
    const raw = fs.readFileSync(SHARE_TOKENS_FILE, "utf8");
    const arr = JSON.parse(raw);
    if (Array.isArray(arr)) {
      const now = Date.now();
      arr.forEach((item) => {
        if (item && item.token && item.createdAt && now - item.createdAt < SHARE_TOKEN_TTL_MS) {
          shareTokens.set(item.token, item);
        }
      });
    }
  } catch (_) {}
}

function saveShareTokens() {
  try {
    const arr = Array.from(shareTokens.values());
    fs.writeFileSync(SHARE_TOKENS_FILE, JSON.stringify(arr, null, 2), "utf8");
  } catch (e) {
    console.error("saveShareTokens error:", e.message);
  }
}

function purgeOldShareTokens() {
  const now = Date.now();
  let changed = false;
  for (const [token, data] of shareTokens.entries()) {
    if (now - data.createdAt >= SHARE_TOKEN_TTL_MS) {
      shareTokens.delete(token);
      changed = true;
    }
  }
  if (changed) saveShareTokens();
}

function createShareToken({ phone, leadId, applicantCount, visaType }) {
  const token = crypto.randomBytes(24).toString("hex");
  const data = {
    token,
    phone,
    leadId,
    applicantCount: Math.max(1, parseInt(applicantCount, 10) || 1),
    visaType: visaType || "",
    createdAt: Date.now()
  };
  shareTokens.set(token, data);
  saveShareTokens();
  return token;
}

function getShareToken(token) {
  purgeOldShareTokens();
  if (!token || typeof token !== "string") return null;
  return shareTokens.get(token) || null;
}

// Список заполненных ФИО заявителей в рамках конкретной сделки.
// Используется для блокировки дубликатов ФИО в опроснике этой сделки.
async function getExistingApplicantFios(phone, leadId) {
  if (!phone || !YANDEX_DISK_TOKEN) return [];
  try {
    const files = await listAllTechFiles(phone, leadId);
    const indexes = new Set();
    files.forEach((name) => {
      const m = /^Опросник(?:\s+(\d+))?\.json$/i.exec(name);
      if (m) indexes.add(parseInt(m[1] || "1", 10));
    });
    const out = [];
    for (const idx of indexes) {
      try {
        const state = await loadApplicantJson(phone, leadId, idx);
        if (state && state.fullName) {
          out.push({ idx, fullName: String(state.fullName).trim() });
        }
      } catch (_) {}
    }
    return out;
  } catch (e) {
    console.error("getExistingApplicantFios error:", e.message);
    return [];
  }
}

function normalizeFioForCompare(s) {
  return String(s || "").trim().replace(/\s+/g, " ").toLowerCase();
}

// Следующий свободный applicantIndex для НОВОГО опросника в рамках конкретной сделки.
async function getNextApplicantIndex(phone, leadId) {
  try {
    const files = await listAllTechFiles(phone, leadId);
    const used = new Set();
    files.forEach((name) => {
      const m = /^Опросник(?:\s+(\d+))?\.json$/i.exec(name);
      if (m) used.add(parseInt(m[1] || "1", 10));
    });
    let idx = 1;
    while (used.has(idx)) idx++;
    return idx;
  } catch (e) {
    console.error("getNextApplicantIndex error:", e.message);
    return 1;
  }
}

loadShareTokens();

// ──────────────────────────────────────────────────────────
// Feedback (обратная связь по ЛК): SMS-ссылка после перехода
// сделки в «Подготовка документов» + страница опроса + PDF на Я.Диск.
// Одному номеру шлём максимум ОДИН раз за всё время.
// ──────────────────────────────────────────────────────────

const FEEDBACK_DISK_FOLDER = "Опросники по ЛК VOYO";

// ФИО с большой буквы — тот же приём, что и formatFio в cabinet.html
// (lowercase всё → capitalize первую букву каждого «слова», разделители \s и -).
function formatFioTitleCase(s) {
  const lower = String(s || "").trim().toLowerCase();
  if (!lower) return "";
  return lower.replace(/(^|[\s-])(\p{L})/gu, (_, sep, ch) => sep + ch.toUpperCase());
}

// Опции 3-го вопроса (показывается, если на Q1 ответили «Да»).
// Тексты используются и как value на чекбоксах, и как метка в PDF —
// чтобы не дублировать справочник в двух местах.
const FEEDBACK_Q3_OPTIONS = [
  "eSIM (быстрое подключение зарубежной eSIM в поездке для использования мобильного интернета)",
  "Оформление туристической страховки (включая страхование от экстремальных видов спорта, и прочие нестандартные виды страхования)",
  "Поиск отеля (аналог booking / ostrovok)",
  "Поиск экскурсий в городах назначения",
  "Поиск авторских туров",
  "Раздел для организации деловых поездок"
];

const FEEDBACK_SENT_FILE = path.join(__dirname, ".feedbackSent.json");
const FEEDBACK_TOKENS_FILE = path.join(__dirname, ".feedbackTokens.json");
const feedbackSent = new Map();    // phone(7XXXXXXXXXX) -> { sentAt, fullName }
const feedbackTokens = new Map();  // token -> { token, phone, fullName, createdAt, submittedAt? }

function loadFeedbackSent() {
  try {
    const raw = fs.readFileSync(FEEDBACK_SENT_FILE, "utf8");
    const obj = JSON.parse(raw);
    if (obj && typeof obj === "object") {
      Object.entries(obj).forEach(([phone, data]) => {
        if (data && typeof data === "object") {
          feedbackSent.set(phone, data);
        } else if (data) {
          feedbackSent.set(phone, { sentAt: Number(data) || Date.now(), fullName: "" });
        }
      });
    }
  } catch (_) {}
}

function saveFeedbackSent() {
  try {
    const obj = Object.fromEntries(feedbackSent.entries());
    fs.writeFileSync(FEEDBACK_SENT_FILE, JSON.stringify(obj, null, 2), "utf8");
  } catch (e) {
    console.error("saveFeedbackSent error:", e.message);
  }
}

function loadFeedbackTokens() {
  try {
    const raw = fs.readFileSync(FEEDBACK_TOKENS_FILE, "utf8");
    const arr = JSON.parse(raw);
    if (Array.isArray(arr)) {
      arr.forEach((item) => {
        if (item && item.token) feedbackTokens.set(item.token, item);
      });
    }
  } catch (_) {}
}

function saveFeedbackTokens() {
  try {
    const arr = Array.from(feedbackTokens.values());
    fs.writeFileSync(FEEDBACK_TOKENS_FILE, JSON.stringify(arr, null, 2), "utf8");
  } catch (e) {
    console.error("saveFeedbackTokens error:", e.message);
  }
}

function wasFeedbackSent(phone) {
  return feedbackSent.has(phone);
}

function markFeedbackSent(phone, fullName) {
  feedbackSent.set(phone, { sentAt: Date.now(), fullName: String(fullName || "") });
  saveFeedbackSent();
}

function createFeedbackToken(phone, fullName) {
  const token = crypto.randomBytes(6).toString("hex"); // 12 hex — короткая ссылка
  const data = {
    token,
    phone,
    fullName: String(fullName || ""),
    createdAt: Date.now()
  };
  feedbackTokens.set(token, data);
  saveFeedbackTokens();
  return token;
}

function getFeedbackToken(token) {
  if (!token || typeof token !== "string") return null;
  return feedbackTokens.get(token) || null;
}

loadFeedbackSent();
loadFeedbackTokens();

// ──────────────────────────────────────────────────────────
// Статистика ЛК: уникальные авторизации по номеру телефона.
// Каждый номер учитывается ровно один раз (первая авторизация). Ежедневно
// в 00:00 МСК пересобираем PDF и кладём в папку «Статистика ЛК VOYO» на
// Я.Диске, удаляя предыдущие версии .pdf.
// ──────────────────────────────────────────────────────────

const LK_STATS_DISK_FOLDER = "Статистика ЛК VOYO";
const LK_STATS_START_DATE = "21.05.2026"; // отсчёт «с какой даты»
const LK_AUTH_PHONES_FILE = path.join(__dirname, ".lkAuthPhones.json");
const lkAuthPhones = new Map(); // phone(7XXXXXXXXXX) -> firstAuthAt(ms)

function loadLkAuthPhones() {
  try {
    const raw = fs.readFileSync(LK_AUTH_PHONES_FILE, "utf8");
    const obj = JSON.parse(raw);
    if (obj && typeof obj === "object") {
      Object.entries(obj).forEach(([phone, ts]) => {
        lkAuthPhones.set(phone, Number(ts) || Date.now());
      });
    }
  } catch (_) {}
}

function saveLkAuthPhones() {
  try {
    const obj = Object.fromEntries(lkAuthPhones.entries());
    fs.writeFileSync(LK_AUTH_PHONES_FILE, JSON.stringify(obj, null, 2), "utf8");
  } catch (e) {
    console.error("saveLkAuthPhones error:", e.message);
  }
}

function recordLkAuth(phone) {
  const norm = normalizePhone(phone || "");
  if (!norm) return;
  if (lkAuthPhones.has(norm)) return; // уже учтён
  lkAuthPhones.set(norm, Date.now());
  saveLkAuthPhones();
  console.log(`LK STATS: new unique auth phone=${norm} totalNow=${lkAuthPhones.size}`);
}

loadLkAuthPhones();

// ── PDF + Я.Диск ──
function nowMskDateString() {
  const mskNow = new Date(Date.now() + 3 * 3600 * 1000);
  const y = mskNow.getUTCFullYear();
  const m = String(mskNow.getUTCMonth() + 1).padStart(2, "0");
  const d = String(mskNow.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function formatPhoneForDisplay(norm) {
  if (!norm || norm.length !== 11) return `+${norm}`;
  return `+${norm[0]} (${norm.slice(1, 4)}) ${norm.slice(4, 7)}-${norm.slice(7, 9)}-${norm.slice(9, 11)}`;
}

async function generateLkStatsPdfBuffer() {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 40 });
    const chunks = [];
    doc.on("data", (c) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const fontPath = getPdfFontPath();
    if (fontPath) doc.font(fontPath);

    doc.fontSize(18).fillColor("#161d45").text("Статистика ЛК VOYO", { align: "left" });
    doc.moveDown(0.4);

    const total = lkAuthPhones.size;
    doc.fillColor("#1d2330").fontSize(13).text(`Количество уникальных авторизаций с ${LK_STATS_START_DATE}: ${total}`);
    doc.moveDown(0.2);
    doc.fontSize(10).fillColor("#737988").text(`Дата обновления: ${nowMskDateString()} (МСК)`);
    doc.fillColor("#1d2330");
    doc.moveDown(0.8);

    // Список номеров — сортируем по дате первой авторизации (свежие сверху).
    const entries = Array.from(lkAuthPhones.entries()).sort((a, b) => b[1] - a[1]);
    if (!entries.length) {
      doc.fontSize(11).fillColor("#737988").text("Авторизаций пока нет.");
    } else {
      doc.fontSize(12).text("Список номеров (повторные не учитываются):");
      doc.moveDown(0.4);
      doc.fontSize(11);
      entries.forEach(([phone], idx) => {
        doc.text(`${idx + 1}. ${formatPhoneForDisplay(phone)}`);
      });
    }

    doc.end();
  });
}

async function uploadLkStatsPdfAndCleanup() {
  if (!YANDEX_DISK_TOKEN) {
    console.log("LK STATS: YANDEX_DISK_TOKEN не задан, пропускаем выгрузку.");
    return;
  }
  try {
    await ensureNestedYandexFolder(LK_STATS_DISK_FOLDER);
    const dateStr = nowMskDateString();
    const fileName = `Статистика на ${dateStr}.pdf`;
    const diskPath = `${LK_STATS_DISK_FOLDER}/${fileName}`;

    // Сначала удаляем все старые PDF в папке (кроме одноимённого — overwrite сам разберётся),
    // потом грузим новый.
    try {
      const existing = await listYandexFolderFiles(LK_STATS_DISK_FOLDER);
      for (const name of existing) {
        if (!/\.pdf$/i.test(name)) continue;
        if (name === fileName) continue;
        await deleteYandexResourceIfExists(`${LK_STATS_DISK_FOLDER}/${name}`);
      }
    } catch (e) {
      console.error("LK STATS cleanup old PDFs error:", e.message);
    }

    const pdfBuffer = await generateLkStatsPdfBuffer();
    await uploadBufferToYandexDisk(pdfBuffer, diskPath, "application/pdf");
    console.log(`LK STATS: uploaded ${diskPath} (total=${lkAuthPhones.size})`);
  } catch (e) {
    console.error("uploadLkStatsPdfAndCleanup error:", e.response?.data || e.message);
  }
}

// ── Расписание: ежедневно в 00:00 МСК ──
function msUntilNextMoscowMidnight() {
  const now = Date.now();
  const mskOffsetMs = 3 * 3600 * 1000;
  const mskNow = new Date(now + mskOffsetMs);
  const nextMskMidnightAsUtcEpoch = Date.UTC(
    mskNow.getUTCFullYear(),
    mskNow.getUTCMonth(),
    mskNow.getUTCDate() + 1,
    0, 0, 0, 0
  );
  const target = nextMskMidnightAsUtcEpoch - mskOffsetMs;
  return target - now;
}

function scheduleLkStatsJob() {
  const delay = msUntilNextMoscowMidnight();
  console.log(`LK STATS: next run in ${Math.round(delay / 1000 / 60)} min (${new Date(Date.now() + delay).toISOString()} UTC)`);
  setTimeout(async () => {
    try { await uploadLkStatsPdfAndCleanup(); } catch (_) {}
    scheduleLkStatsJob();
  }, delay).unref?.();
}

// Один раз при старте — чтобы файл существовал сразу, не дожидаясь полуночи.
// Через 30 секунд после старта (чтобы не блокировать прогрев процесса).
setTimeout(() => {
  uploadLkStatsPdfAndCleanup().catch(() => {});
}, 30 * 1000).unref?.();
scheduleLkStatsJob();

// ──────────────────────────────────────────────────────────
// Legacy-owner для существующих данных в phone-scoped папках Я.Диска
// (до 2026-05-21 файлы лежали в <phone>/..., без leadId-партиции).
// Чтобы сохранить совместимость со старыми клиентами и не показывать их
// данные в новых сделках, определяем «владельца» legacy-данных = САМАЯ
// ПЕРВАЯ сделка клиента в amoCRM (по created_at). Эта связка кешируется.
// ──────────────────────────────────────────────────────────
const LEGACY_OWNERS_FILE = path.join(__dirname, ".legacyOwners.json");
const legacyOwnersCache = new Map(); // phone -> { leadId: string|null, computedAt: number }

function loadLegacyOwners() {
  try {
    const raw = fs.readFileSync(LEGACY_OWNERS_FILE, "utf8");
    const obj = JSON.parse(raw);
    if (obj && typeof obj === "object") {
      Object.entries(obj).forEach(([phone, data]) => {
        if (data) legacyOwnersCache.set(phone, data);
      });
    }
  } catch (_) {}
}

function saveLegacyOwners() {
  try {
    const obj = Object.fromEntries(legacyOwnersCache.entries());
    fs.writeFileSync(LEGACY_OWNERS_FILE, JSON.stringify(obj, null, 2), "utf8");
  } catch (e) {
    console.error("saveLegacyOwners error:", e.message);
  }
}

loadLegacyOwners();

// Определяет «владельца» legacy-данных для phone:
// - если в <phone>/TECH FOLDER или <phone>/Опросники/Технические файлы лежат
//   Опросник*.json — берём самую первую сделку клиента из amoCRM (oldest by created_at)
//   и кешируем результат;
// - если legacy-данных нет — кешируем null (новый клиент, всё лежит lead-scoped с самого начала).
// На вход — номер уже в формате 7XXXXXXXXXX (normalizePhone).
async function getLegacyOwnerLeadId(phone) {
  if (!phone) return null;
  const cached = legacyOwnersCache.get(phone);
  if (cached) return cached.leadId ? String(cached.leadId) : null;

  let leadId = null;
  try {
    // Проверяем, есть ли вообще legacy-tech-данные
    const legacy1 = await listYandexFolderFiles(`${YANDEX_DISK_ROOT}/${phone}/${TECH_FOLDER_NAME}`);
    const legacy2 = await listYandexFolderFiles(`${YANDEX_DISK_ROOT}/${phone}/Опросники/Технические файлы`);
    const hasLegacy = [...legacy1, ...legacy2].some((n) => /^Опросник.*\.json$/i.test(n));
    if (hasLegacy) {
      // Определяем владельца — самая ранняя сделка клиента
      const leads = await getLeadsByPhone(phone);
      if (leads && leads.length) {
        const sorted = [...leads].sort((a, b) => (a.created_at || 0) - (b.created_at || 0));
        leadId = String(sorted[0].id);
      }
    }
  } catch (e) {
    console.error("getLegacyOwnerLeadId compute error:", e.message);
  }
  legacyOwnersCache.set(phone, { leadId, computedAt: Date.now() });
  saveLegacyOwners();
  return leadId;
}

// Проверяет, что у клиента ВСЕ заявители в рамках КОНКРЕТНОЙ сделки имеют хотя бы
// один загруженный документ в своей папке ФИО на Я.Диске.
// PDF опросника («Опросник - <ФИО>.pdf») не считается «документом» — это автогенерация.
// Возвращает true только если у каждого заявителя из TECH FOLDER этой сделки есть
// хотя бы 1 «реально загруженный» файл.
async function hasUploadedDocsForAllApplicants(phone, leadId) {
  if (!phone || !YANDEX_DISK_TOKEN || !leadId) return false;
  try {
    const techFiles = await listAllTechFiles(phone, leadId);
    const indices = new Set();
    techFiles.forEach((n) => {
      const m = /^Опросник(?:\s+(\d+))?\.json$/i.exec(n);
      if (m) indices.add(parseInt(m[1] || "1", 10));
    });
    if (!indices.size) return false;

    const ownerId = await getLegacyOwnerLeadId(phone);
    const isLegacyOwner = ownerId && String(ownerId) === String(leadId);
    const phoneRoot = `${YANDEX_DISK_ROOT}/${phone}`;
    const leadRoot = leadScopedFolder(phone, leadId);

    for (const idx of indices) {
      const data = await loadApplicantJson(phone, leadId, idx);
      if (!data || !data.fullName) return false;
      const safeFio = sanitizeFileName(String(data.fullName).trim());
      if (!safeFio) return false;

      // Сначала смотрим lead-scoped папку заявителя.
      let files = await listYandexFolderFiles(`${leadRoot}/${safeFio}`);

      // Если пусто И этот лид — legacy owner — пробуем legacy-папку заявителя.
      if ((!files || !files.length) && isLegacyOwner) {
        files = await listYandexFolderFiles(`${phoneRoot}/${safeFio}`);
      }

      const hasRealDoc = (files || []).some((name) => !/^Опросник\s+-\s+.*\.pdf$/i.test(name));
      if (!hasRealDoc) return false;
    }
    return true;
  } catch (e) {
    console.error("hasUploadedDocsForAllApplicants error:", e && e.message);
    return false;
  }
}

// Проверяет триггер «у клиента есть сделка в "Подготовка документов" + опросник
// заполнен + документы загружены для всех заявителей этой сделки».
// Проверка идёт ПО КАЖДОЙ сделке отдельно (lead-scoped), а лимит «1 SMS на номер
// за всё время» — общий по phone. Если несколько сделок одновременно подходят,
// триггерит первая, для которой условия выполнены целиком.
async function maybeSendFeedbackSms(phone, leads) {
  try {
    const normPhone = normalizePhone(phone || "");
    if (!normPhone) return;
    if (wasFeedbackSent(normPhone)) return;
    if (!Array.isArray(leads) || !leads.length) return;

    // Условие #3 — кандидаты: сделки в «Подготовка документов».
    const candidates = leads.filter((l) => l && l.cabinet_status === "Подготовка документов");
    if (!candidates.length) return;

    // Ищем первого кандидата, у которого выполнены условия #1 и #2.
    let triggeredFullName = "";
    let triggeredLeadId = "";
    for (const lead of candidates) {
      const leadId = String(lead.id);
      // Условие #1 — для ЭТОЙ сделки должен быть хотя бы один заполненный опросник.
      const techFiles = await listAllTechFiles(normPhone, leadId);
      const hasAnyJson = techFiles.some((n) => /^Опросник.*\.json$/i.test(n));
      if (!hasAnyJson) continue;
      // Условие #2 — для ЭТОЙ сделки документы должны быть загружены у каждого заявителя.
      const allDocs = await hasUploadedDocsForAllApplicants(normPhone, leadId);
      if (!allDocs) continue;
      // Подходит — берём ФИО первого заявителя для PDF и имени файла.
      const firstQ = await loadApplicantJson(normPhone, leadId, 1);
      triggeredFullName = (firstQ && firstQ.fullName) ? String(firstQ.fullName).trim() : "";
      triggeredLeadId = leadId;
      break;
    }

    if (!triggeredLeadId) {
      console.log(`FEEDBACK skip: phone=${normPhone} — нет сделки, удовлетворяющей всем условиям`);
      return;
    }

    // Помечаем ДО SMS, чтобы при параллельных запросах /api/leads не отправилось дважды.
    markFeedbackSent(normPhone, triggeredFullName);
    const fullName = triggeredFullName;

    const token = createFeedbackToken(normPhone, fullName);
    const link = `https://voyovoyo.ru/feedback?t=${token}`;
    console.log(`FEEDBACK SMS: phone=${normPhone} token=${token} link=${link}`);

    const result = await sms.sendFeedbackLink(normPhone, link);
    if (!result || !result.ok) {
      console.error("FEEDBACK SMS send failed:", result && result.error);
      // Не откатываем флаг: лучше «возможный пропуск» чем риск спама при ретраях.
    }
  } catch (e) {
    console.error("maybeSendFeedbackSms error:", e && e.message);
  }
}

function buildFeedbackHtml(token, fullName) {
  const safeToken = escapeHtml(token);
  const prettyName = formatFioTitleCase(fullName);
  const safeName = escapeHtml(prettyName);
  const q3OptionsHtml = FEEDBACK_Q3_OPTIONS.map((opt) => {
    const safeOpt = escapeHtml(opt);
    return `
            <label class="checkbox-row">
              <input type="checkbox" name="q3" value="${safeOpt}" />
              <span>${safeOpt}</span>
            </label>`;
  }).join("");
  return `<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta name="robots" content="noindex,nofollow" />
  <title>Обратная связь — VOYO</title>
  <link rel="icon" href="/favicon.ico" />
  <style>
    :root { --vsc-ease: cubic-bezier(0.4, 0, 0.2, 1); }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif;
      background: #f3f2f7;
      color: #1d2330;
      padding: 24px 16px 48px;
      min-height: 100vh;
    }
    .brand-bar { max-width: 760px; margin: 8px auto 0; padding: 0 12px; display: flex; justify-content: center; }
    .brand-bar img {
      width: 160px; height: auto; aspect-ratio: 2 / 1; mix-blend-mode: multiply;
      opacity: 0; transform: scale(0.96);
      transition: opacity 0.55s var(--vsc-ease), transform 0.55s var(--vsc-ease);
    }
    .brand-bar img.is-loaded { opacity: 1; transform: scale(1); }
    .wrap {
      max-width: 760px;
      margin: 20px auto 0;
      background: #fff;
      border: 1px solid #ece7f2;
      border-radius: 24px;
      padding: 24px;
      box-shadow: 0 10px 30px rgba(34, 36, 52, 0.05);
    }
    h1 { margin: 0 0 8px; font-size: 24px; line-height: 1.2; color: #171c29; }
    .subtitle { margin: 0 0 22px; font-size: 14px; color: #737988; line-height: 1.5; }
    form { display: grid; gap: 18px; }
    .field { display: grid; gap: 8px; }
    .field > label { font-size: 14px; font-weight: 600; color: #3a4150; }
    .q-text { font-size: 16px; color: #1d2330; line-height: 1.45; margin: 0 0 4px; font-weight: 500; }
    .radio-group { display: grid; gap: 8px; }
    .radio-row {
      display: flex; align-items: center; gap: 10px;
      padding: 12px 14px;
      border: 1px solid #e8e2ee;
      border-radius: 14px;
      cursor: pointer;
      font-size: 15px;
      background: #fff;
      transition: border-color 0.2s var(--vsc-ease), background 0.2s var(--vsc-ease);
    }
    .radio-row:hover { background: #faf9fc; }
    .radio-row input[type="radio"] { width: 18px; height: 18px; accent-color: #3589BD; margin: 0; }
    .radio-row.is-checked { border-color: #3589BD; background: #f0f7fc; }
    .checkbox-row {
      display: flex; align-items: flex-start; gap: 10px;
      padding: 12px 14px;
      border: 1px solid #e8e2ee;
      border-radius: 14px;
      cursor: pointer;
      font-size: 15px;
      background: #fff;
      line-height: 1.4;
      transition: border-color 0.2s var(--vsc-ease), background 0.2s var(--vsc-ease);
    }
    .checkbox-row:hover { background: #faf9fc; }
    .checkbox-row input[type="checkbox"] {
      width: 18px; height: 18px; accent-color: #3589BD; margin: 1px 0 0; flex-shrink: 0;
    }
    .checkbox-row.is-checked { border-color: #3589BD; background: #f0f7fc; }
    textarea {
      width: 100%; min-height: 120px;
      border: 1px solid #e8e2ee;
      border-radius: 14px;
      padding: 12px 14px;
      font-size: 15px;
      font-family: inherit;
      color: #1f2532;
      resize: vertical;
      outline: none;
      transition: border-color 0.2s var(--vsc-ease);
    }
    textarea:focus { border-color: #3589BD; }
    .step-block { display: none; }
    .step-block.show { display: grid; gap: 8px; }
    .submit-btn {
      height: 50px;
      border: 0;
      border-radius: 14px;
      background: #3589BD;
      color: #fff;
      font-size: 16px;
      font-weight: 600;
      cursor: pointer;
      transition: filter 0.2s var(--vsc-ease);
      font-family: inherit;
    }
    .submit-btn:hover { filter: brightness(0.95); }
    .submit-btn:disabled { opacity: 0.6; cursor: progress; }
    .error-msg {
      color: #c4314b;
      font-size: 14px;
      padding: 10px 12px;
      background: #fbebee;
      border: 1px solid #d97a8a;
      border-radius: 12px;
      display: none;
    }
    .error-msg.show { display: block; }
    .success-screen {
      display: none;
      text-align: center;
      padding: 16px 8px 8px;
    }
    .success-screen.show { display: block; }
    .success-screen .check {
      width: 64px; height: 64px; margin: 0 auto 16px;
      border-radius: 50%;
      background: #e6f4eb;
      display: flex; align-items: center; justify-content: center;
      color: #1f7a3f;
      font-size: 32px;
    }
    .success-screen h2 {
      margin: 0;
      font-size: 22px;
      color: #1d2330;
    }
  </style>
</head>
<body>
  <div class="brand-bar">
    <img src="/logo.png" alt="VOYO" width="600" height="300" onload="this.classList.add('is-loaded')" onerror="this.classList.add('is-loaded')" />
  </div>
  <div class="wrap">
    <div id="formBlock">
      <h1>Обратная связь</h1>
      <p class="subtitle">${safeName ? `${safeName}, н` : "Н"}ам важно ваше мнение о работе личного кабинета VOYO. Ответы займут меньше минуты.</p>

      <form id="fbForm">
        <div class="field">
          <p class="q-text">Оказался ли процесс заполнения опросника, сбора и предоставления документов для оформления визы через личный кабинет VOYO для вас удобным?</p>
          <div class="radio-group">
            <label class="radio-row">
              <input type="radio" name="q1" value="Да" />
              <span>Да</span>
            </label>
            <label class="radio-row">
              <input type="radio" name="q1" value="Нет" />
              <span>Нет</span>
            </label>
          </div>
        </div>

        <div class="field step-block" id="stepYes">
          <label for="qYes" class="q-text">Скажите, что вы порекомендовали бы нам улучшить в личном кабинете VOYO?</label>
          <textarea id="qYes" name="qYes" placeholder="Поле необязательное. Можно оставить пустым."></textarea>
        </div>

        <div class="field step-block" id="stepQ3">
          <p class="q-text">Что ещё вы хотели бы видеть в личном кабинете VOYO? <span style="color:#c4314b;">*</span></p>
          <div class="radio-group">${q3OptionsHtml}
          </div>
        </div>

        <div class="field step-block" id="stepNo">
          <label for="qNo" class="q-text">Что было не так?</label>
          <textarea id="qNo" name="qNo" placeholder="Поле необязательное. Можно оставить пустым."></textarea>
        </div>

        <div id="errorBox" class="error-msg"></div>

        <button type="submit" class="submit-btn" id="submitBtn" disabled>Отправить ответы</button>
      </form>
    </div>

    <div id="successBlock" class="success-screen">
      <div class="check">✓</div>
      <h2>Спасибо за вашу обратную связь!</h2>
    </div>
  </div>

  <script>
    (function() {
      const TOKEN = ${JSON.stringify(safeToken)};
      const form = document.getElementById("fbForm");
      const formBlock = document.getElementById("formBlock");
      const successBlock = document.getElementById("successBlock");
      const stepYes = document.getElementById("stepYes");
      const stepQ3  = document.getElementById("stepQ3");
      const stepNo  = document.getElementById("stepNo");
      const submitBtn = document.getElementById("submitBtn");
      const errorBox = document.getElementById("errorBox");
      const radios = Array.from(form.querySelectorAll('input[name="q1"]'));
      const q3Checks = Array.from(form.querySelectorAll('input[name="q3"]'));

      function syncRadioStyles() {
        radios.forEach((r) => {
          const row = r.closest(".radio-row");
          if (!row) return;
          if (r.checked) row.classList.add("is-checked");
          else row.classList.remove("is-checked");
        });
      }

      function syncCheckboxStyles() {
        q3Checks.forEach((c) => {
          const row = c.closest(".checkbox-row");
          if (!row) return;
          if (c.checked) row.classList.add("is-checked");
          else row.classList.remove("is-checked");
        });
      }

      function isYesSelected() {
        const r = radios.find((x) => x.checked);
        return r && r.value === "Да";
      }

      function anyQ3Checked() {
        return q3Checks.some((c) => c.checked);
      }

      function refreshSubmitState() {
        const r = radios.find((x) => x.checked);
        if (!r) { submitBtn.disabled = true; return; }
        if (r.value === "Да") {
          submitBtn.disabled = !anyQ3Checked();
        } else {
          submitBtn.disabled = false;
        }
      }

      radios.forEach((r) => {
        r.addEventListener("change", () => {
          syncRadioStyles();
          if (r.value === "Да" && r.checked) {
            stepYes.classList.add("show");
            stepQ3.classList.add("show");
            stepNo.classList.remove("show");
          } else if (r.value === "Нет" && r.checked) {
            stepNo.classList.add("show");
            stepYes.classList.remove("show");
            stepQ3.classList.remove("show");
          }
          refreshSubmitState();
        });
      });

      q3Checks.forEach((c) => {
        c.addEventListener("change", () => {
          syncCheckboxStyles();
          refreshSubmitState();
        });
      });

      function showError(msg) {
        errorBox.textContent = msg;
        errorBox.classList.add("show");
      }
      function hideError() {
        errorBox.classList.remove("show");
      }

      form.addEventListener("submit", async (e) => {
        e.preventDefault();
        hideError();
        const q1 = radios.find((r) => r.checked);
        if (!q1) {
          showError("Пожалуйста, выберите ответ на первый вопрос.");
          return;
        }
        const q2 = q1.value === "Да"
          ? (document.getElementById("qYes").value || "").trim()
          : (document.getElementById("qNo").value || "").trim();
        let q3 = [];
        if (q1.value === "Да") {
          q3 = q3Checks.filter((c) => c.checked).map((c) => c.value);
          if (!q3.length) {
            showError("Выберите минимум один пункт в последнем вопросе.");
            return;
          }
        }
        submitBtn.disabled = true;
        submitBtn.textContent = "Отправляем...";
        try {
          const r = await fetch("/api/feedback", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ token: TOKEN, q1: q1.value, q2, q3 })
          });
          const data = await r.json().catch(() => ({}));
          if (!r.ok || !data.success) {
            showError(data.message || "Не удалось отправить. Попробуйте позже.");
            submitBtn.disabled = false;
            submitBtn.textContent = "Отправить ответы";
            return;
          }
          formBlock.style.display = "none";
          successBlock.classList.add("show");
        } catch (err) {
          showError("Сетевая ошибка. Проверьте интернет и попробуйте снова.");
          submitBtn.disabled = false;
          submitBtn.textContent = "Отправить ответы";
        }
      });
    })();
  </script>
</body>
</html>`;
}

async function generateFeedbackPdfBuffer({ fullName, phone, q1, q2, q3 }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 50 });
    const chunks = [];
    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const fontPath = getPdfFontPath();
    if (fontPath) doc.font(fontPath);

    doc.fontSize(18).text("Обратная связь — личный кабинет VOYO", { align: "left" });
    doc.moveDown(0.5);
    doc.fontSize(11).text(`Клиент: ${fullName || "—"}`);
    doc.text(`Телефон: ${phone || "—"}`);
    doc.text(`Дата заполнения: ${new Date().toLocaleString("ru-RU")}`);
    doc.moveDown();

    doc.fontSize(12).text(
      "Вопрос 1. Оказался ли процесс заполнения опросника, сбора и предоставления документов для оформления визы через личный кабинет VOYO для вас удобным?",
      { lineGap: 2 }
    );
    doc.moveDown(0.3);
    doc.fontSize(13).fillColor(q1 === "Да" ? "#1f7a3f" : "#c4314b").text(`Ответ: ${q1 || "—"}`);
    doc.fillColor("#000");
    doc.moveDown();

    if (q1 === "Да") {
      doc.fontSize(12).text("Вопрос 2. Скажите, что вы порекомендовали бы нам улучшить в личном кабинете VOYO?", { lineGap: 2 });
    } else if (q1 === "Нет") {
      doc.fontSize(12).text("Вопрос 2. Что было не так?", { lineGap: 2 });
    } else {
      doc.fontSize(12).text("Вопрос 2.", { lineGap: 2 });
    }
    doc.moveDown(0.3);
    doc.fontSize(12).text(`Ответ: ${q2 && q2.trim() ? q2.trim() : "(пусто, клиент не заполнил)"}`);

    // Вопрос 3 — только если ответ на Q1 «Да».
    if (q1 === "Да") {
      doc.moveDown();
      doc.fontSize(12).text("Вопрос 3. Что ещё вы хотели бы видеть в личном кабинете VOYO?", { lineGap: 2 });
      doc.moveDown(0.3);
      const selected = Array.isArray(q3) ? q3 : [];
      if (selected.length) {
        selected.forEach((opt) => {
          doc.fontSize(12).text(`• ${opt}`, { lineGap: 1, indent: 6 });
        });
      } else {
        doc.fontSize(12).text("(пусто)");
      }
    }

    doc.end();
  });
}

// Возвращает безопасное имя файла для PDF: «<ФИО>.pdf», при коллизиях — «<ФИО> (2).pdf» и т.д.
async function pickFeedbackPdfName(safeFio) {
  const base = safeFio || "Без имени";
  const existing = await listYandexFolderFiles(FEEDBACK_DISK_FOLDER);
  const baseFile = `${base}.pdf`;
  if (!existing.includes(baseFile)) return baseFile;
  for (let i = 2; i < 100; i++) {
    const candidate = `${base} (${i}).pdf`;
    if (!existing.includes(candidate)) return candidate;
  }
  // Краевой случай — добавим timestamp
  return `${base} - ${new Date().toISOString().replace(/[:T]/g, "-").slice(0, 19)}.pdf`;
}

app.get("/feedback", (req, res) => {
  const token = String((req.query && req.query.t) || "").trim();
  const data = getFeedbackToken(token);
  if (!data) {
    res.status(404).send(
      `<!DOCTYPE html><html lang="ru"><head><meta charset="UTF-8" /><title>Ссылка не найдена</title>` +
      `<style>body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;background:#f3f2f7;color:#1d2330;padding:48px 24px;text-align:center;}` +
      `.box{max-width:560px;margin:0 auto;background:#fff;border:1px solid #ece7f2;border-radius:24px;padding:32px;}h1{margin:0 0 8px;font-size:22px;}</style></head>` +
      `<body><div class="box"><h1>Ссылка не найдена</h1><p>Возможно, опрос уже был заполнен или ссылка устарела.</p></div></body></html>`
    );
    return;
  }
  res.send(buildFeedbackHtml(data.token, data.fullName));
});

app.post("/api/feedback", async (req, res) => {
  try {
    const token = String((req.body && req.body.token) || "").trim();
    const q1 = String((req.body && req.body.q1) || "").trim();
    const q2 = String((req.body && req.body.q2) || "").trim();
    const q3Raw = (req.body && req.body.q3) || [];
    // Принимаем только значения из строго заданного списка (FEEDBACK_Q3_OPTIONS) —
    // отсекаем любые посторонние варианты, которые могли прийти при подделке запроса.
    const q3 = (Array.isArray(q3Raw) ? q3Raw : [])
      .map((v) => String(v || "").trim())
      .filter((v) => FEEDBACK_Q3_OPTIONS.includes(v));

    const data = getFeedbackToken(token);
    if (!data) {
      return res.status(404).json({ success: false, message: "Ссылка устарела или уже использована" });
    }
    if (q1 !== "Да" && q1 !== "Нет") {
      return res.status(400).json({ success: false, message: "Выберите ответ на первый вопрос" });
    }
    // Если ответили «Да» — на 3-м вопросе должен быть выбран хотя бы 1 пункт.
    if (q1 === "Да" && q3.length === 0) {
      return res.status(400).json({
        success: false,
        message: "Выберите минимум один пункт в последнем вопросе"
      });
    }

    // ФИО в Title Case (как в ЛК) — попадает и в PDF, и в имя файла.
    const fullName = formatFioTitleCase(data.fullName) || "Клиент VOYO";
    const phone = data.phone || "";

    // 1. PDF
    const pdfBuffer = await generateFeedbackPdfBuffer({ fullName, phone, q1, q2, q3 });

    // 2. Папка на Я.Диске
    await ensureNestedYandexFolder(FEEDBACK_DISK_FOLDER);

    // 3. Имя файла с защитой от коллизий
    const safeFio = sanitizeFileName(fullName) || "Без имени";
    const fileName = await pickFeedbackPdfName(safeFio);
    const diskPath = `${FEEDBACK_DISK_FOLDER}/${fileName}`;

    await uploadBufferToYandexDisk(pdfBuffer, diskPath, "application/pdf");
    console.log(`FEEDBACK PDF saved: ${diskPath}`);

    // 4. Удаляем токен — повторно использовать нельзя.
    //    Ссылка из SMS сразу перестаёт работать (GET /feedback вернёт 404).
    feedbackTokens.delete(token);
    saveFeedbackTokens();

    return res.json({ success: true });
  } catch (e) {
    console.error("POST /api/feedback error:", e.response?.data || e.message);
    return res.status(500).json({ success: false, message: "Ошибка сохранения. Попробуйте позже." });
  }
});

// ──────────────────────────────────────────────────────────
// WebAuthn — вход по биометрии (Face ID / Touch ID / Windows Hello)
// ──────────────────────────────────────────────────────────
const webauthn = require("@simplewebauthn/server");

const WEBAUTHN_RP_NAME = "VOYO";
const WEBAUTHN_RP_ID = process.env.WEBAUTHN_RP_ID || "voyovoyo.ru";
const WEBAUTHN_ORIGIN = process.env.WEBAUTHN_ORIGIN || "https://voyovoyo.ru";

const PASSKEYS_FILE = path.join(__dirname, ".passkeys.json");
const passkeysByPhone = new Map();
const webauthnChallenges = new Map();
const WEBAUTHN_CHALLENGE_TTL_MS = 5 * 60 * 1000;

function loadPasskeys() {
  try {
    const raw = fs.readFileSync(PASSKEYS_FILE, "utf8");
    const obj = JSON.parse(raw);
    if (obj && typeof obj === "object") {
      Object.keys(obj).forEach((phone) => {
        if (Array.isArray(obj[phone])) passkeysByPhone.set(phone, obj[phone]);
      });
    }
  } catch (_) {}
}
function savePasskeys() {
  try {
    const obj = {};
    for (const [phone, arr] of passkeysByPhone.entries()) obj[phone] = arr;
    fs.writeFileSync(PASSKEYS_FILE, JSON.stringify(obj, null, 2), "utf8");
  } catch (e) {
    console.error("savePasskeys error:", e.message);
  }
}
function setWebauthnChallenge(phone, challenge, type) {
  webauthnChallenges.set(phone, { challenge, type, expiresAt: Date.now() + WEBAUTHN_CHALLENGE_TTL_MS });
}
function getWebauthnChallenge(phone, type) {
  const c = webauthnChallenges.get(phone);
  if (!c || c.type !== type) return null;
  if (Date.now() > c.expiresAt) { webauthnChallenges.delete(phone); return null; }
  return c.challenge;
}
function clearWebauthnChallenge(phone) { webauthnChallenges.delete(phone); }

function b64uFromBuffer(buf) { return Buffer.from(buf).toString("base64url"); }
function bufferFromB64u(s) { return Buffer.from(String(s || ""), "base64url"); }

loadPasskeys();

app.post("/api/auth/webauthn/has-credentials", (req, res) => {
  try {
    const phone = sms.normalizePhone((req.body && req.body.phone) || "");
    if (!phone) return res.json({ hasCredentials: false });
    const arr = passkeysByPhone.get(phone) || [];
    return res.json({ hasCredentials: arr.length > 0 });
  } catch (_) {
    return res.json({ hasCredentials: false });
  }
});

app.post("/api/auth/webauthn/register-options", async (req, res) => {
  try {
    const phone = sms.normalizePhone((req.body && req.body.phone) || "");
    if (!phone || phone.length < 11) {
      return res.status(400).json({ success: false, message: "Некорректный номер" });
    }
    const existing = passkeysByPhone.get(phone) || [];
    const options = await webauthn.generateRegistrationOptions({
      rpName: WEBAUTHN_RP_NAME,
      rpID: WEBAUTHN_RP_ID,
      userID: phone,
      userName: phone,
      userDisplayName: "+" + phone,
      attestationType: "none",
      excludeCredentials: existing.map((c) => ({
        id: bufferFromB64u(c.credentialID),
        type: "public-key",
      })),
      authenticatorSelection: {
        residentKey: "preferred",
        userVerification: "preferred",
      },
    });
    setWebauthnChallenge(phone, options.challenge, "register");
    return res.json(options);
  } catch (err) {
    console.error("WEBAUTHN REGISTER OPTIONS:", err.message);
    return res.status(500).json({ success: false, message: err.message });
  }
});

app.post("/api/auth/webauthn/register-verify", async (req, res) => {
  try {
    const phone = sms.normalizePhone((req.body && req.body.phone) || "");
    const attestationResponse = req.body && req.body.attestationResponse;
    if (!phone || !attestationResponse) {
      return res.status(400).json({ success: false, message: "Невалидный запрос" });
    }
    const expectedChallenge = getWebauthnChallenge(phone, "register");
    if (!expectedChallenge) {
      return res.status(400).json({ success: false, message: "Регистрация просрочена" });
    }
    const verification = await webauthn.verifyRegistrationResponse({
      response: attestationResponse,
      expectedChallenge,
      expectedOrigin: WEBAUTHN_ORIGIN,
      expectedRPID: WEBAUTHN_RP_ID,
      requireUserVerification: false,
    });
    if (!verification.verified || !verification.registrationInfo) {
      clearWebauthnChallenge(phone);
      return res.status(400).json({ success: false, message: "Проверка не прошла" });
    }
    const info = verification.registrationInfo;
    const newCredential = {
      credentialID: b64uFromBuffer(info.credentialID),
      publicKey: b64uFromBuffer(info.credentialPublicKey),
      counter: info.counter || 0,
      createdAt: Date.now(),
    };
    const arr = passkeysByPhone.get(phone) || [];
    arr.push(newCredential);
    passkeysByPhone.set(phone, arr);
    savePasskeys();
    clearWebauthnChallenge(phone);
    return res.json({ success: true });
  } catch (err) {
    console.error("WEBAUTHN REGISTER VERIFY:", err.message);
    return res.status(500).json({ success: false, message: err.message });
  }
});

app.post("/api/auth/webauthn/auth-options", async (req, res) => {
  try {
    const phone = sms.normalizePhone((req.body && req.body.phone) || "");
    if (!phone) return res.status(400).json({ success: false, message: "Не передан номер" });
    const arr = passkeysByPhone.get(phone) || [];
    if (arr.length === 0) {
      return res.status(404).json({ success: false, message: "Нет зарегистрированных passkey" });
    }
    const options = await webauthn.generateAuthenticationOptions({
      rpID: WEBAUTHN_RP_ID,
      allowCredentials: arr.map((c) => ({
        id: bufferFromB64u(c.credentialID),
        type: "public-key",
      })),
      userVerification: "preferred",
    });
    setWebauthnChallenge(phone, options.challenge, "auth");
    return res.json(options);
  } catch (err) {
    console.error("WEBAUTHN AUTH OPTIONS:", err.message);
    return res.status(500).json({ success: false, message: err.message });
  }
});

app.post("/api/auth/webauthn/auth-verify", async (req, res) => {
  try {
    const phone = sms.normalizePhone((req.body && req.body.phone) || "");
    const assertionResponse = req.body && req.body.assertionResponse;
    if (!phone || !assertionResponse) {
      return res.status(400).json({ success: false, message: "Невалидный запрос" });
    }
    const expectedChallenge = getWebauthnChallenge(phone, "auth");
    if (!expectedChallenge) {
      return res.status(400).json({ success: false, message: "Сессия просрочена" });
    }
    const arr = passkeysByPhone.get(phone) || [];
    const cred = arr.find((c) => c.credentialID === assertionResponse.id);
    if (!cred) {
      return res.status(404).json({ success: false, message: "Passkey не найден" });
    }
    const verification = await webauthn.verifyAuthenticationResponse({
      response: assertionResponse,
      expectedChallenge,
      expectedOrigin: WEBAUTHN_ORIGIN,
      expectedRPID: WEBAUTHN_RP_ID,
      authenticator: {
        credentialID: bufferFromB64u(cred.credentialID),
        credentialPublicKey: bufferFromB64u(cred.publicKey),
        counter: cred.counter || 0,
      },
      requireUserVerification: false,
    });
    if (!verification.verified) {
      clearWebauthnChallenge(phone);
      return res.status(400).json({ success: false, message: "Подпись не прошла" });
    }
    cred.counter = verification.authenticationInfo.newCounter;
    savePasskeys();
    clearWebauthnChallenge(phone);
    try { recordLkAuth(phone); } catch (_) {}
    return res.json({ success: true, phone });
  } catch (err) {
    console.error("WEBAUTHN AUTH VERIFY:", err.message);
    return res.status(500).json({ success: false, message: err.message });
  }
});

app.get("/questionnaire-start", async (req, res) => {
  try {
    const phone = normalizePhone(req.query.phone || "");
    const leadId = String(req.query.leadId || "").trim();

    if (!phone || !leadId) {
      return res.status(400).send("Не переданы phone или leadId");
    }

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.send(buildQuestionnaireStartHtml({ phone, leadId }));
  } catch (error) {
    console.error("GET /questionnaire-start error:", error.response?.data || error.message);
    return res.status(500).send("Ошибка при открытии опросника");
  }
});

app.get("/questionnaire", async (req, res) => {
  try {
    // Share-режим: ссылка отправлена по SMS, всё контекстное берём из токена
    const shareTokenParam = String(req.query.share || "").trim();
    const shareData = shareTokenParam ? getShareToken(shareTokenParam) : null;
    if (shareTokenParam && !shareData) {
      return res.status(404).send("Ссылка устарела или недействительна. Запросите новую ссылку у заказчика.");
    }

    const phone = shareData
      ? normalizePhone(shareData.phone || "")
      : normalizePhone(req.query.phone || "");
    const leadId = shareData
      ? String(shareData.leadId || "").trim()
      : String(req.query.leadId || "").trim();
    const applicantIndex = shareData
      ? 1
      : Math.max(1, Math.min(10, parseInt(req.query.applicantIndex || "1", 10) || 1));
    const totalApplicants = shareData
      ? 1
      : Math.max(applicantIndex, Math.min(10, parseInt(req.query.totalApplicants || "1", 10) || 1));
    const prevApplicantName = shareData ? "" : String(req.query.prevApplicantName || "").trim();
    const isEdit = shareData ? false : String(req.query.edit || "") === "1";
    const applicantCount = shareData
      ? 0
      : Math.max(0, Math.min(10, parseInt(req.query.applicantCount || "0", 10) || 0));
    const visaType = shareData
      ? String(shareData.visaType || "").trim()
      : String(req.query.visaType || "").trim();

    // Mixed-режим: клиент сам заполняет часть опросников, остальное уходит по SMS
    const isMixed = !shareData && String(req.query.mixed || "") === "1";
    const selfFillCount = isMixed
      ? Math.max(1, Math.min(10, parseInt(req.query.selfFillCount || "0", 10) || 0))
      : 0;
    const selfStep = isMixed
      ? Math.max(1, Math.min(10, parseInt(req.query.selfStep || "1", 10) || 1))
      : 0;

    if (!phone || !leadId) {
      return res.status(400).send("Не переданы phone или leadId");
    }

    // Первый заявитель без applicantCount — перенаправляем на стартовую страницу выбора визы и количества
    if (!shareData && !isEdit && applicantIndex === 1 && !applicantCount) {
      const params = new URLSearchParams({ phone, leadId });
      return res.redirect("/questionnaire-start?" + params.toString());
    }

    if (!AMO_SUBDOMAIN || !AMO_ACCESS_TOKEN) {
      return res.status(500).send("Не настроены переменные amoCRM");
    }

    const baseUrl = `https://${AMO_SUBDOMAIN}.amocrm.ru`;
    const lead = await getLeadById(baseUrl, leadId);

    if (!lead?.id) {
      return res.status(404).send("Сделка не найдена");
    }

    const countryService = getCustomFieldValue(lead, "Страна оформления/услуга") || "не указано";

    let prefill = null;
    let effectiveTotal = totalApplicants;
    if (isEdit && YANDEX_DISK_TOKEN) {
      try {
        prefill = await loadApplicantJson(phone, leadId, applicantIndex);
      } catch (err) {
        console.error("EDIT prefill load error:", err.message);
      }
      // Сохраняем общее количество заявителей из первого опросника
      if (applicantIndex !== 1) {
        try {
          const firstState = await loadApplicantJson(phone, leadId, 1);
          const fromFirst = parseInt(firstState && firstState.totalApplicants, 10);
          if (fromFirst > 0) effectiveTotal = Math.max(applicantIndex, fromFirst);
        } catch (_) {}
      } else if (prefill && prefill.totalApplicants) {
        const fromPrefill = parseInt(prefill.totalApplicants, 10);
        if (fromPrefill > 0) effectiveTotal = fromPrefill;
      }
    }

    // visaType: из URL, либо из сохранённого state (для edit / 2+ заявителя)
    const effectiveVisaType = visaType || (prefill && prefill.visaType) || "";

    // ФИО уже заполненных заявителей В РАМКАХ ЭТОЙ СДЕЛКИ — для блокировки дубликатов на клиенте.
    const existingFios = await getExistingApplicantFios(phone, leadId);

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.send(buildQuestionnaireHtml({
      phone,
      leadId,
      countryService,
      applicantIndex,
      totalApplicants: effectiveTotal,
      prevApplicantName,
      prefill,
      isEdit,
      applicantCount,
      visaType: effectiveVisaType,
      shareToken: shareData ? shareData.token : "",
      isMixed,
      selfFillCount,
      selfStep,
      existingFios
    }));
  } catch (error) {
    console.error("GET /questionnaire error:", error.response?.data || error.message);
    return res.status(500).send("Ошибка при открытии опросника");
  }
});

app.post(
  "/api/questionnaire",
  upload.none(),
  async (req, res) => {
    try {
      const fullName = String(req.body.fullName || "").trim();
      const shareTokenInput = String(req.body.shareToken || "").trim();
      const shareData = shareTokenInput ? getShareToken(shareTokenInput) : null;
      if (shareTokenInput && !shareData) {
        return res.status(400).json({ success: false, message: "Ссылка устарела или недействительна" });
      }
      const isShareMode = !!shareData;

      const phone = isShareMode
        ? normalizePhone(shareData.phone || "")
        : normalizePhone(req.body.phone || "");
      const leadId = isShareMode
        ? String(shareData.leadId || "").trim()
        : String(req.body.leadId || "").trim();

      const isEdit = !isShareMode && String(req.body.isEdit || "") === "1";
      const isMixed = !isShareMode && !isEdit && String(req.body.mixed || "") === "1";
      const selfFillCount = isMixed
        ? Math.max(1, Math.min(10, parseInt(req.body.selfFillCount || "0", 10) || 0))
        : 0;
      const selfStep = isMixed
        ? Math.max(1, Math.min(10, parseInt(req.body.selfStep || "1", 10) || 1))
        : 0;

      // applicantIndex и totalApplicants:
      // - share-режим:   first-free; total = max(idx, applicantCount из токена)
      // - mixed-режим:   first-free; total = max(idx, applicantCount из формы)
      // - обычный режим: как раньше — берётся из формы
      let applicantIndex;
      let totalApplicants;

      const applicantCountRaw = Math.max(1, Math.min(10, parseInt(req.body.applicantCount || "0", 10) || 0));

      if (isShareMode) {
        applicantIndex = await getNextApplicantIndex(phone, leadId);
        totalApplicants = Math.max(applicantIndex, parseInt(shareData.applicantCount, 10) || 1);
      } else if (isMixed) {
        if (!applicantCountRaw) {
          return res.status(400).json({
            success: false,
            message: "Не указано количество заявителей"
          });
        }
        applicantIndex = await getNextApplicantIndex(phone, leadId);
        totalApplicants = Math.max(applicantIndex, applicantCountRaw);
      } else {
        applicantIndex = Math.max(1, Math.min(10, parseInt(req.body.applicantIndex || "1", 10) || 1));
        const incomingTotal = Math.max(1, Math.min(10, parseInt(req.body.totalApplicants || "0", 10) || 0));
        totalApplicants = isEdit
          ? Math.max(applicantIndex, incomingTotal)
          : (applicantIndex === 1
              ? Math.max(1, applicantCountRaw)
              : Math.max(applicantIndex, incomingTotal));

        if (!isEdit && applicantIndex === 1 && !applicantCountRaw) {
          return res.status(400).json({
            success: false,
            message: "Не указано количество заявителей"
          });
        }
      }

      if (!phone || !leadId || !fullName) {
        return res.status(400).json({
          success: false,
          message: "Заполнены не все обязательные поля опросника"
        });
      }

      // Серверная страховка от дубликата ФИО внутри одной сделки (на случай обхода клиентской валидации).
      try {
        const existingFios = await getExistingApplicantFios(phone, leadId);
        const wanted = normalizeFioForCompare(fullName);
        const conflict = existingFios.find((it) => {
          if (!it || !it.fullName) return false;
          if (parseInt(it.idx, 10) === applicantIndex) return false; // своё ФИО в edit-режиме разрешено
          return normalizeFioForCompare(it.fullName) === wanted;
        });
        if (conflict) {
          return res.status(409).json({
            success: false,
            message: "Опросник на это ФИО уже заполнен в этой сделке. Укажите другое ФИО."
          });
        }
      } catch (e) {
        console.error("POST /api/questionnaire fio dup check error:", e.message);
      }

      if (!AMO_SUBDOMAIN || !AMO_ACCESS_TOKEN) {
        return res.status(500).json({
          success: false,
          message: "Не настроены переменные amoCRM"
        });
      }

      if (!YANDEX_DISK_TOKEN) {
        return res.status(500).json({
          success: false,
          message: "Не задан YANDEX_DISK_TOKEN"
        });
      }

      const baseUrl = `https://${AMO_SUBDOMAIN}.amocrm.ru`;
      const lead = await getLeadById(baseUrl, leadId);

      if (!lead?.id) {
        return res.status(404).json({
          success: false,
          message: "Сделка не найдена"
        });
      }

      const countryService = getCustomFieldValue(lead, "Страна оформления/услуга") || "не указано";

      const fields = {
        phone,
        leadId,
        countryService,
        fullName,
        hadPrevSurnames:            String(req.body.hadPrevSurnames || "").trim(),
        prevSurnames:               String(req.body.prevSurnames || "").trim(),
        contactPhone:               String(req.body.contactPhone || "").trim(),
        email:                      String(req.body.email || "").trim(),
        maritalStatus:              String(req.body.maritalStatus || "").trim(),
        hadOtherCitizenshipAtBirth: String(req.body.hadOtherCitizenshipAtBirth || "").trim(),
        birthCitizenship:           String(req.body.birthCitizenship || "").trim(),
        hasSecondCitizenship:       String(req.body.hasSecondCitizenship || "").trim(),
        secondCitizenship:          String(req.body.secondCitizenship || "").trim(),
        hasSecondPassport:          String(req.body.hasSecondPassport || "").trim(),
        whichPassport:              String(req.body.whichPassport || "").trim(),
        canSurrenderPassport:       String(req.body.canSurrenderPassport || "").trim(),
        surrenderReason:            String(req.body.surrenderReason || "").trim(),
        actualAddress:              String(req.body.actualAddress || "").trim(),
        occupation:                 String(req.body.occupation || "").trim(),
        employerName:               String(req.body.employerName || "").trim(),
        employerAddress:            String(req.body.employerAddress || "").trim(),
        employerPhone:              String(req.body.employerPhone || "").trim(),
        tripPurpose:                String(req.body.tripPurpose || "").trim(),
        tripPurposeOther:           String(req.body.tripPurposeOther || "").trim(),
        usaInterviewPoland:         String(req.body.usaInterviewPoland || "").trim(),
        travelCountry:              String(req.body.travelCountry || "").trim(),
        visaCountry:                String(req.body.visaCountry || "").trim(),
        tripDateFrom:               String(req.body.tripDateFrom || "").trim(),
        tripDateTo:                 String(req.body.tripDateTo || "").trim(),
        tripDatesUnknown:           String(req.body.tripDatesUnknown || "").trim(),
        tripDatesAck:               String(req.body.tripDatesAck || "").trim(),
        hasActiveSchengen:          String(req.body.hasActiveSchengen || "").trim(),
        schengenExpiry:             String(req.body.schengenExpiry || "").trim(),
        hadSchengen3Years:          String(req.body.hadSchengen3Years || "").trim(),
        didNotUseVisa:              String(req.body.didNotUseVisa || "").trim(),
        didNotUseReason:            String(req.body.didNotUseReason || "").trim(),
        visaRefused:                String(req.body.visaRefused || "").trim(),
        refusalReason:              String(req.body.refusalReason || "").trim(),
        hasInsurance:               String(req.body.hasInsurance || "").trim(),
        wantBuyInsurance:           String(req.body.wantBuyInsurance || "").trim(),
        isUnder18:                  String(req.body.isUnder18 || "").trim(),
        legalRepresentative:        String(req.body.legalRepresentative || "").trim(),
        hasSponsor:                 String(req.body.hasSponsor || "").trim(),
        sponsorName:                String(req.body.sponsorName || "").trim(),
        visitType:                  String(req.body.visitType || "").trim(),
        pickupMethod:               String(req.body.pickupMethod || "").trim(),
        hasConsularFeeDoc:          String(req.body.hasConsularFeeDoc || "").trim(),
        useBotBooking:              String(req.body.useBotBooking || "").trim(),
        bookingDateFrom:            String(req.body.bookingDateFrom || "").trim(),
        bookingDateTo:              String(req.body.bookingDateTo || "").trim(),
        bookingExclusions:          String(req.body.bookingExclusions || "").trim(),
        bookingCity:                String(req.body.bookingCity || "").trim(),
        bookingTimePrefs:           String(req.body.bookingTimePrefs || "").trim(),
        bookingLoungePrefs:         String(req.body.bookingLoungePrefs || "").trim(),
        howFoundUs:                 String(req.body.howFoundUs || "").trim(),
        notes:                      String(req.body.notes || "").trim(),
        confirmAccuracy:            String(req.body.confirmAccuracy || "").trim(),
        confirmPrevData:            String(req.body.confirmPrevData || "").trim(),
        personalDataConsent:        String(req.body.personalDataConsent || "").trim(),
        visaType:                   String(req.body.visaType || "").trim()
      };

      const enrichedFields = {
        ...fields,
        applicantIndex,
        totalApplicants
      };

      const pdfBuffer = await generateQuestionnairePdfBuffer(enrichedFields);

      const rootFolder = YANDEX_DISK_ROOT;
      const phoneFolder = `${rootFolder}/${phone}`;
      const leadFolder = leadScopedFolder(phone, leadId); // "<phone>/<leadId>"
      const techFolder = techFolderPath(phone, leadId);   // "<phone>/<leadId>/TECH FOLDER"

      const suffix = applicantIndex > 1 ? ` ${applicantIndex}` : "";
      const safeFio = sanitizeFileName(fullName) || `Заявитель ${applicantIndex}`;
      const applicantFolder = `${leadFolder}/${safeFio}`; // "<phone>/<leadId>/<ФИО>"

      await ensureYandexFolder(rootFolder);
      await ensureYandexFolder(phoneFolder);
      await ensureYandexFolder(leadFolder);
      await ensureYandexFolder(techFolder);
      await ensureYandexFolder(applicantFolder);

      // PDF опросника кладём в папку с ФИО клиента (рядом с документами).
      const pdfFileName = `Опросник - ${safeFio}.pdf`;
      await uploadBufferToYandexDisk(
        pdfBuffer,
        `${applicantFolder}/${pdfFileName}`,
        "application/pdf"
      );

      // JSON — служебный, кладётся в TECH FOLDER (используется бэкендом для prefill
      // при «Скорректировать опросник» и для определения уже загруженных файлов).
      const stateJson = JSON.stringify({ ...enrichedFields, savedAt: new Date().toISOString() }, null, 2);
      const jsonFileName = `Опросник${suffix}.json`;
      const jsonBuffer = Buffer.from(stateJson, "utf-8");
      await uploadBufferToYandexDisk(
        jsonBuffer,
        `${techFolder}/${jsonFileName}`,
        "application/json; charset=utf-8"
      );

      // Зеркалирование в папку сделки: PDF — в папку ФИО, JSON — в служебную TECH FOLDER.
      // Задачу при сабмите опросника не создаём — только при загрузке документов.
      if (leadId) {
        mirrorFilesToAmoFolder(leadId, [
          {
            relativePath: `${safeFio}/${pdfFileName}`,
            buffer: pdfBuffer,
            contentType: "application/pdf"
          },
          {
            relativePath: `TECH FOLDER/${jsonFileName}`,
            buffer: jsonBuffer,
            contentType: "application/json; charset=utf-8"
          }
        ]);
        finalizeAmoUpload(leadId, { createTask: false });
      }

      // Share-режим: токен одноразовый — после успешного сохранения удаляем
      if (isShareMode && shareData) {
        shareTokens.delete(shareData.token);
        saveShareTokens();
      }

      let nextApplicantUrl = null;
      if (!isShareMode && !isEdit) {
        if (isMixed) {
          // Mixed: ведём по selfStep до selfFillCount
          if (selfStep < selfFillCount) {
            const params = new URLSearchParams({
              phone,
              leadId,
              applicantCount: String(applicantCountRaw),
              mixed: "1",
              selfFillCount: String(selfFillCount),
              selfStep: String(selfStep + 1),
              prevApplicantName: fullName
            });
            if (fields.visaType) params.set("visaType", fields.visaType);
            nextApplicantUrl = `/questionnaire?${params.toString()}`;
          }
        } else if (applicantIndex < totalApplicants) {
          const params = new URLSearchParams({
            phone,
            leadId,
            applicantIndex: String(applicantIndex + 1),
            totalApplicants: String(totalApplicants),
            prevApplicantName: fullName
          });
          if (fields.visaType) params.set("visaType", fields.visaType);
          nextApplicantUrl = `/questionnaire?${params.toString()}`;
        }
      }

      return res.json({
        success: true,
        message: "Опросник успешно сохранён",
        nextApplicantUrl
      });
    } catch (error) {
      console.error("POST /api/questionnaire error:");
      console.error("message:", error.message);
      console.error("status:", error.response?.status);
      console.error("", error.response?.data);

      return res.status(500).json({
        success: false,
        message: "Ошибка при сохранении опросника",
        error: error.response?.data || error.message
      });
    }
  }
);

app.post("/api/questionnaire/share", async (req, res) => {
  try {
    const phone = normalizePhone(req.body.phone || "");
    const leadId = String(req.body.leadId || "").trim();
    const applicantCount = Math.max(1, Math.min(10, parseInt(req.body.applicantCount || "0", 10) || 0));
    const visaType = String(req.body.visaType || "").trim();
    const recipientPhone = sms.normalizePhone(String(req.body.recipientPhone || ""));

    if (!phone || !leadId) {
      return res.status(400).json({ success: false, message: "Не переданы phone или leadId" });
    }
    if (!recipientPhone || recipientPhone.length < 11) {
      return res.status(400).json({ success: false, message: "Некорректный номер телефона получателя" });
    }
    if (!applicantCount) {
      return res.status(400).json({ success: false, message: "Не указано количество заявителей" });
    }

    const token = createShareToken({ phone, leadId, applicantCount, visaType });
    const origin = `${req.protocol}://${req.get("host")}`;
    const link = `${origin}/questionnaire?share=${token}`;

    const r = await sms.sendQuestionnaireLink(recipientPhone, link);
    if (!r.ok) {
      return res.status(502).json({
        success: false,
        message: r.error || "Не удалось отправить SMS",
        testMode: !!r.testMode
      });
    }

    return res.json({ success: true, testMode: !!r.testMode, recipientPhone });
  } catch (error) {
    console.error("POST /api/questionnaire/share error:", error.message);
    return res.status(500).json({ success: false, message: "Ошибка при отправке SMS" });
  }
});

app.get("/api/questionnaire-state", async (req, res) => {
  try {
    const phone = normalizePhone(req.query.phone || "");
    const leadId = String(req.query.leadId || "").trim();

    if (!phone) {
      return res.status(400).json({ success: false, message: "Не передан phone" });
    }
    if (!leadId) {
      // С 2026-05-21 lead-scoped — leadId обязателен.
      // Без него все сделки бы видели общий стейт и зеркалили чужие документы.
      return res.status(400).json({ success: false, message: "Не передан leadId" });
    }

    if (!YANDEX_DISK_TOKEN) {
      return res.status(500).json({ success: false, message: "Не задан YANDEX_DISK_TOKEN" });
    }

    const loadOne = (n) => loadApplicantJson(phone, leadId, n);

    const first = await loadOne(1);

    if (!first) {
      return res.json({ success: true, applicants: [] });
    }

    // Считаем фактическое количество заявителей по файлам JSON на диске для ЭТОЙ сделки
    // (lead-scoped TECH FOLDER + legacy TECH FOLDER только если этот лид — legacy owner).
    let maxIdxOnDisk = 1;
    try {
      const files = await listAllTechFiles(phone, leadId);
      files.forEach((name) => {
        const m = /^Опросник(?:\s+(\d+))?\.json$/i.exec(name);
        if (m) {
          const idx = parseInt(m[1] || "1", 10);
          if (idx > maxIdxOnDisk) maxIdxOnDisk = idx;
        }
      });
    } catch (_) {}

    const fromFirst = Math.max(1, Math.min(10, parseInt(first.totalApplicants, 10) || 1));
    const total = Math.min(10, Math.max(fromFirst, maxIdxOnDisk));
    const restPromises = [];
    for (let i = 2; i <= total; i++) {
      restPromises.push(loadOne(i));
    }
    const rest = await Promise.all(restPromises);

    const applicants = [{ ...first, applicantIndex: 1 }];
    rest.forEach((s, i) => {
      if (s) applicants.push({ ...s, applicantIndex: i + 2 });
    });

    // Список загруженных файлов в папке заявителя.
    // Если этот лид — legacy owner: мерджим lead-scoped + legacy <phone>/<ФИО>/.
    // Это обеспечивает, что если клиент дозагружает что-то новое в свою «старую» сделку
    // (после деплоя 2026-05-21) — он продолжит видеть и старые файлы, и новые.
    // Для новых сделок (не-owner) — только lead-scoped, legacy не подмешивается.
    const ownerId = await getLegacyOwnerLeadId(phone);
    const isLegacyOwner = ownerId && String(ownerId) === String(leadId);
    await Promise.all(applicants.map(async (a) => {
      const fio = sanitizeFileName(String(a.fullName || "").trim()) || `Заявитель ${a.applicantIndex}`;
      const merged = new Set();
      const leadScopedPath = `${leadScopedFolder(phone, leadId)}/${fio}`;
      const leadFiles = await listYandexFolderFiles(leadScopedPath);
      (leadFiles || []).forEach((n) => merged.add(n));
      if (isLegacyOwner) {
        const legacyFiles = await listYandexFolderFiles(`${YANDEX_DISK_ROOT}/${phone}/${fio}`);
        (legacyFiles || []).forEach((n) => merged.add(n));
      }
      a.uploadedFiles = Array.from(merged);
    }));

    return res.json({ success: true, applicants });
  } catch (error) {
    console.error("GET /api/questionnaire-state error:");
    console.error("message:", error.message);
    console.error("status:", error.response?.status);
    console.error("", error.response?.data);

    return res.status(500).json({
      success: false,
      message: "Ошибка чтения состояния опросника",
      error: error.response?.data || error.message
    });
  }
});

app.post(
  "/upload-extra-document",
  upload.single("file"),
  async (req, res) => {
    try {
      const phone = normalizePhone(req.body.phone || "");
      const file = req.file;
      const leadId = String(req.body.leadId || "").trim();

      if (!phone) return res.status(400).json({ success: false, message: "Телефон не передан" });
      if (!file) return res.status(400).json({ success: false, message: "Файл не передан" });
      if (!leadId) return res.status(400).json({ success: false, message: "leadId не передан" });
      if (!YANDEX_DISK_TOKEN) return res.status(500).json({ success: false, message: "Не задан YANDEX_DISK_TOKEN" });

      // Лимит файлов на обращение (200 на одну сделку).
      const currentCount = await getAmoLeadFileCount(leadId);
      if (currentCount >= LEAD_FILE_LIMIT) {
        return res.status(429).json({
          success: false,
          message: `Превышен лимит файлов для этого обращения (${LEAD_FILE_LIMIT}). Обратитесь к менеджеру или дождитесь нового обращения.`
        });
      }

      const rootFolder = YANDEX_DISK_ROOT;
      const phoneFolder = `${rootFolder}/${phone}`;
      const leadFolder = leadScopedFolder(phone, leadId);
      const extraFolder = `${leadFolder}/Дополнительные документы`;

      await ensureYandexFolder(rootFolder);
      await ensureYandexFolder(phoneFolder);
      await ensureYandexFolder(leadFolder);
      await ensureYandexFolder(extraFolder);

      const origName = sanitizeFileName(file.originalname || "file");
      const dotIndex = origName.lastIndexOf(".");
      const base = dotIndex > 0 ? origName.slice(0, dotIndex) : origName;
      const ext = dotIndex > 0 ? origName.slice(dotIndex) : "";
      const ts = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 19);
      const finalName = `${base} - ${ts}${ext}`;
      const diskPath = `${extraFolder}/${finalName}`;

      await uploadBufferToYandexDisk(file.buffer, diskPath, file.mimetype);

      // Зеркалирование одного файла в папку сделки (фоном, без zip и task).
      // Финализация (zip + task) — отдельный вызов клиента к /api/amo/finish-upload
      // после батча, чтобы получить ровно 1 задачу на нажатие «Загрузить».
      mirrorFilesToAmoFolder(leadId, {
        relativePath: `Дополнительные документы/${finalName}`,
        buffer: file.buffer,
        contentType: file.mimetype
      });
      bumpAmoLeadFileCount(leadId, 1);

      return res.json({ success: true, message: "Файл успешно загружен", fileName: finalName });
    } catch (error) {
      console.error("UPLOAD EXTRA DOC ERROR:");
      console.error("message:", error.message);
      console.error("status:", error.response?.status);
      console.error("", error.response?.data);
      return res.status(500).json({
        success: false,
        message: "Ошибка загрузки документа",
        error: error.response?.data || error.message
      });
    }
  }
);

app.post(
  "/upload-document",
  upload.single("file"),
  async (req, res) => {
    try {
      const phone = normalizePhone(req.body.phone || "");
      const field = String(req.body.field || "").trim();
      const applicantIndex = Math.max(1, Math.min(10, parseInt(req.body.applicantIndex || "1", 10) || 1));
      const file = req.file;
      const leadId = String(req.body.leadId || "").trim();

      console.log("HANDLER /upload-document phone =", phone, "field =", field, "applicantIndex =", applicantIndex, "leadId =", leadId);

      if (!phone) {
        return res.status(400).json({ success: false, message: "Телефон не передан" });
      }
      if (!file) {
        return res.status(400).json({ success: false, message: "Файл не передан" });
      }
      if (!leadId) {
        return res.status(400).json({ success: false, message: "leadId не передан" });
      }

      const targetName = UPLOAD_FIELDS_WHITELIST[field];
      if (!targetName) {
        return res.status(400).json({ success: false, message: "Неизвестный тип документа" });
      }

      if (!YANDEX_DISK_TOKEN) {
        return res.status(500).json({ success: false, message: "Не задан YANDEX_DISK_TOKEN" });
      }

      // Лимит файлов на обращение (200 на одну сделку).
      // Проверяем только для partIndex === 1 (новая загрузка для поля).
      const partIndexForLimit = Math.max(1, parseInt(req.body.partIndex || "1", 10) || 1);
      if (partIndexForLimit === 1) {
        const currentCount = await getAmoLeadFileCount(leadId);
        if (currentCount >= LEAD_FILE_LIMIT) {
          return res.status(429).json({
            success: false,
            message: `Превышен лимит файлов для этого обращения (${LEAD_FILE_LIMIT}). Обратитесь к менеджеру или дождитесь нового обращения.`
          });
        }
      }

      const rootFolder = YANDEX_DISK_ROOT;
      const phoneFolder = `${rootFolder}/${phone}`;
      const leadFolder = leadScopedFolder(phone, leadId); // "<phone>/<leadId>"

      await ensureYandexFolder(rootFolder);
      await ensureYandexFolder(phoneFolder);
      await ensureYandexFolder(leadFolder);

      let applicantState = null;
      try { applicantState = await loadApplicantJson(phone, leadId, applicantIndex); } catch (_) {}

      if (!applicantState) {
        return res.status(409).json({
          success: false,
          message: "Опросник заявителя не найден — заполните опросник перед загрузкой документов"
        });
      }

      const rawFio = String(applicantState.fullName || "").trim();
      const safeFio = sanitizeFileName(rawFio) || `Заявитель ${applicantIndex}`;
      const applicantFolder = `${leadFolder}/${safeFio}`; // "<phone>/<leadId>/<ФИО>"

      await ensureYandexFolder(applicantFolder);

      const originalName = sanitizeFileName(file.originalname || "file");
      const dotIndex = originalName.lastIndexOf(".");
      const ext = dotIndex >= 0 ? originalName.slice(dotIndex) : "";
      // Если для одного поля грузится несколько файлов — добавляем суффикс (2), (3) и т.д.
      const partIndex = Math.max(1, parseInt(req.body.partIndex || "1", 10) || 1);
      const partSuffix = partIndex > 1 ? ` (${partIndex})` : "";
      const finalFileName = `${targetName} - ${safeFio}${partSuffix}${ext}`;
      const diskPath = `${applicantFolder}/${finalFileName}`;

      // При partIndex === 1 (первый файл батча для этого поля) подчищаем все
      // предыдущие версии загрузки в этом поле — любое расширение, любой суффикс « (2)»/« (3)».
      // Это нужно, чтобы при замене JPG на PDF (или наоборот) старая версия не оставалась
      // ни в основной папке клиента, ни в zip-архиве сделки.
      if (partIndex === 1) {
        try {
          const existing = await listYandexFolderFiles(applicantFolder);
          for (const name of existing) {
            if (matchesFieldFile(name, targetName, safeFio)) {
              await deleteYandexResourceIfExists(`${applicantFolder}/${name}`);
            }
          }
        } catch (e) {
          console.error("CLEANUP OLD FIELD FILES (lead folder) error:", e.message);
        }
        // Параллельно подчистим зеркало сделки — встаёт в очередь ПЕРЕД новой mirror-операцией.
        cleanupAmoFieldFilesInMirror(leadId, safeFio, targetName);
        // Cleanup мог удалить файлы из папки сделки — сбрасываем кеш счётчика,
        // следующий запрос пересчитает с Я.Диска.
        invalidateAmoLeadFileCount(leadId);
      }

      console.log("UPLOAD TO YANDEX:", diskPath);
      await uploadBufferToYandexDisk(file.buffer, diskPath, file.mimetype);

      // Зеркалирование одного файла в папку сделки (фоном, без zip и task).
      // Финализация (zip + 1 задача) — отдельный вызов /api/amo/finish-upload
      // после успешного завершения батча, чтобы получить ровно 1 задачу на нажатие «Загрузить».
      mirrorFilesToAmoFolder(leadId, {
        relativePath: `${safeFio}/${finalFileName}`,
        buffer: file.buffer,
        contentType: file.mimetype
      });
      bumpAmoLeadFileCount(leadId, 1);

      return res.json({
        success: true,
        message: "Файл успешно загружен",
        fileName: finalFileName
      });
    } catch (error) {
      console.error("UPLOAD DOCUMENT ERROR:");
      console.error("message:", error.message);
      console.error("status:", error.response?.status);
      console.error("", error.response?.data);

      return res.status(500).json({
        success: false,
        message: "Ошибка загрузки документа",
        error: error.response?.data || error.message
      });
    }
  }
);

// Финализация батча загрузки: один общий пересбор zip + одна задача в amoCRM
// на всё нажатие «Загрузить». Клиент вызывает этот эндпоинт ОДИН раз после
// успешной загрузки всех файлов из батча.
app.post("/api/amo/finish-upload", express.json(), async (req, res) => {
  try {
    const leadId = String((req.body && req.body.leadId) || "").trim();
    const withTask = !!(req.body && req.body.withTask);
    if (!leadId) {
      return res.status(400).json({ success: false, message: "leadId не передан" });
    }
    console.log("FINISH-UPLOAD leadId =", leadId, "withTask =", withTask);
    // Не блокируем ответ клиенту — финализация уйдёт в очередь и выполнится по порядку.
    finalizeAmoUpload(leadId, { createTask: withTask });
    return res.json({ success: true });
  } catch (e) {
    console.error("FINISH-UPLOAD ERROR:", e.response?.data || e.message);
    return res.status(500).json({ success: false, message: "Ошибка финализации" });
  }
});

app.listen(PORT, () => {
  console.log(`Server started on http://localhost:${PORT}`);
});
