#!/usr/bin/env node
// Просьба Андрея 19.11.2026: если Катя не отреагировала на сообщение про «Мусор» (mwns7y5ndolq5,
// личка Андрей–Катя), каждый день в 12:00 МСК отвечать на него напоминанием, пока не отреагирует.
// Реакция = любая её реакция на исходное или на напоминание, её ответ цитатой/в ветке, сообщение по делу
// («мусор», «сделк», «распредел», «провер») или короткое «ок/да» сразу после нашего сообщения.
// Запуск ТОЛЬКО от kateadmin (файлы чата её). Печатает ANSWERED, если Катя уже ответила — обёртка снимает cron.
//   --dry  только проверить, ничего не писать.
"use strict";
process.chdir("/var/www/kateadmin");
const C = require("/var/www/kateadmin/notify-chat.js");
C.useCenter({ ownerEmail: () => "ekaterina.z@visa-sc.ru", resolve: () => [] });
const I = C._int;
const ROOM = "dm_director@visa-sc.ru__ekaterina.z@visa-sc.ru", ORIG = "mwns7y5ndolq5", KATE = "ekaterina.z@visa-sc.ru";
const dry = process.argv.includes("--dry");
const now = new Date(), msk = new Date(now.getTime() + 3 * 3600e3), day = msk.toISOString().slice(0, 10);

// Все сообщения переписки с ноября по текущий месяц.
const months = [];
for (let d = new Date(Date.UTC(2026, 10, 1)); d <= now; d.setUTCMonth(d.getUTCMonth() + 1)) months.push(d.toISOString().slice(0, 7));
const all = [].concat(...months.map((mo) => I.loadMonth(ROOM, mo))).sort((a, b) => String(a.at).localeCompare(String(b.at)));
const orig = all.find((m) => m.id === ORIG);
if (!orig) { console.log(day, "исходное сообщение не найдено"); process.exit(1); }
const ours = new Set([ORIG].concat(all.filter((m) => m.nudgeFor === ORIG).map((m) => m.id)));
const reacted = all.some((m) => ours.has(m.id) && Object.values(m.reactions || {}).some((w) => (w || []).includes(KATE)));
let answered = reacted ? "реакция" : "";
if (!answered) {
  let lastOurs = false;
  for (const m of all) {
    if (m.at < orig.at) continue;
    if (ours.has(m.id)) { lastOurs = true; continue; }
    if (m.from !== KATE) { lastOurs = false; continue; }
    const t = String(m.text || "");
    if ((m.reply && ours.has(m.reply.id)) || ours.has(m.thread)) { answered = "ответ цитатой"; break; }
    if (/мусор|сделк|распредел|провер/i.test(t)) { answered = "сообщение по делу"; break; }
    if (lastOurs && t.length <= 60) { answered = "короткий ответ сразу после"; break; }
    lastOurs = false;
  }
}
if (answered) { console.log(day, "ANSWERED:", answered); process.exit(0); }
if (day < "2026-11-20") { console.log(day, "ещё рано"); process.exit(0); }

const n = ours.size;   // 1 = напоминаний ещё не было
const text = n === 1
  ? "Катя, напоминаю про это сообщение: нужно выполнить задачу по проверке «мусорных» сделок и отреагировать здесь, ответом или хотя бы отметкой."
  : "Катя, снова напоминаю: задача по проверке «мусорных» сделок ждёт, ответа на сообщение пока нет. Пожалуйста, отреагируйте здесь.";
if (dry) { console.log(day, "НАПОМНИЛ БЫ (" + n + "):", text); process.exit(0); }
const r = C.postAs(ROOM, { as: "claude", text, key: "kate-musor-nudge-" + day, mentions: [KATE] });
if (r && r.ok && !r.dup) {
  const mo = I.monthOf(r.at), list = I.loadMonth(ROOM, mo), m = list.find((x) => x.id === r.id);
  if (m) { m.reply = { id: orig.id, from: orig.from, text: String(orig.text || "").slice(0, 160) }; m.nudgeFor = ORIG; I.saveMonth(ROOM, mo, list); }
}
console.log(day, "напомнил:", JSON.stringify(r));
