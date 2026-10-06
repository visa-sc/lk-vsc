// ═══════════════════════════════════════════════════════════════════════════
// Экономия на правках переводов (06.10.2026, решение Андрея).
//
// Живёт в шлюзе ОСНОВНОГО приложения, а не в движке: движок правит Катя, и
// любую правку в нём её Claude может перезаписать. Через шлюз проходит каждый
// запрос движка к ИИ, а к /var/www/voyo у её юзера нет доступа — здесь
// экономию не стереть. Если движок поменяет формат запросов, экономия просто
// перестанет срабатывать (запросы пойдут как обычно) — сломаться ничего не может.
//
// 1. Правка группы. Модуль Кати шлёт одну правку на весь заказ
//    (/translate/api/portal/correct), а движок гонит её через Sonnet по
//    КАЖДОМУ файлу — даже если правка про один документ («в выписке ВТБ
//    замени Best на LUCHSHIY»). 06.10 так ушла половина дневного расхода.
//    Шлюз сам проксирует эту команду, поэтому знает текст правки и число
//    файлов. Перед дорогим проходом он спрашивает дешёвую модель, касается ли
//    правка этого документа; если явно нет — отвечает движку от имени модели
//    текущим переводом без изменений (файл пересобирается тем же).
//    Предохранители: в сомнениях — правим; хотя бы один файл группы правится
//    всегда; правки одного файла (не группой) не трогаем никогда.
// 2. Вывод правил из правки. Движок делает его по разу на каждый файл группы:
//    одна правка давала 11 переформулированных копий одного правила, и они
//    вытесняли из промпта настоящие правила (в него идут последние 40).
//    Здесь вывод правил из одного и того же текста идёт один раз за 12 часов,
//    на повторы шлюз отвечает «новых правил нет».
//
// Счётчики по дням — в .engineEconomy.json (stats).
// ═══════════════════════════════════════════════════════════════════════════
const fs = require("fs");
const path = require("path");

const FILE = path.join(__dirname, ".engineEconomy.json");
const TTL = 12 * 3600 * 1000;
const CLASSIFY_MODEL = "claude-haiku-4-5";

// Метки из промптов движка (translate.js: pipelineCorrect). Поменяются — экономия
// молча выключится, ответы движку пойдут как раньше.
const CORR_HEAD = "РЕЖИМ: переводчик, правка.";
const CUR_MARK = "\n\nТекущий перевод:\n\n";
const INS_MARK = "\n\nКорректировка заказчика (выполни её):\n";
const TR_MARK = "\n\nТранслитерация ФИО: ";
const LES_SYS = "Ты ведёшь базу правил для переводчика документов";
const LES_HEAD = "Корректировка заказчика: ";
const LES_TAIL = "\n\nСуществующие правила:";

let st = null;
const pendingLessons = new Set();

function mskDay() { return new Date(Date.now() + 3 * 3600 * 1000).toISOString().slice(0, 10); }
function load() {
  if (st) return st;
  try { st = JSON.parse(fs.readFileSync(FILE, "utf8")); } catch (_) { st = {}; }
  st.groups = st.groups || {};
  st.lessons = st.lessons || {};
  st.stats = st.stats || {};
  prune();
  return st;
}
function save() {
  try { fs.writeFileSync(FILE, JSON.stringify(st, null, 1)); } catch (e) { console.warn("engine-economy save:", e.message); }
}
function prune() {
  const now = Date.now();
  for (const k of Object.keys(st.groups)) if (now - (st.groups[k].at || 0) > TTL) delete st.groups[k];
  for (const k of Object.keys(st.lessons)) if (now - st.lessons[k] > TTL) delete st.lessons[k];
  const old = new Date(now - 90 * 86400e3).toISOString().slice(0, 10);
  for (const k of Object.keys(st.stats)) if (k < old) delete st.stats[k];
}
function bump(key, n) {
  const d = st.stats[mskDay()] || (st.stats[mskDay()] = {});
  d[key] = (d[key] || 0) + (n == null ? 1 : n);
}
const norm = (t) => String(t || "").toLowerCase().replace(/\s+/g, " ").trim();

// ── Команда «правка группы» (её видит прокси /translate/api/*) ──
function noteGroupStart(text, number) {
  load();
  const k = norm(text);
  if (!k) return;
  st.groups[k] = { at: Date.now(), number: String(number || ""), n: null, decided: 0, applied: 0, skipped: 0 };
  save();
}
function noteGroupResult(text, files) {
  load();
  const g = st.groups[norm(text)];
  if (!g) return;
  if (files > 0) g.n = files; else delete st.groups[norm(text)];
  save();
}

