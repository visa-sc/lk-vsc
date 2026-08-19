"use strict";
// ── Онлайн-консультант VSC (/chat_test) — продающий ИИ-чат по визам ──────────
// Отдельный изолированный модуль: клиентский ЛК, amoCRM и переводы не трогает.
// Отвечает клиенту на вопросы по визам, ориентирует по ситуации/условиям,
// подбирает вариант оформления и на первых шагах мягко берёт контакт
// (телефон / WhatsApp / Telegram). Контакты складываются в .chatLeads.json и
// выгружаются в админке (экспорт в amoCRM подключим позже).
//
// Канал до Anthropic переиспользует те же env, что и переводы:
//   ANTHROPIC_API_KEY   — ключ (обязателен)
//   ANTHROPIC_BASE_URL  — ретранслятор (опц.)
//   TRANSLATE_PROXY     — не-РФ прокси (прод в РФ, Anthropic не пускает с РФ-IP)
//   CHAT_MODEL          — модель (дефолт claude-sonnet-5)
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const LEADS_FILE = path.join(__dirname, ".chatLeads.json");
const MODEL = process.env.CHAT_MODEL || "claude-sonnet-5";
// Код входа на время обкатки — чтобы посторонние не жгли токены. Убрать при запуске в бой:
// задать CHAT_ACCESS_CODE="" в .env (пустой = без кода) или удалить проверку.
const ACCESS_CODE = process.env.CHAT_ACCESS_CODE !== undefined ? process.env.CHAT_ACCESS_CODE : "111";
const MAX_TURNS = 40;          // предохранитель на длину диалога (пар сообщений)
const MAX_MSG_LEN = 4000;      // предохранитель на длину одного сообщения

// ── Клиент Anthropic (тот же канал, что и переводы) ─────────────────────────
function aiConfigured() { return !!process.env.ANTHROPIC_API_KEY; }
let _client = null;
function client() {
  if (!aiConfigured()) return null;
  if (_client) return _client;
  const { Anthropic } = require("@anthropic-ai/sdk");
  const opts = {
    apiKey: process.env.ANTHROPIC_API_KEY,
    baseURL: process.env.ANTHROPIC_BASE_URL || undefined,
    timeout: 2 * 60 * 1000,
    maxRetries: 2,
  };
  if (process.env.TRANSLATE_PROXY) {
    const undici = require("undici");
    opts.fetch = undici.fetch;
    opts.fetchOptions = { dispatcher: new undici.ProxyAgent(process.env.TRANSLATE_PROXY) };
  }
  _client = new Anthropic(opts);
  return _client;
}

// ── Хранилище лидов ─────────────────────────────────────────────────────────
function loadLeads() {
  try { return JSON.parse(fs.readFileSync(LEADS_FILE, "utf8")) || {}; }
  catch (_) { return {}; }
}
function saveLeads(obj) {
  try { fs.writeFileSync(LEADS_FILE, JSON.stringify(obj, null, 1), "utf8"); }
  catch (e) { console.error("chat: не удалось сохранить лид:", e.message); }
}
// Мягко доливаем непустые поля в существующую запись сессии.
function upsertLead(sessionId, patch, meta) {
  const all = loadLeads();
  const now = new Date().toISOString();
  const cur = all[sessionId] || { sessionId, createdAt: now, source: "chat_test" };
  ["name", "contact", "contact_type", "country", "details"].forEach((k) => {
    const v = patch && patch[k];
    if (typeof v === "string" && v.trim()) cur[k] = v.trim();
  });
  cur.updatedAt = now;
  if (meta && meta.ip) cur.ip = meta.ip;
  if (meta && meta.ua) cur.ua = String(meta.ua).slice(0, 300);
  all[sessionId] = cur;
  saveLeads(all);
  return cur;
}

