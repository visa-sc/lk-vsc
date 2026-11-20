// Ежедневные партии рассылки агентствам (17.11.2026, решение Андрея: по 300–500 в день, до выходных).
//   node tools/esimPartnerDaily.js report        — 09:50: итог вчерашней партии Андрею на почту
//   node tools/esimPartnerDaily.js send <N>      — 10:00: следующие N агентств из очереди
// Очередь: .esim/partner-queue.json (коды и слаги назначены заранее — под них нарисованы
// таблички в .esim/partner-kit/<КОД>/). Журнал партий: .esim/partner-daily.json.
// Не стартует, если сработал автостоп (.esim/partner-mail-stop.json) или у прошлой партии
// не дошло больше 15% писем — тогда пишет Андрею и ждёт решения.
require("dotenv").config({ path: require("path").join(__dirname, "..", ".env"), quiet: true });
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { sendMail } = require("../mail.js");

const ROOT = path.join(__dirname, "..");
const D = path.join(ROOT, ".esim");
const F = { queue: path.join(D, "partner-queue.json"), log: path.join(D, "partner-mail.json"), state: path.join(D, "partner-daily.json"),
  stop: path.join(D, "partner-mail-stop.json"), replies: path.join(D, "partner-replies.json"), orders: path.join(D, "orders.json"), promos: path.join(D, "promos.json") };
const TO = "director@visa-sc.ru";
const rj = (f, d) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch (_) { return d; } };
const mskDate = (t) => new Date((t || Date.now()) + 3 * 3600e3).toISOString().slice(0, 10);
const mail = (subject, text) => process.env.PARTNER_DAILY_DRY ? Promise.resolve(console.log("[без отправки] " + subject + "\n" + text)) : sendMail({ to: TO, subject, text }).then((r) => console.log(r.ok ? "письмо: " + subject : "письмо не ушло: " + r.error));

// итог по партии: сколько ушло, ошибок, недоставленных
function batchStats(b) {
  const log = rj(F.log, {});
  const list = rj(path.join(D, b.file), []);
  const emails = new Set(list.map((x) => String(x.email || "").toLowerCase()));
  let ok = 0, err = 0;
  emails.forEach((e) => { if (log[e]) { if (log[e].ok) ok++; else err++; } });
  const rep = rj(F.replies, { items: [] }).items;
  const bounce = rep.filter((x) => x.bounce && emails.has(String(x.from).toLowerCase())).length;
  const human = rep.filter((x) => !x.bounce && !x.auto && emails.has(String(x.from).toLowerCase())).length;
  return { ok, err, bounce, human, total: list.length };
}
function overall() {
  const promos = rj(F.promos, {});
  const codes = new Set(Object.keys(promos).filter((c) => promos[c].partner && promos[c].partner.email));
  const orders = rj(F.orders, []).filter((o) => codes.has(String(o.promoCode || "").toUpperCase()));
  const rep = rj(F.replies, { items: [] }).items;
  return { sent: Object.values(rj(F.log, {})).filter((x) => x.ok).length, paid: orders.filter((o) => o.status === "done").length,
    revenue: orders.filter((o) => o.status === "done").reduce((a, o) => a + (o.payTotalRub || o.priceRub || 0), 0),
    human: rep.filter((x) => !x.bounce && !x.auto).length, bounce: rep.filter((x) => x.bounce).length };
}

