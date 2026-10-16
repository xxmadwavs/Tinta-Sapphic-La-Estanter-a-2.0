// Pruebas del service worker (sw.js) con Cache API, fetch y clientes simulados.
// Se ejecuta con: node --test sw.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), vm = require('vm'), path = require('path');

const SW_SRC = fs.readFileSync(path.join(__dirname, '..', 'sw.js'), 'utf8');
const ORIGIN = 'https://xxmadwavs.github.io';
const SCOPE_TEST  = ORIGIN + '/Tinta-Sapphic-La-Estanter-a-2.0/';
const SCOPE_FINAL = ORIGIN + '/Tinta-Sapphic-La-Estanteria/';

/* ---------- Cache API simulada (compartida entre despliegues, como en el mismo origen) ---------- */
class FakeCache {
  constructor(){ this.m = new Map(); }
  _k(r){ return typeof r === 'string' ? r : r.url; }
  async match(r, o){ const k = this._k(r); const ig = o && o.ignoreSearch;
    for (const [u, res] of this.m) { if (u === k || (ig && u.split('?')[0] === k.split('?')[0])) return res.clone(); } }
  async put(r, res){ this.m.set(this._k(r), res); }
  async add(r){ const res = await FETCH(this._k(r), { cache: r.cache }); if (!res.ok) throw new Error('add ' + res.status); this.m.set(this._k(r), res); }
  async addAll(rs){ for (const r of rs) await this.add(r); }
  async delete(r){ return this.m.delete(this._k(r)); }
  async keys(){ return [...this.m.keys()].map(url => ({ url })); }
}
class FakeCaches {
  constructor(){ this.s = new Map(); this.deleted = []; }
  async open(n){ if (!this.s.has(n)) this.s.set(n, new FakeCache()); return this.s.get(n); }
  async keys(){ return [...this.s.keys()]; }
  async delete(n){ this.deleted.push(n); return this.s.delete(n); }
}

/* ---------- red simulada ---------- */
let NET;      // { routes: {url: handler}, calls: [] , offline:false }
function mkRes(body, { status = 200, headers = {}, type = 'basic' } = {}){
  const r = new Response(body, { status, headers });
  Object.defineProperty(r, 'type', { value: type });
  return r;
}
function FETCH(url, init){
  url = typeof url === 'string' ? url : url.url;
  NET.calls.push({ url, cache: init && init.cache });
  if (NET.offline) return Promise.reject(new TypeError('Failed to fetch'));
  const h = NET.routes[url] || NET.routes[url.split('?')[0]];
  if (!h) return Promise.resolve(mkRes('not found', { status: 404 }));
  return Promise.resolve(typeof h === 'function' ? h(url, init) : h);
}

/* ---------- carga de una instancia de sw.js ---------- */
function loadSW(scope, caches, { version, timeoutMs = 80 } = {}){
  const handlers = {}, posted = [];
  const clientsList = [{ postMessage: m => posted.push(m) }];
  let skipped = false, claimed = false;
  const selfObj = {
    registration: { scope }, location: { origin: ORIGIN },
    addEventListener: (t, f) => { handlers[t] = f; },
    skipWaiting: async () => { skipped = true; },
    clients: { claim: async () => { claimed = true; }, matchAll: async () => clientsList },
  };
  let src = SW_SRC.replace('const NET_TIMEOUT_MS = 5000;', `const NET_TIMEOUT_MS = ${timeoutMs};`);
  if (version) src = src.replace(/const VERSION = '[^']+';/, `const VERSION = '${version}';`);
  const ctx = { self: selfObj, caches, fetch: FETCH, Request, Response, URL, Headers, setTimeout, Promise, console };
  vm.createContext(ctx); vm.runInContext(src, ctx);
  return {
    posted, get skipped(){ return skipped; }, get claimed(){ return claimed; },
    cacheName: () => vm.runInContext('CACHE', ctx),
    async lifecycle(type){ let p; handlers[type]({ waitUntil: x => { p = x; } }); return p; },
    // devuelve { handled, response(), waits }
    async fetch(url, { method = 'GET', mode = 'cors', headers = {} } = {}){
      let resp, waits = [];
      const req = { url, method, mode, headers: new Headers(headers) };
      handlers.fetch({ request: req, respondWith: p => { resp = p; }, waitUntil: p => waits.push(p) });
      if (!resp) return { handled: false };
      let out, err;
      try { out = await resp; } catch (e) { err = e; }
      await Promise.allSettled(waits);
      return { handled: true, res: out, err };
    },
  };
}
const fresh = () => { NET = { routes: {}, calls: [], offline: false }; return new FakeCaches(); };
const okAll = scope => { const r = {};
  r[scope + 'index.html'] = mkRes('<html>v1</html>', { headers: { date: 'Mon, 12 Oct 2026 10:00:00 GMT' } });
  r[scope + 'manifest.json'] = mkRes('{}'); r[scope + 'icons/icon-192.png'] = mkRes('i1');
  r[scope + 'icons/icon-512.png'] = mkRes('i2'); r[scope + 'icons/apple-touch-icon.png'] = mkRes('i3');
  r[scope + 'books_data.json'] = mkRes('[{"t":"libro"}]');
  return r; };

