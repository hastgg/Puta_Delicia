'use strict';
/**
 * Pruebas de lib/estadisticas.js (los números del panel del dueño).
 * Son funciones puras: no necesitan Mongo ni servidor. Los casos más delicados son los de la medianoche de Bogotá (UTC-5),
 * donde un dato a las 11:59 p. m. y otro a las 12:00 a. m. deben caer en días distintos.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('../lib/estadisticas');

const d = iso => new Date(iso);
const suma = (arr, f) => arr.reduce((t, x) => t + f(x), 0);

/* ---------- Hora de Bogotá ---------- */

test('ymdDe y horaDe: el día cambia a las 5:00 UTC (medianoche de Bogotá)', () => {
  assert.equal(E.ymdDe(d('2026-11-18T04:59:59Z')), '2026-11-17');
  assert.equal(E.horaDe(d('2026-11-18T04:59:59Z')), 23);
  assert.equal(E.ymdDe(d('2026-11-18T05:00:00Z')), '2026-11-18');
  assert.equal(E.horaDe(d('2026-11-18T05:00:00Z')), 0);
  assert.equal(E.horaDe(d('2026-11-18T17:30:00Z')), 12);               // mediodía local
});

test('ymdDe: el cambio de año también respeta la hora de Bogotá', () => {
  assert.equal(E.ymdDe(d('2027-01-01T04:59:59Z')), '2026-12-31');
  assert.equal(E.ymdDe(d('2027-01-01T05:00:00Z')), '2027-01-01');
});

test('ymdDe: acepta fechas en texto ISO igual que objetos Date', () => {
  assert.equal(E.ymdDe('2026-11-18T05:00:00Z'), '2026-11-18');
});

test('inicioDia: es la medianoche de Bogotá (5:00 UTC)', () => {
  assert.equal(E.inicioDia('2026-11-18').toISOString(), '2026-11-18T05:00:00.000Z');
});

/* ---------- Fechas ---------- */

test('sumarDias: cruza mes, año y febrero bisiesto', () => {
  assert.equal(E.sumarDias('2026-11-30', 1), '2026-12-01');
  assert.equal(E.sumarDias('2026-12-31', 1), '2027-01-01');
  assert.equal(E.sumarDias('2028-02-28', 1), '2028-02-29');             // 2028 es bisiesto
  assert.equal(E.sumarDias('2026-02-28', 1), '2026-03-01');             // 2026 no
  assert.equal(E.sumarDias('2026-03-01', -1), '2026-02-28');
  assert.equal(E.sumarDias('2026-11-18', 0), '2026-11-18');
  assert.equal(E.sumarDias('2026-11-18', -6), '2026-11-12');
});

test('ymdValido: acepta fechas reales y rechaza todo lo demás', () => {
  for (const ok of ['2026-11-18', '2028-02-29', '2026-12-31']) assert.equal(E.ymdValido(ok), true, ok);
  for (const mal of ['2026-02-29', '2026-13-01', '2026-11-31', '2026-00-10', '26-11-18', '2026-1-1', '2026-11-18T00:00', '', null, undefined, 20261118])
    assert.equal(E.ymdValido(mal), false, String(mal));
});

/* ---------- Periodos (día, semana lun–dom, mes, año) ---------- */

test('periodo: día', () => {
  assert.deepEqual(E.periodo('dia', '2026-11-18'), { ini: '2026-11-18', fin: '2026-11-18' });
});

test('periodo: la semana va de lunes a domingo', () => {
  // 2026-11-18 es miércoles
  assert.deepEqual(E.periodo('semana', '2026-11-18'), { ini: '2026-11-16', fin: '2026-11-22' });
  assert.deepEqual(E.periodo('semana', '2026-11-16'), { ini: '2026-11-16', fin: '2026-11-22' });   // lunes
  assert.deepEqual(E.periodo('semana', '2026-11-22'), { ini: '2026-11-16', fin: '2026-11-22' });   // domingo: pertenece a la semana que termina
  assert.deepEqual(E.periodo('semana', '2026-11-23'), { ini: '2026-11-23', fin: '2026-11-29' });   // el lunes siguiente abre otra
});

test('periodo: una semana puede cruzar de mes y de año', () => {
  assert.deepEqual(E.periodo('semana', '2026-12-02'), { ini: '2026-11-30', fin: '2026-12-06' });
  assert.deepEqual(E.periodo('semana', '2027-01-01'), { ini: '2026-12-28', fin: '2027-01-03' });
});

