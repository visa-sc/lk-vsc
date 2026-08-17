// ── /fin: личные финансы Андрея (17.08.2026) ───────────────────────────────────
// Супер-простой учёт расходов с телефона → автоматическая запись в
// «Личные финансы.numbers» (iCloud, мак Андрея). Отдельный модуль, монтируется
// из server.js; клиентский ЛК, amoCRM и остальные разделы НЕ затрагивает.
//
// Схема: айфон → /fin (PWA, вход по коду FIN_CODE) → записи в .fin/store.json →
// агент на маке (tools/fin-numbers-sync.js, LaunchAgent, раз в 2 мин) забирает
// несинкнутые записи по /fin/api/pull и дописывает их в Numbers через
// AppleScript, затем подтверждает /fin/api/mark-synced.
//
// Корзины — как столбцы таблицы Андрея:
//   pos   = Позитивные расходы        ok    = Допустимые расходы
//   nope  = Можно было не тратить     trash = Выброшенные на ветер деньги
//
// env: FIN_CODE (код входа с телефона, дефолт 280992 — общий админ-код),
//      FIN_AGENT_KEY (ключ агента синка; ОБЯЗАТЕЛЕН на проде, без него pull закрыт).
// Хранилище: .fin/store.json (gitignore — личные данные).

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const DIR = path.join(__dirname, ".fin");
const STORE_FILE = path.join(DIR, "store.json");
const SEED_FILE = path.join(__dirname, "fin.seed.json");
const TOKEN_TTL = 180 * 24 * 3600 * 1000; // полгода — личный телефон, перелогин не нужен
const MAX_ENTRIES = 20000;

const BUCKETS = ["pos", "ok", "nope", "trash"];

let _store = null;
function store() {
  if (_store) return _store;
  try { _store = JSON.parse(fs.readFileSync(STORE_FILE, "utf8")); } catch (_) { _store = null; }
  if (!_store || !Array.isArray(_store.entries)) _store = { entries: [], auth: {}, custom: {} };
  if (!_store.auth) _store.auth = {};
  if (!_store.custom) _store.custom = {}; // выученные названия: name → {bucket, category, amount, uses}
  return _store;
}
function save() {
  try { fs.mkdirSync(DIR, { recursive: true }); } catch (_) {}
  try { fs.writeFileSync(STORE_FILE, JSON.stringify(store(), null, 2), "utf8"); } catch (e) { console.error("fin save:", e.message); }
}

let _seed = null;
function seed() {
  if (_seed) return _seed;
  try { _seed = JSON.parse(fs.readFileSync(SEED_FILE, "utf8")); } catch (_) { _seed = { frequent: [], categories: ["Прочее"], categoryRules: [] }; }
  return _seed;
}

function categorize(name) {
  const n = String(name || "").toLowerCase();
  for (const r of seed().categoryRules || []) for (const m of r.m) if (n.includes(m)) return r.c;
  return "Прочее";
}

// Дата «финансового дня» в МСК: до 04:00 утра расход относится к вчера
// (поздний ужин, вбитый в час ночи, должен попасть в прошедший день).
function todayMsk() {
  const d = new Date(Date.now() + 3 * 3600 * 1000 - 4 * 3600 * 1000);
  return d.toISOString().slice(0, 10);
}

