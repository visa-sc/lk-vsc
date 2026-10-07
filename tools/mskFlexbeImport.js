#!/usr/bin/env node
/* ─────────────────────────────────────────────────────────────────────────────
 * mskFlexbeImport — переносит архив заявок основного сайта visa-sc.ru из Flexbe в раздел
 * «Заявки» копии msk.voyotravel.ru (просьба Андрея 02.10.2026).
 *
 * Заявок 115+ тысяч, поэтому не в leads.json, а в /var/www/mskcopy/archive-flexbe:
 *   index.json   — лёгкие строки для списка и фильтров (номер, дата, имя, телефон, почта,
 *                  форма, страница, статус, сумма);
 *   ГГГГ-ММ.json — полные заявки за месяц (их открывает карточка).
 * Раздел «Заявки» читает это сам (leads.js, archiveRows). Номера — как во Flexbe.
 * Такие заявки не уходят в amoCRM и не попадают в текущую статистику (host flexbe-archive).
 * Источник — API Flexbe проекта visa-sc.ru (ключ ночной сверки, .phonetest/store.json,
 * config.flexbe[id=visa-sc]); getLeads по 1000, пауза между запросами под лимит Flexbe.
 * Повторный запуск собирает архив заново целиком, правки статусов/заметок из архива сохраняет.
 *
 * Запуск на сервере: node tools/mskFlexbeImport.js [--dry]
 * Другой сайт Flexbe: FLEXBE_SITE=ekb MSKCOPY_ARCHIVE=/var/www/ekbcopy/archive-flexbe (07.10.2026 — Екатеринбург).
 * ───────────────────────────────────────────────────────────────────────────── */
"use strict";
const fs = require("fs");
const path = require("path");
const axios = require("axios");

