// ─────────────────────────────────────────────────────────────────────────
// esign.js — ПОДПИСАНИЕ ДОКУМЕНТОВ простой электронной подписью (ПЭП) по SMS-коду.
// Самостоятельный аналог fdoc. НЕ интегрирован в клиентский ЛК и НЕ меняет вход/
// авторизацию: монтируется отдельными маршрутами /esign* и /api/esign*.
// Подключение к опросникам/договорам — отдельным шагом, по команде (см. README в
// конце файла и шаги интеграции, выданные в чате).
//
// Юридическая основа: ПЭП по 63-ФЗ «Об электронной подписи» (ст. 5, 6, 9).
// Для ПЭП НЕ нужны УЦ/сертификаты/криптография и НЕТ никакого госреестра подписей.
// Достаточно: (1) соглашение об использовании ПЭП (CONSENT_TEXT — акцепт клиентом),
// (2) идентификация подписанта (телефон + одноразовый код), (3) доказательный
// аудит-лог (этот модуль фиксирует телефон, хэш кода, SHA-256 документа, время, IP,
// user-agent, версию соглашения) и формирует «Протокол подписания» (PDF).
// ─────────────────────────────────────────────────────────────────────────
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const PDFDocument = require("pdfkit");
const sms = require("./sms");

const STORE_DIR = path.join(__dirname, "esign_store");   // PDF: оригиналы и протоколы
const LEDGER_FILE = path.join(__dirname, ".esign.json"); // метаданные запросов (содержит ПДн → в .gitignore)
const OTP_TTL_MS = 10 * 60 * 1000;        // код действует 10 минут
const OTP_MAX_ATTEMPTS = 5;               // максимум попыток ввода
const OTP_RESEND_COOLDOWN_MS = 60 * 1000; // не чаще 1 SMS в минуту
const OTP_MAX_SENDS = 5;                   // максимум отправок кода на запрос
const REQ_TTL_MS = 14 * 24 * 3600 * 1000; // запрос на подпись живёт 14 дней
const CONSENT_VERSION = "ПЭП-1.0 (2026-06-26)";

// ── СОГЛАШЕНИЕ ОБ ИСПОЛЬЗОВАНИИ ПЭП (черновик; передать юристу на проверку) ──
// Плейсхолдеры [...] заполнить реквизитами компании перед боевым запуском.
const CONSENT_TEXT = `СОГЛАШЕНИЕ ОБ ИСПОЛЬЗОВАНИИ ПРОСТОЙ ЭЛЕКТРОННОЙ ПОДПИСИ (ПЭП)

1. Стороны и предмет
1.1. Настоящее Соглашение заключается между [ПОЛНОЕ НАИМЕНОВАНИЕ КОМПАНИИ, ИНН/ОГРН, адрес] (далее — «Компания») и физическим лицом, акцептовавшим настоящее Соглашение (далее — «Клиент»).
1.2. Соглашение регулирует использование Сторонами простой электронной подписи (ПЭП) при подписании электронных документов (опросные листы, договоры оказания услуг, согласия на обработку персональных данных, заявления, акты и иные документы, не содержащие сведений, составляющих государственную тайну).
1.3. Соглашение является договором присоединения (ст. 428 ГК РФ) и заключается путём проставления Клиентом отметки о согласии и/или ввода направленного ему одноразового кода.

2. Признание ПЭП равнозначной собственноручной подписи
2.1. В соответствии с ч. 2 ст. 6 и ст. 9 Федерального закона от 06.04.2011 № 63-ФЗ «Об электронной подписи» Стороны признают электронные документы, подписанные ПЭП в порядке настоящего Соглашения, равнозначными документам на бумажном носителе, подписанным собственноручной подписью, и порождающими аналогичные юридические последствия.

3. Ключ ПЭП и порядок подписания
3.1. Ключом ПЭП Клиента является одноразовый код (последовательность символов), направляемый Компанией SMS-сообщением на номер мобильного телефона Клиента, указанный Клиентом.
3.2. Документ считается подписанным Клиентом, если в интерфейсе подписания Клиент корректно ввёл направленный ему одноразовый код. Ввод корректного кода означает подписание Клиентом конкретного документа, отображённого ему при подписании.
3.3. Факт подписания фиксируется Компанией в протоколе подписания, содержащем в т.ч.: идентификатор документа, его криптографический отпечаток (хэш SHA-256), номер телефона Клиента, дату и время, IP-адрес и сведения об устройстве.

4. Идентификация подписанта
4.1. Клиент идентифицируется по номеру мобильного телефона, на который направлен одноразовый код. Подписантом признаётся лицо, владеющее данным номером и корректно вводящее направленный на него код.

5. Конфиденциальность ключа (ст. 9 ч. 2 п. 2 63-ФЗ)
5.1. Клиент обязуется не передавать одноразовый код третьим лицам и обеспечивать его конфиденциальность. Действия, совершённые с использованием корректно введённого кода, признаются совершёнными Клиентом.
5.2. Клиент обязуется незамедлительно уведомить Компанию при подозрении на компрометацию номера телефона или кода.

6. Ограничения
6.1. ПЭП не используется для подписания документов, содержащих сведения, составляющие государственную тайну, а также в случаях, когда нормативными актами РФ для соответствующего документа требуется усиленная (квалифицированная) электронная подпись или нотариальная форма.

7. Хранение и доказательственная сила
7.1. Подписанные документы и протоколы подписания хранятся Компанией в течение срока, установленного законодательством и внутренними регламентами Компании, и предоставляются по запросу Клиента, а также уполномоченных органов и суда.

8. Срок и расторжение
8.1. Соглашение действует бессрочно до его расторжения любой из Сторон. Расторжение не затрагивает юридическую силу ранее подписанных документов.

Акцептуя настоящее Соглашение, Клиент подтверждает, что ознакомлен с его условиями, согласен использовать ПЭП и обязуется соблюдать конфиденциальность одноразового кода.`;

