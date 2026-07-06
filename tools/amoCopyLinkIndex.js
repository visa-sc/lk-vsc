#!/usr/bin/env node
/*
 * Обратный индекс контакт → сделки для слепка /amocrm_copy.
 * Читает .amocopy/leads_detail/*.ndjson (полные сделки со связями contacts),
 * пишет .amocopy/contact_leads/{id % BUCKETS}.ndjson: {"id":<contactId>,"leads":[{id,name,price,pid,sid}]}
 * Запуск: node tools/amoCopyLinkIndex.js [--dir /var/www/voyo/.amocopy]
 */
const fs = require("fs");
const path = require("path");
const readline = require("readline");

function arg(name, def) {
  const i = process.argv.indexOf("--" + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
const DIR = path.resolve(arg("dir", "/var/www/voyo/.amocopy"));
const SRC = path.join(DIR, "leads_detail");
const OUT = path.join(DIR, "contact_leads");
let BUCKETS = 500;
try { BUCKETS = JSON.parse(fs.readFileSync(path.join(DIR, "meta.json"), "utf8")).buckets || 500; } catch (_) {}

const t0 = Date.now();
const map = new Map(); // contactId -> [{id,name,price,pid,sid}]

function processFile(p) {
  return new Promise((resolve, reject) => {
    const rl = readline.createInterface({ input: fs.createReadStream(p, "utf8"), crlfDelay: Infinity });
    rl.on("line", (l) => {
      if (!l.trim()) return;
      let lead; try { lead = JSON.parse(l); } catch (_) { return; }
      const cs = (lead._embedded && lead._embedded.contacts) || [];
      if (!cs.length) return;
      const slim = { id: lead.id, name: lead.name || "", price: lead.price || 0, pid: lead.pipeline_id, sid: lead.status_id };
      for (const c of cs) {
        if (!map.has(c.id)) map.set(c.id, []);
        map.get(c.id).push(slim);
      }
    });
    rl.on("close", resolve);
    rl.on("error", reject);
  });
}

(async () => {
  const files = fs.readdirSync(SRC).filter((f) => f.endsWith(".ndjson"));
  console.log(`Строю индекс контакт→сделки: ${files.length} бакетов сделок`);
  let n = 0;
  for (const f of files) {
    await processFile(path.join(SRC, f));
    if (++n % 100 === 0) console.log(`  [${Math.round((Date.now() - t0) / 1000)}s] обработано ${n}/${files.length}, контактов в индексе ${map.size}`);
  }
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  const byBucket = new Map();
  for (const [cid, leads] of map) {
    const b = Math.abs(Number(cid)) % BUCKETS;
    if (!byBucket.has(b)) byBucket.set(b, []);
    byBucket.get(b).push(JSON.stringify({ id: cid, leads: leads.slice(0, 200) }));
  }
  for (const [b, lines] of byBucket) fs.writeFileSync(path.join(OUT, `${b}.ndjson`), lines.join("\n") + "\n");
  console.log(`ГОТОВО за ${Math.round((Date.now() - t0) / 1000)}s: контактов со сделками ${map.size}, бакетов ${byBucket.size}`);
})().catch((e) => { console.error("ОШИБКА:", e); process.exit(1); });
