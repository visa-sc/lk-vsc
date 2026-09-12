# -*- coding: utf-8 -*-
# Собирает vscom/virtual_card.html: каркас и стили берём у spain/ga.html
# (проверенная вёрстка), контент — со страницы visa-sc.ru/kcard/.
import io, os, re

BASE = "/Users/andrey/Documents/Бизнес/VOYO/lk-vsc-macbook"
SCR = os.path.dirname(os.path.abspath(__file__))
head = io.open(os.path.join(SCR, "head.html"), encoding="utf-8").read()
tail = io.open(os.path.join(SCR, "tail.html"), encoding="utf-8").read()

# ── head: свои мета ──────────────────────────────────────────────────────────
head = head.replace(
    "<title>ВНЖ Испании: бесплатная консультация | VSC</title>",
    "<title>Виртуальная карта для оплаты за границей | VSC</title>")
head = head.replace(
    '<meta name="description" content="Резиденция Испании позволяет жить в Испании и Европе дольше 90 дней. Бесплатная консультация: какая программа подходит именно вам, какие нужны документы, реальные сроки и стоимость.">',
    '<meta name="description" content="Виртуальная карта VSC для покупок по всему миру: выпуск за 5 минут онлайн, пополнение рублями по СБП, Apple Pay и Google Pay, оплата в 180+ странах и в иностранных сервисах.">')
head = head.replace('<link rel="canonical" href="https://spain.visa-sc.com/ga">',
                    '<link rel="canonical" href="https://visa-sc.com/virtual_card">')
head = head.replace('<meta property="og:url" content="https://spain.visa-sc.com/ga">',
                    '<meta property="og:url" content="https://visa-sc.com/virtual_card">')
head = head.replace('<meta property="og:title" content="ВНЖ Испании: бесплатная консультация">',
                    '<meta property="og:title" content="Виртуальная карта VSC для покупок по всему миру">')
head = head.replace('<meta property="og:description" content="Разберём вашу ситуацию: какая программа подходит, что нужно и сколько это стоит. Бесплатно и ни к чему не обязывает.">',
                    '<meta property="og:description" content="Выпуск за 5 минут онлайн, пополнение по СБП, Apple Pay и Google Pay, оплата в 180+ странах.">')
head = head.replace('<meta property="og:image" content="https://spain.visa-sc.com/img/og-cover.jpg">',
                    '<meta property="og:image" content="https://visa-sc.com/img/og-cover.jpg">')

# Вуаль первого экрана: слева держим плотной (там заголовок), справа отпускаем,
# иначе графика платежа под ней не читается вовсе.
head = head.replace(
    "background:linear-gradient(100deg,rgba(9,18,40,.88) 0%,rgba(9,18,40,.70) 42%,rgba(9,18,40,.28) 72%,rgba(9,18,40,.38) 100%)}",
    "background:linear-gradient(100deg,rgba(9,18,40,.90) 0%,rgba(9,18,40,.66) 40%,rgba(9,18,40,.16) 70%,rgba(9,18,40,.24) 100%)}")

# фон первого экрана: фотографии под карту нет, поэтому чистый градиент
head = head.replace(
    ".hero__bg{position:absolute;inset:0;background:url('/img/hero-spain.webp') center/cover no-repeat}",
    ".hero__bg{position:absolute;inset:0;background:\n"
    "  radial-gradient(1100px 620px at 78% 18%,rgba(0,152,202,.42) 0%,rgba(0,152,202,0) 62%),\n"
    "  radial-gradient(760px 520px at 12% 88%,rgba(238,114,87,.28) 0%,rgba(238,114,87,0) 60%),\n"
    "  linear-gradient(120deg,#0b1531 0%,#12275c 55%,#0d1c40 100%)}")

