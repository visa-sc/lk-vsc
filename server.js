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
    "Передано Клиенту для личной подачи": { client_status: "Ожидание записи / подачи" },
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

function buildQuestionnaireHtml({ phone, leadId, countryService }) {
  const safePhone = escapeHtml(phone || "");
  const safeLeadId = escapeHtml(String(leadId || ""));
  const safeCountry = escapeHtml(countryService || "не указано");

  return `
<!DOCTYPE html>
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
    h1 {
      margin: 0 0 8px;
      font-size: 28px;
      line-height: 1.15;
      color: #171c29;
    }
    .subtitle {
      margin: 0 0 22px;
      font-size: 14px;
      color: #737988;
      line-height: 1.5;
    }
    form {
      display: grid;
      gap: 14px;
    }
    .field {
      display: grid;
      gap: 6px;
    }
    .field label {
      font-size: 14px;
      font-weight: 600;
      color: #3a4150;
    }
    .field input {
      width: 100%;
      height: 50px;
      border: 1px solid #e8e2ee;
      border-radius: 14px;
      padding: 0 14px;
      font-size: 16px;
      outline: none;
      background: #fff;
      color: #1f2532;
    }
    .message {
      display: none;
      padding: 12px 14px;
      border-radius: 14px;
      font-size: 14px;
      margin-bottom: 16px;
    }
    .message.error {
      background: #fbebee;
      border: 1px solid #efcfd5;
      color: #a15561;
    }
    .message.success {
      background: #edf8ef;
      border: 1px solid #cfe7d2;
      color: #2e7a43;
    }
    .submit-btn {
      height: 50px;
      border: none;
      border-radius: 14px;
      background: #161d45;
      color: #fff;
      font-size: 16px;
      font-weight: 600;
      cursor: pointer;
      margin-top: 8px;
    }
  </style>
</head>
<body>
  <div class="wrap">
    <h1>Опросный лист на ${safeCountry}</h1>
    <p class="subtitle">Заполните, пожалуйста, данные и отправьте опросник.</p>

    <div id="errorBox" class="message error"></div>
    <div id="successBox" class="message success"></div>

    <form id="questionnaireForm">
      <input type="hidden" name="phone" value="${safePhone}" />
      <input type="hidden" name="leadId" value="${safeLeadId}" />

      <div class="field">
        <label for="lastName">Фамилия</label>
        <input id="lastName" name="lastName" type="text" required />
      </div>

      <div class="field">
        <label for="firstName">Имя</label>
        <input id="firstName" name="firstName" type="text" required />
      </div>

      <div class="field">
        <label for="middleName">Отчество</label>
        <input id="middleName" name="middleName" type="text" required />
      </div>

      <button id="submitBtn" class="submit-btn" type="submit">Отправить опросник</button>
    </form>
  </div>

  <script>
    const form = document.getElementById("questionnaireForm");
    const submitBtn = document.getElementById("submitBtn");
    const errorBox = document.getElementById("errorBox");
    const successBox = document.getElementById("successBox");

    function showBox(el, message) {
      el.style.display = "block";
      el.textContent = message || "";
    }

    function hideBox(el) {
      el.style.display = "none";
      el.textContent = "";
    }

    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      hideBox(errorBox);
      hideBox(successBox);

      submitBtn.disabled = true;
      submitBtn.textContent = "Отправка...";

      try {
        const formData = new FormData(form);
        const payload = Object.fromEntries(formData.entries());

        const response = await fetch("/api/questionnaire", {
          method: "POST",
          headers: {
            "Content-Type": "application/json"
          },
          body: JSON.stringify(payload)
        });

        const data = await response.json();

        if (!response.ok || !data.success) {
          throw new Error(data.message || "Не удалось отправить опросник");
        }

        showBox(successBox, "Опросник успешно отправлен");

        setTimeout(() => {
          if (window.opener && !window.opener.closed) {
            window.close();
            return;
          }

          if (window.history.length > 1) {
            window.history.back();
            return;
          }

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
</html>
  `;
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
    const doc = new PDFDocument({
      size: "A4",
      margin: 50
    });

    const chunks = [];
    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const fontPath = getPdfFontPath();
    if (fontPath) {
      doc.font(fontPath);
    }

    doc.fontSize(20).text("Опросник", { align: "left" });
    doc.moveDown();
    doc.fontSize(14).text(`Страна оформления/услуга: ${data.countryService || "не указано"}`);
    doc.moveDown();
    doc.text(`Фамилия: ${data.lastName || ""}`);
    doc.text(`Имя: ${data.firstName || ""}`);
    doc.text(`Отчество: ${data.middleName || ""}`);
    doc.moveDown();
    doc.fontSize(11).text(`Телефон клиента: ${data.phone || ""}`);
    doc.text(`ID сделки: ${data.leadId || ""}`);
    doc.text(`Дата заполнения: ${new Date().toLocaleString("ru-RU")}`);

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

app.get("/questionnaire", async (req, res) => {
  try {
    const phone = normalizePhone(req.query.phone || "");
    const leadId = String(req.query.leadId || "").trim();

    if (!phone || !leadId) {
      return res.status(400).send("Не переданы phone или leadId");
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

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.send(buildQuestionnaireHtml({
      phone,
      leadId,
      countryService
    }));
  } catch (error) {
    console.error("GET /questionnaire error:", error.response?.data || error.message);
    return res.status(500).send("Ошибка при открытии опросника");
  }
});

app.post("/api/questionnaire", async (req, res) => {
  try {
    const phone = normalizePhone(req.body.phone || "");
    const leadId = String(req.body.leadId || "").trim();
    const lastName = String(req.body.lastName || "").trim();
    const firstName = String(req.body.firstName || "").trim();
    const middleName = String(req.body.middleName || "").trim();

    if (!phone || !leadId || !lastName || !firstName || !middleName) {
      return res.status(400).json({
        success: false,
        message: "Заполнены не все поля опросника"
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

    const pdfBuffer = await generateQuestionnairePdfBuffer({
      phone,
      leadId,
      countryService,
      lastName,
      firstName,
      middleName
    });

    const rootFolder = YANDEX_DISK_ROOT;
    const phoneFolder = `${rootFolder}/${phone}`;
    const diskPath = `${phoneFolder}/Опросник.pdf`;

    await ensureYandexFolder(rootFolder);
    await ensureYandexFolder(phoneFolder);
    await uploadBufferToYandexDisk(pdfBuffer, diskPath, "application/pdf");

    return res.json({
      success: true,
      message: "Опросник успешно сохранён"
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
});

app.post(
  "/upload-documents",
  upload.fields([
    { name: "passportFile", maxCount: 1 },
    { name: "innerPassportFile", maxCount: 1 },
    { name: "workFile", maxCount: 1 }
  ]),
  async (req, res) => {
    try {
      const phone = normalizePhone(req.body.phone || "");

      console.log("HANDLER /upload-documents phone =", phone);
      console.log("FILES:", Object.keys(req.files || {}));

      if (!phone) {
        return res.status(400).json({
          success: false,
          message: "Телефон не передан"
        });
      }

      if (!YANDEX_DISK_TOKEN) {
        return res.status(500).json({
          success: false,
          message: "Не задан YANDEX_DISK_TOKEN"
        });
      }

      const rootFolder = YANDEX_DISK_ROOT;
      const phoneFolder = `${rootFolder}/${phone}`;

      await ensureYandexFolder(rootFolder);
      await ensureYandexFolder(phoneFolder);

      const fileConfigs = [
        {
          field: "passportFile",
          targetName: "Заграничный паспорт"
        },
        {
          field: "innerPassportFile",
          targetName: "Внутренний паспорт"
        },
        {
          field: "workFile",
          targetName: "Справка с работы"
        }
      ];

      const uploadedFiles = [];

      for (const config of fileConfigs) {
        const file = req.files?.[config.field]?.[0];
        if (!file) continue;

        const originalName = sanitizeFileName(file.originalname || "file");
        const dotIndex = originalName.lastIndexOf(".");
        const ext = dotIndex >= 0 ? originalName.slice(dotIndex) : "";
        const finalFileName = `${config.targetName}${ext}`;
        const diskPath = `${phoneFolder}/${finalFileName}`;

        console.log("UPLOAD TO YANDEX:", diskPath);

        await uploadBufferToYandexDisk(file.buffer, diskPath, file.mimetype);

        uploadedFiles.push({
          field: config.field,
          fileName: finalFileName
        });
      }

      return res.json({
        success: true,
        message: "Файлы успешно загружены",
        uploadedFiles
      });
    } catch (error) {
      console.error("UPLOAD DOCUMENTS ERROR:");
      console.error("message:", error.message);
      console.error("status:", error.response?.status);
      console.error("", error.response?.data);

      return res.status(500).json({
        success: false,
        message: "Ошибка загрузки документов",
        error: error.response?.data || error.message
      });
    }
  }
);

app.listen(PORT, () => {
  console.log(`Server started on http://localhost:${PORT}`);
});
