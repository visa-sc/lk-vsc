// Письмо агентствам: «продавайте eSIM своим клиентам и зарабатывайте 15%» (17.11.2026).
// Каждому агентству — свой код, ссылка для клиентов и кабинет (заводит tools/esimPartnersAdd.js).
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
const REPLY = "director@visa-sc.ru";
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
  const row = (name, p) => p ? { name, price: p.priceRub, what: (p.dataGb >= 999 ? "безлимит" : p.dataGb + " ГБ") + " на " + p.days + " дн." } : null;
  return [row("Турция", one("TR")), row("Таиланд", one("TH")), row("Европа, " + (eu ? eu.countries.length : 33) + " стран", eu), row("ОАЭ", one("AE"))].filter(Boolean);
}

function build(p, pr) {
  const visa = /виз/i.test(String(p.kind || ""));
  const who = visa ? "Ваши клиенты оформляют визу и едут за границу." : "Ваши туристы едут за границу.";
  const subject = "Дополнительный доход с каждого клиента, который едет за границу";
  const C = { ink: "#16202e", mut: "#6e7c91", line: "#e6ebf2", acc: "#2c6f96", bg: "#f4f7fb" };
  const btn = (href, txt) => '<a href="' + href + '" style="display:inline-block;background:#2c6f96;background-image:linear-gradient(135deg,#4aa3d4,#2c6f96);color:#fff;text-decoration:none;font-weight:600;font-size:15px;padding:13px 22px;border-radius:12px">' + txt + "</a>";
  const card = (inner) => '<tr><td style="padding:0 0 14px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#fff;border:1px solid ' + C.line + ';border-radius:16px"><tr><td style="padding:22px 24px">' + inner + "</td></tr></table></td></tr>";
  const h2 = (t) => '<div style="font-size:18px;font-weight:700;color:' + C.ink + ';margin:0 0 12px">' + t + "</div>";
  const li = (t) => '<tr><td valign="top" style="padding:0 10px 10px 0;color:#2a8f6a;font-weight:700;font-size:16px">✓</td><td style="padding:0 0 10px;font-size:15px;line-height:1.5;color:' + C.ink + '">' + t + "</td></tr>";
  const priceRows = pr.map((x) => '<tr><td style="padding:7px 0;border-bottom:1px solid ' + C.line + ';font-size:15px;color:' + C.ink + '">' + esc(x.name) + '<span style="color:' + C.mut + '">, ' + esc(x.what) + '</span></td><td align="right" style="padding:7px 0;border-bottom:1px solid ' + C.line + ';font-size:15px;font-weight:700;color:' + C.ink + ';white-space:nowrap">от ' + RU(x.price) + " ₽</td></tr>").join("");
  const step = (n, t) => '<tr><td valign="top" style="padding:0 12px 12px 0"><div style="width:28px;height:28px;border-radius:14px;background:#e8f2f9;color:' + C.acc + ';font-weight:700;font-size:14px;line-height:28px;text-align:center">' + n + '</div></td><td style="padding:3px 0 12px;font-size:15px;line-height:1.5;color:' + C.ink + '">' + t + "</td></tr>";
  const kv = (k, v) => '<tr><td style="padding:0 0 12px"><div style="font-size:13px;color:' + C.mut + ';margin:0 0 3px">' + k + '</div><div style="font-size:15px;color:' + C.ink + ';word-break:break-word">' + v + "</div></td></tr>";

  const html = '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>' +
  '<body style="margin:0;padding:0;background:' + C.bg + ';font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Arial,sans-serif">' +
  '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:' + C.bg + '"><tr><td align="center" style="padding:24px 12px">' +
  '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px">' +
  // шапка
  '<tr><td style="padding:4px 4px 18px"><img src="https://voyomobile.ru/voyo-logo.png" alt="VOYO" height="26" style="height:26px;vertical-align:middle;border:0"> <span style="font-size:20px;font-weight:300;color:' + C.acc + ';vertical-align:middle">mobile</span></td></tr>' +
  // первый экран
  '<tr><td style="padding:0 0 14px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-radius:18px;background:#2c6f96;background-image:linear-gradient(135deg,#4aa3d4,#2c6f96)"><tr><td style="padding:28px 26px;color:#fff">' +
  '<div style="font-size:14px;opacity:.85;margin:0 0 8px">Партнёрская программа для ' + (visa ? "визовых агентств" : "турагентств") + "</div>" +
  '<div style="font-size:26px;line-height:1.25;font-weight:700;margin:0 0 12px">15% с каждой eSIM ваших клиентов. Навсегда.</div>' +
  '<div style="font-size:16px;line-height:1.5;opacity:.95">' + who + " Интернет в поездке им нужен в любом случае. Порекомендуйте eSIM VOYO mobile: клиент сэкономит на роуминге, а вы будете получать 15% с каждой его покупки, не только с первой.</div>" +
  "</td></tr></table></td></tr>" +
  // почему клиенты покупают
  card(h2("Почему клиенты покупают") + '<table role="presentation" cellpadding="0" cellspacing="0">' +
    li("<b>Дешевле, чем у большинства:</b> цены от 69 ₽, на популярные направления в 2–3 раза ниже, чем у известных сервисов.") +
    li("<b>Подключение за минуту:</b> QR-код приходит на почту сразу после оплаты, eSIM ставится до вылета.") +
    li("<b>211 стран</b>, оплата российской картой.") +
    li("<b>Поддержка на нас:</b> чат на сайте и в Telegram, отвечаем сами. Вам не нужно разбираться в настройках телефонов.") +
    li("<b>Подарок от вас:</b> по вашей ссылке клиент получает скидку 100 ₽ на первую покупку.") +
    "</table>") +
  // цены
  card(h2("Цены сейчас") + '<table role="presentation" width="100%" cellpadding="0" cellspacing="0">' + priceRows + "</table>" +
    '<div style="font-size:13px;color:' + C.mut + ';margin-top:10px">Это цены без вашей скидки 100 ₽. Все пакеты: <a href="https://voyomobile.ru" style="color:' + C.acc + '">voyomobile.ru</a></div>') +
  // что получаете
  card(h2("Что получаете вы") + '<table role="presentation" cellpadding="0" cellspacing="0">' +
    li("<b>15% с каждой покупки</b> клиента, который пришёл по вашей ссылке или коду. И с первой, и со всех следующих, даже если код он больше не вводит.") +
    li("<b>Без вложений и интеграций:</b> ссылка, QR-код и личный кабинет уже готовы, начать можно сегодня.") +
    li("<b>Всё прозрачно:</b> в кабинете видно каждого клиента, покупки и сколько вы заработали.") +
    li("<b>Выплаты раз в месяц</b> на карту или расчётный счёт.") +
    "</table>") +
  // как пользоваться
  card(h2("Как пользоваться: 3 шага") + '<table role="presentation" cellpadding="0" cellspacing="0">' +
    step(1, "Отправьте клиенту <b>вашу ссылку</b> вместе с документами, ваучером или памяткой. Промокод подставится сам.") +
    step(2, "Распечатайте <b>QR-код</b> из кабинета и поставьте на стойку в офисе.") +
    step(3, "Заходите в <b>кабинет</b>: там клиенты и начисления. Остальное делаем мы.") +
    "</table>") +
  // личный блок
  '<tr><td style="padding:0 0 14px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#fff;border:2px solid #4aa3d4;border-radius:16px"><tr><td style="padding:22px 24px">' +
  h2("Ваши данные" + (p.name ? ": " + esc(p.name) : "")) +
  '<div style="font-size:14px;color:' + C.mut + ';margin:-6px 0 12px">Всё уже работает, ничего заполнять не нужно.</div>' +
  '<table role="presentation" width="100%" cellpadding="0" cellspacing="0">' +
    kv("Промокод", '<span style="font-family:Menlo,Consolas,monospace;font-weight:700;font-size:17px;letter-spacing:1px;background:' + C.bg + ';padding:4px 10px;border-radius:8px">' + esc(p.code) + "</span>") +
    kv("Ссылка для клиентов", '<a href="' + esc(p.link) + '" style="color:' + C.acc + '">' + esc(p.link.replace(/^https:\/\//, "")) + "</a>") +
    kv("Кабинет", '<a href="' + esc(p.cabinet) + '" style="color:' + C.acc + '">' + esc(p.cabinet.replace(/^https:\/\//, "")) + "</a>") +
    kv("Пароль кабинета", '<span style="font-family:Menlo,Consolas,monospace;font-size:15px">' + esc(p.pass) + "</span>") +
  "</table>" +
  '<div style="padding:18px 0 0">' + btn(esc(p.cabinetAuto), "Открыть мой кабинет") + "</div>" +
  "</td></tr></table></td></tr>" +
  // подпись
  '<tr><td style="padding:6px 6px 0;font-size:15px;line-height:1.55;color:' + C.ink + '">Вопросы, договор, особые условия для крупных агентств: просто ответьте на это письмо.<br><br>' +
  "Андрей Комисаренко<br>VOYO mobile, eSIM для поездок<br>" +
  '<a href="mailto:' + REPLY + '" style="color:' + C.acc + '">' + REPLY + "</a></td></tr>" +
  '<tr><td style="padding:22px 6px 0;font-size:12px;line-height:1.5;color:' + C.mut + '">Пишем, потому что этот адрес указан на сайте ' + esc(p.site || "вашей компании") + ". Если неинтересно, ответьте «нет», и мы больше не напишем.</td></tr>" +
  "</table></td></tr></table></body></html>";

  const text = [
    "Партнёрская программа VOYO mobile для " + (visa ? "визовых агентств" : "турагентств") + ": 15% с каждой eSIM ваших клиентов.",
    "", who + " Порекомендуйте eSIM VOYO mobile: клиент сэкономит на роуминге, а вы получите 15% с каждой его покупки, не только с первой.",
    "", "Цены сейчас:", ...pr.map((x) => "• " + x.name + ", " + x.what + ": от " + RU(x.price) + " ₽"),
    "", "Как пользоваться:", "1. Отправьте клиенту вашу ссылку с документами или памяткой.", "2. Поставьте QR-код из кабинета на стойку.", "3. Смотрите клиентов и начисления в кабинете.",
    "", "Ваши данные" + (p.name ? " (" + p.name + ")" : "") + ":", "Промокод: " + p.code, "Ссылка для клиентов: " + p.link, "Кабинет: " + p.cabinet, "Пароль: " + p.pass,
    "", "Клиенту по вашей ссылке скидка 100 ₽ на первую покупку. Выплаты раз в месяц на карту или расчётный счёт.",
    "Вопросы: ответьте на это письмо.", "", "Андрей Комисаренко, VOYO mobile", REPLY,
    "", "Пишем, потому что адрес указан на сайте " + (p.site || "вашей компании") + ". Неинтересно: ответьте «нет», больше не напишем.",
  ].join("\n");
  return { subject, html, text };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const [mode, a1, a2, a3] = process.argv.slice(2);
  const pr = await livePrices();
  if (mode === "test") {
    const list = JSON.parse(fs.readFileSync(a2, "utf8"));
    const p = list[Number(a3 || 0)];
    const L = build(p, pr);
    const r = await sendMail({ to: a1, subject: "[ОБРАЗЕЦ] " + L.subject, html: L.html, text: L.text, replyTo: REPLY, fromName: "VOYO mobile" });
    console.log(r.ok ? "образец отправлен на " + a1 : r.error);
    return;
  }
  if (mode === "send") {
    const list = JSON.parse(fs.readFileSync(a1, "utf8"));
    const lim = process.argv.includes("--limit") ? Number(process.argv[process.argv.indexOf("--limit") + 1]) : Infinity;
    const log = fs.existsSync(LOG) ? JSON.parse(fs.readFileSync(LOG, "utf8")) : {};
    let n = 0;
    for (const p of list) {
      const to = String(p.email || "").trim().toLowerCase();
      if (!to || log[to]) continue;
      if (n >= lim) break;
      const L = build(p, pr);
      const r = await sendMail({ to, subject: L.subject, html: L.html, text: L.text, replyTo: REPLY, fromName: "VOYO mobile" });
      log[to] = { at: Date.now(), ok: !!r.ok, err: r.ok ? null : r.error, code: p.code, name: p.name, kind: p.kind || null };
      fs.writeFileSync(LOG, JSON.stringify(log, null, 1), "utf8");
      console.log(new Date().toISOString().slice(11, 19), r.ok ? "ok " : "ERR", to, r.ok ? "" : r.error);
      n++;
      await sleep(75000);
    }
    console.log("отправлено:", n);
    return;
  }
  console.log("режимы: test <почта> <партнёры.json> [номер] | send <партнёры.json> [--limit N]");
})();
