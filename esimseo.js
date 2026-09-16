// ═══════════════════════════════════════════════════════════════════════════
// Страницы направлений под поиск: /esim/turkey, /esim/uae и так далее.
//
// Зачем: у Airalo под каждую страну своя посадочная, и они собирают весь
// трафик по запросам «eSIM Турция». Нам нужно то же самое, только по-русски
// и с живыми ценами.
//
// Как устроено: текст статьи лежит в esim-articles.json (пишется руками —
// штампованные тексты поиск не любит), а цены, число пакетов и покрытие
// подставляются из боевого каталога. Страница рендерится на сервере целиком,
// чтобы робот видел текст без выполнения скриптов.
// ═══════════════════════════════════════════════════════════════════════════
const fs = require("fs");
const path = require("path");
const axios = require("axios");

// Статьи разложены по файлам, чтобы каждый оставался обозримым при правке
const ARTICLES = Object.assign({},
  require("./esim-articles.json"), require("./esim-articles-2.json"), require("./esim-articles-3.json"));
// Инструкции и сравнения: другой шаблон, другие запросы, но тот же раздел
const GUIDES = require("./esim-guides.json");
const SELF = process.env.ESIM_SELF_BASE || "http://127.0.0.1:3000";
const BASE_URL = process.env.ESIM_BASE_URL || "https://voyotravel.ru";
const BOT = "https://t.me/" + (process.env.ESIM_TG_USERNAME || "esimvoyo_bot");

const STYLE = `<style>
  :root{--bg:#f5f7fb;--card:#fff;--line:#e6eaf2;--ink:#16202e;--mut:#8b93a5;--accent:#3589bd;
    --grad:linear-gradient(135deg,#2c6f96 0%,#3d95c7 55%,#5ac8fa 120%);
    --sh:0 1px 2px rgba(16,24,40,.04),0 18px 44px -22px rgba(22,48,80,.22);}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--ink);
    font-family:-apple-system,BlinkMacSystemFont,"SF Pro Display","SF Pro Text","Segoe UI",Roboto,Helvetica,Arial,sans-serif;
    -webkit-font-smoothing:antialiased;line-height:1.62;font-size:16.5px;}
  .wrap{max-width:760px;margin:0 auto;padding:0 18px 70px;}
  .hdr{display:flex;align-items:center;justify-content:space-between;padding:22px 0 8px;}
  .brand{display:flex;flex-direction:column;text-decoration:none;line-height:1;}
  .brandrow{display:flex;align-items:center;gap:9px;}
  .brandrow img{height:19px;display:block;}
  .wm{font-size:20px;font-weight:300;letter-spacing:.01em;background:var(--grad);
    -webkit-background-clip:text;background-clip:text;color:transparent;}
  .byvsc{font-size:10.5px;color:var(--mut);letter-spacing:.02em;margin-top:3px;align-self:flex-end;margin-right:2px;}
  .byvsc b{color:var(--accent);font-weight:700;}
  .mine{font-size:13.5px;color:var(--mut);text-decoration:none;border:1px solid var(--line);
    border-radius:999px;padding:8px 14px;background:rgba(255,255,255,.7);}
  h1{font-size:clamp(28px,6vw,40px);line-height:1.1;letter-spacing:-.03em;margin:18px 0 10px;}
  .lead{font-size:18px;color:#41506a;margin:0 0 22px;}
  h2{font-size:clamp(21px,3.6vw,26px);letter-spacing:-.02em;margin:34px 0 10px;}
  h3{font-size:17px;margin:20px 0 6px;}
  p{margin:0 0 14px;}
  .cta{display:flex;gap:10px;flex-wrap:wrap;margin:22px 0 8px;}
  .btn{display:inline-block;text-decoration:none;font-weight:700;font-size:16px;padding:15px 26px;
    border-radius:15px;background:var(--grad);color:#fff;box-shadow:0 12px 28px -12px rgba(53,137,189,.85);}
  .btn.sec{background:#fff;color:var(--accent);border:1px solid var(--line);box-shadow:var(--sh);}
  .price{background:var(--card);border:1px solid var(--line);border-radius:22px;box-shadow:var(--sh);
    padding:8px 20px 6px;margin:22px 0 10px;overflow-x:auto;}
  table{width:100%;border-collapse:collapse;font-size:15.5px;}
  th{text-align:left;font-size:11.5px;text-transform:uppercase;letter-spacing:.05em;color:var(--mut);
    padding:14px 10px 8px 0;font-weight:700;border-bottom:1px solid var(--line);white-space:nowrap;}
  td{padding:12px 10px 12px 0;border-bottom:1px solid #f0f3f8;white-space:nowrap;}
  tr:last-child td{border-bottom:0;}
  td.p,th.p{text-align:right;padding-right:0;font-weight:700;}
  .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:12px;margin:16px 0 6px;}
  .c{background:var(--card);border:1px solid var(--line);border-radius:18px;padding:16px 18px;box-shadow:var(--sh);}
  .c b{display:block;margin-bottom:5px;font-size:15.5px;}
  .c span{font-size:14px;color:#54607a;}
  details{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:14px 18px;margin-bottom:9px;box-shadow:var(--sh);}
  summary{cursor:pointer;font-weight:600;font-size:16px;list-style:none;}
  summary::-webkit-details-marker{display:none}
  summary::after{content:"+";float:right;color:var(--mut);font-weight:400;}
  details[open] summary::after{content:"–";}
  .a{margin-top:9px;font-size:15.5px;color:#41506a;}
  .steps{counter-reset:s;padding:0;margin:14px 0 6px;list-style:none;}
  .steps li{counter-increment:s;position:relative;padding-left:40px;margin-bottom:12px;}
  .steps li::before{content:counter(s);position:absolute;left:0;top:0;width:27px;height:27px;border-radius:9px;
    background:var(--grad);color:#fff;font-weight:700;font-size:14px;display:flex;align-items:center;justify-content:center;}
  .others{display:flex;flex-wrap:wrap;gap:8px;margin:14px 0 0;}
  .others a{text-decoration:none;font-size:14.5px;color:#41506a;background:var(--card);border:1px solid var(--line);
    border-radius:999px;padding:8px 14px;box-shadow:var(--sh);}
  .foot{margin-top:44px;padding-top:18px;border-top:1px solid var(--line);font-size:13px;color:var(--mut);}
  .foot a{color:var(--accent);}
</style>`;

