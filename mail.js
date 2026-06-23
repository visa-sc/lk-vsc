// Отправка писем через SMTP (mail.ru для домена voyotravel.ru).
// Конфиг из .env: SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM.
// Используется для служебных писем сотрудникам (корректировки, приглашения).
const nodemailer = require("nodemailer");

let _t = null;
function transporter() {
  if (_t) return _t;
  const host = process.env.SMTP_HOST;
  const port = parseInt(process.env.SMTP_PORT || "465", 10);
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  if (!host || !user || !pass) return null;
  _t = nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: { user, pass }
  });
  return _t;
}

// sendMail({to, subject, html, text?, replyTo?}) → {ok:true,id} | {ok:false,error}
async function sendMail(opts) {
  const t = transporter();
  if (!t) return { ok: false, error: "SMTP не сконфигурирован" };
  const from = process.env.SMTP_FROM || process.env.SMTP_USER;
  try {
    const info = await t.sendMail({
      from: '"VOYO" <' + from + '>',
      to: opts.to,
      subject: opts.subject,
      html: opts.html,
      text: opts.text || undefined,
      replyTo: opts.replyTo || undefined
    });
    return { ok: true, id: info && info.messageId };
  } catch (e) {
    return { ok: false, error: e && e.message };
  }
}

module.exports = { sendMail };
