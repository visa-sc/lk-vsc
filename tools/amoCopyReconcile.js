#!/usr/bin/env node
/* Сверка целостности копии с amo: удаление «призраков» — сделок, УДАЛЁННЫХ в amo.
 * Проблема: инкрементальный синк (updated_at) не видит удалений — удалённая сделка
 * просто перестаёт отдаваться API и навсегда остаётся в копии (найдено 18.07: 30 призраков
 * на одном этапе). Решение: тянем id всех сделок АКТИВНЫХ этапов (не 142/143) воронки из amo
 * и удаляем локальные активные сделки, которых в amo больше нет.
 *
 * Безопасность: строго 1 rps; НЕ трогаем локальные сущности id>=1e9; не трогаем сделки,
 * обновлённые последние 2 часа (даём инкрементальному синку шанс подхватить перенос);
 * закрытые (142/143) не сверяем — их обновления синк видит штатно.
 * Запуск: node tools/amoCopyReconcile.js [pipeline_id | all | leads | contacts | tasks]
 *   all (дефолт, cron) = сделки всех воронок + КОНТАКТЫ (найдено 19.07: копия 247089 vs amo 247059 —
 *   удалённые/слитые в amo контакты тоже навсегда зависали в копии; ~989 стр. по 250, тот же 1 rps)
 */
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });
const axios = require("axios");
const Database = require(process.env.SQLITE_MODULE || "/var/www/voyo/crm-svc/node_modules/better-sqlite3");
const db = new Database(process.env.AMOCOPY_DB || "/var/www/voyo/.amocopy-db/crm.db");
db.pragma("journal_mode = WAL");
db.pragma("busy_timeout = 8000");

const TOK = process.env.AMO_ACCESS_TOKEN;
const SUB = (process.env.AMO_SUBDOMAIN || "").replace(/^https?:\/\//, "").replace(/\..*/, "");
const BASE = `https://${SUB}.amocrm.ru`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const LOCAL_ID_BASE = 1000000000;
const arg = process.argv[2] || "all";

let last = 0, reqs = 0;
async function get(url, params) {
  // сетевые обрывы (socket hang up/ECONNRESET) НЕ должны валить весь прогон — 3 ретрая с паузой
  for (let attempt = 1; attempt <= 3; attempt++) {
    const wait = last + 1100 - Date.now(); if (wait > 0) await sleep(wait); last = Date.now(); reqs++;
    let r;
    try {
      r = await axios.get(url, { params, headers: { Authorization: "Bearer " + TOK }, validateStatus: null, timeout: 30000 });
    } catch (e) { console.log(`сеть (${e.message}) — повтор ${attempt}/3`); await sleep(5000 * attempt); continue; }
    if (r.status === 429 || r.status === 403) { console.log("СТОП: HTTP " + r.status + " — лимит, выходим"); process.exit(2); }
    if (r.status === 204) return { _embedded: { leads: [] } };
    if (r.status !== 200) { console.log("HTTP", r.status, url); return null; }
    return r.data;
  }
  return null; // обрыв после ретраев — вызывающий код трактует как «неполный список» и пропускает удаление
}

// точечный запрос с ЯВНЫМ статусом: нужен там, где 404 («удалено в amo») нельзя путать с обрывом сети
async function getStatus(url) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const wait = last + 1100 - Date.now(); if (wait > 0) await sleep(wait); last = Date.now(); reqs++;
    try {
      const r = await axios.get(url, { headers: { Authorization: "Bearer " + TOK }, validateStatus: null, timeout: 30000 });
      if (r.status === 429 || r.status === 403) { console.log("СТОП: HTTP " + r.status + " — лимит, выходим"); process.exit(2); }
      return { status: r.status, data: r.data };
    } catch (e) { await sleep(5000 * attempt); }
  }
  return { status: 0, data: null };
}

// «отставшие»: amo.updated_at НОВЕЕ копии, но watermark-синк их уже никогда не увидит
// (класс дыры найден 21.07: гонка первичного экспорта — сделка выкачана утром 04-05.07,
// изменена в amo днём 05.07, синк стартовал с 06.07 → изменение потеряно навсегда).
// Кравл reconcile и так отдаёт updated_at каждой записи — сравниваем и перекачиваем точечно.
const staleLeads = [], staleContacts = [], missingLeads = [];

