#!/usr/bin/env node
/* ─────────────────────────────────────────────────────────────────────────────
 * modelAudit — ночная проверка сервисов, где 21–22.11.2026 сменились модели Claude (просьба Андрея 22.11).
 * Насовсем, каждую ночь 04:50 МСК. Почти без токенов: журналы + по одному крошечному запросу к каждой модели (< 1 цента в сутки).
 *
 * Что смотрит:
 *   1. Модели отвечают: Haiku 5.5, Sonnet 5.5 (через шлюз), Haiku 4.5 и Sonnet 5 (старые, на них оценки и переводы), Opus 5.5 (радар,
 *      «Помощники», поддержка eSIM — напрямую через ретранслятор). 429/5xx — повтор через 30 с; дальше — «канал», не модель.
 *   2. Шлюз: сколько раз за сутки новая модель давала сбой и запрос уходил на прежнюю (журнал voyo, по смещению).
 *   3. Прослушка Кати: ночная пачка — расшифровки распознаны, а чистка не прошла ни у одной → чистка сломана.
 *   4. Переводы: заказы с ошибкой за сутки. 5. Радар: последний прогон ушёл на запасную модель.
 *   6. «Помощники»: ночной разбор прошёл («проверка: ок» за сегодня). 7. Поддержка eSIM: ошибки в журнале voyo.
 * Чинит сам (без перезапуска): новая модель недоступна (400/404) или сбоит часто (≥10 откатов за сутки) → убирает правила
 *   из /var/www/voyo/.engineModels.json (чистка прослушки и переводы возвращаются на старые модели), пишет Катиному Claude в «Помощники».
 * Письмо при проблеме — Кате Зайцевой (ekaterina.z@visa-sc.ru), Андрею нет. Итог по ночам — в его письме 10.12 (kateModelsAsk report).
 * Журнал: /var/lib/engine-shadow/audit.jsonl. Запуск: node tools/modelAudit.js [--dry]
 * ───────────────────────────────────────────────────────────────────────────── */
"use strict";
const fs = require("fs"), path = require("path"), { execSync } = require("child_process");
require("dotenv").config({ path: path.join(__dirname, "..", ".env"), quiet: true });
const DRY = process.argv.includes("--dry");
const DIR = "/var/lib/engine-shadow", LOG = path.join(DIR, "audit.jsonl"), CUR = path.join(DIR, "audit-cursor.json");
const MF = path.join(__dirname, "..", ".engineModels.json");
const KATE = "ekaterina.z@visa-sc.ru";
const DAY = 864e5, now = Date.now();
const problems = [], fixed = [], ok = [];
const readJ = (f, d) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch (_) { return d; } };
const cur = readJ(CUR, {});

