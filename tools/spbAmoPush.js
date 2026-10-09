#!/usr/bin/env node
/* ─────────────────────────────────────────────────────────────────────────────
 * spbAmoPush — заявки с нашего питерского сайта уходят в amoCRM В ТОЧНОСТИ
 * в том виде, в каком их создавал Flexbe.
 *
 * Образец снят 02.10.2026 с живых питерских сделок в нашей копии CRM:
 *   • сделка «Новая заявка № <номер> (<название формы>)»,
 *     воронка «Отдел Продаж» (138231) → «Ещё не связывались» (10687611),
 *     ответственный «Visa Services Center» (787932), теги Flexbe и SPB;
 *   • поля сделки: Страница, Адрес страницы, Форма, Дата создания, ip,
 *     utm_source/medium/campaign/term/content, ym_client_id, ga_client_id,
 *     _ym_uid, «Канал WZ» = Не Wazzup, «Источник звонка» = Не звонок,
 *     «Вид заявки» = Новое обращение, плюс ответы квиза (страна, гражданство,
 *     даты поездки, занятость) в свои поля;
 *   • контакт: имя из формы или «Клиент», телефон, почта, «Источник» = СПБ.
 *     Если контакт с таким телефоном уже есть — сделка цепляется к нему.
 *
 * В amo берём только заявки с боевого домена (spb.visa-sc.ru): тестовые
 * отправки с spb.voyotravel.ru туда не идут. Скорость — не чаще 1 запроса в
 * секунду, как у всех наших инструментов для amo.
 *
 * Запуск: node tools/spbAmoPush.js [--dry] [--test]
 *   --dry   показать, что будет создано, ничего не отправляя;
 *   --test  выгрузить и заявки с тестового домена (для разовой проверки);
 *   --only=N выгрузить одну заявку с номером N, с любого домена.
 * Выключатель: SPBCOPY_AMO=0 в .env. Cron — раз в 2 минуты.
 *
 * Тот же инструмент выгружает и МОСКВУ (visa-sc.ru на нашем коде, с 09.10.2026) — отдельный
 * процесс pm2 «msk-amo» с переменными (у Питера всё по умолчанию, как было):
 *   AMO_PUSH_SITE_ENV=/var/www/mskcopy/.env — откуда взять SPBCOPY_API_TOKEN и SPBCOPY_LIVE_HOSTS сайта;
 *   SPBCOPY_API_URL=https://msk.voyotravel.ru — откуда брать новые заявки;
 *   AMO_PUSH_SITE=visa-sc.ru, AMO_PUSH_TAGS=Flexbe, AMO_PUSH_CONTACT_SOURCE=Основной —
 *   так московские сделки создавал Flexbe (образец 09.10.2026: метка только «Flexbe»,
 *   источник нового контакта «Основной»; «MSK» и прочее потом ставят автоматизации amo).
 *   Поле ip_location (город по IP) Flexbe заполнял, мы — нет (как и у Питера).
 *   Выключатель Москвы: AMO_PUSH_OFF=1 у процесса msk-amo.
 * ───────────────────────────────────────────────────────────────────────────── */
"use strict";

const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });
const axios = require("axios");

