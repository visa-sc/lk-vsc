// ── Переводы документов для визового агентства (проект Зайцевой, 07.08.2026) ──
// Отдельный модуль, монтируется из server.js: страница /translate + API + бот
// Яндекс Мессенджера (тихий режим). НЕ касается клиентского ЛК и amoCRM.
//
// Пайплайн заказа: файлы (PDF/фото) → Claude (перевод с сохранением структуры,
// HTML) → DOCX (html-to-docx) → второй проход Claude «агент-проверщик» (сверка
// цифр/дат/ФИО, JSON-отчёт). Отдельно: загрузка перевода человека → третий
// проход «сравнение ИИ vs человек» (для этапа обучения по плану Кати).
//
// Бот (Шаг 2 плана): если задан YM_BOT_TOKEN — long-polling getUpdates Bot API
// Яндекс Мессенджера. Бот ТОЛЬКО ЧИТАЕТ чат переводов (наружу ничего не пишет):
// файл в корне чата = заказ девочек → фоновый перевод ИИ; файл ответом в ветке
// (thread) того же заказа = результат переводчика → автосравнение. Все
// увиденные чаты копятся в состоянии — их id видно на странице (для
// YM_TRANSLATE_CHAT_ID).
//
// env: ANTHROPIC_API_KEY (обязателен для ИИ), ANTHROPIC_BASE_URL (опц., для
// прокси-провайдеров с рублёвой оплатой), TRANSLATE_MODEL (дефолт claude-opus-5),
// YM_BOT_TOKEN (опц.), YM_TRANSLATE_CHAT_ID (опц. — ограничить одним чатом).
//
// Хранилище: .translate/orders.json + .translate/files/* (gitignore, ПДн клиентов).

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const multer = require("multer");
const axios = require("axios");

const DIR = path.join(__dirname, ".translate");
const FILES_DIR = path.join(DIR, "files");
const STORE_FILE = path.join(DIR, "orders.json");

const MAX_ORDERS = 500;
const MAX_TOTAL_SRC = 20 * 1024 * 1024; // base64 раздувает ×1.33, лимит API — 32MB на запрос

function ensureDirs() {
  try { fs.mkdirSync(FILES_DIR, { recursive: true }); } catch (_) {}
}

let _store = null;
function store() {
  if (_store) return _store;
  try { _store = JSON.parse(fs.readFileSync(STORE_FILE, "utf8")); } catch (_) { _store = null; }
  if (!_store || !Array.isArray(_store.orders)) _store = { orders: [], bot: { offset: 0, chats: {} } };
  if (!_store.bot) _store.bot = { offset: 0, chats: {} };
  return _store;
}
function save() {
  ensureDirs();
  try { fs.writeFileSync(STORE_FILE, JSON.stringify(store(), null, 2), "utf8"); } catch (e) { console.error("translate save:", e.message); }
}

function newId() { return crypto.randomBytes(6).toString("hex"); }
function findOrder(id) { return store().orders.find((o) => o.id === id) || null; }

// ── Файлы ─────────────────────────────────────────────────────────────────
function extOf(name, mime) {
  const e = path.extname(String(name || "")).toLowerCase();
  if (e) return e;
  if (/pdf/.test(mime)) return ".pdf";
  if (/png/.test(mime)) return ".png";
  if (/webp/.test(mime)) return ".webp";
  if (/gif/.test(mime)) return ".gif";
  return ".jpg";
}
function saveFile(orderId, tag, buf, name, mime) {
  ensureDirs();
  const fn = orderId + "-" + tag + extOf(name, mime || "");
  fs.writeFileSync(path.join(FILES_DIR, fn), buf);
  return fn;
}
function readFileBuf(fn) { return fs.readFileSync(path.join(FILES_DIR, fn)); }

function mimeByExt(fn) {
  const e = path.extname(fn).toLowerCase();
  return { ".pdf": "application/pdf", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif", ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document", ".html": "text/html; charset=utf-8" }[e] || "application/octet-stream";
}

// Контент-блоки Claude из исходников заказа (PDF → document, фото → image).
function srcBlocks(order) {
  const blocks = [];
  for (const f of order.src) {
    const buf = readFileBuf(f.file);
    const mime = mimeByExt(f.file);
    if (mime === "application/pdf") {
      blocks.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data: buf.toString("base64") } });
    } else if (/^image\//.test(mime)) {
      blocks.push({ type: "image", source: { type: "base64", media_type: mime, data: buf.toString("base64") } });
    }
  }
  return blocks;
}