const RU = (n) => Math.round(Number(n) || 0).toLocaleString("ru-RU");
function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}
function plural(n, forms) {
  const a = Math.abs(n) % 100, b = a % 10;
  if (a > 10 && a < 20) return forms[2];
  if (b > 1 && b < 5) return forms[1];
  if (b === 1) return forms[0];
  return forms[2];
}

// Каталог тянем у себя же и держим полчаса: цены меняются раз в сутки, а
// страницы должны отдаваться мгновенно.
let _cat = { ts: 0, products: [] };
async function catalog() {
  if (Date.now() - _cat.ts < 30 * 60 * 1000 && _cat.products.length) return _cat.products;
  try {
    const r = await axios.get(SELF + "/esim/api/catalog", { timeout: 30000 });
    if (r.data && r.data.success) _cat = { ts: Date.now(), products: r.data.products };
  } catch (e) { console.error("esimseo каталог:", e.message); }
  return _cat.products;
}

// Витрина страны: самые дешёвые пакеты на 1/3/5/10/20 ГБ — по одному на объём,
// чтобы таблица была короткой и понятной, а не списком из 80 строк.
function pickPackages(products, iso) {
  const mine = products.filter((p) => (p.countries || []).indexOf(iso) >= 0);
  const byVol = new Map();
  mine.forEach((p) => {
    const key = p.unlimited ? "inf" : Math.round(Number(p.dataGb) || 0);
    const prev = byVol.get(key);
    if (!prev || p.priceRub < prev.priceRub) byVol.set(key, p);
  });
  const rows = Array.from(byVol.values())
    .sort((a, b) => (a.unlimited ? 1e6 : a.dataGb) - (b.unlimited ? 1e6 : b.dataGb))
    .filter((p) => p.unlimited || p.dataGb >= 1);
  const want = [1, 3, 5, 10, 20, 50];
  const out = [];
  want.forEach((v) => {
    const hit = rows.find((p) => !p.unlimited && Math.round(p.dataGb) === v);
    if (hit) out.push(hit);
  });
  const inf = rows.find((p) => p.unlimited);
  if (inf) out.push(inf);
  return { all: mine, rows: out.slice(0, 6), min: mine.length ? Math.min(...mine.map((p) => p.priceRub)) : 0 };
}

