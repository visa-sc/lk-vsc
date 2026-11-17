#!/usr/bin/env node
/* ─────────────────────────────────────────────────────────────────────────────
 * kateReadAccess — Екатерине Зайцевой (пользователь kateadmin) ЧТЕНИЕ всего нашего на
 * сервере, кроме ak-co.ru и ключей (17.11.2026, решение Андрея: «пусть может всё
 * прочитать и скопировать код, но не менять и не удалять; ak-co — нет»).
 *
 * Как устроено (ACL, пакет acl):
 *   • /var/www/voyo (основной проект: сайт, ЛК, eSIM, /vsc, CRM-копия, инструменты) —
 *     u:kateadmin:r-X (читать файлы, входить в папки). Писать нельзя: права записи не
 *     даются, владелец — root.
 *   • Ключи и входы — явный запрет u:kateadmin:--- (.env и все его копии, файлы сессий,
 *     токенов ссылок, авторизации по телефону, *.pem/*.key). Явная запись сильнее «прочих».
 *   • ak-co.ru (/var/www/akfin — личные финансы, карта) — явный запрет на саму папку:
 *     внутрь не войти вообще. Остальным пользователям (akco для /aroma) — как было.
 *   • Копии сайтов (mskcopy, ekbcopy, spbcopy, olyabi, visa-sc-com, spain…) и так открыты
 *     на чтение всем, их .env — 600 у своих владельцев; не трогаем.
 *   • Снимок расписания root (crontab, без значений key=/token=) и списка служб pm2 —
 *     /var/www/voyo/.server-snapshot/ (сама /root закрыта: там ключи ssh и копии).
 * Новые файлы: раз в 10 минут — только изменившееся с прошлого прохода (по ctime),
 * ночью — полный проход. Ключи среди новых файлов НЕ открываются никогда.
 * Самопроверка: от имени kateadmin читается server.js и НЕ читаются .env и ak-co;
 * сбой — письмо Андрею (одно на сбой).
 * Запуск: node tools/kateReadAccess.js [--full] [--dry]
 * Откат целиком: setfacl -R -x u:kateadmin /var/www/voyo; setfacl -x u:kateadmin /var/www/akfin
 * ───────────────────────────────────────────────────────────────────────────── */
"use strict";
const fs = require("fs");
const path = require("path");
const { execFileSync, execSync } = require("child_process");

const DRY = process.argv.includes("--dry");
const STAMP = "/var/lib/kate-read-access.stamp";
const STATE = "/var/lib/kate-read-access.json";
const U = "kateadmin";
const GRANT = ["/var/www/voyo"];
const DENY_DIRS = ["/var/www/akfin"];
const SNAP = "/var/www/voyo/.server-snapshot";
// Ключи и входы: имя файла (или любой папки по пути) подходит — читать нельзя.
const SECRET = [
  /^\.env/i,                       // .env, .env.bak-*, .env.20260702…
  /sessions?\.json$/i,             // .lkManagerSessions.json, authSessions.json, …
  /tokens?\.json$/i,               // .shareTokens.json, .feedbackTokens.json
  /^\.lkAuth/i,                    // .lkAuthPhones.json, .lkAuthStatus.json
  /\.(pem|key|p12|pfx)$/i,
  /^id_(rsa|ed25519|ecdsa)/i,
  /^\.npmrc$|^\.git-credentials$|^\.netrc$/i,
  /cookies?\.(json|txt)$/i,
  // Не ключ, но деликатное: список к планёркам с самой Катей (ФОТ, сокращения, «воспитательная
  // беседа»). С 05.08 — только админ; закрыто до явного решения Андрея (17.11.2026).
  /^\.vscPlanerka/i
];
const isSecret = (p) => SECRET.some((re) => re.test(path.basename(p)));

