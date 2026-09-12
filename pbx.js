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

// Справочник добавочных АТС читается ИЗ САМОЙ АТС при каждом пересчёте
// (POST /user/get.json — номер, имя, включён ли; POST /group/get.json — группы,
// откуда берётся состав «Первой Линии»). Люди приходят и уходят, руками такую
// карту не удержать. Карта ниже осталась запасной: если справочник не ответит,
// считаем по ней и пишем об этом в лог.
const EXT_FALLBACK = {
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
// Первая линия по умолчанию — если АТС не отдала группы.
const PL_FALLBACK = ["502", "503", "505", "506", "508"];

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

// Справочник АТС: кто есть в компании и кто числится в первой линии.
// Возвращает { ext: {добавочный: имя}, plExt: [...], groups: {название: [...]}, live: true }.
async function fetchRoster() {
  const a = await auth();
  const H = { "x-pbx-authentication": a.key_id + ":" + a.key, "Content-Type": "application/x-www-form-urlencoded" };
  const u = await axios.post(BASE + "/user/get.json", "", { headers: H, timeout: 25000 });
  const list = (u.data && u.data.data) || [];
  if (!list.length) throw new Error("АТС вернула пустой справочник пользователей");
  const ext = {};
  list.forEach((x) => { if (x && x.num && x.name && x.enabled !== false) ext[String(x.num)] = String(x.name).trim(); });
  const groups = {};
  let plExt = null;
  try {
    const g = await axios.post(BASE + "/group/get.json", "", { headers: H, timeout: 25000 });
    (g.data && g.data.data || []).forEach((gr) => {
      if (!gr || !gr.name) return;
      const nums = String(gr.users || "").split(";").map((n) => n.trim()).filter(Boolean);
      groups[String(gr.name).trim()] = nums;
      // В группе перечислены все номера отдела, включая незанятые. Оставляем тех,
      // у кого есть живой добавочный, иначе в знаменатель попадут пустые места.
      // \w с кириллицей в JS не работает — сопоставляем без классов символов.
      if (/перв.*лини/i.test(String(gr.name))) plExt = nums.filter((n) => ext[n]);
    });
  } catch (e) { console.error("PBX группы:", e && e.message); }
  return { ext: ext, plExt: (plExt && plExt.length) ? plExt : null, groups: groups, live: true };
}

// Сводка за один месяц. Возвращает { byExt: {доб: {...}}, total: {...} }.
async function fetchMonth(year, mi, extMap) {
  const EXT = extMap || EXT_FALLBACK;
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
  if (!cur || cur.year !== year) cur = { ts: 0, year: year, months: {}, ext: EXT_FALLBACK };
  // Сначала обновляем справочник: кто-то мог прийти, уйти или сменить добавочный.
  // Что изменилось — пишем в лог и сохраняем в снимок, чтобы это было видно в разделе.
  let roster = { ext: cur.ext || EXT_FALLBACK, plExt: cur.plExt || PL_FALLBACK, live: false };
  try {
    const fresh = await fetchRoster();
    const before = cur.ext || {};
    const added = Object.keys(fresh.ext).filter((n) => !before[n] || before[n] !== fresh.ext[n]);
    const removed = Object.keys(before).filter((n) => !fresh.ext[n]);
    if ((added.length || removed.length) && Object.keys(before).length) {
      console.log("PBX справочник: пришли/сменились " + (added.map((n) => n + " " + fresh.ext[n]).join(", ") || "—")
        + "; ушли " + (removed.map((n) => n + " " + before[n]).join(", ") || "—"));
      cur.rosterDiff = { ts: Date.now(), added: added.map((n) => ({ ext: n, name: fresh.ext[n] })), removed: removed.map((n) => ({ ext: n, name: before[n] })) };
    }
    roster = fresh;
    cur.rosterTs = Date.now();
  } catch (e) { console.error("PBX справочник недоступен, считаем по запасной карте:", e && e.message); }
  let list = o.months;
  if (!list) {
    const has = Object.keys(cur.months).length;
    const m = now.getUTCMonth();
    list = has ? [Math.max(0, m - 1), m] : Array.from({ length: m + 1 }, (_, i) => i);
  }
  for (const mi of list) {
    try {
      const r = await fetchMonth(year, mi, roster.ext);
      cur.months[String(mi)] = { byExt: r.byExt, total: r.total };
      console.log("PBX: месяц " + (mi + 1) + " — записей " + r.rows + ", входящих " + r.total.inbound + ", пропущено " + r.total.missed);
    } catch (e) { console.error("PBX месяц " + (mi + 1) + ":", e && e.message); }
  }
  cur.ts = Date.now();
  cur.ext = roster.ext; cur.plExt = roster.plExt || PL_FALLBACK; cur.rosterLive = !!roster.live;
  cur.groups = roster.groups || cur.groups || null;
  save(cur);
  return cur;
}

module.exports = { run, load, fetchMonth, fetchRoster, EXT_FALLBACK, PL_FALLBACK };
