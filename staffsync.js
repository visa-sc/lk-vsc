// ═══════════════════════════════════════════════════════════════════════════
// Сторож состава сотрудников: АТС ↔ amoCRM ↔ зарплатная таблица.
//
// Зачем. Люди приходят и уходят, и если оператор есть в АТС, но не нашёлся в
// amoCRM (завели только в одной системе или имя написано по-разному), его звонки
// молча выпадают из статистики раздела /vsc «ФОТ». Раньше это было видно только
// тому, кто откроет вкладку «Статистика по сотрудникам» — а она у админа скрыта,
// то есть по факту не видел никто. До 29.09.2026 роль сторожа выполняла ручная
// ежемесячная задача в приложении Андрея; она работала, только пока приложение
// открыто, поэтому проверка переехала на сервер.
//
// Откуда данные — только из того, что уже собрано, ни одного лишнего запроса:
//   • .vscPbxStats.json   — справочник АТС, обновляется ночным пересчётом в 01:10;
//   • .vscAmoRoster.json  — пользователи amoCRM с группами, обновляется раз в 6 ч;
//   • .vscZarplata.json   — штат и отделы из зарплатной таблицы.
// amoCRM здесь не дёргается вообще: лимит строгий, нас за него уже банили.
//
// Что делает: раз в сутки считает расхождения и, если появилось НОВОЕ, шлёт письмо
// директору. Одно и то же расхождение письмом не повторяется — только когда оно
// изменилось или исчезло. Тот же снимок отдаётся в раздел /vsc «ФОТ» плашкой.
// ═══════════════════════════════════════════════════════════════════════════
const fs = require("fs");
const path = require("path");

const FILE = path.join(__dirname, ".vscStaffSync.json");
const PBX_FILE = path.join(__dirname, ".vscPbxStats.json");
const AMO_ROSTER_FILE = path.join(__dirname, ".vscAmoRoster.json");
const ZARPLATA_FILE = path.join(__dirname, ".vscZarplata.json");
const TO = process.env.STAFF_SYNC_TO || "director@visa-sc.ru";
const CHECK_HOUR_MSK = 9;                       // проверка в 09:20 МСК, после ночного пересчёта АТС

// Из штата зарплатной таблицы исключены владелец, управляющая и Зайцева —
// тот же список, что в разделе ФОТ.
const NOT_STAFF = [/комисаренко/i, /панфилова\s+галина/i, /зайцева\s+екатерина/i];

const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch (_) { return null; } };
const norm = (x) => String(x || "").toLowerCase().replace(/ё/g, "е").replace(/\s+/g, " ").trim();
const load = () => readJson(FILE);
function save(d) {
  try { fs.writeFileSync(FILE, JSON.stringify(d, null, 1), "utf8"); return true; }
  catch (e) { console.error("staffSync save:", e.message); return false; }
}

