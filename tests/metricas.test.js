'use strict';
/**
 * Pruebas de las métricas para decidir (lib/estadisticas.js): periodo anterior, variación (▲ / ▼) y clientes que dejaron de venir.
 * Son funciones puras. Los casos delicados: cruces de mes/año, división entre cero y la medianoche de Bogotá (UTC-5).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('../lib/estadisticas');

const d = iso => new Date(iso);

/* ---------- Periodo anterior ---------- */

test('periodoAnterior: 7 días → los 7 días justo antes', () => {
  assert.deepEqual(E.periodoAnterior('2026-11-12', '2026-11-18'), { ini: '2026-11-05', fin: '2026-11-11' });
});

test('periodoAnterior: un solo día → el día anterior', () => {
  assert.deepEqual(E.periodoAnterior('2026-11-18', '2026-11-18'), { ini: '2026-11-17', fin: '2026-11-17' });
});

test('periodoAnterior: cruza mes y año, y tiene la misma duración', () => {
  const a = E.periodoAnterior('2026-01-05', '2026-01-11');
  assert.deepEqual(a, { ini: '2025-12-29', fin: '2026-01-04' });
  const largo = E.periodoAnterior('2026-02-01', '2026-03-02');          // 30 días
  assert.equal(largo.fin, '2026-01-31');
  assert.equal(largo.ini, '2026-01-02');
});

test('periodoAnterior: febrero bisiesto cuenta bien los días', () => {
  assert.deepEqual(E.periodoAnterior('2028-03-01', '2028-03-07'), { ini: '2028-02-23', fin: '2028-02-29' });
});

/* ---------- Variación ---------- */

test('variacion: sube, baja e igual', () => {
  assert.deepEqual(E.variacion(15, 10), { previo: 10, dif: 5, pct: 0.5 });
  assert.deepEqual(E.variacion(5, 10), { previo: 10, dif: -5, pct: -0.5 });
  assert.deepEqual(E.variacion(10, 10), { previo: 10, dif: 0, pct: 0 });
});

test('variacion: si antes era 0 no divide; el porcentaje es null pero la diferencia se conserva', () => {
  assert.deepEqual(E.variacion(4, 0), { previo: 0, dif: 4, pct: null });
  assert.deepEqual(E.variacion(0, 0), { previo: 0, dif: 0, pct: null });
});

test('variacion: sin dato en alguno de los dos lados (p. ej. sin calificaciones) no inventa nada', () => {
  assert.equal(E.variacion(null, 4.2), null);
  assert.equal(E.variacion(4.2, null), null);
  assert.equal(E.variacion(undefined, undefined), null);
});

test('variacion: promedios de estrellas con decimales', () => {
  assert.deepEqual(E.variacion(4.5, 4.25), { previo: 4.25, dif: 0.25, pct: 0.059 });
  assert.equal(E.variacion(4.1, 4.3).dif, -0.2);
});

test('variacion: el porcentaje se redondea a 3 decimales (12,3 %)', () => {
  assert.equal(E.variacion(100, 89).pct, 0.124);
});

/* ---------- Días sin venir ---------- */

test('diasDesde: la misma noche, 11:59 p. m. y 12:00 a. m. de Bogotá, son días distintos', () => {
  const ult = d('2026-11-18T04:59:00Z');                                // 17 nov, 11:59 p. m. en Bogotá
  assert.equal(E.diasDesde(ult, d('2026-11-18T04:59:30Z')), 0);         // aún es 17 nov
  assert.equal(E.diasDesde(ult, d('2026-11-18T05:00:00Z')), 1);         // ya es 18 nov
});

test('diasDesde: no depende de la hora del día, solo del calendario', () => {
  const ult = d('2026-11-01T15:00:00Z');                                // 1 nov, 10 a. m.
  assert.equal(E.diasDesde(ult, d('2026-11-18T14:00:00Z')), 17);
  assert.equal(E.diasDesde(ult, d('2026-11-18T23:00:00Z')), 17);
});

test('diasDesde: acepta texto ISO (así llega de Mongo/JSON) y cruza año', () => {
  assert.equal(E.diasDesde('2025-12-31T20:00:00Z', d('2026-01-02T17:00:00Z')), 2);
});

/* ---------- Límite de inactividad ---------- */

test('limiteInactividad: es la medianoche de Bogotá, 29 días antes de hoy', () => {
  assert.equal(E.limiteInactividad('2026-11-18', 30).toISOString(), '2026-10-20T05:00:00.000Z');
});

test('limiteInactividad coincide con diasDesde: justo en el borde de los 30 días', () => {
  const hoy = '2026-11-18', ahora = d('2026-11-18T20:00:00Z');
  const limite = E.limiteInactividad(hoy, 30);
  const ultimoDia29 = d('2026-10-20T05:00:00Z');                        // 20 oct, 12:00 a. m. → hace 29 días: todavía NO está inactivo
  const ultimoDia30 = d('2026-10-20T04:59:00Z');                        // 19 oct, 11:59 p. m. → hace 30 días: SÍ
  assert.equal(E.diasDesde(ultimoDia29, ahora), 29);
  assert.equal(E.diasDesde(ultimoDia30, ahora), 30);
  assert.equal(ultimoDia29 < limite, false);
  assert.equal(ultimoDia30 < limite, true);
});
