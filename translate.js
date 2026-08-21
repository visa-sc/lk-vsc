// ── Переводы документов для визового агентства (проект Зайцевой, 07–08.08.2026) ──
// Отдельный модуль, монтируется из server.js: страница /translate + API + бот
// Яндекс Мессенджера. НЕ касается клиентского ЛК и amoCRM.
//
// Пайплайн заказа: файлы (PDF/фото/DOCX/TXT) → Claude (перевод с сохранением
// структуры, HTML) → DOCX (html-to-docx) → «агент-проверщик» (сверка цифр/дат/
// ФИО, JSON-отчёт) → при критичных замечаниях авто-исправление и повторная
// проверка. Отдельно: перевод человека → «сравнение ИИ vs человек» (обучение).
//
// Бот (YM_BOT_TOKEN, long-polling getUpdates) работает в ДВУХ режимах:
//  • АКТИВНЫЙ (все чаты по умолчанию): кинули документ → «Принял, перевожу…» →
//    перевод+проверка(+автоисправление) → DOCX и итог проверки ответом в ветку.
//    Корректировки: ответ в ветке «исправь: …» → бот правит перевод, шлёт новую
//    версию И извлекает из правки общие правила на будущее (самообучение,
//    .translate/orders.json → lessons). Команда «правила» — показать выученное.
//  • ТИХИЙ (чаты из YM_TRANSLATE_CHAT_ID, через запятую — чат переводчиц):
//    только читает: файл в корне = заказ → фоновый перевод для сравнения; файл
//    в ветке = перевод человека → автосравнение. Наружу НЕ пишет (по плану
//    Кати никто не должен знать про ИИ).
// ВАЖНО: чат переводчиц ОБЯЗАТЕЛЬНО занести в YM_TRANSLATE_CHAT_ID до
// добавления туда бота — иначе он там ответит.
//
// env: ANTHROPIC_API_KEY (обязателен для ИИ), ANTHROPIC_BASE_URL (опц., для
// прокси-провайдеров с рублёвой оплатой), TRANSLATE_MODEL (дефолт claude-opus-5),
// YM_BOT_TOKEN (опц.), YM_TRANSLATE_CHAT_ID (опц., «тихие» чаты через запятую).
//
// Хранилище: .translate/orders.json (+lessons внутри) + .translate/files/*
// (gitignore, ПДн клиентов).

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const multer = require("multer");
const axios = require("axios");

const DIR = path.join(__dirname, ".translate");
const FILES_DIR = path.join(DIR, "files");
const STORE_FILE = path.join(DIR, "orders.json");

const MAX_ORDERS = 500;
const MAX_TOTAL_SRC = 45 * 1024 * 1024; // крупные PDF режем на части сами (ensureChunks)
const MAX_LESSONS_IN_PROMPT = 40;

function ensureDirs() {
  try { fs.mkdirSync(FILES_DIR, { recursive: true }); } catch (_) {}
}

let _store = null;
function store() {
  if (_store) return _store;
  try { _store = JSON.parse(fs.readFileSync(STORE_FILE, "utf8")); } catch (_) { _store = null; }
  if (!_store || !Array.isArray(_store.orders)) _store = { orders: [], bot: { offset: 0, chats: {} }, lessons: [] };
  if (!_store.bot) _store.bot = { offset: 0, chats: {} };
  if (!Array.isArray(_store.lessons)) _store.lessons = [];
  return _store;
}
function save() {
  ensureDirs();
  try { fs.writeFileSync(STORE_FILE, JSON.stringify(store(), null, 2), "utf8"); } catch (e) { console.error("translate save:", e.message); }
}

function newId() { return crypto.randomBytes(6).toString("hex"); }
function findOrder(id) { return store().orders.find((o) => o.id === id || o.num === id) || null; }

// ── Человеческий номер заказа (просьба Зайцевой 08.08) ────────────────────
// Вид VT-0001: короткий, читается вслух, вписывается в amoCRM — по нему менеджер
// находит перевод, а Катя сшивает заказы со сверками. Сквозной счётчик в store.
function nextNum() {
  const st = store();
  st.seq = (st.seq || 0) + 1;
  return "VT-" + String(st.seq).padStart(4, "0");
}
// Разовая простановка номеров заказам, созданным до введения нумерации:
// от самых старых к новым, чтобы порядок номеров совпадал с хронологией.
function backfillNums() {
  const st = store();
  const without = st.orders.filter((o) => !o.num);
  if (!without.length) return;
  without.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0)).forEach((o) => { o.num = nextNum(); });
  save();
  console.log("translate: проставлены номера заказам:", without.length);
}

// ── «Уроки» — правила, выученные на корректировках человека ───────────────
function lessons() { return store().lessons; }
function lessonsPromptBlock() {
  const act = lessons().slice(-MAX_LESSONS_IN_PROMPT);
  if (!act.length) return "";
  return "\n\nНакопленные правила из прошлых корректировок заказчика — соблюдай их ОБЯЗАТЕЛЬНО:\n" + act.map((l) => "- " + l.text).join("\n");
}

// ── Файлы ─────────────────────────────────────────────────────────────────
function extOf(name, mime) {
  const e = path.extname(String(name || "")).toLowerCase();
  if (e) return e;
  if (/pdf/.test(mime)) return ".pdf";
  if (/png/.test(mime)) return ".png";
  if (/webp/.test(mime)) return ".webp";
  if (/gif/.test(mime)) return ".gif";
  if (/wordprocessingml/.test(mime)) return ".docx";
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
  return { ".pdf": "application/pdf", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif", ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document", ".doc": "application/msword", ".txt": "text/plain; charset=utf-8", ".html": "text/html; charset=utf-8" }[e] || "application/octet-stream";
}
// Что умеем переводить как исходник.
const SRC_EXT = [".pdf", ".jpg", ".jpeg", ".png", ".webp", ".gif", ".docx", ".txt"];
function srcSupported(name) { return SRC_EXT.indexOf(path.extname(String(name || "")).toLowerCase()) >= 0; }

// Контент-блоки Claude из исходников заказа (PDF → document, фото → image,
// DOCX/TXT → извлечённый текст). Последний блок помечаем cache_control: с этого
// места префикс (system + документ) кэшируется, и все следующие проходы по
// тому же заказу читают его по 10% цены вместо полной.
// cache = true ставим только на проходах «переводчика» (перевод → авто-исправление
// → корректировки): у них одинаковый префикс, поэтому повторные проходы читают
// документ по 10% цены. У проверки и сравнения своя JSON-схема — их префикс всё
// равно другой, там кэш только удорожил бы первый запрос на 25%.
async function srcBlocks(order, cache, files) {
  const blocks = await srcBlocksRaw(order, files);
  if (cache && blocks.length) blocks[blocks.length - 1] = Object.assign({}, blocks[blocks.length - 1], { cache_control: { type: "ephemeral" } });
  return blocks;
}
async function srcBlocksRaw(order, files) {
  const blocks = [];
  for (const f of (files || order.src)) {
    const buf = readFileBuf(f.file);
    const mime = mimeByExt(f.file);
    if (mime === "application/pdf") {
      blocks.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data: buf.toString("base64") } });
    } else if (/^image\/(jpeg|png|webp|gif)/.test(mime)) {
      blocks.push({ type: "image", source: { type: "base64", media_type: mime.split(";")[0], data: buf.toString("base64") } });
    } else if (/wordprocessingml/.test(mime)) {
      const mammoth = require("mammoth");
      const res = await mammoth.extractRawText({ buffer: buf });
      blocks.push({ type: "text", text: "Документ «" + f.name + "» (текст извлечён из DOCX; структуру таблиц восстанови по смыслу):\n\n" + res.value });
    } else if (/^text\//.test(mime)) {
      blocks.push({ type: "text", text: "Документ «" + f.name + "»:\n\n" + buf.toString("utf8") });
    }
  }
  return blocks;
}

// ── Большие документы: нарезка и пакеты ──────────────────────────────────
// Лимит API — 32 МБ на запрос, base64 раздувает файл в 1,33 раза. Держим бюджет
// одного запроса 19 МБ исходных байт; что больше — режем PDF по страницам
// (pdf-lib) и переводим частями, склеивая HTML.
const REQ_BUDGET = Number(process.env.TRANSLATE_REQ_BUDGET || 19 * 1024 * 1024);
function totalSrcSize(order) {
  try { return (order.src || []).reduce((s, f) => s + fs.statSync(path.join(FILES_DIR, f.file)).size, 0); } catch (_) { return 0; }
}
// Крупный PDF → несколько src-файлов по страницам, каждый в бюджете запроса.
async function ensureChunks(order) {
  const out = [];
  let changed = false;
  for (const f of order.src) {
    let size = 0;
    try { size = fs.statSync(path.join(FILES_DIR, f.file)).size; } catch (_) { out.push(f); continue; }
    if (!/\.pdf$/i.test(f.file) || size <= REQ_BUDGET) { out.push(f); continue; }
    const { PDFDocument } = require("pdf-lib");
    const srcDoc = await PDFDocument.load(readFileBuf(f.file), { ignoreEncryption: true });
    const n = srcDoc.getPageCount();
    // Запас 20%: страницы неравномерные, лучше больше частей, чем упавший запрос.
    const parts = Math.max(2, Math.ceil(size / (REQ_BUDGET * 0.8)));
    const per = Math.max(1, Math.ceil(n / parts));
    for (let i = 0, part = 0; i < n; i += per, part++) {
      const nd = await PDFDocument.create();
      const pages = await nd.copyPages(srcDoc, Array.from({ length: Math.min(per, n - i) }, (_, k) => i + k));
      pages.forEach((pg) => nd.addPage(pg));
      const buf = Buffer.from(await nd.save());
      const fn = saveFile(order.id, "part" + out.length + "-" + part, buf, "part.pdf", "");
      out.push({ file: fn, name: f.name + " (стр. " + (i + 1) + "–" + Math.min(i + per, n) + ")" });
    }
    changed = true;
    console.log("translate: PDF «" + f.name + "» (" + Math.round(size / 1e6) + " МБ, " + n + " стр.) нарезан на части:", parts);
  }
  if (changed) { order.srcOriginal = order.src; order.src = out; save(); }
}
// Разбивка списка исходников на пакеты «по одному запросу».
function srcBatches(order) {
  const batches = [[]];
  let cur = 0;
  for (const f of order.src) {
    let size = 0;
    try { size = fs.statSync(path.join(FILES_DIR, f.file)).size; } catch (_) {}
    if (cur > 0 && cur + size > REQ_BUDGET) { batches.push([]); cur = 0; }
    batches[batches.length - 1].push(f);
    cur += size;
  }
  return batches.filter((b) => b.length);
}

// ── Claude ────────────────────────────────────────────────────────────────
function aiConfigured() { return !!process.env.ANTHROPIC_API_KEY; }
// Канал до Anthropic: основной ретранслятор (ANTHROPIC_BASE_URL) и запасной
// (ANTHROPIC_BASE_URL_BACKUP, опц.). Переключение хранится в orders.json —
// переживает рестарт; назад на основной возвращает часовой сторож канала.
function channelState() {
  const st = store();
  if (!st.channel) st.channel = { useBackup: false, fails: 0, alertedAt: null };
  return st.channel;
}
function baseUrls() {
  return { prim: process.env.ANTHROPIC_BASE_URL || "", back: process.env.ANTHROPIC_BASE_URL_BACKUP || "" };
}
function activeBase() {
  const { prim, back } = baseUrls();
  return (channelState().useBackup && back) ? back : prim;
}
let _client = null, _clientBase = null;
function client() {
  if (!aiConfigured()) return null;
  const base = activeBase() || undefined;
  if (!_client || _clientBase !== base) {
    const { Anthropic } = require("@anthropic-ai/sdk");
    const opts = {
      apiKey: process.env.ANTHROPIC_API_KEY,
      baseURL: base,
      timeout: 15 * 60 * 1000, maxRetries: 2,
    };
    _clientBase = base;
    // Anthropic не обслуживает запросы с российских IP (403 Request not allowed),
    // прод — в РФ. TRANSLATE_PROXY = любой не-РФ http(s)/socks-прокси вида
    // http://user:pass@host:port — весь трафик к API пойдёт через него.
    if (process.env.TRANSLATE_PROXY) {
      // ВАЖНО: fetch берём тоже из undici — ProxyAgent из npm-пакета несовместим
      // со встроенным fetch Node 20 (webidl.util.markAsUncloneable is not a function).
      const undici = require("undici");
      opts.fetch = undici.fetch;
      opts.fetchOptions = { dispatcher: new undici.ProxyAgent(process.env.TRANSLATE_PROXY) };
    }
    _client = new Anthropic(opts);
  }
  return _client;
}
function model() { return process.env.TRANSLATE_MODEL || "claude-opus-5"; }
// Модель и «усердие» проверяющих проходов настраиваются отдельно: перевод —
// работа механическая (структура + точность цифр), проверка и сравнение —
// придирчивая, там экономить опаснее.
function modelCheck() { return process.env.TRANSLATE_MODEL_CHECK || model(); }
// Мелкие служебные вызовы (вывод правил из корректировок) — на дешёвой модели.
function modelSmall() { return process.env.TRANSLATE_MODEL_SMALL || "claude-haiku-4-5"; }
function effortMain() { return process.env.TRANSLATE_EFFORT || "medium"; }
function effortCheck() { return process.env.TRANSLATE_EFFORT_CHECK || "high"; }

// Общая «шапка» системного промпта одинакова во всех проходах — это условие
// работы кэша Anthropic: совпадающий префикс (system + документ) во втором и
// последующих запросах считается по 10% цены. Конкретная роль задаётся уже в
// сообщении пользователя.
const SYS_COMMON = [
  "Ты работаешь с официальными документами для визового агентства (справки о движении средств, выписки, свидетельства, паспорта и т.п.).",
  "В одном режиме ты профессиональный переводчик, в другом — придирчивый редактор-контролёр, в третьем — эксперт по качеству переводов. Конкретная задача всегда сформулирована в сообщении пользователя, следуй ей буквально.",
  "Общие требования ко всем режимам:",
  "- ВСЕ числа, суммы, даты, номера счетов и документов переносятся АБСОЛЮТНО точно, ничего не округляется и не пропускается; формат дат сохраняется как в оригинале.",
  "- Печати, штампы, подписи, логотипы обозначаются пометами в квадратных скобках: [Signature], [Round seal: ...], [Stamp: ...], [Logo]; неразборчивое — [illegible].",
  "- Ничего не добавляется от себя и не комментируется сверх задачи.",
].join("\n");

