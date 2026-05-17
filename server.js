require("dotenv").config();

const express = require("express");
const path = require("path");
const fs = require("fs");
const os = require("os");
const axios = require("axios");
const multer = require("multer");
const PDFDocument = require("pdfkit");

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
  return axios({
    ...config,
    headers: {
      Authorization: `OAuth ${YANDEX_DISK_TOKEN}`,
      ...(config.headers || {})
    },
    maxBodyLength: Infinity,
    maxContentLength: Infinity
  });
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

const UPLOAD_FIELDS_WHITELIST = {
  mainPassport:   "Заграничный паспорт (в который запрашиваем визу)",
  innerPassport:  "Внутренний паспорт",
  workCert:       "Справка с работы",
  secondPassport: "Второй заграничный паспорт",
  prevSchengen:   "Шенгенские визы за последние 3 года"
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

function buildQuestionnaireHtml({ phone, leadId, countryService, applicantIndex = 1, totalApplicants = 1, prevApplicantName = "", prefill = null, isEdit = false, applicantCount = 0 }) {
  const safePhone = escapeHtml(phone || "");
  const safeLeadId = escapeHtml(String(leadId || ""));
  const safeCountry = escapeHtml(countryService || "не указано");
  const idx = Math.max(1, parseInt(applicantIndex, 10) || 1);
  const total = Math.max(idx, parseInt(totalApplicants, 10) || 1);
  const safePrevName = escapeHtml(prevApplicantName || "");
  const isFirstApplicant = idx === 1;
  const safeApplicantCount = Math.max(0, parseInt(applicantCount, 10) || 0);

  const subtitleText = isEdit
    ? "Внесите изменения и нажмите «Отправить опросник»."
    : "Заполните, пожалуйста, данные и отправьте опросник.";

  const handoffNoticeHtml = (isFirstApplicant || isEdit) ? "" : `
    <div class="handoff-notice">
      Опросник для <strong>${safePrevName || "предыдущего заявителя"}</strong> отправлен. Заполните опросник на следующего заявителя.
    </div>`;

  const applicantCountFieldHtml = (isFirstApplicant && !isEdit && safeApplicantCount > 0) ? `
    <input type="hidden" name="applicantCount" value="${safeApplicantCount}" />` : "";

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
  </style>
</head>
<body>
<div class="wrap">
  <h1>Опросный лист на ${safeCountry}</h1>
  <p class="subtitle">${subtitleText}</p>

  <div id="successBox" class="message success"></div>
${handoffNoticeHtml}
  <form id="questionnaireForm">
    <input type="hidden" name="phone" value="${safePhone}" />
    <input type="hidden" name="leadId" value="${safeLeadId}" />
    <input type="hidden" name="applicantIndex" value="${idx}" />
    <input type="hidden" name="totalApplicants" value="${total}" />
    <input type="hidden" name="isEdit" value="${isEdit ? "1" : ""}" />
${applicantCountFieldHtml}
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
      <input type="tel" name="contactPhone" required />
      <span class="hint">Тот, по которому Консульство сможет связаться с заявителем</span>
    </div>

    <!-- 5 -->
    <div class="field">
      <label>Почта *</label>
      <input type="text" name="email" required />
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
      <input type="tel" name="employerPhone" required />
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
        <label>Прикрепите фото последней шенгенской визы *</label>
        <input type="file" name="visaPhoto" accept="image/*,.pdf" />
      </div>
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

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    hideBox(errorBox);
    hideBox(successBox);

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
  const underdevCond = document.getElementById("c_underdev");
  const continueBtn = document.getElementById("continueBtn");

  function update() {
    const v = visaSelect.value;
    const isSchengen = v === "Шенгенская виза";
    countCond.classList.toggle("show", isSchengen);
    underdevCond.classList.toggle("show", !!v && !isSchengen);
    const countVal = parseInt(countSelect.value, 10) || 0;
    continueBtn.disabled = !(isSchengen && countVal > 0);
  }

  visaSelect.addEventListener("change", update);
  countSelect.addEventListener("change", update);
  update();

  document.getElementById("startForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const v = visaSelect.value;
    if (v !== "Шенгенская виза") return;
    const count = parseInt(countSelect.value, 10) || 0;
    if (count < 1) return;
    const params = new URLSearchParams({
      phone: PHONE,
      leadId: LEAD_ID,
      applicantCount: String(count)
    });
    window.location.href = "/questionnaire?" + params.toString();
  });
</script>
</body>
</html>`;
}

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
    const phone = normalizePhone(req.query.phone || "");
    const leadId = String(req.query.leadId || "").trim();
    const applicantIndex = Math.max(1, Math.min(10, parseInt(req.query.applicantIndex || "1", 10) || 1));
    const totalApplicants = Math.max(applicantIndex, Math.min(10, parseInt(req.query.totalApplicants || "1", 10) || 1));
    const prevApplicantName = String(req.query.prevApplicantName || "").trim();
    const isEdit = String(req.query.edit || "") === "1";
    const applicantCount = Math.max(0, Math.min(10, parseInt(req.query.applicantCount || "0", 10) || 0));

    if (!phone || !leadId) {
      return res.status(400).send("Не переданы phone или leadId");
    }

    // Первый заявитель без applicantCount — перенаправляем на стартовую страницу выбора визы и количества
    if (!isEdit && applicantIndex === 1 && !applicantCount) {
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
      applicantCount
    }));
  } catch (error) {
    console.error("GET /questionnaire error:", error.response?.data || error.message);
    return res.status(500).send("Ошибка при открытии опросника");
  }
});

app.post(
  "/api/questionnaire",
  upload.fields([{ name: "visaPhoto", maxCount: 1 }]),
  async (req, res) => {
    try {
      const phone = normalizePhone(req.body.phone || "");
      const leadId = String(req.body.leadId || "").trim();
      const fullName = String(req.body.fullName || "").trim();

      const applicantIndex = Math.max(1, Math.min(10, parseInt(req.body.applicantIndex || "1", 10) || 1));
      const applicantCountRaw = Math.max(1, Math.min(10, parseInt(req.body.applicantCount || "0", 10) || 0));
      const incomingTotal = Math.max(1, Math.min(10, parseInt(req.body.totalApplicants || "0", 10) || 0));
      const isEdit = String(req.body.isEdit || "") === "1";
      const totalApplicants = isEdit
        ? Math.max(applicantIndex, incomingTotal)
        : (applicantIndex === 1
            ? Math.max(1, applicantCountRaw)
            : Math.max(applicantIndex, incomingTotal));

      if (!phone || !leadId || !fullName) {
        return res.status(400).json({
          success: false,
          message: "Заполнены не все обязательные поля опросника"
        });
      }

      if (!isEdit && applicantIndex === 1 && !applicantCountRaw) {
        return res.status(400).json({
          success: false,
          message: "Не указано количество заявителей"
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
        personalDataConsent:        String(req.body.personalDataConsent || "").trim()
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

      await ensureYandexFolder(rootFolder);
      await ensureYandexFolder(phoneFolder);
      await ensureYandexFolder(opsFolder);
      await ensureYandexFolder(techFolder);

      const suffix = applicantIndex > 1 ? ` ${applicantIndex}` : "";
      const safeFio = sanitizeFileName(fullName) || `Заявитель ${applicantIndex}`;

      await uploadBufferToYandexDisk(
        pdfBuffer,
        `${opsFolder}/Опросник - ${safeFio}.pdf`,
        "application/pdf"
      );

      const stateJson = JSON.stringify({ ...enrichedFields, savedAt: new Date().toISOString() }, null, 2);
      await uploadBufferToYandexDisk(
        Buffer.from(stateJson, "utf-8"),
        `${techFolder}/Опросник${suffix}.json`,
        "application/json; charset=utf-8"
      );

      const visaPhotoFile = req.files?.visaPhoto?.[0];
      if (visaPhotoFile) {
        const origName = sanitizeFileName(visaPhotoFile.originalname || "visa");
        const dotIndex = origName.lastIndexOf(".");
        const ext = dotIndex >= 0 ? origName.slice(dotIndex) : "";
        await uploadBufferToYandexDisk(
          visaPhotoFile.buffer,
          `${opsFolder}/Фото шенгенской визы - ${safeFio}${ext}`,
          visaPhotoFile.mimetype
        );
      }

      let nextApplicantUrl = null;
      if (!isEdit && applicantIndex < totalApplicants) {
        const params = new URLSearchParams({
          phone,
          leadId,
          applicantIndex: String(applicantIndex + 1),
          totalApplicants: String(totalApplicants),
          prevApplicantName: fullName
        });
        nextApplicantUrl = `/questionnaire?${params.toString()}`;
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
      const finalFileName = `${targetName} - ${safeFio}${ext}`;
      const diskPath = `${applicantFolder}/${finalFileName}`;

      console.log("UPLOAD TO YANDEX:", diskPath);
      await uploadBufferToYandexDisk(file.buffer, diskPath, file.mimetype);

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
