// ═══════════════════════════════════════════════════════════════════════════
// Пакетные туры через Слетать.ру — поиск, подбор и оформление заявки с оплатой.
//
// Два разных сервиса Слетать.ру под одной учётной записью:
//   1) ПОИСК   — JSON, https://module.sletat.ru/Main.svc (GetTours, GetLoadState,
//      справочники GetCountries / GetDepartCities / GetCities / GetHotels…).
//   2) ЗАЯВКИ  — SOAP 1.1, https://claims.sletat.ru/XMLGate.svc (CreateClaim,
//      GetClaimInfo, GetActualization). Он же выдаёт ссылку на оплату.
//
// Почему всё ходит через наш сервер, а не из браузера клиента:
//   • Слетать требует, чтобы создание поиска, опрос статуса и забор результатов
//     шли с ОДНОГО IP — из браузера это не гарантируется;
//   • доступ выдаётся по Referer домена, привязанного к лицензии, — подставляем
//     его сами и не зависим от настроек браузера клиента;
//   • логин и пароль кабинета не покидают сервер.
//
// ЧТО МЫ ПОКУПАЕМ (по письмам Слетать.ру от 29.09.2026). У них две разные
// линейки, и путать их нельзя:
//   • «Модули поиска туров» — готовые виджеты в их вёрстке, вставляются кодом на
//     чужой сайт. 17 500–43 000 ₽/год. НАМ НЕ ПОДХОДЯТ: это не наш кабинет.
//   • «Шлюз поиска туров» (XML/JSON API) — то, на чём работает этот модуль.
//     Базовый: 15 000 ₽/3 мес, 24 000 ₽/6 мес, 42 000 ₽/год. Тест 2 недели.
//     С расширениями — 90 000 ₽/3 мес, 165 000 ₽/6 мес, 288 000 ₽/год.
// Базовый пакет — это ТОЛЬКО поиск. Чего в нём нет и как здесь обойдено:
//   – имя туроператора и ссылка на тур приходят лишь при оформлении заказа,
//     поэтому в карточке оператор может быть пустым (пишем «уточняется»);
//   – описаний, фото и отзывов по отелям нет (расширение «Отельная база»);
//   – доплат, времени и аэропорта вылета нет до актуализации заявки
//     (расширение «Детальная актуализация») — про это честно сказано в форме.
// Лимит: 20 000 поисков в месяц в базовом пакете, сверх — 10 коп./запрос
// автосчётом в следующем месяце. Отсюда счётчик и кэш ниже.
//
// ЛИЦЕНЗИЯ. Пока домен не привязан к купленной лицензии, шлюз отвечает
// демо-выдачей: туры 2014 года по Египту с оператором «Демо Sletat.ru». Это не
// ошибка интеграции, а режим по умолчанию. Живые туры появятся сразу после
// привязки домена, менять код не нужно. Признак демо-данных отдаётся наружу
// полем demo, чтобы страница честно про это писала.
//
// ОГРАНИЧЕНИЕ СЕРВИСА, про которое нельзя забыть: брони «в один клик» у Слетать
// нет ни в каком виде. Клиент оплачивает (деньги холдируются), заявка уходит
// менеджеру, менеджер бронирует тур у туроператора руками и только потом даёт
// команду на списание. Поэтому здесь честный статус «заявка принята, ждём
// подтверждения оператора», а не «забронировано».
//
// env: SLETAT_LOGIN, SLETAT_PASSWORD — учётка кабинета sletat.ru (нужна для
//      заявок; поиск работает и без неё, в демо-режиме),
//      SLETAT_REFERER — домен, привязанный к лицензии (по умолчанию voyotravel.ru),
//      SLETAT_MARKUP_PCT — наша наценка в процентах поверх цены оператора (0 = без),
//      SLETAT_WORKFLOW — preprocessing (по умолчанию, менеджер ведёт заказ) или
//      twostep (клиент платит сразу после заявки).
// ═══════════════════════════════════════════════════════════════════════════
const fs = require("fs");
const path = require("path");
const https = require("https");

const DIR = path.join(__dirname, ".sletat");
const CLAIMS_FILE = path.join(DIR, "claims.json");
const DICT_FILE = path.join(DIR, "dict.json");
const USAGE_FILE = path.join(DIR, "usage.json");

const SEARCH_BASE = "https://module.sletat.ru/Main.svc";
const CLAIMS_URL = "https://claims.sletat.ru/XMLGate.svc";
const REFERER = process.env.SLETAT_REFERER || "https://voyotravel.ru/";
const LOGIN = process.env.SLETAT_LOGIN || "";
const PASSWORD = process.env.SLETAT_PASSWORD || "";
const MARKUP_PCT = Number(process.env.SLETAT_MARKUP_PCT || 0);
const WORKFLOW = /twostep/i.test(String(process.env.SLETAT_WORKFLOW || "")) ? 1 : 0;
const DICT_TTL = 24 * 3600 * 1000;

