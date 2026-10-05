// ═══════════════════════════════════════════════════════════════════════════
// Сторож пустых сделок Flexbe (просьба Андрея 05.10.2026).
//
// Что ловит: интеграция Flexbe → amoCRM иногда создаёт сделку «Новая заявка № N»,
// но не создаёт и не привязывает к ней контакт с телефоном. Так было 02.10.2026
// с заявкой №141945: сделка пришла без номера, менеджер через два часа удалил её
// как пустую, клиент потерялся на три дня.
//
// Что делает: раз в 10 минут берёт сделки, созданные 3–40 минут назад (первые
// 3 минуты даём самой интеграции дописать контакт), ищет среди них сделки с тегом
// Flexbe без контакта, достаёт телефон из заявки во Flexbe по её номеру, находит
// существующий контакт с этим телефоном или создаёт новый, привязывает его и
// оставляет в сделке примечание.
//
// Бережно к API: один запрос к amoCRM за проход (список свежих сделок), низкий
// приоритет общего ограничителя. Flexbe дёргаем, только если нашлась сирота.
// За проход — не больше 3 сделок. Каждую сделку трогаем один раз (журнал на диске),
// и перед записью ещё раз проверяем, не привязал ли контакт кто-то другой.
// История: за 30 дней до запуска из 998 живых сделок Flexbe без контакта — ни одной,
// так что срабатывать сторож должен редко.
//
// Выключатель: FLEXBE_ORPHANS=0 в .env.
// ═══════════════════════════════════════════════════════════════════════════
const fs = require("fs");
const path = require("path");
const axios = require("axios");

const FILE = path.join(__dirname, ".flexbeOrphans.json");
const WINDOW_FROM = 40 * 60;      // сек: насколько назад смотрим
const WINDOW_GRACE = 3 * 60;      // сек: самые свежие не трогаем, интеграция может ещё дописать
const MAX_PER_RUN = 3;
const CF_PAGE_URL = 568514;       // поле сделки «Страница» — по нему понимаем, с какого сайта заявка

function load() { try { return JSON.parse(fs.readFileSync(FILE, "utf8")); } catch (_) { return { done: {}, log: [] }; } }
function save(d) {
  // журнал держим коротким: последние 200 записей, «done» — за 30 дней
  const cutoff = Date.now() - 30 * 86400000;
  Object.keys(d.done).forEach((k) => { if ((d.done[k].at || 0) < cutoff) delete d.done[k]; });
  d.log = (d.log || []).slice(-200);
  try { fs.writeFileSync(FILE, JSON.stringify(d, null, 1), "utf8"); } catch (e) { console.error("FLEXORPHAN save:", e.message); }
}

const cfVal = (e, id) => { const f = (e.custom_fields_values || []).find((x) => x.field_id === id); return f && f.values && f.values.length ? f.values[0].value : null; };
const digits = (s) => String(s || "").replace(/\D/g, "");
function normPhone(raw) {
  let d = digits(raw);
  if (d.length === 11 && d[0] === "8") d = "7" + d.slice(1);
  if (d.length === 10) d = "7" + d;
  return d.length >= 11 ? d : "";
}

