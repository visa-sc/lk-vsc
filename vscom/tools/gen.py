# -*- coding: utf-8 -*-
import html, os, json

DESK = os.path.expanduser("~/Desktop")

CSS = """
:root{--bg:#f5f5f7;--card:#fff;--tx:#1d1d1f;--mut:#6e6e73;--acc:#0071e3;--ok:#1a7f37;--warn:#a15c00;--err:#b42318;--line:#e5e5ea}
*{box-sizing:border-box}
body{margin:0;padding:28px 20px 80px;background:var(--bg);color:var(--tx);
 font:15px/1.55 -apple-system,BlinkMacSystemFont,"SF Pro Text","Helvetica Neue",Arial,sans-serif}
.wrap{max-width:900px;margin:0 auto}
h1{font-size:26px;letter-spacing:-.02em;margin:0 0 6px}
.sub{color:var(--mut);margin:0 0 22px;font-size:14px}
.card{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:18px 20px;margin:0 0 16px}
.card h2{font-size:17px;margin:0 0 4px;letter-spacing:-.01em}
.card .hint{color:var(--mut);font-size:13px;margin:0 0 12px}
.badge{display:inline-block;font-size:12px;padding:2px 9px;border-radius:99px;margin-left:8px;vertical-align:2px}
.b-must{background:#e7f4ea;color:var(--ok)}
.b-opt{background:#fff4e0;color:var(--warn)}
.b-no{background:#fde8e6;color:var(--err)}
pre{background:#fafafa;border:1px solid var(--line);border-radius:10px;padding:12px 14px;margin:0 0 12px;
 white-space:pre-wrap;word-break:break-word;font:13px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace;max-height:340px;overflow:auto}
button.copy{appearance:none;border:0;background:var(--acc);color:#fff;font-size:14px;font-weight:590;
 padding:9px 16px;border-radius:99px;cursor:pointer}
button.copy:active{opacity:.8}
button.copy.done{background:var(--ok)}
.cnt{color:var(--mut);font-size:13px;margin-left:10px}
.danger{border-color:#f3c4c0;background:#fff7f6}
.danger h2{color:var(--err)}
.chk{background:#e7f4ea;border:1px solid #bfe3c8;border-radius:12px;padding:12px 14px;color:#12622b;font-size:13px;margin:0 0 16px}
.chk.bad{background:#fde8e6;border-color:#f3c4c0;color:var(--err)}
table{width:100%;border-collapse:collapse;font-size:13px}
td,th{border-bottom:1px solid var(--line);padding:7px 8px;text-align:left;vertical-align:top}
th{color:var(--mut);font-weight:500}
td.n{text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums}
.ok{color:var(--ok)} .bad{color:var(--err)}
.note{font-size:13px;color:var(--mut);margin:10px 0 0}
ol.lines{list-style:none;margin:0 0 12px;padding:0;counter-reset:l}
ol.lines li{display:flex;align-items:center;gap:10px;padding:7px 0;border-bottom:1px solid var(--line)}
ol.lines li:last-child{border-bottom:0}
ol.lines .num{counter-increment:l;flex:none;width:22px;color:var(--mut);font-size:12.5px;
 text-align:right;font-variant-numeric:tabular-nums}
ol.lines .num:before{content:counter(l)}
ol.lines code{flex:1;font:14px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace;word-break:break-word}
ol.lines .len{flex:none;color:var(--mut);font-size:12px;font-variant-numeric:tabular-nums;
 min-width:30px;text-align:right}
ol.lines .len.over{color:var(--err);font-weight:600}
button.copy.sm{padding:6px 13px;font-size:12.5px;font-weight:500;flex:none}
.allrow{display:flex;align-items:center;gap:10px;margin-top:4px}
@media (max-width:640px){
 ol.lines li{flex-wrap:wrap}
 ol.lines code{flex:1 1 100%;order:2}
 ol.lines .len{order:1}
 button.copy.sm{order:3;margin-left:auto}
}
"""

JS = """
function legacyCopy(t){var a=document.createElement('textarea');a.value=t;a.style.position='fixed';a.style.opacity='0';
 document.body.appendChild(a);a.select();try{document.execCommand('copy')}catch(e){}document.body.removeChild(a);}
document.addEventListener('click',function(e){
 var b=e.target.closest('button.copy'); if(!b) return;
 var t; if(b.dataset.line!==undefined){t=b.closest('li').querySelector('code').innerText;}
 else {var el=document.getElementById(b.dataset.for); t=el.innerText||el.textContent;}
 var done=function(){var o=b.textContent;b.textContent='Скопировано';b.classList.add('done');
   setTimeout(function(){b.textContent=o;b.classList.remove('done')},1400)};
 if(navigator.clipboard&&window.isSecureContext){navigator.clipboard.writeText(t).then(done,function(){legacyCopy(t);done()})}
 else{legacyCopy(t);done()}
});
"""

def page(title, sub, blocks, checkline=None, checkbad=False, extra_html=""):
    parts = ['<!doctype html><meta charset="utf-8"><title>%s</title><style>%s</style>' % (html.escape(title), CSS)]
    parts.append('<div class="wrap"><h1>%s</h1><p class="sub">%s</p>' % (html.escape(title), sub))
    if checkline:
        parts.append('<div class="chk%s">%s</div>' % (" bad" if checkbad else "", checkline))
    parts.append(extra_html)
    for i, b in enumerate(blocks):
        pid = "p%d" % i
        badge = ""
        if b.get("badge"):
            cls, txt = b["badge"]
            badge = '<span class="badge %s">%s</span>' % (cls, html.escape(txt))
        cls = " danger" if b.get("danger") else ""
        cnt = b.get("count")
        cnth = '<span class="cnt">%s</span>' % html.escape(cnt) if cnt else ""
        body = b.get("html")
        if body is None:
            body = '<pre id="%s">%s</pre>' % (pid, html.escape(b["text"]))
            btn = '<button class="copy" data-for="%s">Скопировать</button>%s' % (pid, cnth)
        else:
            btn = ""
        parts.append('<div class="card%s"><h2>%s%s</h2><p class="hint">%s</p>%s%s</div>'
                     % (cls, html.escape(b["title"]), badge, b.get("hint",""), body, btn))
    parts.append('</div><script>%s</script>' % JS)
    return "\n".join(parts)

def lines_block(items, limit=None, pid="all"):
    """Список строк: у каждой свой счётчик знаков и своя кнопка копирования.
    Вставлять в Google Ads всё равно приходится по одному полю за раз."""
    rows = []
    for it in items:
        n = len(it)
        cls = " over" if (limit and n > limit) else ""
        rows.append('<li><span class="num"></span><code>%s</code>'
                    '<span class="len%s">%d</span>'
                    '<button class="copy sm" data-line>Копировать</button></li>'
                    % (html.escape(it), cls, n))
    hidden = ('<pre id="%s" style="display:none">%s</pre>'
              % (pid, html.escape("\n".join(items))))
    return ('<ol class="lines">%s</ol>%s'
            '<div class="allrow"><button class="copy" data-for="%s">Скопировать все</button>'
            '<span class="cnt">%d шт.%s</span></div>'
            % ("".join(rows), hidden, pid, len(items),
               (" · лимит %d знаков" % limit) if limit else ""))


def write(name, content, subdir=None):
    base = os.path.join(DESK, subdir) if subdir else DESK
    os.makedirs(base, exist_ok=True)
    p = os.path.join(base, name)
    with open(p, "w", encoding="utf-8") as f:
        f.write(content)
    print("OK", p, len(content))
