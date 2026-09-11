// ═══════════════════════════════════════════════════════════════════════════
// Зарплатная таблица «расчет ЗП Визы» → показатели для /vsc «Ежемесячный контроль».
//
// Источник: опубликованный в интернет XLSX-экспорт ВСЕЙ книги (одна ссылка отдаёт
// все вкладки сразу — по вкладке на месяц). Публикация только на чтение, правки в
// Google подхватываются сами (кэш 6 ч + последний удачный снимок на диске, чтобы
// блок не падал, когда Google недоступен).
//
// Что берём с месячной вкладки:
//   • ФОТ общий (вкл. взносы) — собственная итоговая ячейка листа вида
//     «=<база>+SUM(<взносы>)» (в разные месяцы это AA73 / Y74 / AA74 — ищем по
//     форме формулы, а не по адресу: колонки в таблице гуляют от месяца к месяцу);
//   • взносы — слагаемые той самой SUM (взносы + ОСФР по 4 юрлицам). Строки с
//     пометкой «ЕНС» в соседней колонке НЕ считаем: это разовый платёж по ЕНС,
//     Андрей его в проценте взносов не учитывает (май 2026);
//   • ФОТ через зарплатный проект — сумма колонок «выплачено через зп проект …»
//     ПЛЮС НДФЛ (выплаты в таблице чистыми, НДФЛ отдельной колонкой; взносы
//     начисляются на грязную базу, поэтому процент считаем от неё);
//   • штат — строки сотрудников листа МИНУС учредители/управляющая
//     (Зайцева, Комисаренко, Панфилова) — так у Андрея и получается 50 в августе;
//   • отделы — колонка «Группа должности» (появилась с мая 2026);
//   • отпуска — колонка «количество дней отпуска в месяце».
//
// Ничего не пишем обратно в Google — только чтение.
// ═══════════════════════════════════════════════════════════════════════════
const axios = require("axios");
const AdmZip = require("adm-zip");
const fs = require("fs");
const path = require("path");

const ZP_XLSX = "https://docs.google.com/spreadsheets/d/e/2PACX-1vSxxDunlSJ1g1TBp9EoePjuchsY1qfD95UviisUb1vlMZWr-FNJa9vqHQodTmoSOdUoQANyFCBeQ5pl/pub?output=xlsx";
const CACHE_FILE = path.join(__dirname, ".vscZarplata.json");
const TTL_MS = 6 * 3600 * 1000;

const RU_MONTHS = ["январь", "февраль", "март", "апрель", "май", "июнь", "июль", "август", "сентябрь", "октябрь", "ноябрь", "декабрь"];
const RU_MONTH_IDX = {}; RU_MONTHS.forEach((m, i) => { RU_MONTH_IDX[m] = i; });

// Не считаем в штат (просьба Андрея): управляющая и учредители-ИП.
// Именно эти три человека (однофамильцы в таблице есть — «Зайцева Ирина» считается
// как обычный сотрудник, иначе штат расходится с ручным расчётом Андрея).
const STAFF_EXCLUDE = /зайцева\s+екатерин|комисаренко|комиссаренко|панфилова\s+галин/i;

