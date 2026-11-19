// ═════════════════════════════════════════════════════════════════════════════
// Комната «Помощники Андрей-Андрей» для Claude Андрея Петрова (19.11.2026, просьба Андрея).
//
// В чате work.voyotravel.ru (сервис Екатерины) у Андрея две комнаты помощников:
//   «Помощники Андрей-Катя»   (gmvcc6iz9pmsc) — с Катей и её Claude, её Claude читает файлы сервера сам;
//   «Помощники Андрей-Андрей» (HELPERS_PETROV_ROOM) — с Петровым. Его Claude живёт на его компьютере,
//   поэтому ходит сюда по HTTP тем же личным ключом, что и в /data-api (DATA_RO_KEYS, имя petrov).
//
//   GET  /data-api/room              — что это и как пользоваться
//   GET  /data-api/room/readme       — памятка для его Claude (markdown)
//   GET  /data-api/room/messages     — сообщения комнаты (?since=ISO, ?limit=)
//   GET  /data-api/room/file/:id     — файл, приложенный в этой комнате
//   POST /data-api/room/say {text}   — написать в комнату от «Помощник Петрова» (robot:claude-petrov)
//
// Чтение — прямо с диска (файлы чата Кати, только чтение). Запись — НЕ из этого процесса: файлы
// чата принадлежат kateadmin, поэтому пишем через tools/helpersRoomSay.js, запущенный от kateadmin
// (тот же путь, что claude-say.js). Другие комнаты этим ключом не видны и не пишутся.
// ═════════════════════════════════════════════════════════════════════════════
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const ROOM = () => process.env.HELPERS_PETROV_ROOM || "mwnfd15c4znxl";
const KATE = "/var/www/kateadmin/data/notify";
const README = path.join(__dirname, "tools", "helpersRoomReadme.md");
const NAMES = { "director@visa-sc.ru": "Андрей Комисаренко", "ap@spt1.ru": "Андрей Петров",
                "robot:claude": "Помощник Андрея", "robot:claude-petrov": "Помощник Петрова" };
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch (_) { return d; } };

function keys() {
  const out = {};
  for (const pair of String(process.env.DATA_RO_KEYS || "").split(",")) {
    const i = pair.indexOf(":");
    if (i > 0) { const name = pair.slice(0, i).trim(), key = pair.slice(i + 1).trim(); if (name && key.length >= 24) out[key] = name; }
  }
  return out;
}
function auth(req, res, next) {
  const k = String(req.headers["x-ro-key"] || String(req.headers.authorization || "").replace(/^Bearer\s+/i, "") || "").trim();
  if (keys()[k] !== "petrov") return res.status(401).json({ ok: false, error: "Нужен ключ Андрея Петрова: заголовок X-RO-Key" });
  next();
}
function months() {
  try { return fs.readdirSync(path.join(KATE, "chat", ROOM())).filter((f) => /^\d{4}-\d{2}\.json$/.test(f)).sort().map((f) => f.slice(0, 7)); } catch (_) { return []; }
}
function messages(since, limit) {
  let out = [];
  for (const m of months()) {
    for (const x of (readJson(path.join(KATE, "chat", ROOM(), m + ".json"), { list: [] }).list || [])) {
      if (x.deletedAt || (since && !(x.at > since))) continue;
      out.push({ id: x.id, at: x.at, from: x.from, name: NAMES[x.from] || x.from, text: x.text || "",
                 reply: x.reply ? x.reply.id || "" : "", thread: x.thread || "",
                 files: (x.files || []).map((f) => ({ id: f.id, name: f.name, size: f.size })) });
    }
  }
  out.sort((a, b) => (a.at < b.at ? -1 : 1));
  return out.slice(-limit);
}
function fileMeta(id) {
  const clean = String(id || "").replace(/[^a-z0-9]/gi, "");
  if (!clean) return null;
  try {
    for (const mo of fs.readdirSync(path.join(KATE, "files")).sort().reverse()) {
      const f = path.join(KATE, "files", mo, clean + ".json");
      if (fs.existsSync(f)) { const m = readJson(f, null); if (m) return { meta: m, dir: path.join(KATE, "files", mo) }; }
    }
  } catch (_) {}
  return null;
}
let sent = [];   // защита от зацикливания робота: не больше 30 сообщений в час
function say(text, key) {
  return new Promise((ok) => {
    const p = spawn("runuser", ["-u", "kateadmin", "--", "node", path.join(__dirname, "tools", "helpersRoomSay.js"), ROOM(), "claude-petrov", key || ""], { stdio: ["pipe", "pipe", "pipe"] });
    let out = "", err = "";
    p.stdout.on("data", (d) => (out += d)); p.stderr.on("data", (d) => (err += d));
    p.on("close", (code) => { try { ok(JSON.parse(out.trim().split("\n").pop())); } catch (_) { ok({ ok: false, error: (err || out || "код " + code).slice(0, 200) }); } });
    p.stdin.end(text);
  });
}