# ── дополнительные стили страницы карт ───────────────────────────────────────
extra_css = """
/* ── страница виртуальных карт ─────────────────────────────────────────────
   Визуал самой карты рисуем на CSS: фотографий под неё нет, а картинка
   с реквизитами на лендинге всё равно должна быть нарисованной. */
.pcard{position:relative;aspect-ratio:1.586/1;border-radius:16px;padding:20px 22px;color:#fff;
  display:flex;flex-direction:column;justify-content:space-between;margin-bottom:20px;
  box-shadow:0 18px 40px rgba(16,32,74,.28);overflow:hidden}
.pcard--rub{background:linear-gradient(135deg,#123a7a 0%,#0a1b3f 100%)}
.pcard--usd{background:linear-gradient(135deg,#0098ca 0%,#0b3c66 100%)}
.pcard:after{content:"";position:absolute;right:-70px;top:-70px;width:210px;height:210px;
  border-radius:50%;background:rgba(255,255,255,.07)}
.pcard__top{display:flex;align-items:center;justify-content:space-between;position:relative;z-index:1}
.pcard__brand{font-weight:700;letter-spacing:.22em;font-size:13px}
.pcard__sys{font-weight:500;font-size:14px;opacity:.92}
.pcard__num{font-size:clamp(16px,2.6vw,19px);letter-spacing:.16em;position:relative;z-index:1}
.pcard__bot{display:flex;align-items:flex-end;justify-content:space-between;font-size:11.5px;
  letter-spacing:.06em;color:rgba(255,255,255,.72);position:relative;z-index:1}
.pcard__bot b{display:block;font-weight:500;font-size:13px;color:#fff;letter-spacing:.02em}

.hero-card{max-width:360px;margin:0 auto}

/* Графика первого экрана. Рисуем сами, а не берём фотосток: на снимке оплаты
   всегда чей-то терминал, чей-то логотип платёжной системы и чей-то номер
   карты — ровно то, к чему цепляется модерация Google. */
.hero__art{position:absolute;inset:0;overflow:hidden;pointer-events:none}
.hero__art svg{display:block;width:100%;height:100%}

/* Формы на этой странице нет: карту выпускают в кабинете партнёра по
   реферальной ссылке, поэтому первый экран одноколоночный, а справа
   остаётся видна графика. */
.hero__in{grid-template-columns:1fr}
.hero__in>div:first-child{max-width:760px}
.hero__cta{display:flex;flex-wrap:wrap;align-items:center;gap:13px;margin-top:30px}
.hero__cta .btn{width:auto;padding:19px 34px;font-size:17px;
  box-shadow:0 14px 34px rgba(238,114,87,.34)}
.hero__cta .msgr{margin:0;padding:17px 22px;font-size:15.5px}
.hero__note{color:rgba(255,255,255,.62);font-size:14px;margin:14px 0 0}

.final{background:linear-gradient(120deg,#10204a 0%,#1b3a72 100%);color:#fff;border-radius:18px;
  padding:46px 40px;text-align:center}
.final h3{font-size:27px;margin-bottom:10px}
.final p{color:rgba(255,255,255,.76);max-width:620px;margin:0 auto 26px;font-size:16px}
.final .btn{width:auto;padding:19px 34px;font-size:17px}

@media (max-width:640px){
  .hero__cta{gap:10px}
  .hero__cta .btn,.hero__cta .msgr{width:100%;justify-content:center}
  .final{padding:34px 22px}
}

.limits{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin:0 0 16px}
.limit{background:var(--blue-pale);border-radius:10px;padding:11px 12px;text-align:center}
.limit span{display:block;font-size:11.5px;color:var(--muted);letter-spacing:.04em;margin-bottom:3px}
.limit b{font-weight:500;font-size:15px;white-space:nowrap}

.tariff__note{font-size:14px;color:var(--muted);margin:0 0 15px}
.price{display:flex;align-items:baseline;gap:12px;margin:18px 0 14px}
.price b{font-size:26px;font-weight:500;line-height:1}
.price s{color:var(--muted);font-size:17px}

.pays{list-style:none;margin:0;padding:0;display:grid;grid-template-columns:repeat(4,1fr);gap:20px}
.pays li b{display:block;font-weight:500;font-size:16.5px;margin-bottom:4px}
.pays li span{color:var(--muted);font-size:15px}

.legal{color:var(--muted);font-size:13.5px;line-height:1.6;max-width:900px;margin-top:26px}

@media (max-width:1000px){
  .pays{grid-template-columns:repeat(2,1fr)}
}
@media (max-width:640px){
  .pays{grid-template-columns:1fr}
  .limits{grid-template-columns:1fr}
  .limit{display:flex;align-items:center;justify-content:space-between;text-align:left}
  .limit span{margin:0}
}
</style>"""
head = head.replace("</style>", extra_css, 1)


