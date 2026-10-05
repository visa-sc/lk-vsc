// ═══════════════════════════════════════════════════════════════════════════
// Сторож формулы калькулятора ВНЖ: режим «Приход в USDT».
//
// Правило Андрея (05.10.2026): долг партнёру в USDT считается по КУРСУ ДЛЯ РАСХОДА
// (b7), как в режимах евро и рубли. До этого в режиме USDT стоял курс доллара ЦБ —
// это была ошибка. Калькулятор живёт в трёх копиях, и одна из них (у Зайцевой на
// work.voyotravel.ru) правится независимо, поэтому строку легко случайно откатить.
//
// Что делает: раз в сутки читает три файла и проверяет, каким курсом умножается
// долг партнёру в ветке USDT. Пишет Андрею только при СМЕНЕ состояния (сломалось /
// починилось) — не каждый день. Ничего не откатывает и не блокирует: Катя может
// менять свою копию как раньше, сторож лишь сообщает. Об этой проверке написано
// прямо в комментарии у формулы в её файле.
//
// Запуск: cron, cd /var/www/voyo && node tools/calcFormulaGuard.js
//         --dry  — только показать состояние, ничего не писать и не слать.
// ═══════════════════════════════════════════════════════════════════════════
const fs = require("fs");
const path = require("path");
const ROOT = path.join(__dirname, "..");
try { require("dotenv").config({ path: path.join(ROOT, ".env") }); } catch (_) {}

const DRY = process.argv.includes("--dry");
const STATE = path.join(ROOT, ".calcFormulaGuard.json");
const TO = "director@visa-sc.ru";

const COPIES = [
  { id: "public", name: "voyotravel.ru/calc (копия Андрея)", file: path.join(ROOT, "public/calc.html") },
  { id: "vsc", name: "вкладка «Калькулятор ВНЖ» в /vsc", file: path.join(ROOT, "public/admin.html") },
  { id: "kate", name: "work.voyotravel.ru → Инструменты → Калькуляторы (копия Зайцевой)", file: "/var/www/kateadmin/public/calc.html" },
];

// Ветка USDT: else { seif = prihod * usd; uslugi = partner * <КУРС>; }
const RE = /else\s*\{\s*seif\s*=\s*prihod\s*\*\s*usd\s*;\s*uslugi\s*=\s*partner\s*\*\s*([A-Za-z_$][\w$.]*)\s*;/;

function check(c) {
  let src;
  try { src = fs.readFileSync(c.file, "utf8"); }
  catch (e) { return { ok: false, why: "файл не читается: " + (e && e.code || e && e.message) }; }
  const m = src.match(RE);
  if (!m) return { ok: false, why: "строка расчёта режима USDT не найдена — формулу переписали иначе, нужно посмотреть глазами" };
  if (m[1] !== "b7") return { ok: false, why: "долг партнёру умножается на «" + m[1] + "» вместо курса для расхода (b7)" };
  return { ok: true, why: "по курсу для расхода (b7)" };
}

function loadState() { try { return JSON.parse(fs.readFileSync(STATE, "utf8")) || {}; } catch (_) { return {}; } }

(async () => {
  const prev = loadState(), now = {}, changed = [];
  for (const c of COPIES) {
    const r = check(c);
    now[c.id] = { ok: r.ok, why: r.why, at: new Date().toISOString() };
    const was = prev[c.id];
    if (!was || was.ok !== r.ok) changed.push({ c, r, first: !was });
    console.log((r.ok ? "OK   " : "FAIL ") + c.name + " — " + r.why);
  }
  if (DRY) return;
  fs.writeFileSync(STATE, JSON.stringify(now, null, 2));

  // Первый запуск — это просто снимок исходного состояния. Пишем только если уже что-то не так.
  const toMail = changed.filter((x) => !(x.first && x.r.ok));
  if (!toMail.length) return;

  const rows = toMail.map((x) =>
    '<li style="margin-bottom:6px;"><b>' + x.c.name + '</b>: ' +
    (x.r.ok ? '<span style="color:#1f8f4d;">снова верно</span> — ' : '<span style="color:#b0263a;">формула изменилась</span> — ') +
    x.r.why + '</li>').join("");
  const broken = toMail.some((x) => !x.r.ok);
  const html = '<div style="font-family:-apple-system,\'Segoe UI\',Roboto,Arial,sans-serif;font-size:15px;color:#1d1d1f;line-height:1.55;max-width:620px;">'
    + '<p>Андрей, сторож калькулятора ВНЖ заметил изменение в режиме «Приход в USDT».</p>'
    + '<ul style="padding-left:20px;">' + rows + '</ul>'
    + '<p>Правило: долг партнёру в USDT считается по курсу для расхода, как в евро и рублях (твоё решение 05.10.2026).'
    + (broken ? ' Сторож ничего не откатывал — если правка случайная, скажи, верну.' : '') + '</p>'
    + '<p style="color:#8a8a8e;font-size:13px;margin-top:18px;">VOYO · Visa Services Center</p></div>';
  try {
    const mail = require(path.join(ROOT, "mail"));
    const r = await mail.sendMail({ to: TO, subject: broken ? "Калькулятор ВНЖ: формула USDT изменилась" : "Калькулятор ВНЖ: формула USDT снова верная", html });
    console.log("письмо:", JSON.stringify(r));
  } catch (e) { console.error("calcFormulaGuard mail:", e && e.message); }
})();