test('periodo: mes (febrero normal, bisiesto y diciembre)', () => {
  assert.deepEqual(E.periodo('mes', '2026-11-18'), { ini: '2026-11-01', fin: '2026-11-30' });
  assert.deepEqual(E.periodo('mes', '2026-02-10'), { ini: '2026-02-01', fin: '2026-02-28' });
  assert.deepEqual(E.periodo('mes', '2028-02-10'), { ini: '2028-02-01', fin: '2028-02-29' });
  assert.deepEqual(E.periodo('mes', '2026-12-31'), { ini: '2026-12-01', fin: '2026-12-31' });
});

test('periodo: año', () => {
  assert.deepEqual(E.periodo('anio', '2026-11-18'), { ini: '2026-01-01', fin: '2026-12-31' });
});

/* ---------- Claves de la serie ---------- */

test('claves por día: incluye los dos extremos y cruza meses cortos', () => {
  assert.deepEqual(E.claves('2026-11-16', '2026-11-18', 'dia'), ['2026-11-16', '2026-11-17', '2026-11-18']);
  assert.deepEqual(E.claves('2026-11-18', '2026-11-18', 'dia'), ['2026-11-18']);
  assert.deepEqual(E.claves('2026-02-27', '2026-03-02', 'dia'), ['2026-02-27', '2026-02-28', '2026-03-01', '2026-03-02']);
});

test('claves por mes: un mes, cambio de año y los 12 meses del rango «12 meses»', () => {
  assert.deepEqual(E.claves('2026-11-12', '2026-11-18', 'mes'), ['2026-11']);
  assert.deepEqual(E.claves('2025-11-18', '2026-02-03', 'mes'), ['2025-11', '2025-12', '2026-01', '2026-02']);
  const doce = E.claves('2025-12-01', '2026-11-18', 'mes');
  assert.equal(doce.length, 12);
  assert.equal(doce[0], '2025-12');
  assert.equal(doce[11], '2026-11');
});

/* ---------- calcular: visitas, registros, horas ---------- */

test('calcular sin datos: todo en cero, serie completa y sin promedios', () => {
  const r = E.calcular({ ini: '2026-11-16', fin: '2026-11-18' });
  assert.equal(r.registros, 0); assert.equal(r.visitas, 0); assert.equal(r.unicos, 0); assert.equal(r.canjes, 0);
  assert.equal(r.horas.length, 24);
  assert.ok(r.horas.every(h => h === 0));
  assert.deepEqual(r.serie.map(s => s.k), ['2026-11-16', '2026-11-17', '2026-11-18']);
  assert.ok(r.serie.every(s => s.registros === 0 && s.visitas === 0 && s.unicos === 0));
  assert.equal(r.calif.n, 0);
  for (const c of ['general', 'servicio', 'comida', 'lugar']) assert.equal(r.calif[c], null, c);
  assert.equal(r.calif.tasa_respuesta, null);
  assert.deepEqual(r.calif.dist.general, [0, 0, 0, 0, 0]);
});

test('calcular: las 11:59 p. m. y las 12:00 a. m. de Bogotá caen en días y horas distintos', () => {
  const r = E.calcular({
    ini: '2026-11-17', fin: '2026-11-18',
    visitas: [
      { fecha: d('2026-11-18T04:59:59Z'), id: 'a' },      // 17 nov 11:59 p. m.
      { fecha: d('2026-11-18T05:00:00Z'), id: 'a' },      // 18 nov 12:00 a. m.
      { fecha: d('2026-11-18T05:30:00Z'), id: 'b' },      // 18 nov 12:30 a. m.
      { fecha: d('2026-11-18T15:00:00Z'), id: 'a' },      // 18 nov 10:00 a. m.
    ],
    registros: [{ fecha_registro: d('2026-11-18T04:59:59Z') }, { fecha_registro: d('2026-11-18T05:00:00Z') }],
  });
  assert.equal(r.visitas, 4);
  assert.equal(r.unicos, 2);                               // a y b
  assert.equal(r.registros, 2);
  const [dia17, dia18] = r.serie;
  assert.deepEqual([dia17.visitas, dia17.unicos, dia17.registros], [1, 1, 1]);
  assert.deepEqual([dia18.visitas, dia18.unicos, dia18.registros], [3, 2, 1]);      // «a» visitó 2 veces el 18 pero cuenta 1 como distinto
  assert.equal(r.horas[23], 1);
  assert.equal(r.horas[0], 2);
  assert.equal(r.horas[10], 1);
  assert.equal(suma(r.horas, x => x), 4);
});