function mount(app, deps) {
  const requireAdmin = deps.requireAdmin;
  const FIN_CODE = process.env.FIN_CODE || "280992";
  const FIN_AGENT_KEY = process.env.FIN_AGENT_KEY || "";

  function tokenFromReq(req) {
    const h = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
    return h || String(req.query.token || "").trim();
  }
  const loginFails = new Map(); // ip -> [ts]
  app.post("/fin/api/login", (req, res) => {
    const ip = String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();
    const hist = (loginFails.get(ip) || []).filter((t) => Date.now() - t < 24 * 3600 * 1000);
    if (hist.length >= 15) return res.status(429).json({ success: false, message: "Слишком много попыток, попробуйте завтра" });
    const code = String((req.body && req.body.code) || "").trim();
    if (code !== FIN_CODE) {
      hist.push(Date.now()); loginFails.set(ip, hist);
      return res.status(401).json({ success: false, message: "Неверный код" });
    }
    const st = store();
    const tok = crypto.randomBytes(24).toString("hex");
    st.auth[tok] = { at: Date.now() };
    for (const k of Object.keys(st.auth)) if (Date.now() - (st.auth[k].at || 0) > TOKEN_TTL) delete st.auth[k];
    save();
    res.json({ success: true, token: tok });
  });

  function requireFin(req, res, next) {
    const tok = tokenFromReq(req);
    const rec = tok && store().auth[tok];
    if (rec && Date.now() - (rec.at || 0) <= TOKEN_TTL) return next();
    return res.status(401).json({ success: false, message: "Нет доступа" });
  }
  // Агент синка: отдельный ключ, чтобы не хранить пользовательский токен на маке.
  function requireAgent(req, res, next) {
    if (!FIN_AGENT_KEY) return res.status(503).json({ success: false, message: "FIN_AGENT_KEY не задан на сервере" });
    if (String(req.headers["x-fin-agent"] || "") === FIN_AGENT_KEY) return next();
    return res.status(401).json({ success: false, message: "Нет доступа" });
  }

  app.get("/fin", (req, res) => {
    res.set("Cache-Control", "no-store, no-cache, must-revalidate");
    res.sendFile(path.join(__dirname, "public", "fin.html"));
  });

  // Стартовые данные для страницы: частые покупки (сид + выученные), категории.
  app.get("/fin/api/state", requireFin, (req, res) => {
    const st = store();
    const sd = seed();
    // выученное поверх сида: то, что Андрей реально вбивает, поднимаем наверх
    const custom = Object.entries(st.custom)
      .map(([name, v]) => ({ name, bucket: v.bucket, amount: v.amount, category: v.category, uses: v.uses }))
      .sort((a, b) => b.uses - a.uses);
    const seen = new Set(custom.map((c) => c.name.toLowerCase()));
    const frequent = custom.concat((sd.frequent || []).filter((f) => !seen.has(f.name.toLowerCase()))).slice(0, 60);
    const today = todayMsk();
    const entries = st.entries.filter((e) => e.date === today && !e.deleted);
    const pendingSync = st.entries.filter((e) => !e.synced && !e.deleted).length;
    res.json({ success: true, frequent, categories: sd.categories || [], today, entries, pendingSync, lastSyncAt: st.lastSyncAt || null });
  });

  // Добавить расход. body: {name, amount, bucket, category?, date?}
  app.post("/fin/api/add", requireFin, (req, res) => {
    const b = req.body || {};
    const name = String(b.name || "").trim().slice(0, 200);
    const amount = Math.round(Number(b.amount) * 100) / 100;
    const bucket = BUCKETS.includes(b.bucket) ? b.bucket : "ok";
    if (!name) return res.status(400).json({ success: false, message: "Нет названия" });
    if (!(amount > 0)) return res.status(400).json({ success: false, message: "Сумма должна быть больше нуля" });
    let date = String(b.date || "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) date = todayMsk();
    const category = String(b.category || "").trim() || categorize(name);
    const st = store();
    const e = {
      id: crypto.randomBytes(8).toString("hex"),
      at: Date.now(),
      date, name, amount, bucket, category,
      synced: false,
    };
    st.entries.push(e);
    if (st.entries.length > MAX_ENTRIES) st.entries.splice(0, st.entries.length - MAX_ENTRIES);
    // самообучение частых покупок
    const key = name.toLowerCase().replace(/\s+/g, " ");
    const known = Object.keys(st.custom).find((k) => k.toLowerCase() === key);
    const rec = known ? st.custom[known] : { uses: 0 };
    rec.uses++; rec.bucket = bucket; rec.category = category; rec.amount = amount;
    st.custom[known || name] = rec;
    save();
    res.json({ success: true, entry: e });
  });

  // Редактирование/удаление — только пока запись не синкнута в Numbers
  // (после — правьте в Numbers, там источник истины).
  app.post("/fin/api/edit/:id", requireFin, (req, res) => {
    const st = store();
    const e = st.entries.find((x) => x.id === req.params.id);
    if (!e) return res.status(404).json({ success: false, message: "Не найдено" });
    if (e.synced) return res.status(409).json({ success: false, message: "Уже в Numbers — правьте там" });
    const b = req.body || {};
    if (b.name != null) { const n = String(b.name).trim().slice(0, 200); if (n) e.name = n; }
    if (b.amount != null) { const a = Math.round(Number(b.amount) * 100) / 100; if (a > 0) e.amount = a; }
    if (b.bucket != null && BUCKETS.includes(b.bucket)) e.bucket = b.bucket;
    if (b.category != null) e.category = String(b.category).trim() || e.category;
    if (b.date != null && /^\d{4}-\d{2}-\d{2}$/.test(String(b.date))) e.date = String(b.date);
    save();
    res.json({ success: true, entry: e });
  });
  app.post("/fin/api/delete/:id", requireFin, (req, res) => {
    const st = store();
    const e = st.entries.find((x) => x.id === req.params.id);
    if (!e) return res.status(404).json({ success: false, message: "Не найдено" });
    if (e.synced) return res.status(409).json({ success: false, message: "Уже в Numbers — удаляйте там" });
    e.deleted = true;
    save();
    res.json({ success: true });
  });

  // История по дням (для просмотра с телефона)
  app.get("/fin/api/days", requireFin, (req, res) => {
    const st = store();
    const byDay = {};
    for (const e of st.entries) {
      if (e.deleted) continue;
      (byDay[e.date] = byDay[e.date] || []).push(e);
    }
    const days = Object.keys(byDay).sort().reverse().slice(0, 45)
      .map((d) => ({ date: d, entries: byDay[d], total: byDay[d].reduce((s, e) => s + e.amount, 0) }));
    res.json({ success: true, days });
  });

  // ── API агента синка (мак Андрея) ──
  app.get("/fin/api/pull", requireAgent, (req, res) => {
    const st = store();
    res.json({ success: true, entries: st.entries.filter((e) => !e.synced && !e.deleted) });
  });
  app.post("/fin/api/mark-synced", requireAgent, (req, res) => {
    const ids = Array.isArray(req.body && req.body.ids) ? req.body.ids : [];
    const st = store();
    let n = 0;
    for (const e of st.entries) if (ids.includes(e.id) && !e.synced) { e.synced = true; e.syncedAt = Date.now(); n++; }
    st.lastSyncAt = Date.now();
    save();
    res.json({ success: true, marked: n });
  });

  // Диагностика для админки (не публично)
  app.get("/fin/api/status", requireAdmin, (req, res) => {
    const st = store();
    res.json({
      success: true,
      entries: st.entries.filter((e) => !e.deleted).length,
      pendingSync: st.entries.filter((e) => !e.synced && !e.deleted).length,
      lastSyncAt: st.lastSyncAt || null,
      customLearned: Object.keys(st.custom).length,
    });
  });

  console.log("FIN: /fin смонтирован (личные финансы)");
}

module.exports = { mount };
