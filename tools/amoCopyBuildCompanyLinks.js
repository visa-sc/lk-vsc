#!/usr/bin/env node
/*
 * Строит таблицы связей с компаниями из СЫРОГО слепка (без обращения к amo API):
 *   contact_companies(contact_id,company_id) — из contacts.ndjson.gz (_embedded.companies)
 *   lead_companies(lead_id,company_id)       — из leads.ndjson.gz
 * Запуск на сервере: node tools/amoCopyBuildCompanyLinks.js
 */
const fs = require("fs");
const zlib = require("zlib");
const readline = require("readline");
const path = require("path");
const Database = require(process.env.SQLITE_MODULE || "/var/www/voyo/crm-svc/node_modules/better-sqlite3");
const DB_PATH = process.env.AMOCOPY_DB || "/var/www/voyo/.amocopy-db/crm.db";
const BACKUP = process.env.AMO_BACKUP_DIR || "/root/amo-backup/2026-07-05";
const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.exec("CREATE TABLE IF NOT EXISTS contact_companies (contact_id INTEGER, company_id INTEGER, PRIMARY KEY(contact_id,company_id))");
db.exec("CREATE TABLE IF NOT EXISTS lead_companies (lead_id INTEGER, company_id INTEGER, PRIMARY KEY(lead_id,company_id))");
db.exec("CREATE INDEX IF NOT EXISTS ix_cc_company ON contact_companies(company_id)");
db.exec("CREATE INDEX IF NOT EXISTS ix_lc_company ON lead_companies(company_id)");

function scan(file, table, idField, done) {
  const p = path.join(BACKUP, file);
  if (!fs.existsSync(p)) { console.log("нет файла", p); return done(0); }
  const ins = db.prepare(`INSERT OR IGNORE INTO ${table}(${idField},company_id) VALUES(?,?)`);
  const rl = readline.createInterface({ input: fs.createReadStream(p).pipe(zlib.createGunzip()), crlfDelay: Infinity });
  let n = 0, links = 0, buf = [];
  const flush = db.transaction((rows) => { for (const r of rows) ins.run(r[0], r[1]); });
  rl.on("line", (line) => {
    if (line.indexOf('"companies":[{') < 0) { n++; return; } // быстрый префильтр
    try {
      const o = JSON.parse(line);
      const comps = (o._embedded && o._embedded.companies) || [];
      for (const c of comps) if (c && c.id) buf.push([o.id, c.id]);
      if (buf.length >= 5000) { flush(buf); links += buf.length; buf = []; }
    } catch (_) {}
    n++;
    if (n % 50000 === 0) console.log(`  ${file}: ${n} строк, связей ${links + buf.length}`);
  });
  rl.on("close", () => { if (buf.length) { flush(buf); links += buf.length; } console.log(`${table}: строк ${n}, связей ${links}`); done(links); });
  rl.on("error", (e) => { console.log("ошибка", e.message); done(links); });
}

scan("contacts.ndjson.gz", "contact_companies", "contact_id", () => {
  scan("leads.ndjson.gz", "lead_companies", "lead_id", () => {
    console.log("ГОТОВО. contact_companies:", db.prepare("SELECT COUNT(*) c FROM contact_companies").get().c,
      "| lead_companies:", db.prepare("SELECT COUNT(*) c FROM lead_companies").get().c);
  });
});
