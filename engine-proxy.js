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
//         превышении ENGINE_DAILY_BUDGET_RUB (дефолт 3000 ₽/сутки) отвечает 429 —
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

const ENGINE = { host: "127.0.0.1", port: Number(process.env.ENGINE_PORT || 3003) };
const BUDGET_FILE = path.join(__dirname, ".engineBudget.json");
const PRICES = { // $ за 1M токенов: [вход, выход] — как в движке
  "claude-opus-5": [5, 25], "claude-sonnet-5": [3, 15], "claude-haiku-4-5": [1, 5],
};
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
function usdOf(model, u) {
  const rate = PRICES[model] || PRICES["claude-sonnet-5"];
  return ((u.input_tokens || 0) + (u.cache_read_input_tokens || 0) * 0.1 + (u.cache_creation_input_tokens || 0) * 1.25) * rate[0] / 1e6
    + (u.output_tokens || 0) * rate[1] / 1e6;
}

function mountEarly(app, deps) {
  const { getStaffFromReq, sendMail, publicDir } = deps;
  const SECRET = String(process.env.ENGINE_SECRET || "");
  const ALLOWED = String(process.env.ENGINE_ALLOWED_MODELS || "claude-sonnet-5,claude-haiku-4-5").split(",").map((s) => s.trim()).filter(Boolean);
  const FORCED = process.env.TRANSLATE_MODEL || "claude-sonnet-5";
  const DAILY_RUB = Number(process.env.ENGINE_DAILY_BUDGET_RUB || 3000);
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
    const p = http.request({ host: ENGINE.host, port: ENGINE.port, path: req.originalUrl, method: req.method, headers }, (r) => {
      res.writeHead(r.statusCode || 502, r.headers);
      r.pipe(res);
    });
    p.on("error", () => {
      if (!res.headersSent) res.status(502).json({ success: false, message: "Движок переводов временно недоступен" });
      else res.end();
    });
    req.pipe(p);
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
    if (req.method === "POST" && d.usd * RUB >= DAILY_RUB) {
      if (!budget.alerts[day + ":100"]) {
        budget.alerts[day + ":100"] = Date.now(); saveBudget(budget);
        sendMail({ to: ALERT_TO, subject: "Движок переводов: суточный бюджет исчерпан", text: "Расход движка переводов за " + day + " достиг " + Math.round(d.usd * RUB) + " ₽ (лимит ENGINE_DAILY_BUDGET_RUB = " + DAILY_RUB + " ₽). Новые запросы к Anthropic отклоняются до полуночи МСК. Если это штатная нагрузка — поднимите лимит в .env основного приложения и перезапустите voyo." }).catch(() => {});
      }
      return res.status(429).json({ type: "error", error: { type: "rate_limit_error", message: "Суточный бюджет движка переводов исчерпан (" + DAILY_RUB + " ₽) — обратитесь к Андрею" } });
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
    const headers = { "x-api-key": KEY, "content-type": "application/json", accept: req.headers.accept || "application/json" };
    for (const k of Object.keys(req.headers)) if (/^anthropic-/i.test(k)) headers[k] = req.headers[k];
    let up;
    try {
      up = await fetch(BASE + sub, { method: req.method, headers, body: req.method === "POST" || req.method === "PUT" ? JSON.stringify(body || {}) : undefined, signal: AbortSignal.timeout(15 * 60 * 1000) });
    } catch (e) {
      return res.status(502).json({ type: "error", error: { type: "api_error", message: "канал до Anthropic: " + e.message } });
    }
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
      if (seen) {
        const usd = usdOf(model || FORCED, u);
        const b2 = loadBudget();
        const d2 = b2.days[day] || (b2.days[day] = { usd: 0, calls: 0, forced: 0 });
        d2.usd += usd; d2.calls++; d2.forced = (d2.forced || 0) + forcedNow;
        // чистим журнал старше 90 дней
        for (const k of Object.keys(b2.days)) if (k < new Date(Date.now() - 90 * 86400e3).toISOString().slice(0, 10)) delete b2.days[k];
        if (d2.usd * RUB >= DAILY_RUB * 0.8 && !b2.alerts[day + ":80"]) {
          b2.alerts[day + ":80"] = Date.now();
          sendMail({ to: ALERT_TO, subject: "Движок переводов: 80% суточного бюджета", text: "Расход движка переводов за " + day + " — " + Math.round(d2.usd * RUB) + " ₽ из " + DAILY_RUB + " ₽ (ENGINE_DAILY_BUDGET_RUB). Запросов: " + d2.calls + ". Если это не штатная нагрузка — проверьте, что Катя не запустила массовые прогоны; лимит сработает на 100%." }).catch(() => {});
        }
        saveBudget(b2);
      }
    } catch (e) { console.warn("engine-proxy usage:", e.message); }
  });

  // ── 4. Почта от имени движка ──
  app.post("/internal/engine/mail", express.json({ limit: "1mb" }), async (req, res) => {
    if (!isLocal(req)) return res.status(403).json({ ok: false, error: "local only" });
    if (!SECRET || String(req.headers["x-engine-secret"] || "") !== SECRET) return res.status(401).json({ ok: false, error: "engine secret mismatch" });
    const b = req.body || {};
    if (!b.to || !b.subject) return res.status(400).json({ ok: false, error: "нужны to и subject" });
    try { res.json(await sendMail({ to: b.to, subject: String(b.subject).slice(0, 200), text: b.text, html: b.html, replyTo: b.replyTo })); }
    catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  // Сводка расхода для админа (читается из /admin при желании)
  app.get("/internal/engine/budget", (req, res) => {
    if (!isLocal(req)) return res.status(403).end();
    const b = loadBudget();
    res.json({ ok: true, dailyLimitRub: DAILY_RUB, allowedModels: ALLOWED, days: Object.fromEntries(Object.entries(b.days).sort().slice(-31).map(([k, v]) => [k, { rub: Math.round(v.usd * RUB), calls: v.calls, forced: v.forced || 0 }])) });
  });
}

module.exports = { mountEarly };
