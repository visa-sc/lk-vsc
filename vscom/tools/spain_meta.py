# -*- coding: utf-8 -*-
"""spain.visa-sc.com/fb — посадочная под рекламу в Facebook и Instagram.

Компоновка — от /ga (первый экран с мессенджерами, «Что даёт статус», «С чем
уйдёте после консультации» и т.д.). С 13.10.2026 формулировки в блоках, общих
с исходной страницей, — прямые, как на visa-sc.ru/spain_vnzh/ (решение Андрея:
Meta не отклоняет «ВНЖ Испании», как Google). Общие блоки берём из spain/index.html:
первый экран (заголовок, абзац, факты), все три формы, программы, «Как мы работаем»,
отказы, заголовок команды, FAQ, заголовок контактов.

Прочее:
  * контакты — только настоящий офис (Москва) с номерами 495/499, как на visa-sc.ru;
    выдуманных адресов нет: за них Meta банит, и это обман клиента; в шапке +44;
  * свои id форм spain-fb*, fbclid в метках, пиксель Meta;
  * отслеживание: клики по телефонам, начало заполнения, мессенджеры, заявки — в
    Google, Метрику, пиксель (через обёртку gtag из build_eta) и наш журнал на сервере.
Исходные /ga и index не трогаем. Пересборка: python3 spain_meta.py
"""
import io, os, re
from build_eta import meta_pixel, strip_gads

BASE = "/Users/andrey/Documents/Бизнес/VOYO/lk-vsc-macbook/vscom/spain"
META_PIXEL = "1329364073594329"          # пиксель «VSC ETA» из сетапа BroCard
META_VERIFY = "f2ko3or5swjxp3imio4ohdfqrjap3e"         # метатег подтверждения домена visa-sc.com

idx = io.open(os.path.join(BASE, "index.html"), encoding="utf-8").read()
html = io.open(os.path.join(BASE, "ga.html"), encoding="utf-8").read()


def must(old, new, count=1):
    global html
    n = html.count(old)
    if n != count:
        raise SystemExit("ожидал %d вхождений, нашёл %d: %s" % (count, n, old[:70]))
    html = html.replace(old, new)


def region(s, a, b):
    """Кусок s от начала a до конца b (включительно)."""
    i = s.index(a)
    return s[i:s.index(b, i) + len(b)]


def section(s, marker):
    """Содержимое <div class="container"> секции после комментария-маркера."""
    i = s.index(marker)
    a = s.index('<div class="container">', i)
    b = s.index("\n</section>", a)
    return s[a:b]


def swap_section(ga_marker, idx_marker):
    global html
    html = html.replace(section(html, ga_marker), section(idx, idx_marker), 1)


# ── <head>: тексты исходной страницы ──
html = re.sub(r"<title>.*?</title>", lambda _: re.search(r"<title>.*?</title>", idx).group(0), html, 1)
for prop in ('name="description"', 'property="og:title"', 'property="og:description"'):
    pat = r'<meta %s content="[^"]*">' % re.escape(prop)
    m = re.search(pat, idx).group(0)
    html = re.sub(pat, lambda _: m, html, 1)
must('<link rel="canonical" href="https://spain.visa-sc.com/ga">',
     '<link rel="canonical" href="https://spain.visa-sc.com/fb">')
must('<meta property="og:url" content="https://spain.visa-sc.com/ga">',
     '<meta property="og:url" content="https://spain.visa-sc.com/fb">')
# конверсии Google Ads на странице под Meta не нужны
html = strip_gads(html)
html = html.replace("</head>", meta_pixel({"pixel_id": META_PIXEL, "fb_verify": META_VERIFY, "form": "spain-fb",
                                           "cur_code": "EUR"}) + "</head>", 1)

# ── шапка: подпись кнопки как на исходной ──
must('<span class="lbl-l">Бесплатная консультация</span>', '<span class="lbl-l">Заказать звонок</span>')

# ── первый экран: заголовок, абзац и факты — исходные, заголовок как на visa-sc.ru ──
html = html.replace(region(html, "<h1", '<div class="facts">'), region(idx, "<h1", '<div class="facts">'), 1)
html = html.replace(region(html, '<div class="facts">', "</div>\n    </div>"),
                    region(idx, '<div class="facts">', "</div>\n    </div>"), 1)
h1 = re.search(r'(<h1[^>]*>)([\s\S]*?)(</h1>)', html)
html = html.replace(h1.group(0), h1.group(1) + """
        Ездить в Европу, как раньше,<br>
        с <span class="hl">ВНЖ Испании</span>!<br>
        <span class="hl">За 3 месяца</span> сразу <span class="hl">на 3 года</span>,<br>
        <span class="hl">без</span> проживания и <span class="hl">налогов</span>.
      """ + h1.group(3), 1)
must("<b>от 1 месяца</b>", "<b>от 3 месяцев</b>")

