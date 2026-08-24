// ─────────────────────────────────────────────────────────────────────────
// Сканер документов (/scanner) — распознавание паспортов для сотрудников.
// Переписан 22.08.2026 по задаче Андрея: раньше была браузерная OCR-демка
// (tesseract.js), теперь полноценный сервис.
//
// Как устроено (гибрид — точность там, где она бесплатна):
//  1. MRZ (две машиночитаемые строки внизу загранпаспорта) разбирается ЗДЕСЬ,
//     кодом, с проверкой контрольных цифр. Это даёт номер, даты рождения и
//     окончания, пол, гражданство и латиницу ФИО — без вариантов и без ИИ.
//  2. Всё остальное (кириллица ФИО с отчеством, место рождения, кем и когда
//     выдан) читает Claude по фото — то, что OCR общего назначения делал плохо.
//     Модель заодно переписывает MRZ, и её версия сверяется с нашим разбором:
//     совпало — ставим галочку, разошлось — предупреждение в карточке.
//  3. Где MRZ и визуальная зона противоречат друг другу, верим MRZ (если её
//     контрольные цифры сошлись).
//
// Обучение: сотрудник правит поле и пишет комментарий → правка сохраняется,
// из неё дешёвой моделью выводятся ОБЩИЕ правила, которые подмешиваются во все
// последующие распознавания (как «память» в переводах).
//
// ПДн: фото паспортов не хранятся дольше нужного — SCANNER_KEEP_DAYS (3 дня),
// а по документам с правками — SCANNER_KEEP_CORRECTED_DAYS (30 дней, нужны для
// разбора ошибок). Сами распознанные поля остаются в журнале.
//
// env: ANTHROPIC_API_KEY (обязателен), ANTHROPIC_BASE_URL/TRANSLATE_PROXY —
// общий канал с переводами; SCANNER_MODEL (дефолт claude-haiku-4-5),
// SCANNER_MODEL_HARD (дефолт claude-sonnet-5 — вторая попытка, если с первой
// не сошлось), SCANNER_CODE (код входа, дефолт — код переводов).
// ─────────────────────────────────────────────────────────────────────────
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const multer = require("multer");

const DIR = path.join(__dirname, ".scanner");
const FILES_DIR = path.join(DIR, "files");
const STORE_FILE = path.join(DIR, "store.json");

const MAX_DOCS = 3000;
const MAX_LESSONS_IN_PROMPT = 40;
const KEEP_DAYS = Number(process.env.SCANNER_KEEP_DAYS || 3);
const KEEP_CORRECTED_DAYS = Number(process.env.SCANNER_KEEP_CORRECTED_DAYS || 30);
// Сколько живёт САМА запись в истории сканирований (поля без фото) — как срок
// хранения заказов в переводах.
const KEEP_HISTORY_DAYS = Number(process.env.SCANNER_KEEP_HISTORY_DAYS || 90);

function ensureDirs() { try { fs.mkdirSync(FILES_DIR, { recursive: true }); } catch (_) {} }
let _store = null;
function store() {
  if (_store) return _store;
  try { _store = JSON.parse(fs.readFileSync(STORE_FILE, "utf8")); } catch (_) { _store = null; }
  if (!_store || typeof _store !== "object") _store = {};
  if (!Array.isArray(_store.docs)) _store.docs = [];
  if (!Array.isArray(_store.lessons)) _store.lessons = [];
  if (!Array.isArray(_store.corrections)) _store.corrections = [];
  if (!Array.isArray(_store.examples)) _store.examples = [];
  if (!_store.copyStats || typeof _store.copyStats !== "object") _store.copyStats = {};
  if (!_store.auth) _store.auth = {};
  return _store;
}
function save() {
  ensureDirs();
  try { fs.writeFileSync(STORE_FILE, JSON.stringify(store(), null, 1), "utf8"); }
  catch (e) { console.error("scanner save:", e.message); }
}
function newId() { return crypto.randomBytes(6).toString("hex"); }
function lessons() { return store().lessons; }

// ── MRZ: разбор и контрольные цифры (ICAO 9303, формат TD3 — загранпаспорт) ──
function mrzCharValue(c) {
  if (c === "<") return 0;
  if (c >= "0" && c <= "9") return c.charCodeAt(0) - 48;
  if (c >= "A" && c <= "Z") return c.charCodeAt(0) - 55; // A=10 … Z=35
  return -1;
}
function mrzCheckDigit(s) {
  const w = [7, 3, 1];
  let sum = 0;
  for (let i = 0; i < s.length; i++) {
    const v = mrzCharValue(s[i]);
    if (v < 0) return -1;
    sum += v * w[i % 3];
  }
  return sum % 10;
}
function mrzDate(yymmdd, kind) {
  if (!/^\d{6}$/.test(yymmdd)) return "";
  const yy = Number(yymmdd.slice(0, 2)), mm = yymmdd.slice(2, 4), dd = yymmdd.slice(4, 6);
  const nowYY = new Date().getFullYear() % 100;
  // Дата рождения не бывает в будущем; срок действия — наоборот, всегда вперёд.
  const century = kind === "birth" ? (yy > nowYY ? 1900 : 2000) : (yy < 70 ? 2000 : 1900);
  return dd + "." + mm + "." + (century + yy);
}
function cleanMrzLine(s) {
  return String(s || "").toUpperCase().replace(/[«»]/g, "<").replace(/[^A-Z0-9<]/g, "");
}
// Имена из первой строки: P<RUS SURNAME<<GIVEN<NAMES
function mrzNames(l1) {
  // Модель нередко дописывает в конец первой строки хвост второй («…<<02»),
  // поэтому оставляем только буквенные слова: в именах цифр не бывает.
  const clean = (x) => String(x || "").replace(/</g, " ").split(/\s+/)
    .filter((w) => w && /^[A-Z-]+$/.test(w)).join(" ").trim();
  let surname = "", given = "";
  if (l1.length >= 6) {
    const names = l1.slice(5).replace(/<+$/, "");
    const parts = names.split("<<");
    surname = clean(parts[0]);
    given = clean(parts.slice(1).join(" "));
  }
  return { surname, given };
}
// Разбор пары строк TD3.
//
// ВАЖНО: модель переписывает MRZ почти верно, но регулярно ошибается на один
// знак в длинных цепочках «<» и иногда теряет контрольную цифру — тогда жёсткий
// разбор «по позициям» разъезжается целиком. Поэтому разбираем в два захода:
// сначала строго по ICAO, а если контрольные цифры не сошлись — по «якорю»
// (гражданство + дата рождения + пол + срок), который стоит в середине строки и
// от сбитой длины хвоста не зависит. Что не подтвердилось контрольной цифрой,
// потом сверяется с напечатанным в паспорте (см. buildFields).
function parseMrzTd3(l1raw, l2raw) {
  const l1 = cleanMrzLine(l1raw), l2 = cleanMrzLine(l2raw);
  if (l2.length < 26) return null;
  const nm = mrzNames(l1);
  const make = (num, numChk, nat, bd, bdChk, sex, ed, edChk, how) => {
    const checks = {
      number: numChk === "" ? null : mrzCheckDigit(num) === Number(numChk),
      birth: mrzCheckDigit(bd) === Number(bdChk),
      expiry: mrzCheckDigit(ed) === Number(edChk),
    };
    return {
      line1: l1, line2: l2, how,
      docCode: l1.slice(0, 1), issuingState: l1.slice(2, 5),
      number: String(num).replace(/</g, ""),
      nationality: String(nat).replace(/</g, ""),
      birthDate: mrzDate(bd, "birth"),
      expiryDate: mrzDate(ed, "expiry"),
      sex: sex === "M" ? "М" : sex === "F" ? "Ж" : "",
      surnameLat: nm.surname, nameLat: nm.given,
      checks, valid: checks.number === true && checks.birth === true && checks.expiry === true,
    };
  };
  // 1) Строго по позициям ICAO 9303.
  const strict = make(l2.slice(0, 9), l2.slice(9, 10), l2.slice(10, 13), l2.slice(13, 19),
    l2.slice(19, 20), l2.slice(20, 21), l2.slice(21, 27), l2.slice(27, 28), "строго");
  if (strict.valid) return strict;
  // 2) По якорю: 3 буквы гражданства + 6 цифр + контрольная + пол + 6 цифр + контрольная.
  const m = l2.match(/([A-Z]{3})(\d{6})(\d)([MFX<])(\d{6})(\d)/);
  if (m) {
    const head = l2.slice(0, m.index);            // номер (+ контрольная, если не потеряна)
    let num = head, numChk = "";
    if (head.length >= 10) { num = head.slice(-10, -1); numChk = head.slice(-1); }
    else if (head.length === 9) { num = head; numChk = ""; }   // контрольная выпала при переписывании
    const loose = make(num, numChk, m[1], m[2], m[3], m[4], m[5], m[6], "по якорю");
    // Берём «якорный» разбор, если он подтверждён хотя бы датами.
    if (loose.checks.birth || loose.checks.expiry) return loose;
  }
  return strict;
}
// Номер российского загранпаспорта печатают как «75 8340533».
function prettyRuNumber(n) {
  const d = String(n || "").replace(/\D/g, "");
  return d.length === 9 ? d.slice(0, 2) + " " + d.slice(2) : String(n || "");
}
function onlyDigits(s) { return String(s || "").replace(/\D/g, ""); }
function normDate(s) {
  const m = String(s || "").match(/(\d{1,2})[.\-/\s](\d{1,2})[.\-/\s](\d{2,4})/);
  if (!m) return String(s || "").trim();
  const dd = m[1].padStart(2, "0"), mm = m[2].padStart(2, "0");
  let yy = m[3];
  if (yy.length === 2) yy = (Number(yy) > new Date().getFullYear() % 100 ? "19" : "20") + yy;
  return dd + "." + mm + "." + yy;
}

// ── Транслитерация кириллицы по правилам загранпаспорта (ICAO Doc 9303,
// в РФ применяется с 2014 г.). Нужна для полей, которых в MRZ нет: отчество,
// место рождения, орган выдачи. Проверено на паспорте: ВИКТОРОВИЧ → VIKTOROVICH,
// СВЕРДЛОВСКАЯ ОБЛ. → SVERDLOVSKAIA OBL., МВД → MVD.
const TRANSLIT = {
  А: "A", Б: "B", В: "V", Г: "G", Д: "D", Е: "E", Ё: "E", Ж: "ZH", З: "Z", И: "I",
  Й: "I", К: "K", Л: "L", М: "M", Н: "N", О: "O", П: "P", Р: "R", С: "S", Т: "T",
  У: "U", Ф: "F", Х: "KH", Ц: "TS", Ч: "CH", Ш: "SH", Щ: "SHCH", Ъ: "IE", Ы: "Y",
  Ь: "", Э: "E", Ю: "IU", Я: "IA",
};
// Гражданство по-английски — это НЕ транслитерация: нужны официальные названия
// стран. Берём по трёхбуквенному коду из MRZ (ISO 3166), а если MRZ нет —
// по написанию в паспорте.
const NAT_EN = {
  RUS: "RUSSIAN FEDERATION", KAZ: "KAZAKHSTAN", BLR: "BELARUS", UKR: "UKRAINE",
  UZB: "UZBEKISTAN", ARM: "ARMENIA", AZE: "AZERBAIJAN", GEO: "GEORGIA",
  KGZ: "KYRGYZSTAN", TJK: "TAJIKISTAN", TKM: "TURKMENISTAN", MDA: "MOLDOVA",
  LTU: "LITHUANIA", LVA: "LATVIA", EST: "ESTONIA", ISR: "ISRAEL", TUR: "TURKEY",
  DEU: "GERMANY", USA: "UNITED STATES OF AMERICA", GBR: "UNITED KINGDOM",
  FRA: "FRANCE", ITA: "ITALY", ESP: "SPAIN", CHN: "CHINA", IND: "INDIA",
  SRB: "SERBIA", MNE: "MONTENEGRO", THA: "THAILAND", ARE: "UNITED ARAB EMIRATES",
};
const NAT_RU_EN = {
  "РОССИЙСКАЯ ФЕДЕРАЦИЯ": "RUSSIAN FEDERATION", "РОССИЯ": "RUSSIAN FEDERATION",
  "КАЗАХСТАН": "KAZAKHSTAN", "БЕЛАРУСЬ": "BELARUS", "БЕЛОРУССИЯ": "BELARUS",
  "УКРАИНА": "UKRAINE", "УЗБЕКИСТАН": "UZBEKISTAN", "АРМЕНИЯ": "ARMENIA",
  "АЗЕРБАЙДЖАН": "AZERBAIJAN", "ГРУЗИЯ": "GEORGIA", "КИРГИЗИЯ": "KYRGYZSTAN",
  "КЫРГЫЗСТАН": "KYRGYZSTAN", "ТАДЖИКИСТАН": "TAJIKISTAN", "МОЛДОВА": "MOLDOVA",
};
function citizenshipEn(ru, natCode) {
  const code = String(natCode || "").toUpperCase().trim();
  if (NAT_EN[code]) return NAT_EN[code];
  const key = String(ru || "").toUpperCase().replace(/[^А-ЯЁ ]/g, "").trim();
  if (NAT_RU_EN[key]) return NAT_RU_EN[key];
  // В паспорте латинское название часто напечатано рядом через дробь.
  const lat = String(ru || "").match(/[A-Z][A-Z ]{3,}/);
  return lat ? lat[0].trim() : "";
}
function translit(sIn) {
  const src = String(sIn || "").toUpperCase();
  let out = "";
  for (const ch of src) out += Object.prototype.hasOwnProperty.call(TRANSLIT, ch) ? TRANSLIT[ch] : ch;
  return out;
}

