// ─────────────── Поддержка eSIM: разбор проблемы человека головой, а не шаблоном ───────────────
// Андрей 29.09.2026: «сделай, чтобы возврата не было, чтобы проблему решали».
//
// Как работает. Когда человек пишет в чат, сервер уже знает про него всё: какие
// пакеты он покупал, что говорит о них поставщик прямо сейчас (скачан ли профиль,
// вышел ли в сеть, сколько трафика осталось, не истёк ли срок), с какого телефона
// он пишет и из какой страны. Это досье уходит модели вместе с историей переписки,
// и она возвращает: диагноз, готовый ответ человеку и что сделать нам.
//
// Жёсткие рамки, которые модель не может обойти:
//   • про возврат в ответе не пишем, пока сервер сам не решит, что пора;
//   • факты только из досье, ничего не выдумываем;
//   • длинные тире вырезаем (правило Андрея по клиентским текстам).

const ALLOWED = ["advice", "replace", "escalate"];

function aiOn() {
  return Boolean(process.env.ANTHROPIC_API_KEY) && String(process.env.ESIM_DOCTOR || "1") !== "0";
}
function modelName() { return process.env.ESIM_DOCTOR_MODEL || "claude-sonnet-5"; }

let _client = null;
function client() {
  if (!aiOn()) return null;
  if (_client) return _client;
  const { Anthropic } = require("@anthropic-ai/sdk");
  const opts = {
    apiKey: process.env.ANTHROPIC_API_KEY,
    baseURL: process.env.ANTHROPIC_BASE_URL || undefined,
    timeout: 90 * 1000, maxRetries: 1,
  };
  if (process.env.TRANSLATE_PROXY) {
    const undici = require("undici");
    opts.fetch = undici.fetch;
    opts.fetchOptions = { dispatcher: new undici.ProxyAgent(process.env.TRANSLATE_PROXY) };
  }
  _client = new Anthropic(opts);
  return _client;
}

const SYSTEM = `Ты оператор поддержки VOYO mobile. Мы продаём eSIM для поездок.
Тебе дают досье: что человек написал, какие у него пакеты и что о них говорит поставщик прямо сейчас.

Твоя работа: понять, из-за чего у человека нет интернета, и написать ему, что делать. Коротко, по шагам, на «вы», без воды.

Правила:
1. Опирайся только на досье. Не придумывай остатки, даты и статусы, которых там нет.
2. Если из досье видно причину, назови её прямо в первой строке: человек должен понять, что мы посмотрели именно его случай.
3. Шаги давай в том порядке, в котором они реально помогают. Не больше шести.
4. Не предлагай возврат денег и не обещай его. Об этом решает сервер, не ты.
5. Не пиши «обратитесь к оператору»: оператор это ты.
6. Никаких длинных тире в тексте ответа.
7. Пиши так, как пишет живой человек, который только что посмотрел данные. Без канцелярита и без извинений на каждой строке.

Типовые причины, которые стоит проверять по досье:
• профиль не скачан на телефон: человек не дошёл до установки или ошибка при скачивании;
• профиль скачан, но не активирован: телефон не зарегистрировался в сети. Частая причина, когда у человека несколько наших eSIM и включены сразу две: телефон держится за старую линию;
• линия выключена, не выбрана для сотовых данных, выключен роуминг данных;
• трафик израсходован или срок пакета истёк: нужен новый пакет или продление;
• пакет приостановлен у поставщика: это чиним мы сами, человека настройками не мучаем;
• телефон без eSIM или залочен под оператора: проверяется строкой EID в «Об этом устройстве».

Ответ верни строго в JSON:
{"diagnosis": "одна фраза для нас, что происходит",
 "reply": "текст для человека",
 "action": "advice | replace | escalate",
 "why": "почему выбрал это действие"}

action:
• advice, если человек может починить сам по твоим шагам;
• replace, если пакет у поставщика явно нерабочий или человек уже пробовал настройки и не вышло: мы выдадим ему eSIM другого оператора за наш счёт. В reply тогда напиши, что высылаем другую eSIM, и коротко как её поставить;
• escalate, только если данных не хватает и нужен живой оператор.`;