// closest_task_at — поле, по которому amo считает «есть задача» (см. amocopy-db.js). Кравл
// reconcile и так тянет ВСЕ сделки и ВСЕ контакты, поэтому поддерживаем поле бесплатно, без
// единого лишнего запроса. Ставим значение как есть, включая обнуление.
try { db.exec("ALTER TABLE leads ADD COLUMN closest_task_at INTEGER"); } catch (_) {}
try { db.exec("ALTER TABLE contacts ADD COLUMN closest_task_at INTEGER"); } catch (_) {}
const setCtaLead = db.prepare("UPDATE leads SET closest_task_at=? WHERE id=?");
const setCtaContact = db.prepare("UPDATE contacts SET closest_task_at=? WHERE id=?");
const applyCta = (table, items) => {
  const st = table === "leads" ? setCtaLead : setCtaContact;
  db.transaction(() => { for (const [id, v] of items) st.run(v || null, id); })();
};
// дозаливка полей фильтра amo (кем создана/изменена, причина отказа) из того же обхода — бесплатно
try { db.exec("ALTER TABLE leads ADD COLUMN created_by INTEGER DEFAULT 0"); } catch (_) {}
try { db.exec("ALTER TABLE leads ADD COLUMN updated_by INTEGER DEFAULT 0"); } catch (_) {}
try { db.exec("ALTER TABLE leads ADD COLUMN loss_reason_id INTEGER DEFAULT 0"); } catch (_) {}
const setLeadMeta = db.prepare("UPDATE leads SET created_by=?,updated_by=?,loss_reason_id=? WHERE id=?");
const applyLeadMeta = (page) => { db.transaction(() => { for (const l of page) setLeadMeta.run(l.created_by || 0, l.updated_by || 0, l.loss_reason_id || 0, l.id); })(); };

// ВОССТАНОВЛЕНИЕ СВЯЗЕЙ сделка↔контакт из того же обхода (дыра «отставшие связи», найдена 23.07:
// привязка контакта к сделке НЕ всегда бампает updated_at сделки → watermark-синк её не
// перекачивает → lead_contacts навсегда теряет строку; 4 из 8 «контактов без сделок» в копии
// имели сделку в amo). Обход reconcile и так тянет все активные сделки — добавляем with=contacts
// и доводим связи: чего нет — вставляем, is_main выравниваем, ЛИШНИЕ (отвязанные в amo) удаляем.
try { db.exec("ALTER TABLE lead_contacts ADD COLUMN is_main INTEGER DEFAULT 0"); } catch (_) {}
const lcInsert = db.prepare("INSERT OR IGNORE INTO lead_contacts(lead_id,contact_id,is_main) VALUES(?,?,?)");
const lcSetMain = db.prepare("UPDATE lead_contacts SET is_main=? WHERE lead_id=? AND contact_id=?");
const lcLocal = db.prepare("SELECT contact_id c FROM lead_contacts WHERE lead_id=?");
const lcDel = db.prepare("DELETE FROM lead_contacts WHERE lead_id=? AND contact_id=?");
const qContactExists = db.prepare("SELECT 1 x FROM contacts WHERE id=?");
let linksAdded = 0, linksRemoved = 0;
function rebuildLinks(page) {
  db.transaction(() => {
    for (const l of page) {
      const amoC = ((l._embedded || {}).contacts || []);
      if (!amoC.length && !((l._embedded || {}).contacts)) continue; // поле не пришло — не трогаем
      const amoIds = new Set(amoC.map((c) => c.id));
      for (const c of amoC) {
        // не создаём связь на контакт, которого ещё нет в копии (его подтянет контактный синк)
        if (!qContactExists.get(c.id)) continue;
        const r = lcInsert.run(l.id, c.id, c.is_main ? 1 : 0); if (r.changes) linksAdded++;
        lcSetMain.run(c.is_main ? 1 : 0, l.id, c.id);
      }
      // удаляем локальные связи, которых в amo больше нет (контакт отвязан от сделки).
      // ТОЛЬКО при непустом наборе от amo: пустой ответ (редкая квирка with=contacts) не должен
      // сносить все связи сделки — риск потери данных важнее редкого неучтённого отвяза.
      if (amoC.length) for (const row of lcLocal.all(l.id)) { if (!amoIds.has(row.c)) { lcDel.run(l.id, row.c); linksRemoved++; } }
    }
  })();
}

