// ─────────────────────────── Поддержка eSIM: чат и обращения ───────────────────────────
// На витрине две кнопки: «Оставить обращение» (форма) и «Написать в чат».
//
// Как это работает (Андрей, 22.09.2026):
//   • человек пишет в чат прямо на сайте, ему сразу отвечает автоответ;
//   • сообщение уходит письмом на director@, НО только в рабочее окно:
//     с понедельника 08:00 до пятницы 15:00 МСК, вне окна письмо ждёт;
//   • 28 сентября письма не уходят вовсе (ESIM_SUPPORT_BLACKOUT);
//   • Андрей отвечает ОБЫЧНЫМ ответом на письмо — мы читаем почтовый ящик по IMAP,
//     вырезаем цитату и подпись и показываем ответ человеку в чате.
//
// Хранилище: .esim/chats.json — [{ id, ts, page, ua, ip, contact, messages: [...] }],
// очередь писем: .esim/mailqueue.json.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const DIR = path.join(__dirname, ".esim");
const CHATS = path.join(DIR, "chats.json");
const QUEUE = path.join(DIR, "mailqueue.json");
const IMAP_STATE = path.join(DIR, "mailin.json");

const TO = process.env.ESIM_SUPPORT_TO || "director@visa-sc.ru";
const BLACKOUT = String(process.env.ESIM_SUPPORT_BLACKOUT || "2026-09-28").split(",").map((s) => s.trim()).filter(Boolean);
const AUTO_REPLY = process.env.ESIM_SUPPORT_AUTOREPLY ||
  "Спасибо, сообщение получено. Оператор уже занимается вашим вопросом — ответ придёт сюда же, в этот чат.";

function readJson(f, d) { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch (_) { return d; } }
function writeJson(f, d) {
  try { fs.mkdirSync(DIR, { recursive: true }); fs.writeFileSync(f, JSON.stringify(d, null, 1), "utf8"); }
  catch (e) { console.error("chat write:", e.message); }
}
const msk = (ts) => new Date((ts || Date.now()) + 3 * 3600e3);          // время в МСК
const mskDay = (ts) => msk(ts).toISOString().slice(0, 10);
const esc = (s) => String(s == null ? "" : s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));

// ── рабочее окно писем: пн 08:00 → пт 15:00 МСК, без «чёрных» дат ──
function mailWindowOpen(ts) {
  const d = msk(ts);
  if (BLACKOUT.indexOf(d.toISOString().slice(0, 10)) >= 0) return false;
  const day = d.getUTCDay();                 // 0 — воскресенье
  const hour = d.getUTCHours() + d.getUTCMinutes() / 60;
  if (day === 0 || day === 6) return false;                       // выходные
  if (day === 1 && hour < 8) return false;                        // до понедельника 08:00
  if (day === 5 && hour >= 15) return false;                      // после пятницы 15:00
  return true;
}

// ── очередь писем: вне окна копим, внутри отправляем ──
function queueMail(mail) {
  const q = readJson(QUEUE, []);
  q.push(Object.assign({ id: crypto.randomBytes(4).toString("hex"), ts: Date.now() }, mail));
  writeJson(QUEUE, q.slice(-500));
}
async function flushQueue(sendMail) {
  if (!sendMail) return 0;
  const q = readJson(QUEUE, []);
  if (!q.length || !mailWindowOpen()) return 0;
  const rest = [];
  let sent = 0;
  for (const m of q) {
    const r = await sendMail({ to: m.to || TO, subject: m.subject, text: m.text, replyTo: m.replyTo }).catch(() => ({ ok: false }));
    if (r && r.ok !== false) sent++; else rest.push(m);
    await new Promise((r2) => setTimeout(r2, 300));
  }
  writeJson(QUEUE, rest);
  if (sent) console.log("esim support: отправлено писем из очереди", sent);
  return sent;
}

// ── чаты ──
function loadChats() { return readJson(CHATS, []); }
function saveChats(list) { writeJson(CHATS, list.slice(0, 3000)); }
function findChat(id) { return loadChats().find((c) => c.id === String(id || "")); }

function newChatId() { return crypto.randomBytes(4).toString("hex"); }

// Сообщение от клиента: кладём в чат, отвечаем автоответом, письмо — в очередь
function clientMessage({ id, text, page, ua, ip, contact }) {
  const list = loadChats();
  let chat = list.find((c) => c.id === id);
  if (!chat) {
    chat = { id: id || newChatId(), ts: Date.now(), page: String(page || "").slice(0, 200),
      ua: String(ua || "").slice(0, 200), ip: ip || null, contact: null, messages: [] };
    list.unshift(chat);
  }
  if (contact) chat.contact = String(contact).slice(0, 120);
  const clean = String(text || "").slice(0, 4000).trim();
  if (!clean) return null;
  // Автоответ в чате Андрей убрал 22.09.2026 — человек пишет, ответ даёт оператор
  chat.messages.push({ from: "client", text: clean, ts: Date.now() });
  chat.lastAt = Date.now();
  saveChats(list);

  queueMail({
    subject: "VOYO eSIM: сообщение из чата #" + chat.id,
    text: "Человек пишет в чат на сайте.\n\n" +
      clean + "\n\n" +
      "— — —\n" +
      "Чтобы ответить, просто ответьте на это письмо: текст ответа увидит человек в чате.\n" +
      "Цитату и подпись мы вырежем сами.\n\n" +
      "Страница: " + (chat.page || "—") + "\n" +
      (chat.contact ? "Контакт: " + chat.contact + "\n" : "") +
      "Чат: " + chat.id,
  });
  return chat;
}

