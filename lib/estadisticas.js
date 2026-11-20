'use strict';
/**
 * Cálculo de estadísticas del panel de administración.
 * Son funciones puras (no tocan la base de datos): server.js les pasa los datos y ellas devuelven los números.
 * Bogotá es UTC-5 todo el año (Colombia no tiene horario de verano), por eso se puede trabajar con un desfase fijo.
 */
const OFFSET_LOCAL = 5 * 3600000;
const CAMPOS = ['servicio', 'comida', 'lugar'];

const local = d => new Date(new Date(d).getTime() - OFFSET_LOCAL);
const ymdDe = d => local(d).toISOString().slice(0, 10);          // "2026-11-17" en hora de Bogotá
/** Día de la semana en Bogotá: 0 = lunes … 6 = domingo. */
const diaSemanaDe = f => (new Date(ymdDe(f) + 'T00:00:00Z').getUTCDay() + 6) % 7;
const horaDe = d => local(d).getUTCHours();                        // 0..23 en hora de Bogotá
const inicioDia = ymd => new Date(ymd + 'T00:00:00-05:00');
const sumarDias = (ymd, n) => { const d = new Date(ymd + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const ymdValido = s => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(s || ''))) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !isNaN(d) && d.toISOString().slice(0, 10) === s;
};
const redondear = (n, dec = 2) => (n == null ? null : Math.round(n * 10 ** dec) / 10 ** dec);
const promedio = a => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const esNum = v => typeof v === 'number' && Number.isFinite(v);

/** Periodo (día, semana lunes-domingo, mes o año) que contiene la fecha dada. Devuelve { ini, fin } inclusivos. */
function periodo(g, ymd) {
  const d = new Date(ymd + 'T00:00:00Z');
  if (g === 'dia') return { ini: ymd, fin: ymd };
  if (g === 'semana') { const ini = sumarDias(ymd, -((d.getUTCDay() + 6) % 7)); return { ini, fin: sumarDias(ini, 6) }; }
  if (g === 'mes') return { ini: ymd.slice(0, 8) + '01', fin: new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).toISOString().slice(0, 10) };
  return { ini: ymd.slice(0, 4) + '-01-01', fin: ymd.slice(0, 4) + '-12-31' };
}

/** Claves de cada barra de la serie: todos los días, o todos los meses ("AAAA-MM"), entre ini y fin. */
function claves(ini, fin, bucket) {
  const out = [];
  if (bucket === 'dia') { for (let d = ini; d <= fin; d = sumarDias(d, 1)) out.push(d); return out; }
  let y = +ini.slice(0, 4), m = +ini.slice(5, 7);
  const ultimo = fin.slice(0, 7);
  for (;;) {
    const k = `${y}-${String(m).padStart(2, '0')}`;
    out.push(k);
    if (k >= ultimo) return out;
    if (++m > 12) { m = 1; y++; }
  }
}

/**
 * registros: [{ fecha_registro }]   visitas: [{ fecha, id }]   canjes: número
 * cals: calificaciones del periodo [{ estado, vence, general, servicio, comida, lugar }]
 */
function calcular({ ini, fin, bucket = 'dia', registros = [], visitas = [], canjes = 0, cals = [], ahora = Date.now() }) {
  const clave = bucket === 'mes' ? f => ymdDe(f).slice(0, 7) : ymdDe;
  const serie = new Map(claves(ini, fin, bucket).map(k => [k, { k, registros: 0, visitas: 0, ids: new Set() }]));
  const horas = Array(24).fill(0), unicos = new Set();
  const mapa = Array.from({ length: 7 }, () => Array(24).fill(0));      // visitas por día de la semana (lun…dom) × hora

  for (const r of registros) { const s = serie.get(clave(r.fecha_registro)); if (s) s.registros++; }
  for (const v of visitas) {
    horas[horaDe(v.fecha)]++;
    mapa[diaSemanaDe(v.fecha)][horaDe(v.fecha)]++;
    unicos.add(v.id);
    const s = serie.get(clave(v.fecha)); if (s) { s.visitas++; s.ids.add(v.id); }
  }

  // Calificaciones: solo cuentan las que el cliente sí envió (tienen "general")
  const hechas = cals.filter(k => esNum(k.general));
  const dist = { general: [0, 0, 0, 0, 0] };
  for (const c of CAMPOS) dist[c] = [0, 0, 0, 0, 0];
  for (const k of hechas) for (const c of ['general', ...CAMPOS])
    if (esNum(k[c])) dist[c][Math.min(5, Math.max(1, Math.round(k[c]))) - 1]++;
  const media = c => redondear(promedio(hechas.map(k => k[c]).filter(esNum)));
  const pendientes = cals.filter(k => k.estado === 'PENDIENTE' && new Date(k.vence) > ahora).length;
  const vencidas = cals.length - pendientes;           // las pendientes aún pueden calificar, no cuentan como "no calificó"

  return {
    registros: registros.length, visitas: visitas.length, unicos: unicos.size, canjes,
    horas, mapa,
    serie: [...serie.values()].map(s => ({ k: s.k, registros: s.registros, visitas: s.visitas, unicos: s.ids.size })),
    calif: {
      n: hechas.length, general: media('general'), servicio: media('servicio'), comida: media('comida'), lugar: media('lugar'),
      tasa_respuesta: vencidas > 0 ? redondear(hechas.length / vencidas, 3) : null, dist,
    },
  };
}

