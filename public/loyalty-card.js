/* ══════════════════════════════════════════════════════════════════════════
   VOYO — БОНУСНАЯ ПРОГРАММА: портативный клиентский виджет.

   Один файл, ноль зависимостей, свои стили (все классы с префиксом .vl-,
   инжектятся один раз) — чтобы вшить в клиентский ЛК одной строкой:

       <script src="/loyalty-card.js"></script>
       <div id="bonus"></div>
       <script>VoyoLoyalty.mount(document.getElementById("bonus"), {phone: PHONE});</script>

   Данные берёт из уже существующего открытого API /beta/api/loyalty?phone=
   (карта + реферальный блок). Ничего не пишет и не меняет — только читает.

   opts:
     phone     — телефон клиента (обязателен; без него рисуем понятную заглушку)
     api       — базовый путь API (по умолчанию "/beta/api/loyalty")
     refBase   — на что ведёт реферальная ссылка (по умолчанию origin + "/app?ref=")
     compact   — true: без FAQ и «как это работает» (для узких мест ЛК)
   Возвращает контроллер: { reload(phone), el }.
   ══════════════════════════════════════════════════════════════════════════ */
(function (w, d) {
  "use strict";
  if (w.VoyoLoyalty) return;

  var CSS = ''
  + '.vl-root{--vl-accent:#3589BD;--vl-accent-d:#2b6d97;--vl-ink:#171c29;--vl-mut:#6a7385;'
  + '--vl-line:rgba(23,32,60,.09);--vl-bg:#fff;--vl-soft:#f4f7fb;--vl-green:#2f8a52;--vl-red:#b0263a;'
  + '--vl-sh:0 1px 2px rgba(16,24,40,.04),0 14px 34px -18px rgba(16,32,64,.20);'
  + '--vl-r:18px;color:var(--vl-ink);'
  + 'font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text","Segoe UI",Roboto,Helvetica,Arial,sans-serif;'
  + '-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility;line-height:1.45;}'
  + '.vl-root *{box-sizing:border-box;}'
  + '.vl-sec{margin-top:18px;}'
  + '.vl-h{font-size:15px;font-weight:700;letter-spacing:-.01em;margin:0 0 10px;}'
  + '.vl-sub{font-size:13px;color:var(--vl-mut);margin:-6px 0 12px;}'

  /* ── карта ── */
  + '.vl-card{position:relative;overflow:hidden;border-radius:22px;padding:22px 22px 20px;color:#fff;'
  + 'background:linear-gradient(140deg,#2a6690 0%,#3589BD 48%,#4fb0d8 100%);'
  + 'box-shadow:0 10px 30px -12px rgba(31,86,124,.55),0 2px 6px rgba(16,24,40,.10);}'
  + '.vl-card::after{content:"";position:absolute;right:-70px;top:-90px;width:240px;height:240px;border-radius:50%;background:rgba(255,255,255,.10);}'
  + '.vl-card::before{content:"";position:absolute;left:-60px;bottom:-120px;width:220px;height:220px;border-radius:50%;background:rgba(255,255,255,.07);}'
  + '.vl-card>*{position:relative;z-index:1;}'
  + '.vl-c-top{display:flex;justify-content:space-between;align-items:center;gap:10px;}'
  + '.vl-brand{display:flex;align-items:center;gap:8px;font-weight:700;font-size:12.5px;letter-spacing:.14em;opacity:.92;}'
  + '.vl-tier{font-size:11.5px;font-weight:700;padding:6px 12px;border-radius:999px;background:rgba(255,255,255,.20);'
  + 'backdrop-filter:saturate(140%) blur(6px);-webkit-backdrop-filter:saturate(140%) blur(6px);white-space:nowrap;}'
  + '.vl-bal{font-size:46px;font-weight:800;letter-spacing:-.03em;line-height:1;margin:18px 0 4px;}'
  + '.vl-bal small{font-size:16px;font-weight:600;opacity:.85;margin-left:8px;letter-spacing:0;}'
  + '.vl-eq{font-size:13.5px;opacity:.92;}'
  + '.vl-name{font-size:13px;opacity:.8;margin-top:14px;letter-spacing:.01em;}'
  + '.vl-prog{margin-top:16px;}'
  + '.vl-prog .vl-bar{height:8px;border-radius:99px;background:rgba(255,255,255,.24);overflow:hidden;}'
  + '.vl-prog .vl-bar i{display:block;height:100%;border-radius:99px;background:#fff;width:0;transition:width .9s cubic-bezier(.22,.61,.36,1);}'
  + '.vl-prog .vl-cap{font-size:12px;opacity:.92;margin-top:8px;}'

  /* ── две плитки «копить / тратить» ── */
  + '.vl-tiles{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:12px;}'
  + '.vl-tile{background:var(--vl-bg);border:1px solid var(--vl-line);border-radius:16px;padding:13px 14px;box-shadow:var(--vl-sh);}'
  + '.vl-tile .t{font-size:11.5px;text-transform:uppercase;letter-spacing:.05em;color:var(--vl-mut);font-weight:700;margin-bottom:5px;}'
  + '.vl-tile .v{font-size:13.5px;font-weight:600;line-height:1.4;}'
  + '.vl-tile .v b{color:var(--vl-accent-d);}'
  + '@media(max-width:420px){.vl-tiles{grid-template-columns:1fr;}}'

  /* ── шаги «как это работает» ── */
  + '.vl-steps{display:grid;gap:10px;}'
  + '.vl-step{display:flex;gap:12px;align-items:flex-start;background:var(--vl-bg);border:1px solid var(--vl-line);'
  + 'border-radius:16px;padding:13px 14px;box-shadow:var(--vl-sh);}'
  + '.vl-ico{flex:none;width:36px;height:36px;border-radius:12px;display:flex;align-items:center;justify-content:center;'
  + 'background:linear-gradient(140deg,#e8f3fa,#d8ebf7);color:var(--vl-accent-d);}'
  + '.vl-ico svg{width:19px;height:19px;display:block;}'
  + '.vl-step .tx{font-size:13.5px;line-height:1.45;}'
  + '.vl-step .tx b{display:block;font-size:14px;margin-bottom:2px;letter-spacing:-.01em;}'
  + '.vl-step .tx span{color:var(--vl-mut);}'

  /* ── лестница статусов ── */
  + '.vl-ladder{background:var(--vl-bg);border:1px solid var(--vl-line);border-radius:18px;padding:6px 16px;box-shadow:var(--vl-sh);}'
  + '.vl-lv{display:flex;gap:13px;padding:13px 0;border-bottom:1px solid var(--vl-line);align-items:flex-start;}'
  + '.vl-lv:last-child{border-bottom:0;}'
  + '.vl-dot{flex:none;width:22px;height:22px;border-radius:50%;border:2px solid var(--vl-line);margin-top:2px;'
  + 'display:flex;align-items:center;justify-content:center;font-size:11px;color:#fff;background:#fff;}'
  + '.vl-lv.done .vl-dot{background:var(--vl-accent);border-color:var(--vl-accent);}'
  + '.vl-lv.now .vl-dot{background:var(--vl-accent);border-color:var(--vl-accent);box-shadow:0 0 0 4px rgba(53,137,189,.16);}'
  + '.vl-lv .nm{font-size:14px;font-weight:600;letter-spacing:-.01em;display:flex;align-items:center;gap:8px;flex-wrap:wrap;}'
  + '.vl-lv .nm em{font-style:normal;font-size:10.5px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;'
  + 'color:var(--vl-accent-d);background:rgba(53,137,189,.12);border-radius:999px;padding:3px 8px;}'
  + '.vl-lv .nm em.rate{background:linear-gradient(140deg,#4aa3d8,#3589BD);color:#fff;letter-spacing:.02em;font-size:11px;}'
  + '.vl-lv.locked .nm em.rate{background:#e9edf3;color:var(--vl-mut);}'
  + '.vl-lv .th{font-size:12px;color:var(--vl-mut);margin-top:2px;}'
  + '.vl-lv .pk{font-size:12.5px;color:var(--vl-mut);margin-top:4px;}'
  + '.vl-lv.locked .nm,.vl-lv.locked .pk{opacity:.62;}'

  /* ── реферальный блок ── */
  + '.vl-ref{border-radius:18px;padding:18px;background:linear-gradient(150deg,#f2f8fc 0%,#eaf4fb 100%);border:1px solid rgba(53,137,189,.20);}'
  + '.vl-ref h4{margin:0 0 4px;font-size:15px;letter-spacing:-.01em;}'
  + '.vl-ref .rd{font-size:13px;color:var(--vl-mut);margin-bottom:14px;}'
  + '.vl-ref .rd b{color:var(--vl-ink);}'
  + '.vl-code{display:flex;align-items:center;justify-content:space-between;gap:10px;background:#fff;border:1px dashed rgba(53,137,189,.45);'
  + 'border-radius:14px;padding:12px 14px;}'
  + '.vl-code .lb{font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--vl-mut);font-weight:700;}'
  + '.vl-code .cd{font-size:22px;font-weight:800;letter-spacing:.14em;color:var(--vl-accent-d);font-variant-numeric:tabular-nums;}'
  + '.vl-share{display:flex;gap:8px;margin-top:12px;flex-wrap:wrap;}'
  + '.vl-btn{flex:1 1 auto;min-width:112px;text-align:center;cursor:pointer;border:0;border-radius:12px;padding:11px 14px;'
  + 'font:inherit;font-size:13.5px;font-weight:600;text-decoration:none;display:inline-block;'
  + 'background:linear-gradient(140deg,#4aa3d8,#3589BD);color:#fff;box-shadow:0 8px 18px -9px rgba(53,137,189,.65);'
  + 'transition:transform .16s ease,filter .16s ease;}'
  + '.vl-btn:hover{filter:brightness(1.06);transform:translateY(-1px);}'
  + '.vl-btn.sec{background:#fff;color:var(--vl-accent-d);border:1px solid rgba(53,137,189,.28);box-shadow:none;}'
  + '.vl-rstat{display:flex;gap:8px;flex-wrap:wrap;margin-top:14px;}'
  + '.vl-pill{flex:1 1 auto;background:rgba(255,255,255,.75);border:1px solid var(--vl-line);border-radius:12px;padding:9px 11px;'
  + 'font-size:11.5px;color:var(--vl-mut);text-align:center;}'
  + '.vl-pill b{display:block;font-size:17px;color:var(--vl-ink);font-weight:700;margin-top:2px;letter-spacing:-.01em;}'
  + '.vl-inv{margin-top:12px;background:rgba(255,255,255,.7);border:1px solid var(--vl-line);border-radius:12px;padding:4px 12px;}'
  + '.vl-inv .it{display:flex;justify-content:space-between;align-items:center;gap:10px;padding:9px 0;border-bottom:1px solid var(--vl-line);font-size:13px;}'
  + '.vl-inv .it:last-child{border-bottom:0;}'
  + '.vl-bdg{font-size:11px;font-weight:700;border-radius:999px;padding:4px 9px;white-space:nowrap;}'
  + '.vl-bdg.q{background:rgba(47,138,82,.13);color:var(--vl-green);}'
  + '.vl-bdg.p{background:rgba(201,151,43,.16);color:#8a6410;}'

  /* ── история ── */
  + '.vl-hist{background:var(--vl-bg);border:1px solid var(--vl-line);border-radius:18px;padding:4px 16px;box-shadow:var(--vl-sh);}'
  + '.vl-op{display:flex;gap:12px;align-items:center;padding:12px 0;border-bottom:1px solid var(--vl-line);}'
  + '.vl-op:last-child{border-bottom:0;}'
  + '.vl-op .oi{flex:none;width:32px;height:32px;border-radius:10px;display:flex;align-items:center;justify-content:center;font-size:14px;'
  + 'background:rgba(53,137,189,.10);color:var(--vl-accent-d);}'
  + '.vl-op .ol{flex:1;min-width:0;}'
  + '.vl-op .ol .t{font-size:13.5px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}'
  + '.vl-op .ol .s{font-size:11.5px;color:var(--vl-mut);margin-top:1px;}'
  + '.vl-op .op{font-size:15px;font-weight:700;white-space:nowrap;font-variant-numeric:tabular-nums;}'
  + '.vl-op .op.plus{color:var(--vl-green);}.vl-op .op.minus{color:var(--vl-red);}'
  + '.vl-more{width:100%;margin:2px 0 12px;background:none;border:0;color:var(--vl-accent-d);font:inherit;font-size:13px;'
  + 'font-weight:600;cursor:pointer;padding:8px;border-radius:10px;}'
  + '.vl-more:hover{background:var(--vl-soft);}'
  + '.vl-empty{padding:18px 0;text-align:center;color:var(--vl-mut);font-size:13px;}'

  /* ── FAQ ── */
  + '.vl-faq{background:var(--vl-bg);border:1px solid var(--vl-line);border-radius:18px;padding:2px 16px;box-shadow:var(--vl-sh);}'
  + '.vl-faq details{border-bottom:1px solid var(--vl-line);}'
  + '.vl-faq details:last-child{border-bottom:0;}'
  + '.vl-faq summary{cursor:pointer;list-style:none;padding:14px 0;font-size:13.5px;font-weight:600;display:flex;'
  + 'justify-content:space-between;align-items:center;gap:10px;}'
  + '.vl-faq summary::-webkit-details-marker{display:none;}'
  + '.vl-faq summary::after{content:"+";color:var(--vl-accent);font-size:19px;font-weight:400;line-height:1;flex:none;}'
  + '.vl-faq details[open] summary::after{content:"–";}'
  + '.vl-faq .an{font-size:13px;color:var(--vl-mut);padding:0 0 14px;line-height:1.55;}'

  /* ── списание баллов ── */
  + '.vl-spend{background:var(--vl-bg);border:1px solid var(--vl-line);border-radius:18px;padding:16px;box-shadow:var(--vl-sh);}'
  + '.vl-spend .sh{font-size:14px;font-weight:700;letter-spacing:-.01em;margin-bottom:4px;}'
  + '.vl-spend .sd{font-size:12.5px;color:var(--vl-mut);line-height:1.5;}'
  + '.vl-spend .sf{display:flex;gap:8px;margin-top:12px;flex-wrap:wrap;align-items:center;}'
  + '.vl-spend input{flex:1;min-width:120px;border:1px solid var(--vl-line);border-radius:12px;padding:11px 13px;'
  + 'font:inherit;font-size:14px;background:#fff;color:var(--vl-ink);}'
  + '.vl-spend input:focus{outline:none;border-color:var(--vl-accent);box-shadow:0 0 0 3px rgba(53,137,189,.14);}'
  + '.vl-spend .er{color:var(--vl-red);font-size:12.5px;margin-top:8px;}'
  + '.vl-pend{background:linear-gradient(150deg,#fff8e8,#fdf3dd);border:1px solid rgba(201,151,43,.30);border-radius:18px;padding:16px;}'
  + '.vl-pend .ph{font-size:14px;font-weight:700;margin-bottom:4px;}'
  + '.vl-pend .pd{font-size:12.5px;color:#6b5a2e;line-height:1.5;}'
  + '.vl-lnk{background:none;border:0;padding:0;font:inherit;font-size:12.5px;color:var(--vl-accent-d);'
  + 'cursor:pointer;text-decoration:underline;}'

  /* ── ввод номера (только бета: в ЛК номер берётся из сессии) ── */
  + '.vl-gate{background:var(--vl-bg);border:1px solid var(--vl-line);border-radius:18px;padding:22px 20px;box-shadow:var(--vl-sh);text-align:center;}'
  + '.vl-gate .gh{font-size:15px;font-weight:700;letter-spacing:-.01em;margin-bottom:5px;}'
  + '.vl-gate .gd{font-size:13px;color:var(--vl-mut);line-height:1.5;margin-bottom:14px;}'
  + '.vl-gate .gf{display:flex;gap:8px;flex-wrap:wrap;}'
  + '.vl-gate input{flex:1;min-width:150px;border:1px solid var(--vl-line);border-radius:12px;padding:11px 13px;'
  + 'font:inherit;font-size:14px;background:#fff;color:var(--vl-ink);text-align:center;}'
  + '.vl-gate input:focus{outline:none;border-color:var(--vl-accent);box-shadow:0 0 0 3px rgba(53,137,189,.14);}'
  + '.vl-who{text-align:center;font-size:12px;color:var(--vl-mut);margin-top:14px;}'

  /* ── состояния ── */
  + '.vl-state{background:var(--vl-bg);border:1px solid var(--vl-line);border-radius:18px;padding:26px 20px;text-align:center;'
  + 'color:var(--vl-mut);font-size:13.5px;box-shadow:var(--vl-sh);}'
  + '.vl-skel{border-radius:22px;height:196px;background:linear-gradient(100deg,#eef2f7 30%,#f7fafd 50%,#eef2f7 70%);'
  + 'background-size:220% 100%;animation:vlsk 1.3s linear infinite;}'
  + '@keyframes vlsk{0%{background-position:120% 0}100%{background-position:-40% 0}}'
  + '.vl-toast{position:fixed;left:50%;bottom:28px;transform:translateX(-50%) translateY(10px);background:rgba(23,28,41,.94);'
  + 'color:#fff;font-size:13px;padding:11px 18px;border-radius:12px;z-index:99999;opacity:0;transition:all .25s ease;pointer-events:none;}'
  + '.vl-toast.on{opacity:1;transform:translateX(-50%) translateY(0);}';

  function injectCss() {
    if (d.getElementById("vl-style")) return;
    var s = d.createElement("style"); s.id = "vl-style"; s.textContent = CSS;
    (d.head || d.documentElement).appendChild(s);
  }

  /* ── утилиты ── */
  function RU(n) { return (Math.round(Number(n) || 0)).toLocaleString("ru-RU"); }
  function plural(n, a) { n = Math.abs(Number(n) || 0) % 100; var k = n % 10; if (n > 10 && n < 20) return a[2]; if (k > 1 && k < 5) return a[1]; if (k === 1) return a[0]; return a[2]; }
  function pts(n) { return RU(n) + " " + plural(n, ["балл", "балла", "баллов"]); }
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }
  function fmtDate(ts) { try { return new Date(Number(ts)).toLocaleDateString("ru-RU", { day: "2-digit", month: "long", year: "numeric" }); } catch (e) { return ""; } }
  function el(html) { var t = d.createElement("template"); t.innerHTML = String(html).trim(); return t.content.firstChild; }
  function toast(msg) {
    var t = el('<div class="vl-toast">' + esc(msg) + "</div>"); d.body.appendChild(t);
    requestAnimationFrame(function () { t.classList.add("on"); });
    setTimeout(function () { t.classList.remove("on"); setTimeout(function () { t.remove(); }, 300); }, 1900);
  }
  var ICO = {
    pay: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="5" width="20" height="14" rx="3"/><path d="M2 10h20"/></svg>',
    gift: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="9" width="18" height="12" rx="2"/><path d="M12 9v12M3 13h18"/><path d="M12 9S10.5 4 8 4a2.5 2.5 0 0 0 0 5zM12 9s1.5-5 4-5a2.5 2.5 0 0 1 0 5z"/></svg>',
    plane: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12.5l19-8-8 19-2.5-8.5z"/></svg>',
    check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round" style="width:12px;height:12px"><path d="M4 12.5l5.2 5.2L20 7"/></svg>'
  };

  /* ══ рендер частей ══ */

  function vCard(card) {
    var bal = Number(card.balance) || 0;
    var prog = "";
    if (card.nextTier && card.toNextSpend > 0) {
      var goal = (Number(card.spend) || 0) + (Number(card.toNextSpend) || 0);
      var pct = goal > 0 ? Math.max(4, Math.min(100, Math.round((Number(card.spend) || 0) / goal * 100))) : 0;
      var upto = card.nextRate
        ? (", и кэшбэк " + (Number(card.rate) > 0 ? "вырастет" : "включится") + " — " + Math.round(card.nextRate * 100) + "%")
        : "";
      prog = '<div class="vl-prog"><div class="vl-bar"><i data-w="' + pct + '"></i></div>'
           + '<div class="vl-cap">До статуса ' + esc(card.nextTier) + " — ещё " + RU(card.toNextSpend) + " ₽" + upto + "</div></div>";
    } else if (!card.nextTier) {
      prog = '<div class="vl-prog"><div class="vl-cap">Максимальный статус — ваш кэшбэк ' + Math.round((Number(card.rate) || 0) * 100) + "% ✦</div></div>";
    }
    var node = el(
      '<div class="vl-card">'
      + '<div class="vl-c-top"><div class="vl-brand">VOYO · БОНУСЫ</div>'
      + '<div class="vl-tier">' + esc(card.tierName || "Базовый") + (card.rate ? " · " + Math.round(card.rate * 100) + "%" : "") + "</div></div>"
      + '<div class="vl-bal">' + RU(bal) + "<small>" + plural(bal, ["балл", "балла", "баллов"]) + "</small></div>"
      + '<div class="vl-eq">Это ' + RU(bal) + " ₽ скидки на следующую услугу</div>"
      + (card.name ? '<div class="vl-name">' + esc(card.name) + "</div>" : "")
      + prog + "</div>"
    );
    var bar = node.querySelector(".vl-bar i");
    if (bar) requestAnimationFrame(function () { bar.style.width = bar.getAttribute("data-w") + "%"; });
    return node;
  }

  function vTiles(card) {
    var rate = Math.round((Number(card.rate) || 0) * 100);
    var share = Math.round((Number(card.redeemMaxShare) || .3) * 100);
    // Ставка зависит от статуса, поэтому у новичка формулировка другая — что сделать,
    // чтобы кэшбэк включился, а не «0% баллами».
    var first = (card.tiers || []).filter(function (t) { return t.rate > 0; })[0];
    var earn = rate > 0
      ? "<b>" + rate + "%</b> баллами возвращается с каждой оплаченной услуги — это ваш статус " + esc(card.tierName || "")
      : "Кэшбэк включится со статуса <b>" + esc(first ? first.name : "Silver") + "</b> — от " + RU(first ? first.min : 50000) + " ₽ покупок";
    return el('<div class="vl-tiles">'
      + '<div class="vl-tile"><div class="t">Как копить</div><div class="v">' + earn + "</div></div>"
      + '<div class="vl-tile"><div class="t">Как тратить</div><div class="v">1 балл = <b>1 ₽</b>, можно оплатить до <b>' + share + "%</b> любой услуги: визы, ВНЖ, страховки, банковской карты</div></div></div>");
  }

  function vSteps(card) {
    var rate = Math.round((Number(card.rate) || 0) * 100);
    var share = Math.round((Number(card.redeemMaxShare) || .3) * 100);
    var paid = (card.tiers || []).filter(function (t) { return t.rate > 0; });
    var scale = paid.map(function (t) { return Math.round(t.rate * 100) + "% с " + RU(t.min) + " ₽"; }).join(", ");
    var s = el('<div class="vl-sec"><div class="vl-h">Как это работает</div><div class="vl-steps"></div></div>');
    var box = s.querySelector(".vl-steps");
    [[ICO.pay, "Оформляете услугу", "Виза, ВНЖ, страховка, банковская карта — любая оплаченная услуга VOYO участвует в программе."],
     [ICO.gift, rate > 0 ? "Получаете " + rate + "% баллами" : "Копите бюджет — включается кэшбэк",
      "Процент растёт вместе с вашим бюджетом в агентстве: " + scale + ". Баллы приходят автоматически после оплаты, активировать ничего не нужно."],
     [ICO.plane, "Платите баллами", "Скажите менеджеру, что хотите списать баллы — спишем до " + share + "% стоимости следующей услуги."]
    ].forEach(function (x) {
      box.appendChild(el('<div class="vl-step"><div class="vl-ico">' + x[0] + '</div><div class="tx"><b>' + esc(x[1]) + "</b><span>" + esc(x[2]) + "</span></div></div>"));
    });
    return s;
  }

  function vLadder(card) {
    var tiers = card.tiers || [];
    if (!tiers.length) return null;
    var s = el('<div class="vl-sec"><div class="vl-h">Ваш статус и процент кэшбэка</div>'
      + '<div class="vl-sub">Чем больше ваш бюджет в агентстве, тем выше процент. Статус остаётся с вами.</div><div class="vl-ladder"></div></div>');
    var box = s.querySelector(".vl-ladder");
    tiers.forEach(function (t) {
      var cls = t.current ? "now" : (t.reached ? "done" : "locked");
      var pc = t.rate > 0 ? '<em class="rate">' + Math.round(t.rate * 100) + "%</em>" : "";
      box.appendChild(el('<div class="vl-lv ' + cls + '">'
        + '<div class="vl-dot">' + (t.reached ? ICO.check : "") + "</div>"
        + '<div><div class="nm">' + esc(t.name) + pc + (t.current ? "<em>ваш статус</em>" : "") + "</div>"
        + '<div class="th">' + (t.min > 0 ? "от " + RU(t.min) + " ₽ оплаченных услуг" : "старт программы") + "</div>"
        + '<div class="pk">' + esc(t.perk || "") + "</div></div></div>"));
    });
    return s;
  }

  function vRef(ref, refBase) {
    if (!ref || !ref.code) return null;
    var link = refBase + encodeURIComponent(ref.code);
    var txt = "Оформляю визы и поездки через VOYO. По моей ссылке тебе " + RU(ref.rewardFriend || 1500) + " бонусов на первую услугу: ";
    var wa = "https://wa.me/?text=" + encodeURIComponent(txt + link);
    var tg = "https://t.me/share/url?url=" + encodeURIComponent(link) + "&text=" + encodeURIComponent(txt);
    var s = el('<div class="vl-sec"><div class="vl-ref">'
      + "<h4>Приглашайте друзей</h4>"
      + '<div class="rd">Другу — <b>' + RU(ref.rewardFriend || 1500) + " баллов</b> на первую услугу. Вам — <b>"
      + RU(ref.rewardInviter || 2000) + " баллов</b>, как только друг оформит заявку.</div>"
      + '<div class="vl-code"><div><div class="lb">Ваш код</div><div class="cd">' + esc(ref.code) + "</div></div>"
      + '<button class="vl-btn sec" style="flex:none;min-width:auto" data-act="copy">Скопировать ссылку</button></div>'
      + '<div class="vl-share">'
      + '<a class="vl-btn" href="' + esc(wa) + '" target="_blank" rel="noopener">Отправить в WhatsApp</a>'
      + '<a class="vl-btn sec" href="' + esc(tg) + '" target="_blank" rel="noopener">В Telegram</a></div>'
      + '<div class="vl-rstat">'
      + '<div class="vl-pill">Приглашено<b>' + RU(ref.invitedCount || 0) + "</b></div>"
      + '<div class="vl-pill">Оформились<b>' + RU(ref.qualifiedCount || 0) + "</b></div>"
      + '<div class="vl-pill">Заработано<b>' + RU(ref.earnedPoints || 0) + "</b></div></div>"
      + "</div></div>");
    if ((ref.invited || []).length) {
      var inv = el('<div class="vl-inv"></div>');
      ref.invited.forEach(function (i) {
        var q = i.status === "qualified";
        inv.appendChild(el('<div class="it"><span>' + esc(i.phone) + '</span><span class="vl-bdg ' + (q ? "q" : "p") + '">'
          + (q ? "оформился · баллы начислены" : "ждём первую заявку") + "</span></div>"));
      });
      s.querySelector(".vl-ref").appendChild(inv);
    }
    s.querySelector('[data-act="copy"]').addEventListener("click", function () {
      try {
        if (navigator.clipboard) navigator.clipboard.writeText(link);
        else { var i = d.createElement("input"); i.value = link; d.body.appendChild(i); i.select(); d.execCommand("copy"); i.remove(); }
        toast("Ссылка скопирована");
      } catch (e) { toast(link); }
    });
    return s;
  }

  /* Списание баллов: клиент оставляет заявку → менеджер подтверждает → баллы
     уходят из баланса. Кнопки-обманки нет: если списывать нечего, честно пишем. */
  function vSpend(card, phone, api, onChanged) {
    var bal = Number(card.balance) || 0;
    var min = Number(card.redeemMin) || 500;
    var share = Math.round((Number(card.redeemMaxShare) || .3) * 100);
    var s = el('<div class="vl-sec"></div>');

    if (card.redeemRequest) {
      var rq = card.redeemRequest;
      var p = el('<div class="vl-pend"><div class="ph">Заявка на списание принята</div>'
        + '<div class="pd">Вы попросили списать <b>' + RU(rq.points) + "</b> " + plural(rq.points, ["балл", "балла", "баллов"])
        + " — от " + fmtDate(rq.ts) + ". Менеджер учтёт их при оформлении ближайшей услуги и свяжется с вами."
        + '</div><div style="margin-top:10px"><button class="vl-lnk" type="button" data-act="cancel">Отменить заявку</button></div></div>');
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
      s.appendChild(el('<div class="vl-spend"><div class="sh">Оплата баллами</div>'
        + '<div class="sd">Списывать баллы можно от <b>' + RU(min) + "</b> — сейчас у вас "
        + RU(bal) + ". Оформите ещё одну услугу, и баллов хватит.</div></div>"));
      return s;
    }

    var box = el('<div class="vl-spend"><div class="sh">Оплатить баллами</div>'
      + '<div class="sd">Скажите нам, сколько баллов списать со следующей услуги. Менеджер подтвердит и уменьшит сумму к оплате — до ' + share + "% стоимости.</div>"
      + '<div class="sf"><input type="number" inputmode="numeric" min="' + min + '" max="' + bal + '" value="' + bal + '" data-f="pts">'
      + '<button class="vl-btn" type="button" data-act="send" style="flex:0 0 auto">Списать баллы</button></div>'
      + '<div class="er" data-f="err" style="display:none"></div></div>');
    var inp = box.querySelector('[data-f="pts"]'), err = box.querySelector('[data-f="err"]');
    box.querySelector('[data-act="send"]').addEventListener("click", function () {
      var n = Math.floor(Number(inp.value) || 0);
      err.style.display = "none";
      if (n < min) { err.textContent = "Минимум к списанию — " + RU(min) + " баллов."; err.style.display = "block"; return; }
      if (n > bal) { err.textContent = "У вас всего " + RU(bal) + " баллов."; err.style.display = "block"; return; }
      this.disabled = true; this.textContent = "Отправляем…";
      fetch(api + "/redeem", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone: phone, points: n }) })
        .then(function (r) { return r.json(); })
        .then(function (j) {
          if (j && j.ok) { toast("Заявка отправлена — менеджер свяжется"); onChanged(); return; }
          err.textContent = j && j.reason === "not_enough" ? "Баллов не хватает — обновите страницу." : "Не удалось отправить заявку.";
          err.style.display = "block";
        })
        .catch(function () { err.textContent = "Не удалось отправить заявку."; err.style.display = "block"; });
    });
    s.appendChild(box);
    return s;
  }

  function vHist(card) {
    var list = (card.history || []).slice();
    var s = el('<div class="vl-sec"><div class="vl-h">История баллов</div><div class="vl-hist"></div></div>');
    var box = s.querySelector(".vl-hist");
    if (!list.length) {
      box.appendChild(el('<div class="vl-empty">Пока пусто. После первой оплаченной услуги здесь появятся баллы.</div>'));
      return s;
    }
    var SHOW = 5, shown = SHOW;
    function draw() {
      box.innerHTML = "";
      list.slice(0, shown).forEach(function (h) {
        var p = (Number(h.points) || 0) >= 0;
        var isRef = /пригла|друг/i.test(h.note || "");
        var label = h.type === "redeem" ? "Списание баллов"
          : (isRef ? "Бонус за друга"
          : (h.type === "earn" ? ("Кэшбэк с услуги" + (h.rate ? " · " + Math.round(h.rate * 100) + "%" : "")) : "Корректировка"));
        box.appendChild(el('<div class="vl-op"><div class="oi">' + (h.type === "redeem" ? ICO.plane : (isRef ? ICO.gift : ICO.pay)) + "</div>"
          + '<div class="ol"><div class="t">' + esc(label) + '</div><div class="s">' + fmtDate(h.ts) + (h.note ? " · " + esc(h.note) : "") + "</div></div>"
          + '<div class="op ' + (p ? "plus" : "minus") + '">' + (p ? "+" : "−") + RU(Math.abs(h.points)) + "</div></div>"));
      });
      if (list.length > shown) {
        var b = el('<button class="vl-more" type="button">Показать ещё ' + Math.min(20, list.length - shown) + " из " + RU(list.length - shown) + "</button>");
        b.addEventListener("click", function () { shown += 20; draw(); });
        box.appendChild(b);
      }
    }
    draw();
    return s;
  }

  function vFaq(card) {
    var rate = Math.round((Number(card.rate) || 0) * 100);
    var share = Math.round((Number(card.redeemMaxShare) || .3) * 100);
    var ttl = Number(card.pointsTtlDays) || 0;
    var paid = (card.tiers || []).filter(function (t) { return t.rate > 0; });
    var scale = paid.map(function (t) { return esc(t.name) + " — " + Math.round(t.rate * 100) + "% от " + RU(t.min) + " ₽"; }).join("; ");
    var ex = rate > 0 ? rate : (paid[0] ? Math.round(paid[0].rate * 100) : 5);
    var qa = [
      ["Как считается мой процент?", "Процент зависит от суммы оплаченных вами услуг: " + scale + ". Как только бюджет достигает следующей ступени, кэшбэк по новым услугам считается уже по повышенной ставке."],
      ["Когда начисляются баллы?", "После оплаты услуги. Начисление происходит автоматически — как правило, в течение суток."],
      ["Сгорают ли баллы?", ttl > 0 ? ("Баллы действуют " + ttl + " дней с последней активности.") : "Нет. Срок действия баллов не ограничен — копите столько, сколько нужно."],
      ["На что можно потратить баллы?", "На любые услуги агентства: визы, ВНЖ, страховки, банковские карты, туры и сопровождение."],
      ["Как оплатить баллами?", "Скажите вашему менеджеру при оформлении следующей услуги — он спишет баллы и уменьшит сумму к оплате (до " + share + "% стоимости)."],
      ["Сколько баллов я получу?", ex + "% от суммы оплаченной услуги" + (rate > 0 ? "" : " (на ближайшем статусе)") + ". Например, с услуги за 40 000 ₽ вернётся " + RU(40000 * (ex / 100)) + " баллов."],
      ["Можно ли передать баллы другому?", "Баллы привязаны к вашему номеру телефона и не передаются. Но вы можете пригласить близких по своей ссылке — баллы получите и вы, и они."]
    ];
    var s = el('<div class="vl-sec"><div class="vl-h">Частые вопросы</div><div class="vl-faq"></div></div>');
    var box = s.querySelector(".vl-faq");
    qa.forEach(function (x) {
      box.appendChild(el("<details><summary>" + esc(x[0]) + '</summary><div class="an">' + esc(x[1]) + "</div></details>"));
    });
    return s;
  }

  /* ══ монтирование ══

     askPhone: true  — бета-режим: если номер не передан, виджет сам спросит его
                       ненавязчивой формой и запомнит в localStorage.
     askPhone: false — режим ЛК: номер приходит из сессии, форму не показываем
                       (при вшивании в кабинет передаём {phone: PHONE, askPhone: false}).  */
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
      root.innerHTML = "";
      root.appendChild(vCard(card));
      root.appendChild(vTiles(card));
      root.appendChild(vSpend(card, phone, api, function () { load(phone); }));
      if (!opts.compact) root.appendChild(vSteps(card));
      var l = vLadder(card); if (l) root.appendChild(l);
      var r = vRef(ref, refBase); if (r) root.appendChild(r);
      root.appendChild(vHist(card));
      if (!opts.compact) root.appendChild(vFaq(card));
      if (askPhone) {
        // Деликатная подпись «чей это баланс» + возможность сменить номер.
        var who = el('<div class="vl-who">Баллы для <b>' + esc(phone) + '</b> · <button class="vl-lnk" type="button">сменить номер</button></div>');
        who.querySelector("button").addEventListener("click", function () { lsSet(""); phone = ""; gate(); });
        root.appendChild(who);
      }
    }

    function gate() {
      root.innerHTML = "";
      var g = el('<div class="vl-gate"><div class="gh">Ваша бонусная карта</div>'
        + '<div class="gd">Баллы привязаны к номеру телефона — укажите его, чтобы увидеть баланс и статус.</div>'
        + '<div class="gf"><input type="tel" placeholder="+7 999 123-45-67" data-f="ph">'
        + '<button class="vl-btn" type="button" style="flex:0 0 auto">Показать баллы</button></div></div>');
      var inp = g.querySelector('[data-f="ph"]');
      function go() { var v = inp.value.trim(); if (!v) { inp.focus(); return; } lsSet(v); phone = v; load(v); }
      g.querySelector("button").addEventListener("click", go);
      inp.addEventListener("keydown", function (e) { if (e.key === "Enter") go(); });
      root.appendChild(g);
      inp.focus();
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

  w.VoyoLoyalty = { mount: mount, version: 2 };
})(window, document);
