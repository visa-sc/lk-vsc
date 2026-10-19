# Админка eSIM — правки и выкладка (для Андрея Петрова)

С 19.10.2026 вы сами правите и выкладываете админку eSIM — страницу dev.voyomobile.ru
(она же вкладка «eSIM» на dev.voyotravel.ru). Это один файл: `esim-adm.html`.

Что можно: менять внешний вид, блоки, таблицы, фильтры, подписи, расчёты на странице.
Чего нельзя: серверную часть (данные, расчёты на сервере, витрину, бот). Если для правки
нужны новые данные с сервера — напишите Андрею, что нужно, добавим.

## Вход

    ssh spbadmin@89.108.88.59

Ключ — тот же, что для питерского сайта (andreipetrov@Andreis-MacBook-Air).

## Команды

    esimdeploy pull                     взять свежий боевой esim-adm.html в ~/esim-deploy
    esimdeploy status                   отличается ли ваш файл от боевого
    esimdeploy check                    проверить файл (кодировка, синтаксис скриптов), ничего не выкладывая
    esimdeploy deploy                   выложить (нужен ~/esim-deploy/CHANGELOG.md)
    esimdeploy rollback esim-adm.html   вернуть предыдущую версию
    esimdeploy log                      последние выкладки

## Порядок

1. `esimdeploy pull` — всегда перед правкой.
2. Правите `~/esim-deploy/esim-adm.html` (на сервере или у себя, потом копируете туда:
   `scp esim-adm.html spbadmin@89.108.88.59:esim-deploy/`).
3. `esimdeploy check`.
4. Пишете `~/esim-deploy/CHANGELOG.md`: первая строка — заголовок, дальше пункты «- …».
5. `esimdeploy deploy`. Служба сама проверит файл, сохранит прежнюю версию и убедится,
   что сайт отдаёт новую; если нет — вернёт как было.
6. Открываете dev.voyomobile.ru, проверяете (и на телефоне). Не так — `esimdeploy rollback esim-adm.html`.

Если боевой файл поменяли после вашего `pull` (Андрей что-то выложил), выкладка откажет:
сделайте `pull`, перенесите правки в свежую версию (она ляжет рядом как `esim-adm.html.prod`), выкладывайте снова.

## Как устроена страница

- Один HTML-файл со стилями и скриптом внутри. Внешних библиотек нет.
- Данные — `GET /esim/api/adm/stats?from=ГГГГ-ММ-ДД&to=…&test=1&fsrc=канал|метка`
  с заголовком `Authorization: Bearer <токен входа>` (страница берёт токен сама после входа).
  Ответ — объект `DATA`: `totals`, `days`, `channels`, `funnel` (с `sources`), `promos`,
  `smsCampaigns`, `service`, `support`, `customers`, `balances`, `spend` и др.
- Отрисовка — функции `render*()` в конце файла; секции — `<section class="sec" data-id="…">`.
- Цвета и размеры — переменные CSS в начале файла; держите стиль как у соседних блоков.

## Для вашего Claude

Вставьте ему:

> Админка eSIM VOYO — один файл esim-adm.html. Правки выкладываются только через сервер:
> ssh spbadmin@89.108.88.59, команды esimdeploy pull / check / deploy / rollback esim-adm.html.
> Перед правкой всегда esimdeploy pull, перед выкладкой — esimdeploy check и файл
> ~/esim-deploy/CHANGELOG.md (заголовок и пункты «- …»). Серверную часть не трогать — её нет в доступе.
> Данные страница получает из GET /esim/api/adm/stats (Bearer-токен после входа).
> Цифры для анализа без правок — по ключу X-Key: /esim/api/ro/stats (только чтение).
