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
// Что делает: раз в сутки пересчитывает расхождения и кладёт снимок в файл.
// Писем НЕ шлёт (Андрей 29.09: «это письмо мне не надо») — расхождения видно
// строкой под заголовком блока «Зарплаты, штат и нагрузка» в разделе /vsc «ФОТ».
// ═══════════════════════════════════════════════════════════════════════════
const fs = require("fs");
const path = require("path");

const FILE = path.join(__dirname, ".vscStaffSync.json");
const PBX_FILE = path.join(__dirname, ".vscPbxStats.json");
const AMO_ROSTER_FILE = path.join(__dirname, ".vscAmoRoster.json");
const ZARPLATA_FILE = path.join(__dirname, ".vscZarplata.json");
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

// ── Пересчёт ────────────────────────────────────────────────────────────────
// Держим снимок свежим, чтобы раздел открывался мгновенно. Писем нет: всё, что
// нашлось, показывается в самом разделе.
function check(_unused, why) {
  const cur = compute();
  save(cur);
  console.log("STAFF SYNC [" + (why || "cron") + "]: расхождений " + cur.issues.length
    + "; АТС " + cur.pbx.users + ", amoCRM " + cur.amo.active);
  return cur;
}

// Ежедневно в 09:20 МСК: ночной пересчёт АТС в 01:10 к этому времени уже прошёл.
function schedule() {
  const MSK = 3 * 3600 * 1000, DAY = 86400000;
  (function next() {
    const now = Date.now() + MSK;
    let t = Math.floor(now / DAY) * DAY + (CHECK_HOUR_MSK * 60 + 20) * 60 * 1000;
    if (t <= now) t += DAY;
    setTimeout(() => {
      try { check(null, "cron"); } catch (e) { console.error("staffSync:", e && e.message); }
      next();
    }, Math.max(1000, t - now));
  })();
  // Первый прогон через 8 минут после старта — просто чтобы снимок в разделе был
  // свежим и после перезапуска.
  setTimeout(() => { try { check(null, "startup"); } catch (_) {} }, 8 * 60 * 1000);
  console.log("STAFF SYNC: сверка состава АТС ↔ amoCRM ежедневно в 09:20 МСК (без писем, видно в разделе)");
}

module.exports = { compute, check, schedule, load, save };
