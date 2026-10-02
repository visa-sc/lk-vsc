// Переключение эквайринга eSIM между ИП Комиссаренко и ООО «Эй Кей Групп».
//
//   node tools/kassa-switch.js status   — какой терминал сейчас принимает оплату
//   node tools/kassa-switch.js akg      — новые платежи через ООО; ИП остаётся
//                                         «прежним» терминалом для вебхуков,
//                                         статусов и возвратов по старым платежам
//   node tools/kassa-switch.js ip       — откат: всё обратно на ИП
//
// Скрипт только правит .env (с резервной копией) — перезапуск делает
// tools/kassa-switch.sh, который ждёт окончания выдачи eSIM (рестарт посреди
// выдачи ломал выдачу, 10.09.2026). Ключи ООО лежат в .env под TBANK_AKG_*,
// ключи ИП при первом переключении сохраняются под TBANK_IP_*.
const fs = require("fs");
const path = require("path");
const F = path.join(__dirname, "..", ".env");
const dotenv = require(path.join(__dirname, "..", "node_modules", "dotenv"));

const mode = String(process.argv[2] || "status");
let txt = fs.readFileSync(F, "utf8");
const env = dotenv.parse(txt);
const set = (k, v) => {
  const line = k + "='" + v + "'";
  const re = new RegExp("^" + k + "=.*$", "m");
  if (v == null) { txt = txt.replace(new RegExp("^" + k + "=.*\\n?", "m"), ""); return; }
  txt = re.test(txt) ? txt.replace(re, line) : (txt.endsWith("\n") ? txt : txt + "\n") + line + "\n";
};
const who = (k) => (k === env.TBANK_AKG_TERMINAL_KEY ? "ООО «Эй Кей Групп»" : (k === (env.TBANK_IP_TERMINAL_KEY || "") ? "ИП Комиссаренко" : "ИП Комиссаренко (исходный)"));

if (mode === "status") {
  console.log("принимает оплату:", who(env.TBANK_TERMINAL_KEY), "(" + String(env.TBANK_TERMINAL_KEY).slice(0, 6) + "…)");
  console.log("налоги чека:", env.TBANK_TAXATION || "usn_income", "/", env.TBANK_VAT || "none", "/", env.TBANK_PAYMENT_METHOD || "full_prepayment");
  console.log("прежний терминал для старых платежей:", env.TBANK_OLD_TERMINAL_KEY ? who(env.TBANK_OLD_TERMINAL_KEY) : "нет");
  process.exit(0);
}
if (mode !== "akg" && mode !== "ip") { console.log("режим: status | akg | ip"); process.exit(1); }
if (!env.TBANK_AKG_TERMINAL_KEY || !env.TBANK_AKG_TERMINAL_PASSWORD) { console.log("нет ключей ООО (TBANK_AKG_*)"); process.exit(1); }

fs.writeFileSync(F + ".bak-switch-" + Date.now(), txt);
// ключи ИП сохраняем один раз, пока они ещё в текущих
if (!env.TBANK_IP_TERMINAL_KEY && env.TBANK_TERMINAL_KEY !== env.TBANK_AKG_TERMINAL_KEY) {
  set("TBANK_IP_TERMINAL_KEY", env.TBANK_TERMINAL_KEY);
  set("TBANK_IP_TERMINAL_PASSWORD", env.TBANK_TERMINAL_PASSWORD);
  set("TBANK_IP_TAXATION", env.TBANK_TAXATION || "usn_income");
  set("TBANK_IP_VAT", env.TBANK_VAT || "none");
  set("TBANK_IP_PAYMENT_METHOD", env.TBANK_PAYMENT_METHOD || "full_prepayment");
  Object.assign(env, dotenv.parse(txt));
}
const IP = { key: env.TBANK_IP_TERMINAL_KEY, pass: env.TBANK_IP_TERMINAL_PASSWORD,
  tax: env.TBANK_IP_TAXATION, vat: env.TBANK_IP_VAT, method: env.TBANK_IP_PAYMENT_METHOD };
const AKG = { key: env.TBANK_AKG_TERMINAL_KEY, pass: env.TBANK_AKG_TERMINAL_PASSWORD,
  tax: env.TBANK_AKG_TAXATION, vat: env.TBANK_AKG_VAT, method: env.TBANK_AKG_PAYMENT_METHOD };
const [now, prev] = mode === "akg" ? [AKG, IP] : [IP, AKG];

set("TBANK_TERMINAL_KEY", now.key);
set("TBANK_TERMINAL_PASSWORD", now.pass);
set("TBANK_TAXATION", now.tax);
set("TBANK_VAT", now.vat);
set("TBANK_PAYMENT_METHOD", now.method);
set("TBANK_OLD_TERMINAL_KEY", prev.key);
set("TBANK_OLD_TERMINAL_PASSWORD", prev.pass);
fs.writeFileSync(F, txt);
console.log("готово: оплата через", mode === "akg" ? "ООО «Эй Кей Групп»" : "ИП Комиссаренко",
  "| старые платежи — через", mode === "akg" ? "ИП" : "ООО", "| нужен перезапуск voyo");
