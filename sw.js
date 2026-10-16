/* Tinta Sapphic - La Estantería · Service worker (A3)
   Idéntico en final y pruebas. Subir VERSION en cada publicación en la que cambie
   este archivo o quieras forzar el vaciado de la caché antigua.

   QUÉ HACE
   - Red primero (con revalidación) para index.html y los JSON de datos; la caché es
     solo respaldo sin conexión o con red muy lenta. Si sirve una copia guardada,
     avisa a la página (mensaje 'ts-stale') para que lo indique al usuario.
   - Estáticos propios (iconos, manifest, assets/): caché con actualización en segundo plano.
   - NO toca nada más: Supabase, autenticación, Google Fonts, CDN, admin.html,
     peticiones POST/Range... pasan directas a la red sin pasar por la caché.
   - Nunca borra datos del usuario: solo gestiona sus propias cachés (prefijo del scope). */
const VERSION = '1.1.0';

const SCOPE  = self.registration.scope;       // p. ej. https://xxmadwavs.github.io/Tinta-Sapphic-La-Estanteria/
const PREFIX = 'ts::' + SCOPE + '::';         // distinto en cada despliegue
const CACHE  = PREFIX + VERSION;

const INDEX_PATH = 'index.html';
const INDEX_URL  = new URL(INDEX_PATH, SCOPE).href;

const REQUIRED = [INDEX_PATH];                // si falla, la instalación se reintenta
const SHELL    = ['manifest.json', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png']; // best-effort
const DATA     = ['books_data.json', 'world_map_data.json', 'world_cities_data.json', 'world_regions_data.json'];
const STATIC_PREFIXES = ['assets/', 'icons/'];
const STATIC_FILES    = ['manifest.json'];

const NET_TIMEOUT_MS = 5000;                  // red lenta: si hay copia guardada, se usa tras este tiempo
const MAX_ASSETS     = 40;                    // tope de imágenes de assets/ guardadas en ejecución

/* ───────────── ciclo de vida ───────────── */
self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await cache.addAll(REQUIRED.map(p => new Request(new URL(p, SCOPE).href, { cache: 'reload' })));
    await Promise.allSettled(SHELL.map(p => cache.add(new Request(new URL(p, SCOPE).href, { cache: 'reload' }))));
    await self.skipWaiting();                 // seguro: index/datos van red primero
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    // Solo cachés de ESTE scope y de otras versiones. Jamás las del otro despliegue ni datos del usuario.
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k.startsWith(PREFIX) && k !== CACHE).map(k => caches.delete(k)));
    await self.clients.claim();
    await warmData();                         // best-effort; no bloquea el control de la página
  })());
});

// Deja disponibles sin conexión los datos principales si la página los pidió antes de que el SW la controlara.
async function warmData() {
  const cache = await caches.open(CACHE);
  for (const p of DATA) {
    try {
      const url = new URL(p, SCOPE).href;
      if (await cache.match(url)) continue;
      const res = await fetch(url);
      if (isCacheable(res)) await cache.put(url, res);
    } catch (e) { /* el archivo puede no existir en este despliegue: se ignora */ }
  }
}

/* ───────────── utilidades ───────────── */
function isCacheable(res) {
  if (!res || res.status !== 200 || res.type !== 'basic') return false;
  const cc = (res.headers.get('cache-control') || '').toLowerCase();
  return !cc.includes('no-store') && !cc.includes('private');
}

async function notifyStale(path, cachedRes) {
  const clients = await self.clients.matchAll({ type: 'window' });
  const msg = { type: 'ts-stale', path, date: cachedRes.headers.get('date') || null };
  clients.forEach(c => c.postMessage(msg));
}

// waitUntil puede lanzar si el evento ya terminó (caso de la carrera perdida): la escritura sigue igualmente.
function keepAlive(event, p) { p = p.catch(() => {}); try { event.waitUntil(p); } catch (e) { /* ya no hay evento activo */ } return p; }

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

// Red primero. Copia guardada solo si: sin red, error 5xx o red más lenta que NET_TIMEOUT_MS.
async function networkFirst(event, path) {
  const key = new URL(path, SCOPE).href;
  const cache = await caches.open(CACHE);
  const cached = await cache.match(key, { ignoreSearch: true });

  const net = fetch(key, { cache: 'no-cache' }).then(res => {
    if (isCacheable(res)) keepAlive(event, cache.put(key, res.clone()));
    return res;
  });
  net.catch(() => {});                        // evita rechazos sin gestionar si perdemos la carrera

  try {
    const res = cached
      ? await Promise.race([net, delay(NET_TIMEOUT_MS).then(() => { throw new Error('timeout'); })])
      : await net;
    if (res.status >= 500 && cached) { notifyStale(path, cached); return cached; }
    return res;                               // 404 y demás: se devuelven tal cual (no se maquillan con datos viejos)
  } catch (err) {
    if (cached) { notifyStale(path, cached); return cached; }
    throw err;
  }
}

async function trimAssets(cache) {
  const keys = (await cache.keys()).filter(r => new URL(r.url).pathname.startsWith(new URL(SCOPE).pathname + 'assets/'));
  for (let i = 0; i < keys.length - MAX_ASSETS; i++) await cache.delete(keys[i]);   // los más antiguos primero
}

// Caché con actualización en segundo plano (imágenes e iconos).
async function staleWhileRevalidate(event, req, path) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(req);
  const refresh = fetch(req).then(async res => {
    if (isCacheable(res)) { await cache.put(req, res.clone()); if (path.startsWith('assets/')) await trimAssets(cache); }
    return res;
  }).catch(() => null);
  if (hit) { keepAlive(event, refresh); return hit; }
  return (await refresh) || Response.error();
}

/* ───────────── peticiones ───────────── */
self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET' || req.headers.has('range')) return;
  const url = new URL(req.url);
  // Solo mismo origen Y dentro del scope. Supabase, Google Fonts y jsdelivr quedan fuera.
  if (url.origin !== self.location.origin || !req.url.startsWith(SCOPE)) return;

  const path = url.pathname.slice(new URL(SCOPE).pathname.length);

  if (req.mode === 'navigate') {              // la app (raíz, index.html, ?section=...). admin.html y demás no se tocan.
    if (path === '' || path === INDEX_PATH) event.respondWith(networkFirst(event, INDEX_PATH));
    return;
  }
  if (path === INDEX_PATH || DATA.includes(path)) { event.respondWith(networkFirst(event, path)); return; }
  if (STATIC_FILES.includes(path) || STATIC_PREFIXES.some(p => path.startsWith(p))) {
    event.respondWith(staleWhileRevalidate(event, req, path));
  }
  // cualquier otra cosa: sin respondWith → red directa
});
