# -*- coding: utf-8 -*-
import sys, os, re
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from gen import page, write, lines_block

DIR = "ETA Brasil"
import html as H

def norm(s): return re.sub(r"\s+", " ", s.strip().lower())
def strip_kw(k):
    k = k.strip()
    if k[:1] in "[\"" and k[-1:] in "]\"": return k[1:-1]
    return k
def blocks(n, q):
    n, q = norm(n), norm(q)
    if n.startswith('"') and n.endswith('"'):
        return re.search(r"(?<!\w)" + re.escape(n[1:-1]) + r"(?!\w)", q) is not None
    return all(w in set(q.split()) for w in n.split())

POLICY = """<pre style="max-height:none">ЭТО САМАЯ ЗАРЕГУЛИРОВАННАЯ ТЕМАТИКА В GOOGLE ADS. Прочитайте до запуска.

1. НУЖНА СЕРТИФИКАЦИЯ АККАУНТА

   Политика «Government documents and services» разрешает такую рекламу только
   государственным органам и «авторизованным провайдерам». Без сертификата
   объявления будут отклонены — не после показов, а сразу.

   Заявка подаётся в Google Ads: Инструменты → Настройка → Сертификаты
   («Документы и услуги государственных органов»). Там же выбирается
   основание. Посреднику подходит вариант с исключением по политике.

   Параллельно нужна верификация рекламодателя — она у вас уже пройдена
   по визовому аккаунту, повторно не потребуется.

2. С 5 ОКТЯБРЯ 2026 ТРЕБОВАНИЯ УЖЕСТОЧАЮТСЯ

   По отраслевым сообщениям, Google начнёт требовать, чтобы домен был указан
   как авторизованный на официальном сайте правительства. Для посредников
   это фактически закрывает канал. То есть окно для теста — три недели.

3. ЧЕГО НЕЛЬЗЯ ПИСАТЬ НИКОГДА

   «oficial», «governo», «site do governo», «autorizado pelo governo»
       — присвоение государственного статуса, мгновенный бан.
   «garantido», «aprovação garantida», «100% aprovado»
       — обещание результата, которого мы не контролируем.
   «visto para o Reino Unido»
       — бразильцам нужна ETA, а не виза; это несоответствие странице.
   «mais barato que o site oficial»
       — сравнение с государственной пошлиной, вводит в заблуждение.

4. ЧТО ОБЯЗАНО БЫТЬ НА ПОСАДОЧНОЙ (уже сделано)

   Блок «Não somos um órgão do governo» со ссылкой на официальный портал,
   раздельные суммы (госпошлина отдельно, наша работа отдельно),
   прямой текст о том, что заявку можно подать самостоятельно.</pre>"""


