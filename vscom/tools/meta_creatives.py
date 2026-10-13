"""Креативы Meta 1080x1080: UK ETA (BR/ES/IT/US) и ВНЖ Испании."""
import os
from PIL import Image, ImageDraw, ImageFont, ImageFilter

OUT = os.path.dirname(os.path.abspath(__file__)) + "/out"
os.makedirs(OUT, exist_ok=True)
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

def eta(tag, kicker, head, bullets, price, cta, foot):
    im = Image.new("RGB", (W, W))
    d = ImageDraw.Draw(im)
    for yy in range(W):  # тёмно-синий градиент
        k = yy / W
        d.line([(0, yy), (W, yy)], fill=(int(10 + 12 * k), int(25 + 30 * k), int(70 + 60 * k)))
    flag_gb(d, 80, 80, 150)
    d.text((260, 92), kicker, font=font(True, 40), fill="#9FC3FF")
    d.text((260, 142), "UK ETA", font=font(True, 34), fill="white")
    y = 250
    for ln in wrap(d, head, font(True, 84), W - 160):
        d.text((80, y), ln, font=font(True, 84), fill="white"); y += 96
    y += 30
    for b in bullets:
        d.ellipse([84, y + 14, 108, y + 38], fill="#3DDC97")
        d.text((128, y), b, font=font(False, 44), fill="#E6EEFF"); y += 70
    d.rounded_rectangle([80, 850, 80 + d.textlength(cta, font=font(True, 46)) + 80, 940], 45, fill="#3DDC97")
    d.text((120, 868), cta, font=font(True, 46), fill="#0A1F4A")
    d.text((W - 80, 872), price, font=font(True, 52), fill="white", anchor="ra")
    d.text((80, 985), foot, font=font(False, 26), fill="#8FA6D6")
    im.save(f"{OUT}/eta_{tag}.jpg", quality=92)

eta("br", "Viagem ao Reino Unido", "Autorização UK em ordem antes do voo",
    ["Em português, pelo celular", "Revisão antes do envio", "Resposta a partir de 15 min"],
    "a partir de R$ 599", "Começar", "VSC — empresa privada, sem vínculo com o governo do Reino Unido")
eta("es", "Viaje al Reino Unido", "Tu autorización UK lista antes de volar",
    ["En español, desde el móvil", "Revisión antes del envío", "Respuesta desde 15 min"],
    "desde €89", "Empezar", "VSC — empresa privada, sin relación con el gobierno del Reino Unido")
eta("it", "Viaggio nel Regno Unito", "Autorizzazione UK pronta prima del volo",
    ["In italiano, dal telefono", "Controllo prima dell'invio", "Risposta da 15 min"],
    "da €89", "Inizia", "VSC — società privata, non collegata al governo del Regno Unito")
eta("us", "Flying to the UK?", "Get your UK travel authorisation sorted",
    ["Done on your phone", "Every field checked first", "Replies from 15 min"],
    "from $99", "Get started", "VSC is a private company, not affiliated with the UK government")

# ВНЖ Испании: фото + плашка
src = Image.open(IMG + "hero-spain.webp").convert("RGB")
s = W / src.height
src = src.resize((int(src.width * s), W))
left = (src.width - W) // 2
im = src.crop((left, 0, left + W, W))
ov = Image.new("RGBA", (W, W), (0, 0, 0, 0))
od = ImageDraw.Draw(ov)
for yy in range(W):
    a = int(max(0, (yy - 300) / (W - 300)) * 235)
    od.line([(0, yy), (W, yy)], fill=(8, 18, 45, a))
im = Image.alpha_composite(im.convert("RGBA"), ov).convert("RGB")
d = ImageDraw.Draw(im)
d.rounded_rectangle([80, 80, 80 + d.textlength("ВНЖ ИСПАНИИ", font=font(True, 38)) + 60, 150], 35, fill="#F5C518")
d.text((110, 95), "ВНЖ ИСПАНИИ", font=font(True, 38), fill="#1A1A1A")
y = 540
for ln in wrap(d, "Живите в Испании и ездите по всей Европе", font(True, 74), W - 160):
    d.text((80, y), ln, font=font(True, 74), fill="white"); y += 86
y += 20
for b in ["Статус сразу на 3 года, семья вместе с вами", "Подача из любой страны"]:
    d.ellipse([84, y + 12, 106, y + 34], fill="#F5C518")
    d.text((124, y), b, font=font(False, 40), fill="#F0F0F0"); y += 60
d.rounded_rectangle([80, 950 - 20, 80 + d.textlength("Бесплатная консультация", font=font(True, 42)) + 80, 1010], 40, fill="#F5C518")
d.text((120, 946), "Бесплатная консультация", font=font(True, 42), fill="#1A1A1A")
im.save(f"{OUT}/vnj_es.jpg", quality=92)
print("ok", sorted(os.listdir(OUT)))