// Поиск у Слетать.ру тарифицируется ПОШТУЧНО: в пакет входит 20 000 запросов в
// месяц, каждый сверх пакета — 10 копеек, счёт приходит в следующем месяце уже
// по факту. Поэтому запросы считаем сами, а одинаковые в пределах четверти часа
// не отправляем повторно: выдача за это время всё равно не меняется.
const QUOTA = Number(process.env.SLETAT_QUOTA || 20000);
const CACHE_TTL = Number(process.env.SLETAT_CACHE_MIN || 15) * 60000;

function ensureDir() { try { fs.mkdirSync(DIR, { recursive: true }); } catch (_) {} }
function readJson(p, dflt) { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch (_) { return dflt; } }
function writeJson(p, d) { ensureDir(); try { fs.writeFileSync(p, JSON.stringify(d), "utf8"); } catch (e) { console.error("sletat write:", e.message); } }

/* ──────────────────── Счётчик оплачиваемых запросов ─────────────────────── */
// Считаем помесячно и храним год с лишним: когда придёт автосчёт за перерасход,
// будет с чем сверить. Сэкономленные кэшем запросы считаем отдельно — по ним
// видно, нужен ли вообще расширенный пакет.

function monthKey(d) {
  const t = d || new Date();
  return t.getFullYear() + "-" + String(t.getMonth() + 1).padStart(2, "0");
}

function usageAll() { return readJson(USAGE_FILE, {}); }

function usageBump(field) {
  const all = usageAll();
  const k = monthKey();
  const cur = all[k] || (all[k] = { searches: 0, cached: 0, claims: 0 });
  cur[field] = (cur[field] || 0) + 1;
  const keep = Object.keys(all).sort().slice(-13);
  const trimmed = {};
  keep.forEach((x) => { trimmed[x] = all[x]; });
  writeJson(USAGE_FILE, trimmed);
  if (field === "searches" && cur.searches === QUOTA) {
    console.error("SLETAT: месячный пакет поисков исчерпан (" + QUOTA + ") — дальше 10 коп./запрос");
  }
  return cur;
}

/* ─────────────────── Кэш поиска, чтобы не платить дважды ─────────────────── */
// Один и тот же запрос (страна, даты, состав) в пределах CACHE_TTL отдаётся из
// памяти вместе со старым requestId: дозагрузка результатов по нему у Слетать
// отдельным запросом не считается.

const _cache = new Map();

function cacheKey(q) {
  return JSON.stringify([
    q.cityFromId, q.countryId, q.adults || 2, q.kids || 0, q.kidsAges || [],
    q.nightsMin || 7, q.nightsMax || 10, q.departFrom || "", q.departTo || "",
    q.priceMin || 0, q.priceMax || 0, q.stars || [], q.meals || [], q.resorts || [], !!q.noFlight,
  ]);
}

function cacheGet(k) {
  const v = _cache.get(k);
  if (!v) return null;
  if (Date.now() - v.at > CACHE_TTL) { _cache.delete(k); return null; }
  return v;
}

function cachePut(k, v) {
  _cache.set(k, Object.assign({ at: Date.now() }, v));
  if (_cache.size > 300) _cache.delete(_cache.keys().next().value);
}

/* ─────────────────────────── HTTP к Слетать ──────────────────────────────── */

function httpGet(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        Referer: REFERER,
        "User-Agent": "VOYO/1.0 (+https://voyotravel.ru)",
        Accept: "application/json",
      },
    }, (r) => {
      let b = ""; r.setEncoding("utf8");
      r.on("data", (c) => (b += c));
      r.on("end", () => resolve({ status: r.statusCode, body: b }));
    });
    req.setTimeout(timeoutMs || 30000, () => { req.destroy(new Error("таймаут Слетать.ру")); });
    req.on("error", reject);
  });
}

function httpPostXml(url, xml, soapAction, timeoutMs) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname, path: u.pathname, method: "POST",
      headers: {
        "Content-Type": "text/xml; charset=utf-8",
        "Content-Length": Buffer.byteLength(xml),
        SOAPAction: soapAction,
        Referer: REFERER,
      },
    }, (r) => {
      let b = ""; r.setEncoding("utf8");
      r.on("data", (c) => (b += c));
      r.on("end", () => resolve({ status: r.statusCode, body: b }));
    });
    req.setTimeout(timeoutMs || 60000, () => { req.destroy(new Error("таймаут заявок Слетать.ру")); });
    req.on("error", reject);
    req.write(xml);
    req.end();
  });
}

function qs(params) {
  const p = [];
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === "") continue;
    if (Array.isArray(v)) { v.forEach((x) => p.push(encodeURIComponent(k) + "=" + encodeURIComponent(x))); continue; }
    p.push(encodeURIComponent(k) + "=" + encodeURIComponent(v));
  }
  return p.length ? "?" + p.join("&") : "";
}

// Учётку шлюз спрашивает ТОЛЬКО у поиска (GetTours и опрос его состояния).
// Справочники открываются одной лицензией на Referer — и если приложить к ним
// логин, который шлюз не признаёт, они падают вместе с поиском, а форма в
// кабинете остаётся с пустыми списками городов и стран. Поэтому сюда логин не
// кладём: справочники должны жить своей жизнью.
const AUTHED = { GetTours: 1, GetLoadState: 1 };
function auth(method) { return (AUTHED[method] && LOGIN) ? { login: LOGIN, password: PASSWORD } : {}; }

