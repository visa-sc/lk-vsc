// ─────────────────────────── Блогеры: бесплатный интернет за сторис ───────────────────────────
// Телеграм-бот собирает заявку (имя и фамилия, соцсеть, ник, даты поездки) и выдаёт
// личный промокод. По нему eSIM выдаётся БЕСПЛАТНО: на витрине и в основном боте
// цена становится 0 ₽ и оплата не открывается.
//
// Правила (Андрей, 21.09.2026):
//   • не больше BLOG_MONTH_LIMIT кодов в календарный месяц;
//   • один код на человека: ни то же «имя фамилия», ни тот же ник второй раз;
//   • код закрепляется за первым, кто им воспользовался (почта или чат телеграма),
//     другим он уже не подойдёт;
//   • брать можно сколько угодно eSIM, но не чаще одной в BLOG_COOLDOWN_H часов;
//   • поездка не длиннее BLOG_MAX_DAYS дней, код действует по дату окончания.
//
// Хранилище: .esim/bloggers.json — [{ code, name, network, nick, from, to, chatId,
//   createdAt, boundTo, uses: [ts] }]. Модуль ничего не знает про Telegram: бот
// (tgblogbot.js) зовёт эти функции, а esim.js спрашивает про код при расчёте цены.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const DIR = path.join(__dirname, ".esim");
const FILE = path.join(DIR, "bloggers.json");

const MONTH_LIMIT = Number(process.env.ESIM_BLOG_MONTH_LIMIT || 7);
const MAX_DAYS = Number(process.env.ESIM_BLOG_MAX_DAYS || 30);
const COOLDOWN_H = Number(process.env.ESIM_BLOG_COOLDOWN_H || 4);
const REF_BONUS_RUB = Number(process.env.ESIM_REF_BONUS || 100);

function load() { try { return JSON.parse(fs.readFileSync(FILE, "utf8")); } catch (_) { return []; } }
function save(list) {
  try { fs.mkdirSync(DIR, { recursive: true }); fs.writeFileSync(FILE, JSON.stringify(list, null, 1), "utf8"); }
  catch (e) { console.error("blog save:", e.message); }
}

