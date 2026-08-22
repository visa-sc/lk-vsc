// ─────────────────────────────────────────────────────────────────────────
// Движок ИИ-переводов VOYO — ОТДЕЛЬНЫЙ сервис (порт 3003), 22.08.2026.
//
// Зачем отдельно: движок правит Екатерина Зайцева со своим Claude Code, не
// дёргая Андрея. Сервис живёт в /var/www/translate-engine под юзером kateadmin,
// pm2-процесс «translate-engine» в её pm2. Основное приложение (/var/www/voyo,
// :3000) к нему только проксирует /translate/api/* и /translate_pay/api/*.
//
// Чего здесь НЕТ и не будет — это на основном приложении (:3000, /internal/*):
//  • ключ Anthropic: SDK настроен на ANTHROPIC_BASE_URL=http://127.0.0.1:3000/internal/anthropic,
//    ANTHROPIC_API_KEY здесь = служебный секрет моста (ENGINE_SECRET), а не ключ.
//    Основное приложение подставляет настоящий ключ, ПРИНУДИТЕЛЬНО держит модель
//    в белом списке (ENGINE_ALLOWED_MODELS) и считает суточный бюджет
//    (ENGINE_DAILY_BUDGET_RUB): при превышении отвечает 429 и пишет Андрею.
//    Поэтому сменить модель на более дорогую или сжечь баланс регулярными
//    задачами отсюда нельзя — это решено не договорённостью, а кодом на :3000.
//  • почта: mail.js здесь — тонкий шим к POST :3000/internal/engine/mail.
//
// Кто пришёл: основное приложение само проверяет токен (админ/руководитель/
// портальный сотрудник) и кладёт роль в заголовок x-voyo-staff (только с
// 127.0.0.1). Код доступа /translate (TRANSLATE_CODE) и токены сверяются здесь.
//
// Данные: ./.translate/ (orders.json + files/) — переехали из основного
// приложения 22.08.2026 целиком, история заказов и правила сохранены.
// ─────────────────────────────────────────────────────────────────────────
require("dotenv").config();
const express = require("express");

const app = express();
app.set("trust proxy", "loopback");
app.use(express.json({ limit: "4mb" }));
app.use(express.urlencoded({ extended: true }));

function isLocal(req) {
  const ip = String(req.socket.remoteAddress || "");
  return ip === "127.0.0.1" || ip === "::ffff:127.0.0.1" || ip === "::1";
}
// Роль запроса из заголовка, который ставит основное приложение при проксировании.
function getStaffFromReq(req) {
  if (!isLocal(req)) return null;
  const h = req.headers["x-voyo-staff"];
  if (!h) return null;
  try { return JSON.parse(decodeURIComponent(String(h))); } catch (_) { return null; }
}

app.get("/engine/health", (req, res) => res.json({ ok: true, service: "translate-engine", uptime: Math.round(process.uptime()) }));

require("./translate").mount(app, { getStaffFromReq });

const PORT = Number(process.env.PORT || 3003);
app.listen(PORT, "127.0.0.1", () => console.log("translate-engine on 127.0.0.1:" + PORT));