async function api(method, params, timeoutMs) {
  const r = await httpGet(SEARCH_BASE + "/" + method + qs(Object.assign({}, auth(method), params || {})), timeoutMs);
  let j;
  try { j = JSON.parse(r.body); }
  catch (e) { throw new Error("Слетать.ру вернул не JSON (" + r.status + "): " + String(r.body).slice(0, 160)); }
  const res = j[method + "Result"];
  if (!res) throw new Error("неожиданный ответ " + method);
  if (res.IsError) throw new Error(res.ErrorMessage || "ошибка " + method);
  return res.Data;
}

/* ───────────────────────────── Справочники ──────────────────────────────── */
// Страны и города вылета меняются раз в сезон — держим сутки в файле, чтобы не
// дёргать шлюз на каждом открытии страницы.

let _dict = null;
async function dict(force) {
  if (!_dict) _dict = readJson(DICT_FILE, null);
  if (!force && _dict && Date.now() - (_dict.ts || 0) < DICT_TTL) return _dict;
  const [countries, departs] = await Promise.all([
    api("GetCountries", {}),
    api("GetDepartCities", {}),
  ]);
  _dict = {
    ts: Date.now(),
    countries: (countries || [])
      .filter((c) => c && c.Name)
      .map((c) => ({ id: c.Id, name: c.Name, visa: !!c.IsVisa, rank: c.Rank || 0 }))
      .sort((a, b) => a.name.localeCompare(b.name, "ru")),
    departs: (departs || [])
      .filter((c) => c && c.Name && !c.Hidden)
      .map((c) => ({ id: c.Id, name: c.Name, popular: !!c.IsPopular, def: !!c.Default })),
  };
  writeJson(DICT_FILE, _dict);
  return _dict;
}

/* ───────────────────────── Разбор выдачи GetTours ───────────────────────── */
// Ответ приходит массивом массивов (aaData) — по сто колонок в строке, без имён.
// Индексы сверены на живом ответе 29.09.2026; если Слетать поменяет порядок,
// ломаться будет именно здесь, поэтому разбор собран в одном месте.
const C = {
  offerId: 0, sourceId: 1, hotelUrl: 2, hotelId: 3, resortId: 5, route: 6,
  hotelStars: 7, stars: 8, roomType: 9, mealCode: 10, placement: 11,
  checkIn: 12, checkOut: 13, nights: 14, operator: 15, adults: 16, kids: 17,
  resort: 19, photo: 29, countryId: 30, country: 31, cityFromId: 32, cityFrom: 33,
  rating: 35, price: 42, currency: 43, hotelName: 48, meal: 51, tourists: 53,
  lat: 92, lon: 93,
};

const num = (v) => { const n = Number(String(v).replace(/[^\d.-]/g, "")); return isFinite(n) ? n : 0; };
const clean = (v) => String(v == null ? "" : v).replace(/&nbsp;/g, " ").trim();

function markup(price) {
  if (!MARKUP_PCT) return price;
  return Math.round(price * (1 + MARKUP_PCT / 100));
}

function parseRow(row) {
  const base = num(row[C.price]);
  const photo = clean(row[C.photo]);
  return {
    offerId: String(row[C.offerId] || ""),
    sourceId: Number(row[C.sourceId]) || 0,
    // В базовом пакете имя оператора закрыто, и в этой колонке приходит цена
    // строкой («17216 RUB»). Её не показываем — клиент увидит «уточняется».
    operator: /^[\d\s.,]+[A-Z]{3}$/.test(clean(row[C.operator])) ? "" : clean(row[C.operator]),
    hotel: clean(row[C.hotelName]) || clean(row[C.hotelStars]),
    stars: clean(row[C.stars]),
    rating: num(row[C.rating]) || null,
    country: clean(row[C.country]),
    countryId: Number(row[C.countryId]) || 0,
    resort: clean(row[C.resort]),
    cityFrom: clean(row[C.cityFrom]),
    checkIn: clean(row[C.checkIn]),
    checkOut: clean(row[C.checkOut]),
    nights: Number(row[C.nights]) || 0,
    meal: clean(row[C.meal]) || clean(row[C.mealCode]),
    room: clean(row[C.roomType]),
    placement: clean(row[C.placement]),
    adults: Number(row[C.adults]) || 0,
    kids: Number(row[C.kids]) || 0,
    price: markup(base),
    priceBase: base,
    currency: clean(row[C.currency]) || "RUB",
    photo: photo ? (photo.startsWith("//") ? "https:" + photo : photo) : "",
    hotelUrl: clean(row[C.hotelUrl]),
    coords: (num(row[C.lat]) && num(row[C.lon])) ? { lat: num(row[C.lat]), lon: num(row[C.lon]) } : null,
  };
}

// Демо-выдачу видно по имени оператора и по датам из прошлого — пишем об этом
// честно, иначе страница выглядит сломанной.
function looksDemo(tours) {
  if (!tours.length) return false;
  return tours.every((t) => /демо|demo/i.test(t.operator))
    || tours.every((t) => /\.20(1[0-9]|2[0-4])$/.test(t.checkIn));
}

