/**
 * vscSchengenCompute.js — считает % сделок на «продвинутых» статусах со страной=шенген,
 * ПО ДАТЕ ОПЛАТЫ (поле 427242), помесячно, из локальной копии amoCRM (crm.db, readonly).
 * НОЛЬ обращений к amoCRM API. Пишет результат в .vscSchengen.json. Всё живое (без заморозки):
 * если оплаченную в июле сделку «запишут» в сентябре — июльский % подрастёт при следующем расчёте.
 * Запускается отдельным процессом (server.js спавнит по расписанию) — better-sqlite3 в основной
 * процесс не тянем.
 */
const path = require("path");
const fs = require("fs");
const DB_PATH = process.env.AMOCOPY_DB || "/var/www/voyo/.amocopy-db/crm.db";
const SQLITE = process.env.SQLITE_MODULE || "/var/www/voyo/crm-svc/node_modules/better-sqlite3";
const OUT = process.env.VSC_SCHENGEN_FILE || path.join(__dirname, "..", ".vscSchengen.json");

const F_COUNTRY = 427240, F_PAYDATE = 427242;
// Две ОТДЕЛЬНЫЕ группы стран (по ВХОЖДЕНИЮ названия в значение поля «Страна оформления/услуга»):
//  • Шенген — зона + Болгария/Кипр/Румыния/Хорватия («Италия» ловит Альмавиву+VMS). Ирландия/Британия НЕ входят.
//  • США — «США»/«США Астана»/«США Варшава».
const KW_SCH = ["Австрия", "Бельгия", "Чехия", "Дания", "Эстония", "Финляндия", "Франция", "Германия", "Греция", "Венгрия", "Исландия", "Италия", "Латвия", "Литва", "Люксембург", "Мальта", "Нидерланды", "Норвегия", "Польша", "Португалия", "Словакия", "Словения", "Испания", "Швеция", "Швейцария", "Лихтенштейн", "Румыния", "Хорватия", "Болгария", "Кипр"];
const KW_USA = ["США"];
// Целевые статусы (pipeline_id:status_id):
//  Отдел по работе с Клиентами (1309524): На рассмотрении в Консульстве, Документы готовы к личной
//   подаче, Передано Клиенту для личной подачи, Документы поданы лично Заявителем, Паспорт готов,
//   Успешно реализовано.  Отдел Оформления (1312578): Запись сделана, Электронное рассмотрение,
//   Оформлен выкуп, Пакет документов готов.
const TARGET = new Set([
  "1309524:21256455", "1309524:21256203", "1309524:70957793", "1309524:70957929", "1309524:21256458", "1309524:142",
  "1312578:26918115", "1312578:21256668", "1312578:61251437", "1312578:142"
]);
const YEAR = +(process.env.VSC_SCHENGEN_YEAR || 2026);

function cfVal(arr, fid) { if (!Array.isArray(arr)) return null; const c = arr.find((f) => f.field_id === fid); return c && c.values && c.values.length ? c.values[0] : null; }
function ymOf(ts) { if (ts == null || ts === "" || isNaN(Number(ts))) return null; const d = new Date(Number(ts) * 1000 + 3 * 3600 * 1000); return { y: d.getUTCFullYear(), m: d.getUTCMonth() }; }
function hit(kw, name) { const s = String(name || ""); return kw.some((k) => s.includes(k)); }
function grp(den, num) { return { den: den, num: num, pct: den ? Math.round(num / den * 1000) / 10 : null }; }

function main() {
  const Database = require(SQLITE);
  const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
  const from = Math.floor(Date.UTC(YEAR, 0, 1) / 1000) - 3 * 3600; // деньги/оплаты года — по updated_at ≥ 1 янв (МСК)
  const rows = db.prepare("SELECT pipeline_id,status_id,cf FROM leads WHERE updated_at >= ?").all(from);
  const agg = {}; // m -> {schDen,schNum,usaDen,usaNum}
  for (const r of rows) {
    let cf; try { cf = JSON.parse(r.cf || "[]"); } catch (_) { continue; }
    const pay = cfVal(cf, F_PAYDATE); if (!pay) continue;
    const ym = ymOf(pay.value); if (!ym || ym.y !== YEAR) continue;      // оплата в нужном году
    const country = cfVal(cf, F_COUNTRY); if (!country) continue;
    const nm = country.value, isSch = hit(KW_SCH, nm), isUsa = hit(KW_USA, nm);
    if (!isSch && !isUsa) continue;
    const adv = TARGET.has(r.pipeline_id + ":" + r.status_id);
    const a = agg[ym.m] || (agg[ym.m] = { schDen: 0, schNum: 0, usaDen: 0, usaNum: 0 });
    if (isSch) { a.schDen++; if (adv) a.schNum++; }
    if (isUsa) { a.usaDen++; if (adv) a.usaNum++; }
  }
  db.close();
  const months = {};
  for (let m = 0; m < 12; m++) {
    const a = agg[m]; if (!a || (!a.schDen && !a.usaDen)) continue;
    months[YEAR + "-" + String(m + 1).padStart(2, "0")] = { sch: grp(a.schDen, a.schNum), usa: grp(a.usaDen, a.usaNum) };
  }
  const out = { ts: Date.now(), year: YEAR, scanned: rows.length, months };
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2), "utf8");
  console.log("VSC SCHENGEN: посчитано месяцев " + Object.keys(months).length + ", просмотрено сделок " + rows.length + " → " + OUT);
}

try { main(); } catch (e) { console.error("vscSchengenCompute ERROR:", e && e.message); process.exit(1); }
