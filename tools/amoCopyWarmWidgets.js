#!/usr/bin/env node
/* Прогрев кэша амо-виджетов рабочего стола (widget_stat2, TTL 10 мин; cron каждые 8 мин).
 * Без прогрева холодный прогон 9 спеков ~7.7с — дашборд Андрея ждал бы; с прогревом всегда мгновенный.
 * Работает локально: login по коду → widget_stat2 по каждому spec из desk-widgets.json + дельта-вариант (today).
 */
const fs = require("fs");
const http = require("http");

const CODE = process.env.AMOCRM_COPY_CODE || "111";
const FILE = "/var/www/voyo/.amocopy-db/desk-widgets.json";

const req = (method, path, body, headers) => new Promise((resolve, reject) => {
  const data = body ? JSON.stringify(body) : null;
  const r = http.request({ host: "127.0.0.1", port: 3001, path, method, headers: { "Content-Type": "application/json", ...(headers || {}) } }, (res) => {
    let buf = ""; res.on("data", (c) => buf += c); res.on("end", () => { try { resolve(JSON.parse(buf)); } catch (_) { resolve(null); } });
  });
  r.on("error", reject);
  if (data) r.write(data);
  r.end();
});

const deltaSpec = (spec) => {
  const s2 = JSON.parse(JSON.stringify(spec || {}));
  if (s2.created_preset === "yesterday") { s2.created_preset = "today"; return s2; }
  if (s2.cf && s2.cf["427242"] && (s2.cf["427242"].preset === "yesterday" || s2.cf["427242"].from)) { s2.cf["427242"] = { preset: "today" }; return s2; }
  if (s2.no_tasks) { s2.created_preset = "today"; return s2; }
  return null;
};

(async () => {
  const login = await req("POST", "/amocrm_copy/api/login", { code: CODE });
  if (!login || !login.token) { console.log("нет токена"); process.exit(1); }
  const H = { Authorization: "Bearer " + login.token };
  const all = JSON.parse(fs.readFileSync(FILE, "utf8"));
  let n = 0;
  for (const owner of Object.keys(all)) {
    for (const w of all[owner] || []) {
      if (w.kind !== "amo" || !w.spec) continue;
      for (const s of [w.spec, deltaSpec(w.spec)]) {
        if (!s) continue;
        await req("GET", "/amocrm_copy/api/widget_stat2?spec=" + encodeURIComponent(JSON.stringify(s)), null, H);
        n++;
      }
    }
  }
  console.log(new Date().toISOString(), "прогрето спеков:", n);
})().catch((e) => { console.error("ошибка прогрева:", e.message); process.exit(1); });