// Ищем заявку по номеру сначала на «своём» сайте (по адресу страницы), потом на остальных.
async function findFlexbeLead(sites, num, pageUrl) {
  const host = String(pageUrl || "").replace(/^https?:\/\//, "").split("/")[0].toLowerCase();
  const ordered = sites.slice().sort((a, b) => {
    const ha = String(a.apiUrl || "").includes(host) ? 0 : 1, hb = String(b.apiUrl || "").includes(host) ? 0 : 1;
    return ha - hb;
  });
  for (const s of ordered) {
    if (!s.apiKey || !s.apiUrl) continue;
    try {
      const r = await axios.get(s.apiUrl, { params: { api_key: s.apiKey, method: "getLeads", count: 100 }, timeout: 30000 });
      const raw = (r.data && r.data.data && (r.data.data.leads || r.data.data.list)) || [];
      const list = Array.isArray(raw) ? raw : Object.values(raw);
      const hit = list.find((l) => Number(l.num) === Number(num));
      if (hit) return { site: s, lead: hit };
    } catch (e) { console.error("FLEXORPHAN flexbe " + s.id + ":", e.message); }
  }
  return null;
}

// deps: { baseUrl, amoGet, amoPost, amoBg, findContacts(phone) → [contacts], flexbeSites() → [{id,apiUrl,apiKey}] }
async function run(deps, trigger) {
  if (process.env.FLEXBE_ORPHANS === "0") return { skipped: "выключен" };
  const st = load();
  const now = Math.floor(Date.now() / 1000);
  const data = await deps.amoBg(() => deps.amoGet(deps.baseUrl + "/api/v4/leads", {
    limit: 250, with: "contacts",
    "filter[created_at][from]": now - WINDOW_FROM, "filter[created_at][to]": now - WINDOW_GRACE,
  }));
  const leads = (data && data._embedded && data._embedded.leads) || [];
  const orphans = leads.filter((l) => {
    const tags = ((l._embedded && l._embedded.tags) || []).map((t) => t.name);
    const cs = (l._embedded && l._embedded.contacts) || [];
    return tags.indexOf("Flexbe") >= 0 && !cs.length && !st.done[l.id];
  });
  if (!orphans.length) return { checked: leads.length, fixed: 0 };
  if (orphans.length > MAX_PER_RUN) console.log("FLEXORPHAN: сделок Flexbe без контакта сразу " + orphans.length + " — беру по " + MAX_PER_RUN + " за проход");

  const sites = (deps.flexbeSites && deps.flexbeSites()) || [];
  let fixed = 0;
  for (const l of orphans.slice(0, MAX_PER_RUN)) {
    const rec = { at: Date.now(), leadId: l.id, name: l.name };
    try {
      const m = /№\s*(\d+)/.exec(String(l.name || ""));
      if (!m) { rec.result = "нет номера заявки в названии — пропуск"; continue; }
      rec.num = Number(m[1]);
      const found = await findFlexbeLead(sites, rec.num, cfVal(l, CF_PAGE_URL));
      if (!found) { rec.result = "заявка №" + rec.num + " во Flexbe пока не найдена"; rec.retry = true; continue; }
      const client = found.lead.client || {};
      const phone = normPhone(client.phone || (found.lead.form_data && found.lead.form_data.phone && found.lead.form_data.phone.value));
      const email = String(client.email || "").trim();
      rec.site = found.site.id; rec.phone = phone || null;
      if (!phone && !email) { rec.result = "в заявке нет ни телефона, ни почты — пропуск"; continue; }

      // перед записью — свежий взгляд: вдруг контакт уже привязали
      const fresh = await deps.amoBg(() => deps.amoGet(deps.baseUrl + "/api/v4/leads/" + l.id, { with: "contacts" }));
      if (!fresh || !fresh.id) { rec.result = "сделка уже удалена — пропуск"; continue; }
      if (((fresh._embedded && fresh._embedded.contacts) || []).length) { rec.result = "контакт уже привязан кем-то — ничего не делал"; continue; }

      let contactId = null;
      if (phone) {
        const ex = await deps.amoBg(() => deps.findContacts(phone));
        if (ex && ex.length) { contactId = ex[0].id; rec.contact = "найден существующий #" + contactId; }
      }
      if (!contactId) {
        const cf = [];
        if (phone) cf.push({ field_code: "PHONE", values: [{ value: "+" + phone, enum_code: "WORK" }] });
        if (email) cf.push({ field_code: "EMAIL", values: [{ value: email, enum_code: "WORK" }] });
        const cr = await deps.amoBg(() => deps.amoPost(deps.baseUrl + "/api/v4/contacts", [{ name: String(client.name || "").trim() || "Клиент", custom_fields_values: cf }]));
        contactId = cr && cr._embedded && cr._embedded.contacts && cr._embedded.contacts[0] && cr._embedded.contacts[0].id;
        if (!contactId) throw new Error("amoCRM не вернула id нового контакта");
        rec.contact = "создан #" + contactId;
      }
      await deps.amoBg(() => deps.amoPost(deps.baseUrl + "/api/v4/leads/" + l.id + "/link",
        [{ to_entity_id: contactId, to_entity_type: "contacts", metadata: { is_main: true } }]));
      await deps.amoBg(() => deps.amoPost(deps.baseUrl + "/api/v4/leads/" + l.id + "/notes", [{
        note_type: "common",
        params: { text: "Контакт дописан автоматически: интеграция Flexbe прислала заявку №" + rec.num + " без контакта. "
          + "Телефон взят из самой заявки на сайте" + (phone ? " (+" + phone + ")" : "") + ". Сделка настоящая — не удаляйте её как пустую." },
      }]));
      rec.result = "контакт привязан";
      fixed++;
    } catch (e) {
      rec.result = "ошибка: " + String(e && e.message).slice(0, 200);
      rec.retry = true;   // ошибку сети/API пробуем на следующем проходе
    } finally {
      // Повторяем на следующих проходах, но не дольше часа (6 попыток) — дальше
      // сделка выпадает из окна просмотра, а запись остаётся в журнале.
      st.tries = st.tries || {};
      if (rec.retry) st.tries[l.id] = (st.tries[l.id] || 0) + 1;
      if (!rec.retry || st.tries[l.id] >= 6) { st.done[l.id] = { at: rec.at, num: rec.num || null, result: rec.result }; delete st.tries[l.id]; }
      st.log.push(rec);
      console.log("FLEXORPHAN [" + (trigger || "cron") + "]: сделка #" + l.id + " «" + l.name + "» — " + rec.result + (rec.contact ? ", контакт " + rec.contact : ""));
    }
  }
  save(st);
  return { checked: leads.length, orphans: orphans.length, fixed };
}

module.exports = { run, load };
