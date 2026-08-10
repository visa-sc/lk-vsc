/* ══════════════════════════════════════════════════════════════════════════
   VOYO — БОНУСНАЯ ПРОГРАММА: портативный клиентский виджет.

   Один файл, ноль зависимостей, свои стили (все классы с префиксом .vl-,
   инжектятся один раз) — чтобы вшить в клиентский ЛК одной строкой:

       <script src="/loyalty-card.js"></script>
       <div id="bonus"></div>
       <script>VoyoLoyalty.mount(document.getElementById("bonus"), {phone: PHONE, askPhone: false});</script>

   Оформление — как в ЛК (lk-skin): воздух, крупные скругления, мягкие двойные
   тени, спокойная типографика, акцент #3589BD. Экран намеренно КОРОТКИЙ —
   всего три блока: карта → приглашение друзей → кнопка «Показать историю».
   Вся «теория» (статусы, ставки, курс балла, как потратить) живёт ТОЛЬКО в
   поповере «i» у названия статуса — поповер рисуется порталом в body.

   На карте: баланс, статус со ставкой и шкала достижения по всей лестнице
   (потрачено → верхний статус, с засечками ступеней). Карта живая: следит за
   курсором/пальцем (наклон + блик + голограмма), приминается при нажатии;
   всё уважает prefers-reduced-motion.

   Данные — /beta/api/loyalty?phone= (или /cabinet/api/loyalty в session-режиме).

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
  // Пропорции настоящей пластиковой карты (85,6 × 54 мм) на любой ширине — и в
  // узкой шторке ЛК тоже. Всё, что в эти пропорции не влезает (прогресс, история),
  // живёт отдельными блоками ПОД картой.
  + 'aspect-ratio:1.586/1;min-height:168px;max-height:250px;display:flex;flex-direction:column;justify-content:space-between;'
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
  /* Широкий экран: прогресс переезжает ВНУТРЬ карты (её высоты хватает), поэтому
     карта чуть вытянутее — иначе в середине зияла бы пустота. Тёмные варианты
     тех же элементов шкалы. На мобиле всё наоборот: карта чистая, прогресс ниже. */
  + '@media(min-width:640px){.vl-card{aspect-ratio:1.75/1;max-height:340px;}}'
  + '.vl-card .vl-prog-in{margin-top:18px;}'
  + '.vl-card .vl-scale{color:rgba(255,255,255,.7);}'
  + '.vl-card .vl-scale b{color:#fff;}'
  + '.vl-card .vl-bar{background:rgba(0,0,0,.18);}'
  + '.vl-card .vl-bar i{background:rgba(255,255,255,.94);box-shadow:0 0 14px rgba(255,255,255,.45);}'
  + '.vl-card .vl-tick{background:rgba(255,255,255,.24);}'
  + '.vl-card .vl-tick.on{background:rgba(255,255,255,.6);}'
  + '.vl-card .vl-note{color:rgba(255,255,255,.8);}'
  + '.vl-card .vl-note b{color:#fff;}'
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
  + '.vl-mid{margin-top:auto;}'
  + '.vl-bal{font-size:clamp(30px,11vw,44px);font-weight:600;letter-spacing:-.035em;line-height:1;margin:0 0 4px;'
  + 'font-variant-numeric:tabular-nums;text-shadow:0 1px 0 rgba(255,255,255,.14),0 4px 22px rgba(0,0,0,.20);}'
  + '.vl-bal small{font-size:13.5px;font-weight:400;opacity:.66;margin-left:9px;letter-spacing:0;text-shadow:none;}'
  + '.vl-foot{display:flex;justify-content:space-between;align-items:baseline;gap:12px;margin-top:18px;}'
  + '.vl-name{font-size:10.5px;opacity:.66;letter-spacing:.11em;text-transform:uppercase;font-weight:500;'
  + 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}'
  /* ── прогресс статуса: отдельная светлая панель ПОД картой ── 
     На карте ему места нет (там пропорции пластика), а внизу он читается лучше. */
  + '.vl-progress{background:var(--vl-bg);border-radius:20px;padding:16px 18px;box-shadow:var(--vl-sh);'
  + 'backdrop-filter:blur(12px) saturate(150%);-webkit-backdrop-filter:blur(12px) saturate(150%);}'
  + '.vl-scale{display:flex;justify-content:space-between;align-items:baseline;gap:10px;'
  + 'font-size:11.5px;color:var(--vl-mut);margin-bottom:9px;letter-spacing:.01em;}'
  + '.vl-scale b{font-weight:600;color:var(--vl-ink);}'
  + '.vl-bar{position:relative;height:6px;border-radius:99px;background:rgba(23,32,60,.08);}'
  + '.vl-bar i{display:block;height:100%;border-radius:99px;width:0;position:relative;z-index:2;'
  + 'background:linear-gradient(90deg,#5cb0e0,#3589BD);box-shadow:0 1px 8px rgba(53,137,189,.45);'
  + 'transition:width 1.1s cubic-bezier(.22,.61,.36,1);}'
  + '.vl-tick{position:absolute;top:0;bottom:0;width:2px;border-radius:2px;z-index:1;'
  + 'background:rgba(23,32,60,.14);transform:translateX(-1px);}'
  + '.vl-tick.on{background:rgba(255,255,255,.75);}'
  + '.vl-note{font-size:12.5px;color:var(--vl-mut);margin-top:10px;line-height:1.45;}'
  + '.vl-note b{color:var(--vl-ink);font-weight:600;}'

  /* ── кнопка «Показать историю» ── */
  + '.vl-toggle{width:100%;background:var(--vl-bg);border:0;border-radius:16px;padding:14px;font:inherit;'
  + 'font-size:13.5px;font-weight:600;color:var(--vl-accent-d);cursor:pointer;box-shadow:var(--vl-sh);'
  + 'transition:background .18s ease,transform .16s ease;'
  + 'backdrop-filter:blur(12px) saturate(150%);-webkit-backdrop-filter:blur(12px) saturate(150%);}'
  + '.vl-toggle:hover{background:#fff;}'
  + '.vl-toggle:active{transform:scale(.99);}'
  + '.vl-hist[hidden]{display:none;}'
  + '.vl-hist{margin-top:10px;}'

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

  /* ── реферал: выгода вынесена крупным числом наверх блока ── */
  + '.vl-invite{position:relative;overflow:hidden;background:linear-gradient(160deg,rgba(255,255,255,.94),rgba(238,246,252,.94));}'
  + '.vl-invite::after{content:"";position:absolute;right:-70px;top:-90px;width:200px;height:200px;border-radius:50%;'
  + 'background:radial-gradient(circle,rgba(53,137,189,.12),rgba(53,137,189,0) 70%);pointer-events:none;}'
  /* Сумма выгоды — главный акцент блока: крупнее промокода и по центру,
     подпись с «i» идёт хвостом справа от неё. */
  + '.vl-gain{display:block;margin-bottom:12px;position:relative;text-align:center;}'
  + '.vl-gain-sum{display:block;font-size:42px;font-weight:800;letter-spacing:-.035em;line-height:1.05;'
  + 'background:linear-gradient(135deg,#4aa3d8,#2b6d97);-webkit-background-clip:text;background-clip:text;'
  + '-webkit-text-fill-color:transparent;}'
  + '.vl-gain-txt{display:inline-flex;align-items:center;font-size:12.5px;color:var(--vl-mut);'
  + 'font-weight:500;margin-top:4px;}'
  + '.vl-gain .vl-i{margin-left:6px;}'
  + '@media(max-width:360px){.vl-gain-sum{font-size:36px;}}'
  + '.vl-invite .ph{font-size:14.5px;position:relative;}'
  + '.vl-invite-txt{position:relative;font-size:13px;line-height:1.55;}'
  /* Промокод — одна кликабельная плашка: тап в любое место копирует код.
     Иконка копирования в углу и подтверждение прямо в подписи (как в /calc). */
  + '.vl-code{position:relative;display:block;width:100%;margin-top:14px;cursor:pointer;text-align:center;'
  + 'font-family:inherit;padding:14px 16px 15px;border-radius:16px;'
  + 'background:linear-gradient(180deg,rgba(238,246,252,.95),rgba(226,240,250,.95));'
  + 'border:1px solid rgba(53,137,189,.28);box-shadow:0 1px 2px rgba(16,24,40,.03);'
  + 'transition:transform .16s ease,box-shadow .16s ease,background .3s ease,border-color .3s ease;}'
  + '.vl-code:hover{transform:translateY(-1px);box-shadow:0 10px 22px -14px rgba(53,137,189,.8);}'
  + '.vl-code:active{transform:translateY(0) scale(.995);}'
  + '.vl-code::after{content:"⧉";position:absolute;top:11px;right:13px;font-size:13px;'
  + 'color:var(--vl-accent);opacity:.5;transition:opacity .15s ease;}'
  + '.vl-code:hover::after{opacity:.9;}'
  + '.vl-code .lb{display:block;font-size:11.5px;color:var(--vl-mut);font-weight:500;letter-spacing:.01em;}'
  + '.vl-code .cd{display:block;font-size:26px;font-weight:700;letter-spacing:.08em;color:var(--vl-accent-d);'
  + 'font-variant-numeric:tabular-nums;margin-top:5px;line-height:1.1;}'
  + '.vl-code.done{background:linear-gradient(180deg,#e8f7ee,#dff3e6);border-color:rgba(47,138,82,.35);}'
  + '.vl-code.done .lb{color:var(--vl-green);font-weight:600;}'
  + '.vl-code.done::after{opacity:0;}'
  + '.vl-share{display:flex;gap:9px;margin-top:10px;flex-wrap:wrap;}'
  /* Подписи длинные — разрешаем перенос, чтобы на узком экране не вылезали за край */
  + '.vl-share .vl-btn{flex:1 1 44%;white-space:normal;font-size:13px;padding:11px 12px;line-height:1.3;}'
  /* Вторая кнопка на голубой подложке блока сливалась — делаем её белой с
     чёткой границей: контраст есть, а иерархия (WhatsApp главный) сохраняется. */
  + '.vl-share .vl-btn.sec{background:#fff;color:var(--vl-accent-d);'
  + 'box-shadow:0 0 0 1px rgba(23,32,60,.10),0 6px 14px -10px rgba(16,32,64,.45);}'
  + '.vl-share .vl-btn.sec:hover{background:#fff;box-shadow:0 0 0 1px rgba(53,137,189,.35),0 10px 20px -12px rgba(16,32,64,.5);}'
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
  // Широкий экран — по ширине КОНТЕЙНЕРА виджета не судим: в ЛК он живёт в шторке,
  // поэтому ориентируемся на само окно (тот же порог, что в CSS-медиазапросе).
  function isWide() { try { return w.matchMedia("(min-width: 640px)").matches; } catch (e) { return true; } }
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
  // Палитра карты по статусу — семь ступеней, каждая заметно «дороже» предыдущей:
  // графит → сталь → бронза → холодная платина → тёмный титан → чёрный → индиго.
  var SKIN = {
    base:     { c1: "#3d4b60", c2: "#4e6278", c3: "#657b91", glow: "rgba(48,64,84,.5)" },
    silver:   { c1: "#5b6c7e", c2: "#7e90a2", c3: "#a5b5c4", glow: "rgba(90,107,125,.5)" },
    gold:     { c1: "#8a6114", c2: "#b98a22", c3: "#ddb34c", glow: "rgba(150,105,25,.5)" },
    platinum: { c1: "#3f5f70", c2: "#62889c", c3: "#9dc0cf", glow: "rgba(63,95,112,.5)" },
    titanium: { c1: "#26383f", c2: "#3f5a62", c3: "#6d8f95", glow: "rgba(30,50,58,.55)" },
    black:    { c1: "#14161b", c2: "#24272f", c3: "#41464f", glow: "rgba(10,12,16,.6)" },
    infinite: { c1: "#2b2170", c2: "#4a3f8f", c3: "#7565cf", glow: "rgba(45,35,100,.6)" }
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
  // Единственное место, где живёт вся «теория» программы: статусы, ставки,
  // курс балла и правила списания. На экране этого текста нет — только «i».
  function txtTiers(card) {
    var rows = (card.tiers || []).map(function (t) {
      return '<div class="r' + (t.current ? " now" : "") + '"><span>' + esc(t.name)
        + (t.current ? " · ваш статус" : "") + '<br><i>' + (t.min > 0 ? "от " + RU(t.min) + " ₽ покупок" : "старт программы") + "</i></span>"
        + "<b>" + Math.round((t.rate || 0) * 100) + "%</b></div>";
    }).join("");
    var share = Math.round((Number(card.redeemMaxShare) || .3) * 100);
    var min = RU(card.redeemMin || 500);
    return "<b>Статусы и кэшбэк</b><br>Процент зависит от суммы оплаченных вами услуг — "
      + "чем больше, тем выше. Статус остаётся с вами навсегда.<div style='margin-top:9px'>" + rows + "</div>"
      + "<div style='margin-top:9px;opacity:.72'>Ставка берётся по статусу на момент покупки; ранее начисленные баллы не пересчитываются.</div>"
      + "<div style='margin-top:12px'><b>Как потратить баллы</b><br>1 балл = 1 ₽. Баллами можно оплатить "
      + "до <b>" + share + "%</b> стоимости любой услуги: визы, ВНЖ, страховки, банковской карты, тура. "
      + "Списываем от " + min + " баллов — скажите менеджеру при оформлении, и он уменьшит сумму к оплате."
      + "<br><br>Баллы начисляются автоматически после оплаты, обычно в течение суток, и не сгорают.</div>";
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

  function vCard(card, withProgress) {
    var bal = Number(card.balance) || 0;
    var sk = SKIN[card.tier] || SKIN.base;
    var rate = Math.round((Number(card.rate) || 0) * 100);
    var stage = el('<div class="vl-stage"></div>');
    var node = el(
      '<div class="vl-card" style="--c1:' + sk.c1 + ';--c2:' + sk.c2 + ';--c3:' + sk.c3 + ';--cglow:' + sk.glow + '">'
      + '<div class="vl-fx"><div class="vl-tex"></div><div class="vl-holo"></div><div class="vl-glare"></div>'
      + (calm() ? "" : '<div class="vl-sheen"></div>') + "</div>"
      + '<div class="vl-c-top"><div class="vl-brand">VOYO x VSC</div>'
      + '<div class="vl-tier">' + esc(card.tierName || "Базовый") + (rate ? " · " + rate + "%" : "") + "</div></div>"
      + '<div class="vl-mid"><div class="vl-bal">0<small>' + plural(bal, ["балл", "балла", "баллов"]) + "</small></div></div>"
      + '<div class="vl-foot"><div class="vl-name">' + esc(card.name || "Ваша карта") + "</div></div>"
      + (withProgress ? '<div class="vl-prog-in">' + progInner(card) + "</div>" : "") + "</div>"
    );
    node.querySelector(".vl-tier").appendChild(vInfo(txtTiers(card)));
    if (withProgress) animBar(node);
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

  /* Прогресс по лестнице статусов — отдельной панелью под картой (на самой карте
     держим пропорции пластика, поэтому всё лишнее живёт ниже). Шкала идёт по ВСЕЙ
     лестнице (0 → верхний статус) с засечками на порогах: видно весь путь. */
  // Разметка шкалы — одна на оба места (внутри карты на десктопе / панелью под
  // картой на мобиле); отличается только оформление, оно задано CSS по родителю.
  function progInner(card) {
    var tiers = card.tiers || [];
    var top = tiers.length ? (tiers[tiers.length - 1].min || 0) : 0;
    if (!top) return "";
    var spend = Number(card.spend) || 0;
    var rate = Math.round((Number(card.rate) || 0) * 100);
    var pct = Math.max(1.5, Math.min(100, spend / top * 100));
    var ticks = tiers.filter(function (t) { return t.min > 0 && t.min < top; }).map(function (t) {
      return '<span class="vl-tick' + (spend >= t.min ? " on" : "") + '" style="left:' + (t.min / top * 100).toFixed(2) + '%"></span>';
    }).join("");
    var note = card.nextTier && card.toNextSpend > 0
      ? "До статуса <b>" + esc(card.nextTier) + "</b> — ещё " + RU(card.toNextSpend) + " ₽"
        + (card.nextRate ? ", кэшбэк станет " + Math.round(card.nextRate * 100) + "%" : "")
      : "Максимальный статус — ваш кэшбэк <b>" + rate + "%</b> ✦";
    return '<div class="vl-scale"><span>Потрачено <b>' + RU(spend) + ' ₽</b></span><span>' + RU(top) + " ₽</span></div>"
      + '<div class="vl-bar"><i data-w="' + pct.toFixed(2) + '"></i>' + ticks + "</div>"
      + '<div class="vl-note">' + note + "</div>";
  }
  function animBar(root) {
    var bar = root.querySelector(".vl-bar i");
    if (bar) requestAnimationFrame(function () { bar.style.width = bar.getAttribute("data-w") + "%"; });
  }
  function vProgress(card) {
    var inner = progInner(card);
    if (!inner) return null;
    var s = el('<section><div class="vl-progress">' + inner + "</div></section>");
    animBar(s);
    return s;
  }

  /* Активная заявка на списание. Формы списания в ЛК нет (по решению Андрея
     10.08): как тратить баллы — написано в «i» у статуса, списывает менеджер при
     оформлении. Но если заявка уже создана, клиент должен видеть её статус. */
  function vPending(card, post, onChanged) {
    var rq = card.redeemRequest;
    if (!rq) return null;
    var s = d.createElement('section');
    var p = el('<div class="vl-panel vl-wait"><div class="ph">Заявка на списание принята</div>'
      + '<div class="pd">Спишем <b>' + RU(rq.points) + '</b> ' + plural(rq.points, ['балл', 'балла', 'баллов'])
      + ' при оформлении ближайшей услуги — менеджер свяжется с вами.'
      + ' <button class="vl-lnk" type="button" data-act="cancel">Отменить</button></div></div>');
    p.querySelector('[data-act="cancel"]').addEventListener('click', function () {
      post('/redeem/cancel', { id: rq.id })
        .then(function (j) { if (j && j.ok) { toast('Заявка отменена'); onChanged(); } else toast('Заявку уже обработали'); })
        .catch(function () { toast('Не удалось отменить'); });
    });
    s.appendChild(p);
    return s;
  }

  function vRef(ref, refBase) {
    if (!ref || !ref.code) return null;
    var link = refBase + encodeURIComponent(ref.code);
    var txt = "Оформляю визы и поездки через VOYO. По моей ссылке тебе " + RU(ref.rewardFriend || 2000) + " бонусов на первую услугу:";
    var msg = txt + "\n" + link;   // сначала текст, ссылка последней строкой
    var wa = "https://wa.me/?text=" + encodeURIComponent(msg);
    // Telegram при url+text всегда ставит ССЫЛКУ ПЕРВОЙ. Поэтому отдаём одним
    // параметром url всё сообщение целиком — тогда порядок остаётся наш,
    // а ссылку Telegram всё равно распознаёт и делает кликабельной.
    var tg = "https://t.me/share/url?url=" + encodeURIComponent(msg);
    var pair = (ref.rewardInviter || 2000) + (ref.rewardFriend || 2000);
    var s = el('<section><div class="vl-panel vl-invite">'
      + '<div class="vl-gain"><span class="vl-gain-sum">' + RU(pair) + " ₽</span>"
      + '<span class="vl-gain-txt">за каждого друга</span></div>'
      + '<div class="pd vl-invite-txt">Приглашайте друзей и получайте <b>' + RU(pair) + " ₽</b> баллами на двоих."
      + "<br><b>" + RU(ref.rewardInviter || 2000) + " ₽</b> — вам и <b>" + RU(ref.rewardFriend || 2000)
      + " ₽</b> — другу!<br>Вознаграждение поступит на ваш счёт сразу после оплаты."
      + "<br>Приглашайте неограниченное количество друзей.</div>"
      + '<button type="button" class="vl-code" data-act="copy" title="Нажмите, чтобы скопировать промокод">'
      + '<span class="lb">Ваш промокод</span><span class="cd">' + esc(ref.code) + "</span></button>"
      + '<div class="vl-share">'
      + '<a class="vl-btn" href="' + esc(wa) + '" target="_blank" rel="noopener">Отправить в WhatsApp</a>'
      + '<a class="vl-btn sec" href="' + esc(tg) + '" target="_blank" rel="noopener">Отправить в Telegram</a></div>'
      + (ref.invitedCount ? '<div class="vl-rstat">Приглашено <b>' + RU(ref.invitedCount) + "</b> · оформились <b>"
          + RU(ref.qualifiedCount || 0) + "</b> · получено <b>" + RU(ref.earnedPoints || 0) + "</b> баллов</div>" : "")
      + "</div></section>");
    s.querySelector(".vl-gain").appendChild(vInfo(txtRef(ref)));   // «i» — у суммы выгоды
    // Клик по всей области промокода копирует САМ КОД (им делятся голосом и в чатах),
    // а плашка на секунду подтверждает действие — как зелёные блоки в калькуляторе.
    var codeBox = s.querySelector('[data-act="copy"]');
    codeBox.addEventListener("click", function () {
      function flash() {
        codeBox.classList.add("done");
        var lb = codeBox.querySelector(".lb"), was = lb.textContent;
        lb.textContent = "✓ Промокод скопирован";
        setTimeout(function () { codeBox.classList.remove("done"); lb.textContent = was; }, 1400);
      }
      // Clipboard API может отказать (нет жеста/прав) — тогда молча уходим на
      // execCommand, но подтверждение показываем в любом случае.
      function legacy() {
        try {
          var i = d.createElement("textarea"); i.value = ref.code;
          i.style.cssText = "position:fixed;opacity:0;top:0;left:0";
          d.body.appendChild(i); i.select(); d.execCommand("copy"); i.remove();
        } catch (_) {}
        flash();
      }
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(ref.code).then(flash, legacy);
        else legacy();
      } catch (e) { legacy(); }
    });
    return s;
  }

  // История скрыта за кнопкой: экран остаётся коротким, но всё под рукой.
  function vHist(card) {
    var list = (card.history || []).slice();
    var s = el('<section><button class="vl-toggle" type="button">Показать историю</button>'
      + '<div class="vl-hist" hidden></div></section>');
    var box = s.querySelector(".vl-hist"), btn = s.querySelector(".vl-toggle");
    if (!list.length) {
      // Пустую историю тоже показываем: клиент должен понимать, что раздел есть.
      btn.addEventListener("click", function () {
        var open = !box.hasAttribute("hidden");
        if (open) { box.setAttribute("hidden", ""); btn.textContent = "Показать историю"; }
        else {
          box.removeAttribute("hidden"); btn.textContent = "Скрыть историю";
          box.innerHTML = '<div class="vl-empty">Пока пусто. Здесь появятся все начисления и списания баллов.</div>';
        }
      });
      return s;
    }
    btn.addEventListener("click", function () {
      var open = !box.hasAttribute("hidden");
      if (open) { box.setAttribute("hidden", ""); btn.textContent = "Показать историю"; }
      else { box.removeAttribute("hidden"); btn.textContent = "Скрыть историю"; draw(); }
    });
    var shown = 5;
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
        var b = el('<button class="vl-more" type="button">Ещё ' + RU(list.length - shown) + "</button>");
        b.addEventListener("click", function () { shown = list.length; draw(); });
        box.appendChild(b);
      }
    }
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
    // По умолчанию ведём друга на ГЛАВНУЮ (вход/регистрация в ЛК) — там промокод
    // подхватится автоматически. /app?ref= остаётся для пилотного суперприложения.
    var refBase = opts.refBase || (w.location.origin + "/?ref=");
    // session: true — телефон берётся сервером из подписанной cookie-сессии.
    // Тогда ?phone= не добавляем и в теле POST его не шлём (режим клиентского ЛК).
    var session = !!opts.session;
    var askPhone = !session && opts.askPhone !== false;
    var root = el('<div class="vl-root"></div>');
    var phone = session ? "-" : (opts.phone || (askPhone ? lsGet() : ""));
    var last = null, lastWide = null, rsT = 0;
    target.innerHTML = ""; target.appendChild(root);
    // Перерисовываем только когда экран реально перешёл границу мобильный/десктоп.
    w.addEventListener("resize", function () {
      if (!last) return;
      clearTimeout(rsT);
      rsT = setTimeout(function () { if (last && isWide() !== lastWide) render(last.card, last.ref); }, 180);
    });

    // Единая точка исходящих POST: в сессионном режиме телефон не передаём —
    // сервер берёт его из cookie voyo_sess (клиентский ЛК, Фаза 2 авторизации).
    function post(path, body) {
      if (!session) body = Object.assign({ phone: phone }, body);
      return fetch(api + path, {
        method: "POST", credentials: "same-origin",
        headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
      }).then(function (r) { return r.json(); });
    }

    function render(card, ref) {
      popCloseAll(); root.innerHTML = "";
      last = { card: card, ref: ref };
      // Широкий экран — вся информация на карте (высоты хватает). Узкий — карта
      // остаётся «пластиком», а прогресс уходит панелью под неё.
      var wide = isWide(); lastWide = wide;
      root.appendChild(vCard(card, wide));
      if (!wide) { var pg = vProgress(card); if (pg) root.appendChild(pg); }
      var pend = vPending(card, post, function () { load(phone); });
      if (pend) root.appendChild(pend);
      if (!opts.compact) {
        var r = vRef(ref, refBase); if (r) root.appendChild(r);
        var h = vHist(card); if (h) root.appendChild(h);
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
      return fetch(session ? api : (api + "?phone=" + encodeURIComponent(phone)), { credentials: "same-origin" })
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
