// Pruebas del código añadido a index.html: cliente de respaldo (sin supabase-js) y avisos.
// Se ejecuta con: node --test page.test.js   (extrae los bloques directamente de ../index.html)
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), vm = require('vm'), path = require('path');
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const block = (start) => { const i = html.indexOf(start); assert.ok(i > 0, 'bloque no encontrado: ' + start); const j = html.indexOf('</script>', i); return html.slice(i, j); };
const SHIM = block('/* A3 · Sin conexión'), BAR = block('/* A3 · Registro');

/* ================= cliente de respaldo ================= */
function runShim(win){
  const storageTouched = [];
  const store = new Proxy({}, { get: (_, k) => { storageTouched.push(String(k)); return () => null; } });
  const ctx = vm.createContext({ window: win, localStorage: store, sessionStorage: store, Promise, Object, Proxy, Symbol });
  vm.runInContext(SHIM, ctx);
  return { storageTouched };
}
test('P1. con supabase-js disponible el bloque no hace nada', () => {
  const real = { createClient: () => 'REAL' }; const win = { supabase: real };
  runShim(win);
  assert.equal(win.supabase, real); assert.equal(win.__tsNoSupabase, undefined);
});
test('P2. sin supabase-js: la línea original `supabase.createClient(...)` ya no revienta', () => {
  const win = {}; runShim(win);
  assert.equal(win.__tsNoSupabase, true);
  assert.doesNotThrow(() => vm.runInContext("const sb = supabase.createClient('u','k'); sb;", vm.createContext(Object.assign({}, win, { window: win, supabase: win.supabase }))));
});
test('P3. formato idéntico al de supabase-js ante fallo de red; sesión vacía; sin tocar localStorage', async () => {
  const win = {}; const { storageTouched } = runShim(win);
  const sb = win.supabase.createClient('u', 'k');
  const { data: { session } } = await sb.auth.getSession();                    // patrón exacto de init()
  assert.equal(session, null);
  const { data: { subscription } } = sb.auth.onAuthStateChange(() => {});     // patrón exacto del código
  assert.equal(typeof subscription.unsubscribe, 'function');
  let { error } = await sb.auth.signInWithPassword({ email: 'a', password: 'b' });
  assert.match(error.message, /Sin conexión/);                                // lo muestra setAuthError()
  ({ error } = await sb.auth.signUp({}));  assert.match(error.message, /Sin conexión/);
  const q = await sb.from('ratings').select('*').eq('user_id', 1).order('x').limit(3);
  assert.equal(q.data, null); assert.match(q.error.message, /Sin conexión/);
  const one = await sb.from('x').upsert({}).select().single();  assert.ok(one.error);
  const rpc = await sb.rpc('f', {});  assert.ok(rpc.error);
  assert.doesNotThrow(() => sb.channel('c').on('postgres_changes', {}, () => {}).subscribe());
  assert.equal(JSON.stringify(await sb.auth.getUser()), JSON.stringify({ data: { user: null }, error: null }));
  assert.equal(storageTouched.length, 0, 'nunca lee ni escribe almacenamiento: la sesión guardada se conserva');
});