// ── Claude ────────────────────────────────────────────────────────────────
function aiConfigured() { return !!process.env.ANTHROPIC_API_KEY; }
let _client = null;
function client() {
  if (!aiConfigured()) return null;
  if (!_client) {
    const { Anthropic } = require("@anthropic-ai/sdk");
    _client = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY,
      baseURL: process.env.ANTHROPIC_BASE_URL || undefined,
      timeout: 15 * 60 * 1000, maxRetries: 2,
    });
  }
  return _client;
}
function model() { return process.env.TRANSLATE_MODEL || "claude-opus-5"; }

async function runClaude(params) {
  const c = client();
  if (!c) throw new Error("ИИ не настроен: добавьте ANTHROPIC_API_KEY в .env на сервере");
  const stream = c.messages.stream(params);
  const msg = await stream.finalMessage();
  if (msg.stop_reason === "refusal") throw new Error("Модель отклонила запрос (safety refusal)" + (msg.stop_details && msg.stop_details.explanation ? ": " + msg.stop_details.explanation : ""));
  if (msg.stop_reason === "max_tokens") throw new Error("Ответ модели обрезан по лимиту токенов — попробуйте разбить документ на части");
  let text = "";
  for (const b of msg.content) if (b.type === "text") text += b.text;
  return { text, usage: msg.usage };
}

// JSON из ответа модели: structured outputs гарантируют чистый JSON, но на
// прокси-провайдерах output_config может не поддерживаться — парсим толерантно.
function parseJsonLoose(text) {
  try { return JSON.parse(text); } catch (_) {}
  const m = String(text).match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch (_) {} }
  return null;
}
// Вызов с JSON-схемой; если провайдер не понял output_config — повтор без него.
async function runClaudeJson(params, schema) {
  try {
    const r = await runClaude(Object.assign({}, params, { output_config: { format: { type: "json_schema", schema } } }));
    const j = parseJsonLoose(r.text);
    if (j) return { json: j, usage: r.usage };
  } catch (e) {
    if (!(e && e.status === 400)) throw e;
    console.warn("translate: output_config не принят провайдером, повтор без схемы:", e.message);
  }
  const r2 = await runClaude(params);
  return { json: parseJsonLoose(r2.text), usage: r2.usage };
}

function langName(code) { return code === "en" ? "английский" : (code || "английский"); }

const CHECK_SCHEMA = {
  type: "object", additionalProperties: false,
  required: ["verdict", "summary", "issues"],
  properties: {
    verdict: { type: "string", enum: ["ok", "warnings", "errors"] },
    summary: { type: "string" },
    issues: {
      type: "array",
      items: {
        type: "object", additionalProperties: false,
        required: ["severity", "where", "note"],
        properties: {
          severity: { type: "string", enum: ["critical", "warning", "info"] },
          where: { type: "string" },
          original: { type: "string" },
          translated: { type: "string" },
          note: { type: "string" },
        },
      },
    },
  },
};

const COMPARE_SCHEMA = {
  type: "object", additionalProperties: false,
  required: ["verdict", "summary", "differences"],
  properties: {
    verdict: { type: "string", enum: ["match", "minor", "major"] },
    summary: { type: "string" },
    differences: {
      type: "array",
      items: {
        type: "object", additionalProperties: false,
        required: ["kind", "severity", "note"],
        properties: {
          kind: { type: "string", enum: ["number", "date", "name", "omission", "meaning", "style", "format", "other"] },
          severity: { type: "string", enum: ["critical", "warning", "info"] },
          ai: { type: "string" },
          human: { type: "string" },
          note: { type: "string" },
        },
      },
    },
  },
};

