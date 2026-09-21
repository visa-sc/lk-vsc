#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// spbcopy-mirror — полная копия сайта spb.visa-sc.ru (Flexbe) на нашем хостинге.
//
// ЗАЧЕМ: уйти с Flexbe. Копия живёт на crm.voyotravel.ru/spb_copy/ и должна
// выглядеть и работать в точности как оригинал: та же вёрстка, те же картинки,
// те же модальные окна, меню, квизы, формы. Заявки НИКУДА не интегрированы
// (решение Андрея 21.09.2026): форма отправляется на наш заглушечный обработчик,
// который отвечает Flexbe-совместимым JSON и пишет заявку в журнал.
//
// ЧТО ДЕЛАЕТ:
//   fetch  — тянет sitemap.xml, все страницы и все ассеты (css/js/шрифты/img),
//            рекурсивно разбирая css и js на вложенные ссылки. Сырьё в raw/.
//   build  — из raw/ собирает site/: переписывает все ссылки под префикс
//            /spb_copy, вырезает чужую аналитику (иначе копия льёт трафик в
//            живую Метрику клиента), вешает шим для форм и рантайм-путей.
//   check  — сверяет, что все 242 страницы на месте и внутри нет ссылок,
//            уводящих обратно на spb.visa-sc.ru.
//
// Флаги: --only=<подстрока> (ограничить набор страниц), --limit=N, --force.
// ─────────────────────────────────────────────────────────────────────────────
"use strict";

const fs = require("fs");
const path = require("path");
const https = require("https");
const zlib = require("zlib");

const ORIGIN = "https://spb.visa-sc.ru";
const HOSTS_SELF = ["spb.visa-sc.ru"]; // что считаем «своим» и переписываем
// Копия живёт в корне своего поддомена spb.voyotravel.ru, поэтому префикса нет
// и все абсолютные пути оригинала («/img/…», «/italy/») остаются как есть — это
// самый точный вариант копии. Если понадобится положить её в подкаталог
// (например crm.voyotravel.ru/spb_copy), достаточно SPBCOPY_PREFIX=/spb_copy.
const PREFIX = process.env.SPBCOPY_PREFIX || "";
const COPY_HOST = process.env.SPBCOPY_HOST || "spb.voyotravel.ru";
const OUT = process.env.SPBCOPY_OUT || path.join(__dirname, "..", ".spbcopy");
const RAW = path.join(OUT, "raw");
const SITE = path.join(OUT, "site");
const STATE = path.join(OUT, "state.json");

// Внешние счётчики и эксперименты — в копии не нужны: они бы писали чужую
// статистику и тянули лишние домены.
// Режем только сами счётчики (по хостам). Вызовы ym()/gtag() в коде формы
// остаются — под них шим подставляет пустышки, иначе отправка формы падала бы.
const ANALYTICS_HOSTS = [
  "mc.yandex.ru",
  "googletagmanager.com",
  "abt.s3.yandex.net",
  "yandex_metrika",
  "metrika/tag.js"
];

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/140.0 Safari/537.36";

// ── утилиты ──────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const cmd = args.find((a) => !a.startsWith("-")) || "fetch";
const flag = (name, def = null) => {
  const a = args.find((x) => x.startsWith(`--${name}=`));
  return a ? a.slice(name.length + 3) : args.includes(`--${name}`) ? true : def;
};

function ensureDir(p) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
}

function log(...a) {
  console.log(...a);
}

