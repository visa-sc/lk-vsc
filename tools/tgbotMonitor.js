// ═══════════════════════════════════════════════════════════════════════════
// Внешний монитор телеграм-бота eSIM (@esimvoyo_bot). Крон каждые 5 минут:
//   */5 * * * * cd /var/www/voyo && node tools/tgbotMonitor.js >> .esim/tgmonitor.log 2>&1
//
// Зачем, если у бота есть свой сторож внутри приложения. Внутренний сторож не
// увидит поломку, при которой сам бот не запустился (ошибка при загрузке модуля)
// или весь его таймер встал. Этот скрипт живёт отдельно и смотрит снаружи.
//
// Разделение обязанностей, чтобы письма не дублировались:
//   • сайт целиком лежит            → /root/voyo-guard.sh (перезапуск, откат кода);
//   • нет связи с телеграмом         → сторож внутри tgbot.js;
//   • всё остальное про бота         → этот монитор.
//
// Что чинит сам, без писем:
//   • .env не заканчивается переносом строки — дописывает перенос. Именно из-за
//     этого 12.09.2026 новый ключ приклеился к адресу ретранслятора и бот молчал;
//   • строка ESIM_TG_RELAY или ESIM_TG_TOKEN склеена с соседней — расклеивает
//     по строгому виду значения, с резервной копией .env;
//   • опрос бота завис, а внутренний сторож его не поднял — перезапускает
//     приложение, не чаще раза в 30 минут.
//
// О чём пишет на director@visa-sc.ru (только пн 08:00 – пт 15:00 МСК):
//   • бот не запустился в приложении;
//   • опрос завис и перезапуск не помог;
//   • бот падает на сообщениях клиентов (5 и больше ошибок за 30 минут),
//     если внутренний сторож по какой-то причине сам не написал.
// Повтор раз в 12 часов, после починки — письмо «снова работает».
// ═══════════════════════════════════════════════════════════════════════════
const APP = process.env.TGMON_APP || "/var/www/voyo";   // переопределяется только для обкатки
require(APP + "/node_modules/dotenv").config({ path: APP + "/.env", quiet: true });
const fs = require("fs");
const http = require("http");
const { execSync } = require("child_process");

const ENV = APP + "/.env";
const STATE = APP + "/.esim/tgmonitor.json";
const WATCH = APP + "/.esim/tgwatch.json";
const TO = process.env.ESIM_TG_ALERT_TO || "director@visa-sc.ru";
const ADM = process.env.ESIM_ADMIN_CODE || "280992";
const BOT = process.env.ESIM_TG_USERNAME || "esimvoyo_bot";
const ALERT_AFTER_MS = 10 * 60 * 1000;
const REPEAT_MS = 12 * 3600 * 1000;
const RESTART_GAP_MS = 30 * 60 * 1000;

const now = Date.now();
const log = (m) => console.log(new Date(now + 3 * 3600 * 1000).toISOString().slice(0, 16).replace("T", " ") + " " + m);
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch (_) { return d; } };
const writeJson = (f, d) => fs.writeFileSync(f, JSON.stringify(d, null, 1));

function inMailWindow() {
  const msk = new Date(now + 3 * 3600 * 1000);
  const day = msk.getUTCDay(), hour = msk.getUTCHours();
  if (day === 0 || day === 6) return false;
  if (day === 1) return hour >= 8;
  if (day === 5) return hour < 15;
  return true;
}
function humanDur(ms) {
  const m = Math.round(ms / 60000);
  if (m < 60) return m + " мин";
  const h = Math.floor(m / 60);
  return h < 48 ? h + " ч " + (m % 60) + " мин" : Math.floor(h / 24) + " дн " + (h % 24) + " ч";
}
const esc = (s) => String(s || "").replace(/</g, "&lt;");

function get(path) {
  return new Promise((resolve) => {
    const req = http.get({ host: "127.0.0.1", port: 3000, path, timeout: 15000 }, (r) => {
      let b = ""; r.on("data", (c) => (b += c)); r.on("end", () => resolve({ code: r.statusCode, body: b }));
    });
    req.on("error", () => resolve({ code: 0, body: "" }));
    req.on("timeout", () => { req.destroy(); resolve({ code: 0, body: "" }); });
  });
}

