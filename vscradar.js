// ═════════════════════════════════════════════════════════════════════════
// Радар возможностей /vsc «Прогноз прибыли» — решения по карточкам и поиск
// новых идей с помощью Claude (просьба Андрея 19.10.2026).
//
// 1. Решения. У каждой карточки радара кнопки «Применено» и «Не актуально»:
//    карточка исчезает, решение хранится здесь (.vscRadar.json), скрытые можно
//    вернуть. Карточки правил считаются на странице, у них устойчивый key.
// 2. Новые идеи. После каждого решения (с паузой 90 с, чтобы серия нажатий дала
//    один запуск), по кнопке «Найти новые» и раз в неделю сервер собирает сводку
//    по всем накопленным данным VSC: дашборд KPI по месяцам, P&L «Потока», прогноз
//    и модель расходов, историю прибыли, выручку по городам, П&L Питера, сборы,
//    эквайринг, выкупы, ФОТ по отделам (средние, без личных окладов), нагрузку и
//    результаты сотрудников, скорость первого касания, цикл сделки, маркетинг KPI
//    по каналам, записанные сделки, сверку контактов. Планёрка и личные зарплаты
//    в сводку НЕ идут. Claude возвращает 5–8 неочевидных идей с оценкой в рублях;
//    уже принятые и отклонённые решения ему передаются, чтобы не повторялся.
// Данные читаются через те же адреса /admin/api/vsc/*, что видит Андрей, служебным
// входом администратора (createAdminSession) — по localhost, наружу не выходит.
// Расход Claude пишется в общий журнал ai-usage под именем «vsc_radar».
// Только админ: все адреса под requireAdmin.
// ═════════════════════════════════════════════════════════════════════════
const fs = require("fs");
const path = require("path");
const http = require("http");

const FILE = path.join(__dirname, ".vscRadar.json");
const MODELS = String(process.env.VSC_RADAR_MODEL || "claude-opus-5-5,claude-opus-5").split(",").map((s) => s.trim()).filter(Boolean);
const DEBOUNCE_MS = 90 * 1000;
const WEEK_MS = 7 * 86400 * 1000;
const MAX_RUNS_DAY = 8;                 // предохранитель от серии нажатий
const SRC_LIMIT = 24000;                // символов на один источник в сводке
const TOTAL_LIMIT = 240000;             // символов на всю сводку

// Источники: адрес, подпись для модели, что выкинуть (тяжёлые/личные поля).
const SOURCES = [
  ["/admin/api/vsc-dashboard", "Дашборд KPI по месяцам и неделям (выручка=budget, реклама=ad, CPL, конверсия cv, средний чек atv, ДРР, контакты processed, пропущенные звонки missedPct, мусор junkPct, конверсия трафика trafConv, возвраты returnsPct, ctrl — план/факт, CPL и ДРР с доп. расходами, налоги)", ["days", "profit", "dayRevenue"]],
  ["/admin/api/vsc-forecast", "Прогноз прибыли текущего месяца и модель расходов по факту P&L «Потока» (costModel: доходы и расходы по статьям, проверка на прошлых месяцах)", ["weeks"]],
  ["/admin/api/vsc/profit-history", "История чистой прибыли по месяцам и годам", []],
  ["/admin/api/vsc/city-revenue", "Выручка и сделки по городам (МСК/СПБ/ЕКБ) по месяцам", []],
  ["/admin/api/vsc/spb-pnl", "P&L филиала Санкт-Петербург по месяцам", []],
  ["/admin/api/vsc/sbory", "Запас на сборы: приход и расход по сборам по месяцам", []],
  ["/admin/api/vsc/acquiring", "Комиссии эквайринга по месяцам", ["days", "ops"]],
  ["/admin/api/vsc/buyouts", "Выкупы и возвраты через T-Bank по месяцам", ["list", "ops", "sameDayList"]],
  ["/admin/api/vsc/zarplata", "ФОТ по отделам по месяцам: штат, начислено, средняя по отделу, человеко-дни; выручка городов", ["people", "list"]],
  ["/admin/api/vsc/staffperf", "Результаты и нагрузка сотрудников по месяцам (контакты, продажи, выручка, сделки ОРК/ОО)", []],
  ["/admin/api/vsc/staffstats", "Статистика сотрудников из amoCRM", []],
  ["/admin/api/vsc/firsttouch", "Скорость первого касания по сотрудникам", ["list"]],
  ["/admin/api/vsc/dealcycle", "Цикл сделки по направлениям (дни от контакта до оплаты)", []],
  ["/admin/api/vsc/mktkpi", "Маркетинг KPI по каналам по месяцам (расход, лиды, продажи, выручка)", []],
  ["/admin/api/vsc/schengen", "Доля записанных сделок Шенген/США по дате оплаты", []],
  ["/admin/api/vsc/recon-summary", "Сверка контактов: звонки и заявки с сайтов против amoCRM (потерянные обращения)", ["missCalls", "missPhones"]],
  ["/admin/api/vsc/vouchers", "Ваучеры и сертификаты", ["list"]],
  ["/admin/api/vsc/marketing-plan", "Маркетинговый план: задачи в работе и бэклог (чтобы не предлагать уже начатое)", []],
];

