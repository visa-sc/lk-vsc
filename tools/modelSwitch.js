#!/usr/bin/env node
/* ─────────────────────────────────────────────────────────────────────────────
 * modelSwitch — перевод прослушки и переводов на новые модели после сравнения на живых запросах (Андрей 21.11.2026).
 *
 * Шлюз (engine-proxy.js, ENGINE_SHADOW) отдаёт клиенту ответ старой модели, а тот же запрос в фоне шлёт новой и
 * пишет оба ответа в /var/lib/engine-shadow/<сервис>.jsonl. Здесь сравниваем:
 *   cq (прослушка Кати, Haiku 4.5 → 5.5): JSON оценок — совпадение отметок по каждому критерию и сотруднику;
 *   translate (переводы, Sonnet 5 → 5.5): ответ без ошибок, не обрезан, длина и текст близки к старому.
 * Если качество держится — дописываем сервис в ENGINE_MODEL_UPGRADE (.env основного приложения, копия .env рядом),
 * снимаем его из ENGINE_SHADOW и перезапускаем voyo (после проверки, что нет выдачи eSIM). Не держится или мало данных —
 * ничего не меняем. Одно письмо Андрею за прогон, только если что-то решено.
 * Каждый день в 09:05, пока по обоим сервисам нет решения: мало данных — ждём следующего дня; решение принято (переведено
 * или оставлена старая) — сервис больше не трогаем (state.json рядом с журналами). Когда решены оба — строка cron снимает себя.
 * Если за 21 день данных так и не набралось — одно письмо Андрею.
 * Запуск: node tools/modelSwitch.js [--dry]
 * ───────────────────────────────────────────────────────────────────────────── */