// Расстояние Левенштейна — отличить «модель сбилась на знак» от «прочитала другое слово».
function editDist(a, b) {
  a = String(a || ""); b = String(b || "");
  if (a === b) return 0;
  if (!a.length || !b.length) return Math.max(a.length, b.length);
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

// Кириллица прочитана с ошибкой в одну букву — а латиница в MRZ говорит, как
// должно быть: «СЫГАНКОВА» при «TSYGANKOVA» это «ЦЫГАНКОВА», «ЮЛЯ» при
// «IULIIA» это «ЮЛИЯ». Перебираем все правки в один знак (замена, удаление,
// вставка) и берём ту, чья транслитерация совпадает с MRZ ТОЧНО. Замена
// вперёд удаления и вставки: она сохраняет длину прочитанного, а значит ближе
// к тому, что модель действительно видела. Если внутри одного вида правок
// подходит несколько разных слов — не угадываем, оставляем как есть.
const AZBUKA = "АБВГДЕЁЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯ".split("");
function repairByMrz(cyr, mrzLat) {
  const src = String(cyr || "");
  if (!src || !mrzLat || src.length > 40) return null;
  const uniq = (arr) => Array.from(new Set(arr));
  // Отсекаем заведомо нерусские сочетания: иначе к «ЮЛИЯ» в кандидаты лезет
  // «ЮЛЙЯ» (транслитерация та же), и выбрать не из чего.
  const looksRussian = (c) => !/^[ЬЪЫ]/.test(c) && !/Й[АЕЁИОУЫЭЮЯ]/.test(c) &&
    !/[ЬЪ][ЬЪ]/.test(c) && !/(.)\1\1/.test(c) && !/[АЕЁИОУЫЭЮЯ][ЬЪ]/.test(c);
  const fits = (c) => c.length > 1 && looksRussian(c) && translit(c) === mrzLat;
  const swaps = [], drops = [], adds = [];
  for (let i = 0; i < src.length; i++) {
    for (const ch of AZBUKA) {
      // Ь и Ъ в транслитерации пустые, поэтому замена на них «подходит» почти
      // всегда и превращает «СПЫЛИКХИНА» в «СПЫЛИЬХИНА». Заменять на них нельзя.
      if (ch === src[i] || ch === "Ь" || ch === "Ъ") continue;
      const c = src.slice(0, i) + ch + src.slice(i + 1);
      if (fits(c)) swaps.push(c);
    }
    const d = src.slice(0, i) + src.slice(i + 1);
    if (fits(d)) drops.push(d);
  }
  for (let i = 0; i <= src.length; i++) {
    for (const ch of AZBUKA) {
      const c = src.slice(0, i) + ch + src.slice(i);
      if (fits(c)) adds.push(c);
    }
  }
  for (const list of [uniq(swaps), uniq(drops), uniq(adds)]) {
    if (list.length === 1) return list[0];
    if (list.length > 1) return null;                    // несколько вариантов — не гадаем
  }
  return null;
}

// Имена в MRZ НЕ защищены контрольной цифрой (она считается только по номеру,
// датам и служебным полям второй строки), поэтому ошибка модели в первой строке
// проходит мимо всех проверок — «MRZ сошлась», а фамилия неверная. Единственная
// опора — латиница, напечатанная в визуальной зоне: в загранпаспорте РФ она
// совпадает с MRZ всегда, любое расхождение = чья-то ошибка чтения.
//
// Что чиним:
//   1) имя, заехавшее в фамилию (модель потеряла второй «<» разделителя);
//   2) фамилию, прочитанную с ошибкой («KOMISARENKO» → «KOMISAR», «KOMIISARENKO»).
//
// Считать мелкое расхождение «официальной транслитерацией» нельзя: в паспорте
// латиница печатается ровно та же, что в MRZ, поэтому ЛЮБОЕ различие — чья-то
// ошибка чтения, хоть на один знак (так и вышло с «KOMIISARENKO»). Кто из двух
// прав, решает третий, независимый от латиницы источник: транслитерация
// кириллической фамилии нашей же таблицей ICAO. Он не годится как главный
// (в паспортах до 2010 года правила были другие — ANDREY вместо ANDREI), но
// как судья между двумя чтениями одного и того же слова работает.
function reconcileLat(mrzSurname, mrzGiven, printedSurname, printedGiven, ruSurname, ruGiven) {
  let surname = String(mrzSurname || "").trim();
  let given = String(mrzGiven || "").trim();
  const pS = String(printedSurname || "").trim(), pG = String(printedGiven || "").trim();
  // 1) Слово из фамилии, совпавшее с напечатанным именем, — это имя, а не фамилия.
  const words = surname.split(/\s+/).filter(Boolean);
  if (words.length > 1 && pG) {
    const own = words.filter((w) => w !== pG && !(pG.split(/\s+/).indexOf(w) >= 0));
    if (own.length && own.length < words.length) {
      surname = own.join(" ");
      if (!given) given = pG;
    }
  }
  // 2) Фамилия/имя разошлись с напечатанным сильнее, чем на один знак.
  const notes = [], bad = [], open = [];
  const check = (mv, pv, ru, key, human) => {
    if (!mv || !pv) return mv || pv;
    if (mv === pv) return mv;                             // два чтения сошлись
    bad.push(key);
    // Третий голос: как эта же фамилия выглядит по правилам транслитерации.
    const exp = translit(String(ru || "").replace(/[^А-ЯЁ\- ]/gi, "").trim().toUpperCase());
    const dm = exp ? editDist(mv, exp) : -1, dp = exp ? editDist(pv, exp) : -1;
    let val = pv, why = "взято напечатанное в паспорте (крупный шрифт читается вернее)";
    if (exp && dm < dp) { val = mv; why = "взято «" + mv + "» — оно ближе к транслитерации кириллицы («" + exp + "»)"; }
    else if (exp && dp < dm) { why = "взято «" + pv + "» — оно ближе к транслитерации кириллицы («" + exp + "»)"; }
    // Спор считаем решённым, когда один из вариантов в точности равен
    // транслитерации кириллицы: два независимых источника из трёх сошлись,
    // перечитывать MRZ сильной моделью незачем — это лишние деньги и секунды.
    if (!(exp && Math.min(dm, dp) === 0 && dm !== dp)) open.push(key);
    notes.push(human + ": в MRZ прочитано «" + mv + "», в паспорте напечатано «" + pv +
      "» — два чтения разошлись, " + why + ". Сверьте глазами.");
    return val;
  };
  surname = check(surname, pS, ruSurname, "surnameLat", "Фамилия латиницей");
  given = check(given, pG, ruGiven, "nameLat", "Имя латиницей");
  // suspect — «есть расхождение» (галочку не ставим, пишем предупреждение),
  // unresolved — «расхождение, которое нечем рассудить» (только тут перечитываем).
  return { surname, given, suspect: bad.length > 0, unresolved: open.length > 0, bad, notes };
}
// Разбор имён MRZ глазами сверки. mrzNamesSuspect — «имена разошлись»
// (используется при выборе лучшего из двух разборов), mrzNamesUnresolved —
// «разошлись, и рассудить нечем» (единственный повод платить за перечитку).
function latVerdict(mrz, ai) {
  return reconcileLat(mrz.surnameLat, mrz.nameLat,
    String((ai && ai.surname_lat) || "").trim().toUpperCase(),
    String((ai && ai.name_lat) || "").trim().toUpperCase(),
    String((ai && ai.surname_ru) || ""), String((ai && ai.name_ru) || ""));
}
function mrzNamesSuspect(mrz, ai) { return mrz ? latVerdict(mrz, ai).suspect : false; }
function mrzNamesUnresolved(mrz, ai) { return mrz ? latVerdict(mrz, ai).unresolved : false; }

// ── Claude ────────────────────────────────────────────────────────────────
function aiConfigured() { return !!process.env.ANTHROPIC_API_KEY; }
let _client = null;
function client() {
  if (!aiConfigured()) return null;
  if (_client) return _client;
  const { Anthropic } = require("@anthropic-ai/sdk");
  const opts = {
    apiKey: process.env.ANTHROPIC_API_KEY,
    baseURL: process.env.ANTHROPIC_BASE_URL || undefined,
    timeout: 4 * 60 * 1000, maxRetries: 2,
  };
  if (process.env.TRANSLATE_PROXY) {
    const undici = require("undici");
    opts.fetch = undici.fetch;
    opts.fetchOptions = { dispatcher: new undici.ProxyAgent(process.env.TRANSLATE_PROXY) };
  }
  _client = new Anthropic(opts);
  return _client;
}
function model() { return process.env.SCANNER_MODEL || "claude-haiku-4-5"; }
// Прицельная перепроверка мелкого шрифта (код подразделения, дата выдачи).
// Включена по умолчанию: SCANNER_SMALL_PRINT=0 выключает.
function smallPrintCheck() { return !/^(0|off|no|нет)$/i.test(String(process.env.SCANNER_SMALL_PRINT || "1").trim()); }
// Читать документ дважды и сверять чтения между собой. «1» — вторым проходом
// та же модель (вдвое дороже), «hard» — сильная: она ошибается в других местах,
// поэтому ловит больше, но и стоит заметно дороже.
function doubleRead() {
  const v = String(process.env.SCANNER_DOUBLE_READ || "").toLowerCase().trim();
  if (/^(hard|sonnet|strong|сильная)$/.test(v)) return "hard";
  return /^(1|true|on|yes|да)$/.test(v) ? "same" : "";
}
function modelHard() { return process.env.SCANNER_MODEL_HARD || "claude-sonnet-5"; }
const PRICES = { "claude-opus-5": [5, 25], "claude-sonnet-5": [3, 15], "claude-haiku-4-5": [1, 5] };
const RUB = Number(process.env.TRANSLATE_USD_RUB || 80);
function costRub(spend) {
  let usd = 0;
  for (const e of spend || []) {
    const r = PRICES[e.model] || PRICES["claude-haiku-4-5"];
    usd += ((e.in || 0) + (e.cr || 0) * 0.1 + (e.cw || 0) * 1.25) * r[0] / 1e6 + (e.out || 0) * r[1] / 1e6;
  }
  return usd * RUB;
}

const FIELDS = [
  { key: "surnameRu", label: "Фамилия" },
  { key: "nameRu", label: "Имя" },
  { key: "patronymicRu", label: "Отчество" },
  { key: "surnameLat", label: "Фамилия (латиницей)" },
  { key: "nameLat", label: "Имя (латиницей)" },
  { key: "patronymicLat", label: "Отчество (латиницей)" },
  { key: "translit", label: "Имя и фамилия латиницей" },
  { key: "birthDate", label: "Дата рождения" },
  { key: "sex", label: "Пол" },
  { key: "birthPlace", label: "Место рождения" },
  { key: "birthPlaceLat", label: "Место рождения (латиницей)" },
  { key: "citizenship", label: "Гражданство" },
  { key: "citizenshipEn", label: "Гражданство (англ.)" },
  { key: "number", label: "Серия и номер" },
  { key: "series", label: "Серия" },
  { key: "numberOnly", label: "Номер" },
  { key: "issueDate", label: "Дата выдачи" },
  { key: "expiryDate", label: "Действителен до" },
  { key: "authority", label: "Кем выдан" },
  { key: "authorityLat", label: "Кем выдан (латиницей)" },
  { key: "docKind", label: "Тип документа" },
];

const DOC_KINDS = ["Загранпаспорт РФ", "Внутренний паспорт РФ", "Иностранный паспорт", "Другой документ"];
const SCHEMA = {
  type: "object", additionalProperties: false,
  required: ["doc_kind", "surname_ru", "name_ru", "patronymic_ru", "surname_lat", "name_lat",
    "birth_date", "sex", "birth_place", "citizenship", "number", "issue_date", "expiry_date",
    "authority", "mrz_line1", "mrz_line2", "notes", "page_box", "authority_box"],
  properties: {
    // Где на снимке сама страница с данными — чтобы вырезать её и перечитать
    // мелкий шрифт в исходном разрешении (см. cropToJpeg).
    page_box: {
      type: "object", additionalProperties: false, required: ["x", "y", "w", "h"],
      properties: { x: { type: "number" }, y: { type: "number" }, w: { type: "number" }, h: { type: "number" } },
    },
    // Где именно строка с кодом подразделения — по ней делается вторая,
    // мелкая вырезка: код накрывают голограммой, и в масштабе страницы
    // «78004» превращается в «78604».
    authority_box: {
      type: "object", additionalProperties: false, required: ["x", "y", "w", "h"],
      properties: { x: { type: "number" }, y: { type: "number" }, w: { type: "number" }, h: { type: "number" } },
    },
    doc_kind: { type: "string", enum: DOC_KINDS },
    surname_ru: { type: "string" }, name_ru: { type: "string" }, patronymic_ru: { type: "string" },
    surname_lat: { type: "string" }, name_lat: { type: "string" },
    birth_date: { type: "string" }, sex: { type: "string" }, birth_place: { type: "string" },
    citizenship: { type: "string" }, number: { type: "string" },
    issue_date: { type: "string" }, expiry_date: { type: "string" }, authority: { type: "string" },
    mrz_line1: { type: "string" }, mrz_line2: { type: "string" },
    notes: { type: "string" },
  },
};
const MRZ_SCHEMA = {
  type: "object", additionalProperties: false, required: ["mrz_line1", "mrz_line2"],
  properties: { mrz_line1: { type: "string" }, mrz_line2: { type: "string" } },
};
const SMALL_SCHEMA = {
  type: "object", additionalProperties: false, required: ["issue_date", "authority"],
  properties: { issue_date: { type: "string" }, authority: { type: "string" } },
};
const EXAMPLE_SCHEMA = {
  type: "object", additionalProperties: false, required: ["lessons", "diff"],
  properties: { lessons: { type: "array", items: { type: "string" } }, diff: { type: "string" } },
};
const LESSONS_SCHEMA = {
  type: "object", additionalProperties: false, required: ["lessons"],
  properties: { lessons: { type: "array", items: { type: "string" } } },
};

function lessonsBlock() {
  const ls = lessons().slice(-MAX_LESSONS_IN_PROMPT);
  if (!ls.length) return "";
  return "\n\nЧему научили сотрудники на прошлых документах (соблюдай):\n" + ls.map((l, i) => (i + 1) + ". " + l.text).join("\n");
}
const SYS = [
  "Ты извлекаешь данные из фотографий и сканов удостоверяющих документов для визового агентства.",
  "Отвечай СТРОГО данными из документа: ничего не додумывай и не «исправляй» — если поля не видно или его нет, оставь пустую строку.",
  "Часто присылают не само фото, а скриншот из мессенджера: сверху и снизу видны имя отправителя, время, кнопки. Это НЕ данные документа — бери только то, что напечатано на самой странице паспорта.",
  "Правила заполнения:",
  "- Кириллические поля (фамилия, имя, отчество, место рождения, кем выдан) переписывай ровно как напечатано, ЗАГЛАВНЫМИ, без точек в конце.",
  "- В паспортах уроженцев Средней Азии отчество состоит из двух слов: «ИСРОИЛЖОН УГЛИ», «АЗИЗ КЫЗЫ», «РУСТАМ ОГЛЫ», «БЕКОВИЧ УУЛУ». Слово «УГЛИ», «КЫЗЫ», «ОГЛЫ», «УУЛУ» — часть отчества, не теряй его и не приписывай к имени.",
  "- Латиница (surname_lat, name_lat) — как в документе/MRZ, заглавными.",
  "- Даты — в формате ДД.ММ.ГГГГ.",
  "- Пол — «М» или «Ж».",
  "- number — серия и номер как напечатаны, например «75 8340533».",
  "- authority — орган выдачи как напечатан, например «МВД 50001» или «ФМС 77712». Код подразделения набран мелко и часто смазан: читай его ПО ОДНОЙ ЦИФРЕ, не угадывай слово целиком. Легко спутать 6 и 8, 0 и 8, 3 и 8, 1 и 7 — если цифра нечёткая, выбери ту, у которой видны характерные штрихи (у 6 хвост наверху слева и замкнутая нижняя петля, у 8 две замкнутые петли).",
  "- birth_place — как напечатано ЦЕЛИКОМ, вместе с латинской частью после косой черты: «СВЕРДЛОВСКАЯ ОБЛ. / RUSSIA», «ПЕРМСКАЯ ОБЛ. / USSR», «Г. МОСКВА / USSR». Латинская часть — это страна рождения, у рождённых до 1991 года там стоит USSR, и её нельзя терять и нельзя менять на RUSSIA.",
  "- mrz_line1 и mrz_line2 — две нижние машиночитаемые строки (крупный моноширинный шрифт под фотографией), СИМВОЛ В СИМВОЛ, ровно по 44 знака каждая. Знак-заполнитель — «<» (шеврон), его в строках много подряд; не заменяй его пробелами и не пропускай. Не путай O и 0, I и 1. Пример вида: «P<RUSIVANOV<<IVAN<<<<<<<<<<<<<<<<<<<<<<<<<<<» и «7512345674RUS8503121M3001015<<<<<<<<<<<<<<04». Это самое важное поле — по нему сверяются номер и даты. ЕСЛИ машиночитаемых строк на снимке НЕ ВИДНО (обрезаны, залиты бликом, это другая страница) — верни для них ПУСТЫЕ строки. Ни в коем случае не составляй их сам из напечатанных данных: выдуманная MRZ хуже отсутствующей.",
  "- authority_box — положение СТРОКИ с кодом подразделения (там, где «МВД 12345» под надписью «Орган, выдавший документ / Authority») в процентах от размеров снимка: x, y, w, h. Рамку бери с запасом по ширине, чтобы код попал целиком. Если строки не видно — нули.",
  "- page_box — положение самой страницы с данными (та, где фотография и под ней две машиночитаемые строки) в ПРОЦЕНТАХ от размеров снимка: x и y — левый верхний угол, w и h — ширина и высота. Снимок часто сделан издалека, паспорт занимает лишь часть кадра — покажи именно его. Если страницы не видно, верни нули.",
  "- notes — короткая пометка по-русски, если с документом что-то не так (плохо видно, обрезано, блик, это не паспорт). Обязательно напиши сюда, если какая-то ЦИФРА читается неуверенно, и укажи поле: «код подразделения смазан», «не уверен в дате выдачи».",
].join("\n");

// «Усердие» (output_config.effort) понимают только модели пятого поколения;
// haiku 4.5 на такой параметр отвечает 400 — ей его не передаём.
function supportsEffort(m) { return /(opus|sonnet|fable)-5/.test(String(m || "")); }
async function runJson(params, schema) {
  const c = client();
  if (!c) throw new Error("ИИ не настроен: нет ANTHROPIC_API_KEY");
  const base = Object.assign({}, params);
  if (!supportsEffort(base.model) && base.output_config) {
    const oc = Object.assign({}, base.output_config);
    delete oc.effort;
    if (Object.keys(oc).length) base.output_config = oc; else delete base.output_config;
  }
  const withSchema = Object.assign({}, base, {
    output_config: Object.assign({}, base.output_config, { format: { type: "json_schema", schema } }),
  });
  const call = async (p) => {
    const msg = await c.messages.create(p);
    let text = "";
    for (const b of msg.content) if (b.type === "text") text += b.text;
    return { text, usage: msg.usage, model: p.model };
  };
  let r;
  try { r = await call(withSchema); }
  catch (e) {
    if (!(e && e.status === 400)) throw e;
    // Канал/модель не приняли настройки ответа — повтор совсем без них,
    // JSON тогда просто разбираем из текста.
    console.warn("scanner: настройки ответа не приняты (" + e.message + "), повтор без них");
    const plain = Object.assign({}, base); delete plain.output_config;
    plain.system = (plain.system || "") + "\n\nОтвечай ТОЛЬКО валидным JSON без пояснений и без markdown-ограждений.";
    r = await call(plain);
  }
  let json = null;
  try { json = JSON.parse(r.text); }
  catch (_) {
    const m = r.text.match(/\{[\s\S]*\}/);
    if (m) { try { json = JSON.parse(m[0]); } catch (_) {} }
  }
  return { json, usage: r.usage, model: r.model };
}

// Айфон снимает в HEIC, а модели такой формат не принимают. Переводим в JPEG
// сами: heic-convert — чистый JS (libheif, собранный в wasm), никаких системных
// библиотек ставить не нужно. Возвращаем новый буфер и имя с .jpg, чтобы фото
// в истории потом открывалось в браузере (он HEIC тоже не показывает).
function isHeic(name, mime) {
  const ext = path.extname(String(name || "")).toLowerCase();
  return /^image\/hei[cf]/.test(String(mime || "").toLowerCase()) || ext === ".heic" || ext === ".heif";
}
async function heicToJpeg(buf, name) {
  const convert = require("heic-convert");
  const out = await convert({ buffer: buf, format: "JPEG", quality: 0.92 });
  return { buf: Buffer.from(out), name: String(name || "фото").replace(/\.hei[cf]$/i, "") + ".jpg" };
}

// ── Вырезка страницы паспорта ────────────────────────────────────────────
// Снимок обычно делают «человек держит паспорт»: сам документ занимает четверть
// кадра, а модель получает картинку, ужатую до 1568 px по длинной стороне.
// Мелкий шрифт (код подразделения) превращается в десяток пикселей и не
// читается никакой моделью. Лечится не переспрашиванием, а разрешением:
// вырезаем страницу в ИСХОДНОМ качестве и задаём вопрос уже по ней.
// Всё на чистом JS — jpeg-js и pngjs уже стоят, ничего системного не нужно.
// Скан паспорта в PDF — это почти всегда одна фотография, вложенная внутрь
// готовым JPEG (фильтр DCTDecode). Растеризовать PDF нечем (для этого нужны
// системные библиотеки), а вот достать оттуда исходный JPEG можно простым
// разбором: находим потоки с DCTDecode и берём самый большой. Тогда вырезка
// страницы работает и для PDF — а без неё мелкий шрифт в сканах не читался.
function jpegInsidePdf(buf) {
  const hay = buf.toString("latin1");
  let best = null;
  const re = /\/Filter\s*(?:\[\s*)?\/DCTDecode/g;
  let m;
  while ((m = re.exec(hay))) {
    const s = hay.indexOf("stream", m.index);
    if (s < 0) continue;
    let from = s + 6;
    if (hay[from] === "\r") from++;
    if (hay[from] === "\n") from++;
    const to = hay.indexOf("endstream", from);
    if (to < 0) continue;
    const len = to - from;
    if (len > 5000 && (!best || len > best.len)) best = { from, len };
  }
  if (!best) return null;
  const out = buf.subarray(best.from, best.from + best.len);
  // Поток должен начинаться сигнатурой JPEG, иначе это что-то другое.
  return out.length > 3 && out[0] === 0xff && out[1] === 0xd8 ? out : null;
}

// Второй вид сканов: картинка лежит в PDF не JPEG-ом, а сжатым растром
// (FlateDecode — тот же zlib, он есть в самом Node). Разжимаем и собираем
// пиксели: длина ровно W*H*каналы, значит предсказателей нет и данные сырые.
function rasterInsidePdf(buf) {
  const hay = buf.toString("latin1");
  const re = /\/Subtype\s*\/Image([\s\S]{0,600}?)stream/g;
  let m, best = null;
  while ((m = re.exec(hay))) {
    const head = m[1];
    if (!/\/Filter\s*\/?FlateDecode/.test(head) || /\/DCTDecode|\/JPXDecode/.test(head)) continue;
    const W = Number((head.match(/\/Width\s+(\d+)/) || [])[1] || 0);
    const H = Number((head.match(/\/Height\s+(\d+)/) || [])[1] || 0);
    const bpc = Number((head.match(/\/BitsPerComponent\s+(\d+)/) || [])[1] || 8);
    if (!W || !H || bpc !== 8) continue;
    let from = m.index + m[0].length;
    if (hay[from] === "\r") from++;
    if (hay[from] === "\n") from++;
    const to = hay.indexOf("endstream", from);
    if (to < 0) continue;
    if (!best || W * H > best.W * best.H) best = { from, to, W, H };
  }
  if (!best) return null;
  let raw;
  try { raw = require("zlib").inflateSync(buf.subarray(best.from, best.to)); } catch (_) { return null; }
  const px = best.W * best.H;
  const ch = raw.length === px * 3 ? 3 : raw.length === px ? 1 : raw.length === px * 4 ? 4 : 0;
  if (!ch) return null;                                   // с предсказателями не связываемся
  const data = Buffer.alloc(px * 4);
  for (let i = 0; i < px; i++) {
    const r = raw[i * ch], g = ch === 1 ? r : raw[i * ch + 1], b = ch === 1 ? r : raw[i * ch + 2];
    data[i * 4] = r; data[i * 4 + 1] = g; data[i * 4 + 2] = b; data[i * 4 + 3] = 255;
  }
  return { data, width: best.W, height: best.H };
}

function decodeImage(buf, mime, name) {
  const ext = path.extname(String(name || "")).toLowerCase();
  const m = String(mime || "").toLowerCase();
  if (m === "application/pdf" || ext === ".pdf") {
    const inner = jpegInsidePdf(buf);
    if (inner) {
      const im = require("jpeg-js").decode(inner, { useTArray: true });
      return { data: Buffer.from(im.data.buffer || im.data), width: im.width, height: im.height };
    }
    return rasterInsidePdf(buf);
  }
  if (m === "image/png" || ext === ".png") {
    const { PNG } = require("pngjs");
    const p = PNG.sync.read(buf);
    return { data: Buffer.from(p.data), width: p.width, height: p.height };
  }
  if (/jpe?g/.test(m) || ext === ".jpg" || ext === ".jpeg") {
    const im = require("jpeg-js").decode(buf, { useTArray: true });
    return { data: Buffer.from(im.data.buffer || im.data), width: im.width, height: im.height };
  }
  return null; // PDF и прочее не режем
}
function cropToJpeg(buf, mime, name, box, padPct) {
  const im = decodeImage(buf, mime, name);
  if (!im) return null;
  // Сколько точек снимка реально доходит до модели: она ужимает картинку до
  // 1568 px по длинной стороне. Пригодится, чтобы честно сказать «снимок мелкий».
  const delivered = (side) => Math.round(Math.min(side, 1568));
  const whole = { buf: null, delivered: delivered(Math.max(im.width, im.height)) };
  if (!box) return whole;
  const pad = padPct || 5;
  let x = Math.round(im.width * (box.x - pad) / 100), y = Math.round(im.height * (box.y - pad) / 100);
  let w = Math.round(im.width * (box.w + pad * 2) / 100), h = Math.round(im.height * (box.h + pad * 2) / 100);
  x = Math.max(0, Math.min(im.width - 1, x)); y = Math.max(0, Math.min(im.height - 1, y));
  w = Math.min(im.width - x, w); h = Math.min(im.height - y, h);
  if (w < 200 || h < 120) return whole;                      // вырезка слишком мелкая — толку не будет
  if (w * h > 0.92 * im.width * im.height) return whole;     // это почти весь кадр, резать незачем
  const out = Buffer.alloc(w * h * 4);
  for (let r = 0; r < h; r++) im.data.copy(out, r * w * 4, ((y + r) * im.width + x) * 4, ((y + r) * im.width + x + w) * 4);
  // Насколько крупнее станет страница в глазах модели. Картинку она всё равно
  // ужимает до 1568 px по длинной стороне, поэтому выигрыш даёт не сама резка,
  // а то, что из кадра ушло лишнее. Если снимок и так мелкий (скриншот 369x800),
  // выигрыша нет никакого — и доверять такой «вырезке» больше, чем оригиналу,
  // нельзя: проверено, на ней модель прочитала фамилию хуже.
  const cap = (side) => Math.min(1, 1568 / side);
  const gain = cap(Math.max(w, h)) / cap(Math.max(im.width, im.height));
  // used — какая рамка в процентах реально вырезана (с учётом полей): по ней
  // потом пересчитываются координаты внутри вырезки в координаты снимка.
  const used = { x: x / im.width * 100, y: y / im.height * 100, w: w / im.width * 100, h: h / im.height * 100 };
  return { buf: Buffer.from(require("jpeg-js").encode({ data: out, width: w, height: h }, 92).data), w, h, gain, used, delivered: delivered(Math.max(w, h)) };
}
// Рамка строки — узкая полоска, к ней мерки страницы неприменимы.
function saneLineBox(b) {
  if (!b) return null;
  const n = (v) => (typeof v === "number" && isFinite(v) ? v : NaN);
  const x = n(b.x), y = n(b.y), w = n(b.w), h = n(b.h);
  if ([x, y, w, h].some(isNaN)) return null;
  if (w < 3 || h < 0.4 || w > 100 || h > 40) return null;
  if (x < 0 || y < 0 || x + w > 101 || y + h > 101) return null;
  return { x, y, w, h };
}
// Рамка от модели: проверяем на вменяемость, чтобы не резать по мусору.
function sanePageBox(b) {
  if (!b) return null;
  const n = (v) => (typeof v === "number" && isFinite(v) ? v : NaN);
  const x = n(b.x), y = n(b.y), w = n(b.w), h = n(b.h);
  if ([x, y, w, h].some(isNaN)) return null;
  if (w < 8 || h < 8 || w > 100 || h > 100) return null;
  if (x < 0 || y < 0 || x + w > 101 || y + h > 101) return null;
  return { x, y, w, h };
}

function mediaBlock(buf, name, mime) {
  const ext = path.extname(String(name || "")).toLowerCase();
  const m = String(mime || "").toLowerCase();
  if (m === "application/pdf" || ext === ".pdf") {
    return { type: "document", source: { type: "base64", media_type: "application/pdf", data: buf.toString("base64") } };
  }
  let media = m && /^image\/(jpeg|png|webp|gif)$/.test(m) ? m : null;
  if (!media) media = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp", ".gif": "image/gif" }[ext] || null;
  if (!media) return null;
  return { type: "image", source: { type: "base64", media_type: media, data: buf.toString("base64") } };
}

// Сколько цифр разошлось у двух строк одной длины (иначе — бесконечность).
function digitDiff(a, b) {
  const x = String(a || "").replace(/\D/g, ""), y = String(b || "").replace(/\D/g, "");
  if (!x || !y || x.length !== y.length) return Infinity;
  let n = 0;
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) n++;
  return n;
}

// Свести ответ модели и разбор MRZ в итоговый набор полей.
// alt — второе, прицельное чтение мелких полей (см. readSmallPrint): {authority, issueDate}.
function buildFields(ai, mrz, alt) {
  const warn = [];
  const f = {
    docKind: DOC_KINDS.indexOf(ai.doc_kind) >= 0 ? ai.doc_kind : "Другой документ",
    surnameRu: (ai.surname_ru || "").trim().toUpperCase(),
    nameRu: (ai.name_ru || "").trim().toUpperCase(),
    patronymicRu: (ai.patronymic_ru || "").trim().toUpperCase(),
    surnameLat: (ai.surname_lat || "").trim().toUpperCase(),
    nameLat: (ai.name_lat || "").trim().toUpperCase(),
    birthDate: normDate(ai.birth_date),
    sex: /ж|f/i.test(ai.sex || "") ? "Ж" : (/м|m/i.test(ai.sex || "") ? "М" : ""),
    birthPlace: (ai.birth_place || "").trim().toUpperCase(),
    citizenship: (ai.citizenship || "").trim(),
    number: String(ai.number || "").trim(),
    issueDate: normDate(ai.issue_date),
    expiryDate: normDate(ai.expiry_date),
    authority: (ai.authority || "").trim(),
  };
  // «РОССИЙСКАЯ ФЕДЕРАЦИЯ / RUSSIAN FEDERATION» → в поле гражданства оставляем
  // только русскую часть, английская уедет в отдельное поле.
  if (/[А-ЯЁ]/.test(f.citizenship) && /\//.test(f.citizenship)) f.citizenship = f.citizenship.split("/")[0].trim();
  // Место рождения печатают через дробь: слева по-русски регион, справа
  // латиницей СТРАНА рождения — и это не перевод региона, а важные данные:
  // у рождённых до 1991 там стоит USSR, консульства к этому придирчивы.
  // Оставляем строку ровно как в паспорте, целиком (просьба Андрея 24.08).
  f.birthPlace = f.birthPlace.replace(/\s*\/\s*/g, " / ").trim();
  const confirmed = [];
  if (mrz) {
    // Поле считается надёжным, если сошлась контрольная цифра MRZ ИЛИ если
    // машиночитаемая строка и напечатанное в паспорте говорят одно и то же.
    const put = (key, val, ok, human) => {
      if (!val) return;
      const same = f[key] && f[key] === val;
      if (same) { confirmed.push(key); return; }         // два источника совпали
      if (ok === true) {                                  // MRZ проверена цифрой
        if (f[key]) warn.push(human + ": в документе «" + f[key] + "», по MRZ «" + val + "» — взято из MRZ");
        f[key] = val; confirmed.push(key);
      } else if (!f[key]) {                               // в визуальной зоне пусто
        f[key] = val;
        warn.push(human + ": взято из MRZ, контрольной цифрой не подтверждено — сверьте глазами");
      } else {                                            // расходятся и MRZ не проверена
        warn.push(human + ": в документе «" + f[key] + "», в MRZ «" + val + "» — оставил как в документе, сверьте глазами");
      }
    };
    put("number", prettyRuNumber(mrz.number), mrz.checks.number, "Номер");
    put("birthDate", mrz.birthDate, mrz.checks.birth, "Дата рождения");
    put("expiryDate", mrz.expiryDate, mrz.checks.expiry, "Срок действия");
    if (mrz.sex) { if (!f.sex || f.sex === mrz.sex) { if (f.sex === mrz.sex) confirmed.push("sex"); f.sex = mrz.sex; } else warn.push("Пол: в документе «" + f.sex + "», в MRZ «" + mrz.sex + "»"); }
    // Латиница из MRZ — официальная транслитерация, для виз важна именно она;
    // но только если MRZ и напечатанное в паспорте говорят одно и то же.
    const lat = reconcileLat(mrz.surnameLat, mrz.nameLat, f.surnameLat, f.nameLat, f.surnameRu, f.nameRu);
    for (const n of lat.notes) warn.push(n);
    // Галочку ставим только там, где MRZ и паспорт действительно сошлись:
    // поле, где MRZ прочиталась неуверенно, подтверждённым считать нельзя.
    const putLat = (key, val, human) => {
      if (!val) return;
      if (lat.bad.indexOf(key) >= 0) { f[key] = val; return; }   // про это уже сказано выше
      if (f[key] && f[key] !== val) warn.push(human + ": в документе «" + f[key] + "», в MRZ «" + val + "» — взято из MRZ (это официальная транслитерация)");
      else if (f[key] === val && lat.bad.indexOf(key) < 0) confirmed.push(key);
      f[key] = val;
    };
    putLat("surnameLat", lat.surname, "Фамилия латиницей");
    putLat("nameLat", lat.given, "Имя латиницей");
    if (mrz.nationality === "RUS" && !f.citizenship) f.citizenship = "РОССИЙСКАЯ ФЕДЕРАЦИЯ";
  } else {
    warn.push("MRZ не распознана — все поля прочитаны только глазами модели, проверьте внимательно");
  }
  // Имя первым, фамилия второй (просьба Андрея 22.08).
  f.translit = [f.nameLat, f.surnameLat].filter(Boolean).join(" ");
  if (confirmed.indexOf("surnameLat") >= 0 && confirmed.indexOf("nameLat") >= 0) confirmed.push("translit");
  // Серия и номер — двумя блоками (у загранпаспорта РФ это 2 + 7 цифр).
  const nd = String(f.number || "").replace(/\D/g, "");
  if (nd.length === 9) { f.number = prettyRuNumber(nd); f.series = nd.slice(0, 2); f.numberOnly = nd.slice(2); }
  else { f.series = ""; f.numberOnly = String(f.number || "").trim(); }
  if (confirmed.indexOf("number") >= 0) { confirmed.push("series"); confirmed.push("numberOnly"); }
  // Модель иногда набирает кириллическое поле вперемешку с латиницей:
  // «СОРОKIN» вместо «СОРОКИН» — буквы-двойники неразличимы на глаз. Чиним
  // подстановкой двойников, но принимаем результат ТОЛЬКО если он сходится
  // с латиницей MRZ: угадывать вслепую нельзя.
  const LOOKALIKE = { A: "А", B: "В", C: "С", E: "Е", H: "Н", I: "И", K: "К", M: "М", N: "Н",
    O: "О", P: "Р", T: "Т", X: "Х", Y: "У", U: "У", G: "Г", D: "Д", L: "Л", R: "Р", S: "С", F: "Ф", V: "В", Z: "З", J: "Ж" };
  const fixMixed = (key, mrzVal) => {
    const v = f[key];
    if (!v || !/[A-Z]/.test(v) || !/[А-ЯЁ]/.test(v)) return;   // не смесь — не трогаем
    const guess = v.replace(/[A-Z]/g, (ch) => LOOKALIKE[ch] || ch);
    if (mrzVal && translit(guess) === mrzVal) { f[key] = guess; return; }
    warn.push(((FIELDS.find((x) => x.key === key) || {}).label || key) + ": «" + v +
      "» набрано вперемешку кириллицей и латиницей — прочитано неуверенно, сверьте с паспортом.");
  };
  fixMixed("surnameRu", mrz && mrz.surnameLat);
  fixMixed("nameRu", mrz && mrz.nameLat);
  fixMixed("patronymicRu", null);

  // Кириллицу проверять нечем — кроме одного: в загранпаспорте латиница в MRZ
  // это транслитерация той же самой кириллической фамилии. Прогоняем прочитанную
  // кириллицу через нашу таблицу ICAO и сравниваем. Мелкое расхождение не в счёт
  // (в паспортах до 2010 года правила были другие: ANDREY против ANDREI), а
  // крупное значит, что кириллица прочитана неверно: «РУСКУННИКОВ» вместо
  // «КАНУННИКОВА» — здесь и вылезает.
  const ruVsMrz = (ruKey, mrzVal, human) => {
    if (!mrz || !mrzVal || !f[ruKey]) return;
    let my = translit(f[ruKey]);
    if (my !== mrzVal) {
      const fix = repairByMrz(f[ruKey], mrzVal);
      if (fix) {
        warn.push(human + ": прочитано «" + f[ruKey] + "», но по MRZ («" + mrzVal + "») это «" + fix +
          "» — ошибка в одну букву. Исправлено, сверьте глазами.");
        f[ruKey] = fix;
        my = translit(f[ruKey]);
      }
    }
    if (my === mrzVal || editDist(my, mrzVal) <= 1) return;
    warn.push(human + ": прочитано «" + f[ruKey] + "», но в MRZ стоит «" + mrzVal + "», а из прочитанного вышло бы «" + my +
      "». Кириллица прочитана неуверенно — сверьте с паспортом.");
    const i = confirmed.indexOf(ruKey);
    if (i >= 0) confirmed.splice(i, 1);
  };

  // Модель иногда приклеивает к фамилии код государства из MRZ:
  // «P<RUSKANUNNIKOV» → «РУСКАНУННИКОВ». Ловится сверкой с фамилией из MRZ.
  if (mrz && mrz.surnameLat && /^РУС/.test(f.surnameRu)) {
    const bare = f.surnameRu.replace(/^РУС/, "");
    if (translit(bare) === mrz.surnameLat && translit(f.surnameRu) !== mrz.surnameLat) {
      f.surnameRu = bare;
    }
  }
  // Кириллица: в MRZ её нет и контрольных цифр у неё нет, поэтому единственная
  // защита — второе чтение по увеличенной вырезке страницы. Там модель верно
  // читает то, что на общем снимке путала (КАНУННИКОВ вместо РУКАВИШНИКОВ,
  // КУРСК вместо КИРОВА). Верим вырезке только если она про тот же документ —
  // это проверяется по номеру, сошедшемуся с MRZ (alt.trusted).
  if (alt && alt.trusted) {
    for (const key of ["surnameRu", "nameRu", "patronymicRu", "birthPlace"]) {
      let v = String(alt[key] || "").trim().toUpperCase();
      if (key === "birthPlace") v = v.replace(/\s*\/\s*/g, " / ").trim();
      if (!v || v === f[key]) { if (v && v === f[key]) confirmed.push(key); continue; }
      const label = (FIELDS.find((x) => x.key === key) || {}).label || key;
      if (!f[key]) { f[key] = v; continue; }
      warn.push(label + ": на общем снимке прочиталось «" + f[key] + "», на увеличенной вырезке — «" + v +
        "». Взято второе (там шрифт крупнее), но сверьте глазами.");
      f[key] = v;
    }
  }
  // Модель иногда меняет фамилию и имя местами (в паспорте они идут в две
  // строки без подписей, спутать легко). Ловится по MRZ: там порядок задан
  // жёстко — фамилия, два шеврона, имя.
  if (mrz && mrz.surnameLat && mrz.nameLat && f.surnameRu && f.nameRu) {
    const asIs = editDist(translit(f.surnameRu), mrz.surnameLat) + editDist(translit(f.nameRu), mrz.nameLat);
    const swapped = editDist(translit(f.nameRu), mrz.surnameLat) + editDist(translit(f.surnameRu), mrz.nameLat);
    if (swapped === 0 && asIs > 0) {
      warn.push("Фамилия и имя: в прочитанном они поменяны местами (по MRZ фамилия «" + mrz.surnameLat + "», имя «" + mrz.nameLat + "»). Переставил обратно.");
      const t = f.surnameRu; f.surnameRu = f.nameRu; f.nameRu = t;
    }
  }
  ruVsMrz("surnameRu", mrz && mrz.surnameLat, "Фамилия");
  ruVsMrz("nameRu", mrz && mrz.nameLat, "Имя");
  // Бывает, что оба латинских чтения сошлись — и оба неверны: «ALEXANDRA» там,
  // где по правилам транслитерации «ALEKSANDRA» (X вместо KS модель ставит
  // охотно, потому что так пишут в жизни). Подменять нельзя: у паспортов до
  // 2010 года транслитерация была своя, там расхождения законны. Предупреждаем.
  const latVsTranslit = (latKey, ruKey, human) => {
    if (!f[latKey] || !f[ruKey]) return;
    const my = translit(f[ruKey]);
    if (!my || my === f[latKey] || editDist(my, f[latKey]) <= 1) return;
    warn.push(human + ": в паспорте «" + f[latKey] + "», а по нынешним правилам транслитерации с «" + f[ruKey] +
      "» вышло бы «" + my + "». Если паспорт выдан после 2010 года — вероятно, латиница прочитана неверно.");
  };
  latVsTranslit("surnameLat", "surnameRu", "Фамилия латиницей");
  latVsTranslit("nameLat", "nameRu", "Имя латиницей");
  // Полей ниже в MRZ нет вовсе — транслитерируем сами по правилам загранпаспорта.
  f.patronymicLat = translit(f.patronymicRu);
  f.citizenshipEn = citizenshipEn(f.citizenship, mrz && mrz.nationality);
  // Латиница: кириллица переводится по таблице, латинская часть («/ USSR»)
  // проходит насквозь — в таблице её букв нет.
  f.birthPlaceLat = translit(f.birthPlace);
  f.authorityLat = translit(f.authority);
  // Даты выдачи в MRZ нет, но она жёстко связана со сроком действия: у
  // загранпаспорта РФ окончание — это выдача плюс ровно 5 или 10 лет, день и
  // месяц те же. А срок действия проверен контрольной цифрой MRZ. Значит по
  // нему можно и подтвердить дату выдачи, и починить одну сбитую цифру года
  // (модель прочитала «30.11.2011» вместо «30.11.2021» — 20 лет не бывает).
  // Второе, прицельное чтение мелкого шрифта. Слепо ему верить нельзя: на
  // хорошем снимке оно точнее основного прохода (тот читает 19 полей разом и
  // «проскакивает» цифры), а на плохом — выдаёт откровенный мусор. Поэтому:
  // сошлось — ставим галочку; разошлось РОВНО НА ОДНУ ЦИФРУ при той же длине —
  // это описка основного прохода, берём прицельное; всё остальное (другая
  // длина, две и больше цифр разницы) — оставляем как было и предупреждаем.
  // КОД ПОДРАЗДЕЛЕНИЯ. Проверить его не с чем: в MRZ его нет, контрольной
  // цифры нет, а цифры мелкие и часто под голограммой. Поэтому смотрим на него
  // трижды в разном масштабе — весь снимок, вырезка страницы, вырезка самой
  // строки — и берём то, что совпало хотя бы дважды. Опыт показал, что ни один
  // масштаб не выигрывает всегда: на одном снимке верна строка, на другом
  // страница. Если все три разошлись — значит читать нечего, так и пишем.
  let authorityDecided = false;
  {
    const digits = (v) => String(v || "").replace(/\D/g, "");
    const votes = [
      { src: "по всему снимку", v: f.authority },
      { src: "по вырезке страницы", v: alt && alt.authority },
      { src: "по вырезке строки", v: alt && alt.authorityLine },
    ].filter((x) => /^\d{5}$/.test(digits(x.v)));
    if (votes.length >= 2) {
      const count = new Map();
      votes.forEach((x) => count.set(digits(x.v), (count.get(digits(x.v)) || 0) + 1));
      const best = Array.from(count).sort((a, b) => b[1] - a[1]);
      const list = votes.map((x) => "«" + String(x.v).trim() + "» " + x.src).join(", ");
      if (best[0][1] >= 2) {
        const win = votes.find((x) => digits(x.v) === best[0][0]);
        if (digits(f.authority) !== best[0][0]) {
          warn.push("Кем выдан: чтения разошлись (" + list + "). Взято «" + String(win.v).trim() + "» — за него два чтения из " + votes.length + ".");
        } else if (votes.length >= 3 && best.length > 1) {
          warn.push("Кем выдан: одно из трёх чтений разошлось (" + list + "). Оставлено «" + String(win.v).trim() + "», но сверьте глазами.");
        }
        f.authority = String(win.v).trim();
        if (best[0][1] === votes.length && votes.length >= 2) confirmed.push("authority");
      } else {
        warn.push("Кем выдан: все чтения разные (" + list + ") — код набран мелко и, похоже, перекрыт голограммой. Введите вручную, глядя в паспорт.");
        const pageVote = votes.find((x) => x.src === "по вырезке страницы") || votes[0];
        f.authority = String(pageVote.v).trim();
      }
      f.authorityLat = translit(f.authority);
      authorityDecided = true;
    }
  }
  const altAuthority = authorityDecided ? "" : String((alt && alt.authority) || "").trim();
  if (altAuthority && f.authority) {
    const d = digitDiff(altAuthority, f.authority);
    const sameWord = altAuthority.replace(/[\d\s]/g, "") === f.authority.replace(/[\d\s]/g, "");
    const wellFormed = /^(МВД|ФМС|УФМС|ГУВД|УВД)?\s*\d{5}$/i.test(altAuthority.trim());
    if (altAuthority === f.authority) confirmed.push("authority");
    else if (alt.cropped && wellFormed) {
      // Вырезка страницы в исходном разрешении — самый надёжный источник для
      // мелкого шрифта: на целом снимке цифры просто не долетают до модели.
      warn.push("Кем выдан: на общем снимке прочиталось «" + f.authority + "», а на увеличенной вырезке страницы — «" + altAuthority +
        "». Взято второе (там шрифт крупнее), но сверьте глазами.");
      f.authority = altAuthority;
    } else if (d === 1 && sameWord) {
      warn.push("Кем выдан: при беглом чтении «" + f.authority + "», при повторном, прицельном — «" + altAuthority +
        "». Взято прицельное (различие в одной цифре), но сверьте глазами: код набран мелко.");
      f.authority = altAuthority;
    } else {
      warn.push("Кем выдан: два чтения разошлись — «" + f.authority + "» и «" + altAuthority +
        "». Оставлено первое, но полагаться на него нельзя — введите вручную.");
    }
    f.authorityLat = translit(f.authority);
  } else if (altAuthority && !f.authority) {
    f.authority = altAuthority;
    f.authorityLat = translit(f.authority);
  }

  // У загранпаспорта РФ код подразделения — ровно пять цифр. Меньше значит,
  // что модель их не дочитала (мелкий или размытый снимок).
  if (f.authority && !/^\d{5}$/.test(f.authority.replace(/\D/g, ""))) {
    warn.push("Кем выдан: «" + f.authority + "» — у загранпаспорта РФ код подразделения из пяти цифр. Прочитано не полностью, введите вручную.");
  }

  const isDate = (s) => /^\d{2}\.\d{2}\.\d{4}$/.test(String(s || ""));
  const altIssue = normDate((alt && alt.issueDate) || "");
  // ДАТА ВЫДАЧИ. Её в MRZ нет, но она не свободна: у загранпаспорта РФ
  // окончание — это выдача плюс ровно 5 или 10 лет, тот же день и месяц.
  // А окончание проверено контрольной цифрой MRZ. Значит верных вариантов
  // всего два, и оба известны заранее — читать дату глазами тут нужно лишь
  // чтобы выбрать между ними. Так что чтение, не совпавшее ни с одним из двух,
  // мы не «поправляем по цифрам», а заменяем ближайшим законным вариантом:
  // модель сбивалась и в годе («2011» вместо «2021»), и в дне («28» вместо «30»).
  if (isDate(f.expiryDate) && confirmed.indexOf("expiryDate") >= 0) {
    const dmE = f.expiryDate.slice(0, 5), yE = Number(f.expiryDate.slice(6));
    const cands = [yE - 10, yE - 5].map((y) => dmE + "." + y);
    const days = (s) => { const p = s.split("."); return Date.UTC(+p[2], +p[1] - 1, +p[0]) / 86400e3; };
    const legal = (s) => cands.indexOf(s) >= 0;
    if (legal(f.issueDate)) {
      if (confirmed.indexOf("issueDate") < 0) confirmed.push("issueDate");
    } else if (legal(altIssue)) {
      warn.push("Дата выдачи: при беглом чтении «" + (f.issueDate || "пусто") + "», при повторном — «" + altIssue +
        "». Взято второе: оно сходится со сроком действия «" + f.expiryDate + "» из MRZ.");
      f.issueDate = altIssue;
      confirmed.push("issueDate");
    } else {
      const seen = isDate(f.issueDate) ? f.issueDate : (isDate(altIssue) ? altIssue : "");
      if (seen) {
        const near = cands.slice().sort((a, b) => Math.abs(days(a) - days(seen)) - Math.abs(days(b) - days(seen)))[0];
        warn.push("Дата выдачи: прочитано «" + seen + "», но по сроку действия «" + f.expiryDate +
          "» (подтверждён MRZ) выдача может быть только «" + cands[0] + "» или «" + cands[1] +
          "» — у загранпаспорта РФ ровно 10 или 5 лет. Поставлено ближайшее, «" + near + "»; если паспорт пятилетний, поправьте.");
        f.issueDate = near;
      } else {
        warn.push("Дата выдачи не прочитана. По сроку действия «" + f.expiryDate + "» это «" + cands[0] + "» или «" + cands[1] + "» — выберите сами.");
      }
    }
  } else if (isDate(f.issueDate) && isDate(f.expiryDate)) {
    // Срок действия контрольной цифрой не подтверждён — судить не по чему,
    // остаётся здравый смысл.
    const years = Number(f.expiryDate.slice(6)) - Number(f.issueDate.slice(6));
    if (f.issueDate.slice(0, 5) !== f.expiryDate.slice(0, 5) || (years !== 5 && years !== 10)) {
      warn.push("Дата выдачи «" + f.issueDate + "» и окончание «" + f.expiryDate +
        "» не сходятся: у загранпаспорта РФ это один и тот же день, разница ровно 5 или 10 лет. Проверьте обе даты.");
    }
  }
  if (f.expiryDate) {
    const p = f.expiryDate.split(".");
    const exp = new Date(Number(p[2]), Number(p[1]) - 1, Number(p[0]));
    const days = Math.round((exp - Date.now()) / 86400e3);
    if (days < 0) warn.push("Паспорт просрочен (" + f.expiryDate + ")");
    else if (days < 180) warn.push("До окончания паспорта меньше полугода (" + f.expiryDate + ") — для многих виз этого мало");
  }
  return { fields: f, warnings: warn, confirmed };
}

async function recognizeOne(buf, name, mime, ctx) {
  if (isHeic(name, mime)) {
    try {
      const c = await heicToJpeg(buf, name);
      buf = c.buf; name = c.name; mime = "image/jpeg";
    } catch (e) {
      console.warn("scanner: HEIC не сконвертировался:", e.message);
      throw new Error("Не удалось прочитать «" + name + "»: файл HEIC повреждён или это живое фото (Live Photo). Пересохраните его в JPG.");
    }
  }
  const block = mediaBlock(buf, name, mime);
  if (!block) throw new Error("Формат «" + name + "» не поддерживается. Нужны JPG, PNG, HEIC, WEBP или PDF.");
  const task = "Извлеки данные из этого документа (обычно это разворот российского загранпаспорта). " +
    "Верни строго JSON по схеме. Если на снимке несколько документов — бери тот, что виден целиком." + lessonsBlock();
  const started = Date.now();
  const spend = [];
  const track = (r) => { if (r && r.usage) spend.push({ model: r.model, in: r.usage.input_tokens || 0, out: r.usage.output_tokens || 0, cw: r.usage.cache_creation_input_tokens || 0, cr: r.usage.cache_read_input_tokens || 0 }); };

  // Основной проход: effort low — это извлечение данных, а не рассуждение;
  // с ним ответ приходит в разы быстрее, а точность на печатном тексте та же.
  //
  // Второе мнение (SCANNER_DOUBLE_READ=1) — тот же снимок читается ещё раз,
  // ПАРАЛЛЕЛЬНО первому: по времени почти даром, по деньгам ровно вдвое.
  // Нужно оно тем полям, которые сверить больше не с чем: кириллица, дата
  // выдачи, код подразделения — в MRZ их нет, контрольных цифр у них нет.
  // Ошибку второе чтение не исправляет, а делает видимой: разошлись — снимаем
  // галочку и пишем оба варианта.
  const req = (nudge, mdl) => ({
    model: mdl || model(), max_tokens: 1500, system: SYS, output_config: { effort: "low" },
    messages: [{ role: "user", content: [block, { type: "text", text: task + (nudge || "") }] }],
  });
  const [r, rb] = await Promise.all([
    runJson(req(), SCHEMA),
    doubleRead()
      ? runJson(req("\n\nОсобое внимание — цифрам: номер, даты, код подразделения в поле «кем выдан». Перечитай каждую цифру по отдельности.",
          doubleRead() === "hard" ? modelHard() : null), SCHEMA).catch((e) => {
          console.warn("scanner: второе чтение не удалось:", e.message); return null;
        })
      : Promise.resolve(null),
  ]);
  track(r); track(rb);
  let ai = r.json || {};
  let mrz = parseMrzTd3(ai.mrz_line1, ai.mrz_line2);
  const mrzRaw = { line1: String((ai && ai.mrz_line1) || ""), line2: String((ai && ai.mrz_line2) || "") };
  let usedModel = r.model;

  // MRZ — наш якорь точности. Если она не прочиталась или контрольные цифры не
  // сошлись, перечитываем ТОЛЬКО две строки (маленький быстрый запрос), а не
  // весь документ заново.
  // Отдельный повод перечитать: контрольные цифры сошлись, но имена в первой
  // строке разошлись с напечатанным в паспорте (цифрами имена не проверяются)
  // И спор не решается транслитерацией кириллицы. Если решается — не платим.
  if (!mrz || !mrz.valid || mrzNamesUnresolved(mrz, ai)) {
    try {
      const r2 = await runJson({
        model: modelHard(), max_tokens: 300, output_config: { effort: "low" },
        system: "Ты переписываешь машиночитаемую зону (MRZ) документа символ в символ.",
        messages: [{ role: "user", content: [block, { type: "text", text:
          "Внизу страницы паспорта — две машиночитаемые строки крупным моноширинным шрифтом, ровно по 44 знака каждая. Перепиши их ТОЧНО, знак в знак. Знак-заполнитель — «<» (не пробел, не «к»). В первой строке фамилия отделена от имени ДВУМЯ знаками «<<» подряд — не потеряй ни один из них и не потеряй ни одной буквы фамилии. Если этих строк на снимке нет или они не читаются — верни две ПУСТЫЕ строки; не составляй их из напечатанных данных. Верни строго JSON: {\"mrz_line1\":\"…\",\"mrz_line2\":\"…\"}." }] }],
      }, MRZ_SCHEMA);
      track(r2);
      const m2 = parseMrzTd3(r2.json && r2.json.mrz_line1, r2.json && r2.json.mrz_line2);
      // Что лучше: сошедшиеся контрольные цифры весомее, но имена, сошедшиеся
      // с напечатанным, тоже стоят в зачёт — иначе «валидная» MRZ с испорченной
      // первой строкой останется победителем.
      const score = (m) => (!m ? -1 : (m.valid ? 3 : 0) + (mrzNamesSuspect(m, ai) ? 0 : 2));
      if (m2 && score(m2) > score(mrz)) { mrz = m2; usedModel = usedModel + "+" + r2.model; }
      if (r2.json) { mrzRaw.retry1 = String(r2.json.mrz_line1 || ""); mrzRaw.retry2 = String(r2.json.mrz_line2 || ""); }
    } catch (e) { console.warn("scanner: перечитка MRZ не удалась:", e.message); }
  }

  // Полная перечитка сильной моделью — только если документ вообще не прочитан.
  if (!ai.surname_ru && !ai.number && modelHard() !== model()) {
    try {
      const r3 = await runJson({
        model: modelHard(), max_tokens: 1500, system: SYS, output_config: { effort: "low" },
        messages: [{ role: "user", content: [block, { type: "text", text: task + "\n\nПредыдущая попытка ничего не прочитала. Прочитай заново, внимательно." }] }],
      }, SCHEMA);
      track(r3);
      if (r3.json && r3.json.surname_ru) {
        ai = r3.json; usedModel = r3.model;
        const m3 = parseMrzTd3(r3.json.mrz_line1, r3.json.mrz_line2);
        if (m3 && (!mrz || m3.valid)) mrz = m3;
      }
    } catch (e) { console.warn("scanner: полная перечитка не удалась:", e.message); }
  }

  // Прицельное чтение мелкого шрифта — двух полей, которые сверить больше не с
  // чем: кода подразделения и даты выдачи (в MRZ их нет, контрольных цифр нет).
  // Главное здесь не «спросить ещё раз», а спросить по ВЫРЕЗКЕ страницы в
  // исходном разрешении: на целом снимке «МВД 77438» читалось как 77436, 77449,
  // 77409 — каждый раз по-новому, а по вырезке трижды из трёх верно.
  let alt = null, pageShort = 0;
  if (smallPrintCheck()) {
    let cropBlock = null, cropGain = 1, cropUsed = null;
    try {
      const box = sanePageBox(ai.page_box);
      const c = cropToJpeg(buf, mime, name, box, 5);
      if (c) {
        // Меньше ~900 точек на страницу — мелкий шрифт не различить никакими
        // ухищрениями, честнее об этом сказать сотруднику.
        pageShort = c.delivered;
        if (c.buf) { cropBlock = mediaBlock(c.buf, "crop.jpg", "image/jpeg"); cropGain = c.gain; cropUsed = c.used; }
      }
    } catch (e) { console.warn("scanner: вырезка страницы не удалась:", e.message); }
    try {
      if (cropBlock) {
        // Второе чтение по вырезке — ВСЕХ полей, а не только мелких: на
        // увеличенной странице модель верно читает и фамилию, и место
        // рождения, и отчество, где на общем снимке путала буквы.
        const rc = await runJson({
          model: model(), max_tokens: 1500, system: SYS, output_config: { effort: "low" },
          messages: [{ role: "user", content: [cropBlock, { type: "text", text:
            "Это увеличенная страница того же паспорта. Прочитай данные заново, внимательно: шрифт здесь крупнее, чем на общем снимке. " + task }] }],
        }, SCHEMA);
        track(rc);
        if (rc && rc.json) {
          const j = rc.json;
          // Вырезке верим целиком только если она про тот же документ:
          // сверяем номер с подтверждённой MRZ.
          const same = mrz && mrz.valid
            ? String(j.number || "").replace(/\D/g, "") === String(mrz.number || "").replace(/\D/g, "")
            : false;
          alt = {
            cropped: true, trusted: same && cropGain >= 1.2,
            authority: j.authority, issueDate: j.issue_date,
            surnameRu: j.surname_ru, nameRu: j.name_ru, patronymicRu: j.patronymic_ru, birthPlace: j.birth_place,
          };
          // Код подразделения — самое больное место: пять мелких цифр под
          // голограммой. Даже на вырезке страницы «78004» читается как «78604».
          // Поэтому режем ещё раз, уже по самой строке кода: там цифры занимают
          // весь кадр. Рамку берём из чтения по вырезке и пересчитываем в
          // координаты исходного снимка, запрос выходит копеечным — картинка
          // крошечная.
          try {
            const ab = saneLineBox(j.authority_box);
            const used = cropUsed;
            if (ab && used) {
              const abs = {
                x: used.x + ab.x * used.w / 100, y: used.y + ab.y * used.h / 100,
                w: ab.w * used.w / 100, h: ab.h * used.h / 100,
              };
              const line = cropToJpeg(buf, mime, name, abs, 2);
              if (line && line.buf && line.w >= 120) {
                const rl = await runJson({
                  model: model(), max_tokens: 80,
                  system: "Ты переписываешь то, что видишь на снимке. Ничего не додумывай.",
                  messages: [{ role: "user", content: [mediaBlock(line.buf, "line.jpg", "image/jpeg"), { type: "text", text:
                    "На картинке — строка из паспорта с кодом подразделения: «МВД» или «ФМС» и пять цифр. Перепиши её, рассматривая каждую цифру отдельно. Часть цифры может быть перекрыта голограммой — ориентируйся на видимые части контура. Строго JSON: {\"authority\":\"МВД 12345\"}." }] }],
                }, SMALL_SCHEMA);
                track(rl);
                if (rl && rl.json && /\d{5}/.test(String(rl.json.authority || ""))) alt.authorityLine = String(rl.json.authority).trim();
              }
            }
          } catch (e) { console.warn("scanner: вырезка строки с кодом не удалась:", e.message); }
          // MRZ на вырезке тоже крупнее — вдруг разберётся лучше.
          const mc = parseMrzTd3(j.mrz_line1, j.mrz_line2);
          const sc = (m) => (!m ? -1 : (m.valid ? 3 : 0) + (mrzNamesSuspect(m, ai) ? 0 : 2));
          if (mc && sc(mc) > sc(mrz)) { mrz = mc; usedModel = usedModel + "+вырезка"; }
        }
      } else {
        // Рамку не нашли — спрашиваем по общему снимку хотя бы про мелкий шрифт.
        const rs = await runJson({
          model: model(), max_tokens: 200,
          system: "Ты извлекаешь данные из фотографий документов для визового агентства. Отвечай строго тем, что видишь: ничего не додумывай. Если поля не видно — верни пустую строку.",
          messages: [{ role: "user", content: [block, { type: "text", text:
            "Найди в паспорте две строки: «Дата выдачи / Date of issue» и «Орган, выдавший документ / Authority». Код подразделения набран мелко — рассмотри каждую цифру отдельно, не угадывай число целиком. Если цифры не различаются уверенно — верни пустые строки, не гадай. Верни строго JSON: {\"issue_date\":\"ДД.ММ.ГГГГ\",\"authority\":\"МВД 12345\"}." }] }],
        }, SMALL_SCHEMA);
        track(rs);
        if (rs && rs.json) alt = { authority: rs.json.authority, issueDate: rs.json.issue_date, cropped: false, trusted: false };
      }
    } catch (e) { console.warn("scanner: чтение по вырезке не удалось:", e.message); }
  }
  const { fields, warnings, confirmed } = buildFields(ai, mrz, alt);
  if (pageShort && pageShort < 900) {
    warnings.unshift("Снимок мелкий: страница паспорта — всего " + pageShort + " точек по длинной стороне. Мелкий шрифт (код подразделения, отчество, место рождения) на таком читается ненадёжно — лучше запросить исходное фото, а не пересланный скриншот.");
  }

  // Сверка двух чтений. MRZ подставляем ОДНУ И ТУ ЖЕ, чтобы сравнивать именно
  // то, что модель увидела глазами, а не разбор машиночитаемой зоны.
  let secondRead = null;
  if (rb && rb.json) {
    const b = buildFields(rb.json, mrz);
    secondRead = { agreed: [], differ: [] };
    for (const fl of FIELDS) {
      const va = String(fields[fl.key] || ""), vb = String(b.fields[fl.key] || "");
      if (!va && !vb) continue;
      if (va === vb) { secondRead.agreed.push(fl.key); if (confirmed.indexOf(fl.key) < 0) confirmed.push(fl.key); continue; }
      secondRead.differ.push({ key: fl.key, a: va, b: vb });
      const i = confirmed.indexOf(fl.key);
      if (i >= 0) confirmed.splice(i, 1);                 // сверенным больше не считается
      warnings.push(fl.label + ": два чтения разошлись — «" + (va || "пусто") + "» и «" + (vb || "пусто") + "». Сверьте с документом.");
    }
  }

  const doc = {
    id: newId(), at: Date.now(), by: (ctx && ctx.by) || "",
    file: name, ms: Date.now() - started, model: usedModel,
    fields, warnings, confirmed, note: (ai.notes || "").trim(),
    mrz: mrz ? { line1: mrz.line1, line2: mrz.line2, valid: !!mrz.valid, checks: mrz.checks } : null,
    mrzRaw: mrz ? null : mrzRaw, // что модель увидела вместо MRZ — для разбора ошибок
    spend, corrected: false, secondRead,
    // Сырые ответы модели — чтобы потом заново прогнать разбор (сверку с MRZ,
    // даты, транслитерацию) БЕЗ обращения к ИИ: правки сотрудников проверяются
    // на них бесплатно. Персональных данных здесь не больше, чем в fields,
    // и живёт это ровно столько же — до чистки истории.
    raw: {
      ai: {
        doc_kind: ai.doc_kind, surname_ru: ai.surname_ru, name_ru: ai.name_ru, patronymic_ru: ai.patronymic_ru,
        surname_lat: ai.surname_lat, name_lat: ai.name_lat, birth_date: ai.birth_date, sex: ai.sex,
        birth_place: ai.birth_place, citizenship: ai.citizenship, number: ai.number,
        issue_date: ai.issue_date, expiry_date: ai.expiry_date, authority: ai.authority,
        mrz_line1: ai.mrz_line1, mrz_line2: ai.mrz_line2,
      },
      mrz: mrz ? { line1: mrz.line1, line2: mrz.line2 } : null,
      alt: alt || null,
    },
  };
  // Фото храним недолго — только чтобы разобрать ошибку, если сотрудник её пришлёт.
  try {
    ensureDirs();
    const ext = path.extname(name || "").toLowerCase() || ".jpg";
    const fn = doc.id + ext;
    fs.writeFileSync(path.join(FILES_DIR, fn), buf);
    doc.imgFile = fn;
  } catch (e) { console.warn("scanner: не сохранил файл:", e.message); }
  return doc;
}

// Удаление старых файлов и записей истории.
function purgeOldFiles() {
  const st = store();
  const now = Date.now();
  let n = 0;
  // Записи старше срока хранения истории — удаляем целиком (вместе с файлом).
  const keep = [];
  let dropped = 0;
  for (const d of st.docs) {
    if (now - d.at > KEEP_HISTORY_DAYS * 86400e3) {
      if (d.imgFile) { try { fs.unlinkSync(path.join(FILES_DIR, d.imgFile)); } catch (_) {} }
      dropped++;
    } else keep.push(d);
  }
  if (dropped) { st.docs = keep; console.log("scanner: из истории удалено записей по сроку (" + KEEP_HISTORY_DAYS + " дн.):", dropped); save(); }
  for (const d of st.docs) {
    if (!d.imgFile) continue;
    const days = d.corrected ? KEEP_CORRECTED_DAYS : KEEP_DAYS;
    if (now - d.at < days * 86400e3) continue;
    try { fs.unlinkSync(path.join(FILES_DIR, d.imgFile)); } catch (_) {}
    delete d.imgFile; d.imgPurged = true; n++;
  }
  if (n) { console.log("scanner: удалено файлов по сроку хранения:", n); save(); }
}

// ── Доступ из портала Кати (work.voyotravel.ru) ──
// Её сервис проксирует /scanner/api/* сюда; право определяется разделом
// «scanner» в ЕЁ data/portal.json (личные вкладки ∪ отделы). Ключей и настроек
// движка это не даёт: модель и лимиты живут только здесь.
const PORTAL_DATA_DIR = process.env.TRANSLATE_PORTAL_DATA || "/var/www/kateadmin/data";
const _portalCache = { at: 0, data: null };
function portalHasScanner(email) {
  if (!email) return false;
  if (Date.now() - _portalCache.at > 30000) {
    try { _portalCache.data = JSON.parse(fs.readFileSync(path.join(PORTAL_DATA_DIR, "portal.json"), "utf8")); }
    catch (_) { _portalCache.data = null; }
    _portalCache.at = Date.now();
  }
  const pj = _portalCache.data;
  if (!pj) return false;
  const e = String(email).toLowerCase().trim();
  const owners = [String(pj.owner || "").toLowerCase()].concat((pj.coOwners || []).map((x) => String(x).toLowerCase()));
  if (owners.indexOf(e) >= 0) return true;
  const u = (pj.users || {})[e];
  const tabs = new Set((u && Array.isArray(u.tabs)) ? u.tabs : []);
  for (const d of (pj.departments || [])) {
    if (Array.isArray(d.members) && d.members.indexOf(e) >= 0) (d.tabs || []).forEach((t) => tabs.add(t));
  }
  return tabs.has("scanner");
}

function mount(app, deps) {
  const getStaffFromReq = deps.getStaffFromReq;
  const CODE = String(process.env.SCANNER_CODE || process.env.TRANSLATE_CODE || "3451");
  const TOKEN_TTL = 30 * 24 * 3600 * 1000;
  const loginFails = new Map();

  function authTokens() { const st = store(); if (!st.auth) st.auth = {}; return st.auth; }
  function tokenFromReq(req) {
    const h = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
    return h || String(req.query.token || "").trim();
  }
  // Доступ: код сканера ИЛИ любая рабочая сессия (админ/руководитель).
  function requireScanner(req, res, next) {
    const tok = tokenFromReq(req);
    const rec = tok && authTokens()[tok];
    if (rec && Date.now() - (rec.at || 0) <= TOKEN_TTL) { req.who = rec.name || "сотрудник"; return next(); }
    const s = getStaffFromReq && getStaffFromReq(req);
    if (s) {
      // Свои (админ и руководители Андрея) — всегда. Аккаунты, заведённые Катей
      // в портале, — только если ей открыт им раздел «Сканер»: доступами её
      // сотрудников управляет она сама, как в переводах.
      const own = s.role === "admin" || (Array.isArray(s.perms) && s.perms.length > 0) || !!s.vscRestrict;
      if (own || portalHasScanner(s.email)) { req.who = s.name || s.email || "сотрудник"; return next(); }
      return res.status(401).json({ success: false, message: "Раздел «Сканер» вам не открыт — попросите Екатерину Зайцеву выдать доступ" });
    }
    return res.status(401).json({ success: false, message: "Нет доступа" });
  }

  app.get("/scanner", (req, res) => {
    res.set("Cache-Control", "no-store, no-cache, must-revalidate");
    res.sendFile(path.join(__dirname, "public", "scanner.html"));
  });

  app.post("/scanner/api/login", (req, res) => {
    const ip = String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();
    const hist = (loginFails.get(ip) || []).filter((t) => Date.now() - t < 24 * 3600 * 1000);
    if (hist.length >= 20) return res.status(429).json({ success: false, message: "Слишком много попыток, попробуйте завтра" });
    const b = req.body || {};
    if (String(b.code || "").trim() !== CODE) {
      hist.push(Date.now()); loginFails.set(ip, hist);
      return res.status(401).json({ success: false, message: "Неверный код" });
    }
    const tok = crypto.randomBytes(24).toString("hex");
    const at = authTokens();
    at[tok] = { at: Date.now(), name: String(b.name || "").slice(0, 60) };
    for (const k of Object.keys(at)) if (Date.now() - (at[k].at || 0) > TOKEN_TTL) delete at[k];
    save();
    return res.json({ success: true, token: tok });
  });

  const up = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024, files: 20 } });

  app.get("/scanner/api/state", requireScanner, (req, res) => {
    const st = store();
    res.json({
      success: true, aiConfigured: aiConfigured(), model: model(), me: req.who,
      fields: FIELDS,
      lessons: st.lessons.slice().reverse(),
      keepDays: KEEP_DAYS, keepCorrectedDays: KEEP_CORRECTED_DAYS, keepHistoryDays: KEEP_HISTORY_DAYS,
      recent: st.docs.slice(-30).reverse().map((d) => ({ id: d.id, at: d.at, by: d.by, file: d.file, fields: d.fields, warnings: d.warnings, mrz: d.mrz, ms: d.ms, corrected: d.corrected, hasImg: !!d.imgFile })),
    });
  });

  // Распознавание пачки файлов. Идут параллельно (до 4 одновременно) — сотрудник
  // кидает 5 паспортов и получает всё примерно за время одного.
  app.post("/scanner/api/parse", requireScanner, up.array("files", 20), async (req, res) => {
    if (!aiConfigured()) return res.status(400).json({ success: false, message: "ИИ не настроен: нет ANTHROPIC_API_KEY" });
    const files = req.files || [];
    if (!files.length) return res.status(400).json({ success: false, message: "Прикрепите фото или скан" });
    const named = files.map((f) => ({ buf: f.buffer, name: Buffer.from(f.originalname, "latin1").toString("utf8"), mime: f.mimetype }));
    const out = new Array(named.length);
    let idx = 0;
    const worker = async () => {
      for (;;) {
        const i = idx++;
        if (i >= named.length) return;
        const x = named[i];
        try { out[i] = { ok: true, doc: await recognizeOne(x.buf, x.name, x.mime, { by: req.who }) }; }
        catch (e) { out[i] = { ok: false, file: x.name, message: String((e && e.message) || e) }; }
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, named.length) }, worker));
    const st = store();
    out.forEach((r) => { if (r && r.ok) st.docs.push(r.doc); });
    if (st.docs.length > MAX_DOCS) st.docs.splice(0, st.docs.length - MAX_DOCS);
    save();
    res.json({ success: true, results: out });
  });

  // История сканирований: можно открыть прошлый документ и снова накопировать
  // поля. Записи живут KEEP_HISTORY_DAYS (90 дней), потом удаляются сами.
  app.get("/scanner/api/history", requireScanner, (req, res) => {
    const st = store();
    const q = String(req.query.q || "").trim().toLowerCase();
    const mine = String(req.query.mine || "") === "1";
    let list = st.docs.slice().reverse();
    if (mine) list = list.filter((d) => (d.by || "") === req.who);
    if (q) {
      list = list.filter((d) => {
        const f = d.fields || {};
        return [f.surnameRu, f.nameRu, f.patronymicRu, f.translit, f.number, f.numberOnly, d.file, d.by]
          .filter(Boolean).join(" ").toLowerCase().indexOf(q) >= 0;
      });
    }
    const total = list.length;
    const offset = Math.max(0, Number(req.query.offset) || 0);
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 30));
    res.json({
      success: true, total, offset, limit, keepDays: KEEP_HISTORY_DAYS,
      docs: list.slice(offset, offset + limit).map((d) => ({
        id: d.id, at: d.at, by: d.by, file: d.file, fields: d.fields, warnings: d.warnings,
        confirmed: d.confirmed || [], mrz: d.mrz ? { valid: d.mrz.valid } : null,
        corrected: !!d.corrected, hasImg: !!d.imgFile,
      })),
    });
  });

  // Что копируют сотрудники — для дашборда (какие поля реально нужны в работе).
  app.post("/scanner/api/copy", requireScanner, (req, res) => {
    const keys = Array.isArray(req.body && req.body.fields) ? req.body.fields : [String((req.body && req.body.field) || "")];
    const st = store();
    let n = 0;
    for (const k of keys) {
      const key = String(k || "").slice(0, 40);
      if (!FIELDS.some((f) => f.key === key) && key !== "__all" && key !== "__json") continue;
      st.copyStats[key] = (st.copyStats[key] || 0) + 1; n++;
    }
    if (n) save();
    res.json({ success: true });
  });

  app.get("/scanner/api/doc/:id/image", requireScanner, (req, res) => {
    const d = store().docs.find((x) => x.id === req.params.id);
    if (!d || !d.imgFile) return res.status(404).send("Нет файла");
    let buf;
    try { buf = fs.readFileSync(path.join(FILES_DIR, d.imgFile)); } catch (_) { return res.status(404).send("Файл удалён по сроку хранения"); }
    const ext = path.extname(d.imgFile).toLowerCase();
    res.set("Content-Type", { ".png": "image/png", ".pdf": "application/pdf", ".webp": "image/webp" }[ext] || "image/jpeg");
    res.set("Cache-Control", "private, max-age=300");
    res.send(buf);
  });

  // Правка сотрудника → сохраняем и выводим из неё общие правила на будущее.
  app.post("/scanner/api/correct", requireScanner, async (req, res) => {
    const b = req.body || {};
    const d = store().docs.find((x) => x.id === String(b.id || ""));
    if (!d) return res.status(404).json({ success: false, message: "Документ не найден (возможно, распознан давно)" });
    const after = {};
    const changed = [];
    for (const f of FIELDS) {
      if (b.fields && Object.prototype.hasOwnProperty.call(b.fields, f.key)) {
        const v = String(b.fields[f.key] == null ? "" : b.fields[f.key]).slice(0, 300).trim();
        after[f.key] = v;
        if (v !== (d.fields[f.key] || "")) changed.push({ key: f.key, label: f.label, was: d.fields[f.key] || "", now: v });
      }
    }
    const comment = String(b.comment || "").slice(0, 1500).trim();
    if (!changed.length && !comment) return res.status(400).json({ success: false, message: "Нечего сохранять: поля не изменены и комментария нет" });
    const before = Object.assign({}, d.fields);
    Object.assign(d.fields, after);
    d.corrected = true;
    const corr = { id: newId(), at: Date.now(), by: req.who, docId: d.id, file: d.file, changed, comment, learned: [] };
    store().corrections.push(corr);
    if (store().corrections.length > 1000) store().corrections.splice(0, store().corrections.length - 1000);
    save();

    // Обучение: из правки формулируем общие правила (best-effort, дешёвой моделью).
    let learned = [];
    try {
      const existing = lessons().map((l) => l.text);
      const r = await runJson({
        model: model(), max_tokens: 900,
        system: "Ты ведёшь базу правил для сервиса распознавания паспортов. Из правки сотрудника сформулируй 0–3 ОБЩИХ правила на будущее (по-русски, коротко, повелительно, применимо к ЛЮБОМУ такому документу). Разовые особенности одного скана правилом НЕ являются — тогда верни пустой список. Не дублируй существующие правила. Отвечай строго JSON: {\"lessons\":[\"правило\"]}.",
        messages: [{ role: "user", content:
          "Что исправил сотрудник:\n" + (changed.map((c) => "- " + c.label + ": было «" + c.was + "» → стало «" + c.now + "»").join("\n") || "(поля не менялись)") +
          "\n\nКомментарий сотрудника: " + (comment || "(нет)") +
          "\n\nСуществующие правила:\n" + (existing.join("\n") || "(пусто)") }],
      }, LESSONS_SCHEMA);
      learned = ((r.json && r.json.lessons) || []).map((t) => String(t).trim()).filter((t) => t && !existing.some((e) => e.toLowerCase() === t.toLowerCase())).slice(0, 3);
      for (const t of learned) lessons().push({ id: newId(), createdAt: Date.now(), text: t.slice(0, 400), source: "correction", sourceRef: d.id, by: req.who });
      corr.learned = learned;
      if (r.usage) (d.spend = d.spend || []).push({ model: r.model, in: r.usage.input_tokens || 0, out: r.usage.output_tokens || 0 });
      save();
    } catch (e) { console.warn("scanner lessons:", e.message); }

    res.json({ success: true, learned, before, fields: d.fields });
  });

  // Обучение на примерах: сотрудник грузит снимок и пишет, как правильно.
  // Сервис распознаёт его сам, сверяет с эталоном и выводит правила — как
  // «проверка прошлых переводов» в /translate.
  app.post("/scanner/api/example", requireScanner, up.single("file"), async (req, res) => {
    if (!aiConfigured()) return res.status(400).json({ success: false, message: "ИИ не настроен" });
    if (!req.file) return res.status(400).json({ success: false, message: "Прикрепите снимок документа" });
    const ref = String((req.body && req.body.reference) || "").slice(0, 4000).trim();
    if (!ref) return res.status(400).json({ success: false, message: "Напишите, как должно быть распознано (эталон)" });
    const name = Buffer.from(req.file.originalname, "latin1").toString("utf8");
    let doc;
    try { doc = await recognizeOne(req.file.buffer, name, req.file.mimetype, { by: req.who }); }
    catch (e) { return res.status(400).json({ success: false, message: String((e && e.message) || e) }); }
    doc.kind = "example";
    const st = store();
    st.docs.push(doc);
    const got = FIELDS.map((f) => f.label + ": " + (doc.fields[f.key] || "—")).join("\n");
    let learned = [], diff = "";
    try {
      const existing = lessons().map((l) => l.text);
      const r = await runJson({
        model: model(), max_tokens: 1200,
        system: "Ты ведёшь базу правил для сервиса распознавания паспортов. Тебе дают эталон (как ДОЛЖНО быть) и то, что распозналось. Найди расхождения и сформулируй 0–5 ОБЩИХ правил на будущее (по-русски, коротко, повелительно, применимо к любому такому документу). Если расхождений нет — верни пустой список. Не дублируй существующие правила. Отвечай строго JSON: {\"lessons\":[\"правило\"],\"diff\":\"краткий разбор расхождений по-русски\"}.",
        messages: [{ role: "user", content: "ЭТАЛОН (как правильно):\n" + ref + "\n\nРАСПОЗНАЛОСЬ:\n" + got + "\n\nСуществующие правила:\n" + (existing.join("\n") || "(пусто)") }],
      }, EXAMPLE_SCHEMA);
      learned = ((r.json && r.json.lessons) || []).map((t) => String(t).trim()).filter((t) => t && !existing.some((e) => e.toLowerCase() === t.toLowerCase())).slice(0, 5);
      diff = String((r.json && r.json.diff) || "").slice(0, 1500);
      for (const t of learned) lessons().push({ id: newId(), createdAt: Date.now(), text: t.slice(0, 400), source: "example", sourceRef: doc.id, by: req.who });
    } catch (e) { console.warn("scanner example:", e.message); }
    st.examples.push({ id: newId(), at: Date.now(), by: req.who, file: name, docId: doc.id, reference: ref, learned, diff });
    if (st.examples.length > 300) st.examples.splice(0, st.examples.length - 300);
    save();
    res.json({ success: true, fields: doc.fields, warnings: doc.warnings, learned, diff, docId: doc.id });
  });

  app.post("/scanner/api/lesson", requireScanner, (req, res) => {
    const text = String((req.body && req.body.text) || "").trim().slice(0, 400);
    if (!text) return res.status(400).json({ success: false, message: "Пустое правило" });
    lessons().push({ id: newId(), createdAt: Date.now(), text, source: "manual", by: req.who });
    save();
    res.json({ success: true });
  });
  app.delete("/scanner/api/lesson/:id", requireScanner, (req, res) => {
    const ls = lessons();
    const i = ls.findIndex((l) => l.id === req.params.id);
    if (i < 0) return res.status(404).json({ success: false, message: "Не найдено" });
    ls.splice(i, 1); save();
    res.json({ success: true });
  });

  app.get("/scanner/api/stats", requireScanner, (req, res) => {
    const st = store();
    const month = /^\d{4}-\d{2}$/.test(String(req.query.month || "")) ? String(req.query.month) : "";
    const key = (t) => { const d = new Date(t); return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0"); };
    const docs = month ? st.docs.filter((d) => key(d.at) === month) : st.docs;
    const corrs = month ? st.corrections.filter((c) => key(c.at) === month) : st.corrections;
    const tally = (arr, fn) => {
      const m = new Map();
      arr.forEach((x) => { const k = fn(x) || "—"; m.set(k, (m.get(k) || 0) + 1); });
      return Array.from(m, ([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count);
    };
    const ms = docs.map((d) => d.ms || 0).filter(Boolean).sort((a, b) => a - b);
    const rub = docs.reduce((s, d) => s + costRub(d.spend), 0);
    const mrzOk = docs.filter((d) => d.mrz && d.mrz.valid).length;
    const fieldFixes = new Map();
    corrs.forEach((c) => (c.changed || []).forEach((ch) => fieldFixes.set(ch.label, (fieldFixes.get(ch.label) || 0) + 1)));
    const days = new Map();
    st.docs.slice(-2000).forEach((d) => {
      const k = new Date(d.at).toISOString().slice(0, 10);
      days.set(k, (days.get(k) || 0) + 1);
    });
    const months = Array.from(new Set(st.docs.map((d) => key(d.at)))).sort().reverse();
    res.json({
      success: true, month, months,
      totals: {
        docs: docs.length,
        corrected: docs.filter((d) => d.corrected).length,
        cleanPct: docs.length ? Math.round((1 - docs.filter((d) => d.corrected).length / docs.length) * 100) : null,
        mrzPct: docs.length ? Math.round(mrzOk / docs.length * 100) : null,
        // Перечитка — это запрос СВЕРХ обычных (второе чтение, если включено,
        // обычным и считается), поэтому порог зависит от режима документа.
        rereadPct: docs.length ? Math.round(docs.filter((d) => (d.spend || []).length > (d.secondRead ? 2 : 1)).length / docs.length * 100) : null,
        doubleReadPct: docs.length ? Math.round(docs.filter((d) => d.secondRead).length / docs.length * 100) : null,
        doubleDiffer: docs.filter((d) => d.secondRead && d.secondRead.differ.length).length,
        // Контрольные цифры имена не покрывают, поэтому «MRZ сошлась» о ФИО ничего
        // не говорит: считаем отдельно, как часто два чтения латиницы разошлись.
        latMismatch: docs.filter((d) => (d.warnings || []).some((w) => /два чтения разошлись/.test(w))).length,
        avgSec: ms.length ? +(ms.reduce((a, b) => a + b, 0) / ms.length / 1000).toFixed(1) : 0,
        medSec: ms.length ? +(ms[Math.floor(ms.length / 2)] / 1000).toFixed(1) : 0,
        rub: Math.round(rub * 10) / 10,
        rubPerDoc: docs.length ? +(rub / docs.length).toFixed(2) : 0,
        lessons: st.lessons.length,
        corrections: corrs.length,
      },
      copyStats: FIELDS.map((f) => ({ name: f.label, key: f.key, count: st.copyStats[f.key] || 0 }))
        .filter((x) => x.count > 0).sort((a, b) => b.count - a.count),
      examples: st.examples.slice(-20).reverse().map((e) => ({ id: e.id, at: e.at, by: e.by, file: e.file, learned: e.learned, diff: e.diff })),
      byKind: tally(docs, (d) => d.fields && d.fields.docKind),
      byUser: tally(docs, (d) => d.by),
      fieldFixes: Array.from(fieldFixes, ([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count),
      byDay: Array.from(days, ([name, count]) => ({ name, count })).sort((a, b) => a.name.localeCompare(b.name)).slice(-14),
      corrections: corrs.slice(-40).reverse().map((c) => ({ id: c.id, at: c.at, by: c.by, file: c.file, docId: c.docId, changed: c.changed, comment: c.comment, learned: c.learned })),
    });
  });

  purgeOldFiles();
  setInterval(purgeOldFiles, 6 * 3600 * 1000);
}

module.exports = { mount, recognizeOne, jpegInsidePdf, decodeImage, cropToJpeg, parseMrzTd3, mrzCheckDigit, buildFields, reconcileLat, mrzNamesSuspect, mrzNamesUnresolved, prettyRuNumber, translit, citizenshipEn, FIELDS };
