#!/usr/bin/env node
/* Разовый бэкфил ТЕГОВ контактов (найдено 18.07 по живому amo: у контактов есть теги
 * MSK/Исходящий/shengen..., а в слепке колонки tags у contacts не было — снимок их не выгружал).
 * Полный проход /api/v4/contacts (~980 страниц, 1 rps, ~18 мин) — обновляет ТОЛЬКО tags.
 * Резюмируемый: state в .amocopy-db/contact-tags-state.json (страница). Запуск под flock синка!
 */
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });
const fs = require("fs");
const axios = require("axios");
const Database = require(process.env.SQLITE_MODULE || "/var/www/voyo/crm-svc/node_modules/better-sqlite3");
const db = new Database(process.env.AMOCOPY_DB || "/var/www/voyo/.amocopy-db/crm.db");
db.pragma("journal_mode = WAL");
db.pragma("busy_timeout = 8000");
try { db.exec("ALTER TABLE contacts ADD COLUMN tags TEXT"); } catch (_) { /* уже есть */ }

const TOK = process.env.AMO_ACCESS_TOKEN;
const SUB = (process.env.AMO_SUBDOMAIN || "").replace(/^https?:\/\//, "").replace(/\..*/, "");
const BASE = `https://${SUB}.amocrm.ru`;
const STATE = path.join(path.dirname(process.env.AMOCOPY_DB || "/var/www/voyo/.amocopy-db/crm.db"), "contact-tags-state.json");
let state = {}; try { state = JSON.parse(fs.readFileSync(STATE, "utf8")); } catch (_) {}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let last = 0;
async function get(url, params) {
  const wait = last + 1100 - Date.now(); if (wait > 0) await sleep(wait); last = Date.now();
  const r = await axios.get(url, { params, headers: { Authorization: "Bearer " + TOK }, validateStatus: null, timeout: 30000 });
  if (r.status === 429 || r.status === 403) { console.log("СТОП: HTTP " + r.status); process.exit(2); }
  if (r.status === 204) return null;
  if (r.status !== 200) { console.log("HTTP", r.status); return null; }
  return r.data;
}

(async () => {
  const up = db.prepare("UPDATE contacts SET tags=? WHERE id=?");
  let page = state.page || 1, updated = state.updated || 0, tagged = state.tagged || 0;
  console.log(`старт со страницы ${page}`);
  let url = `${BASE}/api/v4/contacts`, params = { limit: 250, page };
  while (url) {
    const d = await get(url, params); params = undefined;
    if (!d) break;
    const items = (d._embedded && d._embedded.contacts) || [];
    if (!items.length) break;
    const tx = db.transaction(() => {
      for (const c of items) {
        const tags = ((c._embedded && c._embedded.tags) || []).map((t) => t.name);
        up.run(JSON.stringify(tags), c.id);
        updated++; if (tags.length) tagged++;
      }
    });
    tx();
    page++;
    if (page % 50 === 0) console.log(`страниц ${page}, обновлено ${updated}, с тегами ${tagged}`);
    fs.writeFileSync(STATE, JSON.stringify({ page, updated, tagged }));
    url = (d._links && d._links.next && d._links.next.href) || null;
    if (url) { const u = new URL(url); params = Object.fromEntries(u.searchParams); url = u.origin + u.pathname; }
  }
  console.log(`ГОТОВО: обновлено ${updated}, с тегами ${tagged}`);
})().catch((e) => { console.error("ОШИБКА:", e.message); process.exit(1); });