// ── Разбор запросов движка ──
function lastUserText(body) {
  const ms = (body && body.messages) || [];
  const m = ms[ms.length - 1];
  if (!m) return "";
  if (typeof m.content === "string") return m.content;
  return (m.content || []).filter((b) => b && b.type === "text").map((b) => b.text || "").join("\n");
}
function systemText(body) {
  const s = body && body.system;
  if (typeof s === "string") return s;
  if (Array.isArray(s)) return s.map((b) => (b && b.text) || "").join("\n");
  return "";
}
function parseCorrection(body) {
  const t = lastUserText(body);
  if (t.indexOf(CORR_HEAD) < 0) return null;
  const a = t.indexOf(CUR_MARK), b = t.lastIndexOf(INS_MARK);
  if (a < 0 || b < 0 || b < a) return null;
  let ins = t.slice(b + INS_MARK.length);
  const c = ins.lastIndexOf(TR_MARK);
  if (c >= 0) ins = ins.slice(0, c);
  return { html: t.slice(a + CUR_MARK.length, b), instruction: ins };
}
function parseLessons(body) {
  if (systemText(body).indexOf(LES_SYS) < 0) return null;
  const t = lastUserText(body);
  if (t.indexOf(LES_HEAD) !== 0) return null;
  const e = t.indexOf(LES_TAIL);
  return { instruction: t.slice(LES_HEAD.length, e < 0 ? undefined : e) };
}

// ── Касается ли правка документа (дешёвая модель) ──
async function relevant(instruction, html, call) {
  const plain = String(html).replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim().slice(0, 40000);
  const r = await call({
    model: CLASSIFY_MODEL, max_tokens: 120,
    system: "Ты помогаешь бюро переводов не тратить деньги впустую. Заказчик прислал ОДНУ правку на весь заказ из нескольких документов. Тебе показан ОДИН документ этого заказа — его готовый перевод. Реши, может ли правка изменить хоть что-то именно в этом документе.",
    messages: [{ role: "user", content:
      "Правка заказчика:\n" + instruction + "\n\nДокумент (текст перевода):\n" + plain +
      "\n\nКак решать:\n" +
      "- НЕТ — только если правка явно про другой документ (называет другой тип документа, другой банк, другую выписку, другого человека) или про конкретное слово, номер, название, которого в этом документе нет ни в каком написании.\n" +
      "- Общие правки про оформление, таблицы, шрифты, поля, страницы, печати, подписи, транслитерацию имён, которые есть в документе, — ДА.\n" +
      "- Если сомневаешься — ДА.\n" +
      "Первая строка ответа — только ДА или НЕТ. Вторая — коротко почему." }],
  });
  const first = String(r.text || "").trim().split("\n")[0].trim().toUpperCase();
  return !/^НЕТ(?![А-ЯЁ])/.test(first);
}

// ── Точка входа из шлюза ──
// Возвращает null (пропустить как есть), {synthetic, why} (ответить самим) или
// {after(status)} (пропустить и сообщить итог).
async function intercept(body, call) {
  if (!body || typeof body !== "object" || !Array.isArray(body.messages)) return null;
  load();

  const L = parseLessons(body);
  if (L) {
    const k = norm(L.instruction);
    if (!k) return null;
    if (st.lessons[k] || pendingLessons.has(k)) {
      bump("lessonsDeduped"); save();
      return { synthetic: "{\"lessons\":[]}", why: "lessons-dedup" };
    }
    pendingLessons.add(k);
    return { after: (status) => { pendingLessons.delete(k); if (status === 200) { st.lessons[k] = Date.now(); save(); } } };
  }

  const C = parseCorrection(body);
  if (!C) return null;
  const k = norm(C.instruction);
  const g = st.groups[k];
  if (!g) return null;                              // правка одного файла — не трогаем
  for (let i = 0; i < 30 && g.n == null; i++) await new Promise((r) => setTimeout(r, 100));
  if (!g.n || g.n < 2) return null;
  if (g.decided >= g.n) return null;                // сверх группы — значит, это уже другая правка
  g.decided++;
  bump("groupFiles");
  let yes = true;
  try { yes = await relevant(C.instruction, C.html, call); }
  catch (e) { console.warn("engine-economy: классификатор не ответил — правим как обычно:", e.message); yes = true; }
  if (yes) { g.applied++; save(); return null; }
  if (g.applied === 0 && g.skipped + 1 >= g.n) {    // правка не должна пропасть целиком
    g.applied++; bump("guardApplied"); save();
    return null;
  }
  g.skipped++;
  bump("skipped");
  save();
  console.log("engine-economy: правка «" + C.instruction.slice(0, 60).replace(/\s+/g, " ") + "» не касается файла заказа " + g.number + " — пропущена");
  return { synthetic: C.html, why: "correction-skipped" };
}