function load() { try { return JSON.parse(fs.readFileSync(FILE, "utf8")) || {}; } catch (_) { return {}; } }
function save(o) { try { fs.writeFileSync(FILE + ".tmp", JSON.stringify(o, null, 1)); fs.renameSync(FILE + ".tmp", FILE); } catch (e) { console.error("vscradar save:", e.message); } }
const mskDay = () => new Date(Date.now() + 3 * 3600e3).toISOString().slice(0, 10);

// Сжатие: убрать тяжёлые/личные ключи на любом уровне, округлить дроби, обрезать длинные массивы.
function compact(v, drop, depth) {
  depth = depth || 0;
  if (v == null) return v;
  if (typeof v === "number") return Math.abs(v) >= 100 ? Math.round(v) : Math.round(v * 100) / 100;
  if (typeof v === "string") return v.length > 300 ? v.slice(0, 300) + "…" : v;
  if (Array.isArray(v)) return v.slice(-60).map((x) => compact(x, drop, depth + 1));
  if (typeof v === "object") {
    if (depth > 7) return "…";
    const o = {};
    for (const k of Object.keys(v)) {
      if (drop.indexOf(k) >= 0 || /token|password|phone|email|passport|inn\b/i.test(k)) continue;
      o[k] = compact(v[k], drop, depth + 1);
    }
    return o;
  }
  return v;
}

