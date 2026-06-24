// VFS · Франция — монитор слотов (Москва, туристическая виза, тип C).
//
// ⚠️⚠️ ЗАПУСКАТЬ ТОЛЬКО НА ОТДЕЛЬНОЙ МАШИНЕ — НЕ на проде VOYO (89.108.88.59) ⚠️⚠️
// Headless-браузер (Chromium) тяжёлый (CPU + 300 МБ–1 ГБ RAM на инстанс) и может
// дестабилизировать Node-процесс клиентского ЛК. Этот файл НИКАК не подключён к
// server.js и не запускается процессом `voyo`. См. README.md.
//
// Что уже готово (плумбинг): цикл опроса с джиттером, дедуп уведомлений,
// конфиг, письмо Насте при найденном слоте, аккуратный бэкофф на ошибки.
// Что нужно дореализовать на этапе с живым доступом (помечено TODO):
// вход в VFS + обход DataDome через 2captcha (+ прокси) + парсинг доступных дат.

require("dotenv").config();
const fs = require("fs");
const path = require("path");
const nodemailer = require("nodemailer");
// Подключим на этапе реализации (ставятся `npm i` ВНУТРИ vfs-bot/, не на проде):
// const { chromium } = require("playwright");
// const { Solver } = require("@2captcha/captcha-solver");

const CFG_FILE = path.join(__dirname, "config.json");
const STATE_FILE = path.join(__dirname, "state.json");
const POLL_MIN_MS = 2 * 60 * 1000; // 2 мин
const POLL_MAX_MS = 3 * 60 * 1000; // 3 мин (случайный джиттер в этом диапазоне)

// Портал VFS Франция (Россия) + цель. Точные URL шагов записи домаппим на живом входе.
const VFS_LOGIN_URL = "https://visa.vfsglobal.com/rus/en/fra/login";
const TARGET = { center: "Moscow", visaCategory: "Short Stay", subCategory: "Tourism" };

function loadJson(f, def) { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch (_) { return def; } }
function saveJson(f, o) { try { fs.writeFileSync(f, JSON.stringify(o, null, 2)); } catch (e) { console.error("save", f, e.message); } }

const mailer = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: +(process.env.SMTP_PORT || 465),
  secure: String(process.env.SMTP_PORT || "465") === "465",
  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
});

async function notify(recipients, client, slotInfo) {
  const to = (Array.isArray(recipients) && recipients.length ? recipients : ["anastasia.p@visa-sc.ru"]).join(",");
  const name = (String(client.firstName || "") + " " + String(client.lastName || "")).trim();
  const html =
    "<p>Появился <b>свободный слот</b> во французский визовый центр (Москва, туристическая виза, тип C).</p>" +
    "<p><b>Клиент:</b> " + name + "<br><b>Найдено:</b> " + (slotInfo || "детали — в кабинете VFS") +
    "<br><b>Окно записи клиента:</b> " + (client.dateFrom || "?") + " – " + (client.dateTo || "?") + "</p>" +
    "<p>Зайдите в кабинет VFS этого клиента и <b>завершите запись вручную как можно быстрее</b> — слоты разбирают за минуты.</p>";
  await mailer.sendMail({
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
    to,
    subject: "🟢 VFS Франция (Москва): свободный слот для " + name + " — записывайте!",
    html,
  });
}

// TODO (живой этап): реальная навигация VFS.
// Должна вернуть массив строк-слотов (дат) в окне записи клиента, иначе [].
async function checkSlotsForClient(/* client, browserCtx */) {
  // 1) chromium.launch({ proxy }) → context → page; page.goto(VFS_LOGIN_URL)
  // 2) ввести client.vfsLogin / client.vfsPassword
  // 3) при DataDome-капче — solver.datadome(...) (нужен прокси) → вставить токен/куку
  // 4) перейти к записи: TARGET.center / visaCategory / subCategory
  // 5) считать доступные даты, отфильтровать по [client.dateFrom..dateTo], вернуть найденное
  throw new Error("VFS-навигация не реализована: нужен живой доступ для маппинга шагов + 2captcha-ключ + прокси");
}

async function tick() {
  const cfg = loadJson(CFG_FILE, { clients: [], recipients: [] });
  const state = loadJson(STATE_FILE, {});
  // Мониторим только клиентов с логином/паролем и статусом «Мониторинг слотов»/«В работе»
  // (или cfg.monitorAll=true для теста).
  const active = (cfg.clients || []).filter((c) =>
    c.vfsLogin && c.vfsPassword && (cfg.monitorAll || c.status === "Мониторинг слотов" || c.status === "В работе"));
  if (!active.length) { console.log(new Date().toISOString(), "нет активных клиентов для мониторинга"); return; }
  for (const c of active) {
    try {
      const slots = await checkSlotsForClient(c);
      if (slots && slots.length) {
        const key = (c.passport || c.vfsLogin) + ":" + slots[0];
        if (!state[key]) {
          await notify(cfg.recipients, c, slots.join(", "));
          state[key] = Date.now(); saveJson(STATE_FILE, state);
          console.log(new Date().toISOString(), "✓ УВЕДОМЛЕНИЕ отправлено:", c.lastName, slots.join(", "));
        }
      } else {
        console.log(new Date().toISOString(), c.lastName, "— слотов нет");
      }
    } catch (e) {
      console.error(new Date().toISOString(), c.lastName, "— ошибка:", e.message);
    }
  }
}

(async function loop() {
  console.log("VFS-монитор запущен. Цель:", JSON.stringify(TARGET));
  for (;;) {
    await tick();
    const wait = POLL_MIN_MS + Math.floor(Math.random() * (POLL_MAX_MS - POLL_MIN_MS));
    await new Promise((r) => setTimeout(r, wait));
  }
})();
