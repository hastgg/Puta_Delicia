'use strict';
/**
 * Pruebas del orden de la lista de clientes del panel (lib/estadisticas.js → ordenarClientes).
 * Es una función pura: recibe filas y devuelve otra lista, sin tocar la original.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('../lib/estadisticas');

const f = (id, nombre, extra = {}) => ({ id, nombre_norm: nombre, ultima_visita: null, general: null, n: 0, ...extra });
const ids = lista => lista.map(x => x.id);

test('por nombre: A–Z, y si el nombre es igual desempata por código', () => {
  const l = [f('C3', 'carlos'), f('A1', 'ana'), f('B2', 'ana')];
  assert.deepEqual(ids(E.ordenarClientes(l, 'nombre')), ['A1', 'B2', 'C3']);
});

test('un orden desconocido se trata como nombre', () => {
  const l = [f('2', 'beto'), f('1', 'ana')];
  assert.deepEqual(ids(E.ordenarClientes(l, 'cualquier-cosa')), ['1', '2']);
  assert.deepEqual(ids(E.ordenarClientes(l, undefined)), ['1', '2']);
});

test('calif: mejor calificado primero; los que nunca calificaron van al final', () => {
  const l = [f('a', 'ana'), f('b', 'beto', { general: 3.5, n: 2 }), f('c', 'carla', { general: 5, n: 1 }), f('d', 'dani', { general: 4.2, n: 4 })];
  assert.deepEqual(ids(E.ordenarClientes(l, 'calif')), ['c', 'd', 'b', 'a']);
});

test('calif: con el mismo promedio gana quien tiene más calificaciones, y luego el nombre', () => {
  const l = [f('x', 'zoe', { general: 4, n: 2 }), f('y', 'ana', { general: 4, n: 5 }), f('z', 'bea', { general: 4, n: 2 })];
  assert.deepEqual(ids(E.ordenarClientes(l, 'calif')), ['y', 'z', 'x']);
});

test('calif: un promedio de 0 cuenta como calificado (no se confunde con «sin calificar»)', () => {
  const l = [f('a', 'ana'), f('b', 'beto', { general: 0, n: 1 })];
  assert.deepEqual(ids(E.ordenarClientes(l, 'calif')), ['b', 'a']);
});

test('calif: los sin calificar quedan ordenados por nombre entre ellos', () => {
  const l = [f('c', 'carla'), f('a', 'ana'), f('b', 'beto', { general: 2, n: 1 })];
  assert.deepEqual(ids(E.ordenarClientes(l, 'calif')), ['b', 'a', 'c']);
});

test('visita: primero quien lleva más tiempo sin venir; quien nunca vino va al final', () => {
  const l = [
    f('a', 'ana', { ultima_visita: new Date('2026-11-10T20:00:00Z') }),
    f('b', 'beto'),
    f('c', 'carla', { ultima_visita: new Date('2026-09-01T20:00:00Z') }),
    f('d', 'dani', { ultima_visita: new Date('2026-11-17T20:00:00Z') }),
  ];
  assert.deepEqual(ids(E.ordenarClientes(l, 'visita')), ['c', 'a', 'd', 'b']);
});

test('visita: las fechas pueden venir como texto ISO (así llegan de Mongo/JSON)', () => {
  const l = [f('a', 'ana', { ultima_visita: '2026-11-10T20:00:00Z' }), f('b', 'beto', { ultima_visita: '2026-01-02T20:00:00Z' })];
  assert.deepEqual(ids(E.ordenarClientes(l, 'visita')), ['b', 'a']);
});

test('visita: la misma fecha desempata por nombre', () => {
  const d = new Date('2026-11-10T20:00:00Z');
  const l = [f('b', 'beto', { ultima_visita: d }), f('a', 'ana', { ultima_visita: d })];
  assert.deepEqual(ids(E.ordenarClientes(l, 'visita')), ['a', 'b']);
});

test('no modifica la lista original y funciona con una lista vacía', () => {
  const l = [f('b', 'beto'), f('a', 'ana')];
  E.ordenarClientes(l, 'nombre');
  assert.deepEqual(ids(l), ['b', 'a']);
  assert.deepEqual(E.ordenarClientes([], 'calif'), []);
});
