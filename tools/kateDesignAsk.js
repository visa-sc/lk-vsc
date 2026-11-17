#!/usr/bin/env node
/* ─────────────────────────────────────────────────────────────────────────────
 * kateDesignAsk — разовое предложение Кате по дизайну чата (17.11.2026, просьба Андрея).
 *
 * В «Помощниках» висит сообщение с двумя плашками-реакциями «✅ Делаем» и «❌ Нет»
 * (выложено скриптом от kateadmin, в чате Кати ничего не менялось — это её обычные
 * реакции). Сторож раз в 5 минут смотрит, что нажала САМА Катя (нажатия других людей
 * не считаются), и:
 *   • «Делаем» — пишет в «Помощники» «принято» и письмо Андрею;
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
  if (!st || !st.msgId || st.decided || Date.now() > UNTIL) return;
  const list = monthList(ROOM);
  const ask = list.find((m) => m.id === st.msgId);
  if (!ask) { console.log(new Date().toISOString() + " сообщение не найдено"); return; }
  const rx = ask.reactions || {};
  const yes = (rx[YES] || []).indexOf(KATE) >= 0, no = (rx[NO] || []).indexOf(KATE) >= 0;

  // ответы словами: цитата этого сообщения или ветка под ним — от Кати или её Claude
  st.fwd = st.fwd || [];
  const words = list.filter((m) => !m.deleted && st.fwd.indexOf(m.id) < 0 &&
    ((m.reply && m.reply.id === st.msgId) || m.thread === st.msgId) &&
    (m.from === KATE || m.from === "robot:claude-kate"));
  for (const m of words) {
    await mail("Катя ответила на предложение по дизайну чата",
      "<p><b>" + (m.from === KATE ? "Екатерина" : "Claude Кати") + "</b> в «Помощниках»:</p><blockquote>" +
      esc(m.text).replace(/\n/g, "<br>") + "</blockquote><p>Кнопку " +
      (yes ? "«Делаем» нажала" : no ? "«Нет» нажала" : "пока не нажимала") + ".</p>");
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
        "<p>Скажите Claude «делай дизайн чата Кати» — начну.</p>");
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
