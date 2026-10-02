#!/usr/bin/env node
/* ─────────────────────────────────────────────────────────────────────────────
 * spbGuard — сторож и «первая линия» питерского сайта spb.visa-sc.ru (просьба
 * Андрея 02.10.2026, по образцу eSIM): каждые 2 минуты проверяет всё, что
 * может сломаться, сам чинит то, что можно починить, и пишет Андрею Петрову
 * (без копии — решение Андрея 02.10.2026), что случилось и как исправлено.
 *
 * Что проверяем и что делаем сами:
 *   site     — сайт отвечает (локально и снаружи по https)  → перезапуск spbcopy, nginx reload
 *   metrika  — в странице стоит Метрика и её очередь ym     → только письмо (нужна правка кода)
 *   cert     — сертификат https живёт > 14 дней              → certbot renew
 *   amo      — процесс выгрузки spb-amo на месте            → перезапуск spb-amo
 *   leads    — нет заявок, зависших без сделки > 10 минут    → перезапуск spb-amo, потом письмо
 *   numbers  — питерские номера зарегистрированы в АТС       → только письмо (сбой у оператора)
 *   forms    — нет сбоев отправки форм за последние 30 мин   → только письмо с подробностями
 *   disk     — диск сервера занят меньше 92%                 → только письмо
 * Письмо о проблеме — не чаще раза в час на одну проблему; когда проблема ушла —
 * одно письмо «исправлено». Состояние — /var/lib/spb-guard/state.json.
 *
 * Запуск: node tools/spbGuard.js [--dry] (cron каждые 2 минуты от root). Живой amoCRM не трогает.
 * ───────────────────────────────────────────────────────────────────────────── */
"use strict";
const fs = require("fs");
const path = require("path");
const https = require("https");
const http = require("http");
const { execSync } = require("child_process");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const DRY = process.argv.includes("--dry");
const TO = process.env.SPB_GUARD_TO || "ap@spt1.ru";
// Андрей 02.10.2026: о проблемах пишем только Петрову, без копии.
const CC = process.env.SPB_GUARD_CC || "";
const STATE_DIR = "/var/lib/spb-guard";
const STATE = path.join(STATE_DIR, "state.json");
const SPB = "/var/www/spbcopy";
const SPB_NUMBERS = ["78122440468", "78122200365", "78124673878", "78122373387", "78122408545", "78122443427"];
const tail10 = (s) => String(s || "").replace(/\D/g, "").slice(-10);

