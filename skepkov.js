// ── /skepkov — склад и производство (таблица «Остатки на складе», 08.08.2026) ──
// Отдельный модуль, монтируется из server.js: страница /skepkov + API. К ЛК VOYO,
// amoCRM и /vsc отношения не имеет — изолированный проект (мебель, WB+Ozon,
// магазины «СПК Лазурный» и «Stolmann»).
//
// Источник данных — выгрузка Google-таблицы в .xlsx. Парсим ЗДЕСЬ (adm-zip +
// разбор XML, без новых зависимостей): xlsx это zip с xml, кэшированные значения
// формул лежат в <v>, поэтому пересчёт не нужен.
//
// Что забираем из книги:
//  • активный лист месяца — его имя лежит в 'Стоки FBS WB'!G1 (сама таблица его
//    оттуда же и берёт формулой XLOOKUP), fallback — последний лист-месяц;
//  • по каждой позиции: min/max, остаток на 1-е, возвраты, произведено и
//    отгружено ПО ДНЯМ (блоки «ПРОИЗВЕДЕНО» и «ОТГРУЖЕНО» в шапке);
//  • историю месяцев (листы с «Всего произведено» / «Итого отгружено»);
//  • лист «Статистика» — заказы/выручка/реклама по дням (4 магазина);
//  • листы «Возвр*» — приход/расход возвратов помесячно.
//
// Ручные правки (ввод произведено/отгружено, изменение min/max) живут ОТДЕЛЬНЫМ
// слоем manual[] и переживают повторный импорт файла: при импорте заменяются
// только данные из xlsx, ручные значения накладываются поверх.
//
// Хранилище: .skepkov/data.json (+ backups/*.json, gitignore).
// Доступ: открытая ссылка (решение Андрея 08.08.2026) — ПДн тут нет, но есть
// себестоимость/обороты, так что при желании закрыть — см. requireSkepkov ниже.

const fs = require("fs");
const path = require("path");
const AdmZip = require("adm-zip");
const multer = require("multer");

const DIR = path.join(__dirname, ".skepkov");
const STORE_FILE = path.join(DIR, "data.json");
const BACKUP_DIR = path.join(DIR, "backups");
const MAX_BACKUPS = 20;

// ─────────────────────────── xlsx: минимальный ридер ───────────────────────────

function xmlUnescape(s) {
  if (s.indexOf("&") < 0) return s;
  return s.replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&amp;/g, "&");
}

// A1 → номер колонки (1-based)
function colOf(ref) {
  let n = 0;
  for (let i = 0; i < ref.length; i++) {
    const c = ref.charCodeAt(i);
    if (c < 65 || c > 90) break;
    n = n * 26 + (c - 64);
  }
  return n;
}

function readSharedStrings(zip) {
  const raw = zip.getEntry("xl/sharedStrings.xml");
  if (!raw) return [];
  const xml = zip.readAsText("xl/sharedStrings.xml");
  const out = [];
  const siRe = /<si>([\s\S]*?)<\/si>/g;
  let m;
  while ((m = siRe.exec(xml))) {
    let s = "";
    const tRe = /<t[^>]*>([\s\S]*?)<\/t>/g;
    let t;
    while ((t = tRe.exec(m[1]))) s += t[1];
    out.push(xmlUnescape(s));
  }
  return out;
}

