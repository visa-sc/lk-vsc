#!/usr/bin/env node
/* ─────────────────────────────────────────────────────────────────────────────
 * modelSwitch — перевод переводов документов на Sonnet 5.5 после сравнения на живых заказах (Андрей 21–22.11.2026).
 *
 * Шлюз (engine-proxy.js, ENGINE_SHADOW) отдаёт заказчику перевод старой модели, а тот же запрос в фоне шлёт новой и
 * пишет оба ответа в /var/lib/engine-shadow/translate.jsonl. Прослушка (cq) решена 22.11 отдельно: чистка — Haiku 5.5
 * через upgradeIf, оценки — решает Катя (tools/kateModelsAsk.js).
 * Каждый день в 09:05 до 10.12:
 *   нет решения — сравниваем (evalTr). Проходит → сам переключаю (.engineModels.json, шлюз читает на лету, без перезапуска),
 *     сразу живая проверка через шлюз; не прошла → тут же откат. Данных хватает, но не проходит → остаётся прежняя.
 *   переключено — проверка заказов движка после переключения: любая ошибка заказа или откат новой модели в шлюзе → автооткат.
 *   Любое изменение — сообщением Катиному Claude в «Помощники». Андрею писем нет: итог 10.12 в 08:00 (tools/kateModelsAsk.js report).
 * Журнал решений — switch-state.json (log, tr). Запуск: node tools/modelSwitch.js [--dry]
 * ───────────────────────────────────────────────────────────────────────────── */
