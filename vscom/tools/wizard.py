# -*- coding: utf-8 -*-
"""Мастер оформления в духе iVisa: тариф → путешественники → подтверждение.

Оплаты пока нет: на последнем шаге данные уходят менеджеру обычной заявкой,
он связывается по WhatsApp и выставляет счёт. Поэтому кнопка называется
«Enviar pedido», а не «Pagar» — обещать оплату, которой нет, нельзя.
"""

WIZ_CSS = """
/* ── мастер оформления ─────────────────────────────────────────────────────*/
.order{display:grid;grid-template-columns:300px minmax(0,1fr);gap:28px;align-items:start}
.aside{background:#fff;border:1px solid var(--line);border-radius:var(--radius);padding:22px 24px;
  position:sticky;top:88px}
.aside__ttl{display:flex;align-items:center;gap:10px;font-weight:500;font-size:17px;margin-bottom:18px}
.aside__flag{font-size:22px;line-height:1}
.aside dl{margin:0;display:grid;gap:14px}
.aside dt{color:var(--muted);font-size:13px;margin-bottom:2px}
.aside dd{margin:0;font-weight:500;font-size:15.5px}
.aside__row{padding-bottom:14px;border-bottom:1px solid var(--line)}
.aside__row:last-child{padding-bottom:0;border-bottom:0}

.wiz{background:#fff;border:1px solid var(--line);border-radius:var(--radius);padding:28px 30px}
.wiz__steps{display:flex;align-items:center;gap:10px;margin-bottom:26px;flex-wrap:wrap}
.wiz__step{display:flex;align-items:center;gap:8px;font-size:14.5px;color:var(--muted);white-space:nowrap}
.wiz__step b{width:24px;height:24px;border-radius:50%;background:#e8edf5;color:var(--muted);
  display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:500;flex:none}
.wiz__step.is-on{color:var(--ink)}
.wiz__step.is-on b{background:var(--blue);color:#fff}
.wiz__step.is-done b{background:var(--blue-pale);color:var(--blue)}
.wiz__line{flex:1;height:1px;background:var(--line);min-width:16px}
.wiz h3{font-size:21px;margin-bottom:4px}
.wiz__hint{color:var(--muted);font-size:14.5px;margin-bottom:20px}
.wiz__pane{display:none}
.wiz__pane.is-on{display:block}

.opt{display:grid;gap:12px;margin-bottom:8px}
.opt label{display:flex;align-items:center;gap:14px;border:1px solid var(--line);border-radius:12px;
  padding:16px 18px;cursor:pointer;transition:border-color .15s ease,background .15s ease}
.opt label:hover{border-color:var(--blue)}
.opt input{position:absolute;left:-9999px;width:1px;height:1px;opacity:0;pointer-events:none}
.opt input:checked+.opt__in{}
.opt label:has(input:checked){border-color:var(--blue);background:var(--blue-pale)}
.opt__dot{width:20px;height:20px;border-radius:50%;border:2px solid var(--line);flex:none;
  position:relative}
.opt label:has(input:checked) .opt__dot{border-color:var(--blue)}
.opt label:has(input:checked) .opt__dot:after{content:"";position:absolute;inset:3px;border-radius:50%;
  background:var(--blue)}
.opt__txt{flex:1;min-width:0}
.opt__txt b{display:block;font-weight:500;font-size:16.5px}
.opt__txt span{color:var(--muted);font-size:14px}
.opt__price{font-weight:500;font-size:18px;white-space:nowrap}
.opt__tag{display:inline-block;background:var(--gold);color:#1b1f21;border-radius:50px;
  padding:2px 9px;font-size:11.5px;font-weight:500;margin-left:8px;vertical-align:2px}

.trav{border:1px solid var(--line);border-radius:12px;padding:20px;margin-bottom:14px;position:relative}
.trav__ttl{font-weight:500;font-size:15.5px;margin-bottom:14px;display:flex;
  justify-content:space-between;align-items:center;gap:10px}
.trav__del{background:none;border:0;color:var(--accent);cursor:pointer;font-size:14px;padding:2px 4px}
.row2{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.row3{display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px}
.field label{display:block;font-size:13px;color:var(--muted);margin-bottom:5px}
.field select{width:100%;height:56px;border:1px solid var(--line);border-radius:8px;background:#f6f8fb;
  padding:0 14px;font:400 16px/1 Roboto,Arial,sans-serif;color:var(--ink);outline:none;
  -webkit-appearance:none;appearance:none;
  background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='8' viewBox='0 0 12 8'%3E%3Cpath d='M1 1l5 5 5-5' stroke='%236b7280' stroke-width='2' fill='none' stroke-linecap='round'/%3E%3C/svg%3E");
  background-repeat:no-repeat;background-position:right 14px center}
.field select:focus{border-color:var(--blue);background-color:#fff}
/* iOS не уважает width:100% у input[type=date] и раздувает поле по содержимому,
   из-за чего оно вылезало за край карточки. Ширину задаём жёстко. */
.field input[type=date]{width:100%;max-width:100%;min-width:0;display:block;
  -webkit-appearance:none;appearance:none}
.trav .field,.trav .row2,.trav .row3{min-width:0}
.trav input,.trav select{max-width:100%}
.sex{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.sex label{display:flex;align-items:center;justify-content:center;gap:9px;border:1px solid var(--line);
  border-radius:8px;height:56px;cursor:pointer;font-size:15.5px;margin:0}
.sex label:has(input:checked){border-color:var(--blue);background:var(--blue-pale)}
.sex input{position:absolute;left:-9999px;width:1px;height:1px;opacity:0;pointer-events:none}

.addbtn{background:none;border:1px dashed var(--line);border-radius:12px;width:100%;padding:15px;
  cursor:pointer;color:var(--blue);font:500 15px/1 Roboto,Arial,sans-serif}
.addbtn:hover{border-color:var(--blue)}

.sum{border:1px solid var(--line);border-radius:12px;padding:18px 20px;margin-bottom:18px}
.sum__row{display:flex;justify-content:space-between;gap:16px;font-size:15px;padding:7px 0}
.sum__row--tot{border-top:1px solid var(--line);margin-top:7px;padding-top:13px;
  font-weight:500;font-size:19px}
.sum__who{color:var(--muted);font-size:14px;padding:5px 0}

.wiz__nav{display:flex;gap:12px;margin-top:22px;align-items:center;flex-wrap:wrap}
.wiz__nav .btn{width:auto;padding:17px 30px}
.btn--ghost{background:none;color:var(--blue);border:1px solid var(--line)}
.btn--ghost:hover{background:var(--blue-pale)}
.wiz__err{display:none;margin-top:14px;font-size:14px;border-radius:8px;padding:11px 13px;
  background:#fdeae6;color:#b8351a}
.wiz__err.is-on{display:block}
.wiz__done{display:none;text-align:center;padding:26px 0}
.wiz__done .tick-round{margin-bottom:16px}
.is-sent .wiz__steps,.is-sent .wiz__pane{display:none}
.is-sent .wiz__done{display:block}

@media (max-width:1000px){
  .order{grid-template-columns:1fr}
  .aside{position:static}
}
@media (max-width:640px){
  .wiz{padding:22px 18px}
  .row2,.row3{grid-template-columns:1fr}
  .wiz__step span{display:none}
  .wiz__nav .btn{width:100%}
}
"""