// К «информационным» запросам обязательно добавляем коммерческие: купить,
// цена, оформить, онлайн. Именно по ним приходит человек с деньгами, а не
// с любопытством.
function commercialKeys(a) {
  const n = a.nameNom.toLowerCase();
  return [
    "купить esim " + n, "esim " + n + " цена", "оформить esim " + n,
    "esim " + n + " купить онлайн", "есим " + n + " купить", "esim " + n + " стоимость",
  ].join(", ");
}

function page(slug, a, data) {
  const url = BASE_URL + "/esim/" + slug;
  const title = a.title.replace("{minPrice}", RU(data.min));
  const desc = a.description.replace("{minPrice}", RU(data.min));
  const rows = data.rows.map((p) => {
    const vol = p.unlimited ? "Безлимит" : RU(p.dataGb) + " ГБ";
    const extra = p.countries.length > 1 ? p.countries.length + " " + plural(p.countries.length, ["страна", "страны", "стран"]) : "только " + a.nameNom;
    return '<tr><td><b>' + vol + "</b></td><td>" + RU(p.days) + " дн.</td><td>" + esc(extra) +
      "</td><td class=\"p\">" + RU(p.priceRub) + " ₽</td></tr>";
  }).join("");

  const faq = a.faq.map(([q, ans]) =>
    '<details><summary>' + esc(q) + "</summary><div class=\"a\">" + esc(ans) + "</div></details>").join("");

  const faqLd = {
    "@context": "https://schema.org", "@type": "FAQPage",
    mainEntity: a.faq.map(([q, ans]) => ({
      "@type": "Question", name: q,
      acceptedAnswer: { "@type": "Answer", text: ans },
    })),
  };
  const productLd = {
    "@context": "https://schema.org", "@type": "Product",
    name: "eSIM для " + a.name, description: desc,
    brand: { "@type": "Brand", name: "VOYO mobile" },
    offers: { "@type": "AggregateOffer", priceCurrency: "RUB", lowPrice: data.min,
      offerCount: data.all.length, availability: "https://schema.org/InStock", url },
  };

  const others = Object.keys(ARTICLES).filter((s) => s !== slug)
    .map((s) => '<a href="/esim/' + s + '">' + ARTICLES[s].flag + " " + esc(ARTICLES[s].nameNom) + "</a>").join("");

  return `<!DOCTYPE html>
<html lang="ru"><head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}" />
<meta name="keywords" content="${esc(a.keywords + ", " + commercialKeys(a))}" />
<link rel="canonical" href="${url}" />
<meta property="og:type" content="article" />
<meta property="og:title" content="${esc(title)}" />
<meta property="og:description" content="${esc(desc)}" />
<meta property="og:url" content="${url}" />
<meta property="og:site_name" content="VOYO mobile" />
<link rel="apple-touch-icon" href="/apple-touch-icon.png" />
<link rel="icon" type="image/png" href="/apple-touch-icon.png" />
<script type="application/ld+json">${JSON.stringify(faqLd)}</script>
<script type="application/ld+json">${JSON.stringify(productLd)}</script>
${STYLE}</head><body>
<div class="wrap">

  <div class="hdr">
    <a class="brand" href="/esim">
      <span class="brandrow"><img src="/voyo-logo.png" alt="VOYO" /><span class="wm">mobile</span></span>
      <span class="byvsc">by <b>VSC</b></span>
    </a>
    <a class="mine" href="/esim/account">Мои eSIM</a>
  </div>

  <h1>${a.flag} ${esc(a.h1)}</h1>
  <p class="lead">${esc(a.lead)}</p>

  <div class="cta">
    <a class="btn" href="/esim?c=${a.iso}">Выбрать пакет от ${RU(data.min)} ₽</a>
    <a class="btn sec" href="${BOT}">Купить в телеграме</a>
  </div>

  ${a.intro.map((t) => "<p>" + esc(t) + "</p>").join("\n  ")}

  <h2>Сколько стоит eSIM для ${esc(a.name)}</h2>
  <div class="price">
    <table>
      <tr><th>Интернет</th><th>Срок</th><th>Покрытие</th><th class="p">Цена</th></tr>
      ${rows}
    </table>
  </div>
  <p style="font-size:14px;color:#54607a">Всего доступно ${data.all.length} ${plural(data.all.length, ["пакет", "пакета", "пакетов"])} для ${esc(a.name)}.
  Цены окончательные, в рублях, комиссий сверху нет. Обновляются вместе с курсом ЦБ.</p>

  <h2>Почему eSIM, а не роуминг и не местная симка</h2>
  <div class="grid">
    ${a.whyBlocks.map(([t, d]) => '<div class="c"><b>' + esc(t) + "</b><span>" + esc(d) + "</span></div>").join("\n    ")}
  </div>

  <h2>Сколько гигабайтов брать</h2>
  <p>${esc(a.howMuch)}</p>

  <h2>Какие сети ловит</h2>
  <p>${esc(a.coverage)}</p>

  <h2>Как установить eSIM</h2>
  <ol class="steps">
    <li><b>Выберите пакет и оплатите</b> картой российского банка или через СБП. QR-код придёт сразу после оплаты — на страницу и на почту.</li>
    <li><b>Отсканируйте QR дома по Wi-Fi:</b> Настройки → Сотовая связь → Добавить eSIM → сканировать код. Занимает минуту.</li>
    <li><b>В поездке включите «Роуминг данных»</b> для линии eSIM. Это обязательный шаг: без него пакет не активируется.</li>
    <li><b>Готово.</b> Основная симка остаётся для звонков и SMS, интернет идёт через eSIM.</li>
  </ol>

  <div class="cta">
    <a class="btn" href="/esim?c=${a.iso}">Купить eSIM для ${esc(a.name)}</a>
    <a class="btn sec" href="${BOT}">Оформить в телеграме</a>
  </div>

  <h2>Частые вопросы</h2>
  ${faq}

  <h2>eSIM для других направлений</h2>
  <div class="others">${others}</div>

  <h2>Полезное перед поездкой</h2>
  <div class="others">${guideLinks(slug)}</div>

  <div class="foot">
    VOYO mobile — сервис компании VOYO (ООО «ЭЙ КЕЙ ГРУПП»). Интернет в поездке без роуминга:
    <a href="/esim">все страны и пакеты</a> · <a href="/esim/account">мои eSIM</a> · <a href="${BOT}">телеграм-бот</a>
  </div>
</div>
</body></html>`;
}

