// ═══════════════════════════════════════════════════════════════════════════
// VOYO mobile — телеграм-бот продажи eSIM (t.me/esimvoyo_bot)
//
// Бот это ВТОРОЕ ЛИЦО того же сервиса: каталог, цены, промокоды, оплата и
// выдача живут в esim.js, бот только разговаривает с человеком и дёргает наш
// же HTTP-API на localhost. Поэтому правка цены или промокода на сайте сразу
// действует и в боте, дублировать логику не нужно.
//
// Поток: /start → страна → пакет → почта (для чека) → ссылка на оплату
//        → банк зовёт /esim/api/pay/notify → esim.js выдаёт eSIM и зовёт
//        onIssued → бот шлёт QR картинкой прямо в чат.
//
// Токен в .env: ESIM_TG_TOKEN. Секрет вебхука — ESIM_TG_SECRET (или считается
// от токена). В git не попадает ни то, ни другое.
// ═══════════════════════════════════════════════════════════════════════════
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const axios = require("axios");

const DIR = path.join(__dirname, ".esim");
const STATE_FILE = path.join(DIR, "tgstate.json");     // с кем на каком шаге говорим
const OFFSET_FILE = path.join(DIR, "tgoffset.json");   // на каком обновлении остановились
const TG_API = "https://api.telegram.org/bot";

const TOKEN = process.env.ESIM_TG_TOKEN || "";
// С прод-сервера исходящие к api.telegram.org не проходят, поэтому наружу
// ходим через свой ретранслятор на Deno (tools/deno-relay-telegram.ts).
// Входящие вебхуки Telegram присылает нам напрямую — им релей не нужен.
const RELAY = (process.env.ESIM_TG_RELAY || "").replace(/\/+$/, "");
const SELF = process.env.ESIM_SELF_BASE || "http://127.0.0.1:3000";
const BASE_URL = process.env.ESIM_BASE_URL || "https://voyotravel.ru";
const UTM_PROMO = process.env.ESIM_UTM_PROMO || "VSC20OFF3";
const SUPPORT_TG = "https://t.me/vsc_operator";

function ready() { return !!TOKEN; }
function webhookPath() {
  const secret = process.env.ESIM_TG_SECRET ||
    crypto.createHash("sha256").update("tg:" + TOKEN).digest("hex").slice(0, 24);
  return "/tg/esim/" + secret;
}

// ─────────────────────────── состояние диалога ───────────────────────────
// Один файл на всех: чатов немного, а переживать рестарты нужно.
function readJson(f, dflt) { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch (_) { return dflt; } }
function writeJson(f, d) {
  try { fs.mkdirSync(DIR, { recursive: true }); fs.writeFileSync(f, JSON.stringify(d, null, 1), "utf8"); }
  catch (e) { console.error("tg write:", e.message); }
}
function getState(chatId) { return readJson(STATE_FILE, {})[String(chatId)] || {}; }
function setState(chatId, patch) {
  const all = readJson(STATE_FILE, {});
  const key = String(chatId);
  all[key] = Object.assign({}, all[key], patch, { ts: Date.now() });
  // Чистим совсем старые диалоги, чтобы файл не пух
  const cut = Date.now() - 180 * 24 * 3600 * 1000;
  Object.keys(all).forEach((k) => { if ((all[k].ts || 0) < cut) delete all[k]; });
  writeJson(STATE_FILE, all);
  return all[key];
}

// ─────────────────────────── разговор с Telegram ───────────────────────────
function callUrl(method) { return RELAY ? RELAY + "/" + method : TG_API + TOKEN + "/" + method; }
function callHeaders(extra) {
  return Object.assign({}, extra || {}, RELAY ? { "X-Bot-Token": TOKEN } : {});
}
async function tg(method, payload) {
  try {
    const r = await axios.post(callUrl(method), payload, { timeout: 30000, headers: callHeaders() });
    return r.data && r.data.result;
  } catch (e) {
    const d = e.response && e.response.data;
    console.error("tg " + method + ":", (d && d.description) || e.message);
    return null;
  }
}
const send = (chatId, text, extra) => tg("sendMessage", Object.assign({
  chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: true,
}, extra || {}));
const edit = (chatId, messageId, text, extra) => tg("editMessageText", Object.assign({
  chat_id: chatId, message_id: messageId, text, parse_mode: "HTML", disable_web_page_preview: true,
}, extra || {}));
const answer = (id, text) => tg("answerCallbackQuery", { callback_query_id: id, text: text || undefined });

