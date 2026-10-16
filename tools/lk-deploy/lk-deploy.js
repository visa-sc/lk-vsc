#!/usr/bin/env node
// lk-deploy — выкладка визового клиентского ЛК Екатериной Зайцевой (16.10.2026, решение Андрея:
// «безопасный способ выкладывания, правки только к визовому личному кабинету, остальное не трогать»).
//
// Как работает. Катя к /var/www/voyo доступа не имеет и не получает. Она правит файлы у себя в
// ~/lk-deploy и командой `lkdeploy <действие>` пишет файл-заявку ~/lk-deploy/REQUEST. systemd
// (lk-deploy.path) замечает заявку и запускает этот скрипт от root. Скрипт:
//   - берёт из её папки ТОЛЬКО файлы из WHITELIST (пути из заявки не принимаются);
//   - читает их безопасно: обычный файл, владелец kateadmin, без ссылок (O_NOFOLLOW, nlink=1) —
//     подсунуть чужой файл (например .env) вместо своего нельзя;
//   - в её папку root НИЧЕГО не пишет и не удаляет: ответы — в /var/lib/lk-deploy/out;
//   - перед выкладкой проверяет кодировку, размер и синтаксис всех встроенных <script>;
//   - не даёт выложить, если боевой файл менялся после её последнего pull (не затереть чужое);
//   - сохраняет копию боевого файла для отката, пишет запись в журнал изменений ЛК
//     (/var/www/voyo/.lkChangelogKate.json — его показывает админка в «Истории изменений»);
//   - после выкладки проверяет, что сайт отдаёт новую версию, иначе сам откатывает.
"use strict";
const fs = require("fs"), path = require("path"), crypto = require("crypto"), vm = require("vm"), http = require("http");

const KATE_UID = 1001, KATE_GID = 1001;
const INBOX = "/home/kateadmin/lk-deploy";
const LIB = "/var/lib/lk-deploy";
const OUT = LIB + "/out", CUR = LIB + "/current", PREVIEW = LIB + "/preview";
const STATE = LIB + "/state.json", LOG = LIB + "/deploy.log", KEYF = LIB + "/preview.key";
const PROD = "/var/www/voyo/public";
const BACKUP = "/var/www/voyo/.lk-deploy-backups";
const CHANGELOG_STORE = "/var/www/voyo/.lkChangelogKate.json";
// Только визовый кабинет и страница входа в него. Остальное (eSIM, «Карты», «Баллы», опросники
// и вся серверная часть) Кате пока не выдано — решение Андрея 16.10.2026.
const WHITELIST = ["cabinet.html", "index.html"];
// По какому адресу сайт отдаёт файл — для проверки после выкладки.
const URL_OF = { "cabinet.html": "/cabinet", "index.html": "/" };
const MAX = 2 * 1024 * 1024;
const KEEP_BACKUPS = 30;

const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
const short = (h) => (h ? h.slice(0, 10) : "—");
const now = () => new Date();
const msk = (d) => new Date(d.getTime() + 3 * 3600e3).toISOString().replace("T", " ").slice(0, 19);
const mskDate = (d) => { const s = new Date(d.getTime() + 3 * 3600e3).toISOString(); return s.slice(8, 10) + "." + s.slice(5, 7) + "." + s.slice(0, 4); };
const stamp = (d) => new Date(d.getTime() + 3 * 3600e3).toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);

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

// Безопасное чтение файла из её папки (см. шапку). null — файла нет.
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
    if (st.uid !== KATE_UID) throw new Error(name + ": файл должен принадлежать kateadmin");
    if (st.nlink !== 1) throw new Error(name + ": у файла есть жёсткие ссылки — сделайте обычную копию");
    if (st.size > MAX) throw new Error(name + ": больше 2 МБ");
    const buf = Buffer.alloc(st.size);
    let off = 0;
    while (off < st.size) { const n = fs.readSync(fd, buf, off, st.size - off, off); if (!n) break; off += n; }
    return buf.subarray(0, off);
  } finally { fs.closeSync(fd); }
}
function readProd(name) { try { return fs.readFileSync(path.join(PROD, name)); } catch (_) { return null; } }

