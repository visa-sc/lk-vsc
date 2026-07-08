#!/usr/bin/env node
/*
 * Полный read-only экспорт аккаунта amoCRM в NDJSON (для слепка /amocrm_copy).
 *
 * Запуск:  node tools/amoFullBackup.js --out /root/amo-backup/2026-07-05 [--rps 1] [--probe]
 *
 * Безопасность (история: блокировки аккаунта 09.06 и 15.06 за превышение API-лимита ~7 RPS):
 *  - скорость жёстко ограничена (по умолчанию 1 rps, максимум 2) — сервер ЛК работает на своих 4 RPS,
 *    суммарно 5-6 < 7;
 *  - только GET, ничего в amoCRM не пишется;
 *  - пагинация строго последовательная, без параллельных страниц;
 *  - 429: пауза 60с, повторный — 5 мин, три подряд — полная остановка;
 *  - 403/401: немедленная остановка (защита от блокировки);
 *  - состояние в state.json — экспорт можно прервать и продолжить с того же места.
 */
const fs = require("fs");
const path = require("path");
const axios = require("axios");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const AMO_ACCESS_TOKEN = process.env.AMO_ACCESS_TOKEN;
// нормализация как в server.js: убрать протокол/путь/.amocrm.ru
const AMO_SUBDOMAIN = String(process.env.AMO_SUBDOMAIN || "")
  .trim()
  .replace(/^https?:\/\//i, "")
  .replace(/\/.*$/, "")
  .replace(/\.amocrm\.ru$/i, "");
if (!AMO_SUBDOMAIN || !AMO_ACCESS_TOKEN) {
  console.error("AMO_SUBDOMAIN / AMO_ACCESS_TOKEN не заданы в .env");
  process.exit(1);
}
const BASE = `https://${AMO_SUBDOMAIN}.amocrm.ru`;

function arg(name, def) {
  const i = process.argv.indexOf("--" + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
const PROBE = process.argv.includes("--probe");
const OUT = path.resolve(arg("out", path.join(__dirname, "..", "amo-backup")));
const RPS = Math.min(2, Math.max(0.2, parseFloat(arg("rps", "1")) || 1));
const MIN_INTERVAL = Math.ceil(1000 / RPS);
const MAX_REQUESTS = 30000; // предохранитель от бесконечного цикла

fs.mkdirSync(OUT, { recursive: true });
const STATE_FILE = path.join(OUT, "state.json");
let state = {};
try { state = JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); } catch (_) {}
function saveState() { fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2)); }