// ── Пайплайн перевода ─────────────────────────────────────────────────────
async function pipelineTranslate(order) {
  order.status = "translating"; order.error = null; save();
  const p = order.params || {};
  const sys = [
    "Ты — профессиональный переводчик официальных документов для визового агентства (справки о движении средств, выписки, свидетельства, паспорта и т.п.).",
    "Переводишь с русского на " + langName(p.targetLang) + " язык по стандартам сертифицированного перевода для подачи на визу:",
    "- Сохраняй структуру документа максимально близко к оригиналу: таблицы — таблицами (<table>), шапки, реквизиты, порядок строк.",
    "- ВСЕ числа, суммы, даты, номера счетов/документов переноси АБСОЛЮТНО точно, ничего не округляй и не пропускай. Формат дат сохраняй как в оригинале.",
    "- Печати, штампы, подписи, логотипы оформляй пометами в квадратных скобках: [Signature], [Round seal: ...], [Stamp: ...], [Logo].",
    "- Неразборчивый текст помечай [illegible].",
    "- Ничего не добавляй от себя и не комментируй.",
    "Формат ответа: ТОЛЬКО HTML-фрагмент без markdown и без ```-ограждений.",
    "Каждая страница оригинала — отдельный <section class=\"page\"> (после каждой секции перевод продолжается со следующей страницы).",
    "В начале первой страницы добавь строку-заголовок вида: <p class=\"tr-note\"><i>Translation from Russian into English</i></p> (язык подставь по факту).",
    "Используй простой HTML: h3/p/table/tr/td/b/i, таблицам добавляй border=\"1\" cellspacing=\"0\" cellpadding=\"4\".",
  ].join("\n");
  const userText = [
    "Переведи приложенный документ полностью, страница за страницей.",
    p.translit ? "Транслитерация ФИО клиента (использовать именно её): " + p.translit : "",
    p.country ? "Направление подачи (страна): " + p.country : "",
    p.note ? "Комментарий к заказу: " + p.note : "",
    order.chat && order.chat.text ? "Исходное сообщение заказа из рабочего чата (контекст): " + order.chat.text : "",
  ].filter(Boolean).join("\n");

  const r = await runClaude({
    model: model(), max_tokens: 60000,
    system: sys,
    messages: [{ role: "user", content: [...srcBlocks(order), { type: "text", text: userText }] }],
  });
  let html = r.text.trim().replace(/^```(?:html)?\s*/i, "").replace(/```\s*$/i, "");
  order.resultHtmlRaw = null;
  const fullHtml = "<!DOCTYPE html><html><head><meta charset=\"utf-8\"><title>Перевод</title><style>body{font-family:'Times New Roman',serif;max-width:820px;margin:24px auto;padding:0 16px;color:#111}table{border-collapse:collapse;width:100%;margin:8px 0}td,th{border:1px solid #444;padding:4px 6px;font-size:13px}section.page{page-break-after:always;margin-bottom:36px;border-bottom:1px dashed #bbb;padding-bottom:24px}.tr-note{color:#333}</style></head><body>" + html + "</body></html>";
  order.files = order.files || {};
  order.files.html = saveFile(order.id, "result", Buffer.from(fullHtml, "utf8"), "result.html", "text/html");

  // DOCX
  try {
    const HTMLtoDOCX = require("html-to-docx");
    const docxBuf = await HTMLtoDOCX(fullHtml, null, { table: { row: { cantSplit: true } }, font: "Times New Roman", fontSize: 24 });
    order.files.docx = saveFile(order.id, "result", Buffer.from(docxBuf), "result.docx", "");
  } catch (e) {
    console.error("translate docx:", e.message);
    order.docxError = "DOCX не собрался: " + e.message;
  }
  order.usage = order.usage || {};
  order.usage.translate = r.usage;
  order.status = "checking"; save();

  // Проверка вторым проходом
  const checkSys = "Ты — придирчивый редактор-контролёр переводов официальных документов. Тебе дан оригинал документа и перевод. Найди ВСЕ расхождения: неверные/пропущенные цифры, суммы, даты, номера, ошибки транслитерации ФИО, пропущенные строки/страницы, смысловые ошибки. Мелкие стилистические замечания помечай как info. Отвечай строго JSON по схеме: {verdict: ok|warnings|errors, summary: краткий итог по-русски, issues: [{severity: critical|warning|info, where, original, translated, note}]}. Если всё точно — verdict ok и пустой issues.";
  const chk = await runClaudeJson({
    model: model(), max_tokens: 16000,
    system: checkSys,
    messages: [{ role: "user", content: [...srcBlocks(order), { type: "text", text: "Вот перевод, который нужно проверить против оригинала выше:\n\n" + html + (p.translit ? "\n\nЗаявленная транслитерация ФИО: " + p.translit : "") }] }],
  }, CHECK_SCHEMA);
  order.check = chk.json || { verdict: "warnings", summary: "Не удалось разобрать отчёт проверки", issues: [] };
  order.usage.check = chk.usage;
  order.status = "done"; order.doneAt = Date.now(); save();
}

