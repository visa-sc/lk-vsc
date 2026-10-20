// Содержимое eSIM, которое правит Андрей Петров через esimdeploy (20.10.2026): статьи, список
// стран, тексты бота. Файлы перечитываются на лету, когда меняются: выкладка не требует
// перезапуска сервера. Битый или недописанный файл не подхватывается — остаётся прежняя версия.
"use strict";
const fs = require("fs");

function jsonWatch(file, fallback) {
  let cache = null, mtime = 0, checked = 0;
  return function get() {
    const now = Date.now();
    if (cache && now - checked < 3000) return cache;
    checked = now;
    let st = null;
    try {
      st = fs.statSync(file);
      if (!cache || st.mtimeMs !== mtime) {
        mtime = st.mtimeMs;                       // битую версию не перечитываем каждые 3 с — ждём следующую
        cache = JSON.parse(fs.readFileSync(file, "utf8"));
      }
    } catch (e) {
      // файл дописывается прямо сейчас — попробуем ещё раз через 3 с
      if (st && e instanceof SyntaxError && Date.now() - st.mtimeMs < 5000) mtime = 0;
      if (!cache) cache = fallback;
      if (e.code !== "ENOENT") console.error("esim content " + file + ":", e.message);
    }
    return cache;
  };
}

// Страницы и скрипты eSIM в правке Петрова лежат отдельно — esim-site/ — и отдаются ТОЛЬКО на
// доменах eSIM. На voyotravel.ru (и в разделе eSIM внутри ЛК, и во вкладке eSIM панели руководителей)
// остаются копии из public/, которые выкладывает Андрей. Зачем (аудит 20.10.2026): в браузере на
// voyotravel.ru лежат токены входа в админку, /vsc и сессии клиентов ЛК; скрипт, который правит
// сотрудник, не должен исполняться на этом домене.
const path = require("path");
const SITE_DIR = path.join(__dirname, "esim-site");
const PUBLIC_DIR = path.join(__dirname, "public");
const OWN_HOSTS = new Set(["voyomobile.ru", "voyomobile.com", "esim.voyotravel.ru", "dev.voyomobile.ru", "dev.voyomobile.com"]);
function onEsimHost(req) { return OWN_HOSTS.has(String((req && req.hostname) || "").toLowerCase()); }
function pageFile(req, name) {
  if (onEsimHost(req)) { const p = path.join(SITE_DIR, name); if (fs.existsSync(p)) return p; }
  return path.join(PUBLIC_DIR, name);
}
// список стран — данные, а не код: читаем версию Петрова (по ней работают адреса voyomobile.ru/<страна>)
const landsFile = () => (fs.existsSync(path.join(SITE_DIR, "esim-lands.json")) ? path.join(SITE_DIR, "esim-lands.json") : path.join(PUBLIC_DIR, "esim-lands.json"));

module.exports = { jsonWatch, pageFile, onEsimHost, landsFile, SITE_DIR };
