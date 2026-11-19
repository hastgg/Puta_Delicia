'use strict';
/**
 * Pruebas de la comparativa (GET /api/admin/comparar) y de las funciones puras que la sostienen.
 * Lo más delicado es «Igualar días transcurridos»: si A es un periodo en curso, B se corta a los mismos días,
 * y no debe cortarse nada cuando los dos periodos ya terminaron o cuando el dueño apaga la opción.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const E = require('../lib/estadisticas');
const { MongoClientFalso, compartida } = require('./mongo-falso');

/* ---------------- Funciones puras: fechas fijas, sin servidor ---------------- */
test('atajos: esta semana vs la pasada (lun–dom)', () => {
  assert.deepEqual(E.rangosAtajo('semana', '2026-11-17'), {            // un martes
    a: { ini: '2026-11-16', fin: '2026-11-22' }, b: { ini: '2026-11-09', fin: '2026-11-15' } });
});

test('atajos: este mes vs el pasado, incluso al cruzar de año y con febrero corto', () => {
  assert.deepEqual(E.rangosAtajo('mes', '2027-01-20'), { a: { ini: '2027-01-01', fin: '2027-01-31' }, b: { ini: '2026-12-01', fin: '2026-12-31' } });
  assert.deepEqual(E.rangosAtajo('mes', '2026-03-05').b, { ini: '2026-02-01', fin: '2026-02-28' });
});

test('atajos: este mes vs el mismo mes del año pasado (febrero bisiesto vs no bisiesto)', () => {
  assert.deepEqual(E.rangosAtajo('mes-anio', '2026-11-19'), { a: { ini: '2026-11-01', fin: '2026-11-30' }, b: { ini: '2025-11-01', fin: '2025-11-30' } });
  assert.deepEqual(E.rangosAtajo('mes-anio', '2028-02-10'), { a: { ini: '2028-02-01', fin: '2028-02-29' }, b: { ini: '2027-02-01', fin: '2027-02-28' } });
  assert.equal(E.rangosAtajo('inventado', '2026-11-19'), null);
});

test('igualar: un martes, A lleva 2 días y B (la semana pasada) se corta a sus 2 primeros', () => {
  const { a, b } = E.rangosAtajo('semana', '2026-11-17');
  const c = E.prepararComparacion(a, b, '2026-11-17', true);
  assert.equal(c.a.en_curso, true);
  assert.equal(c.b.en_curso, false);
  assert.deepEqual([c.a.ini, c.a.fin, c.a.dias], ['2026-11-16', '2026-11-17', 2]);
  assert.deepEqual([c.b.ini, c.b.fin, c.b.dias], ['2026-11-09', '2026-11-10', 2]);
  assert.equal(c.b.fin_pedido, '2026-11-15');
  assert.equal(c.recortado, true);
  assert.equal(c.dias, 2);
});

test('igualar apagado: A llega solo hasta hoy y B se queda entero', () => {
  const { a, b } = E.rangosAtajo('semana', '2026-11-17');
  const c = E.prepararComparacion(a, b, '2026-11-17', false);
  assert.deepEqual([c.a.dias, c.b.dias], [2, 7]);
  assert.equal(c.b.fin, '2026-11-15');
  assert.equal(c.recortado, false);
});

test('igualar: el lunes (1 día transcurrido) se compara con el lunes anterior; el domingo, con la semana entera', () => {
  const { a, b } = E.rangosAtajo('semana', '2026-11-16');
  assert.deepEqual([E.prepararComparacion(a, b, '2026-11-16').b.fin], ['2026-11-09']);
  const dom = E.rangosAtajo('semana', '2026-11-22');
  const c = E.prepararComparacion(dom.a, dom.b, '2026-11-22');
  assert.equal(c.b.dias, 7);
  assert.equal(c.recortado, false);                                    // ya están completos los 7 días: nada que cortar
});

test('igualar: si los dos periodos ya terminaron no se corta nada, aunque midan distinto', () => {
  const c = E.prepararComparacion({ ini: '2026-10-01', fin: '2026-10-10' }, { ini: '2026-09-01', fin: '2026-09-30' }, '2026-11-17');
  assert.deepEqual([c.a.dias, c.b.dias, c.recortado], [10, 30, false]);
  assert.deepEqual([c.a.en_curso, c.b.en_curso], [false, false]);
});

