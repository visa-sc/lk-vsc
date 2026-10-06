#!/usr/bin/env node
// Переходы из Instagram до запуска счётчика (воронка Instagram в панели eSIM,
// 06.10.2026). Читает журналы nginx (и сжатые .gz), берёт заходы на витрину с
// utm_source=instagram и считает людей (IP + браузер) по дням и ссылкам
// (utm_content: link_in_bio — ссылка в профиле, пусто — без пометки).
// Шагов и оплат в журнале нет — только переходы. Пишет .esim/ig-history.json.
//   node tools/igBackfill.js [--dry]
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const LOG_DIR = "/var/log/nginx";
const OUT = path.join(__dirname, "..", ".esim", "ig-history.json");
const MON = { Jan: "01", Feb: "02", Mar: "03", Apr: "04", May: "05", Jun: "06", Jul: "07", Aug: "08", Sep: "09", Oct: "10", Nov: "11", Dec: "12" };
// витрина eSIM: главная, страницы стран, /67, /visazen, /esim
const PAGE = /^\/(\?|esim(\/|\?|$)|67\b|visazen\b|[a-z-]+\?)/;
const BOT = /bot|crawl|spider|facebookexternalhit|preview|curl|python/i;

const days = {};   // день → ссылка → Set(IP|UA)
let since = null;
for (const f of fs.readdirSync(LOG_DIR).filter((x) => /^access\.log(\.\d+)?(\.gz)?$/.test(x))) {
  let raw = fs.readFileSync(path.join(LOG_DIR, f));
  if (f.endsWith(".gz")) raw = zlib.gunzipSync(raw);
  for (const line of raw.toString("utf8").split("\n")) {
    if (line.indexOf("utm_source=instagram") < 0) continue;
    const m = /^(\S+) \S+ \S+ \[(\d{2})\/(\w{3})\/(\d{4}):(\d{2}):\d{2}:\d{2} ([+-]\d{4})\] "GET (\S+) [^"]*" (\d{3}) \S+ "[^"]*" "([^"]*)"/.exec(line);
    if (!m || m[8] !== "200" || BOT.test(m[9])) continue;
    const url = m[7];
    if (!PAGE.test(url)) continue;
    // журнал в UTC+0? приводим к московскому дню по смещению из строки
    const utc = Date.UTC(+m[4], +MON[m[3]] - 1, +m[2], +m[5]) - (parseInt(m[6], 10) / 100) * 3600e3;
    const day = new Date(utc + 3 * 3600e3).toISOString().slice(0, 10);
    const q = new URLSearchParams(url.split("?")[1] || "");
    const link = String(q.get("utm_content") || q.get("utm_campaign") || "").toLowerCase().replace(/[^a-z0-9_.-]/g, "").slice(0, 40);
    const d = days[day] || (days[day] = {});
    (d[link] || (d[link] = new Set())).add(m[1] + "|" + m[9]);
    if (!since || utc < since) since = utc;
  }
}
const out = { since, built: Date.now(), days: {} };
Object.keys(days).sort().forEach((day) => {
  out.days[day] = {};
  Object.keys(days[day]).forEach((k) => { out.days[day][k] = days[day][k].size; });
});
console.log(JSON.stringify(out.days, null, 1));
if (process.argv.indexOf("--dry") < 0) { fs.writeFileSync(OUT, JSON.stringify(out, null, 1)); console.log("записано:", OUT); }
