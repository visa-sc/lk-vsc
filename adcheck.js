// ═══════════════════════════════════════════════════════════════════════════
// Ночная проверка посадочных страниц Яндекс.Директа (просьба Андрея 23.09.2026).
//
// Зачем: объявление может вести на битую страницу, и мы узнаём об этом только
// когда кто-то случайно кликнет. Здесь наоборот: каждую ночь сами обходим все
// страницы, на которые ведёт реклама, и показываем в дашборде, где непорядок.
//
// Что берём из Директа: кампании в состоянии ON и со статусом ACCEPTED, у них
// активные объявления, у объявлений ссылку и набор быстрых ссылок. Метки после
// «?» отбрасываем — страница одна и та же, проверять её десять раз ни к чему:
// 2174 ссылки схлопываются в 170 страниц.
//
// Как проверяем: открываем страницу в headless Chrome (он уже стоит на проде
// для /phone_test) и после отработки скриптов снимаем с неё мерки. Шапка и
// подвал на Flexbe дорисовываются скриптами, поэтому по сырому HTML судить
// нельзя — только по отрендеренному DOM.
//
// Что считаем изъяном:
//   • страница не открылась или ответила 4xx/5xx;
//   • нет шапки (ни логотипа, ни меню, ни телефона в верхних 200 пикселях);
//   • нет подвала;
//   • битые картинки (после прокрутки до низа, чтобы не путать с ленивой загрузкой);
//   • горизонтальная прокрутка — вёрстка вылезает за экран;
//   • поля формы шире 600 пикселей — растянуты.
// Подозрительные страницы прогоняем ВТОРОЙ раз: на медленной загрузке легко
// принять ещё не дорисованную шапку за отсутствующую.
// ═══════════════════════════════════════════════════════════════════════════
const fs = require("fs");
const path = require("path");
const axios = require("axios");

const FILE = path.join(__dirname, ".vscAdCheck.json");
const YD_API = "https://api.direct.yandex.com/json/v5/";
// На проде два гигабайта памяти, а Chrome прожорлив: на трёх вкладках разом
// свободными оставалось меньше 250 МБ. Двух хватает, ночью спешить некуда.
const CONCURRENCY = Number(process.env.ADCHECK_CONCURRENCY || 2);
const PAGE_TIMEOUT = 45000;

function ydHeaders() {
  const h = {
    Authorization: "Bearer " + (process.env.YANDEX_DIRECT_TOKEN || ""),
    "Accept-Language": "ru", "Content-Type": "application/json; charset=utf-8",
  };
  if (process.env.YANDEX_DIRECT_LOGIN) h["Client-Login"] = process.env.YANDEX_DIRECT_LOGIN;
  return h;
}
async function ydCall(svc, params) {
  const r = await axios.post(YD_API + svc, { method: "get", params }, { headers: ydHeaders(), timeout: 60000, validateStatus: () => true });
  if (r.data && r.data.error) throw new Error(svc + ": " + (r.data.error.error_string || JSON.stringify(r.data.error)).slice(0, 160));
  return (r.data && r.data.result) || {};
}