/** Resumen de las calificaciones de UN cliente (promedios, distribución y comentarios). */
function resumenCalificaciones(cals) {
  const hechas = cals.filter(k => esNum(k.general));
  const r = calcular({ ini: '2000-01-01', fin: '2000-01-01', cals });          // reutiliza promedios y distribución
  return {
    ...r.calif,
    comentarios: hechas.filter(k => k.comentario && String(k.comentario).trim())
      .map(k => ({ fecha: k.fecha, general: k.general, servicio: k.servicio, comida: k.comida, lugar: k.lugar, comentario: k.comentario })),
  };
}

/** Periodo inmediatamente anterior y de la misma duración (en días): para comparar «este periodo» contra «el de antes». */
function periodoAnterior(ini, fin) {
  const dias = Math.round((new Date(fin + 'T00:00:00Z') - new Date(ini + 'T00:00:00Z')) / 86400000) + 1;
  const finAnt = sumarDias(ini, -1);
  return { ini: sumarDias(finAnt, -(dias - 1)), fin: finAnt };
}

/** Cambio entre dos cifras: { previo, dif, pct }. pct es null si no hay con qué comparar (antes 0 o sin dato). */
function variacion(actual, previo) {
  if (!esNum(actual) || !esNum(previo)) return null;
  return { previo, dif: redondear(actual - previo), pct: previo > 0 ? redondear((actual - previo) / previo, 3) : null };
}

/** Días de calendario que abarca un rango, contando ambos extremos. */
const diasEntre = (ini, fin) => Math.round((new Date(fin + 'T00:00:00Z') - new Date(ini + 'T00:00:00Z')) / 86400000) + 1;

/**
 * Los dos periodos de cada atajo de la comparativa (A = el actual, B = contra el que se mide), completos:
 *   'semana'   → esta semana (lun–dom) vs. la pasada
 *   'mes'      → este mes vs. el mes pasado
 *   'mes-anio' → este mes vs. el mismo mes del año pasado (la estacionalidad pesa en un restaurante)
 * Devuelve null si el atajo no existe.
 */
function rangosAtajo(atajo, hoy) {
  if (atajo === 'semana') return { a: periodo('semana', hoy), b: periodo('semana', sumarDias(hoy, -7)) };
  if (atajo === 'mes') { const a = periodo('mes', hoy); return { a, b: periodo('mes', sumarDias(a.ini, -1)) }; }
  if (atajo === 'mes-anio') return { a: periodo('mes', hoy), b: periodo('mes', `${+hoy.slice(0, 4) - 1}-${hoy.slice(5, 7)}-01`) };
  return null;
}

/**
 * Prepara dos rangos { ini, fin } para compararlos con justicia.
 *  - Un periodo no tiene datos más allá de «hoy», así que su fin efectivo nunca pasa de hoy.
 *  - Con igualar = true y algún periodo EN CURSO (fin >= hoy), el otro se corta a los mismos días transcurridos:
 *    si A lleva 2 días, B se queda con sus 2 primeros días. Si ninguno está en curso no se toca nada.
 * Devuelve { a, b, dias, recortado }; cada periodo trae { ini, fin, fin_pedido, en_curso, dias }.
 */
function prepararComparacion(a, b, hoy, igualar = true) {
  const transcurridos = p => diasEntre(p.ini, p.fin < hoy ? p.fin : hoy);
  const enCurso = p => p.fin >= hoy;
  const vivos = [a, b].filter(enCurso).map(transcurridos);
  const tope = igualar && vivos.length ? Math.min(...vivos) : Infinity;
  const armar = p => {
    const hasta = p.fin < hoy ? p.fin : hoy;                          // nunca más allá de hoy
    const corte = isFinite(tope) ? sumarDias(p.ini, tope - 1) : hasta;
    const fin = corte < hasta ? corte : hasta;
    return { ini: p.ini, fin, fin_pedido: p.fin, en_curso: enCurso(p), dias: diasEntre(p.ini, fin), _hasta: hasta };
  };
  const A = armar(a), B = armar(b);
  const recortado = A.fin < A._hasta || B.fin < B._hasta;              // el recorte lo causó «igualar», no el hecho de estar en curso
  delete A._hasta; delete B._hasta;
  return { a: A, b: B, dias: Math.max(A.dias, B.dias), recortado };
}