// Excel-сериал → 'YYYY-MM-DD' (базa 1899-12-30, как у Excel/Sheets)
function serialToISO(n) {
  const ms = Math.round((n - 25569) * 86400000);
  const d = new Date(ms);
  if (isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}
// Похоже на дату 2015…2035 годов
function looksLikeDate(v) { return typeof v === "number" && v > 42000 && v < 50000 && Math.abs(v - Math.round(v)) < 1e-6; }

// Лист → массив строк: rows[r][c] (1-based индексы, дырки = undefined)
function readSheet(zip, entryName, shared) {
  const xml = zip.readAsText(entryName);
  const rows = [];
  const rowRe = /<row[^>]*\br="(\d+)"[^>]*>([\s\S]*?)<\/row>/g;
  let rm;
  while ((rm = rowRe.exec(xml))) {
    const rIdx = Number(rm[1]);
    const row = [];
    // ВАЖНО: пустые ячейки приходят самозакрывающимися (<c r="B1" s="3"/>), и
    // «жадный» вариант <c…>…</c> сожрал бы всё до следующего </c>. Поэтому
    // самозакрывающийся хвост разбираем в той же альтернативе, до тела.
    const cRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
    let cm;
    while ((cm = cRe.exec(rm[2]))) {
      const attrs = cm[1] || "";
      const body = cm[2] || "";
      const refM = /\br="([A-Z]+)\d+"/.exec(attrs);
      if (!refM) continue;
      const c = colOf(refM[1]);
      const tM = /\bt="([^"]+)"/.exec(attrs);
      const t = tM ? tM[1] : "n";
      let val;
      if (t === "s") {
        const v = /<v>([\s\S]*?)<\/v>/.exec(body);
        val = v ? shared[Number(v[1])] : undefined;
      } else if (t === "inlineStr") {
        let s = ""; const tRe = /<t[^>]*>([\s\S]*?)<\/t>/g; let x;
        while ((x = tRe.exec(body))) s += x[1];
        val = xmlUnescape(s);
      } else if (t === "str" || t === "e") {
        const v = /<v>([\s\S]*?)<\/v>/.exec(body);
        val = v ? xmlUnescape(v[1]) : undefined;
      } else if (t === "b") {
        const v = /<v>([\s\S]*?)<\/v>/.exec(body);
        val = v ? v[1] === "1" : undefined;
      } else {
        const v = /<v>([\s\S]*?)<\/v>/.exec(body);
        if (v) { const n = Number(v[1]); val = isNaN(n) ? xmlUnescape(v[1]) : n; }
      }
      if (val !== undefined && val !== "") row[c] = val;
    }
    rows[rIdx] = row;
  }
  return rows;
}

function openWorkbook(buf) {
  const zip = new AdmZip(buf);
  const shared = readSharedStrings(zip);
  const rels = {};
  const relXml = zip.readAsText("xl/_rels/workbook.xml.rels") || "";
  const relRe = /<Relationship\b[^>]*Id="([^"]+)"[^>]*Target="([^"]+)"/g;
  let rm;
  while ((rm = relRe.exec(relXml))) rels[rm[1]] = rm[2].replace(/^\/?xl\//, "").replace(/^\//, "");
  const wbXml = zip.readAsText("xl/workbook.xml") || "";
  const sheets = [];
  const shRe = /<sheet\b([^>]*)\/>/g;
  let sm;
  while ((sm = shRe.exec(wbXml))) {
    const a = sm[1];
    const name = /\bname="([^"]*)"/.exec(a);
    const rid = /\br:id="([^"]*)"/.exec(a);
    if (!name || !rid) continue;
    const target = rels[rid[1]];
    if (!target) continue;
    sheets.push({ name: xmlUnescape(name[1]), entry: "xl/" + target });
  }
  const cache = {};
  return {
    names: sheets.map((s) => s.name),
    sheet(name) {
      if (cache[name]) return cache[name];
      const s = sheets.find((x) => x.name === name);
      if (!s) return null;
      return (cache[name] = readSheet(zip, s.entry, shared));
    },
  };
}

// ───────────────────────────── разбор нашей книги ─────────────────────────────