/* ─────────────────────────────── Поиск ──────────────────────────────────── */

// Даты шлюз понимает только как дд/мм/гггг. С точками он их молча игнорирует и
// отдаёт вылеты с сегодняшнего дня — проверено на живой выдаче 30.09.2026.
const slashDate = (s) => (s ? String(s).replace(/\./g, "/") : undefined);

const SEARCH_PARAMS = (q) => ({
  cityFromId: q.cityFromId,
  countryId: q.countryId,
  s_adults: q.adults || 2,
  s_kids: q.kids || 0,
  s_kids_ages: q.kidsAges && q.kidsAges.length ? q.kidsAges : undefined,
  s_nightsMin: q.nightsMin || 7,
  s_nightsMax: q.nightsMax || 10,
  s_departFrom: slashDate(q.departFrom),
  s_departTo: slashDate(q.departTo),
  s_priceMin: q.priceMin || undefined,
  s_priceMax: q.priceMax || undefined,
  stars: q.stars && q.stars.length ? q.stars : undefined,
  meals: q.meals && q.meals.length ? q.meals : undefined,
  cities: q.resorts && q.resorts.length ? q.resorts : undefined,
  s_hotelIsNotInStop: true,
  s_hasTickets: true,
  // Без этого флага шлюз отдаёт и «только отель» (его клиент выбирает сам фильтром «Перелёт») — Турция на двоих за 13 тысяч
  // без билетов. Нам нужен пакет: перелёт обязан входить в цену.
  s_ticketsIncluded: q.noFlight ? undefined : true,
  currencyAlias: "RUB",
  includeDescriptions: 1,
});

// Первый вызов создаёт поиск и возвращает requestId. Результаты забираем
// отдельно: у Слетать выдача наполняется по мере ответа операторов.
async function searchStart(q) {
  const key = cacheKey(q);
  const hit = cacheGet(key);
  if (hit) {
    usageBump("cached");
    return { requestId: hit.requestId, tours: hit.tours, total: hit.total, cached: true };
  }
  const data = await api("GetTours", SEARCH_PARAMS(q), 40000);
  usageBump("searches");
  const out = {
    requestId: data && (data.requestId || data.RequestId) || null,
    tours: ((data && data.aaData) || []).map(parseRow),
    total: (data && data.iTotalRecords) || 0,
    cached: false,
  };
  if (out.requestId) cachePut(key, out);
  return out;
}

// Статус опрашиваем ТОЛЬКО этим методом: опрос через GetTours у Слетать
// считается нарушением и грозит отзывом лицензии (прямо написано в их вики).
async function searchState(requestId) {
  const data = await api("GetLoadState", { requestId: requestId }, 20000);
  const list = Array.isArray(data) ? data : (data && data.LoadState) || [];
  const done = list.filter((x) => x && x.IsProcessed).length;
  const rows = list.reduce((s, x) => s + ((x && x.RowsCount) || 0), 0);
  return { operators: list.length, processed: done, rows: rows, ready: list.length > 0 && done >= list.length };
}

// minStars — фильтр по звёздам на нашей стороне: у шлюза звёзды задаются его
// внутренними кодами, а нам нужно простое «от 4 звёзд». Поэтому берём страницу
// пошире (одним запросом, стоимость та же) и отсекаем сами. Отели с оценкой
// туристов ниже 7 из 10 в выдачу с фильтром тоже не пускаем.
const starsOf = (t) => Number(String(t.stars || "").replace(/[^\d]/g, "").slice(0, 1)) || 0;

// Питание по возрастанию: без питания < завтраки < полупансион < пансион < всё включено.
function mealRank(code) {
  const c = String(code || "").toUpperCase().replace(/\s+/g, "");
  if (/^UAI|ULTRA/.test(c)) return 5;
  if (/^AI|ALL/.test(c)) return 4;
  if (/^FB/.test(c)) return 3;
  if (/^HB/.test(c)) return 2;
  if (/^BB/.test(c)) return 1;
  return 0;
}

async function searchResults(requestId, page, pageSize, minStars, minMeal) {
  const want = pageSize || 30;
  // Выдача для страницы (minStars передан, хоть 0): вся выборка разом, по отелю
  // одна карточка. Подборки зовут без него и получают сырую страницу.
  const shelf = minStars !== undefined;
  const data = await api("GetTours", {
    requestId: requestId, updateResult: 1,
    pageNumber: shelf ? 1 : (page || 1), pageSize: shelf ? 3000 : want,
    currencyAlias: "RUB",
  }, 40000);
  let tours = ((data && data.aaData) || []).map(parseRow);
  const demo = looksDemo(tours);
  if (shelf) {
    tours = tours.filter((t) => (!minStars || (starsOf(t) >= minStars && !(t.rating && t.rating < 7)))
        && (!minMeal || mealRank(t.meal) >= minMeal));
    // Один отель — одна карточка, самый дешёвый вариант. Вперёд отели, которые
    // туристы оценили от 7,5 из 10, дальше остальные; внутри групп — по цене.
    const byHotel = {};
    tours.forEach((t) => { const k = t.hotel + "|" + t.resort; if (!byHotel[k] || t.price < byHotel[k].price) byHotel[k] = t; });
    const liked = (t) => (t.rating || 0) >= 7.5 ? 0 : 1;
    tours = Object.values(byHotel)
      .sort((a, b) => (liked(a) - liked(b)) || (a.price - b.price))
      .slice(0, want);
    return { tours: tours, total: tours.length, demo: demo };
  }
  return { tours: tours, total: (data && data.iTotalRecords) || tours.length, demo: demo };
}

