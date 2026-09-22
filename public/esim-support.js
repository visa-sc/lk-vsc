/* Поддержка VOYO mobile: всплывающая форма обращения и чат.
   Подключается одной строкой на всех страницах eSIM:
   <script src="/esim-support.js" defer></script>
   Кнопки на странице зовут window.voyoSupport.form() и window.voyoSupport.chat().
   Чат опрашивает сервер раз в 5 секунд, ответ оператора приходит из письма. */
(function () {
  "use strict";
  if (window.voyoSupport) return;

  var CSS = '' +
'.vsup-ovl{position:fixed;inset:0;background:rgba(16,24,40,.45);backdrop-filter:blur(3px);display:none;' +
  'align-items:center;justify-content:center;padding:16px;z-index:99999;}' +
'.vsup-ovl.on{display:flex;}' +
'.vsup-box{background:#fff;width:100%;max-width:520px;max-height:min(86vh,720px);display:flex;flex-direction:column;' +
  'overflow:auto;border-radius:22px;padding:20px;' +
  'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif;color:#16202e;' +
  '-webkit-overflow-scrolling:touch;}' +
'.vsup-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin-bottom:6px;}' +
'.vsup-head h3{margin:0;font-size:19px;letter-spacing:-.02em;}' +
'.vsup-x{border:0;background:#f1f5f9;color:#6e7c91;width:32px;height:32px;border-radius:50%;font-size:18px;cursor:pointer;flex:none;}' +
'.vsup-sub{color:#6e7c91;font-size:13.5px;line-height:1.45;margin:0 0 14px;}' +
'.vsup-box label{display:block;font-size:13px;font-weight:600;margin:14px 0 6px;}' +
'.vsup-box input,.vsup-box textarea{width:100%;box-sizing:border-box;font:inherit;font-size:16px;color:#16202e;' +
  'background:#f7fafd;border:1px solid #e6ebf2;border-radius:13px;padding:11px 13px;outline:none;}' +
'.vsup-box textarea{min-height:86px;resize:vertical;}' +
'.vsup-box input:focus,.vsup-box textarea:focus{border-color:#aed3ea;background:#fff;}' +
'.vsup-pills{display:flex;gap:8px;flex-wrap:wrap;}' +
'.vsup-pill{font:inherit;font-size:14px;border:1px solid #e6ebf2;background:#fff;color:#16202e;border-radius:12px;' +
  'padding:9px 15px;cursor:pointer;}' +
'.vsup-pill.on{background:linear-gradient(135deg,#4aa3d4,#2c6f96);color:#fff;border-color:transparent;}' +
'.vsup-file{font:inherit;font-size:13.5px;border:1px dashed #b9d5e8;background:#f7fafd;color:#2c6f96;border-radius:12px;' +
  'padding:10px 14px;cursor:pointer;}' +
'.vsup-send{width:100%;margin-top:18px;border:0;border-radius:14px;background:linear-gradient(135deg,#4aa3d4,#2c6f96);' +
  'color:#fff;font:inherit;font-size:16px;font-weight:700;padding:14px;cursor:pointer;}' +
'.vsup-send:disabled{opacity:.6;cursor:default;}' +
'.vsup-note{font-size:12.5px;color:#6e7c91;margin-top:8px;line-height:1.4;}' +
'.vsup-err{color:#b4322c;font-size:13.5px;margin-top:10px;display:none;}' +
'.vsup-err.on{display:block;}' +
'.vsup-ok{text-align:center;padding:8px 0;}' +
'.vsup-ok b{display:block;font-size:18px;margin-bottom:6px;}' +
'.vsup-ok p{color:#6e7c91;font-size:14.5px;line-height:1.5;margin:0;}' +
'.vsup-log{display:flex;flex-direction:column;gap:8px;margin:6px 0 12px;flex:1 1 auto;min-height:120px;overflow:auto;padding-right:2px;}' +
'.vsup-row{flex:none;}' +
'.vsup-m{max-width:86%;padding:10px 13px;border-radius:15px;font-size:14.5px;line-height:1.45;white-space:pre-wrap;word-break:break-word;}' +
'.vsup-m.me{align-self:flex-end;background:linear-gradient(135deg,#4aa3d4,#2c6f96);color:#fff;border-bottom-right-radius:5px;}' +
'.vsup-m.they{align-self:flex-start;background:#f1f5f9;color:#16202e;border-bottom-left-radius:5px;}' +
'.vsup-m .who{display:block;font-size:11.5px;opacity:.75;margin-bottom:3px;}' +
'.vsup-row{display:flex;gap:8px;align-items:flex-end;}' +
'.vsup-row textarea{min-height:44px;max-height:120px;}' +
'.vsup-row button{flex:none;border:0;border-radius:13px;background:linear-gradient(135deg,#4aa3d4,#2c6f96);color:#fff;' +
  'font:inherit;font-weight:700;padding:12px 16px;cursor:pointer;}';

  function el(html) { var t = document.createElement("template"); t.innerHTML = html.trim(); return t.content.firstChild; }
  function style() {
    if (document.getElementById("vsup-css")) return;
    var s = document.createElement("style"); s.id = "vsup-css"; s.textContent = CSS; document.head.appendChild(s);
  }
  var ovl = null;
  function open(inner) {
    style();
    if (!ovl) {
      ovl = el('<div class="vsup-ovl"><div class="vsup-box"></div></div>');
      ovl.addEventListener("click", function (e) { if (e.target === ovl) close(); });
      document.body.appendChild(ovl);
    }
    ovl.querySelector(".vsup-box").innerHTML = inner;
    ovl.classList.add("on");
    document.body.style.overflow = "hidden";
    return ovl.querySelector(".vsup-box");
  }
  function close() {
    if (!ovl) return;
    ovl.classList.remove("on");
    document.body.style.overflow = "";
    stopPoll();
  }

  /* ── обращение: та же форма, что на /esim/help ── */
  function formHtml() {
    return '' +
'<div class="vsup-head"><h3>Оставить обращение</h3><button class="vsup-x" type="button">×</button></div>' +
'<p class="vsup-sub">Расскажите, что не получилось — разберёмся и ответим вам.</p>' +
'<div id="vsupForm">' +
  '<label>Как с вами связаться</label>' +
  '<input type="text" id="vsupContact" placeholder="Телефон, почта или ник в телеграме" />' +
  '<label>Модель телефона</label>' +
  '<input type="text" id="vsupModel" placeholder="Например: iPhone 13, Samsung S23" />' +
  '<label>Пробовали подключить eSIM?</label>' +
  '<div class="vsup-pills" id="vsupTried">' +
    '<button type="button" class="vsup-pill" data-v="yes">Да, пробовал</button>' +
    '<button type="button" class="vsup-pill" data-v="no">Ещё нет</button></div>' +
  '<label>Что происходит и какая ошибка</label>' +
  '<textarea id="vsupErr" placeholder="Например: сканирую QR-код, пишет «Не удалось добавить сотовый тариф»"></textarea>' +
  '<label>Скриншот ошибки</label>' +
  '<button type="button" class="vsup-file" id="vsupPick">Прикрепить скриншот</button> ' +
  '<span class="vsup-note" id="vsupFname" style="display:inline">файл не выбран</span>' +
  '<input type="file" id="vsupShot" accept="image/*" hidden />' +
  '<button type="button" class="vsup-send" id="vsupSend">Отправить</button>' +
  '<div class="vsup-err" id="vsupMsg"></div>' +
  '<div class="vsup-note">Инструкция по установке eSIM — на странице <a href="/esim/help" target="_blank" rel="noopener">помощи</a>.</div>' +
'</div>';
  }
  function showForm() {
    var box = open(formHtml());
    box.querySelector(".vsup-x").addEventListener("click", close);
    var tried = "", shot = null;
    box.querySelector("#vsupTried").addEventListener("click", function (e) {
      var b = e.target.closest(".vsup-pill"); if (!b) return;
      tried = b.dataset.v;
      [].forEach.call(this.querySelectorAll(".vsup-pill"), function (x) { x.classList.toggle("on", x === b); });
    });
    var file = box.querySelector("#vsupShot");
    box.querySelector("#vsupPick").addEventListener("click", function () { file.click(); });
    file.addEventListener("change", function () {
      var f = file.files && file.files[0]; if (!f) return;
      if (f.size > 5 * 1024 * 1024) { box.querySelector("#vsupFname").textContent = "файл больше 5 МБ"; return; }
      var r = new FileReader();
      r.onload = function () { shot = String(r.result); box.querySelector("#vsupFname").textContent = f.name; };
      r.readAsDataURL(f);
    });
    box.querySelector("#vsupSend").addEventListener("click", async function () {
      var msg = box.querySelector("#vsupMsg");
      var contact = box.querySelector("#vsupContact").value.trim();
      var err = box.querySelector("#vsupErr").value.trim();
      if (contact.length < 5) { msg.textContent = "Напишите, как с вами связаться."; msg.classList.add("on"); return; }
      if (!err && !shot) { msg.textContent = "Опишите, что происходит, или приложите скриншот."; msg.classList.add("on"); return; }
      this.disabled = true; this.textContent = "Отправляем…";
      try {
        var r = await fetch("/esim/api/help", { method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ c: "widget", contact: contact, model: box.querySelector("#vsupModel").value.trim(),
            tried: tried, error: err, shot: shot, ua: navigator.userAgent }) });
        var j = await r.json();
        if (!j || !j.success) throw new Error("fail");
        box.innerHTML = '<div class="vsup-head"><h3>Спасибо, получили</h3><button class="vsup-x" type="button">×</button></div>' +
          '<div class="vsup-ok"><p>Мы разберёмся и ответим тем способом, который вы указали.</p></div>';
        box.querySelector(".vsup-x").addEventListener("click", close);
      } catch (e) {
        msg.textContent = "Не отправилось. Попробуйте ещё раз или напишите в чат."; msg.classList.add("on");
        this.disabled = false; this.textContent = "Отправить";
      }
    });
  }

  /* ── чат ── */
  var CID_KEY = "voyo_chat_id";
  var poll = null, lastCount = 0;
  function cid() { try { return localStorage.getItem(CID_KEY) || ""; } catch (e) { return ""; } }
  function setCid(v) { try { localStorage.setItem(CID_KEY, v); } catch (e) {} }
  function stopPoll() { if (poll) { clearInterval(poll); poll = null; } }

  function render(box, messages) {
    var log = box.querySelector("#vsupLog");
    if (!log) return;
    if (messages.length === lastCount) return;
    lastCount = messages.length;
    log.innerHTML = messages.map(function (m) {
      var mine = m.from === "client";
      var who = mine ? "" : '<span class="who">' + (m.from === "operator" ? "Оператор" : "VOYO mobile") + "</span>";
      var text = String(m.text).replace(/[&<>]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]; });
      return '<div class="vsup-m ' + (mine ? "me" : "they") + '">' + who + text + "</div>";
    }).join("");
    log.scrollTop = log.scrollHeight;
  }

  function showChat() {
    var box = open('' +
'<div class="vsup-head"><h3>Чат с поддержкой</h3><button class="vsup-x" type="button">×</button></div>' +
'<p class="vsup-sub">Напишите, что случилось. Оператор ответит здесь же — страницу можно закрыть и вернуться позже.</p>' +
'<div class="vsup-log" id="vsupLog"></div>' +
'<div class="vsup-row"><textarea id="vsupText" placeholder="Ваше сообщение"></textarea>' +
'<button type="button" id="vsupSendChat">Отправить</button></div>' +
'<div class="vsup-err" id="vsupChatErr"></div>');
    box.querySelector(".vsup-x").addEventListener("click", close);
    lastCount = -1;

    async function refresh() {
      var id = cid(); if (!id) return;
      try {
        var r = await fetch("/esim/api/chat/poll?cid=" + encodeURIComponent(id));
        var j = await r.json();
        if (j && j.success) render(box, j.messages || []);
      } catch (e) {}
    }
    refresh();
    stopPoll();
    poll = setInterval(refresh, 5000);

    async function send() {
      var ta = box.querySelector("#vsupText");
      var text = ta.value.trim();
      if (!text) return;
      var btn = box.querySelector("#vsupSendChat");
      btn.disabled = true; ta.value = "";
      try {
        var r = await fetch("/esim/api/chat/send", { method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ cid: cid(), text: text, page: location.pathname + location.search }) });
        var j = await r.json();
        if (j && j.success) { setCid(j.cid); lastCount = -1; render(box, j.messages || []); }
      } catch (e) {
        box.querySelector("#vsupChatErr").textContent = "Не отправилось, попробуйте ещё раз.";
        box.querySelector("#vsupChatErr").classList.add("on");
      }
      btn.disabled = false;
      ta.focus();
    }
    box.querySelector("#vsupSendChat").addEventListener("click", send);
    box.querySelector("#vsupText").addEventListener("keydown", function (e) {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); send(); }
    });
    setTimeout(function () { box.querySelector("#vsupText").focus(); }, 150);
  }

  window.voyoSupport = { form: showForm, chat: showChat, close: close };

  // Кнопки на странице: data-vsup="form" | "chat"
  document.addEventListener("click", function (e) {
    var b = e.target.closest("[data-vsup]");
    if (!b) return;
    e.preventDefault();
    if (b.getAttribute("data-vsup") === "chat") showChat(); else showForm();
  });
})();