// QR приходит от поставщика как data:image/png;base64 — отправляем картинкой,
// чтобы человек мог сразу навести на неё камеру со второго телефона или
// открыть на весь экран и отсканировать.
async function sendQr(chatId, dataUrl, caption) {
  const m = /^data:image\/(png|jpeg);base64,(.+)$/i.exec(String(dataUrl || ""));
  if (!m) return null;
  const form = new FormData();
  form.append("chat_id", String(chatId));
  form.append("caption", caption || "");
  form.append("parse_mode", "HTML");
  form.append("photo", new Blob([Buffer.from(m[2], "base64")], { type: "image/" + m[1] }), "esim-qr.png");
  try {
    const r = await axios.post(callUrl("sendPhoto"), form, { timeout: 60000, headers: callHeaders() });
    return r.data && r.data.result;
  } catch (e) {
    const d = e.response && e.response.data;
    console.error("tg sendPhoto:", (d && d.description) || e.message);
    return null;
  }
}

// ─────────────────────────── наш же API ───────────────────────────
async function api(method, url, body, headers) {
  const r = await axios({ method, url: SELF + url, data: body, headers, timeout: 60000, validateStatus: () => true });
  return r.data;
}

let _cat = { ts: 0, products: [], byCountry: {}, index: [] };
const RU = (n) => Math.round(Number(n) || 0).toLocaleString("ru-RU");
let dn; try { dn = new Intl.DisplayNames(["ru"], { type: "region" }); } catch (_) { dn = null; }
const SHORT = { US: "США", GB: "Великобритания", AE: "ОАЭ", KR: "Южная Корея", CZ: "Чехия", "US-HI": "Гавайи" };
function cname(iso) {
  if (iso === "EU-REGION") return "Европа";
  if (SHORT[iso]) return SHORT[iso];
  try { return (dn && dn.of(iso)) || iso; } catch (_) { return iso; }
}
function flag(iso) {
  if (iso === "EU-REGION") return "🇪🇺";
  if (!/^[A-Z]{2}$/.test(iso)) return "🌍";
  return String.fromCodePoint(0x1F1E6 + iso.charCodeAt(0) - 65, 0x1F1E6 + iso.charCodeAt(1) - 65);
}
const EU = "AT BE BG HR CY CZ DK EE FI FR DE GR HU IS IE IT LV LI LT LU MT NL NO PL PT RO SK SI ES SE CH GB"
  .split(" ").reduce((a, c) => (a[c] = 1, a), {});
const isEuroRegional = (p) => p.countries.filter((c) => EU[c]).length >= 15;
const POPULAR = ["ES", "IT", "FR", "EU-REGION", "TR", "AE", "TH", "JP", "US"];

// Как люди на самом деле называют страны: «Америка», «Эмираты», «Тайланд»
// через «й», курорты вместо стран. Официальное название знают не все, а уйти
// из бота ни с чем человек может с первой же попытки.
const ALIAS = {
  "US": "сша америка соединенные штаты штаты usa america united states",
  "AE": "оаэ эмираты арабские дубай абу-даби uae dubai emirates",
  "GB": "великобритания англия британия лондон uk britain england",
  "KR": "южная корея корея сеул korea",
  "CZ": "чехия прага czech",
  "TR": "турция турци стамбул анталия анталья turkey turkiye",
  "TH": "таиланд тайланд бангкок пхукет самуи thailand",
  "ES": "испания барселона мадрид тенерифе майорка spain",
  "IT": "италия рим милан венеция italy",
  "FR": "франция париж ницца france",
  "DE": "германия берлин мюнхен germany",
  "GR": "греция афины крит родос greece",
  "EG": "египет хургада шарм каир egypt",
  "CN": "китай пекин шанхай china",
  "JP": "япония токио japan",
  "VN": "вьетнам нячанг фукуок дананг vietnam",
  "GE": "грузия тбилиси батуми georgia",
  "AM": "армения ереван armenia",
  "AZ": "азербайджан баку azerbaijan",
  "RS": "сербия белград serbia",
  "ME": "черногория будва montenegro",
  "CY": "кипр ларнака cyprus",
  "IL": "израиль тель-авив israel",
  "IN": "индия гоа india",
  "ID": "индонезия бали джакарта indonesia bali",
  "MV": "мальдивы maldives",
  "LK": "шри-ланка шри ланка цейлон sri lanka",
  "KZ": "казахстан алматы астана kazakhstan",
  "UZ": "узбекистан ташкент самарканд uzbekistan",
  "KG": "киргизия кыргызстан бишкек",
  "BY": "беларусь белоруссия минск belarus",
  "MD": "молдова молдавия кишинев moldova",
  "PT": "португалия лиссабон portugal",
  "NL": "нидерланды голландия амстердам netherlands holland",
  "AT": "австрия вена austria",
  "CH": "швейцария цюрих женева switzerland",
  "PL": "польша варшава краков poland",
  "HU": "венгрия будапешт hungary",
  "FI": "финляндия хельсинки finland",
  "SE": "швеция стокгольм sweden",
  "NO": "норвегия осло norway",
  "DK": "дания копенгаген denmark",
  "HR": "хорватия croatia",
  "BG": "болгария болгари bulgaria",
  "RO": "румыния romania",
  "AL": "албания albania",
  "MX": "мексика канкун mexico",
  "BR": "бразилия brazil",
  "AR": "аргентина argentina",
  "CA": "канада canada",
  "AU": "австралия australia",
  "NZ": "новая зеландия zealand",
  "ZA": "юар южная африка africa",
  "MA": "марокко morocco",
  "TN": "тунис tunisia",
  "QA": "катар доха qatar",
  "SA": "саудовская аравия саудовская riyadh",
  "OM": "оман oman",
  "BH": "бахрейн bahrain",
  "KW": "кувейт kuwait",
  "JO": "иордания jordan",
  "SG": "сингапур singapore",
  "MY": "малайзия куала-лумпур malaysia",
  "PH": "филиппины philippines",
  "HK": "гонконг hong kong",
  "TW": "тайвань taiwan",
  "EU-REGION": "европа европу европе шенген евросоюз europe",
};
function norm(s) { return String(s || "").toLowerCase().replace(/ё/g, "е").replace(/\s+/g, " ").trim(); }

