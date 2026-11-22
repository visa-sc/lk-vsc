// ─────────────────────────────────────────────────────────────────────────
// Мост основного приложения к ДВИЖКУ ПЕРЕВОДОВ (22.08.2026).
//
// Сам движок (translate.js) с 22.08 живёт отдельным сервисом translate-engine
// (/var/www/translate-engine, :3003, юзер kateadmin) — его правит Екатерина
// Зайцева самостоятельно. Здесь остаётся только то, что ей давать нельзя:
//
//  1. Прокси /translate/api/* и /translate_pay/api/* → :3003. Токен проверяем
//     здесь (getStaffFromReq) и передаём роль заголовком x-voyo-staff; входящий
//     такой заголовок снаружи вырезаем (подделать нельзя).
//  2. Страницы /translate, /translate_old, /translate_pay — статика из public
//     основного приложения (их Андрей просил не трогать).
//  3. /internal/anthropic/* — шлюз к Anthropic для движка. Настоящий ключ только
//     здесь; движок шлёт x-api-key = ENGINE_SECRET. Шлюз:
//       • держит модель в белом списке ENGINE_ALLOWED_MODELS (дефолт
//         claude-sonnet-5,claude-haiku-4-5) — чужую модель подменяет на
//         TRANSLATE_MODEL, т.е. включить дорогую модель из движка нельзя;
//       • считает расход по usage из ответов (в т.ч. из SSE-потока) и при
//         превышении ENGINE_DAILY_BUDGET_USD (дефолт 15 $/сутки, по решению Андрея 22.08) отвечает 429 —
//         предохранитель от регулярных задач, жгущих баланс; на 80% и на 100%
//         пишет письмо Андрею (раз в сутки каждое). Журнал: .engineBudget.json.
//  4. /internal/engine/mail — письма от имени движка через mail.js (SMTP здесь).
//
// Монтируется РАНЬШЕ express.json основного приложения: прокси нужны сырые тела
// (multipart до 45 МБ), а шлюзу Anthropic — тела до 64 МБ (документы в base64).
// ─────────────────────────────────────────────────────────────────────────
const http = require("http");
const fs = require("fs");
const path = require("path");
const express = require("express");
const economy = require("./engine-economy"); // экономия на правках группы и выводе правил (06.10.2026)

const ENGINE = { host: "127.0.0.1", port: Number(process.env.ENGINE_PORT || 3003) };
const BUDGET_FILE = path.join(__dirname, ".engineBudget.json");
// $ за 1M токенов: [вход, выход]. Sonnet 5 стоит $2/$10 (до 05.10.2026 здесь
// стояли $3/$15 от Sonnet 4.6 — расход переводов завышался в полтора раза, и
// письмо о балансе показывало меньше денег, чем в консоли).
const PRICES = {
  "claude-opus-5": [5, 25], "claude-sonnet-5": [2, 10], "claude-haiku-4-5": [1, 5],
  // новые модели (21.11.2026): Opus 5.5 $4/$20, Sonnet 5.5 $2/$10, Haiku 5.5 $0.10/$0.50 (запросы до 100K токенов)
  "claude-opus-5-5": [4, 20], "claude-sonnet-5-5": [2, 10], "claude-haiku-5-5": [0.1, 0.5],
};

