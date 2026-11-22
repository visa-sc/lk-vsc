// Сторож: Петров должен забрать наши правки витрины (16–17.11.2026), чтобы не затереть их.
// Андрей 18.11: «30 ноября в 9 утра отправь Петрову файл с корректировками для его Claude;
// если не заберёт — каждый день в 9 утра, пока не заберёт».
//   cron: 0 9 * * *  node tools/petrovSyncWatch.js        (до 30.11 молчит)
//   node tools/petrovSyncWatch.js --dry                    — показать письмо, не отправлять
// «Забрал» = сделал esimdeploy pull после наших правок: в /var/lib/esim-deploy/state.json
// base[файл] совпадает с хешем боевого файла. Тогда пишем Андрею один раз и замолкаем.
// Затереть правки он и так не сможет: служба выкладки откажет, если боевой менялся после его pull.
require("dotenv").config({ path: require("path").join(__dirname, "..", ".env"), quiet: true });
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { sendMail } = require("../mail.js");

const DIR = path.join(__dirname, "..", ".esim", "petrov-sync");
const STATE = path.join(DIR, "watch.json");
const DEPLOY = "/var/lib/esim-deploy/state.json";
const FILES = ["esim.html", "esim-pay-ok.html", "esim-partner.html", "esim-my.html"];
// 22.11.2026 (Андрей): 30.11 всё уходит Петрову ОДНИМ письмом — файл eSIM вкладывается разделом в общий пакет
// /root/look/petrov-bundle.js (30.11 00:55, письмо в 01:00, режим --md-only). Сам сторож с 01.12 в 9:00 только
// напоминает, пока не сделан pull, и один раз пишет Андрею «забрал».
const START = Date.parse("2026-12-01T09:00:00+03:00") - 10 * 60000;
const MD_ONLY = process.argv.includes("--md-only");
const PETROV = "ap@spt1.ru", ANDREY = "director@visa-sc.ru";
const DRY = process.argv.includes("--dry");
const rj = (f, d) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch (_) { return d; } };
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
const send = (o) => DRY ? Promise.resolve(console.log("[без отправки] кому:", o.to, "| тема:", o.subject, "\n" + o.text + "\nвложения:", (o.attachments || []).map((a) => a.filename).join(", "))) : sendMail(o);

// 19.11: смотрим не только три файла, а все файлы витрины из его основы — вдруг до 30.11 поправим ещё что-то
function pending() {
  const st = rj(DEPLOY, {});
  const names = Array.from(new Set(FILES.concat(Object.keys(st.base || {}))));
  return names.filter((f) => {
    let prod; try { prod = fs.readFileSync(path.join(__dirname, "..", "esim-site", f)); } catch (_) { return false; }
    return !(st.base && st.base[f] === sha(prod));
  });
}

