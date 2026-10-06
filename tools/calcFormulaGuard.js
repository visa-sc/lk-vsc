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
  { id: "kate", name: "work.voyotravel.ru → Инструменты → Калькуляторы (копия Зайцевой)", file: "/var/www/kateadmin/public/calc.html", backupNear: true },
];
const fi = argv.indexOf("--files");
if (fi >= 0 && argv[fi + 1]) COPIES = argv[fi + 1].split(",").map((f, i) => ({ id: "t" + i, name: f, file: f, backupNear: true }));

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

// Чего починить нельзя — пишем в лог, но не чаще раза в сутки (иначе каждые 10 минут).
function warnOnce(c, st, why) {
  const today = new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Moscow" });
  if (!DRY && st[c.id] === today) return;
  if (!DRY) st[c.id] = today;
  log((DRY ? "[dry] " : "") + c.name + ": " + why);
}

const st = loadState();
for (const c of COPIES) {
  try { heal(c, st); } catch (e) { log(c.name + ": ошибка сторожа — " + (e && e.message)); }
}
saveState(st);
if (DRY) for (const c of COPIES) {
  try { const m = fs.readFileSync(c.file, "utf8").match(RE); console.log((m && m[1] === WANT ? "OK   " : "НАДО ") + c.name + " — " + (m ? "«" + m[1] + "»" : "строка не найдена")); }
  catch (e) { console.log("НЕТ  " + c.name + " — " + (e && e.code)); }
}
