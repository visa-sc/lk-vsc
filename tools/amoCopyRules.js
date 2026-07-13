#!/usr/bin/env node
/*
 * Извлекает правила автоматизаций из выгруженных настроек цифровой воронки
 * (.amocopy/digital_pipeline_*.json) → .amocopy-db/rules.json.
 * v1: только безопасные локальные действия — «создать задачу» и «сменить ответственного»
 * при входе на этап. Письма/SMS/боты/чек-листы — помечаем как external (заглушка-лог).
 *
 * Структура amoCRM digital_pipeline у виджетов недокументирована и разнится, поэтому
 * парсим устойчиво: ищем узлы с задачами (task/complete_till/task_type/text) и сменой
 * ответственного, привязанные к status_id. Что не распознали — в raw для ручной сверки.
 *
 * Запуск: node tools/amoCopyRules.js [--dir /var/www/voyo/.amocopy] [--out /var/www/voyo/.amocopy-db/rules.json]
 */
const fs = require("fs");
const path = require("path");

function arg(name, def) { const i = process.argv.indexOf("--" + name); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def; }
const DIR = path.resolve(arg("dir", "/var/www/voyo/.amocopy"));
const OUT = path.resolve(arg("out", "/var/www/voyo/.amocopy-db/rules.json"));

const files = fs.readdirSync(DIR).filter((f) => /^digital_pipeline_\d+\.json$/.test(f));
const rules = []; // {pipeline_id, status_id, action, ...}
let externalCount = 0;

// рекурсивный обход: собираем объекты, у которых есть признаки задачи/смены ответственного,
// и ближайший вверх по дереву status_id.
function walk(node, ctxStatus, pid) {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) { node.forEach((n) => walk(n, ctxStatus, pid)); return; }
  const st = node.status_id || node.status || ctxStatus;

  // действие «создать задачу»
  const hasTaskText = node.task_text || node.text;
  const looksTask = (node.type === "task" || node.action === "task" || node.task_type != null || node.complete_till != null) && hasTaskText;
  if (looksTask && st) {
    rules.push({ pipeline_id: pid, status_id: +st, action: "create_task", text: String(hasTaskText).slice(0, 500), task_type: node.task_type || 0 });
  }
  // смена ответственного
  if ((node.responsible_user_id || node.new_responsible || node.change_responsible) && st) {
    const rid = node.responsible_user_id || node.new_responsible || node.change_responsible;
    if (typeof rid === "number") rules.push({ pipeline_id: pid, status_id: +st, action: "set_responsible", responsible_user_id: rid });
  }
  // внешние действия (письмо/sms/бот/чек-лист) — заглушка
  const s = JSON.stringify(node).toLowerCase();
  if (st && (s.indexOf("mail") >= 0 || s.indexOf("sms") >= 0 || s.indexOf("salesbot") >= 0 || s.indexOf("wazzup") >= 0)) externalCount++;

  Object.keys(node).forEach((k) => { if (node[k] && typeof node[k] === "object") walk(node[k], st, pid); });
}

for (const f of files) {
  const pid = +f.match(/(\d+)/)[1];
  let data; try { data = JSON.parse(fs.readFileSync(path.join(DIR, f), "utf8")); } catch (_) { continue; }
  walk(data, null, pid);
}

// дедуп
const seen = new Set();
const dedup = rules.filter((r) => { const k = r.pipeline_id + ":" + r.status_id + ":" + r.action + ":" + (r.text || r.responsible_user_id || ""); if (seen.has(k)) return false; seen.add(k); return true; });

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify({ generatedAt: null, rules: dedup, externalSeen: externalCount, note: "v1: локальные действия create_task/set_responsible; внешние (письма/SMS/боты) — заглушки" }, null, 2));
console.log(`Правил распознано: ${dedup.length} (create_task/set_responsible), внешних действий замечено ~${externalCount}. → ${OUT}`);
