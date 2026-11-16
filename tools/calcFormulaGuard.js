// ═══════════════════════════════════════════════════════════════════════════
// Сторож формулы калькулятора ВНЖ: режим «Приход в USDT». САМОВОССТАНОВЛЕНИЕ.
//
// Правило Андрея (06.10.2026): в режиме USDT и приход, и долг партнёру считаются по
// КУРСУ ЦБ (usd). С 05 по 06.10 долг считался по курсу для расхода (b7), Андрей вернул
// курс ЦБ; прошлое не пересчитывается. Калькулятор живёт в трёх копиях, и одна из них
// (у Зайцевой на work.voyotravel.ru) правится независимо, поэтому строку легко
// случайно откатить — например, положив поверх старую версию файла.
//
// Что делает (решение Андрея 06.10.2026: «чтобы само управлялось, без писем»):
// каждую минуту читает три файла и, если в ветке USDT долг партнёру умножается
// не на usd, САМ возвращает usd. Меняется ровно один множитель в одной строке —
// остальной код сверяется до и после и должен совпасть байт-в-байт, иначе правка
// не пишется. Перед заменой — бэкап, владелец и права файла сохраняются. Писем нет,
// только строка в лог. Если строку переписали так, что её не узнать, — файл не
// трогаем (чинить вслепую нельзя), пишем в лог раз в сутки.
// О самовосстановлении написано прямо в комментарии у формулы в файле Зайцевой.
//
// Запуск: cron каждую минуту, cd /var/www/voyo && node tools/calcFormulaGuard.js
//         --dry               — только показать, что было бы сделано
//         --files a,b,c       — проверить другие файлы (для тестов)
//         --kate-test         — с --files: проверять в них и откат страховки, как у Зайцевой
// ═══════════════════════════════════════════════════════════════════════════
const fs = require("fs");
const path = require("path");
const ROOT = path.join(__dirname, "..");

const argv = process.argv.slice(2);
const DRY = argv.includes("--dry");
const STATE = path.join(ROOT, ".calcFormulaGuard.json");
const BACKUPS = "/root/voyo-backups";

let COPIES = [
  { id: "public", name: "voyotravel.ru/calc (копия Андрея)", file: path.join(ROOT, "public/calc.html") },
  { id: "vsc", name: "вкладка «Калькулятор ВНЖ» в /vsc", file: path.join(ROOT, "public/admin.html") },
  // бэкап Катиного файла кладём рядом с ним — ей видно, что и когда восстанавливалось
  { id: "kate", name: "work.voyotravel.ru → Инструменты → Калькуляторы (копия Зайцевой)", file: "/var/www/kateadmin/public/calc.html", backupNear: true, insurance: true },
];
const fi = argv.indexOf("--files");
if (fi >= 0 && argv[fi + 1]) COPIES = argv[fi + 1].split(",").map((f, i) => ({ id: "t" + i, name: f, file: f, backupNear: true, insurance: argv.includes("--kate-test") }));

