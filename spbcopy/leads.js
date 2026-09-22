// ─────────────────────────────────────────────────────────────────────────────
// spbcopy/leads.js — раздел «Заявки» для копии питерского сайта: /leads
//
// Повторяет то, что у клиента сейчас во Flexbe (app.flexbe.ru → Заявки):
//   • список: № заявки, статус, оплата, имя клиента, контакт, форма и страница,
//     дата; фильтр по статусу, выбор размера страницы, пагинация «1 из N»,
//     выгрузка в CSV;
//   • карточка /leads/<id>: шапка с номером, стрелками «предыдущая/следующая»,
//     статусом и датой; поля формы; заметки; блок UTM-меток; справа «Источник»
//     со страницей, адресом, IP и устройством.
// Статус и заметки сохраняются у нас (во Flexbe они тоже правятся руками).
//
// Вход по коду (SPBCOPY_ADMIN_CODE, по умолчанию тот же 280992, что и в других
// наших инструментах), сессия в httpOnly-куке. Раздел всегда noindex, на каком
// бы домене копия ни стояла.
//
// ВАЖНО: сюда попадают заявки, отправленные С НАШЕЙ КОПИИ. Заявки живого
// spb.visa-sc.ru пока уходят во Flexbe — перелить их можно выгрузкой из Flexbe
// (кнопка «скачать» в их списке) или после переезда домена на наш код.
// ─────────────────────────────────────────────────────────────────────────────
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

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

