# -*- coding: utf-8 -*-
"""Собирает страницы ETA под бразильский рынок на каркасе spain/ga.html.

Две страницы:
  visa-sc.com/br/gb      — ETA do Reino Unido (обязательна всем бразильцам)
  visa-sc.com/br/canada  — eTA do Canadá (только при визе США или прошлой канадской)

Тематика попадает под политику Google «Government documents and services»,
поэтому дисклеймеры «не сайт правительства», ссылка на официальный портал и
раздельные суммы (госпошлина / наша работа) — не украшение, а обязательная часть.
"""
import io, os
from wizard import WIZ_CSS, wizard_html, wizard_js

BASE = "/Users/andrey/Documents/Бизнес/VOYO/lk-vsc-macbook"
SCR = os.path.dirname(os.path.abspath(__file__))
head_src = io.open(os.path.join(SCR, "head.html"), encoding="utf-8").read()

TEL_BR = "+55 11 4210-8500"
TEL_BR_H = "+551142108500"
TEL_UK = "+44 20 3769 9209"
TEL_UK_H = "+442037699209"
WA = "https://wa.me/79299435150"
MAIL = "info@visa-sc.com"

WA_SVG = '<svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor"><path d="M12.04 2C6.58 2 2.13 6.45 2.13 11.91c0 1.75.46 3.45 1.32 4.95L2 22l5.25-1.38a9.9 9.9 0 0 0 4.79 1.22h.01c5.46 0 9.9-4.45 9.9-9.91 0-2.65-1.03-5.14-2.9-7.01A9.82 9.82 0 0 0 12.04 2Zm5.8 14.16c-.24.68-1.42 1.32-1.95 1.36-.5.04-.98.22-3.3-.72-2.78-1.1-4.55-3.94-4.69-4.12-.14-.18-1.12-1.49-1.12-2.85 0-1.35.71-2.02.96-2.3.25-.27.55-.34.73-.34.18 0 .37 0 .53.01.17.01.4-.06.62.48.24.55.8 1.9.87 2.04.07.14.12.3.02.48-.09.18-.14.3-.28.46-.14.16-.29.36-.42.48-.14.14-.28.29-.12.57.16.27.72 1.19 1.55 1.93 1.07.95 1.97 1.25 2.25 1.39.28.14.44.12.6-.07.18-.2.7-.81.88-1.09.19-.27.37-.23.62-.14.25.09 1.6.76 1.87.9.27.14.46.2.53.32.06.11.06.66-.18 1.34Z"/></svg>'

EXTRA_CSS = ("""
/* ── страницы ETA ──────────────────────────────────────────────────────────
   Фото под тему нет, поэтому первый экран держим на градиенте и своей
   графике: документ, печать, самолёт. Ничего чужого. */
.hero__bg{position:absolute;inset:0;background:
  radial-gradient(1000px 600px at 76% 16%,rgba(0,152,202,.40) 0%,rgba(0,152,202,0) 62%),
  radial-gradient(720px 520px at 10% 88%,rgba(238,114,87,.26) 0%,rgba(238,114,87,0) 60%),
  linear-gradient(120deg,#0b1531 0%,#12275c 55%,#0d1c40 100%)}
.hero__art{position:absolute;inset:0;overflow:hidden;pointer-events:none}
.hero__art svg{display:block;width:100%;height:100%}

.tiers{display:grid;grid-template-columns:repeat(3,1fr);gap:22px;align-items:start}
.tier{background:#fff;border:1px solid var(--line);border-radius:var(--radius);padding:26px 24px;
  position:relative}
.tier--top{border-color:var(--blue);box-shadow:0 14px 34px rgba(0,152,202,.16)}
.tier__badge{position:absolute;top:-13px;left:24px;background:var(--blue);color:#fff;
  border-radius:50px;padding:6px 15px;font-size:13px;font-weight:500}
.tier h3{margin-bottom:4px}
.tier__time{color:var(--muted);font-size:14.5px;margin-bottom:16px}
.tier__sum{display:flex;align-items:baseline;gap:10px;margin-bottom:4px}
.tier__sum b{font-size:30px;font-weight:500;line-height:1}
.tier__split{color:var(--muted);font-size:13.5px;line-height:1.5;margin:0 0 18px;
  padding-bottom:16px;border-bottom:1px solid var(--line)}
.tier ul{list-style:none;margin:0 0 20px;padding:0;display:grid;gap:9px}
.tier li{position:relative;padding-left:24px;font-size:15px}
.tier li:before{content:"";position:absolute;left:0;top:6px;width:13px;height:13px;border-radius:50%;
  background:var(--blue-pale);box-shadow:inset 0 0 0 2px var(--blue)}

.alert{border:1px solid #f0d08a;background:#fff9ea;border-radius:var(--radius);
  padding:22px 24px;margin-bottom:28px}
.alert b{display:block;font-weight:500;font-size:17px;margin-bottom:6px}
.alert p{margin:0;font-size:15.5px;line-height:1.6}

.gov{border:1px solid var(--line);background:#f7f9fc;border-radius:var(--radius);
  padding:20px 22px;font-size:14.5px;line-height:1.6;color:var(--muted);margin-top:26px}
.gov b{color:var(--ink);font-weight:500}
.gov a{color:var(--blue)}

.hero__cta{display:flex;flex-wrap:wrap;align-items:center;gap:13px;margin-top:26px}
.hero__cta .btn{width:auto;padding:19px 32px;font-size:17px;
  box-shadow:0 14px 34px rgba(238,114,87,.32)}
.hero__cta .msgr{margin:0;padding:17px 22px;font-size:15.5px}

WIZ_PLACEHOLDER
@media (max-width:1000px){ .tiers{grid-template-columns:1fr} }
@media (max-width:640px){
  .hero__cta .btn,.hero__cta .msgr{width:100%;justify-content:center}
}
""".replace("WIZ_PLACEHOLDER", WIZ_CSS) + "</style>")

