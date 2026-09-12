// Записать пополнение счёта Anthropic, чтобы сторож считал остаток от него.
//
//   node tools/ai-topup.js 20            — пополнили на $20
//   node tools/ai-topup.js               — показать текущий остаток
//
// Пополнение сбрасывает маркеры предупреждений: письма по порогам $7 и $5
// начнут работать заново.
require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });
const bal = require("../ai-balance");

const arg = process.argv[2];
const money = (v) => "$" + (Math.round(v * 100) / 100).toFixed(2);

if (arg) {
  const usd = Number(String(arg).replace(",", "."));
  if (!isFinite(usd) || usd <= 0) { console.error("Сумма должна быть положительным числом в долларах."); process.exit(1); }
  bal.addTopup(usd, process.argv.slice(3).join(" "));
  console.log("Записано пополнение " + money(usd) + ". Счётчик предупреждений сброшен.");
}

const s = bal.status();
if (!s.known) { console.log(s.message); process.exit(0); }
const d = new Date(s.topupAt + 3 * 3600 * 1000);
const p = (n) => String(n).padStart(2, "0");
console.log("Пополнение от " + p(d.getUTCDate()) + "." + p(d.getUTCMonth() + 1) + "." + d.getUTCFullYear() + ": " + money(s.topupUsd));
console.log("Потрачено с тех пор:              " + money(s.spentUsd));
console.log("  переводы документов:            " + money(s.gateway.usd) + " за " + s.gateway.calls + " обращений");
console.log("  сканер паспортов:               " + money(s.scanner.usd) + " за " + s.scanner.docs + " документов");
console.log("Остаток:                          " + money(s.leftUsd));
