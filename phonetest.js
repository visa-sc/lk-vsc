// ─────────────────────────────────────────────────────────────────────────
// Проверка интеграций: телефония и формы сайтов (/phone_test).
// Задача Андрея 25.08.2026: раньше сотрудники руками обзванивали ~24 номера и
// оставляли заявки на двух сайтах, чтобы убедиться, что звонок/заявка доходят
// до amoCRM и источник проставляется верно. Теперь это делает сервис.
//
// Как проходит одна проверка НОМЕРА:
//  1. sms.ru «звонок с кодом» (метод code/call) звонит на наш номер с
//     постороннего номера из их пула — в точности то, что делает живой клиент.
//     Заранее известны последние 4 цифры звонящего (их sms.ru возвращает как
//     «код») — по ним и по нашему номеру потом однозначно опознаём запись в amo.
//  2. Ждём, пока связка OnlinePBX → amoCRM создаст контакт и сделку.
//  3. Сверяем источник: у контакта поля «Источник» и «Region», у сделки —
//     «Источник звонка» (для номеров 812 везде должно быть СПБ).
//  4. Удаляем СОЗДАННОЕ ЭТИМ ЗВОНКОМ и идём к следующему номеру.
//
// Проверка ФОРМЫ: заявка отправляется настоящим браузером (как человек),
// дальше — та же сверка в amoCRM и удаление.
//
// ⚠️ УДАЛЕНИЕ — САМОЕ ОПАСНОЕ МЕСТО. Требование Андрея: «не удалять лишнего,
// строго то, что создано нашим тестом». Поэтому предохранители многослойные:
//   • удаляем только id, найденные в ЭТОМ шаге проверки;
//   • контакт обязан содержать в имени/телефоне номер, с которого мы звонили
//     (его нам вернул sms.ru), И быть созданным в окне нашего звонка;
//   • сделка обязана быть привязана к этому контакту и создана в том же окне;
//   • жёсткие лимиты: не больше 1 контакта и 2 сделок за шаг, иначе — стоп и
//     пометка «нужна ручная проверка»;
//   • всё, что удаляется, сперва целиком записывается в журнал (можно восстановить);
//   • по умолчанию режим «без удаления» (dryRun) — включает удаление только Андрей.
//
// Расписание (понедельник 04:00 МСК) написано, но ВЫКЛЮЧЕНО до его команды.
// ─────────────────────────────────────────────────────────────────────────
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const axios = require("axios");

const DIR = path.join(__dirname, ".phonetest");
const STORE_FILE = path.join(DIR, "store.json");

// ── Поля amoCRM (найдены по API 25.08.2026) ──
const F_CONTACT_SOURCE = 571754;   // «Источник»: 1090888 СПБ, 1090890 Основной, 1095266 ЕКБ
const F_CONTACT_REGION = 577714;   // «Region»: 1097342 МСК, 1097344 СПБ, 1097346 ЕКБ, 1097348 Основной
const F_LEAD_CALL_SOURCE = 571454; // «Источник звонка»: значения совпадают с названиями номеров
const F_CONTACT_PHONE = 241342;    // «Телефон» (multitext)

const SRC_SPB = 1090888, SRC_MAIN = 1090890, SRC_EKB = 1095266;
const REG_MSK = 1097342, REG_SPB = 1097344, REG_EKB = 1097346, REG_MAIN = 1097348;

// Названия номеров в телефонии совпадают со значениями «Источник звонка» —
// сопоставляем автоматически, вручную ничего вбивать не нужно.
const CALL_SOURCE_ENUM = {
  spb: 1090414, instagram: 1090416, visa_sc: 1090418, "telegram_sip": 1090420,
  yd_rsy: 1090422, visa_gum: 1090424, msk: 1090426, vsc_site: 1090428,
  email: 1091280, vcru: 1091362, "2gis": 1091364, "ya.bz": 1091370,
  shengen: 1091526, france: 1091562, italy: 1091564, seo: 1091610, china: 1091698,
  spb_yb: 1092592, euro_hard: 1092792, "4test": 1092794, regions: 1092896,
  yb_auto: 1092944, spb_rsy: 1092966,
};

// Номера из личного кабинета телефонии (скриншоты Андрея 25.08.2026).
const DEFAULT_NUMBERS = [
  ["74953692046", "2gis"], ["74993254757", "4test"], ["74999385654", "card"],
  ["74993256474", "compare"], ["74999385075", "cyprus"], ["73432472237", "ekb"],
  ["73432472172", "ekb-yb"], ["74953691866", "email"], ["74953692049", "france"],
  ["74993257397", "italy"], ["74953691867", "MSK"], ["74999384377", "SEO"],
  ["74999384688", "shengen"], ["78122440468", "SPB"], ["78122373387", "spb-email"],
  ["78124673878", "spb_rsy"], ["78122408545", "SPB_yb"], ["74953694067", "telegram_sip"],
  ["78122200365", "vox_78122200365"], ["74993258683", "voyo"], ["74999385358", "vsc_site"],
  ["74953692048", "ya.bz"], ["74953691567", "YD_RSY"],
];

function isSpbPhone(p) { return /^7812/.test(String(p || "").replace(/\D/g, "")); }
function isEkbPhone(p) { return /^7343/.test(String(p || "").replace(/\D/g, "")); }
function defaultNumberConfig(phone, label) {
  const key = String(label || "").toLowerCase().replace(/-/g, "_");
  return {
    phone: String(phone).replace(/\D/g, ""),
    label,
    // Ожидаемый источник контакта: правило Андрея — 812 всегда СПБ.
    contactSource: isSpbPhone(phone) ? SRC_SPB : (isEkbPhone(phone) ? SRC_EKB : null),
    contactRegion: isSpbPhone(phone) ? REG_SPB : (isEkbPhone(phone) ? REG_EKB : null),
    // Ожидаемый «Источник звонка» сделки — по совпадению названия номера со
    // значением в amoCRM; где совпадения нет, просто фиксируем что пришло.
    callSource: CALL_SOURCE_ENUM[key] || null,
    enabled: true,
  };
}
const DEFAULT_FORMS = [
  { id: "visa-sc", label: "visa-sc.ru", url: "https://visa-sc.ru/", contactSource: null, contactRegion: null, enabled: true },
  { id: "spb", label: "spb.visa-sc.ru", url: "https://spb.visa-sc.ru/", contactSource: SRC_SPB, contactRegion: REG_SPB, enabled: true },
];

