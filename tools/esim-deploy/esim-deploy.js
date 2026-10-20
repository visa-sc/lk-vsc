#!/usr/bin/env node
// esim-deploy — выкладка сайтов eSIM Андреем Петровым.
// 19.10.2026 — только админка (esim-adm.html). 20.10.2026, решение Андрея: «отправь Петрову управление
// voyomobile.ru, voyomobile.com и другими доменами eSIM и Telegram-ботом… чтобы мог корректировать
// содержимое». Отвечая на вопрос «что он сможет править», Андрей выбрал «страницы и тексты»: всё, что
// видит клиент (страницы, статьи, список стран, значки, тексты бота), но НЕ код сервера — оплата,
// выдача eSIM, поставщики, цены и логика бота остаются за Андреем.
//
// Как работает. Петров к /var/www/voyo доступа не имеет и не получает. Он правит файлы у себя в
// ~/esim-deploy и командой `esimdeploy <действие>` пишет файл-заявку ~/esim-deploy/REQUEST. systemd
// (esim-deploy.path) замечает заявку и запускает этот скрипт от root. Скрипт:
//   - берёт из его папки ТОЛЬКО файлы из FILES (пути из заявки не принимаются);
//   - читает их безопасно: обычный файл, владелец spbadmin, без ссылок (O_NOFOLLOW, nlink=1) —
//     подсунуть чужой файл (например .env) вместо своего нельзя;
//   - в его папку root НИЧЕГО не пишет и не удаляет: ответы — в /var/lib/esim-deploy/out;
//   - перед выкладкой проверяет каждый файл по его виду (синтаксис скриптов, JSON и его поля,
//     разметку текстов бота, размеры значков);
//   - не даёт выложить, если боевой файл менялся после его последнего pull (не затереть чужое);
//   - сохраняет копию боевого файла для отката, пишет запись в журнал выкладок;
//   - после выкладки проверяет, что сайт отдаёт новую версию и что витрина жива, иначе сам откатывает;
//   - слепки (snapshot): полная копия всех его файлов разом, откат к слепку одной командой (restore).
//     Слепок «исходное-2026-10-20» сделан Андреем до передачи и защищён от удаления.
"use strict";
const fs = require("fs"), path = require("path"), crypto = require("crypto"), vm = require("vm"), http = require("http");

const KATE_UID = 1002, KATE_GID = 1002;   // spbadmin — Андрей Петров (имя переменной — от образца lk-deploy)
const INBOX = "/home/spbadmin/esim-deploy";
const LIB = "/var/lib/esim-deploy";
const OUT = LIB + "/out", CUR = LIB + "/current", SNAPS = LIB + "/snapshots";
const STATE = LIB + "/state.json", LOG = LIB + "/deploy.log";
const V = "/var/www/voyo", PUB = V + "/public";
const BACKUP = V + "/.esim-deploy-backups";
const CHANGELOG_STORE = V + "/.esimAdmChangelogPetrov.json";
const MAX = 2 * 1024 * 1024, MAX_IMG = 1024 * 1024;
const KEEP_BACKUPS = 30, KEEP_SNAPS = 40;