const RU_MONTHS = {
  январь: 1, января: 1, янв: 1, февраль: 2, февраля: 2, фев: 2, март: 3, марта: 3, мар: 3,
  апрель: 4, апреля: 4, апр: 4, май: 5, мая: 5, июнь: 6, июня: 6, июн: 6, июль: 7, июля: 7, июл: 7,
  август: 8, августа: 8, авг: 8, сентябрь: 9, сентября: 9, сент: 9, сен: 9, октябрь: 10, октября: 10, окт: 10,
  ноябрь: 11, ноября: 11, ноя: 11, декабрь: 12, декабря: 12, дек: 12,
};
// 'АВГУСТ2026' / 'ИЮЛЬ 2026' / 'май 2026  ' → {y, m}
function monthFromSheetName(name) {
  const s = String(name).toLowerCase().trim();
  let mo = null;
  for (const k of Object.keys(RU_MONTHS)) {
    if (s.startsWith(k) || s.indexOf(k) === 0) { mo = RU_MONTHS[k]; break; }
  }
  if (mo == null) {
    for (const k of Object.keys(RU_MONTHS)) if (s.indexOf(k) >= 0) { mo = RU_MONTHS[k]; break; }
  }
  if (mo == null) return null;
  const ym = /(\d{4})/.exec(s) || /(\d{2})\s*$/.exec(s);
  let y = ym ? Number(ym[1]) : null;
  if (y && y < 100) y += 2000;
  if (!y) return null;
  return { y, m: mo, key: y + "-" + String(mo).padStart(2, "0") };
}

const norm = (s) => String(s == null ? "" : s).replace(/\s+/g, " ").replace(/ /g, " ").trim();
const low = (s) => norm(s).toLowerCase();
const num = (v) => (typeof v === "number" && isFinite(v) ? v : 0);
const isNum = (v) => typeof v === "number" && isFinite(v);

function slugId(name) {
  return low(name).replace(/[^a-zа-яё0-9]+/gi, "-").replace(/^-+|-+$/g, "").slice(0, 80);
}

// Активный лист месяца: сама таблица держит его имя в 'Стоки FBS WB'!G1
function detectMonthSheet(wb) {
  for (const n of ["Стоки FBS WB", "Стоки FBS Ozon"]) {
    const s = wb.sheet(n);
    const v = s && s[1] && s[1][7];
    if (v && wb.names.indexOf(norm(v)) >= 0) return norm(v);
    if (v && wb.names.indexOf(String(v)) >= 0) return String(v);
  }
  // fallback — самый поздний лист-месяц
  let best = null;
  for (const n of wb.names) {
    const m = monthFromSheetName(n);
    if (!m) continue;
    const s = wb.sheet(n);
    if (!s || !s[2]) continue;
    if (!best || m.key > best.key) best = { key: m.key, name: n };
  }
  return best && best.name;
}

// Блок дат в шапке: в строке 1 маркер ('ПРОИЗВЕДЕНО'/'ОТГРУЖЕНО'), дальше в
// строке 2 идут даты до ячейки «ИТОГО».
function dateBlock(rows, marker) {
  const r1 = rows[1] || [], r2 = rows[2] || [];
  let start = null;
  for (let c = 1; c < r1.length; c++) {
    if (r1[c] && low(r1[c]).indexOf(marker) === 0) { start = c; break; }
  }
  if (start == null) return null;
  const cols = [];
  let totalCol = null;
  for (let c = start; c < Math.max(r2.length, start + 60); c++) {
    const h = r2[c];
    if (h != null && low(h) === "итого") { totalCol = c; break; }
    if (looksLikeDate(h)) cols.push({ c, date: serialToISO(h) });
    else if (h != null && norm(h) !== "") cols.push({ c, date: null, label: norm(h) });
  }
  return { start, cols, totalCol };
}