// Ищем в таком порядке: точное название, начало названия, синоним, вхождение.
function searchCountries(list, query) {
  const q = norm(query);
  if (q.length < 2) return [];
  const seen = {}, out = [];
  const push = (x) => { if (x && !seen[x.iso]) { seen[x.iso] = 1; out.push(x); } };
  const named = list.map((x) => ({ iso: x.iso, name: x.name, n: norm(x.name) }));
  named.filter((x) => x.n === q).forEach(push);
  named.filter((x) => x.n.indexOf(q) === 0).forEach(push);
  named.filter((x) => (ALIAS[x.iso] || "").split(" ").some((w) => w && w.indexOf(q) === 0)).forEach(push);
  if (ALIAS["EU-REGION"].split(" ").some((w) => w && w.indexOf(q) === 0)) push({ iso: "EU-REGION", name: "Европа" });
  named.filter((x) => x.n.indexOf(q) > 0).forEach(push);
  return out;
}

async function catalog() {
  if (Date.now() - _cat.ts < 10 * 60 * 1000 && _cat.products.length) return _cat;
  const j = await api("get", "/esim/api/catalog");
  if (!j || !j.success) return _cat;
  const byCountry = {};
  j.products.forEach((p) => (p.countries || []).forEach((c) => { (byCountry[c] = byCountry[c] || []).push(p); }));
  _cat = {
    ts: Date.now(), products: j.products, byCountry, pay: j.pay,
    index: Object.keys(byCountry).map((iso) => ({ iso, name: cname(iso) })),
  };
  return _cat;
}
async function packsFor(iso) {
  const c = await catalog();
  const list = iso === "EU-REGION" ? c.products.filter(isEuroRegional) : (c.byCountry[iso] || []).slice();
  return list.sort((a, b) => a.priceRub - b.priceRub);
}
const gbOf = (p) => (p.unlimited ? "безлимит" : RU(p.dataGb) + " ГБ");
const packLabel = (p) => gbOf(p) + " · " + RU(p.days) + " дн. · " + RU(p.priceRub) + " ₽";

// ─────────────────────────── экраны ───────────────────────────
function homeKeyboard() {
  const rows = [];
  for (let i = 0; i < POPULAR.length; i += 3) {
    rows.push(POPULAR.slice(i, i + 3).map((iso) => ({ text: flag(iso) + " " + cname(iso), callback_data: "c:" + iso })));
  }
  rows.push([{ text: "🌍 Все страны", callback_data: "all:0" }]);
  rows.push([{ text: "📱 Мои eSIM", callback_data: "my" }, { text: "💬 Помощь", url: SUPPORT_TG }]);
  return { inline_keyboard: rows };
}

// Полный список стран страницами: в каталоге их около двух сотен, в одну
// клавиатуру не влезут, а искать словом догадается не каждый.
const PER_PAGE = 24;
async function showAllCountries(chatId, page, messageId) {
  const c = await catalog();
  const all = c.index.slice().sort((a, b) => a.name.localeCompare(b.name, "ru"));
  const pages = Math.max(1, Math.ceil(all.length / PER_PAGE));
  const p = Math.min(Math.max(0, page), pages - 1);
  const slice = all.slice(p * PER_PAGE, p * PER_PAGE + PER_PAGE);
  const rows = [];
  for (let i = 0; i < slice.length; i += 3) {
    rows.push(slice.slice(i, i + 3).map((x) => ({
      text: flag(x.iso) + " " + x.name.slice(0, 18), callback_data: "c:" + x.iso,
    })));
  }
  const nav = [];
  if (p > 0) nav.push({ text: "‹ Назад", callback_data: "all:" + (p - 1) });
  nav.push({ text: (p + 1) + " из " + pages, callback_data: "all:" + p });
  if (p < pages - 1) nav.push({ text: "Далее ›", callback_data: "all:" + (p + 1) });
  rows.push(nav);
  rows.push([{ text: "‹ К популярным", callback_data: "home" }]);
  const head = "<b>Все страны — " + all.length + "</b>\nВыберите из списка или просто напишите название.";
  const kb = { inline_keyboard: rows };
  return messageId ? edit(chatId, messageId, head, { reply_markup: kb }) : send(chatId, head, { reply_markup: kb });
}
// Нижнее меню живёт всегда: с любого шага — хоть с оплаты — можно уйти
// посмотреть свои eSIM и вернуться, ничего не потеряв.
const BTN_BUY = "🌍 Купить eSIM";
const BTN_MY = "📱 Мои eSIM";
const BTN_HELP = "💬 Помощь";
const BTN_MAIL = "✉️ Почта для сайта";
function mainKeyboard() {
  return {
    keyboard: [[{ text: BTN_BUY }, { text: BTN_MY }], [{ text: BTN_MAIL }, { text: BTN_HELP }]],
    resize_keyboard: true, is_persistent: true,
  };
}

