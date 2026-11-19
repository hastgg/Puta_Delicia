'use strict';
/**
 * Prueba de punta a punta con la base de datos SIMULADA: levanta el servidor real, llama a la API por HTTP
 * y revisa qué quedó guardado en la «base». No toca tu MongoDB de verdad.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { MongoClientFalso, compartida } = require('./mongo-falso');
const C = require('../lib/credenciales');

const PORT = 38917, BASE = 'http://127.0.0.1:' + PORT;
const SEMILLA_CLAVE = 'Brasa#Lenta-7731', SEMILLA_PIN = '482917';

// --- simulamos el driver de MongoDB y capturamos el servidor HTTP para cerrarlo al final
const rutaMongo = require.resolve('mongodb');
require.cache[rutaMongo] = { id: rutaMongo, filename: rutaMongo, loaded: true, exports: { MongoClient: MongoClientFalso } };
let srv; const listenOrig = http.Server.prototype.listen;
http.Server.prototype.listen = function (...a) { srv = this; return listenOrig.apply(this, a); };
Object.assign(process.env, {
  MONGODB_URI: 'mongodb://falso', DATA_KEY: Buffer.alloc(32, 9).toString('base64'), PORT: String(PORT), TRUST_PROXY: '1',
  ADMIN_PASSWORD: SEMILLA_CLAVE, STAFF_PIN: SEMILLA_PIN, SIMULACION: 'true',
});
delete process.env.ADMIN_PIN;

// --- ayudantes
let ipN = 0; const ipNueva = () => `198.51.100.${++ipN}`;            // cada grupo de pruebas usa su propia IP (los límites son por IP)
async function llamar(ruta, { metodo = 'GET', body, pin, ip } = {}) {
  const r = await fetch(BASE + ruta, {
    method: metodo,
    headers: { ...(body && { 'Content-Type': 'application/json' }), ...(pin && { 'x-pin': encodeURIComponent(pin) }), 'x-forwarded-for': ip || '203.0.113.9' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, ...(await r.json().catch(() => ({}))) };
}
const credenciales = () => compartida.collection('credenciales'), bitacora = () => compartida.collection('auditoria').docs;
const eventos = accion => bitacora().filter(b => b.accion === accion);

test.before(async () => {
  require('../server.js');
  for (let i = 0; i < 100; i++) { try { if ((await fetch(BASE + '/api/health')).ok) return; } catch {} await new Promise(r => setTimeout(r, 50)); }
  throw new Error('El servidor no arrancó');
});
test.after(() => { srv?.closeAllConnections?.(); srv?.close(); });

test('primer arranque: siembra desde el .env, pero guarda solo hashes', async () => {
  const adm = await credenciales().findOne({ _id: 'admin' }), caja = await credenciales().findOne({ _id: 'caja' });
  assert.match(adm.hash, /^s1\$/); assert.match(caja.hash, /^s1\$/);
  const todo = JSON.stringify(compartida.collection('credenciales').docs);
  assert.ok(!todo.includes(SEMILLA_CLAVE) && !todo.includes(SEMILLA_PIN), 'las claves no deben quedar en claro');
  assert.equal(eventos('CREDENCIALES_INICIALES').length, 1);
});

test('acceso: caja y dueño usan claves distintas; los PIN por defecto de antes ya no sirven', async () => {
  const ip = ipNueva();
  assert.equal((await llamar('/api/verificar-pin', { metodo: 'POST', pin: SEMILLA_PIN, ip })).status, 200);
  assert.equal((await llamar('/api/verificar-pin', { metodo: 'POST', pin: SEMILLA_CLAVE, ip })).status, 200);   // el dueño también entra a caja
  assert.equal((await llamar('/api/verificar-admin', { metodo: 'POST', pin: SEMILLA_CLAVE, ip })).status, 200);
  assert.equal((await llamar('/api/verificar-admin', { metodo: 'POST', pin: SEMILLA_PIN, ip })).status, 401);   // la caja NO entra al panel
  for (const viejo of ['1234', '9999', '']) assert.equal((await llamar('/api/verificar-pin', { metodo: 'POST', pin: viejo, ip })).status, 401);
  assert.equal((await llamar('/api/eliminar-cliente', { metodo: 'POST', body: { id: 'PD-000000' }, pin: SEMILLA_PIN, ip })).status, 401);
  assert.equal((await llamar('/api/eliminar-cliente', { metodo: 'POST', body: { id: 'PD-000000' }, pin: SEMILLA_CLAVE, ip })).status, 404);  // autorizado, pero no existe
});

test('fuerza bruta: 10 fallos y se bloquea esa IP (aunque luego acierte)', async () => {
  const ip = ipNueva();
  for (let i = 0; i < 10; i++) assert.equal((await llamar('/api/verificar-pin', { metodo: 'POST', pin: '99' + i, ip })).status, 401);
  assert.equal((await llamar('/api/verificar-pin', { metodo: 'POST', pin: SEMILLA_PIN, ip })).status, 429);
  assert.equal((await llamar('/api/verificar-pin', { metodo: 'POST', pin: SEMILLA_PIN, ip: ipNueva() })).status, 200);   // otra IP no se afecta
});

test('/api/cliente/:id: probar PIN ahí también cuenta como intento', async () => {
  const ip = ipNueva();
  await compartida.collection('clientes').insertOne({ _id: 'PD-AAAAAA', nombre: 'Ana', puntos: 1, premio_listo: false, canjes: 0 });
  assert.equal((await llamar('/api/cliente/PD-AAAAAA', { ip })).status, 200);                    // el cliente sin PIN ve su tarjeta
  for (let i = 0; i < 10; i++) assert.equal((await llamar('/api/cliente/PD-AAAAAA', { pin: '77' + i, ip })).status, 401);
  assert.equal((await llamar('/api/cliente/PD-AAAAAA', { pin: SEMILLA_PIN, ip })).status, 429);
});

test('seguridad: solo el dueño la ve', async () => {
  const ip = ipNueva();
  assert.equal((await llamar('/api/admin/seguridad', { pin: SEMILLA_PIN, ip })).status, 401);
  const r = await llamar('/api/admin/seguridad', { pin: SEMILLA_CLAVE, ip });
  assert.equal(r.status, 200); assert.equal(r.tiene_codigo, false);
});

test('cambiar contraseña del dueño: pide la actual, aplica reglas y deja bitácora con IP', async () => {
  const ip = ipNueva(), nueva = 'Parrilla*Ñandú_77x';
  const cambiar = (actual, n) => llamar('/api/admin/cambiar-clave', { metodo: 'POST', body: { actual, nueva: n }, ip });
  assert.equal((await cambiar('incorrecta', nueva)).status, 401);
  assert.equal((await cambiar(SEMILLA_PIN, nueva)).status, 401);                                  // el PIN de caja no puede cambiarla
  assert.equal((await cambiar(SEMILLA_CLAVE, 'corta')).status, 400);
  assert.equal((await cambiar(SEMILLA_CLAVE, '12345678')).status, 400);
  assert.equal((await cambiar(SEMILLA_CLAVE, SEMILLA_CLAVE)).status, 400);                        // igual a la actual
  assert.equal((await cambiar(SEMILLA_CLAVE, nueva)).status, 200);
  assert.equal((await llamar('/api/verificar-admin', { metodo: 'POST', pin: SEMILLA_CLAVE, ip: ipNueva() })).status, 401);   // la vieja ya no
  assert.equal((await llamar('/api/verificar-admin', { metodo: 'POST', pin: nueva, ip: ipNueva() })).status, 200);           // la nueva (con ñ y tilde) sí
  const ev = eventos('CAMBIO_CLAVE_ADMIN'); assert.equal(ev.length, 1);
  assert.equal(ev[0].ip, ip); assert.ok(ev[0].fecha instanceof Date);
  // dejamos la contraseña como estaba para los siguientes grupos
  assert.equal((await llamar('/api/admin/cambiar-clave', { metodo: 'POST', body: { actual: nueva, nueva: SEMILLA_CLAVE }, ip })).status, 200);
});

test('cambiar PIN de caja: solo el dueño, con su contraseña actual y PIN no obvio', async () => {
  const ip = ipNueva(), nuevo = '730194';
  const cambiar = (actual, n) => llamar('/api/admin/cambiar-pin-caja', { metodo: 'POST', body: { actual, nuevo: n }, ip });
  assert.equal((await cambiar(SEMILLA_PIN, nuevo)).status, 401);                                  // caja no puede cambiar su propio PIN
  assert.equal((await cambiar('mala', nuevo)).status, 401);
  for (const malo of ['1234', '123456', '111111', '121212', 'abcdef', '12345678901234']) assert.equal((await cambiar(SEMILLA_CLAVE, malo)).status, 400, malo);
  assert.equal((await cambiar(SEMILLA_CLAVE, nuevo)).status, 200);
  assert.equal((await llamar('/api/verificar-pin', { metodo: 'POST', pin: SEMILLA_PIN, ip: ipNueva() })).status, 401);
  assert.equal((await llamar('/api/verificar-pin', { metodo: 'POST', pin: nuevo, ip: ipNueva() })).status, 200);
  assert.equal(eventos('CAMBIO_PIN_CAJA').length, 1); assert.equal(eventos('CAMBIO_PIN_CAJA')[0].ip, ip);
});

let codigo;     // código de recuperación vigente (lo van pasando los tests siguientes)
test('código de recuperación: se genera, se guarda solo con hash y la API nunca lo muestra', async () => {
  // Desde V1.1 el panel ya no tiene ruta para generarlo: nace con «npm run reset-admin», que usa esta misma función.
  const ip = ipNueva();
  codigo = await C.nuevoCodigo(credenciales());
  assert.match(codigo, /^[A-Z2-9]{4}(-[A-Z2-9]{4}){3}$/);
  assert.ok(!JSON.stringify(credenciales().docs).includes(codigo.replace(/-/g, '')));            // en la base solo queda el hash
  const s = await llamar('/api/admin/seguridad', { pin: SEMILLA_CLAVE, ip });
  assert.equal(s.tiene_codigo, true); assert.ok(!JSON.stringify(s).includes(codigo));            // la API nunca lo muestra
  assert.equal((await llamar('/api/admin/generar-codigo', { metodo: 'POST', body: { actual: SEMILLA_CLAVE }, ip })).status, 404);   // la ruta antigua ya no existe
});

test('recuperar contraseña con el código: una sola vez, entrega código nuevo, deja bitácora', async () => {
  const ip = ipNueva(), nueva = 'Fuego_Vivo-4096q';
  const rec = (c, n) => llamar('/api/admin/recuperar', { metodo: 'POST', body: { codigo: c, nueva: n }, ip });     // sin contraseña ni sesión
  assert.equal((await rec(codigo, 'debil')).status, 400);                                         // contraseña débil: NO gasta el código
  assert.equal((await rec('AAAA-BBBB-CCCC-DDDD', nueva)).status, 401);                            // código equivocado
  assert.equal(eventos('RECUPERACION_FALLIDA').length, 1);
  const ok = await rec(codigo.toLowerCase().replace(/-/g, ' '), nueva);                           // tolera minúsculas y espacios
  assert.equal(ok.status, 200); assert.notEqual(ok.codigo, codigo);
  assert.equal((await llamar('/api/verificar-admin', { metodo: 'POST', pin: nueva, ip: ipNueva() })).status, 200);
  assert.equal((await llamar('/api/verificar-admin', { metodo: 'POST', pin: SEMILLA_CLAVE, ip: ipNueva() })).status, 401);
  assert.equal((await rec(codigo, 'Otra_Clave-5821z')).status, 401);                              // el código usado ya no sirve
  const ev = eventos('RECUPERACION_USADA'); assert.equal(ev.length, 1); assert.equal(ev[0].ip, ip);
  codigo = ok.codigo;
  assert.equal((await rec(codigo, 'Otra_Clave-5821z')).status, 200);                              // el nuevo sirve (una vez)
});

test('recuperación: tras 5 códigos equivocados se bloquea la IP', async () => {
  const ip = ipNueva();
  for (let i = 0; i < 5; i++) assert.equal((await llamar('/api/admin/recuperar', { metodo: 'POST', body: { codigo: 'AAAA-BBBB-CCCC-DDDD', nueva: 'Fuego_Vivo-4096q' }, ip })).status, 401);
  assert.equal((await llamar('/api/admin/recuperar', { metodo: 'POST', body: { codigo: 'AAAA-BBBB-CCCC-DDDD', nueva: 'Fuego_Vivo-4096q' }, ip })).status, 429);
});

test('reset-admin (desde tu PC): deja contraseña, código y —si se pide— PIN de caja nuevos', async () => {
  const { reiniciar } = require('../scripts/reset-admin');
  const r = await reiniciar(compartida, { conCaja: true });
  const ip = ipNueva();
  assert.equal((await llamar('/api/verificar-admin', { metodo: 'POST', pin: r.clave, ip })).status, 200);
  assert.equal((await llamar('/api/verificar-pin', { metodo: 'POST', pin: r.pin, ip })).status, 200);
  assert.equal((await llamar('/api/verificar-admin', { metodo: 'POST', pin: 'Fuego_Vivo-4096q', ip })).status, 401);      // la que tenía el dueño ya no
  assert.equal((await llamar('/api/admin/recuperar', { metodo: 'POST', body: { codigo: r.codigo, nueva: 'Brasa_Nueva-1357k' }, ip })).status, 200);  // el código nuevo funciona
  assert.equal(eventos('RESET_ADMIN_PC').length, 1);
  assert.match(eventos('RESET_ADMIN_PC')[0].ip, /^PC local/);
  const bit = await llamar('/api/admin/seguridad', { pin: 'Brasa_Nueva-1357k', ip });
  assert.ok(bit.bitacora.length >= 8 && bit.bitacora[0].fecha && bit.bitacora[0].ip);
  assert.ok(bit.bitacora.every(b => ['CAMBIO_CLAVE_ADMIN', 'CAMBIO_PIN_CAJA', 'CODIGO_RECUPERACION_NUEVO', 'RECUPERACION_USADA', 'RECUPERACION_FALLIDA', 'RESET_ADMIN_PC', 'CREDENCIALES_INICIALES'].includes(b.accion)));
  assert.ok(!JSON.stringify(bit).includes('Brasa_Nueva') && !JSON.stringify(bit).includes(r.codigo));                   // la bitácora nunca guarda claves
});

test('reset-admin rechaza contraseñas o PIN débiles', async () => {
  const { reiniciar } = require('../scripts/reset-admin');
  await assert.rejects(reiniciar(compartida, { clave: 'debil' }));
  await assert.rejects(reiniciar(compartida, { conCaja: true, pin: '123456' }));
});

test('sin claves válidas ni en la base ni en el .env, el servidor se niega a arrancar y explica qué hacer', () => {
  const r = spawnSync(process.execPath, [path.join(__dirname, 'arranque-sin-claves.js')], {
    encoding: 'utf8', env: { ...process.env, ADMIN_PASSWORD: '', ADMIN_PIN: '9999', STAFF_PIN: '1234', PORT: '38918' }, timeout: 20000,
  });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /npm run reset-admin/);
  assert.match(r.stderr, /STAFF_PIN del \.env no sirve/);
});