def make(slug, camp_name, title, sub, url, exact, phrase, neg_groups, neg_decide,
         protect, heads, descs, paths, brand, callouts, snippets, sitelinks,
         intro_k, intro_m, bid, geo_note, lang_name, exact_hint, policy):
    keys = [strip_kw(k) for k in exact + phrase]
    neg_all = [n for g in neg_groups for n in g["items"]] + neg_decide["items"]
    conf = [(n, k) for n in neg_all for k in keys if blocks(n, k)]
    check_m = ("Автопроверка: %d минус-слов × %d ключей — <b>0 конфликтов</b>."
               % (len(neg_all), len(keys))) if not conf else \
              "КОНФЛИКТЫ: " + "; ".join("%s ✕ %s" % c for c in conf[:10])
    print(f"{slug}: ключей {len(keys)}, минусов {len(neg_all)}, конфликтов {len(conf)}", conf[:5])

    # ── ключи ──
    write(f"{camp_name} — ключевые слова.html",
          page(f"{camp_name} — ключевые слова", sub, [
              {"title": "Точное соответствие", "badge": ("b-must", "обязательно"),
               "hint": exact_hint,
               "text": "\n".join(exact), "count": "%d шт." % len(exact)},
              {"title": "Фразовое соответствие", "badge": ("b-must", "обязательно"),
               "hint": "Здесь основной объём: длинные хвосты вокруг цены, сроков и «нужна ли она мне».",
               "text": "\n".join(phrase), "count": "%d шт." % len(phrase)},
              {"title": "Настройки кампании", "hint": "", "html": f"""<pre style="max-height:none">{geo_note}
Язык: {lang_name}
Стратегия: Максимум кликов, предельная цена клика {bid}
Бюджет: 15 $ в день
Конечный URL: {url}
Суффикс конечного URL:
utm_source=google&amp;utm_medium=cpc&amp;utm_campaign={slug}&amp;utm_term={{keyword}}&amp;utm_content={{creative}}&amp;matchtype={{matchtype}}&amp;device={{device}}</pre>
<p class="note">Обязательно проверьте колонку «Тип соответствия» после заливки: скобки и кавычки
теряются при вставке, на этом мы уже потеряли 77 $ на кампании по ВНЖ.</p>"""},
          ], None, False, intro_k), DIR)

    # ── минуса ──
    bl_m = []
    for g in neg_groups:
        bl_m.append({"title": g["title"], "badge": ("b-must", "обязательно"),
                     "hint": g["hint"], "text": "\n".join(g["items"]),
                     "count": "%d шт." % len(g["items"])})
    bl_m.append({"title": neg_decide["title"], "badge": ("b-opt", "на ваш выбор"),
                 "hint": neg_decide["hint"], "text": "\n".join(neg_decide["items"]),
                 "count": "%d шт." % len(neg_decide["items"])})
    bl_m.append({"title": "Что НЕ переносить", "danger": True, "hint": "",
                 "html": '<pre style="max-height:none">%s</pre>' % protect})
    write(f"{camp_name} — минус-слова.html",
          page(f"{camp_name} — минус-слова",
               "Настройки кампании → Минус-слова → Добавить в кампанию.",
               bl_m, check_m, bool(conf), intro_m), DIR)

    # ── объявления ──
    bad = [h for h in heads if len(h) > 30] + [d for d in descs if len(d) > 90] + \
          [p for p in paths if len(p) > 15] + [c for c in callouts if len(c) > 25]
    check_a = ("Автопроверка длин: заголовки ≤30, описания ≤90, пути ≤15, уточнения ≤25 — "
               "<b>всё в лимите</b> (%d заголовков, %d описания)." % (len(heads), len(descs))) \
              if not bad else "ПРЕВЫШЕНИЕ: " + " | ".join(bad)
    print("   объявления:", "ок" if not bad else bad)

    sl_html = ""
    for i, sl in enumerate(sitelinks):
        sl_html += ('<p class="hint" style="margin:16px 0 6px"><b>Ссылка %d</b></p>' % (i + 1)) + \
                   lines_block(list(sl), None, "sl%d" % i)

    write(f"{camp_name} — объявления.html",
          page(f"{camp_name} — объявления",
               f"Адаптивное поисковое объявление, язык — {lang_name}. {url}", [
                   {"title": "Прочитайте до запуска", "danger": True, "hint": "", "html": policy},
                   {"title": "15 заголовков", "badge": ("b-must", "обязательно"),
                    "hint": "Каждый в своё поле, лимит 30 знаков. Цифра справа — длина.",
                    "html": lines_block(heads, 30, "h15")},
                   {"title": "4 описания", "badge": ("b-must", "обязательно"),
                    "hint": "Лимит 90 знаков.", "html": lines_block(descs, 90, "d4")},
                   {"title": "Отображаемые пути", "badge": ("b-must", "обязательно"),
                    "hint": "Два поля после visa-sc.com.", "html": lines_block(paths, 15, "paths")},
                   {"title": "Название компании", "hint": "До 25 знаков.",
                    "html": lines_block([brand], 25, "brand")},
                   {"title": "Уточнения", "badge": ("b-opt", "очень желательно"),
                    "hint": "Дополнения → Уточнения, лимит 25 знаков.",
                    "html": lines_block(callouts, 25, "callouts")},
                   {"title": "Структурированные описания", "badge": ("b-opt", "очень желательно"),
                    "hint": "Дополнения → Структурированные описания → «Услуги», лимит 25 знаков.",
                    "html": lines_block(snippets, 25, "snip")},
                   {"title": "Дополнительные ссылки", "badge": ("b-opt", "очень желательно"),
                    "hint": "Порядок полей: текст (до 25), описание 1 (до 35), описание 2 (до 35), URL.",
                    "html": sl_html},
               ], check_a, bool(bad)), DIR)