# ── формы: тексты исходных, id свои ──
for ga_id, idx_id, fb_id in (("spain-ga", "spain", "spain-fb"),
                             ("spain-ga-bottom", "spain-bottom", "spain-fb-bottom"),
                             ("spain-ga-modal", "spain-modal", "spain-fb-modal")):
    old = region(html, '<form class="vsc-form" data-form="%s">' % ga_id, "</form>")
    new = region(idx, '<form class="vsc-form" data-form="%s">' % idx_id, "</form>")
    html = html.replace(old, new.replace('data-form="%s"' % idx_id, 'data-form="%s"' % fb_id), 1)

# ── смежные блоки: формулировки исходной, обёртки секций (фон, id) — от /ga ──
swap_section("<!-- ============ ПРОГРАММЫ", "<!-- ============ ПРОГРАММЫ")
swap_section("<!-- ============ КАК ПРОХОДИТ", "<!-- ============ КАК РАБОТАЕМ")
swap_section("<!-- ============ ОТКАЗЫ", "<!-- ============ ОТКАЗЫ")
swap_section("<!-- ============ КОМАНДА", "<!-- ============ КОМАНДА")
swap_section("<!-- ============ FAQ", "<!-- ============ FAQ")
# подписи команды — как на visa-sc.ru: люди работают в Москве и Петербурге
must("по работе с клиентами, Барселона", "по работе с клиентами, Москва")
must("по работе с клиентами, Мадрид", "по работе с клиентами, Санкт-Петербург")

# ── контакты ──
must('<section class="section" id="contacts">\n  <div class="container">\n',
     '<section class="section" id="contacts">\n  <div class="container">\n'
     '    <h2>Приняли решение оформлять с нами?</h2>\n')
html, n = re.subn(r'\s*<div class="office">\s*<b>(Barcelona|London)[^<]*</b>[\s\S]*?</div>', "", html)
if n < 1:
    raise SystemExit("офис Barcelona не найден")
PH = ('<a href="tel:+74953691867">+7 (495) 369-18-67</a><br>\n'
      '          <a href="tel:+74999385358">+7 (499) 938-53-58</a>')
must('<a href="tel:+74993256474">+7 (499) 325-64-74</a>', PH)
# подвал: номера Москвы перед британским
must('<p><a href="tel:+442037699209">+44 20 3769 9209</a> · <a href="mailto:',
     '<p><a href="tel:+74953691867">+7 (495) 369-18-67</a> · <a href="tel:+74999385358">+7 (499) 938-53-58</a>'
     ' · <a href="tel:+442037699209">+44 20 3769 9209</a> · <a href="mailto:')

# ── скрипт форм ──
must('"gclid","yclid"]', '"gclid","yclid","fbclid"]')
html = html.replace("spain-ga", "spain-fb")
# клики по телефонам и начало заполнения: gtag-события (обёртка разносит их в
# Метрику и пиксель) плюс наш журнал на сервере
TEL = """
  // Свой журнал на сервере (/api/vscom-click): не зависит от блокировщиков рекламы.
  function beacon(what) {
    var q = new URLSearchParams(location.search), u = {};
    ["utm_source","utm_medium","utm_campaign","utm_content","utm_term","fbclid"].forEach(function (k) { if (q.get(k)) u[k] = q.get(k); });
    var body = JSON.stringify({ messenger: what, form: "spain-fb", page: location.href, referrer: document.referrer || "", utm: u });
    try {
      if (navigator.sendBeacon) navigator.sendBeacon("/api/vscom-click", new Blob([body], { type: "application/json" }));
      else fetch("/api/vscom-click", { method: "POST", keepalive: true, headers: { "Content-Type": "application/json" }, body: body });
    } catch (e) {}
  }
  // Звонок — такая же цель, как заявка: считаем клик по любому номеру.
  document.addEventListener("click", function (e) {
    var a = e.target.closest('a[href^="tel:"]');
    if (!a) return;
    var num = a.getAttribute("href").slice(4);
    beacon("phone");
    if (typeof window.gtag === "function") gtag("event", "phone_click", { phone: num, form_id: "spain-fb" });
  });
  // Начал заполнять форму: первый фокус в поле, один раз на форму.
  document.addEventListener("focusin", function (e) {
    var f = e.target.closest && e.target.closest(".vsc-form");
    if (!f || f.dataset.started) return;
    f.dataset.started = "1";
    beacon("form_start");
    if (typeof window.gtag === "function") gtag("event", "form_start", { form_id: f.dataset.form });
  });
"""
i = html.rindex("<script>")
html = html[:i] + html[i:].replace('  "use strict";\n', '  "use strict";\n' + TEL, 1)

left = re.findall(r"Portland|Passeig|W1W|Eixample|325-64-74|spain-ga|резиденции Европы", html)
if left:
    raise SystemExit("осталось лишнее: %s" % sorted(set(left)))

out = os.path.join(BASE, "fb.html")
io.open(out, "w", encoding="utf-8").write(html)
print("написано:", out, len(html), "байт")
