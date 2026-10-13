"""Креативы Meta 1080x1080: UK ETA (BR/ES/IT/US) и ВНЖ Испании."""
import os
from PIL import Image, ImageDraw, ImageFont, ImageFilter

ADS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "ads")
# по папке на кампанию в Ads Manager: лента 1:1 и сторис/Reels 9:16
DIRS = {"eta_br": "ETA Бразилия (VSC ETA BR)", "eta_es": "ETA Испания (VSC ETA ES)",
        "eta_it": "ETA Италия (VSC ETA IT)", "eta_us": "ETA США (VSC ETA US)",
        "vnj_es": "ВНЖ Испании (VSC VNJ Spain RU)"}


def save(im, key, suffix):
    d = os.path.join(ADS, DIRS[key])
    os.makedirs(d, exist_ok=True)
    name = "сторис и Reels 9x16.jpg" if suffix else "лента 1x1.jpg"
    im.save(os.path.join(d, name), quality=92)
IMG = "/Users/andrey/Documents/Бизнес/VOYO/lk-vsc-macbook/vscom/public/img/"
F = "/System/Library/Fonts/Supplemental/"
def font(bold, size):
    return ImageFont.truetype(F + ("Arial Bold.ttf" if bold else "Arial.ttf"), size)

W = 1080

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

