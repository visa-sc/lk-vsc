// ─────────────────────────────────────────────────────────────────────────
// VOYO Экскурсии — собственный сервис бронирования экскурсий (/excursion)
//
// Модель ровно как у /esim: витрина, поиск, карточка, выбор и оформление —
// НАШИ, под брендом VOYO. Поставщик (Sputnik8) спрятан за интерфейсом: его
// ключ живёт только на сервере, наружу уходят уже наши нормализованные поля.
//
// Что умеем через API поставщика (проверено 05.09.2026):
//   GET /products, /products/:id      — каталог и полная карточка
//   GET /cities, /countries           — направления
//   GET /cities/:id/categories        — категории для фильтров
//   GET /events?activity_id=          — РЕАЛЬНОЕ расписание (даты, время, места)
//   GET /events/:id/order_options     — типы билетов и цены на конкретный сеанс
//   GET /products/:id/reviews         — отзывы
//   GET affiliate/orders_report       — наши брони и комиссия (сверка)
// Чего пока НЕТ: POST /orders (создание брони) отдаёт 403 «You do not have
// rights» — права на бронирование по API выдаёт партнёрский отдел Sputnik8
// (partners@sputnik8.com). Как выдадут — включаем BOOK_API и оформление
// становится полностью нашим (см. createOrderViaApi ниже, код уже готов).
//
// Пока прав нет, последний шаг (подтверждение + оплата) делает защищённая
// форма поставщика, встроенная в НАШУ страницу через iframe и преднастроенная
// нашим выбором (экскурсия, дата, сеанс, количество билетов каждого типа).
// Клиент не уходит с voyotravel.ru. Это официальный партнёрский инструмент
// «IFRAME форма бронирования», заказ метится нашим партнёрским ID.
//
// Изолирован от всего остального: свои роуты /excursion*, своё хранилище
// .excursion/. Клиентский ЛК, /admin, /vsc, amoCRM не затрагиваются.
// ─────────────────────────────────────────────────────────────────────────
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const axios = require("axios");

const API = "https://api.sputnik8.com/v1";
const REPORT_URL = "https://sputnik8.com/ru/affiliate/orders_report";
const ORDER_FORM = "https://www.sputnik8.com/order_form";

const KEY = process.env.SPUTNIK8_API_KEY || "";
const USER = process.env.SPUTNIK8_USERNAME || "";
// Партнёрский ID (метка, по которой нам засчитывается бронь и комиссия).
const AFF = String(process.env.SPUTNIK8_AFFILIATE_ID || "6654");
// Включится, когда поставщик выдаст права на POST /orders.
const BOOK_API = String(process.env.SPUTNIK8_BOOK_API || "") === "1";

const ADMIN_CODE = "280992";
const DIR = path.join(__dirname, ".excursion");
const LEADS_FILE = path.join(DIR, "leads.json");
const STARTS_FILE = path.join(DIR, "starts.json");

function ensureDir() { try { fs.mkdirSync(DIR, { recursive: true }); } catch (_) {} }
function readJson(f, d) { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch (_) { return d; } }
function writeJson(f, d) { ensureDir(); try { fs.writeFileSync(f, JSON.stringify(d, null, 1), "utf8"); } catch (e) { console.error("excursion write:", e.message); } }
function ready() { return !!(KEY && USER); }

// ═══════════════ клиент к API поставщика (кэш в памяти) ═══════════════
const _cache = new Map();
async function sp(pathname, params, ttlMs) {
  const qs = Object.assign({ api_key: KEY, username: USER }, params || {});
  const ck = pathname + "?" + Object.keys(qs).filter((k) => k !== "api_key").sort().map((k) => k + "=" + qs[k]).join("&");
  const now = Date.now();
  if (ttlMs) { const h = _cache.get(ck); if (h && now - h.at < ttlMs) return h.data; }
  const r = await axios.get(API + pathname, { params: qs, timeout: 20000 });
  if (ttlMs) {
    _cache.set(ck, { at: now, data: r.data });
    if (_cache.size > 400) { const o = Array.from(_cache.entries()).sort((a, b) => a[1].at - b[1].at)[0]; if (o) _cache.delete(o[0]); }
  }
  return r.data;
}