// Сетевая ли ошибка (обрыв канала/блокировка), а не ответ API.
function isNetworkError(e) {
  return !(e && e.status) && /fetch failed|network|ECONN|ETIMEDOUT|EAI_AGAIN|handshake|socket|terminated|aborted|Connection error/i.test(String((e && e.message) || e));
}
async function runClaude(params) {
  try { return await runClaudeOnce(params); }
  catch (e) {
    // Основной канал оборвался, а запасной настроен — переключаемся и повторяем.
    const { back } = baseUrls();
    const ch = channelState();
    if (isNetworkError(e) && back && !ch.useBackup) {
      console.warn("translate: основной канал не отвечает (" + e.message + ") — переключаюсь на запасной");
      ch.useBackup = true; save();
      return runClaudeOnce(params);
    }
    throw e;
  }
}
async function runClaudeOnce(params) {
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
    const r = await runClaude(Object.assign({}, params, { output_config: Object.assign({}, params.output_config, { format: { type: "json_schema", schema } }) }));
    const j = parseJsonLoose(r.text);
    if (j) return { json: j, usage: r.usage };
  } catch (e) {
    if (!(e && e.status === 400)) throw e;
    console.warn("translate: output_config не принят провайдером, повтор без схемы:", e.message);
  }
  const r2 = await runClaude(params);
  return { json: parseJsonLoose(r2.text), usage: r2.usage };
}

function langName(code) { if (code === "en" || !code) return "английский"; if (code === "other") return "язык, указанный в комментарии заказа"; return code; }
function stripFences(t) { return String(t || "").trim().replace(/^```(?:html)?\s*/i, "").replace(/```\s*$/i, ""); }

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

const LESSONS_SCHEMA = {
  type: "object", additionalProperties: false,
  required: ["lessons"],
  properties: { lessons: { type: "array", items: { type: "string" } } },
};

// ── Сборка результата (HTML + DOCX) ──────────────────────────────────────
// Альбомная ли работа: модель помечает горизонтальные страницы оригинала
// классом <section class="page landscape">. Ориентация DOCX одна на документ
// (библиотека не умеет смешанные секции) — берём по большинству страниц.
function detectLandscape(html) {
  const secs = String(html).match(/<section\b[^>]*class="[^"]*page[^"]*"[^>]*>/gi) || [];
  if (!secs.length) return false;
  const land = secs.filter((s) => /landscape/i.test(s)).length;
  return land > 0 && land * 2 >= secs.length;
}

// Доводка HTML модели под html-to-docx: процентные ширины колонок библиотека
// не переваривает (падает с Invalid XML name: @w), пиксельные — переводит в
// корректные w:tcW. Модель пишет пропорции в процентах, мы пересчитываем их в
// пиксели от печатной ширины страницы. Идемпотентно: пиксели остаются как есть.
function fitHtmlForDocx(html, landscape) {
  const pageW = landscape ? 870 : 620; // px печатной области A4 при наших полях
  return String(html)
    .replace(/width\s*:\s*([0-9.]+)\s*%/gi, (m, p) => "width:" + Math.max(20, Math.round(pageW * parseFloat(p) / 100)) + "px")
    .replace(/\s+width\s*=\s*("[0-9.]+%"|'[0-9.]+%'|[0-9.]+%)/gi, ""); // %-атрибуты роняют конвертер — убираем (любые кавычки)
}

