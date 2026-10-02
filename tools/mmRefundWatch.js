// Сторож возвратов у поставщиков eSIM: раз в сутки смотрит заказы, по которым мы
// попросили деньги назад, и отмечает, когда они реально упали на наш кошелёк.
// Одно короткое письмо на каждый вернувшийся заказ — и больше по нему ни звука.
//
// Было с 06.09.2026 под один заказ AKGR-23489937. С 02.10.2026 общий: следит за
// всеми заказами с пометкой supplierRefund.state = "PendingRefund" в orders.json
// (их ставит сервер, когда просит возврат у MobiMatter: PUT /order/refund).
//
// Крон: 0 3 * * * cd /var/www/voyo && node tools/mmRefundWatch.js
require("dotenv").config({ quiet: true });
const fs = require("fs");
const path = require("path");
const https = require("https");
const mail = require("../mail.js");

const TO = process.env.MM_WATCH_TO || "director@visa-sc.ru";
const ORDERS = path.join(__dirname, "..", ".esim", "orders.json");

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
  const all = JSON.parse(fs.readFileSync(ORDERS, "utf8"));
  const wait = all.filter((o) => o.supplierRefund && o.supplierRefund.state === "PendingRefund" &&
    /^AKGR-/.test(String(o.mmOrderId || "")));
  const now = new Date().toISOString();
  if (!wait.length) return console.log(now + " ждущих возвратов нет");
  const bal = await api("/merchant/balance");
  const wallet = bal && bal.result && bal.result.balance;
  const done = [];
  for (const o of wait) {
    const r = await api("/order/" + o.mmOrderId);
    const st = (r && r.result && r.result.orderState) || "?";
    console.log(now + " " + o.mmOrderId + " статус: " + st + " | кошелёк: $" + wallet);
    if (st === "Refunded") {
      o.supplierRefund.state = "Refunded";
      o.supplierRefund.at = Date.now();
      done.push(o);
    }
  }
  if (!done.length) return;
  fs.writeFileSync(ORDERS, JSON.stringify(all, null, 1), "utf8");
  const lines = done.map((o) => "• " + o.mmOrderId + ", " + (o.label || "") + ", закупка $" + (o.costUsd || "?") +
    (o.email ? ", клиент " + o.email : "")).join("\n");
  await mail.sendMail({
    to: TO,
    subject: "VOYO eSIM: MobiMatter вернул деньги за " + done.length + " " + (done.length === 1 ? "заказ" : "заказа"),
    text: "Поставщик вернул деньги на наш кошелёк:\n\n" + lines + "\n\nКошелёк MobiMatter сейчас: $" + wallet + ".",
  }).catch((e) => console.log("письмо не ушло:", e.message));
  console.log(now + " письмо отправлено");
})();
