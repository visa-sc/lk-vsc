// ═══════════════════════════════════════════════════════════════════════════
// Платрум — расход по категории «Сборы» для блока «Запас на сборы» в /vsc.
//
// Официальной документации по этому эндпоинту нет, поэтому формат снят с самого
// кабинета (visasc.platrum.ru → Финансы → P&L): страница шлёт POST на
// /finance/api/pnl/data с интервалом и группировкой по месяцам. Тот же запрос
// принимает и API-ключ — ЗАГОЛОВКОМ «Api-Key» (X-API-KEY, X-Token и Bearer
// отвечают 403; query-параметр «key» тоже работает, но заголовок аккуратнее).
//
// Ключ — в .env прода: PLATRUM_KEY, PLATRUM_DOMAIN. В git не уходит.
// ═══════════════════════════════════════════════════════════════════════════
const axios = require("axios");
const fs = require("fs");
const path = require("path");

const DOMAIN = process.env.PLATRUM_DOMAIN || "visasc.platrum.ru";
const FILE = path.join(__dirname, ".vscPlatrum.json");
const TTL = 6 * 3600 * 1000;

const MONF = ["Январь", "Февраль", "Март", "Апрель", "Май", "Июнь", "Июль", "Август", "Сентябрь", "Октябрь", "Ноябрь", "Декабрь"];

// Тянет P&L за год и раскладывает нужные строки по месяцам.
// Возвращает { "Август 2026": { sbory, marketing, fot, ... } }.
async function fetchPnl(year) {
  const key = process.env.PLATRUM_KEY;
  if (!key) throw new Error("нет PLATRUM_KEY в .env");
  const y = year || new Date(Date.now() + 3 * 3600 * 1000).getUTCFullYear();
  const body = {
    interval: [y + "-01-01", y + "-12-31"], group_by: "month", report_by: "report_date",
    currency_code: null, currency_code_to: "RUB", categories_ids: [], cashbox_id: [],
    counterparty_key: [], id: 1, category_ids_by_type: [], timezone: "Europe/Moscow", filter: []
  };
  const r = await axios.post("https://" + DOMAIN + "/finance/api/pnl/data", body, {
    headers: { "Content-Type": "application/json", "Api-Key": key }, timeout: 60000
  });
  if (!r.data || r.data.status !== "success") throw new Error("Платрум: " + JSON.stringify(r.data).slice(0, 200));
  const rows = (r.data.data && r.data.data.data) || {};
  // Верхний уровень — группы и формулы (Переменные расходы, Постоянные расходы…).
  // Сами категории лежат внутри группы в массиве data, а помесячные суммы у них в
  // intervals: [{date:"2026-08", value}]. Ищем по ИМЕНИ категории: id у них
  // транслитерированный и при переименовании меняется.
  const out = {};
  const put = (field, date, value) => {
    const m = /^(\d{4})-(\d{2})$/.exec(String(date || "")); if (!m) return;
    const name = MONF[+m[2] - 1] + " " + m[1];
    (out[name] || (out[name] = {}))[field] = Math.round(Number(value) || 0);
  };
  const WANT = { "сборы": "sbory", "маркетинг": "marketing", "фот": "fot", "офис": "office", "налоги": "tax" };
  Object.keys(rows).forEach((gk) => {
    const g = rows[gk]; if (!g) return;
    // формулы верхнего уровня (Чистая прибыль и т.п.) — тоже пригодятся
    const gname = String(g.name || "").trim().toLowerCase();
    if (gname === "чистая прибыль" || gname === "прибыль до налога (ebitda)") {
      (g.data || []).forEach((p) => { if (p && p.date != null) put(gname === "чистая прибыль" ? "netProfit" : "ebitda", p.date, p.value); });
    }
    (g.data || []).forEach((cat) => {
      if (!cat || !cat.name || !Array.isArray(cat.intervals)) return;
      const f = WANT[String(cat.name).trim().toLowerCase()]; if (!f) return;
      cat.intervals.forEach((iv) => put(f, iv.date, iv.value));
    });
  });
  return out;
}

let _cache = null, _at = 0, _running = false;
function load() {
  if (_cache) return _cache;
  try { const d = JSON.parse(fs.readFileSync(FILE, "utf8")); if (d && d.months) { _cache = d.months; _at = d.ts || 0; } } catch (_) {}
  return _cache;
}
async function refresh() {
  const months = await fetchPnl();
  if (!Object.keys(months).length) throw new Error("Платрум вернул пустой P&L");
  _cache = months; _at = Date.now();
  try { fs.writeFileSync(FILE, JSON.stringify({ ts: _at, months: months }), "utf8"); } catch (e) { console.error("savePlatrum:", e.message); }
  console.log("PLATRUM: P&L обновлён, месяцев " + Object.keys(months).length);
  return months;
}
// Тёплое отдаём сразу, свежее тянем фоном.
function warm() {
  const c = load();
  const stale = !c || (Date.now() - _at) > TTL;
  if (stale && !_running) { _running = true; refresh().catch((e) => console.error("PLATRUM:", e && e.message)).then(() => { _running = false; }); }
  return c;
}

module.exports = { fetchPnl, refresh, load, warm };