function get(url, tries = 4) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      {
        headers: {
          "User-Agent": UA,
          "Accept-Encoding": "gzip, deflate",
          Accept: "*/*",
          "Accept-Language": "ru-RU,ru;q=0.9"
        },
        timeout: 45000
      },
      (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
          res.resume();
          const next = new URL(res.headers.location, url).href;
          return resolve(get(next, tries).then((r) => ({ ...r, redirectedTo: next })));
        }
        const chunks = [];
        let stream = res;
        const enc = (res.headers["content-encoding"] || "").toLowerCase();
        if (enc === "gzip") stream = res.pipe(zlib.createGunzip());
        else if (enc === "deflate") stream = res.pipe(zlib.createInflate());
        stream.on("data", (c) => chunks.push(c));
        stream.on("end", () =>
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks)
          })
        );
        stream.on("error", (e) => (tries > 1 ? resolve(get(url, tries - 1)) : reject(e)));
      }
    );
    req.on("timeout", () => {
      req.destroy();
      tries > 1 ? resolve(get(url, tries - 1)) : reject(new Error("timeout " + url));
    });
    req.on("error", (e) => (tries > 1 ? resolve(get(url, tries - 1)) : reject(e)));
  });
}

// Путь на диске для URL. Страница → <путь>/index.html, ассет → как есть.
function diskPathFor(urlStr, isPage) {
  const u = new URL(urlStr, ORIGIN);
  let p = decodeURIComponent(u.pathname);
  if (isPage) {
    if (p.endsWith("/")) p += "index.html";
    else p += "/index.html";
  } else if (p.endsWith("/")) {
    p += "index";
  }
  return p.replace(/^\/+/, "");
}

// ── обход html/css/js в поисках ссылок ───────────────────────────────────────
const ASSET_ATTRS = [
  "src",
  "href",
  "poster",
  "data-src",
  "data-lazy-src",
  "data-lazy-href",
  "data-inline-href",
  "data-img-url",
  "data-bg",
  "data-background",
  "data-poster",
  "data-mobile-src",
  "data-icon",
  "content" // og:image и подобные — мимо них уехали бы картинки соцсетей
];