// Группа должности → отдел. Руководители идут в СВОЙ отдел (так средние по отделам
// сходятся с ручным расчётом Андрея до копейки). Порядок важен: городские ОРК
// проверяем до общих правил. \b с кириллицей в JS не работает — границы явные.
const DEPT_BY_GROUP = [
  [/первая\s*лини/i, "pl"],
  [/орк\s*мск|клиент[а-я]*\s*мск/i, "orkMsk"],
  [/орк\s*спб|клиент[а-я]*\s*спб/i, "orkSpb"],
  [/(^|\s)оп(\s|$)|отдел\s*продаж/i, "op"],
  [/(^|\s)оо(\s|$)|отдел\s*оформлени/i, "oo"]
];
// Персональные привязки для «Администрации» (указания Андрея 11.09.2026).
const DEPT_BY_NAME = [
  [/романенко/i, "oo"],
  [/кудрин/i, "oo"]
];
const DEPT_TITLES = { pl: "Первая линия", op: "Отдел продаж", orkMsk: "ОРК Москва", orkSpb: "ОРК Санкт-Петербург", oo: "Отдел оформления", none: "Вне отделов" };
// Январь–апрель 2026: на тех листах ещё НЕТ колонки «Группа должности», разложить
// сотрудников по отделам нечем. Средние за эти месяцы взяты из таблицы Андрея
// (скриншот 11.09.2026) — разово, только чтобы история не обрывалась. С мая 2026
// колонка появилась, и всё считается из листа само.
// Январь и февраль 2026: на листе января итог «ИТОГО ФОТ» и блок взносов вообще не
// посчитаны, а февральский лист правился уже после того, как Андрей снял с него свою
// таблицу. Эти два месяца берём из его таблицы, остальные считаются из листа.
const FOT_SEED = {
  "Январь 2026": { fot: 5180319.64, contrib: 591177 },
  "Февраль 2026": { fot: 6249136.65, contrib: 591267 }
};
const DEPT_AVG_SEED = {
  "Январь 2026": { pl: 69038.66, op: 145036.41, orkMsk: 99094.06, orkSpb: 97105.09, oo: 87313.59 },
  "Февраль 2026": { pl: 77456.96, op: 145678.51, orkMsk: 99218.58, orkSpb: 112248.21, oo: 96411.42 },
  "Март 2026": { pl: 82935.22, op: 155327.80, orkMsk: 114500.71, orkSpb: 114514.80, oo: 106813.11 },
  "Апрель 2026": { pl: 79010.75, op: 167824.43, orkMsk: 104278.33, orkSpb: 135080.55, oo: 109327.95 }
};

// ── xlsx: минимальный разбор ───────────────────────────────────────────────
function colToNum(s) { let n = 0; for (let i = 0; i < s.length; i++) n = n * 26 + (s.charCodeAt(i) - 64); return n; }
function decodeXml(s) {
  return String(s).replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
}
// Ячейки бывают самозакрывающимися (<c r="D4" s="48"/>) — жадный разбор одним
// регекспом на них ломается и «съедает» следующую ячейку, поэтому идём по тегам.
function parseSheetXml(xml, shared) {
  const cells = {};
  const re = /<c\s([^>]*?)(\/)?>/g;
  let m;
  while ((m = re.exec(xml))) {
    const attrs = m[1], selfClose = !!m[2];
    const rm = /r="([A-Z]+)(\d+)"/.exec(attrs);
    if (!rm) continue;
    let body = "";
    if (!selfClose) { const end = xml.indexOf("</c>", re.lastIndex); body = end < 0 ? "" : xml.slice(re.lastIndex, end); }
    const fm = /<f[^>]*>([\s\S]*?)<\/f>/.exec(body);
    const vm = /<v>([\s\S]*?)<\/v>/.exec(body);
    let v = vm ? vm[1] : "";
    if (/t="s"/.test(attrs) && v !== "") v = shared[+v] || "";
    else if (/<is>/.test(body)) v = (body.match(/<t[^>]*>([\s\S]*?)<\/t>/g) || []).map((x) => x.replace(/<[^>]+>/g, "")).join("");
    else v = decodeXml(v);
    cells[rm[1] + rm[2]] = { col: rm[1], row: +rm[2], v: v, f: fm ? decodeXml(fm[1]) : null };
  }
  return cells;
}
function num(cell) { if (!cell) return null; const n = parseFloat(String(cell.v).replace(",", ".")); return isFinite(n) ? n : null; }
function txt(cell) { return cell ? String(cell.v || "").trim() : ""; }
const norm = (s) => String(s || "").replace(/\s+/g, " ").trim().toLowerCase();

