// Судья для оценок прослушки: на тех же звонках, где Haiku 4.5 и Haiku 5.5 разошлись, Opus 5.5 вслепую решает,
// кто прав по правилам Кати (критерии, правила отделов, поправки руководителей). Файлы Кати только читаются.
"use strict";
const fs = require("fs"), vm = require("vm"), path = require("path");
require("/var/www/voyo/node_modules/dotenv").config({ path: "/var/www/voyo/.env", quiet: true });
const K = "/var/www/kateadmin", D = K + "/data", OUT = "/root/look/cqjudge";
fs.mkdirSync(OUT, { recursive: true });
const load = (n) => JSON.parse(fs.readFileSync(path.join(D, n + ".json"), "utf8"));
const S = { load: (n) => { try { return load(n); } catch (_) { return {}; } } };
function lit(file, name) {
  const s = fs.readFileSync(file, "utf8"); const i = s.indexOf("const " + name + " = "); if (i < 0) throw new Error(name);
  let j = s.indexOf("=", i) + 1; while (/\s/.test(s[j])) j++;
  const open = s[j], close = open === "[" ? "]" : "}"; let depth = 0, k = j, q = null;
  for (; k < s.length; k++) {
    const c = s[k];
    if (q) { if (c === "\\") { k++; continue; } if (c === q) q = null; continue; }
    if (c === "/" && s[k + 1] === "/") { k = s.indexOf("\n", k); continue; }
    if (c === '"' || c === "'" || c === "`") { q = c; continue; }
    if (c === open) depth++; else if (c === close && --depth === 0) break;
  }
  return vm.runInNewContext("(" + s.slice(j, k + 1) + ")", {});
}
const CRIT = lit(K + "/sverki.js", "CQ_CRITERIA");
const TYPES = lit(K + "/sverki.js", "CQ_CALL_TYPES");
const DEPT = lit(K + "/cq-api.js", "CQ_DEPT_RULES");
const TYPE_RULES = lit(K + "/cq-api.js", "CQ_TYPE_RULES");
const LEARN = require(K + "/cq-learning");
const st = S.load("cqSettings");
const critList = Array.isArray(st.criteria) && st.criteria.length ? st.criteria : CRIT;
const json = (t) => { const s = String(t || "").replace(/```json|```/g, ""); const a = s.indexOf("{"), b = s.lastIndexOf("}"); try { return JSON.parse(s.slice(a, b + 1)); } catch (_) { return null; } };

