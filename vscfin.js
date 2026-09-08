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
    { name: "ФОТ - Сбер - сверить", category: "ФОТ" },
    { name: "ФОТ - Нал - сверить", category: "ФОТ" },
    { name: "ФОТ - безнал - сверить Эй Кей", category: "ФОТ" },
    { name: "ФОТ - безнал - сверить Альта", category: "ФОТ" },
    { name: "ФОТ - безнал - сверить ИП П", category: "ФОТ" },
    { name: "ФОТ - безнал - сверить ИП К", category: "ФОТ" },
    { name: "Единый налоговый платеж (Взносы)", category: "ФОТ" },
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

// ── Выгрузка .xlsx в раскладке листа «vsc таблица» ───────────────────────────
// Открывать ТОЛЬКО в Numbers (Excel искажает цвета — грабли из /fin), лист на
// каждый месяц с записями. Дальше строки копируются в основную таблицу руками.
//
// Палитра и кегли — КАНОН из собственного экспорта Numbers (export as Microsoft
// Excel → styles.xml → indexedColors), а НЕ пипетка и не AppleScript: последний
// отдаёт цвет в другом пространстве (#6DFFF2 вместо #7AFCF4).
//   бирюза служебных колонок #7AFCF4 · ячейки данных #FEFEFE
//   Helvetica 10, шапка Helvetica-Bold 12, «Юр. лицо» — кегль 8
// ВАЖНО: bgColor ДУБЛИРУЕТ fgColor — Numbers при импорте читает именно bgColor
// (с indexed=64 ячейки приезжали чёрными).
const AdmZip = require("adm-zip");
const XL_MONTHS = ["Январь", "Февраль", "Март", "Апрель", "Май", "Июнь", "Июль", "Август", "Сентябрь", "Октябрь", "Ноябрь", "Декабрь"];
const XL_HEAD = ["", "Категория", "Безнал/нал", "Наименование", "Контрагент", "Стоимость", "Юр. лицо", "", "Наименование", "Контрагент", "Стоимость"];

function colLetter(i) { let s = "", n = i + 1; while (n > 0) { s = String.fromCharCode(65 + (n - 1) % 26) + s; n = Math.floor((n - 1) / 26); } return s; }
// cells: [{v, num?, style?, f?}] — f это формула без «=» («1000*86.1909»)
function xlRow(rowIdx, cells, height) {
  const parts = cells.map((c, i) => {
    if (c == null || c.v === "" || c.v == null) return "";
    const ref = colLetter(i) + rowIdx;
    const st = c.style ? ' s="' + c.style + '"' : "";
    if (c.f) return '<c r="' + ref + '"' + st + '><f>' + xmlEsc(c.f) + '</f><v>' + c.v + '</v></c>';
    return c.num
      ? '<c r="' + ref + '"' + st + '><v>' + c.v + '</v></c>'
      : '<c r="' + ref + '"' + st + ' t="inlineStr"><is><t xml:space="preserve">' + xmlEsc(c.v) + '</t></is></c>';
  });
  const h = height ? ' ht="' + height + '" customHeight="1"' : "";
  return '<row r="' + rowIdx + '"' + h + ">" + parts.join("") + "</row>";
}

