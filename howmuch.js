/* «Хау мач?» — voyotravel.ru/howmuch
   Цена с заграничного ценника в рубли: наводишь камеру, приложение читает
   число прямо в браузере (Tesseract лежит рядом, наружу не ходит) и делит на
   курс. Страница целиком статическая и работает офлайн — из серверного тут
   только курс.

   Курс — официальный ЦБ РФ (cbr.ru/scripts/XML_daily.asp). Ходим за ним МЫ, а
   не страница: у человека телефон стоит в роуминге где-нибудь во Вьетнаме, и
   сайт ЦБ оттуда открывается не всегда. Разобранное держим час в памяти и
   дублируем на диск, чтобы рестарт приложения не оставил всех без курса.
   Курс ЦБ — это не курс обменника: в самом приложении можно вписать свой,
   и тогда он важнее нашего. */

const path = require("path");
const fs = require("fs");
const axios = require("axios");
const iconv = require("iconv-lite");

const DIR = path.join(__dirname, "public", "howmuch");
const STORE = path.join(__dirname, ".howmuchRates.json");
const TTL_MS = 60 * 60 * 1000;          // как часто ходим к ЦБ: он меняет курс раз в сутки
const STALE_OK_MS = 7 * 24 * 3600 * 1000; // просроченный курс отдаём до недели — лучше, чем ничего

let cache = null;   // {at, date, rates, src}
let inflight = null;

function loadStore() {
  try {
    const j = JSON.parse(fs.readFileSync(STORE, "utf8"));
    if (j && j.rates && Object.keys(j.rates).length) return j;
  } catch (e) { /* файла ещё нет — обычное дело на первом запуске */ }
  return null;
}
function saveStore(j) {
  try { fs.writeFileSync(STORE, JSON.stringify(j)); } catch (e) { console.log("howmuch: снимок курса не записался:", e.message); }
}

/* XML ЦБ: <Valute><CharCode>USD</CharCode><Nominal>1</Nominal><Value>82,3456</Value>.
   Нам нужно «сколько валюты за рубль» = Nominal / Value. */
function parseCbrXml(xml) {
  const out = {};
  const re = /<Valute[^>]*>([\s\S]*?)<\/Valute>/g;
  let m;
  while ((m = re.exec(xml))) {
    const b = m[1];
    const code = (/<CharCode>([A-Z]{3})<\/CharCode>/.exec(b) || [])[1];
    const nom = parseFloat(((/<Nominal>([\d\s.,]+)<\/Nominal>/.exec(b) || [])[1] || "").replace(",", ".").replace(/\s/g, ""));
    const val = parseFloat(((/<Value>([\d\s.,]+)<\/Value>/.exec(b) || [])[1] || "").replace(",", ".").replace(/\s/g, ""));
    if (code && nom > 0 && val > 0) out[code] = nom / val;
  }
  const date = (/<ValCurs[^>]*Date="([\d.]+)"/.exec(xml) || [])[1] || "";
  return { rates: out, date };
}

async function fromCbr() {
  const r = await axios.get("https://www.cbr.ru/scripts/XML_daily.asp", {
    responseType: "arraybuffer",
    timeout: 9000,
    headers: { "User-Agent": "voyotravel.ru/howmuch" }
  });
  // XML у ЦБ в windows-1251 — без перекодировки разваливаются даже цифры в атрибутах
  const xml = iconv.decode(Buffer.from(r.data), "win1251");
  const p = parseCbrXml(xml);
  if (Object.keys(p.rates).length < 10) throw new Error("ЦБ отдал подозрительно мало валют");
  return { rates: p.rates, date: p.date, src: "cbr" };
}

/* Зеркало ЦБ: тот же курс, но готовым JSON. Нужно на случай, когда сам cbr.ru
   не отвечает (у него бывают провалы по утрам в момент выкладки). */