// Справочники отдаются постранично (лимит 100) — собираем целиком.
async function spAll(pathname, params, ttlMs, maxPages) {
  const out = [];
  for (let page = 1; page <= (maxPages || 20); page++) {
    const d = await sp(pathname, Object.assign({ limit: 100, page }, params || {}), ttlMs);
    const arr = Array.isArray(d) ? d : (d && (d.cities || d.countries || d.items)) || [];
    out.push.apply(out, arr);
    if (arr.length < 100) break;
  }
  return out;
}

// ═══════════════ нормализация ═══════════════
// Цены приходят строкой «1650.00 ₽» — приводим к числу.
function num(v) {
  if (v == null) return null;
  if (typeof v === "number") return Math.round(v);
  const m = String(v).replace(/\s|&nbsp;/g, "").match(/\d+([.,]\d+)?/);
  if (!m) return null;
  const n = parseFloat(m[0].replace(",", "."));
  return isNaN(n) ? null : Math.round(n);
}
function photoOf(x) {
  const pick = (o) => (o && typeof o === "object" ? (o.big || o.original || o.medium || o.small || "") : (typeof o === "string" ? o : ""));
  return pick(x.main_photo) || pick(x.cover_photo) || x.image_big || x.image_small || "";
}
function galleryOf(x) {
  const out = [];
  const add = (u) => { if (u && out.indexOf(u) < 0) out.push(u); };
  add(photoOf(x));
  (Array.isArray(x.photos) ? x.photos : []).forEach((p) => add(p && (p.big || p.original || p.medium || p.small)));
  return out.slice(0, 12);
}
// Описания приходят с HTML — вычищаем до текста с абзацами (свою вёрстку рисуем сами).
// Латинские двойники внутри русского слова («чаcов» с латинской c) — меняем
// только когда СОСЕДИ кириллические, чтобы не портить Toyota и прочие названия.
const LAT2CYR = { a: "а", c: "с", e: "е", o: "о", p: "р", x: "х", y: "у", A: "А", B: "В", C: "С", E: "Е", H: "Н", K: "К", M: "М", O: "О", P: "Р", T: "Т", X: "Х", Y: "У" };
function fixMixedScript(t) {
  return t.replace(/([А-Яа-яЁё])([A-Za-z])(?=[А-Яа-яЁё])/g, (m, a, b) => a + (LAT2CYR[b] || b));
}
function clean(s) {
  if (!s) return "";
  return fixMixedScript(String(s)
    .replace(/[\u200B-\u200F\u2060-\u2064\uFEFF]/g, "")
    .replace(/<\s*br\s*\/?>/gi, "\n")
    .replace(/<\/\s*(p|div|li|h\d)\s*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim());
}
// «• пункт • пункт» и переводы строк → массив пунктов
function bullets(s) {
  const t = clean(s);
  if (!t) return [];
  let parts = t.split(/\n+|\s*•\s*|\s*·\s*/);
  // Часть полей приходит одной строкой-перечислением в кавычках:
  // «"Транспортное обслуживание", "Услуги гида"» — разбираем на пункты.
  if (parts.length === 1 && /"[^"]*"\s*,\s*"/.test(parts[0])) parts = parts[0].split(/\s*,\s*(?=")/);
  // «1) … 2) … 3) …» сплошным текстом — тоже перечисление
  if (parts.length === 1 && (parts[0].match(/\d{1,2}\)\s/g) || []).length > 1) parts = parts[0].split(/\s+(?=\d{1,2}\)\s)/);
  return parts
    // кавычки снимаем ТОЛЬКО когда они обрамляют весь пункт целиком,
    // иначе ломаются названия вроде «Киностудия «Мосфильм»»
    .map((x) => x.trim().replace(/^\d{1,2}[).]\s*/, "").replace(/^[-–—]\s*/, "").replace(/^"(.*)"$/s, "$1").replace(/^«([^«»]*)»$/s, "$1").trim())
    .filter((x) => x.length > 1).slice(0, 30);
}
function cardOf(x) {
  return {
    id: x.id,
    title: String(x.title || "").trim(),
    photo: photoOf(x),
    price: num(x.base_price && x.base_price.price) ?? num(x.minimal_price) ?? num(x.price),
    oldPrice: num(x.base_price && x.base_price.original_price),
    rating: x.customers_review_rating != null ? Number(x.customers_review_rating) : null,
    reviews: x.reviews != null ? Number(x.reviews) : null,
    duration: x.duration != null ? String(x.duration) : "",
    type: x.type === "private" ? "private" : (x.type === "shared" ? "shared" : (x.product_type || "")),
    payType: x.pay_type_in_text || "",
    city: (x.geo && x.geo.city && x.geo.city.name) || x.city_slug || "",
    country: (x.geo && x.geo.country && x.geo.country.name) || "",
    cityId: (x.geo && x.geo.city && x.geo.city.id) || x.city_id || null,
    groupMax: x.group_size_max != null ? Number(x.group_size_max) : null,
    categories: (Array.isArray(x.categories) ? x.categories : []).map((c) => c.short_name || c.name).filter(Boolean).slice(0, 3),
    available: x.available_for_booking !== false
  };
}