async function buildOutputs(order, html) {
  const landscape = detectLandscape(html);
  html = fitHtmlForDocx(html, landscape);
  order.landscape = landscape;
  const fullHtml = "<!DOCTYPE html><html><head><meta charset=\"utf-8\"><title>Перевод</title><style>body{font-family:'Times New Roman',serif;max-width:" + (landscape ? 1160 : 820) + "px;margin:24px auto;padding:0 16px;color:#111}table{border-collapse:collapse;width:100%;margin:8px 0}td,th{border:1px solid #444;padding:4px 6px;font-size:13px}section.page{page-break-after:always;margin-bottom:36px;border-bottom:1px dashed #bbb;padding-bottom:24px}.tr-note{color:#333}@page{size:A4 " + (landscape ? "landscape" : "portrait") + ";margin:12mm}@media print{body{max-width:none;margin:0}section.page{border-bottom:0;margin-bottom:0;padding-bottom:0}}</style><script>if(/[?&]print=1/.test(location.search)){window.addEventListener(\"load\",function(){setTimeout(function(){window.print()},400)})}</script></head><body>" + html + "</body></html>";
  order.files = order.files || {};
  order.files.html = saveFile(order.id, "result", Buffer.from(fullHtml, "utf8"), "result.html", "text/html");
  order.docxError = null;
  try {
    const HTMLtoDOCX = require("html-to-docx");
    const docxBuf = await HTMLtoDOCX(fullHtml, null, {
      orientation: landscape ? "landscape" : "portrait",
      table: { row: { cantSplit: true } }, font: "Times New Roman", fontSize: 24,
    });
    order.files.docx = saveFile(order.id, "result", Buffer.from(docxBuf), "result.docx", "");
  } catch (e) {
    // Последний рубеж: любая незнакомая форма ширин, уронившая конвертер, —
    // собираем без ширин вообще. DOCX с авто-колонками лучше, чем без файла.
    try {
      const HTMLtoDOCX = require("html-to-docx");
      const bare = fullHtml
        .replace(/width\s*:\s*[^;"'}]+;?/gi, "")
        .replace(/\s+width\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "");
      const docxBuf = await HTMLtoDOCX(bare, null, {
        orientation: landscape ? "landscape" : "portrait",
        table: { row: { cantSplit: true } }, font: "Times New Roman", fontSize: 24,
      });
      order.files.docx = saveFile(order.id, "result", Buffer.from(docxBuf), "result.docx", "");
      order.docxError = null;
      console.warn("translate docx: собрался только после удаления ширин (" + e.message.slice(0, 60) + ")");
    } catch (e2) {
      console.error("translate docx:", e2.message);
      order.docxError = "DOCX не собрался: " + e2.message;
    }
  }
}
function currentHtml(order) {
  try { return readFileBuf(order.files.html).toString("utf8").replace(/^[\s\S]*?<body>/, "").replace(/<\/body>[\s\S]*$/, ""); } catch (_) { return ""; }
}
function docxDlName(order) {
  return "Перевод " + (((order.src[0] && order.src[0].name) || order.id).replace(/\.[^.]+$/, "")) + ".docx";
}

// ── Проверка вторым проходом ──────────────────────────────────────────────
async function runCheck(order, html, files) {
  const p = order.params || {};
  const task = [
    "РЕЖИМ: редактор-контролёр. Выше — оригинал документа, ниже — перевод. Найди ВСЕ расхождения: неверные/пропущенные цифры, суммы, даты, номера, ошибки транслитерации ФИО, пропущенные строки/страницы, смысловые ошибки. Мелкие стилистические замечания помечай как info.",
    "Отвечай строго JSON по схеме: {verdict: ok|warnings|errors, summary: краткий итог по-русски, issues: [{severity: critical|warning|info, where, original, translated, note}]}. Если всё точно — verdict ok и пустой issues.",
    p.translit ? "Заявленная транслитерация ФИО: " + p.translit : "",
    "Перевод на проверку:\n\n" + html,
  ].filter(Boolean).join("\n\n");
  return runClaudeJson({
    model: modelCheck(), max_tokens: 16000,
    system: SYS_COMMON,
    output_config: { effort: effortCheck() },
    messages: [{ role: "user", content: [...(await srcBlocks(order, false, files)), { type: "text", text: task }] }],
  }, CHECK_SCHEMA);
}

// ── Пайплайн перевода (+ авто-исправление по критичным замечаниям) ────────
async function pipelineTranslate(order) {
  order.status = "translating"; order.error = null; save();
  const p = order.params || {};
  // Инструкции переводчика живут в сообщении пользователя (после документа), а
  // не в system — так system остаётся одинаковым во всех проходах и кэш работает.
  const transTask = [
    "РЕЖИМ: переводчик. Переведи приложенный выше документ полностью, страница за страницей, с русского на " + langName(p.targetLang) + " язык по стандартам сертифицированного перевода для подачи на визу.",
    "- Сохраняй структуру документа максимально близко к оригиналу: таблицы — таблицами (<table>), шапки, реквизиты, порядок строк.",
    "Формат ответа: ТОЛЬКО HTML-фрагмент без markdown и без ```-ограждений.",
    "Каждая страница оригинала — отдельный <section class=\"page\">; если страница оригинала АЛЬБОМНАЯ (горизонтальная) — помечай её <section class=\"page landscape\">.",
    "В начале первой страницы добавь строку-заголовок вида: <p class=\"tr-note\"><i>Translation from Russian into English</i></p> (язык подставь по факту).",
    "Используй простой HTML: h3/p/table/tr/td/b/i, таблицам добавляй border=\"1\" cellspacing=\"0\" cellpadding=\"4\".",
    "Колонкам таблиц задавай ширины ПРОПОРЦИОНАЛЬНО оригиналу — в процентах, через style у ячеек ПЕРВОЙ строки: <td style=\"width:15%\">…; сумма по строке ≈ 100%. Узкие колонки (даты, суммы) не делай шире, чем в оригинале.",
    p.translit ? "Транслитерация ФИО клиента (использовать именно её): " + p.translit : "",
    p.country ? "Направление подачи (страна): " + p.country : "",
    p.note ? "Комментарий к заказу: " + p.note : "",
    order.chat && order.chat.text ? "Исходное сообщение заказа из рабочего чата (контекст): " + order.chat.text : "",
  ].filter(Boolean).join("\n") + lessonsPromptBlock();

  // Большой документ → нарезаем PDF и переводим пакетами по одному запросу.
  await ensureChunks(order);
  const batches = srcBatches(order);

  if (batches.length > 1) {
    let htmlAll = "";
    const verdicts = [], summaries = [], issuesAll = [];
    order.chunks = batches.length;
    for (let bi = 0; bi < batches.length; bi++) {
      order.status = "translating"; order.progress = (bi + 1) + "/" + batches.length; save();
      const partTask = transTask + "\n\nВАЖНО: это ЧАСТЬ " + (bi + 1) + " из " + batches.length + " большого документа (приложена только эта часть)." + (bi ? " Заголовок Translation from… НЕ добавляй — он был в части 1. Продолжай структуру со следующей страницы." : "");
      const r = await runClaude({
        model: model(), max_tokens: 60000,
        system: SYS_COMMON,
        output_config: { effort: effortMain() },
        messages: [{ role: "user", content: [...(await srcBlocks(order, true, batches[bi])), { type: "text", text: partTask }] }],
      });
      const partHtml = stripFences(r.text);
      trackUsage(order, "translate" + (bi || ""), model(), r.usage);
      order.status = "checking"; save();
      const chk = await runCheck(order, partHtml, batches[bi]);
      trackUsage(order, "check" + (bi || ""), modelCheck(), chk.usage);
      if (chk.json) { verdicts.push(chk.json.verdict); if (chk.json.summary) summaries.push("Часть " + (bi + 1) + ": " + chk.json.summary); issuesAll.push(...(chk.json.issues || [])); }
      htmlAll += "\n" + partHtml;
    }
    order.progress = null;
    order.check = {
      verdict: verdicts.indexOf("errors") >= 0 ? "errors" : (verdicts.indexOf("warnings") >= 0 ? "warnings" : "ok"),
      summary: summaries.join(" "),
      issues: issuesAll,
    };
    // Авто-исправление в пакетном режиме пропускаем: замечания видны в отчёте.
    await buildOutputs(order, htmlAll.trim());
    order.status = "done"; order.doneAt = Date.now(); save();
    try { await enrichMeta(order, htmlAll); } catch (e) { console.warn("enrichMeta:", e.message); }
    return;
  }

  const r = await runClaude({
    model: model(), max_tokens: 60000,
    system: SYS_COMMON,
    output_config: { effort: effortMain() },
    messages: [{ role: "user", content: [...(await srcBlocks(order, true)), { type: "text", text: transTask }] }],
  });
  let html = stripFences(r.text);
  await buildOutputs(order, html);
  trackUsage(order, "translate", model(), r.usage);
  order.status = "checking"; save();

  let chk = await runCheck(order, html);
  order.check = chk.json || { verdict: "warnings", summary: "Не удалось разобрать отчёт проверки", issues: [] };
  trackUsage(order, "check", modelCheck(), chk.usage);

  // Авто-исправление: если проверка нашла критичные ошибки — правим и проверяем ещё раз.
  const critical = (order.check.issues || []).filter((i) => i.severity === "critical");
  if (critical.length) {
    order.status = "revising"; save();
    const rev = await runClaude({
      model: model(), max_tokens: 60000,
      system: SYS_COMMON,
      output_config: { effort: effortMain() },
      messages: [{ role: "user", content: [...(await srcBlocks(order, true)), { type: "text", text: transTask + "\n\nСейчас ты ИСПРАВЛЯЕШЬ свой предыдущий перевод по замечаниям контролёра. Верни ПОЛНЫЙ исправленный HTML-перевод целиком (не только исправленные места), тем же форматом.\n\nТекущий перевод:\n\n" + html + "\n\nЗамечания контролёра (исправь все критичные и по возможности остальные):\n" + JSON.stringify(order.check.issues, null, 1) }] }],
    });
    html = stripFences(rev.text);
    await buildOutputs(order, html);
    trackUsage(order, "revise", model(), rev.usage);
    order.status = "checking"; save();
    chk = await runCheck(order, html);
    order.check = chk.json || order.check;
    order.check.revised = true;
    trackUsage(order, "check2", modelCheck(), chk.usage);
  }
  order.status = "done"; order.doneAt = Date.now(); save();
  try { await enrichMeta(order, html); } catch (e) { console.warn("enrichMeta:", e.message); }
}

// ── Учёт расхода ──────────────────────────────────────────────────────────
// order.usage хранит ПОСЛЕДНИЙ проход каждого типа (для отладки), а order.spend —
// НАКОПИТЕЛЬНЫЙ журнал всех вызовов с моделью каждого: только так расход виден
// честно, если заказ переводили повторно или модель по дороге меняли.
function trackUsage(order, phase, modelId, usage) {
  if (!usage) return;
  order.usage = order.usage || {};
  order.usage[phase] = usage;
  order.spend = order.spend || [];
  order.spend.push({
    at: Date.now(), phase, model: modelId,
    in: usage.input_tokens || 0, out: usage.output_tokens || 0,
    cw: usage.cache_creation_input_tokens || 0, cr: usage.cache_read_input_tokens || 0,
  });
  if (order.spend.length > 200) order.spend.splice(0, order.spend.length - 200);
}

// ── Мета для аналитики: тип документа и число страниц ────────────────────
// Тип определяем дешёвой моделью по началу перевода (≈0,05 ₽), страницы —
// по числу секций в HTML. Заполняется один раз, при первом переводе заказа.
const DOC_TYPES = [
  "Справка о движении средств", "Банковская выписка", "Справка с работы", "Справка из банка о счёте",
  "Свидетельство о рождении", "Свидетельство о браке", "Свидетельство о разводе", "Паспорт",
  "Диплом или аттестат", "Согласие на выезд ребёнка", "Документы на недвижимость",
  "Справка из налоговой", "Пенсионное удостоверение", "Справка из учебного заведения", "Иное",
];
const DOCTYPE_SCHEMA = {
  type: "object", additionalProperties: false, required: ["doc_type"],
  properties: { doc_type: { type: "string", enum: DOC_TYPES } },
};
async function enrichMeta(order, html) {
  const pages = (String(html).match(/<section class="page[^"]*"/g) || []).length || (order.src || []).length || 1;
  order.meta = Object.assign({}, order.meta, { pages });
  if (order.meta.docType) { save(); return; }
  try {
    const r = await runClaudeJson({
      model: modelSmall(), max_tokens: 300,
      system: "Ты классифицируешь официальные документы по типу. Отвечай строго JSON: {doc_type: \"<один из списка>\"}.",
      messages: [{ role: "user", content: "Определи тип документа по началу его перевода и имени файла.\nИмя файла: " + ((order.src[0] && order.src[0].name) || "") + "\nНачало перевода:\n\n" + String(html).replace(/<[^>]+>/g, " ").slice(0, 1200) + "\n\nДопустимые значения: " + DOC_TYPES.join(" | ") }],
    }, DOCTYPE_SCHEMA);
    trackUsage(order, "doctype", modelSmall(), r.usage);
    const t = r.json && r.json.doc_type;
    order.meta.docType = DOC_TYPES.indexOf(t) >= 0 ? t : "Иное";
  } catch (e) {
    console.warn("translate docType:", e.message);
    order.meta.docType = "Иное";
  }
  save();
}

// Дозаполнение меты у заказов, переведённых до появления аналитики: страницы
// считаем из сохранённого HTML бесплатно, тип — дешёвой моделью, по одному
// заказу в очереди, чтобы не мешать живым переводам.
function backfillMeta() {
  const need = store().orders.filter((o) => o.status === "done" && o.files && o.files.html && !(o.meta && o.meta.docType));
  if (!need.length) return;
  console.log("translate: дозаполняю аналитику по заказам:", need.length);
  need.forEach((o) => {
    enqueue("meta " + o.id, async () => {
      const cur = findOrder(o.id);
      if (!cur || (cur.meta && cur.meta.docType)) return;
      try { await enrichMeta(cur, currentHtml(cur)); } catch (e) { console.warn("backfillMeta:", e.message); }
    });
  });
}

// ── Корректировка по команде человека («исправь: …») ─────────────────────
async function pipelineCorrect(order, instruction, author) {
  order.correctStatus = "processing"; save();
  const p = order.params || {};
  const html = currentHtml(order);
  if (!html) throw new Error("нет готового перевода для правки");
  const withSrc = totalSrcSize(order) <= REQ_BUDGET;
  const task = "РЕЖИМ: переводчик, правка. " + (withSrc ? "Выше — оригинал, ниже" : "Оригинал не приложен (слишком большой) — работай по тексту перевода. Ниже") + " — текущий перевод (HTML) и корректировка от заказчика. Внеси правку и верни ПОЛНЫЙ исправленный HTML-перевод целиком, тем же форматом (<section class=\"page\">, таблицы <table>), без markdown и ```-ограждений. Ничего не ломай в местах, которых правка не касается."
    + lessonsPromptBlock()
    + "\n\nТекущий перевод:\n\n" + html + "\n\nКорректировка заказчика (выполни её):\n" + instruction + (p.translit ? "\n\nТранслитерация ФИО: " + p.translit : "");
  const r = await runClaude({
    model: model(), max_tokens: 60000,
    system: SYS_COMMON,
    output_config: { effort: effortMain() },
    messages: [{ role: "user", content: [...(withSrc ? await srcBlocks(order, true) : []), { type: "text", text: task }] }],
  });
  trackUsage(order, "correct", model(), r.usage);
  await buildOutputs(order, stripFences(r.text));
  order.corrections = order.corrections || [];
  order.corrections.push({ at: Date.now(), by: author || "", text: String(instruction).slice(0, 2000) });
  order.correctStatus = "done"; save();

  // Самообучение: извлекаем из правки общие правила на будущее (best-effort).
  try {
    const existing = lessons().map((l) => l.text);
    const les = await runClaudeJson({
      model: modelSmall(), max_tokens: 4000,
      system: "Ты ведёшь базу правил для переводчика документов. Из корректировки заказчика сформулируй 0–3 ОБЩИХ правила на будущее (по-русски, коротко, применимо к любым документам). Разовые правки конкретного документа (опечатка, конкретная сумма) правилом НЕ являются — тогда верни пустой список. Не дублируй существующие правила. Отвечай строго JSON: {lessons: [\"правило\", ...]}.",
      messages: [{ role: "user", content: "Корректировка заказчика: " + instruction + "\n\nСуществующие правила:\n" + (existing.join("\n") || "(пусто)") }],
    }, LESSONS_SCHEMA);
    trackUsage(order, "lessons", modelSmall(), les.usage);
    const newOnes = ((les.json && les.json.lessons) || []).map((t) => String(t).trim()).filter((t) => t && !existing.some((e) => e.toLowerCase() === t.toLowerCase()));
    for (const t of newOnes) lessons().push({ id: newId(), createdAt: Date.now(), text: t.slice(0, 500), source: "correction", sourceRef: order.id });
    if (newOnes.length) save();
    return newOnes;
  } catch (e) { console.warn("translate lessons:", e.message); return []; }
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
    content.push({ type: "image", source: { type: "base64", media_type: mime.split(";")[0], data: readFileBuf(humanFn).toString("base64") } });
    humanNote = "Перевод человека приложен изображением (последнее фото).";
  } else {
    humanNote = "Перевод человека (текст):\n\n" + readFileBuf(humanFn).toString("utf8");
  }
  const aiHtml = currentHtml(order);

  const task = "РЕЖИМ: эксперт по качеству переводов. Выше — оригинал документа. Сравни два его перевода: перевод ИИ и перевод человека-переводчика. Определи все содержательные расхождения (цифры, даты, ФИО, пропуски, смысл) и заметные стилистические. Оцени, есть ли у человека то, чего не хватает у ИИ, и наоборот. Отвечай строго JSON: {verdict: match|minor|major, summary: развёрнутый вывод по-русски (какой перевод точнее и почему), differences: [{kind: number|date|name|omission|meaning|style|format|other, severity: critical|warning|info, ai, human, note}]}."
    + "\n\nПеревод ИИ (HTML):\n\n" + aiHtml + "\n\n---\n\n" + humanNote;
  const cmp = await runClaudeJson({
    model: modelCheck(), max_tokens: 16000,
    system: SYS_COMMON,
    output_config: { effort: effortCheck() },
    messages: [{ role: "user", content: [...(totalSrcSize(order) <= REQ_BUDGET ? await srcBlocks(order) : []), ...content, { type: "text", text: task }] }],
  }, COMPARE_SCHEMA);
  order.compare = cmp.json || { verdict: "minor", summary: "Не удалось разобрать отчёт сравнения", differences: [] };
  trackUsage(order, "compare", modelCheck(), cmp.usage);
  order.compareStatus = "done"; save();
}

// ── Обучение на архиве прошлых переводов ─────────────────────────────────
// Из отчёта сравнения «ИИ vs человек» вытаскиваем общие правила: там, где
// человек прав, а ИИ ошибся, — это и есть материал для обучения.
async function learnFromCompare(order) {
  const diffs = (order.compare && order.compare.differences) || [];
  const meaningful = diffs.filter((d) => d.severity === "critical" || d.severity === "warning");
  if (!meaningful.length) return [];
  const existing = lessons().map((l) => l.text);
  const les = await runClaudeJson({
    model: modelSmall(), max_tokens: 4000,
    system: "Ты ведёшь базу правил для переводчика официальных документов. Тебе дан разбор расхождений между переводом ИИ и переводом профессионального переводчика (эталон — человек). Сформулируй 0–5 ОБЩИХ правил на будущее (по-русски, коротко, применимо к любым документам этого типа), чтобы ИИ больше не повторял свои ошибки. Разовые особенности конкретного документа правилами НЕ являются. Не дублируй существующие правила. Если поучиться нечему — верни пустой список. Отвечай строго JSON: {lessons: [\"правило\", ...]}.",
    messages: [{ role: "user", content: "Расхождения:\n" + JSON.stringify(meaningful, null, 1) + "\n\nОбщий вывод: " + ((order.compare && order.compare.summary) || "") + "\n\nСуществующие правила:\n" + (existing.join("\n") || "(пусто)") }],
  }, LESSONS_SCHEMA);
  trackUsage(order, "lessons", modelSmall(), les.usage);
  const newOnes = ((les.json && les.json.lessons) || []).map((t) => String(t).trim()).filter((t) => t && !existing.some((e) => e.toLowerCase() === t.toLowerCase()));
  for (const t of newOnes) lessons().push({ id: newId(), createdAt: Date.now(), text: t.slice(0, 500), source: "review", sourceRef: order.id });
  order.learned = newOnes;
  save();
  return newOnes;
}

// ── Стоимость заказа в токенах ───────────────────────────────────────────
// Считаем по накопительному журналу spend (все проходы, каждый по своей
// модели). Для заказов, сделанных до появления журнала, — прикидка по
// тарифу Opus 5 (тогда сервис работал на нём). Курс 80 ₽/$.
const PRICES = { // $ за 1M токенов: [вход, выход]
  "claude-opus-5": [5, 25], "claude-sonnet-5": [3, 15], "claude-haiku-4-5": [1, 5],
};
const RUB_RATE = Number(process.env.TRANSLATE_USD_RUB || 80);
function orderCost(o) {
  let usd = 0;
  if (Array.isArray(o.spend) && o.spend.length) {
    for (const e of o.spend) {
      const rate = PRICES[e.model] || PRICES["claude-sonnet-5"];
      usd += ((e.in || 0) + (e.cr || 0) * 0.1 + (e.cw || 0) * 1.25) * rate[0] / 1e6 + (e.out || 0) * rate[1] / 1e6;
    }
    return { usd, exact: true };
  }
  const rate = PRICES["claude-opus-5"];
  for (const v of Object.values(o.usage || {})) {
    if (!v) continue;
    usd += ((v.input_tokens || 0) + (v.cache_read_input_tokens || 0) * 0.1 + (v.cache_creation_input_tokens || 0) * 1.25) * rate[0] / 1e6
      + (v.output_tokens || 0) * rate[1] / 1e6;
  }
  return { usd, exact: false };
}

// ── Мост к порталу Кати (work.voyotravel.ru, ТЗ Зайцевой 21.08.2026) ──────
// Её модуль «Переводы» оформляет заказы и считает деньги у себя
// (/var/www/kateadmin, сервис :3002); наш движок переводит и отчитывается ей:
//  • доступ к /translate/api/* по портальному staff-токену — право «translate»
//    берём из её data/portal.json (личные вкладки ∪ отделы);
//  • заказ целиком: POST /translate/api/order c полем meta (JSON) + files;
//  • отчёт по группе: POST {портал}/api/sverki/translate/server/report?key=…
//    (ready/returned/error, cost в рублях, ссылки на файлы);
//  • расход прогона обучения: POST {портал}/api/sverki/translate/learn-cost.
// Ключ — её же widgetKey из data/settings.json (читаем с диска, mtime-кэш).
// Отчёты идут через дисковую очередь portalOutbox с повторами — рестарт её
// сервиса ничего не теряет. Деньги/копилки/комиссию НЕ трогаем — это её слой.
const PORTAL_DATA_DIR = process.env.TRANSLATE_PORTAL_DATA || "/var/www/kateadmin/data";
const PORTAL_URL = process.env.TRANSLATE_PORTAL_URL || "http://127.0.0.1:3002";
const PORTAL_PUBLIC = process.env.TRANSLATE_PORTAL_PUBLIC || "https://work.voyotravel.ru";
const _portalCache = new Map(); // файл -> { at, data }
function portalReadJson(name) {
  const c = _portalCache.get(name);
  if (c && Date.now() - c.at < 30000) return c.data;
  let data = null;
  try { data = JSON.parse(fs.readFileSync(path.join(PORTAL_DATA_DIR, name + ".json"), "utf8")); } catch (_) {}
  _portalCache.set(name, { at: Date.now(), data });
  return data;
}
function portalKey() { const s = portalReadJson("settings"); return (s && s.widgetKey) || ""; }
// Открыт ли юзеру раздел «Переводы» в портале Кати: владелец/совладельцы — всегда,
// остальным — личные вкладки ∪ вкладки отделов (копия её tabsFor).
function portalHasTranslate(email) {
  const p = portalReadJson("portal");
  if (!p || !email) return false;
  const e = String(email).toLowerCase().trim();
  const owners = [String(p.owner || "").toLowerCase()].concat((p.coOwners || []).map((x) => String(x).toLowerCase()));
  if (owners.indexOf(e) >= 0) return true;
  const u = (p.users || {})[e];
  const tabs = new Set((u && Array.isArray(u.tabs)) ? u.tabs : []);
  for (const d of (p.departments || [])) {
    if (Array.isArray(d.members) && d.members.indexOf(e) >= 0) (d.tabs || []).forEach((t) => tabs.add(t));
  }
  return tabs.has("translate");
}
// Очередь исходящих отчётов порталу (переживает рестарт — лежит в orders.json).
function portalOutbox() { const st = store(); if (!Array.isArray(st.portalOutbox)) st.portalOutbox = []; return st.portalOutbox; }
function portalSend(pathname, payload) {
  portalOutbox().push({ at: Date.now(), path: pathname, payload, tries: 0 });
  save();
  portalFlush().catch(() => {});
}
let _portalFlushing = false;
async function portalFlush() {
  if (_portalFlushing) return;
  _portalFlushing = true;
  try {
    const box = portalOutbox();
    let changed = false;
    for (let i = 0; i < box.length;) {
      const it = box[i];
      try {
        const key = portalKey();
        if (!key) throw new Error("не прочитан ключ портала (settings.json)");
        const r = await axios.post(PORTAL_URL + it.path + "?key=" + encodeURIComponent(key),
          Object.assign({ key }, it.payload), { timeout: 20000 });
        if (!r.data || r.data.ok !== true) throw new Error((r.data && r.data.error) || "ответ не ok");
        console.log("translate→портал:", it.path, JSON.stringify(it.payload).slice(0, 120));
        box.splice(i, 1); changed = true;
      } catch (e) {
        it.tries = (it.tries || 0) + 1;
        it.lastError = String((e.response && e.response.data && e.response.data.error) || e.message || e).slice(0, 200);
        it.lastAt = Date.now();
        // 4xx — постоянная ошибка (например «заказ не найден»): не мучаем вечно.
        const cap = (e.response && e.response.status && e.response.status < 500) ? 10 : 300;
        if (it.tries >= cap) { console.error("translate→портал: сдаюсь,", it.path, it.lastError); box.splice(i, 1); }
        else i++;
        changed = true;
      }
    }
    if (changed) save();
  } finally { _portalFlushing = false; }
}
function portalGroupOrders(number) { return store().orders.filter((o) => o.portal && o.portal.number === number); }
// Итоговый отчёт по группе заказов одного номера (ЕЗ7): шлём, когда все файлы
// группы дошли до терминального статуса. Дедуп по подписи — чтобы ретраи и
// повторные хуки не спамили её историю статусов.
const ACTIVE_STATUSES = ["new", "queued", "translating", "checking", "revising"];
function portalGroupReport(number, opts) {
  const list = portalGroupOrders(number);
  if (!list.length) return;
  const busy = list.some((o) => ACTIVE_STATUSES.indexOf(o.status) >= 0 || o.correctStatus === "processing" || o.portalFixPending);
  if (busy) return;
  const errs = list.filter((o) => o.status === "error");
  const cost = Math.round(list.reduce((s, o) => s + orderCost(o).usd, 0) * RUB_RATE * 100) / 100;
  const pages = list.reduce((s, o) => s + ((o.meta && o.meta.pages) || 0), 0);
  const files = [];
  for (const o of list) {
    const base = PORTAL_PUBLIC + "/translate/api/dl/" + o.id + "/" + o.dlToken + "/";
    if (o.files && o.files.docx) files.push({ name: docxDlName(o), url: base + "docx" });
    else if (o.files && o.files.html) files.push({ name: "Перевод (веб-версия): " + ((o.src[0] && o.src[0].name) || o.id), url: base + "html" });
  }
  const payload = {
    number,
    status: errs.length ? "error" : ((opts && opts.returned) ? "returned" : "ready"),
    cost, orderId: "grp-" + number, files,
  };
  if (pages) payload.pages = pages;
  if (errs.length) payload.error = errs.map((o) => o.error).filter(Boolean).join("; ").slice(0, 500);
  const st = store();
  st.portalSent = st.portalSent || {};
  const sig = payload.status + "|" + cost + "|" + files.length;
  if (st.portalSent[number] === sig) return;
  st.portalSent[number] = sig;
  portalSend("/api/sverki/translate/server/report", payload);
}
// Расход прогона обучения (номер ОБ7 присваивает её модуль): шлём суммарный
// расход всех пар прогона, когда все они завершились.
function portalLearnReport(number) {
  const list = store().orders.filter((o) => o.portalLearn === number);
  if (!list.length) return;
  const busy = list.some((o) => ACTIVE_STATUSES.indexOf(o.status) >= 0 || o.compareStatus === "processing");
  if (busy) return;
  const cost = Math.round(list.reduce((s, o) => s + orderCost(o).usd, 0) * RUB_RATE * 100) / 100;
  if (!cost) return;
  const st = store();
  st.portalLearnSent = st.portalLearnSent || {};
  if (st.portalLearnSent[number] === cost) return;
  st.portalLearnSent[number] = cost;
  portalSend("/api/sverki/translate/learn-cost", { number, cost });
}

// Мостик к списанию /translate_pay: сама функция объявляется в mount (ей нужны
// тарифы и пользователи), а вызывается из очереди после успешного перевода.
const payChargeOrderRef = { fn: null };

// Пул обработки: до TRANSLATE_CONCURRENCY заказов одновременно (дефолт 2) —
// чтобы второй сотрудник не ждал чужую очередь. Внутри одного заказа операции
// по-прежнему строго последовательны (перевод → сравнение → правка не дерутся
// за одни файлы) — на это отдельная цепочка per-order.
const CONCURRENCY = Math.max(1, Number(process.env.TRANSLATE_CONCURRENCY || 2));
const _qTasks = [];
let _qRunning = 0;
function _pump() {
  while (_qRunning < CONCURRENCY && _qTasks.length) {
    const t = _qTasks.shift();
    _qRunning++;
    Promise.resolve().then(t.fn)
      .catch((e) => { console.error("translate queue [" + t.label + "]:", e && e.message); })
      .finally(() => { _qRunning--; _pump(); });
  }
}
const _orderChains = new Map();
function enqueue(label, fn) {
  // Ключ сериализации — id заказа из подписи задачи ("translate abc123" и т.п.).
  const key = String(label).split(" ")[1] || label;
  const prev = _orderChains.get(key) || Promise.resolve();
  const next = prev.then(() => new Promise((resolve) => {
    _qTasks.push({ label, fn: async () => { try { await fn(); } finally { resolve(); } } });
    _pump();
  }));
  _orderChains.set(key, next.catch(() => {}));
  if (_orderChains.size > 1000) { const first = _orderChains.keys().next().value; _orderChains.delete(first); }
}
function queueTranslate(order) {
  order.status = "queued"; order.error = null; save();
  enqueue("translate " + order.id, async () => {
    const o = findOrder(order.id);
    if (!o) return;
    try {
      await pipelineTranslate(o);
      if (o.kind === "bot") await botDeliver(o).catch((e) => console.error("botDeliver:", e.message));
      if (o.kind === "pay" && payChargeOrderRef.fn) { try { payChargeOrderRef.fn(o); } catch (e) { console.error("payCharge:", e.message); } }
    } catch (e) {
      o.status = "error"; o.error = String((e && e.message) || e); save();
      if (o.kind === "bot") await botSay(o, "⚠️ Не получилось перевести: " + o.error).catch(() => {});
    }
    if (o.portal) { try { portalGroupReport(o.portal.number); } catch (e) { console.error("portalGroupReport:", e.message); } }
  });
}
function queueCompare(order, learn) {
  enqueue("compare " + order.id, async () => {
    const o = findOrder(order.id);
    if (!o) return;
    try {
      await pipelineCompare(o);
      if (learn || o.kind === "review") { try { await learnFromCompare(o); } catch (e) { console.warn("learnFromCompare:", e.message); } }
    }
    catch (e) { o.compareStatus = "error"; o.compareError = String((e && e.message) || e); save(); }
  });
}
// Разбор архива прошлых переводов: перевести оригинал заново, сравнить с
// человеческим, выучить правила. Один заказ = одна пара файлов.
function queueReview(order) {
  order.status = "queued"; order.error = null; save();
  enqueue("review " + order.id, async () => {
    const o = findOrder(order.id);
    if (!o) return;
    try {
      await pipelineTranslate(o);
      await pipelineCompare(o);
      try { await learnFromCompare(o); } catch (e) { console.warn("learnFromCompare:", e.message); }
    } catch (e) {
      o.status = o.status === "done" ? o.status : "error";
      if (o.status === "error") o.error = String((e && e.message) || e);
      else { o.compareStatus = "error"; o.compareError = String((e && e.message) || e); }
      save();
    }
    if (o.portalLearn) { try { portalLearnReport(o.portalLearn); } catch (e) { console.error("portalLearnReport:", e.message); } }
  });
}
function queueCorrect(order, instruction, author) {
  enqueue("correct " + order.id, async () => {
    const o = findOrder(order.id);
    if (!o) return;
    try {
      const newRules = await pipelineCorrect(o, instruction, author);
      if (o.kind === "bot") {
        if (o.files && o.files.docx) await ymSendFile(o.chat.chatId, readFileBuf(o.files.docx), docxDlName(o), o.chat.messageId).catch((e) => console.error("send fix docx:", e.message));
        let t = "✅ Поправил, новая версия выше.";
        if (newRules && newRules.length) t += "\nЗапомнил на будущее:\n" + newRules.map((x) => "• " + x).join("\n");
        await botSay(o, t).catch(() => {});
      }
    } catch (e) {
      o.correctStatus = "error"; save();
      if (o.kind === "bot") await botSay(o, "⚠️ Не получилось поправить: " + String((e && e.message) || e)).catch(() => {});
    }
  });
}

// ── Бот Яндекс Мессенджера ────────────────────────────────────────────────
const YM_API = "https://botapi.messenger.yandex.net/bot/v1";
function botConfigured() { return !!process.env.YM_BOT_TOKEN; }
function ymHeaders() { return { Authorization: "OAuth " + process.env.YM_BOT_TOKEN }; }
function quietChatIds() { return String(process.env.YM_TRANSLATE_CHAT_ID || "").split(",").map((s) => s.trim()).filter(Boolean); }

async function ymGetFile(fileId) {
  const r = await axios.post(YM_API + "/messages/getFile/", { file_id: fileId }, { headers: ymHeaders(), responseType: "arraybuffer", timeout: 120000, maxContentLength: 60 * 1024 * 1024 });
  return Buffer.from(r.data);
}
async function ymSendText(chatId, text, threadId) {
  const body = { chat_id: chatId, text: String(text).slice(0, 3800) };
  if (threadId) body.thread_id = Number(threadId) || threadId;
  const r = await axios.post(YM_API + "/messages/sendText/", body, { headers: ymHeaders(), timeout: 30000 });
  if (!r.data || r.data.ok !== true) throw new Error("sendText не ок: " + JSON.stringify(r.data || {}).slice(0, 200));
  return r.data;
}
async function ymSendFile(chatId, buf, filename, threadId) {
  const fd = new FormData();
  fd.append("chat_id", chatId);
  if (threadId) fd.append("thread_id", String(threadId));
  fd.append("document", new Blob([buf]), filename);
  const r = await fetch(YM_API + "/messages/sendFile/", { method: "POST", headers: ymHeaders(), body: fd });
  const j = await r.json().catch(() => null);
  if (!j || j.ok !== true) throw new Error("sendFile не ок: " + (j ? JSON.stringify(j).slice(0, 200) : "HTTP " + r.status));
  return j;
}
// Ответ в ветку заказа (для активного режима).
async function botSay(order, text) {
  if (!order.chat || !order.chat.chatId) return;
  await ymSendText(order.chat.chatId, text, order.chat.messageId);
}

// Итог активного заказа: DOCX + сводка проверки в ветку.
async function botDeliver(o) {
  if (!o.chat || !o.chat.chatId) return;
  if (o.files && o.files.docx) await ymSendFile(o.chat.chatId, readFileBuf(o.files.docx), docxDlName(o), o.chat.messageId);
  const c = o.check || {};
  let txt = "✅ Перевод готов" + (c.revised ? " (при самопроверке нашёл замечания и уже исправил их)" : "") + ".\n";
  if (c.verdict === "ok") txt += "Контрольная проверка: расхождений с оригиналом не найдено.";
  else {
    txt += "Контрольная проверка: " + (c.summary || "есть замечания") + "";
    const top = (c.issues || []).filter((i) => i.severity !== "info").slice(0, 5);
    if (top.length) txt += "\n" + top.map((i) => "• " + (i.note || i.where || "")).join("\n");
  }
  if (o.docxError) txt += "\n⚠️ " + o.docxError;
  txt += "\n\nПоправить: ответьте в этой ветке «исправь: …». Команда «правила» — что я уже выучил.";
  await ymSendText(o.chat.chatId, txt, o.chat.messageId);
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

const CORRECT_RE = /^\s*[\/!]?\s*(исправ|поправ|правк|подправ|измени|замени|убери|удали|добавь|переделай|fix|correct)/i;
const RULES_RE = /^\s*\/?\s*(правила|rules)\s*$/i;

let _ymLoggedSample = 0;

// Заказ из сообщения с файлами (общее для обоих режимов).
async function ymCreateOrder(u, files, kind) {
  const chat = u.chat || {};
  const order = {
    id: newId(), num: nextNum(), kind, createdAt: Date.now(), status: "new",
    params: { translit: "", country: "", targetLang: "en", note: "" },
    src: [], files: {},
    chat: { chatId: String(chat.id || ""), messageId: u.message_id ? String(u.message_id) : "", threadId: u.thread_id ? String(u.thread_id) : "", from: (u.from && (u.from.display_name || u.from.login)) || "", text: String(u.text || "").slice(0, 3000) },
  };
  const tm = order.chat.text.match(/транслитерац\w*\s*[:—-]\s*([A-ZА-Я][A-Za-zА-Яа-яЁё .-]+)/i);
  if (tm) order.params.translit = tm[1].trim();
  for (let i = 0; i < files.length && i < 10; i++) {
    const buf = await ymGetFile(files[i].id);
    order.src.push({ file: saveFile(order.id, "src-" + i, buf, files[i].name, ""), name: files[i].name });
  }
  const st = store();
  st.orders.unshift(order);
  if (st.orders.length > MAX_ORDERS) st.orders.length = MAX_ORDERS;
  save();
  return order;
}

async function ymHandleUpdate(u) {
  const st = store();
  const chat = u.chat || {};
  const chatId = String(chat.id || "");
  if (chatId) {
    st.bot.chats[chatId] = { type: chat.type || "", lastAt: Date.now(), lastFrom: (u.from && (u.from.display_name || u.from.login)) || "" };
  }
  if (u.from && u.from.robot) return;
  const files = ymExtractFiles(u);
  if (files.length && _ymLoggedSample < 3) { _ymLoggedSample++; console.log("ymbot update с файлом (образец):", JSON.stringify(u).slice(0, 1500)); }
  const threadId = u.thread_id ? String(u.thread_id) : "";
  const quiet = quietChatIds().indexOf(chatId) >= 0;

  // ── ТИХИЙ режим (чат переводчиц): только читаем, для обучения ──
  if (quiet) {
    if (!files.length) {
      if (threadId) {
        const o = st.orders.find((x) => x.chat && x.chat.messageId === threadId);
        if (o && u.text) { o.chat.thread = (o.chat.thread || []); o.chat.thread.push({ from: (u.from && (u.from.display_name || u.from.login)) || "", text: String(u.text).slice(0, 2000) }); save(); }
      }
      return;
    }
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
          else { o.pendingCompare = true; save(); }
        } catch (e) { console.error("ymbot human file:", e.message); }
        return;
      }
    }
    try {
      const order = await ymCreateOrder(u, files, "chat");
      if (aiConfigured()) queueTranslate(order);
      else { order.status = "error"; order.error = "ANTHROPIC_API_KEY не настроен"; save(); }
    } catch (e) { console.error("ymbot quiet order:", e.message); }
    return;
  }

  // ── АКТИВНЫЙ режим (все остальные чаты): переводим и отвечаем ──
  if (!files.length) {
    const text = String(u.text || "").trim();
    if (!text) return;
    // Команда «правила»
    if (RULES_RE.test(text)) {
      const ls = lessons();
      const msg = ls.length ? "Мои выученные правила (" + ls.length + "):\n" + ls.slice(-30).map((l, i) => (i + 1) + ". " + l.text).join("\n") : "Пока ни одного правила не выучил — поправьте мой перевод командой «исправь: …», и я запомню.";
      await ymSendText(chatId, msg, u.thread_id ? threadId : undefined).catch((e) => console.error("rules reply:", e.message));
      return;
    }
    // Корректировка в ветке заказа
    if (threadId) {
      const o = st.orders.find((x) => x.kind === "bot" && x.chat && x.chat.messageId === threadId);
      if (o && CORRECT_RE.test(text)) {
        if (o.status !== "done") { await botSay(o, "Ещё перевожу — как закончу, пришлю, и тогда поправлю.").catch(() => {}); return; }
        const instruction = text.replace(/^\s*[\/!]?\s*(исправь|поправь|исправить|поправить|правка|fix|correct)\s*[:,—-]?\s*/i, "") || text;
        const author = (u.from && (u.from.display_name || u.from.login)) || "";
        await botSay(o, "Принял, вношу правку…").catch(() => {});
        queueCorrect(o, instruction, author);
      }
      return;
    }
    return;
  }

  // Файлы в активном режиме → новый заказ с ответом в чат.
  const supported = files.filter((f) => srcSupported(f.name));
  const rootThread = threadId || (u.message_id ? String(u.message_id) : "");
  if (!supported.length) {
    await ymSendText(chatId, "Этот формат не потяну 😕 Пришлите PDF, DOCX, TXT или фото (JPG/PNG). Старый .doc пересохраните в PDF или DOCX.", rootThread).catch(() => {});
    return;
  }
  try {
    const order = await ymCreateOrder(u, supported, "bot");
    if (!threadId && u.message_id) order.chat.messageId = String(u.message_id); // ветка = исходное сообщение
    else order.chat.messageId = threadId; // файл кинули в ветку — отвечаем туда же
    save();
    if (!aiConfigured()) {
      order.status = "error"; order.error = "ANTHROPIC_API_KEY не настроен"; save();
      await botSay(order, "⚠️ ИИ ещё не подключён (нет ключа) — передайте администратору.").catch(() => {});
      return;
    }
    await botSay(order, "Принял, перевожу и проверяю… Обычно это занимает несколько минут, результат пришлю сюда.").catch(() => {});
    queueTranslate(order);
  } catch (e) {
    console.error("ymbot active order:", e.message);
    await ymSendText(chatId, "⚠️ Не смог скачать файл: " + e.message, rootThread).catch(() => {});
  }
}

