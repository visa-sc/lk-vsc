// РАЗВЕДКА через Bright Data Browser API (connectOverCDP) против Cloudflare на VFS.
// Endpoint в .env: BRIGHTDATA_CDP=wss://...@brd.superproxy.io:9222
// Запуск: node recon_brightdata.js [URL]
require("dotenv").config();
const { chromium } = require("playwright");

(async () => {
  const ep = process.env.BRIGHTDATA_CDP;
  if (!ep) { console.error("нет BRIGHTDATA_CDP в .env"); process.exit(1); }
  const URL = process.argv[2] || "https://visa.vfsglobal.com/rus/en/fra/login";
  console.log("Bright Data Browser API → connectOverCDP… (host:", ep.split("@")[1] + ")");

  let browser;
  try {
    browser = await chromium.connectOverCDP(ep, { timeout: 60000 });
    console.log("✓ подключился к удалённому браузеру");
    const ctx = browser.contexts()[0] || (await browser.newContext());
    const page = ctx.pages()[0] || (await ctx.newPage());

    console.log("goto:", URL, "(до 2 мин — Bright Data сам снимает Cloudflare)");
    const resp = await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 120000 });
    console.log("HTTP status:", resp && resp.status());
    await page.waitForTimeout(6000);

    const info = await page.evaluate(() => ({
      title: document.title,
      url: location.href,
      emailField: !!document.querySelector("input[type='email'],input[name*='mail' i],#email,#mat-input-0"),
      passwordField: !!document.querySelector("input[type='password']"),
      challenge: /just a moment|момент|проверка безопас|checking/i.test((document.title || "") + " " + ((document.body && document.body.innerText) || "")),
      bodyText: ((document.body && document.body.innerText) || "").replace(/\s+/g, " ").slice(0, 400),
    }));
    console.log("title:", info.title, "| url:", info.url);
    console.log("Cloudflare ещё держит?:", info.challenge, "| emailField:", info.emailField, "| passwordField:", info.passwordField);
    console.log("body:", info.bodyText);

    try {
      const ip = await ctx.newPage();
      await ip.goto("https://api.ipify.org", { timeout: 30000 });
      console.log("exit IP:", (await ip.evaluate(() => document.body.innerText)).trim());
      await ip.close();
    } catch (e) { console.log("ip-check:", e.message); }

    try { await page.screenshot({ path: "/root/vfs-bot/recon_bd.png" }); console.log("screenshot → recon_bd.png"); } catch (_) {}
  } catch (e) {
    console.error("RECON_BD ERROR:", e.message);
  } finally {
    try { await browser.close(); } catch (_) {}
  }
})();
