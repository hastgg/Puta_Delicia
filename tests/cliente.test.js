'use strict';
/**
 * Ficha de un cliente: ritmo propio, estado (al día / se está enfriando / inactivo), día y hora favoritos y visitas por mes.
 * Primero la lógica pura con fechas fijas; luego GET /api/admin/cliente/:id contra el servidor real con la base simulada.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const E = require('../lib/estadisticas');
const { MongoClientFalso, compartida } = require('./mongo-falso');

/* ---------------- Lógica pura: «ahora» fijo = jueves 19 nov 2026, 3 pm Bogotá ---------------- */
const AHORA = new Date('2026-11-19T15:00:00-05:00');
const mas = (ymd, n) => new Date(new Date(ymd + 'T00:00:00Z').getTime() + n * 86400000).toISOString().slice(0, 10);
const v = (...dias) => dias.map(d => new Date(d.includes('T') ? d + '-05:00' : d + 'T13:00:00-05:00'));

test('sin visitas: estado «sin_visitas», sin ritmo ni favoritos y 12 meses en cero', () => {
  const h = E.habitosCliente([], [], AHORA);
  assert.equal(h.estado, 'sin_visitas');
  assert.equal(h.ritmo, null);
  assert.equal(h.dias_sin_venir, null);
  assert.equal(h.dia_favorito, null);
  assert.equal(h.hora_favorita, null);
  assert.equal(h.por_mes.length, 12);
  assert.ok(h.por_mes.every(m => m.visitas === 0 && m.canjes === 0));
});

test('con 1 o 2 visitas no hay ritmo: «nuevo» si vino en el último mes, «inactivo» si no', () => {
  assert.equal(E.habitosCliente(v('2026-11-10'), [], AHORA).estado, 'nuevo');
  const dosDias = E.habitosCliente(v('2026-11-01', '2026-11-12'), [], AHORA);
  assert.deepEqual([dosDias.estado, dosDias.ritmo], ['nuevo', null]);
  assert.equal(E.habitosCliente(v('2026-09-01', '2026-09-10'), [], AHORA).estado, 'inactivo');
});

test('el ritmo es la mediana de los días entre visitas y la compara contra SU ritmo, no contra un corte fijo', () => {
  // Viene cada 12 días: 1 sep, 13 sep, 25 sep, 7 oct, 19 oct
  const base = ['2026-09-01', '2026-09-13', '2026-09-25', '2026-10-07', '2026-10-19'];
  const h = E.habitosCliente(v(...base), [], AHORA);
  assert.equal(h.ritmo, 12);
  assert.equal(h.dias_sin_venir, 31);
  assert.equal(h.limite_enfriando, 18);                                // 1,5 × su ritmo
  assert.equal(h.limite_inactivo, 36);                                 // 3 × su ritmo
  assert.equal(h.estado, 'enfriando');                                  // 31 días: para el corte fijo de 30 ya sería «inactivo»
});

test('estados según los límites de su ritmo', () => {
  // Tres visitas con 7 días de diferencia, la última en `ultima`: ritmo 7 → «activo» hasta 11 días, «enfriando» hasta 30, luego «inactivo»
  const sem = ultima => v(mas(ultima, -14), mas(ultima, -7), ultima);
  const con = ultima => E.habitosCliente(sem(ultima), [], AHORA);
  assert.equal(con('2026-11-12').estado, 'activo');                     // hace 7 días
  assert.equal(con('2026-11-08').estado, 'activo');                     // hace 11: justo en el límite
  assert.equal(con('2026-11-07').estado, 'enfriando');                  // hace 12
  assert.equal(con('2026-10-20').estado, 'enfriando');                  // hace 30: justo en el límite
  assert.equal(con('2026-10-19').estado, 'inactivo');                   // hace 31
  const raro = E.habitosCliente(v('2026-03-01', '2026-05-01', '2026-07-01', '2026-09-01'), [], AHORA);
  assert.equal(raro.ritmo, 61);
  assert.equal(raro.estado, 'activo');                                  // viene cada 2 meses: 79 días sin venir aún entra en 1,5 × 61
});

test('dos visitas el mismo día cuentan como un solo día para el ritmo', () => {
  const h = E.habitosCliente(v('2026-10-01', '2026-10-01T18:00', '2026-10-11', '2026-10-21'), [], AHORA);
  assert.equal(h.ritmo, 10);                                           // 1, 11 y 21 de octubre
  assert.equal(h.visitas, 4);
});