const sh = (c, t = 60000) => {
  try {
    return execSync(c, { encoding: "utf8", timeout: t, stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch (e) {
    return "ERR " + String(e.stdout || e.message).slice(0, 300);
  }
};
const get = (opts, mod = http) =>
  new Promise((resolve) => {
    const req = mod.get({ timeout: 15000, ...opts }, (res) => {
      let d = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (d.length < 600000 ? (d += c) : null));
      res.on("end", () => resolve({ status: res.statusCode, body: d, cert: res.socket && res.socket.getPeerCertificate && res.socket.getPeerCertificate() }));
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", (e) => resolve({ status: 0, body: "", err: e.message }));
  });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const local = () => get({ host: "127.0.0.1", port: 3006, path: "/italy/", headers: { Host: "spb.visa-sc.ru", "X-Spbcopy-Check": "1" } });
const pub = () => get({ host: "127.0.0.1", port: 443, path: "/italy/", servername: "spb.visa-sc.ru", headers: { Host: "spb.visa-sc.ru", "X-Spbcopy-Check": "1" }, rejectUnauthorized: true }, https);
const pm2Status = (name, user) => {
  const out = sh(user ? `su - ${user} -c 'pm2 jlist'` : "pm2 jlist");
  try {
    const p = JSON.parse(out.slice(out.indexOf("["))).find((x) => x.name === name);
    return p ? p.pm2_env.status : "нет процесса";
  } catch (_) {
    return "не прочитать";
  }
};

(async () => {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  let state = {};
  try {
    state = JSON.parse(fs.readFileSync(STATE, "utf8"));
  } catch (_) {}
  const now = Date.now();
  const issues = {}; // key → { what, did, fixed }

  // ── сайт ──────────────────────────────────────────────────────────────────
  let r = await local();
  if (r.status !== 200) {
    await sleep(5000);
    r = await local();
  }
  if (r.status !== 200) {
    const did = DRY ? "(пробный заход — не перезапускал)" : (sh("su - spbadmin -c 'pm2 restart spbcopy'"), "перезапустил сервис сайта spbcopy");
    await sleep(8000);
    const r2 = await local();
    issues.site = { what: `сайт не отвечал (код ${r.status || r.err})`, did, fixed: r2.status === 200 };
  } else {
    const p = await pub();
    if (p.status !== 200) {
      const did = DRY ? "(пробный заход)" : (sh("nginx -t && systemctl reload nginx"), "проверил и перезагрузил nginx");
      await sleep(3000);
      const p2 = await pub();
      issues.site = { what: `сайт не открывался снаружи по https (код ${p.status || p.err})`, did, fixed: p2.status === 200 };
    } else {
      // Метрика: счётчик и очередь ym на месте (поймано 02.10 — пустая заглушка ym глушила Метрику)
      const okM = /ym\(95230258|metrika\.95230258|mc\.yandex\.ru\/metrika/.test(p.body) && /window\.ym\.a=window\.ym\.a\|\|\[\]/.test(p.body);
      if (!okM) issues.metrika = { what: "на странице нет счётчика Метрики 95230258 или сломана очередь ym — визиты в Метрику не считаются", did: "автоматически не чинится — нужна правка страниц", fixed: false };
      // сертификат
      const exp = p.cert && p.cert.valid_to ? Date.parse(p.cert.valid_to) : 0;
      const days = exp ? Math.floor((exp - now) / 864e5) : -1;
      if (days >= 0 && days < 14) {
        const did = DRY ? "(пробный заход)" : (sh("certbot renew --quiet && systemctl reload nginx", 180000), "запустил продление сертификата (certbot renew)");
        const p2 = await pub();
        const e2 = p2.cert && p2.cert.valid_to ? Math.floor((Date.parse(p2.cert.valid_to) - now) / 864e5) : days;
        issues.cert = { what: `сертификат https истекает через ${days} дн.`, did, fixed: e2 >= 14 };
      }
    }
  }

  // ── выгрузка заявок в amo ─────────────────────────────────────────────────
  const amoSt = pm2Status("spb-amo");
  if (amoSt !== "online" && amoSt !== "не прочитать") {
    const did = DRY ? "(пробный заход)" : (sh("pm2 restart spb-amo"), "перезапустил выгрузку spb-amo");
    await sleep(5000);
    issues.amo = { what: `выгрузка заявок в amoCRM остановилась (${amoSt})`, did, fixed: pm2Status("spb-amo") === "online" };
  }
  try {
    const leads = JSON.parse(fs.readFileSync(path.join(SPB, "leads.json"), "utf8"));
    const stuck = leads.filter(
      (e) => /^(www\.)?spb\.visa-sc\.ru$/i.test(e.host || "") && !e.amo && (e.data && (e.data.fields || []).some((f) => String(f.value || "").trim())) && now - Date.parse(e.at) > 10 * 60e3 && now - Date.parse(e.at) < 3 * 864e5
    );
    if (stuck.length) {
      const prev = state.leads && state.leads.healedAt;
      let did = "автоматически не чинится";
      if (!prev || now - prev > 30 * 60e3) {
        did = DRY ? "(пробный заход)" : (sh("pm2 restart spb-amo"), "перезапустил выгрузку spb-amo — заявки уйдут в amo в течение минуты");
        state.leads = { ...(state.leads || {}), healedAt: now };
      }
      issues.leads = {
        what: `${stuck.length} заявк(и) с сайта больше 10 минут не дошли до amoCRM: ` + stuck.slice(0, 10).map((e) => `№${e.id} (${new Date(Date.parse(e.at) + 3 * 3600e3).toISOString().slice(11, 16)}, ${e.page || ""})`).join(", "),
        did,
        fixed: false
      };
    }
  } catch (e) {
    issues.leads = { what: "не читается журнал заявок: " + e.message, did: "автоматически не чинится", fixed: false };
  }

  // ── номера в АТС ──────────────────────────────────────────────────────────
  try {
    const st = JSON.parse(fs.readFileSync(path.join(__dirname, "..", ".phonetest", "store.json"), "utf8"));
    // Номера время от времени перерегистрируются в АТС за пару минут — это норма, о ней не пишем
    // (Андрей 02.10.2026). Тревога — только если номер не на связи 11 минут и дольше: считаем
    // от первого опроса АТС подряд, где он был «не на связи» (опрос раз в 10 минут).
    const polls = (st.trunkLog || []).filter((x) => !x.error).sort((a, b) => b.at - a.at);
    const last = polls[0];
    if (last && now - last.at < 40 * 60e3) {
      const spbSet = new Set(SPB_NUMBERS.map(tail10));
      const downSince = (num) => {
        let since = null;
        for (const p of polls) {
          if ((p.down || []).some((t) => tail10(t.number) === num)) since = p.at;
          else break;
        }
        return since;
      };
      const down = (last.down || []).filter((t) => {
        if (!spbSet.has(tail10(t.number))) return false;
        const since = downSince(tail10(t.number));
        return since != null && now - since >= 11 * 60e3;
      });
      if (down.length)
        issues.numbers = {
          what: "питерские номера не на связи в АТС дольше 11 минут (звонки на них не проходят): " + down.map((t) => "+" + t.number + (t.name ? " (" + t.name + ")" : "") + " — " + t.status + ", с " + new Date(downSince(tail10(t.number)) + 3 * 3600e3).toISOString().slice(11, 16) + " МСК").join(", "),
          did: "автоматически не чинится: регистрация линии — на стороне оператора/АТС; проверьте OnlinePBX → Номера",
          fixed: false
        };
    }
  } catch (_) {}

  // ── сбои отправки форм ────────────────────────────────────────────────────
  try {
    const f = path.join(SPB, "stat", `events-${new Date(now).toISOString().slice(0, 7)}.jsonl`);
    const errs = fs
      .readFileSync(f, "utf8")
      .split("\n")
      .filter((l) => l.includes('"form_error"'))
      .map((l) => JSON.parse(l))
      .filter((e) => now - Date.parse(e.at) < 30 * 60e3);
    if (errs.length)
      issues.forms = {
        what: `${errs.length} сбо(я) отправки формы за 30 минут: ` + errs.slice(0, 8).map((e) => `${new Date(Date.parse(e.at) + 3 * 3600e3).toISOString().slice(11, 16)} ${e.page} — ${e.value}`).join("; "),
        did: "автоматически не чинится; подробности — /vsc → Ежемесячный контроль → «Формы заявок — СПБ»",
        fixed: false
      };
  } catch (_) {}

  // ── диск ──────────────────────────────────────────────────────────────────
  const disk = Number(sh("df --output=pcent / | tail -1").replace(/\D/g, "")) || 0;
  if (disk >= 92) issues.disk = { what: `диск сервера заполнен на ${disk}%`, did: "автоматически не чинится", fixed: false };

  // ── письма ────────────────────────────────────────────────────────────────
  const { sendMail } = require(path.join(__dirname, "..", "mail.js"));
  const send = async (subject, lines) => {
    const html = `<div style="font:15px/1.5 -apple-system,Segoe UI,Roboto,Arial,sans-serif">${lines.map((l) => `<p style="margin:6px 0">${l}</p>`).join("")}<p style="color:#888;font-size:12px">Сторож spb.visa-sc.ru (tools/spbGuard.js), проверка каждые 2 минуты.</p></div>`;
    if (DRY) return console.log("[письмо]", subject, lines.join(" | "));
    await sendMail(CC ? { to: TO, cc: CC, subject, html } : { to: TO, subject, html });
  };
  const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;");
  for (const [k, v] of Object.entries(issues)) {
    const s = (state[k] = state[k] || {});
    if (v.fixed) {
      await send(`spb.visa-sc.ru: был сбой — исправлено автоматически`, [`<b>Что было:</b> ${esc(v.what)}`, `<b>Что сделал:</b> ${esc(v.did)}`, `<b>Итог:</b> ✅ работает`]);
      state[k] = { lastFixedAt: now };
      continue;
    }
    if (!s.since) s.since = now;
    if (!s.notifiedAt || now - s.notifiedAt > 60 * 60e3) {
      await send(`⚠️ spb.visa-sc.ru: ${v.what.slice(0, 70)}`, [`<b>Проблема:</b> ${esc(v.what)}`, `<b>Что сделал:</b> ${esc(v.did)}`, `<b>Итог:</b> пока не исправлено — проверю снова через 2 минуты`]);
      s.notifiedAt = now;
    }
  }
  // проблемы, которые ушли сами или после починки
  for (const k of Object.keys(state)) {
    if (issues[k] || !state[k].since) continue;
    if (state[k].notifiedAt) await send(`spb.visa-sc.ru: исправлено`, [`<b>Проблема «${esc(k)}» больше не наблюдается</b> (была с ${new Date(state[k].since + 3 * 3600e3).toISOString().slice(0, 16).replace("T", " ")} МСК).`]);
    delete state[k];
  }
  if (!DRY) fs.writeFileSync(STATE, JSON.stringify(state));
  console.log(new Date().toISOString(), Object.keys(issues).length ? "проблемы: " + Object.keys(issues).join(", ") : "всё в порядке");
})().catch((e) => console.log("сторож упал:", e.message));