const WANT = "usd";
const NOTE = "// ⚠ ПРАВИЛО АНДРЕЯ (06.10.2026): в режиме USDT и приход, и долг партнёру — по курсу ЦБ (usd). Сервер проверяет эту строку каждую минуту и восстанавливает её автоматически; поменять правило — через Андрея.";
// Ветка USDT: else { seif = prihod * usd; uslugi = partner * <КУРС>; }
const RE = /else\s*\{\s*seif\s*=\s*prihod\s*\*\s*usd\s*;\s*uslugi\s*=\s*partner\s*\*\s*([A-Za-z_$][\w$.]*)\s*;/;

const stamp = () => new Date().toLocaleString("sv-SE", { timeZone: "Europe/Moscow" }).replace(" ", "_").replace(/:/g, "");
const log = (msg) => console.log(new Date().toLocaleString("ru-RU", { timeZone: "Europe/Moscow" }) + "  " + msg);
// код без комментариев — для проверки, что кроме множителя ничего не поменялось
const strip = (t) => t.replace(/<!--[\s\S]*?-->/g, "").replace(/\/\/[^\n]*/g, "").replace(/\s+/g, " ");

function loadState() { try { return JSON.parse(fs.readFileSync(STATE, "utf8")) || {}; } catch (_) { return {}; } }
function saveState(s) { if (DRY) return; try { fs.writeFileSync(STATE, JSON.stringify(s, null, 2)); } catch (_) {} }

function heal(c, st) {
  let src, info;
  try { src = fs.readFileSync(c.file, "utf8"); info = fs.statSync(c.file); }
  catch (e) { return warnOnce(c, st, "файл не читается (" + (e && e.code || e && e.message) + ")"); }

  const m = src.match(RE);
  if (!m) return warnOnce(c, st, "строка расчёта режима USDT не найдена — формулу переписали иначе, файл не трогаю");
  if (m[1] === WANT) { delete st[c.id]; return; }                     // всё верно — молчим

  // Заменяем ТОЛЬКО множитель внутри найденной строки.
  const fixedLine = m[0].replace(/(uslugi\s*=\s*partner\s*\*\s*)[A-Za-z_$][\w$.]*(\s*;)$/, "$1" + WANT + "$2");
  let fixed = src.slice(0, m.index) + fixedLine + src.slice(m.index + m[0].length);
  // Устаревший хвостовой комментарий «…по курсу для расхода…» на той же строке — переписываем,
  // чтобы текст не спорил с кодом (это только комментарий, код не меняется).
  {
    const ls = fixed.lastIndexOf("\n", m.index) + 1, le = fixed.indexOf("\n", m.index);
    const line = fixed.slice(ls, le < 0 ? fixed.length : le);
    const ci = line.indexOf("//", line.indexOf(fixedLine) + fixedLine.length);
    if (ci >= 0 && /курсу для расхода/.test(line.slice(ci))) {
      const nl = line.slice(0, ci) + "// режим USDT: и приход, и долг партнёру — по курсу ЦБ (правило Андрея 06.10.2026)";
      fixed = fixed.slice(0, ls) + nl + fixed.slice(ls + line.length);
    }
  }
  // Пометка-пояснение отдельной строкой НАД формулой (не в конце строки — там дальше идёт «}»).
  // Ставим, только если рядом её нет: после перезаливки файла без комментария она вернётся сама.
  const lineStart = fixed.lastIndexOf("\n", m.index) + 1;
  if (fixed.slice(Math.max(0, lineStart - 800), lineStart).indexOf("ПРАВИЛО АНДРЕЯ") < 0) {
    const indent = (fixed.slice(lineStart).match(/^[ \t]*/) || [""])[0];
    fixed = fixed.slice(0, lineStart) + indent + NOTE + "\n" + fixed.slice(lineStart);
  }
  const expected = strip(src).replace(strip(m[0]).trim(), strip(fixedLine).trim());
  if (strip(fixed) !== expected || fixed === src) return warnOnce(c, st, "не удалось безопасно заменить множитель «" + m[1] + "» — файл не трогаю");

  if (DRY) { log("[dry] " + c.name + ": вернул бы курс ЦБ (сейчас «" + m[1] + "»)"); return; }

  const bak = c.backupNear
    ? c.file + ".bak-" + stamp() + "-autofix"
    : path.join(BACKUPS, path.basename(c.file) + "." + stamp() + ".autofix.bak");
  fs.copyFileSync(c.file, bak);
  try { fs.chownSync(bak, info.uid, info.gid); } catch (_) {}

  const tmp = c.file + ".autofix-tmp";
  fs.writeFileSync(tmp, fixed);
  try { fs.chownSync(tmp, info.uid, info.gid); } catch (_) {}         // владелец прежний (у Кати — kateadmin)
  fs.chmodSync(tmp, info.mode & 0o7777);
  fs.renameSync(tmp, c.file);                                          // атомарно: файл никогда не бывает «наполовину»
  delete st[c.id];
  log(c.name + ": курс в режиме USDT был «" + m[1] + "» — вернул курс ЦБ (usd). Бэкап: " + bak);
}

// Чего починить нельзя — пишем в лог, но не чаще раза в сутки (иначе каждую минуту).
function warnOnce(c, st, why, key) {
  const k = key || c.id;
  const today = new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Moscow" });
  if (!DRY && st[k] === today) return;
  if (!DRY) st[k] = today;
  log((DRY ? "[dry] " : "") + c.name + ": " + why);
}

// ═══ Калькулятор страхования у Зайцевой: защита ТОЛЬКО от отката к старой версии ═══
// Решения Андрея 12.10.2026:
//  • если правки 02.10.2026 (Совкомбанк, возраст по дате рождения, вёрстка) пропадут
//    из-за перезаливки СТАРОЙ версии файла — сервер вернёт их сам;
//  • но Катя должна и дальше менять свою копию сама, НЕЗАВИСИМО от калькулятора Андрея.
// Поэтому:
//  1) эталон — снимок её собственной копии на 12.10.2026 (tools/calc-guard-kate-insurance.json),
//     а не калькулятор Андрея: его изменения к ней не попадают;
//  2) срабатываем только на «подпись» версии старше 02.10 — заголовок скрипта
//     «КАЛЬКУЛЯТОР СТРАХОВАНИЯ АБСОЛЮТ» или карточка страхования без переключателя страховых.
//     Любые её доработки текущей версии (тарифы, страховые, вёрстка — что угодно) не трогаем.
// Её оформление (шапка, логотип, #0093ce) и расчёт ВНЖ не трогаем: до записи сверяем, что
// функция расчёта ВНЖ совпадает, логотип и цвет на месте, скрипт страницы разбирается.
const SNAPSHOT = path.join(__dirname, "calc-guard-kate-insurance.json");

function block(s, start, end) {
  const i = s.indexOf(start); if (i < 0 || s.indexOf(start, i + 1) >= 0) return null;   // нет или не единственный — не трогаем
  const j = s.indexOf(end, i + 1); if (j < 0) return null;
  return { i, j, text: s.slice(i, j) };
}
const vnzCalc = (s) => { const i = s.indexOf("function comp(){"); return i < 0 ? null : strip(s.slice(i, s.indexOf("function scheduleMismatchLog", i))); };
const jsOk = (s) => { let bad = 0; s.replace(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g, (m, js) => { try { new Function(js); } catch (_) { bad++; } }); return !bad; };
const count = (s, x) => s.split(x).length - 1;
// версия страхового калькулятора старше 02.10.2026
const isOldInsurance = (s) => s.includes("// ══ КАЛЬКУЛЯТОР СТРАХОВАНИЯ АБСОЛЮТ") || (s.includes('id="cardIns"') && !s.includes('id="segIns"'));

function healInsurance(c, st) {
  const KEY = c.id + ":ins";
  let src, info;
  try { src = fs.readFileSync(c.file, "utf8"); info = fs.statSync(c.file); } catch (_) { return; }   // нечитаемость уже пишет heal()
  if (!isOldInsurance(src)) { delete st[KEY]; return; }            // её текущая версия, какой бы она ни была, — не трогаем

  let snap; try { snap = JSON.parse(fs.readFileSync(SNAPSHOT, "utf8")); } catch (_) { return warnOnce(c, st, "снимок страховки не читается — не восстанавливаю", KEY); }
  if (!snap.js || !snap.html || !snap.cssDob || !snap.cssSeg || !snap.cssMob) return warnOnce(c, st, "снимок страховки неполный — не восстанавливаю", KEY);

  let s = src;
  // карточка
  const kHTML = block(s, '    <p class="sub"', '    <div class="receipt" id="receipt"></div>');
  if (!kHTML) return warnOnce(c, st, "залита старая версия, но не нашёл в ней карточку страхования — не трогаю", KEY);
  s = s.slice(0, kHTML.i) + snap.html + s.slice(kHTML.j);
  // скрипт (вместе с пометкой «ПРАВКА АНДРЕЯ», если она стояла над старым заголовком — заменяем и её)
  const jsStart = s.indexOf("  // ПРАВКА АНДРЕЯ (02.10.2026)") >= 0 && s.indexOf("  // ПРАВКА АНДРЕЯ (02.10.2026)") < s.indexOf("  // ══ КАЛЬКУЛЯТОР СТРАХОВАНИЯ")
    ? "  // ПРАВКА АНДРЕЯ (02.10.2026)" : "  // ══ КАЛЬКУЛЯТОР СТРАХОВАНИЯ";
  const kJS = block(s, jsStart, "\n  // ── Переключатель «Калькулятор ВНЖ / Страхование» ──");
  if (!kJS) return warnOnce(c, st, "залита старая версия, но не нашёл в ней скрипт страхования — не трогаю", KEY);
  s = s.slice(0, kJS.i) + snap.js + s.slice(kJS.j);
  // стили: поле даты, сегменты, «46–60 дней» на мобильном
  if (!s.includes("/* Ввод даты рождения")) {
    const r = block(s, "  .receipt { margin-top: 22px;", "}");
    if (!r) return warnOnce(c, st, "не нашёл место для стилей поля даты — не трогаю", KEY);
    s = s.slice(0, r.i) + snap.cssDob + s.slice(r.i);
  }
  if (!s.includes("/* Шрифт мельче и перенос длинных слов")) {
    const kSEG = block(s, "  .seg button {", "\n  .seg button.on");
    if (!kSEG) return warnOnce(c, st, "не нашёл стиль кнопок-сегментов — не трогаю", KEY);
    s = s.slice(0, kSEG.i) + snap.cssSeg + s.slice(kSEG.j);
  }
  if (!s.includes("#segDur button:nth-child(4)")) {
    const on = block(s, "  .seg button.on {", "\n");
    if (!on) return warnOnce(c, st, "не нашёл стиль выбранного сегмента — не трогаю", KEY);
    s = s.slice(0, on.j + 1) + snap.cssMob + s.slice(on.j + 1);
  }

  // Предохранители: вернули что нужно и ничего лишнего не задели.
  const why = isOldInsurance(s) || !s.includes("var SOV_BASE") || !s.includes("dobInput") ? "после вставки версия всё ещё старая"
    : vnzCalc(src) == null || vnzCalc(src) !== vnzCalc(s) ? "изменился бы расчёт ВНЖ (или не найден)"
    : count(s, "brand-logo") < count(src, "brand-logo") || count(s, "0093ce") < count(src, "0093ce") ? "задело бы оформление площадки"
    : !jsOk(s) ? "скрипт страницы перестал бы разбираться" : null;
  if (why) return warnOnce(c, st, "страховку не восстанавливаю: " + why, KEY);

  if (DRY) { log("[dry] " + c.name + ": залита версия старше 02.10 — вернул бы Совкомбанк, дату рождения и вёрстку"); return; }
  const bak = c.backupNear ? c.file + ".bak-" + stamp() + "-autoins" : path.join(BACKUPS, path.basename(c.file) + "." + stamp() + ".autoins.bak");
  fs.copyFileSync(c.file, bak);
  try { fs.chownSync(bak, info.uid, info.gid); } catch (_) {}
  const tmp = c.file + ".autoins-tmp";
  fs.writeFileSync(tmp, s);
  try { fs.chownSync(tmp, info.uid, info.gid); } catch (_) {}
  fs.chmodSync(tmp, info.mode & 0o7777);
  fs.renameSync(tmp, c.file);
  delete st[KEY];
  log(c.name + ": залита версия старше 02.10 — вернул Совкомбанк, возраст по дате рождения и вёрстку. Бэкап: " + bak);
}

const st = loadState();
for (const c of COPIES) {
  if (c.insurance) { try { healInsurance(c, st); } catch (e) { log(c.name + ": ошибка сторожа (страховка) — " + (e && e.message)); } }
  try { heal(c, st); } catch (e) { log(c.name + ": ошибка сторожа — " + (e && e.message)); }
}
saveState(st);
if (DRY) for (const c of COPIES) {
  try { const m = fs.readFileSync(c.file, "utf8").match(RE); console.log((m && m[1] === WANT ? "OK   " : "НАДО ") + c.name + " — " + (m ? "«" + m[1] + "»" : "строка не найдена")); }
  catch (e) { console.log("НЕТ  " + c.name + " — " + (e && e.code)); }
}