test('día y hora favoritos: solo cuando hay patrón', () => {
  const viernes = E.habitosCliente(v('2026-10-23', '2026-10-30', '2026-11-06', '2026-11-13', '2026-11-04'), [], AHORA);
  assert.deepEqual(viernes.dia_favorito, { d: 4, n: 4 });               // cuatro viernes de cinco visitas
  assert.deepEqual(viernes.hora_favorita, { h: 13, n: 5 });
  const disperso = E.habitosCliente(v('2026-11-02', '2026-11-04', '2026-11-06', '2026-11-08', '2026-11-10'), [], AHORA);
  assert.equal(disperso.dia_favorito, null);                            // cada visita en un día distinto: sin favorito
  assert.equal(E.habitosCliente(v('2026-11-06', '2026-11-13'), [], AHORA).dia_favorito, null);   // con 2 visitas no se afirma nada
});

test('la hora se cuenta en Bogotá, no en UTC', () => {
  const noche = E.habitosCliente(v('2026-11-06T22:30:00', '2026-11-07T21:00:00', '2026-11-13T22:45:00'), [], AHORA);
  assert.deepEqual(noche.hora_favorita, { h: 22, n: 2 });
});

test('visitas por mes: últimos 12 meses con el actual al final, canjes aparte y lo anterior se descarta', () => {
  const h = E.habitosCliente(v('2025-10-15', '2025-12-05', '2026-11-02', '2026-11-09'), [new Date('2025-12-06T12:00:00-05:00'), new Date('2026-11-09T14:00:00-05:00')], AHORA);
  assert.equal(h.por_mes.length, 12);
  assert.equal(h.por_mes[0].k, '2025-12');
  assert.equal(h.por_mes.at(-1).k, '2026-11');
  assert.deepEqual(h.por_mes[0], { k: '2025-12', visitas: 1, canjes: 1 });
  assert.deepEqual(h.por_mes.at(-1), { k: '2026-11', visitas: 2, canjes: 1 });
  assert.equal(h.por_mes.reduce((s, m) => s + m.visitas, 0), 3);        // la de oct 2025 queda fuera de la ventana
  assert.equal(h.visitas, 4);                                           // pero sí cuenta en el total
});

test('visitas por mes: cruza el año sin saltarse meses', () => {
  const h = E.habitosCliente([], [], new Date('2027-02-10T12:00:00-05:00'));
  assert.deepEqual([h.por_mes[0].k, h.por_mes[1].k, h.por_mes.at(-1).k], ['2026-03', '2026-04', '2027-02']);
});

/* ---- Tarjeta de fidelidad ---- */
test('tarjeta: progreso de la tarjeta en curso y cuánto tarda en llenar una', () => {
  // Llenó una tarjeta de 4 visitas en 9 días (1→10 oct), la canjeó y lleva 2 de la siguiente
  const visitas = v('2026-10-01', '2026-10-04', '2026-10-07', '2026-10-10', '2026-11-02', '2026-11-09');
  const canjes = [new Date('2026-10-10T20:00:00-05:00')];
  const t = E.progresoTarjeta(visitas, canjes, 4, AHORA);
  assert.deepEqual([t.actual, t.faltan, t.listo, t.listo_desde, t.listo_dias], [2, 2, false, null, null]);
  assert.deepEqual([t.tarjetas_completas, t.promedio_dias], [1, 9]);
});

test('tarjeta: cortesía lista sin canjear desde la visita que completó la meta', () => {
  const t = E.progresoTarjeta(v('2026-11-01', '2026-11-05', '2026-11-12', '2026-11-16'), [], 4, AHORA);
  assert.equal(t.listo, true);
  assert.equal(t.faltan, 0);
  assert.equal(t.listo_dias, 3);                                        // la 4.ª visita fue el 16: hace 3 días
  assert.equal(+t.listo_desde, +new Date('2026-11-16T13:00:00-05:00'));
  assert.deepEqual([t.tarjetas_completas, t.promedio_dias], [1, 15]);   // 1 → 16 de noviembre
});

test('tarjeta: promedio entre varias tarjetas; sin visitas todo en cero y sin promedio', () => {
  const visitas = v('2026-01-01', '2026-01-03', '2026-01-11', '2026-03-01', '2026-03-05', '2026-03-21');   // dos tarjetas de 3: 10 y 20 días
  const canjes = [new Date('2026-01-12T12:00:00-05:00'), new Date('2026-03-22T12:00:00-05:00')];
  const t = E.progresoTarjeta(visitas, canjes, 3, AHORA);
  assert.deepEqual([t.tarjetas_completas, t.promedio_dias, t.actual, t.faltan], [2, 15, 0, 3]);
  const vacia = E.progresoTarjeta([], [], 8, AHORA);
  assert.deepEqual([vacia.actual, vacia.faltan, vacia.listo, vacia.tarjetas_completas, vacia.promedio_dias], [0, 8, false, 0, null]);
});

