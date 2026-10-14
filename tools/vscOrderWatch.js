#!/usr/bin/env node
// Сторож первых оплат VSC mobile (Андрей, 14.10.2026): «до первых трёх оплат — если будут
// проблемы, пиши мне; после третьей оплаты сторожа можно отключить».
//
// Смотрит заказы с brand: "vsc" (витрина voyomobile.ru/vsc и ссылки с utm_source=sms).
// Проблема = то, что сломалось у нас, а не выбор клиента:
//   • банк не открыл оплату (payFail при создании платежа);
//   • оплата прошла, а eSIM не выдалась (paid_failed);
//   • выдача висит дольше 15 минут (fulfilling);
//   • eSIM выдана, но ссылка на неё без бренда VSC или карточка клиента не помечена VSC
//     (тогда письма и страницы ушли бы под VOYO).
// О каждой проблеме — одно письмо на director@. После третьей успешной оплаты пишет
// итог и выключается сам (отметка done в .esim/vsc-watch.json, дальше прогоны пустые).
// Cron прода: */10 * * * * cd /var/www/voyo && /usr/bin/node tools/vscOrderWatch.js >> /var/log/vsc-order-watch.log 2>&1
const fs = require("fs");
require("dotenv").config({ path: "/var/www/voyo/.env", quiet: true });
const D = "/var/www/voyo/.esim/";
const STATE = D + "vsc-watch.json";
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch (_) { return d; } };
const msk = (ts) => new Date(ts + 3 * 3600e3).toISOString().slice(0, 16).replace("T", " ");
const NEED = 3;

(async () => {
  const st = readJson(STATE, { warned: {}, ok: [], done: 0 });
  if (st.done) return;
  const orders = readJson(D + "orders.json", []).filter((o) => o.brand === "vsc");
  const cust = readJson(D + "customers.json", {});
  const now = Date.now();
  const problems = [];
  for (const o of orders) {
    if (st.warned[o.id]) continue;
    const who = o.email || o.phone || "—";
    const head = "Заказ " + o.id + " · " + (o.label || "") + " · " + who + " · " + msk(o.ts) + " МСК";
    if (o.payFail) problems.push([o.id, head + "\nБанк не открыл оплату: " + (o.payFail.why || "без причины")]);
    else if (o.status === "paid_failed") problems.push([o.id, head + "\nОплата прошла, а eSIM не выдалась: " + (o.error || "без текста ошибки") + "\nНужно выдать вручную (панель eSIM, раздел заказов)."]);
    else if (o.status === "fulfilling" && now - (o.ts || now) > 15 * 60e3) problems.push([o.id, head + "\nВыдача eSIM висит больше 15 минут."]);
    else if (o.status === "done" && o.paidAt) {
      const card = cust[String(o.custKey || o.email || "").toLowerCase()];
      const bad = [];
      if (o.myUrl && !/[?&]b=vsc/.test(o.myUrl)) bad.push("ссылка на eSIM без бренда VSC (страница откроется как VOYO)");
      if (o.email && !(card && card.brand === "vsc")) bad.push("карточка клиента не помечена VSC (письма уйдут под VOYO)");
      if (bad.length) problems.push([o.id, head + "\nОплачено и выдано, но: " + bad.join("; ") + "."]);
      else if (!o.groupOf && st.ok.indexOf(o.id) < 0) st.ok.push(o.id);
    }
  }
  const mail = require("/var/www/voyo/mail.js");
  if (problems.length) {
    const r = await mail.sendMail({ to: "director@visa-sc.ru", subject: "VSC mobile: проблема с оплатой или выдачей (" + problems.length + ")",
      text: "Сторож первых оплат VSC mobile нашёл проблему:\n\n" + problems.map((p) => p[1]).join("\n\n") +
        "\n\nУспешных оплат VSC mobile пока: " + st.ok.length + " из " + NEED + "." }).catch((e) => ({ ok: false, error: e.message }));
    if (r && r.ok !== false) problems.forEach((p) => { st.warned[p[0]] = now; });
    console.log(new Date().toISOString(), "проблем", problems.length, "письмо", !!(r && r.ok !== false));
  }
  if (st.ok.length >= NEED) {
    const list = orders.filter((o) => st.ok.indexOf(o.id) >= 0);
    await mail.sendMail({ to: "director@visa-sc.ru", subject: "VSC mobile: первые " + NEED + " оплаты прошли без проблем, сторож выключен",
      text: "Первые " + NEED + " оплаты на витрине VSC mobile прошли и выданы под брендом VSC:\n\n" +
        list.map((o) => "• " + msk(o.paidAt) + " МСК · " + (o.label || "") + " · " + (o.priceRub || 0) + " ₽").join("\n") +
        "\n\nСторож первых оплат выключился сам." }).catch(() => {});
    st.done = now;
    console.log(new Date().toISOString(), "три оплаты без проблем — сторож выключен");
  }
  fs.writeFileSync(STATE, JSON.stringify(st));
  if (!problems.length && !st.done) console.log(new Date().toISOString(), "VSC заказов", orders.length, "успешных", st.ok.length);
})().catch((e) => { console.error("vscOrderWatch:", e.message); process.exit(1); });
