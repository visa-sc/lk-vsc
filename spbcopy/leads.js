// ─────────────────────────────────────────────────────────────────────────────
// spbcopy/leads.js — раздел «Заявки» для копии питерского сайта: /leads
//
// Повторяет то, что у клиента во Flexbe (app.flexbe.ru → Заявки):
//   • список: № заявки, статус, оплата, имя клиента, контакт, форма и страница,
//     дата; непрочитанные помечены синей полосой слева, как у них;
//   • меню «Фильтр» с сортировкой и отборами: статус, просмотр, оплата,
//     № заявки, дата, сумма, имя клиента, телефон, email;
//   • выгрузка по кнопке с выбором формата — CSV или XLSX;
//   • карточка /leads/<id>: шапка с номером, стрелками к соседним заявкам,
//     статусом и датой; все поля формы; заметки; UTM-метки (показываем всегда,
//     пустые значения прочерком); справа «Источник» со страницей, адресом, IP и
//     устройством. Открыл карточку — заявка помечается просмотренной.
//
// Вход по коду (SPBCOPY_ADMIN_CODE, по умолчанию 280992), сессия в куке.
// Раздел всегда noindex, на каком бы домене копия ни стояла.
//
// ВАЖНО: сюда попадают заявки, отправленные С НАШЕЙ КОПИИ. Заявки живого
// spb.visa-sc.ru пока уходят во Flexbe.
// ─────────────────────────────────────────────────────────────────────────────
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

let xlsx = null;
try {
  xlsx = require("./xlsx");
} catch (_) {
  // без adm-zip выгрузка в Excel недоступна, CSV работает всегда
}

const CODE = String(process.env.SPBCOPY_ADMIN_CODE || "280992");
const SECRET = process.env.SPBCOPY_ADMIN_SECRET || "spbcopy-leads-" + CODE;
const COOKIE = "spbleads";
const PAGE_SIZES = [25, 50, 100];

const STATUSES = [
  { key: "new", title: "Новая", color: "#e8edff", text: "#3452ff" },
  { key: "work", title: "В работе", color: "#fff3d6", text: "#a1690a" },
  { key: "done", title: "Успешно", color: "#e2f7e8", text: "#1a7f3c" },
  { key: "reject", title: "Отказ", color: "#feeaea", text: "#c23c3c" }
];
const statusOf = (k) => STATUSES.find((s) => s.key === k) || STATUSES[0];

// Порядок меток как во Flexbe: сначала utm_*, потом идентификаторы счётчиков.
const UTM_KEYS = [
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "ym_client_id",
  "ga_client_id"
];

// ── хранилище ────────────────────────────────────────────────────────────────
function load(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    return Array.isArray(raw) ? raw : [];
  } catch (_) {
    return [];
  }
}

function save(file, list) {
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(list, null, 2));
  fs.renameSync(tmp, file);
}

// Приводим запись к единому виду: старые записи лежат как {at, page, ip, ua, data}.
function normalize(entry, index, siteDir) {
  const data = entry.data || {};
  const fields = Array.isArray(data.fields) ? data.fields : [];
  const pick = (types) => {
    const f = fields.find((x) => types.includes(String(x.type || "").toLowerCase()));
    return f ? String(f.value || "").trim() : "";
  };
  const byName = (re) => {
    const f = fields.find((x) => re.test(String(x.name || "")));
    return f ? String(f.value || "").trim() : "";
  };

  let utm = {};
  try {
    const raw = typeof data.utmData === "string" ? JSON.parse(data.utmData || "{}") : data.utmData || {};
    utm = raw && typeof raw === "object" ? raw : {};
  } catch (_) {
    utm = {};
  }
  if (data.ym_client_id) utm.ym_client_id = data.ym_client_id;
  if (data.ga_client_id) utm.ga_client_id = data.ga_client_id;
  if (entry.utm && typeof entry.utm === "object") utm = { ...utm, ...entry.utm };

  const ua = String(entry.ua || "");
  const device = /android/i.test(ua)
    ? "Android"
    : /iphone|ipad|ios/i.test(ua)
      ? "iPhone"
      : /macintosh|mac os/i.test(ua)
        ? "Mac"
        : /windows/i.test(ua)
          ? "ПК"
          : "—";

  const pagePath = entry.pageUrl || entry.referer || "/";
  const amount = Number(entry.amount || data.amount || 0) || 0;

  return {
    id: entry.id || index + 1,
    at: entry.at || new Date().toISOString(),
    status: entry.status || "new",
    viewed: !!entry.viewed,
    notes: entry.notes || "",
    form: data.name || entry.form || "Заявка",
    fields: fields.map((f) => ({
      name: f.name || "Поле",
      value: String(f.value == null ? "" : f.value),
      type: f.type || "text"
    })),
    clientName: pick(["name"]) || byName(/имя|name/i),
    phone: pick(["phone", "tel"]) || byName(/телефон|phone/i),
    email: pick(["email"]) || byName(/e-?mail|почта/i),
    pagePath,
    pageTitle: entry.pageTitle || pageTitleFor(pagePath, siteDir),
    utm,
    ip: entry.ip || "",
    ua,
    device,
    amount,
    payment: entry.payment || ""
  };
}