const OUT = process.env.MSKCOPY_ARCHIVE || "/var/www/mskcopy/archive-flexbe";
const DRY = process.argv.includes("--dry");
const STATUS = { 0: "new", 1: "work", 2: "success", 10: "refused" };
const store = JSON.parse(fs.readFileSync(path.join(__dirname, "..", ".phonetest", "store.json"), "utf8"));
const SITE_ID = process.env.FLEXBE_SITE || "visa-sc";
const site = (store.config.flexbe || []).find((x) => x.id === SITE_ID) || {};
if (!site.apiKey) {
  console.log("нет ключа API Flexbe для " + SITE_ID);
  process.exit(1);
}
const API = site.apiUrl || "https://visa-sc.ru/mod/api/";
const SITE_ORIGIN = new URL(API).origin;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pathOf = (raw) => {
  raw = String(raw || "/");
  try {
    return new URL(/^https?:\/\//.test(raw) ? raw : /^[\w.-]+\.[a-z]{2,}\//i.test(raw) ? "https://" + raw : raw, SITE_ORIGIN).pathname;
  } catch (_) {
    return "/";
  }
};

(async () => {
  // Выборка по месяцам (date_from/date_to): большие смещения в общей выдаче Flexbe не отдаёт
  // (на 60 000 перестал отвечать). Каждый скачанный месяц сохраняем — при сбое продолжаем.
  // кэш закрытых месяцев — свой у каждого сайта (иначе Екатеринбург взял бы месяцы Москвы)
  const RAW = process.env.MSKCOPY_RAW || (SITE_ID === "visa-sc" ? "/root/msk-flexbe-raw" : "/root/" + SITE_ID + "-flexbe-raw");
  fs.mkdirSync(RAW, { recursive: true });
  let broken = 0;
  const getPage = async (from, to, start, count = 1000, tries = 5) => {
    for (let t = 0; t < tries; t++) {
      try {
        const r = await axios.get(API, { params: { api_key: site.apiKey, method: "getLeads", count, start, date_from: from, date_to: to }, timeout: 120000 });
        if (r.data && r.data.error) throw new Error(JSON.stringify(r.data.error));
        let part = r.data && r.data.data && r.data.data.leads;
        if (part && !Array.isArray(part)) part = Object.values(part);
        return part || [];
      } catch (e) {
        await sleep(5000 * (t + 1));
      }
    }
    throw new Error("Flexbe не ответил: " + new Date(from * 1000).toISOString().slice(0, 7) + ", позиция " + start);
  };
  const all = [];
  const nowMonth = new Date().toISOString().slice(0, 7);
  for (let d = new Date(Date.UTC(2016, 0, 1)); d.toISOString().slice(0, 7) <= nowMonth; d.setUTCMonth(d.getUTCMonth() + 1)) {
    const key = d.toISOString().slice(0, 7);
    const cache = path.join(RAW, key + ".json");
    if (key !== nowMonth && fs.existsSync(cache)) {
      all.push(...JSON.parse(fs.readFileSync(cache, "utf8")));
      continue;
    }
    const from = Math.floor(d.getTime() / 1000) - 3 * 3600;
    const to = Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1) / 1000) - 3 * 3600 - 1;
    // Целиком за месяц; если Flexbe падает (500 — в выборке битая заявка, так было в марте 2022),
    // то по дням, а сбойный день — по одной заявке, пропуская только саму битую.
    const span = async (a, b) => {
      const out = [];
      for (let st = 0; ; st += 1000) {
        const part = await getPage(a, b, st, 1000, 2);
        out.push(...part);
        await sleep(1200); // лимит Flexbe — 100 запросов в минуту
        if (part.length < 1000) break;
      }
      return out;
    };
    let month = [];
    try {
      month = await span(from, to);
    } catch (_) {
      for (let a = from; a <= to; a += 86400) {
        const b = Math.min(a + 86399, to);
        try {
          month.push(...(await span(a, b)));
        } catch (_) {
          for (let st = 0, miss = 0; miss < 3; st++) {
            let one = null;
            try {
              one = await getPage(a, b, st, 1, 2);
            } catch (_) {
              broken++;
              miss = 0;
              console.log(`  битая заявка во Flexbe: ${new Date((a + 3 * 3600) * 1000).toISOString().slice(0, 10)}, позиция ${st} — пропущена`);
              await sleep(1200);
              continue;
            }
            await sleep(700);
            if (!one.length) break;
            month.push(...one);
          }
        }
      }
    }
    fs.writeFileSync(cache, JSON.stringify(month));
    all.push(...month);
    if (month.length) console.log(`  ${key}: ${month.length}, всего ${all.length}`);
  }
  // Заявки, которые API Flexbe не отдаёт вовсе (ошибка 500 на его стороне), перенесены
  // руками из интерфейса Flexbe — tools/mskFlexbeExtra.json (03.10.2026: №70487, №70488)
  if (SITE_ID === "visa-sc") try {
    const have = new Set(all.map((l) => String(l.id)));
    for (const x of JSON.parse(fs.readFileSync(path.join(__dirname, "mskFlexbeExtra.json"), "utf8"))) if (!have.has(String(x.id))) all.push(x);
  } catch (_) {}
  // прежние правки (статус, заметки, сумма) — не теряем при повторном переносе
  const kept = new Map();
  try {
    for (const f of fs.readdirSync(OUT).filter((x) => /^\d{4}-\d{2}\.json$/.test(x)))
      for (const e of JSON.parse(fs.readFileSync(path.join(OUT, f), "utf8")))
        if (e.status !== "new" || e.notes || e.amountManual) kept.set(String(e.flexbe && e.flexbe.id), { status: e.status, notes: e.notes, amount: e.amount, amountManual: e.amountManual });
  } catch (_) {}

  const months = new Map();
  const index = [];
  const seen = new Set();
  // У Flexbe бывают две разные заявки под одним номером (так он их и показывает). Номер у нас —
  // ключ карточки, поэтому повтору даём ключом внутренний id Flexbe, а показываем номер (num).
  const usedNum = new Set();
  all.sort((a, b) => Number(a.time) - Number(b.time) || Number(a.id) - Number(b.id));
  for (const L of all) {
    const st = Number(L.status && L.status.code);
    if (st === 11 || seen.has(String(L.id))) continue; // удалённые во Flexbe и повторы
    seen.add(String(L.id));
    const fd = L.form_data && typeof L.form_data === "object" ? Object.values(L.form_data) : [];
    const fields = fd.filter((f) => f && String(f.value == null ? "" : f.value).trim()).map((f) => ({ name: f.name || f.orig_name || "Поле", value: String(f.value), type: f.type || "text" }));
    const utm = L.utm && typeof L.utm === "object" ? L.utm : {};
    const u = {};
    for (const k of ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content"]) if (utm[k]) u[k] = utm[k];
    const at = new Date(Number(L.time) * 1000).toISOString();
    const month = new Date(Number(L.time) * 1000 + 3 * 3600e3).toISOString().slice(0, 7);
    const paid = !!L.pay && Number(L.pay.status && (L.pay.status.code != null ? L.pay.status.code : L.pay.status)) === 2;
    const k = kept.get(String(L.id)) || {};
    const pagePath = pathOf(L.page && L.page.url);
    const num = Number(L.num) || Number(L.id);
    const e = {
      id: usedNum.has(num) ? Number(L.id) : num,
      num,
      at,
      page: pagePath,
      pageUrl: pagePath,
      pageTitle: (L.page && L.page.name) || "",
      host: "flexbe-archive",
      ym_client_id: utm.ym_client_id || "",
      ga_client_id: utm.ga_client_id || "",
      ip: utm.ip || "",
      data: { name: L.form_name || "Заявка", fields, utmData: JSON.stringify(u) },
      status: k.status || STATUS[st] || "new",
      notes: k.notes || L.note || "",
      viewed: true,
      amount: k.amountManual ? k.amount : paid ? Number(L.pay.summ) || 0 : 0,
      amountManual: k.amountManual || paid,
      flexbe: { id: L.id, num: L.num },
      amo: { skipped: "архив Flexbe — сделку создавал Flexbe" }
    };
    usedNum.add(num);
    if (!months.has(month)) months.set(month, []);
    months.get(month).push(e);
    const fv = (re) => (fields.find((f) => re.test(String(f.type) + " " + String(f.name))) || {}).value || "";
    index.push({
      id: e.id, num, at, month, status: e.status, viewed: true, notes: e.notes ? "•" : "", form: e.data.name,
      clientName: (L.client && L.client.name) || fv(/name|имя/i), phone: (L.client && L.client.phone) || fv(/phone|tel|телефон/i),
      email: (L.client && L.client.email) || fv(/email|почт/i), pagePath, pageTitle: e.pageTitle, amount: e.amount, host: "flexbe-archive"
    });
  }
  console.log(`из Flexbe: ${all.length}, в архив: ${index.length}, месяцев: ${months.size}, битых пропущено: ${broken}`);
  if (DRY) return console.log(JSON.stringify(index[0]));
  fs.mkdirSync(OUT, { recursive: true });
  for (const [m, list] of months) {
    fs.writeFileSync(path.join(OUT, m + ".json.tmp"), JSON.stringify(list));
    fs.renameSync(path.join(OUT, m + ".json.tmp"), path.join(OUT, m + ".json"));
  }
  fs.writeFileSync(path.join(OUT, "index.json.tmp"), JSON.stringify(index));
  fs.renameSync(path.join(OUT, "index.json.tmp"), path.join(OUT, "index.json"));
  try {
    const st = fs.statSync(path.dirname(OUT));
    for (const f of fs.readdirSync(OUT)) fs.chownSync(path.join(OUT, f), st.uid, st.gid);
    fs.chownSync(OUT, st.uid, st.gid);
  } catch (_) {}
  console.log("записано в", OUT);
})().catch((e) => {
  console.log("ошибка переноса:", e.message);
  process.exit(1);
});