function ensureDir() { try { fs.mkdirSync(DIR, { recursive: true }); } catch (_) {} }
let _store = null;
function store() {
  if (_store) return _store;
  try { _store = JSON.parse(fs.readFileSync(STORE_FILE, "utf8")); } catch (_) { _store = null; }
  if (!_store || typeof _store !== "object") _store = {};
  if (!_store.config) _store.config = {};
  const c = _store.config;
  if (!Array.isArray(c.numbers) || !c.numbers.length) c.numbers = DEFAULT_NUMBERS.map(([p, l]) => defaultNumberConfig(p, l));
  if (!Array.isArray(c.forms) || !c.forms.length) c.forms = DEFAULT_FORMS.map((f) => Object.assign({}, f));
  if (typeof c.dryRun !== "boolean") c.dryRun = true;          // по умолчанию НИЧЕГО не удаляем
  if (typeof c.scheduleEnabled !== "boolean") c.scheduleEnabled = false; // и не запускаемся сами
  if (!c.scheduleHour) c.scheduleHour = 4;                      // понедельник, 04:00 МСК
  if (!c.waitSec) c.waitSec = 240;                              // сколько ждём появления в amo
  if (!c.testName) c.testName = "ТЕСТ ИНТЕГРАЦИИ";
  if (!c.testPhone) c.testPhone = "+79990000042";               // телефон для заявок с форм
  // Сверка (OnlinePBX и Flexbe против amoCRM): доступы вводятся на странице.
  if (!c.pbx || typeof c.pbx !== "object") c.pbx = { domain: "", key: "" };
  // URL из раздела Flexbe «Настройки → API» (скрин Андрея 31.08): /mod/api/
  const FLEXBE_DEFAULTS = [
    { id: "visa-sc", label: "visa-sc.ru", apiUrl: "https://visa-sc.ru/mod/api/", apiKey: "" },
    { id: "spb", label: "spb.visa-sc.ru", apiUrl: "https://spb.visa-sc.ru/mod/api/", apiKey: "" },
    { id: "ekb", label: "ekb.visa-sc.ru", apiUrl: "https://ekb.visa-sc.ru/mod/api/", apiKey: "" },
  ];
  if (!Array.isArray(c.flexbe)) c.flexbe = [];
  for (const d of FLEXBE_DEFAULTS) { // дозаполняем новые сайты в уже созданном конфиге
    if (!c.flexbe.find((x) => x.id === d.id)) c.flexbe.push(Object.assign({}, d));
  }
  if (!Array.isArray(_store.runs)) _store.runs = [];
  if (!Array.isArray(_store.recons)) _store.recons = [];
  if (!_store.reconDays || typeof _store.reconDays !== "object") _store.reconDays = {}; // итог сверки по дням (ночные прогоны)
  return _store;
}
function save() {
  ensureDir();
  try { fs.writeFileSync(STORE_FILE, JSON.stringify(store(), null, 1), "utf8"); }
  catch (e) { console.error("phonetest save:", e.message); }
}
function newId() { return crypto.randomBytes(6).toString("hex"); }
const digits = (s) => String(s || "").replace(/\D/g, "");
const last10 = (s) => digits(s).slice(-10);
const enumName = (map, id) => { for (const [k, v] of Object.entries(map)) if (v === id) return k; return String(id || "—"); };
const SRC_NAMES = { [SRC_SPB]: "СПБ", [SRC_MAIN]: "Основной", [SRC_EKB]: "ЕКБ", 1091298: "Инстаграм", 1095432: "НИЖНИЙ", 1096240: "Перевод" };
const REG_NAMES = { [REG_MSK]: "МСК", [REG_SPB]: "СПБ", [REG_EKB]: "ЕКБ", [REG_MAIN]: "Основной" };

function fieldValue(entity, fieldId) {
  const f = (entity && entity.custom_fields_values) || [];
  for (const x of f) if (Number(x.field_id) === fieldId) {
    const v = (x.values && x.values[0]) || {};
    return { value: v.value, enumId: v.enum_id != null ? Number(v.enum_id) : null };
  }
  return { value: null, enumId: null };
}
function contactPhones(contact) {
  const out = [];
  const f = (contact && contact.custom_fields_values) || [];
  for (const x of f) if (Number(x.field_id) === F_CONTACT_PHONE) for (const v of (x.values || [])) if (v && v.value) out.push(String(v.value));
  return out;
}