ART = """  <div class="hero__art" aria-hidden="true">
    <svg viewBox="0 0 1440 760" preserveAspectRatio="xMidYMid slice" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="dg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stop-color="#ffffff" stop-opacity=".26"/>
          <stop offset="1" stop-color="#ffffff" stop-opacity=".06"/>
        </linearGradient>
        <pattern id="dots" width="32" height="32" patternUnits="userSpaceOnUse">
          <circle cx="2" cy="2" r="1.7" fill="#ffffff" opacity=".11"/>
        </pattern>
      </defs>
      <rect width="1440" height="760" fill="url(#dots)"/>

      <!-- паспорт с одобренной отметкой -->
      <g transform="translate(1010 92) rotate(-9)">
        <rect width="400" height="540" rx="26" fill="url(#dg)" stroke="#ffffff" stroke-opacity=".30" stroke-width="2"/>
        <circle cx="200" cy="150" r="54" fill="none" stroke="#ffffff" stroke-opacity=".45" stroke-width="3"/>
        <path d="M146 150h108M200 96v108M160 120a120 120 0 0 0 0 60M240 120a120 120 0 0 1 0 60"
              fill="none" stroke="#ffffff" stroke-opacity=".35" stroke-width="2.5"/>
        <g fill="#ffffff" opacity=".34">
          <rect x="70" y="262" width="260" height="13" rx="6.5"/>
          <rect x="70" y="298" width="200" height="13" rx="6.5"/>
          <rect x="70" y="334" width="230" height="13" rx="6.5"/>
        </g>
        <g transform="translate(232 386) rotate(-13)">
          <rect width="150" height="92" rx="12" fill="none" stroke="#3ddc84" stroke-opacity=".75" stroke-width="4"/>
          <path d="M34 48l24 24 50-52" fill="none" stroke="#3ddc84" stroke-opacity=".85"
                stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/>
        </g>
      </g>

      <!-- маршрут самолёта -->
      <path d="M150 612C380 690 700 636 962 486" fill="none" stroke="#ffffff" stroke-opacity=".24"
            stroke-width="2.5" stroke-dasharray="10 13" stroke-linecap="round"/>
      <g transform="translate(962 486) rotate(-32)" fill="#ffffff" opacity=".5">
        <path d="M0 0l-30 12 8-12-8-12z"/>
      </g>
    </svg>
  </div>
"""


