"""Креативы Meta: визы в США и Великобританию (14.10.2026).

Фото — то же, что в шапке страниц visa-sc.ru/usa и /britain (паспорт в руках),
чтобы объявление и страница выглядели одним целым. Сверху флаг страны и плашка,
снизу текст на тёмно-синем затемнении. Формулировки — только те, что есть на
страницах: «от 3 дней», «на срок до 10 лет», «получите визу или вернём деньги», бесплатная консультация.
Лента 1:1 и сторис/Reels 9:16, по папке на кампанию в vscom/ads.
"""
import os
from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
ADS = os.path.join(HERE, "..", "ads")
SRC = os.path.join(ADS, "_src_hero_passport.webp")
F = "/System/Library/Fonts/Supplemental/"
W = 1080
NAVY = (10, 22, 54)
GOLD = "#F5C518"
PASSPORT_X = 0.60     # центр паспорта по ширине исходника


def font(bold, size):
    return ImageFont.truetype(F + ("Arial Bold.ttf" if bold else "Arial.ttf"), size)


def wrap(d, text, fnt, maxw):
    lines, cur = [], ""
    for w in text.split():
        t = (cur + " " + w).strip()
        if d.textlength(t, font=fnt) <= maxw:
            cur = t
        else:
            lines.append(cur); cur = w
    lines.append(cur)
    return lines


