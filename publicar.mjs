// Publicador de redes de Vees Comunicación
//
// Uso:  node publicar.mjs comprobar | prueba | publicar
//
//   comprobar  Dice a qué página e Instagram llega la clave de Meta y qué canales hay en Buffer.
//   prueba     Dice lo que haría ahora mismo, sin publicar nada.
//   publicar   Publica lo que toca:
//                - Instagram y Facebook (API de Meta): cuando llega su hora, con hasta 24 h de retraso.
//                - LinkedIn y X (Buffer): se programan en Buffer hasta 48 h antes; Buffer publica a su hora.
//
// Solo se publican las entradas con "aprobado": true.
// Las claves llegan como variables de entorno (META_PAGE_TOKEN y BUFFER_API_KEY) y nunca se escriben en ningún archivo.
// Node 22, sin dependencias.

import { readFile, writeFile, stat } from 'node:fs/promises';
import { existsSync, openAsBlob } from 'node:fs';
import { basename, extname } from 'node:path';
import { pathToFileURL } from 'node:url';

const VERSION_META = 'v23.0';
const GRAPH = `https://graph.facebook.com/${VERSION_META}`;
const GRAPH_VIDEO = `https://graph-video.facebook.com/${VERSION_META}`;
const BUFFER_URLS = ['https://api.buffer.com', 'https://api.buffer.com/graphql'];

const CALENDARIO = 'calendario.json';
const ESTADO = 'estado.md';

const HORA = 3600_000;
const RETRASO_MAX = 24 * HORA; // publicar como mucho 24 h tarde
const ANTELACION_BUFFER = 48 * HORA; // programar en Buffer como mucho 2 días antes
const MAX_INTENTOS = 3;

const REDES_META = ['instagram', 'facebook'];
const REDES_BUFFER = ['linkedin', 'x'];
const REDES = [...REDES_META, ...REDES_BUFFER];
const NOMBRE_RED = { instagram: 'Instagram', facebook: 'Facebook', linkedin: 'LinkedIn', x: 'X' };

const MAX_IMAGEN_IG = 8 * 1024 * 1024;

let META_TOKEN = '';
let BUFFER_KEY = '';
let cal = [];

// ---------------------------------------------------------------- utilidades

class ErrorRed extends Error {
  // definitivo = sabemos seguro que NO se ha publicado (se puede reintentar sin riesgo de duplicar)
  constructor(mensaje, { definitivo = true } = {}) {
    super(mensaje);
    this.definitivo = definitivo;
  }
}

function limpiar(texto) {
  let s = String(texto ?? '');
  for (const secreto of [META_TOKEN, BUFFER_KEY]) {
    if (secreto && secreto.length > 8) s = s.split(secreto).join('***');
  }
  return s;
}

const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
const esUrl = (s) => /^https?:\/\//i.test(String(s));
const ahoraISO = () => new Date().toISOString();