const HELLO =
  "<b>VOYO mobile — интернет в поездке</b>\n\n" +
  "Выбираете пакет, оплачиваете картой в рублях, сразу получаете QR-код прямо сюда. " +
  "Основная симка остаётся на месте, eSIM ставится второй линией только для интернета.\n\n" +
  "Куда летите? Нажмите страну ниже или напишите её название.";

async function showHome(chatId) {
  await send(chatId, "Меню всегда внизу: можно уйти к своим eSIM и вернуться сюда.",
    { reply_markup: mainKeyboard() });
  return send(chatId, HELLO, { reply_markup: homeKeyboard() });
}

async function showCountry(chatId, iso, page, messageId) {
  const list = await packsFor(iso);
  if (!list.length) {
    return send(chatId, "По этой стране пакетов сейчас нет. Напишите нам, подберём вручную: " + SUPPORT_TG);
  }
  const PER = 8;
  const pages = Math.max(1, Math.ceil(list.length / PER));
  const pg = Math.min(Math.max(0, page), pages - 1);
  const from = pg * PER;
  const slice = list.slice(from, from + PER);
  const rows = slice.map((p) => [{ text: packLabel(p), callback_data: "p:" + p.id }]);
  // Листаем в обе стороны: человек может уйти вперёд и захотеть вернуться
  const nav = [];
  if (pg > 0) nav.push({ text: "‹ Дешевле", callback_data: "c:" + iso + ":" + (pg - 1) });
  nav.push({ text: (pg + 1) + " из " + pages, callback_data: "c:" + iso + ":" + pg });
  if (pg < pages - 1) nav.push({ text: "Дороже ›", callback_data: "c:" + iso + ":" + (pg + 1) });
  if (nav.length > 1) rows.push(nav);
  rows.push([{ text: "‹ Другая страна", callback_data: "home" }]);
  const head = flag(iso) + " <b>" + cname(iso) + "</b> · " + list.length + " " +
    plural(list.length, ["пакет", "пакета", "пакетов"]) + "\n" +
    "Сначала самые дешёвые. Цена окончательная, в рублях, QR-код выдаётся сразу." +
    (pages > 1 ? "\nСтраница " + (pg + 1) + " из " + pages + "." : "");
  const kb = { inline_keyboard: rows };
  setState(chatId, { iso });
  return messageId ? edit(chatId, messageId, head, { reply_markup: kb }) : send(chatId, head, { reply_markup: kb });
}

async function showPack(chatId, productId, messageId) {
  const c = await catalog();
  const p = c.products.find((x) => x.id === productId);
  if (!p) return send(chatId, "Пакет больше не доступен, выберите другой.", { reply_markup: homeKeyboard() });
  const st = setState(chatId, { productId });
  const price = await priceFor(chatId, p);
  const multi = p.countries.length > 1;
  const where = multi ? p.countries.length + " " + plural(p.countries.length, ["страна", "страны", "стран"]) : cname(p.countries[0]);
  let text = "<b>" + esc(where) + " · " + gbOf(p) + "</b>\n" +
    "<i>" + esc(p.title || "") + (p.operator ? " · сеть " + esc(p.operator) : "") + "</i>\n\n" +
    "Интернет: <b>" + gbOf(p) + "</b>\n" +
    "Срок: <b>" + RU(p.days) + " дн.</b> с первого выхода в интернет\n" +
    "Сеть: <b>" + (p.fiveG ? "5G / 4G LTE" : "4G LTE") + "</b>\n" +
    "Раздача Wi-Fi: <b>" + (p.hotspot !== false ? "да" : "нет") + "</b>\n\n";
  if (price.discountRub > 0) {
    text += "Цена: <s>" + RU(price.listPrice) + " ₽</s>  <b>" + RU(price.total) + " ₽</b>\n" +
            "Скидка по вашей ссылке уже применена.\n";
  } else {
    text += "Цена: <b>" + RU(price.total) + " ₽</b>\n";
  }
  text += "\nПосле оплаты QR-код придёт сюда же, в этот чат.";
  const rows = [
    [{ text: "Оплатить " + RU(price.total) + " ₽", callback_data: "buy:" + p.id }],
    [{ text: "‹ Назад к пакетам", callback_data: "c:" + (st.iso || p.countries[0]) }],
  ];
  const kb = { inline_keyboard: rows };
  return messageId ? edit(chatId, messageId, text, { reply_markup: kb }) : send(chatId, text, { reply_markup: kb });
}

