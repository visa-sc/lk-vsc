#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// spbcopy-verify — сверяет живую копию (spb.voyotravel.ru) с оригиналом
// (spb.visa-sc.ru) постранично: текст, заголовок, число форм/полей/кнопок/
// картинок/ссылок, доступность всех ассетов и картинок во всех размерах.
//
// Оригинал только ЧИТАЕТСЯ (GET), ничего не отправляем — сайт и Flexbe в
// полной безопасности.
//
// node tools/spbcopy-verify.js [--copy=https://spb.voyotravel.ru] [--limit=N]
// ─────────────────────────────────────────────────────────────────────────────
"use strict";

const fs = require("fs");
const path = require("path");
const https = require("https");
const http = require("http");
const zlib = require("zlib");

const ORIGIN = "https://spb.visa-sc.ru";
const args = process.argv.slice(2);
const flag = (n, d = null) => {
  const a = args.find((x) => x.startsWith(`--${n}=`));
  return a ? a.slice(n.length + 3) : d;
};
const COPY = (flag("copy") || "https://spb.voyotravel.ru").replace(/\/$/, "");
const OUT = process.env.SPBCOPY_OUT || path.join(__dirname, "..", ".spbcopy");
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/140.0 Safari/537.36";

function req(url, method = "GET") {
  const lib = url.startsWith("https") ? https : http;
  return new Promise((resolve) => {
    const r = lib.request(
      url,
      {
        method,
        headers: {
          "User-Agent": UA,
          "Accept-Encoding": "gzip",
          Accept: "text/html,image/webp,image/avif,*/*"
        },
        timeout: 40000
      },
      (res) => {
        if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location) {
          res.resume();
          return resolve(req(new URL(res.headers.location, url).href, method));
        }
        const chunks = [];
        let s = res;
        if ((res.headers["content-encoding"] || "") === "gzip") s = res.pipe(zlib.createGunzip());
        s.on("data", (c) => chunks.push(c));
        s.on("end", () =>
          resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) })
        );
        s.on("error", () => resolve({ status: 0, headers: {}, body: Buffer.alloc(0) }));
      }
    );
    r.on("timeout", () => {
      r.destroy();
      resolve({ status: 0, headers: {}, body: Buffer.alloc(0) });
    });
    r.on("error", () => resolve({ status: 0, headers: {}, body: Buffer.alloc(0) }));
    r.end();
  });
}

const ENT = { "&nbsp;": " ", "&amp;": "&", "&quot;": '"', "&#39;": "'", "&lt;": "<", "&gt;": ">" };
function textOf(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x2F;/gi, "/")
    .replace(/&nbsp;|&amp;|&quot;|&#39;|&lt;|&gt;/gi, (m) => ENT[m.toLowerCase()] || " ")
    .replace(/\s+/g, " ")
    .trim();
}

