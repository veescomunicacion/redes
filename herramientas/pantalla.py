"""Monta una imagen a pantalla completa (1080 × 1920) para Reels, a partir del post de la plantilla (1080 × 1350).

Uso: python3 herramientas/pantalla.py POST.jpg "Frase línea 1\nFrase línea 2" SALIDA.jpg

- Fondo: la misma foto ampliada, desenfocada y oscurecida (nada de blanco).
- Arriba, el logo de Vees en una pastilla blanca.
- En el centro, la foto a todo el ancho (sin las líneas del marco azul).
- Debajo, la frase en blanco con una sombra suave.
Todo queda dentro de la zona segura de los Reels (arriba, el título de Instagram; abajo, el texto
y el nombre de la cuenta).
"""
import sys

from PIL import Image, ImageDraw, ImageEnhance, ImageFilter, ImageFont

W, H = 1080, 1920
NEGRITA = '/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf'
LOGO_Y = 215
FOTO_Y = 380


def componer(post, frase, salida):
    im = Image.open(post).convert('RGB')
    if im.size != (1080, 1350):
        im = im.resize((1080, 1350), Image.LANCZOS)
    foto = im.crop((36, 218, 1044, 1162))  # la foto, sin las líneas del marco
    foto = foto.resize((W, round(foto.height * W / foto.width)), Image.LANCZOS)
    logo = im.crop((360, 50, 720, 210))

    r = max(W / foto.width, H / foto.height)
    fondo = foto.resize((round(foto.width * r), round(foto.height * r)), Image.LANCZOS)
    fondo = fondo.crop(((fondo.width - W) // 2, (fondo.height - H) // 2, (fondo.width - W) // 2 + W, (fondo.height - H) // 2 + H))
    fondo = ImageEnhance.Brightness(fondo.filter(ImageFilter.GaussianBlur(38))).enhance(0.55)

    c = fondo.copy()
    d = ImageDraw.Draw(c)
    lw = 300
    lg = logo.resize((lw, round(logo.height * lw / logo.width)), Image.LANCZOS)
    pad = 22
    x0 = (W - lw) // 2 - pad
    d.rounded_rectangle((x0, LOGO_Y, x0 + lw + 2 * pad, LOGO_Y + lg.height + 2 * pad - 10), radius=26, fill='white')
    c.paste(lg, (x0 + pad, LOGO_Y + pad - 6))

    c.paste(foto, (0, FOTO_Y))

    lineas = [l.strip() for l in frase.replace('\\n', '\n').split('\n') if l.strip()][:2]
    t = 54
    fn = ImageFont.truetype(NEGRITA, t)
    while max(d.textlength(l, font=fn) for l in lineas) > 960:
        t -= 1
        fn = ImageFont.truetype(NEGRITA, t)
    y = FOTO_Y + foto.height + 30
    for l in lineas:
        w = d.textlength(l, font=fn)
        d.text(((W - w) / 2 + 2, y + 3), l, font=fn, fill=(0, 0, 0))
        d.text(((W - w) / 2, y), l, font=fn, fill='white')
        y += round(t * 1.2)
    c.save(salida, quality=95)


if __name__ == '__main__':
    if len(sys.argv) != 4:
        raise SystemExit(__doc__)
    componer(*sys.argv[1:4])
    print('ok', sys.argv[3])