/* ─────────────────────── Подборки под формой поиска ─────────────────────── */
// Пустая страница с одной формой выглядит как незаполненный бланк, поэтому под
// поиском показываем живые направления: самое дешёвое предложение по каждому и
// отели с лучшими оценками. Данные собираются фоном — по одному оплачиваемому
// запросу на направление раз в шесть часов, это около тысячи запросов в месяц
// из двадцати тысяч пакета.
//
// Пока шлюз не пускает, файл остаётся пустым: страница в этом случае рисует те
// же плитки без цен, они всё равно работают как быстрый выбор направления.

const PICKS_FILE = path.join(DIR, "picks.json");
const PICKS_TTL = 6 * 3600 * 1000;

// Города вылета у направлений разные не бывают — считаем от Москвы, она же
// стоит в форме по умолчанию.
const PICK_FROM = Number(process.env.SLETAT_PICK_FROM || 832);
const PICK_DIRECTIONS = [
  { id: 119, name: "Турция", hue: "#2e86c1" },
  { id: 40, name: "Египет", hue: "#c8823a" },
  { id: 90, name: "ОАЭ", hue: "#8e6fb5" },
  { id: 113, name: "Таиланд", hue: "#2f9e7a" },
  { id: 29, name: "Вьетнам", hue: "#3a9ec8" },
  { id: 72, name: "Мальдивы", hue: "#1f9bb3" },
  { id: 132, name: "Шри-Ланка", hue: "#4f9a4a" },
  { id: 61, name: "Куба", hue: "#c2603f" },
];

function picksLoad() { return readJson(PICKS_FILE, { at: 0, cheap: [], top: [] }); }

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// Один проход по направлению: создаём поиск, ждём операторов и забираем выдачу.
async function pickOne(dir) {
  const today = new Date();
  const from = new Date(today.getTime() + 7 * 86400000);
  const to = new Date(today.getTime() + 45 * 86400000);
  const fmt = (d) => String(d.getDate()).padStart(2, "0") + "." + String(d.getMonth() + 1).padStart(2, "0") + "." + d.getFullYear();
  const q = {
    cityFromId: PICK_FROM, countryId: dir.id, adults: 2, kids: 0,
    nightsMin: 6, nightsMax: 8, departFrom: fmt(from), departTo: fmt(to),
  };
  const started = await searchStart(q);
  if (!started.requestId) return null;
  for (let i = 0; i < 12; i++) {
    await wait(2000);
    let st;
    try { st = await searchState(started.requestId); } catch (_) { break; }
    if (st.ready) break;
  }
  const res = await searchResults(started.requestId, 1, 1000);
  const tours = (res.tours || []).filter((t) => t.price > 0);
  if (!tours.length || res.demo) return null;
  const cheapest = tours.slice().sort((a, b) => a.price - b.price)[0];
  return { dir: dir, cheapest: cheapest, deals: pickDeals(tours) };
}

// «Хорошие отели по хорошей цене»: четыре-пять звёзд и оценка туристов от 8 из
// 10, по каждому отелю берём самый дешёвый вариант. Самые дешёвые туры — это
// обычно двушки и апартаменты без питания, на витрину они не годятся.
function pickDeals(tours) {
  const good = (minRating) => tours.filter((t) => starsOf(t) >= 4 && (t.rating || 0) >= minRating && t.photo);
  let list = good(8);
  if (list.length < 3) list = good(7);
  // По многим странам оценок туристов у поставщика нет вовсе — тогда берём
  // лучшие по звёздам: сначала 5★, потом 4★, по два отеля.
  if (!list.length) {
    const seen = {};
    return tours.filter((t) => starsOf(t) >= 4 && t.photo)
      .sort((a, b) => (starsOf(b) - starsOf(a)) || (a.price - b.price))
      .filter((t) => (seen[t.hotel] ? false : (seen[t.hotel] = true)))
      .slice(0, 2);
  }
  const byHotel = {};
  list.forEach((t) => { const k = t.hotel; if (!byHotel[k] || t.price < byHotel[k].price) byHotel[k] = t; });
  return Object.values(byHotel)
    .sort((a, b) => (b.rating - a.rating) || (a.price - b.price))
    .slice(0, 4);
}