// ── Сравнение с переводом человека ────────────────────────────────────────
async function pipelineCompare(order) {
  order.compare = null; order.compareStatus = "processing"; save();
  const humanFn = order.files && order.files.human;
  if (!humanFn) throw new Error("нет файла перевода человека");
  const mime = mimeByExt(humanFn);
  const content = [];
  let humanNote = "";
  if (/wordprocessingml/.test(mime)) {
    const mammoth = require("mammoth");
    const res = await mammoth.extractRawText({ buffer: readFileBuf(humanFn) });
    humanNote = "Перевод человека (текст извлечён из DOCX):\n\n" + res.value;
  } else if (mime === "application/pdf") {
    content.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data: readFileBuf(humanFn).toString("base64") } });
    humanNote = "Перевод человека приложен файлом (PDF выше, последний документ).";
  } else if (/^image\//.test(mime)) {
    content.push({ type: "image", source: { type: "base64", media_type: mime, data: readFileBuf(humanFn).toString("base64") } });
    humanNote = "Перевод человека приложен изображением (последнее фото).";
  } else {
    humanNote = "Перевод человека (текст):\n\n" + readFileBuf(humanFn).toString("utf8");
  }
  let aiHtml = "";
  try { aiHtml = readFileBuf(order.files.html).toString("utf8"); } catch (_) {}
  aiHtml = aiHtml.replace(/^[\s\S]*?<body>/, "").replace(/<\/body>[\s\S]*$/, "");

  const sys = "Ты — эксперт по качеству переводов официальных документов. Сравни два перевода одного документа: перевод ИИ и перевод человека-переводчика. Оригинал тоже приложен. Определи все содержательные расхождения (цифры, даты, ФИО, пропуски, смысл) и заметные стилистические. Оцени, есть ли у человека то, чего не хватает у ИИ, и наоборот. Отвечай строго JSON: {verdict: match|minor|major, summary: развёрнутый вывод по-русски (какой перевод точнее и почему), differences: [{kind: number|date|name|omission|meaning|style|format|other, severity: critical|warning|info, ai, human, note}]}.";
  const cmp = await runClaudeJson({
    model: model(), max_tokens: 16000,
    system: sys,
    messages: [{ role: "user", content: [...srcBlocks(order), ...content, { type: "text", text: "Перевод ИИ (HTML):\n\n" + aiHtml + "\n\n---\n\n" + humanNote }] }],
  }, COMPARE_SCHEMA);
  order.compare = cmp.json || { verdict: "minor", summary: "Не удалось разобрать отчёт сравнения", differences: [] };
  order.usage = order.usage || {};
  order.usage.compare = cmp.usage;
  order.compareStatus = "done"; save();
}

// Последовательная очередь: тяжёлые вызовы не гоняем параллельно.
let _chain = Promise.resolve();
function enqueue(label, fn) {
  _chain = _chain.then(fn).catch((e) => { console.error("translate queue [" + label + "]:", e && e.message); });
}
function queueTranslate(order) {
  order.status = "queued"; order.error = null; save();
  enqueue("translate " + order.id, async () => {
    const o = findOrder(order.id);
    if (!o) return;
    try { await pipelineTranslate(o); }
    catch (e) { o.status = "error"; o.error = String((e && e.message) || e); save(); }
  });
}
function queueCompare(order) {
  enqueue("compare " + order.id, async () => {
    const o = findOrder(order.id);
    if (!o) return;
    try { await pipelineCompare(o); }
    catch (e) { o.compareStatus = "error"; o.compareError = String((e && e.message) || e); save(); }
  });
}

// ── Бот Яндекс Мессенджера (тихий режим — только читаем) ──────────────────
const YM_API = "https://botapi.messenger.yandex.net/bot/v1";
function botConfigured() { return !!process.env.YM_BOT_TOKEN; }
function ymHeaders() { return { Authorization: "OAuth " + process.env.YM_BOT_TOKEN }; }

async function ymGetFile(fileId) {
  const r = await axios.post(YM_API + "/messages/getFile/", { file_id: fileId }, { headers: ymHeaders(), responseType: "arraybuffer", timeout: 60000, maxContentLength: 50 * 1024 * 1024 });
  return Buffer.from(r.data);
}

