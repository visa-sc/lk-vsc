// ═══════════════════════════════════════════════════════════════════════════
// Общий журнал расхода Claude для сервисов, которые ходят к Anthropic своим
// ключом, мимо шлюза /internal/anthropic (engine-proxy).
//
// Зачем. Сторож баланса (ai-balance.js) видит расход только там, где он
// записан: шлюз ведёт свой журнал, у сканера и поддержки eSIM — свои. Новый
// сервис со своим ключом раньше оставался невидимым: деньги уходили, а в письме
// о балансе его не было. Теперь у таких сервисов один способ отчитаться:
//
//   require("./ai-usage").record("chat", msg.model, msg.usage);
//
// и строка с этим сервисом сама появится в письме сторожа. Сервисы, которые
// ходят через шлюз, сюда писать НЕ должны — шлюз их уже посчитал (иначе расход
// задвоится); им достаточно заголовка x-voyo-service с именем сервиса.
//
// Файл .aiUsage.json — плоский список записей, последние 20 000.
// ═══════════════════════════════════════════════════════════════════════════
const fs = require("fs");
const path = require("path");

const FILE = path.join(__dirname, ".aiUsage.json");
const KEEP = 20000;

// $ за 1M токенов: вход, выход. Кэш: чтение 0,1 входа, запись 1,25 (часовая — 2).
const PRICES = {
  "claude-opus-5-5": [4, 20], "claude-opus-5": [5, 25],
  "claude-sonnet-5-5": [2, 10], "claude-sonnet-5": [2, 10],
  "claude-haiku-4-5": [1, 5],
};

function usdOf(model, u) {
  const p = PRICES[model] || PRICES["claude-opus-5-5"];
  const cw1h = (u.cache_creation && u.cache_creation.ephemeral_1h_input_tokens) || 0;
  const cw = (u.cache_creation_input_tokens || 0) - cw1h;
  return ((u.input_tokens || 0) + (u.cache_read_input_tokens || 0) * 0.1 + cw * 1.25 + cw1h * 2) * p[0] / 1e6
    + (u.output_tokens || 0) * p[1] / 1e6;
}

function load() { try { return JSON.parse(fs.readFileSync(FILE, "utf8")) || []; } catch (_) { return []; } }

// kind — необязательная пометка вызова, который не является «работой» сервиса
// (служебная сборка, разметка): в письме такие не попадают в счётчик.
function record(svc, model, usage, kind) {
  if (!svc || !usage) return;
  try {
    const all = load();
    all.push({
      ts: Date.now(), svc: String(svc), model: String(model || ""), kind: kind || undefined,
      in: usage.input_tokens || 0, out: usage.output_tokens || 0,
      cr: usage.cache_read_input_tokens || 0, cw: usage.cache_creation_input_tokens || 0,
      usd: Math.round(usdOf(String(model || ""), usage) * 10000) / 10000,
    });
    fs.writeFileSync(FILE, JSON.stringify(all.slice(-KEEP)));
  } catch (e) { console.warn("ai-usage:", e.message); }
}

module.exports = { record, load, usdOf, PRICES, FILE };
