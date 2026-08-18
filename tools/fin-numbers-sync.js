#!/usr/bin/env node
// ── /fin: агент синхронизации → «Личные финансы.numbers» (мак Андрея) ──────────
// Запускается LaunchAgent'ом (ru.voyo.fin-sync, раз в 2 мин):
//   1) тянет несинкнутые записи с прода: GET /fin/api/pull (ключ x-fin-agent);
//   2) бэкапит файл Numbers (последние 40 копий);
//   3) через AppleScript дописывает записи в лист «<Месяц> <Год>» в группу
//      нужного дня (вставка строк, итоги пересчитываются формулами сами);
//   4) подтверждает POST /fin/api/mark-synced (только реально записанные).
//
// Numbers у Андрея — «Numbers Creator Studio» 15.3.1, bundle id com.apple.Numbers
// (старый Numbers.app 14.5 = com.apple.iWork.Numbers НЕ используем — файл создан
// новой версией). Адресуем строго по bundle id.
//
// Лист нового месяца агент НЕ создаёт (AppleScript Numbers не умеет дублировать
// листы) — если листа нет, записи остаются в очереди, а в лог пишется подсказка.
//
// Конфиг: ~/Library/Application Support/fin-sync/config.json
//   { "server": "https://voyotravel.ru", "agentKey": "...",
//     "numbersPath": "~/Library/Mobile Documents/com~apple~Numbers/Documents/Личные финансы.numbers" }

const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFileSync } = require("child_process");

const APP_DIR = path.join(os.homedir(), "Library", "Application Support", "fin-sync");
const CONFIG_FILE = path.join(APP_DIR, "config.json");
const BACKUP_DIR = path.join(APP_DIR, "backups");
const LOG_FILE = path.join(APP_DIR, "sync.log");
const LOCK_FILE = path.join(APP_DIR, ".lock");
const MAX_BACKUPS = 40;

const MONTHS = ["Январь", "Февраль", "Март", "Апрель", "Май", "Июнь", "Июль", "Август", "Сентябрь", "Октябрь", "Ноябрь", "Декабрь"];
const BUCKET_COL = { pos: 3, ok: 4, nope: 5, trash: 6 };

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  try { fs.appendFileSync(LOG_FILE, line); } catch (_) {}
  process.stdout.write(line);
}