async function priceFor(chatId, p) {
  const st = getState(chatId);
  const j = await api("post", "/esim/api/price", { productId: p.id, promo: st.promo || "", email: st.email || "" });
  if (j && j.success) return j;
  return { listPrice: p.priceRub, total: p.priceRub, discountRub: 0 };
}

// Оплата: спрашиваем почту один раз — на неё уходит чек от онлайн-кассы,
// дальше берём сохранённую и не мучаем человека повторно.
async function startBuy(chatId, productId) {
  const st = setState(chatId, { productId });
  if (st.phone || st.email) return payLink(chatId);
  // Банк обязан отправить чек покупателю, поэтому один контакт всё же нужен.
  // Телефон отдаётся одним касанием — печатать ничего не надо.
  setState(chatId, { step: "contact" });
  return send(chatId,
    "Остался один шаг: банку нужен контакт для чека.\n\n" +
    "Нажмите кнопку ниже — телеграм сам передаст ваш номер, вводить ничего не нужно. " +
    "Чек придёт смской, а QR-код сюда, в чат.",
    { reply_markup: {
      keyboard: [[{ text: "📱 Отправить мой номер", request_contact: true }]],
      resize_keyboard: true, one_time_keyboard: true,
    } });
}

async function payLink(chatId) {
  const st = getState(chatId);
  const c = await catalog();
  const p = c.products.find((x) => x.id === st.productId);
  if (!p) return send(chatId, "Пакет больше не доступен, выберите другой.", { reply_markup: homeKeyboard() });
  const j = await api("post", "/esim/api/pay/start", {
    productId: p.id, email: st.email || "", phone: st.phone || "",
    promo: st.promo || "", tgChatId: String(chatId),
  });
  if (!j || !j.success || !j.url) {
    return send(chatId, "Не получилось открыть оплату. Попробуйте ещё раз или напишите нам: " + SUPPORT_TG);
  }
  const price = await priceFor(chatId, p);
  return send(chatId,
    "<b>" + esc(p.title || "") + "</b>\n" + gbOf(p) + " · " + RU(p.days) + " дн.\n\n" +
    "К оплате: <b>" + RU(price.total) + " ₽</b>\nЧек уйдёт " + (st.email ? "на " + esc(st.email) : "смской на " + esc(st.phone)) + "\n\n" +
    "Нажмите кнопку — откроется защищённая страница Т-Банка. Карта или СБП.",
    { reply_markup: { inline_keyboard: [
      [{ text: "Оплатить " + RU(price.total) + " ₽", url: j.url }],
      [{ text: "‹ Другой пакет", callback_data: "c:" + (st.iso || p.countries[0]) },
       { text: "📱 Мои eSIM", callback_data: "my" }],
      [{ text: "‹ В начало", callback_data: "home" }],
    ] } });
}