def photo(h, scale_h=None):
    """Кадр W×h; scale_h > h — фото крупнее и срезано сверху, паспорт выше в кадре."""
    sh = scale_h or h
    src = Image.open(SRC).convert("RGB")
    k = sh / src.height
    src = src.resize((int(src.width * k), sh), Image.LANCZOS)
    left = max(0, min(src.width - W, int(src.width * PASSPORT_X) - W // 2))
    return src.crop((left, sh - h, left + W, sh))


def shade(im, y0, y1, a_max=245):
    w, h = im.size
    ov = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    od = ImageDraw.Draw(ov)
    for yy in range(h):
        a = 0 if yy < y0 else int(min(1, (yy - y0) / max(1, y1 - y0)) * a_max)
        od.line([(0, yy), (w, yy)], fill=NAVY + (a,))
    return Image.alpha_composite(im.convert("RGBA"), ov).convert("RGB")


def pill(d, x, y, text, size, bg, fg, pad=30, right=False):
    f = font(True, size)
    tw = d.textlength(text, font=f)
    if right:
        x = x - tw - 2 * pad
    d.rounded_rectangle([x, y, x + tw + 2 * pad, y + size + 2 * (pad // 2) + 8], (size + pad) // 2, fill=bg)
    d.text((x + pad, y + pad // 2 + 2), text, font=f, fill=fg)
    return y + size + 2 * (pad // 2) + 8


def flag_us(im, x, y, w0):
    w = w0 * 8
    h = int(w * 10 / 19)
    fl = Image.new("RGB", (w, h), "white")
    d = ImageDraw.Draw(fl)
    sh = h / 13
    for i in range(0, 13, 2):
        d.rectangle([0, round(i * sh), w, round((i + 1) * sh) - 1], fill="#B22234")
    cw, ch = int(w * 0.4), round(7 * sh)
    d.rectangle([0, 0, cw, ch], fill="#3C3B6E")
    r = w / 95
    for row in range(9):
        cols = 6 if row % 2 == 0 else 5
        for c in range(cols):
            cx = cw / 12 * (2 * c + 1 + (row % 2))
            cy = ch / 10 * (row + 1)
            d.ellipse([cx - r, cy - r, cx + r, cy + r], fill="white")
    paste_flag(im, fl.resize((w0, round(h / 8)), Image.LANCZOS), x, y)


def flag_gb(im, x, y, w0):
    w = w0 * 8
    h = w // 2
    fl = Image.new("RGB", (w, h), "#012169")
    d = ImageDraw.Draw(fl)
    for a, b in [((0, 0), (w, h)), ((0, h), (w, 0))]:
        d.line([a, b], fill="white", width=w // 10)
        d.line([a, b], fill="#C8102E", width=w // 30)
    d.rectangle([w * 0.42, 0, w * 0.58, h], fill="white")
    d.rectangle([0, h * 0.35, w, h * 0.65], fill="white")
    d.rectangle([w * 0.46, 0, w * 0.54, h], fill="#C8102E")
    d.rectangle([0, h * 0.41, w, h * 0.59], fill="#C8102E")
    paste_flag(im, fl.resize((w0, round(h / 8)), Image.LANCZOS), x, y)


def paste_flag(im, fl, x, y):
    # флаг рисуется крупно (см. flag_*) и уменьшается: на мелком размере звёзды
    # иначе сливаются в белое пятно вместо синего поля
    # маленький флаг со скруглёнными углами — значок в строке над заголовком
    r = max(4, fl.width // 12)
    m = Image.new("L", fl.size, 0)
    ImageDraw.Draw(m).rounded_rectangle([0, 0, fl.width - 1, fl.height - 1], r, fill=255)
    im.paste(fl, (x, y), m)


C = {
    "usa": {
        "dir": "Виза в США (VSC USA RU)", "flag": flag_us, "tag": "ВИЗА В США",
        "head": ["Виза в США от 3 дней", "на срок до 10 лет"],
        "bullets": ["Документы и запись на подачу", "Получите визу или вернём деньги"],
    },
    "uk": {
        "dir": "Виза в Великобританию (VSC UK RU)", "flag": flag_gb, "tag": "ВИЗА В ВЕЛИКОБРИТАНИЮ",
        "head": ["Виза в Великобританию", "от 3 дней", "на срок до 10 лет"],
        "bullets": ["Документы и запись на подачу", "Получите визу или вернём деньги"],
    },
}
CTA = "Бесплатная консультация"


def text(d, c, y, hs=72, bs=42):
    fh = font(True, hs)
    for ln in c["head"]:
        assert d.textlength(ln, font=fh) <= W - 160, ln
        d.text((80, y), ln, font=fh, fill="white"); y += int(hs * 1.17)
    y += 24
    for b in c["bullets"]:
        d.ellipse([84, y + 13, 106, y + 35], fill=GOLD)
        d.text((124, y), b, font=font(False, bs), fill="#EEF2FA"); y += int(bs * 1.5)
    return y


def save(im, c, story):
    d = os.path.join(ADS, c["dir"])
    os.makedirs(d, exist_ok=True)
    im.save(os.path.join(d, "сторис и Reels 9x16.jpg" if story else "лента 1x1.jpg"), quality=92)


def label(im, d, c, y, size):
    """Строка «флаг + ВИЗА В …» золотом над заголовком, на тёмном фоне, не на фото."""
    fw = int(size * 1.9)
    fh = int(fw * 10 / 19) if c["flag"] is flag_us else fw // 2
    c["flag"](im, 80, y + (size - fh) // 2 + 3, fw)
    d.text((80 + fw + 22, y), c["tag"], font=font(True, size), fill=GOLD)
    return y + size + 26


def block(im, d, c, y, ls, hs, bs, cs):
    y = label(im, d, c, y, ls)
    y = text(d, c, y, hs, bs)
    return pill(d, 80, y + 30, CTA, cs, GOLD, "#1A1A1A", pad=40)


def measure(c, *a):
    tmp = Image.new("RGB", (W, W))
    return block(tmp, ImageDraw.Draw(tmp), c, 0, *a)


def feed(c):
    # Лента 1:1: сверху чистое фото, весь текст — на затемнении снизу
    sz = (34, 70, 40, 42)
    y0 = 1010 - measure(c, *sz)
    im = shade(photo(W, 1750), y0 - 200, y0 + 40)
    block(im, ImageDraw.Draw(im), c, y0, *sz)
    save(im, c, False)


def story(c):
    # Сторис 9:16: сверху ~250 px закрывает имя аккаунта, снизу ~340 px — кнопка.
    # Фото в верхней части, текст на тёмно-синем ниже, заканчивается к 1580.
    H = 1920
    sz = (40, 72, 50, 48)
    y0 = 1580 - measure(c, *sz)
    im = Image.new("RGB", (W, H), NAVY)
    im.paste(photo(y0 + 80), (0, 0))
    im = shade(im, y0 - 320, y0 + 40, 255)
    block(im, ImageDraw.Draw(im), c, y0, *sz)
    save(im, c, True)


for c in C.values():
    feed(c)
    story(c)
print("ok", [c["dir"] for c in C.values()])
