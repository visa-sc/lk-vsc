#!/usr/bin/env node
/* ─────────────────────────────────────────────────────────────────────────────
 * clickNoCallToAmo — «нажал на номер и не дозвонился»: номер такого посетителя — в amoCRM (Андрей 20.11.2026).
 *
 * Цель одна: чтобы номер с наибольшей вероятностью попал в amoCRM. Задач менеджерам НЕ ставим (решение Андрея).
 * Посетитель нажал на номер на сайте (visa-sc.ru / visa-gum.ru, spb, ekb), а звонка от него нет. Если мы знаем
 * его номер — он раньше оставлял заявку на этом сайте или ввёл телефон в форму (тот же посетитель, кука spb_vid),
 * — проверяем копию amoCRM: номер там уже есть → ничего не делаем. Нет → заводим заявку на сайте от его имени
 * (как сторож брошенных форм: POST формы на локальный порт сайта, форма «Заявка»), и она уходит в amoCRM
 * обычной выгрузкой. Окно «Не дозвонились? Перезвоним» на сайте — отдельно, это его подстраховка.
 *
 * Ждём 15 минут после нажатия (вдруг перезвонит или оставит номер в окне). Не трогаем: тесты (нет визита,
 * тестовые номера), тех, кто после нажатия позвонил с этого номера или оставил заявку. Один номер — не чаще
 * раза в 7 дней. Писем нет, только журнал. Живой amo не трогаем (только копия CRM).
 * Запуск: node tools/clickNoCallToAmo.js [--dry]   cron: каждые 10 минут. Состояние: /var/lib/click-nocall/state.json
 * ───────────────────────────────────────────────────────────────────────────── */
"use strict";
const fs = require("fs");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env"), quiet: true });

const DRY = process.argv.includes("--dry");
const STATE_DIR = "/var/lib/click-nocall", STATE = path.join(STATE_DIR, "state.json");
const GRACE = 15 * 60e3, PER_PHONE = 7 * 86400e3;
const SITES = [
  { id: "spb", name: "spb.visa-sc.ru", dir: "/var/www/spbcopy", host: /^(www\.)?spb\.visa-sc\.ru$/i, port: 3006 },
  { id: "msk", name: "visa-sc.ru", dir: "/var/www/mskcopy", host: /^(www\.)?visa-sc\.ru$|^(www\.)?visa-gum\.ru$/i, port: 3007 },
  { id: "ekb", name: "ekb.visa-sc.ru", dir: "/var/www/ekbcopy", host: /^(www\.)?ekb\.visa-sc\.ru$/i, port: 3009 }
];
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch (_) { return d; } };
const digits10 = (s) => { const d = String(s || "").replace(/\D/g, ""); return d.length >= 10 ? d.slice(-10) : ""; };
const fmtPhone = (p) => (p ? "+7 " + p.slice(0, 3) + " " + p.slice(3, 6) + "-" + p.slice(6, 8) + "-" + p.slice(8) : "");
const leadPhone = (l) => digits10(((l.data && l.data.fields) || []).filter((f) => f.type === "phone").map((f) => f.value).join(""));
const looksTest = (p) => !p || p === "9001234567" || p === "9161234567" || /(\d)\1{6}$/.test(p);

function readEvents(site, types) {
  const out = [], now = new Date();
  const months = [...new Set([new Date(now.getFullYear(), now.getMonth() - 1, 15), now].map((d) => d.toISOString().slice(0, 7)))];
  for (const m of months) {
    const f = path.join(site.dir, "stat", `events-${m}.jsonl`);
    if (!fs.existsSync(f)) continue;
    for (const line of fs.readFileSync(f, "utf8").split("\n")) {
      if (!line || !types.some((t) => line.indexOf('"' + t + '"') >= 0)) continue;
      let e; try { e = JSON.parse(line); } catch (_) { continue; }
      if (types.includes(e.type)) out.push(e);
    }
  }
  return out;
}
function visitVids(site) {
  const set = new Set(), now = new Date();
  for (const m of [...new Set([new Date(now.getFullYear(), now.getMonth() - 1, 15), now].map((d) => d.toISOString().slice(0, 7)))]) {
    try { const txt = fs.readFileSync(path.join(site.dir, "stat", `visits-${m}.jsonl`), "utf8");
      let i = 0; while ((i = txt.indexOf('"vid":"', i)) >= 0) { const j = txt.indexOf('"', i + 7); set.add(txt.slice(i + 7, j)); i = j; } } catch (_) {}
  }
  return set;
}
let _phones = null;
function inAmo(phone) {
  if (!_phones) {
    const Database = require(process.env.SQLITE_MODULE || "/var/www/voyo/crm-svc/node_modules/better-sqlite3");
    const db = new Database(process.env.AMOCOPY_DB || "/var/www/voyo/.amocopy-db/crm.db", { readonly: true, fileMustExist: true });
    _phones = new Set();
    for (const c of db.prepare("SELECT phones FROM contacts").iterate())
      for (const p of String(c.phones || "").split(/[,;\s]+/).map(digits10).filter(Boolean)) _phones.add(p);
  }
  return _phones.has(phone);
}
async function createLead(site, click, phone) {
  if (DRY) { console.log("[dry] заявка:", site.name, click.page, fmtPhone(phone)); return 0; }
  const page = String(click.page || "/").startsWith("/") ? click.page : "/";
  const r = await fetch(`http://127.0.0.1:${site.port}${page}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Host: site.name, "X-Forwarded-Host": site.name, "X-Forwarded-Proto": "https",
      Referer: `https://${site.name}${page}`, Cookie: "spb_vid=" + click.vid, "User-Agent": "clickNoCallToAmo (known visitor)" },
    body: JSON.stringify({ name: "Заявка", action: "", is_ajax: true, utmData: JSON.stringify(click.utm || {}),
      fields: [{ id: "cnc-phone", type: "phone", name: "Телефон", value: fmtPhone(phone) },
               { id: "cnc-note", type: "text", name: "Комментарий", value: "Нажал на номер на сайте и не дозвонился. Номер из его прошлой заявки на сайте." }] }),
    signal: AbortSignal.timeout(20000)
  });
  const j = await r.json().catch(() => ({}));
  return j && j.success && j.lead_id > 100000 ? j.lead_id - 100000 : null;
}

