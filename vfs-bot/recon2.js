// РАЗВЕДКА 2 — анти-детект (patchright) против Cloudflare на VFS.
// Запуск: node recon2.js [URL]
require("dotenv").config();
const { chromium } = require("patchright");
const fs = require("fs");

function parseProxy(s) {
  if (!s) return undefined;
  s = String(s).trim();
  let m = s.match(/^(https?):\/\/(?:([^:@]+):([^@]+)@)?([^:\/]+):(\d+)/);
  if (m) return { server: m[1] + "://" + m[4] + ":" + m[5], username: m[2], password: m[3] };
  const p = s.split(":");
  if (p.length === 4) return { server: "http://" + p[0] + ":" + p[1], username: p[2], password: p[3] };
  return undefined;
}

(async () => {
  const URL = process.argv[2] || "https://visa.vfsglobal.com/rus/en/fra/login";
  const proxy = parseProxy(process.env.PROXY_URL);
  console.log("URL:", URL, "| proxy:", proxy ? proxy.server : "NONE");

  // patchright: персистентный контекст, без подмены UA, без отключения automation-флагов вручную.
  const ctx = await chromium.launchPersistentContext("/root/vfs-bot/.pw-profile", {
    headless: true,
    proxy,
    viewport: { width: 1366, height: 768 },
    locale: "ru-RU",
    timezoneId: "Europe/Moscow",
  });
  const page = ctx.pages()[0] || (await ctx.newPage());

  try {
    const resp = await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 60000 });
    console.log("goto HTTP status:", resp && resp.status());

    // Ждём авто-снятия челленджа Cloudflare до 35с: появление формы или смена заголовка.
    let cleared = false;
    for (let t = 0; t < 35; t++) {
      await page.waitForTimeout(1000);
      const st = await page.evaluate(() => {
        const title = document.title || "";
        const challenge = /момент|just a moment|проверка безопасности|checking/i.test(title) ||
          /проверк|security check/i.test((document.body && document.body.innerText) || "");
        const hasForm = !!document.querySelector("input[type='password'],input[type='email'],input[name*='mail' i]");
        return { title, challenge, hasForm };
      });
      if (st.hasForm || !st.challenge) { cleared = true; console.log("cleared after", t + 1, "s | title:", st.title, "| form:", st.hasForm); break; }
      if (t === 8 || t === 20) console.log("  …still on challenge at", t + 1, "s | title:", st.title);
    }

    const info = await page.evaluate(() => ({
      title: document.title,
      url: location.href,
      status200ish: !/момент|just a moment|проверка/i.test(document.title),
      emailField: !!document.querySelector("input[type='email'],input[name*='mail' i],#email,#mat-input-0"),
      passwordField: !!document.querySelector("input[type='password']"),
      bodyText: ((document.body && document.body.innerText) || "").replace(/\s+/g, " ").slice(0, 500),
    }));
    console.log("FINAL cleared:", cleared);
    console.log("title:", info.title, "| url:", info.url);
    console.log("emailField:", info.emailField, "| passwordField:", info.passwordField);
    console.log("bodyText:", info.bodyText);
    await page.screenshot({ path: "/root/vfs-bot/recon2.png" });
    console.log("screenshot → recon2.png");
  } catch (e) {
    console.error("RECON2 ERROR:", e.message);
    try { await page.screenshot({ path: "/root/vfs-bot/recon2-error.png" }); } catch (_) {}
  } finally {
    await ctx.close();
  }
})();
