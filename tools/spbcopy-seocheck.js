#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// spbcopy-seocheck — проверка SEO-поведения копии в ДВУХ режимах сразу.
//
// Зачем: самый частый провал при переносе сайта — уехать в бой вместе с
// тестовым robots.txt и noindex (об этом предупредил SEO-специалист 22.09.2026).
// У нас домен нигде не вшит: сервис смотрит на имя хоста запроса. Этот скрипт
// доказывает, что обе ветки работают:
//
//   ТЕСТОВЫЙ домен (spb.voyotravel.ru) — сайт закрыт: robots.txt с Disallow,
//   заголовок X-Robots-Tag и мета noindex на каждой странице.
//   БОЕВОЕ имя (spb.visa-sc.ru) — ведёт себя как оригинал: robots.txt как у
//   него, никакого noindex, canonical/og/sitemap на боевом домене.
//
// Запуск (ходит на сервер по ssh, оригинал только читает):
//   node tools/spbcopy-seocheck.js
// ─────────────────────────────────────────────────────────────────────────────
"use strict";

const { execFileSync } = require("child_process");
const https = require("https");

const SSH_HOST = process.env.SPBCOPY_SSH || "root@89.108.88.59";
const SERVICE = process.env.SPBCOPY_LOCAL || "http://127.0.0.1:3006";
const TEST_URL = process.env.SPBCOPY_TEST_URL || "https://spb.voyotravel.ru";
const LIVE_HOST = process.env.SPBCOPY_LIVE_HOST || "spb.visa-sc.ru";
const PAGES = ["/", "/italy/", "/contacts/", "/czech/prague/"];

let bad = 0;
const ok = (cond, text, detail = "") => {
  console.log(`  ${cond ? "OK  " : "ПЛОХО"} ${text}${detail ? " — " + detail : ""}`);
  if (!cond) bad++;
};

// Запрос к сервису на сервере с подменой имени хоста.
function askService(path, host) {
  const cmd = [
    SSH_HOST,
    `curl -s -i -H 'Host: ${host}' -H 'X-Forwarded-Proto: https' '${SERVICE}${path}'`
  ];
  return execFileSync("ssh", ["-o", "ConnectTimeout=20", ...cmd], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024
  });
}

function fetchPublic(url) {
  return new Promise((resolve) => {
    https
      .get(url, { headers: { "User-Agent": "spbcopy-seocheck" } }, (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ headers: res.headers, body, status: res.statusCode }));
      })
      .on("error", () => resolve({ headers: {}, body: "", status: 0 }));
  });
}

(async () => {
  console.log(`\n① БОЕВОЕ имя (${LIVE_HOST}) — так копия поведёт себя сразу после переноса домена`);

  const liveRobots = askService("/robots.txt", LIVE_HOST);
  const robotsBody = liveRobots.split(/\r?\n\r?\n/).slice(1).join("\n\n");
  const origRobots = await fetchPublic(`https://${LIVE_HOST}/robots.txt`);
  ok(
    robotsBody.trim() === origRobots.body.trim(),
    "robots.txt совпадает с оригиналом",
    robotsBody.trim().replace(/\s+/g, " ").slice(0, 60)
  );
  ok(!/Disallow:\s*\/\s*$/m.test(robotsBody), "в robots.txt НЕТ запрета обхода");

  const liveMap = askService("/sitemap.xml", LIVE_HOST);
  const locs = [...liveMap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  const origMap = await fetchPublic(`https://${LIVE_HOST}/sitemap.xml`);
  const origLocs = [...origMap.body.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  ok(locs.length === origLocs.length, `в sitemap.xml ${locs.length} адресов, как в оригинале (${origLocs.length})`);
  ok(
    locs.every((l) => l.startsWith(`https://${LIVE_HOST}/`)),
    "все адреса sitemap ведут на боевой домен"
  );
  ok(
    origLocs.every((l) => locs.includes(l)),
    "ни один адрес оригинала не потерян"
  );

  for (const p of PAGES) {
    const raw = askService(p, LIVE_HOST);
    const head = raw.split(/\r?\n\r?\n/)[0];
    const html = raw.slice(head.length);
    ok(!/x-robots-tag/i.test(head), `${p}: нет заголовка X-Robots-Tag`);
    ok(!/<meta[^>]+name=["']robots["']/i.test(html), `${p}: нет меты noindex`);
    const canon = (html.match(/<link[^>]*rel=["']canonical["'][^>]*href=["']([^"']+)/i) || [, ""])[1];
    ok(canon === `https://${LIVE_HOST}${p}`, `${p}: canonical на боевой домен`, canon);
    const ogImg = (html.match(/<meta[^>]*property=["']og:image["'][^>]*content=["']([^"']+)/i) || [, ""])[1];
    ok(
      !ogImg || ogImg.startsWith(`https://${LIVE_HOST}/`),
      `${p}: og:image абсолютный и на боевой домен`,
      ogImg
    );
  }

  console.log(`\n② ТЕСТОВЫЙ домен (${TEST_URL}) — копия должна быть закрыта от поиска`);
  const testRobots = await fetchPublic(`${TEST_URL}/robots.txt`);
  // Обход тут должен быть РАЗРЕШЁН: запрет в robots.txt не выкидывает страницы
  // из поиска, он лишь мешает роботу увидеть noindex на самой странице.
  ok(
    !/^\s*Disallow:\s*\/\s*$/im.test(testRobots.body),
    "robots.txt не запрещает обход (иначе робот не прочитает noindex)"
  );
  ok(!/Sitemap:/i.test(testRobots.body), "карта сайта на тестовом домене не публикуется");
  for (const p of PAGES) {
    const r = await fetchPublic(`${TEST_URL}${p}`);
    ok(/noindex/i.test(String(r.headers["x-robots-tag"] || "")), `${p}: заголовок X-Robots-Tag noindex`);
    ok(/<meta[^>]+name=["']robots["'][^>]*noindex/i.test(r.body), `${p}: мета noindex на месте`);
  }

  console.log(
    bad === 0
      ? "\nИТОГ: всё верно. Перенос домена ничего не сломает: noindex и тестовый robots.txt живут только на тестовом имени.\n"
      : `\nИТОГ: проблем ${bad}. Разбираться до переноса.\n`
  );
  process.exitCode = bad ? 1 : 0;
})();