// ── База знаний чата (обучение на звонках/переписках/БЗ Платрума/документах) ──
// Живёт в отдельном файле .chatKnowledge.md на проде (в .gitignore): его
// регенерирует ночной цикл обучения БЕЗ деплоя кода. Подхватывается по mtime.
// В запрос уходит вторым system-блоком с prompt caching (cache_control) —
// повторные сообщения диалога почти не дорожают.
const KNOWLEDGE_FILE = path.join(__dirname, ".chatKnowledge.md");
let _knowledge = { text: "", mtime: 0 };
function knowledge() {
  try {
    const st = fs.statSync(KNOWLEDGE_FILE);
    if (st.mtimeMs !== _knowledge.mtime) {
      _knowledge = { text: fs.readFileSync(KNOWLEDGE_FILE, "utf8"), mtime: st.mtimeMs };
      console.log("CHAT: база знаний перечитана (" + Math.round(_knowledge.text.length / 1000) + "К знаков)");
    }
  } catch (_) { _knowledge = { text: "", mtime: 0 }; }
  return _knowledge.text;
}

// ── Системный промпт (продающий консультант) ────────────────────────────────
const SYSTEM = [
  "Ты — Анастасия, специалист визового центра VSC (Visa Service Center, входит в VOYO). Ты общаешься с клиентом от лица компании как живой сотрудник поддержки. Компания помогает оформлять визы: шенген, США, Великобритания, страны Азии и другие направления — от подбора типа визы и сбора документов до записи в визовые центры и сопровождения на всех этапах.",
  "",
  "ТВОЯ ГЛАВНАЯ ЗАДАЧА — помочь клиенту и превратить обращение в заявку:",
  "1) Ответь по существу на любой вопрос по визам: сориентируй человека по его ситуации, условиям, срокам и рискам, честно и понятно.",
  "2) Подбери лучший вариант оформления именно под его случай и объясни, чем поможет VSC (экономия времени, снижение риска отказа, корректные документы, запись, сопровождение).",
  "3) Возьми контакт для связи — это ключевой результат диалога.",
  "",
  "КАК БРАТЬ КОНТАКТ:",
  "- Сначала дай пользу (1–2 содержательных ответа), затем ОДИН раз предложи оставить телефон, WhatsApp или Telegram, чтобы менеджер подготовил расчёт и список документов. Формулируй как заботу и выгоду, а не требование.",
  "- НЕ проси контакт в каждом сообщении. Если клиент проигнорировал просьбу — продолжай помогать и вернись к контакту через 2–3 сообщения, другим заходом (например: «могу прислать список документов на WhatsApp»).",
  "- Если клиент сначала хочет ответ — сначала дай пользу (короткий полезный ответ), затем предложи контакт.",
  "- Как только клиент оставил телефон/WhatsApp/Telegram (или имя, страну, детали) — СРАЗУ вызови инструмент save_lead и обновляй его по мере появления новых деталей. Никогда не показывай клиенту, что что-то сохраняешь.",
  "- Если клиент не готов делиться контактом — не дави, продолжай помогать и предложи ещё раз позже.",
  "",
  "СТИЛЬ:",
  "- Держись роли специалиста VSC. Не сообщай, что ты ИИ, бот, нейросеть или ассистент, и не упоминай Anthropic/Claude. Если спросят напрямую — мягко скажи, что помогаешь с визами от лица VSC, и переведи разговор на суть вопроса и помощь менеджера.",
  "- ГЛАВНОЕ ПРАВИЛО: отвечай ТОЛЬКО на заданный вопрос. 1–3 коротких предложения, до ~350 знаков. НЕ рассказывай цены, сроки, условия и нюансы, пока о них не спросили — у тебя ещё будет случай. Не предлагай альтернативные страны без запроса.",
  "- РОВНО ОДИН вопрос за сообщение. НИКОГДА не задавай два и больше вопросов и не оформляй вопросы списком — это анкета, а не диалог. Квалифицируй по шагам: сообщение — вопрос про даты; следующее — сколько человек; потом — была ли виза; и т.д. Начинай с самого важного для этой страны.",
  "- Пока задаёшь уточняющие вопросы — контакт НЕ проси. Попроси один раз ПОСЛЕ того, как клиент ответил на 2–3 вопроса, как естественный следующий шаг: «давайте я передам менеджеру, оставьте WhatsApp».",
  "- ПРИМЕР. Клиент: «Визу испанскую делаете?» ПЛОХО: абзац про сложности + список условий с ценами + альтернативы + просьба контакта. ХОРОШО: «Да, оформляем. Сразу скажу: с записью в Испанию сейчас непросто, слоты открываются пару раз в месяц. На какие даты планируете поездку?»",
  "- Список — только если клиент прямо спросил «что нужно / какие документы / сколько стоит». И даже тогда до 5 пунктов, без вступлений и «важных моментов» пачкой.",
  "- НИКОГДА не используй длинное тире (—) и полудлинное (–). Только простая пунктуация: запятая, точка, обычный дефис. Не задавай один и тот же вопрос дважды в одном сообщении.",
  "- Один вопрос за раз. Веди диалог, а не выдавай простыню.",
  "- ЗНАНИЯ: если ниже есть отдельный блок «База знаний VSC» — это твой главный источник (реальные цены, сроки, условия, пакеты документов, стиль менеджеров из настоящих сделок). Опирайся на него уверенно. Чего в базе нет — не выдумывай: скажи, что менеджер уточнит точную цифру.",
  "- Про записи в визовые центры и сроки: ситуация меняется, поэтому подавай как «по состоянию на сегодня» и говори, что менеджер подтвердит актуальное при связи. Не обещай конкретных дат записи.",
  "- Не давай юридических гарантий одобрения визы. Отказ — всегда риск, но VSC помогает его минимизировать.",
  "- Не обсуждай ничего, кроме виз и связанных услуг; вежливо возвращай разговор к делу.",
].join("\n");