test('igualar: si el periodo en curso es B, es A quien se corta; si ambos están en curso, mandan los menos días', () => {
  const c1 = E.prepararComparacion({ ini: '2026-10-01', fin: '2026-10-31' }, { ini: '2026-11-15', fin: '2026-11-30' }, '2026-11-17');
  assert.deepEqual([c1.a.fin, c1.a.dias, c1.b.dias], ['2026-10-03', 3, 3]);
  const c2 = E.prepararComparacion({ ini: '2026-11-10', fin: '2026-11-30' }, { ini: '2026-11-15', fin: '2026-11-30' }, '2026-11-17');
  assert.deepEqual([c2.a.dias, c2.b.dias], [3, 3]);
});

test('igualar: febrero de 29 días contra febrero de 28 no inventa un recorte', () => {
  const { a, b } = E.rangosAtajo('mes-anio', '2028-02-29');
  const c = E.prepararComparacion(a, b, '2028-02-29', true);
  assert.deepEqual([c.a.dias, c.b.dias, c.b.fin, c.recortado], [29, 28, '2027-02-28', false]);
});

test('día más fuerte: el de más visitas en el mapa; null si no hubo visitas', () => {
  const mapa = Array.from({ length: 7 }, () => Array(24).fill(0));
  assert.equal(E.diaFuerte(mapa), null);
  mapa[4][19] = 3; mapa[4][20] = 2; mapa[1][12] = 5; mapa[6][12] = 5;
  assert.deepEqual(E.diaFuerte(mapa), { d: 1, n: 5 });                 // viernes 3+2, martes 5 y domingo 5: empate a 5, gana el primero (martes)
  mapa[2][10] = 9;
  assert.deepEqual(E.diaFuerte(mapa), { d: 2, n: 9 });
});

/* ---------------- Endpoint: servidor real con la base de datos simulada ---------------- */
const PORT = 38919, BASE = 'http://127.0.0.1:' + PORT;
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

// Ayudantes de fecha escritos aparte de lib/estadisticas.js, para no probar el código con él mismo
const MS_DIA = 86400000;
const hoy = new Date(Date.now() - 5 * 3600000).toISOString().slice(0, 10);               // «hoy» en Bogotá (UTC-5)
const sumar = (ymd, n) => new Date(new Date(ymd + 'T00:00:00Z').getTime() + n * MS_DIA).toISOString().slice(0, 10);
const bogota = (ymd, hhmm = '12:00') => new Date(`${ymd}T${hhmm}:00-05:00`);
const diaSemana = ymd => (new Date(ymd + 'T00:00:00Z').getUTCDay() + 6) % 7;             // 0 = lunes … 6 = domingo
const dia = n => sumar(hoy, -n);
const lunes = sumar(hoy, -diaSemana(hoy)), lunesPasado = sumar(lunes, -7);
const n = diaSemana(hoy) + 1;                                                            // días que lleva la semana (1 = lunes … 7 = domingo)

let ipN = 0;
async function comparar(query, { pin = CLAVE } = {}) {
  const r = await fetch(BASE + '/api/admin/comparar?' + query, {
    headers: { ...(pin && { 'x-pin': encodeURIComponent(pin) }), 'x-forwarded-for': `203.0.113.${++ipN}` },
  });
  return { status: r.status, ...(await r.json().catch(() => ({}))) };
}

