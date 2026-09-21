#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// spbcopy — сервис, отдающий нашу копию сайта spb.visa-sc.ru.
//
// Живёт отдельным процессом (pm2 «spbcopy», порт 3006), nginx на
// crm.voyotravel.ru отдаёт ему всё, что начинается с /spb_copy/. Главный апп
// (voyo) и копия amoCRM (amocopy-svc) им не задеты — так безопаснее.
//
// ЧТО УМЕЕТ:
//  1. Статика копии: страницы, css, js, шрифты, картинки (каталог site/).
//  2. РЕСАЙЗ КАРТИНОК. Flexbe отдаёт картинку в той ширине, которую попросил
//     браузер (/img/123_854.png, /img/123_640_q70.jpg) — ширина вычисляется из
//     вёрстки, вариантов бесконечно много. Поэтому у нас лежит оригинал, а
//     варианты нарезаются на ходу (sharp) и кэшируются на диск. Если sharp не
//     установлен — отдаём оригинал: страница выглядит так же, просто тяжелее.
//  3. Формы. Flexbe-формы шлют JSON POST на адрес самой страницы и ждут в ответ
//     {lead_id}. Мы отвечаем именно так и пишем заявку в журнал leads.json.
//     В amoCRM / на почту заявки НЕ уходят — интеграция по решению Андрея
//     (21.09.2026) пока не делается.
//  4. Заглушки служебных ручек Flexbe (/mod/stat/, /mod/quiz/…, промокоды),
//     чтобы в консоли не было ошибок и не ломалась механика квизов.
//
// Копия закрыта от индексации (X-Robots-Tag + meta noindex в html): она не
// должна конкурировать в поиске с живым сайтом.
// ─────────────────────────────────────────────────────────────────────────────
"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const PORT = Number(process.env.SPBCOPY_PORT || 3006);
const ROOT = process.env.SPBCOPY_SITE || path.join(__dirname, "..", ".spbcopy", "site");
const CACHE = process.env.SPBCOPY_CACHE || path.join(ROOT, "..", "imgcache");
const LEADS = process.env.SPBCOPY_LEADS || path.join(ROOT, "..", "leads.json");
// Копия отдаётся в корне поддомена spb.voyotravel.ru. Префикс /spb_copy тоже
// понимаем — на случай, если копию попросят положить в подкаталог другого домена.
const PREFIX = process.env.SPBCOPY_PREFIX || "";
const ALT_PREFIX = "/spb_copy";
const MAX_LEADS = 5000;

let sharp = null;
try {
  sharp = require("sharp");
} catch (_) {
  console.log("spbcopy: sharp не установлен — картинки отдаём в оригинальном размере");
}

fs.mkdirSync(CACHE, { recursive: true });

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/vnd.microsoft.icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".eot": "application/vnd.ms-fontobject",
  ".otf": "font/otf",
  ".pdf": "application/pdf",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml; charset=utf-8"
};

const COMPRESSIBLE = new Set([".html", ".css", ".js", ".mjs", ".json", ".svg", ".xml", ".txt"]);

function safeJoin(rel) {
  const p = path.normalize(path.join(ROOT, rel));
  return p.startsWith(path.normalize(ROOT)) ? p : null;
}

function send(req, res, status, body, type, extra = {}) {
  const headers = {
    "Content-Type": type,
    "X-Robots-Tag": "noindex, nofollow",
    ...extra
  };
  const ext = path.extname(String(extra.__ext || "")).toLowerCase();
  const wantGzip =
    COMPRESSIBLE.has(ext) && /\bgzip\b/.test(req.headers["accept-encoding"] || "") && body.length > 1024;
  delete headers.__ext;
  if (wantGzip) {
    const gz = zlib.gzipSync(body);
    headers["Content-Encoding"] = "gzip";
    headers["Content-Length"] = gz.length;
    res.writeHead(status, headers);
    return res.end(req.method === "HEAD" ? undefined : gz);
  }
  headers["Content-Length"] = body.length;
  res.writeHead(status, headers);
  res.end(req.method === "HEAD" ? undefined : body);
}