// ─────────────────────────── мои eSIM ───────────────────────────
// Показываем только то, что куплено из этого чата: так не нужно проверять,
// действительно ли человек владеет чужой почтой.
function myOrders(chatId) {
  const orders = readJson(path.join(DIR, "orders.json"), []);
  return orders.filter((o) => String(o.tgChatId || "") === String(chatId) && o.status === "done" && o.myUrl);
}
async function showMy(chatId) {
  const mine = myOrders(chatId);
  if (!mine.length) {
    const st = getState(chatId);
    return send(chatId,
      "Здесь появятся ваши eSIM после первой покупки." +
      (st.email ? "\n\nЕсли покупали на сайте, все ваши eSIM здесь: " + BASE_URL + "/esim/account" : ""),
      { reply_markup: homeKeyboard() });
  }
  const rows = mine.slice(0, 8).map((o) => [{ text: (o.label || "eSIM").slice(0, 60), callback_data: "m:" + o.id }]);
  rows.push([{ text: "＋ Купить ещё eSIM", callback_data: "home" }]);
  if (getState(chatId).productId) rows.push([{ text: "‹ Вернуться к оплате", callback_data: "back:pay" }]);
  return send(chatId, "<b>Ваши eSIM</b>\nВыберите, чтобы увидеть остаток трафика и QR-код.",
    { reply_markup: { inline_keyboard: rows } });
}
async function showMyOne(chatId, localId) {
  const o = myOrders(chatId).find((x) => x.id === localId);
  if (!o) return showMy(chatId);
  const u = new URL(o.myUrl);
  const j = await api("get", "/esim/api/my?o=" + encodeURIComponent(u.searchParams.get("o")) +
    "&t=" + encodeURIComponent(u.searchParams.get("t")));
  if (!j || !j.success) return send(chatId, "Не удалось получить остаток. Откройте страницу: " + o.myUrl);
  const packs = (j.usage && j.usage.packages) || [];
  const total = packs.reduce((a, x) => a + x.totalMb, 0);
  const left = packs.reduce((a, x) => a + x.remainingMb, 0);
  const gb = (mb) => (mb / 1024 >= 10 ? String(Math.round(mb / 1024)) : String(Math.round(mb / 102.4) / 10).replace(".", ",")) + " ГБ";
  let exp = null;
  packs.forEach((x) => { if (x.expiresAt && (!exp || new Date(x.expiresAt) > new Date(exp))) exp = x.expiresAt; });
  const text = "<b>" + esc(o.label || "eSIM") + "</b>\n\n" +
    (total ? "Осталось: <b>" + gb(left) + "</b> из " + gb(total) + "\n" : "Пакет ещё не активирован.\n") +
    (exp ? "Действует до: <b>" + new Date(exp).toLocaleDateString("ru-RU", { day: "numeric", month: "long" }) + "</b>\n" : "") +
    (packs.length && !packs.some((x) => x.activatedAt) ? "\n<i>Отсчёт срока начнётся, когда eSIM впервые выйдет в интернет.</i>" : "");
  const rows = [[{ text: "Открыть QR и продление", url: o.myUrl }], [{ text: "‹ Мои eSIM", callback_data: "my" }]];
  return send(chatId, text, { reply_markup: { inline_keyboard: rows } });
}

// ── почта для сайта: необязательная, только чтобы видеть eSIM ещё и в вебе ──
async function askMail(chatId) {
  const st = getState(chatId);
  setState(chatId, { step: "linkmail" });
  return send(chatId,
    "<b>Почта для сайта</b>\n\n" +
    "В боте всё и так работает: eSIM, остаток, QR. Почта нужна только если хотите видеть " +
    "свои eSIM ещё и на сайте voyotravel.ru — там же живут бонусы и приглашение друзей.\n\n" +
    (st.email ? "Сейчас привязана: <b>" + esc(st.email) + "</b>. Пришлите другую, если нужно поменять." :
      "Напишите вашу почту одним сообщением."));
}
async function linkMail(chatId, email) {
  const j = await api("post", "/esim/api/tg/link-email", { tgChatId: String(chatId), email }, {
    "X-Tg-Secret": crypto.createHash("sha256").update("tg:" + TOKEN).digest("hex").slice(0, 24),
  });
  if (!j || !j.success) return send(chatId, "Не получилось привязать почту, попробуйте позже.");
  const n = j.linked || 0;
  return send(chatId,
    "Готово. Почта <b>" + esc(email) + "</b> привязана" +
    (n ? ", и " + n + " " + plural(n, ["ваша eSIM теперь видна", "ваши eSIM теперь видны", "ваших eSIM теперь видны"]) + " на сайте." : "."),
    { reply_markup: { inline_keyboard: [
      [{ text: "Открыть кабинет на сайте", url: j.accountUrl }],
      [{ text: "📱 Мои eSIM", callback_data: "my" }],
    ] } });
}

// ─────────────────────────── обработка апдейтов ───────────────────────────
function esc(s) { return String(s == null ? "" : s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c])); }
function plural(n, forms) {
  const a = Math.abs(n) % 100, b = a % 10;
  if (a > 10 && a < 20) return forms[2];
  if (b > 1 && b < 5) return forms[1];
  if (b === 1) return forms[0];
  return forms[2];
}
const validEmail = (e) => /^[^@\s]+@[^@\s.]+\.[^@\s]{2,}$/.test(String(e || "").trim());

