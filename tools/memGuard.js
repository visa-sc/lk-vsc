#!/usr/bin/env node
/* ─────────────────────────────────────────────────────────────────────────────
 * memGuard — сторож оперативной памяти сервера 89.108.88.59 (просьба Андрея 07.10.2026,
 * перед переносом visa-sc.ru): если памяти перестаёт хватать — письмо Андрею, чтобы
 * сразу увеличить RAM в Рег.облаке (сервер VOYO, ID 7303919).
 *
 * Каждые 5 минут (cron от root) смотрит:
 *   low   — свободной памяти (MemAvailable) меньше 500 МБ три проверки подряд (~15 мин);
 *   swap  — сервер постоянно гоняет файл подкачки: больше 100 страниц/с туда-обратно
 *           (≈0,4 МБ/с) три проверки подряд;
 *   swapfull — подкачка занята больше чем на 85% И при этом свободно меньше 800 МБ или идёт обмен;
 *   oom   — система убила процесс из-за нехватки памяти (сразу, без ожидания);
 *   disk  — с 05.11.2026 считается ОБЩЕЕ свободное место на основном диске (/, 40 ГБ) и сетевом
 *           (/mnt/data, 50 ГБ, там резервные копии Кати): меньше 10 ГБ — одно письмо, меньше 8 ГБ —
 *           письмо каждый день, пока не освободят. Отдельно: на основном диске меньше 3 ГБ — тоже
 *           каждый день (сайты падают при полном /, сетевой диск их не спасёт);
 *   cpu   — средняя загрузка процессора за 5 минут выше 1,5 × число ядер три проверки подряд (~15 мин).
 * Письмо о проблеме — не чаще раза в 12 часов на одну проблему; когда всё прошло — одно
 * письмо «в норме». В письме — сколько свободно и кто сколько занимает.
 * Про диск (с 05.11.2026, просьба Андрея) — ещё и строкой в комнату «Помощники» чата Кати.
 * Состояние — /var/lib/mem-guard/state.json.
 *
 * Запуск: node tools/memGuard.js [--dry] [--test]   (--test — пробное письмо)
 * ───────────────────────────────────────────────────────────────────────────── */
"use strict";
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
require("dotenv").config({ path: path.join(__dirname, "..", ".env"), quiet: true });

const DRY = process.argv.includes("--dry");
const TEST = process.argv.includes("--test");
// С 20.10.2026 письмо дублируется Андрею Петрову (просьба Андрея: при упоре в потолок по
// памяти или диску знать должны оба).
const TO = process.env.MEM_GUARD_TO || "director@visa-sc.ru, ap@spt1.ru";
const STATE_DIR = "/var/lib/mem-guard";
const STATE = path.join(STATE_DIR, "state.json");
const LOW_MB = Number(process.env.MEM_GUARD_LOW_MB || 500);
const SWAP_RATE = Number(process.env.MEM_GUARD_SWAP_RATE || 100); // страниц в секунду
const SWAP_FULL = 0.85;
const SWAP_FULL_LOW_MB = 800;
const DISK_WARN_GB = Number(process.env.MEM_GUARD_DISK_WARN_GB || 10); // общий остаток: одно письмо
const DISK_DAILY_GB = Number(process.env.MEM_GUARD_DISK_DAILY_GB || 8); // общий остаток: письмо каждый день
const ROOT_MIN_GB = Number(process.env.MEM_GUARD_ROOT_MIN_GB || 3);     // основной диск отдельно
// Диск копий /mnt/data с 13.11.2026 — 20 ГБ (был 50): свои пороги, общие 10/8 на нём не сработают
const DATA_WARN_GB = Number(process.env.MEM_GUARD_DATA_WARN_GB || 4);   // одно письмо
const DATA_DAILY_GB = Number(process.env.MEM_GUARD_DATA_DAILY_GB || 3); // каждый день
const DISKS = ["/", "/mnt/data"];
const DAY_MS = 24 * 3600 * 1000;
const CPU_K = 1.5; // загрузка (loadavg 5 мин) на ядро
const STREAK = 3;
const REPEAT_MS = 12 * 3600 * 1000;