// ── Переход на новые модели (Андрей 21.11.2026) ─────────────────────────────
// ENGINE_MODEL_UPGRADE="старая=новая,сервис:старая=новая" — шлюз сам меняет модель в запросе.
// Клиентам (прослушка Кати, сканеры, переводы) ничего править не нужно, их код остаётся прежним.
// Откат — убрать строку из .env и перезапустить voyo.
// Плюс файл .engineModels.json рядом ({"upgrade":"..."}) — его пишет tools/modelSwitch.js и шлюз перечитывает
// его на лету: переключение без перезапуска voyo, чтобы не оборвать идущий перевод (поток до 15 минут).
const MODELS_FILE = path.join(__dirname, ".engineModels.json");
let _mf = { mtime: 0, upgrade: "", upgradeIf: [] };
function readModelsFile() {
  try {
    const mt = fs.statSync(MODELS_FILE).mtimeMs;
    if (mt !== _mf.mtime) { const j = JSON.parse(fs.readFileSync(MODELS_FILE, "utf8")); _mf = { mtime: mt, upgrade: String(j.upgrade || ""), upgradeIf: Array.isArray(j.upgradeIf) ? j.upgradeIf : [] }; }
  } catch (_) { _mf = { mtime: 0, upgrade: "", upgradeIf: [] }; }
  return _mf;
}
function fileUpgrade() { return readModelsFile().upgrade; }
const sysText = (b) => typeof (b && b.system) === "string" ? b.system : Array.isArray(b && b.system) ? b.system.map((x) => (x && x.text) || "").join("") : "";
// upgradeFor(сервис, модель[, тело запроса]). Без тела — только правила на весь сервис.
// upgradeIf в .engineModels.json — перевод только части запросов сервиса, по началу system
// (22.11: у прослушки на Haiku 5.5 только чистка расшифровок, оценки остаются на Haiku 4.5).
function upgradeFor(svc, model, body) {
  for (const part of [process.env.ENGINE_MODEL_UPGRADE || "", fileUpgrade()].join(",").split(",").map((s) => s.trim()).filter(Boolean)) {
    const m = part.match(/^(?:([a-z0-9_-]+):)?([a-z0-9.-]+)=([a-z0-9.-]+)$/i);
    if (m && (!m[1] || m[1] === svc) && m[2] === model) return m[3];
  }
  if (body) for (const r of readModelsFile().upgradeIf) {
    if (r && r.svc === svc && r.from === model && r.to && r.systemStarts && sysText(body).indexOf(String(r.systemStarts)) === 0) return String(r.to);
  }
  return null;
}
// Новые модели строже к настройкам запроса: Haiku 5.5 по умолчанию «думает» (съест маленький max_tokens
// сканера и прослушки), Sonnet 5.5 не принимает thinking disabled, у всех 5.5 нельзя менять temperature.
// Приводим запрос к тому, что новая модель принимает, и даём ей место на размышления.
function adaptForModel(body) {
  const m = String((body && body.model) || "");
  if (!/^claude-(haiku|sonnet|opus)-5-5$/.test(m)) return body;
  delete body.temperature; delete body.top_p; delete body.top_k;
  const th = body.thinking;
  if (m === "claude-haiku-5-5") {
    // Haiku 5.5 думает по умолчанию. Без размышлений она ошибалась в сроке паспорта из MRZ (3 из 3),
    // с размышлениями на low — верно 3 из 3 при +~200 токенов (доли цента). Поэтому: размышления на low,
    // а к max_tokens — запас 1024, чтобы размышления не съели ответ (у сканера и прослушки бывает 250–400).
    if (!th || th.type === "enabled") body.thinking = { type: "adaptive" };
    body.output_config = Object.assign({ effort: "low" }, body.output_config || {});
    // Запас: размышления + у Haiku 5.5 другой счёт токенов (русский текст выходит длиннее). 22.11: при +1024 три длинные
    // чистки расшифровок прослушки обрезались на max_tokens — теперь вдвое, но не меньше +2048. Платим только за потраченное.
    if (body.thinking.type !== "disabled") { const mt = Number(body.max_tokens) || 1024; body.max_tokens = Math.min(64000, Math.max(mt * 2, mt + 2048)); }
  } else if (th && th.type === "enabled") body.thinking = { type: "adaptive" };
  else if (m === "claude-sonnet-5-5" && th && th.type === "disabled") body.thinking = { type: "between_tools" };
  else if (m === "claude-opus-5-5" && th && th.type === "disabled") delete body.thinking;
  return body;
}
// Текст ответа модели (JSON или SSE) — для сравнения старой и новой модели.
function outText(text, ct) {
  let out = "";
  if (/text\/event-stream/i.test(ct || "")) {
    for (const line of String(text).split("\n")) {
      if (line.indexOf("data:") !== 0) continue;
      let ev; try { ev = JSON.parse(line.slice(5).trim()); } catch (_) { continue; }
      if (ev.type === "content_block_delta" && ev.delta) out += ev.delta.text || ev.delta.partial_json || "";
    }
    return out;
  }
  let j; try { j = typeof text === "string" ? JSON.parse(text) : text; } catch (_) { return ""; }
  for (const b of (j && j.content) || []) out += b.type === "text" ? b.text : b.type === "tool_use" ? JSON.stringify(b.input) : "";
  return out;
}
// Сравнение на живых запросах (ENGINE_SHADOW="сервис:старая>новая:сколько;…"): ответ клиенту даёт
// старая модель как раньше, а тот же запрос в фоне уходит в новую. Оба ответа — в /var/lib/engine-shadow/<сервис>.jsonl.
const SHADOW_DIR = "/var/lib/engine-shadow";
function shadowRule(svc, model) {
  if (upgradeFor(svc, model)) return null;   // сервис уже переведён — сравнивать больше нечего
  for (const part of String(process.env.ENGINE_SHADOW || "").split(";").map((s) => s.trim()).filter(Boolean)) {
    const m = part.match(/^([a-z0-9_-]+):([a-z0-9.-]+)>([a-z0-9.-]+):(\d+)$/i);
    if (!m || m[1] !== svc || m[2] !== model) continue;
    let n = 0; try { n = fs.readFileSync(path.join(SHADOW_DIR, svc + ".jsonl"), "utf8").split("\n").filter(Boolean).length; } catch (_) {}
    if (n < Number(m[4])) return { to: m[3] };
  }
  return null;
}
const RUB = Number(process.env.TRANSLATE_USD_RUB || 80);

