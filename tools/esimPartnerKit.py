# Вложения для письма агентству (tools/esimPartnerMail.js): QR-код PNG и табличка на стойку A5 (PDF+PNG). Нужны PIL и qrcode, шрифт SF (мак).
#   python mk_kit.py partners.json outdir
import json, sys, os
import qrcode
from PIL import Image, ImageDraw, ImageFont

SF = "/System/Library/Fonts/SFNS.ttf"
def F(size, w=400):
    f = ImageFont.truetype(SF, size)
    try: f.set_variation_by_axes([100, min(96, max(17, size / 4)), 400, w])
    except Exception: pass
    return f
INK = (22, 32, 46); MUT = (110, 124, 145); ACC = (44, 111, 150); A1 = (74, 163, 212)
LOGO = Image.open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "public", "voyo-mobile-logo.png")).convert("RGBA")

def qr_img(link, px):
    q = qrcode.QRCode(error_correction=qrcode.constants.ERROR_CORRECT_M, border=1, box_size=10)
    q.add_data(link); q.make(fit=True)
    im = q.make_image(fill_color=INK, back_color="white").convert("RGB")
    return im.resize((px, px), Image.NEAREST)

def grad(w, h):
    g = Image.new("RGB", (w, h)); p = g.load()
    for y in range(h):
        for x in range(w):
            t = (x + y) / (w + h)
            p[x, y] = tuple(round(A1[i] + (ACC[i] - A1[i]) * t) for i in range(3))
    return g

def centered(d, y, text, font, fill, W):
    w = d.textlength(text, font=font); d.text(((W - w) / 2, y), text, font=font, fill=fill)

def stand(p, out):
    W, H = 1748, 2480            # A5 при 300 dpi
    im = Image.new("RGB", (W, H), "white"); d = ImageDraw.Draw(im)
    # шапка-градиент
    top = 980
    g = grad(W, top); im.paste(g, (0, 0))
    lg = LOGO.copy(); lw = 620; lg = lg.resize((lw, round(LOGO.height * lw / LOGO.width)), Image.LANCZOS)
    # логотип на белой плашке, чтобы читался как на сайте
    pad = 40; plate = Image.new("RGBA", (lg.width + pad * 2, lg.height + pad * 2), (255, 255, 255, 255))
    m = Image.new("L", plate.size, 0); ImageDraw.Draw(m).rounded_rectangle([0, 0, plate.width - 1, plate.height - 1], radius=40, fill=255)
    im.paste(plate, ((W - plate.width) // 2, 120), m); im.paste(lg, ((W - lg.width) // 2, 120 + pad), lg)
    centered(d, 400, "Интернет за границей", F(118, 700), "white", W)
    centered(d, 540, "без роуминга", F(118, 700), "white", W)
    centered(d, 730, "eSIM за 1 минуту  ·  211 стран  ·  от 69 ₽", F(62, 500), (232, 243, 250), W)
    # QR
    qs = 1000
    q = qr_img(p["link"], qs)
    box = Image.new("RGB", (qs + 80, qs + 80), "white")
    mk = Image.new("L", box.size, 0); ImageDraw.Draw(mk).rounded_rectangle([0, 0, box.width - 1, box.height - 1], radius=60, fill=255)
    bx = (W - box.width) // 2; by = top - 120
    sh = Image.new("RGBA", box.size, (0, 0, 0, 0))
    im.paste(box, (bx, by), mk); im.paste(q, (bx + 40, by + 40))
    d.rounded_rectangle([bx, by, bx + box.width, by + box.height], radius=60, outline=(220, 228, 238), width=4)
    y = by + box.height + 70
    centered(d, y, "Наведите камеру телефона", F(72, 600), INK, W)
    # плашка скидки
    y += 140
    txt = "−100 ₽ на первую покупку по этому QR"
    f = F(60, 700); tw = d.textlength(txt, font=f)
    d.rounded_rectangle([(W - tw) / 2 - 50, y - 26, (W + tw) / 2 + 50, y + 100], radius=60, fill=(232, 246, 239))
    d.text(((W - tw) / 2, y), txt, font=f, fill=(42, 143, 106))
    y += 200
    centered(d, y, "voyomobile.ru  ·  промокод " + p["code"], F(54, 500), MUT, W)
    im.save(out + ".png", optimize=True)
    im.save(out + ".pdf", "PDF", resolution=300.0)

def qr_card(p, out):
    W = 900; H = 1060
    im = Image.new("RGB", (W, H), "white"); d = ImageDraw.Draw(im)
    lg = LOGO.copy(); lw = 360; lg = lg.resize((lw, round(LOGO.height * lw / LOGO.width)), Image.LANCZOS)
    im.paste(lg, ((W - lw) // 2, 40), lg)
    im.paste(qr_img(p["link"], 780), (60, 130))
    centered(d, 925, "−100 ₽ на первую покупку по этому QR", F(36, 600), INK, W)
    centered(d, 985, "voyomobile.ru  ·  промокод " + p["code"], F(30, 400), MUT, W)
    im.save(out, optimize=True)

if __name__ == "__main__":
    lst = json.load(open(sys.argv[1], encoding="utf-8")); outdir = sys.argv[2]
    os.makedirs(outdir, exist_ok=True)
    for p in lst:
        dd = os.path.join(outdir, p["code"]); os.makedirs(dd, exist_ok=True)
        qr_card(p, os.path.join(dd, "qr-voyo-mobile.png"))
        stand(p, os.path.join(dd, "tablichka-voyo-mobile-A5"))
    print("готово:", len(lst))