// контакты: полная сверка id (удалённые и слитые в amo → каскадное удаление из копии)
async function reconcileContacts(cutoff) {
  const amoIds = new Set(), amoUpd = new Map();
  let url = `${BASE}/api/v4/contacts`;
  let params = { limit: 250 };
  let pages = 0;
  while (url && pages < 1300) {
    const d = await get(url, params); params = undefined;
    if (!d) { console.log(`контакты: обрыв на стр.${pages} — пропускаю удаление (неполный список)`); return 0; }
    const page = ((d._embedded || {}).contacts || []);
    page.forEach((c) => { amoIds.add(c.id); amoUpd.set(c.id, c.updated_at || 0); });
    applyCta("contacts", page.map((c) => [c.id, c.closest_task_at]));
    url = (d._links && d._links.next && d._links.next.href) || null;
    pages++;
  }
  const local = db.prepare("SELECT id,updated_at FROM contacts WHERE id<? AND updated_at<?").all(LOCAL_ID_BASE, cutoff);
  const ghosts = local.filter((c) => !amoIds.has(c.id));
  for (const c of local) { const au = amoUpd.get(c.id); if (au && au > c.updated_at && au < cutoff) staleContacts.push(c.id); }
  console.log(`контакты: amo=${amoIds.size} (стр.${pages}), локально=${local.length}, призраков=${ghosts.length}, отставших=${staleContacts.length}`);
  if (!ghosts.length) return 0;
  if (amoIds.size === 0 || amoIds.size < local.length / 2) { console.log("  amo вернул подозрительно мало — пропускаю удаление"); return 0; }
  const delC = db.prepare("DELETE FROM contacts WHERE id=?");
  const delLC = db.prepare("DELETE FROM lead_contacts WHERE contact_id=?");
  const delCC = db.prepare("DELETE FROM contact_companies WHERE contact_id=?");
  const delT = db.prepare("DELETE FROM tasks WHERE entity_type='contacts' AND entity_id=?");
  const delN = db.prepare("DELETE FROM notes_new WHERE entity_type='contacts' AND entity_id=?");
  const tx = db.transaction(() => { for (const g of ghosts) { delC.run(g.id); delLC.run(g.id); delCC.run(g.id); delT.run(g.id); delN.run(g.id); } });
  tx();
  return ghosts.length;
}

