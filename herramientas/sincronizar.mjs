// Sincroniza la herramienta «Plan semanal Vees» con el publicador.
//
// Solo pasa al calendario las publicaciones que Julia ha APROBADO en la herramienta, y solo si el
// texto y la imagen siguen siendo exactamente los que aprobó. Después devuelve a la herramienta el
// estado de cada publicación (enviada, programada, publicada o con error).
//
// Uso:
//   node herramientas/sincronizar.mjs necesita <carpeta-db>
//       Lista (una por línea) los ids de las imágenes que hay que descargar antes de aplicar.
//   node herramientas/sincronizar.mjs aplicar <carpeta-db> <carpeta-imagenes> [salida.json]
//       Actualiza calendario.json y material/, y escribe en salida.json los cambios para la base de datos.
//
// <carpeta-db> contiene publicaciones/*.json e imagenes/*.json (una por documento de la base de datos).
// <carpeta-imagenes> contiene las imágenes descargadas, cada una con su id como nombre (id.jpg).

import { readFileSync, writeFileSync, readdirSync, existsSync, copyFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const AVISO_HISTORIA = 'Más información en el enlace de nuestra bio';
const RETRASO_MAX = 24 * 3600_000;
const CAMPO_TEXTO = { instagram: 'texto', facebook: 'texto_facebook', linkedin: 'texto_linkedin', x: 'texto_x' };

function leerColeccion(dir, nombre) {
  const carpeta = join(dir, nombre);
  if (!existsSync(carpeta)) return [];
  return readdirSync(carpeta)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      let d = JSON.parse(readFileSync(join(carpeta, f), 'utf8'));
      // Acepta tanto el documento tal cual como envuelto en { id, version, data }
      if (d && typeof d.data === 'object' && d.data !== null && ('version' in d || 'id' in d)) d = { ...d.data, _version: d.version };
      return { ...d, _id: f.replace(/\.json$/, '') };
    });
}

function cargar(dirDb) {
  const publicaciones = leerColeccion(dirDb, 'publicaciones');
  const imagenes = Object.fromEntries(leerColeccion(dirDb, 'imagenes').map((i) => [i._id, i]));
  return { publicaciones, imagenes };
}

// Por qué una publicación aprobada NO se puede enviar (o null si se puede)
function bloqueo(p, imagenes) {
  if (p.estado !== 'aprobado') return 'no está aprobada';
  if (!CAMPO_TEXTO[p.red]) return `red desconocida: ${p.red}`;
  if (!p.cuando || Number.isNaN(Date.parse(p.cuando))) return 'fecha no válida';
  if ((p.aprobado_texto ?? null) !== (p.texto ?? null)) return 'el texto cambió después de aprobarla: hay que volver a aprobarla';
  if (p.imagen) {
    const img = imagenes[p.imagen];
    if (!img?.asset_id) return 'falta subir la imagen';
    if (p.aprobado_imagen !== img.asset_id) return 'la imagen cambió después de aprobarla: hay que volver a aprobarla';
    if (p.formato === 'historia' && !img.frase) return 'falta la frase de la imagen para la historia';
  } else if (p.red === 'instagram') {
    return 'Instagram necesita imagen';
  }
  return null;
}

function necesita(dirDb) {
  const { publicaciones, imagenes } = cargar(dirDb);
  const cal = JSON.parse(readFileSync('calendario.json', 'utf8'));
  const ids = new Set();
  for (const p of publicaciones) {
    if (cal.some((e) => e.id === p._id)) continue;
    if (bloqueo(p, imagenes)) continue;
    if (p.imagen) ids.add(imagenes[p.imagen].asset_id);
  }
  for (const id of ids) console.log(id);
}

function resultadoDesde(entrada, red) {
  const r = entrada[red];
  if (!r) return { estado: 'enviado', detalle: 'En el publicador, esperando su hora' };
  if (r.publicado) return { estado: 'publicado', enlace: r.enlace || null, fecha: r.publicado };
  if (r.programado) return { estado: 'programado', detalle: 'Programado en Buffer', fecha: r.programado };
  if (r.error) return { estado: 'error', detalle: r.revisar ? `${r.error} (${r.revisar})` : r.error, intentos: r.intentos || 0 };
  return { estado: 'enviado' };
}

const igual = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