// Файл из update: форматы у Bot API не зафиксированы публично — разбираем
// толерантно (file / document / images) и логируем незнакомые формы.
function ymExtractFiles(u) {
  const out = [];
  const push = (f) => { if (f && (f.id || f.file_id)) out.push({ id: f.id || f.file_id, name: f.name || f.file_name || "file", size: f.size || 0 }); };
  push(u.file); push(u.document);
  if (Array.isArray(u.images)) {
    for (const img of u.images) {
      if (Array.isArray(img)) { const best = img[img.length - 1]; push(best && Object.assign({ name: "photo.jpg" }, best)); }
      else push(img && Object.assign({ name: "photo.jpg" }, img));
    }
  }
  return out;
}

let _ymLoggedSample = 0;
async function ymHandleUpdate(u) {
  const st = store();
  const chat = u.chat || {};
  const chatId = String(chat.id || "");
  if (chatId) {
    st.bot.chats[chatId] = { type: chat.type || "", lastAt: Date.now(), lastFrom: (u.from && (u.from.display_name || u.from.login)) || "" };
  }
  const onlyChat = process.env.YM_TRANSLATE_CHAT_ID || "";
  if (u.from && u.from.robot) return;
  if (onlyChat && chatId !== onlyChat) return;
  if (!onlyChat && chat.type !== "group") return; // без пина слушаем только группы

  const files = ymExtractFiles(u);
  const threadId = u.thread_id ? String(u.thread_id) : "";
  const msgId = u.message_id ? String(u.message_id) : "";

  if (!files.length) {
    // Текст в ветке существующего заказа — дописываем контекст.
    if (threadId) {
      const o = st.orders.find((x) => x.chat && x.chat.messageId === threadId);
      if (o && u.text) { o.chat.thread = (o.chat.thread || []); o.chat.thread.push({ from: (u.from && (u.from.display_name || u.from.login)) || "", text: String(u.text).slice(0, 2000) }); save(); }
    }
    return;
  }
  if (_ymLoggedSample < 3) { _ymLoggedSample++; console.log("ymbot update с файлом (образец):", JSON.stringify(u).slice(0, 1500)); }

  // Файл ответом в ветке заказа = перевод человека → сравнение.
  if (threadId) {
    const o = st.orders.find((x) => x.chat && x.chat.messageId === threadId);
    if (o) {
      try {
        const buf = await ymGetFile(files[0].id);
        o.files = o.files || {};
        o.files.human = saveFile(o.id, "human", buf, files[0].name, "");
        o.humanName = files[0].name;
        save();
        if (o.status === "done") queueCompare(o);
        else o.pendingCompare = true, save();
      } catch (e) { console.error("ymbot human file:", e.message); }
      return;
    }
  }

  // Файл(ы) в корне чата = новый заказ на перевод.
  try {
    const order = {
      id: newId(), kind: "chat", createdAt: Date.now(), status: "new",
      params: { translit: "", country: "", targetLang: "en", note: "" },
      src: [], files: {},
      chat: { chatId, messageId: msgId, threadId, from: (u.from && (u.from.display_name || u.from.login)) || "", text: String(u.text || "").slice(0, 3000) },
    };
    // Транслитерация из текста сообщения («транслитерация: KOSTENKO MARINA»)
    const tm = order.chat.text.match(/транслитерац\w*\s*[:—-]\s*([A-ZА-Я][A-Za-zА-Яа-яЁё .-]+)/i);
    if (tm) order.params.translit = tm[1].trim();
    for (let i = 0; i < files.length && i < 10; i++) {
      const buf = await ymGetFile(files[i].id);
      order.src.push({ file: saveFile(order.id, "src-" + i, buf, files[i].name, ""), name: files[i].name });
    }
    st.orders.unshift(order);
    if (st.orders.length > MAX_ORDERS) st.orders.length = MAX_ORDERS;
    save();
    if (aiConfigured()) queueTranslate(order);
    else { order.status = "error"; order.error = "ANTHROPIC_API_KEY не настроен"; save(); }
  } catch (e) { console.error("ymbot new order:", e.message); }
}

