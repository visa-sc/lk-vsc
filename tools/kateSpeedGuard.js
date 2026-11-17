#!/usr/bin/env node
/* ─────────────────────────────────────────────────────────────────────────────
 * kateSpeedGuard — сторож правок скорости чата Кати (16.11.2026, просьба Андрея: «чтобы
 * не затёрли»). Раз в час смотрит в файлы службы work.voyotravel.ru и проверяет, что
 * правки на месте — по тем же меткам, что записаны в /var/www/kateadmin/ПРАВКИ-АНДРЕЯ.md
 * (раздел «16.11.2026 — скорость чата и портала»).
 *
 * Пропала правка — пишет в комнату «Помощники» (Кате и её Claude: что пропало и где
 * копия) и письмо Андрею. Об одном и том же наборе пропаж — один раз; вернули — пишет
 * «снова на месте». Ничего не чинит сам: файлы Кати правятся только с её ведома.
 * Запуск: node tools/kateSpeedGuard.js [--dry]   cron: раз в час.
 * ───────────────────────────────────────────────────────────────────────────── */
"use strict";
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
require("dotenv").config({ path: path.join(__dirname, "..", ".env"), quiet: true });

const DRY = process.argv.includes("--dry");
const K = "/var/www/kateadmin/";
const STATE = "/var/lib/kate-speed-guard.json";
const ROOM = "gmvcc6iz9pmsc";             // «Помощники»
// [файл, что ищем (регулярка), сколько минимум совпадений, что это]
const CHECKS = [
  ["notify-chat.js", /loadMonthRO|cfgRO/g, 8, "чат: чтение из памяти (ветки, закреплённые, поиск, настройки)"],
  ["notify-chat.js", /livePulse/g, 3, "чат: живой канал (новые сообщения сразу)"],
  ["notify-chat.js", /function sharpLib/g, 1, "чат: лёгкие копии картинок для ленты"],
  ["cq-feed.js", /const ASKS/g, 1, "«Стафф»: память расчёта просьб об отзыве"],
  ["sverki-api.js", /cqSaveSoon/g, 2, "приём Wazzup: запись порцией, а не на каждое сообщение"],
  ["kassa-ofd.js", /monthDataRO/g, 6, "касса: чтение ОФД из памяти (дела кассы)"],
  ["kassa-api.js", /amoAtRO/g, 2, "касса: дата выгрузки amo из памяти"],
  ["clients-api.js", /AMOU_MEM/g, 3, "клиенты: справочник amo из памяти"],
  ["public/chat.html", /voyo_chat_mem_v1|onRooms\(|thumbUrl|liveStart/g, 8, "страница чата: память на устройстве, мгновенное переключение, лёгкие картинки, живой канал"],
  ["public/chat-sw.js", /isShell/g, 2, "служебный работник: запросы к серверу мимо него"],
  ["public/chat.html", /unreadOffNow/g, 2, "страница чата: счётчик непрочитанного гаснет сразу при открытии"],
  ["public/chat.html", /rmNow/g, 5, "страница чата: отметка «непрочитано», «не беспокоить» и булавка — сразу"],
  ["public/chat.html", /читаем ДО rmNow/g, 2, "страница чата: колокольчик и булавка включаются обратно (исправление 15:41)"],
  ["public/chat.html", /avaForget/g, 3, "страница чата: новое фото видно сразу после загрузки (аудит 15:43)"],
  ["public/chat.html", /\.side:not\(\.hide\) ~ \.main\{visibility:hidden\}/g, 1, "страница чата (телефон): закреп и «Вчера/Сегодня» не просвечивают сквозь список (17.11)"],
  ["public/chat.html", /\?w=160/g, 1, "страница чата: лёгкие копии фото людей (17.11)"],
  ["notify-chat.js", /AVA_THUMB/g, 1, "чат: сервер отдаёт лёгкие копии фото (?w=160, 17.11)"],
  ["public/chat.html", /data-gal=/g, 1, "страница чата: фото листаются стрелками и свайпом (17.11)"],
  ["public/chat.html", /stickEnd/g, 8, "страница чата: переписка открывается в самом низу, догрузка фото не сдвигает (17.11, седьмой круг)"],
  ["public/chat.html", /avaPend|thumbPend|filePend/g, 12, "страница чата: один запрос на фото человека и на файл, без повторов (17.11, седьмой круг)"],
  ["public/chat.html", /--tabh|tabFit/g, 6, "страница чата (телефон): список, «Дела» и круглая кнопка не уходят под нижнюю панель (17.11, восьмой круг)"],
  ["public/chat.html", /meKeep/g, 3, "страница чата: «Дела» и «Уведомления» открываются сразу из памяти (17.11, девятый круг)"]
];

function count(file, re) {
  try { return (fs.readFileSync(K + file, "utf8").match(re) || []).length; } catch (_) { return -1; }
}
function say(text, key) {
  if (DRY) { console.log("[dry] в Помощники:", text); return; }
  const tmp = "/tmp/kate-speed-guard-" + process.pid + ".txt";
  try {
    fs.writeFileSync(tmp, text, { mode: 0o644 });
    execSync("runuser -u kateadmin -- node " + K + "claude-say.js " + tmp + " " + ROOM + " " + key, { timeout: 30000, stdio: "ignore" });
  } catch (e) { console.log("чат: не отправлено —", e.message); }
  try { fs.unlinkSync(tmp); } catch (_) {}
}
async function mail(subject, html) {
  if (DRY) { console.log("[dry] письмо:", subject); return; }
  try { await require(path.join(__dirname, "..", "mail.js")).sendMail({ to: "director@visa-sc.ru", subject, html }); }
  catch (e) { console.log("письмо не ушло:", e.message); }
}

(async () => {
  const miss = CHECKS.filter(([f, re, min]) => count(f, re) < min);
  let st = {}; try { st = JSON.parse(fs.readFileSync(STATE, "utf8")); } catch (_) {}
  const sig = miss.map((c) => c[0] + ":" + c[3]).join("|");
  const now = new Date().toISOString();
  console.log(now + " правок на месте " + (CHECKS.length - miss.length) + " из " + CHECKS.length + (miss.length ? "; нет: " + sig : ""));
  if (sig === (st.sig || "")) return;                         // ничего не изменилось с прошлого раза
  if (miss.length) {
    const list = miss.map((c) => "• " + c[0] + " — " + c[3]).join("\n");
    say("@Екатерина Зайцева, Claude Кати — сторож основного сервера: пропали правки скорости чата от 16.11 " +
        "(их список и проверка — в ПРАВКИ-АНДРЕЯ.md, раздел «16.11.2026 — скорость чата и портала»):\n" + list +
        "\n\nСкорее всего файл переписали со старой копии. Пожалуйста, верни правки: копии с ними лежат рядом " +
        "(*.bak-20261116-speed…), или напиши здесь — поможем.", "speed-guard-" + Date.now());
    await mail("Чат Кати: пропали правки скорости",
      "<p>Сторож нашёл, что из файлов службы work.voyotravel.ru пропали правки скорости чата от 16.11:</p><ul>" +
      miss.map((c) => "<li><b>" + c[0] + "</b> — " + c[3] + "</li>").join("") +
      "</ul><p>Кате и её Claude написал в «Помощники». Скажите — верну сам.</p>");
  } else if (st.sig) {
    say("Сторож основного сервера: правки скорости чата от 16.11 снова на месте. Спасибо!", "speed-guard-ok-" + Date.now());
  }
  if (!DRY) fs.writeFileSync(STATE, JSON.stringify({ sig: sig, at: now }));
})();
