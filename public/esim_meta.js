/* Пиксель Meta (Facebook/Instagram) для витрины eSIM — 13.10.2026.
   Работает только на voyomobile.com: туда ведёт реклама в Meta. На voyotravel.ru,
   voyomobile.ru и внутри ЛК (embed=1) пиксель не грузится — там свои счётчики.
   Три этапа воронки, на которых учится кампания:
     ViewContent      — открыл карточку пакета (выбрал пакет);
     InitiateCheckout — нажал «Купить», открылось окно оформления;
     AddPaymentInfo   — ввёл почту и ушёл на оплату;
     Purchase         — оплатил (с суммой в рублях).
   Имя файла начинается с esim_, чтобы его пропускал фильтр сайта eSIM в server.js. */
(function(){
  "use strict";
  var PIXEL = "1329364073594329";
  var on = /(^|\.)voyomobile\.com$/.test(location.hostname) &&
           new URLSearchParams(location.search).get("embed") !== "1";
  window.voyoMeta = function(){};
  if(!on) return;

  !function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){n.callMethod?
  n.callMethod.apply(n,arguments):n.queue.push(arguments)};if(!f._fbq)f._fbq=n;
  n.push=n;n.loaded=!0;n.version='2.0';n.queue=[];t=b.createElement(e);t.async=!0;
  t.src=v;s=b.getElementsByTagName(e)[0];s.parentNode.insertBefore(t,s)}(window,
  document,'script','https://connect.facebook.net/en_US/fbevents.js');
  fbq("init", PIXEL);
  fbq("track", "PageView");

  var MAP = { esim_pack_open: "ViewContent", esim_checkout_open: "InitiateCheckout",
              esim_pay_click: "AddPaymentInfo", purchase: "Purchase" };
  var sent = {};
  window.voyoMeta = function(name, p){
    var ev = MAP[name];
    if(!ev) return;
    p = p || {};
    var data = { currency: "RUB" };
    var v = Number(p.value != null ? p.value : p.price);
    if(v > 0) data.value = v;
    if(p.country) data.content_category = p.country;
    if(p.id || (p.items && p.items[0])) data.content_ids = [String(p.id || p.items[0].item_id)];
    var opt = {};
    if(ev === "Purchase"){
      if(!p.id || sent[p.id]) return;           // одна покупка — одно событие
      sent[p.id] = 1;
      opt.eventID = "esim-" + p.id;
    }
    try{ fbq("track", ev, data, opt); }catch(e){}
  };
})();
