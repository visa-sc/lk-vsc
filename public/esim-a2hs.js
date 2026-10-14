/* VOYO mobile на экране телефона (14.10.2026).
 * Одна инструкция «добавить кабинет на экран» для трёх мест:
 *   • всплывающее окно после покупки — первые два захода (кабинет или страница eSIM);
 *   • свёрнутый блок в кабинете перед поддержкой;
 *   • манифест приложения, чтобы Android предлагал «Установить», а иконка открывала кабинет уже с входом.
 * Шаги подбираются под устройство: iPhone (Safari или другой браузер), Android (Chrome или Samsung).
 */
(function () {
  "use strict";
  var ua = navigator.userAgent || "";
  var ANDROID = /Android/i.test(ua);
  // iPad в последних iOS представляется Mac’ом — узнаём его по сенсорному экрану
  var IOS = !ANDROID && (/iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1));
  var SAMSUNG = /SamsungBrowser/i.test(ua);
  var IOS_OTHER = IOS && /CriOS|FxiOS|EdgiOS|YaBrowser|OPiOS|GSA\//.test(ua);
  // встроенные браузеры приложений: на экран оттуда не добавить
  var INAPP = /Instagram|FBAN|FBAV|Telegram|VKClient|; wv\)/i.test(ua);
  function standalone() {
    try { return window.matchMedia("(display-mode: standalone)").matches || navigator.standalone === true; } catch (e) { return false; }
  }

  // ── значки шагов ──
  var S = 'width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"';
  var ICON = {
    dotsH: '<svg ' + S + '><circle cx="5" cy="12" r="1.3" fill="currentColor"/><circle cx="12" cy="12" r="1.3" fill="currentColor"/><circle cx="19" cy="12" r="1.3" fill="currentColor"/></svg>',
    dotsV: '<svg ' + S + '><circle cx="12" cy="5" r="1.3" fill="currentColor"/><circle cx="12" cy="12" r="1.3" fill="currentColor"/><circle cx="12" cy="19" r="1.3" fill="currentColor"/></svg>',
    share: '<svg ' + S + '><path d="M12 3v12"/><path d="M8 7l4-4 4 4"/><path d="M6 11H5a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-8a1 1 0 0 0-1-1h-1"/></svg>',
    addSq: '<svg ' + S + '><rect x="4" y="4" width="16" height="16" rx="4"/><path d="M12 8v8M8 12h8"/></svg>',
    plus: '<svg ' + S + '><path d="M12 5v14M5 12h14"/></svg>',
    down: '<svg ' + S + '><path d="M12 4v11"/><path d="M7 10l5 5 5-5"/><path d="M5 20h14"/></svg>',
    menu: '<svg ' + S + '><path d="M4 7h16M4 12h16M4 17h16"/></svg>',
  };
  var IOS_SAFARI = { name: "iPhone", app: "Safari", steps: [
    [ICON.dotsH, "Нажмите три точки внизу справа"],
    [ICON.share, "Выберите «Поделиться»"],
    [ICON.addSq, "Выберите «На экран „Домой“»"],
    [ICON.plus, "Нажмите «Добавить»"],
  ], hint: "Если внизу сразу виден значок «Поделиться», начните с него." };
  var IOS_BROWSER = { name: "iPhone", app: "Chrome и другие браузеры", steps: [
    [ICON.share, "Нажмите «Поделиться» в адресной строке"],
    [ICON.addSq, "Выберите «На экран „Домой“»"],
    [ICON.plus, "Нажмите «Добавить»"],
  ] };
  var ANDROID_CHROME = { name: "Android", app: "Chrome", steps: [
    [ICON.dotsV, "Нажмите три точки справа вверху"],
    [ICON.down, "Выберите «Установить приложение» или «Добавить на гл. экран»"],
    [ICON.plus, "Нажмите «Установить»"],
  ] };
  var ANDROID_SAMSUNG = { name: "Android", app: "Samsung Internet", steps: [
    [ICON.menu, "Нажмите меню внизу справа"],
    [ICON.addSq, "Выберите «Добавить страницу на» и «Главный экран»"],
    [ICON.plus, "Нажмите «Добавить»"],
  ] };
  function guides() {
    if (IOS) return [IOS_OTHER ? IOS_BROWSER : IOS_SAFARI];
    if (ANDROID) return [SAMSUNG ? ANDROID_SAMSUNG : ANDROID_CHROME];
    return [IOS_SAFARI, ANDROID_CHROME];   // компьютер: обе инструкции
  }
  var TITLE = "VOYO mobile на экране телефона";
  var WHY = "Кабинет в одно касание: QR-коды, остаток трафика и продление всегда под рукой.";

  // ── стили (свои, с префиксом va-, чтобы не задеть страницу) ──
  var css = "" +
    ".va-card{background:#f4f6fa;border-radius:20px;padding:18px 18px 16px;}" +
    ".va-ch{font-size:18px;font-weight:800;letter-spacing:-.02em;color:#16202e;}" +
    ".va-app{font-size:13px;color:#8b93a5;margin:2px 0 12px;}" +
    ".va-st{display:flex;gap:12px;align-items:flex-start;margin:0 0 12px;font-size:14.5px;line-height:1.4;color:#3a4356;}" +
    ".va-st:last-child{margin-bottom:0;}" +
    ".va-st i{flex:none;width:22px;height:22px;color:#3589bd;display:flex;align-items:center;justify-content:center;font-style:normal;margin-top:-1px;}" +
    ".va-hint{font-size:12.5px;color:#8b93a5;line-height:1.5;margin:12px 0 0;}" +
    ".va-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px;}" +
    "@media(max-width:560px){.va-grid{grid-template-columns:1fr;}}" +
    ".va-ovl{position:fixed;inset:0;z-index:1000;background:rgba(18,28,42,.5);-webkit-backdrop-filter:blur(8px);backdrop-filter:blur(8px);" +
      "display:flex;align-items:flex-end;justify-content:center;opacity:0;transition:opacity .2s ease;}" +
    ".va-ovl.on{opacity:1;}" +
    "@media(min-width:640px){.va-ovl{align-items:center;padding:24px;}}" +
    ".va-sheet{background:#fff;width:100%;max-width:420px;max-height:92vh;overflow-y:auto;border-radius:28px 28px 0 0;position:relative;" +
      "padding:26px 22px calc(22px + env(safe-area-inset-bottom));transform:translateY(40px);transition:transform .26s cubic-bezier(.2,.9,.3,1);" +
      "font-family:-apple-system,BlinkMacSystemFont,'SF Pro Text','Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#16202e;-webkit-font-smoothing:antialiased;}" +
    ".va-ovl.on .va-sheet{transform:none;}" +
    "@media(min-width:640px){.va-sheet{border-radius:28px;padding-bottom:22px;}}" +
    ".va-x{position:absolute;top:14px;right:14px;width:32px;height:32px;border-radius:50%;border:0;cursor:pointer;background:#f0f3f7;color:#8b93a5;" +
      "font-size:15px;line-height:1;display:flex;align-items:center;justify-content:center;}" +
    ".va-ico{width:56px;height:56px;border-radius:14px;display:block;margin:0 0 14px;box-shadow:0 8px 20px -10px rgba(22,32,46,.6);}" +
    ".va-sheet h3{margin:0 0 6px;font-size:20px;font-weight:800;letter-spacing:-.025em;padding-right:36px;line-height:1.25;}" +
    ".va-why{margin:0 0 18px;font-size:14px;line-height:1.5;color:#6b7385;}" +
    ".va-inst{display:block;width:100%;font:inherit;font-size:15.5px;font-weight:700;border:0;cursor:pointer;border-radius:14px;padding:14px;margin:0 0 14px;" +
      "background:linear-gradient(135deg,#2c6f96 0%,#3d95c7 55%,#5ac8fa 120%);color:#fff;box-shadow:0 12px 26px -12px rgba(53,137,189,.85);}" +
    ".va-blk{margin:28px auto 0;max-width:720px;background:#fff;border:1px solid #e6eaf2;border-radius:18px;" +
      "box-shadow:0 1px 2px rgba(16,24,40,.04),0 18px 44px -22px rgba(22,48,80,.22);overflow:hidden;}" +
    ".va-blk summary{list-style:none;cursor:pointer;display:flex;align-items:center;gap:12px;padding:14px 16px;font-size:14.5px;font-weight:600;color:#16202e;}" +
    ".va-blk summary::-webkit-details-marker{display:none;}" +
    ".va-blk summary img{width:30px;height:30px;border-radius:8px;flex:none;}" +
    ".va-blk summary span{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}" +
    ".va-blk summary b{flex:none;color:#8b93a5;font-weight:400;font-size:18px;transition:transform .18s ease;}" +
    ".va-blk[open] summary b{transform:rotate(90deg);}" +
    ".va-body{padding:2px 16px 16px;}" +
    ".va-body .va-why{margin:0 0 14px;font-size:13.5px;}";
  function addCss() {
    if (document.getElementById("va-css")) return;
    var s = document.createElement("style"); s.id = "va-css"; s.textContent = css; document.head.appendChild(s);
  }
  function guideHtml(g) {
    return '<div class="va-card"><div class="va-ch">' + g.name + '</div><div class="va-app">' + g.app + '</div>' +
      g.steps.map(function (st) { return '<div class="va-st"><i>' + st[0] + '</i><span>' + st[1] + "</span></div>"; }).join("") +
      (g.hint ? '<p class="va-hint">' + g.hint + "</p>" : "") + "</div>";
  }
  function guidesHtml() {
    var list = guides();
    return list.length > 1 ? '<div class="va-grid">' + list.map(guideHtml).join("") + "</div>" : guideHtml(list[0]);
  }

  // Android: если браузер готов установить приложение сам — кнопка «Установить» одним нажатием
  var bip = null;
  window.addEventListener("beforeinstallprompt", function (e) { e.preventDefault(); bip = e; });
  function installBtn(onDone) {
    if (!bip) return null;
    var b = document.createElement("button");
    b.type = "button"; b.className = "va-inst"; b.textContent = "Установить";
    b.addEventListener("click", function () {
      var ev = bip; bip = null;
      try { ev.prompt(); ev.userChoice.then(function () { onDone && onDone(); }).catch(function () {}); } catch (e) {}
    });
    return b;
  }

  // ── манифест: Android предлагает «Установить», иконка открывает кабинет уже с входом ──
  function setManifest(start) {
    try {
      var href = "/esim/app.webmanifest" + (start ? "?start=" + encodeURIComponent(start) : "") +
        (window.VOYO_BRAND === "vsc" ? (start ? "&" : "?") + "b=vsc" : "");
      var l = document.querySelector('link[rel="manifest"]');
      if (!l) { l = document.createElement("link"); l.rel = "manifest"; document.head.appendChild(l); }
      l.href = href;
      if (!document.querySelector('meta[name="theme-color"]')) {
        var m = document.createElement("meta"); m.name = "theme-color"; m.content = "#f5f7fb"; document.head.appendChild(m);
      }
      if (!document.querySelector('meta[name="apple-mobile-web-app-title"]')) {
        var t = document.createElement("meta"); t.name = "apple-mobile-web-app-title"; t.content = "VOYO mobile"; document.head.appendChild(t);
      }
    } catch (e) {}
  }

  // ── всплывающее окно: два первых захода после покупки, только на телефоне ──
  var KEY = "voyo_a2hs";
  function store(get, val) {
    try { if (get) return JSON.parse(localStorage.getItem(KEY) || "{}"); localStorage.setItem(KEY, JSON.stringify(val)); } catch (e) { return {}; }
  }
  function popup(force) {
    if (!force) {
      if (!(IOS || ANDROID) || INAPP || standalone()) return false;
      var st = store(true) || {};
      if ((st.n || 0) >= 2) return false;
      try { if (sessionStorage.getItem(KEY)) return false; sessionStorage.setItem(KEY, "1"); } catch (e) {}
      store(false, { n: (st.n || 0) + 1, last: Date.now() });
    }
    addCss();
    var ovl = document.createElement("div");
    ovl.className = "va-ovl";
    ovl.innerHTML = '<div class="va-sheet" role="dialog" aria-modal="true" aria-labelledby="vaT">' +
      '<button class="va-x" type="button" aria-label="Закрыть">✕</button>' +
      '<img class="va-ico" src="/favicon-192.png" alt=""/>' +
      '<h3 id="vaT">' + TITLE + '</h3><p class="va-why">' + WHY + "</p>" +
      '<div class="va-g">' + guidesHtml() + "</div></div>";
    var prevOverflow = document.body.style.overflow;
    function close() {
      ovl.classList.remove("on");
      document.body.style.overflow = prevOverflow;
      document.removeEventListener("keydown", onKey);
      setTimeout(function () { if (ovl.parentNode) ovl.parentNode.removeChild(ovl); }, 220);
    }
    function onKey(e) { if (e.key === "Escape") close(); }
    ovl.addEventListener("click", function (e) { if (e.target === ovl) close(); });
    ovl.querySelector(".va-x").addEventListener("click", close);
    document.addEventListener("keydown", onKey);
    var b = installBtn(close);
    if (b) { var sh = ovl.querySelector(".va-sheet"); sh.insertBefore(b, ovl.querySelector(".va-g")); }
    document.body.appendChild(ovl);
    document.body.style.overflow = "hidden";
    requestAnimationFrame(function () { requestAnimationFrame(function () { ovl.classList.add("on"); }); });
    return true;
  }

  // ── свёрнутый блок для кабинета ──
  function block(host) {
    if (!host || standalone()) return;
    addCss();
    var d = document.createElement("details");
    d.className = "va-blk";
    d.innerHTML = '<summary><img src="/favicon-192.png" alt=""/><span>Добавить на экран телефона</span><b>›</b></summary>' +
      '<div class="va-body"><p class="va-why">' + WHY + "</p>" + guidesHtml() + "</div>";
    d.addEventListener("toggle", function () {
      if (!d.open || d.querySelector(".va-inst")) return;
      var b = installBtn(function () {});
      if (b) d.querySelector(".va-body").insertBefore(b, d.querySelector(".va-body").firstChild.nextSibling);
    });
    host.innerHTML = "";
    host.appendChild(d);
  }

  window.voyoA2hs = { popup: popup, block: block, setManifest: setManifest, standalone: standalone };
})();
