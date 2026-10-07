#!/usr/bin/env node
/* ─────────────────────────────────────────────────────────────────────────────
 * rebootCheck — проверка сервера после перезагрузки (07.10.2026, смена тарифа Рег.облака
 * на 2 vCPU в ночь на 08.10; пригодится и при любой будущей перезагрузке).
 *
 *   node tools/rebootCheck.js --snapshot  — запомнить, что сейчас работает (процессы pm2 всех
 *                                           пользователей, сайты, число ядер и память);
 *   node tools/rebootCheck.js             — сверить с запомненным и написать директору итог.
 * Cron root: «@reboot sleep 180 && cd /var/www/voyo && node tools/rebootCheck.js».
 * Если что-то не поднялось — пробует поднять (pm2 resurrect у этого пользователя, nginx
 * restart) и проверяет ещё раз через минуту; в письме — что было и что сделано.
 * ───────────────────────────────────────────────────────────────────────────── */
"use strict";
const fs = require("fs");
const path = require("path");
const https = require("https");
const { execSync } = require("child_process");
require("dotenv").config({ path: path.join(__dirname, "..", ".env"), quiet: true });

const TO = process.env.REBOOT_CHECK_TO || "director@visa-sc.ru";
const DIR = "/var/lib/reboot-check";
const SNAP = path.join(DIR, "before.json");
const USERS = ["root", "spbadmin", "mskadmin", "ekbadmin", "kateadmin", "olyabi"];
const SITES = ["voyotravel.ru", "voyovoyo.ru", "spb.visa-sc.ru", "msk.voyotravel.ru", "ekb.voyotravel.ru", "work.voyotravel.ru", "crm.voyotravel.ru", "esim.voyotravel.ru",
  "voyomobile.ru", "dev.voyomobile.ru", "ak-co.ru", "visa-sc.com", "vsc.voyotravel.ru", "admin.voyotravel.ru", "vo-yo.ru"];
const sh = (c) => { try { return execSync(c, { encoding: "utf8", timeout: 60000, stdio: ["ignore", "pipe", "pipe"] }).trim(); } catch (e) { return String(e.stdout || "").trim(); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function pm2Apps() {
  const out = {};
  for (const u of USERS) {
    const raw = u === "root" ? sh("pm2 jlist") : sh(`sudo -u ${u} -H pm2 jlist`);
    try { out[u] = JSON.parse(raw.slice(raw.indexOf("["))).map((p) => ({ name: p.name, status: p.pm2_env.status })); } catch (_) { out[u] = []; }
  }
  return out;
}
const site = (host) => new Promise((r) => {
  const q = https.get({ host: "127.0.0.1", servername: host, path: "/", headers: { Host: host, "User-Agent": "reboot-check", "X-Spbcopy-Check": "1" }, timeout: 20000, rejectUnauthorized: false }, (s) => { s.resume(); r(s.statusCode); });
  q.on("error", () => r(0)); q.on("timeout", () => q.destroy());
});
async function state() {
  const sites = {};
  for (const h of SITES) sites[h] = await site(h);
  return { at: new Date().toISOString(), cpus: Number(sh("nproc")), memMb: Math.round(Number(sh("awk '/MemTotal/{print $2}' /proc/meminfo")) / 1024), pm2: pm2Apps(), sites, nginx: sh("systemctl is-active nginx") };
}
function problems(before, now) {
  const p = [];
  if (now.nginx !== "active") p.push("nginx не запущен");
  for (const u of USERS) for (const a of before.pm2[u] || []) {
    if (a.status !== "online") continue;
    const n = (now.pm2[u] || []).find((x) => x.name === a.name);
    if (!n || n.status !== "online") p.push(`процесс ${a.name} (${u}) — ${n ? n.status : "нет"}`);
  }
  for (const [h, code] of Object.entries(before.sites)) {
    const ok = (c) => c >= 200 && c < 500;
    if (ok(code) && !ok(now.sites[h])) p.push(`сайт ${h} отвечает ${now.sites[h] || "нет ответа"}`);
  }
  return p;
}

(async () => {
  fs.mkdirSync(DIR, { recursive: true });
  if (process.argv.includes("--snapshot")) {
    const s = await state();
    fs.writeFileSync(SNAP, JSON.stringify(s, null, 1));
    const n = Object.values(s.pm2).reduce((a, l) => a + l.filter((x) => x.status === "online").length, 0);
    console.log(`снимок: ядер ${s.cpus}, памяти ${s.memMb} МБ, процессов online ${n}, сайты ${JSON.stringify(s.sites)}`);
    return;
  }
  if (!fs.existsSync(SNAP)) return console.log("нет снимка — сначала --snapshot");
  const before = JSON.parse(fs.readFileSync(SNAP, "utf8"));
  let now = await state(), p = problems(before, now);
  const fixed = [];
  if (p.length) {
    if (now.nginx !== "active") { sh("systemctl restart nginx"); fixed.push("перезапущен nginx"); }
    for (const u of USERS) if (p.some((x) => x.includes(`(${u})`))) { sh(u === "root" ? "pm2 resurrect" : `sudo -u ${u} -H pm2 resurrect`); fixed.push(`pm2 resurrect у ${u}`); }
    await sleep(60000);
    now = await state(); p = problems(before, now);
  }
  // выдача eSIM идёт в памяти процесса — перезагрузка посреди неё оставляет заказ «fulfilling»
  try {
    const orders = JSON.parse(fs.readFileSync(path.join(__dirname, "..", ".esim", "orders.json"), "utf8"));
    const stuck = (Array.isArray(orders) ? orders : Object.values(orders)).filter((o) => o && o.status === "fulfilling");
    if (stuck.length) p.push(`eSIM: заказов, оборванных посреди выдачи, — ${stuck.length} (${stuck.map((o) => o.id).join(", ")}); достроить через /esim/api/adm/recover, не покупать повторно`);
  } catch (_) {}
  const upMin = Math.round(Number(sh("awk '{print $1}' /proc/uptime")) / 60);
  const nOnline = Object.values(now.pm2).reduce((a, l) => a + l.filter((x) => x.status === "online").length, 0);
  const lines = [
    p.length ? `<b>После перезагрузки есть проблемы (${p.length}):</b><br>${p.join("<br>")}` : "<b>Сервер перезагрузился, всё поднялось.</b>",
    `Ядер: <b>${now.cpus}</b> (было ${before.cpus}), память ${now.memMb} МБ (было ${before.memMb}). Сервер работает ${upMin} мин.`,
    `Процессов работает: ${nOnline}. Сайты: ${Object.entries(now.sites).map(([h, c]) => `${h} ${c}`).join(", ")}.`,
    fixed.length ? `Что сделал сам: ${fixed.join(", ")}.` : ""
  ].filter(Boolean);
  console.log(lines.join("\n").replace(/<[^>]+>/g, ""));
  const { sendMail } = require("../mail.js");
  const r = await sendMail({ to: TO, subject: p.length ? "Сервер после перезагрузки: есть проблемы" : `Сервер после перезагрузки: всё работает, ядер ${now.cpus}`, html: `<div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.5">${lines.map((l) => `<p>${l}</p>`).join("")}</div>` });
  console.log("письмо:", JSON.stringify(r));
})();
