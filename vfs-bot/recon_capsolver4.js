// VFS: главная → «Book an appointment» (/interim) внутри SPA → смотрим вход.
// Запуск: node recon_capsolver4.js
require("dotenv").config();
const { chromium } = require("patchright");

const KEY = process.env.CAPSOLVER_KEY;
const PROXY = process.env.MOBILE_PROXY;
const BASE = "https://visa.vfsglobal.com/rus/en/fra";
const LOGIN = "https://visa.vfsglobal.com/rus/en/fra/login";

function parseProxy(s) { const m = String(s || "").match(/^(https?):\/\/(?:([^:@]+):([^@]+)@)?([^:\/]+):(\d+)/); return m ? { scheme: m[1], host: m[4], port: m[5], user: m[2], pass: m[3] } : null; }
async function post(url, body) { const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }); return r.json(); }
async function capsolve(t) {
  const p = parseProxy(PROXY); const proxyStr = p.scheme + ":" + p.host + ":" + p.port + ":" + p.user + ":" + p.pass;
  const c = await post("https://api.capsolver.com/createTask", { clientKey: KEY, task: { type: "AntiCloudflareTask", websiteURL: t, proxy: proxyStr } });
  if (c.errorId) throw new Error("createTask: " + (c.errorDescription || c.errorCode));
  for (let i = 0; i < 40; i++) { await new Promise((r) => setTimeout(r, 3000)); const res = await post("https://api.capsolver.com/getTaskResult", { clientKey: KEY, taskId: c.taskId }); if (res.status === "ready") return res.solution; if (res.status === "failed" || res.errorId) throw new Error(res.errorDescription || res.errorCode); }
  throw new Error("timeout");
}
async function snap(page, tag) {
  const s = await page.evaluate(() => ({
    title: (document.title || "").slice(0, 70), url: location.href,
    email: !!document.querySelector("input[type='email'],input[name*='mail' i],#email,#mat-input-0"),
    pass: !!document.querySelector("input[type='password']"),
    sessionErr: /session expired|unable to progress/i.test((document.body && document.body.innerText) || ""),
    body: ((document.body && document.body.innerText) || "").replace(/\s+/g, " ").slice(0, 220),
    cands: Array.from(document.querySelectorAll("a,button")).map((el) => { const t = (el.innerText || "").trim().replace(/\s+/g, " ").slice(0, 35); return /log\s?in|sign\s?in|войти|continue|next|verify|otp|email|account|proceed/i.test(t) ? { t: t, href: el.getAttribute("href") || "" } : null; }).filter(Boolean).slice(0, 12),
  }));
  console.log(tag + ":", JSON.stringify(s));
}

(async () => {
  if (!KEY || !PROXY) { console.error("нет ключа/прокси"); process.exit(0); }
  let sol; try { sol = await capsolve(LOGIN); } catch (e) { console.error("CAPSOLVER ERROR:", e.message); process.exit(0); }
  const ua = sol.userAgent || sol.user_agent || undefined;
  const cookieList = [];
  if (Array.isArray(sol.cookies)) for (const c of sol.cookies) cookieList.push({ name: c.name, value: String(c.value), domain: c.domain || "visa.vfsglobal.com", path: c.path || "/", secure: true });
  else if (sol.cookies && typeof sol.cookies === "object") for (const k of Object.keys(sol.cookies)) cookieList.push({ name: k, value: String(sol.cookies[k]), url: "https://visa.vfsglobal.com/" });
  console.log("CF решён.");

  const p = parseProxy(PROXY);
  const browser = await chromium.launch({ headless: true, proxy: { server: "http://" + p.host + ":" + p.port, username: p.user, password: p.pass }, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  const ctx = await browser.newContext({ userAgent: ua, locale: "ru-RU", timezoneId: "Europe/Moscow", viewport: { width: 1366, height: 768 } });
  try { if (cookieList.length) await ctx.addCookies(cookieList); } catch (e) {}
  const page = await ctx.newPage();
  try {
    await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 90000 });
    await page.waitForTimeout(10000);
    // закрыть возможный cookie-consent
    for (const sel of ["#onetrust-accept-btn-handler", "button:has-text('Accept')", "button:has-text('Принять')", "button:has-text('Agree')"]) {
      const b = await page.$(sel); if (b) { await b.click().catch(() => {}); console.log("закрыл consent:", sel); await page.waitForTimeout(1500); break; }
    }
    await snap(page, "главная");

    // клик «Book an appointment» → /interim (SPA)
    let clicked = false;
    for (const sel of ["a[href$='/interim']", "a[href*='/interim']", "a:has-text('Book an appointment')", "a:has-text('Book now')"]) {
      const el = await page.$(sel);
      if (el) { console.log("→ кликаю:", sel); await Promise.all([page.waitForTimeout(11000), el.click().catch(() => {})]); clicked = true; break; }
    }
    if (!clicked) console.log("кнопку записи не нашёл");
    await snap(page, "после клика (interim)");

    try { await page.screenshot({ path: "/root/vfs-bot/recon_cap4.png", fullPage: false }); console.log("screenshot → recon_cap4.png"); } catch (_) {}
  } catch (e) { console.error("NAV ERROR:", e.message); }
  finally { await browser.close(); }
})();
