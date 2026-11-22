#!/usr/bin/env node
// Просьба Андрея 22.11.2026: предложить Кате перевести оценки прослушки на Haiku 5.5 (дешевле в ~10 раз),
// решение и переход — на её стороне (подробности её Claude — в «Помощниках»).
//   send   — 23.11 06:00 МСК сообщение в личку Андрей–Катя (метка askTag на сообщении);
//   nudge  — 10:00 и 14:00 МСК: если Катя не отреагировала — короткое напоминание ответом на сообщение;
//   report — 10.12 08:00 МСК одно письмо Андрею: оценки (модель, ответ Кати) и переводы (решение tools/modelSwitch.js) (запуск от root).
// send/nudge — ТОЛЬКО от kateadmin (файлы чата её). --dry — ничего не писать.
"use strict";
const mode = process.argv[2], dry = process.argv.includes("--dry");
const ROOM = "dm_director@visa-sc.ru__ekaterina.z@visa-sc.ru", KATE = "ekaterina.z@visa-sc.ru", TAG = "models-1123";
const fs = require("fs");

function chat() {
  process.chdir("/var/www/kateadmin");
  const C = require("/var/www/kateadmin/notify-chat.js");
  C.useCenter({ ownerEmail: () => KATE, resolve: () => [] });
  return C;
}
function history(I) {
  const months = [], now = new Date();
  for (let d = new Date(Date.UTC(2026, 10, 1)); d <= now; d.setUTCMonth(d.getUTCMonth() + 1)) months.push(d.toISOString().slice(0, 7));
  return [].concat(...months.map((mo) => I.loadMonth(ROOM, mo))).sort((a, b) => String(a.at).localeCompare(String(b.at)));
}
// Ответила ли Катя: реакция на наше сообщение или напоминание, ответ цитатой/в ветке, сообщение по теме, короткий ответ сразу после.
function answer(all) {
  const orig = all.find((m) => m.askTag === TAG);
  if (!orig) return { orig: null };
  const ours = new Set([orig.id].concat(all.filter((m) => m.nudgeFor === orig.id).map((m) => m.id)));
  if (all.some((m) => ours.has(m.id) && Object.values(m.reactions || {}).some((w) => (w || []).includes(KATE)))) return { orig, ours, how: "реакция", text: "" };
  let lastOurs = false;
  for (const m of all) {
    if (m.at < orig.at) continue;
    if (ours.has(m.id)) { lastOurs = true; continue; }
    if (m.from !== KATE) { lastOurs = false; continue; }
    const t = String(m.text || "");
    if ((m.reply && ours.has(m.reply.id)) || ours.has(m.thread)) return { orig, ours, how: "ответ", text: t };
    if (/модел|haiku|хайку|прослушк|оценк/i.test(t)) return { orig, ours, how: "сообщение по теме", text: t };
    if (lastOurs && t.length <= 60) return { orig, ours, how: "короткий ответ", text: t };
    lastOurs = false;
  }
  return { orig, ours, how: "" };
}

const TEXT = "Катя, от Андрея.\n\n" +
  "Оценки прослушки можно перевести на новую модель Haiku 5.5: оценка звонков станет примерно в 10 раз дешевле. Чистка расшифровок на ней уже работает.\n\n" +
  "Сейчас просто переключить нельзя. На тех же звонках новая модель без оснований снижает примерно каждую шестую отметку, в основном «Исход для клиента» и «Речь». Сначала нужно поправить формулировки этих критериев и перепроверить.\n\n" +
  "Решение и переход — на твоей стороне, делаешь сама со своим Claude, без меня. Всё для него лежит в «Помощниках». Ответь здесь: берёшь в работу или оставляем как есть.";

