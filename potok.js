// ═══════════════════════════════════════════════════════════════════════════
// P&L «Потока» Екатерины Зайцевой (work.voyotravel.ru) → расходы для /vsc.
//
// С сентября 2026 учёт расходов ведётся в «Потоке», Платрум за сентябрь пустой
// (решение Андрея 06.10.2026 — «бери теперь из Катиного блока»). Отсюда берём:
//   • «Сборы» — расход в блок «Запас на сборы»;
//   • «Маркетинг»: «Яндекс Директ», «ФОТ Маркетинг», «Остальной маркетинг» —
//     сопутствующие расходы на маркетинг (ФОТ + остальной) для CPL и ДРР с учётом
//     доп. расходов, когда в листе KPI месяц не заполнен вручную.
// Сверено с Платрумом на июле и августе: сборы расходятся на 360–410 ₽ в месяц,
// «ФОТ Маркетинг» за август — 465 255 ₽, ровно как в листе KPI.
//
// Читаем её же отчёт через её сервис (127.0.0.1:3002, /api/potok/pnl?m=ГГГГ-ММ)
// служебным админ-входом: её модуль пускает его как наблюдателя director@ (только
// просмотр, правка 06.10.2026 в её potok-api.js). Её файлы напрямую не трогаем —
// модуль «Потока» при загрузке пишет свои файлы. Кэш 6 ч + снимок на диске.
// ═══════════════════════════════════════════════════════════════════════════
const fs = require("fs");
const path = require("path");
const http = require("http");

const FILE = path.join(__dirname, ".vscPotok.json");
const TTL = 6 * 3600 * 1000;
const FROM_YM = "2026-09";
const HOST = process.env.KATE_PORTAL_HOST || "127.0.0.1";
const PORT = Number(process.env.KATE_PORTAL_PORT || 3002);
const MONF = ["Январь", "Февраль", "Март", "Апрель", "Май", "Июнь", "Июль", "Август", "Сентябрь", "Октябрь", "Ноябрь", "Декабрь"];
const nameOf = (ym) => MONF[+ym.slice(5, 7) - 1] + " " + ym.slice(0, 4);

let getToken = null;                                   // server.js отдаёт служебный админ-токен
function init(tokenFn) { getToken = tokenFn; }

function apiGet(p, token) {
  return new Promise((resolve, reject) => {
    const r = http.get({ host: HOST, port: PORT, path: p, headers: { Authorization: "Bearer " + token }, timeout: 60000 }, (x) => {
      let b = ""; x.on("data", (d) => (b += d));
      x.on("end", () => {
        let j = null; try { j = JSON.parse(b); } catch (_) { return reject(new Error("«Поток» ответил не JSON (HTTP " + x.statusCode + ")")); }
        if (x.statusCode !== 200 || j.error) return reject(new Error("«Поток»: " + (j.error || ("HTTP " + x.statusCode))));
        resolve(j);
      });
    });
    r.on("timeout", () => { r.destroy(new Error("«Поток» не ответил за 60 с")); });
    r.on("error", reject);
  });
}

// Из отчёта месяца — нужные строки. Ищем по ИМЕНИ (как у Платрума): категория
// «Сборы», категория «Маркетинг» и её строки.
function pick(rep) {
  const out = { sbory: null, marketing: null, direct: null, mktFot: null, mktOther: null };
  (rep.steps || []).forEach((st) => (st.cats || []).forEach((c) => {
    const n = String(c.name || "").trim().toLowerCase();
    if (n === "сборы" && out.sbory == null) out.sbory = Math.round(Number(c.sum) || 0);
    if (n === "маркетинг" && out.marketing == null) {
      out.marketing = Math.round(Number(c.sum) || 0);
      (c.rows || []).forEach((r) => {
        const rn = String(r.name || "").trim().toLowerCase();
        if (/директ/.test(rn)) out.direct = (out.direct || 0) + Math.round(Number(r.sum) || 0);
        else if (/фот/.test(rn)) out.mktFot = (out.mktFot || 0) + Math.round(Number(r.sum) || 0);
        else out.mktOther = (out.mktOther || 0) + Math.round(Number(r.sum) || 0);
      });
    }
  }));
  // Сопутствующие расходы на маркетинг = всё, что в «Маркетинге» кроме Директа.
  out.extra = (out.mktFot != null || out.mktOther != null) ? (out.mktFot || 0) + (out.mktOther || 0) : null;
  return out;
}

let _cache = null, _at = 0, _running = false;
function load() {
  if (_cache) return _cache;
  try { const d = JSON.parse(fs.readFileSync(FILE, "utf8")); if (d && d.months) { _cache = d.months; _at = d.ts || 0; } } catch (_) {}
  return _cache;
}
async function refresh() {
  if (!getToken) throw new Error("«Поток»: не задан служебный вход");
  const token = getToken();
  const now = new Date(Date.now() + 3 * 3600 * 1000);
  const curYm = now.toISOString().slice(0, 7);
  const months = Object.assign({}, load() || {});
  for (let i = 0; i < 36; i++) {
    const d = new Date(Date.UTC(+FROM_YM.slice(0, 4), +FROM_YM.slice(5, 7) - 1 + i, 1));
    const ym = d.toISOString().slice(0, 7);
    if (ym > curYm) break;
    try {
      const rep = await apiGet("/api/potok/pnl?m=" + ym, token);
      if (rep.month && rep.month !== ym) continue;     // месяца ещё нет в «Потоке» — он отдал другой
      months[nameOf(ym)] = Object.assign(pick(rep), { ym: ym, at: Date.now() });
    } catch (e) { console.error("POTOK " + ym + ":", e.message); }
  }
  _cache = months; _at = Date.now();
  try { fs.writeFileSync(FILE, JSON.stringify({ ts: _at, months: months }), "utf8"); } catch (e) { console.error("savePotok:", e.message); }
  console.log("POTOK: P&L обновлён, месяцев " + Object.keys(months).length);
  return months;
}
// Тёплое отдаём сразу, свежее тянем фоном.
function warm() {
  const c = load();
  if ((!c || (Date.now() - _at) > TTL) && !_running) {
    _running = true;
    refresh().catch((e) => console.error("POTOK:", e && e.message)).then(() => { _running = false; });
  }
  return c;
}

module.exports = { init, refresh, load, warm, FROM_YM };