// Снимок состояния и список того, что требует человека.
function compute() {
  const px = readJson(PBX_FILE) || {};
  const amo = readJson(AMO_ROSTER_FILE) || {};
  const zp = readJson(ZARPLATA_FILE) || {};
  const now = Date.now();
  const issues = [];                              // { key, text } — key нужен, чтобы не слать одно и то же дважды

  const pbxExt = px.ext || {};
  const amoUsers = (amo.users || []).filter((u) => u.active);
  const amoNames = new Set(amoUsers.map((u) => norm(u.name)));

  // 1. Кто есть в АТС, но не нашёлся в amoCRM. Главная поломка: звонки такого
  // оператора не попадают в статистику, и это никак иначе не заметно.
  const unmatched = Object.keys(pbxExt)
    .filter((e) => String(pbxExt[e] || "").trim() && !amoNames.has(norm(pbxExt[e])))
    .map((e) => ({ ext: e, name: pbxExt[e] }));
  if (unmatched.length) {
    issues.push({
      key: "unmatched:" + unmatched.map((x) => x.ext).sort().join(","),
      text: "В АТС есть, в amoCRM не нашлись по имени: "
        + unmatched.map((x) => x.name + " (" + x.ext + ")").join(", ")
        + ". Их звонки в статистику ФОТ не попадают, пока имена не совпадут.",
    });
  }

  // 2. Состав АТС изменился за последние сутки.
  const rd = px.rosterDiff;
  if (rd && rd.ts && now - rd.ts < 26 * 3600 * 1000) {
    const bits = [];
    if ((rd.added || []).length) bits.push("добавлены " + rd.added.map((x) => x.name + " (" + x.ext + ")").join(", "));
    if ((rd.removed || []).length) bits.push("убраны " + rd.removed.map((x) => x.name + " (" + x.ext + ")").join(", "));
    if (bits.length) issues.push({ key: "pbxdiff:" + rd.ts, text: "Изменился состав АТС: " + bits.join("; ") + "." });
  }

  // 3. Состав amoCRM изменился за последние сутки.
  const ad = amo.diff;
  if (ad && ad.ts && now - ad.ts < 26 * 3600 * 1000) {
    const bits = [];
    if ((ad.added || []).length) bits.push("пришли или сменили группу " + ad.added.map((x) => x.name + " (" + (x.group || "без группы") + ")").join(", "));
    if ((ad.removed || []).length) bits.push("ушли " + ad.removed.map((x) => x.name).join(", "));
    if (bits.length) issues.push({ key: "amodiff:" + ad.ts, text: "Изменился состав amoCRM: " + bits.join("; ") + "." });
  }

  // 4. Первая линия. Её состав тянется из группы АТС и идёт в знаменатель нагрузки,
  // поэтому смена состава меняет цифры раздела.
  const plExt = (px.plExt || []).slice();
  const plNames = plExt.map((e) => pbxExt[e]).filter(Boolean);
  const prev = load();
  const prevPl = (prev && prev.pl && prev.pl.ext) || null;
  if (prevPl && prevPl.join(",") !== plExt.join(",")) {
    issues.push({
      key: "pl:" + plExt.join(","),
      text: "Изменился состав «Первой линии»: было " + prevPl.length + " операторов, стало " + plExt.length
        + " (" + (plNames.join(", ") || plExt.join(", ")) + "). Нагрузка на отдел считается по ним.",
    });
  }

  // 5. Живость источников. Если АТС не отвечает, раздел молча показывает вчерашние
  // цифры — 17–18.09.2026 так и случилось после смены ключа.
  if (px.rosterLive === false) {
    issues.push({ key: "pbxdead", text: "Справочник АТС не ответил при последнем пересчёте — считали по сохранённому списку. Проверьте ключ PBX_KEY." });
  }
  if (px.lastError && px.lastError.months && px.lastError.months.length) {
    issues.push({
      key: "pbxerr:" + px.lastError.ts,
      text: "АТС не отдала статистику за месяцы: " + px.lastError.months.map((m) => m.month).join(", ") + ".",
    });
  }
  if (amo.ts && now - amo.ts > 26 * 3600 * 1000) {
    issues.push({ key: "amostale", text: "Справочник amoCRM не обновлялся больше суток (последний раз " + new Date(amo.ts).toLocaleString("ru-RU") + ")." });
  }

  // 6. Штат зарплатной таблицы за свежий месяц — справочно, рядом с числом активных
  // в amoCRM. Расхождение тут нормально (в таблице есть люди без учётки в CRM),
  // поэтому письмом не тревожим, но в разделе показываем обе цифры.
  const months = zp.months || {};
  const mkeys = Object.keys(months);
  const lastKey = mkeys.length ? mkeys[mkeys.length - 1] : null;
  const lastMonth = lastKey ? months[lastKey] : null;
  const zarplata = lastMonth ? {
    month: lastKey,
    staff: lastMonth.staff || 0,
    hasDepts: !!lastMonth.hasDepts,
    depts: lastMonth.depts ? Object.keys(lastMonth.depts).length : 0,
  } : null;
  if (lastMonth && lastMonth.hasDepts === false) {
    issues.push({ key: "nodepts:" + lastKey, text: "В зарплатной таблице за «" + lastKey + "» не разобрались отделы — нагрузка по отделам за этот месяц не посчитается." });
  }

  return {
    ts: now,
    pbx: { users: Object.keys(pbxExt).length, live: px.rosterLive !== false, rosterTs: px.rosterTs || null },
    amo: { active: amoUsers.length, total: (amo.users || []).length, ts: amo.ts || null },
    pl: { ext: plExt, names: plNames },
    zarplata: zarplata,
    unmatched: unmatched,
    issues: issues,
  };
}

