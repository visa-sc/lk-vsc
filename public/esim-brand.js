/* Бренд витрины eSIM: VOYO mobile или VSC mobile (14.10.2026).
 * VSC mobile — та же витрина для клиентов визового центра: voyomobile.ru/vsc и voyomobile.com/vsc.
 * Признак бренда: адрес /vsc, параметр ?b=vsc (ссылки из писем) или запомненный выбор
 * в этом браузере. Витрина в корне без ?b=vsc сбрасывает выбор обратно на VOYO.
 * Подключается в <head> до отрисовки: на VSC прячем знак VOYO, «by VSC» и ссылку на бота,
 * а тексты «VOYO mobile» / «VOYO» меняем на VSC и в том, что страница дорисует потом.
 */
(function () {
  "use strict";
  var KEY = "voyo_brand";
  var me = document.currentScript;
  var store = me && me.getAttribute("data-store") === "1";   // это витрина
  var qs = new URLSearchParams(location.search);
  var vsc = /^\/vsc(\/|$)/i.test(location.pathname) || qs.get("b") === "vsc";
  try {
    if (vsc) localStorage.setItem(KEY, "vsc");
    else if (store && location.pathname === "/") localStorage.removeItem(KEY);   // главная VOYO mobile
    else vsc = localStorage.getItem(KEY) === "vsc";
  } catch (e) {}
  window.VOYO_BRAND = vsc ? "vsc" : "";
  if (!vsc) return;

  var root = document.documentElement;
  root.classList.add("brand-vsc");
  var css = document.createElement("style");
  css.textContent =
    ".brand-vsc .brand .brandrow img,.brand-vsc .byvsc,.brand-vsc .tgl,.brand-vsc a[href*='t.me/esimvoyo_bot']{display:none!important}" +
    ".brand-vsc .brand{flex-direction:row!important;align-items:center!important}" +
    ".vsc-wm{display:inline-flex;align-items:center;gap:7px;font-family:ui-rounded,'SF Pro Rounded',system-ui,-apple-system,'Segoe UI',Roboto,Arial,sans-serif;" +
      "font-weight:800;font-size:20px;line-height:1;letter-spacing:.02em;color:#0097ca}" +
    ".vsc-wm i{width:1.5px;height:15px;background:#0097ca;opacity:.45;border-radius:1px}" +
    ".vsc-wm em{font-style:normal;font-weight:300;font-size:19px;letter-spacing:.01em;color:#3589bd;margin-left:3px}";
  (document.head || root).appendChild(css);

  // значок вкладки и иконка «на экран» — VSC
  function icons() {
    var links = document.querySelectorAll("link[rel~='icon'],link[rel='apple-touch-icon'],link[rel='apple-touch-icon-precomposed']");
    for (var i = 0; i < links.length; i++) { links[i].href = "/vsc-icon.png"; links[i].removeAttribute("sizes"); links[i].type = "image/png"; }
  }
  var WM = '<span class="vsc-wm">V<i></i>S<i></i>C<em>mobile</em></span>';
  function swapText(node) {
    var w = document.createTreeWalker(node, NodeFilter.SHOW_TEXT, {
      acceptNode: function (n) {
        var p = n.parentNode && n.parentNode.nodeName;
        return (p === "SCRIPT" || p === "STYLE" || p === "TEXTAREA") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
      }
    });
    var n;
    while ((n = w.nextNode())) {
      if (n.nodeValue.indexOf("VOYO") < 0) continue;
      n.nodeValue = n.nodeValue.replace(/VOYO mobile/g, "VSC mobile").replace(/VOYO/g, "VSC");
    }
  }
  // витрина VSC: на сайтах eSIM — /vsc, с других доменов (кабинет на voyotravel.ru) — полный адрес
  var STORE = /(^|\.)voyomobile\.(ru|com)$/.test(location.hostname) ? "/vsc" : "https://voyomobile.ru/vsc";
  function apply(scope) {
    var q = scope.querySelectorAll ? scope : document;
    var brands = q.querySelectorAll(".brand");
    for (var i = 0; i < brands.length; i++) {
      var b = brands[i];
      if (b.getAttribute("data-vsc")) continue;
      var row = b.querySelector(".brandrow");
      if (row) row.innerHTML = WM; else b.innerHTML = WM;
      b.setAttribute("data-vsc", "1");
    }
    // «на витрину» ведём на витрину VSC, а не VOYO
    var links = q.querySelectorAll("a[href='/esim'],a[href='/esim/'],a[href='/']");
    for (var l = 0; l < links.length; l++) links[l].setAttribute("href", STORE);
    var imgs = q.querySelectorAll("img[src='/favicon-192.png']");
    for (var j = 0; j < imgs.length; j++) imgs[j].src = "/vsc-icon.png";
    swapText(scope.nodeType === 1 || scope.nodeType === 9 ? scope : document.body);
  }
  function start() {
    document.title = document.title.replace(/VOYO mobile/g, "VSC mobile").replace(/VOYO/g, "VSC");
    icons();
    apply(document.body);
    new MutationObserver(function (list) {
      for (var i = 0; i < list.length; i++) {
        var m = list[i];
        if (m.type === "characterData") { if (m.target.nodeValue.indexOf("VOYO") >= 0) swapText(m.target.parentNode || document.body); continue; }
        for (var k = 0; k < m.addedNodes.length; k++) {
          var a = m.addedNodes[k];
          if (a.nodeType === 1) apply(a); else if (a.nodeType === 3 && a.nodeValue.indexOf("VOYO") >= 0) swapText(a.parentNode);
        }
      }
      if (document.title.indexOf("VOYO") >= 0) document.title = document.title.replace(/VOYO mobile/g, "VSC mobile").replace(/VOYO/g, "VSC");
    }).observe(document.body, { childList: true, subtree: true, characterData: true });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start); else start();
})();