/** Día de la semana con más visitas según el mapa de calor (7 × 24): { d: 0 lunes … 6 domingo, n } o null si no hubo visitas. */
function diaFuerte(mapa) {
  let mejor = null;
  mapa.forEach((fila, d) => { const n = fila.reduce((x, y) => x + y, 0); if (n > 0 && (!mejor || n > mejor.n)) mejor = { d, n }; });
  return mejor;
}

/**
 * La ficha de un cliente a partir de SUS fechas de visita y de canje (un Date o ms cada una):
 *  - ritmo: cada cuántos días suele venir (mediana de los días entre visitas; hace falta haber venido en 3 días distintos).
 *  - estado: se mide contra SU ritmo, no contra un corte fijo para todos:
 *      'sin_visitas' nunca ha venido · 'nuevo' (menos de 3 visitas, ha venido en el último mes) ·
 *      'activo' dentro de 1,5 veces su ritmo (mínimo 7 días) · 'enfriando' hasta 3 veces su ritmo (mínimo 30 días) · 'inactivo' más allá.
 *      Sin ritmo conocido (menos de 3 visitas) vale el corte de 30 días del panel.
 *  - dia_favorito / hora_favorita: dónde se juntan más de sus visitas (a partir de 3 visitas y solo si hay patrón: ≥ 2 visitas y ≥ 30 % del total
 *    para el día, ≥ 25 % para la hora; si no, null). Empates: gana el primero.
 *  - por_mes: visitas y canjes de los últimos `meses` meses, incluido el actual, aunque estén en cero.
 */
function habitosCliente(visitas, canjes = [], ahora = Date.now(), meses = 12) {
  const n = visitas.length, hoy = ymdDe(ahora);
  const dias = [...new Set(visitas.map(ymdDe))].sort();
  const huecos = dias.slice(1).map((d, i) => diasEntre(dias[i], d) - 1);
  const orden = [...huecos].sort((a, b) => a - b), m = orden.length >> 1;
  const mediana = orden.length ? (orden.length % 2 ? orden[m] : (orden[m - 1] + orden[m]) / 2) : null;
  const ritmo = huecos.length >= 2 ? Math.max(1, Math.round(mediana)) : null;       // 3 días distintos = 2 huecos
  const dias_sin_venir = dias.length ? diasDesde(dias.at(-1) + 'T12:00:00-05:00', ahora) : null;
  const limite_enfriando = ritmo == null ? 30 : Math.max(Math.round(ritmo * 1.5), 7);
  const limite_inactivo = ritmo == null ? 30 : Math.max(ritmo * 3, 30);
  let estado;
  if (!n) estado = 'sin_visitas';
  else if (ritmo == null) estado = dias_sin_venir <= 30 ? 'nuevo' : 'inactivo';
  else estado = dias_sin_venir <= limite_enfriando ? 'activo' : dias_sin_venir <= limite_inactivo ? 'enfriando' : 'inactivo';

  const mayor = arr => arr.reduce((mejor, v, i) => (v > (mejor?.n ?? 0) ? { i, n: v } : mejor), null);
  const porDia = Array(7).fill(0), porHora = Array(24).fill(0);
  if (n >= 3) visitas.forEach(f => { porDia[diaSemanaDe(f)]++; porHora[horaDe(f)]++; });
  // «Favorito» solo si hay un patrón de verdad: al menos 2 visitas y una parte relevante del total (si cada visita cayó en un día distinto, no hay favorito)
  const patron = (top, minimo) => (top && top.n >= 2 && top.n / n >= minimo ? top : null);
  const d = n >= 3 ? patron(mayor(porDia), 0.3) : null, h = n >= 3 ? patron(mayor(porHora), 0.25) : null;

  const ini = hoy.slice(0, 8) + '01';
  const desde = new Date(Date.UTC(+ini.slice(0, 4), +ini.slice(5, 7) - 1 - (meses - 1), 1)).toISOString().slice(0, 10);
  const por_mes = claves(desde, hoy, 'mes').map(k => ({ k, visitas: 0, canjes: 0 }));
  const casilla = new Map(por_mes.map(x => [x.k, x]));
  visitas.forEach(f => { const x = casilla.get(ymdDe(f).slice(0, 7)); if (x) x.visitas++; });
  canjes.forEach(f => { const x = casilla.get(ymdDe(f).slice(0, 7)); if (x) x.canjes++; });

  return {
    visitas: n, ritmo, dias_sin_venir, estado, limite_enfriando, limite_inactivo,
    dia_favorito: d && { d: d.i, n: d.n }, hora_favorita: h && { h: h.i, n: h.n }, por_mes,
  };
}