def form_html(where, cfg, sub=None):
    return f"""<form class="vsc-form" data-form="{where}">
          <div class="form-body">
            <div class="card__title"><em>{cfg['form_title']}</em><br>{cfg['form_title2']}</div>
            <p class="card__sub">{sub or cfg['form_sub']}</p>
            <div class="field"><input type="text" name="name" placeholder="{cfg['ph_name']}" autocomplete="name"></div>
            <div class="field"><input type="email" name="email" placeholder="{cfg['ph_mail']}" autocomplete="email"></div>
            <div class="field"><input type="tel" name="phone" placeholder="{cfg['ph_phone']}" autocomplete="tel" required></div>
            <input class="hp" type="text" name="company" tabindex="-1" autocomplete="off" aria-hidden="true">
            <button class="btn" type="submit">{cfg['btn']}</button>
            <p class="consent">{cfg['consent']}</p>
            <div class="form-note"></div>
          </div>
          <div class="form-done">
            <div class="tick-round"><img src="/img/icon-check.svg" width="28" height="28" alt=""></div>
            <h3>{cfg['done_h']}</h3>
            <p>{cfg['done_p']}</p>
          </div>
        </form>"""


def build(cfg):
    head = head_src
    head = head.replace('<html lang="ru">', '<html lang="%s">' % cfg["lang"])
    head = head.replace("<title>ВНЖ Испании: бесплатная консультация | VSC</title>",
                        "<title>%s</title>" % cfg["title"])
    head = head.replace(
        '<meta name="description" content="Резиденция Испании позволяет жить в Испании и Европе дольше 90 дней. Бесплатная консультация: какая программа подходит именно вам, какие нужны документы, реальные сроки и стоимость.">',
        '<meta name="description" content="%s">' % cfg["desc"])
    head = head.replace('<link rel="canonical" href="https://spain.visa-sc.com/ga">',
                        '<link rel="canonical" href="%s">' % cfg["url"])
    head = head.replace('<meta property="og:url" content="https://spain.visa-sc.com/ga">',
                        '<meta property="og:url" content="%s">' % cfg["url"])
    head = head.replace('<meta property="og:title" content="ВНЖ Испании: бесплатная консультация">',
                        '<meta property="og:title" content="%s">' % cfg["og_title"])
    head = head.replace('<meta property="og:description" content="Разберём вашу ситуацию: какая программа подходит, что нужно и сколько это стоит. Бесплатно и ни к чему не обязывает.">',
                        '<meta property="og:description" content="%s">' % cfg["og_desc"])
    head = head.replace('<meta property="og:image" content="https://spain.visa-sc.com/img/og-cover.jpg">',
                        '<meta property="og:image" content="https://visa-sc.com/img/og-cover.jpg">')
    head = head.replace('<meta property="og:locale" content="ru_RU">',
                        '<meta property="og:locale" content="%s">' % cfg["locale"])
    head = head.replace(
        "background:linear-gradient(100deg,rgba(9,18,40,.88) 0%,rgba(9,18,40,.70) 42%,rgba(9,18,40,.28) 72%,rgba(9,18,40,.38) 100%)}",
        "background:linear-gradient(100deg,rgba(9,18,40,.90) 0%,rgba(9,18,40,.68) 40%,rgba(9,18,40,.22) 70%,rgba(9,18,40,.30) 100%)}")
    head = head.replace("</style>", EXTRA_CSS, 1)

    steps = "".join(
        f"""      <div class="step"><b>{s[0]}</b><span>{s[1]}</span></div>\n"""
        for s in cfg["steps"])

    probs = "".join(
        f"""        <div class="benefit">
          <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16.5v.01"/></svg>
          <div><b>{p[0]}</b><span>{p[1]}</span></div>
        </div>\n""" for p in cfg["problems"])

    faq = "".join(
        f"""      <details><summary>{q}</summary><p>{a}</p></details>\n"""
        for q, a in cfg["faq"])

    facts = "".join('<div class="fact"><span>%s</span><b>%s</b></div>' % f for f in cfg["facts"])

    wiz_section = wizard_html(cfg)
    body = f"""<body>

<header class="hdr">
  <div class="container hdr__in">
    <a href="{cfg['path']}" aria-label="VSC"><img class="hdr__logo" src="/img/logo-vsc.svg" alt="VSC"></a>
    <nav class="hdr__nav" id="nav">
      <a href="#who">{cfg['nav'][0]}</a>
      <a href="#price">{cfg['nav'][1]}</a>
      <a href="#how">{cfg['nav'][2]}</a>
      <a href="#faq">{cfg['nav'][3]}</a>
      <a href="#contacts">{cfg['nav'][4]}</a>
    </nav>
    <div class="hdr__tels">
      <a class="hdr__tel" href="tel:{cfg['tel_h']}" data-msgr="phone"><img src="/img/icon-phone.svg" alt="">{cfg['tel']}</a>
    </div>
    <a class="btn btn--sm btn--inline" href="#form"><span class="lbl-l">{cfg['btn']}</span><span class="lbl-s">{cfg['btn_s']}</span></a>
    <button class="hdr__burger" id="burger" aria-label="Menu"><span></span><span></span><span></span></button>
  </div>
</header>

<!-- ============ PRIMEIRA TELA ============ -->
<section class="hero">
  <div class="hero__bg"></div>
{ART}  <div class="hero__veil"></div>
  <div class="container hero__in">
    <div>
      <h1>{cfg['h1']}</h1>
      <p class="hero__sub">{cfg['sub']}</p>
      <div class="facts">{facts}</div>
      <div class="hero__cta">
        <a class="btn" href="#form">{cfg['btn']}</a>
      </div>
    </div>

  </div>
</section>

{wiz_section}
<!-- ============ PARA QUEM ============ -->
<section class="section" id="who">
  <div class="container">
    <h2>{cfg['who_h']}</h2>
    <div class="alert"><b>{cfg['alert_b']}</b><p>{cfg['alert_p']}</p></div>
  </div>
</section>

<!-- ============ PROBLEMAS ============ -->
<section class="section section--navy">
  <div class="container">
    <h2>{cfg['prob_h']}</h2>
    <div class="grid grid--2">
{probs}    </div>
  </div>
</section>

<!-- ============ COMO FUNCIONA ============ -->
<section class="section" id="how">
  <div class="container">
    <h2>{cfg['how_h']}</h2>
    <div class="steps">
{steps}    </div>
  </div>
</section>

<!-- ============ FAQ ============ -->
<section class="section section--pale" id="faq">
  <div class="container">
    <h2>{cfg['faq_h']}</h2>
    <div class="faq">
{faq}    </div>
  </div>
</section>

<!-- ============ CONTATOS ============ -->
<section class="section" id="contacts">
  <div class="container">
    <div class="contact-grid">
      <div>
        <div class="office">
          <b>{cfg['office_city']}</b>
          {cfg['office_addr']}<br>
          <a href="tel:{cfg['tel_h']}" data-msgr="phone">{cfg['tel']}</a><br>
          {MAIL}<br>
          <span class="mut">{cfg['hours_br']}</span>
        </div>
        <div class="office">
          <b>London, 85 Great Portland Street</b>
          Fitzrovia, W1W 7LT<br>
          <a href="tel:{TEL_UK_H}" data-msgr="phone">{TEL_UK}</a><br>
          {MAIL}<br>
          <span class="mut">{cfg['hours_uk']}</span>
        </div>
        <div>
          <a class="msgr msgr--wa" data-msgr="whatsapp" href="{WA}" target="_blank" rel="noopener">{WA_SVG}WhatsApp</a>
        </div>
      </div>
      <div class="card">
        {form_html(cfg['form'] + "-bottom", cfg, cfg['form_sub2'])}
      </div>
    </div>
  </div>
</section>

<!-- ============ MODAL ============ -->
<div class="modal" id="callModal">
  <div class="modal__box">
    <button class="modal__x" data-close aria-label="Fechar">&times;</button>
    {form_html(cfg['form'] + "-modal", cfg)}
  </div>
</div>

<footer class="ftr">
  <div class="container">
    <b>VSC — Visa Services Center</b>
    <p><a href="tel:{cfg['tel_h']}" data-msgr="phone">{cfg['tel']}</a> · <a href="mailto:{MAIL}">{MAIL}</a></p>
    <div class="ftr__fine">
      <p>{cfg['legal1']}</p>
      <p>{cfg['legal2']}</p>
      <p>AK Group, LLC.</p>
      <p><a href="/files/policy_20241106155551.pdf" target="_blank" rel="noopener">{cfg['privacy']}</a></p>
    </div>
  </div>
</footer>

"""

    tail = """<script>
(function () {
  "use strict";
  var burger = document.getElementById("burger"), nav = document.getElementById("nav");
  if (burger) burger.addEventListener("click", function () { nav.classList.toggle("is-on"); });
  nav.addEventListener("click", function (e) { if (e.target.tagName === "A") nav.classList.remove("is-on"); });

  var modal = document.getElementById("callModal");
  function openModal() {
    modal.classList.add("is-on");
    var f = modal.querySelector('input[name="name"]');
    if (f) setTimeout(function () { f.focus(); }, 60);
  }
  function closeModal() { modal.classList.remove("is-on"); }
  document.addEventListener("click", function (e) {
    // Кнопки первого экрана ведут прямо к мастеру оформления, а не к короткой
    // форме «перезвоните»: человек пришёл оформлять, а не оставлять телефон.
    if (e.target.closest("[data-close]") || e.target === modal) closeModal();
  });
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && modal.classList.contains("is-on")) closeModal();
  });

  var qs = new URLSearchParams(location.search), utm = {};
  ["utm_source","utm_medium","utm_campaign","utm_content","utm_term","gclid","yclid"].forEach(function (k) {
    if (qs.get(k)) utm[k] = qs.get(k);
  });
  var openedAt = Date.now();

  // WhatsApp в Бразилии — основной канал связи с бизнесом, поэтому уход туда
  // считаем целевым действием наравне с заявкой.
  document.querySelectorAll("[data-msgr]").forEach(function (a) {
    a.addEventListener("click", function () {
      var body = JSON.stringify({ messenger: a.dataset.msgr, form: "__FORM__",
        page: location.href, referrer: document.referrer || "", utm: utm });
      try {
        if (navigator.sendBeacon) {
          navigator.sendBeacon("/api/vscom-click", new Blob([body], { type: "application/json" }));
        } else {
          fetch("/api/vscom-click", { method: "POST", keepalive: true,
            headers: { "Content-Type": "application/json" }, body: body });
        }
      } catch (e) {}
      if (typeof window.gtag === "function") {
        gtag("event", a.dataset.msgr === "phone" ? "phone_click" : "messenger_click",
             { messenger: a.dataset.msgr, form_id: "__FORM__" });
      }
    });
  });

  function setNote(form, msg) {
    var n = form.querySelector(".form-note");
    n.textContent = msg || "";
    n.className = "form-note" + (msg ? " is-err" : "");
  }
  function validPhone(v) {
    var d = (v || "").replace(/\\D/g, "");
    return d.length >= 9 && d.length <= 15;
  }

__WIZJS__
  document.querySelectorAll(".vsc-form").forEach(function (form) {
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      setNote(form, "");
      var data = {};
      form.querySelectorAll("input").forEach(function (el) {
        if (el.name) data[el.name] = (el.value || "").trim();
      });
      var phoneEl = form.querySelector('[name="phone"]');
      if (!validPhone(data.phone)) {
        phoneEl.closest(".field").classList.add("field--err");
        setNote(form, "__ERR_PHONE__");
        phoneEl.focus();
        return;
      }
      phoneEl.closest(".field").classList.remove("field--err");

      var btn = form.querySelector('button[type="submit"]');
      var old = btn.textContent;
      btn.disabled = true; btn.textContent = "__SENDING__";

      var payload = {
        form: "__FORM__", source: form.dataset.form, name: data.name || "",
        phone: data.phone || "", email: data.email || "",
        page: location.href, referrer: document.referrer || "", utm: utm,
        lang: navigator.language || "",
        elapsed: Math.round((Date.now() - openedAt) / 1000),
        company: data.company || ""
      };

      fetch("/api/vscom-lead", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      }).then(function (r) { return r.json().catch(function () { return {}; }); })
        .then(function (res) {
          if (res && res.ok) {
            form.classList.add("is-sent");
            if (typeof window.gtag === "function") {
              gtag("event", "generate_lead", { form_id: "__FORM__", page_location: location.href });
            }
            if (typeof window.gtag_report_conversion === "function") gtag_report_conversion();
          } else {
            setNote(form, (res && res.message) || "__ERR_SEND__");
          }
        })
        .catch(function () { setNote(form, "__ERR_NET__"); })
        .then(function () { btn.disabled = false; btn.textContent = old; });
    });
  });
})();
</script>
</body>
</html>
"""
    tail = tail.replace("__WIZJS__", wizard_js(cfg))
    tail = (tail.replace("__FORM__", cfg["form"])
                .replace("__ERR_PHONE__", cfg["err_phone"])
                .replace("__SENDING__", cfg["sending"])
                .replace("__ERR_SEND__", cfg["err_send"])
                .replace("__ERR_NET__", cfg["err_net"]))

    out = head + body + tail
    path = os.path.join(BASE, "vscom", cfg["file"])
    os.makedirs(os.path.dirname(path), exist_ok=True)
    io.open(path, "w", encoding="utf-8").write(out)
    print("написано:", path, len(out), "байт")
    return out