function mount(app, deps) {
  const { amoGet, amoPost, amoDelete, amoBg, amoBaseUrl, getStaffFromReq, sendMail } = deps;
  const SMS_API = () => process.env.SMS_RU_API_ID || "";

  function requirePT(req, res, next) {
    const s = getStaffFromReq && getStaffFromReq(req);
    if (s && s.role === "admin") { req.who = s.name || "админ"; return next(); }
    return res.status(401).json({ success: false, message: "Только для администратора" });
  }

  // ── Журнал ──────────────────────────────────────────────────────────────
  let current = null; // текущий прогон (в памяти, чтобы страница видела прогресс)
  function log(step, msg, extra) {
    if (!current) return;
    const rec = Object.assign({ at: Date.now(), step, msg }, extra || {});
    current.log.push(rec);
    if (current.log.length > 800) current.log.splice(0, current.log.length - 800);
    console.log("PHONETEST[" + step + "]:", msg);
  }

  // ── amoCRM: поиск созданного нашим тестом ───────────────────────────────
  // Ищем контакт по номеру звонившего/телефону заявки. Ключевое: контакт должен
  // быть создан в окне нашей проверки, иначе это чужой контакт — не трогаем.
  async function findContact(query, windowFrom, windowTo) {
    const base = amoBaseUrl();
    let data;
    try {
      data = await amoBg(() => amoGet(`${base}/api/v4/contacts`, { query, with: "leads", limit: 50 }));
    } catch (e) {
      if (e && e.response && e.response.status === 204) return [];
      throw e;
    }
    const list = (data && data._embedded && data._embedded.contacts) || [];
    return list.filter((c) => {
      const at = Number(c.created_at || 0) * 1000;
      return at >= windowFrom && at <= windowTo;
    });
  }
  async function leadById(id) {
    const base = amoBaseUrl();
    try { return await amoBg(() => amoGet(`${base}/api/v4/leads/${id}`, { with: "contacts" })); }
    catch (_) { return null; }
  }

  // ── Удаление: только то, что создали мы ────────────────────────────────
  // Возвращает {deleted, skipped, reason}. При малейшем сомнении НЕ удаляет.
  async function deleteCreated(ctx, contact, leads) {
    const cfg = store().config;
    const snapshot = {
      contact: { id: contact.id, name: contact.name, phones: contactPhones(contact), created_at: contact.created_at },
      leads: leads.map((l) => ({ id: l.id, name: l.name, created_at: l.created_at, price: l.price })),
    };
    // Предохранитель 1: количество.
    if (leads.length > 2) return { deleted: false, reason: "у контакта больше двух сделок — удаление отменено, проверьте вручную", snapshot };
    // Предохранитель 2: окно создания.
    const bad = [contact, ...leads].find((e) => {
      const at = Number(e.created_at || 0) * 1000;
      return !(at >= ctx.windowFrom && at <= ctx.windowTo);
    });
    if (bad) return { deleted: false, reason: "сущность создана вне окна проверки — удаление отменено", snapshot };
    // Предохранитель 3: контакт должен быть «нашим» — в имени/телефонах обязан
    // встречаться номер нашей проверки (для звонка это наш проверяемый номер,
    // который телефония пишет в имя контакта; для заявки — тестовый телефон).
    const hay = digits((contact.name || "") + " " + contactPhones(contact).join(" "));
    const marker = last10(ctx.marker || "");
    if (!marker || !hay.includes(marker)) {
      return { deleted: false, reason: "в контакте нет номера нашей проверки — удаление отменено", snapshot };
    }
    // Предохранитель 3б: для звонка дополнительно сверяем окончание номера,
    // с которого звонил sms.ru.
    if (ctx.tail && !hay.includes(ctx.tail)) {
      return { deleted: false, reason: "не совпало окончание номера звонившего (…" + ctx.tail + ") — удаление отменено", snapshot };
    }
    // Предохранитель 4: сделка должна быть привязана к этому контакту.
    for (const l of leads) {
      const cs = ((l._embedded && l._embedded.contacts) || []).map((x) => Number(x.id));
      if (cs.length && !cs.includes(Number(contact.id))) {
        return { deleted: false, reason: "сделка привязана к другому контакту — удаление отменено", snapshot };
      }
      if (cs.length > 1) return { deleted: false, reason: "в сделке несколько контактов — удаление отменено", snapshot };
    }
    // Предохранитель 5: режим без удаления.
    if (cfg.dryRun) return { deleted: false, dryRun: true, reason: "режим проверки без удаления — в amoCRM ничего не тронуто", snapshot };

    const base = amoBaseUrl();
    // Сначала сделки, потом контакт (иначе сделка останется без контакта).
    for (const l of leads) {
      await amoBg(() => amoDelete(`${base}/api/v4/leads`, [{ id: Number(l.id) }]));
      log(ctx.step, "удалена сделка " + l.id + " «" + (l.name || "") + "»");
    }
    await amoBg(() => amoDelete(`${base}/api/v4/contacts`, [{ id: Number(contact.id) }]));
    log(ctx.step, "удалён контакт " + contact.id + " «" + (contact.name || "") + "»");
    return { deleted: true, snapshot };
  }

  // ── Сверка источника ───────────────────────────────────────────────────
  function checkSources(item, contact, leads) {
    const problems = [];
    const got = {
      contactSource: fieldValue(contact, F_CONTACT_SOURCE).enumId,
      contactRegion: fieldValue(contact, F_CONTACT_REGION).enumId,
      leadCallSource: leads.length ? fieldValue(leads[0], F_LEAD_CALL_SOURCE).enumId : null,
    };
    if (item.contactSource && got.contactSource !== item.contactSource) {
      problems.push("«Источник» контакта: ожидали " + (SRC_NAMES[item.contactSource] || item.contactSource) +
        ", получили " + (SRC_NAMES[got.contactSource] || "пусто"));
    }
    if (item.contactRegion && got.contactRegion !== item.contactRegion) {
      problems.push("«Region» контакта: ожидали " + (REG_NAMES[item.contactRegion] || item.contactRegion) +
        ", получили " + (REG_NAMES[got.contactRegion] || "пусто"));
    }
    if (item.callSource && got.leadCallSource !== item.callSource) {
      problems.push("«Источник звонка» сделки: ожидали " + enumName(CALL_SOURCE_ENUM, item.callSource) +
        ", получили " + (got.leadCallSource ? enumName(CALL_SOURCE_ENUM, got.leadCallSource) : "пусто"));
    }
    return { got, problems };
  }

  // ── Ожидание появления в amoCRM ────────────────────────────────────────
  async function waitForAmo(ctx, query) {
    const cfg = store().config;
    const deadline = Date.now() + cfg.waitSec * 1000;
    let attempt = 0;
    while (Date.now() < deadline) {
      attempt++;
      let found = await findContact(query, ctx.windowFrom, ctx.windowTo);
      // Если знаем последние цифры звонившего — оставляем только совпадающие.
      if (ctx.tail && found.length > 1) {
        const strict = found.filter((c) => digits((c.name || "") + " " + contactPhones(c).join(" ")).includes(ctx.tail));
        if (strict.length) found = strict;
      }
      if (found.length === 1) {
        const c = found[0];
        const leadIds = ((c._embedded && c._embedded.leads) || []).map((l) => l.id);
        const leads = [];
        for (const id of leadIds) { const l = await leadById(id); if (l) leads.push(l); }
        return { contact: c, leads, attempts: attempt };
      }
      if (found.length > 1) return { many: found.length, attempts: attempt };
      await new Promise((r) => setTimeout(r, 15000));
    }
    return { none: true, attempts: attempt };
  }

  // ── Проверка одного номера ─────────────────────────────────────────────
  async function testNumber(item) {
    const step = "номер " + item.phone + " (" + item.label + ")";
    const res = { kind: "number", phone: item.phone, label: item.label, at: Date.now(), ok: false };
    if (!SMS_API()) { res.error = "не задан SMS_RU_API_ID"; return res; }
    const t0 = Date.now();
    log(step, "звоню на " + item.phone);
    let call;
    try {
      // code/call — sms.ru звонит на указанный номер с номера из своего пула и
      // сбрасывает; «код» в ответе = последние 4 цифры звонившего.
      const r = await axios.get("https://sms.ru/code/call", {
        params: { api_id: SMS_API(), phone: item.phone, json: 1 }, timeout: 30000,
      });
      call = r.data;
    } catch (e) { res.error = "sms.ru не ответил: " + e.message; return res; }
    if (!call || call.status !== "OK") {
      res.error = "sms.ru отказал: " + ((call && (call.status_text || call.status_code)) || "нет ответа");
      return res;
    }
    const code = String(call.code || "").replace(/\D/g, "");
    res.callerTail = code;
    res.callId = call.call_id || null;
    res.cost = call.cost != null ? call.cost : null;
    log(step, "звонок ушёл, звонит номер с окончанием …" + code + (res.cost != null ? " (" + res.cost + " ₽)" : ""));

    const ctx = {
      step,
      windowFrom: t0 - 120000,
      windowTo: t0 + (store().config.waitSec + 180) * 1000,
      // Опознаём запись по НАШЕМУ номеру: телефония пишет его в имя контакта
      // («Пропущенный 79XXXXXXXXX (74953691867 - MSK)»), плюс сверяем окончание
      // номера звонившего.
      marker: item.phone,
      tail: code,
    };
    const found = await waitForAmo(ctx, item.phone);
    res.attempts = found.attempts;
    if (found.none) { res.error = "в amoCRM за " + store().config.waitSec + " сек не появился контакт от этого звонка"; return res; }
    if (found.many) { res.error = "нашлось несколько подходящих контактов (" + found.many + ") — ничего не трогаю, нужна ручная проверка"; return res; }

    const { contact, leads } = found;
    res.contact = { id: contact.id, name: contact.name };
    res.leads = leads.map((l) => ({ id: l.id, name: l.name }));
    log(step, "в amoCRM создан контакт " + contact.id + " «" + contact.name + "», сделок: " + leads.length);
    if (!leads.length) res.warnings = ["контакт создан, а сделки нет"];

    const chk = checkSources(item, contact, leads);
    res.got = chk.got;
    res.problems = chk.problems;
    const del = await deleteCreated(ctx, contact, leads);
    res.deleted = del.deleted;
    res.deleteReason = del.reason || null;
    res.snapshot = del.snapshot;
    res.ok = !!leads.length && !chk.problems.length;
    return res;
  }

  // ── Проверка формы (браузером, как человек) ────────────────────────────
  // Chromium на проде лежит не в стандартном кеше puppeteer, а в
  // /var/www/voyo/.chrome — находим бинарь сами.
  function findChrome() {
    const root = path.join(__dirname, ".chrome", "chrome");
    try {
      for (const ver of fs.readdirSync(root)) {
        const p = path.join(root, ver, "chrome-linux64", "chrome");
        if (fs.existsSync(p)) return p;
      }
    } catch (_) {}
    return null;
  }
  async function submitForm(form, cfg) {
    let puppeteer;
    try { puppeteer = require("puppeteer"); }
    catch (_) { throw new Error("на сервере не установлен puppeteer — заявку отправить нечем"); }
    const chromePath = findChrome();
    const browser = await puppeteer.launch({
      headless: true,
      executablePath: chromePath || undefined,
      args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
    });
    try {
      const page = await browser.newPage();
      await page.setViewport({ width: 1280, height: 900 });
      // На сайтах стоит антибот botfaqtor: его iframe создаются и умирают прямо
      // во время загрузки, из-за чего page.goto может ЛОЖНО упасть с «frame was
      // detached» (гонка в puppeteer), хотя страница загружается нормально.
      // Такую ошибку глотаем и просто ждём поле телефона поллингом.
      try {
        await page.goto(form.url, { waitUntil: "domcontentloaded", timeout: 90000 });
      } catch (e) {
        if (!/frame was detached|detached Frame/i.test(String(e.message || ""))) throw e;
      }
      const readyBy = Date.now() + 45000;
      let ready = false;
      while (Date.now() < readyBy && !ready) {
        try {
          ready = await page.evaluate(() => !!document.querySelector('input[type=tel], input[data-check=phone]'));
        } catch (_) {}
        if (!ready) await new Promise((r) => setTimeout(r, 1500));
      }
      if (!ready) throw new Error("поле телефона так и не появилось на странице");
      await new Promise((r) => setTimeout(r, 3000)); // скриптам сайта — дозагрузиться
      // Ищем первую форму, где есть поле телефона, и заполняем её как человек.
      const filled = await page.evaluate((name, phone) => {
        const forms = Array.from(document.querySelectorAll("form"));
        for (const f of forms) {
          const tel = f.querySelector('input[type=tel], input[data-check=phone]');
          if (!tel) continue;
          const rect = f.getBoundingClientRect();
          if (!rect.width || !rect.height) continue; // невидимая форма
          const setVal = (el, v) => {
            const proto = Object.getPrototypeOf(el);
            const d = Object.getOwnPropertyDescriptor(proto, "value");
            d.set.call(el, v);
            el.dispatchEvent(new Event("input", { bubbles: true }));
            el.dispatchEvent(new Event("change", { bubbles: true }));
          };
          const nm = f.querySelector('input[data-check=name], input[type=text]');
          if (nm) setVal(nm, name);
          setVal(tel, phone);
          const ta = f.querySelector("textarea:not([style*='display:none'])");
          if (ta) setVal(ta, "Автопроверка интеграции, заявку можно удалить");
          f.scrollIntoView({ block: "center" });
          f.setAttribute("data-autotest", "1");
          return true;
        }
        return false;
      }, cfg.testName, cfg.testPhone);
      if (!filled) throw new Error("на странице не нашлось формы с полем телефона");
      await new Promise((r) => setTimeout(r, 1200));
      const submitted = await page.evaluate(() => {
        const f = document.querySelector('form[data-autotest="1"]');
        if (!f) return false;
        const btn = f.querySelector('button[type=submit], input[type=submit], button:not([type]), .form-button, [data-component=button]');
        if (btn) { btn.click(); return true; }
        f.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
        return true;
      });
      if (!submitted) throw new Error("не нашлась кнопка отправки");
      await new Promise((r) => setTimeout(r, 8000));
      return { url: page.url() };
    } finally { await browser.close().catch(() => {}); }
  }

  async function testForm(form) {
    const cfg = store().config;
    const step = "форма " + form.label;
    const res = { kind: "form", id: form.id, label: form.label, url: form.url, at: Date.now(), ok: false };
    const t0 = Date.now();
    log(step, "открываю сайт и отправляю заявку");
    // Гонки puppeteer с iframe антибота лечатся повтором — до 3 попыток.
    let sent = false, lastErr = null;
    for (let attempt = 1; attempt <= 3 && !sent; attempt++) {
      try { await submitForm(form, cfg); sent = true; }
      catch (e) {
        lastErr = e;
        const transient = /frame was detached|detached Frame|Target closed|Protocol error/i.test(String(e.message || ""));
        if (!transient || attempt === 3) break;
        log(step, "попытка " + attempt + " сорвалась (" + e.message + ") — пробую ещё раз");
        await new Promise((r) => setTimeout(r, 3000));
      }
    }
    if (!sent) { res.error = "заявку отправить не удалось: " + lastErr.message; return res; }
    log(step, "заявка отправлена, жду появления в amoCRM");
    const ctx = { step, windowFrom: t0 - 120000, windowTo: t0 + (cfg.waitSec + 180) * 1000, marker: cfg.testPhone };
    const found = await waitForAmo(ctx, last10(cfg.testPhone));
    res.attempts = found.attempts;
    if (found.none) { res.error = "в amoCRM за " + cfg.waitSec + " сек не появился контакт по заявке"; return res; }
    if (found.many) { res.error = "нашлось несколько подходящих контактов — ничего не трогаю, нужна ручная проверка"; return res; }
    const { contact, leads } = found;
    res.contact = { id: contact.id, name: contact.name };
    res.leads = leads.map((l) => ({ id: l.id, name: l.name }));
    const chk = checkSources(form, contact, leads);
    res.got = chk.got;
    res.problems = chk.problems;
    const del = await deleteCreated(ctx, contact, leads);
    res.deleted = del.deleted;
    res.deleteReason = del.reason || null;
    res.snapshot = del.snapshot;
    res.ok = !!leads.length && !chk.problems.length;
    return res;
  }

  // ── Полный прогон ──────────────────────────────────────────────────────
  let running = false;
  async function runAll(opts) {
    if (running) throw new Error("проверка уже идёт");
    running = true;
    const cfg = store().config;
    const only = (opts && opts.only) || null; // можно прогнать один номер/форму
    current = { id: newId(), startedAt: Date.now(), by: (opts && opts.by) || "", dryRun: cfg.dryRun, log: [], results: [], finishedAt: null };
    try {
      const numbers = cfg.numbers.filter((n) => n.enabled !== false && (!only || only === n.phone));
      const forms = cfg.forms.filter((f) => f.enabled !== false && (!only || only === f.id));
      log("старт", "проверок: номеров " + numbers.length + ", форм " + forms.length + (cfg.dryRun ? " · режим без удаления" : " · с удалением тестовых записей"));
      for (const n of numbers) {
        const r = await testNumber(n).catch((e) => ({ kind: "number", phone: n.phone, label: n.label, at: Date.now(), ok: false, error: String((e && e.message) || e) }));
        current.results.push(r);
        save2run();
        await new Promise((r2) => setTimeout(r2, 5000)); // пауза между номерами
      }
      for (const f of forms) {
        const r = await testForm(f).catch((e) => ({ kind: "form", id: f.id, label: f.label, at: Date.now(), ok: false, error: String((e && e.message) || e) }));
        current.results.push(r);
        save2run();
      }
      current.finishedAt = Date.now();
      log("итог", "готово: успешно " + current.results.filter((r) => r.ok).length + " из " + current.results.length);
      save2run();
      const bad = current.results.filter((r) => !r.ok);
      if (bad.length && (opts && opts.notify)) {
        const lines = bad.map((r) => "• " + (r.label || r.phone || r.id) + ": " + (r.error || (r.problems || []).join("; ") || "не создалась сделка"));
        sendMail({
          to: process.env.PHONETEST_ALERT_EMAIL || "director@visa-sc.ru",
          subject: "Проверка интеграций: проблемы (" + bad.length + " из " + current.results.length + ")",
          text: "Ночная проверка номеров и форм нашла проблемы:\n\n" + lines.join("\n") +
            "\n\nПодробности: https://voyotravel.ru/phone_test",
        }).catch(() => {});
      }
      return current;
    } finally { running = false; }
  }
  function save2run() {
    const st = store();
    const i = st.runs.findIndex((r) => r.id === current.id);
    const copy = JSON.parse(JSON.stringify(current));
    if (i >= 0) st.runs[i] = copy; else st.runs.push(copy);
    if (st.runs.length > 60) st.runs.splice(0, st.runs.length - 60);
    save();
  }

  // ── Расписание: понедельник 04:00 МСК (по умолчанию ВЫКЛЮЧЕНО) ─────────
  function scheduleNext() {
    const cfg = store().config;
    const msk = new Date(Date.now() + 3 * 3600 * 1000);
    const day = msk.getUTCDay(); // 1 = понедельник
    let daysAhead = (1 - day + 7) % 7;
    const target = new Date(msk);
    target.setUTCDate(msk.getUTCDate() + daysAhead);
    target.setUTCHours(cfg.scheduleHour, 0, 0, 0);
    let delay = target.getTime() - msk.getTime();
    if (delay <= 60000) delay += 7 * 24 * 3600000;
    setTimeout(() => {
      const c = store().config;
      if (c.scheduleEnabled) {
        console.log("PHONETEST: плановый запуск (понедельник " + c.scheduleHour + ":00 МСК)");
        runAll({ by: "расписание", notify: true }).catch((e) => console.error("phonetest cron:", e.message));
      }
      scheduleNext();
    }, delay);
    return delay;
  }

  // ── Сверка за период: OnlinePBX и Flexbe ↔ amoCRM ──────────────────────
  // Пассивная проверка (задача Андрея 26.08): каждый номер, с которого был
  // входящий звонок, и каждая заявка из Flexbe должны существовать в amoCRM
  // контактом. Ничего не создаём и не удаляем — только читаем и сравниваем.
  let reconRunning = false;
  let reconCurrent = null;
  function rlog(msg) {
    if (!reconCurrent) return;
    reconCurrent.log.push({ at: Date.now(), msg });
    if (reconCurrent.log.length > 400) reconCurrent.log.splice(0, reconCurrent.log.length - 400);
    console.log("PHONETEST-RECON:", msg);
  }

  // Входящие звонки из OnlinePBX. Авторизация двухшаговая: auth_key меняем на
  // временные key_id/key, ими подписываем запрос истории.
  async function pbxCalls(pbx, fromTs, toTs) {
    const dom = String(pbx.domain || "").trim();
    const form = (o) => new URLSearchParams(o).toString();
    const FH = { "Content-Type": "application/x-www-form-urlencoded" };
    const auth = await axios.post(
      "https://api.onlinepbx.ru/" + dom + "/auth.json",
      form({ auth_key: String(pbx.key || "").trim(), new: "true" }),
      { headers: FH, timeout: 30000 }
    );
    const a = auth.data;
    if (!a || String(a.status) !== "1" || !a.data || !a.data.key_id) {
      throw new Error("OnlinePBX не принял ключ: " + JSON.stringify(a).slice(0, 200));
    }
    const r = await axios.post(
      "https://api.onlinepbx.ru/" + dom + "/mongo_history/search.json",
      form({ start_stamp_from: String(Math.floor(fromTs / 1000)), start_stamp_to: String(Math.floor(toTs / 1000)) }),
      { headers: Object.assign({ "x-pbx-authentication": a.data.key_id + ":" + a.data.key }, FH), timeout: 60000 }
    );
    const d = r.data;
    if (!d || String(d.status) !== "1") throw new Error("OnlinePBX не отдал историю: " + JSON.stringify(d).slice(0, 200));
    let rows = d.data;
    if (rows && !Array.isArray(rows)) rows = rows.list || rows.rows || rows.items || [];
    if (!Array.isArray(rows)) rows = [];
    const calls = [];
    for (const row of rows) {
      const dir = String(row.accountcode || row.direction || "").toLowerCase();
      if (dir && dir.indexOf("inbound") === -1) continue; // явно не входящий
      const caller = digits(row.caller_id_number || row.caller || row.from || "");
      const callee = digits(row.destination_number || row.callee || row.to || "");
      const ts = Number(row.start_stamp || row.start || 0) * 1000;
      if (caller.length < 10) continue; // внутренние и скрытые номера
      calls.push({ caller, callee, ts });
    }
    if (rows.length && !calls.length) {
      rlog("историю получил (" + rows.length + " записей), но входящих не распознал; поля записи: " + Object.keys(rows[0] || {}).join(", "));
    }
    return calls;
  }

  // Заявки из Flexbe. Формат их API уточняется при первом живом ключе, поэтому
  // разбор терпимый: ищем массив в ответе и телефон в полях каждой записи.
  function parseAnyTs(v) {
    if (v == null) return null;
    if (typeof v === "number") return v > 1e12 ? v : v * 1000;
    const t = Date.parse(String(v).replace(" ", "T"));
    return isNaN(t) ? null : t;
  }
  function digDeep(obj, test, depth) {
    if (depth > 3 || obj == null) return null;
    if (typeof obj === "string" || typeof obj === "number") return test(String(obj)) ? String(obj) : null;
    if (typeof obj !== "object") return null;
    for (const k of Object.keys(obj)) {
      const r = digDeep(obj[k], test, depth + 1);
      if (r) return r;
    }
    return null;
  }
  // Flexbe getLeads (формат выяснен по живому API 31.08): data.leads — ОБЪЕКТ
  // id→заявка; телефон в client.phone, время в time (unix, сек), имя в client.name.
  // До 1000 заявок за запрос, сортировка от новых к старым — за сутки хватает.
  async function flexbeFetch(site, fromTs, toTs) {
    const r = await axios.get(site.apiUrl, {
      params: { api_key: site.apiKey, method: "getLeads", count: 500 },
      timeout: 30000, validateStatus: () => true,
    });
    if (r.status !== 200) throw new Error("HTTP " + r.status + ": " + JSON.stringify(r.data).slice(0, 200));
    if (r.data && r.data.error) throw new Error("Flexbe: " + JSON.stringify(r.data.error).slice(0, 200));
    let leads = r.data && r.data.data && r.data.data.leads;
    if (leads && !Array.isArray(leads)) leads = Object.values(leads);
    if (!Array.isArray(leads)) throw new Error("не понял формат ответа Flexbe: " + JSON.stringify(r.data).slice(0, 250));
    const out = [];
    for (const it of leads) {
      const phone = digits((it.client && it.client.phone) || it.phone || "");
      if (phone.length < 10) continue;
      const ts = it.time ? Number(it.time) * 1000 : parseAnyTs(it.created_at || it.date || null);
      if (ts != null && (ts < fromTs || ts > toTs)) continue;
      out.push({ phone, name: (it.client && it.client.name) || it.name || null, ts, num: it.num || null });
    }
    return out;
  }

  async function amoFindByPhone(num) {
    const base = amoBaseUrl();
    try {
      const data = await amoBg(() => amoGet(base + "/api/v4/contacts", { query: last10(num), limit: 10 }));
      return ((data && data._embedded && data._embedded.contacts) || []).map((c) => ({ id: c.id, name: c.name }));
    } catch (e) {
      if (e && e.response && e.response.status === 204) return [];
      throw e;
    }
  }

  const mskDayStr = (ts) => new Date(ts + 3 * 3600000).toISOString().slice(0, 10);
  async function runRecon(opts) {
    if (reconRunning) throw new Error("сверка уже идёт");
    reconRunning = true;
    const cfg = store().config;
    const hours = Math.min(168, Math.max(1, Number((opts && opts.hours) || 24)));
    // Ночной режим: окно — ПОЛНЫЕ прошедшие сутки по МСК (просьба Андрея 31.08),
    // итог записывается в дневную историю reconDays.
    let fromTs, toTs, dayStr = null;
    if (opts && opts.day === "yesterday") {
      const DAY = 86400000;
      const todayMsk0 = Math.floor((Date.now() + 3 * 3600000) / DAY) * DAY - 3 * 3600000; // полночь МСК
      fromTs = todayMsk0 - DAY; toTs = todayMsk0; dayStr = mskDayStr(fromTs);
    } else {
      toTs = Date.now(); fromTs = toTs - hours * 3600000;
    }
    reconCurrent = { id: newId(), startedAt: Date.now(), hours: dayStr ? 24 : hours, day: dayStr, by: (opts && opts.by) || "", log: [], pbx: null, forms: [], summary: null, finishedAt: null };
    try {
      const ourPhones = new Set(cfg.numbers.map((n) => last10(n.phone)));
      // 1) Звонки OnlinePBX
      if (cfg.pbx && cfg.pbx.domain && cfg.pbx.key) {
        try {
          rlog("запрашиваю входящие OnlinePBX за " + hours + " ч");
          const calls = await pbxCalls(cfg.pbx, fromTs, toTs);
          const uniq = new Map();
          for (const c of calls) {
            const k = last10(c.caller);
            if (ourPhones.has(k)) continue; // наши собственные номера
            const u = uniq.get(k) || { phone: c.caller, count: 0, firstAt: c.ts, lastAt: c.ts, to: c.callee };
            u.count++;
            if (c.ts) { u.firstAt = Math.min(u.firstAt || c.ts, c.ts); u.lastAt = Math.max(u.lastAt || 0, c.ts); }
            uniq.set(k, u);
          }
          rlog("входящих звонков: " + calls.length + ", уникальных внешних номеров: " + uniq.size);
          const missing = [];
          let checked = 0, foundN = 0;
          for (const [k, u] of uniq) {
            const contacts = await amoFindByPhone(k);
            checked++;
            if (contacts.length) foundN++;
            else missing.push(u);
            if (checked % 25 === 0) rlog("сверено с amoCRM: " + checked + " из " + uniq.size);
            await new Promise((r) => setTimeout(r, 150));
          }
          reconCurrent.pbx = { calls: calls.length, unique: uniq.size, found: foundN, missing };
          rlog("звонки: найдено в amoCRM " + foundN + " из " + uniq.size + (missing.length ? ", ПРОПАЛО: " + missing.length : ""));
        } catch (e) {
          reconCurrent.pbx = { error: String((e && e.message) || e) };
          rlog("OnlinePBX: " + reconCurrent.pbx.error);
        }
      } else {
        reconCurrent.pbx = { skipped: "не заданы домен и ключ OnlinePBX" };
        rlog("звонки пропущены: нет доступов OnlinePBX");
      }
      // 2) Заявки Flexbe по сайтам
      for (const site of cfg.flexbe || []) {
        const fr = { id: site.id, label: site.label };
        if (!site.apiKey || !site.apiUrl) {
          fr.skipped = "нет ключа API";
          rlog("форма " + site.label + " пропущена: нет ключа");
          reconCurrent.forms.push(fr);
          continue;
        }
        try {
          rlog("запрашиваю заявки " + site.label);
          const leads = await flexbeFetch(site, fromTs, toTs);
          const missing = [];
          let foundN = 0;
          for (const l of leads) {
            const contacts = await amoFindByPhone(l.phone);
            if (contacts.length) foundN++;
            else missing.push(l);
            await new Promise((r) => setTimeout(r, 150));
          }
          fr.leads = leads.length; fr.found = foundN; fr.missing = missing;
          rlog(site.label + ": заявок " + leads.length + ", в amoCRM " + foundN + (missing.length ? ", ПРОПАЛО: " + missing.length : ""));
        } catch (e) {
          fr.error = String((e && e.message) || e);
          rlog(site.label + ": " + fr.error);
        }
        reconCurrent.forms.push(fr);
      }
      const p = reconCurrent.pbx || {};
      reconCurrent.summary = {
        calls: p.calls || 0, unique: p.unique || 0, found: p.found || 0,
        callsMissing: (p.missing && p.missing.length) || 0,
        formsLeads: reconCurrent.forms.reduce((n, f) => n + (f.leads || 0), 0),
        formsMissing: reconCurrent.forms.reduce((n, f) => n + ((f.missing && f.missing.length) || 0), 0),
        // Разбивка по сайтам — для строк истории в блоке /vsc («Заявки МСК: 10/10»).
        forms: reconCurrent.forms.map((f) => ({
          id: f.id, label: f.label, leads: f.leads || 0, found: f.found || 0,
          miss: (f.missing && f.missing.length) || 0, error: !!f.error, skipped: !!f.skipped,
        })),
        errors: [p.error].concat(reconCurrent.forms.map((f) => f.error)).filter(Boolean).length,
        skipped: [p.skipped].concat(reconCurrent.forms.map((f) => f.skipped)).filter(Boolean).length,
      };
      reconCurrent.finishedAt = Date.now();
      rlog("сверка завершена");
      const st = store();
      st.recons.push(JSON.parse(JSON.stringify(reconCurrent)));
      if (st.recons.length > 30) st.recons.splice(0, st.recons.length - 30);
      if (reconCurrent.day) { // дневная история для блока в /vsc (копится с первой ночи)
        st.reconDays[reconCurrent.day] = Object.assign({ at: reconCurrent.finishedAt }, reconCurrent.summary);
        const keys = Object.keys(st.reconDays).sort();
        while (keys.length > 40) delete st.reconDays[keys.shift()];
      }
      save();
      return reconCurrent;
    } finally { reconRunning = false; }
  }

  // ── API ────────────────────────────────────────────────────────────────
  app.get("/phone_test", (req, res) => {
    res.set("Cache-Control", "no-store, no-cache, must-revalidate");
    res.sendFile(path.join(__dirname, "public", "phone_test.html"));
  });

  app.get("/phone_test/api/state", requirePT, (req, res) => {
    const st = store();
    res.json({
      success: true,
      config: st.config,
      running,
      current: current && !current.finishedAt ? current : null,
      lastRun: st.runs.length ? st.runs[st.runs.length - 1] : null,
      runs: st.runs.slice(-20).reverse().map((r) => ({
        id: r.id, startedAt: r.startedAt, finishedAt: r.finishedAt, by: r.by, dryRun: r.dryRun,
        total: r.results.length, ok: r.results.filter((x) => x.ok).length,
      })),
      dict: { sources: SRC_NAMES, regions: REG_NAMES, callSources: CALL_SOURCE_ENUM },
      smsReady: !!SMS_API(),
      recon: {
        running: reconRunning,
        current: reconCurrent && !reconCurrent.finishedAt ? reconCurrent : null,
        last: (st.recons && st.recons.length) ? st.recons[st.recons.length - 1] : null,
        history: (st.recons || []).slice(-15).reverse().map((r) => ({
          id: r.id, startedAt: r.startedAt, finishedAt: r.finishedAt, hours: r.hours, by: r.by, summary: r.summary,
        })),
        config: {
          pbxDomain: (st.config.pbx && st.config.pbx.domain) || "",
          pbxKeySet: !!(st.config.pbx && st.config.pbx.key),
          flexbe: (st.config.flexbe || []).map((f) => ({ id: f.id, label: f.label, apiUrl: f.apiUrl || "", apiKeySet: !!f.apiKey })),
        },
      },
    });
  });

  app.get("/phone_test/api/recon/:id", requirePT, (req, res) => {
    const r = store().recons.find((x) => x.id === req.params.id);
    if (!r) return res.status(404).json({ success: false, message: "Сверка не найдена" });
    res.json({ success: true, recon: r });
  });

  app.post("/phone_test/api/recon", requirePT, (req, res) => {
    if (reconRunning) return res.status(409).json({ success: false, message: "Сверка уже идёт" });
    const hours = Number((req.body && req.body.hours) || 24);
    runRecon({ hours, by: req.who }).catch((e) => console.error("phonetest recon:", e.message));
    res.json({ success: true, started: true });
  });

  // Доступы сверки. Ключи наружу не отдаются (в state только «задан/не задан»);
  // пустое значение в запросе значит «оставить как есть».
  app.post("/phone_test/api/recon-config", requirePT, (req, res) => {
    const b = req.body || {};
    const c = store().config;
    if (typeof b.pbxDomain === "string") c.pbx.domain = b.pbxDomain.trim().slice(0, 120);
    if (typeof b.pbxKey === "string" && b.pbxKey.trim()) c.pbx.key = b.pbxKey.trim().slice(0, 240);
    if (Array.isArray(b.flexbe)) {
      for (const f of b.flexbe) {
        const cur = c.flexbe.find((x) => x.id === f.id);
        if (!cur) continue;
        if (typeof f.apiUrl === "string" && f.apiUrl.trim()) cur.apiUrl = f.apiUrl.trim().slice(0, 300);
        if (typeof f.apiKey === "string" && f.apiKey.trim()) cur.apiKey = f.apiKey.trim().slice(0, 240);
      }
    }
    save();
    res.json({ success: true });
  });

  app.get("/phone_test/api/run/:id", requirePT, (req, res) => {
    const r = store().runs.find((x) => x.id === req.params.id);
    if (!r) return res.status(404).json({ success: false, message: "Прогон не найден" });
    res.json({ success: true, run: r });
  });

  app.post("/phone_test/api/run", requirePT, (req, res) => {
    if (running) return res.status(409).json({ success: false, message: "Проверка уже идёт" });
    const only = String((req.body && req.body.only) || "") || null;
    runAll({ by: req.who, only, notify: false }).catch((e) => console.error("phonetest run:", e.message));
    res.json({ success: true, started: true });
  });

  app.post("/phone_test/api/config", requirePT, (req, res) => {
    const b = req.body || {};
    const c = store().config;
    if (typeof b.dryRun === "boolean") c.dryRun = b.dryRun;
    if (typeof b.scheduleEnabled === "boolean") c.scheduleEnabled = b.scheduleEnabled;
    if (b.waitSec) c.waitSec = Math.min(900, Math.max(30, Number(b.waitSec) || 240));
    if (b.testPhone) c.testPhone = String(b.testPhone).slice(0, 20);
    if (b.testName) c.testName = String(b.testName).slice(0, 60);
    if (Array.isArray(b.numbers)) {
      for (const n of b.numbers) {
        const cur = c.numbers.find((x) => x.phone === digits(n.phone));
        if (!cur) continue;
        if (typeof n.enabled === "boolean") cur.enabled = n.enabled;
        if ("contactSource" in n) cur.contactSource = n.contactSource ? Number(n.contactSource) : null;
        if ("contactRegion" in n) cur.contactRegion = n.contactRegion ? Number(n.contactRegion) : null;
        if ("callSource" in n) cur.callSource = n.callSource ? Number(n.callSource) : null;
      }
    }
    if (Array.isArray(b.forms)) {
      for (const f of b.forms) {
        const cur = c.forms.find((x) => x.id === f.id);
        if (!cur) continue;
        if (typeof f.enabled === "boolean") cur.enabled = f.enabled;
        if (f.url) cur.url = String(f.url).slice(0, 200);
        if ("contactSource" in f) cur.contactSource = f.contactSource ? Number(f.contactSource) : null;
        if ("contactRegion" in f) cur.contactRegion = f.contactRegion ? Number(f.contactRegion) : null;
      }
    }
    save();
    res.json({ success: true, config: c });
  });

  // Ночная сверка за полные прошедшие сутки — 04:30 МСК ежедневно (просьба
  // Андрея 31.08: «сверку делай ночью»). Не пересекается с ночными съёмами amo
  // (00:00/00:30) и сторожами (03:30/03:40); из amo только чтение фоном.
  function scheduleReconNightly() {
    const msk = new Date(Date.now() + 3 * 3600 * 1000);
    let ms = ((((4 - msk.getUTCHours() + 24) % 24) * 60 + (30 - msk.getUTCMinutes())) * 60 - msk.getUTCSeconds()) * 1000;
    if (ms <= 0) ms += 24 * 3600000;
    setTimeout(() => {
      runRecon({ day: "yesterday", by: "ночное расписание" }).catch((e) => console.error("phonetest night recon:", e.message));
      scheduleReconNightly();
    }, ms);
    return ms;
  }
  const reconDelay = scheduleReconNightly();
  console.log("PHONETEST: ночная сверка контактов в 04:30 МСК (ближайшая через " + Math.round(reconDelay / 3600000) + " ч)");

  const delay = scheduleNext();
  console.log("PHONETEST: страница /phone_test готова; расписание " +
    (store().config.scheduleEnabled ? "ВКЛЮЧЕНО" : "выключено") +
    " (ближайший понедельник через " + Math.round(delay / 3600000) + " ч), удаление " +
    (store().config.dryRun ? "ВЫКЛЮЧЕНО (режим проверки)" : "включено"));
}