// ЗАДАЧИ (фаза добавлена 22.07). Класс дыры найден паритетным обходом: фильтр «Сделки/контакты без
// задач» в копии давал 42 172 против 42 080 в amo. Диагностика активных задач показала ДВЕ дыры:
//   • 181 активная задача (upd. март) ОТСУТСТВУЕТ в копии — первичный экспорт их не забрал, а
//     watermark-синк (filter[updated_at][from]) их уже никогда не увидит: они старше точки старта;
//   • 28 задач в копии числятся активными, хотя в amo уже завершены/удалены — «призраки» задач
//     (тот же класс, что чинился для сделок/контактов, но задачи в сверку не входили вовсе).
// Обе дыры искажали «без задач» в обе стороны. Стоимость фазы ~30 запросов при 1 rps.
async function reconcileTasks() {
  const upTask = db.prepare(`INSERT INTO tasks(id,entity_type,entity_id,text,task_type,complete_till,is_completed,responsible_user_id,result,created_at)
    VALUES(@id,@entity_type,@entity_id,@text,@task_type,@complete_till,@is_completed,@responsible_user_id,@result,@created_at)
    ON CONFLICT(id) DO UPDATE SET text=@text,complete_till=@complete_till,is_completed=@is_completed,responsible_user_id=@responsible_user_id,result=@result`);
  const row = (t) => ({ id: t.id, entity_type: t.entity_type || "leads", entity_id: t.entity_id || 0, text: t.text || "",
    task_type: t.task_type_id || 0, complete_till: t.complete_till || 0, is_completed: t.is_completed ? 1 : 0,
    responsible_user_id: t.responsible_user_id || 0, result: JSON.stringify(t.result || null), created_at: t.created_at || 0 });
  const amo = new Map();
  let url = `${BASE}/api/v4/tasks`, params = { limit: 250, "filter[is_completed]": 0 }, pages = 0;
  while (url && pages < 80) {
    const d = await get(url, params); params = undefined;
    if (!d) { console.log(`задачи: обрыв на стр.${pages} — пропускаю фазу (неполный список)`); return; }
    ((d._embedded || {}).tasks || []).forEach((t) => amo.set(t.id, t));
    url = (d._links && d._links.next && d._links.next.href) || null;
    if (url) { const u = new URL(url); params = Object.fromEntries(u.searchParams); url = u.origin + u.pathname; }
    pages++;
  }
  if (!amo.size) { console.log("задачи: amo вернул 0 активных — подозрительно, пропускаю фазу"); return; }
  const local = db.prepare("SELECT id FROM tasks WHERE is_completed=0 AND id<?").all(LOCAL_ID_BASE);
  const locIds = new Set(local.map((t) => t.id));
  const missing = [...amo.values()].filter((t) => !locIds.has(t.id));
  const suspect = local.filter((t) => !amo.has(t.id)).map((t) => t.id);
  db.transaction(() => { for (const t of missing) upTask.run(row(t)); })();
  console.log(`задачи: amo активных=${amo.size} (стр.${pages}), копия активных=${local.length}, добавлено отсутствовавших=${missing.length}, к проверке=${suspect.length}`);
  // «подозрительные» проверяем поштучно. Ответы amo (проверено 22.07 на живых id):
  //   200 + is_completed=true → задача просто завершена, у нас отстал статус → upsert;
  //   204 (именно 204, не 404 — так amo отвечает на несуществующую сущность) → удалена в amo → удаляем;
  // ВАЖНО: по сетевому обрыву (status 0) НЕ удаляем — иначе можно снести живую задачу.
  let closed = 0, deleted = 0, skipped = 0;
  for (const id of suspect.slice(0, 200)) {
    const r = await getStatus(`${BASE}/api/v4/tasks/${id}`);
    if (r.status === 200 && r.data && r.data.id) { upTask.run(row(r.data)); closed++; }
    else if (r.status === 204 || r.status === 404) { db.prepare("DELETE FROM tasks WHERE id=?").run(id); deleted++; }
    else skipped++;
  }
  if (skipped) console.log(`  не проверено (сетевые ошибки): ${skipped} — без изменений, дочистит следующий прогон`);
  if (suspect.length > 200) console.log(`  ВНИМАНИЕ: проверено 200 из ${suspect.length} — остальные дочистит следующий прогон`);
  console.log(`задачи: завершено по amo=${closed}, удалено призраков=${deleted}`);
}

