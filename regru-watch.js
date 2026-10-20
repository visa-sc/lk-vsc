// ─────────────────────────────────────────────────────────────────────────
// Сторож баланса Рег.облака (просьба Андрея 31.08.2026): раз в сутки ночью
// проверяем баланс облака reg.ru (на нём живёт прод-сервер) и, если денег
// меньше порога, шлём письмо на director@ — раз в сутки, пока не пополнят.
// Требует REGRU_CLOUD_TOKEN в .env (токен с вкладки «Настройки» панели
// облачных серверов); без токена модуль просто спит и пишет об этом в лог.
// Два порога (решение Андрея 31.08): ниже 1000 ₽ — ОДНО письмо (повторится,
// только если баланс поднялся выше и снова упал); ниже 500 ₽ — письмо
// КАЖДЫЙ день, пока не пополнят. REGRU_BALANCE_WARN_RUB / _ALERT_RUB.
// 12.10.2026 Андрей поднял пороги до 2000 / 1500 ₽ и попросил присылать письма
// только с 08:00 понедельника до 15:00 пятницы МСК (и не ночью: в будни с 08:00).
// Поэтому проверка теперь раз в час, а письмо, которое выпало вне окна, уходит
// первой проверкой в окне — отметка «отправлено» ставится только при отправке.
// ─────────────────────────────────────────────────────────────────────────
const fs = require("fs");
const path = require("path");

const STATE = path.join(__dirname, ".regruWatch.json");

