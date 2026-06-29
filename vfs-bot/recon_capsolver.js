// VFS через CapSolver (решение Cloudflare) + chromium(patchright) с нашим мобильным прокси.
// CapSolver получает cf_clearance через НАШ прокси → подставляем куку+UA в браузер.
// Запуск: node recon_capsolver.js [URL]
require("dotenv").config();
const { chromium } = require("patchright");

const KEY = process.env.CAPSOLVER_KEY;
const PROXY = process.env.MOBILE_PROXY; // http://user:pass@host:port
const URL = process.argv[2] || "https://visa.vfsglobal.com/rus/en/fra/login";

function parseProxy(s) {
  const m = String(s || "").match(/^(https?):\/\/(?:([^:@]+):([^@]+)@)?([^:\/]+):(\d+)/);
  return m ? { scheme: m[1], host: m[4], port: m[5], user: m[2], pass: m[3] } : null;
}

async function post(url, body) {
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return r.json();
}

async function capsolve() {
  const p = parseProxy(PROXY);
  const proxyStr = p.scheme + ":" + p.host + ":" + p.port + ":" + p.user + ":" + p.pass;
  const create = await post("https://api.capsolver.com/createTask", {
    clientKey: KEY,
    task: { type: "AntiCloudflareTask", websiteURL: URL, proxy: proxyStr },
  });
  console.log("createTask:", JSON.stringify(create).slice(0, 300));
  if (create.errorId) throw new Error("createTask: " + (create.errorDescription || create.errorCode));
  const taskId = create.taskId;
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    const res = await post("https://api.capsolver.com/getTaskResult", { clientKey: KEY, taskId });
    if (res.status === "ready") { console.log("SOLUTION:", JSON.stringify(res.solution).slice(0, 700)); return res.solution; }
    if (res.status === "failed" || res.errorId) throw new Error("getTaskResult: " + (res.errorDescription || res.errorCode));
    if (i % 3 === 0) console.log("  …solving", (i + 1) * 3, "s");
  }
  throw new Error("CapSolver timeout");
}

(async () => {
  if (!KEY) { console.error("нет CAPSOLVER_KEY"); process.exit(1); }
  if (!PROXY) { console.error("нет MOBILE_PROXY"); process.exit(1); }

  let sol;
  try { sol = await capsolve(); } catch (e) { console.error("CAPSOLVER ERROR:", e.message); process.exit(1); }

  const ua = sol.userAgent || sol.user_agent || null;
  const cookieList = [];
  if (Array.isArray(sol.cookies)) {
    for (const c of sol.cookies) cookieList.push({ name: c.name, value: String(c.value), domain: c.domain || "visa.vfsglobal.com", path: c.path || "/", secure: true });
  } else if (sol.cookies && typeof sol.cookies === "object") {
    for (const k of Object.keys(sol.cookies)) cookieList.push({ name: k, value: String(sol.cookies[k]), url: "https://visa.vfsglobal.com/" });
  }
  if (sol.cf_clearance) cookieList.push({ name: "cf_clearance", value: String(sol.cf_clearance), url: "https://visa.vfsglobal.com/" });
  console.log("UA:", ua, "| cookies:", cookieList.map((c) => c.name).join(",") || "НЕТ", "| token:", sol.token ? "есть" : "нет");

  const p = parseProxy(PROXY);
  const browser = await chromium.launch({
    headless: true,
    proxy: { server: "http://" + p.host + ":" + p.port, username: p.user, password: p.pass },
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  const ctx = await browser.newContext({
    userAgent: ua || undefined,
    locale: "ru-RU", timezoneId: "Europe/Moscow", viewport: { width: 1366, height: 768 },
  });
  try { if (cookieList.length) await ctx.addCookies(cookieList); } catch (e) { console.log("addCookies warn:", e.message); }
  const page = await ctx.newPage();
  try {
    const resp = await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 90000 });
    console.log("goto status:", resp && resp.status());
    await page.waitForTimeout(7000);
    const info = await page.evaluate(() => ({
      title: document.title, url: location.href,
      emailField: !!document.querySelector("input[type='email'],input[name*='mail' i],#email,#mat-input-0"),
      passwordField: !!document.querySelector("input[type='password']"),
      challenge: /just a moment|момент|проверка безопас|checking/i.test((document.title || "") + " " + ((document.body && document.body.innerText) || "")),
      body: ((document.body && document.body.innerText) || "").replace(/\s+/g, " ").slice(0, 350),
    }));
    console.log("FINAL title:", info.title, "| url:", info.url);
    console.log("challenge ещё держит?:", info.challenge, "| emailField:", info.emailField, "| passwordField:", info.passwordField);
    console.log("body:", info.body);
    try { await page.screenshot({ path: "/root/vfs-bot/recon_cap.png" }); console.log("screenshot → recon_cap.png"); } catch (_) {}
  } catch (e) {
    console.error("NAV ERROR:", e.message);
  } finally {
    await browser.close();
  }
})();