// «Локальный» = пришёл напрямую с loopback И не через прокси: nginx и сервис Кати
// (:3002) тоже стучатся с 127.0.0.1, но ставят X-Forwarded-For/X-Real-IP — такие
// запросы внешние. Движок (:3003) ходит напрямую, без этих заголовков.
function isLocal(req) {
  const ip = String(req.socket.remoteAddress || "");
  if (!(ip === "127.0.0.1" || ip === "::ffff:127.0.0.1" || ip === "::1")) return false;
  if (req.headers["x-forwarded-for"] || req.headers["x-real-ip"] || req.headers["x-forwarded-host"]) return false;
  return true;
}
function mskDay() {
  return new Date(Date.now() + 3 * 3600 * 1000).toISOString().slice(0, 10);
}
function loadBudget() {
  try { return JSON.parse(fs.readFileSync(BUDGET_FILE, "utf8")); } catch (_) { return { days: {}, alerts: {} }; }
}
function saveBudget(b) { try { fs.writeFileSync(BUDGET_FILE, JSON.stringify(b, null, 1)); } catch (e) { console.error("engineBudget save:", e.message); } }
// Какой сервис пришёл в шлюз. Ключ у движка переводов и у модуля «Качество
// коммуникации» (прослушка звонков и переписок у Кати) СЕЙЧАС ОДИН: её код читает
// его из .env движка. Поэтому различаем по подписи клиента — движок ходит через
// Anthropic SDK и шлёт его служебные заголовки (user-agent: Anthropic/JS,
// x-stainless-*), её модуль стучится голым http.request без них. Заголовок
// x-voyo-service, если он есть, важнее догадки: новый сервис называет себя сам,
// и тогда ничего угадывать не нужно.
const SVC_TITLES = { translate: "Переводы документов", cq: "Прослушка (качество коммуникации)", scanner: "Сканер паспортов" };
function svcTitle(id) { return SVC_TITLES[id] || id; }
function svcOf(req) {
  const named = String(req.headers["x-voyo-service"] || "").trim().toLowerCase();
  if (named && /^[a-z0-9_-]{1,24}$/.test(named)) return named;
  if (req.headers["x-stainless-lang"] || /Anthropic\//i.test(String(req.headers["user-agent"] || ""))) return "translate";
  return "cq";
}
// Запись в кэш: на 5 минут — 1,25 входа, на час — 2. API отдаёт общий объём
// записи и отдельно часовую часть (cache_creation.ephemeral_1h_input_tokens),
// поэтому к 1,25 за всё доплачиваем 0,75 за часовую.
function cw1hOf(u) { return (u.cache_creation && u.cache_creation.ephemeral_1h_input_tokens) || 0; }
function usdOf(model, u) {
  const rate = PRICES[model] || PRICES["claude-sonnet-5"];
  return ((u.input_tokens || 0) + (u.cache_read_input_tokens || 0) * 0.1 + (u.cache_creation_input_tokens || 0) * 1.25 + cw1hOf(u) * 0.75) * rate[0] / 1e6
    + (u.output_tokens || 0) * rate[1] / 1e6;
}

function mountEarly(app, deps) {
  const { getStaffFromReq, sendMail, publicDir } = deps;
  const SECRET = String(process.env.ENGINE_SECRET || "");
  const ALLOWED = String(process.env.ENGINE_ALLOWED_MODELS || "claude-sonnet-5,claude-haiku-4-5").split(",").map((s) => s.trim()).filter(Boolean);
  const FORCED = process.env.TRANSLATE_MODEL || "claude-sonnet-5";
  const DAILY_USD = Number(process.env.ENGINE_DAILY_BUDGET_USD || 15); // суточный лимит в $ (решение Андрея: 15 $, не рубли)
  const fmt = (usd) => usd.toFixed(2) + " $ (≈" + Math.round(usd * RUB) + " ₽)";
  const ALERT_TO = process.env.ENGINE_ALERT_EMAIL || "director@visa-sc.ru";

  // ── 2. Страницы (остаются на основном приложении) ──
  const page = (file) => (req, res) => { res.set("Cache-Control", "no-store, no-cache, must-revalidate"); res.sendFile(path.join(publicDir, file)); };
  app.get("/translate", page("translate2.html"));
  app.get("/translate_old", page("translate.html"));
  app.get("/translate_v2", (req, res) => res.redirect(302, "/translate"));
  app.get("/translate_pay", page("translate_pay.html"));

  // ── 1. Прокси API движка ──
  const isApi = (u) => u.indexOf("/translate/api/") === 0 || u.indexOf("/translate_pay/api/") === 0;
  app.use((req, res, next) => {
    if (!isApi(req.path)) return next();
    const headers = Object.assign({}, req.headers);
    delete headers["x-voyo-staff"];
    let staff = null;
    try { staff = getStaffFromReq(req); } catch (_) {}
    if (staff) headers["x-voyo-staff"] = encodeURIComponent(JSON.stringify({ role: staff.role, name: staff.name, email: staff.email, perms: staff.perms, vscRestrict: staff.vscRestrict }));
    headers["x-forwarded-for"] = ((headers["x-forwarded-for"] ? headers["x-forwarded-for"] + ", " : "") + (req.socket.remoteAddress || "")).trim();
    // Правка на весь заказ из модуля Кати: шлюзу нужно знать её текст и сколько
    // файлов она затронет (см. engine-economy.js). Тело маленькое — читаем целиком.
    const groupFix = req.method === "POST" && req.path === "/translate/api/portal/correct";
    let groupText = "";
    const p = http.request({ host: ENGINE.host, port: ENGINE.port, path: req.originalUrl, method: req.method, headers }, (r) => {
      if (!groupFix) { res.writeHead(r.statusCode || 502, r.headers); return r.pipe(res); }
      const parts = [];
      r.on("data", (c) => parts.push(c));
      r.on("end", () => {
        const out = Buffer.concat(parts);
        try { const j = JSON.parse(out.toString("utf8")); economy.noteGroupResult(groupText, j && j.success ? Number(j.orders) || 0 : 0); }
        catch (_) { economy.noteGroupResult(groupText, 0); }
        res.writeHead(r.statusCode || 502, r.headers);
        res.end(out);
      });
    });
    p.on("error", () => {
      if (!res.headersSent) res.status(502).json({ success: false, message: "Движок переводов временно недоступен" });
      else res.end();
    });
    if (!groupFix) return req.pipe(p);
    const inParts = [];
    req.on("data", (c) => inParts.push(c));
    req.on("end", () => {
      const buf = Buffer.concat(inParts);
      try { const b = JSON.parse(buf.toString("utf8")); groupText = String((b && b.text) || "").trim(); economy.noteGroupStart(groupText, b && b.number); }
      catch (_) {}
      p.end(buf);
    });
  });

  // ── 3. Шлюз к Anthropic для движка ──
  const BASE = (process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com").replace(/\/+$/, "");
  const KEY = process.env.ANTHROPIC_API_KEY || "";
  app.use("/internal/anthropic", (req, res, next) => {
    if (!isLocal(req)) return res.status(403).json({ type: "error", error: { type: "permission_error", message: "local only" } });
    if (!SECRET || String(req.headers["x-api-key"] || "") !== SECRET) return res.status(401).json({ type: "error", error: { type: "authentication_error", message: "engine secret mismatch" } });
    next();
  }, express.json({ limit: "64mb" }), async (req, res) => {
    const sub = req.url; // остаток пути: /v1/messages, /v1/models...
    const budget = loadBudget();
    const day = mskDay();
    const d = budget.days[day] || (budget.days[day] = { usd: 0, calls: 0, forced: 0 });
    // Предохранитель: суточный бюджет исчерпан → 429 (движок покажет ошибку в заказе)
    if (req.method === "POST" && d.usd >= DAILY_USD) {
      if (!budget.alerts[day + ":100"]) {
        budget.alerts[day + ":100"] = Date.now(); saveBudget(budget);
        sendMail({ to: ALERT_TO, subject: "Движок переводов: суточный бюджет исчерпан", text: "Расход движка переводов за " + day + " достиг " + fmt(d.usd) + " — лимит ENGINE_DAILY_BUDGET_USD = " + DAILY_USD + " $. Новые запросы к Anthropic отклоняются до полуночи МСК. Если это штатная нагрузка — поднимите лимит в .env основного приложения и перезапустите voyo." }).catch(() => {});
      }
      return res.status(429).json({ type: "error", error: { type: "rate_limit_error", message: "Суточный бюджет движка переводов исчерпан (" + DAILY_USD + " $) — обратитесь к Андрею" } });
    }
    let body = req.body;
    let model = null, forcedNow = 0;
    if (req.method === "POST" && body && typeof body === "object" && body.model !== undefined) {
      model = String(body.model);
      if (ALLOWED.indexOf(model) < 0) { // чужая модель → принудительно разрешённая
        console.warn("engine-proxy: модель «" + model + "» не в белом списке — подставляю " + FORCED);
        body.model = FORCED; model = FORCED; forcedNow = 1;
      }
    }
    // Сравнение старой и новой модели: копия запроса ДО перевода на новую модель (только /v1/messages)
    let shadow = null;
    // Фоновые сравнения считаются в суточный лимит: за половиной лимита их не делаем, чтобы не отнять бюджет у настоящих переводов
    if (model && /^\/v1\/messages(\?|$)/.test(sub) && d.usd < DAILY_USD * 0.5) {
      try { const rule = shadowRule(svcOf(req), model); if (rule) shadow = { rule, from: model, body: JSON.parse(JSON.stringify(body)) }; } catch (_) {}
    }
    // Перевод на новую модель (ENGINE_MODEL_UPGRADE) и поправка настроек под неё
    let origBody = null;
    if (model) {
      const upm = upgradeFor(svcOf(req), model, body);
      if (upm) { origBody = JSON.parse(JSON.stringify(body)); body.model = upm; model = upm; }
      adaptForModel(body);
    }
    // Экономия на правках (engine-economy.js): только запросы движка переводов.
    // Любая ошибка здесь — просто обычный путь, запрос уходит к модели как раньше.
    let econ = null;
    if (req.method === "POST" && /^\/v1\/messages(\?|$)/.test(sub) && svcOf(req) === "translate") {
      try {
        econ = await economy.intercept(body, classifyCall);
        if (econ && econ.synthetic != null) return economy.respond(res, body, econ);
      } catch (e) { console.warn("engine-economy:", e.message); econ = null; }
    }
    const headers = { "x-api-key": KEY, "content-type": "application/json", accept: req.headers.accept || "application/json" };
    for (const k of Object.keys(req.headers)) if (/^anthropic-/i.test(k)) headers[k] = req.headers[k];
    let up;
    try {
      up = await fetch(BASE + sub, { method: req.method, headers, body: req.method === "POST" || req.method === "PUT" ? JSON.stringify(body || {}) : undefined, signal: AbortSignal.timeout(15 * 60 * 1000) });
    } catch (e) {
      if (econ && econ.after) econ.after(0);
      return res.status(502).json({ type: "error", error: { type: "api_error", message: "канал до Anthropic: " + e.message } });
    }
    // Подстраховка: новая модель ответила ошибкой (не лимит и не перегрузка общей очереди) — тот же запрос
    // уходит на прежнюю модель, клиент получает обычный ответ. Клиенту ещё ничего не отправлено.
    if (origBody && up.status >= 400 && up.status !== 429) {
      console.warn("engine-proxy: новая модель " + model + " ответила " + up.status + " — повторяю на " + origBody.model);
      try {
        const up2 = await fetch(BASE + sub, { method: "POST", headers, body: JSON.stringify(origBody), signal: AbortSignal.timeout(15 * 60 * 1000) });
        if (up2.ok || up2.status < up.status) { up = up2; model = origBody.model; }
      } catch (_) {}
    }
    // Подстраховка 2: новая модель упёрлась в max_tokens (ответ обрезан) — повторяем на прежней.
    // Только обычные (не потоковые) ответы: их можно проверить до отправки клиенту.
    if (origBody && up.ok && !body.stream && /json/i.test(up.headers.get("content-type") || "")) {
      try {
        const j = await up.clone().json();
        if (j && j.stop_reason === "max_tokens") {
          console.warn("engine-proxy: новая модель " + model + " обрезала ответ (max_tokens) — повторяю на " + origBody.model);
          if (j.usage) recordSpend(mskDay(), svcOf(req), model, j.usage, 0);
          const up2 = await fetch(BASE + sub, { method: "POST", headers, body: JSON.stringify(origBody), signal: AbortSignal.timeout(15 * 60 * 1000) });
          if (up2.ok) { up = up2; model = origBody.model; }
        }
      } catch (e) { console.warn("engine-proxy max_tokens:", e.message); }
    }
    if (econ && econ.after) econ.after(up.status);
    res.status(up.status);
    const ct = up.headers.get("content-type") || "application/json";
    res.set("content-type", ct);
    const rid = up.headers.get("request-id") || up.headers.get("x-request-id");
    if (rid) res.set("request-id", rid);
    // Пропускаем тело как есть и параллельно считаем usage (SSE или JSON)
    const dec = new TextDecoder();
    let text = "";
    const reader = up.body && up.body.getReader();
    if (reader) {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          res.write(Buffer.from(value));
          text += dec.decode(value, { stream: true });
          if (text.length > 50 * 1024 * 1024) text = text.slice(-1024 * 1024); // не копить гигабайты, usage в конце
        }
      } catch (e) { console.warn("engine-proxy stream:", e.message); }
    }
    res.end();
    // Учёт расхода
    try {
      const u = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
      let seen = false;
      if (/text\/event-stream/i.test(ct)) {
        for (const line of text.split("\n")) {
          if (line.indexOf("data:") !== 0) continue;
          let ev; try { ev = JSON.parse(line.slice(5).trim()); } catch (_) { continue; }
          if (ev.type === "message_start" && ev.message && ev.message.usage) { Object.assign(u, ev.message.usage); seen = true; if (!model && ev.message.model) model = ev.message.model; }
          if (ev.type === "message_delta" && ev.usage) { if (ev.usage.output_tokens != null) u.output_tokens = ev.usage.output_tokens; seen = true; }
        }
      } else {
        let j; try { j = JSON.parse(text); } catch (_) {}
        if (j && j.usage) { Object.assign(u, j.usage); seen = true; if (!model && j.model) model = j.model; }
      }
      if (seen) recordSpend(day, svcOf(req), model || FORCED, u, forcedNow);
    } catch (e) { console.warn("engine-proxy usage:", e.message); }
    // Фоновый прогон того же запроса на новой модели (клиент уже получил ответ, его это не задерживает)
    if (shadow && up.ok) {
      const svc = svcOf(req), aText = outText(text, ct), aModel = model;
      (async () => {
        const b2 = adaptForModel(Object.assign(shadow.body, { model: shadow.rule.to, stream: false }));
        const t0 = Date.now();
        const r2 = await fetch(BASE + "/v1/messages", { method: "POST", headers: Object.assign({}, headers, { accept: "application/json" }), body: JSON.stringify(b2), signal: AbortSignal.timeout(10 * 60 * 1000) });
        const j2 = await r2.json().catch(() => ({}));
        if (j2.usage) recordSpend(mskDay(), "model-eval", b2.model, j2.usage, 0);
        fs.mkdirSync(SHADOW_DIR, { recursive: true });
        fs.appendFileSync(path.join(SHADOW_DIR, svc + ".jsonl"), JSON.stringify({ at: new Date().toISOString(), svc, a: { model: aModel, text: aText.slice(0, 20000) },
          b: { model: b2.model, status: r2.status, ms: Date.now() - t0, text: outText(j2, "application/json").slice(0, 20000), stop: j2.stop_reason || null, error: j2.error ? String(j2.error.message || "").slice(0, 200) : null } }) + "\n");
      })().catch((e) => console.warn("engine-shadow:", e.message));
    }
  });

  // Записать расход в суточный журнал шлюза (общий итог, сервис, модель, токены).
  function recordSpend(day, svc, model, u, forcedNow) {
    const usd = usdOf(model, u);
    const b2 = loadBudget();
    const d2 = b2.days[day] || (b2.days[day] = { usd: 0, calls: 0, forced: 0 });
    d2.usd += usd; d2.calls++; d2.forced = (d2.forced || 0) + (forcedNow || 0);
    // Разбивка по сервисам: без неё расход прослушки сливался с переводами
    // в одну строку, и в письме о балансе было не видно, кто сколько съел.
    d2.svc = d2.svc || {};
    const sv = d2.svc[svc] || (d2.svc[svc] = { usd: 0, calls: 0 });
    sv.usd += usd; sv.calls++;
    // Какая модель реально работала. Нужно письму о балансе: модели задаются
    // переменными окружения и меняются, по коду их не угадать.
    const mid = String(model);
    sv.models = sv.models || {};
    sv.models[mid] = (sv.models[mid] || 0) + 1;
    // Токены, включая кэш: по ним видно, работает ли кэширование у сервиса.
    // Запись в кэш стоит 1,25 обычного входа, чтение — 0,1; если пишем много,
    // а читаем мало, кэш не экономит, а доплачивает.
    sv.tok = sv.tok || { in: 0, out: 0, cr: 0, cw: 0 };
    sv.tok.in += u.input_tokens || 0;
    sv.tok.out += u.output_tokens || 0;
    sv.tok.cr += u.cache_read_input_tokens || 0;
    sv.tok.cw += u.cache_creation_input_tokens || 0;
    sv.tok.cw1h = (sv.tok.cw1h || 0) + cw1hOf(u);
    // Деньги по моделям: если цена какой-то модели окажется неверной,
    // историю можно будет пересчитать точно, а не прикидкой.
    sv.usdBy = sv.usdBy || {};
    sv.usdBy[mid] = (sv.usdBy[mid] || 0) + usd;
    // чистим журнал старше 90 дней
    for (const k of Object.keys(b2.days)) if (k < new Date(Date.now() - 90 * 86400e3).toISOString().slice(0, 10)) delete b2.days[k];
    if (d2.usd >= DAILY_USD * 0.8 && !b2.alerts[day + ":80"]) {
      b2.alerts[day + ":80"] = Date.now();
      sendMail({ to: ALERT_TO, subject: "Движок переводов: 80% суточного бюджета", text: "Расход движка переводов за " + day + " — " + fmt(d2.usd) + " из " + DAILY_USD + " $ (ENGINE_DAILY_BUDGET_USD). Запросов: " + d2.calls + ". Если это не штатная нагрузка — проверьте, что Катя не запустила массовые прогоны; лимит сработает на 100%." }).catch(() => {});
    }
    saveBudget(b2);
  }

  // Классификатор «касается ли правка документа» — короткий запрос мимо движка.
  // Расход пишем в журнал как расход переводов: он делается ради них.
  async function classifyCall(params) {
    params = Object.assign({}, params);
    const upm = upgradeFor("translate", params.model); if (upm) params.model = upm;   // тот же переход на новые модели
    adaptForModel(params);
    const r = await fetch(BASE + "/v1/messages", {
      method: "POST",
      headers: { "x-api-key": KEY, "content-type": "application/json", "anthropic-version": "2023-06-01" },
      body: JSON.stringify(params), signal: AbortSignal.timeout(60 * 1000),
    });
    const j = await r.json().catch(() => null);
    if (!r.ok || !j) throw new Error("HTTP " + r.status);
    if (j.usage) recordSpend(mskDay(), "translate", params.model, j.usage, 0);
    return { text: (j.content || []).map((b) => (b && b.text) || "").join(""), usage: j.usage || {} };
  }

  economy.watch(sendMail); // сторож: экономия на правках не должна выключиться молча

  // ── 4. Почта от имени движка ──
  app.post("/internal/engine/mail", express.json({ limit: "1mb" }), async (req, res) => {
    if (!isLocal(req)) return res.status(403).json({ ok: false, error: "local only" });
    if (!SECRET || String(req.headers["x-engine-secret"] || "") !== SECRET) return res.status(401).json({ ok: false, error: "engine secret mismatch" });
    const b = req.body || {};
    if (!b.to || !b.subject) return res.status(400).json({ ok: false, error: "нужны to и subject" });
    try { res.json(await sendMail({ to: b.to, subject: String(b.subject).slice(0, 200), text: b.text, html: b.html, replyTo: b.replyTo })); }
    catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  // ── Сторож канала до Anthropic (24.08.2026) ──────────────────────────────
  // Весь ИИ-трафик (переводы, чат, сканер) идёт через ретранслятор
  // ANTHROPIC_BASE_URL: Anthropic не принимает запросы с российских адресов.
  // Раньше сторож жил в translate.js, но движок переехал к Кате и теперь ходит
  // на локальный шлюз — настоящий канал виден только отсюда. Раз в сутки ночью (03:30 МСК) пробуем
  // /v1/models: два провала подряд → письмо Андрею (не чаще раза в сутки) и,
  // если задан ANTHROPIC_BASE_URL_BACKUP, переключение на запасной адрес.
  let chFails = 0;
  async function probeChannel() {
    const base = (process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com").replace(/\/+$/, "");
    try {
      const r = await fetch(base + "/v1/models?limit=1", {
        headers: { "x-api-key": KEY, "anthropic-version": "2023-06-01" },
        signal: AbortSignal.timeout(30000),
      });
      if (!r.ok) throw new Error("HTTP " + r.status);
      if (chFails) console.log("engine-proxy: канал до Anthropic отвечает");
      chFails = 0;
      return;
    } catch (e) {
      chFails++;
      console.warn("engine-proxy: канал до Anthropic не ответил (" + chFails + "): " + e.message);
      if (chFails < 2) return;
      const b = loadBudget();
      const day = mskDay();
      if (!b.alerts[day + ":channel"]) {
        b.alerts[day + ":channel"] = Date.now(); saveBudget(b);
        const backup = process.env.ANTHROPIC_BASE_URL_BACKUP || "";
        sendMail({ to: ALERT_TO, subject: "ИИ-канал не отвечает: переводы, чат и сканер могут встать",
          text: "Ретранслятор до Anthropic (" + base.replace(/\/[^/]+$/, "/…") + ") не отвечает уже " + chFails + " проверки подряд: " + e.message +
            "\n\nЧерез него работают переводы, ИИ-чат и сканер паспортов — сейчас они будут отдавать ошибку канала." +
            (backup ? "\n\nЗапасной канал задан, но переключение делается вручную (ANTHROPIC_BASE_URL в .env)." :
              "\n\nЗапасного канала НЕТ. Частая причина — приостановка приложения на Deno Deploy из-за лимитов: проверьте console.deno.com (организация visa-sc).") }).catch(() => {});
      }
    }
  }
  // Ночная проверка: один провал бывает случайным, поэтому при неудаче
  // повторяем через минуту и только тогда пишем письмо.
  function nightlyCheck() {
    chFails = 0;
    probeChannel().then(() => { if (chFails) setTimeout(probeChannel, 60000); }).catch(() => {});
  }
  const msk = new Date(Date.now() + 3 * 3600 * 1000);
  let msTo0330 = ((((3 - msk.getUTCHours() + 24) % 24) * 60 + (30 - msk.getUTCMinutes())) * 60 - msk.getUTCSeconds()) * 1000;
  if (msTo0330 <= 0) msTo0330 += 24 * 3600000;
  setTimeout(() => { nightlyCheck(); setInterval(nightlyCheck, 24 * 3600000); }, msTo0330);
  console.log("engine-proxy: проверка ИИ-канала — раз в сутки в 03:30 МСК (ближайшая через " + Math.round(msTo0330 / 60000) + " мин)");

  // Сводка расхода для админа (читается из /admin при желании)
  app.get("/internal/engine/budget", (req, res) => {
    if (!isLocal(req)) return res.status(403).end();
    const b = loadBudget();
    res.json({ ok: true, dailyLimitUsd: DAILY_USD, allowedModels: ALLOWED, days: Object.fromEntries(Object.entries(b.days).sort().slice(-31).map(([k, v]) => [k, { usd: +v.usd.toFixed(3), rub: Math.round(v.usd * RUB), calls: v.calls, forced: v.forced || 0 }])) });
  });
}

module.exports = { mountEarly };