// ── Утилиты ──
function ensureStore() { try { fs.mkdirSync(STORE_DIR, { recursive: true }); } catch (_) {} }
function sha256Hex(buf) { return crypto.createHash("sha256").update(buf).digest("hex"); }
function genId() { return crypto.randomBytes(24).toString("hex"); } // непредсказуемый токен = «ключ-ссылка»
function nowTs() { return Date.now(); }
function mskString(ts) { try { return new Date(ts).toLocaleString("ru-RU", { timeZone: "Europe/Moscow", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" }) + " МСК"; } catch (_) { return String(ts); } }
function maskPhone(p) { const s = String(p || "").replace(/\D/g, ""); return s.length >= 4 ? ("•••• " + s.slice(-4)) : s; }
// Независимая привязка к оператору связи (sms.ru) из ответа sms.sendMessage:
// id сообщения (sms_id) + статус доставки + остаток баланса. Это доказательство
// со стороны провайдера, что код ушёл на конкретный номер.
function smsProviderRef(r, phone) {
  if (!r) return null;
  const raw = r.raw || {};
  const smsMap = raw.sms || {};
  const per = smsMap[phone] || smsMap[Object.keys(smsMap)[0]] || {};
  return {
    provider: "sms.ru",
    smsId: per.sms_id || null,
    providerStatus: per.status || r.smsStatus || null,
    providerCode: (per.status_code != null ? per.status_code : (r.smsCode != null ? r.smsCode : null)),
    balance: (raw.balance != null ? raw.balance : (r.balance != null ? r.balance : null)),
    testMode: !!r.testMode
  };
}
function clientIp(req) { return String((req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket && req.socket.remoteAddress || "").slice(0, 64); }

let _ledger;
function loadLedger() { if (_ledger !== undefined) return _ledger; try { _ledger = JSON.parse(fs.readFileSync(LEDGER_FILE, "utf8")); } catch (_) { _ledger = {}; } return _ledger; }
function saveLedger() { try { fs.writeFileSync(LEDGER_FILE, JSON.stringify(_ledger, null, 2), "utf8"); } catch (e) { console.error("esign saveLedger:", e.message); } }

function getPdfFontPath() {
  const candidates = [
    path.join(__dirname, "fonts", "DejaVuSans.ttf"),
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/usr/share/fonts/TTF/DejaVuSans.ttf"
  ];
  for (const fp of candidates) { if (fs.existsSync(fp)) return fp; }
  return null;
}

// ── Генерация образца документа (для теста, если PDF не передан) ──
function buildSamplePdf(rec) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 50 });
    const chunks = []; doc.on("data", (c) => chunks.push(c)); doc.on("end", () => resolve(Buffer.concat(chunks))); doc.on("error", reject);
    const fp = getPdfFontPath(); if (fp) doc.font(fp);
    doc.fontSize(16).text(rec.docName || "Документ", { align: "center" });
    doc.moveDown(0.5).fontSize(11).fillColor("#555").text("Тип документа: " + (rec.docType || "—"), { align: "center" });
    doc.moveDown(1.5).fillColor("#000").fontSize(11);
    doc.text("Это образец документа для теста подписания простой электронной подписью (ПЭП).", { align: "left" });
    doc.moveDown(0.5).text("Подписант: " + (rec.signerName || "—"));
    doc.moveDown(0.5).text("Номер телефона: " + (rec.signerPhone || "—"));
    doc.moveDown(1).text("Содержательная часть документа размещается здесь. При реальной интеграции сюда передаётся готовый PDF опросника или договора, сформированный системой.");
    doc.moveDown(2).fontSize(9).fillColor("#888").text("Сформировано автоматически · " + mskString(nowTs()));
    doc.end();
  });
}