(async () => {
  const first = !fs.existsSync(STATE);
  const st = readJson(STATE, null) || { since: {}, phones: {} };
  const now = Date.now();
  if (first) for (const s of SITES) st.since[s.id] = new Date(now).toISOString();   // только с первого запуска
  const stats = { clicks: 0, known: 0, inAmo: 0, created: 0 };
  for (const site of SITES) {
    const since = process.env.CNC_SINCE || st.since[site.id] || new Date(now - GRACE).toISOString();   // CNC_SINCE — только для проверки с --dry
    const ev = readEvents(site, ["phone_click", "form_abandon"]);
    const leads = readJson(path.join(site.dir, "leads.json"), []).filter((l) => site.host.test(l.host || ""));
    const calls = (readJson(path.join(site.dir, "stat", "calls.json"), {}).calls || []);
    const visits = visitVids(site);
    let newSince = since;
    const clicks = ev.filter((e) => e.type === "phone_click" && e.at > since).sort((a, b) => (a.at < b.at ? -1 : 1));
    for (const c of clicks) {
      const t = Date.parse(c.at);
      if (now - t < GRACE) break;
      newSince = c.at; stats.clicks++;
      if (!c.vid || (visits.size && !visits.has(c.vid))) continue;                       // тест / бот
      // номер посетителя: его заявки на этом сайте или телефон, введённый в форму
      const byVid = leads.filter((l) => l.vid === c.vid);
      const after = byVid.some((l) => Date.parse(l.at || 0) >= t - 60e3);
      if (after) continue;                                                                  // после нажатия сам оставил заявку
      let phone = "";
      for (const l of byVid.filter((x) => Date.parse(x.at || 0) < t)) phone = leadPhone(l) || phone;
      if (!phone) for (const e of ev) if (e.type === "form_abandon" && e.vid === c.vid) { try { phone = digits10(JSON.parse(e.value || "{}").p) || phone; } catch (_) {} }
      if (!phone || looksTest(phone)) continue;
      stats.known++;
      if (calls.some((x) => x.caller === phone && x.ts * 1000 >= t - 30e3)) continue;      // дозвонился с этого номера
      if (inAmo(phone)) { stats.inAmo++; continue; }                                          // номер уже в amo — достаточно
      // прошлая заявка с этим номером уже уходила в amo, а контакта нет — значит, его там удалили (тест, спам): не возвращаем
      if (leads.some((l) => l.amo && l.amo.leadId && leadPhone(l) === phone)) { stats.inAmo++; continue; }
      if (st.phones[phone] && now - st.phones[phone] < PER_PHONE) continue;
      const n = await createLead(site, c, phone).catch((e) => { console.log("заявка не создана:", e.message); return null; });
      if (n !== null) { st.phones[phone] = now; stats.created++; }
      console.log(new Date().toISOString(), site.name, c.page, fmtPhone(phone), n ? "заявка №" + n : n === 0 ? "dry" : "не создана");
    }
    st.since[site.id] = newSince;
  }
  for (const p of Object.keys(st.phones)) if (now - st.phones[p] > 30 * 86400e3) delete st.phones[p];
  if (!DRY) { fs.mkdirSync(STATE_DIR, { recursive: true }); fs.writeFileSync(STATE, JSON.stringify(st)); }
  if (stats.clicks || DRY) console.log(new Date().toISOString(), "нажатий:", stats.clicks, "номер известен:", stats.known, "уже в amo:", stats.inAmo, "заведено заявок:", stats.created);
})().catch((e) => { console.error("clickNoCallToAmo:", e.message); process.exit(1); });
