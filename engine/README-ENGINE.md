# Движок ИИ-переводов VOYO — теперь ваш сервис (`translate-engine`)

Памятка для Claude Code Кати. С 22.08.2026 движок перевода вынесен из основного
приложения в отдельный сервис, который принадлежит вам и правится без Андрея.

## Где и как

| | |
|---|---|
| Папка | `/var/www/translate-engine` (владелец `kateadmin` — ваш юзер) |
| Код | `translate.js` — весь движок (~2000 строк), `engine-server.js` — обёртка (express, порт 3003), `mail.js` — шим почты |
| Данные | `.translate/orders.json` (заказы, правила-lessons, токены) и `.translate/files/` (исходники и результаты, ПДн клиентов — чистятся через 60 дней) |
| Процесс | pm2 под вашим юзером: `pm2 status`, `pm2 logs translate-engine`, `pm2 restart translate-engine` |
| Зависимости | `node_modules` (express, multer, pdf-lib, html-to-docx, mammoth, adm-zip, @anthropic-ai/sdk, puppeteer); Chromium для PDF — в `.chrome/` |
| Настройки | `.env` (порт, секрет моста, модели) — см. ниже, что трогать нельзя |

Запросы к движку приходят **только** через основное приложение: `work.voyotravel.ru/translate/api/*`
→ ваш портал (:3002) → основное (:3000, проверяет токен и кладёт роль в заголовок
`x-voyo-staff`) → движок (:3003). Напрямую снаружи на :3003 никто не ходит.

После правки кода:

```bash
cd /var/www/translate-engine && node --check translate.js && pm2 restart translate-engine && pm2 logs translate-engine --lines 20
curl -s http://127.0.0.1:3003/engine/health
```

## Что в движке есть (и что вы можете менять)

- **Промпты и логика перевода** — `SYS_COMMON`, `pipelineTranslate` (перевод → проверка → авто-исправление), `runCheck`, `pipelineCorrect` (правки), `pipelineCompare`/`learnFromCompare` (обучение на архивах), правила-lessons.
- **Сборка файлов** — `buildOutputs`: HTML → DOCX (html-to-docx) и **PDF** (headless Chromium, `htmlToPdf`, постранично по `section.page`, ориентация по заказу). Результат выбирается по полю `to` заказа портала (PDF/DOCX; JPG/PNG/TXT → PDF с пояснением в `error`).
- **Мост с вашим модулем** — `portalOrderIntake` (meta+files), `portalGroupReport` (отчёт на ваш server/report), `portalLearnReport` (learn-cost), `/translate/api/portal/correct`, `/translate/api/dl/:id/:token/(pdf|docx|html)`.
- Страница сотрудников `/translate` и `/translate_pay` (SaaS-черновик) — их вёрстка лежит на основном приложении (Андрея), но их API — это тоже этот движок.

## Чего менять НЕЛЬЗЯ (и почему это не сработает)

1. **Модель.** Ключа Anthropic в движке нет. `ANTHROPIC_BASE_URL` указывает на шлюз
   основного приложения (`http://127.0.0.1:3000/internal/anthropic`), а `ANTHROPIC_API_KEY`
   здесь — просто секрет моста. Шлюз держит модель в **белом списке**
   (`claude-sonnet-5`, `claude-haiku-4-5`): любую другую модель он молча подменяет на
   `claude-sonnet-5`. Менять `TRANSLATE_MODEL*` в `.env` или в коде бесполезно — и не нужно.
2. **Бюджет.** Шлюз считает расход по каждому ответу и при **15 $ за сутки** (МСК,
   ≈1200 ₽) начинает отвечать 429 «бюджет исчерпан» — заказ уйдёт в
   ошибку, менеджер увидит текст. На 80% и 100% Андрею приходит письмо. Поэтому
   **не заводите регулярные задачи (setInterval/cron), которые гоняют документы через
   ИИ без человека** — они упрутся в лимит и остановят живые заказы. Прогоны обучения —
   только руками, по мере надобности. Нужен больше лимит — это к Андрею (.env основного).
3. `.env` движка: `ENGINE_SECRET`, `ANTHROPIC_*`, `MAIN_URL`, `PORT` — не трогать, иначе движок
   потеряет связь с шлюзом и почтой.
4. Почта — через `mail.js` (шим к основному приложению); SMTP-паролей здесь нет и не нужно.

## Если что-то сломалось

- `pm2 logs translate-engine --lines 50` — ошибки движка.
- 502 «Движок переводов временно недоступен» на странице — сервис упал: `pm2 restart translate-engine`.
- Ошибка `engine secret mismatch` — сломан `.env`; Андрей может выдать секрет заново.
- 429 в заказах — суточный бюджет; ждать полуночи МСК или писать Андрею.
- Откат кода — `git`/бэкапы ведёте сами; стартовая версия 22.08 сохранена у Андрея в репозитории (`engine/translate.js`).
