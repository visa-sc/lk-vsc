#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// spbcopy-noindex-sweep — проверяет КАЖДУЮ страницу копии на тестовом домене:
// есть ли мета <meta name="robots" content="noindex, nofollow"> и заголовок
// X-Robots-Tag. Нужен, чтобы отвечать на вопрос «копия точно нигде не
// индексируется?» фактом по всем 242 адресам, а не по паре примеров.
//
//   node tools/spbcopy-noindex-sweep.js [--copy=https://spb.voyotravel.ru]
// ─────────────────────────────────────────────────────────────────────────────
"use strict";

const fs = require("fs");
const path = require("path");
const https = require("https");
const zlib = require("zlib");

const args = process.argv.slice(2);
const flag = (n, d = null) => {
  const a = args.find((x) => x.startsWith(`--${n}=`));
  return a ? a.slice(n.length + 3) : d;
};
const COPY = (flag("copy") || "https://spb.voyotravel.ru").replace(/\/$/, "");
const OUT = process.env.SPBCOPY_OUT || path.join(__dirname, "..", ".spbcopy");

function get(url) {
  return new Promise((resolve) => {
    https
      .get(
        url,
        { headers: { "User-Agent": "spbcopy-noindex-sweep", "Accept-Encoding": "gzip" }, timeout: 30000 },
        (res) => {
          const chunks = [];
          let s = res;
          if ((res.headers["content-encoding"] || "") === "gzip") s = res.pipe(zlib.createGunzip());
          s.on("data", (c) => chunks.push(c));
          s.on("end", () =>
            resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") })
          );
          s.on("error", () => resolve({ status: 0, headers: {}, body: "" }));
        }
      )
      .on("error", () => resolve({ status: 0, headers: {}, body: "" }));
  });
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
  const bad = [];
  let done = 0;

  await pool(pages, 6, async (u) => {
    const p = new URL(u).pathname;
    const r = await get(COPY + p);
    done++;
    if (done % 25 === 0) process.stdout.write(` ${done}`);
    if (r.status !== 200) return bad.push(`${p}: ответ ${r.status}`);
    const hasMeta = /<meta[^>]+name=["']robots["'][^>]*content=["'][^"']*noindex/i.test(r.body);
    const hasHeader = /noindex/i.test(String(r.headers["x-robots-tag"] || ""));
    if (!hasMeta) bad.push(`${p}: НЕТ меты noindex`);
    if (!hasHeader) bad.push(`${p}: НЕТ заголовка X-Robots-Tag`);
  });

  process.stdout.write("\n");
  const robots = await get(COPY + "/robots.txt");
  const blocksCrawl = /^\s*Disallow:\s*\/\s*$/im.test(robots.body);

  console.log(`Проверено страниц: ${done} из ${pages.length}`);
  console.log(`Без запрета индексации: ${bad.length}`);
  bad.slice(0, 20).forEach((b) => console.log("  • " + b));
  console.log(
    `robots.txt ${blocksCrawl ? "ЗАПРЕЩАЕТ обход — роботы не увидят noindex на страницах" : "разрешает обход, значит роботы прочитают noindex и выкинут страницы из индекса"}`
  );
  process.exitCode = bad.length || blocksCrawl ? 1 : 0;
})();