function guideLinks(skip) {
  return Object.keys(GUIDES).filter((g) => g !== skip)
    .map((g) => '<a href="/esim/' + g + '">' + esc(GUIDES[g].h1) + "</a>").join("");
}

function guidePage(slug, g, minPrice) {
  const url = BASE_URL + "/esim/" + slug;
  const body = g.blocks.map((b) => {
    let h = "<h2>" + esc(b.h2) + "</h2>";
    if (b.p) h += b.p.map((t) => "<p>" + esc(t) + "</p>").join("");
    if (b.list) h += "<ul>" + b.list.map((t) => "<li>" + esc(t) + "</li>").join("") + "</ul>";
    if (b.steps) h += '<ol class="steps">' + b.steps.map((t) => "<li>" + esc(t) + "</li>").join("") + "</ol>";
    return h;
  }).join("\n  ");

  const faq = g.faq.map(([q, ans]) =>
    "<details><summary>" + esc(q) + '</summary><div class="a">' + esc(ans) + "</div></details>").join("");
  const faqLd = {
    "@context": "https://schema.org", "@type": "FAQPage",
    mainEntity: g.faq.map(([q, ans]) => ({ "@type": "Question", name: q,
      acceptedAnswer: { "@type": "Answer", text: ans } })),
  };
  const howLd = {
    "@context": "https://schema.org", "@type": "Article", headline: g.h1,
    description: g.description, inLanguage: "ru-RU",
    publisher: { "@type": "Organization", name: "VOYO mobile" }, mainEntityOfPage: url,
  };
  const countries = Object.keys(ARTICLES).slice(0, 12)
    .map((s) => '<a href="/esim/' + s + '">' + ARTICLES[s].flag + " " + esc(ARTICLES[s].nameNom) + "</a>").join("");

  return `<!DOCTYPE html>
<html lang="ru"><head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${esc(g.title)}</title>
<meta name="description" content="${esc(g.description)}" />
<meta name="keywords" content="${esc(g.keywords)}" />
<link rel="canonical" href="${url}" />
<meta property="og:type" content="article" />
<meta property="og:title" content="${esc(g.title)}" />
<meta property="og:description" content="${esc(g.description)}" />
<meta property="og:url" content="${url}" />
<meta property="og:site_name" content="VOYO mobile" />
<link rel="apple-touch-icon" href="/apple-touch-icon.png" />
<link rel="icon" type="image/png" href="/apple-touch-icon.png" />
<script type="application/ld+json">${JSON.stringify(faqLd)}</script>
<script type="application/ld+json">${JSON.stringify(howLd)}</script>
${STYLE}
</head><body>
<div class="wrap">
  <div class="hdr">
    <a class="brand" href="/esim">
      <span class="brandrow"><img src="/voyo-logo.png" alt="VOYO" /><span class="wm">mobile</span></span>
      <span class="byvsc">by <b>VSC</b></span>
    </a>
    <a class="mine" href="/esim/account">Мои eSIM</a>
  </div>

  <h1>${esc(g.h1)}</h1>
  <p class="lead">${esc(g.lead)}</p>

  <div class="cta">
    <a class="btn" href="/esim">Купить eSIM от ${RU(minPrice)} ₽</a>
    <a class="btn sec" href="${BOT}">Оформить в телеграме</a>
  </div>

  ${body}

  <div class="cta">
    <a class="btn" href="/esim">Выбрать пакет от ${RU(minPrice)} ₽</a>
  </div>

  <h2>Частые вопросы</h2>
  ${faq}

  <h2>Популярные направления</h2>
  <div class="others">${countries}</div>

  <h2>Другие инструкции</h2>
  <div class="others">${guideLinks(slug)}</div>

  <div class="foot">
    VOYO mobile — сервис компании VOYO (ООО «ЭЙ КЕЙ ГРУПП»).
    <a href="/esim">Все страны и пакеты</a> · <a href="/esim/account">мои eSIM</a> · <a href="${BOT}">телеграм-бот</a>
  </div>
</div>
</body></html>`;
}