// ── Генерация «Протокола подписания» (доказательная база) ──
function buildProtocolPdf(rec) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 50 });
    const chunks = []; doc.on("data", (c) => chunks.push(c)); doc.on("end", () => resolve(Buffer.concat(chunks))); doc.on("error", reject);
    const fp = getPdfFontPath(); if (fp) doc.font(fp);
    const line = (label, val) => { doc.fontSize(10).fillColor("#666").text(label); doc.fontSize(11).fillColor("#000").text(String(val == null ? "—" : val)); doc.moveDown(0.6); };

    doc.fontSize(15).fillColor("#000").text("ПРОТОКОЛ ПОДПИСАНИЯ ДОКУМЕНТА", { align: "center" });
    doc.fontSize(11).fillColor("#555").text("простой электронной подписью (ПЭП)", { align: "center" });
    doc.moveDown(0.4).fontSize(9).fillColor("#888").text("№ " + rec.id, { align: "center" });
    doc.moveDown(1.2);

    doc.fillColor("#000").fontSize(12).text("Документ"); doc.moveDown(0.4);
    line("Наименование", rec.docName);
    line("Тип", rec.docType);
    line("Криптографический отпечаток (SHA-256)", rec.docHash);

    doc.moveDown(0.4).fontSize(12).text("Подписант"); doc.moveDown(0.4);
    line("ФИО", rec.signerName);
    line("Номер телефона (канал доставки кода)", rec.signerPhone);
    line("Способ идентификации", "Одноразовый код, направленный SMS на указанный номер");

    doc.moveDown(0.4).fontSize(12).text("Факт подписания"); doc.moveDown(0.4);
    line("Статус", "ПОДПИСАНО");
    line("Дата и время", mskString(rec.signedAt));
    line("IP-адрес", rec.signerIp);
    line("Устройство (User-Agent)", rec.signerUa);
    line("Соглашение об использовании ПЭП (версия)", rec.consentVersion);
    line("Отпечаток одноразового кода (SHA-256)", rec.otpHashUsed || "—");

    // Независимое подтверждение оператора связи — усиливает доказательную базу.
    if (rec.smsProvider && rec.smsProvider.smsId) {
      const sp = rec.smsProvider;
      doc.moveDown(0.4).fontSize(12).text("Подтверждение оператора связи (SMS)"); doc.moveDown(0.4);
      line("Оператор", sp.provider || "sms.ru");
      line("Идентификатор сообщения (sms_id)", sp.smsId);
      line("Статус доставки", String(sp.providerStatus || "—") + (sp.providerCode != null ? (" (код " + sp.providerCode + ")") : ""));
    }

    doc.moveDown(0.4).fontSize(12).text("Журнал событий"); doc.moveDown(0.4);
    (rec.events || []).forEach((e) => {
      const extra = (e.ip ? (" · IP " + e.ip) : "") + (e.sms && e.sms.smsId ? (" · sms_id " + e.sms.smsId) : "");
      doc.fontSize(9).fillColor("#333").text("• " + mskString(e.ts) + " — " + e.type + extra);
    });

    doc.moveDown(1).fontSize(8.5).fillColor("#777").text(
      "Документ подписан простой электронной подписью в соответствии со ст. 5, 6 и 9 Федерального закона от 06.04.2011 № 63-ФЗ «Об электронной подписи» и Соглашением об использовании ПЭП (версия " + rec.consentVersion + "), акцептованным подписантом. ПЭП признаётся равнозначной собственноручной подписи. Целостность документа подтверждается совпадением отпечатка SHA-256.",
      { align: "left" }
    );
    doc.end();
  });
}

