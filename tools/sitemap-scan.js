#!/usr/bin/env node
/*
 * КАРТА ВСЕГО (ak-co.ru/map) — сканер живой инфраструктуры.
 *
 * Смысл: структура сервисов не должна поддерживаться руками, иначе она протухает
 * через неделю. Этот скрипт каждый час читает ПЕРВОИСТОЧНИКИ на боевом сервере:
 *   1) /etc/nginx/sites-enabled/*      → домены, поддомены, редиректы, куда проксируются
 *   2) pm2 (root + kateadmin)          → живые процессы-сервисы, порты, аптайм
 *   3) app.get/post/use(...) в коде    → страницы и API каждого сервиса
 *   4) data-tab / data-go / TABS[...]  → разделы внутри страниц-одностраничников
 *   5) статические сайты в /var/www    → html-страницы лендингов
 *   6) crontab -l                      → фоновые задачи
 *   7) /sitemap.xml самого сайта       → страницы под поиск (/esim/turkey и т.п.),
 *                                       которые объявлены в коде циклом и по одному
 *                                       объявлению их не увидеть
 * и кладёт снимок в /var/www/akfin/.sitemap.json, откуда его отдаёт страница /map.
 *
 * НЕМИНУЕМОСТЬ. Сканер сравнивает снимок с предыдущим. Всё, что появилось или
 * пропало, попадает в раздел «Изменения» на карте, а при существенной разнице
 * уходит письмом на director@visa-sc.ru. То есть новый раздел или поддомен
 * невозможно добавить мимо карты: он окажется там сам, в течение часа.
 *
 * Запуск: node tools/sitemap-scan.js [--dry] [--quiet] [--check]
 *   --dry   ничего не писать, вывести отчёт в консоль
 *   --quiet без письма (для ручных прогонов)
 *   --check найти страницы без пояснения в sitemap-notes.json. Работает и на
 *           маке, прямо в репозитории: node tools/sitemap-scan.js --check
 *           Код возврата 1, если что-то не описано — удобно как проверка перед
 *           деплоем новой страницы.
 */

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const DRY = process.argv.includes("--dry");
const CHECK = process.argv.includes("--check");
const QUIET = process.argv.includes("--quiet");

// Куда пишем снимок: его читает сервис akfin (ak-co.ru), страница /map.
const OUT = process.env.SITEMAP_OUT || "/var/www/akfin/.sitemap.json";
const NOTES = path.join(__dirname, "sitemap-notes.json");

// Где что лежит на боевом сервере. Локально (на маке) большинства путей нет —
// сканер это переживает и просто пропускает недоступные источники.
const ROOTS = {
  voyo: process.env.SITEMAP_VOYO || "/var/www/voyo",
  akfin: "/var/www/akfin",
  kateadmin: "/var/www/kateadmin",
  engine: "/var/www/translate-engine",
  vscom: "/var/www/visa-sc-com",
  spain: "/var/www/spain-visa-sc-com",
};

const sh = (cmd) => {
  try { return execSync(cmd, { encoding: "utf8", timeout: 20000, stdio: ["ignore", "pipe", "ignore"] }); }
  catch { return ""; }
};
const exists = (p) => { try { fs.accessSync(p); return true; } catch { return false; } };
const read = (p) => { try { return fs.readFileSync(p, "utf8"); } catch { return ""; } };

const notes = (() => { try { return JSON.parse(read(NOTES) || "{}"); } catch { return {}; } })();

// Пояснение к странице: сначала точное совпадение «домен+путь», потом просто
// путь, потом шаблон с звёздочкой («/esim/*» — общее описание для всех
// SEO-страниц направлений, их десятки и по одной их описывать незачем).
function noteFor(domain, p) {
  const map = notes.pages || {};
  if (map[domain + p]) return map[domain + p];
  if (map[p]) return map[p];
  for (const k of Object.keys(map)) {
    if (!k.endsWith("*")) continue;
    const pref = k.slice(0, -1);
    if (p.startsWith(pref) || (domain + p).startsWith(pref)) return map[k];
  }
  return {};
}

