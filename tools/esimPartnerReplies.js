// Ответы агентств на письмо о партнёрке eSIM (17.11.2026). Андрей: «себе на почту не надо,
// складируй на сервере, потом спрошу». Читает ящик отправителя (SMTP_USER) по IMAP, берёт
// письма от адресов из журнала рассылки .esim/partner-mail.json или с темой письма-предложения
// и складывает в .esim/partner-replies.json. Письма в ящике не трогает (флаги не меняет).
// Поддержка eSIM (esimchat.js) читает тот же ящик, но берёт только темы с #номером чата.
//   cron: */30 * * * *  node tools/esimPartnerReplies.js
//   node tools/esimPartnerReplies.js --days 30   — перечитать за 30 дней
require("dotenv").config({ path: require("path").join(__dirname, "..", ".env"), quiet: true });
const fs = require("fs");
const path = require("path");
const DIR = path.join(__dirname, "..", ".esim");
const LOG = path.join(DIR, "partner-mail.json");
const OUT = path.join(DIR, "partner-replies.json");
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch (_) { return d; } };
const days = process.argv.includes("--days") ? Number(process.argv[process.argv.indexOf("--days") + 1]) : 3;

(async () => {
  const sent = readJson(LOG, {});
  const out = readJson(OUT, { items: [] });
  const have = new Set(out.items.map((x) => x.id));
  const { ImapFlow } = require("imapflow");
  const { simpleParser } = require("mailparser");
  const client = new ImapFlow({ host: process.env.IMAP_HOST || "imap.mail.ru", port: 993, secure: true,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }, logger: false,
    socketTimeout: 45000, greetingTimeout: 15000, connectionTimeout: 20000 });
  client.on("error", (e) => console.error("partner replies imap:", e.message));
  await client.connect();
  let added = 0;
  const lock = await client.getMailboxLock("INBOX");
  try {
    const uids = (await client.search({ since: new Date(Date.now() - days * 864e5) }, { uid: true })) || [];
    for (const uid of uids) {
      let env = null;
      for await (const h of client.fetch(String(uid), { envelope: true }, { uid: true })) env = h.envelope;
      if (!env) continue;
      const id = env.messageId || ("uid:" + uid);
      if (have.has(id)) continue;
      const from = String(((env.from || [])[0] || {}).address || "").toLowerCase();
      const subj = String(env.subject || "");
      const daemon = /mailer-daemon|postmaster/i.test(from);
      const ours = !!sent[from] || /увеличьте ваш доход|15% с каждой esim/i.test(subj) || daemon;
      if (!ours) continue;
      let raw = null;
      for await (const f of client.fetch(String(uid), { source: true }, { uid: true })) raw = f.source;
      const m = raw ? await simpleParser(raw) : {};
      if (daemon) {   // недоставленное: запоминаем, какой адрес из рассылки не дошёл
        const body = String(m.text || "") + " " + String(raw || "");
        const bad = Object.keys(sent).find((e) => body.toLowerCase().includes(e));
        if (!bad) continue;
        out.items.push({ id, at: env.date ? new Date(env.date).getTime() : Date.now(), from: bad, bounce: true,
          name: (sent[bad] || {}).name || null, code: (sent[bad] || {}).code || null, subject: subj.slice(0, 200), text: "" });
        have.add(id); added++;
        continue;
      }
      const text = String(m.text || "").split(/\n-{2,}\s*\n|\n>|\nОт: |\nFrom: |\n\d{1,2}\.\d{1,2}\.\d{2,4}.{0,40}(пишет|написал)/)[0].trim().slice(0, 4000);
      const s = sent[from] || {};
      out.items.push({ id, at: env.date ? new Date(env.date).getTime() : Date.now(), from, name: s.name || null,
        code: s.code || null, kind: s.kind || null, subject: subj.slice(0, 200), text,
        auto: /автоответ|auto.?reply|out of office|отпуск|undeliver|не доставлено|mailer-daemon/i.test(subj + " " + from) ||
          /обращение (получено|принято|зарегистрировано)|ваше письмо (получено|принято)|ответим (вам )?в течение|автоматическ(ий|ое) (ответ|сообщение)|не отвечайте на (это|данное) письмо|this is an automat|we have received your/i.test(text) });
      have.add(id); added++;
    }
  } finally { lock.release(); }
  await client.logout().catch(() => {});
  out.items.sort((a, b) => a.at - b.at);
  out.updatedAt = Date.now();
  fs.writeFileSync(OUT, JSON.stringify(out, null, 1), "utf8");
  console.log("новых ответов:", added, "всего:", out.items.length);
})().catch((e) => { console.error("partner replies:", e.message); process.exit(1); });
