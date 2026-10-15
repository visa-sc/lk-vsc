# -*- coding: utf-8 -*-
"""Посадочные под рекламу в Facebook и Instagram (14.10.2026):
  visa-sc.com/usa/fb      — виза в США,
  visa-sc.com/britain/fb  — виза в Великобританию.

Обе собираются из visa-sc.com/usa (public/usa.html): раскладка, номера, подвал —
как там. Формулировки первого экрана и форм — прямые, как на питерском сайте
(spb.visa-sc.ru/usa и /angliya): «Виза в США от 3 дней, на срок до 10 лет»,
«Оформить визу». Выдуманные офисы (Барселона, Лондон) и подписи команды
«Барселона/Мадрид» убираем — Meta банит за вымышленные контакты, и это обман.

Отслеживание: пиксель Meta + маяк захода (build_eta.meta_pixel), начало формы,
клики по телефонам и мессенджерам (в Google, Метрику, пиксель и наш журнал),
заявка. Заявки usa-fb* / uk-fb* сразу уходят в amoCRM (vscom.js).
Пересборка: python3 visa_meta.py
"""
import io, os, re
from build_eta import meta_pixel, strip_gads

V = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
SRC = io.open(os.path.join(V, "public", "usa.html"), encoding="utf-8").read()
PIXEL = "1329364073594329"
VERIFY = "f2ko3or5swjxp3imio4ohdfqrjap3e"


def must(s, old, new, count=1):
    n = s.count(old)
    if n != count:
        raise SystemExit("ожидал %d вхождений, нашёл %d: %s" % (count, n, old[:70]))
    return s.replace(old, new)


def section(s, marker):
    i = s.index(marker)
    a = s.index('<div class="container">', i)
    b = s.index("\n</section>", a)
    return a, b


def put_section(s, marker, inner):
    a, b = section(s, marker)
    return s[:a] + '<div class="container">\n' + inner + "\n  </div>" + s[b:]


def benefits(items):
    icons = ['<circle cx="16" cy="16" r="12"/><path d="M16 9v7l5 3"/>',
             '<circle cx="11" cy="12" r="4"/><circle cx="22" cy="13" r="3.2"/><path d="M4 26c0-4 3.2-7 7-7s7 3 7 7M19 26c0-3 2-5.5 5-5.5s4 2.2 4 5.5"/>',
             '<rect x="3" y="7" width="26" height="18" rx="2.5"/><path d="M3 13h26M8 20h6"/>',
             '<circle cx="16" cy="16" r="12"/><path d="M4 16h24M16 4c3.5 4 3.5 20 0 24M16 4c-3.5 4-3.5 20 0 24"/>',
             '<rect x="3" y="9" width="26" height="18" rx="2.5"/><path d="M11 9V6.5A2.5 2.5 0 0 1 13.5 4h5A2.5 2.5 0 0 1 21 6.5V9"/>',
             '<path d="M16 3l3.6 7.6 8.4 1.1-6.1 5.8 1.5 8.3L16 22l-7.4 3.8 1.5-8.3L4 11.7l8.4-1.1L16 3Z"/>']
    return "\n".join('      <div class="benefit"><svg viewBox="0 0 32 32">%s</svg><div><b>%s</b><span>%s</span></div></div>'
                     % (icons[i % 6], b, t) for i, (b, t) in enumerate(items))