/* ================= avisos ================= */
function runBar({ online = true, controller = false, noSb = false } = {}){
  const el = () => ({ hidden: true, textContent: '', _l: {}, addEventListener(t, f){ this._l[t] = f; } });
  const els = { tsNetBar: el(), tsNetTx: el(), tsNetAct: el(), tsNetX: el() };
  const winL = {}, docL = {}, swL = {}; let reloads = 0, registered = null;
  const navigator = { onLine: online, serviceWorker: {
    controller: controller ? {} : null, addEventListener: (t, f) => { swL[t] = f; },
    register: (u, o) => { registered = { u, o }; return Promise.resolve({ update: () => Promise.resolve() }); } } };
  const win = { addEventListener: (t, f) => { winL[t] = f; }, __tsNoSupabase: noSb || undefined };
  const ctx = vm.createContext({ document: { getElementById: i => els[i], addEventListener: (t, f) => { docL[t] = f; }, visibilityState: 'visible' },
    navigator, window: win, location: { reload: () => { reloads++; } }, console, setInterval: () => 0, Date, isNaN, Promise });
  Object.defineProperty(ctx, '__tsNoSupabase', { get: () => win.__tsNoSupabase });
  vm.runInContext(BAR.replace(/window\.__tsNoSupabase/g, '__tsNoSupabase'), ctx);
  return { els, winL, swL, docL, navigator, win, get reloads(){ return reloads; }, get registered(){ return registered; },
    shown: () => !els.tsNetBar.hidden, text: () => els.tsNetTx.textContent };
}
test('P4. online y todo normal: no se muestra ningún aviso', () => { assert.equal(runBar().shown(), false); });
test('P5. sin conexión: aviso claro (puede estar desactualizado; sesión/valoraciones/estantería necesitan Internet)', () => {
  const b = runBar({ online: false }); assert.ok(b.shown());
  assert.match(b.text(), /Sin conexión/); assert.match(b.text(), /no estar actualizado/); assert.match(b.text(), /sesión|Iniciar sesión/); assert.match(b.text(), /valoraciones/); assert.match(b.text(), /estantería/);
  assert.equal(b.els.tsNetAct.hidden, true);
});
test('P6. eventos offline/online: aparece y desaparece; cerrar lo oculta hasta que vuelva a cortarse', () => {
  const b = runBar(); b.navigator.onLine = false; b.winL.offline(); assert.ok(b.shown());
  b.els.tsNetX._l.click(); assert.equal(b.shown(), false);
  b.navigator.onLine = true; b.winL.online(); assert.equal(b.shown(), false);
  b.navigator.onLine = false; b.winL.offline(); assert.ok(b.shown(), 'vuelve a avisar en un nuevo corte');
});
test('P7. página abierta sin conexión y luego con red: pide recargar (sin recargar sola)', () => {
  const b = runBar({ online: false, noSb: true }); assert.match(b.text(), /Sin conexión/);
  b.navigator.onLine = true; b.winL.online();
  assert.match(b.text(), /Ya hay conexión/); assert.equal(b.els.tsNetAct.textContent, 'Recargar'); assert.equal(b.reloads, 0);
  b.els.tsNetAct._l.click(); assert.equal(b.reloads, 1, 'solo recarga cuando la usuaria pulsa');
});
test('P8. cuentas no cargadas estando online: lo indica', () => {
  const b = runBar({ noSb: true }); assert.ok(b.shown()); assert.match(b.text(), /no pudo activar las cuentas/);
});
test('P9. versión nueva: avisa solo si ya había un SW controlando (no en la primera instalación) y nunca recarga sola', () => {
  const first = runBar({ controller: false }); first.swL.controllerchange(); assert.equal(first.shown(), false, 'primera instalación: sin aviso');
  const upd = runBar({ controller: true }); upd.swL.controllerchange();
  assert.ok(upd.shown()); assert.match(upd.text(), /versión nueva/); assert.equal(upd.els.tsNetAct.textContent, 'Actualizar'); assert.equal(upd.reloads, 0);
  upd.els.tsNetAct._l.click(); assert.equal(upd.reloads, 1);
});
test('P10. copia guardada servida por el SW: indica la fecha de la copia', () => {
  const b = runBar(); b.swL.message({ data: { type: 'ts-stale', path: 'books_data.json', date: 'Mon, 12 Oct 2026 10:00:00 GMT' } });
  assert.ok(b.shown()); assert.match(b.text(), /última copia guardada del 12 de octubre de 2026/);
  b.swL.message({ data: { type: 'otro' } });          // mensajes ajenos se ignoran
});
test('P11. prioridad: actualización > sin conexión', () => {
  const b = runBar({ online: false, controller: true }); b.swL.controllerchange(); assert.match(b.text(), /versión nueva/);
});
test('P12. el registro usa ./sw.js, scope ./ y updateViaCache none; comprueba actualizaciones al volver a la app', async () => {
  const b = runBar(); b.winL.load(); await new Promise(r => setImmediate(r));
  assert.equal(JSON.stringify(b.registered), JSON.stringify({ u: './sw.js', o: { scope: './', updateViaCache: 'none' } }));
  assert.equal(typeof b.docL.visibilitychange, 'function');
});
