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
// Цены: розница ₽ = закупка $ × курс ЦБ USD × наценка, округление вверх до …90
// (990/1490/2190…), минимум ESIM_MIN_RUB.
// Наценка УБЫВАЮЩАЯ по ступеням закупки (12.09.2026): плоские ×2,5 делали
// дорогие направления непродаваемыми — на Мальдивах те же проценты давали
// +2500 ₽ вместо +350 ₽ на Турции. Ступени задаются ESIM_MARKUP_TIERS.
// ОТКАТ к прежней схеме: ESIM_MARKUP_TIERS=*:2.5 в .env + pm2 restart voyo.
// Закупка и маржа клиенту НЕ отдаются; на тестовой странице видны только
// с ?adm=<ESIM_ADMIN_CODE>.
//
// env: MOBIMATTER_MERCHANT_ID, MOBIMATTER_API_KEY — ключи из портала;
// ESIM_MARKUP_TIERS (дефолт «3:2.5,15:2.45,22:2.04,40:1.93,*:1.85»),
// ESIM_MARKUP (2.5 — запасной множитель, если ступени не разобрались),
// ESIM_MIN_RUB (590), ESIM_USD_FALLBACK (90),
// ESIM_ADMIN_CODE (дефолт 280992 — превью-код Андрея).
// ─────────────────────────────────────────────────────────────────────────
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const axios = require("axios");
const express = require("express"); // нужен для express.json() на ручке бота
const tbank = require("./tbank"); // Т-Касса: приём оплат (банк за интерфейсом, как и поставщик eSIM)
const adsource = require("./adsource"); // откуда пришёл покупатель: метки Google Ads, utm и т.п.

const BASE_URL = process.env.ESIM_BASE_URL || "https://voyotravel.ru";
// Витрина открыта ещё на esim.voyotravel.ru, voyomobile.ru и voyomobile.com. Возврат из
// банка и ссылка входа в кабинет ведут туда же, где человек покупал: кука кабинета у
// каждого домена своя, и с чужого домена он оказался бы не вошедшим. Список доменов
// общий с server.js (ESIM_SITE_HOSTS).
const ESIM_HOSTS = {
  "esim.voyotravel.ru": "https://esim.voyotravel.ru",
  "voyomobile.ru": "https://voyomobile.ru",
  "voyomobile.com": "https://voyomobile.com",
};
function baseFor(req) {
  return ESIM_HOSTS[String((req && req.hostname) || "").toLowerCase()] || BASE_URL;
}
const DIR = path.join(__dirname, ".esim");
const CATALOG_FILE = path.join(DIR, "catalog.json");
const ORDERS_FILE = path.join(DIR, "orders.json");
const CUSTOMERS_FILE = path.join(DIR, "customers.json"); // баланс и реф-коды клиентов
const PROMOS_FILE = path.join(DIR, "promos.json");       // промокоды
const NOTIFY_FILE = path.join(DIR, "notify.json");       // какие напоминания уже отправлены
const LKBIND_FILE = path.join(DIR, "lkbind.json");       // телефон в ЛК → почты, на которые куплены eSIM
const TGWELCOME_FILE = path.join(DIR, "tgwelcome.json"); // каким чатам уже дарили приветственные баллы

// Напоминания о продлении: чем ближе конец пакета, тем выше шанс, что клиент
// докупит — но письмо каждого типа шлём ровно один раз на eSIM.
const NOTIFY_DAYS_BEFORE = Number(process.env.ESIM_NOTIFY_DAYS || 2);   // за сколько дней до конца срока
const NOTIFY_LOW_SHARE = Number(process.env.ESIM_NOTIFY_LOW || 0.2);    // остаток трафика ниже 20%
const NOTIFY_EVERY_MS = Number(process.env.ESIM_NOTIFY_EVERY_H || 4) * 3600 * 1000;
// Приглашение друзей: письмо (или сообщение в бот) через сутки после первой
// оплаты — человек уже попользовался eSIM и знает, что она работает.
// Одному клиенту отправляем один раз, отметки в .esim/refinvite.json.
const REFINVITE_FILE = path.join(DIR, "refinvite.json");
const REFINVITE_AFTER_MS = Number(process.env.ESIM_REFINVITE_H || 24) * 3600 * 1000;
const REF_SITE = process.env.ESIM_REF_SITE || "https://voyomobile.ru";

// Скидки: промокод и реферальная программа дают фиксированную сумму в рублях.
// К оплате всегда остаётся не меньше MIN_PAY_RUB — иначе банку нечего проводить,
// а нам нечем подтвердить покупку и выбить чек.
const REF_BONUS_RUB = Number(process.env.ESIM_REF_BONUS || 100);
const TG_WELCOME_RUB = Number(process.env.ESIM_TG_WELCOME || 100);   // подарок новичку в боте   // другу и пригласившему
const MIN_PAY_RUB = Number(process.env.ESIM_MIN_PAY || 100);
// Бонусами можно закрыть не больше половины стоимости пакета — остальное деньгами
const MAX_BONUS_SHARE = Number(process.env.ESIM_MAX_BONUS_SHARE || 0.5);
// Запас над себестоимостью, ниже которого не пускаем скидки и баллы
const DISCOUNT_FLOOR_K = Number(process.env.ESIM_DISCOUNT_FLOOR || 1.08);

const MARKUP = Number(process.env.ESIM_MARKUP || 2.5);
// Ступени наценки: «порог закупки в $ : множитель», последняя со звёздочкой —
// всё, что дороже. Разбирается из строки, чтобы менять без выкатки кода.
const MARKUP_TIERS = (function () {
  const raw = String(process.env.ESIM_MARKUP_TIERS || "3:2.5,15:2.45,22:2.04,40:1.93,*:1.85");
  const tiers = [];
  for (const part of raw.split(",")) {
    const [lim, mul] = part.split(":");
    const m = Number(mul);
    if (!m || m <= 0) continue;
    tiers.push({ upTo: String(lim).trim() === "*" ? Infinity : Number(lim), mul: m });
  }
  tiers.sort((a, b) => a.upTo - b.upTo);
  return tiers.length ? tiers : [{ upTo: Infinity, mul: MARKUP }];
})();
function markupFor(costUsd) {
  const u = Number(costUsd) || 0;
  for (const t of MARKUP_TIERS) if (u <= t.upTo) return t.mul;
  return MARKUP;
}
// Человекочитаемые ступени для админки и сторожа
function markupLabel() {
  return MARKUP_TIERS.map((t) => (t.upTo === Infinity ? ">" + "$" : "≤$" + t.upTo) + " ×" + t.mul).join(", ");
}
const MIN_RUB = Number(process.env.ESIM_MIN_RUB || 590);
// Цена за гигабайт на карточке: так делают Yotti и Telwel, и у нас она лучше.
// Выключить: ESIM_PER_GB=0 в .env и pm2 restart voyo.
const SHOW_PER_GB = String(process.env.ESIM_PER_GB || "1") !== "0";
const USD_FALLBACK = Number(process.env.ESIM_USD_FALLBACK || 90);
const ADMIN_CODE = String(process.env.ESIM_ADMIN_CODE || "280992");
const CATALOG_TTL_MS = 6 * 60 * 60 * 1000;

function ensureDir() { try { fs.mkdirSync(DIR, { recursive: true }); } catch (_) {} }
function readJson(f, dflt) { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch (_) { return dflt; } }
function writeJson(f, d) { ensureDir(); try { fs.writeFileSync(f, JSON.stringify(d, null, 1), "utf8"); } catch (e) { console.error("esim write:", e.message); } }

// ── округление розницы: вверх до ближайших …90 ──
// Свой промокод «по себестоимости»: закупка у поставщика по курсу ЦБ плюс запас
// на разницу курса конвертации и комиссия эквайринга — чтобы такая продажа
// выходила в ноль, а не в минус.
const FX_SPREAD = Number(process.env.ESIM_FX_SPREAD || 0.05);   // 5% на конвертацию
const ACQ_FEE = Number(process.env.ESIM_ACQ_FEE || 0.015);      // 1,5% эквайринг
function toCostRub(costUsd, usdRate) {
  return Math.ceil(Number(costUsd) * usdRate * (1 + FX_SPREAD) * (1 + ACQ_FEE));
}

function toRetailRub(costUsd, usdRate, minRub) {
  const raw = costUsd * usdRate * markupFor(costUsd);
  const rounded = Math.ceil((raw + 10) / 100) * 100 - 10; // 1462→1490, 930→990
  return Math.max(minRub == null ? MIN_RUB : minRub, rounded);
}

// ── Рекомендации для eSIM на Китай (14.09.2026) ──
// Любая eSIM в Китае выпускает трафик за границей, поэтому сеть бывает
// нестабильной, а российские сайты медленные. Появилось после жалобы клиента:
// сеть пропадала до авиарежима, CRM на ноутбуке еле грузились. Шаги ниже
// уходят в письмо о выдаче и открываются кнопкой на странице «Моя eSIM»
// (там свой текст в public/esim-my.html, держать одинаковым). Только Китай:
// пакеты, в названии которых есть China.
const CHINA_TIPS = [
  "Настройки → Сотовая связь → линия eSIM → «Выбор сети»: выключите «Автоматически» и выберите China Mobile. Если связь слабая, попробуйте China Unicom.",
  "Там же «Голос и данные» → LTE вместо 5G.",
  "Раздаёте интернет на компьютер: «Режим модема» → включите «Максимальная совместимость».",
  "Не включайте VPN: мессенджеры и Google работают и без него, а с ним всё медленнее.",
];
const CHINA_TIPS_NOTE = "Российские сайты в Китае открываются медленнее, чем дома. Это нормально для любой eSIM.";
const CHINA_TIPS_TEXT = "Если интернет в Китае тормозит или пропадает:\n" +
  CHINA_TIPS.map((t, i) => (i + 1) + ". " + t).join("\n") + "\n" + CHINA_TIPS_NOTE + "\n";
function isChinaLabel(label) { return /china/i.test(String(label || "")); }
function chinaTipsHtml() {
  return '<div style="background:#f4f9fd;border:1px solid #ddedf7;border-radius:12px;padding:12px 16px;margin:0 0 14px">' +
    '<p style="font-size:14px;font-weight:700;margin:0 0 6px;color:#16202e">Если интернет в Китае тормозит или пропадает</p>' +
    '<ol style="margin:0 0 8px;padding-left:18px;font-size:13.5px;line-height:1.55;color:#3a4356">' +
    CHINA_TIPS.map((t) => '<li style="margin:0 0 4px">' + t + "</li>").join("") + "</ol>" +
    '<p style="font-size:12.5px;line-height:1.5;color:#8b93a5;margin:0">' + CHINA_TIPS_NOTE + "</p></div>";
}

// Пакеты на Китай, которые советуем для работы с российскими сервисами
// (Битрикс, amoCRM и т.п.): сеть NextLink с выходом в интернет через Сингапур.
// Решение Андрея 15.09.2026 после жалобы клиента на медленные CRM через
// гонконгский выход. На витрине и в боте такие пакеты помечены зелёной сноской.
function isRuServicesPick(p) {
  return p && p.operator === "NextLink" && /singapore/i.test(p.ipBreakout || "") &&
    (p.countries || []).indexOf("CN") >= 0;
}