const titleCache = new Map();
function pageTitleFor(p, siteDir) {
  if (!siteDir) return "";
  const clean = String(p).split("?")[0].split("#")[0];
  if (titleCache.has(clean)) return titleCache.get(clean);
  let title = "";
  try {
    const file = path.join(siteDir, clean.replace(/^\/+/, ""), "index.html");
    if (fs.existsSync(file)) {
      const html = fs.readFileSync(file, "utf8").slice(0, 4000);
      title = (html.match(/<title>([\s\S]*?)<\/title>/i) || [, ""])[1].trim();
    }
  } catch (_) {}
  titleCache.set(clean, title);
  return title;
}

// ── вспомогательное ──────────────────────────────────────────────────────────
const esc = (s) =>
  String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const MONTHS = [
  "января", "февраля", "марта", "апреля", "мая", "июня",
  "июля", "августа", "сентября", "октября", "ноября", "декабря"
];

function mskParts(iso) {
  const d = new Date(iso);
  const msk = new Date(d.getTime() + 3 * 3600 * 1000); // сервер в UTC, показываем МСК
  return {
    day: msk.getUTCDate(),
    month: msk.getUTCMonth(),
    year: msk.getUTCFullYear(),
    hh: String(msk.getUTCHours()).padStart(2, "0"),
    mm: String(msk.getUTCMinutes()).padStart(2, "0"),
    date: msk
  };
}

function shortDate(iso) {
  const p = mskParts(iso);
  const now = mskParts(new Date().toISOString());
  if (p.day === now.day && p.month === now.month && p.year === now.year) return `${p.hh}:${p.mm}`;
  const yest = new Date(now.date.getTime() - 86400000);
  if (p.day === yest.getUTCDate() && p.month === yest.getUTCMonth()) return `вчера, ${p.hh}:${p.mm}`;
  return `${p.day} ${MONTHS[p.month]}`;
}

const fullDate = (iso) => {
  const p = mskParts(iso);
  return `${p.day} ${MONTHS[p.month]} ${p.year} г. в ${p.hh}:${p.mm}`;
};