function mount(deps) {
  const { app, requireAdmin, createAdminSession, isAdminTokenValid, potok, port, aiUsage, sendMail } = deps;
  let st = load();
  st.decisions = st.decisions || {};
  st.ai = st.ai || {};
  st.runs = st.runs || {};
  let running = false, timer = null, svcToken = null;

  const tokenOf = () => {
    if (!svcToken || !isAdminTokenValid(svcToken)) svcToken = createAdminSession();
    return svcToken;
  };
  const getJSON = (p) => new Promise((resolve) => {
    const r = http.request({ host: "127.0.0.1", port, path: p, method: "GET", headers: { Authorization: "Bearer " + tokenOf() }, timeout: 120000 }, (x) => {
      let b = ""; x.setEncoding("utf8"); x.on("data", (c) => (b += c));
      x.on("end", () => { try { resolve(x.statusCode === 200 ? JSON.parse(b) : null); } catch (_) { resolve(null); } });
    });
    r.on("error", () => resolve(null)); r.on("timeout", () => { r.destroy(); resolve(null); }); r.end();
  });

  async function digest() {
    const parts = [];
    let total = 0;
    for (const [p, title, drop] of SOURCES) {
      const j = await getJSON(p);
      if (!j) { parts.push("### " + title + "\n(нет данных)"); continue; }
      let s = JSON.stringify(compact(j, drop.concat(["success"])));
      if (s.length > SRC_LIMIT) s = s.slice(0, SRC_LIMIT) + "…(обрезано)";
      if (total + s.length > TOTAL_LIMIT) { parts.push("### " + title + "\n(пропущено: лимит сводки)"); continue; }
      total += s.length;
      parts.push("### " + title + "\n" + s);
    }
    // P&L «Потока» Кати по месяцам: шаги и категории (без построчных проводок)
    try {
      const pm = potok.load() || {};
      const out = {};
      for (const m of Object.keys(pm)) {
        const x = pm[m] || {}, pl = x.pl || {};
        out[m] = compact({ ym: x.ym, steps: pl.steps, cats: pl.cats, tax: pl.tax, ebit: pl.ebit, profit: pl.profit, fond: pl.fond, extra: x.extra }, []);
      }
      let s = JSON.stringify(out);
      if (s.length > SRC_LIMIT * 2) s = s.slice(0, SRC_LIMIT * 2) + "…(обрезано)";
      parts.push("### P&L «Потока» (учёт Кати) по месяцам: шаги отчёта и категории расходов\n" + s);
    } catch (_) {}
    return parts.join("\n\n");
  }

  function decidedList() {
    return Object.keys(st.decisions).map((k) => {
      const d = st.decisions[k];
      return "- " + (d.state === "applied" ? "ПРИМЕНЕНО" : "НЕ АКТУАЛЬНО") + ": " + (d.title || k) + (d.act ? " — " + d.act : "");
    }).join("\n") || "(пока нет)";
  }

  const TOOL = {
    name: "submit_ideas",
    description: "Отдать список идей по увеличению чистой прибыли.",
    input_schema: {
      type: "object",
      properties: {
        ideas: {
          type: "array", minItems: 3, maxItems: 8,
          items: {
            type: "object",
            properties: {
              title: { type: "string", description: "Короткий заголовок, 3–7 слов" },
              gain: { type: "number", description: "Оценка прироста чистой прибыли, ₽ в месяц (осторожная)" },
              now: { type: "string", description: "Как сейчас, с цифрами из данных" },
              target: { type: "string", description: "Цель, к чему прийти, с цифрой" },
              act: { type: "string", description: "Что конкретно сделать, 1–3 предложения простыми словами" },
              calc: { type: "string", description: "Как посчитана оценка: формула на цифрах из данных" },
              basis: { type: "string", description: "Какие отчёты и месяцы легли в основу" }
            },
            required: ["title", "gain", "now", "target", "act", "calc", "basis"]
          }
        }
      },
      required: ["ideas"]
    }
  };

  async function callClaude(system, user) {
    const base = (process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com").replace(/\/+$/, "");
    let lastErr = null;
    for (const model of MODELS) {
      try {
        const r = await fetch(base + "/v1/messages", {
          method: "POST",
          headers: { "x-api-key": process.env.ANTHROPIC_API_KEY || "", "anthropic-version": "2023-06-01", "content-type": "application/json" },
          body: JSON.stringify({ model, max_tokens: 8000, system, tools: [TOOL], tool_choice: { type: "tool", name: "submit_ideas" }, messages: [{ role: "user", content: user }] }),
          signal: AbortSignal.timeout(10 * 60 * 1000)
        });
        const j = await r.json().catch(() => null);
        if (!r.ok) { lastErr = new Error("HTTP " + r.status + " " + JSON.stringify(j && j.error || j).slice(0, 200)); if (r.status === 404 || r.status === 400) continue; throw lastErr; }
        if (j && j.usage) aiUsage.record("vsc_radar", j.model || model, j.usage);
        const tu = (j.content || []).find((b) => b.type === "tool_use");
        if (!tu || !tu.input || !Array.isArray(tu.input.ideas)) throw new Error("модель не вернула список идей");
        return { model: j.model || model, ideas: tu.input.ideas, usage: j.usage };
      } catch (e) { lastErr = e; if (!/HTTP 40[04]/.test(e.message)) break; }
    }
    throw lastErr || new Error("нет ответа модели");
  }

  async function run(trigger) {
    if (running) return null;
    const day = mskDay();
    if ((st.runs[day] || 0) >= MAX_RUNS_DAY) { console.log("VSC RADAR: лимит запусков за сутки"); return null; }
    running = true; st.ai.running = true; st.ai.startedAt = Date.now(); save(st);
    try {
      const data = await digest();
      const ruleCards = (st.ruleCards || []).map((c) => "- " + c).join("\n") || "(нет)";
      const system = [
        "Ты — финансовый аналитик компании VSC (Центр визовых услуг: визы, ВНЖ, переводы, страховки; офисы Москва, Санкт-Петербург, Екатеринбург; собственник Андрей).",
        "Задача: по накопленным данным компании найти НЕОЧЕВИДНЫЕ, конкретные решения, которые увеличат чистую прибыль. Любые: цены и допродажи, структура услуг, каналы и реклама, персонал и графики, процессы, возвраты, налоги и комиссии, сезонность, города, повторные продажи, потери обращений и т.д.",
        "Правила:",
        "1. Каждая идея опирается на цифры из данных: укажи, какие отчёты и месяцы. Не выдумывай данных, которых нет.",
        "2. Оценка прироста прибыли — осторожная, в рублях в месяц, с понятной формулой на реальных цифрах. Выручку не путай с прибылью: от прироста выручки в прибыль идёт только маржа.",
        "3. Не повторяй карточки, которые радар уже показывает по правилам, и решения из списков «применено» и «не актуально» (ни дословно, ни по смыслу).",
        "4. Не предлагай то, что уже есть в маркетинговом плане в работе.",
        "5. Пиши по-русски, простыми словами, как для собственника: без жаргона и англицизмов. Без длинных тире. Не используй технические имена полей из данных (trafConv, returnsPct, upt, cv и т.п.) — называй по-человечески: «конверсия трафика в контакт», «доля возвратов», «услуг в чеке».",
        "   Кратко: «сейчас» и «цель» — по одному предложению с главными цифрами; «что сделать» — до трёх коротких предложений; подробности и формулы — в «расчёт».",
        "6. Сортируй по оценке, от большей к меньшей. 5–8 идей."
      ].join("\n");
      const user = "Сегодня " + day + ".\n\nКарточки, которые радар уже показывает по правилам (не повторять):\n" + ruleCards
        + "\n\nРешения собственника по прошлым идеям (не повторять):\n" + decidedList()
        + "\n\nДАННЫЕ КОМПАНИИ (JSON по разделам):\n\n" + data;
      const res = await callClaude(system, user);
      const ideas = res.ideas.map((x, i) => ({
        key: "ai:" + day + ":" + i + ":" + String(x.title || "").toLowerCase().replace(/[^a-zа-яё0-9]+/gi, "-").slice(0, 40),
        title: String(x.title || ""), gain: Math.max(0, Math.round(Number(x.gain) || 0)),
        now: String(x.now || ""), target: String(x.target || ""), act: String(x.act || ""), calc: String(x.calc || ""), basis: String(x.basis || "")
      }));
      st.runs[day] = (st.runs[day] || 0) + 1;
      for (const k of Object.keys(st.runs)) if (k < new Date(Date.now() - 20 * 86400e3).toISOString().slice(0, 10)) delete st.runs[k];
      st.ai = { ts: Date.now(), trigger, model: res.model, ideas, inTok: res.usage && res.usage.input_tokens, outTok: res.usage && res.usage.output_tokens };
      save(st);
      console.log("VSC RADAR [" + trigger + "]: идей " + ideas.length + ", модель " + res.model);
      return st.ai;
    } catch (e) {
      st.ai.running = false; st.ai.lastError = { ts: Date.now(), message: e.message }; save(st);
      console.error("VSC RADAR [" + trigger + "]:", e.message);
      return null;
    } finally { running = false; if (st.ai) { st.ai.running = false; save(st); } }
  }
  function schedule(trigger) {
    if (timer) clearTimeout(timer);
    st.ai.pending = Date.now() + DEBOUNCE_MS; save(st);
    timer = setTimeout(() => { timer = null; st.ai.pending = null; run(trigger).catch(() => {}); }, DEBOUNCE_MS);
  }

  const view = () => ({ decisions: st.decisions, ai: { ts: st.ai.ts || null, model: st.ai.model || null, ideas: st.ai.ideas || [], running: running || !!st.ai.pending, lastError: st.ai.lastError || null } });

  app.get("/admin/api/vsc/radar", requireAdmin, (req, res) => res.json(Object.assign({ success: true }, view())));
  // Решение по карточке: applied | irrelevant | restore. Страница присылает и текущие
  // карточки правил (ruleCards) — чтобы Claude их не повторял.
  app.post("/admin/api/vsc/radar/decide", requireAdmin, (req, res) => {
    const b = req.body || {};
    const key = String(b.key || "").slice(0, 200), state = String(b.state || "");
    if (!key || ["applied", "irrelevant", "restore"].indexOf(state) < 0) return res.status(400).json({ success: false, message: "Нужны key и state" });
    if (Array.isArray(b.ruleCards)) st.ruleCards = b.ruleCards.slice(0, 30).map((x) => String(x).slice(0, 200));
    if (state === "restore") delete st.decisions[key];
    else {
      st.decisions[key] = { state, at: Date.now(), title: String(b.title || "").slice(0, 200), act: String(b.act || "").slice(0, 400), gain: Math.round(Number(b.gain) || 0) };
      schedule("решение");
    }
    save(st);
    res.json(Object.assign({ success: true }, view()));
  });
  app.post("/admin/api/vsc/radar/refresh", requireAdmin, (req, res) => {
    const b = req.body || {};
    if (Array.isArray(b.ruleCards)) st.ruleCards = b.ruleCards.slice(0, 30).map((x) => String(x).slice(0, 200));
    if (running) return res.json(Object.assign({ success: true }, view()));
    if ((st.runs[mskDay()] || 0) >= MAX_RUNS_DAY) return res.json(Object.assign({ success: false, message: "На сегодня поиск запускался " + MAX_RUNS_DAY + " раз — хватит, завтра снова" }, view()));
    run("кнопка").catch(() => {});
    res.json(Object.assign({ success: true }, view(), { ai: Object.assign(view().ai, { running: true }) }));
  });

  // Раз в неделю — сам, если идей давно не искали (проверка раз в час).
  setInterval(() => { if (!running && (!st.ai.ts || Date.now() - st.ai.ts > WEEK_MS)) run("неделя").catch(() => {}); }, 3600 * 1000);
  // После перезапуска отложенный запуск (нажали и сразу выкладка) не теряется.
  if (st.ai.pending) schedule("решение");
  console.log("VSC RADAR: решения по карточкам + поиск идей Claude (" + MODELS[0] + ") после решений и раз в неделю");
}

module.exports = { mount };
