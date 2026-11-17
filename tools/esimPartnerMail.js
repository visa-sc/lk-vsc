// Письмо агентствам: «продавайте eSIM своим клиентам и зарабатывайте 15%» (17.11.2026).
// Каждому агентству свой код, ссылки на сайт и Telegram-бот, кабинет (заводит
// tools/esimPartnersAdd.js) и вложения: QR-код и табличка на стойку A5 из папки
// .esim/partner-kit/<КОД>/ (рисуются на маке скриптом mk_kit.py, на сервере нет PIL).
//
//   node tools/esimPartnerMail.js test <почта> <партнёры.json> [номер]  — образец на свой адрес
//   node tools/esimPartnerMail.js send <партнёры.json> [--limit N]      — боевая рассылка
//
// Боевая: по одному письму раз в 75 секунд (mail.ru режет пачки), журнал отправленных
// .esim/partner-mail.json — повторно тому же адресу не уйдёт, можно перезапускать.
// Ответы приходят на ящик отправителя и складываются в .esim/partner-replies.json (tools/esimPartnerReplies.js). Без длинных тире: правило клиентских текстов.
require("dotenv").config({ path: require("path").join(__dirname, "..", ".env"), quiet: true });
const fs = require("fs");
const path = require("path");
const { sendMail } = require("../mail.js");

const LOG = path.join(__dirname, "..", ".esim", "partner-mail.json");
const KIT = path.join(__dirname, "..", ".esim", "partner-kit");
const DIR_ESIM = path.join(__dirname, "..", ".esim");
const REPLY = process.env.SMTP_USER || "noreply@voyotravel.ru";   // ответы агентств складывает tools/esimPartnerReplies.js (Андрей 17.11: себе на почту не надо)
const BOT = process.env.ESIM_TG_USERNAME || "esimvoyo_bot";
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const RU = (n) => Math.round(n).toLocaleString("ru-RU").replace(/ /g, " ");

// живые цены «от» по популярным направлениям (1 ГБ и больше, не суточные) и число стран
async function livePrices() {
  const r = await fetch("http://127.0.0.1:" + (process.env.PORT || 3000) + "/esim/api/catalog", { headers: { host: "voyomobile.ru" } });
  const all = (await r.json()).products || [];
  const one = (cc) => all.filter((p) => p.countries.length === 1 && p.countries[0] === cc && p.dataGb >= 1 && !p.daily)
    .sort((a, b) => a.priceRub - b.priceRub)[0];
  const eu = all.filter((p) => p.countries.length >= 30 && p.countries.includes("FR") && p.dataGb >= 1 && !p.daily)
    .sort((a, b) => a.priceRub - b.priceRub)[0];
  const row = (name, p) => p ? { name, price: p.priceRub } : null;
  const rows = [row("Турция", one("TR")), row("Европа", eu), row("Таиланд", one("TH")), row("ОАЭ", one("AE"))].filter(Boolean);
  const cc = new Set(); all.forEach((p) => p.countries.forEach((c) => cc.add(c)));
  rows.total = cc.size;
  return rows;
}

// «ещё 207 стран» — с правильным окончанием
function stran(n) { const a = n % 100, b = n % 10; return n + " " + (a > 10 && a < 20 ? "стран" : b === 1 ? "страна" : b > 1 && b < 5 ? "страны" : "стран"); }

