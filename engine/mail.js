// Почта движка — шим: письма отправляет основное приложение (:3000), у которого
// есть SMTP-доступ. Сюда ключи почты не кладём. Интерфейс тот же, что у mail.js
// основного приложения: sendMail({to, subject, text, html, replyTo}) → {ok, id|error}.
const axios = require("axios");
const MAIN = process.env.MAIN_URL || "http://127.0.0.1:3000";

async function sendMail(opts) {
  try {
    const r = await axios.post(MAIN + "/internal/engine/mail", opts || {}, {
      headers: { "x-engine-secret": process.env.ENGINE_SECRET || "" }, timeout: 30000,
    });
    return r.data || { ok: false, error: "пустой ответ основного приложения" };
  } catch (e) {
    return { ok: false, error: (e.response && e.response.data && e.response.data.error) || e.message };
  }
}

module.exports = { sendMail };
