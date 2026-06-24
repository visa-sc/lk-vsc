// Закрытие корректировки(ок) в «Реализовано» при ПРЯМОЙ правке данных + отправка
// автору-руководителю штатного письма «корректировка выполнена» (тот же шаблон,
// что и кнопка статуса в /admin). Нужен, потому что прямая правка .lkCorrections.json
// в обход API писем не шлёт.
//
// Запуск из каталога приложения (/var/www/voyo):
//   node tools/correctionDone.js <id> [<id> ...] [--comment "что сделано"] [--no-status] [--to email]
//     --comment    добавить комментарий от «Андрей Комисаренко» (текст «Что сделано»)
//     --no-status  не менять данные (только отправить письмо по уже закрытой заявке)
//     --to <email> отправить ТО ЖЕ письмо на указанный адрес (копия для проверки),
//                  вместо автора-руководителя (напр. дублировать на director@visa-sc.ru)
//
// ВАЖНО: шаблон письма ниже — ЗЕРКАЛО server.js (emailDoc / correctionDoneEmailHtml /
// escapeHtml). При изменении шаблона в server.js синхронизировать и здесь.
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });
const fs = require("fs");
const mail = require(path.join(__dirname, "..", "mail"));

const F = path.join(__dirname, "..", ".lkCorrections.json");

function escapeHtml(value = "") {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function emailDoc(inner, accent, footer) {
  accent = accent || "#3589BD";
  footer = footer || 'Служебное письмо для сотрудников VOYO. Отвечать на него не нужно.<br>С уважением, команда VOYO · Visa Services Center';
  return '<!doctype html><html><head><meta charset="utf-8"></head>' +
    '<body style="margin:0;padding:24px 12px;background:#eef1f5;">' +
    '<div style="max-width:600px;margin:0 auto;background:#ffffff;border-radius:14px;overflow:hidden;border:1px solid #e6e9f0;font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#1d2330;">' +
    '<div style="height:4px;background:' + accent + ';"></div>' +
    '<div style="text-align:center;padding:24px 24px 6px;"><img src="https://voyotravel.ru/logo.png" alt="VOYO" width="150" style="width:150px;height:auto;max-width:55%;" /></div>' +
    '<div style="padding:10px 32px 26px;line-height:1.55;font-size:15px;">' + inner + '</div>' +
    '<div style="background:#f7f9fc;border-top:1px solid #eef0f4;padding:16px 32px;font-size:12px;color:#8a93a3;line-height:1.5;">' + footer + '</div>' +
    '</div></body></html>';
}

function correctionDoneEmailHtml(name, it) {
  const e = escapeHtml;
  const comments = Array.isArray(it.comments) ? it.comments : [];
  const lastComment = comments.length ? (comments[comments.length - 1].text || "") : "";
  const done = (it.note && String(it.note).trim()) ? it.note : (lastComment || "Готово.");
  const inner =
    '<p style="margin:0 0 14px;">Привет, ' + e(String(name || "").trim().split(/\s+/)[0]) + '!</p>' +
    '<p style="margin:0 0 16px;"><span style="display:inline-block;background:#e7f6ec;color:#1f7a3d;font-weight:600;font-size:13px;padding:5px 12px;border-radius:20px;">✓ Корректировка выполнена</span></p>' +
    '<p style="margin:0 0 16px;">Твоя корректировка по личному кабинету клиента выполнена и уже работает на боевом сайте.</p>' +
    '<div style="background:#eef5fb;border-left:4px solid #3589BD;border-radius:8px;padding:14px 16px;margin:0 0 16px;font-size:14px;">' +
      '<div style="color:#6b7280;font-size:12px;margin-bottom:3px;">Корректировка</div>' +
      '<div style="margin-bottom:12px;">' + e(it.what || "") + '</div>' +
      '<div style="color:#6b7280;font-size:12px;margin-bottom:3px;">Что сделано</div>' +
      '<div>' + e(done) + '</div>' +
    '</div>' +
    '<p style="margin:0 0 22px;">Посмотреть все твои корректировки и статусы можно в панели:</p>' +
    '<p style="margin:0 0 8px;"><a href="https://dev.voyotravel.ru" style="display:inline-block;background:#3589BD;color:#ffffff;text-decoration:none;font-weight:600;font-size:15px;padding:13px 26px;border-radius:10px;">Открыть панель ЛК</a></p>';
  return emailDoc(inner, "#3589BD", 'Это автоматическое уведомление — отвечать на него не нужно.<br>С уважением, команда VOYO · Visa Services Center');
}

(async () => {
  const args = process.argv.slice(2);
  const ids = [];
  let comment = "";
  let noStatus = false;
  let toOverride = "";
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--comment") comment = args[++i] || "";
    else if (args[i] === "--no-status") noStatus = true;
    else if (args[i] === "--to") toOverride = args[++i] || "";
    else ids.push(args[i]);
  }
  if (!ids.length) { console.error("Укажи id корректировки (см. .lkCorrections.json)"); process.exit(2); }

  const a = JSON.parse(fs.readFileSync(F, "utf8"));
  const today = new Date().toISOString().slice(0, 10);
  const now = Date.now();
  let changed = false;

  for (const id of ids) {
    const it = a.find((x) => x && x.id === id);
    if (!it) { console.log("НЕ НАЙДЕНО:", id); continue; }
    if (!noStatus) {
      if (it.status !== "done") { it.status = "done"; changed = true; }
      if (!it.resolvedAt) { it.resolvedAt = today; changed = true; }
      if (comment) {
        if (!Array.isArray(it.comments)) it.comments = [];
        it.comments.push({ ts: now, author: "Андрей Комисаренко", text: comment });
        changed = true;
      }
    }
    const cb = it.createdBy || {};
    const recipient = toOverride || ((cb.role === "manager" && cb.email) ? cb.email : "");
    if (recipient) {
      const r = await mail.sendMail({
        to: recipient,
        subject: "Твоя корректировка по ЛК выполнена",
        html: correctionDoneEmailHtml(cb.name, it),
      });
      console.log("письмо →", recipient, "(" + id + "):", r.ok ? ("OK " + (r.id || "")) : ("FAIL " + r.error));
    } else {
      console.log("письмо НЕ отправлено (нет получателя — ни --to, ни manager-email):", id, JSON.stringify(cb));
    }
  }

  if (changed) {
    fs.writeFileSync(F, JSON.stringify(a, null, 2), "utf8");
    console.log("файл .lkCorrections.json сохранён — НУЖЕН pm2 restart voyo, чтобы сервер перечитал.");
  } else {
    console.log("данные не менялись (рестарт не нужен).");
  }
})();
