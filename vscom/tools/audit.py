# -*- coding: utf-8 -*-
"""Предзапусковая проверка страниц ETA и файлов Google Ads."""
import io, os, re, json, urllib.request, html

BASE = "/Users/andrey/Documents/Бизнес/VOYO/lk-vsc-macbook/vscom"
DESK = os.path.expanduser("~/Desktop/ETA Brasil")

PAGES = {
    "br/gb.html":  ("pt-BR", "https://visa-sc.com/br/gb"),
    "es/gb.html":  ("es-ES", "https://visa-sc.com/es/gb"),
    "it/gb.html":  ("it-IT", "https://visa-sc.com/it/gb"),
    "us/gb.html":  ("en-US", "https://visa-sc.com/us/gb"),
}

# слова, за которые Google снимает объявления в этой тематике
BANNED = [
    r"\boficial do governo\b", r"\bsite do governo\b", r"\bgovernment site\b",
    r"\bweb del gobierno\b", r"\bsito del governo\b",
    r"\bgarantido\b", r"\bgarantizado\b", r"\bgarantito\b", r"\bguaranteed\b",
    r"aprova(ção|cion) garanti", r"approvazione garantita", r"100\s*%\s*(aprovad|approved|aprobad)",
    r"autorizado pelo governo", r"autorizado por el gobierno",
    r"autorizzato dal governo", r"government authoris",
    r"mais barato que o site oficial", r"más barato que la web oficial",
    r"cheaper than the official",
]
# обязательные элементы посадочной под политику Government documents
REQUIRED = {
    "br/gb.html": ["Não somos um órgão do governo", "gov.uk", "£20", "por conta própria"],
    "es/gb.html": ["No somos un organismo público", "gov.uk", "£20", "por tu cuenta"],
    "it/gb.html": ["Non siamo un ente pubblico", "gov.uk", "£20", "da solo"],
    "us/gb.html": ["We are not a government body", "gov.uk", "£20", "yourself"],
}
LEAK = {  # чужой язык на странице
    "es/gb.html": [r"\bvocê\b", r"\bpelo\b", r"\bviajante\b"],
    "it/gb.html": [r"\bvocê\b", r"\busted\b", r"\bviajero\b"],
    "us/gb.html": [r"\bvocê\b", r"\busted\b", r"\btu\b(?![a-z])"],
    "br/gb.html": [r"\busted\b", r"\bviaggiatore\b"],
}

problems, notes = [], []

print("=" * 74)
print("СТРАНИЦЫ")
print("=" * 74)
for rel, (lang, url) in PAGES.items():
    p = os.path.join(BASE, rel)
    s = io.open(p, encoding="utf-8").read()
    tag = rel.split("/")[0].upper()

    # живая доступность
    try:
        with urllib.request.urlopen(url, timeout=20) as r:
            code, live = r.status, r.read().decode("utf-8", "ignore")
        same = (len(live) == len(s))
    except Exception as e:
        code, same = str(e), False

    got_lang = (re.search(r'<html lang="([^"]+)"', s) or [None, "?"])[1]
    anchors = set(re.findall(r'<section[^>]*id="([^"]+)"', s))
    need_anchors = {"who", "form", "how", "faq", "contacts"}
    miss_anchors = need_anchors - anchors

    banned_hits = [b for b in BANNED if re.search(b, s, re.I)]
    req_miss = [r for r in REQUIRED[rel] if r not in s]
    leaks = [l for l in LEAK[rel] if re.search(l, s, re.I)]

    events = [e for e in ("form_start", "phone_click", "generate_lead", "gtag_report_conversion")
              if e in s]
    tiers = len(re.findall(r'<input type="radio" name="tier"', s))
    forms = len(re.findall(r"vsc-form", s))
    order_first = s.index('id="form"') < s.index('id="who"')

    ok = (code == 200 and same and got_lang == lang and not miss_anchors
          and not banned_hits and not req_miss and not leaks
          and len(events) == 4 and tiers == 3 and order_first)

    print(f"\n{tag}  {url}")
    print(f"   отдаётся {code}, совпадает с локальной: {same}")
    print(f"   lang={got_lang} (ждём {lang}) · тарифов {tiers} · форм {forms} · мастер выше описания: {order_first}")
    print(f"   якоря: {'все на месте' if not miss_anchors else 'НЕТ ' + ', '.join(sorted(miss_anchors))}")
    print(f"   события: {', '.join(events) if events else 'НЕТ'}")
    print(f"   дисклеймеры: {'все' if not req_miss else 'НЕ ХВАТАЕТ: ' + ', '.join(req_miss)}")
    print(f"   запрещённые формулировки: {'нет' if not banned_hits else 'НАЙДЕНЫ: ' + ', '.join(banned_hits)}")
    print(f"   чужой язык: {'нет' if not leaks else 'НАЙДЕН: ' + ', '.join(leaks)}")
    print(f"   ИТОГ: {'готово' if ok else 'ЕСТЬ ЗАМЕЧАНИЯ'}")
    if not ok:
        problems.append(f"{tag}: code={code} same={same} lang={got_lang} anchors={miss_anchors} "
                        f"banned={banned_hits} req={req_miss} leaks={leaks} events={events}")