// ═══════════════ бронирование ═══════════════
// Ссылка на защищённую форму подтверждения с НАШЕЙ преднастройкой.
// Открывается в модальном окне внутри нашей страницы — клиент не уходит.
function bookingUrl(o) {
  const q = new URLSearchParams();
  q.set("id", String(o.productId));
  q.set("ref", AFF);
  // Во фрейме нет их куки локали, и форма может уехать в английский —
  // фиксируем русский и рубли явно.
  q.set("locale", "ru"); q.set("lang", "ru"); q.set("currency", "RUB");
  if (o.date) q.set("event_date", String(o.date));
  if (o.eventId) q.set("event_id", String(o.eventId));
  (o.tickets || []).forEach((t) => { if (t && t.id != null && Number(t.qty) > 0) q.set("ticket_id_" + t.id, String(Number(t.qty))); });
  return ORDER_FORM + "?" + q.toString();
}
// Полностью своё оформление — включится, когда поставщик выдаст права на API
// заказов (сейчас POST /orders → 403). Логика уже по документации: создаём
// заказ, затем помечаем оплату (после успешной оплаты на нашей стороне).
async function createOrderViaApi(o) {
  const body = new URLSearchParams();
  body.set("api_key", KEY); body.set("username", USER);
  body.set("product_id", String(o.productId));
  body.set("event_id", String(o.eventId));
  body.set("customer_first_name", o.firstName || "");
  body.set("customer_last_name", o.lastName || "");
  body.set("customer_email", o.email || "");
  body.set("customer_phone", o.phone || "");
  body.set("tickets", JSON.stringify((o.tickets || []).filter((t) => Number(t.qty) > 0).map((t) => ({ id: t.id, quantity: Number(t.qty) }))));
  const r = await axios.post(API + "/orders", body.toString(), {
    headers: { "Content-Type": "application/x-www-form-urlencoded" }, timeout: 25000, validateStatus: () => true
  });
  return { status: r.status, data: r.data };
}

