#!/usr/bin/env node
/* ─────────────────────────────────────────────────────────────────────────────
 * cqInboxResync — досылка сообщений Wazzup в «Качество коммуникации» Кати (16.11.2026).
 *
 * Приём Кати (/api/cq/inbox на work.voyotravel.ru, 127.0.0.1:3002) с 16.11 копит сообщения
 * в памяти и пишет на диск порцией раз в 5 минут — иначе каждое сообщение останавливало
 * портал и чат на секунду. Если служба падает или её перезапускают посреди записи,
 * сообщения последних минут пропадают (так было 16.11 в 11:27 — 30 сообщений).
 *
 * Здесь: берём из архива пакетов Wazzup основного сервера (.wazzupInbox.ndjson — туда
 * попадает КАЖДЫЙ пакет) сообщения за последние 90 минут и отдаём приёмнику Кати ещё раз.
 * Он сам пропускает те, что уже есть (по messageId), и добавляет недостающие. Только
 * сообщения с текстом — остальные приёмник и так не берёт.
 *
 * Запуск: node tools/cqInboxResync.js [--minutes=90] [--dry]   cron: каждые 10 минут.
 * ───────────────────────────────────────────────────────────────────────────── */
"use strict";
const fs = require("fs");
const path = require("path");
const http = require("http");

const ARCHIVE = path.join(__dirname, "..", ".wazzupInbox.ndjson");
const MIN = Number((process.argv.find((a) => a.startsWith("--minutes=")) || "").slice(10)) || 90;
const DRY = process.argv.includes("--dry");
const TAIL = 12 * 1024 * 1024;   // хвост архива: этого с запасом хватает на 90 минут

function tailLines(file, bytes) {
  const st = fs.statSync(file);
  const from = Math.max(0, st.size - bytes);
  const fd = fs.openSync(file, "r");
  const buf = Buffer.alloc(st.size - from);
  fs.readSync(fd, buf, 0, buf.length, from);
  fs.closeSync(fd);
  const lines = buf.toString("utf8").split("\n");
  if (from > 0) lines.shift();   // первая строка обрезана
  return lines.filter(Boolean);
}
function post(body) {
  return new Promise((resolve) => {
    const data = JSON.stringify(body);
    const r = http.request({ host: "127.0.0.1", port: 3002, path: "/api/cq/inbox", method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) }, timeout: 30000 }, (x) => {
      let b = ""; x.on("data", (c) => (b += c));
      x.on("end", () => { try { resolve(JSON.parse(b)); } catch (_) { resolve({ ok: false, error: "ответ не JSON: " + b.slice(0, 80) }); } });
    });
    r.on("error", (e) => resolve({ ok: false, error: e.message }));
    r.on("timeout", () => { r.destroy(); resolve({ ok: false, error: "нет ответа 30 с" }); });
    r.end(data);
  });
}

(async () => {
  const since = new Date(Date.now() - MIN * 60e3).toISOString();
  const msgs = [];
  for (const l of tailLines(ARCHIVE, TAIL)) {
    let j; try { j = JSON.parse(l); } catch (_) { continue; }
    if (!j || !j.t || j.t < since || !j.b) continue;
    for (const m of j.b.messages || []) if (m && m.messageId && m.text) msgs.push(m);
  }
  let saved = 0, sent = 0, bad = 0;
  for (let i = 0; i < msgs.length; i += 200) {
    const part = msgs.slice(i, i + 200);
    if (DRY) { sent += part.length; continue; }
    const r = await post({ messages: part });
    sent += part.length;
    if (r && r.ok) saved += Number(r.saved) || 0; else bad++;
  }
  const line = new Date().toISOString() + " за " + MIN + " мин сообщений с текстом " + msgs.length +
               ", отдано " + sent + ", добавлено недостающих " + saved + (bad ? ", сбоев " + bad : "") + (DRY ? " (пробно)" : "");
  console.log(line);
})().catch((e) => { console.error("cqInboxResync:", e.message); process.exit(1); });
