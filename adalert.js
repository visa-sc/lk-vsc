// ═══════════════════════════════════════════════════════════════════════════
// Утреннее письмо Андрею Петрову о проблемах за прошедшие сутки (просьба
// Андрея 23.09.2026).
//
// Собираем в одном письме три вещи:
//   • посадочные страницы Директа с изъянами (ночная проверка adcheck.js);
//   • номера и заявки, не доехавшие в amoCRM (ночная сверка phonetest.js);
//   • номера в АТС, терявшие регистрацию.
//
// Правило (уточнено Андреем 24.09.2026): письмо уходит КАЖДОЕ утро, пока проблема
// жива — чтобы висящее не забывалось. В письме отделяем новое от того, что тянется
// с прошлых дней, и у старого пишем, с какого числа оно висит. Когда проблема
// исчезает, её отпечаток забывается: появится снова — будет считаться новой.
// Проблем нет — письма нет вообще.
// ═══════════════════════════════════════════════════════════════════════════
const fs = require("fs");
const path = require("path");

const FILE = path.join(__dirname, ".vscAlertSent.json");
const TO = process.env.ADALERT_TO || "ap@spt1.ru";          // Андрей Петров
const REPLY = "director@visa-sc.ru";

function load() { try { return JSON.parse(fs.readFileSync(FILE, "utf8")); } catch (_) { return { keys: {}, lastMailAt: 0 }; } }
function save(d) { try { fs.writeFileSync(FILE, JSON.stringify(d, null, 1), "utf8"); } catch (e) { console.error("adalert save:", e.message); } }

const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const fmt = (ts) => { const d = new Date(ts + 3 * 3600 * 1000); const p = (n) => (n < 10 ? "0" : "") + n;
  return p(d.getUTCDate()) + "." + p(d.getUTCMonth() + 1) + " " + p(d.getUTCHours()) + ":" + p(d.getUTCMinutes()); };

// Собираем текущие проблемы в плоский список с устойчивыми отпечатками.
function gather(deps) {
  const items = [];
  // 1. Страницы рекламы
  try {
    const ac = deps.adcheck && deps.adcheck.load();
    if (ac && Array.isArray(ac.problems)) {
      ac.problems.forEach((p) => {
        items.push({
          group: "pages", key: "page|" + p.url + "|" + p.faults.join(";"),
          title: p.url, camps: p.camps || [], detail: p.faults.join(", "), at: ac.ts,
        });
      });
    }
  } catch (e) { console.error("adalert pages:", e.message); }
  // 2. Сверка контактов и номера АТС — по последнему завершённому дню
  try {
    const rs = deps.reconSummary && deps.reconSummary();
    const day = rs && (rs.days || [])[0];
    if (day) {
      (day.missCalls || []).forEach((phone) => {
        items.push({ group: "calls", key: "call|" + day.day + "|" + phone, title: phone, detail: "звонок был, контакта в amoCRM нет", at: day.at });
      });
      (day.forms || []).forEach((f) => {
        (f.missPhones || []).forEach((phone) => {
          items.push({ group: "forms", key: "form|" + day.day + "|" + f.id + "|" + phone, title: phone,
            detail: "заявка с " + (f.label || f.id) + " не доехала в amoCRM", at: day.at });
        });
      });
      const tr = day.trunks;
      if (tr && (tr.incidents || []).length) {
        tr.incidents.forEach((x) => {
          items.push({ group: "trunks", key: "trunk|" + day.day + "|" + x.number + "|" + x.from,
            title: x.number + (x.name ? " (" + x.name + ")" : ""),
            detail: x.to ? ("не было связи " + fmt(x.from) + " — " + fmt(x.to)) : ("нет связи с " + fmt(x.from) + " и до сих пор"),
            at: x.from });
        });
      }
    }
  } catch (e) { console.error("adalert recon:", e.message); }
  return items;
}

const GROUP_TITLE = {
  pages: "Страницы рекламы с изъянами",
  calls: "Звонки без контакта в amoCRM",
  forms: "Заявки, не доехавшие в amoCRM",
  trunks: "Номера, терявшие связь в АТС",
};

function dayStr(ts) { const d = new Date(ts + 3 * 3600 * 1000); const p = (n) => (n < 10 ? "0" : "") + n;
  return p(d.getUTCDate()) + "." + p(d.getUTCMonth() + 1); }

function buildHtml(items, sinceOf) {
  const fresh = items.filter((x) => !sinceOf[x.key]);
  const old = items.filter((x) => sinceOf[x.key]);
  let html = "<p>Андрей, доброе утро. По проверкам за прошедшие сутки.</p>";
  const section = (title, list, withSince) => {
    if (!list.length) return "";
    let h = "<p><b>" + title + "</b></p><ul>";
    list.slice(0, 40).forEach((x) => {
      h += "<li>" + esc(x.title)
        + (x.camps && x.camps.length ? ' <span style="color:#666;">(' + esc(x.camps.slice(0, 3).join(", ")) + ")</span>" : "")
        + " — " + esc(x.detail)
        + (withSince && sinceOf[x.key] ? ' <span style="color:#666;">висит с ' + dayStr(sinceOf[x.key]) + "</span>" : "")
        + "</li>";
    });
    if (list.length > 40) h += "<li>…и ещё " + (list.length - 40) + "</li>";
    return h + "</ul>";
  };
  ["pages", "calls", "forms", "trunks"].forEach((g) => {
    html += section(GROUP_TITLE[g] + (fresh.filter((x) => x.group === g).length ? " — новое" : ""), fresh.filter((x) => x.group === g), false);
  });
  const oldAny = old.length;
  if (oldAny) {
    html += '<p style="margin-top:14px;"><b>Остаётся нерешённым</b></p>';
    ["pages", "calls", "forms", "trunks"].forEach((g) => {
      html += section(GROUP_TITLE[g], old.filter((x) => x.group === g), true);
    });
  }
  html += '<p style="color:#666;font-size:13px;">Проверка идёт каждую ночь: страницы всех активных объявлений и быстрых ссылок Директа, сверка звонков и заявок с amoCRM, регистрация номеров в АТС. Письмо приходит каждое утро, пока есть что чинить.</p>';
  return html;
}

// deps: { adcheck, reconSummary, sendMail }
async function runMorning(deps, trigger) {
  const st = load();
  const items = gather(deps);
  const now = Date.now();
  const alive = {};
  items.forEach((x) => { alive[x.key] = true; });
  // Забываем то, чего больше нет: проблема ушла, её повторное появление — новость.
  Object.keys(st.keys).forEach((k) => { if (!alive[k]) delete st.keys[k]; });
  const fresh = items.filter((x) => !st.keys[x.key]);
  if (!items.length) {
    save(st);
    console.log("ADALERT [" + (trigger || "cron") + "]: проблем нет, письма нет");
    return { sent: false, total: 0 };
  }
  const word = items.length === 1 ? "проблема" : (items.length < 5 ? "проблемы" : "проблем");
  const subj = "Проверка сайтов и заявок: " + items.length + " " + word
    + (fresh.length ? " (новых: " + fresh.length + ")" : " — всё то же");
  await deps.sendMail({ to: TO, replyTo: REPLY, subject: subj, html: buildHtml(items, st.keys) });
  fresh.forEach((x) => { st.keys[x.key] = now; });   // отмечаем день появления
  st.lastMailAt = now;
  save(st);
  console.log("ADALERT [" + (trigger || "cron") + "]: письмо отправлено, всего " + items.length + ", из них новых " + fresh.length);
  return { sent: true, total: items.length, fresh: fresh.length };
}

module.exports = { runMorning, gather, load };
