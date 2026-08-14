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
const MAX_TOTAL_SRC = 20 * 1024 * 1024; // base64 раздувает ×1.33, лимит API — 32MB на запрос
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
async function srcBlocks(order, cache) {
  const blocks = await srcBlocksRaw(order);
  if (cache && blocks.length) blocks[blocks.length - 1] = Object.assign({}, blocks[blocks.length - 1], { cache_control: { type: "ephemeral" } });
  return blocks;
}
async function srcBlocksRaw(order) {
  const blocks = [];
  for (const f of order.src) {
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

// ── Claude ────────────────────────────────────────────────────────────────
function aiConfigured() { return !!process.env.ANTHROPIC_API_KEY; }
let _client = null;
function client() {
  if (!aiConfigured()) return null;
  if (!_client) {
    const { Anthropic } = require("@anthropic-ai/sdk");
    const opts = {
      apiKey: process.env.ANTHROPIC_API_KEY,
      baseURL: process.env.ANTHROPIC_BASE_URL || undefined,
      timeout: 15 * 60 * 1000, maxRetries: 2,
    };
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

function langName(code) { return code === "en" ? "английский" : (code || "английский"); }
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
    .replace(/\s+width\s*=\s*"[0-9.]+%"/gi, ""); // %-атрибуты роняют конвертер — убираем
}

async function buildOutputs(order, html) {
  const landscape = detectLandscape(html);
  html = fitHtmlForDocx(html, landscape);
  order.landscape = landscape;
  const fullHtml = "<!DOCTYPE html><html><head><meta charset=\"utf-8\"><title>Перевод</title><style>body{font-family:'Times New Roman',serif;max-width:" + (landscape ? 1160 : 820) + "px;margin:24px auto;padding:0 16px;color:#111}table{border-collapse:collapse;width:100%;margin:8px 0}td,th{border:1px solid #444;padding:4px 6px;font-size:13px}section.page{page-break-after:always;margin-bottom:36px;border-bottom:1px dashed #bbb;padding-bottom:24px}.tr-note{color:#333}</style></head><body>" + html + "</body></html>";
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
    console.error("translate docx:", e.message);
    order.docxError = "DOCX не собрался: " + e.message;
  }
}
function currentHtml(order) {
  try { return readFileBuf(order.files.html).toString("utf8").replace(/^[\s\S]*?<body>/, "").replace(/<\/body>[\s\S]*$/, ""); } catch (_) { return ""; }
}
function docxDlName(order) {
  return "Перевод " + (((order.src[0] && order.src[0].name) || order.id).replace(/\.[^.]+$/, "")) + ".docx";
}

// ── Проверка вторым проходом ──────────────────────────────────────────────
async function runCheck(order, html) {
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
    messages: [{ role: "user", content: [...(await srcBlocks(order)), { type: "text", text: task }] }],
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
  const pages = (String(html).match(/<section class="page"/g) || []).length || (order.src || []).length || 1;
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
  const task = "РЕЖИМ: переводчик, правка. Выше — оригинал, ниже — текущий перевод (HTML) и корректировка от заказчика. Внеси правку и верни ПОЛНЫЙ исправленный HTML-перевод целиком, тем же форматом (<section class=\"page\">, таблицы <table>), без markdown и ```-ограждений. Ничего не ломай в местах, которых правка не касается."
    + lessonsPromptBlock()
    + "\n\nТекущий перевод:\n\n" + html + "\n\nКорректировка заказчика (выполни её):\n" + instruction + (p.translit ? "\n\nТранслитерация ФИО: " + p.translit : "");
  const r = await runClaude({
    model: model(), max_tokens: 60000,
    system: SYS_COMMON,
    output_config: { effort: effortMain() },
    messages: [{ role: "user", content: [...(await srcBlocks(order, true)), { type: "text", text: task }] }],
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
    for (const t of newOnes) lessons().push({ id: newId(), createdAt: Date.now(), text: t.slice(0, 500), source: order.id });
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
    messages: [{ role: "user", content: [...(await srcBlocks(order)), ...content, { type: "text", text: task }] }],
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
  for (const t of newOnes) lessons().push({ id: newId(), createdAt: Date.now(), text: t.slice(0, 500), source: "review:" + order.id });
  order.learned = newOnes;
  save();
  return newOnes;
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
    try {
      await pipelineTranslate(o);
      if (o.kind === "bot") await botDeliver(o).catch((e) => console.error("botDeliver:", e.message));
    } catch (e) {
      o.status = "error"; o.error = String((e && e.message) || e); save();
      if (o.kind === "bot") await botSay(o, "⚠️ Не получилось перевести: " + o.error).catch(() => {});
    }
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
    checkVerdict: (o.check && o.check.verdict) || null,
    checkRevised: !!(o.check && o.check.revised),
    humanName: o.humanName || null,
    compareStatus: o.compareStatus || null, compareVerdict: (o.compare && o.compare.verdict) || null,
    compareError: o.compareError || null,
    correctStatus: o.correctStatus || null,
    correctionsCnt: (o.corrections || []).length,
    learned: o.learned || null,
    chat: o.chat ? { from: o.chat.from, text: o.chat.text } : null,
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

  // Доступ: код /translate ИЛИ админ ИЛИ руководитель с "translate" в vscRestrict.tabs (Зайцева).
  function requireTranslate(req, res, next) {
    const tok = tokenFromReq(req);
    const rec = tok && authTokens()[tok];
    if (rec && Date.now() - (rec.at || 0) <= TOKEN_TTL) { req.staff = { role: "translate", name: "сотрудник (код)" }; return next(); }
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
      botConfigured: botConfigured(), quietChats: quietChatIds(),
      botChats: st.bot.chats || {},
      lessons: lessons().slice().reverse(),
      orders: st.orders.map((o) => orderView(o, false)),
    });
  });

  // ── Аналитика (черновая вкладка «Дашборд», запрос Зайцевой 08.08) ──
  // Считаем на лету из orders.json: заказов мало (до 500), отдельного хранилища
  // не заводим. Цены моделей — для прикидки расхода, курс 80 ₽/$.
  const PRICES = { // $ за 1M токенов: [вход, выход]
    "claude-opus-5": [5, 25], "claude-sonnet-5": [3, 15], "claude-haiku-4-5": [1, 5],
  };
  // Считаем по накопительному журналу spend (все проходы, каждый по своей
  // модели). Для заказов, сделанных до появления журнала, — прикидка по
  // последнему проходу и текущей модели, такие помечаем отдельно.
  function orderCost(o) {
    let usd = 0;
    if (Array.isArray(o.spend) && o.spend.length) {
      for (const e of o.spend) {
        const rate = PRICES[e.model] || PRICES["claude-sonnet-5"];
        usd += ((e.in || 0) + (e.cr || 0) * 0.1 + (e.cw || 0) * 1.25) * rate[0] / 1e6 + (e.out || 0) * rate[1] / 1e6;
      }
      return { usd, exact: true };
    }
    // Заказы без журнала — это всё, что переведено до 08.08.2026, а тогда
    // сервис работал на Opus 5. Считаем их по его тарифу, иначе расход
    // занижается почти вдвое.
    const rate = PRICES["claude-opus-5"];
    for (const v of Object.values(o.usage || {})) {
      if (!v) continue;
      usd += ((v.input_tokens || 0) + (v.cache_read_input_tokens || 0) * 0.1 + (v.cache_creation_input_tokens || 0) * 1.25) * rate[0] / 1e6
        + (v.output_tokens || 0) * rate[1] / 1e6;
    }
    return { usd, exact: false };
  }
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

  app.get("/translate/api/stats", requireTranslate, (req, res) => {
    const st = store();
    const all = st.orders;
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

  app.post("/translate/api/order", requireTranslate, up.array("files", 10), (req, res) => {
    try {
      if (!aiConfigured()) return res.status(400).json({ success: false, message: "ИИ не настроен: добавьте ANTHROPIC_API_KEY в .env на сервере и перезапустите" });
      const files = req.files || [];
      if (!files.length) return res.status(400).json({ success: false, message: "Прикрепите файл (PDF, DOCX или фото)" });
      const total = files.reduce((s, f) => s + f.size, 0);
      if (total > MAX_TOTAL_SRC) return res.status(413).json({ success: false, message: "Слишком большие файлы (лимит 20 МБ на заказ) — разбейте на части" });
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
        save();
        created.forEach(queueReview);
        return res.json({
          success: true, created: created.length, unpaired,
          pairs: pairs.slice(0, 50).map((p) => ({ original: p.original.path, human: p.human.path })),
        });
      }

      if (!f.original || !f.original[0] || !f.human || !f.human[0]) return res.status(400).json({ success: false, message: "Нужны оба файла: оригинал и перевод человека (или ZIP-архив)" });
      const o = f.original[0], h = f.human[0];
      if (!srcSupported(nameOf(o))) return res.status(400).json({ success: false, message: "Формат оригинала не поддерживается (нужен PDF, DOCX, TXT или фото)" });
      const order = makeReviewOrder(o.buffer, nameOf(o), h.buffer, nameOf(h), meta);
      save();
      queueReview(order);
      return res.json({ success: true, created: 1, id: order.id });
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
