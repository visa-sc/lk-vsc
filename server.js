require("dotenv").config();

const express = require("express");
const path = require("path");

const app = express();

app.use(express.static(path.join(__dirname, "public")));

async function amoGet(url) {
  const response = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${process.env.AMO_ACCESS_TOKEN}`,
      "Content-Type": "application/json"
    }
  });

  const data = await response.json();
  return data;
}

app.get("/client-status", async (req, res) => {
  try {
    const phone = req.query.phone;

    if (!phone) {
      return res.json({ success: false, message: "Телефон не передан" });
    }

    const contactData = await amoGet(
      `https://${process.env.AMO_SUBDOMAIN}/api/v4/contacts?query=${encodeURIComponent(phone)}`
    );

    const contact = contactData?._embedded?.contacts?.[0];

    if (!contact) {
      return res.json({ success: false, message: "Контакт не найден" });
    }

    const linksData = await amoGet(
      `https://${process.env.AMO_SUBDOMAIN}/api/v4/contacts/${contact.id}/links`
    );

    const leadLinks = linksData?._embedded?.links?.filter(
      (item) => item.to_entity_type === "leads"
    ) || [];

    if (!leadLinks.length) {
      return res.json({
        success: true,
        phone,
        contact_id: contact.id,
        contact_name: contact.name,
        message: "У контакта нет сделок"
      });
    }

    const leadId = leadLinks[0].to_entity_id;

    const leadData = await amoGet(
      `https://${process.env.AMO_SUBDOMAIN}/api/v4/leads/${leadId}`
    );

    const pipelineData = await amoGet(
      `https://${process.env.AMO_SUBDOMAIN}/api/v4/leads/pipelines/${leadData.pipeline_id}`
    );

    const statuses = pipelineData?._embedded?.statuses || [];
    const currentStatus = statuses.find(
      (status) => Number(status.id) === Number(leadData.status_id)
    );

    res.json({
      success: true,
      phone,
      contact_id: contact.id,
      contact_name: contact.name,
      lead_id: leadData.id,
      lead_name: leadData.name,
      pipeline_id: leadData.pipeline_id,
      pipeline_name: pipelineData.name || "",
      status_id: leadData.status_id,
      status_name: currentStatus ? currentStatus.name : "Статус не найден",
      statuses: statuses.map((status) => ({
        id: status.id,
        name: status.name,
        sort: status.sort
      }))
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.listen(3000, () => {
  console.log("Сервер запущен: http://localhost:3000");
});
