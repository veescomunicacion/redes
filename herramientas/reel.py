"""Monta un Reel vertical (1080 × 1920, MP4 H.264) a partir de varias imágenes de la plantilla.

Uso: python3 herramientas/reel.py SALIDA.mp4 SEGUNDOS IMAGEN1.jpg IMAGEN2.jpg [...] [--completa] [--audio AUDIO]

--completa: las imágenes ya están montadas a pantalla completa con herramientas/pantalla.py.
--post: Reel del tamaño de un post (1080 × 1350), con las imágenes de post de la plantilla tal cual.

- Acepta imágenes de historia (1080 × 1920) o de post (1080 × 1350).
- Reduce el contenido para que quede dentro de la zona segura de los Reels: arriba Instagram pone
  el título y la cámara; abajo, el texto y el nombre; a la derecha, los botones.
- Cada imagen hace un zoom muy lento y pasa a la siguiente con un fundido.
- Lleva una pista de audio en silencio (la música la pone Instagram) o, con --audio, ese audio
  recortado y con fundido de salida (solo para vistas previas internas).
"""
import subprocess
import sys

from PIL import Image

W, H, FPS = 1080, 1920, 30
ESCALA = 0.88          # tamaño del contenido dentro del Reel
CENTRO_Y = 900         # centro vertical del contenido (algo por encima de la mitad)
ZOOM_FINAL = 1.05      # zoom al final del vídeo
FUNDIDO = 0.8          # segundos de fundido entre imágenes


def lienzo(ruta, completa=False):
    im = Image.open(ruta).convert('RGB')
    if completa:
        # Imagen ya montada a pantalla completa (herramientas/pantalla.py): se usa tal cual
        return im.resize((W, H), Image.LANCZOS) if im.size != (W, H) else im
    if im.size == (1080, 1920):
        # Historia: el contenido útil va del marco superior al inferior
        im = im.crop((0, 240, 1080, 1700))
    w, h = round(im.width * ESCALA), round(im.height * ESCALA)
    im = im.resize((w, h), Image.LANCZOS)
    c = Image.new('RGB', (W, H), 'white')
    c.paste(im, ((W - w) // 2, CENTRO_Y - h // 2))
    return c


def con_zoom(img, z):
    if z <= 1.0001:
        return img
    # Zoom centrado en el contenido, con interpolación suave (sin saltos de píxel)
    cx, cy = W / 2, CENTRO_Y
    a = 1 / z
    return img.transform((W, H), Image.AFFINE, (a, 0, cx - a * cx, 0, a, cy - a * cy), resample=Image.BICUBIC, fillcolor='white')


def main():
    global H, CENTRO_Y, ZOOM_FINAL
    args = sys.argv[1:]
    completa = '--completa' in args
    if '--post' in args:
        # Reel del tamaño de un post (1080 × 1350) con las imágenes de la plantilla tal cual.
        # Zoom más suave para que el marco azul (a 30 px del borde) no se salga.
        H, CENTRO_Y, ZOOM_FINAL, completa = 1350, 675, 1.02, True
    args = [a for a in args if a not in ('--completa', '--post')]
    audio = None
    if '--audio' in args:
        i = args.index('--audio')
        audio = args[i + 1]
        del args[i:i + 2]
    if len(args) < 3:
        raise SystemExit(__doc__)
    salida, segundos, imagenes = args[0], float(args[1]), args[2:]
    n = len(imagenes)
    total = round(segundos * FPS)
    fundido = round(FUNDIDO * FPS)
    # Duración de cada tramo contando los solapes de los fundidos
    tramo = (total + fundido * (n - 1)) / n
    lienzos = [lienzo(r, completa) for r in imagenes]
    inicios = [round(k * (tramo - fundido)) for k in range(n)]

    cmd = ['ffmpeg', '-y', '-loglevel', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', f'{W}x{H}', '-r', str(FPS), '-i', '-']
    if audio:
        cmd += ['-i', audio]
    else:
        cmd += ['-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000']
    cmd += ['-map', '0:v', '-map', '1:a', '-t', f'{total / FPS:.3f}',
            '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p', '-profile:v', 'high', '-movflags', '+faststart',
            '-c:a', 'aac', '-b:a', '128k', '-ar', '48000']
    if audio:
        fin = total / FPS
        cmd += ['-af', f'afade=t=in:d=0.3,afade=t=out:st={fin - 1.2:.2f}:d=1.2']
    cmd += [salida]
    p = subprocess.Popen(cmd, stdin=subprocess.PIPE)

    for f in range(total):
        # Mezcla de imágenes (el logo y el marco coinciden, así que solo cambian la foto y la frase)
        frame = None
        for k in range(n):
            ini = inicios[k]
            fin = ini + round(tramo)
            if not (ini <= f < fin):
                continue
            if frame is None:
                frame = lienzos[k]
            else:
                alfa = min(1.0, (f - ini + 1) / fundido)
                frame = Image.blend(frame, lienzos[k], alfa)
        if frame is None:
            frame = lienzos[-1]
        # Un único zoom lento para todo el vídeo
        frame = con_zoom(frame, 1 + (ZOOM_FINAL - 1) * f / max(1, total - 1))
        p.stdin.write(frame.tobytes())
    p.stdin.close()
    if p.wait() != 0:
        raise SystemExit('ffmpeg falló')
    print('ok', salida)


if __name__ == '__main__':
    main()