function decodeEntities(s) {
  return s
    .replace(/&#x2F;/gi, "/")
    .replace(/&#47;/g, "/")
    .replace(/&#x3A;/gi, ":")
    .replace(/&amp;/g, "&");
}

// Все «наши» ссылки из html: и ассеты, и страницы.
function scanHtml(html) {
  const out = new Set();
  const attrRe = new RegExp(`(?:${ASSET_ATTRS.join("|")})\\s*=\\s*"([^"]*)"`, "gi");
  let m;
  while ((m = attrRe.exec(html))) out.add(decodeEntities(m[1]));
  // srcset: «url 1x, url 2x»
  const srcsetRe = /srcset\s*=\s*"([^"]*)"/gi;
  while ((m = srcsetRe.exec(html))) {
    decodeEntities(m[1])
      .split(",")
      .forEach((part) => out.add(part.trim().split(/\s+/)[0]));
  }
  // url(...) в <style> и в style=""
  const urlRe = /url\((['"]?)([^'")]+)\1\)/gi;
  while ((m = urlRe.exec(html))) out.add(decodeEntities(m[2]));
  // строковые литералы с нашими путями в инлайн-скриптах
  const litRe = /["'`](\/(?:_s|_app|img|files|api\/theme)\/[^"'`\s>]+)["'`]/g;
  while ((m = litRe.exec(html))) out.add(m[1]);
  // Картинка может быть объявлена без адреса: data-img-id + data-img-ext,
  // а сам адрес Flexbe собирает в браузере.
  const idExt = /data-img-id="(\d+)"[^>]*?data-img-ext="([a-z0-9]+)"/gi;
  while ((m = idExt.exec(html))) out.add(`/img/${m[1]}.${m[2]}`);
  const extId = /data-img-ext="([a-z0-9]+)"[^>]*?data-img-id="(\d+)"/gi;
  while ((m = extId.exec(html))) out.add(`/img/${m[2]}.${m[1]}`);
  return [...out];
}

function scanCss(css) {
  const out = new Set();
  let m;
  const urlRe = /url\((['"]?)([^'")]+)\1\)/gi;
  while ((m = urlRe.exec(css))) out.add(m[2]);
  const impRe = /@import\s+(?:url\()?['"]([^'"]+)['"]/gi;
  while ((m = impRe.exec(css))) out.add(m[1]);
  return [...out];
}

// В js пути бывают шаблонами: `/_s/build/theme/${t}/_tooltipster.css?${e}`.
// Подставляем известные значения: тема 4, версию просто отбрасываем (в имени
// файла на диске query не участвует).
function scanJs(js) {
  const out = new Set();
  const re = /["'`](\/(?:_s|_app|img|files|api\/theme)\/[^"'`\s)]+)["'`]/g;
  let m;
  while ((m = re.exec(js))) {
    let p = m[1];
    if (p.includes("${")) {
      p = p.replace(/\$\{[^}]*\}/g, (s) => (/theme/.test(p.slice(0, p.indexOf(s))) ? "4" : ""));
      if (p.includes("${") || /\/\//.test(p)) continue;
    }
    out.add(p);
  }
  // ES-модули тянут соседние куски относительным путём: from"../../js/chunk-X.mjs"
  const esm = /(?:\bfrom|\bimport\(|\bimport)\s*\(?\s*["']([^"']+\.(?:mjs|js|css))["']/g;
  while ((m = esm.exec(js))) out.add(m[1]);
  return [...out];
}

// Flexbe отдаёт картинки в произвольных ширинах: /img/123_%optimalWidth%.png,
// /img/123_800_q70.jpg. Нам нужен ОРИГИНАЛ — варианты наш сервис нарежет сам.
function imgBase(pathname) {
  return pathname.replace(
    /^\/img\/(\d+)(?:_(?:%optimalWidth%|\d+))?(?:_q\d+)?(\.[a-z0-9]+)$/i,
    "/img/$1$2"
  );
}

function isOurUrl(raw) {
  if (!raw) return false;
  if (raw.startsWith("data:") || raw.startsWith("#") || raw.startsWith("mailto:")) return false;
  if (raw.startsWith("tel:") || raw.startsWith("javascript:")) return false;
  if (raw.includes("%optimalWidth%") || raw.includes("${")) {
    // остался шаблон — годится только если это картинка (нормализуется в оригинал)
    if (!/^\/img\/\d+_/.test(raw)) return false;
  }
  if (raw.includes("%") && !raw.includes("%optimalWidth%")) {
    // битое процентное кодирование (обломки шаблонов) — мимо
    try {
      decodeURIComponent(raw);
    } catch (_) {
      return false;
    }
  }
  try {
    const u = new URL(raw, ORIGIN);
    return u.protocol === "https:" && HOSTS_SELF.includes(u.host);
  } catch (_) {
    return false;
  }
}

function normalize(raw) {
  const u = new URL(raw, ORIGIN);
  u.hash = "";
  u.search = "";
  if (u.pathname.startsWith("/img/")) u.pathname = imgBase(u.pathname);
  return u.href;
}

const isPageUrl = (urlStr) => {
  const p = new URL(urlStr).pathname;
  if (/^\/(?:_s|_app|img|files|api|mod)\//.test(p)) return false;
  return !/\.[a-z0-9]{2,5}$/i.test(p) || /\.html?$/i.test(p);
};

// ── команда fetch ────────────────────────────────────────────────────────────
async function cmdFetch() {
  fs.mkdirSync(RAW, { recursive: true });
  const state = fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, "utf8")) : {};
  state.pages = state.pages || {};
  state.assets = state.assets || {};

  // Служебные файлы: их не найти обходом по ссылкам, но в копии они нужны.
  for (const extra of ["/robots.txt", "/sitemap.xml", "/favicon.ico"]) {
    const r = await get(ORIGIN + extra);
    if (r.status === 200) {
      const f = path.join(RAW, extra.replace(/^\//, ""));
      ensureDir(f);
      fs.writeFileSync(f, r.body);
    }
  }
  // Страница 404 оригинала — чтобы копия ошибалась так же
  const nf = await get(`${ORIGIN}/_spbcopy_probe_404/`);
  if (nf.status === 404 && nf.body.length) {
    fs.writeFileSync(path.join(RAW, "404.html"), nf.body);
  }

  log("• sitemap.xml");
  const sm = await get(`${ORIGIN}/sitemap.xml`);
  let pages = [...sm.body.toString("utf8").matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) =>
    normalize(m[1].trim())
  );
  fs.writeFileSync(path.join(OUT, "pages.json"), JSON.stringify(pages, null, 2));
  const only = flag("only");
  if (only) pages = pages.filter((p) => p.includes(only));
  const limit = Number(flag("limit", 0));
  if (limit) pages = pages.slice(0, limit);
  log(`  страниц: ${pages.length}`);

  const assetQueue = new Set();
  const seenAssets = new Set();

  // 1) страницы
  await pool(pages, 5, async (url) => {
    const rel = diskPathFor(url, true);
    const file = path.join(RAW, rel);
    if (!flag("force") && fs.existsSync(file) && state.pages[url]) {
      scanHtml(fs.readFileSync(file, "utf8")).forEach((r) => {
        if (isOurUrl(r) && !isPageUrl(normalize(r))) assetQueue.add(normalize(r));
      });
      return;
    }
    const res = await get(url);
    if (res.status !== 200) {
      log(`  ! ${res.status} ${url}`);
      state.pages[url] = { status: res.status };
      return;
    }
    ensureDir(file);
    fs.writeFileSync(file, res.body);
    state.pages[url] = { status: 200, bytes: res.body.length, at: Date.now() };
    scanHtml(res.body.toString("utf8")).forEach((r) => {
      if (isOurUrl(r) && !isPageUrl(normalize(r))) assetQueue.add(normalize(r));
    });
    process.stdout.write(".");
  });
  log(`\n  страницы готовы, ассетов в очереди: ${assetQueue.size}`);

  // 2) ассеты (волнами: css/js приносят новые ссылки)
  let wave = 0;
  while (assetQueue.size) {
    wave++;
    const batch = [...assetQueue];
    assetQueue.clear();
    log(`• волна ассетов ${wave}: ${batch.length}`);
    await pool(batch, 8, async (url) => {
      if (seenAssets.has(url)) return;
      seenAssets.add(url);
      const rel = diskPathFor(url, false);
      const file = path.join(RAW, rel);
      let buf = null;
      if (!flag("force") && fs.existsSync(file) && state.assets[url]?.status === 200) {
        buf = fs.readFileSync(file);
      } else {
        const res = await get(url);
        state.assets[url] = { status: res.status, bytes: res.body.length };
        if (res.status !== 200) {
          if (res.status !== 404) log(`  ! ${res.status} ${url}`);
          return;
        }
        ensureDir(file);
        fs.writeFileSync(file, res.body);
        buf = res.body;
        process.stdout.write(".");
      }
      const ext = path.extname(new URL(url).pathname).toLowerCase();
      let found = [];
      if (ext === ".css") found = scanCss(buf.toString("utf8"));
      else if (ext === ".js" || ext === ".mjs") found = scanJs(buf.toString("utf8"));
      else if (ext === ".svg") found = scanCss(buf.toString("utf8"));
      for (const r of found) {
        let abs;
        try {
          abs = normalize(new URL(r, url).href);
        } catch (_) {
          continue;
        }
        if (isOurUrl(abs) && !isPageUrl(abs) && !seenAssets.has(abs)) assetQueue.add(abs);
      }
    });
    log("");
    if (wave > 8) break;
  }

  fs.writeFileSync(STATE, JSON.stringify(state, null, 2));
  const okPages = Object.values(state.pages).filter((p) => p.status === 200).length;
  const okAssets = Object.values(state.assets).filter((a) => a.status === 200).length;
  log(`\nГотово: страниц ${okPages}, ассетов ${okAssets}`);
}

async function pool(items, size, fn) {
  const it = items[Symbol.iterator]();
  const workers = Array.from({ length: size }, async () => {
    for (;;) {
      const { value, done } = it.next();
      if (done) return;
      try {
        await fn(value);
      } catch (e) {
        log(`  !! ${value}: ${e.message}`);
      }
    }
  });
  await Promise.all(workers);
}

// ─────────────────────────────────────────────────────────────────────────────
// build — из сырья делаем сайт под префиксом /spb_copy
// ─────────────────────────────────────────────────────────────────────────────

// Шим грузится первым и решает три задачи:
//  1. Пути, которые Flexbe собирает в рантайме (`/_s/build/theme/${id}/…`,
//     `/mod/stat/`), уводят на корень домена — дописываем им префикс.
//  2. Счётчики из копии вырезаны, но код формы вызывает ym()/gtag() — ставим
//     пустышки, иначе отправка формы падала бы с ошибкой.
//  3. Ничто не должно случайно уйти на spb.visa-sc.ru.
const SHIM = `<script id="spbcopy-shim">
(function(){
  var P="${PREFIX}", RE=/^\\/(?:_s|_app|img|files|api|mod)\\//, O="https://spb.visa-sc.ru";
  function fix(u){
    if(typeof u!=="string"||!u) return u;
    if(u.indexOf(P+"/")===0) return u;
    if(u.indexOf(O)===0) return P+(u.slice(O.length)||"/");
    return RE.test(u) ? P+u : u;
  }
  window.__spbcopyFix = fix;
  if(window.fetch){ var of=window.fetch; window.fetch=function(r,i){ return of.call(this, typeof r==="string"?fix(r):r, i); }; }
  var xo=XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open=function(){ var a=[].slice.call(arguments); a[1]=fix(a[1]); return xo.apply(this,a); };
  var sa=Element.prototype.setAttribute;
  Element.prototype.setAttribute=function(n,v){
    if(typeof v==="string"&&(n==="src"||n==="href"||n==="xlink:href"||n==="data-src"||n==="poster")) v=fix(v);
    return sa.call(this,n,v);
  };
  ["HTMLScriptElement","HTMLImageElement","HTMLLinkElement","HTMLSourceElement","HTMLMediaElement","HTMLIFrameElement","HTMLTrackElement"].forEach(function(k){
    var C=window[k]; if(!C||!C.prototype) return;
    ["src","href"].forEach(function(prop){
      var d=Object.getOwnPropertyDescriptor(C.prototype, prop);
      if(!d||!d.set) return;
      Object.defineProperty(C.prototype, prop, {configurable:true, enumerable:d.enumerable, get:d.get,
        set:function(v){ d.set.call(this, fix(v)); }});
    });
  });
  window.dataLayer = window.dataLayer || [];
  if(!window.ym) window.ym=function(){};
  if(!window.gtag) window.gtag=function(){ window.dataLayer.push(arguments); };
})();
</script>`;

function rewriteUrlValue(v) {
  let s = decodeEntities(v).trim();
  if (!s) return v;
  if (/^(data:|#|mailto:|tel:|javascript:|blob:)/i.test(s)) return s;
  const abs = s.match(/^https?:\/\/spb\.visa-sc\.ru(\/.*)?$/i);
  if (abs) return PREFIX + (abs[1] || "/");
  if (s.startsWith("//") || /^https?:/i.test(s)) return s;
  if (s.startsWith("/")) return s.startsWith(PREFIX + "/") ? s : PREFIX + s;
  return s;
}

const REWRITE_ATTRS = [...ASSET_ATTRS, "action", "data-href", "data-url", "content"];

function rewriteCssText(css) {
  return css
    .replace(/url\((['"]?)(\/(?!\/)[^'")]*|https?:\/\/spb\.visa-sc\.ru[^'")]*)\1\)/gi, (m, q, u) => {
      return `url(${q}${rewriteUrlValue(u)}${q})`;
    })
    .replace(/@import\s+(url\()?(['"])(\/(?!\/)[^'"]*)\2/gi, (m, u, q, p) => {
      return `@import ${u || ""}${q}${rewriteUrlValue(p)}${q}`;
    });
}

// В js встречаются и обычные строки ("/img/1.png"), и шаблоны
// (`/_s/build/theme/${id}/x.css`) — дописываем префикс к началу пути.
function rewriteJsText(js) {
  if (!PREFIX) return js; // копия в корне домена — пути и так верные
  return js.replace(
    /(["'`])(\/(?:_s|_app|img|files|api|mod)\/)/g,
    (m, q, p) => `${q}${PREFIX}${p}`
  );
}

function rewriteHtml(html, relPath) {
  // 1) чужие счётчики — вон (иначе копия писала бы статистику живого сайта)
  html = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, (block) => {
    const low = block.toLowerCase();
    return ANALYTICS_HOSTS.some((h) => low.includes(h)) ? "" : block;
  });
  html = html.replace(/<noscript>[\s\S]*?<\/noscript>/gi, (block) =>
    ANALYTICS_HOSTS.some((h) => block.toLowerCase().includes(h)) ? "" : block
  );

  // 2) атрибуты со ссылками
  const attrRe = new RegExp(`(\\s(?:${REWRITE_ATTRS.join("|")})\\s*=\\s*)"([^"]*)"`, "gi");
  html = html.replace(attrRe, (m, head, val) => {
    // content="" бывает у og:*/canonical, но также у обычных мета — правим лишь адреса
    if (/content\s*=\s*$/i.test(head) && !/^(https?:\/\/spb\.visa-sc\.ru|\/)/i.test(decodeEntities(val)))
      return m;
    return `${head}"${rewriteUrlValue(val)}"`;
  });
  // srcset — список «url 1x, url 2x»
  html = html.replace(/(\ssrcset\s*=\s*)"([^"]*)"/gi, (m, head, val) => {
    const list = decodeEntities(val)
      .split(",")
      .map((part) => {
        const bits = part.trim().split(/\s+/);
        if (!bits[0]) return part.trim();
        bits[0] = rewriteUrlValue(bits[0]);
        return bits.join(" ");
      })
      .join(", ");
    return `${head}"${list}"`;
  });

  // 3) css внутри html (<style> и style="")
  html = rewriteCssText(html);

  // 4) пути в инлайн-скриптах
  html = html.replace(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi, (m, attrs, body) => {
    if (!body.trim()) return m;
    return `<script${attrs}>${rewriteJsText(body)}</script>`;
  });

  // 5) шим первым делом + запрет индексации (копия не должна лезть в поиск)
  html = html.replace(
    /<head>/i,
    `<head><meta name="robots" content="noindex, nofollow">${SHIM}`
  );
  return html;
}

function walk(dir, acc = []) {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) walk(p, acc);
    else acc.push(p);
  }
  return acc;
}

function cmdBuild() {
  if (!fs.existsSync(RAW)) throw new Error(`нет сырья: ${RAW} (сначала fetch)`);
  fs.mkdirSync(SITE, { recursive: true });
  const files = walk(RAW);
  let html = 0,
    css = 0,
    js = 0,
    other = 0;
  for (const src of files) {
    const rel = path.relative(RAW, src);
    const dst = path.join(SITE, rel);
    ensureDir(dst);
    const ext = path.extname(src).toLowerCase();
    if (ext === ".html" || ext === ".htm") {
      fs.writeFileSync(dst, rewriteHtml(fs.readFileSync(src, "utf8"), rel));
      html++;
    } else if (ext === ".css") {
      fs.writeFileSync(dst, rewriteCssText(fs.readFileSync(src, "utf8")));
      css++;
    } else if (ext === ".js" || ext === ".mjs") {
      fs.writeFileSync(dst, rewriteJsText(fs.readFileSync(src, "utf8")));
      js++;
    } else if (ext === ".svg") {
      fs.writeFileSync(dst, rewriteCssText(fs.readFileSync(src, "utf8")));
      other++;
    } else if (ext === ".xml" || ext === ".txt") {
      // robots.txt и sitemap.xml переводим на домен копии
      const txt = fs
        .readFileSync(src, "utf8")
        .replace(/https?:\/\/spb\.visa-sc\.ru/gi, `https://${COPY_HOST}`);
      fs.writeFileSync(dst, txt);
      other++;
    } else {
      fs.copyFileSync(src, dst);
      other++;
    }
  }
  log(`Собрано: html ${html}, css ${css}, js ${js}, прочее ${other} → ${SITE}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// check — все ли страницы на месте и не осталось ли ссылок на оригинал
// ─────────────────────────────────────────────────────────────────────────────
function cmdCheck() {
  const pages = JSON.parse(fs.readFileSync(path.join(OUT, "pages.json"), "utf8"));
  const problems = [];
  let ok = 0;
  for (const url of pages) {
    const file = path.join(SITE, diskPathFor(url, true));
    if (!fs.existsSync(file)) {
      problems.push(`нет страницы: ${url}`);
      continue;
    }
    const html = fs.readFileSync(file, "utf8");
    if (html.length < 2000) problems.push(`подозрительно короткая: ${url} (${html.length} б)`);
    const leaks = [...html.matchAll(/(?:src|href)\s*=\s*"(https?:\/\/spb\.visa-sc\.ru[^"]*)"/gi)].map(
      (m) => m[1]
    );
    if (leaks.length) problems.push(`ссылки на оригинал (${leaks.length}): ${url} → ${leaks[0]}`);
    if (!html.includes("spbcopy-shim")) problems.push(`нет шима: ${url}`);
    ok++;
  }
  // битые внутренние ссылки на ассеты
  const missing = new Set();
  for (const url of pages) {
    const file = path.join(SITE, diskPathFor(url, true));
    if (!fs.existsSync(file)) continue;
    const html = fs.readFileSync(file, "utf8");
    const assetRe = new RegExp(`"(${PREFIX}/(?:_s|_app|img|files|api)/[^"?#]+)`, "g");
    for (const m of html.matchAll(assetRe)) {
      let p = m[1].slice(PREFIX.length);
      if (p.includes("%optimalWidth%")) p = imgBase(p.replace(/_%optimalWidth%/gi, ""));
      if (p.startsWith("/img/")) p = imgBase(p);
      const f = path.join(SITE, p.replace(/^\/+/, ""));
      if (!fs.existsSync(f)) missing.add(p);
    }
  }
  log(`Страниц проверено: ${ok} из ${pages.length}`);
  if (missing.size) {
    log(`Не найдено ассетов: ${missing.size}`);
    [...missing].slice(0, 20).forEach((m) => log(`  - ${m}`));
  }
  if (problems.length) {
    log(`Замечания: ${problems.length}`);
    problems.slice(0, 40).forEach((p) => log(`  • ${p}`));
    process.exitCode = 1;
  } else if (!missing.size) {
    log("Замечаний нет.");
  }
}

module.exports = { get, scanHtml, scanCss, scanJs, diskPathFor, normalize, isOurUrl, isPageUrl };

if (require.main === module) {
  const run = { fetch: cmdFetch, build: cmdBuild, check: cmdCheck };
  const f = run[cmd];
  if (!f) {
    console.error(`неизвестная команда: ${cmd}. Есть: ${Object.keys(run).join(", ")}`);
    process.exit(2);
  }
  Promise.resolve()
    .then(f)
    .catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