async function onText(chatId, text) {
  const t = String(text || "").trim();
  const st = getState(chatId);

  if (/^\/start/i.test(t)) {
    // Ссылка из рассылки: t.me/esimvoyo_bot?start=sms — скидка применится сама
    const payload = (t.split(/\s+/)[1] || "").toLowerCase();
    if (["sms", "email", "tg"].indexOf(payload) >= 0) {
      setState(chatId, { promo: UTM_PROMO, step: null });
      await send(chatId, "Ваша скидка по ссылке уже учтена — увидите её в цене пакета.");
    } else setState(chatId, { step: null });
    return showHome(chatId);
  }
  if (t === BTN_BUY) return showHome(chatId);
  if (t === BTN_MY || /^\/my|^мои/i.test(t)) return showMy(chatId);
  if (t === BTN_MAIL || /^\/email/i.test(t)) return askMail(chatId);
  if (t === BTN_HELP || /^\/help|^помощь/i.test(t)) {
    return send(chatId, "Напишите страну, и я покажу пакеты. Живой человек на связи здесь: " + SUPPORT_TG,
      { reply_markup: homeKeyboard() });
  }

  if (st.step === "linkmail") {
    if (!validEmail(t)) return send(chatId, "Похоже, в адресе опечатка. Напишите почту целиком, например ivan@mail.ru");
    setState(chatId, { email: t.toLowerCase(), step: null });
    return linkMail(chatId, t.toLowerCase());
  }
  if (st.step === "contact" || st.step === "email") {
    if (validEmail(t)) {
      setState(chatId, { email: t.toLowerCase(), step: null });
      return payLink(chatId);
    }
    if (/^[\d+][\d\s()-]{9,}$/.test(t)) {
      setState(chatId, { phone: t.replace(/[^\d+]/g, ""), step: null });
      return payLink(chatId);
    }
    // молчим и ждём нажатия кнопки — это не команда и не страна
  }

  // Промокод человек может просто прислать сообщением
  if (/^[A-Z0-9]{4,20}$/.test(t.toUpperCase()) && !/^\d+$/.test(t) && st.productId) {
    const j = await api("post", "/esim/api/price", { productId: st.productId, promo: t.toUpperCase(), email: st.email || "" });
    if (j && j.promoOk) {
      setState(chatId, { promo: t.toUpperCase() });
      await send(chatId, "Промокод принят: −" + RU(j.discountRub) + " ₽");
      return showPack(chatId, st.productId);
    }
  }

  // Иначе считаем, что это страна
  const c = await catalog();
  const hits = searchCountries(c.index, t);
  if (!hits.length) {
    return send(chatId, "Не нашёл такую страну. Попробуйте другое написание, откройте полный список или напишите нам: " + SUPPORT_TG,
      { reply_markup: homeKeyboard() });
  }
  if (hits.length === 1) return showCountry(chatId, hits[0].iso, 0);
  const rows = hits.slice(0, 8).map((x) => [{ text: flag(x.iso) + " " + x.name, callback_data: "c:" + x.iso }]);
  return send(chatId, "Уточните страну:", { reply_markup: { inline_keyboard: rows } });
}

async function onCallback(q) {
  const chatId = q.message && q.message.chat && q.message.chat.id;
  const messageId = q.message && q.message.message_id;
  const data = String(q.data || "");
  await answer(q.id);
  if (!chatId) return;
  if (data === "home") return edit(chatId, messageId, HELLO, { reply_markup: homeKeyboard() });
  if (data === "my") return showMy(chatId);
  if (data === "mail") return askMail(chatId);
  if (data.indexOf("all:") === 0) return showAllCountries(chatId, parseInt(data.slice(4), 10) || 0, messageId);
  if (data.indexOf("c:") === 0) {
    const parts = data.slice(2).split(":");
    return showCountry(chatId, parts[0], parseInt(parts[1] || "0", 10) || 0, messageId);
  }
  if (data.indexOf("p:") === 0) return showPack(chatId, data.slice(2), messageId);
  if (data.indexOf("buy:") === 0) return startBuy(chatId, data.slice(4));
  if (data.indexOf("m:") === 0) return showMyOne(chatId, data.slice(2));
  if (data === "back:pay") {
    const st = getState(chatId);
    if (!st.productId) return showHome(chatId);
    return (st.phone || st.email) ? payLink(chatId) : showPack(chatId, st.productId);
  }
}

// ─────────────────────────── выдача после оплаты ───────────────────────────
// Зовётся из esim.js, когда пакет уже куплен у поставщика.
async function onIssued(order) {
  if (!ready() || !order || !order.tgChatId) return;
  const chatId = order.tgChatId;
  const u = new URL(order.myUrl);
  const j = await api("get", "/esim/api/my?o=" + encodeURIComponent(u.searchParams.get("o")) +
    "&t=" + encodeURIComponent(u.searchParams.get("t")));
  const o = (j && j.order) || {};
  const caption = "<b>Ваша eSIM готова</b>\n" + esc(order.label || "") +
    "\n\nОтсканируйте QR-код на телефоне, куда ставите eSIM.";
  const sent = await sendQr(chatId, o.qrDataUrl, caption);
  const how =
    "<b>Как установить</b>\n" +
    "1. Настройки → Сотовая связь → Добавить eSIM → сканировать QR.\n" +
    "2. Сделайте это дома по Wi-Fi, до вылета.\n" +
    "3. В поездке включите «Роуминг данных» для линии eSIM — интернет заработает сам.\n\n" +
    (o.lpa ? "Если камеры под рукой нет, введите вручную:\n<code>" + esc(o.lpa) + "</code>\n\n" : "") +
    "Остаток трафика и продление — по кнопке ниже.";
  const st = getState(chatId);
  const rows = [
    [{ text: "Остаток и продление", url: order.myUrl }],
    [{ text: "📱 Мои eSIM", callback_data: "my" }, { text: "💬 Помощь", url: SUPPORT_TG }],
  ];
  if (!st.email) rows.push([{ text: "✉️ Привязать почту для сайта", callback_data: "mail" }]);
  await send(chatId, how, { reply_markup: { inline_keyboard: rows } });
  if (!sent) {
    await send(chatId, "QR-код картинкой отправить не удалось — откройте его здесь: " + order.myUrl);
  }
}