test('calcular por mes: agrupa por mes y el cliente que vuelve cuenta una vez por mes', () => {
  const r = E.calcular({
    ini: '2026-10-01', fin: '2026-11-18', bucket: 'mes',
    visitas: [
      { fecha: d('2026-11-01T04:00:00Z'), id: 'a' },      // 31 oct 11:00 p. m. → octubre
      { fecha: d('2026-11-01T05:00:00Z'), id: 'a' },      // 1 nov 12:00 a. m. → noviembre
    ],
  });
  assert.deepEqual(r.serie.map(s => s.k), ['2026-10', '2026-11']);
  assert.deepEqual(r.serie.map(s => s.visitas), [1, 1]);
  assert.deepEqual(r.serie.map(s => s.unicos), [1, 1]);
  assert.equal(r.unicos, 1);                               // en total es un solo cliente
});

test('calcular: un dato fuera del rango no rompe la serie', () => {
  const r = E.calcular({ ini: '2026-11-16', fin: '2026-11-18', visitas: [{ fecha: d('2026-11-25T15:00:00Z'), id: 'z' }], registros: [{ fecha_registro: d('2026-11-01T15:00:00Z') }] });
  assert.equal(r.serie.length, 3);
  assert.ok(r.serie.every(s => s.visitas === 0 && s.registros === 0));
});

test('calcular: los canjes pasan tal cual', () => {
  assert.equal(E.calcular({ ini: '2026-11-18', fin: '2026-11-18', canjes: 7 }).canjes, 7);
});

test('calcular: las sumas de la serie y de las horas cuadran con los totales (datos variados)', () => {
  let semilla = 12345;                                      // generador fijo: la prueba da siempre lo mismo
  const azar = n => { semilla = (semilla * 1103515245 + 12345) % 2147483648; return semilla % n; };
  const ini = '2026-11-01', fin = '2026-11-30', t0 = E.inicioDia(ini).getTime(), t1 = E.inicioDia(E.sumarDias(fin, 1)).getTime();
  const enRango = () => new Date(t0 + azar(t1 - t0 - 1));
  const visitas = Array.from({ length: 500 }, () => ({ fecha: enRango(), id: 'c' + azar(40) }));
  const registros = Array.from({ length: 80 }, () => ({ fecha_registro: enRango() }));
  const r = E.calcular({ ini, fin, visitas, registros });
  assert.equal(r.serie.length, 30);
  assert.equal(suma(r.serie, s => s.visitas), 500);
  assert.equal(suma(r.serie, s => s.registros), 80);
  assert.equal(suma(r.horas, x => x), 500);
  assert.equal(r.unicos, new Set(visitas.map(v => v.id)).size);
  assert.ok(r.serie.every(s => s.unicos <= s.visitas));
  assert.ok(r.unicos <= r.visitas);
});

/* ---------- calcular: calificaciones ---------- */

const AHORA = d('2026-11-18T12:00:00Z');
const en = ms => new Date(AHORA.getTime() + ms);

test('calificaciones: promedios, distribución y tasa de respuesta', () => {
  const cals = [
    { estado: 'CALIFICADA', general: 5, servicio: 5, comida: 5, lugar: 4 },
    { estado: 'CALIFICADA', general: 4, servicio: 4, comida: 5, lugar: 5 },
    { estado: 'PENDIENTE', vence: en(3600000) },                 // aún puede calificar: no cuenta como «no calificó»
    { estado: 'NO_CALIFICO', vence: en(-86400000) },
    { estado: 'PENDIENTE', vence: en(-3600000) },                // venció: ya cuenta como «no calificó»
  ];
  const { calif } = E.calcular({ ini: '2026-11-18', fin: '2026-11-18', cals, ahora: AHORA });
  assert.equal(calif.n, 2);
  assert.equal(calif.general, 4.5);
  assert.equal(calif.servicio, 4.5);
  assert.equal(calif.comida, 5);
  assert.equal(calif.lugar, 4.5);
  assert.equal(calif.tasa_respuesta, 0.5);                       // 2 calificadas de 4 vencidas (la pendiente vigente se excluye)
  assert.deepEqual(calif.dist.general, [0, 0, 0, 1, 1]);
  assert.deepEqual(calif.dist.servicio, [0, 0, 0, 1, 1]);
  assert.deepEqual(calif.dist.comida, [0, 0, 0, 0, 2]);
  assert.deepEqual(calif.dist.lugar, [0, 0, 0, 1, 1]);
});

test('calificaciones: la tasa se redondea a 3 decimales', () => {
  const cals = [
    { estado: 'CALIFICADA', general: 5 }, { estado: 'CALIFICADA', general: 4 },
    { estado: 'NO_CALIFICO', vence: en(-1000) }, { estado: 'PENDIENTE', vence: en(60000) },
  ];
  assert.equal(E.calcular({ ini: '2026-11-18', fin: '2026-11-18', cals, ahora: AHORA }).calif.tasa_respuesta, 0.667);   // 2 de 3
});

