/*
 * Корзина витрины eSIM (16.11.2026, идея Андрея Петрова, решение Андрея Комисаренко).
 *
 * Как работает:
 *  • Человек открыл пакет (окно «Купить») — пакет тихо кладётся в корзину этого браузера
 *    (localStorage voyo_esim_cart, до 5 пакетов, живут 30 дней).
 *  • В этот же заход ничего не показываем: выбрал и оплатил — для него ничего не поменялось.
 *  • Оплатил — пакет убирается из корзины (страница «Оплата прошла» вызывает voyoCart.paid()).
 *  • Ушёл без оплаты и вернулся (новый заход: другая вкладка или перерыв больше 30 минут) —
 *    справа внизу появляется круглая кнопка с тележкой и числом пакетов. По ней — список
 *    пакетов с актуальной ценой и кнопкой «Оформить», которая открывает обычное окно покупки.
 *  • В кабинете клиента (встроенная витрина ?embed=1) корзины нет.
 *
 * Страница витрины сообщает о себе через два крючка: voyoCart.add(пакет) в окне покупки и
 * window.voyoOpenPack(id) — открыть окно покупки пакета по id. Цена в корзине берётся из
 * свежего каталога (window.voyoPackById), сохранённая — только запасная.
 */
(function () {
  "use strict";
  var KEY = "voyo_esim_cart", LAST = "voyo_esim_last", SKEY = "voyo_esim_sess", SHOW = "voyo_esim_cart_on";
  var MAX = 5, TTL = 30 * 864e5, GAP = 30 * 60e3;
  function rd() { try { var a = JSON.parse(localStorage.getItem(KEY) || "[]"); return Array.isArray(a) ? a : []; } catch (e) { return []; } }
  function wr(a) { try { localStorage.setItem(KEY, JSON.stringify(a)); } catch (e) {} }
  function fresh(a) { var now = Date.now(); return a.filter(function (x) { return x && x.id && now - (x.at || 0) < TTL; }); }
  var RU = function (n) { return Math.round(Number(n) || 0).toLocaleString("ru-RU"); };
  var esc = function (s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); };

  var api = window.voyoCart = {
    add: function (it) {
      if (!it || !it.id) return;
      var a = fresh(rd()).filter(function (x) { return x.id !== it.id; });
      a.unshift({ id: it.id, title: String(it.title || "").slice(0, 80), sub: String(it.sub || "").slice(0, 120),
        flag: String(it.flag || "").slice(0, 8), price: Number(it.price) || 0, at: Date.now() });
      wr(a.slice(0, MAX));
      try { localStorage.setItem(LAST, String(Date.now())); } catch (e) {}
      render();
    },
    paying: function (id) { try { localStorage.setItem(KEY + "_paying", String(id || "")); } catch (e) {} },
    paid: function () {
      var id = ""; try { id = localStorage.getItem(KEY + "_paying") || ""; localStorage.removeItem(KEY + "_paying"); } catch (e) {}
      if (id) wr(rd().filter(function (x) { return x.id !== id; }));
    },
  };

  // Страница «Оплата прошла»: убрать оплаченный пакет и больше ничего не делать
  var path = location.pathname;
  if (/\/esim\/pay\/ok/.test(path) || document.documentElement.getAttribute("data-esim-paid") === "1") { api.paid(); return; }
  var qs = new URLSearchParams(location.search);
  if (qs.get("embed") === "1" || window.top !== window.self) return;   // витрина внутри кабинета

  // Новый заход: вкладка открыта впервые или перерыв больше 30 минут
  var now = Date.now(), last = 0, newVisit = false;
  try { last = Number(localStorage.getItem(LAST) || 0); } catch (e) {}
  try { newVisit = !sessionStorage.getItem(SKEY) || (last && now - last > GAP); sessionStorage.setItem(SKEY, "1"); } catch (e) { newVisit = now - last > GAP; }
  try { localStorage.setItem(LAST, String(now)); } catch (e) {}
  var items = fresh(rd()); wr(items);
  try { if (newVisit && items.length) sessionStorage.setItem(SHOW, "1"); } catch (e) {}
  function shown() { try { return sessionStorage.getItem(SHOW) === "1"; } catch (e) { return false; } }
  // посетитель что-то делает — заход продолжается
  ["click", "keydown", "touchstart"].forEach(function (ev) {
    document.addEventListener(ev, function () { try { localStorage.setItem(LAST, String(Date.now())); } catch (e) {} }, { passive: true, capture: true });
  });

  var css = document.createElement("style");
  css.textContent =
    ".vc-fab{position:fixed;right:16px;bottom:calc(16px + env(safe-area-inset-bottom,0px));z-index:90;width:56px;height:56px;border-radius:50%;" +
    "border:0;cursor:pointer;background:#fff;color:#2c6f96;box-shadow:0 2px 6px rgba(16,24,40,.08),0 14px 34px -10px rgba(22,48,80,.38);" +
    "display:flex;align-items:center;justify-content:center;-webkit-tap-highlight-color:transparent;transition:transform .15s ease}" +
    ".vc-fab:active{transform:scale(.94)}.vc-fab svg{width:26px;height:26px}" +
    ".vc-n{position:absolute;top:-3px;right:-3px;min-width:22px;height:22px;padding:0 6px;border-radius:11px;background:linear-gradient(135deg,#2c6f96,#3d95c7);" +
    "color:#fff;font:700 12px/22px -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;text-align:center;box-shadow:0 0 0 2.5px #fff}" +
    ".vc-tip{position:fixed;right:82px;bottom:calc(27px + env(safe-area-inset-bottom,0px));z-index:90;background:#16202e;color:#fff;" +
    "font:500 13.5px/1.3 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;padding:9px 13px;border-radius:12px;max-width:min(240px,calc(100vw - 110px));" +
    "box-shadow:0 10px 26px -10px rgba(16,24,40,.45);opacity:0;transform:translateX(6px);transition:opacity .25s,transform .25s;pointer-events:none}" +
    ".vc-tip.on{opacity:1;transform:none}" +
    ".vc-ovl{position:fixed;inset:0;z-index:110;background:rgba(18,28,42,.5);backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);" +
    "display:none;align-items:flex-end;justify-content:center}.vc-ovl.on{display:flex}" +
    ".vc-box{background:#fff;width:100%;max-width:480px;border-radius:22px 22px 0 0;padding:18px 16px calc(16px + env(safe-area-inset-bottom,0px));" +
    "max-height:82vh;overflow-y:auto;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#16202e;box-shadow:0 30px 70px -28px rgba(16,32,64,.4)}" +
    "@media(min-width:640px){.vc-ovl{align-items:center;padding:24px}.vc-box{border-radius:22px;padding:22px}}" +
    ".vc-h{display:flex;align-items:center;justify-content:space-between;margin:0 0 4px}.vc-h b{font-size:19px;letter-spacing:-.02em}" +
    ".vc-x{border:0;background:#f2f4f8;width:32px;height:32px;border-radius:50%;font-size:18px;line-height:32px;color:#5b6475;cursor:pointer}" +
    ".vc-s{color:#8b93a5;font-size:13.5px;margin:0 0 12px}" +
    ".vc-it{display:flex;align-items:center;gap:12px;padding:12px 0;border-top:1px solid #eef1f6}" +
    ".vc-f{font-size:26px;width:34px;text-align:center;flex:none}.vc-t{flex:1;min-width:0}" +
    ".vc-t b{display:block;font-size:15px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}" +
    ".vc-t span{display:block;font-size:12.5px;color:#8b93a5;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:2px}" +
    ".vc-r{display:flex;flex-direction:column;align-items:flex-end;gap:6px;flex:none}.vc-p{font-weight:700;font-size:15px}" +
    ".vc-go{border:0;cursor:pointer;background:linear-gradient(135deg,#2c6f96 0%,#3d95c7 55%,#5ac8fa 120%);color:#fff;font-weight:600;font-size:13.5px;" +
    "padding:8px 14px;border-radius:10px}.vc-rm{border:0;background:none;color:#a3aab8;font-size:12.5px;cursor:pointer;padding:0}" +
    ".vc-ft{color:#8b93a5;font-size:12.5px;margin:10px 0 0;line-height:1.5}";
  document.head.appendChild(css);

  var CART_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M3 4h2.2l2.1 10.3a1.6 1.6 0 0 0 1.6 1.3h8.4a1.6 1.6 0 0 0 1.6-1.2L20.5 8H6.1"/><circle cx="9.5" cy="19.3" r="1.35"/><circle cx="17.2" cy="19.3" r="1.35"/></svg>';
  var fab = null, tip = null, ovl = null;

  function build() {
    if (fab) return;
    fab = document.createElement("button");
    fab.type = "button"; fab.className = "vc-fab"; fab.setAttribute("aria-label", "Корзина");
    fab.innerHTML = CART_SVG + '<span class="vc-n"></span>';
    fab.addEventListener("click", openList);
    document.body.appendChild(fab);
    ovl = document.createElement("div");
    ovl.className = "vc-ovl";
    ovl.addEventListener("click", function (e) { if (e.target === ovl) closeList(); });
    document.body.appendChild(ovl);
    document.addEventListener("keydown", function (e) { if (e.key === "Escape" && ovl.classList.contains("on")) closeList(); });
  }
  function render() {
    var a = fresh(rd());
    if (!shown() || !a.length) { if (fab) fab.style.display = "none"; if (tip) tip.classList.remove("on"); return; }
    build();
    // пока открыто окно покупки, кнопку прячем, чтобы не лезла поверх
    var buying = document.querySelector(".ovl.on");
    fab.style.display = buying ? "none" : "flex";
    fab.querySelector(".vc-n").textContent = a.length;
    if (ovl.classList.contains("on")) fillList();
  }
  function priceOf(x) {
    try { var p = window.voyoPackById && window.voyoPackById(x.id); if (p && p.priceRub) return p.priceRub; } catch (e) {}
    return x.price;
  }
  function fillList() {
    var a = fresh(rd());
    if (!a.length) { closeList(); render(); return; }
    var h = '<div class="vc-box" role="dialog" aria-label="Корзина"><div class="vc-h"><b>Корзина</b><button type="button" class="vc-x" aria-label="Закрыть">×</button></div>' +
      '<p class="vc-s">Пакеты, которые вы выбирали. Оформление займёт минуту.</p>';
    a.forEach(function (x) {
      h += '<div class="vc-it" data-id="' + esc(x.id) + '"><div class="vc-f">' + esc(x.flag || "🌍") + '</div>' +
        '<div class="vc-t"><b>' + esc(x.title || "eSIM") + '</b>' + (x.sub ? '<span>' + esc(x.sub) + '</span>' : "") + '</div>' +
        '<div class="vc-r"><span class="vc-p">' + RU(priceOf(x)) + ' ₽</span><button type="button" class="vc-go">Оформить</button>' +
        '<button type="button" class="vc-rm">Убрать</button></div></div>';
    });
    h += '<p class="vc-ft">Оплата картой российского банка или по СБП. QR-код придёт сразу после оплаты.</p></div>';
    ovl.innerHTML = h;
    ovl.querySelector(".vc-x").addEventListener("click", closeList);
    Array.prototype.forEach.call(ovl.querySelectorAll(".vc-it"), function (row) {
      var id = row.getAttribute("data-id");
      row.querySelector(".vc-go").addEventListener("click", function () {
        var ok = false;
        try { ok = window.voyoOpenPack && window.voyoOpenPack(id); } catch (e) {}
        if (ok) { closeList(); return; }
        // пакета больше нет в каталоге (снят у поставщика) — убираем и говорим об этом
        wr(rd().filter(function (x) { return x.id !== id; }));
        row.querySelector(".vc-r").innerHTML = '<span style="color:#b0263a;font-size:12.5px">Пакет больше не продаётся</span>';
        setTimeout(function () { fillList(); render(); }, 1600);
      });
      row.querySelector(".vc-rm").addEventListener("click", function () {
        wr(rd().filter(function (x) { return x.id !== id; }));
        fillList(); render();
      });
    });
  }
  function openList() { if (tip) tip.classList.remove("on"); fillList(); ovl.classList.add("on"); document.body.style.overflow = "hidden"; }
  function closeList() { if (ovl) ovl.classList.remove("on"); document.body.style.overflow = ""; }

  function start() {
    render();
    if (!fab || fab.style.display === "none") return;
    // разовая подсказка рядом с кнопкой
    var a = fresh(rd());
    tip = document.createElement("div");
    tip.className = "vc-tip";
    tip.textContent = a.length === 1 ? "Вы выбирали: " + (a[0].title || "пакет eSIM")
      : "Вы выбирали " + a.length + (a.length < 5 ? " пакета" : " пакетов") + ", они в корзине";
    document.body.appendChild(tip);
    setTimeout(function () { tip.classList.add("on"); }, 900);
    setTimeout(function () { tip.classList.remove("on"); }, 7000);
    // кнопка прячется, пока открыто окно покупки
    try { new MutationObserver(render).observe(document.body, { subtree: true, attributes: true, attributeFilter: ["class"] }); } catch (e) {}
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start); else start();
})();
