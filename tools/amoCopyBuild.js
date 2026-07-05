#!/usr/bin/env node
/*
 * Сборка данных для страницы-слепка /amocrm_copy из полного экспорта amoCRM.
 *
 * Вход:  каталог экспорта (NDJSON) — по умолчанию /root/amo-backup/2026-07-05
 * Выход: /var/www/voyo/.amocopy/ — компактные JSON для UI (в .gitignore, только прод)
 *
 * Запуск: node tools/amoCopyBuild.js --in /root/amo-backup/2026-07-05 --out /var/www/voyo/.amocopy
 * Только чтение экспорта, в amoCRM не ходит вообще.
 */
const fs = require("fs");
const path = require("path");
const readline = require("readline");

function arg(name, def) {
  const i = process.argv.indexOf("--" + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
const IN = path.resolve(arg("in", "/root/amo-backup/2026-07-05"));
const OUT = path.resolve(arg("out", "/var/www/voyo/.amocopy"));
const BUCKETS = 500;   // карточки сделок/контактов раскладываются по id % BUCKETS
const PAGE = 50;       // сделок на страницу канбан-списка

const t0 = Date.now();
const log = (m) => console.log(`[+${Math.round((Date.now() - t0) / 1000)}s] ${m}`);

fs.mkdirSync(OUT, { recursive: true });
for (const d of ["leads_pages", "leads_detail", "contacts_detail", "notes_leads", "notes_contacts", "tasks_by_lead"]) {
  fs.mkdirSync(path.join(OUT, d), { recursive: true });
}

function readNd(file) {
  const p = path.join(IN, file);
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
}
function writeJson(name, obj) {
  fs.writeFileSync(path.join(OUT, name), JSON.stringify(obj));
}

// потоковая обработка большого NDJSON
function streamNd(file, onItem) {
  return new Promise((resolve, reject) => {
    const p = path.join(IN, file);
    if (!fs.existsSync(p)) return resolve(0);
    let n = 0;
    const rl = readline.createInterface({ input: fs.createReadStream(p, "utf8"), crlfDelay: Infinity });
    rl.on("line", (l) => { if (!l.trim()) return; try { onItem(JSON.parse(l)); n++; } catch (_) {} });
    rl.on("close", () => resolve(n));
    rl.on("error", reject);
  });
}

// сброс бакетов на диск (append), буферизуем в памяти по частям
function makeBucketWriter(dir) {
  const buf = new Map();
  let pending = 0;
  const flush = () => {
    for (const [b, lines] of buf) {
      fs.appendFileSync(path.join(OUT, dir, `${b}.ndjson`), lines.join("\n") + "\n");
    }
    buf.clear(); pending = 0;
  };
  return {
    add(id, obj) {
      const b = Math.abs(Number(id) || 0) % BUCKETS;
      if (!buf.has(b)) buf.set(b, []);
      buf.get(b).push(JSON.stringify(obj));
      if (++pending >= 20000) flush();
    },
    flush
  };
}

const cfVal = (e, fid) => {
  const f = (e.custom_fields_values || []).find((x) => x.field_id === fid);
  return f && f.values && f.values[0] ? f.values[0].value : null;
};

async function main() {
  log(`Сборка слепка: ${IN} -> ${OUT}`);

  // --- справочники (мелкие, целиком) ---
  const account = fs.existsSync(path.join(IN, "account.json")) ? JSON.parse(fs.readFileSync(path.join(IN, "account.json"), "utf8")) : {};
  const pipelines = readNd("pipelines.ndjson");
  const users = readNd("users.ndjson");
  const roles = readNd("roles.ndjson");
  const lossReasons = readNd("loss_reasons.ndjson");
  writeJson("pipelines.json", pipelines);
  writeJson("users.json", users.map((u) => ({ id: u.id, name: u.name, email: u.email, lang: u.lang,
    is_active: u.rights ? u.rights.is_active : null, is_admin: u.rights ? u.rights.is_admin : null,
    role: (u._embedded && u._embedded.roles && u._embedded.roles[0] && u._embedded.roles[0].name) || null,
    group: (u._embedded && u._embedded.groups && u._embedded.groups[0] && u._embedded.groups[0].name) || null })));
  writeJson("roles.json", roles);
  writeJson("loss_reasons.json", lossReasons);
  writeJson("custom_fields.json", {
    leads: readNd("cf_leads.ndjson"), contacts: readNd("cf_contacts.ndjson"),
    companies: readNd("cf_companies.ndjson"), customers: readNd("cf_customers.ndjson"),
    groups: { leads: readNd("cfg_leads.ndjson"), contacts: readNd("cfg_contacts.ndjson"), companies: readNd("cfg_companies.ndjson") }
  });
  writeJson("tags.json", { leads: readNd("tags_leads.ndjson"), contacts: readNd("tags_contacts.ndjson"), companies: readNd("tags_companies.ndjson") });
  writeJson("webhooks.json", readNd("webhooks.ndjson"));
  writeJson("sources.json", readNd("sources.ndjson"));
  const catalogs = readNd("catalogs.ndjson");
  writeJson("catalogs.json", catalogs.map((c) => ({ ...c, elements: readNd(`catalog_${c.id}_elements.ndjson`) })));
  for (const f of ["salesbots.json"]) {
    if (fs.existsSync(path.join(IN, f))) fs.copyFileSync(path.join(IN, f), path.join(OUT, f));
  }
  const dpFiles = fs.readdirSync(IN).filter((f) => f.startsWith("digital_pipeline_"));
  for (const f of dpFiles) fs.copyFileSync(path.join(IN, f), path.join(OUT, f));
  log(`Справочники готовы (воронок ${pipelines.length}, пользователей ${users.length}, dp-файлов ${dpFiles.length})`);

  const userName = {}; users.forEach((u) => { userName[u.id] = u.name; });
  const statusName = {}; const pipeName = {};
  pipelines.forEach((p) => { pipeName[p.id] = p.name; ((p._embedded && p._embedded.statuses) || []).forEach((s) => { statusName[`${p.id}:${s.id}`] = s.name; }); });

  // --- сделки: канбан-счётчики + страницы + карточки ---
  const kanban = {}; // pid -> sid -> {count, sum}
  const pages = new Map(); // `pid:sid` -> текущая страница (массив), номер
  const pageNo = new Map();
  const detail = makeBucketWriter("leads_detail");
  const flushPage = (key, force) => {
    const arr = pages.get(key);
    if (!arr || (!force && arr.length < PAGE)) return;
    const n = (pageNo.get(key) || 0) + 1;
    pageNo.set(key, n);
    const [pid, sid] = key.split(":");
    const dir = path.join(OUT, "leads_pages", pid);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${sid}-${n}.json`), JSON.stringify(arr));
    pages.set(key, []);
  };
  const nLeads = await streamNd("leads.ndjson", (l) => {
    const pid = l.pipeline_id, sid = l.status_id;
    kanban[pid] = kanban[pid] || {};
    kanban[pid][sid] = kanban[pid][sid] || { count: 0, sum: 0 };
    kanban[pid][sid].count++; kanban[pid][sid].sum += l.price || 0;
    const key = `${pid}:${sid}`;
    if (!pages.has(key)) pages.set(key, []);
    pages.get(key).push({
      id: l.id, name: l.name, price: l.price || 0,
      resp: userName[l.responsible_user_id] || l.responsible_user_id,
      created: l.created_at, updated: l.updated_at, closed: l.closed_at || null,
      contacts: ((l._embedded && l._embedded.contacts) || []).map((c) => c.id),
      tags: ((l._embedded && l._embedded.tags) || []).map((t) => t.name)
    });
    flushPage(key, false);
    detail.add(l.id, l);
  });
  for (const key of pages.keys()) flushPage(key, true);
  detail.flush();
  writeJson("kanban.json", { kanban, pages: Object.fromEntries([...pageNo].map(([k, v]) => [k, v])) });
  log(`Сделки: ${nLeads}`);

  // --- контакты: поисковый индекс + карточки ---
  const cIdx = fs.createWriteStream(path.join(OUT, "contacts_index.ndjson"));
  const cDetail = makeBucketWriter("contacts_detail");
  const nContacts = await streamNd("contacts.ndjson", (c) => {
    const phones = [], emails = [];
    (c.custom_fields_values || []).forEach((f) => {
      if (f.field_code === "PHONE") (f.values || []).forEach((v) => phones.push(String(v.value)));
      if (f.field_code === "EMAIL") (f.values || []).forEach((v) => emails.push(String(v.value)));
    });
    cIdx.write(JSON.stringify({ id: c.id, n: c.name || "", p: phones, e: emails }) + "\n");
    cDetail.add(c.id, c);
  });
  cDetail.flush();
  await new Promise((r) => cIdx.end(r));
  log(`Контакты: ${nContacts}`);

  // --- компании (обычно немного — целиком) ---
  const companies = [];
  const nCompanies = await streamNd("companies.ndjson", (c) => companies.push(c));
  if (nCompanies <= 20000) writeJson("companies.json", companies);
  log(`Компании: ${nCompanies}`);

  // --- задачи: по сделкам бакетами + счётчик ---
  const tByLead = makeBucketWriter("tasks_by_lead");
  let nTasks = 0, nTasksLead = 0;
  await streamNd("tasks.ndjson", (t) => {
    nTasks++;
    if (t.entity_type === "leads" && t.entity_id) { nTasksLead++; tByLead.add(t.entity_id, t); }
  });
  tByLead.flush();
  log(`Задачи: ${nTasks} (на сделках ${nTasksLead})`);

  // --- примечания: бакетами по entity_id ---
  const noteSlim = (n) => ({ id: n.id, eid: n.entity_id, type: n.note_type, created: n.created_at,
    by: userName[n.created_by] || n.created_by, params: n.params || null });
  const nlB = makeBucketWriter("notes_leads");
  const nNl = await streamNd("notes_leads.ndjson", (n) => nlB.add(n.entity_id, noteSlim(n)));
  nlB.flush();
  const ncB = makeBucketWriter("notes_contacts");
  const nNc = await streamNd("notes_contacts.ndjson", (n) => ncB.add(n.entity_id, noteSlim(n)));
  ncB.flush();
  log(`Примечания: сделки ${nNl}, контакты ${nNc}`);

  // --- метаданные ---
  writeJson("meta.json", {
    builtAt: new Date().toISOString(),
    exportDir: IN,
    account: { id: account.id, name: account.name, subdomain: account.subdomain, created_at: account.created_at },
    counts: { leads: nLeads, contacts: nContacts, companies: nCompanies, tasks: nTasks,
      notes_leads: nNl, notes_contacts: nNc, users: users.length, pipelines: pipelines.length,
      cf_leads: readNd("cf_leads.ndjson").length, webhooks: readNd("webhooks.ndjson").length },
    buckets: BUCKETS, page: PAGE
  });
  log("ГОТОВО: meta.json записан");
}

main().catch((e) => { console.error("ОШИБКА:", e); process.exit(1); });
