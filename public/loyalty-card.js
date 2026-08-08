/* ══════════════════════════════════════════════════════════════════════════
   VOYO — БОНУСНАЯ ПРОГРАММА: портативный клиентский виджет.

   Один файл, ноль зависимостей, свои стили (все классы с префиксом .vl-,
   инжектятся один раз) — чтобы вшить в клиентский ЛК одной строкой:

       <script src="/loyalty-card.js"></script>
       <div id="bonus"></div>
       <script>VoyoLoyalty.mount(document.getElementById("bonus"), {phone: PHONE, askPhone: false});</script>

   Экран намеренно КОРОТКИЙ: клиент видит карту, три плитки, оплату баллами,
   приглашение друзей и историю. Все объяснения спрятаны под иконки «i»
   (поповер порталом в body — как в админке), чтобы не растягивать страницу.

   Данные — из открытого API /beta/api/loyalty?phone= (карта + реферальный блок),
   списание — /beta/api/loyalty/redeem.

   opts:
     phone     — телефон клиента (в ЛК приходит из сессии)
     askPhone  — true (по умолчанию): если номера нет, виджет спросит его сам
                 и запомнит в localStorage. В ЛК передаём false — формы не будет.
     api       — базовый путь API (по умолчанию "/beta/api/loyalty")
     refBase   — на что ведёт реферальная ссылка (по умолчанию origin + "/app?ref=")
     compact   — true: только карта, плитки и списание (без реферала и истории)
   Возвращает контроллер: { reload(phone), el, phone }.
   ══════════════════════════════════════════════════════════════════════════ */
