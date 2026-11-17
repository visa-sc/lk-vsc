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

(async () => {
  const [mode, nArg] = process.argv.slice(2);
  const state = rj(F.state, { batches: [] });
  const last = state.batches[state.batches.length - 1];

  if (mode === "report") {
    spawnSync("node", [path.join(__dirname, "esimPartnerReplies.js"), "--days", "3"], { cwd: ROOT, stdio: "ignore" });
    if (!last) return console.log("партий ещё нет");
    const s = batchStats(last), o = overall();
    const left = rj(F.queue, []).filter((x) => !rj(F.log, {})[String(x.email).toLowerCase()]).length;
    const plan = (state.plan || {})[mskDate()];
    const pct = s.ok ? Math.round(s.bounce / s.ok * 100) : 0;
    const text = "Итог партии " + last.date + " (" + s.total + " агентств):\n" +
      "• ушло " + s.ok + ", ошибок отправки " + s.err + ", не доставлено " + s.bounce + " (" + pct + "%)\n" +
      "• ответов от людей по этой партии: " + s.human + "\n\n" +
      "Всего с начала рассылки: ушло " + o.sent + ", ответов " + o.human + ", не доставлено " + o.bounce + ", оплат по кодам агентств " + o.paid + (o.revenue ? " на " + o.revenue + " ₽" : "") + ".\n" +
      "Осталось в очереди: " + left + ".\n\n" +
      (fs.existsSync(F.stop) ? "⚠️ Сработал автостоп: почта отказала в отправке. Сегодня не шлю, жду вашего решения.\n"
        : pct > 15 ? "⚠️ Недоставленных больше 15% — сегодня не шлю, разберусь с адресами и напишу.\n"
        : plan ? "Сегодня в 10:00 запускаю " + plan + " писем.\n" : "На сегодня партия не запланирована.\n") +
      "Ответы агентств лежат на сервере, спросите — покажу.";
    return mail("eSIM: рассылка агентствам — итог " + last.date + ", план на сегодня", text);
  }

  if (mode === "send") {
    const N = Number(nArg) || 0;
    if (!N) return console.log("нужно число");
    if (fs.existsSync(F.stop)) return mail("eSIM: рассылка агентствам на паузе (автостоп)", "Почта отказала в отправке, партию " + mskDate() + " не запускаю. Подробности в .esim/partner-mail-stop.json. Клиентские письма уходят как обычно.");
    if (last) { const s = batchStats(last); if (s.ok && s.bounce / s.ok > 0.15) return mail("eSIM: рассылка агентствам на паузе (недоставленные)", "У партии " + last.date + " не дошло " + s.bounce + " из " + s.ok + " — больше 15%. Сегодня не шлю, чтобы не портить репутацию ящика."); }
    const log = rj(F.log, {});
    const next = rj(F.queue, []).filter((x) => !log[String(x.email).toLowerCase()]).slice(0, N);
    if (!next.length) return mail("eSIM: рассылка агентствам завершена", "Очередь пуста — письма ушли всем агентствам.");
    const file = "partner-batch-" + mskDate() + ".json";
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
    return mail("eSIM: партия " + b.date + " агентствам ушла — " + s.ok + " из " + list.length,
      "Партия " + b.date + ": ушло " + s.ok + " из " + list.length + ", ошибок отправки " + s.err + "." +
      (fs.existsSync(F.stop) ? "\n⚠️ Сработал автостоп, остальное на паузе до вашего решения." : "") +
      (lost ? "\n(" + lost + " агентствам код выдан новый, их письма ушли без вложений с табличкой — некритично, QR есть в кабинете.)" : "") +
      "\nНедоставленные и ответы посчитаю завтра утром, итог пришлю до 10:00.");
  }
  console.log("режимы: report | send <N>");
})().catch((e) => { console.error("partner daily:", e.message); process.exit(1); });