// ── разбор того, что прислал человек ──
const norm = (s) => String(s || "").replace(/\s+/g, " ").trim();
const key = (s) => norm(s).toLowerCase().replace(/ё/g, "е");
const nickKey = (s) => key(s).replace(/^@+/, "").replace(/^https?:\/\/[^/]+\//, "").replace(/\/+$/, "");

// Имя и фамилия: ровно два слова из букв. Спам вроде «куплю рекламу дёшево»
// отсекаем по словарю — иначе бот принимал любую фразу из двух-трёх слов.
const JUNK = /^(куплю|продам|реклама|рекламу|дёшево|дешево|привет|здравствуйте|добрый|день|тест|test|промокод|код|блогер|блогера|сотрудничество|предложение|здрасте|хочу|дайте|дай|нужен|нужна|можно|пожалуйста|спасибо|интернет|есим|esim|сим|карта)$/i;
function parseName(raw) {
  const t = norm(raw).replace(/[.,;]+$/, "");
  if (!t) return null;
  const words = t.split(" ");
  if (words.length !== 2) return null;
  if (!words.every((w) => /^[A-Za-zА-Яа-яЁё][A-Za-zА-Яа-яЁё'-]{1,19}$/.test(w))) return null;
  if (words.some((w) => JUNK.test(w))) return null;
  return words.map((w) => w[0].toUpperCase() + w.slice(1).toLowerCase()).join(" ");
}

const NETWORKS = [
  { id: "instagram", title: "Instagram", re: /instagram|инстаграм|инста|ig\b/i },
  { id: "telegram", title: "Telegram", re: /telegram|телеграм|тг\b|tg\b/i },
  { id: "youtube", title: "YouTube", re: /youtube|ютуб|shorts/i },
  { id: "tiktok", title: "TikTok", re: /tiktok|тикток/i },
  { id: "vk", title: "ВКонтакте", re: /vk\b|вконтакте|вк\b/i },
  { id: "dzen", title: "Дзен", re: /dzen|дзен/i },
  { id: "other", title: "Другая соцсеть", re: /.*/ },
];
// Соцсеть: узнаём по названию. Незнакомое принимаем, только если это одно слово
// (Rutube, Pinterest) — иначе бот проглатывал любую фразу, включая имя.
function parseNetwork(raw) {
  const t = norm(raw).replace(/[.,;!]+$/, "");
  if (!t) return null;
  const known = NETWORKS.filter((n) => n.id !== "other").find((n) => n.re.test(t));
  if (known) return { id: known.id, title: known.title };
  const one = t.replace(/^в\s+/i, "");
  if (/^[A-Za-zА-Яа-яЁё][A-Za-zА-Яа-яЁё.-]{2,19}$/.test(one) && !JUNK.test(one)) {
    return { id: "other", title: one[0].toUpperCase() + one.slice(1) };
  }
  return null;
}

// Ник: @name, ссылка на профиль или просто слово. Без пробелов и без «спасибо»
function parseNick(raw) {
  let t = norm(raw).replace(/\s+/g, "");
  if (!t) return null;
  const m = /^https?:\/\/[^/]+\/([^/?#]+)/i.exec(t);
  if (m) t = "@" + m[1];
  if (!t.startsWith("@")) t = "@" + t;
  if (!/^@[A-Za-z0-9._-]{2,40}$/.test(t)) return null;
  return t;
}

// Даты: «01.01.2026 - 10.01.2026», «1.1.26-10.1.26», «01/01/2026 10/01/2026»,
// «с 1 января по 10 января». Принимаем разные разделители, год можно не писать.
function parseDates(raw) {
  const t = norm(raw).toLowerCase();
  const MONTHS = ["янв", "фев", "мар", "апр", "мая|май", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"];
  const found = [];
  // цифрами: 01.01.2026, 1/1/26, 2026-01-01
  const reNum = /(\d{1,2})[.\-/](\d{1,2})(?:[.\-/](\d{2,4}))?|(\d{4})-(\d{2})-(\d{2})/g;
  let m;
  while ((m = reNum.exec(t))) {
    if (m[4]) { found.push(mk(Number(m[6]), Number(m[5]), Number(m[4]))); continue; }
    found.push(mk(Number(m[1]), Number(m[2]), m[3] ? Number(m[3]) : null));
  }
  // словами: 5 октября
  if (found.length < 2) {
    const reWord = /(\d{1,2})\s+([а-я]{3,8})/g;
    while ((m = reWord.exec(t))) {
      const mi = MONTHS.findIndex((x) => new RegExp("^(" + x + ")").test(m[2]));
      if (mi >= 0) found.push(mk(Number(m[1]), mi + 1, null));
    }
  }
  const ok = found.filter(Boolean);
  if (ok.length < 2) return null;
  const [from, to] = [ok[0], ok[1]];
  return { from, to };

  function mk(d, mo, y) {
    if (!d || !mo || d > 31 || mo > 12) return null;
    const now = new Date();
    let year = y == null ? now.getFullYear() : (y < 100 ? 2000 + y : y);
    const dt = new Date(Date.UTC(year, mo - 1, d));
    // без года: если дата уже прошла больше месяца назад — значит, речь про следующий год
    if (y == null && dt.getTime() < now.getTime() - 31 * 864e5) dt.setUTCFullYear(year + 1);
    return dt.toISOString().slice(0, 10);
  }
}

function daysBetween(from, to) {
  return Math.round((new Date(to + "T00:00:00Z") - new Date(from + "T00:00:00Z")) / 864e5) + 1;
}
const today = () => new Date(Date.now() + 3 * 3600e3).toISOString().slice(0, 10);   // МСК
const monthKey = (iso) => String(iso || "").slice(0, 7);

// Проверка заявки целиком: что не так — то и скажем человеку
function validate({ name, network, nick, from, to }) {
  if (!name) return { ok: false, why: "name" };
  if (!network) return { ok: false, why: "network" };
  if (!nick) return { ok: false, why: "nick" };
  if (!from || !to) return { ok: false, why: "dates" };
  if (to < from) return { ok: false, why: "order" };
  const days = daysBetween(from, to);
  if (days > MAX_DAYS) return { ok: false, why: "long", days };
  if (to < today()) return { ok: false, why: "past" };
  const list = load();
  const mine = list.filter((b) => monthKey(b.createdAt) === monthKey(today()));
  if (mine.length >= MONTH_LIMIT) return { ok: false, why: "month", left: 0 };
  if (list.some((b) => key(b.name) === key(name))) return { ok: false, why: "dupName" };
  if (list.some((b) => nickKey(b.nick) === nickKey(nick))) return { ok: false, why: "dupNick" };
  return { ok: true, days, left: MONTH_LIMIT - mine.length - 1 };
}

// Код вида VOYO-BLOG-3F7K: видно, что он наш и служебный
function newCode(list) {
  const abc = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  for (let i = 0; i < 50; i++) {
    let t = "";
    for (let j = 0; j < 4; j++) t += abc[crypto.randomBytes(1)[0] % abc.length];
    const code = "STORIS" + t;
    if (!list.some((b) => b.code === code)) return code;
  }
  return "STORIS" + Date.now().toString(36).toUpperCase().slice(-5);
}

function create({ name, network, nick, from, to, chatId }) {
  const v = validate({ name, network, nick, from, to });
  if (!v.ok) return v;
  const list = load();
  const rec = { code: newCode(list), name, network: network.title || network, networkId: network.id || "",
    nick, from, to, chatId: chatId ? String(chatId) : null, createdAt: today(), ts: Date.now(),
    boundTo: null, uses: [] };
  list.push(rec); save(list);
  return { ok: true, rec, left: v.left, days: v.days };
}

function find(code) {
  const c = String(code || "").trim().toUpperCase();
  return load().find((b) => b.code === c) || null;
}

// Можно ли прямо сейчас взять бесплатную eSIM по этому коду.
// who — почта покупателя или "tg:<чат>". Код у блогера один, а мест два: бот и сайт.
// Поэтому свой он и там и там: чат, в котором код выдан, плюс ОДНА почта (первая,
// с которой код применили на сайте). Чужой чат или вторая почта — отказ.
function ownerOf(rec, who) {
  const me = String(who || "").trim().toLowerCase();
  if (!me) return "no_who";
  if (me.indexOf("tg:") === 0) {
    if (rec.chatId) return me === "tg:" + rec.chatId ? "chat" : null;   // код выдан в этом чате
    return (!rec.boundTo || rec.boundTo === me) ? "bind" : null;        // код заведён руками, без чата
  }
  if (!rec.boundEmail || rec.boundEmail === me) return "email";
  return null;
}
function checkUse(code, who) {
  const rec = find(code);
  if (!rec) return { ok: false, why: "not_found" };
  const day = today();
  if (day < rec.from) return { ok: false, why: "not_started", rec };
  if (day > rec.to) return { ok: false, why: "expired", rec };
  if (!ownerOf(rec, who)) return { ok: false, why: "bound", rec };
  const last = (rec.uses || []).slice(-1)[0];
  if (last && Date.now() - last < COOLDOWN_H * 3600e3) {
    return { ok: false, why: "cooldown", rec, waitMin: Math.ceil((COOLDOWN_H * 3600e3 - (Date.now() - last)) / 60000) };
  }
  return { ok: true, rec };
}

// Отмечаем выдачу: закрепляем код за человеком и запускаем отсчёт 4 часов
function markUse(code, who, orderId) {
  const list = load();
  const rec = list.find((b) => b.code === String(code || "").trim().toUpperCase());
  if (!rec) return null;
  const me = String(who || "").trim().toLowerCase();
  if (!rec.boundTo && me) rec.boundTo = me;
  // почту запоминаем отдельно: по ней код работает на сайте, а в боте — по чату
  if (me && me.indexOf("tg:") !== 0 && !rec.boundEmail) rec.boundEmail = me;
  rec.uses = (rec.uses || []).concat([Date.now()]).slice(-200);
  rec.orders = (rec.orders || []).concat([orderId]).slice(-200);
  save(list); return rec;
}

function stats() {
  const list = load();
  const m = monthKey(today());
  return { total: list.length, month: list.filter((b) => monthKey(b.createdAt) === m).length,
    limit: MONTH_LIMIT, left: Math.max(0, MONTH_LIMIT - list.filter((b) => monthKey(b.createdAt) === m).length) };
}

module.exports = { load, save, parseName, parseNetwork, parseNick, parseDates, daysBetween, today,
  validate, create, find, checkUse, markUse, stats, ownerOf,
  MONTH_LIMIT, MAX_DAYS, COOLDOWN_H, REF_BONUS_RUB, NETWORKS };