let _ymStarted = false;
function ymStartPolling() {
  if (_ymStarted || !botConfigured()) return;
  _ymStarted = true;
  console.log("translate: бот Яндекс Мессенджера запущен (polling); тихие чаты:", quietChatIds().join(", ") || "(нет)");
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
    id: o.id, num: o.num || null, meta: o.meta || null,
    kind: o.kind, createdAt: o.createdAt, doneAt: o.doneAt || null,
    status: o.status, error: o.error || null,
    params: o.params, srcNames: (o.src || []).map((f) => f.name),
    hasDocx: !!(o.files && o.files.docx), hasHtml: !!(o.files && o.files.html),
    docxError: o.docxError || null,
    filesPurged: !!o.filesPurged, progress: o.progress || null,
    checkVerdict: (o.check && o.check.verdict) || null,
    checkRevised: !!(o.check && o.check.revised),
    humanName: o.humanName || null,
    compareStatus: o.compareStatus || null, compareVerdict: (o.compare && o.compare.verdict) || null,
    compareError: o.compareError || null,
    correctStatus: o.correctStatus || null,
    correctionsCnt: (o.corrections || []).length,
    learned: o.learned || null,
    chat: o.chat ? { from: o.chat.from, text: o.chat.text } : null,
    portal: o.portal || null,
  };
  if (full) { v.check = o.check || null; v.compare = o.compare || null; v.corrections = o.corrections || []; v.usage = o.usage || null; }
  return v;
}