/**
 * La tarjeta de fidelidad de un cliente a partir de sus fechas. Cada canje cierra una tarjeta y abre otra:
 * una visita pertenece a la tarjeta número «canjes anteriores a ella».
 *  - actual / faltan: visitas de la tarjeta en curso y cuántas le faltan para `meta`.
 *  - listo / listo_desde / listo_dias: si ya completó la tarjeta en curso y desde cuándo (la visita que llegó a `meta`).
 *  - tarjetas_completas / promedio_dias: cuántas tarjetas ha llenado (la lista sin canjear incluida) y en cuántos días,
 *    de su primera visita a la visita número `meta`, tarda en promedio en llenar una (null si no ha llenado ninguna).
 */
function progresoTarjeta(visitas, canjes, meta, ahora = Date.now()) {
  const vs = visitas.map(f => new Date(f)).sort((a, b) => a - b);
  const cs = canjes.map(f => +new Date(f));
  const por = new Map();
  vs.forEach(f => { const i = cs.filter(c => c < +f).length; por.set(i, [...(por.get(i) || []), f]); });
  const llenas = [...por.values()].filter(t => t.length >= meta);
  const dias = llenas.map(t => diasEntre(ymdDe(t[0]), ymdDe(t[meta - 1])) - 1);
  const actual = por.get(cs.length) || [];
  const listo = actual.length >= meta;
  const listo_desde = listo ? actual[meta - 1] : null;
  return {
    meta, actual: Math.min(actual.length, meta), faltan: Math.max(0, meta - actual.length),
    listo, listo_desde, listo_dias: listo ? diasDesde(listo_desde, ahora) : null,
    tarjetas_completas: llenas.length,
    promedio_dias: dias.length ? Math.round(dias.reduce((a, b) => a + b, 0) / dias.length) : null,
  };
}

/**
 * Cuándo es el próximo cumpleaños de alguien nacido el `nacimiento` («AAAA-MM-DD»): { dias, md } (dias = 0 si es hoy) o null si no hay fecha válida.
 * Quien nació un 29 de febrero celebra el 28 en los años no bisiestos.
 */
function proximoCumple(nacimiento, hoy) {
  if (!ymdValido(nacimiento)) return null;
  const md = nacimiento.slice(5), bisiesto = y => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  const fecha = y => `${y}-${md === '02-29' && !bisiesto(y) ? '02-28' : md}`;
  let y = +hoy.slice(0, 4), f = fecha(y);
  if (f < hoy) f = fecha(++y);
  return { dias: diasEntre(hoy, f) - 1, md };
}

/** Días de calendario (hora de Bogotá) entre una fecha y «ahora»: 0 = hoy, 1 = ayer... */
function diasDesde(fecha, ahora = Date.now()) {
  return Math.round((new Date(ymdDe(ahora) + 'T00:00:00Z') - new Date(ymdDe(fecha) + 'T00:00:00Z')) / 86400000);
}

/** Quien tiene su última visita ANTES de este instante lleva N días (de calendario, hora de Bogotá) o más sin venir. */
const limiteInactividad = (hoy, dias) => inicioDia(sumarDias(hoy, -(dias - 1)));

/**
 * Ordena la lista de clientes del panel. filas: [{ id, nombre_norm, ultima_visita, general, n }]
 *   'calif'  → mejor calificados primero (empata el que tiene más calificaciones); los que nunca calificaron, al final
 *   'visita' → los que llevan más tiempo sin venir primero; los que nunca han venido, al final
 *   otro     → por nombre (A–Z)
 * No modifica la lista que recibe.
 */
function ordenarClientes(filas, orden) {
  const porNombre = (a, b) => String(a.nombre_norm ?? '').localeCompare(String(b.nombre_norm ?? '')) || String(a.id).localeCompare(String(b.id));
  const t = f => (f == null ? null : new Date(f).getTime());
  const sinDato = { calif: x => !esNum(x.general), visita: x => t(x.ultima_visita) == null };
  const cmp = {
    calif: (a, b) => (b.general - a.general) || ((b.n || 0) - (a.n || 0)),
    visita: (a, b) => t(a.ultima_visita) - t(b.ultima_visita),
  };
  if (!cmp[orden]) return [...filas].sort(porNombre);
  return [...filas].sort((a, b) => {
    const sa = sinDato[orden](a), sb = sinDato[orden](b);
    if (sa !== sb) return sa ? 1 : -1;
    return (sa ? 0 : cmp[orden](a, b)) || porNombre(a, b);
  });
}

module.exports = { ymdDe, horaDe, diaSemanaDe, inicioDia, sumarDias, ymdValido, periodo, claves, calcular, resumenCalificaciones, redondear, periodoAnterior, variacion, diasEntre, rangosAtajo, prepararComparacion, diaFuerte, habitosCliente, progresoTarjeta, proximoCumple, diasDesde, limiteInactividad, ordenarClientes };