const isoDay = (iso) => {
  const p = mskParts(iso);
  return `${p.year}-${String(p.month + 1).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
};

const token = () => crypto.createHmac("sha256", SECRET).update("ok").digest("hex").slice(0, 32);

function authed(req) {
  const raw = String(req.headers.cookie || "");
  const m = raw.match(new RegExp(`${COOKIE}=([a-f0-9]+)`));
  return !!m && m[1] === token();
}

// ── отбор и сортировка ───────────────────────────────────────────────────────
const FILTER_FIELDS = ["status", "seen", "pay", "idFrom", "idTo", "dateFrom", "dateTo", "sumFrom", "sumTo", "name", "phone", "email", "sort"];

function applyFilters(all, q) {
  const g = (k) => (q.get(k) || "").trim();
  const has = (v) => v !== "";
  const low = (s) => String(s || "").toLowerCase();
  let list = all.slice();

  if (has(g("status"))) list = list.filter((l) => l.status === g("status"));
  if (g("seen") === "yes") list = list.filter((l) => l.viewed);
  if (g("seen") === "no") list = list.filter((l) => !l.viewed);
  if (g("pay") === "yes") list = list.filter((l) => l.amount > 0);
  if (g("pay") === "no") list = list.filter((l) => !l.amount);
  if (has(g("idFrom"))) list = list.filter((l) => l.id >= Number(g("idFrom")));
  if (has(g("idTo"))) list = list.filter((l) => l.id <= Number(g("idTo")));
  if (has(g("dateFrom"))) list = list.filter((l) => isoDay(l.at) >= g("dateFrom"));
  if (has(g("dateTo"))) list = list.filter((l) => isoDay(l.at) <= g("dateTo"));
  if (has(g("sumFrom"))) list = list.filter((l) => l.amount >= Number(g("sumFrom")));
  if (has(g("sumTo"))) list = list.filter((l) => l.amount <= Number(g("sumTo")));
  if (has(g("name"))) list = list.filter((l) => low(l.clientName).includes(low(g("name"))));
  if (has(g("phone"))) {
    const digits = g("phone").replace(/\D/g, "");
    list = list.filter((l) => l.phone.replace(/\D/g, "").includes(digits));
  }
  if (has(g("email"))) list = list.filter((l) => low(l.email).includes(low(g("email"))));

  const sort = g("sort") || "date_desc";
  const cmp = {
    date_desc: (a, b) => new Date(b.at) - new Date(a.at),
    date_asc: (a, b) => new Date(a.at) - new Date(b.at),
    id_desc: (a, b) => b.id - a.id,
    id_asc: (a, b) => a.id - b.id
  };
  list.sort(cmp[sort] || cmp.date_desc);
  return list;
}

const activeFilters = (q) =>
  FILTER_FIELDS.filter((k) => k !== "sort" && (q.get(k) || "").trim()).length;

// ── вёрстка ──────────────────────────────────────────────────────────────────
const CSS = `
*{box-sizing:border-box}
body{margin:0;font:14px/1.5 -apple-system,"Golos Text","Segoe UI",Roboto,Arial,sans-serif;color:#1a1a1a;background:#fff}
a{color:inherit;text-decoration:none}
.top{background:#1c1c1e;color:#fff;display:flex;align-items:center;gap:26px;padding:0 22px;height:48px;font-size:13px}
.top .site{background:#2c2c2e;border-radius:8px;padding:6px 12px;font-weight:600}
.top .badge{background:#ffb020;color:#1c1c1e;border-radius:8px;padding:1px 7px;font-size:11px;font-weight:700;margin-left:6px}
.top .sp{margin-left:auto;opacity:.7}
.wrap{max-width:1180px;margin:0 auto;padding:26px 22px 60px}
h1{font-size:28px;font-weight:700;margin:0}
.bar{display:flex;align-items:center;gap:12px;margin-bottom:22px}
.bar .right{margin-left:auto;display:flex;align-items:center;gap:10px}
.btn{border:1px solid #e3e3e6;background:#fff;border-radius:10px;padding:8px 14px;font-size:13px;cursor:pointer;display:inline-flex;align-items:center;gap:8px;color:#1a1a1a}
.btn:hover{background:#f7f7f8}
.btn.on{background:#f0f0f2;border-color:#dcdce0}
.btn .cnt{background:#3452ff;color:#fff;border-radius:7px;padding:0 6px;font-size:11px}
.pager{display:flex;align-items:center;gap:8px;font-size:13px;color:#6b6b70}
.drop{position:relative;display:inline-block}
.menu{position:absolute;right:0;top:calc(100% + 8px);background:#fff;border:1px solid #ececef;border-radius:14px;box-shadow:0 12px 40px rgba(0,0,0,.12);padding:14px;z-index:20;display:none;min-width:300px}
.menu.show{display:block}
.menu h4{margin:0 0 10px;font-size:12px;color:#8b8b90;font-weight:500;text-transform:none}
.menu .f{margin-bottom:12px}
.menu .f label{display:block;font-size:12px;color:#6b6b70;margin-bottom:5px}
.menu input,.menu select{width:100%;padding:8px 10px;border:1px solid #e3e3e6;border-radius:9px;font:inherit;font-size:13px}
.menu .two{display:grid;grid-template-columns:1fr 1fr;gap:8px}
.menu .acts{display:flex;gap:8px;margin-top:6px}
.menu .acts button,.menu .acts a{flex:1;justify-content:center}
.menu .primary{background:#3452ff;color:#fff;border-color:#3452ff}
.menu .primary:hover{background:#2540e0}
.menu .item{display:block;padding:9px 10px;border-radius:9px;font-size:13px}
.menu .item:hover{background:#f6f6f8}
.table{width:100%;border-collapse:collapse}
.table th{font-size:12px;color:#8b8b90;font-weight:500;text-align:left;padding:10px 12px;border-bottom:1px solid #eeeef0}
.table td{padding:13px 12px;border-bottom:1px solid #f4f4f6;font-size:13px;vertical-align:middle}
.table tr.row:hover td{background:#fafafb}
.table tr.row{cursor:pointer}
.table tr.unseen td:first-child{box-shadow:inset 3px 0 0 #3452ff}
.table tr.unseen td{font-weight:500}
.num{color:#6b6b70;width:88px}
.chip{display:inline-block;border-radius:9px;padding:5px 12px;font-size:12px;font-weight:500}
.muted{color:#b5b5ba}
.ellip{max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:inline-block;vertical-align:bottom}
.page-col{color:#9a9aa0;font-weight:400}
.card-head{display:flex;align-items:center;gap:14px;margin-bottom:26px;flex-wrap:wrap}
.card-head h1{font-size:26px}
.crumb{color:#8b8b90;font-size:22px;font-weight:600}
.arrow{border:1px solid #e3e3e6;border-radius:9px;width:32px;height:32px;display:inline-flex;align-items:center;justify-content:center;color:#6b6b70}
.arrow.off{opacity:.35;pointer-events:none}
.when{margin-left:auto;color:#8b8b90;font-size:13px}
.cols{display:grid;grid-template-columns:1fr 330px;gap:28px;align-items:start}
@media(max-width:900px){.cols{grid-template-columns:1fr}}
.sect{margin-bottom:26px}
.sect h2{font-size:15px;font-weight:600;margin:0 0 12px}
.panel{border:1px solid #edeef0;border-radius:14px;overflow:hidden}
.panel .r{display:grid;grid-template-columns:210px 1fr;border-bottom:1px solid #f1f1f3}
.panel .r:last-child{border-bottom:0}
.panel .k{padding:13px 16px;color:#6b6b70;background:#fbfbfc}
.panel .v{padding:13px 16px;font-weight:500;word-break:break-word}
textarea{width:100%;min-height:96px;border:1px solid #edeef0;border-radius:14px;padding:14px 16px;font:inherit;resize:vertical}
textarea:focus{outline:2px solid #dbe2ff;border-color:#c9d4ff}
.src{border:1px solid #edeef0;border-radius:14px;padding:14px}
.src .t{font-weight:600;margin-bottom:4px;font-size:13px}
.src .u{color:#8b8b90;font-size:13px;word-break:break-all}
.src .meta{display:flex;gap:10px;margin-top:12px;flex-wrap:wrap}
.src .meta span{border:1px solid #edeef0;border-radius:9px;padding:5px 10px;font-size:12px;color:#6b6b70}
.login{max-width:330px;margin:14vh auto;text-align:center}
.login input{width:100%;padding:13px 16px;border:1px solid #e3e3e6;border-radius:12px;font:inherit;text-align:center;letter-spacing:3px}
.login button{width:100%;margin-top:12px;padding:13px;border:0;border-radius:12px;background:#3452ff;color:#fff;font:inherit;font-weight:600;cursor:pointer}
.empty{padding:60px 0;text-align:center;color:#8b8b90}
.statuses select{appearance:none;border:0;border-radius:9px;padding:6px 28px 6px 12px;font:inherit;font-size:12px;font-weight:500;cursor:pointer}
.hint{color:#8b8b90;font-size:12px;margin-top:8px}
`;

const JS_DROP = `
function drop(id){
  var m=document.getElementById(id); if(!m) return;
  var open=m.classList.contains('show');
  document.querySelectorAll('.menu').forEach(function(x){x.classList.remove('show')});
  if(!open) m.classList.add('show');
  event.stopPropagation();
}
document.addEventListener('click',function(){document.querySelectorAll('.menu').forEach(function(x){x.classList.remove('show')})});
document.addEventListener('click',function(e){ if(e.target.closest('.menu')) e.stopPropagation(); },true);
`;

function layout(title, body, ctx, unseen) {
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${esc(title)}</title><style>${CSS}</style></head><body>
<div class="top"><span class="site">${esc(ctx.site)}</span>
<a href="/leads">Заявки${unseen ? `<span class="badge">${unseen}</span>` : ""}</a>
<span class="sp">копия · только наши заявки</span></div>
${body}<script>${JS_DROP}</script></body></html>`;
}

function loginPage(ctx, err) {
  return layout(
    "Вход — Заявки",
    `<form class="login" method="post" action="/leads/login">
      <h1 style="font-size:20px;margin-bottom:18px">Заявки</h1>
      <input name="code" inputmode="numeric" autocomplete="off" autofocus placeholder="код">
      <button type="submit">Войти</button>
      ${err ? '<div class="hint" style="color:#c23c3c">Неверный код</div>' : ""}
    </form>`,
    ctx,
    0
  );
}

function filterMenu(q) {
  const v = (k) => esc(q.get(k) || "");
  const sel = (k, val) => ((q.get(k) || "") === val ? " selected" : "");
  return `<div class="menu" id="filterMenu">
  <form method="get" action="/leads">
    <div class="f"><label>Сортировка</label>
      <select name="sort">
        <option value="date_desc"${sel("sort", "date_desc")}>Сначала новые</option>
        <option value="date_asc"${sel("sort", "date_asc")}>Сначала старые</option>
        <option value="id_desc"${sel("sort", "id_desc")}>Номер по убыванию</option>
        <option value="id_asc"${sel("sort", "id_asc")}>Номер по возрастанию</option>
      </select></div>
    <h4>Фильтр</h4>
    <div class="f"><label>Статус</label>
      <select name="status"><option value="">Любой</option>
        ${STATUSES.map((s) => `<option value="${s.key}"${sel("status", s.key)}>${s.title}</option>`).join("")}
      </select></div>
    <div class="f"><label>Просмотр</label>
      <select name="seen"><option value="">Любой</option>
        <option value="no"${sel("seen", "no")}>Не просмотренные</option>
        <option value="yes"${sel("seen", "yes")}>Просмотренные</option>
      </select></div>
    <div class="f"><label>Оплата</label>
      <select name="pay"><option value="">Любая</option>
        <option value="yes"${sel("pay", "yes")}>С оплатой</option>
        <option value="no"${sel("pay", "no")}>Без оплаты</option>
      </select></div>
    <div class="f"><label>№ заявки</label><div class="two">
      <input name="idFrom" inputmode="numeric" placeholder="от" value="${v("idFrom")}">
      <input name="idTo" inputmode="numeric" placeholder="до" value="${v("idTo")}"></div></div>
    <div class="f"><label>Дата</label><div class="two">
      <input type="date" name="dateFrom" value="${v("dateFrom")}">
      <input type="date" name="dateTo" value="${v("dateTo")}"></div></div>
    <div class="f"><label>Сумма</label><div class="two">
      <input name="sumFrom" inputmode="numeric" placeholder="от" value="${v("sumFrom")}">
      <input name="sumTo" inputmode="numeric" placeholder="до" value="${v("sumTo")}"></div></div>
    <div class="f"><label>Имя клиента</label><input name="name" value="${v("name")}"></div>
    <div class="f"><label>Телефон</label><input name="phone" value="${v("phone")}"></div>
    <div class="f"><label>Email</label><input name="email" value="${v("email")}"></div>
    <input type="hidden" name="limit" value="${esc(q.get("limit") || "25")}">
    <div class="acts">
      <button class="btn primary" type="submit">Применить</button>
      <a class="btn" href="/leads">Сбросить</a>
    </div>
  </form>
</div>`;
}

function listPage(all, q, ctx, unseen) {
  const limit = PAGE_SIZES.includes(Number(q.get("limit"))) ? Number(q.get("limit")) : 25;
  const page = Math.max(1, Number(q.get("page")) || 1);
  const filtered = applyFilters(all, q);
  const pages = Math.max(1, Math.ceil(filtered.length / limit));
  const slice = filtered.slice((page - 1) * limit, page * limit);

  const keep = new URLSearchParams();
  FILTER_FIELDS.forEach((k) => (q.get(k) || "").trim() && keep.set(k, q.get(k)));
  keep.set("limit", String(limit));
  const link = (p) => {
    const u = new URLSearchParams(keep);
    u.set("page", String(p));
    return "/leads?" + u.toString();
  };
  const exportQs = keep.toString();

  const rows = slice
    .map((l) => {
      const st = statusOf(l.status);
      return `<tr class="row${l.viewed ? "" : " unseen"}" onclick="location.href='/leads/${l.id}'">
      <td class="num">${l.id}</td>
      <td><span class="chip" style="background:${st.color};color:${st.text}">${st.title}</span></td>
      <td class="muted">${l.amount ? l.amount + " ₽" : "—"}</td>
      <td>${l.clientName ? esc(l.clientName) : '<span class="muted">—</span>'}</td>
      <td>${esc(l.phone || l.email || "—")}</td>
      <td>${esc(l.form)} <span class="ellip page-col">${esc(l.pageTitle || l.pagePath)}</span></td>
      <td style="text-align:right;color:#6b6b70">${shortDate(l.at)}</td>
    </tr>`;
    })
    .join("");

  const nFilters = activeFilters(q);
  const body = `<div class="wrap">
  <div class="bar"><h1>Заявки</h1>
    <div class="right">
      <div class="drop">
        <button class="btn${nFilters ? " on" : ""}" onclick="drop('filterMenu')">Фильтр${
          nFilters ? `<span class="cnt">${nFilters}</span>` : ""
        }</button>
        ${filterMenu(q)}
      </div>
      <div class="drop">
        <button class="btn" onclick="drop('dlMenu')">Скачать ▾</button>
        <div class="menu" id="dlMenu" style="min-width:210px">
          <a class="item" href="/leads/export.xlsx${exportQs ? "?" + exportQs : ""}">Excel (.xlsx)</a>
          <a class="item" href="/leads/export.csv${exportQs ? "?" + exportQs : ""}">Таблица CSV</a>
          <div class="hint" style="padding:0 10px">Выгружается текущая выборка: ${filtered.length}</div>
        </div>
      </div>
      <form method="get" action="/leads" style="display:inline">
        ${[...keep.entries()]
          .filter(([k]) => k !== "limit")
          .map(([k, val]) => `<input type="hidden" name="${esc(k)}" value="${esc(val)}">`)
          .join("")}
        <select class="btn" name="limit" onchange="this.form.submit()">
          ${PAGE_SIZES.map((n) => `<option value="${n}"${limit === n ? " selected" : ""}>${n}</option>`).join("")}
        </select>
      </form>
      <div class="pager">
        <a class="arrow${page <= 1 ? " off" : ""}" href="${link(page - 1)}">‹</a>
        <span>${page} из ${pages}</span>
        <a class="arrow${page >= pages ? " off" : ""}" href="${link(page + 1)}">›</a>
      </div>
    </div>
  </div>
  ${
    slice.length
      ? `<table class="table"><thead><tr>
    <th class="num">№</th><th>Статус</th><th>Оплата</th><th>Имя клиента</th>
    <th>Контакт</th><th>Форма / Страница</th><th style="text-align:right">Дата</th>
  </tr></thead><tbody>${rows}</tbody></table>`
      : `<div class="empty">${
          nFilters ? "По этому фильтру заявок нет." : "Заявок пока нет."
        }<div class="hint">Сюда попадают заявки, отправленные с копии сайта.</div></div>`
  }
  <div class="hint">Всего заявок: ${all.length}${nFilters ? `, по фильтру: ${filtered.length}` : ""}${
    unseen ? `, не просмотрено: ${unseen}` : ""
  }</div>
</div>`;
  return layout("Заявки", body, ctx, unseen);
}

function cardPage(lead, prev, next, ctx, unseen) {
  const st = statusOf(lead.status);
  const fieldRows = lead.fields.length
    ? lead.fields
        .map((f) => `<div class="r"><div class="k">${esc(f.name)}</div><div class="v">${esc(f.value) || "—"}</div></div>`)
        .join("")
    : `<div class="r"><div class="k">Поля формы</div><div class="v">—</div></div>`;

  // Метки показываем ВСЕГДА, как во Flexbe: сначала стандартные, потом всё
  // остальное, что прислала форма. Пустые — прочерком.
  const extraKeys = Object.keys(lead.utm || {}).filter((k) => !UTM_KEYS.includes(k));
  const utmRows = [...UTM_KEYS, ...extraKeys]
    .map(
      (k) =>
        `<div class="r"><div class="k">${esc(k)}</div><div class="v">${
          lead.utm[k] ? esc(lead.utm[k]) : '<span class="muted">—</span>'
        }</div></div>`
    )
    .join("");

  const body = `<div class="wrap">
  <div class="card-head">
    <a class="crumb" href="/leads">Заявки</a><span class="crumb">›</span>
    <h1>#${lead.id}</h1>
    <a class="arrow${prev ? "" : " off"}" href="/leads/${prev || ""}">‹</a>
    <a class="arrow${next ? "" : " off"}" href="/leads/${next || ""}">›</a>
    <span class="statuses"><select style="background:${st.color};color:${st.text}"
      onchange="fetch('/leads/${lead.id}/status',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({status:this.value})}).then(()=>location.reload())">
      ${STATUSES.map((s) => `<option value="${s.key}"${lead.status === s.key ? " selected" : ""}>${s.title}</option>`).join("")}
    </select></span>
    <span class="when">${fullDate(lead.at)}</span>
  </div>
  <div class="cols">
    <div>
      <div class="sect"><h2>${esc(lead.form)}</h2><div class="panel">${fieldRows}</div></div>
      <div class="sect"><h2>Заметки</h2>
        <textarea id="notes" placeholder="Начните печатать">${esc(lead.notes)}</textarea>
        <div class="hint" id="notesHint">Сохраняется автоматически</div>
      </div>
      <div class="sect"><h2>UTM-метки</h2><div class="panel">${utmRows}</div></div>
    </div>
    <div>
      <div class="sect"><h2>Источник</h2>
        <div class="src">
          <div class="t">${esc(lead.pageTitle || "Страница сайта")}</div>
          <div class="u"><a href="${esc(lead.pagePath)}" target="_blank">${esc(ctx.site + lead.pagePath)}</a></div>
          <div class="meta">
            <span>IP ${esc(lead.ip || "—")}</span>
            <span>${esc(lead.device)}</span>
          </div>
        </div>
      </div>
    </div>
  </div>
</div>
<script>
var t; var n=document.getElementById('notes');
if(n) n.addEventListener('input',function(){
  clearTimeout(t);
  t=setTimeout(function(){
    fetch('/leads/${lead.id}/notes',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({notes:n.value})})
      .then(function(){document.getElementById('notesHint').textContent='Сохранено';
        setTimeout(function(){document.getElementById('notesHint').textContent='Сохраняется автоматически'},1500);});
  },600);
});
</script>`;
  return layout(`Заявка #${lead.id}`, body, ctx, unseen);
}

// ── выгрузки ─────────────────────────────────────────────────────────────────
const EXPORT_HEAD = [
  "Номер", "Дата", "Статус", "Просмотрена", "Имя клиента", "Телефон", "Email",
  "Форма", "Страница", "Адрес страницы", "Оплата", "IP", "Устройство",
  ...UTM_KEYS, "Все поля формы", "Заметки"
];

const exportRow = (l) => [
  l.id,
  fullDate(l.at),
  statusOf(l.status).title,
  l.viewed ? "да" : "нет",
  l.clientName,
  l.phone,
  l.email,
  l.form,
  l.pageTitle,
  l.pagePath,
  l.amount ? l.amount : "",
  l.ip,
  l.device,
  ...UTM_KEYS.map((k) => l.utm[k] || ""),
  l.fields.map((f) => `${f.name}: ${f.value}`).join("; "),
  l.notes
];

function csv(list) {
  const q = (v) => `"${String(v == null ? "" : v).replace(/"/g, '""')}"`;
  return (
    "﻿" +
    [EXPORT_HEAD, ...list.map(exportRow)].map((r) => r.map(q).join(";")).join("\r\n")
  );
}

// ── точка входа ──────────────────────────────────────────────────────────────
function handle(req, res, ctx) {
  const url = new URL(req.url, "http://localhost");
  const p = url.pathname.replace(/\/+$/, "") || "/leads";
  if (p !== "/leads" && !p.startsWith("/leads/")) return false;

  const html = (code, text) =>
    ctx.send(req, res, code, Buffer.from(text, "utf8"), "text/html; charset=utf-8", {
      "Cache-Control": "no-store",
      "X-Robots-Tag": "noindex, nofollow",
      __ext: ".html"
    });

  if (p === "/leads/login" && req.method === "POST") {
    ctx.readBody(req).then((raw) => {
      const code = decodeURIComponent((raw.match(/code=([^&]*)/) || [, ""])[1] || "").replace(/\+/g, " ").trim();
      if (code !== CODE) return html(200, loginPage(ctx, true));
      res.writeHead(302, {
        "Set-Cookie": `${COOKIE}=${token()}; Path=/leads; HttpOnly; SameSite=Lax; Max-Age=2592000${
          ctx.secure ? "; Secure" : ""
        }`,
        Location: "/leads"
      });
      res.end();
    });
    return true;
  }
  if (!authed(req)) {
    html(200, loginPage(ctx, false));
    return true;
  }

  const raw = load(ctx.leadsFile);
  const all = raw
    .map((e, i) => normalize(e, i, ctx.siteDir))
    .sort((a, b) => new Date(b.at) - new Date(a.at));
  const unseen = all.filter((l) => !l.viewed).length;

  // выгрузки
  if (p === "/leads/export.csv" || p === "/leads/export.xlsx") {
    const list = applyFilters(all, url.searchParams);
    if (p.endsWith(".csv")) {
      ctx.send(req, res, 200, Buffer.from(csv(list), "utf8"), "text/csv; charset=utf-8", {
        "Content-Disposition": 'attachment; filename="zayavki.csv"',
        "Cache-Control": "no-store",
        "X-Robots-Tag": "noindex, nofollow"
      });
      return true;
    }
    if (!xlsx) {
      html(200, layout("Выгрузка", '<div class="wrap"><div class="empty">Выгрузка в Excel недоступна: не установлен adm-zip. Скачайте CSV.</div></div>', ctx, unseen));
      return true;
    }
    const buf = xlsx.build([EXPORT_HEAD, ...list.map(exportRow)], {
      sheetName: "Заявки",
      widths: [8, 22, 12, 13, 18, 18, 24, 18, 32, 26, 10, 16, 12, 14, 12, 18, 16, 14, 22, 22, 40, 30]
    });
    ctx.send(req, res, 200, buf, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", {
      "Content-Disposition": 'attachment; filename="zayavki.xlsx"',
      "Cache-Control": "no-store",
      "X-Robots-Tag": "noindex, nofollow"
    });
    return true;
  }

  // статус и заметки
  const act = p.match(/^\/leads\/(\d+)\/(status|notes)$/);
  if (act && req.method === "POST") {
    const id = Number(act[1]);
    ctx.readBody(req).then((body) => {
      let data = {};
      try {
        data = JSON.parse(body || "{}");
      } catch (_) {}
      const list = load(ctx.leadsFile);
      const idx = list.findIndex((e, i) => (e.id || i + 1) === id);
      if (idx >= 0) {
        if (act[2] === "status" && STATUSES.some((s) => s.key === data.status)) list[idx].status = data.status;
        if (act[2] === "notes") list[idx].notes = String(data.notes || "").slice(0, 5000);
        list[idx].id = list[idx].id || idx + 1;
        save(ctx.leadsFile, list);
      }
      ctx.send(req, res, 200, Buffer.from('{"success":true}'), "application/json; charset=utf-8", {
        "Cache-Control": "no-store"
      });
    });
    return true;
  }

  // карточка: открыли — значит просмотрена
  const card = p.match(/^\/leads\/(\d+)$/);
  if (card) {
    const id = Number(card[1]);
    const i = all.findIndex((l) => l.id === id);
    if (i < 0) {
      html(404, layout("Заявка не найдена", '<div class="wrap"><div class="empty">Такой заявки нет.<div class="hint"><a href="/leads">К списку</a></div></div></div>', ctx, unseen));
      return true;
    }
    if (!all[i].viewed) {
      const list = load(ctx.leadsFile);
      const idx = list.findIndex((e, k) => (e.id || k + 1) === id);
      if (idx >= 0) {
        list[idx].viewed = true;
        list[idx].id = list[idx].id || idx + 1;
        save(ctx.leadsFile, list);
      }
      all[i].viewed = true;
    }
    const prev = i > 0 ? all[i - 1].id : null;
    const next = i < all.length - 1 ? all[i + 1].id : null;
    html(200, cardPage(all[i], prev, next, ctx, all.filter((l) => !l.viewed).length));
    return true;
  }

  html(200, listPage(all, url.searchParams, ctx, unseen));
  return true;
}

module.exports = { handle, normalize, STATUSES, UTM_KEYS };