function horaMadrid(fecha) {
  return new Date(fecha).toLocaleString('es-ES', {
    timeZone: 'Europe/Madrid',
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function duracion(ms) {
  const h = Math.round(Math.abs(ms) / HORA);
  if (h < 1) return `${Math.max(1, Math.round(Math.abs(ms) / 60_000))} min`;
  if (h < 48) return `${h} h`;
  return `${Math.round(h / 24)} días`;
}

function tipoArchivo(ruta) {
  const ext = extname(ruta).toLowerCase();
  return { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.mp4': 'video/mp4', '.mov': 'video/quicktime' }[ext] || 'application/octet-stream';
}

function rutasMedia(e) {
  if (e.video) return [e.video];
  if (Array.isArray(e.imagenes) && e.imagenes.length) return e.imagenes;
  if (e.imagen) return [e.imagen];
  return [];
}

function tipoMedia(e) {
  if (e.video) return 'video';
  const n = rutasMedia(e).length;
  if (n > 1) return 'carrusel';
  if (n === 1) return 'foto';
  return 'texto';
}

const esHistoria = (e) => String(e.formato || '').toLowerCase() === 'historia';

function textoPara(red, e) {
  if (red === 'facebook') return e.texto_facebook || e.texto || '';
  if (red === 'linkedin') return e.texto_linkedin || e.texto || '';
  if (red === 'x') return e.texto_x || e.texto || '';
  return e.texto || '';
}

// X cuenta los enlaces como 23 caracteres y los emojis como 2 (aproximación)
function largoX(texto) {
  const sinEnlaces = String(texto).replace(/https?:\/\/\S+/g, 'x'.repeat(23));
  let n = 0;
  for (const ch of sinEnlaces) n += ch.codePointAt(0) > 0x2fff ? 2 : 1;
  return n;
}

async function leerCalendario() {
  const texto = await readFile(CALENDARIO, 'utf8');
  const datos = JSON.parse(texto);
  if (!Array.isArray(datos)) throw new Error('calendario.json tiene que ser una lista: [ ... ]');
  return datos;
}

async function guardar() {
  await writeFile(CALENDARIO, JSON.stringify(cal, null, 2) + '\n');
}

// ---------------------------------------------------------------- comprobaciones de cada entrada

// Devuelve una lista de avisos { red, texto }. red = null significa que afecta a todas las redes.
async function validar(e) {
  const avisos = [];
  const aviso = (texto, red = null) => avisos.push({ red, texto });
  const redes = Array.isArray(e.redes) ? e.redes : [];

  if (!e.id) aviso('le falta el "id"');
  if (!e.cuando || Number.isNaN(Date.parse(e.cuando))) aviso('el "cuando" no es una fecha válida');
  if (!redes.length) aviso('no dice en qué "redes" sale');
  for (const red of redes) if (!REDES.includes(red)) aviso(`red desconocida: "${red}"`);

  if (esHistoria(e)) {
    for (const red of redes) if (red !== 'instagram') aviso(`de momento las historias solo se publican en Instagram, no en ${NOMBRE_RED[red] || red}`, red);
    if (rutasMedia(e).length !== 1) aviso('una historia lleva exactamente una imagen o un vídeo', 'instagram');
  }
  for (const red of redes) {
    if (!REDES.includes(red)) continue;
    if (!textoPara(red, e).trim() && !(red === 'instagram' && rutasMedia(e).length)) aviso(`falta el texto de ${NOMBRE_RED[red]}`, red);
  }
  if (redes.includes('x') && largoX(textoPara('x', e)) > 280) aviso(`el texto de X pasa de 280 caracteres (${largoX(textoPara('x', e))})`, 'x');
  if (redes.includes('instagram')) {
    if (!rutasMedia(e).length) aviso('Instagram necesita una imagen o un vídeo', 'instagram');
    if ((e.texto || '').length > 2200) aviso('el texto de Instagram pasa de 2.200 caracteres', 'instagram');
    if (((e.texto || '').match(/#[\p{L}\p{N}_]+/gu) || []).length > 30) aviso('el texto de Instagram tiene más de 30 hashtags', 'instagram');
  }
  if (Array.isArray(e.imagenes) && e.imagenes.length > 10) aviso('un carrusel admite como mucho 10 imágenes');

  for (const ruta of rutasMedia(e)) {
    if (esUrl(ruta)) continue;
    if (!existsSync(ruta)) {
      aviso(`no encuentro el archivo ${ruta}`);
      continue;
    }
    const { size } = await stat(ruta);
    const tipo = tipoArchivo(ruta);
    if (tipo === 'image/jpeg' && size > MAX_IMAGEN_IG) aviso(`${ruta} pesa más de 8 MB`, 'instagram');
    if (tipo.startsWith('image/') && tipo !== 'image/jpeg' && redes.includes('instagram')) aviso(`${ruta}: Instagram solo admite JPG`, 'instagram');
  }
  return avisos;
}

const avisosDe = (avisos, red) => avisos.filter((a) => a.red === null || a.red === red).map((a) => a.texto);
const textosAvisos = (avisos) => avisos.map((a) => (a.red ? `${NOMBRE_RED[a.red]}: ${a.texto}` : a.texto));

// ---------------------------------------------------------------- API de Meta (Instagram y Facebook)

async function graph(metodo, ruta, params = {}, { base = GRAPH, form = null } = {}) {
  const url = new URL(base + ruta);
  let body;
  if (metodo === 'GET') {
    url.searchParams.set('access_token', META_TOKEN);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  } else if (form) {
    form.set('access_token', META_TOKEN);
    body = form;
  } else {
    body = new URLSearchParams({ access_token: META_TOKEN });
    for (const [k, v] of Object.entries(params)) body.set(k, String(v));
  }
  let res;
  try {
    res = await fetch(url, { method: metodo, body });
  } catch (err) {
    throw new ErrorRed(`Meta no responde (${err.message})`, { definitivo: false });
  }
  const texto = await res.text();
  let datos = null;
  try {
    datos = JSON.parse(texto);
  } catch {}
  if (!res.ok || datos?.error) {
    const m = datos?.error?.error_user_msg || datos?.error?.message || texto.slice(0, 300);
    throw new ErrorRed(limpiar(`Meta: ${m}`), { definitivo: res.status >= 400 && res.status < 500 });
  }
  return datos;
}

let idsCache = null;
async function idsMeta() {
  if (idsCache) return idsCache;
  const yo = await graph('GET', '/me', { fields: 'id,name,instagram_business_account{id,username}' });
  idsCache = {
    pagina: yo.id,
    nombrePagina: yo.name,
    ig: yo.instagram_business_account?.id || null,
    igUsuario: yo.instagram_business_account?.username || null,
  };
  return idsCache;
}

// Sube la imagen a la página de Facebook SIN publicarla. Así no hace falta ningún enlace público:
// con esa copia Facebook nos da un enlace para Instagram y Buffer, y la misma foto sirve para el post de Facebook.
async function fotoMeta(e, ruta) {
  e._fotos_meta ??= {};
  if (e._fotos_meta[ruta]) return e._fotos_meta[ruta];
  const { pagina } = await idsMeta();
  let r;
  if (esUrl(ruta)) {
    r = await graph('POST', `/${pagina}/photos`, { url: ruta, published: 'false' });
  } else {
    const form = new FormData();
    form.set('published', 'false');
    form.set('source', await openAsBlob(ruta, { type: tipoArchivo(ruta) }), basename(ruta));
    r = await graph('POST', `/${pagina}/photos`, {}, { form });
  }
  e._fotos_meta[ruta] = r.id;
  await guardar();
  return r.id;
}

async function urlPublica(e, ruta) {
  if (esUrl(ruta)) return ruta;
  const id = await fotoMeta(e, ruta);
  const foto = await graph('GET', `/${id}`, { fields: 'images' });
  const mayor = [...(foto.images || [])].sort((a, b) => (b.width || 0) - (a.width || 0))[0];
  if (!mayor?.source) throw new ErrorRed('Facebook no devolvió el enlace de la imagen.');
  return mayor.source;
}

// Sube el vídeo a la página de Facebook SIN publicarlo y devuelve su enlace (para Instagram).
async function videoPublico(e, ruta) {
  e._videos_meta ??= {};
  const { pagina } = await idsMeta();
  let id = e._videos_meta[ruta];
  if (!id) {
    const form = new FormData();
    form.set('published', 'false');
    form.set('source', await openAsBlob(ruta, { type: tipoArchivo(ruta) }), basename(ruta));
    id = (await graph('POST', `/${pagina}/videos`, {}, { base: GRAPH_VIDEO, form })).id;
    e._videos_meta[ruta] = id;
    await guardar();
  }
  const fin = Date.now() + 10 * 60_000;
  for (;;) {
    const v = await graph('GET', `/${id}`, { fields: 'source,status' });
    const listo = v.status?.video_status === 'ready' || v.status?.processing_progress === 100;
    if (v.source && listo) return v.source;
    if (v.status?.video_status === 'error') throw new ErrorRed('Facebook no pudo procesar el vídeo.');
    if (Date.now() > fin) throw new ErrorRed('Facebook tardó demasiado en procesar el vídeo.');
    await esperar(10_000);
  }
}

async function esperarContenedor(id, maxMs, cadaMs) {
  const fin = Date.now() + maxMs;
  for (;;) {
    const r = await graph('GET', `/${id}`, { fields: 'status_code,status' });
    if (r.status_code === 'FINISHED' || r.status_code === 'PUBLISHED') return;
    if (r.status_code === 'ERROR' || r.status_code === 'EXPIRED') {
      throw new ErrorRed(`Instagram no pudo procesar el archivo (${r.status || r.status_code}).`);
    }
    if (Date.now() > fin) throw new ErrorRed('Instagram tardó demasiado en procesar el archivo.');
    await esperar(cadaMs);
  }
}

async function publicarInstagram(e) {
  const { ig } = await idsMeta();
  if (!ig) throw new ErrorRed('Instagram no está vinculado a la página de Facebook.');
  const caption = e.texto || '';
  const tipo = tipoMedia(e);
  let contenedor;

  if (esHistoria(e)) {
    // Historia: sin texto (Instagram no lo admite por la API) y sin pegatinas
    if (tipo === 'foto') {
      const image_url = await urlPublica(e, rutasMedia(e)[0]);
      contenedor = (await graph('POST', `/${ig}/media`, { media_type: 'STORIES', image_url })).id;
      await esperarContenedor(contenedor, 2 * 60_000, 5_000);
    } else if (tipo === 'video' && esUrl(e.video)) {
      contenedor = (await graph('POST', `/${ig}/media`, { media_type: 'STORIES', video_url: e.video })).id;
      await esperarContenedor(contenedor, 10 * 60_000, 10_000);
    } else {
      throw new ErrorRed('Una historia necesita una sola imagen (o un vídeo con enlace público).');
    }
  } else if (tipo === 'foto') {
    const image_url = await urlPublica(e, rutasMedia(e)[0]);
    contenedor = (await graph('POST', `/${ig}/media`, { image_url, caption })).id;
    await esperarContenedor(contenedor, 2 * 60_000, 5_000);
  } else if (tipo === 'carrusel') {
    const hijos = [];
    for (const ruta of rutasMedia(e)) {
      const image_url = await urlPublica(e, ruta);
      hijos.push((await graph('POST', `/${ig}/media`, { image_url, is_carousel_item: 'true' })).id);
    }
    for (const h of hijos) await esperarContenedor(h, 2 * 60_000, 5_000);
    contenedor = (await graph('POST', `/${ig}/media`, { media_type: 'CAROUSEL', children: hijos.join(','), caption })).id;
    await esperarContenedor(contenedor, 2 * 60_000, 5_000);
  } else if (tipo === 'video') {
    const ruta = e.video;
    // Música de la biblioteca de Instagram (audio_id de musica.md)
    const extra = e.audio_id ? { audio_configuration: JSON.stringify({ audio_id: String(e.audio_id), audio_volume: 100, video_volume: 1 }) } : {};
    if (esUrl(ruta) || e.audio_id) {
      // Con música, Instagram recoge el vídeo desde un enlace (la vía que documenta su Audio API).
      // Si el vídeo es un archivo, se sube antes a la página de Facebook sin publicar para tener ese enlace.
      const video_url = esUrl(ruta) ? ruta : await videoPublico(e, ruta);
      contenedor = (await graph('POST', `/${ig}/media`, { media_type: 'REELS', video_url, caption, share_to_feed: 'true', ...extra })).id;
    } else {
      // Subida directa del vídeo (sin enlace público)
      const r = await graph('POST', `/${ig}/media`, { media_type: 'REELS', upload_type: 'resumable', caption, share_to_feed: 'true', ...extra });
      contenedor = r.id;
      const datos = await readFile(ruta);
      let res;
      try {
        res = await fetch(r.uri || `https://rupload.facebook.com/ig-api-upload/${VERSION_META}/${r.id}`, {
          method: 'POST',
          headers: { Authorization: `OAuth ${META_TOKEN}`, offset: '0', file_size: String(datos.length) },
          body: datos,
        });
      } catch (err) {
        throw new ErrorRed(`No se pudo subir el vídeo a Instagram (${err.message})`);
      }
      if (!res.ok) throw new ErrorRed(limpiar(`Instagram no aceptó el vídeo: ${(await res.text()).slice(0, 300)}`));
    }
    await esperarContenedor(contenedor, 10 * 60_000, 10_000);
  } else {
    throw new ErrorRed('Instagram necesita una imagen o un vídeo.');
  }

  const pub = await graph('POST', `/${ig}/media_publish`, { creation_id: contenedor });
  let enlace = null;
  try {
    enlace = (await graph('GET', `/${pub.id}`, { fields: 'permalink' })).permalink || null;
  } catch {}
  return { id: pub.id, enlace };
}

async function publicarFacebook(e) {
  const { pagina } = await idsMeta();
  const message = textoPara('facebook', e);
  const tipo = tipoMedia(e);
  let id;

  if (tipo === 'foto' || tipo === 'carrusel') {
    const params = { message };
    const rutas = rutasMedia(e);
    for (let i = 0; i < rutas.length; i++) params[`attached_media[${i}]`] = JSON.stringify({ media_fbid: await fotoMeta(e, rutas[i]) });
    id = (await graph('POST', `/${pagina}/feed`, params)).id;
  } else if (tipo === 'video') {
    if (esUrl(e.video)) {
      id = (await graph('POST', `/${pagina}/videos`, { file_url: e.video, description: message })).id;
    } else {
      const form = new FormData();
      form.set('description', message);
      form.set('source', await openAsBlob(e.video, { type: tipoArchivo(e.video) }), basename(e.video));
      id = (await graph('POST', `/${pagina}/videos`, {}, { base: GRAPH_VIDEO, form })).id;
    }
  } else {
    const params = { message };
    if (e.enlace_web) params.link = e.enlace_web;
    id = (await graph('POST', `/${pagina}/feed`, params)).id;
  }

  let enlace = null;
  try {
    const p = (await graph('GET', `/${id}`, { fields: 'permalink_url' })).permalink_url || null;
    enlace = p && !esUrl(p) ? `https://www.facebook.com${p}` : p;
  } catch {}
  return { id, enlace };
}

// Antes de reintentar, mira si en realidad ya salió (para no publicar dos veces)
async function yaPublicadoEnMeta(red, e) {
  const desde = Date.parse(e.cuando) - HORA;
  const inicio = (s) => String(s || '').trim().slice(0, 60);
  if (red === 'instagram' && esHistoria(e)) {
    // Las historias no tienen texto: se busca una historia creada desde el primer intento
    const { ig } = await idsMeta();
    const desdeIntento = Date.parse(e.instagram?.primer_intento || e.instagram?.ultimo_intento || e.cuando) - 5 * 60_000;
    const r = await graph('GET', `/${ig}/stories`, { fields: 'id,permalink,timestamp' });
    const m = (r.data || []).find((x) => Date.parse(x.timestamp) >= desdeIntento);
    return m ? { id: m.id, enlace: m.permalink || null } : null;
  }
  if (red === 'instagram') {
    const { ig } = await idsMeta();
    const r = await graph('GET', `/${ig}/media`, { fields: 'id,caption,permalink,timestamp', limit: '15' });
    const m = (r.data || []).find((x) => Date.parse(x.timestamp) >= desde && inicio(x.caption) === inicio(e.texto));
    return m ? { id: m.id, enlace: m.permalink } : null;
  }
  const { pagina } = await idsMeta();
  const r = await graph('GET', `/${pagina}/posts`, { fields: 'id,message,permalink_url,created_time', limit: '15' });
  const m = (r.data || []).find((x) => Date.parse(x.created_time) >= desde && inicio(x.message) === inicio(textoPara('facebook', e)));
  return m ? { id: m.id, enlace: m.permalink_url } : null;
}

// ---------------------------------------------------------------- Buffer (LinkedIn y X)

async function buffer(query, variables) {
  for (const url of BUFFER_URLS) {
    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${BUFFER_KEY}` },
        body: JSON.stringify({ query, variables }),
      });
    } catch (err) {
      throw new ErrorRed(`Buffer no responde (${err.message})`, { definitivo: false });
    }
    if (res.status === 404 && url !== BUFFER_URLS.at(-1)) continue;
    const texto = await res.text();
    let datos = null;
    try {
      datos = JSON.parse(texto);
    } catch {}
    if (!res.ok || datos?.errors?.length) {
      const m = datos?.errors?.map((x) => x.message).join('; ') || `HTTP ${res.status} ${texto.slice(0, 200)}`;
      const definitivo = Boolean(datos?.errors?.length) || (res.status >= 400 && res.status < 500);
      throw new ErrorRed(limpiar(`Buffer: ${m}`), { definitivo });
    }
    return datos?.data || {};
  }
}

let canalesCache = null;
async function canalesBuffer() {
  if (canalesCache) return canalesCache;
  const d = await buffer('query { account { organizations { id name } } }');
  const organizaciones = d.account?.organizations || [];
  const canales = [];
  for (const o of organizaciones) {
    const c = await buffer('query ($input: ChannelsInput!) { channels(input: $input) { id name service } }', {
      input: { organizationId: o.id },
    });
    for (const ch of c.channels || []) canales.push({ ...ch, organizacion: o.name });
  }
  canalesCache = { organizaciones, canales };
  return canalesCache;
}

function canalPara(red, canales) {
  const servicios = red === 'x' ? ['twitter', 'x'] : ['linkedin'];
  return canales.find((c) => servicios.includes(String(c.service || '').toLowerCase()));
}

async function programarEnBuffer(red, e) {
  const { canales } = await canalesBuffer();
  const canal = canalPara(red, canales);
  if (!canal) throw new ErrorRed(`No hay ningún canal de ${NOMBRE_RED[red]} conectado en Buffer.`);

  const text = textoPara(red, e);
  if (red === 'x' && largoX(text) > 280) throw new ErrorRed(`El texto de X pasa de 280 caracteres (${largoX(text)}).`);

  const ahora = Date.now();
  const hora = Math.max(Date.parse(e.cuando), ahora + 5 * 60_000);
  const input = {
    channelId: canal.id,
    text,
    schedulingType: 'automatic',
    mode: 'customScheduled',
    dueAt: new Date(hora).toISOString(),
  };

  if (e.video) {
    if (!esUrl(e.video)) throw new ErrorRed('Para LinkedIn y X, de momento el vídeo necesita un enlace público.');
    input.assets = [{ video: { url: e.video } }];
  } else {
    const rutas = rutasMedia(e).slice(0, red === 'x' ? 4 : 10);
    if (rutas.length) {
      input.assets = [];
      for (const ruta of rutas) input.assets.push({ image: { url: await urlPublica(e, ruta) } });
    }
  }

  const d = await buffer(
    'mutation ($input: CreatePostInput!) { createPost(input: $input) { __typename ... on PostActionSuccess { post { id dueAt } } ... on MutationError { message } } }',
    { input },
  );
  const r = d.createPost;
  if (r?.__typename !== 'PostActionSuccess') throw new ErrorRed(limpiar(`Buffer no aceptó la publicación: ${r?.message || r?.__typename || 'sin respuesta'}`));
  return { id: r.post?.id || null, programado: r.post?.dueAt || input.dueAt, canal: canal.name };
}

// ---------------------------------------------------------------- decidir qué toca

// Devuelve qué hay que hacer con una red de una entrada ahora mismo
function queToca(e, red, ahora) {
  const r = e[red];
  if (!e.aprobado) return { accion: 'esperar', motivo: 'sin aprobar' };
  if (r?.publicado) return { accion: 'nada', motivo: `publicado ${r.enlace || ''}`.trim() };
  if (r?.programado) return { accion: 'nada', motivo: `programado en Buffer para ${horaMadrid(r.programado)}` };
  if (r?.revisar) return { accion: 'nada', motivo: `revisar a mano: ${r.revisar}` };
  if ((r?.intentos || 0) >= MAX_INTENTOS) return { accion: 'nada', motivo: `sin más intentos: ${r.error || ''}`.trim() };

  const t = Date.parse(e.cuando);
  if (Number.isNaN(t)) return { accion: 'nada', motivo: 'fecha no válida' };
  if (ahora - t > RETRASO_MAX) return { accion: 'caducar', motivo: 'pasaron más de 24 h' };

  if (REDES_META.includes(red)) {
    if (!META_TOKEN) return { accion: 'esperar', motivo: 'falta la clave de Meta' };
    if (ahora < t) return { accion: 'esperar', motivo: `faltan ${duracion(t - ahora)}` };
    return { accion: 'publicar', motivo: 'ya es la hora' };
  }

  if (!BUFFER_KEY) return { accion: 'esperar', motivo: 'falta la clave de Buffer' };
  if (t - ahora > ANTELACION_BUFFER) return { accion: 'esperar', motivo: `se programa en Buffer 2 días antes (faltan ${duracion(t - ahora)})` };
  if (rutasMedia(e).some((x) => !esUrl(x)) && !e.video && !META_TOKEN) {
    return { accion: 'esperar', motivo: 'falta la clave de Meta para preparar la imagen' };
  }
  return { accion: 'programar', motivo: `programar para ${horaMadrid(Math.max(t, ahora))}` };
}

// ---------------------------------------------------------------- modos

async function comprobar() {
  const l = ['# Estado del publicador', '', `Comprobación: ${horaMadrid(Date.now())} (hora de Madrid)`, ''];

  l.push('## Meta (Instagram y Facebook)', '');
  if (!META_TOKEN) {
    l.push('- ⬜ Falta la clave `META_PAGE_TOKEN` (pendiente).');
  } else {
    try {
      const ids = await idsMeta();
      l.push(`- ✅ Página de Facebook: **${ids.nombrePagina}**`);
      l.push(ids.ig ? `- ✅ Instagram: **@${ids.igUsuario}**` : '- ⚠️ Instagram no está vinculado a la página de Facebook.');
      try {
        await graph('GET', `/${ids.pagina}/posts`, { fields: 'id', limit: '1' });
        l.push('- ✅ Puede leer las publicaciones de la página.');
      } catch (err) {
        l.push(`- ⚠️ No puede leer las publicaciones de la página: ${limpiar(err.message)}`);
      }
      if (ids.ig) {
        try {
          const r = await graph('GET', `/${ids.ig}`, { fields: 'media_count,followers_count' });
          l.push(`- ✅ Puede leer Instagram (${r.media_count ?? '?'} publicaciones, ${r.followers_count ?? '?'} seguidores).`);
        } catch (err) {
          l.push(`- ⚠️ No puede leer Instagram: ${limpiar(err.message)}`);
        }
      }
    } catch (err) {
      l.push(`- ❌ ${limpiar(err.message)}`);
    }
  }
  l.push('');

  l.push('## Buffer (LinkedIn y X)', '');
  if (!BUFFER_KEY) {
    l.push('- ⬜ Falta la clave `BUFFER_API_KEY` (pendiente).');
  } else {
    try {
      const { organizaciones, canales } = await canalesBuffer();
      l.push(`- ✅ La clave funciona. Organización: **${organizaciones.map((o) => o.name).join(', ') || '(ninguna)'}**`);
      for (const c of canales) l.push(`- Canal: ${c.service} — ${c.name}`);
      for (const red of REDES_BUFFER) {
        l.push(canalPara(red, canales) ? `- ✅ ${NOMBRE_RED[red]} conectado` : `- ⚠️ ${NOMBRE_RED[red]} no está conectado en Buffer`);
      }
    } catch (err) {
      l.push(`- ❌ ${limpiar(err.message)}`);
    }
  }
  l.push('');

  l.push('## Calendario', '');
  const aprobadas = cal.filter((e) => e.aprobado).length;
  l.push(`- ${cal.length} publicaciones (${aprobadas} aprobadas, ${cal.length - aprobadas} sin aprobar).`);
  for (const e of cal) {
    const avisos = textosAvisos(await validar(e));
    if (avisos.length) l.push(`- ⚠️ ${e.id || '(sin id)'}: ${avisos.join('; ')}`);
  }
  l.push('');
  return { lineas: l, errores: 0 };
}

async function prueba() {
  const ahora = Date.now();
  const l = ['# Estado del publicador (prueba)', '', `Prueba: ${horaMadrid(ahora)} (hora de Madrid). No se ha publicado nada.`, ''];
  if (!cal.length) l.push('El calendario está vacío.');
  for (const e of cal) {
    l.push(`## ${e.id || '(sin id)'} · ${e.cuando ? horaMadrid(e.cuando) : 'sin fecha'}`, '');
    for (const aviso of textosAvisos(await validar(e))) l.push(`- ⚠️ ${aviso}`);
    for (const red of e.redes || []) {
      if (!REDES.includes(red)) continue;
      const q = queToca(e, red, ahora);
      const verbo = { publicar: '▶️ Publicaría ahora', programar: '▶️ Programaría en Buffer', caducar: '⏹️ Daría por perdida', esperar: '⏳ Esperaría', nada: '✔️ Nada que hacer' }[q.accion];
      l.push(`- ${NOMBRE_RED[red]}: ${verbo} (${q.motivo})`);
    }
    l.push('');
  }
  return { lineas: l, errores: 0 };
}

async function publicar() {
  const ahora = Date.now();
  const l = ['# Estado del publicador', '', `Última publicación: ${horaMadrid(ahora)} (hora de Madrid)`, ''];
  let errores = 0;
  let hechos = 0;

  for (const e of cal) {
    for (const red of e.redes || []) {
      if (!REDES.includes(red)) continue;
      const q = queToca(e, red, Date.now());

      if (q.accion === 'caducar') {
        e[red] = { error: 'No se publicó: pasaron más de 24 horas desde su hora.', intentos: MAX_INTENTOS };
        l.push(`- ⏹️ ${e.id} · ${NOMBRE_RED[red]}: perdida (pasaron más de 24 h).`);
        errores++;
        await guardar();
        continue;
      }
      if (q.accion !== 'publicar' && q.accion !== 'programar') continue;

      const avisos = avisosDe(await validar(e), red);
      if (avisos.length) {
        e[red] = { error: `No se publicó: ${avisos.join('; ')}`, intentos: (e[red]?.intentos || 0) + 1, ultimo_intento: ahoraISO() };
        l.push(`- ❌ ${e.id} · ${NOMBRE_RED[red]}: ${avisos.join('; ')}`);
        errores++;
        await guardar();
        continue;
      }

      if (q.accion === 'publicar') {
        try {
          if ((e[red]?.intentos || 0) > 0) {
            const ya = await yaPublicadoEnMeta(red, e);
            if (ya) {
              e[red] = { publicado: ahoraISO(), enlace: ya.enlace || null, id: ya.id, nota: 'ya estaba publicado' };
              l.push(`- ✅ ${e.id} · ${NOMBRE_RED[red]}: ya estaba publicado ${ya.enlace || ''}`);
              hechos++;
              await guardar();
              continue;
            }
          }
          const r = red === 'instagram' ? await publicarInstagram(e) : await publicarFacebook(e);
          e[red] = { publicado: ahoraISO(), enlace: r.enlace, id: r.id };
          l.push(`- ✅ ${e.id} · ${NOMBRE_RED[red]}: publicado ${r.enlace || ''}`);
          hechos++;
        } catch (err) {
          e[red] = {
            error: limpiar(err.message),
            intentos: (e[red]?.intentos || 0) + 1,
            primer_intento: e[red]?.primer_intento || ahoraISO(),
            ultimo_intento: ahoraISO(),
          };
          l.push(`- ❌ ${e.id} · ${NOMBRE_RED[red]}: ${limpiar(err.message)}`);
          errores++;
        }
      } else {
        try {
          const r = await programarEnBuffer(red, e);
          e[red] = { programado: r.programado, buffer_id: r.id };
          l.push(`- ✅ ${e.id} · ${NOMBRE_RED[red]}: programado en Buffer para ${horaMadrid(r.programado)}`);
          hechos++;
        } catch (err) {
          const previos = e[red]?.intentos || 0;
          e[red] = err.definitivo
            ? { error: limpiar(err.message), intentos: previos + 1, ultimo_intento: ahoraISO() }
            : {
                error: limpiar(err.message),
                intentos: MAX_INTENTOS,
                ultimo_intento: ahoraISO(),
                revisar: 'No se sabe si llegó a Buffer: mira la cola de Buffer antes de volver a intentarlo.',
              };
          l.push(`- ❌ ${e.id} · ${NOMBRE_RED[red]}: ${limpiar(err.message)}`);
          errores++;
        }
      }
      await guardar();
    }
  }

  if (!hechos && !errores) l.push('Nada que publicar ahora.');
  return { lineas: l, errores, hechos };
}

// ---------------------------------------------------------------- música para Reels (biblioteca de Instagram)

// Busca canciones con las consultas de peticiones/musica.txt (una por línea), escribe musica.md y
// guarda en musica/previa/ los primeros segundos de cada una, solo para escucharlas antes de elegir.
async function musica() {
  const l = ['# Música para Reels', '', `Búsqueda: ${horaMadrid(Date.now())} (hora de Madrid)`, ''];
  if (!META_TOKEN) return { lineas: [...l, '❌ Falta la clave de Meta.'], errores: 1 };
  let consultas = ['halloween'];
  try {
    consultas = (await readFile('peticiones/musica.txt', 'utf8')).split('\n').map((s) => s.trim()).filter((s) => s && !s.startsWith('#'));
  } catch {}
  let segundos = 15;
  const m = consultas.find((c) => /^segundos\s*=/.test(c));
  if (m) { segundos = Number(m.split('=')[1]) || 15; consultas = consultas.filter((c) => c !== m); }

  const { ig } = await idsMeta();
  const vistas = new Map();
  for (const q of consultas) {
    try {
      const r = await graph('GET', '/ig_audio', { audio_type: 'music', user_id: ig, search_query: q });
      for (const a of r.audio || r.data || []) if (a.audio_id && !vistas.has(a.audio_id)) vistas.set(a.audio_id, { ...a, consulta: q });
      l.push(`- «${q}»: ${(r.audio || r.data || []).length} resultados`);
    } catch (err) {
      l.push(`- «${q}»: ❌ ${limpiar(err.message)}`);
    }
  }
  l.push('');
  // Primero las que por el título suenan más a Halloween
  const CLAVES = /hallow|spook|horror|creep|scar|ghost|ghoul|witch|haunt|monster|zombie|vampir|skelet|pumpkin|trick|treat|terror|miedo|fantasm|bruj|dark|night|myster|thrill|suspens|macabr|eerie|grave|tomb|curse|spider|bat|boo/i;
  const puntos = (a) => (CLAVES.test(`${a.title} ${a.display_artist}`) ? 1 : 0);
  const lista = [...vistas.values()]
    .filter((a) => !a.duration_in_ms || a.duration_in_ms >= segundos * 1000)
    .sort((a, b) => puntos(b) - puntos(a));
  if (!lista.length) return { lineas: [...l, 'No ha salido ninguna canción.'], errores: 1 };

  const { mkdir, rm } = await import('node:fs/promises');
  await rm('musica/previa', { recursive: true, force: true });
  await mkdir('musica/previa', { recursive: true });
  l.push('| # | Canción | Artista | Duración | Búsqueda | id | Escuchar en Instagram | Previa |', '|---|---|---|---|---|---|---|---|');
  let n = 0;
  let descargadas = 0;
  for (const a of lista.slice(0, 24)) {
    n++;
    let previa = '';
    if (a.download_url && descargadas < 12) {
      try {
        const res = await fetch(a.download_url);
        if (res.ok) {
          // Se guarda el archivo tal cual: solo para escucharlo antes de elegir (se borra en la siguiente búsqueda)
          previa = `musica/previa/${a.audio_id}.orig`;
          await writeFile(previa, Buffer.from(await res.arrayBuffer()));
          descargadas++;
        }
      } catch (err) {
        previa = `❌ ${limpiar(err.message).slice(0, 60)}`;
      }
    }
    const dur = a.duration_in_ms ? `${Math.round(a.duration_in_ms / 1000)} s` : '?';
    const celda = (s) => String(s ?? '').replace(/\|/g, '/');
    l.push(`| ${n} | ${celda(a.title)} | ${celda(a.display_artist || a.ig_username)} | ${dur} | ${celda(a.consulta)} | ${a.audio_id} | ${a.on_platform_audio_preview_link || ''} | ${previa} |`);
  }
  return { lineas: l, errores: 0 };
}

// ---------------------------------------------------------------- principal

export async function main(argv = process.argv.slice(2)) {
  META_TOKEN = (process.env.META_PAGE_TOKEN || '').trim();
  BUFFER_KEY = (process.env.BUFFER_API_KEY || '').trim();
  idsCache = null;
  canalesCache = null;

  const modo = (argv[0] || 'prueba').toLowerCase();
  if (!['comprobar', 'prueba', 'publicar', 'musica'].includes(modo)) {
    console.error('Uso: node publicar.mjs comprobar | prueba | publicar | musica');
    return 2;
  }
  if (modo === 'musica') {
    let r;
    try {
      r = await musica();
    } catch (err) {
      r = { lineas: ['# Música para Reels', '', `❌ Error inesperado: ${limpiar(err?.stack || err?.message || err)}`], errores: 1 };
    }
    const texto = limpiar(r.lineas.join('\n')) + '\n';
    console.log(texto);
    await writeFile('musica.md', texto);
    return r.errores ? 1 : 0;
  }

  try {
    cal = await leerCalendario();
  } catch (err) {
    console.error(`❌ No puedo leer ${CALENDARIO}: ${err.message}`);
    await writeFile(ESTADO, `# Estado del publicador\n\n❌ No puedo leer ${CALENDARIO}: ${limpiar(err.message)}\n`);
    return 1;
  }

  let resultado;
  try {
    resultado = modo === 'comprobar' ? await comprobar() : modo === 'prueba' ? await prueba() : await publicar();
  } catch (err) {
    resultado = { lineas: ['# Estado del publicador', '', `❌ Error inesperado (${modo}): ${limpiar(err?.stack || err?.message || err)}`], errores: 1, hechos: 0 };
  }
  const texto = limpiar(resultado.lineas.join('\n')) + '\n';
  console.log(texto);

  // En modo publicar solo se escribe el estado si ha pasado algo, para no llenar el historial
  if (modo !== 'publicar' || resultado.hechos || resultado.errores) await writeFile(ESTADO, texto);
  if (modo === 'publicar') await guardar();
  return resultado.errores ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