function parseMonthSheet(wb, sheetName) {
  const rows = wb.sheet(sheetName);
  if (!rows) return null;
  const r2 = rows[2] || [];
  const H = {}; // заголовок → колонка
  for (let c = 1; c < r2.length; c++) if (r2[c] != null) H[low(r2[c])] = c;
  const find = (...alts) => {
    for (const a of alts) {
      for (const k of Object.keys(H)) if (k.indexOf(a) === 0) return H[k];
    }
    return null;
  };
  const cOzon = find("артикул ozon", "артикул озон");
  const cWb = find("артикул вб", "артикул wb");
  const cBar = find("баркод");
  const cArt = find("артикул продавца (текущ", "артикул продавца");
  const cArtNew = H["артикул продавца нов"] || null;
  const cMin = find("min", "мин");
  const cMax = find("max", "макс");
  const cOpen = find("остаток на");
  const cRet = find("возврат");
  // «остаток текущий» встречается дважды: шт. и кор. для МП
  const curCols = [];
  for (let c = 1; c < r2.length; c++) if (r2[c] != null && low(r2[c]).indexOf("остаток текущий") === 0) curCols.push(c);
  const cCur = curCols[0] || null, cCurBox = curCols[1] || null;
  // имя позиции — первая текстовая колонка без своего заголовка (в августе это F)
  let cName = null;
  const r3 = rows[3] || [];
  for (let c = 1; c <= 8; c++) {
    if (typeof r3[c] === "string" && norm(r3[c]).length > 12 && c !== cArt && c !== cArtNew) { cName = c; break; }
  }
  if (!cName) cName = 6;

  const prodB = dateBlock(rows, "произведен") || { cols: [] };
  const shipB = dateBlock(rows, "отгруж") || { cols: [] };

  const skus = [];
  for (let r = 3; r < rows.length; r++) {
    const row = rows[r] || [];
    const name = norm(row[cName]);
    if (!name) continue;
    if (low(name) === "итого" || low(name).indexOf("итого") === 0) continue;
    const prod = {}, ship = {};
    for (const q of prodB.cols) { const v = row[q.c]; if (isNum(v) && v !== 0) prod[q.date || q.label] = v; }
    for (const q of shipB.cols) { const v = row[q.c]; if (isNum(v) && v !== 0) ship[q.date || q.label] = Math.abs(v); }
    const cur = cCur ? num(row[cCur]) : null;
    const box = cCurBox ? num(row[cCurBox]) : null;
    let boxDiv = 1;
    if (cur > 0 && box > 0) { const k = cur / box; if (k > 1.7 && k < 2.3) boxDiv = 2; else if (k > 3.4 && k < 4.6) boxDiv = 4; }
    else if (/\b4\s*шт/i.test(name)) boxDiv = 4;
    else if (/\b2\s*шт/i.test(name)) boxDiv = 2;
    skus.push({
      id: slugId(name),
      name,
      artOzon: row[cOzon] != null ? norm(row[cOzon]) : "",
      artWb: row[cWb] != null ? norm(row[cWb]) : "",
      barcode: row[cBar] != null ? norm(row[cBar]) : "",
      art: row[cArt] != null ? norm(row[cArt]) : "",
      artNew: cArtNew && row[cArtNew] != null ? norm(row[cArtNew]) : "",
      min: cMin ? num(row[cMin]) : 0,
      max: cMax ? num(row[cMax]) : 0,
      opening: cOpen ? num(row[cOpen]) : 0,
      returns: cRet ? num(row[cRet]) : 0,
      boxDiv,
      xlsxStock: cur,
      prod, ship,
    });
  }
  // даты блоков (только настоящие даты, для сетки ввода)
  const prodDates = prodB.cols.filter((x) => x.date).map((x) => x.date);
  const shipDates = shipB.cols.filter((x) => x.date).map((x) => x.date);
  const mk = monthFromSheetName(sheetName) || (shipDates[0] ? { key: shipDates[0].slice(0, 7) } : null);
  return { sheetName, monthKey: mk && mk.key, prodDates, shipDates, skus };
}

// История: листы прошлых месяцев с «Всего произведено» / «Итого отгружено»
function parseHistory(wb, currentSheet) {
  const out = [];
  for (const n of wb.names) {
    if (n === currentSheet) continue;
    const mk = monthFromSheetName(n);
    if (!mk) continue;
    const rows = wb.sheet(n);
    if (!rows || !rows[2]) continue;
    const r2 = rows[2];
    let cProd = null, cShip = null;
    for (let c = 1; c < r2.length; c++) {
      const h = low(r2[c]);
      if (!h) continue;
      if (h.indexOf("всего произведено") === 0) cProd = c;
      if (h.indexOf("итого отгружено") === 0) cShip = c;
    }
    if (cProd == null && cShip == null) continue;
    let prod = 0, ship = 0, items = 0;
    for (let r = 3; r < rows.length; r++) {
      const row = rows[r] || [];
      if (!norm(row[1])) continue;
      items++;
      if (cProd) prod += num(row[cProd]);
      if (cShip) ship += Math.abs(num(row[cShip]));
    }
    out.push({ sheet: n, key: mk.key, produced: Math.round(prod), shipped: Math.round(ship), items });
  }
  out.sort((a, b) => (a.key < b.key ? -1 : 1));
  return out;
}

