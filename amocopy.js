/*
 * /amocrm_copy — страница-слепок amoCRM (данные из полного экспорта, только чтение).
 *
 * Полностью обособленный модуль: server.js лишь вызывает setup(app, requireVscAccess).
 * Данные лежат в .amocopy/ (создаёт tools/amoCopyBuild.js из экспорта, в .gitignore).
 * Все API — за requireVscAccess (админ или руководитель с правом "vsc").
 * В amoCRM этот модуль НЕ ходит вообще.
 */
const fs = require("fs");
const path = require("path");
const readline = require("readline");

const DATA_DIR = process.env.AMOCOPY_DIR || path.join(__dirname, ".amocopy");
const PAGE_FILE_RE = /^[0-9]{1,12}$/;

function sendJsonFile(res, file) {
  const p = path.join(DATA_DIR, file);
  if (!fs.existsSync(p)) return res.status(404).json({ success: false, message: "Слепок ещё не собран (нет " + file + ")" });
  res.set("Content-Type", "application/json; charset=utf-8");
  res.set("Cache-Control", "no-cache");
  return res.sendFile(p);
}

// поиск записи по id в бакете (NDJSON), потоково
function findInBucket(dir, id, buckets, cb) {
  const b = Math.abs(Number(id)) % buckets;
  const p = path.join(DATA_DIR, dir, `${b}.ndjson`);
  if (!fs.existsSync(p)) return cb(null, null);
  let found = null;
  const rl = readline.createInterface({ input: fs.createReadStream(p, "utf8"), crlfDelay: Infinity });
  rl.on("line", (l) => {
    if (found) return;
    // быстрый префильтр до parse
    if (l.indexOf(`"id":${id},`) < 0 && l.indexOf(`"id":${id}}`) < 0) return;
    try { const o = JSON.parse(l); if (o.id === id) { found = o; rl.close(); } } catch (_) {}
  });
  rl.on("close", () => cb(null, found));
  rl.on("error", (e) => cb(e));
}

// все записи бакета с eid === id (примечания/задачи по сущности)
function listFromBucket(dir, id, buckets, field, cb) {
  const b = Math.abs(Number(id)) % buckets;
  const p = path.join(DATA_DIR, dir, `${b}.ndjson`);
  if (!fs.existsSync(p)) return cb(null, []);
  const out = [];
  const needle = `"${field}":${id}`;
  const rl = readline.createInterface({ input: fs.createReadStream(p, "utf8"), crlfDelay: Infinity });
  rl.on("line", (l) => {
    if (l.indexOf(needle) < 0) return;
    try { const o = JSON.parse(l); if (o[field] === id || o.entity_id === id) out.push(o); } catch (_) {}
  });
  rl.on("close", () => cb(null, out));
  rl.on("error", (e) => cb(e));
}

