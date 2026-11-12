// Сторож возвратов у поставщика MobiMatter: смотрит заказы, по которым мы попросили деньги назад,
// и отмечает, когда они реально упали на наш кошелёк. Одно короткое письмо на каждый вернувшийся
// заказ — и больше по нему ни звука.
//
// Было с 06.09.2026 под один заказ AKGR-23489937. С 02.10.2026 общий: заказы с пометкой
// supplierRefund.state = "PendingRefund" (сервер попросил возврат через API: PUT /order/refund).
// С 12.11.2026 и ручные: state = "Asked" — автовозврат не прошёл (eSIM успела запуститься), и мы
// написали в поддержку письмом (AKGR-25287301, Япония, $14,40). Возврат замечаем двумя путями:
// статус заказа у MobiMatter стал Refunded или кошелёк вырос на сумму заказа сверх наших покупок
// с момента запроса (точка отсчёта — mmBal/mmBalTs, ставится при первой проверке).
//
// Крон: 17 */2 * * * cd /var/www/voyo && node tools/mmRefundWatch.js
require("dotenv").config({ quiet: true });
const fs = require("fs");
const path = require("path");
const https = require("https");
const mail = require("../mail.js");

const TO = process.env.MM_WATCH_TO || "director@visa-sc.ru";
const ORDERS = path.join(__dirname, "..", ".esim", "orders.json");
const read = () => JSON.parse(fs.readFileSync(ORDERS, "utf8"));

function api(p) {
  return new Promise((resolve) => {
    const req = https.get({
      host: "api.mobimatter.com",
      path: "/mobimatter/api/v2" + p,
      headers: { "api-key": process.env.MOBIMATTER_API_KEY, merchantId: process.env.MOBIMATTER_MERCHANT_ID, Accept: "application/json" },
      timeout: 30000,
    }, (res) => {
      let b = ""; res.on("data", (c) => (b += c));
      res.on("end", () => { try { resolve(JSON.parse(b)); } catch (_) { resolve(null); } });
    });
    req.on("error", () => resolve(null));
    req.on("timeout", () => { req.destroy(); resolve(null); });
  });
}

(async () => {
  const all = read();
  const isMm = (o) => /^AKGR-/.test(String(o.mmOrderId || ""));
  const wait = all.filter((o) => isMm(o) && o.supplierRefund && (o.supplierRefund.state === "PendingRefund" ||
    (o.supplierRefund.state === "Asked" && Date.now() - (o.supplierRefund.asked || 0) < 60 * 864e5)));
  const now = new Date().toISOString();
  if (!wait.length) return console.log(now + " ждущих возвратов нет");
  const bal = await api("/merchant/balance");
  const wallet = Number(bal && bal.result && bal.result.balance);
  const patch = {};   // id → поля supplierRefund, которые меняем
  const done = [];
  for (const o of wait) {
    const r = o.supplierRefund, cost = Number(o.costUsd || 0);
    const res = await api("/order/" + o.mmOrderId);
    const st = (res && res.result && res.result.orderState) || "?";
    let how = null;
    if (st === "Refunded") how = "статус заказа у MobiMatter: Refunded";
    else if (Number.isFinite(wallet) && cost > 0) {
      if (r.mmBal == null) { patch[o.id] = { mmBal: wallet, mmBalTs: Date.now() }; }   // точка отсчёта
      else {
        // наши покупки у MobiMatter после точки отсчёта (кроме этого заказа)
        const spent = all.filter((x) => isMm(x) && x.id !== o.id && x.paidAt && x.paidAt > r.mmBalTs)
          .reduce((a, x) => a + Number(x.costUsd || 0), 0);
        const diff = wallet - (r.mmBal - spent);
        if (diff >= cost * 0.8 && diff <= cost * 1.5 + 0.5) how = "кошелёк вырос на $" + diff.toFixed(2);
        else if (diff > cost * 1.5 + 0.5) patch[o.id] = { mmBal: wallet, mmBalTs: Date.now() };   // похоже на пополнение — сдвигаем точку
      }
    }
    console.log(now + " " + o.mmOrderId + " (" + r.state + ") статус: " + st + " | кошелёк: $" + wallet + (how ? " | ВЕРНУЛИ: " + how : ""));
    if (how) { patch[o.id] = Object.assign(patch[o.id] || {}, { state: "Refunded", refundedAt: Date.now(), refundedUsd: cost, at: Date.now(), how }); done.push(o); }
  }
  if (Object.keys(patch).length) {
    // пишем поверх свежей копии и только свои поля — сервер мог за это время поменять заказы
    const fresh = read();
    for (const [id, f] of Object.entries(patch)) { const x = fresh.find((y) => y.id === id); if (x && x.supplierRefund) Object.assign(x.supplierRefund, f); }
    fs.writeFileSync(ORDERS, JSON.stringify(fresh, null, 1), "utf8");
  }
  if (!done.length) return;
  const lines = done.map((o) => "• " + o.mmOrderId + ", " + (o.label || "") + ", $" + Number(o.costUsd || 0).toFixed(2) +
    (o.email ? ", клиент " + o.email : "") + " (" + patch[o.id].how + ")").join("\n");
  await mail.sendMail({
    to: TO,
    subject: "VOYO eSIM: MobiMatter вернул деньги за " + done.length + " " + (done.length === 1 ? "заказ" : "заказа"),
    text: "Поставщик вернул деньги на наш кошелёк:\n\n" + lines + "\n\nКошелёк MobiMatter сейчас: $" + wallet.toFixed(2) + ".",
  }).catch((e) => console.log("письмо не ушло:", e.message));
  console.log(now + " письмо отправлено");
})();