// Проверка перед предпросмотром и выкладкой. Возвращает список проблем (пусто — можно).
function validate(name, buf) {
  const errs = [];
  const s = buf.toString("utf8");
  if (!Buffer.from(s, "utf8").equals(buf) || s.indexOf("�") >= 0) errs.push("файл не в UTF-8 или в нём битые символы");
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

// Свежие копии боевых файлов — ей для pull (папка current читается группой kateadmin).
function refreshCurrent() {
  for (const f of WHITELIST) {
    const b = readProd(f);
    if (b) writeRoot(path.join(CUR, f), b, 0o640, KATE_GID);
  }
}

// Запись в журнал изменений ЛК из её CHANGELOG.md: первая строка — заголовок, дальше пункты «- …».
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
  // Храним последние KEEP_BACKUPS копий каждого файла.
  const mine = fs.readdirSync(BACKUP).filter((x) => x.startsWith(f + ".")).sort();
  while (mine.length > KEEP_BACKUPS) fs.unlinkSync(path.join(BACKUP, mine.shift()));
  return p;
}
function putProd(f, buf) {
  const dst = path.join(PROD, f), tmp = path.join(PROD, "." + f + ".lkdeploy.tmp");
  fs.writeFileSync(tmp, buf, { mode: 0o644 });
  fs.chownSync(tmp, 0, 0);
  fs.chmodSync(tmp, 0o644);
  fs.renameSync(tmp, dst);
}
// Отдаёт ли сайт ровно эту версию файла.
function served(f, wantSha) {
  return new Promise((resolve) => {
    const req = http.get({ host: "127.0.0.1", port: 3000, path: URL_OF[f], headers: { "Cache-Control": "no-cache" }, timeout: 15000 }, (res) => {
      const parts = [];
      res.on("data", (c) => parts.push(c));
      res.on("end", () => resolve(res.statusCode === 200 && sha(Buffer.concat(parts)) === wantSha));
    });
    req.on("timeout", () => { req.destroy(); resolve(false); });
    req.on("error", () => resolve(false));
  });
}