// ── разбор одной месячной вкладки ──────────────────────────────────────────
function parseMonth(cells, monthName) {
  // 1. Шапка — строка, где в колонке A написано «Сотрудник».
  let hdrRow = 0;
  for (let r = 1; r <= 12 && !hdrRow; r++) if (norm(txt(cells["A" + r])) === "сотрудник") hdrRow = r;
  if (!hdrRow) return null;

  // 2. Заголовок → буква колонки (колонки в таблице гуляют по месяцам).
  const byHeader = {};
  const projCols = [];
  Object.keys(cells).forEach((k) => {
    const c = cells[k]; if (c.row !== hdrRow) return;
    const h = norm(c.v); if (!h) return;
    if (!byHeader[h]) byHeader[h] = c.col;
    if (h.indexOf("выплачено через зп проект") === 0) projCols.push(c.col);
  });
  const find = (...kw) => {
    const hit = Object.keys(byHeader).find((h) => kw.every((k) => h.indexOf(k) >= 0));
    return hit ? byHeader[hit] : null;
  };
  const C = {
    dept: find("группа должности"),
    hours: find("отработанное количество"),
    normHours: find("количество часов в производственном"),
    vac: find("количество дней отпуска"),
    accrued: find("начислено"),
    gross: find("итогова зп"),
    ndfl: byHeader["ндфл"] || null
  };
  if (!C.accrued || !C.gross) return null;
  projCols.sort((a, b) => colToNum(a) - colToNum(b));

  // 3. Строки сотрудников — до итоговой строки (в ней «итогова зп» = SUM(...)).
  let totalRow = 0;
  for (let r = hdrRow + 1; r <= hdrRow + 90; r++) {
    const g = cells[C.gross + r];
    // Именно итог столбца «=SUM(Y4:Y56)» целиком — у строк сотрудников в этой же
    // колонке тоже есть SUM, но с хвостом («=SUM(N4:X4)+H4+J4+L4»).
    if (g && g.f && /^SUM\([A-Z]+\d+:[A-Z]+\d+\)$/i.test(g.f.trim())) { totalRow = r; break; }
  }
  if (!totalRow) return null;

  const people = [];
  for (let r = hdrRow + 1; r < totalRow; r++) {
    const name = txt(cells["A" + r]);
    if (!name) continue;
    const group = C.dept ? txt(cells[C.dept + r]) : "";
    let dept = "none";
    const gHit = DEPT_BY_GROUP.find((x) => x[0].test(group));
    if (gHit) dept = gHit[1];
    else { const nHit = DEPT_BY_NAME.find((x) => x[0].test(name)); if (nHit) dept = nHit[1]; }
    people.push({
      name: name,
      group: group,
      dept: dept,
      accrued: num(cells[C.accrued + r]) || 0,
      vacDays: C.vac ? (num(cells[C.vac + r]) || 0) : 0,
      hours: C.hours ? num(cells[C.hours + r]) : null,
      normHours: C.normHours ? num(cells[C.normHours + r]) : null,
      counted: !STAFF_EXCLUDE.test(name)
    });
  }
  if (!people.length) return null;

  // 4. ФОТ общий (вкл. взносы) — итоговая ячейка листа «=<база>+SUM(<взносы>)».
  let fotTotal = null, contrib = null, contribRows = [];
  Object.keys(cells).forEach((k) => {
    const c = cells[k]; if (!c.f || fotTotal != null) return;
    const m = /^([A-Z]+\d+)\s*\+\s*SUM\(([A-Z]+)(\d+):([A-Z]+)(\d+)\)$/i.exec(c.f.trim());
    if (!m) return;
    const v = num(c); if (v == null || v < 100000) return;   // защита от случайных совпадений
    fotTotal = v;
    const col = m[2].toUpperCase();
    let sum = 0;
    for (let r = +m[3]; r <= +m[5]; r++) {
      const cell = cells[col + r]; const val = num(cell); if (val == null) continue;
      // Пометка в СОСЕДНЕЙ справа колонке: «ЕНС» — разовый платёж, в процент не идёт.
      const note = txt(cells[nextCol(col) + r]);
      const label = txt(cells[prevCol(col) + r]) || txt(cells[prevCol(prevCol(col)) + r]);
      if (/енс/i.test(note)) { contribRows.push({ label: label, value: val, skipped: true }); continue; }
      contribRows.push({ label: label, value: val, skipped: false });
      sum += val;
    }
    contrib = Math.round(sum * 100) / 100;
  });

  // 5. Итоговая строка: ФОТ через зарплатный проект (грязными = выплаты + НДФЛ).
  const tot = (col) => (col ? (num(cells[col + totalRow]) || 0) : 0);
  const projNet = projCols.reduce((a, c) => a + tot(c), 0);
  const ndfl = tot(C.ndfl);
  const accruedTotal = tot(C.accrued);

  // 6. Штат, средние, отделы.
  const seedFot = FOT_SEED[monthName];
  if (seedFot) { if (fotTotal == null) fotTotal = seedFot.fot; else fotTotal = seedFot.fot; if (seedFot.contrib != null) contrib = seedFot.contrib; }
  const counted = people.filter((p) => p.counted);
  const staff = counted.length;
  // Рабочих дней в месяце — из нормы производственного календаря (часы / 8).
  const normVals = people.map((p) => p.normHours).filter((x) => x && x > 40);
  const normHours = normVals.length ? normVals.sort((a, b) => a - b)[Math.floor(normVals.length / 2)] : null;
  const workDays = normHours ? Math.round(normHours / 8) : null;
  const mi = RU_MONTH_IDX[norm(monthName).split(" ")[0]];
  const year = parseInt(norm(monthName).split(" ")[1], 10);
  const calDays = (mi != null && year) ? new Date(year, mi + 1, 0).getDate() : 30;

  const depts = buildDepts(counted, workDays, calDays);

  return {
    month: monthName, year: year, mi: mi,
    people: people,                                  // внутреннее: нужно для разбора по именам, наружу не отдаём
    staff: staff,
    rows: people.length,
    excluded: people.filter((p) => !p.counted).map((p) => p.name),
    fotTotal: fotTotal != null ? Math.round(fotTotal * 100) / 100 : null,
    contrib: contrib,
    contribRows: contribRows,
    fotProject: Math.round((projNet + ndfl) * 100) / 100,
    fotProjectNet: Math.round(projNet * 100) / 100,
    ndfl: Math.round(ndfl * 100) / 100,
    contribPct: (contrib != null && projNet + ndfl > 0) ? Math.round(contrib / (projNet + ndfl) * 10000) / 100 : null,
    accruedTotal: Math.round(accruedTotal),
    avgSalary: (fotTotal != null && staff) ? Math.round(fotTotal / staff * 100) / 100 : null,
    avgAccrued: staff ? Math.round(accruedTotal / staff) : null,
    workDays: workDays, calDays: calDays,
    vacDaysTotal: Math.round(counted.reduce((a, p) => a + p.vacDays, 0) * 10) / 10,
    depts: depts,
    hasDepts: !!C.dept,
    deptAvgSeed: (!C.dept && DEPT_AVG_SEED[monthName]) ? DEPT_AVG_SEED[monthName] : null
  };
}
// Свод по отделам: штат, средняя начисленная, отпускные дни и человеко-дни с вычетом
// отпусков (отпуск в календарных днях переводим в рабочие долей месяца).
function buildDepts(counted, workDays, calDays) {
  const depts = {};
  counted.forEach((p) => {
    const d = depts[p.dept] || (depts[p.dept] = { key: p.dept, title: DEPT_TITLES[p.dept] || p.dept, staff: 0, accrued: 0, vacDays: 0 });
    d.staff++; d.accrued += p.accrued; d.vacDays += p.vacDays;
  });
  Object.keys(depts).forEach((k) => {
    const d = depts[k];
    d.avg = d.staff ? Math.round(d.accrued / d.staff) : null;
    d.effStaff = Math.round((d.staff - d.vacDays / calDays) * 100) / 100;
    d.manDays = workDays ? Math.round(d.effStaff * workDays * 10) / 10 : null;
    d.accrued = Math.round(d.accrued);
    d.vacDays = Math.round(d.vacDays * 10) / 10;
  });
  return depts;
}
function nextCol(c) { const n = colToNum(c) + 1; return numToCol(n); }
function prevCol(c) { const n = colToNum(c) - 1; return n < 1 ? c : numToCol(n); }
function numToCol(n) { let s = ""; while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); } return s; }