function mount(deps) {
  const sendMail = deps.sendMail;
  const TOKEN = () => (process.env.REGRU_CLOUD_TOKEN || "").trim();
  const WARN = () => Number(process.env.REGRU_BALANCE_WARN_RUB || 2000);
  const LIMIT = () => Number(process.env.REGRU_BALANCE_ALERT_RUB || 1500);
  // Окно писем: пн–пт с 08:00, в пятницу до 15:00 (МСК).
  const mailOk = () => {
    const m = new Date(Date.now() + 3 * 3600000), dow = m.getUTCDay(), h = m.getUTCHours();
    if (dow < 1 || dow > 5 || h < 8) return false;
    return !(dow === 5 && h >= 15);
  };
  const TO = process.env.REGRU_ALERT_EMAIL || "director@visa-sc.ru";
  // Письма о самом балансе (предупреждение и «срочно пополнить») с 20.10.2026 дублируются
  // Андрею Петрову — просьба Андрея. Письмо «проверка не удалась» (нужен новый токен в .env)
  // остаётся только директору: Петров с ним ничего сделать не может.
  const TO_BALANCE = process.env.REGRU_ALERT_EMAIL_BALANCE || (TO + ", ap@spt1.ru");

  const load = () => { try { return JSON.parse(fs.readFileSync(STATE, "utf8")); } catch (_) { return {}; } };
  const save = (o) => { try { fs.writeFileSync(STATE, JSON.stringify(o)); } catch (e) { console.error("regru-watch save:", e.message); } };
  const mskDay = () => new Date(Date.now() + 3 * 3600000).toISOString().slice(0, 10);

  // Ищем поле баланса в ответе терпимо: точный ключ balance, иначе первый
  // числовой ключ, содержащий "balance" (кроме бонусного).
  function findBalance(obj, depth) {
    if (obj == null || typeof obj !== "object" || (depth || 0) > 3) return null;
    for (const k of Object.keys(obj)) {
      if (k.toLowerCase() === "balance" && isFinite(parseFloat(obj[k]))) return parseFloat(obj[k]);
    }
    for (const k of Object.keys(obj)) {
      const lk = k.toLowerCase();
      if (lk.includes("balance") && !lk.includes("bonus") && isFinite(parseFloat(obj[k]))) return parseFloat(obj[k]);
    }
    for (const k of Object.keys(obj)) {
      const r = findBalance(obj[k], (depth || 0) + 1);
      if (r != null) return r;
    }
    return null;
  }

  async function check() {
    if (!TOKEN()) return null;
    let bal;
    try {
      const r = await fetch("https://api.cloudvps.reg.ru/v1/balance_data", {
        headers: { Authorization: "Bearer " + TOKEN() },
        signal: AbortSignal.timeout(30000),
      });
      const raw = await r.json().catch(() => null);
      if (!r.ok) throw new Error("HTTP " + r.status + ": " + JSON.stringify(raw).slice(0, 200));
      bal = findBalance(raw);
      if (bal == null) throw new Error("в ответе нет поля баланса: " + JSON.stringify(raw).slice(0, 250));
    } catch (e) {
      console.error("regru-watch: проверка не удалась: " + e.message);
      const st = load();
      if (st.errDay !== mskDay() && mailOk()) { // об одной и той же проблеме — не чаще раза в сутки
        st.errDay = mskDay(); save(st);
        sendMail({
          to: TO,
          subject: "Сторож баланса Рег.облака: проверка не удалась",
          text: "Не получилось узнать баланс Рег.облака: " + e.message +
            "\n\nЕсли токен отозван или истёк — нужен новый (панель cloud.reg.ru → Настройки → API-токены)," +
            " положить в .env как REGRU_CLOUD_TOKEN. Пока сторож слеп, баланс лучше глянуть руками.",
        }).catch(() => {});
      }
      return null;
    }
    console.log("regru-watch: баланс Рег.облака " + bal + " ₽ (пороги " + WARN() + "/" + LIMIT() + " ₽)");
    const st = load();
    if (bal < LIMIT()) {
      // Критично: письмо каждый день, пока не пополнят.
      if (st.alertDay !== mskDay() && mailOk()) {
        st.alertDay = mskDay(); st.warnSent = true; save(st);
        sendMail({
          to: TO_BALANCE,
          subject: "🔴 Баланс Рег.облака " + Math.round(bal) + " ₽ — срочно пополнить",
          text: "На балансе Рег.облака осталось " + bal + " ₽ — меньше " + LIMIT() + " ₽." +
            "\n\nНа этом облаке работает прод-сервер voyotravel.ru (ЛК, /vsc, сайты): если баланс уйдёт в ноль," +
            " Рег.ру остановит сервер.\n\nПополнить: https://cloud.reg.ru (раздел «Баланс»)." +
            "\n\nЭто письмо будет приходить раз в сутки, пока баланс ниже " + LIMIT() + " ₽.",
        }).catch(() => {});
      }
    } else if (bal < WARN()) {
      // Предупреждение: одно письмо на «заход» ниже порога, без ежедневных повторов.
      if (!st.warnSent && mailOk()) {
        st.warnSent = true; save(st);
        sendMail({
          to: TO_BALANCE,
          subject: "⚠️ Баланс Рег.облака " + Math.round(bal) + " ₽ — ниже " + WARN() + " ₽",
          text: "На балансе Рег.облака осталось " + bal + " ₽ — меньше " + WARN() + " ₽." +
            "\n\nПока не критично, но лучше пополнить заранее: https://cloud.reg.ru (раздел «Баланс»)." +
            "\n\nСледующее письмо придёт, только если баланс опустится ниже " + LIMIT() + " ₽ (дальше — ежедневно)" +
            " или если после пополнения снова упадёт ниже " + WARN() + " ₽.",
        }).catch(() => {});
      }
    } else if (st.warnSent || st.alertDay) {
      // Пополнили — взводим предупреждение заново.
      delete st.warnSent; delete st.alertDay; save(st);
    }
    return bal;
  }

  // Раз в час в :40 (запрос к API рег.облака лёгкий). Письма — только в окне mailOk().
  const msk = new Date(Date.now() + 3 * 3600 * 1000);
  let msTo = ((40 - msk.getUTCMinutes()) * 60 - msk.getUTCSeconds()) * 1000;
  if (msTo <= 0) msTo += 3600000;
  setTimeout(() => { check(); setInterval(check, 3600000); }, msTo);
  console.log("regru-watch: " + (TOKEN()
    ? "проверка баланса Рег.облака раз в час в :40, письма пн 08:00 – пт 15:00 МСК (пороги " + WARN() + "/" + LIMIT() + " ₽, ближайшая через " + Math.round(msTo / 60000) + " мин)"
    : "СПИТ — нет REGRU_CLOUD_TOKEN в .env (токен: панель cloud.reg.ru → API)"));
  return { check };
}

module.exports = { mount };
