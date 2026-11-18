#!/usr/bin/env node
/* ─────────────────────────────────────────────────────────────────────────────
 * kateDesignAsk — разовое предложение Кате по дизайну чата (17.11.2026, просьба Андрея).
 *
 * В «Помощниках» висит сообщение с двумя плашками-реакциями «✅ Делаем» и «❌ Нет»
 * (выложено скриптом от kateadmin, в чате Кати ничего не менялось — это её обычные
 * реакции). Сторож раз в 5 минут смотрит, что нажала САМА Катя (нажатия других людей
 * не считаются), и:
 *   • «Делаем» — пишет в «Помощники» «принято» и письмо Андрею с готовым заданием для Claude
 *     (Андрей делает скрин письма и сам запускает работу — сторож ничего не переделывает);
 *   • «Нет» — пишет «принято, ничего не меняем» и письмо Андрею;
 *   • ответ словами на это сообщение (от Кати или её Claude) — пересылает Андрею письмом;
 *   • нет ответа сутки — один раз напоминает Кате в личке (будни, 10–19 МСК).
 * После решения ничего не делает (state.decided), после 31.12.2026 тоже.
 * Только читает файлы чата; пишет в чат через claude-say.js от kateadmin.
 * Запуск: node tools/kateDesignAsk.js [--dry]   cron: каждые 5 минут.
 * ───────────────────────────────────────────────────────────────────────────── */
"use strict";
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
require("dotenv").config({ path: path.join(__dirname, "..", ".env"), quiet: true });

const DRY = process.argv.includes("--dry");
const K = process.env.KDA_ROOT || "/var/www/kateadmin/";   // KDA_ROOT/KDA_STATE — только для проверки
const STATE = process.env.KDA_STATE || "/var/lib/kate-design-ask.json";
const ROOM = "gmvcc6iz9pmsc";                                   // «Помощники»
const DM = "dm_director@visa-sc.ru__ekaterina.z@visa-sc.ru";
const KATE = "ekaterina.z@visa-sc.ru";
const YES = "✅ Делаем", NO = "❌ Нет";
const UNTIL = Date.parse("2026-12-31T21:00:00Z");
// Задание для Claude — в письме Андрею при согласии Кати (решение Андрея 17.11: «сам всё сделаю —
// сделаю скрин письма и закину в Claude»). Сам сторож ничего не переделывает.
const TASK_HTML =
  "<hr><p><b>Задание для Claude (сделайте скрин этого блока и отправьте в Claude):</b></p>" +
  "<p>Claude, Катя согласилась на новый дизайн чата (предложение в «Помощниках», сообщение mwkcihphnl03m). Сделай:</p><ol>" +
  "<li><b>Дизайн</b> чата и Центра уведомлений work.voyotravel.ru (/var/www/kateadmin/public/chat.html): лёгкий, воздушный, в стиле Apple, " +
  "как наш клиентский личный кабинет (скины lk-skin, память lk-skin-design.md). Прям сексуальный, вылизанный, аппетитный — сильно красивее, " +
  "чем сейчас. Компьютер и телефон, светлая и тёмная тема.</li>" +
  "<li><b>Убрать «by VSC» везде</b> на площадке Кати — просто VOYO: «VOYO · Центр уведомлений», «VOYO · Чат», заголовки всех её страниц, " +
  "chat-manifest.json, знак в шапках.</li>" +
  "<li><b>Ничего не сломать</b>: функционал, вёрстка, скорость — как были. Меняется только вид. Правки — от kateadmin, с копиями, " +
  "сначала стенд (tools/katechat-stand.js), свежую версию файлов забрать с сервера.</li>" +
  "<li><b>После — полный аудит</b>, чтобы ничего не съехало: телефон и компьютер, обе темы, все экраны (список и папки, поиск, переписка, " +
  "ответы и реакции, закреп, «вниз» и открытие в самом низу, поле ввода, ветки, «Дела» и «Уведомления» с кнопками, настройки, фото и листание, " +
  "файлы, кнопки строк на телефоне, нижняя панель), ошибки страницы, скорость переключения, сторож правок — все метки на месте.</li>" +
  "<li><b>Чтобы не затёрли</b>: раздел в ПРАВКИ-АНДРЕЯ.md, метка в сторож kateSpeedGuard, написать в «Помощники» Claude Кати, " +
  "чтобы сохранил правки; Кате в личку коротко, что новый вид готов.</li>" +
  "<li>Мне — короткое письмо, что сделано. Строку cron kateDesignAsk после этого убрать.</li></ol>";