// ═══════════════════════════════════════════════════════════════════════════
// Рекламные посадочные: /esim/internet-turkey и /esim/internet-china (16.09.2026)
//
// Отдельно от SEO-страниц: там длинная статья под поиск, здесь короткая
// страница под платный клик — цена в заголовке, кнопка в первом экране,
// четыре пакета, три шага установки. Индексацию закрываем, чтобы страницы не
// конкурировали с /esim/turkey и /esim/china в поиске.
//
// Счётчики те же, что на витрине, и клик по кнопке шлёт цель esim_cta:
// в Метрике и Google Ads видно, сколько человек дошли до выбора пакета.
// Рекламные метки (gclid, utm) переносим на витрину как есть, иначе источник
// продажи потеряется.
// ═══════════════════════════════════════════════════════════════════════════
const ADS = {
  "internet-turkey": {
    iso: "TR", flag: "🇹🇷", country: "Турции", countryNom: "Турция",
    h1: "Интернет в Турции за минуту",
    lead: "eSIM для телефона от {minPrice} ₽. Ставится дома по Wi-Fi за минуту, в поездке интернет включается сам. Роуминг отключать не нужно, местную симку покупать тоже.",
    bullets: [
      ["Включается за минуту", "Отсканировали QR-код — линия готова. Ничего не ждём, в салон связи идти не нужно."],
      ["Цена окончательная", "Платите в рублях российской картой или через СБП. Ни доплат за подключение, ни комиссий."],
      ["Номер остаётся ваш", "Основная симка работает для звонков и SMS, интернет идёт через eSIM."],
    ],
    faq: [
      ["Телефон подойдёт?", "Подойдёт любой iPhone с XR и новее, Samsung с S20, Pixel с 3-го и большинство современных Android. Проверить просто: Настройки → Сотовая связь → есть пункт «Добавить eSIM»."],
      ["Когда начнётся отсчёт дней?", "С первого выхода в интернет в поездке. Купить и установить можно заранее, дома."],
      ["Что с WhatsApp и Telegram?", "Работают как обычно, ваш номер остаётся на основной симке."],
      ["А если не хватит трафика?", "Возьмёте ещё один пакет в личном кабинете, он появится там же, где QR-код."],
    ],
  },
  "internet-china": {
    iso: "CN", flag: "🇨🇳", country: "Китае", countryNom: "Китай",
    h1: "Интернет в Китае за минуту",
    lead: "eSIM для телефона от {minPrice} ₽. Ставится дома по Wi-Fi за минуту, в поездке интернет включается сам. Google, WhatsApp и Telegram работают без VPN.",
    bullets: [
      ["Без VPN", "Трафик выходит в интернет за пределами Китая, поэтому привычные сервисы открываются сразу. Есть пакеты, на которых работают ChatGPT и TikTok."],
      ["Включается за минуту", "Отсканировали QR-код — линия готова. Ничего не ждём, в салон связи идти не нужно."],
      ["Цена окончательная", "Платите в рублях российской картой или через СБП. Ни доплат за подключение, ни комиссий."],
    ],
    faq: [
      ["Точно ли работает Google и мессенджеры?", "Да. Интернет идёт через зарубежную сеть, местные ограничения на неё не действуют. На пакетах с пометкой про ChatGPT открывается и он."],
      ["Телефон подойдёт?", "Подойдёт любой iPhone с XR и новее, Samsung с S20, Pixel с 3-го и большинство современных Android. Проверить просто: Настройки → Сотовая связь → есть пункт «Добавить eSIM»."],
      ["Когда начнётся отсчёт дней?", "С первого выхода в интернет в поездке. Купить и установить можно заранее, дома."],
      ["А если не хватит трафика?", "Возьмёте ещё один пакет в личном кабинете, он появится там же, где QR-код."],
    ],
  },
};

