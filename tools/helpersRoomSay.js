#!/usr/bin/env node
// Написать в комнату помощников чата work.voyotravel.ru. Запускать ТОЛЬКО от kateadmin (файлы чата её):
//   runuser -u kateadmin -- node /var/www/voyo/tools/helpersRoomSay.js <комната> <as> [ключ-от-повтора] [файл-вложение] < текст
// as: claude (Помощник Андрея) | claude-petrov (Помощник Петрова). Вложение (необязательно) кладётся в
// хранилище файлов чата и прописывается в комнате — его видят участники и /data-api/room/file.
// Печатает одну строку JSON — ответ postAs (+ file).
"use strict";
const fs = require("fs"), path = require("path");
const [room, as, key, attach] = process.argv.slice(2);
if (!room || !/^(claude|claude-petrov)$/.test(as || "")) { console.log(JSON.stringify({ ok: false, error: "нужны комната и as" })); process.exit(1); }
process.chdir("/var/www/kateadmin");
const C = require("/var/www/kateadmin/notify-chat.js");
C.useCenter({ ownerEmail: "director@visa-sc.ru", resolve: () => [] });
const I = C._int;
const text = fs.readFileSync(0, "utf8").trim();
// MENTION=почта[,почта] в окружении — упомянуть (пуш человеку), напр. первое сообщение Петрову.
const mentions = String(process.env.MENTION || "").split(",").map((x) => x.trim()).filter(Boolean);
const r = C.postAs(room, { as, text, key: key || "", mentions });
if (r && r.ok && !r.dup && attach) {
  try {
    const buf = fs.readFileSync(attach);
    const id = I.newId(), ext = path.extname(attach).toLowerCase(), mo = I.monthOf(r.at);
    const dir = path.join(I.FILES(), mo); I.mkdir(dir);
    fs.writeFileSync(path.join(dir, id + ext), buf);
    const name = path.basename(attach);
    I.writeJson(path.join(dir, id + ".json"), { id, name, ext, size: buf.length, room, by: "robot:" + as, at: r.at });
    const list = I.loadMonth(room, mo);
    const m = list.find((x) => x.id === r.id);
    if (m) { m.files = [{ id, name, size: buf.length }]; I.saveMonth(room, mo, list); r.file = id; }
  } catch (e) { r.fileError = e.message; }
}
console.log(JSON.stringify(r));
