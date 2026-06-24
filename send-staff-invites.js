// Разовая (идемпотентная) рассылка пригласительных писем сотрудникам.
// Запускается по cron (0 10 * * * МСК). Каждое письмо отправляется ОДИН раз
// (маркер .staffInvitesSent.json). Письма с ready:false пропускаются —
// включить, когда доступ будет готов (напр. Плинер — после vsc-входа).
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const mail = require("./mail");

const SENT_FILE = path.join(__dirname, ".staffInvitesSent.json");
function loadSent() { try { return JSON.parse(fs.readFileSync(SENT_FILE, "utf8")) || {}; } catch (_) { return {}; } }
function saveSent(s) { try { fs.writeFileSync(SENT_FILE, JSON.stringify(s, null, 2)); } catch (e) { console.error("saveSent:", e.message); } }

function shell(inner, accent, footer) {
  accent = accent || "#3589BD";
  footer = footer || "Служебное письмо для сотрудников VOYO. Отвечать на него не нужно.<br>С уважением, команда VOYO · Visa Services Center";
  return '<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0;padding:24px 12px;background:#eef1f5;">' +
    '<div style="max-width:600px;margin:0 auto;background:#fff;border-radius:14px;overflow:hidden;border:1px solid #e6e9f0;font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#1d2330;">' +
    '<div style="height:4px;background:' + accent + ';"></div>' +
    '<div style="text-align:center;padding:24px 24px 6px;"><img src="https://voyotravel.ru/logo.png" alt="VOYO" width="150" style="width:150px;height:auto;max-width:55%;"/></div>' +
    '<div style="padding:10px 32px 26px;line-height:1.55;font-size:15px;">' + inner + '</div>' +
    '<div style="background:#f7f9fc;border-top:1px solid #eef0f4;padding:16px 32px;font-size:12px;color:#8a93a3;line-height:1.5;">' + footer + '</div>' +
    '</div></body></html>';
}

function rustamTeamInvite() {
  const inner =
    '<p style="margin:0 0 14px;">Привет, Рустам!</p>' +
    '<p style="margin:0 0 16px;">Тебе открыт доступ в <b>панель управления клиентским ЛК VOYO</b> — рабочее пространство, где команда контролирует и улучшает то, что видит клиент в личном кабинете.</p>' +
    '<div style="font-size:13px;color:#6b7280;text-transform:uppercase;letter-spacing:.5px;margin:0 0 8px;">Что внутри</div>' +
    '<div style="font-size:14px;line-height:1.7;margin:0 0 18px;">' +
      '<div><span style="color:#3589BD;font-weight:700;">✓</span> Корректировки ЛК — заявки на доработки и их статусы</div>' +
      '<div><span style="color:#3589BD;font-weight:700;">✓</span> Тестировщик ЛК и «Экраны клиента» — что видит клиент на каждом этапе</div>' +
      '<div><span style="color:#3589BD;font-weight:700;">✓</span> Запрос документов, Опросники (логика), Области загрузки</div>' +
      '<div><span style="color:#3589BD;font-weight:700;">✓</span> Действия — что ЛК делает в amoCRM, Я.Диске, SMS</div>' +
      '<div><span style="color:#3589BD;font-weight:700;">✓</span> Логи ЛК, Вход в ЛК клиента, Заявители, База знаний</div>' +
    '</div>' +
    '<div style="background:#eef5fb;border-left:4px solid #3589BD;border-radius:8px;padding:14px 16px;margin:0 0 18px;font-size:14px;line-height:1.7;">' +
      '<div style="color:#6b7280;font-size:12px;margin-bottom:4px;">Как войти</div>' +
      'Адрес: <b>dev.voyotravel.ru</b><br>Логин: <b>rustam.b@visa-sc.ru</b><br>' +
      'Пароль ты придумаешь сам при первом входе (не короче 6 символов).<br>' +
      'Можно включить вход по <b>Face ID / Touch ID</b>, а пароль при необходимости — восстановить по ссылке на эту почту.' +
    '</div>' +
    '<p style="margin:0 0 8px;"><a href="https://dev.voyotravel.ru" style="display:inline-block;background:#3589BD;color:#fff;text-decoration:none;font-weight:600;font-size:15px;padding:13px 26px;border-radius:10px;">Войти в панель</a></p>';
  return shell(inner, "#3589BD");
}