def pcard(kind, sys_label, caption):
    return f"""<div class="pcard pcard--{kind}">
          <div class="pcard__top"><span class="pcard__brand">V S C</span><span class="pcard__sys">{sys_label}</span></div>
          <div class="pcard__num">&bull;&bull;&bull;&bull; &bull;&bull;&bull;&bull; &bull;&bull;&bull;&bull; 5810</div>
          <div class="pcard__bot">
            <span>CARDHOLDER<b>IVAN IVANOV</b></span>
            <span>VALID THRU<b>05 / 31</b></span>
            <span>{caption}</span>
          </div>
        </div>"""


# Реферальная ссылка партнёра: комиссия начисляется только по метке anakondos,
# поэтому она обязана быть во ВСЕХ кнопках выпуска карты.
REF = "https://lk.anakondos.com/auth?anakondos=CB6ie3G"

def ref_btn(text, cls="btn"):
    return (f'<a class="{cls}" href="{REF}" target="_blank" rel="noopener nofollow" '
            f'data-ref-card>{text}</a>')

WA_SVG = '<svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor"><path d="M12.04 2C6.58 2 2.13 6.45 2.13 11.91c0 1.75.46 3.45 1.32 4.95L2 22l5.25-1.38a9.9 9.9 0 0 0 4.79 1.22h.01c5.46 0 9.9-4.45 9.9-9.91 0-2.65-1.03-5.14-2.9-7.01A9.82 9.82 0 0 0 12.04 2Zm5.8 14.16c-.24.68-1.42 1.32-1.95 1.36-.5.04-.98.22-3.3-.72-2.78-1.1-4.55-3.94-4.69-4.12-.14-.18-1.12-1.49-1.12-2.85 0-1.35.71-2.02.96-2.3.25-.27.55-.34.73-.34.18 0 .37 0 .53.01.17.01.4-.06.62.48.24.55.8 1.9.87 2.04.07.14.12.3.02.48-.09.18-.14.3-.28.46-.14.16-.29.36-.42.48-.14.14-.28.29-.12.57.16.27.72 1.19 1.55 1.93 1.07.95 1.97 1.25 2.25 1.39.28.14.44.12.6-.07.18-.2.7-.81.88-1.09.19-.27.37-.23.62-.14.25.09 1.6.76 1.87.9.27.14.46.2.53.32.06.11.06.66-.18 1.34Z"/></svg>'
TG_SVG = '<svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor"><path d="M21.9 4.3 18.6 20c-.25 1.1-.9 1.37-1.83.85l-5.05-3.72-2.44 2.35c-.27.27-.5.5-1.02.5l.36-5.15 9.37-8.47c.4-.36-.09-.56-.63-.2L5.79 13.06.82 11.5c-1.08-.34-1.1-1.08.23-1.6l19.44-7.5c.9-.33 1.69.2 1.4 1.9Z"/></svg>'

TEL = "+7 (499) 938-56-54"
TELH = "+74999385654"

