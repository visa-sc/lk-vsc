// ─────────────────────────────────────────────────────────────────────────
// VOYO eSIM (/esim) — продажа туристических eSIM под брендом VOYO.
// Создан 02.09.2026 по решению Андрея (handoff «eSIM MobiMatter»).
//
// Архитектура: поставщик спрятан за интерфейсом (сейчас MobiMatter, на
// объёме планируется eSIM Go/Maya — витрина при смене не переделывается).
// Интерфейс поставщика: fetchProducts() / createOrder() / getBalance().
//
// Режимы:
//  • БЕЗ ключей API (env MOBIMATTER_MERCHANT_ID + MOBIMATTER_API_KEY не
//    заданы) — работает ДЕМО-каталог: реальные закупочные цены, снятые
//    вручную с partner.mobimatter.com 02.09.2026. Витрина полностью живая,
//    покупка отвечает «оплата подключается».
//  • С ключами — каталог тянется из API MobiMatter и кэшируется в
//    .esim/catalog.json (обновление раз в 6 ч и при рестарте).
//    ⚠ Эндпоинты заказа сверить с доками в портале при первом реальном
//    заказе — написаны по публичной документации v2.
//
// Цены: розница ₽ = закупка $ × курс ЦБ USD × наценка (дефолт ×2.5),
// округление вверх до …90 (990/1490/2190…), минимум ESIM_MIN_RUB.
// Закупка и маржа клиенту НЕ отдаются; на тестовой странице видны только
// с ?adm=<ESIM_ADMIN_CODE>.
//
// env: MOBIMATTER_MERCHANT_ID, MOBIMATTER_API_KEY — ключи из портала;
// ESIM_MARKUP (2.5), ESIM_MIN_RUB (590), ESIM_USD_FALLBACK (90),
// ESIM_ADMIN_CODE (дефолт 280992 — превью-код Андрея).
// ─────────────────────────────────────────────────────────────────────────
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const axios = require("axios");
const tbank = require("./tbank"); // Т-Касса: приём оплат (банк за интерфейсом, как и поставщик eSIM)

const BASE_URL = process.env.ESIM_BASE_URL || "https://voyotravel.ru";
const DIR = path.join(__dirname, ".esim");
const CATALOG_FILE = path.join(DIR, "catalog.json");
const ORDERS_FILE = path.join(DIR, "orders.json");

const MARKUP = Number(process.env.ESIM_MARKUP || 2.5);
const MIN_RUB = Number(process.env.ESIM_MIN_RUB || 590);
const USD_FALLBACK = Number(process.env.ESIM_USD_FALLBACK || 90);
const ADMIN_CODE = String(process.env.ESIM_ADMIN_CODE || "280992");
const CATALOG_TTL_MS = 6 * 60 * 60 * 1000;

function ensureDir() { try { fs.mkdirSync(DIR, { recursive: true }); } catch (_) {} }
function readJson(f, dflt) { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch (_) { return dflt; } }
function writeJson(f, d) { ensureDir(); try { fs.writeFileSync(f, JSON.stringify(d, null, 1), "utf8"); } catch (e) { console.error("esim write:", e.message); } }

// ── округление розницы: вверх до ближайших …90 ──
function toRetailRub(costUsd, usdRate) {
  const raw = costUsd * usdRate * MARKUP;
  const rounded = Math.ceil((raw + 10) / 100) * 100 - 10; // 1462→1490, 930→990
  return Math.max(MIN_RUB, rounded);
}