// Публичные страницы, объявленные циклом: их в коде видно как app.get("/esim/" + slug),
// то есть по одному объявлению не перечислить. Живой источник — sitemap.xml сайта.
function scanSitemapXml(host, port) {
  const xml = sh(`curl -s -m 10 -H "Host: ${host}" http://127.0.0.1:${port}/sitemap.xml`);
  const out = [];
  for (const m of xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)) {
    try {
      const u = new URL(m[1]);
      out.push(u.pathname.replace(/\/$/, "") || "/");
    } catch { /* мусор в sitemap пропускаем */ }
  }
  return [...new Set(out)];
}

/* ──────────────────────────── 1. Домены из nginx ─────────────────────────── */

function scanNginx() {
  const dir = "/etc/nginx/sites-enabled";
  if (!exists(dir)) return [];
  const out = [];
  for (const f of fs.readdirSync(dir)) {
    const conf = read(path.join(dir, f));
    if (!conf) continue;
    // Разбираем по server-блокам: у одного домена обычно два (80 → редирект на https, 443 → работа).
    for (const block of splitServerBlocks(conf)) {
      const m = block.match(/server_name\s+([^;]+);/);
      if (!m) continue;
      const names = m[1].trim().split(/\s+/).filter((n) => n !== "_");
      if (!names.length) continue;
      const isHttpOnly = /listen\s+80\b/.test(block) && !/listen\s+443/.test(block);

      // Классификация домена. Важно смотреть именно на то, чем обслуживается «/»:
      // у spain.visa-sc.com статика в root, а proxy_pass стоит только во вложенных
      // location (/api/, /mod/) — по одному лишь наличию proxy_pass домен ошибочно
      // выглядел приложением.
      const locs = extractLocations(block);
      const bare = stripLocations(block);           // директивы уровня server
      const rootLoc = locs.find((l) => /^(=\s*)?\/$/.test(l.match.trim()));
      const decide = (body) => {
        const pp = (body.match(/proxy_pass\s+([^;]+);/) || [])[1];
        const rd = (body.match(/return\s+30[12]\s+([^;]+);/) || [])[1];
        const rt = (body.match(/\broot\s+([^;]+);/) || [])[1];
        if (rd && !/^https:\/\/\$host\$request_uri$/.test(rd.trim())) return { kind: "redirect", target: rd.trim() };
        if (pp) return /127\.0\.0\.1/.test(pp) ? { kind: "app", target: pp.trim() } : { kind: "proxy", target: pp.trim() };
        if (rt) return { kind: "static", target: rt.trim() };
        return null;
      };
      const verdict = (rootLoc && decide(rootLoc.body)) || decide(bare) || { kind: "static", target: "" };
      const kind = verdict.kind, target = verdict.target;

      const primary = names[0];
      const aliases = names.slice(1);

      const prev = out.find((d) => d.domain === primary);
      if (prev) { // объединяем 80-й и 443-й блоки одного домена
        if (isHttpOnly) continue;
        prev.kind = kind; prev.target = target; prev.conf = f;
        for (const a of aliases) if (!prev.aliases.includes(a)) prev.aliases.push(a);
        continue;
      }
      out.push({ domain: primary, aliases, kind, target, conf: f, https: /listen\s+443/.test(block) });
    }
  }
  return out.sort((a, b) => a.domain.localeCompare(b.domain));
}

