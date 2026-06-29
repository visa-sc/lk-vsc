// РАЗВЕДКА 4 — camoufox (анти-детект на движке Firefox) против Cloudflare на VFS.
// Запуск: xvfb-run -a node recon4.js [URL]
require("dotenv").config();
const camoufox = require("camoufox-js");

function parseProxy(s) {
  if (!s) return undefined;
  s = String(s).trim();
  let m = s.match(/^(https?):\/\/(?:([^:@]+):([^@]+)@)?([^:\/]+):(\d+)/);
  if (m) return { server: m[1] + "://" + m[4] + ":" + m[5], username: m[2], password: m[3] };
  const p = s.split(":");
  if (p.length === 4) return { server: "http://" + p[0] + ":" + p[1], username: p[2], password: p[3] };
  return undefined;
}

async function makeBrowser(proxy, useGeoip) {
  const Launch = camoufox.Camoufox || camoufox.default || camoufox.launch;
  if (!Launch) {
    console.log("camoufox-js exports:", Object.keys(camoufox));
    throw new Error("не нашёл точку входа camoufox-js");
  }
  const opts = {
    headless: false,
    proxy,
    humanize: true,
    os: "windows",
  };
  if (useGeoip) opts.geoip = true;
  else { opts.locale = "ru-RU"; }
  return await Launch(opts);
}

(async () => {
  const URL = process.argv[2] || "https://visa.vfsglobal.com/rus/en/fra/login";
  const proxy = parseProxy(process.env.PROXY_URL);
  console.log("URL:", URL, "| proxy:", proxy ? proxy.server : "NONE", "| движок: camoufox(Firefox)");

  let browser;
  try {
    try { browser = await makeBrowser(proxy, true); console.log("camoufox запущен (geoip)"); }
    catch (e) { console.log("geoip-режим не вышел (", e.message, ") → без geoip"); browser = await makeBrowser(proxy, false); console.log("camoufox запущен (без geoip)"); }

    const page = await browser.newPage();
    const resp = await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 60000 });
    console.log("goto HTTP status:", resp && resp.status());

    let cleared = false;
    for (let t = 0; t < 45; t++) {
      await page.waitForTimeout(1000);
      const st = await page.evaluate(() => {
        const title = document.title || "";
        const body = (document.body && document.body.innerText) || "";
        const challenge = /момент|just a moment|проверка безопасности|checking/i.test(title) ||
          /проверк безопас|security check/i.test(body);
        const hasForm = !!document.querySelector("input[type='password'],input[type='email'],input[name*='mail' i]");
        return { title, challenge, hasForm };
      });
      if (st.hasForm || !st.challenge) { cleared = true; console.log("✓ cleared after", t + 1, "s | title:", st.title, "| form:", st.hasForm); break; }
      if ([8, 20, 35].includes(t)) console.log("  …still on challenge at", t + 1, "s | title:", st.title);
    }

    const info = await page.evaluate(() => ({
      title: document.title,
      url: location.href,
      emailField: !!document.querySelector("input[type='email'],input[name*='mail' i],#email,#mat-input-0"),
      passwordField: !!document.querySelector("input[type='password']"),
      bodyText: ((document.body && document.body.innerText) || "").replace(/\s+/g, " ").slice(0, 500),
    }));
    console.log("FINAL cleared:", cleared);
    console.log("title:", info.title, "| url:", info.url);
    console.log("emailField:", info.emailField, "| passwordField:", info.passwordField);
    console.log("bodyText:", info.bodyText);
    try { await page.screenshot({ path: "/root/vfs-bot/recon4.png" }); console.log("screenshot → recon4.png"); } catch (_) {}
  } catch (e) {
    console.error("RECON4 ERROR:", e.message);
  } finally {
    try { await browser.close(); } catch (_) {}
  }
})();