// ── 1. Санитария .env: перенос в конце и склеенные строки бота ──────────────
// Значения не печатаем никогда. Расклеиваем только там, где вид значения строгий
// и однозначный, иначе можно порезать чужой ключ.
function fixEnv() {
  let src;
  try { src = fs.readFileSync(ENV, "utf8"); } catch (e) { log("не читается .env: " + e.message); return false; }
  let out = src;
  const notes = [];
  const STRICT = {
    ESIM_TG_RELAY: /^(https:\/\/[^\s\/]+\/[0-9a-f]{32})(.*)$/,
    ESIM_TG_TOKEN: /^(\d{6,12}:[A-Za-z0-9_-]{35})(.*)$/,
  };
  const lines = out.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const eq = lines[i].indexOf("=");
    const name = eq > 0 ? lines[i].slice(0, eq) : "";
    if (!STRICT[name]) continue;
    const m = STRICT[name].exec(lines[i].slice(eq + 1));
    if (!m || !m[2]) continue;
    const tail = m[2];
    const tm = /^([A-Z][A-Z0-9_]{2,})=/.exec(tail);
    if (!tm) continue;                       // хвост не похож на переменную — не трогаем, пусть смотрит человек
    lines[i] = name + "=" + m[1];
    if (lines.indexOf(tail) >= 0) notes.push(name + ": отрезан приклеенный дубль " + tm[1]);
    else { lines.splice(i + 1, 0, tail); notes.push(name + ": приклеенная " + tm[1] + " вынесена на свою строку"); }
  }
  out = lines.join("\n");
  if (out.length && !out.endsWith("\n")) { out += "\n"; notes.push("в конец .env дописан перенос строки"); }
  if (out === src) return false;
  fs.writeFileSync(ENV + ".bak-monitor-" + new Date(now).toISOString().slice(0, 19).replace(/[:T]/g, "-"), src, { mode: 0o600 });
  fs.writeFileSync(ENV, out, { mode: 0o600 });
  notes.forEach((n) => log("починил .env — " + n));
  return notes.some((n) => /ESIM_TG_/.test(n));   // перенос строки перезапуска не требует
}

function sendMail(subject, html) {
  try {
    const mail = require(APP + "/mail.js");
    return Promise.resolve(mail.sendMail({ to: TO, replyTo: TO, subject, html,
      text: html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() }))
      .then((r) => { log("письмо «" + subject + "» " + (r && r.ok === false ? "НЕ ушло: " + r.error : "отправлено")); return !(r && r.ok === false); })
      .catch((e) => { log("письмо не ушло: " + e.message); return false; });
  } catch (e) { log("почта недоступна: " + e.message); return Promise.resolve(false); }
}

function pm2Uptime() {
  try {
    const list = JSON.parse(execSync("pm2 jlist", { encoding: "utf8", timeout: 20000 }));
    const v = list.find((p) => p.name === "voyo");
    return v ? now - v.pm2_env.pm_uptime : 0;
  } catch (_) { return 0; }
}

