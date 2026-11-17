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
// Ответы приходят на director@visa-sc.ru. Без длинных тире: правило клиентских текстов.
require("dotenv").config({ path: require("path").join(__dirname, "..", ".env"), quiet: true });
const fs = require("fs");
const path = require("path");
const { sendMail } = require("../mail.js");

const LOG = path.join(__dirname, "..", ".esim", "partner-mail.json");
const KIT = path.join(__dirname, "..", ".esim", "partner-kit");
const REPLY = "director@visa-sc.ru";
const BOT = process.env.ESIM_TG_USERNAME || "esimvoyo_bot";
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const RU = (n) => Math.round(n).toLocaleString("ru-RU").replace(/ /g, " ");

// живые цены «от» по популярным направлениям: 1 ГБ и больше, не суточные
async function livePrices() {
  const r = await fetch("http://127.0.0.1:" + (process.env.PORT || 3000) + "/esim/api/catalog", { headers: { host: "voyomobile.ru" } });
  const all = (await r.json()).products || [];
  const one = (cc) => all.filter((p) => p.countries.length === 1 && p.countries[0] === cc && p.dataGb >= 1 && !p.daily)
    .sort((a, b) => a.priceRub - b.priceRub)[0];
  const eu = all.filter((p) => p.countries.length >= 30 && p.countries.includes("FR") && p.dataGb >= 1 && !p.daily)
    .sort((a, b) => a.priceRub - b.priceRub)[0];
  const row = (name, p) => p ? { name, price: p.priceRub } : null;
  return [row("Турция", one("TR")), row("Европа", eu), row("Таиланд", one("TH")), row("ОАЭ", one("AE"))].filter(Boolean);
}