// Ответ оператора (из письма или из панели)
function operatorMessage(id, text) {
  const list = loadChats();
  const chat = list.find((c) => c.id === String(id || ""));
  if (!chat) return null;
  const clean = String(text || "").slice(0, 4000).trim();
  if (!clean) return null;
  chat.messages.push({ from: "operator", text: clean, ts: Date.now() });
  chat.lastAt = Date.now();
  saveChats(list);
  console.log("esim support: ответ оператора в чат", chat.id);
  return chat;
}

// ── разбор ответа из письма: убираем цитату и подпись ──
function stripReply(raw) {
  const lines = String(raw || "").replace(/\r/g, "").split("\n");
  const out = [];
  for (const line of lines) {
    if (/^\s*>/.test(line)) break;                                   // цитата
    if (/^\s*--\s*$/.test(line)) break;                              // подпись
    if (/^\s*(On .+ wrote:|.*\b\d{1,2}\s+\S+\s+\d{4}.*(пишет|wrote):)\s*$/i.test(line)) break;
    if (/^\s*(От|From|Кому|To|Отправлено|Sent|Тема|Subject)\s*:/i.test(line)) break;
    if (/^-{3,}\s*(Исходное сообщение|Original Message)/i.test(line)) break;
    out.push(line);
  }
  return out.join("\n").trim();
}

// ── чтение ответов из почтового ящика ──
// Соединение с mail.ru иногда рвётся по таймауту, и imapflow кидает 'error'
// в процесс — без своего обработчика это уронило бы весь сервер. Поэтому:
// свой таймаут, свой обработчик ошибок и мягкое закрытие.
let _imapBusy = false;
async function pollMailbox() {
  if (_imapBusy) return 0;
  const user = process.env.SMTP_USER, pass = process.env.SMTP_PASS;
  if (!user || !pass) return 0;
  _imapBusy = true;
  let done = 0;
  let client = null;
  try {
    const { ImapFlow } = require("imapflow");
    const { simpleParser } = require("mailparser");
    client = new ImapFlow({
      host: process.env.IMAP_HOST || "imap.mail.ru", port: 993, secure: true,
      auth: { user, pass }, logger: false, emitLogs: false,
      socketTimeout: 45000, greetingTimeout: 15000, connectionTimeout: 20000,
    });
    client.on("error", (e) => console.error("esim support imap:", e.message));
    await client.connect();
    const lock = await client.getMailboxLock("INBOX");
    try {
      const state = readJson(IMAP_STATE, { ids: [] });
      const ids = new Set(state.ids || []);
      // берём только непрочитанные и только заголовки — письмо целиком тянем,
      // лишь когда в теме есть номер чата
      // ищем по дате, а не по «непрочитанным»: если письмо уже пометили прочитанным
      // (например, сорвалась прошлая попытка), ответ всё равно дойдёт — повторы
      // отсекаем по Message-ID
      const since = new Date(Date.now() - 3 * 864e5);
      const uids = (await client.search({ since }, { uid: true })) || [];   // именно UID, не номера
      for (const uid of uids.slice(-30)) {
        let subject = "", mid = "";
        for await (const head of client.fetch(String(uid), { envelope: true }, { uid: true })) {
          subject = (head.envelope && head.envelope.subject) || "";
          mid = (head.envelope && head.envelope.messageId) || ("uid:" + uid);
        }
        const m = /#([0-9a-f]{6,12})/i.exec(subject);
        if (!m) continue;                                       // чужое письмо — не трогаем
        await client.messageFlagsAdd({ uid: String(uid) }, ["\\Seen"], { uid: true }).catch(() => {});
        if (ids.has(mid)) continue;                             // это письмо уже разбирали
        ids.add(mid);
        let raw = null;
        for await (const full of client.fetch(String(uid), { source: true }, { uid: true })) raw = full.source;
        if (!raw) continue;
        const parsed = await simpleParser(raw);
        const body2 = stripReply(parsed.text || "");
        if (body2) { operatorMessage(m[1], body2); done++; }
      }
      writeJson(IMAP_STATE, { ids: Array.from(ids).slice(-1000) });
    } finally { lock.release(); }
  } catch (e) {
    console.error("esim support imap:", e.message);
  } finally {
    try { if (client) await client.logout(); } catch (_) { try { client && client.close(); } catch (__) {} }
    _imapBusy = false;
  }
  if (done) console.log("esim support: ответов из почты", done);
  return done;
}

module.exports = { mailWindowOpen, queueMail, flushQueue, loadChats, findChat, newChatId,
  clientMessage, operatorMessage, stripReply, pollMailbox, esc, mskDay, TO, AUTO_REPLY, BLACKOUT };