(async () => {
  const pipes = (arg === "all" || arg === "leads")
    ? db.prepare("SELECT DISTINCT pipeline_id p FROM leads WHERE status_id NOT IN (142,143) AND id<?").all(LOCAL_ID_BASE).map((x) => x.p)
    : (arg === "contacts" || arg === "tasks" ? [] : [parseInt(arg, 10)]);
  const cutoff = Math.floor(Date.now() / 1000) - 7200; // не трогаем свежеобновлённые
  let totalGhosts = 0;
  for (const pid of pipes) {
    const amoIds = new Set(), amoUpd = new Map();
    let url = `${BASE}/api/v4/leads`;
    let params = { limit: 250, "filter[pipeline_id]": pid, with: "contacts" };
    let pages = 0, broke = false;
    while (url && pages < 1200) {
      const d = await get(url, params); params = undefined;
      if (!d) { broke = true; break; }
      const page = ((d._embedded || {}).leads || []);
      page.forEach((l) => { amoIds.add(l.id); amoUpd.set(l.id, l.updated_at || 0); });
      applyCta("leads", page.map((l) => [l.id, l.closest_task_at]));
      applyLeadMeta(page); // created_by/updated_by/loss_reason_id — из того же обхода
      rebuildLinks(page); // доведение lead_contacts (та же выкачка, 0 доп. запросов)
      url = (d._links && d._links.next && d._links.next.href) || null;
      pages++;
    }
    if (broke) { console.log(`воронка ${pid}: обрыв на стр.${pages} — пропускаю удаление (неполный список)`); continue; }
    // ВАЖНО: filter[pipeline_id] отдаёт и закрытые — значит сверять можно все локальные этой воронки
    const local = db.prepare("SELECT id,updated_at FROM leads WHERE pipeline_id=? AND id<? AND updated_at<?").all(pid, LOCAL_ID_BASE, cutoff);
    const ghosts = local.filter((l) => !amoIds.has(l.id));
    for (const l of local) { const au = amoUpd.get(l.id); if (au && au > l.updated_at && au < cutoff) staleLeads.push(l.id); }
    // ПРОПУЩЕННЫЕ СДЕЛКИ (зеркало призраков, найдено 23.07): есть в amo, но в копию не попали
    // (первичный слепок 06.07 их не забрал + обновление до/мимо watermark → невидимы навсегда).
    // Список id воронки из amo у нас уже есть — сравниваем со ВСЕМИ локальными id (без cutoff) и
    // докачиваем недостающие тем же syncLeadsByIds. Требует полноты списка — только если не broke.
    if (amoIds.size) {
      const localAll = new Set(db.prepare("SELECT id FROM leads WHERE pipeline_id=? AND id<?").all(pid, LOCAL_ID_BASE).map((x) => x.id));
      // сделка могла сменить воронку — исключаем те, что есть в копии в ЛЮБОЙ воронке
      const hasAnywhere = db.prepare("SELECT 1 x FROM leads WHERE id=?");
      let miss = 0;
      for (const id of amoIds) { if (!localAll.has(id) && !hasAnywhere.get(id)) { missingLeads.push(id); miss++; } }
      if (miss) console.log(`  воронка ${pid}: пропущенных сделок (есть в amo, нет в копии): ${miss}`);
    }
    console.log(`воронка ${pid}: amo=${amoIds.size} (стр.${pages}), локально=${local.length}, призраков=${ghosts.length}`);
    if (!ghosts.length) continue;
    if (amoIds.size === 0) { console.log("  amo вернул 0 — подозрительно, пропускаю удаление"); continue; }
    const delL = db.prepare("DELETE FROM leads WHERE id=?");
    const delLC = db.prepare("DELETE FROM lead_contacts WHERE lead_id=?");
    const delT = db.prepare("DELETE FROM tasks WHERE entity_type='leads' AND entity_id=?");
    const delN = db.prepare("DELETE FROM notes_new WHERE entity_type='leads' AND entity_id=?");
    const tx = db.transaction(() => { for (const g of ghosts) { delL.run(g.id); delLC.run(g.id); delT.run(g.id); delN.run(g.id); } });
    tx();
    totalGhosts += ghosts.length;
  }
  // перекачка отставших ТЕМ ЖЕ кодом синка (upsert с pay_ts/контактами); watermark не трогается.
  // leads перекачиваем СРАЗУ после воронок — падение контактной фазы не должно терять сделочный результат
  const { spawnSync } = require("child_process");
  const fs = require("fs");
  const refetch = (entity, ids) => {
    if (!ids.length) return;
    const f = "/tmp/amocopy-stale-" + entity + ".json";
    fs.writeFileSync(f, JSON.stringify(ids));
    console.log(`перекачиваю отставших ${entity}: ${ids.length}`);
    const r = spawnSync(process.execPath, [path.join(__dirname, "amoCopySync.js"), "--entity", entity, "--ids", "@" + f], { stdio: "inherit" });
    if (r.status !== 0) console.log(`перекачка ${entity} завершилась с кодом ${r.status}`);
  };
  // отставшие И пропущенные сделки — одной перекачкой (дедуп); syncLeadsByIds добавит недостающие
  const leadsToFetch = [...new Set([...staleLeads, ...missingLeads])];
  if (missingLeads.length) console.log(`пропущенных сделок к докачке: ${missingLeads.length}`);
  refetch("leads", leadsToFetch);
  if (arg === "all" || arg === "contacts") {
    try { totalGhosts += await reconcileContacts(cutoff); }
    catch (e) { console.log("контакты: фаза упала (" + e.message + ") — сделочный результат сохранён"); }
    refetch("contacts", staleContacts);
  }
  if (arg === "all" || arg === "tasks") {
    try { await reconcileTasks(); }
    catch (e) { console.log("задачи: фаза упала (" + e.message + ") — остальной результат сохранён"); }
  }
  console.log(`ИТОГО: удалено призраков ${totalGhosts}, отставших leads=${staleLeads.length}/contacts=${staleContacts.length}, пропущенных сделок ${missingLeads.length}, связей +${linksAdded}/-${linksRemoved}, запросов к amo ${reqs}`);
})().catch((e) => { console.error("ОШИБКА:", e.message); process.exit(1); });
