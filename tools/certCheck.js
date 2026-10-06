// ═══════════════════════════════════════════════════════════════════════════
// Оплаты именными сертификатами по месяцам — для блока «Ежемесячного контроля»
// /vsc (Андрей 06.10.2026). Только чтение, пишет один файл .vscCerts.json.
//
// Два источника:
//   • Список сертификатов — раздел Кати «Касса → CRM-факт» на work.voyotravel.ru:
//     /var/www/kateadmin/data/kassa/amo/ГГГГ-ММ.json, days[день].certList
//     [{id, name, sum, why}]; день — по дате оплаты, файл обновляется у неё утром.
//   • Проверка заполненности — локальная копия amoCRM (.amocopy-db/crm.db): сделки,
//     где в «Способе оплаты» (449464) стоит «Именной Сертификат» (enum 1017540), но не
//     заполнены сумма (578360) или причина (578362). Такие в CRM-факт Кати не попадают
//     вообще, поэтому по её файлу их не увидеть. Копия — ноль нагрузки на amoCRM.
//
// Запускается сервером отдельным процессом (better-sqlite3 синхронный — в основном
// процессе он остановил бы сайт на время запроса).
// ═══════════════════════════════════════════════════════════════════════════
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const KATE_AMO = process.env.KATE_KASSA_AMO || "/var/www/kateadmin/data/kassa/amo";
const OUT = path.join(ROOT, ".vscCerts.json");
const FROM_YM = "2026-07";                          // CRM-факт у Кати ведётся с июля 2026
const CERT_ENUM = 1017540, F_PAY = 449464, F_SUM = 578360, F_WHY = 578362;
const RU = ["Январь", "Февраль", "Март", "Апрель", "Май", "Июнь", "Июль", "Август", "Сентябрь", "Октябрь", "Ноябрь", "Декабрь"];
const ymOf = (ts) => new Date((ts + 3 * 3600) * 1000).toISOString().slice(0, 7);
const dayOf = (ts) => new Date((ts + 3 * 3600) * 1000).toISOString().slice(0, 10);
const nameOf = (ym) => RU[+ym.slice(5, 7) - 1] + " " + ym.slice(0, 4);

// Причина → группа для свода.
function reasonKey(why) {
  const w = String(why || "").toLowerCase();
  if (/перенос/.test(w)) return "transfer";
  if (/скидк/.test(w)) return "discount";
  if (/переделк/.test(w)) return "redo";
  if (!w.trim()) return "none";
  return "other";
}
// Неполное описание: при переносе и переделке в названии должен быть номер исходной
// сделки (8+ цифр, не своей), при перекрытии скидки — видно клиента (слово с заглавной
// кириллической буквы). Это подсказка «дописать», не ошибка.
function describeIssues(c) {
  const out = [];
  const nm = String(c.name || "");
  const rk = reasonKey(c.why);
  if (rk === "transfer" || rk === "redo") {
    const nums = (nm.match(/\d{8,}/g) || []).filter((n) => Number(n) !== Number(c.id));
    if (!nums.length) out.push("нет номера исходной сделки");
  }
  if (rk === "discount" && !/[А-ЯЁ][а-яё]{2,}/.test(nm.replace(/^(Доплата|Перенос|Скидка)\b/i, ""))) out.push("не видно клиента");
  return out;
}
const OWNER_RE = /комисаренко|комиссаренко|панфилова|зайцева\s*е/i;

function readKate() {
  const months = {};
  let files = [];
  try { files = fs.readdirSync(KATE_AMO).filter((f) => /^\d{4}-\d{2}\.json$/.test(f)); } catch (e) { return { months, error: "нет доступа к CRM-факту Кати: " + e.message }; }
  files.forEach((f) => {
    const ym = f.slice(0, 7); if (ym < FROM_YM) return;
    let j; try { j = JSON.parse(fs.readFileSync(path.join(KATE_AMO, f), "utf8")); } catch (e) { months[ym] = { error: "файл не читается: " + e.message }; return; }
    const st = fs.statSync(path.join(KATE_AMO, f));
    const items = [];
    let dayTotal = 0;
    Object.keys(j.days || {}).sort().forEach((day) => {
      const d = j.days[day] || {};
      dayTotal += Number(d.cert) || 0;
      (d.certList || []).forEach((c) => items.push({ date: day, id: Number(c.id), sum: Number(c.sum) || 0, name: String(c.name || ""), why: String(c.why || "") }));
    });
    months[ym] = { items, dayTotal: Math.round(dayTotal), fileAt: st.mtimeMs };
  });
  return { months };
}