body = f"""<body>

<header class="hdr">
  <div class="container hdr__in">
    <a href="/virtual_card" aria-label="VSC"><img class="hdr__logo" src="/img/logo-vsc.svg" alt="VSC Visa Services Center"></a>
    <nav class="hdr__nav" id="nav">
      <a href="#tasks">Задачи</a>
      <a href="#cards">Карты</a>
      <a href="#how">Как получить</a>
      <a href="#pays">Что оплачивать</a>
      <a href="#faq">Вопросы</a>
      <a href="#contacts">Контакты</a>
    </nav>
    <div class="hdr__tels">
      <a class="hdr__tel" href="tel:{TELH}"><img src="/img/icon-phone.svg" alt="">{TEL}</a>
    </div>
    <a class="btn btn--sm btn--inline" href="{REF}" target="_blank" rel="noopener nofollow" data-ref-card><span class="lbl-l">Выпустить карту</span><span class="lbl-s">Карта</span></a>
    <button class="hdr__burger" id="burger" aria-label="Меню"><span></span><span></span><span></span></button>
  </div>
</header>

<!-- ============ ПЕРВЫЙ ЭКРАН ============ -->
<section class="hero">
  <div class="hero__bg"></div>
  <div class="hero__art" aria-hidden="true">
    <svg viewBox="0 0 1440 760" preserveAspectRatio="xMidYMid slice" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="cg1" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stop-color="#ffffff" stop-opacity=".30"/>
          <stop offset="1" stop-color="#ffffff" stop-opacity=".08"/>
        </linearGradient>
        <linearGradient id="cg2" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stop-color="#12b7ee" stop-opacity=".55"/>
          <stop offset="1" stop-color="#0b3c66" stop-opacity=".18"/>
        </linearGradient>
        <linearGradient id="cg3" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stop-color="#ee7257" stop-opacity=".46"/>
          <stop offset="1" stop-color="#ee7257" stop-opacity=".08"/>
        </linearGradient>
        <pattern id="dots" width="32" height="32" patternUnits="userSpaceOnUse">
          <circle cx="2" cy="2" r="1.7" fill="#ffffff" opacity=".12"/>
        </pattern>
        <g id="chip">
          <rect width="52" height="38" rx="7" fill="#ffffff" opacity=".55"/>
          <path d="M0 13h52M0 25h52M17 0v38M35 0v38" stroke="#0b1531" stroke-opacity=".45" stroke-width="2"/>
        </g>
        <g id="wave" fill="none" stroke="#ffffff" stroke-linecap="round" stroke-width="5">
          <path d="M0 0a30 30 0 0 1 0 40" opacity=".85"/>
          <path d="M13 -10a46 46 0 0 1 0 60" opacity=".58"/>
          <path d="M26 -20a62 62 0 0 1 0 80" opacity=".34"/>
        </g>
      </defs>

      <rect width="1440" height="760" fill="url(#dots)"/>

      <!-- дальняя карта, уходит за правый нижний угол -->
      <g transform="translate(1104 470) rotate(11)">
        <rect width="430" height="270" rx="26" fill="url(#cg3)" stroke="#ffffff" stroke-opacity=".26" stroke-width="2"/>
        <use href="#chip" x="38" y="78"/>
        <g fill="#ffffff" opacity=".38">
          <rect x="38" y="190" width="70" height="10" rx="5"/>
          <rect x="118" y="190" width="70" height="10" rx="5"/>
          <rect x="198" y="190" width="70" height="10" rx="5"/>
          <rect x="278" y="190" width="70" height="10" rx="5"/>
        </g>
      </g>

      <!-- ближняя карта, уходит за правый верхний угол -->
      <g transform="translate(966 40) rotate(-14)">
        <rect width="510" height="320" rx="32" fill="url(#cg1)" stroke="#ffffff" stroke-opacity=".38" stroke-width="2"/>
        <rect width="510" height="320" rx="32" fill="url(#cg2)"/>
        <g transform="translate(48 96) scale(1.25)"><use href="#chip"/></g>
        <g transform="translate(214 130)"><use href="#wave"/></g>
        <g fill="#ffffff" opacity=".55">
          <rect x="48" y="228" width="80" height="12" rx="6"/>
          <rect x="140" y="228" width="80" height="12" rx="6"/>
          <rect x="232" y="228" width="80" height="12" rx="6"/>
          <rect x="324" y="228" width="80" height="12" rx="6"/>
        </g>
        <g fill="#ffffff" opacity=".3">
          <rect x="48" y="264" width="128" height="9" rx="4.5"/>
          <rect x="366" y="264" width="52" height="9" rx="4.5"/>
        </g>
      </g>

      <!-- волны бесконтактной оплаты, левый нижний угол -->
      <g transform="translate(150 622) scale(1.5)" opacity=".5"><use href="#wave"/></g>

      <!-- траектория платежа -->
      <path d="M236 606C450 700 760 652 986 528" fill="none" stroke="#ffffff" stroke-opacity=".26"
            stroke-width="2.5" stroke-dasharray="10 13" stroke-linecap="round"/>
      <circle cx="986" cy="530" r="7.5" fill="#ffffff" opacity=".5"/>
    </svg>
  </div>
  <div class="hero__veil"></div>
  <div class="container hero__in">
    <div>
      <h1>
        Виртуальная карта для реальных покупок по всему миру.<br>
        <span class="hl">Выпуск за 5 минут, без визита в офис.</span>
      </h1>
      <p class="hero__sub">
        Откройте карту онлайн, пополните рублями по СБП и оплачивайте подписки,<br>
        поездки и покупки в 180+ странах.<br>
        Карты МИР и Visa работают с Apple Pay и Google Pay.<br>
        Выпускает партнёрская кредитная организация с банковской лицензией.
      </p>
      <div class="facts">
        <div class="fact"><span>Выпуск</span><b>за 5 минут</b></div>
        <div class="fact"><span>География</span><b>180+ стран</b></div>
        <div class="fact"><span>Обслуживание</span><b>бесплатно</b></div>
        <div class="fact"><span>Пополнение</span><b>по СБП</b></div>
        <div class="fact"><span>Кошелёк</span><b>Apple и Google Pay</b></div>
        <div class="fact"><span>Поддержка</span><b>24/7</b></div>
      </div>
    </div>

      <div class="hero__cta">
        {ref_btn("Выпустить карту бесплатно")}
      </div>
      <p class="hero__note">Регистрация бесплатная, карта выпускается за 5 минут.
      Вопросы по оформлению — по телефону {TEL}.</p>
    </div>
  </div>
</section>

<!-- ============ ЗАДАЧИ ============ -->
<section class="section section--navy" id="tasks">
  <div class="container">
    <h2>Знакомые ситуации? Карта VSC их решает</h2>
    <div class="grid grid--2">
      <div class="benefit">
        <svg viewBox="0 0 24 24"><rect x="2" y="5" width="20" height="14" rx="2"/><path d="M2 10h20"/></svg>
        <div><b>Карта не принимается за границей</b>
        <span>Оплачивайте отели, авиабилеты и кофе в 180+ странах через Apple Pay и Google Pay.</span></div>
      </div>
      <div class="benefit">
        <svg viewBox="0 0 24 24"><path d="M12 2v20"/><path d="M17 6H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>
        <div><b>Иностранные сервисы отклоняют оплату</b>
        <span>Трастовые карты VSC подходят для зарубежных сервисов и не блокируются из-за плохих BIN.</span></div>
      </div>
      <div class="benefit">
        <svg viewBox="0 0 24 24"><path d="M12 3l8 4v5c0 5-3.4 8.3-8 9-4.6-.7-8-4-8-9V7l8-4z"/><path d="M9 12l2 2 4-4"/></svg>
        <div><b>Обменники с непонятным курсом</b>
        <span>Понятный курс и никаких потерь на скрытых процентах: всё видно в личном кабинете.</span></div>
      </div>
      <div class="benefit">
        <svg viewBox="0 0 24 24"><path d="M3 12h18"/><path d="M14 5l7 7-7 7"/></svg>
        <div><b>Крупные платежи за рубеж</b>
        <span>Оплата учёбы, аренды, недвижимости или авто за границей — прозрачно и без сюрпризов.</span></div>
      </div>
    </div>
  </div>
</section>

<!-- ============ КАРТЫ ============ -->
<section class="section" id="cards">
  <div class="container">
    <h2>Выберите свою карту</h2>
    <p style="color:var(--muted);max-width:760px;margin:-16px 0 30px">Обе карты выпускаются онлайн,
    без комиссии за обслуживание. Пополнение рублями по СБП.</p>
    <div class="grid grid--2">

      <div class="prog">
        {pcard("rub", "МИР", "РУБЛЁВАЯ")}
        <h3>Рублёвая карта</h3>
        <p class="prog__for">Для повседневных задач в России и за рубежом</p>
        <div class="limits">
          <div class="limit"><span>ТРАНЗАКЦИЯ</span><b>400 000 ₽</b></div>
          <div class="limit"><span>СУТКИ</span><b>400 000 ₽</b></div>
          <div class="limit"><span>МЕСЯЦ</span><b>800 000 ₽</b></div>
        </div>
        <p class="tariff__note">Комиссия отсутствует · Обслуживание бесплатно</p>
        <ul>
          <li>Пополнение рублями по СБП</li>
          <li>Вывод в рублях и долларах на любые карты</li>
          <li>Оплата по QR везде, где поддерживается МИР</li>
          <li>Покупки на маркетплейсах и в онлайн-сервисах</li>
        </ul>
        <div class="price"><b>Бесплатно</b><s>2 500 ₽</s></div>
        {ref_btn("Выпустить рублёвую карту")}
      </div>

      <div class="prog prog--top">
        <div class="prog__badge">Для заграницы</div>
        {pcard("usd", "VISA", "МЕЖДУНАРОДНАЯ")}
        <h3>Международная карта</h3>
        <p class="prog__for">Одна карта для любых задач по всему миру</p>
        <div class="limits">
          <div class="limit"><span>ТРАНЗАКЦИЯ</span><b>50 000 $</b></div>
          <div class="limit"><span>СУТКИ</span><b>200 000 $</b></div>
          <div class="limit"><span>МЕСЯЦ</span><b>6 000 000 $</b></div>
        </div>
        <p class="tariff__note">Комиссия отсутствует · Обслуживание бесплатно</p>
        <ul>
          <li>Привязка к Apple Pay, Google Pay и App Store</li>
          <li>Доступ к нейросетям и ИИ-инструментам</li>
          <li>Бронирование отелей и покупка авиабилетов</li>
          <li>Оплата через терминалы в 180+ странах</li>
          <li>Персональная поддержка 24/7</li>
        </ul>
        <div class="price"><b>1 990 ₽</b><s>4 990 ₽</s></div>
        {ref_btn("Выпустить международную карту")}
      </div>

    </div>
  </div>
</section>

<!-- ============ КАК ПОЛУЧИТЬ ============ -->
<section class="section section--pale" id="how">
  <div class="container">
    <h2>От регистрации до первой оплаты — 5 минут</h2>
    <p style="color:var(--muted);max-width:760px;margin:-16px 0 30px">Без новых приложений и сложных
    анкет. Всё управление картой — в личном кабинете.</p>
    <div class="steps">
      <div class="step"><b>Зарегистрируйтесь</b>
        <span>Создайте бесплатный аккаунт в личном кабинете: карта, баланс и управление внутри.</span></div>
      <div class="step"><b>Пройдите проверку</b>
        <span>Загрузите фото паспорта. Проверка занимает несколько минут, дальше выдаются реквизиты.</span></div>
      <div class="step"><b>Пополните баланс</b>
        <span>Рублями по СБП. Зачисление мгновенное, курс и комиссия видны заранее.</span></div>
      <div class="step"><b>Оплачивайте покупки</b>
        <span>Карта готова к работе: онлайн и офлайн, с привязкой к Apple Pay и Google Pay.</span></div>
    </div>
  </div>
</section>

<!-- ============ ЧТО ОПЛАЧИВАТЬ ============ -->
<section class="section" id="pays">
  <div class="container">
    <h2>Любые покупки. В любой ситуации.</h2>
    <p style="color:var(--muted);max-width:760px;margin:-16px 0 30px">Оплата по QR-коду через СБП или
    картой Visa через Apple Pay и Google Pay.</p>
    <ul class="pays">
      <li><b>Подписки</b><span>Netflix, Spotify, ChatGPT, YouTube, App Store</span></li>
      <li><b>Недвижимость</b><span>Оплата аренды и покупки за рубежом</span></li>
      <li><b>Гостиницы</b><span>Booking, Airbnb, Ostrovok и депозиты</span></li>
      <li><b>Авиабилеты</b><span>Aviasales и иностранные авиакомпании</span></li>
    </ul>
  </div>
</section>

<!-- ============ БОЛЬШЕ, ЧЕМ КАРТА ============ -->
<section class="section section--navy">
  <div class="container">
    <h2>Полноценный платёжный сервис</h2>
    <p style="color:rgba(255,255,255,.75);max-width:760px;margin:-16px 0 30px">Не просто карта, а
    кошелёк с банковской лицензией: карты, QR-платежи и переводы в одном месте.</p>
    <div class="grid grid--3">
      <div class="benefit">
        <svg viewBox="0 0 24 24"><rect x="2" y="5" width="20" height="14" rx="2"/><path d="M2 10h20"/></svg>
        <div><b>Карты МИР и Visa</b><span>Покупки по всему миру онлайн и офлайн, пополнение рублями.</span></div>
      </div>
      <div class="benefit">
        <svg viewBox="0 0 24 24"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><path d="M14 14h3v3h-3zM19 19h2v2h-2z"/></svg>
        <div><b>Платежи по QR-коду</b><span>Забыли телефон с Apple Pay? Оплачивайте сканированием QR.</span></div>
      </div>
      <div class="benefit">
        <svg viewBox="0 0 24 24"><path d="M7 10l-4 4 4 4"/><path d="M3 14h13"/><path d="M17 14l4-4-4-4"/><path d="M21 10H8"/></svg>
        <div><b>Переводы между пользователями</b><span>Мгновенные переводы рублей другим пользователям по нику.</span></div>
      </div>
    </div>
  </div>
</section>

<!-- ============ FAQ ============ -->
<section class="section section--pale" id="faq">
  <div class="container">
    <h2>Главные вопросы</h2>
    <div class="faq">
      <details><summary>Карта Visa точно привяжется к Apple Pay и Google Pay?</summary>
        <p>Да, международная карта поддерживает оба кошелька, а также оплату в App Store. Если привязка
        не пройдёт, поддержка разбирается вместе с вами — на это есть персональный менеджер 24/7.</p></details>
      <details><summary>Как пополнить карту и какие комиссии?</summary>
        <p>Рублями по СБП, зачисление мгновенное. Комиссия за пополнение отсутствует, обслуживание
        карты бесплатное. Курс конвертации виден в личном кабинете до подтверждения операции.</p></details>
      <details><summary>Сколько стоит карта?</summary>
        <p>Рублёвая карта сейчас выпускается бесплатно вместо 2 500 ₽. Международная — 1 990 ₽
        вместо 4 990 ₽. Обслуживание в обоих случаях бесплатное, скрытых платежей нет.</p></details>
      <details><summary>Насколько это безопасно?</summary>
        <p>Карты выпускает партнёрская кредитная организация с банковской лицензией, деньги хранятся
        на счёте, а не на балансе сервиса. Реквизиты видны только вам в личном кабинете.</p></details>
      <details><summary>Нужно ли устанавливать приложение?</summary>
        <p>Нет. Всё управление — в личном кабинете в браузере: баланс, реквизиты, история операций
        и лимиты. Ставить отдельное приложение не требуется.</p></details>
      <details><summary>Какие документы нужны?</summary>
        <p>Достаточно фотографии паспорта. Проверка занимает несколько минут, приезжать в офис
        и подписывать бумаги не нужно.</p></details>
    </div>
  </div>
</section>

<!-- ============ ФИНАЛЬНЫЙ CTA ============ -->
<section class="section">
  <div class="container">
    <div class="final">
      <h3>Выпустите карту VSC прямо сейчас</h3>
      <p>Бесплатная регистрация, выпуск за 5 минут и первая оплата уже сегодня.
      Без визита в офис и лишних документов.</p>
      {ref_btn("Выпустить карту бесплатно")}
    </div>
  </div>
</section>

<!-- ============ КОНТАКТЫ ============ -->
<section class="section section--pale" id="contacts">
  <div class="container">
    <h2>Остались вопросы</h2>
    <div class="grid grid--2">
      <div>
        <div class="office">
          <b>Москва, Ветошный переулок 9</b>
          ТЦ «Никольский Пассаж», 1 этаж<br>
          <a href="tel:{TELH}">{TEL}</a><br>
          info@visa-sc.com<br>
          <span class="mut">Пн–Пт 10:00–19:00, Сб–Вс 12:00–18:00</span>
        </div>
        <div class="office">
          <b>Санкт-Петербург, улица Марата 86</b>
          ТЦ «Планета Нептун», 2 этаж<br>
          <a href="tel:{TELH}">{TEL}</a><br>
          info@visa-sc.com<br>
          <span class="mut">Пн–Пт 10:00–19:00, Сб–Вс 12:00–18:00</span>
        </div>
      </div>
      <div>
        <p style="color:var(--muted);margin-bottom:18px">Напишите нам, если не уверены, какая карта
        подойдёт под ваши задачи, или что-то не получается на этапе оформления. Отвечаем в рабочее
        время, обычно в течение нескольких минут.</p>
        <a class="msgr msgr--wa" data-msgr="whatsapp" href="https://wa.me/79299435150" target="_blank" rel="noopener">{WA_SVG}Написать в WhatsApp</a>
        <a class="msgr msgr--tg" data-msgr="telegram" href="https://t.me/vsc_operator" target="_blank" rel="noopener">{TG_SVG}Написать в Telegram</a>
      </div>
    </div>
  </div>
</section>

<footer class="ftr">
  <div class="container">
    <b>VSC · Виртуальные карты</b>
    <p><a href="tel:{TELH}">{TEL}</a> · <a href="mailto:info@visa-sc.com">info@visa-sc.com</a></p>
    <div class="ftr__fine">
      <p>Виртуальные карты выпускаются партнёрской кредитной организацией с банковской лицензией.
      VSC — сервис оформления и сопровождения, а не банк и не эмитент.</p>
      <p>Информация на этой странице носит справочный характер, не является публичной офертой,
      определяемой положением Статьи 437 (2) Гражданского кодекса Российской Федерации, а также
      не является индивидуальной инвестиционной или налоговой рекомендацией. Тарифы, лимиты и
      условия выпуска уточняются при оформлении.</p>
      <p>ООО «Эй Кей Групп» · ИНН 7704349866 · 115280, г. Москва, Автозаводская ул., д. 23а, к. 2</p>
      <p><a href="/files/policy_20241106155551.pdf" target="_blank" rel="noopener">Политика конфиденциальности</a></p>
    </div>
  </div>
</footer>

"""

