#!/usr/bin/env node
// Расход Я.Директа на eSIM — сам, каждые сутки (Андрей, 15.10.2026).
//
// Берёт из Reports API все кампании, в названии которых есть eSIM / есим
// (например «Регионы - ДРР - Esim - Поиск»), суммирует расход с НДС по дням
// и кладёт в расходы панели eSIM (.esim/adspend.json) каналом «yandex»:
// одна запись на день, id «yd-ГГГГ-ММ-ДД», повторный съём её перезаписывает.
// Так расход попадает и в канал «Яндекс Директ», и в общий итог панели.
//
// Ручные записи по 15.10 включительно уже внесены (итог по 21.09 и ДРР 347 ₽),
// поэтому автоматом берём дни с ESIM_YD_FROM (по умолчанию 2026-10-16).
// Окно — 10 последних закрытых дней: Директ уточняет расход задним числом.
//
// Крон: каждый час в :25; если вчерашний день уже снят сегодня — выходит сразу.
// API Директа бывает недоступен (с 12.10.2026 отвечал пустым 204) — тогда
// просто пишет ошибку в .esim/yd-esim-spend.json и пробует через час.
//
//   node tools/esimYdSpend.js          — обычный прогон
//   node tools/esimYdSpend.js --force  — снять заново, даже если сегодня уже снимали
//   node tools/esimYdSpend.js --dry    — показать, что запишет, ничего не меняя
"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const ROOT = path.join(__dirname, "..");
require("dotenv").config({ path: path.join(ROOT, ".env"), quiet: true });
const axios = require("axios");

const SPEND_FILE = path.join(ROOT, ".esim", "adspend.json");
const STATE_FILE = path.join(ROOT, ".esim", "yd-esim-spend.json");
const API = "https://api.direct.yandex.com/json/v5/reports";
const TOKEN = process.env.YANDEX_DIRECT_TOKEN || "";
const LOGIN = process.env.YANDEX_DIRECT_LOGIN || "";
const FROM = process.env.ESIM_YD_FROM || "2026-10-16";
const NAME_RE = /e-?sim|есим|е-сим/i;
const WINDOW = 10;
const args = process.argv.slice(2);
const DRY = args.includes("--dry"), FORCE = args.includes("--force");

const iso = (ms) => new Date(ms + 3 * 3600e3).toISOString().slice(0, 10);   // день по МСК
const rj = (f, d) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch (_) { return d; } };
const wj = (f, v) => { const t = f + ".tmp"; fs.writeFileSync(t, JSON.stringify(v, null, 1)); fs.renameSync(t, f); };

(async () => {
  const state = rj(STATE_FILE, { days: {} });
  const today = iso(Date.now()), yesterday = iso(Date.now() - 86400e3);
  if (!TOKEN) { console.log("нет YANDEX_DIRECT_TOKEN"); return; }
  if (yesterday < FROM) { console.log("ещё рано: автосбор с " + FROM); return; }
  if (!FORCE && state.lastOkDay === today && state.to === yesterday) { return; }
  const from = [FROM, iso(Date.now() - WINDOW * 86400e3)].sort().pop();

  const headers = { Authorization: "Bearer " + TOKEN, "Accept-Language": "ru", "Content-Type": "application/json; charset=utf-8",
    processingMode: "auto", returnMoneyInMicros: "false", skipReportHeader: "true", skipColumnHeader: "true", skipReportSummary: "true" };
  if (LOGIN) headers["Client-Login"] = LOGIN;
  const body = { params: {
    SelectionCriteria: { DateFrom: from, DateTo: yesterday }, FieldNames: ["Date", "CampaignId", "CampaignName", "Cost", "Clicks"],
    ReportName: "voyo_esim_" + from + "_" + Date.now(), ReportType: "CAMPAIGN_PERFORMANCE_REPORT",
    DateRangeType: "CUSTOM_DATE", Format: "TSV", IncludeVAT: "YES", IncludeDiscount: "NO" } };

  let text = null, err = "";
  try {
    for (let i = 1; i <= 30 && text == null; i++) {
      const r = await axios.post(API, body, { headers, timeout: 120000, validateStatus: () => true, responseType: "text", transformResponse: [(d) => d] });
      if (r.status === 200) { text = String(r.data || ""); break; }
      if (r.status === 201 || r.status === 202) { await new Promise((x) => setTimeout(x, ((parseInt(r.headers.retryin, 10) || 5) + 1) * 1000)); continue; }
      err = "HTTP " + r.status + (r.status === 204 ? " (пустой ответ, сбой на стороне Яндекса)" : " " + String(r.data || "").slice(0, 200));
      break;
    }
  } catch (e) { err = e.message; }
  if (text == null) {
    state.lastError = { at: Date.now(), message: err || "отчёт не построился" };
    if (!DRY) wj(STATE_FILE, state);
    console.log("Директ недоступен: " + state.lastError.message);
    return;
  }

  // по дням: только кампании с eSIM в названии
  const days = {};
  for (let d = from; d <= yesterday; d = iso(Date.parse(d + "T12:00:00+03:00") + 86400e3)) days[d] = { rub: 0, clicks: 0, campaigns: {} };
  for (const line of text.trim().split("\n")) {
    const [date, id, name, cost, clicks] = line.split("\t");
    if (!days[date] || !NAME_RE.test(name || "")) continue;
    const c = parseFloat(String(cost || "").replace(",", "."));
    if (!Number.isFinite(c)) continue;
    days[date].rub += c; days[date].clicks += parseInt(clicks, 10) || 0;
    days[date].campaigns[id] = name;
  }

  const spend = rj(SPEND_FILE, { acqPct: 2.5, items: [] });
  spend.items = Array.isArray(spend.items) ? spend.items : [];
  const lines = [];
  for (const [date, v] of Object.entries(days)) {
    const id = "yd-" + date, rub = Math.round(v.rub);
    spend.items = spend.items.filter((x) => x.id !== id);
    if (rub > 0) spend.items.push({ id, channel: "yandex", date, rub, auto: true, ts: Date.now(),
      note: ("Директ авто, с НДС: " + Object.values(v.campaigns).join("; ")).slice(0, 160) });
    state.days[date] = { rub, clicks: v.clicks, campaigns: Object.values(v.campaigns) };
    lines.push(date + ": " + rub + " ₽, кликов " + v.clicks + (Object.keys(v.campaigns).length ? " (" + Object.values(v.campaigns).join("; ") + ")" : ""));
  }
  console.log(lines.join("\n") || "расхода нет");
  if (DRY) return;
  wj(SPEND_FILE, spend);
  Object.assign(state, { from, to: yesterday, lastOk: Date.now(), lastOkDay: today, lastError: null });
  wj(STATE_FILE, state);
})().catch((e) => { console.error("esimYdSpend:", e.message); process.exitCode = 1; });