(async () => {
  const st = readJson(STATE, { problems: {} });
  st.problems = st.problems || {};

  // 1. Сначала чиним то, что чинится само
  const envFixed = fixEnv();

  // 2. Сайт целиком — забота voyo-guard.sh, мы в это не лезем
  const site = await get("/");
  if (site.code !== 200) { log("сайт не отвечает (" + site.code + "), это забота voyo-guard"); writeJson(STATE, st); return; }
  if (envFixed) {
    log("строки бота в .env были склеены — перезапускаю приложение, чтобы оно прочитало исправленные");
    try { execSync("pm2 restart voyo --silent", { timeout: 60000 }); st.lastRestartAt = now; } catch (e) { log("перезапуск не удался: " + e.message); }
    writeJson(STATE, st);
    return;
  }

  // 3. Состояние бота глазами приложения
  const h = await get("/esim/api/tg/health?adm=" + encodeURIComponent(ADM));
  let s = null;
  try { s = JSON.parse(h.body); } catch (_) {}
  const uptime = pm2Uptime();
  const found = {};

  if (h.code === 404 || !s) {
    // Сайт жив, а ручки бота нет — модуль бота не поднялся при старте
    if (uptime > 3 * 60 * 1000) {
      found.notMounted = "Сайт работает, но бот в приложении не запустился: страница состояния бота не отвечает (код " + h.code + "). " +
        "Чаще всего это ошибка в коде tgbot.js при загрузке или пропал ESIM_TG_TOKEN в .env. Смотреть лог: pm2 logs voyo --err.";
    }
  } else {
    // Опрос завис, а внутренний сторож не поднял его сам
    if (s.polling && s.lastLoopAgoSec != null && s.lastLoopAgoSec > 300) {
      const canRestart = !st.lastRestartAt || now - st.lastRestartAt > RESTART_GAP_MS;
      if (canRestart && uptime > 10 * 60 * 1000) {
        log("опрос бота стоит " + s.lastLoopAgoSec + " с, внутренний сторож не справился — перезапускаю приложение");
        try { execSync("pm2 restart voyo --silent", { timeout: 60000 }); st.lastRestartAt = now; } catch (e) { log("перезапуск не удался: " + e.message); }
      } else {
        found.stalled = "Опрос бота стоит " + humanDur(s.lastLoopAgoSec * 1000) + ". Автоматический перезапуск приложения уже был и не помог. Нужна ручная проверка: pm2 logs voyo.";
      }
    }
    // Бот падает на сообщениях. Внутренний сторож тоже пишет об этом —
    // дублируем, только если он молчит (например, у него самого ошибка).
    const w = readJson(WATCH, {});
    if (s.handlerErrors30m >= 5 && !(w.crashAlertedAt && now - w.crashAlertedAt < REPEAT_MS)) {
      found.crashing = "За последние 30 минут бот " + s.handlerErrors30m + " раз упал при обработке сообщений клиентов. " +
        "Это ошибка в коде, сама не пройдёт. Последняя: " + esc(s.lastHandlerError);
    }
  }

  // 4. Письма: новое — через 10 минут, повтор — раз в 12 часов, починилось — «снова работает»
  const TITLES = {
    notMounted: "Бот @" + BOT + " не запустился",
    stalled: "Бот @" + BOT + " завис, перезапуск не помог",
    crashing: "Бот @" + BOT + " падает на сообщениях клиентов",
  };
  for (const key of Object.keys(TITLES)) {
    const p = st.problems[key];
    if (found[key]) {
      if (!p) { st.problems[key] = { since: now }; log("замечено: " + key); continue; }
      p.detail = found[key];
      // 10 минут форы: за это время внутренний сторож успевает написать сам, и дубля не будет
      if (now - p.since < ALERT_AFTER_MS) continue;
      if (p.alertedAt && now - p.alertedAt < REPEAT_MS) continue;
      if (!inMailWindow()) continue;
      const ok = await sendMail(TITLES[key],
        "<p><b>" + TITLES[key] + "</b>, уже " + humanDur(now - p.since) + ".</p><p>" + found[key] + "</p>" +
        "<p style=\"color:#8b93a5\">Когда починится, придёт письмо «снова работает». Повтор — через 12 часов.</p>");
      if (ok) p.alertedAt = now;
    } else if (p) {
      if (p.alertedAt && !p.recoveredAt) p.recoveredAt = now;
      if (p.alertedAt) {
        if (!inMailWindow()) continue;             // «снова работает» подождёт окна
        const ok = await sendMail("Бот @" + BOT + " снова работает",
          "<p>Проблема «" + TITLES[key].replace("Бот @" + BOT + " ", "") + "» устранена.</p>" +
          "<p>Длилась " + humanDur(p.recoveredAt - p.since) + ".</p>");
        if (!ok) continue;
      }
      log("прошло: " + key);
      delete st.problems[key];
    }
  }

  st.lastRunAt = now;
  writeJson(STATE, st);
})().catch((e) => log("монитор упал: " + e.message));