// Подпись под карточкой пакета (зелёная строка на витрине и в боте). Нужна там,
// где рядом стоят два внешне одинаковых пакета и клиент не видит разницы:
// у TSim на Китай это (T+C) и (Premium). Текст короткий — карточка узкая.
function packNote(p) {
  if (!p) return "";
  const t = String(p.title || "");
  const cn = (p.countries || []).indexOf("CN") >= 0;
  if (cn && /\(T\+C\)/i.test(t)) return "Работают ChatGPT и TikTok без VPN";
  if (cn && /premium/i.test(t) && p.src === "tsim") return "Сеть China Mobile, лучшее покрытие";
  if (isRuServicesPick(p)) return "Рекомендуем для Битрикс, amoCRM и др. российских сервисов в Китае";
  return "";
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
        // где трафик выходит в интернет: Hong Kong, Singapore и т.д. (нужно для подсказки ниже)
        ipBreakout: String(det.IP_BREAKOUT || "").trim(),
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
const provider = mobimatter; // основной поставщик: каталог, топапы, служебные ручки

// ═══════════════ ПОСТАВЩИК №2: TSim Tech напрямую (15.09.2026) ═══════════════
// Пакеты TSim лежат в той же витрине, клиент поставщика не видит. Незаметная
// метка: id пакета начинается с «ts_», номер заказа с «TS-», в заказе src:"tsim".
// Выключить все пакеты TSim разом: ESIM_TSIM=0 в .env и pm2 restart voyo.
// Такие же пакеты MobiMatter, спрятанные как дубли, вернутся на витрину сами.
// API сверен 15.09.2026: подпись HMAC-SHA256(account+nonce+timestamp), тело JSON,
// ответ {code:1,msg,result}; запросы пускают только с IP боевого сервера.
const TSIM_BASE = "https://api.tsimtech.com";
const TSIM_CATALOG_FILE = path.join(DIR, "catalog-tsim.json");
const TSIM_WATCH_FILE = path.join(DIR, "tsimwatch.json");
// Баланса в API нет, поэтому считаем сами: сколько всего внесено (тест $100,
// дальше депозиты) минус закупка по выданным заказам. Когда остаётся меньше
// резерва, пакеты TSim прячутся с витрины, а на почту уходит письмо.
const TSIM_CREDIT_USD = Number(process.env.ESIM_TSIM_CREDIT_USD || 100);
const TSIM_RESERVE_USD = Number(process.env.ESIM_TSIM_RESERVE_USD || 10);
// Нижняя цена для TSim своя: у них есть суточные пакеты и 1 ГБ за $0,5–1,
// и общий пол 590 ₽ съел бы весь смысл дешёвого входа. Наценка та же.
const TSIM_MIN_RUB = Number(process.env.ESIM_TSIM_MIN_RUB || 190);
function isTsimId(id) { return /^(ts_|TS-)/.test(String(id || "")); }

// ── Своё ценообразование для пакетов TSim (16.09.2026, просьба Андрея) ──
// У MobiMatter всё остаётся как было. Здесь: себестоимость = закупка × курс ЦБ
// + 5% на конвертацию + 11% налога. Наценка убывает с объёмом: ×1,8 на самых
// маленьких пакетах и ×1,4 на самых больших, цена округляется вверх до …9.
// Дальше лестница внутри страны: каждый следующий по объёму пакет ДЕШЕВЛЕ за
// гигабайт, а прибыль в рублях не меньше, чем у предыдущего (деньги важнее,
// если условия спорят). Откат к прежней схеме: ESIM_TSIM_PRICING=tiers в .env
// (тогда работает общая ступенчатая наценка и пол ESIM_TSIM_MIN_RUB), снимок
// прежних цен лежит в .esim/tsim-prices-before-ladder.json.
const TSIM_PRICING = String(process.env.ESIM_TSIM_PRICING || "ladder");
const TSIM_TAX = Number(process.env.ESIM_TSIM_TAX || 0.11);
const TSIM_FX = Number(process.env.ESIM_TSIM_FX || 0.05);
const TSIM_MUL_HI = Number(process.env.ESIM_TSIM_MUL_HI || 1.8);   // маленький пакет
const TSIM_MUL_LO = Number(process.env.ESIM_TSIM_MUL_LO || 1.4);   // самый большой
const TSIM_GB_HI = Number(process.env.ESIM_TSIM_GB_HI || 1);       // до этого объёма держим ×1,8
const TSIM_GB_LO = Number(process.env.ESIM_TSIM_GB_LO || 50);      // с этого объёма ×1,4
function tsimCostRub(costUsd, rate) { return Math.ceil(Number(costUsd) * rate * (1 + TSIM_FX) * (1 + TSIM_TAX)); }
function up9(x) { return Math.ceil((x + 1) / 10) * 10 - 1; }       // 190 → 199
function down9(x) { return Math.floor((x + 1) / 10) * 10 - 1; }    // 205 → 199
function tsimMul(gb) {
  const g = Math.max(0.1, Number(gb) || 0.1);
  if (g <= TSIM_GB_HI) return TSIM_MUL_HI;
  if (g >= TSIM_GB_LO) return TSIM_MUL_LO;
  return TSIM_MUL_HI - (TSIM_MUL_HI - TSIM_MUL_LO) * (Math.log(g / TSIM_GB_HI) / Math.log(TSIM_GB_LO / TSIM_GB_HI));
}
// Сколько гигабайт человек получает за весь срок: у суточного пакета это объём в сутки × дни
function totalGb(p) { return (Number(p.dataGb) || 0) * (p.daily ? (Number(p.days) || 1) : 1); }
const _ladderCache = {};
function tsimPriceMap(rate) {
  const cat = loadTsimCatalog();
  return ladderMap("tsim", (cat && cat.products) || [], rate, (cat && cat.ts) || 0);
}
// Лестница цен для каталога одного поставщика (см. описание выше)
function ladderMap(who, products, rate, ts) {
  const key = rate + ":" + ts + ":" + products.length;
  if (_ladderCache[who] && _ladderCache[who].key === key) return _ladderCache[who].map;
  const map = new Map();
  const groups = new Map();
  products.forEach((p) => {
    // Суточные пакеты 500 МБ/сут и 1 ГБ/сут — разные линейки: внутри каждой
    // больше дней значит больше гигабайт и дешевле за гигабайт. Если смешать,
    // «7 дней по 500 МБ» окажется дороже за гигабайт, чем «3 дня по 1 ГБ».
    const g = (p.countries || []).slice().sort().join(",") + (p.daily ? "|сут" + p.dataGb : "|пакет");
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(p);
  });
  for (const list of groups.values()) {
    const all = list.map((p) => {
      const cost = tsimCostRub(p.costUsd, rate), gb = totalGb(p);
      return { p, gb, cost, price: Math.max(up9(cost * tsimMul(gb)), cost + 1) };
    }).sort((a, b) => a.gb - b.gb || a.price - b.price);
    // Лестницу строим по основным срокам. Короткие сроки (только для страниц
    // стран) в неё не входят: иначе каждый добавленный пакет поднимал бы цену
    // следующих ступеней, и большие пакеты дорожали бы на ровном месте.
    const items = all.filter((x) => !x.p.landOnly);
    const extra = all.filter((x) => x.p.landOnly);
    let prevPerGb = Infinity, prevMargin = 0, i = 0;
    while (i < items.length) {
      let j = i;
      while (j < items.length && items[j].gb === items[i].gb) j++;
      const tier = items.slice(i, j);
      const lead = tier[0];                       // самый дешёвый пакет этого объёма — он и держит лестницу
      let price = lead.price;
      if (prevPerGb !== Infinity) price = Math.min(price, down9(prevPerGb * lead.gb - 0.01));
      if (prevMargin > 0) price = Math.max(price, up9(lead.cost + prevMargin));
      price = Math.max(price, lead.cost + 1);
      tier.forEach((x) => { map.set(x.p.id, x === lead ? price : Math.max(x.price, price)); });
      prevPerGb = price / lead.gb;
      prevMargin = price - lead.cost;
      i = j;
    }
    // Короткий срок не может стоить меньше такого же объёма из лестницы
    extra.forEach((x) => {
      const same = items.filter((y) => y.gb === x.gb).map((y) => map.get(y.p.id) || 0);
      map.set(x.p.id, Math.max(x.price, same.length ? Math.min.apply(null, same) : 0, x.cost + 1));
    });
  }
  _ladderCache[who] = { key, map };
  return map;
}
function tsimOn() {
  return Boolean(process.env.TSIM_ACCOUNT && process.env.TSIM_SECRET) && String(process.env.ESIM_TSIM || "1") !== "0";
}
// ESIM_TSIM=adm — пакеты видны и продаются только по админ-коду (обкатка до
// депозита и полного прайса). 15.09.2026 Андрей: «не работает — на витрину не надо».
function tsimAdmOnly() { return String(process.env.ESIM_TSIM || "1") === "adm"; }
function tsimHeaders(json) {
  const nonce = crypto.randomBytes(8).toString("hex");
  const ts = String(Math.floor(Date.now() / 1000));
  const sign = crypto.createHmac("sha256", String(process.env.TSIM_SECRET || ""))
    .update(String(process.env.TSIM_ACCOUNT || "") + nonce + ts).digest("hex");
  const h = { "TSIM-ACCOUNT": process.env.TSIM_ACCOUNT, "TSIM-NONCE": nonce, "TSIM-TIMESTAMP": ts, "TSIM-SIGN": sign };
  if (json) h["Content-Type"] = "application/json";
  return h;
}
async function tsimCall(method, p, body) {
  const r = await axios({ method, url: TSIM_BASE + p, data: body ? JSON.stringify(body) : undefined,
    headers: tsimHeaders(!!body), timeout: 60000 });
  const d = r.data || {};
  if (Number(d.code) !== 1) {
    const e = new Error("TSim " + p.split("?")[0] + ": " + (d.msg || "ошибка"));
    e.tsimCode = d.code;
    throw e;
  }
  return d.result;
}
// Время у TSim — пекинское (UTC+8) строкой «2025-10-27 12:17:06»
function tsimTime(s) {
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})$/.exec(String(s || "").trim());
  return m ? new Date(m[1] + "T" + m[2] + "+08:00").toISOString() : null;
}
function lpaParts(lpa) {
  const m = /^LPA:1\$([^$]+)\$(.+)$/.exec(String(lpa || ""));
  return m ? { smdp: m[1], code: m[2] } : { smdp: null, code: null };
}
// QR рисуем сами из LPA-строки; если библиотека не загрузилась, берём картинку TSim
async function qrFromLpa(lpa, remoteUrl) {
  try { return await require("qrcode").toDataURL(lpa, { margin: 1, width: 480 }); } catch (_) {}
  if (!remoteUrl) return null;
  try {
    const r = await axios.get(remoteUrl, { responseType: "arraybuffer", timeout: 20000 });
    const ct = String(r.headers["content-type"] || "image/png").split(";")[0];
    return /^image\//.test(ct) ? "data:" + ct + ";base64," + Buffer.from(r.data).toString("base64") : null;
  } catch (_) { return null; }
}
// У TSim на каждую страну по 70–80 вариантов: 8 сроков на каждый объём и 11
// сроков у суточных. Чтобы витрина не превратилась в кашу, берём привычные
// сроки. Списки меняются в .env без выкатки кода.
// Обычные сроки в общем каталоге — 7, 15 и 30 дней, как было. Короткие 3, 5 и
// 10 дней добавлены 16.09.2026 только для рекламных страниц стран
// (voyomobile.ru/turkey и /china): там спрос на короткие поездки, а общий
// каталог от них разбухает. Оба списка меняются в .env.
const TSIM_DAYS = String(process.env.ESIM_TSIM_DAYS || "7,15,30").split(",").map(Number);
const TSIM_DAYS_LAND = String(process.env.ESIM_TSIM_DAYS_LAND || "3,5,10").split(",").map(Number).filter((d) => d);
const TSIM_DAILY_DAYS = String(process.env.ESIM_TSIM_DAILY_DAYS || "1,3,5,7,10,15").split(",").map(Number);
const TSIM_DAILY_MAX_MB = Number(process.env.ESIM_TSIM_DAILY_MAX_MB || 1024);
function tsimItem(p) {
  if (p.status != null && String(p.status) !== "1") return null;
  const isDaily = p.is_daily === true || String(p.is_daily) === "1";
  const days = Number(p.day) || 0;
  // У суточных пакетов data_allowance — трафик за ВЕСЬ срок (3 дня × 500 МБ = 1500),
  // а на витрине нужен объём в сутки. Сверено с прайсом 16.09.2026.
  const perDayMb = isDaily && days ? Math.round(Number(p.data_allowance) / days) : Number(p.data_allowance);
  const landOnly = !isDaily && TSIM_DAYS.indexOf(days) < 0 && TSIM_DAYS_LAND.indexOf(days) >= 0;
  if (isDaily ? (TSIM_DAILY_DAYS.indexOf(days) < 0 || perDayMb > TSIM_DAILY_MAX_MB)
              : (TSIM_DAYS.indexOf(days) < 0 && !landOnly)) return null;
  if (String(p.currency || "USD").toUpperCase() !== "USD") return null;
  // пакеты с датой активации «на заказ» требуют дату при покупке — не наш случай
  if (Number(p.scheduled_activation) === 1) return null;
  const cost = Number(p.price);
  const mb = perDayMb;   // суточный — за сутки, обычный — весь пакет
  const countries = (p.coverages || []).map((c) => String(c.country_code || "").toUpperCase()).filter((c) => /^[A-Z]{2}$/.test(c));
  if (!cost || !mb || mb <= 0 || !countries.length || !p.channel_dataplan_id) return null;
  const name = String(p.channel_dataplan_name || "");
  return {
    id: "ts_" + p.channel_dataplan_id, src: "tsim", familyId: "",
    title: name, operator: "TSimTech", countries,
    dataGb: Math.round((mb / 1024) * 10) / 10, unlimited: false,
    daily: isDaily,
    days: days || null, costUsd: cost, retailUsd: null,
    fiveG: /5g/i.test(name + " " + (p.spec_name || "")), hotspot: true,
    topup: Number(p.topup_support) === 1,
    landOnly,   // короткий срок: показываем только на страницах стран
    ipBreakout: /\(T\+C\)/i.test(name) ? "T+C" : "",
    dataMb: mb,
  };
}
function tsimSpentUsd() {
  return readJson(ORDERS_FILE, []).filter((o) => o.src === "tsim" && o.status === "done")
    .reduce((s, o) => s + (Number(o.costUsd) || 0), 0);
}
function tsimLeftUsd() { return Math.round((TSIM_CREDIT_USD - tsimSpentUsd()) * 100) / 100; }
// Каталоги поставщиков держим в памяти: цены считаются по каждому пакету, и
// чтение файла на 3000 позиций из каждого вызова растягивало ответ витрины до
// десятков секунд (поймано 16.09.2026). Перечитываем, только если файл изменился.
const _catCache = {};
function loadCatalogCached(file) {
  let mt = 0;
  try { mt = fs.statSync(file).mtimeMs; } catch (_) { return null; }
  const c = _catCache[file];
  if (c && c.mt === mt) return c.data;
  const data = readJson(file, null);
  _catCache[file] = { mt, data };
  return data;
}
function loadTsimCatalog() { return loadCatalogCached(TSIM_CATALOG_FILE); }

const tsim = {
  name: "tsim",
  ready: tsimOn,
  async fetchProducts() {
    const products = [];
    for (let page = 1; page <= 200; page++) {
      const res = await tsimCall("get", "/tsim/v2/dataplanList?pageNo=" + page + "&pageSize=100&all_column=1");
      const data = (res && res.data) || [];
      data.forEach((p) => { const it = tsimItem(p); if (it) products.push(it); });
      if (!data.length || page >= Number((res && res.last_page) || 0)) break;
    }
    return { products, addons: [] };
  },
  // Заказ: esimSubscribe → topup_id, профиль готовится асинхронно, поэтому
  // опрашиваем topupDetail, пока не придёт LPA-строка.
  async createOrder(productId) {
    const planId = String(productId).replace(/^ts_/, "");
    const plan = ((loadTsimCatalog() || {}).products || []).find((x) => x.id === productId) || {};
    let topupId;
    try {
      const r = await tsimCall("post", "/tsim/v1/esimSubscribe", {
        number: 1, channel_dataplan_id: planId, custom_order_no: "VOYO" + Date.now() + crypto.randomBytes(2).toString("hex"),
      });
      topupId = r && r.topup_id;
    } catch (e) { e.noOrder = true; throw e; }
    if (!topupId) { const e = new Error("TSim: заказ не создан"); e.noOrder = true; throw e; }
    let det = null;
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, i < 5 ? 2000 : 3000));
      try { det = await tsimCall("post", "/tsim/v1/topupDetail", { topup_id: topupId }); } catch (e) { if (Number(e.tsimCode) !== 1006) throw e; }
      if (det && (det.lpa_str || [])[0]) break;
    }
    if (!det || !(det.lpa_str || [])[0]) throw new Error("TSim: заказ TS-" + topupId + " создан, но QR не пришёл за 90 секунд");
    const view = await this._view(det);
    return Object.assign(view, { orderId: "TS-" + topupId, state: "Completed", costUsd: Number(plan.costUsd) || null });
  },
  async createTopup() { throw new Error("TSim: продление через API пока не подключено"); },
  async _view(det) {
    const lpa = (det.lpa_str || [])[0] || null;
    const parts = lpaParts(lpa);
    return {
      title: det.channel_dataplan_name || "", operator: "TSimTech",
      iccid: (det.operator_iccids || [])[0] || (det.device_ids || [])[0] || null,
      deviceId: (det.device_ids || [])[0] || null,
      lpa, activationCode: parts.code, smdp: parts.smdp, apn: det.apn || null,
      qrDataUrl: lpa ? await qrFromLpa(lpa, (det.qrcode || [])[0]) : null,
      planId: det.channel_dataplan_id || "",
    };
  },
  async getOrderView(orderId) {
    const det = await tsimCall("post", "/tsim/v1/topupDetail", { topup_id: String(orderId).replace(/^TS-/, "") });
    return this._view(det || {});
  },
  // Остаток: deviceDetail по ICCID. У суточных пакетов показываем сегодняшний день.
  async getUsage(orderId) {
    const topupId = String(orderId).replace(/^TS-/, "");
    const det = await tsimCall("post", "/tsim/v1/topupDetail", { topup_id: topupId });
    const deviceId = (det && (det.device_ids || [])[0]) || null;
    const plan = ((loadTsimCatalog() || {}).products || []).find((x) => x.id === "ts_" + (det && det.channel_dataplan_id)) || {};
    const totalMb = Number(plan.dataMb) || 0;
    let d = null;
    if (deviceId) { try { d = await tsimCall("post", "/tsim/v1/deviceDetail", { device_id: deviceId, topup_id: topupId }); } catch (_) {} }
    const events = (d && d.esim_event) || [];
    const daily = d ? (d.is_daily === true || String(d.is_daily) === "1") : !!plan.daily;
    let usedMb = d ? Number(d.data_usage) || 0 : 0;
    if (daily && d) {
      const today = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
      const day = (d.data_usage_daily || []).find((x) => x.date === today);
      usedMb = day ? Number(day.total_usage) || 0 : 0;
    }
    return {
      installed: events.some((e) => /INSTALL|ENABLE|DOWNLOAD/i.test(e.notify_type || "")),
      status: (d && d.status) || null, iccid: (det && ((det.operator_iccids || [])[0] || deviceId)) || null,
      suspended: !!(d && d.terminate_time), daily,
      packages: totalMb ? [{
        name: (det && det.channel_dataplan_name) || "", totalMb, usedMb,
        remainingMb: Math.max(0, totalMb - usedMb),
        // до активации expire_time — крайний срок установки, а не конец пакета
        activatedAt: d ? tsimTime(d.active_time) : null,
        expiresAt: d && tsimTime(d.active_time) ? tsimTime(d.expire_time) : null,
      }] : [],
    };
  },
  getBalance() { return { spentUsd: Math.round(tsimSpentUsd() * 100) / 100, leftUsd: tsimLeftUsd(), creditUsd: TSIM_CREDIT_USD }; },
};
// ═══════════════ ПОСТАВЩИК №3: eSIM Access (Redtea) 16.09.2026 ═══════════════
// Нужен там, где у TSim пусто: Грузия, Армения, Казахстан, Узбекистан,
// Шри-Ланка, плюс дешёвые суточные и Таиланд. Устроен так же, как TSim:
// id пакета «ea_…», номер заказа «EA-…», в заказе src:"esimaccess".
// Режимы ESIM_EA: 0 — выключен совсем (по умолчанию), adm — видно только по
// админ-коду, 1 — в бою. Ключ ESIMACCESS_ACCESS_CODE только в прод .env.
// API сверен 16.09.2026: один заголовок RT-AccessCode, ответ {success,obj},
// цены в 1/10000 USD, объём в байтах, баланс есть отдельной ручкой.
const EA_BASE = "https://api.esimaccess.com";
const EA_CATALOG_FILE = path.join(DIR, "catalog-ea.json");
const EA_RESERVE_USD = Number(process.env.ESIM_EA_RESERVE_USD || 5);
// Сторож баланса поставщиков: ниже «низкого» порога уходит письмо один раз,
// ниже «критического» — каждые сутки, пока не пополним. Файл состояния общий.
const BAL_WATCH_FILE = path.join(DIR, "balancewatch.json");
const EA_LOW_USD = Number(process.env.ESIM_EA_LOW_USD || 20);
const MM_LOW_USD = Number(process.env.ESIM_MM_LOW_USD || 20);
const MM_CRIT_USD = Number(process.env.ESIM_MM_CRIT_USD || 10);
const EA_DAYS = String(process.env.ESIM_EA_DAYS || "1,3,5,7,10,15,30").split(",").map(Number);
// Порог в мегабайтах: у них «500MB» — это 0,49 ГБ, и порог «от 0,5 ГБ» резал
// все самые дешёвые пакеты. Пакеты по 100 МБ не берём: стоят столько же,
// сколько 500 МБ, клиенту от них только вред.
const EA_MIN_MB = Number(process.env.ESIM_EA_MIN_MB || 400);
function eaMode() { return String(process.env.ESIM_EA || "0"); }
function eaOn() { return Boolean(process.env.ESIMACCESS_ACCESS_CODE) && eaMode() !== "0"; }
function eaAdmOnly() { return eaMode() === "adm"; }
function isEaId(id) { return /^(ea_|EA-)/.test(String(id || "")); }
async function eaCall(p, body) {
  const r = await axios.post(EA_BASE + p, body || {}, {
    headers: { "RT-AccessCode": process.env.ESIMACCESS_ACCESS_CODE, "Content-Type": "application/json" },
    timeout: 60000,
  });
  const d = r.data || {};
  if (!d.success) {
    const e = new Error("eSIM Access " + p.split("/").pop() + ": " + (d.errorMsg || d.errorCode || "ошибка"));
    e.eaCode = d.errorCode;
    throw e;
  }
  return d.obj;
}
function eaItemRaw(p) {
  const loc = String(p.location || "").split(",").map((x) => x.trim().toUpperCase()).filter((c) => /^[A-Z]{2}$/.test(c));
  const gb = Number(p.volume) / 1073741824;
  const days = Number(p.duration) || 0;
  const cost = Number(p.price) / 10000;
  if (!gb || !days || !cost || !p.packageCode) return null;
  const name = String(p.name || "");
  return {
    id: "ea_" + p.packageCode, src: "esimaccess", familyId: "", title: name, operator: "eSIM Access",
    countries: loc, dataGb: Math.round(gb * 10) / 10, unlimited: false, daily: /\/\s*day/i.test(name),
    days, costUsd: cost, retailUsd: Number(p.retailPrice || 0) / 10000 || null,
    fiveG: /5G/i.test(String(p.speed || "")), hotspot: true, topup: Number(p.supportTopUpType) > 0,
    ipBreakout: String(p.ipExport || "").trim(), dataMb: Math.round(gb * 1024),
  };
}
function eaItem(p) {
  const loc = String(p.location || "").split(",").map((x) => x.trim().toUpperCase()).filter((c) => /^[A-Z]{2}$/.test(c));
  const gb = Number(p.volume) / 1073741824;
  const days = Number(p.duration) || 0;
  const cost = Number(p.price) / 10000;
  if (!loc.length || !gb || !days || !cost || !p.packageCode) return null;
  if (Math.round(gb * 1024) < EA_MIN_MB || EA_DAYS.indexOf(days) < 0) return null;
  const name = String(p.name || "");
  // «/Day» у них значит суточный пакет: объём в сутки, цена тоже за сутки
  const daily = /\/\s*day/i.test(name);
  return {
    id: "ea_" + p.packageCode, src: "esimaccess", familyId: "",
    title: name, operator: "eSIM Access", countries: loc,
    dataGb: Math.round(gb * 10) / 10, unlimited: false, daily, days,
    costUsd: cost, retailUsd: Number(p.retailPrice || 0) / 10000 || null,
    fiveG: /5G/i.test(String(p.speed || "")), hotspot: true,
    topup: Number(p.supportTopUpType) > 0,
    ipBreakout: String(p.ipExport || "").trim(),
    dataMb: Math.round(gb * 1024),
  };
}
function loadEaCatalog() { return loadCatalogCached(EA_CATALOG_FILE); }
let _eaBalance = { ts: 0, usd: 0 };
const esimaccess = {
  name: "esimaccess",
  ready: eaOn,
  async fetchProducts() {
    const obj = await eaCall("/api/v1/open/package/list", {});
    const list = (obj && (obj.packageList || obj.list)) || [];
    const products = [];
    list.forEach((p) => { const it = eaItem(p); if (it) products.push(it); });
    return { products, addons: [] };
  },
  async createOrder(productId) {
    const code = String(productId).replace(/^ea_/, "");
    const plan = ((loadEaCatalog() || {}).products || []).find((x) => x.id === productId) || {};
    const price = Math.round(Number(plan.costUsd || 0) * 10000);
    let orderNo;
    try {
      const res = await eaCall("/api/v1/open/esim/order", {
        transactionId: "VOYO" + Date.now() + crypto.randomBytes(2).toString("hex"),
        amount: price,
        packageInfoList: [{ packageCode: code, count: 1, price }],
      });
      orderNo = res && (res.orderNo || res.orderNumber);
    } catch (e) { e.noOrder = true; throw e; }
    if (!orderNo) { const e = new Error("eSIM Access: заказ не создан"); e.noOrder = true; throw e; }
    let esim = null;
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, i < 5 ? 2000 : 3000));
      try { esim = await this._esim(orderNo); } catch (e) { if (Number(e.eaCode) !== 310272) throw e; }
      if (esim && (esim.ac || esim.qrCodeUrl)) break;
    }
    if (!esim || !(esim.ac || esim.qrCodeUrl)) throw new Error("eSIM Access: заказ EA-" + orderNo + " создан, но QR не пришёл за 90 секунд");
    const view = await this._view(esim);
    return Object.assign(view, { orderId: "EA-" + orderNo, state: "Completed", costUsd: Number(plan.costUsd) || null });
  },
  // Докупка гигабайт на ту же eSIM (16.09.2026, подтвердил Rain Wang).
  // Список пополнений берётся по коду исходного пакета: package/list
  // {packageCode, type:"TOPUP"} → пакеты TOPUP_*. Пополнять можно, пока eSIM
  // новая, активная или пустая, но не после окончания срока.
  async listTopups(orderId, rate) {
    const e = await this._esim(orderId);
    const base = this._pack(e).packageCode;
    if (!e || !base) return [];
    const obj = await eaCall("/api/v1/open/package/list", { packageCode: base, type: "TOPUP" });
    const list = (obj && (obj.packageList || obj.list)) || [];
    return list.map((p) => {
      const it = eaItemRaw(p);
      if (!it) return null;
      const price = Math.max(up9(tsimCostRub(it.costUsd, rate) * tsimMul(totalGb(it))), tsimCostRub(it.costUsd, rate) + 1);
      return { id: it.id, title: it.title, dataGb: it.dataGb, unlimited: false, daily: it.daily, days: it.days, priceRub: price, costUsd: it.costUsd };
    }).filter(Boolean).sort((a, b) => a.priceRub - b.priceRub);
  },
  async createTopup(productId, parentOrderId) {
    const e = await this._esim(parentOrderId);
    if (!e) { const err = new Error("eSIM Access: eSIM не найдена"); err.noOrder = true; throw err; }
    const code = String(productId).replace(/^ea_/, "");
    const tops = await this.listTopups(parentOrderId, 1).catch(() => []);
    const plan = tops.find((x) => x.id === productId);
    const price = Math.round(Number((plan && plan.costUsd) || 0) * 10000);
    const res = await eaCall("/api/v1/open/esim/topup", {
      transactionId: "VOYO" + Date.now() + crypto.randomBytes(2).toString("hex"),
      esimTranNo: e.esimTranNo, packageCode: code, amount: price, price,
    });
    const view = await this._view(e);
    return Object.assign(view, {
      orderId: parentOrderId, state: "Completed",
      costUsd: (plan && plan.costUsd) || null, topupOrderNo: (res && (res.orderNo || res.topUpOrderNo)) || null,
    });
  },
  async _esim(orderNo) {
    const obj = await eaCall("/api/v1/open/esim/query", {
      orderNo: String(orderNo).replace(/^EA-/, ""), pager: { pageNum: 1, pageSize: 20 },
    });
    return ((obj && (obj.esimList || obj.list)) || [])[0] || null;
  },
  _pack(e) { return ((e && e.packageList) || [])[0] || {}; },
  async _view(e) {
    const lpa = e.ac || e.activationCode || null;
    const parts = lpaParts(lpa);
    const pk = this._pack(e);
    return {
      title: pk.packageName || e.packageName || "", operator: "eSIM Access",
      iccid: e.iccid || null, lpa,
      activationCode: parts.code || e.acCode || null, smdp: parts.smdp || e.smdpAddress || null,
      apn: e.apn || null,
      qrDataUrl: lpa ? await qrFromLpa(lpa, e.qrCodeUrl) : null,
    };
  },
  async getOrderView(orderId) {
    const e = await this._esim(orderId);
    if (!e) { const err = new Error("eSIM Access: заказ не найден"); err.eaCode = 310272; throw err; }
    return this._view(e);
  },
  async getUsage(orderId) {
    const e = await this._esim(orderId);
    if (!e) return { installed: false, status: null, iccid: null, suspended: false, packages: [] };
    const pk = this._pack(e);
    const totalMb = Math.round(Number(e.totalVolume || 0) / 1048576);
    const usedMb = Math.round(Number(e.orderUsage || e.usage || 0) / 1048576);
    // RELEASED значит «профиль выпущен, но ещё не установлен» — в статусах их API
    // установка видна по installationTime и по ENABLED/INSTALLED
    const st = String(e.smdpStatus || "").toUpperCase();
    return {
      installed: Boolean(e.installationTime) || /INSTALL|ENABLE|DOWNLOAD/.test(st),
      status: e.esimStatus || e.smdpStatus || null, iccid: e.iccid || null,
      suspended: String(e.esimStatus || "").toUpperCase() === "SUSPENDED",
      daily: /\/\s*day/i.test(String(pk.packageName || "")),
      packages: totalMb ? [{
        name: pk.packageName || "", totalMb, usedMb, remainingMb: Math.max(0, totalMb - usedMb),
        // до активации expiredTime — крайний срок установки, а не конец пакета
        activatedAt: e.activateTime || null,
        expiresAt: e.activateTime ? e.expiredTime : null,
      }] : [],
    };
  },
  // У них баланс есть в API, в отличие от TSim: держим значение пять минут
  async getBalance() {
    const obj = await eaCall("/api/v1/open/balance/query");
    const usd = Number((obj && obj.balance) || 0) / 10000;
    _eaBalance = { ts: Date.now(), usd };
    return { balanceUsd: usd };
  },
  balanceUsd() { return _eaBalance.usd; },
};