TEL = """
  // Свой журнал на сервере (/api/vscom-click): не зависит от блокировщиков рекламы.
  function beacon(what) {
    var q = new URLSearchParams(location.search), u = {};
    ["utm_source","utm_medium","utm_campaign","utm_content","utm_term","fbclid"].forEach(function (k) { if (q.get(k)) u[k] = q.get(k); });
    var body = JSON.stringify({ messenger: what, form: "__FORM__", page: location.href, referrer: document.referrer || "", utm: u });
    try {
      if (navigator.sendBeacon) navigator.sendBeacon("/api/vscom-click", new Blob([body], { type: "application/json" }));
      else fetch("/api/vscom-click", { method: "POST", keepalive: true, headers: { "Content-Type": "application/json" }, body: body });
    } catch (e) {}
  }
  // Звонок и мессенджер — тоже цели: клик по номеру, WhatsApp, Telegram.
  document.addEventListener("click", function (e) {
    var a = e.target.closest('a[href^="tel:"]');
    if (a) {
      beacon("phone");
      if (typeof window.gtag === "function") gtag("event", "phone_click", { phone: a.getAttribute("href").slice(4), form_id: "__FORM__" });
      return;
    }
    var m = e.target.closest("[data-msgr]");
    if (m) {
      beacon(m.dataset.msgr);
      if (typeof window.gtag === "function") gtag("event", "messenger_click", { messenger: m.dataset.msgr, form_id: "__FORM__" });
    }
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


NEUTRAL = [
    ("Виза в США для россиян: от 3 дней", "Туристическая и деловая виза в США: от 3 дней"),
    ("Подача в третьих странах, бесплатная консультация.", "Подача в удобной стране, бесплатная консультация."),
    ("Посольство США в России визы не выдаёт — оформляем через третьи страны.",
     "Подаём через посольства США в удобной для вас стране."),
    ("<span>Подача</span><b>вне России</b>", "<span>Подача</span><b>в удобной стране</b>"),
    ("Гражданство РФ — не преграда: интервью проходят в третьих странах.",
     "Интервью проходят в удобной стране: Казахстан, Сербия, Армения, ОАЭ и другие."),
    ("Можно ли гражданину РФ вообще получить визу США?", "Где сейчас можно получить визу США?"),
    ("Да. Посольство в Москве визы не выдаёт, но россияне подаются в третьих странах — Казахстане, Сербии, Армении, ОАЭ и других.",
     "Подаваться можно в посольствах США в разных странах — Казахстане, Сербии, Армении, ОАЭ и других."),
    ("B1/B2 гражданам РФ чаще всего выдают", "B1/B2 чаще всего выдают"),
    ("Можно ли гражданину РФ получить визу в Англию?", "Можно ли сейчас получить визу в Англию?"),
    ("Да. Россияне получают британские гостевые визы", "Да. Британия выдаёт гостевые визы"),
]


def build(cfg):
    s = strip_gads(SRC)
    form = cfg["form"]
    # <head>
    s = re.sub(r"<title>.*?</title>", "<title>%s</title>" % cfg["title"], s, 1)
    s = re.sub(r'<meta name="description" content="[^"]*">', '<meta name="description" content="%s">' % cfg["desc"], s, 1)
    s = must(s, '<meta property="og:url" content="https://visa-sc.com/usa">', '<meta property="og:url" content="%s">' % cfg["url"])
    s = re.sub(r'<meta property="og:title" content="[^"]*">', '<meta property="og:title" content="%s">' % cfg["title"].split(" | ")[0], s, 1)
    s = re.sub(r'<meta property="og:description" content="[^"]*">', '<meta property="og:description" content="%s">' % cfg["desc"], s, 1)
    s = s.replace("</head>", meta_pixel({"pixel_id": PIXEL, "fb_verify": VERIFY, "form": form, "cur_code": "EUR"}) + "</head>", 1)
    # шапка
    s = must(s, '<span class="lbl-l">Бесплатная консультация</span>', '<span class="lbl-l">Заказать звонок</span>')
    # первый экран
    h1 = re.search(r"(<h1>)([\s\S]*?)(</h1>)", s)
    s = s.replace(h1.group(0), h1.group(1) + cfg["h1"] + h1.group(3), 1)
    sub = re.search(r'(<p class="hero__sub">)([\s\S]*?)(</p>)', s)
    s = s.replace(sub.group(0), sub.group(1) + cfg["sub"] + sub.group(3), 1)
    facts = re.search(r'<div class="facts">[\s\S]*?</div>\n    </div>', s).group(0)
    s = s.replace(facts, '<div class="facts">\n' + "\n".join(
        '        <div class="fact"><span>%s</span><b>%s</b></div>' % f for f in cfg["facts"]) + "\n      </div>\n    </div>", 1)
    # формы: тексты как на питерском сайте, свои id
    s = s.replace("<em>Бесплатная консультация</em><br>по визе в США", "<em>%s</em><br>%s" % cfg["card"])
    s = s.replace('<button class="btn" type="submit">Получить консультацию</button>', '<button class="btn" type="submit">Оформить визу</button>')
    s = s.replace('<a class="btn" href="#form">Получить консультацию</a>', '<a class="btn" href="#form">Оформить визу</a>')
    for a, b in (('data-form="usa-ga-bottom"', 'data-form="%s-bottom"' % form),
                 ('data-form="usa-ga-modal"', 'data-form="%s-modal"' % form),
                 ('data-form="usa-ga"', 'data-form="%s"' % form)):
        s = must(s, a, b)
    s = s.replace('form: "usa-ga"', 'form: "%s"' % form).replace('form_id: "usa-ga"', 'form_id: "%s"' % form)
    # блоки страны
    if cfg.get("gives"):
        s = put_section(s, "<!-- ============ ЧТО ДАЁТ СТАТУС", "    <h2>%s</h2>\n    <div class=\"grid grid--3\">\n%s\n    </div>" % cfg["gives"])
    for a, b in cfg.get("nav", []):
        s = must(s, a, b)
    for marker, inner in cfg.get("sections", []):
        s = put_section(s, marker, inner)
    # контакты: без выдуманных офисов; команда — где люди реально работают
    s, n = re.subn(r'\s*<div class="office">\s*<b>(Barcelona|London)[^<]*</b>[\s\S]*?</div>', "", s)
    if n != 2:
        raise SystemExit("офисы Barcelona/London: нашёл %d" % n)
    s = s.replace("по работе с клиентами, Барселона", "по работе с клиентами, Москва")
    s = s.replace("по работе с клиентами, Мадрид", "по работе с клиентами, Санкт-Петербург")
    s = s.replace('<a class="msgr msgr--wa" href=', '<a class="msgr msgr--wa" data-msgr="whatsapp" href=')
    s = s.replace('<a class="msgr msgr--tg" href=', '<a class="msgr msgr--tg" data-msgr="telegram" href=')
    # скрипт: fbclid в метках + отслеживание
    s = must(s, '"gclid","yclid"]', '"gclid","yclid","fbclid"]')
    i = s.rindex("<script>")
    s = s[:i] + s[i:].replace('  "use strict";\n', '  "use strict";\n' + TEL.replace("__FORM__", form), 1)
    # Без упоминаний гражданства (15.10.2026): Meta отнесла visa-sc.com к категории
    # «Nationality» и заблокировала события пикселя. Предмет страницы — поездка
    # (туризм и деловые визиты), а не гражданство заявителя.
    if cfg.get("hero"):  # фон первого экрана: у Британии не Нью-Йорк, а паспорт (как в объявлении)
        s = must(s, "url('/img/hero-usa.webp", "url('%s" % cfg["hero"])
    for a, b2 in NEUTRAL:
        s = s.replace(a, b2)
    s = re.sub(r'\s*<details><summary>Я не гражданин РФ[\s\S]*?</details>', "", s)
    for bad in ("гражданин", "гражданам", "Гражданство", "россиян", "России", " РФ"):
        if bad in s:
            raise SystemExit("осталось про гражданство: " + bad)
    for bad in ("Passeig", "Portland", "usa-ga", "AW-18409333270"):
        if bad in s:
            raise SystemExit("осталось: " + bad)
    out = os.path.join(V, cfg["file"])
    os.makedirs(os.path.dirname(out), exist_ok=True)
    io.open(out, "w", encoding="utf-8").write(s)
    print("написано:", out, len(s))


USA = dict(
    file="usa/fb.html", url="https://visa-sc.com/usa/fb", form="usa-fb",
    title="Виза в США от 3 дней, на срок до 10 лет | VSC",
    desc="Виза в США для россиян: от 3 дней, на срок до 10 лет, с гарантией. Подача в третьих странах, бесплатная консультация.",
    h1='\n        <span class="hl">Виза в США</span><br>\n        от 3-х дней, на срок <span class="hl">до 10 лет</span>,<br>\n        с гарантией.\n      ',
    sub="Посольство США в России визы не выдаёт — оформляем через третьи страны.<br>\n        Подберём страну подачи, подготовим анкету DS-160 и документы, подготовим к интервью.",
    facts=[("Срок оформления", "от 3 дней"), ("Виза", "до 10 лет"), ("Семья", "вся сразу"),
           ("Подача", "вне России"), ("Повторно", "без интервью*"), ("Консультация", "бесплатно")],
    card=("Оформить визу в США", "консультация бесплатно"),
)

UK = dict(
    file="britain/fb.html", url="https://visa-sc.com/britain/fb", form="uk-fb", hero="/img/hero-uk.webp",
    title="Виза в Великобританию от 3 рабочих дней, до 10 лет | VSC",
    desc="Виза в Англию: от 3 рабочих дней, на срок до 10 лет, с гарантией. Полный пакет документов, бесплатная консультация.",
    h1='\n        <span class="hl">Виза в Англию</span><br>\n        от 3 рабочих дней, на срок <span class="hl">до 10 лет</span>,<br>\n        с гарантией.\n      ',
    sub="Готовим полный пакет документов для оформления визы.<br>\n        Экономим ваши время и нервы: анкета, запись, проверка каждого документа.",
    facts=[("Срок оформления", "от 3 рабочих дней"), ("Виза", "до 10 лет"), ("Семья", "вся сразу"),
           ("Интервью", "не требуется"), ("Документы", "под ключ"), ("Консультация", "бесплатно")],
    card=("Оформить визу в Англию", "консультация бесплатно"),
    nav=[('<a href="#programs">Где подаваться</a>', '<a href="#programs">Сроки</a>'),
         ('<a href="#call">Консультация</a>', '<a href="#call">Что делаем</a>')],
    gives=("Что даёт британская виза", benefits([
        ("До 10 лет действия", "Многократная гостевая виза: поездки до 6 месяцев за визит."),
        ("Вся семья сразу", "Супруги и дети подаются вместе, одним пакетом."),
        ("Туризм и дела", "Отдых, гости, переговоры, учёба до 6 месяцев — одна Standard Visitor."),
        ("Без собеседования", "Обычно достаточно анкеты, биометрии и документов."),
        ("Ускоренное рассмотрение", "Priority и Super Priority — решение за дни, а не недели."),
        ("Сильная визовая история", "Британская виза помогает с визами других стран.")])),
    sections=[
        ("<!-- ============ ПРОГРАММЫ", """    <h2>Какой срок рассмотрения выбрать</h2>
    <div class="grid grid--3" style="margin-bottom:32px">
      <div class="prog">
        <h3>Стандарт</h3>
        <div class="prog__for">около 3 недель</div>
        <ul>
          <li>Если поездка не скоро</li>
          <li>Без доплаты за срочность</li>
          <li>Подходит большинству заявителей</li>
        </ul>
      </div>
      <div class="prog prog--top">
        <div class="prog__badge">Популярный выбор</div>
        <h3>Priority</h3>
        <div class="prog__for">от 3 рабочих дней</div>
        <ul>
          <li>Когда поездка уже скоро</li>
          <li>Ускоренная проверка документов</li>
          <li>Сроки по вашему центру — скажем на консультации</li>
        </ul>
      </div>
      <div class="prog">
        <h3>Super Priority</h3>
        <div class="prog__for">решение за 1–2 дня</div>
        <ul>
          <li>Для срочных поездок</li>
          <li>Доступно не во всех центрах</li>
          <li>Подскажем, где есть</li>
        </ul>
      </div>
    </div>
    <div class="cta">
      <div>
        <h3>Не знаете, с чего начать?</h3>
        <p>Расскажите о поездке — подберём срок рассмотрения, место подачи и соберём документы под ваш случай.</p>
      </div>
      <a class="btn" href="#form">Оформить визу</a>
    </div>"""),
        ("<!-- ============ ЧТО ДАЁТ КОНСУЛЬТАЦИЯ", """    <h2>Что мы делаем за вас</h2>
    <ul class="covers">
      <li>Заполняем анкету на английском без ошибок</li>
      <li>Точный список документов под ваш случай</li>
      <li>Проверяем выписки, справки и переводы</li>
      <li>Записываем на подачу и биометрию</li>
      <li>Подаём всю семью одним пакетом</li>
      <li>Сопровождаем до получения визы</li>
      <li>Честно оцениваем шансы до подачи</li>
    </ul>"""),
        ("<!-- ============ КАК ПРОХОДИТ", """    <h2>Как это устроено</h2>
    <div class="steps">
      <div class="step"><b>Заявка</b><span>Имя и телефон, больше ничего.</span></div>
      <div class="step"><b>Перезвоним</b><span>В день обращения, обсудим поездку.</span></div>
      <div class="step"><b>Документы</b><span>Анкета, справки, переводы — готовим мы.</span></div>
      <div class="step"><b>Подача</b><span>Запись, биометрия, решение и паспорт с визой.</span></div>
    </div>"""),
        ("<!-- ============ ОТКАЗЫ", """    <h2>Почему в британской визе отказывают</h2>
    <ul class="refuse">
      <li><b>Неубедительные финансы.</b> Выписка должна показывать стабильный доход и происхождение денег, а не крупный разовый перевод перед подачей.</li>
      <li><b>Ошибки и нестыковки в анкете.</b> Даты, работа, прошлые поездки — расхождение с документами читается как недостоверность.</li>
      <li><b>Слабые связи с родиной.</b> Работа, семья, имущество должны показывать, что вы вернётесь.</li>
      <li><b>Прошлые отказы и нарушения.</b> О них нужно правильно сообщить — скрытый отказ хуже честно указанного.</li>
    </ul>
    <p style="margin-top:24px;color:var(--muted);max-width:860px">
      Каждый из этих рисков виден заранее — и дешевле разобрать его до подачи, чем после отказа,
      который останется в визовой истории.
    </p>"""),
        ("<!-- ============ FAQ", """    <h2>Частые вопросы</h2>
    <div class="faq">
      <details open><summary>Можно ли гражданину РФ получить визу в Англию?</summary><p>Да. Россияне получают британские гостевые визы, в том числе на несколько лет. Где сейчас удобнее подаваться, скажем на консультации.</p></details>
      <details><summary>Нужно ли собеседование?</summary><p>Обычно нет: анкета, документы и сдача биометрии в визовом центре.</p></details>
      <details><summary>Сколько рассматривают?</summary><p>Стандартно около трёх недель, с ускорением Priority — от 3 рабочих дней, Super Priority — 1–2 дня там, где он доступен.</p></details>
      <details><summary>На какой срок дают визу?</summary><p>Гостевую визу дают на 6 месяцев, 2, 5 или 10 лет — зависит от вашей визовой истории и запроса.</p></details>
      <details><summary>Можно ли подать всю семью сразу?</summary><p>Да, готовим документы на всех и подаём одним пакетом.</p></details>
      <details><summary>Консультация правда бесплатная?</summary><p>Да. Бесплатная и ни к чему не обязывает.</p></details>
    </div>"""),
    ],
)

if __name__ == "__main__":
    build(USA)
    build(UK)
