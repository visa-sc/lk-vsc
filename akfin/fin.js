// ── /fin: личные финансы Андрея (17.08.2026) ───────────────────────────────────
// Супер-простой учёт расходов с телефона → автоматическая запись в
// «Личные финансы.numbers» (iCloud, мак Андрея). Отдельный модуль, монтируется
// из server.js; клиентский ЛК, amoCRM и остальные разделы НЕ затрагивает.
//
// Схема (с 18.08.2026): айфон → /fin (PWA, вход по коду FIN_CODE) → записи в
// .fin/store.json → кнопка «Скачать таблицу» отдаёт .xlsx с раскладкой листа
// «Личные финансы» (Numbers открывает его как есть, строки копируются руками).
// Агента синка на маке и записи в Numbers через AppleScript БОЛЬШЕ НЕТ — по
// просьбе Андрея: не грузить систему и не трогать основную таблицу.
//
// Корзины — как столбцы таблицы Андрея:
//   pos   = Позитивные расходы        ok    = Допустимые расходы
//   nope  = Можно было не тратить     trash = Выброшенные на ветер деньги
//
// env: FIN_CODE (код входа с телефона, дефолт 280992 — общий админ-код),
// Хранилище: .fin/store.json (gitignore — личные данные).

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const webauthn = require("@simplewebauthn/server"); // Face ID — та же библиотека, что в ЛК/админке, но свои изолированные ключи

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
  if (!Array.isArray(_store.passkeys)) _store.passkeys = []; // Face ID: свои ключи, НЕ общие с .passkeys.json ЛК
  return _store;
}
function save() {
  // личные данные: папка и файл только для владельца процесса
  try { fs.mkdirSync(DIR, { recursive: true, mode: 0o700 }); } catch (_) {}
  try {
    fs.writeFileSync(STORE_FILE, JSON.stringify(store(), null, 2), { encoding: "utf8", mode: 0o600 });
    fs.chmodSync(STORE_FILE, 0o600); fs.chmodSync(DIR, 0o700);
  } catch (e) { console.error("fin save:", e.message); }
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

// ── Выгрузка таблицы (17.08.2026) ─────────────────────────────────────────────
// Отдаём .xlsx с той же раскладкой, что в «Личные финансы.numbers» Андрея:
//   A=день (только в первой строке дня) · B=наименование (+ « - » комментарий)
//   C=Позитивные · D=Допустимые · E=Можно было не тратить · F=Выброшенные
//   G=Категория · H=Банк (пусто, заполняется руками)
// Лист на каждый месяц с записями, имена как у листов Андрея («Август 2026»).
// Numbers открывает .xlsx двойным кликом — строки копируются в основную таблицу.
// Своего формата .numbers у нас нет: он закрытый, на сервере его не собрать.
const AdmZip = require("adm-zip");
const XL_MONTHS = ["Январь", "Февраль", "Март", "Апрель", "Май", "Июнь", "Июль", "Август", "Сентябрь", "Октябрь", "Ноябрь", "Декабрь"];
const BUCKET_COL_XL = { pos: 2, ok: 3, nope: 4, trash: 5 }; // индекс среди 4 колонок сумм (C..F)
function xmlEsc(s) {
  return String(s == null ? "" : s).replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" }[c]));
}
function colLetter(i) { let s = "", n = i + 1; while (n > 0) { s = String.fromCharCode(65 + (n - 1) % 26) + s; n = Math.floor((n - 1) / 26); } return s; }
// cells: [{v, num?, style?, f?}] — style: 0 обычная, 1 заголовок, 2 деньги, 3 жёлтая, 4 красная;
// f — формула («45*79.8», без «=»): валютный ввод попадает в ячейку формулой, v — посчитанный кэш.
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
  const h = height ? ' ht="' + height + '" customHeight="1"' : '';
  return '<row r="' + rowIdx + '"' + h + '>' + parts.join("") + '</row>';
}
function buildXlsx(entries) {
  // группировка: месяц → день → записи (порядок ввода сохраняем)
  const byMonth = new Map();
  entries.slice().sort((a, b) => (a.date === b.date ? a.at - b.at : (a.date < b.date ? -1 : 1))).forEach((e) => {
    const ym = String(e.date).slice(0, 7);
    if (!byMonth.has(ym)) byMonth.set(ym, []);
    byMonth.get(ym).push(e);
  });
  const yms = Array.from(byMonth.keys()).sort();
  if (!yms.length) yms.push(todayMsk().slice(0, 7));           // пустая выгрузка — один лист текущего месяца
  const HEAD = ["", "Наименование", "Позитивные расходы", "Допустимые расходы", "Можно было не тратить", "Выброшенные на ветер деньги", "Категория", "Банк"];
  const sheets = yms.map((ym) => {
    const list = byMonth.get(ym) || [];
    const rows = [xlRow(1, HEAD.map((h) => ({ v: h || " ", style: 1 })), 34)];
    let r = 2, prevDay = null;
    list.forEach((e) => {
      const day = +String(e.date).slice(8, 10);
      const cells = new Array(8).fill(null);
      // Колонка дня: с номером — белая жирная (как у Андрея), без номера — бирюзовая полоса.
      cells[0] = (day !== prevDay) ? { v: day, num: true, style: 7 } : { v: " ", style: 8 };
      prevDay = day;
      // Наименование — серая заливка; метка 🟡/🔴 перебивает её (как цвет ячейки в Numbers).
      cells[1] = { v: e.comment ? e.name + " - " + e.comment : e.name, style: e.flag === "yellow" ? 3 : (e.flag === "red" ? 4 : (e.flag === "green" ? 9 : 6)) };
      // Колонки сумм — белые: заполняем пустышками, чтобы рамки были у всех четырёх.
      for (let c = 2; c <= 5; c++) cells[c] = { v: " ", style: 0 };
      if (e.amount > 0) cells[BUCKET_COL_XL[e.bucket] != null ? BUCKET_COL_XL[e.bucket] : 3] = { v: e.amount, num: true, style: 2, f: e.formula || null };
      cells[6] = { v: e.category || " ", style: 5 };   // Категория — бирюзовая
      cells[7] = { v: " ", style: 5 };                 // Банк — бирюзовая, заполняется руками
      rows.push(xlRow(r++, cells));
    });
    const p = ym.split("-");
    return { name: XL_MONTHS[+p[1] - 1] + " " + p[0], xml: rows.join("") };
  });
  const zip = new AdmZip();
  zip.addFile("[Content_Types].xml", Buffer.from('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
    + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
    + '<Default Extension="xml" ContentType="application/xml"/>'
    + '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
    + '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
    + sheets.map((s, i) => '<Override PartName="/xl/worksheets/sheet' + (i + 1) + '.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>').join("")
    + '</Types>', "utf8"));
  zip.addFile("_rels/.rels", Buffer.from('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>'
    + '</Relationships>', "utf8"));
  zip.addFile("xl/workbook.xml", Buffer.from('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>'
    + sheets.map((s, i) => '<sheet name="' + xmlEsc(s.name) + '" sheetId="' + (i + 1) + '" r:id="rId' + (i + 1) + '"/>').join("")
    + '</sheets></workbook>', "utf8"));
  zip.addFile("xl/_rels/workbook.xml.rels", Buffer.from('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + sheets.map((s, i) => '<Relationship Id="rId' + (i + 1) + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet' + (i + 1) + '.xml"/>').join("")
    + '<Relationship Id="rIdS" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>'
    + '</Relationships>', "utf8"));
  // Палитра снята пипеткой с «Личные финансы.numbers»: шапка и правые колонки —
  // бирюзовые #00FFFF, «Наименование» — серая #BFBFBF, суммы — белые; всё в тонкой рамке.
  zip.addFile("xl/styles.xml", Buffer.from('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
    // Шрифт снят с «Личные финансы.numbers»: Helvetica 10 (день/шапка — Helvetica-Bold),
    // иначе скопированные строки в таблице Андрея отличаются от соседних.
    + '<fonts count="2"><font><sz val="10"/><name val="Helvetica"/></font><font><b/><sz val="10"/><name val="Helvetica"/></font></fonts>'
    // bgColor ДУБЛИРУЕТ fgColor: Excel для solid берёт fgColor, а Numbers при
    // копировании строк читает bgColor — с indexed=64 (системный) он давал ЧЁРНЫЕ ячейки.
    // Палитра ОТКАЛИБРОВАНА под импорт Numbers (19.08.2026): hex подобраны так,
    // чтобы ПОСЛЕ импорта совпадать с реальной таблицей Андрея до единиц:
    // 11FFF8 → бирюза шапки/категорий, 7AFCF4 → полоса дней, FEFEFE → день —
    // РОВНО те hex, которыми сам Numbers экспортирует таблицу Андрея в xlsx
    // sRGB-значения: Numbers конвертирует цвета через профиль при импорте.
    + '<fills count="9"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>'
    + '<fill><patternFill patternType="solid"><fgColor rgb="FFFFE061"/><bgColor rgb="FFFFE061"/></patternFill></fill>'
    + '<fill><patternFill patternType="solid"><fgColor rgb="FFFFC7CE"/><bgColor rgb="FFFFC7CE"/></patternFill></fill>'
    + '<fill><patternFill patternType="solid"><fgColor rgb="FF11FFF8"/><bgColor rgb="FF11FFF8"/></patternFill></fill>'
    + '<fill><patternFill patternType="solid"><fgColor rgb="FFBFBFBF"/><bgColor rgb="FFBFBFBF"/></patternFill></fill>'
    + '<fill><patternFill patternType="solid"><fgColor rgb="FF7AFCF4"/><bgColor rgb="FF7AFCF4"/></patternFill></fill>'
    + '<fill><patternFill patternType="solid"><fgColor rgb="FFFEFEFE"/><bgColor rgb="FFFEFEFE"/></patternFill></fill>'
    + '<fill><patternFill patternType="solid"><fgColor rgb="FFC6EFCE"/><bgColor rgb="FFC6EFCE"/></patternFill></fill></fills>'
    + '<borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border>'
    + '<border><left style="thin"><color rgb="FFD9D9D9"/></left><right style="thin"><color rgb="FFD9D9D9"/></right>'
    + '<top style="thin"><color rgb="FFD9D9D9"/></top><bottom style="thin"><color rgb="FFD9D9D9"/></bottom><diagonal/></border></borders>'
    + '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
    + '<cellXfs count="10">'
    + '<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1"/>'                                                       // 0 обычная
    + '<xf numFmtId="0" fontId="1" fillId="4" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1"><alignment vertical="center" wrapText="1"/></xf>' // 1 шапка
    + '<xf numFmtId="4" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1"/>'                                  // 2 сумма
    + '<xf numFmtId="0" fontId="0" fillId="2" borderId="1" xfId="0" applyFill="1" applyBorder="1"/>'                                          // 3 🟡 разобраться
    + '<xf numFmtId="0" fontId="0" fillId="3" borderId="1" xfId="0" applyFill="1" applyBorder="1"/>'                                          // 4 🔴 вернуть
    + '<xf numFmtId="0" fontId="0" fillId="4" borderId="1" xfId="0" applyFill="1" applyBorder="1"/>'                                          // 5 бирюза категорий (шапка/G/H)
    + '<xf numFmtId="0" fontId="0" fillId="5" borderId="1" xfId="0" applyFill="1" applyBorder="1"/>'                                          // 6 «Наименование»
    + '<xf numFmtId="0" fontId="1" fillId="7" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1"><alignment horizontal="center"/></xf>' // 7 день (белая, как у Андрея)
    + '<xf numFmtId="0" fontId="0" fillId="6" borderId="1" xfId="0" applyFill="1" applyBorder="1"/>'                                          // 8 бирюза полосы дней (A без номера)
    + '<xf numFmtId="0" fontId="0" fillId="8" borderId="1" xfId="0" applyFill="1" applyBorder="1"/>'                                          // 9 🟢 зелёная метка
    + '</cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>', "utf8"));
  sheets.forEach((s, i) => {
    zip.addFile("xl/worksheets/sheet" + (i + 1) + ".xml", Buffer.from('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
      + '<cols><col min="1" max="1" width="6"/><col min="2" max="2" width="42"/><col min="3" max="6" width="17"/><col min="7" max="8" width="16"/></cols>'
      + '<sheetData>' + s.xml + '</sheetData></worksheet>', "utf8"));
  });
  return zip.toBuffer();
}