// ── Бизнес-операции ──
async function createRequest({ docType, docName, signerPhone, signerName, pdfBuffer }) {
  ensureStore();
  const led = loadLedger();
  const id = genId();
  const dir = path.join(STORE_DIR, id);
  fs.mkdirSync(dir, { recursive: true });
  const rec = {
    id, createdAt: nowTs(),
    docType: String(docType || "Документ").slice(0, 120),
    docName: String(docName || "Документ").slice(0, 200),
    signerPhone: sms.normalizePhone(signerPhone || ""),
    signerName: String(signerName || "").slice(0, 200),
    status: "pending",
    consentVersion: CONSENT_VERSION,
    docHash: null,
    otp: null, otpSends: 0,
    events: [{ ts: nowTs(), type: "Запрос на подпись создан" }]
  };
  const buf = (pdfBuffer && pdfBuffer.length) ? pdfBuffer : await buildSamplePdf(rec);
  fs.writeFileSync(path.join(dir, "original.pdf"), buf);
  rec.docHash = sha256Hex(buf);
  led[id] = rec; saveLedger();
  return rec;
}

function getRecord(id) { const led = loadLedger(); return led[id] || null; }
function isExpired(rec) { return rec && rec.status === "pending" && (nowTs() - rec.createdAt) > REQ_TTL_MS; }

function publicView(rec) {
  if (!rec) return null;
  return {
    id: rec.id, docType: rec.docType, docName: rec.docName,
    signerName: rec.signerName, signerPhoneMasked: maskPhone(rec.signerPhone),
    status: isExpired(rec) ? "expired" : rec.status,
    createdAt: rec.createdAt, signedAt: rec.signedAt || null,
    consentVersion: rec.consentVersion, docHash: rec.docHash
  };
}

async function sendOtp(rec, ip) {
  if (!rec) return { ok: false, error: "Запрос не найден" };
  if (rec.status === "signed") return { ok: false, error: "Документ уже подписан" };
  if (isExpired(rec)) return { ok: false, error: "Срок действия запроса истёк" };
  if ((rec.otpSends || 0) >= OTP_MAX_SENDS) return { ok: false, error: "Превышен лимит отправок кода" };
  if (rec.otp && rec.otp.lastSentAt && (nowTs() - rec.otp.lastSentAt) < OTP_RESEND_COOLDOWN_MS) {
    return { ok: false, error: "Код уже отправлен. Повторная отправка — через минуту." };
  }
  const code = sms.generateCode ? String(sms.generateCode()) : String(Math.floor(1000 + Math.random() * 9000));
  rec.otp = { hash: sha256Hex(code), expiresAt: nowTs() + OTP_TTL_MS, attempts: 0, lastSentAt: nowTs() };
  rec.otpSends = (rec.otpSends || 0) + 1;
  const r = await sms.sendMessage(rec.signerPhone, `Код для подписания документа в VOYO: ${code}. Никому не сообщайте.`);
  // Независимое подтверждение оператора связи (sms.ru): id сообщения + статус доставки.
  // Это усиливает доказательную базу — провайдер со своей стороны фиксирует факт
  // отправки кода на конкретный номер (мы — заинтересованная сторона, наш лог один
  // суд может счесть недостаточным; ссылка на sms_id оператора это закрывает).
  const prov = smsProviderRef(r, rec.signerPhone);
  if (!r || !r.ok) {
    rec.events.push({ ts: nowTs(), type: "Ошибка отправки SMS-кода" + ((r && r.error) ? (": " + r.error) : ""), ip: ip, sms: prov });
    saveLedger();
    return { ok: false, error: "Не удалось отправить SMS" };
  }
  rec.events.push({ ts: nowTs(), type: "Код для подписания отправлен по SMS", ip: ip, sms: prov });
  saveLedger();
  return { ok: true, testMode: !!(r && r.testMode) };
}