// По номеру заказа или id пакета понимаем, у кого он куплен
function providerFor(id) { return isEaId(id) ? esimaccess : (isTsimId(id) ? tsim : provider); }

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
// Общий каталог витрины: MobiMatter + пакеты TSim (если включены и хватает кредита)
async function getCatalog(force) {
  const mm = await getMmCatalog(force);
  const [ts, ea] = await Promise.all([getTsimProducts(force), getEaProducts(force)]);
  const extra = ts.concat(ea);
  return extra.length ? Object.assign({}, mm, { products: mm.products.concat(extra) }) : mm;
}
let _eaFetching = null;
async function getEaProducts(force) {
  if (!esimaccess.ready()) return [];
  const cached = loadEaCatalog();
  const ttl = cached && cached.products && cached.products.length ? CATALOG_TTL_MS : 20 * 60 * 1000;
  let cat = cached;
  if (force || !cached || Date.now() - cached.ts > ttl) {
    if (!_eaFetching) {
      _eaFetching = esimaccess.fetchProducts()
        .then(({ products }) => { const c = { ts: Date.now(), products }; writeJson(EA_CATALOG_FILE, c); return c; })
        .catch((e) => { console.error("esim ea catalog:", e.message); return cached; })
        .finally(() => { _eaFetching = null; });
    }
    if (!cached || force) cat = await _eaFetching;
  }
  if (!cat || !cat.products || !cat.products.length) return [];
  // баланс у них живой: пакеты прячем, когда денег почти не осталось
  if (Date.now() - _eaBalance.ts > 5 * 60 * 1000) esimaccess.getBalance().catch(() => {});
  // в боевом режиме прячем пакеты, когда денег почти нет; в режиме adm смотрим и с нулём
  if (eaMode() === "1" && _eaBalance.ts && _eaBalance.usd < EA_RESERVE_USD) return [];
  return cat.products;
}
let _tsimFetching = null;
async function getTsimProducts(force) {
  if (!tsim.ready()) return [];
  const cached = loadTsimCatalog();
  // пустой список (пакеты ещё не открыли) перепроверяем чаще
  const ttl = cached && cached.products && cached.products.length ? CATALOG_TTL_MS : 20 * 60 * 1000;
  let cat = cached;
  if (force || !cached || Date.now() - cached.ts > ttl) {
    if (!_tsimFetching) {
      _tsimFetching = tsim.fetchProducts()
        .then(({ products }) => { const c = { ts: Date.now(), products }; writeJson(TSIM_CATALOG_FILE, c); return c; })
        .catch((e) => { console.error("esim tsim catalog:", e.message); return cached; })
        .finally(() => { _tsimFetching = null; });
    }
    // без кэша ждём ответа; с кэшем отдаём старое, свежее подтянется фоном
    if (!cached || force) cat = await _tsimFetching;
  }
  if (!cat || !cat.products || !cat.products.length) return [];
  if (tsimLeftUsd() < TSIM_RESERVE_USD) return [];
  return cat.products;
}
// Розница: у MobiMatter общая ступенчатая наценка, у TSim своя лестница
function baseRetailFor(item, rate) {
  if (isEaId(item.id) && TSIM_PRICING === "ladder") {
    const cat = loadEaCatalog();
    const p = ladderMap("ea", (cat && cat.products) || [], rate, (cat && cat.ts) || 0).get(item.id);
    if (p) return p;
  }
  if (isTsimId(item.id) && TSIM_PRICING === "ladder") {
    const p = tsimPriceMap(rate).get(item.id);
    if (p) return p;
  }
  return toRetailRub(item.costUsd, rate, isTsimId(item.id) ? TSIM_MIN_RUB : MIN_RUB);
}

// ── ПОДЪЁМ ЦЕН (17.09.2026, решение Андрея) ─────────────────────────────
// Входные пакеты дешевле 200 ₽ не трогаем: на эти цифры («от 59 ₽») идут
// объявления в Директе и первый экран витрины. Выше — шаг вверх ступенями,
// округление вверх до …9. Ступени задаются строкой «порог:процент»,
// ESIM_UPLIFT=0 выключает подъём целиком и возвращает прежние цены.
const UPLIFT_RAW = String(process.env.ESIM_UPLIFT || "200:5,500:8,1000:10");
const UPLIFT_STEPS = (UPLIFT_RAW === "0" ? [] : UPLIFT_RAW.split(","))
  .map((x) => ({ from: Number(x.split(":")[0]), k: 1 + Number(x.split(":")[1]) / 100 }))
  .filter((x) => x.from > 0 && x.k > 1)
  .sort((a, b) => b.from - a.from);
