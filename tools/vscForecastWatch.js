#!/usr/bin/env node
/* ─────────────────────────────────────────────────────────────────────────────
 * vscForecastWatch — ночная проверка прогноза прибыли /vsc (Андрей 23.11.2026: «чтобы я этим больше не занимался»).
 * Каждую ночь 04:25 МСК, насовсем:
 *   1) расчёт цел: /admin/api/vsc-forecast отвечает, итог месяца и недели — конечные числа, есть хотя бы одна
 *      посчитанная неделя, ответ свежий (не сохранённая копия старше суток), в журнале voyo нет «VSC FC» ошибок;
 *   2) журнал точности: для каждой закрытой недели — прогноз выручки/прибыли против факта
 *      (/var/lib/vsc-forecast/accuracy.jsonl, одна строка на неделю, без повторов).
 * Письмо Андрею — ТОЛЬКО если расчёт сломан. При поломке /vsc сам показывает последний удачный расчёт
 * (.vscForecastLastGood.json), так что пустого блока не будет. Запуск: node tools/vscForecastWatch.js [--dry]
 * ───────────────────────────────────────────────────────────────────────────── */
"use strict";
const fs = require("fs"), path = require("path"), { execSync } = require("child_process");
require("dotenv").config({ path: path.join(__dirname, "..", ".env"), quiet: true });
const DRY = process.argv.includes("--dry");
const DIR = "/var/lib/vsc-forecast", ACC = path.join(DIR, "accuracy.jsonl"), CUR = path.join(DIR, "cursor.json");
const ROOT = path.join(__dirname, "..");
(async () => {
  const problems = [];
  let f = null;
  try {
    const s = JSON.parse(fs.readFileSync(path.join(ROOT, ".lkAdminSessions.json"), "utf8")).filter(([t, e]) => e > Date.now() + 3600e3).sort((x, y) => y[1] - x[1]);
    if (!s.length) throw new Error("нет действующей служебной сессии для запроса");
    const r = await fetch("http://127.0.0.1:" + (process.env.PORT || 3000) + "/admin/api/vsc-forecast", { headers: { authorization: "Bearer " + s[0][0] }, signal: AbortSignal.timeout(180000) });
    if (!r.ok) throw new Error("ответ " + r.status);
    f = await r.json();
  } catch (e) { problems.push("прогноз не отвечает: " + e.message); }
  if (f) {
    const m = f.month || {};
    if (!isFinite(+m.revenue) || !isFinite(+m.profitMonth) || !(+m.revenue > 0)) problems.push("итог месяца не посчитан (выручка " + m.revenue + ", прибыль " + m.profitMonth + ")");
    const built = (f.weeks || []).filter((w) => !w.pending);
    if (!built.length) problems.push("ни одной посчитанной недели");
    const bad = built.filter((w) => !isFinite(+w.periodProfit) || !isFinite(+w.periodRevenue));
    if (bad.length) problems.push("недели с битыми числами: " + bad.map((w) => w.label).join(", "));
    if (f.savedAt && Date.now() - Date.parse(f.savedAt) > 26 * 3600e3) problems.push("показывается сохранённая копия от " + f.savedAt + " — свежий расчёт не проходит");
  }
  try {
    const cur = (() => { try { return JSON.parse(fs.readFileSync(CUR, "utf8")); } catch (_) { return {}; } })();
    const log = "/root/.pm2/logs/voyo-error.log", size = fs.statSync(log).size, from = cur.err != null && cur.err <= size ? cur.err : Math.max(0, size - 2e6);
    const fd = fs.openSync(log, "r"), buf = Buffer.alloc(size - from); fs.readSync(fd, buf, 0, buf.length, from); fs.closeSync(fd);
    const lines = buf.toString("utf8").split("\n").filter((l) => /VSC FC/.test(l));
    if (lines.length) problems.push("ошибки расчёта в журнале: " + lines.length + " (" + lines[lines.length - 1].slice(0, 160) + ")");
    if (!DRY) { fs.mkdirSync(DIR, { recursive: true }); fs.writeFileSync(CUR, JSON.stringify({ err: size })); }
  } catch (_) {}
  // журнал точности
  if (f && !DRY) {
    fs.mkdirSync(DIR, { recursive: true });
    const seen = new Set(); try { fs.readFileSync(ACC, "utf8").split("\n").filter(Boolean).forEach((l) => seen.add(JSON.parse(l).week)); } catch (_) {}
    for (const w of (f.weeks || []).filter((x) => x.kind === "fact" && x.fc)) {
      const id = (f.monthName || "") + " " + w.label; if (seen.has(id)) continue;
      fs.appendFileSync(ACC, JSON.stringify({ week: id, at: new Date().toISOString(), basis: w.basis, revenueFact: Math.round(w.periodRevenue), revenueFc: Math.round(w.fc.periodRevenue), profitFact: Math.round(w.periodProfit), profitFc: Math.round(w.fc.periodProfit), revErrPct: Math.round((w.fc.periodRevenue / w.periodRevenue - 1) * 1000) / 10 }) + "\n");
    }
  }
  console.log(new Date().toISOString(), problems.length ? "ПРОБЛЕМЫ: " + problems.join("; ") : "ok");
  if (problems.length && !DRY) {
    await require(path.join(ROOT, "mail.js")).sendMail({ to: "director@visa-sc.ru", subject: "/vsc: прогноз прибыли — сбой расчёта",
      html: "<p><b>Ночная проверка прогноза /vsc нашла сбой.</b> На странице пока показан последний удачный расчёт.</p><ul>" + problems.map((p) => "<li>" + String(p).replace(/</g, "&lt;") + "</li>").join("") + "</ul>" }).catch((e) => console.log("письмо:", e.message));
  }
})().catch((e) => { console.error("vscForecastWatch:", e.message); process.exit(1); });
