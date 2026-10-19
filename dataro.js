// ═════════════════════════════════════════════════════════════════════════
// Данные только на чтение для своих Claude по личному ключу — /data-api/*
// (просьба Андрея 19.10.2026: дать Андрею Петрову «максимально глубокий доступ»
// ко всем данным, кроме финансов).
//
// Что открыто (всё только чтение):
//   • amoCRM живьём: GET /data-api/amo/<путь v4>?… — проксируем GET /api/v4/<путь>
//     через ОБЩИЙ лимитер amoCRM в НИЗКОЙ очереди (amoBg): клиентский ЛК и админка
//     всегда идут вперёд, при 429/403 фон встаёт на паузу. Плюс своя очередь ключа:
//     по одному запросу, не чаще AMO_GAP_MS, не больше AMO_DAY в сутки.
//   • копия amoCRM (crm.db, обновляется синхронизацией): GET /data-api/crm/sql?q=SELECT…
//     и /data-api/crm/schema. Запрос выполняется в ОТДЕЛЬНОМ процессе (tools/roSql.js)
//     с таймаутом и лимитом строк, база открыта только на чтение — тяжёлый запрос не
//     подвесит сайт и не нагружает API amoCRM. Предпочтительный путь.
//   • SMS.ru: баланс, статусы по sms_id, журнал отправленных SMS (наш).
//   • OnlinePBX (телефония): история звонков за период, состояние номеров.
//   • Яндекс.Директ: POST /data-api/direct/<сервис> — reports целиком, остальные
//     сервисы только method "get".
//   • опубликованные Google-таблицы без финансов (KPI, отзывы): список и CSV.
// Чего НЕТ: финансы (P&L, «Поток», сверки и модули Кати, прибыль, ФОТ и зарплаты,
// выкупы, возвраты, налоги, прогноз прибыли), запись куда-либо, отправка SMS.
//
// Ключи: DATA_RO_KEYS="имя:ключ,…" в .env (сейчас petrov). Отозвать — убрать пару и
// pm2 restart voyo --update-env. Журнал обращений — .dataRoLog.json (последние 5000).
// ═════════════════════════════════════════════════════════════════════════
const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");
const axios = require("axios");

const LOG = path.join(__dirname, ".dataRoLog.json");
const PHONETEST_STORE = path.join(__dirname, ".phonetest", "store.json");
const SMS_LOG = path.join(__dirname, ".esim", "smslog.json");
const AMO_GAP_MS = 700;
const LIMITS = { amo: 6000, sql: 3000, direct: 400, pbx: 300, sms: 2000, sheets: 1000 };   // в сутки на ключ

// Опубликованные таблицы без финансов. Финансовые (возвраты, выкупы, ЗП, прогноз
// прибыли) сюда не добавлять — решение Андрея 19.10.2026.
const SHEETS = {
  kpi: { title: "Таблица KPI по месяцам (вкладки «Месяц ГГГГ»): контакты, конверсии, CPL, ДРР, реклама, выручка", base: "https://docs.google.com/spreadsheets/d/e/2PACX-1vQfS5TX6tFZbbSZTNZhWVqRYvxBSt84vUERG1HRzJ5NOjsHDD4dd5DSkg_fWrSzIRKVk0evV6BVnC1V/pub" },
  reviews: { title: "Отзывы (Москва и Санкт-Петербург) по месяцам", base: "https://docs.google.com/spreadsheets/d/e/2PACX-1vRWz9BWp9Dzqj1TQivSvTQ12tE_06UzV3Dy2Lix5kyVBYUkUou9EHhCQvT3fVzafqwNYfCFeyp6UMrT/pub" },
};

function keys() {
  const out = {};
  for (const pair of String(process.env.DATA_RO_KEYS || "").split(",")) {
    const i = pair.indexOf(":");
    if (i > 0) { const name = pair.slice(0, i).trim(), key = pair.slice(i + 1).trim(); if (name && key.length >= 24) out[key] = name; }
  }
  return out;
}
const mskDay = () => new Date(Date.now() + 3 * 3600e3).toISOString().slice(0, 10);
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch (_) { return d; } };