// ═══════════════ mount ═══════════════
function mount(app, opts) {
  const sendMail = (opts && opts.sendMail) || null;
  const page = (file) => (req, res) => { res.set("Cache-Control", "no-store, no-cache, must-revalidate"); res.sendFile(path.join(__dirname, "public", file)); };

  app.get("/excursion", page("excursion.html"));
  app.get("/excursions", (req, res) => res.redirect(301, "/excursion"));

  // Направления: города со странами + список стран. Кэш 6 ч.
  app.get("/excursion/api/destinations", async (req, res) => {
    if (!ready()) return res.json({ success: false, configured: false });
    try {
      const [raw, cs] = await Promise.all([
        spAll("/cities", { lang: "ru" }, 6 * 3600 * 1000, 20),
        spAll("/countries", { lang: "ru" }, 24 * 3600 * 1000, 6)
      ]);
      const cmap = {}; cs.forEach((c) => { if (c && c.id != null) cmap[c.id] = String(c.name || c.title || "").trim(); });
      const cities = raw.map((c) => ({
        id: c.id, name: String(c.name || c.title || "").trim(),
        countryId: c.country_id || (c.country && c.country.id) || null,
        country: (c.country && (c.country.name || c.country.title)) || c.country_name || cmap[c.country_id] || ""
      })).filter((c) => c.id && c.name).sort((a, b) => a.name.localeCompare(b.name, "ru"));
      const countries = cs.filter((c) => c && c.id != null && c.name && (c.products == null || Number(c.products) > 0))
        .map((c) => ({ id: c.id, name: String(c.name).trim(), products: c.products != null ? Number(c.products) : null }))
        .sort((a, b) => a.name.localeCompare(b.name, "ru"));
      res.json({ success: true, configured: true, cities, countries });
    } catch (e) { res.status(502).json({ success: false, message: "Не удалось загрузить направления" }); }
  });

  // Каталог. Фильтры: город/страна/категория, сортировка, страница.
  app.get("/excursion/api/products", async (req, res) => {
    if (!ready()) return res.json({ success: false, configured: false });
    const sort = String(req.query.sort || "popular");
    const p = {
      lang: "ru", currency: "rub",
      page: Math.max(1, parseInt(req.query.page, 10) || 1),
      limit: Math.min(60, Math.max(1, parseInt(req.query.limit, 10) || 24)),
      order: sort === "new" ? "product_id" : "rating",
      order_type: "desc"
    };
    if (req.query.city_id) p.city_id = parseInt(req.query.city_id, 10);
    if (req.query.country_id) p.country_id = parseInt(req.query.country_id, 10);
    if (req.query.category_id) p.category_id = parseInt(req.query.category_id, 10);
    try {
      const data = await sp("/products", p, 10 * 60 * 1000);
      const arr = Array.isArray(data) ? data : (data && (data.products || data.items)) || [];
      let out = arr.map(cardOf).filter((x) => x.id && x.title);
      const q = String(req.query.q || "").trim().toLowerCase();
      if (q) out = out.filter((x) => (x.title + " " + x.categories.join(" ")).toLowerCase().indexOf(q) >= 0);
      // Цену сортируем у себя — так предсказуемее, чем гадать про поля поставщика.
      if (sort === "cheap") out.sort((a, b) => (a.price || 1e9) - (b.price || 1e9));
      if (sort === "rating") out.sort((a, b) => (b.rating || 0) - (a.rating || 0) || (b.reviews || 0) - (a.reviews || 0));
      res.json({ success: true, page: p.page, count: out.length, products: out });
    } catch (e) { res.status(502).json({ success: false, message: "Не удалось загрузить экскурсии" }); }
  });

  // Категории конкретного города (фильтр-чипы).
  app.get("/excursion/api/categories", async (req, res) => {
    const cityId = parseInt(req.query.city_id, 10);
    if (!ready() || !cityId) return res.json({ success: true, categories: [] });
    try {
      const data = await sp("/cities/" + cityId + "/categories", { lang: "ru" }, 6 * 3600 * 1000);
      const arr = Array.isArray(data) ? data : (data && (data.categories || data.items)) || [];
      // Верхний уровень — пустая обёртка, реальные категории лежат в
      // sub_categories (с количеством экскурсий). Берём самые наполненные.
      const flat = [];
      arr.forEach((c) => {
        if (c && c.id && (c.name || c.short_name)) flat.push(c);
        (Array.isArray(c && c.sub_categories) ? c.sub_categories : []).forEach((sc) => { if (sc && sc.id && (sc.name || sc.short_name)) flat.push(sc); });
      });
      const seen = {};
      const categories = flat
        .map((c) => ({ id: c.id, name: c.short_name || c.name, count: Array.isArray(c.products) ? c.products.length : 0 }))
        .filter((c) => c.name && !seen[c.name] && (seen[c.name] = 1))
        .sort((a, b) => b.count - a.count)
        .slice(0, 12);
      res.json({ success: true, categories });
    } catch (e) { res.json({ success: true, categories: [] }); }
  });

  // Полная карточка: галерея, программа, что входит, гид, отзывы, условия.
  app.get("/excursion/api/product/:id", async (req, res) => {
    if (!ready()) return res.json({ success: false, configured: false });
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ success: false });
    try {
      const x = await sp("/products/" + id, { lang: "ru", currency: "rub" }, 10 * 60 * 1000);
      if (!x || !x.id) return res.status(404).json({ success: false, message: "Экскурсия не найдена" });
      const base = cardOf(x);
      const host = x.host && typeof x.host === "object" ? {
        name: x.host.name || "", photo: x.host.photo || "",
        rating: x.host.review_rating != null ? Number(x.host.review_rating) : null,
        reviews: x.host.reviews != null ? Number(x.host.reviews) : null
      } : null;
      const reviews = (Array.isArray(x.reviews_list) ? x.reviews_list : []).filter((r) => r && r.content)
        .slice(0, 12).map((r) => ({ name: r.name || "Гость", date: r.date || "", rating: r.rating != null ? Number(r.rating) : null, text: clean(r.content).slice(0, 900) }));
      res.json({
        success: true,
        product: Object.assign(base, {
          gallery: galleryOf(x),
          short: clean(x.short_info),
          description: clean(x.description),
          included: bullets(x.what_included),
          notIncluded: bullets(x.what_not_included),
          places: bullets(x.places_to_see),
          importantInfo: clean(x.important_info),
          // тем же полем, но списком: в исходнике пункты через «•» и пустые строки,
          // сплошным текстом это читается плохо
          importantList: bullets(x.important_info),
          refundInfo: clean(x.refund_info),
          refundList: bullets(x.refund_info),
          meetingPoint: (x.begin_place && x.begin_place.address) || "",
          meetingComment: (x.begin_place && x.begin_place.address_comment) || "",
          finishPoint: typeof x.finish_point === "string" ? clean(x.finish_point) : "",
          languages: Array.isArray(x.languages) ? x.languages : [],
          minBookPeriod: x.minimum_book_period != null ? Number(x.minimum_book_period) : null,
          bookingType: x.booking_type || "",
          scheduleType: x.schedule_type || "",
          host: host,
          reviewsList: reviews
        })
      });
    } catch (e) {
      if (e.response && e.response.status === 404) return res.status(404).json({ success: false, message: "Экскурсия не найдена" });
      res.status(502).json({ success: false, message: "Не удалось загрузить экскурсию" });
    }
  });

  // Расписание: реальные сеансы, сгруппированные по датам (на 120 дней вперёд).
  app.get("/excursion/api/product/:id/schedule", async (req, res) => {
    if (!ready()) return res.json({ success: false, configured: false });
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ success: false });
    try {
      const data = await sp("/events", { activity_id: id, lang: "ru", limit: 100 }, 5 * 60 * 1000);
      const arr = Array.isArray(data) ? data : (data && (data.events || data.items)) || [];
      const today = new Date(Date.now() - 6 * 3600 * 1000).toISOString().slice(0, 10);
      // Одно и то же время в один день может прийти несколькими сеансами
      // (разные автобусы/группы) — показываем клиенту один, где больше мест.
      const byDate = {};
      arr.filter((e) => e && e.status === "active" && !e.is_hidden && e.date >= today).forEach((e) => {
        const day = (byDate[e.date] = byDate[e.date] || {});
        const t = e.time || "";
        const cap = e.max_capacity != null ? Number(e.max_capacity) : 0;
        if (!day[t] || cap > day[t].capacity) day[t] = { eventId: e.id, time: t, capacity: cap, duration: e.duration || "" };
      });
      const days = Object.keys(byDate).sort().map((d) => ({
        date: d,
        slots: Object.keys(byDate[d]).sort().map((t) => byDate[d][t]).filter((s) => s.capacity !== 0 || true)
      }));
      res.json({ success: true, days });
    } catch (e) { res.json({ success: true, days: [] }); }
  });

  // Билеты и цены конкретного сеанса.
  app.get("/excursion/api/event/:id/tickets", async (req, res) => {
    if (!ready()) return res.json({ success: false, configured: false });
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ success: false });
    try {
      const data = await sp("/events/" + id + "/order_options", { lang: "ru", currency: "rub" }, 3 * 60 * 1000);
      const arr = Array.isArray(data) ? data : (data && (data.order_options || data.items)) || [];
      // order_lines — ценовые СТУПЕНИ по количеству: «1–15 чел. по 1200»,
      // «16–30 по 1100». Отдаём все, цену за штуку витрина берёт по количеству.
      const tickets = arr.map((o) => {
        const lines = (Array.isArray(o.order_lines) ? o.order_lines : []).map((l) => ({
          from: l.from_quantity != null ? Number(l.from_quantity) : 1,
          to: l.to_quantity != null ? Number(l.to_quantity) : null,
          // у зарубежных экскурсий l.price приходит в валюте тура — рубли берём явно
          price: num(l.all_prices && l.all_prices.RUB) ?? num(l.price)
        })).filter((l) => l.price != null).sort((a, b) => a.from - b.from);
        const price = lines.length ? lines[0].price : null;
        return {
          id: o.id, title: o.title || "Билет", isBase: !!o.is_base,
          price: price, free: price === 0, lines: lines,
          maxQty: lines.length && lines[lines.length - 1].to ? lines[lines.length - 1].to : null
        };
      }).filter((t) => t.id != null && t.lines.length);
      res.json({ success: true, tickets });
    } catch (e) { res.json({ success: true, tickets: [] }); }
  });

  // Оформление. Собираем ссылку на защищённое подтверждение с нашей
  // преднастройкой (клиент остаётся на нашей странице, в модальном окне).
  // Когда поставщик выдаст права на API заказов — тот же вызов начнёт
  // создавать бронь напрямую и вернёт mode:"api".
  app.post("/excursion/api/book", async (req, res) => {
    const b = req.body || {};
    const productId = parseInt(b.productId, 10);
    const eventId = parseInt(b.eventId, 10) || null;
    const tickets = (Array.isArray(b.tickets) ? b.tickets : []).map((t) => ({ id: parseInt(t.id, 10), qty: Math.max(0, parseInt(t.qty, 10) || 0) })).filter((t) => t.id && t.qty > 0);
    if (!productId) return res.status(400).json({ success: false, message: "Не выбрана экскурсия" });
    const rec = {
      id: crypto.randomBytes(6).toString("hex"), ts: Date.now(),
      productId, eventId, date: String(b.date || "").slice(0, 10), time: String(b.time || "").slice(0, 8),
      title: String(b.title || "").slice(0, 200), total: Number(b.total) || null, tickets,
      phone: String(b.phone || "").slice(0, 30), name: String(b.name || "").slice(0, 120)
    };
    const all = readJson(STARTS_FILE, []); all.unshift(rec); writeJson(STARTS_FILE, all.slice(0, 5000));

    if (BOOK_API) {
      try {
        const r = await createOrderViaApi({ productId, eventId, tickets, firstName: b.name, lastName: b.lastName, email: b.email, phone: b.phone });
        if (r.status >= 200 && r.status < 300 && r.data && r.data.id) {
          return res.json({ success: true, mode: "api", order: { id: r.data.id, status: r.data.status || "", voucher: r.data.voucher_url || null } });
        }
        console.error("excursion book api:", r.status, JSON.stringify(r.data).slice(0, 200));
      } catch (e) { console.error("excursion book api:", e.message); }
    }
    res.json({ success: true, mode: "form", url: bookingUrl({ productId, date: rec.date, eventId, tickets }) });
  });

  // Подбор менеджером — для тех, кто хочет живого человека (и для нестандарта:
  // группы, дети, особые даты). Уходит письмом, как заявки с /esim.
  app.post("/excursion/api/lead", (req, res) => {
    const b = req.body || {};
    const phone = String(b.phone || "").trim().slice(0, 30);
    if (phone.replace(/\D/g, "").length < 10) return res.status(400).json({ success: false, message: "Нужен телефон." });
    const lead = {
      id: crypto.randomBytes(6).toString("hex"), ts: Date.now(),
      phone, name: String(b.name || "").slice(0, 120), comment: String(b.comment || "").slice(0, 800),
      productId: b.productId ? parseInt(b.productId, 10) : null, title: String(b.title || "").slice(0, 200),
      date: String(b.date || "").slice(0, 10), people: String(b.people || "").slice(0, 40)
    };
    const all = readJson(LEADS_FILE, []); all.unshift(lead); writeJson(LEADS_FILE, all.slice(0, 5000));
    if (sendMail) {
      sendMail({
        to: "director@visa-sc.ru",
        subject: "VOYO Экскурсии: заявка" + (lead.title ? " — " + lead.title : ""),
        text: "Заявка на подбор экскурсии с voyotravel.ru/excursion\n\n" +
          "Клиент: " + (lead.name || "—") + "\nТелефон: " + phone +
          "\nЭкскурсия: " + (lead.title || "—") + (lead.productId ? " (ID " + lead.productId + ")" : "") +
          "\nДата: " + (lead.date || "—") + "\nЛюдей: " + (lead.people || "—") +
          "\nКомментарий: " + (lead.comment || "—") +
          "\n\nОформить: sputnik8.com (кабинет партнёра ID " + AFF + ") или отправить клиенту ссылку с нашей меткой."
      }).then((r) => { if (r && !r.ok) console.error("excursion mail:", r.error); }).catch((e) => console.error("excursion mail:", e.message));
    }
    res.json({ success: true });
  });

  // Сверка: наши брони и заработанная комиссия (только с админ-кодом).
  app.get("/excursion/api/report", async (req, res) => {
    if (String(req.query.adm || "") !== ADMIN_CODE) return res.status(403).json({ success: false });
    if (!ready()) return res.json({ success: false, configured: false });
    try {
      const r = await axios.get(REPORT_URL, { params: { api_key: KEY, username: USER }, timeout: 25000 });
      const arr = Array.isArray(r.data) ? r.data : [];
      const orders = arr.slice(0, 300).map((o) => ({
        number: o.order_number, created: o.created_at || "", eventDate: o.event_date || "",
        city: o.city_name || "", country: o.country_name || "", title: o.description || "",
        status: o.status || o.order_status || "", paid: o.paid_status || "",
        amount: num(o.price), currency: (o.currency || "rub").toUpperCase(),
        // profit — наше вознаграждение по заказу; paid_by_sputnik_to_agent — уже выплачено
        income: num(o.profit), paidOut: num(o.paid_by_sputnik_to_agent),
        test: !!o.is_test, cancelled: !!o.cancellation_date
      }));
      const income = orders.filter((o) => !o.cancelled && !o.test).reduce((s, o) => s + (o.income || 0), 0);
      res.json({ success: true, count: orders.length, income, orders, leads: readJson(LEADS_FILE, []).slice(0, 100), starts: readJson(STARTS_FILE, []).slice(0, 100) });
    } catch (e) { res.status(502).json({ success: false, message: "Отчёт недоступен" }); }
  });

  console.log("VOYO Экскурсии: /excursion" + (ready() ? " (каталог и расписание live, партнёр " + AFF + ")" : " — НЕ настроен: нет SPUTNIK8_API_KEY"));
}

module.exports = { mount, ready, bookingUrl };