"use strict";
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
require("dotenv").config({ path: path.join(__dirname, "..", ".env"), quiet: true });
const DRY = process.argv.includes("--dry");
const ENV = path.join(__dirname, "..", ".env");
const DIR = process.env.MODEL_SHADOW_DIR || "/var/lib/engine-shadow";   // MODEL_SHADOW_DIR — только для проверки
const RULES = {
  cq: { title: "Прослушка звонков (Катя)", from: "claude-haiku-4-5", to: "claude-haiku-5-5", min: 25, upgrade: "cq:claude-haiku-4-5=claude-haiku-5-5" },
  translate: { title: "Переводы документов", from: "claude-sonnet-5", to: "claude-sonnet-5-5", min: 5, upgrade: "translate:claude-sonnet-5=claude-sonnet-5-5,translate:claude-haiku-4-5=claude-haiku-5-5" }
};
const rows = (svc) => { try { return fs.readFileSync(path.join(DIR, svc + ".jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch (_) { return []; } };
function json(t) {
  const s = String(t || "").replace(/```json|```/g, "");
  const a = s.indexOf("{"), b = s.lastIndexOf("}");
  if (a < 0 || b < a) return null;
  try { return JSON.parse(s.slice(a, b + 1)); } catch (_) { return null; }
}
function marks(o) {
  const m = {};
  for (const p of (o && o.people) || []) for (const [k, v] of Object.entries((p && p.scores) || {})) m[(p.employee || "") + "|" + k] = v && v.mark;
  return m;
}
const words = (t) => new Set(String(t || "").toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) || []);
function evalCq(list) {
  let validB = 0, validA = 0, same = 0, total = 0, errs = 0;
  for (const r of list) {
    if (r.b.error || r.b.status !== 200) { errs++; continue; }
    const A = json(r.a.text), B = json(r.b.text);
    if (A) validA++;
    if (B) validB++;
    if (!A || !B) continue;
    const ma = marks(A), mb = marks(B);
    for (const k of Object.keys(ma)) { total++; if (mb[k] && mb[k] === ma[k]) same++; }
  }
  const n = list.length, agree = total ? same / total : 0, okRate = n ? validB / n : 0;
  return { n, agree, okRate, errs, pass: n >= RULES.cq.min && errs === 0 && okRate >= 0.95 && validB >= validA && agree >= 0.8,
    text: `${n} проверок; новая модель дала правильный ответ в ${Math.round(okRate * 100)}% (старая — ${n ? Math.round(validA / n * 100) : 0}%), совпадение отметок со старой ${Math.round(agree * 100)}%${errs ? `, ошибок ${errs}` : ""}` };
}
function evalTr(list) {
  let ok = 0, close = 0, errs = 0;
  for (const r of list) {
    if (r.b.error || r.b.status !== 200 || r.b.stop === "max_tokens") { errs++; continue; }
    ok++;
    const la = String(r.a.text).length, lb = String(r.b.text).length;
    const A = words(r.a.text), B = words(r.b.text);
    let inter = 0; for (const w of A) if (B.has(w)) inter++;
    const jac = A.size + B.size ? inter / (A.size + B.size - inter) : 1;
    if (la === 0 || (lb / la >= 0.75 && lb / la <= 1.33 && jac >= 0.45)) close++;
  }
  const n = list.length;
  return { n, errs, pass: n >= RULES.translate.min && errs === 0 && close / Math.max(1, ok) >= 0.8,
    text: `${n} переводов; без ошибок и обрывов ${ok} из ${n}, близки к прежним по объёму и содержанию ${close} из ${ok}` };
}
function setEnv(key, fn) {
  const lines = fs.readFileSync(ENV, "utf8").split("\n");
  let found = false;
  const out = lines.map((l) => { if (l.startsWith(key + "=")) { found = true; return key + "=" + fn(l.slice(key.length + 1)); } return l; });
  if (!found) out.push(key + "=" + fn(""));
  fs.writeFileSync(ENV, out.join("\n"));
}
function restartVoyo() {
  for (let i = 0; i < 60; i++) {
    let n = 0;
    try { const o = JSON.parse(fs.readFileSync(path.join(__dirname, "..", ".esim", "orders.json"), "utf8")); n = (Array.isArray(o) ? o : o.orders || Object.values(o)).filter((x) => x && x.status === "fulfilling").length; } catch (_) {}
    if (!n) break;
    execSync("sleep 10");
  }
  execSync("pm2 restart voyo --update-env", { stdio: "ignore" });
}
const STATE = path.join(DIR, "switch-state.json");
const readState = () => { try { return JSON.parse(fs.readFileSync(STATE, "utf8")); } catch (_) { return { since: new Date().toISOString(), done: {} }; } };
(async () => {
  const decided = [];
  const st = readState();
  const upgrade = String(process.env.ENGINE_MODEL_UPGRADE || "");
  for (const [svc, rule] of Object.entries(RULES)) {
    if (st.done[svc] || upgrade.includes(rule.upgrade.split(",")[0])) { st.done[svc] = st.done[svc] || "switched"; continue; }   // уже решено
    const list = rows(svc).filter((r) => r.a && r.a.model === rule.from && r.b && r.b.model === rule.to);
    const ev = svc === "cq" ? evalCq(list) : evalTr(list);
    console.log(new Date().toISOString(), svc, ev.pass ? "ПРОХОДИТ" : "не проходит", ev.text);
    if (ev.pass) decided.push({ svc, rule, ev, switched: true });
    else if (ev.n >= rule.min) decided.push({ svc, rule, ev, switched: false });   // данных хватает, но качество не держится — оставляем старую
  }
  const finish = () => {
    if (DRY) return;
    fs.mkdirSync(DIR, { recursive: true }); fs.writeFileSync(STATE, JSON.stringify(st));
    if (Object.keys(RULES).every((k) => st.done[k])) { try { execSync("crontab -l | grep -v modelswitch-daily | crontab -"); console.log("оба сервиса решены — расписание снято"); } catch (_) {} }
  };
  if (!decided.length) {
    const days = (Date.now() - Date.parse(st.since)) / 864e5;
    if (days > 21 && !st.lateMail && !DRY) {
      st.lateMail = 1;
      await require(path.join(__dirname, "..", "mail.js")).sendMail({ to: "director@visa-sc.ru", subject: "Модели Claude: за 3 недели мало данных для сравнения",
        html: "<p>Сравнение старой и новой модели: за 3 недели набралось мало живых запросов (" + Object.keys(RULES).filter((k) => !st.done[k]).map((k) => RULES[k].title).join(", ") + "). Сервисы работают на прежней модели, проверка продолжается.</p>" }).catch(() => {});
    }
    finish();
    return console.log("решений нет (мало данных) — ждём");
  }
  for (const d of decided) st.done[d.svc] = d.switched ? "switched" : "kept";
  if (!DRY) {
    const sw = decided.filter((d) => d.switched);
    if (sw.length) {
      fs.copyFileSync(ENV, ENV + ".bak-modelswitch-" + new Date().toISOString().slice(0, 16).replace(/[-:T]/g, ""));
      setEnv("ENGINE_MODEL_UPGRADE", (v) => [v].concat(sw.map((d) => d.rule.upgrade)).filter(Boolean).join(","));
      setEnv("ENGINE_SHADOW", (v) => v.split(";").filter((p) => !sw.some((d) => p.startsWith(d.svc + ":"))).join(";"));
      restartVoyo();
    }
    const li = decided.map((d) => `<li><b>${d.rule.title}</b>: ${d.switched ? `переведено на ${d.rule.to.replace("claude-", "").replace(/-(\d)-(\d)$/, " $1.$2")}` : "оставлена прежняя модель — новая расходится со старой, разберу"}. ${d.ev.text}.</li>`).join("");
    await require(path.join(__dirname, "..", "mail.js")).sendMail({ to: "director@visa-sc.ru", subject: "Модели Claude: итог сравнения на живых запросах",
      html: `<div style="font-family:-apple-system,Arial,sans-serif;font-size:14px;line-height:1.5;color:#222"><p><b>Сравнение старой и новой модели на живых запросах:</b></p><ul>${li}</ul><p>Сотрудники ничего не заметят: окна и порядок работы прежние. Откат — одна строка в .env, копия рядом.</p></div>` }).catch((e) => console.log("письмо:", e.message));
  }
  finish();
})().catch((e) => { console.error("modelSwitch:", e.message); process.exit(1); });
