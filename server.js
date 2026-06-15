require("dotenv").config();

const express = require("express");
const path = require("path");
const fs = require("fs");
const os = require("os");
const axios = require("axios");
const multer = require("multer");
const PDFDocument = require("pdfkit");
const crypto = require("crypto");
const archiver = require("archiver");
const AdmZip = require("adm-zip");
const iconv = require("iconv-lite");
const sms = require("./sms");

const app = express();
const PORT = process.env.PORT || 3000;

app.use((req, res, next) => {
  console.log("REQUEST:", req.method, req.path, req.query || {});
  next();
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));

app.get("/cabinet", (req, res) => {
  // no-cache: правки UX/блоков ЛК идут пачкой, нельзя чтобы клиент
  // смотрел вчерашнюю закэшированную версию (как было с pre-applicants).
  res.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.set("Pragma", "no-cache");
  res.set("Expires", "0");
  res.sendFile(path.join(__dirname, "public", "cabinet.html"));
});

app.get("/search", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "search.html"));
});

// ──────────────────────────────────────────────────────────
// ТРАФИК с лендингов (/welcome*): визиты (в т.ч. переходы с Яндекс.Директа)
// и конверсии. Конверсия = уникальная регистрация в ЛК (новая авторизация +
// создание нового контакта в amoCRM — оба действия в одном /api/auth/register).
// Лёгкая серверная аналитика: дневные агрегаты в JSON + дебаунс-сохранение.
// Атрибуция к лендингу/источнику — через cookie voyo_src, выставляемую при визите.
// ──────────────────────────────────────────────────────────
const TRAFFIC_FILE = path.join(__dirname, ".trafficStats.json");
const TRAFFIC_PAGES = ["welcome", "welcome_schengen", "welcome_japan"];
const trafficStats = { visits: {}, conversions: {}, convertedPhones: [] };
const _trafficConvertedSet = new Set();

function loadTrafficStats() {
  try {
    const obj = JSON.parse(fs.readFileSync(TRAFFIC_FILE, "utf8"));
    if (obj && typeof obj === "object") {
      trafficStats.visits = obj.visits || {};
      trafficStats.conversions = obj.conversions || {};
      (Array.isArray(obj.convertedPhones) ? obj.convertedPhones : []).forEach((p) => _trafficConvertedSet.add(p));
    }
  } catch (_) {}
}
let _trafficSaveTimer = null;
function saveTrafficStats() {
  if (_trafficSaveTimer) return; // дебаунс — не чаще раза в 5с
  _trafficSaveTimer = setTimeout(() => {
    _trafficSaveTimer = null;
    try {
      trafficStats.convertedPhones = Array.from(_trafficConvertedSet);
      fs.writeFileSync(TRAFFIC_FILE, JSON.stringify(trafficStats), "utf8");
    } catch (e) { console.error("saveTrafficStats error:", e.message); }
  }, 5000);
}
function trafficDayKey(ts) {
  const d = new Date((ts || Date.now()) + 3 * 3600 * 1000); // МСК (UTC+3)
  return d.toISOString().slice(0, 10);
}
function isYandexDirectReq(req) {
  const q = (req && req.query) || {};
  if (q.yclid) return true; // автометка Яндекс.Директа — самый надёжный сигнал
  const src = String(q.utm_source || "").toLowerCase();
  if (src.includes("yandex") || src.includes("direct")) return true;
  // Фолбэк: реферер с доменов Яндекса. Лендинги /welcome* — посадочные под
  // рекламу (органических ссылок на них нет), поэтому переход с yandex.* почти
  // наверняка = Яндекс.Директ. Ловит клики, где yclid не проставлен.
  const ref = String((req && req.headers && req.headers.referer) || "").toLowerCase();
  if (/(?:\/\/|\.)yandex\.[a-z]/.test(ref) || ref.includes("yabs.") || ref.includes("an.yandex")) return true;
  return false;
}
function parseTrafficCookie(req) {
  const m = String((req && req.headers && req.headers.cookie) || "").match(/(?:^|;\s*)voyo_src=([^;]+)/);
  if (!m) return null;
  try {
    const val = decodeURIComponent(m[1]);
    const dot = val.lastIndexOf(".");
    if (dot < 0) return null;
    const page = val.slice(0, dot);
    if (!TRAFFIC_PAGES.includes(page)) return null;
    return { page, yd: val.slice(dot + 1) === "1" };
  } catch (_) { return null; }
}
function recordLandingVisit(page, yd) {
  if (!TRAFFIC_PAGES.includes(page)) return;
  const key = trafficDayKey();
  const day = trafficStats.visits[key] || (trafficStats.visits[key] = {});
  const pv = day[page] || (day[page] = { total: 0, yd: 0 });
  pv.total++; if (yd) pv.yd++;
  saveTrafficStats();
}
function recordTrafficConversion(normPhone, attr) {
  if (normPhone) {
    if (_trafficConvertedSet.has(normPhone)) return; // уникальность по номеру
    _trafficConvertedSet.add(normPhone);
  }
  const key = trafficDayKey();
  const c = trafficStats.conversions[key] || (trafficStats.conversions[key] = { total: 0, yd: 0, byPage: {} });
  c.total++;
  if (attr && attr.yd) c.yd++;
  if (attr && TRAFFIC_PAGES.includes(attr.page)) c.byPage[attr.page] = (c.byPage[attr.page] || 0) + 1;
  saveTrafficStats();
  console.log(`TRAFFIC conversion: total=${c.total} yd=${c.yd} page=${(attr && attr.page) || "-"}`);
}
function aggregateTraffic() {
  const visits = {}; TRAFFIC_PAGES.forEach((p) => { visits[p] = { total: 0, yd: 0 }; });
  Object.values(trafficStats.visits || {}).forEach((day) => {
    TRAFFIC_PAGES.forEach((p) => { if (day[p]) { visits[p].total += day[p].total || 0; visits[p].yd += day[p].yd || 0; } });
  });
  let vt = 0, vy = 0; TRAFFIC_PAGES.forEach((p) => { vt += visits[p].total; vy += visits[p].yd; });
  const conv = { total: 0, yd: 0, byPage: {} }; TRAFFIC_PAGES.forEach((p) => { conv.byPage[p] = 0; });
  Object.values(trafficStats.conversions || {}).forEach((day) => {
    conv.total += day.total || 0; conv.yd += day.yd || 0;
    if (day.byPage) TRAFFIC_PAGES.forEach((p) => { conv.byPage[p] += day.byPage[p] || 0; });
  });
  return { pages: TRAFFIC_PAGES, visits, visitsAll: { total: vt, yd: vy }, conversions: conv };
}
loadTrafficStats();

function serveLanding(page, file) {
  return (req, res) => {
    res.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
    res.set("Pragma", "no-cache");
    res.set("Expires", "0");
    try {
      const yd = isYandexDirectReq(req);
      recordLandingVisit(page, yd);
      // cookie атрибуции: переживёт переход на «/» и регистрацию (последний клик).
      res.cookie("voyo_src", page + "." + (yd ? "1" : "0"), { maxAge: 30 * 24 * 3600 * 1000, httpOnly: true, sameSite: "lax", path: "/" });
    } catch (e) { console.error("serveLanding track error:", e.message); }
    res.sendFile(path.join(__dirname, "public", file));
  };
}

app.get("/about", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "about.html"));
});

// Лендинги под Яндекс.Директ (+ трекинг визитов и источника). no-cache.
app.get("/welcome", serveLanding("welcome", "welcome.html"));
app.get("/welcome_schengen", serveLanding("welcome_schengen", "welcome_schengen.html"));
app.get("/welcome_japan", serveLanding("welcome_japan", "welcome_japan.html"));

// Резервные (старые) версии лендингов — на случай отката оффера. Без трекинга
// трафика (это не рекламные посадочные), no-cache как и у основных.
function serveStaticNoCache(file) {
  return (req, res) => {
    res.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
    res.set("Pragma", "no-cache");
    res.set("Expires", "0");
    res.sendFile(path.join(__dirname, "public", file));
  };
}
app.get("/welcome_old", serveStaticNoCache("welcome_old.html"));
app.get("/welcome_schengen_old", serveStaticNoCache("welcome_schengen_old.html"));
app.get("/welcome_japan_old", serveStaticNoCache("welcome_japan_old.html"));

app.get("/about/v1", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "about-v1.html"));
});

app.get(["/admin", "/team", "/vsc"], (req, res) => {
  // Не кешируем — админка часто меняется, не хочется получать stale HTML/CSS
  // в Safari/Chrome (особенно на iOS). Снимаем и ETag, чтобы не возвращался 304.
  // /team — портал руководителей; /vsc — отдельный VSC-дашборд (тот же файл,
  // вход как в админку по коду, своя вывеска VSC, показывается только дашборд).
  res.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.set("Pragma", "no-cache");
  res.set("Expires", "0");
  const adminFile = path.join(__dirname, "public", "admin.html");
  // Только для /vsc вставляем в <head> ссылку на apple-touch-icon = логотип VSC.
  // iOS «Добавить на экран» читает иконку из HTML страницы → у /vsc будет VSC.
  // Остальные страницы (/admin, /team и весь сайт) HTML не меняют и продолжают
  // использовать корневой /apple-touch-icon.png (VOYO) — их иконка не затрагивается.
  if (String(req.path || "").replace(/\/+$/, "") === "/vsc") {
    try {
      const html = fs.readFileSync(adminFile, "utf8")
        .replace("</head>", '<link rel="apple-touch-icon" href="/vsc-logo.png">\n<link rel="apple-touch-icon" sizes="180x180" href="/vsc-logo.png">\n</head>');
      res.set("Content-Type", "text/html; charset=utf-8");
      return res.send(html);
    } catch (e) { /* при сбое — отдаём как есть ниже */ }
  }
  res.sendFile(adminFile, { etag: false, lastModified: false });
});

// ──────────────────────────────────────────────────────────
// SMS-аутентификация (спящий режим). Включается флагом SMS_AUTH_ENABLED=true.
// Пока флаг false — эндпоинты возвращают 404, чтобы внешне ничего не светилось.
// ──────────────────────────────────────────────────────────

const smsCodeStore = new Map(); // phone(E.164 без +) -> { code, expiresAt, attempts, lastSentAt }
const SMS_CODE_TTL_MS = 5 * 60 * 1000; // 5 минут
const SMS_RESEND_COOLDOWN_MS = 60 * 1000; // 60 секунд
const SMS_MAX_ATTEMPTS = 5;

// ─── Rate limits ───────────────────────────────────────────
// Защита sms.ru-баланса и от перебора служебного кода.
// Все счётчики живут в памяти процесса — при рестарте сбрасываются.
// Для текущей нагрузки этого достаточно; persistent-хранение можно прикрутить позже.
const MS_10MIN = 10 * 60 * 1000;
const MS_1H = 60 * 60 * 1000;
const MS_24H = 24 * 60 * 60 * 1000;

const SMS_LIMIT_PER_PHONE_10MIN = 3;     // <= 3 SMS в 10 мин на номер
const SMS_LIMIT_PER_PHONE_1H = 5;        // <= 5 SMS в час на номер (значит после 3 в 10 мин — ещё максимум 2 за 50 мин)
const SMS_LIMIT_PER_PHONE_24H = 15;      // <= 15 SMS в сутки на номер
const SMS_LIMIT_PER_IP_24H = 15;         // <= 15 SMS в сутки с одного IP

const STAFF_BYPASS_CODE = (process.env.STAFF_BYPASS_CODE || "111");
const STAFF_BYPASS_FAIL_LIMIT_24H = 15;  // <= 15 неудачных попыток ввода служебного кода в сутки с одного IP

// История отправок SMS: ключ → массив timestamp'ов
const smsSendHistory = new Map();
// История неудачных попыток ввода служебного кода: IP → массив timestamp'ов
const staffBypassFailHistory = new Map();

function getClientIp(req) {
  const xff = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  return xff || req.ip || (req.connection && req.connection.remoteAddress) || "unknown";
}

function pruneHistory(store, key, cutoffMs) {
  const list = store.get(key) || [];
  const cutoff = Date.now() - cutoffMs;
  const fresh = list.filter((t) => t >= cutoff);
  if (fresh.length !== list.length) {
    if (fresh.length === 0) store.delete(key);
    else store.set(key, fresh);
  }
  return fresh;
}

function formatWait(sec) {
  if (sec >= 3600) return `${Math.ceil(sec / 3600)} ч`;
  if (sec >= 60) return `${Math.ceil(sec / 60)} мин`;
  return `${Math.max(1, sec)} с`;
}

function checkSmsRateLimit(phone, ip) {
  // Возвращает { ok: true } или { ok: false, message, retryAfterSec }
  const phoneKey = `p:${phone}`;
  const ipKey = `i:${ip}`;
  const phoneHist = pruneHistory(smsSendHistory, phoneKey, MS_24H);
  const ipHist = pruneHistory(smsSendHistory, ipKey, MS_24H);
  const now = Date.now();

  const in10min = phoneHist.filter((t) => t >= now - MS_10MIN);
  if (in10min.length >= SMS_LIMIT_PER_PHONE_10MIN) {
    const oldest = in10min[0];
    const wait = Math.ceil((oldest + MS_10MIN - now) / 1000);
    return { ok: false, retryAfterSec: wait, message: `Слишком много запросов SMS. Попробуйте через ${formatWait(wait)}.` };
  }
  const in1h = phoneHist.filter((t) => t >= now - MS_1H);
  if (in1h.length >= SMS_LIMIT_PER_PHONE_1H) {
    const oldest = in1h[0];
    const wait = Math.ceil((oldest + MS_1H - now) / 1000);
    return { ok: false, retryAfterSec: wait, message: `Превышен часовой лимит SMS на этот номер. Попробуйте через ${formatWait(wait)}.` };
  }
  if (phoneHist.length >= SMS_LIMIT_PER_PHONE_24H) {
    return { ok: false, retryAfterSec: 24 * 3600, message: "Превышен суточный лимит SMS на этот номер. Попробуйте завтра." };
  }
  if (ipHist.length >= SMS_LIMIT_PER_IP_24H) {
    return { ok: false, retryAfterSec: 24 * 3600, message: "Превышен суточный лимит SMS с вашего устройства. Попробуйте завтра." };
  }
  return { ok: true };
}

function recordSmsSent(phone, ip) {
  const phoneKey = `p:${phone}`;
  const ipKey = `i:${ip}`;
  const now = Date.now();
  smsSendHistory.set(phoneKey, [...(smsSendHistory.get(phoneKey) || []), now]);
  smsSendHistory.set(ipKey, [...(smsSendHistory.get(ipKey) || []), now]);
}

function checkStaffBypassRateLimit(ip) {
  const key = ip;
  const hist = pruneHistory(staffBypassFailHistory, key, MS_24H);
  if (hist.length >= STAFF_BYPASS_FAIL_LIMIT_24H) {
    return { ok: false, message: "Слишком много неудачных попыток. Попробуйте через сутки." };
  }
  return { ok: true };
}

function recordStaffBypassFail(ip) {
  const key = ip;
  staffBypassFailHistory.set(key, [...(staffBypassFailHistory.get(key) || []), Date.now()]);
}

function smsGate(req, res, next) {
  if (!sms.isEnabled()) {
    return res.status(404).send("Not found");
  }
  next();
}

app.post("/api/auth/has-leads", async (req, res) => {
  try {
    const phone = sms.normalizePhone((req.body && req.body.phone) || "");
    if (!phone || phone.length < 11) {
      return res.status(400).json({ success: false, message: "Некорректный номер телефона" });
    }
    if (!AMO_SUBDOMAIN || !AMO_ACCESS_TOKEN) {
      return res.status(500).json({ success: false, message: "Не настроены переменные amoCRM" });
    }
    const leads = await getLeadsByPhone(phone);
    return res.json({ success: true, hasLeads: Array.isArray(leads) && leads.length > 0 });
  } catch (err) {
    console.error("HAS-LEADS ERROR:", err.message);
    // Не блокируем поток — если проверка упала, пусть SMS уйдёт по обычному пути
    return res.status(500).json({ success: false, message: "Ошибка проверки" });
  }
});

// Регистрация нового клиента: создание контакта + сделки в воронке «Отдел продаж»,
// статус «Ещё не связывались». Опционально — закреплённый комментарий при валидном промокоде.
// Промокоды → размер скидки в %. Текст комментария формируется единообразно.
const PROMO_CODES = {
  "10OFFBRO": 10,
  "15OFFBRO": 15,
  "20OFFBRO": 20,
  "WELCOME": 10
};
function promoCommentText(percent, code) {
  // Промокод WELCOME (лендинги /welcome*) — отдельный текст комментария.
  if (String(code || "").toUpperCase() === "WELCOME") {
    return "Скидка -10% на услуги по промокоду WELCOME при регистрации в VOYO.";
  }
  return `-${percent}% скидка на услуги от Андрея К. Можно перекрыть сертификатом.`;
}

// Создание новой сделки для УЖЕ АВТОРИЗОВАННОГО клиента (из кабинета по кнопке
// «Новое обращение»). По логике аналогично /api/auth/register, но без промо
// (комментарий со скидкой не пишется).
app.post("/api/leads/new", async (req, res) => {
  try {
    const phone = sms.normalizePhone((req.body && req.body.phone) || "");
    if (!phone || phone.length < 11) {
      return res.status(400).json({ success: false, message: "Некорректный номер телефона" });
    }
    if (!AMO_SUBDOMAIN || !AMO_ACCESS_TOKEN) {
      return res.status(500).json({ success: false, message: "Не настроены переменные amoCRM" });
    }
    const result = await createAmoContactAndLeadForRegistration(phone, {
      promoApplied: false,
      promoText: ""
    });
    return res.json({
      success: true,
      contactId: result.contactId,
      leadId: result.leadId
    });
  } catch (err) {
    console.error("POST /api/leads/new error:", err.response?.data || err.message);
    return res.status(500).json({
      success: false,
      message: "Не удалось создать новое обращение. Попробуйте позже."
    });
  }
});

app.post("/api/auth/register", async (req, res) => {
  try {
    const phone = sms.normalizePhone((req.body && req.body.phone) || "");
    const promoCodeRaw = String((req.body && req.body.promoCode) || "").trim().toUpperCase();
    if (!phone || phone.length < 11) {
      return res.status(400).json({ success: false, message: "Некорректный номер телефона" });
    }
    if (!AMO_SUBDOMAIN || !AMO_ACCESS_TOKEN) {
      return res.status(500).json({ success: false, message: "Не настроены переменные amoCRM" });
    }
    const promoPercent = Object.prototype.hasOwnProperty.call(PROMO_CODES, promoCodeRaw)
      ? PROMO_CODES[promoCodeRaw]
      : 0;
    const promoApplied = promoPercent > 0;
    const result = await createAmoContactAndLeadForRegistration(phone, {
      promoApplied,
      promoText: promoApplied ? promoCommentText(promoPercent, promoCodeRaw) : ""
    });
    // Трафик: конверсия = уникальная регистрация (новая авторизация + новый
    // контакт в amoCRM). Атрибуция к лендингу/источнику — из cookie voyo_src.
    try { recordTrafficConversion(phone, parseTrafficCookie(req)); } catch (_) {}
    return res.json({
      success: true,
      contactId: result.contactId,
      leadId: result.leadId,
      promoApplied,
      promoPercent
    });
  } catch (err) {
    console.error("REGISTER ERROR:", err.response?.data || err.message);
    return res.status(500).json({
      success: false,
      message: "Не удалось зарегистрировать. Попробуйте позже."
    });
  }
});

app.post("/api/auth/request-code", smsGate, async (req, res) => {
  try {
    const phone = sms.normalizePhone((req.body && req.body.phone) || "");
    if (!phone || phone.length < 11) {
      return res.status(400).json({ success: false, message: "Некорректный номер телефона" });
    }

    const ip = getClientIp(req);
    const rateLimit = checkSmsRateLimit(phone, ip);
    if (!rateLimit.ok) {
      console.log(`SMS RATE LIMIT: phone=${phone} ip=${ip} → ${rateLimit.message}`);
      return res.status(429).json({ success: false, message: rateLimit.message, retryAfterSec: rateLimit.retryAfterSec });
    }

    const existing = smsCodeStore.get(phone);
    if (existing && Date.now() - (existing.lastSentAt || 0) < SMS_RESEND_COOLDOWN_MS) {
      const wait = Math.ceil((SMS_RESEND_COOLDOWN_MS - (Date.now() - existing.lastSentAt)) / 1000);
      return res.status(429).json({ success: false, message: `Подождите ${wait} с перед повторной отправкой` });
    }

    const code = sms.generateCode();
    const result = await sms.sendCode(phone, code);

    if (!result.ok) {
      return res.status(502).json({ success: false, message: result.error || "Не удалось отправить SMS" });
    }

    // Учитываем в лимитах только успешно ушедшую SMS — чтобы ошибки sms.ru
    // не сжигали клиенту его квоту 3/10мин и 5/час.
    recordSmsSent(phone, ip);

    smsCodeStore.set(phone, {
      code,
      expiresAt: Date.now() + SMS_CODE_TTL_MS,
      attempts: 0,
      lastSentAt: Date.now(),
    });

    return res.json({ success: true, testMode: !!result.testMode });
  } catch (err) {
    console.error("REQUEST CODE ERROR:", err);
    return res.status(500).json({ success: false, message: "Внутренняя ошибка" });
  }
});

// Серверная проверка служебного «обходного» кода входа.
// Раньше код хардкодился в HTML — каждый, кто открыл DevTools, видел его.
// Теперь код хранится только на сервере (env STAFF_BYPASS_CODE, дефолт «111»)
// и есть rate-limit 15 неудачных попыток в сутки на IP.
app.post("/api/auth/staff-bypass", (req, res) => {
  const ip = getClientIp(req);
  const limit = checkStaffBypassRateLimit(ip);
  if (!limit.ok) {
    return res.status(429).json({ success: false, message: limit.message });
  }
  const provided = String((req.body && req.body.code) || "").trim();
  if (!provided) {
    // Пустой ввод не считаем как неудачную попытку, чтобы случайные ENTER'ы
    // не сжигали лимит.
    return res.status(400).json({ success: false, message: "Введите код" });
  }
  if (provided !== STAFF_BYPASS_CODE) {
    recordStaffBypassFail(ip);
    return res.status(403).json({ success: false, message: "Неверный код" });
  }
  return res.json({ success: true });
});

// ──────────────────────────────────────────────────────────
// Админ-дашборд: /admin
// Авторизация по коду (env ADMIN_CODE, дефолт «250960»). После успешного
// логина — токен живёт 24 часа. Защищённые эндпоинты помечены requireAdmin.
// ──────────────────────────────────────────────────────────
const ADMIN_CODE = process.env.ADMIN_CODE || "250960";
const ADMIN_SESSION_TTL_MS = 24 * 3600 * 1000;
const ADMIN_LOGIN_FAIL_LIMIT_24H = 15;
const adminSessions = new Map();          // token -> expiresAt(ms)
const adminLoginFailHistory = new Map();  // ip -> [timestamp,...]

function createAdminSession() {
  const token = crypto.randomBytes(24).toString("hex");
  adminSessions.set(token, Date.now() + ADMIN_SESSION_TTL_MS);
  return token;
}

function isAdminTokenValid(token) {
  if (!token || typeof token !== "string") return false;
  const exp = adminSessions.get(token);
  if (!exp) return false;
  if (Date.now() > exp) {
    adminSessions.delete(token);
    return false;
  }
  return true;
}

function requireAdmin(req, res, next) {
  const headerToken = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
  const queryToken = String(req.query.token || "").trim();
  const token = headerToken || queryToken;
  if (!isAdminTokenValid(token)) {
    return res.status(401).json({ success: false, message: "Не авторизован" });
  }
  next();
}

function checkAdminLoginRateLimit(ip) {
  const hist = pruneHistory(adminLoginFailHistory, ip, MS_24H);
  if (hist.length >= ADMIN_LOGIN_FAIL_LIMIT_24H) {
    return { ok: false, message: "Слишком много неудачных попыток. Попробуйте через сутки." };
  }
  return { ok: true };
}
function recordAdminLoginFail(ip) {
  adminLoginFailHistory.set(ip, [...(adminLoginFailHistory.get(ip) || []), Date.now()]);
}

app.post("/admin/api/login", (req, res) => {
  const ip = getClientIp(req);
  const limit = checkAdminLoginRateLimit(ip);
  if (!limit.ok) {
    return res.status(429).json({ success: false, message: limit.message });
  }
  const provided = String((req.body && req.body.code) || "").trim();
  if (!provided) {
    return res.status(400).json({ success: false, message: "Введите код доступа" });
  }
  if (provided !== ADMIN_CODE) {
    recordAdminLoginFail(ip);
    return res.status(403).json({ success: false, message: "Неверный код" });
  }
  const token = createAdminSession();
  return res.json({ success: true, token, expiresInSec: Math.floor(ADMIN_SESSION_TTL_MS / 1000) });
});

app.post("/admin/api/logout", requireAdmin, (req, res) => {
  const headerToken = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
  if (headerToken) adminSessions.delete(headerToken);
  return res.json({ success: true });
});

// Статистика воронки ЛК. Расчёт «онлайн» — без кеша; на полл-вызовы
// клиент сам реагирует своей частотой. При большом росте номеров здесь
// можно навесить лёгкий кеш с TTL ~5с и инвалидацию на recordLkAuth/etc.
app.get("/admin/api/stats", requireAdmin, async (req, res) => {
  try {
    const data = await computeAdminStats();
    return res.json(Object.assign({ success: true }, data));
  } catch (e) {
    console.error("/admin/api/stats error:", e && e.message);
    return res.status(500).json({ success: false, message: "Ошибка расчёта статистики" });
  }
});

// Воронка по этапам сделки (статусы ЛК из amoCRM), кумулятивно.
app.get("/admin/api/stage-stats", requireStagesAccess, async (req, res) => {
  try {
    const data = await computeStageStats();
    return res.json(Object.assign({ success: true }, data));
  } catch (e) {
    console.error("/admin/api/stage-stats error:", e && e.message);
    return res.status(500).json({ success: false, message: "Ошибка расчёта по этапам" });
  }
});

// Конверсия авторизаций по «оплаченным» сделкам (3 цифры: все / без Японии / только Япония).
app.get("/admin/api/paid-conversion-stats", requireStagesAccess, async (req, res) => {
  try {
    const data = await computePaidConversionStats();
    return res.json(Object.assign({ success: true }, data));
  } catch (e) {
    console.error("/admin/api/paid-conversion-stats error:", e && e.message);
    return res.status(500).json({ success: false, message: "Ошибка расчёта конверсии" });
  }
});

// Трафик: визиты лендингов /welcome* (всего и с Яндекс.Директа) + конверсии
// (уникальные регистрации = новая авторизация + новый контакт в amoCRM).
app.get("/admin/api/traffic", requireAdmin, (req, res) => {
  try {
    return res.json(Object.assign({ success: true }, aggregateTraffic()));
  } catch (e) {
    console.error("/admin/api/traffic error:", e && e.message);
    return res.status(500).json({ success: false, message: "Ошибка расчёта трафика" });
  }
});

// График новых авторизаций по дням за последние 30 дней (скользящее окно).
// In-memory расчёт по lkAuthPhones — лёгкий и всегда свежий, кеш не нужен.
app.get("/admin/api/auth-daily", requireStagesAccess, (req, res) => {
  try {
    return res.json(computeDailyAuthSeries());
  } catch (e) {
    console.error("/admin/api/auth-daily error:", e && e.message);
    return res.status(500).json({ success: false, message: "Ошибка расчёта графика авторизаций" });
  }
});

// Воронка «Опросники»: SMS отправлено → кликнул → отправил.
// Считаем по уникальным номерам. Базой берём feedbackSent — туда попадают
// номера, которым ушло приглашение (фиксируется ДО самой отправки SMS).
// Окно отслеживания такое же, как у «Статистики» (LK_STATS_START_MS) — номера
// с sentAt ДО точки отсечки в воронку не идут. Старые записи в .feedbackSent.json
// не удаляются (см. README по recordLkAuth), просто игнорируются здесь.
app.get("/admin/api/surveys-funnel", requireAdmin, async (req, res) => {
  try {
    const sentEntries = Array.from(feedbackSent.entries()).filter(([, d]) => {
      const ts = Number(d && d.sentAt);
      return Number.isFinite(ts) && ts >= LK_STATS_START_MS;
    });
    let totalSent = 0, totalClicked = 0, totalSubmitted = 0;
    const perPhone = [];

    for (const [phone, sentData] of sentEntries) {
      totalSent++;
      const click = feedbackClicked.get(phone);
      const sub = feedbackSubmitted.get(phone);
      if (click) totalClicked++;
      if (sub) totalSubmitted++;
      let stage = 1;
      if (click) stage = 2;
      if (sub) stage = 3;
      perPhone.push({
        phone,
        formatted: formatPhoneForDisplay(phone),
        fullName: (sub && sub.fullName) || (sentData && sentData.fullName) || "",
        sentAt: sentData ? sentData.sentAt : null,
        clickedAt: click ? click.clickedAt : null,
        submittedAt: sub ? sub.submittedAt : null,
        pdfFileName: sub ? sub.pdfFileName : null,
        stage,
        stages: {
          sent: true,
          clicked: !!click,
          submitted: !!sub
        }
      });
    }

    // Сортировка: stage ASC (отстающие сверху), внутри стадии — свежие сверху.
    perPhone.sort((a, b) => a.stage - b.stage || (b.sentAt - a.sentAt));

    function pct(num, den) {
      if (!den) return 0;
      return Math.round((num / den) * 100);
    }

    return res.json({
      success: true,
      totals: {
        smsSent: totalSent,
        clicked: totalClicked,
        submitted: totalSubmitted
      },
      conversions: {
        sent_to_clicked: pct(totalClicked, totalSent),
        clicked_to_submitted: pct(totalSubmitted, totalClicked),
        // Сквозная: «получили SMS → отправили опросник».
        sent_to_submitted: pct(totalSubmitted, totalSent)
      },
      phones: perPhone
    });
  } catch (e) {
    console.error("/admin/api/surveys-funnel error:", e && e.message);
    return res.status(500).json({ success: false, message: "Ошибка расчёта воронки" });
  }
});

// Список PDF-опросников обратной связи на Я.Диске.
app.get("/admin/api/surveys", requireAdmin, async (req, res) => {
  try {
    if (!YANDEX_DISK_TOKEN) {
      return res.status(500).json({ success: false, message: "Не задан YANDEX_DISK_TOKEN" });
    }
    const files = await listYandexFolderFiles(FEEDBACK_DISK_FOLDER);
    const pdfs = (files || []).filter((n) => /\.pdf$/i.test(n)).sort();
    return res.json({
      success: true,
      folder: FEEDBACK_DISK_FOLDER,
      files: pdfs
    });
  } catch (e) {
    console.error("ADMIN /surveys list error:", e.response?.data || e.message);
    return res.status(500).json({ success: false, message: "Ошибка чтения списка опросников" });
  }
});

// Скачивание конкретного PDF: проксируем поток с Я.Диска, чтобы клиенту
// не нужно было знать токен и пути на Диске.
app.get("/admin/api/surveys/download", requireAdmin, async (req, res) => {
  try {
    const name = String(req.query.name || "").trim();
    if (!name || name.includes("/") || name.includes("\\") || name.includes("..")) {
      return res.status(400).send("Bad name");
    }
    if (!YANDEX_DISK_TOKEN) {
      return res.status(500).send("YANDEX_DISK_TOKEN missing");
    }
    const diskPath = `${FEEDBACK_DISK_FOLDER}/${name}`;
    const buf = await downloadYandexFileBuffer(diskPath);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename*=UTF-8''${encodeURIComponent(name)}`);
    return res.send(buf);
  } catch (e) {
    console.error("ADMIN /surveys download error:", e.response?.data || e.message);
    return res.status(404).send("Not found");
  }
});

// ─────────────────────────────────────────────────────────────────────────
// Доступы руководителей (разделы «Корректировки ЛК» + «База знаний ЛК»).
// Отдельный вход email+пароль (первый вход = задание пароля). Только e-mail из
// списка приглашённых (lkManagers.seed.json). Сессии отдельные от админских.
// requireStaff = админ (код 250960) ИЛИ руководитель. Админ-вход не меняется.
// ─────────────────────────────────────────────────────────────────────────
const LK_MANAGERS_FILE = path.join(__dirname, ".lkManagers.json");
const LK_MANAGERS_SEED = path.join(__dirname, "lkManagers.seed.json");
const MANAGER_SESSION_TTL_MS = 30 * 24 * 3600 * 1000; // 30 дней
const managerSessions = new Map(); // token -> { email, name, exp }
let lkManagers = null; // { email: { name, salt, hash, createdAt, lastLoginAt } }

function saveManagers() {
  try { fs.writeFileSync(LK_MANAGERS_FILE, JSON.stringify(lkManagers || {}, null, 2), "utf8"); }
  catch (e) { console.error("saveManagers error:", e.message); }
}
function loadManagers() {
  if (lkManagers) return lkManagers;
  lkManagers = {};
  try {
    if (fs.existsSync(LK_MANAGERS_FILE)) {
      lkManagers = JSON.parse(fs.readFileSync(LK_MANAGERS_FILE, "utf8")) || {};
    }
    // Досеваем e-mail из seed (приглашённые добавляются туда), обновляем имена.
    if (fs.existsSync(LK_MANAGERS_SEED)) {
      const seed = JSON.parse(fs.readFileSync(LK_MANAGERS_SEED, "utf8")) || [];
      let changed = false;
      seed.forEach((m) => {
        const email = String(m.email || "").toLowerCase().trim();
        if (!email) return;
        const seedPerms = Array.isArray(m.perms) ? m.perms : [];
        if (!lkManagers[email]) { lkManagers[email] = { name: m.name || email, salt: "", hash: "", createdAt: "", lastLoginAt: "", perms: seedPerms }; changed = true; }
        else {
          if (m.name && lkManagers[email].name !== m.name) { lkManagers[email].name = m.name; changed = true; }
          // Права доступа синхронизируем из seed (источник правды для прав).
          if (JSON.stringify(lkManagers[email].perms || []) !== JSON.stringify(seedPerms)) { lkManagers[email].perms = seedPerms; changed = true; }
        }
      });
      if (changed) saveManagers();
    }
  } catch (e) { console.error("loadManagers error:", e.message); }
  return lkManagers;
}
function hashPassword(password, salt) {
  return crypto.scryptSync(String(password), salt, 64).toString("hex");
}
function createManagerSession(email, name) {
  const token = crypto.randomBytes(24).toString("hex");
  managerSessions.set(token, { email, name, exp: Date.now() + MANAGER_SESSION_TTL_MS });
  return token;
}
function getManagerSession(token) {
  if (!token || typeof token !== "string") return null;
  const s = managerSessions.get(token);
  if (!s) return null;
  if (Date.now() > s.exp) { managerSessions.delete(token); return null; }
  return s;
}
// Роль запроса: админ (полный доступ) ИЛИ руководитель. Токен из заголовка или ?token=.
function getStaffFromReq(req) {
  const headerToken = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
  const queryToken = String(req.query.token || "").trim();
  const token = headerToken || queryToken;
  if (isAdminTokenValid(token)) return { role: "admin", name: "Андрей Комисаренко", perms: ["stages"], token };
  const m = getManagerSession(token);
  if (m) {
    // Права берём из актуальной записи руководителя (источник — seed).
    const acc = (loadManagers() || {})[String(m.email || "").toLowerCase()] || {};
    return { role: "manager", name: m.name, email: m.email, perms: Array.isArray(acc.perms) ? acc.perms : [], token };
  }
  return null;
}
function requireStaff(req, res, next) {
  const s = getStaffFromReq(req);
  if (!s) return res.status(401).json({ success: false, message: "Не авторизован" });
  req.staff = s;
  next();
}
// Доступ к статистике этапов: админ ИЛИ руководитель с правом «stages».
function requireStagesAccess(req, res, next) {
  const s = getStaffFromReq(req);
  if (s && (s.role === "admin" || (Array.isArray(s.perms) && s.perms.indexOf("stages") >= 0))) { req.staff = s; return next(); }
  return res.status(401).json({ success: false, message: "Нет доступа" });
}

app.post("/admin/api/manager-login", (req, res) => {
  const ip = getClientIp(req);
  const limit = checkAdminLoginRateLimit(ip);
  if (!limit.ok) return res.status(429).json({ success: false, message: limit.message });
  const email = String((req.body && req.body.email) || "").toLowerCase().trim();
  const password = String((req.body && req.body.password) || "");
  if (!email || !password) return res.status(400).json({ success: false, message: "Введите e-mail и пароль" });
  const mgrs = loadManagers();
  const acc = mgrs[email];
  if (!acc) { recordAdminLoginFail(ip); return res.status(403).json({ success: false, message: "Нет доступа для этого e-mail" }); }
  if (!acc.hash) {
    // Первый вход — задаём пароль.
    if (password.length < 6) return res.status(400).json({ success: false, message: "Придумайте пароль не короче 6 символов" });
    acc.salt = crypto.randomBytes(16).toString("hex");
    acc.hash = hashPassword(password, acc.salt);
    acc.createdAt = new Date().toISOString();
    acc.lastLoginAt = acc.createdAt;
    saveManagers();
    const token = createManagerSession(email, acc.name);
    return res.json({ success: true, token, role: "manager", name: acc.name, perms: acc.perms || [], firstLogin: true });
  }
  // Обычный вход — проверяем пароль (constant-time).
  let ok = false;
  try {
    const a = Buffer.from(hashPassword(password, acc.salt), "hex");
    const b = Buffer.from(acc.hash, "hex");
    ok = a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch (_) { ok = false; }
  if (!ok) { recordAdminLoginFail(ip); return res.status(403).json({ success: false, message: "Неверный e-mail или пароль" }); }
  acc.lastLoginAt = new Date().toISOString();
  saveManagers();
  const token = createManagerSession(email, acc.name);
  return res.json({ success: true, token, role: "manager", name: acc.name, perms: acc.perms || [] });
});

app.post("/admin/api/manager-logout", requireStaff, (req, res) => {
  if (req.staff && req.staff.token) managerSessions.delete(req.staff.token);
  return res.json({ success: true });
});

// «Кто я» — роль + имя (для фронта). Принимает админский и менеджерский токен.
app.get("/admin/api/whoami", requireStaff, (req, res) => {
  return res.json({ success: true, role: req.staff.role, name: req.staff.name, perms: req.staff.perms || [] });
});

// ─────────────────────────────────────────────────────────────────────────
// Раздел «Корректировки ЛК» (админка). Приём корректировок от руководителей:
// структурированные заявки + статусы + тред-комментарии. Хранение — JSON-файл
// (рантайм .lkCorrections.json; при отсутствии инициализируется из коммита
// lkCorrections.seed.json, куда импортирована история из таблицы). Изолировано
// от клиентского ЛК / amoCRM / Я.Диска.
// ─────────────────────────────────────────────────────────────────────────
const LK_CORRECTIONS_FILE = path.join(__dirname, ".lkCorrections.json");
const LK_CORRECTIONS_SEED = path.join(__dirname, "lkCorrections.seed.json");
const CORRECTION_STATUSES = new Set(["new", "clarify", "in_progress", "deferred", "done", "rejected"]);
// Статусы, считающиеся «закрытыми» (скрываются в сворачиваемые секции, проставляется дата).
const CORRECTION_CLOSED_STATUSES = new Set(["deferred", "done", "rejected"]);
let lkCorrections = null; // массив в памяти

function saveCorrections() {
  try {
    fs.writeFileSync(LK_CORRECTIONS_FILE, JSON.stringify(lkCorrections || [], null, 2), "utf8");
  } catch (e) {
    console.error("saveCorrections error:", e.message);
  }
}
function loadCorrections() {
  if (lkCorrections) return lkCorrections;
  try {
    if (fs.existsSync(LK_CORRECTIONS_FILE)) {
      lkCorrections = JSON.parse(fs.readFileSync(LK_CORRECTIONS_FILE, "utf8"));
    } else if (fs.existsSync(LK_CORRECTIONS_SEED)) {
      lkCorrections = JSON.parse(fs.readFileSync(LK_CORRECTIONS_SEED, "utf8"));
      saveCorrections(); // материализуем рантайм-файл из seed при первом запуске
    } else {
      lkCorrections = [];
    }
  } catch (e) {
    console.error("loadCorrections error:", e.message);
  }
  if (!Array.isArray(lkCorrections)) lkCorrections = [];
  return lkCorrections;
}
function corrText(s, max) {
  return String(s == null ? "" : s).trim().slice(0, max || 4000);
}

app.get("/admin/api/corrections", requireStaff, (req, res) => {
  try {
    const all = loadCorrections();
    // Корзина «Удалённые» видна только админу; руководителям отдаём без удалённых.
    const items = req.staff.role === "manager" ? all.filter((x) => x && !x.deleted) : all;
    return res.json({ success: true, items, me: { role: req.staff.role, name: req.staff.name } });
  } catch (e) {
    return res.status(500).json({ success: false, message: "Ошибка" });
  }
});

app.post("/admin/api/corrections", requireStaff, (req, res) => {
  try {
    const b = req.body || {};
    const what = corrText(b.what, 6000);
    if (!what) return res.status(400).json({ success: false, message: "Заполните поле «Что нужно»" });
    loadCorrections();
    const now = Date.now();
    // Для руководителя автор = его имя из аккаунта (поле в форме скрыто).
    // Админ может указать автора вручную; если не указал (быстрые формы
    // из Тестировщика/справочников) — подставляем имя админа.
    const author = req.staff.role === "manager" ? req.staff.name : (corrText(b.author, 120) || req.staff.name);
    const item = {
      id: "c" + now + Math.floor(Math.random() * 1000),
      ts: now,
      createdAt: new Date(now).toISOString(),
      author: author,
      area: corrText(b.area, 200),
      what,
      expected: corrText(b.expected, 4000),
      example: corrText(b.example, 1000),
      context: corrText(b.context, 3000),
      priority: corrText(b.priority, 40),
      status: "new",
      resolvedAt: "",
      note: "",
      comments: [],
      legacy: false
    };
    lkCorrections.unshift(item);
    saveCorrections();
    return res.json({ success: true, item });
  } catch (e) {
    console.error("create correction error:", e.message);
    return res.status(500).json({ success: false, message: "Ошибка" });
  }
});

app.post("/admin/api/corrections/:id/update", requireAdmin, (req, res) => {
  try {
    loadCorrections();
    const it = lkCorrections.find((x) => x && x.id === String(req.params.id));
    if (!it) return res.status(404).json({ success: false, message: "Не найдено" });
    const b = req.body || {};
    if (b.status !== undefined) {
      const st = String(b.status);
      if (!CORRECTION_STATUSES.has(st)) return res.status(400).json({ success: false, message: "Неизвестный статус" });
      it.status = st;
      if (CORRECTION_CLOSED_STATUSES.has(st) && !it.resolvedAt) {
        it.resolvedAt = new Date().toISOString().slice(0, 10);
      }
      if (!CORRECTION_CLOSED_STATUSES.has(st)) it.resolvedAt = "";
    }
    if (b.note !== undefined) it.note = corrText(b.note, 4000);
    saveCorrections();
    return res.json({ success: true, item: it });
  } catch (e) {
    console.error("update correction error:", e.message);
    return res.status(500).json({ success: false, message: "Ошибка" });
  }
});

app.post("/admin/api/corrections/:id/comment", requireStaff, (req, res) => {
  try {
    loadCorrections();
    const it = lkCorrections.find((x) => x && x.id === String(req.params.id));
    if (!it) return res.status(404).json({ success: false, message: "Не найдено" });
    const b = req.body || {};
    const text = corrText(b.text, 4000);
    if (!text) return res.status(400).json({ success: false, message: "Пустой комментарий" });
    if (!Array.isArray(it.comments)) it.comments = [];
    it.comments.push({ ts: Date.now(), author: req.staff.name || corrText(b.author, 120), text });
    saveCorrections();
    return res.json({ success: true, item: it });
  } catch (e) {
    console.error("comment correction error:", e.message);
    return res.status(500).json({ success: false, message: "Ошибка" });
  }
});

// Удаление корректировки — ТОЛЬКО админ (вход по коду). Руководителям нельзя.
// Мягкое: заявка помечается deleted и попадает в корзину «Удалённые» внизу
// раздела (только у админа). Безвозвратное удаление — purge-deleted ниже.
app.post("/admin/api/corrections/:id/delete", requireAdmin, (req, res) => {
  try {
    loadCorrections();
    const it = lkCorrections.find((x) => x && x.id === String(req.params.id));
    if (!it) return res.status(404).json({ success: false, message: "Не найдено" });
    it.deleted = true;
    it.deletedAt = new Date().toISOString();
    saveCorrections();
    return res.json({ success: true, item: it });
  } catch (e) {
    console.error("delete correction error:", e.message);
    return res.status(500).json({ success: false, message: "Ошибка" });
  }
});

// Восстановление из корзины «Удалённые» — только админ.
app.post("/admin/api/corrections/:id/restore", requireAdmin, (req, res) => {
  try {
    loadCorrections();
    const it = lkCorrections.find((x) => x && x.id === String(req.params.id));
    if (!it) return res.status(404).json({ success: false, message: "Не найдено" });
    it.deleted = false;
    it.deletedAt = "";
    saveCorrections();
    return res.json({ success: true, item: it });
  } catch (e) {
    console.error("restore correction error:", e.message);
    return res.status(500).json({ success: false, message: "Ошибка" });
  }
});

// «Удалить все» из корзины — безвозвратно. Только админ.
app.post("/admin/api/corrections/purge-deleted", requireAdmin, (req, res) => {
  try {
    loadCorrections();
    let removed = 0;
    for (let i = lkCorrections.length - 1; i >= 0; i--) {
      if (lkCorrections[i] && lkCorrections[i].deleted) { lkCorrections.splice(i, 1); removed++; }
    }
    saveCorrections();
    return res.json({ success: true, removed });
  } catch (e) {
    console.error("purge corrections error:", e.message);
    return res.status(500).json({ success: false, message: "Ошибка" });
  }
});

// ═════════════════════════════════════════════════════════════════════════
// База знаний ЛК. Живые HTML-страницы — генерятся из кода/данных в момент
// открытия (всегда актуально, файлы не хранятся). Доступ: requireStaff
// (токен в заголовке или ?token= — чтобы открывать в новой вкладке).
// ═════════════════════════════════════════════════════════════════════════
function kbEsc(s) {
  return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function kbPage(title, bodyHtml) {
  const now = new Date().toLocaleString("ru-RU", { timeZone: "Europe/Moscow" });
  return `<!DOCTYPE html><html lang="ru"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0"><title>${kbEsc(title)} · VOYO ЛК</title>
<style>
:root{--navy:#161d45;--blue:#3589BD;}
*{box-sizing:border-box;} body{font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#23272f;line-height:1.5;max-width:1000px;margin:0 auto;padding:24px 18px 70px;background:#f6f7f9;}
h1{font-size:23px;color:var(--navy);margin:0 0 4px;} h2{font-size:18px;color:var(--navy);margin:26px 0 8px;padding-bottom:6px;border-bottom:2px solid #e6e9f0;}
h3{font-size:15px;color:var(--navy);margin:16px 0 6px;} p{margin:7px 0;} .sub{color:#6b7280;margin:0 0 14px;font-size:13px;}
table{width:100%;border-collapse:collapse;margin:8px 0;background:#fff;font-size:13.5px;} th,td{border:1px solid #e6e9f0;padding:7px 10px;text-align:left;vertical-align:top;}
th{background:var(--navy);color:#fff;font-weight:600;font-size:12.5px;} tr:nth-child(even) td{background:#fafbfc;}
.card{background:#fff;border:1px solid #e6e9f0;border-radius:14px;padding:14px 16px;margin:12px 0;}
.badge{display:inline-block;padding:1px 8px;border-radius:999px;font-size:11.5px;font-weight:700;white-space:nowrap;}
.b-req{background:#fbebee;color:#7a2d39;border:1px solid #efcfd5;} .b-opt{background:#f0f7fc;color:#1d4d72;border:1px solid #d3e7f4;}
.muted{color:#9aa0ab;font-size:12px;} ul{margin:6px 0;padding-left:20px;} li{margin:4px 0;}
.filt{display:flex;flex-wrap:wrap;gap:6px;margin:12px 0 6px;} .filt button{border:1px solid #cfd8e3;background:#fff;color:#33415a;border-radius:999px;padding:5px 12px;font-size:13px;cursor:pointer;font-family:inherit;} .filt button.active{background:var(--blue);color:#fff;border-color:var(--blue);}
.upd{color:#9aa0ab;font-size:11px;margin-top:24px;border-top:1px dashed #e0e3ea;padding-top:10px;}
@media print{body{background:#fff;padding:0;} .filt{display:none;} tr{page-break-inside:avoid;} h2{page-break-after:avoid;}}
</style></head><body>
${bodyHtml}
<div class="upd">Сгенерировано из текущего кода ЛК · ${now} (МСК). Страница всегда отражает актуальную логику — обновлять вручную не нужно.</div>
</body></html>`;
}

// ── Инструкция по админке: цели и возможности разделов. При изменениях
// админки/ЛК этот текст обновляется вместе с ними (как и LK_TESTER_SPEC). ──
app.get("/admin/kb/admin-guide", requireStaff, (req, res) => {
  try {
    let b = `<h1>Инструкция по админке</h1><p class="sub">Цели и возможности разделов — без воды, со всеми нюансами. Страница соответствует текущей версии админки и обновляется вместе с ней.</p>`;

    b += `<div class="card"><b>Доступы.</b> Сотрудники входят на <b>voyovoyo.ru/team</b> (email + пароль; при первом входе придумываете пароль не короче 6 символов). Сотрудникам видна группа «Работа с ЛК»: «Корректировки ЛК», «Тестировщик ЛК», «Запрос документов», «Опросники (логика)», «Действия», «Области загрузки», «База знаний ЛК». Статистика и данные клиентов недоступны. Админ входит по коду и видит всё.</div>`;

    b += `<h2>Корректировки ЛК</h2>
<p><b>Цель:</b> единый канал заявок на изменения ЛК — ничего не теряется в чатах, по каждой заявке виден статус и история обсуждения.</p>
<ul>
<li><b>Подать заявку:</b> «+ Добавить корректировку» → раздел ЛК, «что не так» (обязательно), «как должно быть», пример/ссылка на сделку, приоритет. Автор подставляется автоматически из вашего аккаунта.</li>
<li><b>Статусы</b> (меняет только админ; сотрудники видят): Новая → Нужны уточнения / В работе → Реализовано / Отложено / Отклонено.</li>
<li><b>Структура:</b> сверху «Новые» и «В работе» (новые → старые); «Реализованные», «Отложенные», «Отклонённые» свёрнуты внизу и разворачиваются кнопкой. У админа дополнительно корзина «Удалённые»: восстановление заявки или «Удалить все безвозвратно».</li>
<li><b>Комментарии:</b> тред под каждой заявкой для вопросов и уточнений; имя автора и время (МСК) подставляются автоматически.</li>
<li><b>«Параметры ситуации»:</b> заявки, отправленные кнопками «Скорректировать»/«Применить» из других разделов, приходят с автоконтекстом (направление, этап, выбранные параметры, документ/вопрос/действие) — это точная фиксация ситуации, в которой замечена проблема.</li>
<li>Заявки со статусом «Реализовано» автоматически попадают в «Историю изменений клиентского ЛК» (База знаний).</li>
</ul>`;

    b += `<h2>Тестировщик ЛК</h2>
<p><b>Цель:</b> мгновенно увидеть, что увидит клиент при любом сочетании параметров — вместо создания тестового клиента и прокликивания ЛК руками.</p>
<ul>
<li><b>Как пользоваться:</b> направление (Шенген/Япония) → этап → параметры клиента (род деятельности, спонсор, возраст, визы, 2-й загран, страна оформления в CRM, окно до даты записи и т.д.). Результат пересчитывается сразу.</li>
<li><b>Что показывает:</b> что видит клиент на этапе; документы — <span class="badge b-req">обязательные</span> / <span class="badge b-opt">необязательные</span>, кумулятивно (незагруженное с ранних этапов остаётся в списке); подобласть «Документы для проверки перед подачей» (появляется за 7 дней до «Даты записи на подачу»); «Внутренняя логика» — что происходит незаметно для клиента (задачи amoCRM, папки Я.Диска).</li>
<li><b>«Скорректировать»</b> на каждом блоке: заметили несоответствие — заполняете «что не так / как нужно», заявка уходит в «Корректировки ЛК» со всеми выбранными параметрами.</li>
<li><b>«Рекомендации»</b> (жёлтый блок): замечания Claude — спорное/дубли/хрупкое. Кнопка «Применить» отправляет рекомендацию в «Корректировки ЛК» (можно добавить свой комментарий).</li>
</ul>`;

    b += `<h2>Запрос документов</h2>
<p><b>Цель:</b> полный справочник документов по направлениям — по каждому документу видна вся логика запроса.</p>
<ul>
<li><b>Каждая строка:</b> документ → когда запрашивается (этап + условие из опросника или поля CRM) → обязательность и когда она наступает.</li>
<li><b>Нюансы:</b> документы кумулятивны — остаются в списке до этапа 2, пока не загружены; подобласть «перед подачей» появляется за 7 дней до «Даты записи на подачу» (нет даты в сделке — подобласти нет); пометка «обязателен*» = обязателен, но при условии становится необязательным (например, при спонсоре); пока обязательные из подобласти не загружены — точка этапа у клиента жёлтая.</li>
<li>«Скорректировать» у каждой строки; «Рекомендации» сверху раздела.</li>
</ul>`;

    b += `<h2>Опросники (логика)</h2>
<p><b>Цель:</b> все вопросы опросников и их последствия.</p>
<ul>
<li><b>Каждая строка:</b> вопрос → обязателен ли ответ → когда вопрос показывается (включая вопросы, открывающиеся после определённых ответов) → что влечёт ответ (какой документ и на каком этапе запросится).</li>
<li><b>Нюансы:</b> «обязателен*» — особый случай (например, даты поездки можно заменить галочкой «не знаю точных дат» + подтверждение); часть «Да/Нет» вопросов Шенгена технически можно пропустить — пропуск работает как «Нет» (см. «Рекомендации»); у Японии пропуск «Цели визита» наоборот запрашивает «Приглашение» и «План поездки».</li>
<li>Не путать со вкладкой «Опросники» в группе статистики — там присланные клиентами анкеты (доступна только админу).</li>
</ul>`;

    b += `<h2>Действия</h2>
<p><b>Цель:</b> справочник всего, что ЛК делает во внешних системах — sms.ru, amoCRM, Яндекс.Диск — и значимых внутренних действий.</p>
<ul>
<li>Сгруппировано по сервисам; внутри группы — в порядке пути клиента. По каждому действию: когда срабатывает + подробности (тексты задач amoCRM и схема выбора ответственного; пути папок на Я.Диске; лимиты SMS: код 5 минут, повтор раз в 60 секунд, 5 попыток).</li>
<li>Используйте, когда нужно понять: «почему создалась задача», «куда упал файл клиента», «почему не пришла SMS».</li>
</ul>`;

    b += `<h2>Области загрузки</h2>
<p><b>Цель:</b> справочник всех областей загрузки документов клиентского ЛК — как они себя ведут.</p>
<ul>
<li><b>По каждой области:</b> направления, когда появляется (этап + условие, напр. «за 7 дней до даты записи»), состав документов, когда плашка меняет цвет (красная → зелёная при загрузке всех обязательных), когда область можно закрыть полностью, нюансы (жёлтая точка этапа, свободная зона Японии, поведение после полной загрузки).</li>
<li>«Скорректировать» у каждой области — замечание сразу в «Корректировки ЛК» с контекстом области.</li>
</ul>`;

    b += `<h2>Экраны клиента</h2>
<p><b>Цель:</b> что видит клиент на каждом из 8 этапов ЛК, цвет точки этапа и все валидации/ошибки.</p>
<ul>
<li><b>Экраны по этапам:</b> по каждому этапу — что показывается клиенту (блоки документов, «Ваши готовые документы», рекламные блоки, Telegram) и когда точка этапа серая / жёлтая / зелёная.</li>
<li><b>Валидации и ошибки:</b> что блокирует отправку опросника и загрузку (даты, дубль ФИО, биометрия и согласия, модал ФИО, лимит 20 МБ и форматы файлов) и какие сообщения видит клиент.</li>
</ul>`;

    b += `<h2>Заявители</h2>
<p><b>Цель:</b> работа с несколькими заявителями в одной сделке.</p>
<ul>
<li>Пакеты («Количество пакетов» из amoCRM) и ограничение кнопки «Заполнить ещё опросник»; добавление и правка заявителей; блоки загрузки на каждого; предварительные заявители (паспорта до опросника) и их слияние по ФИО; папки на Я.Диске и проверка дублей ФИО.</li>
</ul>`;

    b += `<div class="card muted"><b>Общие принципы.</b> Разделы генерируются из актуальной логики ЛК — при изменениях ЛК данные актуализируются, вручную ничего обновлять не нужно. Любая кнопка «Скорректировать»/«Применить» создаёт заявку в «Корректировки ЛК»; автором становится тот, кто отправил. «База знаний ЛК» — справочные страницы (эта инструкция, карта статусов, история изменений и др.), открываются в новой вкладке.</div>`;

    res.set("Content-Type", "text/html; charset=utf-8");
    return res.send(kbPage("Инструкция по админке", b));
  } catch (e) { return res.status(500).send("Ошибка генерации страницы"); }
});

// ── Карта статусов (полностью авто из STATUS_MAP / CABINET_STAGES) ──
app.get("/admin/kb/statuses", requireStaff, (req, res) => {
  try {
    let b = `<h1>Карта статусов</h1><p class="sub">Какой статус сделки в amoCRM → какой этап показывается клиенту в ЛК. Генерируется из кода — всегда актуально.</p>`;
    b += `<div class="card"><b>Этапы ЛК по порядку:</b><br>` + CABINET_STAGES.map((s, i) => `${i}. ${kbEsc(s)}`).join(" · ") + `</div>`;
    Object.keys(STATUS_MAP).forEach((pipeline) => {
      b += `<h2>${kbEsc(pipeline)}</h2><table><tr><th>Статус сделки (amoCRM)</th><th>Этап в ЛК</th></tr>`;
      const st = STATUS_MAP[pipeline];
      Object.keys(st).forEach((status) => {
        const v = st[status];
        const target = v.hidden ? '<span class="muted">скрыт в ЛК</span>' : kbEsc(v.client_status || "—");
        b += `<tr><td>${kbEsc(status)}</td><td>${target}</td></tr>`;
      });
      b += `</table>`;
    });
    b += `<div class="card muted">Особый случай: «Электронное рассмотрение» (Отдел Оформления) обычно → «Рассмотрение», но если «Страна оформления/услуга» в CRM = США/Великобритания → «Подготовка документов».</div>`;
    res.set("Content-Type", "text/html; charset=utf-8");
    return res.send(kbPage("Карта статусов", b));
  } catch (e) { return res.status(500).send("Ошибка генерации страницы"); }
});

// ── Карта документов (по этапам; источник правды — логика ЛК) ──
const KB_DOC_GROUPS = [
  { stage: "Начало оформления (этап 0)", note: "Показывается всегда, обеим визам.", docs: [
    { n: "Внутренний паспорт (1-й разворот, прописка, последний разворот)", c: "всегда", r: true },
    { n: "Загран. паспорт (в который запрашиваем визу)", c: "всегда", r: true }
  ]},
  { stage: "Первичный сбор документов (этап 1) — Шенген", docs: [
    { n: "Электронное фото", c: "если «Страна оформления/услуга» в amoCRM = Испания / Португалия / Кипр (берётся из CRM, не из опросника)", r: true },
    { n: "Приглашение", c: "если цель поездки ≠ Туризм", r: true }
  ]},
  { stage: "Первичный сбор документов (этап 1) — Япония", docs: [
    { n: "Приглашение + План поездки", c: "если цель поездки ≠ Туризм", r: true },
    { n: "Авиабилеты", c: "если есть свои авиабилеты", r: true },
    { n: "Внутр. паспорт спонсора", c: "если поездку оплачивает спонсор", r: true },
    { n: "Свидетельство о рождении", c: "если заявителю < 18", r: true },
    { n: "Справка с работы", c: "если род занятий = «Работа по найму»", r: true },
    { n: "Справка с учёбы", c: "если род занятий = «Учащийся»", r: true }
  ]},
  { stage: "Подготовка документов (этап 2) — Шенген, обычный список", docs: [
    { n: "Фото действующей шенгенской визы", c: "если есть действующая виза", r: true },
    { n: "Фото последней шенгенской визы", c: "если были визы за 3 года", r: true },
    { n: "Внутр. паспорт спонсора или Спонсорское письмо", c: "если спонсируют", r: true },
    { n: "Свидетельство о рождении", c: "если < 18", r: true },
    { n: "2-й загран. паспорт", c: "если есть 2-й загран", r: true },
    { n: "Своё проживание (бронь/аренда/собственность)", c: "если своё проживание", r: true },
    { n: "Свои авиабилеты / транспорт", c: "если свой транспорт", r: true },
    { n: "Билеты в третью страну", c: "если 2-й загран + не сдаёт действующий + причина «третья страна»", r: true },
    { n: "ВНЖ или регистрация", c: "если не гражданин РФ", r: true },
    { n: "Справка с работы или учёбы", c: "если указан работодатель/учёба (≠ «НЕТ»)", r: true },
    { n: "Страховой полис для въезда в Шенген", c: "если есть своя страховка", r: true },
    { n: "Посадочные талоны и (или) иные подтверждения использования визы", c: "если посещал Шенген после 10.04.2026 и штампы не ставили", r: true }
  ]},
  { stage: "Подготовка документов — подобласть «Документы для проверки перед подачей»", note: "Появляется за 7 дней до поля сделки «Дата записи на подачу». Деление обяз/необяз — красным/синим.", docs: [
    { n: "Справка из банка об остатке средств", c: "всем; необяз. если спонсируют", r: true },
    { n: "Выписка (детализация) по счёту", c: "всем; необяз. если спонсируют", r: true },
    { n: "Документы на ИП", c: "если род занятий = ИП", r: true },
    { n: "Справка из учебного заведения", c: "если «Учащийся»", r: true },
    { n: "Пенсионное удостоверение или справка о пенсии", c: "если «Пенсионер»", r: true },
    { n: "Справка о самозанятости", c: "если «Самозанятый»", r: true },
    { n: "Справка из банка от спонсора / Выписка по счёту спонсора / Внутр. паспорт спонсора", c: "если спонсируют", r: true },
    { n: "Внутренние паспорта родителей", c: "если < 18", r: true },
    { n: "Справка с места работы спонсора", c: "если спонсируют", r: false },
    { n: "Согласие на выезд ребёнка", c: "если < 18", r: false },
    { n: "Электронная выписка из ПФР", c: "всем", r: false },
    { n: "Справка 2-НДФЛ", c: "всем", r: false }
  ]},
  { stage: "Ожидание подачи (этап 3) и далее", note: "Загрузки документов нет — пакет собран. На «Ожидание подачи» клиенту выдаются готовые документы для скачивания.", docs: [] }
];
app.get("/admin/kb/documents", requireStaff, (req, res) => {
  try {
    let b = `<h1>Карта документов</h1><p class="sub">Какие документы и на каком этапе запрашиваются у клиента, и что обязательно. <span class="badge b-req">обязательный</span> · <span class="badge b-opt">необязательный</span></p>`;
    KB_DOC_GROUPS.forEach((g) => {
      b += `<h2>${kbEsc(g.stage)}</h2>`;
      if (g.note) b += `<p class="sub">${kbEsc(g.note)}</p>`;
      if (g.docs.length) {
        b += `<table><tr><th>Документ</th><th>Когда (условие)</th><th>Статус</th></tr>`;
        g.docs.forEach((d) => { b += `<tr><td>${kbEsc(d.n)}</td><td>${kbEsc(d.c)}</td><td><span class="badge ${d.r ? "b-req" : "b-opt"}">${d.r ? "обяз." : "необяз."}</span></td></tr>`; });
        b += `</table>`;
      }
    });
    b += `<p class="muted">Необязательные в подобласли «перед подачей» помечены: «В вашем случае может быть не обязательным документом. Уточните у менеджера.»</p>`;
    res.set("Content-Type", "text/html; charset=utf-8");
    return res.send(kbPage("Карта документов", b));
  } catch (e) { return res.status(500).send("Ошибка генерации страницы"); }
});

// ── Полная логика ЛК + поведение по этапам (фильтр) ──
const KB_LOGIC_STAGES = [
  { key: "Начало оформления", sees: "Загрузка 2 паспортов (внутренний + загран). Возможность заполнить опросник (паспорта можно загрузить и до опросника — тогда спросим ФИО).", dep: ["Этап определяется статусом сделки в amoCRM (см. «Карту статусов»).", "Опросник: Шенген или Япония — по полю визы."] },
  { key: "Первичный сбор документов", sees: "Паспорта (этап 0) + первый набор условных документов по ответам опросника.", dep: ["Состав документов зависит от ответов опросника и от поля CRM «Страна оформления/услуга» (электронное фото).", "Все условные документы сейчас обязательны."] },
  { key: "Подготовка документов", sees: "Документы этапов 0–1 + второй набор условных документов (кумулятивно). За 7 дней до «Даты записи на подачу» появляется подобласть «Документы для проверки перед подачей» (красным — обязательные, синим — нет).", dep: ["Сюда же ведут статусы «Ожидает записи через Бота», «Запись сделана» и т.д. (см. «Карту статусов»).", "Подобласть «перед подачей» — по полю сделки «Дата записи на подачу» (−7 дней). Если поле пустое — подобласти нет.", "Пока обязательные в подобласли не загружены — точка этапа жёлтая."] },
  { key: "Ожидание подачи", sees: "Документы клиент больше не грузит. Вместо этого видит блок «Ваши готовые документы» — список по заявителям с кнопками «Скачать» и «Скачать все документы».", dep: ["Готовые документы кладёт отдел оформления в папку сделки на Я.Диске.", "Блок виден на статусах: «Документы готовы к личной подаче», «Ожидает передачи на рассмотрение в Консульство», «Передано Клиенту для личной подачи»."] },
  { key: "Оформление на паузе", sees: "Информационный статус «на паузе».", dep: ["Статусы «На паузе по просьбе Клиента», «Ожидает решения о возврате»."] },
  { key: "Рассмотрение", sees: "Информация, что документы на рассмотрении в Консульстве.", dep: ["Статусы «На рассмотрении в Консульстве», «Документы поданы лично», «Электронное рассмотрение»."] },
  { key: "Паспорт готов", sees: "Сообщение, что паспорт готов.", dep: ["Статус «Паспорт готов»."] },
  { key: "Обращение исполнено", sees: "Обращение завершено.", dep: ["Статусы «Успешно реализовано», «Возврат»."] }
];
app.get("/admin/kb/logic", requireStaff, (req, res) => {
  try {
    let b = `<h1>Как работает клиентский ЛК</h1><p class="sub">Поведение по этапам: что видит клиент и от чего это зависит. Для не-технических сотрудников. Фильтр по этапу:</p>`;
    b += `<div class="filt"><button class="active" data-f="all">Все этапы</button>` + KB_LOGIC_STAGES.map((s, i) => `<button data-f="${i}">${kbEsc(s.key)}</button>`).join("") + `</div>`;
    KB_LOGIC_STAGES.forEach((s, i) => {
      b += `<div class="card kb-stage" data-i="${i}"><h3>${kbEsc(s.key)}</h3><p><b>Что видит клиент:</b> ${kbEsc(s.sees)}</p><p><b>От чего зависит / нюансы:</b></p><ul>` + s.dep.map((d) => `<li>${kbEsc(d)}</li>`).join("") + `</ul></div>`;
    });
    b += `<div class="card muted">Общая механика: этап в ЛК определяется статусом сделки в amoCRM (см. «Карту статусов»). Состав документов — ответами опросника + полем «Страна оформления/услуга». Это «как задумано и проверено»; при правках страница обновляется автоматически.</div>`;
    b += `<script>(function(){var btns=document.querySelectorAll('.filt button');var cards=document.querySelectorAll('.kb-stage');btns.forEach(function(btn){btn.addEventListener('click',function(){btns.forEach(function(x){x.classList.remove('active');});btn.classList.add('active');var f=btn.dataset.f;cards.forEach(function(c){c.style.display=(f==='all'||c.dataset.i===f)?'':'none';});});});})();</script>`;
    res.set("Content-Type", "text/html; charset=utf-8");
    return res.send(kbPage("Как работает клиентский ЛК", b));
  } catch (e) { return res.status(500).send("Ошибка генерации страницы"); }
});

// ── Что изменилось (changelog) — из реализованных корректировок ──
app.get("/admin/kb/changelog", requireStaff, (req, res) => {
  try {
    const items = (loadCorrections() || []).filter((x) => x && x.status === "done");
    items.sort((a, b) => String(b.resolvedAt || "").localeCompare(String(a.resolvedAt || "")) || (b.ts || 0) - (a.ts || 0));
    let b = `<h1>История изменений клиентского ЛК</h1><p class="sub">Лента реализованных корректировок (из раздела «Корректировки ЛК»). Обновляется автоматически.</p>`;
    if (!items.length) { b += `<div class="card muted">Пока нет реализованных корректировок.</div>`; }
    else {
      b += `<table><tr><th>Дата</th><th>Что сделано</th><th>Примечание</th><th>Автор</th></tr>`;
      items.forEach((it) => {
        const date = String(it.resolvedAt || it.createdAt || "").slice(0, 10).split("-").reverse().join(".");
        b += `<tr><td>${kbEsc(date)}</td><td>${kbEsc(it.what || "")}</td><td>${kbEsc(it.note || "")}</td><td>${kbEsc(it.author || "")}</td></tr>`;
      });
      b += `</table>`;
    }
    res.set("Content-Type", "text/html; charset=utf-8");
    return res.send(kbPage("История изменений клиентского ЛК", b));
  } catch (e) { return res.status(500).send("Ошибка генерации страницы"); }
});

// ═════════════════════════════════════════════════════════════════════════
// ТЕСТИРОВЩИК ЛК — интерактивный калькулятор логики.
// Один источник правды (LK_TESTER_SPEC) — отдаётся фронту, который считает
// результат на клиенте. Спек ОТРАЖАЕТ реальную логику cabinet.html: при любом
// изменении клиентского ЛК этот спек нужно синхронно обновлять (он и есть
// «актуализация»). Условия показа документов сверены с кодом cabinet.html.
//   Грамматика условия cond: отсутствует = всегда; {f,eq}/{f,ne}/{f,in:[...]};
//   {all:[...]} / {any:[...]}. Для presub: opt=true (всегда необязателен) или
//   opt={cond} (необязателен, когда cond истинно; иначе обязателен).
// ═════════════════════════════════════════════════════════════════════════
const LK_TESTER_SPEC = {
  stages: [
    "Начало оформления", "Первичный сбор документов", "Подготовка документов",
    "Ожидание подачи", "Оформление на паузе", "Рассмотрение", "Паспорт готов", "Обращение исполнено"
  ],
  stageSees: {
    0: "Загрузка 2 паспортов (внутренний + загран). Доступен опросник (паспорта можно загрузить и до опросника — тогда спросим ФИО). Над списком — красная плашка «Необходимо загрузить все документы ниже», зеленеет, когда все обязательные прикреплены.",
    1: "Паспорта (этап 0) + первый набор условных документов по ответам опросника. Все показанные документы обязательны. Красная плашка области зеленеет, когда все обязательные прикреплены.",
    2: "Документы этапов 0–1 + второй набор условных документов (кумулятивно). За 7 дней до «Даты записи на подачу» появляется подобласть «Документы для проверки перед подачей» (красным — обязательные, синим — необязательные). Красные плашки областей (основной и подобласти) зеленеют, когда все обязательные в них загружены.",
    3: "Документы больше не грузятся. Клиент видит блок «Ваши готовые документы» — список по заявителям с кнопками «Скачать» / «Скачать все».",
    4: "Информационный экран «Оформление на паузе».",
    5: "Информация: документы на рассмотрении в Консульстве.",
    6: "Сообщение, что паспорт готов.",
    7: "Обращение завершено."
  },
  internal: {
    docStages: "При загрузке документов (этапы 0–2) в amoCRM создаётся задача «Загрузились новые документы от клиента из ЛК». Ответственный: воронка «Отдел продаж» → поле «Ответственный» (иначе responsible_user_id сделки); другие воронки → поле «Кто принял клиента» (иначе responsible_user_id); крайний случай — пользователь «Visa Services Center».",
    questionnaireSubmit: "При сохранении опросника на Я.Диске создаются папки: «Готовые документы (ЛК)/<ФИО>» и подпапка «…/Чек по страховке». При повторном сохранении (правка опросника) — задача в amoCRM «Клиент скорректировал опросник в личном кабинете VOYO» на того же ответственного.",
    stage3: "На «Ожидание подачи» документы кладёт отдел оформления в папку сделки на Я.Диске; клиент видит их в блоке «Ваши готовые документы»."
  },
  // Мои замечания (спорное / дублирующееся / хрупкое) — показываются вверху страницы.
  contentious: [
    "«Электронное фото» зависит от CRM-поля «Страна оформления/услуга», а НЕ от ответа опросника «в какую страну виза». Если в опроснике клиент указал одну страну, а в CRM поле — другую, фото покажется/не покажется не по тому, что выбрал клиент. (Случай, о котором писала сотрудница про Францию.)",
    "Возможные дубли документов между обычным списком этапа «Подготовка документов» и подобластью «перед подачей»: спонсорские документы, справка с работы, 2-й загран и т.п. могут запрашиваться дважды. (Ждёт правил Насти — задачи 2/3.)",
    "«Билеты в третью страну» — срабатывает по тройному условию (есть 2-й загран + не сдаёт его + причина «Поездка в третью страну»). Легко не показать там, где нужно, и наоборот.",
    "«Посадочные талоны…» — тоже тройное условие (была виза + посещал Шенген после 10.04.2026 + штампы не ставили) и очень длинная формулировка.",
    "Род деятельности в подобласти «перед подачей» определяется по подстрокам («ип», «учащ», «пенси», «самозанят»). Это хрупко: напр. «Владелец бизнеса или ИП» всегда триггерит ИП-документы (в названии есть «ИП»), даже если человек — владелец бизнеса без статуса ИП.",
    "У Японии на этапе «Подготовка документов» НЕТ стандартного списка документов — только подобласть «перед подачей» (если задана дата записи) и свободная зона загрузки. Если дата записи не указана, на этом этапе у Японии нет запрашиваемых документов. Возможно, это не задумано.",
    "«Справка с работы или учёбы» (Шенген, этап 2) показывается, если «Наименование работодателя/учёбы» ≠ «НЕТ». Зависимость от точного текста поля — потенциально хрупкая.",
    "Большинство вопросов «Да/Нет» в опроснике Шенгена технически НЕ обязательны (нет required): клиент может отправить опросник, не ответив про спонсора, 2-й загран, визы и т.д. Пропуск срабатывает как «Нет» — соответствующие документы просто не запросятся.",
    "В японском опроснике «Цель визита» не обязательна. Если клиент её пропустит, ЛК запросит «Приглашение» и «План поездки», как будто цель ≠ Туризм (условие «не равно Туризм» истинно и для пустого ответа)."
  ],
  directions: {
    schengen: {
      title: "Шенген",
      params: [
        { key: "crmCountry", label: "Страна оформления (в CRM)", opts: ["Другая", "Испания", "Португалия", "Кипр"], def: "Другая" },
        { key: "tripPurpose", label: "Цель поездки", opts: ["Туризм", "Иная (бизнес/частный/лечение/обучение/иное)"], def: "Туризм" },
        { key: "occupation", label: "Род деятельности", opts: ["Работа по найму", "Владелец бизнеса или ИП", "Самозанятый", "Пенсионер", "Учащийся", "Безработный"], def: "Работа по найму" },
        { key: "employer", label: "Указано место работы/учёбы", opts: ["Указано", "НЕТ"], def: "Указано" },
        { key: "hasActiveSchengen", label: "Действующая шенгенская виза", opts: ["Нет", "Да"], def: "Нет" },
        { key: "hadSchengen3Years", label: "Были визы за 3 года", opts: ["Нет", "Да"], def: "Нет" },
        { key: "hasSponsor", label: "Поездку спонсируют", opts: ["Нет", "Да"], def: "Нет" },
        { key: "isUnder18", label: "Младше 18 лет", opts: ["Нет", "Да"], def: "Нет" },
        { key: "hasSecondPassport", label: "Есть 2-й загранпаспорт", opts: ["Нет", "Да"], def: "Нет" },
        { key: "canSurrenderPassport", label: "Может сдать 2-й паспорт", opts: ["Да", "Нет"], def: "Да" },
        { key: "surrenderReason", label: "Причина не сдачи 2-го паспорта", opts: ["—", "Поездка в третью страну", "Подача на другую визу", "Иное"], def: "—" },
        { key: "hasOwnAccommodation", label: "Своё проживание", opts: ["Нет", "Да"], def: "Нет" },
        { key: "hasOwnTransport", label: "Свой транспорт/авиабилеты", opts: ["Нет", "Да"], def: "Нет" },
        { key: "notRussianCitizen", label: "Не гражданин РФ", opts: ["Нет", "Да"], def: "Нет" },
        { key: "hasInsurance", label: "Есть своя страховка", opts: ["Нет", "Да"], def: "Нет" },
        { key: "visitedSchengenAfterApr2026", label: "Посещал Шенген после 10.04.2026", opts: ["Нет", "Да"], def: "Нет" },
        { key: "hadBorderStamps", label: "Ставили штампы на границе", opts: ["Да", "Нет"], def: "Да" },
        { key: "submitWindow", label: "До «Даты записи на подачу»", opts: ["нет даты / > 7 дней", "≤ 7 дней"], def: "нет даты / > 7 дней" }
      ],
      docsByStage: {
        "0": [
          { label: "Внутренний паспорт (1-й разворот, прописка, последний разворот)", when: "всегда" },
          { label: "Загран. паспорт (в который запрашиваем визу)", when: "всегда" }
        ],
        "1": [
          { label: "Электронное фото", when: "если «Страна оформления/услуга» в CRM = Испания / Португалия / Кипр", cond: { f: "crmCountry", in: ["Испания", "Португалия", "Кипр"] } },
          { label: "Приглашение", when: "если цель поездки ≠ Туризм", cond: { f: "tripPurpose", ne: "Туризм" } }
        ],
        "2": [
          { label: "Фото действующей шенгенской визы", when: "если есть действующая виза", cond: { f: "hasActiveSchengen", eq: "Да" } },
          { label: "Фото последней шенгенской визы", when: "если были визы за 3 года", cond: { f: "hadSchengen3Years", eq: "Да" } },
          { label: "Внутр. паспорт спонсора или спонсорское письмо от компании", when: "если поездку спонсируют", cond: { f: "hasSponsor", eq: "Да" } },
          { label: "Свидетельство о рождении", when: "если младше 18", cond: { f: "isUnder18", eq: "Да" } },
          { label: "2-й загран. паспорт", when: "если есть 2-й загран", cond: { f: "hasSecondPassport", eq: "Да" } },
          { label: "Своё проживание (бронь / аренда / собственность)", when: "если своё проживание", cond: { f: "hasOwnAccommodation", eq: "Да" } },
          { label: "Свои авиабилеты или другой транспорт", when: "если свой транспорт", cond: { f: "hasOwnTransport", eq: "Да" } },
          { label: "Билеты в третью страну", when: "если есть 2-й загран + не сдаёт его + причина «Поездка в третью страну»", cond: { all: [{ f: "hasSecondPassport", eq: "Да" }, { f: "canSurrenderPassport", eq: "Нет" }, { f: "surrenderReason", eq: "Поездка в третью страну" }] } },
          { label: "ВНЖ или регистрация", when: "если не гражданин РФ", cond: { f: "notRussianCitizen", eq: "Да" } },
          { label: "Справка с работы или учёбы", when: "если указано место работы/учёбы (≠ «НЕТ»)", cond: { f: "employer", ne: "НЕТ" } },
          { label: "Страховой полис для въезда в Шенген", when: "если есть своя страховка", cond: { f: "hasInsurance", eq: "Да" } },
          { label: "Посадочные талоны и (или) иные подтверждения того, что вы использовали предыдущую визу", when: "если была виза (действующая/за 3 года) + посещал Шенген после 10.04.2026 + штампы не ставили", cond: { all: [{ any: [{ f: "hasActiveSchengen", eq: "Да" }, { f: "hadSchengen3Years", eq: "Да" }] }, { f: "visitedSchengenAfterApr2026", eq: "Да" }, { f: "hadBorderStamps", eq: "Нет" }] } }
        ]
      },
      presub: [
        { label: "Справка из банка об остатке средств", when: "всем (необязательна, если спонсируют)", opt: { f: "hasSponsor", eq: "Да" } },
        { label: "Выписка (детализация) по счёту", when: "всем (необязательна, если спонсируют)", opt: { f: "hasSponsor", eq: "Да" } },
        { label: "Документы на ИП (лист записи + свидетельство о регистрации)", when: "если «Владелец бизнеса или ИП»", cond: { f: "occupation", eq: "Владелец бизнеса или ИП" } },
        { label: "Справка из учебного заведения", when: "если «Учащийся»", cond: { f: "occupation", eq: "Учащийся" } },
        { label: "Пенсионное удостоверение или справка о пенсии", when: "если «Пенсионер»", cond: { f: "occupation", eq: "Пенсионер" } },
        { label: "Справка о самозанятости", when: "если «Самозанятый»", cond: { f: "occupation", eq: "Самозанятый" } },
        { label: "Справка из банка об остатке средств от спонсора", when: "если спонсируют", cond: { f: "hasSponsor", eq: "Да" } },
        { label: "Выписка (детализация) по счёту спонсора", when: "если спонсируют", cond: { f: "hasSponsor", eq: "Да" } },
        { label: "Внутренний паспорт спонсора", when: "если спонсируют", cond: { f: "hasSponsor", eq: "Да" } },
        { label: "Справка с места работы спонсора", when: "если спонсируют (необязательна)", cond: { f: "hasSponsor", eq: "Да" }, opt: true },
        { label: "Согласие на выезд ребёнка или замещающий документ", when: "если младше 18 (необязательна)", cond: { f: "isUnder18", eq: "Да" }, opt: true },
        { label: "Внутренние паспорта родителей", when: "если младше 18", cond: { f: "isUnder18", eq: "Да" } },
        { label: "Электронная выписка из ПФР", when: "всем (необязательна)", opt: true },
        { label: "Справка 2-НДФЛ", when: "всем (необязательна)", opt: true }
      ],
      qrecs: [
        "Большинство вопросов «Да/Нет» технически можно пропустить (не помечены обязательными) — пропуск срабатывает как «Нет», и соответствующие документы не запросятся. Рекомендация: сделать ключевые «Да/Нет» вопросы (спонсор, 2-й загран, визы, страховка, младше 18) обязательными.",
        "«Наименование работодателя/учёбы» управляет запросом справки по точному тексту «НЕТ»: если клиент напишет «нет работы», «-», «безработный» — справка всё равно запросится. Рекомендация: отдельный вопрос «Работаете или учитесь?» (Да/Нет)."
      ],
      docRecs: [
        "«Электронное фото» зависит от CRM-поля «Страна оформления/услуга», а НЕ от ответа клиента «в какую страну виза». При расхождении полей документ запросится неверно (случай сотрудницы с Францией). Рекомендация: предупреждение при несовпадении страны CRM и опросника.",
        "Возможные дубли между обычным списком этапа «Подготовка документов» и подобластью «перед подачей»: спонсорские документы, справка с работы, 2-й загран и т.п. могут запрашиваться дважды. (Ждёт правил Насти — задачи 2/3.)",
        "«Билеты в третью страну» — тройное условие (2-й загран + не сдаёт + причина «Поездка в третью страну»); легко получить неверный показ. Рекомендация: проверить на реальных кейсах.",
        "«Посадочные талоны и (или) иные подтверждения…» — тройное условие и очень длинная формулировка. Рекомендация: упростить текст для клиента.",
        "Род деятельности в подобласти «перед подачей» определяется по подстрокам («ип», «учащ», «пенси», «самозанят»): «Владелец бизнеса или ИП» всегда триггерит ИП-документы, даже если человек — владелец бизнеса без статуса ИП. Рекомендация: разделить «Владелец бизнеса» и «ИП» на два варианта."
      ],
      questions: [
        { q: "Полное имя (ФИО)", req: "Да", shows: "всегда", effect: "Имя папки заявителя на Я.Диске, подписи всех файлов, проверка дубликата заявителя." },
        { q: "У меня ранее были предыдущие фамилии (Да/Нет)", req: "Нет", shows: "всегда", effect: "«Да» открывает поле «Укажите все предыдущие фамилии». На документы не влияет." },
        { q: "Укажите все предыдущие фамилии", req: "Нет", shows: "если предыдущие фамилии = «Да»", effect: "Только данные опросника (PDF)." },
        { q: "Телефон", req: "Да", shows: "всегда", effect: "Только данные." },
        { q: "Почта", req: "Да", shows: "всегда", effect: "Только данные." },
        { q: "Семейное положение", req: "Да", shows: "всегда", effect: "Только данные." },
        { q: "При рождении было иное гражданство (Да/Нет)", req: "Нет", shows: "всегда", effect: "«Да» открывает поле «гражданство при рождении»." },
        { q: "Ваше гражданство при рождении", req: "Нет", shows: "если иное гражданство = «Да»", effect: "Только данные." },
        { q: "Я не гражданин РФ (галочка)", req: "Нет", shows: "всегда", effect: "Отмечена → этап 2: «ВНЖ или регистрация» (обязательный)." },
        { q: "Есть второе гражданство (Да/Нет)", req: "Нет", shows: "всегда", effect: "«Да» открывает поле «какое гражданство»." },
        { q: "Укажите второе гражданство", req: "Нет", shows: "если второе гражданство = «Да»", effect: "Только данные." },
        { q: "Есть второй заграничный паспорт (Да/Нет)", req: "Нет", shows: "всегда", effect: "«Да» → этап 2: «2-й загран. паспорт» (обяз.) + открывает вопросы «на какой паспорт оформляем» и «можете ли сдать 2-й паспорт»." },
        { q: "На какой паспорт оформляем все документы", req: "Нет", shows: "если 2-й паспорт = «Да»", effect: "Только данные." },
        { q: "Можете ли сдать второй паспорт в ВЦ (Да/Нет)", req: "Нет", shows: "если 2-й паспорт = «Да»", effect: "«Нет» открывает «причину не сдачи» и участвует в условии «Билеты в третью страну»." },
        { q: "Причина не сдачи второго паспорта", req: "Нет", shows: "если сдать паспорт = «Нет»", effect: "«Поездка в третью страну» (вместе с 2-м заграном и «не сдаёт») → этап 2: «Билеты в третью страну» (обяз.). «Иное» открывает текстовое поле." },
        { q: "Фактический адрес проживания", req: "Да", shows: "всегда", effect: "Только данные." },
        { q: "Род занятий (6 вариантов)", req: "Да", shows: "всегда", effect: "Влияет на подобласть «перед подачей» (этап 2, за 7 дней до записи): «Владелец бизнеса или ИП» → «Документы на ИП»; «Учащийся» → «Справка из учебного заведения»; «Пенсионер» → «Пенсионное удостоверение/справка»; «Самозанятый» → «Справка о самозанятости» (все обязательные)." },
        { q: "Наименование работодателя/учебной организации", req: "Да", shows: "всегда", effect: "Если ≠ «НЕТ» → этап 2: «Справка с работы или учёбы» (обяз.) + открывает телефон работодателя. Если написать «НЕТ» — справка не запрашивается." },
        { q: "Адрес работодателя/учебной организации", req: "Да", shows: "всегда", effect: "Только данные." },
        { q: "Телефон работодателя", req: "Да", shows: "если работодатель ≠ «НЕТ»", effect: "Только данные." },
        { q: "Цель поездки", req: "Да", shows: "всегда", effect: "≠ «Туризм» → этап 1: «Приглашение» (обяз.). «Иное» открывает поле подробностей." },
        { q: "Виза для собеседования на США в Польше (Да/Нет)", req: "Нет", shows: "всегда", effect: "Только данные." },
        { q: "Страна поездки", req: "Да", shows: "всегда", effect: "Только данные. ⚠ На документы не влияет." },
        { q: "В какую страну запрашивается виза (список 30 стран)", req: "Да", shows: "всегда", effect: "Включает биометрические уведомления (в т.ч. для Франции); блок записи ботом учитывает Францию/Испанию. ⚠ «Электронное фото» зависит от CRM-поля «Страна оформления/услуга», а НЕ от этого ответа." },
        { q: "Даты поездки (от/до)", req: "Да*", shows: "всегда", effect: "Обязательны, если не отмечено «Я ещё не знаю точных дат» — тогда вместо дат обязательна галочка-подтверждение сроков. Только данные." },
        { q: "Действующая шенгенская виза (Да/Нет)", req: "Нет", shows: "всегда", effect: "«Да» → этап 2: «Фото действующей визы» (обяз.) + открывает дату окончания + участвует в условии «Посадочные талоны»." },
        { q: "Дата окончания действующей визы", req: "Нет", shows: "если действующая виза = «Да»", effect: "Только данные." },
        { q: "Были шенгенские визы за последние 3 года (Да/Нет)", req: "Нет", shows: "всегда", effect: "«Да» → этап 2: «Фото последней визы» (обяз.) + открывает вопросы о неиспользованной визе + участвует в «Посадочных талонах»." },
        { q: "Не открыл/-а свою последнюю визу (Да/Нет)", req: "Нет", shows: "если визы за 3 года = «Да»", effect: "«Да» открывает поле причины." },
        { q: "Посещали Шенген после 10.04.2026 (Да/Нет)", req: "Нет", shows: "если есть действующая виза или были визы за 3 года", effect: "Вместе со «штампы не ставили» → этап 2: «Посадочные талоны…» (обяз.)." },
        { q: "Ставили штампы о пересечении границы (Да/Нет)", req: "Нет", shows: "если посещали Шенген после 10.04.2026 = «Да»", effect: "«Нет» → запрашиваются «Посадочные талоны…»." },
        { q: "Есть действующая страховка для Шенгена (Да/Нет)", req: "Нет", shows: "всегда", effect: "«Да» → этап 2: «Страховой полис» (обяз.). «Нет» открывает «хочу приобрести страховку»." },
        { q: "Я хочу приобрести страховку (Да/Нет)", req: "Нет", shows: "если страховка = «Нет»", effect: "Только данные (страховку оформляет офис; чек кладётся в папку «Чек по страховке» на Я.Диске)." },
        { q: "Своё проживание: бронь/аренда/собственность (Да/Нет)", req: "Нет", shows: "всегда", effect: "«Да» → этап 2: «Своё проживание» (обяз.)." },
        { q: "Свои авиабилеты / другой транспорт (Да/Нет)", req: "Нет", shows: "всегда", effect: "«Да» → этап 2: «Свои авиабилеты или другой транспорт» (обяз.)." },
        { q: "Младше 18 лет на момент подачи (Да/Нет)", req: "Нет", shows: "всегда", effect: "«Да» → этап 2: «Свидетельство о рождении» (обяз.); подобласть «перед подачей»: «Внутр. паспорта родителей» (обяз.), «Согласие на выезд ребёнка» (необяз.); открывает «законного представителя»." },
        { q: "ФИО законного представителя", req: "Нет", shows: "если младше 18 = «Да»", effect: "Только данные." },
        { q: "Поездку спонсирует третье лицо/компания (Да/Нет)", req: "Нет", shows: "всегда", effect: "«Да» → этап 2: «Внутр. паспорт спонсора или спонсорское письмо» (обяз.); подобласть «перед подачей»: справка из банка спонсора + выписка спонсора + внутр. паспорт спонсора (обяз.), справка с работы спонсора (необяз.); при этом СВОИ «Справка из банка» и «Выписка по счёту» становятся необязательными. Открывает ФИО спонсора." },
        { q: "ФИО/наименование спонсора", req: "Нет", shows: "если спонсор = «Да»", effect: "Только данные." },
        { q: "Тип подачи (Личная / Без присутствия)", req: "Да", shows: "всегда", effect: "Только данные." },
        { q: "Как забрать готовые документы", req: "Да", shows: "всегда", effect: "Только данные." },
        { q: "Документы на льготный консульский сбор (Да/Нет)", req: "Нет", shows: "всегда", effect: "Только данные." },
        { q: "Хочу воспользоваться записью ботом (Да/Нет)", req: "Нет", shows: "всегда", effect: "«Да» открывает блок записи: диапазон(ы) дат (для Испании — до 3 диапазонов), город, пожелания по датам и бизнес-залам; для Франции/Испании скрыто поле «Исключения». На документы не влияет." },
        { q: "Откуда вы о нас узнали", req: "Да", shows: "всегда", effect: "Только данные/статистика." },
        { q: "Примечания", req: "Нет", shows: "всегда", effect: "Только данные." },
        { q: "Подтверждения: правильность сведений, ответственность, перс. данные", req: "Да", shows: "всегда", effect: "Без них опросник не отправится." }
      ]
    },
    japan: {
      title: "Япония",
      stage2Note: "У Японии на этапе «Подготовка документов» нет стандартного списка документов — только подобласть «перед подачей» (если задана дата записи) и свободная зона загрузки.",
      params: [
        { key: "jp_tripPurpose", label: "Цель визита", opts: ["Туризм", "Иная (бизнес/семья/учёба/работа)"], def: "Туризм" },
        { key: "jp_hasOwnFlights", label: "Есть свои авиабилеты", opts: ["Нет", "Да"], def: "Нет" },
        { key: "jp_hasSponsor", label: "Поездку спонсируют", opts: ["Нет", "Да"], def: "Нет" },
        { key: "jp_isUnder18", label: "Младше 18 лет", opts: ["Нет", "Да"], def: "Нет" },
        { key: "occupation", label: "Род деятельности", opts: ["Работа по найму", "Индивидуальный предприниматель", "Самозанятый", "Учащийся", "Пенсионер", "Безработный", "Другое"], def: "Работа по найму" },
        { key: "submitWindow", label: "До «Даты записи на подачу»", opts: ["нет даты / > 7 дней", "≤ 7 дней"], def: "нет даты / > 7 дней" }
      ],
      docsByStage: {
        "0": [
          { label: "Внутренний паспорт (1-й разворот, прописка, последний разворот)", when: "всегда" },
          { label: "Загран. паспорт (в который запрашиваем визу)", when: "всегда" }
        ],
        "1": [
          { label: "Приглашение", when: "если цель визита ≠ Туризм", cond: { f: "jp_tripPurpose", ne: "Туризм" } },
          { label: "План поездки", when: "если цель визита ≠ Туризм", cond: { f: "jp_tripPurpose", ne: "Туризм" } },
          { label: "Авиабилеты", when: "если есть свои авиабилеты", cond: { f: "jp_hasOwnFlights", eq: "Да" } },
          { label: "Внутр. паспорт спонсора", when: "если спонсируют", cond: { f: "jp_hasSponsor", eq: "Да" } },
          { label: "Свидетельство о рождении", when: "если младше 18", cond: { f: "jp_isUnder18", eq: "Да" } },
          { label: "Справка с работы", when: "если «Работа по найму»", cond: { f: "occupation", eq: "Работа по найму" } },
          { label: "Справка с учёбы", when: "если «Учащийся»", cond: { f: "occupation", eq: "Учащийся" } }
        ],
        "2": []
      },
      presub: [
        { label: "Справка из банка об остатке средств", when: "всем (необязательна, если спонсируют)", opt: { f: "jp_hasSponsor", eq: "Да" } },
        { label: "Выписка (детализация) по счёту", when: "всем (необязательна, если спонсируют)", opt: { f: "jp_hasSponsor", eq: "Да" } },
        { label: "Документы на ИП (лист записи + свидетельство о регистрации)", when: "если «Индивидуальный предприниматель»", cond: { f: "occupation", eq: "Индивидуальный предприниматель" } },
        { label: "Справка из учебного заведения", when: "если «Учащийся»", cond: { f: "occupation", eq: "Учащийся" } },
        { label: "Пенсионное удостоверение или справка о пенсии", when: "если «Пенсионер»", cond: { f: "occupation", eq: "Пенсионер" } },
        { label: "Справка о самозанятости", when: "если «Самозанятый»", cond: { f: "occupation", eq: "Самозанятый" } },
        { label: "Справка из банка об остатке средств от спонсора", when: "если спонсируют", cond: { f: "jp_hasSponsor", eq: "Да" } },
        { label: "Выписка (детализация) по счёту спонсора", when: "если спонсируют", cond: { f: "jp_hasSponsor", eq: "Да" } },
        { label: "Внутренний паспорт спонсора", when: "если спонсируют", cond: { f: "jp_hasSponsor", eq: "Да" } },
        { label: "Справка с места работы спонсора", when: "если спонсируют (необязательна)", cond: { f: "jp_hasSponsor", eq: "Да" }, opt: true },
        { label: "Согласие на выезд ребёнка или замещающий документ", when: "если младше 18 (необязательна)", cond: { f: "jp_isUnder18", eq: "Да" }, opt: true },
        { label: "Внутренние паспорта родителей", when: "если младше 18", cond: { f: "jp_isUnder18", eq: "Да" } },
        { label: "Электронная выписка из ПФР", when: "всем (необязательна)", opt: true },
        { label: "Справка 2-НДФЛ", when: "всем (необязательна)", opt: true }
      ],
      qrecs: [
        "«Цель визита» не обязательна: если клиент её пропустит, ЛК запросит «Приглашение» и «План поездки», как при не-туризме (условие «≠ Туризм» истинно и для пустого ответа). Рекомендация: сделать вопрос обязательным."
      ],
      docRecs: [
        "На этапе «Подготовка документов» у Японии нет стандартного списка документов — только подобласть «перед подачей» (если задана дата записи) и свободная зона загрузки. Если дата не указана — на этапе нет запрашиваемых документов вовсе. Возможно, это не задумано.",
        "Подобласть «перед подачей» использует те же подстроки рода деятельности, что и Шенген, — те же риски неверного определения."
      ],
      questions: [
        { q: "Полное ФИО заявителя", req: "Да", shows: "всегда", effect: "Имя папки заявителя на Я.Диске, подписи файлов." },
        { q: "Ранее были другие имена/фамилии (галочка)", req: "Нет", shows: "всегда", effect: "Открывает поле «укажите другие имена/фамилии»." },
        { q: "Другие имена/фамилии", req: "Нет", shows: "если отмечена галочка", effect: "Только данные." },
        { q: "Семейное положение", req: "Да", shows: "всегда", effect: "«Состою в браке» открывает «род занятий супруга/-и»." },
        { q: "Род занятий супруга/-и", req: "Нет", shows: "если «Состою в браке»", effect: "Только данные." },
        { q: "Есть второе гражданство (галочка)", req: "Нет", shows: "всегда", effect: "Открывает поле «какое гражданство»." },
        { q: "На какой загранпаспорт оформляем визу", req: "Да", shows: "всегда", effect: "Только данные." },
        { q: "Город выдачи паспорта", req: "Да", shows: "всегда", effect: "Только данные." },
        { q: "Цель визита (Туризм/Бизнес/Семья/Учёба/Работа)", req: "Нет ⚠", shows: "всегда", effect: "≠ «Туризм» → этап 1: «Приглашение» + «План поездки» (обяз.). ⚠ Вопрос не обязателен: пропуск срабатывает как «не Туризм» — оба документа запросятся." },
        { q: "Даты визита (от/до)", req: "Да", shows: "всегда", effect: "Только данные." },
        { q: "Города, которые планируете посетить", req: "Да", shows: "всегда", effect: "Только данные." },
        { q: "Я уже знаю, где буду проживать (галочка)", req: "Нет", shows: "всегда", effect: "Открывает название и адрес места проживания." },
        { q: "Есть свои авиабилеты (галочка)", req: "Нет", shows: "всегда", effect: "Отмечена → этап 1: «Авиабилеты» (обяз.)." },
        { q: "Уже был/-а в Японии ранее (галочка)", req: "Нет", shows: "всегда", effect: "Открывает поле со списком визитов." },
        { q: "Фактический адрес проживания в РФ", req: "Да", shows: "всегда", effect: "Только данные." },
        { q: "Контактный телефон", req: "Да", shows: "всегда", effect: "Только данные." },
        { q: "Электронная почта", req: "Да", shows: "всегда", effect: "Только данные." },
        { q: "Род занятий (7 вариантов)", req: "Да", shows: "всегда", effect: "«Работа по найму» → этап 1: «Справка с работы» (обяз.) + открывает поля работодателя; «Учащийся» → этап 1: «Справка с учёбы» (обяз.) + поля учёбы; подобласть «перед подачей»: «Индивидуальный предприниматель» → «Документы на ИП», «Самозанятый» → «Справка о самозанятости», «Пенсионер» → «Пенсионное», «Учащийся» → «Справка из учебного заведения». «Безработный» открывает «источник дохода», «Другое» — описание." },
        { q: "Поля работодателя / ИП / учёбы / дохода", req: "—", shows: "в зависимости от рода занятий", effect: "Только данные." },
        { q: "Заявитель младше 18 лет (галочка)", req: "Нет", shows: "всегда", effect: "Отмечена → этап 1: «Свидетельство о рождении» (обяз.); подобласть «перед подачей»: «Внутр. паспорта родителей» (обяз.), «Согласие на выезд» (необяз.); открывает ФИО отца и матери." },
        { q: "Меня приглашают в Японию (галочка)", req: "Нет", shows: "всегда", effect: "Открывает блок приглашающего (ФИО, адрес, кем приходится, статус в Японии). Сама галочка документы НЕ запрашивает — «Приглашение» зависит от «Цели визита»." },
        { q: "Поездку спонсирует другой человек (галочка)", req: "Нет", shows: "всегда", effect: "Отмечена → этап 1: «Внутр. паспорт спонсора» (обяз.); подобласть «перед подачей»: спонсорские документы (обяз.), своя банковская справка/выписка → необязательны." },
        { q: "Вопросы о правонарушениях (5 галочек + «ничего из перечисленного»)", req: "Нет", shows: "всегда", effect: "Любая отметка (кроме «ничего») открывает поле «Поясните». На документы не влияет." },
        { q: "Подтверждения: правильность сведений, ответственность, перс. данные", req: "Да", shows: "всегда", effect: "Проверяются при отправке — без них опросник не отправится." }
      ]
    }
  },
  // Все действия, которые ЛК инициирует во внешних системах (и значимые внутренние).
  actions: [
    { sys: "sms.ru", name: "SMS с кодом входа", when: "Клиент запрашивает код для входа в ЛК по номеру телефона", details: "Код действует 5 минут; повторная отправка — не чаще раза в 60 секунд; максимум 5 попыток ввода, потом код сбрасывается. Защита баланса sms.ru и от перебора кода." },
    { sys: "ЛК", name: "Запись авторизации в статистику", when: "Успешный вход клиента по коду", details: "Авторизация попадает в график «Новые авторизации» в админке. Служебные/исключённые номера не учитываются." },
    { sys: "amoCRM", name: "Поиск клиента и сделок по телефону", when: "Вход в ЛК и обновление данных в ЛК", details: "Ищутся контакты и сделки по номеру телефона. Результаты кэшируются (контакты ~2 мин, сделки ~30 сек), все запросы идут через лимитер 5 запросов/сек — защита аккаунта amoCRM от блокировки." },
    { sys: "Я.Диск", name: "Создание папки «Готовые документы (ЛК)»", when: "Первый вход клиента (для всех его активных сделок)", details: "Создаётся корневая папка в папке сделки. Пропускаются сделки на этапах «Паспорт готов» и «Обращение исполнено»." },
    { sys: "Я.Диск", name: "Папки заявителя + «Чек по страховке»", when: "Отправка/сохранение опросника", details: "Создаются «Готовые документы (ЛК)/<ФИО заявителя>» и подпапка «Чек по страховке» (туда офис кладёт чек, если страховку оформляем мы)." },
    { sys: "Я.Диск", name: "PDF опросника", when: "Отправка/сохранение опросника", details: "Генерируется файл «Опросник - <ФИО>.pdf» и кладётся в папку сделки. В статистике документов PDF опросника НЕ считается загруженным документом." },
    { sys: "amoCRM", name: "Задача «Клиент скорректировал опросник в личном кабинете VOYO»", when: "Клиент сохранил ПРАВКУ опросника (не первичную отправку)", details: "Ответственный: воронка «Отдел продаж» → поле «Ответственный» (если пусто — ответственный сделки); другие воронки → поле «Кто принял клиента» (если пусто — ответственный сделки); крайний случай — пользователь «Visa Services Center»." },
    { sys: "Я.Диск", name: "Загрузка документов клиента", when: "Клиент загружает документ (этапы 0–2)", details: "Файл кладётся в «Документы от клиентов из личного кабинета VSC/<телефон>/<номер сделки>». Имя файла = название документа + ФИО заявителя." },
    { sys: "amoCRM", name: "Задача «Загрузились новые документы от клиента из ЛК»", when: "После загрузки документов клиентом", details: "Тип задачи — «Проверить доки». Ответственный выбирается по той же схеме: «Отдел продаж» → поле «Ответственный»; другие воронки → «Кто принял клиента»; затем ответственный сделки; крайний случай — «Visa Services Center»." },
    { sys: "Я.Диск", name: "Распаковка ZIP и дедупликация файлов", when: "Фоном после загрузки документов", details: "ZIP-архивы распаковываются, дубликаты файлов убираются — чтобы офис видел чистый список." },
    { sys: "ЛК", name: "Блок «Ваши готовые документы»", when: "Этап «Ожидание подачи» (статусы «Документы готовы к личной подаче», «Ожидает передачи на рассмотрение в Консульство», «Передано Клиенту для личной подачи»)", details: "Клиент видит файлы из папки «Готовые документы (ЛК)» (их кладёт отдел оформления) и может скачать каждый файл или все сразу." }
  ],
  actionRecs: [
    "Каждая порция загруженных документов создаёт отдельную задачу «Загрузились новые документы…» — если клиент грузит документы в несколько заходов, задачи могут дублироваться. Рекомендация: не создавать новую задачу, пока предыдущая такая же не закрыта.",
    "Каждое сохранение правки опросника создаёт отдельную задачу «Клиент скорректировал опросник…» — при серии правок подряд возможен «спам» задач на ответственного.",
    "Клиент НЕ получает уведомление (SMS), когда отдел оформления выложил готовые документы на «Ожидании подачи» — он узнаёт о них, только зайдя в ЛК. Рекомендация: добавить SMS-уведомление «ваши документы готовы».",
    "Если в сделке не заполнено поле «Кто принял клиента» (или «Ответственный» в продажах) и нет ответственного сделки — задачи падают на сервисного пользователя «Visa Services Center», где их легко не заметить. Рекомендация: контролировать заполнение этих полей."
  ],
  // Все области загрузки документов клиентского ЛК (раздел «Области загрузки»).
  uploadAreas: [
    {
      name: "Основная область документов — этап 0 «Начало оформления»",
      dirs: "Шенген и Япония",
      appears: "Всегда на этапе 0, отдельный блок на каждого заявителя. Если опросник ещё не заполнен — пустой блок с паспортами: при попытке загрузки спросим ФИО (модальное окно) и создадим предварительного заявителя, который потом объединится с данными опросника.",
      composition: "Внутренний паспорт (1-й разворот, прописка, последний разворот) + загранпаспорт, в который запрашиваем визу. Оба обязательные.",
      color: "Красная плашка «Необходимо загрузить все документы ниже» → зелёная «✓ Все обязательные документы прикреплены». Пересчёт мгновенный — при каждом прикреплении/удалении файла, ещё до нажатия «Загрузить».",
      complete: "Закрыть полностью можно всегда — состав фиксированный. После полной загрузки блок сворачивается в «Документы загружены» с кнопкой «Скорректировать документы» (точечная замена файла через список).",
      notes: "Загрузка одной кнопкой «Загрузить» на блок; файлы → Я.Диск, в amoCRM создаётся задача «Загрузились новые документы от клиента из ЛК»."
    },
    {
      name: "Основная область — этап 1 «Первичный сбор документов»",
      dirs: "Шенген и Япония (состав разный)",
      appears: "Всегда на этапе 1. Кумулятивно: незагруженные паспорта с этапа 0 остаются в списке.",
      composition: "Шенген: «Электронное фото» (если «Страна оформления/услуга» в CRM = Испания/Португалия/Кипр) и «Приглашение» (если цель ≠ Туризм). Япония: «Приглашение» + «План поездки» (цель ≠ Туризм), «Авиабилеты» (есть свои), «Внутр. паспорт спонсора», «Свидетельство о рождении» (<18), «Справка с работы» / «Справка с учёбы» (по роду занятий). Все показанные документы обязательные.",
      color: "Та же плашка: красная → зелёная, когда все обязательные прикреплены.",
      complete: "Закрыть полностью можно всегда — состав определяется уже данными ответами опросника. Если ни одно условие не сработало, в области остаются только паспорта (или она уже закрыта).",
      notes: "Документ, чьё условие не выполняется, просто не показывается."
    },
    {
      name: "Основная область — этап 2 «Подготовка документов»",
      dirs: "Только Шенген (у Японии основной области на этапе 2 нет)",
      appears: "Всегда на этапе 2 у Шенгена. Кумулятивно: всё незагруженное с этапов 0–1 + до 12 условных документов (фото действующей/последней визы, спонсорские, свидетельство о рождении, 2-й загран, проживание, транспорт, билеты в 3-ю страну, ВНЖ, справка с работы/учёбы, страховка, посадочные талоны).",
      composition: "Все показанные документы обязательные (красно-зелёная плашка одна на блок).",
      color: "Та же плашка: красная → зелёная, когда все обязательные прикреплены.",
      complete: "Закрыть полностью можно всегда. Системных случаев «нельзя загрузить» нет — но клиент может физически не иметь документа (например, утерял посадочные талоны): тогда область остаётся красной до решения с менеджером.",
      notes: "У Японии на этапе 2 вместо основной области — свободная зона загрузки и подобласть «перед подачей» (если задана дата записи)."
    },
    {
      name: "Подобласть «Документы для проверки перед подачей»",
      dirs: "Шенген и Япония",
      appears: "Только на этапе 2 и только когда до «Даты записи на подачу» (поле сделки amoCRM) осталось 7 дней или меньше. Если дата не заполнена — подобласть не появляется вовсе.",
      composition: "Банковская справка и выписка (всем; при спонсоре — необязательные), документы по роду занятий (ИП / учёба / пенсия / самозанятость), спонсорские (при спонсоре), детские (<18), ПФР и 2-НДФЛ (необязательные всем). Красные — обязательные, синие — необязательные с пометкой «уточните у менеджера».",
      color: "Красная плашка → зелёная «✓ Все обязательные документы для проверки перед подачей загружены» — когда загружены ВСЕ обязательные. Необязательные (синие) на цвет не влияют.",
      complete: "Обязательные закрыть можно всегда. ВАЖНО: пока они не загружены, точка этапа «Подготовка документов» у клиента ЖЁЛТАЯ (даже если основная область уже зелёная); после загрузки всех обязательных — зелёная.",
      notes: "Каждый документ грузится отдельно: своя кнопка «Загрузить», затем «✓ Загружено» и «Скорректировать файл». Область пересоздаётся после каждой загрузки — цвет пересчитывается сразу."
    },
    {
      name: "Свободная зона загрузки дополнительных документов",
      dirs: "Только Япония",
      appears: "Всегда на этапе 2 у Японии.",
      composition: "Любые дополнительные файлы по запросу менеджера — фиксированного списка нет, обязательных нет.",
      color: "Цвет не меняется — обязательных документов в зоне нет.",
      complete: "Понятия «загружено полностью» нет — зона всегда доступна для дозагрузки.",
      notes: "Если «Дата записи на подачу» не задана, у Японии на этапе 2 нет ни одного запрашиваемого документа — только эта зона (см. «Рекомендации» в «Запросе документов»)."
    },
    {
      name: "После этапа 2 областей загрузки нет",
      dirs: "Шенген и Япония",
      appears: "С этапа «Ожидание подачи» клиент документы больше не загружает.",
      composition: "На «Ожидании подачи» — блок «Ваши готовые документы» (скачивание файлов, которые положил отдел оформления). Дальше — информационные экраны (пауза/рассмотрение/паспорт готов/исполнено).",
      color: "—",
      complete: "—",
      notes: ""
    }
  ],
  uploadRecs: [
    "Зелёная плашка основной области загорается уже при ПРИКРЕПЛЕНИИ всех файлов — до нажатия «Загрузить». Клиент может увидеть зелёное, закрыть ЛК и не отправить файлы. Рекомендация: добавить в зелёный текст напоминание про кнопку «Загрузить» или зеленить только после фактической загрузки.",
    "Нет механизма «не могу предоставить документ»: если у клиента физически нет обязательного дока (например, утеряны посадочные талоны), область остаётся красной навсегда — закрыть её можно, только загрузив хоть что-то. Рекомендация: вариант «нет документа — согласовано с менеджером».",
    "Жёлтая точка этапа «Подготовка документов» не объясняется клиенту: основная область может быть уже зелёной, а точка — жёлтой из-за незакрытой подобласти «перед подачей». Выглядит противоречиво. Рекомендация: подсказка у жёлтой точки, что именно осталось."
  ],
  // Раздел «Заявители»: мультизаявитель, пакеты, пред-заявители, слияние.
  applicantsInfo: [
    { topic: "Сколько заявителей в сделке (пакеты)", detail: "Поле сделки amoCRM «Количество пакетов» задаёт максимум уникальных заявителей. На этапе «Подготовка документов» (этап 2), когда число уникальных ФИО достигло этого значения, кнопка «Заполнить ещё опросник» скрывается. Если поле не задано — ограничения нет." },
    { topic: "Кнопка «Заполнить ещё опросник»", detail: "Открывает опросник для следующего заявителя в новой вкладке: подставляются его порядковый номер, тип визы и ФИО предыдущего заявителя. На этапе 2 ограничивается «Количеством пакетов» (см. выше)." },
    { topic: "Кнопка «Скорректировать опросник» + список", detail: "Разворачивает список всех заявителей сделки; клик по заявителю открывает его опросник на редактирование (режим edit). После правки в amoCRM создаётся задача «Клиент скорректировал опросник…»." },
    { topic: "Блоки загрузки на каждого заявителя", detail: "На каждого заявителя — свой блок документов с его ФИО в заголовке и в подписях файлов. Состав блоков одинаковый, обязательность считается по каждому отдельно. «Всё загружено» = количество заявителей × все обязательные блоки." },
    { topic: "Предварительные заявители (паспорта до опросника)", detail: "Если клиент грузит паспорта на этапе «Начало оформления» ДО заполнения опросника, показывается модальное окно «Напишите пожалуйста ФИО заявителя на русском языке». По ФИО заводится «предварительный заявитель» — чтобы файлы легли в именованную папку, а не безымянно." },
    { topic: "Слияние пред-заявителя с опросником", detail: "Когда позже заполняется опросник с тем же ФИО, предварительный заявитель объединяется с полноценным: файлы и данные сводятся к одному заявителю. Сверка идёт по совпадению ФИО." },
    { topic: "Папки на Я.Диске и проверка дубля ФИО", detail: "Каждому заявителю — папка «Готовые документы (ЛК)/<ФИО>» (+ подпапка «Чек по страховке»). Внутри одной сделки нельзя завести двух заявителей с одинаковым ФИО: при вводе — «Опросник на это ФИО уже заполнен в этой сделке. Укажите другое ФИО», на сабмите — серверная страховка «Опросник на этого заявителя уже заполнен в рамках этой сделки»." }
  ],
  applicantsRecs: [
    "«Количество пакетов» ограничивает кнопку «Заполнить ещё опросник» только на этапе «Подготовка документов». На этапах 0–1 клиент может добавить больше заявителей, чем оплачено пакетов. Рекомендация: единое ограничение или предупреждение на всех этапах.",
    "Слияние пред-заявителя с опросником — по точному совпадению ФИО. Если в модале и в опроснике ФИО написать по-разному (опечатка, другой порядок слов, лишний пробел) — получатся два заявителя и две папки. Рекомендация: нормализация ФИО / подсказка при вводе."
  ],
  // Раздел «Экраны клиента»: что видит клиент по 8 этапам, цвет статус-точки,
  // и валидации/сообщения об ошибках.
  dotRule: "Цвет точки этапа: серая — этап ещё не достигнут (будущий); текущий этап подсвечен; жёлтая (внимание) — только на текущем этапе 0–2, пока не загружены все обязательные документы; пройденные этапы — зелёные.",
  screens: [
    { stage: 0, title: "0 · Начало оформления", sees: "Загрузка двух паспортов (внутренний + загран) на каждого заявителя и кнопка «Заполните опросник». Если опросник ещё не заполнен — пустой блок паспортов с модалом ФИО при первой загрузке. Над списком — красная плашка «Необходимо загрузить все документы ниже», зеленеет, когда оба паспорта прикреплены.", dot: "Жёлтая, пока не загружены оба паспорта и/или не заполнен опросник. Если оба паспорта уже загружены — жёлтая снимается, даже если опросник не заполнен." },
    { stage: 1, title: "1 · Первичный сбор документов", sees: "Блоки документов: паспорта (кумулятивно, если ещё не загружены) + первый набор условных документов по ответам опросника. Все показанные обязательны. Красно-зелёная плашка области.", dot: "Жёлтая, пока не загружены все обязательные документы этапа." },
    { stage: 2, title: "2 · Подготовка документов", sees: "Документы этапов 0–1 + второй набор (кумулятивно). Кнопки «Скорректировать опросник» и «Заполнить ещё опросник». За 7 дней до «Даты записи на подачу» — подобласть «Документы для проверки перед подачей».", dot: "Жёлтая, пока не загружены все обязательные основной области; и отдельно — жёлтая, если активна подобласть «перед подачей» и в ней не загружены все обязательные (даже если основная область уже зелёная)." },
    { stage: 3, title: "3 · Ожидание подачи", sees: "Документы больше не загружаются. Блок «Ваши готовые документы» — список по заявителям с кнопками «Скачать» по каждому файлу и «Скачать все документы». Файлы кладёт отдел оформления.", dot: "Текущий этап (без жёлтого — загрузок нет); предыдущие зелёные." },
    { stage: 4, title: "4 · Оформление на паузе", sees: "Строка этапа «Оформление на паузе» + рекламный блок «Зарубежная банковская карта» (со ссылкой). Отдельного статусного текста нет.", dot: "Текущий этап, без жёлтого." },
    { stage: 5, title: "5 · Рассмотрение", sees: "Строка этапа «Рассмотрение» + рекламный блок «Зарубежная банковская карта». Отдельного текста «документы на рассмотрении» нет.", dot: "Текущий этап, без жёлтого." },
    { stage: 6, title: "6 · Паспорт готов", sees: "Строка этапа «Паспорт готов» + рекламный блок «Зарубежная банковская карта». Отдельного текста «заберите паспорт» нет.", dot: "Текущий этап, без жёлтого." },
    { stage: 7, title: "7 · Обращение исполнено", sees: "Строка этапа «Обращение исполнено» + блок «Подписывайтесь на наш Telegram-канал». В списке слева такие обращения уходят в «Предыдущие обращения».", dot: "Все этапы пройдены (зелёные)." }
  ],
  validations: [
    { rule: "Опросник · даты поездки", msg: "Если не отмечено «Я ещё не знаю точных дат» — оба поля дат обязательны: «Заполните даты поездки — оба поля обязательны»." },
    { rule: "Опросник · «не знаю дат»", msg: "Если отмечено — нужна галочка подтверждения сроков, иначе: «Поставьте галочку в чек-боксе подтверждения сроков»." },
    { rule: "Опросник · дубль ФИО", msg: "При вводе занятого ФИО: «Опросник на это ФИО уже заполнен в этой сделке. Укажите другое ФИО». На сабмите/вставке: «Опросник на этого заявителя уже заполнен в рамках этой сделки». Дублируется серверной проверкой." },
    { rule: "Опросник · биометрия и согласия", msg: "Для стран, требующих биометрический (десятилетний) загранпаспорт, показывается галочка-уведомление (для Франции — отдельная, для лиц старше 14 лет). Согласия (правильность сведений, ответственность, перс. данные) обязательны — без них опросник не отправится." },
    { rule: "Модал ФИО (паспорта до опросника)", msg: "ФИО короче 3 символов: «Введите полное ФИО»." },
    { rule: "Загрузка файлов", msg: "Лимит 1 файла — 20 МБ; принимаются изображения и PDF. Без прикреплённого файла: «Прикрепите файл для загрузки»; при сбое: «Ошибка загрузки файла»." },
    { rule: "Паспорта (пред-заявитель)", msg: "Если приложен неполный комплект: «Загрузите оба паспорта»." }
  ],
  screensRecs: [
    "На этапах «Оформление на паузе», «Рассмотрение», «Паспорт готов» клиент видит только рекламный блок банковской карты — нет успокаивающего статуса («ваши документы на рассмотрении», «паспорт готов — заберите»). Рекомендация: добавить информационный текст под этапом.",
    "Жёлтая точка не объясняет причину (повтор из «Областей загрузки»): клиент не понимает, что именно осталось сделать.",
    "Сообщения об ошибках загрузки обобщённые («Ошибка загрузки файла») — не подсказывают причину (размер / формат / сеть). Рекомендация: конкретизировать сообщение."
  ]
};
app.get("/admin/api/lk-tester-spec", requireStaff, (req, res) => {
  try {
    return res.json({ success: true, spec: LK_TESTER_SPEC });
  } catch (e) {
    return res.status(500).json({ success: false, message: "Ошибка" });
  }
});

// ═════════════════════════════════════════════════════════════════════════
// VSC — дашборд показателей визового агентства из Google-таблицы.
// Источник — опубликованная в вебе таблица (CSV по листам-месяцам). Сервер
// тянет листы, парсит и отдаёт агрегаты; кэш 15 мин. Только админ. На
// клиентский ЛК / amoCRM / Я.Диск никак не влияет (отдельный источник).
// ═════════════════════════════════════════════════════════════════════════
const VSC_PUB_BASE = "https://docs.google.com/spreadsheets/d/e/2PACX-1vQfS5TX6tFZbbSZTNZhWVqRYvxBSt84vUERG1HRzJ5NOjsHDD4dd5DSkg_fWrSzIRKVk0evV6BVnC1V/pub";
const VSC_SHEETS = [
  { name: "Январь 2026", gid: "1488691450" },
  { name: "Февраль 2026", gid: "1568094283" },
  { name: "Март 2026", gid: "1502719932" },
  { name: "Апрель 2026", gid: "1868729159" },
  { name: "Май 2026", gid: "352648437" },
  { name: "Июнь 2026", gid: "1371246931" },
  { name: "Июль 2026", gid: "95777680" }
];
// Парсер CSV (учитывает кавычки, экранирование "" и переводы строк внутри ячеек).
function vscParseCsv(text) {
  const rows = []; let row = [], field = "", i = 0, q = false;
  const s = String(text || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  while (i < s.length) {
    const c = s[i];
    if (q) {
      if (c === '"') { if (s[i + 1] === '"') { field += '"'; i += 2; continue; } q = false; i++; continue; }
      field += c; i++; continue;
    }
    if (c === '"') { q = true; i++; continue; }
    if (c === ",") { row.push(field); field = ""; i++; continue; }
    if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; i++; continue; }
    field += c; i++;
  }
  row.push(field); rows.push(row);
  return rows;
}
function vscNum(s) {
  if (s == null) return null;
  let t = String(s).replace(/ /g, " ").trim();
  if (!t || t.indexOf("#") >= 0 || /р\./.test(t)) return null;
  t = t.replace(/%/g, "").replace(/\s/g, "").replace(/,/g, ".");
  const v = parseFloat(t);
  return isNaN(v) ? null : v;
}
function vscIsDate(s) { return /^\d{2}\.\d{2}\.\d{4}$/.test(String(s || "").trim()); }
function vscParseMonth(rows) {
  let hi = -1;
  for (let i = 0; i < Math.min(rows.length, 15); i++) { if (rows[i] && String(rows[i][0]).trim() === "Дата") { hi = i; break; } }
  if (hi < 0) return null;
  const hdr = rows[hi];
  // Все колонки, чьё имя содержит ВСЕ ключевые слова (минус excl-подстроки).
  const colsAll = (kw, excl) => {
    const out = [];
    for (let i = 0; i < hdr.length; i++) {
      const nn = String(hdr[i] || "").replace(/\s+/g, " ").toLowerCase();
      if (kw.every((k) => nn.indexOf(k.toLowerCase()) >= 0) && !(excl || []).some((e) => nn.indexOf(e) >= 0)) out.push(i);
    }
    return out;
  };
  // Предпочитаем вариант с «(ФОРМУЛА)», иначе обычную колонку.
  const colF = (...kw) => { const f = colsAll(kw.concat("формула")); if (f.length) return f[0]; const o = colsAll(kw); return o.length ? o[0] : -1; };
  // ATV: «(ФОРМУЛА)» если есть, иначе обычная «ATV» — НЕ «Fulll ATV».
  const atvF = colsAll(["atv", "формула"]); const atvP = colsAll(["atv"], ["fulll", "формула"]);
  const C = {
    atv: atvF.length ? atvF[0] : (atvP.length ? atvP[0] : -1),
    asp: colF("asp"), upt: colF("upt"),
    cv: colF("итоговая конверсия общая"), cpl: colF("cpl", "общий"), drr: colF("дрр общая"),
    rev: colF("общая сумма выручки"), ad: colF("рекламные расходы общие"),
    budget: colF("общая сумма в бюджете"),
    factMSK: colF("таргет мск", "факт"), planMSK: colF("таргет мск", "план"),
    factSPB: colF("таргет спб", "факт"), planSPB: colF("таргет спб", "план")
  };
  // Обработанные контакты = сумма «Контакты, полученные до/после конца рабочего
  // дня» по всем городам (МСК/СПБ/ЕКБ/Остальные). Так считает заказчик
  // (март: AC+AD+AE+AF). НЕ путать с «Обработанные контакты <город>».
  const processedCols = colsAll(["полученные", "конца рабочего дня"]);
  // Недобор/перебор ОП — суммируем все региональные колонки (МСК/СПБ/ЕКБ или одну общую).
  const overCols = colsAll(["недобор/перебор", "оп"]);
  const sumNN = (r, cols) => { const v = cols.map((i) => vscNum(r[i])).filter((x) => x != null); return v.length ? v.reduce((a, b) => a + b, 0) : null; };
  // Отклонение таргета: (ФАКТ МСК + ФАКТ СПБ) − (ПЛАН МСК + ПЛАН СПБ).
  const targetDev = (r) => {
    const f = sumNN(r, [C.factMSK, C.factSPB].filter((i) => i >= 0));
    const p = sumNN(r, [C.planMSK, C.planSPB].filter((i) => i >= 0));
    return (f == null && p == null) ? null : ((f || 0) - (p || 0));
  };
  const pick = (r) => ({
    atv: C.atv >= 0 ? vscNum(r[C.atv]) : null, asp: vscNum(r[C.asp]), upt: vscNum(r[C.upt]),
    cv: vscNum(r[C.cv]), cpl: vscNum(r[C.cpl]), drr: vscNum(r[C.drr]),
    over: sumNN(r, overCols), targetDev: targetDev(r),
    processed: sumNN(r, processedCols),
    rev: vscNum(r[C.rev]), ad: vscNum(r[C.ad]), budget: C.budget >= 0 ? vscNum(r[C.budget]) : null,
    planPct: null // план ОП — месячная величина из сводного блока (см. ниже), не из дневной строки
  });
  const days = [], weeks = []; let blockStart = null, blockEnd = null, total = null;
  for (let i = hi + 1; i < rows.length; i++) {
    const r = rows[i]; if (!r || !r.length) continue;
    const c0 = String(r[0] || "").trim();
    if (vscIsDate(c0)) {
      days.push(Object.assign({ date: c0, weekday: String(r[1] || "").trim() }, pick(r)));
      if (!blockStart) blockStart = c0; blockEnd = c0;
    } else if (c0.toLowerCase() === "total") {
      const lbl = blockStart ? (blockStart.slice(0, 5) + "–" + (blockEnd || blockStart).slice(0, 5)) : ("Неделя " + (weeks.length + 1));
      weeks.push(Object.assign({ label: lbl }, pick(r)));
      blockStart = null; blockEnd = null;
    } else if (c0.toLowerCase() === "grand total") {
      total = pick(r);
    }
  }
  // Накопительные за месяц (недобор/перебор, отклонение таргета, обработанные)
  // считаем суммой по ФАКТИЧЕСКИ заполненным дням — Grand total у незавершённого
  // месяца включает пустые будущие дни и искажает накопленный эффект.
  if (total) {
    const filled = days.filter((d) => (d.processed != null && d.processed > 0) || (d.budget != null && d.budget > 0));
    const sumD = (k) => { const v = filled.map((d) => d[k]).filter((x) => x != null); return v.length ? v.reduce((a, b) => a + b, 0) : null; };
    total.over = sumD("over");
    total.targetDev = sumD("targetDev");
    total.processed = sumD("processed");
    total._filledDays = filled.length;
  }
  // План ОП (% выполнения) — из сводного блока месяца: строка «Выручка общая
  // от набора», колонка «ПРОЦЕНТ ВЫПОЛНЕНИЯ». Это одна величина на месяц.
  let pctCol = -1;
  for (let i = 0; i < rows.length && pctCol < 0; i++) {
    const r = rows[i] || [];
    for (let ci = 0; ci < r.length; ci++) { if (String(r[ci] || "").replace(/\s+/g, " ").toUpperCase() === "ПРОЦЕНТ ВЫПОЛНЕНИЯ") { pctCol = ci; break; } }
  }
  if (pctCol >= 0 && total) {
    for (const r of rows) { if (r && r.some((v) => String(v || "").toLowerCase().indexOf("выручка общая от набора") >= 0)) { total.planPct = vscNum(r[pctCol]); break; } }
  }
  return { days, weeks, total };
}
let _vscCache = null, _vscCacheAt = 0, _vscInflight = null;
const VSC_TTL_MS = 15 * 60 * 1000;
async function vscFetchAll() {
  // Листы Google тянем ПАРАЛЛЕЛЬНО (раньше — последовательно, 7 листов = долго).
  // Promise.all сохраняет порядок VSC_SHEETS; недоступный лист → null → отфильтруем.
  const results = await Promise.all(VSC_SHEETS.map(async (sh) => {
    try {
      const url = VSC_PUB_BASE + "?gid=" + sh.gid + "&single=true&output=csv";
      const r = await axios.get(url, { timeout: 15000, responseType: "text", transformResponse: [(d) => d] });
      const parsed = vscParseMonth(vscParseCsv(r.data));
      return parsed ? Object.assign({ name: sh.name }, parsed) : null;
    } catch (e) { return null; /* пропускаем недоступный лист */ }
  }));
  const months = results.filter(Boolean);
  // Год: суммируем аддитивные базы из месячных Grand total, ratio — производные/среднее.
  const withTotal = months.filter((m) => m.total);
  const sum = (f) => withTotal.reduce((a, m) => a + (m.total[f] || 0), 0);
  const avg = (f) => { const v = withTotal.map((m) => m.total[f]).filter((x) => x != null); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
  // Аддитивные базы суммируем; коэффициенты (ATV/CV/CPL/ДРР/план%) на год берём
  // как СРЕДНЕЕ по месяцам с данными — пересчитывать их из «сырых» баз рискованно
  // (у CPL/конверсии в таблице свои знаменатели, не равные суммируемым колонкам).
  // Точные годовые формулы докрутим, если в таблице появится годовая сводка.
  const year = {
    rev: sum("rev"), ad: sum("ad"), over: sum("over"), budget: sum("budget"),
    targetDev: sum("targetDev"), processed: sum("processed"),
    atv: avg("atv"), cv: avg("cv"), cpl: avg("cpl"), drr: avg("drr"),
    asp: avg("asp"), upt: avg("upt"), planPct: avg("planPct"),
    aggregate: "avg"
  };
  return { months, year, updatedAt: new Date().toISOString() };
}
async function getVscDashboard() {
  const now = Date.now();
  if (_vscCache && (now - _vscCacheAt) < VSC_TTL_MS) return _vscCache;
  if (_vscInflight) return _vscInflight;
  _vscInflight = vscFetchAll().then((res) => { _vscCache = res; _vscCacheAt = Date.now(); return res; }).finally(() => { _vscInflight = null; });
  return _vscInflight;
}
// Фоновый прогрев VSC-кэша (Google-таблица). Тянем свежее в фоне и атомарно
// подменяем кэш (stale-while-revalidate) — пользователю /vsc всегда отдаётся
// тёплый кэш, без ожидания. Интервал < TTL (15 мин). amoCRM здесь не трогаем.
(function scheduleVscPrewarm() {
  const VSC_PREWARM_MS = 13 * 60 * 1000;
  const warm = () => vscFetchAll()
    .then((res) => { _vscCache = res; _vscCacheAt = Date.now(); })
    .catch((e) => console.error("VSC PREWARM err:", e && e.message));
  setTimeout(warm, 15 * 1000);
  setInterval(warm, VSC_PREWARM_MS);
})();
app.get("/admin/api/vsc-dashboard", requireAdmin, async (req, res) => {
  try {
    const data = await getVscDashboard();
    return res.json(Object.assign({ success: true }, data));
  } catch (e) {
    console.error("vsc dashboard error:", e.message);
    return res.status(500).json({ success: false, message: "Не удалось загрузить данные таблицы" });
  }
});

// ═════════════════════════════════════════════════════════════════════════
// Клиентская сессия (ФАЗА 1). Подписанный токен (HMAC-SHA256) в httpOnly-cookie
// `voyo_sess`. Выдаётся при ЛЮБОМ успешном входе (SMS / Face ID по номеру /
// Face ID кнопкой). Stateless → переживает рестарты/деплои (никого не
// разлогинивает). На этом этапе cookie ТОЛЬКО выдаётся и читается через /api/me;
// существующие эндпоинты данных пока работают как раньше (по ?phone=) —
// обратная совместимость 100% (Фаза 2 переведёт их на сессию и закроет ?phone=).
// Если LK_SESSION_SECRET не задан — cookie просто не ставится, поведение = текущее.
const LK_SESSION_SECRET = process.env.LK_SESSION_SECRET || "";
const LK_SESSION_TTL_MS = 90 * 24 * 3600 * 1000; // 90 дней — «залогинен» как сейчас
const _b64url = (buf) => Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
function signClientSession(phone) {
  if (!LK_SESSION_SECRET || !phone) return null;
  const body = _b64url(JSON.stringify({ phone: String(phone), exp: Date.now() + LK_SESSION_TTL_MS }));
  const sig = _b64url(crypto.createHmac("sha256", LK_SESSION_SECRET).update(body).digest());
  return body + "." + sig;
}
function verifyClientSession(token) {
  if (!LK_SESSION_SECRET || !token || typeof token !== "string") return null;
  const dot = token.indexOf(".");
  if (dot <= 0) return null;
  const body = token.slice(0, dot), sig = token.slice(dot + 1);
  const expSig = _b64url(crypto.createHmac("sha256", LK_SESSION_SECRET).update(body).digest());
  let a, b;
  try { a = Buffer.from(sig); b = Buffer.from(expSig); } catch (_) { return null; }
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let payload;
  try { payload = JSON.parse(Buffer.from(body.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8")); } catch (_) { return null; }
  if (!payload || !payload.phone || !payload.exp || Date.now() > payload.exp) return null;
  return payload;
}
function readCookie(req, name) {
  const raw = String((req && req.headers && req.headers.cookie) || "");
  const m = raw.match(new RegExp("(?:^|;\\s*)" + name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "=([^;]+)"));
  return m ? decodeURIComponent(m[1]) : null;
}
function setClientSessionCookie(res, phone) {
  const token = signClientSession(phone);
  if (!token) return; // нет секрета — тихо пропускаем, поведение прежнее
  res.cookie("voyo_sess", token, { httpOnly: true, secure: true, sameSite: "lax", maxAge: LK_SESSION_TTL_MS, path: "/" });
}
// Текущий клиент по сессии (или null). На Фазе 1 используется только /api/me.
function clientPhoneFromSession(req) {
  const p = verifyClientSession(readCookie(req, "voyo_sess"));
  return p ? p.phone : null;
}
// Кто я по сессии. Фронт (Фаза 2) будет брать телефон отсюда вместо URL.
app.get("/api/me", (req, res) => {
  const phone = clientPhoneFromSession(req);
  if (!phone) return res.status(401).json({ success: false });
  return res.json({ success: true, phone });
});

app.post("/api/auth/verify", smsGate, (req, res) => {
  try {
    const phone = sms.normalizePhone((req.body && req.body.phone) || "");
    const code = String((req.body && req.body.code) || "").trim();

    if (!phone || !code) {
      return res.status(400).json({ success: false, message: "Введите код" });
    }

    const entry = smsCodeStore.get(phone);
    if (!entry) {
      return res.status(400).json({ success: false, message: "Запросите код заново" });
    }
    if (Date.now() > entry.expiresAt) {
      smsCodeStore.delete(phone);
      return res.status(400).json({ success: false, message: "Код истёк, запросите заново" });
    }
    if (entry.attempts >= SMS_MAX_ATTEMPTS) {
      smsCodeStore.delete(phone);
      return res.status(429).json({ success: false, message: "Слишком много попыток, запросите код заново" });
    }
    entry.attempts += 1;

    if (entry.code !== code) {
      return res.status(400).json({ success: false, message: "Неверный код" });
    }

    smsCodeStore.delete(phone);
    setClientSessionCookie(res, phone); // ФАЗА 1: выдаём сессию (тело ответа без изменений)
    try { recordLkAuth(phone); } catch (_) {}
    return res.json({ success: true, phone });
  } catch (err) {
    console.error("VERIFY CODE ERROR:", err);
    return res.status(500).json({ success: false, message: "Внутренняя ошибка" });
  }
});

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

// Маппинг статусов 3 воронок amoCRM на этапы клиентского ЛК (8 этапов).
// Этапы определены в CABINET_STAGES ниже. Особый случай — "Электронное
// рассмотрение" (Отдел Оформления): по дефолту → "Рассмотрение", но если
// "Страна оформления/услуга" содержит США / Великобритания — переезжает
// в "Подготовка документов". Эта развилка реализована в enrichLeadWithMappedStatus.
const STATUS_MAP = {
  "Отдел продаж": {
    "Ещё не связывались": { client_status: "Начало оформления" },
    "Ещё не связывались (для повторных сделок)": { client_status: "Начало оформления" },
    "Новый после Первой линии": { client_status: "Начало оформления" },
    "Недозвон": { client_status: "Начало оформления" },
    "Работа в одно касание": { client_status: "Начало оформления" },
    "Консультация": { client_status: "Начало оформления" },
    "Пришлёт документы на почту": { client_status: "Начало оформления" },
    "Сбор Документов": { client_status: "Начало оформления" },
    "Выставлен счёт через раздел Касса": { client_status: "Начало оформления" },
    "Оплачен счёт через раздел Касса": { client_status: "Начало оформления" },
    // Перенесены в hidden по ТЗ от 27.05.2026:
    "Рабочая виза": { hidden: true },
    "Юридическое лицо": { hidden: true },
    "США через рф": { hidden: true },
    "Отправлено на согласование партнеру": { hidden: true },
    "Контакт передан партнеру": { hidden: true },
    "Ожидаем оплату комиссии": { hidden: true },
    "Часть оплаты по ВНЖ": { hidden: true },
    "Успешно реализовано (для ВНЖ)": { hidden: true },
    "Дубль": { hidden: true },
    "Партнеры и подрядчики": { hidden: true },
    "Мусор": { hidden: true },
    "Мусор Китай (тур и не рф)": { hidden: true },
    "МУСОР ВНЖ(для старых сделок, не использу...)": { hidden: true },
    "Спам": { hidden: true },
    "Закрыто и не реализовано": { hidden: true }
  },

  "Отдел Оформления": {
    "Выставлен счёт через раздел Касса": { client_status: "Начало оформления" },
    "Оплачен счёт через раздел Касса": { client_status: "Начало оформления" },
    "Принято в работу": { client_status: "Подготовка документов" },
    "Согласование документов": { client_status: "Подготовка документов" },
    "Сбор оплачен": { client_status: "Подготовка документов" },
    "Исправить": { client_status: "Подготовка документов" },
    "Пакет документов готов": { client_status: "Подготовка документов" },
    "Запись сделана": { client_status: "Подготовка документов" },
    "Оформлен выкуп": { client_status: "Подготовка документов" },
    "Ожидает записи вручную": { client_status: "Подготовка документов" },
    "Ожидает записи через Бота": { client_status: "Подготовка документов" },
    "На паузе по просьбе Клиента": { client_status: "Оформление на паузе" },
    "ОЖИДАЕТ РЕШЕНИЯ О ВОЗВРАТЕ": { client_status: "Оформление на паузе" },
    // Дефолтная цель — "Рассмотрение"; для США/Великобритании переопределяется
    // на "Подготовка документов" в enrichLeadWithMappedStatus.
    "Электронное рассмотрение": { client_status: "Рассмотрение" },
    "Закрыто и не реализовано": { hidden: true }
  },

  "Отдел по работе с Клиентами": {
    "Визит в офис без оплаты": { client_status: "Начало оформления" },
    "Выставлен счёт через раздел Касса": { client_status: "Начало оформления" },
    "Оплачен счёт через раздел Касса": { client_status: "Начало оформления" },
    "Произведена оплата": { client_status: "Начало оформления" },
    "Сбор документов для ОО": { client_status: "Первичный сбор документов" },
    "Сбор дополнительных документов для ОО": { client_status: "Подготовка документов" },
    "Электронные документы переданы в Отдел ...": { client_status: "Подготовка документов" },
    "Принято в работу после ОО": { client_status: "Подготовка документов" },
    "Ожидает передачи на рассмотрение в Консульство": { client_status: "Ожидание подачи" },
    "Документы готовы к личной подаче": { client_status: "Ожидание подачи" },
    "Передано Клиенту для личной подачи": { client_status: "Ожидание подачи" },
    "На рассмотрении в Консульстве": { client_status: "Рассмотрение" },
    "Документы поданы лично Заявителем": { client_status: "Рассмотрение" },
    "Паспорт готов": { client_status: "Паспорт готов" },
    "Успешно реализовано": { client_status: "Обращение исполнено" },
    "Возврат": { client_status: "Обращение исполнено" },
    "Доплата": { hidden: true },
    "Закрыто и не реализовано": { hidden: true }
  }
};

// Порядок этапов клиентского ЛК. cabinet_stage_index в лидах = индекс в этом
// массиве. Изменение порядка/состава ломает сортировки в кабинете и админке —
// при ревизии всегда синхронно обновляй public/cabinet.html STAGES.
const CABINET_STAGES = [
  "Начало оформления",
  "Первичный сбор документов",
  "Подготовка документов",
  "Ожидание подачи",
  "Оформление на паузе",
  "Рассмотрение",
  "Паспорт готов",
  "Обращение исполнено"
];

// Дефолтный этап ЛК для лида, у которого pipeline/status не нашёлся в STATUS_MAP
// (новые статусы amoCRM, опечатки и т.п.). Берём самый ранний — "Начало оформления".
const CABINET_DEFAULT_STAGE = "Начало оформления";

// Страны, для которых "Электронное рассмотрение" из Отдела Оформления
// маппится не в "Рассмотрение", а в "Подготовка документов" (продолжается
// работа с документами на стороне VOYO).
const ELECTRONIC_REVIEW_PREP_COUNTRIES = ["США", "Великобритания"];
function isElectronicReviewPrepCountry(countryServiceValue) {
  const v = String(countryServiceValue || "").toLowerCase();
  if (!v) return false;
  return ELECTRONIC_REVIEW_PREP_COUNTRIES.some((c) => v.includes(c.toLowerCase()));
}

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

function escapeHtml(value = "") {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function extractPhonesFromContact(contact) {
  const fields = contact?.custom_fields_values || [];
  const values = [];

  for (const field of fields) {
    const code = String(field.field_code || "").toUpperCase();
    const name = String(field.field_name || "").toLowerCase();

    if (code === "PHONE" || name.includes("тел")) {
      for (const item of field.values || []) {
        if (item?.value) {
          values.push(normalizePhone(item.value));
        }
      }
    }
  }

  return [...new Set(values.filter(Boolean))];
}

function contactMatchesPhone(contact, phone) {
  const normalizedPhone = normalizePhone(phone);
  const phones = extractPhonesFromContact(contact);

  return phones.some((p) => {
    return p === normalizedPhone || p.endsWith(normalizedPhone) || normalizedPhone.endsWith(p);
  });
}

function normalizeText(value = "") {
  return String(value || "").trim().toLowerCase();
}

function findStatusMapEntry(pipelineName = "", statusName = "") {
  const normalizedPipeline = normalizeText(pipelineName);
  const normalizedStatus = normalizeText(statusName);

  for (const [mapPipelineName, statuses] of Object.entries(STATUS_MAP)) {
    if (normalizeText(mapPipelineName) !== normalizedPipeline) continue;

    for (const [mapStatusName, config] of Object.entries(statuses)) {
      if (normalizeText(mapStatusName) === normalizedStatus) {
        return config;
      }
    }
  }

  return null;
}

function getCabinetStageIndexByName(clientStatus) {
  return CABINET_STAGES.findIndex((item) => item === clientStatus);
}

function getCustomFieldValue(entity, fieldName) {
  const fields = entity?.custom_fields_values || [];
  const normalizedTarget = normalizeText(fieldName);

  for (const field of fields) {
    if (normalizeText(field.field_name) !== normalizedTarget) continue;
    const values = field.values || [];
    const first = values[0];

    if (!first) return "";
    if (typeof first.value === "string") return first.value;
    if (typeof first.value === "number") return String(first.value);
    if (first.enum) return String(first.enum);
    return "";
  }

  return "";
}

// ─────────────────────────────────────────────────────────────────────────
// Глобальный ограничитель исходящих запросов к amoCRM (token bucket + приоритет).
// amoCRM лимит ~7 RPS на аккаунт; его ПРЕВЫШЕНИЕ приводит не просто к 429, а к
// БЛОКИРОВКЕ аккаунта (инцидент 09.06.2026: шквал GET /contacts?query=...;
// повторный бан 15.06.2026 — превышение общего лимита аккаунта по API).
// Держим запас: не более AMO_MAX_RPS исходящих в секунду со ВСЕХ кодовых путей
// (кабинет, прогревы статистики, вебхуки и в т.ч. повторы-ретраи). При нормальной
// нагрузке токены доступны сразу — задержки нет; под всплеском запросы встают в
// очередь, но суммарный темп физически не может превысить лимит.
// AMO_MAX_RPS — устойчивый темп (refill, запр./сек); AMO_BURST — ёмкость бакета
// (допустимый мгновенный всплеск). Худшее окно в 1 сек = AMO_BURST + AMO_MAX_RPS,
// держим его НИЖЕ лимита amoCRM (7/сек) с запасом для веб-интерфейса/других
// интеграций аккаунта: 1 + 4 = 5 < 7.
//
// ДВЕ ОЧЕРЕДИ ПО ПРИОРИТЕТУ:
//   • high — клиентский ЛК и админка (по умолчанию, без обёртки). Всегда вперёд.
//   • low  — фон (вебхуки, прогревы статистики). Помечается amoBg(() => ...).
// Клиентский запрос НИКОГДА не ждёт за фоновым: при наличии токена он берётся
// первым; при его отсутствии будит лимитер по времени пополнения токена, а не
// по паузе фона. Так лимит RPS не создаёт клиенту дискомфорта.
//
// ПРЕДОХРАНИТЕЛЬ (circuit breaker): при 429/403 от amoCRM ставим на паузу ТОЛЬКО
// фон (low) — чтобы наши ретраи не разгоняли счётчик к бану. Клиент (high) при
// этом продолжает идти. Фон — основной источник объёма, его пауза снимает
// нагрузку и даёт аккаунту восстановиться без ущерба для клиентов.
const { AsyncLocalStorage } = require("async_hooks");
const amoPriorityStore = new AsyncLocalStorage();
// Пометить фоновый код низким приоритетом для лимитера amoCRM. ALS пробрасывает
// контекст сквозь await и колбэки, созданные синхронно внутри fn.
const amoBg = (fn) => amoPriorityStore.run("low", fn);

const AMO_MAX_RPS = 4;   // было 5
const AMO_BURST = 1;     // было 2; худшее окно теперь 4+1 = 5 < 7 (запас аккаунту)
let _amoTokens = AMO_BURST;
let _amoTokensTs = Date.now();
const _amoQHigh = []; // ожидающие резолверы — клиент/админ
const _amoQLow = [];  // ожидающие резолверы — фон
let _amoTimer = null;
let _amoLowPauseUntil = 0; // до этого времени фон (low) не обслуживается

function _amoRefillTokens() {
  const now = Date.now();
  const elapsedSec = (now - _amoTokensTs) / 1000;
  if (elapsedSec > 0) {
    _amoTokens = Math.min(AMO_BURST, _amoTokens + elapsedSec * AMO_MAX_RPS);
    _amoTokensTs = now;
  }
}
function _amoSchedulePump() {
  if (_amoTimer) { clearTimeout(_amoTimer); _amoTimer = null; }
  const now = Date.now();
  const tokenWaitMs = _amoTokens >= 1 ? 0 : Math.ceil(((1 - _amoTokens) / AMO_MAX_RPS) * 1000);
  const wakes = [];
  if (_amoQHigh.length) wakes.push(tokenWaitMs); // клиент — только по токену
  if (_amoQLow.length) wakes.push(Math.max(tokenWaitMs, _amoLowPauseUntil - now)); // фон — ещё и пауза
  if (!wakes.length) return;
  _amoTimer = setTimeout(() => { _amoTimer = null; _amoPump(); }, Math.max(20, Math.min(...wakes)));
}
function _amoPump() {
  _amoRefillTokens();
  const now = Date.now();
  while (_amoTokens >= 1) {
    let resolve = null;
    if (_amoQHigh.length) resolve = _amoQHigh.shift();           // приоритет клиента
    else if (_amoQLow.length && now >= _amoLowPauseUntil) resolve = _amoQLow.shift();
    else break;
    _amoTokens -= 1;
    resolve();
  }
  _amoSchedulePump();
}
function amoAcquireToken() {
  const low = amoPriorityStore.getStore() === "low";
  return new Promise((resolve) => {
    (low ? _amoQLow : _amoQHigh).push(resolve);
    _amoPump();
  });
}
// Вызывается из retry при ответе amoCRM 429/403: тормозим ТОЛЬКО фон.
function amoNoteThrottle(status) {
  if (status === 429) _amoLowPauseUntil = Math.max(_amoLowPauseUntil, Date.now() + 4000);
  else if (status === 403) _amoLowPauseUntil = Math.max(_amoLowPauseUntil, Date.now() + 30000);
}

// Унифицированный retry для всех вызовов amoCRM API. Защищает ВСЕ кодовые пути
// от 429/503/5xx и временных сетевых сбоев — включая клиентский флоу (find contact,
// load leads и т.д.). Каждая попытка (включая повторы) проходит через глобальный
// лимитер RPS — чтобы ретраи на 429 НЕ разгоняли счётчик обращений к блокировке.
async function amoRequestWithRetry(doRequest, label, maxAttempts = 5) {
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    await amoAcquireToken(); // глобальный лимит RPS (распространяется и на повторы)
    try {
      return await doRequest();
    } catch (e) {
      lastErr = e;
      const status = e.response && e.response.status;
      amoNoteThrottle(status); // 429/403 → пауза ТОЛЬКО фона (клиента не тормозим)
      const retryable = status === 429 || status === 503 || (status >= 500 && status < 600) || !status;
      if (!retryable || attempt === maxAttempts) throw e;
      // Уважаем Retry-After (сек) от amoCRM, если прислан; иначе экспоненциальный
      // backoff + джиттер: 250мс, 600мс, 1.4с, 3.2с.
      const retryAfterRaw = e.response && e.response.headers && e.response.headers["retry-after"];
      const retryAfterMs = retryAfterRaw ? Math.min(10000, (parseInt(retryAfterRaw, 10) || 0) * 1000) : 0;
      const base = 250 * Math.pow(2.3, attempt - 1);
      const delay = retryAfterMs || (base + Math.floor(Math.random() * 150));
      console.warn(`AMO RETRY ${label} attempt=${attempt}/${maxAttempts} status=${status || "net"} delay=${Math.round(delay)}ms`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

async function amoGet(url, params = {}) {
  console.log("AMO GET:", url, params);
  return amoRequestWithRetry(async () => {
    const response = await axios.get(url, {
      headers: { Authorization: `Bearer ${AMO_ACCESS_TOKEN}` },
      params
    });
    return response.data;
  }, `GET ${url}`);
}

async function amoGetByFullUrl(url) {
  console.log("AMO GET FULL URL:", url);
  return amoRequestWithRetry(async () => {
    const response = await axios.get(url, {
      headers: { Authorization: `Bearer ${AMO_ACCESS_TOKEN}` }
    });
    return response.data;
  }, `GET ${url}`);
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
    if (!nextUrl) break;
    page++;
  }

  return allItems;
}

// Параллельная пагинация. Концепция: тянем `concurrency` страниц одновременно,
// но различаем «реально пустую страницу» (= конец) и «упавший запрос» (rate-limit /
// network). Упавшие — повторяем последовательно с retry, чтобы НЕ ТЕРЯТЬ страницы.
// amoCRM rate-limit ~7 RPS; concurrency=4 даёт безопасный запас.
async function amoGetPageWithRetry(url, params, page, limit, maxAttempts = 3) {
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await amoGet(url, { ...params, page, limit });
    } catch (e) {
      lastErr = e;
      const status = e.response && e.response.status;
      const retryable = status === 429 || status === 503 || (status >= 500 && status < 600) || !status;
      if (!retryable || attempt === maxAttempts) throw e;
      // Экспоненциальный backoff: 300мс, 900мс, 2.7сек.
      await new Promise((r) => setTimeout(r, 300 * Math.pow(3, attempt - 1)));
    }
  }
  throw lastErr;
}

async function amoGetAllPagesParallel(url, params = {}, concurrency = 4) {
  const limit = 250;
  const allItems = [];
  let nextStart = 1;
  while (true) {
    const pages = Array.from({ length: concurrency }, (_, i) => nextStart + i);
    const results = await Promise.allSettled(
      pages.map((p) => amoGetPageWithRetry(url, params, p, limit))
    );

    // Обрабатываем результаты СТРОГО по порядку: на любом «упавшем» делаем
    // последовательный retry (вне race), чтобы данные не потерялись.
    let foundShortPage = false;
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      let data;
      if (r.status === "fulfilled") {
        data = r.value;
      } else {
        try {
          data = await amoGetPageWithRetry(url, params, pages[i], limit);
        } catch (e) {
          console.error(`amoGetAllPagesParallel page=${pages[i]} final fail:`, (e.response && e.response.data) || e.message);
          // Считаем, что данных там нет — продолжаем (НЕ обрываем общую пагинацию).
          continue;
        }
      }
      const embeddedKey = Object.keys(data._embedded || {})[0];
      const items = embeddedKey ? (data._embedded[embeddedKey] || []) : [];
      allItems.push(...items);
      if (items.length < limit) foundShortPage = true;
    }
    if (foundShortPage) break;
    nextStart += concurrency;
    // Защита от runaway: > 200 страниц = 50 000 элементов, явно что-то не так.
    if (nextStart > 200) break;
  }
  return allItems;
}

async function getEntityLinks(baseUrl, entityType, entityId) {
  try {
    const data = await amoGet(`${baseUrl}/api/v4/${entityType}/${entityId}/links`);
    return data?._embedded?.links || [];
  } catch (error) {
    console.error(`GET LINKS ERROR ${entityType}/${entityId}:`, error.response?.data || error.message);
    return [];
  }
}

async function getLeadById(baseUrl, leadId) {
  try {
    return await amoGet(`${baseUrl}/api/v4/leads/${leadId}`, { with: "contacts" });
  } catch (error) {
    console.error(`GET LEAD ERROR ${leadId}:`, error.response?.data || error.message);
    return null;
  }
}

// Возвращает массив id всех сделок контакта.
async function getContactLeadIds(baseUrl, contactId) {
  try {
    const data = await amoGet(`${baseUrl}/api/v4/contacts/${contactId}`, { with: "leads" });
    const leads = (data && data._embedded && data._embedded.leads) || [];
    return leads.map((l) => l.id).filter(Boolean);
  } catch (error) {
    console.error(`GET CONTACT LEADS ERROR ${contactId}:`, error.response?.data || error.message);
    return [];
  }
}

async function getPipelinesMap(baseUrl) {
  const pipelines = await amoGetAllPages(`${baseUrl}/api/v4/leads/pipelines`);
  const statusMap = new Map();

  for (const pipeline of pipelines) {
    const pipelineId = pipeline.id;
    const pipelineName = pipeline.name || "";
    const statuses = await amoGetAllPages(`${baseUrl}/api/v4/leads/pipelines/${pipelineId}/statuses`);

    for (const status of statuses) {
      statusMap.set(`${pipelineId}:${status.id}`, {
        pipeline_id: pipelineId,
        status_id: status.id,
        pipeline_name: pipelineName,
        status_name: status.name || ""
      });
    }
  }

  return statusMap;
}

// Кеш карты воронок/статусов на 10 минут — чтобы webhook'и от amoCRM, которые
// прилетают часто, не плодили лишние API-запросы.
let _cachedPipelinesMap = null;
let _cachedPipelinesMapTs = 0;
const PIPELINES_MAP_TTL_MS = 10 * 60 * 1000;
async function getCachedPipelinesMap(baseUrl) {
  const now = Date.now();
  if (_cachedPipelinesMap && (now - _cachedPipelinesMapTs) < PIPELINES_MAP_TTL_MS) {
    return _cachedPipelinesMap;
  }
  _cachedPipelinesMap = await getPipelinesMap(baseUrl);
  _cachedPipelinesMapTs = now;
  return _cachedPipelinesMap;
}

function enrichLeadWithMappedStatus(lead, statusesMap) {
  const statusMeta = statusesMap.get(`${lead.pipeline_id}:${lead.status_id}`) || {};
  const pipelineName = statusMeta.pipeline_name || lead.pipeline_name || "";
  const statusName = statusMeta.status_name || lead.status_name || "";
  const countryService = getCustomFieldValue(lead, "Страна оформления/услуга");
  // «Дата записи на подачу» — дата (amoCRM возвращает unix-секунды строкой).
  // Используется в кабинете на этапе «Подготовка документов»: за 7 дней до этой
  // даты открываем подобласть загрузки предподачных документов. Пусто → ничего.
  const submissionDateRaw = getCustomFieldValue(lead, "Дата записи на подачу");
  // «Количество пакетов» — целое число; используется в кабинете на этапе
  // «Подготовка документов» для решения, показывать ли кнопку «Заполнить
  // ещё опросник» (если опросников уже >= packets_count → скрываем).
  const packetsRaw = getCustomFieldValue(lead, "Количество пакетов");
  const packetsNum = parseInt(String(packetsRaw || "").trim(), 10);
  const packetsCount = Number.isFinite(packetsNum) && packetsNum > 0 ? packetsNum : null;

  const mapEntry = findStatusMapEntry(pipelineName, statusName);

  if (!mapEntry) {
    return {
      ...lead,
      pipeline_name: pipelineName,
      status_name: statusName,
      hidden_in_cabinet: false,
      cabinet_status: CABINET_DEFAULT_STAGE,
      cabinet_stage_index: getCabinetStageIndexByName(CABINET_DEFAULT_STAGE),
      country_service: countryService,
      submission_date: submissionDateRaw,
      packets_count: packetsCount
    };
  }

  if (mapEntry.hidden) {
    return {
      ...lead,
      pipeline_name: pipelineName,
      status_name: statusName,
      hidden_in_cabinet: true,
      cabinet_status: null,
      cabinet_stage_index: null,
      country_service: countryService,
      submission_date: submissionDateRaw,
      packets_count: packetsCount
    };
  }

  let cabinetStatus = mapEntry.client_status || CABINET_DEFAULT_STAGE;

  // Особый кейс: "Электронное рассмотрение" в Отделе Оформления для США/
  // Великобритании ведётся как "Подготовка документов" на стороне VOYO,
  // а не как реальное рассмотрение в Консульстве.
  if (
    normalizeText(pipelineName) === normalizeText("Отдел Оформления") &&
    normalizeText(statusName) === normalizeText("Электронное рассмотрение") &&
    isElectronicReviewPrepCountry(countryService)
  ) {
    cabinetStatus = "Подготовка документов";
  }

  const stageIndex = getCabinetStageIndexByName(cabinetStatus);

  return {
    ...lead,
    pipeline_name: pipelineName,
    status_name: statusName,
    hidden_in_cabinet: false,
    cabinet_status: cabinetStatus,
    cabinet_stage_index: stageIndex >= 0 ? stageIndex : 0,
    country_service: countryService,
    packets_count: packetsCount
  };
}

// Общая retry-обёртка для всех запросов к Я.Диску. Дёргает thunk до 5 раз
// с экспоненциальной паузой + jitter. Ретраим 423/429/5xx/сетевые таймауты.
// 4xx бизнес-логики (404/409/etc) — не ретраим, кидаем сразу.
async function yandexCallWithRetry(thunk, label = "") {
  const maxAttempts = 5;
  let attempt = 0;
  let lastError;
  while (attempt < maxAttempts) {
    try {
      return await thunk();
    } catch (err) {
      lastError = err;
      const status = err.response?.status;
      const retryable = status === 423 || status === 429 || (status >= 500 && status < 600) || !status;
      if (!retryable) throw err;
      attempt++;
      if (attempt >= maxAttempts) break;
      const delay = Math.min(2000, 200 * Math.pow(2, attempt - 1)) + Math.floor(Math.random() * 150);
      if (label) {
        console.log(`YANDEX RETRY ${label} attempt=${attempt}/${maxAttempts} status=${status || "?"} delay=${delay}ms`);
      }
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastError;
}

async function yandexRequest(config) {
  // Я.Диск может ответить 423 (Resource is locked), если одну и ту же папку/ресурс
  // одновременно трогает другая операция (параллельные ensureYandexFolder/upload в одну папку).
  // Делаем мягкий retry с экспоненциальной паузой, чтобы не падать на гонке.
  return yandexCallWithRetry(() => axios({
    ...config,
    headers: {
      Authorization: `OAuth ${YANDEX_DISK_TOKEN}`,
      ...(config.headers || {})
    },
    maxBodyLength: Infinity,
    maxContentLength: Infinity
  }), `${(config.method || "GET").toUpperCase()} ${config.url || ""}`);
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

  // Сам PUT файла на полученную upload-ссылку — тоже может ответить 423,
  // если параллельно идёт другая операция с этим же ресурсом. Без retry
  // юзер видит «Ошибка загрузки документа», хотя ретрай через секунду прошёл бы.
  await yandexCallWithRetry(() => axios.put(uploadUrl, buffer, {
    headers: {
      "Content-Type": contentType
    },
    maxBodyLength: Infinity,
    maxContentLength: Infinity
  }), `PUT upload ${diskPath}`);
}

async function listYandexFolderFiles(folderPath) {
  try {
    const r = await yandexRequest({
      method: "GET",
      url: "https://cloud-api.yandex.net/v1/disk/resources",
      params: { path: folderPath, limit: 1000, fields: "_embedded.items.name,_embedded.items.type" }
    });
    const items = r.data?._embedded?.items || [];
    return items.filter((i) => i.type === "file").map((i) => i.name);
  } catch (e) {
    if (e.response?.status === 404) return [];
    return [];
  }
}

// Проверяет, есть ли в папке хоть один ребёнок (файл или подпапка). Возвращает
// false если папки нет вовсе или она пуста.
async function yandexFolderHasAnyChildren(folderPath) {
  try {
    const r = await yandexRequest({
      method: "GET",
      url: "https://cloud-api.yandex.net/v1/disk/resources",
      params: { path: folderPath, limit: 1, fields: "_embedded.items.name" }
    });
    const items = r.data?._embedded?.items || [];
    return items.length > 0;
  } catch (e) {
    return false;
  }
}

// Проверяет существование ресурса (файла или папки) по path.
async function yandexResourceExists(path) {
  try {
    await yandexRequest({
      method: "GET",
      url: "https://cloud-api.yandex.net/v1/disk/resources",
      params: { path, fields: "type" }
    });
    return true;
  } catch (_e) {
    return false;
  }
}

// Серверное копирование ресурса (папки или файла) на Я.Диске. По умолчанию
// overwrite=false — если цель существует, бросает 409. Большие папки могут
// вернуть 202 с async-link, но axios не считает это ошибкой — окей.
async function copyYandexResource(fromPath, toPath, { overwrite = false } = {}) {
  await yandexRequest({
    method: "POST",
    url: "https://cloud-api.yandex.net/v1/disk/resources/copy",
    params: {
      from: fromPath,
      path: toPath,
      overwrite: overwrite ? "true" : "false"
    }
  });
}

async function downloadJsonFromYandexDisk(diskPath) {
  try {
    const linkResponse = await yandexRequest({
      method: "GET",
      url: "https://cloud-api.yandex.net/v1/disk/resources/download",
      params: { path: diskPath }
    });
    const downloadUrl = linkResponse.data.href;
    const fileResponse = await yandexCallWithRetry(
      () => axios.get(downloadUrl, { responseType: "text" }),
      `GET download(json) ${diskPath}`
    );
    return typeof fileResponse.data === "string"
      ? JSON.parse(fileResponse.data)
      : fileResponse.data;
  } catch (error) {
    if (error.response?.status === 404) return null;
    if (error.response?.data?.error === "DiskNotFoundError") return null;
    throw error;
  }
}

// ─── Тех. папка для JSON-стейта опросников ───
// С 2026-05-21 данные scope-ятся по (phone, leadId): "<phone>/<leadId>/TECH FOLDER/".
// До этой даты данные лежали по phone: "<phone>/TECH FOLDER/" — этот путь
// сохраняется как legacy и читается ТОЛЬКО для leadId-владельца (см. getLegacyOwnerLeadId).
// Ещё более старый legacy: "<phone>/Опросники/Технические файлы/".
const TECH_FOLDER_NAME = "TECH FOLDER";

function leadScopedFolder(phone, leadId) {
  return `${YANDEX_DISK_ROOT}/${phone}/${leadId}`;
}

function techFolderPath(phone, leadId) {
  // Новая схема (lead-scoped). Если leadId не передан — старый путь
  // (используется только при чтении legacy).
  if (leadId) return `${leadScopedFolder(phone, leadId)}/${TECH_FOLDER_NAME}`;
  return `${YANDEX_DISK_ROOT}/${phone}/${TECH_FOLDER_NAME}`;
}
function legacyTechFolderPath(phone) {
  return `${YANDEX_DISK_ROOT}/${phone}/Опросники/Технические файлы`;
}

// Список Опросник*.json для конкретного lead'а.
// Если leadId == legacy-owner → дополнительно мерджим файлы из legacy-папок.
async function listAllTechFiles(phone, leadId) {
  if (!phone) return [];
  const out = new Set();

  if (leadId) {
    const leadScoped = await listYandexFolderFiles(techFolderPath(phone, leadId));
    (leadScoped || []).forEach((n) => out.add(n));

    const ownerId = await getLegacyOwnerLeadId(phone);
    if (ownerId && String(ownerId) === String(leadId)) {
      const legacy1 = await listYandexFolderFiles(`${YANDEX_DISK_ROOT}/${phone}/${TECH_FOLDER_NAME}`);
      (legacy1 || []).forEach((n) => out.add(n));
      const legacy2 = await listYandexFolderFiles(legacyTechFolderPath(phone));
      (legacy2 || []).forEach((n) => out.add(n));
    }
  } else {
    // Backward compat: leadId не передан — читаем всё legacy
    const legacy1 = await listYandexFolderFiles(`${YANDEX_DISK_ROOT}/${phone}/${TECH_FOLDER_NAME}`);
    (legacy1 || []).forEach((n) => out.add(n));
    const legacy2 = await listYandexFolderFiles(legacyTechFolderPath(phone));
    (legacy2 || []).forEach((n) => out.add(n));
  }
  return Array.from(out);
}

async function loadApplicantJson(phone, leadId, applicantIndex) {
  const suf = applicantIndex > 1 ? ` ${applicantIndex}` : "";
  const fileName = `Опросник${suf}.json`;
  const candidates = [];

  if (leadId) {
    // Сначала пробуем lead-scoped
    candidates.push(`${techFolderPath(phone, leadId)}/${fileName}`);
    // Если этот leadId — legacy owner, добавляем legacy-пути как fallback
    const ownerId = await getLegacyOwnerLeadId(phone);
    if (ownerId && String(ownerId) === String(leadId)) {
      candidates.push(`${YANDEX_DISK_ROOT}/${phone}/${TECH_FOLDER_NAME}/${fileName}`);
      candidates.push(`${legacyTechFolderPath(phone)}/${fileName}`);
      candidates.push(`${YANDEX_DISK_ROOT}/${phone}/${fileName}`); // самый старый legacy
    }
  } else {
    // Backward compat
    candidates.push(`${YANDEX_DISK_ROOT}/${phone}/${TECH_FOLDER_NAME}/${fileName}`);
    candidates.push(`${legacyTechFolderPath(phone)}/${fileName}`);
    candidates.push(`${YANDEX_DISK_ROOT}/${phone}/${fileName}`);
  }

  for (const p of candidates) {
    try {
      const data = await downloadJsonFromYandexDisk(p);
      if (data) return data;
    } catch (_) {}
  }
  return null;
}

// ─── amoCRM↔Я.Диск интеграция: зеркалирование документов в папку сделки + zip ───
// Папки сделок лежат в /amoCRM/Сделки/<lead_id>/ (создаются интеграцией amoCRM↔Я.Диск),
// внутри сделки создаём свою папку «Документы из ЛК».
const AMO_DEALS_ROOT = "amoCRM/Сделки";
const AMO_DOCS_FOLDER_NAME = "Документы из ЛК";
const AMO_DOCS_ZIP_NAME = "Документы из ЛК.zip";
const TASK_RESPONSIBLE_FIELD_ID = 443488;

// ─── «Готовые документы (ЛК)» — выдача готовых документов клиенту ──────
// Лежит в папке сделки на Я.Диске РЯДОМ с «Документы из ЛК»
// (т.е. amoCRM/Сделки/<leadId>/Готовые документы (ЛК)). ОО кидают сюда
// архив (zip), внутри — подпапка на каждого заявителя (<ФИО>), а в ней —
// подпапка «Чек по страховке» (туда ОРК кладут чек по страховке).
const READY_DOCS_FOLDER_NAME = "Готовые документы (ЛК)";
const INSURANCE_SUBFOLDER_NAME = "Чек по страховке";
// Статусы amoCRM (этап ЛК «Ожидание подачи»), на которых клиенту показываем
// готовые документы. Все три относятся к «Ожидание подачи».
const READY_DOCS_VISIBLE_STATUSES = new Set([
  "Документы готовы к личной подаче",
  "Ожидает передачи на рассмотрение в Консульство",
  "Передано Клиенту для личной подачи"
]);
// Этапы ЛК, для активных сделок которых НЕ создаём «Готовые документы (ЛК)»
// при провижне (завершённые обращения).
const READY_DOCS_SKIP_STAGES = new Set(["Паспорт готов", "Обращение исполнено"]);

function readyDocsFolder(leadId) {
  return `${amoDealFolder(leadId)}/${READY_DOCS_FOLDER_NAME}`;
}
function readyDocsApplicantFolder(leadId, safeFio) {
  return `${readyDocsFolder(leadId)}/${safeFio}`;
}
function readyDocsInsuranceFolder(leadId, safeFio) {
  return `${readyDocsApplicantFolder(leadId, safeFio)}/${INSURANCE_SUBFOLDER_NAME}`;
}

// ─── Лимит файлов на одно обращение (lead) ──────────────────
// 200 файлов в папке «Документы из ЛК» (т.е. в зеркале сделки на Я.Диске).
// Считаем рекурсивно по факту с Я.Диска и кешируем в памяти на короткий TTL.
// .zip-архив и системные файлы в счёт не идут — это автогенерация.
const LEAD_FILE_LIMIT = 200;
const LEAD_COUNT_CACHE_TTL_MS = 30 * 1000;
const leadFileCountCache = new Map(); // leadId -> { count, ts }

async function getAmoLeadFileCount(leadId, { forceFresh = false } = {}) {
  if (!leadId) return 0;
  const cached = leadFileCountCache.get(leadId);
  if (!forceFresh && cached && (Date.now() - cached.ts) < LEAD_COUNT_CACHE_TTL_MS) {
    return cached.count;
  }
  let count = 0;
  try {
    const items = await listYandexFolderRecursive(amoDocsFolder(leadId));
    // Исключаем .zip-архивы (это сам автособираемый «Документы из ЛК.zip»,
    // если он по какой-то причине окажется внутри подпапки).
    count = items.filter((it) => !/\.zip$/i.test(it.name)).length;
  } catch (e) {
    // Если папки ещё нет (свежий lead) — count = 0, fail-open.
    count = 0;
  }
  leadFileCountCache.set(leadId, { count, ts: Date.now() });
  return count;
}

function bumpAmoLeadFileCount(leadId, delta) {
  if (!leadId) return;
  const cached = leadFileCountCache.get(leadId);
  if (cached) {
    cached.count = Math.max(0, cached.count + delta);
    cached.ts = Date.now();
  }
}

function invalidateAmoLeadFileCount(leadId) {
  if (leadId) leadFileCountCache.delete(leadId);
}

function amoDealFolder(leadId) {
  return `${AMO_DEALS_ROOT}/${leadId}`;
}
function amoDocsFolder(leadId) {
  return `${amoDealFolder(leadId)}/${AMO_DOCS_FOLDER_NAME}`;
}

// Single-flight по absolutePath: если для этой же папки уже идёт создание
// (например, две одновременных webhook-обработки одного контакта), второй
// вызов ждёт результат первого вместо параллельной гонки за создание тех
// же сегментов. Без этого Я.Диск пробивает retry-цепочку 423 и выкидывает
// ошибку в верхний слой (AMO MERGE TRANSFER ensure main folder error).
const _ensureNestedInflight = new Map(); // absolutePath → Promise
async function ensureNestedYandexFolder(absolutePath) {
  const existing = _ensureNestedInflight.get(absolutePath);
  if (existing) return existing;
  const p = (async () => {
    const parts = absolutePath.split("/").filter(Boolean);
    let acc = "";
    for (const part of parts) {
      acc = acc ? `${acc}/${part}` : part;
      await ensureYandexFolder(acc);
    }
  })().finally(() => {
    _ensureNestedInflight.delete(absolutePath);
  });
  _ensureNestedInflight.set(absolutePath, p);
  return p;
}

async function uploadToAmoDealDocs(leadId, relativePath, buffer, contentType) {
  await ensureNestedYandexFolder(amoDocsFolder(leadId));
  const segments = String(relativePath).split("/").filter(Boolean);
  const fileName = segments.pop();
  if (!fileName) throw new Error("relativePath is empty");
  let current = amoDocsFolder(leadId);
  for (const seg of segments) {
    current = `${current}/${seg}`;
    await ensureYandexFolder(current);
  }
  const fullPath = `${current}/${fileName}`;
  await uploadBufferToYandexDisk(buffer, fullPath, contentType);
  return fullPath;
}

async function listYandexFolderRecursive(folderPath, basePath = folderPath) {
  const out = [];
  try {
    const r = await yandexRequest({
      method: "GET",
      url: "https://cloud-api.yandex.net/v1/disk/resources",
      params: {
        path: folderPath,
        limit: 1000,
        fields: "_embedded.items.name,_embedded.items.type,_embedded.items.path,_embedded.items.size"
      }
    });
    const items = r.data?._embedded?.items || [];
    for (const item of items) {
      if (item.type === "dir") {
        const sub = await listYandexFolderRecursive(`${folderPath}/${item.name}`, basePath);
        out.push(...sub);
      } else if (item.type === "file") {
        const fullPath = `${folderPath}/${item.name}`;
        out.push({
          name: item.name,
          fullPath,
          relativePath: fullPath.slice(basePath.length + 1),
          size: item.size
        });
      }
    }
  } catch (e) {
    if (e.response?.status !== 404) {
      console.error("LIST FOLDER ERROR:", folderPath, e.response?.data || e.message);
    }
  }
  return out;
}

async function downloadYandexFileBuffer(diskPath) {
  const linkResponse = await yandexRequest({
    method: "GET",
    url: "https://cloud-api.yandex.net/v1/disk/resources/download",
    params: { path: diskPath }
  });
  const downloadUrl = linkResponse.data.href;
  const response = await yandexCallWithRetry(() => axios.get(downloadUrl, {
    responseType: "arraybuffer",
    maxBodyLength: Infinity,
    maxContentLength: Infinity
  }), `GET download(buf) ${diskPath}`);
  return Buffer.from(response.data);
}

async function deleteYandexResourceIfExists(diskPath) {
  try {
    await yandexRequest({
      method: "DELETE",
      url: "https://cloud-api.yandex.net/v1/disk/resources",
      params: { path: diskPath, permanently: "true" }
    });
  } catch (e) {
    if (e.response?.status === 404) return;
    console.error("DELETE Y.DISK ERROR:", diskPath, e.response?.data || e.message);
  }
}

async function rebuildAmoDocsZip(leadId) {
  const folder = amoDocsFolder(leadId);
  // Zip кладём в КОРЕНЬ папки сделки (а не внутрь «Документы из ЛК»), чтобы
  // интеграция amoCRM↔Я.Диск показывала его во вкладке «Файлы» сделки.
  const zipPath = `${amoDealFolder(leadId)}/${AMO_DOCS_ZIP_NAME}`;
  // Старый путь (внутри подпапки) тоже подчищаем — мог остаться от прошлых сборок.
  const legacyZipPath = `${folder}/${AMO_DOCS_ZIP_NAME}`;

  console.log(`AMO ZIP: rebuild start, folder=${folder}`);

  // Удаляем старые архивы, чтобы не попали в новый
  await deleteYandexResourceIfExists(zipPath);
  await deleteYandexResourceIfExists(legacyZipPath);

  const items = await listYandexFolderRecursive(folder);
  const filtered = items.filter((f) => !f.name.toLowerCase().endsWith(".zip"));
  console.log(`AMO ZIP: ${items.length} items found, ${filtered.length} after filtering .zip`);
  if (!filtered.length) {
    console.log(`AMO ZIP: nothing to zip, skipping upload`);
    return;
  }

  // Сначала качаем все буферы (последовательно, чтобы не словить 423/429 на Я.Диске).
  const entries = [];
  for (const item of filtered) {
    try {
      const buf = await downloadYandexFileBuffer(item.fullPath);
      entries.push({ buf, name: item.relativePath });
    } catch (e) {
      console.error("AMO ZIP fetch error:", item.fullPath, e.response?.data || e.message);
    }
  }
  console.log(`AMO ZIP: downloaded ${entries.length}/${filtered.length} files`);
  if (!entries.length) {
    console.log("AMO ZIP: no entries downloaded, skipping upload");
    return;
  }

  // Собираем zip в Buffer, надёжно дожидаясь end-события.
  const zipBuffer = await new Promise((resolve, reject) => {
    const archive = archiver("zip", { zlib: { level: 9 } });
    const chunks = [];
    archive.on("data", (chunk) => chunks.push(chunk));
    archive.on("warning", (w) => console.warn("AMO ZIP warning:", w.message || w));
    archive.on("error", reject);
    archive.on("end", () => resolve(Buffer.concat(chunks)));
    for (const e of entries) {
      archive.append(e.buf, { name: e.name });
    }
    archive.finalize().catch(reject);
  });

  console.log(`AMO ZIP: built ${zipBuffer.length} bytes, uploading to ${zipPath}`);
  await uploadBufferToYandexDisk(zipBuffer, zipPath, "application/zip");
  console.log(`AMO ZIP: uploaded successfully`);
}

async function amoPost(url, body) {
  console.log("AMO POST:", url, JSON.stringify(body));
  return amoRequestWithRetry(async () => {
    const response = await axios.post(url, body, {
      headers: {
        Authorization: `Bearer ${AMO_ACCESS_TOKEN}`,
        "Content-Type": "application/json"
      }
    });
    return response.data;
  }, `POST ${url}`);
}

function getEntityCustomFieldValue(entity, fieldId) {
  const fields = entity?.custom_fields_values || [];
  for (const f of fields) {
    if (Number(f.field_id) === Number(fieldId)) {
      const values = f.values || [];
      if (values.length) return values[0].value;
    }
  }
  return null;
}

// ── Авто-обнаружение элементов amoCRM (id'шники, которые могут отличаться у разных аккаунтов) ──
// Кешируем в памяти на время жизни процесса. Sentinel undefined = ещё не искали.
let _cachedTaskTypeProveritDokiId = undefined;
let _cachedKtoPrinyalFieldId = undefined;
let _cachedVscUserId = undefined;
let _cachedPacketsCountFieldId = undefined;

async function getProveritDokiTaskTypeId() {
  if (_cachedTaskTypeProveritDokiId !== undefined) return _cachedTaskTypeProveritDokiId;
  try {
    const baseUrl = `https://${AMO_SUBDOMAIN}.amocrm.ru`;
    const r = await amoGet(`${baseUrl}/api/v4/account`, { with: "task_types" });
    const taskTypes = (r && r._embedded && r._embedded.task_types) || [];
    const found = taskTypes.find((t) => {
      const name = String(t.name || "").toLowerCase().trim();
      return name === "проверить доки" || name.startsWith("проверить док");
    });
    if (found) {
      _cachedTaskTypeProveritDokiId = found.id;
      console.log(`AMO TASK TYPE «Проверить доки»: id=${found.id} name="${found.name}"`);
    } else {
      _cachedTaskTypeProveritDokiId = null;
      console.log(`AMO TASK TYPE «Проверить доки» NOT FOUND. Available: ${taskTypes.map((t) => `"${t.name}"(id=${t.id})`).join(", ")}`);
    }
  } catch (e) {
    console.error("getProveritDokiTaskTypeId error:", e.response?.data || e.message);
    _cachedTaskTypeProveritDokiId = null;
  }
  return _cachedTaskTypeProveritDokiId;
}

async function getKtoPrinyalFieldId() {
  if (_cachedKtoPrinyalFieldId !== undefined) return _cachedKtoPrinyalFieldId;
  try {
    const baseUrl = `https://${AMO_SUBDOMAIN}.amocrm.ru`;
    const fields = await amoGetAllPages(`${baseUrl}/api/v4/leads/custom_fields`);
    const found = (fields || []).find((f) => {
      const name = String(f.name || "").toLowerCase().trim();
      return name.indexOf("кто принял") === 0;
    });
    if (found) {
      _cachedKtoPrinyalFieldId = found.id;
      console.log(`AMO FIELD «Кто принял клиента»: id=${found.id} name="${found.name}" type="${found.type}"`);
    } else {
      _cachedKtoPrinyalFieldId = null;
      console.log("AMO FIELD «Кто принял клиента» NOT FOUND — задачи будут падать на Visa Services Center");
    }
  } catch (e) {
    console.error("getKtoPrinyalFieldId error:", e.response?.data || e.message);
    _cachedKtoPrinyalFieldId = null;
  }
  return _cachedKtoPrinyalFieldId;
}

async function getPacketsCountFieldId() {
  if (_cachedPacketsCountFieldId !== undefined) return _cachedPacketsCountFieldId;
  try {
    const baseUrl = `https://${AMO_SUBDOMAIN}.amocrm.ru`;
    const fields = await amoGetAllPages(`${baseUrl}/api/v4/leads/custom_fields`);
    const found = (fields || []).find((f) => {
      const name = String(f.name || "").toLowerCase().trim();
      return name === "количество пакетов" || name.indexOf("количество пакетов") >= 0;
    });
    if (found) {
      _cachedPacketsCountFieldId = found.id;
      console.log(`AMO FIELD «Количество пакетов»: id=${found.id} name="${found.name}" type="${found.type}"`);
    } else {
      _cachedPacketsCountFieldId = null;
      console.log("AMO FIELD «Количество пакетов» NOT FOUND — кнопка «Заполнить ещё опросник» на «Подготовке документов» не будет ограничиваться");
    }
  } catch (e) {
    console.error("getPacketsCountFieldId error:", e.response?.data || e.message);
    _cachedPacketsCountFieldId = null;
  }
  return _cachedPacketsCountFieldId;
}

async function getVscUserId() {
  if (_cachedVscUserId !== undefined) return _cachedVscUserId;
  try {
    const baseUrl = `https://${AMO_SUBDOMAIN}.amocrm.ru`;
    const users = await amoGetAllPages(`${baseUrl}/api/v4/users`);
    const found = (users || []).find((u) => {
      const name = String(u.name || "").toLowerCase().trim();
      return name === "visa services center" || name.indexOf("visa services center") >= 0;
    });
    if (found) {
      _cachedVscUserId = found.id;
      console.log(`AMO USER «Visa Services Center»: id=${found.id} name="${found.name}"`);
    } else {
      _cachedVscUserId = null;
      console.log("AMO USER «Visa Services Center» NOT FOUND — fallback не сработает, задачи будут без responsible");
    }
  } catch (e) {
    console.error("getVscUserId error:", e.response?.data || e.message);
    _cachedVscUserId = null;
  }
  return _cachedVscUserId;
}

// Возвращает {pipelineName, statusName} для (pipeline_id, status_id) сделки.
// Используется для определения, какой воронке принадлежит лид при выборе ответственного.
async function getLeadPipelineName(lead) {
  if (!lead || !lead.pipeline_id) return "";
  try {
    const baseUrl = `https://${AMO_SUBDOMAIN}.amocrm.ru`;
    const statusMap = await getCachedPipelinesMap(baseUrl);
    const meta = statusMap.get(`${lead.pipeline_id}:${lead.status_id}`);
    if (meta && meta.pipeline_name) return meta.pipeline_name;
  } catch (_) {}
  return "";
}

// Общая «начинка» для создания задачи «Проверить доки» на лиде: получаем
// тип задачи, ответственного по правилам воронки. Возвращает готовое тело
// для POST /api/v4/tasks (без поля text — его задаёт конкретный кейс).
async function _resolveAmoTaskTarget(leadId) {
  const baseUrl = `https://${AMO_SUBDOMAIN}.amocrm.ru`;
  const lead = await getLeadById(baseUrl, leadId);
  if (!lead) return null;

  // Тип задачи: «Проверить доки» (если есть в amoCRM), fallback — встроенный «Связаться» (id=1).
  let taskTypeId = await getProveritDokiTaskTypeId();
  if (!taskTypeId) taskTypeId = 1;

  // По воронке выбираем, кому ставим задачу.
  // «Отдел Продаж» (любые этапы, кроме hidden) → поле «Отв-ный/Ответственный» (TASK_RESPONSIBLE_FIELD_ID),
  //                                              пусто → ответственный по сделке.
  // «Отдел Оформления» / «Отдел по работе с Клиентами» → поле «Кто принял клиента»;
  //                                пусто → ОТВЕТСТВЕННЫЙ по сделке; и только если и его нет — «Visa Services Center».
  const pipelineName = await getLeadPipelineName(lead);
  const pipelineLow = String(pipelineName || "").toLowerCase().trim();
  const isSales = pipelineLow.indexOf("отдел продаж") === 0;

  let responsibleUserId = null;
  if (isSales) {
    const respRaw = getEntityCustomFieldValue(lead, TASK_RESPONSIBLE_FIELD_ID);
    const respNum = respRaw != null ? Number(respRaw) : NaN;
    if (Number.isFinite(respNum) && respNum > 0) responsibleUserId = respNum;
    if (!responsibleUserId) {
      const standardResp = lead && lead.responsible_user_id;
      const standardNum = standardResp != null ? Number(standardResp) : NaN;
      if (Number.isFinite(standardNum) && standardNum > 0) responsibleUserId = standardNum;
    }
  } else {
    const ktoFieldId = await getKtoPrinyalFieldId();
    if (ktoFieldId) {
      const ktoRaw = getEntityCustomFieldValue(lead, ktoFieldId);
      const ktoNum = ktoRaw != null ? Number(ktoRaw) : NaN;
      if (Number.isFinite(ktoNum) && ktoNum > 0) responsibleUserId = ktoNum;
    }
    // Поле «Кто принял клиента» пустое → ставим на ОТВЕТСТВЕННОГО по сделке,
    // а не на служебного «Visa Services Center» (из-за этого задачи падали на VSC).
    if (!responsibleUserId) {
      const standardResp = lead && lead.responsible_user_id;
      const standardNum = standardResp != null ? Number(standardResp) : NaN;
      if (Number.isFinite(standardNum) && standardNum > 0) responsibleUserId = standardNum;
    }
    // Крайний случай (нет ни поля, ни ответственного) — служебный VSC.
    if (!responsibleUserId) {
      const vscId = await getVscUserId();
      if (vscId) responsibleUserId = vscId;
    }
  }

  return { baseUrl, taskTypeId, pipelineName, isSales, responsibleUserId };
}

async function _createAmoTaskWithText(leadId, label, text) {
  if (!AMO_ACCESS_TOKEN || !AMO_SUBDOMAIN) return;
  if (!leadId) return;
  try {
    const target = await _resolveAmoTaskTarget(leadId);
    if (!target) return;
    const { baseUrl, taskTypeId, pipelineName, isSales, responsibleUserId } = target;
    const nowSec = Math.floor(Date.now() / 1000);
    const taskBody = [{
      task_type_id: taskTypeId,
      text,
      complete_till: nowSec,
      entity_id: Number(leadId),
      entity_type: "leads"
    }];
    if (responsibleUserId) taskBody[0].responsible_user_id = responsibleUserId;
    console.log(`CREATE TASK [${label}] lead=${leadId} pipeline="${pipelineName}" isSales=${isSales} taskTypeId=${taskTypeId} responsible=${responsibleUserId || "(default)"}`);
    await amoPost(`${baseUrl}/api/v4/tasks`, taskBody);
  } catch (e) {
    console.error(`CREATE AMO TASK ERROR [${label}]:`, e.response?.data || e.message);
  }
}

async function createAmoUploadTask(leadId) {
  return _createAmoTaskWithText(leadId, "upload", "Загрузились новые документы от клиента из ЛК.");
}

// Срабатывает при сохранении опросника в режиме корректировки (isEdit=1
// в /api/questionnaire). Тип задачи и ответственный — те же, что у задачи
// на загрузку документов, отличается только текст.
async function createAmoQuestionnaireCorrectionTask(leadId) {
  return _createAmoTaskWithText(leadId, "questionnaire-correction", "Клиент скорректировал опросник в личном кабинете VOYO");
}

// Per-leadId последовательная очередь: все операции с amoCRM/<lead_id>/Документы из ЛК/
// идут строго по порядку (зеркало файла → пересборка zip → задача), чтобы избежать гонок
// при загрузке батчем и race condition при пересборе zip.
const amoQueues = new Map();
function amoEnqueue(leadId, label, fn) {
  if (!leadId) return Promise.resolve();
  const key = String(leadId);
  const prev = amoQueues.get(key) || Promise.resolve();
  const next = prev.then(async () => {
    console.log(`AMO QUEUE START [lead ${key}] ${label}`);
    try {
      await fn();
      console.log(`AMO QUEUE DONE  [lead ${key}] ${label}`);
    } catch (e) {
      console.error(`AMO QUEUE ERROR [lead ${key}] ${label}:`, e.response?.data || e.message || e);
    }
  });
  amoQueues.set(key, next);
  return next;
}

// Зеркалирование одного или нескольких файлов в /amoCRM/Сделки/<lead_id>/Документы из ЛК/...
// БЕЗ пересборки zip и БЕЗ создания задачи — финализация делается отдельно.
function mirrorFilesToAmoFolder(leadId, files) {
  if (!leadId) {
    console.log("AMO MIRROR SKIP: no leadId");
    return;
  }
  const list = Array.isArray(files) ? files : [files];
  if (!list.length) return;
  for (const f of list) {
    if (!f || !f.relativePath || !f.buffer) continue;
    amoEnqueue(leadId, `mirror ${f.relativePath}`, async () => {
      await uploadToAmoDealDocs(leadId, f.relativePath, f.buffer, f.contentType || "application/octet-stream");
    });
  }
}

// Подходит ли файл под «поле заявителя» — имя начинается с "<targetName> - <safeFio>",
// дальше либо «.» (расширение сразу), либо « » (затем " (2).ext" / " (3).ext").
// Используется для очистки предыдущих версий загрузки при повторной загрузке того же поля.
function matchesFieldFile(filename, targetName, safeFio) {
  const prefix = `${targetName} - ${safeFio}`;
  if (!String(filename).startsWith(prefix)) return false;
  const next = String(filename).charAt(prefix.length);
  return next === "." || next === " ";
}

// Удаляет в зеркале сделки все ранее загруженные файлы этого поля для этого заявителя
// (любое расширение / любой partSuffix). Встаёт в очередь ПЕРЕД новыми mirror-операциями.
function cleanupAmoFieldFilesInMirror(leadId, safeFio, targetName) {
  if (!leadId) return;
  amoEnqueue(leadId, `cleanup ${safeFio}/${targetName}`, async () => {
    const folder = `${amoDocsFolder(leadId)}/${safeFio}`;
    try {
      const items = await listYandexFolderFiles(folder);
      for (const name of items) {
        if (matchesFieldFile(name, targetName, safeFio)) {
          await deleteYandexResourceIfExists(`${folder}/${name}`);
        }
      }
    } catch (e) {
      console.error("AMO MIRROR cleanup error:", e.message);
    }
  });
}

// Финализация: пересборка zip + (опционально) создание задачи в amoCRM.
// Встаёт в очередь ПОСЛЕ всех ранее поставленных mirror-операций для этого leadId.
function finalizeAmoUpload(leadId, options = {}) {
  if (!leadId) {
    console.log("AMO FINALIZE SKIP: no leadId");
    return Promise.resolve();
  }
  const { createTask = false } = options;
  return amoEnqueue(leadId, `finalize (zip${createTask ? "+task" : ""})`, async () => {
    await rebuildAmoDocsZip(leadId);
    if (createTask) {
      await createAmoUploadTask(leadId);
    }
  });
}

// Метка источника для leads, созданных через ЛК. Кладётся как тег amoCRM.
// Можно переопределить через .env: LK_SOURCE_VALUE (по умолчанию «VOYO»).
// ════════════════════════════════════════════════════════════════════
// «Готовые документы (ЛК)»: провижн папок, распаковка ZIP, дедуп, выдача.
// Всё фоновое (распаковка/дедуп) идёт ВНЕ пути клиентских запросов и
// сериализуется per-lead через amoEnqueue, чтобы не словить гонки на Я.Диске.
// ════════════════════════════════════════════════════════════════════

const _readyDocsProcessing = new Set(); // leadId, по которым прямо сейчас идёт обработка

// Листинг ОДНОЙ папки с метаданными (created/modified) — для дедупа по времени.
async function listYandexDirEntries(folderPath) {
  try {
    const r = await yandexRequest({
      method: "GET",
      url: "https://cloud-api.yandex.net/v1/disk/resources",
      params: {
        path: folderPath,
        limit: 1000,
        fields: "_embedded.items.name,_embedded.items.type,_embedded.items.created,_embedded.items.modified"
      }
    });
    return (r.data && r.data._embedded && r.data._embedded.items) || [];
  } catch (e) {
    if (e.response?.status !== 404) {
      console.error("READY-DOCS list dir error:", folderPath, e.response?.data || e.message);
    }
    return [];
  }
}

// Создание корневой папки «Готовые документы (ЛК)» сделки (идемпотентно).
function ensureReadyDocsFolderForLead(leadId) {
  if (!leadId) return Promise.resolve();
  return amoEnqueue(leadId, `ready-docs ensure root`, async () => {
    await ensureNestedYandexFolder(readyDocsFolder(leadId));
  });
}

// Создание папки заявителя <ФИО> + вложенной «Чек по страховке» (идемпотентно).
function ensureReadyDocsApplicantFolder(leadId, safeFio) {
  if (!leadId || !safeFio) return Promise.resolve();
  return amoEnqueue(leadId, `ready-docs ensure applicant ${safeFio}`, async () => {
    await ensureNestedYandexFolder(readyDocsInsuranceFolder(leadId, safeFio));
  });
}

// Провижн «Готовые документы (ЛК)» для всех активных видимых сделок номера.
// Вызывается асинхронно (вход не блокирует) при первой авторизации и при бэкафилле.
async function provisionReadyDocsForActiveLeads(phone) {
  const norm = normalizePhone(phone || "");
  if (!norm) return;
  let leads = [];
  try {
    leads = await getLeadsByPhone(norm); // только видимые (hidden исключены внутри)
  } catch (e) {
    console.error(`READY-DOCS provision: getLeadsByPhone error phone=${norm}:`, e.message);
    return;
  }
  let made = 0;
  for (const lead of leads) {
    if (!lead || !lead.id) continue;
    if (READY_DOCS_SKIP_STAGES.has(String(lead.cabinet_status || ""))) continue;
    try {
      await ensureReadyDocsFolderForLead(lead.id);
      made++;
    } catch (e) {
      console.error(`READY-DOCS provision lead=${lead.id} error:`, e.message);
    }
  }
  if (made) console.log(`READY-DOCS provision: phone=${norm} ensured ${made} active lead folder(s)`);
}

// content-type по расширению (для загрузки распакованных файлов).
function guessContentType(name) {
  const ext = String(name).toLowerCase().split(".").pop();
  const map = {
    pdf: "application/pdf",
    jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif",
    webp: "image/webp", heic: "image/heic", bmp: "image/bmp", tif: "image/tiff", tiff: "image/tiff",
    doc: "application/msword",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    xls: "application/vnd.ms-excel",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    txt: "text/plain; charset=utf-8", rtf: "application/rtf"
  };
  return map[ext] || "application/octet-stream";
}

// Имя файла из zip-записи: UTF-8 если выставлен флаг bit-11, иначе cp866
// (русская Windows-кодировка имён в zip).
function decodeZipEntryName(entry) {
  try {
    const raw = entry.rawEntryName; // Buffer
    if (!raw) return entry.entryName;
    const isUtf8 = (((entry.header && entry.header.flags) || 0) & 0x800) !== 0;
    if (isUtf8) return raw.toString("utf8");
    return iconv.decode(raw, "cp866");
  } catch (_) {
    return entry.entryName;
  }
}

// Безопасный сегмент имени файла (без traversal/слешей).
function safePathSegment(s) {
  return String(s || "")
    .replace(/[\\/]+/g, "_")
    .replace(/\.\.+/g, "_")
    .replace(/[<>:"|?*\x00-\x1F]/g, "_")
    .trim();
}

// Распаковка одного zip в указанную папку (плоско, имя = basename записи).
async function unpackZipIntoFolder(zipDiskPath, destFolder) {
  const buf = await downloadYandexFileBuffer(zipDiskPath);
  let zip;
  try { zip = new AdmZip(buf); } catch (e) { console.error("READY-DOCS bad zip:", zipDiskPath, e.message); return 0; }
  const entries = zip.getEntries();
  let n = 0;
  for (const entry of entries) {
    if (entry.isDirectory) continue;
    const decoded = decodeZipEntryName(entry);
    const base = safePathSegment(String(decoded).replace(/\\/g, "/").split("/").pop());
    if (!base || /\.zip$/i.test(base)) continue;
    let data;
    try { data = entry.getData(); } catch (e) { console.error("READY-DOCS entry read error:", base, e.message); continue; }
    try {
      await uploadBufferToYandexDisk(data, `${destFolder}/${base}`, guessContentType(base));
      n++;
    } catch (e) {
      console.error("READY-DOCS upload extracted error:", `${destFolder}/${base}`, e.message);
    }
  }
  return n;
}

// Ключ дедупа: нормализованное имя без хвостов " (2)" / " копия" / " - copy".
function readyDocsDedupKey(filename) {
  const s = String(filename);
  const dot = s.lastIndexOf(".");
  let base = dot > 0 ? s.slice(0, dot) : s;
  const ext = dot > 0 ? s.slice(dot).toLowerCase() : "";
  base = base.toLowerCase().trim();
  base = base.replace(/\s*-?\s*копия(\s*\(\d+\))?\s*$/u, "");
  base = base.replace(/\s*-?\s*copy(\s*\(\d+\))?\s*$/u, "");
  base = base.replace(/\s*\(\d+\)\s*$/u, "");
  base = base.trim();
  return base + ext;
}

// Дедуп файлов в одной папке: при совпадении ключа оставляем самый свежий.
async function dedupReadyDocsDir(folderPath, entries) {
  const files = (entries || []).filter((e) => e.type === "file" && !/\.zip$/i.test(e.name));
  const groups = new Map();
  for (const f of files) {
    const key = readyDocsDedupKey(f.name);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(f);
  }
  for (const arr of groups.values()) {
    if (arr.length <= 1) continue;
    arr.sort((a, b) => {
      const ta = Date.parse(a.modified || a.created || 0) || 0;
      const tb = Date.parse(b.modified || b.created || 0) || 0;
      return tb - ta; // свежие первыми
    });
    for (let i = 1; i < arr.length; i++) {
      await deleteYandexResourceIfExists(`${folderPath}/${arr[i].name}`);
      console.log(`READY-DOCS dedup: removed old ${folderPath}/${arr[i].name}`);
    }
  }
}

// Полная обработка папки готовых документов сделки: распаковать все zip
// (в ту же папку, где лежит архив), удалить архив, прогнать дедуп. Идемпотентно.
async function processReadyDocsArchivesForLead(leadId) {
  if (!leadId) return;
  const key = String(leadId);
  if (_readyDocsProcessing.has(key)) return;
  _readyDocsProcessing.add(key);
  try {
    await amoEnqueue(leadId, `ready-docs process`, async () => {
      const root = readyDocsFolder(leadId);
      const queue = [root];
      const seen = new Set();
      while (queue.length) {
        const dir = queue.shift();
        if (seen.has(dir)) continue;
        seen.add(dir);
        let entries = await listYandexDirEntries(dir);
        const zips = entries.filter((e) => e.type === "file" && /\.zip$/i.test(e.name));
        for (const z of zips) {
          try {
            const cnt = await unpackZipIntoFolder(`${dir}/${z.name}`, dir);
            await deleteYandexResourceIfExists(`${dir}/${z.name}`);
            console.log(`READY-DOCS unpacked ${cnt} file(s) from ${dir}/${z.name}, archive removed`);
          } catch (e) {
            console.error("READY-DOCS unpack error:", `${dir}/${z.name}`, e.message);
          }
        }
        if (zips.length) entries = await listYandexDirEntries(dir); // перечитать после распаковки
        await dedupReadyDocsDir(dir, entries);
        for (const e of entries) {
          if (e.type === "dir") queue.push(`${dir}/${e.name}`);
        }
      }
    });
  } finally {
    _readyDocsProcessing.delete(key);
  }
}

// Сбор списка готовых документов сделки по заявителям (для ЛК).
// Возвращает { applicants:[{fio,files:[{name,rel}]}], hasZip, needsDedup }.
async function collectReadyDocsForLead(leadId) {
  const root = readyDocsFolder(leadId);
  const rootEntries = await listYandexDirEntries(root);
  let hasZip = rootEntries.some((e) => e.type === "file" && /\.zip$/i.test(e.name));
  const dupSeen = new Map(); // dir|key -> count
  const markDup = (dir, name) => {
    const k = `${dir}|${readyDocsDedupKey(name)}`;
    dupSeen.set(k, (dupSeen.get(k) || 0) + 1);
  };

  const applicants = [];
  const rootFiles = [];
  for (const e of rootEntries) {
    if (e.type === "file" && !/\.zip$/i.test(e.name)) {
      rootFiles.push({ name: e.name, rel: e.name });
      markDup("", e.name);
    }
  }
  for (const e of rootEntries) {
    if (e.type !== "dir") continue;
    const fio = e.name;
    const appFolder = `${root}/${fio}`;
    const sub = await listYandexFolderRecursive(appFolder); // {name, fullPath, relativePath, size}
    const files = [];
    for (const f of sub) {
      if (/\.zip$/i.test(f.name)) { hasZip = true; continue; }
      // Файл из подпапки «Чек по страховке» показываем под именем «Чек по
      // страховке» (как просили). Пустая папка файлов не даёт — игнорируется.
      const inInsurance = f.relativePath.startsWith(`${INSURANCE_SUBFOLDER_NAME}/`);
      const displayName = inInsurance ? INSURANCE_SUBFOLDER_NAME : f.name;
      files.push({ name: displayName, rel: `${fio}/${f.relativePath}` });
      const parentDir = f.relativePath.includes("/") ? `${fio}/${f.relativePath.slice(0, f.relativePath.lastIndexOf("/"))}` : fio;
      markDup(parentDir, f.name);
    }
    applicants.push({ fio, files });
  }
  if (rootFiles.length) applicants.push({ fio: "", files: rootFiles });

  let needsDedup = false;
  for (const c of dupSeen.values()) { if (c > 1) { needsDedup = true; break; } }
  return { applicants, hasZip, needsDedup };
}

// Проверка доступа клиента к готовым документам сделки: владение номером +
// статус сделки входит в READY_DOCS_VISIBLE_STATUSES.
async function verifyReadyDocsAccess(phone, leadId) {
  const norm = normalizePhone(phone || "");
  const lid = parseInt(leadId, 10);
  if (!norm || !lid) return { ok: false };
  const baseUrl = `https://${AMO_SUBDOMAIN}.amocrm.ru`;
  const contacts = await findMatchingContacts(baseUrl, norm);
  if (!contacts.length) return { ok: false };
  const leadIds = await collectLeadIdsFromContacts(baseUrl, contacts);
  if (!leadIds.map(String).includes(String(lid))) return { ok: false };
  const lead = await getLeadById(baseUrl, lid);
  if (!lead) return { ok: false };
  const statusesMap = await getCachedPipelinesMap(baseUrl);
  const enriched = enrichLeadWithMappedStatus(lead, statusesMap);
  const statusName = String(enriched.status_name || "");
  const visible = !enriched.hidden_in_cabinet && READY_DOCS_VISIBLE_STATUSES.has(statusName);
  return { ok: true, visible, statusName };
}

// Метка источника для leads, созданных через ЛК. Кладётся как тег amoCRM.
// Можно переопределить через .env: LK_SOURCE_VALUE (по умолчанию «VOYO»).
const LK_SOURCE_VALUE = process.env.LK_SOURCE_VALUE || "VOYO";

// Создание контакта (если ещё нет) + новой сделки в воронке «Отдел продаж»,
// статус «Ещё не связывались». При applyPromo — добавляем закреплённый комментарий.
async function createAmoContactAndLeadForRegistration(phone, { promoApplied = false, promoText = "" } = {}) {
  const baseUrl = `https://${AMO_SUBDOMAIN}.amocrm.ru`;

  // 1) Ищем существующий контакт по телефону, чтобы не дублировать.
  let contactId = null;
  try {
    const existing = await findMatchingContacts(baseUrl, phone);
    if (existing && existing.length) contactId = existing[0].id;
  } catch (e) {
    console.error("REGISTER find contact err:", e.message);
  }

  // 2) Если контакта нет — создаём.
  if (!contactId) {
    const displayPhone = `+${phone}`;
    const contactBody = [{
      name: displayPhone,
      custom_fields_values: [{
        field_code: "PHONE",
        values: [{ value: displayPhone, enum_code: "WORK" }]
      }]
    }];
    const createRes = await amoPost(`${baseUrl}/api/v4/contacts`, contactBody);
    contactId = createRes?._embedded?.contacts?.[0]?.id;
    if (!contactId) throw new Error("Не удалось создать контакт");
  }

  // 3) Находим воронку «Отдел продаж» и статус «Ещё не связывались».
  const pipelines = await amoGetAllPages(`${baseUrl}/api/v4/leads/pipelines`);
  let pipelineId = null, statusId = null;
  for (const p of pipelines) {
    const pname = normalizeText(p.name);
    if (pname === "отдел продаж" || pname.startsWith("отдел продаж")) {
      pipelineId = p.id;
      const statuses = await amoGetAllPages(`${baseUrl}/api/v4/leads/pipelines/${p.id}/statuses`);
      for (const s of statuses) {
        if (normalizeText(s.name) === "ещё не связывались") {
          statusId = s.id;
          break;
        }
      }
      break;
    }
  }
  if (!pipelineId || !statusId) {
    throw new Error("Не найдена воронка/статус «Отдел продаж» → «Ещё не связывались»");
  }

  // 4) Создаём сделку, привязанную к контакту, с тегом-источником «VOYO».
  //    Раньше пробовали писать в custom-поле utm_term — оно у пользователя
  //    оказалось типа tracking_data (служебное для UTM-аналитики Flexbe).
  //    Запись туда технически проходит, но в UI карточки не показывается,
  //    и плюс переписывает реальные UTM от Flexbe. Поэтому используем теги —
  //    они видны в шапке сделки, фильтруются и ни с чем не конфликтуют.
  const leadBody = [{
    name: "Новое обращение из ЛК",
    pipeline_id: pipelineId,
    status_id: statusId,
    _embedded: {
      contacts: [{ id: contactId }],
      tags: [{ name: LK_SOURCE_VALUE }]
    }
  }];
  const leadRes = await amoPost(`${baseUrl}/api/v4/leads`, leadBody);
  const leadId = leadRes?._embedded?.leads?.[0]?.id;
  if (!leadId) throw new Error("Не удалось создать сделку");

  console.log(`REGISTER OK: phone=${phone} contactId=${contactId} leadId=${leadId} promo=${promoApplied} tag=${LK_SOURCE_VALUE}`);

  // 5) При applyPromo — закреплённый комментарий на сделке.
  if (promoApplied && promoText) {
    try {
      const noteBody = [{
        note_type: "common",
        is_pinned: true,
        params: { text: promoText }
      }];
      await amoPost(`${baseUrl}/api/v4/leads/${leadId}/notes`, noteBody);
    } catch (e) {
      console.error("REGISTER promo note err:", e.response?.data || e.message);
    }
  }

  return { contactId, leadId };
}

const UPLOAD_FIELDS_WHITELIST = {
  mainPassport:         "Загран. паспорт (в который запрашиваем визу)",
  innerPassport:        "Внутренний паспорт (1-ый разворот, разворот с актуальной пропиской, последний разворот)",
  secondPassport:       "2-ой загран. паспорт",
  thirdCountryTickets:  "Билеты в третью страну",
  invitation:           "Приглашение",
  activeSchengenPhoto:  "Фото действующей Шенгенской визы",
  prevSchengenPhoto:    "Фото последней Шенгенской визы",
  birthCertificate:     "Свидетельство о рождении",
  // ВНИМАНИЕ: с 27.05.2026 для Шенгена этот label переименован c "1-ый разворот
  // внутреннего паспорта РФ спонсора". Слэш в label нельзя — Я.Диск трактует
  // его как разделитель пути и валит загрузку с 409 DiskPathDoesntExistsError;
  // поэтому используем "или" вместо "/". Для Японии используем отдельный
  // короткий label через виза-зависимую логику в cabinet.html.
  sponsorPassport:      "Внутр. паспорт спонсора или Спонсорское письмо от компании",
  insurancePolicy:      "Страховой полис для въезда в Шенген",
  workCert:             "Справка с работы",
  studyCert:            "Справка с учёбы",
  routeSheet:           "Маршрутный лист",
  routePlan:            "План поездки",
  ownFlights:           "Авиабилеты",
  ownAccommodation:     "Своё проживание (бронь или аренда или собственность)",
  ownTransport:         "Свои авиабилеты или другой транспорт",
  electronicPhoto:      "Электронное фото",
  residencePermit:      "ВНЖ или регистрация",
  // Посадочные талоны — по ТЗ от 29.05.2026 (Шенген: посещал зону после
  // 10.04.2026, но штампы в загранпаспорт не ставили). Слэша в label нет
  // («и (или)» вместо «и/или») — иначе Я.Диск валит загрузку 409. Строка
  // обязана быть идентична label в buildUploadBlocksConfig (cabinet.html) и
  // buildUploadBlocksForApplicantStats (server.js), иначе ломается детект
  // «загружено» (startsWith(label)).
  boardingPasses:       "Посадочные талоны и (или) иные подтверждения того, что вы использовали предыдущую визу",
  // ── Предподачные документы (этап «Подготовка документов», за 7 дней до
  // «Даты записи на подачу»). Названия БЕЗ «/» — иначе Я.Диск валит загрузку.
  // Строки обязаны совпадать с label в cabinet.html (детект «загружено» по startsWith).
  bankBalance:             "Справка из банка об остатке средств",
  accountStatement:        "Выписка (детализация) по счету",
  ipDocs:                  "Документы на ИП (лист записи + свидетельство о регистрации)",
  studyCertPre:            "Справка из учебного заведения",
  pensionDoc:              "Пенсионное удостоверение или справка о пенсии",
  selfEmployedDoc:         "Справка о самозанятости",
  childTravelConsent:      "Согласие на выезд ребенка или замещающий документ",
  pfrStatement:            "Электронная выписка из ПФР",
  ndfl2:                   "Справка 2-НДФЛ",
  sponsorBankBalance:      "Справка из банка об остатке средств от спонсора",
  sponsorAccountStatement: "Выписка (детализация) по счету спонсора",
  sponsorInnerPassport:    "Внутренний паспорт спонсора",
  sponsorWorkCert:         "Справка с места работы спонсора",
  parentsPassports:        "Внутренние паспорта родителей"
};

// Кэш поиска контактов по телефону. Эндпоинт GET /contacts?query=<phone> — главный
// виновник блокировки аккаунта 09.06.2026 (один номер запрашивался по 7–17 раз).
// Контакты по номеру меняются редко → держим результат (в т.ч. пустой) на TTL,
// схлопывая быстрые обновления кабинета и параллельных потребителей в 1 запрос.
const _contactsByPhoneCache = new Map();   // normalized -> { ts, data }
const _contactsByPhoneInflight = new Map(); // normalized -> Promise
const CONTACTS_BY_PHONE_TTL_MS = 120 * 1000;

async function findMatchingContacts(baseUrl, phone) {
  const normalized = normalizePhone(phone);
  if (!normalized) return [];
  const now = Date.now();
  const cached = _contactsByPhoneCache.get(normalized);
  if (cached && (now - cached.ts) < CONTACTS_BY_PHONE_TTL_MS) return cached.data;
  const inflight = _contactsByPhoneInflight.get(normalized);
  if (inflight) return inflight;
  const p = _findMatchingContactsUncached(baseUrl, normalized)
    .then((data) => { _contactsByPhoneCache.set(normalized, { ts: Date.now(), data }); return data; })
    .finally(() => { _contactsByPhoneInflight.delete(normalized); });
  _contactsByPhoneInflight.set(normalized, p);
  return p;
}

async function _findMatchingContactsUncached(baseUrl, normalized) {
  const variants = [...new Set([
    normalized,
    normalized.slice(-10),
    normalized.startsWith("7") ? `8${normalized.slice(1)}` : normalized
  ].filter(Boolean))];

  const contactsMap = new Map();

  for (const query of variants) {
    const contacts = await amoGetAllPages(`${baseUrl}/api/v4/contacts`, {
      query
    });

    for (const contact of contacts) {
      if (!contact?.id) continue;
      if (!contactMatchesPhone(contact, normalized)) continue;
      contactsMap.set(contact.id, contact);
    }
  }

  return Array.from(contactsMap.values());
}

async function collectLeadIdsFromContacts(baseUrl, contacts) {
  const leadIds = new Set();

  for (const contact of contacts) {
    const contactFull = await amoGet(`${baseUrl}/api/v4/contacts/${contact.id}`, {
      with: "leads"
    });

    const embeddedLeads = contactFull?._embedded?.leads || [];
    for (const lead of embeddedLeads) {
      if (lead?.id) {
        leadIds.add(lead.id);
      }
    }

    const links = await getEntityLinks(baseUrl, "contacts", contact.id);
    for (const link of links) {
      const toType = String(link.to_entity_type || "").toLowerCase();
      if ((toType === "leads" || toType === "lead") && link.to_entity_id) {
        leadIds.add(link.to_entity_id);
      }
    }
  }

  return Array.from(leadIds);
}

async function loadLeadsByIds(baseUrl, leadIds, statusesMap) {
  const leadsMap = new Map();

  for (const leadId of leadIds) {
    const lead = await getLeadById(baseUrl, leadId);
    if (!lead?.id) continue;

    const enrichedLead = enrichLeadWithMappedStatus(lead, statusesMap);
    if (enrichedLead.hidden_in_cabinet) continue;

    leadsMap.set(enrichedLead.id, enrichedLead);
  }

  return Array.from(leadsMap.values()).sort((a, b) => {
    return (b.created_at || 0) - (a.created_at || 0);
  });
}

// Кэш «сделки по телефону» (полный обход: контакты → их сделки → enrich статусов).
// Короткий TTL: схлопывает быстрые F5/повторные заходы в кабинет в один обход,
// при этом статус сделки остаётся достаточно свежим (изменение этапа видно в
// течение TTL). Защищает amoCRM от лавины запросов (инцидент-блокировка 09.06.2026).
const _leadsByPhoneCache = new Map();   // normalized -> { ts, data }
const _leadsByPhoneInflight = new Map(); // normalized -> Promise
const LEADS_BY_PHONE_TTL_MS = 30 * 1000;

async function getLeadsByPhone(phone) {
  const normalized = normalizePhone(phone);
  if (!normalized) return [];
  const now = Date.now();
  const cached = _leadsByPhoneCache.get(normalized);
  if (cached && (now - cached.ts) < LEADS_BY_PHONE_TTL_MS) return cached.data;
  const inflight = _leadsByPhoneInflight.get(normalized);
  if (inflight) return inflight;
  const p = _getLeadsByPhoneUncached(phone)
    .then((data) => { _leadsByPhoneCache.set(normalized, { ts: Date.now(), data }); return data; })
    .finally(() => { _leadsByPhoneInflight.delete(normalized); });
  _leadsByPhoneInflight.set(normalized, p);
  return p;
}

async function _getLeadsByPhoneUncached(phone) {
  const normalized = normalizePhone(phone);

  console.log("PHONE RAW:", phone);
  console.log("PHONE NORMALIZED:", normalized);
  console.log("AMO_SUBDOMAIN:", AMO_SUBDOMAIN);

  if (!normalized) return [];

  const baseUrl = `https://${AMO_SUBDOMAIN}.amocrm.ru`;

  const statusesMap = await getCachedPipelinesMap(baseUrl);
  const contacts = await findMatchingContacts(baseUrl, normalized);

  console.log("MATCHED CONTACTS:", contacts.map((c) => ({
    id: c.id,
    phones: extractPhonesFromContact(c)
  })));

  if (!contacts.length) {
    return [];
  }

  const leadIds = await collectLeadIdsFromContacts(baseUrl, contacts);
  console.log("COLLECTED LEAD IDS:", leadIds);

  if (!leadIds.length) {
    return [];
  }

  const leads = await loadLeadsByIds(baseUrl, leadIds, statusesMap);

  console.log("VISIBLE LEADS:", leads.map((lead) => ({
    id: lead.id,
    name: lead.name,
    created_at: lead.created_at,
    pipeline_name: lead.pipeline_name,
    status_name: lead.status_name,
    cabinet_status: lead.cabinet_status,
    cabinet_stage_index: lead.cabinet_stage_index,
    country_service: lead.country_service
  })));

  return leads;
}

function buildQuestionnaireHtml({ phone, leadId, countryService, applicantIndex = 1, totalApplicants = 1, prevApplicantName = "", prefill = null, isEdit = false, applicantCount = 0, visaType = "", shareToken = "", isMixed = false, selfFillCount = 0, selfStep = 0, existingFios = [] }) {
  const safePhone = escapeHtml(phone || "");
  const safeLeadId = escapeHtml(String(leadId || ""));
  const safeCountry = escapeHtml(countryService || "не указано");
  const idx = Math.max(1, parseInt(applicantIndex, 10) || 1);
  const total = Math.max(idx, parseInt(totalApplicants, 10) || 1);
  const safePrevName = escapeHtml(prevApplicantName || "");
  const isFirstApplicant = idx === 1;
  const safeApplicantCount = Math.max(0, parseInt(applicantCount, 10) || 0);
  const safeVisaType = escapeHtml(visaType || "");
  const safeShareToken = escapeHtml(String(shareToken || ""));
  const isShareMode = !!shareToken;
  const mixedFlag = isMixed ? "1" : "";
  const safeSelfFillCount = Math.max(0, parseInt(selfFillCount, 10) || 0);
  const safeSelfStep = Math.max(0, parseInt(selfStep, 10) || 0);

  const titleText = visaType === "Шенгенская виза"
    ? "Опросник на Шенгенскую визу"
    : `Опросный лист на ${safeCountry}`;

  const subtitleText = isEdit
    ? "Внесите изменения и нажмите «Отправить опросник»."
    : 'Заполните данные и нажмите "Отправить опросник" внизу страницы';

  // В обычном режиме handoff показывается со 2-го applicantIndex.
  // В mixed-режиме applicantIndex может быть любым (first-free), поэтому используем selfStep.
  const showHandoff = isMixed
    ? (safeSelfStep > 1 && !isEdit)
    : (!isFirstApplicant && !isEdit);
  const handoffNoticeHtml = !showHandoff ? "" : `
    <div class="handoff-notice">
      Опросник для <strong>${safePrevName || "предыдущего заявителя"}</strong> отправлен. Заполните опросник на следующего заявителя.
    </div>`;

  const applicantCountFieldHtml = (!isEdit && safeApplicantCount > 0) ? `
    <input type="hidden" name="applicantCount" value="${safeApplicantCount}" />` : "";
  const mixedFieldsHtml = isMixed ? `
    <input type="hidden" name="mixed" value="1" />
    <input type="hidden" name="selfFillCount" value="${safeSelfFillCount}" />
    <input type="hidden" name="selfStep" value="${safeSelfStep}" />` : "";

  return `<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Опросный лист</title>
  <style>
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif;
      background: #f3f2f7;
      color: #1d2330;
      padding: 24px;
    }
    .wrap {
      max-width: 760px;
      margin: 0 auto;
      background: #fff;
      border: 1px solid #ece7f2;
      border-radius: 24px;
      padding: 24px;
      box-shadow: 0 10px 30px rgba(34, 36, 52, 0.05);
    }
    h1 { margin: 0 0 8px; font-size: 28px; line-height: 1.15; color: #171c29; }
    .subtitle { margin: 0 0 22px; font-size: 14px; color: #737988; line-height: 1.5; }
    form { display: grid; gap: 14px; }
    .field { display: grid; gap: 6px; }
    .field > label { font-size: 14px; font-weight: 600; color: #3a4150; }
    .field input[type="text"],
    .field input[type="tel"],
    .field input[type="email"],
    .field input[type="date"],
    .field select,
    .field textarea {
      width: 100%;
      height: 50px;
      border: 1px solid #e8e2ee;
      border-radius: 14px;
      padding: 0 14px;
      font-size: 16px;
      outline: none;
      background: #fff;
      color: #1f2532;
      font-family: inherit;
    }
    .field textarea { height: auto; min-height: 80px; padding: 12px 14px; resize: vertical; }
    .field select {
      appearance: none;
      background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='8' viewBox='0 0 12 8'%3E%3Cpath d='M1 1l5 5 5-5' stroke='%239096a3' stroke-width='1.5' fill='none' stroke-linecap='round'/%3E%3C/svg%3E");
      background-repeat: no-repeat;
      background-position: right 14px center;
      padding-right: 36px;
    }
    .field input[type="file"] {
      height: auto;
      padding: 10px 14px;
      border: 1px solid #e8e2ee;
      border-radius: 14px;
      background: #fff;
      font-size: 14px;
      cursor: pointer;
      width: 100%;
    }
    .hint { font-size: 12px; color: #9096a3; line-height: 1.4; }
    .radio-group { display: flex; gap: 10px; flex-wrap: wrap; }
    .radio-group label {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 14px;
      font-weight: 400;
      color: #1d2330;
      cursor: pointer;
      padding: 10px 16px;
      border: 1px solid #e8e2ee;
      border-radius: 12px;
      background: #fff;
    }
    .radio-group input[type="radio"] { accent-color: #4f9f68; width: 16px; height: 16px; }
    .radio-group label:has(input:checked) { border-color: #4f9f68; background: #f0faf3; }
    .radio-group label:has(input[name="confirmAccuracy"][value="Нет"]:checked),
    .radio-group label:has(input[name="confirmPrevData"][value="Нет"]:checked),
    .radio-group label:has(input[name="personalDataConsent"][value="Нет"]:checked) {
      border-color: #d97a8a;
      background: #fbebee;
      color: #a15561;
    }
    .radio-group label:has(input[name="confirmAccuracy"][value="Нет"]:checked) input,
    .radio-group label:has(input[name="confirmPrevData"][value="Нет"]:checked) input,
    .radio-group label:has(input[name="personalDataConsent"][value="Нет"]:checked) input {
      accent-color: #d97a8a;
    }
    .cond { display: none; }
    .cond.show { display: grid; gap: 14px; }
    .message {
      display: none;
      padding: 12px 14px;
      border-radius: 14px;
      font-size: 14px;
      margin-bottom: 16px;
    }
    .message.error { background: #fbebee; border: 1px solid #efcfd5; color: #a15561; }
    .message.success { background: #edf8ef; border: 1px solid #cfe7d2; color: #2e7a43; }
    .handoff-notice {
      padding: 12px 14px;
      border-radius: 14px;
      font-size: 14px;
      line-height: 1.5;
      background: #f0f7fc;
      border: 1px solid #d3e7f4;
      color: #2f6e95;
      margin-bottom: 14px;
    }
    .notice-green {
      padding: 12px 14px;
      border-radius: 14px;
      font-size: 14px;
      line-height: 1.5;
      background: #edf8ef;
      border: 1px solid #cfe7d2;
      color: #2e7a43;
    }
    .submit-btn {
      height: 50px;
      border: none;
      border-radius: 14px;
      background: #3589BD;
      color: #fff;
      font-size: 16px;
      font-weight: 600;
      cursor: pointer;
      margin-top: 8px;
    }
    .submit-btn:disabled { opacity: 0.7; cursor: not-allowed; }
    .date-row { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
    .date-row > input { min-width: 0; width: 100%; }
    @media (max-width: 480px) {
      .date-row { grid-template-columns: 1fr; }
    }
    .field input.input-error,
    .date-row input.input-error {
      border-color: #d97a8a !important;
      background: #fbebee !important;
      box-shadow: 0 0 0 3px rgba(217, 122, 138, 0.18) !important;
    }

    .ack-row {
      display: flex;
      align-items: flex-start;
      gap: 10px;
      margin-top: 12px;
      font-size: 14px;
      color: #1d2330;
      line-height: 1.45;
      cursor: pointer;
    }
    .ack-row input[type="checkbox"] {
      margin: 3px 0 0;
      accent-color: #4f9f68;
      width: 16px;
      height: 16px;
      flex: 0 0 auto;
    }
    .ack-row.ack-error,
    .ack-row.ack-error span {
      color: #c4314b;
    }
    .ack-row.ack-error input[type="checkbox"] {
      outline: 2px solid #c4314b;
      outline-offset: 2px;
      border-radius: 3px;
    }
  </style>
</head>
<body>
<div class="wrap">
  <h1>${titleText}</h1>
  <p class="subtitle">${subtitleText}</p>

  <div id="successBox" class="message success"></div>
${handoffNoticeHtml}
  <form id="questionnaireForm">
    <input type="hidden" name="phone" value="${safePhone}" />
    <input type="hidden" name="leadId" value="${safeLeadId}" />
    <input type="hidden" name="applicantIndex" value="${idx}" />
    <input type="hidden" name="totalApplicants" value="${total}" />
    <input type="hidden" name="isEdit" value="${isEdit ? "1" : ""}" />
    <input type="hidden" name="visaType" value="${safeVisaType}" />
    <input type="hidden" name="shareToken" value="${safeShareToken}" />
${applicantCountFieldHtml}
${mixedFieldsHtml}
    <!-- 1 -->
    <div class="field">
      <label>Полное имя (ФИО) *</label>
      <input type="text" name="fullName" required />
    </div>

    <!-- 2 -->
    <div class="field">
      <label>У меня ранее были предыдущие фамилии</label>
      <div class="radio-group">
        <label><input type="radio" name="hadPrevSurnames" value="Да" /> Да</label>
        <label><input type="radio" name="hadPrevSurnames" value="Нет" /> Нет</label>
      </div>
    </div>

    <!-- 3 условно -->
    <div class="cond" id="c_prevSurnames">
      <div class="field">
        <label>Укажите все предыдущие фамилии *</label>
        <input type="text" name="prevSurnames" />
      </div>
    </div>

    <!-- 4 -->
    <div class="field">
      <label>Телефон *</label>
      <input type="tel" name="contactPhone" inputmode="tel" autocomplete="tel" placeholder="+7 (___) ___-__-__" data-phone-mask required />
      <span class="hint">Тот, по которому Консульство сможет связаться с заявителем</span>
    </div>

    <!-- 5 -->
    <div class="field">
      <label>Почта *</label>
      <input type="email" name="email" inputmode="email" autocomplete="email" placeholder="example@mail.ru" required />
      <span class="hint">Та, по которой Консульство сможет связаться с заявителем</span>
    </div>

    <!-- 6 -->
    <div class="field">
      <label>Семейное положение *</label>
      <select name="maritalStatus" required>
        <option value="">— выберите —</option>
        <option value="Не в браке">Не в браке</option>
        <option value="В браке">В браке</option>
        <option value="В разводе">В разводе</option>
        <option value="Вдовец/вдова">Вдовец/вдова</option>
      </select>
    </div>

    <!-- 7 -->
    <div class="field">
      <label>При рождении у меня было иное гражданство</label>
      <div class="radio-group">
        <label><input type="radio" name="hadOtherCitizenshipAtBirth" value="Да" /> Да</label>
        <label><input type="radio" name="hadOtherCitizenshipAtBirth" value="Нет" /> Нет</label>
      </div>
    </div>

    <!-- 8 условно -->
    <div class="cond" id="c_birthCitizenship">
      <div class="field">
        <label>Ваше гражданство при рождении *</label>
        <input type="text" name="birthCitizenship" />
      </div>
    </div>

    <!-- 8.5 — чекбокс «Я не гражданин РФ» -->
    <div class="field">
      <label class="ack-row">
        <input type="checkbox" name="notRussianCitizen" value="Да" />
        <span>Я не гражданин РФ</span>
      </label>
    </div>

    <!-- 9 -->
    <div class="field">
      <label>У меня в данный момент есть второе гражданство</label>
      <div class="radio-group">
        <label><input type="radio" name="hasSecondCitizenship" value="Да" /> Да</label>
        <label><input type="radio" name="hasSecondCitizenship" value="Нет" /> Нет</label>
      </div>
    </div>

    <!-- 10 условно -->
    <div class="cond" id="c_secondCitizenship">
      <div class="field">
        <label>Укажите второе гражданство *</label>
        <input type="text" name="secondCitizenship" />
      </div>
    </div>

    <!-- 11 -->
    <div class="field">
      <label>У меня есть второй заграничный паспорт</label>
      <div class="radio-group">
        <label><input type="radio" name="hasSecondPassport" value="Да" /> Да</label>
        <label><input type="radio" name="hasSecondPassport" value="Нет" /> Нет</label>
      </div>
    </div>

    <!-- 12, 13, 14 условно -->
    <div class="cond" id="c_secondPassport">
      <div class="field">
        <label>На какой паспорт мы оформляем все документы? *</label>
        <input type="text" name="whichPassport" />
      </div>
      <div class="field">
        <label>Можете ли вы сдать второй паспорт в ВЦ на период рассмотрения? *</label>
        <div class="radio-group">
          <label><input type="radio" name="canSurrenderPassport" value="Да" /> Да</label>
          <label><input type="radio" name="canSurrenderPassport" value="Нет" /> Нет</label>
        </div>
      </div>
      <div class="cond" id="c_surrenderReason">
        <div class="field">
          <label>Укажите, по какой причине не сдаете паспорт: *</label>
          <select name="surrenderReason">
            <option value="">— выберите —</option>
            <option value="Поездка в третью страну">Поездка в третью страну</option>
            <option value="Подача на другую визу">Подача на другую визу</option>
            <option value="Иное">Иное</option>
          </select>
        </div>
        <div class="cond" id="c_surrenderReasonOther">
          <div class="field">
            <label>Объясните причину *</label>
            <input type="text" name="surrenderReasonOther" />
          </div>
        </div>
      </div>
    </div>

    <!-- 15 -->
    <div class="field">
      <label>Фактический адрес проживания *</label>
      <input type="text" name="actualAddress" required />
      <span class="hint">Может не совпадать с адресом регистрации</span>
    </div>

    <!-- 16 -->
    <div class="field">
      <label>Род занятий (занимаемая должность) *</label>
      <select name="occupation" required>
        <option value="">— выберите —</option>
        <option value="Работа по найму">Работа по найму</option>
        <option value="Владелец бизнеса или ИП">Владелец бизнеса или ИП</option>
        <option value="Самозанятый">Самозанятый</option>
        <option value="Пенсионер">Пенсионер</option>
        <option value="Учащийся">Учащийся</option>
        <option value="Безработный">Безработный</option>
      </select>
      <span class="hint">Вносится в анкету только при предоставлении подтверждающего документа (справки, документов на бизнес, пенсионного и т. д.)</span>
    </div>

    <!-- 17 -->
    <div class="field">
      <label>Наименование работодателя/учебной организации *</label>
      <input type="text" name="employerName" required />
      <span class="hint">Если вы не учитесь и не работаете, укажите НЕТ.</span>
    </div>

    <!-- 18 -->
    <div class="field">
      <label>Адрес работодателя/учебной организации *</label>
      <input type="text" name="employerAddress" required />
      <span class="hint">Если вы не учитесь и не работаете, укажите НЕТ.</span>
    </div>

    <!-- 19 — скрываем, если employerName === «НЕТ» (любой регистр) -->
    <div class="cond" id="c_employerPhone">
      <div class="field">
        <label>Телефон работодателя *</label>
        <input type="tel" name="employerPhone" inputmode="tel" placeholder="+7 (___) ___-__-__" data-phone-mask required />
      </div>
    </div>

    <!-- 20 -->
    <div class="field">
      <label>Цель поездки *</label>
      <select name="tripPurpose" id="tripPurpose" required>
        <option value="">— выберите —</option>
        <option value="Туризм">Туризм</option>
        <option value="Бизнес">Бизнес</option>
        <option value="Частный визит">Частный визит</option>
        <option value="Лечение">Лечение</option>
        <option value="Обучение">Обучение</option>
        <option value="Иное">Иное</option>
      </select>
    </div>

    <!-- 21 условно -->
    <div class="cond" id="c_purposeOther">
      <div class="field">
        <label>Если Вы выбрали цель поездки "Иное", укажите подробности в этом поле *</label>
        <input type="text" name="tripPurposeOther" />
      </div>
    </div>

    <!-- 22 -->
    <div class="field">
      <label>Я делаю визу, чтобы пройти собеседование на США в Польше</label>
      <div class="radio-group">
        <label><input type="radio" name="usaInterviewPoland" value="Да" /> Да</label>
        <label><input type="radio" name="usaInterviewPoland" value="Нет" /> Нет</label>
      </div>
      <span class="hint">Если да, ваш паспорт обязан быть БИОМЕТРИЧЕСКИМ.</span>
    </div>

    <!-- 23 -->
    <div class="field">
      <label>Страна поездки *</label>
      <input type="text" name="travelCountry" required />
      <label class="ack-row" id="biometricAckRow" style="display: none;">
        <input type="checkbox" name="biometricAck" value="Да" />
        <span>Я уведомлен, что гражданам РФ для въезда в эту страну требуется биометрический (десятилетний) заграничный паспорт.</span>
      </label>
      <label class="ack-row" id="biometricAckFrRow" style="display: none;">
        <input type="checkbox" name="biometricAckFr" value="Да" />
        <span>Я уведомлен, что гражданам РФ старше 14 лет для въезда в эту страну требуется биометрический (десятилетний) заграничный паспорт.</span>
      </label>
    </div>

    <!-- 24 -->
    <div class="field">
      <label>В какую страну запрашивается виза *</label>
      <select name="visaCountry" required>
        <option value="">— выберите —</option>
        <option value="Австрия">Австрия</option>
        <option value="Бельгия">Бельгия</option>
        <option value="Болгария">Болгария</option>
        <option value="Венгрия">Венгрия</option>
        <option value="Германия">Германия</option>
        <option value="Греция">Греция</option>
        <option value="Дания">Дания</option>
        <option value="Исландия">Исландия</option>
        <option value="Испания">Испания</option>
        <option value="Италия">Италия</option>
        <option value="Кипр">Кипр</option>
        <option value="Латвия">Латвия</option>
        <option value="Литва">Литва</option>
        <option value="Лихтенштейн">Лихтенштейн</option>
        <option value="Люксембург">Люксембург</option>
        <option value="Мальта">Мальта</option>
        <option value="Нидерланды">Нидерланды</option>
        <option value="Норвегия">Норвегия</option>
        <option value="Польша">Польша</option>
        <option value="Португалия">Португалия</option>
        <option value="Румыния">Румыния</option>
        <option value="Словакия">Словакия</option>
        <option value="Словения">Словения</option>
        <option value="Финляндия">Финляндия</option>
        <option value="Франция">Франция</option>
        <option value="Хорватия">Хорватия</option>
        <option value="Чехия">Чехия</option>
        <option value="Швейцария">Швейцария</option>
        <option value="Швеция">Швеция</option>
        <option value="Эстония">Эстония</option>
      </select>
    </div>

    <!-- 25 -->
    <div class="field">
      <label>Даты поездки *</label>
      <div class="date-row" id="tripDatesInputs">
        <input type="date" name="tripDateFrom" required />
        <input type="date" name="tripDateTo" required />
      </div>
      <label class="ack-row" id="tripDatesUnknownRow">
        <input type="checkbox" name="tripDatesUnknown" value="Да" />
        <span>Я ещё не знаю точных дат поездки.</span>
      </label>
      <label class="ack-row" id="tripDatesAckRow" style="display: none;">
        <input type="checkbox" name="tripDatesAck" value="Да" />
        <span>Я проинформирован (-а) о сроках рассмотрения, обязуюсь предоставить информацию о датах поездки минимум за неделю до подачи документов в Консульство.<br />Я так же и проинформирован (-а) о том, что при изменении дат поездки после того, как пакет документов уже подготовлен, может потребоваться дополнительная оплата.</span>
      </label>
    </div>

    <!-- 26 -->
    <div class="field">
      <label>У меня есть действующая шенгенская виза</label>
      <div class="radio-group">
        <label><input type="radio" name="hasActiveSchengen" value="Да" /> Да</label>
        <label><input type="radio" name="hasActiveSchengen" value="Нет" /> Нет</label>
      </div>
    </div>

    <!-- 27 условно -->
    <div class="cond" id="c_schengenExpiry">
      <div class="field">
        <label>Укажите дату окончания текущей визы *</label>
        <input type="date" name="schengenExpiry" />
      </div>
    </div>

    <!-- 28 -->
    <div class="field">
      <label>У меня были Шенгенские визы за последние 3 года</label>
      <div class="radio-group">
        <label><input type="radio" name="hadSchengen3Years" value="Да" /> Да</label>
        <label><input type="radio" name="hadSchengen3Years" value="Нет" /> Нет</label>
      </div>
    </div>

    <!-- 29, 30, 31, 32, 33 условно -->
    <div class="cond" id="c_prevSchengen">
      <div class="field">
        <label>Я не открыл/-а свою последнюю шенгенскую визу</label>
        <div class="radio-group">
          <label><input type="radio" name="didNotUseVisa" value="Да" /> Да</label>
          <label><input type="radio" name="didNotUseVisa" value="Нет" /> Нет</label>
        </div>
        <span class="hint">Отметьте, если вы ею не воспользовались</span>
      </div>
      <div class="cond" id="c_didNotUseReason">
        <div class="field">
          <label>Укажите причину, почему виза не была отъезжена *</label>
          <input type="text" name="didNotUseReason" />
        </div>
      </div>
      <div class="field">
        <label>Я открыл/-а свою последнюю шенгенскую визу не той страной, которая ее выдала</label>
        <div class="radio-group">
          <label><input type="radio" name="visaRefused" value="Да" /> Да</label>
          <label><input type="radio" name="visaRefused" value="Нет" /> Нет</label>
        </div>
      </div>
      <div class="cond" id="c_refusalReason">
        <div class="field">
          <label>Укажите причину *</label>
          <input type="text" name="refusalReason" />
        </div>
      </div>
    </div>

    <!-- 33а условно: посещение Шенгена после 10.04.2026 — если есть действующая виза ИЛИ были визы за 3 года -->
    <div class="cond" id="c_visitedSchengen">
      <div class="field">
        <label>Я посещал (-а) Шенгенскую зону после 10 апреля 2026 года</label>
        <div class="radio-group">
          <label><input type="radio" name="visitedSchengenAfterApr2026" value="Да" /> Да</label>
          <label><input type="radio" name="visitedSchengenAfterApr2026" value="Нет" /> Нет</label>
        </div>
      </div>
      <div class="cond" id="c_borderStamps">
        <div class="field">
          <label>Вам ставили штампы о пересечении границы в ваш заграничный паспорт?</label>
          <div class="radio-group">
            <label><input type="radio" name="hadBorderStamps" value="Да" /> Да</label>
            <label><input type="radio" name="hadBorderStamps" value="Нет" /> Нет</label>
          </div>
        </div>
        <div class="cond" id="c_borderStampsNotice">
          <div class="notice-green">
            Необходимо будет предоставить посадочные талоны / иное подтверждение того, что вы посетили Шенгенскую зону.
          </div>
        </div>
      </div>
    </div>

    <!-- 34 -->
    <div class="field">
      <label>У меня есть действительная страховка для въезда в Шенгенскую зону</label>
      <div class="radio-group">
        <label><input type="radio" name="hasInsurance" value="Да" /> Да</label>
        <label><input type="radio" name="hasInsurance" value="Нет" /> Нет</label>
      </div>
      <span class="hint">Покрывает все страны Шенгена и минимум €30,000, действительная минимум на даты поездки.</span>
    </div>

    <!-- 34а условно -->
    <div class="cond" id="c_wantBuyInsurance">
      <div class="field">
        <label>Я хочу приобрести страховку для оформления визы у вас</label>
        <div class="radio-group">
          <label><input type="radio" name="wantBuyInsurance" value="Да" /> Да</label>
          <label><input type="radio" name="wantBuyInsurance" value="Нет" /> Нет</label>
        </div>
      </div>
    </div>

    <!-- 34б — своё проживание (отель/аренда/собственность) -->
    <div class="field">
      <label>У меня будет своё проживание (отель, аренда, собственность)</label>
      <div class="radio-group">
        <label><input type="radio" name="hasOwnAccommodation" value="Да" /> Да</label>
        <label><input type="radio" name="hasOwnAccommodation" value="Нет" /> Нет</label>
      </div>
      <span class="hint">Если «Да» — на этапе загрузки документов появится область «Своё проживание».</span>
    </div>

    <!-- 34в — свои авиа/другой транспорт -->
    <div class="field">
      <label>У меня будут свои авиа/другой транспорт</label>
      <div class="radio-group">
        <label><input type="radio" name="hasOwnTransport" value="Да" /> Да</label>
        <label><input type="radio" name="hasOwnTransport" value="Нет" /> Нет</label>
      </div>
      <span class="hint">Если «Да» — на этапе загрузки документов появится область «Свой транспорт».</span>
    </div>

    <!-- 35 -->
    <div class="field">
      <label>На момент подачи документов я буду младше 18 лет</label>
      <div class="radio-group">
        <label><input type="radio" name="isUnder18" value="Да" /> Да</label>
        <label><input type="radio" name="isUnder18" value="Нет" /> Нет</label>
      </div>
    </div>

    <!-- 36 условно -->
    <div class="cond" id="c_legalRep">
      <div class="field">
        <label>ФИО законного представителя *</label>
        <input type="text" name="legalRepresentative" />
        <span class="hint">Вносится в анкету для лиц младше 18 лет</span>
      </div>
    </div>

    <!-- 37 -->
    <div class="field">
      <label>Мою поездку спонсирует третье лицо/компания</label>
      <div class="radio-group">
        <label><input type="radio" name="hasSponsor" value="Да" /> Да</label>
        <label><input type="radio" name="hasSponsor" value="Нет" /> Нет</label>
      </div>
    </div>

    <!-- 38 условно -->
    <div class="cond" id="c_sponsorName">
      <div class="field">
        <label>Укажите ФИО/наименование спонсора *</label>
        <input type="text" name="sponsorName" />
      </div>
    </div>

    <!-- 39 -->
    <div class="field">
      <label>Тип подачи *</label>
      <select name="visitType" required>
        <option value="">— выберите —</option>
        <option value="Личная">Личная</option>
        <option value="Без присутствия">Без присутствия</option>
      </select>
    </div>

    <!-- 40 -->
    <div class="field">
      <label>Как вы хотите забрать готовые документы для подачи? *</label>
      <select name="pickupMethod" required>
        <option value="">— выберите —</option>
        <option value="В офисе">В офисе</option>
        <option value="Курьером">Курьером</option>
        <option value="Электронная почта">Электронная почта</option>
      </select>
    </div>

    <!-- 41 -->
    <div class="field">
      <label>У меня есть документы, подтверждающие льготную оплату консульского сбора</label>
      <div class="radio-group">
        <label><input type="radio" name="hasConsularFeeDoc" value="Да" /> Да</label>
        <label><input type="radio" name="hasConsularFeeDoc" value="Нет" /> Нет</label>
      </div>
    </div>

    <!-- 42 -->
    <div class="field">
      <label>Я хочу воспользоваться услугой записи ботом</label>
      <div class="radio-group">
        <label><input type="radio" name="useBotBooking" value="Да" /> Да</label>
        <label><input type="radio" name="useBotBooking" value="Нет" /> Нет</label>
      </div>
    </div>

    <!-- 43-47 условно -->
    <div class="cond" id="c_botBooking">
      <div class="field">
        <label>Диапазон записи *</label>
        <div class="date-row">
          <input type="date" name="bookingDateFrom" />
          <input type="date" name="bookingDateTo" />
        </div>
        <div id="botExtraRanges"></div>
        <button type="button" id="botAddRangeBtn" style="display:none;margin-top:10px;background:#eef5fa;color:#3589BD;border:1px solid #cfe3f0;border-radius:8px;padding:8px 12px;font-size:13px;font-weight:600;cursor:pointer;">+ Добавить ещё диапазон</button>
        <span class="hint" id="botRangeHint" style="display:none;color:#3589BD;font-weight:500;"></span>
      </div>
      <div class="field" id="f_bookingExclusions">
        <label>Исключения *</label>
        <input type="text" name="bookingExclusions" />
        <span class="hint">Даты и дни, когда Вы не сможете пойти на подачу</span>
      </div>
      <div class="field">
        <label>Город для записи *</label>
        <input type="text" name="bookingCity" />
      </div>
      <div class="field">
        <label>Если у вас есть исключения или пожелания по датам, в которые вас можно или нельзя записывать, пропишите их здесь. *</label>
        <input type="text" name="bookingTimePrefs" />
        <span class="hint">Если нет - напишите "НЕТ".</span>
      </div>
      <div class="field">
        <label>При записи в случае наличия бизнес-залов/ускоренных записей (дополнительная услуга в ВЦ), какие из этих услуг вас интересуют? *</label>
        <input type="text" name="bookingLoungePrefs" />
      </div>
    </div>

    <!-- 48 -->
    <div class="field">
      <label>Откуда Вы о нас узнали? *</label>
      <select name="howFoundUs" required>
        <option value="">— выберите —</option>
        <option value="Instagram">Instagram</option>
        <option value="Telegram-канал">Telegram-канал</option>
        <option value="Поиск Google">Поиск Google</option>
        <option value="Поиск Yandex">Поиск Yandex</option>
        <option value="Яндекс Карты">Яндекс Карты</option>
        <option value="2Гис">2Гис</option>
        <option value="Google Maps">Google Maps</option>
        <option value="По рекомендации">По рекомендации</option>
        <option value="Реклама в Интернете">Реклама в Интернете</option>
      </select>
    </div>

    <!-- 49 -->
    <div class="field">
      <label>Примечания</label>
      <textarea name="notes" rows="3"></textarea>
      <span class="hint">Любые подробности, которые Вы хотите добавить к своей заявке.</span>
    </div>

    <!-- 50 -->
    <div class="field">
      <label>Я подтверждаю правильность и достоверность указанных мной сведений. *</label>
      <div class="radio-group">
        <label><input type="radio" name="confirmAccuracy" value="Да" required /> Да</label>
        <label><input type="radio" name="confirmAccuracy" value="Нет" /> Нет</label>
      </div>
    </div>

    <!-- 51 -->
    <div class="field">
      <label>Настоящим я соглашаюсь, что данные, внесенные в электронный опросник, являются частью заключенного со мной договора и в случае предоставления недостоверных сведений ответственность за возможные последствия несу лично я. *</label>
      <div class="radio-group">
        <label><input type="radio" name="confirmPrevData" value="Да" required /> Да</label>
        <label><input type="radio" name="confirmPrevData" value="Нет" /> Нет</label>
      </div>
    </div>

    <!-- 52 -->
    <div class="field">
      <label>Даю согласие на обработку персональных данных. *</label>
      <div class="radio-group">
        <label><input type="radio" name="personalDataConsent" value="Да" required /> Да</label>
        <label><input type="radio" name="personalDataConsent" value="Нет" /> Нет</label>
      </div>
    </div>

    <div id="errorBox" class="message error"></div>

    <button id="submitBtn" class="submit-btn" type="submit">Отправить опросник</button>
  </form>
</div>

<script>
  const form = document.getElementById("questionnaireForm");
  const submitBtn = document.getElementById("submitBtn");
  const errorBox = document.getElementById("errorBox");
  const successBox = document.getElementById("successBox");

  function showBox(el, msg) { el.style.display = "block"; el.textContent = msg || ""; }
  function hideBox(el) { el.style.display = "none"; el.textContent = ""; }

  function radio(name) {
    const el = form.querySelector('input[name="' + name + '"]:checked');
    return el ? el.value : null;
  }

  function toggle(id, show) {
    const el = document.getElementById(id);
    if (!el) return;
    el.classList.toggle("show", !!show);
  }

  function updateConditionals() {
    toggle("c_prevSurnames",      radio("hadPrevSurnames") === "Да");
    toggle("c_birthCitizenship",  radio("hadOtherCitizenshipAtBirth") === "Да");
    toggle("c_secondCitizenship", radio("hasSecondCitizenship") === "Да");
    toggle("c_secondPassport",    radio("hasSecondPassport") === "Да");
    toggle("c_surrenderReason",   radio("canSurrenderPassport") === "Нет");
    const surrenderReasonEl = form.querySelector('[name="surrenderReason"]');
    toggle("c_surrenderReasonOther", surrenderReasonEl && surrenderReasonEl.value === "Иное" && radio("canSurrenderPassport") === "Нет");
    const purpose = form.querySelector('[name="tripPurpose"]');
    toggle("c_purposeOther",      purpose && purpose.value === "Иное");
    toggle("c_schengenExpiry",    radio("hasActiveSchengen") === "Да");
    toggle("c_prevSchengen",      radio("hadSchengen3Years") === "Да");
    toggle("c_didNotUseReason",   radio("didNotUseVisa") === "Да");
    toggle("c_refusalReason",     radio("visaRefused") === "Да");
    // Посещение Шенгена после 10.04.2026 — показываем, если есть действующая
    // виза ИЛИ были визы за последние 3 года. Затем вопрос про штампы, и при
    // ответе «Нет» — зелёное уведомление о необходимости посадочных талонов.
    toggle("c_visitedSchengen",   radio("hasActiveSchengen") === "Да" || radio("hadSchengen3Years") === "Да");
    toggle("c_borderStamps",      radio("visitedSchengenAfterApr2026") === "Да");
    toggle("c_borderStampsNotice", radio("hadBorderStamps") === "Нет");
    toggle("c_legalRep",          radio("isUnder18") === "Да");
    toggle("c_sponsorName",       radio("hasSponsor") === "Да");
    toggle("c_botBooking",        radio("useBotBooking") === "Да");
    updateBotBooking();
    // «Я хочу приобрести страховку у вас» — показываем, если у клиента нет своей страховки.
    toggle("c_wantBuyInsurance",  radio("hasInsurance") === "Нет");

    // «Телефон работодателя» — скрываем, если работодатель = «НЕТ» (любой регистр).
    const empNameEl = form.querySelector('input[name="employerName"]');
    const empNameVal = (empNameEl && empNameEl.value || "").trim().toUpperCase();
    const showEmployerPhone = empNameVal !== "НЕТ";
    toggle("c_employerPhone", showEmployerPhone);
    // Снимаем/возвращаем required, чтобы скрытое поле не блокировало сабмит браузером.
    const empPhoneEl = form.querySelector('input[name="employerPhone"]');
    if (empPhoneEl) {
      if (showEmployerPhone) {
        empPhoneEl.required = true;
      } else {
        empPhoneEl.required = false;
        empPhoneEl.classList.remove("input-error");
      }
    }

    // Биометрический паспорт — показ обязательных галочек-уведомлений по «Стране поездки».
    applyBiometricAckState();
  }

  // ─── Запись ботом: зависимость от «В какую страну виза» + ограничения дат ───
  // Франция: убираем «Исключения», один диапазон, поясняющий текст.
  // Испания: убираем «Исключения», до 3 диапазонов (кнопка «Добавить ещё диапазон»).
  // Прочие страны: всё как раньше (диапазон + исключения).
  const BOT_TODAY = new Date().toISOString().slice(0, 10);
  const BOT_MAX_RANGES = 3; // базовый (1) + до 2 дополнительных диапазонов (Испания)

  function wireBotDatePair(fromEl, toEl) {
    if (!fromEl || !toEl) return;
    fromEl.min = BOT_TODAY;                       // первая дата — не раньше сегодня
    const sync = () => {
      const minTo = fromEl.value || BOT_TODAY;
      toEl.min = minTo;                           // вторая дата — не раньше первой
      if (toEl.value && toEl.value < minTo) toEl.value = "";
    };
    fromEl.addEventListener("change", sync);
    sync();
  }

  function botVisaCountry() {
    const el = form.querySelector('[name="visaCountry"]');
    return el ? (el.value || "") : "";
  }

  function botExtraWraps() {
    const cont = document.getElementById("botExtraRanges");
    return cont ? [].slice.call(cont.querySelectorAll("[data-range-slot]")) : [];
  }
  function botUsedSlots() {
    return botExtraWraps().map(function (el) { return parseInt(el.getAttribute("data-range-slot"), 10); });
  }
  // Подписи доп. диапазонов пересчитываем по позиции: базовый = 1, доп. — со 2-го.
  function relabelBotRanges() {
    botExtraWraps().forEach(function (w, i) {
      const lab = w.querySelector("label");
      if (lab) lab.textContent = "Диапазон записи " + (i + 2);
    });
  }
  function updateBotAddRangeBtn() {
    const btn = document.getElementById("botAddRangeBtn");
    if (!btn) return;
    const show = (radio("useBotBooking") === "Да") && botVisaCountry() === "Испания" && botUsedSlots().length < (BOT_MAX_RANGES - 1);
    btn.style.display = show ? "inline-block" : "none";
  }
  function removeBotRange(wrap) {
    if (wrap && wrap.parentNode) wrap.parentNode.removeChild(wrap);
    relabelBotRanges();
    updateBotAddRangeBtn();
  }
  function addBotRange(prefFrom, prefTo) {
    const cont = document.getElementById("botExtraRanges");
    if (!cont) return;
    const used = botUsedSlots();
    if (used.length >= (BOT_MAX_RANGES - 1)) return;
    // Берём наименьший свободный слот (2..BOT_MAX_RANGES) — имена полей стабильны,
    // поэтому удаление одного диапазона не ломает остальные.
    let slot = null;
    for (let s = 2; s <= BOT_MAX_RANGES; s++) { if (used.indexOf(s) < 0) { slot = s; break; } }
    if (slot === null) return;
    const wrap = document.createElement("div");
    wrap.className = "field";
    wrap.style.marginTop = "10px";
    wrap.setAttribute("data-range-slot", String(slot));
    wrap.innerHTML =
      "<label></label>" +
      '<div class="date-row">' +
      '<input type="date" name="bookingDateFrom' + slot + '" />' +
      '<input type="date" name="bookingDateTo' + slot + '" />' +
      "</div>";
    const rm = document.createElement("button");
    rm.type = "button";
    rm.textContent = "Удалить диапазон";
    rm.style.cssText = "margin-top:6px;background:none;border:none;color:#b03a3a;font-size:12px;font-weight:600;cursor:pointer;padding:0;text-decoration:underline;";
    rm.addEventListener("click", function () { removeBotRange(wrap); });
    wrap.appendChild(rm);
    cont.appendChild(wrap);
    const f = wrap.querySelector('input[name="bookingDateFrom' + slot + '"]');
    const t = wrap.querySelector('input[name="bookingDateTo' + slot + '"]');
    if (prefFrom) f.value = prefFrom;
    if (prefTo) t.value = prefTo;
    wireBotDatePair(f, t);
    relabelBotRanges();
    updateBotAddRangeBtn();
  }
  function clearBotExtraRanges() {
    const cont = document.getElementById("botExtraRanges");
    if (cont) cont.innerHTML = "";
  }

  function updateBotBooking() {
    const wantBot = radio("useBotBooking") === "Да";
    const visa = botVisaCountry();
    const isFrance = visa === "Франция";
    const isSpain = visa === "Испания";

    // «Исключения» — скрываем для Франции и Испании (без исключений).
    const exclWrap = document.getElementById("f_bookingExclusions");
    const exclInput = form.querySelector('input[name="bookingExclusions"]');
    const hideExcl = wantBot && (isFrance || isSpain);
    if (exclWrap) exclWrap.style.display = hideExcl ? "none" : "";
    if (hideExcl && exclInput) exclInput.value = "";

    // Поясняющий текст по стране.
    const hint = document.getElementById("botRangeHint");
    if (hint) {
      if (wantBot && isFrance) {
        hint.textContent = "При записи ботом на французскую визу вы можете выбрать только один диапазон, без исключений.";
        hint.style.display = "block";
      } else if (wantBot && isSpain) {
        hint.textContent = "При записи ботом на испанскую визу вы можете выбрать не более трёх диапазонов записи, без исключений внутри них.";
        hint.style.display = "block";
      } else {
        hint.style.display = "none";
      }
    }

    // Доп. диапазоны — только для Испании. Для остальных убираем.
    if (!(wantBot && isSpain)) clearBotExtraRanges();
    updateBotAddRangeBtn();
  }

  // Инициализация бот-секции: ограничения дат базового диапазона + кнопка.
  wireBotDatePair(
    form.querySelector('input[name="bookingDateFrom"]'),
    form.querySelector('input[name="bookingDateTo"]')
  );
  (function () {
    const addBtn = document.getElementById("botAddRangeBtn");
    if (addBtn) addBtn.addEventListener("click", function () { addBotRange("", ""); });
  })();

  form.addEventListener("change", updateConditionals);
  // employerName / travelCountry — текстовые поля, нужно слушать input для мгновенной реакции.
  form.addEventListener("input", (e) => {
    if (e.target && e.target.name === "employerName") updateConditionals();
    if (e.target && e.target.name === "travelCountry") applyBiometricAckState();
  });
  updateConditionals();

  // ─── Маска для телефонных полей: +7 (XXX) XXX-XX-XX ───
  function formatPhoneRu(rawDigits) {
    let d = String(rawDigits || "").replace(/\\D/g, "");
    if (d.length && d[0] === "8") d = "7" + d.slice(1);
    if (d.length && d[0] !== "7") d = "7" + d;
    d = d.slice(0, 11);
    const a = d.slice(1, 4);
    const b = d.slice(4, 7);
    const c = d.slice(7, 9);
    const e = d.slice(9, 11);
    let out = "+7";
    if (a) out += " (" + a;
    if (a.length === 3) out += ")";
    if (b) out += " " + b;
    if (c) out += "-" + c;
    if (e) out += "-" + e;
    return out;
  }
  function attachPhoneMask(input) {
    if (!input) return;
    function applyMask(skipIfEmpty) {
      const v = input.value || "";
      if (skipIfEmpty && !v.replace(/\\D/g, "")) return;
      input.value = formatPhoneRu(v);
    }
    if (input.value) applyMask(true);
    input.addEventListener("input", () => applyMask(false));
    input.addEventListener("focus", () => {
      if (!input.value) input.value = "+7 ";
    });
    input.addEventListener("blur", () => {
      if (input.value.replace(/\\D/g, "").length <= 1) input.value = "";
    });
  }
  document.querySelectorAll('input[data-phone-mask]').forEach(attachPhoneMask);

  // ─── Даты поездки: первая ≥ завтра, вторая ≥ первой ───
  function pad2(n) { return n < 10 ? "0" + n : String(n); }
  function ymd(date) {
    return date.getFullYear() + "-" + pad2(date.getMonth() + 1) + "-" + pad2(date.getDate());
  }
  function applyTripDateConstraints() {
    const tripFrom = form.querySelector('input[name="tripDateFrom"]');
    const tripTo = form.querySelector('input[name="tripDateTo"]');
    if (!tripFrom || !tripTo) return;
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const tomorrowStr = ymd(tomorrow);
    tripFrom.min = tomorrowStr;
    if (tripFrom.value && tripFrom.value < tomorrowStr) tripFrom.value = tomorrowStr;
    const fromVal = tripFrom.value || tomorrowStr;
    tripTo.min = fromVal;
    if (tripTo.value && tripTo.value < fromVal) tripTo.value = fromVal;
    tripFrom.addEventListener("change", () => {
      const v = tripFrom.value || tomorrowStr;
      tripTo.min = v;
      if (tripTo.value && tripTo.value < v) tripTo.value = v;
    });
  }
  applyTripDateConstraints();

  // Срок действия действующей Шенгенской визы — не ранее даты заполнения
  // опросника (просроченная виза = не действующая, нет смысла её указывать).
  function applySchengenExpiryConstraint() {
    const expiry = form.querySelector('input[name="schengenExpiry"]');
    if (!expiry) return;
    const todayStr = ymd(new Date());
    expiry.min = todayStr;
    if (expiry.value && expiry.value < todayStr) expiry.value = todayStr;
    expiry.addEventListener("change", () => {
      if (expiry.value && expiry.value < todayStr) expiry.value = todayStr;
    });
  }
  applySchengenExpiryConstraint();

  // ─── Логика «Я ещё не знаю точных дат поездки» ───
  const tripUnknownInput = form.querySelector('input[name="tripDatesUnknown"]');
  const tripAckInput = form.querySelector('input[name="tripDatesAck"]');
  const tripAckRow = document.getElementById("tripDatesAckRow");
  const tripDatesInputsEl = document.getElementById("tripDatesInputs");
  const tripFromInputEl = form.querySelector('input[name="tripDateFrom"]');
  const tripToInputEl = form.querySelector('input[name="tripDateTo"]');

  function applyTripDatesUnknownState() {
    if (!tripUnknownInput) return;
    const unknown = tripUnknownInput.checked;
    if (unknown) {
      if (tripDatesInputsEl) tripDatesInputsEl.style.display = "none";
      if (tripFromInputEl) {
        tripFromInputEl.required = false;
        tripFromInputEl.classList.remove("input-error");
      }
      if (tripToInputEl) {
        tripToInputEl.required = false;
        tripToInputEl.classList.remove("input-error");
      }
      if (tripAckRow) tripAckRow.style.display = "";
    } else {
      if (tripDatesInputsEl) tripDatesInputsEl.style.display = "";
      if (tripFromInputEl) tripFromInputEl.required = true;
      if (tripToInputEl) tripToInputEl.required = true;
      if (tripAckRow) {
        tripAckRow.style.display = "none";
        tripAckRow.classList.remove("ack-error");
      }
      if (tripAckInput) tripAckInput.checked = false;
    }
  }
  if (tripUnknownInput) {
    tripUnknownInput.addEventListener("change", applyTripDatesUnknownState);
  }
  if (tripAckInput && tripAckRow) {
    tripAckInput.addEventListener("change", () => {
      if (tripAckInput.checked) tripAckRow.classList.remove("ack-error");
    });
  }
  applyTripDatesUnknownState();

  // ─── Биометрический паспорт: обязательные галочки-уведомления по стране поездки ───
  // BIO10 — страны, для въезда в которые гражданам РФ нужен биометрический
  // (10-летний) загранпаспорт. «Страна поездки» — свободный текст, поэтому
  // сравнение регистронезависимое и по вхождению подстроки. Франция — отдельная
  // формулировка («старше 14 лет»), поэтому отдельная галочка.
  function applyBiometricAckState() {
    const BIO10 = ["чехия","дания","германия","эстония","литва","латвия","польша","румыния","исландия","финляндия"];
    const tcEl = form.querySelector('input[name="travelCountry"]');
    const val = (tcEl && tcEl.value || "").trim().toLowerCase();
    const show10 = BIO10.some((c) => val.includes(c));
    const showFr = val.includes("франция");
    const row10 = document.getElementById("biometricAckRow");
    const in10 = form.querySelector('input[name="biometricAck"]');
    if (row10) {
      row10.style.display = show10 ? "" : "none";
      if (!show10) { row10.classList.remove("ack-error"); if (in10) in10.checked = false; }
    }
    const rowFr = document.getElementById("biometricAckFrRow");
    const inFr = form.querySelector('input[name="biometricAckFr"]');
    if (rowFr) {
      rowFr.style.display = showFr ? "" : "none";
      if (!showFr) { rowFr.classList.remove("ack-error"); if (inFr) inFr.checked = false; }
    }
  }
  const bioAckIn10 = form.querySelector('input[name="biometricAck"]');
  if (bioAckIn10) bioAckIn10.addEventListener("change", () => {
    if (bioAckIn10.checked) { const r = document.getElementById("biometricAckRow"); if (r) r.classList.remove("ack-error"); }
  });
  const bioAckInFr = form.querySelector('input[name="biometricAckFr"]');
  if (bioAckInFr) bioAckInFr.addEventListener("change", () => {
    if (bioAckInFr.checked) { const r = document.getElementById("biometricAckFrRow"); if (r) r.classList.remove("ack-error"); }
  });
  applyBiometricAckState();

  // ─── Проверка дубликата ФИО в рамках этой сделки ───
  const EXISTING_FIOS = ${JSON.stringify(existingFios || []).replace(/</g, "\\u003c")};
  const CURRENT_APPLICANT_INDEX = ${JSON.stringify(applicantIndex)};
  function normFio(s) {
    return String(s || "").trim().replace(/\\s+/g, " ").toLowerCase();
  }
  const fullNameInput = form.querySelector('input[name="fullName"]');
  let fioDupErrEl = null;
  if (fullNameInput) {
    fioDupErrEl = document.createElement("div");
    fioDupErrEl.className = "field-inline-error";
    fioDupErrEl.style.color = "#c4314b";
    fioDupErrEl.style.fontSize = "13px";
    fioDupErrEl.style.marginTop = "6px";
    fioDupErrEl.style.lineHeight = "1.4";
    fioDupErrEl.style.display = "none";
    fioDupErrEl.textContent = "Опросник на это ФИО уже заполнен в этой сделке. Укажите другое ФИО.";
    fullNameInput.insertAdjacentElement("afterend", fioDupErrEl);
  }
  function checkFioDuplicate() {
    if (!fullNameInput) return false;
    const v = normFio(fullNameInput.value);
    if (!v) {
      if (fioDupErrEl) fioDupErrEl.style.display = "none";
      fullNameInput.classList.remove("input-error");
      if (submitBtn) submitBtn.disabled = false;
      return false;
    }
    const isDup = EXISTING_FIOS.some((it) => {
      const otherIdx = parseInt(it && it.idx, 10);
      const otherFio = normFio(it && it.fullName);
      if (!otherFio) return false;
      // В edit-режиме своё ФИО разрешено (тот же applicantIndex).
      if (otherIdx === CURRENT_APPLICANT_INDEX) return false;
      return otherFio === v;
    });
    if (isDup) {
      if (fioDupErrEl) fioDupErrEl.style.display = "block";
      fullNameInput.classList.add("input-error");
      if (submitBtn) submitBtn.disabled = true;
    } else {
      if (fioDupErrEl) fioDupErrEl.style.display = "none";
      fullNameInput.classList.remove("input-error");
      if (submitBtn) submitBtn.disabled = false;
    }
    return isDup;
  }
  if (fullNameInput) {
    fullNameInput.addEventListener("input", checkFioDuplicate);
    fullNameInput.addEventListener("blur", checkFioDuplicate);
    // Первичная проверка (например, при prefill)
    setTimeout(checkFioDuplicate, 0);
  }

  // Prefill (для режима "Скорректировать опросник")
  const PREFILL = ${JSON.stringify(prefill || null).replace(/</g, "\\u003c")};
  if (PREFILL && typeof PREFILL === "object") {
    Object.keys(PREFILL).forEach((name) => {
      const val = PREFILL[name];
      if (val === null || val === undefined || val === "") return;
      const inputs = form.querySelectorAll('[name="' + name + '"]');
      inputs.forEach((input) => {
        const t = (input.type || "").toLowerCase();
        if (t === "radio" || t === "checkbox") {
          input.checked = (input.value === String(val));
        } else if (t === "file" || t === "hidden") {
          return;
        } else {
          input.value = String(val);
        }
      });
    });
    updateConditionals();
    // После prefill пересинхронизируем UI чек-бокса «не знаю дат» (скрытие/показ полей дат)
    applyTripDatesUnknownState();
    // visaCountry стал выпадающим списком: если сохранённое (старое, «несписочное»)
    // значение не совпадает ни с одним пунктом — добавляем его, чтобы не потерять.
    if (PREFILL.visaCountry) {
      const vsel = form.querySelector('select[name="visaCountry"]');
      if (vsel) {
        const want = String(PREFILL.visaCountry);
        if (![].some.call(vsel.options, function (o) { return o.value === want; })) {
          const o = document.createElement("option"); o.value = want; o.textContent = want; vsel.appendChild(o);
        }
        vsel.value = want;
      }
    }
    // occupation тоже стал выпадающим списком — сохраняем старое значение при правке.
    if (PREFILL.occupation) {
      const osel = form.querySelector('select[name="occupation"]');
      if (osel) {
        const want = String(PREFILL.occupation);
        if (![].some.call(osel.options, function (o) { return o.value === want; })) {
          const o = document.createElement("option"); o.value = want; o.textContent = want; osel.appendChild(o);
        }
        osel.value = want;
      }
    }
    // Доп. диапазоны записи (Испания) — восстанавливаем при правке.
    if (PREFILL.bookingDateFrom2 || PREFILL.bookingDateTo2) addBotRange(PREFILL.bookingDateFrom2 || "", PREFILL.bookingDateTo2 || "");
    if (PREFILL.bookingDateFrom3 || PREFILL.bookingDateTo3) addBotRange(PREFILL.bookingDateFrom3 || "", PREFILL.bookingDateTo3 || "");
    updateBotBooking();
  }

  // Снимаем подсветку ошибки с поля при изменении/вводе
  form.addEventListener("input", (e) => {
    if (e.target && e.target.classList && e.target.classList.contains("input-error")) {
      e.target.classList.remove("input-error");
    }
  });
  form.addEventListener("change", (e) => {
    if (e.target && e.target.classList && e.target.classList.contains("input-error")) {
      e.target.classList.remove("input-error");
    }
  });

  function validateRequiredFields() {
    // Список пар «обязательных» дат — проверяем только те, что видимы (не внутри скрытого .cond)
    const datePairs = [
      ["tripDateFrom", "tripDateTo"],
      ["bookingDateFrom", "bookingDateTo"]
    ];
    let firstBad = null;
    datePairs.forEach((pair) => {
      pair.forEach((name) => {
        const el = form.querySelector('input[name="' + name + '"]');
        if (!el) return;
        // Проверяем только видимые поля
        if (el.offsetParent === null) return;
        if (!el.value) {
          el.classList.add("input-error");
          if (!firstBad) firstBad = el;
        }
      });
    });
    return firstBad;
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    hideBox(errorBox);
    hideBox(successBox);

    // Проверка дубликата ФИО — финальная страховка перед отправкой
    if (checkFioDuplicate()) {
      if (fullNameInput && fullNameInput.scrollIntoView) {
        fullNameInput.scrollIntoView({ behavior: "smooth", block: "center" });
      }
      try { if (fullNameInput) fullNameInput.focus({ preventScroll: true }); } catch (_) { if (fullNameInput) fullNameInput.focus(); }
      return;
    }

    // Если клиент выбрал «Я ещё не знаю точных дат поездки» — даты не обязательны,
    // зато требуется подтверждающий чек-бокс ниже. Если он не отмечен — блокируем сабмит,
    // подсвечиваем строку красным.
    if (tripUnknownInput && tripUnknownInput.checked) {
      if (tripAckInput && !tripAckInput.checked) {
        if (tripAckRow) {
          tripAckRow.classList.add("ack-error");
          if (tripAckRow.scrollIntoView) tripAckRow.scrollIntoView({ behavior: "smooth", block: "center" });
        }
        showBox(errorBox, "Поставьте галочку в чек-боксе подтверждения сроков.");
        return;
      }
    } else {
      // Обычный путь — обе даты обязательны (validateRequiredFields пропускает скрытые поля).
      const badDate = validateRequiredFields();
      if (badDate) {
        showBox(errorBox, "Заполните даты поездки — оба поля обязательны.");
        if (badDate.scrollIntoView) badDate.scrollIntoView({ behavior: "smooth", block: "center" });
        try { badDate.focus({ preventScroll: true }); } catch (_) { badDate.focus(); }
        return;
      }
    }

    // Биометрический паспорт — если уведомление видимо (страна из списка),
    // галочка обязательна. Не отмечена → подсветка красным + скролл к пункту.
    const bioAckRows = [
      ["biometricAckRow", "biometricAck"],
      ["biometricAckFrRow", "biometricAckFr"]
    ];
    for (const pair of bioAckRows) {
      const rowEl = document.getElementById(pair[0]);
      const inEl = form.querySelector('input[name="' + pair[1] + '"]');
      if (rowEl && rowEl.style.display !== "none" && inEl && !inEl.checked) {
        rowEl.classList.add("ack-error");
        if (rowEl.scrollIntoView) rowEl.scrollIntoView({ behavior: "smooth", block: "center" });
        showBox(errorBox, "Поставьте галочку: подтвердите, что уведомлены о требовании биометрического загранпаспорта.");
        return;
      }
    }

    // Проверка согласий — без сброса данных формы
    const accuracyVal = radio("confirmAccuracy");
    if (accuracyVal !== "Да") {
      showBox(errorBox, 'Чтобы отправить опросник, подтвердите правильность и достоверность указанных сведений (выберите "Да").');
      const el = form.querySelector('input[name="confirmAccuracy"]');
      if (el && el.scrollIntoView) el.scrollIntoView({ behavior: "smooth", block: "center" });
      return;
    }
    const prevDataVal = radio("confirmPrevData");
    if (prevDataVal !== "Да") {
      showBox(errorBox, 'Чтобы отправить опросник, согласитесь с условиями электронного опросника (выберите "Да").');
      const el = form.querySelector('input[name="confirmPrevData"]');
      if (el && el.scrollIntoView) el.scrollIntoView({ behavior: "smooth", block: "center" });
      return;
    }
    const consentVal = radio("personalDataConsent");
    if (consentVal !== "Да") {
      showBox(errorBox, 'Чтобы отправить опросник, согласитесь на обработку персональных данных (выберите "Да").');
      const el = form.querySelector('input[name="personalDataConsent"]');
      if (el && el.scrollIntoView) el.scrollIntoView({ behavior: "smooth", block: "center" });
      return;
    }

    submitBtn.disabled = true;
    submitBtn.textContent = "Отправка...";

    try {
      const formData = new FormData(form);

      const response = await fetch("/api/questionnaire", {
        method: "POST",
        body: formData
      });

      const data = await response.json();

      if (!response.ok || !data.success) {
        throw new Error(data.message || "Не удалось отправить опросник");
      }

      const IS_SHARE_MODE = ${JSON.stringify(isShareMode)};
      if (IS_SHARE_MODE) {
        showBox(successBox, "Спасибо! Опросник отправлен. Можете закрыть страницу.");
        submitBtn.style.display = "none";
        if (successBox.scrollIntoView) successBox.scrollIntoView({ behavior: "smooth", block: "center" });
        return;
      }

      showBox(successBox, "Опросник успешно отправлен");

      try {
        localStorage.setItem("vsc_questionnaire_updated", JSON.stringify({
          phone: "${safePhone}",
          leadId: "${safeLeadId}",
          ts: Date.now()
        }));
      } catch (_) {}

      setTimeout(() => {
        if (data.nextApplicantUrl) {
          window.location.href = data.nextApplicantUrl;
          return;
        }
        if (window.opener && !window.opener.closed) { window.close(); return; }
        if (window.history.length > 1) { window.history.back(); return; }
        window.location.href = "/";
      }, 700);
    } catch (error) {
      console.error("QUESTIONNAIRE SUBMIT ERROR:", error);
      showBox(errorBox, error.message || "Ошибка отправки опросника");
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = "Отправить опросник";
    }
  });
</script>
</body>
</html>`;
}

// ────────────────────────────────────────────────────────────────────
// Опросник: ВИЗА В ЯПОНИЮ.
// Отдельная функция, параллельная buildQuestionnaireHtml (Шенген).
// Общий wrapper / CSS / submit-handler — те же, что у Шенгена, чтобы не
// расходилось визуально. Поля и их состав — по скриншотам, которые
// пользователь приложил (vision-документ). Поля имеют префикс `jp_`,
// кроме семантически идентичных с Шенгеном (fullName / actualAddress /
// contactPhone / email) — чтобы multi-applicant логика, имя папки на
// Я.Диске, маска телефона работали «из коробки» так же.
// ────────────────────────────────────────────────────────────────────
function buildJapanQuestionnaireHtml({ phone, leadId, countryService, applicantIndex = 1, totalApplicants = 1, prevApplicantName = "", prefill = null, isEdit = false, applicantCount = 0, visaType = "", shareToken = "", isMixed = false, selfFillCount = 0, selfStep = 0, existingFios = [] }) {
  const safePhone = escapeHtml(phone || "");
  const safeLeadId = escapeHtml(String(leadId || ""));
  const safeCountry = escapeHtml(countryService || "не указано");
  const idx = Math.max(1, parseInt(applicantIndex, 10) || 1);
  const total = Math.max(idx, parseInt(totalApplicants, 10) || 1);
  const safePrevName = escapeHtml(prevApplicantName || "");
  const isFirstApplicant = idx === 1;
  const safeApplicantCount = Math.max(0, parseInt(applicantCount, 10) || 0);
  const safeVisaType = escapeHtml(visaType || "Виза в Японию");
  const safeShareToken = escapeHtml(String(shareToken || ""));
  const isShareMode = !!shareToken;
  const safeSelfFillCount = Math.max(0, parseInt(selfFillCount, 10) || 0);
  const safeSelfStep = Math.max(0, parseInt(selfStep, 10) || 0);

  const titleText = "Опросник на визу в Японию";
  const subtitleText = isEdit
    ? "Внесите изменения и нажмите «Отправить опросник»."
    : 'Заполните данные и нажмите "Отправить опросник" внизу страницы';

  const showHandoff = isMixed
    ? (safeSelfStep > 1 && !isEdit)
    : (!isFirstApplicant && !isEdit);
  const handoffNoticeHtml = !showHandoff ? "" : `
    <div class="handoff-notice">
      Опросник для <strong>${safePrevName || "предыдущего заявителя"}</strong> отправлен. Заполните опросник на следующего заявителя.
    </div>`;

  const applicantCountFieldHtml = (!isEdit && safeApplicantCount > 0) ? `
    <input type="hidden" name="applicantCount" value="${safeApplicantCount}" />` : "";
  const mixedFieldsHtml = isMixed ? `
    <input type="hidden" name="mixed" value="1" />
    <input type="hidden" name="selfFillCount" value="${safeSelfFillCount}" />
    <input type="hidden" name="selfStep" value="${safeSelfStep}" />` : "";

  // Хелперы prefill-значений: при «Скорректировать опросник» подставляют
  // ранее введённое из JSON-стейта.
  const pv = (name) => {
    if (!prefill) return "";
    const v = prefill[name];
    return v == null ? "" : escapeHtml(String(v));
  };
  const pvRaw = (name) => {
    if (!prefill) return "";
    return prefill[name] == null ? "" : String(prefill[name]);
  };
  const radioSel = (name, val) => pvRaw(name) === val ? "checked" : "";
  // Чекбокс «Да/Нет» (одиночный) — checked, если в state записано "Да".
  const chkYes = (name) => pvRaw(name) === "Да" ? "checked" : "";
  const selectSel = (name, val) => pvRaw(name) === val ? "selected" : "";
  const existingFiosJsonSafe = JSON.stringify(Array.isArray(existingFios) ? existingFios : []).replace(/</g, "\\u003c");

  return `<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Опросный лист</title>
  <style>
    * { box-sizing: border-box; }
    body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif; background: #f3f2f7; color: #1d2330; padding: 24px; }
    .wrap { max-width: 760px; margin: 0 auto; background: #fff; border: 1px solid #ece7f2; border-radius: 24px; padding: 24px; box-shadow: 0 10px 30px rgba(34, 36, 52, 0.05); }
    h1 { margin: 0 0 8px; font-size: 28px; line-height: 1.15; color: #171c29; }
    .subtitle { margin: 0 0 22px; font-size: 14px; color: #737988; line-height: 1.5; }
    form { display: grid; gap: 14px; }
    .field { display: grid; gap: 6px; }
    .field > label { font-size: 14px; font-weight: 600; color: #3a4150; }
    .field input[type="text"], .field input[type="tel"], .field input[type="email"], .field input[type="date"], .field select, .field textarea {
      width: 100%; height: 50px; border: 1px solid #e8e2ee; border-radius: 14px; padding: 0 14px; font-size: 16px; outline: none; background: #fff; color: #1f2532; font-family: inherit;
    }
    .field textarea { height: auto; min-height: 80px; padding: 12px 14px; resize: vertical; }
    .hint { font-size: 12px; color: #9096a3; line-height: 1.4; }
    .radio-group { display: flex; gap: 10px; flex-wrap: wrap; }
    .radio-group label {
      display: flex; align-items: center; gap: 6px; font-size: 14px; font-weight: 400; color: #1d2330; cursor: pointer;
      padding: 10px 16px; border: 1px solid #e8e2ee; border-radius: 12px; background: #fff;
    }
    .radio-group input[type="radio"] { accent-color: #4f9f68; width: 16px; height: 16px; }
    .radio-group label:has(input:checked) { border-color: #4f9f68; background: #f0faf3; }
    /* Вертикальный список «пилюль» для длинных radio-списков (цель визита, род занятий, статус приглашающего). */
    .radio-stack { display: grid; gap: 8px; }
    .radio-stack label {
      display: flex; align-items: center; gap: 8px; font-size: 14px; color: #1d2330; cursor: pointer;
      padding: 12px 16px; border: 1px solid #e8e2ee; border-radius: 12px; background: #fff;
    }
    .radio-stack input[type="radio"] { accent-color: #4f9f68; width: 16px; height: 16px; }
    .radio-stack label:has(input:checked) { border-color: #4f9f68; background: #f0faf3; }
    /* Одиночные «карточки-чекбоксы» (Да-если-отмечено). */
    .checkbox-card {
      display: flex; align-items: center; gap: 10px; font-size: 14px; color: #1d2330; cursor: pointer;
      padding: 12px 16px; border: 1px solid #e8e2ee; border-radius: 12px; background: #fff;
    }
    .checkbox-card input[type="checkbox"] { accent-color: #4f9f68; width: 16px; height: 16px; flex: 0 0 auto; }
    .checkbox-card:has(input:checked) { border-color: #4f9f68; background: #f0faf3; }
    /* Группа чекбоксов (multi-select) для «что применимо к вам». */
    .checkbox-stack { display: grid; gap: 8px; }
    .checkbox-stack label {
      display: flex; align-items: flex-start; gap: 10px; font-size: 14px; color: #1d2330; cursor: pointer;
      padding: 12px 16px; border: 1px solid #e8e2ee; border-radius: 12px; background: #fff; line-height: 1.4;
    }
    .checkbox-stack input[type="checkbox"] { accent-color: #4f9f68; width: 16px; height: 16px; flex: 0 0 auto; margin-top: 1px; }
    .checkbox-stack label:has(input:checked) { border-color: #4f9f68; background: #f0faf3; }
    /* Условные блоки — показываются только после установки галки/выбора. */
    .cond { display: none; }
    .cond.show { display: grid; gap: 14px; }
    .message { display: none; padding: 12px 14px; border-radius: 14px; font-size: 14px; margin-bottom: 16px; }
    .message.error { background: #fbebee; border: 1px solid #efcfd5; color: #a15561; }
    .message.success { background: #edf8ef; border: 1px solid #cfe7d2; color: #2e7a43; }
    .handoff-notice { padding: 12px 14px; border-radius: 14px; font-size: 14px; line-height: 1.5; background: #f0f7fc; border: 1px solid #d3e7f4; color: #2f6e95; margin-bottom: 14px; }
    .submit-btn { height: 50px; border: none; border-radius: 14px; background: #3589BD; color: #fff; font-size: 16px; font-weight: 600; cursor: pointer; margin-top: 8px; }
    .submit-btn:disabled { opacity: 0.7; cursor: not-allowed; }
    .date-row { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
    .date-row > input { min-width: 0; width: 100%; }
    @media (max-width: 480px) { .date-row { grid-template-columns: 1fr; } }
    .field input.input-error, .date-row input.input-error, .checkbox-card.input-error, .checkbox-stack.input-error label {
      border-color: #d97a8a !important; background: #fbebee !important;
    }
    .required-star { color: #d97a8a; margin-right: 4px; }
  </style>
</head>
<body>
<div class="wrap">
  <h1>${titleText}</h1>
  <p class="subtitle">${subtitleText}</p>

  <div id="errorBox" class="message error"></div>
  <div id="successBox" class="message success"></div>
${handoffNoticeHtml}
  <form id="questionnaireForm">
    <input type="hidden" name="phone" value="${safePhone}" />
    <input type="hidden" name="leadId" value="${safeLeadId}" />
    <input type="hidden" name="applicantIndex" value="${idx}" />
    <input type="hidden" name="totalApplicants" value="${total}" />
    <input type="hidden" name="isEdit" value="${isEdit ? "1" : ""}" />
    <input type="hidden" name="visaType" value="${safeVisaType}" />
    <input type="hidden" name="shareToken" value="${safeShareToken}" />
${applicantCountFieldHtml}
${mixedFieldsHtml}

    <!-- 1 -->
    <div class="field">
      <label><span class="required-star">*</span>Полное ФИО заявителя</label>
      <input type="text" name="fullName" value="${pv("fullName")}" required />
    </div>

    <!-- 2 -->
    <label class="checkbox-card">
      <input type="checkbox" name="jp_hadOtherNames" value="Да" ${chkYes("jp_hadOtherNames")} />
      <span>У меня ранее были другие имена/фамилии</span>
    </label>

    <!-- 2a — условно (jp_hadOtherNames === "Да") -->
    <div class="cond" id="c_jp_otherNames">
      <div class="field">
        <label><span class="required-star">*</span>Укажите другие имена/фамилии</label>
        <input type="text" name="jp_otherNames" value="${pv("jp_otherNames")}" />
      </div>
    </div>

    <!-- 3 -->
    <div class="field">
      <label><span class="required-star">*</span>Семейное положение</label>
      <div class="radio-stack">
        <label><input type="radio" name="jp_maritalStatus" value="Состою в браке" ${radioSel("jp_maritalStatus","Состою в браке")} required /> Состою в браке</label>
        <label><input type="radio" name="jp_maritalStatus" value="Холост/не замужем" ${radioSel("jp_maritalStatus","Холост/не замужем")} /> Холост/не замужем</label>
        <label><input type="radio" name="jp_maritalStatus" value="В разводе" ${radioSel("jp_maritalStatus","В разводе")} /> В разводе</label>
        <label><input type="radio" name="jp_maritalStatus" value="Вдовец/вдова" ${radioSel("jp_maritalStatus","Вдовец/вдова")} /> Вдовец/вдова</label>
      </div>
    </div>

    <!-- 3a — условно (jp_maritalStatus === "Состою в браке") -->
    <div class="cond" id="c_jp_spouseOccupation">
      <div class="field">
        <label><span class="required-star">*</span>Род занятий супруга/супруги</label>
        <input type="text" name="jp_spouseOccupation" value="${pv("jp_spouseOccupation")}" />
      </div>
    </div>

    <!-- 4 -->
    <label class="checkbox-card">
      <input type="checkbox" name="jp_hasSecondCitizenship" value="Да" ${chkYes("jp_hasSecondCitizenship")} />
      <span>У меня есть второе гражданство</span>
    </label>

    <!-- 4a — условно (jp_hasSecondCitizenship === "Да") -->
    <div class="cond" id="c_jp_secondCitizenship">
      <div class="field">
        <label><span class="required-star">*</span>Какое второе гражданство?</label>
        <input type="text" name="jp_secondCitizenship" value="${pv("jp_secondCitizenship")}" />
      </div>
    </div>

    <!-- 5 -->
    <div class="field">
      <label><span class="required-star">*</span>На какой загранпаспорт оформляем визу?</label>
      <input type="text" name="jp_passportForVisa" value="${pv("jp_passportForVisa")}" required />
    </div>

    <!-- 6 -->
    <div class="field">
      <label><span class="required-star">*</span>В каком городе выдан этот паспорт?</label>
      <input type="text" name="jp_passportCity" value="${pv("jp_passportCity")}" required />
    </div>

    <!-- 7 -->
    <div class="field">
      <label>Цель визита в Японию</label>
      <div class="radio-stack">
        <label><input type="radio" name="jp_tripPurpose" value="Туризм" ${radioSel("jp_tripPurpose","Туризм")} /> Туризм</label>
        <label><input type="radio" name="jp_tripPurpose" value="Бизнес" ${radioSel("jp_tripPurpose","Бизнес")} /> Бизнес</label>
        <label><input type="radio" name="jp_tripPurpose" value="Посещение семьи и друзей" ${radioSel("jp_tripPurpose","Посещение семьи и друзей")} /> Посещение семьи и друзей</label>
        <label><input type="radio" name="jp_tripPurpose" value="Учеба" ${radioSel("jp_tripPurpose","Учеба")} /> Учеба</label>
        <label><input type="radio" name="jp_tripPurpose" value="Работа" ${radioSel("jp_tripPurpose","Работа")} /> Работа</label>
      </div>
    </div>

    <!-- 8 -->
    <div class="field">
      <label><span class="required-star">*</span>Даты визита в Японию</label>
      <div class="date-row">
        <input type="date" name="jp_tripDateFrom" value="${pv("jp_tripDateFrom")}" placeholder="с" required />
        <input type="date" name="jp_tripDateTo" value="${pv("jp_tripDateTo")}" placeholder="по" required />
      </div>
    </div>

    <!-- 9 -->
    <div class="field">
      <label><span class="required-star">*</span>Города, которые вы планируете посетить</label>
      <input type="text" name="jp_citiesToVisit" value="${pv("jp_citiesToVisit")}" required />
    </div>

    <!-- 10 -->
    <label class="checkbox-card">
      <input type="checkbox" name="jp_knowsAccommodation" value="Да" ${chkYes("jp_knowsAccommodation")} />
      <span>Я уже знаю, где буду проживать во время визита в Японию</span>
    </label>

    <!-- 10a — условно (jp_knowsAccommodation === "Да") -->
    <div class="cond" id="c_jp_accommodation">
      <div class="field">
        <label><span class="required-star">*</span>Название отеля / места проживания</label>
        <input type="text" name="jp_accommodationName" value="${pv("jp_accommodationName")}" />
      </div>
      <div class="field">
        <label><span class="required-star">*</span>Адрес места проживания</label>
        <input type="text" name="jp_accommodationAddress" value="${pv("jp_accommodationAddress")}" />
      </div>
    </div>

    <!-- 10b — свои авиабилеты -->
    <label class="checkbox-card">
      <input type="checkbox" name="jp_hasOwnFlights" value="Да" ${chkYes("jp_hasOwnFlights")} />
      <span>У меня есть свои авиабилеты</span>
    </label>

    <!-- 11 -->
    <label class="checkbox-card">
      <input type="checkbox" name="jp_visitedJapanBefore" value="Да" ${chkYes("jp_visitedJapanBefore")} />
      <span>Я уже был/-а в Японии ранее</span>
    </label>

    <!-- 11a — условно (jp_visitedJapanBefore === "Да") -->
    <div class="cond" id="c_jp_japanVisits">
      <div class="field">
        <label><span class="required-star">*</span>Укажите визиты в Японию</label>
        <textarea name="jp_japanVisits" rows="3" placeholder="Например: с 01.01.2026 10 дней, Токио">${pv("jp_japanVisits")}</textarea>
        <span class="hint">Точные даты, продолжительность и города каждого визита</span>
      </div>
    </div>

    <!-- 12 -->
    <div class="field">
      <label><span class="required-star">*</span>Фактический адрес проживания в РФ</label>
      <input type="text" name="actualAddress" value="${pv("actualAddress")}" required />
      <span class="hint">Может не совпадать с пропиской</span>
    </div>

    <!-- 13 -->
    <div class="field">
      <label><span class="required-star">*</span>Контактный телефон</label>
      <input type="tel" name="contactPhone" value="${pv("contactPhone")}" inputmode="tel" autocomplete="tel" placeholder="+7 (___) ___-__-__" data-phone-mask required />
    </div>

    <!-- 14 -->
    <div class="field">
      <label><span class="required-star">*</span>Электронная почта</label>
      <input type="email" name="email" value="${pv("email")}" inputmode="email" autocomplete="email" placeholder="example@mail.ru" required />
    </div>

    <!-- 15 -->
    <div class="field">
      <label><span class="required-star">*</span>Род занятий</label>
      <div class="radio-stack">
        <label><input type="radio" name="jp_occupation" value="Работа по найму" ${radioSel("jp_occupation","Работа по найму")} required /> Работа по найму</label>
        <label><input type="radio" name="jp_occupation" value="Индивидуальный предприниматель" ${radioSel("jp_occupation","Индивидуальный предприниматель")} /> Индивидуальный предприниматель</label>
        <label><input type="radio" name="jp_occupation" value="Самозанятый" ${radioSel("jp_occupation","Самозанятый")} /> Самозанятый</label>
        <label><input type="radio" name="jp_occupation" value="Учащийся" ${radioSel("jp_occupation","Учащийся")} /> Учащийся</label>
        <label><input type="radio" name="jp_occupation" value="Пенсионер" ${radioSel("jp_occupation","Пенсионер")} /> Пенсионер</label>
        <label><input type="radio" name="jp_occupation" value="Безработный" ${radioSel("jp_occupation","Безработный")} /> Безработный</label>
        <label><input type="radio" name="jp_occupation" value="Другое" ${radioSel("jp_occupation","Другое")} /> Другое</label>
      </div>
    </div>

    <!-- 15a — условно: «Работа по найму» -->
    <div class="cond" id="c_jp_employed">
      <div class="field">
        <label><span class="required-star">*</span>Наименование работодателя</label>
        <input type="text" name="jp_employerName" value="${pv("jp_employerName")}" />
      </div>
      <div class="field">
        <label><span class="required-star">*</span>Адрес работодателя</label>
        <input type="text" name="jp_employerAddress" value="${pv("jp_employerAddress")}" />
      </div>
      <div class="field">
        <label><span class="required-star">*</span>Телефон работодателя</label>
        <input type="tel" name="jp_employerPhone" value="${pv("jp_employerPhone")}" inputmode="tel" placeholder="+7 (___) ___-__-__" data-phone-mask />
      </div>
      <div class="field">
        <label><span class="required-star">*</span>Должность</label>
        <input type="text" name="jp_position" value="${pv("jp_position")}" />
      </div>
    </div>

    <!-- 15b — условно: «Индивидуальный предприниматель» -->
    <div class="cond" id="c_jp_ip">
      <div class="field">
        <label><span class="required-star">*</span>Наименование ИП / ОГРНИП</label>
        <input type="text" name="jp_ipName" value="${pv("jp_ipName")}" />
      </div>
      <div class="field">
        <label><span class="required-star">*</span>Вид деятельности</label>
        <input type="text" name="jp_ipActivity" value="${pv("jp_ipActivity")}" />
      </div>
    </div>

    <!-- 15c — условно: «Самозанятый» -->
    <div class="cond" id="c_jp_selfemployed">
      <div class="field">
        <label><span class="required-star">*</span>Вид деятельности</label>
        <input type="text" name="jp_selfActivity" value="${pv("jp_selfActivity")}" />
      </div>
    </div>

    <!-- 15d — условно: «Учащийся» -->
    <div class="cond" id="c_jp_student">
      <div class="field">
        <label><span class="required-star">*</span>Наименование учебного заведения</label>
        <input type="text" name="jp_studyPlace" value="${pv("jp_studyPlace")}" />
      </div>
      <div class="field">
        <label><span class="required-star">*</span>Адрес учебного заведения</label>
        <input type="text" name="jp_studyAddress" value="${pv("jp_studyAddress")}" />
      </div>
    </div>

    <!-- 15e — условно: «Безработный» -->
    <div class="cond" id="c_jp_unemployed">
      <div class="field">
        <label><span class="required-star">*</span>Источник дохода / средств к существованию</label>
        <input type="text" name="jp_unemployedIncome" value="${pv("jp_unemployedIncome")}" />
      </div>
    </div>

    <!-- 15f — условно: «Другое» -->
    <div class="cond" id="c_jp_occupationOther">
      <div class="field">
        <label><span class="required-star">*</span>Опишите ваш род занятий</label>
        <input type="text" name="jp_occupationOther" value="${pv("jp_occupationOther")}" />
      </div>
    </div>

    <!-- 16 -->
    <label class="checkbox-card">
      <input type="checkbox" name="jp_isUnder18" value="Да" ${chkYes("jp_isUnder18")} />
      <span>Заявитель младше 18 лет</span>
    </label>

    <!-- 16a — условно (jp_isUnder18 === "Да") -->
    <div class="cond" id="c_jp_parents">
      <div class="field">
        <label><span class="required-star">*</span>ФИО отца</label>
        <input type="text" name="jp_fatherFullName" value="${pv("jp_fatherFullName")}" />
      </div>
      <div class="field">
        <label><span class="required-star">*</span>ФИО матери</label>
        <input type="text" name="jp_motherFullName" value="${pv("jp_motherFullName")}" />
      </div>
    </div>

    <!-- 17 -->
    <label class="checkbox-card">
      <input type="checkbox" name="jp_hasInvitation" value="Да" ${chkYes("jp_hasInvitation")} />
      <span>Меня приглашают в Японию</span>
    </label>

    <!-- 18 — условно (jp_hasInvitation === "Да") -->
    <div class="cond" id="c_jp_inviter">
      <div class="field">
        <label><span class="required-star">*</span>ФИО приглашающего лица</label>
        <input type="text" name="jp_inviterName" value="${pv("jp_inviterName")}" />
      </div>
      <div class="field">
        <label><span class="required-star">*</span>Адрес приглашающего лица</label>
        <input type="text" name="jp_inviterAddress" value="${pv("jp_inviterAddress")}" />
      </div>
      <div class="field">
        <label><span class="required-star">*</span>Кем приходится приглашающее лицо</label>
        <input type="text" name="jp_inviterRelation" value="${pv("jp_inviterRelation")}" placeholder="Например: друг, родственник, коллега" />
      </div>
      <div class="field">
        <label><span class="required-star">*</span>Статус приглашающего лица в Японии</label>
        <div class="radio-stack">
          <label><input type="radio" name="jp_inviterStatus" value="Гражданин" ${radioSel("jp_inviterStatus","Гражданин")} /> Гражданин</label>
          <label><input type="radio" name="jp_inviterStatus" value="Постоянный резидент" ${radioSel("jp_inviterStatus","Постоянный резидент")} /> Постоянный резидент</label>
          <label><input type="radio" name="jp_inviterStatus" value="Рабочая виза" ${radioSel("jp_inviterStatus","Рабочая виза")} /> Рабочая виза</label>
          <label><input type="radio" name="jp_inviterStatus" value="Учебная виза" ${radioSel("jp_inviterStatus","Учебная виза")} /> Учебная виза</label>
          <label><input type="radio" name="jp_inviterStatus" value="Иное" ${radioSel("jp_inviterStatus","Иное")} /> Иное</label>
        </div>
      </div>
    </div>

    <!-- 18a — спонсор поездки -->
    <label class="checkbox-card">
      <input type="checkbox" name="jp_hasSponsor" value="Да" ${chkYes("jp_hasSponsor")} />
      <span>Мою поездку спонсирует другой человек</span>
    </label>

    <!-- 19 -->
    <div class="field">
      <label><span class="required-star">*</span>Что из нижеследующего применимо к вам?</label>
      <div class="checkbox-stack" id="jp_applicable_group">
        <label><input type="checkbox" name="jp_appl_crimes" value="Да" ${chkYes("jp_appl_crimes")} /> <span>Совершал/-а преступления или правонарушения в какой-либо стране</span></label>
        <label><input type="checkbox" name="jp_appl_prison" value="Да" ${chkYes("jp_appl_prison")} /> <span>Подвергался/-лась тюремному заключению</span></label>
        <label><input type="checkbox" name="jp_appl_deport" value="Да" ${chkYes("jp_appl_deport")} /> <span>Был/-а депортирована за нарушения визового режима</span></label>
        <label><input type="checkbox" name="jp_appl_drugs" value="Да" ${chkYes("jp_appl_drugs")} /> <span>Подвергался/-лась наказанию за преступления, связанные с запрещенными веществами</span></label>
        <label><input type="checkbox" name="jp_appl_traffic" value="Да" ${chkYes("jp_appl_traffic")} /> <span>Был/-а когда-либо вовлечена в деятельность, связанную с торговлей людьми</span></label>
        <label><input type="checkbox" name="jp_appl_none" value="Да" ${chkYes("jp_appl_none")} /> <span>Ничего из вышеперечисленного</span></label>
      </div>
    </div>

    <!-- 19a — условно: любая из jp_appl_* кроме jp_appl_none -->
    <div class="cond" id="c_jp_applicableExplain">
      <div class="field">
        <label><span class="required-star">*</span>Поясните</label>
        <textarea name="jp_applicableExplain" rows="3">${pv("jp_applicableExplain")}</textarea>
        <span class="hint">Опишите подробнее отмеченные выше пункты</span>
      </div>
    </div>

    <!-- 20 -->
    <!-- Без required: иначе браузер показывает свой tooltip «Select this tickbox».
         Валидация делается ниже в JS (requireChecked), подсветка красным через
         .input-error на .checkbox-card. -->
    <label class="checkbox-card" id="card_jp_confirmAccuracy">
      <input type="checkbox" name="jp_confirmAccuracy" value="Да" ${chkYes("jp_confirmAccuracy")} />
      <span><span class="required-star">*</span>Я подтверждаю правильность и достоверность указанных мной сведений.</span>
    </label>

    <!-- 21 -->
    <label class="checkbox-card" id="card_jp_confirmContract">
      <input type="checkbox" name="jp_confirmContract" value="Да" ${chkYes("jp_confirmContract")} />
      <span><span class="required-star">*</span>Настоящим я соглашаюсь, что данные, внесенные в электронный опросник, являются частью заключенного со мной договора и в случае предоставления недостоверных сведений ответственность за возможные последствия несу лично я.</span>
    </label>

    <!-- 22 -->
    <label class="checkbox-card" id="card_jp_personalDataConsent">
      <input type="checkbox" name="jp_personalDataConsent" value="Да" ${chkYes("jp_personalDataConsent")} />
      <span><span class="required-star">*</span>Согласие на обработку персональных данных</span>
    </label>

    <button id="submitBtn" class="submit-btn" type="submit">Отправить опросник</button>
  </form>
</div>

<script>
  const form = document.getElementById("questionnaireForm");
  const submitBtn = document.getElementById("submitBtn");
  const errorBox = document.getElementById("errorBox");
  const successBox = document.getElementById("successBox");
  const EXISTING_FIOS = ${existingFiosJsonSafe};

  function showBox(el, msg) { el.style.display = "block"; el.textContent = msg || ""; }
  function hideBox(el) { el.style.display = "none"; el.textContent = ""; }

  // ── Маска телефона +7 (XXX) XXX-XX-XX (тот же приём, что у Шенгена) ──
  function formatPhoneRu(rawDigits) {
    let d = String(rawDigits || "").replace(/\\D/g, "");
    if (d.length && d[0] === "8") d = "7" + d.slice(1);
    if (d.length && d[0] !== "7") d = "7" + d;
    d = d.slice(0, 11);
    const a = d.slice(1, 4); const b = d.slice(4, 7); const c = d.slice(7, 9); const e = d.slice(9, 11);
    let out = "+7";
    if (a) out += " (" + a;
    if (a.length === 3) out += ")";
    if (b) out += " " + b;
    if (c) out += "-" + c;
    if (e) out += "-" + e;
    return out;
  }
  function attachPhoneMask(input) {
    const handler = () => { input.value = formatPhoneRu(input.value); };
    input.addEventListener("input", handler);
    input.addEventListener("blur", handler);
    if (input.value) handler();
  }
  form.querySelectorAll('input[data-phone-mask]').forEach(attachPhoneMask);

  // ─── Условные блоки (.cond) ───
  function chk(name) {
    const el = form.querySelector('input[name="' + name + '"][type="checkbox"]');
    return !!(el && el.checked);
  }
  function radio(name) {
    const el = form.querySelector('input[name="' + name + '"]:checked');
    return el ? el.value : null;
  }
  function toggleCond(id, show) {
    const el = document.getElementById(id);
    if (!el) return;
    el.classList.toggle("show", !!show);
    // Поля внутри скрытых блоков не должны блокировать сабмит и оставаться помеченными required.
    const inputs = el.querySelectorAll('input, textarea, select');
    inputs.forEach((inp) => {
      if (show) {
        if (inp.dataset.condRequired === "1") inp.required = true;
      } else {
        if (inp.required) inp.dataset.condRequired = "1";
        inp.required = false;
        inp.classList.remove("input-error");
      }
    });
  }
  // Помечаем поля в условных блоках как «по-умолчанию обязательные» (атрибут data-cond-required)
  // — кроме textarea «Поясните» (jp_applicableExplain), jp_occupationOther и jp_inviterStatus radio,
  // которые становятся обязательными только при показе и устанавливаются в toggleCond.
  // Здесь — упрощенно: ВСЕ input/textarea в .cond становятся required при показе.
  document.querySelectorAll('.cond input[type="text"], .cond input[type="tel"], .cond input[type="email"], .cond textarea').forEach((inp) => {
    inp.dataset.condRequired = "1";
    inp.required = false;
  });

  function updateJapanConditionals() {
    toggleCond("c_jp_otherNames",          chk("jp_hadOtherNames"));
    toggleCond("c_jp_spouseOccupation",    radio("jp_maritalStatus") === "Состою в браке");
    toggleCond("c_jp_secondCitizenship",   chk("jp_hasSecondCitizenship"));
    toggleCond("c_jp_accommodation",       chk("jp_knowsAccommodation"));
    toggleCond("c_jp_japanVisits",         chk("jp_visitedJapanBefore"));
    toggleCond("c_jp_parents",             chk("jp_isUnder18"));
    toggleCond("c_jp_inviter",             chk("jp_hasInvitation"));

    const occ = radio("jp_occupation");
    toggleCond("c_jp_employed",         occ === "Работа по найму");
    toggleCond("c_jp_ip",               occ === "Индивидуальный предприниматель");
    toggleCond("c_jp_selfemployed",     occ === "Самозанятый");
    toggleCond("c_jp_student",          occ === "Учащийся");
    toggleCond("c_jp_unemployed",       occ === "Безработный");
    toggleCond("c_jp_occupationOther",  occ === "Другое");

    // «Поясните» — любая чекбокс кроме jp_appl_none.
    const anyBad = chk("jp_appl_crimes") || chk("jp_appl_prison") || chk("jp_appl_deport")
                 || chk("jp_appl_drugs") || chk("jp_appl_traffic");
    toggleCond("c_jp_applicableExplain", anyBad);
  }
  form.addEventListener("change", updateJapanConditionals);
  updateJapanConditionals();

  // ─── Даты поездки: tripDateFrom ≥ завтра, tripDateTo ≥ tripDateFrom ───
  function pad2(n) { return n < 10 ? "0" + n : String(n); }
  function ymd(date) {
    return date.getFullYear() + "-" + pad2(date.getMonth() + 1) + "-" + pad2(date.getDate());
  }
  (function applyJapanTripDateConstraints() {
    const tripFrom = form.querySelector('input[name="jp_tripDateFrom"]');
    const tripTo = form.querySelector('input[name="jp_tripDateTo"]');
    if (!tripFrom || !tripTo) return;
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const tomorrowStr = ymd(tomorrow);
    tripFrom.min = tomorrowStr;
    if (tripFrom.value && tripFrom.value < tomorrowStr) tripFrom.value = tomorrowStr;
    const fromVal = tripFrom.value || tomorrowStr;
    tripTo.min = fromVal;
    if (tripTo.value && tripTo.value < fromVal) tripTo.value = fromVal;
    tripFrom.addEventListener("change", () => {
      const v = tripFrom.value || tomorrowStr;
      tripTo.min = v;
      if (tripTo.value && tripTo.value < v) tripTo.value = v;
    });
  })();

  // ── Live duplicate-ФИО check ──
  const fioInput = form.querySelector('input[name="fullName"]');
  if (fioInput && EXISTING_FIOS && EXISTING_FIOS.length) {
    const normalize = (s) => String(s || "").trim().toLowerCase().replace(/\\s+/g, " ");
    const knownLowercased = new Set(EXISTING_FIOS.map(normalize));
    fioInput.addEventListener("input", () => {
      const v = normalize(fioInput.value);
      const isDup = knownLowercased.has(v) && v.length > 0;
      fioInput.classList.toggle("input-error", isDup);
      if (isDup) showBox(errorBox, "Опросник на этого заявителя уже заполнен в рамках этой сделки.");
      else hideBox(errorBox);
    });
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    hideBox(errorBox);

    // Проверка дубликата ФИО на сабмите (на случай вставки уже-существующего).
    if (fioInput && EXISTING_FIOS && EXISTING_FIOS.length) {
      const normalize = (s) => String(s || "").trim().toLowerCase().replace(/\\s+/g, " ");
      const knownLowercased = new Set(EXISTING_FIOS.map(normalize));
      if (knownLowercased.has(normalize(fioInput.value))) {
        showBox(errorBox, "Опросник на этого заявителя уже заполнен в рамках этой сделки.");
        fioInput.classList.add("input-error");
        fioInput.scrollIntoView({ behavior: "smooth", block: "center" });
        return;
      }
    }

    // 3 обязательных чек-бокса в конце. Подсвечиваем красным ВСЕ
    // непомеченные сразу, а не только первую — у клиента сразу полная
    // картина что нужно отметить.
    const finalCheckboxes = ["jp_confirmAccuracy", "jp_confirmContract", "jp_personalDataConsent"];
    const missingFinal = [];
    finalCheckboxes.forEach((name) => {
      const el = form.querySelector('input[name="' + name + '"]');
      const card = el && el.closest('.checkbox-card');
      if (el && !el.checked) {
        if (card) card.classList.add("input-error");
        missingFinal.push({ el, card });
      } else if (card) {
        card.classList.remove("input-error");
      }
    });
    if (missingFinal.length) {
      showBox(errorBox, "Отметьте обязательные пункты в конце опросника.");
      const firstCard = missingFinal[0].card;
      if (firstCard && firstCard.scrollIntoView) {
        firstCard.scrollIntoView({ behavior: "smooth", block: "center" });
      }
      return;
    }

    // Снимаем подсветку с финальных чекбоксов при отметке — сразу
    // после клика, без ожидания повторного submit.
    finalCheckboxes.forEach((name) => {
      const el = form.querySelector('input[name="' + name + '"]');
      if (!el || el.dataset._jpFinalBound === "1") return;
      el.dataset._jpFinalBound = "1";
      el.addEventListener("change", () => {
        const card = el.closest('.checkbox-card');
        if (card && el.checked) card.classList.remove("input-error");
      });
    });

    submitBtn.disabled = true;
    submitBtn.textContent = "Отправка...";

    try {
      const formData = new FormData(form);
      const response = await fetch("/api/questionnaire", { method: "POST", body: formData });
      const data = await response.json();
      if (!response.ok || !data.success) throw new Error(data.message || "Не удалось отправить опросник");

      const IS_SHARE_MODE = ${JSON.stringify(isShareMode)};
      if (IS_SHARE_MODE) {
        showBox(successBox, "Спасибо! Опросник отправлен. Можете закрыть страницу.");
        submitBtn.style.display = "none";
        if (successBox.scrollIntoView) successBox.scrollIntoView({ behavior: "smooth", block: "center" });
        return;
      }
      showBox(successBox, "Опросник успешно отправлен");
      try {
        localStorage.setItem("vsc_questionnaire_updated", JSON.stringify({
          phone: "${safePhone}", leadId: "${safeLeadId}", ts: Date.now()
        }));
      } catch (_) {}
      setTimeout(() => {
        if (data.nextApplicantUrl) { window.location.href = data.nextApplicantUrl; return; }
        if (window.opener && !window.opener.closed) { window.close(); return; }
        if (window.history.length > 1) { window.history.back(); return; }
        window.location.href = "/";
      }, 700);
    } catch (error) {
      console.error("QUESTIONNAIRE SUBMIT ERROR (JP):", error);
      showBox(errorBox, error.message || "Ошибка отправки опросника");
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = "Отправить опросник";
    }
  });
</script>
</body>
</html>`;
}

function getPdfFontPath() {
  const candidates = [
    path.join(__dirname, "fonts", "DejaVuSans.ttf"),
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/usr/share/fonts/TTF/DejaVuSans.ttf"
  ];

  for (const fontPath of candidates) {
    if (fs.existsSync(fontPath)) {
      return fontPath;
    }
  }

  return null;
}

async function generateQuestionnairePdfBuffer(data) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 40 });

    const chunks = [];
    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const fontPath = getPdfFontPath();
    if (fontPath) doc.font(fontPath);

    // ── Геометрия таблицы ──
    const MARGIN = 40;
    const TABLE_W = doc.page.width - 2 * MARGIN;
    const Q_W = Math.floor(TABLE_W * 0.55);
    const A_W = TABLE_W - Q_W;
    const PAD_X = 6;
    const PAD_Y = 5;
    const FS_Q = 10;
    const FS_A = 10;
    const FS_SECTION = 12;

    function ensureSpace(needed) {
      const bottom = doc.page.height - MARGIN;
      if (doc.y + needed > bottom) doc.addPage();
    }

    function drawSectionHeader(title) {
      doc.moveDown(0.4);
      const h = FS_SECTION + 8;
      ensureSpace(h + 4);
      const y = doc.y;
      doc.rect(MARGIN, y, TABLE_W, h).fillAndStroke("#3589BD", "#3589BD");
      doc.fillColor("#ffffff").fontSize(FS_SECTION).text(
        title,
        MARGIN + PAD_X,
        y + (h - FS_SECTION) / 2,
        { width: TABLE_W - 2 * PAD_X, lineBreak: false }
      );
      doc.fillColor("#000000");
      doc.y = y + h;
    }

    // Строка-«ячейка» опросника. Левая — вопрос (серый фон), правая — ответ (белый).
    // Если значение пустое — строка не рисуется.
    function drawRow(question, answer) {
      if (answer === undefined || answer === null) return;
      const a = String(answer);
      if (!a.trim()) return;
      const q = String(question || "");

      doc.fontSize(FS_Q);
      const qHeight = doc.heightOfString(q, { width: Q_W - 2 * PAD_X });
      doc.fontSize(FS_A);
      const aHeight = doc.heightOfString(a, { width: A_W - 2 * PAD_X });
      const rowHeight = Math.max(qHeight, aHeight) + 2 * PAD_Y;

      ensureSpace(rowHeight);
      const y = doc.y;

      doc.lineWidth(0.5).strokeColor("#c8ccd4");
      doc.rect(MARGIN, y, Q_W, rowHeight).fillAndStroke("#f3f2f7", "#c8ccd4");
      doc.rect(MARGIN + Q_W, y, A_W, rowHeight).fillAndStroke("#ffffff", "#c8ccd4");

      doc.fillColor("#1d2330").fontSize(FS_Q).text(
        q,
        MARGIN + PAD_X,
        y + PAD_Y,
        { width: Q_W - 2 * PAD_X }
      );
      doc.fillColor("#1d2330").fontSize(FS_A).text(
        a,
        MARGIN + Q_W + PAD_X,
        y + PAD_Y,
        { width: A_W - 2 * PAD_X }
      );

      doc.y = y + rowHeight;
    }

    // ── Шапка ──
    doc.fontSize(18).fillColor("#161d45").text("Опросный лист", { align: "left" });
    doc.fillColor("#1d2330").moveDown(0.3);
    doc.fontSize(11);
    doc.text(`Страна оформления/услуга: ${data.countryService || "не указано"}`);
    doc.text(`Телефон клиента: ${data.phone || ""}`);
    doc.text(`ID сделки: ${data.leadId || ""}`);
    doc.text(`Дата заполнения: ${new Date().toLocaleString("ru-RU")}`);

    // ───────────────────────────────────────────────────────────────
    // Опросник «Виза в Японию» — отдельный набор jp_*-полей. Если
    // тащим Шенгенский шаблон на Японский state, ячейки выходят
    // пустыми (handoff 26.05, known issue). Японская ветка ниже
    // рисует ВСЕ jp_* поля + общие fullName/email/contactPhone/
    // actualAddress.
    // ───────────────────────────────────────────────────────────────
    if (String(data.visaType || "").trim() === "Виза в Японию") {
      drawSectionHeader("Личные данные");
      drawRow("Полное имя (ФИО)", data.fullName);
      drawRow("Ранее были другие фамилии/имена", data.jp_hadOtherNames);
      drawRow("Укажите все предыдущие фамилии/имена", data.jp_otherNames);
      drawRow("Телефон", data.contactPhone);
      drawRow("Почта", data.email);
      drawRow("Семейное положение", data.jp_maritalStatus);
      drawRow("Род занятий супруга/и", data.jp_spouseOccupation);
      drawRow("Есть второе гражданство", data.jp_hasSecondCitizenship);
      drawRow("Какое второе гражданство", data.jp_secondCitizenship);
      drawRow("Паспорт, на который оформляем визу", data.jp_passportForVisa);
      drawRow("Город получения паспорта", data.jp_passportCity);

      drawSectionHeader("Адрес и занятость");
      drawRow("Фактический адрес проживания", data.actualAddress);
      drawRow("Род занятий", data.jp_occupation);
      drawRow("Наименование работодателя", data.jp_employerName);
      drawRow("Адрес работодателя", data.jp_employerAddress);
      drawRow("Телефон работодателя", data.jp_employerPhone);
      drawRow("Должность", data.jp_position);
      drawRow("ИП — название", data.jp_ipName);
      drawRow("ИП — вид деятельности", data.jp_ipActivity);
      drawRow("Самозанятый — вид деятельности", data.jp_selfActivity);
      drawRow("Место учёбы", data.jp_studyPlace);
      drawRow("Адрес учебной организации", data.jp_studyAddress);
      drawRow("Безработный — источник доходов", data.jp_unemployedIncome);
      drawRow('Род занятий "Иное" — пояснение', data.jp_occupationOther);

      drawSectionHeader("Поездка");
      drawRow("Цель поездки", data.jp_tripPurpose);
      if (data.jp_tripDateFrom || data.jp_tripDateTo) {
        drawRow("Даты поездки", `${data.jp_tripDateFrom || "?"} — ${data.jp_tripDateTo || "?"}`);
      }
      drawRow("Города/места поездки", data.jp_citiesToVisit);
      drawRow("Уже известно проживание", data.jp_knowsAccommodation);
      drawRow("Название проживания", data.jp_accommodationName);
      drawRow("Адрес проживания", data.jp_accommodationAddress);
      drawRow("У меня есть свои авиабилеты", data.jp_hasOwnFlights);
      drawRow("Уже был(а) в Японии раньше", data.jp_visitedJapanBefore);
      drawRow("Подробности предыдущих визитов в Японию", data.jp_japanVisits);

      if (data.jp_isUnder18 === "Да" || data.jp_fatherFullName || data.jp_motherFullName) {
        drawSectionHeader("Заявитель младше 18 лет");
        drawRow("Заявитель младше 18 лет", data.jp_isUnder18);
        drawRow("ФИО отца", data.jp_fatherFullName);
        drawRow("ФИО матери", data.jp_motherFullName);
      }

      drawSectionHeader("Приглашение и спонсор");
      drawRow("Есть приглашение в Японию", data.jp_hasInvitation);
      drawRow("ФИО приглашающего", data.jp_inviterName);
      drawRow("Адрес приглашающего", data.jp_inviterAddress);
      drawRow("Степень родства/отношений с приглашающим", data.jp_inviterRelation);
      drawRow("Статус приглашающего", data.jp_inviterStatus);
      drawRow("Мою поездку спонсирует другой человек/компания", data.jp_hasSponsor);

      drawSectionHeader("Применимые обстоятельства");
      drawRow("Совершал(а) преступления/правонарушения", data.jp_appl_crimes);
      drawRow("Подвергался(лась) тюремному заключению", data.jp_appl_prison);
      drawRow("Был(а) депортирован(а) за нарушение визового режима", data.jp_appl_deport);
      drawRow("Привлекался(лась) за преступления, связанные с запрещ. веществами", data.jp_appl_drugs);
      drawRow("Был(а) вовлечён(а) в торговлю людьми", data.jp_appl_traffic);
      drawRow("Ничего из вышеперечисленного", data.jp_appl_none);
      drawRow("Пояснение к применимым обстоятельствам", data.jp_applicableExplain);

      drawSectionHeader("Подтверждения");
      drawRow("Подтверждаю правильность и достоверность сведений", data.jp_confirmAccuracy);
      drawRow("Согласие с условиями договора по электронному опроснику", data.jp_confirmContract);
      drawRow("Согласие на обработку персональных данных", data.jp_personalDataConsent);

      doc.end();
      return;
    }

    // ── Личные данные ──
    drawSectionHeader("Личные данные");
    drawRow("Полное имя (ФИО)", data.fullName);
    drawRow("У меня ранее были предыдущие фамилии", data.hadPrevSurnames);
    drawRow("Укажите все предыдущие фамилии", data.prevSurnames);
    drawRow("Телефон", data.contactPhone);
    drawRow("Почта", data.email);
    drawRow("Семейное положение", data.maritalStatus);
    drawRow("При рождении у меня было иное гражданство", data.hadOtherCitizenshipAtBirth);
    drawRow("Ваше гражданство при рождении", data.birthCitizenship);
    drawRow("У меня в данный момент есть второе гражданство", data.hasSecondCitizenship);
    drawRow("Укажите второе гражданство", data.secondCitizenship);
    drawRow("У меня есть второй заграничный паспорт", data.hasSecondPassport);
    drawRow("На какой паспорт мы оформляем все документы", data.whichPassport);
    drawRow("Можете ли вы сдать второй паспорт в ВЦ на период рассмотрения", data.canSurrenderPassport);
    drawRow("Укажите, по какой причине не сдаете паспорт", data.surrenderReason);

    // ── Адрес и занятость ──
    drawSectionHeader("Адрес и занятость");
    drawRow("Фактический адрес проживания", data.actualAddress);
    drawRow("Род занятий (занимаемая должность)", data.occupation);
    drawRow("Наименование работодателя/учебной организации", data.employerName);
    drawRow("Адрес работодателя/учебной организации", data.employerAddress);
    drawRow("Телефон работодателя", data.employerPhone);

    // ── Поездка ──
    drawSectionHeader("Поездка");
    drawRow("Цель поездки", data.tripPurpose);
    drawRow('Подробности цели "Иное"', data.tripPurposeOther);
    drawRow("Виза для собеседования на США в Польше", data.usaInterviewPoland);
    drawRow("Страна поездки", data.travelCountry);
    if (data.biometricAck === "Да") {
      drawRow("Уведомлён: для въезда нужен биометрический (10-летний) загранпаспорт", "Да");
    }
    if (data.biometricAckFr === "Да") {
      drawRow("Уведомлён: биометрический загранпаспорт (Франция, граждане РФ старше 14 лет)", "Да");
    }
    drawRow("В какую страну запрашивается виза", data.visaCountry);
    if (data.tripDatesUnknown === "Да") {
      drawRow("Даты поездки", "Точные даты пока не известны");
      if (data.tripDatesAck === "Да") {
        drawRow(
          "Подтверждение клиента",
          "проинформирован о сроках рассмотрения; обязуется предоставить даты минимум за неделю до подачи в Консульство; в курсе о возможной доплате при изменении дат после подготовки пакета"
        );
      }
    } else if (data.tripDateFrom || data.tripDateTo) {
      drawRow("Даты поездки", `${data.tripDateFrom || "?"} — ${data.tripDateTo || "?"}`);
    }

    // ── История виз ──
    drawSectionHeader("История виз");
    drawRow("Есть действующая шенгенская виза", data.hasActiveSchengen);
    drawRow("Дата окончания текущей визы", data.schengenExpiry);
    drawRow("Были Шенгенские визы за последние 3 года", data.hadSchengen3Years);
    drawRow("Не открыл/-а последнюю шенгенскую визу", data.didNotUseVisa);
    drawRow("Причина, почему виза не была отъезжена", data.didNotUseReason);
    drawRow("Открыл/-а визу не той страной, которая её выдала", data.visaRefused);
    drawRow("Укажите причину", data.refusalReason);
    drawRow("Посещал Шенгенскую зону после 10.04.2026", data.visitedSchengenAfterApr2026);
    drawRow("Ставили штампы о пересечении границы в загранпаспорт", data.hadBorderStamps);

    // ── Документы и услуги ──
    drawSectionHeader("Документы и услуги");
    drawRow("Есть действительная страховка для въезда в Шенгенскую зону", data.hasInsurance);
    if (data.hasInsurance === "Нет") {
      drawRow("Хочу приобрести страховку для оформления визы у вас", data.wantBuyInsurance);
    }
    drawRow("На момент подачи документов младше 18 лет", data.isUnder18);
    drawRow("ФИО законного представителя", data.legalRepresentative);
    drawRow("Поездку спонсирует третье лицо/компания", data.hasSponsor);
    drawRow("ФИО/наименование спонсора", data.sponsorName);
    drawRow("Тип подачи", data.visitType);
    drawRow("Способ получения готовых документов", data.pickupMethod);
    drawRow("Есть документы на льготную оплату консульского сбора", data.hasConsularFeeDoc);

    // ── Запись ботом ──
    drawSectionHeader("Запись ботом");
    drawRow("Хочу воспользоваться услугой записи ботом", data.useBotBooking);
    if (data.bookingDateFrom || data.bookingDateTo) {
      drawRow("Диапазон записи", `${data.bookingDateFrom || "?"} — ${data.bookingDateTo || "?"}`);
    }
    const botExtraRanges = [];
    if (data.bookingDateFrom2 || data.bookingDateTo2) botExtraRanges.push(`${data.bookingDateFrom2 || "?"} — ${data.bookingDateTo2 || "?"}`);
    if (data.bookingDateFrom3 || data.bookingDateTo3) botExtraRanges.push(`${data.bookingDateFrom3 || "?"} — ${data.bookingDateTo3 || "?"}`);
    botExtraRanges.forEach((r, i) => drawRow("Диапазон записи " + (i + 2), r));
    if (data.bookingExclusions) drawRow("Исключения", data.bookingExclusions);
    drawRow("Город для записи", data.bookingCity);
    drawRow("Пожелания по датам записи", data.bookingTimePrefs);
    drawRow("Дополнительные услуги в ВЦ (бизнес-залы/ускоренные)", data.bookingLoungePrefs);

    // ── Прочее ──
    drawSectionHeader("Прочее");
    drawRow("Откуда узнали о нас", data.howFoundUs);
    drawRow("Примечания", data.notes);
    drawRow("Подтверждаю правильность и достоверность сведений", data.confirmAccuracy);
    drawRow("Согласие с условиями договора по электронному опроснику", data.confirmPrevData);
    drawRow("Согласие на обработку персональных данных", data.personalDataConsent);

    doc.end();
  });
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

    // Триггер «обратная связь по ЛК»: одна SMS на номер за всё время, после того
    // как сделка перешла на этап «Подготовка документов». Не блокируем ответ —
    // если что-то пойдёт не так, кабинет всё равно покажется.
    maybeSendFeedbackSms(phone, leads).catch((e) => {
      console.error("FEEDBACK trigger error:", e && e.message);
    });

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

const VISA_TYPES = [
  "Шенгенская виза",
  "Виза в Японию",
  "Виза в США",
  "Виза в Великобританию",
  "Виза в Австралию",
  "Виза в Новую Зеландию",
  "Виза в Южную Корею (K-ETA)",
  "Виза в Саудовскую Аравию",
  "Виза в Индию",
  "Виза в Израиль (ETA)",
  "Виза в Азербайджан",
  "Виза в Россию (E-Visa)",
  "Виза в Северную Македонию",
  "Виза в Египет",
  "Виза в Мексику",
  "Виза во Вьетнам",
  "Виза на Сейшельские острова",
  "Виза в Уганду",
  "Виза на Шри-Ланку",
  "Виза в Бахрейн",
  "Виза в Эфиопию",
  "Виза в Кению"
];

function buildQuestionnaireStartHtml({ phone, leadId }) {
  const safePhone = escapeHtml(phone || "");
  const safeLeadId = escapeHtml(String(leadId || ""));
  const visaOptionsHtml = VISA_TYPES.map((v) => {
    const safe = escapeHtml(v);
    return `<option value="${safe}">${safe}</option>`;
  }).join("\n");

  return `<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Опросный лист — начало</title>
  <style>
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif;
      background: #f3f2f7;
      color: #1d2330;
      padding: 24px;
    }
    .wrap {
      max-width: 760px;
      margin: 0 auto;
      background: #fff;
      border: 1px solid #ece7f2;
      border-radius: 24px;
      padding: 24px;
      box-shadow: 0 10px 30px rgba(34, 36, 52, 0.05);
    }
    h1 { margin: 0 0 8px; font-size: 28px; line-height: 1.15; color: #171c29; }
    .subtitle { margin: 0 0 22px; font-size: 14px; color: #737988; line-height: 1.5; }
    form { display: grid; gap: 14px; }
    .field { display: grid; gap: 6px; }
    .field > label { font-size: 14px; font-weight: 600; color: #3a4150; }
    .field select {
      width: 100%;
      height: 50px;
      border: 1px solid #e8e2ee;
      border-radius: 14px;
      padding: 0 14px;
      font-size: 16px;
      outline: none;
      background: #fff;
      color: #1f2532;
      font-family: inherit;
      appearance: none;
      background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='8' viewBox='0 0 12 8'%3E%3Cpath d='M1 1l5 5 5-5' stroke='%239096a3' stroke-width='1.5' fill='none' stroke-linecap='round'/%3E%3C/svg%3E");
      background-repeat: no-repeat;
      background-position: right 14px center;
      padding-right: 36px;
    }
    .cond { display: none; }
    .cond.show { display: grid; gap: 14px; }
    .info-box {
      padding: 14px 16px;
      border-radius: 14px;
      background: #f0f7fc;
      border: 1px solid #d3e7f4;
      color: #2f6e95;
      font-size: 14px;
      line-height: 1.5;
    }
    .submit-btn {
      height: 50px;
      border: none;
      border-radius: 14px;
      background: #3589BD;
      color: #fff;
      font-size: 16px;
      font-weight: 600;
      cursor: pointer;
      margin-top: 8px;
    }
    .submit-btn:disabled { opacity: 0.55; cursor: not-allowed; }
    .radio-group { display: flex; gap: 10px; flex-wrap: wrap; }
    .radio-group label {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 14px;
      color: #1d2330;
      cursor: pointer;
      padding: 10px 16px;
      border: 1px solid #e8e2ee;
      border-radius: 12px;
      background: #fff;
      flex: 1 1 220px;
    }
    .radio-group input[type="radio"] { accent-color: #4f9f68; width: 16px; height: 16px; }
    .radio-group label:has(input:checked) { border-color: #4f9f68; background: #f0faf3; }
    #smsRows { display: grid; gap: 10px; }
    .sms-row {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      align-items: center;
    }
    .sms-row input[type="tel"] {
      flex: 1 1 200px;
      height: 44px;
      border: 1px solid #e8e2ee;
      border-radius: 12px;
      padding: 0 14px;
      font-size: 15px;
      outline: none;
      background: #fff;
      color: #1f2532;
      font-family: inherit;
      transition: border-color 0.2s ease, box-shadow 0.2s ease;
    }
    .sms-row input[type="tel"]:focus {
      border-color: #3589BD;
      box-shadow: 0 0 0 3px rgba(53, 137, 189, 0.12);
    }
    .sms-send-btn {
      flex: 0 0 auto;
      height: 44px;
      padding: 0 16px;
      border: 1.5px solid #3589BD;
      border-radius: 12px;
      background: #fff;
      color: #3589BD;
      font-size: 13px;
      font-weight: 600;
      cursor: pointer;
      white-space: nowrap;
      transition: background 0.2s ease, color 0.2s ease, border-color 0.2s ease, opacity 0.2s ease;
    }
    .sms-send-btn:hover:not(:disabled) { background: #f0f7fc; }
    .sms-send-btn:disabled { opacity: 0.55; cursor: not-allowed; }
    .sms-row.is-sent input[type="tel"] {
      background: #f6fbf8;
      border-color: #cfe7d2;
      color: #2e7a43;
    }
    .sms-row.is-sent .sms-send-btn {
      background: #f0faf3;
      border-color: #4f9f68;
      color: #4f9f68;
      cursor: default;
    }
    .sms-remove-btn {
      flex: 0 0 auto;
      width: 40px;
      height: 44px;
      padding: 0;
      border: 1px solid #e8e2ee;
      border-radius: 12px;
      background: #fff;
      color: #9096a3;
      font-size: 22px;
      line-height: 1;
      cursor: pointer;
      font-weight: 600;
      display: none;
      align-items: center;
      justify-content: center;
      transition: border-color 0.15s ease, color 0.15s ease, background 0.15s ease;
    }
    .sms-row.has-remove .sms-remove-btn { display: inline-flex; }
    .sms-remove-btn:hover {
      border-color: #d97a8a;
      color: #a15561;
      background: #fbebee;
    }
    .sms-add-btn {
      background: transparent;
      border: none;
      color: #3589BD;
      font-size: 14px;
      font-weight: 600;
      padding: 6px 0;
      margin-top: 4px;
      cursor: pointer;
      text-align: left;
      display: inline-block;
    }
    .sms-add-btn:disabled { opacity: 0.45; cursor: not-allowed; }
    .sms-msg {
      flex-basis: 100%;
      font-size: 13px;
      line-height: 1.4;
    }
    .sms-msg.error { color: #a15561; }
    .sms-msg.success { color: #2e7a43; }
    .sms-hint { font-size: 12px; color: #9096a3; line-height: 1.4; }
  </style>
</head>
<body>
<div class="wrap">
  <h1>Опросный лист</h1>
  <p class="subtitle">Выберите визу/услугу, на которую заполняем опросный лист.</p>

  <form id="startForm">
    <div class="field">
      <label>На какую визу/услугу заполняем опросник? *</label>
      <select name="visaType" id="visaType" required>
        <option value="" disabled selected>Выберите визу/услугу</option>
${visaOptionsHtml}
      </select>
    </div>

    <div class="cond" id="c_count">
      <div class="field">
        <label>На какое количество человек заполняем опросные листы? *</label>
        <select name="applicantCount" id="applicantCount">
          <option value="" disabled selected>Выберите количество</option>
          <option value="1">1</option>
          <option value="2">2</option>
          <option value="3">3</option>
          <option value="4">4</option>
          <option value="5">5</option>
          <option value="6">6</option>
          <option value="7">7</option>
          <option value="8">8</option>
          <option value="9">9</option>
          <option value="10">10</option>
        </select>
      </div>
    </div>

    <div class="cond" id="c_mode">
      <div class="field">
        <label>Вы будете заполнять опросники за всех заявителей, или хотите, чтобы кому-то из заявителей ушло SMS со ссылкой на заполнение опросника?</label>
        <div class="radio-group" id="modeGroup">
          <label><input type="radio" name="fillMode" value="self" /> Я заполню за всех</label>
          <label><input type="radio" name="fillMode" value="sms" /> Некоторым нужно отправить SMS со ссылкой на заполнение опросника</label>
        </div>
      </div>
      <div class="cond" id="c_smsBlock">
        <div class="field">
          <label>Отправьте SMS со ссылкой на заполнение опросника</label>
          <div id="smsRows"></div>
          <button type="button" class="sms-add-btn" id="smsAddBtn">+ Добавить поле</button>
          <p class="sms-hint" id="smsHint"></p>
        </div>
      </div>
    </div>

    <div class="cond" id="c_underdev">
      <div class="info-box">Раздел в разработке</div>
    </div>

    <button type="submit" class="submit-btn" id="continueBtn" disabled>Продолжить</button>
  </form>
</div>

<script>
  const PHONE = ${JSON.stringify(safePhone)};
  const LEAD_ID = ${JSON.stringify(safeLeadId)};

  const visaSelect = document.getElementById("visaType");
  const countSelect = document.getElementById("applicantCount");
  const countCond = document.getElementById("c_count");
  const modeCond = document.getElementById("c_mode");
  const smsBlockCond = document.getElementById("c_smsBlock");
  const underdevCond = document.getElementById("c_underdev");
  const continueBtn = document.getElementById("continueBtn");
  const smsRows = document.getElementById("smsRows");
  const smsAddBtn = document.getElementById("smsAddBtn");
  const smsHint = document.getElementById("smsHint");

  // sentSms: набор номеров (нормализованных), на которые уже отправили SMS
  const sentSms = new Set();

  function applicantCountVal() {
    return parseInt(countSelect.value, 10) || 0;
  }

  function fillModeVal() {
    const el = document.querySelector('input[name="fillMode"]:checked');
    return el ? el.value : null;
  }

  function normalizePhoneJs(raw) {
    const digits = String(raw || "").replace(/\\D/g, "");
    if (!digits) return "";
    if (digits.length === 11 && digits.startsWith("8")) return "7" + digits.slice(1);
    if (digits.length === 10) return "7" + digits;
    return digits;
  }

  function update() {
    const v = visaSelect.value;
    // Поддерживаемые опросники в ЛК: Шенген + Япония. Для остальных
    // показываем «Раздел в разработке» — как раньше.
    const isSupported = v === "Шенгенская виза" || v === "Виза в Японию";
    countCond.classList.toggle("show", isSupported);
    underdevCond.classList.toggle("show", !!v && !isSupported);

    const countVal = applicantCountVal();
    const showMode = isSupported && countVal > 1;
    modeCond.classList.toggle("show", showMode);
    if (!showMode) {
      // сбрасываем выбор режима, чтобы случайный «sms» не залип после смены количества
      const checked = document.querySelector('input[name="fillMode"]:checked');
      if (checked) checked.checked = false;
    }
    const isSmsMode = showMode && fillModeVal() === "sms";
    smsBlockCond.classList.toggle("show", isSmsMode);

    if (isSmsMode && smsRows.children.length === 0) addSmsRow();
    refreshSmsAddState();

    // Кнопка «Продолжить» доступна для:
    // — шенген + count >= 1 (один заявитель — без вопроса о режиме)
    // — count > 1 + выбран режим (любой)
    let canContinue = false;
    if (isSupported && countVal > 0) {
      if (countVal === 1) canContinue = true;
      else if (fillModeVal()) canContinue = true;
    }
    continueBtn.disabled = !canContinue;

    // Текст кнопки: если все опросники уже разосланы SMS — «Готово»
    if (isSmsMode && sentSms.size >= countVal) {
      continueBtn.textContent = "Готово";
    } else {
      continueBtn.textContent = "Продолжить";
    }
  }

  function addSmsRow() {
    const countVal = applicantCountVal();
    if (smsRows.children.length >= countVal) return;
    const row = document.createElement("div");
    row.className = "sms-row";
    row.innerHTML = ''
      + '<input type="tel" placeholder="+7 999 123-45-67" autocomplete="off" inputmode="tel" />'
      + '<button type="button" class="sms-send-btn">Отправить SMS с опросником</button>'
      + '<button type="button" class="sms-remove-btn" aria-label="Убрать поле" title="Убрать поле">−</button>'
      + '<div class="sms-msg" style="display:none;"></div>';
    smsRows.appendChild(row);
    const input = row.querySelector('input[type="tel"]');
    const sendBtn = row.querySelector('.sms-send-btn');
    const removeBtn = row.querySelector('.sms-remove-btn');
    const msg = row.querySelector('.sms-msg');
    sendBtn.addEventListener("click", () => sendSms(row, input, sendBtn, msg));
    removeBtn.addEventListener("click", () => removeSmsRow(row));
    refreshRowsLayout();
    refreshSmsAddState();
  }

  function removeSmsRow(row) {
    // Если эта строка уже отправляла SMS — снимаем из набора
    if (row.classList.contains("is-sent")) {
      const input = row.querySelector('input[type="tel"]');
      const norm = input ? normalizePhoneJs(input.value.trim()) : "";
      if (norm) sentSms.delete(norm);
    }
    if (row.parentNode) row.parentNode.removeChild(row);
    refreshRowsLayout();
    refreshSmsAddState();
    update();
  }

  function refreshRowsLayout() {
    // Кнопка "−" отображается на каждой строке, кроме первой
    const rows = Array.from(smsRows.children);
    rows.forEach((row, idx) => {
      row.classList.toggle("has-remove", idx > 0);
    });
  }

  function refreshSmsAddState() {
    const countVal = applicantCountVal();
    const rows = smsRows.children.length;
    smsAddBtn.disabled = rows >= countVal;
    smsHint.textContent = countVal > 0
      ? "Добавлено полей: " + rows + " из " + countVal + " (по количеству заявителей)"
      : "";
  }

  async function sendSms(row, input, btn, msg) {
    msg.style.display = "none";
    msg.className = "sms-msg";
    const raw = input.value.trim();
    const norm = normalizePhoneJs(raw);
    if (!norm || norm.length < 11) {
      msg.style.display = "block";
      msg.className = "sms-msg error";
      msg.textContent = "Введите корректный номер телефона";
      return;
    }
    if (sentSms.has(norm)) {
      msg.style.display = "block";
      msg.className = "sms-msg error";
      msg.textContent = "На этот номер уже отправлено SMS";
      return;
    }
    btn.disabled = true;
    const prevText = btn.textContent;
    btn.textContent = "Отправка...";
    try {
      const r = await fetch("/api/questionnaire/share", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          phone: PHONE,
          leadId: LEAD_ID,
          applicantCount: applicantCountVal(),
          visaType: visaSelect.value,
          recipientPhone: norm
        })
      });
      const data = await r.json();
      if (!r.ok || !data.success) {
        throw new Error(data.message || "Не удалось отправить SMS");
      }
      sentSms.add(norm);
      input.value = norm;
      input.readOnly = true;
      row.classList.add("is-sent");
      btn.textContent = data.testMode ? "Отправлено (тестовый режим)" : "SMS отправлено";
      msg.style.display = "block";
      msg.className = "sms-msg success";
      msg.textContent = data.testMode
        ? "Тестовый режим SMS.ru — реальное сообщение не отправлено, но логика работает."
        : "Ссылка отправлена.";
      update();
    } catch (err) {
      btn.disabled = false;
      btn.textContent = prevText;
      msg.style.display = "block";
      msg.className = "sms-msg error";
      msg.textContent = err.message || "Ошибка отправки";
    }
  }

  smsAddBtn.addEventListener("click", addSmsRow);
  visaSelect.addEventListener("change", update);
  countSelect.addEventListener("change", () => {
    // Если количество уменьшили — удаляем лишние SMS-строки (только не отправленные)
    const target = applicantCountVal();
    while (smsRows.children.length > target) {
      const last = smsRows.lastElementChild;
      if (last && !last.classList.contains("is-sent")) {
        smsRows.removeChild(last);
      } else {
        break;
      }
    }
    update();
  });
  document.addEventListener("change", (e) => {
    if (e.target && e.target.name === "fillMode") update();
  });
  update();

  document.getElementById("startForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const v = visaSelect.value;
    // Поддерживаемые опросники в ЛК — Шенген и Япония.
    if (v !== "Шенгенская виза" && v !== "Виза в Японию") return;
    const count = applicantCountVal();
    if (count < 1) return;

    const sent = sentSms.size;
    const isMixed = count > 1 && fillModeVal() === "sms" && sent > 0;
    const selfFillCount = isMixed ? Math.max(0, count - sent) : count;

    // Если все опросники разосланы по SMS — возвращаемся в кабинет
    if (isMixed && selfFillCount === 0) {
      window.location.href = "/cabinet?phone=" + encodeURIComponent(PHONE);
      return;
    }

    const params = new URLSearchParams({
      phone: PHONE,
      leadId: LEAD_ID,
      applicantCount: String(count),
      visaType: v
    });
    if (isMixed) {
      params.set("mixed", "1");
      params.set("selfFillCount", String(selfFillCount));
      params.set("selfStep", "1");
    }
    window.location.href = "/questionnaire?" + params.toString();
  });
</script>
</body>
</html>`;
}

// ──────────────────────────────────────────────────────────
// Share-токены опросника (SMS-ссылки на заполнение)
// ──────────────────────────────────────────────────────────
const SHARE_TOKENS_FILE = path.join(__dirname, ".shareTokens.json");
const SHARE_TOKEN_TTL_MS = 14 * 24 * 60 * 60 * 1000; // 14 дней
const shareTokens = new Map();

function loadShareTokens() {
  try {
    const raw = fs.readFileSync(SHARE_TOKENS_FILE, "utf8");
    const arr = JSON.parse(raw);
    if (Array.isArray(arr)) {
      const now = Date.now();
      arr.forEach((item) => {
        if (item && item.token && item.createdAt && now - item.createdAt < SHARE_TOKEN_TTL_MS) {
          shareTokens.set(item.token, item);
        }
      });
    }
  } catch (_) {}
}

function saveShareTokens() {
  try {
    const arr = Array.from(shareTokens.values());
    fs.writeFileSync(SHARE_TOKENS_FILE, JSON.stringify(arr, null, 2), "utf8");
  } catch (e) {
    console.error("saveShareTokens error:", e.message);
  }
}

function purgeOldShareTokens() {
  const now = Date.now();
  let changed = false;
  for (const [token, data] of shareTokens.entries()) {
    if (now - data.createdAt >= SHARE_TOKEN_TTL_MS) {
      shareTokens.delete(token);
      changed = true;
    }
  }
  if (changed) saveShareTokens();
}

function createShareToken({ phone, leadId, applicantCount, visaType }) {
  const token = crypto.randomBytes(24).toString("hex");
  const data = {
    token,
    phone,
    leadId,
    applicantCount: Math.max(1, parseInt(applicantCount, 10) || 1),
    visaType: visaType || "",
    createdAt: Date.now()
  };
  shareTokens.set(token, data);
  saveShareTokens();
  return token;
}

function getShareToken(token) {
  purgeOldShareTokens();
  if (!token || typeof token !== "string") return null;
  return shareTokens.get(token) || null;
}

// Список заполненных ФИО заявителей в рамках конкретной сделки.
// Используется для блокировки дубликатов ФИО в опроснике этой сделки.
async function getExistingApplicantFios(phone, leadId) {
  if (!phone || !YANDEX_DISK_TOKEN) return [];
  try {
    const files = await listAllTechFiles(phone, leadId);
    const indexes = new Set();
    files.forEach((name) => {
      const m = /^Опросник(?:\s+(\d+))?\.json$/i.exec(name);
      if (m) indexes.add(parseInt(m[1] || "1", 10));
    });
    const out = [];
    for (const idx of indexes) {
      try {
        const state = await loadApplicantJson(phone, leadId, idx);
        if (state && state.fullName) {
          out.push({ idx, fullName: String(state.fullName).trim() });
        }
      } catch (_) {}
    }
    return out;
  } catch (e) {
    console.error("getExistingApplicantFios error:", e.message);
    return [];
  }
}

function normalizeFioForCompare(s) {
  return String(s || "").trim().replace(/\s+/g, " ").toLowerCase();
}

// ── Pre-applicants: клиенты, которые загрузили 2 паспорта на этапе
// «Начало оформления» ДО заполнения опросника. Храним список ФИО в
// TECH FOLDER/_preApplicants.json. Файлы уже лежат в обычной папке
// заявителя <phone>/<leadId>/<safeFio>, так что после сохранения
// опросника на это же ФИО мы просто удаляем запись из pre-applicants
// (мерж происходит автоматически — нормальный applicant видит файлы
// в своей папке).
const PRE_APPLICANTS_FILE = "_preApplicants.json";

function preApplicantsFilePath(phone, leadId) {
  return `${techFolderPath(phone, leadId)}/${PRE_APPLICANTS_FILE}`;
}

async function loadPreApplicants(phone, leadId) {
  if (!phone || !leadId || !YANDEX_DISK_TOKEN) return [];
  try {
    const data = await downloadJsonFromYandexDisk(preApplicantsFilePath(phone, leadId));
    if (!data) return [];
    const items = Array.isArray(data.items) ? data.items : [];
    return items
      .map((it) => ({
        fullName: String(it && it.fullName || "").trim(),
        createdAt: String(it && it.createdAt || "")
      }))
      .filter((it) => it.fullName);
  } catch (e) {
    return [];
  }
}

async function savePreApplicants(phone, leadId, items) {
  if (!phone || !leadId || !YANDEX_DISK_TOKEN) return;
  const body = JSON.stringify({ items: items || [] }, null, 2);
  const buffer = Buffer.from(body, "utf-8");
  await ensureNestedYandexFolder(techFolderPath(phone, leadId));
  await uploadBufferToYandexDisk(buffer, preApplicantsFilePath(phone, leadId), "application/json; charset=utf-8");
}

// Добавляет pre-applicant, если такого ФИО ещё нет. Идемпотентно.
async function addPreApplicantFio(phone, leadId, fullName) {
  const fio = String(fullName || "").trim();
  if (!fio) return null;
  const list = await loadPreApplicants(phone, leadId);
  const norm = normalizeFioForCompare(fio);
  const existing = list.find((it) => normalizeFioForCompare(it.fullName) === norm);
  if (existing) return existing;
  const item = { fullName: fio, createdAt: new Date().toISOString() };
  list.push(item);
  await savePreApplicants(phone, leadId, list);
  return item;
}

// Удаляет pre-applicant по ФИО (для мерж при сохранении опросника).
async function removePreApplicantByFio(phone, leadId, fullName) {
  const norm = normalizeFioForCompare(fullName);
  if (!norm) return;
  const list = await loadPreApplicants(phone, leadId);
  const next = list.filter((it) => normalizeFioForCompare(it.fullName) !== norm);
  if (next.length !== list.length) {
    await savePreApplicants(phone, leadId, next);
  }
}

// Следующий свободный applicantIndex для НОВОГО опросника в рамках конкретной сделки.
async function getNextApplicantIndex(phone, leadId) {
  try {
    const files = await listAllTechFiles(phone, leadId);
    const used = new Set();
    files.forEach((name) => {
      const m = /^Опросник(?:\s+(\d+))?\.json$/i.exec(name);
      if (m) used.add(parseInt(m[1] || "1", 10));
    });
    let idx = 1;
    while (used.has(idx)) idx++;
    return idx;
  } catch (e) {
    console.error("getNextApplicantIndex error:", e.message);
    return 1;
  }
}

loadShareTokens();

// ──────────────────────────────────────────────────────────
// Feedback (обратная связь по ЛК): SMS-ссылка после перехода
// сделки в «Подготовка документов» + страница опроса + PDF на Я.Диск.
// Одному номеру шлём максимум ОДИН раз за всё время.
// ──────────────────────────────────────────────────────────

const FEEDBACK_DISK_FOLDER = "Опросники по ЛК VOYO";

// ФИО с большой буквы — тот же приём, что и formatFio в cabinet.html
// (lowercase всё → capitalize первую букву каждого «слова», разделители \s и -).
function formatFioTitleCase(s) {
  const lower = String(s || "").trim().toLowerCase();
  if (!lower) return "";
  return lower.replace(/(^|[\s-])(\p{L})/gu, (_, sep, ch) => sep + ch.toUpperCase());
}

// Опции 3-го вопроса (показывается, если на Q1 ответили «Да»).
// Тексты используются и как value на чекбоксах, и как метка в PDF —
// чтобы не дублировать справочник в двух местах.
const FEEDBACK_Q3_OPTIONS = [
  "eSIM (быстрое подключение зарубежной eSIM в поездке для использования мобильного интернета)",
  "Оформление туристической страховки (включая страхование от экстремальных видов спорта, и прочие нестандартные виды страхования)",
  "Поиск отеля (аналог booking / ostrovok)",
  "Поиск экскурсий в городах назначения",
  "Поиск авторских туров",
  "Раздел для организации деловых поездок"
];

const FEEDBACK_SENT_FILE = path.join(__dirname, ".feedbackSent.json");
const FEEDBACK_TOKENS_FILE = path.join(__dirname, ".feedbackTokens.json");
const feedbackSent = new Map();    // phone(7XXXXXXXXXX) -> { sentAt, fullName }
const feedbackTokens = new Map();  // token -> { token, phone, fullName, createdAt, submittedAt? }

function loadFeedbackSent() {
  try {
    const raw = fs.readFileSync(FEEDBACK_SENT_FILE, "utf8");
    const obj = JSON.parse(raw);
    if (obj && typeof obj === "object") {
      Object.entries(obj).forEach(([phone, data]) => {
        if (data && typeof data === "object") {
          feedbackSent.set(phone, data);
        } else if (data) {
          feedbackSent.set(phone, { sentAt: Number(data) || Date.now(), fullName: "" });
        }
      });
    }
  } catch (_) {}
}

function saveFeedbackSent() {
  try {
    const obj = Object.fromEntries(feedbackSent.entries());
    fs.writeFileSync(FEEDBACK_SENT_FILE, JSON.stringify(obj, null, 2), "utf8");
  } catch (e) {
    console.error("saveFeedbackSent error:", e.message);
  }
}

function loadFeedbackTokens() {
  try {
    const raw = fs.readFileSync(FEEDBACK_TOKENS_FILE, "utf8");
    const arr = JSON.parse(raw);
    if (Array.isArray(arr)) {
      arr.forEach((item) => {
        if (item && item.token) feedbackTokens.set(item.token, item);
      });
    }
  } catch (_) {}
}

function saveFeedbackTokens() {
  try {
    const arr = Array.from(feedbackTokens.values());
    fs.writeFileSync(FEEDBACK_TOKENS_FILE, JSON.stringify(arr, null, 2), "utf8");
  } catch (e) {
    console.error("saveFeedbackTokens error:", e.message);
  }
}

function wasFeedbackSent(phone) {
  return feedbackSent.has(phone);
}

// ── Воронка опросников: учёт переходов по ссылке и отправок ──
// SMS → клик по ссылке → отправка формы. Один номер учитывается один раз
// на каждом этапе (как с lkAuthPhones).
const FEEDBACK_CLICKED_FILE = path.join(__dirname, ".feedbackClicked.json");
const FEEDBACK_SUBMITTED_FILE = path.join(__dirname, ".feedbackSubmitted.json");
const feedbackClicked = new Map();   // phone -> { clickedAt }
const feedbackSubmitted = new Map(); // phone -> { submittedAt, fullName, pdfFileName }

function loadFeedbackClicked() {
  try {
    const raw = fs.readFileSync(FEEDBACK_CLICKED_FILE, "utf8");
    const obj = JSON.parse(raw);
    if (obj && typeof obj === "object") {
      Object.entries(obj).forEach(([phone, data]) => {
        if (data && typeof data === "object") feedbackClicked.set(phone, data);
      });
    }
  } catch (_) {}
}
function saveFeedbackClicked() {
  try {
    fs.writeFileSync(FEEDBACK_CLICKED_FILE, JSON.stringify(Object.fromEntries(feedbackClicked.entries()), null, 2), "utf8");
  } catch (e) {
    console.error("saveFeedbackClicked error:", e.message);
  }
}
function recordFeedbackClick(phone) {
  const norm = normalizePhone(phone || "");
  if (!norm) return;
  if (feedbackClicked.has(norm)) return;
  feedbackClicked.set(norm, { clickedAt: Date.now() });
  saveFeedbackClicked();
}

function loadFeedbackSubmitted() {
  try {
    const raw = fs.readFileSync(FEEDBACK_SUBMITTED_FILE, "utf8");
    const obj = JSON.parse(raw);
    if (obj && typeof obj === "object") {
      Object.entries(obj).forEach(([phone, data]) => {
        if (data && typeof data === "object") feedbackSubmitted.set(phone, data);
      });
    }
  } catch (_) {}
}
function saveFeedbackSubmitted() {
  try {
    fs.writeFileSync(FEEDBACK_SUBMITTED_FILE, JSON.stringify(Object.fromEntries(feedbackSubmitted.entries()), null, 2), "utf8");
  } catch (e) {
    console.error("saveFeedbackSubmitted error:", e.message);
  }
}
function recordFeedbackSubmission(phone, fullName, pdfFileName) {
  const norm = normalizePhone(phone || "");
  if (!norm) return;
  feedbackSubmitted.set(norm, {
    submittedAt: Date.now(),
    fullName: String(fullName || ""),
    pdfFileName: String(pdfFileName || "")
  });
  saveFeedbackSubmitted();
}

loadFeedbackClicked();
loadFeedbackSubmitted();

function markFeedbackSent(phone, fullName) {
  feedbackSent.set(phone, { sentAt: Date.now(), fullName: String(fullName || "") });
  saveFeedbackSent();
}

function createFeedbackToken(phone, fullName) {
  const token = crypto.randomBytes(6).toString("hex"); // 12 hex — короткая ссылка
  const data = {
    token,
    phone,
    fullName: String(fullName || ""),
    createdAt: Date.now()
  };
  feedbackTokens.set(token, data);
  saveFeedbackTokens();
  return token;
}

function getFeedbackToken(token) {
  if (!token || typeof token !== "string") return null;
  return feedbackTokens.get(token) || null;
}

loadFeedbackSent();
loadFeedbackTokens();

// ──────────────────────────────────────────────────────────
// Статистика ЛК: уникальные авторизации по номеру телефона.
// Каждый номер учитывается ровно один раз (первая авторизация).
// Статистика отдаётся только через /admin/api/stats — на Я.Диск ничего
// не выгружается (раньше был ежедневный PDF, потом каждые 3 часа — убрано).
// ──────────────────────────────────────────────────────────

const LK_STATS_START_DATE = "22.05.2026"; // отсчёт «с какой даты» (label для админки)
// Точка отсечки в ms (МСК): записи о первой авторизации с timestamp'ом ДО этой
// даты в статистику не попадают (сами записи в .lkAuthPhones.json не удаляем —
// просто игнорируем при подсчёте, чтобы при необходимости можно было откатить).
const LK_STATS_START_MS = new Date("2026-05-22T00:00:00+03:00").getTime();

// Тестовые номера команды — НЕ показываем в админке /admin → Статистика
// (ни в totals, ни в conversions, ни в списке номеров). Записи в
// .lkAuthPhones.json / .lkFirstQuestionnaireLead.json не удаляем, просто
// игнорируем при подсчёте — чтобы можно было откатить без потери данных.
// Формат: нормализованный номер (без +, скобок, дефисов, пробелов).
//
// Источник списка двухуровневый:
//   1) Hardcoded дефолт (ниже) — всегда применяется. Это safety net на случай,
//      если JSON-файл сломан или удалён.
//   2) JSON-файл .lkStatsExcludedPhones.json (опционально) — добавляется к
//      дефолту, перечитывается при изменении (fs.watch). Это позволяет править
//      список на проде БЕЗ git push и pm2 restart.
//
// Формат JSON: {"phones": ["79111111111", "79222222222", ...]}
//
// Дефолтные номера (актуальная команда на момент написания):
//   +7 (916) 923-66-38 → 79169236638
//   +7 (995) 918-90-58 → 79959189058
//   +7 (999) 989-90-58 → 79999899058
//   +7 (999) 879-84-31 → 79998798431
//   +7 (911) 617-91-89 → 79116179189
//   +7 (925) 377-20-78 → 79253772078
//   +7 (926) 084-77-26 → 79260847726
//   +7 (982) 640-45-43 → 79826404543
//   +7 (929) 609-43-13 → 79296094313
const LK_STATS_EXCLUDED_PHONES_DEFAULT = [
  "79169236638",
  "79959189058",
  "79999899058",
  "79998798431",
  "79116179189",
  "79253772078",
  "79260847726",
  "79826404543",
  "79296094313"
];
// Stable reference — все потребители (computeAdminStats, recordLkAuth,
// computePaidConversionStats) обращаются к этому самому объекту через .has().
// При hot-reload содержимое перезаливается через .clear() + .add(), reference
// не меняется.
const LK_STATS_EXCLUDED_PHONES = new Set(LK_STATS_EXCLUDED_PHONES_DEFAULT);
const LK_STATS_EXCLUDED_PHONES_FILE = path.join(__dirname, ".lkStatsExcludedPhones.json");

function reloadLkStatsExcludedPhones() {
  // Стартуем с дефолта, поверх него мержим валидные номера из файла.
  const next = new Set(LK_STATS_EXCLUDED_PHONES_DEFAULT);
  let fromFile = 0;
  try {
    if (fs.existsSync(LK_STATS_EXCLUDED_PHONES_FILE)) {
      const raw = fs.readFileSync(LK_STATS_EXCLUDED_PHONES_FILE, "utf8");
      const obj = JSON.parse(raw);
      const arr = Array.isArray(obj?.phones) ? obj.phones : [];
      for (const p of arr) {
        // Принимаем только строки из 10-15 цифр (нормализованный российский
        // номер — 11 цифр, но даём запас). Всё прочее тихо игнорируем.
        if (typeof p === "string" && /^\d{10,15}$/.test(p)) {
          next.add(p);
          fromFile++;
        }
      }
    }
  } catch (e) {
    console.warn(`LK_STATS_EXCLUDED_PHONES: file load failed, using defaults only: ${e.message}`);
  }
  LK_STATS_EXCLUDED_PHONES.clear();
  for (const p of next) LK_STATS_EXCLUDED_PHONES.add(p);
  console.log(`LK_STATS_EXCLUDED_PHONES: ${LK_STATS_EXCLUDED_PHONES.size} entries (${LK_STATS_EXCLUDED_PHONES_DEFAULT.length} default + ${fromFile} from file)`);
  // При смене списка имеет смысл инвалидировать кеш админ-воронки — иначе
  // до истечения TTL (5 мин) исключённые номера будут продолжать висеть.
  try { invalidateAdminStatsCache(); } catch (_) {}
}

// Первичная загрузка — синхронно на старте процесса.
reloadLkStatsExcludedPhones();

// Hot-reload через fs.watch с дебаунсом 200мс (защита от двойных событий
// редактора и атомарных перезаписей). Если watcher не стартует (например,
// файла ещё нет) — мы всё равно работаем на дефолтах + перечитаем при
// следующем рестарте.
let _excludedPhonesReloadTimer = null;
function _scheduleExcludedPhonesReload() {
  if (_excludedPhonesReloadTimer) clearTimeout(_excludedPhonesReloadTimer);
  _excludedPhonesReloadTimer = setTimeout(reloadLkStatsExcludedPhones, 200);
}
try {
  // fs.watch на директории, чтобы переживать удаление/пересоздание файла
  // (rename-based атомарная запись из редакторов).
  fs.watch(__dirname, (eventType, filename) => {
    if (filename === ".lkStatsExcludedPhones.json") _scheduleExcludedPhonesReload();
  });
} catch (e) {
  console.warn(`LK_STATS_EXCLUDED_PHONES: fs.watch failed, hot-reload disabled: ${e.message}`);
}
const LK_AUTH_PHONES_FILE = path.join(__dirname, ".lkAuthPhones.json");
const lkAuthPhones = new Map(); // phone(7XXXXXXXXXX) -> firstAuthAt(ms)

function loadLkAuthPhones() {
  try {
    const raw = fs.readFileSync(LK_AUTH_PHONES_FILE, "utf8");
    const obj = JSON.parse(raw);
    if (obj && typeof obj === "object") {
      Object.entries(obj).forEach(([phone, ts]) => {
        lkAuthPhones.set(phone, Number(ts) || Date.now());
      });
    }
  } catch (_) {}
}

function saveLkAuthPhones() {
  try {
    const obj = Object.fromEntries(lkAuthPhones.entries());
    fs.writeFileSync(LK_AUTH_PHONES_FILE, JSON.stringify(obj, null, 2), "utf8");
  } catch (e) {
    console.error("saveLkAuthPhones error:", e.message);
  }
}

function recordLkAuth(phone) {
  const norm = normalizePhone(phone || "");
  if (!norm) return;
  if (lkAuthPhones.has(norm)) return; // уже учтён
  lkAuthPhones.set(norm, Date.now());
  saveLkAuthPhones();
  console.log(`LK STATS: new unique auth phone=${norm} totalNow=${lkAuthPhones.size}`);
  // Свежая авторизация = новая воронка-точка → сбрасываем кеш статистики, чтобы
  // на следующем polling-тике (10 сек) админ увидел свежие цифры.
  if (typeof invalidateAdminStatsCache === "function") invalidateAdminStatsCache();
  // Первая авторизация: асинхронно создаём «Готовые документы (ЛК)» в активных
  // сделках номера. Вход не блокируем (вызвано из auth-обработчика).
  setImmediate(() => {
    provisionReadyDocsForActiveLeads(norm).catch((e) =>
      console.error("READY-DOCS provision on auth error:", e.message));
  });
}

loadLkAuthPhones();

function formatPhoneForDisplay(norm) {
  if (!norm || norm.length !== 11) return `+${norm}`;
  return `+${norm[0]} (${norm.slice(1, 4)}) ${norm.slice(4, 7)}-${norm.slice(7, 9)}-${norm.slice(9, 11)}`;
}

// ── График новых авторизаций по дням (скользящее окно «последние 30 дней») ──
// Источник — lkAuthPhones (phone → firstAuthAt ms), полностью in-memory, поэтому
// расчёт дешёвый (один проход по Map на пару сотен записей) и всегда свежий —
// кеш не нужен, клиентский ЛК не затрагивается.
//
// Логика окна:
//   • День = МСК-сутки (UTC+3), как в trafficDayKey.
//   • Конец окна = сегодня (МСК). Начало = сегодня − 29 дней (итого 30 дней),
//     но не раньше LK_STATS_START_MS (22.05.2026 — когда начали отслеживать).
//   • Пока с 22.05.2026 не набралось 30 суток, показываем меньше дней; дальше
//     окно автоматически «едет» вперёд — всегда последние 30 дней.
//   • Исключаем тестовые номера команды и записи до точки отсчёта — как в
//     остальной статистике, чтобы цифры сходились с «Авторизовались».
function computeDailyAuthSeries() {
  const DAY_MS = 86400000;
  const MSK_OFFSET = 3 * 3600 * 1000; // UTC+3
  const mskDayIdx = (ts) => Math.floor((ts + MSK_OFFSET) / DAY_MS);
  const keyForIdx = (idx) => new Date(idx * DAY_MS).toISOString().slice(0, 10);

  const startFloorIdx = mskDayIdx(LK_STATS_START_MS); // 22.05.2026
  const todayIdx = mskDayIdx(Date.now());
  let startIdx = todayIdx - 29; // 30 дней включительно
  if (startIdx < startFloorIdx) startIdx = startFloorIdx;

  const counts = new Map(); // dayIdx -> кол-во новых авторизаций
  for (const [phone, ts] of lkAuthPhones.entries()) {
    if (!Number.isFinite(ts)) continue;
    if (ts < LK_STATS_START_MS) continue;
    if (LK_STATS_EXCLUDED_PHONES.has(phone)) continue;
    const idx = mskDayIdx(ts);
    if (idx < startIdx || idx > todayIdx) continue;
    counts.set(idx, (counts.get(idx) || 0) + 1);
  }

  const days = [];
  let total = 0, peak = 0;
  for (let i = startIdx; i <= todayIdx; i++) {
    const c = counts.get(i) || 0;
    total += c;
    if (c > peak) peak = c;
    days.push({ date: keyForIdx(i), count: c });
  }
  return { success: true, days, total, peak, windowDays: 30, startDate: LK_STATS_START_DATE };
}

// ── First-LK-questionnaire-lead для статистики воронки ──
// Для каждого phone запоминаем САМУЮ ПЕРВУЮ сделку, в которой клиент через ЛК
// отправил опросник. Эта связка определяет «учётную сделку клиента» для всех
// последующих этапов воронки (опросник → обязательные доки → все доки).
// Последующие сделки того же клиента в воронке не учитываются.
const LK_FIRST_Q_FILE = path.join(__dirname, ".lkFirstQuestionnaireLead.json");
const lkFirstQuestionnaireLead = new Map(); // phone -> { leadId: string|null, firstAt: number|null, checked: boolean }

function loadLkFirstQ() {
  try {
    const raw = fs.readFileSync(LK_FIRST_Q_FILE, "utf8");
    const obj = JSON.parse(raw);
    if (obj && typeof obj === "object") {
      Object.entries(obj).forEach(([phone, data]) => {
        if (data && typeof data === "object") {
          lkFirstQuestionnaireLead.set(phone, {
            leadId: data.leadId ? String(data.leadId) : null,
            firstAt: Number(data.firstAt) || null,
            checked: !!data.checked
          });
        }
      });
    }
  } catch (_) {}
}

function saveLkFirstQ() {
  try {
    const obj = Object.fromEntries(lkFirstQuestionnaireLead.entries());
    fs.writeFileSync(LK_FIRST_Q_FILE, JSON.stringify(obj, null, 2), "utf8");
  } catch (e) {
    console.error("saveLkFirstQ error:", e.message);
  }
}

// Вызывается ТОЛЬКО при успешном сохранении опросника через ЛК.
// Если у phone уже зафиксирована «первая ЛК-сделка с опросником» — не меняем.
function recordFirstQuestionnaireForPhone(phone, leadId) {
  const norm = normalizePhone(phone || "");
  if (!norm || !leadId) return;
  const existing = lkFirstQuestionnaireLead.get(norm);
  if (existing && existing.leadId) return; // уже зафиксирован настоящий первый
  lkFirstQuestionnaireLead.set(norm, {
    leadId: String(leadId),
    firstAt: Date.now(),
    checked: true
  });
  saveLkFirstQ();
  console.log(`LK STATS: first questionnaire phone=${norm} leadId=${leadId}`);
}

loadLkFirstQ();

// Бэкфилл: для phone из lkAuthPhones, у которого нет записи в lkFirstQuestionnaireLead,
// сканируем Я.Диск и ищем самый ранний leadId с опросником. Кешируем результат
// (даже отрицательный — со флагом checked=true). Вызывается лениво из computeAdminStats.
async function ensureFirstQuestionnaireLookup(phone) {
  const norm = normalizePhone(phone || "");
  if (!norm) return null;
  const cached = lkFirstQuestionnaireLead.get(norm);
  if (cached && (cached.leadId || cached.checked)) return cached.leadId || null;

  let foundLeadId = null;
  let foundAt = null;
  try {
    if (YANDEX_DISK_TOKEN) {
      // Шаг 1. Смотрим lead-scoped подпапки <phone>/<leadId>/TECH FOLDER/Опросник.json.
      // Listing верхнего уровня <phone>/* — все подпапки.
      const baseFolder = `${YANDEX_DISK_ROOT}/${norm}`;
      let topItems = [];
      try {
        const r = await yandexRequest({
          method: "GET",
          url: "https://cloud-api.yandex.net/v1/disk/resources",
          params: { path: baseFolder, limit: 1000, fields: "_embedded.items.name,_embedded.items.type" }
        });
        topItems = (r.data && r.data._embedded && r.data._embedded.items) || [];
      } catch (_) {}
      // leadId-папки — это подпапки с числовым именем.
      const numericFolders = topItems
        .filter((it) => it.type === "dir" && /^\d+$/.test(String(it.name || "")))
        .map((it) => String(it.name))
        .sort(); // числовой/лексикографический порядок (леды растут со временем)
      for (const leadId of numericFolders) {
        // Проверяем наличие хоть одного Опросник*.json в этой папке.
        const files = await listYandexFolderFiles(`${baseFolder}/${leadId}/${TECH_FOLDER_NAME}`);
        const hasQ = (files || []).some((n) => /^Опросник.*\.json$/i.test(n));
        if (hasQ) {
          foundLeadId = String(leadId);
          break;
        }
      }
      // Шаг 2. Если не нашли — проверяем legacy phone-scoped TECH FOLDER:
      //   если в нём есть Опросник*.json, владельцем считаем legacy owner.
      if (!foundLeadId) {
        const legacyFiles = await listYandexFolderFiles(`${baseFolder}/${TECH_FOLDER_NAME}`);
        const legacyHasQ = (legacyFiles || []).some((n) => /^Опросник.*\.json$/i.test(n));
        if (legacyHasQ) {
          const ownerId = await getLegacyOwnerLeadId(norm);
          if (ownerId) foundLeadId = String(ownerId);
        }
      }
    }
  } catch (e) {
    console.error("ensureFirstQuestionnaireLookup error:", e && e.message);
  }

  lkFirstQuestionnaireLead.set(norm, {
    leadId: foundLeadId,
    firstAt: foundLeadId ? Date.now() : null, // время найдено приблизительно как «когда обнаружили»
    checked: true
  });
  saveLkFirstQ();
  return foundLeadId;
}

// ── Реплика логики buildUploadBlocksConfig из cabinet.html (для подсчёта
// статистики). Здесь собираем ОБЪЕДИНЁННЫЙ набор всех блоков, которые могут
// быть запрошены у клиента на любом из 3 «загрузочных» этапов (Начало
// оформления, Первичный сбор документов, Подготовка документов). Стат-расчёт
// «загрузил ли клиент все нужные документы» не должен зависеть от текущего
// этапа — клиенту в итоге надо отдать всё, что подходит по его опроснику.
// Если меняешь условия в cabinet.html → синхронизируй здесь.
const STATS_DEFAULT_OPTIONAL_FIELDS = new Set([
  "invitation",
  "thirdCountryTickets",
  "birthCertificate",
  "sponsorPassport",
  "insurancePolicy",
  "workCert",
  "studyCert",
  "ownAccommodation",
  "ownTransport",
  "ownFlights",
  "routePlan",
  "electronicPhoto",
  "residencePermit"
]);

const ELECTRONIC_PHOTO_COUNTRIES = ["Испания", "Португалия", "Кипр"];
function countryMatchesAny(countryValue, list) {
  const v = String(countryValue || "").toLowerCase();
  if (!v) return false;
  return list.some((c) => v.includes(c.toLowerCase()));
}

// Если stageIndex передан — возвращаем блоки только для этого этапа ЛК.
// stageIndex undefined → ОБЪЕДИНЁННЫЙ набор всех «загрузочных» этапов
// (нужно для общего расчёта «всё ли загружено», когда этап не важен).
function buildUploadBlocksForApplicantStats(state, lead, stageIndex) {
  const isJp = state && String(state.visaType || "").trim() === "Виза в Японию";
  const includeAll = (typeof stageIndex !== "number");

  // Stage 0: «Начало оформления» — 2 паспорта для обеих виз.
  const stage0 = [
    { field: "innerPassport", label: "Внутренний паспорт (1-ый разворот, разворот с актуальной пропиской, последний разворот)", optional: false },
    { field: "mainPassport",  label: "Загран. паспорт (в который запрашиваем визу)", optional: false }
  ];

  if (isJp) {
    // Stage 1 Японии — условные блоки по опроснику.
    const stage1 = [];
    const occ = String(state.jp_occupation || "").trim();
    const jpTripPurpose = String(state.jp_tripPurpose || "").trim();
    if (jpTripPurpose && jpTripPurpose !== "Туризм") {
      stage1.push({ field: "invitation", label: "Приглашение", optional: true });
      stage1.push({ field: "routePlan",  label: "План поездки", optional: true });
    }
    if (String(state.jp_hasOwnFlights || "").trim() === "Да") {
      stage1.push({ field: "ownFlights", label: "Авиабилеты", optional: true });
    }
    if (String(state.jp_hasSponsor || "").trim() === "Да") {
      stage1.push({ field: "sponsorPassport", label: "Внутр. паспорт спонсора", optional: true });
    }
    if (String(state.jp_isUnder18 || "").trim() === "Да") {
      stage1.push({ field: "birthCertificate", label: "Свидетельство о рождении", optional: true });
    }
    if (occ === "Работа по найму") {
      stage1.push({ field: "workCert",  label: "Справка с работы", optional: true });
    }
    if (occ === "Учащийся") {
      stage1.push({ field: "studyCert", label: "Справка с учёбы", optional: true });
    }
    // Stage 2 Японии — свободная зона (extra-doc), здесь её не считаем
    // в воронке: блок есть всегда и не имеет «строго требуемых» файлов.
    const stage2 = [];

    if (includeAll) return stage0.concat(stage1).concat(stage2);
    if (stageIndex === 0) return stage0;
    if (stageIndex === 1) return stage1;
    if (stageIndex === 2) return stage2;
    return [];
  }

  // ─── Шенген ───
  const country = (lead && lead.country_service) || "";
  const stage1 = [];
  if (countryMatchesAny(country, ELECTRONIC_PHOTO_COUNTRIES)) {
    stage1.push({ field: "electronicPhoto", label: "Электронное фото", optional: true });
  }
  const tripPurpose = String(state.tripPurpose || "").trim();
  if (tripPurpose && tripPurpose !== "Туризм") {
    stage1.push({ field: "invitation", label: "Приглашение", optional: true });
  }

  const stage2 = [];
  if (state.hasActiveSchengen === "Да") {
    stage2.push({ field: "activeSchengenPhoto", label: "Фото действующей Шенгенской визы", optional: true });
  }
  if (state.hadSchengen3Years === "Да") {
    stage2.push({ field: "prevSchengenPhoto", label: "Фото последней Шенгенской визы", optional: true });
  }
  if (state.hasSponsor === "Да") {
    stage2.push({ field: "sponsorPassport", label: "Внутр. паспорт спонсора или Спонсорское письмо от компании", optional: true });
  }
  if (state.isUnder18 === "Да") {
    stage2.push({ field: "birthCertificate", label: "Свидетельство о рождении", optional: true });
  }
  if (state.hasSecondPassport === "Да") {
    stage2.push({ field: "secondPassport", label: "2-ой загран. паспорт", optional: true });
  }
  if (state.hasOwnAccommodation === "Да") {
    stage2.push({ field: "ownAccommodation", label: "Своё проживание (бронь или аренда или собственность)", optional: true });
  }
  if (state.hasOwnTransport === "Да") {
    stage2.push({ field: "ownTransport", label: "Свои авиабилеты или другой транспорт", optional: true });
  }
  if (
    state.hasSecondPassport === "Да" &&
    state.canSurrenderPassport === "Нет" &&
    /треть.*страну/i.test(String(state.surrenderReason || ""))
  ) {
    stage2.push({ field: "thirdCountryTickets", label: "Билеты в третью страну", optional: true });
  }
  if (state.notRussianCitizen === "Да") {
    stage2.push({ field: "residencePermit", label: "ВНЖ или регистрация", optional: true });
  }
  // Справка с работы/учёбы — если в опроснике указан работодатель.
  const employerNameSch = String(state.employerName || "").trim();
  if (employerNameSch && employerNameSch.toUpperCase() !== "НЕТ") {
    stage2.push({ field: "workCert", label: "Справка с работы или учёбы", optional: true });
  }
  // Страховой полис — если есть в опроснике (старое условие).
  if (state.hasInsurance === "Да") {
    stage2.push({ field: "insurancePolicy", label: "Страховой полис для въезда в Шенген", optional: true });
  }
  // Посадочные талоны — если клиент посещал Шенген после 10.04.2026, но штампы
  // в загранпаспорт ему не ставили. Гейтим и по родительскому условию (есть
  // действующая виза ИЛИ были визы за 3 года), чтобы не сработать на устаревших
  // значениях скрытых полей опросника. Зеркало cabinet.html buildUploadBlocksConfig.
  if (
    (state.hasActiveSchengen === "Да" || state.hadSchengen3Years === "Да") &&
    state.visitedSchengenAfterApr2026 === "Да" &&
    state.hadBorderStamps === "Нет"
  ) {
    stage2.push({ field: "boardingPasses", label: "Посадочные талоны и (или) иные подтверждения того, что вы использовали предыдущую визу", optional: true });
  }

  if (includeAll) return stage0.concat(stage1).concat(stage2);
  if (stageIndex === 0) return stage0;
  if (stageIndex === 1) return stage1;
  if (stageIndex === 2) return stage2;
  return [];
}

// Для конкретного (phone, leadId) считает по всем заявителям этой сделки,
// прошёл ли клиент этапы ЛК «Первичный сбор документов» (stage 1) и
// «Подготовка документов» (stage 2). «Прошёл этап X» = для каждого
// заявителя ВСЕ блоки этого этапа из его опросника фактически загружены.
//
// Имена ключей сохранены — { hasAllRequired, hasAllBlocks } — для backward
// compat с потребителями (computeAdminStats, frontend admin.html), но
// семантика теперь stage-based:
//   hasAllRequired — все блоки stage 1 загружены (прошёл «Первичный сбор»)
//   hasAllBlocks   — все блоки stage 2 загружены (прошёл «Подготовку»)
// «Загружено» определяется так же, как в кабинете: имя файла начинается
// с label блока, далее точка или пробел.
async function computeUploadStatusForLead(phone, leadId, leadObj) {
  if (!phone || !leadId) return { hasAllRequired: false, hasAllBlocks: false };
  try {
    const techFiles = await listAllTechFiles(phone, leadId);
    const indices = new Set();
    techFiles.forEach((n) => {
      const m = /^Опросник(?:\s+(\d+))?\.json$/i.exec(n);
      if (m) indices.add(parseInt(m[1] || "1", 10));
    });
    if (!indices.size) return { hasAllRequired: false, hasAllBlocks: false };

    const ownerId = await getLegacyOwnerLeadId(phone);
    const isLegacyOwner = ownerId && String(ownerId) === String(leadId);
    const leadRoot = leadScopedFolder(phone, leadId);
    const phoneRoot = `${YANDEX_DISK_ROOT}/${phone}`;

    let allStage1 = true;
    let allStage2 = true;

    for (const idx of indices) {
      const data = await loadApplicantJson(phone, leadId, idx);
      if (!data || !data.fullName) {
        allStage1 = false; allStage2 = false;
        continue;
      }
      // Кумулятивная логика «прошёл этап X»: учитываем не только блоки
      // самого X, но и всех предыдущих этапов. То есть «прошёл «Первичный
      // сбор»» = stage 0 (2 паспорта) + stage 1 (условные A) загружены;
      // «прошёл «Подготовку»» = stage 0 + stage 1 + stage 2 загружены.
      // Иначе пустые stage 1/2 (Шенген: туризм, не Испания/Португалия/Кипр,
      // hasInsurance=Нет и т.п.) автоматом проходили этап даже без паспортов.
      const stage0Blocks = buildUploadBlocksForApplicantStats(data, leadObj, 0);
      const stage1Blocks = buildUploadBlocksForApplicantStats(data, leadObj, 1);
      const stage2Blocks = buildUploadBlocksForApplicantStats(data, leadObj, 2);
      const cumulative1 = stage0Blocks.concat(stage1Blocks);
      const cumulative2 = cumulative1.concat(stage2Blocks);

      const safeFio = sanitizeFileName(String(data.fullName).trim());
      if (!safeFio) {
        allStage1 = false; allStage2 = false;
        continue;
      }

      const merged = new Set();
      (await listYandexFolderFiles(`${leadRoot}/${safeFio}`) || []).forEach((n) => merged.add(n));
      if (isLegacyOwner) {
        (await listYandexFolderFiles(`${phoneRoot}/${safeFio}`) || []).forEach((n) => merged.add(n));
      }
      const files = Array.from(merged);

      const allLoaded = (blocks) => blocks.every((b) => files.some((f) => {
        if (!f.startsWith(b.label)) return false;
        const next = f.charAt(b.label.length);
        return next === "." || next === " ";
      }));

      // Кумулятив включает 2 паспорта (stage 0), поэтому пустого набора
      // быть не может — клиент обязан загрузить хотя бы паспорта.
      if (!allLoaded(cumulative1)) allStage1 = false;
      if (!allLoaded(cumulative2)) allStage2 = false;
    }
    return { hasAllRequired: allStage1, hasAllBlocks: allStage2 };
  } catch (e) {
    console.error("computeUploadStatusForLead error:", e && e.message);
    return { hasAllRequired: false, hasAllBlocks: false };
  }
}

// ──────────────────────────────────────────────────────────────────────
// Конверсия авторизаций по «оплаченным» сделкам amoCRM.
// Источник — сделки, у которых:
//   • Кастомное поле «Дата оплаты» ≥ 22.05.2026
//   • «Страна оформления/услуга» содержит подстроку из списка целевых стран
//
// Показываем 3 процента:
//   1. Общая конверсия по всем сделкам из списка
//   2. Без Японии — конверсия среди сделок-не-японских из списка
//   3. Только Япония — конверсия среди сделок где страна содержит «Япония»
//
// «Авторизовался» = телефон контакта сделки попал в lkAuthPhones (после
// LK_STATS_START_MS и не в LK_STATS_EXCLUDED_PHONES).
// ──────────────────────────────────────────────────────────────────────

// Список целевых стран (без Японии). Подстрочный матч — case-insensitive.
const PAID_CONV_NON_JAPAN_COUNTRIES = [
  "Австрия", "Бельгия", "Болгария", "Венгрия", "Германия", "Греция",
  "Дания", "Исландия", "Испания", "Италия", "Кипр", "Латвия", "Литва",
  "Лихтенштейн", "Люксембург", "Мальта", "Нидерланды", "Норвегия",
  "Польша", "Португалия", "Румыния", "Словакия", "Словения", "Финляндия",
  "Франция", "Хорватия", "Чехия", "Швейцария", "Швеция", "Шенген", "Эстония"
];
const PAID_CONV_JAPAN_TOKEN = "Япония";
const PAID_CONV_ALL_COUNTRIES = [...PAID_CONV_NON_JAPAN_COUNTRIES, PAID_CONV_JAPAN_TOKEN];

function paidConvNormalize(s) {
  return String(s || "").toLowerCase();
}
function paidConvCountryMatchesAny(countryValue, list) {
  const v = paidConvNormalize(countryValue);
  if (!v) return false;
  return list.some((tok) => v.includes(tok.toLowerCase()));
}
function paidConvIsJapan(countryValue) {
  return paidConvNormalize(countryValue).includes(PAID_CONV_JAPAN_TOKEN.toLowerCase());
}

// Кеш id кастомных полей сделок (отдельные слоты, не зависят от воронки).
let _cachedPaymentDateFieldId = undefined;
let _cachedCountryServiceFieldId = undefined;
async function getCustomFieldIdByPredicate(baseUrl, predicate) {
  const fields = await amoGetAllPages(`${baseUrl}/api/v4/leads/custom_fields`);
  const found = (fields || []).find(predicate);
  return found ? found.id : null;
}
async function getPaymentDateFieldId() {
  if (_cachedPaymentDateFieldId !== undefined) return _cachedPaymentDateFieldId;
  try {
    const baseUrl = `https://${AMO_SUBDOMAIN}.amocrm.ru`;
    _cachedPaymentDateFieldId = await getCustomFieldIdByPredicate(baseUrl, (f) => {
      const name = String(f.name || "").trim().toLowerCase();
      return name === "дата оплаты" || name.startsWith("дата оплат");
    });
    console.log(`AMO FIELD «Дата оплаты»: id=${_cachedPaymentDateFieldId || "NOT FOUND"}`);
  } catch (e) {
    console.error("getPaymentDateFieldId error:", e.response?.data || e.message);
    _cachedPaymentDateFieldId = null;
  }
  return _cachedPaymentDateFieldId;
}
async function getCountryServiceFieldId() {
  if (_cachedCountryServiceFieldId !== undefined) return _cachedCountryServiceFieldId;
  try {
    const baseUrl = `https://${AMO_SUBDOMAIN}.amocrm.ru`;
    _cachedCountryServiceFieldId = await getCustomFieldIdByPredicate(baseUrl, (f) => {
      const name = String(f.name || "").trim().toLowerCase();
      return name === "страна оформления/услуга" || name.startsWith("страна оформления");
    });
    console.log(`AMO FIELD «Страна оформления/услуга»: id=${_cachedCountryServiceFieldId || "NOT FOUND"}`);
  } catch (e) {
    console.error("getCountryServiceFieldId error:", e.response?.data || e.message);
    _cachedCountryServiceFieldId = null;
  }
  return _cachedCountryServiceFieldId;
}

// Кеш результата вычисления — 20 минут. Должен быть с запасом длиннее интервала
// фонового пре-warm (15 мин), чтобы между прогревами не было «провалов»,
// когда живой запрос /admin вынужден ждать холодного пересчёта.
let _cachedPaidConvStats = null;
let _cachedPaidConvStatsTs = 0;
const PAID_CONV_CACHE_TTL_MS = 20 * 60 * 1000;
// Single-flight: параллельные вызовы ждут результат уже идущего пересчёта,
// а не запускают свои. Без этого admin polling + пре-warm + open-страница
// плодят 5-10 одновременных пересчётов, которые забивают amoCRM 429.
let _paidConvInflight = null;

async function computePaidConversionStats() {
  const now = Date.now();
  if (_cachedPaidConvStats && (now - _cachedPaidConvStatsTs) < PAID_CONV_CACHE_TTL_MS) {
    return _cachedPaidConvStats;
  }
  if (_paidConvInflight) return _paidConvInflight;
  _paidConvInflight = _computePaidConversionStatsInner().finally(() => {
    _paidConvInflight = null;
  });
  return _paidConvInflight;
}

async function _computePaidConversionStatsInner() {
  const now = Date.now();
  const empty = {
    startDate: LK_STATS_START_DATE,
    countries: { all: 0, nonJapan: 0, japan: 0 },
    authorized: { all: 0, nonJapan: 0, japan: 0 },
    conversions: { all: 0, nonJapan: 0, japan: 0 },
    error: null
  };
  if (!AMO_SUBDOMAIN || !AMO_ACCESS_TOKEN) {
    return Object.assign({}, empty, { error: "AMO not configured" });
  }
  try {
    const baseUrl = `https://${AMO_SUBDOMAIN}.amocrm.ru`;
    const paymentDateFieldId = await getPaymentDateFieldId();
    if (!paymentDateFieldId) {
      return Object.assign({}, empty, { error: "Не найдено поле «Дата оплаты»" });
    }

    // Стартовая дата = LK_STATS_START_MS (00:00 22.05.2026 МСК) в секундах epoch.
    // amoCRM не принимает filter[custom_fields_values][*][from] на этом аккаунте
    // ("Invalid filter for current account"). Поэтому фильтруем по updated_at —
    // оплата меняет лида и его updated_at, поэтому окно покрывает все наши кейсы.
    // Уже в коде дополнительно проверяем фактическое значение «Дата оплаты».
    const fromTs = Math.floor(LK_STATS_START_MS / 1000);
    const params = {
      "filter[updated_at][from]": String(fromTs),
      with: "contacts"
    };
    const t0 = Date.now();
    // Параллельная пагинация — драматически быстрее последовательной
    // на больших объёмах (>1000 сделок). Concurrency снижен с 8 до 4, чтобы
    // не выжирать amoCRM rate-limit (7 RPS) — это синхронизировано с понижением
    // CONCURRENCY в computeAdminStats по той же причине.
    const allLeads = await amoGetAllPagesParallel(`${baseUrl}/api/v4/leads`, params, 4);
    console.log(`PAID-CONV STATS: fetched ${allLeads.length} leads updated_at >= ${fromTs} (${Date.now()-t0}ms)`);

    // Карта воронок/статусов — уже кешируется на 10 минут (getCachedPipelinesMap),
    // поэтому добавление здесь дополнительного шага НЕ замедляет работу.
    // Используем для фильтрации статуса «Доплата» (исключение из расчёта
    // по требованию от 28.05.2026).
    let statusesMap = null;
    try {
      statusesMap = await getCachedPipelinesMap(baseUrl);
    } catch (e) {
      console.error("PAID-CONV STATS: pipelines map error (продолжаем без фильтра по «Доплата»):", e.message);
    }

    // ── Сначала отфильтруем сделки по «Дата оплаты» + стране + статус/услуга
    //    (исключения «Доплата» и «ВНЖ» в стране) — чтобы потом тянуть
    //    телефоны ТОЛЬКО для контактов, которые реально нужны.
    let excludedDoplata = 0;
    let excludedVnj = 0;
    const matchedLeads = [];
    for (const lead of allLeads) {
      // Дата оплаты
      const fields = (lead && lead.custom_fields_values) || [];
      const pf = fields.find((f) => Number(f.field_id) === Number(paymentDateFieldId));
      if (!pf) continue;
      const payTs = Number((pf.values && pf.values[0] && pf.values[0].value) || 0);
      if (!payTs || payTs < fromTs) continue;
      // Страна
      const country = getCustomFieldValue(lead, "Страна оформления/услуга") || "";
      if (!paidConvCountryMatchesAny(country, PAID_CONV_ALL_COUNTRIES)) continue;
      // Исключаем сделки со «ВНЖ» в поле «Страна оформления/услуга»
      // (подстрочно, case-insensitive — «ВНЖ» может быть в сочетании
      // с другими словами и символами).
      if (/внж/i.test(country)) { excludedVnj++; continue; }
      // Исключаем сделки на статусе amoCRM «Доплата» (case-insensitive,
      // подстрочно — чтобы поймать вариации типа «Доплата по сделке»).
      // statusesMap опционален — если он не загрузился, фильтр пропускается.
      if (statusesMap) {
        const meta = statusesMap.get(`${lead.pipeline_id}:${lead.status_id}`) || {};
        const statusName = String(meta.status_name || "").trim().toLowerCase();
        if (statusName.includes("доплат")) { excludedDoplata++; continue; }
      }
      matchedLeads.push({ lead, country });
    }
    console.log(`PAID-CONV STATS: ${matchedLeads.length} leads match payment_date + country filter (excluded: Доплата=${excludedDoplata}, ВНЖ=${excludedVnj})`);

    // ── DEBUG: распределение статусов и стран среди прошедших фильтр.
    //    Чтобы понять, почему фильтр «Доплата»/«ВНЖ» отбрасывает 0
    //    (возможно, такие сделки реально отсутствуют, или их статус
    //    в amoCRM назван иначе). Лог пишется один раз за пересчёт (раз в
    //    20 минут под cache TTL) — нагрузки не создаёт.
    if (statusesMap) {
      const statusCount = new Map();
      const countryCount = new Map();
      for (const { lead, country } of matchedLeads) {
        const meta = statusesMap.get(`${lead.pipeline_id}:${lead.status_id}`) || {};
        const key = `${meta.pipeline_name || "?"} / ${meta.status_name || "?"}`;
        statusCount.set(key, (statusCount.get(key) || 0) + 1);
        countryCount.set(country, (countryCount.get(country) || 0) + 1);
      }
      const topStatuses = Array.from(statusCount.entries())
        .sort((a, b) => b[1] - a[1])
        .map(([k, v]) => `${k}=${v}`);
      console.log(`PAID-CONV DEBUG statuses: ${topStatuses.join(" | ")}`);
      const topCountries = Array.from(countryCount.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 15)
        .map(([k, v]) => `${k}=${v}`);
      console.log(`PAID-CONV DEBUG countries (top 15): ${topCountries.join(" | ")}`);
    }

    // Соберём contact_id только по «выжившим» лидам.
    const contactIds = new Set();
    for (const { lead } of matchedLeads) {
      const cs = (lead && lead._embedded && lead._embedded.contacts) || [];
      for (const c of cs) {
        if (c && c.id) contactIds.add(c.id);
      }
    }

    // ── Пакетная загрузка контактов: amoCRM поддерживает filter[id][]=...,
    //    тащим пачками по 50 (URL длинна остаётся управляемой). Это драматически
    //    быстрее, чем по 1 контакту за запрос.
    const t1 = Date.now();
    const contactPhonesMap = new Map(); // contactId -> Set<normalizedPhone>
    const idList = Array.from(contactIds);
    const BATCH = 50;
    for (let i = 0; i < idList.length; i += BATCH) {
      const chunk = idList.slice(i, i + BATCH);
      try {
        const chunkParams = {};
        chunk.forEach((id, idx) => { chunkParams[`filter[id][${idx}]`] = String(id); });
        chunkParams["limit"] = String(BATCH);
        const data = await amoGet(`${baseUrl}/api/v4/contacts`, chunkParams);
        const items = (data && data._embedded && data._embedded.contacts) || [];
        for (const contact of items) {
          if (!contact || !contact.id) continue;
          contactPhonesMap.set(contact.id, new Set(extractPhonesFromContact(contact)));
        }
      } catch (e) {
        console.error(`PAID-CONV STATS contact batch ${i}-${i+chunk.length} error:`, e.response?.data || e.message);
        // Пустые наборы — те, для кого данных нет, по умолчанию считаются «не авторизовался».
      }
    }
    // Для тех id, кого batch не вернул (deleted/permission issue) — пустой Set, чтобы
    // получить детерминированный результат «не авторизован».
    for (const id of idList) if (!contactPhonesMap.has(id)) contactPhonesMap.set(id, new Set());
    console.log(`PAID-CONV STATS: fetched ${idList.length} contacts in ${Math.ceil(idList.length / BATCH)} batches (${Date.now()-t1}ms)`);

    // ── Считаем 3 ведра.
    let denomAll = 0, numAll = 0;
    let denomNJ  = 0, numNJ  = 0;
    let denomJP  = 0, numJP  = 0;

    for (const { lead, country } of matchedLeads) {
      const isJp = paidConvIsJapan(country);

      // Авторизовался ли контакт этой сделки?
      const cs = (lead && lead._embedded && lead._embedded.contacts) || [];
      let authorized = false;
      for (const c of cs) {
        const phones = contactPhonesMap.get(c && c.id);
        if (!phones || !phones.size) continue;
        for (const p of phones) {
          const ts = lkAuthPhones.get(p);
          if (ts != null && Number(ts) >= LK_STATS_START_MS && !LK_STATS_EXCLUDED_PHONES.has(p)) {
            authorized = true;
            break;
          }
        }
        if (authorized) break;
      }

      denomAll++;
      if (authorized) numAll++;
      if (isJp) {
        denomJP++;
        if (authorized) numJP++;
      } else {
        denomNJ++;
        if (authorized) numNJ++;
      }
    }

    function pct(num, den) {
      if (!den) return 0;
      return Math.round((num / den) * 100);
    }
    const result = {
      startDate: LK_STATS_START_DATE,
      countries: { all: denomAll, nonJapan: denomNJ, japan: denomJP },
      authorized: { all: numAll, nonJapan: numNJ, japan: numJP },
      conversions: {
        all: pct(numAll, denomAll),
        nonJapan: pct(numNJ, denomNJ),
        japan: pct(numJP, denomJP)
      },
      error: null
    };
    _cachedPaidConvStats = result;
    _cachedPaidConvStatsTs = now;
    return result;
  } catch (e) {
    console.error("computePaidConversionStats error:", e.response?.data || e.message);
    return Object.assign({}, empty, { error: e.message || "amoCRM error" });
  }
}

// Кеш результата computeAdminStats. TTL держим заметно длиннее реального
// пересчёта (минуты при холодном кеше под нагрузкой) — иначе polling каждые
// 10 сек гонит каскад пересчётов, которые ещё и упираются в rate-limit amoCRM.
// invalidateAdminStatsCache() всё равно дёргается из recordLkAuth — новые
// авторизации появятся в воронке быстро, без ожидания TTL.
let _cachedAdminStats = null;
let _cachedAdminStatsTs = 0;
const ADMIN_STATS_CACHE_TTL_MS = 13 * 60 * 1000; // > интервала пре-warm (12 мин), чтобы кеш не остывал между прогревами
// Single-flight для воронки: admin-страница polling-ит /admin/api/stats каждые
// 10 сек. Когда кеш холодный (после рестарта или TTL), без single-flight
// каждый polling-запрос запускал отдельный пересчёт — 5-10 параллельных
// проходов по всем телефонам, все дерутся за amoCRM rate-limit.
let _adminStatsInflight = null;
function invalidateAdminStatsCache() {
  _cachedAdminStats = null;
  _cachedAdminStatsTs = 0;
}

async function computeAdminStats() {
  const now = Date.now();
  if (_cachedAdminStats && (now - _cachedAdminStatsTs) < ADMIN_STATS_CACHE_TTL_MS) {
    return _cachedAdminStats;
  }
  if (_adminStatsInflight) return _adminStatsInflight;
  _adminStatsInflight = _computeAdminStatsInner().finally(() => {
    _adminStatsInflight = null;
  });
  return _adminStatsInflight;
}
// Пересчёт для пре-warm без обнуления кеша заранее: старый результат отдаётся
// поллерам, пока считается новый (без подвисаний на холодном кеше).
function refreshAdminStats() {
  if (_adminStatsInflight) return _adminStatsInflight;
  _adminStatsInflight = _computeAdminStatsInner().finally(() => {
    _adminStatsInflight = null;
  });
  return _adminStatsInflight;
}

async function _computeAdminStatsInner() {
  // Базовый набор — авторизованные клиенты, чья первая авторизация попадает
  // в окно отслеживания (с LK_STATS_START_MS) И не попала в чёрный список
  // тестовых номеров команды (LK_STATS_EXCLUDED_PHONES). Старые записи
  // остаются в .lkAuthPhones.json (на случай отката), но в воронку не идут.
  const phoneEntries = Array.from(lkAuthPhones.entries())
    .filter(([phone, ts]) =>
      Number(ts) >= LK_STATS_START_MS &&
      !LK_STATS_EXCLUDED_PHONES.has(phone)
    )
    .sort((a, b) => b[1] - a[1]);

  // ── Параллельная обработка клиентов чанками по 4 одновременно ──
  // Раньше было последовательно: для каждого клиента ждали запросы к Я.Диску
  // (проверить опросник + проверить документы), что давало N × ~200мс задержки.
  // Параллелизация даёт большое ускорение, но при 8 одновременных клиентах
  // вкупе с пре-warm paid-conv мы упирались в amoCRM rate-limit (429) —
  // снизили до 4, чтобы оставить запас другим потребителям API.
  const CONCURRENCY = 4;
  async function processPhone([phone, ts]) {
    const firstLeadId = await ensureFirstQuestionnaireLookup(phone);
    let stage = 1;
    let submittedQ = false, uploadedReq = false, uploadedAll = false;
    if (firstLeadId) {
      submittedQ = true;
      stage = 2;
      const up = await computeUploadStatusForLead(phone, firstLeadId);
      if (up.hasAllRequired) {
        uploadedReq = true;
        stage = 3;
        if (up.hasAllBlocks) {
          uploadedAll = true;
          stage = 4;
        }
      }
    }
    return {
      phone,
      formatted: formatPhoneForDisplay(phone),
      firstAuthAt: ts,
      stage,
      stages: {
        authorized: true,
        submittedQuestionnaire: submittedQ,
        uploadedRequired: uploadedReq,
        uploadedAll: uploadedAll
      },
      firstQuestionnaireLeadId: firstLeadId || null
    };
  }
  const perPhone = [];
  let countSubmitted = 0;
  let countRequired = 0;
  let countAll = 0;
  const tStart = Date.now();
  for (let i = 0; i < phoneEntries.length; i += CONCURRENCY) {
    const chunk = phoneEntries.slice(i, i + CONCURRENCY);
    const results = await Promise.all(chunk.map(processPhone));
    for (const r of results) {
      perPhone.push(r);
      if (r.stages.submittedQuestionnaire) countSubmitted++;
      if (r.stages.uploadedRequired) countRequired++;
      if (r.stages.uploadedAll) countAll++;
    }
  }
  console.log(`ADMIN STATS: processed ${phoneEntries.length} phones in ${Date.now()-tStart}ms`);

  // Сортировка: сначала те, кто дальше НЕ прошёл (stage 1), потом 2, 3, 4.
  perPhone.sort((a, b) => a.stage - b.stage || (b.firstAuthAt - a.firstAuthAt));

  const totalAuth = phoneEntries.length;
  function pct(num, den) {
    if (!den) return 0;
    return Math.round((num / den) * 100);
  }

  const result = {
    startDate: LK_STATS_START_DATE,
    totals: {
      authorized: totalAuth,
      submittedQuestionnaire: countSubmitted,
      uploadedRequired: countRequired,
      uploadedAll: countAll
    },
    conversions: {
      auth_to_submitted: pct(countSubmitted, totalAuth),
      submitted_to_required: pct(countRequired, countSubmitted),
      required_to_all: pct(countAll, countRequired),
      // Сквозная конверсия: «авторизовались → загрузили все документы».
      auth_to_all: pct(countAll, totalAuth)
    },
    phones: perPhone
  };
  _cachedAdminStats = result;
  _cachedAdminStatsTs = Date.now();
  return result;
}

// ──────────────────────────────────────────────────────────
// Воронка по ЭТАПАМ сделки (статусы ЛК из amoCRM), кумулятивно.
// «Прошёл этап X» = у клиента есть сделка, дошедшая до этапа X
// (по максимальному cabinet_stage_index среди его видимых сделок).
// Этап «Оформление на паузе» (idx 4) в воронку не выводим, но он засчитывается
// как достижение предыдущих этапов (сравнение по индексу).
// Кеш + single-flight + пре-warm, concurrency 2 — щадим amoCRM rate-limit,
// чтобы фоновый расчёт не мешал клиентскому кабинету (общий лимит 7 RPS).
// ──────────────────────────────────────────────────────────
let _cachedStageStats = null;
let _cachedStageStatsTs = 0;
let _stageStatsInflight = null;
const STAGE_STATS_CACHE_TTL_MS = 22 * 60 * 1000; // > интервала пре-warm (20 мин), чтобы кеш не остывал
function invalidateStageStatsCache() { _cachedStageStats = null; _cachedStageStatsTs = 0; }

// Тихий помощник: максимальный cabinet_stage_index по видимым сделкам номера.
// Переиспользует те же кирпичики, что getLeadsByPhone, но без verbose-логов и
// возвращает только индекс (или -1, если видимых сделок нет).
async function getMaxCabinetStageForPhone(phone, statusesMap, baseUrl) {
  const normalized = normalizePhone(phone);
  if (!normalized) return -1;
  const contacts = await findMatchingContacts(baseUrl, normalized);
  if (!contacts.length) return -1;
  const leadIds = await collectLeadIdsFromContacts(baseUrl, contacts);
  if (!leadIds.length) return -1;
  // Приоритет АКТИВНОЙ сделки. «Обращение исполнено» (последний этап) —
  // терминальное состояние завершённой сделки. Если у клиента есть хоть одна
  // активная (видимая, НЕ завершённая) сделка — статистика представляет его
  // по ней; завершённую берём, только если активных нет вовсе. Так у клиента
  // с новой сделкой в работе + старой закрытой больше не показывается «обращение
  // исполнено». Дубли/мусор/«закрыто и не реализовано» уже отсеяны через
  // hidden_in_cabinet — ровно как в клиентском ЛК (там их тоже не показываем).
  const DONE_IDX = CABINET_STAGES.indexOf("Обращение исполнено");
  let maxActiveIdx = -1; // максимум среди активных (незавершённых) видимых сделок
  let maxDoneIdx = -1;   // максимум среди завершённых видимых сделок (фактически DONE_IDX)
  for (const leadId of leadIds) {
    const lead = await getLeadById(baseUrl, leadId);
    if (!lead || !lead.id) continue;
    const enriched = enrichLeadWithMappedStatus(lead, statusesMap);
    if (enriched.hidden_in_cabinet) continue;
    const idx = Number(enriched.cabinet_stage_index);
    if (!Number.isFinite(idx) || idx < 0) continue;
    if (DONE_IDX >= 0 && idx === DONE_IDX) {
      if (idx > maxDoneIdx) maxDoneIdx = idx;
    } else if (idx > maxActiveIdx) {
      maxActiveIdx = idx;
    }
  }
  return maxActiveIdx >= 0 ? maxActiveIdx : maxDoneIdx;
}

async function computeStageStats() {
  const now = Date.now();
  if (_cachedStageStats && (now - _cachedStageStatsTs) < STAGE_STATS_CACHE_TTL_MS) return _cachedStageStats;
  if (_stageStatsInflight) return _stageStatsInflight;
  _stageStatsInflight = _computeStageStatsInner().finally(() => { _stageStatsInflight = null; });
  return _stageStatsInflight;
}
// Принудительный пересчёт для пре-warm: старый кеш остаётся валидным до
// завершения (поллеры не виснут), затем кеш атомарно обновляется в _inner.
function refreshStageStats() {
  if (_stageStatsInflight) return _stageStatsInflight;
  _stageStatsInflight = _computeStageStatsInner().finally(() => { _stageStatsInflight = null; });
  return _stageStatsInflight;
}

async function _computeStageStatsInner() {
  const phoneEntries = Array.from(lkAuthPhones.entries())
    .filter(([phone, ts]) => Number(ts) >= LK_STATS_START_MS && !LK_STATS_EXCLUDED_PHONES.has(phone))
    .sort((a, b) => b[1] - a[1]);

  function pct(n, d) { return d > 0 ? Math.round((n / d) * 100) : 0; }
  const baseResult = (perPhone, authorized, c) => ({
    startDate: LK_STATS_START_DATE,
    totals: { authorized, primary: c.primary, prep: c.prep, waiting: c.waiting, review: c.review, passport: c.passport, done: c.done },
    conversions: {
      auth_to_primary: pct(c.primary, authorized),
      primary_to_prep: pct(c.prep, c.primary),
      prep_to_waiting: pct(c.waiting, c.prep),
      waiting_to_review: pct(c.review, c.waiting),
      review_to_passport: pct(c.passport, c.review),
      passport_to_done: pct(c.done, c.passport),
      auth_to_done: pct(c.done, authorized)
    },
    phones: perPhone
  });

  if (!AMO_SUBDOMAIN || !AMO_ACCESS_TOKEN) {
    const r = baseResult([], phoneEntries.length, { primary:0, prep:0, waiting:0, review:0, passport:0, done:0 });
    _cachedStageStats = r; _cachedStageStatsTs = Date.now(); return r;
  }
  const baseUrl = `https://${AMO_SUBDOMAIN}.amocrm.ru`;
  let statusesMap = null;
  try { statusesMap = await getCachedPipelinesMap(baseUrl); } catch (e) { console.error("STAGE STATS pipelines err:", e.message); }

  const CONCURRENCY = 2; // щадим amoCRM, чтобы не мешать клиентскому кабинету
  async function processPhone([phone, ts]) {
    let idx = -1;
    try { idx = await getMaxCabinetStageForPhone(phone, statusesMap, baseUrl); }
    catch (e) { console.error("STAGE STATS phone err", phone, e && e.message); }
    return {
      phone, formatted: formatPhoneForDisplay(phone), firstAuthAt: ts,
      reachedIndex: idx,
      reachedLabel: (idx >= 0 && CABINET_STAGES[idx]) ? CABINET_STAGES[idx] : "—",
      stages: {
        authorized: true,
        primary: idx >= 1, prep: idx >= 2, waiting: idx >= 3,
        review: idx >= 5, passport: idx >= 6, done: idx >= 7
      }
    };
  }
  const perPhone = [];
  const tStart = Date.now();
  // Пауза между чанками: размазываем запросы к amoCRM во времени, чтобы фоновый
  // прогон не давал пиковых всплесков RPS (общий лимит аккаунта 7 RPS делится с
  // клиентским ЛК и веб-интерфейсом amoCRM). При concurrency=2 и паузе ~700мс
  // job держит ≈3 RPS вместо рваных всплесков → меньше каскадов 429-retry.
  const STAGE_STATS_CHUNK_PAUSE_MS = 700;
  for (let i = 0; i < phoneEntries.length; i += CONCURRENCY) {
    const chunk = phoneEntries.slice(i, i + CONCURRENCY);
    const res = await Promise.all(chunk.map(processPhone));
    perPhone.push(...res);
    if (i + CONCURRENCY < phoneEntries.length) {
      await new Promise((r) => setTimeout(r, STAGE_STATS_CHUNK_PAUSE_MS));
    }
  }
  console.log(`STAGE STATS: processed ${phoneEntries.length} phones in ${Date.now()-tStart}ms`);

  const c = { primary:0, prep:0, waiting:0, review:0, passport:0, done:0 };
  for (const p of perPhone) {
    if (p.stages.primary) c.primary++;
    if (p.stages.prep) c.prep++;
    if (p.stages.waiting) c.waiting++;
    if (p.stages.review) c.review++;
    if (p.stages.passport) c.passport++;
    if (p.stages.done) c.done++;
  }
  // По умолчанию — по этапу (отстающие сверху), как в doc-вкладке.
  perPhone.sort((a, b) => (a.reachedIndex - b.reachedIndex) || (b.firstAuthAt - a.firstAuthAt));

  const result = baseResult(perPhone, phoneEntries.length, c);
  _cachedStageStats = result; _cachedStageStatsTs = Date.now();
  return result;
}

// ──────────────────────────────────────────────────────────
// Legacy-owner для существующих данных в phone-scoped папках Я.Диска
// (до 2026-05-21 файлы лежали в <phone>/..., без leadId-партиции).
// Чтобы сохранить совместимость со старыми клиентами и не показывать их
// данные в новых сделках, определяем «владельца» legacy-данных = САМАЯ
// ПЕРВАЯ сделка клиента в amoCRM (по created_at). Эта связка кешируется.
// ──────────────────────────────────────────────────────────
const LEGACY_OWNERS_FILE = path.join(__dirname, ".legacyOwners.json");
const legacyOwnersCache = new Map(); // phone -> { leadId: string|null, computedAt: number }

function loadLegacyOwners() {
  try {
    const raw = fs.readFileSync(LEGACY_OWNERS_FILE, "utf8");
    const obj = JSON.parse(raw);
    if (obj && typeof obj === "object") {
      Object.entries(obj).forEach(([phone, data]) => {
        if (data) legacyOwnersCache.set(phone, data);
      });
    }
  } catch (_) {}
}

function saveLegacyOwners() {
  try {
    const obj = Object.fromEntries(legacyOwnersCache.entries());
    fs.writeFileSync(LEGACY_OWNERS_FILE, JSON.stringify(obj, null, 2), "utf8");
  } catch (e) {
    console.error("saveLegacyOwners error:", e.message);
  }
}

loadLegacyOwners();

// Определяет «владельца» legacy-данных для phone:
// - если в <phone>/TECH FOLDER или <phone>/Опросники/Технические файлы лежат
//   Опросник*.json — берём самую первую сделку клиента из amoCRM (oldest by created_at)
//   и кешируем результат;
// - если legacy-данных нет — кешируем null (новый клиент, всё лежит lead-scoped с самого начала).
// На вход — номер уже в формате 7XXXXXXXXXX (normalizePhone).
async function getLegacyOwnerLeadId(phone) {
  if (!phone) return null;
  const cached = legacyOwnersCache.get(phone);
  if (cached) return cached.leadId ? String(cached.leadId) : null;

  let leadId = null;
  try {
    // Проверяем, есть ли вообще legacy-tech-данные
    const legacy1 = await listYandexFolderFiles(`${YANDEX_DISK_ROOT}/${phone}/${TECH_FOLDER_NAME}`);
    const legacy2 = await listYandexFolderFiles(`${YANDEX_DISK_ROOT}/${phone}/Опросники/Технические файлы`);
    const hasLegacy = [...legacy1, ...legacy2].some((n) => /^Опросник.*\.json$/i.test(n));
    if (hasLegacy) {
      // Определяем владельца — самая ранняя сделка клиента
      const leads = await getLeadsByPhone(phone);
      if (leads && leads.length) {
        const sorted = [...leads].sort((a, b) => (a.created_at || 0) - (b.created_at || 0));
        leadId = String(sorted[0].id);
      }
    }
  } catch (e) {
    console.error("getLegacyOwnerLeadId compute error:", e.message);
  }
  legacyOwnersCache.set(phone, { leadId, computedAt: Date.now() });
  saveLegacyOwners();
  return leadId;
}

// Проверяет, что у клиента ВСЕ заявители в рамках КОНКРЕТНОЙ сделки имеют хотя бы
// один загруженный документ в своей папке ФИО на Я.Диске.
// PDF опросника («Опросник - <ФИО>.pdf») не считается «документом» — это автогенерация.
// Возвращает true только если у каждого заявителя из TECH FOLDER этой сделки есть
// хотя бы 1 «реально загруженный» файл.
async function hasUploadedDocsForAllApplicants(phone, leadId) {
  if (!phone || !YANDEX_DISK_TOKEN || !leadId) return false;
  try {
    const techFiles = await listAllTechFiles(phone, leadId);
    const indices = new Set();
    techFiles.forEach((n) => {
      const m = /^Опросник(?:\s+(\d+))?\.json$/i.exec(n);
      if (m) indices.add(parseInt(m[1] || "1", 10));
    });
    if (!indices.size) return false;

    const ownerId = await getLegacyOwnerLeadId(phone);
    const isLegacyOwner = ownerId && String(ownerId) === String(leadId);
    const phoneRoot = `${YANDEX_DISK_ROOT}/${phone}`;
    const leadRoot = leadScopedFolder(phone, leadId);

    for (const idx of indices) {
      const data = await loadApplicantJson(phone, leadId, idx);
      if (!data || !data.fullName) return false;
      const safeFio = sanitizeFileName(String(data.fullName).trim());
      if (!safeFio) return false;

      // Сначала смотрим lead-scoped папку заявителя.
      let files = await listYandexFolderFiles(`${leadRoot}/${safeFio}`);

      // Если пусто И этот лид — legacy owner — пробуем legacy-папку заявителя.
      if ((!files || !files.length) && isLegacyOwner) {
        files = await listYandexFolderFiles(`${phoneRoot}/${safeFio}`);
      }

      const hasRealDoc = (files || []).some((name) => !/^Опросник\s+-\s+.*\.pdf$/i.test(name));
      if (!hasRealDoc) return false;
    }
    return true;
  } catch (e) {
    console.error("hasUploadedDocsForAllApplicants error:", e && e.message);
    return false;
  }
}

// Проверяет триггер «у клиента есть сделка в "Подготовка документов" + опросник
// заполнен + документы загружены для всех заявителей этой сделки».
// Проверка идёт ПО КАЖДОЙ сделке отдельно (lead-scoped), а лимит «1 SMS на номер
// за всё время» — общий по phone. Если несколько сделок одновременно подходят,
// триггерит первая, для которой условия выполнены целиком.
async function maybeSendFeedbackSms(phone, leads) {
  try {
    const normPhone = normalizePhone(phone || "");
    if (!normPhone) return;
    if (wasFeedbackSent(normPhone)) return;
    if (!Array.isArray(leads) || !leads.length) return;

    // Условие #3 — кандидаты: сделки на этапе ЛК «Ожидание подачи» ИЛИ
    // «Рассмотрение». Триггерим SMS на том этапе, на который сделка
    // попала первым. Идемпотентность («не дублировать на обоих этапах»)
    // уже обеспечена markFeedbackSent → wasFeedbackSent: после первой
    // отправки номер в .feedbackSent.json, повторных SMS нет — даже если
    // сделка потом меняет этап туда-обратно.
    const FEEDBACK_TRIGGER_STAGES = new Set(["Ожидание подачи", "Рассмотрение"]);
    const candidates = leads.filter((l) => l && FEEDBACK_TRIGGER_STAGES.has(l.cabinet_status));
    if (!candidates.length) return;

    // Ищем первого кандидата, у которого выполнены условия #1 и #2.
    let triggeredFullName = "";
    let triggeredLeadId = "";
    for (const lead of candidates) {
      const leadId = String(lead.id);
      // Условие #1 — для ЭТОЙ сделки должен быть хотя бы один заполненный опросник.
      const techFiles = await listAllTechFiles(normPhone, leadId);
      const hasAnyJson = techFiles.some((n) => /^Опросник.*\.json$/i.test(n));
      if (!hasAnyJson) continue;
      // Условие #2 — для ЭТОЙ сделки документы должны быть загружены у каждого заявителя.
      const allDocs = await hasUploadedDocsForAllApplicants(normPhone, leadId);
      if (!allDocs) continue;
      // Подходит — берём ФИО первого заявителя для PDF и имени файла.
      const firstQ = await loadApplicantJson(normPhone, leadId, 1);
      triggeredFullName = (firstQ && firstQ.fullName) ? String(firstQ.fullName).trim() : "";
      triggeredLeadId = leadId;
      break;
    }

    if (!triggeredLeadId) {
      console.log(`FEEDBACK skip: phone=${normPhone} — нет сделки, удовлетворяющей всем условиям`);
      return;
    }

    // Помечаем ДО SMS, чтобы при параллельных запросах /api/leads не отправилось дважды.
    markFeedbackSent(normPhone, triggeredFullName);
    const fullName = triggeredFullName;

    const token = createFeedbackToken(normPhone, fullName);
    const link = `https://voyovoyo.ru/feedback?t=${token}`;
    console.log(`FEEDBACK SMS: phone=${normPhone} token=${token} link=${link}`);

    const result = await sms.sendFeedbackLink(normPhone, link);
    if (!result || !result.ok) {
      console.error("FEEDBACK SMS send failed:", result && result.error);
      // Не откатываем флаг: лучше «возможный пропуск» чем риск спама при ретраях.
    }
  } catch (e) {
    console.error("maybeSendFeedbackSms error:", e && e.message);
  }
}

function buildFeedbackHtml(token, fullName) {
  const safeToken = escapeHtml(token);
  const prettyName = formatFioTitleCase(fullName);
  const safeName = escapeHtml(prettyName);
  const q3OptionsHtml = FEEDBACK_Q3_OPTIONS.map((opt) => {
    const safeOpt = escapeHtml(opt);
    return `
            <label class="checkbox-row">
              <input type="checkbox" name="q3" value="${safeOpt}" />
              <span>${safeOpt}</span>
            </label>`;
  }).join("");
  return `<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta name="robots" content="noindex,nofollow" />
  <title>Обратная связь — VOYO</title>
  <link rel="icon" href="/favicon.ico" />
  <style>
    :root { --vsc-ease: cubic-bezier(0.4, 0, 0.2, 1); }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif;
      background: #f3f2f7;
      color: #1d2330;
      padding: 24px 16px 48px;
      min-height: 100vh;
    }
    .brand-bar { max-width: 760px; margin: 8px auto 0; padding: 0 12px; display: flex; justify-content: center; }
    .brand-bar img {
      width: 160px; height: auto; aspect-ratio: 2 / 1; mix-blend-mode: multiply;
      opacity: 0; transform: scale(0.96);
      transition: opacity 0.55s var(--vsc-ease), transform 0.55s var(--vsc-ease);
    }
    .brand-bar img.is-loaded { opacity: 1; transform: scale(1); }
    .wrap {
      max-width: 760px;
      margin: 20px auto 0;
      background: #fff;
      border: 1px solid #ece7f2;
      border-radius: 24px;
      padding: 24px;
      box-shadow: 0 10px 30px rgba(34, 36, 52, 0.05);
    }
    h1 { margin: 0 0 8px; font-size: 24px; line-height: 1.2; color: #171c29; }
    .subtitle { margin: 0 0 22px; font-size: 14px; color: #737988; line-height: 1.5; }
    form { display: grid; gap: 18px; }
    .field { display: grid; gap: 8px; }
    .field > label { font-size: 14px; font-weight: 600; color: #3a4150; }
    .q-text { font-size: 16px; color: #1d2330; line-height: 1.45; margin: 0 0 4px; font-weight: 500; }
    .radio-group { display: grid; gap: 8px; }
    .radio-row {
      display: flex; align-items: center; gap: 10px;
      padding: 12px 14px;
      border: 1px solid #e8e2ee;
      border-radius: 14px;
      cursor: pointer;
      font-size: 15px;
      background: #fff;
      transition: border-color 0.2s var(--vsc-ease), background 0.2s var(--vsc-ease);
    }
    .radio-row:hover { background: #faf9fc; }
    .radio-row input[type="radio"] { width: 18px; height: 18px; accent-color: #3589BD; margin: 0; }
    .radio-row.is-checked { border-color: #3589BD; background: #f0f7fc; }
    .checkbox-row {
      display: flex; align-items: flex-start; gap: 10px;
      padding: 12px 14px;
      border: 1px solid #e8e2ee;
      border-radius: 14px;
      cursor: pointer;
      font-size: 15px;
      background: #fff;
      line-height: 1.4;
      transition: border-color 0.2s var(--vsc-ease), background 0.2s var(--vsc-ease);
    }
    .checkbox-row:hover { background: #faf9fc; }
    .checkbox-row input[type="checkbox"] {
      width: 18px; height: 18px; accent-color: #3589BD; margin: 1px 0 0; flex-shrink: 0;
    }
    .checkbox-row.is-checked { border-color: #3589BD; background: #f0f7fc; }
    textarea {
      width: 100%; min-height: 120px;
      border: 1px solid #e8e2ee;
      border-radius: 14px;
      padding: 12px 14px;
      font-size: 15px;
      font-family: inherit;
      color: #1f2532;
      resize: vertical;
      outline: none;
      transition: border-color 0.2s var(--vsc-ease);
    }
    textarea:focus { border-color: #3589BD; }
    .step-block { display: none; }
    .step-block.show { display: grid; gap: 8px; }
    .submit-btn {
      height: 50px;
      border: 0;
      border-radius: 14px;
      background: #3589BD;
      color: #fff;
      font-size: 16px;
      font-weight: 600;
      cursor: pointer;
      transition: filter 0.2s var(--vsc-ease);
      font-family: inherit;
    }
    .submit-btn:hover { filter: brightness(0.95); }
    .submit-btn:disabled { opacity: 0.6; cursor: progress; }
    .error-msg {
      color: #c4314b;
      font-size: 14px;
      padding: 10px 12px;
      background: #fbebee;
      border: 1px solid #d97a8a;
      border-radius: 12px;
      display: none;
    }
    .error-msg.show { display: block; }
    .success-screen {
      display: none;
      text-align: center;
      padding: 16px 8px 8px;
    }
    .success-screen.show { display: block; }
    .success-screen .check {
      width: 64px; height: 64px; margin: 0 auto 16px;
      border-radius: 50%;
      background: #e6f4eb;
      display: flex; align-items: center; justify-content: center;
      color: #1f7a3f;
      font-size: 32px;
    }
    .success-screen h2 {
      margin: 0;
      font-size: 22px;
      color: #1d2330;
    }
  </style>
</head>
<body>
  <div class="brand-bar">
    <img src="/logo.png" alt="VOYO" width="600" height="300" onload="this.classList.add('is-loaded')" onerror="this.classList.add('is-loaded')" />
  </div>
  <div class="wrap">
    <div id="formBlock">
      <h1>Обратная связь</h1>
      <p class="subtitle">${safeName ? `${safeName}, н` : "Н"}ам важно ваше мнение о работе личного кабинета VOYO. Ответы займут меньше минуты.</p>

      <form id="fbForm">
        <div class="field">
          <p class="q-text">Оказался ли процесс заполнения опросника, сбора и предоставления документов для оформления визы через личный кабинет VOYO для вас удобным?</p>
          <div class="radio-group">
            <label class="radio-row">
              <input type="radio" name="q1" value="Да" />
              <span>Да</span>
            </label>
            <label class="radio-row">
              <input type="radio" name="q1" value="Нет" />
              <span>Нет</span>
            </label>
          </div>
        </div>

        <div class="field step-block" id="stepYes">
          <label for="qYes" class="q-text">Скажите, что вы порекомендовали бы нам улучшить в личном кабинете VOYO?</label>
          <textarea id="qYes" name="qYes" placeholder="Поле необязательное. Можно оставить пустым."></textarea>
        </div>

        <div class="field step-block" id="stepQ3">
          <p class="q-text">Что ещё вы хотели бы видеть в личном кабинете VOYO? <span style="color:#c4314b;">*</span></p>
          <div class="radio-group">${q3OptionsHtml}
          </div>
        </div>

        <div class="field step-block" id="stepNo">
          <label for="qNo" class="q-text">Что было не так?</label>
          <textarea id="qNo" name="qNo" placeholder="Поле необязательное. Можно оставить пустым."></textarea>
        </div>

        <div id="errorBox" class="error-msg"></div>

        <button type="submit" class="submit-btn" id="submitBtn" disabled>Отправить ответы</button>
      </form>
    </div>

    <div id="successBlock" class="success-screen">
      <div class="check">✓</div>
      <h2>Спасибо за вашу обратную связь!</h2>
    </div>
  </div>

  <script>
    (function() {
      const TOKEN = ${JSON.stringify(safeToken)};
      const form = document.getElementById("fbForm");
      const formBlock = document.getElementById("formBlock");
      const successBlock = document.getElementById("successBlock");
      const stepYes = document.getElementById("stepYes");
      const stepQ3  = document.getElementById("stepQ3");
      const stepNo  = document.getElementById("stepNo");
      const submitBtn = document.getElementById("submitBtn");
      const errorBox = document.getElementById("errorBox");
      const radios = Array.from(form.querySelectorAll('input[name="q1"]'));
      const q3Checks = Array.from(form.querySelectorAll('input[name="q3"]'));

      function syncRadioStyles() {
        radios.forEach((r) => {
          const row = r.closest(".radio-row");
          if (!row) return;
          if (r.checked) row.classList.add("is-checked");
          else row.classList.remove("is-checked");
        });
      }

      function syncCheckboxStyles() {
        q3Checks.forEach((c) => {
          const row = c.closest(".checkbox-row");
          if (!row) return;
          if (c.checked) row.classList.add("is-checked");
          else row.classList.remove("is-checked");
        });
      }

      function isYesSelected() {
        const r = radios.find((x) => x.checked);
        return r && r.value === "Да";
      }

      function anyQ3Checked() {
        return q3Checks.some((c) => c.checked);
      }

      function refreshSubmitState() {
        const r = radios.find((x) => x.checked);
        if (!r) { submitBtn.disabled = true; return; }
        if (r.value === "Да") {
          submitBtn.disabled = !anyQ3Checked();
        } else {
          submitBtn.disabled = false;
        }
      }

      radios.forEach((r) => {
        r.addEventListener("change", () => {
          syncRadioStyles();
          if (r.value === "Да" && r.checked) {
            stepYes.classList.add("show");
            stepQ3.classList.add("show");
            stepNo.classList.remove("show");
          } else if (r.value === "Нет" && r.checked) {
            stepNo.classList.add("show");
            stepYes.classList.remove("show");
            stepQ3.classList.remove("show");
          }
          refreshSubmitState();
        });
      });

      q3Checks.forEach((c) => {
        c.addEventListener("change", () => {
          syncCheckboxStyles();
          refreshSubmitState();
        });
      });

      function showError(msg) {
        errorBox.textContent = msg;
        errorBox.classList.add("show");
      }
      function hideError() {
        errorBox.classList.remove("show");
      }

      form.addEventListener("submit", async (e) => {
        e.preventDefault();
        hideError();
        const q1 = radios.find((r) => r.checked);
        if (!q1) {
          showError("Пожалуйста, выберите ответ на первый вопрос.");
          return;
        }
        const q2 = q1.value === "Да"
          ? (document.getElementById("qYes").value || "").trim()
          : (document.getElementById("qNo").value || "").trim();
        let q3 = [];
        if (q1.value === "Да") {
          q3 = q3Checks.filter((c) => c.checked).map((c) => c.value);
          if (!q3.length) {
            showError("Выберите минимум один пункт в последнем вопросе.");
            return;
          }
        }
        submitBtn.disabled = true;
        submitBtn.textContent = "Отправляем...";
        try {
          const r = await fetch("/api/feedback", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ token: TOKEN, q1: q1.value, q2, q3 })
          });
          const data = await r.json().catch(() => ({}));
          if (!r.ok || !data.success) {
            showError(data.message || "Не удалось отправить. Попробуйте позже.");
            submitBtn.disabled = false;
            submitBtn.textContent = "Отправить ответы";
            return;
          }
          formBlock.style.display = "none";
          successBlock.classList.add("show");
        } catch (err) {
          showError("Сетевая ошибка. Проверьте интернет и попробуйте снова.");
          submitBtn.disabled = false;
          submitBtn.textContent = "Отправить ответы";
        }
      });
    })();
  </script>
</body>
</html>`;
}

async function generateFeedbackPdfBuffer({ fullName, phone, q1, q2, q3 }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 50 });
    const chunks = [];
    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const fontPath = getPdfFontPath();
    if (fontPath) doc.font(fontPath);

    doc.fontSize(18).text("Обратная связь — личный кабинет VOYO", { align: "left" });
    doc.moveDown(0.5);
    doc.fontSize(11).text(`Клиент: ${fullName || "—"}`);
    doc.text(`Телефон: ${phone || "—"}`);
    doc.text(`Дата заполнения: ${new Date().toLocaleString("ru-RU")}`);
    doc.moveDown();

    doc.fontSize(12).text(
      "Вопрос 1. Оказался ли процесс заполнения опросника, сбора и предоставления документов для оформления визы через личный кабинет VOYO для вас удобным?",
      { lineGap: 2 }
    );
    doc.moveDown(0.3);
    doc.fontSize(13).fillColor(q1 === "Да" ? "#1f7a3f" : "#c4314b").text(`Ответ: ${q1 || "—"}`);
    doc.fillColor("#000");
    doc.moveDown();

    if (q1 === "Да") {
      doc.fontSize(12).text("Вопрос 2. Скажите, что вы порекомендовали бы нам улучшить в личном кабинете VOYO?", { lineGap: 2 });
    } else if (q1 === "Нет") {
      doc.fontSize(12).text("Вопрос 2. Что было не так?", { lineGap: 2 });
    } else {
      doc.fontSize(12).text("Вопрос 2.", { lineGap: 2 });
    }
    doc.moveDown(0.3);
    doc.fontSize(12).text(`Ответ: ${q2 && q2.trim() ? q2.trim() : "(пусто, клиент не заполнил)"}`);

    // Вопрос 3 — только если ответ на Q1 «Да».
    if (q1 === "Да") {
      doc.moveDown();
      doc.fontSize(12).text("Вопрос 3. Что ещё вы хотели бы видеть в личном кабинете VOYO?", { lineGap: 2 });
      doc.moveDown(0.3);
      const selected = Array.isArray(q3) ? q3 : [];
      if (selected.length) {
        selected.forEach((opt) => {
          doc.fontSize(12).text(`• ${opt}`, { lineGap: 1, indent: 6 });
        });
      } else {
        doc.fontSize(12).text("(пусто)");
      }
    }

    doc.end();
  });
}

// Возвращает безопасное имя файла для PDF: «<ФИО>.pdf», при коллизиях — «<ФИО> (2).pdf» и т.д.
async function pickFeedbackPdfName(safeFio) {
  const base = safeFio || "Без имени";
  const existing = await listYandexFolderFiles(FEEDBACK_DISK_FOLDER);
  const baseFile = `${base}.pdf`;
  if (!existing.includes(baseFile)) return baseFile;
  for (let i = 2; i < 100; i++) {
    const candidate = `${base} (${i}).pdf`;
    if (!existing.includes(candidate)) return candidate;
  }
  // Краевой случай — добавим timestamp
  return `${base} - ${new Date().toISOString().replace(/[:T]/g, "-").slice(0, 19)}.pdf`;
}

app.get("/feedback", (req, res) => {
  const token = String((req.query && req.query.t) || "").trim();
  const data = getFeedbackToken(token);
  if (!data) {
    res.status(404).send(
      `<!DOCTYPE html><html lang="ru"><head><meta charset="UTF-8" /><title>Ссылка не найдена</title>` +
      `<style>body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;background:#f3f2f7;color:#1d2330;padding:48px 24px;text-align:center;}` +
      `.box{max-width:560px;margin:0 auto;background:#fff;border:1px solid #ece7f2;border-radius:24px;padding:32px;}h1{margin:0 0 8px;font-size:22px;}</style></head>` +
      `<body><div class="box"><h1>Ссылка не найдена</h1><p>Возможно, опрос уже был заполнен или ссылка устарела.</p></div></body></html>`
    );
    return;
  }
  // Учитываем переход по ссылке (для статистики «Опросники» в админке).
  try { recordFeedbackClick(data.phone); } catch (_) {}
  res.send(buildFeedbackHtml(data.token, data.fullName));
});

app.post("/api/feedback", async (req, res) => {
  try {
    const token = String((req.body && req.body.token) || "").trim();
    const q1 = String((req.body && req.body.q1) || "").trim();
    const q2 = String((req.body && req.body.q2) || "").trim();
    const q3Raw = (req.body && req.body.q3) || [];
    // Принимаем только значения из строго заданного списка (FEEDBACK_Q3_OPTIONS) —
    // отсекаем любые посторонние варианты, которые могли прийти при подделке запроса.
    const q3 = (Array.isArray(q3Raw) ? q3Raw : [])
      .map((v) => String(v || "").trim())
      .filter((v) => FEEDBACK_Q3_OPTIONS.includes(v));

    const data = getFeedbackToken(token);
    if (!data) {
      return res.status(404).json({ success: false, message: "Ссылка устарела или уже использована" });
    }
    if (q1 !== "Да" && q1 !== "Нет") {
      return res.status(400).json({ success: false, message: "Выберите ответ на первый вопрос" });
    }
    // Если ответили «Да» — на 3-м вопросе должен быть выбран хотя бы 1 пункт.
    if (q1 === "Да" && q3.length === 0) {
      return res.status(400).json({
        success: false,
        message: "Выберите минимум один пункт в последнем вопросе"
      });
    }

    // ФИО в Title Case (как в ЛК) — попадает и в PDF, и в имя файла.
    const fullName = formatFioTitleCase(data.fullName) || "Клиент VOYO";
    const phone = data.phone || "";

    // 1. PDF
    const pdfBuffer = await generateFeedbackPdfBuffer({ fullName, phone, q1, q2, q3 });

    // 2. Папка на Я.Диске
    await ensureNestedYandexFolder(FEEDBACK_DISK_FOLDER);

    // 3. Имя файла с защитой от коллизий
    const safeFio = sanitizeFileName(fullName) || "Без имени";
    const fileName = await pickFeedbackPdfName(safeFio);
    const diskPath = `${FEEDBACK_DISK_FOLDER}/${fileName}`;

    await uploadBufferToYandexDisk(pdfBuffer, diskPath, "application/pdf");
    console.log(`FEEDBACK PDF saved: ${diskPath}`);

    // 4. Удаляем токен — повторно использовать нельзя.
    //    Ссылка из SMS сразу перестаёт работать (GET /feedback вернёт 404).
    feedbackTokens.delete(token);
    saveFeedbackTokens();

    // 5. Учитываем отправку в воронке «Опросники» админки.
    try { recordFeedbackSubmission(phone, fullName, fileName); } catch (_) {}

    return res.json({ success: true });
  } catch (e) {
    console.error("POST /api/feedback error:", e.response?.data || e.message);
    return res.status(500).json({ success: false, message: "Ошибка сохранения. Попробуйте позже." });
  }
});

// ──────────────────────────────────────────────────────────
// WebAuthn — вход по биометрии (Face ID / Touch ID / Windows Hello)
// ──────────────────────────────────────────────────────────
const webauthn = require("@simplewebauthn/server");

const WEBAUTHN_RP_NAME = "VOYO";
const WEBAUTHN_RP_ID = process.env.WEBAUTHN_RP_ID || "voyovoyo.ru";
const WEBAUTHN_ORIGIN = process.env.WEBAUTHN_ORIGIN || "https://voyovoyo.ru";

const PASSKEYS_FILE = path.join(__dirname, ".passkeys.json");
const passkeysByPhone = new Map();
const webauthnChallenges = new Map();
const WEBAUTHN_CHALLENGE_TTL_MS = 5 * 60 * 1000;

function loadPasskeys() {
  try {
    const raw = fs.readFileSync(PASSKEYS_FILE, "utf8");
    const obj = JSON.parse(raw);
    if (obj && typeof obj === "object") {
      Object.keys(obj).forEach((phone) => {
        if (Array.isArray(obj[phone])) passkeysByPhone.set(phone, obj[phone]);
      });
    }
  } catch (_) {}
}
function savePasskeys() {
  try {
    const obj = {};
    for (const [phone, arr] of passkeysByPhone.entries()) obj[phone] = arr;
    fs.writeFileSync(PASSKEYS_FILE, JSON.stringify(obj, null, 2), "utf8");
  } catch (e) {
    console.error("savePasskeys error:", e.message);
  }
}
function setWebauthnChallenge(phone, challenge, type) {
  webauthnChallenges.set(phone, { challenge, type, expiresAt: Date.now() + WEBAUTHN_CHALLENGE_TTL_MS });
}
function getWebauthnChallenge(phone, type) {
  const c = webauthnChallenges.get(phone);
  if (!c || c.type !== type) return null;
  if (Date.now() > c.expiresAt) { webauthnChallenges.delete(phone); return null; }
  return c.challenge;
}
function clearWebauthnChallenge(phone) { webauthnChallenges.delete(phone); }

function b64uFromBuffer(buf) { return Buffer.from(buf).toString("base64url"); }
function bufferFromB64u(s) { return Buffer.from(String(s || ""), "base64url"); }

loadPasskeys();

app.post("/api/auth/webauthn/has-credentials", (req, res) => {
  try {
    const phone = sms.normalizePhone((req.body && req.body.phone) || "");
    if (!phone) return res.json({ hasCredentials: false });
    const arr = passkeysByPhone.get(phone) || [];
    return res.json({ hasCredentials: arr.length > 0 });
  } catch (_) {
    return res.json({ hasCredentials: false });
  }
});

app.post("/api/auth/webauthn/register-options", async (req, res) => {
  try {
    const phone = sms.normalizePhone((req.body && req.body.phone) || "");
    if (!phone || phone.length < 11) {
      return res.status(400).json({ success: false, message: "Некорректный номер" });
    }
    const existing = passkeysByPhone.get(phone) || [];
    const options = await webauthn.generateRegistrationOptions({
      rpName: WEBAUTHN_RP_NAME,
      rpID: WEBAUTHN_RP_ID,
      userID: phone,
      userName: phone,
      userDisplayName: "+" + phone,
      attestationType: "none",
      excludeCredentials: existing.map((c) => ({
        id: bufferFromB64u(c.credentialID),
        type: "public-key",
      })),
      authenticatorSelection: {
        residentKey: "preferred",
        userVerification: "preferred",
      },
    });
    setWebauthnChallenge(phone, options.challenge, "register");
    return res.json(options);
  } catch (err) {
    console.error("WEBAUTHN REGISTER OPTIONS:", err.message);
    return res.status(500).json({ success: false, message: err.message });
  }
});

app.post("/api/auth/webauthn/register-verify", async (req, res) => {
  try {
    const phone = sms.normalizePhone((req.body && req.body.phone) || "");
    const attestationResponse = req.body && req.body.attestationResponse;
    if (!phone || !attestationResponse) {
      return res.status(400).json({ success: false, message: "Невалидный запрос" });
    }
    const expectedChallenge = getWebauthnChallenge(phone, "register");
    if (!expectedChallenge) {
      return res.status(400).json({ success: false, message: "Регистрация просрочена" });
    }
    const verification = await webauthn.verifyRegistrationResponse({
      response: attestationResponse,
      expectedChallenge,
      expectedOrigin: WEBAUTHN_ORIGIN,
      expectedRPID: WEBAUTHN_RP_ID,
      requireUserVerification: false,
    });
    if (!verification.verified || !verification.registrationInfo) {
      clearWebauthnChallenge(phone);
      return res.status(400).json({ success: false, message: "Проверка не прошла" });
    }
    const info = verification.registrationInfo;
    const newCredential = {
      credentialID: b64uFromBuffer(info.credentialID),
      publicKey: b64uFromBuffer(info.credentialPublicKey),
      counter: info.counter || 0,
      createdAt: Date.now(),
    };
    const arr = passkeysByPhone.get(phone) || [];
    arr.push(newCredential);
    passkeysByPhone.set(phone, arr);
    savePasskeys();
    clearWebauthnChallenge(phone);
    return res.json({ success: true });
  } catch (err) {
    console.error("WEBAUTHN REGISTER VERIFY:", err.message);
    return res.status(500).json({ success: false, message: err.message });
  }
});

app.post("/api/auth/webauthn/auth-options", async (req, res) => {
  try {
    const phone = sms.normalizePhone((req.body && req.body.phone) || "");
    if (!phone) return res.status(400).json({ success: false, message: "Не передан номер" });
    const arr = passkeysByPhone.get(phone) || [];
    if (arr.length === 0) {
      return res.status(404).json({ success: false, message: "Нет зарегистрированных passkey" });
    }
    const options = await webauthn.generateAuthenticationOptions({
      rpID: WEBAUTHN_RP_ID,
      allowCredentials: arr.map((c) => ({
        id: bufferFromB64u(c.credentialID),
        type: "public-key",
      })),
      userVerification: "preferred",
    });
    setWebauthnChallenge(phone, options.challenge, "auth");
    return res.json(options);
  } catch (err) {
    console.error("WEBAUTHN AUTH OPTIONS:", err.message);
    return res.status(500).json({ success: false, message: err.message });
  }
});

app.post("/api/auth/webauthn/auth-verify", async (req, res) => {
  try {
    const phone = sms.normalizePhone((req.body && req.body.phone) || "");
    const assertionResponse = req.body && req.body.assertionResponse;
    if (!phone || !assertionResponse) {
      return res.status(400).json({ success: false, message: "Невалидный запрос" });
    }
    const expectedChallenge = getWebauthnChallenge(phone, "auth");
    if (!expectedChallenge) {
      return res.status(400).json({ success: false, message: "Сессия просрочена" });
    }
    const arr = passkeysByPhone.get(phone) || [];
    const cred = arr.find((c) => c.credentialID === assertionResponse.id);
    if (!cred) {
      return res.status(404).json({ success: false, message: "Passkey не найден" });
    }
    const verification = await webauthn.verifyAuthenticationResponse({
      response: assertionResponse,
      expectedChallenge,
      expectedOrigin: WEBAUTHN_ORIGIN,
      expectedRPID: WEBAUTHN_RP_ID,
      authenticator: {
        credentialID: bufferFromB64u(cred.credentialID),
        credentialPublicKey: bufferFromB64u(cred.publicKey),
        counter: cred.counter || 0,
      },
      requireUserVerification: false,
    });
    if (!verification.verified) {
      clearWebauthnChallenge(phone);
      return res.status(400).json({ success: false, message: "Подпись не прошла" });
    }
    cred.counter = verification.authenticationInfo.newCounter;
    savePasskeys();
    clearWebauthnChallenge(phone);
    setClientSessionCookie(res, phone); // ФАЗА 1: сессия после Face ID по номеру
    try { recordLkAuth(phone); } catch (_) {}
    return res.json({ success: true, phone });
  } catch (err) {
    console.error("WEBAUTHN AUTH VERIFY:", err.message);
    return res.status(500).json({ success: false, message: err.message });
  }
});

// ──────────────────────────────────────────────────────────
// WebAuthn клиентский — «anonymous» поток для экрана входа на «/».
// Симметрия с админкой: страница «/» не знает номер телефона до момента
// аутентификации, но если на сервере вообще есть зарегистрированный
// passkey — мы показываем системный диалог Face ID/Touch ID, ОС сама
// выбирает подходящий passkey среди allowCredentials (это весь набор
// passkey'ев со всех phones), а сервер при verify ищет phone по credentialID
// и возвращает его клиенту → /cabinet?phone=<resolved>.
// Per-phone эндпоинты (has-credentials/auth-options/auth-verify) сохранены —
// они нужны в потоке регистрации passkey'я после SMS-входа и проч.
// ──────────────────────────────────────────────────────────
const anonWebauthnState = { challenge: null, expiresAt: 0 };
function setAnonChallenge(c) {
  anonWebauthnState.challenge = c;
  anonWebauthnState.expiresAt = Date.now() + WEBAUTHN_CHALLENGE_TTL_MS;
}
function getAnonChallenge() {
  if (!anonWebauthnState.challenge) return null;
  if (Date.now() > anonWebauthnState.expiresAt) {
    anonWebauthnState.challenge = null;
    return null;
  }
  return anonWebauthnState.challenge;
}
function clearAnonChallenge() {
  anonWebauthnState.challenge = null;
  anonWebauthnState.expiresAt = 0;
}

// 1) Есть ли НА СЕРВЕРЕ вообще хоть один зарегистрированный passkey?
//    Публичный эндпоинт — клиент по нему решает, дёргать ли авто-prompt
//    Face ID и показывать ли кнопку «Войти по Face ID / отпечатку».
app.get("/api/auth/webauthn/any-credentials", (req, res) => {
  let any = false;
  for (const arr of passkeysByPhone.values()) {
    if (Array.isArray(arr) && arr.length > 0) { any = true; break; }
  }
  return res.json({ hasCredentials: any });
});

// 2) Опции для аутентификации без знания phone'а. allowCredentials —
//    все известные credential ID со всех phones; ОС покажет пользователю
//    подходящий из доступных на устройстве (iCloud Keychain / Google
//    Password Manager). Публичный эндпоинт.
app.post("/api/auth/webauthn/auth-options-any", async (req, res) => {
  try {
    const allowCredentials = [];
    for (const arr of passkeysByPhone.values()) {
      if (!Array.isArray(arr)) continue;
      for (const c of arr) {
        if (!c || !c.credentialID) continue;
        allowCredentials.push({
          id: bufferFromB64u(c.credentialID),
          type: "public-key"
        });
      }
    }
    if (!allowCredentials.length) {
      return res.status(404).json({ success: false, message: "Нет зарегистрированных passkey" });
    }
    const options = await webauthn.generateAuthenticationOptions({
      rpID: WEBAUTHN_RP_ID,
      allowCredentials,
      userVerification: "preferred"
    });
    setAnonChallenge(options.challenge);
    return res.json(options);
  } catch (err) {
    console.error("WEBAUTHN AUTH-OPTIONS-ANY:", err.message);
    return res.status(500).json({ success: false, message: err.message });
  }
});

// 3) Верификация подписи. На вход — только assertionResponse без phone.
//    Сервер ищет phone по credentialID в passkeysByPhone, проверяет подпись
//    стандартным verifyAuthenticationResponse и возвращает phone клиенту.
app.post("/api/auth/webauthn/auth-verify-any", async (req, res) => {
  try {
    const assertionResponse = req.body && req.body.assertionResponse;
    if (!assertionResponse || !assertionResponse.id) {
      return res.status(400).json({ success: false, message: "Невалидный запрос" });
    }
    const expectedChallenge = getAnonChallenge();
    if (!expectedChallenge) {
      return res.status(400).json({ success: false, message: "Сессия просрочена" });
    }
    // Найти phone и кредитку по credentialID.
    let foundPhone = null;
    let foundCred = null;
    for (const [phone, arr] of passkeysByPhone.entries()) {
      if (!Array.isArray(arr)) continue;
      for (const c of arr) {
        if (c && c.credentialID === assertionResponse.id) {
          foundPhone = phone;
          foundCred = c;
          break;
        }
      }
      if (foundPhone) break;
    }
    if (!foundPhone || !foundCred) {
      clearAnonChallenge();
      return res.status(404).json({ success: false, message: "Passkey не найден" });
    }
    const verification = await webauthn.verifyAuthenticationResponse({
      response: assertionResponse,
      expectedChallenge,
      expectedOrigin: WEBAUTHN_ORIGIN,
      expectedRPID: WEBAUTHN_RP_ID,
      authenticator: {
        credentialID: bufferFromB64u(foundCred.credentialID),
        credentialPublicKey: bufferFromB64u(foundCred.publicKey),
        counter: foundCred.counter || 0,
      },
      requireUserVerification: false,
    });
    if (!verification.verified) {
      clearAnonChallenge();
      return res.status(400).json({ success: false, message: "Подпись не прошла" });
    }
    foundCred.counter = verification.authenticationInfo.newCounter;
    savePasskeys();
    clearAnonChallenge();
    setClientSessionCookie(res, foundPhone); // ФАЗА 1: сессия после Face ID кнопкой
    try { recordLkAuth(foundPhone); } catch (_) {}
    return res.json({ success: true, phone: foundPhone });
  } catch (err) {
    console.error("WEBAUTHN AUTH-VERIFY-ANY:", err.message);
    return res.status(500).json({ success: false, message: err.message });
  }
});

// ──────────────────────────────────────────────────────────
// WebAuthn для админки (/admin). Биометрия / passkey.
// Одиночный «пользователь» — единственный админ. Несколько устройств можно
// прописать — каждое получит свой credential. Регистрировать можно только
// после успешного входа по коду (требует admin-токен).
// ──────────────────────────────────────────────────────────
const ADMIN_PASSKEYS_FILE = path.join(__dirname, ".adminPasskeys.json");
const adminPasskeys = []; // [{ credentialID, publicKey, counter, createdAt }]
const adminWebauthnChallenges = new Map(); // ключ всегда "admin" — единственная активная challenge.
const ADMIN_WEBAUTHN_USER_NAME = "voyo-admin";
const ADMIN_WEBAUTHN_USER_DISPLAY = "VOYO Admin";

function loadAdminPasskeys() {
  try {
    const raw = fs.readFileSync(ADMIN_PASSKEYS_FILE, "utf8");
    const arr = JSON.parse(raw);
    if (Array.isArray(arr)) {
      adminPasskeys.splice(0, adminPasskeys.length, ...arr);
    }
  } catch (_) {}
}
function saveAdminPasskeys() {
  try {
    fs.writeFileSync(ADMIN_PASSKEYS_FILE, JSON.stringify(adminPasskeys, null, 2), "utf8");
  } catch (e) {
    console.error("saveAdminPasskeys error:", e.message);
  }
}
function setAdminChallenge(challenge, type) {
  adminWebauthnChallenges.set("admin", {
    challenge,
    type,
    expiresAt: Date.now() + WEBAUTHN_CHALLENGE_TTL_MS
  });
}
function getAdminChallenge(type) {
  const c = adminWebauthnChallenges.get("admin");
  if (!c || c.type !== type) return null;
  if (Date.now() > c.expiresAt) {
    adminWebauthnChallenges.delete("admin");
    return null;
  }
  return c.challenge;
}
function clearAdminChallenge() { adminWebauthnChallenges.delete("admin"); }

loadAdminPasskeys();

// 1) Есть ли вообще зарегистрированный admin-passkey? Публичный эндпоинт —
//    клиент решает, показать ли кнопку «Войти по Face ID».
app.get("/admin/api/webauthn/has-credentials", (req, res) => {
  return res.json({ hasCredentials: adminPasskeys.length > 0 });
});

// 2) Опции для аутентификации (Face ID без кода). Публично.
app.post("/admin/api/webauthn/auth-options", async (req, res) => {
  try {
    if (!adminPasskeys.length) {
      return res.status(404).json({ success: false, message: "Нет зарегистрированных passkey" });
    }
    const options = await webauthn.generateAuthenticationOptions({
      rpID: WEBAUTHN_RP_ID,
      allowCredentials: adminPasskeys.map((c) => ({
        id: bufferFromB64u(c.credentialID),
        type: "public-key"
      })),
      userVerification: "preferred"
    });
    setAdminChallenge(options.challenge, "auth");
    return res.json(options);
  } catch (err) {
    console.error("ADMIN WEBAUTHN AUTH OPTIONS:", err.message);
    return res.status(500).json({ success: false, message: err.message });
  }
});

// 3) Верификация ответа passkey'я. При успехе — выдаём admin-токен (24 часа).
app.post("/admin/api/webauthn/auth-verify", async (req, res) => {
  try {
    const assertionResponse = req.body && req.body.assertionResponse;
    if (!assertionResponse) {
      return res.status(400).json({ success: false, message: "Невалидный запрос" });
    }
    const expectedChallenge = getAdminChallenge("auth");
    if (!expectedChallenge) {
      return res.status(400).json({ success: false, message: "Сессия просрочена" });
    }
    const cred = adminPasskeys.find((c) => c.credentialID === assertionResponse.id);
    if (!cred) {
      return res.status(404).json({ success: false, message: "Passkey не найден" });
    }
    const verification = await webauthn.verifyAuthenticationResponse({
      response: assertionResponse,
      expectedChallenge,
      expectedOrigin: WEBAUTHN_ORIGIN,
      expectedRPID: WEBAUTHN_RP_ID,
      authenticator: {
        credentialID: bufferFromB64u(cred.credentialID),
        credentialPublicKey: bufferFromB64u(cred.publicKey),
        counter: cred.counter || 0
      },
      requireUserVerification: false
    });
    if (!verification.verified) {
      clearAdminChallenge();
      return res.status(400).json({ success: false, message: "Подпись не прошла" });
    }
    cred.counter = verification.authenticationInfo.newCounter;
    saveAdminPasskeys();
    clearAdminChallenge();
    const token = createAdminSession();
    return res.json({ success: true, token, expiresInSec: Math.floor(ADMIN_SESSION_TTL_MS / 1000) });
  } catch (err) {
    console.error("ADMIN WEBAUTHN AUTH VERIFY:", err.message);
    return res.status(500).json({ success: false, message: err.message });
  }
});

// 4) Опции для регистрации нового passkey'я. Требует admin-токен —
//    регистрировать биометрию может только уже залогиненный по коду админ.
app.post("/admin/api/webauthn/register-options", requireAdmin, async (req, res) => {
  try {
    const options = await webauthn.generateRegistrationOptions({
      rpName: WEBAUTHN_RP_NAME,
      rpID: WEBAUTHN_RP_ID,
      userID: ADMIN_WEBAUTHN_USER_NAME,
      userName: ADMIN_WEBAUTHN_USER_NAME,
      userDisplayName: ADMIN_WEBAUTHN_USER_DISPLAY,
      attestationType: "none",
      excludeCredentials: adminPasskeys.map((c) => ({
        id: bufferFromB64u(c.credentialID),
        type: "public-key"
      })),
      authenticatorSelection: {
        residentKey: "preferred",
        userVerification: "preferred"
      }
    });
    setAdminChallenge(options.challenge, "register");
    return res.json(options);
  } catch (err) {
    console.error("ADMIN WEBAUTHN REGISTER OPTIONS:", err.message);
    return res.status(500).json({ success: false, message: err.message });
  }
});

// 5) Верификация регистрации. Требует admin-токен. После успеха —
//    credential сохраняется в .adminPasskeys.json.
app.post("/admin/api/webauthn/register-verify", requireAdmin, async (req, res) => {
  try {
    const attestationResponse = req.body && req.body.attestationResponse;
    if (!attestationResponse) {
      return res.status(400).json({ success: false, message: "Невалидный запрос" });
    }
    const expectedChallenge = getAdminChallenge("register");
    if (!expectedChallenge) {
      return res.status(400).json({ success: false, message: "Регистрация просрочена" });
    }
    const verification = await webauthn.verifyRegistrationResponse({
      response: attestationResponse,
      expectedChallenge,
      expectedOrigin: WEBAUTHN_ORIGIN,
      expectedRPID: WEBAUTHN_RP_ID,
      requireUserVerification: false
    });
    if (!verification.verified || !verification.registrationInfo) {
      clearAdminChallenge();
      return res.status(400).json({ success: false, message: "Проверка не прошла" });
    }
    const info = verification.registrationInfo;
    adminPasskeys.push({
      credentialID: b64uFromBuffer(info.credentialID),
      publicKey: b64uFromBuffer(info.credentialPublicKey),
      counter: info.counter || 0,
      createdAt: Date.now()
    });
    saveAdminPasskeys();
    clearAdminChallenge();
    return res.json({ success: true });
  } catch (err) {
    console.error("ADMIN WEBAUTHN REGISTER VERIFY:", err.message);
    return res.status(500).json({ success: false, message: err.message });
  }
});

app.get("/questionnaire-start", async (req, res) => {
  try {
    const phone = normalizePhone(req.query.phone || "");
    const leadId = String(req.query.leadId || "").trim();

    if (!phone || !leadId) {
      return res.status(400).send("Не переданы phone или leadId");
    }

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.send(buildQuestionnaireStartHtml({ phone, leadId }));
  } catch (error) {
    console.error("GET /questionnaire-start error:", error.response?.data || error.message);
    return res.status(500).send("Ошибка при открытии опросника");
  }
});

app.get("/questionnaire", async (req, res) => {
  try {
    // Share-режим: ссылка отправлена по SMS, всё контекстное берём из токена
    const shareTokenParam = String(req.query.share || "").trim();
    const shareData = shareTokenParam ? getShareToken(shareTokenParam) : null;
    if (shareTokenParam && !shareData) {
      return res.status(404).send("Ссылка устарела или недействительна. Запросите новую ссылку у заказчика.");
    }

    const phone = shareData
      ? normalizePhone(shareData.phone || "")
      : normalizePhone(req.query.phone || "");
    const leadId = shareData
      ? String(shareData.leadId || "").trim()
      : String(req.query.leadId || "").trim();
    const applicantIndex = shareData
      ? 1
      : Math.max(1, Math.min(10, parseInt(req.query.applicantIndex || "1", 10) || 1));
    const totalApplicants = shareData
      ? 1
      : Math.max(applicantIndex, Math.min(10, parseInt(req.query.totalApplicants || "1", 10) || 1));
    const prevApplicantName = shareData ? "" : String(req.query.prevApplicantName || "").trim();
    const isEdit = shareData ? false : String(req.query.edit || "") === "1";
    const applicantCount = shareData
      ? 0
      : Math.max(0, Math.min(10, parseInt(req.query.applicantCount || "0", 10) || 0));
    const visaType = shareData
      ? String(shareData.visaType || "").trim()
      : String(req.query.visaType || "").trim();

    // Mixed-режим: клиент сам заполняет часть опросников, остальное уходит по SMS
    const isMixed = !shareData && String(req.query.mixed || "") === "1";
    const selfFillCount = isMixed
      ? Math.max(1, Math.min(10, parseInt(req.query.selfFillCount || "0", 10) || 0))
      : 0;
    const selfStep = isMixed
      ? Math.max(1, Math.min(10, parseInt(req.query.selfStep || "1", 10) || 1))
      : 0;

    if (!phone || !leadId) {
      return res.status(400).send("Не переданы phone или leadId");
    }

    // Первый заявитель без applicantCount — перенаправляем на стартовую страницу выбора визы и количества
    if (!shareData && !isEdit && applicantIndex === 1 && !applicantCount) {
      const params = new URLSearchParams({ phone, leadId });
      return res.redirect("/questionnaire-start?" + params.toString());
    }

    if (!AMO_SUBDOMAIN || !AMO_ACCESS_TOKEN) {
      return res.status(500).send("Не настроены переменные amoCRM");
    }

    const baseUrl = `https://${AMO_SUBDOMAIN}.amocrm.ru`;
    const lead = await getLeadById(baseUrl, leadId);

    if (!lead?.id) {
      return res.status(404).send("Сделка не найдена");
    }

    const countryService = getCustomFieldValue(lead, "Страна оформления/услуга") || "не указано";

    let prefill = null;
    let effectiveTotal = totalApplicants;
    if (isEdit && YANDEX_DISK_TOKEN) {
      try {
        prefill = await loadApplicantJson(phone, leadId, applicantIndex);
      } catch (err) {
        console.error("EDIT prefill load error:", err.message);
      }
      // Сохраняем общее количество заявителей из первого опросника
      if (applicantIndex !== 1) {
        try {
          const firstState = await loadApplicantJson(phone, leadId, 1);
          const fromFirst = parseInt(firstState && firstState.totalApplicants, 10);
          if (fromFirst > 0) effectiveTotal = Math.max(applicantIndex, fromFirst);
        } catch (_) {}
      } else if (prefill && prefill.totalApplicants) {
        const fromPrefill = parseInt(prefill.totalApplicants, 10);
        if (fromPrefill > 0) effectiveTotal = fromPrefill;
      }
    }

    // visaType: из URL, либо из сохранённого state (для edit / 2+ заявителя)
    const effectiveVisaType = visaType || (prefill && prefill.visaType) || "";

    // ФИО уже заполненных заявителей В РАМКАХ ЭТОЙ СДЕЛКИ — для блокировки дубликатов на клиенте.
    const existingFios = await getExistingApplicantFios(phone, leadId);

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    // Диспатч по типу визы: для Японии — отдельная функция, для остального — общий шенгенский шаблон.
    const builder = (effectiveVisaType === "Виза в Японию")
      ? buildJapanQuestionnaireHtml
      : buildQuestionnaireHtml;
    return res.send(builder({
      phone,
      leadId,
      countryService,
      applicantIndex,
      totalApplicants: effectiveTotal,
      prevApplicantName,
      prefill,
      isEdit,
      applicantCount,
      visaType: effectiveVisaType,
      shareToken: shareData ? shareData.token : "",
      isMixed,
      selfFillCount,
      selfStep,
      existingFios
    }));
  } catch (error) {
    console.error("GET /questionnaire error:", error.response?.data || error.message);
    return res.status(500).send("Ошибка при открытии опросника");
  }
});

app.post(
  "/api/questionnaire",
  upload.none(),
  async (req, res) => {
    try {
      let fullName = String(req.body.fullName || "").trim();
      const shareTokenInput = String(req.body.shareToken || "").trim();
      const shareData = shareTokenInput ? getShareToken(shareTokenInput) : null;
      if (shareTokenInput && !shareData) {
        return res.status(400).json({ success: false, message: "Ссылка устарела или недействительна" });
      }
      const isShareMode = !!shareData;

      const phone = isShareMode
        ? normalizePhone(shareData.phone || "")
        : normalizePhone(req.body.phone || "");
      const leadId = isShareMode
        ? String(shareData.leadId || "").trim()
        : String(req.body.leadId || "").trim();

      // Case-insensitive выравнивание ФИО к УЖЕ существующему заявителю —
      // pre-applicant'у или нормальному. Сценарий: клиент через модал
      // ввёл «Иванов Иван Иванович» и загрузил паспорта в папку
      // `<phone>/<leadId>/Иванов Иван Иванович/`. Потом в опроснике указал
      // «Иванов Иван ивановиЧ» (другой регистр). Без выравнивания мы
      // создадим вторую папку с другим регистром, файлы старого pre-applicant
      // не подтянутся, клиент увидит «загрузите паспорта снова». Берём
      // ОРИГИНАЛЬНОЕ написание (из pre-applicant или из существующего
      // applicant'а) как canonical и работаем дальше уже с ним
      // (в state.fullName, safeFio, applicantFolder).
      if (phone && leadId && fullName) {
        try {
          const norm = normalizeFioForCompare(fullName);
          let canon = null;
          const preList = await loadPreApplicants(phone, leadId);
          const matchPre = preList.find((p) => normalizeFioForCompare(p.fullName) === norm);
          if (matchPre) canon = matchPre.fullName;
          if (!canon) {
            const existing = await getExistingApplicantFios(phone, leadId);
            const matchEx = existing.find((e) => normalizeFioForCompare(e.fullName) === norm);
            if (matchEx) canon = matchEx.fullName;
          }
          if (canon && canon !== fullName) {
            console.log(`QUESTIONNAIRE: aligning fullName "${fullName}" → "${canon}" (canonical case)`);
            fullName = canon;
          }
        } catch (_) {}
      }

      const isEdit = !isShareMode && String(req.body.isEdit || "") === "1";
      const isMixed = !isShareMode && !isEdit && String(req.body.mixed || "") === "1";
      const selfFillCount = isMixed
        ? Math.max(1, Math.min(10, parseInt(req.body.selfFillCount || "0", 10) || 0))
        : 0;
      const selfStep = isMixed
        ? Math.max(1, Math.min(10, parseInt(req.body.selfStep || "1", 10) || 1))
        : 0;

      // applicantIndex и totalApplicants:
      // - share-режим:   first-free; total = max(idx, applicantCount из токена)
      // - mixed-режим:   first-free; total = max(idx, applicantCount из формы)
      // - обычный режим: как раньше — берётся из формы
      let applicantIndex;
      let totalApplicants;

      const applicantCountRaw = Math.max(1, Math.min(10, parseInt(req.body.applicantCount || "0", 10) || 0));

      if (isShareMode) {
        applicantIndex = await getNextApplicantIndex(phone, leadId);
        totalApplicants = Math.max(applicantIndex, parseInt(shareData.applicantCount, 10) || 1);
      } else if (isMixed) {
        if (!applicantCountRaw) {
          return res.status(400).json({
            success: false,
            message: "Не указано количество заявителей"
          });
        }
        applicantIndex = await getNextApplicantIndex(phone, leadId);
        totalApplicants = Math.max(applicantIndex, applicantCountRaw);
      } else {
        applicantIndex = Math.max(1, Math.min(10, parseInt(req.body.applicantIndex || "1", 10) || 1));
        const incomingTotal = Math.max(1, Math.min(10, parseInt(req.body.totalApplicants || "0", 10) || 0));
        totalApplicants = isEdit
          ? Math.max(applicantIndex, incomingTotal)
          : (applicantIndex === 1
              ? Math.max(1, applicantCountRaw)
              : Math.max(applicantIndex, incomingTotal));

        if (!isEdit && applicantIndex === 1 && !applicantCountRaw) {
          return res.status(400).json({
            success: false,
            message: "Не указано количество заявителей"
          });
        }
      }

      if (!phone || !leadId || !fullName) {
        return res.status(400).json({
          success: false,
          message: "Заполнены не все обязательные поля опросника"
        });
      }

      // Серверная страховка от дубликата ФИО внутри одной сделки (на случай обхода клиентской валидации).
      try {
        const existingFios = await getExistingApplicantFios(phone, leadId);
        const wanted = normalizeFioForCompare(fullName);
        const conflict = existingFios.find((it) => {
          if (!it || !it.fullName) return false;
          if (parseInt(it.idx, 10) === applicantIndex) return false; // своё ФИО в edit-режиме разрешено
          return normalizeFioForCompare(it.fullName) === wanted;
        });
        if (conflict) {
          return res.status(409).json({
            success: false,
            message: "Опросник на это ФИО уже заполнен в этой сделке. Укажите другое ФИО."
          });
        }
      } catch (e) {
        console.error("POST /api/questionnaire fio dup check error:", e.message);
      }

      if (!AMO_SUBDOMAIN || !AMO_ACCESS_TOKEN) {
        return res.status(500).json({
          success: false,
          message: "Не настроены переменные amoCRM"
        });
      }

      if (!YANDEX_DISK_TOKEN) {
        return res.status(500).json({
          success: false,
          message: "Не задан YANDEX_DISK_TOKEN"
        });
      }

      const baseUrl = `https://${AMO_SUBDOMAIN}.amocrm.ru`;
      const lead = await getLeadById(baseUrl, leadId);

      if (!lead?.id) {
        return res.status(404).json({
          success: false,
          message: "Сделка не найдена"
        });
      }

      const countryService = getCustomFieldValue(lead, "Страна оформления/услуга") || "не указано";

      const fields = {
        phone,
        leadId,
        countryService,
        fullName,
        hadPrevSurnames:            String(req.body.hadPrevSurnames || "").trim(),
        prevSurnames:               String(req.body.prevSurnames || "").trim(),
        contactPhone:               String(req.body.contactPhone || "").trim(),
        email:                      String(req.body.email || "").trim(),
        maritalStatus:              String(req.body.maritalStatus || "").trim(),
        hadOtherCitizenshipAtBirth: String(req.body.hadOtherCitizenshipAtBirth || "").trim(),
        birthCitizenship:           String(req.body.birthCitizenship || "").trim(),
        notRussianCitizen:          String(req.body.notRussianCitizen || "").trim(),
        hasSecondCitizenship:       String(req.body.hasSecondCitizenship || "").trim(),
        secondCitizenship:          String(req.body.secondCitizenship || "").trim(),
        hasSecondPassport:          String(req.body.hasSecondPassport || "").trim(),
        whichPassport:              String(req.body.whichPassport || "").trim(),
        canSurrenderPassport:       String(req.body.canSurrenderPassport || "").trim(),
        surrenderReason:            String(req.body.surrenderReason || "").trim(),
        surrenderReasonOther:       String(req.body.surrenderReasonOther || "").trim(),
        actualAddress:              String(req.body.actualAddress || "").trim(),
        occupation:                 String(req.body.occupation || "").trim(),
        employerName:               String(req.body.employerName || "").trim(),
        employerAddress:            String(req.body.employerAddress || "").trim(),
        employerPhone:              String(req.body.employerPhone || "").trim(),
        tripPurpose:                String(req.body.tripPurpose || "").trim(),
        tripPurposeOther:           String(req.body.tripPurposeOther || "").trim(),
        usaInterviewPoland:         String(req.body.usaInterviewPoland || "").trim(),
        travelCountry:              String(req.body.travelCountry || "").trim(),
        biometricAck:               String(req.body.biometricAck || "").trim(),
        biometricAckFr:             String(req.body.biometricAckFr || "").trim(),
        visaCountry:                String(req.body.visaCountry || "").trim(),
        tripDateFrom:               String(req.body.tripDateFrom || "").trim(),
        tripDateTo:                 String(req.body.tripDateTo || "").trim(),
        tripDatesUnknown:           String(req.body.tripDatesUnknown || "").trim(),
        tripDatesAck:               String(req.body.tripDatesAck || "").trim(),
        hasActiveSchengen:          String(req.body.hasActiveSchengen || "").trim(),
        schengenExpiry:             String(req.body.schengenExpiry || "").trim(),
        hadSchengen3Years:          String(req.body.hadSchengen3Years || "").trim(),
        didNotUseVisa:              String(req.body.didNotUseVisa || "").trim(),
        didNotUseReason:            String(req.body.didNotUseReason || "").trim(),
        visaRefused:                String(req.body.visaRefused || "").trim(),
        refusalReason:              String(req.body.refusalReason || "").trim(),
        visitedSchengenAfterApr2026: String(req.body.visitedSchengenAfterApr2026 || "").trim(),
        hadBorderStamps:            String(req.body.hadBorderStamps || "").trim(),
        hasInsurance:               String(req.body.hasInsurance || "").trim(),
        wantBuyInsurance:           String(req.body.wantBuyInsurance || "").trim(),
        hasOwnAccommodation:        String(req.body.hasOwnAccommodation || "").trim(),
        hasOwnTransport:            String(req.body.hasOwnTransport || "").trim(),
        isUnder18:                  String(req.body.isUnder18 || "").trim(),
        legalRepresentative:        String(req.body.legalRepresentative || "").trim(),
        hasSponsor:                 String(req.body.hasSponsor || "").trim(),
        sponsorName:                String(req.body.sponsorName || "").trim(),
        visitType:                  String(req.body.visitType || "").trim(),
        pickupMethod:               String(req.body.pickupMethod || "").trim(),
        hasConsularFeeDoc:          String(req.body.hasConsularFeeDoc || "").trim(),
        useBotBooking:              String(req.body.useBotBooking || "").trim(),
        bookingDateFrom:            String(req.body.bookingDateFrom || "").trim(),
        bookingDateTo:              String(req.body.bookingDateTo || "").trim(),
        bookingDateFrom2:           String(req.body.bookingDateFrom2 || "").trim(),
        bookingDateTo2:             String(req.body.bookingDateTo2 || "").trim(),
        bookingDateFrom3:           String(req.body.bookingDateFrom3 || "").trim(),
        bookingDateTo3:             String(req.body.bookingDateTo3 || "").trim(),
        bookingExclusions:          String(req.body.bookingExclusions || "").trim(),
        bookingCity:                String(req.body.bookingCity || "").trim(),
        bookingTimePrefs:           String(req.body.bookingTimePrefs || "").trim(),
        bookingLoungePrefs:         String(req.body.bookingLoungePrefs || "").trim(),
        howFoundUs:                 String(req.body.howFoundUs || "").trim(),
        notes:                      String(req.body.notes || "").trim(),
        confirmAccuracy:            String(req.body.confirmAccuracy || "").trim(),
        confirmPrevData:            String(req.body.confirmPrevData || "").trim(),
        personalDataConsent:        String(req.body.personalDataConsent || "").trim(),
        visaType:                   String(req.body.visaType || "").trim(),
        // ── Поля опросника на визу в Японию (jp_*). Заполнены только для visaType="Виза в Японию". ──
        jp_hadOtherNames:           String(req.body.jp_hadOtherNames || "").trim(),
        jp_otherNames:              String(req.body.jp_otherNames || "").trim(),
        jp_maritalStatus:           String(req.body.jp_maritalStatus || "").trim(),
        jp_spouseOccupation:        String(req.body.jp_spouseOccupation || "").trim(),
        jp_hasSecondCitizenship:    String(req.body.jp_hasSecondCitizenship || "").trim(),
        jp_secondCitizenship:       String(req.body.jp_secondCitizenship || "").trim(),
        jp_passportForVisa:         String(req.body.jp_passportForVisa || "").trim(),
        jp_passportCity:            String(req.body.jp_passportCity || "").trim(),
        jp_tripPurpose:             String(req.body.jp_tripPurpose || "").trim(),
        jp_tripDateFrom:            String(req.body.jp_tripDateFrom || "").trim(),
        jp_tripDateTo:              String(req.body.jp_tripDateTo || "").trim(),
        jp_citiesToVisit:           String(req.body.jp_citiesToVisit || "").trim(),
        jp_knowsAccommodation:      String(req.body.jp_knowsAccommodation || "").trim(),
        jp_accommodationName:       String(req.body.jp_accommodationName || "").trim(),
        jp_accommodationAddress:    String(req.body.jp_accommodationAddress || "").trim(),
        jp_hasOwnFlights:           String(req.body.jp_hasOwnFlights || "").trim(),
        jp_visitedJapanBefore:      String(req.body.jp_visitedJapanBefore || "").trim(),
        jp_japanVisits:             String(req.body.jp_japanVisits || "").trim(),
        jp_occupation:              String(req.body.jp_occupation || "").trim(),
        jp_employerName:            String(req.body.jp_employerName || "").trim(),
        jp_employerAddress:         String(req.body.jp_employerAddress || "").trim(),
        jp_employerPhone:           String(req.body.jp_employerPhone || "").trim(),
        jp_position:                String(req.body.jp_position || "").trim(),
        jp_ipName:                  String(req.body.jp_ipName || "").trim(),
        jp_ipActivity:              String(req.body.jp_ipActivity || "").trim(),
        jp_selfActivity:            String(req.body.jp_selfActivity || "").trim(),
        jp_studyPlace:              String(req.body.jp_studyPlace || "").trim(),
        jp_studyAddress:            String(req.body.jp_studyAddress || "").trim(),
        jp_unemployedIncome:        String(req.body.jp_unemployedIncome || "").trim(),
        jp_occupationOther:         String(req.body.jp_occupationOther || "").trim(),
        jp_isUnder18:               String(req.body.jp_isUnder18 || "").trim(),
        jp_fatherFullName:          String(req.body.jp_fatherFullName || "").trim(),
        jp_motherFullName:          String(req.body.jp_motherFullName || "").trim(),
        jp_hasInvitation:           String(req.body.jp_hasInvitation || "").trim(),
        jp_inviterName:             String(req.body.jp_inviterName || "").trim(),
        jp_inviterAddress:          String(req.body.jp_inviterAddress || "").trim(),
        jp_inviterRelation:         String(req.body.jp_inviterRelation || "").trim(),
        jp_inviterStatus:           String(req.body.jp_inviterStatus || "").trim(),
        jp_hasSponsor:              String(req.body.jp_hasSponsor || "").trim(),
        jp_appl_crimes:             String(req.body.jp_appl_crimes || "").trim(),
        jp_appl_prison:             String(req.body.jp_appl_prison || "").trim(),
        jp_appl_deport:             String(req.body.jp_appl_deport || "").trim(),
        jp_appl_drugs:              String(req.body.jp_appl_drugs || "").trim(),
        jp_appl_traffic:            String(req.body.jp_appl_traffic || "").trim(),
        jp_appl_none:               String(req.body.jp_appl_none || "").trim(),
        jp_applicableExplain:       String(req.body.jp_applicableExplain || "").trim(),
        jp_confirmAccuracy:         String(req.body.jp_confirmAccuracy || "").trim(),
        jp_confirmContract:         String(req.body.jp_confirmContract || "").trim(),
        jp_personalDataConsent:     String(req.body.jp_personalDataConsent || "").trim()
      };

      const enrichedFields = {
        ...fields,
        applicantIndex,
        totalApplicants
      };

      const pdfBuffer = await generateQuestionnairePdfBuffer(enrichedFields);

      const rootFolder = YANDEX_DISK_ROOT;
      const phoneFolder = `${rootFolder}/${phone}`;
      const leadFolder = leadScopedFolder(phone, leadId); // "<phone>/<leadId>"
      const techFolder = techFolderPath(phone, leadId);   // "<phone>/<leadId>/TECH FOLDER"

      const suffix = applicantIndex > 1 ? ` ${applicantIndex}` : "";
      const safeFio = sanitizeFileName(fullName) || `Заявитель ${applicantIndex}`;
      const applicantFolder = `${leadFolder}/${safeFio}`; // "<phone>/<leadId>/<ФИО>"

      await ensureYandexFolder(rootFolder);
      await ensureYandexFolder(phoneFolder);
      await ensureYandexFolder(leadFolder);
      await ensureYandexFolder(techFolder);
      await ensureYandexFolder(applicantFolder);

      // PDF опросника кладём в папку с ФИО клиента (рядом с документами).
      const pdfFileName = `Опросник - ${safeFio}.pdf`;
      await uploadBufferToYandexDisk(
        pdfBuffer,
        `${applicantFolder}/${pdfFileName}`,
        "application/pdf"
      );

      // JSON — служебный, кладётся в TECH FOLDER (используется бэкендом для prefill
      // при «Скорректировать опросник» и для определения уже загруженных файлов).
      const stateJson = JSON.stringify({ ...enrichedFields, savedAt: new Date().toISOString() }, null, 2);
      const jsonFileName = `Опросник${suffix}.json`;
      const jsonBuffer = Buffer.from(stateJson, "utf-8");
      await uploadBufferToYandexDisk(
        jsonBuffer,
        `${techFolder}/${jsonFileName}`,
        "application/json; charset=utf-8"
      );

      // Зеркалирование в папку сделки: PDF — в папку ФИО, JSON — в служебную TECH FOLDER.
      // Задачу при сабмите опросника не создаём — только при загрузке документов.
      if (leadId) {
        // Готовые документы (ЛК): на каждый опросник создаём папку заявителя
        // <ФИО> + вложенную «Чек по страховке» (идемпотентно, fire-and-forget).
        ensureReadyDocsApplicantFolder(leadId, safeFio);
        mirrorFilesToAmoFolder(leadId, [
          {
            relativePath: `${safeFio}/${pdfFileName}`,
            buffer: pdfBuffer,
            contentType: "application/pdf"
          },
          {
            relativePath: `TECH FOLDER/${jsonFileName}`,
            buffer: jsonBuffer,
            contentType: "application/json; charset=utf-8"
          }
        ]);
        finalizeAmoUpload(leadId, { createTask: false });
      }

      // Share-режим: токен одноразовый — после успешного сохранения удаляем
      if (isShareMode && shareData) {
        shareTokens.delete(shareData.token);
        saveShareTokens();
      }

      let nextApplicantUrl = null;
      if (!isShareMode && !isEdit) {
        if (isMixed) {
          // Mixed: ведём по selfStep до selfFillCount
          if (selfStep < selfFillCount) {
            const params = new URLSearchParams({
              phone,
              leadId,
              applicantCount: String(applicantCountRaw),
              mixed: "1",
              selfFillCount: String(selfFillCount),
              selfStep: String(selfStep + 1),
              prevApplicantName: fullName
            });
            if (fields.visaType) params.set("visaType", fields.visaType);
            nextApplicantUrl = `/questionnaire?${params.toString()}`;
          }
        } else if (applicantIndex < totalApplicants) {
          const params = new URLSearchParams({
            phone,
            leadId,
            applicantIndex: String(applicantIndex + 1),
            totalApplicants: String(totalApplicants),
            prevApplicantName: fullName
          });
          if (fields.visaType) params.set("visaType", fields.visaType);
          nextApplicantUrl = `/questionnaire?${params.toString()}`;
        }
      }

      // Для статистики воронки админки: фиксируем первую ЛК-сделку,
      // в которой клиент отправил опросник. Идемпотентно — повторные
      // сабмиты для других сделок не перетирают первый.
      try { recordFirstQuestionnaireForPhone(phone, leadId); } catch (_) {}

      // Мерж с pre-applicant: если ФИО опросника совпадает с ФИО, под
      // которым клиент уже загрузил паспорта до опросника, — удаляем
      // pre-applicant. Файлы паспортов остаются в той же папке заявителя
      // и автоматически подхватываются нормальной логикой.
      if (leadId && fullName) {
        try { await removePreApplicantByFio(phone, leadId, fullName); } catch (_) {}
      }

      // Корректировка опросника → задача «Проверить доки» с пометкой,
      // что клиент сам внёс правки. Запускаем фоном, не блокируем ответ.
      if (isEdit && leadId) {
        createAmoQuestionnaireCorrectionTask(leadId).catch(() => {});
      }

      return res.json({
        success: true,
        message: "Опросник успешно сохранён",
        nextApplicantUrl
      });
    } catch (error) {
      console.error("POST /api/questionnaire error:");
      console.error("message:", error.message);
      console.error("status:", error.response?.status);
      console.error("", error.response?.data);

      return res.status(500).json({
        success: false,
        message: "Ошибка при сохранении опросника",
        error: error.response?.data || error.message
      });
    }
  }
);

app.post("/api/questionnaire/share", async (req, res) => {
  try {
    const phone = normalizePhone(req.body.phone || "");
    const leadId = String(req.body.leadId || "").trim();
    const applicantCount = Math.max(1, Math.min(10, parseInt(req.body.applicantCount || "0", 10) || 0));
    const visaType = String(req.body.visaType || "").trim();
    const recipientPhone = sms.normalizePhone(String(req.body.recipientPhone || ""));

    if (!phone || !leadId) {
      return res.status(400).json({ success: false, message: "Не переданы phone или leadId" });
    }
    if (!recipientPhone || recipientPhone.length < 11) {
      return res.status(400).json({ success: false, message: "Некорректный номер телефона получателя" });
    }
    if (!applicantCount) {
      return res.status(400).json({ success: false, message: "Не указано количество заявителей" });
    }

    const token = createShareToken({ phone, leadId, applicantCount, visaType });
    const origin = `${req.protocol}://${req.get("host")}`;
    const link = `${origin}/questionnaire?share=${token}`;

    const r = await sms.sendQuestionnaireLink(recipientPhone, link);
    if (!r.ok) {
      return res.status(502).json({
        success: false,
        message: r.error || "Не удалось отправить SMS",
        testMode: !!r.testMode
      });
    }

    return res.json({ success: true, testMode: !!r.testMode, recipientPhone });
  } catch (error) {
    console.error("POST /api/questionnaire/share error:", error.message);
    return res.status(500).json({ success: false, message: "Ошибка при отправке SMS" });
  }
});

// Регистрирует pre-applicant: фиксирует ФИО, под которым клиент будет
// грузить паспорта на этапе «Начало оформления» до отправки опросника.
// Идемпотентно: повторный вызов с тем же ФИО возвращает existing.
app.post("/api/cabinet/pre-applicant", express.json(), async (req, res) => {
  try {
    const phone = normalizePhone((req.body && req.body.phone) || "");
    const leadId = String((req.body && req.body.leadId) || "").trim();
    const fullName = String((req.body && req.body.fullName) || "").trim();
    if (!phone) return res.status(400).json({ success: false, message: "Не передан phone" });
    if (!leadId) return res.status(400).json({ success: false, message: "Не передан leadId" });
    if (!fullName) return res.status(400).json({ success: false, message: "Не передан fullName" });
    if (!YANDEX_DISK_TOKEN) return res.status(500).json({ success: false, message: "Не задан YANDEX_DISK_TOKEN" });
    const item = await addPreApplicantFio(phone, leadId, fullName);
    return res.json({ success: true, fullName: item ? item.fullName : fullName });
  } catch (e) {
    console.error("POST /api/cabinet/pre-applicant error:", e.message);
    return res.status(500).json({ success: false, message: "Ошибка сохранения" });
  }
});

// ─── «Готовые документы (ЛК)»: список / скачать файл / скачать всё ───
// Показываем только на этапе ЛК «Ожидание подачи» (3 статуса amoCRM).
app.get("/api/ready-docs", async (req, res) => {
  try {
    const phone = req.query.phone || "";
    const leadId = req.query.leadId || "";
    if (!phone || !leadId) return res.status(400).json({ success: false, message: "Не передан phone/leadId" });
    if (!YANDEX_DISK_TOKEN) return res.status(500).json({ success: false, message: "Я.Диск не настроен" });
    const acc = await verifyReadyDocsAccess(phone, leadId);
    if (!acc.ok) return res.status(403).json({ success: false, message: "Нет доступа" });
    if (!acc.visible) return res.json({ success: true, visible: false, applicants: [] });

    const { applicants, hasZip, needsDedup } = await collectReadyDocsForLead(parseInt(leadId, 10));
    if (hasZip || needsDedup) {
      // ленивый фоновый триггер: распаковать архивы / почистить дубли (не блокируем ответ)
      setImmediate(() => processReadyDocsArchivesForLead(parseInt(leadId, 10)).catch(() => {}));
    }
    return res.json({ success: true, visible: true, processing: !!hasZip, applicants });
  } catch (e) {
    console.error("GET /api/ready-docs error:", e.message);
    return res.status(500).json({ success: false, message: "Ошибка" });
  }
});

app.get("/api/ready-docs/file", async (req, res) => {
  try {
    const phone = req.query.phone || "";
    const leadId = req.query.leadId || "";
    const rel = String(req.query.path || "");
    if (!phone || !leadId || !rel) return res.status(400).send("bad request");
    if (rel.includes("..") || rel.startsWith("/")) return res.status(400).send("bad path");
    const acc = await verifyReadyDocsAccess(phone, leadId);
    if (!acc.ok || !acc.visible) return res.status(403).send("forbidden");
    const diskPath = `${readyDocsFolder(parseInt(leadId, 10))}/${rel}`;
    const linkResp = await yandexRequest({
      method: "GET",
      url: "https://cloud-api.yandex.net/v1/disk/resources/download",
      params: { path: diskPath }
    });
    const href = linkResp.data && linkResp.data.href;
    if (!href) return res.status(404).send("not found");
    return res.redirect(href); // лёгкий путь: отдаём скачивание напрямую с Я.Диска
  } catch (e) {
    if (e.response?.status === 404) return res.status(404).send("not found");
    console.error("GET /api/ready-docs/file error:", e.message);
    return res.status(500).send("error");
  }
});

app.get("/api/ready-docs/zip", async (req, res) => {
  try {
    const phone = req.query.phone || "";
    const leadId = req.query.leadId || "";
    const fio = String(req.query.fio || "");
    if (!phone || !leadId || !fio) return res.status(400).send("bad request");
    if (fio.includes("..") || fio.includes("/") || fio.includes("\\")) return res.status(400).send("bad fio");
    const acc = await verifyReadyDocsAccess(phone, leadId);
    if (!acc.ok || !acc.visible) return res.status(403).send("forbidden");
    const folder = readyDocsApplicantFolder(parseInt(leadId, 10), fio);
    const items = (await listYandexFolderRecursive(folder)).filter((f) => !/\.zip$/i.test(f.name));
    if (!items.length) return res.status(404).send("no files");
    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", "attachment; filename*=UTF-8''" + encodeURIComponent(`Документы - ${fio}.zip`));
    const archive = archiver("zip", { zlib: { level: 6 } });
    archive.on("error", (err) => { console.error("READY-DOCS zip stream error:", err.message); try { res.status(500).end(); } catch (_) {} });
    archive.pipe(res);
    for (const it of items) {
      try {
        const buf = await downloadYandexFileBuffer(it.fullPath);
        archive.append(buf, { name: it.relativePath });
      } catch (e) {
        console.error("READY-DOCS zip fetch error:", it.fullPath, e.message);
      }
    }
    await archive.finalize();
  } catch (e) {
    console.error("GET /api/ready-docs/zip error:", e.message);
    try { res.status(500).end(); } catch (_) {}
  }
});

app.get("/api/questionnaire-state", async (req, res) => {
  try {
    const phone = normalizePhone(req.query.phone || "");
    const leadId = String(req.query.leadId || "").trim();

    if (!phone) {
      return res.status(400).json({ success: false, message: "Не передан phone" });
    }
    if (!leadId) {
      // С 2026-05-21 lead-scoped — leadId обязателен.
      // Без него все сделки бы видели общий стейт и зеркалили чужие документы.
      return res.status(400).json({ success: false, message: "Не передан leadId" });
    }

    if (!YANDEX_DISK_TOKEN) {
      return res.status(500).json({ success: false, message: "Не задан YANDEX_DISK_TOKEN" });
    }

    const loadOne = (n) => loadApplicantJson(phone, leadId, n);

    const first = await loadOne(1);

    // Pre-applicants: ФИО, которые ввели через модал на этапе «Начало
    // оформления» до заполнения опросника. У них только uploadedFiles из
    // папки заявителя — никакого опросника. Если опросник на это же ФИО
    // потом был сохранён — pre-applicant будет удалён в POST /api/questionnaire,
    // и сюда он не вернётся (нормальный applicant покажет файлы из своей папки).
    const preApplicantsRaw = await loadPreApplicants(phone, leadId);
    const normalFiosSet = new Set();

    const preApplicantsOut = [];
    for (const pa of preApplicantsRaw) {
      const fio = String(pa.fullName || "").trim();
      if (!fio) continue;
      const safeFio = sanitizeFileName(fio);
      const path = `${leadScopedFolder(phone, leadId)}/${safeFio}`;
      let files = [];
      try { files = await listYandexFolderFiles(path) || []; } catch (_) { files = []; }
      preApplicantsOut.push({
        fullName: fio,
        uploadedFiles: files
      });
    }

    if (!first) {
      return res.json({ success: true, applicants: [], preApplicants: preApplicantsOut });
    }

    // Считаем фактическое количество заявителей по файлам JSON на диске для ЭТОЙ сделки
    // (lead-scoped TECH FOLDER + legacy TECH FOLDER только если этот лид — legacy owner).
    let maxIdxOnDisk = 1;
    try {
      const files = await listAllTechFiles(phone, leadId);
      files.forEach((name) => {
        const m = /^Опросник(?:\s+(\d+))?\.json$/i.exec(name);
        if (m) {
          const idx = parseInt(m[1] || "1", 10);
          if (idx > maxIdxOnDisk) maxIdxOnDisk = idx;
        }
      });
    } catch (_) {}

    const fromFirst = Math.max(1, Math.min(10, parseInt(first.totalApplicants, 10) || 1));
    const total = Math.min(10, Math.max(fromFirst, maxIdxOnDisk));
    const restPromises = [];
    for (let i = 2; i <= total; i++) {
      restPromises.push(loadOne(i));
    }
    const rest = await Promise.all(restPromises);

    const applicants = [{ ...first, applicantIndex: 1 }];
    rest.forEach((s, i) => {
      if (s) applicants.push({ ...s, applicantIndex: i + 2 });
    });

    // Список загруженных файлов в папке заявителя.
    // Если этот лид — legacy owner: мерджим lead-scoped + legacy <phone>/<ФИО>/.
    // Это обеспечивает, что если клиент дозагружает что-то новое в свою «старую» сделку
    // (после деплоя 2026-05-21) — он продолжит видеть и старые файлы, и новые.
    // Для новых сделок (не-owner) — только lead-scoped, legacy не подмешивается.
    const ownerId = await getLegacyOwnerLeadId(phone);
    const isLegacyOwner = ownerId && String(ownerId) === String(leadId);
    await Promise.all(applicants.map(async (a) => {
      const fio = sanitizeFileName(String(a.fullName || "").trim()) || `Заявитель ${a.applicantIndex}`;
      const merged = new Set();
      const leadScopedPath = `${leadScopedFolder(phone, leadId)}/${fio}`;
      const leadFiles = await listYandexFolderFiles(leadScopedPath);
      (leadFiles || []).forEach((n) => merged.add(n));
      if (isLegacyOwner) {
        const legacyFiles = await listYandexFolderFiles(`${YANDEX_DISK_ROOT}/${phone}/${fio}`);
        (legacyFiles || []).forEach((n) => merged.add(n));
      }
      a.uploadedFiles = Array.from(merged);
    }));

    // Если pre-applicant пересекается по ФИО с нормальным applicant —
    // в ответе показываем только нормального (мерж уже произошёл по факту,
    // pre-applicant ещё не удалён из json, но это произойдёт при следующем сохранении).
    applicants.forEach((a) => {
      const norm = normalizeFioForCompare(a && a.fullName);
      if (norm) normalFiosSet.add(norm);
    });
    const preApplicantsFiltered = preApplicantsOut.filter((pa) => {
      const norm = normalizeFioForCompare(pa.fullName);
      return !normalFiosSet.has(norm);
    });

    return res.json({ success: true, applicants, preApplicants: preApplicantsFiltered });
  } catch (error) {
    console.error("GET /api/questionnaire-state error:");
    console.error("message:", error.message);
    console.error("status:", error.response?.status);
    console.error("", error.response?.data);

    return res.status(500).json({
      success: false,
      message: "Ошибка чтения состояния опросника",
      error: error.response?.data || error.message
    });
  }
});

app.post(
  "/upload-extra-document",
  upload.single("file"),
  async (req, res) => {
    try {
      const phone = normalizePhone(req.body.phone || "");
      const file = req.file;
      const leadId = String(req.body.leadId || "").trim();

      if (!phone) return res.status(400).json({ success: false, message: "Телефон не передан" });
      if (!file) return res.status(400).json({ success: false, message: "Файл не передан" });
      if (!leadId) return res.status(400).json({ success: false, message: "leadId не передан" });
      if (!YANDEX_DISK_TOKEN) return res.status(500).json({ success: false, message: "Не задан YANDEX_DISK_TOKEN" });

      // Лимит файлов на обращение (200 на одну сделку).
      const currentCount = await getAmoLeadFileCount(leadId);
      if (currentCount >= LEAD_FILE_LIMIT) {
        return res.status(429).json({
          success: false,
          message: `Превышен лимит файлов для этого обращения (${LEAD_FILE_LIMIT}). Обратитесь к менеджеру или дождитесь нового обращения.`
        });
      }

      const rootFolder = YANDEX_DISK_ROOT;
      const phoneFolder = `${rootFolder}/${phone}`;
      const leadFolder = leadScopedFolder(phone, leadId);
      const extraFolder = `${leadFolder}/Дополнительные документы`;

      await ensureYandexFolder(rootFolder);
      await ensureYandexFolder(phoneFolder);
      await ensureYandexFolder(leadFolder);
      await ensureYandexFolder(extraFolder);

      const origName = sanitizeFileName(file.originalname || "file");
      const dotIndex = origName.lastIndexOf(".");
      const base = dotIndex > 0 ? origName.slice(0, dotIndex) : origName;
      const ext = dotIndex > 0 ? origName.slice(dotIndex) : "";
      const ts = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 19);
      const finalName = `${base} - ${ts}${ext}`;
      const diskPath = `${extraFolder}/${finalName}`;

      await uploadBufferToYandexDisk(file.buffer, diskPath, file.mimetype);

      // Зеркалирование одного файла в папку сделки (фоном, без zip и task).
      // Финализация (zip + task) — отдельный вызов клиента к /api/amo/finish-upload
      // после батча, чтобы получить ровно 1 задачу на нажатие «Загрузить».
      mirrorFilesToAmoFolder(leadId, {
        relativePath: `Дополнительные документы/${finalName}`,
        buffer: file.buffer,
        contentType: file.mimetype
      });
      bumpAmoLeadFileCount(leadId, 1);

      return res.json({ success: true, message: "Файл успешно загружен", fileName: finalName });
    } catch (error) {
      console.error("UPLOAD EXTRA DOC ERROR:");
      console.error("message:", error.message);
      console.error("status:", error.response?.status);
      console.error("", error.response?.data);
      return res.status(500).json({
        success: false,
        message: "Ошибка загрузки документа",
        error: error.response?.data || error.message
      });
    }
  }
);

app.post(
  "/upload-document",
  upload.single("file"),
  async (req, res) => {
    try {
      const phone = normalizePhone(req.body.phone || "");
      const field = String(req.body.field || "").trim();
      const applicantIndex = Math.max(1, Math.min(10, parseInt(req.body.applicantIndex || "1", 10) || 1));
      const file = req.file;
      const leadId = String(req.body.leadId || "").trim();

      console.log("HANDLER /upload-document phone =", phone, "field =", field, "applicantIndex =", applicantIndex, "leadId =", leadId);

      if (!phone) {
        return res.status(400).json({ success: false, message: "Телефон не передан" });
      }
      if (!file) {
        return res.status(400).json({ success: false, message: "Файл не передан" });
      }
      if (!leadId) {
        return res.status(400).json({ success: false, message: "leadId не передан" });
      }

      const targetName = UPLOAD_FIELDS_WHITELIST[field];
      if (!targetName) {
        return res.status(400).json({ success: false, message: "Неизвестный тип документа" });
      }

      if (!YANDEX_DISK_TOKEN) {
        return res.status(500).json({ success: false, message: "Не задан YANDEX_DISK_TOKEN" });
      }

      // Лимит файлов на обращение (200 на одну сделку).
      // Проверяем только для partIndex === 1 (новая загрузка для поля).
      const partIndexForLimit = Math.max(1, parseInt(req.body.partIndex || "1", 10) || 1);
      if (partIndexForLimit === 1) {
        const currentCount = await getAmoLeadFileCount(leadId);
        if (currentCount >= LEAD_FILE_LIMIT) {
          return res.status(429).json({
            success: false,
            message: `Превышен лимит файлов для этого обращения (${LEAD_FILE_LIMIT}). Обратитесь к менеджеру или дождитесь нового обращения.`
          });
        }
      }

      const rootFolder = YANDEX_DISK_ROOT;
      const phoneFolder = `${rootFolder}/${phone}`;
      const leadFolder = leadScopedFolder(phone, leadId); // "<phone>/<leadId>"

      await ensureYandexFolder(rootFolder);
      await ensureYandexFolder(phoneFolder);
      await ensureYandexFolder(leadFolder);

      // preApplicantFio — режим загрузки на этапе «Начало оформления»
      // до заполнения опросника. Клиент уже ввёл ФИО через модал, мы
      // используем его напрямую для имени папки. JSON опросника НЕ нужен.
      const preApplicantFio = String(req.body.preApplicantFio || "").trim();

      let applicantState = null;
      let rawFio = "";
      if (preApplicantFio) {
        rawFio = preApplicantFio;
      } else {
        try { applicantState = await loadApplicantJson(phone, leadId, applicantIndex); } catch (_) {}
        if (!applicantState) {
          return res.status(409).json({
            success: false,
            message: "Опросник заявителя не найден — заполните опросник перед загрузкой документов"
          });
        }
        rawFio = String(applicantState.fullName || "").trim();
      }

      const safeFio = sanitizeFileName(rawFio) || `Заявитель ${applicantIndex}`;
      const applicantFolder = `${leadFolder}/${safeFio}`; // "<phone>/<leadId>/<ФИО>"

      await ensureYandexFolder(applicantFolder);

      const originalName = sanitizeFileName(file.originalname || "file");
      const dotIndex = originalName.lastIndexOf(".");
      const ext = dotIndex >= 0 ? originalName.slice(dotIndex) : "";
      // Если для одного поля грузится несколько файлов — добавляем суффикс (2), (3) и т.д.
      const partIndex = Math.max(1, parseInt(req.body.partIndex || "1", 10) || 1);
      const partSuffix = partIndex > 1 ? ` (${partIndex})` : "";
      const finalFileName = `${targetName} - ${safeFio}${partSuffix}${ext}`;
      const diskPath = `${applicantFolder}/${finalFileName}`;

      // При partIndex === 1 (первый файл батча для этого поля) подчищаем все
      // предыдущие версии загрузки в этом поле — любое расширение, любой суффикс « (2)»/« (3)».
      // Это нужно, чтобы при замене JPG на PDF (или наоборот) старая версия не оставалась
      // ни в основной папке клиента, ни в zip-архиве сделки.
      if (partIndex === 1) {
        try {
          const existing = await listYandexFolderFiles(applicantFolder);
          for (const name of existing) {
            if (matchesFieldFile(name, targetName, safeFio)) {
              await deleteYandexResourceIfExists(`${applicantFolder}/${name}`);
            }
          }
        } catch (e) {
          console.error("CLEANUP OLD FIELD FILES (lead folder) error:", e.message);
        }
        // Параллельно подчистим зеркало сделки — встаёт в очередь ПЕРЕД новой mirror-операцией.
        cleanupAmoFieldFilesInMirror(leadId, safeFio, targetName);
        // Cleanup мог удалить файлы из папки сделки — сбрасываем кеш счётчика,
        // следующий запрос пересчитает с Я.Диска.
        invalidateAmoLeadFileCount(leadId);
      }

      console.log("UPLOAD TO YANDEX:", diskPath);
      await uploadBufferToYandexDisk(file.buffer, diskPath, file.mimetype);

      // Зеркалирование одного файла в папку сделки (фоном, без zip и task).
      // Финализация (zip + 1 задача) — отдельный вызов /api/amo/finish-upload
      // после успешного завершения батча, чтобы получить ровно 1 задачу на нажатие «Загрузить».
      mirrorFilesToAmoFolder(leadId, {
        relativePath: `${safeFio}/${finalFileName}`,
        buffer: file.buffer,
        contentType: file.mimetype
      });
      bumpAmoLeadFileCount(leadId, 1);

      return res.json({
        success: true,
        message: "Файл успешно загружен",
        fileName: finalFileName
      });
    } catch (error) {
      console.error("UPLOAD DOCUMENT ERROR:");
      console.error("message:", error.message);
      console.error("status:", error.response?.status);
      console.error("", error.response?.data);

      return res.status(500).json({
        success: false,
        message: "Ошибка загрузки документа",
        error: error.response?.data || error.message
      });
    }
  }
);

// Финализация батча загрузки: один общий пересбор zip + одна задача в amoCRM
// на всё нажатие «Загрузить». Клиент вызывает этот эндпоинт ОДИН раз после
// успешной загрузки всех файлов из батча.
app.post("/api/amo/finish-upload", express.json(), async (req, res) => {
  try {
    const leadId = String((req.body && req.body.leadId) || "").trim();
    const withTask = !!(req.body && req.body.withTask);
    if (!leadId) {
      return res.status(400).json({ success: false, message: "leadId не передан" });
    }
    console.log("FINISH-UPLOAD leadId =", leadId, "withTask =", withTask);
    // Не блокируем ответ клиенту — финализация уйдёт в очередь и выполнится по порядку.
    finalizeAmoUpload(leadId, { createTask: withTask });
    return res.json({ success: true });
  } catch (e) {
    console.error("FINISH-UPLOAD ERROR:", e.response?.data || e.message);
    return res.status(500).json({ success: false, message: "Ошибка финализации" });
  }
});

// ────────────────────────────────────────────────────────────────────
// AMO MERGE TRANSFER: webhook от amoCRM для копирования содержимого папки
// сделки-дубля в основную сделку того же контакта.
//
// Триггеры (оба слушаем):
//   • contacts[merge]            — объединение контактов
//   • leads[status]→«Дубль»      — перевод сделки в статус «Дубль»
//
// Условия копирования (ВСЕ должны быть выполнены):
//   1. У контакта есть сделка в статусе «Дубль» И есть сделка не в «Дубль»
//   2. Разница в датах создания обеих сделок ≤ 4 дней
//   3. Папка дубль-сделки на Я.Диске существует и содержит хоть что-то
//   4. В основной сделке ещё нет папки «Перенос из Дубля #<dup_id> от (DD.MM.YYYY)»
//
// Копируется ВСЁ содержимое `amoCRM/<dup>/` в
// `amoCRM/<main>/Перенос из Дубля #<dup_id> от (DD.MM.YYYY)/`.
// Папка `Документы из ЛК` основной сделки НЕ ТРОГАЕТСЯ.
// ────────────────────────────────────────────────────────────────────

function formatDdMmYyyy(d) {
  const pad2 = (n) => (n < 10 ? `0${n}` : String(n));
  return `${pad2(d.getDate())}.${pad2(d.getMonth() + 1)}.${d.getFullYear()}`;
}

async function transferDupFolderToMain(dupLeadId, mainLeadId) {
  const dupFolder = amoDealFolder(dupLeadId);
  const mainFolder = amoDealFolder(mainLeadId);

  // 1. Папка дубль-сделки непуста?
  const hasContent = await yandexFolderHasAnyChildren(dupFolder);
  if (!hasContent) {
    console.log(`AMO MERGE TRANSFER: dup=${dupLeadId} → main=${mainLeadId} skipped (dup folder empty/missing)`);
    return;
  }

  const targetSubfolder = `Перенос из Дубля #${dupLeadId} от (${formatDdMmYyyy(new Date())})`;
  const targetPath = `${mainFolder}/${targetSubfolder}`;

  // 2. Идемпотентность: цель уже существует?
  const alreadyExists = await yandexResourceExists(targetPath);
  if (alreadyExists) {
    console.log(`AMO MERGE TRANSFER: dup=${dupLeadId} → main=${mainLeadId} skipped (already at "${targetSubfolder}")`);
    return;
  }

  // 3. Папка основной сделки должна существовать перед copy. amoCRM↔Я.Диск
  //    обычно её создаёт, но на всякий случай гарантируем.
  try {
    await ensureNestedYandexFolder(mainFolder);
  } catch (e) {
    console.error(`AMO MERGE TRANSFER ensure main folder error:`, e.response?.data || e.message);
    return;
  }

  // 4. Копируем через очередь основной сделки — чтобы не конфликтовать с
  //    активными аплоадами/zip-сборкой для этой же сделки.
  return amoEnqueue(String(mainLeadId), `transfer dup folder #${dupLeadId}`, async () => {
    try {
      await copyYandexResource(dupFolder, targetPath, { overwrite: false });
      console.log(`AMO MERGE TRANSFER: dup=${dupLeadId} → main=${mainLeadId} copied to "${targetSubfolder}"`);
    } catch (e) {
      const status = e.response?.status;
      if (status === 409) {
        console.log(`AMO MERGE TRANSFER: dup=${dupLeadId} → main=${mainLeadId} race-collision (409, target appeared between checks)`);
      } else {
        console.error(`AMO MERGE TRANSFER copy error dup=${dupLeadId} → main=${mainLeadId}:`, e.response?.data || e.message);
      }
    }
  });
}

async function tryTransferDupFilesForContact(contactId, triggerReason) {
  if (!contactId || !AMO_SUBDOMAIN || !AMO_ACCESS_TOKEN) return;
  const baseUrl = `https://${AMO_SUBDOMAIN}.amocrm.ru`;
  console.log(`AMO MERGE TRANSFER: check contact=${contactId} trigger=${triggerReason}`);

  const leadIds = await getContactLeadIds(baseUrl, contactId);
  if (leadIds.length < 2) {
    console.log(`AMO MERGE TRANSFER: contact=${contactId} skipped (leads=${leadIds.length})`);
    return;
  }

  const statusesMap = await getCachedPipelinesMap(baseUrl);
  const leads = [];
  for (const id of leadIds) {
    const lead = await getLeadById(baseUrl, id);
    if (lead) leads.push(lead);
  }

  const dupLeads = [];
  const workingLeads = [];
  for (const lead of leads) {
    const meta = statusesMap.get(`${lead.pipeline_id}:${lead.status_id}`) || {};
    const statusName = String(meta.status_name || "").trim();
    if (statusName === "Дубль") dupLeads.push(lead);
    else workingLeads.push(lead);
  }

  if (!dupLeads.length || !workingLeads.length) {
    console.log(`AMO MERGE TRANSFER: contact=${contactId} skipped (dup=${dupLeads.length}, working=${workingLeads.length})`);
    return;
  }

  // Окно ±4 дня по created_at (epoch seconds в amoCRM).
  const FOUR_DAYS_MS = 4 * 24 * 60 * 60 * 1000;
  for (const dup of dupLeads) {
    for (const work of workingLeads) {
      const dupTs = (dup.created_at || 0) * 1000;
      const workTs = (work.created_at || 0) * 1000;
      const diff = Math.abs(dupTs - workTs);
      if (diff > FOUR_DAYS_MS) {
        console.log(`AMO MERGE TRANSFER: dup=${dup.id} ↔ work=${work.id} skipped (diff ${Math.round(diff/86400000)}d > 4d)`);
        continue;
      }
      await transferDupFolderToMain(dup.id, work.id);
    }
  }
}

// Дедуп вебхуков по contactId, чтобы при шторме contacts[update] не плодить
// параллельных проверок одного и того же контакта (каждая проверка = каскад
// GET к amoCRM по сделкам контакта — основной усилитель нагрузки).
// Окно расширено 30с → 90с: amoCRM при правках шлёт по нескольку update на один
// контакт за минуту; склеиваем их в одну проверку. Это ЧИСТО фоновая служебная
// операция (перенос файлов дублей) — клиент в ЛК её не видит, а перевод сделки
// в «Дубль» триггерит перенос отдельным событием leads[status], так что реальные
// дубли не теряются.
const recentContactChecks = new Map(); // contactId -> ts
const RECENT_CHECK_WINDOW_MS = 90 * 1000;
function shouldSkipDuplicate(contactId) {
  if (!contactId) return true;
  const now = Date.now();
  const prev = recentContactChecks.get(contactId);
  if (prev && (now - prev) < RECENT_CHECK_WINDOW_MS) return true;
  recentContactChecks.set(contactId, now);
  // Periodic cleanup, чтобы карта не росла бесконтрольно.
  if (recentContactChecks.size > 500) {
    const cutoff = now - RECENT_CHECK_WINDOW_MS;
    for (const [k, ts] of recentContactChecks) {
      if (ts < cutoff) recentContactChecks.delete(k);
    }
  }
  return false;
}

// GET для верификации URL при сохранении webhook'а в amoCRM. amoCRM перед
// сохранением проверяет, что endpoint доступен (HEAD/GET с ожиданием 2xx).
// Без этого сохранение падает с «URL ведёт во внутреннюю сеть».
app.get("/api/amo/webhook", (_req, res) => {
  res.status(200).type("text/plain").send("amo webhook endpoint ok");
});

// Endpoint, который надо прописать в amoCRM как webhook URL.
// Подписать на события: «Изменение контакта» + «Смена этапа сделки».
// (Опционально + «Объединение контактов», если в твоей версии amoCRM есть.)
app.post("/api/amo/webhook", async (req, res) => {
  // amoCRM ожидает быстрый 200 — иначе будет ретраить вебхук. Всё дальнейшее
  // выполняем в фоне.
  res.status(200).send("ok");

  // Вся фоновая обработка вебхука — низкий приоритет в лимитере amoCRM: клиентские
  // запросы ЛК всегда идут впереди, а при 429/403 фон ставится на паузу (предохранитель).
  amoBg(() => {
  try {
    const body = req.body || {};
    const accountSubdomain = body?.account?.subdomain;

    // Слабая защита от чужих POST'ов: subdomain в payload должен совпасть
    // с нашим AMO_SUBDOMAIN. Если поля нет (не amo) — игнорим тихо.
    if (!accountSubdomain) {
      console.warn("AMO WEBHOOK: missing account.subdomain — ignoring");
      return;
    }
    if (accountSubdomain !== AMO_SUBDOMAIN) {
      console.warn(`AMO WEBHOOK: subdomain mismatch (${accountSubdomain} vs ${AMO_SUBDOMAIN})`);
      return;
    }

    const eventKeys = [];

    // 1) contacts[merge] — отдельное событие объединения (есть не во всех версиях amoCRM).
    const mergedContacts = body?.contacts?.merge;
    if (Array.isArray(mergedContacts) && mergedContacts.length) {
      eventKeys.push(`merge×${mergedContacts.length}`);
      for (const m of mergedContacts) {
        const contactId = parseInt(m?.id, 10);
        if (contactId && !shouldSkipDuplicate(contactId)) {
          tryTransferDupFilesForContact(contactId, "merge_contacts")
            .catch((e) => console.error("AMO WEBHOOK merge handler error:", e.message));
        }
      }
    }

    // 2) contacts[update] — событие изменения контакта. ВАЖНО: amoCRM присылает
    //    update на оставшийся контакт В ТОМ ЧИСЛЕ при объединении контактов.
    //    Это покрывает кейс «сначала ставим Дубль, потом мержим». Дедуп по contactId
    //    защищает от шторма (множество разных правок одного контакта).
    const updatedContacts = body?.contacts?.update;
    if (Array.isArray(updatedContacts) && updatedContacts.length) {
      eventKeys.push(`contact_update×${updatedContacts.length}`);
      for (const c of updatedContacts) {
        const contactId = parseInt(c?.id, 10);
        if (contactId && !shouldSkipDuplicate(contactId)) {
          tryTransferDupFilesForContact(contactId, "contact_update")
            .catch((e) => console.error("AMO WEBHOOK contact_update handler error:", e.message));
        }
      }
    }

    // 3) leads[status] — смена этапа сделки. Два независимых триггера:
    //   а) перевод в «Дубль» → AMO MERGE TRANSFER
    //   б) перевод в этап ЛК «Ожидание подачи» / «Рассмотрение» →
    //      feedback SMS с опросником клиенту (если ещё не отправляли).
    const leadsStatuses = body?.leads?.status;
    if (Array.isArray(leadsStatuses) && leadsStatuses.length) {
      eventKeys.push(`status×${leadsStatuses.length}`);
      const baseUrl = `https://${AMO_SUBDOMAIN}.amocrm.ru`;
      for (const ls of leadsStatuses) {
        const leadId = parseInt(ls?.id, 10);
        if (!leadId) continue;
        (async () => {
          try {
            const lead = await getLeadById(baseUrl, leadId);
            if (!lead) return;
            const statusesMap = await getCachedPipelinesMap(baseUrl);
            const meta = statusesMap.get(`${lead.pipeline_id}:${lead.status_id}`) || {};
            const statusName = String(meta.status_name || "").trim();

            // Готовые документы (ЛК): если сделка попала в статус выдачи —
            // распаковать архивы / почистить дубли в фоне (вне пути запроса).
            if (READY_DOCS_VISIBLE_STATUSES.has(statusName)) {
              processReadyDocsArchivesForLead(leadId).catch(() => {});
            }

            const contacts = (lead && lead._embedded && lead._embedded.contacts) || [];
            const mainContact = contacts.find((c) => c.is_main) || contacts[0];
            const contactId = mainContact && mainContact.id;

            // (а) Дубль → AMO MERGE TRANSFER
            if (statusName === "Дубль" && contactId && !shouldSkipDuplicate(contactId)) {
              await tryTransferDupFilesForContact(contactId, `lead_status:${leadId}→Дубль`);
            }

            // (б) Feedback SMS — триггер при попадании сделки в этап ЛК
            //     «Ожидание подачи» или «Рассмотрение», не дожидаясь, пока
            //     клиент сам зайдёт в кабинет. Идемпотентно через
            //     wasFeedbackSent: повторного SMS на втором этапе не будет.
            try {
              const enriched = enrichLeadWithMappedStatus(lead, statusesMap);
              if (enriched && !enriched.hidden_in_cabinet
                  && (enriched.cabinet_status === "Ожидание подачи"
                      || enriched.cabinet_status === "Рассмотрение")
                  && contactId) {
                let contactFull = null;
                try {
                  contactFull = await amoGet(`${baseUrl}/api/v4/contacts/${contactId}`);
                } catch (_) {}
                const phones = contactFull ? extractPhonesFromContact(contactFull) : [];
                const phone = phones[0];
                if (phone) {
                  await maybeSendFeedbackSms(phone, [enriched]);
                }
              }
            } catch (eFb) {
              console.error(`FEEDBACK trigger from webhook error lead=${leadId}:`, eFb && eFb.message);
            }
          } catch (e) {
            console.error(`AMO WEBHOOK status handler error lead=${leadId}:`, e.message);
          }
        })();
      }
    }

    console.log(`AMO WEBHOOK accepted: ${eventKeys.join(", ") || "no relevant events"}`);
  } catch (e) {
    console.error("AMO WEBHOOK fatal:", e.message);
  }
  });
});

// ────────────────────────────────────────────────────────────────────
// Фоновый пре-warm кеша «конверсия по оплаченным сделкам». Каждые 15 минут
// перевычисляем результат в фоне (TTL кеша 20 мин — успеваем обновить до
// истечения). Интервал поднят с 4 мин: при росте объёмов данных пре-warm
// конкурировал с admin-воронкой за amoCRM rate-limit (7 RPS), это давало
// каскад 429-retry и подвисания. 15 мин достаточно для свежести дашборда.
// ────────────────────────────────────────────────────────────────────
const PAID_CONV_PREWARM_INTERVAL_MS = 15 * 60 * 1000;
function schedulePaidConvPrewarm() {
  if (!AMO_SUBDOMAIN || !AMO_ACCESS_TOKEN) return; // нет смысла без amoCRM
  // Первый пре-warm — через 20 сек после старта, чтобы не блокировать первый запуск.
  setTimeout(async () => {
    try {
      // Сбрасываем кеш, чтобы computePaidConversionStats реально пересчитал.
      _cachedPaidConvStats = null;
      _cachedPaidConvStatsTs = 0;
      const t = Date.now();
      await amoBg(() => computePaidConversionStats());
      console.log(`PAID-CONV PREWARM (initial) done in ${Date.now()-t}ms`);
    } catch (e) {
      console.error("PAID-CONV PREWARM initial error:", e.message);
    }
  }, 20 * 1000);
  // Периодический пре-warm.
  setInterval(async () => {
    try {
      _cachedPaidConvStats = null;
      _cachedPaidConvStatsTs = 0;
      const t = Date.now();
      await amoBg(() => computePaidConversionStats());
      console.log(`PAID-CONV PREWARM done in ${Date.now()-t}ms`);
    } catch (e) {
      console.error("PAID-CONV PREWARM error:", e.message);
    }
  }, PAID_CONV_PREWARM_INTERVAL_MS);
}
schedulePaidConvPrewarm();

// Фоновый пре-warm воронки «Авторизовались → … → Прошёл «Подготовка документов»».
// Раньше блок считался лениво (на первый polling-запрос при холодном кеше) — после
// рестарта/истечения TTL админ ждал полный проход по всем телефонам (десятки
// запросов к Я.Диску). Теперь держим кеш всегда тёплым в фоне → блок открывается
// мгновенно. Нагрузка — только на Я.Диск (листинг папок), на amoCRM и клиентский
// ЛК не влияет; интервал чуть меньше TTL кеша (13 мин), чтобы он не успевал остыть.
// Интервал поднят 4 → 12 мин: воронка меняется медленно (клиенты грузят доки
// часами/днями), а 12 мин ощутимо снижают фоновый churn листингов Я.Диска.
const ADMIN_STATS_PREWARM_INTERVAL_MS = 12 * 60 * 1000;
function scheduleAdminStatsPrewarm() {
  setTimeout(async () => {
    try {
      const t = Date.now();
      await amoBg(() => refreshAdminStats());
      console.log(`ADMIN STATS PREWARM (initial) done in ${Date.now()-t}ms`);
    } catch (e) { console.error("ADMIN STATS PREWARM initial error:", e.message); }
  }, 25 * 1000);
  setInterval(async () => {
    try {
      const t = Date.now();
      await amoBg(() => refreshAdminStats());
      console.log(`ADMIN STATS PREWARM done in ${Date.now()-t}ms`);
    } catch (e) { console.error("ADMIN STATS PREWARM error:", e.message); }
  }, ADMIN_STATS_PREWARM_INTERVAL_MS);
}
scheduleAdminStatsPrewarm();

// Фоновый пре-warm воронки «по этапам» (amoCRM). Реже и с низкой concurrency
// (2), т.к. бьёт по amoCRM rate-limit — держим кеш тёплым, не мешая клиентскому
// кабинету. На auth НЕ инвалидируем (свежесть обеспечивает TTL/пре-warm).
const STAGE_STATS_PREWARM_INTERVAL_MS = 20 * 60 * 1000;
function scheduleStageStatsPrewarm() {
  if (!AMO_SUBDOMAIN || !AMO_ACCESS_TOKEN) return;
  setTimeout(async () => {
    try { const t = Date.now(); await amoBg(() => refreshStageStats()); console.log(`STAGE STATS PREWARM (initial) done in ${Date.now()-t}ms`); }
    catch (e) { console.error("STAGE STATS PREWARM initial error:", e.message); }
  }, 35 * 1000);
  setInterval(async () => {
    try { const t = Date.now(); await amoBg(() => refreshStageStats()); console.log(`STAGE STATS PREWARM done in ${Date.now()-t}ms`); }
    catch (e) { console.error("STAGE STATS PREWARM error:", e.message); }
  }, STAGE_STATS_PREWARM_INTERVAL_MS);
}
scheduleStageStatsPrewarm();

// ─── Разовый бэкафилл «Готовые документы (ЛК)» для уже авторизованных номеров ───
// Создаёт папку «Готовые документы (ЛК)» в активных сделках тех, кто уже
// авторизовался в ЛК. Идёт один раз (флаг-файл), с задержкой после старта и
// щадящим троттлингом — чтобы не конкурировать с пре-warm'ами за amoCRM/Я.Диск.
const READY_DOCS_BACKFILL_FLAG = path.join(__dirname, ".readyDocsBackfillDone");
(function scheduleReadyDocsBackfill() {
  if (!AMO_SUBDOMAIN || !AMO_ACCESS_TOKEN || !YANDEX_DISK_TOKEN) return;
  let alreadyDone = false;
  try { alreadyDone = fs.existsSync(READY_DOCS_BACKFILL_FLAG); } catch (_) {}
  if (alreadyDone) { console.log("READY-DOCS backfill: already done, skip"); return; }
  setTimeout(async () => {
    try {
      const phones = Array.from(lkAuthPhones.keys());
      console.log(`READY-DOCS backfill: start for ${phones.length} authorized phone(s)`);
      for (const ph of phones) {
        try { await amoBg(() => provisionReadyDocsForActiveLeads(ph)); }
        catch (e) { console.error("READY-DOCS backfill phone error:", ph, e.message); }
        await new Promise((r) => setTimeout(r, 2500)); // щадящий троттлинг между номерами
      }
      try { fs.writeFileSync(READY_DOCS_BACKFILL_FLAG, new Date().toISOString()); } catch (_) {}
      console.log("READY-DOCS backfill: done");
    } catch (e) {
      console.error("READY-DOCS backfill fatal:", e.message);
    }
  }, 90 * 1000); // через 90с после старта
})();

app.listen(PORT, () => {
  console.log(`Server started on http://localhost:${PORT}`);
});