// Настройки другого сайта (Москва) — из его .env, чтобы ключи не дублировать и не светить в pm2.
if (process.env.AMO_PUSH_SITE_ENV) {
  try {
    const site = require("dotenv").parse(require("fs").readFileSync(process.env.AMO_PUSH_SITE_ENV));
    for (const k of ["SPBCOPY_API_TOKEN", "SPBCOPY_LIVE_HOSTS"]) if (site[k]) process.env[k] = site[k];
  } catch (e) {
    console.log("не прочитал " + process.env.AMO_PUSH_SITE_ENV + ": " + e.message);
  }
}
const API = (process.env.SPBCOPY_API_URL || "https://spb.voyotravel.ru").replace(/\/$/, "");
const SPB_TOKEN = process.env.SPBCOPY_API_TOKEN || "";
const SITE = process.env.AMO_PUSH_SITE || "spb.visa-sc.ru";
const AMO_TOKEN = process.env.AMO_ACCESS_TOKEN;
const SUB = String(process.env.AMO_SUBDOMAIN || "").replace(/^https?:\/\//, "").replace(/\..*/, "");
const AMO = `https://${SUB}.amocrm.ru`;
const LIVE_HOSTS = (process.env.SPBCOPY_LIVE_HOSTS || "spb.visa-sc.ru,www.spb.visa-sc.ru").split(",").map((h) => h.trim());

const args = process.argv.slice(2);
const DRY = args.includes("--dry");
const TEST = args.includes("--test");
const ONLY = (args.find((a) => a.startsWith("--only=")) || "").slice(7); // одна заявка по номеру — для проверки

// ── как у Flexbe ─────────────────────────────────────────────────────────────
const PIPELINE_ID = 138231; // Отдел Продаж
const STATUS_ID = 10687611; // Ещё не связывались
const RESPONSIBLE_ID = 787932; // Visa Services Center
const TAGS = (process.env.AMO_PUSH_TAGS || "Flexbe,SPB").split(",").map((t) => t.trim()).filter(Boolean);

const F = {
  page: 479442, // Страница
  url: 568514, // Адрес страницы
  form: 479444, // Форма
  created: 571230, // Дата создания (unix)
  ip: 460012,
  ymClient: 479348, // ym_client_id
  gaClient: 479346, // ga_client_id
  ymUid: 545399, // _ym_uid
  utm_source: 447606,
  utm_medium: 447608,
  utm_campaign: 447610,
  utm_term: 447612,
  utm_content: 545395,
  wz: 572046, // Канал WZ
  callSrc: 571454, // Источник звонка
  kind: 572064 // Вид заявки
};
const SELECTS = { [F.wz]: "Не Wazzup", [F.callSrc]: "Не звонок", [F.kind]: "Новое обращение" };

// Ответы квиза Flexbe раскладывал в свои поля сделки — делаем так же.
const QUIZ = [
  { re: /страну/i, id: 445390 }, // В какую страну требуется виза
  { re: /гражданств/i, id: 445394 }, // Ваше гражданство
  { re: /дат.*поездк|поездк.*дат/i, id: 445396 }, // Планируемые даты поездки
  { re: /ситуация с работой/i, id: 573854 },
  { re: /занятост/i, id: 445392 }
];
const CONTACT_SOURCE_FIELD = 571754; // «Источник» у контакта
const CONTACT_SOURCE_VALUE = process.env.AMO_PUSH_CONTACT_SOURCE || "СПБ";

// ── amo с паузой 1 запрос в секунду ──────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let last = 0;
async function amo(method, url, data) {
  for (let a = 1; a <= 4; a++) {
    const wait = last + 1100 - Date.now();
    if (wait > 0) await sleep(wait);
    last = Date.now();
    let r;
    try {
      r = await axios({
        method,
        url: AMO + url,
        data,
        headers: { Authorization: "Bearer " + AMO_TOKEN },
        validateStatus: null,
        timeout: 45000
      });
    } catch (e) {
      await sleep(3000 * a);
      continue;
    }
    if (r.status === 204) return null;
    if (r.status === 429) {
      await sleep(5000 * a);
      continue;
    }
    if (r.status >= 200 && r.status < 300) return r.data;
    throw new Error(`amo ${method} ${url}: HTTP ${r.status} ${JSON.stringify(r.data || "").slice(0, 300)}`);
  }
  throw new Error(`amo ${method} ${url}: не ответил`);
}

// Варианты выбора полей-списков: amo принимает их по enum_id.
const enumCache = new Map();
async function enumId(entity, fieldId, text) {
  const key = `${entity}:${fieldId}`;
  if (!enumCache.has(key)) {
    const f = await amo("get", `/api/v4/${entity}/custom_fields/${fieldId}`);
    enumCache.set(key, (f && f.enums) || []);
  }
  const e = enumCache.get(key).find((x) => String(x.value).trim().toLowerCase() === text.toLowerCase());
  return e ? e.id : null;
}

const digits = (s) => String(s || "").replace(/\D/g, "");
function phoneE164(p) {
  let d = digits(p);
  if (d.length === 11 && d[0] === "8") d = "7" + d.slice(1);
  if (d.length === 10) d = "7" + d;
  return d ? "+" + d : "";
}

async function findContact(phone) {
  const d = digits(phone).slice(-10);
  if (d.length < 10) return null;
  const r = await amo("get", `/api/v4/contacts?query=${d}&limit=5`);
  const list = (r && r._embedded && r._embedded.contacts) || [];
  return list[0] || null;
}

const txt = (id, v) => (v ? { field_id: id, values: [{ value: String(v).slice(0, 250) }] } : null);

async function buildLead(lead) {
  const pageUrl = `http://${lead.host && LIVE_HOSTS.includes(lead.host) ? lead.host : SITE}${lead.pagePath || "/"}`;
  const fields = [
    txt(F.page, lead.pageTitle),
    txt(F.url, pageUrl),
    txt(F.form, lead.form),
    { field_id: F.created, values: [{ value: Math.floor(new Date(lead.at).getTime() / 1000) }] },
    txt(F.ip, lead.ip),
    txt(F.ymClient, lead.ym_client_id),
    txt(F.gaClient, lead.ga_client_id),
    txt(F.ymUid, lead.ym_client_id),
    txt(F.utm_source, lead.utm.utm_source),
    txt(F.utm_medium, lead.utm.utm_medium),
    txt(F.utm_campaign, lead.utm.utm_campaign),
    txt(F.utm_term, lead.utm.utm_term),
    txt(F.utm_content, lead.utm.utm_content)
  ];
  for (const [id, text] of Object.entries(SELECTS)) {
    const eid = await enumId("leads", Number(id), text);
    if (eid) fields.push({ field_id: Number(id), values: [{ enum_id: eid }] });
  }
  // ответы квиза — в свои поля; всё, что не нашло поля, уйдёт примечанием
  const unmapped = [];
  for (const f of lead.fields || []) {
    if (!String(f.value || "").trim()) continue;
    if (/^(phone|tel|email|name)$/i.test(f.type) || /телефон|e-?mail|почта|^имя/i.test(f.name)) continue;
    const q = QUIZ.find((x) => x.re.test(f.name));
    if (q) fields.push(txt(q.id, f.value));
    else unmapped.push(`${f.name}: ${f.value}`);
  }
  return {
    body: {
      name: `Новая заявка № ${lead.id} (${lead.form || "Заявка"})`,
      pipeline_id: PIPELINE_ID,
      status_id: STATUS_ID,
      responsible_user_id: RESPONSIBLE_ID,
      custom_fields_values: fields.filter(Boolean),
      _embedded: { tags: TAGS.map((name) => ({ name })) }
    },
    unmapped
  };
}

async function buildContact(lead) {
  const cf = [];
  const ph = phoneE164(lead.phone);
  if (ph) cf.push({ field_code: "PHONE", values: [{ value: ph, enum_code: "WORK" }] });
  if (lead.email) cf.push({ field_code: "EMAIL", values: [{ value: lead.email, enum_code: "WORK" }] });
  const src = await enumId("contacts", CONTACT_SOURCE_FIELD, CONTACT_SOURCE_VALUE);
  if (src) cf.push({ field_id: CONTACT_SOURCE_FIELD, values: [{ enum_id: src }] });
  return { name: lead.clientName || "Клиент", custom_fields_values: cf };
}

async function report(items) {
  if (!items.length || DRY) return;
  await axios.post(`${API}/leads/api/amo?token=${encodeURIComponent(SPB_TOKEN)}`, { items }, { timeout: 30000 });
}

// Письмо на visa.sc.office@yandex.ru и отправку в Roistat, которые делал Flexbe,
// сознательно НЕ повторяем: Андрей 02.10.2026 — оба не нужны.

// Неудачные заявки не долбим каждые секунды: откладываем с нарастающей паузой.
const retryAt = new Map();
const BACKOFF = [60e3, 5 * 60e3, 15 * 60e3, 60 * 60e3];
const fails = new Map();

async function runOnce() {
  if (process.env.AMO_PUSH_OFF === "1") return console.log("выгрузка " + SITE + " в amo выключена (AMO_PUSH_OFF=1)");
  if (!process.env.AMO_PUSH_SITE && process.env.SPBCOPY_AMO === "0") return console.log("выгрузка в amo выключена (SPBCOPY_AMO=0)");
  if (!AMO_TOKEN || !SUB || !SPB_TOKEN) return console.log("нет AMO_ACCESS_TOKEN / AMO_SUBDOMAIN / SPBCOPY_API_TOKEN");

  const { data } = await axios.get(`${API}/leads/api/new?token=${encodeURIComponent(SPB_TOKEN)}`, { timeout: 30000 });
  const all = data.leads || [];
  const todo = all.filter((l) => (ONLY ? String(l.id) === ONLY : TEST || LIVE_HOSTS.includes(l.host)))
    .filter((l) => !retryAt.has(l.id) || retryAt.get(l.id) <= Date.now());
  if (!todo.length) return; // тишина в логе, если выгружать нечего

  console.log(`${new Date().toISOString()} новых заявок для amo: ${todo.length}${DRY ? " (пробный заход)" : ""}`);

  const done = [];
  for (const lead of todo) {
    try {
      const { body, unmapped } = await buildLead(lead);
      if (DRY) {
        console.log(JSON.stringify({ сделка: body, примечание: unmapped, контакт: await buildContact(lead) }, null, 1));
        continue;
      }
      let contact = await findContact(lead.phone);
      if (!contact) {
        const cr = await amo("post", "/api/v4/contacts", [await buildContact(lead)]);
        contact = cr && cr._embedded && cr._embedded.contacts && cr._embedded.contacts[0];
      }
      if (contact) body._embedded.contacts = [{ id: contact.id }];
      const lr = await amo("post", "/api/v4/leads", [body]);
      const leadId = lr && lr._embedded && lr._embedded.leads && lr._embedded.leads[0] && lr._embedded.leads[0].id;
      if (!leadId) throw new Error("amo не вернул номер сделки");
      if (unmapped.length) {
        await amo("post", `/api/v4/leads/${leadId}/notes`, [
          { note_type: "common", params: { text: "Заявка с сайта " + SITE + "\n" + unmapped.join("\n") } }
        ]);
      }
      done.push({ id: lead.id, leadId, contactId: contact ? contact.id : null });
      console.log(`  заявка #${lead.id} → сделка ${leadId}, контакт ${contact ? contact.id : "—"}`);
    } catch (e) {
      const n = (fails.get(lead.id) || 0) + 1;
      fails.set(lead.id, n);
      retryAt.set(lead.id, Date.now() + BACKOFF[Math.min(n - 1, BACKOFF.length - 1)]);
      console.log(`  заявка #${lead.id}: ОШИБКА ${e.message} (повтор через ${Math.round(BACKOFF[Math.min(n - 1, BACKOFF.length - 1)] / 60e3)} мин)`);
    }
  }
  await report(done);
}

// --watch: постоянное наблюдение (pm2 «spb-amo»), новая заявка уходит в amo
// за считанные секунды — как у Flexbe. Без флага — один заход и выход.
// Режим наблюдения включается переменной SPBCOPY_AMO_WATCH=1. Флаг --watch тоже
// понимаем, но pm2 перехватывает его как СВОЁ слежение за файлами и начинает
// перезапускать процесс от каждого изменения в папке приложения (поймано 02.10).
const WATCH = args.includes("--watch") || process.env.SPBCOPY_AMO_WATCH === "1";
const EVERY = Number(process.env.SPBCOPY_AMO_EVERY_MS || 5000);
(async () => {
  if (!WATCH) return runOnce();
  console.log(`${new Date().toISOString()} наблюдаю за новыми заявками, проверка каждые ${EVERY / 1000} с`);
  for (;;) {
    try {
      await runOnce();
    } catch (e) {
      console.log(`${new Date().toISOString()} ошибка захода: ${e.message}`);
    }
    await sleep(EVERY);
  }
})().catch((e) => {
  console.log("ошибка выгрузки в amo:", e.message);
  process.exit(1);
});
