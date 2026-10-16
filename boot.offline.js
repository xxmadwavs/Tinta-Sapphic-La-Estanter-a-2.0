// Arranque de la app REAL con jsdom simulando SIN CONEXIÓN:
//  - el CDN de supabase-js no carga (jsdom no descarga scripts externos)
//  - fetch: books_data.json sale de la "caché" (archivo local); el resto de red falla como offline
// Uso: node boot.offline.js <ruta-a-index.html>
const { JSDOM, VirtualConsole } = require('jsdom');
const fs = require('fs'), path = require('path');
const file = process.argv[2];
const html = fs.readFileSync(file, 'utf8');
const books = fs.readFileSync(path.join(__dirname, 'books_data.json'), 'utf8');
const errors = [], fetched = [];
const vc = new VirtualConsole();
vc.on('jsdomError', e => errors.push((e.detail && e.detail.message) || e.message));
vc.on('error', (...a) => errors.push(a.join(' ')));
const dom = new JSDOM(html, {
  url: 'https://xxmadwavs.github.io/Tinta-Sapphic-La-Estanter-a-2.0/', runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: vc,
  beforeParse(w){
    w.addEventListener('error', e => errors.push(e.message));
    w.addEventListener('unhandledrejection', e => errors.push('rechazo: ' + (e.reason && e.reason.message || e.reason)));
    w.matchMedia = w.matchMedia || (q => ({ matches: false, media: q, addEventListener(){}, removeEventListener(){}, addListener(){}, removeListener(){} }));
    w.IntersectionObserver = w.IntersectionObserver || class { observe(){} unobserve(){} disconnect(){} };
    w.ResizeObserver = w.ResizeObserver || class { observe(){} unobserve(){} disconnect(){} };
    w.scrollTo = () => {}; w.HTMLElement.prototype.scrollIntoView = () => {};
    if (!w.HTMLDialogElement.prototype.showModal) { w.HTMLDialogElement.prototype.showModal = function(){ this.open = true; }; w.HTMLDialogElement.prototype.close = function(){ this.open = false; }; }
    w.fetch = (u) => { u = String(u); fetched.push(u);
      if (u.includes('books_data.json')) return Promise.resolve(new Response(books, { status: 200, headers: { 'content-type': 'application/json' } }));
      return Promise.reject(new TypeError('Failed to fetch')); };            // todo lo demás: sin red
    Object.defineProperty(w.navigator, 'onLine', { get: () => false, configurable: true });
    Object.defineProperty(w.navigator, 'serviceWorker', { value: undefined, configurable: true });   // el SW se prueba aparte
  },
});
setTimeout(() => {
  const d = dom.window.document;
  const cards = d.querySelectorAll('.book-card').length;
  const fatal = errors.filter(m => /supabase is not defined/i.test(m));
  console.log(JSON.stringify({
    archivo: path.basename(file),
    errorSupabaseNoDefinido: fatal.length > 0,
    tarjetasDeLibros: cards,
    librosEnMemoria: (() => { try { return dom.window.eval('allBooks.length'); } catch (e) { return 'n/d: ' + e.message; } })(),
    fetchedUrls: fetched.slice(0,5),
    contenedor: ((d.getElementById('booksContainer')||{}).innerHTML||'').slice(0,140),
    htmlEnContenedor: (d.getElementById('booksContainer') || {}).innerHTML ? d.getElementById('booksContainer').innerHTML.length : 0,
    mensajeSinLibros: /Sin libros/.test((d.getElementById('booksContainer') || {}).innerHTML || ''),
    initEjecutado: fetched.some(u => u.includes('books_data.json')),
    otrosErrores: [...new Set(errors.filter(m => !/supabase is not defined/i.test(m)))].slice(0, 6),
    avisoVisible: (d.getElementById('tsNetBar') || {}).hidden === false,
    textoAviso: (d.getElementById('tsNetTx') || {}).textContent || null,
  }, null, 2));
  process.exit(0);
}, 6000);
