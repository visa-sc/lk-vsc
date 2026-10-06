// ═════════════════════════════════════════════════════════════════════════
// Данные раздела Кати (work.voyotravel.ru) для /vsc — вместо Google «срм-факт»
// и Google-таблицы возвратов (решение Андрея 06.10.2026: «от гугла уходим»).
//
// Что берём:
//  • возвраты — её модуль возвратов, data/vozvraty/returns/ГГГГ-ММ.json (все
//    месяцы 2026: строки перенесены из прежней таблицы, сверено до рубля);
//  • CRM-факт — data/kassa/amo/ГГГГ-ММ.json (сделки amoCRM по дням оплаты): сборы,
//    выручки юрлиц, вынесенный НДС. Катя ведёт его с июля 2026 (раньше сделки в CRM
//    правились задним числом) — поэтому месяцы до июля остаются как были;
//  • нал без чека — её «Касса → CRM-факт» по API (пересчёт сейфа МСК+СПБ), этого
//    числа в файлах готовым нет. Последнее удачное хранится в .vscKateCash.json.
//
// Её файлы только читаем; её модули в наш процесс не грузим (они пишут на диск).
// ═════════════════════════════════════════════════════════════════════════
const fs = require("fs");
const path = require("path");
const http = require("http");

const KATE = "/var/www/kateadmin/data";
const FROM_YM = "2026-07";                 // с этого месяца CRM-факт Кати — источник
const MON = ["Январь", "Февраль", "Март", "Апрель", "Май", "Июнь", "Июль", "Август", "Сентябрь", "Октябрь", "Ноябрь", "Декабрь"];
const CASH_FILE = path.join(__dirname, ".vscKateCash.json");

const ymName = (ym) => MON[+ym.slice(5, 7) - 1] + " " + ym.slice(0, 4);
function nameYm(name) {
  const m = /^([А-Яа-яёЁ]+)\s+(\d{4})$/.exec(String(name || "").trim());
  if (!m) return null;
  const i = MON.findIndex((x) => x.toLowerCase() === m[1].toLowerCase());
  return i < 0 ? null : m[2] + "-" + String(i + 1).padStart(2, "0");
}
function readJson(f) { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch (_) { return null; } }
function monthsIn(dir) {
  try { return fs.readdirSync(dir).map((f) => (/^(\d{4}-\d{2})\.json$/.exec(f) || [])[1]).filter(Boolean).sort(); } catch (_) { return []; }
}
const returnMonths = () => monthsIn(KATE + "/vozvraty/returns");
const amoMonths = () => monthsIn(KATE + "/kassa/amo").filter((ym) => ym >= FROM_YM);
function returnRows(ym) { const j = readJson(KATE + "/vozvraty/returns/" + ym + ".json"); return Array.isArray(j) ? j : null; }
function amoDays(ym) { const j = readJson(KATE + "/kassa/amo/" + ym + ".json"); return j && j.days ? j.days : null; }

const entOf = (s) => {
  const e = String(s || "").toLowerCase();
  if (e.includes("альта")) return "alta";
  if (/комис+аренко/.test(e)) return "kom";
  if (e.includes("панфилов")) return "pan";
  if (/эй ?кей/.test(e)) return "akg";
  return "other";
};
const faultOf = (r) => {
  const c = String(((r.investigation || {}).category) || "").toLowerCase();
  if (/не\s*наш/.test(c)) return "notOur";   // «Не наша вина» содержит «наша вина» — проверяем первым
  if (/наш/.test(c)) return "our";
  return "unknown";
};

// Возвраты месяца для дашборда: «Услуги» по дням возврата (ключ ДД.ММ.ГГГГ), итог
// месяца и разбивка по вине — в той же форме, что раньше давал разбор Google.
function returnsForDashboard(ym) {
  const rows = returnRows(ym); if (!rows) return null;
  const out = { byDay: {}, totalAll: 0, fault: { our: 0, notOur: 0, unknown: 0 } };
  rows.forEach((r) => {
    const v = Number((r.split || {}).services) || 0;
    out.totalAll += v;
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(r.date || ""));
    if (m) { const k = m[3] + "." + m[2] + "." + m[1]; out.byDay[k] = (out.byDay[k] || 0) + v; }
    out.fault[faultOf(r)] += v;
  });
  return out;
}
// Возвраты филиала Санкт-Петербург, «Услуги».
function returnsSpb(ym) {
  const rows = returnRows(ym); if (!rows) return null;
  return rows.reduce((a, r) => a + (/петерб|спб|питер/i.test(String(r.branch || "")) ? (Number((r.split || {}).services) || 0) : 0), 0);
}
// Возвраты по юрлицам: «Услуги» + «НДС» (методика налоговой вкладки).
function returnsByEntity(ym) {
  const rows = returnRows(ym); if (!rows) return null;
  const by = { alta: 0, kom: 0, pan: 0, akg: 0, other: 0 };
  rows.forEach((r) => { const s = r.split || {}; const v = (Number(s.services) || 0) + (Number(s.vat) || 0); if (v) by[entOf(r.entity)] += v; });
  return by;
}
// Возвраты по сборам: вся разбивка, кроме услуг и НДС.
const RET_SBORY = { registration: "Регистрация", submission: "Подача", consular: "Сбор", akk: "Услуги АКК", bot: "Бот", avia: "Ваучеры", insurance: "Страховка" };
function returnsSbory(ym) {
  const rows = returnRows(ym); if (!rows) return null;
  const parts = {}; let total = 0;
  rows.forEach((r) => Object.keys(r.split || {}).forEach((k) => {
    if (k === "services" || k === "vat") return;
    const v = Number(r.split[k]) || 0; if (!v) return;
    const n = RET_SBORY[k] || k;
    parts[n] = (parts[n] || 0) + v; total += v;
  }));
  Object.keys(parts).forEach((k) => { parts[k] = Math.round(parts[k]); });
  return { total: Math.round(total), parts };
}

