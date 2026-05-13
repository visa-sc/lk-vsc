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
  .replace(/^https?:\/\//, "")
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

  const contactSearch = await amoGet(`${baseUrl}/api/v4/contacts`, {
    query: normalized,
    with: "leads"
  });

  console.log("CONTACT SEARCH RESPONSE:", JSON.stringify(contactSearch).slice(0, 3000));

  const contacts = contactSearch._embedded?.contacts || [];
  const leadIds = new Set();

  for (const contact of contacts) {
    const linkedLeads = contact._embedded?.leads || [];
    for (const lead of linkedLeads) {
      if (lead.id) leadIds.add(lead.id);
    }
  }

  console.log("FOUND CONTACTS:", contacts.length);
  console.log("FOUND LEAD IDS:", Array.from(leadIds));

  if (!leadIds.size) return [];

  const leadsResponse = await amoGet(`${baseUrl}/api/v4/leads`, {
    "filter[id]": Array.from(leadIds).join(","),
    with: "contacts"
  });

  console.log("LEADS RESPONSE:", JSON.stringify(leadsResponse).slice(0, 3000));

  return leadsResponse._embedded?.leads || [];
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
