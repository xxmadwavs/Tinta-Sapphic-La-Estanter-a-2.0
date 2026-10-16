/* Tinta Sapphic - La Estantería · Service worker
   Idéntico en final y pruebas. Subir VERSION en cada publicación. */
const VERSION = '1.0.0';

const SCOPE = self.registration.scope;               // p. ej. https://xxmadwavs.github.io/Tinta-Sapphic-La-Estanteria/
const PREFIX = 'ts::' + SCOPE + '::';                // distinto por despliegue
const CACHE = PREFIX + VERSION;

const INDEX_URL = new URL('index.html', SCOPE).href;
const CORE = ['index.html', 'manifest.json', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png'];
const OPTIONAL = ['books_data.json', 'world_map_data.json', 'world_cities_data.json', 'world_regions_data.json'];

const NETWORK_FIRST = ['books_data.json'];           // además de index.html / navegaciones

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await cache.addAll(CORE.map(p => new Request(new URL(p, SCOPE).href, { cache: 'reload' })));
    // Opcionales: si alguno no existe en el repositorio, no rompe la instalación
    await Promise.allSettled(OPTIONAL.map(p => cache.add(new Request(new URL(p, SCOPE).href, { cache: 'reload' }))));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    // Solo borra cachés de ESTE scope y de otras versiones; nunca las del otro despliegue
    await Promise.all(keys.filter(k => k.startsWith(PREFIX) && k !== CACHE).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

async function networkFirst(fetchTarget, cacheKey) {
  const cache = await caches.open(CACHE);
  try {
    const res = await fetch(fetchTarget, { cache: 'no-cache' });
    if (res && res.ok && res.type === 'basic') cache.put(cacheKey, res.clone());
    return res;
  } catch (err) {
    const hit = await cache.match(cacheKey, { ignoreSearch: true });
    if (hit) return hit;
    throw err;
  }
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(request);
  const refresh = fetch(request).then(res => {
    if (res && res.ok && res.status === 200 && res.type === 'basic') cache.put(request, res.clone());
    return res;
  }).catch(() => null);
  return hit || (await refresh) || Response.error();
}

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  // Solo mismo origen Y dentro del scope. Supabase, Google Fonts y jsdelivr quedan fuera.
  if (url.origin !== self.location.origin || !req.url.startsWith(SCOPE)) return;

  const path = url.pathname.slice(new URL(SCOPE).pathname.length);

  // Navegaciones a la app (raíz o index.html, con ?section=... etc.): red primero,
  // index.html en caché como respaldo. Otras páginas (p. ej. admin.html) no se tocan.
  if (req.mode === 'navigate') {
    if (path === '' || path === 'index.html') event.respondWith(networkFirst(INDEX_URL, INDEX_URL));
    return;
  }

  if (path === 'index.html' || NETWORK_FIRST.includes(path)) {
    event.respondWith(networkFirst(req, new URL(path, SCOPE).href));
    return;
  }

  if (path === 'sw.js') return;

  // Resto de estáticos propios (mapas, ciudades, regiones, iconos, assets/logros/)
  if (OPTIONAL.includes(path) || path.startsWith('assets/') || path.startsWith('icons/') || path === 'manifest.json') {
    event.respondWith(staleWhileRevalidate(req));
  }
});