(function (w, d) {
  "use strict";
  if (w.VoyoLoyalty) return;

  var CSS = ''
  + '.vl-root{--vl-accent:#3589BD;--vl-accent-d:#2b6d97;--vl-ink:#141926;--vl-mut:#737d8f;'
  + '--vl-line:rgba(23,32,60,.08);--vl-bg:#fff;--vl-soft:#f5f7fb;--vl-green:#2f8a52;--vl-red:#b0263a;'
  + '--vl-sh:0 1px 2px rgba(16,24,40,.04),0 12px 30px -16px rgba(16,32,64,.22);color:var(--vl-ink);'
  + 'font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text","Segoe UI",Roboto,Helvetica,Arial,sans-serif;'
  + '-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility;line-height:1.45;}'
  + '.vl-root *{box-sizing:border-box;}'
  + '.vl-root section{margin-top:12px;}'
  + '@keyframes vlup{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:none}}'
  + '.vl-root>*{animation:vlup .5s cubic-bezier(.22,.61,.36,1) both;}'
  + '.vl-root>*:nth-child(2){animation-delay:.05s}.vl-root>*:nth-child(3){animation-delay:.1s}'
  + '.vl-root>*:nth-child(4){animation-delay:.15s}.vl-root>*:nth-child(5){animation-delay:.2s}'

  /* ── карта: цвет и блики зависят от статуса ── */
  + '.vl-card{position:relative;overflow:hidden;border-radius:24px;padding:24px 24px 22px;color:#fff;isolation:isolate;'
  + 'background:linear-gradient(145deg,var(--c1) 0%,var(--c2) 52%,var(--c3) 100%);'
  + 'box-shadow:0 18px 40px -18px var(--cglow),0 2px 6px rgba(16,24,40,.10),inset 0 0 0 1px rgba(255,255,255,.13);}'
  + '.vl-card::after{content:"";position:absolute;right:-90px;top:-120px;width:290px;height:290px;border-radius:50%;'
  + 'background:radial-gradient(circle at 35% 35%,rgba(255,255,255,.22),rgba(255,255,255,0) 62%);z-index:-1;}'
  + '.vl-card::before{content:"";position:absolute;left:-70px;bottom:-140px;width:250px;height:250px;border-radius:50%;'
  + 'background:radial-gradient(circle at 50% 50%,rgba(255,255,255,.11),rgba(255,255,255,0) 65%);z-index:-1;}'
  + '.vl-c-top{display:flex;justify-content:space-between;align-items:center;gap:10px;}'
  + '.vl-brand{font-weight:700;font-size:11.5px;letter-spacing:.20em;opacity:.85;}'
  + '.vl-tier{display:inline-flex;align-items:center;gap:6px;font-size:11.5px;font-weight:700;letter-spacing:.03em;'
  + 'padding:6px 12px;border-radius:999px;background:rgba(255,255,255,.20);border:1px solid rgba(255,255,255,.22);'
  + 'backdrop-filter:saturate(160%) blur(8px);-webkit-backdrop-filter:saturate(160%) blur(8px);white-space:nowrap;}'
  + '.vl-bal{font-size:52px;font-weight:800;letter-spacing:-.035em;line-height:1;margin:20px 0 6px;'
  + 'font-variant-numeric:tabular-nums;text-shadow:0 2px 18px rgba(0,0,0,.16);}'
  + '.vl-bal small{font-size:15px;font-weight:600;opacity:.8;margin-left:9px;letter-spacing:0;}'
  + '.vl-eq{font-size:13.5px;opacity:.88;font-weight:500;}'
  + '.vl-name{font-size:12.5px;opacity:.72;margin-top:16px;letter-spacing:.02em;}'
  + '.vl-prog{margin-top:16px;}'
  + '.vl-prog .vl-bar{height:6px;border-radius:99px;background:rgba(0,0,0,.16);overflow:hidden;'
  + 'box-shadow:inset 0 1px 2px rgba(0,0,0,.14);}'
  + '.vl-prog .vl-bar i{display:block;height:100%;border-radius:99px;width:0;'
  + 'background:linear-gradient(90deg,rgba(255,255,255,.75),#fff);box-shadow:0 0 12px rgba(255,255,255,.55);'
  + 'transition:width 1s cubic-bezier(.22,.61,.36,1);}'
  + '.vl-prog .vl-cap{font-size:12px;opacity:.9;margin-top:9px;}'

  /* ── три плитки-факта ── */
  + '.vl-tiles{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;}'
  + '.vl-tile{background:var(--vl-bg);border:1px solid var(--vl-line);border-radius:16px;padding:12px 12px 11px;'
  + 'box-shadow:var(--vl-sh);transition:transform .18s ease,box-shadow .18s ease;}'
  + '.vl-tile:hover{transform:translateY(-2px);box-shadow:0 2px 6px rgba(16,24,40,.05),0 18px 34px -18px rgba(16,32,64,.30);}'
  + '.vl-tile .t{display:flex;align-items:center;font-size:10.5px;text-transform:uppercase;letter-spacing:.06em;'
  + 'color:var(--vl-mut);font-weight:700;margin-bottom:6px;}'
  + '.vl-tile .v{font-size:19px;font-weight:800;letter-spacing:-.02em;line-height:1.1;}'
  + '.vl-tile .v span{font-size:12px;font-weight:600;color:var(--vl-mut);letter-spacing:0;}'
  + '@media(max-width:380px){.vl-tiles{grid-template-columns:1fr 1fr;}.vl-tile:last-child{grid-column:span 2;}}'

  /* ── списание баллов ── */
  + '.vl-spend{background:var(--vl-bg);border:1px solid var(--vl-line);border-radius:18px;padding:15px 16px;box-shadow:var(--vl-sh);}'
  + '.vl-spend .sh{display:flex;align-items:center;font-size:14px;font-weight:700;letter-spacing:-.01em;}'
  + '.vl-spend .sd{font-size:12.5px;color:var(--vl-mut);margin-top:3px;}'
  + '.vl-spend .sf{display:flex;gap:8px;margin-top:12px;flex-wrap:wrap;align-items:center;}'
  + '.vl-spend input{flex:1;min-width:110px;border:1px solid var(--vl-line);border-radius:12px;padding:11px 13px;'
  + 'font:inherit;font-size:15px;font-weight:600;background:var(--vl-soft);color:var(--vl-ink);}'
  + '.vl-spend input:focus{outline:none;background:#fff;border-color:var(--vl-accent);box-shadow:0 0 0 3px rgba(53,137,189,.14);}'
  + '.vl-spend .er{color:var(--vl-red);font-size:12.5px;margin-top:8px;}'
  + '.vl-pend{background:linear-gradient(150deg,#fffaf0,#fdf4e0);border:1px solid rgba(201,151,43,.28);'
  + 'border-radius:18px;padding:15px 16px;box-shadow:var(--vl-sh);}'
  + '.vl-pend .ph{font-size:14px;font-weight:700;margin-bottom:3px;}'
  + '.vl-pend .pd{font-size:12.5px;color:#6b5a2e;line-height:1.5;}'

  /* ── реферал ── */
  + '.vl-ref{border-radius:18px;padding:16px;background:linear-gradient(150deg,#f4f9fd,#e9f3fa);'
  + 'border:1px solid rgba(53,137,189,.18);}'
  + '.vl-ref .rh{display:flex;align-items:center;font-size:14px;font-weight:700;letter-spacing:-.01em;margin-bottom:11px;}'
  + '.vl-code{display:flex;align-items:center;justify-content:space-between;gap:10px;background:#fff;'
  + 'border:1px dashed rgba(53,137,189,.42);border-radius:14px;padding:11px 14px;}'
  + '.vl-code .lb{font-size:10px;text-transform:uppercase;letter-spacing:.07em;color:var(--vl-mut);font-weight:700;}'
  + '.vl-code .cd{font-size:21px;font-weight:800;letter-spacing:.15em;color:var(--vl-accent-d);font-variant-numeric:tabular-nums;}'
  + '.vl-share{display:flex;gap:8px;margin-top:10px;}'
  + '.vl-btn{flex:1 1 auto;text-align:center;cursor:pointer;border:0;border-radius:12px;padding:11px 14px;'
  + 'font:inherit;font-size:13.5px;font-weight:600;text-decoration:none;display:inline-block;'
  + 'background:linear-gradient(140deg,#4aa3d8,#3589BD);color:#fff;box-shadow:0 10px 20px -11px rgba(53,137,189,.85);'
  + 'transition:transform .16s ease,filter .16s ease;}'
  + '.vl-btn:hover{filter:brightness(1.06);transform:translateY(-1px);}'
  + '.vl-btn:active{transform:translateY(0);}'
  + '.vl-btn.sec{background:#fff;color:var(--vl-accent-d);border:1px solid rgba(53,137,189,.26);box-shadow:none;}'
  + '.vl-rstat{font-size:12px;color:var(--vl-mut);margin-top:10px;}'
  + '.vl-rstat b{color:var(--vl-ink);}'

  /* ── история ── */
  + '.vl-hist{background:var(--vl-bg);border:1px solid var(--vl-line);border-radius:18px;padding:2px 16px;box-shadow:var(--vl-sh);}'
  + '.vl-op{display:flex;gap:12px;align-items:center;padding:12px 0;border-bottom:1px solid var(--vl-line);}'
  + '.vl-op:last-child{border-bottom:0;}'
  + '.vl-op .oi{flex:none;width:32px;height:32px;border-radius:11px;display:flex;align-items:center;justify-content:center;'
  + 'background:linear-gradient(140deg,#eaf3fa,#dcecf7);color:var(--vl-accent-d);}'
  + '.vl-op .oi svg{width:16px;height:16px;display:block;}'
  + '.vl-op .ol{flex:1;min-width:0;}'
  + '.vl-op .ol .t{font-size:13.5px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}'
  + '.vl-op .ol .s{font-size:11.5px;color:var(--vl-mut);margin-top:1px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}'
  + '.vl-op .op{font-size:15px;font-weight:700;white-space:nowrap;font-variant-numeric:tabular-nums;}'
  + '.vl-op .op.plus{color:var(--vl-green);}.vl-op .op.minus{color:var(--vl-red);}'
  + '.vl-more{width:100%;margin:0 0 10px;background:none;border:0;color:var(--vl-accent-d);font:inherit;font-size:13px;'
  + 'font-weight:600;cursor:pointer;padding:9px;border-radius:10px;}'
  + '.vl-more:hover{background:var(--vl-soft);}'
  + '.vl-empty{padding:16px 0;text-align:center;color:var(--vl-mut);font-size:13px;}'
  + '.vl-hh{display:flex;align-items:center;font-size:11px;text-transform:uppercase;letter-spacing:.06em;'
  + 'color:var(--vl-mut);font-weight:700;margin:16px 0 8px 2px;}'

  /* ── иконка «i» + поповер (портал в body) ── */
  + '.vl-i{display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;border-radius:50%;'
  + 'border:1.3px solid currentColor;color:#a7b0bf;font-size:10px;font-weight:700;font-style:italic;'
  + 'font-family:Georgia,"Times New Roman",serif;line-height:1;cursor:pointer;vertical-align:middle;margin-left:7px;'
  + '-webkit-user-select:none;user-select:none;flex:0 0 auto;transition:color .15s ease,transform .15s ease;}'
  + '.vl-i:hover,.vl-i.open{color:var(--vl-accent);transform:scale(1.08);}'
  + '.vl-card .vl-i{color:rgba(255,255,255,.72);}.vl-card .vl-i:hover,.vl-card .vl-i.open{color:#fff;}'
  + '.vl-pop{display:none;position:fixed;z-index:99998;box-sizing:border-box;width:min(330px,80vw);'
  + 'max-height:60vh;overflow:auto;-webkit-overflow-scrolling:touch;background:#171d2b;color:#e7ecf5;'
  + 'font:400 12.5px/1.62 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif;font-style:normal;'
  + 'letter-spacing:0;text-align:left;text-transform:none;padding:13px 15px;border-radius:14px;'
  + 'box-shadow:0 18px 44px rgba(16,24,40,.42);white-space:normal;cursor:default;}'
  + '.vl-pop.show{display:block;}'
  + '.vl-pop b{color:#fff;font-weight:700;}'
  + '.vl-pop .r{display:flex;justify-content:space-between;gap:12px;padding:6px 0;border-bottom:1px solid rgba(255,255,255,.10);}'
  + '.vl-pop .r:last-child{border-bottom:0;}'
  + '.vl-pop .r.now{color:#8fd0f5;}'
  + '.vl-pop .r i{font-style:normal;opacity:.72;font-size:11.5px;}'
  + '.vl-pop::before{content:"";position:absolute;bottom:100%;left:var(--arrow-left,50%);transform:translateX(-50%);'
  + 'border:6px solid transparent;border-bottom-color:#171d2b;}'
  + '.vl-pop.up::before{bottom:auto;top:100%;border-bottom-color:transparent;border-top-color:#171d2b;}'

  /* ── ввод номера (только бета: в ЛК номер из сессии) ── */
  + '.vl-gate{background:var(--vl-bg);border:1px solid var(--vl-line);border-radius:22px;padding:24px 20px;'
  + 'box-shadow:var(--vl-sh);text-align:center;}'
  + '.vl-gate .gh{font-size:16px;font-weight:700;letter-spacing:-.015em;margin-bottom:5px;}'
  + '.vl-gate .gd{font-size:13px;color:var(--vl-mut);line-height:1.5;margin-bottom:15px;}'
  + '.vl-gate .gf{display:flex;gap:8px;flex-wrap:wrap;}'
  + '.vl-gate input{flex:1;min-width:150px;border:1px solid var(--vl-line);border-radius:12px;padding:12px 13px;'
  + 'font:inherit;font-size:15px;background:var(--vl-soft);color:var(--vl-ink);text-align:center;}'
  + '.vl-gate input:focus{outline:none;background:#fff;border-color:var(--vl-accent);box-shadow:0 0 0 3px rgba(53,137,189,.14);}'
  + '.vl-who{text-align:center;font-size:11.5px;color:var(--vl-mut);margin-top:16px;}'
  + '.vl-lnk{background:none;border:0;padding:0;font:inherit;font-size:inherit;color:var(--vl-accent-d);'
  + 'cursor:pointer;text-decoration:underline;}'

  /* ── состояния ── */
  + '.vl-state{background:var(--vl-bg);border:1px solid var(--vl-line);border-radius:20px;padding:26px 20px;'
  + 'text-align:center;color:var(--vl-mut);font-size:13.5px;box-shadow:var(--vl-sh);}'
  + '.vl-skel{border-radius:24px;height:210px;background:linear-gradient(100deg,#eaeff6 30%,#f7fafd 50%,#eaeff6 70%);'
  + 'background-size:220% 100%;animation:vlsk 1.3s linear infinite;}'
  + '@keyframes vlsk{0%{background-position:120% 0}100%{background-position:-40% 0}}'
  + '.vl-toast{position:fixed;left:50%;bottom:28px;transform:translateX(-50%) translateY(10px);'
  + 'background:rgba(20,25,38,.95);color:#fff;font-size:13px;padding:12px 20px;border-radius:12px;z-index:99999;'
  + 'opacity:0;transition:all .25s ease;pointer-events:none;box-shadow:0 14px 34px rgba(16,24,40,.35);}'
  + '.vl-toast.on{opacity:1;transform:translateX(-50%) translateY(0);}';

  function injectCss() {
    if (d.getElementById("vl-style")) return;
    var s = d.createElement("style"); s.id = "vl-style"; s.textContent = CSS;
    (d.head || d.documentElement).appendChild(s);
  }

  /* ── утилиты ── */
  function RU(n) { return (Math.round(Number(n) || 0)).toLocaleString("ru-RU"); }
  function plural(n, a) { n = Math.abs(Number(n) || 0) % 100; var k = n % 10; if (n > 10 && n < 20) return a[2]; if (k > 1 && k < 5) return a[1]; if (k === 1) return a[0]; return a[2]; }
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }
  function fmtDate(ts) { try { return new Date(Number(ts)).toLocaleDateString("ru-RU", { day: "2-digit", month: "long", year: "numeric" }); } catch (e) { return ""; } }
  function el(html) { var t = d.createElement("template"); t.innerHTML = String(html).trim(); return t.content.firstChild; }
  function toast(msg) {
    var t = el('<div class="vl-toast">' + esc(msg) + "</div>"); d.body.appendChild(t);
    requestAnimationFrame(function () { t.classList.add("on"); });
    setTimeout(function () { t.classList.remove("on"); setTimeout(function () { t.remove(); }, 300); }, 2000);
  }
  var ICO = {
    pay: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="5" width="20" height="14" rx="3"/><path d="M2 10h20"/></svg>',
    gift: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="9" width="18" height="12" rx="2"/><path d="M12 9v12M3 13h18"/><path d="M12 9S10.5 4 8 4a2.5 2.5 0 0 0 0 5zM12 9s1.5-5 4-5a2.5 2.5 0 0 1 0 5z"/></svg>',
    plane: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12.5l19-8-8 19-2.5-8.5z"/></svg>'
  };
  // Палитра карты по статусу: серебро — сталь, золото — тёплая бронза, платина — глубокий фиолет.
  var SKIN = {
    base:     { c1: "#3b4a5f", c2: "#4c6076", c3: "#63798f", glow: "rgba(48,64,84,.55)" },
    silver:   { c1: "#5a6b7d", c2: "#7d8fa1", c3: "#a3b3c2", glow: "rgba(90,107,125,.55)" },
    gold:     { c1: "#8a6114", c2: "#b98a22", c3: "#dcb14a", glow: "rgba(150,105,25,.55)" },
    platinum: { c1: "#332a63", c2: "#4a3f8f", c3: "#7565cf", glow: "rgba(58,48,110,.6)" }
  };

  /* ── «i»: поповер порталом в body (иначе предки с transform ломают fixed) ── */
  function popClose(w) {
    if (!w) return; w.classList.remove("open");
    var p = w.__pop; if (!p) return;
    p.classList.remove("show", "up"); if (p.parentNode) p.parentNode.removeChild(p);
  }
  function popCloseAll() { [].forEach.call(d.querySelectorAll(".vl-pop.show"), function (p) { popClose(p.__owner); }); }
  function popPlace(wd) {
    var pop = wd.__pop;
    if (pop.parentNode !== d.body) d.body.appendChild(pop);
    pop.classList.add("show");
    var r = wd.getBoundingClientRect(), vw = w.innerWidth, vh = w.innerHeight;
    var pw = Math.min(330, vw - 24);
    pop.style.width = pw + "px";
    var left = Math.max(12, Math.min(r.left + r.width / 2 - pw / 2, vw - pw - 12));
    pop.style.left = left + "px";
    pop.style.top = (r.bottom + 9) + "px";
    pop.classList.remove("up");
    var ph = pop.offsetHeight;
    if (r.bottom + 9 + ph > vh - 12 && r.top - 9 - ph > 12) { pop.style.top = (r.top - 9 - ph) + "px"; pop.classList.add("up"); }
    pop.style.setProperty("--arrow-left", Math.max(10, Math.min(pw - 10, r.left + r.width / 2 - left)) + "px");
  }
  function vInfo(html) {
    if (!w.__vlPopBound) { w.__vlPopBound = true; d.addEventListener("click", popCloseAll); w.addEventListener("scroll", popCloseAll, true); w.addEventListener("resize", popCloseAll); }
    var wd = d.createElement("span");
    wd.className = "vl-i"; wd.setAttribute("role", "button"); wd.setAttribute("tabindex", "0");
    wd.setAttribute("aria-label", "Пояснение"); wd.textContent = "i";
    var pop = d.createElement("span"); pop.className = "vl-pop"; pop.innerHTML = html;
    wd.__pop = pop; pop.__owner = wd;
    wd.addEventListener("click", function (e) {
      e.stopPropagation(); e.preventDefault();
      var was = wd.classList.contains("open"); popCloseAll();
      if (!was) { wd.classList.add("open"); popPlace(wd); }
    });
    pop.addEventListener("click", function (e) { e.stopPropagation(); });
    return wd;
  }

  /* ── тексты поповеров (единственное место, где живут объяснения) ── */
  function txtTiers(card) {
    var rows = (card.tiers || []).map(function (t) {
      return '<div class="r' + (t.current ? " now" : "") + '"><span>' + esc(t.name)
        + (t.current ? " · ваш статус" : "") + '<br><i>' + (t.min > 0 ? "от " + RU(t.min) + " ₽ покупок" : "старт программы") + "</i></span>"
        + "<b>" + Math.round((t.rate || 0) * 100) + "%</b></div>";
    }).join("");
    return "<b>Статусы и процент кэшбэка</b><br>Процент зависит от суммы оплаченных вами услуг — "
      + "чем больше, тем выше. Статус остаётся с вами навсегда.<div style='margin-top:8px'>" + rows + "</div>"
      + "<div style='margin-top:8px;opacity:.75'>Ставка берётся по статусу на момент покупки; ранее начисленные баллы не пересчитываются.</div>";
  }
  function txtEarn(card) {
    var rate = Math.round((Number(card.rate) || 0) * 100);
    var first = (card.tiers || []).filter(function (t) { return t.rate > 0; })[0];
    return "<b>Как начисляются баллы</b><br>"
      + (rate > 0
        ? "С каждой оплаченной услуги возвращается <b>" + rate + "%</b> баллами. 1 балл = 1 ₽."
        : "Кэшбэк включается со статуса <b>" + esc(first ? first.name : "Silver") + "</b> — от " + RU(first ? first.min : 50000) + " ₽ оплаченных услуг. 1 балл = 1 ₽.")
      + "<br><br>Начисление автоматическое, обычно в течение суток после оплаты. Активировать ничего не нужно."
      + "<br><br>Баллы <b>не сгорают</b> и привязаны к вашему номеру телефона.";
  }
  function txtSpend(card) {
    var share = Math.round((Number(card.redeemMaxShare) || .3) * 100);
    return "<b>Как потратить баллы</b><br>1 балл = 1 ₽. Баллами можно оплатить до <b>" + share
      + "%</b> стоимости любой услуги агентства: визы, ВНЖ, страховки, банковские карты, туры."
      + "<br><br>Оставьте заявку кнопкой «Списать баллы» — менеджер подтвердит её и уменьшит сумму к оплате при оформлении."
      + "<br><br>Минимум к списанию — " + RU(card.redeemMin || 500) + " баллов.";
  }
  function txtRef(ref) {
    return "<b>Как работает приглашение</b><br>Отправьте другу свою ссылку. Когда он оформит первую услугу, "
      + "ему начислим <b>" + RU(ref.rewardFriend || 2000) + "</b> баллов, а вам — <b>" + RU(ref.rewardInviter || 2000) + "</b>."
      + "<br><br>Баллы приходят обоим автоматически после оформления заявки друга. Количество приглашений не ограничено.";
  }

  /* ══ блоки ══ */

  function vCard(card) {
    var bal = Number(card.balance) || 0;
    var sk = SKIN[card.tier] || SKIN.base;
    var rate = Math.round((Number(card.rate) || 0) * 100);
    var prog = "";
    if (card.nextTier && card.toNextSpend > 0) {
      var goal = (Number(card.spend) || 0) + (Number(card.toNextSpend) || 0);
      var pct = goal > 0 ? Math.max(3, Math.min(100, Math.round((Number(card.spend) || 0) / goal * 100))) : 0;
      prog = '<div class="vl-prog"><div class="vl-bar"><i data-w="' + pct + '"></i></div>'
           + '<div class="vl-cap">До статуса ' + esc(card.nextTier) + " — ещё " + RU(card.toNextSpend) + " ₽"
           + (card.nextRate ? ", кэшбэк станет " + Math.round(card.nextRate * 100) + "%" : "") + "</div></div>";
    } else if (!card.nextTier) {
      prog = '<div class="vl-prog"><div class="vl-cap">Максимальный статус — ваш кэшбэк ' + rate + "% ✦</div></div>";
    }
    var node = el(
      '<div class="vl-card" style="--c1:' + sk.c1 + ';--c2:' + sk.c2 + ';--c3:' + sk.c3 + ';--cglow:' + sk.glow + '">'
      + '<div class="vl-c-top"><div class="vl-brand">VOYO · БОНУСЫ</div>'
      + '<div class="vl-tier">' + esc(card.tierName || "Базовый") + (rate ? " · " + rate + "%" : "") + "</div></div>"
      + '<div class="vl-bal" data-to="' + bal + '">0<small>' + plural(bal, ["балл", "балла", "баллов"]) + "</small></div>"
      + '<div class="vl-eq">Это ' + RU(bal) + " ₽ скидки на следующую услугу</div>"
      + (card.name ? '<div class="vl-name">' + esc(card.name) + "</div>" : "")
      + prog + "</div>"
    );
    node.querySelector(".vl-tier").appendChild(vInfo(txtTiers(card)));
    var bar = node.querySelector(".vl-bar i");
    if (bar) requestAnimationFrame(function () { bar.style.width = bar.getAttribute("data-w") + "%"; });
    // Мягкий счётчик баланса — цифры «набегают» при появлении карты.
    var balEl = node.querySelector(".vl-bal"), small = balEl.querySelector("small").outerHTML;
    requestAnimationFrame(function (t0) {
      (function step(t) {
        var k = Math.min(1, (t - t0) / 800), e = 1 - Math.pow(1 - k, 3);
        balEl.innerHTML = RU(bal * e) + small;
        if (k < 1) requestAnimationFrame(step);
      })(t0);
    });
    return node;
  }

  function vTiles(card) {
    var rate = Math.round((Number(card.rate) || 0) * 100);
    var share = Math.round((Number(card.redeemMaxShare) || .3) * 100);
    var s = el('<section class="vl-tiles">'
      + '<div class="vl-tile"><div class="t">Кэшбэк</div><div class="v">' + (rate > 0 ? rate + "%" : "<span>с Silver</span>") + "</div></div>"
      + '<div class="vl-tile"><div class="t">Оплата баллами</div><div class="v">до ' + share + "%</div></div>"
      + '<div class="vl-tile"><div class="t">Бюджет</div><div class="v">' + RU(card.spend || 0) + " <span>₽</span></div></div></section>");
    var t = s.querySelectorAll(".vl-tile .t");
    t[0].appendChild(vInfo(txtEarn(card)));
    t[1].appendChild(vInfo(txtSpend(card)));
    t[2].appendChild(vInfo("<b>Ваш бюджет в агентстве</b><br>Сумма оплаченных вами услуг с 26.06.2026 — по ней считается статус и процент кэшбэка."));
    return s;
  }

  /* Списание баллов: заявка клиента → подтверждение менеджера → баллы уходят из баланса. */
  function vSpend(card, phone, api, onChanged) {
    var bal = Number(card.balance) || 0, min = Number(card.redeemMin) || 500;
    var s = d.createElement("section");

    if (card.redeemRequest) {
      var rq = card.redeemRequest;
      var p = el('<div class="vl-pend"><div class="ph">Заявка принята</div>'
        + '<div class="pd">Спишем <b>' + RU(rq.points) + "</b> " + plural(rq.points, ["балл", "балла", "баллов"])
        + " при оформлении ближайшей услуги — менеджер свяжется с вами."
        + ' <button class="vl-lnk" type="button" data-act="cancel">Отменить</button></div></div>');
      p.querySelector('[data-act="cancel"]').addEventListener("click", function () {
        fetch(api + "/redeem/cancel", { method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ phone: phone, id: rq.id }) })
          .then(function (r) { return r.json(); })
          .then(function (j) { if (j && j.ok) { toast("Заявка отменена"); onChanged(); } else toast("Заявку уже обработали"); })
          .catch(function () { toast("Не удалось отменить"); });
      });
      s.appendChild(p);
      return s;
    }

    if (bal < min) {
      var box0 = el('<div class="vl-spend"><div class="sh">Оплата баллами</div>'
        + '<div class="sd">Списывать можно от ' + RU(min) + " баллов — у вас " + RU(bal) + ".</div></div>");
      box0.querySelector(".sh").appendChild(vInfo(txtSpend(card)));
      s.appendChild(box0); return s;
    }

    var box = el('<div class="vl-spend"><div class="sh">Оплатить баллами</div>'
      + '<div class="sd">Сколько баллов списать со следующей услуги?</div>'
      + '<div class="sf"><input type="number" inputmode="numeric" min="' + min + '" max="' + bal + '" value="' + bal + '" data-f="pts">'
      + '<button class="vl-btn" type="button" data-act="send" style="flex:0 0 auto">Списать баллы</button></div>'
      + '<div class="er" data-f="err" style="display:none"></div></div>');
    box.querySelector(".sh").appendChild(vInfo(txtSpend(card)));
    var inp = box.querySelector('[data-f="pts"]'), err = box.querySelector('[data-f="err"]');
    box.querySelector('[data-act="send"]').addEventListener("click", function () {
      var n = Math.floor(Number(inp.value) || 0), btn = this;
      err.style.display = "none";
      if (n < min) { err.textContent = "Минимум к списанию — " + RU(min) + " баллов."; err.style.display = "block"; return; }
      if (n > bal) { err.textContent = "У вас всего " + RU(bal) + " баллов."; err.style.display = "block"; return; }
      btn.disabled = true; btn.textContent = "Отправляем…";
      fetch(api + "/redeem", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone: phone, points: n }) })
        .then(function (r) { return r.json(); })
        .then(function (j) {
          if (j && j.ok) { toast("Заявка отправлена — менеджер свяжется"); onChanged(); return; }
          btn.disabled = false; btn.textContent = "Списать баллы";
          err.textContent = j && j.reason === "not_enough" ? "Баллов не хватает — обновите страницу." : "Не удалось отправить заявку.";
          err.style.display = "block";
        })
        .catch(function () {
          btn.disabled = false; btn.textContent = "Списать баллы";
          err.textContent = "Не удалось отправить заявку."; err.style.display = "block";
        });
    });
    s.appendChild(box);
    return s;
  }

  function vRef(ref, refBase) {
    if (!ref || !ref.code) return null;
    var link = refBase + encodeURIComponent(ref.code);
    var txt = "Оформляю визы и поездки через VOYO. По моей ссылке тебе " + RU(ref.rewardFriend || 2000) + " бонусов на первую услугу: ";
    var wa = "https://wa.me/?text=" + encodeURIComponent(txt + link);
    var tg = "https://t.me/share/url?url=" + encodeURIComponent(link) + "&text=" + encodeURIComponent(txt);
    var s = el('<section><div class="vl-ref">'
      + '<div class="rh">Приглашайте друзей — по ' + RU(ref.rewardInviter || 2000) + " баллов</div>"
      + '<div class="vl-code"><div><div class="lb">Ваш код</div><div class="cd">' + esc(ref.code) + "</div></div>"
      + '<button class="vl-btn sec" style="flex:0 0 auto" data-act="copy">Скопировать</button></div>'
      + '<div class="vl-share">'
      + '<a class="vl-btn" href="' + esc(wa) + '" target="_blank" rel="noopener">WhatsApp</a>'
      + '<a class="vl-btn sec" href="' + esc(tg) + '" target="_blank" rel="noopener">Telegram</a></div>'
      + (ref.invitedCount ? '<div class="vl-rstat">Приглашено: <b>' + RU(ref.invitedCount) + "</b> · оформились: <b>"
          + RU(ref.qualifiedCount || 0) + "</b> · получено: <b>" + RU(ref.earnedPoints || 0) + "</b> баллов</div>" : "")
      + "</div></section>");
    s.querySelector(".rh").appendChild(vInfo(txtRef(ref)));
    s.querySelector('[data-act="copy"]').addEventListener("click", function () {
      try {
        if (navigator.clipboard) navigator.clipboard.writeText(link);
        else { var i = d.createElement("input"); i.value = link; d.body.appendChild(i); i.select(); d.execCommand("copy"); i.remove(); }
        toast("Ссылка скопирована");
      } catch (e) { toast(link); }
    });
    return s;
  }

  function vHist(card) {
    var list = (card.history || []).slice();
    var s = el('<section><div class="vl-hh">История</div><div class="vl-hist"></div></section>');
    var box = s.querySelector(".vl-hist");
    if (!list.length) {
      box.appendChild(el('<div class="vl-empty">После первой оплаченной услуги здесь появятся баллы.</div>'));
      return s;
    }
    var shown = 3;
    function draw() {
      box.innerHTML = "";
      list.slice(0, shown).forEach(function (h) {
        var p = (Number(h.points) || 0) >= 0;
        var isRef = /пригла|друг/i.test(h.note || "");
        var label = h.type === "redeem" ? "Оплата баллами"
          : (isRef ? "Бонус за друга"
          : (h.type === "earn" ? ("Кэшбэк" + (h.rate ? " " + Math.round(h.rate * 100) + "%" : "")) : "Корректировка"));
        box.appendChild(el('<div class="vl-op"><div class="oi">' + (h.type === "redeem" ? ICO.plane : (isRef ? ICO.gift : ICO.pay)) + "</div>"
          + '<div class="ol"><div class="t">' + esc(label) + '</div><div class="s">' + fmtDate(h.ts) + (h.note ? " · " + esc(h.note) : "") + "</div></div>"
          + '<div class="op ' + (p ? "plus" : "minus") + '">' + (p ? "+" : "−") + RU(Math.abs(h.points)) + "</div></div>"));
      });
      if (list.length > shown) {
        var b = el('<button class="vl-more" type="button">Показать всю историю (' + RU(list.length - shown) + ")</button>");
        b.addEventListener("click", function () { shown = list.length; draw(); });
        box.appendChild(b);
      }
    }
    draw();
    return s;
  }

  /* ══ монтирование ══ */
  var LS_KEY = "voyo_loyalty_phone";
  function lsGet() { try { return w.localStorage.getItem(LS_KEY) || ""; } catch (e) { return ""; } }
  function lsSet(v) { try { w.localStorage.setItem(LS_KEY, v || ""); } catch (e) {} }

  function mount(target, opts) {
    injectCss();
    opts = opts || {};
    var api = opts.api || "/beta/api/loyalty";
    var refBase = opts.refBase || (w.location.origin + "/app?ref=");
    var askPhone = opts.askPhone !== false;
    var root = el('<div class="vl-root"></div>');
    var phone = opts.phone || (askPhone ? lsGet() : "");
    target.innerHTML = ""; target.appendChild(root);

    function render(card, ref) {
      popCloseAll(); root.innerHTML = "";
      root.appendChild(vCard(card));
      root.appendChild(vTiles(card));
      root.appendChild(vSpend(card, phone, api, function () { load(phone); }));
      if (!opts.compact) {
        var r = vRef(ref, refBase); if (r) root.appendChild(r);
        root.appendChild(vHist(card));
      }
      if (askPhone) {
        var who = el('<div class="vl-who">Баллы для ' + esc(phone) + ' · <button class="vl-lnk" type="button">сменить номер</button></div>');
        who.querySelector("button").addEventListener("click", function () { lsSet(""); phone = ""; gate(); });
        root.appendChild(who);
      }
    }

    function gate() {
      popCloseAll(); root.innerHTML = "";
      var g = el('<div class="vl-gate"><div class="gh">Ваша бонусная карта</div>'
        + '<div class="gd">Баллы привязаны к номеру телефона — укажите его, чтобы увидеть баланс и статус.</div>'
        + '<div class="gf"><input type="tel" placeholder="+7 999 123-45-67" data-f="ph">'
        + '<button class="vl-btn" type="button" style="flex:0 0 auto">Показать</button></div></div>');
      var inp = g.querySelector('[data-f="ph"]');
      function go() { var v = inp.value.trim(); if (!v) { inp.focus(); return; } lsSet(v); phone = v; load(v); }
      g.querySelector("button").addEventListener("click", go);
      inp.addEventListener("keydown", function (e) { if (e.key === "Enter") go(); });
      root.appendChild(g); inp.focus();
    }

    function load(p) {
      if (p) phone = p;
      if (!phone) {
        if (askPhone) { gate(); return Promise.resolve(null); }
        root.innerHTML = '<div class="vl-state">Бонусная карта привязана к вашему номеру телефона.<br>Откройте кабинет по персональной ссылке, чтобы увидеть баллы.</div>';
        return Promise.resolve(null);
      }
      root.innerHTML = '<div class="vl-skel"></div>';
      return fetch(api + "?phone=" + encodeURIComponent(phone))
        .then(function (r) { return r.json(); })
        .then(function (j) {
          if (!j || !j.success || !j.card) throw new Error("bad");
          render(j.card, j.referral);
          return j;
        })
        .catch(function (e) {
          root.innerHTML = '<div class="vl-state">Не удалось загрузить бонусную карту. Обновите страницу или напишите нам — поможем.</div>';
          if (opts.onError) opts.onError(e);
          return null;
        });
    }

    var ctl = { el: root, reload: load, get phone() { return phone; } };
    load(phone);
    return ctl;
  }

  w.VoyoLoyalty = { mount: mount, version: 3 };
})(window, document);
