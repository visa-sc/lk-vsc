// ─────────────────────────────────────────────────────────────────────────
// Откуда пришёл клиент: разбор рекламных меток (14.09.2026).
//
// Браузер на посадочной запоминает метки перехода (gclid, utm_*, yclid…) и
// кладёт их в localStorage и в куку voyo_ads: «первый заход» и «последний
// заход». При оплате или заявке метки уходят на сервер вместе с заказом.
// Раньше заказы источника не хранили вовсе, и продажу с Google находили
// только по логам nginx, которые живут две недели.
//
// Общий модуль: им пользуются eSIM (esim.js), журнал переходов visa-sc.com
// (vscom.js) и отчёт tools/adsReport.js — чтобы источник везде назывался
// одинаково.
// ─────────────────────────────────────────────────────────────────────────

const KEYS = [
  "gclid", "gbraid", "wbraid", "gad_source", "gad_campaignid",
  "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content",
  "yclid", "fbclid",
];

// Один «заход»: только известные поля, всё обрезано по длине
function cleanTouch(t) {
  if (!t || typeof t !== "object") return null;
  const o = {};
  KEYS.forEach((k) => { if (t[k]) o[k] = String(t[k]).slice(0, 200); });
  if (t.ref) o.ref = String(t.ref).slice(0, 300);
  if (t.landing) o.landing = String(t.landing).slice(0, 300);
  const at = Number(t.at);
  if (at > 1.7e12 && at < Date.now() + 864e5) o.at = at;
  return Object.keys(o).length ? o : null;
}

function cleanAds(a) {
  if (!a || typeof a !== "object") return null;
  const out = {};
  const first = cleanTouch(a.first), last = cleanTouch(a.last);
  if (first) out.first = first;
  if (last) out.last = last;
  if (a.embed) out.embed = true;
  return Object.keys(out).length ? out : null;
}

// Метки из тела запроса, а если браузер их не прислал — из куки voyo_ads
function readAds(req, body) {
  let a = body && body.ads;
  if (!a) {
    const raw = String((req && req.headers && req.headers.cookie) || "");
    const m = /(?:^|;\s*)voyo_ads=([^;]+)/.exec(raw);
    if (m) { try { a = JSON.parse(decodeURIComponent(m[1])); } catch (_) { a = null; } }
  }
  return cleanAds(a);
}

function mskTime(ts) {
  const d = new Date(Number(ts) + 3 * 3600 * 1000);
  const p = (n) => String(n).padStart(2, "0");
  return p(d.getUTCDate()) + "." + p(d.getUTCMonth() + 1) + " " + p(d.getUTCHours()) + ":" + p(d.getUTCMinutes());
}

function isGoogleAds(t) { return !!(t && (t.gclid || t.gbraid || t.wbraid || t.gad_source)); }

// Короткое человеческое название канала: «Google Ads», «Яндекс Директ»…
function channel(t) {
  if (!t) return "не определён";
  if (isGoogleAds(t)) return "Google Ads";
  if (t.yclid || /yandex|direct/i.test(t.utm_source || "")) return "Яндекс Директ";
  if (t.fbclid) return "Facebook/Instagram";
  if (t.utm_source) return "метка " + t.utm_source;
  if (t.ref) {
    let host = t.ref;
    try { host = new URL(t.ref).hostname.replace(/^www\./, ""); } catch (_) {}
    if (/googleadservices\.com$|doubleclick\.net$/.test(host)) return "Google Ads";
    if (/google\./.test(host)) return "поиск Google (без рекламы)";
    if (/yandex\./.test(host)) return "поиск Яндекса (без рекламы)";
    return "переход с " + host;
  }
  return "прямой заход";
}

function describeTouch(t) {
  if (!t) return "не определён";
  let s = channel(t);
  if (isGoogleAds(t) && t.utm_medium === "display") s += " · КМС";
  if (isGoogleAds(t) && t.gad_campaignid) s += ", кампания " + t.gad_campaignid;
  if (t.utm_campaign && !isGoogleAds(t)) s += ", кампания " + t.utm_campaign;
  if (t.utm_term) s += ", запрос «" + t.utm_term + "»";
  if (t.at) s += ", " + mskTime(t.at) + " МСК";
  return s;
}

// Строка для писем: последний заход решает, первый — если отличается
function describeAds(ads) {
  if (!ads) return "не определён (прямой заход или браузер не сохранил метки)";
  if (ads.embed && !ads.last) return "личный кабинет VOYO";
  const last = ads.last || ads.first;
  let s = describeTouch(last);
  if (ads.first && ads.last && channel(ads.first) !== channel(ads.last)) {
    s += " · первый заход: " + describeTouch(ads.first);
  }
  return s;
}

function gclidOf(ads) {
  const t = ads && (isGoogleAds(ads.last) ? ads.last : isGoogleAds(ads.first) ? ads.first : null);
  return t ? (t.gclid || t.gbraid || t.wbraid || "") : "";
}

module.exports = { KEYS, cleanTouch, cleanAds, readAds, channel, describeTouch, describeAds, isGoogleAds, gclidOf, mskTime };
