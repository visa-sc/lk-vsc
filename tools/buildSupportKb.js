#!/usr/bin/env node
// База опыта поддержки eSIM (12.10.2026, просьба Андрея: «собери базу из всех
// обращений и пусть бот по ней ориентируется»).
//
// Берёт все обращения — чаты на сайте и в боте, формы «не получается подключить»,
// планы операторов и возвраты — и просит модель выжать из них типовые ситуации:
// что было у человека, что оказалось на самом деле, как правильно ответить и
// чего не делать. Имён, почт и телефонов в базе нет. Результат — .esim/support-kb.md,
// его подклеивает к инструкции esimdoctor.js. Раз в неделю по cron.
//   node tools/buildSupportKb.js [--dry]
require("dotenv").config({ quiet: true, path: require("path").join(__dirname, "..", ".env") });
const fs = require("fs");
const path = require("path");
const DIR = path.join(__dirname, "..", ".esim");
const read = (f, d) => { try { return JSON.parse(fs.readFileSync(path.join(DIR, f), "utf8")); } catch (_) { return d; } };
const TEST = /@example\.com|komizarenko@gmail|ap@spt1|director@visa-sc|79959189058|79826404543|test-(bot|check)@/i;
// убираем из текстов то, что указывает на человека
const scrub = (s) => String(s || "")
  .replace(/[^\s@]+@[^\s@]+\.[a-z]{2,}/gi, "[почта]")
  .replace(/\+?\d[\d\s()-]{8,}\d/g, "[телефон]")
  .replace(/https?:\/\/\S+/g, "[ссылка]")
  .replace(/\s+/g, " ").trim();

const chats = read("chats.json", []).filter((c) => (c.messages || []).some((m) => m.from === "client") && !TEST.test(String(c.contact || "")));
const forms = read("help.json", []).filter((h) => !TEST.test(String(h.contact || "")));
const plans = read("caseplans.json", []);
const refunds = read("refunds.json", []);

const blocks = [];
chats.forEach((c) => {
  const lines = (c.messages || []).filter((m) => !/^Ваше сообщение получено/.test(m.text))
    .slice(-30).map((m) => (m.from === "client" ? "Клиент" : m.from === "operator" ? "Оператор" : "Бот") + ": " + scrub(m.text).slice(0, 700));
  if (lines.length) blocks.push("ЧАТ (" + (c.tgChatId ? "телеграм-бот" : "сайт") + ")\n" + lines.join("\n"));
});
forms.forEach((h) => {
  blocks.push("ФОРМА «не получается подключить»: телефон " + scrub(h.model) + "; пробовал: " + scrub(h.tried) +
    "; что происходит: " + scrub(h.error).slice(0, 500) + (h.result === "ok" ? "; итог: человек отметил «всё заработало»" : "") +
    (h.refundAsked ? "; человек просил возврат" : ""));
});
plans.forEach((p) => blocks.push("РЕШЕНИЕ ОПЕРАТОРА: вид «" + p.kind + "», итог: " + (p.result || "в работе") + (p.refund ? "; возврат у поставщика: " + scrub(p.refund) : "")));
refunds.forEach((r) => blocks.push("ВОЗВРАТ ДЕНЕГ: " + (r.kind === "card" ? "на карту" : "на баланс") + " " + r.rub + " ₽ за «" + scrub(r.label) + "» (" + scrub(r.note) + ")"));

// уроки, которые уже разобраны с Андреем вручную
const MANUAL = `
УРОКИ, РАЗОБРАННЫЕ ВРУЧНУЮ:
- Две eSIM, одна для спутника: смотреть устройства в досье. Если вторая на другом устройстве — она у спутника, ей нужно только включить линию, мобильные данные и роуминг данных. Нельзя говорить «обе у вас» и предлагать купить ещё одну (08.10.2026 так ответили — клиент потребовал возврат, вернули деньги и извинились бонусом).
- Роуминг данных на линии НАШЕЙ eSIM включать обязательно (на iPhone он выключен по умолчанию); на основной линии — выключить. Нельзя писать, что роуминг на нашей eSIM трогать не нужно.
- «Можно оплатить через Сбербанк?» — да: картой любого банка или через СБП из приложения банка. Т-Банк только принимает платёж.
- Человек часто пишет до оплаты, а потом сразу платит: проверяй по досье, нет ли уже покупки, и отвечай по ней (где QR, что дальше).
- Неиспользованная eSIM не сгорает до даты в досье; срок начинается в поездке. Это снимает многие просьбы о возврате.
- Если человек требует деньги — не обещать и не спорить: передать оператору. Возврат сначала предлагаем на баланс VOYO mobile, на карту — если человек попросит.
`;

(async () => {
  const corpus = blocks.join("\n\n").slice(0, 120000);
  console.log("обращений и записей:", blocks.length, "| объём текста:", corpus.length);
  if (process.argv.includes("--dry")) { console.log(corpus.slice(0, 3000)); return; }
  const { Anthropic } = require("@anthropic-ai/sdk");
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, baseURL: process.env.ANTHROPIC_BASE_URL || undefined, timeout: 600000 });
  const stream = client.messages.stream({
    model: process.env.ESIM_DOCTOR_MODEL || "claude-opus-5-5", max_tokens: 16000, output_config: { effort: "high" },
    system: "Ты старший специалист поддержки VOYO mobile (eSIM для поездок). Тебе дают все прошлые обращения клиентов. " +
      "Собери из них базу опыта для робота-поддержки: короткий справочник по-русски, без воды, без имён, почт, телефонов и номеров заказов. " +
      "Формат — разделы по типовым ситуациям. В каждом: «Как выглядит» (что пишет человек), «Что проверить» (что смотреть в досье), " +
      "«Как ответить» (суть правильного ответа, 1–4 пункта), «Чего не делать» (ошибки, которые уже случались). " +
      "Опирайся только на реальные обращения ниже и на уроки, разобранные вручную. Объём — до 1500 слов. Длинные тире не используй. " +
      "Справочник читает робот: он сам не может начислять бонусы, возвращать деньги и выпускать новые eSIM — это делает оператор. Поэтому в «Как ответить» не пиши «начислите», «верните», «выпустите»: пиши, что робот передаёт это оператору, и ничего не обещает от себя.",
    messages: [{ role: "user", content: corpus + "\n\n" + MANUAL }],
  });
  const msg = await stream.finalMessage();
  const text = msg.content.filter((b) => b.type === "text").map((b) => b.text).join("").trim();
  if (text.length < 300) throw new Error("слишком короткий ответ модели");
  const out = "<!-- собрано " + new Date().toISOString().slice(0, 10) + " из " + blocks.length + " обращений, tools/buildSupportKb.js -->\n" + text.replace(/[—–]/g, "-") + "\n" + MANUAL;
  fs.writeFileSync(path.join(DIR, "support-kb.md"), out);
  const u = msg.usage || {};
  console.log("готово:", out.length, "символов | токены: вход", u.input_tokens, "выход", u.output_tokens,
    "| ≈ $" + (((u.input_tokens || 0) * 4 + (u.output_tokens || 0) * 20) / 1e6).toFixed(3));
})().catch((e) => { console.error("ошибка:", e.message); process.exit(1); });