const TOOLS = [{
  name: "save_lead",
  description: "Сохранить контакт и запрос клиента. Вызывай СРАЗУ, как только клиент оставил телефон, WhatsApp, Telegram или назвал имя/страну/детали поездки. Вызывай повторно при появлении новых данных, чтобы дополнить карточку. Клиенту про сохранение не сообщай.",
  input_schema: {
    type: "object",
    properties: {
      name: { type: "string", description: "Имя клиента, если назвал" },
      contact: { type: "string", description: "Телефон в любом формате или username/ссылка на WhatsApp/Telegram" },
      contact_type: { type: "string", enum: ["phone", "whatsapp", "telegram", "other"], description: "Тип контакта" },
      country: { type: "string", description: "Страна/тип визы, которая интересует (например: Шенген (Италия), США B1/B2)" },
      details: { type: "string", description: "Кратко: ситуация клиента, цель поездки, сроки, важные детали" },
    },
    required: [],
  },
}];

// Причёсываем историю из браузера в формат Anthropic; режем длину/размер.
function sanitizeMessages(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const m of raw) {
    if (!m || (m.role !== "user" && m.role !== "assistant")) continue;
    const text = String(m.content || "").slice(0, MAX_MSG_LEN);
    if (!text.trim()) continue;
    out.push({ role: m.role, content: text });
  }
  // Оставляем последние MAX_TURNS*2 сообщений, диалог должен начинаться с user.
  const trimmed = out.slice(-MAX_TURNS * 2);
  while (trimmed.length && trimmed[0].role !== "user") trimmed.shift();
  return trimmed;
}