/* ===================== INSTALACIÓN / ACTIVACIÓN ===================== */
test('1. nombre de caché derivado del scope y distinto en cada despliegue', async () => {
  const c = fresh();
  const a = loadSW(SCOPE_TEST, c), b = loadSW(SCOPE_FINAL, c);
  assert.match(a.cacheName(), /^ts::https:\/\/xxmadwavs\.github\.io\/Tinta-Sapphic-La-Estanter-a-2\.0\/::\d/);
  assert.notEqual(a.cacheName(), b.cacheName());
  assert.ok(!a.cacheName().startsWith(b.cacheName().split('::')[0] + '::' + SCOPE_FINAL), 'prefijos no solapados');
});

test('2. install: cachea index (obligatorio) y shell; no cachea datos pesados ni nada de usuario', async () => {
  const c = fresh(); NET.routes = okAll(SCOPE_TEST);
  const sw = loadSW(SCOPE_TEST, c); await sw.lifecycle('install');
  const cache = await c.open(sw.cacheName());
  const keys = (await cache.keys()).map(k => k.url.replace(SCOPE_TEST, ''));
  assert.deepEqual(keys.sort(), ['icons/apple-touch-icon.png', 'icons/icon-192.png', 'icons/icon-512.png', 'index.html', 'manifest.json']);
  assert.ok(sw.skipped);
  assert.ok(NET.calls.filter(x => x.url.includes('books_data')).length === 0, 'books_data no se precachea en install');
});

test('3. install tolera que falten iconos/manifest (best-effort) pero falla si falta index.html', async () => {
  let c = fresh(); NET.routes = { [SCOPE_FINAL + 'index.html']: mkRes('<html/>') };
  const ok = loadSW(SCOPE_FINAL, c); await ok.lifecycle('install');
  assert.equal((await (await c.open(ok.cacheName())).keys()).length, 1);
  c = fresh(); NET.routes = {};
  const bad = loadSW(SCOPE_FINAL, c);
  await assert.rejects(() => bad.lifecycle('install'));
});

test('4. activate: borra solo versiones antiguas de SU scope; respeta el otro despliegue y cachés ajenas', async () => {
  const c = fresh(); NET.routes = okAll(SCOPE_TEST);
  const old = loadSW(SCOPE_TEST, c, { version: '1.0.0' }); await old.lifecycle('install');
  const other = loadSW(SCOPE_FINAL, c, { version: '1.0.0' }); NET.routes = { ...NET.routes, ...okAll(SCOPE_FINAL) }; await other.lifecycle('install');
  await c.open('datos-usuario-ajenos'); await c.open('workbox-precache-v2');
  const neu = loadSW(SCOPE_TEST, c, { version: '1.1.0' });
  await neu.lifecycle('activate');
  const names = await c.keys();
  assert.ok(!names.includes(old.cacheName()), 'versión antigua del mismo scope eliminada');
  assert.ok(names.includes(other.cacheName()), 'caché del otro despliegue intacta');
  assert.ok(names.includes('datos-usuario-ajenos') && names.includes('workbox-precache-v2'), 'cachés ajenas intactas');
  assert.deepEqual(c.deleted, [old.cacheName()], 'única eliminación: la versión antigua propia');
  assert.ok(neu.claimed);
});

