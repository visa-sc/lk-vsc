// ═══════════════════════════════════════════════════════════════════════════
// OnlinePBX — статистика звонков по операторам для раздела /vsc «ФОТ».
//
// Зачем: amoCRM знает только те звонки, по которым интеграция успела создать
// ноту, и ничего не знает о пропущенных (на неотвеченный вызов нота с оператором
// не создаётся). Сама АТС знает всё: кому звонок предлагался, кто снял трубку,
// сколько человек ждал ответа.
//
// Что берём по каждому месяцу:
//   • на оператора — принято, не ответил, среднее время до ответа, минуты разговора;
//   • по компании — входящих, отвечено, пропущено (никто не взял), среднее ожидание.
//
// Как устроен ответ АТС: у звонка есть events. Событие type=user с номером
// добавочного означает «вызов предложен этому оператору»; если end_stamp больше
// timestamp — он говорил. Отвечает тот, у кого разговор начался первым.
//
// Пагинации у mongo_history/search.json нет, а выдача обрезается примерно на
// 2,5–3,8 тысячи записей: запрос «за месяц» молча возвращал меньше, чем кабинет
// показывает за неделю. Поэтому ходим ПОДНЕВНО — один день заведомо влезает
// (самый плотный день августа — меньше 500 записей).
// ═══════════════════════════════════════════════════════════════════════════
const axios = require("axios");
const fs = require("fs");
const path = require("path");

const DOMAIN = process.env.PBX_DOMAIN || "visasc.onpbx.ru";
const BASE = "https://api2.onlinepbx.ru/" + DOMAIN;
const FILE = path.join(__dirname, ".vscPbxStats.json");

// Добавочные сотрудников — из кабинета АТС, раздел «Права доступа» (11.09.2026).
// Ключ — добавочный, значение — имя ровно как в amoCRM, чтобы сшивать со стафами.
const EXT = {
  "100": "Кристина Рагоза", "101": "Любовь Красикова", "102": "Артём Ларионов",
  "103": "Руфат Ягудин", "104": "Ани Рейнер", "105": "Дарья Шмидт", "106": "Илья Русанов",
  "120": "Мария Андреева", "121": "Анастасия Волик", "122": "Светлана Чернышова",
  "200": "Анастасия Плинер", "201": "Виктория Журавлёва", "202": "Алёна Романова",
  "203": "Маргарита Агеева", "204": "Елизавета Садыкова", "206": "Ирена Квеквескири",
  "207": "Ксения Зернова", "208": "Мария Калашникова", "211": "Ирина Зайцева",
  "212": "Алёна Сучкова", "214": "Мария Мудрак", "215": "Екатерина Романенко",
  "216": "Эльмира Ярунова", "218": "Екатерина Голубкова",
  "300": "Ксения Маслова", "301": "Денис Коростелкин", "302": "Максим Бакулин",
  "303": "Евгений Егошин", "304": "Алексей Бекназарян", "305": "Рустам Бурханов",
  "306": "Анна Шафранская", "307": "Мария Нефёдова", "308": "Владимир Иванишко",
  "309": "Анна Челышева", "315": "Светлана Сивашова",
  "400": "Маргарита Кузнецова", "401": "Александра Андрушко", "402": "Дарья Евдокимова",
  "403": "Анастасия Льдинина",
  "502": "Анастасия Маркина", "503": "Данил Инчин", "505": "Кристина Осипова",
  "506": "Екатерина Лемаева", "508": "Николай Коковякин"
};

let _auth = { at: 0, key_id: null, key: null };
async function auth() {
  const k = process.env.PBX_KEY;
  if (!k) throw new Error("нет PBX_KEY в .env");
  if (_auth.key_id && Date.now() - _auth.at < 30 * 60 * 1000) return _auth;
  const r = await axios.post(BASE + "/auth.json", "auth_key=" + encodeURIComponent(k),
    { headers: { "Content-Type": "application/x-www-form-urlencoded" }, timeout: 25000 });
  const d = r.data && r.data.data;
  if (!d || !d.key_id) throw new Error("АТС не авторизовала: " + JSON.stringify(r.data).slice(0, 200));
  _auth = { at: Date.now(), key_id: d.key_id, key: d.key };
  return _auth;
}

