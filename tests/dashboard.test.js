'use strict';
/**
 * Prueba de punta a punta de GET /api/admin/dashboard con la base de datos SIMULADA.
 * Levanta el servidor real, siembra clientes, visitas, canjes y calificaciones en fechas relativas a «hoy»
 * (hora de Bogotá) y revisa lo que devuelve el endpoint: periodo, cambio vs. periodo anterior, mapa de calor,
 * listas de acción y el borde de medianoche.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { MongoClientFalso, compartida } = require('./mongo-falso');

const PORT = 38918, BASE = 'http://127.0.0.1:' + PORT;
const CLAVE = 'Brasa#Lenta-7731', PIN_CAJA = '482917';

// --- simulamos el driver de MongoDB y capturamos el servidor HTTP para cerrarlo al final
const rutaMongo = require.resolve('mongodb');
require.cache[rutaMongo] = { id: rutaMongo, filename: rutaMongo, loaded: true, exports: { MongoClient: MongoClientFalso } };
let srv; const listenOrig = http.Server.prototype.listen;
http.Server.prototype.listen = function (...a) { srv = this; return listenOrig.apply(this, a); };
Object.assign(process.env, {
  MONGODB_URI: 'mongodb://falso', DATA_KEY: Buffer.alloc(32, 9).toString('base64'), PORT: String(PORT), TRUST_PROXY: '1',
  ADMIN_PASSWORD: CLAVE, STAFF_PIN: PIN_CAJA, SIMULACION: 'true',
});
delete process.env.ADMIN_PIN;

// --- ayudantes de fecha escritos aparte de lib/estadisticas.js, para no probar el código con él mismo
const MS_DIA = 86400000;
const hoy = new Date(Date.now() - 5 * 3600000).toISOString().slice(0, 10);               // «hoy» en Bogotá (UTC-5)
const sumar = (ymd, n) => new Date(new Date(ymd + 'T00:00:00Z').getTime() + n * MS_DIA).toISOString().slice(0, 10);
const bogota = (ymd, hhmm = '12:00') => new Date(`${ymd}T${hhmm}:00-05:00`);
const diaSemana = ymd => (new Date(ymd + 'T00:00:00Z').getUTCDay() + 6) % 7;             // 0 = lunes … 6 = domingo
const dia = n => sumar(hoy, -n);                                                           // dia(0) = hoy, dia(1) = ayer…
const suma = m => m.flat().reduce((a, b) => a + b, 0);

let ipN = 0;
async function dashboard(rango, { pin = CLAVE } = {}) {
  const q = rango === undefined ? '' : '?rango=' + rango;
  const r = await fetch(BASE + '/api/admin/dashboard' + q, {
    headers: { ...(pin && { 'x-pin': encodeURIComponent(pin) }), 'x-forwarded-for': `198.51.100.${++ipN}` },
  });
  return { status: r.status, ...(await r.json().catch(() => ({}))) };
}

test.before(async () => {
  require('../server.js');
  for (let i = 0; i < 100; i++) { try { if ((await fetch(BASE + '/api/health')).ok) return; } catch {} await new Promise(r => setTimeout(r, 50)); }
  throw new Error('El servidor no arrancó');
});
test.after(() => { srv?.closeAllConnections?.(); srv?.close(); });

async function sembrar() {
  const cl = compartida.collection('clientes'), mv = compartida.collection('movimientos'), ca = compartida.collection('calificaciones');
  const cliente = (id, nombre, puntos, ultima, registro) => cl.insertOne({ _id: id, nombre, puntos, premio_listo: false, canjes: 0, ultima_visita: ultima, fecha_registro: registro });
  await cliente('PD-AAAAAA', 'Ana',  7, bogota(dia(0), '00:00'), bogota(dia(1)));      // a una visita del premio; registrada ayer
  await cliente('PD-BBBBBB', 'Beto', 7, bogota(dia(3)),          bogota(dia(3)));      // a una visita del premio; registrado hace 3 días
  await cliente('PD-CCCCCC', 'Cata', 2, bogota(dia(45)),         bogota(dia(60)));     // inactiva
  await cliente('PD-DDDDDD', 'Dani', 0, null,                    bogota(dia(8)));      // nunca ha venido: NO es «inactivo»
  await cliente('PD-EEEEEE', 'Eli',  3, bogota(dia(30), '23:59'), bogota(dia(60)));    // 30 días de calendario: justo inactivo
  await cliente('PD-FFFFFF', 'Fer',  1, bogota(dia(29), '00:00'), bogota(dia(60)));    // 29 días: todavía NO es inactivo

  const v = (id, f) => mv.insertOne({ tipo: 'VISITA', id, fecha: f });
  await v('PD-AAAAAA', bogota(dia(1), '23:59'));     // ayer, un minuto antes de medianoche → cuenta como AYER
  await v('PD-AAAAAA', bogota(dia(0), '00:00'));     // hoy, justo a medianoche            → cuenta como HOY
  await v('PD-BBBBBB', bogota(dia(3), '19:30'));
  await v('PD-CCCCCC', bogota(dia(3), '19:45'));
  await v('PD-BBBBBB', bogota(dia(10)));             // cae en el periodo anterior de los 7 días
  await v('PD-DDDDDD', bogota(dia(40)));             // fuera de 7d y 30d; solo entra en «Todo»
  const c = (id, f) => mv.insertOne({ tipo: 'CANJE', id, fecha: f });
  await c('PD-BBBBBB', bogota(dia(2)));
  await c('PD-CCCCCC', bogota(dia(9))); await c('PD-CCCCCC', bogota(dia(9), '13:00'));

  const futuro = new Date(Date.now() + 2 * MS_DIA), pasado = new Date(Date.now() - 2 * MS_DIA);
  await ca.insertOne({ id: 'PD-AAAAAA', fecha: bogota(dia(1)), estado: 'CALIFICADA', vence: futuro, general: 5, servicio: 5, comida: 4, lugar: 5 });
  await ca.insertOne({ id: 'PD-BBBBBB', fecha: bogota(dia(2)), estado: 'CALIFICADA', vence: futuro, general: 3, servicio: 3, comida: 3, lugar: 3 });
  await ca.insertOne({ id: 'PD-CCCCCC', fecha: bogota(dia(2)), estado: 'PENDIENTE', vence: futuro });   // aún puede calificar: no cuenta como «no calificó»
  await ca.insertOne({ id: 'PD-DDDDDD', fecha: bogota(dia(4)), estado: 'PENDIENTE', vence: pasado });   // se le pasó el plazo: sí cuenta como «no calificó»
}

test('acceso: sin clave y con el PIN de caja no se entra; con la clave del dueño sí', async () => {
  assert.equal((await dashboard('7d', { pin: null })).status, 401);
  assert.equal((await dashboard('7d', { pin: PIN_CAJA })).status, 401);
  assert.equal((await dashboard('7d')).status, 200);
});

test('base vacía: responde con la forma completa y todo en cero (sin NaN ni nulos que rompan la pantalla)', async () => {
  const r = await dashboard('7d');
  assert.equal(r.ok, true);
  assert.equal(r.total_clientes, 0);
  assert.deepEqual(r.periodo, { registros: 0, visitas: 0, unicos: 0, canjes: 0 });
  assert.deepEqual(r.hoy, { visitas: 0, unicos: 0, registros: 0 });
  assert.equal(r.horas.length, 24);
  assert.equal(r.mapa.length, 7);
  assert.ok(r.mapa.every(f => f.length === 24 && f.every(n => n === 0)));
  assert.equal(r.serie.length, 7);
  assert.equal(r.calif.n, 0);
  assert.equal(r.calif.general, null);
  assert.equal(r.calif.tasa_respuesta, null);
  assert.equal(r.cambio.visitas.pct, null);                       // antes 0: no hay porcentaje que mostrar
  assert.deepEqual(r.accion.cerca, { total: 0, lista: [] });
  assert.deepEqual(r.accion.inactivos, { total: 0, lista: [] });
});

test('periodo de 7 días: cifras, borde de medianoche y mapa de calor', async () => {
  await sembrar();
  const r = await dashboard('7d');
  assert.equal(r.total_clientes, 6);
  assert.deepEqual(r.rango, { ini: dia(6), fin: hoy, bucket: 'dia' });
  assert.deepEqual(r.periodo, { registros: 2, visitas: 4, unicos: 3, canjes: 1 });

  // Medianoche de Bogotá: la visita de las 11:59 p. m. es de ayer y la de las 12:00 a. m. es de hoy
  assert.deepEqual(r.hoy, { visitas: 1, unicos: 1, registros: 0 });
  const porDia = Object.fromEntries(r.serie.map(s => [s.k, s.visitas]));
  assert.equal(porDia[dia(1)], 1);
  assert.equal(porDia[dia(0)], 1);
  assert.equal(porDia[dia(3)], 2);
  assert.equal(r.serie.length, 7);

  // Mapa de calor: cada visita en su día de la semana y su hora de Bogotá
  assert.equal(r.mapa[diaSemana(dia(1))][23], 1);
  assert.equal(r.mapa[diaSemana(dia(0))][0], 1);
  assert.equal(r.mapa[diaSemana(dia(3))][19], 2);
  assert.equal(suma(r.mapa), 4);
  assert.equal(r.horas[19], 2); assert.equal(r.horas[23], 1); assert.equal(r.horas[0], 1);
});

test('cambio frente al periodo anterior (▲ / ▼)', async () => {
  const r = await dashboard('7d');
  assert.deepEqual(r.anterior, { ini: dia(13), fin: dia(7) });
  assert.deepEqual(r.cambio.visitas, { previo: 1, dif: 3, pct: 3 });         // de 1 a 4: +300 %
  assert.deepEqual(r.cambio.canjes, { previo: 2, dif: -1, pct: -0.5 });      // de 2 a 1: −50 %
  assert.deepEqual(r.cambio.registros, { previo: 1, dif: 1, pct: 1 });       // de 1 a 2: +100 %
  assert.equal(r.cambio.general, null);                                      // el periodo anterior no tuvo calificaciones: no hay con qué comparar
});

test('calificaciones: solo cuentan las enviadas; la pendiente no resta, la vencida sí', async () => {
  const { calif } = await dashboard('7d');
  assert.equal(calif.n, 2);
  assert.equal(calif.general, 4);
  assert.equal(calif.servicio, 4);
  assert.deepEqual(calif.dist.general, [0, 0, 1, 0, 1]);
  assert.equal(calif.tasa_respuesta, 0.667);                                 // 2 de 3 (la pendiente vigente no entra en la cuenta)
});

test('A quién escribirle: a una visita del premio e inactivos (con su borde de 30 días)', async () => {
  const { accion } = await dashboard('7d');
  assert.equal(accion.dias_inactivo, 30);
  assert.equal(accion.meta, 8);

  // 7 de 8 puntos: primero el que más lleva esperando su visita
  assert.equal(accion.cerca.total, 2);
  assert.deepEqual(accion.cerca.lista.map(c => [c.id, c.dias]), [['PD-BBBBBB', 3], ['PD-AAAAAA', 0]]);

  // 30 días o más sin venir: Eli (30) sí, Fer (29) no, Dani (nunca vino) no; primero los más recientes
  assert.equal(accion.inactivos.total, 2);
  assert.deepEqual(accion.inactivos.lista.map(c => [c.id, c.dias]), [['PD-EEEEEE', 30], ['PD-CCCCCC', 45]]);
  assert.ok(!accion.inactivos.lista.some(c => c.id === 'PD-DDDDDD' || c.id === 'PD-FFFFFF'));
});

test('las listas no filtran datos personales', async () => {
  const { accion } = await dashboard('7d');
  const permitido = ['id', 'nombre', 'dias', 'puntos'];
  for (const c of [...accion.cerca.lista, ...accion.inactivos.lista]) assert.deepEqual(Object.keys(c).sort(), permitido.sort());
});

test('30 días: deja fuera la visita de hace 40 días y compara con los 30 anteriores', async () => {
  const r = await dashboard('30d');
  assert.equal(r.rango.ini, dia(29));
  assert.equal(r.serie.length, 30);
  assert.equal(r.periodo.visitas, 5);
  assert.deepEqual(r.anterior, { ini: dia(59), fin: dia(30) });
  assert.equal(r.cambio.visitas.previo, 1);                                  // la de hace 40 días
});

test('«Todo»: sin periodo anterior, y entran todas las visitas', async () => {
  const r = await dashboard('todo');
  assert.equal(r.anterior, null);
  assert.equal(r.cambio, null);
  assert.equal(r.rango.ini, dia(60));                                        // el cliente más antiguo se registró hace 60 días
  assert.equal(r.periodo.visitas, 6);
});

test('12 meses: barras por mes, 12 en total', async () => {
  const r = await dashboard('12m');
  assert.equal(r.rango.bucket, 'mes');
  assert.equal(r.serie.length, 12);
  assert.equal(r.periodo.visitas, 6);
});

test('un rango inválido se trata como 7 días', async () => {
  const [a, b] = [await dashboard('7d'), await dashboard('cualquier-cosa')];
  assert.equal(b.status, 200);
  assert.deepEqual(b.rango, a.rango);
  assert.deepEqual(b.periodo, a.periodo);
  assert.equal((await dashboard()).rango.ini, a.rango.ini);                  // sin parámetro, también
});

test('coherencia: mapa, horas y serie suman lo mismo que las visitas del periodo', async () => {
  for (const rango of ['7d', '30d', '12m', 'todo']) {
    const r = await dashboard(rango);
    assert.equal(suma(r.mapa), r.periodo.visitas, `${rango}: mapa vs visitas`);
    assert.equal(r.horas.reduce((a, b) => a + b, 0), r.periodo.visitas, `${rango}: horas vs visitas`);
    assert.equal(r.serie.reduce((a, s) => a + s.visitas, 0), r.periodo.visitas, `${rango}: serie vs visitas`);
    for (let h = 0; h < 24; h++) assert.equal(r.mapa.reduce((a, f) => a + f[h], 0), r.horas[h], `${rango}: columna ${h}`);
  }
});