function aplicar(dirDb, dirImg, salida = 'actualizaciones.json') {
  const { publicaciones, imagenes } = cargar(dirDb);
  const cal = JSON.parse(readFileSync('calendario.json', 'utf8'));
  const actualizaciones = [];
  const informe = [];
  const ahora = Date.now();
  mkdirSync('material', { recursive: true });

  const archivoImagen = (assetId) => {
    if (!existsSync(dirImg)) return null;
    const f = readdirSync(dirImg).find((n) => n.startsWith(assetId));
    return f ? join(dirImg, f) : null;
  };

  for (const p of publicaciones) {
    const i = cal.findIndex((e) => e.id === p._id);
    const entrada = i >= 0 ? cal[i] : null;

    // 1. Ya está en el calendario
    if (entrada) {
      const r = entrada[p.red];
      const sinSalir = !r?.publicado && !r?.programado;
      if (p.estado !== 'aprobado' && sinSalir) {
        // Julia ha retirado la aprobación antes de que saliera: se quita del calendario
        cal.splice(i, 1);
        informe.push(`- ↩️ ${p._id}: retirada del calendario (ya no está aprobada)`);
        actualizaciones.push({ doc_id: p._id, campos: { sincronizado: false, resultado: { estado: 'retirada', detalle: 'Retirada del publicador' } } });
        continue;
      }
      const cambiada =
        p.estado === 'aprobado' &&
        sinSalir &&
        ((entrada[CAMPO_TEXTO[p.red]] ?? null) !== (p.aprobado_texto ?? null) ||
          (entrada.asset_id ?? null) !== (p.aprobado_imagen ?? null) ||
          entrada.cuando !== p.cuando);
      if (!cambiada) {
        const res = resultadoDesde(entrada, p.red);
        if (!igual(res, p.resultado)) actualizaciones.push({ doc_id: p._id, campos: { sincronizado: true, resultado: res } });
        continue;
      }
      // La reaprobó con otro texto, otra imagen u otra hora antes de salir: se sustituye
      cal.splice(i, 1);
      informe.push(`- 🔁 ${p._id}: actualizada en el calendario`);
    }

    // 2. No está en el calendario
    if (p.estado !== 'aprobado') continue;
    const motivo = bloqueo(p, imagenes);
    if (motivo) {
      const res = { estado: 'bloqueada', detalle: motivo };
      if (!igual(res, p.resultado)) actualizaciones.push({ doc_id: p._id, campos: { resultado: res } });
      informe.push(`- ⚠️ ${p._id}: ${motivo}`);
      continue;
    }
    if (ahora - Date.parse(p.cuando) > RETRASO_MAX) {
      const res = { estado: 'caducada', detalle: 'Se aprobó cuando ya habían pasado más de 24 horas desde su hora' };
      if (!igual(res, p.resultado)) actualizaciones.push({ doc_id: p._id, campos: { resultado: res } });
      informe.push(`- ⏹️ ${p._id}: caducada`);
      continue;
    }

    const nueva = {
      id: p._id,
      cuando: p.cuando,
      redes: [p.red],
      aprobado: true,
      aprobado_por: p.revisado_por || null,
      aprobado_en: p.revisado_en || null,
      origen: 'plan-semanal',
      formato: p.formato || 'foto',
      tema: p.tema || null,
      objetivo: p.objetivo || null,
    };
    if (p.aprobado_texto) nueva[CAMPO_TEXTO[p.red]] = p.aprobado_texto;
    nueva.asset_id = p.aprobado_imagen ?? null;

    if (p.imagen) {
      const img = imagenes[p.imagen];
      const origen = archivoImagen(img.asset_id);
      if (!origen) {
        informe.push(`- ⚠️ ${p._id}: no se descargó la imagen ${img.asset_id}`);
        continue;
      }
      if (!/\.jpe?g$/i.test(origen)) {
        const res = { estado: 'bloqueada', detalle: 'La imagen tiene que ser JPG (descárgala de la plantilla)' };
        if (!igual(res, p.resultado)) actualizaciones.push({ doc_id: p._id, campos: { resultado: res } });
        informe.push(`- ⚠️ ${p._id}: la imagen no es JPG`);
        continue;
      }
      const feed = join('material', `${p.imagen}.jpg`);
      copyFileSync(origen, feed);
      if (p.formato === 'historia') {
        const historia = join('material', `${p.imagen}-historia.jpg`);
        execFileSync('python3', ['herramientas/historia.py', feed, img.frase, p.aviso_historia || AVISO_HISTORIA, historia], { stdio: 'inherit' });
        nueva.imagen = historia;
      } else {
        nueva.imagen = feed;
      }
    }

    cal.push(nueva);
    informe.push(`- ✅ ${p._id}: enviada al publicador (${p.red}, ${p.cuando})`);
    actualizaciones.push({ doc_id: p._id, campos: { sincronizado: true, resultado: resultadoDesde(nueva, p.red) } });
  }

  cal.sort((a, b) => Date.parse(a.cuando) - Date.parse(b.cuando));
  writeFileSync('calendario.json', JSON.stringify(cal, null, 2) + '\n');
  writeFileSync(salida, JSON.stringify(actualizaciones, null, 2) + '\n');
  console.log(informe.length ? informe.join('\n') : 'Nada que sincronizar.');
  console.log(`${actualizaciones.length} cambios para la base de datos en ${salida}`);
}

const [modo, a, b, c] = process.argv.slice(2);
if (modo === 'necesita' && a) necesita(a);
else if (modo === 'aplicar' && a && b) aplicar(a, b, c);
else {
  console.error('Uso: node herramientas/sincronizar.mjs necesita <carpeta-db> | aplicar <carpeta-db> <carpeta-imagenes> [salida.json]');
  process.exit(2);
}
