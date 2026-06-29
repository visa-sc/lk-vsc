// РАЗВЕДКА (одноразовый запуск, не цикл): открыть страницу VFS через прокси,
// снять статус/заголовок/наличие DataDome/форму входа и скриншот.
// Запуск: node recon.js [URL]
require("dotenv").config();
const { chromium } = require("playwright");

function parseProxy(s) {
  if (!s) return undefined;
  s = String(s).trim();
  let m = s.match(/^(https?):\/\/(?:([^:@]+):([^@]+)@)?([^:\/]+):(\d+)/);
  if (m) return { server: m[1] + "://" + m[4] + ":" + m[5], username: m[2], password: m[3] };
  const p = s.split(":"); // host:port:user:pass
  if (p.length === 4) return { server: "http://" + p[0] + ":" + p[1], username: p[2], password: p[3] };
  return undefined;
}

(async () => {
  const URL = process.argv[2] || "https://visa.vfsglobal.com/rus/en/fra/login";
  const proxy = parseProxy(process.env.PROXY_URL);
  console.log("URL:", URL);
  console.log("proxy:", proxy ? proxy.server + " (user " + (proxy.username || "").slice(0, 4) + "…)" : "NONE — будет IP датацентра, DataDome заблокирует");

  const browser = await chromium.launch({
    headless: true,
    proxy,
    args: ["--no-sandbox", "--disable-blink-features=AutomationControlled", "--disable-dev-shm-usage"],
  });
  const ctx = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
    viewport: { width: 1366, height: 768 },
    locale: "ru-RU",
    timezoneId: "Europe/Moscow",
  });
  const page = await ctx.newPage();

  // Чек внешнего IP через прокси (подтверждает, что трафик идёт резидентно).
  try {
    const ipPage = await ctx.newPage();
    await ipPage.goto("https://api.ipify.org?format=json", { timeout: 30000 });
    console.log("exit IP:", (await ipPage.evaluate(() => document.body.innerText)).slice(0, 120));
    await ipPage.close();
  } catch (e) { console.log("ip-check failed:", e.message); }

  try {
    const resp = await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 60000 });
    console.log("goto HTTP status:", resp && resp.status());
    await page.waitForTimeout(7000);
    const title = await page.title();
    const info = await page.evaluate(() => {
      const html = document.documentElement.outerHTML;
      return {
        hasDataDome:
          /datadome/i.test(html.slice(0, 8000)) ||
          !!document.querySelector("[id*='datadome' i],[class*='datadome' i],iframe[src*='captcha-delivery']"),
        captchaIframe: !!document.querySelector("iframe[src*='captcha-delivery'],iframe[src*='geo.captcha']"),
        emailField: !!document.querySelector("input[type='email'],input[name*='mail' i],#email,#mat-input-0"),
        passwordField: !!document.querySelector("input[type='password']"),
        bodyText: (document.body ? document.body.innerText : "").replace(/\s+/g, " ").slice(0, 700),
      };
    });
    console.log("title:", title);
    console.log("hasDataDome:", info.hasDataDome, "| captchaIframe:", info.captchaIframe, "| emailField:", info.emailField, "| passwordField:", info.passwordField);
    console.log("bodyText:", info.bodyText);
    await page.screenshot({ path: __dirname + "/recon.png", fullPage: false });
    console.log("screenshot → recon.png");
  } catch (e) {
    console.error("RECON ERROR:", e.message);
    try { await page.screenshot({ path: __dirname + "/recon-error.png" }); console.log("screenshot → recon-error.png"); } catch (_) {}
  } finally {
    await browser.close();
  }
})();
