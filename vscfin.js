"use strict";
// ── /akfin: рабочие расходы и приходы VSC (08.09.2026) ────────────────────────
// Быстрый ввод рабочих трат и поступлений с телефона → перенос в «vsc таблица»
// (Numbers) кнопкой «Скопировать» (буфер, точные цвета и шрифт листа, Cmd+V).
// Сделано по образцу личных финансов /fin (ak-co.ru), но модель данных СВОЯ —
// колонки листа Андрея, без корзин «позитивные/допустимые/выброшенные».
//
// Раскладка листа (11 колонок, расходы слева, приходы справа):
//   1 день · 2 Категория · 3 Безнал/нал · 4 Наименование · 5 Контрагент
//   6 Стоимость · 7 Юр. лицо · 8 разделитель · 9 Наименование · 10 Контрагент · 11 Стоимость
// Поэтому «Скопировать» на вкладке Расходы даёт 7 колонок (вставлять в A),
// на вкладке Приходы — 3 колонки (вставлять в I). Заливки и шрифт — канон
// из собственного экспорта Numbers (см. блок палитры ниже).
//
// Курсы ЦБ (EUR/USD) переиспользуют fetchCbrRates основного сервера (кэш 1 ч,
// прогрев раз в час) — сумму можно вводить в валюте, в таблицу уходят рубли.
//
// env: VSCFIN_CODE (код входа, дефолт 280992 — общий админ-код).
// Хранилище: .vscFin.json (gitignore — рабочие финансовые данные).

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const webauthn = require("@simplewebauthn/server"); // Face ID: та же библиотека, ключи СВОИ (не .passkeys.json ЛК и не /fin)

const STORE_FILE = path.join(__dirname, ".vscFin.json");
const TOKEN_TTL = 180 * 24 * 3600 * 1000; // полгода — личный телефон
const MAX_ENTRIES = 50000;

// ── Справочники: сняты с «vsc таблица» (август 2026) ──────────────────────────
const SEED = {
  categories: ["Сбор", "ФОТ", "Финансы"],
  cash: ["Безнал", "Нал"],
  legals: ["ООО Эй Кей", "ООО Альта", "ИП Комисаренко", "ИП Панфилова"],
  expense: [
    { name: "ВНЖ USDT", category: "Сбор" },
    { name: "Обслуживание ВТБ Комисаренко", category: "Финансы" },
    { name: "Обслуживание ВТБ Панфилова", category: "Финансы" },
    { name: "Обслуживание ВТБ Альта Профит", category: "Финансы" },
    { name: "Обслуживание Т", category: "Финансы" },
    { name: "Обслуживание Альфа", category: "Финансы" },
    { name: "Точка Альта", category: "Финансы" },
    { name: "Комиссии интернет-эквайринг ООО Эй Кей", category: "Финансы" },
    { name: "Комиссии СБП ООО Эй Кей", category: "Финансы" },
    { name: "Комиссии торговый эквайринг ООО Эй Кей", category: "Финансы" },
    { name: "Комиссии интернет-эквайринг ИП П", category: "Финансы" },
    { name: "Комиссии СБП ИП П", category: "Финансы" },
    { name: "Комиссии торговый эквайринг ИП П", category: "Финансы" },
    { name: "Комиссии интернет-эквайринг ИП К", category: "Финансы" },
    { name: "Комиссии СБП ИП К", category: "Финансы" },
    { name: "Комиссии торговый эквайринг ИП К", category: "Финансы" },
    { name: "Комиссии интернет-эквайринг ООО Альта", category: "Финансы" },
    { name: "Комиссии СБП ООО Альта", category: "Финансы" },
    { name: "Комиссии торговый эквайринг ООО Альта", category: "Финансы" },
    { name: "ФОТ - Зайцева", category: "ФОТ" },
    { name: "ФОТ - НДФЛ - сверить", category: "ФОТ" },
    { name: "ФОТ - Сбер - сверить", category: "ФОТ", cash: "Нал" },
    { name: "ФОТ - Нал - сверить", category: "ФОТ", cash: "Нал" },
    { name: "ФОТ - безнал - сверить Эй Кей", category: "ФОТ" },
    { name: "ФОТ - безнал - сверить Альта", category: "ФОТ" },
    { name: "ФОТ - безнал - сверить ИП П", category: "ФОТ" },
    { name: "ФОТ - безнал - сверить ИП К", category: "ФОТ" },
    { name: "Единый налоговый платеж (Взносы)", category: "ФОТ", legal: "ИП Комисаренко" },
  ],
  income: [
    "Комиссия ВНЖ (USDT)",
    "USD ВНЖ",
    "Нал МСК",
    "Нал СПБ",
    "Нал ЕКБ",
    "Торговый эквайринг ООО Эй Кей",
    "Интернет-эквайринг ООО Эй Кей",
    "СБП ООО Эй Кей",
    "Торговый эквайринг ИП П",
    "Интернет-эквайринг ИП П",
    "СБП ИП П",
    "Торговый эквайринг ИП К",
    "Интернет-эквайринг ИП К",
    "СБП ИП К",
    "Торговый эквайринг ООО Альта",
    "Интернет-эквайринг ООО Альта",
    "СБП ООО Альта",
    "Возвраты интернет-эквайринг",
  ],
};