// ── Сбор страниц, на которые ведёт живая реклама ─────────────────────────────
async function collectPages() {
  const c = await ydCall("campaigns", { SelectionCriteria: { States: ["ON"], Statuses: ["ACCEPTED"] }, FieldNames: ["Id", "Name"] });
  const camps = c.Campaigns || [];
  const nameOf = {}; camps.forEach((x) => { nameOf[x.Id] = x.Name; });
  const ids = camps.map((x) => x.Id);
  const ads = [];
  for (let i = 0; i < ids.length; i += 10) {           // в запрос влезает не больше десяти кампаний
    const part = ids.slice(i, i + 10);
    for (let off = 0; ; off += 1000) {
      const a = await ydCall("ads", {
        SelectionCriteria: { CampaignIds: part, States: ["ON"], Statuses: ["ACCEPTED"] },
        FieldNames: ["Id", "CampaignId", "AdGroupId"], TextAdFieldNames: ["Href", "SitelinkSetId"],
        Page: { Limit: 1000, Offset: off },
      });
      const chunk = a.Ads || [];
      chunk.forEach((x) => ads.push(x));
      if (chunk.length < 1000) break;
    }
  }
  // Названия групп: в отчёте нужно понимать, какая именно группа ведёт на битую
  // страницу, а не только кампания.
  const groupIds = [...new Set(ads.map((x) => x.AdGroupId).filter(Boolean))];
  const groupName = {};
  for (let i = 0; i < groupIds.length; i += 1000) {
    try {
      const g = await ydCall("adgroups", { SelectionCriteria: { Ids: groupIds.slice(i, i + 1000) }, FieldNames: ["Id", "Name"] });
      (g.AdGroups || []).forEach((x) => { groupName[x.Id] = x.Name; });
    } catch (e) { console.error("adcheck adgroups:", e.message); }
  }
  // url → { camps:Set, groups:Set, fromAd:bool }
  const raw = new Map();
  const setIds = new Set();
  const add = (href, camp, grp, fromAd) => {
    if (!href) return;
    const cur = raw.get(href) || { camps: new Set(), groups: new Set(), fromAd: false };
    if (camp) cur.camps.add(camp);
    if (grp) cur.groups.add(grp);
    cur.fromAd = cur.fromAd || !!fromAd;
    raw.set(href, cur);
  };
  ads.forEach((x) => {
    const t = x.TextAd || {};
    add(t.Href, nameOf[x.CampaignId], groupName[x.AdGroupId], true);
    if (t.SitelinkSetId) setIds.add(t.SitelinkSetId);
  });
  // быстрые ссылки: к какой кампании относится набор, знаем по объявлениям
  const setToCamps = {};
  ads.forEach((x) => { const t = x.TextAd || {}; if (t.SitelinkSetId) { (setToCamps[t.SitelinkSetId] = setToCamps[t.SitelinkSetId] || new Set()).add(nameOf[x.CampaignId]); } });
  const sl = [...setIds];
  for (let i = 0; i < sl.length; i += 50) {
    const a = await ydCall("sitelinks", { SelectionCriteria: { Ids: sl.slice(i, i + 50) }, FieldNames: ["Id", "Sitelinks"] });
    (a.SitelinksSets || []).forEach((s) => {
      const cs = setToCamps[s.Id] || new Set();
      (s.Sitelinks || []).forEach((x) => { cs.forEach((cn) => add(x.Href, cn, null, false)); if (!cs.size) add(x.Href, null, null, false); });
    });
  }
  // схлопываем метки: страница одна и та же
  const pages = new Map();
  raw.forEach((v, href) => {
    let key;
    try { const u = new URL(href); key = u.origin + u.pathname.replace(/\/+$/, ""); } catch (_) { return; }
    if (/^https?:\/\/t\.me/i.test(key)) return;        // мессенджер проверять нечего
    // Кривой адрес: в быстрой ссылке попадается второй «?» вместо «&» — параметры
    // склеиваются в мусор, и человек уходит не на ту страницу.
    const badLink = (String(href).match(/\?/g) || []).length > 1 ? "два знака «?» в ссылке" : null;
    const cur = pages.get(key) || { url: key, camps: new Set(), groups: new Set(), fromAd: false, sample: href, badLink: null };
    if (badLink && !cur.badLink) cur.badLink = badLink;
    v.camps.forEach((c) => c && cur.camps.add(c));
    (v.groups || new Set()).forEach((g) => g && cur.groups.add(g));
    cur.fromAd = cur.fromAd || v.fromAd;
    pages.set(key, cur);
  });
  return { campaigns: camps.length, ads: ads.length, pages: [...pages.values()] };
}

