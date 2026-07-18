/*
 * amocopy-auth.js — учётки сотрудников + роли для КОПИИ amoCRM (crm.voyotravel.ru).
 *
 * Полностью автономно, живёт только в изолированном сервисе crm-svc (AMOCOPY_USE_DB=1).
 * Прод (server.js / клиентский ЛК) НЕ трогает. Хранилище — JSON рядом с crm.db:
 *   accounts.json  — учётки по email (сид из таблицы users: все 58 пользователей амо),
 *                    пароль ставится при первом входе (must set), scrypt-хэш;
 *   roles.json     — роли с правами (правит админ в разделе «Настройки»);
 *   authSessions.json — сессии сотрудников (token → {email, exp}).
 *
 * Вход по коду 111 остаётся как «супер-админ» (в amocopy.js). Здесь — вход по email+паролю.
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

module.exports = function setupAuth(app, requireAdminOrUser, api, opts) {
  opts = opts || {};
  const DB_PATH = opts.dbPath || process.env.AMOCOPY_DB || path.join(__dirname, ".amocopy-db", "crm.db");
  const DIR = path.dirname(DB_PATH);
  const ACC_FILE = path.join(DIR, "accounts.json");
  const ROLES_FILE = path.join(DIR, "roles.json");
  const SESS_FILE = path.join(DIR, "authSessions.json");
  const SESS_TTL_MS = 30 * 24 * 3600 * 1000;

  const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch (_) { return d; } };
  const writeJson = (f, o) => { try { fs.writeFileSync(f, JSON.stringify(o)); } catch (e) { console.error("auth write", f, e.message); } };

  // ── права по умолчанию ──
  function fullRights() {
    return { sections: { leads: true, contacts: true, companies: true, tasks: true, analytics: true, settings: true }, edit: true, del: true, exp: true };
  }
  function managerRights() {
    return { sections: { leads: true, contacts: true, companies: true, tasks: true, analytics: false, settings: false }, edit: true, del: false, exp: false };
  }
  // группы, которые в амо являются админскими (по данным users.is_admin + названиям)
  const ADMIN_GROUP_RE = /директор|руководител|тех\.?пользовател|управля/i;

  // ── первичный сид из БД (один раз, если файлов ещё нет) ──
  function seedFromDb() {
    let accounts = readJson(ACC_FILE, null);
    let roles = readJson(ROLES_FILE, null);
    if (accounts && roles) return { accounts, roles };
    let users = [];
    try {
      const Database = require(opts.sqliteModule || process.env.SQLITE_MODULE || "better-sqlite3");
      const db = new Database(DB_PATH, { readonly: true });
      users = db.prepare("SELECT id,name,email,role,grp,is_admin FROM users").all();
      db.close();
    } catch (e) { console.error("auth seed: не смог прочитать users:", e.message); }

    accounts = accounts || {};
    roles = roles || {};
    for (const u of users) {
      const grp = (u.grp || u.role || "").trim();
      const roleName = grp || "Без группы";
      if (!roles[roleName]) {
        const isAdminRole = u.is_admin === 1 || ADMIN_GROUP_RE.test(roleName);
        roles[roleName] = { rights: isAdminRole ? fullRights() : managerRights(), is_admin: isAdminRole ? 1 : 0 };
      }
      const email = (u.email || "").trim().toLowerCase();
      if (!email) continue;
      if (!accounts[email]) {
        accounts[email] = {
          user_id: u.id, name: u.name || email, email,
          role: roleName, is_admin: u.is_admin === 1 ? 1 : 0,
          active: 1, pass: null, must_change: 1,
          created: Date.now(), last_login: 0
        };
      }
    }
    writeJson(ACC_FILE, accounts);
    writeJson(ROLES_FILE, roles);
    console.log("AMOCOPY-AUTH: сид учёток —", Object.keys(accounts).length, "аккаунтов,", Object.keys(roles).length, "ролей");
    return { accounts, roles };
  }

  let { accounts, roles } = seedFromDb();
  let sessions = readJson(SESS_FILE, {});
  const saveAcc = () => writeJson(ACC_FILE, accounts);
  const saveRoles = () => writeJson(ROLES_FILE, roles);
  const saveSess = () => writeJson(SESS_FILE, sessions);

  // ── пароли (scrypt, без внешних зависимостей) ──
  function hashPassword(pw) {
    const salt = crypto.randomBytes(16).toString("hex");
    const hash = crypto.scryptSync(String(pw), salt, 32).toString("hex");
    return { salt, hash };
  }
  function verifyPassword(pw, rec) {
    if (!rec || !rec.salt || !rec.hash) return false;
    const h = crypto.scryptSync(String(pw), rec.salt, 32).toString("hex");
    const a = Buffer.from(h, "hex"), b = Buffer.from(rec.hash, "hex");
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  // ── анти-перебор: 8 попыток/мин на IP ──
  const attempts = new Map();
  function limited(ip) {
    const now = Date.now();
    const a = attempts.get(ip) || { n: 0, resetAt: now + 60000 };
    if (now > a.resetAt) { a.n = 0; a.resetAt = now + 60000; }
    a.n++; attempts.set(ip, a);
    return a.n > 8;
  }

  function rightsFor(email) {
    const acc = accounts[(email || "").toLowerCase()];
    if (!acc) return null;
    const r = roles[acc.role] || {};
    return { role: acc.role, is_admin: acc.is_admin || (r.is_admin ? 1 : 0), rights: r.rights || managerRights() };
  }

  // validate(token) → сессия сотрудника или null (используется в requireCopyAccess)
  function validate(token) {
    const s = sessions[token];
    if (!s || s.exp < Date.now()) { if (s) { delete sessions[token]; saveSess(); } return null; }
    const acc = accounts[s.email];
    if (!acc || !acc.active) return null;
    const rf = rightsFor(s.email);
    return { kind: "user", email: s.email, name: acc.name, role: acc.role, is_admin: rf.is_admin, rights: rf.rights, user_id: acc.user_id || 0 };
  }

  function newSession(email) {
    const now = Date.now();
    for (const k of Object.keys(sessions)) if (sessions[k].exp < now) delete sessions[k];
    const token = crypto.randomBytes(24).toString("hex");
    sessions[token] = { email, exp: now + SESS_TTL_MS };
    saveSess();
    return token;
  }

  const clientIp = (req) => String(req.headers["x-real-ip"] || req.ip || "");

  // ── ВХОД сотрудника: email + (пароль | установка пароля при первом входе) ──
  app.post(`${api}/auth/login`, (req, res) => {
    if (limited(clientIp(req))) return res.status(429).json({ success: false, message: "Слишком много попыток — подождите минуту" });
    const email = String((req.body && req.body.email) || "").trim().toLowerCase();
    const password = String((req.body && req.body.password) || "");
    const acc = accounts[email];
    if (!acc) return res.status(404).json({ success: false, message: "Пользователь не найден" });
    if (!acc.active) return res.status(403).json({ success: false, message: "Учётка отключена" });
    // первый вход — пароль ещё не задан
    if (!acc.pass || acc.must_change) {
      if (!password) return res.json({ success: true, needSet: true, name: acc.name });
      if (String(password).length < 6) return res.status(400).json({ success: false, needSet: true, message: "Пароль минимум 6 символов" });
      acc.pass = hashPassword(password);
      acc.must_change = 0;
      acc.last_login = Date.now();
      saveAcc();
      return res.json({ success: true, token: newSession(email), name: acc.name, first: true });
    }
    if (!verifyPassword(password, acc.pass)) return res.status(403).json({ success: false, message: "Неверный пароль" });
    acc.last_login = Date.now(); saveAcc();
    return res.json({ success: true, token: newSession(email), name: acc.name });
  });

  // текущий пользователь (по любому токену доступа)
  app.get(`${api}/auth/me`, requireAdminOrUser, (req, res) => {
    const c = req.crm || {};
    return res.json({ success: true, me: { kind: c.kind || "admin", email: c.email || null, name: c.name || "Администратор", role: c.role || null, is_admin: c.is_admin ? 1 : 0, rights: c.rights || fullRights(), user_id: c.user_id || 0 } });
  });

  // выход
  app.post(`${api}/auth/logout`, (req, res) => {
    const t = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
    if (sessions[t]) { delete sessions[t]; saveSess(); }
    return res.json({ success: true });
  });

  // ── админ-гейт: code-111 (kind=admin) или аккаунт с правом settings ──
  function requireSettingsAdmin(req, res, next) {
    requireAdminOrUser(req, res, () => {
      const c = req.crm || {};
      const ok = c.kind === "admin" || c.is_admin || (c.rights && c.rights.sections && c.rights.sections.settings);
      if (!ok) return res.status(403).json({ success: false, message: "Нужны права администратора" });
      next();
    });
  }

  // список учёток (для раздела «Настройки → Пользователи»)
  app.get(`${api}/auth/users`, requireSettingsAdmin, (req, res) => {
    const list = Object.values(accounts).map((a) => ({
      user_id: a.user_id, name: a.name, email: a.email, role: a.role,
      is_admin: a.is_admin || 0, active: a.active ? 1 : 0,
      has_pass: a.pass ? 1 : 0, must_change: a.must_change ? 1 : 0,
      last_login: a.last_login || 0
    })).sort((x, y) => (y.is_admin - x.is_admin) || x.name.localeCompare(y.name));
    return res.json({ success: true, users: list, roles: Object.keys(roles) });
  });

  // роли с правами
  app.get(`${api}/auth/roles`, requireSettingsAdmin, (req, res) => {
    const counts = {};
    for (const a of Object.values(accounts)) counts[a.role] = (counts[a.role] || 0) + 1;
    const list = Object.keys(roles).map((n) => ({ name: n, is_admin: roles[n].is_admin ? 1 : 0, rights: roles[n].rights || managerRights(), users: counts[n] || 0 }));
    return res.json({ success: true, roles: list });
  });

  // изменить учётку: роль / активность
  app.patch(`${api}/auth/user/:email`, requireSettingsAdmin, (req, res) => {
    const email = String(req.params.email || "").toLowerCase();
    const acc = accounts[email];
    if (!acc) return res.status(404).json({ success: false, message: "Нет учётки" });
    const b = req.body || {};
    if (b.role != null) { if (!roles[b.role]) return res.status(400).json({ success: false, message: "Нет такой роли" }); acc.role = b.role; }
    if (b.active != null) acc.active = b.active ? 1 : 0;
    if (b.is_admin != null) acc.is_admin = b.is_admin ? 1 : 0;
    saveAcc();
    return res.json({ success: true });
  });

  // сбросить пароль (снова «установить при входе»)
  app.post(`${api}/auth/user/:email/reset`, requireSettingsAdmin, (req, res) => {
    const email = String(req.params.email || "").toLowerCase();
    const acc = accounts[email];
    if (!acc) return res.status(404).json({ success: false, message: "Нет учётки" });
    acc.pass = null; acc.must_change = 1; saveAcc();
    // погасим активные сессии этого email
    let changed = false;
    for (const k of Object.keys(sessions)) if (sessions[k].email === email) { delete sessions[k]; changed = true; }
    if (changed) saveSess();
    return res.json({ success: true });
  });

  // сохранить права роли / создать роль
  app.patch(`${api}/auth/role/:name`, requireSettingsAdmin, (req, res) => {
    const name = String(req.params.name || "").trim();
    if (!name) return res.status(400).json({ success: false });
    const b = req.body || {};
    const cur = roles[name] || { rights: managerRights(), is_admin: 0 };
    if (b.rights && typeof b.rights === "object") cur.rights = b.rights;
    if (b.is_admin != null) cur.is_admin = b.is_admin ? 1 : 0;
    roles[name] = cur; saveRoles();
    return res.json({ success: true });
  });
  app.post(`${api}/auth/role`, requireSettingsAdmin, (req, res) => {
    const name = String((req.body && req.body.name) || "").trim();
    if (!name) return res.status(400).json({ success: false, message: "Имя роли" });
    if (roles[name]) return res.status(400).json({ success: false, message: "Роль уже есть" });
    roles[name] = { rights: managerRights(), is_admin: 0 }; saveRoles();
    return res.json({ success: true });
  });
  app.delete(`${api}/auth/role/:name`, requireSettingsAdmin, (req, res) => {
    const name = String(req.params.name || "").trim();
    if (!roles[name]) return res.status(404).json({ success: false, message: "Нет такой роли" });
    const used = Object.values(accounts).filter((a) => a.role === name).length;
    if (used) return res.status(400).json({ success: false, message: "Роль занята: " + used + " польз. — сначала переназначьте" });
    delete roles[name]; saveRoles();
    return res.json({ success: true });
  });

  console.log("AMOCOPY-AUTH: вход сотрудников + роли подключены");
  return { validate, rightsFor, fullRights };
};
