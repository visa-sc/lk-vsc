const express = require("express");
const cors = require("cors");
const axios = require("axios");
const path = require("path");
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

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

function normalizePipelineName(name = "") {
  const value = name.trim().toLowerCase();

  if (value.includes("отдел продаж")) return "Отдел продаж";
  if (value.includes("отдел оформления")) return "Отдел Оформления";
  if (value.includes("отдел по работе с клиент")) return "Отдел по работе с Клиентами";

  return name.trim();
}

function getClientStatus(pipelineName = "", statusName = "") {
  const normalizedPipeline = normalizePipelineName(pipelineName);
  const pipelineMap = STATUS_MAP[normalizedPipeline];

  if (!pipelineMap) {
    return { client_status: "Сбор документов", hidden: false };
  }

  const mapped = pipelineMap[statusName];

  if (!mapped) {
    return { client_status: "Сбор документов", hidden: false };
  }

  return {
    client_status: mapped.client_status || null,
    hidden: mapped.hidden === true
  };
}

function formatLeadDate(createdAt) {
  if (!createdAt) return "без даты";
  const date = new Date(createdAt * 1000);
  return date.toLocaleDateString("ru-RU");
}

async function amoGet(url) {
  const response = await axios.get(url, {
    headers: {
      Authorization: `Bearer ${process.env.AMO_ACCESS_TOKEN}`,
      "Content-Type": "application/json"
    }
  });

  return response.data;
}

app.get("/client-status", async (req, res) => {
  try {
    const phone = req.query.phone;

    if (!phone) {
      return res.json({
        success: false,
        message: "Телефон не передан"
      });
    }

    const contactData = await amoGet(
      `https://${process.env.AMO_SUBDOMAIN}/api/v4/contacts?query=${encodeURIComponent(phone)}`
    );

    const contact = contactData?._embedded?.contacts?.[0];

    if (!contact) {
      return res.json({
        success: false,
        message: "Контакт не найден"
      });
    }

    const linksData = await amoGet(
      `https://${process.env.AMO_SUBDOMAIN}/api/v4/contacts/${contact.id}/links`
    );

    const leadLinks =
      linksData?._embedded?.links?.filter((item) => item.to_entity_type === "leads") || [];

    if (!leadLinks.length) {
      return res.json({
        success: true,
        phone,
        contact_id: contact.id,
        contact_name: contact.name || "",
        deals: [],
        message: "У контакта нет сделок"
      });
    }

    const deals = [];

    for (const link of leadLinks) {
      const leadId = link.to_entity_id;

      try {
        const lead = await amoGet(
          `https://${process.env.AMO_SUBDOMAIN}/api/v4/leads/${leadId}`
        );

        const pipelineId = lead.pipeline_id;
        const statusId = lead.status_id;

        const pipelineData = await amoGet(
          `https://${process.env.AMO_SUBDOMAIN}/api/v4/leads/pipelines/${pipelineId}`
        );

        const pipelineName = pipelineData?.name || "";
        const statuses = pipelineData?._embedded?.statuses || [];
        const currentStatus = statuses.find((s) => s.id === statusId);
        const statusName = currentStatus?.name || "";

        const clientStatusData = getClientStatus(pipelineName, statusName);

        if (clientStatusData.hidden) {
          continue;
        }

        deals.push({
          lead_id: lead.id,
          lead_name: lead.name || "",
          pipeline_name: pipelineName,
          amo_status_name: statusName,
          client_status: clientStatusData.client_status,
          created_at: lead.created_at || null,
          display_name: `Обращение от ${formatLeadDate(lead.created_at)}`
        });
      } catch (leadError) {
        continue;
      }
    }

    deals.sort((a, b) => {
      const aTime = a.created_at || 0;
      const bTime = b.created_at || 0;
      return bTime - aTime;
    });

    return res.json({
      success: true,
      phone,
      contact_id: contact.id,
      contact_name: contact.name || "",
      deals,
      message: deals.length ? "Сделки найдены" : "Нет доступных сделок для отображения"
    });
  } catch (error) {
    const amoMessage =
      error?.response?.data?.detail ||
      error?.response?.data?.title ||
      error?.response?.data?.message ||
      error.message;

    return res.status(500).json({
      success: false,
      message: "Ошибка получения статуса",
      error: amoMessage
    });
  }
});

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`Server started on port ${PORT}`);
});
