# -*- coding: utf-8 -*-
"""Дотягиваю картинки и прочую статику, которую wget не разобрал (srcset, data-*, css url())."""
import re, os, sys, urllib.request, urllib.parse

ROOT = "/root/spainmirror/visa-sc.ru"
BASE = "https://visa-sc.ru"
UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36"

paths = set()
pat = re.compile(r'(?<![\w.])/(?:img|_s|files|_app|api)/[A-Za-z0-9._/@%~-]+(?:\?[A-Za-z0-9._=&%-]*)?')

for dirpath, _, names in os.walk(ROOT):
    for n in names:
        if not n.endswith((".html", ".css", ".js", ".mjs")) and "?" not in n:
            continue
        p = os.path.join(dirpath, n)
        try:
            txt = open(p, encoding="utf-8", errors="ignore").read()
        except Exception:
            continue
        for m in pat.findall(txt):
            paths.add(m)

print("нашёл путей:", len(paths))

ok = fail = skip = 0
for p in sorted(paths):
    # wget сохранял файлы вместе с query в имени — повторяем ту же схему
    rel = p.lstrip("/")
    local = os.path.join(ROOT, rel)
    if os.path.exists(local) and os.path.getsize(local) > 0:
        skip += 1
        continue
    os.makedirs(os.path.dirname(local), exist_ok=True)
    url = BASE + urllib.parse.quote(p, safe="/?=&%.@~-")
    try:
        req = urllib.request.Request(url, headers={"User-Agent": UA, "Referer": BASE + "/spain_vnzh/"})
        data = urllib.request.urlopen(req, timeout=30).read()
        open(local, "wb").write(data)
        ok += 1
    except Exception as e:
        fail += 1
        print("  ! %s -> %s" % (p, e))

print("скачано:", ok, "| уже было:", skip, "| не вышло:", fail)