async function run(reqObj, st) {
  const cmd = String(reqObj.cmd || "");
  const out = [];
  const say = (s) => out.push(s);

  if (cmd === "pull") {
    refreshCurrent();
    for (const f of WHITELIST) {
      const b = readProd(f);
      st.base[f] = b ? sha(b) : null;
      say(f + ": взята боевая версия " + short(st.base[f]));
    }
    return { ok: true, text: out.join("\n") };
  }

  if (cmd === "status" || cmd === "check") {
    let problems = 0;
    for (const f of WHITELIST) {
      const p = readProd(f), k = readKate(f);
      const ps = p ? sha(p) : null, ks = k ? sha(k) : null;
      let line = f + ": боевой " + short(ps);
      if (!k) line += ", у вас файла нет";
      else if (ks === ps) line += ", ваш совпадает с боевым";
      else line += ", ваш отличается (" + short(ks) + ")";
      if (st.base[f] && ps !== st.base[f]) line += ". ВНИМАНИЕ: боевой изменился после вашего pull — сделайте pull и перенесите правки";
      if (!st.base[f]) line += ". pull ещё не делали";
      say(line);
      if (cmd === "check" && k && ks !== ps) {
        const errs = validate(f, k);
        problems += errs.length;
        say(errs.length ? "  проверка: " + errs.join("; ") : "  проверка: всё в порядке");
      }
    }
    return { ok: problems === 0, text: out.join("\n") };
  }

  if (cmd === "preview") {
    let key = "";
    try { key = fs.readFileSync(KEYF, "utf8").trim(); } catch (_) {}
    if (!key) { key = crypto.randomBytes(16).toString("hex"); writeRoot(KEYF, key + "\n", 0o640, KATE_GID); }
    let any = false, bad = false;
    for (const f of WHITELIST) {
      const k = readKate(f);
      if (!k) continue;
      const errs = validate(f, k);
      if (errs.length) { bad = true; say(f + ": НЕ выложен в предпросмотр — " + errs.join("; ")); continue; }
      writeRoot(path.join(PREVIEW, f), k, 0o600, 0);
      any = true;
      say(f + ": в предпросмотре — https://voyotravel.ru/lk-preview/" + f.replace(".html", "") + "?k=" + key);
    }
    if (!any && !bad) say("в ~/lk-deploy нет ни cabinet.html, ни index.html");
    if (any) say("Предпросмотр видят только те, у кого есть ссылка. Данные — настоящие: войдите в кабинет как обычно (или откройте клиента через «Вход в ЛК клиента» в админке) и откройте ссылку.");
    return { ok: any && !bad, text: out.join("\n") };
  }

  if (cmd === "deploy") {
    const clBuf = readKate("CHANGELOG.md");
    if (!clBuf) return { ok: false, text: "Нет ~/lk-deploy/CHANGELOG.md — опишите, что меняется: первая строка заголовок, дальше пункты «- …». Эта запись попадёт в «Историю изменений» ЛК в админке." };
    const cl = parseChangelog(clBuf);
    if (!cl.title || !cl.points.length) return { ok: false, text: "В CHANGELOG.md нужен заголовок (первая строка) и хотя бы один пункт «- …»" };
    if (st.lastChangelogSha && st.lastChangelogSha === sha(clBuf)) return { ok: false, text: "CHANGELOG.md тот же, что в прошлой выкладке — опишите эту" };

    const todo = [];
    for (const f of WHITELIST) {
      const k = readKate(f);
      if (!k) continue;
      const p = readProd(f);
      if (p && sha(p) === sha(k)) continue;
      if (!st.base[f]) return { ok: false, text: f + ": сначала сделайте pull — без него не видно, не затрёте ли вы чужие правки" };
      if (p && sha(p) !== st.base[f]) return { ok: false, text: f + ": боевой файл изменился после вашего pull (кто-то выложил правку). Сделайте pull, перенесите свои правки в свежую версию и выкладывайте снова." };
      const errs = validate(f, k);
      if (errs.length) return { ok: false, text: f + ": не выложено — " + errs.join("; ") };
      todo.push({ f, k, ks: sha(k) });
    }
    if (!todo.length) return { ok: false, text: "Нечего выкладывать: ваши файлы совпадают с боевыми" };

    const done = [];
    for (const t of todo) {
      const bak = backupProd(t.f);
      putProd(t.f, t.k);
      const ok = await served(t.f, t.ks);
      if (!ok) {
        // Сайт не отдаёт новую версию — возвращаем как было и прекращаем.
        if (bak) putProd(t.f, fs.readFileSync(bak));
        for (const d of done) if (d.bak) putProd(d.f, fs.readFileSync(d.bak));
        logLine({ who: "kateadmin", cmd: "deploy", result: "откат: сайт не отдал новую версию", files: todo.map((x) => x.f) });
        return { ok: false, text: t.f + ": после выкладки сайт не отдал новую версию — всё возвращено как было. Напишите Андрею." };
      }
      st.base[t.f] = t.ks;
      done.push({ f: t.f, bak, ks: t.ks });
      say(t.f + ": выложено (" + short(t.ks) + "), копия прежней версии сохранена");
    }
    st.lastChangelogSha = sha(clBuf);
    addChangelog({ date: mskDate(now()), title: cl.title, by: "Екатерина Зайцева", points: cl.points,
                   files: done.map((d) => d.f), at: now().toISOString() });
    refreshCurrent();
    logLine({ who: "kateadmin", cmd: "deploy", files: done.map((d) => d.f + " " + short(d.ks)), title: cl.title });
    say("Запись «" + cl.title + "» добавлена в «Историю изменений» ЛК в админке.");
    say("Проверьте кабинет глазами: voyotravel.ru/cabinet (и на телефоне). Если что-то не так — lkdeploy rollback <файл>.");
    return { ok: true, text: out.join("\n") };
  }

  if (cmd === "rollback") {
    const f = String(reqObj.file || "");
    if (WHITELIST.indexOf(f) < 0) return { ok: false, text: "Откатить можно только: " + WHITELIST.join(", ") };
    const list = fs.existsSync(BACKUP) ? fs.readdirSync(BACKUP).filter((x) => x.startsWith(f + ".")).sort() : [];
    if (!list.length) return { ok: false, text: f + ": сохранённых версий нет" };
    const from = path.join(BACKUP, list[list.length - 1]);
    const b = fs.readFileSync(from);
    backupProd(f);                                   // текущую тоже сохраняем — откат обратим
    // Только что сохранённая копия текущей версии — теперь последняя; её как источник не берём.
    putProd(f, b);
    const ok = await served(f, sha(b));
    st.base[f] = sha(b);
    refreshCurrent();
    addChangelog({ date: mskDate(now()), title: "Откат " + f + " к предыдущей версии", by: "Екатерина Зайцева",
                   points: ["Возвращена версия, сохранённая при выкладке: " + list[list.length - 1]], files: [f], at: now().toISOString() });
    logLine({ who: "kateadmin", cmd: "rollback", file: f, to: list[list.length - 1], served: ok });
    return { ok: ok, text: f + ": возвращена версия " + list[list.length - 1] + (ok ? "" : " — но сайт её не отдаёт, напишите Андрею") + ". Сделайте lkdeploy pull." };
  }

  if (cmd === "log") {
    const lines = fs.existsSync(LOG) ? fs.readFileSync(LOG, "utf8").trim().split("\n").slice(-15) : [];
    return { ok: true, text: lines.length ? lines.join("\n") : "выкладок ещё не было" };
  }

  return { ok: false, text: "Неизвестное действие. Есть: pull, status, check, preview, deploy, rollback <файл>, log" };
}

(async () => {
  for (const d of [LIB, OUT, CUR, PREVIEW]) fs.mkdirSync(d, { recursive: true });
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
  catch (e) { res = { ok: false, text: "Ошибка: " + e.message }; logLine({ who: "kateadmin", cmd: r.cmd, error: e.message }); }
  st.done.push(id); st.done = st.done.slice(-200);
  writeRoot(STATE, JSON.stringify(st, null, 1), 0o600, 0);
  writeRoot(path.join(OUT, id + ".txt"), (res.ok ? "OK\n" : "ОШИБКА\n") + res.text + "\n", 0o640, KATE_GID);
  // Ответы старше суток убираем.
  for (const x of fs.readdirSync(OUT)) {
    const p = path.join(OUT, x);
    try { if (Date.now() - fs.statSync(p).mtimeMs > 86400e3) fs.unlinkSync(p); } catch (_) {}
  }
})();