// ═══════════════ ПОСТАВЩИК: MobiMatter ═══════════════
const MM_BASE = "https://api.mobimatter.com/mobimatter/api/v2";
function mmHeaders() {
  return { "api-key": process.env.MOBIMATTER_API_KEY, merchantId: process.env.MOBIMATTER_MERCHANT_ID };
}
const mobimatter = {
  name: "mobimatter",
  ready() { return Boolean(process.env.MOBIMATTER_API_KEY && process.env.MOBIMATTER_MERCHANT_ID); },
  // Каталог → нормализованный формат витрины (одинаковый для любого поставщика).
  // Структура сверена с живым API 02.09.2026: PLAN_VALIDITY — в ЧАСАХ (720=30 дн).
  // Продаём esim_realtime (мгновенная выдача QR); esim_addon — ТОПАПЫ, идут
  // отдельным списком: топап совместим с eSIM, если у их продуктов одинаковый
  // productFamilyId (правило из доков). esim_delayed/replacement не берём.
  async fetchProducts() {
    const r = await axios.get(MM_BASE + "/products", { headers: mmHeaders(), timeout: 60000 });
    const list = (r.data && (r.data.result || r.data)) || [];
    const products = [], addons = [];
    for (const p of list) {
      if (p.productCategory !== "esim_realtime" && p.productCategory !== "esim_addon") continue;
      const det = {};
      (p.productDetails || []).forEach((d) => { det[String(d.name || "").trim()] = d.value; });
      const rawData = parseFloat(det.PLAN_DATA_LIMIT || "") || null;
      const unit = String(det.PLAN_DATA_UNIT || "GB").toUpperCase();
      const hours = parseInt(det.PLAN_VALIDITY || "", 10) || 0;
      const cost = Number(p.wholesalePrice || 0);
      if (!cost) continue;
      const item = {
        id: String(p.productId || p.uniqueId),
        familyId: String(p.productFamilyId || ""),
        title: det.PLAN_TITLE || "",
        operator: p.providerName || "",
        countries: p.countries || [],
        dataGb: unit === "MB" && rawData ? Math.round((rawData / 1024) * 10) / 10 : rawData,
        unlimited: det.UNLIMITED === "1",
        days: hours ? Math.round(hours / 24) : null,
        costUsd: cost,
        retailUsd: Number(p.retailPrice || 0) || null,
        fiveG: det.FIVEG === "1",
        hotspot: det.HOTSPOT === "1",
        topup: det.TOPUP === "1",
      };
      (p.productCategory === "esim_addon" ? addons : products).push(item);
    }
    return { products, addons };
  },
  // Заказ — два шага, ОБКАТАНО на тест-продукте 02.09.2026 (AKGR-23460525):
  //  1) POST /order {productId, productCategory} → orderId (холд на кошельке);
  //  2) PUT /order/complete {orderId} → orderState=Completed + lineItemDetails
  //     с ICCID, LPA-строкой, кодом активации, APN и ГОТОВЫМ QR (data:image/png).
  // Возвращаем нормализованный объект — витрине всё равно, кто поставщик.
  async createOrder(productId) { return this._order({ productId, productCategory: "esim_realtime" }); },
  // Топап (продление) существующей eSIM: та же пара create→complete, но категория
  // esim_addon + addOnOrderIdentifier = ИСХОДНЫЙ заказ esim_realtime (из доков).
  async createTopup(productId, parentOrderId) {
    return this._order({ productId, productCategory: "esim_addon", addOnOrderIdentifier: parentOrderId });
  },
  async _order(body) {
    const c = await axios.post(MM_BASE + "/order", body, { headers: mmHeaders(), timeout: 60000 });
    const orderId = c.data && c.data.result && c.data.result.orderId;
    if (!orderId) throw new Error("MobiMatter: заказ не создан");
    const d = await axios.put(MM_BASE + "/order/complete", { orderId }, { headers: mmHeaders(), timeout: 120000 });
    const resErr = !d.data || !d.data.result || d.data.result.orderState !== "Completed";
    if (resErr) throw new Error("MobiMatter: заказ " + orderId + " не завершился: " + JSON.stringify(d.data).slice(0, 200));
    const li = d.data.result.orderLineItem || {};
    const det = {};
    (li.lineItemDetails || []).forEach((x) => { det[x.name] = x.value; });
    return {
      orderId, state: d.data.result.orderState, title: li.title || "",
      costUsd: Number(li.wholesalePrice || 0),
      iccid: det.ICCID || null, lpa: det.LOCAL_PROFILE_ASSISTANT || null,
      activationCode: det.ACTIVATION_CODE || null, smdp: det.SMDP_ADDRESS || null,
      apn: det.ACCESS_POINT_NAME || null, qrDataUrl: det.QR_CODE || null,
    };
  },
  async getOrder(orderId) {
    const r = await axios.get(MM_BASE + "/order/" + encodeURIComponent(orderId), { headers: mmHeaders(), timeout: 30000 });
    return r.data && (r.data.result || r.data);
  },
  // Остаток трафика по купленной eSIM — для «моя eSIM» в ЛК (сверено 02.09.2026
  // на тест-заказе): GET /provider/info/{orderId} → esim.installationStatus +
  // packages[{totalAllowanceMb, usedMb, activationDate, expirationDate}]
  async getUsage(orderId) {
    const r = await axios.get(MM_BASE + "/provider/info/" + encodeURIComponent(orderId), { headers: mmHeaders(), timeout: 30000 });
    const d = (r.data && (r.data.result || r.data)) || {};
    const es = d.esim || {};
    return {
      installed: es.installationStatus === "INSTALLED",
      status: es.status || null, iccid: es.iccid || null, suspended: !!es.isSuspended,
      packages: (d.packages || []).map((p) => ({
        name: p.name, totalMb: Number(p.totalAllowanceMb || 0), usedMb: Number(p.usedMb || 0),
        remainingMb: Math.max(0, Number(p.totalAllowanceMb || 0) - Number(p.usedMb || 0)),
        activatedAt: p.activationDate || null, expiresAt: p.expirationDate || null,
      })),
    };
  },
  async getBalance() {
    // сверено 02.09.2026: GET /merchant/balance → { result: { balance: 250 } }
    const r = await axios.get(MM_BASE + "/merchant/balance", { headers: mmHeaders(), timeout: 15000 });
    return r.data && (r.data.result || r.data);
  },
};
const provider = mobimatter; // единственная точка смены поставщика