test.before(async () => {
  require('../server.js');
  for (let i = 0; i < 100; i++) { try { if ((await fetch(BASE + '/api/health')).ok) break; } catch {} await new Promise(r => setTimeout(r, 50)); }
  const mv = compartida.collection('movimientos'), ca = compartida.collection('calificaciones');
  const v = (id, f) => mv.insertOne({ tipo: 'VISITA', id, fecha: f });
  // Esta semana: 1 visita por día transcurrido, y 3 más el lunes (día más fuerte = lunes, 4 visitas)
  for (let i = 0; i < n; i++) await v('PD-A' + i, bogota(sumar(lunes, i), '13:00'));
  for (let i = 0; i < 3; i++) await v('PD-X' + i, bogota(lunes, '19:00'));
  // La semana pasada, ENTERA: 1 visita por día, y un canje el domingo
  for (let i = 0; i < 7; i++) await v('PD-B' + i, bogota(sumar(lunesPasado, i), '13:00'));
  await mv.insertOne({ tipo: 'CANJE', id: 'PD-B0', fecha: bogota(sumar(lunesPasado, 6)) });
  const futuro = new Date(Date.now() + 2 * MS_DIA), pasado = new Date(Date.now() - 2 * MS_DIA);
  await ca.insertOne({ id: 'PD-A0', fecha: bogota(lunes), estado: 'CALIFICADA', vence: futuro, general: 4, servicio: 4, comida: 4, lugar: 4 });
  await ca.insertOne({ id: 'PD-X0', fecha: bogota(lunes), estado: 'PENDIENTE', vence: pasado });      // venció sin calificar → tasa de respuesta 1 de 2
});
test.after(() => { srv?.closeAllConnections?.(); srv?.close(); });

test('acceso: solo con la contraseña del dueño', async () => {
  assert.equal((await comparar('atajo=semana', { pin: null })).status, 401);
  assert.equal((await comparar('atajo=semana', { pin: PIN_CAJA })).status, 401);
  assert.equal((await comparar('atajo=semana')).status, 200);
});

test('esta semana vs la pasada, con «igualar» (por defecto): B se corta a los mismos días que lleva A', async () => {
  const r = await comparar('atajo=semana');
  assert.equal(r.igualar, true);
  assert.equal(r.atajo, 'semana');
  assert.deepEqual([r.a.ini, r.a.fin_pedido, r.a.en_curso, r.a.dias], [lunes, sumar(lunes, 6), true, n]);
  assert.deepEqual([r.b.ini, r.b.fin, r.b.fin_pedido, r.b.en_curso, r.b.dias], [lunesPasado, sumar(lunesPasado, n - 1), sumar(lunesPasado, 6), false, n]);
  assert.equal(r.recortado, n < 7);
  assert.equal(r.a.visitas, n + 3);
  assert.equal(r.b.visitas, n);                                         // sin el recorte serían 7
  assert.equal(r.b.canjes, n === 7 ? 1 : 0);                            // el canje del domingo queda fuera mientras no se complete la semana
});

test('«igualar» apagado (igualar=0): B se queda con la semana entera y la serie de A termina en hoy', async () => {
  const r = await comparar('atajo=semana&igualar=0');
  assert.equal(r.igualar, false);
  assert.equal(r.recortado, false);
  assert.equal(r.b.dias, 7);
  assert.equal(r.b.visitas, 7);
  assert.equal(r.b.canjes, 1);
  assert.equal(r.a.dias, n);
  assert.equal(r.a.serie.length, n);                                    // sin días futuros en cero que parezcan una caída
  assert.equal(r.b.serie.length, 7);
});

test('la serie día a día coincide con los totales y está alineada (día 1 de A frente al día 1 de B)', async () => {
  const r = await comparar('atajo=semana');
  for (const P of [r.a, r.b]) {
    assert.equal(P.serie.length, n);
    assert.equal(P.serie.reduce((s, x) => s + x.visitas, 0), P.visitas);
  }
  assert.equal(r.a.serie[0].k, lunes);
  assert.equal(r.b.serie[0].k, lunesPasado);
  assert.equal(r.a.serie[0].visitas, 1 + 3);                            // el lunes de A: la visita normal más las 3 extra
  assert.equal(r.b.serie[0].visitas, 1);
  assert.equal(r.bucket, 'dia');
});

test('día más fuerte y tasa de respuesta de cada periodo', async () => {
  const r = await comparar('atajo=semana');
  assert.deepEqual(r.a.dia_fuerte, { d: 0, n: 4 });                     // el lunes de A
  assert.deepEqual(r.b.dia_fuerte, { d: 0, n: 1 });                     // todos los días de B valen 1: gana el primero
  assert.equal(r.a.calif.tasa_respuesta, 0.5);
  assert.equal(r.b.calif.tasa_respuesta, null);                         // la semana pasada nadie tuvo calificaciones: no hay tasa
  assert.equal(r.a.calif.general, 4);
});