function setfacl(spec, files) {
  for (let i = 0; i < files.length; i += 400) {
    const part = files.slice(i, i + 400);
    if (DRY) { console.log("[dry] setfacl", spec, part.length, "шт., пример:", part[0]); continue; }
    try { execFileSync("setfacl", ["-P", "-m", spec, "--"].concat(part), { stdio: ["ignore", "ignore", "pipe"] }); }
    catch (e) { console.log("setfacl", spec, "ошибка:", String(e.stderr || e.message).slice(0, 300)); }
  }
}
function walk(dir, since, out) {
  let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isSymbolicLink()) continue;
    let st; try { st = fs.lstatSync(p); } catch (_) { continue; }
    if (!since || st.ctimeMs > since) (isSecret(p) ? out.deny : out.grant).push(p);
    if (e.isDirectory()) walk(p, since, out);
  }
}
function canRead(p) {
  try { execFileSync("runuser", ["-u", U, "--", "test", "-r", p], { stdio: "ignore" }); return true; } catch (_) { return false; }
}
async function mail(subject, html) {
  if (DRY) { console.log("[dry] письмо:", subject); return; }
  try {
    require("dotenv").config({ path: path.join(__dirname, "..", ".env"), quiet: true });
    await require(path.join(__dirname, "..", "mail.js")).sendMail({ to: "director@visa-sc.ru", subject, html });
  } catch (e) { console.log("письмо не ушло:", e.message); }
}
function snapshot() {
  try {
    fs.mkdirSync(SNAP, { recursive: true });
    const cron = execSync("crontab -l", { encoding: "utf8" })
      .replace(/((?:key|token|pass(?:word)?|secret)=)[^\s&]+/gi, "$1***");
    const pm2 = execSync("pm2 jlist", { encoding: "utf8", maxBuffer: 32 << 20 });
    const list = JSON.parse(pm2).map((p) => p.name + "\t" + p.pm2_env.status + "\t" + p.pm2_env.pm_cwd + "\t" +
      (p.pm2_env.pm_exec_path || "")).join("\n");
    const head = "# Снимок для чтения (tools/kateReadAccess.js), " + new Date().toISOString() + "\n";
    if (!DRY) {
      fs.writeFileSync(path.join(SNAP, "crontab-root.txt"), head + cron);
      fs.writeFileSync(path.join(SNAP, "pm2-root.txt"), head + list + "\n");
    }
  } catch (e) { console.log("снимок:", e.message); }
}

(async () => {
  const t0 = Date.now();
  const full = process.argv.includes("--full") || !fs.existsSync(STAMP);
  const since = full ? 0 : fs.statSync(STAMP).mtimeMs;
  const startedAt = new Date();
  snapshot();
  const out = { grant: [], deny: [] };
  for (const d of GRANT) { out.grant.push(d); walk(d, since, out); }
  // сами корни — всегда: войти в /var/www/voyo
  setfacl("u:" + U + ":rX", out.grant);
  setfacl("u:" + U + ":---", out.deny);
  setfacl("u:" + U + ":---", DENY_DIRS.filter((d) => fs.existsSync(d)));
  // Отметку ставим ПОСЛЕ setfacl: он сам меняет ctime обработанных файлов, и с отметкой на
  // начало прохода каждый следующий проход заново брал бы всё, что тронул предыдущий.
  // Созданное в эти секунды подберёт ночной полный проход.
  if (!DRY) fs.writeFileSync(STAMP, String(startedAt.toISOString()));

  // Самопроверка
  const bad = [];
  if (!canRead("/var/www/voyo/server.js")) bad.push("не читается /var/www/voyo/server.js");
  if (canRead("/var/www/voyo/.env")) bad.push("ЧИТАЕТСЯ /var/www/voyo/.env");
  if (canRead("/var/www/akfin/server.js")) bad.push("ЧИТАЕТСЯ ak-co (/var/www/akfin)");
  if (canRead("/var/www/voyo/.lkManagerSessions.json")) bad.push("ЧИТАЕТСЯ файл входов админки");
  let st = {}; try { st = JSON.parse(fs.readFileSync(STATE, "utf8")); } catch (_) {}
  const sig = bad.join("|");
  console.log(new Date().toISOString() + (full ? " полный" : " новое") + ": открыто " + out.grant.length +
    ", ключей закрыто " + out.deny.length + ", " + (Date.now() - t0) + " мс" + (bad.length ? "; СБОЙ: " + sig : "; проверка ок"));
  if (sig && sig !== st.sig) {
    await mail("Доступ Кати к серверу: сбой проверки", "<p>Сторож доступа Кати (tools/kateReadAccess.js) нашёл:</p><ul>" +
      bad.map((b) => "<li>" + b + "</li>").join("") + "</ul>");
  }
  if (!DRY) fs.writeFileSync(STATE, JSON.stringify({ sig: sig, at: new Date().toISOString(), full: full }));
})();
