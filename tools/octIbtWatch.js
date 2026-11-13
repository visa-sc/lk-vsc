// ─────────────────────────────────────────────────────────────────────────
// Разовый сторож (просьба Андрея 13.11.2026). Катя рано взяла выписку IBT
// за октябрь: операции 29–30.10 в ней ещё не отразились (видимо, не прошла
// авторизация). Она обещала включить их в ноябрь «Потока». Из-за них «Запас
// на сборы» за октябрь расходится со сводной на ~65 тыс. ₽.
//
// Не хватает (сверка со сводной «Октябрь 2026», категория «Сбор», юрлицо IBT):
//   GDIT USEMBASSY 185 $ — у нас 8, у Кати 7;   GDIT USEMBASSY 370 $ — 7 и 6;
//   DR-WALTER 33,38 $ — 2 и 0;                   NAIROBI ECITIZEN 35 $ — 2 и 1.
//
// Cron 10 декабря в 09:00 МСК. Считает операции кассы IBT (328) с октябрьской
// датой банка во всех файлах «Потока» (октябрь–декабрь), в каком бы месяце P&L
// они ни стояли. Письмо на director@ уходит в любом случае: внесла — короткое
// «сделала», не внесла — что именно не хватает. Работает один раз и только в
// 2026 году; cron-строку потом убрать.
//   node tools/octIbtWatch.js --dry   — только напечатать, без письма.
// ─────────────────────────────────────────────────────────────────────────
require("dotenv").config({ quiet: true });
const fs = require("fs");
const path = require("path");
const mail = require("../mail.js");

const DRY = process.argv.includes("--dry");
const TX = "/var/www/kateadmin/data/potok/tx";
const STATE = path.join(__dirname, "..", ".octIbtWatch.json");
const TO = process.env.OCT_IBT_WATCH_TO || "director@visa-sc.ru";
const IBT = "328";
const NEED = [
  { kw: "USEMBASSY", usd: 185, need: 8, rate: 98, label: "Сбор посольства США 185 $" },
  { kw: "USEMBASSY", usd: 370, need: 7, rate: 98, label: "Сбор посольства США 370 $" },
  { kw: "DR-WALTER", usd: 33.38, need: 2, rate: 110, label: "Страховка DR-WALTER 33,38 $" },
  { kw: "NAIROBI", usd: 35, need: 2, rate: 95, label: "Кения, eCitizen 35 $" },
];
const MON = { "2026-10": "октябрь", "2026-11": "ноябрь", "2026-12": "декабрь" };

const rub = (v) => Math.round(v).toLocaleString("ru-RU") + " ₽";
function loadTx(ym) {
  try { const j = JSON.parse(fs.readFileSync(path.join(TX, ym + ".json"), "utf8")); return Array.isArray(j) ? j : Object.values(j); }
  catch (_) { return []; }
}
// Операция октябрьская, если в тексте банка дата «ДД.10.26 ЧЧ:ММ». Если Катя
// внесла её руками без текста банка — по дате операции с 27.10 по 05.11.
function isOctOp(x) {
  const m = /(\d{2})\.(\d{2})\.(\d{2})\s+\d{2}:\d{2}/.exec(String(x.bankText || ""));
  if (m) return m[2] === "10" && m[3] === "26";
  const d = String(x.date || "");
  return d >= "2026-10-01" && d <= "2026-11-05";
}

async function main() {
  const now = new Date(Date.now() + 3 * 3600 * 1000);
  if (!DRY && now.getUTCFullYear() !== 2026) { console.log("octIbtWatch: не 2026 год — ничего не делаю, cron-строку пора убрать"); return; }
  let st = {}; try { st = JSON.parse(fs.readFileSync(STATE, "utf8")); } catch (_) {}
  if (!DRY && st.done) { console.log("octIbtWatch: уже отработал " + st.done); return; }

  const ops = [].concat(loadTx("2026-10"), loadTx("2026-11"), loadTx("2026-12"))
    .filter((x) => String(x.cashbox) === IBT && x.type === "out" && isOctOp(x));
  const rows = NEED.map((n) => {
    const hit = ops.filter((x) => String(x.bankText || x.description || "").toUpperCase().includes(n.kw) && Math.abs((Number(x.amountCur) || 0) - n.usd) < 0.01);
    const byPnl = {}; hit.forEach((x) => { byPnl[x.pnl] = (byPnl[x.pnl] || 0) + 1; });
    return Object.assign({}, n, { found: hit.length, byPnl, miss: Math.max(0, n.need - hit.length) });
  });
  const missRub = rows.reduce((a, r) => a + r.miss * r.usd * r.rate, 0);
  const where = (r) => Object.keys(r.byPnl).sort().map((k) => (MON[k] || k) + " " + r.byPnl[k]).join(", ") || "—";
  rows.forEach((r) => console.log(`${r.label}: нужно ${r.need}, найдено ${r.found} (${where(r)}), не хватает ${r.miss}`));
  console.log(`не внесено ≈ ${rub(missRub)}`);
  if (DRY) { console.log("--dry: письмо не отправляю, адресат " + TO); return; }

  const td = 'style="padding:6px 10px;border-bottom:1px solid #eee;text-align:right;"';
  const table = '<table style="border-collapse:collapse;font-size:14px;"><tr><th style="text-align:left;padding:6px 10px;">Операция</th>'
    + '<th ' + td + '>Должно быть</th><th ' + td + '>Внесено</th><th ' + td + '>В каком месяце P&amp;L</th><th ' + td + '>Не хватает</th></tr>'
    + rows.map((r) => '<tr><td style="padding:6px 10px;border-bottom:1px solid #eee;">' + r.label + '</td><td ' + td + '>' + r.need + '</td><td ' + td + '>' + r.found
      + '</td><td ' + td + '>' + where(r) + '</td><td ' + td + (r.miss ? ' style="color:#b0263a;font-weight:700;"' : '') + '>' + r.miss + '</td></tr>').join("")
    + '</table>';
  let subject, html;
  if (missRub < 1) {
    subject = "IBT за октябрь: Катя внесла в «Поток»";
    html = '<p>Андрей, Катя внесла в «Поток» все октябрьские операции карты IBT, о которых мы договорились (≈ 65 тыс. ₽).</p>' + table
      + '<p style="color:#888;font-size:12px;">Сторож tools/octIbtWatch.js, поставлен 13.11, разовый. Cron-строку на сервере можно убрать.</p>';
  } else {
    subject = "IBT за октябрь не внесены в «Поток» (≈ " + rub(missRub) + ")";
    html = '<p>Андрей, это сторож, которого ты попросил поставить 13.11.</p>'
      + '<p>Катя обещала включить в ноябрь «Потока» октябрьские операции карты IBT (29–30.10, ≈ 65 тыс. ₽), но к 10 декабря внесены не все. '
      + 'Не хватает на <b>≈ ' + rub(missRub) + '</b>.</p>' + table
      + '<p>Отдельно: Канада 132,22 $ у неё по курсу 95, у нас 110 (≈ 1 983 ₽).</p>'
      + '<p style="color:#888;font-size:12px;">Сторож tools/octIbtWatch.js, разовый: больше не сработает. Cron-строку на сервере можно убрать.</p>';
  }
  const r = await mail.sendMail({ to: TO, subject, html });
  console.log("octIbtWatch: письмо", r);
  if (r && r.ok) fs.writeFileSync(STATE, JSON.stringify({ done: now.toISOString(), missRub: Math.round(missRub) }));
}
main().catch((e) => { console.error("octIbtWatch:", e && e.message); process.exit(1); });
