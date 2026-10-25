# Redes de Vees Comunicación

Aquí vive el sistema que publica en Instagram, Facebook, LinkedIn y X.

| Qué | Para qué |
|---|---|
| `calendario.json` | La lista de publicaciones: día, hora, redes, textos e imagen. |
| `material/` | Las imágenes y vídeos que se van a publicar. |
| `estado.md` | El resultado de la última ejecución del publicador. |
| `bitacora.md` | Lo que probamos cada semana, qué pasó y qué aprendemos. |
| `publicar.mjs` | El publicador. |
| `.github/workflows/publicar.yml` | Cuándo se ejecuta el publicador. |

## Cómo funciona

1. Claude prepara las publicaciones de la semana en `calendario.json`.
2. Julia las revisa. Solo se publican las que llevan `"aprobado": true`.
3. El publicador:
   - **Instagram y Facebook**: los publica a su hora con la API de Meta.
   - **LinkedIn y X**: los programa en Buffer hasta 2 días antes, y Buffer los publica a su hora.
4. Después apunta en el calendario el enlace de lo publicado, o el error.

Las imágenes no necesitan estar en internet: el publicador las sube a la página
de Facebook sin publicarlas y usa esa copia para Instagram y Buffer.

## Lanzarlo a mano

Actions → **Publicar redes** → **Run workflow** → elegir:

- `comprobar`: dice a qué cuentas llegan las claves.
- `prueba`: dice lo que haría ahora, sin publicar nada.
- `publicar`: publica lo que toca.

## Las claves

Las claves de Meta y de Buffer **no** están en ningún archivo: se guardan en
Settings → Secrets and variables → Actions (`META_PAGE_TOKEN` y `BUFFER_API_KEY`),
y nadie puede leerlas.