"use strict";
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
require("dotenv").config({ path: path.join(__dirname, "..", ".env"), quiet: true });
const DRY = process.argv.includes("--dry");
const DIR = process.env.MODEL_SHADOW_DIR || "/var/lib/engine-shadow";   // MODEL_SHADOW_DIR — только для проверки
const RULES = {
  cq: { title: "Прослушка звонков (Катя)", from: "claude-haiku-4-5", to: "claude-haiku-5-5", min: 25, upgrade: "cq:claude-haiku-4-5=claude-haiku-5-5" },
  // 22.11: только основная модель перевода. Мелкие задачи движка на Haiku (тип документа, выжимка правок) не сравнивались —
  // их не трогаем. Минимум 15 переводов и 5 проверок минимум за 3 разных дня (растянуто по просьбе Андрея 22.11) (одна заявка даёт несколько запросов подряд).
  translate: { title: "Переводы документов", from: "claude-sonnet-5", to: "claude-sonnet-5-5", min: 15, minCheck: 5, days: 3, upgrade: "translate:claude-sonnet-5=claude-sonnet-5-5" }
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
// Числа в переводе (номера документов, даты, суммы) — главное, что нельзя потерять. Сравниваем как мультимножества:
// каждое число старого перевода должно быть в новом. Хоть одно расхождение — сам не переключаю, разбираю руками. Ответы в журнале обрезаны на 20 000 знаков — у старого берём начало.
const nums = (t) => { const m = new Map(); for (const x of String(t || "").match(/\d{2,}/g) || []) m.set(x, (m.get(x) || 0) + 1); return m; };
// Движок шлёт на Sonnet два вида запросов: сам перевод (HTML) и проверку перевода «редактором-контролёром» (JSON
// {verdict, issues}). Их сравниваем по-разному: переводы — строго по числам и близости текста, проверки — новая модель
// должна вернуть правильный JSON и не пропустить критичную ошибку, которую нашла старая (находить больше — можно).
const chk = (t) => { const j = json(t); return j && typeof j.verdict === "string" ? j : null; };
const crit = (j) => ((j && j.issues) || []).filter((i) => i && i.severity === "critical").length;
function evalTr(list) {
  let ok = 0, close = 0, errs = 0, numOk = 0, numAll = 0, numHit = 0, cN = 0, cValid = 0, cNeed = 0, cCaught = 0, cSame = 0;
  const days = new Set(list.map((r) => String(r.at || "").slice(0, 10)));
  for (const r of list) {
    if (r.b.status === 429 || r.b.status >= 500) continue;   // перегрузка или сбой канала — не про качество, пропускаем
    if (r.b.error || r.b.status !== 200 || r.b.stop === "max_tokens") { errs++; continue; }
    const A = chk(r.a.text);
    if (A) {                                   // проверка перевода
      cN++; const B = chk(r.b.text); if (!B) continue; cValid++;
      if (A.verdict === B.verdict) cSame++;
      if (crit(A)) { cNeed++; if (crit(B)) cCaught++; }
      continue;
    }
    ok++;                                      // сам перевод
    const na = nums(String(r.a.text).length >= 19990 ? String(r.a.text).slice(0, 18000) : r.a.text), nb = nums(r.b.text);
    let miss = 0; for (const [x, c] of na) { numAll += c; const h = Math.min(c, nb.get(x) || 0); numHit += h; miss += c - h; }
    if (!miss) numOk++;
    const la = String(r.a.text).length, lb = String(r.b.text).length;
    const WA = words(r.a.text), WB = words(r.b.text);
    let inter = 0; for (const w of WA) if (WB.has(w)) inter++;
    const jac = WA.size + WB.size ? inter / (WA.size + WB.size - inter) : 1;
    if (la === 0 || (lb / la >= 0.75 && lb / la <= 1.33 && jac >= 0.45)) close++;
  }
  const R = RULES.translate, n = list.length;
  const enough = ok >= R.min && cN >= R.minCheck && days.size >= R.days;
  const numRate = numAll ? numHit / numAll : 1;
  return { n: enough ? n : 0, errs,
    pass: enough && errs === 0 && close / Math.max(1, ok) >= 0.8 && numOk === ok && cValid === cN && cCaught === cNeed,
    text: `за ${days.size} дн.: переводов ${ok}, проверок ${cN}, ошибок и обрывов новой модели ${errs}. Переводы: близки к прежним ${close} из ${ok}, все числа (даты, номера, суммы) совпали в ${numOk} из ${ok} (всего чисел ${Math.round(numRate * 1000) / 10}%). Проверки: правильный ответ ${cValid} из ${cN}, вывод совпал ${cSame} из ${cN}, критичные ошибки, найденные старой, нашла и новая: ${cCaught} из ${cNeed}` };
}
const STATE = path.join(DIR, "switch-state.json");
const readState = () => { try { return JSON.parse(fs.readFileSync(STATE, "utf8")); } catch (_) { return { since: new Date().toISOString(), done: {} }; } };
const MF = path.join(__dirname, "..", ".engineModels.json");
const readMF = () => { try { return JSON.parse(fs.readFileSync(MF, "utf8")) || {}; } catch (_) { return {}; } };
const writeUpgrade = (fn) => { const o = readMF(); o.upgrade = fn(String(o.upgrade || "").split(",").map((s) => s.trim()).filter(Boolean)).join(","); o.at = new Date().toISOString(); fs.writeFileSync(MF, JSON.stringify(o, null, 1)); };
const nice = (m) => m.replace("claude-", "").replace(/-(\d)-(\d)$/, " $1.$2");
// Сообщение Катиному Claude в «Помощники» о любом изменении (Андрей 22.11: изменения — сразу туда, ему — итог 10.12).
function toKate(key, text) {
  if (DRY) return console.log("В ПОМОЩНИКИ БЫ:", text);
  const f = "/tmp/modelswitch-" + key + ".txt";
  try { fs.writeFileSync(f, "Катя, от Андрея. Для твоего Claude.\n\n" + text, { mode: 0o644 }); execSync("runuser -u kateadmin -- env MENTION=ekaterina.z@visa-sc.ru node " + path.join(__dirname, "helpersRoomSay.js") + " gmvcc6iz9pmsc claude " + key + " < " + f, { stdio: "inherit" }); }
  catch (e) { console.log("Помощники:", e.message); } finally { try { fs.unlinkSync(f); } catch (_) {} }
}
// Живая проверка сразу после переключения: запрос как у движка (поток, Sonnet 5) через шлюз — должен ответить Sonnet 5.5 и не потерять цифры.
async function smoke() {
  const key = (fs.readFileSync("/var/www/translate-engine/.env", "utf8").match(/^ANTHROPIC_API_KEY=(.+)$/m) || [])[1];
  const r = await fetch("http://127.0.0.1:" + (process.env.PORT || 3000) + "/internal/anthropic/v1/messages", { method: "POST",
    headers: { "x-api-key": String(key || "").trim(), "anthropic-version": "2023-06-01", "content-type": "application/json", "x-voyo-service": "translate" },
    body: JSON.stringify({ model: RULES.translate.from, max_tokens: 60000, stream: true, output_config: { effort: "medium" }, system: "Ты переводчик документов. Верни HTML.",
      messages: [{ role: "user", content: "Проверка после переключения. Переведи на английский в <section class=\"page\">: Паспорт серия 75 номер 1234567 выдан 05.03.2026, сумма 15000 рублей." }] }),
    signal: AbortSignal.timeout(5 * 60 * 1000) });
  const t = await r.text(); const model = (t.match(/"model":"([^"]+)"/) || [])[1] || "";
  const text = t.split("\n").filter((l) => l.startsWith("data:")).map((l) => { try { const e = JSON.parse(l.slice(5)); return (e.delta && e.delta.text) || ""; } catch (_) { return ""; } }).join("");
  const ok = r.status === 200 && model.indexOf(RULES.translate.to) === 0 && /1234567/.test(text) && /<section/.test(text);
  return { ok, why: ok ? "" : `ответ ${r.status}, модель ${model || "?"}, ${/1234567/.test(text) ? "" : "номер паспорта потерян"}` };
}
// Проверка после переключения: заказы движка с момента переключения — ни одной ошибки, и в журнале шлюза нет откатов новой модели.
function audit(since) {
  let orders = []; try { orders = (JSON.parse(fs.readFileSync("/var/www/translate-engine/.translate/orders.json", "utf8")).orders || []).filter((o) => Number(o.createdAt) >= since); } catch (_) {}
  const errs = orders.filter((o) => o.status === "error" || o.correctStatus === "error");
  let fb = 0; try { fb = (execSync("grep -ac 'новая модель " + RULES.translate.to + " \\(ответила\\|обрезала\\)' /root/.pm2/logs/voyo-error.log /root/.pm2/logs/voyo-out.log 2>/dev/null || true").toString().match(/:(\d+)/g) || []).reduce((s, x) => s + Number(x.slice(1)), 0); } catch (_) {}
  return { orders: orders.length, done: orders.filter((o) => o.status === "done").length, errs, fb };
}
(async () => {
  const st = readState(); st.tr = st.tr || {}; st.log = st.log || [];
  const note = (s) => { const l = new Date().toISOString().slice(0, 16) + " " + s; st.log.push(l); st.log = st.log.slice(-60); console.log(l); };
  const rule = RULES.translate, fileUp = String(readMF().upgrade || "");
  const isOn = fileUp.split(",").includes(rule.upgrade);
  if (!st.done.translate) {
    const list = rows("translate").filter((r) => r.a && r.a.model === rule.from && r.b && r.b.model === rule.to);
    const ev = evalTr(list);
    st.tr.last = ev.text;
    note("переводы: " + (ev.pass ? "ПРОХОДИТ" : ev.n ? "не проходит" : "мало данных") + " — " + ev.text);
    if (ev.pass && !DRY) {
      writeUpgrade((a) => a.filter((x) => x !== rule.upgrade).concat(rule.upgrade));
      st.done.translate = "switched"; st.tr.switchedAt = Date.now(); st.tr.fbBase = audit(Date.now()).fb;
      const s = await smoke().catch((e) => ({ ok: false, why: e.message }));
      if (s.ok) {
        note("переводы переключены на " + nice(rule.to) + ", живая проверка прошла");
        toKate("modelswitch-tr-on", `Переводы документов переключены на ${nice(rule.to)} (было ${nice(rule.from)}). Сравнение на живых заказах: ${ev.text}.\n\nПереключает шлюз (/var/www/voyo/.engineModels.json, строка ${rule.upgrade}), в translate-engine ничего не менялось. TRANSLATE_MODEL / TRANSLATE_MODEL_CHECK в .env движка НЕ менять. Мелкие задачи на Haiku не переключались. Если новая модель ответит ошибкой, шлюз сам повторит на прежней. Ближайшие дни каждый заказ проверяется: при ошибках будет автооткат. Откат вручную — убрать эту строку из .engineModels.json, перезапуск не нужен.`);
      } else {
        writeUpgrade((a) => a.filter((x) => x !== rule.upgrade)); st.done.translate = "kept"; st.tr.rolledBack = "живая проверка: " + s.why;
        note("переводы: живая проверка после переключения НЕ прошла (" + s.why + ") — сразу вернул прежнюю модель");
      }
    } else if (ev.n && !DRY) { st.done.translate = "kept"; note("переводы: данных хватает, но новая модель не прошла — оставлена прежняя"); }
  } else if (st.done.translate === "switched" && isOn) {
    const a = audit(st.tr.switchedAt), fb = a.fb - (st.tr.fbBase || 0);
    st.tr.audit = { at: new Date().toISOString(), orders: a.orders, done: a.done, errors: a.errs.length, fallbacks: fb };
    note(`переводы на ${nice(rule.to)}: с переключения заказов ${a.orders}, готово ${a.done}, ошибок ${a.errs.length}, откатов в шлюзе ${fb}`);
    if ((a.errs.length || fb > 0) && !DRY) {
      writeUpgrade((x) => x.filter((y) => y !== rule.upgrade)); st.done.translate = "kept"; st.tr.rolledBack = `ошибок в заказах ${a.errs.length} (${a.errs.map((o) => String(o.error || "").slice(0, 80)).join("; ")}), откатов в шлюзе ${fb}`;
      note("переводы: ОТКАТ на " + nice(rule.from) + " — " + st.tr.rolledBack);
      toKate("modelswitch-tr-off", `Переводы документов возвращены на ${nice(rule.from)}: после переключения на ${nice(rule.to)} были сбои (${st.tr.rolledBack}). Строка ${rule.upgrade} убрана из /var/www/voyo/.engineModels.json. В translate-engine ничего не менялось.`);
    }
  }
  if (!DRY) { fs.mkdirSync(DIR, { recursive: true }); fs.writeFileSync(STATE, JSON.stringify(st)); }
})().catch((e) => { console.error("modelSwitch:", e.message); process.exit(1); });