# ── свой хвост: форм на странице нет, вся логика — меню и учёт переходов ─────
tail = """<script>
(function () {
  "use strict";
  var burger = document.getElementById("burger"), nav = document.getElementById("nav");
  if (burger) burger.addEventListener("click", function () { nav.classList.toggle("is-on"); });
  nav.addEventListener("click", function (e) { if (e.target.tagName === "A") nav.classList.remove("is-on"); });

  var qs = new URLSearchParams(location.search), utm = {};
  ["utm_source","utm_medium","utm_campaign","utm_content","utm_term","gclid","yclid"].forEach(function (k) {
    if (qs.get(k)) utm[k] = qs.get(k);
  });

  // Формы здесь нет: карта выпускается в кабинете партнёра по реферальной
  // ссылке, и уход по ней — единственное, что мы вообще можем засчитать.
  // sendBeacon не задерживает переход: браузер досылает запрос после ухода.
  function track(kind, extra) {
    var body = JSON.stringify({
      messenger: kind, form: "card-ga",
      page: location.href, referrer: document.referrer || "", utm: utm
    });
    try {
      if (navigator.sendBeacon) {
        navigator.sendBeacon("/api/vscom-click", new Blob([body], { type: "application/json" }));
      } else {
        fetch("/api/vscom-click", { method: "POST", keepalive: true,
          headers: { "Content-Type": "application/json" }, body: body });
      }
    } catch (e) {}
    if (typeof window.gtag === "function") gtag("event", extra.event, extra.params);
  }

  document.querySelectorAll("[data-msgr]").forEach(function (a) {
    a.addEventListener("click", function () {
      track(a.dataset.msgr, { event: "messenger_click",
        params: { messenger: a.dataset.msgr, form_id: "card-ga" } });
    });
  });

  document.querySelectorAll("[data-ref-card]").forEach(function (a) {
    a.addEventListener("click", function () {
      track("card", { event: "card_referral_click",
        params: { form_id: "card-ga", link_text: (a.textContent || "").trim() } });
    });
  });
})();
</script>
</body>
</html>
"""

out = head + body + tail
path = os.path.join(BASE, "vscom", "virtual_card.html")
io.open(path, "w", encoding="utf-8").write(out)
print("написано:", path, len(out), "байт")