function mount(app, deps) {
  const requireAdmin = deps.requireAdmin;
  const FIN_CODE = process.env.FIN_CODE || "280992";

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

  // Сторож: при подборе кода (5+ неверных за сутки суммарно) — письмо директору,
  // не чаще раза в сутки. Личные финансы — самый чувствительный раздел.
  let failsToday = { day: "", n: 0, alerted: false };
  function noteFail(ip) {
    const day = todayMsk();
    if (failsToday.day !== day) failsToday = { day, n: 0, alerted: false };
    failsToday.n++;
    if (failsToday.n >= 5 && !failsToday.alerted) {
      failsToday.alerted = true;
      try {
        require("./mail").sendMail({
          to: "director@visa-sc.ru",
          subject: "⚠️ /fin: попытки подбора кода",
          html: `За сегодня ${failsToday.n} неверных попыток входа в раздел личных финансов. Последний IP: ${ip}. Если это не вы — смените FIN_CODE в .env на сервере.`,
        }).catch(() => {});
      } catch (_) {}
    }
  }

  const loginFails = new Map(); // ip -> [ts]
  app.post("/fin/api/login", (req, res) => {
    const ip = String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();
    const hist = (loginFails.get(ip) || []).filter((t) => Date.now() - t < 24 * 3600 * 1000);
    if (hist.length >= 15) return res.status(429).json({ success: false, message: "Слишком много попыток, попробуйте завтра" });
    const code = String((req.body && req.body.code) || "").trim();
    if (code !== FIN_CODE) {
      hist.push(Date.now()); loginFails.set(ip, hist);
      noteFail(ip);
      return res.status(401).json({ success: false, message: "Неверный код" });
    }
    res.json({ success: true, token: issueToken("code") });
  });

  // ── Face ID (WebAuthn) — изолированно от паспорт-ключей ЛК/админки. ──
  // Регистрация ключа — ТОЛЬКО из залогиненной сессии (код знает один Андрей),
  // вход по ключу — публичный эндпоинт, но пускает только по подписи
  // зарегистрированного ключа. Хост-зависимые rpID/origin как в ЛК.
  const FIN_BIO_HOSTS = { "ak-co.ru": true, "voyotravel.ru": true, "voyovoyo.ru": true };
  function bioHost(req) {
    const h = String((req.headers && req.headers.host) || "").toLowerCase().split(":")[0].replace(/^www\./, "");
    return FIN_BIO_HOSTS[h] ? h : "ak-co.ru";
  }
  const bioChallenges = new Map(); // key -> {challenge, expiresAt}
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

  app.post("/fin/api/bio/register-options", requireFin, async (req, res) => {
    try {
      const st = store();
      const options = await webauthn.generateRegistrationOptions({
        rpName: "VOYO",
        rpID: bioHost(req),
        userID: "fin-owner",
        userName: "fin",
        userDisplayName: "Личный раздел",
        attestationType: "none",
        excludeCredentials: st.passkeys.map((c) => ({ id: fromB64u(c.credentialID), type: "public-key" })),
        authenticatorSelection: { residentKey: "preferred", userVerification: "preferred" },
      });
      setBioChallenge("reg", options.challenge);
      res.json(options);
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
  });
  app.post("/fin/api/bio/register-verify", requireFin, async (req, res) => {
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
      const st = store();
      st.passkeys.push({ credentialID: b64u(info.credentialID), publicKey: b64u(info.credentialPublicKey), counter: info.counter || 0, host: bioHost(req), createdAt: Date.now() });
      save();
      res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
  });
  app.post("/fin/api/bio/has", (req, res) => {
    res.json({ success: true, has: store().passkeys.some((c) => c.host === bioHost(req)) });
  });
  app.post("/fin/api/bio/auth-options", async (req, res) => {
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
  app.post("/fin/api/bio/auth-verify", async (req, res) => {
    try {
      const assertionResponse = req.body && req.body.assertionResponse;
      const expectedChallenge = takeBioChallenge("auth");
      if (!assertionResponse || !expectedChallenge) return res.status(400).json({ success: false, message: "Сессия просрочена" });
      const st = store();
      const cred = st.passkeys.find((c) => c.credentialID === assertionResponse.id);
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
      res.json({ success: true, token: issueToken("bio") });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
  });

  function requireFin(req, res, next) {
    const tok = tokenFromReq(req);
    const rec = tok && store().auth[tok];
    if (rec && Date.now() - (rec.at || 0) <= TOKEN_TTL) return next();
    return res.status(401).json({ success: false, message: "Нет доступа" });
  }
  // Агент синка: отдельный ключ, чтобы не хранить пользовательский токен на маке.

  app.get("/fin", (req, res) => {
    res.set("Cache-Control", "no-store, no-cache, must-revalidate");
    res.sendFile(path.join(__dirname, "public", "fin.html"));
  });
  // Иконка «растущий график» и сервис-воркер офлайн-режима (Life Investments)
  app.get("/fin-icon.png", (req, res) => {
    res.set("Cache-Control", "public, max-age=86400");
    res.sendFile(path.join(__dirname, "public", "fin-icon.png"));
  });
  app.get("/fin-sw.js", (req, res) => {
    res.set("Cache-Control", "no-store");
    res.type("application/javascript");
    res.sendFile(path.join(__dirname, "public", "fin-sw.js"));
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
    res.json({ success: true, frequent, categories: sd.categories || [], today, entries, total: st.entries.filter((e) => !e.deleted).length });
  });

  // Добавить расход. body: {name, amount, bucket, category?, date?, flag?, comment?}
  // flag: "" | "yellow" (разобраться) | "red" (вернуть деньги) — цвет ячейки в Numbers;
  // comment — приписывается к названию через « - » (как Андрей делает руками).
  app.post("/fin/api/add", requireFin, (req, res) => {
    const b = req.body || {};
    const name = String(b.name || "").trim().slice(0, 200);
    let amount = Math.round(Number(b.amount) * 100) / 100;
    const bucket = BUCKETS.includes(b.bucket) ? b.bucket : "ok";
    const flagEarly = ["yellow", "red", "green"].includes(b.flag);
    if (!name) return res.status(400).json({ success: false, message: "Нет названия" });
    // Валютный ввод (USD): выражение вида «45*79.8» — уходит в таблицу ФОРМУЛОЙ,
    // сумма в рублях считается из него (и на клиенте, и здесь — не доверяем клиенту).
    let formula = String(b.formula || "").trim().slice(0, 120).replace(/,/g, ".").replace(/\s+/g, "");
    if (formula) {
      if (!/^[0-9.+\-*/()]+$/.test(formula)) return res.status(400).json({ success: false, message: "В выражении только цифры и + − × ÷" });
      let val;
      try { val = Function('"use strict";return(' + formula + ')')(); } catch (_) { val = NaN; }
      if (!isFinite(val) || !(val > 0)) return res.status(400).json({ success: false, message: "Не могу посчитать выражение" });
      amount = Math.round(val * 100) / 100;
    }
    // с меткой 🟡/🔴 сумма не обязательна — строка-заметка (как «вернуть билет…»)
    if (!(amount > 0)) {
      if (!flagEarly) return res.status(400).json({ success: false, message: "Сумма должна быть больше нуля" });
      amount = 0;
    }
    let date = String(b.date || "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) date = todayMsk();
    const category = String(b.category || "").trim() || categorize(name);
    const flag = ["yellow", "red", "green"].includes(b.flag) ? b.flag : "";
    const comment = String(b.comment || "").trim().slice(0, 300);
    const st = store();
    // офлайн-очередь шлёт повторно при обрыве связи — дедупликация по клиентскому cid
    let cid = String(b.cid || "").trim().slice(0, 64);
    if (cid && !/^[a-zA-Z0-9-]{6,64}$/.test(cid)) cid = "";
    if (cid) {
      const dup = st.entries.find((x) => x.cid === cid);
      if (dup) return res.json({ success: true, entry: dup, dedup: true });
    }
    const e = {
      id: crypto.randomBytes(8).toString("hex"),
      at: Date.now(),
      date, name, amount, bucket, category, flag, comment,
      formula: formula || "",
      cid: cid || "",
      synced: false,
    };
    st.entries.push(e);
    if (st.entries.length > MAX_ENTRIES) st.entries.splice(0, st.entries.length - MAX_ENTRIES);
    // самообучение частых покупок (заметки без суммы не учим)
    if (amount > 0) {
      const key = name.toLowerCase().replace(/\s+/g, " ");
      const known = Object.keys(st.custom).find((k) => k.toLowerCase() === key);
      const rec = known ? st.custom[known] : { uses: 0 };
      rec.uses++; rec.bucket = bucket; rec.category = category; rec.amount = amount;
      st.custom[known || name] = rec;
    }
    save();
    res.json({ success: true, entry: e });
  });

  // Редактирование/удаление — всегда доступны: записи живут здесь, в Numbers они
  // попадают только копированием из выгрузки (агента синка больше нет, 18.08.2026).
  app.post("/fin/api/edit/:id", requireFin, (req, res) => {
    const st = store();
    const e = st.entries.find((x) => x.id === req.params.id);
    if (!e) return res.status(404).json({ success: false, message: "Не найдено" });
    const b = req.body || {};
    if (b.name != null) { const n = String(b.name).trim().slice(0, 200); if (n) e.name = n; }
    if (b.amount != null) { const a = Math.round(Number(b.amount) * 100) / 100; if (a > 0) { e.amount = a; e.formula = ""; } }
    // формула (валютный ввод) перекрывает amount: пересчитываем и храним выражение
    if (b.formula != null) {
      const f = String(b.formula).trim().slice(0, 120).replace(/,/g, ".").replace(/\s+/g, "");
      if (f) {
        if (!/^[0-9.+\-*/()]+$/.test(f)) return res.status(400).json({ success: false, message: "В выражении только цифры и + − × ÷" });
        let val; try { val = Function('"use strict";return(' + f + ')')(); } catch (_) { val = NaN; }
        if (!isFinite(val) || !(val > 0)) return res.status(400).json({ success: false, message: "Не могу посчитать выражение" });
        e.formula = f; e.amount = Math.round(val * 100) / 100;
      } else if (b.amount == null) { e.formula = ""; }
    }
    if (b.bucket != null && BUCKETS.includes(b.bucket)) e.bucket = b.bucket;
    if (b.category != null) e.category = String(b.category).trim() || e.category;
    if (b.flag != null) e.flag = ["yellow", "red", "green"].includes(b.flag) ? b.flag : "";
    if (b.comment != null) e.comment = String(b.comment).trim().slice(0, 300);
    if (b.date != null && /^\d{4}-\d{2}-\d{2}$/.test(String(b.date))) e.date = String(b.date);
    save();
    res.json({ success: true, entry: e });
  });
  app.post("/fin/api/delete/:id", requireFin, (req, res) => {
    const st = store();
    const e = st.entries.find((x) => x.id === req.params.id);
    if (!e) return res.status(404).json({ success: false, message: "Не найдено" });
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

  // Выгрузка таблицы: .xlsx с раскладкой листа Андрея (открывается в Numbers).
  // ?month=YYYY-MM — только один месяц; без параметра — все месяцы с записями.
  app.get("/fin/api/export.xlsx", requireFin, (req, res) => {
    const st = store();
    const mon = String((req.query && req.query.month) || "").trim();
    let list = st.entries.filter((e) => !e.deleted);
    if (/^\d{4}-\d{2}$/.test(mon)) list = list.filter((e) => String(e.date).slice(0, 7) === mon);
    let buf;
    try { buf = buildXlsx(list); }
    catch (e) { console.error("fin xlsx:", e.message); return res.status(500).json({ success: false, message: "Не удалось собрать файл" }); }
    const fname = "Личные финансы" + (/^\d{4}-\d{2}$/.test(mon) ? " " + mon : "") + ".xlsx";
    res.set("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    // inline, НЕ attachment: страница открывает файл в отдельном окне (target=_blank),
    // и встроенный браузер iOS с attachment показывает белый экран; с inline —
    // предпросмотр таблицы + «Поделиться» → «Open in Numbers».
    res.set("Content-Disposition", "inline; filename=\"finances.xlsx\"; filename*=UTF-8''" + encodeURIComponent(fname));
    res.set("Cache-Control", "no-store");
    res.send(buf);
  });

  // Диагностика для админки (не публично)
  app.get("/fin/api/status", requireAdmin, (req, res) => {
    const st = store();
    res.json({
      success: true,
      entries: st.entries.filter((e) => !e.deleted).length,
      customLearned: Object.keys(st.custom).length,
    });
  });

  console.log("FIN: /fin смонтирован (личные финансы)");
}

module.exports = { mount };