// ── Монтирование ──────────────────────────────────────────────────────────
function mount(app, deps) {
  const getStaffFromReq = deps.getStaffFromReq;

  // Свой код входа для сотрудников (по просьбе Андрея 08.08) + токен-сессии,
  // переживающие рестарт (в orders.json). Админ-код и вход Зайцевой тоже работают.
  const TRANSLATE_CODE = process.env.TRANSLATE_CODE || "3451";
  const TOKEN_TTL = 30 * 24 * 3600 * 1000;
  function authTokens() { const st = store(); if (!st.auth) st.auth = {}; return st.auth; }
  function tokenFromReq(req) {
    const h = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
    return h || String(req.query.token || "").trim();
  }
  const loginFails = new Map(); // ip -> [ts]
  app.post("/translate/api/login", (req, res) => {
    const ip = String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();
    const hist = (loginFails.get(ip) || []).filter((t) => Date.now() - t < 24 * 3600 * 1000);
    if (hist.length >= 20) return res.status(429).json({ success: false, message: "Слишком много попыток, попробуйте завтра" });
    const code = String((req.body && req.body.code) || "").trim();
    if (code !== TRANSLATE_CODE) {
      hist.push(Date.now()); loginFails.set(ip, hist);
      return res.status(401).json({ success: false, message: "Неверный код" });
    }
    const tok = crypto.randomBytes(24).toString("hex");
    const at = authTokens();
    at[tok] = { at: Date.now() };
    for (const k of Object.keys(at)) if (Date.now() - (at[k].at || 0) > TOKEN_TTL) delete at[k];
    save();
    return res.json({ success: true, token: tok });
  });

  // Доступ: код /translate ИЛИ админ ИЛИ руководитель с "translate" в vscRestrict.tabs (Зайцева)
  // ИЛИ портальный staff-токен work.voyotravel.ru, если юзеру в портале Кати открыт
  // раздел «Переводы» (ТЗ Зайцевой 21.08: отдельный код входа в её модуле убран)
  // ИЛИ её служебный ключ (для server-to-server, тот же widgetKey что в 4.1 ТЗ).
  function requireTranslate(req, res, next) {
    const tok = tokenFromReq(req);
    const rec = tok && authTokens()[tok];
    if (rec && Date.now() - (rec.at || 0) <= TOKEN_TTL) { req.staff = { role: "translate", name: "сотрудник (код)" }; return next(); }
    const s = getStaffFromReq(req);
    if (s && (s.role === "admin" || (s.vscRestrict && Array.isArray(s.vscRestrict.tabs) && s.vscRestrict.tabs.indexOf("translate") >= 0))) { req.staff = s; return next(); }
    if (s && portalHasTranslate(s.email)) { req.staff = s; return next(); }
    const pk = portalKey();
    if (pk && (String(req.query.key || "") === pk || String(req.headers["x-portal-key"] || "") === pk)) { req.staff = { role: "portal", name: "портал work." }; return next(); }
    return res.status(401).json({ success: false, message: "Нет доступа" });
  }
  const up = multer({ storage: multer.memoryStorage(), limits: { fileSize: 45 * 1024 * 1024, files: 10 } });

  // С 16.08 редизайн (translate2.html) — основная страница /translate; движок, API и данные общие.
  // Старая вёрстка доступна на /translate_old, /translate_v2 остаётся редиректом со старых ссылок.
  app.get("/translate", (req, res) => { res.set("Cache-Control", "no-store, no-cache, must-revalidate"); res.sendFile(path.join(__dirname, "public", "translate2.html")); });
  app.get("/translate_old", (req, res) => { res.set("Cache-Control", "no-store, no-cache, must-revalidate"); res.sendFile(path.join(__dirname, "public", "translate.html")); });
  app.get("/translate_v2", (req, res) => res.redirect(302, "/translate"));

  app.get("/translate/api/state", requireTranslate, (req, res) => {
    const st = store();
    res.json({
      success: true,
      aiConfigured: aiConfigured(), model: model(),
      botConfigured: botConfigured(), quietChats: quietChatIds(),
      botChats: st.bot.chats || {},
      lessons: lessons().slice().reverse(),
      orders: st.orders.filter((o) => o.kind !== "pay").map((o) => orderView(o, false)),
    });
  });

  // ── /translate_pay — черновой SaaS для внешних клиентов (просьба Андрея 12.08) ──
  // Личный кабинет: регистрация по email, баланс в рублях, заказы того же
  // движка (kind: "pay", в общем store — пайплайны/очистка/учёт работают как
  // есть), списание по факту: страницы × PAY_RATE_RUB. Пополнение — черновик:
  // заявка + письмо директору, баланс зачисляет Андрей через Клода. Заказы
  // внешних клиентов в интерфейсе сотрудников не показываются (фильтр kind).
  const PAY_RATE_RUB = Number(process.env.TRANSLATE_PAY_RATE_RUB || 35);
  const PAY_BONUS_RUB = Number(process.env.TRANSLATE_PAY_BONUS_RUB || 175);
  function payUsers() { const st = store(); if (!st.payUsers) st.payUsers = {}; return st.payUsers; }
  function payTokens() { const st = store(); if (!st.payTokens) st.payTokens = {}; return st.payTokens; }
  function payHash(pass, salt) { return crypto.scryptSync(String(pass), salt, 32).toString("hex"); }
  function payUserFromReq(req) {
    const tok = tokenFromReq(req);
    const rec = tok && payTokens()[tok];
    if (!rec || Date.now() - (rec.at || 0) > TOKEN_TTL) return null;
    return payUsers()[rec.email] || null;
  }
  function requirePayUser(req, res, next) {
    const u = payUserFromReq(req);
    if (!u) return res.status(401).json({ success: false, message: "Не авторизован" });
    req.payUser = u;
    next();
  }
  function payOp(u, kind, rub, note, orderId) {
    u.ops = u.ops || [];
    u.ops.push({ at: Date.now(), kind, rub, note: note || "", orderId: orderId || null });
    if (u.ops.length > 300) u.ops.splice(0, u.ops.length - 300);
  }
  // Списание по факту перевода (вызывается из queueTranslate после done).
  function payChargeOrder(o) {
    if (o.kind !== "pay" || o.payCharged != null || o.status !== "done") return;
    const u = payUsers()[o.ownerEmail];
    if (!u) return;
    const pages = (o.meta && o.meta.pages) || 1;
    const cost = pages * PAY_RATE_RUB;
    u.balanceRub = Math.round(((u.balanceRub || 0) - cost) * 100) / 100;
    payOp(u, "charge", -cost, "Перевод " + (o.num || o.id) + " · " + pages + " стр.", o.id);
    o.payCharged = cost;
    save();
  }
  payChargeOrderRef.fn = payChargeOrder;

  const PAY_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
  app.get("/translate_pay", (req, res) => { res.set("Cache-Control", "no-store, no-cache, must-revalidate"); res.sendFile(path.join(__dirname, "public", "translate_pay.html")); });

  app.post("/translate_pay/api/register", (req, res) => {
    const b = req.body || {};
    const email = String(b.email || "").trim().toLowerCase();
    const pass = String(b.password || "");
    const name = String(b.name || "").trim().slice(0, 100);
    if (!PAY_EMAIL_RE.test(email)) return res.status(400).json({ success: false, message: "Укажите корректный e-mail" });
    if (pass.length < 6) return res.status(400).json({ success: false, message: "Пароль — минимум 6 символов" });
    const users = payUsers();
    if (users[email]) return res.status(400).json({ success: false, message: "Такой e-mail уже зарегистрирован — войдите" });
    const salt = crypto.randomBytes(12).toString("hex");
    users[email] = { email, name, salt, hash: payHash(pass, salt), balanceRub: PAY_BONUS_RUB, createdAt: Date.now(), ops: [] };
    payOp(users[email], "bonus", PAY_BONUS_RUB, "Приветственный бонус — попробуйте перевод бесплатно");
    const tok = crypto.randomBytes(24).toString("hex");
    payTokens()[tok] = { email, at: Date.now() };
    save();
    return res.json({ success: true, token: tok });
  });

  const payLoginFails = new Map();
  app.post("/translate_pay/api/login", (req, res) => {
    const ip = String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();
    const hist = (payLoginFails.get(ip) || []).filter((t) => Date.now() - t < 24 * 3600 * 1000);
    if (hist.length >= 30) return res.status(429).json({ success: false, message: "Слишком много попыток, попробуйте позже" });
    const email = String((req.body && req.body.email) || "").trim().toLowerCase();
    const pass = String((req.body && req.body.password) || "");
    // Демо-доступ для Андрея: логин 111 / пароль 111 (создаётся при первом входе).
    if (email === "111" && pass === "111" && !payUsers()["111"]) {
      const salt = crypto.randomBytes(12).toString("hex");
      payUsers()["111"] = { email: "111", name: "Демо", salt, hash: payHash("111", salt), balanceRub: PAY_BONUS_RUB, createdAt: Date.now(), ops: [] };
      payOp(payUsers()["111"], "bonus", PAY_BONUS_RUB, "Приветственный бонус — попробуйте перевод бесплатно");
    }
    const u = payUsers()[email];
    if (!u || payHash(pass, u.salt) !== u.hash) {
      hist.push(Date.now()); payLoginFails.set(ip, hist);
      return res.status(401).json({ success: false, message: "Неверный e-mail или пароль" });
    }
    const tok = crypto.randomBytes(24).toString("hex");
    const pt = payTokens();
    pt[tok] = { email, at: Date.now() };
    for (const k of Object.keys(pt)) if (Date.now() - (pt[k].at || 0) > TOKEN_TTL) delete pt[k];
    save();
    return res.json({ success: true, token: tok });
  });

  function payView(o, full) {
    const v = {
      id: o.id, num: o.num || null, createdAt: o.createdAt, status: o.status, progress: o.progress || null,
      error: o.error || null, srcNames: (o.src || []).map((f) => f.name),
      params: o.params, hasDocx: !!(o.files && o.files.docx), hasHtml: !!(o.files && o.files.html),
      checkVerdict: (o.check && o.check.verdict) || null, checkRevised: !!(o.check && o.check.revised),
      correctStatus: o.correctStatus || null, correctionsCnt: (o.corrections || []).length,
      pages: (o.meta && o.meta.pages) || null, docType: (o.meta && o.meta.docType) || null,
      chargedRub: o.payCharged != null ? o.payCharged : null, filesPurged: !!o.filesPurged,
    };
    if (full) v.check = o.check || null;
    return v;
  }
  function payOrderOf(req) {
    const o = findOrder(req.params.id);
    return o && o.kind === "pay" && o.ownerEmail === req.payUser.email ? o : null;
  }

  app.get("/translate_pay/api/state", requirePayUser, (req, res) => {
    const u = req.payUser;
    res.json({
      success: true, rateRub: PAY_RATE_RUB,
      user: { email: u.email, name: u.name, balanceRub: u.balanceRub || 0, ops: (u.ops || []).slice(-50).reverse() },
      orders: store().orders.filter((o) => o.kind === "pay" && o.ownerEmail === u.email).map((o) => payView(o, false)),
    });
  });

  app.post("/translate_pay/api/order", requirePayUser, up.array("files", 10), (req, res) => {
    try {
      if (!aiConfigured()) return res.status(503).json({ success: false, message: "Сервис временно недоступен, попробуйте позже" });
      const u = req.payUser;
      if ((u.balanceRub || 0) < PAY_RATE_RUB) return res.status(402).json({ success: false, message: "Недостаточно средств: минимум " + PAY_RATE_RUB + " ₽ (одна страница). Пополните баланс." });
      const files = req.files || [];
      if (!files.length) return res.status(400).json({ success: false, message: "Прикрепите файл (PDF, DOCX или фото)" });
      const total = files.reduce((s, f) => s + f.size, 0);
      if (total > MAX_TOTAL_SRC) return res.status(413).json({ success: false, message: "Слишком большие файлы (лимит 45 МБ на заказ)" });
      const named = files.map((f) => ({ f, name: Buffer.from(f.originalname, "latin1").toString("utf8") }));
      const bad = named.find((x) => !srcSupported(x.name));
      if (bad) return res.status(400).json({ success: false, message: "Формат «" + bad.name + "» не поддерживается. Можно: PDF, DOCX, TXT, JPG/PNG/WEBP." });
      const docCount = named.filter((x) => !/\.(jpe?g|png|webp|gif)$/i.test(x.name)).length;
      if (docCount > 1 || (docCount === 1 && files.length > 1)) return res.status(400).json({ success: false, message: "Либо один документ (PDF/DOCX/TXT), либо несколько фото — не смешивайте" });
      const b = req.body || {};
      const order = {
        id: newId(), num: nextNum(), kind: "pay", ownerEmail: u.email, createdAt: Date.now(), status: "new",
        params: {
          translit: String(b.translit || "").slice(0, 200),
          country: String(b.country || "").slice(0, 100),
          targetLang: String(b.targetLang || "en").slice(0, 40),
          note: String(b.note || "").slice(0, 1000),
        },
        src: [], files: {},
      };
      named.forEach((x, i) => { order.src.push({ file: saveFile(order.id, "src-" + i, x.f.buffer, x.name, x.f.mimetype), name: x.name }); });
      const st = store();
      st.orders.unshift(order);
      if (st.orders.length > MAX_ORDERS) st.orders.length = MAX_ORDERS;
      save();
      queueTranslate(order);
      return res.json({ success: true, id: order.id });
    } catch (e) { return res.status(500).json({ success: false, message: e.message }); }
  });

  app.get("/translate_pay/api/order/:id", requirePayUser, (req, res) => {
    const o = payOrderOf(req);
    if (!o) return res.status(404).json({ success: false, message: "Не найден" });
    return res.json({ success: true, order: payView(o, true) });
  });

  app.get("/translate_pay/api/order/:id/file/:which", requirePayUser, (req, res) => {
    const o = payOrderOf(req);
    if (!o) return res.status(404).send("Не найден");
    const which = req.params.which;
    let fn = null, dlName = null;
    if (which === "docx") { fn = o.files && o.files.docx; dlName = docxDlName(o); }
    else if (which === "html") { fn = o.files && o.files.html; }
    if (!fn) return res.status(404).send("Нет файла");
    let buf;
    try { buf = readFileBuf(fn); } catch (_) { return res.status(404).send("Файл утерян"); }
    res.set("Content-Type", mimeByExt(fn));
    if (dlName) res.set("Content-Disposition", "attachment; filename*=UTF-8''" + encodeURIComponent(dlName));
    return res.send(buf);
  });

  app.post("/translate_pay/api/order/:id/correct", requirePayUser, (req, res) => {
    const o = payOrderOf(req);
    if (!o) return res.status(404).json({ success: false, message: "Не найден" });
    if (o.status !== "done") return res.status(400).json({ success: false, message: "Заказ ещё не готов" });
    if ((o.corrections || []).length >= 3) return res.status(400).json({ success: false, message: "Лимит корректировок по заказу — 3. Напишите нам, если нужно больше." });
    const instruction = String((req.body && req.body.text) || "").trim();
    if (!instruction) return res.status(400).json({ success: false, message: "Опишите, что поправить" });
    queueCorrect(o, instruction, "клиент " + req.payUser.email);
    return res.json({ success: true });
  });

  // Заявка на пополнение — черновик: письмо директору, зачисление вручную.
  app.post("/translate_pay/api/topup", requirePayUser, (req, res) => {
    const rub = Math.round(Number((req.body && req.body.rub) || 0));
    if (!(rub >= 100 && rub <= 100000)) return res.status(400).json({ success: false, message: "Сумма пополнения — от 100 до 100 000 ₽" });
    const u = req.payUser;
    payOp(u, "topup-request", 0, "Заявка на пополнение " + rub + " ₽ (ожидает подтверждения)");
    save();
    const mailMod = require("./mail");
    mailMod.sendMail({
      to: "director@visa-sc.ru",
      subject: "Переводы (SaaS): заявка на пополнение " + rub + " ₽",
      html: "<p>Клиент <b>" + u.email + "</b>" + (u.name ? " (" + u.name + ")" : "") + " хочет пополнить баланс на <b>" + rub + " ₽</b>.</p><p>Текущий баланс: " + (u.balanceRub || 0) + " ₽. Свяжитесь с клиентом, примите оплату и скажите Клоду «зачисли " + rub + " ₽ клиенту " + u.email + "».</p>",
    }).catch((e) => console.error("pay topup mail:", e.message));
    return res.json({ success: true, message: "Заявка принята — менеджер свяжется с вами по e-mail для оплаты. Онлайн-оплата картой появится позже." });
  });

  // ── Разовый сторож баланса Anthropic (просьба Андрея 11.08) ──────────────
  // Обычному API-ключу баланс в Anthropic не виден, поэтому считаем сами:
  // старт $20 (пополнение 10.08.2026), минус расход по журналам spend всех
  // заказов с этого момента. Остаток ≤ $5 → ОДНО письмо директору (маркер
  // alertedAt). После следующего пополнения новую сумму задаёт Клод — сказать
  // ему «пополнил на X», он сбросит счётчик.
  {
    const st0 = store();
    if (!st0.balance) { st0.balance = { usd: 20, since: Date.parse("2026-08-10T00:00:00+03:00"), thresholdUsd: 5, alertedAt: null }; save(); }
  }
  function spendSinceUsd(ts) {
    const st = store();
    let usd = 0;
    const entries = [...st.orders.flatMap((o) => o.spend || []), ...(st.spendArchive || [])];
    for (const e of entries) {
      if ((e.at || 0) < ts) continue;
      const rate = PRICES[e.model] || PRICES["claude-sonnet-5"];
      usd += ((e.in || 0) + (e.cr || 0) * 0.1 + (e.cw || 0) * 1.25) * rate[0] / 1e6 + (e.out || 0) * rate[1] / 1e6;
    }
    return usd;
  }
  async function checkAiBalance() {
    try {
      const b = store().balance;
      if (!b || b.alertedAt) return;
      const left = b.usd - spendSinceUsd(b.since);
      if (left > b.thresholdUsd) return;
      const mailMod = require("./mail");
      const r = await mailMod.sendMail({
        to: "director@visa-sc.ru",
        subject: "⚠️ Переводы: на балансе Anthropic осталось ≈ $" + left.toFixed(2),
        html: "<p>По расчёту сервиса переводов, от пополнения $" + b.usd + " осталось <b>≈ $" + left.toFixed(2) + "</b> (порог предупреждения — $" + b.thresholdUsd + ").</p>"
          + "<p>Пополнить: console.anthropic.com → Billing → Add funds. Точный остаток — там же на главной (Organization credits).</p>"
          + "<p>Это разовое письмо. После пополнения скажите Клоду новую сумму — он перезапустит счётчик. Цифра оценочная (считается по журналу вызовов сервиса), фактический остаток в кабинете может немного отличаться.</p>",
      });
      if (r && r.ok) { b.alertedAt = Date.now(); b.lastLeftUsd = +left.toFixed(2); save(); console.log("translate: письмо о низком балансе отправлено, остаток ≈ $" + left.toFixed(2)); }
      else console.error("translate balance mail:", (r && r.error) || "unknown");
    } catch (e) { console.error("translate balance watch:", e.message); }
  }
  setInterval(checkAiBalance, 30 * 60 * 1000);
  setTimeout(checkAiBalance, 90 * 1000);

  // ── Сторож канала до Anthropic (просьба Андрея 12.08) ─────────────────────
  // Раз в час пробуем основной ретранслятор. Любой HTTP-ответ = канал жив
  // (даже 4xx — это уже ответ Anthropic); TLS-обрыв/таймаут = канал упал
  // (так выглядела блокировка Cloudflare). Два подряд провала → письмо
  // директору (раз в сутки) и, если задан запасной, переключение на него.
  // Когда основной оживает — тихо возвращаемся.
  async function probeBase(base) {
    try {
      const r = await fetch(base + "/v1/models", {
        headers: { "x-api-key": process.env.ANTHROPIC_API_KEY || "", "anthropic-version": "2023-06-01" },
        signal: AbortSignal.timeout(20000),
      });
      return r.status > 0;
    } catch (_) { return false; }
  }
  async function checkChannel() {
    try {
      if (!aiConfigured()) return;
      const { prim, back } = baseUrls();
      if (!prim) return;
      const ch = channelState();
      if (await probeBase(prim)) {
        if (ch.useBackup) console.log("translate: основной канал ожил — возвращаюсь с запасного");
        if (ch.useBackup || ch.fails) { ch.useBackup = false; ch.fails = 0; save(); }
        return;
      }
      ch.fails = (ch.fails || 0) + 1;
      if (ch.fails < 2) { save(); return; }
      if (back && !ch.useBackup) { ch.useBackup = true; console.warn("translate: основной канал упал — переключил на запасной"); }
      if (!ch.alertedAt || Date.now() - ch.alertedAt > 24 * 3600 * 1000) {
        const mailMod = require("./mail");
        const r = await mailMod.sendMail({
          to: "director@visa-sc.ru",
          subject: back ? "Переводы: основной канал до Anthropic упал — работаем через запасной" : "⚠️ Переводы ВСТАЛИ: канал до Anthropic недоступен",
          html: back
            ? "<p>Ретранслятор на deno.net перестал отвечать (похоже на блокировку домена). Сервис автоматически переключился на запасной канал и продолжает работать.</p><p>Ничего срочного, но стоит сказать Клоду — он проверит, что случилось.</p>"
            : "<p>Ретранслятор на deno.net перестал отвечать (похоже на блокировку домена), запасной канал не настроен — переводы сейчас не работают.</p><p>Скажите Клоду «канал упал» — он поднимет запасной на другой площадке за несколько минут (нужен один деплой на vercel.com по готовому файлу).</p>",
        }).catch(() => null);
        if (r && r.ok) ch.alertedAt = Date.now();
      }
      save();
    } catch (e) { console.error("translate channel watch:", e.message); }
  }
  setInterval(checkChannel, 60 * 60 * 1000);
  setTimeout(checkChannel, 3 * 60 * 1000);

  // ── Автоочистка файлов старых заказов (место на диске + гигиена ПДн) ──────
  // Через TRANSLATE_KEEP_DAYS (дефолт 60) сканы клиентов и готовые файлы
  // удаляются; сам заказ, отчёты, статистика и расход остаются.
  const KEEP_DAYS = Math.max(7, Number(process.env.TRANSLATE_KEEP_DAYS || 60));
  function purgeOldFiles() {
    try {
      const cutoff = Date.now() - KEEP_DAYS * 24 * 3600 * 1000;
      let n = 0;
      for (const o of store().orders) {
        if (o.filesPurged || (o.createdAt || 0) > cutoff) continue;
        if (["new", "queued", "translating", "checking", "revising"].indexOf(o.status) >= 0 || o.compareStatus === "processing" || o.correctStatus === "processing") continue;
        const all = [...(o.src || []).map((f) => f.file), ...((o.srcOriginal || []).map((f) => f.file)), o.files && o.files.html, o.files && o.files.docx, o.files && o.files.human].filter(Boolean);
        for (const fn of all) { try { fs.unlinkSync(path.join(FILES_DIR, fn)); } catch (_) {} }
        o.filesPurged = true; o.files = {}; n++;
      }
      if (n) { save(); console.log("translate: очищены файлы заказов старше " + KEEP_DAYS + " дн.:", n); }
    } catch (e) { console.error("translate purge:", e.message); }
  }
  setInterval(purgeOldFiles, 12 * 3600 * 1000);
  setTimeout(purgeOldFiles, 5 * 60 * 1000);

  app.get("/translate/api/stats", requireTranslate, (req, res) => {
    const st = store();
    const all = st.orders.filter((o) => o.kind !== "pay");
    const done = all.filter((o) => o.status === "done");
    const tally = (arr, keyFn) => {
      const m = new Map();
      arr.forEach((o) => { const k = keyFn(o) || "—"; m.set(k, (m.get(k) || 0) + 1); });
      return Array.from(m, ([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count);
    };
    // Среднее число страниц на одну фамилию: заказы группируем по транслитерации
    // (если её не указали — по первому файлу, чтобы не слипались разные клиенты).
    const byClient = new Map();
    done.forEach((o) => {
      const k = ((o.params && o.params.translit) || "").trim().toUpperCase() || ("файл:" + ((o.src[0] && o.src[0].name) || o.id));
      const rec = byClient.get(k) || { orders: 0, pages: 0 };
      rec.orders++; rec.pages += (o.meta && o.meta.pages) || 1;
      byClient.set(k, rec);
    });
    const clients = Array.from(byClient, ([name, r]) => ({ name, orders: r.orders, pages: r.pages }));
    const pagesTotal = done.reduce((s, o) => s + ((o.meta && o.meta.pages) || 1), 0);
    const withIssues = done.filter((o) => o.check && o.check.verdict && o.check.verdict !== "ok").length;
    const revised = done.filter((o) => o.check && o.check.revised).length;
    const corrections = all.reduce((s, o) => s + ((o.corrections || []).length), 0);
    const durations = done.filter((o) => o.doneAt && o.createdAt).map((o) => (o.doneAt - o.createdAt) / 1000);
    const months = new Map();
    done.forEach((o) => {
      const d = new Date(o.createdAt);
      const k = d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0");
      const rec = months.get(k) || { orders: 0, pages: 0 };
      rec.orders++; rec.pages += (o.meta && o.meta.pages) || 1;
      months.set(k, rec);
    });
    const costs = all.map(orderCost);
    const usd = costs.reduce((s, c) => s + c.usd, 0);
    const approxOrders = costs.filter((c) => !c.exact).length;
    res.json({
      success: true, model: model(),
      totals: {
        orders: all.length, done: done.length,
        inWork: all.filter((o) => ["new", "queued", "translating", "checking", "revising"].indexOf(o.status) >= 0).length,
        errors: all.filter((o) => o.status === "error").length,
        pages: pagesTotal,
        clients: clients.length,
        avgPagesPerOrder: done.length ? +(pagesTotal / done.length).toFixed(1) : 0,
        avgPagesPerClient: clients.length ? +(pagesTotal / clients.length).toFixed(1) : 0,
        lessons: lessons().length,
        corrections,
        withIssues, revised,
        avgSec: durations.length ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : 0,
        costRub: Math.round(usd * 80),
        costPerOrderRub: all.length ? +(usd * 80 / all.length).toFixed(1) : 0,
        costPerPageRub: pagesTotal ? +(usd * 80 / pagesTotal).toFixed(1) : 0,
        costApproxOrders: approxOrders,
      },
      byCountry: tally(done, (o) => (o.params && o.params.country || "").trim()),
      byType: tally(done, (o) => (o.meta && o.meta.docType) || ""),
      byLang: tally(done, (o) => langName((o.params && o.params.targetLang) || "en")),
      bySource: tally(all, (o) => ({ manual: "Страница", bot: "Бот в чате", chat: "Тихий чат", review: "Сверка прошлых" }[o.kind] || o.kind)),
      byMonth: Array.from(months, ([name, r]) => ({ name, orders: r.orders, pages: r.pages })).sort((a, b) => a.name.localeCompare(b.name)),
      topClients: clients.sort((a, b) => b.pages - a.pages).slice(0, 10),
      reviewVerdicts: tally(all.filter((o) => o.compare), (o) => ({ match: "совпадает с человеком", minor: "мелкие расхождения", major: "серьёзные расхождения" }[o.compare.verdict] || o.compare.verdict)),
    });
  });

  // ── Приём заказа целиком из портала Кати (ТЗ 6.1): FormData meta (JSON) + files ──
  // meta: {number, dealId, dealName, country, author, apps: [{translit, files: [{name,
  // docType, srcLang, lang, scope, range, pages, from, to, orient, keepLayout}]}]}.
  // Каждый файл — свой внутренний заказ (kind "portal"), группа связана номером ЕЗ7;
  // отчёт по группе уходит на её server/report, когда все файлы готовы.
  function parsePageRange(str) {
    const out = new Set();
    String(str || "").split(/[,;]+/).forEach((part) => {
      const m = part.trim().match(/^(\d+)\s*[-–—]\s*(\d+)$/);
      if (m) { for (let i = +m[1]; i <= +m[2] && i <= +m[1] + 500; i++) out.add(i); }
      else if (/^\d+$/.test(part.trim())) out.add(+part.trim());
    });
    return Array.from(out).filter((n) => n >= 1).sort((a, b) => a - b);
  }
  async function extractPdfPages(buf, pageNums) {
    const { PDFDocument } = require("pdf-lib");
    const srcDoc = await PDFDocument.load(buf, { ignoreEncryption: true });
    const n = srcDoc.getPageCount();
    const idx = pageNums.filter((p) => p <= n).map((p) => p - 1);
    if (!idx.length || idx.length === n) return buf;
    const nd = await PDFDocument.create();
    (await nd.copyPages(srcDoc, idx)).forEach((pg) => nd.addPage(pg));
    return Buffer.from(await nd.save());
  }
  async function portalOrderIntake(req, res) {
    let meta;
    try { meta = JSON.parse(String(req.body.meta)); } catch (_) { return res.status(400).json({ success: false, message: "Поле meta — не JSON" }); }
    const number = String(meta.number || "").trim().slice(0, 20);
    if (!number) return res.status(400).json({ success: false, message: "В meta нет номера заказа (number)" });
    if (store().orders.some((o) => o.portal && o.portal.number === number)) return res.status(400).json({ success: false, message: "Заказ " + number + " уже принят в перевод" });
    const files = req.files || [];
    const flat = [];
    (Array.isArray(meta.apps) ? meta.apps : []).forEach((a) => (Array.isArray(a.files) ? a.files : []).forEach((f) => flat.push({ app: a, f })));
    if (!flat.length) return res.status(400).json({ success: false, message: "В meta нет файлов" });
    if (files.length !== flat.length) return res.status(400).json({ success: false, message: "Файлов приложено " + files.length + ", а в meta перечислено " + flat.length + " — порядок и состав должны совпадать" });
    // Валидация до создания заказов — чтобы не оставить полгруппы при ошибке.
    for (let i = 0; i < files.length; i++) {
      const name = Buffer.from(files[i].originalname, "latin1").toString("utf8");
      if (!srcSupported(name)) return res.status(400).json({ success: false, message: "Формат «" + name + "» не поддерживается. Можно: PDF, DOCX, TXT, JPG/PNG/WEBP." });
      if (files[i].size > MAX_TOTAL_SRC) return res.status(413).json({ success: false, message: "Файл «" + name + "» больше 45 МБ" });
    }
    const created = [];
    for (let i = 0; i < flat.length; i++) {
      const { app, f } = flat[i];
      const name = Buffer.from(files[i].originalname, "latin1").toString("utf8");
      let buf = files[i].buffer;
      let rangeNote = "";
      if (String(f.scope) === "part" && f.range) {
        if (/\.pdf$/i.test(name)) {
          try { buf = await extractPdfPages(buf, parsePageRange(f.range)); }
          catch (e) { rangeNote = "Переводить ТОЛЬКО страницы: " + f.range; console.warn("translate portal: не вырезал страницы из PDF:", e.message); }
        } else rangeNote = "Переводить ТОЛЬКО страницы: " + f.range;
      }
      const noteBits = [];
      if (f.docType) noteBits.push("Тип документа: " + String(f.docType).slice(0, 100));
      const srcLang = String(f.srcLang || "ru").toLowerCase();
      if (srcLang && srcLang !== "ru") noteBits.push("Язык оригинала: " + srcLang + " (переводить С этого языка)");
      if (rangeNote) noteBits.push(rangeNote);
      if (String(f.orient) === "landscape") noteBits.push("Страницы оригинала альбомные — помечай их class=\"page landscape\"");
      if (f.keepLayout) noteBits.push("Строго сохранить вёрстку и разбивку на страницы как в оригинале");
      const order = {
        id: newId(), num: nextNum(), kind: "portal", createdAt: Date.now(), status: "new",
        params: {
          translit: String(app.translit || "").slice(0, 200),
          country: String(meta.country || "").slice(0, 100),
          targetLang: String(f.lang || "en").slice(0, 40),
          note: noteBits.join(". ").slice(0, 1000),
        },
        meta: f.docType ? { docType: String(f.docType).slice(0, 100) } : undefined,
        portal: {
          number, dealId: String(meta.dealId || "").slice(0, 20), dealName: String(meta.dealName || "").slice(0, 200),
          author: String(meta.author || (req.staff && (req.staff.name || req.staff.email)) || "").slice(0, 100),
          pagesDeclared: Math.max(0, Math.round(Number(f.pages) || 0)),
          from: String(f.from || "").slice(0, 10), to: String(f.to || "").slice(0, 10),
        },
        dlToken: crypto.randomBytes(12).toString("hex"),
        src: [], files: {},
      };
      order.src.push({ file: saveFile(order.id, "src-0", buf, name, files[i].mimetype), name });
      created.push(order);
    }
    const st = store();
    created.slice().reverse().forEach((o) => st.orders.unshift(o));
    if (st.orders.length > MAX_ORDERS) st.orders.length = MAX_ORDERS;
    save();
    created.forEach(queueTranslate);
    return res.json({ success: true, orderId: "grp-" + number, ids: created.map((o) => o.id) });
  }

  app.post("/translate/api/order", requireTranslate, up.array("files", 40), (req, res) => {
    try {
      if (!aiConfigured()) return res.status(400).json({ success: false, message: "ИИ не настроен: добавьте ANTHROPIC_API_KEY в .env на сервере и перезапустите" });
      if (req.body && req.body.meta) return void portalOrderIntake(req, res).catch((e) => { try { res.status(500).json({ success: false, message: e.message }); } catch (_) {} });
      const files = req.files || [];
      if (!files.length) return res.status(400).json({ success: false, message: "Прикрепите файл (PDF, DOCX или фото)" });
      const total = files.reduce((s, f) => s + f.size, 0);
      if (total > MAX_TOTAL_SRC) return res.status(413).json({ success: false, message: "Слишком большие файлы (лимит 45 МБ на заказ)" });
      const named = files.map((f) => ({ f, name: Buffer.from(f.originalname, "latin1").toString("utf8") })); // multer отдаёт имя в latin1
      const bad = named.find((x) => !srcSupported(x.name));
      if (bad) return res.status(400).json({ success: false, message: "Формат «" + bad.name + "» не поддерживается. Можно: PDF, DOCX, TXT, JPG/PNG/WEBP. Старый .doc пересохраните в PDF/DOCX." });
      const docCount = named.filter((x) => !/\.(jpe?g|png|webp|gif)$/i.test(x.name)).length;
      if (docCount > 1 || (docCount === 1 && files.length > 1)) return res.status(400).json({ success: false, message: "Либо один документ (PDF/DOCX/TXT), либо несколько фото — не смешивайте" });
      const b = req.body || {};
      const order = {
        id: newId(), num: nextNum(), kind: "manual", createdAt: Date.now(), status: "new",
        params: {
          translit: String(b.translit || "").slice(0, 200),
          country: String(b.country || "").slice(0, 100),
          targetLang: String(b.targetLang || "en").slice(0, 40),
          note: String(b.note || "").slice(0, 1000),
        },
        src: [], files: {},
      };
      named.forEach((x, i) => {
        order.src.push({ file: saveFile(order.id, "src-" + i, x.f.buffer, x.name, x.f.mimetype), name: x.name });
      });
      const st = store();
      st.orders.unshift(order);
      if (st.orders.length > MAX_ORDERS) st.orders.length = MAX_ORDERS;
      save();
      queueTranslate(order);
      return res.json({ success: true, id: order.id });
    } catch (e) { return res.status(500).json({ success: false, message: e.message }); }
  });

  // ── «Проверка прошлых переводов»: пары «оригинал + перевод человека» ──
  // Принимаем либо два файла (original/human), либо архив ZIP со всем скопом.
  // В архиве пары ищем по имени: одинаковая основа имени, либо папки
  // «оригинал/original/source/скан» ↔ «перевод/translation/готовое», либо
  // суффиксы _ru/_en, «-перевод», «-translated».
  const REVIEW_SRC = SRC_EXT;
  function normBase(name) {
    return String(name).toLowerCase()
      .replace(/\.[^.]+$/, "")
      .replace(/[_\-\s]*(перевод\w*|translation|translated|translate|итог\w*|готов\w*|final|eng?|en|ru|rus|orig\w*|оригинал\w*|скан|scan|source|src)[_\-\s]*/g, " ")
      .replace(/[^a-zа-я0-9]+/gi, " ").trim();
  }
  function looksTranslated(p) { return /(перевод|translat|_en\b|-en\b|\ben\b|eng|final|готов|итог)/i.test(p); }
  function looksOriginal(p) { return /(оригинал|origin|source|src|скан|scan|_ru\b|-ru\b|\bru\b|rus)/i.test(p); }
  // Стыковка файлов архива в пары «оригинал ↔ перевод». Несколько стратегий,
  // от самой надёжной к запасной; каждый файл участвует только в одной паре.
  function pairArchiveEntries(entries) {
    const pairs = [], used = new Set();
    const free = () => entries.map((_, i) => i).filter((i) => !used.has(i));
    // Кто из двоих оригинал: сначала по явным подсказкам в пути, затем по типу
    // (перевод обычно DOCX/TXT, оригинал — скан PDF/фото).
    const isDoc = (e) => /\.(docx?|txt)$/i.test(e.name);
    function takePair(a, b) {
      const A = entries[a], B = entries[b];
      let orig = a, tr = b;
      if (looksTranslated(A.path) && !looksTranslated(B.path)) { orig = b; tr = a; }
      else if (looksOriginal(B.path) && !looksOriginal(A.path)) { orig = b; tr = a; }
      else if (isDoc(A) && !isDoc(B)) { orig = b; tr = a; }
      used.add(orig); used.add(tr);
      pairs.push({ original: entries[orig], human: entries[tr] });
    }
    function groupAndPair(keyFn) {
      const groups = new Map();
      for (const i of free()) {
        const k = keyFn(entries[i]);
        if (!k) continue;
        if (!groups.has(k)) groups.set(k, []);
        groups.get(k).push(i);
      }
      for (const [, idxs] of groups) {
        const avail = idxs.filter((i) => !used.has(i));
        if (avail.length === 2) takePair(avail[0], avail[1]);
        else if (avail.length > 2) {
          // Больше двух файлов с одним ключом: разбиваем на оригиналы/переводы
          // и стыкуем попарно по порядку.
          const tr = avail.filter((i) => looksTranslated(entries[i].path) || isDoc(entries[i]));
          const or = avail.filter((i) => tr.indexOf(i) < 0);
          for (let k = 0; k < Math.min(or.length, tr.length); k++) takePair(or[k], tr[k]);
        }
      }
    }
    // 1) Одинаковое имя файла (обычно папки «Оригиналы» и «Переводы»).
    groupAndPair((e) => e.name.toLowerCase());
    // 2) Имя без служебных слов: «справка_оригинал.pdf» ↔ «справка_перевод.docx».
    groupAndPair((e) => normBase(e.name));
    // 3) Общая папка на заказ: «Костенко/скан.pdf» + «Костенко/перевод.docx».
    groupAndPair((e) => (path.dirname(e.path) === "." ? "" : path.dirname(e.path).toLowerCase()));
    // 4) Запасной вариант: в архиве ровно два файла — это пара.
    if (!pairs.length && entries.length === 2) takePair(0, 1);
    const unpaired = entries.filter((_, i) => !used.has(i)).map((e) => e.path);
    return { pairs, unpaired };
  }
  function makeReviewOrder(origBuf, origName, humanBuf, humanName, meta) {
    const order = {
      id: newId(), num: nextNum(), kind: "review", createdAt: Date.now(), status: "new",
      params: { translit: (meta && meta.translit) || "", country: (meta && meta.country) || "", targetLang: (meta && meta.targetLang) || "en", note: (meta && meta.note) || "" },
      src: [], files: {},
    };
    order.src.push({ file: saveFile(order.id, "src-0", origBuf, origName, ""), name: origName });
    order.files.human = saveFile(order.id, "human", humanBuf, humanName, "");
    order.humanName = humanName;
    const st = store();
    st.orders.unshift(order);
    if (st.orders.length > MAX_ORDERS) st.orders.length = MAX_ORDERS;
    return order;
  }

  app.post("/translate/api/review", requireTranslate, up.fields([{ name: "original", maxCount: 1 }, { name: "human", maxCount: 1 }, { name: "archive", maxCount: 1 }]), (req, res) => {
    try {
      if (!aiConfigured()) return res.status(400).json({ success: false, message: "ИИ не настроен (ANTHROPIC_API_KEY)" });
      const f = req.files || {};
      const nameOf = (x) => Buffer.from(x.originalname, "latin1").toString("utf8");
      const meta = req.body || {};
      const created = [];

      if (f.archive && f.archive[0]) {
        const a = f.archive[0];
        const aname = nameOf(a);
        if (!/\.zip$/i.test(aname)) return res.status(400).json({ success: false, message: "Архив поддерживается только ZIP. RAR/7z распакуйте у себя и загрузите ZIP или файлы по отдельности." });
        const AdmZip = require("adm-zip");
        let entries;
        try { entries = new AdmZip(a.buffer).getEntries(); } catch (e) { return res.status(400).json({ success: false, message: "Не смог открыть архив: " + e.message }); }
        const files = entries
          .filter((e) => !e.isDirectory && !/(^|\/)(__MACOSX|\.)/i.test(e.entryName))
          .map((e) => ({ path: e.entryName, name: path.basename(e.entryName), buf: e.getData() }))
          .filter((e) => srcSupported(e.name) && e.buf.length > 0 && e.buf.length <= 25 * 1024 * 1024);
        if (!files.length) return res.status(400).json({ success: false, message: "В архиве не нашёл подходящих файлов (PDF, DOCX, TXT, JPG/PNG)" });
        const { pairs, unpaired } = pairArchiveEntries(files);
        if (!pairs.length) return res.status(400).json({ success: false, message: "Не смог разобрать, где оригиналы, а где переводы. Назовите файлы одинаково с пометкой (например «справка_оригинал.pdf» и «справка_перевод.docx») или загрузите пары по одной." });
        for (const p of pairs.slice(0, 50)) created.push(makeReviewOrder(p.original.buf, p.original.name, p.human.buf, p.human.name, meta));
        // ТЗ 6.2: номер прогона обучения из портала Кати (ОБ7) — по нему потом
        // отчитываемся расходом на её learn-cost.
        if (meta.number) created.forEach((o) => { o.portalLearn = String(meta.number).slice(0, 20); });
        save();
        created.forEach(queueReview);
        return res.json({
          success: true, created: created.length, unpaired, ids: created.map((o) => o.id),
          pairs: pairs.slice(0, 50).map((p) => ({ original: p.original.path, human: p.human.path })),
        });
      }

      if (!f.original || !f.original[0] || !f.human || !f.human[0]) return res.status(400).json({ success: false, message: "Нужны оба файла: оригинал и перевод человека (или ZIP-архив)" });
      const o = f.original[0], h = f.human[0];
      if (!srcSupported(nameOf(o))) return res.status(400).json({ success: false, message: "Формат оригинала не поддерживается (нужен PDF, DOCX, TXT или фото)" });
      const order = makeReviewOrder(o.buffer, nameOf(o), h.buffer, nameOf(h), meta);
      if (meta.number) order.portalLearn = String(meta.number).slice(0, 20);
      save();
      queueReview(order);
      return res.json({ success: true, created: 1, id: order.id, ids: [order.id] });
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
      else { o.pendingCompare = true; save(); }
      return res.json({ success: true });
    } catch (e) { return res.status(500).json({ success: false, message: e.message }); }
  });

  // Корректировка со страницы (тот же механизм, что «исправь:» в чате).
  app.post("/translate/api/order/:id/correct", requireTranslate, (req, res) => {
    const o = findOrder(req.params.id);
    if (!o) return res.status(404).json({ success: false, message: "Не найден" });
    if (o.status !== "done") return res.status(400).json({ success: false, message: "Заказ ещё не готов" });
    const instruction = String((req.body && req.body.text) || "").trim();
    if (!instruction) return res.status(400).json({ success: false, message: "Пустая корректировка" });
    queueCorrect(o, instruction, (req.staff && (req.staff.name || req.staff.email)) || "страница");
    return res.json({ success: true });
  });

  app.post("/translate/api/order/:id/rebuild", requireTranslate, async (req, res) => {
    const o = findOrder(req.params.id);
    if (!o) return res.status(404).json({ success: false, message: "Не найден" });
    const html = currentHtml(o);
    if (!html) return res.status(400).json({ success: false, message: "Нет сохранённого перевода" });
    try {
      await buildOutputs(o, html);
      save();
      return res.json({ success: true, docx: !!(o.files && o.files.docx), docxError: o.docxError || null });
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
    // Журнал расхода удалённого заказа сохраняем отдельно — иначе удаление
    // «возвращает» деньги в оценку остатка баланса и статистику.
    if (Array.isArray(o.spend) && o.spend.length) {
      st.spendArchive = st.spendArchive || [];
      st.spendArchive.push(...o.spend);
      if (st.spendArchive.length > 5000) st.spendArchive.splice(0, st.spendArchive.length - 5000);
    }
    st.orders.splice(i, 1);
    save();
    return res.json({ success: true });
  });

  // Правила бота: добавить своё / удалить.
  app.post("/translate/api/lesson", requireTranslate, (req, res) => {
    const text = String((req.body && req.body.text) || "").trim().slice(0, 500);
    if (!text) return res.status(400).json({ success: false, message: "Пустое правило" });
    lessons().push({ id: newId(), createdAt: Date.now(), text, source: "manual" });
    save();
    return res.json({ success: true });
  });
  app.delete("/translate/api/lesson/:id", requireTranslate, (req, res) => {
    const ls = lessons();
    const i = ls.findIndex((l) => l.id === req.params.id);
    if (i < 0) return res.status(404).json({ success: false, message: "Не найдено" });
    ls.splice(i, 1);
    save();
    return res.json({ success: true });
  });

  app.get("/translate/api/order/:id/file/:which", requireTranslate, (req, res) => {
    const o = findOrder(req.params.id);
    if (!o) return res.status(404).send("Не найден");
    const which = req.params.which;
    let fn = null, dlName = null;
    if (which === "docx") { fn = o.files && o.files.docx; dlName = docxDlName(o); }
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

  // ── Портал Кати: привязка номера прогона, правки по группе, скачивание ──
  // Её страница сначала шлёт пары на /review, потом регистрирует прогон у себя
  // (номер ОБ7 появляется после) — этим вызовом номер доклеивается к уже
  // созданным заказам, и по завершении уходит learn-cost.
  app.post("/translate/api/review/attach", requireTranslate, (req, res) => {
    const b = req.body || {};
    const number = String(b.number || "").trim().slice(0, 20);
    const ids = Array.isArray(b.ids) ? b.ids : [];
    if (!number || !ids.length) return res.status(400).json({ success: false, message: "Нужны number и ids" });
    let n = 0;
    for (const id of ids) { const o = findOrder(String(id)); if (o) { o.portalLearn = number; n++; } }
    save();
    try { portalLearnReport(number); } catch (_) {} // вдруг прогоны уже успели завершиться
    return res.json({ success: true, attached: n });
  });

  // ТЗ 6.3: правки менеджера по заказу портала — применяем ко всем файлам
  // группы, по завершении отчитываемся статусом returned (+ свежие ссылки и cost).
  app.post("/translate/api/portal/correct", requireTranslate, (req, res) => {
    const b = req.body || {};
    const number = String(b.number || "").trim().slice(0, 20);
    const text = String(b.text || "").trim();
    if (!number || !text) return res.status(400).json({ success: false, message: "Нужны number и text" });
    const list = portalGroupOrders(number).filter((o) => o.status === "done");
    if (!list.length) return res.status(404).json({ success: false, message: "По заказу " + number + " нет готовых переводов" });
    const author = (req.staff && (req.staff.name || req.staff.email)) || "портал";
    list.forEach((o) => { o.portalFixPending = true; });
    const st = store();
    if (st.portalSent) delete st.portalSent[number]; // после правки итоговый отчёт должен уйти заново
    save();
    list.forEach((o) => {
      queueCorrect(o, text, author);
      // Цепочка per-order гарантирует: эта задача выполнится после правки.
      enqueue("portalfix " + o.id, async () => {
        const cur = findOrder(o.id);
        if (cur) { cur.portalFixPending = false; save(); }
        try { portalGroupReport(number, { returned: true }); } catch (e) { console.error("portal returned:", e.message); }
      });
    });
    return res.json({ success: true, orders: list.length });
  });

  // Скачивание результата по неугадываемому токену заказа (кнопки в карточке
  // заказа у Кати; авторизации нет — токен случайный per-order).
  app.get("/translate/api/dl/:id/:tok/:which", (req, res) => {
    const o = findOrder(req.params.id);
    if (!o || !o.dlToken || o.dlToken !== req.params.tok) return res.status(404).send("Не найдено");
    let fn = null, dlName = null;
    if (req.params.which === "docx") { fn = o.files && o.files.docx; dlName = docxDlName(o); }
    else if (req.params.which === "html") { fn = o.files && o.files.html; }
    if (!fn) return res.status(404).send("Нет файла");
    let buf;
    try { buf = readFileBuf(fn); } catch (_) { return res.status(404).send("Файл утерян (хранение 60 дней)"); }
    res.set("Content-Type", mimeByExt(fn));
    if (dlName) res.set("Content-Disposition", "attachment; filename*=UTF-8''" + encodeURIComponent(dlName));
    return res.send(buf);
  });

  // ТЗ 7: источник правила — единый словарь manual|review|correction|auto.
  // Старые записи мигрируем на месте (прежнее значение остаётся в sourceRef).
  (function migrateLessonSources() {
    let changed = false;
    for (const l of lessons()) {
      const s = String(l.source || "");
      if (["manual", "review", "correction", "auto"].indexOf(s) >= 0) continue;
      if (s) l.sourceRef = s;
      l.source = /^review:/.test(s) ? "review" : (/^[0-9a-f]{12}$/.test(s) ? "correction" : "auto");
      changed = true;
    }
    if (changed) save();
  })();

  // Недоставленные отчёты порталу — дошлём (её сервис могли перезапускать).
  setInterval(() => { portalFlush().catch(() => {}); }, 60000);
  setTimeout(() => { portalFlush().catch(() => {}); }, 15000);

  // Отложенные сравнения (человек прислал раньше, чем ИИ доделал) — добираем.
  setInterval(() => {
    for (const o of store().orders) {
      if (o.pendingCompare && o.status === "done" && o.compareStatus !== "processing") { o.pendingCompare = false; save(); queueCompare(o); }
    }
  }, 15000);

  backfillNums();
  backfillMeta();
  ymStartPolling();
}

module.exports = { mount };