// Что можно выкладывать. Имя — как файл лежит у него в ~/esim-deploy; dest — куда на боевом;
// kind — как проверять; url/host — где сайт его отдаёт (для проверки после выкладки).
// Страницы, скрипты и список стран лежат в esim-site/ и отдаются ТОЛЬКО на доменах eSIM (voyomobile.ru,
// .com, esim.voyotravel.ru, dev.voyomobile.ru): на voyotravel.ru хранятся токены админки и сессии ЛК, чужой
// скрипт там исполняться не должен (аудит 20.10.2026). voyotravel.ru/esim и раздел eSIM в ЛК отдают копии
// из public/, их выкладывает Андрей.
const VT = "voyotravel.ru", VM = "voyomobile.ru", SITE = V + "/esim-site";
const FILES = {
  "esim-adm.html":         { dest: SITE + "/esim-adm.html", kind: "html", host: "dev.voyomobile.ru", url: "/", what: "админка eSIM (dev.voyomobile.ru)" },
  "esim.html":             { dest: SITE + "/esim.html", kind: "html", host: VM, url: "/", what: "витрина: voyomobile.ru и .com, страницы стран, /vsc" },
  "esim-my.html":          { dest: SITE + "/esim-my.html", kind: "html", host: VM, url: "/esim/my", what: "страница одной eSIM: QR, остаток, продление" },
  "esim-account.html":     { dest: SITE + "/esim-account.html", kind: "html", host: VM, url: "/esim/account", what: "кабинет покупателя: все его eSIM, бонусы" },
  "esim-help.html":        { dest: SITE + "/esim-help.html", kind: "html", host: VM, url: "/esim/help", what: "форма «Не получается подключить eSIM»" },
  "esim-case.html":        { dest: SITE + "/esim-case.html", kind: "html", host: VM, url: "/esim/case/check", what: "личная страница обращения клиента" },
  "esim-pay-ok.html":      { dest: SITE + "/esim-pay-ok.html", kind: "html", host: VM, url: "/esim/pay/ok", what: "после оплаты: успех" },
  "esim-pay-fail.html":    { dest: SITE + "/esim-pay-fail.html", kind: "html", host: VM, url: "/esim/pay/fail", what: "после оплаты: не прошла" },
  "esim-partner.html":     { dest: SITE + "/esim-partner.html", kind: "html", host: VM, url: "/visazen", what: "кабинет турагентства-партнёра (voyomobile.ru/visazen)" },
  "esim-brand.js":         { dest: SITE + "/esim-brand.js", kind: "js", host: VM, url: "/esim-brand.js", what: "знак VOYO / VSC на страницах" },
  "esim-support.js":       { dest: SITE + "/esim-support.js", kind: "js", host: VM, url: "/esim-support.js", what: "окно чата поддержки на страницах" },
  "esim-a2hs.js":          { dest: SITE + "/esim-a2hs.js", kind: "js", host: VM, url: "/esim-a2hs.js", what: "подсказка «добавить на экран телефона»" },
  "esim_country_search.js":{ dest: SITE + "/esim_country_search.js", kind: "js", host: VM, url: "/esim_country_search.js", what: "поиск страны на витрине" },
  "esim_meta.js":          { dest: SITE + "/esim_meta.js", kind: "js", host: VM, url: "/esim_meta.js", what: "служебные данные витрины" },
  "esim-lands.json":       { dest: SITE + "/esim-lands.json", kind: "lands", host: VM, url: "/esim-lands.json", what: "страницы стран voyomobile.ru/<страна> (≈150)" },
  "esim-articles.json":    { dest: V + "/esim-articles.json", kind: "articles", what: "статьи voyomobile.ru/esim/<страна>, часть 1" },
  "esim-articles-2.json":  { dest: V + "/esim-articles-2.json", kind: "articles", what: "статьи, часть 2" },
  "esim-articles-3.json":  { dest: V + "/esim-articles-3.json", kind: "articles", what: "статьи, часть 3" },
  "esim-guides.json":      { dest: V + "/esim-guides.json", kind: "guides", what: "инструкции и сравнения voyomobile.ru/esim/<тема>" },
  "esim-bot-texts.json":   { dest: V + "/esim-bot-texts.json", kind: "bot", what: "тексты телеграм-бота @esimvoyo_bot" },
};
// значки voyomobile.ru и .com (на voyotravel.ru — общие, их не трогаем)
const ICON_DIMS = { "favicon-32.png": 32, "favicon-48.png": 48, "favicon-96.png": 96, "favicon-192.png": 192, "favicon-512.png": 512, "apple-touch-icon.png": 180 };
["favicon.ico", "favicon.svg"].concat(Object.keys(ICON_DIMS)).forEach((n) => {
  FILES[n] = { dest: PUB + "/vm/" + n, kind: "img", host: VM, url: "/" + n, what: "значок voyomobile.ru/.com" };
});
const NAMES = Object.keys(FILES);
// первые части адресов /esim/…, занятые сервером: статья с таким именем их бы перекрыла
const RESERVED_SLUGS = ["account", "api", "app.webmanifest", "case", "help", "logout", "my", "mylink", "pay", "promo", "partner", "ref", "adm"];
// адреса сайта, которые страница страны перекрывать не должна
const RESERVED_LANDS = ["/esim", "/vsc", "/67", "/admin", "/team", "/cabinet", "/api", "/translate", "/visazen", "/robots.txt", "/sitemap.xml"];

const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
const short = (h) => (h ? h.slice(0, 10) : "—");
const now = () => new Date();
const msk = (d) => new Date(d.getTime() + 3 * 3600e3).toISOString().replace("T", " ").slice(0, 19);
const mskDate = (d) => { const s = new Date(d.getTime() + 3 * 3600e3).toISOString(); return s.slice(8, 10) + "." + s.slice(5, 7) + "." + s.slice(0, 4); };
const stamp = (d) => new Date(d.getTime() + 3 * 3600e3).toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function readJson(p, dflt) { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch (_) { return dflt; } }
function writeRoot(p, data, mode, gid) {
  const tmp = p + ".tmp-" + process.pid;
  fs.writeFileSync(tmp, data, { mode: mode });
  fs.chownSync(tmp, 0, gid == null ? 0 : gid);
  fs.chmodSync(tmp, mode);
  fs.renameSync(tmp, p);
}
function logLine(o) {
  fs.appendFileSync(LOG, JSON.stringify(Object.assign({ at: msk(now()) }, o)) + "\n");
  try { fs.chownSync(LOG, 0, KATE_GID); fs.chmodSync(LOG, 0o640); } catch (_) {}
}

