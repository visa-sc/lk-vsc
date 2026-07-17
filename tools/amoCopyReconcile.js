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
 * Запуск: node tools/amoCopyReconcile.js [pipeline_id | all]
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
  const wait = last + 1100 - Date.now(); if (wait > 0) await sleep(wait); last = Date.now(); reqs++;
  const r = await axios.get(url, { params, headers: { Authorization: "Bearer " + TOK }, validateStatus: null, timeout: 30000 });
  if (r.status === 429 || r.status === 403) { console.log("СТОП: HTTP " + r.status + " — лимит, выходим"); process.exit(2); }
  if (r.status === 204) return { _embedded: { leads: [] } };
  if (r.status !== 200) { console.log("HTTP", r.status, url); return null; }
  return r.data;
}

(async () => {
  const pipes = arg === "all"
    ? db.prepare("SELECT DISTINCT pipeline_id p FROM leads WHERE status_id NOT IN (142,143) AND id<?").all(LOCAL_ID_BASE).map((x) => x.p)
    : [parseInt(arg, 10)];
  const cutoff = Math.floor(Date.now() / 1000) - 7200; // не трогаем свежеобновлённые
  let totalGhosts = 0;
  for (const pid of pipes) {
    const amoIds = new Set();
    let url = `${BASE}/api/v4/leads`;
    let params = { limit: 250, "filter[pipeline_id]": pid };
    let pages = 0, broke = false;
    while (url && pages < 1200) {
      const d = await get(url, params); params = undefined;
      if (!d) { broke = true; break; }
      ((d._embedded || {}).leads || []).forEach((l) => amoIds.add(l.id));
      url = (d._links && d._links.next && d._links.next.href) || null;
      pages++;
    }
    if (broke) { console.log(`воронка ${pid}: обрыв на стр.${pages} — пропускаю удаление (неполный список)`); continue; }
    // ВАЖНО: filter[pipeline_id] отдаёт и закрытые — значит сверять можно все локальные этой воронки
    const local = db.prepare("SELECT id FROM leads WHERE pipeline_id=? AND id<? AND updated_at<?").all(pid, LOCAL_ID_BASE, cutoff);
    const ghosts = local.filter((l) => !amoIds.has(l.id));
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
  console.log(`ИТОГО: удалено призраков ${totalGhosts}, запросов к amo ${reqs}`);
})().catch((e) => { console.error("ОШИБКА:", e.message); process.exit(1); });
