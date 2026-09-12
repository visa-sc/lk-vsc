// ─────────────────────────────────────────────────────────────────────────
// VOYO Карты — раздел «Карты» клиентского ЛК и отдельная страница /cards.
//
// Два продукта на одной странице, переключаются вкладками:
//   • ВИРТУАЛЬНАЯ (VSC Virtual Card) — карты МИР и Visa, выпуск за минуты.
//     Оформление у партнёра (anakondos) по НАШЕЙ реферальной метке: две
//     кнопки — телеграм-бот и личный кабинет партнёра. Форм у нас нет.
//   • ФИЗИЧЕСКАЯ (карта зарубежного банка) — именной пластик Visa/Mastercard,
//     оформляем мы сами: клиент оставляет заявку в один тап, менеджер
//     перезванивает. Телефон берём из сессии ЛК, поэтому формы тоже нет.
//
// Тексты — выжимка с visa-sc.ru/kcard и visa-sc.ru/acard (тарифы, лимиты,
// сроки, для чего подходит). Меняются тарифы — правим здесь и на лендингах.
//
// Изолирован: свои роуты /cards*, своё хранилище .cards/. Клиентский ЛК,
// /admin, /vsc и amoCRM не затрагивает.
// ─────────────────────────────────────────────────────────────────────────
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

// Реферальные ссылки партнёра по виртуальным картам (метка CB6ie3G — наша).
const REF_TG = "https://telegram.me/anakondos_bot?start=CB6ie3G";
const REF_LK = "https://lk.anakondos.com?anakondos=CB6ie3G";
const PHONE = "+74999385654";

const DIR = path.join(__dirname, ".cards");
const LEADS_FILE = path.join(DIR, "leads.json");
const CLICKS_FILE = path.join(DIR, "clicks.json");

function ensureDir() { try { fs.mkdirSync(DIR, { recursive: true }); } catch (_) {} }
function readJson(f, d) { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch (_) { return d; } }
function writeJson(f, d) { ensureDir(); try { fs.writeFileSync(f, JSON.stringify(d, null, 1), "utf8"); } catch (e) { console.error("cards write:", e.message); } }

function mount(app, opts) {
  const o = opts || {};
  const sendMail = o.sendMail;
  // Телефон вошедшего клиента (подписанная сессия voyo_sess). В отдельной
  // вкладке без входа вернёт null — тогда телефон спросим у клиента.
  const clientPhone = typeof o.clientPhone === "function" ? o.clientPhone : () => null;

  const page = (file) => (req, res) => {
    res.set("Cache-Control", "no-store, no-cache, must-revalidate");
    res.sendFile(path.join(__dirname, "public", file));
  };
  app.get("/cards", page("cards.html"));
  app.get("/card", (req, res) => res.redirect(301, "/cards"));

  // Кто открыл страницу: телефон из сессии ЛК, чтобы заявку можно было
  // отправить одной кнопкой, без формы.
  app.get("/cards/api/me", (req, res) => {
    const phone = clientPhone(req);
    res.json({ success: true, phone: phone || "", refTg: REF_TG, refLk: REF_LK, tel: PHONE });
  });

  // Переходы по кнопкам виртуальной карты — чтобы видеть, приносит ли раздел
  // заявки партнёру (у партнёра статистика своя, у нас — свой счётчик).
  app.post("/cards/api/click", (req, res) => {
    const kind = String((req.body || {}).kind || "").slice(0, 24);
    if (!kind) return res.status(400).json({ success: false });
    const all = readJson(CLICKS_FILE, []);
    all.unshift({ ts: Date.now(), kind, phone: clientPhone(req) || "" });
    writeJson(CLICKS_FILE, all.slice(0, 5000));
    res.json({ success: true });
  });

  // Заявка на физическую карту. Один тап: телефон уже известен из сессии.
  app.post("/cards/api/lead", (req, res) => {
    const b = req.body || {};
    const phone = String(clientPhone(req) || b.phone || "").trim().slice(0, 30);
    if (phone.replace(/\D/g, "").length < 10) {
      return res.status(400).json({ success: false, message: "Нужен телефон." });
    }
    const lead = {
      id: crypto.randomBytes(6).toString("hex"), ts: Date.now(), phone,
      plan: String(b.plan || "").slice(0, 40),
      name: String(b.name || "").slice(0, 120),
      comment: String(b.comment || "").slice(0, 600),
      fromSession: !!clientPhone(req)
    };
    const all = readJson(LEADS_FILE, []); all.unshift(lead); writeJson(LEADS_FILE, all.slice(0, 5000));
    if (sendMail) {
      sendMail({
        to: "director@visa-sc.ru",
        subject: "Карта зарубежного банка: заявка из личного кабинета",
        text: "Заявка на карту зарубежного банка (раздел «Карты» в ЛК)\n\n" +
          "Телефон: " + phone + (lead.fromSession ? " (из сессии ЛК)" : " (ввёл вручную)") +
          "\nТариф: " + (lead.plan || "не выбран") +
          "\nИмя: " + (lead.name || "—") +
          "\nКомментарий: " + (lead.comment || "—") +
          "\n\nПерезвонить, назвать банк и подобрать тариф."
      }).then((r) => { if (r && !r.ok) console.error("cards mail:", r.error); })
        .catch((e) => console.error("cards mail:", e.message));
    }
    res.json({ success: true });
  });
}

module.exports = { mount };