function upliftOf(price) {
  const st = UPLIFT_STEPS.find((x) => price >= x.from);
  return st ? up9(price * st.k) : price;
}
// Гигабайт в большом пакете обязан остаться дешевле, чем в меньшем. Если
// подъём это правило ломает — такой пакет оставляем в прежней цене (просьба
// Андрея: «если на объёме выйдет дороже, чем поштучно, не поднимай»).
let _upliftSkip = { key: "", set: new Set() };
function upliftSkipSet(rate) {
  const cats = [loadCatalogFile(), loadTsimCatalog(), loadEaCatalog()];
  const key = cats.map((c) => (c && c.ts) || 0).join("|") + "|" + rate + "|" + UPLIFT_RAW;
  if (_upliftSkip.key === key) return _upliftSkip.set;
  const skip = new Set();
  const groups = new Map();
  cats.forEach((c) => ((c && c.products) || []).forEach((p) => {
    if (!p || !p.id || p.unlimited || !p.dataGb) return;
    // сравниваем внутри одного набора стран; суточные линейки считаем отдельно
    const g = (p.countries || []).slice().sort().join(",") + (p.daily ? "|сут" + p.dataGb : "|пакет");
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(p);
  }));
  groups.forEach((list) => {
    const vol = (p) => p.dataGb * (p.daily ? (p.days || 1) : 1);
    list.sort((a, b) => vol(a) - vol(b));
    let best = Infinity;                      // лучшая (наименьшая) цена за ГБ среди меньших пакетов
    list.forEach((p) => {
      const gb = vol(p) || 1;
      const base = baseRetailFor(p, rate);
      const up = upliftOf(base);
      if (up > base && up / gb > best) skip.add(p.id);
      best = Math.min(best, (skip.has(p.id) ? base : up) / gb);
    });
  });
  _upliftSkip = { key, set: skip };
  return skip;
}
function retailFor(item, rate) {
  const base = baseRetailFor(item, rate);
  if (!UPLIFT_STEPS.length) return base;
  if (item.unlimited || !item.dataGb) return upliftOf(base);   // безлимит сравнивать по ГБ не с чем
  return upliftSkipSet(rate).has(item.id) ? base : upliftOf(base);
}
// СЕБЕСТОИМОСТЬ (одинаково для всех поставщиков, 16.09.2026):
// закупка × курс ЦБ + 5% на конвертацию + 11% налога. Ниже неё цена не падает
// ни при каких скидках. Раньше у MobiMatter считалось без налога, и промокод
// мог увести продажу в ноль по факту.
function costFor(item, rate) { return tsimCostRub(item.costUsd, rate); }
async function getMmCatalog(force) {
  const cached = loadCatalogFile();
  if (!provider.ready()) return { ts: Date.now(), source: "demo", products: DEMO_PRODUCTS, addons: [] };
  // кэш старого формата (без addons) не годится — обновляем
  // кэш без ipBreakout (до 15.09.2026) тоже старый формат
  const fresh = cached && cached.products && cached.products[0] && ("ipBreakout" in cached.products[0]);
  if (!force && cached && fresh && cached.source === provider.name && Array.isArray(cached.addons) && Date.now() - cached.ts < CATALOG_TTL_MS) return cached;
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

// ═══ Клиенты: баланс в рублях и реферальный код ═══
// Отдельный файл, чтобы заказы оставались журналом покупок, а деньги клиента —
// самостоятельной сущностью с историей начислений и списаний.
function loadCustomers() { return readJson(CUSTOMERS_FILE, {}); }
function saveCustomers(d) { writeJson(CUSTOMERS_FILE, d); }
// Код без похожих символов (0/O, 1/I) — его диктуют голосом и пишут от руки
const REF_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
function makeRefCode(email, all) {
  const h = crypto.createHmac("sha256", LINK_SECRET).update("ref:" + email).digest();
  for (let attempt = 0; attempt < 40; attempt++) {
    let code = "";
    for (let i = 0; i < 6; i++) code += REF_ALPHABET[h[(i + attempt * 6) % h.length] % REF_ALPHABET.length];
    if (!Object.values(all).some((c) => c.refCode === code)) return code;
  }
  return crypto.randomBytes(4).toString("hex").toUpperCase();
}
// Кто перед нами. На сайте это почта, в телеграм-боте почты может не быть —
// тогда личностью служит сам чат: «tg:12345». Ключ один и тот же и для
// промокодов (чтобы одноразовый не сработал дважды), и для бонусов рефералки.
function tgKey(chatId) { return chatId ? "tg:" + String(chatId).replace(/[^\d]/g, "") : ""; }
function custKey(email, tgChatId) {
  const e = normEmail(email);
  if (validEmail(e)) return e;
  return tgKey(tgChatId);
}
function validKey(k) { return validEmail(k) || /^tg:\d+$/.test(String(k || "")); }

function getCustomer(email, create) {
  email = normEmail(email);
  if (!validKey(email)) return null;
  const all = loadCustomers();
  if (!all[email]) {
    if (!create) return null;
    all[email] = { email, refCode: makeRefCode(email, all), balanceRub: 0, invitedBy: null, ts: Date.now(), ledger: [] };
    saveCustomers(all);
  }
  return all[email];
}
function updateCustomer(email, fn) {
  email = normEmail(email);
  const all = loadCustomers();
  if (!all[email]) all[email] = { email, refCode: makeRefCode(email, all), balanceRub: 0, invitedBy: null, ts: Date.now(), ledger: [] };
  fn(all[email]);
  saveCustomers(all);
  return all[email];
}
function addBalance(email, rub, note) {
  return updateCustomer(email, (c) => {
    c.balanceRub = Math.max(0, Math.round((c.balanceRub || 0) + rub));
    c.ledger = [{ ts: Date.now(), rub: Math.round(rub), note: String(note || "").slice(0, 80) }].concat(c.ledger || []).slice(0, 100);
  });
}
function customerByRef(code) {
  code = String(code || "").trim().toUpperCase();
  if (!code) return null;
  return Object.values(loadCustomers()).find((c) => c.refCode === code) || null;
}
function hasOrders(key) {
  key = normEmail(key);
  return readJson(ORDERS_FILE, []).some((o) => (o.custKey || o.email) === key && (o.status === "done" || o.status === "fulfilling"));
}

// ═══ Промокоды ═══
// { "КОД": { rub: 100, active: true, maxUses: null, uses: 0, note: "" } }
function loadPromos() { return readJson(PROMOS_FILE, {}); }
// Возвращает скидку либо причину отказа — клиенту важно понимать, почему код не сработал
let _promoReason = null;
function checkPromo(code, listPrice, email) {
  _promoReason = null;
  code = String(code || "").trim().toUpperCase();
  if (!code) return null;
  const p = loadPromos()[code];
  if (!p) { _promoReason = "not_found"; return null; }
  if (p.active === false) { _promoReason = "inactive"; return null; }
  // Срок акции по московскому времени: from — с начала дня, to — до конца дня
  // включительно. Появилось 15.09.2026 под SEXTRIP (15–27 октября).
  const now = Date.now();
  if (p.from && now < new Date(p.from + "T00:00:00+03:00").getTime()) { _promoReason = "not_started"; return null; }
  if (p.to && now > new Date(p.to + "T23:59:59.999+03:00").getTime()) { _promoReason = "expired"; return null; }
  if (p.maxUses && (p.uses || 0) >= p.maxUses) { _promoReason = "limit"; return null; }
  // «Только на первую eSIM» — у клиента ещё не должно быть выданных заказов
  if (p.firstOnly && email && hasOrders(email)) { _promoReason = "first_only"; return null; }
  // «Один раз на клиента» — код уже засчитан этой почте
  if (p.oncePerUser !== false && email) {
    const c = getCustomer(email, false);
    if (c && (c.usedPromos || []).indexOf(code) >= 0) { _promoReason = "used"; return null; }
  }
  const rub = p.pct
    ? Math.round((Number(listPrice) || 0) * Number(p.pct) / 100)
    : Math.max(0, Number(p.rub) || 0);
  return { code, rub, pct: Number(p.pct) || 0, firstOnly: !!p.firstOnly, cost: !!p.cost };
}
function usePromo(code) {
  code = String(code || "").trim().toUpperCase();
  const all = loadPromos();
  if (all[code]) { all[code].uses = (all[code].uses || 0) + 1; writeJson(PROMOS_FILE, all); }
}

// Единая калькуляция цены: список → промокод/реферал ЛИБО списание баланса.
// Два правила, введены 12.09.2026:
//  1. ПОЛ ПО СЕБЕСТОИМОСТИ. Ни скидка, ни баллы не опускают цену ниже закупки
//     с учётом конвертации и эквайринга. Раньше единственным ограничителем были
//     100 ₽ минимального платежа, и связка «промокод + баллы» уводила в минус.
//  2. ЛИБО ПРОМОКОД, ЛИБО БАЛЛЫ. Не складываются. Промокод (и реферальная
//     скидка) в приоритете: его вводят осознанно, а баллы — это переключатель.
//     Неизрасходованные баллы остаются на балансе до следующей покупки.
function priceWithDiscounts({ listPrice, costRub, email, promoCode, refCode, useBalance }) {
  // Личный код клиента работает и в поле промокода: человеку всё равно, как
  // называется код друга, а объяснять разницу в письме незачем.
  if (promoCode && !refCode) {
    const byRef = customerByRef(String(promoCode).trim().toUpperCase());
    if (byRef) { refCode = String(promoCode).trim().toUpperCase(); promoCode = null; }
  }
  const out = { listPrice, discountRub: 0, discountKind: null, promoCode: null, promoReason: null, refBy: null,
                balanceRub: 0, balanceCanUse: 0, balanceUsed: 0, balanceBlockedBy: null, total: listPrice };
  // Ниже этой суммы цена не опускается ни при каких скидках. Себестоимость ещё и
  // с запасом: продавать ровно по закупке смысла нет, работа и поддержка стоят
  // денег. Запас меняется в .env (ESIM_DISCOUNT_FLOOR=1 убирает его совсем).
  const floorRub = Math.min(listPrice, Math.max(MIN_PAY_RUB, Math.ceil((Number(costRub) || 0) * DISCOUNT_FLOOR_K)));
  const promo = checkPromo(promoCode, listPrice, email);
  out.promoReason = _promoReason;
  if (promo && promo.cost && costRub != null) {
    // Промокод «по себестоимости»: цена не скидывается на сумму, а становится равной закупке
    out.discountRub = Math.max(0, listPrice - floorRub);
    out.discountKind = "cost"; out.promoCode = promo.code;
  } else if (promo && promo.rub > 0) {
    out.discountRub = promo.rub; out.discountKind = "promo"; out.promoCode = promo.code;
  } else if (refCode) {
    const inviter = customerByRef(refCode);
    // Реферальная скидка — только новому клиенту и не по своей же ссылке
    if (inviter && normEmail(inviter.email) !== normEmail(email) && !hasOrders(email)) {
      out.discountRub = REF_BONUS_RUB; out.discountKind = "ref"; out.refBy = inviter.email;
    } else if (inviter && normEmail(inviter.email) === normEmail(email)) {
      out.promoReason = "ref_own";
    } else if (inviter) {
      out.promoReason = "ref_not_new";
    }
  }
  let afterDiscount = Math.max(floorRub, listPrice - out.discountRub);
  out.discountRub = listPrice - afterDiscount;          // если упёрлись в пол — показываем честную скидку
  const cust = getCustomer(email, false);
  out.balanceRub = (cust && cust.balanceRub) || 0;
  // Баллы идут в дело, только если скидки не было: не больше половины пакета,
  // не больше самого баланса и так, чтобы цена не пробила пол по себестоимости.
  if (out.discountKind) out.balanceBlockedBy = out.discountKind;
  out.balanceCanUse = out.balanceBlockedBy ? 0 : Math.max(0, Math.min(
    out.balanceRub,
    Math.floor(listPrice * MAX_BONUS_SHARE),
    afterDiscount - floorRub
  ));
  if (useBalance && out.balanceCanUse > 0) {
    out.balanceUsed = out.balanceCanUse;
    afterDiscount -= out.balanceUsed;
  }
  out.total = afterDiscount;
  return out;
}

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
// Покупка засчитывается один раз на заказ, где бы её ни поймали: на странице
// «оплачено» или позже на странице с QR. Клиент после СБП часто не возвращается
// на сайт, поэтому одной точки мало — заказ 739 ₽ от 16.09 так и потерялся.
function orderByProviderId(mmOrderId) {
  return readJson(ORDERS_FILE, []).find(
    (x) => x.status === "done" && (x.mmOrderId === mmOrderId || x.parentOrderId === mmOrderId)) || null;
}
function convPayload(order) {
  if (!order || !order.priceRub || order.convSent) return null;
  return { id: order.id, t: signOrder(order.id), price: Number(order.priceRub),
           title: order.label || order.title || "eSIM", aw: process.env.ESIM_AW_PURCHASE || "" };
}
function emailOfProviderOrder(mmOrderId) {
  const o = readJson(ORDERS_FILE, []).find((x) => x.status === "done" && (x.mmOrderId === mmOrderId || x.parentOrderId === mmOrderId));
  return o && o.email ? o.email : null;
}
// Купленное в боте живёт на телефоне, а не на почте: клиентский ЛК как раз
// опознаёт человека по номеру, поэтому такие eSIM находятся по нему.
function samePhone(a, b) {
  const d = (x) => String(x || "").replace(/\D/g, "").slice(-10);
  return d(a).length === 10 && d(a) === d(b);
}
function esimsOfPhone(phone) {
  if (!phone) return [];
  return readJson(ORDERS_FILE, [])
    .filter((o) => o.status === "done" && o.mmOrderId && !o.email && samePhone(o.phone, phone))
    .map((o) => ({
      label: o.label, ts: o.ts, priceRub: o.priceRub, topup: !!o.parentOrderId,
      url: BASE_URL + "/esim/my?o=" + encodeURIComponent(o.parentOrderId || o.mmOrderId) +
           "&t=" + signOrder(o.parentOrderId || o.mmOrderId),
    }));
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
      // ?land=1 — запрос со страницы страны: там показываем и короткие сроки
      const land = String(req.query.land || "") === "1";
      let products = cat.products
        .filter((p) => adm || (!isTestProduct(p) && !(tsimAdmOnly() && isTsimId(p.id)) && !(eaAdmOnly() && isEaId(p.id))))
        .filter((p) => land || adm || !p.landOnly)
        .map((p) => {
        const o = {
          id: p.id, title: p.title || "", operator: p.operator || "", countries: p.countries || [],
          dataGb: p.dataGb, unlimited: !!p.unlimited, daily: !!p.daily, days: p.days,
          fiveG: !!p.fiveG, hotspot: p.hotspot !== false, priceRub: retailFor(p, rate),
          note: packNote(p), ruPick: isRuServicesPick(p),
        };
        if (adm) { o.src = p.src || "mobimatter"; o.costUsd = p.costUsd; o.costRub = costFor(p, rate); o.marginRub = o.priceRub - o.costRub; }
        return o;
      });
      products = hideSupplierDups(products);
      res.json({ success: true, demo: cat.source === "demo", live: provider.ready(), pay: tbank.ready(), updatedAt: cat.ts, usdRate: Math.round(rate * 100) / 100, markup: adm ? markupLabel() : undefined, perGb: SHOW_PER_GB, products });
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
      ads: adsource.readAds(req, b),
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
          "\nИсточник: " + adsource.describeAds(order.ads) +
          "\nID продукта MobiMatter: " + (order.productId || "—") +
          "\n\nКупить пакет: partner.mobimatter.com → Buy eSIMs (найти по ID) → QR-код отправить клиенту." +
          "\nПосле покупки возьмите номер заказа (AKGR-…) и откройте voyotravel.ru/esim/mylink?adm=КОД&o=НОМЕР — " +
          "получится персональная ссылка «Моя eSIM» для клиента (остаток трафика, QR, продление). Отправьте её вместе с QR.",
      }).then((r) => { if (r && !r.ok) console.error("esim mail:", r.error); }).catch((e) => console.error("esim mail:", e.message));
    }
    res.json({ success: true, pending: true });
  });

  // Пакет кончился. Поставщики считают трафик по суткам и на новые сутки
  // обнуляют счётчик — у суточного тарифа после окончания срока остаток снова
  // выглядит «полным» (клиент 17.09.2026: «вчера симка закончилась, а сегодня
  // показывает полный пакет»). Поэтому окончание определяем по сроку сами и
  // отдаём отдельным полем, а не доверяем цифре остатка.
  function markExpiry(usage) {
    if (!usage || !Array.isArray(usage.packages)) return usage;
    const now = Date.now();
    usage.packages.forEach((p) => {
      // только для начатых пакетов: у неактивированной eSIM в этом поле у части
      // поставщиков лежит срок установки, а не конец интернета
      const started = Boolean(p.activatedAt) || Number(p.usedMb) > 0;
      p.expired = Boolean(started && p.expiresAt && new Date(p.expiresAt).getTime() <= now);
    });
    const dated = usage.packages.filter((p) => p.expiresAt);
    usage.expired = dated.length > 0 && dated.length === usage.packages.length && dated.every((p) => p.expired);
    usage.expiredAt = usage.expired
      ? usage.packages.map((p) => p.expiresAt).sort().slice(-1)[0] : null;
    return usage;
  }

  // ═══ «Моя eSIM» — страница клиента: остаток, срок, QR, продление ═══
  app.get("/esim/my", (req, res) => {
    res.set("Cache-Control", "no-store, no-cache, must-revalidate");
    res.sendFile(path.join(__dirname, "public", "esim-my.html"));
  });

  // Данные eSIM клиента: заказ (QR/LPA) + живой остаток + совместимые топапы в ₽
  app.get("/esim/api/my", async (req, res) => {
    const o = String(req.query.o || "").slice(0, 40);
    if (!o || !checkSig(o, req.query.t)) return res.status(403).json({ success: false, message: "Ссылка недействительна." });
    // eSIM от TSim и eSIM Access: те же поля страницы, продлений пока нет
    if (isTsimId(o) || isEaId(o)) {
      const who = isEaId(o) ? esimaccess : tsim;
      try {
        const rate = await usdRate();
        const [view, usage, topups] = await Promise.all([
          who.getOrderView(o), who.getUsage(o).catch(() => null),
          isEaId(o) ? esimaccess.listTopups(o, rate).catch(() => []) : [],
        ]);
        const owner = emailOfProviderOrder(o);
        if (owner) setSession(res, owner);
        return res.json({
          success: true, pay: tbank.ready(), you: owner || readSession(req),
          conv: convPayload(orderByProviderId(o)),
          order: { id: o, state: "Completed", title: view.title, operator: view.operator, qrDataUrl: view.qrDataUrl,
            lpa: view.lpa, activationCode: view.activationCode, smdp: view.smdp, apn: view.apn, iccid: view.iccid },
          usage: markExpiry(usage), topups: (usage && usage.expired) ? [] : topups,
        });
      } catch (e) {
        const nf = Number(e.tsimCode) === 1006 || Number(e.eaCode) === 310272;
        return res.status(nf ? 404 : 500).json({ success: false, message: nf ? "Заказ не найден." : e.message });
      }
    }
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
      // Список продлений у поставщика бывает диким: у одного пакета 258 вариантов
      // с дублями («+1 ГБ на 14 дней» 14 раз) и немонотонными ценами. Причёсываем:
      //  1) одинаковые «объём+срок» схлопываем в самый дешёвый;
      //  2) выкидываем заведомо невыгодные — те, где за те же деньги есть больше ГБ;
      //  3) сортируем от меньшего объёма к большему и показываем не больше 8.
      const byKey = new Map();
      (cat.addons || []).filter((a) => a.familyId === familyId).forEach((a) => {
        const price = toRetailRub(a.costUsd, rate);
        const key = (a.unlimited ? "inf" : a.dataGb) + "/" + a.days;
        const prev = byKey.get(key);
        if (!prev || price < prev.priceRub) {
          byKey.set(key, { id: a.id, title: a.title, dataGb: a.dataGb, unlimited: !!a.unlimited, days: a.days, priceRub: price });
        }
      });
      const vol = (t) => (t.unlimited ? 1e6 : Number(t.dataGb) || 0);
      const uniq = Array.from(byKey.values());
      const topups = uniq
        .filter((t) => !uniq.some((o) => o !== t && o.priceRub <= t.priceRub && vol(o) >= vol(t) && (o.days || 0) >= (t.days || 0)
                                          && (o.priceRub < t.priceRub || vol(o) > vol(t) || (o.days || 0) > (t.days || 0))))
        .sort((x, y) => vol(x) - vol(y) || x.priceRub - y.priceRub)
        .slice(0, 8);
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
        usage: markExpiry(usage), topups: (usage && usage.expired) ? [] : topups,
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

  // Служебные пакеты MobiMatter ($0.01, «Test 1 GB»/«Test 2 GB») нужны только нам
  // для сквозной проверки оплаты — интернета они не дают. Клиенту их не показываем
  // и не продаём; нам самим они видны по adm-коду.
  function isTestProduct(p) {
    return Number(p.costUsd) <= 0.05 || /(^|\s)test\b/i.test(String(p.title || ""));
  }

  // Один и тот же пакет (страны, объём, срок) у разных поставщиков показываем
  // один раз — по меньшей цене, кто бы её ни давал. Если цена совпала, оставляем
  // MobiMatter: там самый большой депозит (решение Андрея 16.09.2026), затем
  // TSim, затем eSIM Access. Дубли внутри одного поставщика не трогаем.
  function supplierRank(p) { return isEaId(p.id) ? 2 : (isTsimId(p.id) ? 1 : 0); }
  function hideSupplierDups(list) {
    const key = (p) => p.countries.slice().sort().join(",") + "|" + (p.unlimited ? "u" : p.dataGb) + "|" + (p.daily ? "d" : "") + "|" + p.days;
    const best = new Map(); // ключ → { price: минимальная цена, rank: лучший поставщик по этой цене }
    list.forEach((p) => {
      const k = key(p), r = supplierRank(p), b = best.get(k);
      if (!b || p.priceRub < b.price || (p.priceRub === b.price && r < b.rank)) best.set(k, { price: p.priceRub, rank: r });
    });
    return list.filter((p) => {
      const b = best.get(key(p));
      return p.priceRub === b.price && supplierRank(p) === b.rank;
    });
  }

  function findProduct(cat, id) {
    const inMain = (cat.products || []).find((x) => x.id === id);
    if (inMain) return { item: inMain, addon: false };
    const inAdd = (cat.addons || []).find((x) => x.id === id);
    return inAdd ? { item: inAdd, addon: true } : null;
  }
  function labelFor(p) {
    const gb = String(p.dataGb).replace(".", ",");
    const vol = p.unlimited ? "безлимит" : (gb + (p.daily ? " ГБ в день" : " ГБ"));
    return "eSIM " + (p.title || "") + " · " + vol + (p.days ? (" · " + p.days + " дн.") : "");
  }
  function findLocal(id) {
    const orders = readJson(ORDERS_FILE, []);
    const i = orders.findIndex((o) => o.id === id);
    return i < 0 ? null : { orders, i, order: orders[i] };
  }
  function saveLocal(orders) { writeJson(ORDERS_FILE, orders.slice(0, 5000)); }

  // Такой же пакет у MobiMatter (страны, объём, срок) с закупкой не дороже оплаченного
  async function mmTwin(tsimProductId, paidRub) {
    const [cat, rate] = await Promise.all([getMmCatalog(false), usdRate()]);
    const t = ((loadTsimCatalog() || {}).products || []).find((x) => x.id === tsimProductId);
    if (!t || t.daily) return null;
    const cs = t.countries.slice().sort().join(",");
    return (cat.products || [])
      .filter((p) => !p.unlimited && !isTestProduct(p) && p.dataGb === t.dataGb && (p.days || 0) >= (t.days || 0) &&
        (p.countries || []).slice().sort().join(",") === cs && toCostRub(p.costUsd, rate) <= Number(paidRub || 0))
      .sort((a, b) => a.costUsd - b.costUsd)[0] || null;
  }

  // Кредит TSim на исходе: одно письмо на каждое пересечение резерва
  function checkTsimCredit() {
    const left = tsimLeftUsd(), w = readJson(TSIM_WATCH_FILE, {});
    if (left >= TSIM_RESERVE_USD) { if (w.lowSent) { w.lowSent = 0; writeJson(TSIM_WATCH_FILE, w); } return; }
    if (w.lowSent || !(opts && opts.sendMail)) return;
    w.lowSent = Date.now(); writeJson(TSIM_WATCH_FILE, w);
    opts.sendMail({
      to: "director@visa-sc.ru",
      subject: "VOYO eSIM: кредит TSim заканчивается, их пакеты скрыты с витрины",
      text: "По нашему учёту у TSim осталось $" + left + " из внесённых $" + TSIM_CREDIT_USD +
        ". Пакеты TSim спрятаны с витрины, продажи идут через MobiMatter.\n\n" +
        "Пополнили депозит — впишите новую общую сумму в .env: ESIM_TSIM_CREDIT_USD=<всего внесено> и перезапустите voyo.",
    }).catch(() => {});
  }

  // Деньги у поставщиков на исходе. У TSim кредит считаем сами (выше), у
  // eSIM Access и MobiMatter баланс живой в их API. Письмо уходит один раз на
  // пересечение порога; если остаток упал ниже критического — раз в сутки,
  // пока не пополним. Порог обратно перешли — счётчик сбрасывается.
  const BALANCE_WATCH = [
    {
      key: "ea", name: "eSIM Access", low: EA_LOW_USD, crit: EA_RESERVE_USD,
      on: () => eaMode() !== "0",
      read: async () => Number((await esimaccess.getBalance()).balanceUsd),
      risk: "Ниже $" + EA_RESERVE_USD + " их пакеты прячутся с витрины — а это весь дешёвый вход " +
        "(Турция 59 ₽, Китай 79 ₽) и вся реклама, которая на эти цены ведёт.",
      how: "Пополнить: console.esimaccess.com → Balance → Recharge (от $50).",
    },
    {
      key: "mm", name: "MobiMatter", low: MM_LOW_USD, crit: MM_CRIT_USD,
      on: () => provider.ready(),
      read: async () => Number((await provider.getBalance()).balance),
      risk: "Когда депозит кончится, заказы у MobiMatter перестанут выдаваться, " +
        "а клиент уже оплатил — деньги придётся возвращать руками.",
      how: "Пополнить: partner.mobimatter.com → Billing.",
    },
  ];

  async function checkSupplierBalances() {
    const w = readJson(BAL_WATCH_FILE, {});
    let changed = false;
    for (const s of BALANCE_WATCH) {
      if (!s.on()) continue;
      let usd = null;
      try { usd = await s.read(); } catch (e) { continue; }   // API молчит — посмотрим на следующем круге
      if (!Number.isFinite(usd)) continue;
      const st = w[s.key] || (w[s.key] = {});
      st.usd = Math.round(usd * 100) / 100; st.ts = Date.now(); changed = true;
      if (usd >= s.low) { if (st.sentAt) { st.sentAt = 0; } continue; }
      const crit = usd < s.crit;
      if (st.sentAt && (!crit || Date.now() - st.sentAt < 24 * 3600 * 1000)) continue;
      if (!(opts && opts.sendMail)) continue;
      st.sentAt = Date.now();
      opts.sendMail({
        to: "director@visa-sc.ru",
        subject: "VOYO eSIM: у " + s.name + " осталось $" + st.usd + (crit ? " — пополнить срочно" : " — пора пополнить"),
        text: "Баланс " + s.name + ": $" + st.usd + " (порог предупреждения $" + s.low + ").\n\n" +
          s.risk + "\n\n" + s.how +
          (crit ? "\n\nОстаток ниже критического $" + s.crit + " — письмо будет приходить каждые сутки, пока не пополните." : ""),
      }).catch(() => {});
      console.log("esim: письмо о балансе " + s.name + " $" + st.usd);
    }
    if (changed) writeJson(BAL_WATCH_FILE, w);
    return w;
  }

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
      let res, src = isEaId(o.productId) ? "esimaccess" : (isTsimId(o.productId) ? "tsim" : "mobimatter"), fallbackFrom = null;
      if (o.parentOrderId) {
        src = isEaId(o.parentOrderId) ? "esimaccess" : (isTsimId(o.parentOrderId) ? "tsim" : "mobimatter");
        res = await providerFor(o.parentOrderId).createTopup(o.productId, o.parentOrderId);
      }
      else if (src === "tsim" || src === "esimaccess") {
        const who = src === "tsim" ? tsim : esimaccess;
        try { res = await who.createOrder(o.productId); }
        catch (e) {
          // TSim не принял заказ (заказа у них нет) — выдаём такой же пакет MobiMatter,
          // если его закупка укладывается в оплаченную сумму. Иначе ручной разбор.
          const alt = e.noOrder ? await mmTwin(o.productId, o.priceRub) : null;
          if (!alt) throw e;
          console.error("esim tsim → mobimatter:", e.message);
          res = await provider.createOrder(alt.id);
          fallbackFrom = o.productId; src = "mobimatter";
        }
      } else res = await provider.createOrder(o.productId);
      const g = findLocal(id);
      Object.assign(g.order, {
        status: "done", paidAt: Date.now(), src, fallbackFrom,
        mmOrderId: res.orderId, iccid: res.iccid || null, costUsd: res.costUsd || null,
        myUrl: (g.order.base || BASE_URL) + "/esim/my?o=" + encodeURIComponent(o.parentOrderId || res.orderId) +
               "&t=" + signOrder(o.parentOrderId || res.orderId),
      });
      saveLocal(g.orders);
      if (src === "tsim") checkTsimCredit();
      checkSupplierBalances().catch(() => {});
      // Деньги и бонусы проводим только после подтверждённой оплаты
      try {
        const who = g.order.custKey || g.order.email;
        if (g.order.balanceUsed > 0) addBalance(who, -g.order.balanceUsed, "Оплата: " + (g.order.label || ""));
        if (g.order.promoCode) {
          usePromo(g.order.promoCode);
          updateCustomer(who, (c) => {
            c.usedPromos = (c.usedPromos || []).concat([g.order.promoCode]).slice(-50);
          });
        }
        if (g.order.refBy) {
          updateCustomer(who, (c) => { if (!c.invitedBy) c.invitedBy = g.order.refBy; });
          addBalance(g.order.refBy, REF_BONUS_RUB, "Бонус за друга");
          // Пригласивший может жить в боте — тогда обрадуем его прямо в чате
          if (String(g.order.refBy).indexOf("tg:") === 0 && opts && opts.notifyTelegram) {
            opts.notifyTelegram({ chatId: String(g.order.refBy).slice(3), kind: "refBonus",
              bonusRub: REF_BONUS_RUB }).catch(() => {});
          }
          if (validEmail(g.order.refBy) && opts && opts.sendMail) {
            const accInv = BASE_URL + "/esim/account?e=" + encodeURIComponent(g.order.refBy) + "&t=" + signEmail(g.order.refBy);
            opts.sendMail({
              to: g.order.refBy,
              subject: "VOYO mobile: вам начислено " + REF_BONUS_RUB + " ₽ за друга",
              html: '<div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;max-width:520px;margin:0 auto;color:#16202e">' +
                '<p style="font-size:19px;font-weight:700;margin:0 0 6px">+' + REF_BONUS_RUB + ' ₽ на ваш баланс</p>' +
                '<p style="color:#8b93a5;font-size:14px;line-height:1.6;margin:0 0 18px">Друг купил eSIM по вашей ссылке. Бонус спишется автоматически со следующей покупки.</p>' +
                '<p style="margin:0"><a href="' + accInv + '" style="display:inline-block;background:#3589bd;color:#fff;text-decoration:none;' +
                'font-weight:700;font-size:15px;padding:13px 22px;border-radius:12px">Открыть кабинет</a></p></div>',
              text: "+" + REF_BONUS_RUB + " ₽ на ваш баланс — друг купил eSIM по вашей ссылке.\nКабинет: " + accInv,
            }).catch(() => {});
          }
        }
        getCustomer(who, true); // заводим карточку с реф-кодом покупателю
      } catch (e) { console.error("esim bonuses:", e.message); }
      if (opts && opts.sendSms && g.order.phone) {
        opts.sendSms(g.order.phone, "VOYO mobile: ваша eSIM готова. QR и остаток трафика — " + g.order.myUrl)
          .catch((e) => console.error("esim sms:", e.message));
      }
      // Письмо клиенту: доступ в кабинет + QR-строка на случай, если картинка не откроется
      if (opts && opts.sendMail && g.order.email) {
        const tipsCN = isChinaLabel(g.order.label);
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
            (tipsCN ? chinaTipsHtml() : "") +
            '<p style="font-size:13px;line-height:1.6;color:#8b93a5;margin:0 0 6px">Ваш личный кабинет со всеми eSIM: <a href="' + acc + '" style="color:#3589bd">открыть</a><br/>' +
            'Ссылка постоянная — сохраните это письмо.</p>' +
            '<p style="font-size:12px;color:#a6adbd;margin:18px 0 0">VOYO mobile · интернет в поездке</p></div>',
          text: "Ваша eSIM готова: " + (g.order.label || "") + "\n\nQR-код и остаток трафика: " + g.order.myUrl +
                (tipsCN ? "\n\n" + CHINA_TIPS_TEXT : "") +
                "\nЛичный кабинет со всеми eSIM: " + acc,
        }).catch((e) => console.error("esim client mail:", e.message));
      }
      if (opts && opts.sendMail) {
        opts.sendMail({
          to: "director@visa-sc.ru",
          subject: "VOYO eSIM: ✅ ОПЛАЧЕНО " + (g.order.label || "") + (g.order.tgChatId ? " (телеграм-бот)" : ""),
          text: "Клиент оплатил и получил eSIM автоматически.\n\nОткуда: " +
            (g.order.tgChatId ? "телеграм-бот, чат " + g.order.tgChatId : "сайт") +
            (g.order.tgChatId ? "" : "\nИсточник: " + adsource.describeAds(g.order.ads)) +
            "\nПакет: " + (g.order.label || "—") +
            (g.order.parentOrderId ? "\nЭто ПРОДЛЕНИЕ заказа " + g.order.parentOrderId : "") +
            "\nСумма: " + (g.order.priceRub || "—") + " ₽" +
            (g.order.discountRub ? " (скидка " + g.order.discountRub + " ₽" +
              (g.order.promoCode ? ", промокод " + g.order.promoCode : "") + ")" : "") +
            (g.order.balanceUsed ? "\nСписано бонусами: " + g.order.balanceUsed + " ₽" : "") +
            "\nТелефон: " + (g.order.phone || "—") +
            "\nEmail: " + (g.order.email || "—") +
            "\nЗаказ " + (src === "tsim" ? "TSim" : src === "esimaccess" ? "eSIM Access" : "MobiMatter") + ": " + res.orderId +
            (fallbackFrom ? "\nTSim не принял заказ, выдан такой же пакет MobiMatter." : "") +
            (src === "tsim" ? "\nКредит TSim по учёту: $" + tsimLeftUsd() : "") +
            "\nСсылка клиента: " + g.order.myUrl,
        }).catch(() => {});
      }
      // Продали через бота — пусть он сам отдаст клиенту QR в чат
      if (opts && opts.onIssued) { try { opts.onIssued(g.order); } catch (e) { console.error("esim onIssued:", e.message); } }
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
            "\nОшибка: " + e.message +
            (isTsimId(o.productId)
              ? "\n\nПакет TSim. Если в ошибке есть номер TS-…, заказ у TSim создан, но QR не пришёл: откройте ссылку " +
                BASE_URL + "/esim/mylink?adm=КОД&o=TS-… чуть позже. Иначе купите похожий пакет в portal.mobimatter.com и отправьте клиенту QR."
              : "\n\nКупите пакет в portal.mobimatter.com и отправьте клиенту QR."),
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
    const phone = String(b.phone || "").trim().slice(0, 30) || null;
    const tgChatId = b.tgChatId ? String(b.tgChatId).slice(0, 20) : null;   // покупка из телеграм-бота
    // Банк требует контакт для чека: обычно это почта, но из бота человек
    // отдаёт номер одним касанием — тогда чек уходит смской, а QR в чат.
    if (!validEmail(email) && !(tgChatId && phone)) {
      return res.status(400).json({ success: false, message: "Нужен корректный email." });
    }
    const parentOrderId = b.parent ? String(b.parent).slice(0, 40) : null;
    if (parentOrderId && !checkSig(parentOrderId, b.t)) return res.status(403).json({ success: false });
    // Купил из клиентского ЛК — запоминаем связку телефон → почта, чтобы в
    // разделе «Мои eSIM» больше не спрашивать почту
    try { const lk = await lkEmails(req); if (lk) bindLk(lk.phone, email); } catch (_) {}
    try {
      const [cat, rate] = await Promise.all([getCatalog(false), usdRate()]);
      let found = findProduct(cat, String(b.productId || ""));
      // Пакеты докупки живут не в каталоге, а в списке пополнений конкретной eSIM
      if (!found && parentOrderId && isEaId(parentOrderId) && isEaId(b.productId)) {
        const tops = await esimaccess.listTopups(parentOrderId, rate).catch(() => []);
        const t = tops.find((x) => x.id === String(b.productId));
        if (t) found = { item: Object.assign({ countries: [], id: t.id }, t), addon: true };
      }
      if (!found) return res.status(400).json({ success: false, message: "Пакет не найден." });
      // Предохранитель на время обкатки: пока терминал тестовый, деньги с карт не
      // списываются, а закупка у поставщика РЕАЛЬНАЯ — за пару кликов можно сжечь
      // депозит. С ESIM_TEST_ONLY=1 покупаются только служебные пакеты ($0.01).
      if (String(process.env.ESIM_TEST_ONLY || "") === "1" && Number(found.item.costUsd) > 0.01) {
        return res.status(403).json({ success: false, message: "Идёт тестирование: доступны только служебные пакеты «Test 1 GB» и «Test 2 GB» (Германия и Италия)." });
      }
      // Служебный пакет можно купить только с adm-кодом — клиент его и не увидит
      if ((isTestProduct(found.item) || (tsimAdmOnly() && isTsimId(found.item.id)) || (eaAdmOnly() && isEaId(found.item.id))) && String(b.adm || "") !== ADMIN_CODE) {
        return res.status(400).json({ success: false, message: "Пакет не найден." });
      }
      if (found.addon && !parentOrderId) return res.status(400).json({ success: false, message: "Топап без исходной eSIM." });
      const listPrice = found.item.priceRub || retailFor(found.item, rate);
      const who = custKey(email, tgChatId);
      const calc = priceWithDiscounts({ listPrice, costRub: costFor(found.item, rate),
        email: who, promoCode: b.promo, refCode: b.ref, useBalance: !!b.useBalance });
      const priceRub = calc.total;
      const id = crypto.randomBytes(6).toString("hex");
      const label = labelFor(found.item);
      const orders = readJson(ORDERS_FILE, []);
      orders.unshift({
        id, ts: Date.now(), status: "pending", productId: found.item.id, parentOrderId,
        label, priceRub, listPriceRub: listPrice, phone, email, tgChatId, custKey: who,
        discountRub: calc.discountRub, discountKind: calc.discountKind,
        promoCode: calc.promoCode, refBy: calc.refBy, balanceUsed: calc.balanceUsed,
        ads: tgChatId ? null : adsource.readAds(req, b),
        // Домен покупки: ссылка с QR должна вести туда же, иначе счётчик Метрики
        // окажется другим и покупка не свяжется с рекламным визитом (17.09.2026)
        base: baseFor(req),
      });
      saveLocal(orders);
      const pay = await tbank.init({
        orderId: id, amountRub: priceRub,
        description: label.slice(0, 140), itemName: label,
        phone, email: validEmail(email) ? email : null,
        notificationUrl: BASE_URL + "/esim/api/pay/notify",
        successUrl: baseFor(req) + "/esim/pay/ok?o=" + id + "&t=" + signOrder(id),
        failUrl: baseFor(req) + "/esim/pay/fail?o=" + id,
      });
      if (!pay.ok) { console.error("esim pay init:", pay.message); return res.status(502).json({ success: false, message: "Банк не принял платёж. Попробуйте ещё раз." }); }
      const g = findLocal(id);
      if (g) { g.order.paymentId = pay.paymentId; saveLocal(g.orders); }
      return res.json({ success: true, url: pay.url });
    } catch (e) { return res.status(500).json({ success: false, message: e.message }); }
  });

  // Предрасчёт цены для витрины: проверка промокода, реф-скидки и баланса
  app.post("/esim/api/price", async (req, res) => {
    const b = req.body || {};
    try {
      const [cat, rate] = await Promise.all([getCatalog(false), usdRate()]);
      const found = findProduct(cat, String(b.productId || ""));
      if (!found) return res.status(400).json({ success: false, message: "Пакет не найден." });
      const email = normEmail(b.email) || readSession(req) || "";
      const who = custKey(email, b.tgChatId);
      const listPrice = retailFor(found.item, rate);
      const calc = priceWithDiscounts({ listPrice, costRub: costFor(found.item, rate),
        email: who, promoCode: b.promo, refCode: b.ref, useBalance: !!b.useBalance });
      const promoTried = String(b.promo || "").trim();
      res.json({
        success: true, listPrice, total: calc.total,
        discountRub: calc.discountRub, discountKind: calc.discountKind,
        balanceRub: calc.balanceRub, balanceCanUse: calc.balanceCanUse, balanceUsed: calc.balanceUsed,
        balanceBlockedBy: calc.balanceBlockedBy,
        // Промокод засчитан, если сервер его принял — хоть скидкой, хоть себестоимостью
        promoOk: promoTried ? !!(calc.promoCode || calc.discountKind === "ref") : null,
        promoReason: calc.promoReason,
      });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
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
    // Сумма и метка конверсии нужны странице «оплачено», чтобы передать покупку
    // в Google Ads. ESIM_AW_PURCHASE — «AW-…/label» из действия-конверсии в Ads.
    return res.json({ success: true, status: f.order.status, myUrl: f.order.myUrl || null,
      priceRub: f.order.priceRub || null, aw: process.env.ESIM_AW_PURCHASE || "",
      conv: convPayload(f.order) });
  });

  // Страница сообщает, что цель ушла в Метрику: ставим отметку, иначе при
  // повторном заходе покупка задвоится.
  app.post("/esim/api/conv-ack", (req, res) => {
    const id = String((req.query.o || (req.body && req.body.o) || "")).slice(0, 40);
    const t = String(req.query.t || (req.body && req.body.t) || "");
    if (!id || !checkSig(id, t)) return res.status(403).json({ success: false });
    const f = findLocal(id);
    if (!f) return res.status(404).json({ success: false });
    if (!f.order.convSent) { f.order.convSent = Date.now(); saveLocal(f.orders); }
    return res.json({ success: true });
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
  // Клиент, вошедший в кабинет по телефону, не должен вводить почту второй раз.
  // Держим связку телефон → почты локально: один раз узнали (из покупки или из
  // карточки amoCRM) — дальше в amo не ходим.
  function bindLk(phone, email) {
    if (!phone || !email) return;
    const b = readJson(LKBIND_FILE, {});
    const list = b[phone] || [];
    if (list.indexOf(email) < 0) { list.unshift(email); b[phone] = list.slice(0, 5); writeJson(LKBIND_FILE, b); }
  }
  async function lkEmails(req) {
    if (!(opts && opts.lkClient)) return null;
    let lk = null;
    try { lk = await opts.lkClient(req); } catch (_) { return null; }
    if (!lk || !lk.phone) return null;
    const saved = (readJson(LKBIND_FILE, {})[lk.phone] || []);
    const seen = {}, all = [];
    saved.concat((lk.emails || []).map(normEmail)).forEach((e) => {
      if (e && !seen[e]) { seen[e] = 1; all.push(e); }
    });
    return { phone: lk.phone, emails: all };
  }

  app.get("/esim/api/account", async (req, res) => {
    // Вход по подписанной ссылке из письма ИЛИ по уже открытой сессии
    let email = normEmail(req.query.e);
    if (email && checkEmailSig(email, req.query.t)) setSession(res, email);
    else email = readSession(req);

    // Внутри клиентского ЛК почту не спрашиваем: берём её у кабинета (связка
    // телефон → почта). Складываем eSIM со всех почт этого человека.
    const lk = await lkEmails(req);
    let extra = [];
    if (lk) {
      if (email) bindLk(lk.phone, email);
      const withEsims = lk.emails.filter((e) => esimsOf(e).length);
      if (!email && withEsims.length) { email = withEsims[0]; setSession(res, email); }
      extra = withEsims.filter((e) => e !== email);
    }

    // Куплено в боте на этот номер — показываем и без почты
    const byPhone = lk ? esimsOfPhone(lk.phone) : [];
    if (!email) {
      if (lk) return res.json({ success: true, lk: true, email: null, esims: byPhone, balanceRub: 0 });
      return res.status(403).json({ success: false });
    }
    const c = getCustomer(email, true);
    const invited = Object.values(loadCustomers()).filter((x) => normEmail(x.invitedBy || "") === email);
    let list = esimsOf(email).concat(byPhone);
    extra.forEach((e) => { list = list.concat(esimsOf(e)); });
    list.sort((a, b) => (b.ts || 0) - (a.ts || 0));
    res.json({
      success: true, email, esims: list, lk: !!lk,
      balanceRub: c.balanceRub || 0,
      refCode: c.refCode,
      refLink: BASE_URL + "/esim?ref=" + c.refCode,
      refBonus: REF_BONUS_RUB,
      invitedCount: invited.length,
      ledger: (c.ledger || []).slice(0, 10),
    });
  });

  // Вход в кабинет по email: клиент сменил телефон или потерял письмо.
  // Пароля нет специально — лишний барьер на покупке; ключ это почта.
  const _loginAt = new Map(); // антиспам: не чаще раза в минуту на адрес
  app.post("/esim/api/account/login", (req, res) => {
    const email = normEmail((req.body || {}).email);
    if (!validEmail(email)) return res.status(400).json({ success: false, message: "Введите корректный email." });
    const now = Date.now(), prev = _loginAt.get(email) || 0;
    const mine = esimsOf(email);
    // Клиенту важнее понять, что он ошибся почтой, чем нам скрывать факт покупки:
    // отвечаем честно (found), но письмо шлём не чаще раза в минуту на адрес.
    if (now - prev < 60000) return res.json({ success: true, sent: mine.length > 0, found: mine.length > 0 });
    _loginAt.set(email, now);
    if (mine.length && opts && opts.sendMail) {
      const acc = baseFor(req) + "/esim/account?e=" + encodeURIComponent(email) + "&t=" + signEmail(email) +
        ((req.body || {}).lk ? "&lk=1" : "");
      opts.sendMail({
        to: email,
        subject: "VOYO mobile: вход в кабинет",
        html: '<div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;max-width:520px;margin:0 auto;color:#16202e">' +
          '<p style="font-size:19px;font-weight:700;letter-spacing:-.02em;margin:0 0 6px">Вход в кабинет VOYO mobile</p>' +
          '<p style="color:#8b93a5;font-size:14px;line-height:1.6;margin:0 0 18px">У вас ' + mine.length +
          ' eSIM. Нажмите кнопку — откроется кабинет с QR-кодами и остатком трафика.</p>' +
          '<p style="margin:0 0 18px"><a href="' + acc + '" style="display:inline-block;background:#3589bd;color:#fff;' +
          'text-decoration:none;font-weight:700;font-size:15px;padding:13px 22px;border-radius:12px">Войти в кабинет</a></p>' +
          '<p style="font-size:12.5px;line-height:1.6;color:#8b93a5;margin:0">Ссылка постоянная — сохраните письмо. ' +
          'Если вход запрашивали не вы, просто удалите письмо.</p></div>',
        text: "Вход в кабинет VOYO mobile\n\nУ вас " + mine.length + " eSIM.\nОткройте ссылку: " + acc +
              "\n\nСсылка постоянная — сохраните письмо.",
      }).catch((e) => console.error("esim login mail:", e.message));
    }
    res.json({ success: true, sent: mine.length > 0, found: mine.length > 0 });
  });

  // Привязка почты к покупкам из телеграм-бота: там контакт — телефон, и на
  // сайте такие eSIM иначе не найти. Зовёт только наш же бот с localhost,
  // подтверждая себя секретом от токена.
  app.post("/esim/api/tg/link-email", (req, res) => {
    const secret = crypto.createHash("sha256").update("tg:" + (process.env.ESIM_TG_TOKEN || "")).digest("hex").slice(0, 24);
    if (!process.env.ESIM_TG_TOKEN || String(req.headers["x-tg-secret"] || "") !== secret) {
      return res.status(403).json({ success: false });
    }
    const b = req.body || {};
    const email = normEmail(b.email);
    const chat = String(b.tgChatId || "");
    if (!validEmail(email) || !chat) return res.status(400).json({ success: false, message: "Нужны чат и корректный email." });
    const orders = readJson(ORDERS_FILE, []);
    let n = 0;
    orders.forEach((o) => {
      if (String(o.tgChatId || "") === chat && !o.email) { o.email = email; o.custKey = email; n++; }
    });
    if (n) writeJson(ORDERS_FILE, orders.slice(0, 5000));
    // Переносим на почту всё, что человек накопил, пока был «просто чатом»:
    // бонусы, историю промокодов и тех, кого он привёл.
    const from = tgKey(chat), all = loadCustomers();
    getCustomer(email, true);
    if (all[from]) {
      updateCustomer(email, (c) => {
        c.balanceRub = Math.max(0, Math.round((c.balanceRub || 0) + (all[from].balanceRub || 0)));
        c.usedPromos = Array.from(new Set((c.usedPromos || []).concat(all[from].usedPromos || []))).slice(-50);
        c.ledger = (all[from].ledger || []).concat(c.ledger || []).slice(0, 100);
        if (!c.invitedBy && all[from].invitedBy) c.invitedBy = all[from].invitedBy;
      });
      const after = loadCustomers();
      Object.keys(after).forEach((k) => { if (String(after[k].invitedBy || "") === from) after[k].invitedBy = email; });
      delete after[from];
      saveCustomers(after);
    }
    res.json({
      success: true, linked: n,
      accountUrl: BASE_URL + "/esim/account?e=" + encodeURIComponent(email) + "&t=" + signEmail(email),
    });
  });

  // Приветственные баллы новичку бота. Идемпотентно: карточка помечается, и
  // повторный /start второй сотни не даёт.
  app.post("/esim/api/tg/welcome", (req, res) => {
    const secret = crypto.createHash("sha256").update("tg:" + (process.env.ESIM_TG_TOKEN || "")).digest("hex").slice(0, 24);
    if (!process.env.ESIM_TG_TOKEN || String(req.headers["x-tg-secret"] || "") !== secret) {
      return res.status(403).json({ success: false });
    }
    const chat = String((req.body || {}).tgChatId || "").replace(/\D/g, "");
    const who = tgKey(chat);
    if (!validKey(who)) return res.status(400).json({ success: false });
    // Отметку о подарке держим отдельно от карточки клиента: карточка может
    // переехать на почту и исчезнуть, а второй раз дарить нельзя.
    const given = readJson(TGWELCOME_FILE, {});
    const had = getCustomer(who, false);
    if (given[chat] || (had && had.welcomeBonus)) {
      return res.json({ success: true, granted: false, balanceRub: (had && had.balanceRub) || 0, bonusRub: TG_WELCOME_RUB });
    }
    given[chat] = Date.now();
    writeJson(TGWELCOME_FILE, given);
    const c = updateCustomer(who, (x) => {
      x.welcomeBonus = Date.now();
      x.balanceRub = Math.max(0, Math.round((x.balanceRub || 0) + TG_WELCOME_RUB));
      x.ledger = [{ ts: Date.now(), rub: TG_WELCOME_RUB, note: "Приветственные баллы" }].concat(x.ledger || []).slice(0, 100);
    });
    res.json({ success: true, granted: true, balanceRub: c.balanceRub, bonusRub: TG_WELCOME_RUB });
  });

  // Бонусы и рефералка для телеграм-бота: своя карточка по чату, если почты нет
  app.post("/esim/api/tg/bonus", (req, res) => {
    const secret = crypto.createHash("sha256").update("tg:" + (process.env.ESIM_TG_TOKEN || "")).digest("hex").slice(0, 24);
    if (!process.env.ESIM_TG_TOKEN || String(req.headers["x-tg-secret"] || "") !== secret) {
      return res.status(403).json({ success: false });
    }
    const b = req.body || {};
    const who = custKey(b.email, b.tgChatId);
    if (!validKey(who)) return res.status(400).json({ success: false });
    const c = getCustomer(who, true);
    const invited = Object.values(loadCustomers()).filter((x) => String(x.invitedBy || "") === who);
    res.json({
      success: true, balanceRub: c.balanceRub || 0, refCode: c.refCode,
      refBonus: REF_BONUS_RUB, invitedCount: invited.length,
      maxShare: MAX_BONUS_SHARE, ledger: (c.ledger || []).slice(0, 5),
    });
  });

  // Кто я сейчас (для шапки страниц)
  app.get("/esim/api/session", (req, res) => {
    const email = readSession(req);
    res.json({ success: true, email, esims: email ? esimsOf(email) : [] });
  });

  app.get("/esim/logout", (req, res) => { clearSession(res); res.redirect("/esim"); });

  // ═══ Админка промокодов и рефералки: /esim_ref_admin ═══
  app.get("/esim_ref_admin", (req, res) => {
    res.set("Cache-Control", "no-store, no-cache, must-revalidate");
    res.sendFile(path.join(__dirname, "public", "esim-ref-admin.html"));
  });
  app.get("/esim/api/ref-admin", (req, res) => {
    if (String(req.query.adm || "") !== ADMIN_CODE) return res.status(403).json({ success: false });
    const promosRaw = loadPromos();
    const promos = Object.entries(promosRaw).map(([code, v]) => ({
      code, rub: v.rub, pct: v.pct || 0, firstOnly: !!v.firstOnly, oncePerUser: v.oncePerUser !== false,
      uses: v.uses || 0, maxUses: v.maxUses || null,
      active: v.active !== false, note: v.note || "", ts: v.ts || null,
    })).sort((a, b) => (b.ts || 0) - (a.ts || 0));
    const custAll = loadCustomers();
    const orders = readJson(ORDERS_FILE, []);
    const customers = Object.values(custAll).map((c) => ({
      email: c.email, refCode: c.refCode, balanceRub: c.balanceRub || 0,
      invitedBy: c.invitedBy || null, ts: c.ts || null,
      invitedCount: Object.values(custAll).filter((x) => normEmail(x.invitedBy || "") === normEmail(c.email)).length,
      orders: orders.filter((o) => o.email === c.email && o.status === "done").length,
    })).sort((a, b) => (b.balanceRub - a.balanceRub) || (b.ts || 0) - (a.ts || 0));
    res.json({
      success: true, promos, customers,
      stats: {
        promoUses: promos.reduce((s2, x) => s2 + x.uses, 0),
        customers: customers.length,
        invited: customers.filter((c) => c.invitedBy).length,
        balanceTotal: customers.reduce((s2, c) => s2 + c.balanceRub, 0),
        spent: orders.filter((o) => o.status === "done").reduce((s2, o) => s2 + (o.balanceUsed || 0), 0),
      },
    });
  });
  app.post("/esim/api/ref-admin/promo", (req, res) => {
    if (String(req.query.adm || "") !== ADMIN_CODE) return res.status(403).json({ success: false });
    const b = req.body || {};
    const code = String(b.code || "").trim().toUpperCase();
    if (!code) return res.status(400).json({ success: false });
    const all = loadPromos();
    if (b.off) { if (all[code]) all[code].active = false; }
    else {
      const pct = Math.max(0, Math.min(100, parseInt(b.pct, 10) || 0));
      all[code] = {
        rub: (b.cost || pct) ? 0 : Math.max(1, parseInt(b.rub, 10) || REF_BONUS_RUB),
        pct: b.cost ? 0 : (pct || 0), cost: !!b.cost,
        firstOnly: !!b.firstOnly, oncePerUser: b.oncePerUser !== false, active: true,
        uses: (all[code] && all[code].uses) || 0,
        maxUses: parseInt(b.max, 10) || null,
        // срок акции переживает правку кода из админки
        from: b.from || (all[code] && all[code].from) || undefined,
        to: b.to || (all[code] && all[code].to) || undefined,
        note: String(b.note || "").slice(0, 80), ts: (all[code] && all[code].ts) || Date.now(),
      };
    }
    writeJson(PROMOS_FILE, all);
    res.json({ success: true });
  });

  // Промокоды: создать/выключить/посмотреть. Только с админ-кодом.
  app.get("/esim/promo", (req, res) => {
    if (String(req.query.adm || "") !== ADMIN_CODE) return res.status(403).send("Нет доступа.");
    const all = loadPromos();
    const code = String(req.query.code || "").trim().toUpperCase();
    if (code) {
      if (String(req.query.off || "") === "1") {
        if (all[code]) { all[code].active = false; writeJson(PROMOS_FILE, all); }
      } else {
        // Скидка либо в рублях (rub), либо процентом (pct) — процент считается
        // от цены пакета в checkPromo.
        const pct = Math.min(90, Math.max(0, parseInt(req.query.pct, 10) || 0));
        all[code] = {
          rub: pct ? 0 : Math.max(0, parseInt(req.query.rub, 10) || REF_BONUS_RUB),
          pct: pct || undefined,
          active: true, uses: (all[code] && all[code].uses) || 0,
          maxUses: parseInt(req.query.max, 10) || null,
          to: String(req.query.to || "").slice(0, 10) || undefined,
          note: String(req.query.note || "").slice(0, 80), ts: Date.now(),
        };
        writeJson(PROMOS_FILE, all);
      }
    }
    res.set("Content-Type", "text/html; charset=utf-8");
    const rows = Object.entries(loadPromos()).map(([k, v]) =>
      "<tr><td><b>" + esc(k) + "</b></td><td>" + (v.pct ? "−" + v.pct + " %" : v.rub + " ₽") + "</td><td>" + (v.active === false ? "выключен" : "активен") +
      "</td><td>" + (v.uses || 0) + (v.maxUses ? " / " + v.maxUses : "") + "</td><td>" + esc(v.note || "") + "</td></tr>").join("");
    res.send('<meta name="viewport" content="width=device-width,initial-scale=1"/>' +
      '<body style="font-family:-apple-system,sans-serif;padding:24px;line-height:1.6;max-width:760px;margin:0 auto">' +
      "<h2>Промокоды VOYO mobile</h2>" +
      '<table cellpadding="8" style="border-collapse:collapse;width:100%;font-size:14px">' +
      "<tr style=\"text-align:left;color:#888\"><th>Код</th><th>Скидка</th><th>Статус</th><th>Использован</th><th>Заметка</th></tr>" +
      (rows || '<tr><td colspan="5" style="color:#888">Пока нет ни одного</td></tr>') + "</table>" +
      '<p style="color:#888;font-size:13px;margin-top:22px">Создать или изменить:<br/>' +
      "<code>/esim/promo?adm=КОД&amp;code=VOYO100&amp;rub=100</code> — скидка в рублях<br/>" +
      "<code>/esim/promo?adm=КОД&amp;code=BONUS10&amp;pct=10</code> — скидка процентом<br/>" +
      "необязательно: <code>&amp;max=500</code> (лимит использований), <code>&amp;to=2026-12-31</code>, <code>&amp;note=текст</code><br/>" +
      "Выключить: <code>/esim/promo?adm=КОД&amp;code=VOYO100&amp;off=1</code></p></body>");
  });

  // Служебное: состояние провайдера и кошелька (для админки/сторожа депозита)
  app.get("/esim/api/health", async (req, res) => {
    if (String(req.query.adm || "") !== ADMIN_CODE) return res.status(403).json({ success: false });
    const out = { success: true, provider: provider.name, ready: provider.ready(), markup: markupLabel(), minRub: MIN_RUB };
    if (provider.ready()) { try { out.balance = await provider.getBalance(); } catch (e) { out.balanceError = e.message; } }
    out.ea = { mode: eaMode(), on: esimaccess.ready(), plans: ((loadEaCatalog() || {}).products || []).length,
      shown: (await getEaProducts(false)).length, reserveUsd: EA_RESERVE_USD };
    if (esimaccess.ready() || process.env.ESIMACCESS_ACCESS_CODE) {
      try { out.ea.balance = await esimaccess.getBalance(); } catch (e) { out.ea.balanceError = e.message; }
    }
    out.tsim = { on: tsim.ready(), plans: ((loadTsimCatalog() || {}).products || []).length,
      shown: (await getTsimProducts(false)).length, minRub: TSIM_MIN_RUB, reserveUsd: TSIM_RESERVE_USD, ...tsim.getBalance() };
    const orders = readJson(ORDERS_FILE, []);
    out.interest = orders.length;
    res.json(out);
  });

  // ═══ Напоминания клиентам: срок и остаток трафика ═══
  // Раз в несколько часов спрашиваем у поставщика остаток по каждой выданной
  // eSIM. Письмо каждого типа уходит один раз — отметки в .esim/notify.json.
  function esimsToWatch() {
    const orders = readJson(ORDERS_FILE, []).filter((o) => o.status === "done" && o.mmOrderId);
    const byEsim = new Map();
    // Идём от старых к новым, чтобы в карточке остался самый свежий email и ссылка
    orders.slice().reverse().forEach((o) => {
      const id = o.parentOrderId || o.mmOrderId;
      byEsim.set(id, { esimId: id, email: o.email, label: o.label, myUrl: o.myUrl, productId: o.productId,
                       tgChatId: o.tgChatId || null });
    });
    // Достучаться нужно хоть куда-то: почтой или в телеграм-чат покупателя
    return Array.from(byEsim.values()).filter((x) => x.myUrl && (x.email || x.tgChatId));
  }

  async function hasTopups(productId) {
    try {
      const cat = await getCatalog(false);
      const main = (cat.products || []).find((x) => x.id === productId);
      if (!main) return false;
      return (cat.addons || []).some((a) => a.familyId === main.familyId);
    } catch (_) { return false; }
  }

  function notifyLetter({ kind, item, left, total, days, canTopup }) {
    const isData = kind === "lowData";
    const cta = isData ? (canTopup ? "Докупить гигабайты" : "Купить ещё eSIM")
                       : (canTopup ? "Продлить пакет" : "Купить новый пакет");
    const link = canTopup ? item.myUrl : (BASE_URL + "/esim");
    const title = isData
      ? "Интернет почти закончился"
      : (days <= 0 ? "Пакет заканчивается сегодня" : "Пакет заканчивается через " + days + " " + (days === 1 ? "день" : "дня"));
    const body = isData
      ? ("Осталось " + left + " из " + total + " — при активном интернете это меньше дня. " +
         (canTopup ? "Гигабайты добавятся на эту же eSIM, переустанавливать ничего не нужно."
                   : "На этом тарифе добавить трафик нельзя, но можно взять ещё один пакет."))
      : ((days <= 0 ? "Сегодня последний день действия пакета. " : "Через " + days + " " + (days === 1 ? "день" : "дня") + " пакет перестанет работать. ") +
         (canTopup ? "Продление продлит и срок, и трафик на этой же eSIM."
                   : "На этом тарифе продление недоступно — если поездка продолжается, возьмите новый пакет."));
    return {
      subject: "VOYO mobile: " + (isData ? "интернет почти закончился" : title.toLowerCase()),
      html: '<div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;max-width:520px;margin:0 auto;color:#16202e">' +
        '<p style="font-size:19px;font-weight:700;letter-spacing:-.02em;margin:0 0 6px">' + esc(title) + '</p>' +
        '<p style="color:#8b93a5;font-size:14px;line-height:1.6;margin:0 0 6px">' + esc(item.label || "") + '</p>' +
        '<p style="font-size:14.5px;line-height:1.6;margin:0 0 18px">' + esc(body) + '</p>' +
        '<p style="margin:0 0 18px"><a href="' + link + '" style="display:inline-block;background:#3589bd;color:#fff;' +
        'text-decoration:none;font-weight:700;font-size:15px;padding:13px 22px;border-radius:12px">' + cta + '</a></p>' +
        '<p style="font-size:12.5px;color:#8b93a5;margin:0">Остаток и QR всегда здесь: <a href="' + item.myUrl + '" style="color:#3589bd">моя eSIM</a></p>' +
        '<p style="font-size:12px;color:#a6adbd;margin:16px 0 0">VOYO mobile · интернет в поездке</p></div>',
      text: title + "\n\n" + (item.label || "") + "\n" + body + "\n\n" + cta + ": " + link,
    };
  }


  // ═══ Брошенная оплата ═══════════════════════════════════════════════════
  // Человек выбрал пакет, дошёл до банка и не заплатил: карту отбили, закрыл
  // окно СБП, отвлёкся. Такие заказы не видел никто — за неделю их набежало на
  // 7,6 тыс. ₽ (17.09.2026). Теперь через полчаса клиенту уходит письмо с
  // разовым промокодом и ссылкой на тот же пакет, а через два часа о заказе
  // узнаёт директор.
  const ABANDON_AFTER_MS = Number(process.env.ESIM_ABANDON_AFTER_MIN || 30) * 60000;
  const ABANDON_ADMIN_MS = Number(process.env.ESIM_ABANDON_ADMIN_MIN || 120) * 60000;
  const ABANDON_MAX_MS = 36 * 3600 * 1000;   // старее — догонять уже неловко
  const ABANDON_PROMO = String(process.env.ESIM_ABANDON_PROMO || "BONUS10").toUpperCase();
  const ABANDON_TO = process.env.ESIM_ABANDON_TO || "director@visa-sc.ru";
  const HELP_WA = "https://wa.me/79299435150";
  const HELP_TG = "https://t.me/vsc_operator";

  // Что сказал банк: NEW/FORM_SHOWED — до оплаты не дошёл, REJECTED/AUTH_FAIL —
  // карту не пропустили, DEADLINE_EXPIRED — форма протухла.
  const BANK_PAID = ["CONFIRMED", "AUTHORIZED", "PARTIAL_REFUNDED", "REFUNDED"];
  function bankWhy(st) {
    if (st === "REJECTED" || st === "AUTH_FAIL") return "declined";
    if (st === "DEADLINE_EXPIRED") return "expired";
    return "left";
  }

  function abandonLink(o) {
    return (o.base || BASE_URL) + "/esim?p=" + encodeURIComponent(o.productId) +
      "&promo=" + ABANDON_PROMO + "&utm_source=voyo_letter&utm_medium=email&utm_campaign=esim_abandon";
  }

  function abandonLetter(o, why) {
    const link = abandonLink(o);
    const title = why === "declined" ? "Банк не пропустил оплату" : "Вы не завершили оплату eSIM";
    const lead = why === "declined"
      ? "Карта не прошла — так бывает с лимитами и подтверждением по SMS. Заказ мы сохранили: попробуйте ещё раз этой же картой, другой картой или по СБП."
      : (why === "expired"
        ? "Страница оплаты закрылась раньше, чем прошёл платёж. Заказ мы сохранили — открыть его можно в один клик."
        : "Пакет выбран, но оплата так и не прошла. Заказ мы сохранили — вернуться к нему можно в один клик.");
    const price = o.priceRub ? String(o.priceRub) + " ₽" : "";
    const disc = o.priceRub ? String(Math.round(o.priceRub * 0.9)) + " ₽" : "";
    return {
      subject: "VOYO mobile: завершите оплату — дарим промокод на 10%",
      html: '<div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;max-width:520px;margin:0 auto;color:#16202e">' +
        '<p style="font-size:19px;font-weight:700;letter-spacing:-.02em;margin:0 0 6px">' + esc(title) + '</p>' +
        '<p style="color:#8b93a5;font-size:14px;line-height:1.6;margin:0 0 14px">' + esc(o.label || "eSIM") +
        (price ? ' · ' + price : '') + '</p>' +
        '<p style="font-size:14.5px;line-height:1.6;margin:0 0 16px">' + esc(lead) + '</p>' +
        '<div style="background:#f2f8fc;border:1px solid #d9e9f4;border-radius:14px;padding:16px 18px;margin:0 0 18px">' +
        '<p style="font-size:14.5px;line-height:1.6;margin:0 0 8px">И чтобы не откладывать — дарим промокод на <b>−10%</b> к этому заказу:</p>' +
        '<p style="font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:22px;font-weight:700;' +
        'letter-spacing:.06em;margin:0 0 8px;color:#16202e">' + esc(ABANDON_PROMO) + '</p>' +
        '<p style="font-size:13px;color:#6b748a;line-height:1.55;margin:0">Промокод разовый' +
        (disc ? ' — пакет выйдет в ' + disc : '') + '. По кнопке ниже он подставится сам.</p></div>' +
        '<p style="margin:0 0 18px"><a href="' + link + '" style="display:inline-block;background:#3589bd;color:#fff;' +
        'text-decoration:none;font-weight:700;font-size:15px;padding:13px 22px;border-radius:12px">Оплатить со скидкой 10%</a></p>' +
        '<p style="font-size:13.5px;line-height:1.6;color:#3a4356;margin:0 0 14px">Оплата картой российского банка или по СБП, ' +
        'QR-код придёт сразу после оплаты. Интернет включится за минуту.</p>' +
        '<p style="font-size:13.5px;line-height:1.6;color:#3a4356;margin:0 0 6px">Если возникли сложности — напишите нам, поможем: ' +
        '<a href="' + HELP_WA + '" style="color:#3589bd;font-weight:600">WhatsApp</a> · ' +
        '<a href="' + HELP_TG + '" style="color:#3589bd;font-weight:600">Telegram</a></p>' +
        '<p style="font-size:12px;color:#a6adbd;margin:18px 0 0">VOYO mobile · интернет в поездке</p></div>',
      text: title + "\n\n" + (o.label || "eSIM") + (price ? " · " + price : "") + "\n" + lead +
        "\n\nПромокод на −10%: " + ABANDON_PROMO + " (разовый" + (disc ? ", пакет выйдет в " + disc : "") + ")" +
        "\nОплатить: " + link +
        "\n\nЕсли возникли сложности, напишите нам: WhatsApp " + HELP_WA + " · Telegram " + HELP_TG,
    };
  }

  function abandonAdminLetter(o, why, st) {
    const whyRu = why === "declined" ? "банк отклонил платёж (" + (st || "—") + ")"
      : why === "expired" ? "форма оплаты протухла (DEADLINE_EXPIRED)"
      : "до оплаты не дошёл (" + (st || "—") + ")";
    return {
      to: ABANDON_TO,
      subject: "VOYO eSIM: ❌ НЕ ОПЛАЧЕНО " + (o.priceRub || "—") + " ₽ · " + (o.label || "—"),
      text: "Заказ висит без оплаты больше двух часов.\n\nЧто случилось: " + whyRu +
        "\nПакет: " + (o.label || "—") +
        "\nСумма: " + (o.priceRub || "—") + " ₽" +
        (o.discountRub ? " (скидка " + o.discountRub + " ₽" + (o.promoCode ? ", промокод " + o.promoCode : "") + ")" : "") +
        "\nТелефон: " + (o.phone || "—") +
        "\nEmail: " + (o.email || "—") +
        (o.tgChatId ? "\nТелеграм-бот, чат " + o.tgChatId : "\nИсточник: " + adsource.describeAds(o.ads)) +
        "\nЗаказ создан: " + adsource.mskTime(o.ts) + " МСК" +
        "\nВнутренний номер: " + o.id +
        "\n\nКлиенту " + (o.abandonMail > 0 ? "письмо с промокодом " + ABANDON_PROMO + " уже ушло."
          : "письмо не отправляли (нет почты или уже писали сегодня).") +
        (o.email ? "\nНаписать: " + o.email : "") +
        (o.phone ? "\nПозвонить: " + o.phone : ""),
    };
  }

  // Свои же ящики: тестовые заказы с них делали мы, догонять их письмами незачем
  function ourOwnEmail(e) { return /@(voyotravel\.ru|voyovoyo\.ru|voyomobile\.(ru|com)|visa-sc\.(ru|com))$/i.test(String(e || "")); }

  let _abandonRunning = false;
  // opt.all — разовый прогон по всем заказам без оплаты, а не только за последние
  // полтора суток (например, когда решили догнать накопившиеся).
  async function runAbandoned(opt) {
    if (_abandonRunning || !tbank.ready() || !(opts && opts.sendMail)) return;
    _abandonRunning = true;
    let mails = 0;
    try {
      const orders = readJson(ORDERS_FILE, []);
      const now = Date.now();
      // кому уже писали за сутки — второй раз не пишем, даже если заказов несколько
      const wroteTo = new Set();
      orders.forEach((o) => {
        if (o.abandonMail > 0 && now - o.abandonMail < 24 * 3600 * 1000) wroteTo.add(o.custKey || o.email);
      });
      const paidAfter = (o) => orders.some((x) => (x.custKey || x.email) === (o.custKey || o.email) &&
        (x.status === "done" || x.status === "fulfilling") && x.ts >= o.ts - 5 * 60000);

      let changed = false;
      for (const o of orders) {
        if (o.status !== "pending" || !o.paymentId) continue;
        const age = now - (o.ts || 0);
        if (age < ABANDON_AFTER_MS) continue;
        if (age > ABANDON_MAX_MS && !(opt && opt.all)) continue;
        if (o.abandonMail && o.abandonAdmin) continue;
        if (/\btest\b/i.test(o.label || "")) continue;
        // Заказы с наших же ящиков — это проверки, а не потерянные клиенты
        if (ourOwnEmail(o.email)) { o.abandonMail = -1; o.abandonAdmin = -1; changed = true; continue; }
        if (paidAfter(o)) { o.abandonMail = o.abandonMail || -1; o.abandonAdmin = o.abandonAdmin || -1; changed = true; continue; }

        let st = null;
        try { const r = await tbank.getState(o.paymentId); st = (r && r.Status) || null; } catch (_) { continue; }
        if (!st) continue;
        // заплатил, а выдача не сработала — это не брошенная оплата, а авария
        if (BANK_PAID.indexOf(st) >= 0) { o.abandonMail = -1; o.abandonAdmin = -1; changed = true; continue; }
        const why = bankWhy(st);

        if (!o.abandonMail) {
          const to = validEmail(o.email) && !ourOwnEmail(o.email) ? o.email : null;
          const key = o.custKey || o.email;
          if (to && !wroteTo.has(key)) {
            const r = await opts.sendMail(Object.assign({ to }, abandonLetter(o, why))).catch(() => ({ ok: false }));
            o.abandonMail = r && r.ok === false ? -1 : now;
            if (o.abandonMail > 0) { wroteTo.add(key); mails++; }
          } else { o.abandonMail = -1; }
          changed = true;
        }
        // Про старые заказы письмо директору уже не новость: при разовом догоне
        // накопившихся оно только засоряет почту, клиенту письмо всё равно уйдёт.
        if (!o.abandonAdmin && age > ABANDON_MAX_MS) { o.abandonAdmin = -1; changed = true; }
        if (!o.abandonAdmin && age >= ABANDON_ADMIN_MS) {
          await opts.sendMail(abandonAdminLetter(o, why, st)).catch(() => {});
          o.abandonAdmin = now; changed = true; mails++;
        }
        await new Promise((r) => setTimeout(r, 300));       // не долбим банк
      }
      if (changed) saveLocal(orders);
      if (mails) console.log("esim: писем по брошенной оплате", mails);
    } catch (e) { console.error("esim abandon:", e.message); }
    finally { _abandonRunning = false; }
  }

  let _notifyRunning = false;
  async function runNotifications() {
    if (_notifyRunning || !provider.ready()) return;
    _notifyRunning = true;
    const sent = readJson(NOTIFY_FILE, {});
    let mails = 0;
    try {
      for (const item of esimsToWatch()) {
        const mark = sent[item.esimId] || {};
        if (mark.expiry && mark.lowData) continue;          // по этой eSIM всё уже сказано
        let usage = null;
        try { usage = await providerFor(item.esimId).getUsage(item.esimId); } catch (_) { continue; }
        // у суточного пакета трафик обнуляется каждый день — «почти закончился» не пишем
        if (usage && usage.daily) mark.lowData = mark.lowData || -1;
        const packs = (usage && usage.packages) || [];
        if (!packs.length) continue;
        const totalMb = packs.reduce((a, x) => a + x.totalMb, 0);
        const leftMb = packs.reduce((a, x) => a + x.remainingMb, 0);
        const activated = packs.some((x) => x.activatedAt);
        let expiresAt = null;
        packs.forEach((x) => { if (x.expiresAt && (!expiresAt || new Date(x.expiresAt) > new Date(expiresAt))) expiresAt = x.expiresAt; });
        const daysLeft = expiresAt ? Math.ceil((new Date(expiresAt) - Date.now()) / 86400000) : null;
        const gb = (mb) => (mb / 1024 >= 10 ? String(Math.round(mb / 1024)) : String(Math.round(mb / 102.4) / 10).replace(".", ",")) + " ГБ";

        // 1) срок на исходе — считаем только по активированным, у остальных отсчёт ещё не пошёл
        if (!mark.expiry && activated && daysLeft !== null && daysLeft <= NOTIFY_DAYS_BEFORE && daysLeft >= 0) {
          const canTopup = await hasTopups(item.productId);
          if (item.email) {
            await opts.sendMail(Object.assign({ to: item.email },
              notifyLetter({ kind: "expiry", item, days: daysLeft, canTopup }))).catch(() => {});
          }
          if (item.tgChatId && opts.notifyTelegram) {
            await opts.notifyTelegram({ chatId: item.tgChatId, kind: "expiry", label: item.label,
              days: daysLeft, canTopup, myUrl: item.myUrl }).catch(() => {});
          }
          mark.expiry = Date.now(); mails++;
        }
        // 2) трафик на исходе
        if (!mark.lowData && totalMb > 0 && leftMb / totalMb < NOTIFY_LOW_SHARE && (activated || leftMb < totalMb)) {
          const canTopup = await hasTopups(item.productId);
          if (item.email) {
            await opts.sendMail(Object.assign({ to: item.email },
              notifyLetter({ kind: "lowData", item, left: gb(leftMb), total: gb(totalMb), canTopup }))).catch(() => {});
          }
          if (item.tgChatId && opts.notifyTelegram) {
            await opts.notifyTelegram({ chatId: item.tgChatId, kind: "lowData", label: item.label,
              left: gb(leftMb), total: gb(totalMb), canTopup, myUrl: item.myUrl }).catch(() => {});
          }
          mark.lowData = Date.now(); mails++;
        }
        if (mark.expiry || mark.lowData) sent[item.esimId] = mark;
        await new Promise((r) => setTimeout(r, 400));       // не долбим API поставщика
      }
      writeJson(NOTIFY_FILE, sent);
      if (mails) console.log("esim: напоминаний отправлено", mails);
    } catch (e) { console.error("esim notify:", e.message); }
    finally { _notifyRunning = false; }
  }
  setTimeout(() => { runNotifications(); }, 3 * 60 * 1000);
  setInterval(() => { runNotifications(); }, NOTIFY_EVERY_MS);

  // Баланс поставщиков смотрим раз в полчаса и сразу после каждой выдачи
  setTimeout(() => { checkSupplierBalances().catch(() => {}); }, 4 * 60 * 1000);
  setInterval(() => { checkSupplierBalances().catch(() => {}); }, 30 * 60 * 1000);

  // Состояние сторожа баланса и ручной прогон: ?adm=КОД[&run=1]
  app.get("/esim/api/balance/watch", async (req, res) => {
    if (String(req.query.adm || "") !== ADMIN_CODE) return res.status(403).json({ success: false });
    const state = req.query.run === "1" ? await checkSupplierBalances() : readJson(BAL_WATCH_FILE, {});
    res.json({
      success: true,
      thresholds: BALANCE_WATCH.map((s) => ({ key: s.key, name: s.name, lowUsd: s.low, critUsd: s.crit, on: s.on() })),
      tsim: { leftUsd: tsimLeftUsd(), reserveUsd: TSIM_RESERVE_USD, watch: readJson(TSIM_WATCH_FILE, {}) },
      state,
    });
  });

  // Брошенную оплату проверяем часто: письмо должно прийти, пока человек ещё
  // не забыл про поездку.
  setTimeout(() => { runAbandoned(); }, 4 * 60 * 1000);
  setInterval(() => { runAbandoned(); }, 10 * 60 * 1000);

  // Ручной прогон писем по брошенной оплате — для проверки
  app.get("/esim/api/abandon/run", async (req, res) => {
    if (String(req.query.adm || "") !== ADMIN_CODE) return res.status(403).json({ success: false });
    // Проверка вёрстки: оба письма по конкретному заказу уходят на указанный
    // адрес, отметки в заказе не ставятся и клиент ничего не получает.
    if (validEmail(req.query.test)) {
      const list = readJson(ORDERS_FILE, []).filter((o) => o.status === "pending" && o.paymentId);
      const o = req.query.o ? list.find((x) => x.id === String(req.query.o)) : list[0];
      if (!o) return res.json({ success: false, message: "Нет ни одного заказа в ожидании оплаты." });
      let st = null;
      try { const r = await tbank.getState(o.paymentId); st = (r && r.Status) || null; } catch (_) {}
      const why = bankWhy(st);
      const only = String(req.query.only || "");
      const a1 = only === "admin" ? null
        : await opts.sendMail(Object.assign({ to: req.query.test }, abandonLetter(o, why)));
      const a2 = only === "client" ? null
        : await opts.sendMail(Object.assign({}, abandonAdminLetter(o, why, st), { to: req.query.test }));
      return res.json({ success: true, test: true, order: o.id, bank: st, why, client: a1, admin: a2 });
    }
    await runAbandoned({ all: String(req.query.all || "") === "1" });
    const now = Date.now();
    res.json({ success: true, promo: ABANDON_PROMO, pending: readJson(ORDERS_FILE, [])
      .filter((o) => o.status === "pending" && now - o.ts < ABANDON_MAX_MS)
      .map((o) => ({ id: o.id, ts: adsource.mskTime(o.ts), rub: o.priceRub, label: o.label,
                     email: o.email, mail: o.abandonMail || 0, adm: o.abandonAdmin || 0 })) });
  });

  // Ручной прогон и просмотр — для проверки
  app.get("/esim/api/notify/run", async (req, res) => {
    if (String(req.query.adm || "") !== ADMIN_CODE) return res.status(403).json({ success: false });
    await runNotifications();
    res.json({ success: true, watched: esimsToWatch().length, sent: readJson(NOTIFY_FILE, {}) });
  });

  // ═══ Панель показателей: dev.voyomobile.ru ═══
  // Выручка и пакеты по дням, реклама по каналам и её окупаемость, клиенты,
  // промокоды и итог: выручка минус себестоимость, комиссия банка и реклама.
  // Расходы на рекламу вносятся руками (в API их нет), лежат в .esim/adspend.json.
  const ADSPEND_FILE = path.join(DIR, "adspend.json");
  function loadSpend() {
    const d = readJson(ADSPEND_FILE, null) || {};
    return { acqPct: Number(d.acqPct != null ? d.acqPct : 2.5), items: Array.isArray(d.items) ? d.items : [] };
  }
  // Канал берём из первой метки: она отвечает за то, откуда человек пришёл впервые.
  function channelOf(o) {
    const a = (o.ads && (o.ads.first || o.ads)) || null;
    const src = a && String(a.utm_source || "").toLowerCase();
    if (src) return src;
    if (a && a.yclid) return "yandex";
    if (a && a.gclid) return "google";
    if (o.tgChatId) return "telegram_bot";
    return "direct";
  }
  const CHANNEL_NAMES = {
    yandex: "Яндекс Директ", google: "Google Ads", telegram_bot: "Телеграм-бот",
    direct: "Прямые заходы", vk: "ВКонтакте", blogger: "Блогеры", email: "Рассылка",
  };
  function channelName(k) { return CHANNEL_NAMES[k] || k; }
  const mskDay = (ts) => new Date(ts + 3 * 3600 * 1000).toISOString().slice(0, 10);
  // Свои проверочные покупки в цифры не пускаем: Андрей смотрит на них как на
  // реальные продажи и злится. Показать их можно галочкой в панели (?test=1).
  const TEST_EMAILS = String(process.env.ESIM_TEST_EMAILS || "komizarenko@gmail.com,probe@example.com")
    .split(",").map((x) => x.trim().toLowerCase()).filter(Boolean);
  function isTestOrder(o) {
    return String(o.promoCode || "").toUpperCase() === "OWNER" ||
      TEST_EMAILS.indexOf(normEmail(o.email)) >= 0 ||
      /(^|\s)test\b/i.test(String(o.label || ""));
  }

  app.get("/esim/api/adm/stats", async (req, res) => {
    if (String(req.query.adm || "") !== ADMIN_CODE) return res.status(403).json({ success: false });
    try {
      const rate = await usdRate();
      const spend = loadSpend();
      const from = String(req.query.from || "").slice(0, 10);
      const to = String(req.query.to || "").slice(0, 10);
      const inRange = (day) => (!from || day >= from) && (!to || day <= to);
      const withTest = req.query.test === "1";
      const all = readJson(ORDERS_FILE, []).filter((o) => withTest || !isTestOrder(o));
      const testCount = readJson(ORDERS_FILE, []).filter((o) => o.status === "done" && o.paidAt && isTestOrder(o)).length;
      const paid = all.filter((o) => o.status === "done" && o.paidAt && o.priceRub)
        .filter((o) => inRange(mskDay(o.paidAt)));
      const costOf = (o) => (o.costUsd ? tsimCostRub(o.costUsd, rate) : 0);

      const days = new Map();
      const chans = new Map();
      let revenue = 0, cost = 0;
      paid.forEach((o) => {
        const day = mskDay(o.paidAt), c = costOf(o);
        revenue += o.priceRub; cost += c;
        const d = days.get(day) || { day, revenue: 0, orders: 0, cost: 0 };
        d.revenue += o.priceRub; d.orders++; d.cost += c; days.set(day, d);
        const k = channelOf(o);
        const ch = chans.get(k) || { key: k, name: channelName(k), orders: 0, revenue: 0, cost: 0, spend: 0 };
        ch.orders++; ch.revenue += o.priceRub; ch.cost += c; chans.set(k, ch);
      });
      spend.items.filter((x) => inRange(String(x.date || ""))).forEach((x) => {
        const ch = chans.get(x.channel) || { key: x.channel, name: channelName(x.channel), orders: 0, revenue: 0, cost: 0, spend: 0 };
        ch.spend += Number(x.rub) || 0; chans.set(x.channel, ch);
      });
      const adSpend = spend.items.filter((x) => inRange(String(x.date || "")))
        .reduce((a, x) => a + (Number(x.rub) || 0), 0);
      const acq = Math.round(revenue * spend.acqPct / 100);

      // клиенты: считаем только тех, у кого есть оплаченный заказ
      const cust = loadCustomers();
      const byCust = new Map();
      all.filter((o) => o.status === "done" && o.paidAt).forEach((o) => {
        const key = o.custKey || normEmail(o.email) || (o.tgChatId ? "tg:" + o.tgChatId : "");
        if (!key) return;
        const c = byCust.get(key) || { key, orders: 0, revenue: 0, first: o.paidAt, last: o.paidAt, channel: channelOf(o) };
        c.orders++; c.revenue += o.priceRub || 0;
        c.first = Math.min(c.first, o.paidAt); c.last = Math.max(c.last, o.paidAt);
        byCust.set(key, c);
      });
      const customers = Array.from(byCust.values()).map((c) => {
        const rec = cust[c.key] || cust[normEmail(c.key)] || {};
        return Object.assign({}, c, { refCode: rec.refCode || null, balanceRub: rec.balanceRub || 0,
          invitedBy: rec.invitedBy || null, name: c.key });
      }).sort((a, b) => b.last - a.last);

      // промокоды: сколько раз вводили и сколько по ним продали
      const promos = readJson(PROMOS_FILE, {});
      const promoRevenue = {};
      all.filter((o) => o.status === "done" && o.promoCode).forEach((o) => {
        const k = String(o.promoCode).toUpperCase();
        promoRevenue[k] = (promoRevenue[k] || 0) + (o.priceRub || 0);
      });
      const promoList = Object.keys(promos).map((code) => Object.assign({ code },
        promos[code], { revenue: promoRevenue[code] || 0 }));

      res.json({
        success: true, from: from || null, to: to || null, usdRate: rate,
        testShown: withTest, testCount,
        totals: {
          revenue, orders: paid.length, cost: Math.round(cost), acq, acqPct: spend.acqPct, adSpend,
          profit: Math.round(revenue - cost - acq - adSpend),
          avgCheck: paid.length ? Math.round(revenue / paid.length) : 0,
          customers: byCust.size, customersAll: Object.keys(cust).length,
        },
        days: Array.from(days.values()).sort((a, b) => (a.day < b.day ? -1 : 1))
          .map((d) => Object.assign(d, { cost: Math.round(d.cost), margin: Math.round(d.revenue - d.cost) })),
        channels: Array.from(chans.values()).map((c) => {
          const margin = Math.round(c.revenue - c.cost - c.revenue * spend.acqPct / 100);
          return Object.assign({}, c, { cost: Math.round(c.cost), margin,
            profit: Math.round(margin - c.spend),
            drr: c.revenue ? Math.round(c.spend / c.revenue * 1000) / 10 : null,
            cpo: c.orders ? Math.round(c.spend / c.orders) : null,
            roi: c.spend ? Math.round(margin / c.spend * 100) / 100 : null });
        }).sort((a, b) => b.revenue - a.revenue),
        customers, promos: promoList, spend: spend.items.slice().sort((a, b) => (a.date < b.date ? 1 : -1)),
      });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
  });

  // Расходы на рекламу и процент эквайринга правим руками из панели
  app.post("/esim/api/adm/spend", (req, res) => {
    const b = req.body || {};
    if (String(b.adm || "") !== ADMIN_CODE) return res.status(403).json({ success: false });
    const d = loadSpend();
    if (b.acqPct != null) d.acqPct = Math.max(0, Math.min(20, Number(b.acqPct) || 0));
    if (b.del) d.items = d.items.filter((x) => x.id !== String(b.del));
    if (b.add) {
      const a = b.add;
      const rub = Math.round(Number(a.rub) || 0);
      const date = String(a.date || "").slice(0, 10);
      const channel = String(a.channel || "").trim().toLowerCase().slice(0, 40);
      if (!rub || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !channel) {
        return res.status(400).json({ success: false, message: "Нужны канал, дата и сумма." });
      }
      d.items.push({ id: crypto.randomBytes(4).toString("hex"), channel, date, rub,
        note: String(a.note || "").slice(0, 120), ts: Date.now() });
    }
    writeJson(ADSPEND_FILE, d);
    res.json({ success: true, acqPct: d.acqPct, items: d.items.length });
  });

  // Сама страница панели. Отдаём и по адресу /esim/adm, и в корне dev-домена.
  app.get(["/esim/adm", "/esim/adm/"], (req, res) => {
    res.set("Cache-Control", "no-store");
    res.sendFile(path.join(__dirname, "public", "esim-adm.html"));
  });

  // ═══ Приглашение друзей: письмо через сутки после первой оплаты ═══
  // Клиент уже съездил или хотя бы поставил eSIM и убедился, что всё работает,
  // поэтому предложение позвать друга выглядит уместно, а не как спам вдогонку
  // к оплате. Одному клиенту письмо уходит один раз.
  function refInviteLetter(c) {
    const link = REF_SITE + "/?ref=" + c.refCode;
    const acc = BASE_URL + "/esim/account?e=" + encodeURIComponent(c.email) + "&t=" + signEmail(c.email);
    const b = REF_BONUS_RUB;
    return {
      subject: "VOYO mobile: " + b + " ₽ вам и " + b + " ₽ другу",
      html: '<div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;max-width:520px;margin:0 auto;color:#16202e">' +
        '<p style="font-size:19px;font-weight:700;letter-spacing:-.02em;margin:0 0 10px">Приглашайте друзей в VOYO mobile</p>' +
        '<p style="font-size:14.5px;line-height:1.6;color:#3a4356;margin:0 0 10px">Спасибо за покупку!</p>' +
        '<p style="font-size:14.5px;line-height:1.6;color:#3a4356;margin:0 0 18px">Если кому-либо из ваших друзей и близких ' +
        'понадобится eSIM в любой стране мира, поделитесь своим промокодом или ссылкой: друг сразу получит скидку ' +
        b + ' ₽, а вы получите ' + b + ' ₽ на свой баланс сразу после оплаты друга.</p>' +
        '<p style="font-size:13px;color:#8b93a5;margin:0 0 6px">Ваш личный промокод</p>' +
        '<p style="margin:0 0 14px"><span style="display:inline-block;font-family:SFMono-Regular,Consolas,monospace;' +
        'font-size:22px;font-weight:700;letter-spacing:.12em;background:#f2f7fb;border:1px solid #e0e9f2;' +
        'border-radius:12px;padding:12px 20px">' + c.refCode + '</span></p>' +
        '<p style="font-size:14.5px;line-height:1.6;color:#3a4356;margin:0 0 14px">Вводите в поле «Промокод» при оплате.<br/>' +
        'Также можно отправить вашу персональную ссылку, и бонус применится автоматически:</p>' +
        '<p style="margin:0 0 18px;font-size:14px;word-break:break-all"><a href="' + link + '" style="color:#3589bd">' + link + '</a></p>' +
        '<p style="margin:0 0 18px"><a href="' + acc + '" style="display:inline-block;background:#3589bd;color:#fff;' +
        'text-decoration:none;font-weight:700;font-size:15px;padding:13px 22px;border-radius:12px">Мой кабинет и баланс</a></p>' +
        '<p style="font-size:13px;line-height:1.6;color:#8b93a5;margin:0 0 6px">Бонусами можно оплатить до половины ' +
        'стоимости eSIM, они не сгорают. Приглашать можно сколько угодно друзей.</p>' +
        '<p style="font-size:12px;color:#a6adbd;margin:18px 0 0">VOYO mobile · выгодный интернет в 209 странах мира</p></div>',
      text: "Приглашайте друзей в VOYO mobile\n\nСпасибо за покупку!\n\n" +
        "Если кому-либо из ваших друзей и близких понадобится eSIM в любой стране мира, поделитесь своим промокодом " +
        "или ссылкой: друг сразу получит скидку " + b + " ₽, а вы получите " + b + " ₽ на свой баланс сразу после оплаты друга.\n\n" +
        "Ваш личный промокод: " + c.refCode + "\nВводите в поле «Промокод» при оплате.\n" +
        "Также можно отправить вашу персональную ссылку, и бонус применится автоматически:\n" + link + "\n\n" +
        "Бонусами можно оплатить до половины стоимости eSIM, они не сгорают. Приглашать можно сколько угодно друзей.\n" +
        "Кабинет и баланс: " + acc,
    };
  }

  // Кому и когда: у клиента есть оплаченный заказ, с первой оплаты прошли сутки,
  // письма ещё не было. backfill=1 отправляет и тем, кто купил раньше.
  function refInviteTargets({ backfill }) {
    const orders = readJson(ORDERS_FILE, []).filter((o) => o.status === "done" && o.paidAt);
    const firstPaid = new Map();
    orders.forEach((o) => {
      const key = o.custKey || normEmail(o.email) || (o.tgChatId ? "tg:" + o.tgChatId : "");
      if (!key) return;
      if (!firstPaid.has(key) || o.paidAt < firstPaid.get(key)) firstPaid.set(key, o.paidAt);
    });
    const sent = readJson(REFINVITE_FILE, {});
    const all = loadCustomers();
    const out = [];
    firstPaid.forEach((ts, key) => {
      if (sent[key]) return;
      if (!backfill && Date.now() - ts < REFINVITE_AFTER_MS) return;
      const c = all[key] || all[normEmail(key)];
      if (!c || !c.refCode) return;
      const tg = String(key).indexOf("tg:") === 0 ? String(key).slice(3) : null;
      if (!tg && !validEmail(c.email)) return;
      out.push({ key, email: c.email, refCode: c.refCode, tgChatId: tg, firstPaid: ts });
    });
    return out.sort((a, b) => a.firstPaid - b.firstPaid);
  }

  async function runRefInvites({ backfill, dry } = {}) {
    const targets = refInviteTargets({ backfill });
    const done = [];
    for (const t of targets) {
      if (dry) { done.push({ key: t.key, how: t.tgChatId ? "телеграм" : "почта", dry: true }); continue; }
      let ok = false;
      if (t.tgChatId && opts && opts.notifyTelegram) {
        await opts.notifyTelegram({ chatId: t.tgChatId, kind: "refInvite", refCode: t.refCode,
          bonusRub: REF_BONUS_RUB }).then(() => { ok = true; }).catch((e) => console.error("esim refinvite tg:", e.message));
      } else if (opts && opts.sendMail) {
        const L = refInviteLetter(t);
        const r = await opts.sendMail({ to: t.email, subject: L.subject, html: L.html, text: L.text })
          .catch((e) => ({ ok: false, error: e.message }));
        ok = !r || r.ok !== false;
        if (!ok) console.error("esim refinvite mail:", t.email, (r && r.error) || "");
      }
      if (ok) {
        const sent = readJson(REFINVITE_FILE, {});
        sent[t.key] = Date.now();
        writeJson(REFINVITE_FILE, sent);
        done.push({ key: t.key, how: t.tgChatId ? "телеграм" : "почта" });
      }
      await new Promise((r) => setTimeout(r, 700));      // не долбим SMTP пачкой
    }
    if (done.length) console.log("esim: приглашений отправлено", done.length);
    return { targets: targets.length, sent: done };
  }

  // Раз в час смотрим, кому пора. Ручной прогон и предпросмотр — по админ-коду:
  //   ?adm=КОД            — кто в очереди (ничего не отправляет)
  //   ?adm=КОД&test=почта — прислать письмо на указанный адрес, для проверки
  //   ?adm=КОД&run=1      — отправить тем, у кого срок подошёл
  //   ?adm=КОД&run=1&backfill=1 — отправить всем, кто уже покупал
  setTimeout(() => { runRefInvites({}).catch((e) => console.error("esim refinvite:", e.message)); }, 6 * 60 * 1000);
  setInterval(() => { runRefInvites({}).catch((e) => console.error("esim refinvite:", e.message)); }, 60 * 60 * 1000);

  app.get("/esim/api/ref/invite", async (req, res) => {
    if (String(req.query.adm || "") !== ADMIN_CODE) return res.status(403).json({ success: false });
    const test = String(req.query.test || "").trim();
    if (test) {
      if (!validEmail(test)) return res.status(400).json({ success: false, message: "Нужен корректный адрес." });
      const me = getCustomer(test, true);
      const L = refInviteLetter({ email: test, refCode: me.refCode });
      const r = opts && opts.sendMail ? await opts.sendMail({ to: test, subject: L.subject, html: L.html, text: L.text }) : null;
      return res.json({ success: true, test: test, refCode: me.refCode, mail: r });
    }
    const backfill = req.query.backfill === "1";
    if (req.query.run !== "1") {
      return res.json({ success: true, dry: true, afterHours: REFINVITE_AFTER_MS / 3600000,
        queue: (await runRefInvites({ backfill, dry: true })).sent, already: readJson(REFINVITE_FILE, {}) });
    }
    const r = await runRefInvites({ backfill });
    res.json(Object.assign({ success: true, backfill }, r));
  });

  // Прогрев кэша каталога после старта (не блокируем запуск)
  if (provider.ready()) setTimeout(() => { getCatalog(true).catch(() => {}); }, 15000);
}

// _tsim — для ручной проверки заказа со скрипта на сервере (tools/ не нужен)
module.exports = { mount, _tsim: tsim, _ea: esimaccess };