// ── сборка по всей книге ───────────────────────────────────────────────────
function parseWorkbook(buf) {
  const zip = new AdmZip(buf);
  const read = (n) => { const e = zip.getEntry(n); return e ? e.getData().toString("utf8") : ""; };
  const shared = [];
  {
    const sx = read("xl/sharedStrings.xml");
    const re = /<si>([\s\S]*?)<\/si>/g; let m;
    while ((m = re.exec(sx))) shared.push((m[1].match(/<t[^>]*>([\s\S]*?)<\/t>/g) || []).map((x) => decodeXml(x.replace(/<[^>]+>/g, ""))).join(""));
  }
  const wb = read("xl/workbook.xml"), rels = read("xl/_rels/workbook.xml.rels");
  const sheets = [];
  { const re = /<sheet[^>]*name="([^"]*)"[^>]*r:id="(rId\d+)"/g; let m; while ((m = re.exec(wb))) sheets.push({ name: decodeXml(m[1]), rid: m[2] }); }
  const months = {};
  sheets.forEach((sh) => {
    const mm = /^([А-Яа-яёЁ]+)\s+(20\d\d)$/.exec(sh.name.trim());
    if (!mm) return;                                   // чек-листы, Email, Лог — мимо
    if (RU_MONTH_IDX[mm[1].toLowerCase()] == null) return;
    const year = +mm[2];
    if (year < 2026) return;                           // до 2026 не показываем
    const t = new RegExp('Id="' + sh.rid + '"[^>]*Target="([^"]*)"').exec(rels);
    if (!t) return;
    const xml = read("xl/" + t[1].replace("../", ""));
    if (!xml) return;
    try {
      const parsed = parseMonth(parseSheetXml(xml, shared), sh.name.trim());
      if (parsed) months[sh.name.trim()] = parsed;
    } catch (e) { console.error("ZARPLATA: вкладка «" + sh.name + "»:", e && e.message); }
  });
  // Второй проход: у январь-апрельских листов нет колонки «Группа должности», но люди
  // те же самые. Строим карту «фамилия имя → отдел» по месяцам, где колонка есть, и
  // раскладываем ранние месяцы по именам. Кто до мая уволился — остаётся вне отделов
  // (таких 1–5 человек в месяц), поэтому средние по этим месяцам показываем из таблицы
  // Андрея (DEPT_AVG_SEED), а штат и человеко-дни считаем по карте имён.
  const nameDept = {};
  Object.keys(months).forEach((k) => {
    const m = months[k]; if (!m.hasDepts) return;
    (m.people || []).forEach((p) => { if (p.dept && p.dept !== "none") nameDept[p.name.toLowerCase()] = p.dept; });
  });
  Object.keys(months).forEach((k) => {
    const m = months[k];
    if (!m.hasDepts && Object.keys(nameDept).length) {
      let matched = 0;
      (m.people || []).forEach((p) => { const d = nameDept[p.name.toLowerCase()]; if (d) { p.dept = d; matched++; } });
      m.depts = buildDepts((m.people || []).filter((p) => p.counted), m.workDays, m.calDays);
      m.deptsFromNames = true;
      m.deptsUnmatched = (m.people || []).filter((p) => p.counted && p.dept === "none").length;
    }
    delete m.people;                                  // имена и суммы по людям наружу не отдаём
  });
  return months;
}