// Лист «Статистика» — по дням: заказы / выручка / реклама (4 магазина)
function parseStats(wb) {
  const rows = wb.sheet("Статистика");
  if (!rows) return [];
  const out = [];
  for (let r = 3; r < rows.length; r++) {
    const row = rows[r] || [];
    const d = row[1];
    if (!looksLikeDate(d)) continue;
    const date = serialToISO(d);
    const ordersWb = num(row[4]), revWb = num(row[5]), adWbSpk = num(row[6]);
    const unitsOz = num(row[9]), revOz = num(row[10]), adOzSpk = num(row[11]);
    const ordersWbS = num(row[17]), revWbS = num(row[18]), adWbSt = num(row[19]);
    const unitsOzS = num(row[22]), revOzS = num(row[23]), adOzSt = num(row[24]);
    const orders = ordersWb + unitsOz + ordersWbS + unitsOzS;
    const revenue = revWb + revOz + revWbS + revOzS;
    const ad = adWbSpk + adOzSpk + adWbSt + adOzSt;
    if (!orders && !revenue && !ad) continue;
    out.push({
      d: date, orders, revenue, ad,
      spk: { wbOrders: ordersWb, wbRev: revWb, ozUnits: unitsOz, ozRev: revOz, ad: adWbSpk + adOzSpk },
      st: { wbOrders: ordersWbS, wbRev: revWbS, ozUnits: unitsOzS, ozRev: revOzS, ad: adWbSt + adOzSt },
    });
  }
  out.sort((a, b) => (a.d < b.d ? -1 : 1));
  // помечаем выбросы: выручка дня > 5× медианы (в книге 01.07.2026 = 24,9 млн при 86 заказах)
  const vals = out.map((x) => x.revenue).filter((x) => x > 0).sort((a, b) => a - b);
  const med = vals.length ? vals[Math.floor(vals.length / 2)] : 0;
  if (med > 0) for (const x of out) if (x.revenue > med * 5) x.suspect = true;
  return out;
}

// Листы «Возвр…» — итог месяца: приход ВБ / приход Озон / расход (колонки B,C,D)
function parseReturns(wb) {
  const out = [];
  for (const n of wb.names) {
    if (!/^возвр/i.test(norm(n))) continue;
    const rows = wb.sheet(n);
    if (!rows) continue;
    let inWb = 0, inOz = 0, outQ = 0;
    for (let r = 3; r < rows.length; r++) {
      const row = rows[r] || [];
      if (!norm(row[1])) continue;
      inWb += num(row[2]); inOz += num(row[3]); outQ += num(row[4]);
    }
    const mk = monthFromSheetName(n);
    out.push({ sheet: n, key: mk && mk.key, inWb: Math.round(inWb), inOz: Math.round(inOz), out: Math.round(outQ) });
  }
  return out;
}

function parseWorkbook(buf, sourceName) {
  const wb = openWorkbook(buf);
  const monthSheet = detectMonthSheet(wb);
  if (!monthSheet) throw new Error("Не нашёл лист текущего месяца — проверь, что это выгрузка «Остатки на складе»");
  const cur = parseMonthSheet(wb, monthSheet);
  if (!cur || !cur.skus.length) throw new Error("Лист «" + monthSheet + "» разобран, но позиций не найдено");
  return {
    importedAt: new Date().toISOString(),
    sourceName: sourceName || "",
    sheets: wb.names,
    monthSheet,
    monthKey: cur.monthKey,
    prodDates: cur.prodDates,
    shipDates: cur.shipDates,
    skus: cur.skus,
    history: parseHistory(wb, monthSheet),
    stats: parseStats(wb),
    returns: parseReturns(wb),
  };
}