// Краткая сводка последней сверки — для блока в /vsc «Ежемесячный контроль».
function reconSummary() {
  const st = store();
  const configured = !!(st.config.pbx && st.config.pbx.key) || (st.config.flexbe || []).some((f) => f.apiKey);
  const days = Object.keys(st.reconDays || {}).sort().reverse().slice(0, 30)
    .map((d) => Object.assign({ day: d }, st.reconDays[d]));
  const r = (st.recons && st.recons.length) ? st.recons[st.recons.length - 1] : null;
  if (!r) return { configured, last: null, days };
  const p = r.pbx || {};
  const slim = (m) => ({ phone: m.phone, count: m.count || null, at: m.lastAt || m.ts || null });
  return {
    configured,
    days,
    last: {
      at: r.startedAt, hours: r.hours, day: r.day || null,
      pbx: p.error ? { error: p.error } : p.skipped ? { skipped: p.skipped }
        : { calls: p.calls || 0, unique: p.unique || 0, found: p.found || 0, missing: (p.missing || []).slice(0, 20).map(slim) },
      forms: (r.forms || []).map((f) => f.error ? { id: f.id, label: f.label, error: f.error }
        : f.skipped ? { id: f.id, label: f.label, skipped: f.skipped }
        : { id: f.id, label: f.label, leads: f.leads || 0, found: f.found || 0, missing: (f.missing || []).slice(0, 20).map(slim) }),
    },
  };
}

module.exports = { mount, CALL_SOURCE_ENUM, defaultNumberConfig, reconSummary };
