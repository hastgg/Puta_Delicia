'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../lib/credenciales');
const { BaseFalsa } = require('./mongo-falso');

test('hash: no guarda en claro, usa sal propia y verifica', async () => {
  const h1 = await C.hashear('Secreto*Largo9'), h2 = await C.hashear('Secreto*Largo9');
  assert.notEqual(h1, h2);                         // sal distinta cada vez
  assert.ok(!h1.includes('Secreto'));
  assert.equal(await C.verificar('Secreto*Largo9', h1), true);
  assert.equal(await C.verificar('secreto*largo9', h1), false);
  assert.equal(await C.verificar('x', 'basura'), false);
});

test('contraseña del dueño: acepta fuertes, rechaza débiles', () => {
  for (const ok of ['Put4_D3l1c14*', 'Brasa#Lenta-7731', 'xK9$mPq2!vLw', 'Mi.Parrilla_Es_2026']) assert.equal(C.validarClaveAdmin(ok).ok, true, ok);
  const malas = {
    corta: 'Ab1*xyz', sinMayus: 'putadelicia*77x', sinMinus: 'PUTADELICIA*77X', sinNumero: 'Puta_Delicia*Xx', sinSimbolo: 'PutaDelicia7788',
    repetida: 'Pu!aaaDel1cia', secuencia: 'Brasa*1234xYz', secLetras: 'Abcd*Brasa77x', comun: 'P4ssw0rd*Segura', comun2: 'Admin*Local2026', espacios: ' Brasa*Lenta77 ', vacia: '', noTexto: null,
  };
  for (const [n, c] of Object.entries(malas)) assert.equal(C.validarClaveAdmin(c).ok, false, n);
});

test('PIN de caja: mínimo 6 dígitos y sin combinaciones obvias', () => {
  for (const ok of ['482917', '70391846', '905137', '3827461']) assert.equal(C.validarPinCaja(ok).ok, true, ok);
  const malos = ['1234', '12345', '123456', '654321', '000000', '111111', '121212', '123123', '112233', '696969', '123321', '555512', '98765x', '12 456', '1234567890123', '', 'abcdef', '246810', '4545454545'];
  for (const p of malos) assert.equal(C.validarPinCaja(p).ok, false, p);
});

test('generadores: siempre cumplen las reglas', () => {
  for (let i = 0; i < 200; i++) { assert.equal(C.validarClaveAdmin(C.generarClaveAdmin()).ok, true); assert.equal(C.validarPinCaja(C.generarPinCaja()).ok, true); }
  const c = C.generarCodigo();
  assert.match(c, /^[A-HJ-NP-Z2-9]{4}(-[A-HJ-NP-Z2-9]{4}){3}$/);
  assert.equal(new Set(Array.from({ length: 50 }, C.generarCodigo)).size, 50);
  assert.equal(C.codigoValido(c.toLowerCase().replace(/-/g, ' ')), true);     // tolera minúsculas, espacios y guiones
});

test('código de recuperación: sirve UNA vez y entrega uno nuevo', async () => {
  const col = new BaseFalsa().collection('credenciales');
  await C.fijarSecreto(col, 'admin', 'Clave*Inicial77');
  const c1 = await C.nuevoCodigo(col);
  const r = await C.usarCodigo(col, c1, 'Clave*Nueva88x');
  assert.equal(r.ok, true);
  assert.notEqual(r.codigo, c1);
  const doc = await col.findOne({ _id: 'admin' });
  assert.equal(await C.verificar('Clave*Nueva88x', doc.hash), true);
  assert.equal(await C.verificar('Clave*Inicial77', doc.hash), false);
  assert.ok(!JSON.stringify(doc).includes(c1.replace(/-/g, '')));            // el código no queda en claro
  assert.equal((await C.usarCodigo(col, c1, 'Otra*Clave99x')).motivo, 'incorrecto');   // el viejo ya no sirve
  assert.equal((await C.usarCodigo(col, r.codigo, 'Otra*Clave99x')).ok, true);          // el nuevo sí (una vez)
});

test('código de recuperación: dos usos simultáneos, solo pasa uno', async () => {
  const col = new BaseFalsa().collection('credenciales');
  await C.fijarSecreto(col, 'admin', 'Clave*Inicial77');
  const c = await C.nuevoCodigo(col);
  const rs = await Promise.all([C.usarCodigo(col, c, 'Clave*Uno1234x'), C.usarCodigo(col, c, 'Clave*Dos5678x')]);
  assert.equal(rs.filter(r => r.ok).length, 1);
  assert.equal(rs.find(r => !r.ok).motivo, 'usado');
});

test('sin código generado o con código mal escrito', async () => {
  const col = new BaseFalsa().collection('credenciales');
  await C.fijarSecreto(col, 'admin', 'Clave*Inicial77');
  assert.equal((await C.usarCodigo(col, 'AAAA-BBBB-CCCC-DDDD', 'Clave*Nueva88x')).motivo, 'sin_codigo');
  await C.nuevoCodigo(col);
  assert.equal((await C.usarCodigo(col, 'AAAA-BBBB-CCCC-DDDD', 'Clave*Nueva88x')).motivo, 'incorrecto');
  assert.equal((await C.usarCodigo(col, 'corto', 'Clave*Nueva88x')).motivo, 'incorrecto');
});