function build(p, pr) {
  const visa = /виз/i.test(String(p.kind || ""));
  const tg = "https://t.me/" + BOT + "?start=p_" + String(p.code).toLowerCase();
  const subject = "Увеличьте ваш доход: 15% с каждой eSIM ваших клиентов";
  const C = { ink: "#16202e", mut: "#6e7c91", line: "#e6ebf2", acc: "#2c6f96", bg: "#f4f7fb", green: "#2a8f6a" };
  // плитки одного размера: фиксированная высота, всё по центру
  const tile = (ico, t) => '<td width="50%" valign="top" style="padding:5px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#fff;border:1px solid ' + C.line + ';border-radius:14px"><tr><td align="center" valign="middle" height="104" style="height:104px;padding:10px 12px;text-align:center;font-size:14px;line-height:1.35;color:' + C.ink + ';font-weight:600"><div style="font-size:22px;line-height:1;margin:0 0 8px">' + ico + "</div>" + t + "</td></tr></table></td>";
  const row = (k, v, hint) => '<tr><td align="center" style="padding:0 0 16px;text-align:center"><div style="font-size:13px;color:' + C.mut + ';margin:0 0 5px">' + k + "</div>" + v +
    (hint ? '<div style="font-size:13px;color:' + C.mut + ';margin:5px 0 0">' + hint + "</div>" : "") + "</td></tr>";
  const link = (href, txt) => '<a href="' + esc(href) + '" style="font-size:15px;color:' + C.acc + ';word-break:break-word">' + esc(txt) + "</a>";
  const prices = pr.map((x) => '<span style="white-space:nowrap">' + esc(x.name) + " <b>от " + RU(x.price) + " ₽</b></span>").join('<span style="color:' + C.mut + '"> · </span>');
  const more = pr.total ? pr.total - pr.length : 207;

  const html = '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>' +
  '<body style="margin:0;padding:0;background:' + C.bg + ';font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Arial,sans-serif">' +
  '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:' + C.bg + '"><tr><td align="center" style="padding:24px 12px">' +
  '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px">' +
  // логотип по центру, картинкой как в шапке voyomobile.ru
  '<tr><td align="center" style="padding:2px 4px 18px"><a href="https://voyomobile.ru"><img src="https://voyomobile.ru/voyo-mobile-logo.png" alt="VOYO mobile" width="158" height="23" style="display:block;width:158px;height:23px;border:0;margin:0 auto"></a></td></tr>' +
  // первый экран по центру
  '<tr><td style="padding:0 0 10px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-radius:18px;background:#2c6f96;background-image:linear-gradient(135deg,#4aa3d4,#2c6f96)"><tr><td align="center" style="padding:28px 24px;color:#fff;text-align:center">' +
  '<div style="font-size:29px;line-height:1.2;font-weight:700;margin:0 0 8px">Увеличьте ваш доход</div>' +
  '<div style="font-size:19px;line-height:1.3;font-weight:600;margin:0 0 12px;opacity:.95">15% с каждой eSIM ваших клиентов</div>' +
  '<div style="font-size:15px;line-height:1.5;opacity:.92">' + (visa ? "Клиент получил визу, далее ему нужен интернет в поездке." : "Туристу в поездке нужен интернет.") +
  " Дайте ему ваш промокод: клиенту −100 ₽, вам 15% со всех его покупок, бессрочно.</div>" +
  "</td></tr></table></td></tr>" +
  // плитки как на сайте, одного размера
  '<tr><td style="padding:0 0 8px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="table-layout:fixed">' +
  "<tr>" + tile("⚡", "QR-код через 1 секунду,<br>установка за минуту") + tile("💳", "Оплата российской<br>картой и СБП") + "</tr>" +
  "<tr>" + tile("💬", "Поддержка на русском,<br>чат и Telegram") + tile("⭐", "5,0 · 1 325 оценок") + "</tr>" +
  "</table></td></tr>" +
  // страны и цены по центру, ниже «ещё 207 стран»
  '<tr><td align="center" style="padding:8px 6px 4px;text-align:center;font-size:15px;line-height:1.7;color:' + C.ink + '">' + prices + "</td></tr>" +
  '<tr><td align="center" style="padding:6px 0 14px;text-align:center"><span style="display:inline-block;background:#e8f2f9;color:' + C.acc + ';font-weight:700;font-size:15px;padding:7px 16px;border-radius:999px">и ещё ' + stran(more) + "</span></td></tr>" +
  // как начисляется
  '<tr><td style="padding:0 0 14px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#eaf6f0;border-radius:16px"><tr><td align="center" style="padding:16px 20px;text-align:center;font-size:15px;line-height:1.5;color:' + C.ink + '">' +
  '<div style="font-size:22px;font-weight:700;color:' + C.green + ';margin:0 0 4px">15% бессрочно</div>' +
  "С первой и со всех следующих покупок клиента, даже если промокод он больше не вводит. Выплаты раз в месяц.</td></tr></table></td></tr>" +
  // начать пользоваться
  '<tr><td style="padding:0 0 10px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#fff;border:2px solid #4aa3d4;border-radius:18px"><tr><td align="center" style="padding:24px 20px 8px;text-align:center">' +
  '<div style="font-size:21px;font-weight:700;color:' + C.ink + ';margin:0 0 4px">Начать пользоваться</div>' +
  '<div style="font-size:14px;color:' + C.mut + ';margin:0 0 18px">Всё уже работает, ничего заполнять не нужно.</div>' +
  '<table role="presentation" width="100%" cellpadding="0" cellspacing="0">' +
    row("Ваш промокод", '<span style="display:inline-block;font-family:Menlo,Consolas,monospace;font-weight:700;font-size:19px;letter-spacing:1px;background:' + C.bg + ';padding:7px 14px;border-radius:9px;color:' + C.ink + '">' + esc(p.code) + "</span>", "Клиент вводит его при оплате, скидка 100 ₽.") +
    row("Ссылка на сайт", link(p.link, p.link.replace(/^https:\/\//, "")), "Промокод в ссылке уже есть: отправьте с документами или в мессенджер.") +
    row("Ссылка на Telegram-бот", link(tg, tg.replace(/^https:\/\//, "")), "Для тех, кому удобнее купить прямо в Telegram.") +
    row("QR-код для стойки", '<div style="font-size:15px;color:' + C.ink + '">📎 Во вложении: табличка A5 для печати и QR-код, оба в PDF.</div>') +
  "</table>" +
  '<div style="padding:2px 0 20px"><a href="' + esc(p.cabinetAuto) + '" style="display:inline-block;background:#2c6f96;background-image:linear-gradient(135deg,#4aa3d4,#2c6f96);color:#fff;text-decoration:none;font-weight:600;font-size:15px;padding:13px 22px;border-radius:12px">Мой кабинет: клиенты и начисления</a>' +
  '<div style="font-size:13px;color:' + C.mut + ';margin:8px 0 0">' + esc(p.cabinet.replace(/^https:\/\//, "")) + ", пароль " + esc(p.pass) + "</div></div>" +
  "</td></tr></table></td></tr>" +
  '<tr><td align="center" style="padding:14px 6px 0;text-align:center;font-size:11px;line-height:1.4;color:#9aa3b3">Данный email не является регулярной email-рассылкой.</td></tr>' +
  "</table></td></tr></table></body></html>";

  const text = [
    "Увеличьте ваш доход", "15% с каждой eSIM ваших клиентов",
    (visa ? "Клиент получил визу, далее ему нужен интернет в поездке." : "Туристу в поездке нужен интернет.") + " Дайте ему ваш промокод: клиенту −100 ₽, вам 15% со всех его покупок, бессрочно.",
    "", "QR-код через 1 секунду · оплата картой и СБП · поддержка на русском · 5,0, 1 325 оценок",
    pr.map((x) => x.name + " от " + RU(x.price) + " ₽").join(" · ") + ", и ещё " + stran(more),
    "", "15% бессрочно: с первой и со всех следующих покупок клиента. Выплаты раз в месяц.",
    "", "Начать пользоваться (всё уже работает):", "Промокод: " + p.code + " (клиенту −100 ₽)", "Ссылка на сайт: " + p.link, "Ссылка на Telegram-бот: " + tg,
    "QR-код для стойки: во вложении (табличка A5 и QR-код в PDF).", "Кабинет: " + p.cabinet + ", пароль " + p.pass,
    "", "Данный email не является регулярной email-рассылкой.",
  ].join("\n");
  const dir = path.join(KIT, String(p.code));
  const attachments = [["tablichka-voyo-mobile-A5.pdf", "Табличка VOYO mobile A5.pdf"], ["qr-voyo-mobile.pdf", "QR-код VOYO mobile.pdf"]]
    .filter(([f]) => fs.existsSync(path.join(dir, f))).map(([f, name]) => ({ filename: name, path: path.join(dir, f) }));
  return { subject, html, text, attachments };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const [mode, a1, a2, a3] = process.argv.slice(2);
  if (mode !== "test" && mode !== "send") return console.log("режимы: test <почта> <партнёры.json> [номер] | send <партнёры.json> [--limit N]");
  const pr = await livePrices();
  if (mode === "test") {
    const p = JSON.parse(fs.readFileSync(a2, "utf8"))[Number(a3 || 0)];
    const L = build(p, pr);
    const r = await sendMail({ to: a1, subject: "[ОБРАЗЕЦ] " + L.subject, html: L.html, text: L.text, attachments: L.attachments, replyTo: REPLY, fromName: "VOYO mobile" });
    console.log(r.ok ? "образец отправлен на " + a1 + ", вложений " + L.attachments.length : r.error);
    return;
  }
  const list = JSON.parse(fs.readFileSync(a1, "utf8"));
  const lim = process.argv.includes("--limit") ? Number(process.argv[process.argv.indexOf("--limit") + 1]) : Infinity;
  const log = fs.existsSync(LOG) ? JSON.parse(fs.readFileSync(LOG, "utf8")) : {};
  let n = 0, errRun = 0;
  for (const p of list) {
    const to = String(p.email || "").trim().toLowerCase();
    if (!to || log[to]) continue;
    if (n >= lim) break;
    const L = build(p, pr);
    const r = await sendMail({ to, subject: L.subject, html: L.html, text: L.text, attachments: L.attachments, replyTo: REPLY, fromName: "VOYO mobile" });
    log[to] = { at: Date.now(), ok: !!r.ok, err: r.ok ? null : r.error, code: p.code, name: p.name, kind: p.kind || null };
    fs.writeFileSync(LOG, JSON.stringify(log, null, 1), "utf8");
    console.log(new Date().toISOString().slice(11, 19), r.ok ? "ok " : "ERR", to, r.ok ? "" : r.error);
    n++;
    // Автостоп (Андрей 17.11): почта отказала по лимиту/спаму или две ошибки подряд — встаём,
    // чтобы не задеть клиентские письма с этого же ящика (QR eSIM)
    errRun = r.ok ? 0 : errRun + 1;
    if (!r.ok && (/spam|limit|rate|block|quota|too many|421|451|452|550 5\.7|554/i.test(String(r.error)) || errRun >= 2)) {
      console.log("АВТОСТОП: почта отказывает —", r.error);
      fs.writeFileSync(path.join(DIR_ESIM, "partner-mail-stop.json"), JSON.stringify({ at: Date.now(), error: String(r.error), to }), "utf8");
      break;
    }
    if (n < lim) await sleep(Number(process.env.PARTNER_MAIL_GAP_MS) || 75000);   // интервал задаёт esimPartnerDaily.js
  }
  console.log("отправлено:", n);
})();