async function handleUpdate(upd) {
  try {
    if (upd.callback_query) return await onCallback(upd.callback_query);
    const msg = upd.message || upd.edited_message;
    if (msg && msg.contact && msg.chat) {
      const phone = String(msg.contact.phone_number || "").replace(/[^\d+]/g, "");
      setState(msg.chat.id, { phone, step: null });
      await send(msg.chat.id, "Номер получил, спасибо.", { reply_markup: mainKeyboard() });
      return await payLink(msg.chat.id);
    }
    if (msg && msg.chat && msg.text) return await onText(msg.chat.id, msg.text);
  } catch (e) { console.error("tgbot update:", e.message); }
}

// Вебхук нам не годится: Telegram до нашего сервера не достучится (проверено
// 10.09.2026 — «Connection timed out» на каждой попытке, блокировка работает в
// обе стороны). Поэтому забираем обновления сами длинным опросом через
// ретранслятор: канал наружу у нас есть.
let _polling = false;
async function pollLoop() {
  if (_polling) return;
  _polling = true;
  let offset = readJson(OFFSET_FILE, { offset: 0 }).offset || 0;
  console.log("tgbot: опрос запущен, продолжаем с обновления", offset);
  for (;;) {
    try {
      const ups = await tg("getUpdates", {
        offset, timeout: 25, allowed_updates: ["message", "callback_query"],
      });
      if (Array.isArray(ups) && ups.length) {
        for (const u of ups) {
          offset = Math.max(offset, (u.update_id || 0) + 1);
          await handleUpdate(u);
        }
        writeJson(OFFSET_FILE, { offset });
      } else if (ups === null) {
        await new Promise((r) => setTimeout(r, 5000));   // связи нет — не долбим
      }
    } catch (e) {
      console.error("tgbot опрос:", e.message);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}

// Напоминания: пакет заканчивается или гигабайты на исходе. Приходят прямо
// в чат — открываемость выше, чем у письма, а покупателю из бота письмо и
// слать некуда: почту мы у него не спрашиваем.
async function notifyUsage({ chatId, kind, label, left, total, days, canTopup, myUrl }) {
  if (!ready() || !chatId) return;
  const isData = kind === "lowData";
  const title = isData ? "Интернет почти закончился"
    : (days <= 0 ? "Пакет заканчивается сегодня"
                 : "Пакет заканчивается через " + days + " " + plural(days, ["день", "дня", "дней"]));
  const body = isData
    ? ("Осталось " + left + " из " + total + ". При активном интернете это меньше дня. " +
       (canTopup ? "Гигабайты добавятся на эту же eSIM, переустанавливать ничего не нужно."
                 : "На этом тарифе добавить трафик нельзя, но можно взять ещё один пакет."))
    : ((days <= 0 ? "Сегодня последний день действия пакета. "
                  : "Через " + days + " " + plural(days, ["день", "дня", "дней"]) + " пакет перестанет работать. ") +
       (canTopup ? "Продление продлит и срок, и трафик на этой же eSIM."
                 : "На этом тарифе продление недоступно — если поездка продолжается, возьмите новый пакет."));
  return send(chatId,
    "<b>" + esc(title) + "</b>\n" + esc(label || "") + "\n\n" + esc(body),
    { reply_markup: { inline_keyboard: [
      [{ text: canTopup ? "Продлить пакет" : "Купить ещё eSIM", url: myUrl }],
      [{ text: "📱 Мои eSIM", callback_data: "my" }, { text: "🌍 Другая страна", callback_data: "home" }],
    ] } });
}

// ─────────────────────────── подключение ───────────────────────────
function mount(app, opts) {
  if (!ready()) { console.log("tgbot: ESIM_TG_TOKEN не задан, бот выключен"); return { onIssued: () => {} }; }
  const hook = webhookPath();

  // Вебхук оставлен на случай, если однажды до нас начнут доходить запросы
  app.post(hook, require("express").json({ limit: "1mb" }), async (req, res) => {
    res.json({ ok: true });
    await handleUpdate(req.body || {});
  });

  setTimeout(async () => {
    await tg("deleteWebhook", { drop_pending_updates: false });
    pollLoop();
  }, 4000);

  console.log("tgbot: бот подключён" + (RELAY ? " (наружу через ретранслятор)" : " (напрямую)"));
  return { onIssued, notifyUsage };
}

module.exports = { mount, onIssued, notifyUsage, ready };
