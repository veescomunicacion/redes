"""Genera la versión historia (1080 × 1920) a partir de una imagen de la plantilla de feed (1080 × 1350).

Uso: python3 herramientas/historia.py FEED.jpg "Frase línea 1\nFrase línea 2" "Aviso en naranja" SALIDA.jpg

Reutiliza la foto (franja y=216..1164) y el logo de la imagen de feed, con el mismo marco azul,
la frase en azul y debajo un aviso en el naranja oscuro de Vees. Deja libres las zonas de arriba y
de abajo, que en Instagram tapan el nombre y la barra de mensajes.
"""
import os
import sys

from PIL import Image, ImageDraw, ImageFont

AZUL = (0x00, 0x72, 0xCE)
NARANJA = (0xCD, 0x42, 0x14)
W, H = 1080, 1920
FR_Y0, FR_Y1 = 260, 1680
LG_Y = 300
PH_Y0, PH_Y1 = 490, 1438

FUENTES = {
    'regular': ['/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf', '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'],
    'negrita': ['/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf', '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf'],
}


def fuente(tipo, tam):
    for ruta in FUENTES[tipo]:
        if os.path.exists(ruta):
            return ImageFont.truetype(ruta, tam)
    raise SystemExit('No encuentro la fuente Liberation Sans (instala fonts-liberation).')


def componer(feed_path, texto, aviso, salida):
    feed = Image.open(feed_path).convert('RGB')
    if feed.size != (1080, 1350):
        feed = feed.resize((1080, 1350), Image.LANCZOS)
    c = Image.new('RGB', (W, H), 'white')
    c.paste(feed.crop((0, 216, 1080, 1164)), (0, PH_Y0))
    logo = feed.crop((360, 50, 720, 210))
    c.paste(logo, ((W - logo.width) // 2, LG_Y - 16))
    d = ImageDraw.Draw(c)
    d.rectangle((30, FR_Y0, 1050, FR_Y1), outline=AZUL, width=3)

    lineas = [l.strip() for l in texto.replace('\\n', '\n').split('\n') if l.strip()][:2]
    tam = 50
    f = fuente('regular', tam)
    while tam > 34 and max(d.textlength(l, font=f) for l in lineas) > 940:
        tam -= 1
        f = fuente('regular', tam)
    lh = round(tam * 1.15)
    fa = fuente('negrita', 38)
    alto_aviso, hueco = (44, 26) if aviso else (0, 0)
    alto = lh * len(lineas) + hueco + alto_aviso
    y0 = PH_Y1 + ((FR_Y1 - PH_Y1) - alto) // 2
    for i, l in enumerate(lineas):
        w = d.textlength(l, font=f)
        d.text(((W - w) / 2, y0 + i * lh), l, font=f, fill=AZUL)
    if aviso:
        w = d.textlength(aviso, font=fa)
        d.text(((W - w) / 2, y0 + lh * len(lineas) + hueco), aviso, font=fa, fill=NARANJA)
    c.save(salida, quality=95)


if __name__ == '__main__':
    if len(sys.argv) != 5:
        raise SystemExit(__doc__)
    componer(*sys.argv[1:5])
    print('ok', sys.argv[4])