let _store = null;
function store() {
  if (_store) return _store;
  try { _store = JSON.parse(fs.readFileSync(STORE_FILE, "utf8")); } catch (_) { _store = null; }
  if (!_store || !Array.isArray(_store.entries)) _store = { entries: [] };
  if (!_store.auth) _store.auth = {};
  if (!Array.isArray(_store.passkeys)) _store.passkeys = [];
  if (!_store.custom) _store.custom = {}; // выученные названия: name → {type, category, cash, legal, party, uses}
  return _store;
}
function save() {
  try {
    fs.writeFileSync(STORE_FILE, JSON.stringify(store(), null, 1), { encoding: "utf8", mode: 0o600 });
    fs.chmodSync(STORE_FILE, 0o600);
  } catch (e) { console.error("vscfin save:", e.message); }
}

// Финансовый день в МСК: до 04:00 запись относится к вчера (поздний вечер).
function todayMsk() {
  const d = new Date(Date.now() + 3 * 3600 * 1000 - 4 * 3600 * 1000);
  return d.toISOString().slice(0, 10);
}
function xmlEsc(s) {
  return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
// Сумма для Numbers: русский разделитель дробной части, без разрядных пробелов.
function numForNumbers(v) {
  if (v == null || !isFinite(v)) return "";
  const r = Math.round(Number(v) * 100) / 100;
  return String(r).replace(".", ",");
}

// ── Заливки и шрифт — КАНОН из собственного экспорта Numbers ──────────────────
// Спрашиваем сам Numbers (export as Microsoft Excel → styles.xml/indexedColors),
// а НЕ пипетку и не AppleScript: background color через AppleScript отдаёт цвет
// в другом пространстве (#6DFFF2 вместо #7AFCF4) — вставка была бы мимо стиля.
// Карта колонок листа «vsc таблица» (08.09.2026):
//   A день  #FEFEFE (первая строка дня) / #7AFCF4 (продолжение)
//   B Категория #7AFCF4 · C Безнал/нал #7AFCF4 · D Наименование #FEFEFE
//   E Контрагент #FEFEFE · F Стоимость #FEFEFE · G Юр. лицо #7AFCF4, кегль 8
//   I/J/K приходы — все #FEFEFE
const C = { cyan: "#7AFCF4", white: "#FEFEFE" };
const BORD = "border:1px solid #D9D9D9;";
function font(pt) { return "font-family:Helvetica;font-size:" + (pt || 10) + "pt;"; }
function td(bg, text, align, pt) {
  return `<td style="${font(pt)}${BORD}background-color:${bg};${align ? "text-align:" + align + ";" : ""}">${xmlEsc(text)}</td>`;
}

// Расходы — 7 колонок листа (вставлять в колонку «день»):
// день | Категория | Безнал/нал | Наименование | Контрагент | Стоимость | Юр. лицо
// День проставляется только в ПЕРВОЙ строке дня, дальше — пустая бирюзовая ячейка
// (как в таблице Андрея: белая ячейка с номером, ниже полоса дня).
function buildExpenseRows(list) {
  const sorted = list.slice().sort((a, b) => (a.date === b.date ? a.at - b.at : (a.date < b.date ? -1 : 1)));
  let prevDay = null;
  const rows = sorted.map((e) => {
    const day = +String(e.date).slice(8, 10);
    const first = day !== prevDay;
    prevDay = day;
    const cells = [
      first ? td(C.white, day, "center") : td(C.cyan, "", "center"),
      td(C.cyan, e.category || ""),
      td(C.cyan, e.cash || ""),
      td(C.white, e.comment ? e.name + " - " + e.comment : e.name),
      td(C.white, e.party || ""),
      td(C.white, numForNumbers(e.rub), "right"),
      td(C.cyan, e.legal || "", null, 8), // «Юр. лицо» в таблице набрано 8-м кеглем
    ];
    return "<tr>" + cells.join("") + "</tr>";
  });
  return '<meta charset="utf-8"><table border="0" cellspacing="0" cellpadding="2">' + rows.join("") + "</table>";
}

// Приходы — 3 колонки листа: Наименование | Контрагент | Стоимость
function buildIncomeRows(list) {
  const sorted = list.slice().sort((a, b) => (a.date === b.date ? a.at - b.at : (a.date < b.date ? -1 : 1)));
  const rows = sorted.map((e) => "<tr>" + [
    td(C.white, e.comment ? e.name + " - " + e.comment : e.name),
    td(C.white, e.party || ""),
    td(C.white, numForNumbers(e.rub), "right"),
  ].join("") + "</tr>");
  return '<meta charset="utf-8"><table border="0" cellspacing="0" cellpadding="2">' + rows.join("") + "</table>";
}

function mount(app, deps) {
  deps = deps || {};
  const CODE = process.env.VSCFIN_CODE || "280992";
  // Курсы ЦБ берём у основного сервера (там кэш 1 ч и почасовой прогрев).
  const fetchCbrRates = deps.fetchCbrRates || (async () => ({ rates: {}, date: null }));

  function tokenFromReq(req) {
    const h = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
    return h || String(req.query.token || "").trim();
  }
  function issueToken(via) {
    const st = store();
    const tok = crypto.randomBytes(24).toString("hex");
    st.auth[tok] = { at: Date.now(), via: via || "code" };
    for (const k of Object.keys(st.auth)) if (Date.now() - (st.auth[k].at || 0) > TOKEN_TTL) delete st.auth[k];
    save();
    return tok;
  }
  function requireFin(req, res, next) {
    const tok = tokenFromReq(req);
    const rec = tok && store().auth[tok];
    if (rec && Date.now() - (rec.at || 0) <= TOKEN_TTL) return next();
    return res.status(401).json({ success: false, message: "Нет доступа" });
  }

  // ── Вход по коду ──
  const loginFails = new Map();
  app.post("/akfin/api/login", (req, res) => {
    const ip = String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();
    const hist = (loginFails.get(ip) || []).filter((t) => Date.now() - t < 24 * 3600 * 1000);
    if (hist.length >= 15) return res.status(429).json({ success: false, message: "Слишком много попыток, попробуйте завтра" });
    const code = String((req.body && req.body.code) || "").trim();
    if (code !== CODE) {
      hist.push(Date.now()); loginFails.set(ip, hist);
      return res.status(401).json({ success: false, message: "Неверный код" });
    }
    res.json({ success: true, token: issueToken("code") });
  });

  // ── Face ID (WebAuthn) — свои ключи, изолированы от ЛК и от /fin ──
  const BIO_HOSTS = { "voyotravel.ru": true, "voyovoyo.ru": true, "ak-co.ru": true };
  function bioHost(req) {
    const h = String((req.headers && req.headers.host) || "").toLowerCase().split(":")[0].replace(/^www\./, "");
    return BIO_HOSTS[h] ? h : "voyotravel.ru";
  }
  const bioChallenges = new Map();
  function setBioChallenge(key, challenge) {
    bioChallenges.set(key, { challenge, expiresAt: Date.now() + 5 * 60 * 1000 });
    for (const [k, v] of bioChallenges) if (Date.now() > v.expiresAt) bioChallenges.delete(k);
  }
  function takeBioChallenge(key) {
    const c = bioChallenges.get(key);
    bioChallenges.delete(key);
    return c && Date.now() <= c.expiresAt ? c.challenge : null;
  }
  const b64u = (buf) => Buffer.from(buf).toString("base64url");
  const fromB64u = (s) => Buffer.from(String(s || ""), "base64url");

  app.post("/akfin/api/bio/register-options", requireFin, async (req, res) => {
    try {
      const st = store();
      const options = await webauthn.generateRegistrationOptions({
        rpName: "VSC fin",
        rpID: bioHost(req),
        userID: "vscfin-owner",
        userName: "vscfin",
        userDisplayName: "Рабочие финансы",
        attestationType: "none",
        excludeCredentials: st.passkeys.map((c) => ({ id: fromB64u(c.credentialID), type: "public-key" })),
        authenticatorSelection: { residentKey: "preferred", userVerification: "preferred" },
      });
      setBioChallenge("reg", options.challenge);
      res.json(options);
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
  });
  app.post("/akfin/api/bio/register-verify", requireFin, async (req, res) => {
    try {
      const expectedChallenge = takeBioChallenge("reg");
      if (!expectedChallenge) return res.status(400).json({ success: false, message: "Регистрация просрочена" });
      const verification = await webauthn.verifyRegistrationResponse({
        response: req.body && req.body.attestationResponse,
        expectedChallenge,
        expectedOrigin: "https://" + bioHost(req),
        expectedRPID: bioHost(req),
        requireUserVerification: false,
      });
      if (!verification.verified || !verification.registrationInfo) return res.status(400).json({ success: false, message: "Проверка не прошла" });
      const info = verification.registrationInfo;
      store().passkeys.push({ credentialID: b64u(info.credentialID), publicKey: b64u(info.credentialPublicKey), counter: info.counter || 0, host: bioHost(req), createdAt: Date.now() });
      save();
      res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
  });
  app.post("/akfin/api/bio/has", (req, res) => {
    res.json({ success: true, has: store().passkeys.some((c) => c.host === bioHost(req)) });
  });
  app.post("/akfin/api/bio/auth-options", async (req, res) => {
    try {
      const arr = store().passkeys.filter((c) => c.host === bioHost(req));
      if (!arr.length) return res.status(404).json({ success: false, message: "Face ID не настроен" });
      const options = await webauthn.generateAuthenticationOptions({
        rpID: bioHost(req),
        allowCredentials: arr.map((c) => ({ id: fromB64u(c.credentialID), type: "public-key" })),
        userVerification: "preferred",
      });
      setBioChallenge("auth", options.challenge);
      res.json(options);
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
  });
  app.post("/akfin/api/bio/auth-verify", async (req, res) => {
    try {
      const assertionResponse = req.body && req.body.assertionResponse;
      const expectedChallenge = takeBioChallenge("auth");
      if (!assertionResponse || !expectedChallenge) return res.status(400).json({ success: false, message: "Сессия просрочена" });
      const cred = store().passkeys.find((c) => c.credentialID === assertionResponse.id);
      if (!cred) return res.status(404).json({ success: false, message: "Ключ не найден" });
      const verification = await webauthn.verifyAuthenticationResponse({
        response: assertionResponse,
        expectedChallenge,
        expectedOrigin: "https://" + bioHost(req),
        expectedRPID: bioHost(req),
        authenticator: { credentialID: fromB64u(cred.credentialID), credentialPublicKey: fromB64u(cred.publicKey), counter: cred.counter || 0 },
        requireUserVerification: false,
      });
      if (!verification.verified) return res.status(400).json({ success: false, message: "Подпись не прошла" });
      cred.counter = verification.authenticationInfo.newCounter;
      save();
      res.json({ success: true, token: issueToken("bio") });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
  });

  // ── Страница ──
  app.get("/akfin", (req, res) => {
    res.set("Cache-Control", "no-store, no-cache, must-revalidate");
    res.sendFile(path.join(__dirname, "public", "akfin.html"));
  });

  // ── Курсы ЦБ ──
  async function ratesPayload(force) {
    try {
      const c = await fetchCbrRates(force);
      return { eur: c.rates.EUR || null, usd: c.rates.USD || null, date: c.date || null };
    } catch (e) { return { eur: null, usd: null, date: null, error: e && e.message }; }
  }
  app.get("/akfin/api/rates", requireFin, async (req, res) => {
    res.json({ success: true, rates: await ratesPayload(req.query && req.query.fresh === "1") });
  });

  // ── Стартовые данные: справочники + курсы + последние записи ──
  app.get("/akfin/api/state", requireFin, async (req, res) => {
    const st = store();
    // подсказки: сид + выученные, по частоте использования
    const learned = Object.entries(st.custom).map(([name, v]) => ({ name, ...v }));
    const expLearned = learned.filter((x) => x.type === "exp").sort((a, b) => (b.uses || 0) - (a.uses || 0));
    const incLearned = learned.filter((x) => x.type === "inc").sort((a, b) => (b.uses || 0) - (a.uses || 0));
    const seenE = new Set(); const expense = [];
    for (const x of [...expLearned, ...SEED.expense]) if (!seenE.has(x.name)) { seenE.add(x.name); expense.push({ name: x.name, category: x.category || "", cash: x.cash || "", legal: x.legal || "", party: x.party || "" }); }
    const seenI = new Set(); const income = [];
    for (const x of [...incLearned, ...SEED.income.map((n) => ({ name: n }))]) if (!seenI.has(x.name)) { seenI.add(x.name); income.push({ name: x.name, party: x.party || "" }); }
    const cats = [...new Set([...SEED.categories, ...learned.map((x) => x.category).filter(Boolean)])];
    const legals = [...new Set([...SEED.legals, ...learned.map((x) => x.legal).filter(Boolean)])];
    res.json({
      success: true,
      today: todayMsk(),
      rates: await ratesPayload(false),
      ref: { categories: cats, cash: SEED.cash, legals, expense, income },
      pending: { exp: st.entries.filter((e) => !e.deleted && !e.copiedAt && e.type === "exp").length,
                 inc: st.entries.filter((e) => !e.deleted && !e.copiedAt && e.type === "inc").length },
    });
  });

  // ── Добавление записи ──
  app.post("/akfin/api/add", requireFin, (req, res) => {
    const b = req.body || {};
    const type = b.type === "inc" ? "inc" : "exp";
    const name = String(b.name || "").trim().slice(0, 400);
    if (!name) return res.status(400).json({ success: false, message: "Нужно наименование" });
    const rub = Number(b.rub);
    if (!isFinite(rub) || rub < 0) return res.status(400).json({ success: false, message: "Нужна сумма" });
    const date = /^\d{4}-\d{2}-\d{2}$/.test(String(b.date || "")) ? String(b.date) : todayMsk();
    const st = store();
    if (st.entries.length >= MAX_ENTRIES) return res.status(400).json({ success: false, message: "Хранилище переполнено" });
    // дедуп офлайн-очереди по cid (как в /fin): повтор того же клиентского id не плодит записи
    const cid = String(b.cid || "").slice(0, 64);
    if (cid) { const dup = st.entries.find((e) => e.cid === cid); if (dup) return res.json({ success: true, entry: dup, dup: true }); }
    const e = {
      id: crypto.randomBytes(8).toString("hex"),
      cid: cid || undefined,
      at: Date.now(),
      date, type, name,
      comment: String(b.comment || "").trim().slice(0, 300) || undefined,
      party: String(b.party || "").trim().slice(0, 200) || undefined,
      rub: Math.round(rub * 100) / 100,
      cur: ["USD", "EUR"].includes(b.cur) ? b.cur : undefined,
      curAmount: isFinite(Number(b.curAmount)) && Number(b.curAmount) > 0 ? Number(b.curAmount) : undefined,
      rate: isFinite(Number(b.rate)) && Number(b.rate) > 0 ? Number(b.rate) : undefined,
    };
    if (type === "exp") {
      e.category = String(b.category || "").trim().slice(0, 100) || undefined;
      e.cash = SEED.cash.includes(b.cash) ? b.cash : undefined;
      e.legal = String(b.legal || "").trim().slice(0, 120) || undefined;
    }
    st.entries.push(e);
    // запоминаем название вместе с его реквизитами — в следующий раз подставится
    const c = st.custom[name] || { type, uses: 0 };
    c.type = type; c.uses = (c.uses || 0) + 1;
    if (e.category) c.category = e.category;
    if (e.cash) c.cash = e.cash;
    if (e.legal) c.legal = e.legal;
    if (e.party) c.party = e.party;
    st.custom[name] = c;
    save();
    res.json({ success: true, entry: e });
  });

  app.post("/akfin/api/edit/:id", requireFin, (req, res) => {
    const st = store();
    const e = st.entries.find((x) => x.id === req.params.id && !x.deleted);
    if (!e) return res.status(404).json({ success: false, message: "Запись не найдена" });
    const b = req.body || {};
    if (b.name != null) e.name = String(b.name).trim().slice(0, 400) || e.name;
    if (b.rub != null && isFinite(Number(b.rub))) e.rub = Math.round(Number(b.rub) * 100) / 100;
    if (b.date != null && /^\d{4}-\d{2}-\d{2}$/.test(String(b.date))) e.date = String(b.date);
    if (b.comment != null) e.comment = String(b.comment).trim().slice(0, 300) || undefined;
    if (b.party != null) e.party = String(b.party).trim().slice(0, 200) || undefined;
    if (e.type === "exp") {
      if (b.category != null) e.category = String(b.category).trim().slice(0, 100) || undefined;
      if (b.cash != null) e.cash = SEED.cash.includes(b.cash) ? b.cash : undefined;
      if (b.legal != null) e.legal = String(b.legal).trim().slice(0, 120) || undefined;
    }
    if (b.cur != null) { e.cur = ["USD", "EUR"].includes(b.cur) ? b.cur : undefined; }
    if (b.curAmount != null) e.curAmount = Number(b.curAmount) > 0 ? Number(b.curAmount) : undefined;
    if (b.rate != null) e.rate = Number(b.rate) > 0 ? Number(b.rate) : undefined;
    save();
    res.json({ success: true, entry: e });
  });

  app.post("/akfin/api/delete/:id", requireFin, (req, res) => {
    const st = store();
    const e = st.entries.find((x) => x.id === req.params.id);
    if (!e) return res.status(404).json({ success: false, message: "Запись не найдена" });
    e.deleted = true;
    save();
    res.json({ success: true });
  });

  // ── Список записей по дням (для экрана «Записи») ──
  app.get("/akfin/api/days", requireFin, (req, res) => {
    const type = req.query && req.query.type === "inc" ? "inc" : "exp";
    const byDay = {};
    for (const e of store().entries) {
      if (e.deleted || e.type !== type) continue;
      (byDay[e.date] = byDay[e.date] || []).push(e);
    }
    const days = Object.keys(byDay).sort().reverse().slice(0, 60)
      .map((d) => ({ date: d, entries: byDay[d].sort((a, b) => a.at - b.at), total: byDay[d].reduce((s, e) => s + (e.rub || 0), 0) }));
    res.json({ success: true, days });
  });

  // ── Строки для буфера обмена (главный путь переноса в Numbers) ──
  // scope=new — только не скопированные, и только за САМЫЙ РАННИЙ месяц:
  // вставка всегда идёт в один лист месяца, как в /fin.
  app.get("/akfin/api/rows.html", requireFin, (req, res) => {
    const type = req.query && req.query.type === "inc" ? "inc" : "exp";
    const mon = String((req.query && req.query.month) || "").trim();
    const scope = String((req.query && req.query.scope) || "new").trim();
    let list = store().entries.filter((e) => !e.deleted && e.type === type);
    if (/^\d{4}-\d{2}$/.test(mon)) list = list.filter((e) => String(e.date).slice(0, 7) === mon);
    else if (scope === "new") {
      const fresh = list.filter((e) => !e.copiedAt);
      const months = [...new Set(fresh.map((e) => String(e.date).slice(0, 7)))].sort();
      list = months.length ? fresh.filter((e) => String(e.date).slice(0, 7) === months[0]) : [];
      res.set("X-Fin-Month", months[0] || "");
      res.set("X-Fin-More", String(Math.max(0, months.length - 1)));
    }
    res.set("X-Fin-Ids", list.map((e) => e.id).join(","));
    res.set("Access-Control-Expose-Headers", "X-Fin-Ids, X-Fin-Month, X-Fin-More");
    res.set("Content-Type", "text/html; charset=utf-8");
    res.set("Cache-Control", "no-store");
    res.send(type === "inc" ? buildIncomeRows(list) : buildExpenseRows(list));
  });

  app.post("/akfin/api/mark-copied", requireFin, (req, res) => {
    const ids = String((req.body && req.body.ids) || "").split(",").filter(Boolean);
    const st = store();
    let n = 0;
    for (const e of st.entries) if (ids.includes(e.id) && !e.copiedAt) { e.copiedAt = Date.now(); n++; }
    if (n) save();
    res.json({ success: true, marked: n });
  });

  console.log("VSCFIN: /akfin смонтирован (рабочие расходы и приходы)");
}

module.exports = { mount };