// Приход сборов из CRM-факта (поля сделок amoCRM по видам сборов).
const IN_SBORY = { reg: "регистрация", podacha: "подача", photo: "фото", consul: "консульские сборы", akk: "услуги акк", bot: "запись/бот",
  voucher: "ваучеры авиа", courier: "сторонние курьеры", insur: "страховка", translate: "языковые переводы" };
function sboryIncome(ym) {
  if (ym < FROM_YM) return null;
  const days = amoDays(ym); if (!days) return null;
  const parts = {}; let total = 0;
  Object.values(days).forEach((d) => Object.keys(IN_SBORY).forEach((f) => { const v = Number(d[f]) || 0; if (v) { parts[IN_SBORY[f]] = (parts[IN_SBORY[f]] || 0) + v; total += v; } }));
  Object.keys(parts).forEach((k) => { parts[k] = Math.round(parts[k]); });
  return { total: Math.round(total), parts };
}
// Налоги месяца по формулам Кати (kassa-api.js, saveTax): база — бюджет по четырём
// юрлицам; предполагаемый НДС = база × 5 %; расхождение = вынесенный в сделках НДС −
// предполагаемый (плюс — запас); налог УСН 5 % = база × 5 % без НДС в базе.
function taxesMonth(ym) {
  if (ym < FROM_YM) return null;
  const days = amoDays(ym); if (!days) return null;
  let base = 0, vatFact = 0;
  Object.values(days).forEach((d) => { base += (Number(d.alta) || 0) + (Number(d.komis) || 0) + (Number(d.panf) || 0) + (Number(d.akg) || 0); vatFact += Number(d.nds) || 0; });
  const r2 = (v) => Math.round(v * 100) / 100;
  // Проверка по каждой сделке на юрлица: НДС в сделке должен быть ровно 5 % её бюджета
  // (клиент платит бюджет + НДС + сборы). Месячный итог может сойтись взаимозачётом —
  // поэтому считаем и сделки с отклонением больше 2 ₽.
  const ENT = ["alta", "komis", "panf", "akg"], bad = []; let checked = 0;
  Object.values(days).forEach((d) => (d.deals || []).forEach((x) => {
    if (ENT.indexOf(x.ent) < 0) return; checked++;
    const want = (Number(x.price) || 0) * 0.05, got = Number(x.nds) || 0;
    if (Math.abs(got - want) > 2) bad.push({ id: x.id, name: String(x.name || "").slice(0, 60), price: x.price, nds: got, want: r2(want) });
  }));
  return { base: r2(base), nds: r2(base * 0.05), vatFact: r2(vatFact), rasx: r2(vatFact - base * 0.05), tax5: r2(base * 0.05),
    dealsChecked: checked, dealsBad: bad.length, badList: bad.slice(0, 30) };
}
// Выручки юрлиц за месяц (CRM-факт).
function entityRevenue(ym) {
  if (ym < FROM_YM) return null;
  const days = amoDays(ym); if (!days) return null;
  const s = (f) => Object.values(days).reduce((a, d) => a + (Number(d[f]) || 0), 0);
  return { alta: s("alta"), kom: s("komis"), pan: s("panf"), akg: s("akg") };
}

// Нал без чека по пересчёту сейфа — из API «Кассы» Кати. Токен — служебная сессия
// director@ (та же, что для «Потока»). При сбое — последнее удачное значение.
let _tokenFn = null;
function init(tokenFn) { _tokenFn = tokenFn; }
function getJson(p) {
  return new Promise((resolve, reject) => {
    const tok = _tokenFn ? _tokenFn() : "";
    const r = http.get({ host: "127.0.0.1", port: 3002, path: p, headers: { Authorization: "Bearer " + tok }, timeout: 60000 }, (x) => {
      let b = ""; x.on("data", (d) => (b += d));
      x.on("end", () => { try { const j = JSON.parse(b); if (j && j.ok) resolve(j); else reject(new Error((j && j.error) || ("HTTP " + x.statusCode))); } catch (e) { reject(e); } });
    });
    r.on("error", reject);
    r.on("timeout", () => r.destroy(new Error("таймаут")));
  });
}
function cashLoad() { return readJson(CASH_FILE) || {}; }
let _cashAt = {};
async function cashNoCheck(ym) {
  if (ym < FROM_YM) return null;
  const store = cashLoad();
  if (store[ym] && Date.now() - (_cashAt[ym] || 0) < 60 * 60 * 1000) return store[ym];
  try {
    const j = await getJson("/api/kassa/crmfact?m=" + ym);
    let msk = 0, spb = 0;
    (j.rows || []).forEach((r) => { const c = r.cash || {}; msk += Number(c.nocheck_msk) || 0; spb += Number(c.nocheck_spb) || 0; });
    store[ym] = { msk: Math.round(msk), spb: Math.round(spb), total: Math.round(msk + spb), at: new Date().toISOString() };
    _cashAt[ym] = Date.now();
    try { fs.writeFileSync(CASH_FILE, JSON.stringify(store, null, 1), "utf8"); } catch (_) {}
    return store[ym];
  } catch (e) {
    console.error("katedata: нал без чека " + ym + " — " + e.message + (store[ym] ? ", взял последнее удачное" : ""));
    return store[ym] || null;
  }
}

module.exports = { FROM_YM, KATE, ymName, nameYm, returnMonths, amoMonths, returnsForDashboard, returnsSpb, returnsByEntity, returnsSbory,
  sboryIncome, taxesMonth, entityRevenue, cashNoCheck, init };
