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

    if (code === "PHONE" || name.includes("телефон")) {
      for (const item of field.values || []) {
        if (item?.value) {
          values.push(normalizePhone(item.value));
        }
      }
    }
  }

  return values.filter(Boolean);
}

function contactMatchesPhone(contact, phone) {
  const normalizedPhone = normalizePhone(phone);
  const phones = extractPhonesFromContact(contact);

  return phones.some((p) => {
    return (
      p === normalizedPhone ||
      p.endsWith(normalizedPhone) ||
      normalizedPhone.endsWith(p)
    );
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

    if (!nextUrl) {
      break;
    }

    page += 1;
  }

  return allItems;
}

async function getLeadLinks(baseUrl, leadId) {
  try {
    const data = await amoGet(`${baseUrl}/api/v4/leads/${leadId}/links`);
    return data?._embedded?.links || [];
  } catch (error) {
    console.error("GET LEAD LINKS ERROR:", leadId, error.response?.data || error.message);
    return [];
  }
}

async function getContactLinks(baseUrl, contactId) {
  try {
    const data = await amoGet(`${baseUrl}/api/v4/contacts/${contactId}/links`);
    return data?._embedded?.links || [];
  } catch (error) {
    console.error("GET CONTACT LINKS ERROR:", contactId, error.response?.data || error.message);
    return [];
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

async function getLeadsByPhone(phone) {
  const normalized = normalizePhone(phone);

  console.log("PHONE RAW:", phone);
  console.log("PHONE NORMALIZED:", normalized);
  console.log("AMO_SUBDOMAIN:", AMO_SUBDOMAIN);

  if (!normalized) return [];

  const baseUrl = `https://${AMO_SUBDOMAIN}.amocrm.ru`;

  const foundContacts = [];
  const contactIds = new Set();

  const contactSearchQueries = Array.from(new Set([
    normalized,
    normalized.slice(-10),
    normalized.startsWith("7") ? `8${normalized.slice(1)}` : normalized
  ].filter(Boolean)));

  for (const query of contactSearchQueries) {
    const contacts = await amoGetAllPages(`${baseUrl}/api/v4/contacts`, {
      query,
      with: "leads"
    });

    for (const contact of contacts) {
      if (!contact?.id) continue;
      if (!contactIds.has(contact.id) && contactMatchesPhone(contact, normalized)) {
        contactIds.add(contact.id);
        foundContacts.push(contact);
      }
    }
  }

  console.log("MATCHED CONTACT IDS:", Array.from(contactIds));

  const leadIds = new Set();

  for (const contact of foundContacts) {
    const embeddedLeads = contact?._embedded?.leads || [];
    for (const lead of embeddedLeads) {
      if (lead?.id) {
        leadIds.add(lead.id);
      }
    }

    const links = await getContactLinks(baseUrl, contact.id);
    for (const link of links) {
      const toEntityType = String(link.to_entity_type || "").toLowerCase();
      if (toEntityType === "leads" && link.to_entity_id) {
        leadIds.add(link.to_entity_id);
      }
    }
  }

  const leadIdsArray = Array.from(leadIds);
  console.log("ALL LEAD IDS:", leadIdsArray);

  if (!leadIdsArray.length) {
    return [];
  }

  const chunks = [];
for (let i = 0; i < leadIdsArray.length; i += 100) {
    chunks.push(leadIdsArray.slice(i, i + 100));
  }

  const allLeads = [];

  for (const chunk of chunks) {
    const data = await amoGet(`${baseUrl}/api/v4/leads`, {
      "filter[id]": chunk.join(","),
      with: "contacts"
    });

    const leads = data?._embedded?.leads || [];
    allLeads.push(...leads);
  }

  const uniqueLeadsMap = new Map();

  for (const lead of allLeads) {
    if (!lead?.id) continue;
    if (leadIsHidden(lead)) continue;
    uniqueLeadsMap.set(lead.id, lead);
  }

  for (const lead of allLeads) {
    if (!lead?.id) continue;

    const links = await getLeadLinks(baseUrl, lead.id);
    const hasMatchedContact = links.some((link) => {
      const toEntityType = String(link.to_entity_type || "").toLowerCase();
      return toEntityType === "contacts" && contactIds.has(link.to_entity_id);
    });

    if (hasMatchedContact && !leadIsHidden(lead)) {
      uniqueLeadsMap.set(lead.id, lead);
    }
  }

  const uniqueLeads = Array.from(uniqueLeadsMap.values()).sort((a, b) => {
    return (b.created_at || 0) - (a.created_at || 0);
  });

  console.log("VISIBLE LEADS:", uniqueLeads.map((lead) => ({
    id: lead.id,
    name: lead.name,
    created_at: lead.created_at,
    status_name: lead.status_name
  })));

  return uniqueLeads;
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