function readState() { try { return JSON.parse(fs.readFileSync(STATE, "utf8")); } catch (_) { return null; } }
function saveState(st) { if (!DRY) fs.writeFileSync(STATE, JSON.stringify(st, null, 1)); }
function monthList(room) {
  const dir = path.join(K, "data/notify/chat", room);
  let out = [];
  for (const n of fs.readdirSync(dir).filter((x) => /^\d{4}-\d{2}\.json$/.test(x)).sort().slice(-2)) {
    try { out = out.concat(JSON.parse(fs.readFileSync(path.join(dir, n), "utf8")).list || []); } catch (_) {}
  }
  return out;
}
function say(text, room, key) {
  if (DRY) { console.log("[dry] в " + room + ":", text); return; }
  const tmp = "/tmp/kate-design-ask-" + process.pid + ".txt";
  try {
    fs.writeFileSync(tmp, text, { mode: 0o644 });
    execSync("runuser -u kateadmin -- node " + K + "claude-say.js " + tmp + " " + room + " " + key,
             { timeout: 30000, stdio: "ignore" });
  } catch (e) { console.log("чат: не отправлено —", e.message); }
  try { fs.unlinkSync(tmp); } catch (_) {}
}
async function mail(subject, html) {
  if (DRY) { console.log("[dry] письмо:", subject); return; }
  try { await require(path.join(__dirname, "..", "mail.js")).sendMail({ to: "director@visa-sc.ru", subject, html }); }
  catch (e) { console.log("письмо не ушло:", e.message); }
}
const esc = (s) => String(s || "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
function mskNow() { const d = new Date(Date.now() + 3 * 3600e3); return { h: d.getUTCHours(), wd: d.getUTCDay() }; }

(async () => {
  const st = readState();
  if (!st || !(st.msgId || st.asks) || st.decided || Date.now() > UNTIL) return;
  // С 18.11 предложение висит в нескольких местах (повтор в «Помощниках» и ответом Кате в личке) —
  // кнопка считается, где бы она ни нажала.
  const asks = st.asks || [{ room: ROOM, id: st.msgId }];
  const ids = asks.map((a) => a.id);
  const list = monthList(ROOM);
  let dmList = []; try { dmList = monthList(DM); } catch (_) {}
  let yes = false, no = false, found = 0;
  for (const a of asks) {
    const m = (a.room === DM ? dmList : list).find((x) => x.id === a.id);
    if (!m || m.deletedAt) continue;
    found++;
    const rx = m.reactions || {};
    if ((rx[YES] || []).indexOf(KATE) >= 0) yes = true;
    if ((rx[NO] || []).indexOf(KATE) >= 0) no = true;
  }
  if (!found) { console.log(new Date().toISOString() + " сообщения не найдены"); return; }

  // Ответы словами: цитата этого сообщения, ветка под ним или (с 17.11, Кате в ЛС сказано «нажмите
  // кнопку или напишите ответ») любое её сообщение про дизайн после предложения — в «Помощниках» или в ЛС.
  st.fwd = st.fwd || [];
  const ABOUT = /дизайн|by\s*vsc|оформлен|делаем|отклон|не надо|согласн/i;
  const fromKate = (m) => m.from === KATE || m.from === "robot:claude-kate";
  const isWord = (m, inAsk) => !m.deleted && st.fwd.indexOf(m.id) < 0 && fromKate(m) && m.at > st.postedAt &&
    ((m.reply && ids.indexOf(m.reply.id) >= 0) || ids.indexOf(m.thread) >= 0 || ABOUT.test(m.text || ""));
  const words = list.filter((m) => isWord(m, true)).map((m) => ({ m, where: "в «Помощниках»" }))
    .concat(dmList.filter((m) => isWord(m, false)).map((m) => ({ m, where: "в личке" })));
  for (const { m, where } of words) {
    await mail("Катя ответила на предложение по дизайну чата",
      "<p><b>" + (m.from === KATE ? "Екатерина" : "Claude Кати") + "</b> " + where + ":</p><blockquote>" +
      esc(m.text).replace(/\n/g, "<br>") + "</blockquote><p>Кнопку " +
      (yes ? "«Делаем» нажала" : no ? "«Нет» нажала" : "пока не нажимала") + ".</p>" +
      "<p>Если это согласие — задание ниже.</p>" + TASK_HTML);
    st.fwd.push(m.id);
  }

  if (yes !== no) {                                   // нажата ровно одна
    st.decided = yes ? "yes" : "no";
    st.decidedAt = new Date().toISOString();
    if (yes) {
      say("Екатерина, спасибо! Принято: делаем. Помощник Андрея возьмётся за новый вид чата, проверит, что всё " +
          "работает как прежде, и напишет здесь, что поменялось. Если что-то не понравится — вернём прежний вид.",
          ROOM, "design-ask-yes");
      await mail("Катя: дизайн чата — ДЕЛАЕМ",
        "<p>Екатерина нажала «Делаем» под предложением по дизайну чата и убиранию «by VSC».</p>" +
        "<p>Claude начнёт сам в ближайшие полчаса (задача «Дизайн чата Кати» в приложении на маке, нужен включённый мак): " +
        "редизайн, затем полный аудит, выкладка и письмо вам. Если мак выключен — сделайте скрин блока ниже и отправьте в Claude.</p>" +
        TASK_HTML);
    } else {
      say("Екатерина, принято: ничего не меняем. Спасибо, что посмотрели!", ROOM, "design-ask-no");
      await mail("Катя: дизайн чата — отклонила",
        "<p>Екатерина нажала «Нет» под предложением по дизайну чата. Ничего не трогаем.</p>");
    }
  } else if (!yes && !st.nudgedAt && !words.length && !st.fwd.length &&
             Date.now() - Date.parse(st.postedAt) > 24 * 3600e3) {
    const t = mskNow();
    if (t.wd >= 1 && t.wd <= 5 && t.h >= 10 && t.h < 19) {
      say("Екатерина, посмотрите, пожалуйста, в «Помощниках» предложение по дизайну чата. Это не обязательно, " +
          "просто предложение: можно согласиться или отклонить одной кнопкой под сообщением.", DM, "design-ask-nudge");
      st.nudgedAt = new Date().toISOString();
    }
  }
  console.log(new Date().toISOString() + " делаем:" + yes + " нет:" + no + (st.decided ? " → " + st.decided : ""));
  saveState(st);
})();