function build(p, pr) {
  const visa = /виз/i.test(String(p.kind || ""));
  const tg = "https://t.me/" + BOT + "?start=p_" + String(p.code).toLowerCase();
  const subject = "15% с каждой eSIM ваших клиентов + готовый QR для стойки";
  const C = { ink: "#16202e", mut: "#6e7c91", line: "#e6ebf2", acc: "#2c6f96", bg: "#f4f7fb", green: "#2a8f6a" };
  const tile = (ico, t) => '<td width="50%" valign="top" style="padding:5px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#fff;border:1px solid ' + C.line + ';border-radius:14px"><tr><td style="padding:14px 14px;font-size:14px;line-height:1.35;color:' + C.ink + ';font-weight:600"><span style="font-size:20px;line-height:1;display:block;margin:0 0 6px">' + ico + "</span>" + t + "</td></tr></table></td>";
  const row = (k, v, hint) => '<tr><td style="padding:0 0 14px"><div style="font-size:13px;color:' + C.mut + ';margin:0 0 4px">' + k + "</div>" + v +
    (hint ? '<div style="font-size:13px;color:' + C.mut + ';margin:4px 0 0">' + hint + "</div>" : "") + "</td></tr>";
  const link = (href, txt) => '<a href="' + esc(href) + '" style="font-size:15px;color:' + C.acc + ';word-break:break-word">' + esc(txt) + "</a>";
  const prices = pr.map((x) => '<span style="white-space:nowrap">' + esc(x.name) + " <b>от " + RU(x.price) + " ₽</b></span>").join('<span style="color:' + C.mut + '"> · </span>');

  const html = '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>' +
  '<body style="margin:0;padding:0;background:' + C.bg + ';font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Arial,sans-serif">' +
  '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:' + C.bg + '"><tr><td align="center" style="padding:24px 12px">' +
  '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px">' +
  // логотип — картинкой, как в шапке voyomobile.ru
  '<tr><td style="padding:2px 4px 16px"><a href="https://voyomobile.ru"><img src="https://voyomobile.ru/voyo-mobile-logo.png" alt="VOYO mobile" width="153" height="22" style="display:block;width:153px;height:22px;border:0"></a></td></tr>' +
  // первый экран
  '<tr><td style="padding:0 0 10px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-radius:18px;background:#2c6f96;background-image:linear-gradient(135deg,#4aa3d4,#2c6f96)"><tr><td style="padding:26px 24px;color:#fff">' +
  '<div style="font-size:27px;line-height:1.2;font-weight:700;margin:0 0 10px">15% с каждой eSIM ваших клиентов</div>' +
  '<div style="font-size:16px;line-height:1.45;opacity:.95">' + (visa ? "Клиент получил визу, дальше ему нужен интернет в поездке." : "Туристу в поездке нужен интернет.") +
  " Дайте ему вашу ссылку: клиенту −100 ₽, вам 15% со всех его покупок, бессрочно.</div>" +
  "</td></tr></table></td></tr>" +
  // плитки как на сайте
  '<tr><td style="padding:0 0 6px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0">' +
  "<tr>" + tile("⚡", "QR-код через 1 секунду, установка за минуту") + tile("💳", "Оплата российской картой и СБП") + "</tr>" +
  "<tr>" + tile("💬", "Поддержка на русском, чат и Telegram") + tile("⭐", "5,0 · 1 325 оценок<br><span style=\"font-weight:400;color:" + C.mut + "\">211 стран</span>") + "</tr>" +
  "</table></td></tr>" +
  // цены строкой
  '<tr><td style="padding:4px 6px 16px;font-size:15px;line-height:1.6;color:' + C.ink + '">' + prices + "</td></tr>" +
  // начать пользоваться
  '<tr><td style="padding:0 0 14px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#fff;border:2px solid #4aa3d4;border-radius:18px"><tr><td style="padding:22px 22px 8px">' +
  '<div style="font-size:20px;font-weight:700;color:' + C.ink + ';margin:0 0 4px">Начать пользоваться</div>' +
  '<div style="font-size:14px;color:' + C.mut + ';margin:0 0 16px">Всё уже работает' + (p.name ? " для «" + esc(p.name) + "»" : "") + ", ничего заполнять не нужно.</div>" +
  '<table role="presentation" width="100%" cellpadding="0" cellspacing="0">' +
    row("Ваш промокод", '<span style="display:inline-block;font-family:Menlo,Consolas,monospace;font-weight:700;font-size:18px;letter-spacing:1px;background:' + C.bg + ';padding:6px 12px;border-radius:9px;color:' + C.ink + '">' + esc(p.code) + "</span>", "Клиент вводит его при оплате, скидка 100 ₽.") +
    row("Ссылка на сайт", link(p.link, p.link.replace(/^https:\/\//, "")), "Промокод в ссылке уже есть: отправьте с документами или в мессенджер.") +
    row("Ссылка на Telegram-бот", link(tg, tg.replace(/^https:\/\//, "")), "Для тех, кому удобнее купить прямо в Telegram.") +
    row("QR-код для стойки", '<div style="font-size:15px;color:' + C.ink + '">📎 Во вложении: табличка A5 для печати и QR-код картинкой.</div>') +
  "</table>" +
  '<div style="padding:4px 0 18px"><a href="' + esc(p.cabinetAuto) + '" style="display:inline-block;background:#2c6f96;background-image:linear-gradient(135deg,#4aa3d4,#2c6f96);color:#fff;text-decoration:none;font-weight:600;font-size:15px;padding:13px 22px;border-radius:12px">Мой кабинет: клиенты и начисления</a>' +
  '<div style="font-size:13px;color:' + C.mut + ';margin:8px 0 0">' + esc(p.cabinet.replace(/^https:\/\//, "")) + ", пароль " + esc(p.pass) + "</div></div>" +
  "</td></tr></table></td></tr>" +
  '<tr><td style="padding:0 6px;font-size:14px;line-height:1.5;color:' + C.ink + '">15% начисляются с первой и со всех следующих покупок клиента, даже если код он больше не вводит. Выплаты раз в месяц.</td></tr>' +
  '<tr><td style="padding:18px 6px 0;font-size:12px;line-height:1.5;color:' + C.mut + '">VOYO mobile · ' + REPLY + "<br>Пишем, потому что адрес указан на сайте " + esc(p.site || "вашей компании") + ". Неинтересно: ответьте «нет», больше не напишем.</td></tr>" +
  "</table></td></tr></table></body></html>";

  const text = [
    "15% с каждой eSIM ваших клиентов",
    (visa ? "Клиент получил визу, дальше ему нужен интернет в поездке." : "Туристу в поездке нужен интернет.") + " Дайте ему вашу ссылку: клиенту −100 ₽, вам 15% со всех его покупок, бессрочно.",
    "", "QR-код через 1 секунду · оплата картой и СБП · поддержка на русском · 211 стран",
    pr.map((x) => x.name + " от " + RU(x.price) + " ₽").join(" · "),
    "", "Начать пользоваться:", "Промокод: " + p.code + " (клиенту −100 ₽)", "Ссылка на сайт: " + p.link, "Ссылка на Telegram-бот: " + tg,
    "QR-код для стойки: во вложении (табличка A5 и картинка).", "Кабинет: " + p.cabinet + ", пароль " + p.pass,
    "", "15% с первой и со всех следующих покупок клиента. Выплаты раз в месяц.",
    "", "VOYO mobile · " + REPLY, "Пишем, потому что адрес указан на сайте " + (p.site || "вашей компании") + ". Неинтересно: ответьте «нет», больше не напишем.",
  ].join("\n");
  const dir = path.join(KIT, String(p.code));
  const attachments = [["tablichka-voyo-mobile-A5.pdf", "Табличка VOYO mobile A5.pdf"], ["qr-voyo-mobile.png", "QR VOYO mobile.png"]]
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
  let n = 0;
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
    await sleep(75000);
  }
  console.log("отправлено:", n);
})();
