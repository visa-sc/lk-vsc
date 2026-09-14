// Действия сотрудников в amoCRM по месяцам — из локальной копии CRM (crm.voyotravel.ru),
// без единого запроса в API amoCRM. Считает закрытые задачи, смены этапа сделок и
// исходящие сообщения клиентам по автору события.
//
// Запускается сервером отдельным процессом: better-sqlite3 синхронный, и запрос по
// сотням тысяч событий заблокировал бы основной сервер на несколько секунд.
// База открывается ТОЛЬКО на чтение.
//
//   node tools/orkActivityFromCopy.js <с unix-секунды> <uid,uid,...>
// Печатает JSON: { byUser: { uid: { "7": { tasks, stages, msgs } } }, minTs, maxTs }.
const path = require("path");
const Database = require(path.join(__dirname, "..", "crm-svc", "node_modules", "better-sqlite3"));

const from = parseInt(process.argv[2], 10) || 0;
const uids = String(process.argv[3] || "").split(",").map((x) => parseInt(x, 10)).filter((x) => x > 0);
if (!uids.length) { process.stdout.write(JSON.stringify({ byUser: {} })); process.exit(0); }

const TYPES = { task_completed: "tasks", lead_status_changed: "stages", outgoing_chat_message: "msgs" };
const db = new Database(path.join(__dirname, "..", ".amocopy-db", "crm.db"), { readonly: true, fileMustExist: true });
const range = db.prepare("SELECT MIN(created_at) mn, MAX(created_at) mx FROM amo_events").get();
// Месяц — по московскому времени, нумерация с нуля, как во всём разделе.
const rows = db.prepare(
  "SELECT created_by u, type t, CAST(strftime('%m', created_at, 'unixepoch', '+3 hours') AS INTEGER) - 1 m, " +
  "CAST(strftime('%Y', created_at, 'unixepoch', '+3 hours') AS INTEGER) y, COUNT(*) n FROM amo_events " +
  "WHERE created_at >= ? AND type IN ('task_completed','lead_status_changed','outgoing_chat_message') " +
  "AND created_by IN (" + uids.join(",") + ") GROUP BY u, t, y, m"
).all(from);
db.close();
const byUser = {};
rows.forEach((r) => {
  const um = byUser[r.u] || (byUser[r.u] = {});
  const key = String(r.m);
  const o = um[key] || (um[key] = { tasks: 0, stages: 0, msgs: 0, y: r.y });
  o[TYPES[r.t]] += r.n;
});
process.stdout.write(JSON.stringify({ byUser, minTs: range.mn, maxTs: range.mx }));
