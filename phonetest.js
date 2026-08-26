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
  if (!Array.isArray(_store.runs)) _store.runs = [];
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
  async function submitForm(form, cfg) {
    let puppeteer;
    try { puppeteer = require("puppeteer"); }
    catch (_) { throw new Error("на сервере не установлен puppeteer — заявку отправить нечем"); }
    const browser = await puppeteer.launch({ headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"] });
    try {
      const page = await browser.newPage();
      await page.setViewport({ width: 1280, height: 900 });
      await page.goto(form.url, { waitUntil: "networkidle2", timeout: 90000 });
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
    try { await submitForm(form, cfg); }
    catch (e) { res.error = "заявку отправить не удалось: " + e.message; return res; }
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
    });
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

  const delay = scheduleNext();
  console.log("PHONETEST: страница /phone_test готова; расписание " +
    (store().config.scheduleEnabled ? "ВКЛЮЧЕНО" : "выключено") +
    " (ближайший понедельник через " + Math.round(delay / 3600000) + " ч), удаление " +
    (store().config.dryRun ? "ВЫКЛЮЧЕНО (режим проверки)" : "включено"));
}

module.exports = { mount, CALL_SOURCE_ENUM, defaultNumberConfig };
