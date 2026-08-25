// ─────────────────────────────────────────────────────────────────────────────
// visa-sc.com — англоязычный лендинг «ВНЖ Испании» (копия visa-sc.ru/spain_vnzh/).
// Сам сайт — статика, её отдаёт nginx из /var/www/visa-sc-com. Сюда nginx
// проксирует ТОЛЬКО /api/vscom-lead (с Host: voyotravel.ru, чтобы не задевать
// host-зависимую логику основного приложения).
//
// КУДА ПАДАЮТ ЗАЯВКИ (три независимых адресата, каждый работает сам по себе):
//   1) amoCRM — контакт + сделка в воронке «Отдел продаж», статус «Ещё не
//      связывались», тег VSCOM_AMO_TAG (по умолчанию «VSC-EN») и закреплённое
//      примечание со всеми полями формы (имя, телефон, email, ответы квиза,
//      страница, UTM). Отключается VSCOM_AMO=0.
//   2) Письмо на VSCOM_LEADS_EMAIL (по умолчанию director@visa-sc.ru) —
//      страховка на случай, если amo недоступна.
//   3) Локальный журнал .vscomLeads.json рядом с server.js — последние 2000
//      заявок, чтобы ничего не терялось даже при падении и amo, и почты.
//
// Приложение НИКОГДА не отвечает клиенту ошибкой, если заявка легла хотя бы в
// журнал: для посетителя важно увидеть «спасибо», разбор проблем — наше дело.
// ─────────────────────────────────────────────────────────────────────────────
const fs = require("fs");
const path = require("path");

const LEADS_FILE = path.join(__dirname, ".vscomLeads.json");
const LEADS_EMAIL = process.env.VSCOM_LEADS_EMAIL || "director@visa-sc.ru";
const AMO_TAG = process.env.VSCOM_AMO_TAG || "VSC-EN";
const AMO_ENABLED = process.env.VSCOM_AMO !== "0";
const PIPELINE_NAME = "отдел продаж";
const STATUS_NAME = "ещё не связывались";
const MAX_STORED = 2000;

// Заголовки полей формы для примечания в amo и для письма.
const FORM_TITLES = {
  hero: "Hero form (free consultation)",
  quiz: "Quiz (4 questions)",
  short: "Short form (callback)",
  final: "Final form (full request)",
  callback: "Header callback"
};

// ── журнал ───────────────────────────────────────────────────────────────────
function loadLeads() {
  try {
    return JSON.parse(fs.readFileSync(LEADS_FILE, "utf8"));
  } catch (_) {
    return [];
  }
}

function saveLead(entry) {
  const all = loadLeads();
  all.push(entry);
  const trimmed = all.length > MAX_STORED ? all.slice(all.length - MAX_STORED) : all;
  fs.writeFileSync(LEADS_FILE, JSON.stringify(trimmed, null, 2));
}

// ── антиспам: не больше 5 заявок с одного IP за 10 минут ─────────────────────
const RATE_WINDOW_MS = 10 * 60 * 1000;
const RATE_MAX = 5;
const _hits = new Map();

function rateOk(ip) {
  const now = Date.now();
  const list = (_hits.get(ip) || []).filter((t) => now - t < RATE_WINDOW_MS);
  if (list.length >= RATE_MAX) {
    _hits.set(ip, list);
    return false;
  }
  list.push(now);
  _hits.set(ip, list);
  if (_hits.size > 5000) _hits.clear();
  return true;
}

// ── вспомогательное ──────────────────────────────────────────────────────────
function clean(v, max = 500) {
  return String(v == null ? "" : v).replace(/\s+/g, " ").trim().slice(0, max);
}

function digitsOnly(v) {
  return String(v || "").replace(/\D/g, "");
}