/* ---- Cumpleaños ---- */
test('cumpleaños: hoy, mañana, el año que viene y datos que no sirven', () => {
  assert.deepEqual(E.proximoCumple('1990-11-19', '2026-11-19'), { dias: 0, md: '11-19' });
  assert.deepEqual(E.proximoCumple('1990-11-20', '2026-11-19'), { dias: 1, md: '11-20' });
  assert.deepEqual(E.proximoCumple('1990-11-18', '2026-11-19'), { dias: 364, md: '11-18' });     // ya pasó este año: falta casi uno
  assert.deepEqual(E.proximoCumple('1990-01-05', '2026-12-30'), { dias: 6, md: '01-05' });        // cruza de año
  assert.equal(E.proximoCumple(null, '2026-11-19'), null);
  assert.equal(E.proximoCumple('no es fecha', '2026-11-19'), null);
});

test('cumpleaños: quien nació un 29 de febrero celebra el 28 en años no bisiestos', () => {
  assert.equal(E.proximoCumple('2000-02-29', '2027-02-20').dias, 8);     // 2027 no es bisiesto: el 28
  assert.equal(E.proximoCumple('2000-02-29', '2028-02-20').dias, 9);     // 2028 sí: el 29
});

/* ---------------- Endpoint ---------------- */
const PORT = 38920, BASE = 'http://127.0.0.1:' + PORT;
const CLAVE = 'Brasa#Lenta-7731', PIN_CAJA = '482917';
const rutaMongo = require.resolve('mongodb');
require.cache[rutaMongo] = { id: rutaMongo, filename: rutaMongo, loaded: true, exports: { MongoClient: MongoClientFalso } };
let srv; const listenOrig = http.Server.prototype.listen;
http.Server.prototype.listen = function (...a) { srv = this; return listenOrig.apply(this, a); };
Object.assign(process.env, {
  MONGODB_URI: 'mongodb://falso', DATA_KEY: Buffer.alloc(32, 9).toString('base64'), PORT: String(PORT), TRUST_PROXY: '1',
  ADMIN_PASSWORD: CLAVE, STAFF_PIN: PIN_CAJA, SIMULACION: 'true',
});
delete process.env.ADMIN_PIN;

const MS_DIA = 86400000;
const hoy = new Date(Date.now() - 5 * 3600000).toISOString().slice(0, 10);
const sumar = (ymd, n) => new Date(new Date(ymd + 'T00:00:00Z').getTime() + n * MS_DIA).toISOString().slice(0, 10);
const dia = n => sumar(hoy, -n);
const bogota = (ymd, hhmm = '13:00') => new Date(`${ymd}T${hhmm}:00-05:00`);

let ipN = 0;
async function ficha(id, { pin = CLAVE } = {}) {
  const r = await fetch(BASE + '/api/admin/cliente/' + id, {
    headers: { ...(pin && { 'x-pin': encodeURIComponent(pin) }), 'x-forwarded-for': `192.0.2.${++ipN}` },
  });
  return { status: r.status, ...(await r.json().catch(() => ({}))) };
}

test.before(async () => {
  require('../server.js');
  for (let i = 0; i < 100; i++) { try { if ((await fetch(BASE + '/api/health')).ok) break; } catch {} await new Promise(r => setTimeout(r, 50)); }
  const cl = compartida.collection('clientes'), mv = compartida.collection('movimientos');
  const cliente = (id, nombre, ultima, extra = {}) => cl.insertOne({ _id: id, nombre, puntos: 2, premio_listo: false, canjes: 1, ultima_visita: ultima, fecha_registro: bogota(dia(120)), ...extra });
  // Cliente semanal: cuatro visitas con 7 días de diferencia; la última hace 20 días (para su ritmo ya es «enfriando»)
  const dias = [dia(41), dia(34), dia(27), dia(20)];
  const cumple = sumar(hoy, 3);                                                                 // cumple dentro de 3 días (año 1990)
  await cliente('PD-RITMO1', 'Rita', bogota(dias.at(-1)), { whatsapp: '573001234567', fecha_nacimiento: '1990-' + cumple.slice(5) });
  for (const d of dias) await mv.insertOne({ tipo: 'VISITA', id: 'PD-RITMO1', fecha: bogota(d) });
  await mv.insertOne({ tipo: 'CANJE', id: 'PD-RITMO1', fecha: bogota(dia(20), '14:00') });
  await mv.insertOne({ tipo: 'VISITA', id: 'PD-OTRO01', fecha: bogota(dia(1)) });             // de otro cliente: no debe colarse
  await cliente('PD-NUNCA1', 'Nico', null);
  // Calificaciones de Rita (una baja y reciente, con comentario) y de otro cliente, para el promedio de todos
  const ca = compartida.collection('calificaciones');
  await ca.insertOne({ id: 'PD-RITMO1', fecha: bogota(dia(34)), estado: 'CALIFICADA', vence: bogota(dia(34)), general: 5, servicio: 5, comida: 5, lugar: 5 });
  await ca.insertOne({ id: 'PD-RITMO1', fecha: bogota(dia(20)), estado: 'CALIFICADA', vence: bogota(dia(20)), general: 2, servicio: 2, comida: 2, lugar: 2, comentario: 'Tardaron mucho' });
  await ca.insertOne({ id: 'PD-OTRO01', fecha: bogota(dia(3)), estado: 'CALIFICADA', vence: bogota(dia(3)), general: 4, servicio: 4, comida: 4, lugar: 4 });
});
test.after(() => { srv?.closeAllConnections?.(); srv?.close(); });

