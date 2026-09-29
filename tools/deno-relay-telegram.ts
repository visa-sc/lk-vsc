// Deno Deploy — ретранслятор к Telegram Bot API (для бота продаж eSIM).
//
// Зачем: с нашего прод-сервера исходящие к api.telegram.org не проходят
// (проверено 10.09.2026: IPv4 — таймаут, IPv6 на сервере нет). Наружу ходим
// через этот ретранслятор — тот же приём, что с Anthropic для /translate
// (см. tools/deno-relay.ts).
//
// ВЫЛОЖЕНО 10.09.2026: проект visa-sc/small-emu-2019, адрес в .env прода
// (ESIM_TG_RELAY) = https://small-emu-2019.visa-sc.deno.net/<секрет ниже>.
// Релей переводов (lofty-bulldog-9780) живёт отдельно и не тронут.
//
// ОБНОВЛЕНИЕ 29.09.2026 — ПРИЁМ ВЕБХУКОВ.
// Длинный опрос держит соединение круглосуточно, и Deno считает память за всё
// время ожидания: бот в одиночку съедал 78% бесплатной квоты, даже когда ему
// никто не писал. Телеграм же до нашего сервера не достукивается напрямую
// (проверено 29.09.2026: Connection timed out, хотя из Германии и Финляндии
// сервер открывается). Поэтому вебхук принимает этот ретранслятор и тут же
// пересылает обновление на наш сервер:
//
//   Телеграм → https://<этот релей>/<СЕКРЕТ>/hook → https://voyovoyo.ru/tg/esim/<СЕКРЕТ_БОТА>
//
// Изолятор просыпается только на реальное сообщение, живёт доли секунды, и
// расход падает в сотни раз. Для клиента ничего не меняется.
//
// ГРАБЛИ: первый проект под это (rigid-prawn-3760) трижды падал на «Warm up»
// ещё до запуска кода, без единой строчки в логах — оказался битым. Лечится
// не правкой кода, а созданием нового Playground: пустой пример из шаблона
// там выкладывается за секунды, дальше в него вставляется этот файл.
//
// Токен бота здесь НЕ хранится и в адресе не светится: наш сервер шлёт его
// заголовком X-Bot-Token, ретранслятор только подставляет его в адрес
// Telegram. Секрет в пути закрывает релей от чужих — иначе через него будут
// гонять свой трафик.

const SECRET = "b7f1c0a94e2d4a6f8c3b5e7d9a1f2c48";
const UPSTREAM = "https://api.telegram.org";

// Куда пересылать вебхуки бота. Путь на нашем сервере заканчивается секретом
// бота: его подставляет сам Телеграм, потому что мы регистрируем вебхук
// полным адресом .../hook/<секрет бота>.
const HOOK_TARGET = "https://voyovoyo.ru/tg/esim/";

// Новый Deno Deploy запускает приложение в контейнере и передаёт свой порт в
// переменной PORT: если слушать привычный 8000, проверка живости («Warm up»)
// не достучится и вся выкладка считается неудачной.
const PORT = Number(Deno.env.get("PORT") || 8000);

Deno.serve({ port: PORT }, async (req: Request) => {
  const url = new URL(req.url);

  // Deno Deploy при выкладке стучится в корень и ждёт успешный ответ
  // («Warm up»). Отвечаем ему коротким ok, иначе выкладка считается неудачной.
  if (url.pathname === "/" || url.pathname === "") {
    return new Response("ok", { status: 200 });
  }

  const prefix = "/" + SECRET;
  if (!url.pathname.startsWith(prefix + "/")) {
    return new Response("forbidden", { status: 403 });
  }

  const rest = url.pathname.slice(prefix.length + 1);

  // ── вебхук от Телеграма: /<СЕКРЕТ>/hook/<секрет бота> ──
  // Отвечаем Телеграму сразу, чтобы он не ждал наш сервер и не копил очередь,
  // а обновление досылаем следом. Телеграм повторяет доставку сам, если мы
  // ответили ошибкой, поэтому на неудачу отвечаем 500.
  if (rest.startsWith("hook/") || rest === "hook") {
    if (req.method !== "POST") return new Response("method", { status: 405 });
    const botSecret = rest.slice(5).replace(/[^A-Za-z0-9_-]/g, "");
    if (!botSecret) return new Response("no secret", { status: 400 });
    const body = await req.text();
    const headers = new Headers({ "Content-Type": "application/json" });
    const tgSecret = req.headers.get("x-telegram-bot-api-secret-token");
    if (tgSecret) headers.set("X-Telegram-Bot-Api-Secret-Token", tgSecret);
    try {
      const r = await fetch(HOOK_TARGET + botSecret, { method: "POST", headers, body });
      return new Response("ok", { status: r.ok ? 200 : 500 });
    } catch (_e) {
      return new Response("upstream down", { status: 500 });
    }
  }

  const token = req.headers.get("x-bot-token") || "";
  if (!/^\d+:[A-Za-z0-9_-]{20,}$/.test(token)) {
    return new Response("no token", { status: 400 });
  }

  // /<секрет>/sendMessage → https://api.telegram.org/bot<токен>/sendMessage
  const method = rest.replace(/[^A-Za-z0-9_]/g, "");
  const target = UPSTREAM + "/bot" + token + "/" + method + url.search;

  const headers = new Headers(req.headers);
  headers.delete("host");
  headers.delete("content-length");
  headers.delete("x-bot-token");

  const body = req.method === "GET" || req.method === "HEAD" ? undefined : await req.arrayBuffer();
  const upstream = await fetch(target, { method: req.method, headers, body, redirect: "manual" });

  const outHeaders = new Headers(upstream.headers);
  outHeaders.delete("content-encoding");
  outHeaders.delete("content-length");
  return new Response(upstream.body, { status: upstream.status, headers: outHeaders });
});