function buildXlsx(entries) {
  const byMonth = new Map();
  entries.slice().sort((a, b) => (a.date === b.date ? a.at - b.at : (a.date < b.date ? -1 : 1))).forEach((e) => {
    const ym = String(e.date).slice(0, 7);
    if (!byMonth.has(ym)) byMonth.set(ym, []);
    byMonth.get(ym).push(e);
  });
  const yms = Array.from(byMonth.keys()).sort();
  if (!yms.length) yms.push(todayMsk().slice(0, 7));

  const sheets = yms.map((ym) => {
    const list = byMonth.get(ym) || [];
    const exp = list.filter((e) => e.type === "exp");
    const inc = list.filter((e) => e.type === "inc");
    const rows = [xlRow(1, XL_HEAD.map((h) => ({ v: h || " ", style: 1 })), 30)];
    // Расходы (A..G) и приходы (I..K) идут двумя независимыми столбиками —
    // ровно как в листе Андрея: строки левой и правой половины не связаны.
    const n = Math.max(exp.length, inc.length);
    let prevDay = null;
    for (let i = 0; i < n; i++) {
      const cells = new Array(11).fill(null);
      const e = exp[i];
      if (e) {
        const day = +String(e.date).slice(8, 10);
        cells[0] = day !== prevDay ? { v: day, num: true, style: 4 } : { v: " ", style: 3 };
        prevDay = day;
        cells[1] = { v: e.category || " ", style: 3 };
        cells[2] = { v: " ", style: 3 };                       // Безнал/нал — руками
        cells[3] = { v: e.comment ? e.name + " - " + e.comment : e.name, style: 0 };
        cells[4] = { v: e.party || " ", style: 0 };
        cells[5] = { v: e.rub, num: true, style: 2, f: e.formula || null };
        cells[6] = { v: " ", style: 6 };                       // Юр. лицо — руками, кегль 8
      }
      cells[7] = { v: " ", style: 3 };                         // разделитель — бирюзовая полоса во всех строках
      const k = inc[i];
      if (k) {
        cells[8] = { v: k.comment ? k.name + " - " + k.comment : k.name, style: 0 };
        cells[9] = { v: k.party || " ", style: 0 };
        cells[10] = { v: k.rub, num: true, style: 2, f: k.formula || null };
      }
      rows.push(xlRow(i + 2, cells));
    }
    const pp = ym.split("-");
    return { name: XL_MONTHS[+pp[1] - 1] + " " + pp[0], xml: rows.join("") };
  });

  const zip = new AdmZip();
  zip.addFile("[Content_Types].xml", Buffer.from('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
    + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
    + '<Default Extension="xml" ContentType="application/xml"/>'
    + '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
    + '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
    + sheets.map((_, i) => '<Override PartName="/xl/worksheets/sheet' + (i + 1) + '.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>').join("")
    + "</Types>", "utf8"));
  zip.addFile("_rels/.rels", Buffer.from('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>'
    + "</Relationships>", "utf8"));
  zip.addFile("xl/workbook.xml", Buffer.from('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>'
    + sheets.map((sh, i) => '<sheet name="' + xmlEsc(sh.name) + '" sheetId="' + (i + 1) + '" r:id="rId' + (i + 1) + '"/>').join("")
    + "</sheets></workbook>", "utf8"));
  zip.addFile("xl/_rels/workbook.xml.rels", Buffer.from('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + sheets.map((_, i) => '<Relationship Id="rId' + (i + 1) + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet' + (i + 1) + '.xml"/>').join("")
    + '<Relationship Id="rIdS" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>'
    + "</Relationships>", "utf8"));
  zip.addFile("xl/styles.xml", Buffer.from('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
    + '<fonts count="3"><font><sz val="10"/><name val="Helvetica"/></font>'
    + '<font><b/><sz val="12"/><name val="Helvetica"/></font>'
    + '<font><sz val="8"/><name val="Helvetica"/></font></fonts>'
    + '<fills count="5"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>'
    + '<fill><patternFill patternType="solid"><fgColor rgb="FF7BFDF5"/><bgColor rgb="FF7BFDF5"/></patternFill></fill>'
    + '<fill><patternFill patternType="solid"><fgColor rgb="FFFFFFFF"/><bgColor rgb="FFFFFFFF"/></patternFill></fill>'
    + '<fill><patternFill patternType="solid"><fgColor rgb="FF9CFAF4"/><bgColor rgb="FF9CFAF4"/></patternFill></fill></fills>'
    + '<borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border>'
    + '<border><left style="thin"><color rgb="FFD9D9D9"/></left><right style="thin"><color rgb="FFD9D9D9"/></right>'
    + '<top style="thin"><color rgb="FFD9D9D9"/></top><bottom style="thin"><color rgb="FFD9D9D9"/></bottom><diagonal/></border></borders>'
    + '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
    + '<cellXfs count="7">'
    + '<xf numFmtId="0" fontId="0" fillId="3" borderId="1" xfId="0" applyFill="1" applyBorder="1"/>'                                                     // 0 данные (белая)
    + '<xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1"><alignment horizontal="center" vertical="center"/></xf>' // 1 шапка расходов
    + '<xf numFmtId="4" fontId="0" fillId="3" borderId="1" xfId="0" applyNumberFormat="1" applyFill="1" applyBorder="1"/>'                               // 2 сумма
    + '<xf numFmtId="0" fontId="0" fillId="2" borderId="1" xfId="0" applyFill="1" applyBorder="1"/>'                                                     // 3 бирюза (Категория, Безнал/нал, полоса дня)
    + '<xf numFmtId="0" fontId="0" fillId="3" borderId="1" xfId="0" applyFill="1" applyBorder="1"><alignment horizontal="center"/></xf>'                 // 4 день с номером
    + '<xf numFmtId="0" fontId="1" fillId="4" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1"><alignment horizontal="center" vertical="center"/></xf>' // 5 шапка приходов
    + '<xf numFmtId="0" fontId="2" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1"/>'                                       // 6 Юр. лицо (кегль 8)
    + '</cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>', "utf8"));
  sheets.forEach((sh, i) => {
    zip.addFile("xl/worksheets/sheet" + (i + 1) + ".xml", Buffer.from('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
      + '<cols><col min="1" max="1" width="5"/><col min="2" max="3" width="13"/><col min="4" max="4" width="46"/>'
      + '<col min="5" max="5" width="24"/><col min="6" max="6" width="14"/><col min="7" max="7" width="14"/>'
      + '<col min="8" max="8" width="3"/><col min="9" max="9" width="40"/><col min="10" max="10" width="24"/><col min="11" max="11" width="14"/></cols>'
      + "<sheetData>" + sh.xml + "</sheetData></worksheet>", "utf8"));
  });
  return zip.toBuffer();
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
    for (const x of [...expLearned, ...SEED.expense]) if (!seenE.has(x.name)) { seenE.add(x.name); expense.push({ name: x.name, category: x.category || "", party: x.party || "", rub: x.rub || 0 }); }
    const seenI = new Set(); const income = [];
    for (const x of [...incLearned, ...SEED.income.map((n) => ({ name: n }))]) if (!seenI.has(x.name)) { seenI.add(x.name); income.push({ name: x.name, party: x.party || "", rub: x.rub || 0 }); }
    const cats = [...new Set([...SEED.categories, ...learned.map((x) => x.category).filter(Boolean)])];
    res.json({
      success: true,
      today: todayMsk(),
      rates: await ratesPayload(false),
      ref: { categories: cats, expense, income },
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
      // сумма могла быть введена выражением («1000*86.1909» после кнопки $) —
      // храним его и отдаём в xlsx формулой, как Андрей делает в таблице руками
      formula: /^[\d\s.,+\-*/()]+$/.test(String(b.formula || "")) && /[+\-*/]/.test(String(b.formula || "").slice(1))
        ? String(b.formula).replace(/\s+/g, "").replace(/,/g, ".").slice(0, 120) : undefined,
    };
    if (type === "exp") e.category = String(b.category || "").trim().slice(0, 100) || undefined;
    st.entries.push(e);
    // запоминаем название вместе с его реквизитами — в следующий раз подставится
    const c = st.custom[name] || { type, uses: 0 };
    c.type = type; c.uses = (c.uses || 0) + 1;
    if (e.category) c.category = e.category;
    if (e.party) c.party = e.party;
    if (e.rub) c.rub = e.rub; // последняя сумма — подсказкой на плашке, как в /fin
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
    if (e.type === "exp" && b.category != null) e.category = String(b.category).trim().slice(0, 100) || undefined;
    if (b.formula != null) e.formula = String(b.formula).trim() ? String(b.formula).replace(/\s+/g, "").replace(/,/g, ".").slice(0, 120) : undefined;
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


  // Выгрузка таблицы: .xlsx с раскладкой листа «vsc таблица».
  // Открывать в Numbers (не в Excel — портит цвета), строки копировать руками.
  app.get("/akfin/api/export.xlsx", requireFin, (req, res) => {
    const list = store().entries.filter((e) => !e.deleted);
    const buf = buildXlsx(list);
    res.set("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.set("Content-Disposition", 'attachment; filename="vsc-fin.xlsx"');
    res.set("Cache-Control", "no-store");
    res.send(buf);
  });

  console.log("VSCFIN: /akfin смонтирован (рабочие расходы и приходы)");
}

module.exports = { mount };