(async () => {
  if (mode === "send" || mode === "nudge") {
    const C = chat(), I = C._int, all = history(I), a = answer(all);
    if (mode === "send") {
      if (a.orig) return console.log("уже отправлено:", a.orig.id);
      if (dry) return console.log("ОТПРАВИЛ БЫ:\n" + TEXT);
      const r = C.postAs(ROOM, { as: "claude", text: TEXT, key: "kate-models-ask-" + TAG, mentions: [KATE] });
      if (r && r.ok && !r.dup) { const mo = I.monthOf(r.at), list = I.loadMonth(ROOM, mo), m = list.find((x) => x.id === r.id); if (m) { m.askTag = TAG; I.saveMonth(ROOM, mo, list); } }
      return console.log("отправил:", JSON.stringify(r));
    }
    if (!a.orig) return console.log("исходного сообщения нет — напоминать не о чем");
    if (a.how) return console.log("ANSWERED:", a.how);
    const text = a.ours.size === 1 ? "Катя, напоминаю про это сообщение: ответь, берёшь перевод оценок на новую модель в работу или оставляем как есть." : "Катя, ещё раз: ответа по модели для оценок прослушки пока нет.";
    if (dry) return console.log("НАПОМНИЛ БЫ:", text);
    const r = C.postAs(ROOM, { as: "claude", text, key: "kate-models-nudge-" + new Date().toISOString().slice(0, 13), mentions: [KATE] });
    if (r && r.ok && !r.dup) { const mo = I.monthOf(r.at), list = I.loadMonth(ROOM, mo), m = list.find((x) => x.id === r.id); if (m) { m.reply = { id: a.orig.id, from: a.orig.from, text: String(a.orig.text || "").slice(0, 160) }; m.nudgeFor = a.orig.id; I.saveMonth(ROOM, mo, list); } }
    return console.log("напомнил:", JSON.stringify(r));
  }
  if (mode === "report") {
    // Какая модель реально ставила оценки последние 7 дней (журнал шлюза) и что записано в коде Кати.
    const src = fs.readFileSync("/var/www/kateadmin/sverki.js", "utf8");
    const def = (src.match(/const CQ_AI_DEFAULT_MODEL = "([^"]+)"/) || [])[1] || "?";
    const b = JSON.parse(fs.readFileSync("/var/www/voyo/.engineBudget.json", "utf8")); const cnt = {};
    for (const [, v] of Object.entries(b.days).slice(-7)) for (const [mo, n] of Object.entries(((v.svc || {}).cq || {}).models || {})) cnt[mo] = (cnt[mo] || 0) + n;
    const nice = (m) => m.replace("claude-", "").replace(/-(\d)-(\d)$/, " $1.$2").replace(/-(\d)$/, " $1");
    // Радар /vsc на Opus 5.5 с 21.11: полные прогоны с 22.11 по моделям (Opus 5 = запасная, значит новая давала сбой)
    let radar = "нет данных"; try {
      const u = JSON.parse(fs.readFileSync("/var/www/voyo/.aiUsage.json", "utf8")).filter((x) => x.svc === "vsc_radar" && x.ts > Date.parse("2026-11-22T00:00:00Z") && x.in > 10000);
      const by = {}; for (const x of u) by[x.model] = (by[x.model] || 0) + 1;
      radar = u.length ? "прогонов " + u.length + ": " + Object.entries(by).map(([m, n]) => nice(m) + " — " + n).join(", ") + (by["claude-opus-5"] ? " (часть ушла на запасную старую модель)" : ", все на новой") : "полных прогонов не было";
    } catch (_) {}
    // Ночные проверки modelAudit (с 22.11)
    let aud = "нет данных"; try {
      const L = fs.readFileSync("/var/lib/engine-shadow/audit.jsonl", "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
      const bad = L.filter((x) => x.problems && x.problems.length), fx = L.filter((x) => x.fixed && x.fixed.length);
      aud = "ночей " + L.length + ", с неполадками " + bad.length + (bad.length ? " (" + bad.map((x) => x.at.slice(5, 10) + ": " + x.problems.join("; ").slice(0, 160).replace(/</g, "&lt;")).join(" | ") + ")" : "") + (fx.length ? ", исправлено автоматически " + fx.length + " раз" : "") + (bad.length && !fx.length ? ", исправлять автоматически не потребовалось или нечем — Катя получала письма" : "");
    } catch (_) {}
    let ans = { how: "" }; try { const C = chat(); ans = answer(history(C._int)); } catch (_) {}
    const switched = /haiku-5-5/.test(def);
    // Переводы: решение modelSwitch (switch-state.json)
    let tr = "нет данных"; try {
      const ss = JSON.parse(fs.readFileSync("/var/lib/engine-shadow/switch-state.json", "utf8")), t = ss.tr || {}, d = (ss.done || {}).translate;
      const esc = (x) => String(x || "").replace(/</g, "&lt;");
      tr = d === "switched" ? "переключены на Sonnet 5.5 " + new Date(t.switchedAt).toLocaleDateString("ru-RU", { timeZone: "Europe/Moscow" }) + (t.audit ? ". После переключения: заказов " + t.audit.orders + ", готово " + t.audit.done + ", ошибок " + t.audit.errors + ", откатов " + t.audit.fallbacks : "")
        : d === "kept" ? "оставлена Sonnet 5" + (t.rolledBack ? " — был откат: " + esc(t.rolledBack) : " — новая модель не прошла сравнение") + ". " + esc(t.last)
        : "оставлена Sonnet 5 — до 10.12 не набралось заказов для сравнения. " + esc(t.last);
    } catch (_) {}
    const html = `<div style="font-family:-apple-system,Arial,sans-serif;font-size:14px;line-height:1.5;color:#222">` +
      `<p><b>Модели на 10.12</b></p><p><b>Переводы документов:</b> ${tr}.</p><p><b>Ночные проверки:</b> ${aud}.</p><p><b>Радар /vsc (Opus 5.5):</b> ${radar}.</p><p><b>Оценки прослушки:</b> ${switched ? "Катя перевела на новую модель" : "оставлена старая модель"} (${nice(def)}).</p><ul>` +
      `<li>Запросы прослушки за 7 дней по моделям: ${Object.entries(cnt).map(([m, n]) => nice(m) + " — " + n).join(", ") || "нет данных"}. Чистка расшифровок идёт на Haiku 5.5 с 22.11.</li>` +
      `<li>Ответ Кати на предложение 23.11: ${ans.how ? ans.how + (ans.text ? " — «" + String(ans.text).slice(0, 200).replace(/</g, "&lt;") + "»" : "") : "не ответила"}.</li></ul></div>`;
    if (dry) return console.log(html);
    require("/var/www/voyo/node_modules/dotenv").config({ path: "/var/www/voyo/.env", quiet: true });
    await require("/var/www/voyo/mail.js").sendMail({ to: "director@visa-sc.ru", subject: "Модели Claude: итог на 10.12 (переводы и оценки)", html });
    return console.log("письмо отправлено");
  }
  console.log("режим: send | nudge | report [--dry]");
})().catch((e) => { console.error("kateModelsAsk:", e.message); process.exit(1); });
