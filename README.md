# Redes de Vees Comunicación

Aquí vive el sistema que publica en Instagram, Facebook, LinkedIn y X.

| Qué | Para qué |
|---|---|
| `calendario.json` | La lista de publicaciones: día, hora, redes, textos e imagen. |
| `material/` | Las imágenes y vídeos que se van a publicar. |
| `bitacora.md` | Lo que probamos cada semana, qué pasó y qué aprendemos. |
| `publicar.mjs` | El publicador (llegará más adelante). |
| `.github/workflows/` | Las horas a las que se ejecuta el publicador (llegará más adelante). |

Las claves de Meta y de Buffer **no** están en ningún archivo: se guardan en
Settings → Secrets and variables → Actions, y nadie puede leerlas.