function readCrm() {
  let Database;
  try { Database = require(path.join(ROOT, "crm-svc", "node_modules", "better-sqlite3")); } catch (e) { return { error: "нет модуля копии CRM: " + e.message, leads: [] }; }
  const db = new Database(path.join(ROOT, ".amocopy-db", "crm.db"), { readonly: true, fileMustExist: true });
  const from = Math.floor(Date.UTC(+FROM_YM.slice(0, 4), +FROM_YM.slice(5, 7) - 1, 1) / 1000) - 3 * 3600;
  const rows = db.prepare("SELECT id, name, pay_ts, cf FROM leads WHERE cf LIKE ? AND pay_ts >= ?").all("%" + CERT_ENUM + "%", from);
  db.close();
  const leads = [];
  rows.forEach((r) => {
    let cf = []; try { cf = JSON.parse(r.cf || "[]"); } catch (_) {}
    const f = (id) => (Array.isArray(cf) ? cf : []).find((x) => x && x.field_id === id);
    const pay = f(F_PAY);
    // убеждаемся, что «Именной Сертификат» именно в способе оплаты, а не где-то ещё
    if (!pay || !(pay.values || []).some((v) => Number(v.enum_id) === CERT_ENUM)) return;
    const sumF = f(F_SUM), whyF = f(F_WHY);
    const sum = sumF && sumF.values && sumF.values.length ? Number(sumF.values[0].value) || 0 : null;
    const why = whyF && whyF.values && whyF.values.length ? String(whyF.values[0].value || "") : "";
    leads.push({ id: Number(r.id), name: String(r.name || ""), date: dayOf(r.pay_ts), ym: ymOf(r.pay_ts), sum, why });
  });
  return { leads };
}

function main() {
  const t0 = Date.now();
  const kate = readKate();
  let crm = { leads: [] };
  try { crm = readCrm(); } catch (e) { crm = { error: "копия CRM не читается: " + e.message, leads: [] }; }
  const yms = new Set(Object.keys(kate.months));
  crm.leads.forEach((l) => yms.add(l.ym));
  const nowYm = ymOf(Math.floor(Date.now() / 1000));
  // все месяцы с июля 2026 по текущий — даже пустые, чтобы пропуск выгрузки был виден
  for (let i = 0; i < 120; i++) {
    const d = new Date(Date.UTC(+FROM_YM.slice(0, 4), +FROM_YM.slice(5, 7) - 1 + i, 1));
    const ym = d.toISOString().slice(0, 7);
    if (ym > nowYm) break;
    yms.add(ym);
  }
  const months = {};
  [...yms].filter((ym) => ym >= FROM_YM && ym <= nowYm).sort().forEach((ym) => {
    const K = kate.months[ym] || null;
    const items = ((K && K.items) || []).map((c) => Object.assign(c, {
      reason: reasonKey(c.why),
      issues: describeIssues(c),
      owner: OWNER_RE.test(c.name),
      big: c.sum >= 20000
    }));
    const inKate = new Set(items.map((c) => c.id));
    const crmM = crm.leads.filter((l) => l.ym === ym);
    // «Не применимо» с нулевой суммой — сознательно не сертификат, не ошибка.
    const unfilled = crmM.filter((l) => !(l.sum > 0) && !/не применимо/i.test(l.why))
      .map((l) => ({ date: l.date, id: l.id, name: l.name, why: l.why, what: "нет суммы сертификата" + (!l.why ? ", нет причины" : "") }));
    const missingInKate = crmM.filter((l) => l.sum > 0 && !inKate.has(l.id)).map((l) => ({ date: l.date, id: l.id, name: l.name, sum: l.sum, why: l.why }));
    const by = {};
    items.forEach((c) => { const b = by[c.reason] || (by[c.reason] = { n: 0, sum: 0 }); b.n++; b.sum += c.sum; });
    months[ym] = {
      ym, name: nameOf(ym),
      haveKate: !!(K && !K.error), kateError: K && K.error ? K.error : null, fileAt: K ? K.fileAt : null,
      count: items.length, sum: Math.round(items.reduce((a, c) => a + c.sum, 0)),
      dayTotal: K ? K.dayTotal : null,
      byReason: by,
      items: items,
      noReason: items.filter((c) => !c.why.trim()).map((c) => c.id),
      unfilled: unfilled,
      missingInKate: missingInKate,
    };
  });
  const out = { ts: Date.now(), from: FROM_YM, kateError: kate.error || null, crmError: crm.error || null, months, ms: Date.now() - t0 };
  fs.writeFileSync(OUT + ".tmp", JSON.stringify(out), "utf8");
  fs.renameSync(OUT + ".tmp", OUT);
  console.log("CERTS: месяцев " + Object.keys(months).length + ", сертификатов " + Object.values(months).reduce((a, m) => a + m.count, 0)
    + ", не заполнено " + Object.values(months).reduce((a, m) => a + m.unfilled.length, 0) + ", " + out.ms + " мс");
}
main();