let _ymStarted = false;
function ymStartPolling() {
  if (_ymStarted || !botConfigured()) return;
  _ymStarted = true;
  console.log("translate: бот Яндекс Мессенджера запущен (polling)");
  const tick = async () => {
    try {
      const st = store();
      const r = await axios.post(YM_API + "/messages/getUpdates/", { limit: 50, offset: st.bot.offset || 0 }, { headers: ymHeaders(), timeout: 30000 });
      const updates = (r.data && r.data.updates) || [];
      for (const u of updates) {
        st.bot.offset = Math.max(st.bot.offset || 0, Number(u.update_id || 0) + 1);
        try { await ymHandleUpdate(u); } catch (e) { console.error("ymbot handle:", e.message); }
      }
      if (updates.length) save();
      setTimeout(tick, 3000);
    } catch (e) {
      console.error("ymbot poll:", (e.response && e.response.status) || "", e.message);
      setTimeout(tick, 20000);
    }
  };
  setTimeout(tick, 5000);
}

// ── Публичное представление заказа ────────────────────────────────────────
function orderView(o, full) {
  const v = {
    id: o.id, kind: o.kind, createdAt: o.createdAt, doneAt: o.doneAt || null,
    status: o.status, error: o.error || null,
    params: o.params, srcNames: (o.src || []).map((f) => f.name),
    hasDocx: !!(o.files && o.files.docx), hasHtml: !!(o.files && o.files.html),
    docxError: o.docxError || null,
    checkVerdict: (o.check && o.check.verdict) || null,
    humanName: o.humanName || null,
    compareStatus: o.compareStatus || null, compareVerdict: (o.compare && o.compare.verdict) || null,
    compareError: o.compareError || null,
    chat: o.chat ? { from: o.chat.from, text: o.chat.text } : null,
  };
  if (full) { v.check = o.check || null; v.compare = o.compare || null; v.usage = o.usage || null; }
  return v;
}