const sh = (c) => { try { return execSync(c, { encoding: "utf8", timeout: 20000, stdio: ["ignore", "pipe", "pipe"] }).trim(); } catch (e) { return String(e.stdout || ""); } };
const meminfo = () => Object.fromEntries(fs.readFileSync("/proc/meminfo", "utf8").split("\n").filter(Boolean).map((l) => { const [k, v] = l.split(":"); return [k, parseInt(v, 10)]; }));
const vmstat = () => Object.fromEntries(fs.readFileSync("/proc/vmstat", "utf8").split("\n").filter(Boolean).map((l) => l.split(" ")).map(([k, v]) => [k, Number(v)]));
const mb = (kb) => Math.round(kb / 1024);
const load = () => { try { return JSON.parse(fs.readFileSync(STATE, "utf8")); } catch (_) { return { streak: {}, alerted: {} }; } };
const save = (s) => { if (DRY) return; fs.mkdirSync(STATE_DIR, { recursive: true }); fs.writeFileSync(STATE, JSON.stringify(s, null, 1)); };

function topProcs() {
  const out = sh("ps -eo rss,args --sort=-rss | head -9 | tail -8");
  return out.split("\n").map((l) => { const m = l.trim().match(/^(\d+)\s+(.*)$/); return m ? `${String(mb(+m[1])).padStart(5)} МБ  ${m[2].slice(0, 70)}` : ""; }).filter(Boolean);
}

async function send(subject, lines) {
  const html = `<div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.5">${lines.map((l) => (l.startsWith("<") ? l : `<p>${l}</p>`)).join("")}</div>`;
  if (DRY) { console.log("[dry] письмо:", subject, "\n" + lines.join("\n")); return; }
  const { sendMail } = require("../mail.js");
  const r = await sendMail({ to: TO, subject, html });
  console.log(new Date().toISOString(), "письмо:", subject, JSON.stringify(r));
}

// Комната «Помощники» (gmvcc6iz9pmsc) в чате work.voyotravel.ru: пишем от kateadmin через её
// claude-say.js, чтобы файлы чата остались её. Сбой чата не мешает письму.
const CHAT_ROOM = process.env.MEM_GUARD_CHAT_ROOM || "gmvcc6iz9pmsc";
function chatSay(text, key) {
  if (DRY) { console.log("[dry] в Помощники:", text); return; }
  try {
    const tmp = path.join(require("os").tmpdir(), "mem-guard-chat-" + process.pid + ".txt");
    fs.writeFileSync(tmp, text, { mode: 0o644 });
    execSync("runuser -u kateadmin -- node /var/www/kateadmin/claude-say.js " + tmp + " " + CHAT_ROOM + " " + key, { timeout: 30000, stdio: "ignore" });
    fs.unlinkSync(tmp);
  } catch (e) { console.log("чат: не отправлено —", e.message); }
}
const diskLine = (disks, total) => `свободно ${total.toFixed(1)} ГБ на двух дисках (` +
  disks.map((d) => `${d.m === "/" ? "основной" : "сетевой"} ${d.freeGb.toFixed(1)} из ${d.totGb.toFixed(0)}`).join(", ") + ")";