function sendFile(req, res, file, status = 200) {
  const ext = path.extname(file).toLowerCase();
  const body = fs.readFileSync(file);
  const cache = ext === ".html" ? "no-cache" : "public, max-age=604800";
  send(req, res, status, body, MIME[ext] || "application/octet-stream", {
    "Cache-Control": cache,
    __ext: ext
  });
}

function sendJson(req, res, obj, status = 200) {
  send(req, res, status, Buffer.from(JSON.stringify(obj)), "application/json; charset=utf-8", {
    "Cache-Control": "no-store"
  });
}

// ── картинки: нарезаем вариант из оригинала ──────────────────────────────────
// /img/123_854.png → оригинал /img/123.png, ширина 854
// /img/123_640_q70.jpg → та же логика + качество 70
async function serveImage(req, res, rel) {
  const direct = safeJoin(rel);
  if (direct && fs.existsSync(direct) && fs.statSync(direct).isFile()) return sendFile(req, res, direct);

  const m = rel.match(/^\/img\/(\d+)(?:_(\d+))?(?:_q(\d+))?(\.[a-z0-9]+)$/i);
  if (!m) return false;
  const [, id, widthRaw, qualityRaw, extRaw] = m;
  const ext = extRaw.toLowerCase();

  // Оригинал у нас лежит в исходном формате, а браузер просит тот, который
  // умеет: Flexbe отдаёт webp тем, кто его поддерживает. Ищем любой исходник.
  let base = safeJoin(`/img/${id}${ext}`);
  if (!base || !fs.existsSync(base)) {
    base = null;
    for (const e of [".png", ".jpg", ".jpeg", ".webp", ".gif", ".svg"]) {
      const cand = safeJoin(`/img/${id}${e}`);
      if (cand && fs.existsSync(cand)) {
        base = cand;
        break;
      }
    }
  }
  if (!base) return false;

  const baseExt = path.extname(base).toLowerCase();
  const width = Number(widthRaw) || 0;
  const quality = Number(qualityRaw) || 0;
  const sameFormat = baseExt === ext;
  const vector = baseExt === ".svg";

  if (vector || !sharp || (sameFormat && !width)) return sendFile(req, res, base);

  const cacheFile = path.join(CACHE, `${id}${width ? `_${width}` : ""}${quality ? `_q${quality}` : ""}${ext}`);
  if (!fs.existsSync(cacheFile)) {
    try {
      const animated = baseExt === ".gif" || baseExt === ".webp";
      const img = sharp(base, { animated });
      const meta = await img.metadata();
      let out = img;
      // Увеличивать не надо: если оригинал меньше запрошенного — отдаём как есть.
      if (width && meta.width && width < meta.width) out = out.resize({ width, withoutEnlargement: true });
      if (ext === ".webp") out = out.webp({ quality: quality || 82 });
      else if (ext === ".avif") out = out.avif({ quality: quality || 60 });
      else if (ext === ".jpg" || ext === ".jpeg") out = out.jpeg({ quality: quality || 85, progressive: true });
      else if (ext === ".png") out = out.png({ compressionLevel: 9 });
      else if (ext === ".gif") out = out.gif();
      await out.toFile(cacheFile);
    } catch (e) {
      console.log("spbcopy: ресайз не удался", rel, e.message);
      return sendFile(req, res, base);
    }
  }
  return sendFile(req, res, cacheFile);
}

// ── журнал заявок ────────────────────────────────────────────────────────────
function logLead(entry) {
  let all = [];
  try {
    all = JSON.parse(fs.readFileSync(LEADS, "utf8"));
  } catch (_) {}
  all.push(entry);
  if (all.length > MAX_LEADS) all = all.slice(all.length - MAX_LEADS);
  try {
    fs.writeFileSync(LEADS, JSON.stringify(all, null, 2));
  } catch (e) {
    console.log("spbcopy: журнал заявок не записался:", e.message);
  }
  return all.length;
}

function readBody(req, limit = 2 * 1024 * 1024) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size <= limit) chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", () => resolve(""));
  });
}