def wizard_html(cfg):
    tiers = ""
    for i, t in enumerate(cfg["tiers"]):
        tag = ('<span class="opt__tag">%s</span>' % t["tag"]) if t.get("tag") else ""
        chk = " checked" if t.get("default") else ""
        tiers += f"""          <label>
            <input type="radio" name="tier" value="{t['id']}" data-price="{t['price']}" data-label="{t['name']} — {t['time']}"{chk}>
            <span class="opt__dot"></span>
            <span class="opt__txt"><b>{t['name']}{tag}</b><span>{t['time']}</span></span>
            <span class="opt__price">{cfg['cur']}{t['price']}</span>
          </label>
"""
    aside = ""
    for k, v in cfg["aside"]:
        aside += f'          <div class="aside__row"><dt>{k}</dt><dd>{v}</dd></div>\n'

    return f"""<section class="section section--pale" id="form">
  <div class="container">
    <h2>{cfg['order_h']}</h2>
    <p style="color:var(--muted);max-width:780px;margin:-16px 0 30px">{cfg['order_sub']}</p>

    <div class="order">
      <aside class="aside">
        <div class="aside__ttl"><span class="aside__flag">{cfg['flag']}</span>{cfg['product']}</div>
        <dl>
{aside}        </dl>
      </aside>

      <div class="wiz" id="wiz">
        <div class="wiz__steps">
          <div class="wiz__step is-on" data-s="1"><b>1</b><span>{cfg['st1']}</span></div>
          <div class="wiz__line"></div>
          <div class="wiz__step" data-s="2"><b>2</b><span>{cfg['st2']}</span></div>
          <div class="wiz__line"></div>
          <div class="wiz__step" data-s="3"><b>3</b><span>{cfg['st3']}</span></div>
        </div>

        <!-- 1 -->
        <div class="wiz__pane is-on" data-pane="1">
          <h3>{cfg['p1_h']}</h3>
          <p class="wiz__hint">{cfg['p1_hint']}</p>
          <div class="opt">
{tiers}          </div>
          <div class="wiz__nav">
            <button class="btn" type="button" data-next="2">{cfg['next']}</button>
          </div>
        </div>

        <!-- 2 -->
        <div class="wiz__pane" data-pane="2">
          <h3>{cfg['p2_h']}</h3>
          <p class="wiz__hint">{cfg['p2_hint']}</p>
          <div id="travs"></div>
          <button class="addbtn" type="button" id="addTrav">{cfg['add']}</button>
          <div class="wiz__err" id="err2"></div>
          <div class="wiz__nav">
            <button class="btn btn--ghost" type="button" data-next="1">{cfg['back']}</button>
            <button class="btn" type="button" data-next="3">{cfg['next']}</button>
          </div>
        </div>

        <!-- 3 -->
        <div class="wiz__pane" data-pane="3">
          <h3>{cfg['p3_h']}</h3>
          <p class="wiz__hint">{cfg['p3_hint']}</p>
          <div class="sum" id="sum"></div>
          <div class="row2">
            <div class="field"><label>{cfg['l_mail']}</label>
              <input type="email" name="email" placeholder="voce@email.com" autocomplete="email"></div>
            <div class="field"><label>{cfg['l_wa']}</label>
              <input type="tel" name="phone" placeholder="(11) 99999-9999" autocomplete="tel"></div>
          </div>
          <p class="consent" style="color:var(--muted)">{cfg['consent']}</p>
          <div class="wiz__err" id="err3"></div>
          <div class="wiz__nav">
            <button class="btn btn--ghost" type="button" data-next="2">{cfg['back']}</button>
            <button class="btn" type="button" id="send">{cfg['send']}</button>
          </div>
        </div>

        <div class="wiz__done">
          <div class="tick-round"><img src="/img/icon-check.svg" width="28" height="28" alt=""></div>
          <h3>{cfg['done_h']}</h3>
          <p style="color:var(--muted)">{cfg['done_p']}</p>
        </div>
      </div>
    </div>

    <div class="gov" style="margin-top:26px">{cfg['gov']}</div>
  </div>
</section>
"""