// ── Осмотр одной страницы в браузере ────────────────────────────────────────
function findChrome() {
  const root = path.join(__dirname, ".chrome", "chrome");
  try {
    for (const ver of fs.readdirSync(root)) {
      const p = path.join(root, ver, "chrome-linux64", "chrome");
      if (fs.existsSync(p)) return p;
    }
  } catch (_) {}
  return null;
}
const MEASURE = `(() => {
  const vw = window.innerWidth, vh = window.innerHeight;
  const vis = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none" && +s.opacity > 0.05; };
  // Шапка. По именам классов судить нельзя: на voyomobile она свёрстана классами
  // hdr/brand/lg и под привычные селекторы не попадала — выходила ложная тревога.
  // Поэтому смотрим на смысл: в верхних 170 пикселях должен быть логотип
  // (картинка или svg), либо пара ссылок, либо телефон.
  let header = false;
  {
    const topEls = [...document.querySelectorAll("body *")].filter((el) => {
      if (!vis(el)) return false;
      const r = el.getBoundingClientRect();
      return r.top >= -20 && r.top < 170 && r.width > 24;
    });
    const logo = topEls.some((el) => (el.tagName === "IMG" || el.tagName === "SVG" || el.tagName === "svg") && el.getBoundingClientRect().width > 24);
    const links = topEls.filter((el) => el.tagName === "A").length;
    const phone = topEls.some((el) => el.tagName === "A" && /^tel:/i.test(el.getAttribute("href") || ""));
    const named = topEls.some((el) => /header|nav|logo|menu|brand|hdr/i.test(String(el.className || "") + " " + String(el.id || "")));
    header = logo || phone || links >= 2 || named;
  }
  // Подвал. На Flexbe тега footer нет вообще — низ страницы собран из обычных
  // блоков. Поэтому ищем не тег, а смысл: в нижней трети должен быть телефон,
  // копирайт, реквизиты или ссылка на политику. Так подвал находится и там, где
  // вёрстка нестандартная, и честно не находится там, где его правда нет.
  const docH = document.documentElement.scrollHeight;
  let footer = false;
  const FOOT_RE = /©|\(с\)|политик[аи] конфиденц|пользовательское соглашение|все права защищ|инн\s*\d|огрн|реквизит|ооо\s*«|ооо\s+"|\bип\s+[А-ЯЁ]|сервис компании|оферт/i;
  const bot = [...document.querySelectorAll("footer, [class*=footer], [id*=footer], [class*=podval]")];
  for (const el of bot) {
    if (!vis(el)) continue;
    const r = el.getBoundingClientRect();
    if (r.top + window.scrollY > docH * 0.5) { footer = true; break; }
  }
  if (!footer) {
    const all = [...document.querySelectorAll("body *")];
    for (const el of all) {
      if (el.children.length > 3 || !vis(el)) continue;         // берём листья, не контейнеры
      const r = el.getBoundingClientRect();
      const y = r.top + window.scrollY;
      if (y < docH * 0.66) continue;                            // только низ страницы
      const t = (el.textContent || "").trim();
      if (t.length > 400) continue;
      if (FOOT_RE.test(t) || (el.tagName === "A" && /^tel:/i.test(el.getAttribute("href") || ""))) { footer = true; break; }
    }
  }
  // Битые картинки — только видимые и только с адресом.
  const imgs = [...document.images].filter((i) => i.src && vis(i));
  const broken = imgs.filter((i) => i.complete && i.naturalWidth === 0).map((i) => i.src).slice(0, 8);
  // Поля формы: самое широкое.
  const fields = [...document.querySelectorAll("input:not([type=hidden]):not([type=submit]):not([type=checkbox]):not([type=radio]), textarea, select")].filter(vis);
  const widest = fields.reduce((m, f) => Math.max(m, Math.round(f.getBoundingClientRect().width)), 0);
  // Вылезает ли вёрстка. Считать по scrollWidth нельзя: на Flexbe фон-контейнер
  // шире экрана, но вбок страница не двигается — выходила ложная тревога на ВНЖ
  // Испании (Андрей проверил руками 24.09.2026). Поэтому честно пробуем прокрутить
  // вправо и смотрим, сдвинулось ли что-нибудь.
  const sx = window.scrollX;
  window.scrollTo(99999, window.scrollY);
  const moved = Math.round(window.scrollX - sx);
  window.scrollTo(sx, window.scrollY);
  return {
    header, footer, broken, imgs: imgs.length, fields: fields.length, widest,
    overflow: moved > 4 ? moved : 0,
    title: (document.title || "").slice(0, 120),
    textLen: (document.body ? document.body.innerText.length : 0),
    vw, vh, docH,
  };
})()`;

async function inspect(browser, url, deep) {
  const page = await browser.newPage();
  const out = { url };
  try {
    await page.setViewport({ width: 1280, height: 900 });
    await page.setDefaultNavigationTimeout(PAGE_TIMEOUT);
    let status = null;
    try {
      const resp = await page.goto(url, { waitUntil: "domcontentloaded", timeout: PAGE_TIMEOUT });
      status = resp ? resp.status() : null;
    } catch (e) {
      // Антибот на visa-sc.ru иногда рвёт переход, но страница при этом живая —
      // глотаем ошибку и смотрим, что в итоге отрисовалось.
      if (!/detached|Navigation/i.test(String(e.message))) throw e;
    }
    out.status = status;
    await new Promise((r) => setTimeout(r, deep ? 4000 : 2500));
    if (deep) {                                        // прокрутка до низа: добираем ленивые картинки
      await page.evaluate(`(async () => { const s = document.documentElement.scrollHeight;
        for (let y = 0; y < s; y += 600) { window.scrollTo(0, y); await new Promise((r) => setTimeout(r, 120)); }
        window.scrollTo(0, 0); })()`);
      await new Promise((r) => setTimeout(r, 1500));
    }
    // Часть адресов отдаёт 301 на версию со слешем, и замер падает на переходе
    // («Execution context was destroyed»). Это не изъян страницы — пережидаем
    // редирект и меряем ещё раз.
    let m;
    try { m = await page.evaluate(MEASURE); }
    catch (e) {
      if (!/context was destroyed|Execution context/i.test(String(e.message))) throw e;
      await new Promise((r) => setTimeout(r, 2500));
      m = await page.evaluate(MEASURE);
    }
    Object.assign(out, m);
  } catch (e) {
    out.error = String((e && e.message) || e).slice(0, 160);
  } finally {
    try { await page.close(); } catch (_) {}
  }
  return out;
}