async function reply(messages, sessionId, meta) {
  const c = client();
  if (!c) throw new Error("ИИ не настроен: добавьте ANTHROPIC_API_KEY в .env на сервере");
  const convo = messages.slice();
  let text = "";
  // Агентный цикл: модель может вызвать save_lead, мы сохраняем и продолжаем.
  for (let step = 0; step < 4; step++) {
    const kn = knowledge();
    const system = kn
      ? [
          { type: "text", text: SYSTEM },
          { type: "text", text: kn, cache_control: { type: "ephemeral" } },
        ]
      : SYSTEM;
    const msg = await c.messages.create({
      model: MODEL,
      max_tokens: 1024,
      system,
      tools: TOOLS,
      messages: convo,
    });
    for (const b of msg.content) if (b.type === "text") text += b.text;
    const toolUses = msg.content.filter((b) => b.type === "tool_use");
    if (msg.stop_reason !== "tool_use" || !toolUses.length) break;
    convo.push({ role: "assistant", content: msg.content });
    const results = [];
    for (const tu of toolUses) {
      if (tu.name === "save_lead") {
        try { upsertLead(sessionId, tu.input || {}, meta); } catch (e) { console.error("chat save_lead:", e.message); }
      }
      results.push({ type: "tool_result", tool_use_id: tu.id, content: "ok" });
    }
    convo.push({ role: "user", content: results });
  }
  // Страховка от «почерка ИИ»: длинные тире до клиента не доходят даже если модель их поставила
  text = text.replace(/\s[—–]\s/g, ", ").replace(/[—–]/g, "-");
  return text.trim() || "Извините, не расслышал. Уточните, пожалуйста, по какой стране планируете визу?";
}

