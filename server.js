require("dotenv").config();

const express = require("express");
const path = require("path");
const axios = require("axios");
const multer = require("multer");

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

function leadIsHidden(lead) {
  const raw = [
    lead?.name,
    lead?.status_name,
    lead?.pipeline_name
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  return raw.includes("hidden") || raw.includes("скрыт");
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

  const matchedContacts = Array.from(contactsMap.values());

  console.log("MATCHED CONTACTS:", matchedContacts.map((c) => ({
    id: c.id,
    phones: extractPhonesFromContact(c)
  })));

  return matchedContacts;
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

async function loadLeadsByIds(baseUrl, leadIds) {
  const leadsMap = new Map();

  for (const leadId of leadIds) {
    const lead = await getLeadById(baseUrl, leadId);
    if (!lead?.id) continue;
    if (leadIsHidden(lead)) continue;
    leadsMap.set(lead.id, lead);
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

  const contacts = await findMatchingContacts(baseUrl, normalized);
  if (!contacts.length) {
    console.log("NO MATCHING CONTACTS");
    return [];
  }

  const leadIds = await collectLeadIdsFromContacts(baseUrl, contacts);
  console.log("COLLECTED LEAD IDS:", leadIds);

  if (!leadIds.length) {
    return [];
  }

  const leads = await loadLeadsByIds(baseUrl, leadIds);

  console.log("VISIBLE LEADS:", leads.map((lead) => ({
    id: lead.id,
    name: lead.name,
    created_at: lead.created_at,
    status_name: lead.status_name
  })));

  return leads;
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
          name: finalFileName,
          path: diskPath
        });
      }

      if (!uploadedFiles.length) {
        return res.status(400).json({
          success: false,
          message: "Не выбраны файлы для загрузки"
        });
      }

      return res.json({
        success: true,
        message: "Документы успешно загружены на Яндекс.Диск",
        folder: phoneFolder,
        uploadedFiles
      });
    } catch (error) {
      console.error("API /upload-documents error:");
      console.error("message:", error.message);
      console.error("status:", error.response?.status);
      console.error("", error.response?.data);
      console.error("stack:", error.stack);

      return res.status(500).json({
        success: false,
        message: "Ошибка загрузки документов",
        error: error.response?.data || error.message
      });
    }
  }
);

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`Server started on port ${PORT}`);
});
