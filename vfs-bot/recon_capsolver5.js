// VFS: главная → надёжный клик «Book an appointment» (ожидание перехода) → дамп всех
// интерактивных элементов, чтобы найти вход. Запуск: node recon_capsolver5.js
require("dotenv").config();
const { chromium } = require("patchright");
const KEY = process.env.CAPSOLVER_KEY, PROXY = process.env.MOBILE_PROXY;
const BASE = "https://visa.vfsglobal.com/rus/en/fra", LOGIN = BASE + "/login", INTERIM = BASE + "/interim";

function pp(s) { const m = String(s || "").match(/^(https?):\/\/(?:([^:@]+):([^@]+)@)?([^:\/]+):(\d+)/); return m ? { scheme: m[1], host: m[4], port: m[5], user: m[2], pass: m[3] } : null; }
async function post(u, b) { return (await fetch(u, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) })).json(); }
async function capsolve(t) { const p = pp(PROXY); const c = await post("https://api.capsolver.com/createTask", { clientKey: KEY, task: { type: "AntiCloudflareTask", websiteURL: t, proxy: p.scheme + ":" + p.host + ":" + p.port + ":" + p.user + ":" + p.pass } }); if (c.errorId) throw new Error(c.errorDescription); for (let i = 0; i < 40; i++) { await new Promise(r => setTimeout(r, 3000)); const res = await post("https://api.capsolver.com/getTaskResult", { clientKey: KEY, taskId: c.taskId }); if (res.status === "ready") return res.solution; if (res.status === "failed" || res.errorId) throw new Error(res.errorDescription); } throw new Error("timeout"); }
async function dump(page, tag) {
  const s = await page.evaluate(() => {
    const els = Array.from(document.querySelectorAll("a,button,input")).map((el) => {
      const r = el.getBoundingClientRect(); if (r.width === 0 && r.height === 0) return null;
      return { tag: el.tagName, t: (el.innerText || el.value || "").trim().replace(/\s+/g, " ").slice(0, 30), href: el.getAttribute("href") || "", type: el.getAttribute("type") || "", id: el.id || "", name: el.getAttribute("name") || "" };
    }).filter(Boolean);
    return { title: (document.title || "").slice(0, 60), url: location.href, sessionErr: /session expired|unable to progress/i.test((document.body && document.body.innerText) || ""), n: els.length, els: els.slice(0, 45) };
  });
  console.log("=== " + tag + " === url:", s.url, "| sessionErr:", s.sessionErr, "| элементов:", s.n);
  s.els.forEach((e) => console.log("  [" + e.tag + (e.type ? ":" + e.type : "") + "] " + (e.t || "·") + (e.href ? "  → " + e.href : "") + (e.id ? "  #" + e.id : "") + (e.name ? "  name=" + e.name : "")));
}

(async () => {
  if (!KEY || !PROXY) { console.error("нет ключа/прокси"); process.exit(0); }
  let sol; try { sol = await capsolve(LOGIN); } catch (e) { console.error("CAPSOLVER ERROR:", e.message); process.exit(0); }
  const ua = sol.userAgent || sol.user_agent || undefined;
  const ck = []; if (Array.isArray(sol.cookies)) for (const c of sol.cookies) ck.push({ name: c.name, value: String(c.value), domain: c.domain || "visa.vfsglobal.com", path: c.path || "/", secure: true }); else if (sol.cookies) for (const k of Object.keys(sol.cookies)) ck.push({ name: k, value: String(sol.cookies[k]), url: "https://visa.vfsglobal.com/" });
  console.log("CF решён.");
  const p = pp(PROXY);
  const browser = await chromium.launch({ headless: true, proxy: { server: "http://" + p.host + ":" + p.port, username: p.user, password: p.pass }, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  const ctx = await browser.newContext({ userAgent: ua, locale: "ru-RU", timezoneId: "Europe/Moscow", viewport: { width: 1366, height: 768 } });
  try { if (ck.length) await ctx.addCookies(ck); } catch (e) {}
  const page = await ctx.newPage();
  try {
    await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 90000 });
    await page.waitForTimeout(9000);
    const cb = await page.$("#onetrust-accept-btn-handler"); if (cb) { await cb.click().catch(() => {}); await page.waitForTimeout(1500); }

    console.log("→ клик «Book an appointment» (роль-локатор + ожидание)…");
    try {
      const link = page.getByRole("link", { name: /book an appointment/i }).first();
      await link.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {});
      await link.click({ timeout: 8000 }).catch((e) => console.log("click err:", e.message));
      await page.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => {});
      await page.waitForTimeout(4000);
    } catch (e) { console.log("locator err:", e.message); }
    await dump(page, "после клика");

    if (!/interim|login|apply/i.test(page.url())) {
      console.log("→ URL не изменился, пробую прямой /interim …");
      await page.goto(INTERIM, { waitUntil: "domcontentloaded", timeout: 90000 }).catch((e) => console.log("goto interim err:", e.message));
      await page.waitForTimeout(7000);
      await dump(page, "прямой /interim");
    }
    try { await page.screenshot({ path: "/root/vfs-bot/recon_cap5.png" }); console.log("screenshot → recon_cap5.png"); } catch (_) {}
  } catch (e) { console.error("NAV ERROR:", e.message); }
  finally { await browser.close(); }
})();