(async () => {
  const st = load();
  const now = Date.now();
  const mi = meminfo(), vm = vmstat();
  const availMb = mb(mi.MemAvailable), totalMb = mb(mi.MemTotal);
  const swapTot = mi.SwapTotal || 0, swapUsed = swapTot - (mi.SwapFree || 0);
  const swapShare = swapTot ? swapUsed / swapTot : 0;
  // подкачка: страниц/с с прошлой проверки
  let rate = 0;
  if (st.prev && now > st.prev.t) rate = (vm.pswpin + vm.pswpout - st.prev.sw) / ((now - st.prev.t) / 1000);
  st.prev = { t: now, sw: vm.pswpin + vm.pswpout };
  // убийства из-за нехватки памяти с прошлой проверки
  const ooms = vm.oom_kill || 0;
  const newOom = st.oomSeen !== undefined && ooms > st.oomSeen ? ooms - st.oomSeen : 0;
  st.oomSeen = ooms;

  // диск и процессор (20.10.2026: «мониторинг RAM, диск, CPU с письмом Петрову»)
  // смонтирован ли сетевой диск: иначе df покажет основной под его именем
  const disks = DISKS.filter((m) => m === "/" || sh("findmnt -n -o TARGET " + m) === m).map((m) => {
    const [size, avail] = sh("df -B1 --output=size,avail " + m + " | tail -1").split(/\s+/).map(Number);
    return { m, totGb: size / 2 ** 30, freeGb: avail / 2 ** 30 }; // ГБ как в панели Рег.облака
  });
  const diskFreeGb = disks.reduce((a, d) => a + d.freeGb, 0), diskTotGb = disks.reduce((a, d) => a + d.totGb, 0);
  const rootFreeGb = disks[0].freeGb;
  const dataMissing = disks.length < DISKS.length;
  const dataFreeGb = dataMissing ? Infinity : disks[1].freeGb;
  // уровень: 0 норма, 1 «меньше 10» (одно письмо), 2 «меньше 8» или мало на основном (каждый день);
  // выход из тревоги — с запасом 1 ГБ, чтобы не слать «в норме / снова мало» каждые 5 минут
  const pad = st.alerted.disk ? 1 : 0;
  const diskLevel = diskFreeGb < DISK_DAILY_GB + pad || rootFreeGb < ROOT_MIN_GB + pad || dataFreeGb < DATA_DAILY_GB + pad ? 2
    : diskFreeGb < DISK_WARN_GB + pad || dataFreeGb < DATA_WARN_GB + pad ? 1 : 0;
  const cores = require("os").cpus().length, load5 = require("os").loadavg()[1];
  const cond = {
    disk: diskLevel > 0 || dataMissing,
    cpu: load5 > cores * CPU_K,
    low: availMb < LOW_MB,
    swap: rate > SWAP_RATE,
    // заполненная подкачка сама по себе не беда: Linux выносит туда давно не нужное и при
    // свободной памяти; тревожно, только если вместе с ней мало памяти или идёт обмен (09.10.2026)
    swapfull: swapShare > SWAP_FULL && (availMb < SWAP_FULL_LOW_MB || rate > SWAP_RATE / 4)
  };
  for (const k of Object.keys(cond)) st.streak[k] = cond[k] ? (st.streak[k] || 0) + 1 : 0;
  const active = Object.keys(cond).filter((k) => st.streak[k] >= (k === "disk" ? 1 : STREAK));
  if (newOom) active.push("oom");

  const facts = [
    `Свободно памяти: <b>${availMb} МБ</b> из ${totalMb} МБ (порог ${LOW_MB} МБ).`,
    `Диски вместе: свободно <b>${diskFreeGb.toFixed(1)} ГБ</b> из ${diskTotGb.toFixed(0)} ГБ (пороги: меньше ${DISK_WARN_GB} ГБ — письмо, меньше ${DISK_DAILY_GB} ГБ — каждый день; на диске копий отдельно ${DATA_WARN_GB} и ${DATA_DAILY_GB} ГБ). ` +
      disks.map((d) => `${d.m === "/" ? "основной" : "сетевой " + d.m}: свободно ${d.freeGb.toFixed(1)} из ${d.totGb.toFixed(0)} ГБ`).join("; ") +
      (dataMissing ? "; <b>сетевой диск /mnt/data не подключён</b>" : "") + ".",
    `Процессор: загрузка за 5 минут ${load5.toFixed(2)} при ${cores} ядрах (порог ${(cores * CPU_K).toFixed(1)}).`,
    `Файл подкачки: занят ${mb(swapUsed)} из ${mb(swapTot)} МБ (${Math.round(swapShare * 100)}%), обмен сейчас ${Math.round(rate)} стр/с (порог ${SWAP_RATE}).`,
    `<p>Больше всего занимают:</p><pre style="font-size:12px">${topProcs().join("\n")}</pre>`
  ];
  const WHAT = {
    low: `свободной памяти меньше ${LOW_MB} МБ уже 15 минут`,
    swap: "сервер постоянно обращается к файлу подкачки — сайты начинают тормозить",
    swapfull: "файл подкачки почти заполнен",
    oom: `система закрыла процесс из-за нехватки памяти (${newOom} раз за 5 минут)`,
    disk: dataMissing && !diskLevel ? "сетевой диск /mnt/data не подключён — резервные копии Кати пишутся на основной диск"
      : rootFreeGb < ROOT_MIN_GB ? `на основном диске осталось ${rootFreeGb.toFixed(1)} ГБ — сайты могут остановиться`
      : dataFreeGb < DATA_WARN_GB ? `на диске резервных копий /mnt/data осталось ${dataFreeGb.toFixed(1)} ГБ`
      : `на дисках мало места: свободно ${diskFreeGb.toFixed(1)} ГБ на двоих`,
    cpu: "процессор перегружен уже 15 минут — сайты могут отвечать медленно"
  };
  console.log(new Date().toISOString(), `свободно ${availMb} МБ, диск ${diskFreeGb.toFixed(1)} ГБ, нагрузка ${load5.toFixed(2)}/${cores}, подкачка ${Math.round(swapShare * 100)}% ${Math.round(rate)} стр/с, oom ${ooms}`, active.length ? "ПРОБЛЕМА: " + active.join(",") : "норма");

  if (TEST) {
    await send("Сторож сервера: пробное письмо", ["Сторож памяти, диска и процессора включён. Так будет выглядеть письмо, если ресурсов перестанет хватать.", ...facts]);
    save(st);
    return;
  }
  // диск: при «меньше 10» — одно письмо, при «меньше 8» — раз в сутки, переход 1→2 — сразу
  const repeatMs = (k) => k !== "disk" ? REPEAT_MS : diskLevel >= 2 ? DAY_MS : Infinity;
  const fresh = active.filter((k) => !st.alerted[k] || now - st.alerted[k] > repeatMs(k) || (k === "disk" && diskLevel > (st.diskLevel || 0)));
  if (fresh.length) {
    const memIssue = fresh.some((k) => ["low", "swap", "swapfull", "oom"].includes(k));
    const subj = memIssue ? "Сервер: не хватает оперативной памяти — нужно увеличить RAM"
      : fresh.includes("disk") ? "Сервер: заканчивается место на диске" : "Сервер: процессор перегружен";
    const todo = [];
    if (memIssue) todo.push("память — добавить RAM (сейчас " + Math.round(totalMb / 1024) + " ГБ)");
    if (fresh.includes("disk")) todo.push(`диск — почистить старые журналы и резервные копии (Катины — /mnt/data/kate-backup-daily) или увеличить сетевой диск: Рег.облако → Сетевые диски → диск сервера VOYO, размер увеличивается без перезагрузки, затем resize2fs ${sh("findmnt -n -o SOURCE /mnt/data") || "/dev/sdc"}`);
    if (fresh.includes("cpu")) todo.push("процессор — посмотреть, какой процесс грузит (top), при постоянной нагрузке добавить ядро");
    await send(subj, [
      `<b>Что случилось:</b> ${active.map((k) => WHAT[k]).join("; ")}.`,
      ...facts,
      "<b>Что сделать:</b> " + todo.join("; ") + "." + (memIssue || fresh.includes("cpu") ? " Рег.облако → Виртуальные серверы → VOYO (ID 7303919) → карандаш у «Характеристик сервера». Если в панели «Нет доступных тарифов» — заявка в поддержку. Сервер перезагрузится на несколько минут." : ""),
      fresh.length === 1 && fresh[0] === "disk" ? (diskLevel >= 2 ? "Пока места не прибавится, письмо будет приходить раз в сутки." : "Если места станет ещё меньше — буду писать каждый день.")
        : "Повторю письмо не раньше чем через 12 часов, если проблема останется."
    ]);
    if (fresh.includes("disk")) chatSay("Сторож сервера: " + WHAT.disk + ". Сейчас " + diskLine(disks, diskFreeGb) + ". " +
      (diskLevel >= 2 ? "Пока не освободят, напомню раз в сутки." : "Если места станет ещё меньше — буду писать каждый день.") +
      " Резервные копии Кати — /mnt/data/kate-backup-daily.", "memguard-disk-" + now);
    for (const k of fresh) st.alerted[k] = now;
    if (fresh.includes("disk")) st.diskLevel = diskLevel;
  }
  // «oom» — разовое событие: «в норме» по нему не шлём, отметка лишь сдерживает повтор 12 часов
  const gone = Object.keys(st.alerted).filter((k) => k !== "oom" && !active.includes(k));
  if (gone.length) {
    await send("Сервер: ресурсы снова в норме", [`Прошло: ${gone.map((k) => WHAT[k]).join("; ")}.`, ...facts]);
    for (const k of gone) delete st.alerted[k];
    if (gone.includes("disk")) { st.diskLevel = 0; chatSay("Сторож сервера: место на дисках снова в норме — " + diskLine(disks, diskFreeGb) + ".", "memguard-diskok-" + now); }
  }
  save(st);
})();
