/* ══════════════════════════════════════════════════════════════════════════
   VOYO — БОНУСНАЯ ПРОГРАММА: портативный клиентский виджет.

   Один файл, ноль зависимостей, свои стили (все классы с префиксом .vl-,
   инжектятся один раз) — чтобы вшить в клиентский ЛК одной строкой:

       <script src="/loyalty-card.js"></script>
       <div id="bonus"></div>
       <script>VoyoLoyalty.mount(document.getElementById("bonus"), {phone: PHONE, askPhone: false});</script>

   Оформление — как в ЛК (lk-skin): воздух, крупные скругления, мягкие двойные
   тени, спокойная типографика, акцент #3589BD. Экран намеренно КОРОТКИЙ:
   карта → строка фактов → оплата баллами → приглашение → история. Все
   объяснения спрятаны под иконки «i» (поповер порталом в body, как в админке).

   Карта живая: следит за курсором/пальцем (наклон + блик), «дышит» бликом при
   появлении, приминается при нажатии. Всё уважает prefers-reduced-motion.

   Данные — из открытого API /beta/api/loyalty?phone=, списание — /redeem.

   opts:
     phone     — телефон клиента (в ЛК приходит из сессии)
     askPhone  — true (по умолчанию): если номера нет, виджет спросит его сам
                 и запомнит в localStorage. В ЛК передаём false — формы не будет.
     api       — базовый путь API (по умолчанию "/beta/api/loyalty")
     refBase   — реферальная ссылка (по умолчанию origin + "/app?ref=")
     compact   — true: только карта, факты и списание
   Возвращает контроллер: { reload(phone), el, phone }.
   ══════════════════════════════════════════════════════════════════════════ */
