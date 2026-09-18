#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Воронка eSIM до запуска живого счётчика (18.09.2026) — восстанавливаем по следам.

Сайт — из журнала nginx (хранится 15 дней). Витрина на каждом шаге ходит на
сервер, поэтому шаги видны однозначно:
  GET  /esim/api/catalog   — зашёл на витрину (если с /turkey, /china или ?c= — сразу и «выбрал страну»)
  POST /esim/api/price     — нажал «Купить» (открылось поле почты, считается цена)
  POST /esim/api/pay/start — нажал «Оплатить»
«Открыл пакет» сервер не видит (карточка открывается без запроса), поэтому за
восстановленные дни в этот шаг попадают только те, кто пошёл дальше.
Посетитель — хеш IP и браузера. Роботы, curl и заходы с админ-кодом отсекаются.

Бот — из его файлов: когда человек впервые нажал «Старт» (выдача
приветственного бонуса), до чего дошёл (последнее состояние чата) и заказы.

Пишет .esim/funnel-history.json. Живой счётчик этот файл не трогает, панель
складывает оба. Запуск на сервере: python3 tools/funnelBackfill.py
"""
import glob, gzip, hashlib, json, os, re
from datetime import datetime, timedelta, timezone

ROOT = "/var/www/voyo"
DIR = os.path.join(ROOT, ".esim")
MSK = timezone(timedelta(hours=3))
LIVE = json.load(open(os.path.join(DIR, "funnel.json")))
LIVE_SINCE = LIVE["since"] / 1000.0                   # с этой секунды шаги пишет живой счётчик

BOTS = re.compile(r"bot|crawl|spider|slurp|preview|headless|curl|python|wget|axios|node-fetch|go-http|java/|"
                  r"httpclient|monitor|uptime|facebookexternal|lighthouse|pagespeed|scan", re.I)
LINE = re.compile(r'^(\S+) \S+ \S+ \[([^\]]+)\] "(\S+) (\S+) [^"]*" (\d{3}) \S+ "([^"]*)" "([^"]*)"')
# витрина открыта сразу на стране: рекламные страницы и ссылки из статей (?c=TR)
COUNTRY_REF = re.compile(r"voyomobile\.(ru|com)/(turkey|china|vietnam|thailand|egypt|georgia|japan)\b|[?&]c=[A-Za-z-]{2,}")
STEP = {("GET", "/esim/api/catalog"): "visit", ("POST", "/esim/api/price"): "buy", ("POST", "/esim/api/pay/start"): "pay"}
ORDER = ["visit", "country", "pack", "buy", "pay"]    # кто сделал шаг, прошёл и все предыдущие


def day_of(ts):
    return datetime.fromtimestamp(ts, MSK).strftime("%Y-%m-%d")


days = {}


def hit(day, src, step, vid):
    days.setdefault(day, {}).setdefault(src, {}).setdefault(step, set()).add(vid)


# ── сайт: журнал nginx ─────────────────────────────────────────────
files = sorted(glob.glob("/var/log/nginx/access.log*"))
seen = 0
for fn in files:
    op = gzip.open if fn.endswith(".gz") else open
    with op(fn, "rt", errors="replace") as fh:
        for line in fh:
            if "/esim/api/" not in line:
                continue
            m = LINE.match(line)
            if not m:
                continue
            ip, t, method, url, status, ref, ua = m.groups()
            path = url.split("?")[0]
            step = STEP.get((method, path))
            if not step or not status.startswith("2") or "adm=" in url or BOTS.search(ua or ""):
                continue
            ts = datetime.strptime(t, "%d/%b/%Y:%H:%M:%S %z").timestamp()
            if ts >= LIVE_SINCE:
                continue
            vid = "h" + hashlib.sha1((ip + "|" + ua).encode()).hexdigest()[:14]
            d = day_of(ts)
            for s in ORDER[:ORDER.index(step) + 1]:
                hit(d, "site", s, vid)
            if step == "visit" and COUNTRY_REF.search(ref or ""):
                hit(d, "site", "country", vid)
            seen += 1

# ── бот: первый «Старт», последнее состояние, заказы ───────────────
state = json.load(open(os.path.join(DIR, "tgstate.json")))
welcome = json.load(open(os.path.join(DIR, "tgwelcome.json")))
orders = json.load(open(os.path.join(DIR, "orders.json")))
bot_orders = {}
for o in orders:
    if o.get("tgChatId") and o.get("ts") and not o.get("parentOrderId"):
        bot_orders.setdefault(str(o["tgChatId"]), []).append(o)

chats = set(state) | set(welcome) | set(bot_orders)
for chat in chats:
    st = state.get(chat, {})
    own = sorted(bot_orders.get(chat, []), key=lambda o: o["ts"])
    first = welcome.get(chat) or (own[0]["ts"] if own else st.get("ts"))
    if not first or first / 1000.0 >= LIVE_SINCE:
        continue
    vid = "tg" + chat
    d0 = day_of(first / 1000.0)
    hit(d0, "bot", "start", vid)
    if st.get("iso") or own:
        hit(d0, "bot", "country", vid)
    if st.get("productId") or own:
        hit(d0, "bot", "pack", vid)
    for o in own:                                      # ссылка на оплату: день заказа
        if o["ts"] / 1000.0 >= LIVE_SINCE:
            continue
        d = day_of(o["ts"] / 1000.0)
        for s in ("start", "country", "pack", "pay"):
            hit(d, "bot", s, vid)

out_days = {d: {src: {k: sorted(v) for k, v in steps.items()} for src, steps in srcs.items()} for d, srcs in days.items()}
first_day = min(out_days) if out_days else day_of(LIVE_SINCE)
since = datetime.strptime(first_day, "%Y-%m-%d").replace(tzinfo=MSK).timestamp() * 1000
json.dump({"since": int(since), "builtAt": int(datetime.now().timestamp() * 1000), "until": int(LIVE_SINCE * 1000),
           "note": "восстановлено по журналу nginx и файлам бота", "days": out_days},
          open(os.path.join(DIR, "funnel-history.json"), "w"), ensure_ascii=False)

print("журналов:", len(files), "| событий сайта:", seen, "| дней:", len(out_days), "| с", first_day)
for d in sorted(out_days):
    site = out_days[d].get("site", {}); bot = out_days[d].get("bot", {})
    print(" ", d, "сайт", {k: len(site.get(k, [])) for k in ORDER}, "| бот", {k: len(bot.get(k, [])) for k in ("start", "country", "pack", "pay")})