// Безопасное чтение файла из его папки (см. шапку). null — файла нет.
function readKate(name) {
  const p = path.join(INBOX, name);
  let fd;
  try { fd = fs.openSync(p, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK); }
  catch (e) {
    if (e.code === "ENOENT") return null;
    if (e.code === "ELOOP") throw new Error(name + ": это ссылка, а не файл — выкладываются только обычные файлы");
    throw new Error(name + ": не удалось открыть (" + e.code + ")");
  }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) throw new Error(name + ": это не обычный файл");
    if (st.uid !== KATE_UID) throw new Error(name + ": файл должен принадлежать spbadmin");
    if (st.nlink !== 1) throw new Error(name + ": у файла есть жёсткие ссылки — сделайте обычную копию");
    if (st.size > MAX) throw new Error(name + ": больше 2 МБ");
    const buf = Buffer.alloc(st.size);
    let off = 0;
    while (off < st.size) { const n = fs.readSync(fd, buf, off, st.size - off, off); if (!n) break; off += n; }
    return buf.subarray(0, off);
  } finally { fs.closeSync(fd); }
}
function readProd(name) { try { return fs.readFileSync(FILES[name].dest); } catch (_) { return null; } }

// ── проверки по виду файла. Возвращают список проблем (пусто — можно) ──
function utf8Errs(buf) {
  const s = buf.toString("utf8");
  return (!Buffer.from(s, "utf8").equals(buf) || s.indexOf("�") >= 0) ? ["файл не в UTF-8 или в нём битые символы"] : [];
}
function validateHtml(name, buf) {
  const errs = utf8Errs(buf);
  const s = buf.toString("utf8");
  if (buf.length < 1000) errs.push("подозрительно маленький файл (" + buf.length + " байт)");
  if (!/<\/html>/i.test(s)) errs.push("нет закрывающего </html> — файл обрезан?");
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let m, i = 0;
  while ((m = re.exec(s))) {
    i++;
    const attrs = m[1];
    if (/\bsrc\s*=/i.test(attrs)) continue;
    const type = ((attrs.match(/\btype\s*=\s*["']?([^"'\s>]+)/i) || [])[1] || "").toLowerCase();
    if (type && type !== "text/javascript" && type !== "application/javascript") continue;   // JSON, шаблоны, module
    try { new vm.Script(m[2], { filename: name + ", скрипт №" + i }); }
    catch (e) {
      const line = s.slice(0, m.index).split("\n").length;
      errs.push("ошибка JavaScript в скрипте №" + i + " (начинается со строки " + line + "): " + e.message);
    }
  }
  return errs;
}
function validateJs(name, buf) {
  const errs = utf8Errs(buf);
  if (buf.length < 50) errs.push("подозрительно маленький файл");
  try { new vm.Script(buf.toString("utf8"), { filename: name }); } catch (e) { errs.push("ошибка JavaScript: " + e.message); }
  return errs;
}
function parseJson(buf, errs) {
  try { const v = JSON.parse(buf.toString("utf8")); if (!v || typeof v !== "object" || Array.isArray(v)) { errs.push("ожидается объект {…}"); return null; } return v; }
  catch (e) { errs.push("JSON с ошибкой: " + e.message); return null; }
}
const typeOf = (v) => Array.isArray(v) ? "array" : v === null ? "null" : typeof v;
function validateLands(name, buf) {
  const errs = utf8Errs(buf), j = parseJson(buf, errs);
  if (!j) return errs;
  const keys = Object.keys(j);
  if (!keys.length) errs.push("список стран пустой");
  for (const k of keys) {
    if (!/^\/[a-z0-9-]+$/.test(k)) { errs.push("«" + k + "»: адрес страны — со слеша, латиницей в нижнем регистре, например /bulgaria"); continue; }
    if (RESERVED_LANDS.indexOf(k) >= 0) errs.push("«" + k + "»: этот адрес занят сайтом");
    const v = j[k];
    if (!v || typeof v !== "object" || !/^[A-Z]{2}$/.test(String(v.iso || ""))) errs.push("«" + k + "»: нужен iso — код страны из двух заглавных букв");
    else if (!String(v.where || "").trim()) errs.push("«" + k + "»: нужно where — «в какой стране», например «Болгарии»");
  }
  return errs.slice(0, 15);
}
// статьи и инструкции: поля и их типы — как у боевых записей; имена страниц уникальны во всех файлах
function validateContent(name, buf, others) {
  const kind = FILES[name].kind;
  const errs = utf8Errs(buf), j = parseJson(buf, errs);
  if (!j) return errs;
  const sampleFiles = NAMES.filter((n) => FILES[n].kind === kind);
  const sample = {};
  for (const n of sampleFiles) { const p = readJson(FILES[n].dest, {}); for (const k of Object.keys(p)) { const o = p[k]; if (o && typeof o === "object") for (const f of Object.keys(o)) sample[f] = sample[f] || typeOf(o[f]); } }
  for (const slug of Object.keys(j)) {
    if (!/^[a-z0-9-]+$/.test(slug)) { errs.push("«" + slug + "»: имя страницы — латиницей в нижнем регистре, цифры и дефис"); continue; }
    if (RESERVED_SLUGS.indexOf(slug) >= 0) errs.push("«" + slug + "»: адрес /esim/" + slug + " занят сайтом");
    if (others[slug]) errs.push("«" + slug + "»: такая страница уже есть в " + others[slug]);
    const o = j[slug];
    if (!o || typeof o !== "object" || Array.isArray(o)) { errs.push("«" + slug + "»: ожидается объект с полями"); continue; }
    for (const f of Object.keys(sample)) {
      if (!(f in o)) errs.push("«" + slug + "»: нет поля " + f);
      else if (typeOf(o[f]) !== sample[f]) errs.push("«" + slug + "»: поле " + f + " должно быть " + sample[f] + ", а не " + typeOf(o[f]));
    }
  }
  return errs.slice(0, 15);
}
const TG_TAGS = ["b", "strong", "i", "em", "u", "ins", "s", "strike", "del", "code", "pre", "a", "tg-spoiler", "blockquote", "span"];
function validateBot(name, buf) {
  const errs = utf8Errs(buf), j = parseJson(buf, errs);
  if (!j) return errs;
  const r = j.replace;
  if (!r || typeof r !== "object" || Array.isArray(r)) return errs.concat(["нужен раздел \"replace\": { \"как в коде\": \"как показать\" }"]);
  for (const k of Object.keys(r)) {
    const v = r[k];
    if (typeof v !== "string") { errs.push("«" + k.slice(0, 40) + "»: справа должен быть текст в кавычках"); continue; }
    if (v === k) continue;
    if (k.length < 4) errs.push("«" + k + "»: слишком короткий кусок — подмена заденет другие сообщения");
    if (!v.trim()) errs.push("«" + k.slice(0, 40) + "»: пустой текст справа — клиент увидит пустое сообщение или кнопку");
    if (v.length > 3500) errs.push("«" + k.slice(0, 40) + "»: слишком длинно (больше 3500 знаков)");
    const tags = v.match(/<\/?([a-zA-Z-]+)/g) || [];
    for (const t of tags) { const tn = t.replace(/[<\/]/g, "").toLowerCase(); if (TG_TAGS.indexOf(tn) < 0) { errs.push("«" + k.slice(0, 40) + "»: тег <" + tn + "> Телеграм не понимает"); break; } }
    for (const tn of TG_TAGS) {
      const open = (v.match(new RegExp("<" + tn + "(\\s[^>]*)?>", "gi")) || []).length, close = (v.match(new RegExp("</" + tn + ">", "gi")) || []).length;
      const kOpen = (k.match(new RegExp("<" + tn + "(\\s[^>]*)?>", "gi")) || []).length, kClose = (k.match(new RegExp("</" + tn + ">", "gi")) || []).length;
      // кусок может открывать тег, который закроет следующий кусок, — баланс как в исходном
      if (open - close !== kOpen - kClose) { errs.push("«" + k.slice(0, 40) + "»: тег <" + tn + "> открыт/закрыт не так, как в исходном куске"); break; }
    }
  }
  return errs.slice(0, 15);
}
function pngDims(buf) {
  if (buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47 || buf.toString("latin1", 12, 16) !== "IHDR") return null;
  return [buf.readUInt32BE(16), buf.readUInt32BE(20)];
}
function validateImg(name, buf) {
  const errs = [];
  if (buf.length > MAX_IMG) errs.push("больше 1 МБ");
  if (/\.png$/.test(name)) {
    const d = pngDims(buf);
    if (!d) errs.push("это не PNG");
    else if (ICON_DIMS[name] && (d[0] !== ICON_DIMS[name] || d[1] !== ICON_DIMS[name])) errs.push("размер " + d.join("×") + ", а нужен " + ICON_DIMS[name] + "×" + ICON_DIMS[name]);
  } else if (/\.ico$/.test(name)) {
    if (buf.length < 22 || buf.readUInt16LE(0) !== 0 || buf.readUInt16LE(2) !== 1) errs.push("это не ICO");
  } else if (/\.svg$/.test(name)) {
    const s = buf.toString("utf8");
    if (!/<svg[\s>]/i.test(s)) errs.push("это не SVG");
    if (/<script|\bon[a-z]+\s*=/i.test(s)) errs.push("в значке не должно быть скриптов");
  }
  return errs;
}
function validate(name, buf, ctx) {
  const k = FILES[name].kind;
  if (k === "html") return validateHtml(name, buf);
  if (k === "js") return validateJs(name, buf);
  if (k === "lands") return validateLands(name, buf);
  if (k === "articles" || k === "guides") return validateContent(name, buf, (ctx && ctx.others && ctx.others(name)) || {});
  if (k === "bot") return validateBot(name, buf);
  if (k === "img") return validateImg(name, buf);
  return ["неизвестный вид файла"];
}
// имена статей и инструкций в остальных файлах — с учётом того, что выкладывается вместе
function othersFn(pending) {
  return (name) => {
    const out = {};
    for (const n of NAMES) {
      if (n === name || (FILES[n].kind !== "articles" && FILES[n].kind !== "guides")) continue;
      let j = null;
      try { j = JSON.parse((pending[n] || readProd(n) || Buffer.from("{}")).toString("utf8")); } catch (_) { j = {}; }
      for (const s of Object.keys(j || {})) out[s] = n;
    }
    return out;
  };
}

// Свежие копии боевых файлов — ему для pull (папка current читается группой spbadmin).
function refreshCurrent() {
  for (const f of NAMES) {
    const b = readProd(f);
    if (b) writeRoot(path.join(CUR, f), b, 0o640, KATE_GID);
  }
}

function parseChangelog(buf) {
  const lines = buf.toString("utf8").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const title = (lines.shift() || "").replace(/^#+\s*/, "").slice(0, 200);
  const points = lines.map((l) => l.replace(/^[-•*]\s*/, "").slice(0, 1000)).filter(Boolean).slice(0, 20);
  return { title, points };
}
function addChangelog(entry) {
  const list = readJson(CHANGELOG_STORE, []);
  list.unshift(entry);
  // Пишем на месте, без временного файла: служба в песочнице systemd может писать
  // только в сам этот файл, а не во всю /var/www/voyo.
  fs.writeFileSync(CHANGELOG_STORE, JSON.stringify(list.slice(0, 500), null, 1), { mode: 0o600 });
}

function backupProd(f) {
  const b = readProd(f);
  if (!b) return null;
  fs.mkdirSync(BACKUP, { recursive: true, mode: 0o700 });
  const p = path.join(BACKUP, f + "." + stamp(now()) + "-" + short(sha(b)));
  fs.writeFileSync(p, b, { mode: 0o600 });
  const mine = fs.readdirSync(BACKUP).filter((x) => x.startsWith(f + ".")).sort();
  while (mine.length > KEEP_BACKUPS) fs.unlinkSync(path.join(BACKUP, mine.shift()));
  return p;
}
function putProd(f, buf) {
  const dst = FILES[f].dest;
  if (dst.startsWith(PUB + "/") || dst.startsWith(SITE + "/")) {
    // в public можно писать через временный файл и переименование — страница не увидит полфайла
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    const tmp = path.join(path.dirname(dst), "." + f + ".esimdeploy.tmp");
    fs.writeFileSync(tmp, buf, { mode: 0o644 });
    fs.chownSync(tmp, 0, 0);
    fs.chmodSync(tmp, 0o644);
    fs.renameSync(tmp, dst);
  } else {
    // файлы в корне приложения — на месте (песочница пускает только в сами файлы);
    // сервер перечитывает их по времени изменения и недописанный не подхватит
    fs.writeFileSync(dst, buf);
  }
}

function fetchLocal(host, url) {
  return new Promise((resolve) => {
    const req = http.get({ host: "127.0.0.1", port: 3000, path: url, headers: { "Cache-Control": "no-cache", Host: host }, timeout: 20000 }, (res) => {
      const parts = [];
      res.on("data", (c) => parts.push(c));
      res.on("end", () => resolve({ code: res.statusCode, body: Buffer.concat(parts) }));
    });
    req.on("timeout", () => { req.destroy(); resolve({ code: 0, body: Buffer.alloc(0) }); });
    req.on("error", () => resolve({ code: 0, body: Buffer.alloc(0) }));
  });
}
// Отдаёт ли сайт ровно эту версию файла (для статей — открываются ли страницы).
async function served(f, buf) {
  const c = FILES[f];
  if (c.url) { const r = await fetchLocal(c.host, c.url); return r.code === 200 && sha(r.body) === sha(buf); }
  if (c.kind === "articles" || c.kind === "guides") {
    let slugs = []; try { slugs = Object.keys(JSON.parse(buf.toString("utf8"))); } catch (_) {}
    for (const s of slugs.slice(0, 60)) {
      const r = await fetchLocal(VM, "/esim/" + s);
      if (r.code !== 200 && r.code !== 302) return false;
    }
    return true;
  }
  return true;   // тексты бота: файл проверен, бот перечитает его сам
}
// После любой выкладки витрина должна открываться — иначе всё назад.
async function siteAlive() {
  const a = await fetchLocal(VM, "/"), b = await fetchLocal(VT, "/esim"), c = await fetchLocal(VM, "/sitemap.xml");
  return a.code === 200 && /<\/html>/i.test(a.body.toString("utf8")) && b.code === 200 && c.code === 200;
}
const needsReloadWait = (list) => list.some((f) => { const d = String(FILES[f].dest); return !d.startsWith(PUB + "/") && !d.startsWith(SITE + "/"); });

// Выложить набор файлов разом; при сбое — вернуть все как было. items: [{f, buf}]
async function putAll(items, opt) {
  const done = [];
  // undo: прежняя версия обратно; файла раньше не было — убираем
  const undo = async () => {
    for (const d of done.slice().reverse()) {
      try { if (d.old) putProd(d.f, d.old); else fs.unlinkSync(FILES[d.f].dest); } catch (e) { logLine({ cmd: "undo", file: d.f, error: e.message }); }
    }
  };
  try {
    for (const it of items) {
      const old = readProd(it.f);
      const bak = (opt && opt.noBackup) ? null : backupProd(it.f);
      done.push({ f: it.f, old, bak });
      putProd(it.f, it.buf);
    }
  } catch (e) {
    await undo();
    return { ok: false, bad: "не удалось записать файл (" + e.message + ")" };
  }
  if (needsReloadWait(items.map((x) => x.f))) await sleep(4000);   // сервер перечитывает такие файлы раз в 3 с
  for (const it of items) {
    if (!(await served(it.f, it.buf))) { await undo(); if (needsReloadWait(items.map((x) => x.f))) await sleep(4000); return { ok: false, bad: it.f + ": сайт не отдал новую версию" }; }
  }
  if (!(await siteAlive())) { await undo(); if (needsReloadWait(items.map((x) => x.f))) await sleep(4000); return { ok: false, bad: "после выкладки витрина перестала открываться" }; }
  return { ok: true, done };
}

// ── слепки ──
const snapName = (s) => String(s || "").trim();
const SNAP_RE = /^[A-Za-zА-Яа-яЁё0-9._-]{1,40}$/;
function makeSnapshot(name, by, protect) {
  if (!SNAP_RE.test(name)) throw new Error("имя слепка: буквы, цифры, точка, дефис, подчёркивание, до 40 знаков");
  const dir = path.join(SNAPS, name);
  if (fs.existsSync(dir)) throw new Error("слепок «" + name + "» уже есть — придумайте другое имя");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const files = {};
  for (const f of NAMES) { const b = readProd(f); if (b) { fs.writeFileSync(path.join(dir, f), b, { mode: 0o600 }); files[f] = sha(b); } }
  fs.writeFileSync(path.join(dir, "meta.json"), JSON.stringify({ name, at: msk(now()), by, protect: !!protect, files }, null, 1), { mode: 0o600 });
  // старые незащищённые — прочь
  const all = listSnapshots().filter((s) => !s.protect);
  while (all.length > KEEP_SNAPS) { const s = all.shift(); fs.rmSync(path.join(SNAPS, s.name), { recursive: true, force: true }); }
  return Object.keys(files).length;
}
function listSnapshots() {
  if (!fs.existsSync(SNAPS)) return [];
  return fs.readdirSync(SNAPS).map((n) => readJson(path.join(SNAPS, n, "meta.json"), null)).filter(Boolean)
    .sort((a, b) => String(a.at).localeCompare(String(b.at)));
}

async function run(reqObj, st) {
  const cmd = String(reqObj.cmd || "");
  const out = [];
  const say = (s) => out.push(s);

  if (cmd === "pull") {
    refreshCurrent();
    for (const f of NAMES) { const b = readProd(f); st.base[f] = b ? sha(b) : null; }
    say("Взяты боевые версии всех файлов (" + NAMES.length + "). Что за что отвечает — esimdeploy files.");
    return { ok: true, text: out.join("\n") };
  }

  if (cmd === "files") {
    for (const f of NAMES) say(f.padEnd(24) + " " + FILES[f].what);
    return { ok: true, text: out.join("\n") };
  }

  if (cmd === "status" || cmd === "check") {
    let problems = 0, same = 0, missing = 0;
    const pending = {};
    for (const f of NAMES) { const k = readKate(f); if (k) pending[f] = k; }
    const ctx = { others: othersFn(pending) };
    for (const f of NAMES) {
      const p = readProd(f), k = pending[f];
      const ps = p ? sha(p) : null, ks = k ? sha(k) : null;
      if (!k) { missing++; continue; }
      const stale = st.base[f] && ps !== st.base[f];
      if (ks === ps && !stale) { same++; continue; }
      let line = f + ": " + (ks === ps ? "совпадает с боевым" : "ваш отличается от боевого");
      if (stale) line += ". ВНИМАНИЕ: боевой изменился после вашего pull — сделайте pull и перенесите правки";
      if (!st.base[f]) line += ". pull ещё не делали";
      say(line);
      if (cmd === "check" && ks !== ps) {
        const errs = validate(f, k, ctx);
        problems += errs.length;
        say(errs.length ? "  проверка: " + errs.join("; ") : "  проверка: всё в порядке");
      }
    }
    say("Совпадают с боевыми: " + same + (missing ? ", нет у вас: " + missing + " (сделайте pull)" : ""));
    return { ok: problems === 0, text: out.join("\n") };
  }

  if (cmd === "deploy") {
    const clBuf = readKate("CHANGELOG.md");
    if (!clBuf) return { ok: false, text: "Нет ~/esim-deploy/CHANGELOG.md — опишите, что меняется: первая строка заголовок, дальше пункты «- …»." };
    const cl = parseChangelog(clBuf);
    if (!cl.title || !cl.points.length) return { ok: false, text: "В CHANGELOG.md нужен заголовок (первая строка) и хотя бы один пункт «- …»" };
    if (st.lastChangelogSha && st.lastChangelogSha === sha(clBuf)) return { ok: false, text: "CHANGELOG.md тот же, что в прошлой выкладке — опишите эту" };

    const pending = {};
    for (const f of NAMES) { const k = readKate(f); if (k) pending[f] = k; }
    const ctx = { others: othersFn(pending) };
    const todo = [];
    for (const f of NAMES) {
      const k = pending[f];
      if (!k) continue;
      const p = readProd(f);
      if (p && sha(p) === sha(k)) continue;
      if (!st.base[f]) return { ok: false, text: f + ": сначала сделайте pull — без него не видно, не затрёте ли вы чужие правки" };
      if (p && sha(p) !== st.base[f]) return { ok: false, text: f + ": боевой файл изменился после вашего pull (кто-то выложил правку). Сделайте pull, перенесите свои правки в свежую версию и выкладывайте снова." };
      const errs = validate(f, k, ctx);
      if (errs.length) return { ok: false, text: f + ": не выложено — " + errs.join("; ") };
      todo.push({ f, buf: k });
    }
    if (!todo.length) return { ok: false, text: "Нечего выкладывать: ваши файлы совпадают с боевыми" };

    const r = await putAll(todo);
    if (!r.ok) {
      logLine({ who: "spbadmin", cmd: "deploy", result: "откат: " + r.bad, files: todo.map((x) => x.f) });
      return { ok: false, text: r.bad + " — всё возвращено как было. Ничего не сломано; поправьте файл или напишите Андрею." };
    }
    for (const t of todo) { st.base[t.f] = sha(t.buf); say(t.f + ": выложено (" + short(sha(t.buf)) + "), копия прежней версии сохранена"); }
    st.lastChangelogSha = sha(clBuf);
    addChangelog({ date: mskDate(now()), title: cl.title, by: "Андрей Петров", points: cl.points,
                   files: todo.map((d) => d.f), at: now().toISOString() });
    refreshCurrent();
    logLine({ who: "spbadmin", cmd: "deploy", files: todo.map((d) => d.f + " " + short(sha(d.buf))), title: cl.title });
    say("Изменение «" + cl.title + "» записано в журнал выкладок.");
    if (todo.some((t) => FILES[t.f].kind === "bot")) say("Тексты бота подхватятся сами в течение нескольких секунд — проверьте в @esimvoyo_bot.");
    say("Проверьте глазами (и на телефоне). Не так — esimdeploy rollback <файл> или esimdeploy restore <слепок>.");
    return { ok: true, text: out.join("\n") };
  }

  if (cmd === "rollback") {
    const f = String(reqObj.file || "");
    if (!FILES[f]) return { ok: false, text: "Такого файла нет в списке. Список: esimdeploy files" };
    // шаг назад: самая свежая сохранённая версия, отличная от боевой. Использованную копию и всё,
    // что новее, убираем — следующий rollback уйдёт ещё на шаг назад, а не вернёт плохую версию.
    // Текущая (откатываемая) версия кладётся отдельно, как _откат_<файл>…, и в шаги не попадает.
    const cur = readProd(f);
    const list = fs.existsSync(BACKUP) ? fs.readdirSync(BACKUP).filter((x) => x.startsWith(f + ".")).sort() : [];
    let i = list.length - 1;
    while (i >= 0 && cur && sha(fs.readFileSync(path.join(BACKUP, list[i]))) === sha(cur)) i--;
    if (i < 0) return { ok: false, text: f + ": более ранних версий нет. Вернуть всё к исходному: esimdeploy restore исходное-2026-10-20" };
    const from = list[i];
    const b = fs.readFileSync(path.join(BACKUP, from));
    if (cur) fs.writeFileSync(path.join(BACKUP, "_откат_" + f + "." + stamp(now()) + "-" + short(sha(cur))), cur, { mode: 0o600 });
    const r = await putAll([{ f, buf: b }], { noBackup: true });
    if (!r.ok) return { ok: false, text: f + ": откат не прошёл проверку (" + r.bad + ") — оставлено как было, напишите Андрею." };
    for (const x of list.slice(i)) { try { fs.unlinkSync(path.join(BACKUP, x)); } catch (_) {} }
    st.base[f] = null;   // после отката — свежий pull, чтобы не выложить поверх старую копию
    refreshCurrent();
    addChangelog({ date: mskDate(now()), title: "Откат " + f + " к предыдущей версии", by: "Андрей Петров",
                   points: ["Возвращена версия, сохранённая при выкладке: " + from], files: [f], at: now().toISOString() });
    logLine({ who: "spbadmin", cmd: "rollback", file: f, to: from });
    return { ok: true, text: f + ": возвращена версия " + from + ". Сделайте esimdeploy pull." };
  }

  if (cmd === "snapshot") {
    const name = snapName(reqObj.file);
    const n = makeSnapshot(name, "Андрей Петров", false);
    logLine({ who: "spbadmin", cmd: "snapshot", name });
    return { ok: true, text: "Слепок «" + name + "» сохранён: " + n + " файлов в боевом состоянии на " + msk(now()) + ". Вернуть: esimdeploy restore " + name };
  }

  if (cmd === "snapshots") {
    const list = listSnapshots();
    if (!list.length) return { ok: true, text: "Слепков пока нет" };
    for (const s of list) {
      let diff = 0;
      for (const f of Object.keys(s.files || {})) { const p = readProd(f); if (!p || sha(p) !== s.files[f]) diff++; }
      say(s.name + " — " + s.at + ", " + s.by + (s.protect ? ", защищён" : "") + ", отличается от боевого файлов: " + diff);
    }
    return { ok: true, text: out.join("\n") };
  }

  if (cmd === "restore") {
    const name = snapName(reqObj.file);
    const meta = SNAP_RE.test(name) ? readJson(path.join(SNAPS, name, "meta.json"), null) : null;
    if (!meta) return { ok: false, text: "Нет слепка «" + name + "». Список: esimdeploy snapshots" };
    const items = [];
    for (const f of Object.keys(meta.files || {})) {
      if (!FILES[f]) continue;
      const b = fs.readFileSync(path.join(SNAPS, name, f));
      const p = readProd(f);
      if (!p || sha(p) !== sha(b)) items.push({ f, buf: b });
    }
    if (!items.length) return { ok: true, text: "Боевые файлы уже совпадают со слепком «" + name + "», возвращать нечего." };
    const auto = "до-отката-" + stamp(now());
    makeSnapshot(auto, "автоматически перед restore " + name, false);
    const r = await putAll(items);
    if (!r.ok) return { ok: false, text: "Откат к «" + name + "» не прошёл проверку (" + r.bad + ") — всё оставлено как было. Напишите Андрею." };
    for (const it of items) st.base[it.f] = null;
    refreshCurrent();
    addChangelog({ date: mskDate(now()), title: "Откат к слепку «" + name + "»", by: "Андрей Петров",
                   points: ["Возвращены файлы: " + items.map((x) => x.f).join(", "), "Состояние до отката сохранено слепком «" + auto + "»"],
                   files: items.map((x) => x.f), at: now().toISOString() });
    logLine({ who: "spbadmin", cmd: "restore", name, files: items.map((x) => x.f), auto });
    return { ok: true, text: "Возвращено к слепку «" + name + "»: " + items.map((x) => x.f).join(", ") + ".\nТо, что было до отката, сохранено слепком «" + auto + "» (можно вернуть так же).\nСделайте esimdeploy pull." };
  }

  if (cmd === "log") {
    const lines = fs.existsSync(LOG) ? fs.readFileSync(LOG, "utf8").trim().split("\n").slice(-15) : [];
    return { ok: true, text: lines.length ? lines.join("\n") : "выкладок ещё не было" };
  }

  return { ok: false, text: "Неизвестное действие. Есть: pull, files, status, check, deploy, rollback <файл>, snapshot <имя>, snapshots, restore <имя>, log" };
}

(async () => {
  for (const d of [LIB, OUT, CUR, SNAPS]) fs.mkdirSync(d, { recursive: true });
  // Андрей с сервера (root): node esim-deploy.js --snapshot <имя> — защищённый слепок
  const ai = process.argv.indexOf("--snapshot");
  if (ai > 0) {
    const n = makeSnapshot(process.argv[ai + 1], "Андрей", true);
    refreshCurrent();
    console.log("слепок «" + process.argv[ai + 1] + "»: " + n + " файлов, защищён");
    return;
  }
  const raw = readKate("REQUEST");
  if (!raw) return;
  let r;
  try { r = JSON.parse(raw.toString("utf8")); } catch (_) { return; }
  const id = String(r.id || "");
  if (!/^[0-9a-z-]{6,40}$/.test(id)) return;
  const st = readJson(STATE, { base: {}, done: [] });
  st.base = st.base || {}; st.done = st.done || [];
  if (st.done.indexOf(id) >= 0) return;                       // эта заявка уже обработана
  let res;
  try { res = await run(r, st); }
  catch (e) { res = { ok: false, text: "Ошибка: " + e.message }; logLine({ who: "spbadmin", cmd: r.cmd, error: e.message }); }
  st.done.push(id); st.done = st.done.slice(-200);
  writeRoot(STATE, JSON.stringify(st, null, 1), 0o600, 0);
  writeRoot(path.join(OUT, id + ".txt"), (res.ok ? "OK\n" : "ОШИБКА\n") + res.text + "\n", 0o640, KATE_GID);
  for (const x of fs.readdirSync(OUT)) {
    const p = path.join(OUT, x);
    try { if (Date.now() - fs.statSync(p).mtimeMs > 86400e3) fs.unlinkSync(p); } catch (_) {}
  }
})();
