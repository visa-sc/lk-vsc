// Отправка служебного статус-письма получателям из config.json (поле recipients).
// Использование: node notify.js "Тема" "Тело (текст или HTML)"
// Используется и человеком (статусы по ходу настройки), и монитором (старт/ошибки/heartbeat).
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const nodemailer = require("nodemailer");

const cfg = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, "config.json"), "utf8")); }
  catch (_) { return { recipients: [] }; }
})();
const to = (cfg.recipients && cfg.recipients.length ? cfg.recipients : ["anastasia.p@visa-sc.ru"]).join(",");
const subject = process.argv[2] || "VFS-бот: статус";
const body = process.argv[3] || "";

const mailer = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: +(process.env.SMTP_PORT || 587),
  secure: String(process.env.SMTP_PORT) === "465",
  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
});

mailer
  .sendMail({
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
    to,
    subject,
    html: body.trim().startsWith("<") ? body : "<p>" + body.replace(/\n/g, "<br>") + "</p>",
  })
  .then((i) => { console.log("OK sent →", to, i.messageId || ""); process.exit(0); })
  .catch((e) => { console.error("SEND ERROR:", e.message); process.exit(1); });
