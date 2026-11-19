#!/usr/bin/env node
// Ночное чтение комнаты «Помощники Андрей-Андрей» (19.11.2026, просьба Андрея): раз в сутки собираем всё,
// что за сутки написали Андрей Петров и его помощник, в /var/www/voyo/ПРАВКИ-ПЕТРОВА.md — этот файл читает
// Claude Андрея перед правками сайтов, eSIM и всего, что трогает Петров, чтобы не откатить его работу.
// Если было что прочитать — короткое «прочитал» в комнату от Помощника Андрея. Писем нет.
// cron: 40 1 * * *   (после ночной настройки его Claude, до ночных снимков). --dry — без записи.
"use strict";
const fs = require("fs"), path = require("path"), { spawnSync } = require("child_process");
require("dotenv").config({ path: path.join(__dirname, "..", ".env"), quiet: true });
const { messages } = require(path.join(__dirname, "..", "helpersroom.js"));
const DRY = process.argv.includes("--dry");
const STATE_DIR = "/var/lib/helpers-room", STATE = path.join(STATE_DIR, "state.json");
const LOG = path.join(__dirname, "..", "ПРАВКИ-ПЕТРОВА.md");
const ROOM = process.env.HELPERS_PETROV_ROOM || "mwnfd15c4znxl";
const msk = (iso) => new Date(Date.parse(iso) + 3 * 3600e3).toISOString().slice(0, 16).replace("T", " ");

const st = (() => { try { return JSON.parse(fs.readFileSync(STATE, "utf8")); } catch (_) { return {}; } })();
const since = st.since || new Date(Date.now() - 24 * 3600e3).toISOString();
const all = messages(since, 1000);
const theirs = all.filter((m) => m.from === "ap@spt1.ru" || m.from === "robot:claude-petrov");
const last = all.length ? all[all.length - 1].at : since;
console.log(new Date().toISOString(), "новых сообщений", all.length, "от стороны Петрова", theirs.length);
if (theirs.length && !DRY) {
  if (!fs.existsSync(LOG)) fs.writeFileSync(LOG, "# Правки и просьбы Андрея Петрова и его помощника\n\nСобирается каждую ночь из комнаты «Помощники Андрей-Андрей» (tools/helpersRoomNight.js). Перед правками сайтов visa-sc.ru/spb/ekb, eSIM и поддержки — прочитать свежие записи.\n");
  let s = `\n## Ночь на ${msk(new Date().toISOString()).slice(0, 10)}\n`;
  for (const m of theirs) s += `- ${msk(m.at)} · ${m.name}: ${String(m.text).replace(/\s+/g, " ").slice(0, 1500)}${m.files.length ? " [файлы: " + m.files.map((f) => f.name).join(", ") + "]" : ""}\n`;
  fs.appendFileSync(LOG, s);
  const txt = `Прочитал за сутки: ${theirs.length} ${theirs.length === 1 ? "сообщение" : theirs.length < 5 ? "сообщения" : "сообщений"} от Андрея Петрова и его помощника. Учтём при наших правках; если там просьба к нам — Андрей увидит её здесь.`;
  const r = spawnSync("runuser", ["-u", "kateadmin", "--", "node", path.join(__dirname, "helpersRoomSay.js"), ROOM, "claude", "night-" + last], { input: txt, encoding: "utf8" });
  console.log("ответ в комнату:", String(r.stdout || r.stderr || "").trim().slice(0, 160));
}
if (!DRY) { fs.mkdirSync(STATE_DIR, { recursive: true }); fs.writeFileSync(STATE, JSON.stringify({ since: last, at: new Date().toISOString() })); }
