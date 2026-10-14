/* Пиксель Meta и отслеживание для копии visa-sc.ru на visa-sc.com (14.10.2026).
   nginx отдаёт страницы московской копии (mskcopy) на visa-sc.com и вставляет этот
   скрипт перед </head>. Страницы — один в один с visa-sc.ru, сюда вынесено только
   отслеживание рекламы Facebook/Instagram:
     PageView                 — заход;
     FormStart (+InitiateCheckout) — первый фокус в поле формы;
     Contact                  — клик по номеру, WhatsApp, Telegram;
     Lead                     — форма отправлена (ответ сервера с lead_id).
   ВАЖНО (14.10.2026): у датасета 1329364073594329 Meta включила «restricted events» —
   Lead, Contact, InitiateCheckout, CompleteRegistration, SubmitApplication браузер
   НЕ отправляет вовсе (signals/config → eventValidation). Поэтому дублируем своими
   событиями VSCLead / VSCContact / FormStart: кампании оптимизируются на свои
   конверсии из них. Стандартные оставлены на случай, если ограничение снимут.
   Параллельно — маяки в наш журнал /api/vscom-click (отчёт tools/metaReport.js). */
(function () {
  "use strict";
  var PIXEL = "1329364073594329";
  var path = location.pathname;
  var FORM = /^\/spain_vnzh\b/.test(path) ? "spain-fb"
    : /^\/(usa|amerika)\b/.test(path) ? "usa-fb"
    : /^\/(britain|angliya)\b/.test(path) ? "uk-fb"
    : "msk-copy";

  !function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){n.callMethod?
  n.callMethod.apply(n,arguments):n.queue.push(arguments)};if(!f._fbq)f._fbq=n;
  n.push=n;n.loaded=!0;n.version='2.0';n.queue=[];t=b.createElement(e);t.async=!0;
  t.src=v;s=b.getElementsByTagName(e)[0];s.parentNode.insertBefore(t,s)}(window,
  document,'script','https://connect.facebook.net/en_US/fbevents.js');
  fbq("init", PIXEL);
  fbq("track", "PageView");

  function utm() {
    var q = new URLSearchParams(location.search), u = {};
    ["utm_source","utm_medium","utm_campaign","utm_content","utm_term","fbclid"].forEach(function (k) { if (q.get(k)) u[k] = q.get(k); });
    if (!Object.keys(u).length) { try { u = JSON.parse(sessionStorage.getItem("vsc_meta_utm") || "{}"); } catch (e) {} }
    else { try { sessionStorage.setItem("vsc_meta_utm", JSON.stringify(u)); } catch (e) {} }
    return u;
  }
  var U = utm();
  function beacon(what) {
    var body = JSON.stringify({ messenger: what, form: FORM, page: location.href, referrer: document.referrer || "", utm: U });
    try {
      if (navigator.sendBeacon) navigator.sendBeacon("/api/vscom-click", new Blob([body], { type: "application/json" }));
      else fetch("/api/vscom-click", { method: "POST", keepalive: true, headers: { "Content-Type": "application/json" }, body: body });
    } catch (e) {}
  }
  try {
    var vk = "vsc_view_" + path;
    if (!sessionStorage.getItem(vk)) { sessionStorage.setItem(vk, "1"); beacon("view"); }
  } catch (e) { beacon("view"); }

  // Клики: номер, WhatsApp, Telegram
  var lastClick = {};
  document.addEventListener("click", function (e) {
    var a = e.target.closest && e.target.closest("a[href]");
    if (!a) return;
    var h = a.getAttribute("href") || "";
    var what = /^tel:/i.test(h) ? "phone"
      : /wa\.me|whatsapp/i.test(h) ? "whatsapp"
      : /t\.me\/|telegram/i.test(h) ? "telegram" : "";
    if (!what) return;
    var now = Date.now();                      // Flexbe повторяет клик по ссылке — считаем один раз
    if (lastClick.what === what && now - lastClick.t < 2000) return;
    lastClick = { what: what, t: now };
    beacon(what);
    try { fbq("trackCustom", "VSCContact", { form: FORM, channel: what }); fbq("track", "Contact", { content_category: what }); } catch (x) {}
  }, true);

  // Начал заполнять форму — один раз на страницу
  var started = false;
  document.addEventListener("focusin", function (e) {
    if (started) return;
    var t = e.target;
    if (!t || !/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || !(t.closest && t.closest("form"))) return;
    started = true;
    beacon("form_start");
    try { fbq("trackCustom", "FormStart"); fbq("track", "InitiateCheckout"); } catch (x) {}
  }, true);

  // Заявка: движок Flexbe шлёт форму POST-запросом на /mod/project/…/lead/send/ и ждёт {lead_id}
  // Обычно после отправки Flexbe уводит на страницу «Спасибо» (/thx/) — там и
  // засчитываем заявку: отметка ставится при отправке и живёт в sessionStorage.
  var leadSent = false;
  function lead() {
    if (leadSent) return;
    leadSent = true;
    try { sessionStorage.removeItem("vsc_lead_pending"); } catch (x) {}
    try { fbq("trackCustom", "VSCLead", { form: FORM }); fbq("track", "Lead", { content_category: FORM }); } catch (x) {}
  }
  function pending() { try { sessionStorage.setItem("vsc_lead_pending", FORM); } catch (x) {} }
  try {
    var pf = sessionStorage.getItem("vsc_lead_pending");
    if (pf && /^\/(thx|thanks|spasibo)/i.test(path)) { FORM = pf; lead(); }
  } catch (x) {}
  function isFormPost(method, url) {
    if (String(method || "").toUpperCase() !== "POST") return false;
    try {
      var u = new URL(url, location.href);
      // заявка Flexbe: /mod/project/<id>/lead/send/ (или POST на адрес страницы)
      if (u.host !== location.host) return false;
      return /\/lead\/send\b/.test(u.pathname) || !/^\/(api|mod)\//.test(u.pathname);
    } catch (e) { return false; }
  }
  function check(text) {
    // Сразу после ответа Flexbe уводит на /thx/ — запрос пикселя отсюда терялся бы.
    // Ставим отметку, Lead отправит страница «Спасибо»; если перехода не было
    // (форма без редиректа) — засчитываем здесь через 1,5 с.
    try {
      var j = JSON.parse(text);
      if (j && (j.lead_id > 0 || j.success === true && j.status === "ok")) { pending(); setTimeout(lead, 1500); }
    } catch (e) {}
  }
  var X = window.XMLHttpRequest && XMLHttpRequest.prototype;
  if (X) {
    var open = X.open, send = X.send;
    X.open = function (m, u) { this.__vscPost = isFormPost(m, u); if (this.__vscPost) pending(); return open.apply(this, arguments); };
    X.send = function () {
      if (this.__vscPost) this.addEventListener("load", function () { check(this.responseText); });
      return send.apply(this, arguments);
    };
  }
  if (window.fetch) {
    var f0 = window.fetch;
    window.fetch = function (input, init) {
      var url = typeof input === "string" ? input : (input && input.url) || "";
      var m = (init && init.method) || (input && input.method) || "GET";
      var p = f0.apply(this, arguments);
      if (isFormPost(m, url)) pending();
      if (isFormPost(m, url)) p.then(function (r) { return r.clone().text(); }).then(check).catch(function () {});
      return p;
    };
  }
  // Вставленные html-формы уходят обычной отправкой (переход страницы)
  document.addEventListener("submit", function (e) {
    var fm = e.target;
    if (!fm) return;
    var tel = fm.querySelector('input[type="tel"], input[name*="phone" i]');
    if (tel && String(tel.value || "").replace(/\D/g, "").length >= 9) pending();
  }, true);
})();
