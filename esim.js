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
  // Структура сверена с живым API 02.09.2026: PLAN_VALIDITY — в ЧАСАХ (720=30 дн),
  // продаём только esim_realtime (мгновенная выдача QR); esim_addon — топапы
  // (пригодятся рефералке), esim_delayed/replacement не берём.
  async fetchProducts() {
    const r = await axios.get(MM_BASE + "/products", { headers: mmHeaders(), timeout: 60000 });
    const list = (r.data && (r.data.result || r.data)) || [];
    const out = [];
    for (const p of list) {
      if (p.productCategory !== "esim_realtime") continue;
      const det = {};
      (p.productDetails || []).forEach((d) => { det[String(d.name || "").trim()] = d.value; });
      const rawData = parseFloat(det.PLAN_DATA_LIMIT || "") || null;
      const unit = String(det.PLAN_DATA_UNIT || "GB").toUpperCase();
      const hours = parseInt(det.PLAN_VALIDITY || "", 10) || 0;
      const cost = Number(p.wholesalePrice || 0);
      if (!cost) continue;
      out.push({
        id: String(p.productId || p.uniqueId),
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
      });
    }
    return out;
  },
  // Заказ: create → в ответе QR/LPA (activation). До первого боевого заказа
  // обкатать на тест-продуктах ($0.01, тумблер «Enable test products» в портале).
  async createOrder(productId) {
    const r = await axios.post(MM_BASE + "/order", { productId, productCategory: "esim_realtime" }, { headers: mmHeaders(), timeout: 60000 });
    return r.data && (r.data.result || r.data);
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
let _catalog = null; // { ts, source, products }
function loadCatalogFile() { if (!_catalog) _catalog = readJson(CATALOG_FILE, null); return _catalog; }
async function getCatalog(force) {
  const cached = loadCatalogFile();
  if (!provider.ready()) return { ts: Date.now(), source: "demo", products: DEMO_PRODUCTS };
  if (!force && cached && cached.source === provider.name && Date.now() - cached.ts < CATALOG_TTL_MS) return cached;
  try {
    const products = await provider.fetchProducts();
    if (products.length) { _catalog = { ts: Date.now(), source: provider.name, products }; writeJson(CATALOG_FILE, _catalog); return _catalog; }
  } catch (e) { console.error("esim catalog:", e.message); }
  // API упал — отдаём последний кэш, если есть, иначе демо
  return cached && cached.products && cached.products.length ? cached : { ts: Date.now(), source: "demo", products: DEMO_PRODUCTS };
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
          "\n\nКупить пакет: partner.mobimatter.com → Buy eSIMs (найти по ID) → QR-код отправить клиенту.",
      }).then((r) => { if (r && !r.ok) console.error("esim mail:", r.error); }).catch((e) => console.error("esim mail:", e.message));
    }
    res.json({ success: true, pending: true });
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