// ═══════════════ ДЕМО-КАТАЛОГ (закупки с partner.mobimatter.com, 02.09.2026) ═══════════════
const EU33 = ["AT","BE","BG","HR","CY","CZ","DK","EE","FI","FR","DE","GR","HU","IS","IE","IT","LV","LI","LT","LU","MT","NL","NO","PL","PT","RO","SK","SI","ES","SE","CH","GB","UA"];
const ASIA14 = ["TH","VN","MY","SG","ID","PH","KH","LA","MM","TW","HK","MO","KR","JP"];
const DEMO_PRODUCTS = [
  { id: "demo-es-7", operator: "NextLink", countries: ["ES"], dataGb: 7, days: 30, costUsd: 6.5, fiveG: true },
  { id: "demo-es-15", operator: "NextLink", countries: ["ES"], dataGb: 15, days: 30, costUsd: 11.0, fiveG: true },
  { id: "demo-es-30", operator: "NextLink", countries: ["ES"], dataGb: 30, days: 30, costUsd: 19.5, fiveG: true },
  { id: "demo-eu-3", operator: "Sparks", countries: EU33, dataGb: 3, days: 30, costUsd: 3.9, fiveG: true },
  { id: "demo-eu-10", operator: "Sparks", countries: EU33, dataGb: 10, days: 30, costUsd: 8.9, fiveG: true },
  { id: "demo-eu-20", operator: "Sparks", countries: EU33, dataGb: 20, days: 30, costUsd: 14.5, fiveG: true },
  { id: "demo-tr-12", operator: "NextLink", countries: ["TR"], dataGb: 12, days: 30, costUsd: 7.2, fiveG: true },
  { id: "demo-us-15", operator: "NextLink", countries: ["US"], dataGb: 15, days: 30, costUsd: 10.5, fiveG: true },
  { id: "demo-jp-20", operator: "RoamVault", countries: ["JP"], dataGb: 20, days: 30, costUsd: 10.8, fiveG: true },
  { id: "demo-th-50", operator: "True", countries: ["TH"], dataGb: 50, days: 10, costUsd: 8.0, fiveG: true },
  { id: "demo-ae-10", operator: "Etisalat", countries: ["AE"], dataGb: 10, days: 30, costUsd: 12.0, fiveG: true },
  { id: "demo-cn-20", operator: "TSimTech", countries: ["CN"], dataGb: 20, days: 30, costUsd: 11.0, fiveG: true },
  { id: "demo-eg-12", operator: "NextLink", countries: ["EG"], dataGb: 12, days: 30, costUsd: 11.0, fiveG: true },
  { id: "demo-id-30", operator: "TSimTech", countries: ["ID"], dataGb: 30, days: 30, costUsd: 14.4, fiveG: true },
  { id: "demo-gb-999", operator: "eSIMGo", countries: ["GB"], dataGb: 999, days: 30, costUsd: 19.99, fiveG: true },
  { id: "demo-asia-20", operator: "Airalo", countries: ASIA14, dataGb: 20, days: 30, costUsd: 16.0 },
  { id: "demo-glob-13", operator: "3", countries: EU33.concat(["US","TR","AE","TH","JP"]), dataGb: 13, days: 365, costUsd: 35.5 },
];

// ═══════════════ каталог с кэшем ═══════════════
let _catalog = null; // { ts, source, products, addons }
function loadCatalogFile() { if (!_catalog) _catalog = readJson(CATALOG_FILE, null); return _catalog; }
async function getCatalog(force) {
  const cached = loadCatalogFile();
  if (!provider.ready()) return { ts: Date.now(), source: "demo", products: DEMO_PRODUCTS, addons: [] };
  // кэш старого формата (без addons) не годится — обновляем
  if (!force && cached && cached.source === provider.name && Array.isArray(cached.addons) && Date.now() - cached.ts < CATALOG_TTL_MS) return cached;
  try {
    const { products, addons } = await provider.fetchProducts();
    if (products.length) { _catalog = { ts: Date.now(), source: provider.name, products, addons }; writeJson(CATALOG_FILE, _catalog); return _catalog; }
  } catch (e) { console.error("esim catalog:", e.message); }
  // API упал — отдаём последний кэш, если есть, иначе демо
  if (cached && cached.products && cached.products.length) { if (!Array.isArray(cached.addons)) cached.addons = []; return cached; }
  return { ts: Date.now(), source: "demo", products: DEMO_PRODUCTS, addons: [] };
}

