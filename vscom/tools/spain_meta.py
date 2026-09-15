# -*- coding: utf-8 -*-
"""spain.visa-sc.com/fb — копия страницы /ga под рекламу в Facebook и Instagram.

/ga уже очищена под модерацию Google (без «без налогов», процентов одобрения и
гарантии возврата), поэтому берём её. Отличия копии:
  * из контактов убраны офисы в Барселоне и Лондоне: их нет, а выдуманный адрес
    в рекламе Meta — обман и повод для бана; остаётся московский офис;
  * свой id формы spain-fb, чтобы заявки из Meta не путались с Google;
  * fbclid в метках заявки и пиксель Meta.
Исходную /ga не трогаем. Пересборка: python3 spain_meta.py
"""
import io, os, re
from build_eta import meta_pixel

BASE = "/Users/andrey/Documents/Бизнес/VOYO/lk-vsc-macbook/vscom/spain"
META_PIXEL = ""          # ID пикселя VSC из Events Manager
META_VERIFY = ""         # метатег подтверждения домена visa-sc.com

src = io.open(os.path.join(BASE, "ga.html"), encoding="utf-8").read()
html = src


def must(old, new, count=1):
    global html
    n = html.count(old)
    if n != count:
        raise SystemExit("ожидал %d вхождений, нашёл %d: %s" % (count, n, old[:60]))
    html = html.replace(old, new)


# офисы, которых нет
html, n = re.subn(r'\s*<div class="office">\s*<b>(Barcelona|London)[^<]*</b>[\s\S]*?</div>', "", html)
if n != 2:
    raise SystemExit("офисы Барселоны и Лондона: ожидал 2 блока, нашёл %d" % n)

must('<link rel="canonical" href="https://spain.visa-sc.com/ga">',
     '<link rel="canonical" href="https://spain.visa-sc.com/fb">')
must('<meta property="og:url" content="https://spain.visa-sc.com/ga">',
     '<meta property="og:url" content="https://spain.visa-sc.com/fb">')
must('"gclid","yclid"]', '"gclid","yclid","fbclid"]')

k = html.count("spain-ga")
html = html.replace("spain-ga", "spain-fb")
print("id формы spain-ga -> spain-fb:", k)

html = html.replace("</head>", meta_pixel({"pixel_id": META_PIXEL, "fb_verify": META_VERIFY,
                                           "cur_code": "EUR"}) + "</head>", 1)

left = re.findall(r"Portland|Passeig|W1W|Eixample", html)
if left:
    raise SystemExit("остались адреса: %s" % left)

out = os.path.join(BASE, "fb.html")
io.open(out, "w", encoding="utf-8").write(html)
print("написано:", out, len(html), "байт")