test('5. activate: precarga datos disponibles y tolera 404 (repo final sin world_*.json)', async () => {
  const c = fresh(); NET.routes = okAll(SCOPE_FINAL);          // solo books_data existe
  const sw = loadSW(SCOPE_FINAL, c); await sw.lifecycle('activate');
  const keys = (await (await c.open(sw.cacheName())).keys()).map(k => k.url.replace(SCOPE_FINAL, ''));
  assert.deepEqual(keys, ['books_data.json']);                 // los 404 no se guardan
});

/* ===================== ENRUTADO: qué NO se intercepta ===================== */
test('6. no intercepta Supabase, auth, fuentes, CDN, POST, Range, admin.html, ni rutas ajenas', async () => {
  const c = fresh(); NET.routes = okAll(SCOPE_TEST);
  const sw = loadSW(SCOPE_TEST, c);
  const cases = [
    ['https://fteitflirsmabcasmwij.supabase.co/rest/v1/ratings?select=*', {}],
    ['https://fteitflirsmabcasmwij.supabase.co/auth/v1/token?grant_type=password', { method: 'POST' }],
    ['https://fteitflirsmabcasmwij.supabase.co/auth/v1/user', {}],
    ['https://fonts.googleapis.com/css2?family=Cinzel', {}],
    ['https://fonts.gstatic.com/s/cinzel/x.woff2', {}],
    ['https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2', {}],
    [SCOPE_TEST + 'admin.html', { mode: 'navigate' }],
    [SCOPE_TEST + 'otra-cosa.json', {}],
    [SCOPE_TEST + 'books_data.json', { method: 'POST' }],
    [SCOPE_TEST + 'icons/icon-512.png', { headers: { range: 'bytes=0-10' } }],
    [SCOPE_FINAL + 'index.html', { mode: 'navigate' }],                  // el otro despliegue
    [ORIGIN + '/otro-repo/index.html', { mode: 'navigate' }],
  ];
  for (const [u, o] of cases) assert.equal((await sw.fetch(u, o)).handled, false, 'no debe interceptar: ' + u);
  assert.equal(NET.calls.length, 0, 'ninguna petición pasó por el SW');
});

/* ===================== red primero: index y datos ===================== */
test('7. navegación a la raíz y a ?section=thais: red primero con revalidación; guarda copia', async () => {
  const c = fresh(); NET.routes = okAll(SCOPE_TEST);
  const sw = loadSW(SCOPE_TEST, c);
  for (const u of [SCOPE_TEST, SCOPE_TEST + '?section=thais', SCOPE_TEST + 'index.html']) {
    const r = await sw.fetch(u, { mode: 'navigate' });
    assert.ok(r.handled); assert.equal(await r.res.text(), '<html>v1</html>');
  }
  assert.ok(NET.calls.every(x => x.cache === 'no-cache' && x.url === SCOPE_TEST + 'index.html'), 'siempre revalida index.html sin query');
  assert.ok(await (await c.open(sw.cacheName())).match(SCOPE_TEST + 'index.html'));
});

test('8. no muestra datos viejos si hay red: la versión nueva sustituye a la guardada', async () => {
  const c = fresh(); NET.routes = okAll(SCOPE_TEST);
  const sw = loadSW(SCOPE_TEST, c);
  assert.equal(await (await sw.fetch(SCOPE_TEST + 'books_data.json')).res.text(), '[{"t":"libro"}]');
  NET.routes[SCOPE_TEST + 'books_data.json'] = mkRes('[{"t":"libro NUEVO"}]');
  const r = await sw.fetch(SCOPE_TEST + 'books_data.json');
  assert.equal(await r.res.text(), '[{"t":"libro NUEVO"}]');
  assert.equal(sw.posted.length, 0, 'sin aviso de copia vieja cuando la red responde');
  assert.equal(await (await (await c.open(sw.cacheName())).match(SCOPE_TEST + 'books_data.json')).text(), '[{"t":"libro NUEVO"}]');
});