// ─────────────────────────────── хранилище ───────────────────────────────

function emptyStore() {
  return { base: null, manual: {}, notes: {}, updatedAt: null };
}
let _store = null;
function store() {
  if (_store) return _store;
  try { _store = JSON.parse(fs.readFileSync(STORE_FILE, "utf8")); } catch (_) { _store = emptyStore(); }
  if (!_store.manual) _store.manual = {};
  if (!_store.notes) _store.notes = {};
  return _store;
}
function save() {
  try { fs.mkdirSync(DIR, { recursive: true }); } catch (_) {}
  _store.updatedAt = new Date().toISOString();
  fs.writeFileSync(STORE_FILE, JSON.stringify(_store), "utf8");
}
function backup(tag) {
  try {
    if (!fs.existsSync(STORE_FILE)) return;
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const f = path.join(BACKUP_DIR, new Date().toISOString().replace(/[:.]/g, "-") + "-" + (tag || "auto") + ".json");
    fs.copyFileSync(STORE_FILE, f);
    const all = fs.readdirSync(BACKUP_DIR).filter((x) => x.endsWith(".json")).sort();
    while (all.length > MAX_BACKUPS) { try { fs.unlinkSync(path.join(BACKUP_DIR, all.shift())); } catch (_) {} }
  } catch (_) {}
}

// Итоговый вид для клиента: xlsx + ручной слой поверх.
// manual: { "<skuId>|<YYYY-MM-DD>|prod|ship": число, "<skuId>|min|max|opening|returns": число }
function composed() {
  const s = store();
  if (!s.base) return { empty: true, updatedAt: s.updatedAt };
  const man = s.manual || {};
  const skus = s.base.skus.map((k) => {
    const o = Object.assign({}, k, { prod: Object.assign({}, k.prod), ship: Object.assign({}, k.ship), edited: {} });
    return o;
  });
  const byId = {};
  for (const k of skus) byId[k.id] = k;
  // позиции, которых нет в выгрузке, но их завели руками
  for (const key of Object.keys(man)) {
    const p = key.split("|");
    const k = byId[p[0]];
    if (!k) continue;
    const v = man[key];
    if (p.length === 3) {
      const kind = p[2] === "prod" ? "prod" : "ship";
      if (v === null || v === 0) delete k[kind][p[1]]; else k[kind][p[1]] = v;
      k.edited[p[1] + "|" + kind] = true;
    } else if (p.length === 2) {
      if (["min", "max", "opening", "returns"].indexOf(p[1]) >= 0) { k[p[1]] = v; k.edited[p[1]] = true; }
    }
  }
  const sum = (o) => Object.keys(o).reduce((a, d) => a + (Number(o[d]) || 0), 0);
  for (const k of skus) {
    k.produced = sum(k.prod);
    k.shipped = sum(k.ship);
    k.stock = Math.round(k.opening + k.produced + k.returns - k.shipped);
  }
  return {
    empty: false,
    updatedAt: s.updatedAt,
    importedAt: s.base.importedAt,
    sourceName: s.base.sourceName,
    monthSheet: s.base.monthSheet,
    monthKey: s.base.monthKey,
    prodDates: s.base.prodDates,
    shipDates: s.base.shipDates,
    history: s.base.history,
    stats: s.base.stats,
    returns: s.base.returns,
    notes: s.notes,
    skus,
  };
}

// ─────────────────────────────── монтирование ───────────────────────────────

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

