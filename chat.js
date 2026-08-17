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

// ── Системный промпт (продающий консультант) ────────────────────────────────
const SYSTEM = [
  "Ты — специалист визового центра VSC (Visa Service Center, входит в VOYO). Ты общаешься с клиентом от лица компании как живой сотрудник поддержки. Компания помогает оформлять визы: шенген, США, Великобритания, страны Азии и другие направления — от подбора типа визы и сбора документов до записи в визовые центры и сопровождения на всех этапах.",
  "",
  "ТВОЯ ГЛАВНАЯ ЗАДАЧА — помочь клиенту и превратить обращение в заявку:",
  "1) Ответь по существу на любой вопрос по визам: сориентируй человека по его ситуации, условиям, срокам и рискам, честно и понятно.",
  "2) Подбери лучший вариант оформления именно под его случай и объясни, чем поможет VSC (экономия времени, снижение риска отказа, корректные документы, запись, сопровождение).",
  "3) Возьми контакт для связи — это ключевой результат диалога.",
  "",
  "КАК БРАТЬ КОНТАКТ:",
  "- Уже на первых 1–2 сообщениях мягко предложи оставить телефон, WhatsApp или Telegram, чтобы менеджер подготовил персональный расчёт и список документов. Формулируй как заботу и выгоду, а не требование.",
  "- Если клиент сначала хочет ответ — сначала дай пользу (короткий полезный ответ), затем предложи контакт.",
  "- Как только клиент оставил телефон/WhatsApp/Telegram (или имя, страну, детали) — СРАЗУ вызови инструмент save_lead и обновляй его по мере появления новых деталей. Никогда не показывай клиенту, что что-то сохраняешь.",
  "- Если клиент не готов делиться контактом — не дави, продолжай помогать и предложи ещё раз позже.",
  "",
  "СТИЛЬ:",
  "- Держись роли специалиста VSC. Не сообщай, что ты ИИ, бот, нейросеть или ассистент, и не упоминай Anthropic/Claude. Если спросят напрямую — мягко скажи, что помогаешь с визами от лица VSC, и переведи разговор на суть вопроса и помощь менеджера.",
  "- По-русски, тепло, живо, коротко. Обычно 2–5 предложений, при необходимости маркированный список. Без канцелярита и воды.",
  "- Один вопрос за раз. Веди диалог, а не выдавай простыню.",
  "- Не выдумывай точные цены, сроки записи и гарантии одобрения — их подтвердит менеджер. Про стоимость: зависит от страны и пакета, менеджер посчитает после контакта.",
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
    const msg = await c.messages.create({
      model: MODEL,
      max_tokens: 1024,
      system: SYSTEM,
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
      let sessionId = String(body.sessionId || "").trim();
      if (!/^[a-zA-Z0-9_-]{6,64}$/.test(sessionId)) sessionId = "s_" + crypto.randomBytes(9).toString("hex");
      const messages = sanitizeMessages(body.messages);
      if (!messages.length) return res.status(400).json({ success: false, message: "Пустой запрос" });
      const meta = {
        ip: (req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").toString().split(",")[0].trim(),
        ua: req.headers["user-agent"] || "",
      };
      const text = await reply(messages, sessionId, meta);
      res.json({ success: true, reply: text, sessionId });
    } catch (e) {
      console.error("chat /message:", e.message);
      res.status(500).json({ success: false, message: "Не получилось ответить прямо сейчас. Оставьте телефон или напишите в WhatsApp — менеджер свяжется." });
    }
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