function loadConfig() {
  const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
  cfg.numbersPath = cfg.numbersPath.replace(/^~\//, os.homedir() + "/");
  if (!cfg.server || !cfg.agentKey || !cfg.numbersPath) throw new Error("config.json: нужны server, agentKey, numbersPath");
  return cfg;
}

async function api(cfg, p, opts = {}) {
  opts.headers = Object.assign({ "x-fin-agent": cfg.agentKey, "Content-Type": "application/json" }, opts.headers || {});
  const r = await fetch(cfg.server + p, opts);
  const j = await r.json();
  if (!j.success) throw new Error(`${p}: ${j.message || r.status}`);
  return j;
}

function backup(numbersPath) {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const dst = path.join(BACKUP_DIR, `finances-${stamp}.numbers`);
  fs.copyFileSync(numbersPath, dst);
  const all = fs.readdirSync(BACKUP_DIR).filter((f) => f.endsWith(".numbers")).sort();
  for (const f of all.slice(0, Math.max(0, all.length - MAX_BACKUPS))) fs.unlinkSync(path.join(BACKUP_DIR, f));
}

// AppleScript-литерал строки
function asStr(s) { return '"' + String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"'; }

// Скрипт: для каждой записи найти лист месяца, группу дня, вставить строку.
// Возвращает через return список "ok:<id>" / "skip:<id>:<причина>".
function buildScript(cfg, entries) {
  const docName = path.basename(cfg.numbersPath);
  // Цвет фона ячейки «Наименование»: жёлтый = разобраться, красный = вернуть деньги.
  // AppleScript-цвета в Numbers — RGB 0–65535.
  const FLAG_RGB = { yellow: "{65535, 60395, 26214}", red: "{65535, 40092, 38293}" };
  const items = entries.map((e) => {
    const [y, m, d] = e.date.split("-").map(Number);
    const sheet = `${MONTHS[m - 1]} ${y}`;
    const col = BUCKET_COL[e.bucket] || 4;
    const fullName = e.comment ? `${e.name} - ${e.comment}` : e.name; // комментарий через « - », как в ручных записях
    return `{eid:${asStr(e.id)}, sheetName:${asStr(sheet)}, dayNum:${d}, rowName:${asStr(fullName)}, colIdx:${col}, amt:${e.amount}, cat:${asStr(e.category || "")}, flagRGB:${FLAG_RGB[e.flag] || "{}"}}`;
  });
  return `
set entriesList to {${items.join(", ")}}
set results to {}
with timeout of 180 seconds
tell application id "com.apple.Numbers"
	-- имя открытого документа бывает с расширением и без — ищем оба варианта
	set d to missing value
	repeat with nm in {${asStr(docName)}, ${asStr(docName.replace(/\.numbers$/, ""))}}
		if exists document (nm as text) then
			set d to document (nm as text)
			exit repeat
		end if
	end repeat
	if d is missing value then
		open POSIX file ${asStr(cfg.numbersPath)}
		delay 2
		set d to document 1
	end if
	repeat with e in entriesList
		-- поля записи в простые переменные ДО tell table (терминология Numbers
		-- конфликтует с обращениями к полям записи внутри tell-блока)
		set theId to eid of e
		set theSheet to sheetName of e
		set theDay to dayNum of e
		set theName to rowName of e
		set theCol to colIdx of e
		set theAmt to amt of e
		set theCat to cat of e
		set theRGB to flagRGB of e
		try
			set sh to sheet theSheet of d
		on error
			set end of results to "skip:" & theId & ":нет листа «" & theSheet & "»"
			set sh to missing value
		end try
		if sh is not missing value then
			tell table 1 of sh
				set rc to row count
				set dayVals to value of every cell of column 1
				set bVals to value of every cell of column 2
				-- первая пустая строка данных (итоги — последняя строка, не трогаем)
				set firstEmpty to 0
				repeat with i from 2 to rc - 1
					set bv to item i of bVals
					if bv is missing value or (bv as text) is "" then
						set firstEmpty to i
						exit repeat
					end if
				end repeat
				if firstEmpty is 0 then
					add row above row rc
					set firstEmpty to rc
					set rc to rc + 1
				end if
				-- максимальный день среди заполненных строк
				set maxDay to 0
				repeat with i from 2 to firstEmpty - 1
					set dv to item i of dayVals
					if dv is not missing value then
						try
							set dn to dv as integer
							if dn > maxDay then set maxDay to dn
						end try
					end if
				end repeat
				if theDay is greater than or equal to maxDay then
					set tgt to firstEmpty
					if theDay > maxDay then set value of cell 1 of row tgt to theDay
				else
					-- задним числом: перед первой группой с днём больше theDay
					set nextStart to 0
					set hasD to false
					repeat with i from 2 to firstEmpty - 1
						set dv to item i of dayVals
						if dv is not missing value then
							try
								set dn to dv as integer
								if dn = theDay then set hasD to true
								if dn > theDay and nextStart is 0 then set nextStart to i
							end try
						end if
					end repeat
					if nextStart is 0 then set nextStart to firstEmpty
					add row above row nextStart
					set tgt to nextStart
					if not hasD then set value of cell 1 of row tgt to theDay
				end if
				set value of cell 2 of row tgt to theName
				if theAmt > 0 then set value of cell theCol of row tgt to theAmt
				if theCat is not "" then set value of cell 7 of row tgt to theCat
				if (count of theRGB) is 3 then set background color of cell 2 of row tgt to theRGB
			end tell
			set end of results to "ok:" & theId
		end if
	end repeat
	save d
end tell
end timeout
set text item delimiters to linefeed
return results as text
`;
}

async function main() {
  fs.mkdirSync(APP_DIR, { recursive: true });
  // защита от параллельных запусков
  try {
    const st = fs.statSync(LOCK_FILE);
    if (Date.now() - st.mtimeMs < 10 * 60 * 1000) { log("lock: уже работает, выходим"); return; }
  } catch (_) {}
  fs.writeFileSync(LOCK_FILE, String(process.pid));
  try {
    const cfg = loadConfig();
    const pull = await api(cfg, "/fin/api/pull");
    const entries = pull.entries || [];
    if (!entries.length) return; // тишина — нечего синкать
    log(`к записи: ${entries.length}`);
    if (!fs.existsSync(cfg.numbersPath)) throw new Error("нет файла Numbers: " + cfg.numbersPath);
    backup(cfg.numbersPath);
    // хронологический порядок, чтобы вставки шли сверху вниз
    entries.sort((a, b) => a.date.localeCompare(b.date) || a.at - b.at);
    const script = buildScript(cfg, entries);
    const out = execFileSync("/usr/bin/osascript", ["-e", script], { encoding: "utf8", timeout: 200000 }).trim();
    const okIds = [], skips = [];
    for (const line of out.split("\n")) {
      if (line.startsWith("ok:")) okIds.push(line.slice(3).trim());
      else if (line.startsWith("skip:")) skips.push(line.slice(5).trim());
    }
    for (const s of skips) log("пропуск: " + s + " (создай лист месяца в Numbers — запись подтянется сама)");
    if (okIds.length) {
      await api(cfg, "/fin/api/mark-synced", { method: "POST", body: JSON.stringify({ ids: okIds }) });
      log(`записано в Numbers: ${okIds.length}, подтверждено на сервере`);
    }
  } catch (e) {
    log("ОШИБКА: " + e.message);
    process.exitCode = 1;
  } finally {
    try { fs.unlinkSync(LOCK_FILE); } catch (_) {}
  }
}

main();