function mount({ app, express }) {
  app.get("/data-api/room", auth, (req, res) => res.json({
    ok: true, room: "Помощники Андрей-Андрей", members: Object.values(NAMES),
    endpoints: {
      readme: "GET /data-api/room/readme — памятка (прочитать первым)",
      messages: "GET /data-api/room/messages?since=<ISO-время последнего прочитанного>&limit=200",
      file: "GET /data-api/room/file/<id> — файл из сообщения",
      say: "POST /data-api/room/say  JSON {\"text\": \"...\", \"key\": \"<необязательно: метка от повтора>\"}"
    }
  }));
  app.get("/data-api/room/readme", auth, (req, res) => {
    res.type("text/markdown; charset=utf-8");
    try { res.send(fs.readFileSync(README, "utf8")); } catch (_) { res.status(404).send("памятки нет"); }
  });
  app.get("/data-api/room/messages", auth, (req, res) => {
    const since = /^\d{4}-\d{2}-\d{2}T/.test(String(req.query.since || "")) ? String(req.query.since) : "";
    const limit = Math.max(1, Math.min(1000, Number(req.query.limit) || 200));
    const list = messages(since, limit);
    res.json({ ok: true, room: "Помощники Андрей-Андрей", n: list.length, last: list.length ? list[list.length - 1].at : since, messages: list });
  });
  app.get("/data-api/room/file/:id", auth, (req, res) => {
    const g = fileMeta(req.params.id);
    const rooms = g ? [].concat(g.meta.room || [], g.meta.rooms || []) : [];
    if (!g || rooms.indexOf(ROOM()) < 0) return res.status(404).json({ ok: false, error: "Файла нет в этой комнате" });
    const f = path.join(g.dir, g.meta.id + (g.meta.ext || ""));
    res.setHeader("Content-Disposition", "attachment; filename*=UTF-8''" + encodeURIComponent(g.meta.name || g.meta.id));
    res.sendFile(f);
  });
  app.post("/data-api/room/say", auth, express.json({ limit: "64kb" }), async (req, res) => {
    const text = String((req.body && req.body.text) || "").trim();
    if (!text) return res.status(400).json({ ok: false, error: "Пустой текст" });
    if (text.length > 4000) return res.status(400).json({ ok: false, error: "Не длиннее 4000 знаков — разбейте на части" });
    const now = Date.now(); sent = sent.filter((t) => now - t < 3600e3);
    if (sent.length >= 30) return res.status(429).json({ ok: false, error: "Не больше 30 сообщений в час" });
    const key = String((req.body && req.body.key) || "").replace(/[^\w.:-]/g, "").slice(0, 80);
    const r = await say(text, key ? "petrov:" + key : "");
    if (r && r.ok && !r.dup) sent.push(now);
    res.status(r && r.ok ? 200 : 500).json(r);
  });
  console.log("HELPERS ROOM: /data-api/room — комната «Помощники Андрей-Андрей» " + ROOM());
}
module.exports = { mount, messages };
