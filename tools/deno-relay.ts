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

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);
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