async function signWithCode(rec, code, ip, ua) {
  if (!rec) return { ok: false, error: "Запрос не найден" };
  if (rec.status === "signed") return { ok: false, error: "Документ уже подписан" };
  if (isExpired(rec)) return { ok: false, error: "Срок действия запроса истёк" };
  if (!rec.otp) return { ok: false, error: "Сначала запросите код" };
  if (nowTs() > rec.otp.expiresAt) return { ok: false, error: "Код истёк, запросите новый" };
  if (rec.otp.attempts >= OTP_MAX_ATTEMPTS) return { ok: false, error: "Превышено число попыток" };
  rec.otp.attempts++;
  if (sha256Hex(String(code || "")) !== rec.otp.hash) {
    rec.events.push({ ts: nowTs(), type: "Неверный код при подписании", ip: ip });
    saveLedger();
    return { ok: false, error: "Неверный код" };
  }
  // Успех — фиксируем подпись и формируем протокол.
  rec.status = "signed";
  rec.signedAt = nowTs();
  rec.signerIp = ip;
  rec.signerUa = String(ua || "").slice(0, 240);
  rec.otpHashUsed = rec.otp.hash;
  // Подтверждение оператора связи по последней успешной отправке кода — в протокол.
  const sent = (rec.events || []).filter((e) => e.sms && e.sms.smsId && String(e.type || "").indexOf("отправлен") >= 0);
  rec.smsProvider = sent.length ? sent[sent.length - 1].sms : null;
  rec.events.push({ ts: nowTs(), type: "Документ подписан ПЭП", ip: ip });
  rec.otp = null; // код больше не нужен
  const protoBuf = await buildProtocolPdf(rec);
  fs.writeFileSync(path.join(STORE_DIR, rec.id, "protocol.pdf"), protoBuf);
  saveLedger();
  return { ok: true, signedAt: rec.signedAt };
}

// Проверка целостности: пересчитать SHA-256 хранимого оригинала и сверить с записанным.
function verifyIntegrity(rec) {
  if (!rec) return { ok: false, error: "Запрос не найден" };
  try {
    const buf = fs.readFileSync(path.join(STORE_DIR, rec.id, "original.pdf"));
    const h = sha256Hex(buf);
    return { ok: true, intact: h === rec.docHash, recordedHash: rec.docHash, currentHash: h, status: rec.status };
  } catch (e) { return { ok: false, error: "Файл документа недоступен" }; }
}

function fileStream(id, which, res) {
  const name = which === "protocol" ? "protocol.pdf" : "original.pdf";
  const fp = path.join(STORE_DIR, id, name);
  if (!fs.existsSync(fp)) { res.status(404).end(); return; }
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", "inline; filename=\"" + (which === "protocol" ? "protocol" : "document") + "_" + id.slice(0, 8) + ".pdf\"");
  fs.createReadStream(fp).pipe(res);
}

