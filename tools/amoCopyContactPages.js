#!/usr/bin/env node
/*
 * Постраничный список контактов для /amocrm_copy (как список в amoCRM: новые сверху).
 * Читает .amocopy/contacts_detail/*.ndjson → пишет .amocopy/contacts_pages/{n}.json (по 50)
 * записи: {id, n, p[], e[], created}
 * Запуск: node tools/amoCopyContactPages.js [--dir /var/www/voyo/.amocopy]
 */
const fs = require("fs");
const path = require("path");
const readline = require("readline");

function arg(name, def) {
  const i = process.argv.indexOf("--" + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
const DIR = path.resolve(arg("dir", "/var/www/voyo/.amocopy"));
const SRC = path.join(DIR, "contacts_detail");
const OUT = path.join(DIR, "contacts_pages");
const PAGE = 50;
const t0 = Date.now();
const all = [];

function processFile(p) {
  return new Promise((resolve, reject) => {
    const rl = readline.createInterface({ input: fs.createReadStream(p, "utf8"), crlfDelay: Infinity });
    rl.on("line", (l) => {
      if (!l.trim()) return;
      let c; try { c = JSON.parse(l); } catch (_) { return; }
      const phones = [], emails = [];
      (c.custom_fields_values || []).forEach((f) => {
        if (f.field_code === "PHONE") (f.values || []).forEach((v) => phones.push(String(v.value)));
        if (f.field_code === "EMAIL") (f.values || []).forEach((v) => emails.push(String(v.value)));
      });
      all.push({ id: c.id, n: c.name || "", p: phones.slice(0, 3), e: emails.slice(0, 2), created: c.created_at || 0 });
    });
    rl.on("close", resolve);
    rl.on("error", reject);
  });
}

(async () => {
  const files = fs.readdirSync(SRC).filter((f) => f.endsWith(".ndjson"));
  console.log(`Список контактов: ${files.length} бакетов`);
  let n = 0;
  for (const f of files) {
    await processFile(path.join(SRC, f));
    if (++n % 100 === 0) console.log(`  [${Math.round((Date.now() - t0) / 1000)}s] ${n}/${files.length}, контактов ${all.length}`);
  }
  all.sort((a, b) => (b.created || 0) - (a.created || 0)); // новые сверху, как в amoCRM
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  let pages = 0;
  for (let i = 0; i < all.length; i += PAGE) {
    pages++;
    fs.writeFileSync(path.join(OUT, `${pages}.json`), JSON.stringify(all.slice(i, i + PAGE)));
  }
  fs.writeFileSync(path.join(OUT, "meta.json"), JSON.stringify({ total: all.length, pages, perPage: PAGE }));
  console.log(`ГОТОВО за ${Math.round((Date.now() - t0) / 1000)}s: ${all.length} контактов, ${pages} страниц`);
})().catch((e) => { console.error("ОШИБКА:", e); process.exit(1); });