print("\n" + "=" * 74)
print("ФАЙЛЫ GOOGLE ADS")
print("=" * 74)
files = sorted(os.listdir(DESK))
groups = {}
for f in files:
    camp = f.split(" — ")[0]
    groups.setdefault(camp, []).append(f)

for camp, fs in groups.items():
    kinds = {f.split(" — ")[1].replace(".html", "") for f in fs}
    s_ads = io.open(os.path.join(DESK, camp + " — объявления.html"), encoding="utf-8").read()
    s_key = io.open(os.path.join(DESK, camp + " — ключевые слова.html"), encoding="utf-8").read()
    s_neg = io.open(os.path.join(DESK, camp + " — минус-слова.html"), encoding="utf-8").read()

    heads = re.findall(r'<code>([^<]+)</code><span class="len(?: over)?">(\d+)', s_ads)
    over = [(html.unescape(t), int(n)) for t, n in heads if int(n) > 30 and len(html.unescape(t)) <= 40]
    conflict_ok = "0 конфликтов" in s_neg
    limits_ok = "всё в лимите" in s_ads
    urls = set(re.findall(r"https://visa-sc\.com/([a-z]{2}/[a-z]+)", s_ads + s_key))
    anchors_used = set(re.findall(r"visa-sc\.com/[a-z]{2}/[a-z]+#([a-z]+)", s_ads))
    ad_texts = [html.unescape(t) for t in re.findall(r'<code>([^<]*)</code>', s_ads)]
    joined = " | ".join(ad_texts)
    banned_hits = [b for b in BANNED if re.search(b, joined, re.I)]

    ok = (len(kinds) == 3 and conflict_ok and limits_ok and not banned_hits
          and anchors_used <= {"who", "form", "how", "faq"})
    print(f"\n{camp}")
    print(f"   файлов: {len(fs)} ({', '.join(sorted(kinds))})")
    print(f"   лимиты длин: {'ок' if limits_ok else 'ПРЕВЫШЕНИЕ'} · конфликты минус/ключи: {'нет' if conflict_ok else 'ЕСТЬ'}")
    print(f"   посадочные: {', '.join(sorted(urls))} · якоря ссылок: {', '.join(sorted(anchors_used))}")
    print(f"   текстов в объявлении: {len(ad_texts)} (15 заголовков + 4 описания + пути + дополнения)")
    print(f"   запрещённые формулировки: {'нет' if not banned_hits else 'НАЙДЕНЫ: ' + str(banned_hits)}")
    print(f"   ИТОГ: {'готово' if ok else 'ЕСТЬ ЗАМЕЧАНИЯ'}")
    if not ok:
        problems.append(f"{camp}: kinds={kinds} conflict_ok={conflict_ok} limits={limits_ok} "
                        f"banned={banned_hits} anchors={anchors_used}")

print("\n" + "=" * 74)
print("ПРОБЛЕМЫ:" if problems else "ПРОБЛЕМ НЕ НАЙДЕНО")
for x in problems:
    print("  ✗", x)