// ── Монтирование маршрутов ──
// deps: { requireVscAccess, requireAdmin }
function mount(app, deps) {
  deps = deps || {};
  const requireVscAccess = deps.requireVscAccess || ((req, res, next) => next());
  const requireAdmin = deps.requireAdmin || ((req, res, next) => next());

  // Операторская консоль (команда): создать запрос на подпись. Доступ: VSC/админ.
  app.post("/admin/api/esign/create", requireVscAccess, async (req, res) => {
    try {
      const b = req.body || {};
      if (!b.signerPhone || !sms.normalizePhone(b.signerPhone)) return res.status(400).json({ success: false, message: "Укажите корректный телефон подписанта" });
      let pdfBuffer = null;
      if (b.pdfBase64) { try { pdfBuffer = Buffer.from(String(b.pdfBase64).replace(/^data:.*;base64,/, ""), "base64"); } catch (_) {} }
      const rec = await createRequest({ docType: b.docType, docName: b.docName, signerPhone: b.signerPhone, signerName: b.signerName, pdfBuffer });
      const base = (req.headers["x-forwarded-proto"] || req.protocol || "https") + "://" + req.headers.host;
      return res.json({ success: true, id: rec.id, signUrl: base + "/esign/sign/" + rec.id, record: publicView(rec) });
    } catch (e) { console.error("esign create:", e.message); return res.status(500).json({ success: false, message: "Ошибка создания запроса" }); }
  });

  // Список запросов (команда).
  app.get("/admin/api/esign/list", requireVscAccess, (req, res) => {
    const led = loadLedger();
    const items = Object.values(led).sort((a, b) => b.createdAt - a.createdAt).slice(0, 200).map(publicView);
    return res.json({ success: true, items, consentVersion: CONSENT_VERSION });
  });

  // Текст соглашения об использовании ПЭП (команда — для просмотра/выгрузки юристу).
  app.get("/admin/api/esign/consent", requireVscAccess, (req, res) => res.json({ success: true, version: CONSENT_VERSION, text: CONSENT_TEXT }));

  // ── Публичные маршруты подписанта (доступ по непредсказуемому id из ссылки) ──
  app.get("/api/esign/:id", (req, res) => {
    const rec = getRecord(req.params.id);
    if (!rec) return res.status(404).json({ success: false, message: "Запрос не найден" });
    return res.json({ success: true, request: publicView(rec), consent: { version: CONSENT_VERSION, text: CONSENT_TEXT } });
  });
  app.get("/api/esign/:id/document", (req, res) => { if (!getRecord(req.params.id)) return res.status(404).end(); fileStream(req.params.id, "document", res); });
  app.get("/api/esign/:id/protocol", (req, res) => { const r = getRecord(req.params.id); if (!r || r.status !== "signed") return res.status(404).end(); fileStream(req.params.id, "protocol", res); });
  app.post("/api/esign/:id/otp", async (req, res) => {
    const rec = getRecord(req.params.id); if (!rec) return res.status(404).json({ success: false, message: "Запрос не найден" });
    const r = await sendOtp(rec, clientIp(req));
    return res.status(r.ok ? 200 : 400).json({ success: r.ok, message: r.error, testMode: r.testMode });
  });
  app.post("/api/esign/:id/sign", async (req, res) => {
    const rec = getRecord(req.params.id); if (!rec) return res.status(404).json({ success: false, message: "Запрос не найден" });
    if (!req.body || req.body.consent !== true) return res.status(400).json({ success: false, message: "Необходимо согласие на использование ПЭП" });
    const r = await signWithCode(rec, req.body.code, clientIp(req), req.headers["user-agent"]);
    if (!r.ok) return res.status(400).json({ success: false, message: r.error });
    return res.json({ success: true, signedAt: r.signedAt, protocolUrl: "/api/esign/" + rec.id + "/protocol" });
  });
  app.get("/api/esign/:id/verify", (req, res) => {
    const rec = getRecord(req.params.id); if (!rec) return res.status(404).json({ success: false });
    return res.json(Object.assign({ success: true }, verifyIntegrity(rec)));
  });

  // Страницы (статические файлы; ЛК не трогаем). /fdoc — алиас консоли для показа руководителям.
  app.get(["/esign", "/fdoc"], (req, res) => { res.set("Cache-Control", "no-store"); res.sendFile(path.join(__dirname, "public", "esign.html")); });
  app.get(["/esign/sign/:id", "/fdoc/sign/:id"], (req, res) => { res.set("Cache-Control", "no-store"); res.sendFile(path.join(__dirname, "public", "esign-sign.html")); });

  console.log("ESIGN: модуль ПЭП смонтирован (/esign и /fdoc, /api/esign/*) — не интегрирован в ЛК");
}

module.exports = { mount, createRequest, sendOtp, signWithCode, getRecord, verifyIntegrity, publicView, CONSENT_TEXT, CONSENT_VERSION };