// Счётчики: те же, что на витрине, плюс цель по клику на кнопку
const ADS_TAGS = `<script>
   (function(m,e,t,r,i,k,a){m[i]=m[i]||function(){(m[i].a=m[i].a||[]).push(arguments)};m[i].l=1*new Date();
    for (var j = 0; j < document.scripts.length; j++) {if (document.scripts[j].src === r) { return; }}
    k=e.createElement(t),a=e.getElementsByTagName(t)[0],k.async=1,k.src=r,a.parentNode.insertBefore(k,a)})
   (window, document,'script','https://mc.yandex.ru/metrika/tag.js?id=109614823', 'ym');
   ym(109614823, 'init', {ssr:true, webvisor:false, clickmap:true, trackLinks:true, accurateTrackBounce:true});
</script>
<noscript><div><img src="https://mc.yandex.ru/watch/109614823" style="position:absolute; left:-9999px;" alt="" /></div></noscript>
<script async src="https://www.googletagmanager.com/gtag/js?id=AW-18409333270"></script>
<script>
  window.dataLayer = window.dataLayer || [];
  function gtag(){dataLayer.push(arguments);}
  gtag('js', new Date());
  gtag('config', 'AW-18409333270');
</script>`;

const ADS_SCRIPT = `<script>
(function(){
  // рекламные метки переносим на витрину, иначе продажа потеряет источник
  var q = location.search || "";
  document.querySelectorAll("a.btn").forEach(function(a){
    if(a.href.indexOf("/esim") < 0 || a.href.indexOf("t.me") >= 0) return;
    if(q) a.href += (a.href.indexOf("?") >= 0 ? "&" : "?") + q.slice(1);
    a.addEventListener("click", function(){
      try{ if(typeof ym==="function") ym(109614823,"reachGoal","esim_cta"); }catch(e){}
      try{ if(typeof gtag==="function") gtag("event","esim_cta"); }catch(e){}
    });
  });
})();
</script>`;