const count = (html, re) => (html.match(re) || []).length;
const meta = (html, name, attr = "name") => {
  const re = new RegExp(`<meta[^>]*${attr}=["']${name}["'][^>]*content=["']([^"']*)["']`, "i");
  const re2 = new RegExp(`<meta[^>]*content=["']([^"']*)["'][^>]*${attr}=["']${name}["']`, "i");
  return ((html.match(re) || html.match(re2) || [, ""])[1] || "").trim();
};
const headings = (html, tag) =>
  [...html.matchAll(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "gi"))].map((m) =>
    m[1].replace(/<[^>]+>/g, " ").replace(/&#x2F;/gi, "/").replace(/\s+/g, " ").trim()
  );

// Домен в значениях не сравниваем: в копии он наш, это ожидаемо.
const stripHost = (s) =>
  String(s)
    .replace(/https?:\/\/spb\.visa-sc\.ru/gi, "")
    .replace(/https?:\/\/spb\.voyotravel\.ru/gi, "")
    .replace(/&#x2F;/gi, "/");

// Все meta-теги страницы: «name|property = content», отсортированы.
function allMeta(html) {
  const out = [];
  for (const m of html.matchAll(/<meta\b[^>]*>/gi)) {
    const tag = m[0];
    if (/mc\.yandex\.ru|googletagmanager/i.test(tag)) continue; // счётчиков в копии нет
    const key =
      (tag.match(/\b(?:name|property|http-equiv|itemprop)=["']([^"']*)["']/i) || [, ""])[1] || "";
    const val = (tag.match(/\bcontent=["']([^"']*)["']/i) || [, ""])[1] || "";
    const charset = tag.match(/\bcharset=["']?([^"'\s>]+)/i);
    if (charset) out.push(`charset=${charset[1]}`);
    else if (key || val) out.push(`${key}=${stripHost(val).trim()}`);
  }
  return out.sort();
}

// Все <link rel=...>: rel + адрес без домена.
function allLinkRel(html) {
  const out = [];
  for (const m of html.matchAll(/<link\b[^>]*>/gi)) {
    const tag = m[0];
    const rel = (tag.match(/\brel=["']([^"']*)["']/i) || [, ""])[1];
    const href = (tag.match(/\bhref=["']([^"']*)["']/i) || [, ""])[1];
    out.push(`${rel}|${stripHost(href).split("?")[0]}`);
  }
  return out.sort();
}

// Микроразметка JSON-LD (Schema.org).
function allJsonLd(html) {
  return [...html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)]
    .map((m) => stripHost(m[1]).replace(/\s+/g, " ").trim())
    .sort();
}

// Все ссылки страницы: внутренние как путь, внешние как есть.
function anchorList(html) {
  return [...html.matchAll(/<a\b[^>]*\bhref=["']([^"']*)["']/gi)]
    .map((m) => stripHost(m[1]).trim())
    .sort();
}

function shape(html) {
  return {
    title: (html.match(/<title>([\s\S]*?)<\/title>/i) || [, ""])[1].trim(),
    description: meta(html, "description"),
    keywords: meta(html, "keywords"),
    ogTitle: meta(html, "og:title", "property"),
    ogDescription: meta(html, "og:description", "property"),
    // адрес og:image/canonical в копии наш, сравниваем только путь
    ogImage: meta(html, "og:image", "property").replace(/^https?:\/\/[^/]+/, ""),
    canonical: ((html.match(/<link[^>]*rel=["']canonical["'][^>]*href=["']([^"']*)["']/i) || [, ""])[1] || "")
      .replace(/^https?:\/\/[^/]+/, ""),
    h1: headings(html, "h1"),
    h2: headings(html, "h2"),
    h3: headings(html, "h3"),
    h4: headings(html, "h4"),
    h5: headings(html, "h5"),
    h6: headings(html, "h6"),
    lang: (html.match(/<html[^>]*\blang=["']([^"']*)["']/i) || [, ""])[1],
    // весь head целиком: любые meta и link rel, микроразметка
    metaAll: allMeta(html),
    linkRel: allLinkRel(html),
    jsonLd: allJsonLd(html),
    alts: [...html.matchAll(/<img[^>]*\balt=["']([^"']*)["'][^>]*>/gi)].map((m) => m[1].trim()).sort(),
    anchors: anchorList(html),
    forms: count(html, /<form\b/gi),
    inputs: count(html, /<input\b/gi),
    textareas: count(html, /<textarea\b/gi),
    selects: count(html, /<select\b/gi),
    buttons: count(html, /<button\b/gi),
    links: count(html, /<a\b/gi),
    // счётчик Метрики из копии вырезан — его пиксель в подсчёт не берём
    images: count(html.replace(/<img[^>]*mc\.yandex\.ru[^>]*>/gi, ""), /<img\b/gi),
    modals: count(html, /m_modal\b/g),
    phones: [...new Set((html.match(/\+7[\s()\d-]{10,20}/g) || []).map((s) => s.replace(/\D/g, "")))].sort()
  };
}

// адреса, которые страница попросит у сервера
function assetsOf(html) {
  const out = new Set();
  const dec = (s) => s.replace(/&#x2F;/gi, "/").replace(/&amp;/g, "&");
  const attrs =
    /(?:src|href|poster|data-src|data-lazy-src|data-inline-href|data-lazy-href|data-img-url|data-bg)\s*=\s*"([^"]*)"/gi;
  let m;
  while ((m = attrs.exec(html))) {
    const v = dec(m[1]).trim();
    if (/^\/(?:_s|_app|img|files|api)\//.test(v)) out.add(v.split("#")[0]);
  }
  const urlRe = /url\((['"]?)(\/(?:_s|_app|img|files)\/[^'")]+)\1\)/gi;
  while ((m = urlRe.exec(html))) out.add(m[2]);
  // картинки, объявленные id+расширением: проверяем и вариант с ресайзом в webp
  const idExt = /data-img-id="(\d+)"[^>]*?data-img-ext="([a-z0-9]+)"/gi;
  while ((m = idExt.exec(html))) {
    out.add(`/img/${m[1]}.${m[2]}`);
    out.add(`/img/${m[1]}_640_q70.webp`);
  }
  return [...out].map((u) => u.replace(/_%optimalWidth%/gi, "_800"));
}

async function pool(items, size, fn) {
  const it = items[Symbol.iterator]();
  await Promise.all(
    Array.from({ length: size }, async () => {
      for (;;) {
        const { value, done } = it.next();
        if (done) return;
        await fn(value);
      }
    })
  );
}

(async () => {
  const pages = JSON.parse(fs.readFileSync(path.join(OUT, "pages.json"), "utf8"));
  const limit = Number(flag("limit", 0));
  const list = limit ? pages.slice(0, limit) : pages;
  const problems = [];
  let expectedDiffs = 0;
  const assetSet = new Set();
  let done = 0;

  await pool(list, 4, async (url) => {
    const p = new URL(url).pathname;
    const [copy, orig] = await Promise.all([req(COPY + p), req(ORIGIN + p)]);
    done++;
    if (done % 25 === 0) process.stdout.write(` ${done}`);
    if (copy.status !== 200) {
      problems.push(`${p}: копия отдала ${copy.status}`);
      return;
    }
    if (orig.status !== 200) {
      problems.push(`${p}: ОРИГИНАЛ отдал ${orig.status} (сверить нечем)`);
      return;
    }
    const ch = copy.body.toString("utf8");
    const oh = orig.body.toString("utf8");
    const ct = textOf(ch);
    const ot = textOf(oh);
    if (ct !== ot) {
      // где именно разошлось
      let i = 0;
      while (i < Math.min(ct.length, ot.length) && ct[i] === ot[i]) i++;
      problems.push(
        `${p}: текст разошёлся на позиции ${i} из ${ot.length}\n      оригинал: …${ot.slice(Math.max(0, i - 40), i + 60)}…\n      копия:    …${ct.slice(Math.max(0, i - 40), i + 60)}…`
      );
    }
    const cs = shape(ch);
    const os = shape(oh);
    for (const k of Object.keys(os)) {
      const a = JSON.stringify(cs[k]);
      const b = JSON.stringify(os[k]);
      if (a === b) continue;
      if (Array.isArray(os[k])) {
        // Два отличия сделаны намеренно и расхождением не считаются:
        // наш noindex и вырезанный пиксель Яндекс.Метрики (у него alt="").
        const onlyO = os[k].filter((x) => !cs[k].includes(x));
        const onlyC = cs[k].filter((x) => !os[k].includes(x));
        const expected =
          onlyO.every((x) => x === "") && onlyC.every((x) => /^robots=noindex/.test(x));
        if (expected) {
          expectedDiffs++;
          continue;
        }
      }
      if (Array.isArray(os[k])) {
        // показываем только то, чем списки различаются
        const onlyOrig = os[k].filter((x) => !cs[k].includes(x));
        const onlyCopy = cs[k].filter((x) => !os[k].includes(x));
        problems.push(
          `${p}: ${k}: нет в копии ${JSON.stringify(onlyOrig.slice(0, 4))}, лишнее в копии ${JSON.stringify(
            onlyCopy.slice(0, 4)
          )}`
        );
      } else {
        problems.push(`${p}: ${k}: копия ${a} ≠ оригинал ${b}`);
      }
    }
    assetsOf(ch).forEach((a) => assetSet.add(a));
  });

  process.stdout.write("\n");
  console.log(`Страниц сверено: ${done} из ${list.length}`);
  console.log(`Намеренных отличий (наш noindex, вырезанный пиксель Метрики): ${expectedDiffs}`);
  console.log(`Уникальных ассетов к проверке: ${assetSet.size}`);

  const badAssets = [];
  let checked = 0;
  await pool([...assetSet], 8, async (a) => {
    const r = await req(COPY + a, "GET");
    checked++;
    if (checked % 200 === 0) process.stdout.write(` ${checked}`);
    if (r.status !== 200 || !r.body.length) {
      const o = await req(ORIGIN + a, "GET");
      if (o.status === 200) badAssets.push(`${a}: копия ${r.status}, оригинал 200`);
    }
  });
  process.stdout.write("\n");
  console.log(`Ассетов проверено: ${checked}, битых (живых в оригинале): ${badAssets.length}`);
  badAssets.slice(0, 30).forEach((b) => console.log("  • " + b));

  if (problems.length) {
    console.log(`\nРасхождения по страницам: ${problems.length}`);
    problems.slice(0, 60).forEach((p) => console.log("  • " + p));
    process.exitCode = 1;
  } else {
    console.log("\nРасхождений по страницам нет.");
  }
  fs.writeFileSync(
    path.join(OUT, "verify-report.json"),
    JSON.stringify({ at: new Date().toISOString(), pages: done, problems, badAssets }, null, 2)
  );
})();