test('este mes vs el mismo mes del año pasado: B es el mes calendario completo de hace un año, recortado si A sigue en curso', async () => {
  const r = await comparar('atajo=mes-anio');
  const y = +hoy.slice(0, 4), mm = hoy.slice(5, 7);
  assert.equal(r.a.ini, `${y}-${mm}-01`);
  assert.equal(r.b.ini, `${y - 1}-${mm}-01`);
  assert.equal(r.b.fin_pedido.slice(0, 7), `${y - 1}-${mm}`);
  assert.equal(r.a.dias, +hoy.slice(8, 10));                              // A llega hasta hoy
  assert.equal(r.b.dias, Math.min(r.a.dias, +r.b.fin_pedido.slice(8, 10)));
});

test('este mes vs el pasado responde y termina cada periodo donde toca', async () => {
  const r = await comparar('atajo=mes');
  assert.equal(r.a.ini, hoy.slice(0, 8) + '01');
  assert.equal(r.b.fin_pedido, sumar(r.a.ini, -1));
  assert.equal(r.a.en_curso, true);
});

test('personalizado: dos periodos ya terminados no se recortan aunque midan distinto', async () => {
  const r = await comparar(`a_ini=${dia(10)}&a_fin=${dia(8)}&b_ini=${dia(20)}&b_fin=${dia(14)}`);
  assert.equal(r.status, 200);
  assert.equal(r.atajo, null);
  assert.deepEqual([r.a.dias, r.b.dias, r.recortado], [3, 7, false]);
  assert.deepEqual([r.a.en_curso, r.b.en_curso], [false, false]);
});

test('personalizado: un periodo en curso (termina en el futuro) recorta al otro', async () => {
  const r = await comparar(`a_ini=${dia(2)}&a_fin=${sumar(hoy, 3)}&b_ini=${dia(20)}&b_fin=${dia(10)}`);
  assert.equal(r.a.en_curso, true);
  assert.equal(r.a.dias, 3);
  assert.deepEqual([r.b.dias, r.b.fin, r.recortado], [3, dia(18), true]);
  const sin = await comparar(`a_ini=${dia(2)}&a_fin=${sumar(hoy, 3)}&b_ini=${dia(20)}&b_fin=${dia(10)}&igualar=0`);
  assert.deepEqual([sin.b.dias, sin.recortado], [11, false]);
});

test('personalizado: antes y después de una promoción (periodos de distinto largo, uno de ellos usa «todo el rango»)', async () => {
  const r = await comparar(`a_ini=${lunesPasado}&a_fin=${sumar(lunesPasado, 6)}&b_ini=${sumar(lunesPasado, -7)}&b_fin=${sumar(lunesPasado, -1)}`);
  assert.equal(r.a.visitas, 7);
  assert.equal(r.b.visitas, 0);
});

test('periodos largos (más de 62 días) se agrupan por mes', async () => {
  const r = await comparar(`a_ini=${dia(100)}&a_fin=${dia(1)}&b_ini=${dia(250)}&b_fin=${dia(151)}`);
  assert.equal(r.bucket, 'mes');
  assert.ok(r.a.serie.every(s => /^\d{4}-\d{2}$/.test(s.k)));
});

test('entradas inválidas: 400 con un mensaje claro', async () => {
  for (const q of [
    'atajo=inventado',
    '',                                                                  // ni atajo ni fechas
    `a_ini=${dia(5)}&a_fin=${dia(1)}&b_ini=${dia(9)}`,                   // falta una fecha
    `a_ini=2026-02-31&a_fin=${dia(1)}&b_ini=${dia(9)}&b_fin=${dia(6)}`,  // fecha que no existe
    `a_ini=${dia(1)}&a_fin=${dia(5)}&b_ini=${dia(9)}&b_fin=${dia(6)}`,   // «desde» posterior a «hasta»
    `a_ini=${sumar(hoy, 2)}&a_fin=${sumar(hoy, 4)}&b_ini=${dia(9)}&b_fin=${dia(6)}`,   // empieza en el futuro
    `a_ini=2000-01-01&a_fin=${dia(1)}&b_ini=${dia(9)}&b_fin=${dia(6)}`,  // abarca demasiado
  ]) {
    const r = await comparar(q);
    assert.equal(r.status, 400, q);
    assert.equal(r.ok, false, q);
    assert.ok(r.error, q);
  }
});