def wizard_js(cfg):
    countries = "".join('<option>%s</option>' % c for c in cfg["countries"])
    return """
  // ── мастер оформления ────────────────────────────────────────────────────
  var wiz = document.getElementById("wiz");
  if (wiz) (function () {
    var travs = document.getElementById("travs"), n = 0;
    var PRICE_FMT = function (v) { return "__CUR__" + v.toLocaleString("__NUMLOC__"); };

    function travHtml(i) {
      return '<div class="trav" data-t="' + i + '">' +
        '<div class="trav__ttl"><span>__TRAV__ ' + (i + 1) + '</span>' +
        (i > 0 ? '<button type="button" class="trav__del">__DEL__</button>' : '') + '</div>' +
        '<div class="field" style="margin-bottom:12px"><label>__L_PASS__</label>' +
        '<select name="passport">__COUNTRIES__</select></div>' +
        '<div class="row2">' +
          '<div class="field"><label>__L_FIRST__</label><input type="text" name="firstName" placeholder="John William"></div>' +
          '<div class="field"><label>__L_LAST__</label><input type="text" name="lastName" placeholder="Smith"></div>' +
        '</div>' +
        '<div class="field" style="margin-bottom:12px"><label>__L_BIRTH__</label>' +
        '<input type="date" name="birth"></div>' +
        '<div class="field"><label>__L_SEX__</label><div class="sex">' +
          '<label><input type="radio" name="sex' + i + '" value="M">__M__</label>' +
          '<label><input type="radio" name="sex' + i + '" value="F">__F__</label>' +
        '</div></div></div>';
    }
    function addTrav() {
      travs.insertAdjacentHTML("beforeend", travHtml(n));
      n++;
    }
    addTrav();
    document.getElementById("addTrav").addEventListener("click", addTrav);
    travs.addEventListener("click", function (e) {
      var d = e.target.closest(".trav__del");
      if (!d) return;
      d.closest(".trav").remove();
      [].forEach.call(travs.querySelectorAll(".trav"), function (el, i) {
        el.querySelector(".trav__ttl span").textContent = "__TRAV__ " + (i + 1);
      });
    });

    // Первое касание формы — уже интерес, даже если человек не дойдёт до конца.
    // Считаем один раз на загрузку страницы: фокус, ввод или выбор тарифа.
    var started = false;
    function formStart() {
      if (started) return;
      started = true;
      var body = JSON.stringify({ messenger: "form_start", form: "__FORM__",
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
        gtag("event", "form_start", { form_id: "__FORM__", page_location: location.href });
      }
    }
    ["focusin", "input", "change"].forEach(function (ev) {
      wiz.addEventListener(ev, formStart, { once: false, passive: true });
    });

    function tier() {
      var el = wiz.querySelector('input[name="tier"]:checked');
      return { id: el.value, price: parseInt(el.dataset.price, 10), label: el.dataset.label };
    }
    function collect() {
      return [].map.call(travs.querySelectorAll(".trav"), function (el) {
        var sex = el.querySelector('input[type="radio"]:checked');
        return {
          passport: el.querySelector('[name="passport"]').value,
          firstName: el.querySelector('[name="firstName"]').value.trim(),
          lastName: el.querySelector('[name="lastName"]').value.trim(),
          birth: el.querySelector('[name="birth"]').value,
          gender: sex ? sex.value : ""
        };
      });
    }
    function err(id, msg) {
      var e = document.getElementById(id);
      e.textContent = msg || "";
      e.classList.toggle("is-on", !!msg);
    }

    function renderSum() {
      var t = tier(), list = collect(), box = document.getElementById("sum");
      var html = '<div class="sum__row"><span>' + t.label + '</span><span>' + PRICE_FMT(t.price) + '</span></div>';
      list.forEach(function (x) {
        html += '<div class="sum__who">' + (x.firstName + " " + x.lastName).trim() +
                (x.passport ? " · " + x.passport : "") + '</div>';
      });
      html += '<div class="sum__row"><span>__PEOPLE__</span><span>' + list.length + '</span></div>';
      html += '<div class="sum__row sum__row--tot"><span>__TOTAL__</span><span>' +
              PRICE_FMT(t.price * list.length) + '</span></div>';
      box.innerHTML = html;
    }

    function go(step) {
      [].forEach.call(wiz.querySelectorAll(".wiz__pane"), function (p) {
        p.classList.toggle("is-on", p.dataset.pane === String(step));
      });
      [].forEach.call(wiz.querySelectorAll(".wiz__step"), function (s) {
        var v = parseInt(s.dataset.s, 10);
        s.classList.toggle("is-on", v === step);
        s.classList.toggle("is-done", v < step);
      });
      if (step === 3) renderSum();
      wiz.scrollIntoView({ behavior: "smooth", block: "start" });
    }

    wiz.addEventListener("click", function (e) {
      var b = e.target.closest("[data-next]");
      if (!b) return;
      var to = parseInt(b.dataset.next, 10);
      if (to === 3) {
        var list = collect();
        var bad = list.some(function (x) { return !x.firstName || !x.lastName || !x.birth || !x.gender; });
        if (!list.length || bad) { err("err2", "__ERR_FILL__"); return; }
        err("err2", "");
      }
      go(to);
    });

    document.getElementById("send").addEventListener("click", function () {
      var btn = this, t = tier(), list = collect();
      var email = wiz.querySelector('[name="email"]').value.trim();
      var phone = wiz.querySelector('[name="phone"]').value.trim();
      if ((phone.replace(/\\D/g, "") || "").length < 9) { err("err3", "__ERR_PHONE__"); return; }
      err("err3", "");
      var old = btn.textContent;
      btn.disabled = true; btn.textContent = "__SENDING__";

      fetch("/api/vscom-lead", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          form: "__FORM__", source: "wizard", name: (list[0] || {}).firstName || "",
          phone: phone, email: email, page: location.href,
          referrer: document.referrer || "", utm: utm, lang: navigator.language || "",
          order: { product: "__PRODUCT__", tier: t.id, tierLabel: t.label,
                   priceEach: PRICE_FMT(t.price), total: PRICE_FMT(t.price * list.length),
                   travellers: list }
        })
      }).then(function (r) { return r.json().catch(function () { return {}; }); })
        .then(function (res) {
          if (res && res.ok) {
            wiz.classList.add("is-sent");
            if (typeof window.gtag === "function") {
              gtag("event", "generate_lead", { form_id: "__FORM__", value: t.price * list.length,
                currency: "__CURCODE__", page_location: location.href });
            }
            if (typeof window.gtag_report_conversion === "function") gtag_report_conversion();
            wiz.scrollIntoView({ behavior: "smooth", block: "center" });
          } else {
            err("err3", (res && res.message) || "__ERR_SEND__");
          }
        })
        .catch(function () { err("err3", "__ERR_NET__"); })
        .then(function () { btn.disabled = false; btn.textContent = old; });
    });
  })();
""".replace("__COUNTRIES__", countries) \
   .replace("__TRAV__", cfg["w_trav"]).replace("__DEL__", cfg["w_del"]) \
   .replace("__L_PASS__", cfg["l_pass"]).replace("__L_FIRST__", cfg["l_first"]) \
   .replace("__L_LAST__", cfg["l_last"]).replace("__L_BIRTH__", cfg["l_birth"]) \
   .replace("__L_SEX__", cfg["l_sex"]).replace("__M__", cfg["w_m"]).replace("__F__", cfg["w_f"]) \
   .replace("__PEOPLE__", cfg["w_people"]).replace("__TOTAL__", cfg["w_total"]) \
   .replace("__ERR_FILL__", cfg["err_fill"]).replace("__ERR_PHONE__", cfg["err_phone"]) \
   .replace("__SENDING__", cfg["sending"]).replace("__ERR_SEND__", cfg["err_send"]) \
   .replace("__ERR_NET__", cfg["err_net"]).replace("__FORM__", cfg["form"]) \
   .replace("__PRODUCT__", cfg["product"]) \
   .replace("__CURCODE__", cfg["cur_code"]).replace("__NUMLOC__", cfg["num_loc"]) \
   .replace("__CUR__", cfg["cur"])
