"""Креативы Meta для VOYO mobile (eSIM): лента 1:1 и сторис 9:16, два варианта.
Аудитория — русскоязычные, кто много ездит; оплата только российской картой и СБП,
поэтому это прямо на картинке: отсекает тех, кто заплатить не сможет.
Пересборка: python3 esim_creatives.py → vscom/ads/eSIM VOYO mobile (VSC eSIM RU)/"""
import os
from PIL import Image, ImageDraw, ImageFont

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "ads", "eSIM VOYO mobile (VSC eSIM RU)")
os.makedirs(OUT, exist_ok=True)
F = "/System/Library/Fonts/Supplemental/"
W = 1080
TOP_C, BOT_C = (20, 66, 102), (53, 137, 189)      # от тёмного к фирменному #3589bd
MINT = "#7CE0C3"
INK = "#0E2A40"


def font(bold, size):
    # San Francisco: в Arial нет знака ₽
    f = ImageFont.truetype("/System/Library/Fonts/SFNS.ttf", size)
    f.set_variation_by_name(b"Bold" if bold else b"Regular")
    return f


def wrap(d, text, f, maxw):
    if "\n" in text:                       # перенос задан вручную
        return text.split("\n")
    lines, cur = [], ""
    for w in text.split():
        t = (cur + " " + w).strip()
        if d.textlength(t, font=f) <= maxw:
            cur = t
        else:
            lines.append(cur); cur = w
    return lines + [cur]


def bg(h):
    im = Image.new("RGB", (W, h))
    d = ImageDraw.Draw(im)
    for y in range(h):
        k = y / h
        d.line([(0, y), (W, y)], fill=tuple(int(a + (b - a) * k) for a, b in zip(TOP_C, BOT_C)))
    # мягкие «волны связи» в углу
    for i, r in enumerate((250, 180, 110)):
        d.arc([W - r, -r, W + r, r], 90, 180, fill=(170, 210, 235), width=3 + i)
    return im, d


def sim_icon(d, x, y, s):
    """Фирменный компас VOYO (знак из буквы «О», public/favicon.svg) мятным цветом.
    Рисуется в 4× на прозрачном слое и уменьшается — края гладкие."""
    S = int(s * 1.25)                      # по высоте как прежний значок SIM
    k = 4
    Z = S * k
    u = Z / 70.0                           # в SVG знак занимает квадрат 15..85
    P = lambda vx, vy: ((vx - 15) * u, (vy - 15) * u)
    lay = Image.new("RGBA", (Z, Z), (0, 0, 0, 0))
    ld = ImageDraw.Draw(lay)
    r, w = 30 * u, 8.2 * u
    cx, cy = P(50, 50)
    ld.ellipse([cx - r - w / 2, cy - r - w / 2, cx + r + w / 2, cy + r + w / 2], fill=MINT)
    ld.ellipse([cx - r + w / 2, cy - r + w / 2, cx + r - w / 2, cy + r - w / 2], fill=(0, 0, 0, 0))
    # горизонтальные разрывы кольца слева и справа
    g0, g1 = P(0, 44.4)[1], P(0, 55.6)[1]
    ld.rectangle([0, g0, P(35, 0)[0], g1], fill=(0, 0, 0, 0))
    ld.rectangle([P(65, 0)[0], g0, Z, g1], fill=(0, 0, 0, 0))
    # стрелка
    ld.polygon([P(66.6, 33.4), P(54.4, 54.4), P(33.4, 66.6), P(45.6, 45.6)], fill=MINT)
    lay = lay.resize((S, S), Image.LANCZOS)
    d._image.paste(lay, (int(x), int(y)), lay)


def pill(d, x, y, text, f, bg_, fg, pad=28, full_w=None):
    tw = d.textlength(text, font=f)
    w = full_w or tw + 2 * pad
    h = f.size + 2 * pad // 2 + 14
    d.rounded_rectangle([x, y, x + w, y + h], h // 2, fill=bg_)
    d.text((x + w / 2, y + h / 2), text, font=f, fill=fg, anchor="mm")
    return y + h


VARIANTS = {
    "price": dict(head="Интернет в поездке от 69 ₽",
                  bullets=["Без роуминга, 190+ стран", "QR-код сразу после оплаты", "Оплата российской картой и СБП"]),
    "travel": dict(head="Прилетели и\nсразу на связи",
                   bullets=["eSIM для любой страны от 69 ₽", "Ставится за 2 минуты до вылета", "Оплата российской картой и СБП"]),
}


def feed(key, v):
    im, d = bg(W)
    sim_icon(d, 80, 80, 90)
    d.text((200, 92), "VOYO mobile", font=font(True, 52), fill="white")
    d.text((200, 152), "eSIM для путешествий", font=font(False, 34), fill="#D6E9F7")
    y = 300
    fh = font(True, 86)
    for ln in wrap(d, v["head"], fh, W - 160):
        d.text((80, y), ln, font=fh, fill="white"); y += 98
    y += 34
    fb = font(False, 44)
    for b in v["bullets"]:
        d.ellipse([84, y + 14, 110, y + 40], fill=MINT)
        d.text((132, y), b, font=fb, fill="#EEF6FC"); y += 70
    pill(d, 80, 900, "Выбрать eSIM", font(True, 46), MINT, INK, pad=44)
    d.text((W - 80, 935), "voyomobile.com", font=font(True, 34), fill="white", anchor="rm")
    im.save(os.path.join(OUT, "%s лента 1x1.jpg" % key), quality=92)


def story(key, v):
    """Важное между 260 и 1560 px: сверху имя аккаунта, снизу кнопка сторис."""
    H, TOP, BOT = 1920, 260, 1560
    im, d = bg(H)
    fh, fb = font(True, 100), font(False, 56)

    def block(y, draw):
        if draw: sim_icon(d, 80, y, 120)
        if draw: d.text((240, y + 18), "VOYO mobile", font=font(True, 62), fill="white")
        if draw: d.text((240, y + 92), "eSIM для путешествий", font=font(False, 40), fill="#D6E9F7")
        y += 230
        for ln in wrap(d, v["head"], fh, W - 160):
            if draw: d.text((80, y), ln, font=fh, fill="white")
            y += 114
        y += 50
        for b in v["bullets"]:
            if draw:
                d.ellipse([84, y + 18, 118, y + 52], fill=MINT)
                d.text((146, y), b, font=fb, fill="#EEF6FC")
            y += 92
        y += 60
        if draw: pill(d, 80, y, "Выбрать eSIM", font(True, 60), MINT, INK, full_w=W - 160)
        y += 140
        if draw: d.text((W // 2, y + 20), "voyomobile.com", font=font(True, 40), fill="white", anchor="mm")
        return y + 50

    h = block(0, False)
    assert h <= BOT - TOP, (key, h)
    block(TOP + (BOT - TOP - h) // 2, True)
    im.save(os.path.join(OUT, "%s сторис и Reels 9x16.jpg" % key), quality=92)


for k, v in VARIANTS.items():
    feed(k, v)
    story(k, v)
print("ok", sorted(os.listdir(OUT)))