// Вложенные location-блоки: нужны, чтобы понять, чем обслуживается именно «/».
function extractLocations(block) {
  const out = [];
  const re = /location\s+([^{]+)\{/g;
  let m;
  while ((m = re.exec(block))) {
    let depth = 1, j = re.lastIndex;
    for (; j < block.length && depth; j++) {
      if (block[j] === "{") depth++;
      else if (block[j] === "}") depth--;
    }
    out.push({ match: m[1].replace(/^[~^*=\s]+/, "").trim() || m[1].trim(), body: block.slice(re.lastIndex, j - 1) });
  }
  return out;
}

// Тот же блок без вложенных location — директивы уровня server.
function stripLocations(block) {
  let s = block, out = "", i = 0;
  while (true) {
    const m = /location\s+[^{]+\{/g;
    m.lastIndex = i;
    const hit = m.exec(s);
    if (!hit) { out += s.slice(i); break; }
    out += s.slice(i, hit.index);
    let depth = 1, j = m.lastIndex;
    for (; j < s.length && depth; j++) {
      if (s[j] === "{") depth++;
      else if (s[j] === "}") depth--;
    }
    i = j;
  }
  return out;
}

function splitServerBlocks(conf) {
  const blocks = [];
  let i = 0;
  while (true) {
    const s = conf.indexOf("server", i);
    if (s < 0) break;
    const open = conf.indexOf("{", s);
    if (open < 0) break;
    let depth = 0, j = open;
    for (; j < conf.length; j++) {
      if (conf[j] === "{") depth++;
      else if (conf[j] === "}") { depth--; if (!depth) break; }
    }
    blocks.push(conf.slice(open, j));
    i = j + 1;
  }
  return blocks;
}

/* ─────────────────────────── 2. Сервисы из pm2 ───────────────────────────── */

function scanPm2() {
  const list = [];
  const grab = (json, user) => {
    let arr = []; try { arr = JSON.parse(json); } catch { return; }
    for (const p of arr) {
      if (p.name === "pm2-logrotate") continue;
      list.push({
        name: p.name,
        user,
        cwd: (p.pm2_env && p.pm2_env.pm_cwd) || "",
        script: (p.pm2_env && path.basename(p.pm2_env.pm_exec_path || "")) || "",
        status: (p.pm2_env && p.pm2_env.status) || "",
        restarts: (p.pm2_env && p.pm2_env.restart_time) || 0,
        uptimeMs: p.pm2_env && p.pm2_env.pm_uptime ? Date.now() - p.pm2_env.pm_uptime : 0,
        mem: p.monit ? p.monit.memory : 0,
      });
    }
  };
  grab(sh("pm2 jlist 2>/dev/null"), "root");
  grab(sh("su - kateadmin -c 'pm2 jlist' 2>/dev/null"), "kateadmin");
  return list;
}

/* ─────────── 3. Страницы и API: разбор объявлений маршрутов в коде ────────── */

// Файлы, где живут маршруты каждого сервиса. Модули подхватываются по маске,
// чтобы новый модуль (новый инструмент) попадал в карту без правки сканера.
function routeFilesFor(svc) {
  const r = ROOTS[svc];
  if (!r || !exists(r)) return [];
  const files = [];
  const push = (p) => { if (exists(p)) files.push(p); };
  if (svc === "voyo") {
    for (const f of fs.readdirSync(r)) if (f.endsWith(".js") && !f.includes(".bak")) push(path.join(r, f));
    push(path.join(r, "crm-svc", "index.js"));
  } else if (svc === "akfin") {
    for (const f of fs.readdirSync(r)) if (f.endsWith(".js") && !f.includes(".bak")) push(path.join(r, f));
  } else if (svc === "kateadmin" || svc === "engine") {
    for (const f of fs.readdirSync(r)) if (f.endsWith(".js") && !f.includes(".bak")) push(path.join(r, f));
  }
  return files;
}

const MW = { // как читаются охранники доступа в объявлении маршрута
  requireAdmin: "админ",
  requireStaff: "сотрудник",
  requireVscAccess: "доступ /vsc",
  requireSession: "клиент по сессии",
  requireEsimAdmin: "админ eSIM",
};

function scanRoutes(svc) {
  const found = new Map(); // path → { methods:Set, src, access }
  for (const file of routeFilesFor(svc)) {
    const src = read(file);
    const rel = path.relative(ROOTS[svc], file);
    const lines = src.split("\n");
    lines.forEach((line, idx) => {
      const m = line.match(/\bapp\.(get|post|put|patch|delete|use|all)\(\s*(\[[^\]]*\]|"[^"]*"|'[^']*')/);
      if (!m) return;
      const method = m[1].toUpperCase();
      const rawArg = m[2];
      const paths = [...rawArg.matchAll(/["']([^"']*)["']/g)].map((x) => x[1]).filter((p) => p.startsWith("/"));
      if (!paths.length) return;
      const tail = line.slice(line.indexOf(m[0]) + m[0].length);
      let access = "";
      for (const k of Object.keys(MW)) if (tail.includes(k)) { access = MW[k]; break; }
      for (const p of paths) {
        const key = p;
        if (!found.has(key)) found.set(key, { path: p, methods: new Set(), src: rel + ":" + (idx + 1), access });
        const e = found.get(key);
        e.methods.add(method);
        if (access && !e.access) e.access = access;
      }
    });
  }
  return [...found.values()].map((e) => ({ ...e, methods: [...e.methods].sort() }));
}

/* ───────── 4. Разделы внутри страниц: вкладки одностраничников ───────────── */

function scanSections(htmlFile) {
  const src = read(htmlFile);
  if (!src) return [];
  const out = [];
  const seen = new Set();
  const add = (key, label, from) => {
    key = (key || "").trim(); label = (label || "").trim();
    if (!key || seen.has(key)) return;
    seen.add(key); out.push({ key, label: label || key, from });
  };
  // <button ... data-tab="stats">Статистика</button>  и  data-go="esim"><span class="lb">eSIM</span>
  for (const m of src.matchAll(/data-(?:tab|go)="([a-z0-9_-]+)"[^>]*>\s*(?:<[^>]+>\s*)*([^<]{1,60})/gi)) add(m[1], m[2], "tab");
  for (const m of src.matchAll(/data-(?:tab|go)="([a-z0-9_-]+)"[\s\S]{0,400}?class="lb">([^<]{1,40})</gi)) add(m[1], m[2], "tab");
  // let TABS = [["dash","Дашборд"], ...] — вкладки /vsc собираются кодом
  for (const m of src.matchAll(/TABS\s*=\s*\[(\[[\s\S]{0,1500}?\])\];/g)) {
    for (const p of m[1].matchAll(/\[\s*"([a-z0-9_-]+)"\s*,\s*"([^"]+)"\s*\]/gi)) add(p[1], p[2], "vsc");
  }
  return out;
}

function pageTitle(htmlFile) {
  const m = read(htmlFile).match(/<title>([^<]{1,120})<\/title>/i);
  return m ? m[1].trim() : "";
}

/* ───────────────────── 5. Статические сайты (лендинги) ───────────────────── */

function scanStatic(root) {
  if (!exists(root)) return [];
  const out = [];
  const walk = (dir, prefix) => {
    for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, f.name);
      if (f.isDirectory()) { if (!["node_modules", ".git", "tools"].includes(f.name)) walk(p, prefix + "/" + f.name); continue; }
      if (!f.name.endsWith(".html") || f.name.startsWith("_")) continue;
      const url = f.name === "index.html" ? (prefix || "/") : prefix + "/" + f.name.replace(/\.html$/, "");
      out.push({ path: url, methods: ["GET"], src: path.relative(root, p), title: pageTitle(p), static: true });
    }
  };
  walk(root, "");
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

/* ──────────────────────────── 6. Фоновые задачи ──────────────────────────── */

function scanCron() {
  const out = [];
  const parse = (text, where) => {
    for (const line of text.split("\n")) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const m = t.match(/^(\S+\s+\S+\s+\S+\s+\S+\s+\S+)\s+(.+)$/);
      if (!m) continue;
      out.push({ schedule: m[1], cmd: m[2].replace(/\s*>>?.*$/, "").trim(), where });
    }
  };
  parse(sh("crontab -l 2>/dev/null"), "root");
  if (exists("/etc/cron.d")) {
    for (const f of fs.readdirSync("/etc/cron.d")) {
      if (["e2scrub_all", "sysstat", "certbot"].includes(f)) continue;
      parse(read("/etc/cron.d/" + f).replace(/^(\S+\s+\S+\s+\S+\s+\S+\s+\S+)\s+\S+\s+/gm, "$1 "), "cron.d/" + f);
    }
  }
  return out;
}

/* ─────────────────────────────── Сборка ──────────────────────────────────── */

function classify(p) {
  // «/esim/» — не страница, а начало пути из объявления вида app.get("/esim/" + slug).
  // Сами страницы семейства приходят из sitemap.xml, а обрубок только мусорит.
  if (p.length > 1 && p.endsWith("/")) return "skip";
  if (/\.[a-z0-9]{2,5}$/i.test(p)) return "asset";   // /robots.txt, /fin-icon.png, /sitemap.xml
  if (/(^|\/)__/.test(p)) return "asset";             // служебные ручки вида /__svc_health
  if (p.startsWith("/api/")) return "api";
  if (/^\/[a-z0-9_-]+\/api\//i.test(p)) return "api";
  if (p.includes(":") || p.includes("*")) return "api";
  return "page";
}

function build() {
  const domains = scanNginx();
  const services = scanPm2();

  // Привязка домена к сервису по порту в proxy_pass.
  const portOf = (t) => { const m = String(t).match(/:(\d{2,5})/); return m ? m[1] : ""; };
  const SERVICE_BY_PORT = { 3000: "voyo", 3001: "amocopy-svc", 3002: "kateadmin", 3005: "akfin" };
  const CODE_BY_PORT = { 3000: "voyo", 3001: "voyo", 3002: "kateadmin", 3005: "akfin" };

  const routeCache = {};
  const routesOf = (code) => (routeCache[code] = routeCache[code] || scanRoutes(code));

  // В один процесс смотрят несколько доменов: voyotravel.ru, voyovoyo.ru, vsc. и dev.
  // — все на :3000. Полный список страниц показываем один раз, у основного домена;
  // остальные помечаем зеркалами, иначе карта вчетверо раздувается одним и тем же.
  const primaryByPort = {};
  for (const d of domains) {
    const port = portOf(d.target);
    if (d.kind !== "app" || !port) continue;
    const pref = (notes.primaryDomain || {})[port];
    if (pref) primaryByPort[port] = pref;
    else if (!primaryByPort[port]) primaryByPort[port] = d.domain;
  }

  const tree = [];
  for (const d of domains) {
    const port = portOf(d.target);
    const node = {
      domain: d.domain, aliases: d.aliases, kind: d.kind, target: d.target,
      service: SERVICE_BY_PORT[port] || "", port,
      note: (notes.domains || {})[d.domain] || "",
      pages: [], api: [], assets: [],
    };
    if (d.kind === "app" && primaryByPort[port] && primaryByPort[port] !== d.domain) {
      node.mirrorOf = primaryByPort[port];           // тот же процесс, те же страницы
    } else if (d.kind === "app" && port === "3002") {
      // work.voyotravel.ru написан на голом http (не express): страницы = файлы
      // в public/, всё непокрытое прозрачно уходит на основной апп :3000.
      const pub = path.join(ROOTS.kateadmin, "public");
      if (exists(pub)) {
        for (const f of fs.readdirSync(pub)) {
          if (!f.endsWith(".html") || f.includes(".bak")) continue;
          const file = path.join(pub, f);
          const url = f === "kateadmin.html" ? "/" : "/" + f.replace(/\.html$/, "");
          const n = (notes.pages || {})["work.voyotravel.ru" + url] || {};
          const sec = scanSections(file);
          node.pages.push({
            path: url, methods: ["GET"], src: "public/" + f,
            title: n.title || pageTitle(file), desc: n.desc || "", access: n.access || "",
            ...(sec.length ? { sections: sec } : {}),
          });
        }
        node.pages.sort((a, b) => a.path.localeCompare(b.path));
      }
      node.fallback = "остальные пути прозрачно проксируются на основной апп :3000";
    } else if (d.kind === "app" && CODE_BY_PORT[port]) {
      const code = CODE_BY_PORT[port];
      const pubDir = path.join(ROOTS[code] || "", "public");
      for (const r of routesOf(code)) {
        // crm.voyotravel.ru — обособленный процесс: свои маршруты в crm-svc/index.js
        // плюс общий модуль amocopy.js, который он подключает сам.
        const isCrm = r.src.startsWith("crm-svc") || /^amocopy/.test(r.src);
        if (port === "3001" && !isCrm) continue;
        if (port === "3000" && r.src.startsWith("crm-svc")) continue;
        const kind = classify(r.path);
        const n = noteFor(d.domain, r.path);
        const item = {
          path: r.path, methods: r.methods, src: r.src,
          access: n.access || r.access || "",
          title: n.title || "", desc: n.desc || "", group: n.group || "",
        };
        if (kind === "page") {
          // Заголовок и разделы — из html, который страница отдаёт
          const guess = path.join(pubDir, r.path.replace(/^\//, "").replace(/\//g, "-") + ".html");
          const guess2 = path.join(pubDir, r.path.split("/").pop() + ".html");
          const named = n.file ? path.join(pubDir, n.file) : "";
          const file = named && exists(named) ? named : exists(guess) ? guess : exists(guess2) ? guess2 : "";
          if (file) {
            if (!item.title) item.title = pageTitle(file);
            // /admin, /team и /vsc — один и тот же html с двумя наборами вкладок;
            // какой набор чей, знает только человек — берём из пояснений.
            let sec = scanSections(file);
            if (n.sectionsFrom) sec = sec.filter((x) => x.from === n.sectionsFrom);
            if (sec.length) item.sections = sec;
          }
          node.pages.push(item);
        } else if (kind === "asset") node.assets.push(item);
        else if (kind !== "skip") node.api.push(item);
      }
      // Добавляем публичные страницы из sitemap.xml, которых нет в объявлениях.
      for (const p of scanSitemapXml(d.domain, port)) {
        if (node.pages.some((x) => x.path === p)) continue;
        const n = noteFor(d.domain, p);
        node.pages.push({
          path: p, methods: ["GET"], src: "sitemap.xml",
          access: n.access || "", title: n.title || "", desc: n.desc || "", group: n.group || "Поиск",
        });
      }
      node.pages.sort((a, b) => a.path.localeCompare(b.path));
      node.api.sort((a, b) => a.path.localeCompare(b.path));
    } else if (d.kind === "static" || d.kind === "proxy") {
      const dirs = { "visa-sc.com": ROOTS.vscom, "spain.visa-sc.com": ROOTS.spain };
      for (const p of scanStatic(dirs[d.domain] || d.target)) {
        const n = (notes.pages || {})[d.domain + p.path] || {};
        node.pages.push({ ...p, title: n.title || p.title, desc: n.desc || "", access: n.access || "" });
      }
    }
    tree.push(node);
  }

  const snap = {
    generatedAt: new Date().toISOString(),
    host: sh("hostname -I 2>/dev/null").trim().split(/\s+/)[0] || "",
    domains: tree,
    services,
    jobs: scanCron(),
    watchdogs: notes.watchdogs || [],
    storage: notes.storage || [],
  };
  snap.stats = {
    domains: tree.length,
    pages: tree.reduce((s, d) => s + d.pages.length, 0),
    mirrors: tree.filter((d) => d.mirrorOf).length,
    api: tree.reduce((s, d) => s + d.api.length, 0),
    sections: tree.reduce((s, d) => s + d.pages.reduce((k, p) => k + ((p.sections || []).length), 0), 0),
    services: services.length,
    jobs: snap.jobs.length,
  };
  return snap;
}

/* ─────────── Сравнение с прошлым снимком: что появилось и что ушло ────────── */

function keysOf(snap) {
  const k = new Set();
  for (const d of snap.domains || []) {
    k.add("домен " + d.domain);
    for (const p of d.pages || []) {
      k.add(d.domain + p.path);
      for (const s of p.sections || []) k.add(d.domain + p.path + " → " + s.label);
    }
    for (const a of d.api || []) k.add(d.domain + a.path);
  }
  for (const s of snap.services || []) k.add("сервис " + s.name);
  for (const j of snap.jobs || []) k.add("задача " + j.cmd);
  return k;
}

// Проверка «всё ли описано»: сравнивает маршруты-страницы в коде со списком
// пояснений. Единственный режим, который работает вне боевого сервера.
function check() {
  const repo = process.env.SITEMAP_VOYO || path.resolve(__dirname, "..");
  ROOTS.voyo = repo;
  const missing = [];
  for (const r of scanRoutes("voyo")) {
    if (classify(r.path) !== "page" || !r.methods.includes("GET")) continue;
    if (r.src.startsWith("crm-svc")) continue;
    const n = noteFor("voyotravel.ru", r.path);
    if (!n.desc) missing.push(r.path + "   (" + r.src + ")");
  }
  if (!missing.length) { console.log("Все страницы описаны в tools/sitemap-notes.json."); return; }
  console.log("Не описаны в tools/sitemap-notes.json (" + missing.length + "):");
  for (const m of missing.sort()) console.log("  " + m);
  console.log("\nДопишите строку вида:");
  console.log('  "/путь": { "group": "Клиент|Управление|Служебное", "access": "кто входит", "desc": "что это" }');
  process.exitCode = 1;
}

function main() {
  if (CHECK) return check();
  const snap = build();
  let prev = null;
  try { prev = JSON.parse(read(OUT)); } catch { /* первый прогон */ }

  if (prev) {
    const a = keysOf(prev), b = keysOf(snap);
    const added = [...b].filter((x) => !a.has(x));
    const removed = [...a].filter((x) => !b.has(x));
    // История изменений копится в снимке, чтобы карта показывала «что нового».
    const log = (prev.changelog || []).slice(0, 60);
    if (added.length || removed.length) log.unshift({ at: snap.generatedAt, added, removed });
    snap.changelog = log;
    snap.lastChange = log[0] ? log[0].at : prev.lastChange || null;
  } else snap.changelog = [];

  if (DRY) {
    console.log(JSON.stringify(snap.stats, null, 2));
    for (const d of snap.domains) {
      console.log(`\n## ${d.domain} [${d.kind}${d.service ? " → " + d.service : ""}] — ${d.pages.length} стр., ${d.api.length} api`);
      for (const p of d.pages.slice(0, 200)) console.log("   " + p.path + (p.sections ? ` (${p.sections.length} разд.)` : "") + (p.title ? "  — " + p.title : ""));
    }
    if (snap.changelog && snap.changelog[0]) console.log("\nИзменения:", JSON.stringify(snap.changelog[0], null, 2));
    return;
  }

  fs.writeFileSync(OUT, JSON.stringify(snap));
  try { fs.chmodSync(OUT, 0o644); } catch {}
  const ch = snap.changelog && snap.changelog[0] && snap.changelog[0].at === snap.generatedAt ? snap.changelog[0] : null;
  console.log(`[sitemap] ${snap.stats.domains} доменов, ${snap.stats.pages} страниц, ${snap.stats.api} api, ${snap.stats.sections} разделов` +
    (ch ? ` | изменений: +${ch.added.length} −${ch.removed.length}` : ""));

  if (ch && !QUIET) notify(ch, snap);
}

// Письмо о новом в структуре — чтобы изменение нельзя было не заметить.
function notify(ch, snap) {
  let mail;
  try { mail = require(path.join(ROOTS.voyo, "mail.js")); } catch { return; }
  const li = (arr) => arr.map((x) => "<li>" + String(x).replace(/&/g, "&amp;").replace(/</g, "&lt;") + "</li>").join("");
  const html =
    `<p>Карта структуры обновилась: <a href="https://ak-co.ru/map">ak-co.ru/map</a></p>` +
    (ch.added.length ? `<p><b>Появилось (${ch.added.length}):</b></p><ul>${li(ch.added)}</ul>` : "") +
    (ch.removed.length ? `<p><b>Пропало (${ch.removed.length}):</b></p><ul>${li(ch.removed)}</ul>` : "") +
    `<p style="color:#888">Всего: ${snap.stats.domains} доменов, ${snap.stats.pages} страниц, ${snap.stats.sections} разделов, ${snap.stats.services} сервисов.</p>`;
  mail.sendMail({
    to: "director@visa-sc.ru",
    subject: `Структура: +${ch.added.length} / −${ch.removed.length}`,
    html,
  }).catch(() => {});
}

main();