let _picksRunning = false;
async function refreshPicks() {
  if (_picksRunning) return picksLoad();
  _picksRunning = true;
  const cheap = [], top = [];
  try {
    for (const dir of PICK_DIRECTIONS) {
      let r = null;
      try { r = await pickOne(dir); }
      catch (e) { console.error("SLETAT подборка " + dir.name + ":", e.message); }
      if (!r) continue;
      cheap.push({
        country: dir.name, countryId: dir.id, hue: dir.hue,
        price: r.cheapest.price, nights: r.cheapest.nights,
        hotel: r.cheapest.hotel, resort: r.cheapest.resort, photo: r.cheapest.photo,
      });
      r.deals.forEach((t) => top.push({
        country: dir.name, countryId: dir.id, hue: dir.hue,
        hotel: t.hotel, stars: t.stars, rating: t.rating, meal: t.meal,
        resort: t.resort, price: t.price, nights: t.nights, checkIn: t.checkIn, photo: t.photo,
      }));
      await wait(1500);           // не молотим шлюз очередью
    }
  } finally { _picksRunning = false; }
  cheap.sort((a, b) => a.price - b.price);
  // Витрина вперемешку по странам: первый лучший отель каждой страны, потом второй…
  const rounds = [];
  top.forEach((t) => {
    const n = top.filter((x) => x.countryId === t.countryId).indexOf(t);
    (rounds[n] = rounds[n] || []).push(t);
  });
  const shelf = [].concat(...rounds.map((r) => r.sort((a, b) => b.rating - a.rating)));
  const data = { at: Date.now(), cheap: cheap, top: shelf.slice(0, 12) };
  if (cheap.length) writeJson(PICKS_FILE, data);
  return data;
}

function picksSchedule() {
  const tick = () => {
    const p = picksLoad();
    if (Date.now() - (p.at || 0) < PICKS_TTL) return;
    refreshPicks().then((d) => {
      if (d.cheap.length) console.log("SLETAT: подборки обновлены, направлений " + d.cheap.length);
    }).catch((e) => console.error("SLETAT подборки:", e.message));
  };
  setTimeout(tick, 90000);        // после старта даём серверу прогреться
  setInterval(tick, 3600000);
}

/* ─────────────────────────── Заявка и оплата ────────────────────────────── */

const esc = (s) => String(s == null ? "" : s)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;").replace(/'/g, "&apos;");

function soapEnvelope(bodyXml) {
  return '<?xml version="1.0" encoding="utf-8"?>'
    + '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/">'
    + '<s:Header><AuthInfo xmlns="urn:SletatRu:DataTypes:AuthData:v1">'
    + "<Login>" + esc(LOGIN) + "</Login><Password>" + esc(PASSWORD) + "</Password>"
    + "</AuthInfo></s:Header>"
    + "<s:Body>" + bodyXml + "</s:Body></s:Envelope>";
}

// Достаём значение тега без полноценного парсера: ответы плоские, а тянуть
// зависимость ради шести полей не хочется.
function tag(xml, name) {
  const m = new RegExp("<(?:\\w+:)?" + name + "[^>]*>([\\s\\S]*?)</(?:\\w+:)?" + name + ">").exec(xml);
  return m ? m[1].trim() : "";
}
function soapFault(xml) {
  const f = tag(xml, "faultstring");
  return f || "";
}

function touristXml(t) {
  return "<b:Tourist>"
    + "<b:BirthDate>" + esc(t.birthDate || "1990-01-01") + "</b:BirthDate>"
    + "<b:Citizenship>" + esc(t.citizenship || "Россия") + "</b:Citizenship>"
    + "<b:FirstName>" + esc(t.firstName) + "</b:FirstName>"
    + "<b:Surname>" + esc(t.surname) + "</b:Surname>"
    + (t.patronymic ? "<b:Patronymic>" + esc(t.patronymic) + "</b:Patronymic>" : "")
    + (t.passportSeries ? "<b:PassportSeries>" + esc(t.passportSeries) + "</b:PassportSeries>" : "")
    + (t.passportNumber ? "<b:PassportNumber>" + esc(t.passportNumber) + "</b:PassportNumber>" : "")
    + (t.expires ? "<b:Expires>" + esc(t.expires) + "</b:Expires>" : "")
    + (t.phone ? "<b:Phone>" + esc(t.phone) + "</b:Phone>" : "")
    + (t.email ? "<b:Email>" + esc(t.email) + "</b:Email>" : "")
    + "</b:Tourist>";
}