// разница «его основа (current/ = то, что он забрал) → боевой файл», собирается в момент отправки
function instruction(files) {
  const { spawnSync } = require("child_process");
  const diffs = files.map((f) => {
    const r = spawnSync("diff", ["-u", path.join(path.dirname(DEPLOY), "current", f), path.join(__dirname, "..", "esim-site", f)], { encoding: "utf8", maxBuffer: 1 << 24 });
    let d = r.stdout || "";
    if (!d) { try { d = fs.readFileSync(path.join(DIR, f + ".diff"), "utf8"); } catch (_) {} }
    return "### " + f + "\n\n```diff\n" + d.trim() + "\n```\n";
  }).join("\n");
  return `# Правки в файлах витрины eSIM, внесённые 16–22.11.2026 (Андрей Комисаренко)

Для Claude Андрея Петрова. В боевые файлы витрины, которые Андрей Петров ведёт через \`esimdeploy\`, были внесены правки напрямую. Их нельзя потерять при следующей выкладке.

## Что сделать
1. \`esimdeploy pull\` — забрать свежие боевые файлы. Если у вас есть свои незавершённые правки, рядом появятся файлы \`*.prod\` — это боевые версии с нашими правками.
2. Перенести свои локальные правки ПОВЕРХ боевой версии (\`*.prod\`), сохранить как основной файл, удалить \`*.prod\`. Ни одна строка из изменений ниже не должна пропасть.
3. \`esimdeploy check\`, затем \`esimdeploy deploy\` как обычно.

Служба выкладки сама не даст выложить файл на старой основе (если боевой менялся после вашего pull), поэтому шаг 1 обязателен.

## Что изменено и зачем
- **esim.html** — корзина витрины (esim-cart.js): выбранный пакет запоминается, кнопка с тележкой появляется, только если человек ушёл без оплаты и вернулся (вызовы \`voyoCart.add\`, \`voyoCart.paying\`, функции \`window.voyoPackById\`, \`window.voyoOpenPack\`, подключение \`/esim-cart.js\`); «Срок: 1 день / 2 дня / 5 дней» вместо «1 дней»; в шагах установки «QR-код на почту, он же будет в «Мои eSIM»» вместо «в ЛК и на телефон»; 19.11 — кнопка «Мои eSIM» в шапке стала синей с белым текстом (класс \`mine my\` и правило \`.hdr .mine.my\`), клиенты её не замечали; 22.11 — на телефоне четыре карточки доверия (оплата, QR, поддержка, рейтинг) стоят 2×2 и компактно, чтобы поиск страны был виден без прокрутки (отдельный блок \`@media(max-width:560px)\` с комментарием 22.11.2026).
- **esim-pay-ok.html** — подключение \`/esim-cart.js\` (после оплаты корзина очищается); 22.11 — на iPhone кнопка «Установить eSIM на этот iPhone» (ссылка Apple, как в «Мои eSIM»), вместо подсказки «нажмите и удерживайте» (у клиентов не срабатывала) жёлтая плашка «QR срабатывает один раз», меньше повторов.
- **esim-my.html** — 22.11 блок установки без повторов: без заголовка «QR-код для установки»; на iPhone первой кнопка «Установить eSIM на этот iPhone», под ней QR и строка «Скопировать», одна жёлтая плашка (\`.qrnote\`: iOS 17.4+/Safari и «QR срабатывает один раз»), ниже шаги «Или вручную» / «Как установить» под устройство (id stH, st1, st2, класс .sth); у установленной eSIM вместо плашки строка про переустановку; на устаревшей ссылке кнопка «Найти мои eSIM по почте» (класс .deadbtn); пункты жёлтой плашки списком (instNote, instNote2), заголовок «Не получилось? Установите вручную»; перед «Нужна ещё одна eSIM?» блок «Путешествуете не один?» (#refPanel: промокод копируется касанием, «Отправить ссылку другу», данные из поля ref ответа /esim/api/my).
- **esim-a2hs.js** и **esim-account.html** — 22.11 «Добавить на экран» стало кнопкой с окном инструкции (функция block): только на телефоне, на компьютере не показывается; исчезает, если кабинет открыт с иконки, после установки на Android (событие appinstalled) или после «✓ Уже добавлено на экран» (флаг added в localStorage voyo_a2hs). Во встроенных браузерах (Telegram, Instagram, VK) окно подсказывает сначала открыть страницу в Safari/браузере. Название берётся по бренду (VOYO/VSC mobile). В esim-account.html место кнопки — под списком eSIM, в esim-my.html — перед «Путешествуете не один?».
- **Все страницы витрины (esim.html, esim-my.html, esim-account.html, esim-help.html, esim-case.html)** — 22.11 под логотипом убрана подпись «by VSC» (элемент \`.byvsc\`), остаётся просто VOYO mobile; витрина VSC mobile не тронута. В esim.html блок «Как это работает» компактный: цифра и текст в один ряд (CSS с комментарием 22.11.2026). В esim-my.html кнопка «Установить eSIM на этот iPhone» стоит между QR и строкой «Скопировать», светлее карты и с бликом (\`.instbtn::after\`), кнопка «Мои eSIM» в шапке синяя (\`.shop.my\`), шаг 2 «вставьте строку из поля под QR-кодом». В esim-a2hs.js инструкция для iPhone под новый Safari (≡ слева от адреса → «Поделиться» → «На экран „Домой“»), для Android «⋮ → Добавить на главный экран → Установить».
- **Шапка на всех страницах витрины** — 22.11 опущена чуть ниже (в конце <style> правило .hdr{padding-top:36px}, на телефоне 34px, с комментарием 22.11.2026). В esim-my.html и esim-account.html кнопка Tg-бота — белая «пилюля», как на главной (на компьютере короткая надпись «Tg-бот»).
- **22.11 вечер (аудит)** — esim-my.html и esim-account.html: кнопки шапки, «Выйти», «i» и «Обновить» не меньше 30–36 px (блоки CSS «удобнее попадать пальцем» / «по ним легко попасть пальцем»); у приостановленной eSIM подсказка «Оператор приостановил eSIM. Напишите в поддержку, разберёмся.»; если у eSIM нет строки для ручного ввода, поле «Скопировать» скрыто и шаг 2 просит отсканировать QR.
- **esim-partner.html** — кабинет партнёра (агентства): адрес \`/p/<слаг>\`, вход по ссылке из письма (\`#k=пароль\`), блок «Ссылка для клиентов» с кнопкой «Скопировать» и QR-кодом для стойки.

## Точные изменения (diff: «-» было у вас, «+» стало на боевом)

${diffs}`;
}

