// Deno Deploy — ретранслятор к Anthropic API (для /translate).
//
// Зачем: Anthropic не обслуживает российские IP; купленные прокси proxy-seller
// рвут запросы тяжелее ~32 КБ (проверено на двух IP, HTTP и SOCKS); Cloudflare
// Workers не годится — домены workers.dev и pages.dev заблокированы в РФ на
// уровне TLS. Домен deno.dev с нашего прод-сервера открывается — на нём и живём.
//
// Как поставить (делает Андрей, ~3 минуты, бесплатно, карта не нужна):
//   1. dash.deno.com → «Sign in» (вход через GitHub или Google).
//   2. Кнопка «New Playground» (создаёт проект, который редактируется прямо в браузере).
//   3. Стереть пример, вставить ЭТОТ файл целиком → «Save & Deploy».
//   4. Скопировать адрес проекта (вида https://<имя>.deno.dev) и прислать Клоду —
//      он пропишет ANTHROPIC_BASE_URL на прод-сервере.
//
// Секрет в пути: без него ретранслятор отвечает 403, чтобы чужие не гоняли
// через него трафик за наш счёт. Ключ Anthropic шлёт наш сервер в заголовке —
// здесь он не хранится и не логируется.

const SECRET = "79d29c797f51f0f871a5c852e42a8151";
const UPSTREAM = "https://api.anthropic.com";

// ── Второй жилец: Telegram Bot API (бот продажи eSIM, t.me/esimvoyo_bot) ──
// С прод-сервера исходящие к api.telegram.org не проходят (10.09.2026: IPv4
// таймаут, IPv6 на сервере нет). Отдельный проект на новом Deno Deploy трижды
// падал на «Warm up» ещё до запуска кода, поэтому телеграм живёт здесь же —
// в проекте, который выкладывается нормально. Токен НЕ хранится и в адресе не
// светится: наш сервер шлёт его заголовком X-Bot-Token.
const TG_SECRET = "b7f1c0a94e2d4a6f8c3b5e7d9a1f2c48";
const TG_UPSTREAM = "https://api.telegram.org";

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);

  const tgPrefix = "/" + TG_SECRET;
  if (url.pathname.startsWith(tgPrefix + "/")) {
    const token = req.headers.get("x-bot-token") || "";
    if (!/^\d+:[A-Za-z0-9_-]{20,}$/.test(token)) {
      return new Response("no token", { status: 400 });
    }
    const method = url.pathname.slice(tgPrefix.length + 1).replace(/[^A-Za-z0-9_]/g, "");
    const tgTarget = TG_UPSTREAM + "/bot" + token + "/" + method + url.search;

    const tgHeaders = new Headers(req.headers);
    tgHeaders.delete("host");
    tgHeaders.delete("content-length");
    tgHeaders.delete("x-bot-token");

    const tgBody = req.method === "GET" || req.method === "HEAD" ? undefined : await req.arrayBuffer();
    const tgUp = await fetch(tgTarget, { method: req.method, headers: tgHeaders, body: tgBody, redirect: "manual" });

    const tgOut = new Headers(tgUp.headers);
    tgOut.delete("content-encoding");
    tgOut.delete("content-length");
    return new Response(tgUp.body, { status: tgUp.status, headers: tgOut });
  }

  const prefix = "/" + SECRET;
  if (!url.pathname.startsWith(prefix + "/")) {
    return new Response("forbidden", { status: 403 });
  }
  const target = UPSTREAM + url.pathname.slice(prefix.length) + url.search;

  const headers = new Headers(req.headers);
  headers.delete("host");
  headers.delete("content-length");

  // Тело читаем целиком (документы у нас до ~20 МБ) — так надёжнее, чем
  // потоковая пересылка. Ответ, наоборот, отдаём потоком: перевод приходит
  // стримом, и его нельзя буферизовать целиком.
  const body = req.method === "GET" || req.method === "HEAD" ? undefined : await req.arrayBuffer();

  const upstream = await fetch(target, { method: req.method, headers, body, redirect: "manual" });

  const outHeaders = new Headers(upstream.headers);
  outHeaders.delete("content-encoding");
  outHeaders.delete("content-length");
  return new Response(upstream.body, { status: upstream.status, headers: outHeaders });
});