// Из мерок делаем список претензий человеческим языком.
// Шапку и подвал спрашиваем только с наших визовых лендингов. У voyomobile это
// отдельный сервис со своей вёрсткой, там их и не должно быть (Андрей 24.09.2026).
function wantsChrome(url) { return /(^|\.)visa-sc\.ru$/i.test((() => { try { return new URL(url).hostname; } catch (_) { return ""; } })()); }
function faults(r) {
  const f = [];
  if (r.error) f.push("страница не открылась (" + r.error + ")");
  else {
    if (r.status && r.status >= 400) f.push("ответ " + r.status);
    if (r.textLen != null && r.textLen < 200 && !r.error) f.push("страница почти пустая");
    if (r.badLink) f.push("кривой адрес в объявлении: " + r.badLink);
    if (r.header === false && wantsChrome(r.url)) f.push("нет шапки");
    if (r.footer === false && wantsChrome(r.url)) f.push("нет подвала");
    if ((r.broken || []).length) f.push("не грузятся картинки: " + r.broken.length);
    if (r.overflow > 8) f.push("страница прокручивается вбок на " + r.overflow + " px");
    if (r.widest > 600) f.push("поля формы растянуты до " + r.widest + " px");
  }
  return f;
}

async function run(trigger) {
  const t0 = Date.now();
  let puppeteer;
  try { puppeteer = require("puppeteer"); } catch (_) { throw new Error("на сервере нет puppeteer"); }
  const collected = await collectPages();
  const list = collected.pages;
  const chromePath = findChrome();
  const browser = await puppeteer.launch({
    headless: "new", executablePath: chromePath || undefined,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
  });
  const results = [];
  try {
    let idx = 0;
    const worker = async () => {
      while (idx < list.length) {
        const p = list[idx++];
        const r = await inspect(browser, p.url, false);
        r.camps = [...p.camps]; r.groups = [...(p.groups || [])]; r.badLink = p.badLink || null; r.sample = p.sample;
        results.push(r);
        if (results.length % 25 === 0) console.log("ADCHECK: пройдено " + results.length + " из " + list.length);
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, list.length) }, worker));
    // Подозрительные — второй проход с прокруткой, чтобы отсеять ложные тревоги.
    const suspect = results.filter((r) => faults(r).length);
    if (suspect.length) console.log("ADCHECK: перепроверяю " + suspect.length + " подозрительных");
    for (const s of suspect) {
      const again = await inspect(browser, s.url, true);
      again.camps = s.camps; again.groups = s.groups; again.badLink = s.badLink; again.sample = s.sample;
      Object.assign(s, again);
      s.rechecked = true;
    }
  } finally {
    try { await browser.close(); } catch (_) {}
  }
  const problems = results.filter((r) => faults(r).length)
    .map((r) => ({ url: r.url, camps: r.camps || [], groups: (r.groups || []).slice(0, 4), status: r.status || null, sample: r.sample || null, faults: faults(r) }))
    .sort((a, b) => b.faults.length - a.faults.length);
  const out = {
    ts: Date.now(), trigger: trigger || "cron", tookMs: Date.now() - t0,
    campaigns: collected.campaigns, ads: collected.ads, pages: list.length,
    okPages: list.length - problems.length, problems,
  };
  // История за 30 дней: по одной записи на прогон, чтобы в логах было видно,
  // когда проблема появилась и когда ушла (просьба Андрея 23.09.2026).
  const prev = load() || {};
  const hist = Array.isArray(prev.history) ? prev.history : [];
  hist.unshift({ ts: out.ts, pages: out.pages, problems: problems.map((p) => ({ url: p.url, faults: p.faults, camps: p.camps })) });
  out.history = hist.filter((h) => h.ts >= Date.now() - 30 * 86400000).slice(0, 200);
  try { fs.writeFileSync(FILE, JSON.stringify(out, null, 1), "utf8"); } catch (e) { console.error("adcheck save:", e.message); }
  console.log("ADCHECK [" + out.trigger + "]: страниц " + out.pages + ", с изъянами " + problems.length + ", за " + Math.round(out.tookMs / 1000) + " с");
  return out;
}

function load() { try { return JSON.parse(fs.readFileSync(FILE, "utf8")); } catch (_) { return null; } }

module.exports = { run, load, collectPages, faults };