def flag_gb(d, x, y, w):
    h = w // 2
    d.rectangle([x, y, x + w, y + h], fill="#012169")
    for a, b in [((x, y), (x + w, y + h)), ((x, y + h), (x + w, y))]:
        d.line([a, b], fill="white", width=w // 10)
        d.line([a, b], fill="#C8102E", width=w // 30)
    d.rectangle([x + w * 0.42, y, x + w * 0.58, y + h], fill="white")
    d.rectangle([x, y + h * 0.35, x + w, y + h * 0.65], fill="white")
    d.rectangle([x + w * 0.46, y, x + w * 0.54, y + h], fill="#C8102E")
    d.rectangle([x, y + h * 0.41, x + w, y + h * 0.59], fill="#C8102E")

def eta(tag, kicker, head, bullets, price, cta, foot, H=W, suffix=""):
    oy = (H - W) // 2   # вертикальная версия: тот же макет по центру
    im = Image.new("RGB", (W, H))
    d = ImageDraw.Draw(im)
    for yy in range(H):  # тёмно-синий градиент
        k = yy / H
        d.line([(0, yy), (W, yy)], fill=(int(10 + 12 * k), int(25 + 30 * k), int(70 + 60 * k)))
    flag_gb(d, 80, 80 + oy, 150)
    d.text((260, 92 + oy), kicker, font=font(True, 40), fill="#9FC3FF")
    d.text((260, 142 + oy), "UK ETA", font=font(True, 34), fill="white")
    y = 250 + oy
    for ln in wrap(d, head, font(True, 84), W - 160):
        d.text((80, y), ln, font=font(True, 84), fill="white"); y += 96
    y += 30
    for b in bullets:
        d.ellipse([84, y + 14, 108, y + 38], fill="#3DDC97")
        d.text((128, y), b, font=font(False, 44), fill="#E6EEFF"); y += 70
    d.rounded_rectangle([80, 850 + oy, 80 + d.textlength(cta, font=font(True, 46)) + 80, 940 + oy], 45, fill="#3DDC97")
    d.text((120, 868 + oy), cta, font=font(True, 46), fill="#0A1F4A")
    d.text((W - 80, 872 + oy), price, font=font(True, 52), fill="white", anchor="ra")
    d.text((80, 985 + oy), foot, font=font(False, 26), fill="#8FA6D6")
    save(im, "eta_" + tag, suffix)


def eta_story(tag, kicker, head, bullets, price, cta, foot):
    """Сторис 9:16. Сверху ~240 px закрывает имя аккаунта, снизу ~340 px — кнопка,
    поэтому весь блок центрируется между 260 и 1560, крупно — смотрят с телефона."""
    H, TOP, BOTTOM = 1920, 260, 1560
    im = Image.new("RGB", (W, H))
    d = ImageDraw.Draw(im)
    for yy in range(H):
        k = yy / H
        d.line([(0, yy), (W, yy)], fill=(int(8 + 14 * k), int(22 + 34 * k), int(64 + 70 * k)))

    def block(y, draw):
        fh, fb, fc, ff = font(True, 88), font(False, 54), font(True, 58), font(False, 28)
        if draw: flag_gb(d, 80, y, 240)
        y += 150
        if draw: d.text((80, y), kicker, font=font(True, 50), fill="#9FC3FF")
        y += 60
        if draw: d.text((80, y), "UK ETA", font=font(True, 42), fill="white")
        y += 100
        for ln in wrap(d, head, fh, W - 160):
            if draw: d.text((80, y), ln, font=fh, fill="white")
            y += 104
        y += 44
        for b in bullets:
            if draw:
                d.ellipse([84, y + 18, 114, y + 48], fill="#3DDC97")
                d.text((140, y), b, font=fb, fill="#E6EEFF")
            y += 86
        y += 50
        if draw: d.text((80, y), price, font=font(True, 76), fill="white")
        y += 116
        if draw:
            d.rounded_rectangle([80, y, W - 80, y + 120], 60, fill="#3DDC97")
            d.text((W // 2, y + 60), cta, font=fc, fill="#0A1F4A", anchor="mm")
        y += 156
        for ln in wrap(d, foot, ff, W - 160):
            if draw: d.text((80, y), ln, font=ff, fill="#8FA6D6")
            y += 38
        return y

    h = block(0, False)
    lines = len(wrap(d, head, font(True, 88), W - 160))
    assert lines <= 2, (tag, "заголовок не в 2 строки")
    assert h <= BOTTOM - TOP, (tag, h)
    block(TOP + (BOTTOM - TOP - h) // 2, True)
    save(im, "eta_" + tag, "_9x16")

ETA = [
    ("br", "Viagem ao Reino Unido", "Autorização UK em ordem antes do voo",
    ["Em português, pelo celular", "Revisão antes do envio", "Resposta a partir de 15 min"],
    "a partir de R$ 599", "Começar", "VSC — empresa privada, sem vínculo com o governo do Reino Unido"),
    ("es", "Viaje al Reino Unido", "Tu autorización UK lista antes de volar",
    ["En español, desde el móvil", "Revisión antes del envío", "Respuesta desde 15 min"],
    "desde €89", "Empezar", "VSC — empresa privada, sin relación con el gobierno del Reino Unido"),
    ("it", "Viaggio nel Regno Unito", "Autorizzazione UK pronta prima del volo",
    ["In italiano, dal telefono", "Controllo prima dell'invio", "Risposta da 15 min"],
    "da €89", "Inizia", "VSC — società privata, non collegata al governo del Regno Unito"),
    ("us", "Flying to the UK?", "Get your UK travel authorisation sorted",
    ["Done on your phone", "Every field checked first", "Replies from 15 min"],
    "from $99", "Get started", "VSC is a private company, not affiliated with the UK government"),

]
for args in ETA:
    eta(*args)                      # 1:1 — лента Facebook и Instagram
    eta_story(*args)                # 9:16 — сторис и Reels, своя вёрстка

# ВНЖ Испании: фото + плашка
NAVY = (10, 22, 54)
GOLD = "#F5C518"
FLAG_X = 712          # центр флага на hero-spain.webp, px исходника


def photo(h):
    """Фото высотой h, кадр шириной W с флагом левее центра."""
    src = Image.open(IMG + "hero-spain.webp").convert("RGB")
    k = h / src.height
    src = src.resize((int(src.width * k), h))
    left = max(0, min(src.width - W, int(FLAG_X * k) - int(W * 0.42)))
    return src.crop((left, 0, left + W, h))


def shade(im, y0, y1, a_max=245):
    """Затемнение в тёмно-синий от y0 (прозрачно) до y1 (a_max) и ниже."""
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


def vnj_text(d, y):
    for ln in wrap(d, "Живите в Испании и ездите по всей Европе", font(True, 74), W - 160):
        d.text((80, y), ln, font=font(True, 74), fill="white"); y += 86
    y += 24
    for b in ["Статус сразу на 3 года, семья вместе с вами", "Подача из любой страны"]:
        d.ellipse([84, y + 12, 106, y + 34], fill=GOLD)
        d.text((124, y), b, font=font(False, 40), fill="#EEF2FA"); y += 60
    return y


def vnj():
    # Лента 1:1: флаг сверху-слева, плашка — тёмная справа на небе, текст на затемнении снизу
    im = shade(photo(W), 470, 780)
    d = ImageDraw.Draw(im)
    pill(d, W - 70, 70, "ВНЖ ИСПАНИИ", 38, NAVY, GOLD, right=True)
    vnj_text(d, 560)
    pill(d, 80, 925, "Бесплатная консультация", 42, GOLD, "#1A1A1A", pad=40)
    save(im, "vnj_es", "")


def vnj_story():
    # Сторис 9:16: фото с флагом в верхних 1250 px, ниже — тёмно-синий блок с текстом.
    # Сверху ~200 px и снизу ~300 px перекрывают имя аккаунта и кнопка — там ничего важного.
    H = 1920
    im = Image.new("RGB", (W, H), NAVY)
    im.paste(photo(1250), (0, 0))
    im = shade(im, 820, 1250, 255)
    d = ImageDraw.Draw(im)
    y = pill(d, 80, 1130, "ВНЖ ИСПАНИИ", 38, GOLD, "#1A1A1A") + 34
    y = vnj_text(d, y)
    pill(d, 80, y + 40, "Бесплатная консультация", 42, GOLD, "#1A1A1A", pad=40)
    save(im, "vnj_es", "_9x16")


vnj()
vnj_story()
print("ok", sorted(DIRS.values()))