test('calificaciones: si solo hay pendientes vigentes, la tasa es null (sin dividir entre cero)', () => {
  const cals = [{ estado: 'PENDIENTE', vence: en(60000) }];
  const { calif } = E.calcular({ ini: '2026-11-18', fin: '2026-11-18', cals, ahora: AHORA });
  assert.equal(calif.tasa_respuesta, null);
  assert.equal(calif.n, 0);
});

test('calificaciones: una pendiente que vence justo ahora ya cuenta como vencida', () => {
  const cals = [{ estado: 'CALIFICADA', general: 5 }, { estado: 'PENDIENTE', vence: AHORA }];
  assert.equal(E.calcular({ ini: '2026-11-18', fin: '2026-11-18', cals, ahora: AHORA }).calif.tasa_respuesta, 0.5);     // 1 de 2
});

test('calificaciones: «vence» puede venir como texto ISO (así llega de Mongo/JSON)', () => {
  const cals = [{ estado: 'PENDIENTE', vence: en(60000).toISOString() }, { estado: 'CALIFICADA', general: 4 }];
  assert.equal(E.calcular({ ini: '2026-11-18', fin: '2026-11-18', cals, ahora: AHORA }).calif.tasa_respuesta, 1);       // la pendiente vigente no cuenta
});

test('calificaciones: el promedio se redondea a 2 decimales', () => {
  const cals = [5, 4, 4].map(general => ({ estado: 'CALIFICADA', general }));
  assert.equal(E.calcular({ ini: '2026-11-18', fin: '2026-11-18', cals, ahora: AHORA }).calif.general, 4.33);
});

test('calificaciones: valores raros se acomodan en 1–5 y los no numéricos se ignoran', () => {
  const cals = [0.4, 6, 3.4, 4.5].map(general => ({ estado: 'CALIFICADA', general }));
  const { calif } = E.calcular({ ini: '2026-11-18', fin: '2026-11-18', cals, ahora: AHORA });
  assert.deepEqual(calif.dist.general, [1, 0, 1, 0, 2]);          // 0.4→1, 6→5, 3.4→3, 4.5→5
  const malas = [{ estado: 'CALIFICADA', general: 'abc' }, { estado: 'CALIFICADA', general: NaN }, { estado: 'CALIFICADA', general: null }];
  assert.equal(E.calcular({ ini: '2026-11-18', fin: '2026-11-18', cals: malas, ahora: AHORA }).calif.n, 0);
});

test('calificaciones: si falta un aspecto, el promedio usa solo los que sí lo traen', () => {
  const cals = [{ estado: 'CALIFICADA', general: 5, servicio: 5 }, { estado: 'CALIFICADA', general: 3 }];
  const { calif } = E.calcular({ ini: '2026-11-18', fin: '2026-11-18', cals, ahora: AHORA });
  assert.equal(calif.general, 4);
  assert.equal(calif.servicio, 5);
  assert.equal(calif.comida, null);
});

/* ---------- resumenCalificaciones (ficha de un cliente) ---------- */

test('resumenCalificaciones: promedios, y solo los comentarios que traen texto', () => {
  const r = E.resumenCalificaciones([
    { fecha: d('2026-11-17T20:00:00Z'), general: 5, servicio: 5, comida: 4, lugar: 5, comentario: '  Buenísimo  ' },
    { fecha: d('2026-11-16T20:00:00Z'), general: 3, comentario: '   ' },
    { fecha: d('2026-11-15T20:00:00Z'), general: 4 },
    { estado: 'PENDIENTE', vence: en(60000) },
  ]);
  assert.equal(r.n, 3);
  assert.equal(r.general, 4);
  assert.equal(r.comentarios.length, 1);
  assert.equal(r.comentarios[0].comentario, '  Buenísimo  ');
  assert.equal(r.comentarios[0].general, 5);
});

test('resumenCalificaciones: sin calificaciones no inventa nada', () => {
  const r = E.resumenCalificaciones([]);
  assert.equal(r.n, 0);
  assert.equal(r.general, null);
  assert.deepEqual(r.comentarios, []);
});

/* ---------- redondear ---------- */

test('redondear: decimales, null y valores exactos', () => {
  assert.equal(E.redondear(4.3333), 4.33);
  assert.equal(E.redondear(0.6666, 3), 0.667);
  assert.equal(E.redondear(null), null);
  assert.equal(E.redondear(5), 5);
});