// ── досье по человеку ──
function dossier({ messages, orders, states, ua, ip, country, tried }) {
  const L = [];
  L.push("ПЕРЕПИСКА (последние сообщения):");
  (messages || []).slice(-10).forEach((m) => {
    const who = m.from === "client" ? "человек" : (m.from === "operator" ? "оператор" : "наш автоответ");
    L.push("  [" + who + "] " + String(m.text || "").slice(0, 500));
  });
  L.push("");
  L.push("ЕГО ПАКЕТЫ И ЧТО ГОВОРИТ ПОСТАВЩИК СЕЙЧАС:");
  if (!states || !states.length) L.push("  покупок у нас не нашли");
  (states || []).forEach((s, i) => {
    const o = s.o || {};
    const packs = (s.u && s.u.packages) || [];
    const p = packs[0] || {};
    L.push("  " + (i + 1) + ") " + (o.label || "eSIM") +
      ", куплен " + new Date(o.paidAt || o.ts || Date.now()).toLocaleDateString("ru-RU") +
      ", поставщик " + (o.src || "?"));
    L.push("     профиль скачан на телефон: " + (s.installed ? "да" : "нет") +
      "; вышел в сеть: " + (s.active ? "да, " + (p.activatedAt || "") : "нет") +
      "; трафик: " + Math.round(s.total - s.left) + " из " + Math.round(s.total) + " МБ" +
      "; срок: " + (p.expiresAt ? "до " + String(p.expiresAt).slice(0, 10) : "не начался") +
      (s.expired ? "; ПАКЕТ ИСТЁК" : "") +
      (s.u && s.u.suspended ? "; ПРИОСТАНОВЛЕН У ПОСТАВЩИКА" : ""));
  });
  L.push("");
  L.push("ТЕЛЕФОН И МЕСТО: " + (ua || "неизвестно").slice(0, 160) + (country ? "; страна по адресу: " + country : ""));
  if (tried && tried.length) L.push("МЫ УЖЕ ПРОБОВАЛИ: " + tried.join("; "));
  return L.join("\n");
}

// длинные тире выдают машину, в клиентских текстах их быть не должно
function clean(text) {
  return String(text || "")
    .replace(/\s+[—–]\s+/g, ", ")
    .replace(/[—–]/g, "-")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
// страховка от обещаний возврата раньше времени
function hasRefundTalk(text) {
  return /верн[её]м деньги|возврат|вернуть деньги|деньги обратно/i.test(String(text || ""));
}

async function diagnose(info) {
  const c = client();
  if (!c) return null;
  const body = dossier(info);
  const msg = await c.messages.create({
    model: modelName(), max_tokens: 1200, system: SYSTEM,
    messages: [{ role: "user", content: body }],
  });
  let text = "";
  for (const b of msg.content || []) if (b.type === "text") text += b.text;
  const m = /\{[\s\S]*\}/.exec(text);
  if (!m) return null;
  let out;
  try { out = JSON.parse(m[0]); } catch (_) { return null; }
  if (!out || !out.reply) return null;
  out.reply = clean(out.reply);
  out.action = ALLOWED.indexOf(String(out.action || "")) >= 0 ? out.action : "advice";
  // про возврат решает сервер: если модель всё же написала — убираем абзац
  if (hasRefundTalk(out.reply) && !info.refundAllowed) {
    out.reply = out.reply.split(/\n\n/).filter((p) => !hasRefundTalk(p)).join("\n\n").trim();
    if (!out.reply) return null;
  }
  out.usage = msg.usage || null;
  out.model = modelName();
  return out;
}

module.exports = { aiOn, diagnose, dossier, clean };