// Сводка за один месяц. Возвращает { byExt: {доб: {...}}, total: {...} }.
async function fetchMonth(year, mi) {
  const a = await auth();
  const H = { "x-pbx-authentication": a.key_id + ":" + a.key, "Content-Type": "application/x-www-form-urlencoded" };
  const days = new Date(Date.UTC(year, mi + 1, 0)).getUTCDate();
  const nowSec = Math.floor(Date.now() / 1000);
  const rows = [];
  for (let d0 = 1; d0 <= days; d0++) {
    const from = Math.floor(Date.UTC(year, mi, d0) / 1000) - 3 * 3600;
    const to = from + 86400;
    if (from > nowSec) break;                       // будущие дни не запрашиваем
    try {
      const r = await axios.post(BASE + "/mongo_history/search.json",
        "start_stamp_from=" + from + "&start_stamp_to=" + to + "&limit=5000",
        { headers: H, timeout: 60000, maxContentLength: 128 * 1024 * 1024 });
      const part = (r.data && r.data.data) || [];
      rows.push.apply(rows, part);
    } catch (e) { console.error("PBX день " + d0 + "." + (mi + 1) + ":", e && e.message); }
  }
  const byExt = {};
  const total = { inbound: 0, answered: 0, missed: 0, waitSum: 0, waitCnt: 0, outbound: 0 };
  const slot = (n) => byExt[n] || (byExt[n] = { answered: 0, missed: 0, outbound: 0, talkSec: 0, waitSum: 0, waitCnt: 0 });
  rows.forEach((c) => {
    const us = (c.events || []).filter((e) => e.type === "user" && e.number && EXT[String(e.number)]);
    const talked = us.filter((e) => (e.end_stamp - e.timestamp) > 0).sort((x, y) => x.timestamp - y.timestamp);
    if (c.accountcode === "outbound") {
      total.outbound++;
      const who = talked[0] || us[0];
      if (who) { const s = slot(String(who.number)); s.outbound++; s.talkSec += Math.max(0, c.duration || 0); }
      return;
    }
    if (c.accountcode !== "inbound") return;
    total.inbound++;
    if (talked.length) {
      const w = talked[0];
      const s = slot(String(w.number));
      s.answered++;
      s.talkSec += Math.max(0, (w.end_stamp - w.timestamp));
      const wait = w.timestamp - c.start_stamp;
      if (wait >= 0 && wait < 3600) { s.waitSum += wait; s.waitCnt++; total.waitSum += wait; total.waitCnt++; }
      total.answered++;
    } else {
      total.missed++;
    }
    // «Не ответил» — вызов предлагался оператору, но говорил не он.
    const answeredBy = new Set(talked.map((e) => String(e.number)));
    [...new Set(us.map((e) => String(e.number)))].forEach((n) => { if (!answeredBy.has(n)) slot(n).missed++; });
  });
  return { byExt, total, rows: rows.length };
}

function load() { try { return JSON.parse(fs.readFileSync(FILE, "utf8")); } catch (_) { return null; } }
function save(d) { try { fs.writeFileSync(FILE, JSON.stringify(d), "utf8"); } catch (e) { console.error("savePbx:", e.message); } }

// Обновляет статистику. Без аргументов — текущий и прошлый месяц (ночной режим);
// при отсутствии файла собирает весь год с начала.
async function run(opts) {
  const o = opts || {};
  const now = new Date(Date.now() + 3 * 3600 * 1000);
  const year = o.year || now.getUTCFullYear();
  let cur = load();
  if (!cur || cur.year !== year) cur = { ts: 0, year: year, months: {}, ext: EXT };
  let list = o.months;
  if (!list) {
    const has = Object.keys(cur.months).length;
    const m = now.getUTCMonth();
    list = has ? [Math.max(0, m - 1), m] : Array.from({ length: m + 1 }, (_, i) => i);
  }
  for (const mi of list) {
    try {
      const r = await fetchMonth(year, mi);
      cur.months[String(mi)] = { byExt: r.byExt, total: r.total };
      console.log("PBX: месяц " + (mi + 1) + " — записей " + r.rows + ", входящих " + r.total.inbound + ", пропущено " + r.total.missed);
    } catch (e) { console.error("PBX месяц " + (mi + 1) + ":", e && e.message); }
  }
  cur.ts = Date.now(); cur.ext = EXT;
  save(cur);
  return cur;
}

module.exports = { run, load, EXT, fetchMonth };