function mount(app, opts) {
  const o = opts || {};
  // Гейт доступа. Сейчас открыт (решение Андрея). Чтобы закрыть — передать
  // requireAccess из server.js (например requireAdmin) при монтировании.
  const gate = typeof o.requireAccess === "function" ? o.requireAccess : (req, res, next) => next();

  app.get("/skepkov", (req, res) => {
    res.set("Cache-Control", "no-store, no-cache, must-revalidate");
    res.sendFile(path.join(__dirname, "public", "skepkov.html"));
  });

  app.get("/api/skepkov/data", gate, (req, res) => res.json({ success: true, data: composed() }));

  // Импорт выгрузки. Заменяет ТОЛЬКО слой xlsx; ручные правки остаются.
  app.post("/api/skepkov/import", gate, upload.single("file"), (req, res) => {
    if (!req.file || !req.file.buffer) return res.status(400).json({ success: false, message: "Файл не пришёл" });
    // multer отдаёт originalname в latin1 — русские имена файлов иначе кракозябрят
    let fname = req.file.originalname || "";
    try { fname = Buffer.from(fname, "latin1").toString("utf8"); } catch (_) {}
    let parsed;
    try { parsed = parseWorkbook(req.file.buffer, fname); }
    catch (e) { return res.status(400).json({ success: false, message: e.message || "Не смог разобрать файл" }); }
    backup("before-import");
    const s = store();
    const prevMonth = s.base && s.base.monthKey;
    s.base = parsed;
    // сменился месяц — ручные правки прошлого месяца больше не нужны
    if (prevMonth && parsed.monthKey && prevMonth !== parsed.monthKey) {
      const keep = {};
      for (const k of Object.keys(s.manual)) {
        const p = k.split("|");
        if (p.length === 3 && String(p[1]).slice(0, 7) !== parsed.monthKey) continue;
        keep[k] = s.manual[k];
      }
      s.manual = keep;
    }
    save();
    return res.json({ success: true, data: composed(), stat: { skus: parsed.skus.length, months: parsed.history.length, days: parsed.stats.length } });
  });

  // Точечная правка: {sku, date, kind:'prod'|'ship', qty} либо {sku, field:'min'|'max'|'opening'|'returns', value}
  app.post("/api/skepkov/entry", gate, (req, res) => {
    const s = store();
    if (!s.base) return res.status(400).json({ success: false, message: "Сначала загрузите таблицу" });
    const b = req.body || {};
    const sku = String(b.sku || "");
    if (!s.base.skus.some((k) => k.id === sku)) return res.status(400).json({ success: false, message: "Нет такой позиции" });
    if (b.field) {
      if (["min", "max", "opening", "returns"].indexOf(b.field) < 0) return res.status(400).json({ success: false, message: "bad field" });
      const v = Number(b.value);
      if (!isFinite(v) || v < -100000 || v > 1000000) return res.status(400).json({ success: false, message: "bad value" });
      s.manual[sku + "|" + b.field] = v;
    } else {
      const date = String(b.date || "");
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ success: false, message: "bad date" });
      const kind = b.kind === "prod" ? "prod" : "ship";
      const v = Number(b.qty);
      if (!isFinite(v) || v < 0 || v > 100000) return res.status(400).json({ success: false, message: "bad qty" });
      s.manual[sku + "|" + date + "|" + kind] = v;
    }
    if (Object.keys(s.manual).length > 200000) return res.status(413).json({ success: false, message: "too many edits" });
    save();
    return res.json({ success: true, data: composed() });
  });

  // Заметка к позиции (комментарий для производства)
  app.post("/api/skepkov/note", gate, (req, res) => {
    const s = store();
    const sku = String((req.body && req.body.sku) || "");
    const text = String((req.body && req.body.text) || "").slice(0, 500);
    if (!sku) return res.status(400).json({ success: false, message: "bad sku" });
    if (text) s.notes[sku] = text; else delete s.notes[sku];
    save();
    return res.json({ success: true });
  });

  // Откат ручного слоя (целиком либо по одной позиции)
  app.post("/api/skepkov/reset", gate, (req, res) => {
    const s = store();
    backup("before-reset");
    const sku = (req.body && req.body.sku) || null;
    if (sku) {
      for (const k of Object.keys(s.manual)) if (k.split("|")[0] === sku) delete s.manual[k];
    } else s.manual = {};
    save();
    return res.json({ success: true, data: composed() });
  });
}

module.exports = { mount, parseWorkbook, openWorkbook };
