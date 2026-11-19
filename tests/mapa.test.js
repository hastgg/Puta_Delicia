'use strict';
/**
 * Pruebas del mapa de calor día × hora (lib/estadisticas.js → diaSemanaDe y calcular().mapa).
 * Lo delicado: el día de la semana se cuenta en hora de Bogotá (UTC-5), no en UTC.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('../lib/estadisticas');

const v = (iso, id = 'A1') => ({ id, fecha: new Date(iso) });
const base = { ini: '2026-11-16', fin: '2026-11-22' };            // lunes 16 → domingo 22 de nov de 2026
const suma = m => m.flat().reduce((a, b) => a + b, 0);

test('diaSemanaDe: lunes = 0 … domingo = 6', () => {
  assert.equal(E.diaSemanaDe(new Date('2026-11-16T17:00:00Z')), 0);   // lunes
  assert.equal(E.diaSemanaDe(new Date('2026-11-19T17:00:00Z')), 3);   // jueves
  assert.equal(E.diaSemanaDe(new Date('2026-11-22T17:00:00Z')), 6);   // domingo
});

test('diaSemanaDe: el día cambia a las 5:00 UTC (medianoche de Bogotá), no a las 0:00 UTC', () => {
  assert.equal(E.diaSemanaDe(new Date('2026-11-22T04:59:00Z')), 5);   // sábado 11:59 p. m. en Bogotá
  assert.equal(E.diaSemanaDe(new Date('2026-11-22T05:00:00Z')), 6);   // domingo 12:00 a. m.
  assert.equal(E.diaSemanaDe(new Date('2026-11-23T04:59:00Z')), 6);   // domingo 11:59 p. m.
  assert.equal(E.diaSemanaDe(new Date('2026-11-23T05:00:00Z')), 0);   // lunes 12:00 a. m. (cambia de semana)
});

test('diaSemanaDe: acepta texto ISO y cruza el año', () => {
  assert.equal(E.diaSemanaDe('2026-01-01T15:00:00Z'), 3);             // jueves 1 de enero de 2026
  assert.equal(E.diaSemanaDe('2027-01-01T04:00:00Z'), 3);             // aún es jueves 31 dic en Bogotá
});

test('mapa sin visitas: 7 filas × 24 horas, todo en cero', () => {
  const { mapa } = E.calcular(base);
  assert.equal(mapa.length, 7);
  assert.ok(mapa.every(f => f.length === 24 && f.every(n => n === 0)));
});

test('mapa: cada visita cae en su día y su hora de Bogotá', () => {
  const { mapa } = E.calcular({ ...base, visitas: [
    v('2026-11-20T00:30:00Z'),      // jueves 19, 7:30 p. m. en Bogotá
    v('2026-11-20T00:50:00Z', 'B2'),// jueves 19, 7:50 p. m.
    v('2026-11-22T04:59:00Z'),      // sábado 21, 11:59 p. m.
    v('2026-11-22T05:00:00Z'),      // domingo 22, 12:00 a. m.
  ] });
  assert.equal(mapa[3][19], 2);
  assert.equal(mapa[5][23], 1);
  assert.equal(mapa[6][0], 1);
  assert.equal(suma(mapa), 4);
});

test('mapa: la suma de cada columna cuadra con las horas, y el total con las visitas', () => {
  const visitas = [];
  for (let i = 0; i < 60; i++) visitas.push(v(new Date(Date.UTC(2026, 10, 16, 14, 0) + i * 5.3 * 3600000).toISOString(), 'C' + (i % 7)));
  const r = E.calcular({ ...base, visitas });
  for (let h = 0; h < 24; h++) assert.equal(r.mapa.reduce((a, f) => a + f[h], 0), r.horas[h]);
  assert.equal(suma(r.mapa), r.visitas);
});

test('mapa: el mismo cliente que vuelve en dos días distintos cuenta en cada uno', () => {
  const { mapa } = E.calcular({ ...base, visitas: [v('2026-11-17T23:00:00Z'), v('2026-11-18T23:00:00Z')] });
  assert.equal(mapa[1][18], 1);                                       // martes 6 p. m.
  assert.equal(mapa[2][18], 1);                                       // miércoles 6 p. m.
});