async function createClaim(o) {
  if (!LOGIN) throw new Error("не задана учётка Слетать.ру (SLETAT_LOGIN/SLETAT_PASSWORD) — заявку отправить некуда");
  const body = '<CreateClaim xmlns="urn:SletatRu:XMLClaimsGate:v1">'
    + '<request xmlns:a="urn:SletatRu:Contracts:ClaimsGate:DataTypes:v1" xmlns:b="urn:SletatRu:Contracts:ClaimsGate:DataTypes:XML:v1">'
    + "<a:Comments>" + esc(o.comment || "Заявка с сайта VOYO") + "</a:Comments>"
    + "<a:Customer>"
    + "<a:Email>" + esc(o.customer.email) + "</a:Email>"
    + "<a:FullName>" + esc(o.customer.fullName) + "</a:FullName>"
    + "<a:Phone>" + esc(o.customer.phone) + "</a:Phone>"
    + (o.customer.address ? "<a:Address>" + esc(o.customer.address) + "</a:Address>" : "")
    + "</a:Customer>"
    + "<a:InitialURL>" + esc(o.returnUrl || (REFERER + "packages")) + "</a:InitialURL>"
    + "<a:OfferId>" + esc(o.offerId) + "</a:OfferId>"
    + "<a:RequestId>" + esc(o.requestId) + "</a:RequestId>"
    + "<a:SourceId>" + esc(o.sourceId) + "</a:SourceId>"
    + "<a:Actualize>true</a:Actualize>"
    + "<a:WorkflowType>" + (WORKFLOW === 1 ? "TwoStepsHolding" : "Preprocessing") + "</a:WorkflowType>"
    + "<b:Tourists>" + (o.tourists || []).map(touristXml).join("") + "</b:Tourists>"
    + "</request></CreateClaim>";
  const r = await httpPostXml(CLAIMS_URL, soapEnvelope(body), "urn:SletatRu:XMLClaimsGate:v1/XMLClaimsGate/CreateClaim");
  const fault = soapFault(r.body);
  if (fault) throw new Error("Слетать.ру отклонил заявку: " + fault);
  const ok = /true/i.test(tag(r.body, "OperationStatus"));
  const msg = tag(r.body, "ServiceMessage");
  if (!ok) throw new Error(msg || "заявка не создана");
  return { claimId: tag(r.body, "ClaimIdentity"), number: tag(r.body, "OrderIdentity"), message: msg };
}

async function claimInfo(claimId) {
  const body = '<GetClaimInfo xmlns="urn:SletatRu:XMLClaimsGate:v1">'
    + '<request xmlns:a="urn:SletatRu:Contracts:ClaimsGate:DataTypes:v1">'
    + "<a:ClaimIdentity>" + esc(claimId) + "</a:ClaimIdentity>"
    + "</request></GetClaimInfo>";
  const r = await httpPostXml(CLAIMS_URL, soapEnvelope(body), "urn:SletatRu:XMLClaimsGate:v1/XMLClaimsGate/GetClaimInfo");
  const fault = soapFault(r.body);
  if (fault) throw new Error("Слетать.ру: " + fault);
  return {
    number: tag(r.body, "Number"),
    status: tag(r.body, "Status"),
    payable: /true/i.test(tag(r.body, "PaymentIsAvailable")),
    payUrl: tag(r.body, "RedirectToPaymentURL"),
    payableUntil: tag(r.body, "PayableUntil"),
    actualization: tag(r.body, "CurrentState"),
    price: num(tag(r.body, "Price")) || null,
  };
}

/* ──────────────────────────── Журнал заявок ─────────────────────────────── */
// Содержит ПДн туристов, поэтому только на проде и мимо git (.gitignore).

function claimsLoad() { return readJson(CLAIMS_FILE, { items: [] }); }
function claimsSave(d) { writeJson(CLAIMS_FILE, d); }
function claimAdd(rec) {
  const d = claimsLoad();
  d.items.unshift(rec);
  if (d.items.length > 500) d.items.length = 500;
  claimsSave(d);
}
function claimPatch(claimId, patch) {
  const d = claimsLoad();
  const it = d.items.find((x) => x.claimId === claimId);
  if (it) { Object.assign(it, patch); claimsSave(d); }
  return it || null;
}

/* ──────────────────────────────── Монтаж ────────────────────────────────── */

// Внутренности поставщика клиенту показывать нельзя: «Логин и/или пароль указаны
// неверно» на витрине выглядит как сломанный кабинет, хотя это всего лишь
// незакрытый доступ к шлюзу. Настоящий текст уходит в лог, наружу — человеческий.
// Различаем три случая: шлюз нас ещё не пускает (это не ошибка клиента и не
// повод пугать его красным), поставщик молчит, и всё остальное.
function errKind(e) {
  const m = String((e && e.message) || e);
  if (/логин|пароль|авторизац|лиценз|licen|referer|доступ|denied|forbidden|40[13]/i.test(m)) return "gateway";
  if (/таймаут|timeout|ETIMEDOUT|ECONNRESET|ENOTFOUND|EAI_AGAIN/i.test(m)) return "slow";
  return "other";
}

function humanError(e) {
  const k = errKind(e);
  if (k === "gateway") {
    return "Онлайн-поиск туров сейчас подключается. Это не займёт много времени, "
      + "а пока тур для вас подберёт менеджер — по тем же ценам туроператоров.";
  }
  if (k === "slow") return "Поставщик не ответил вовремя. Попробуйте ещё раз через минуту.";
  return "Не удалось получить туры. Попробуйте сдвинуть даты или повторить поиск.";
}

// Защита от заевшей кнопки и от ботов: каждый лишний старт поиска стоит денег.
const _last = new Map();
function throttled(ip) {
  const now = Date.now();
  if (now - (_last.get(ip) || 0) < 2500) return true;
  if (_last.size > 1000) _last.clear();
  _last.set(ip, now);
  return false;
}