async function ping(model, direct) {
  const gwKey = (fs.readFileSync("/var/www/translate-engine/.env", "utf8").match(/^ANTHROPIC_API_KEY=(.+)$/m) || [])[1];
  const url = direct ? String(process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com").replace(/\/+$/, "") + "/v1/messages"
    : "http://127.0.0.1:" + (process.env.PORT || 3000) + "/internal/anthropic/v1/messages";
  const headers = { "x-api-key": direct ? process.env.ANTHROPIC_API_KEY : String(gwKey || "").trim(), "anthropic-version": "2023-06-01", "content-type": "application/json", "x-voyo-service": "model-audit" };
  const body = JSON.stringify({ model, max_tokens: 64, messages: [{ role: "user", content: "Ответь одним словом: ок" }] });
  for (let i = 0; i < 2; i++) {
    try {
      const r = await fetch(url, { method: "POST", headers, body, signal: AbortSignal.timeout(90000) });
      const j = await r.json().catch(() => ({}));
      if (direct && j.usage) try { require(path.join(__dirname, "..", "ai-usage")).record("model-audit", j.model || model, j.usage); } catch (_) {}
      if (r.ok) return { ok: true, model: j.model };
      if (r.status !== 429 && r.status < 500) return { ok: false, model: true, why: r.status + " " + String((j.error && j.error.message) || "").slice(0, 120) };
      if (i === 0) { await new Promise((s) => setTimeout(s, 30000)); continue; }
      return { ok: false, model: false, why: "канал/перегрузка " + r.status };
    } catch (e) { if (i === 0) { await new Promise((s) => setTimeout(s, 30000)); continue; } return { ok: false, model: false, why: "канал: " + e.message }; }
  }
}
// Новые строки журнала с прошлой ночи (pm2-logrotate мог обнулить файл — тогда с начала)
function newLines(file, key) {
  try {
    const size = fs.statSync(file).size, from = cur[key] != null && cur[key] <= size ? cur[key] : 0;
    cur[key] = size;
    if (size - from > 50 * 1024 * 1024) return [];
    const fd = fs.openSync(file, "r"), buf = Buffer.alloc(size - from); fs.readSync(fd, buf, 0, buf.length, from); fs.closeSync(fd);
    return buf.toString("utf8").split("\n");
  } catch (_) { return []; }
}
function rollbackNew(reason) {
  const o = readJ(MF, {});
  const had = [o.upgrade, (o.upgradeIf || []).length ? "upgradeIf" : ""].filter(Boolean).join(", ");
  if (!had) return false;
  if (DRY) { fixed.push("ОТКАТИЛ БЫ правила шлюза (" + had + "): " + reason); return true; }
  fs.writeFileSync(path.join(DIR, "engineModels.before-audit-rollback.json"), JSON.stringify(o, null, 1));
  o.upgradeOff = { upgrade: o.upgrade, upgradeIf: o.upgradeIf, at: new Date().toISOString(), reason };
  o.upgrade = ""; o.upgradeIf = []; o.at = new Date().toISOString();
  fs.writeFileSync(MF, JSON.stringify(o, null, 1));
  fixed.push("чистка расшифровок прослушки и переводы возвращены на прежние модели (" + reason + ")");
  return true;
}

(async () => {
  // 1. Модели отвечают
  const pings = [["claude-haiku-5-5", false, "Haiku 5.5 (сканеры, чистка расшифровок)"], ["claude-sonnet-5-5", false, "Sonnet 5.5 (сканер, описания картинок)"],
    ["claude-haiku-4-5", false, "Haiku 4.5 (оценки прослушки)"], ["claude-sonnet-5", false, "Sonnet 5 (переводы, сводки)"], ["claude-opus-5-5", true, "Opus 5.5 (радар, «Помощники», поддержка eSIM)"]];
  let newModelDown = "";
  for (const [m, direct, title] of pings) {
    const p = await ping(m, direct);
    if (p.ok) ok.push(title);
    else { problems.push(title + " не отвечает: " + p.why); if (p.model && /5-5/.test(m) && m !== "claude-opus-5-5") newModelDown = title; }
  }
  // 2. Откаты новой модели в шлюзе за сутки
  const errLines = newLines("/root/.pm2/logs/voyo-error.log", "voyoErr");
  const fb = errLines.filter((l) => /engine-proxy: новая модель .* (ответила|обрезала)/.test(l)).length;
  if (fb >= 10) problems.push("шлюз: новая модель за сутки " + fb + " раз давала сбой, запросы уходили на прежнюю");
  else if (fb) ok.push("шлюз: единичных повторов на прежней модели " + fb + " — это нормальная страховка");
  if (newModelDown) rollbackNew(newModelDown + " недоступна");
  else if (fb >= 10) rollbackNew(fb + " сбоев новой модели за сутки");
  // 3. Прослушка: ночная пачка
  try {
    const calls = readJ("/var/www/kateadmin/data/cqCalls.json", []);
    const asr = calls.filter((c) => c && Date.parse(c.asrAt || 0) > now - 1.25 * DAY).length;
    const clean = calls.filter((c) => c && Date.parse(c.cleanAt || 0) > now - 1.25 * DAY).length;
    if (asr >= 5 && clean === 0) problems.push(`прослушка: за сутки распознано ${asr} звонков, а чистка расшифровок не прошла ни у одного`);
    else ok.push(`прослушка: распознано ${asr}, вычищено ${clean}`);
  } catch (e) { problems.push("прослушка: не прочитал данные — " + e.message); }
  // 4. Переводы
  try {
    const o = (readJ("/var/www/translate-engine/.translate/orders.json", {}).orders || []).filter((x) => Number(x.createdAt) > now - DAY);
    const bad = o.filter((x) => x.status === "error" || x.correctStatus === "error");
    if (bad.length) problems.push("переводы: заказов с ошибкой " + bad.length + " из " + o.length + " — " + bad.map((x) => String(x.error || "").slice(0, 80)).join("; "));
    else ok.push("переводы: заказов за сутки " + o.length + ", ошибок нет");
    const ss = readJ(path.join(DIR, "switch-state.json"), {}), tr = ss.tr || {};
    if (tr.rolledBack && tr.rolledBack !== cur.trRolled) { problems.push("переводы: был автооткат на прежнюю модель — " + tr.rolledBack); cur.trRolled = tr.rolledBack; }
  } catch (_) {}
  // 5. Радар: прогон с прошлой проверки ушёл на запасную
  try {
    const runs = readJ(path.join(__dirname, "..", ".aiUsage.json"), []).filter((r) => r.svc === "vsc_radar" && r.in > 10000 && r.ts > (cur.lastAt || now - DAY));
    if (runs.length && runs[runs.length - 1].model !== "claude-opus-5-5") problems.push("радар: прогон ушёл на запасную старую модель (" + runs[runs.length - 1].model + "), идеи есть, но новая модель дала сбой");
    else if (runs.length) ok.push("радар: прогон на Opus 5.5");
  } catch (_) {}
  // 6. «Помощники»
  try {
    const last = execSync("tail -n 1 /var/log/kate-helper.log").toString();
    const msk = new Date(now + 3 * 3600e3).toISOString().slice(0, 10), utcYest = new Date(now - DAY).toISOString().slice(0, 10);
    if (!/проверка: ок/.test(last) || !(last.startsWith(utcYest) || last.startsWith(msk))) problems.push("«Помощники»: ночной разбор не отчитался «ок» — " + last.trim().slice(0, 140));
    else ok.push("«Помощники»: ночной разбор ок");
  } catch (_) {}
  // 7. Поддержка eSIM
  const esimErr = errLines.filter((l) => /esimdoctor|esim doctor|ESIM_DOCTOR/i.test(l) && /error|ошибк|HTTP 4|HTTP 5/i.test(l)).length;
  if (esimErr) problems.push("поддержка eSIM: ошибок модели в журнале " + esimErr); else ok.push("поддержка eSIM: ошибок нет");

  const rec = { at: new Date().toISOString(), problems, fixed, ok };
  console.log(JSON.stringify(rec, null, 1));
  if (DRY) return;
  cur.lastAt = now; fs.writeFileSync(CUR, JSON.stringify(cur)); fs.appendFileSync(LOG, JSON.stringify(rec) + "\n");
  if (fixed.length) {
    const f = "/tmp/modelaudit-" + now + ".txt";
    try { fs.writeFileSync(f, "Катя, от Андрея. Для твоего Claude. Ночная проверка моделей сама вернула старые модели:\n\n- " + fixed.join("\n- ") + "\n\nПричина: " + problems.join("; ") + "\n\nБыло в /var/www/voyo/.engineModels.json — копия в /var/lib/engine-shadow/engineModels.before-audit-rollback.json. В твоём коде ничего не менялось.", { mode: 0o644 });
      execSync("runuser -u kateadmin -- env MENTION=" + KATE + " node " + path.join(__dirname, "helpersRoomSay.js") + " gmvcc6iz9pmsc claude modelaudit-" + new Date().toISOString().slice(0, 10) + " < " + f, { stdio: "inherit" }); }
    catch (e) { console.log("Помощники:", e.message); } finally { try { fs.unlinkSync(f); } catch (_) {} }
  }
  if (problems.length) {
    const esc = (s) => String(s).replace(/</g, "&lt;");
    await require(path.join(__dirname, "..", "mail.js")).sendMail({ to: KATE, subject: "Модели Claude: ночная проверка — " + (fixed.length ? "неполадка, исправлено автоматически" : "неполадка"),
      html: `<div style="font-family:-apple-system,Arial,sans-serif;font-size:14px;line-height:1.5;color:#222"><p>Катя, ночная проверка сервисов на моделях Claude нашла неполадки.</p><ul>${problems.map((p) => "<li>" + esc(p) + "</li>").join("")}</ul>` +
        (fixed.length ? `<p><b>Исправлено автоматически:</b></p><ul>${fixed.map((p) => "<li>" + esc(p) + "</li>").join("")}</ul>` : "<p>Автоматически это не исправляется. Передай своему Claude, подробности — в «Помощниках» и /var/lib/engine-shadow/audit.jsonl.</p>") + `</div>` })
      .catch((e) => console.log("письмо:", e.message));
  }
})().catch((e) => { console.error("modelAudit:", e.message); process.exit(1); });