function adsPage(slug, a, data) {
  const min = RU(data.min);
  const lead = a.lead.replace("{minPrice}", min);
  const title = "Интернет в " + a.country + " за минуту — eSIM от " + min + " ₽ | VOYO mobile";
  const cards = data.rows.slice(0, 4).map((p) => {
    const vol = p.unlimited ? "Безлимит" : (RU(p.dataGb) + (p.daily ? " ГБ в день" : " ГБ"));
    return '<div class="c"><b>' + esc(vol) + "</b><span>" + RU(p.days) + " " + plural(p.days, ["день", "дня", "дней"]) +
      " · <b style=\"color:#16202e\">" + RU(p.priceRub) + " ₽</b></span></div>";
  }).join("\n    ");
  return `<!DOCTYPE html><html lang="ru"><head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex, follow" />
<title>${esc(title)}</title>
<meta name="description" content="${esc(lead)}" />
<link rel="apple-touch-icon" href="/apple-touch-icon.png" />
<link rel="icon" type="image/png" href="/apple-touch-icon.png" />
${ADS_TAGS}
${STYLE}
</head><body>
<div class="wrap">
  <div class="hdr">
    <a class="brand" href="/esim">
      <span class="brandrow"><img src="/voyo-logo.png" alt="VOYO" /><span class="wm">mobile</span></span>
      <span class="byvsc">by <b>VSC</b></span>
    </a>
    <a class="mine" href="/esim/account">Мои eSIM</a>
  </div>

  <h1>${a.flag} ${esc(a.h1)}</h1>
  <p class="lead">${esc(lead)}</p>

  <div class="cta">
    <a class="btn" href="/esim?c=${a.iso}">Выбрать пакет от ${min} ₽</a>
    <a class="btn sec" href="${BOT}">Купить в телеграме</a>
  </div>

  <div class="grid">
    ${a.bullets.map(([t, d]) => '<div class="c"><b>' + esc(t) + "</b><span>" + esc(d) + "</span></div>").join("\n    ")}
  </div>

  <h2>Сколько стоит</h2>
  <div class="grid">
    ${cards}
  </div>
  <p style="font-size:14px;color:#54607a">Всего ${data.all.length} ${plural(data.all.length, ["пакет", "пакета", "пакетов"])} для ${esc(a.countryNom)}: от суточных до 50 ГБ. Чем больше пакет, тем дешевле гигабайт.</p>

  <h2>Как это работает</h2>
  <ol class="steps">
    <li><b>Выбираете пакет и платите</b> картой или через СБП. QR-код приходит сразу, на страницу и на почту.</li>
    <li><b>Сканируете QR дома по Wi-Fi:</b> Настройки → Сотовая связь → Добавить eSIM. Минута.</li>
    <li><b>В поездке включаете «Роуминг данных»</b> для линии eSIM, и интернет работает.</li>
  </ol>

  <div class="cta">
    <a class="btn" href="/esim?c=${a.iso}">Купить eSIM для ${esc(a.countryNom === "Китай" ? "Китая" : "Турции")}</a>
    <a class="btn sec" href="${BOT}">Оформить в телеграме</a>
  </div>

  <h2>Частые вопросы</h2>
  ${a.faq.map(([q, ans]) => "<details><summary>" + esc(q) + '</summary><div class="a">' + esc(ans) + "</div></details>").join("\n  ")}

  <div class="foot">
    VOYO mobile — сервис компании VOYO (ООО «ЭЙ КЕЙ ГРУПП»). Интернет в поездке без роуминга:
    <a href="/esim">все страны и пакеты</a> · <a href="/esim/account">мои eSIM</a> · <a href="${BOT}">телеграм-бот</a>
  </div>
</div>
${ADS_SCRIPT}
</body></html>`;
}