const pairs = fs.readFileSync("/var/lib/engine-shadow/cq.jsonl", "utf8").trim().split("\n").map(JSON.parse).filter((r) => /"scores"/.test(r.a.text));
const checks = load("cqChecks"); const calls = load("cqCalls");
const callById = new Map(calls.map((c) => [c.id, c]));
const cases = [];
for (const p of pairs) {
  const A = json(p.a.text), B = json(p.b.text);
  const ch = checks.find((c) => c.channel === "call" && c.callTypeWhy === (A && A.typeWhy)) ;
  const call = ch && callById.get(ch.id);
  cases.push({ at: p.at, A, B, ch, call, validB: !!B });
}
async function opus(system, user) {
  const r = await fetch((process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com").replace(/\/$/, "") + "/v1/messages", {
    method: "POST", headers: { "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: "claude-opus-5-5", max_tokens: 16000, output_config: { effort: "high" }, system, messages: [{ role: "user", content: user }] }),
    signal: AbortSignal.timeout(10 * 60 * 1000) });
  const j = await r.json();
  if (j.usage) try { require("/var/www/voyo/ai-usage").record("model-eval", j.model || "claude-opus-5-5", j.usage); } catch (_) {}
  if (!r.ok) throw new Error(r.status + " " + JSON.stringify(j.error || j).slice(0, 200));
  return (j.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
}
(async () => {
  const res = [];
  for (const c of cases) {
    if (!c.A || !c.ch || !c.call) { res.push({ at: c.at, skip: !c.A ? "старый ответ не JSON" : !c.ch ? "не нашёл проверку" : "не нашёл звонок" }); continue; }
    const dept = c.ch.dept, t = c.call.clean && Object.keys(c.call.clean).length ? c.call.clean : (c.call.text || {});
    const body = t.manager && t.client ? "МЕНЕДЖЕР:\n" + t.manager + "\n\nКЛИЕНТ:\n" + t.client : "ЗАПИСЬ В ОДИН КАНАЛ:\n" + (t.both || t.manager || "");
    const sa = (c.A && c.A.scores) || {}, sb = (c.B && c.B.scores) || {};
    const ids = Object.keys(sa).filter((id) => sb[id] && sb[id].mark !== sa[id].mark);
    const typeDiff = c.B && c.B.type !== c.A.type;
    const missingB = Object.keys(sa).filter((id) => !sb[id]);
    if (!ids.length && !typeDiff) { res.push({ at: c.at, emp: c.ch.employee, dept, items: [], typeDiff: false, missingB }); continue; }
    const flip = ids.map(() => Math.random() < 0.5);
    const crit = critList.filter((x) => ids.includes(x.id));
    const rules = crit.map((x) => x.id + " — «" + x.label + "». " + (x.hint || "") + (x.how ? " " + x.how : "") + (((DEPT[dept] || {})[x.id]) ? " " + DEPT[dept][x.id] : "")).join("\n\n");
    let learned = ""; try { learned = LEARN.forPrompt(S, { channel: "call", dept, callType: "", criteria: crit.map((x) => x.id), labels: crit }) || ""; } catch (_) {}
    const okTypes = TYPES.filter((x) => x.depts === "*" || (Array.isArray(x.depts) && x.depts.includes(dept)));
    const typesTxt = (okTypes.length > 1 ? okTypes : TYPES).map((x) => "  " + x.id + " — " + x.label + ": " + x.hint).join("\n");
    const disputes = ids.map((id, i) => { const [X, Y] = flip[i] ? [sb[id], sa[id]] : [sa[id], sb[id]];
      return id + ":\n  Оценщик X: " + X.mark + " — " + (X.note || "") + "\n  Оценщик Y: " + Y.mark + " — " + (Y.note || ""); }).join("\n\n");
    const tflip = Math.random() < 0.5; const [tX, tY] = tflip ? [c.B, c.A] : [c.A, c.B];
    const sys = "Вы старший контролёр качества визового центра. Два оценщика проверили один и тот же телефонный разговор менеджера по правилам компании и разошлись. " +
      "Рассудите их строго по правилам ниже — не по своему вкусу и не в пользу более строгого или более мягкого. Расшифровка сделана распознаванием речи: не придирайтесь к исковерканным словам. " +
      "Если нужное место неразборчиво — по правилу компании ставится na. Отвечайте только JSON.";
    const user = "ПРАВИЛА ПО СПОРНЫМ КРИТЕРИЯМ:\n\n" + rules + learned +
      "\n\nОценки: yes (Выполнено), part (Частично), no (Не выполнено), na (Неприменимо).\n\n" +
      (typeDiff ? "ТИПЫ РАЗГОВОРА:\n" + typesTxt + "\n" + (TYPE_RULES[dept] || "") + "\nТип по мнению X: " + tX.type + " (" + (tX.typeWhy || "") + ")\nТип по мнению Y: " + tY.type + " (" + (tY.typeWhy || "") + ")\n\n" : "") +
      "СПОРНЫЕ ОЦЕНКИ:\n\n" + disputes +
      '\n\nОтветьте JSON: {"type":{"right":"X|Y|both|neither","why":"..."} (только если спорят о типе),"items":[{"id":"c_...","right":"X|Y|both|neither","mark":"ваша оценка","why":"одна фраза"}]}' +
      "\n\nРАЗГОВОР (менеджер — " + c.ch.employee + ", " + Math.round((c.call.seconds || 0) / 60) + " мин):\n" + body;
    let out; try { out = json(await opus(sys, user)); } catch (e) { res.push({ at: c.at, err: e.message }); continue; }
    const items = ((out && out.items) || []).map((it) => { const i = ids.indexOf(it.id); if (i < 0) return null;
      const who = it.right === "X" ? (flip[i] ? "new" : "old") : it.right === "Y" ? (flip[i] ? "old" : "new") : it.right;
      return { id: it.id, old: sa[it.id].mark, new: sb[it.id].mark, judge: it.mark, right: who, why: it.why }; }).filter(Boolean);
    let typeRight = null; if (typeDiff && out && out.type) typeRight = out.type.right === "X" ? (tflip ? "new" : "old") : out.type.right === "Y" ? (tflip ? "old" : "new") : out.type.right;
    res.push({ at: c.at, emp: c.ch.employee, dept, items, typeDiff, typeOld: c.A.type, typeNew: c.B && c.B.type, typeRight, missingB });
    process.stderr.write(".");
  }
  fs.writeFileSync(OUT + "/result.json", JSON.stringify({ cases: cases.length, validB: cases.filter((c) => c.validB).length, res }, null, 1));
  const all = res.flatMap((r) => r.items || []); const cnt = (k) => all.filter((x) => x.right === k).length;
  const strictNew = all.filter((x) => ({ yes: 3, part: 2, no: 1 })[x.new] < ({ yes: 3, part: 2, no: 1 })[x.old]);
  console.log("\nзвонков", cases.length, "валидный JSON у новой", cases.filter((c) => c.validB).length, "пропущено", res.filter((r) => r.skip || r.err).map((r) => r.skip || r.err));
  console.log("споров", all.length, "права старая", cnt("old"), "права новая", cnt("new"), "обе", cnt("both"), "никто", cnt("neither"));
  console.log("где новая строже:", strictNew.length, "из них права новая", strictNew.filter((x) => x.right === "new").length, "старая", strictNew.filter((x) => x.right === "old").length);
  const td = res.filter((r) => r.typeDiff); console.log("тип спорный", td.length, "прав новый", td.filter((r) => r.typeRight === "new").length, "старый", td.filter((r) => r.typeRight === "old").length);
  console.log("критерии, которые новая пропустила:", res.flatMap((r) => r.missingB || []).join(",") || "нет");
  const byId = {}; for (const x of all) { const b = byId[x.id] || (byId[x.id] = { old: 0, new: 0, other: 0 }); b[x.right === "old" ? "old" : x.right === "new" ? "new" : "other"]++; }
  console.log("по критериям:", JSON.stringify(byId));
})().catch((e) => { console.error(e); process.exit(1); });
