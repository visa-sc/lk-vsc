#!/usr/bin/env node
// SQL только на чтение по копии amoCRM для /data-api/crm/* (dataro.js).
// Запускается ОТДЕЛЬНЫМ процессом с таймаутом: тяжёлый запрос не трогает сайт.
// Вход: RO_SQL (текст запроса или "__schema__"), RO_LIMIT (строк). Выход: JSON.
// Разрешены только SELECT / WITH / EXPLAIN, одним запросом; база открыта readonly
// и с PRAGMA query_only — записать в неё нельзя даже через хитрый запрос.
"use strict";
const DB = process.env.AMOCOPY_DB || "/var/www/voyo/.amocopy-db/crm.db";
const SQLITE = process.env.SQLITE_MODULE || "/var/www/voyo/crm-svc/node_modules/better-sqlite3";
const out = (o) => { process.stdout.write(JSON.stringify(o)); process.exit(0); };
try {
  const Database = require(SQLITE);
  const db = new Database(DB, { readonly: true, fileMustExist: true });
  db.pragma("query_only = 1");
  db.pragma("busy_timeout = 5000");
  const q = String(process.env.RO_SQL || "").trim().replace(/;\s*$/, "");
  if (q === "__schema__") {
    const tables = db.prepare("SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()
      .map((t) => ({ table: t.name, rows: db.prepare("SELECT count(*) n FROM \"" + t.name + "\"").get().n, columns: db.prepare("PRAGMA table_info(\"" + t.name + "\")").all().map((c) => c.name + " " + c.type) }));
    out({ ok: true, note: "Время в колонках *_at — unix-секунды. cf — JSON доп. полей amo, tags — JSON тегов. Копия догоняет amoCRM синхронизацией (несколько минут).", tables });
  }
  if (!/^(select|with|explain)\b/i.test(q)) out({ ok: false, error: "Только SELECT / WITH / EXPLAIN" });
  if (/;\s*\S/.test(q)) out({ ok: false, error: "Один запрос за раз" });
  const limit = Math.max(1, Math.min(Number(process.env.RO_LIMIT) || 5000, 50000));
  const st = db.prepare(q);
  if (!st.reader) out({ ok: false, error: "Запрос не возвращает строк" });
  const rows = [];
  let more = false;
  for (const r of st.iterate()) { if (rows.length >= limit) { more = true; break; } rows.push(r); }
  out({ ok: true, count: rows.length, truncated: more, rows });
} catch (e) {
  out({ ok: false, error: String(e && e.message || e).slice(0, 500) });
}