test('ficha: solo con la contraseña del dueño y 404 si el cliente no existe', async () => {
  assert.equal((await ficha('PD-RITMO1', { pin: null })).status, 401);
  assert.equal((await ficha('PD-RITMO1', { pin: PIN_CAJA })).status, 401);
  assert.equal((await ficha('PD-NOEXIS')).status, 404);
});

test('ficha: devuelve los hábitos del cliente a partir de sus propias visitas', async () => {
  const r = await ficha('PD-RITMO1');
  assert.equal(r.status, 200);
  const h = r.habitos;
  assert.equal(h.visitas, 4);
  assert.equal(h.ritmo, 7);                                             // una visita cada 7 días
  assert.equal(h.dias_sin_venir, 20);
  assert.equal(h.estado, 'enfriando');
  assert.equal(h.por_mes.length, 12);
  assert.equal(h.por_mes.reduce((s, m) => s + m.visitas, 0), 4);
  assert.equal(h.por_mes.reduce((s, m) => s + m.canjes, 0), 1);
  assert.equal(h.por_mes.at(-1).k, hoy.slice(0, 7));
  assert.deepEqual(h.dia_favorito.n, 4);                                // las cuatro visitas caen el mismo día de la semana
});

test('ficha: un cliente que nunca ha venido no revienta y queda «sin_visitas»', async () => {
  const r = await ficha('PD-NUNCA1');
  assert.equal(r.status, 200);
  assert.equal(r.habitos.estado, 'sin_visitas');
  assert.equal(r.habitos.visitas, 0);
  assert.equal(r.habitos.ritmo, null);
});

test('ficha: tarjeta, historial (visitas y canjes, lo último primero), cumpleaños y WhatsApp del cliente', async () => {
  const r = await ficha('PD-RITMO1');
  assert.equal(r.cliente.whatsapp, '573001234567');
  assert.deepEqual(r.cumple, { dias: 3, md: sumar(hoy, 3).slice(5) });
  assert.equal(r.historial_total, 5);                                    // 4 visitas + 1 canje
  assert.equal(r.historial.length, 5);
  assert.deepEqual(r.historial.map(x => x.tipo), ['CANJE', 'VISITA', 'VISITA', 'VISITA', 'VISITA']);   // el canje es del mismo día que la última visita, pero más tarde
  assert.ok(r.historial.every((x, i, a) => !i || new Date(a[i - 1].fecha) >= new Date(x.fecha)));       // de la más reciente a la más antigua
  assert.equal(r.tarjeta.meta, 8);
  assert.equal(r.tarjeta.actual, 0);                                     // las 4 visitas quedan antes del canje: tarjeta nueva en cero
  assert.equal(r.tarjeta.listo, false);
});

test('ficha: serie de calificaciones del cliente y promedio de todos (sin comentarios ajenos)', async () => {
  const r = await ficha('PD-RITMO1');
  assert.deepEqual(r.calif.serie.map(x => x.general), [5, 2]);           // de la más antigua a la más reciente
  assert.equal(r.calif.comentarios[0].comentario, 'Tardaron mucho');
  assert.equal(r.global.n, 3);
  assert.equal(r.global.general, 3.67);                                  // (5 + 2 + 4) / 3
  assert.deepEqual(Object.keys(r.global).sort(), ['comida', 'general', 'lugar', 'n', 'servicio']);   // solo cifras
});

test('ficha: cliente sin fecha de nacimiento ni calificaciones no revienta', async () => {
  const r = await ficha('PD-NUNCA1');
  assert.equal(r.cumple, null);
  assert.deepEqual(r.calif.serie, []);
  assert.equal(r.historial_total, 0);
  assert.deepEqual(r.historial, []);
  assert.equal(r.tarjeta.tarjetas_completas, 0);
});
