# РАЗВЕДКА camoufox (Python, основная реализация) против Cloudflare на VFS.
# Запуск: /root/vfs-bot/venv/bin/python recon_camoufox.py [URL]
import os, re, sys
from camoufox.sync_api import Camoufox

def parse_proxy(s):
    if not s:
        return None
    s = s.strip()
    m = re.match(r'^(https?)://(?:([^:@]+):([^@]+)@)?([^:/]+):(\d+)', s)
    if m:
        return {"server": f"{m.group(1)}://{m.group(4)}:{m.group(5)}",
                "username": m.group(2), "password": m.group(3)}
    p = s.split(":")
    if len(p) == 4:
        return {"server": f"http://{p[0]}:{p[1]}", "username": p[2], "password": p[3]}
    return None

URL = sys.argv[1] if len(sys.argv) > 1 else "https://visa.vfsglobal.com/rus/en/fra/login"
proxy = parse_proxy(os.environ.get("PROXY_URL"))
print("URL:", URL, "| proxy:", proxy["server"] if proxy else "NONE", "| движок: camoufox(Firefox)")

kwargs = dict(headless="virtual", humanize=True, os="windows")
if proxy:
    kwargs["proxy"] = proxy
    kwargs["geoip"] = True

try:
    with Camoufox(**kwargs) as browser:
        page = browser.new_page()
        resp = page.goto(URL, wait_until="domcontentloaded", timeout=60000)
        print("goto HTTP status:", resp.status if resp else None)

        cleared = False
        for t in range(45):
            page.wait_for_timeout(1000)
            st = page.evaluate("""() => {
                const title = document.title || "";
                const body = (document.body && document.body.innerText) || "";
                const challenge = /момент|just a moment|проверка безопасности|checking/i.test(title) || /проверк безопас|security check/i.test(body);
                const hasForm = !!document.querySelector("input[type='password'],input[type='email'],input[name*='mail' i]");
                return {title, challenge, hasForm};
            }""")
            if st["hasForm"] or not st["challenge"]:
                cleared = True
                print(f"✓ cleared after {t+1}s | title: {st['title']} | form: {st['hasForm']}")
                break
            if t in (8, 20, 35):
                print(f"  …still on challenge at {t+1}s | title: {st['title']}")

        info = page.evaluate("""() => ({
            title: document.title, url: location.href,
            emailField: !!document.querySelector("input[type='email'],input[name*='mail' i],#email,#mat-input-0"),
            passwordField: !!document.querySelector("input[type='password']"),
            bodyText: ((document.body && document.body.innerText)||"").replace(/\\s+/g," ").slice(0,500),
        })""")
        print("FINAL cleared:", cleared)
        print("title:", info["title"], "| url:", info["url"])
        print("emailField:", info["emailField"], "| passwordField:", info["passwordField"])
        print("bodyText:", info["bodyText"])
        try:
            page.screenshot(path="/root/vfs-bot/recon_camoufox.png")
            print("screenshot → recon_camoufox.png")
        except Exception as e:
            print("screenshot err", e)
except Exception as e:
    print("RECON_CAMOUFOX ERROR:", repr(e))