function mount(deps) {
  const { app, amoBg, amoGet, amoBase } = deps;
  const counters = {};      // имя|день|вид → число
  const queues = {};        // имя → Promise (по одному запросу amo на ключ)
  const lastAmo = {};       // имя → время последнего запроса amo
  let logBuf = readJson(LOG, []);
  let logTimer = null;

  const log = (who, kind, what, status, ms) => {
    logBuf.push({ at: new Date().toISOString(), who, kind, what: String(what).slice(0, 300), status, ms });
    if (logBuf.length > 5000) logBuf = logBuf.slice(-5000);
    if (!logTimer) logTimer = setTimeout(() => { logTimer = null; try { fs.writeFileSync(LOG, JSON.stringify(logBuf)); } catch (_) {} }, 3000);
  };
  const auth = (req, res, next) => {
    const k = String(req.headers["x-ro-key"] || String(req.headers.authorization || "").replace(/^Bearer\s+/i, "") || "").trim();
    const who = keys()[k];
    if (!who) return res.status(401).json({ ok: false, error: "Нужен ключ: заголовок X-RO-Key" });
    req.roWho = who;
    next();
  };
  const quota = (req, res, kind) => {
    const c = req.roWho + "|" + mskDay() + "|" + kind;
    counters[c] = (counters[c] || 0) + 1;
    if (counters[c] > LIMITS[kind]) { res.status(429).json({ ok: false, error: "Дневной лимит «" + kind + "» исчерпан (" + LIMITS[kind] + "), завтра снова" }); return false; }
    return true;
  };
  const serial = (who, fn) => {
    const prev = queues[who] || Promise.resolve();
    const p = prev.catch(() => {}).then(async () => {
      const wait = (lastAmo[who] || 0) + AMO_GAP_MS - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      try { return await fn(); } finally { lastAmo[who] = Date.now(); }
    });
    queues[who] = p;
    return p;
  };

  app.get("/data-api", auth, (req, res) => res.json({
    ok: true, who: req.roWho, readOnly: true,
    endpoints: {
      "GET /data-api/crm/schema": "таблицы и колонки копии amoCRM (crm.db)",
      "GET /data-api/crm/sql?q=SELECT …&limit=5000": "SQL только на чтение по копии amoCRM — предпочтительно, API amo не нагружает",
      "GET /data-api/amo/<путь>?<параметры>": "живой amoCRM: GET /api/v4/<путь> (leads, contacts, events, notes, tasks, users, leads/pipelines, …) через общий лимитер в низкой очереди",
      "GET /data-api/sms/balance | /data-api/sms/status?id=<sms_id> | /data-api/sms/log?limit=500": "SMS.ru",
      "GET /data-api/pbx/calls?from=ГГГГ-ММ-ДД&to=ГГГГ-ММ-ДД": "OnlinePBX: история звонков (сырые записи)",
      "GET /data-api/pbx/trunks": "состояние номеров АТС (журнал проверок раз в 10 минут)",
      "POST /data-api/direct/<сервис>": "Яндекс.Директ API v5: reports — целиком; остальные сервисы — только {\"method\":\"get\"}",
      "GET /data-api/sheets | /data-api/sheets/<имя>/tabs | /data-api/sheets/<имя>/csv?gid=<gid>": "опубликованные Google-таблицы без финансов",
    },
    limitsPerDay: LIMITS
  }));

  // ── копия amoCRM: SQL в отдельном процессе ──
  const runSql = (q, limit) => new Promise((resolve) => {
    execFile(process.execPath, [path.join(__dirname, "tools", "roSql.js")], {
      timeout: 30000, maxBuffer: 64 * 1024 * 1024,
      env: Object.assign({}, process.env, { RO_SQL: q, RO_LIMIT: String(limit) })
    }, (err, stdout, stderr) => {
      if (err && !stdout) return resolve({ ok: false, error: err.killed ? "запрос дольше 30 с — упростите или сузьте период" : String(stderr || err.message).slice(0, 400) });
      try { resolve(JSON.parse(stdout)); } catch (_) { resolve({ ok: false, error: "не разобрал ответ: " + String(stdout).slice(0, 200) }); }
    });
  });
  app.get("/data-api/crm/schema", auth, async (req, res) => {
    if (!quota(req, res, "sql")) return;
    const r = await runSql("__schema__", 0);
    log(req.roWho, "sql", "schema", r.ok ? 200 : 400, 0);
    res.status(r.ok ? 200 : 400).json(r);
  });
  app.get("/data-api/crm/sql", auth, async (req, res) => {
    if (!quota(req, res, "sql")) return;
    const q = String(req.query.q || "").trim();
    const limit = Math.min(Math.max(Number(req.query.limit) || 5000, 1), 50000);
    const t = Date.now();
    const r = await serial(req.roWho + ":sql", () => runSql(q, limit));
    log(req.roWho, "sql", q, r.ok ? 200 : 400, Date.now() - t);
    res.status(r.ok ? 200 : 400).json(r);
  });

  // ── amoCRM живьём, только GET, низкий приоритет ──
  app.get(/^\/data-api\/amo\/(.+)$/, auth, async (req, res) => {
    if (!quota(req, res, "amo")) return;
    const p = String(req.params[0] || "");
    if (!/^[a-z0-9_\/-]+$/i.test(p) || p.indexOf("..") >= 0) return res.status(400).json({ ok: false, error: "Путь вида leads, contacts/123, events, leads/pipelines" });
    const params = Object.assign({}, req.query); delete params.key;
    const t = Date.now();
    try {
      const data = await serial(req.roWho, () => amoBg(() => amoGet(amoBase() + "/api/v4/" + p, params)));
      log(req.roWho, "amo", p + " " + JSON.stringify(params), 200, Date.now() - t);
      res.json(data == null || data === "" ? { _empty: true } : data);
    } catch (e) {
      const st = (e && e.response && e.response.status) || 502;
      log(req.roWho, "amo", p, st, Date.now() - t);
      res.status(st === 204 ? 200 : st).json(st === 204 ? { _empty: true } : { ok: false, error: "amoCRM: " + String((e && e.message) || e).slice(0, 300) });
    }
  });

  // ── SMS.ru ──
  const SMSRU = "https://sms.ru";
  app.get("/data-api/sms/balance", auth, async (req, res) => {
    if (!quota(req, res, "sms")) return;
    try { const r = await axios.get(SMSRU + "/my/balance", { params: { api_id: process.env.SMS_RU_API_ID, json: 1 }, timeout: 15000 }); res.json(r.data); }
    catch (e) { res.status(502).json({ ok: false, error: e.message }); }
    log(req.roWho, "sms", "balance", 200, 0);
  });
  app.get("/data-api/sms/status", auth, async (req, res) => {
    if (!quota(req, res, "sms")) return;
    const id = String(req.query.id || "").replace(/[^0-9a-z,-]/gi, "").slice(0, 2000);
    if (!id) return res.status(400).json({ ok: false, error: "Нужен id (sms_id, можно через запятую)" });
    try { const r = await axios.get(SMSRU + "/sms/status", { params: { api_id: process.env.SMS_RU_API_ID, sms_id: id, json: 1 }, timeout: 15000 }); res.json(r.data); }
    catch (e) { res.status(502).json({ ok: false, error: e.message }); }
    log(req.roWho, "sms", "status " + id, 200, 0);
  });
  app.get("/data-api/sms/log", auth, (req, res) => {
    if (!quota(req, res, "sms")) return;
    const lim = Math.min(Math.max(Number(req.query.limit) || 500, 1), 2000);
    res.json({ ok: true, note: "Наш журнал отправленных SMS (новые сверху). Коды входа в журнал не пишутся.", items: readJson(SMS_LOG, []).slice(0, lim) });
    log(req.roWho, "sms", "log", 200, 0);
  });

  // ── OnlinePBX ──
  app.get("/data-api/pbx/calls", auth, async (req, res) => {
    if (!quota(req, res, "pbx")) return;
    const day = (s) => /^\d{4}-\d\d-\d\d$/.test(String(s || "")) ? s : null;
    const from = day(req.query.from), to = day(req.query.to) || from;
    if (!from) return res.status(400).json({ ok: false, error: "Нужно from=ГГГГ-ММ-ДД (и to=…), время московское" });
    const fromTs = Date.parse(from + "T00:00:00+03:00"), toTs = Date.parse(to + "T23:59:59+03:00");
    if (!(toTs >= fromTs) || toTs - fromTs > 32 * 86400e3) return res.status(400).json({ ok: false, error: "Период не больше 31 дня" });
    const pbx = (readJson(PHONETEST_STORE, {}).config || {}).pbx || {};
    const dom = String(pbx.domain || "").trim();
    if (!dom || !pbx.key) return res.status(503).json({ ok: false, error: "АТС не настроена" });
    const t = Date.now();
    try {
      const form = (o) => new URLSearchParams(o).toString(), FH = { "Content-Type": "application/x-www-form-urlencoded" };
      const a = (await axios.post("https://api.onlinepbx.ru/" + dom + "/auth.json", form({ auth_key: String(pbx.key).trim(), new: "true" }), { headers: FH, timeout: 30000 })).data;
      if (!a || String(a.status) !== "1" || !a.data || !a.data.key_id) throw new Error("АТС не приняла ключ");
      const r = (await axios.post("https://api.onlinepbx.ru/" + dom + "/mongo_history/search.json",
        form({ start_stamp_from: String(Math.floor(fromTs / 1000)), start_stamp_to: String(Math.floor(toTs / 1000)) }),
        { headers: Object.assign({ "x-pbx-authentication": a.data.key_id + ":" + a.data.key }, FH), timeout: 90000 })).data;
      let rows = r && r.data; if (rows && !Array.isArray(rows)) rows = rows.list || rows.rows || rows.items || [];
      log(req.roWho, "pbx", from + "…" + to, 200, Date.now() - t);
      res.json({ ok: true, from, to, count: (rows || []).length, calls: rows || [] });
    } catch (e) { log(req.roWho, "pbx", from + "…" + to, 502, Date.now() - t); res.status(502).json({ ok: false, error: "OnlinePBX: " + e.message }); }
  });
  app.get("/data-api/pbx/trunks", auth, (req, res) => {
    if (!quota(req, res, "pbx")) return;
    const st = readJson(PHONETEST_STORE, {});
    res.json({ ok: true, names: st.trunkNames || {}, log: (st.trunkLog || []).slice(-300) });
    log(req.roWho, "pbx", "trunks", 200, 0);
  });

  // ── Яндекс.Директ: только чтение ──
  app.post(/^\/data-api\/direct\/([a-z]+)$/, auth, require("express").json({ limit: "1mb" }), async (req, res) => {
    if (!quota(req, res, "direct")) return;
    const svc = String(req.params[0]);
    const body = req.body || {};
    if (svc !== "reports" && String(body.method || "") !== "get") return res.status(403).json({ ok: false, error: "Только чтение: reports или method \"get\"" });
    const headers = { Authorization: "Bearer " + (process.env.YANDEX_DIRECT_TOKEN || ""), "Accept-Language": "ru", "Content-Type": "application/json; charset=utf-8" };
    if (process.env.YANDEX_DIRECT_LOGIN) headers["Client-Login"] = process.env.YANDEX_DIRECT_LOGIN;
    for (const h of ["processingmode", "returnmoneyinmicros", "skipreportheader", "skipcolumnheader", "skipreportsummary"]) if (req.headers[h]) headers[h] = req.headers[h];
    const t = Date.now();
    try {
      const r = await axios.post("https://api.direct.yandex.com/json/v5/" + svc, body, { headers, timeout: 120000, validateStatus: () => true, responseType: "text", transformResponse: [(d) => d] });
      for (const h of ["retryin", "units", "requestid"]) if (r.headers[h]) res.set(h, r.headers[h]);
      log(req.roWho, "direct", svc + " " + (body.method || (body.params && body.params.ReportType) || ""), r.status, Date.now() - t);
      res.status(r.status).type(r.headers["content-type"] || "text/plain").send(r.data);
    } catch (e) { res.status(502).json({ ok: false, error: "Директ: " + e.message }); }
  });

  // ── Google-таблицы без финансов ──
  app.get("/data-api/sheets", auth, (req, res) => res.json({ ok: true, sheets: Object.keys(SHEETS).map((k) => ({ name: k, title: SHEETS[k].title, url: SHEETS[k].base + "html" })) }));
  app.get(/^\/data-api\/sheets\/([a-z]+)\/(tabs|csv)$/, auth, async (req, res) => {
    if (!quota(req, res, "sheets")) return;
    const sh = SHEETS[req.params[0]];
    if (!sh) return res.status(404).json({ ok: false, error: "Нет такой таблицы" });
    try {
      if (req.params[1] === "tabs") {
        const html = String((await axios.get(sh.base + "html", { timeout: 30000, responseType: "text", transformResponse: [(d) => d] })).data);
        const tabs = []; const re = /items\.push\(\{name: "([^"]+)", pageUrl: "[^"]*[?&]gid=(\d+)/g; let m;
        while ((m = re.exec(html))) tabs.push({ name: m[1].trim(), gid: m[2] });
        return res.json({ ok: true, tabs });
      }
      const gid = String(req.query.gid || "").replace(/\D/g, "");
      const r = await axios.get(sh.base + "?" + (gid ? "gid=" + gid + "&single=true&" : "") + "output=csv", { timeout: 45000, responseType: "text", transformResponse: [(d) => d] });
      res.type("text/csv; charset=utf-8").send(r.data);
    } catch (e) { res.status(502).json({ ok: false, error: "Google: " + e.message }); }
    log(req.roWho, "sheets", req.params[0] + " " + req.params[1], 200, 0);
  });

  console.log("DATA RO: /data-api для своих Claude — ключей " + Object.keys(keys()).length);
}

module.exports = { mount };