// ── Проверка и письмо ────────────────────────────────────────────────────────
// send — sendOrQueueDirectorMail из server.js: сам откладывает письмо, если сейчас
// нерабочее время (окно пн 08:00 – пт 15:00 МСК).
function check(send, why) {
  const prev = load();
  const cur = compute();
  const prevKeys = new Set(((prev && prev.issues) || []).map((x) => x.key));
  const fresh = cur.issues.filter((x) => !prevKeys.has(x.key));
  const gone = ((prev && prev.issues) || []).filter((x) => !cur.issues.some((y) => y.key === x.key));
  cur.lastMailAt = (prev && prev.lastMailAt) || null;

  let mailed = false;
  if (fresh.length && typeof send === "function") {
    const li = (arr) => arr.map((x) => "<li>" + String(x.text).replace(/&/g, "&amp;").replace(/</g, "&lt;") + "</li>").join("");
    const html = '<p><b>Сверка состава сотрудников: появилось новое.</b></p>'
      + "<ul>" + li(fresh) + "</ul>"
      + (gone.length ? '<p style="color:#666;">Закрылось с прошлой проверки:</p><ul style="color:#666;">' + li(gone) + "</ul>" : "")
      + '<p style="color:#888;font-size:13px;">АТС: ' + cur.pbx.users + " добавочных. amoCRM: " + cur.amo.active + " активных."
      + (cur.zarplata ? " Зарплатная таблица «" + cur.zarplata.month + "»: штат " + cur.zarplata.staff + "." : "")
      + "</p>"
      + '<p style="font-size:13px;">Раздел: <a href="https://voyotravel.ru/vsc">voyotravel.ru/vsc</a> → ФОТ.</p>';
    mailed = true;
    send({ to: TO, subject: "Сверка состава: " + fresh.length + " " + (fresh.length === 1 ? "расхождение" : "расхождений"), html: html, noBanner: true });
    cur.lastMailAt = Date.now();
  }
  save(cur);
  console.log("STAFF SYNC [" + (why || "cron") + "]: расхождений " + cur.issues.length
    + (fresh.length ? ", новых " + fresh.length + (mailed ? " — письмо" : " — без письма") : "")
    + "; АТС " + cur.pbx.users + ", amoCRM " + cur.amo.active);
  return cur;
}

// Ежедневно в 09:20 МСК: ночной пересчёт АТС в 01:10 к этому времени уже прошёл.
function schedule(send) {
  const MSK = 3 * 3600 * 1000, DAY = 86400000;
  (function next() {
    const now = Date.now() + MSK;
    let t = Math.floor(now / DAY) * DAY + (CHECK_HOUR_MSK * 60 + 20) * 60 * 1000;
    if (t <= now) t += DAY;
    setTimeout(() => {
      try { check(send, "cron"); } catch (e) { console.error("staffSync:", e && e.message); }
      next();
    }, Math.max(1000, t - now));
  })();
  // Первый прогон через 8 минут после старта — просто чтобы снимок в разделе был
  // свежим и после перезапуска.
  setTimeout(() => { try { check(send, "startup"); } catch (_) {} }, 8 * 60 * 1000);
  console.log("STAFF SYNC: сверка состава АТС ↔ amoCRM ежедневно в 09:20 МСК");
}

module.exports = { compute, check, schedule, load, save };