// реакции из журналов nginx: кто открыл кабинет /p/<слаг>, по чьей ссылке ?promo=КОД заходили клиенты.
// Копятся в state.react (журналы живут 14 дней). gz=true — читать и сжатые старые журналы.
function collectReact(state, gz) {
  const promos = rj(F.promos, {});
  const ours = {}; Object.keys(promos).forEach((c) => { const pp = promos[c].partner; if (pp && pp.email) ours[c] = pp; });
  const bySlug = {}; Object.keys(ours).forEach((c) => { bySlug[ours[c].slug] = c; });
  state.react = state.react || { cab: {}, link: {} };
  let files = ["/var/log/nginx/access.log", "/var/log/nginx/access.log.1"];
  if (gz) { try { files = files.concat(fs.readdirSync("/var/log/nginx").filter((f) => /^access\.log\.\d+\.gz$/.test(f)).map((f) => "/var/log/nginx/" + f)); } catch (_) {} }
  files.forEach((lf) => {
    let txt = ""; try { const b = fs.readFileSync(lf); txt = lf.endsWith(".gz") ? require("zlib").gunzipSync(b).toString("utf8") : b.toString("utf8"); } catch (_) { return; }
    txt.split("\n").forEach((ln) => {
      if (/curl|bot|spider|crawl|preview|Yandex|Google/i.test(ln)) return;
      let m = /"GET \/p\/([a-z0-9-]+)[ ?#]/.exec(ln); if (m && bySlug[m[1]]) state.react.cab[bySlug[m[1]]] = state.react.cab[bySlug[m[1]]] || Date.now();
      m = /[?&]promo=([A-Za-z0-9]+)/.exec(ln); if (m && ours[m[1].toUpperCase()]) state.react.link[m[1].toUpperCase()] = state.react.link[m[1].toUpperCase()] || Date.now();
    });
  });
  return ours;
}

