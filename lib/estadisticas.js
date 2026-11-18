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

  for (const r of registros) { const s = serie.get(clave(r.fecha_registro)); if (s) s.registros++; }
  for (const v of visitas) {
    horas[horaDe(v.fecha)]++;
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
    horas,
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

module.exports = { ymdDe, horaDe, inicioDia, sumarDias, ymdValido, periodo, claves, calcular, resumenCalificaciones, redondear };
