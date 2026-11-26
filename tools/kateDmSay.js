#!/usr/bin/env node
// Сообщение Кате в личную переписку с Андреем в чате work.voyotravel.ru (от имени Андрея, отметка «через Claude»).
// Запускать ТОЛЬКО от kateadmin (файлы чата её):
//   runuser -u kateadmin -- node /var/www/voyo/tools/kateDmSay.js [ключ-от-повтора] < текст
// Печатает одну строку JSON — ответ postAs. С 27.11.2026: обращения в поддержку eSIM до 10.12 (см. esimchat.js).
"use strict";
const fs = require("fs");
process.chdir("/var/www/kateadmin");
const C = require("/var/www/kateadmin/notify-chat.js");
C.useCenter({ ownerEmail: () => "ekaterina.z@visa-sc.ru", resolve: () => [] });
const text = fs.readFileSync(0, "utf8").trim();
if (!text) { console.log(JSON.stringify({ ok: false, error: "пустой текст" })); process.exit(1); }
const r = C.postAs("dm_director@visa-sc.ru__ekaterina.z@visa-sc.ru",
  { from: "director@visa-sc.ru", as: "claude", text, key: process.argv[2] || "", requireHuman: true });
console.log(JSON.stringify(r));
