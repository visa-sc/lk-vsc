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
 *   disk  — на диске свободно меньше 4 ГБ или занято больше 90% (с 20.10.2026, план переезда visa-sc.ru);
 *   cpu   — средняя загрузка процессора за 5 минут выше 1,5 × число ядер три проверки подряд (~15 мин).
 * Письмо о проблеме — не чаще раза в 12 часов на одну проблему; когда всё прошло — одно
 * письмо «в норме». В письме — сколько свободно и кто сколько занимает.
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
const DISK_LOW_GB = Number(process.env.MEM_GUARD_DISK_GB || 4);
const DISK_FULL = 0.9;
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
  const df = sh("df -B1 --output=size,avail / | tail -1").split(/\s+/).map(Number);
  const diskTotGb = df[0] / 1e9, diskFreeGb = df[1] / 1e9, diskShare = df[0] ? 1 - df[1] / df[0] : 0;
  const cores = require("os").cpus().length, load5 = require("os").loadavg()[1];
  const cond = {
    disk: diskFreeGb < DISK_LOW_GB || diskShare > DISK_FULL,
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
    `Диск: свободно <b>${diskFreeGb.toFixed(1)} ГБ</b> из ${diskTotGb.toFixed(0)} ГБ (занято ${Math.round(diskShare * 100)}%, порог: меньше ${DISK_LOW_GB} ГБ или больше ${DISK_FULL * 100}%).`,
    `Процессор: загрузка за 5 минут ${load5.toFixed(2)} при ${cores} ядрах (порог ${(cores * CPU_K).toFixed(1)}).`,
    `Файл подкачки: занят ${mb(swapUsed)} из ${mb(swapTot)} МБ (${Math.round(swapShare * 100)}%), обмен сейчас ${Math.round(rate)} стр/с (порог ${SWAP_RATE}).`,
    `<p>Больше всего занимают:</p><pre style="font-size:12px">${topProcs().join("\n")}</pre>`
  ];
  const WHAT = {
    low: `свободной памяти меньше ${LOW_MB} МБ уже 15 минут`,
    swap: "сервер постоянно обращается к файлу подкачки — сайты начинают тормозить",
    swapfull: "файл подкачки почти заполнен",
    oom: `система закрыла процесс из-за нехватки памяти (${newOom} раз за 5 минут)`,
    disk: `на диске мало места: свободно ${diskFreeGb.toFixed(1)} ГБ`,
    cpu: "процессор перегружен уже 15 минут — сайты могут отвечать медленно"
  };
  console.log(new Date().toISOString(), `свободно ${availMb} МБ, диск ${diskFreeGb.toFixed(1)} ГБ, нагрузка ${load5.toFixed(2)}/${cores}, подкачка ${Math.round(swapShare * 100)}% ${Math.round(rate)} стр/с, oom ${ooms}`, active.length ? "ПРОБЛЕМА: " + active.join(",") : "норма");

  if (TEST) {
    await send("Сторож сервера: пробное письмо", ["Сторож памяти, диска и процессора включён. Так будет выглядеть письмо, если ресурсов перестанет хватать.", ...facts]);
    save(st);
    return;
  }
  const fresh = active.filter((k) => !st.alerted[k] || now - st.alerted[k] > REPEAT_MS);
  if (fresh.length) {
    const memIssue = fresh.some((k) => ["low", "swap", "swapfull", "oom"].includes(k));
    const subj = memIssue ? "Сервер: не хватает оперативной памяти — нужно увеличить RAM"
      : fresh.includes("disk") ? "Сервер: заканчивается место на диске" : "Сервер: процессор перегружен";
    const todo = [];
    if (memIssue) todo.push("память — добавить RAM (сейчас " + Math.round(totalMb / 1024) + " ГБ)");
    if (fresh.includes("disk")) todo.push("диск — почистить старые журналы и резервные копии или увеличить диск");
    if (fresh.includes("cpu")) todo.push("процессор — посмотреть, какой процесс грузит (top), при постоянной нагрузке добавить ядро");
    await send(subj, [
      `<b>Что случилось:</b> ${active.map((k) => WHAT[k]).join("; ")}.`,
      ...facts,
      "<b>Что сделать:</b> " + todo.join("; ") + ". Рег.облако → Виртуальные серверы → VOYO (ID 7303919) → карандаш у «Характеристик сервера». Если в панели «Нет доступных тарифов» — заявка в поддержку. Сервер перезагрузится на несколько минут.",
      "Повторю письмо не раньше чем через 12 часов, если проблема останется."
    ]);
    for (const k of fresh) st.alerted[k] = now;
  }
  // «oom» — разовое событие: «в норме» по нему не шлём, отметка лишь сдерживает повтор 12 часов
  const gone = Object.keys(st.alerted).filter((k) => k !== "oom" && !active.includes(k));
  if (gone.length) {
    await send("Сервер: ресурсы снова в норме", [`Прошло: ${gone.map((k) => WHAT[k]).join("; ")}.`, ...facts]);
    for (const k of gone) delete st.alerted[k];
  }
  save(st);
})();
