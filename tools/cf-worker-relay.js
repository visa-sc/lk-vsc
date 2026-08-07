// ⚠️ НЕ ИСПОЛЬЗУЕТСЯ: домены workers.dev и pages.dev заблокированы в РФ на
// уровне TLS — прод-сервер до воркера не достучится (проверено 08.08.2026).
// Рабочий вариант — tools/deno-relay.ts (deno.dev с прода открывается).
// Файл оставлен на случай, если появится свой домен в зоне Cloudflare.
//
// Cloudflare Worker — ретранслятор к Anthropic API (для /translate).
// Зачем: Anthropic не обслуживает российские IP, а купленные прокси рвут
// запросы тяжелее ~32 КБ (проверено на двух IP proxy-seller). Воркер живёт в
// сети Cloudflare (не в РФ), бесплатный тариф, лимитов по размеру нам хватает.
//
// Как поставить (делает Андрей, ~5 минут, без карты):
//   1. dash.cloudflare.com → регистрация/вход.
//   2. Слева «Compute (Workers)» → «Create» → «Start with Hello World» → Deploy.
//   3. Открыть воркер → «Edit code» → вставить ЭТОТ файл целиком → Deploy.
//   4. Скопировать адрес воркера (вида https://<имя>.<аккаунт>.workers.dev) и
//      прислать Клоду — он пропишет ANTHROPIC_BASE_URL на прод-сервере.
//
// Секрет в пути: без него воркер отвечает 403, чтобы чужие не гоняли через него
// трафик за наш счёт. Секрет одноразовый, сгенерирован для VOYO.

const SECRET = "79d29c797f51f0f871a5c852e42a8151";
const UPSTREAM = "https://api.anthropic.com";

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const prefix = "/" + SECRET;
    if (!url.pathname.startsWith(prefix + "/")) {
      return new Response("forbidden", { status: 403 });
    }
    const target = UPSTREAM + url.pathname.slice(prefix.length) + url.search;
    // Прокидываем метод, заголовки и тело как есть — ключ Anthropic шлёт наш
    // сервер, воркер его не хранит и не логирует.
    const upstreamReq = new Request(target, request);
    upstreamReq.headers.delete("host");
    return fetch(upstreamReq);
  },
};
