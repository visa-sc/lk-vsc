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
      res.json({ success: true, demo: cat.source === "demo", live: provider.ready(), updatedAt: cat.ts, usdRate: Math.round(rate * 100) / 100, markup: adm ? MARKUP : undefined, products });
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
      res.json({
        success: true,
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