test('9. sin conexión: sirve la copia guardada Y avisa a la página (ts-stale con fecha)', async () => {
  const c = fresh(); NET.routes = okAll(SCOPE_TEST);
  const sw = loadSW(SCOPE_TEST, c);
  await sw.fetch(SCOPE_TEST, { mode: 'navigate' });                 // guarda index
  NET.offline = true;
  const r = await sw.fetch(SCOPE_TEST + '?section=thais', { mode: 'navigate' });
  assert.equal(await r.res.text(), '<html>v1</html>');
  assert.equal(sw.posted.length, 1);
  assert.equal(sw.posted[0].type, 'ts-stale'); assert.match(sw.posted[0].date, /12 Oct 2026/);
});

test('10. sin conexión y sin copia: error de red real (no se inventan datos)', async () => {
  const c = fresh(); NET.routes = okAll(SCOPE_TEST); NET.offline = true;
  const sw = loadSW(SCOPE_TEST, c);
  const r = await sw.fetch(SCOPE_TEST + 'world_map_data.json');
  assert.ok(r.handled && r.err instanceof TypeError && !r.res);
});

test('11. error 5xx con copia -> copia + aviso; 404 con copia -> se devuelve el 404 (no se maquilla)', async () => {
  const c = fresh(); NET.routes = okAll(SCOPE_TEST);
  const sw = loadSW(SCOPE_TEST, c);
  await sw.fetch(SCOPE_TEST + 'books_data.json');
  NET.routes[SCOPE_TEST + 'books_data.json'] = mkRes('boom', { status: 503 });
  let r = await sw.fetch(SCOPE_TEST + 'books_data.json');
  assert.equal(await r.res.text(), '[{"t":"libro"}]'); assert.equal(sw.posted.length, 1);
  NET.routes[SCOPE_TEST + 'books_data.json'] = mkRes('nf', { status: 404 });
  r = await sw.fetch(SCOPE_TEST + 'books_data.json');
  assert.equal(r.res.status, 404); assert.equal(sw.posted.length, 1);
  assert.equal(await (await (await c.open(sw.cacheName())).match(SCOPE_TEST + 'books_data.json')).text(), '[{"t":"libro"}]', 'el 404 no pisa la copia buena');
});

test('12. red muy lenta con copia: tras el tiempo límite usa la copia; la respuesta tardía actualiza la caché', async () => {
  const c = fresh(); NET.routes = okAll(SCOPE_TEST);
  const sw = loadSW(SCOPE_TEST, c, { timeoutMs: 60 });
  await sw.fetch(SCOPE_TEST + 'books_data.json');
  NET.routes[SCOPE_TEST + 'books_data.json'] = () => new Promise(r => setTimeout(() => r(mkRes('[{"t":"tardío"}]')), 200));
  const t0 = Date.now();
  const r = await sw.fetch(SCOPE_TEST + 'books_data.json');
  assert.ok(Date.now() - t0 < 180, 'no espera a la red lenta');
  assert.equal(await r.res.text(), '[{"t":"libro"}]'); assert.equal(sw.posted.length, 1);
  await new Promise(r => setTimeout(r, 250));
  assert.equal(await (await (await c.open(sw.cacheName())).match(SCOPE_TEST + 'books_data.json')).text(), '[{"t":"tardío"}]');
});

test('13. no guarda respuestas no cacheables (no-store, private, no-200, no-basic)', async () => {
  const c = fresh(); const sw = loadSW(SCOPE_TEST, c);
  const key = SCOPE_TEST + 'books_data.json'; const cache = await c.open(sw.cacheName());
  for (const res of [mkRes('x', { headers: { 'cache-control': 'no-store' } }), mkRes('x', { headers: { 'cache-control': 'private, max-age=0' } }),
                     mkRes('x', { status: 206 }), mkRes('x', { status: 500 }), mkRes('x', { type: 'cors' }), mkRes('x', { type: 'opaque' })]) {
    NET.routes[key] = res; await sw.fetch(key);
    assert.equal(await cache.match(key), undefined);
  }
});