(async () => {
  const [mode, nArg] = process.argv.slice(2);
  const state = rj(F.state, { batches: [] });
  const last = state.batches[state.batches.length - 1];

  // тихо копим реакции (cron по вечерам до итогового отчёта 10.12), без писем
  if (mode === "react") { collectReact(state, false); fs.writeFileSync(F.state, JSON.stringify(state, null, 1), "utf8"); return console.log("реакции:", Object.keys(state.react.cab).length, Object.keys(state.react.link).length); }

  // итог рассылки — Андрей 20.11: «10 декабря в 8 утра прислать результаты рассылки»
  if (mode === "final") {
    spawnSync("node", [path.join(__dirname, "esimPartnerReplies.js"), "--days", "30"], { cwd: ROOT, stdio: "ignore" });
    const ours = collectReact(state, true);
    fs.writeFileSync(F.state, JSON.stringify(state, null, 1), "utf8");
    const nm = (c) => (ours[c] && ours[c].name) || c;
    const o = overall();
    const left = rj(F.queue, []).filter((x) => !rj(F.log, {})[String(x.email).toLowerCase()]).length;
    const reps = rj(F.replies, { items: [] }).items.filter((x) => !x.bounce && !x.auto);
    const cab = Object.keys(state.react.cab), lnk = Object.keys(state.react.link);
    // продажи и комиссия агентствам — из учёта партнёров (15% со всех покупок приведённых клиентов)
    const parts = rj(path.join(D, "partners.json"), {});
    let clients = 0, sales = 0, rub = 0, earned = 0; const top = [];
    Object.keys(ours).forEach((c) => {
      const p = parts[c]; if (!p) return;
      const cl = Object.keys(p.clients || {}).length, lg = p.log || [];
      const r = lg.reduce((a, x) => a + (x.amountRub || 0), 0), e = lg.reduce((a, x) => a + (x.earnedRub || 0), 0);
      clients += cl; sales += lg.length; rub += r; earned += e;
      if (lg.length) top.push({ c, n: lg.length, r, e });
    });
    top.sort((a, b) => b.r - a.r);
    const fmt = (n) => Math.round(n).toLocaleString("ru-RU");
    const text = "Итоги рассылки агентствам о партнёрке eSIM (письма 17–20.11), на " + mskDate().split("-").reverse().join(".") + "\n\n" +
      "• Отправлено писем: " + o.sent + ", не доставлено " + o.bounce + " (" + (o.sent ? Math.round(o.bounce / o.sent * 100) : 0) + "%)" + (left ? ", не отправлено " + left : "") + ".\n" +
      "• Ответили люди (без автоответов): " + reps.length + "\n" +
      reps.slice(-15).map((x) => "   – " + (x.name || x.from) + ": " + String(x.text || "").replace(/\s+/g, " ").slice(0, 200)).join("\n") + (reps.length ? "\n" : "") +
      "• Открыли свой кабинет: " + cab.length + (cab.length ? " (" + cab.slice(0, 15).map(nm).join(", ") + (cab.length > 15 ? "…" : "") + ")" : "") + "\n" +
      "• Переходы клиентов по ссылкам агентств: " + lnk.length + (lnk.length ? " (" + lnk.slice(0, 15).map(nm).join(", ") + (lnk.length > 15 ? "…" : "") + ")" : "") + "\n" +
      "• Клиентов привели агентства: " + clients + ", покупок " + sales + " на " + fmt(rub) + " ₽.\n" +
      "• Комиссия агентствам (15%): " + fmt(earned) + " ₽" + (top.length ? "\n" + top.slice(0, 10).map((x) => "   – " + nm(x.c) + ": " + x.n + " покуп. на " + fmt(x.r) + " ₽, комиссия " + fmt(x.e) + " ₽").join("\n") : "") + "\n";
    return mail("eSIM: итоги рассылки агентствам на " + mskDate().split("-").reverse().join("."), text);
  }

  if (mode === "report") {
    spawnSync("node", [path.join(__dirname, "esimPartnerReplies.js"), "--days", "3"], { cwd: ROOT, stdio: "ignore" });
    if (!last) return console.log("партий ещё нет");
    // итог дня — по всем партиям этой даты (их может быть две)
    const s = state.batches.filter((b) => b.date === last.date).map(batchStats)
      .reduce((a, x) => ({ ok: a.ok + x.ok, err: a.err + x.err, bounce: a.bounce + x.bounce, human: a.human + x.human, total: a.total + x.total }), { ok: 0, err: 0, bounce: 0, human: 0, total: 0 });
    const o = overall();
    const left = rj(F.queue, []).filter((x) => !rj(F.log, {})[String(x.email).toLowerCase()]).length;
    // вечерний отчёт (после 15:00 МСК) говорит про завтрашнюю партию, утренний — про сегодняшнюю
    const evening = new Date(Date.now() + 3 * 3600e3).getUTCHours() >= 15;
    const planDay = evening ? mskDate(Date.now() + 864e5) : mskDate();
    const plan = (state.plan || {})[planDay];
    const pct = s.ok ? Math.round(s.bounce / s.ok * 100) : 0;
    // реакции копим в журнале: кабинеты /p/<слаг> и переходы ?promo=КОД из журналов nginx (сегодня и вчера)
    const ours = collectReact(state, false);
    fs.writeFileSync(F.state, JSON.stringify(state, null, 1), "utf8");
    const nm = (c) => (ours[c] && ours[c].name) || c;
    const cab = Object.keys(state.react.cab), lnk = Object.keys(state.react.link);
    const reps = rj(F.replies, { items: [] }).items.filter((x) => !x.bounce && !x.auto);
    const ord = rj(F.orders, []).filter((x) => ours[String(x.promoCode || "").toUpperCase()] && x.status === "done");
    const text = "Рассылка агентствам — сводка на " + mskDate().split("-").reverse().join(".") + "\n\n" +
      "• Ушло писем всего: " + o.sent + ", не доставлено " + o.bounce + " (" + (o.sent ? Math.round(o.bounce / o.sent * 100) : 0) + "%). Осталось в очереди: " + left + ".\n" +
      "• Ответов от агентств (без автоответов): " + reps.length + "\n" +
      reps.slice(-10).map((x) => "   – " + (x.name || x.from) + ": " + String(x.text || "").replace(/\s+/g, " ").slice(0, 160)).join("\n") + (reps.length ? "\n" : "") +
      "• Открыли свой кабинет: " + cab.length + (cab.length ? " (" + cab.slice(0, 8).map(nm).join(", ") + (cab.length > 8 ? "…" : "") + ")" : "") + "\n" +
      "• Переходы клиентов по ссылкам агентств: " + lnk.length + (lnk.length ? " (" + lnk.slice(0, 8).map(nm).join(", ") + ")" : "") + "\n" +
      "• Оплат по кодам агентств: " + ord.length + (ord.length ? " на " + ord.reduce((a, x) => a + (x.payTotalRub || x.priceRub || 0), 0) + " ₽ (" + [...new Set(ord.map((x) => nm(String(x.promoCode).toUpperCase())))].join(", ") + ")" : "") + "\n\n" +
      "Вчерашняя партия (" + last.date + "): ушло " + s.ok + " из " + s.total + ", не доставлено " + s.bounce + ".\n" +
      (fs.existsSync(F.stop) ? "⚠️ Сработал автостоп: почта отказала в отправке. Не шлю, жду вашего решения.\n"
        : pct > 15 ? "⚠️ Недоставленных больше 15% — не шлю, разберусь с адресами и напишу.\n"
        : plan ? (evening ? "Завтра" : "Сегодня") + " в 10:00 — " + plan + " писем.\n" : left ? "" : "Очередь пуста, рассылка завершена.\n") +
      "С почтой: " + (fs.existsSync(F.stop) ? "есть отказ, см. выше." : "проблем нет, клиентские письма уходят как обычно.");
    return mail("eSIM: рассылка агентствам — сводка на " + mskDate().split("-").reverse().join("."), text);
  }

  if (mode === "send") {
    const N = Number(nArg) || 0;
    if (!N) return console.log("нужно число");
    if (fs.existsSync(F.stop)) return mail("eSIM: рассылка агентствам на паузе (автостоп)", "Почта отказала в отправке, партию " + mskDate() + " не запускаю. Подробности в .esim/partner-mail-stop.json. Клиентские письма уходят как обычно.");
    if (last) { const s = batchStats(last); if (s.ok && s.bounce / s.ok > 0.15) return mail("eSIM: рассылка агентствам на паузе (недоставленные)", "У партии " + last.date + " не дошло " + s.bounce + " из " + s.ok + " — больше 15%. Сегодня не шлю, чтобы не портить репутацию ящика."); }
    const log = rj(F.log, {});
    const next = rj(F.queue, []).filter((x) => !log[String(x.email).toLowerCase()]).slice(0, N);
    if (!next.length) return mail("eSIM: рассылка агентствам завершена", "Очередь пуста — письма ушли всем агентствам.");
    // вторая партия за день (Андрей 18.11: «сегодня 500, а не 300») — свой файл, первую не трогаем
    let file = "partner-batch-" + mskDate() + ".json";
    for (let k = 2; fs.existsSync(path.join(D, file)); k++) file = "partner-batch-" + mskDate() + "-" + k + ".json";
    fs.writeFileSync("/tmp/partner-day.json", JSON.stringify(next), "utf8");
    const add = spawnSync("node", [path.join(__dirname, "esimPartnersAdd.js"), "/tmp/partner-day.json", path.join(D, file)], { cwd: ROOT, encoding: "utf8" });
    console.log(add.stdout, add.stderr);
    const list = rj(path.join(D, file), []);
    const lost = list.filter((x) => x.preCode && x.preCode !== x.code).length;   // код не совпал с табличкой
    if (lost) console.log("коды не совпали с табличками:", lost);
    // интервал: успеть до 19:00 МСК, но не чаще раза в 55 секунд
    const now = new Date(Date.now() + 3 * 3600e3), endMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 19, 0) - 3 * 3600e3;
    const gap = Math.max(55000, Math.min(75000, Math.floor((endMs - Date.now()) / N)));
    state.batches.push({ date: mskDate(), file, n: list.length, startedAt: Date.now(), gapMs: gap });
    fs.writeFileSync(F.state, JSON.stringify(state, null, 1), "utf8");
    const r = spawnSync("node", [path.join(__dirname, "esimPartnerMail.js"), "send", path.join(D, file), "--limit", String(N)],
      { cwd: ROOT, encoding: "utf8", env: Object.assign({}, process.env, { PARTNER_MAIL_GAP_MS: String(gap) }), maxBuffer: 1 << 26 });
    fs.appendFileSync("/var/log/esim-partner-daily.log", (r.stdout || "") + (r.stderr || ""));
    const st = rj(F.state, state); const b = st.batches[st.batches.length - 1]; b.finishedAt = Date.now();
    const s = batchStats(b); b.ok = s.ok; b.err = s.err;
    fs.writeFileSync(F.state, JSON.stringify(st, null, 1), "utf8");
    // последняя партия (очередь пуста) — одно итоговое письмо с проверкой, что всё работает (Андрей 20.11)
    const leftAfter = rj(F.queue, []).filter((x) => !rj(F.log, {})[String(x.email).toLowerCase()]).length;
    if (!leftAfter) {
      spawnSync("node", [path.join(__dirname, "esimPartnerReplies.js"), "--days", "4"], { cwd: ROOT, stdio: "ignore" });
      const o = overall();
      const chk = async (u) => { const t0 = Date.now(); try { const r = await fetch(u, { signal: AbortSignal.timeout(15000) }); const tx = await r.text(); return { ok: r.ok, ms: Date.now() - t0, tx }; } catch (e) { return { ok: false, ms: Date.now() - t0, tx: "" }; } };
      const site = await chk("https://voyomobile.ru/"), vt = await chk("https://voyotravel.ru/esim");
      const bot = await chk("https://voyomobile.ru/esim/api/tg/health?adm=" + (process.env.ESIM_ADMIN_CODE || "280992"));
      let botOk = false; try { botOk = JSON.parse(bot.tx).ok === true; } catch (_) {}
      const ords = rj(F.orders, []);
      const today = ords.filter((x) => (x.paidAt || 0) > Date.now() - 864e5);
      const stuck = ords.filter((x) => x.status === "fulfilling" || (x.status === "paid" && Date.now() - (x.paidAt || 0) > 600e3)).length;
      const okAll = site.ok && vt.ok && botOk && !stuck && !fs.existsSync(F.stop);
      return mail("eSIM: рассылка агентствам завершена" + (okAll ? ", всё работает" : " — есть проблема"),
        "Последняя партия " + b.date + ": ушло " + s.ok + " из " + list.length + ", ошибок отправки " + s.err + ".\n\n" +
        "Итого: ушло " + o.sent + " писем, не доставлено " + o.bounce + " (" + (o.sent ? Math.round(o.bounce / o.sent * 100) : 0) + "%), очередь пуста.\n" +
        "Ответов людей: " + o.human + ", оплат по кодам агентств: " + o.paid + (o.paid ? " на " + o.revenue + " ₽" : "") + ".\n\n" +
        "Проверка после рассылки:\n" +
        "• voyomobile.ru: " + (site.ok ? "открывается, " + (site.ms / 1000).toFixed(2) + " с" : "НЕ ОТКРЫВАЕТСЯ") + "\n" +
        "• voyotravel.ru/esim: " + (vt.ok ? "открывается, " + (vt.ms / 1000).toFixed(2) + " с" : "НЕ ОТКРЫВАЕТСЯ") + "\n" +
        "• Телеграм-бот: " + (botOk ? "работает" : "НЕ ОТВЕЧАЕТ") + "\n" +
        "• Заказы клиентов за сутки: " + today.length + ", зависших: " + stuck + "\n" +
        "• Почта: " + (fs.existsSync(F.stop) ? "был отказ (автостоп)" : "отказов не было, клиентские письма уходят") + "\n\n" +
        "Итоговый отчёт по результатам пришлю 10.12 в 8:00.");
    }
    return mail("eSIM: партия " + b.date + " агентствам ушла — " + s.ok + " из " + list.length,
      "Партия " + b.date + ": ушло " + s.ok + " из " + list.length + ", ошибок отправки " + s.err + "." +
      (fs.existsSync(F.stop) ? "\n⚠️ Сработал автостоп, остальное на паузе до вашего решения." : "") +
      (lost ? "\n(" + lost + " агентствам код выдан новый, их письма ушли без вложений с табличкой — некритично, QR есть в кабинете.)" : "") +
      "\nНедоставленные и ответы посчитаю завтра утром, итог пришлю до 10:00.");
  }
  console.log("режимы: report | send <N>");
})().catch((e) => { console.error("partner daily:", e.message); process.exit(1); });