function plinnerBotInvite() {
  const inner =
    '<p style="margin:0 0 14px;">Привет, Анастасия!</p>' +
    '<p style="margin:0 0 16px;">Тебе открыт доступ к дашборду <b>VSC</b> — там для тебя доступны «Калькулятор ВНЖ» и раздел <b>«Бот VFS · Франция»</b>.</p>' +
    '<p style="margin:0 0 16px;">Мы начали пробовать разработать <b>бота для автоматической записи на визу во Францию</b> (VFS): он будет сам мониторить свободные слоты и записывать клиентов. Чтобы двигаться дальше и протестировать запись, нужны реальные данные клиентов для предзагрузки — для начала достаточно завести <b>одного клиента на тест</b>.</p>' +
    '<div style="background:#eef1f8;border-left:4px solid #1d2b4f;border-radius:8px;padding:14px 16px;margin:0 0 18px;font-size:14px;line-height:1.7;">' +
      '<div style="color:#6b7280;font-size:12px;margin-bottom:6px;">Что заполнить по клиенту (раздел «Бот VFS»)</div>' +
      'Имя и фамилия (латиницей), дата рождения, гражданство, номер и срок действия загранпаспорта, телефон, почта, желаемый диапазон дат записи.' +
    '</div>' +
    '<div style="background:#eef1f8;border-left:4px solid #1d2b4f;border-radius:8px;padding:14px 16px;margin:0 0 18px;font-size:14px;line-height:1.7;">' +
      '<div style="color:#6b7280;font-size:12px;margin-bottom:4px;">Как войти</div>' +
      'Адрес: <b>vsc.voyotravel.ru</b><br>Логин: <b>anastasia.p@visa-sc.ru</b><br>' +
      'Пароль придумаешь при первом входе (не короче 6 символов); можно включить <b>Face ID / Touch ID</b>, пароль — восстановить по почте.' +
    '</div>' +
    '<p style="margin:0 0 8px;"><a href="https://vsc.voyotravel.ru" style="display:inline-block;background:#1d2b4f;color:#fff;text-decoration:none;font-weight:600;font-size:15px;padding:13px 26px;border-radius:10px;">Открыть «Бот VFS»</a></p>';
  return shell(inner, "#1d2b4f");
}

const INVITES = [
  { key: "rustam-team-2026-06", to: "rustam.b@visa-sc.ru", subject: "Доступ в панель управления ЛК VOYO", html: rustamTeamInvite(), ready: true },
  // Вход руководителей на vsc готов (23.06) → Плинер включена в рассылку.
  { key: "plinner-bot-2026-06", to: "anastasia.p@visa-sc.ru", subject: "Бот VFS · Франция — нужны данные для теста", html: plinnerBotInvite(), ready: true }
];

async function runInvites() {
  const sent = loadSent();
  const stamp = new Date().toISOString();
  for (const inv of INVITES) {
    if (!inv.ready) { console.log(stamp, "skip (not ready):", inv.key); continue; }
    if (sent[inv.key]) { console.log(stamp, "already sent:", inv.key); continue; }
    const r = await mail.sendMail({ to: inv.to, subject: inv.subject, html: inv.html });
    console.log(stamp, inv.key, "→", inv.to, JSON.stringify(r));
    if (r.ok) { sent[inv.key] = { at: stamp, to: inv.to, id: r.id }; saveSent(sent); }
  }
}

// Экспортируем билдеры писем, чтобы можно было переслать точные копии (напр. director@).
module.exports = { shell, rustamTeamInvite, plinnerBotInvite, INVITES, runInvites };

// Рассылка запускается ТОЛЬКО при прямом запуске (cron), не при require().
if (require.main === module) {
  runInvites().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
}