module.exports = function setupAmoCopy(app, requireVscAccess) {
  const htmlFile = path.join(__dirname, "public", "amocrm_copy.html");

  app.get("/amocrm_copy", (req, res) => {
    res.set("Cache-Control", "no-cache");
    return res.sendFile(htmlFile);
  });

  const api = "/amocrm_copy/api";

  // мелкие справочники — файл целиком
  const FILES = {
    meta: "meta.json", pipelines: "pipelines.json", users: "users.json", roles: "roles.json",
    custom_fields: "custom_fields.json", tags: "tags.json", webhooks: "webhooks.json",
    sources: "sources.json", catalogs: "catalogs.json", loss_reasons: "loss_reasons.json",
    salesbots: "salesbots.json", kanban: "kanban.json", companies: "companies.json"
  };
  Object.keys(FILES).forEach((name) => {
    app.get(`${api}/${name}`, requireVscAccess, (req, res) => sendJsonFile(res, FILES[name]));
  });

  // настройки цифровой воронки (сырой JSON из amo)
  app.get(`${api}/dp/:pid`, requireVscAccess, (req, res) => {
    const pid = String(req.params.pid || "");
    if (!PAGE_FILE_RE.test(pid)) return res.status(400).json({ success: false });
    return sendJsonFile(res, `digital_pipeline_${pid}.json`);
  });

  // опись автоматизаций (курируемый markdown из репозитория)
  app.get(`${api}/automations`, requireVscAccess, (req, res) => {
    const p = path.join(__dirname, "amocopy-automations.md");
    if (!fs.existsSync(p)) return res.status(404).json({ success: false });
    res.set("Content-Type", "text/markdown; charset=utf-8");
    return res.sendFile(p);
  });

  // список сделок этапа, постранично
  app.get(`${api}/leads`, requireVscAccess, (req, res) => {
    const pid = String(req.query.pipeline || ""), sid = String(req.query.status || ""), page = String(req.query.page || "1");
    if (!PAGE_FILE_RE.test(pid) || !PAGE_FILE_RE.test(sid) || !PAGE_FILE_RE.test(page)) {
      return res.status(400).json({ success: false });
    }
    return sendJsonFile(res, path.join("leads_pages", pid, `${sid}-${page}.json`));
  });

  // карточка сделки: полные поля + примечания + задачи
  app.get(`${api}/lead/:id`, requireVscAccess, (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!id || id < 0) return res.status(400).json({ success: false });
    let meta = {};
    try { meta = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "meta.json"), "utf8")); } catch (_) {}
    const buckets = meta.buckets || 500;
    findInBucket("leads_detail", id, buckets, (e1, lead) => {
      if (e1) return res.status(500).json({ success: false });
      if (!lead) return res.status(404).json({ success: false, message: "Сделка не найдена в слепке" });
      listFromBucket("notes_leads", id, buckets, "eid", (e2, notes) => {
        listFromBucket("tasks_by_lead", id, buckets, "entity_id", (e3, tasks) => {
          return res.json({ success: true, lead, notes: notes || [], tasks: tasks || [] });
        });
      });
    });
  });

  // карточка контакта
  app.get(`${api}/contact/:id`, requireVscAccess, (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!id || id < 0) return res.status(400).json({ success: false });
    let meta = {};
    try { meta = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "meta.json"), "utf8")); } catch (_) {}
    const buckets = meta.buckets || 500;
    findInBucket("contacts_detail", id, buckets, (e1, contact) => {
      if (e1) return res.status(500).json({ success: false });
      if (!contact) return res.status(404).json({ success: false, message: "Контакт не найден в слепке" });
      listFromBucket("notes_contacts", id, buckets, "eid", (e2, notes) => {
        return res.json({ success: true, contact, notes: notes || [] });
      });
    });
  });

  // поиск контактов по имени/телефону/email (потоковый скан индекса, топ-50)
  app.get(`${api}/contacts`, requireVscAccess, (req, res) => {
    const q = String(req.query.q || "").trim().toLowerCase();
    if (q.length < 3) return res.json({ success: true, items: [], note: "Минимум 3 символа" });
    const qDigits = q.replace(/\D/g, "");
    const p = path.join(DATA_DIR, "contacts_index.ndjson");
    if (!fs.existsSync(p)) return res.status(404).json({ success: false, message: "Слепок ещё не собран" });
    const items = [];
    const rl = readline.createInterface({ input: fs.createReadStream(p, "utf8"), crlfDelay: Infinity });
    rl.on("line", (l) => {
      if (items.length >= 50) { rl.close(); return; }
      try {
        const c = JSON.parse(l);
        const hitName = (c.n || "").toLowerCase().indexOf(q) >= 0;
        const hitPhone = qDigits.length >= 5 && (c.p || []).some((x) => String(x).replace(/\D/g, "").indexOf(qDigits) >= 0);
        const hitEmail = (c.e || []).some((x) => String(x).toLowerCase().indexOf(q) >= 0);
        if (hitName || hitPhone || hitEmail) items.push(c);
      } catch (_) {}
    });
    rl.on("close", () => res.json({ success: true, items }));
    rl.on("error", () => res.status(500).json({ success: false }));
  });

  console.log("AMOCOPY: маршруты /amocrm_copy подключены, данные:", DATA_DIR);
};