(function (w, d) {
  "use strict";
  if (w.VoyoLoyalty) return;

  var CSS = ''
  + '.vl-root{--vl-accent:#3589BD;--vl-accent-d:#2b6d97;--vl-ink:#141926;--vl-mut:#7b8494;'
  + '--vl-hair:rgba(23,32,60,.07);--vl-bg:rgba(255,255,255,.86);--vl-soft:#f3f6fa;'
  + '--vl-green:#2f8a52;--vl-red:#b0263a;'
  + '--vl-sh:0 1px 2px rgba(16,24,40,.03),0 18px 40px -26px rgba(16,32,64,.28);color:var(--vl-ink);'
  + 'font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text","Segoe UI",Roboto,Helvetica,Arial,sans-serif;'
  + '-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility;line-height:1.5;}'
  + '.vl-root *{box-sizing:border-box;}'
  + '.vl-root section{margin-top:26px;}'
  + '.vl-cap{font-size:11px;text-transform:uppercase;letter-spacing:.09em;color:var(--vl-mut);'
  + 'font-weight:600;margin:0 0 10px 4px;display:flex;align-items:center;}'
  + '@keyframes vlup{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:none}}'
  + '.vl-root>*{animation:vlup .55s cubic-bezier(.22,.61,.36,1) both;}'
  + '.vl-root>*:nth-child(2){animation-delay:.06s}.vl-root>*:nth-child(3){animation-delay:.12s}'
  + '.vl-root>*:nth-child(4){animation-delay:.18s}.vl-root>*:nth-child(5){animation-delay:.24s}'
  + '.vl-root>*:nth-child(6){animation-delay:.3s}'

  /* ── карта: премиальный «металл» — фактура, голограмма, чип, параллакс ── */
  + '.vl-stage{perspective:1200px;}'
  + '.vl-card{position:relative;overflow:hidden;border-radius:26px;padding:24px 26px 24px;color:#fff;isolation:isolate;'
  + 'min-height:216px;display:flex;flex-direction:column;'   /* высоту задаёт содержимое — иначе overflow:hidden срежет текст */
  + 'background:linear-gradient(145deg,var(--c1) 0%,var(--c2) 52%,var(--c3) 100%);'
  + 'box-shadow:0 26px 54px -22px var(--cglow),0 2px 8px rgba(16,24,40,.12),'
  + 'inset 0 1px 0 rgba(255,255,255,.30),inset 0 0 0 1px rgba(255,255,255,.12),inset 0 -1px 0 rgba(0,0,0,.16);'
  // БЕЗ transform-style:preserve-3d — он отключает обрезку по overflow, и при наклоне
  // из-под скруглений вылезали «уголки» блика/голограммы. Глубина сделана параллаксом
  // слоёв (2D-сдвиг), поэтому 3D-контекст детям не нужен.
  // Трансформацию НЕ анимируем через CSS: её каждый кадр плавно доводит JS
  // (интерполяция с затуханием). Иначе движение дёргается и текст «съезжает».
  + 'will-change:transform;cursor:default;backface-visibility:hidden;'
  + 'transition:box-shadow .5s ease;}'
  /* тень отъезжает в сторону, противоположную наклону — карта будто приподнята */
  + '.vl-card.live{box-shadow:calc(var(--px,0px) * -1.8) calc(40px - var(--py,0px) * 1.4) 72px -24px var(--cglow),'
  + '0 3px 12px rgba(16,24,40,.14),inset 0 1px 0 rgba(255,255,255,.42),'
  + 'inset 0 0 0 1px rgba(255,255,255,.18),inset 0 -1px 0 rgba(0,0,0,.18);}'
  + '.vl-card>*{position:relative;z-index:3;}'
  /* мягкие световые пятна */
  + '.vl-card::after{content:"";position:absolute;right:-90px;top:-130px;width:300px;height:300px;border-radius:50%;'
  + 'background:radial-gradient(circle at 35% 35%,rgba(255,255,255,.20),rgba(255,255,255,0) 62%);z-index:0;}'
  + '.vl-card::before{content:"";position:absolute;left:-70px;bottom:-150px;width:260px;height:260px;border-radius:50%;'
  + 'background:radial-gradient(circle at 50% 50%,rgba(255,255,255,.09),rgba(255,255,255,0) 65%);z-index:0;}'
  /* Все световые слои живут в отдельном контейнере со своим скруглением и обрезкой —
     так блик и голограмма гарантированно не вылезают «уголками» при наклоне. */
  + '.vl-fx{position:absolute;inset:0;z-index:1;pointer-events:none;border-radius:inherit;overflow:hidden;'
  + '-webkit-mask-image:-webkit-radial-gradient(#fff,#000);}'   /* Safari: заставляет реально обрезать по радиусу */
  /* фактура: тонкие «гильошные» линии + едва заметное зерно */
  + '.vl-tex{position:absolute;inset:0;pointer-events:none;opacity:.42;'
  + 'background:repeating-linear-gradient(115deg,rgba(255,255,255,.055) 0 1px,rgba(255,255,255,0) 1px 7px),'
  + 'repeating-linear-gradient(65deg,rgba(0,0,0,.05) 0 1px,rgba(0,0,0,0) 1px 9px);}'
  /* голограмма: перелив, который смещается вместе с наклоном */
  + '.vl-holo{position:absolute;inset:-25%;pointer-events:none;opacity:0;mix-blend-mode:soft-light;'
  + 'transition:opacity .5s ease;transform:translate3d(calc(var(--px,0px) * 5),calc(var(--py,0px) * 5),0);'
  // Перелив намеренно бледный и малонасыщенный: на soft-light насыщенные стопы
  // перекрашивали золото в розовое. Нужен намёк на голограмму, а не радуга.
  + 'background:conic-gradient(from 210deg at var(--gx,50%) var(--gy,40%),'
  + 'rgba(255,205,230,.55) 0deg,rgba(190,200,255,.5) 70deg,rgba(190,240,220,.45) 140deg,'
  + 'rgba(255,240,200,.5) 210deg,rgba(230,205,255,.5) 280deg,rgba(255,205,230,.55) 360deg);}'
  + '.vl-card.live .vl-holo{opacity:.2;}'
  /* блик, который бежит за курсором */
  + '.vl-glare{position:absolute;inset:0;pointer-events:none;opacity:0;transition:opacity .45s ease;'
  + 'background:radial-gradient(400px circle at var(--gx,50%) var(--gy,0%),rgba(255,255,255,.34),rgba(255,255,255,0) 55%);}'
  + '.vl-card.live .vl-glare{opacity:1;}'
  /* один проход «блеска» при появлении карты */
  + '.vl-sheen{position:absolute;inset:-40%;pointer-events:none;'
  + 'background:linear-gradient(72deg,rgba(255,255,255,0) 42%,rgba(255,255,255,.30) 50%,rgba(255,255,255,0) 58%);'
  + 'transform:translateX(-90%);animation:vlsheen 1.6s .5s cubic-bezier(.4,0,.2,1) 1 both;}'
  + '@keyframes vlsheen{to{transform:translateX(90%)}}'
  /* слои карты двигаются с разной скоростью — эффект глубины */
  // Параллакс намеренно ЕДВА заметный и без CSS-переходов (значения уже сглажены
  // в JS): крупный сдвиг читался не как глубина, а как «съезжающие» буквы.
  + '.vl-card .vl-c-top{transform:translate3d(calc(var(--px,0px) * -.14),calc(var(--py,0px) * -.14),0);}'
  + '.vl-card .vl-mid{transform:translate3d(calc(var(--px,0px) * -.3),calc(var(--py,0px) * -.3),0);}'
  + '.vl-card .vl-foot{transform:translate3d(calc(var(--px,0px) * -.2),calc(var(--py,0px) * -.2),0);}'
  + '.vl-card .vl-prog{transform:translate3d(calc(var(--px,0px) * -.2),calc(var(--py,0px) * -.2),0);}'
  + '.vl-c-top{display:flex;justify-content:space-between;align-items:center;gap:10px;}'
  + '.vl-brand{font-weight:500;font-size:10.5px;letter-spacing:.2em;opacity:.76;'
  + 'text-shadow:0 1px 0 rgba(255,255,255,.12),0 1px 6px rgba(0,0,0,.16);}'
  + '.vl-tier{display:inline-flex;align-items:center;gap:2px;font-size:10.5px;font-weight:600;letter-spacing:.05em;'
  + 'text-transform:uppercase;padding:6px 13px;border-radius:999px;background:rgba(255,255,255,.16);'
  + 'border:1px solid rgba(255,255,255,.24);box-shadow:0 1px 0 rgba(255,255,255,.2) inset;'
  + 'backdrop-filter:saturate(170%) blur(10px);-webkit-backdrop-filter:saturate(170%) blur(10px);white-space:nowrap;}'
  + '.vl-mid{margin-top:auto;padding-top:22px;}'
  + '.vl-bal{font-size:44px;font-weight:600;letter-spacing:-.035em;line-height:1;margin:0 0 6px;'
  + 'font-variant-numeric:tabular-nums;text-shadow:0 1px 0 rgba(255,255,255,.14),0 4px 22px rgba(0,0,0,.20);}'
  + '.vl-bal small{font-size:13.5px;font-weight:400;opacity:.66;margin-left:9px;letter-spacing:0;text-shadow:none;}'
  + '.vl-eq{font-size:12.5px;opacity:.74;font-weight:400;letter-spacing:.005em;}'
  + '.vl-foot{display:flex;justify-content:space-between;align-items:baseline;gap:12px;margin-top:18px;}'
  + '.vl-name{font-size:10.5px;opacity:.66;letter-spacing:.11em;text-transform:uppercase;font-weight:500;'
  + 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}'
  + '.vl-num{font-size:10.5px;opacity:.5;letter-spacing:.09em;font-variant-numeric:tabular-nums;white-space:nowrap;}'
  + '.vl-prog{margin-top:14px;}'
  + '.vl-prog .vl-bar{height:5px;border-radius:99px;background:rgba(0,0,0,.15);overflow:hidden;}'
  + '.vl-prog .vl-bar i{display:block;height:100%;border-radius:99px;width:0;background:rgba(255,255,255,.92);'
  + 'box-shadow:0 0 14px rgba(255,255,255,.5);transition:width 1.1s cubic-bezier(.22,.61,.36,1);}'
  + '.vl-prog .vl-note{font-size:12px;opacity:.82;margin-top:10px;}'

  /* ── строка фактов: одна лёгкая панель, разделители-волоски ── */
  + '.vl-facts{display:grid;grid-template-columns:repeat(3,1fr);background:var(--vl-bg);border-radius:20px;'
  + 'box-shadow:var(--vl-sh);backdrop-filter:blur(12px) saturate(150%);-webkit-backdrop-filter:blur(12px) saturate(150%);}'
  + '.vl-fact{padding:16px 14px;text-align:center;position:relative;}'
  + '.vl-fact+.vl-fact::before{content:"";position:absolute;left:0;top:22%;bottom:22%;width:1px;background:var(--vl-hair);}'
  + '.vl-fact .k{display:flex;align-items:center;justify-content:center;font-size:10.5px;text-transform:uppercase;'
  + 'letter-spacing:.07em;color:var(--vl-mut);font-weight:600;margin-bottom:5px;}'
  + '.vl-fact .v{font-size:20px;font-weight:700;letter-spacing:-.025em;line-height:1.15;white-space:nowrap;}'
  + '.vl-fact .v span{font-size:12.5px;font-weight:500;color:var(--vl-mut);letter-spacing:0;}'
  + '@media(max-width:420px){.vl-fact .v{font-size:17px}.vl-fact{padding:15px 6px}}'
  + '@media(max-width:340px){.vl-fact .v{font-size:15px}}'

  /* ── лёгкие панели ── */
  + '.vl-panel{background:var(--vl-bg);border-radius:20px;padding:18px 20px;box-shadow:var(--vl-sh);'
  + 'backdrop-filter:blur(12px) saturate(150%);-webkit-backdrop-filter:blur(12px) saturate(150%);}'
  + '.vl-panel .ph{display:flex;align-items:center;font-size:15px;font-weight:600;letter-spacing:-.015em;}'
  + '.vl-panel .pd{font-size:13px;color:var(--vl-mut);margin-top:4px;}'
  + '.vl-form{display:flex;gap:9px;margin-top:14px;align-items:center;}'
  + '.vl-form input{flex:1;min-width:100px;border:0;border-radius:13px;padding:12px 14px;font:inherit;font-size:15px;'
  + 'font-weight:600;background:var(--vl-soft);color:var(--vl-ink);box-shadow:inset 0 0 0 1px var(--vl-hair);}'
  + '.vl-form input:focus{outline:none;background:#fff;box-shadow:inset 0 0 0 1px var(--vl-accent),0 0 0 4px rgba(53,137,189,.13);}'
  + '.vl-err{color:var(--vl-red);font-size:12.5px;margin-top:9px;}'
  + '.vl-wait{background:linear-gradient(150deg,rgba(255,250,240,.92),rgba(253,244,224,.92));'
  + 'box-shadow:var(--vl-sh),inset 0 0 0 1px rgba(201,151,43,.20);}'
  + '.vl-wait .pd{color:#6f5d31;}'

  + '.vl-btn{cursor:pointer;border:0;border-radius:13px;padding:12px 18px;font:inherit;font-size:13.5px;'
  + 'font-weight:600;text-decoration:none;display:inline-block;text-align:center;white-space:nowrap;'
  + 'background:linear-gradient(140deg,#4aa3d8,#3589BD);color:#fff;box-shadow:0 12px 22px -13px rgba(53,137,189,.95);'
  + 'transition:transform .16s ease,filter .16s ease,box-shadow .16s ease;}'
  + '.vl-btn:hover{filter:brightness(1.05);transform:translateY(-1px);box-shadow:0 16px 26px -14px rgba(53,137,189,.95);}'
  + '.vl-btn:active{transform:translateY(0) scale(.985);}'
  + '.vl-btn:disabled{opacity:.55;cursor:default;transform:none;}'
  + '.vl-btn.sec{background:rgba(53,137,189,.08);color:var(--vl-accent-d);box-shadow:none;}'
  + '.vl-btn.sec:hover{background:rgba(53,137,189,.13);filter:none;}'

  /* ── реферал ── */
  + '.vl-code{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-top:14px;'
  + 'background:var(--vl-soft);border-radius:15px;padding:13px 16px;}'
  + '.vl-code .lb{font-size:9.5px;text-transform:uppercase;letter-spacing:.08em;color:var(--vl-mut);font-weight:600;}'
  + '.vl-code .cd{font-size:19px;font-weight:600;letter-spacing:.04em;color:var(--vl-accent-d);'
  + 'font-variant-numeric:tabular-nums;margin-top:3px;}'
  + '.vl-share{display:flex;gap:9px;margin-top:10px;}'
  + '.vl-share .vl-btn{flex:1;}'
  + '.vl-rstat{font-size:12px;color:var(--vl-mut);margin-top:12px;text-align:center;}'
  + '.vl-rstat b{color:var(--vl-ink);font-weight:600;}'

  /* ── история: список без рамок ── */
  + '.vl-hist{background:var(--vl-bg);border-radius:20px;padding:4px 20px;box-shadow:var(--vl-sh);'
  + 'backdrop-filter:blur(12px) saturate(150%);-webkit-backdrop-filter:blur(12px) saturate(150%);}'
  + '.vl-op{display:flex;gap:14px;align-items:center;padding:14px 0;border-bottom:1px solid var(--vl-hair);}'
  + '.vl-op:last-child{border-bottom:0;}'
  + '.vl-op .oi{flex:none;width:34px;height:34px;border-radius:12px;display:flex;align-items:center;justify-content:center;'
  + 'background:rgba(53,137,189,.09);color:var(--vl-accent-d);}'
  + '.vl-op .oi svg{width:16px;height:16px;display:block;}'
  + '.vl-op .ol{flex:1;min-width:0;}'
  + '.vl-op .ol .t{font-size:14px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}'
  + '.vl-op .ol .s{font-size:11.5px;color:var(--vl-mut);margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}'
  + '.vl-op .op{font-size:15px;font-weight:600;white-space:nowrap;font-variant-numeric:tabular-nums;}'
  + '.vl-op .op.plus{color:var(--vl-green);}.vl-op .op.minus{color:var(--vl-red);}'
  + '.vl-more{width:100%;margin:2px 0 12px;background:none;border:0;color:var(--vl-accent-d);font:inherit;'
  + 'font-size:13px;font-weight:500;cursor:pointer;padding:10px;border-radius:12px;}'
  + '.vl-more:hover{background:rgba(53,137,189,.07);}'
  + '.vl-empty{padding:20px 0;text-align:center;color:var(--vl-mut);font-size:13px;}'

  /* ── «i» + поповер (портал в body) ── */
  + '.vl-i{display:inline-flex;align-items:center;justify-content:center;width:15px;height:15px;border-radius:50%;'
  + 'border:1.2px solid currentColor;color:#adb5c2;font-size:9.5px;font-weight:700;font-style:italic;'
  + 'font-family:Georgia,"Times New Roman",serif;line-height:1;cursor:pointer;vertical-align:middle;margin-left:7px;'
  + '-webkit-user-select:none;user-select:none;flex:0 0 auto;transition:color .18s ease,transform .18s ease;}'
  + '.vl-i:hover,.vl-i.open{color:var(--vl-accent);transform:scale(1.12);}'
  + '.vl-card .vl-i{color:rgba(255,255,255,.6);margin-left:8px;}'
  + '.vl-card .vl-i:hover,.vl-card .vl-i.open{color:#fff;}'
  + '.vl-pop{display:none;position:fixed;z-index:99998;box-sizing:border-box;width:min(330px,80vw);'
  + 'max-height:60vh;overflow:auto;-webkit-overflow-scrolling:touch;background:rgba(22,27,38,.97);color:#e9edf5;'
  + 'font:400 12.5px/1.65 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif;font-style:normal;'
  + 'letter-spacing:0;text-align:left;text-transform:none;padding:14px 16px;border-radius:16px;'
  + 'box-shadow:0 24px 50px rgba(16,24,40,.40);white-space:normal;cursor:default;'
  + 'backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px);}'
  + '.vl-pop.show{display:block;animation:vlup .22s ease both;}'
  + '.vl-pop b{color:#fff;font-weight:600;}'
  + '.vl-pop .r{display:flex;justify-content:space-between;gap:12px;padding:7px 0;border-bottom:1px solid rgba(255,255,255,.09);}'
  + '.vl-pop .r:last-child{border-bottom:0;}'
  + '.vl-pop .r.now{color:#8fd0f5;}'
  + '.vl-pop .r i{font-style:normal;opacity:.68;font-size:11.5px;}'
  + '.vl-pop::before{content:"";position:absolute;bottom:100%;left:var(--arrow-left,50%);transform:translateX(-50%);'
  + 'border:6px solid transparent;border-bottom-color:rgba(22,27,38,.97);}'
  + '.vl-pop.up::before{bottom:auto;top:100%;border-bottom-color:transparent;border-top-color:rgba(22,27,38,.97);}'

  /* ── ввод номера (только бета) ── */
  + '.vl-gate{background:var(--vl-bg);border-radius:24px;padding:30px 24px;box-shadow:var(--vl-sh);text-align:center;'
  + 'backdrop-filter:blur(12px) saturate(150%);-webkit-backdrop-filter:blur(12px) saturate(150%);}'
  + '.vl-gate .gh{font-size:17px;font-weight:600;letter-spacing:-.02em;margin-bottom:6px;}'
  + '.vl-gate .gd{font-size:13.5px;color:var(--vl-mut);line-height:1.55;margin-bottom:18px;}'
  + '.vl-gate .gf{display:flex;gap:9px;flex-wrap:wrap;}'
  + '.vl-gate input{flex:1;min-width:150px;border:0;border-radius:13px;padding:13px;font:inherit;font-size:15px;'
  + 'background:var(--vl-soft);color:var(--vl-ink);text-align:center;box-shadow:inset 0 0 0 1px var(--vl-hair);}'
  + '.vl-gate input:focus{outline:none;background:#fff;box-shadow:inset 0 0 0 1px var(--vl-accent),0 0 0 4px rgba(53,137,189,.13);}'
  + '.vl-who{text-align:center;font-size:11.5px;color:var(--vl-mut);margin-top:24px;}'
  + '.vl-lnk{background:none;border:0;padding:0;font:inherit;font-size:inherit;color:var(--vl-accent-d);'
  + 'cursor:pointer;text-decoration:underline;text-underline-offset:2px;}'

  /* ── состояния ── */
  + '.vl-state{background:var(--vl-bg);border-radius:22px;padding:30px 22px;text-align:center;color:var(--vl-mut);'
  + 'font-size:13.5px;box-shadow:var(--vl-sh);}'
  + '.vl-skel{border-radius:26px;height:226px;background:linear-gradient(100deg,#e9eef5 30%,#f7fafd 50%,#e9eef5 70%);'
  + 'background-size:220% 100%;animation:vlsk 1.3s linear infinite;}'
  + '@keyframes vlsk{0%{background-position:120% 0}100%{background-position:-40% 0}}'
  + '.vl-toast{position:fixed;left:50%;bottom:30px;transform:translateX(-50%) translateY(10px);'
  + 'background:rgba(20,25,38,.94);color:#fff;font-size:13px;padding:13px 22px;border-radius:14px;z-index:99999;'
  + 'opacity:0;transition:all .28s ease;pointer-events:none;box-shadow:0 18px 40px rgba(16,24,40,.35);'
  + 'backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);}'
  + '.vl-toast.on{opacity:1;transform:translateX(-50%) translateY(0);}'
  + '@media(prefers-reduced-motion:reduce){.vl-root>*,.vl-sheen,.vl-pop.show{animation:none!important}'
  + '.vl-card{transition:none!important}}';

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
  function calm() { try { return w.matchMedia("(prefers-reduced-motion: reduce)").matches; } catch (e) { return false; } }
  function toast(msg) {
    var t = el('<div class="vl-toast">' + esc(msg) + "</div>"); d.body.appendChild(t);
    requestAnimationFrame(function () { t.classList.add("on"); });
    setTimeout(function () { t.classList.remove("on"); setTimeout(function () { t.remove(); }, 320); }, 2000);
  }
  var ICO = {
    pay: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="5" width="20" height="14" rx="3"/><path d="M2 10h20"/></svg>',
    gift: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="9" width="18" height="12" rx="2"/><path d="M12 9v12M3 13h18"/><path d="M12 9S10.5 4 8 4a2.5 2.5 0 0 0 0 5zM12 9s1.5-5 4-5a2.5 2.5 0 0 1 0 5z"/></svg>',
    plane: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12.5l19-8-8 19-2.5-8.5z"/></svg>'
  };
  // Палитра карты по статусу: графит → сталь → тёплая бронза → глубокий фиолет.
  var SKIN = {
    base:     { c1: "#3d4b60", c2: "#4e6278", c3: "#657b91", glow: "rgba(48,64,84,.5)" },
    silver:   { c1: "#5b6c7e", c2: "#7e90a2", c3: "#a5b5c4", glow: "rgba(90,107,125,.5)" },
    gold:     { c1: "#8a6114", c2: "#b98a22", c3: "#ddb34c", glow: "rgba(150,105,25,.5)" },
    platinum: { c1: "#332a63", c2: "#4a3f8f", c3: "#7565cf", glow: "rgba(58,48,110,.55)" }
  };

  /* ── «i»: поповер порталом в body (предки с transform ломают fixed) ── */
  function popClose(w2) {
    if (!w2) return; w2.classList.remove("open");
    var p = w2.__pop; if (!p) return;
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
      // Карту возвращаем в покой: иначе поповер «уедет» вместе с наклоном.
      var card = wd.closest ? wd.closest(".vl-card") : null;
      if (card && card.__rest) card.__rest();
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
      + "чем больше, тем выше. Статус остаётся с вами навсегда.<div style='margin-top:9px'>" + rows + "</div>"
      + "<div style='margin-top:9px;opacity:.72'>Ставка берётся по статусу на момент покупки; ранее начисленные баллы не пересчитываются.</div>";
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

  /* ── «живая» карта ──────────────────────────────────────────────────────
     Ни одно значение не применяется к DOM напрямую из события: цель ставит
     указатель, а каждый кадр текущее состояние ДОГОНЯЕТ цель с затуханием
     (критически задемпфированная интерполяция). Отсюда мягкий разгон, плавный
     возврат и отсутствие рывков — из-за них буквы и казались «съезжающими».  */
  function attachTilt(node) {
    if (calm()) return;
    var MAX = 8, SHIFT = 5;                 // градусы наклона и максимальный сдвиг слоёв
    var tgt = { rx: 0, ry: 0, gx: 50, gy: 0, s: 1, lift: 0 };
    var cur = { rx: 0, ry: 0, gx: 50, gy: 0, s: 1, lift: 0 };
    var raf = 0, live = false;

    function frame() {
      var k = live ? .12 : .085;            // возврат чуть медленнее — читается как инерция
      var moving = false;
      for (var p in tgt) {
        var dl = tgt[p] - cur[p];
        if (Math.abs(dl) > 0.0015) { cur[p] += dl * k; moving = true; } else cur[p] = tgt[p];
      }
      node.style.transform = "translate3d(0,-" + cur.lift.toFixed(2) + "px,0) scale(" + cur.s.toFixed(4) + ")"
        + " rotateX(" + cur.rx.toFixed(3) + "deg) rotateY(" + cur.ry.toFixed(3) + "deg)";
      node.style.setProperty("--px", (cur.ry / MAX * SHIFT).toFixed(2) + "px");
      node.style.setProperty("--py", (-cur.rx / MAX * SHIFT).toFixed(2) + "px");
      node.style.setProperty("--gx", cur.gx.toFixed(2) + "%");
      node.style.setProperty("--gy", cur.gy.toFixed(2) + "%");
      raf = (moving || live) ? requestAnimationFrame(frame) : 0;
    }
    function run() { if (!raf) raf = requestAnimationFrame(frame); }

    function aim(e) {
      var r = node.getBoundingClientRect();
      var px = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
      var py = Math.max(0, Math.min(1, (e.clientY - r.top) / r.height));
      tgt.ry = (px - .5) * 2 * MAX; tgt.rx = (.5 - py) * 2 * MAX;
      tgt.gx = px * 100; tgt.gy = py * 100;
      tgt.lift = 6; tgt.s = 1.012;          // лёгкий подъём и «вдох» — карта тянется к пальцу
      if (!live) { live = true; node.classList.add("live"); }
      run();
    }
    function rest() {
      live = false;
      node.classList.remove("live");
      tgt.rx = tgt.ry = 0; tgt.gx = 50; tgt.gy = 0; tgt.s = 1; tgt.lift = 0;
      run();
    }
    node.__rest = rest;
    node.addEventListener("pointermove", aim);
    node.addEventListener("pointerleave", rest);
    node.addEventListener("pointercancel", rest);
    node.addEventListener("pointerdown", function (e) { aim(e); tgt.s = .988; tgt.lift = 2; run(); });
    node.addEventListener("pointerup", function (e) { aim(e); });
    // Палец: карта идёт за касанием, отпустили — мягко возвращается.
    node.addEventListener("touchmove", function (e) { if (e.touches && e.touches[0]) aim(e.touches[0]); }, { passive: true });
    node.addEventListener("touchend", rest);
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
           + '<div class="vl-note">До статуса ' + esc(card.nextTier) + " — ещё " + RU(card.toNextSpend) + " ₽"
           + (card.nextRate ? ", кэшбэк станет " + Math.round(card.nextRate * 100) + "%" : "") + "</div></div>";
    } else if (!card.nextTier) {
      prog = '<div class="vl-prog"><div class="vl-note">Максимальный статус — ваш кэшбэк ' + rate + "% ✦</div></div>";
    }
    var pk = String((card.phones || [])[0] || "");
    var last4 = pk.length >= 4 ? pk.slice(-4) : "";
    var stage = el('<div class="vl-stage"></div>');
    var node = el(
      '<div class="vl-card" style="--c1:' + sk.c1 + ';--c2:' + sk.c2 + ';--c3:' + sk.c3 + ';--cglow:' + sk.glow + '">'
      + '<div class="vl-fx"><div class="vl-tex"></div><div class="vl-holo"></div><div class="vl-glare"></div>'
      + (calm() ? "" : '<div class="vl-sheen"></div>') + "</div>"
      + '<div class="vl-c-top"><div class="vl-brand">VOYO · БОНУСЫ</div>'
      + '<div class="vl-tier">' + esc(card.tierName || "Базовый") + (rate ? " · " + rate + "%" : "") + "</div></div>"
      + '<div class="vl-mid"><div class="vl-bal">0<small>' + plural(bal, ["балл", "балла", "баллов"]) + "</small></div>"
      + '<div class="vl-eq">Это ' + RU(bal) + " ₽ скидки на следующую услугу</div></div>"
      + '<div class="vl-foot"><div class="vl-name">' + esc(card.name || "Ваша карта") + "</div>"
      + (last4 ? '<div class="vl-num">•••• ' + esc(last4) + "</div>" : "") + "</div>"
      + prog + "</div>"
    );
    node.querySelector(".vl-tier").appendChild(vInfo(txtTiers(card)));
    var bar = node.querySelector(".vl-bar i");
    if (bar) requestAnimationFrame(function () { bar.style.width = bar.getAttribute("data-w") + "%"; });
    // Баланс «набегает» — ощущение, что карта оживает.
    var balEl = node.querySelector(".vl-bal"), small = balEl.querySelector("small").outerHTML;
    if (calm()) balEl.innerHTML = RU(bal) + small;
    else requestAnimationFrame(function (t0) {
      (function step(t) {
        var k = Math.min(1, (t - t0) / 900), e = 1 - Math.pow(1 - k, 3);
        balEl.innerHTML = RU(bal * e) + small;
        if (k < 1) requestAnimationFrame(step);
      })(t0);
    });
    attachTilt(node);
    stage.appendChild(node);
    return stage;
  }

  function vFacts(card) {
    var rate = Math.round((Number(card.rate) || 0) * 100);
    var share = Math.round((Number(card.redeemMaxShare) || .3) * 100);
    var s = el('<section class="vl-facts">'
      + '<div class="vl-fact"><div class="k">Кэшбэк</div><div class="v">' + (rate > 0 ? rate + "%" : "<span>с Silver</span>") + "</div></div>"
      + '<div class="vl-fact"><div class="k">Баллами</div><div class="v">до ' + share + "%</div></div>"
      + '<div class="vl-fact"><div class="k">Бюджет</div><div class="v">' + RU(card.spend || 0) + " <span>₽</span></div></div></section>");
    var k = s.querySelectorAll(".vl-fact .k");
    k[0].appendChild(vInfo(txtEarn(card)));
    k[1].appendChild(vInfo(txtSpend(card)));
    k[2].appendChild(vInfo("<b>Ваш бюджет в агентстве</b><br>Сумма оплаченных вами услуг с 26.06.2026 — по ней считается статус и процент кэшбэка."));
    return s;
  }

  /* Списание: заявка клиента → подтверждение менеджера → баллы уходят из баланса. */
  function vSpend(card, phone, api, onChanged) {
    var bal = Number(card.balance) || 0, min = Number(card.redeemMin) || 500;
    var s = d.createElement("section");

    if (card.redeemRequest) {
      var rq = card.redeemRequest;
      var p = el('<div class="vl-panel vl-wait"><div class="ph">Заявка принята</div>'
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
      var box0 = el('<div class="vl-panel"><div class="ph">Оплата баллами</div>'
        + '<div class="pd">Списывать можно от ' + RU(min) + " баллов — у вас " + RU(bal) + ".</div></div>");
      box0.querySelector(".ph").appendChild(vInfo(txtSpend(card)));
      s.appendChild(box0); return s;
    }

    var box = el('<div class="vl-panel"><div class="ph">Оплатить баллами</div>'
      + '<div class="pd">Сколько баллов списать со следующей услуги?</div>'
      + '<div class="vl-form"><input type="number" inputmode="numeric" min="' + min + '" max="' + bal + '" value="' + bal + '" data-f="pts">'
      + '<button class="vl-btn" type="button" data-act="send">Списать</button></div>'
      + '<div class="vl-err" data-f="err" style="display:none"></div></div>');
    box.querySelector(".ph").appendChild(vInfo(txtSpend(card)));
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
          btn.disabled = false; btn.textContent = "Списать";
          err.textContent = j && j.reason === "not_enough" ? "Баллов не хватает — обновите страницу." : "Не удалось отправить заявку.";
          err.style.display = "block";
        })
        .catch(function () {
          btn.disabled = false; btn.textContent = "Списать";
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
    var s = el('<section><div class="vl-panel">'
      + '<div class="ph">Приглашайте друзей</div>'
      + '<div class="pd">По ' + RU(ref.rewardInviter || 2000) + " баллов вам и другу за первую услугу.</div>"
      + '<div class="vl-code"><div><div class="lb">Ваш код</div><div class="cd">' + esc(ref.code) + "</div></div>"
      + '<button class="vl-btn sec" data-act="copy">Скопировать</button></div>'
      + '<div class="vl-share">'
      + '<a class="vl-btn" href="' + esc(wa) + '" target="_blank" rel="noopener">WhatsApp</a>'
      + '<a class="vl-btn sec" href="' + esc(tg) + '" target="_blank" rel="noopener">Telegram</a></div>'
      + (ref.invitedCount ? '<div class="vl-rstat">Приглашено <b>' + RU(ref.invitedCount) + "</b> · оформились <b>"
          + RU(ref.qualifiedCount || 0) + "</b> · получено <b>" + RU(ref.earnedPoints || 0) + "</b> баллов</div>" : "")
      + "</div></section>");
    s.querySelector(".ph").appendChild(vInfo(txtRef(ref)));
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
    var s = el('<section><div class="vl-cap">История</div><div class="vl-hist"></div></section>');
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
      root.appendChild(vFacts(card));
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
        + '<button class="vl-btn" type="button">Показать</button></div></div>');
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

  w.VoyoLoyalty = { mount: mount, version: 4 };
})(window, document);