// ── обработка запроса ────────────────────────────────────────────────────────
async function handle(req, res) {
  let url;
  try {
    url = new URL(req.url, "http://localhost");
  } catch (_) {
    return sendJson(req, res, { error: "bad url" }, 400);
  }
  let rel = decodeURIComponent(url.pathname);
  for (const p of [PREFIX, ALT_PREFIX]) {
    if (!p) continue;
    if (rel === p) {
      res.writeHead(301, { Location: p + "/" });
      return res.end();
    }
    if (rel.startsWith(p + "/")) rel = rel.slice(p.length);
  }
  if (!rel.startsWith("/")) rel = "/" + rel;

  // Служебные ручки Flexbe: статистика, квизы, промокоды, загрузка файлов.
  if (/^\/mod\/stat\//.test(rel)) return sendJson(req, res, { success: true });
  if (/^\/mod\/quiz\//.test(rel)) return sendJson(req, res, { success: true, id: Date.now() });
  if (/^\/api\/promotions\//.test(rel)) return sendJson(req, res, { success: true, list: [] });
  if (/^\/mod\/file\/lead\/upload\//.test(rel)) {
    return sendJson(req, res, { success: false, message: "Загрузка файлов в копии отключена" });
  }
  if (/^\/mod\/pay\//.test(rel)) return sendJson(req, res, { success: false, message: "Оплата в копии отключена" });

  // Отправка формы: Flexbe шлёт JSON POST на адрес страницы и ждёт {lead_id}.
  if (req.method === "POST") {
    const raw = await readBody(req);
    let data = null;
    try {
      data = JSON.parse(raw);
    } catch (_) {
      data = { raw: raw.slice(0, 5000) };
    }
    const n = logLead({
      at: new Date().toISOString(),
      page: rel,
      ip: (req.headers["x-real-ip"] || req.socket.remoteAddress || "").toString(),
      ua: (req.headers["user-agent"] || "").slice(0, 300),
      data
    });
    return sendJson(req, res, { success: true, lead_id: 100000 + n, status: "ok" });
  }

  if (req.method !== "GET" && req.method !== "HEAD") {
    return sendJson(req, res, { error: "method not allowed" }, 405);
  }

  if (rel.startsWith("/img/")) {
    const done = await serveImage(req, res, rel);
    if (done !== false) return;
  }

  // Статика: файл как есть, либо каталог → index.html
  const candidates = [];
  const direct = safeJoin(rel);
  if (direct) {
    candidates.push(direct);
    candidates.push(path.join(direct, "index.html"));
    if (!path.extname(rel)) candidates.push(direct + ".html");
  }
  for (const c of candidates) {
    try {
      if (fs.existsSync(c) && fs.statSync(c).isFile()) return sendFile(req, res, c);
    } catch (_) {}
  }

  // Оригинал уводит /Singapore → /singapore. Повторяем это поведение.
  const lower = rel.toLowerCase();
  if (lower !== rel) {
    const alt = safeJoin(lower);
    if (alt && (fs.existsSync(path.join(alt, "index.html")) || fs.existsSync(alt))) {
      res.writeHead(301, { Location: lower.replace(/\/$/, "") });
      return res.end();
    }
  }

  const notFound = safeJoin("/404.html");
  if (notFound && fs.existsSync(notFound)) return sendFile(req, res, notFound, 404);
  return send(req, res, 404, Buffer.from("<h1>404</h1>", "utf8"), "text/html; charset=utf-8", {
    __ext: ".html"
  });
}

http
  .createServer((req, res) => {
    handle(req, res).catch((e) => {
      console.log("spbcopy: ошибка", req.url, e.message);
      if (!res.headersSent) sendJson(req, res, { error: "internal" }, 500);
      else res.end();
    });
  })
  .listen(PORT, "127.0.0.1", () => {
    console.log(`spbcopy: слушаю 127.0.0.1:${PORT}, отдаю ${ROOT}${sharp ? " (ресайз включён)" : ""}`);
  });