// ── CSV-выгрузка лидов ──────────────────────────────────────────────────────
function csvCell(v) {
  const s = v == null ? "" : String(v);
  return /[",\n;]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
function leadsToCsv(leads) {
  const rows = Object.values(leads).sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
  const head = ["Дата", "Имя", "Контакт", "Тип", "Страна/виза", "Детали", "IP"];
  const lines = [head.join(";")];
  for (const l of rows) {
    lines.push([
      l.updatedAt || l.createdAt || "", l.name || "", l.contact || "",
      l.contact_type || "", l.country || "", l.details || "", l.ip || "",
    ].map(csvCell).join(";"));
  }
  return "﻿" + lines.join("\n"); // BOM — чтобы Excel понял кириллицу в UTF-8
}

// ── Монтирование маршрутов ──────────────────────────────────────────────────
function mount(app, deps) {
  deps = deps || {};
  const requireAdmin = deps.requireAdmin || ((req, res) => res.status(401).json({ success: false, message: "Не авторизован" }));

  app.get("/chat_test", (req, res) => {
    res.set("Cache-Control", "no-store, no-cache, must-revalidate");
    res.sendFile(path.join(__dirname, "public", "chat_test.html"));
  });

  app.post("/api/chat_test/message", async (req, res) => {
    try {
      if (!aiConfigured()) return res.status(503).json({ success: false, message: "Консультант временно недоступен. Оставьте телефон — мы перезвоним." });
      const body = req.body || {};
      if (ACCESS_CODE && String(body.code || "").trim() !== ACCESS_CODE) {
        return res.status(401).json({ success: false, needCode: true, message: "Нужен код доступа" });
      }
      let sessionId = String(body.sessionId || "").trim();
      if (!/^[a-zA-Z0-9_-]{6,64}$/.test(sessionId)) sessionId = "s_" + crypto.randomBytes(9).toString("hex");
      const messages = sanitizeMessages(body.messages);
      if (!messages.length) return res.status(400).json({ success: false, message: "Пустой запрос" });
      const meta = {
        ip: (req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").toString().split(",")[0].trim(),
        ua: req.headers["user-agent"] || "",
      };
      const t0 = Date.now();
      const text = await reply(messages, sessionId, meta);
      // «человеческая» пауза: ответ не должен прилетать мгновенно, как из пушки.
      // Целевое время ~ как будто человек печатает: база + по длине, потолок 10с.
      const target = Math.min(3000 + text.length * 30, 10000);
      const waitMs = target - (Date.now() - t0);
      if (waitMs > 0) await new Promise((r) => setTimeout(r, waitMs));
      res.json({ success: true, reply: text, sessionId });
    } catch (e) {
      console.error("chat /message:", e.message);
      res.status(500).json({ success: false, message: "Не получилось ответить прямо сейчас. Оставьте телефон или напишите в WhatsApp — менеджер свяжется." });
    }
  });

  // ── Wazzup: приёмник вебхуков (копим переписку для обучения чата) ────────
  // ВАЖНО: до нас вебхук Wazzup указывал на Google Apps Script (старый поток
  // логирования). Мы его НЕ ломаем: всё пришедшее ретранслируем туда же 1:1.
  // Откат: PATCH https://api.wazzup24.com/v3/webhooks на WAZZUP_RELAY_URL.
  const WAZZUP_INBOX = path.join(__dirname, ".wazzupInbox.ndjson");
  const WAZZUP_KEY = process.env.WAZZUP_HOOK_KEY || ""; // секрет в query ?k=
  const WAZZUP_RELAY = process.env.WAZZUP_RELAY_URL || "";
  function wazzupRelay(body, attempt) {
    if (!WAZZUP_RELAY) return;
    attempt = attempt || 1;
    const https = require("https");
    const data = JSON.stringify(body);
    const post = (urlStr, hops) => {
      const u = new URL(urlStr);
      const r = https.request(
        { host: u.host, path: u.pathname + u.search, method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) }, timeout: 25000 },
        (resp) => {
          resp.resume();
          // Google Script отвечает редиректом — идём за ним, чтобы скрипт реально выполнился
          if ([301, 302, 303, 307, 308].includes(resp.statusCode) && resp.headers.location && hops < 3) {
            const next = new URL(resp.headers.location, urlStr).toString();
            const g = https.get(next, (r2) => r2.resume());
            g.on("error", () => {});
            return;
          }
          if (resp.statusCode >= 400) retry();
        }
      );
      r.on("error", retry);
      r.on("timeout", () => { r.destroy(); retry(); });
      r.end(data);
    };
    const retry = () => {
      if (attempt >= 3) {
        console.error("wazzup relay: не доставлено в Google Script после 3 попыток");
        // копим недоставленное для повторной отправки (ночной цикл дошлёт)
        try { fs.appendFileSync(path.join(__dirname, ".wazzupRelayFailed.ndjson"), JSON.stringify({ t: new Date().toISOString(), b: body }) + "\n"); } catch (e) {}
        return;
      }
      setTimeout(() => wazzupRelay(body, attempt + 1), attempt * 15000);
    };
    try { post(WAZZUP_RELAY, 0); } catch (e) { retry(); }
  }
  app.post("/api/wazzup/webhook", (req, res) => {
    if (WAZZUP_KEY && String(req.query.k || "") !== WAZZUP_KEY) return res.status(403).json({ success: false });
    res.status(200).json({ ok: true }); // Wazzup ждёт 200 в течение 30с — отвечаем сразу
    try {
      const body = req.body || {};
      if (body && body.test) return; // тестовый пинг Wazzup не пишем и не ретранслируем
      fs.appendFileSync(WAZZUP_INBOX, JSON.stringify({ t: new Date().toISOString(), b: body }) + "\n");
      wazzupRelay(body);
    } catch (e) { console.error("wazzup hook:", e.message); }
  });

  // Выгрузка лидов — только админ (код 280992).
  app.get("/api/chat_test/leads", requireAdmin, (req, res) => {
    const leads = loadLeads();
    if (String(req.query.format || "").toLowerCase() === "csv") {
      res.set("Content-Type", "text/csv; charset=utf-8");
      res.set("Content-Disposition", 'attachment; filename="chat-leads.csv"');
      return res.send(leadsToCsv(leads));
    }
    const rows = Object.values(leads).sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
    res.json({ success: true, count: rows.length, leads: rows });
  });

  console.log("CHAT: /chat_test смонтирован (модель " + MODEL + ", ИИ " + (aiConfigured() ? "настроен" : "НЕ настроен") + ")");
}

module.exports = { mount };