function mount(app, deps) {
  const requireAdmin = (deps && deps.requireAdmin) || ((req, res) => res.status(403).json({ success: false, message: "Нет доступа" }));
  const fail = (res, e) => {
    console.error("SLETAT:", e && e.message);
    res.json({ success: false, message: humanError(e), kind: errKind(e) });
  };

  app.get("/packages", (req, res) => {
    res.set("Cache-Control", "no-cache");
    res.sendFile(path.join(__dirname, "public", "packages.html"));
  });

  // Справочники для формы поиска.
  app.get("/api/sletat/dict", async (req, res) => {
    try { res.json({ success: true, data: await dict(req.query.force === "1") }); }
    catch (e) { fail(res, e); }
  });

  // Старт поиска: отдаём requestId и то, что успело прийти.
  app.post("/api/sletat/search", async (req, res) => {
    try {
      const q = req.body || {};
      if (!q.cityFromId || !q.countryId) return res.json({ success: false, message: "Выберите город вылета и страну" });
      if (throttled(req.ip || "?")) return res.json({ success: false, message: "Подождите пару секунд — поиск уже идёт." });
      const r = await searchStart(q);
      res.json({ success: true, requestId: r.requestId, tours: r.tours, total: r.total, demo: looksDemo(r.tours), hasLicense: !!LOGIN });
    } catch (e) { fail(res, e); }
  });

  app.get("/api/sletat/state", async (req, res) => {
    try { res.json({ success: true, data: await searchState(req.query.requestId) }); }
    catch (e) { fail(res, e); }
  });

  app.get("/api/sletat/results", async (req, res) => {
    try {
      const r = await searchResults(req.query.requestId, Number(req.query.page) || 1, Number(req.query.pageSize) || 30, Math.min(5, Number(req.query.minStars) || 0), Math.min(5, Number(req.query.minMeal) || 0));
      res.json({ success: true, tours: r.tours, total: r.total, demo: r.demo });
    } catch (e) { fail(res, e); }
  });

  // Заявка: создаём у Слетать, кладём в свой журнал и сразу спрашиваем ссылку
  // на оплату. Актуализация идёт асинхронно, поэтому ссылки может ещё не быть —
  // страница дотягивает её по /api/sletat/claim/:id.
  app.post("/api/sletat/claim", async (req, res) => {
    try {
      const b = req.body || {};
      const c = b.customer || {};
      if (!c.fullName || !c.phone || !c.email) return res.json({ success: false, message: "Нужны имя, телефон и email заказчика" });
      if (!b.offerId || !b.requestId || !b.sourceId) return res.json({ success: false, message: "Тур не выбран" });
      const created = await createClaim(b);
      usageBump("claims");
      claimAdd({
        at: Date.now(), claimId: created.claimId, number: created.number,
        offerId: String(b.offerId), sourceId: Number(b.sourceId), requestId: String(b.requestId),
        tour: b.tour || null, customer: c, tourists: b.tourists || [], status: "created",
      });
      let info = null;
      try { info = await claimInfo(created.claimId); } catch (_) {}
      res.json({ success: true, claimId: created.claimId, number: created.number, info: info });
    } catch (e) { fail(res, e); }
  });

  app.get("/api/sletat/claim/:id", async (req, res) => {
    try {
      const info = await claimInfo(req.params.id);
      claimPatch(req.params.id, { status: info.status, payUrl: info.payUrl, price: info.price });
      res.json({ success: true, data: info });
    } catch (e) { fail(res, e); }
  });

  // Журнал заявок — только админ: внутри паспорта и телефоны.
  app.get("/api/sletat/claims", requireAdmin, (req, res) => {
    res.json({ success: true, data: claimsLoad().items.slice(0, 100) });
  });

  // Подборки под формой. Отдаём и пустые — страница сама нарисует направления
  // без цен, чтобы раздел не выглядел голым.
  app.get("/api/sletat/picks", (req, res) => {
    const p = picksLoad();
    res.json({
      success: true,
      data: {
        at: p.at || 0, cheap: p.cheap || [], top: p.top || [],
        directions: PICK_DIRECTIONS,
      },
    });
  });

  // Пересобрать подборки руками — только админ: каждый вызов тратит запросы.
  app.post("/api/sletat/picks/refresh", requireAdmin, async (req, res) => {
    try { res.json({ success: true, data: await refreshPicks() }); }
    catch (e) { fail(res, e); }
  });

  picksSchedule();

  // Расход пакета поисков по месяцам — чтобы счёт за перерасход не был сюрпризом.
  app.get("/api/sletat/usage", requireAdmin, (req, res) => {
    const all = usageAll();
    const cur = all[monthKey()] || { searches: 0, cached: 0, claims: 0 };
    const over = Math.max(0, cur.searches - QUOTA);
    res.json({
      success: true,
      data: {
        month: monthKey(), quota: QUOTA, used: cur.searches, saved: cur.cached || 0,
        over: over, overCost: Math.round(over * 0.1 * 100) / 100, byMonth: all,
      },
    });
  });

  console.log("SLETAT: /packages смонтирован (пакетные туры"
    + (LOGIN ? ", учётка задана" : ", БЕЗ учётки — поиск в демо-режиме, заявки недоступны")
    + ", пакет " + QUOTA + " поисков/мес, кэш " + Math.round(CACHE_TTL / 60000) + " мин)");
}

module.exports = { mount, dict, searchStart, searchState, searchResults, createClaim, claimInfo, usageAll, monthKey };