function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// Плоский список «поле: значение» — один и тот же и для примечания, и для письма.
function leadRows(lead) {
  const rows = [];
  rows.push(["Source", "visa-sc.com (English landing, Spain residency)"]);
  rows.push(["Form", FORM_TITLES[lead.form] || lead.form || "unknown"]);
  if (lead.name) rows.push(["Name", lead.name]);
  rows.push(["Phone", lead.phoneDisplay]);
  if (lead.email) rows.push(["Email", lead.email]);
  if (lead.employment) rows.push(["Employment", lead.employment]);
  if (lead.citizenship) rows.push(["Citizenship", lead.citizenship]);
  if (lead.comment) rows.push(["Comment", lead.comment]);
  if (lead.quiz) {
    if (lead.quiz.citizenship) rows.push(["Quiz: citizenship", lead.quiz.citizenship]);
    if (lead.quiz.location) rows.push(["Quiz: currently in", lead.quiz.location]);
    if (lead.quiz.qualification) rows.push(["Quiz: degree / experience", lead.quiz.qualification]);
    if (lead.quiz.income) rows.push(["Quiz: remote income", lead.quiz.income]);
  }
  if (lead.page) rows.push(["Page", lead.page]);
  if (lead.referrer) rows.push(["Referrer", lead.referrer]);
  if (lead.lang) rows.push(["Browser language", lead.lang]);
  const utmKeys = Object.keys(lead.utm || {});
  if (utmKeys.length) rows.push(["UTM", utmKeys.map((k) => `${k}=${lead.utm[k]}`).join(", ")]);
  rows.push(["Received", lead.at]);
  return rows;
}

// ── amoCRM: контакт (без дублей) + сделка + закреплённое примечание ──────────
async function pushToAmo(lead, deps) {
  const { amoGetAllPages, amoPost, findMatchingContacts, amoBaseUrl, normalizeText } = deps;
  const baseUrl = amoBaseUrl();
  const phone = lead.phoneDigits;

  let contactId = null;
  try {
    const existing = await findMatchingContacts(baseUrl, phone);
    if (existing && existing.length) contactId = existing[0].id;
  } catch (e) {
    console.error("VSCOM amo find contact:", e.message);
  }

  if (!contactId) {
    const contactBody = [{
      name: lead.name || lead.phoneDisplay,
      custom_fields_values: [{
        field_code: "PHONE",
        values: [{ value: lead.phoneDisplay, enum_code: "WORK" }]
      }].concat(lead.email ? [{
        field_code: "EMAIL",
        values: [{ value: lead.email, enum_code: "WORK" }]
      }] : [])
    }];
    const created = await amoPost(`${baseUrl}/api/v4/contacts`, contactBody);
    contactId = created?._embedded?.contacts?.[0]?.id;
    if (!contactId) throw new Error("не удалось создать контакт");
  }

  // Воронка «Отдел продаж» → «Ещё не связывались» (как при регистрации в ЛК).
  const pipelines = await amoGetAllPages(`${baseUrl}/api/v4/leads/pipelines`);
  let pipelineId = null;
  let statusId = null;
  for (const p of pipelines) {
    const pname = normalizeText(p.name);
    if (pname === PIPELINE_NAME || pname.startsWith(PIPELINE_NAME)) {
      pipelineId = p.id;
      const statuses = await amoGetAllPages(`${baseUrl}/api/v4/leads/pipelines/${p.id}/statuses`);
      for (const s of statuses) {
        if (normalizeText(s.name) === STATUS_NAME) { statusId = s.id; break; }
      }
      break;
    }
  }
  if (!pipelineId || !statusId) throw new Error("не найдена воронка/статус «Отдел продаж» → «Ещё не связывались»");

  const leadBody = [{
    name: "ВНЖ Испании — заявка с visa-sc.com (EN)",
    pipeline_id: pipelineId,
    status_id: statusId,
    _embedded: {
      contacts: [{ id: contactId }],
      tags: [{ name: AMO_TAG }]
    }
  }];
  const created = await amoPost(`${baseUrl}/api/v4/leads`, leadBody);
  const leadId = created?._embedded?.leads?.[0]?.id;
  if (!leadId) throw new Error("не удалось создать сделку");

  const noteText = [
    "Заявка с англоязычного лендинга visa-sc.com (ВНЖ Испании).",
    "Клиент пишет и, скорее всего, говорит по-английски.",
    ""
  ].concat(leadRows(lead).map(([k, v]) => `${k}: ${v}`)).join("\n");

  try {
    await amoPost(`${baseUrl}/api/v4/leads/${leadId}/notes`, [{
      note_type: "common",
      is_pinned: true,
      params: { text: noteText }
    }]);
  } catch (e) {
    console.error("VSCOM amo note:", e.message);
  }

  return { contactId, leadId };
}