// ── Монтирование ──────────────────────────────────────────────────────────
function mount(app, deps) {
  const getStaffFromReq = deps.getStaffFromReq;
  // Доступ: админ ИЛИ руководитель с "translate" в vscRestrict.tabs (Зайцева).
  function requireTranslate(req, res, next) {
    const s = getStaffFromReq(req);
    if (s && (s.role === "admin" || (s.vscRestrict && Array.isArray(s.vscRestrict.tabs) && s.vscRestrict.tabs.indexOf("translate") >= 0))) { req.staff = s; return next(); }
    return res.status(401).json({ success: false, message: "Нет доступа" });
  }
  const up = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024, files: 10 } });

  app.get("/translate", (req, res) => { res.set("Cache-Control", "no-store, no-cache, must-revalidate"); res.sendFile(path.join(__dirname, "public", "translate.html")); });

  app.get("/translate/api/state", requireTranslate, (req, res) => {
    const st = store();
    res.json({
      success: true,
      aiConfigured: aiConfigured(), model: model(),
      botConfigured: botConfigured(), botChatPinned: process.env.YM_TRANSLATE_CHAT_ID || null,
      botChats: st.bot.chats || {},
      orders: st.orders.map((o) => orderView(o, false)),
    });
  });

  app.post("/translate/api/order", requireTranslate, up.array("files", 10), (req, res) => {
    try {
      if (!aiConfigured()) return res.status(400).json({ success: false, message: "ИИ не настроен: добавьте ANTHROPIC_API_KEY в .env на сервере и перезапустите" });
      const files = req.files || [];
      if (!files.length) return res.status(400).json({ success: false, message: "Прикрепите файл (PDF или фото)" });
      const total = files.reduce((s, f) => s + f.size, 0);
      if (total > MAX_TOTAL_SRC) return res.status(413).json({ success: false, message: "Слишком большие файлы (лимит 20 МБ на заказ) — разбейте на части" });
      const pdfCount = files.filter((f) => /pdf/.test(f.mimetype)).length;
      if (pdfCount > 1 || (pdfCount === 1 && files.length > 1)) return res.status(400).json({ success: false, message: "Либо один PDF, либо несколько фото — не смешивайте" });
      const b = req.body || {};
      const order = {
        id: newId(), kind: "manual", createdAt: Date.now(), status: "new",
        params: {
          translit: String(b.translit || "").slice(0, 200),
          country: String(b.country || "").slice(0, 100),
          targetLang: String(b.targetLang || "en").slice(0, 40),
          note: String(b.note || "").slice(0, 1000),
        },
        src: [], files: {},
      };
      files.forEach((f, i) => {
        const name = Buffer.from(f.originalname, "latin1").toString("utf8"); // multer отдаёт имя в latin1
        order.src.push({ file: saveFile(order.id, "src-" + i, f.buffer, name, f.mimetype), name });
      });
      const st = store();
      st.orders.unshift(order);
      if (st.orders.length > MAX_ORDERS) st.orders.length = MAX_ORDERS;
      save();
      queueTranslate(order);
      return res.json({ success: true, id: order.id });
    } catch (e) { return res.status(500).json({ success: false, message: e.message }); }
  });

  app.get("/translate/api/order/:id", requireTranslate, (req, res) => {
    const o = findOrder(req.params.id);
    if (!o) return res.status(404).json({ success: false, message: "Не найден" });
    return res.json({ success: true, order: orderView(o, true) });
  });

  app.post("/translate/api/order/:id/human", requireTranslate, up.single("file"), (req, res) => {
    try {
      const o = findOrder(req.params.id);
      if (!o) return res.status(404).json({ success: false, message: "Не найден" });
      if (!req.file) return res.status(400).json({ success: false, message: "Нет файла" });
      const name = Buffer.from(req.file.originalname, "latin1").toString("utf8");
      o.files = o.files || {};
      o.files.human = saveFile(o.id, "human", req.file.buffer, name, req.file.mimetype);
      o.humanName = name;
      save();
      if (o.status === "done") queueCompare(o);
      else o.pendingCompare = true, save();
      return res.json({ success: true });
    } catch (e) { return res.status(500).json({ success: false, message: e.message }); }
  });

  app.post("/translate/api/order/:id/retry", requireTranslate, (req, res) => {
    const o = findOrder(req.params.id);
    if (!o) return res.status(404).json({ success: false, message: "Не найден" });
    if (!aiConfigured()) return res.status(400).json({ success: false, message: "ИИ не настроен (ANTHROPIC_API_KEY)" });
    queueTranslate(o);
    return res.json({ success: true });
  });

  app.delete("/translate/api/order/:id", requireTranslate, (req, res) => {
    const st = store();
    const i = st.orders.findIndex((o) => o.id === req.params.id);
    if (i < 0) return res.status(404).json({ success: false, message: "Не найден" });
    const o = st.orders[i];
    const all = [...(o.src || []).map((f) => f.file), o.files && o.files.html, o.files && o.files.docx, o.files && o.files.human].filter(Boolean);
    for (const fn of all) { try { fs.unlinkSync(path.join(FILES_DIR, fn)); } catch (_) {} }
    st.orders.splice(i, 1);
    save();
    return res.json({ success: true });
  });

  app.get("/translate/api/order/:id/file/:which", requireTranslate, (req, res) => {
    const o = findOrder(req.params.id);
    if (!o) return res.status(404).send("Не найден");
    const which = req.params.which;
    let fn = null, dlName = null;
    if (which === "docx") { fn = o.files && o.files.docx; dlName = "Перевод " + ((o.src[0] && o.src[0].name) || o.id).replace(/\.[^.]+$/, "") + ".docx"; }
    else if (which === "html") { fn = o.files && o.files.html; }
    else if (which === "human") { fn = o.files && o.files.human; dlName = o.humanName || "human"; }
    else if (/^src(\d+)$/.test(which)) { const i = Number(which.slice(3)); fn = o.src[i] && o.src[i].file; dlName = o.src[i] && o.src[i].name; }
    if (!fn) return res.status(404).send("Нет файла");
    let buf;
    try { buf = readFileBuf(fn); } catch (_) { return res.status(404).send("Файл утерян"); }
    res.set("Content-Type", mimeByExt(fn));
    if (dlName) res.set("Content-Disposition", "attachment; filename*=UTF-8''" + encodeURIComponent(dlName));
    return res.send(buf);
  });

  // Отложенные сравнения (человек прислал раньше, чем ИИ доделал) — добираем.
  setInterval(() => {
    for (const o of store().orders) {
      if (o.pendingCompare && o.status === "done" && o.compareStatus !== "processing") { o.pendingCompare = false; save(); queueCompare(o); }
    }
  }, 15000);

  ymStartPolling();
}

module.exports = { mount };
