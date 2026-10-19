#!/usr/bin/env node
// Архив Wazzup (всё, что Wazzup присылал вебхуком с 18.08.2026) только на чтение для
// /data-api/wazzup/* (dataro.js). Отдельный процесс с таймаутом: файл большой (сотни МБ),
// сайт не должен ждать. Вход — переменные окружения, выход — JSON.
//   RO_MODE=channels                — каналы: тип, сообщений, первое/последнее
//   RO_MODE=messages|statuses       — события за период RO_FROM..RO_TO (ГГГГ-ММ-ДД, МСК, ≤ 31 дня)
//     фильтры: RO_CHAT (chatId), RO_CHANNEL (channelId), RO_TYPE (chatType: whatsapp,
//     telegram, max, vk, instagram…), RO_Q (подстрока текста), RO_DIR (in|out), RO_LIMIT.
"use strict";
const fs = require("fs");
const readline = require("readline");
const FILE = process.env.WAZZUP_INBOX || "/var/www/voyo/.wazzupInbox.ndjson";
// Выход только после того, как весь ответ ушёл в канал: при большом ответе
// process.exit сразу после write обрезал бы JSON.
let _done = false;
const out = (o) => { if (_done) return; _done = true; process.stdout.write(JSON.stringify(o), () => process.exit(0)); };
const bad = (msg) => { out({ ok: false, error: msg }); return true; };
const mode = String(process.env.RO_MODE || "messages");
const day = (s) => /^\d{4}-\d\d-\d\d$/.test(String(s || "")) ? String(s) : null;
const from = day(process.env.RO_FROM), to = day(process.env.RO_TO) || from;
const limit = Math.max(1, Math.min(Number(process.env.RO_LIMIT) || 5000, 50000));
const chat = String(process.env.RO_CHAT || ""), channel = String(process.env.RO_CHANNEL || ""), ctype = String(process.env.RO_TYPE || "");
const q = String(process.env.RO_Q || "").toLowerCase(), dir = String(process.env.RO_DIR || "");
// время события в МСК для фильтра по дням: dateTime сообщения / timestamp статуса, иначе время приёма
const mskDay = (iso) => { const t = Date.parse(iso); return isNaN(t) ? "" : new Date(t + 3 * 3600e3).toISOString().slice(0, 10); };

const stop = mode !== "channels" && (
  (!from && bad("Нужно from=ГГГГ-ММ-ДД (и to=…), время московское")) ||
  ((to < from || (Date.parse(to) - Date.parse(from)) > 31 * 86400e3) && bad("Период не больше 31 дня")));
// грубый отбор по времени приёма (t в начале строки) — чтобы не разбирать весь файл
const lo = from ? new Date(Date.parse(from + "T00:00:00+03:00") - 2 * 86400e3).toISOString() : "";
const hi = to ? new Date(Date.parse(to + "T23:59:59+03:00") + 2 * 86400e3).toISOString() : "";

if (!stop) run();
function run() {
const items = [], chans = {};
let more = false;
const rl = readline.createInterface({ input: fs.createReadStream(FILE), crlfDelay: Infinity });
rl.on("line", (line) => {
  if (more) return;
  const t = line.slice(6, 30);                       // {"t":"2026-10-19T13:23:10.350Z",…
  if (mode !== "channels" && (t < lo || t > hi)) return;
  let j; try { j = JSON.parse(line); } catch (_) { return; }
  const b = j.b || {};
  if (mode === "channels") {
    for (const m of b.messages || []) {
      const k = (m.channelId || "?") + "|" + (m.chatType || "?");
      const c = chans[k] || (chans[k] = { channelId: m.channelId, chatType: m.chatType, messages: 0, inbound: 0, outbound: 0, chats: new Set(), first: m.dateTime, last: m.dateTime });
      c.messages++; if (m.isEcho) c.outbound++; else c.inbound++;
      c.chats.add(m.chatId); if (m.dateTime < c.first) c.first = m.dateTime; if (m.dateTime > c.last) c.last = m.dateTime;
    }
    return;
  }
  const list = mode === "statuses" ? (b.statuses || []) : (b.messages || []);
  for (const m of list) {
    const d = mskDay(m.dateTime || m.timestamp || j.t);
    if (d < from || d > to) continue;
    if (mode === "messages") {
      if (chat && String(m.chatId) !== chat) continue;
      if (channel && m.channelId !== channel) continue;
      if (ctype && m.chatType !== ctype) continue;
      if (dir === "in" && m.isEcho) continue;
      if (dir === "out" && !m.isEcho) continue;
      if (q && String(m.text || "").toLowerCase().indexOf(q) < 0) continue;
    }
    if (items.length >= limit) { more = true; rl.close(); return; }
    items.push(Object.assign({ receivedAt: j.t }, m));
  }
});
rl.on("close", () => {
  if (mode === "channels") {
    out({ ok: true, note: "isEcho=true — исходящее (написал сотрудник), false — входящее от клиента", channels: Object.values(chans).map((c) => Object.assign({}, c, { chats: c.chats.size })).sort((a, b) => b.messages - a.messages) });
  }
  out({ ok: true, from, to, count: items.length, truncated: more, items });
});
rl.on("error", (e) => out({ ok: false, error: e.message }));
}
