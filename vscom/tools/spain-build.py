# -*- coding: utf-8 -*-
"""Собираю spain.visa-sc.com из зеркала visa-sc.ru/spain_vnzh/: раскладываю статику
по абсолютным путям и меняю телефон и почту."""
import os, re, shutil

SRC = "/root/spainmirror/visa-sc.ru"
RAW = "/root/spainmirror/raw.html"
DST = "/var/www/spain-visa-sc-com"

if os.path.isdir(DST):
    shutil.rmtree(DST)
os.makedirs(DST)

copied = 0
for dirpath, _, names in os.walk(SRC):
    rel_dir = os.path.relpath(dirpath, SRC)
    if rel_dir.split(os.sep)[0] == "spain_vnzh":
        continue
    for n in names:
        # wget сохранял query прямо в имени файла — nginx query отбрасывает,
        # поэтому имя приводим к тому, что реально запросит браузер
        clean = n.split("?")[0]
        if not clean:
            continue
        out_dir = os.path.join(DST, "" if rel_dir == "." else rel_dir)
        os.makedirs(out_dir, exist_ok=True)
        dst = os.path.join(out_dir, clean)
        if os.path.exists(dst) and os.path.getsize(dst) >= os.path.getsize(os.path.join(dirpath, n)):
            continue
        shutil.copy2(os.path.join(dirpath, n), dst)
        copied += 1

html = open(RAW, encoding="utf-8").read()

PHONE_HTML = "+7 (499) 325-64-74"
PHONE_TEL = "+74993256474"

subs = [
    # парные питерские номера схлопываем в один, иначе номер продублируется
    ("+7 (812) 244-04-68, +7 (812) 220-03-65", PHONE_HTML),
    ("+7 (495) 369-18-67", PHONE_HTML),
    ("+7 (499) 938-53-58", PHONE_HTML),
    ("+7 (812) 244-04-68", PHONE_HTML),
    ("+7 (812) 220-03-65", PHONE_HTML),
    ("+74953691867", PHONE_TEL),
    ("+74999385358", PHONE_TEL),
    ("director@visa-sc.ru", "info@visa-sc.ru"),
]
for a, b in subs:
    n = html.count(a)
    if n:
        html = html.replace(a, b)
    print("замена %-42s -> %-20s : %d" % (a, b, n))

open(os.path.join(DST, "index.html"), "w", encoding="utf-8").write(html)
print("файлов статики:", copied)

left = re.findall(r"\+7[0-9]{10}|\+7 \([0-9]{3}\) [0-9-]{7,}", html)
import collections
print("номера в итоговом html:", dict(collections.Counter(left)))
print("почты:", dict(collections.Counter(re.findall(r"[a-zA-Z0-9._%-]+@[a-zA-Z0-9.-]+\.[a-z]{2,}", html))))
