// Сторож возврата MobiMatter: раз в сутки смотрит, вернули ли деньги за заказ,
// и один раз пишет письмо, когда они упали на кошелёк партнёра.
//
// Заведён 06.09.2026 под заказ AKGR-23489937 (USA 2 GB, куплен по ошибке при
// обкатке API): саппорт согласился отменить, удержав $2 комиссии. Как только
// придёт письмо — сторож больше ничего не делает, крон можно снимать.
//
// Крон: 0 3 * * * cd /var/www/voyo && node tools/mmRefundWatch.js
require("dotenv").config({ quiet: true });
const fs = require("fs");
const path = require("path");
const https = require("https");
const mail = require("../mail.js");

const ORDER_ID = process.env.MM_WATCH_ORDER || "AKGR-23489937";
const TO = process.env.MM_WATCH_TO || "director@visa-sc.ru";
const STATE = path.join(__dirname, "..", ".esim", "refundwatch.json");

function api(p) {
  return new Promise((resolve) => {
    const req = https.get({
      host: "api.mobimatter.com",
      path: "/mobimatter/api/v2" + p,
      headers: {
        "api-key": process.env.MOBIMATTER_API_KEY,
        merchantId: process.env.MOBIMATTER_MERCHANT_ID,
        Accept: "application/json",
      },
      timeout: 30000,
    }, (res) => {
      let b = "";
      res.on("data", (c) => (b += c));
      res.on("end", () => { try { resolve(JSON.parse(b)); } catch (_) { resolve(null); } });
    });
    req.on("error", () => resolve(null));
    req.on("timeout", () => { req.destroy(); resolve(null); });
  });
}

function readState() {
  try { return JSON.parse(fs.readFileSync(STATE, "utf8")); } catch (_) { return {}; }
}

(async () => {
  const st = readState();
  if (st.notified) return;                       // письмо уже уходило — больше не тревожим

  const ord = await api("/order/" + ORDER_ID);
  const bal = await api("/merchant/balance");
  const o = (ord && (ord.result || ord)) || {};
  const state = String(o.orderState || o.state || "");
  const balance = Number((bal && bal.result && bal.result.balance) != null ? bal.result.balance : NaN);
  if (!state || !isFinite(balance)) {
    console.log(new Date().toISOString(), "нет ответа от MobiMatter, пропускаем");
    return;
  }

  // Базовый остаток запоминаем при первом запуске: возврат виден и по статусу,
  // и по приросту кошелька — хватит любого из признаков.
  if (st.baseline == null) {
    st.baseline = balance;
    fs.writeFileSync(STATE, JSON.stringify(st, null, 1));
  }
  const grew = balance - st.baseline >= 4;
  const refunded = /refund/i.test(state) && !/pending/i.test(state);
  console.log(new Date().toISOString(), "статус:", state, "| кошелёк: $" + balance, "| база: $" + st.baseline);
  if (!refunded && !grew) return;

  const money = Math.round((balance - st.baseline) * 100) / 100;
  const r = await mail.sendMail({
    to: TO,
    subject: "MobiMatter вернул деньги за заказ " + ORDER_ID,
    html: '<div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;max-width:520px;margin:0 auto;color:#16202e">' +
      '<p style="font-size:19px;font-weight:700;letter-spacing:-.02em;margin:0 0 6px">Деньги вернулись</p>' +
      '<p style="font-size:14.5px;line-height:1.65;margin:0 0 14px">MobiMatter отменил заказ <b>' + ORDER_ID +
      '</b> (USA 2 GB, куплен по ошибке при обкатке). Статус у поставщика: <b>' + state + '</b>.</p>' +
      '<p style="font-size:14.5px;line-height:1.65;margin:0 0 14px">На партнёрский кошелёк пришло <b>$' + money +
      '</b>. Остаток кошелька сейчас <b>$' + balance + '</b>.</p>' +
      '<p style="font-size:12.5px;color:#8b93a5;margin:0">Это разовое письмо — сторож больше не побеспокоит.</p></div>',
    text: "MobiMatter вернул деньги за заказ " + ORDER_ID + "\n\nСтатус: " + state +
          "\nПришло: $" + money + "\nОстаток кошелька: $" + balance + "\n\nЭто разовое письмо.",
  });
  st.notified = true;
  st.ts = Date.now();
  st.finalBalance = balance;
  fs.writeFileSync(STATE, JSON.stringify(st, null, 1));
  console.log("письмо отправлено:", r.ok ? "ок" : r.error);
})();