async function fromMirror() {
  const r = await axios.get("https://www.cbr-xml-daily.ru/daily_json.js", { timeout: 9000 });
  const d = r.data || {};
  const out = {};
  Object.keys(d.Valute || {}).forEach((k) => {
    const v = d.Valute[k];
    if (v && v.Value > 0 && v.Nominal > 0 && v.CharCode) out[v.CharCode] = v.Nominal / v.Value;
  });
  if (Object.keys(out).length < 10) throw new Error("зеркало ЦБ отдало пусто");
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(d.Date || ""));
  return { rates: out, date: m ? m[3] + "." + m[2] + "." + m[1] : "", src: "cbr-mirror" };
}

async function refresh() {
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      return await fromCbr();
    } catch (e1) {
      console.log("howmuch: ЦБ не ответил (" + e1.message + "), пробую зеркало");
      return await fromMirror();
    }
  })()
    .then((fresh) => {
      cache = { at: Date.now(), date: fresh.date, rates: fresh.rates, src: fresh.src };
      saveStore(cache);
      return cache;
    })
    .catch((e) => {
      console.log("howmuch: курс не обновился:", e.message);
      return null;
    })
    .then((v) => { inflight = null; return v; });
  return inflight;
}

async function getRates() {
  if (!cache) cache = loadStore();
  const fresh = cache && Date.now() - cache.at < TTL_MS;
  if (fresh) return cache;
  // Протухший курс отдаём сразу и обновляем в фоне: человек стоит у ценника,
  // ждать ответа ЦБ ему незачем — курс всё равно меняется раз в сутки.
  if (cache && Date.now() - cache.at < STALE_OK_MS) { refresh(); return cache; }
  return (await refresh()) || cache;
}

function mount(app) {
  const express = require("express");

  // Без слеша на конце относительные адреса внутри страницы («ocr/…», «sw.js»)
  // ушли бы в корень сайта, а служебный работник получил бы чужую область.
  // Оба адреса ловит ОДИН маршрут: express по умолчанию не различает «/howmuch»
  // и «/howmuch/», и два отдельных маршрута свернулись бы в вечный редирект.
  app.get("/howmuch", (req, res) => {
    if (!/\/$/.test(req.path)) {
      const q = req.originalUrl.indexOf("?");
      return res.redirect(301, "/howmuch/" + (q === -1 ? "" : req.originalUrl.slice(q)));
    }
    res.set("Cache-Control", "no-store, no-cache, must-revalidate");
    res.sendFile(path.join(DIR, "index.html"));
  });

  app.get("/howmuch/rates", async (req, res) => {
    res.set("Cache-Control", "no-store");
    const r = await getRates();
    if (!r || !r.rates) return res.status(503).json({ ok: false, error: "курс ЦБ сейчас недоступен" });
    res.json({
      ok: true,
      src: r.src,                                  // cbr | cbr-mirror
      date: r.date,                                // дата, на которую ЦБ выставил курс
      at: r.at,                                    // когда мы его забрали
      stale: Date.now() - r.at > TTL_MS,
      rates: r.rates                               // единиц валюты за один рубль
    });
  });

  app.use("/howmuch", express.static(DIR, {
    // index.html и sw.js должны обновляться сразу, иначе правки доедут до
    // человека только после того, как он сам почистит кэш. Движок и шрифты,
    // наоборот, не меняются никогда — их держим год.
    setHeaders(res, file) {
      const name = path.basename(file);
      if (name === "index.html" || name === "sw.js" || name === "manifest.webmanifest") {
        // no-cache (а не no-store): браузер каждый раз переспрашивает сервер,
        // но файл ему доступен. no-store на sw.js ломает регистрацию
        // служебного работника в части браузеров.
        res.set("Cache-Control", "no-cache, max-age=0, must-revalidate");
      } else {
        res.set("Cache-Control", "public, max-age=31536000, immutable");
      }
    }
  }));

  // Первый заход не должен ждать ЦБ: прогреваем курс сразу после старта.
  setTimeout(() => { getRates().catch(() => {}); }, 4000);
}

module.exports = { mount, getRates };
