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

app.post("/api/auth/request-code", smsGate, async (req, res) => {
  try {
    const phone = sms.normalizePhone((req.body && req.body.phone) || "");
    if (!phone || phone.length < 11) {
      return res.status(400).json({ success: false, message: "Некорректный номер телефона" });
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

// ─── amoCRM↔Я.Диск интеграция: зеркалирование документов в папку сделки + zip ───
// Папки сделок лежат в /amoCRM/Сделки/<lead_id>/ (создаются интеграцией amoCRM↔Я.Диск),
// внутри сделки создаём свою папку «Документы из ЛК».
const AMO_DEALS_ROOT = "amoCRM/Сделки";
const AMO_DOCS_FOLDER_NAME = "Документы из ЛК";
const AMO_DOCS_ZIP_NAME = "Документы из ЛК.zip";
const TASK_RESPONSIBLE_FIELD_ID = 443488;

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
  const zipPath = `${folder}/${AMO_DOCS_ZIP_NAME}`;

  // Удаляем старый архив, чтобы не попал в новый
  await deleteYandexResourceIfExists(zipPath);

  const items = await listYandexFolderRecursive(folder);
  const filtered = items.filter((f) => !f.name.toLowerCase().endsWith(".zip"));
  if (!filtered.length) return;

  const archive = archiver("zip", { zlib: { level: 9 } });
  const chunks = [];
  const done = new Promise((resolve, reject) => {
    archive.on("data", (chunk) => chunks.push(chunk));
    archive.on("end", resolve);
    archive.on("error", reject);
  });

  for (const item of filtered) {
    try {
      const buf = await downloadYandexFileBuffer(item.fullPath);
      archive.append(buf, { name: item.relativePath });
    } catch (e) {
      console.error("ZIP FETCH ERROR:", item.fullPath, e.response?.data || e.message);
    }
  }
  archive.finalize();
  await done;
  const zipBuffer = Buffer.concat(chunks);
  await uploadBufferToYandexDisk(zipBuffer, zipPath, "application/zip");
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

async function createAmoUploadTask(leadId) {
  if (!AMO_ACCESS_TOKEN || !AMO_SUBDOMAIN) return;
  if (!leadId) return;
  try {
    const baseUrl = `https://${AMO_SUBDOMAIN}.amocrm.ru`;
    const lead = await getLeadById(baseUrl, leadId);
    if (!lead) return;
    const respRaw = getEntityCustomFieldValue(lead, TASK_RESPONSIBLE_FIELD_ID);
    const nowSec = Math.floor(Date.now() / 1000);
    const taskBody = [{
      task_type_id: 1,
      text: "Загрузились новые документы от клиента из ЛК.",
      complete_till: nowSec,
      entity_id: Number(leadId),
      entity_type: "leads"
    }];
    const respNum = respRaw != null ? Number(respRaw) : NaN;
    if (Number.isFinite(respNum) && respNum > 0) {
      taskBody[0].responsible_user_id = respNum;
    }
    await amoPost(`${baseUrl}/api/v4/tasks`, taskBody);
  } catch (e) {
    console.error("CREATE AMO TASK ERROR:", e.response?.data || e.message);
  }
}

// Фоновое зеркалирование: один или несколько файлов → папка сделки на Я.Диске,
// затем один пересбор zip, затем (опционально) amoCRM-задача.
// Не блокирует ответ клиенту (fire-and-forget).
function mirrorToAmoFolderInBackground(leadId, files, options = {}) {
  if (!leadId) return;
  const list = Array.isArray(files) ? files : [files];
  if (!list.length) return;
  const { createTask = false } = options;
  setImmediate(async () => {
    for (const f of list) {
      if (!f || !f.relativePath || !f.buffer) continue;
      try {
        await uploadToAmoDealDocs(leadId, f.relativePath, f.buffer, f.contentType || "application/octet-stream");
      } catch (e) {
        console.error("AMO MIRROR ERROR:", f.relativePath, e.response?.data || e.message);
      }
    }
    try {
      await rebuildAmoDocsZip(leadId);
    } catch (e) {
      console.error("AMO ZIP ERROR:", e.response?.data || e.message);
    }
    if (createTask) {
      await createAmoUploadTask(leadId);
    }
  });
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

function buildQuestionnaireHtml({ phone, leadId, countryService, applicantIndex = 1, totalApplicants = 1, prevApplicantName = "", prefill = null, isEdit = false, applicantCount = 0, visaType = "", shareToken = "", isMixed = false, selfFillCount = 0, selfStep = 0 }) {
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

    <!-- 19 -->
    <div class="field">
      <label>Телефон работодателя *</label>
      <input type="tel" name="employerPhone" inputmode="tel" placeholder="+7 (___) ___-__-__" data-phone-mask required />
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
      <div class="date-row">
        <input type="date" name="tripDateFrom" required />
        <input type="date" name="tripDateTo" required />
      </div>
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
  }

  form.addEventListener("change", updateConditionals);
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

    // Проверка обязательных дат — подсвечиваем и не отправляем
    const badDate = validateRequiredFields();
    if (badDate) {
      showBox(errorBox, "Заполните даты поездки — оба поля обязательны.");
      if (badDate.scrollIntoView) badDate.scrollIntoView({ behavior: "smooth", block: "center" });
      try { badDate.focus({ preventScroll: true }); } catch (_) { badDate.focus(); }
      return;
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
    const doc = new PDFDocument({ size: "A4", margin: 50 });

    const chunks = [];
    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const fontPath = getPdfFontPath();
    if (fontPath) doc.font(fontPath);

    const line = (label, value) => {
      if (!value) return;
      doc.fontSize(11).text(`${label}: ${value}`);
    };

    doc.fontSize(18).text("Опросный лист", { align: "left" });
    doc.moveDown(0.3);
    doc.fontSize(12).text(`Страна оформления/услуга: ${data.countryService || "не указано"}`);
    doc.fontSize(11).text(`Телефон клиента: ${data.phone || ""}`);
    doc.text(`ID сделки: ${data.leadId || ""}`);
    doc.text(`Дата заполнения: ${new Date().toLocaleString("ru-RU")}`);
    doc.moveDown();

    doc.fontSize(13).text("Личные данные", { underline: true });
    doc.moveDown(0.3);
    line("Полное имя (ФИО)", data.fullName);
    line("У меня ранее были предыдущие фамилии", data.hadPrevSurnames);
    line("Укажите все предыдущие фамилии", data.prevSurnames);
    line("Телефон", data.contactPhone);
    line("Почта", data.email);
    line("Семейное положение", data.maritalStatus);
    line("При рождении у меня было иное гражданство", data.hadOtherCitizenshipAtBirth);
    line("Ваше гражданство при рождении", data.birthCitizenship);
    line("У меня в данный момент есть второе гражданство", data.hasSecondCitizenship);
    line("Укажите второе гражданство", data.secondCitizenship);
    line("У меня есть второй заграничный паспорт", data.hasSecondPassport);
    line("На какой паспорт мы оформляем все документы", data.whichPassport);
    line("Можете ли вы сдать второй паспорт в ВЦ на период рассмотрения", data.canSurrenderPassport);
    line("Укажите, по какой причине не сдаете паспорт", data.surrenderReason);
    doc.moveDown();

    doc.fontSize(13).text("Адрес и занятость", { underline: true });
    doc.moveDown(0.3);
    line("Фактический адрес проживания", data.actualAddress);
    line("Род занятий (занимаемая должность)", data.occupation);
    line("Наименование работодателя/учебной организации", data.employerName);
    line("Адрес работодателя/учебной организации", data.employerAddress);
    line("Телефон работодателя", data.employerPhone);
    doc.moveDown();

    doc.fontSize(13).text("Поездка", { underline: true });
    doc.moveDown(0.3);
    line("Цель поездки", data.tripPurpose);
    line('Подробности цели "Иное"', data.tripPurposeOther);
    line("Виза для собеседования на США в Польше", data.usaInterviewPoland);
    line("Страна поездки", data.travelCountry);
    line("В какую страну запрашивается виза", data.visaCountry);
    if (data.tripDateFrom || data.tripDateTo) {
      line("Даты поездки", `${data.tripDateFrom || "?"} — ${data.tripDateTo || "?"}`);
    }
    doc.moveDown();

    doc.fontSize(13).text("История виз", { underline: true });
    doc.moveDown(0.3);
    line("Есть действующая шенгенская виза", data.hasActiveSchengen);
    line("Дата окончания текущей визы", data.schengenExpiry);
    line("Были Шенгенские визы за последние 3 года", data.hadSchengen3Years);
    line("Не открыл/-а последнюю шенгенскую визу", data.didNotUseVisa);
    line("Причина, почему виза не была отъезжена", data.didNotUseReason);
    line("Открыл/-а визу не той страной, которая её выдала", data.visaRefused);
    line("Укажите причину", data.refusalReason);
    doc.moveDown();

    doc.fontSize(13).text("Документы и услуги", { underline: true });
    doc.moveDown(0.3);
    line("Есть действительная страховка для въезда в Шенгенскую зону", data.hasInsurance);
    line("На момент подачи документов младше 18 лет", data.isUnder18);
    line("ФИО законного представителя", data.legalRepresentative);
    line("Поездку спонсирует третье лицо/компания", data.hasSponsor);
    line("ФИО/наименование спонсора", data.sponsorName);
    line("Тип подачи", data.visitType);
    line("Способ получения готовых документов", data.pickupMethod);
    line("Есть документы на льготную оплату консульского сбора", data.hasConsularFeeDoc);
    doc.moveDown();

    doc.fontSize(13).text("Запись ботом", { underline: true });
    doc.moveDown(0.3);
    line("Хочу воспользоваться услугой записи ботом", data.useBotBooking);
    if (data.bookingDateFrom || data.bookingDateTo) {
      line("Диапазон записи", `${data.bookingDateFrom || "?"} — ${data.bookingDateTo || "?"}`);
    }
    line("Исключения", data.bookingExclusions);
    line("Город для записи", data.bookingCity);
    line("Пожелания по датам записи", data.bookingTimePrefs);
    line("Дополнительные услуги в ВЦ (бизнес-залы/ускоренные)", data.bookingLoungePrefs);
    doc.moveDown();

    doc.fontSize(13).text("Прочее", { underline: true });
    doc.moveDown(0.3);
    line("Откуда узнали о нас", data.howFoundUs);
    line("Примечания", data.notes);
    line("Подтверждаю правильность и достоверность сведений", data.confirmAccuracy);
    line("Согласие с условиями договора по электронному опроснику", data.confirmPrevData);
    line("Согласие на обработку персональных данных", data.personalDataConsent);

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

async function getNextApplicantIndex(phone) {
  try {
    const techFolder = `${YANDEX_DISK_ROOT}/${phone}/Опросники/Технические файлы`;
    const files = await listYandexFolderFiles(techFolder);
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
      const loadStateForApplicant = async (n) => {
        const suf = n > 1 ? ` ${n}` : "";
        const fresh = `${YANDEX_DISK_ROOT}/${phone}/Опросники/Технические файлы/Опросник${suf}.json`;
        const legacy = `${YANDEX_DISK_ROOT}/${phone}/Опросник${suf}.json`;
        try {
          const f = await downloadJsonFromYandexDisk(fresh);
          if (f) return f;
        } catch (_) {}
        try {
          return await downloadJsonFromYandexDisk(legacy);
        } catch (_) {
          return null;
        }
      };

      try {
        prefill = await loadStateForApplicant(applicantIndex);
      } catch (err) {
        console.error("EDIT prefill load error:", err.message);
      }
      // Сохраняем общее количество заявителей из первого опросника
      if (applicantIndex !== 1) {
        try {
          const firstState = await loadStateForApplicant(1);
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
      selfStep
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
        applicantIndex = await getNextApplicantIndex(phone);
        totalApplicants = Math.max(applicantIndex, parseInt(shareData.applicantCount, 10) || 1);
      } else if (isMixed) {
        if (!applicantCountRaw) {
          return res.status(400).json({
            success: false,
            message: "Не указано количество заявителей"
          });
        }
        applicantIndex = await getNextApplicantIndex(phone);
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
        hasActiveSchengen:          String(req.body.hasActiveSchengen || "").trim(),
        schengenExpiry:             String(req.body.schengenExpiry || "").trim(),
        hadSchengen3Years:          String(req.body.hadSchengen3Years || "").trim(),
        didNotUseVisa:              String(req.body.didNotUseVisa || "").trim(),
        didNotUseReason:            String(req.body.didNotUseReason || "").trim(),
        visaRefused:                String(req.body.visaRefused || "").trim(),
        refusalReason:              String(req.body.refusalReason || "").trim(),
        hasInsurance:               String(req.body.hasInsurance || "").trim(),
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
      const opsFolder = `${phoneFolder}/Опросники`;
      const techFolder = `${opsFolder}/Технические файлы`;

      const suffix = applicantIndex > 1 ? ` ${applicantIndex}` : "";
      const safeFio = sanitizeFileName(fullName) || `Заявитель ${applicantIndex}`;
      const applicantFolder = `${phoneFolder}/${safeFio}`;

      await ensureYandexFolder(rootFolder);
      await ensureYandexFolder(phoneFolder);
      await ensureYandexFolder(opsFolder);
      await ensureYandexFolder(techFolder);
      await ensureYandexFolder(applicantFolder);

      // PDF опросника кладём в папку с ФИО клиента (рядом с документами).
      const pdfFileName = `Опросник - ${safeFio}.pdf`;
      await uploadBufferToYandexDisk(
        pdfBuffer,
        `${applicantFolder}/${pdfFileName}`,
        "application/pdf"
      );

      // JSON — служебный, остаётся в Опросники/Технические файлы (используется бэкендом
      // для prefill при «Скорректировать опросник» и для определения уже загруженных файлов).
      const stateJson = JSON.stringify({ ...enrichedFields, savedAt: new Date().toISOString() }, null, 2);
      const jsonFileName = `Опросник${suffix}.json`;
      const jsonBuffer = Buffer.from(stateJson, "utf-8");
      await uploadBufferToYandexDisk(
        jsonBuffer,
        `${techFolder}/${jsonFileName}`,
        "application/json; charset=utf-8"
      );

      // Зеркалирование в папку сделки: PDF — в папку ФИО, JSON — служебно в Опросники/Технические файлы.
      // Задачу при сабмите опросника не создаём — только при загрузке документов.
      if (leadId) {
        mirrorToAmoFolderInBackground(
          leadId,
          [
            {
              relativePath: `${safeFio}/${pdfFileName}`,
              buffer: pdfBuffer,
              contentType: "application/pdf"
            },
            {
              relativePath: `Опросники/Технические файлы/${jsonFileName}`,
              buffer: jsonBuffer,
              contentType: "application/json; charset=utf-8"
            }
          ],
          { createTask: false }
        );
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

    if (!phone) {
      return res.status(400).json({ success: false, message: "Не передан phone" });
    }

    if (!YANDEX_DISK_TOKEN) {
      return res.status(500).json({ success: false, message: "Не задан YANDEX_DISK_TOKEN" });
    }

    const techPath = (n) => {
      const suf = n > 1 ? ` ${n}` : "";
      return `${YANDEX_DISK_ROOT}/${phone}/Опросники/Технические файлы/Опросник${suf}.json`;
    };
    const legacyPath = (n) => {
      const suf = n > 1 ? ` ${n}` : "";
      return `${YANDEX_DISK_ROOT}/${phone}/Опросник${suf}.json`;
    };
    const loadOne = async (n) => {
      try {
        const fresh = await downloadJsonFromYandexDisk(techPath(n));
        if (fresh) return fresh;
      } catch (_) {}
      return await downloadJsonFromYandexDisk(legacyPath(n));
    };

    const first = await loadOne(1);

    if (!first) {
      return res.json({ success: true, applicants: [] });
    }

    const total = Math.max(1, Math.min(10, parseInt(first.totalApplicants, 10) || 1));
    const restPromises = [];
    for (let i = 2; i <= total; i++) {
      restPromises.push(loadOne(i));
    }
    const rest = await Promise.all(restPromises);

    const applicants = [{ ...first, applicantIndex: 1 }];
    rest.forEach((s, i) => {
      if (s) applicants.push({ ...s, applicantIndex: i + 2 });
    });

    // Список загруженных файлов в папке заявителя (для подсветки этапа "Сбор документов")
    await Promise.all(applicants.map(async (a) => {
      const fio = sanitizeFileName(String(a.fullName || "").trim()) || `Заявитель ${a.applicantIndex}`;
      const folder = `${YANDEX_DISK_ROOT}/${phone}/${fio}`;
      a.uploadedFiles = await listYandexFolderFiles(folder);
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

      if (!phone) return res.status(400).json({ success: false, message: "Телефон не передан" });
      if (!file) return res.status(400).json({ success: false, message: "Файл не передан" });
      if (!YANDEX_DISK_TOKEN) return res.status(500).json({ success: false, message: "Не задан YANDEX_DISK_TOKEN" });

      const rootFolder = YANDEX_DISK_ROOT;
      const phoneFolder = `${rootFolder}/${phone}`;
      const extraFolder = `${phoneFolder}/Дополнительные документы`;

      await ensureYandexFolder(rootFolder);
      await ensureYandexFolder(phoneFolder);
      await ensureYandexFolder(extraFolder);

      const origName = sanitizeFileName(file.originalname || "file");
      const dotIndex = origName.lastIndexOf(".");
      const base = dotIndex > 0 ? origName.slice(0, dotIndex) : origName;
      const ext = dotIndex > 0 ? origName.slice(dotIndex) : "";
      const ts = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 19);
      const finalName = `${base} - ${ts}${ext}`;
      const diskPath = `${extraFolder}/${finalName}`;

      await uploadBufferToYandexDisk(file.buffer, diskPath, file.mimetype);

      // Зеркалирование в папку сделки на Я.Диске + amoCRM-задача (фоном)
      const leadId = String(req.body.leadId || "").trim();
      mirrorToAmoFolderInBackground(
        leadId,
        {
          relativePath: `Дополнительные документы/${finalName}`,
          buffer: file.buffer,
          contentType: file.mimetype
        },
        { createTask: true }
      );

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

      console.log("HANDLER /upload-document phone =", phone, "field =", field, "applicantIndex =", applicantIndex);

      if (!phone) {
        return res.status(400).json({ success: false, message: "Телефон не передан" });
      }
      if (!file) {
        return res.status(400).json({ success: false, message: "Файл не передан" });
      }

      const targetName = UPLOAD_FIELDS_WHITELIST[field];
      if (!targetName) {
        return res.status(400).json({ success: false, message: "Неизвестный тип документа" });
      }

      if (!YANDEX_DISK_TOKEN) {
        return res.status(500).json({ success: false, message: "Не задан YANDEX_DISK_TOKEN" });
      }

      const rootFolder = YANDEX_DISK_ROOT;
      const phoneFolder = `${rootFolder}/${phone}`;

      await ensureYandexFolder(rootFolder);
      await ensureYandexFolder(phoneFolder);

      const questionnaireSuffix = applicantIndex > 1 ? ` ${applicantIndex}` : "";
      const freshJsonPath = `${phoneFolder}/Опросники/Технические файлы/Опросник${questionnaireSuffix}.json`;
      const legacyJsonPath = `${phoneFolder}/Опросник${questionnaireSuffix}.json`;
      let applicantState = null;
      try { applicantState = await downloadJsonFromYandexDisk(freshJsonPath); } catch (_) {}
      if (!applicantState) {
        try { applicantState = await downloadJsonFromYandexDisk(legacyJsonPath); } catch (_) {}
      }

      if (!applicantState) {
        return res.status(409).json({
          success: false,
          message: "Опросник заявителя не найден — заполните опросник перед загрузкой документов"
        });
      }

      const rawFio = String(applicantState.fullName || "").trim();
      const safeFio = sanitizeFileName(rawFio) || `Заявитель ${applicantIndex}`;
      const applicantFolder = `${phoneFolder}/${safeFio}`;

      await ensureYandexFolder(applicantFolder);

      const originalName = sanitizeFileName(file.originalname || "file");
      const dotIndex = originalName.lastIndexOf(".");
      const ext = dotIndex >= 0 ? originalName.slice(dotIndex) : "";
      // Если для одного поля грузится несколько файлов — добавляем суффикс (2), (3) и т.д.
      const partIndex = Math.max(1, parseInt(req.body.partIndex || "1", 10) || 1);
      const partSuffix = partIndex > 1 ? ` (${partIndex})` : "";
      const finalFileName = `${targetName} - ${safeFio}${partSuffix}${ext}`;
      const diskPath = `${applicantFolder}/${finalFileName}`;

      console.log("UPLOAD TO YANDEX:", diskPath);
      await uploadBufferToYandexDisk(file.buffer, diskPath, file.mimetype);

      // Зеркалирование в папку сделки на Я.Диске + amoCRM-задача (фоном)
      const leadId = String(req.body.leadId || "").trim();
      mirrorToAmoFolderInBackground(
        leadId,
        {
          relativePath: `${safeFio}/${finalFileName}`,
          buffer: file.buffer,
          contentType: file.mimetype
        },
        { createTask: true }
      );

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

app.listen(PORT, () => {
  console.log(`Server started on http://localhost:${PORT}`);
});