// ═══════════════ подписанные ссылки «Моя eSIM» ═══════════════
// Клиент открывает /esim/my?o=<orderId>&t=<подпись> — без входа в ЛК (пока
// продажи ручные). Подпись отсекает перебор номеров заказов AKGR-… .
const LINK_SECRET = process.env.ESIM_LINK_SECRET || (ADMIN_CODE + ":voyo-esim-my");
function signOrder(orderId) { return crypto.createHmac("sha256", LINK_SECRET).update(String(orderId)).digest("hex").slice(0, 12); }
function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }
function normEmail(e) { return String(e || "").trim().toLowerCase(); }
function signEmail(email) { return crypto.createHmac("sha256", LINK_SECRET).update("acc:" + normEmail(email)).digest("hex").slice(0, 16); }
function checkEmailSig(email, t) {
  const a = Buffer.from(signEmail(email)), b = Buffer.from(String(t || ""));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function validEmail(e) { return /^[^@\s]+@[^@\s.]+\.[^@\s]{2,}$/.test(normEmail(e)); }

// ── Сессия клиента: подписанная кука, чтобы email спрашивался один раз ──
// Ставится, когда человек открывает свою ПОДПИСАННУЮ ссылку (из письма или
// после оплаты). Отдельного пароля нет и не нужно: владение ссылкой и есть
// доступ, а кука просто избавляет от повторного ввода почты.
const SESS_COOKIE = "voyo_esim";
const SESS_DAYS = 180;
function sessValue(email) { return Buffer.from(normEmail(email)).toString("base64url") + "." + signEmail(email); }
function setSession(res, email) {
  if (!validEmail(email)) return;
  try {
    res.cookie(SESS_COOKIE, sessValue(email), {
      maxAge: SESS_DAYS * 24 * 3600 * 1000, httpOnly: true, sameSite: "lax",
      secure: BASE_URL.indexOf("https://") === 0, path: "/esim",
    });
  } catch (_) {}
}
function clearSession(res) { try { res.clearCookie(SESS_COOKIE, { path: "/esim" }); } catch (_) {} }
function readSession(req) {
  const raw = String((req.headers && req.headers.cookie) || "");
  const m = new RegExp("(?:^|;\\s*)" + SESS_COOKIE + "=([^;]+)").exec(raw);
  if (!m) return null;
  const parts = decodeURIComponent(m[1]).split(".");
  if (parts.length !== 2) return null;
  let email;
  try { email = Buffer.from(parts[0], "base64url").toString("utf8"); } catch (_) { return null; }
  return validEmail(email) && checkEmailSig(email, parts[1]) ? normEmail(email) : null;
}
function emailOfProviderOrder(mmOrderId) {
  const o = readJson(ORDERS_FILE, []).find((x) => x.status === "done" && (x.mmOrderId === mmOrderId || x.parentOrderId === mmOrderId));
  return o && o.email ? o.email : null;
}
function esimsOf(email) {
  return readJson(ORDERS_FILE, [])
    .filter((o) => o.email === email && o.status === "done" && o.mmOrderId)
    .map((o) => ({
      label: o.label, ts: o.ts, priceRub: o.priceRub, topup: !!o.parentOrderId,
      url: BASE_URL + "/esim/my?o=" + encodeURIComponent(o.parentOrderId || o.mmOrderId) +
           "&t=" + signOrder(o.parentOrderId || o.mmOrderId),
    }));
}
function checkSig(orderId, t) {
  const a = Buffer.from(signOrder(orderId)), b = Buffer.from(String(t || ""));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ═══════════════ mount ═══════════════
// opts.fetchCbrRates — общий с калькулятором источник курса ЦБ из server.js
function mount(app, opts) {
  const fetchCbr = (opts && opts.fetchCbrRates) || null;
  async function usdRate() {
    try { if (fetchCbr) { const c = await fetchCbr(); if (c && c.rates && c.rates.USD) return c.rates.USD; } } catch (_) {}
    return USD_FALLBACK;
  }

  app.get("/esim", (req, res) => {
    res.set("Cache-Control", "no-store, no-cache, must-revalidate");
    res.sendFile(path.join(__dirname, "public", "esim.html"));
  });

  // Каталог для витрины: цены уже в ₽, закупка отдаётся только с админ-кодом
  app.get("/esim/api/catalog", async (req, res) => {
    try {
      const [cat, rate] = await Promise.all([getCatalog(false), usdRate()]);
      const adm = String(req.query.adm || "") === ADMIN_CODE;
      const products = cat.products.map((p) => {
        const o = {
          id: p.id, title: p.title || "", operator: p.operator || "", countries: p.countries || [],
          dataGb: p.dataGb, unlimited: !!p.unlimited, days: p.days,
          fiveG: !!p.fiveG, hotspot: p.hotspot !== false, priceRub: toRetailRub(p.costUsd, rate),
        };
        if (adm) { o.costUsd = p.costUsd; o.costRub = Math.round(p.costUsd * rate); o.marginRub = o.priceRub - o.costRub; }
        return o;
      });
      res.json({ success: true, demo: cat.source === "demo", live: provider.ready(), pay: tbank.ready(), updatedAt: cat.ts, usdRate: Math.round(rate * 100) / 100, markup: adm ? MARKUP : undefined, products });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
  });

  // Покупка. Пока эквайринг не подключён — принимаем ЗАЯВКУ с телефоном:
  // менеджер выставляет счёт, покупает пакет в портале и шлёт клиенту QR.
  // Когда подключим оплату ЛК, сюда встанет: оплата → provider.createOrder →
  // QR клиенту автоматически (в ЛК + письмо/чат под VOYO).
  app.post("/esim/api/order", (req, res) => {
    const b = req.body || {};
    const phone = String(b.phone || "").trim().slice(0, 30);
    if (phone.replace(/\D/g, "").length < 10) return res.status(400).json({ success: false, message: "Нужен телефон." });
    const order = {
      id: crypto.randomBytes(6).toString("hex"), ts: Date.now(), status: "lead",
      productId: String(b.productId || "").slice(0, 64), label: String(b.label || "").slice(0, 120),
      priceRub: Number(b.priceRub) || null, phone,
    };
    const orders = readJson(ORDERS_FILE, []);
    orders.unshift(order);
    writeJson(ORDERS_FILE, orders.slice(0, 5000));
    // уведомление менеджеру — тем же каналом, что заявки с visa-sc.com
    if (opts && opts.sendMail) {
      opts.sendMail({
        to: "director@visa-sc.ru",
        subject: "VOYO eSIM: заявка " + (order.label || order.productId),
        text: "Новая заявка на eSIM с voyotravel.ru/esim\n\nПакет: " + (order.label || "—") +
          "\nЦена для клиента: " + (order.priceRub ? order.priceRub + " ₽" : "—") +
          "\nТелефон клиента: " + phone +
          "\nID продукта MobiMatter: " + (order.productId || "—") +
          "\n\nКупить пакет: partner.mobimatter.com → Buy eSIMs (найти по ID) → QR-код отправить клиенту." +
          "\nПосле покупки возьмите номер заказа (AKGR-…) и откройте voyotravel.ru/esim/mylink?adm=КОД&o=НОМЕР — " +
          "получится персональная ссылка «Моя eSIM» для клиента (остаток трафика, QR, продление). Отправьте её вместе с QR.",
      }).then((r) => { if (r && !r.ok) console.error("esim mail:", r.error); }).catch((e) => console.error("esim mail:", e.message));
    }
    res.json({ success: true, pending: true });
  });

  // ═══ «Моя eSIM» — страница клиента: остаток, срок, QR, продление ═══
  app.get("/esim/my", (req, res) => {
    res.set("Cache-Control", "no-store, no-cache, must-revalidate");
    res.sendFile(path.join(__dirname, "public", "esim-my.html"));
  });

  // Данные eSIM клиента: заказ (QR/LPA) + живой остаток + совместимые топапы в ₽
  app.get("/esim/api/my", async (req, res) => {
    const o = String(req.query.o || "").slice(0, 40);
    if (!o || !checkSig(o, req.query.t)) return res.status(403).json({ success: false, message: "Ссылка недействительна." });
    try {
      const [order, usage, cat, rate] = await Promise.all([
        provider.getOrder(o),
        provider.getUsage(o).catch(() => null), // остаток может быть недоступен у отдельных операторов — страница переживёт
        getCatalog(false), usdRate(),
      ]);
      const li = (order && order.orderLineItem) || {};
      const det = {};
      (li.lineItemDetails || []).forEach((x) => { det[String(x.name || "").trim()] = x.value; });
      const familyId = String(li.productFamilyId || "");
      const topups = (cat.addons || [])
        .filter((a) => a.familyId === familyId)
        .map((a) => ({ id: a.id, title: a.title, dataGb: a.dataGb, unlimited: !!a.unlimited, days: a.days, priceRub: toRetailRub(a.costUsd, rate) }))
        .sort((x, y) => x.priceRub - y.priceRub);
      const owner = emailOfProviderOrder(o);
      if (owner) setSession(res, owner);
      res.json({
        success: true, pay: tbank.ready(), you: owner || readSession(req),
        order: {
          id: o, state: (order && order.orderState) || null, title: li.title || "", operator: li.providerName || "",
          qrDataUrl: det.QR_CODE || null, lpa: det.LOCAL_PROFILE_ASSISTANT || null,
          activationCode: det.ACTIVATION_CODE || null, smdp: det.SMDP_ADDRESS || null,
          apn: det.ACCESS_POINT_NAME || null, iccid: det.ICCID || null,
        },
        usage, topups,
      });
    } catch (e) {
      const code = e.response && e.response.status;
      res.status(code === 404 ? 404 : 500).json({ success: false, message: code === 404 ? "Заказ не найден." : e.message });
    }
  });

  // Заявка на продление (топап). Пока без эквайринга — письмо менеджеру;
  // с оплатой здесь встанет: оплата → provider.createTopup → трафик добавлен.
  app.post("/esim/api/my/topup", (req, res) => {
    const b = req.body || {};
    const o = String(b.o || "").slice(0, 40);
    if (!o || !checkSig(o, b.t)) return res.status(403).json({ success: false });
    const phone = String(b.phone || "").trim().slice(0, 30);
    if (phone.replace(/\D/g, "").length < 10) return res.status(400).json({ success: false, message: "Нужен телефон." });
    const lead = {
      id: crypto.randomBytes(6).toString("hex"), ts: Date.now(), status: "topup-lead",
      parentOrderId: o, productId: String(b.productId || "").slice(0, 64),
      label: String(b.label || "").slice(0, 120), priceRub: Number(b.priceRub) || null, phone,
    };
    const orders = readJson(ORDERS_FILE, []);
    orders.unshift(lead);
    writeJson(ORDERS_FILE, orders.slice(0, 5000));
    if (opts && opts.sendMail) {
      opts.sendMail({
        to: "director@visa-sc.ru",
        subject: "VOYO eSIM: ПРОДЛЕНИЕ " + (lead.label || lead.productId),
        text: "Клиент просит продлить интернет (топап) со страницы «Моя eSIM»\n\nИсходный заказ MobiMatter: " + o +
          "\nТопап: " + (lead.label || "—") + "\nЦена для клиента: " + (lead.priceRub ? lead.priceRub + " ₽" : "—") +
          "\nТелефон клиента: " + phone + "\nID топап-продукта: " + (lead.productId || "—") +
          "\n\nВыполнить: partner.mobimatter.com → Order History & Topup → найти заказ " + o + " → Topup.",
      }).then((r) => { if (r && !r.ok) console.error("esim topup mail:", r.error); }).catch((e) => console.error("esim topup mail:", e.message));
    }
    res.json({ success: true, pending: true });
  });

  // Генератор клиентской ссылки для менеджера (после ручной покупки в портале)
  app.get("/esim/mylink", (req, res) => {
    if (String(req.query.adm || "") !== ADMIN_CODE) return res.status(403).send("Нет доступа.");
    const o = String(req.query.o || "").trim().slice(0, 40);
    if (!o) return res.send("Добавьте &o=НОМЕР_ЗАКАЗА (AKGR-…) к адресу.");
    const url = "https://voyotravel.ru/esim/my?o=" + encodeURIComponent(o) + "&t=" + signOrder(o);
    res.set("Content-Type", "text/html; charset=utf-8");
    res.send('<meta name="viewport" content="width=device-width,initial-scale=1"/><body style="font-family:-apple-system,sans-serif;padding:24px;line-height:1.6">' +
      "<b>Ссылка «Моя eSIM» для клиента:</b><br/><a href=\"" + url + "\">" + url + "</a><br/><br/>Отправьте её клиенту вместе с QR-кодом — там остаток трафика, QR и продление.</body>");
  });

  // ═══════════════ ОНЛАЙН-ОПЛАТА (Т-Касса) ═══════════════
  // Цикл: /pay/start → ссылка Т-Банка → клиент платит → вебхук /pay/notify →
  // покупаем eSIM у поставщика → клиент попадает на «Мою eSIM» с QR.
  // Заводить номенклатуру в банке не нужно: сумма и позиция чека уходят в Init.

  function findProduct(cat, id) {
    const inMain = (cat.products || []).find((x) => x.id === id);
    if (inMain) return { item: inMain, addon: false };
    const inAdd = (cat.addons || []).find((x) => x.id === id);
    return inAdd ? { item: inAdd, addon: true } : null;
  }
  function labelFor(p) {
    const vol = p.unlimited ? "безлимит" : (p.dataGb + " ГБ");
    return "eSIM " + (p.title || "") + " · " + vol + (p.days ? (" · " + p.days + " дн.") : "");
  }
  function findLocal(id) {
    const orders = readJson(ORDERS_FILE, []);
    const i = orders.findIndex((o) => o.id === id);
    return i < 0 ? null : { orders, i, order: orders[i] };
  }
  function saveLocal(orders) { writeJson(ORDERS_FILE, orders.slice(0, 5000)); }

  // Выдача товара после подтверждённой оплаты. Идемпотентна: повторный вебхук
  // не купит вторую eSIM (банк может слать уведомление несколько раз).
  async function fulfil(id) {
    const f = findLocal(id);
    if (!f) return { ok: false, message: "заказ не найден" };
    const o = f.order;
    if (o.status === "done") return { ok: true, already: true, order: o };
    if (o.status === "fulfilling") return { ok: true, pending: true };
    o.status = "fulfilling"; saveLocal(f.orders);
    try {
      const res = o.parentOrderId
        ? await provider.createTopup(o.productId, o.parentOrderId)
        : await provider.createOrder(o.productId);
      const g = findLocal(id);
      Object.assign(g.order, {
        status: "done", paidAt: Date.now(),
        mmOrderId: res.orderId, iccid: res.iccid || null, costUsd: res.costUsd || null,
        myUrl: BASE_URL + "/esim/my?o=" + encodeURIComponent(o.parentOrderId || res.orderId) +
               "&t=" + signOrder(o.parentOrderId || res.orderId),
      });
      saveLocal(g.orders);
      if (opts && opts.sendSms && g.order.phone) {
        opts.sendSms(g.order.phone, "VOYO mobile: ваша eSIM готова. QR и остаток трафика — " + g.order.myUrl)
          .catch((e) => console.error("esim sms:", e.message));
      }
      // Письмо клиенту: доступ в кабинет + QR-строка на случай, если картинка не откроется
      if (opts && opts.sendMail && g.order.email) {
        const acc = BASE_URL + "/esim/account?e=" + encodeURIComponent(g.order.email) + "&t=" + signEmail(g.order.email);
        opts.sendMail({
          to: g.order.email,
          subject: "VOYO mobile: ваша eSIM готова",
          html: '<div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;max-width:520px;margin:0 auto;color:#16202e">' +
            '<p style="font-size:19px;font-weight:700;letter-spacing:-.02em;margin:0 0 6px">Ваша eSIM готова</p>' +
            '<p style="color:#8b93a5;font-size:14px;line-height:1.6;margin:0 0 18px">' + esc(g.order.label || "") + '</p>' +
            '<p style="margin:0 0 18px"><a href="' + g.order.myUrl + '" style="display:inline-block;background:#3589bd;color:#fff;' +
            'text-decoration:none;font-weight:700;font-size:15px;padding:13px 22px;border-radius:12px">Открыть QR-код и остаток</a></p>' +
            '<p style="font-size:13.5px;line-height:1.6;color:#3a4356;margin:0 0 14px">Установка: Настройки → Сотовая связь → Добавить eSIM → сканировать QR. ' +
            'Сделайте это дома по Wi-Fi, до вылета. В поездке включите «Роуминг данных» для линии eSIM.</p>' +
            '<p style="font-size:13px;line-height:1.6;color:#8b93a5;margin:0 0 6px">Ваш личный кабинет со всеми eSIM: <a href="' + acc + '" style="color:#3589bd">открыть</a><br/>' +
            'Ссылка постоянная — сохраните это письмо.</p>' +
            '<p style="font-size:12px;color:#a6adbd;margin:18px 0 0">VOYO mobile · интернет в поездке</p></div>',
          text: "Ваша eSIM готова: " + (g.order.label || "") + "\n\nQR-код и остаток трафика: " + g.order.myUrl +
                "\nЛичный кабинет со всеми eSIM: " + acc,
        }).catch((e) => console.error("esim client mail:", e.message));
      }
      if (opts && opts.sendMail) {
        opts.sendMail({
          to: "director@visa-sc.ru",
          subject: "VOYO eSIM: ОПЛАЧЕНО " + (g.order.label || ""),
          text: "Клиент оплатил и получил eSIM автоматически.\n\nПакет: " + (g.order.label || "—") +
            "\nСумма: " + (g.order.priceRub || "—") + " ₽\nТелефон: " + (g.order.phone || "—") +
            "\nEmail: " + (g.order.email || "—") +
            "\nЗаказ MobiMatter: " + res.orderId + "\nСсылка клиента: " + g.order.myUrl,
        }).catch(() => {});
      }
      return { ok: true, order: g.order };
    } catch (e) {
      const g = findLocal(id);
      if (g) { g.order.status = "paid_failed"; g.order.error = String(e.message).slice(0, 300); saveLocal(g.orders); }
      console.error("esim fulfil:", e.message);
      // Деньги уже списаны — зовём менеджера руками добить заказ.
      if (opts && opts.sendMail) {
        opts.sendMail({
          to: "director@visa-sc.ru",
          subject: "VOYO eSIM: ОПЛАЧЕНО, но выдача НЕ прошла — нужен ручной заказ",
          text: "Клиент заплатил, но купить пакет у поставщика не удалось.\n\nВнутренний заказ: " + id +
            "\nПакет: " + (o.label || "—") + "\nID продукта: " + o.productId +
            "\nСумма: " + (o.priceRub || "—") + " ₽\nТелефон: " + (o.phone || "—") +
            "\nОшибка: " + e.message + "\n\nКупите пакет в portal.mobimatter.com и отправьте клиенту QR.",
        }).catch(() => {});
      }
      return { ok: false, message: e.message };
    }
  }

  // Начало оплаты: создаём внутренний заказ и получаем ссылку Т-Банка
  app.post("/esim/api/pay/start", async (req, res) => {
    if (!tbank.ready()) return res.status(503).json({ success: false, message: "Оплата ещё не подключена." });
    const b = req.body || {};
    // Спрашиваем ТОЛЬКО email: на него уйдёт чек от онлайн-кассы (банк требует
    // контакт покупателя в чеке) и ссылка на личный кабинет с QR и остатком.
    const email = normEmail(b.email) || readSession(req);
    if (!validEmail(email)) return res.status(400).json({ success: false, message: "Нужен корректный email." });
    const phone = String(b.phone || "").trim().slice(0, 30) || null;
    const parentOrderId = b.parent ? String(b.parent).slice(0, 40) : null;
    if (parentOrderId && !checkSig(parentOrderId, b.t)) return res.status(403).json({ success: false });
    try {
      const [cat, rate] = await Promise.all([getCatalog(false), usdRate()]);
      const found = findProduct(cat, String(b.productId || ""));
      if (!found) return res.status(400).json({ success: false, message: "Пакет не найден." });
      if (found.addon && !parentOrderId) return res.status(400).json({ success: false, message: "Топап без исходной eSIM." });
      const priceRub = toRetailRub(found.item.costUsd, rate);
      const id = crypto.randomBytes(6).toString("hex");
      const label = labelFor(found.item);
      const orders = readJson(ORDERS_FILE, []);
      orders.unshift({
        id, ts: Date.now(), status: "pending", productId: found.item.id, parentOrderId,
        label, priceRub, phone, email,
      });
      saveLocal(orders);
      const pay = await tbank.init({
        orderId: id, amountRub: priceRub,
        description: label.slice(0, 140), itemName: label,
        phone, email,
        notificationUrl: BASE_URL + "/esim/api/pay/notify",
        successUrl: BASE_URL + "/esim/pay/ok?o=" + id + "&t=" + signOrder(id),
        failUrl: BASE_URL + "/esim/pay/fail?o=" + id,
      });
      if (!pay.ok) { console.error("esim pay init:", pay.message); return res.status(502).json({ success: false, message: "Банк не принял платёж. Попробуйте ещё раз." }); }
      const g = findLocal(id);
      if (g) { g.order.paymentId = pay.paymentId; saveLocal(g.orders); }
      return res.json({ success: true, url: pay.url });
    } catch (e) { return res.status(500).json({ success: false, message: e.message }); }
  });

  // Вебхук банка. Отвечаем строкой OK — иначе Т-Банк будет повторять.
  app.post("/esim/api/pay/notify", async (req, res) => {
    const b = req.body || {};
    if (!tbank.verifyNotification(b)) { console.error("esim notify: подпись не сошлась"); return res.status(403).send("NO"); }
    res.send("OK"); // отвечаем сразу, выдачу делаем следом
    try {
      if (!tbank.isPaid(b.Status) || b.Success === false) return;
      await fulfil(String(b.OrderId || ""));
    } catch (e) { console.error("esim notify:", e.message); }
  });

  // Статус внутреннего заказа — страница «оплачено» опрашивает его
  app.get("/esim/api/pay/status", async (req, res) => {
    const id = String(req.query.o || "").slice(0, 40);
    if (!id || !checkSig(id, req.query.t)) return res.status(403).json({ success: false });
    const f = findLocal(id);
    if (!f) return res.status(404).json({ success: false });
    // Страховка: вебхук мог не дойти — спросим банк сами
    if (f.order.status === "pending" && f.order.paymentId) {
      const st = await tbank.getState(f.order.paymentId);
      if (st && st.Success && tbank.isPaid(st.Status)) { fulfil(id).catch(() => {}); return res.json({ success: true, status: "fulfilling" }); }
    }
    return res.json({ success: true, status: f.order.status, myUrl: f.order.myUrl || null });
  });

  app.get("/esim/pay/ok", (req, res) => {
    res.set("Cache-Control", "no-store");
    res.sendFile(path.join(__dirname, "public", "esim-pay-ok.html"));
  });
  app.get("/esim/pay/fail", (req, res) => {
    res.set("Cache-Control", "no-store");
    res.sendFile(path.join(__dirname, "public", "esim-pay-fail.html"));
  });

  // ═══ Личный кабинет по email: все eSIM клиента ═══
  app.get("/esim/account", (req, res) => {
    res.set("Cache-Control", "no-store, no-cache, must-revalidate");
    res.sendFile(path.join(__dirname, "public", "esim-account.html"));
  });
  app.get("/esim/api/account", (req, res) => {
    // Вход по подписанной ссылке из письма ИЛИ по уже открытой сессии
    let email = normEmail(req.query.e);
    if (email && checkEmailSig(email, req.query.t)) setSession(res, email);
    else email = readSession(req);
    if (!email) return res.status(403).json({ success: false });
    res.json({ success: true, email, esims: esimsOf(email) });
  });

  // Кто я сейчас (для шапки страниц)
  app.get("/esim/api/session", (req, res) => {
    const email = readSession(req);
    res.json({ success: true, email, esims: email ? esimsOf(email) : [] });
  });

  app.get("/esim/logout", (req, res) => { clearSession(res); res.redirect("/esim"); });

  // Служебное: состояние провайдера и кошелька (для админки/сторожа депозита)
  app.get("/esim/api/health", async (req, res) => {
    if (String(req.query.adm || "") !== ADMIN_CODE) return res.status(403).json({ success: false });
    const out = { success: true, provider: provider.name, ready: provider.ready(), markup: MARKUP, minRub: MIN_RUB };
    if (provider.ready()) { try { out.balance = await provider.getBalance(); } catch (e) { out.balanceError = e.message; } }
    const orders = readJson(ORDERS_FILE, []);
    out.interest = orders.length;
    res.json(out);
  });

  // Прогрев кэша каталога после старта (не блокируем запуск)
  if (provider.ready()) setTimeout(() => { getCatalog(true).catch(() => {}); }, 15000);
}

module.exports = { mount };
