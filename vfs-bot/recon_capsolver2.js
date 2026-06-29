// VFS через CapSolver: cf_clearance + ПРАВИЛЬНЫЙ путь (главная → сессия → логин).
// Запуск: node recon_capsolver2.js
require("dotenv").config();
const { chromium } = require("patchright");

const KEY = process.env.CAPSOLVER_KEY;
const PROXY = process.env.MOBILE_PROXY;
const BASE = "https://visa.vfsglobal.com/rus/en/fra";
const LOGIN = "https://visa.vfsglobal.com/rus/en/fra/login";

function parseProxy(s) {
  const m = String(s || "").match(/^(https?):\/\/(?:([^:@]+):([^@]+)@)?([^:\/]+):(\d+)/);
  return m ? { scheme: m[1], host: m[4], port: m[5], user: m[2], pass: m[3] } : null;
}
async function post(url, body) {
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return r.json();
}
async function capsolve(targetUrl) {
  const p = parseProxy(PROXY);
  const proxyStr = p.scheme + ":" + p.host + ":" + p.port + ":" + p.user + ":" + p.pass;
  const create = await post("https://api.capsolver.com/createTask", { clientKey: KEY, task: { type: "AntiCloudflareTask", websiteURL: targetUrl, proxy: proxyStr } });
  if (create.errorId) throw new Error("createTask: " + (create.errorDescription || create.errorCode));
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    const res = await post("https://api.capsolver.com/getTaskResult", { clientKey: KEY, taskId: create.taskId });
    if (res.status === "ready") return res.solution;
    if (res.status === "failed" || res.errorId) throw new Error("getTaskResult: " + (res.errorDescription || res.errorCode));
  }
  throw new Error("CapSolver timeout");
}
async function state(page) {
  return page.evaluate(() => ({
    title: (document.title || "").slice(0, 90), url: location.href,
    emailField: !!document.querySelector("input[type='email'],input[name*='mail' i],#email,#mat-input-0"),
    passwordField: !!document.querySelector("input[type='password']"),
    challenge: /just a moment|момент|проверка безопас/i.test((document.title || "") + " " + ((document.body && document.body.innerText) || "")),
    sessionErr: /session expired|unable to progress|сесси/i.test((document.body && document.body.innerText) || ""),
  }));
}

(async () => {
  if (!KEY || !PROXY) { console.error("нет ключа/прокси"); process.exit(1); }
  let sol;
  try { sol = await capsolve(LOGIN); } catch (e) { console.error("CAPSOLVER ERROR:", e.message); process.exit(0); }
  const ua = sol.userAgent || sol.user_agent || undefined;
  const cookieList = [];
  if (Array.isArray(sol.cookies)) for (const c of sol.cookies) cookieList.push({ name: c.name, value: String(c.value), domain: c.domain || "visa.vfsglobal.com", path: c.path || "/", secure: true });
  else if (sol.cookies && typeof sol.cookies === "object") for (const k of Object.keys(sol.cookies)) cookieList.push({ name: k, value: String(sol.cookies[k]), url: "https://visa.vfsglobal.com/" });
  console.log("CF решён. UA:", ua, "| куки:", cookieList.map((c) => c.name).join(","));

  const p = parseProxy(PROXY);
  const browser = await chromium.launch({ headless: true, proxy: { server: "http://" + p.host + ":" + p.port, username: p.user, password: p.pass }, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  const ctx = await browser.newContext({ userAgent: ua, locale: "ru-RU", timezoneId: "Europe/Moscow", viewport: { width: 1366, height: 768 } });
  try { if (cookieList.length) await ctx.addCookies(cookieList); } catch (e) {}
  const page = await ctx.newPage();
  try {
    console.log("→ ГЛАВНАЯ:", BASE);
    let r = await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 90000 });
    console.log("  status:", r && r.status());
    await page.waitForTimeout(9000);
    console.log("  ", JSON.stringify(await state(page)));

    console.log("→ ЛОГИН:", LOGIN);
    r = await page.goto(LOGIN, { waitUntil: "domcontentloaded", timeout: 90000 });
    console.log("  status:", r && r.status());
    await page.waitForTimeout(9000);
    console.log("  ", JSON.stringify(await state(page)));
    try { await page.screenshot({ path: "/root/vfs-bot/recon_cap2.png" }); console.log("screenshot → recon_cap2.png"); } catch (_) {}
  } catch (e) { console.error("NAV ERROR:", e.message); }
  finally { await browser.close(); }
})();