let _cache = null, _cacheAt = 0, _inflight = null;
function loadDisk() {
  if (_cache) return _cache;
  try { const d = JSON.parse(fs.readFileSync(CACHE_FILE, "utf8")); if (d && d.months) { _cache = d; _cacheAt = d.ts || 0; } } catch (_) {}
  return _cache;
}
async function refresh() {
  const r = await axios.get(ZP_XLSX, { timeout: 60000, responseType: "arraybuffer", maxContentLength: 64 * 1024 * 1024 });
  const months = parseWorkbook(Buffer.from(r.data));
  if (!Object.keys(months).length) throw new Error("в зарплатной таблице не разобрана ни одна месячная вкладка");
  const data = { ts: Date.now(), months: months };
  _cache = data; _cacheAt = data.ts;
  try { fs.writeFileSync(CACHE_FILE, JSON.stringify(data), "utf8"); } catch (e) { console.error("ZARPLATA cache write:", e.message); }
  console.log("ZARPLATA: обновлено, месяцев " + Object.keys(months).length);
  return data;
}
// Отдаём тёплый кэш сразу, свежее тянем в фоне (Google в проде отвечает не мгновенно).
function getZarplata(force) {
  const disk = loadDisk();
  const stale = !disk || (Date.now() - (_cacheAt || 0)) > TTL_MS;
  if (disk && !stale && !force) return Promise.resolve(disk);
  if (!_inflight) _inflight = refresh().catch((e) => { console.error("ZARPLATA:", e && e.message); if (disk) return disk; throw e; }).finally(() => { _inflight = null; });
  if (force) return _inflight;                       // ручное «обновить» — ждём свежее
  return disk ? Promise.resolve(disk) : _inflight;   // есть снимок — не заставляем ждать
}

module.exports = { getZarplata, DEPT_TITLES };
