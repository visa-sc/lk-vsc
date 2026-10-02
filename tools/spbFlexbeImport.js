#!/usr/bin/env node
/* ─────────────────────────────────────────────────────────────────────────────
 * spbFlexbeImport — переносит архив заявок питерского сайта из Flexbe в наш раздел
 * «Заявки» (https://spb.visa-sc.ru/leads), просьба Андрея 02.10.2026.
 *
 * Откуда: API Flexbe проекта lp130957 (ключ — тот же, что у ночной сверки контактов,
 * .phonetest/store.json → config.flexbe[id=spb]). getLeads по 1000, не чаще лимита.
 * Куда: /var/www/spbcopy/leads.json, рядом с заявками нового сайта.
 *
 * Как записываем: номер заявки = номер во Flexbe (новые заявки сайта продолжают
 * нумерацию после последнего), host = "flexbe-archive". Такие заявки:
 *   • НЕ уходят в amoCRM повторно (spb-amo берёт только заявки боевого домена) —
 *     они уже были созданы Flexbe;
 *   • НЕ попадают в текущую статистику, выручку и сверки (там фильтр по домену);
 *   • помечены просмотренными, чтобы не висеть «новыми».
 * Удалённые во Flexbe (статус 11) не переносим. Повторный запуск ничего не задвоит.
 *
 * Запуск на сервере: node tools/spbFlexbeImport.js [--dry]
 * ───────────────────────────────────────────────────────────────────────────── */
"use strict";
const fs = require("fs");
const path = require("path");
const axios = require("axios");

const LEADS = process.env.SPBCOPY_LEADS || "/var/www/spbcopy/leads.json";
const API = "https://lp130957.myflexbe.ru/mod/api/";
const DRY = process.argv.includes("--dry");
const STATUS = { 0: "new", 1: "work", 2: "success", 10: "refused" };

const store = JSON.parse(fs.readFileSync(path.join(__dirname, "..", ".phonetest", "store.json"), "utf8"));
const key = ((store.config.flexbe || []).find((x) => x.id === "spb") || {}).apiKey;
if (!key) {
  console.log("нет ключа API Flexbe для spb");
  process.exit(1);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const all = [];
  for (let start = 0; ; start += 1000) {
    const r = await axios.get(API, { params: { api_key: key, method: "getLeads", count: 1000, start }, timeout: 120000 });
    if (r.data && r.data.error) throw new Error("Flexbe: " + JSON.stringify(r.data.error));
    let part = r.data && r.data.data && r.data.data.leads;
    if (part && !Array.isArray(part)) part = Object.values(part);
    part = part || [];
    all.push(...part);
    console.log(`  получено ${all.length}`);
    if (part.length < 1000) break;
    await sleep(1500); // лимит Flexbe — 100 запросов в минуту
  }
  const mapped = [];
  for (const L of all) {
    const st = Number(L.status && L.status.code);
    if (st === 11) continue; // удалённые во Flexbe
    const fd = L.form_data && typeof L.form_data === "object" ? Object.values(L.form_data) : [];
    const fields = fd
      .filter((f) => f && String(f.value == null ? "" : f.value).trim())
      .map((f) => ({ name: f.name || f.orig_name || "Поле", value: String(f.value), type: f.type || "text" }));
    const utm = L.utm && typeof L.utm === "object" ? L.utm : {};
    const u = {};
    for (const k of ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content"]) if (utm[k]) u[k] = utm[k];
    let pageUrl = "/";
    try {
      // Flexbe отдаёт адрес без протокола («spb.visa-sc.ru/italy/»)
      const raw = String((L.page && L.page.url) || "/");
      pageUrl = new URL(/^https?:\/\//.test(raw) ? raw : /^[\w.-]+\.[a-z]{2,}\//i.test(raw) ? "https://" + raw : raw, "https://spb.visa-sc.ru").pathname;
    } catch (_) {}
    const paid = !!L.pay && Number(L.pay.status && (L.pay.status.code != null ? L.pay.status.code : L.pay.status)) === 2;
    mapped.push({
      id: Number(L.num) || Number(L.id),
      at: new Date(Number(L.time) * 1000).toISOString(),
      page: pageUrl,
      pageUrl,
      pageTitle: (L.page && L.page.name) || "",
      host: "flexbe-archive",
      ym_client_id: utm.ym_client_id || "",
      ga_client_id: utm.ga_client_id || "",
      ip: utm.ip || "",
      data: { name: L.form_name || "Заявка", fields, utmData: JSON.stringify(u) },
      status: STATUS[st] || "new",
      notes: L.note || "",
      viewed: true,
      amount: paid ? Number(L.pay.summ) || 0 : 0,
      amountManual: paid,
      flexbe: { id: L.id, num: L.num },
      amo: { skipped: "архив Flexbe — сделку создавал Flexbe" }
    });
  }
  console.log(`из Flexbe: ${all.length}, к переносу (без удалённых): ${mapped.length}`);
  if (DRY) {
    console.log(JSON.stringify(mapped[0], null, 1).slice(0, 800));
    return;
  }
  // чтение-запись подряд, без пауз: новые заявки сайта пишутся в этот же файл
  const cur = JSON.parse(fs.readFileSync(LEADS, "utf8"));
  const have = new Set(cur.filter((e) => e.flexbe).map((e) => String(e.flexbe.id)));
  const ids = new Set(cur.map((e) => Number(e.id)));
  const add = mapped.filter((m) => !have.has(String(m.flexbe.id)) && !ids.has(m.id));
  const out = cur.concat(add).sort((a, b) => (a.at < b.at ? -1 : 1));
  fs.writeFileSync(LEADS + ".tmp", JSON.stringify(out, null, 1));
  fs.renameSync(LEADS + ".tmp", LEADS);
  try {
    const st = fs.statSync(path.dirname(LEADS));
    fs.chownSync(LEADS, st.uid, st.gid);
  } catch (_) {}
  console.log(`добавлено: ${add.length}, всего в разделе «Заявки»: ${out.length}`);
})().catch((e) => {
  console.log("ошибка переноса:", e.message);
  process.exit(1);
});