// наш серверный код (Петров его не правит) — для сведения, чтобы его Claude понимал, что видят клиенты
const SERVER_NOTE = `# Письмо «eSIM готова» и кабинет — что изменилось 22.11.2026 (наш код, для сведения)

- **Письмо «eSIM готова»** (esim.js, readyLetter): короче; кнопка «Установить eSIM», под ней «На странице: установка в один тап на iPhone и QR-код»; жёлтая плашка пунктами (QR срабатывает один раз, дома по Wi-Fi; роуминг данных); зелёный блок «Добавьте VOYO mobile на экран телефона» с кнопкой «Открыть кабинет на телефоне»; «Путешествуете не один?» с промокодом и ссылкой; сверху подпись бренда. Ручной инструкции в письме нет сознательно: она на странице eSIM. Письмо на несколько eSIM: подпись над каждой кнопкой (раньше таблица вылезала за экран телефона).
- **Дизайн кабинета eSIM** (esim-my.html, esim-account.html): палитра «глубокая лагуна» — блок в конце <style> с комментарием «Дизайн 22.11.2026». Главная карта полночный синий → бирюза с мягким сиянием, жемчужный фон через body::before, шампань для важного, шалфей для «на экран». Не перекрашивать обратно.
- **API /esim/api/my** отдаёт поле ref {code, bonus, link} — для блока «Путешествуете не один?».
- **Бот** — см. раздел ниже.
- Подпись «by VSC» под логотипом убрана на всех страницах (Андрей Комисаренко: «больше не надо, просто VOYO mobile»). Не возвращать.`;

(async () => {
  const w = rj(STATE, { sent: [], done: null });
  if (w.done) return console.log("уже забрал", new Date(w.done).toISOString());
  // 19.11 (Андрей): всё одним письмом — правки витрины и бота в одном файле. Раздел про бота уходит
  // в первом письме 30.11 обязательно, даже если файлы витрины он к тому времени уже забрал.
  const left = pending();
  if (MD_ONLY) {   // для общего письма 30.11: только собрать файл, ничего не отправлять
    const md0 = (left.length ? instruction(left) + "\n\n---\n\n" : "") + SERVER_NOTE + "\n\n---\n\n" + require("./petrovBotNotice.js").MD;
    fs.mkdirSync(DIR, { recursive: true }); fs.writeFileSync(path.join(DIR, "ПРАВКИ-eSIM-витрина-и-бот-16-22.11.md"), md0, "utf8");
    if (!DRY) { w.bundledAt = Date.now(); w.botSent = true; fs.writeFileSync(STATE, JSON.stringify(w, null, 1)); }
    return process.stdout.write(md0);
  }
  const early = Date.now() < START && !DRY;
  if (!left.length && (w.botSent || early)) {
    if (early && !w.botSent) return console.log("витрину забрал, письмо про бот — 30.11");
    w.done = Date.now(); fs.mkdirSync(DIR, { recursive: true }); if (!DRY) fs.writeFileSync(STATE, JSON.stringify(w, null, 1));
    return send({ to: ANDREY, subject: "eSIM: Петров забрал правки витрины",
      text: "Петров сделал esimdeploy pull: наши правки 16–22.11 (корзина, кабинеты агентств, тексты, кнопка «Мои eSIM») у него, затереть их он не сможет." + (w.sent.length ? "\nПисем ему ушло: " + w.sent.length + "." : "") });
  }
  if (early) return console.log("до 30.11 молчу, не забраны:", left.join(", "));
  const bot = require("./petrovBotNotice.js").MD;
  const md = (left.length ? instruction(left) + "\n\n---\n\n" : "") + SERVER_NOTE + "\n\n---\n\n" + bot;
  const NAME = "ПРАВКИ-eSIM-витрина-и-бот-16-22.11.md";
  const file = path.join(DIR, NAME);
  fs.mkdirSync(DIR, { recursive: true }); fs.writeFileSync(file, md, "utf8");
  const first = !w.sent.length && !w.bundledAt;
  const r = await send({ to: PETROV, replyTo: ANDREY,
    subject: (first ? "" : "Напоминание: ") + "eSIM: правки витрины и бота за 16–22.11 — отдайте файл своему Claude, чтобы не затереть",
    text: "Андрей, добрый день!\n\n" +
      (left.length ? "16–22.11 в ваши файлы витрины внесены правки: корзина, кабинеты агентств для партнёрской рассылки, пара текстов в окне покупки, синяя кнопка «Мои eSIM», понятнее инструкция установки на странице eSIM. Файлы: " + left.join(", ") + ".\n" : "") +
      "В боте изменён раздел «Мои eSIM» (купившие на сайте видят свои eSIM после кода с почты) и появились новые тексты.\n\n" +
      "Чтобы ничего не затереть:\n" +
      (left.length ? "1. esimdeploy pull\n2. " : "") +
      "Отдайте вложенный файл своему Claude: там точный список изменений и что сделать, он перенесёт ваши правки поверх.\n\n" +
      (left.length ? "Служба выкладки и так не даст выложить файл на старой основе, но лучше забрать заранее.\n" : "") +
      (first || !left.length ? "" : "Пока pull не сделан, это письмо будет приходить каждый день в 9:00.\n") +
      "\nАндрей Комисаренко",
    attachments: [{ filename: NAME, path: file }] });
  if (!DRY && r && r.ok) { w.sent.push(Date.now()); w.botSent = true; fs.writeFileSync(STATE, JSON.stringify(w, null, 1)); }
  console.log(DRY ? "проверка" : (r && r.ok ? "отправлено Петрову" : "не ушло: " + (r && r.error)));
})().catch((e) => { console.error("petrov sync:", e.message); process.exit(1); });
