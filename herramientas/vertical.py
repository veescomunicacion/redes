"""Convierte un post de la plantilla (1080 × 1350) en un fotograma vertical de Reel (1080 × 1920).

Uso: python3 herramientas/vertical.py POST.jpg SALIDA.jpg

El post va entero y sin tocar en el centro. Arriba y abajo, en lugar de bandas negras, va la misma
foto ampliada y desenfocada. Así:
- en la cuadrícula del perfil (recorte 3:4 del centro) se ve el post entero, igual que los demás;
- en la pestaña de Reels no se corta la frase;
- a pantalla completa llena toda la pantalla.
"""
import sys

from PIL import Image, ImageEnhance, ImageFilter

W, H = 1080, 1920


def componer(post, salida):
    im = Image.open(post).convert('RGB')
    if im.size != (1080, 1350):
        im = im.resize((1080, 1350), Image.LANCZOS)
    foto = im.crop((36, 218, 1044, 1162))  # la foto de la plantilla, sin las líneas del marco
    r = max(W / foto.width, H / foto.height)
    fondo = foto.resize((round(foto.width * r), round(foto.height * r)), Image.LANCZOS)
    fondo = fondo.crop(((fondo.width - W) // 2, (fondo.height - H) // 2, (fondo.width - W) // 2 + W, (fondo.height - H) // 2 + H))
    fondo = ImageEnhance.Brightness(fondo.filter(ImageFilter.GaussianBlur(40))).enhance(0.7)
    # La cuadrícula del perfil enseña el centro 3:4 (1080 × 1440). El post se escala para llenar justo
    # esa franja, recortando los lados igual que hace Instagram con los posts normales en la cuadrícula.
    G = 1440
    esc = im.resize((round(1080 * G / 1350), G), Image.LANCZOS)
    centro = esc.crop(((esc.width - W) // 2, 0, (esc.width - W) // 2 + W, G))
    fondo.paste(centro, (0, (H - G) // 2))
    fondo.save(salida, quality=95)


if __name__ == '__main__':
    if len(sys.argv) != 3:
        raise SystemExit(__doc__)
    componer(sys.argv[1], sys.argv[2])
    print('ok', sys.argv[2])