/* ===================== estáticos: caché + segundo plano ===================== */
test('14. assets/iconos: primera vez red y guarda; después caché inmediata + refresco en segundo plano', async () => {
  const c = fresh(); NET.routes = { [SCOPE_FINAL + 'assets/logros/sticker-bingo.png']: mkRes('png-1') };
  const sw = loadSW(SCOPE_FINAL, c);
  const u = SCOPE_FINAL + 'assets/logros/sticker-bingo.png';
  assert.equal(await (await sw.fetch(u)).res.text(), 'png-1');
  NET.routes[u] = mkRes('png-2');
  assert.equal(await (await sw.fetch(u)).res.text(), 'png-1', 'responde al instante con la guardada');
  assert.equal(await (await sw.fetch(u)).res.text(), 'png-2', 'y la siguiente ya trae la actualizada');
  NET.offline = true;
  assert.equal(await (await sw.fetch(u)).res.text(), 'png-2', 'offline: sigue disponible');
  const miss = await sw.fetch(SCOPE_FINAL + 'assets/logros/otra.png');
  assert.ok(miss.res && miss.res.type === 'error', 'offline sin copia: error de red, no datos inventados');
});

test('15. tope de imágenes en assets/: se descartan las más antiguas', async () => {
  const c = fresh(); const sw = loadSW(SCOPE_TEST, c);
  for (let i = 0; i < 45; i++) { const u = SCOPE_TEST + `assets/logros/s${i}.png`; NET.routes[u] = mkRes('p' + i); await sw.fetch(u); }
  const keys = (await (await c.open(sw.cacheName())).keys()).map(k => k.url);
  assert.equal(keys.length, 40);
  assert.ok(!keys.some(k => k.endsWith('s0.png')) && keys.some(k => k.endsWith('s44.png')));
});

/* ===================== actualizaciones y aislamiento ===================== */
test('16. subir VERSION: la caché nueva toma el relevo y la antigua se elimina; nada más se toca', async () => {
  const c = fresh(); NET.routes = okAll(SCOPE_TEST);
  const v1 = loadSW(SCOPE_TEST, c, { version: '1.0.0' }); await v1.lifecycle('install');
  await c.open('otra-app'); 
  const v2 = loadSW(SCOPE_TEST, c, { version: '1.1.0' }); await v2.lifecycle('install'); await v2.lifecycle('activate');
  const names = await c.keys();
  assert.ok(names.includes(v2.cacheName()) && !names.includes(v1.cacheName()) && names.includes('otra-app'));
  assert.equal((await v2.fetch(SCOPE_TEST, { mode: 'navigate' })).handled, true);
});

test('17. los dos despliegues conviven: ni sus cachés ni sus peticiones se mezclan', async () => {
  const c = fresh(); NET.routes = { ...okAll(SCOPE_TEST), ...okAll(SCOPE_FINAL) };
  NET.routes[SCOPE_FINAL + 'index.html'] = mkRes('<html>FINAL</html>');
  const t = loadSW(SCOPE_TEST, c), f = loadSW(SCOPE_FINAL, c);
  await t.lifecycle('install'); await f.lifecycle('install'); await t.lifecycle('activate'); await f.lifecycle('activate');
  assert.equal(await (await t.fetch(SCOPE_TEST, { mode: 'navigate' })).res.text(), '<html>v1</html>');
  assert.equal(await (await f.fetch(SCOPE_FINAL, { mode: 'navigate' })).res.text(), '<html>FINAL</html>');
  NET.offline = true;
  assert.equal(await (await f.fetch(SCOPE_FINAL, { mode: 'navigate' })).res.text(), '<html>FINAL</html>');
  assert.equal(await (await t.fetch(SCOPE_TEST, { mode: 'navigate' })).res.text(), '<html>v1</html>');
  assert.equal((await c.keys()).length, 2);
});

test('18. el SW nunca llama a fetch para nada que no sea su propio scope', async () => {
  const c = fresh(); NET.routes = okAll(SCOPE_TEST);
  const sw = loadSW(SCOPE_TEST, c); await sw.lifecycle('install'); await sw.lifecycle('activate');
  await sw.fetch(SCOPE_TEST, { mode: 'navigate' }); await sw.fetch(SCOPE_TEST + 'books_data.json'); await sw.fetch(SCOPE_TEST + 'icons/icon-192.png');
  assert.ok(NET.calls.every(x => x.url.startsWith(SCOPE_TEST)), 'solo peticiones dentro del scope');
});