// Приводим запись к единому виду. Старые записи (до появления раздела) лежат
// как {at, page, ip, ua, data} — разбираем их на лету.
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
    utm = typeof data.utmData === "string" ? JSON.parse(data.utmData) : data.utmData || {};
  } catch (_) {
    utm = {};
  }
  if (data.ym_client_id) utm.ym_client_id = data.ym_client_id;
  if (data.ga_client_id) utm.ga_client_id = data.ga_client_id;

  const ua = String(entry.ua || "");
  const device = /android/i.test(ua)
    ? "Android"
    : /iphone|ipad|ios/i.test(ua)
      ? "iPhone"
      : /macintosh|mac os/i.test(ua)
        ? "Mac"
        : /windows/i.test(ua)
          ? "Windows"
          : "—";

  const pagePath = entry.pageUrl || entry.referer || "/";
  return {
    id: entry.id || index + 1,
    at: entry.at || new Date().toISOString(),
    status: entry.status || "new",
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

// «11:45» сегодня, «вчера, 14:51», «20 сентября» раньше — как во Flexbe
function shortDate(iso) {
  const p = mskParts(iso);
  const now = mskParts(new Date().toISOString());
  const sameDay = p.day === now.day && p.month === now.month && p.year === now.year;
  if (sameDay) return `${p.hh}:${p.mm}`;
  const yest = new Date(now.date.getTime() - 86400000);
  if (p.day === yest.getUTCDate() && p.month === yest.getUTCMonth())
    return `вчера, ${p.hh}:${p.mm}`;
  return `${p.day} ${MONTHS[p.month]}`;
}

function fullDate(iso) {
  const p = mskParts(iso);
  return `${p.day} ${MONTHS[p.month]} ${p.year} г. в ${p.hh}:${p.mm}`;
}

function token() {
  return crypto.createHmac("sha256", SECRET).update("ok").digest("hex").slice(0, 32);
}

function authed(req) {
  const raw = String(req.headers.cookie || "");
  const m = raw.match(new RegExp(`${COOKIE}=([a-f0-9]+)`));
  return !!m && m[1] === token();
}

// ── вёрстка ──────────────────────────────────────────────────────────────────
const CSS = `
*{box-sizing:border-box}
body{margin:0;font:14px/1.5 -apple-system,"Golos Text","Segoe UI",Roboto,Arial,sans-serif;color:#1a1a1a;background:#fff}
a{color:inherit;text-decoration:none}
.top{background:#1c1c1e;color:#fff;display:flex;align-items:center;gap:26px;padding:0 22px;height:48px;font-size:13px}
.top .site{background:#2c2c2e;border-radius:8px;padding:6px 12px;font-weight:600}
.top .sp{margin-left:auto;opacity:.75}
.wrap{max-width:1180px;margin:0 auto;padding:26px 22px 60px}
h1{font-size:28px;font-weight:700;margin:0}
.bar{display:flex;align-items:center;gap:12px;margin-bottom:22px}
.bar .right{margin-left:auto;display:flex;align-items:center;gap:10px}
.btn{border:1px solid #e3e3e6;background:#fff;border-radius:10px;padding:8px 14px;font-size:13px;cursor:pointer;display:inline-flex;align-items:center;gap:8px}
.btn:hover{background:#f7f7f8}
select.btn{padding-right:28px}
.pager{display:flex;align-items:center;gap:8px;font-size:13px;color:#6b6b70}
.table{width:100%;border-collapse:collapse}
.table th{font-size:12px;color:#8b8b90;font-weight:500;text-align:left;padding:10px 12px;border-bottom:1px solid #eeeef0}
.table td{padding:13px 12px;border-bottom:1px solid #f4f4f6;font-size:13px;vertical-align:middle}
.table tr.row:hover td{background:#fafafb}
.table tr.row{cursor:pointer}
.num{color:#6b6b70;width:78px}
.chip{display:inline-block;border-radius:9px;padding:5px 12px;font-size:12px;font-weight:500}
.muted{color:#b5b5ba}
.ellip{max-width:210px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:inline-block;vertical-align:bottom}
.page-col{color:#9a9aa0}
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
.panel .r{display:grid;grid-template-columns:190px 1fr;border-bottom:1px solid #f1f1f3}
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
.statuses{position:relative;display:inline-block}
.statuses select{appearance:none;border:0;border-radius:9px;padding:6px 28px 6px 12px;font:inherit;font-size:12px;font-weight:500;cursor:pointer}
.hint{color:#8b8b90;font-size:12px;margin-top:8px}
`;

function layout(title, body, site) {
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${esc(title)}</title><style>${CSS}</style></head><body>
<div class="top"><span class="site">${esc(site)}</span>
<a href="/leads">Заявки</a><span class="sp">копия · только наши заявки</span></div>
${body}</body></html>`;
}

function loginPage(site, err) {
  return layout(
    "Вход — Заявки",
    `<form class="login" method="post" action="/leads/login">
      <h1 style="font-size:20px;margin-bottom:18px">Заявки</h1>
      <input name="code" inputmode="numeric" autocomplete="off" autofocus placeholder="код">
      <button type="submit">Войти</button>
      ${err ? '<div class="hint" style="color:#c23c3c">Неверный код</div>' : ""}
    </form>`,
    site
  );
}

function listPage(all, q, site) {
  const status = q.get("status") || "";
  const limit = PAGE_SIZES.includes(Number(q.get("limit"))) ? Number(q.get("limit")) : 25;
  const page = Math.max(1, Number(q.get("page")) || 1);
  const filtered = status ? all.filter((l) => l.status === status) : all;
  const pages = Math.max(1, Math.ceil(filtered.length / limit));
  const slice = filtered.slice((page - 1) * limit, page * limit);
  const qs = (over) => {
    const p = new URLSearchParams({ status, limit: String(limit), page: String(page), ...over });
    [...p.entries()].forEach(([k, v]) => (!v || v === "0") && p.delete(k));
    return "/leads?" + p.toString();
  };

  const rows = slice
    .map((l) => {
      const st = statusOf(l.status);
      const contact = l.phone || l.email || "—";
      return `<tr class="row" onclick="location.href='/leads/${l.id}'">
      <td class="num">${l.id}</td>
      <td><span class="chip" style="background:${st.color};color:${st.text}">${st.title}</span></td>
      <td class="muted">${l.payment || "—"}</td>
      <td>${l.clientName ? esc(l.clientName) : '<span class="muted">—</span>'}</td>
      <td>${esc(contact)}</td>
      <td>${esc(l.form)} <span class="ellip page-col">${esc(l.pageTitle || l.pagePath)}</span></td>
      <td style="text-align:right;color:#6b6b70">${shortDate(l.at)}</td>
    </tr>`;
    })
    .join("");

  const body = `<div class="wrap">
  <div class="bar"><h1>Заявки</h1>
    <div class="right">
      <form method="get" action="/leads" style="display:flex;gap:10px;align-items:center">
        <select class="btn" name="status" onchange="this.form.submit()">
          <option value="">Все статусы</option>
          ${STATUSES.map((s) => `<option value="${s.key}"${status === s.key ? " selected" : ""}>${s.title}</option>`).join("")}
        </select>
        <select class="btn" name="limit" onchange="this.form.submit()">
          ${PAGE_SIZES.map((n) => `<option value="${n}"${limit === n ? " selected" : ""}>${n}</option>`).join("")}
        </select>
      </form>
      <a class="btn" href="/leads/export.csv${status ? "?status=" + status : ""}">Скачать CSV</a>
      <div class="pager">
        <a class="arrow${page <= 1 ? " off" : ""}" href="${qs({ page: String(page - 1) })}">‹</a>
        <span>${page} из ${pages}</span>
        <a class="arrow${page >= pages ? " off" : ""}" href="${qs({ page: String(page + 1) })}">›</a>
      </div>
    </div>
  </div>
  ${
    slice.length
      ? `<table class="table"><thead><tr>
    <th class="num">№</th><th>Статус</th><th>Оплата</th><th>Имя клиента</th>
    <th>Контакт</th><th>Форма / Страница</th><th style="text-align:right">Дата</th>
  </tr></thead><tbody>${rows}</tbody></table>`
      : `<div class="empty">Заявок пока нет.<div class="hint">Сюда попадают заявки, отправленные с копии сайта.</div></div>`
  }
  <div class="hint">Всего заявок: ${all.length}${status ? `, по фильтру: ${filtered.length}` : ""}</div>
</div>`;
  return layout("Заявки", body, site);
}

function cardPage(lead, prev, next, site) {
  const st = statusOf(lead.status);
  const fieldRows = lead.fields.length
    ? lead.fields
        .map(
          (f) => `<div class="r"><div class="k">${esc(f.name)}</div><div class="v">${esc(f.value) || "—"}</div></div>`
        )
        .join("")
    : `<div class="r"><div class="k">Поля</div><div class="v">—</div></div>`;

  const utmKeys = Object.keys(lead.utm || {});
  const utmBlock = utmKeys.length
    ? `<div class="sect"><h2>UTM-метки</h2><div class="panel">${utmKeys
        .map(
          (k) => `<div class="r"><div class="k">${esc(k)}</div><div class="v">${esc(lead.utm[k])}</div></div>`
        )
        .join("")}</div></div>`
    : "";

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
      ${utmBlock}
    </div>
    <div>
      <div class="sect"><h2>Источник</h2>
        <div class="src">
          <div class="t">${esc(lead.pageTitle || "Страница сайта")}</div>
          <div class="u"><a href="${esc(lead.pagePath)}" target="_blank">${esc(site + lead.pagePath)}</a></div>
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
  return layout(`Заявка #${lead.id}`, body, site);
}

function csv(list) {
  const head = ["Номер", "Дата", "Статус", "Имя", "Телефон", "Email", "Форма", "Страница", "IP", "Устройство", "Заметки"];
  const rows = list.map((l) => [
    l.id,
    fullDate(l.at),
    statusOf(l.status).title,
    l.clientName,
    l.phone,
    l.email,
    l.form,
    l.pagePath,
    l.ip,
    l.device,
    l.notes
  ]);
  const q = (v) => `"${String(v == null ? "" : v).replace(/"/g, '""')}"`;
  return "﻿" + [head, ...rows].map((r) => r.map(q).join(";")).join("\r\n");
}

// ── точка входа ──────────────────────────────────────────────────────────────
// handle(req, res, ctx) → true, если запрос обработан разделом «Заявки».
// ctx: { leadsFile, siteDir, site, readBody, send }
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

  // вход по коду
  if (p === "/leads/login" && req.method === "POST") {
    ctx.readBody(req).then((raw) => {
      const code = decodeURIComponent((raw.match(/code=([^&]*)/) || [, ""])[1] || "").replace(/\+/g, " ").trim();
      if (code !== CODE) return html(200, loginPage(ctx.site, true));
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
    html(200, loginPage(ctx.site, false));
    return true;
  }

  const raw = load(ctx.leadsFile);
  const all = raw
    .map((e, i) => normalize(e, i, ctx.siteDir))
    .sort((a, b) => new Date(b.at) - new Date(a.at));

  // выгрузка
  if (p === "/leads/export.csv") {
    const status = url.searchParams.get("status");
    const list = status ? all.filter((l) => l.status === status) : all;
    ctx.send(req, res, 200, Buffer.from(csv(list), "utf8"), "text/csv; charset=utf-8", {
      "Content-Disposition": 'attachment; filename="zayavki.csv"',
      "Cache-Control": "no-store",
      "X-Robots-Tag": "noindex, nofollow"
    });
    return true;
  }

  // изменение статуса и заметок
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

  // карточка
  const card = p.match(/^\/leads\/(\d+)$/);
  if (card) {
    const id = Number(card[1]);
    const i = all.findIndex((l) => l.id === id);
    if (i < 0) {
      html(404, layout("Заявка не найдена", '<div class="wrap"><div class="empty">Такой заявки нет.<div class="hint"><a href="/leads">К списку</a></div></div></div>', ctx.site));
      return true;
    }
    const prev = i > 0 ? all[i - 1].id : null;
    const next = i < all.length - 1 ? all[i + 1].id : null;
    html(200, cardPage(all[i], prev, next, ctx.site));
    return true;
  }

  html(200, listPage(all, url.searchParams, ctx.site));
  return true;
}

module.exports = { handle, normalize, STATUSES };