// Ответ движку от имени модели — в том же формате, что настоящий (поток или JSON).
function respond(res, body, syn) {
  const model = String((body && body.model) || CLASSIFY_MODEL);
  const id = "msg_voyo_gw_" + Date.now().toString(36);
  res.set("x-voyo-gateway", syn.why);
  if (body && body.stream) {
    res.status(200).set("content-type", "text/event-stream; charset=utf-8");
    const ev = (type, data) => res.write("event: " + type + "\ndata: " + JSON.stringify(data) + "\n\n");
    ev("message_start", { type: "message_start", message: { id, type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } });
    ev("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
    ev("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: syn.synthetic } });
    ev("content_block_stop", { type: "content_block_stop", index: 0 });
    ev("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 0 } });
    ev("message_stop", { type: "message_stop" });
    return res.end();
  }
  return res.status(200).json({ id, type: "message", role: "assistant", model, content: [{ type: "text", text: syn.synthetic }],
    stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } });
}

// ── Сторож: экономия не должна выключиться молча ──
// Стереть этот файл Катя не может (у её юзера нет доступа к /var/www/voyo), но
// может поменять тексты запросов в своём движке — тогда метки выше перестанут
// совпадать, и экономия тихо прекратится (переводы при этом работают как раньше,
// просто дороже). Раз в час проверяем, что метки на месте в коде движка; если
// пропали — одно письмо Андрею в рабочее время (будни 09–19 МСК).
const ENGINE_SRC = "/var/www/translate-engine/translate.js";
const MARKERS = ["РЕЖИМ: переводчик, правка.", "Текущий перевод:", "Корректировка заказчика (выполни её):",
  "Транслитерация ФИО: ", LES_SYS, LES_HEAD, "Существующие правила:", "/translate/api/portal/correct"];
function watch(sendMail) {
  const run = () => {
    try {
      let src = "";
      try { src = fs.readFileSync(ENGINE_SRC, "utf8"); } catch (_) { return; }
      const missing = MARKERS.filter((m) => src.indexOf(m) < 0);
      load();
      const key = missing.join(" | ");
      const was = (st.watch && st.watch.missing) || "";
      if (key === was) return;
      if (!missing.length) { st.watch = { missing: "", at: Date.now() }; save(); console.log("engine-economy: метки движка снова на месте — экономия работает"); return; }
      const msk = new Date(Date.now() + 3 * 3600 * 1000);
      const dow = msk.getUTCDay(), h = msk.getUTCHours();
      if (dow === 0 || dow === 6 || h < 9 || h >= 19) return;   // напишем в рабочее время
      st.watch = { missing: key, at: Date.now() }; save();
      console.warn("engine-economy: в движке пропали метки: " + key);
      sendMail({ to: "director@visa-sc.ru", subject: "Переводы: экономия на правках перестала срабатывать",
        text: "В движке переводов (его правит Екатерина) изменились тексты запросов к ИИ, и экономия на правках в шлюзе больше их не узнаёт.\n\n" +
          "Ничего не сломано: переводы и правки работают как раньше, просто правка «на весь заказ» снова идёт по каждому файлу, а правила из одной правки снова выводятся по много раз.\n\n" +
          "Не найдено в коде движка: " + key + "\n\nЧтобы вернуть экономию, скажите Клоду: «почини экономию переводов»." }).catch(() => {});
    } catch (e) { console.warn("engine-economy watch:", e.message); }
  };
  setTimeout(run, 2 * 60 * 1000);
  setInterval(run, 60 * 60 * 1000);
}

function stats() { load(); return st.stats; }

module.exports = { intercept, respond, noteGroupStart, noteGroupResult, stats, watch, _parseCorrection: parseCorrection, _parseLessons: parseLessons };
