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
  // 18.11.2026: КАЖДАЯ правка — своя метка (подсказка Claude Кати: общий порог «N и больше» не видел
  // частичного отката — версия до 15:43 давала 10 при пороге 8). Минимум = было в копии ДО правки + 1.
  ["notify-chat.js", /loadMonthRO/g, 8, "чат: чтение переписок из памяти (ветки, закреплённые, поиск)"],
  ["notify-chat.js", /cfgRO/g, 1, "чат: настройки из памяти"],
  ["notify-chat.js", /readJsonRO/g, 6, "чат: чтение файлов из памяти"],
  ["notify-chat.js", /listDirRO/g, 3, "чат: список файлов/фото из памяти"],
  ["notify-chat.js", /livePulse/g, 1, "чат: живой канал (новые сообщения сразу)"],
  ["notify-chat.js", /liveFlush/g, 1, "чат: живой канал, отправка пачкой"],
  ["notify-chat.js", /function sharpLib/g, 1, "чат: лёгкие копии картинок для ленты"],
  ["notify-chat.js", /AVA_THUMB/g, 1, "чат: сервер отдаёт лёгкие копии фото людей (?w=160)"],
  ["notify-chat.js", /FOLK/g, 1, "чат: участники веток по индексу"],
  ["notify-chat.js", /RCACHE/g, 7, "чат: увеличенный кэш чтений"],
  ["cq-feed.js", /const ASKS/g, 1, "«Стафф»: память расчёта просьб об отзыве"],
  ["sverki-api.js", /cqSaveSoon/g, 2, "приём Wazzup: запись порцией, а не на каждое сообщение"],
  ["sverki-api.js", /cqSeen/g, 1, "приём Wazzup: проверка повтора по памяти"],
  ["sverki-api.js", /cqFlush/g, 1, "приём Wazzup: запись при остановке и раз в 5 минут"],
  ["kassa-ofd.js", /monthDataRO/g, 6, "касса: чтение ОФД из памяти"],
  ["kassa-api.js", /amoAtRO/g, 2, "касса: дата выгрузки amo из памяти"],
  ["clients-api.js", /AMOU_MEM/g, 3, "клиенты: справочник amo из памяти"],
  ["public/chat-sw.js", /isShell/g, 2, "служебный работник: запросы к серверу мимо него"],
  ["public/chat.html", /voyo_chat_mem_v1/g, 1, "страница: память на устройстве (запуск сразу)"],
  ["public/chat.html", /onRooms\(/g, 1, "страница: список из памяти без лишней перерисовки"],
  ["public/chat.html", /roomMem/g, 1, "страница: мгновенное переключение переписок"],
  ["public/chat.html", /thumbUrl/g, 1, "страница: лёгкие картинки в ленте"],
  ["public/chat.html", /liveStart/g, 1, "страница: живой канал"],
  ["public/chat.html", /liveListAt/g, 1, "страница: опрос не дублирует живой канал"],
  ["public/chat.html", /prefetchUnread/g, 1, "страница: непрочитанные подгружаются заранее"],
  ["public/chat.html", /voyo_chat_noava/g, 1, "страница: «фото нет» не спрашивается заново"],
  ["public/chat.html", /unreadOffNow/g, 1, "страница: счётчик гаснет сразу при открытии"],
  ["public/chat.html", /rmNow/g, 1, "страница: «непрочитано», 🔔 и 📌 — сразу"],
  ["public/chat.html", /rmApply/g, 1, "страница: старые ответы не откатывают отметки"],
  ["public/chat.html", /rmPend/g, 1, "страница: отметки в ожидании ответа сервера"],
  ["public/chat.html", /читаем ДО rmNow/g, 2, "страница: колокольчик и булавка включаются обратно"],
  ["public/chat.html", /avaForget/g, 1, "страница: новое фото человека видно сразу"],
  ["public/chat.html", /\.side:not\(\.hide\) ~ \.main\{visibility:hidden\}/g, 1, "страница (телефон): закреп и «Вчера/Сегодня» не просвечивают сквозь список"],
  ["public/chat.html", /\?w=160/g, 1, "страница: лёгкие фото людей"],
  ["public/chat.html", /data-gal=/g, 1, "страница: фото листаются стрелками и свайпом"],
  ["public/chat.html", /stickEnd/g, 1, "страница: переписка открывается в самом низу"],
  ["public/chat.html", /avaPend/g, 1, "страница: один запрос на фото человека"],
  ["public/chat.html", /thumbPend/g, 1, "страница: один запрос на картинку"],
  ["public/chat.html", /filePend/g, 1, "страница: один запрос на файл"],
  ["public/chat.html", /tabFit/g, 1, "страница (телефон): высота нижней панели меряется"],
  ["public/chat.html", /--tabh/g, 1, "страница (телефон): список и ✎ не уходят под панель"],
  ["public/chat.html", /meMem/g, 1, "страница: «Дела» и «Уведомления» из памяти"],
  ["public/chat.html", /meCut/g, 1, "страница: память «Дел» после действия не врёт"],
  ["public/chat.html", /meKeep/g, 1, "страница: память «Дел» обновляется"],
  ["public/chat.html", /sysPaint/g, 1, "страница: отрисовка «Дел» одна для памяти и сервера"],
  ["public/chat.html", /class="air"/g, 1, "страница: новый воздушный вид включён (18.11, решение Екатерины)"],
  ["public/chat.html", /body\.air/g, 120, "страница: стили воздушного вида на месте (18.11)"],
  ["public/chat.html", /listDue/g, 1, "страница: при живом канале список опрашивается раз в 15 с (18.11)"],
  ["public/chat.html", /max\(var\(--tabh/g, 3, "страница (айфон): список и ✎ не заходят под нижнюю панель при любом замере (18.11)"],
  ["public/chat.html", /safe-area-inset-bottom,0px\) - 2px/g, 1, "страница (айфон): поле ввода не прижато к «домашней» черте (18.11)"],
  ["public/chat.html", /font-size:16px!important/g, 1, "страница (телефон): нажатие на поле не увеличивает страницу (18.11)"],
  ["public/chat.html", /Парящее поле ввода/g, 1, "страница: парящее поле ввода и кружки инструментов, как в MAX (18.11)"],
  ["public/chat.html", /#go::after/g, 1, "страница: круглая кнопка отправки со стрелкой (18.11)"],
  ["public/chat.html", /send #fmtB,body\.air \.send #fmtU\{display:inline-block\}/g, 1, "страница (телефон): Ж и Ч кружками над полем (18.11)"],
  ["public/chat.html", /send:focus-within\{padding-bottom:12px\}/g, 1, "страница (телефон): при открытой клавиатуре поле прямо над ней, как в MAX (18.11)"],
  ["public/chat-manifest.json", /VOYO · Центр уведомлений/g, 1, "значок чата: просто VOYO, без by VSC (18.11)"]
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