// ── письмо-дубль ─────────────────────────────────────────────────────────────
async function mailLead(lead, amo, deps) {
  const rows = leadRows(lead)
    .map(([k, v]) => `<tr><td style="padding:5px 12px 5px 0;color:#6b7280;white-space:nowrap;vertical-align:top">${esc(k)}</td><td style="padding:5px 0"><b>${esc(v)}</b></td></tr>`)
    .join("");
  const amoLine = amo && amo.leadId
    ? `<p style="margin:0 0 14px">Сделка в amoCRM: <a href="${esc(deps.amoBaseUrl())}/leads/detail/${amo.leadId}">${amo.leadId}</a></p>`
    : `<p style="margin:0 0 14px;color:#b8351a">В amoCRM сделка НЕ создана, обработайте вручную.</p>`;
  const html = `
    <div style="font-family:Arial,sans-serif;font-size:14px;color:#1b1f21">
      <h2 style="margin:0 0 10px;font-size:18px">Заявка с visa-sc.com (английский лендинг, ВНЖ Испании)</h2>
      ${amoLine}
      <table style="border-collapse:collapse">${rows}</table>
    </div>`;
  const res = await deps.sendMail({
    to: LEADS_EMAIL,
    subject: `visa-sc.com: заявка ${lead.phoneDisplay}${lead.name ? " — " + lead.name : ""}`,
    html,
    text: leadRows(lead).map(([k, v]) => `${k}: ${v}`).join("\n")
  });
  if (!res.ok) throw new Error(res.error || "sendMail failed");
}

// ── маршрут ──────────────────────────────────────────────────────────────────
function mount(app, deps) {
  app.post("/api/vscom-lead", async (req, res) => {
    const b = req.body || {};

    // Ловушка для ботов: поле company скрыто через CSS, человек его не заполнит.
    if (clean(b.company)) return res.json({ ok: true });

    const ip = String(req.headers["x-forwarded-for"] || req.ip || "").split(",")[0].trim();
    if (!rateOk(ip)) {
      return res.status(429).json({ ok: false, message: "Too many requests. Please call +7 495 369-18-67." });
    }

    const phoneDigits = digitsOnly(b.phone);
    if (phoneDigits.length < 9 || phoneDigits.length > 15) {
      return res.status(400).json({ ok: false, message: "Please enter a valid phone number with the country code." });
    }

    const lead = {
      at: new Date().toISOString(),
      form: clean(b.form, 40),
      name: clean(b.name, 120),
      phoneDigits,
      phoneDisplay: "+" + phoneDigits,
      email: clean(b.email, 160),
      employment: clean(b.employment, 60),
      citizenship: clean(b.citizenship, 60),
      comment: clean(b.comment, 1500),
      quiz: b.quiz && typeof b.quiz === "object" ? {
        citizenship: clean(b.quiz.citizenship, 60),
        location: clean(b.quiz.location, 60),
        qualification: clean(b.quiz.qualification, 60),
        income: clean(b.quiz.income, 60)
      } : null,
      page: clean(b.page, 400),
      referrer: clean(b.referrer, 400),
      lang: clean(b.lang, 20),
      utm: b.utm && typeof b.utm === "object" ? b.utm : {},
      ip
    };

    // 1) журнал — первым, он не должен зависеть ни от amo, ни от почты
    let stored = true;
    try {
      saveLead(lead);
    } catch (e) {
      stored = false;
      console.error("VSCOM lead store:", e.message);
    }

    // 2) amoCRM
    let amo = null;
    if (AMO_ENABLED) {
      try {
        amo = await pushToAmo(lead, deps);
        console.log(`VSCOM lead → amo: contact=${amo.contactId} lead=${amo.leadId} phone=${lead.phoneDisplay}`);
      } catch (e) {
        console.error("VSCOM lead → amo FAILED:", e.response?.data || e.message);
      }
    }

    // 3) письмо
    try {
      await mailLead(lead, amo, deps);
    } catch (e) {
      console.error("VSCOM lead → mail FAILED:", e.message);
    }

    if (!stored && !amo) {
      return res.status(500).json({ ok: false, message: "Could not send the request. Please call +7 495 369-18-67." });
    }
    return res.json({ ok: true });
  });

  // Просмотр журнала заявок — только для сотрудников (guard приходит извне).
  if (deps.requireStaff) {
    app.get("/admin/api/vscom-leads", deps.requireStaff, (req, res) => {
      res.json({ ok: true, leads: loadLeads().slice(-500).reverse() });
    });
  }

  console.log(`VSCOM: /api/vscom-lead смонтирован (amo=${AMO_ENABLED ? "вкл, тег " + AMO_TAG : "выкл"}, письма → ${LEADS_EMAIL})`);
}

module.exports = { mount, loadLeads };