const t0 = Date.now();
let reqCount = 0;
function log(msg) {
  const s = Math.round((Date.now() - t0) / 1000);
  console.log(`[${new Date().toISOString()}] [+${s}s] [req ${reqCount}] ${msg}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function fatal(msg) { const e = new Error(msg); e.__fatal = true; return e; }

let _lastReq = 0;
let _seq429 = 0;
async function throttle() {
  const wait = _lastReq + MIN_INTERVAL - Date.now();
  if (wait > 0) await sleep(wait);
  _lastReq = Date.now();
}

// GET с ретраями. Возвращает данные, null (204) или { __skip: status } для 402/404 (фича выключена).
async function amoGet(url, params) {
  for (let attempt = 1; attempt <= 6; attempt++) {
    if (reqCount >= MAX_REQUESTS) throw fatal(`достигнут предохранитель MAX_REQUESTS=${MAX_REQUESTS}`);
    await throttle();
    reqCount++;
    let r;
    try {
      r = await axios.get(url, {
        // X-Requested-With обязателен для /ajax/* эндпоинтов (без него amoCRM отвечает 403)
        headers: { Authorization: `Bearer ${AMO_ACCESS_TOKEN}`, "X-Requested-With": "XMLHttpRequest" },
        params, timeout: 60000, validateStatus: null
      });
    } catch (e) {
      log(`сеть: ${e.message} — повтор ${attempt}/6 (${url})`);
      await sleep(3000 * attempt);
      continue;
    }
    if (r.status === 200) { _seq429 = 0; return r.data; }
    if (r.status === 204) { _seq429 = 0; return null; }
    if (r.status === 401) throw fatal("401 — токен невалиден, остановка");
    if (r.status === 403) throw fatal("403 — доступ запрещён (риск блокировки аккаунта), НЕМЕДЛЕННАЯ остановка");
    if (r.status === 402 || r.status === 404) { _seq429 = 0; return { __skip: r.status }; }
    if (r.status === 429) {
      _seq429++;
      if (_seq429 >= 3) throw fatal("три 429 подряд — остановка для безопасности аккаунта");
      const ra = (parseInt(r.headers["retry-after"] || "0", 10) || 0) * 1000;
      const delay = Math.max(ra, _seq429 === 1 ? 60000 : 300000);
      log(`429 rate-limit — пауза ${Math.round(delay / 1000)}с (подряд: ${_seq429})`);
      await sleep(delay);
      continue;
    }
    // 5xx и прочее
    log(`HTTP ${r.status} — повтор ${attempt}/6 (${url})`);
    await sleep(3000 * attempt);
  }
  throw fatal(`исчерпаны попытки: ${url}`);
}

// Выгрузка постраничного списка в <name>.ndjson через _links.next (резюмируемо).
async function exportList(name, startUrl, params, embKey) {
  const st = (state[name] = state[name] || { pages: 0, items: 0, done: false });
  if (st.done) { log(`${name}: уже выгружено (${st.items}), пропуск`); return; }
  const file = path.join(OUT, `${name}.ndjson`);
  let url = st.nextUrl || startUrl;
  let p = st.nextUrl ? undefined : Object.assign({}, params);
  while (url) {
    const data = await amoGet(url, p);
    p = undefined;
    if (data && data.__skip) {
      st.done = true; st.skipped = data.__skip; saveState();
      log(`${name}: недоступно (HTTP ${data.__skip}), пропуск`);
      return;
    }
    if (!data) break; // 204 — пусто/конец
    const items = (data._embedded && data._embedded[embKey]) || [];
    if (items.length) fs.appendFileSync(file, items.map((x) => JSON.stringify(x)).join("\n") + "\n");
    st.items += items.length;
    st.pages++;
    url = (data._links && data._links.next && data._links.next.href) || null;
    st.nextUrl = url;
    saveState();
    if (st.pages % 25 === 0) log(`${name}: страниц ${st.pages}, записей ${st.items}...`);
  }
  st.done = true; st.nextUrl = null; saveState();
  log(`${name}: ГОТОВО — ${st.items} записей (${st.pages} стр.)`);
}

// Курсорная выгрузка примечаний по updated_at (offset-пагинация amoCRM упирается
// в стену 504/лимит на глубине ~375k; filter[id][from] на notes работает как exact-match,
// а filter[updated_at][from] + order[updated_at]=asc — честный курсор без offset'ов).
// Дедуп на границе секунды: в state хранится список id с updated_at == краю.
async function exportListCursor(name, url, embKey) {
  const st = (state[name] = state[name] || {});
  if (st.done) { log(`${name}: уже выгружено (${st.items}), пропуск`); return; }
  if (typeof st.lastUpd !== "number") { st.pages = 0; st.items = 0; st.lastUpd = 0; st.edgeIds = []; }
  const file = path.join(OUT, `${name}.ndjson`);
  while (true) {
    const params = { limit: 250, "order[updated_at]": "asc" };
    if (st.lastUpd > 0) params["filter[updated_at][from]"] = st.lastUpd;
    const data = await amoGet(url, params);
    if (data && data.__skip) { st.done = true; st.skipped = data.__skip; saveState(); log(`${name}: недоступно (HTTP ${data.__skip})`); return; }
    if (!data) break; // 204 — конец
    const items = (data._embedded && data._embedded[embKey]) || [];
    if (!items.length) break;
    const edge = new Set(st.edgeIds || []);
    const fresh = items.filter((n) => !(n.updated_at === st.lastUpd && edge.has(n.id)));
    if (!fresh.length) {
      if (items.length < 250) break;
      // >250 записей с одним и тем же updated_at и все уже выгружены — сдвигаем край
      st.lastUpd += 1; st.edgeIds = []; saveState();
      log(`${name}: ВНИМАНИЕ — край ${st.lastUpd - 1} переполнен (>250 записей/сек), сдвиг +1с`);
      continue;
    }
    fs.appendFileSync(file, fresh.map((x) => JSON.stringify(x)).join("\n") + "\n");
    st.items += fresh.length;
    st.pages++;
    const maxUpd = items[items.length - 1].updated_at;
    if (maxUpd === st.lastUpd) {
      st.edgeIds = [...edge, ...fresh.filter((n) => n.updated_at === maxUpd).map((n) => n.id)].slice(-5000);
    } else {
      st.lastUpd = maxUpd;
      st.edgeIds = items.filter((n) => n.updated_at === maxUpd).map((n) => n.id);
    }
    saveState();
    if (st.pages % 25 === 0) log(`${name}: страниц ${st.pages}, записей ${st.items} (до ${new Date(st.lastUpd * 1000).toISOString().slice(0, 10)})...`);
    if (items.length < 250) break;
  }
  st.done = true; saveState();
  log(`${name}: ГОТОВО — ${st.items} записей (updated_at-курсор, край ${st.lastUpd})`);
}

// notes_companies НЕ курсором: их мало (offset-стена не грозит), а order[updated_at] на этом эндпоинте даёт 504
const CURSOR_ENTITIES = new Set(["notes_leads", "notes_contacts"]);

let ENTITIES = [
  ["users",             `${BASE}/api/v4/users`,                    { limit: 250, with: "role,group,uuid" }, "users"],
  ["roles",             `${BASE}/api/v4/roles`,                    { limit: 250 }, "roles"],
  ["pipelines",         `${BASE}/api/v4/leads/pipelines`,          {}, "pipelines"],
  ["loss_reasons",      `${BASE}/api/v4/leads/loss_reasons`,       { limit: 250 }, "loss_reasons"],
  ["cf_leads",          `${BASE}/api/v4/leads/custom_fields`,      { limit: 50 }, "custom_fields"],
  ["cf_contacts",       `${BASE}/api/v4/contacts/custom_fields`,   { limit: 50 }, "custom_fields"],
  ["cf_companies",      `${BASE}/api/v4/companies/custom_fields`,  { limit: 50 }, "custom_fields"],
  ["cf_customers",      `${BASE}/api/v4/customers/custom_fields`,  { limit: 50 }, "custom_fields"],
  ["cfg_leads",         `${BASE}/api/v4/leads/custom_field_groups`,    { limit: 50 }, "custom_field_groups"],
  ["cfg_contacts",      `${BASE}/api/v4/contacts/custom_field_groups`, { limit: 50 }, "custom_field_groups"],
  ["cfg_companies",     `${BASE}/api/v4/companies/custom_field_groups`,{ limit: 50 }, "custom_field_groups"],
  ["tags_leads",        `${BASE}/api/v4/leads/tags`,               { limit: 250 }, "tags"],
  ["tags_contacts",     `${BASE}/api/v4/contacts/tags`,            { limit: 250 }, "tags"],
  ["tags_companies",    `${BASE}/api/v4/companies/tags`,           { limit: 250 }, "tags"],
  ["sources",           `${BASE}/api/v4/sources`,                  {}, "sources"],
  ["webhooks",          `${BASE}/api/v4/webhooks`,                 {}, "webhooks"],
  ["widgets",           `${BASE}/api/v4/widgets`,                  { limit: 250 }, "widgets"],
  ["catalogs",          `${BASE}/api/v4/catalogs`,                 { limit: 250 }, "catalogs"],
  ["leads",             `${BASE}/api/v4/leads`,                    { limit: 250, with: "contacts,companies,catalog_elements,loss_reason,tags,source_id" }, "leads"],
  ["contacts",          `${BASE}/api/v4/contacts`,                 { limit: 250, with: "companies,catalog_elements" }, "contacts"],
  ["companies",         `${BASE}/api/v4/companies`,                { limit: 250, with: "contacts,catalog_elements" }, "companies"],
  ["tasks",             `${BASE}/api/v4/tasks`,                    { limit: 250 }, "tasks"],
  ["notes_leads",       `${BASE}/api/v4/leads/notes`,              { limit: 250 }, "notes"],
  ["notes_contacts",    `${BASE}/api/v4/contacts/notes`,           { limit: 250 }, "notes"],
  ["notes_companies",   `${BASE}/api/v4/companies/notes`,          { limit: 250 }, "notes"],
  ["customers",         `${BASE}/api/v4/customers`,                { limit: 250 }, "customers"],
  ["unsorted",          `${BASE}/api/v4/leads/unsorted`,           { limit: 250 }, "unsorted"],
];
// Журнал событий — только по явному флагу: на больших аккаунтах это десятки тысяч
// запросов, а инцидент 15.06 был именно за превышение ОБЩЕГО лимита аккаунта по API.
if (process.argv.includes("--with-events")) {
  ENTITIES.push(["events", `${BASE}/api/v4/events`, { limit: 100 }, "events"]);
}

async function probe() {
  log(`ПРОБА: аккаунт ${AMO_SUBDOMAIN}, rps=${RPS}`);
  const acc = await amoGet(`${BASE}/api/v4/account`, { with: "version,task_types,users_groups,datetime_settings,drive_url" });
  log(`Аккаунт: "${acc && acc.name}" (id ${acc && acc.id}), поддомен ${acc && acc.subdomain}`);
  const probes = [
    ["leads",        `${BASE}/api/v4/leads`,        true],
    ["contacts",     `${BASE}/api/v4/contacts`,     true],
    ["companies",    `${BASE}/api/v4/companies`,    true],
    ["notes(leads)", `${BASE}/api/v4/leads/notes`,  false],
    ["tasks",        `${BASE}/api/v4/tasks`,        false],
  ];
  for (const [name, url, orderable] of probes) {
    const params = orderable ? { limit: 1, "order[id]": "desc" } : { limit: 1 };
    const d = await amoGet(url, params);
    if (d && d.__skip) { log(`${name}: недоступно (HTTP ${d.__skip})`); continue; }
    const key = Object.keys((d && d._embedded) || {})[0];
    const it = d && d._embedded && key && d._embedded[key] && d._embedded[key][0];
    log(`${name}: есть данные, ${orderable && it ? "max id ≈ " + it.id : "первая запись id " + (it && it.id)}`);
  }
  log("ПРОБА завершена успешно — можно запускать полный экспорт.");
}

async function main() {
  if (PROBE) return probe();
  log(`СТАРТ полного экспорта: out=${OUT}, rps=${RPS} (только чтение, последовательно)`);

  // account — отдельным файлом
  if (!state.__account) {
    const acc = await amoGet(`${BASE}/api/v4/account`, { with: "version,task_types,users_groups,datetime_settings,drive_url,amojo_id" });
    fs.writeFileSync(path.join(OUT, "account.json"), JSON.stringify(acc, null, 2));
    state.__account = true; saveState();
    log(`account.json сохранён ("${acc && acc.name}")`);
  }

  for (const [name, url, params, embKey] of ENTITIES) {
    if (CURSOR_ENTITIES.has(name)) await exportListCursor(name, url, embKey);
    else await exportList(name, url, params, embKey);
  }

  // элементы каталогов (списков) — после выгрузки самих каталогов
  const catFile = path.join(OUT, "catalogs.ndjson");
  if (fs.existsSync(catFile)) {
    const cats = fs.readFileSync(catFile, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
    for (const c of cats) {
      await exportList(`catalog_${c.id}_elements`, `${BASE}/api/v4/catalogs/${c.id}/elements`, { limit: 250 }, "elements");
    }
  }

  // Salesbot: список и полные сценарии (эндпоинты /ajax/* работают с Bearer-токеном, проверено 05.07.2026)
  if (!state.__bots) {
    const list = await amoGet(`${BASE}/api/v4/bots/`, { limit: 250 });
    const items = (list && list._embedded && list._embedded.items) || [];
    const bots = [];
    for (const b of items) {
      const full = await amoGet(`${BASE}/ajax/v4/bots/${b.id}`);
      const item = full && full._embedded && full._embedded.items && full._embedded.items[0];
      bots.push(item || b);
    }
    fs.writeFileSync(path.join(OUT, "salesbots.json"), JSON.stringify(bots, null, 2));
    state.__bots = true; saveState();
    log(`salesbots.json: ${bots.length} ботов (с полными сценариями)`);
  }

  // Цифровая воронка: настройки триггеров по каждой воронке
  if (!state.__dp) {
    const pf = path.join(OUT, "pipelines.ndjson");
    const pips = fs.existsSync(pf) ? fs.readFileSync(pf, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
    for (const p of pips) {
      const dp = await amoGet(`${BASE}/ajax/leads/digital_pipeline/settings`, { pipeline_id: p.id });
      fs.writeFileSync(path.join(OUT, `digital_pipeline_${p.id}.json`), JSON.stringify(dp));
      log(`digital_pipeline_${p.id}.json сохранён (${p.name})`);
    }
    state.__dp = true; saveState();
  }

  // итоговый манифест
  const manifest = {
    finishedAt: new Date().toISOString(),
    subdomain: AMO_SUBDOMAIN,
    requests: reqCount,
    durationSec: Math.round((Date.now() - t0) / 1000),
    entities: Object.fromEntries(Object.entries(state).filter(([k]) => !k.startsWith("__"))
      .map(([k, v]) => [k, { items: v.items, pages: v.pages, skipped: v.skipped || null }]))
  };
  fs.writeFileSync(path.join(OUT, "manifest.json"), JSON.stringify(manifest, null, 2));
  log(`ЭКСПОРТ ЗАВЕРШЁН: ${reqCount} запросов за ${manifest.durationSec}с. Манифест: manifest.json`);
}

main().catch((e) => {
  log(`ОСТАНОВКА: ${e.message}`);
  process.exit(e.__fatal ? 2 : 1);
});