function mount(app) {
  const slugs = Object.keys(ARTICLES);
  const guideSlugs = Object.keys(GUIDES);

  guideSlugs.forEach((slug) => {
    app.get("/esim/" + slug, async (req, res) => {
      const products = await catalog();
      const min = products.length ? Math.min(...products.map((p) => p.priceRub)) : 590;
      res.set("Cache-Control", "public, max-age=1800");
      res.type("html").send(guidePage(slug, GUIDES[slug], min));
    });
  });

  slugs.forEach((slug) => {
    app.get("/esim/" + slug, async (req, res) => {
      const a = ARTICLES[slug];
      const products = await catalog();
      const data = pickPackages(products, a.iso);
      if (!data.all.length) return res.redirect(302, "/esim");
      res.set("Cache-Control", "public, max-age=1800");
      res.type("html").send(page(slug, a, data));
    });
  });

  // Рекламные посадочные — вне карты сайта и с noindex
  Object.keys(ADS).forEach((slug) => {
    app.get("/esim/" + slug, async (req, res) => {
      const a = ADS[slug];
      const products = await catalog();
      const data = pickPackages(products, a.iso);
      if (!data.all.length) return res.redirect(302, "/esim");
      res.set("Cache-Control", "public, max-age=900");
      res.type("html").send(adsPage(slug, a, data));
    });
  });

  // Карта сайта и роботы: без них робот про эти страницы просто не узнает
  app.get("/sitemap.xml", async (req, res) => {
    // В карту не попадают страны, по которым у поставщика нет пакетов:
    // такая ссылка уводила бы робота на редирект
    const products = await catalog();
    const live = slugs.filter((s) => products.some((p) => (p.countries || []).indexOf(ARTICLES[s].iso) >= 0));
    const urls = ["/esim"].concat(live.map((s) => "/esim/" + s)).concat(guideSlugs.map((s) => "/esim/" + s));
    const today = new Date().toISOString().slice(0, 10);
    res.type("application/xml").send(
      '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
      urls.map((u) => "  <url><loc>" + BASE_URL + u + "</loc><lastmod>" + today +
        "</lastmod><changefreq>weekly</changefreq><priority>" + (u === "/esim" ? "1.0" : "0.8") + "</priority></url>").join("\n") +
      "\n</urlset>");
  });

  app.get("/robots.txt", (req, res) => {
    res.type("text/plain").send(
      "User-agent: *\n" +
      "Disallow: /admin\nDisallow: /vsc\nDisallow: /cabinet\nDisallow: /esim/my\nDisallow: /esim/account\n" +
      "Allow: /esim\n\nSitemap: " + BASE_URL + "/sitemap.xml\n");
  });

  console.log("esimseo: страниц направлений " + slugs.length + ", инструкций " + guideSlugs.length +
    ", рекламных посадочных " + Object.keys(ADS).length);
}

module.exports = { mount, slugs: Object.keys(ARTICLES), guides: Object.keys(GUIDES), ads: Object.keys(ADS) };
