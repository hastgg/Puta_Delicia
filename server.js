'use strict';
/**
 * Puta Delicia BBQ House — Backend de fidelización
 * Express + MongoDB Atlas. Panel de administración (dashboard) y Excel generado al momento para el dueño.
 */
// dotenvx lee el .env normal o cifrado (la llave del cifrado está en .env.keys o en la variable DOTENV_PRIVATE_KEY)
try { require('@dotenvx/dotenvx').config({ quiet: true }); } catch { require('dotenv').config(); }
if (String(process.env.MONGODB_URI || '').startsWith('encrypted:')) {
  console.error('❌ Tu .env está cifrado pero falta dotenvx o su llave. Corre «npm install» y verifica que exista el archivo .env.keys (o la variable DOTENV_PRIVATE_KEY).');
  process.exit(1);
}
const express = require('express');
const cors = require('cors');
const ExcelJS = require('exceljs');
const { MongoClient } = require('mongodb');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const E = require('./lib/estadisticas');
const K = require('./lib/cripto');
const L = require('./lib/limite');
const C = require('./lib/credenciales');

/* ================= Configuración ================= */
const PORT = process.env.PORT || 3000;
// Las claves (contraseña del dueño y PIN de caja) viven con hash en la base de datos (colección «credenciales»).
// Estas dos variables del .env solo se usan la PRIMERA vez para sembrarlas; después puedes borrarlas del .env.
const SEMILLA_ADMIN = process.env.ADMIN_PASSWORD || process.env.ADMIN_PIN || '';   // ADMIN_PIN = nombre antiguo
const SEMILLA_CAJA = process.env.STAFF_PIN || '';
const META = 8;                                           // visitas para la cortesía
const MIN_ENTRE_VISITAS = Number(process.env.MINUTOS_ENTRE_VISITAS || 0);
const SIMULACION = process.env.SIMULACION !== 'false';
const MONGODB_URI = process.env.MONGODB_URI;
const MONGODB_DB = process.env.MONGODB_DB || 'putadelicia';
const TZ = 'America/Bogota';
// Peso de cada aspecto en la calificación general (ponderación). Con pesos iguales es el promedio simple.
// Para dar más importancia a algo, cambia los números (ej.: comida: 3, servicio: 2, lugar: 1).
// Tiempo que tiene el cliente para calificar después de que caja suma su visita. Pasado ese tiempo
// la calificación ya no es válida y en el Excel aparece "No calificó". Cambia con CALIFICACION_MINUTOS en .env.
const MIN_PARA_CALIFICAR = Number(process.env.CALIFICACION_MINUTOS || 60);
const PESOS = { servicio: 1, comida: 1, lugar: 1 };

const PRODUCCION = process.env.NODE_ENV === 'production';

if (!MONGODB_URI) { console.error('❌ Falta MONGODB_URI en el archivo .env (o en las variables de entorno).'); process.exit(1); }
try { K.iniciar(process.env.DATA_KEY); }
catch (e) { console.error('❌ ' + e.message + '\n   (Esta clave cifra los datos personales de los clientes; guárdala en .env y en un lugar seguro.)'); process.exit(1); }
if (PRODUCCION && (!process.env.CORS_ORIGIN || process.env.CORS_ORIGIN === '*'))
  console.warn('⚠️  CORS_ORIGIN está abierto (*). En producción pon la URL de tu sitio.');

let clientes, movimientos, calificaciones, auditoria, credenciales;   // colecciones de MongoDB (se asignan al conectar)

/* ================= Utilidades ================= */
const fmt = d => (d ? new Date(d).toLocaleString('sv-SE', { timeZone: TZ }) : ''); // 2026-11-15 14:30:00
const nuevoId = () => 'PD-' + crypto.randomBytes(3).toString('hex').toUpperCase();
const sinTildes = t => String(t || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
const escaparRegex = t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Deja solo dígitos; un celular colombiano de 10 dígitos recibe el prefijo 57 (formato WhatsApp)
const normWhats = raw => {
  let d = String(raw || '').replace(/\D/g, '');
  if (d.length === 10 && d.startsWith('3')) d = '57' + d;
  return d.length >= 10 && d.length <= 15 ? d : null;
};
// Fecha de nacimiento "AAAA-MM-DD" (opcional). Devuelve { ok, valor }
function parseNacimiento(raw) {
  const s = String(raw || '').trim();
  if (!s) return { ok: true, valor: null };
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return { ok: false };
  const y = +m[1], mo = +m[2], d = +m[3];
  const f = new Date(Date.UTC(y, mo - 1, d)), hoy = new Date();
  const real = f.getUTCFullYear() === y && f.getUTCMonth() === mo - 1 && f.getUTCDate() === d;
  if (!real || f > hoy || y < hoy.getUTCFullYear() - 110) return { ok: false };
  return { ok: true, valor: s };
}
/* --- Datos personales cifrados: WhatsApp, correo y fecha de nacimiento nunca se guardan en claro --- */
// Campos que se guardan en la base: el dato cifrado + un hash (blind index) para buscar y evitar repetidos
const sensibles = ({ whatsapp, correo, nacimiento, nombre_norm }) => ({
  whatsapp: K.cifrar(whatsapp, 'whatsapp'), whatsapp_h: K.hash('whatsapp', whatsapp),
  correo: K.cifrar(correo, 'correo'), correo_h: K.hash('correo', correo),
  fecha_nacimiento: K.cifrar(nacimiento, 'fecha_nacimiento'),
  cumple_md: K.cifrar(nacimiento ? nacimiento.slice(5) : null, 'cumple_md'),
  rec_h: K.hash('rec', nombre_norm + '|' + whatsapp.slice(-4)),      // para «Recupera tu tarjeta»: nombre + últimos 4 dígitos
});
// Documento con los datos personales ya descifrados (solo para caja, dueño y envíos)
const abrir = c => ({
  ...c, whatsapp: K.descifrar(c.whatsapp, 'whatsapp'), correo: K.descifrar(c.correo, 'correo'),
  fecha_nacimiento: K.descifrar(c.fecha_nacimiento, 'fecha_nacimiento'),
});

// Filtro de búsqueda por código, correo, WhatsApp o nombre (el correo y el WhatsApp se buscan por su hash)
function filtroBusqueda(q) {
  const w = normWhats(q);
  const or = [{ _id: q.toUpperCase() }, { nombre_norm: { $regex: escaparRegex(sinTildes(q)) } }];
  if (/^\S+@\S+\.\S+$/.test(q)) or.push({ correo_h: K.hash('correo', q.toLowerCase()) });
  if (w) or.push({ whatsapp_h: K.hash('whatsapp', w) });
  return { $or: or };
}
const maskWhats = w => (w && w.length > 5 ? w.slice(0, 3) + '*'.repeat(w.length - 5) + w.slice(-2) : w || '');
const maskCorreo = c => { const [u, d] = String(c || '').split('@'); return d ? u[0] + '***@' + d : ''; };
const maskNombre = n => String(n || '').split(' ').filter(Boolean).map(p => p[0] + '***').join(' ');   // "J*** P***"
const maskNac = n => (n ? '****-**-**' : '');

const completo = c => {
  const a = abrir(c);
  return {
    id: a._id, nombre: a.nombre, whatsapp: a.whatsapp, correo: a.correo,
    acepta_notificaciones: a.acepta_notificaciones, puntos: a.puntos, premio_listo: a.premio_listo,
    canjes: a.canjes, fecha_nacimiento: a.fecha_nacimiento ?? null, fecha_registro: a.fecha_registro, ultima_visita: a.ultima_visita, meta: META,
  };
};
const publico = c => ({ id: c._id, nombre: c.nombre, puntos: c.puntos, meta: META, premio_listo: c.premio_listo });
const registrar = (c, tipo, detalle = '') =>
  movimientos.insertOne({ fecha: new Date(), id: c._id, nombre: c.nombre, tipo, puntos: c.puntos, detalle });
const idDe = req => String(req.body?.id || req.params?.id || '').trim().toUpperCase();
// Bitácora de acciones delicadas (quién, cuándo, desde qué IP). Nunca debe tumbar la petición.
const auditar = (req, accion, detalle = '') =>
  auditoria.insertOne({ fecha: new Date(), accion, ip: req.ip, detalle }).catch(e => console.error('Auditoría:', e.message));
const ah = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);   // captura errores async

/* ================= Seguridad: contraseña del dueño y PIN de caja ================= */
// Freno a fuerza bruta: 10 fallos / 15 min por IP, y un tope global de 300 fallos / 15 min entre todas las IPs
// (así rotar de IP tampoco sirve para probar los PIN).
const VENTANA_PIN = 15 * 60000, MAX_PIN_IP = 10, MAX_PIN_GLOBAL = 300;
// Quién es el que escribió esa clave: 'caja', 'admin' o null. Solo compara contra los roles permitidos.
async function rolDe(valor, roles) {
  if (!valor) return null;
  for (const rol of roles) {
    const doc = await C.obtener(credenciales, rol);
    if (doc && await C.verificar(valor, doc.hash)) return rol;
  }
  return null;
}
// Comprueba una clave con los límites de intentos. Si falla, ya responde al cliente y devuelve null.
async function comprobar(req, res, valor, roles, msg = 'PIN incorrecto.') {
  const clave = 'pin:' + req.ip;
  if (L.bloqueado(clave, MAX_PIN_IP) || L.bloqueado('pin:global', MAX_PIN_GLOBAL)) {
    res.status(429).json({ ok: false, error: 'Demasiados intentos. Espera 15 minutos.' }); return null;
  }
  const rol = await rolDe(valor, roles);
  if (rol) { L.limpiar(clave); return rol; }
  L.sumar(clave, VENTANA_PIN); L.sumar('pin:global', VENTANA_PIN);
  res.status(401).json({ ok: false, error: msg }); return null;
}
// La clave viaja solo en la cabecera (nunca en la URL), codificada para aceptar cualquier símbolo
const claveDeCabecera = req => { const v = req.get('x-pin') || ''; try { return decodeURIComponent(v); } catch { return v; } };
function requierePin(roles, msg) {
  return ah(async (req, res, next) => { const rol = await comprobar(req, res, claveDeCabecera(req), roles, msg); if (rol) { req.rol = rol; next(); } });
}
const soloStaff = requierePin(['caja', 'admin'], 'PIN incorrecto.');             // caja (el dueño también puede)
const soloAdmin = requierePin(['admin'], 'Contraseña del dueño incorrecta.');

/* ================= App ================= */
const app = express();
// Cuántos proxies hay delante del servidor (Render/Railway = 1). Si pones un número mal, las IPs se pueden falsificar.
app.set('trust proxy', Number(process.env.TRUST_PROXY ?? 1));
app.disable('x-powered-by');
app.use((req, res, next) => {                        // cabeceras de seguridad
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'camera=(self), microphone=(), geolocation=()',   // la cámara se usa para escanear el QR
    // CSP parcial: bloquea incrustación en otros sitios, <base>/<object> maliciosos y formularios hacia afuera
    'Content-Security-Policy': "frame-ancestors 'none'; base-uri 'self'; object-src 'none'; form-action 'self'",
  });
  if (req.secure) res.set('Strict-Transport-Security', 'max-age=15552000');
  if (req.path.startsWith('/api')) res.set('Cache-Control', 'no-store');    // las respuestas con datos personales no se guardan en caché
  next();
});
app.use(cors({ origin: process.env.CORS_ORIGIN || '*', allowedHeaders: ['Content-Type', 'x-pin'] }));
app.use(express.json({ limit: '20kb' }));

const fallo = (res, code, error) => res.status(code).json({ ok: false, error });
const YA_MIEMBRO = 'Ya eres miembro. Usa «Recupera tu tarjeta» con tu nombre y los últimos 4 dígitos de tu WhatsApp.';
const H = 3600000, M15 = 15 * 60000;
// Límites por IP (varios clientes en el mismo WiFi del local comparten IP, por eso los topes son generosos)
const limRegistro = L.limitar('registro', { max: 20, ventanaMs: H });                           // intentos de registro
const limRegistro409 = L.limitar('registro409', { max: 8, ventanaMs: H, soloFallos: true });     // "ya existe" repetido = sondeo de correos/WhatsApp
const limTarjeta = L.limitar('tarjeta', { max: 300, ventanaMs: 60000 });                         // consultas de tarjeta (la app consulta cada 8 s)
const limTarjetaFallos = L.limitar('tarjetaF', { max: 15, ventanaMs: M15, soloFallos: true });   // IDs inexistentes = intento de adivinar códigos
const limCalificar = L.limitar('calificar', { max: 30, ventanaMs: M15, soloFallos: true });
const limBuscar = L.limitar('buscar', { max: 60, ventanaMs: 60000 });

app.get('/api/health', (req, res) => res.json({ ok: true }));

// Comprueba el PIN de caja (lo usa la pantalla de bloqueo)
app.post('/api/verificar-pin', soloStaff, (req, res) => res.json({ ok: true }));

/* 1) Registro ------------------------------------------------ */
app.post('/api/registro', limRegistro, limRegistro409, ah(async (req, res) => {
  const b = req.body || {};
  const nombre = String(b.nombre || '').trim().replace(/\s+/g, ' ');
  const correo = String(b.correo || '').trim().toLowerCase();
  const whatsapp = normWhats(b.whatsapp);
  const acepta = b.acepta_notificaciones === true || b.acepta_notificaciones === 'true';
  const terminos = b.acepta_terminos === true || b.acepta_terminos === 'true';

  if (nombre.length < 3 || nombre.length > 80) return fallo(res, 400, 'Escribe tu nombre completo.');
  if (!whatsapp) return fallo(res, 400, 'Escribe un WhatsApp válido.');
  if (!/^\S+@\S+\.\S+$/.test(correo) || correo.length > 120) return fallo(res, 400, 'Escribe un correo válido.');
  if (!terminos) return fallo(res, 400, 'Debes aceptar los términos y condiciones.');

  const nac = parseNacimiento(b.fecha_nacimiento);
  if (!nac.ok) return fallo(res, 400, 'Escribe una fecha de nacimiento válida.');

  const base = {
    nombre, nombre_norm: sinTildes(nombre), acepta_notificaciones: acepta,
    ...sensibles({ whatsapp, correo, nacimiento: nac.valor, nombre_norm: sinTildes(nombre) }),
    acepta_terminos: true, fecha_aceptacion_terminos: new Date(),
    puntos: 0, premio_listo: false, canjes: 0, fecha_registro: new Date(), ultima_visita: null,
  };
  for (let i = 0; i < 5; i++) {
    const doc = { _id: nuevoId(), ...base };
    try {
      await clientes.insertOne(doc);               // los índices únicos impiden correo/WhatsApp repetidos
      await registrar(doc, 'REGISTRO', acepta ? 'Acepta notificaciones' : 'No acepta notificaciones');
      return res.status(201).json({ ok: true, cliente: completo(doc), qr: doc._id });
    } catch (e) {
      if (e.code !== 11000) throw e;
      const k = Object.keys(e.keyPattern || {})[0] || '';
      if (k === 'correo_h' || k === 'whatsapp_h' || /correo_h|whatsapp_h/.test(String(e.message))) return fallo(res, 409, YA_MIEMBRO);
      // si chocó el código (muy raro), se reintenta con otro
    }
  }
  fallo(res, 500, 'No se pudo generar tu código. Intenta de nuevo.');
}));

/* 1b) Recuperar tarjeta (nombre + últimos 4 dígitos del WhatsApp) */
app.post('/api/recuperar', ah(async (req, res) => {
  const clave = 'rec:' + req.ip;
  if (L.bloqueado(clave, 10)) return fallo(res, 429, 'Demasiados intentos. Espera 15 minutos.');

  const nombre = sinTildes(req.body?.nombre);
  const ult = String(req.body?.ultimos4 || '').replace(/\D/g, '');
  // El WhatsApp está cifrado: se busca por el hash de «nombre + últimos 4 dígitos»
  const coincide = (nombre.length >= 3 && ult.length === 4)
    ? await clientes.find({ rec_h: K.hash('rec', nombre + '|' + ult) }).limit(2).toArray() : [];

  if (coincide.length === 1) { L.limpiar(clave); return res.json({ ok: true, cliente: publico(coincide[0]) }); }
  L.sumar(clave, M15);
  fallo(res, 404, coincide.length > 1
    ? 'Hay más de un miembro con esos datos. Pide ayuda en caja.'
    : 'No encontramos un miembro con esos datos. Revisa tu nombre y los últimos 4 dígitos.');
}));

/* Calificación de cada visita: nace PENDIENTE al sumar el punto y vence a los MIN_PARA_CALIFICAR minutos */
async function abrirCalificacion(c) {
  const ahora = new Date();
  // Si había una visita anterior sin calificar, queda como "No calificó"
  await calificaciones.updateMany({ id: c._id, estado: 'PENDIENTE' }, { $set: { estado: 'NO_CALIFICO' } });
  await calificaciones.insertOne({
    fecha: ahora, id: c._id, nombre: c.nombre, visita: c.puntos,
    estado: 'PENDIENTE', vence: new Date(ahora.getTime() + MIN_PARA_CALIFICAR * 60000),
  });
}
const pendienteDe = id => calificaciones.findOne({ id, estado: 'PENDIENTE', vence: { $gt: new Date() } });

/* 2) Sumar visita (caja) ------------------------------------- */
app.post('/api/sumar-punto', soloStaff, ah(async (req, res) => {
  const id = idDe(req);
  const filtro = { _id: id, puntos: { $lt: META } };
  if (MIN_ENTRE_VISITAS)
    filtro.$or = [{ ultima_visita: null }, { ultima_visita: { $lte: new Date(Date.now() - MIN_ENTRE_VISITAS * 60000) } }];

  // Una sola operación atómica: si dos meseros escanean a la vez, no se suma de más
  const c = await clientes.findOneAndUpdate(filtro, [{ $set: {
    puntos: { $add: ['$puntos', 1] },
    ultima_visita: new Date(),
    premio_listo: { $gte: [{ $add: ['$puntos', 1] }, META] },
  }}], { returnDocument: 'after' });

  if (!c) {
    const ex = await clientes.findOne({ _id: id });
    if (!ex) return fallo(res, 404, 'Cliente no encontrado.');
    if (ex.puntos >= META) return fallo(res, 409, 'Este cliente ya tiene una cortesía lista. Cánjeala antes de sumar.');
    return fallo(res, 429, `Ya se sumó una visita hace menos de ${MIN_ENTRE_VISITAS} minutos.`);
  }
  await registrar(c, 'VISITA', c.premio_listo ? 'Premio listo para canjear' : '');
  await abrirCalificacion(c);
  res.json({ ok: true, cliente: completo(c), premio_listo: c.premio_listo });
}));

/* 3) Canjear cortesía (caja) --------------------------------- */
app.post('/api/canjear-premio', soloStaff, ah(async (req, res) => {
  const id = idDe(req);
  const c = await clientes.findOneAndUpdate({ _id: id, premio_listo: true },
    { $set: { puntos: 0, premio_listo: false }, $inc: { canjes: 1 } }, { returnDocument: 'after' });
  if (!c) {
    const ex = await clientes.findOne({ _id: id });
    return ex ? fallo(res, 409, `Aún no completa las ${META} visitas (lleva ${ex.puntos}).`) : fallo(res, 404, 'Cliente no encontrado.');
  }
  await registrar(c, 'CANJE', 'Cortesía entregada');
  res.json({ ok: true, cliente: completo(c) });
}));

/* 3b) Calificar la visita (cliente) ---------------------------- */
// La calificación general es el promedio ponderado de servicio, comida y lugar.
// Solo funciona si caja acaba de sumar una visita y dentro del tiempo permitido; se consume una sola vez.
const estrellas = (v, obligatoria) => {
  if (v === undefined || v === null || v === '') return obligatoria ? NaN : null;
  const n = Number(v);
  return Number.isInteger(n) && n >= 1 && n <= 5 ? n : NaN;
};
app.post('/api/calificar', limCalificar, ah(async (req, res) => {
  const b = req.body || {};
  const id = idDe(req);
  const servicio = estrellas(b.servicio, true), comida = estrellas(b.comida, true), lugar = estrellas(b.lugar, true);
  const comentario = String(b.comentario || '').trim().replace(/\r\n/g, '\n').slice(0, 500);
  if ([servicio, comida, lugar].some(Number.isNaN)) return fallo(res, 400, 'Califica servicio, comida y lugar de 1 a 5 estrellas.');
  // La general la calcula el servidor (el cliente no la envía ni la puede alterar)
  const pesoTotal = PESOS.servicio + PESOS.comida + PESOS.lugar;
  const general = Math.round((servicio * PESOS.servicio + comida * PESOS.comida + lugar * PESOS.lugar) / pesoTotal * 10) / 10;

  // Atómico: solo se puede calificar una visita PENDIENTE que no haya vencido, y una sola vez
  const k = await calificaciones.findOneAndUpdate({ id, estado: 'PENDIENTE', vence: { $gt: new Date() } },
    { $set: { estado: 'CALIFICADA', fecha_calificacion: new Date(), general, servicio, comida, lugar, comentario } },
    { returnDocument: 'after' });
  if (!k) {
    const ex = await clientes.findOne({ _id: id }, { projection: { _id: 1 } });
    if (!ex) return fallo(res, 404, 'Cliente no encontrado.');
    const venc = await calificaciones.findOne({ id, estado: 'PENDIENTE' });
    return fallo(res, 409, venc ? 'Se acabó el tiempo para calificar esta visita.' : 'No tienes una visita por calificar.');
  }
  const c = await clientes.findOne({ _id: id });
  if (c) await registrar(c, 'CALIFICACION', `${general.toFixed(1)}★` + (comentario ? ' con comentario' : ''));
  res.json({ ok: true });
}));

/* 4) Descargar Excel (dueño): se genera en el momento --------- */
function hoja(wb, nombre, columnas) {
  const ws = wb.addWorksheet(nombre, { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = columnas;
  const h = ws.getRow(1);
  h.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  h.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE62E2D' } };
  ws.autoFilter = { from: 'A1', to: { row: 1, column: columnas.length } };
  return ws;
}
// Por defecto el Excel sale con los datos de contacto ENMASCARADOS (3*****67, a***@gmail.com, 1990-**-**).
// Con ?completo=1 sale con todo; cada descarga queda anotada en la bitácora (colección «auditoria»).
// El PIN solo se acepta por cabecera (antes también por ?pin=, que queda en historiales y logs).
app.get('/api/descargar-excel', L.limitar('excel', { max: 10, ventanaMs: H }), soloAdmin, ah(async (req, res) => {
  const completoXl = req.query.completo === '1';
  if (completoXl) {
    // Comparte el límite de intentos con la recuperación de contraseña (5 por IP / 50 globales cada 15 min)
    const k = 'rec:' + req.ip;
    if (L.bloqueado(k, MAX_REC_IP) || L.bloqueado('rec:global', MAX_REC_GLOBAL))
      return fallo(res, 429, 'Demasiados intentos. Espera 15 minutos.');
    let cod = req.get('x-codigo') || ''; try { cod = decodeURIComponent(cod); } catch {}
    if (!(await C.verificarCodigo(credenciales, cod))) {
      L.sumar(k, VENTANA_REC); L.sumar('rec:global', VENTANA_REC * 4);
      await auditar(req, 'EXCEL_CODIGO_FALLIDO');
      return fallo(res, 403, 'Código de recuperación incorrecto.');
    }
    L.limpiar(k);
  }
  auditar(req, completoXl ? 'EXCEL_COMPLETO' : 'EXCEL_ENMASCARADO');
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Puta Delicia BBQ House';
  const wc = hoja(wb, 'Clientes', [
    { header: 'ID', key: 'id', width: 12 }, { header: 'Nombre', key: 'nombre', width: 28 },
    { header: 'WhatsApp', key: 'whatsapp', width: 16 }, { header: 'Correo', key: 'correo', width: 30 },
    { header: 'Fecha de nacimiento', key: 'nacimiento', width: 18 },
    { header: 'Acepta notificaciones', key: 'acepta', width: 22 }, { header: 'Puntos', key: 'puntos', width: 9 },
    { header: 'Premio listo', key: 'premio', width: 13 }, { header: 'Canjes', key: 'canjes', width: 9 },
    { header: 'Fecha registro', key: 'registro', width: 20 }, { header: 'Última visita', key: 'visita', width: 20 },
  ]);
  for (const raw of await clientes.find().sort({ fecha_registro: 1 }).toArray()) {
    const c = abrir(raw);
    wc.addRow({
      id: c._id, nombre: completoXl ? c.nombre : maskNombre(c.nombre),
      whatsapp: completoXl ? c.whatsapp : maskWhats(c.whatsapp), correo: completoXl ? c.correo : maskCorreo(c.correo),
      nacimiento: completoXl ? (c.fecha_nacimiento || '') : maskNac(c.fecha_nacimiento),
      acepta: c.acepta_notificaciones ? 'SÍ' : 'NO', puntos: c.puntos,
      premio: c.premio_listo ? 'SÍ' : 'NO', canjes: c.canjes,
      registro: fmt(c.fecha_registro), visita: fmt(c.ultima_visita),
    });
  }
  const wm = hoja(wb, 'Movimientos', [
    { header: 'Fecha', key: 'fecha', width: 20 }, { header: 'ID', key: 'id', width: 12 },
    { header: 'Nombre', key: 'nombre', width: 28 }, { header: 'Movimiento', key: 'tipo', width: 14 },
    { header: 'Puntos', key: 'puntos', width: 9 }, { header: 'Detalle', key: 'detalle', width: 40 },
  ]);
  for (const m of await movimientos.find().sort({ fecha: 1 }).toArray()) 
    wm.addRow({ ...m, nombre: completoXl ? m.nombre : maskNombre(m.nombre), fecha: fmt(m.fecha) });

  const wk = hoja(wb, 'Calificación y comentarios', [
    { header: 'Fecha', key: 'fecha', width: 20 }, { header: 'ID', key: 'id', width: 12 },
    { header: 'Nombre', key: 'nombre', width: 28 }, { header: 'Estado', key: 'estado', width: 14 },
    { header: 'Calificación general', key: 'general', width: 20 },
    { header: 'Servicio', key: 'servicio', width: 11 }, { header: 'Comida', key: 'comida', width: 11 },
    { header: 'Lugar (ambientación)', key: 'lugar', width: 21 }, { header: 'Comentario', key: 'comentario', width: 60 },
  ]);
  const ahora = new Date();
  for (const k of await calificaciones.find().sort({ fecha: 1 }).toArray()) {
    // Sin campo "estado" = calificaciones de versiones anteriores (siempre fueron enviadas por el cliente)
    const estado = !k.estado || k.estado === 'CALIFICADA' ? 'Calificó'
      : (k.estado === 'PENDIENTE' && k.vence > ahora) ? 'Pendiente' : 'No calificó';
    const f = wk.addRow({
      fecha: fmt(k.fecha), id: k.id, nombre: completoXl ? k.nombre : maskNombre(k.nombre), estado,
      general: estado === 'Calificó' ? k.general : '', servicio: k.servicio ?? '', comida: k.comida ?? '', lugar: k.lugar ?? '',
      comentario: k.comentario || '',
    });
    f.alignment = { vertical: 'top' };
    for (const col of [4, 5, 6, 7, 8]) f.getCell(col).alignment = { horizontal: 'center', vertical: 'top' };
    f.getCell(9).alignment = { wrapText: true, vertical: 'top' };
    f.getCell(5).numFmt = '0.0';
    if (estado !== 'Calificó') {                       // "No calificó" en rojo, "Pendiente" en ámbar
      const color = estado === 'No calificó' ? 'FFB91C1C' : 'FFB45309';
      f.getCell(4).font = { bold: true, color: { argb: color } };
    }
  }

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="clientes_putadelicia.xlsx"');
  await wb.xlsx.write(res);
  res.end();
}));

/* 5) Notificaciones masivas (dueño) -------------------------- */
// ⚙️ Puntos de integración: reemplaza el cuerpo de estas dos funciones.
//   WhatsApp → Meta Cloud API o Twilio. Correo → Resend o Brevo.
async function enviarWhatsApp(numero, texto) {
  // En los logs nunca va el dato personal completo (los logs del hosting se guardan): solo enmascarado y el largo del mensaje
  if (SIMULACION) return console.log(`[SIMULADO] WhatsApp → +${maskWhats(numero)} (${texto.length} caracteres)`);
  throw new Error('Integra aquí tu proveedor de WhatsApp (Meta/Twilio).');
}
async function enviarCorreo(correo, asunto, texto) {
  if (SIMULACION) return console.log(`[SIMULADO] Correo → ${maskCorreo(correo)} | ${asunto} (${texto.length} caracteres)`);
  throw new Error('Integra aquí tu proveedor de correo (Resend/Brevo).');
}

app.post('/api/enviar-notificacion', soloAdmin, ah(async (req, res) => {
  const { mensaje, asunto = 'Novedades de Puta Delicia BBQ House', canal = 'whatsapp', filtros = {} } = req.body || {};
  const texto = String(mensaje || '').trim();
  if (!texto || texto.length > 1000) return fallo(res, 400, 'Escribe un mensaje de máximo 1000 caracteres.');
  if (!['whatsapp', 'correo'].includes(canal)) return fallo(res, 400, "El canal debe ser 'whatsapp' o 'correo'.");

  // Solo se escribe a quienes aceptaron notificaciones (Habeas Data): este filtro no se puede desactivar.
  const q = { acepta_notificaciones: true };
  if (filtros.min_puntos != null) q.puntos = { $gte: Number(filtros.min_puntos) };
  if (filtros.premio_listo != null) q.premio_listo = Boolean(filtros.premio_listo);
  if (filtros.inactivos_dias)
    q.$or = [{ ultima_visita: null }, { ultima_visita: { $lt: new Date(Date.now() - Number(filtros.inactivos_dias) * 86400000) } }];
  const destino = (await clientes.find(q).toArray()).map(abrir);     // aquí sí se descifran WhatsApp y correo
  auditar(req, 'ENVIAR_NOTIFICACION', `${canal} → ${destino.length} destinatarios`);

  let enviados = 0, fallidos = 0;
  for (const c of destino) {
    const personal = texto.replaceAll('{nombre}', c.nombre.split(' ')[0]);
    try {
      canal === 'whatsapp' ? await enviarWhatsApp(c.whatsapp, personal) : await enviarCorreo(c.correo, asunto, personal);
      enviados++;
    } catch (e) { fallidos++; console.error(`Fallo con ${c._id}:`, e.message); }
  }
  res.json({ ok: true, simulacion: SIMULACION, canal, destinatarios: destino.length, enviados, fallidos });
}));

/* Extras necesarios para el frontend --------------------------- */
// Datos mínimos de una tarjeta (la usa el cliente). Con PIN de caja devuelve el perfil completo.
app.get('/api/cliente/:id', limTarjeta, limTarjetaFallos, ah(async (req, res) => {
  const c = await clientes.findOne({ _id: idDe(req) });
  if (!c) return fallo(res, 404, 'Cliente no encontrado.');
  // Si viene una clave, se valida con los mismos límites de intentos (si no, este endpoint serviría para adivinar el PIN)
  const pin = claveDeCabecera(req);
  let esStaff = false;
  if (pin) { if (!(await comprobar(req, res, pin, ['caja', 'admin']))) return; esStaff = true; }
  const pend = await pendienteDe(c._id);
  res.json({ ok: true, cliente: { ...(esStaff ? completo(c) : publico(c)), calificacion_pendiente: !!pend, calificacion_vence: pend?.vence ?? null } });
}));

// Caja: buscar por código, correo, WhatsApp o nombre
app.get('/api/buscar', limBuscar, soloStaff, ah(async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (q.length < 3) return fallo(res, 400, 'Escribe al menos 3 caracteres.');
  const r = await clientes.find(filtroBusqueda(q)).limit(5).toArray();
  res.json({ ok: true, resultados: r.map(completo) });
}));

/* 6) Eliminar cliente y todo su historial (dueño) */
app.post('/api/eliminar-cliente', soloAdmin, ah(async (req, res) => {
  const id = idDe(req);
  const r = await clientes.deleteOne({ _id: id });
  if (!r.deletedCount) return fallo(res, 404, 'Cliente no encontrado.');
  await movimientos.deleteMany({ id });
  await calificaciones.deleteMany({ id });
  auditar(req, 'ELIMINAR_CLIENTE', id);
  res.json({ ok: true });
}));

/* 7) Panel de administración (dashboard) — solo dueño ------------- */
// Verifica el PIN del dueño (el de caja NO sirve aquí)
app.post('/api/verificar-admin', soloAdmin, (req, res) => { auditar(req, 'ACCESO_ADMIN'); res.json({ ok: true }); });

/* 7z) Seguridad del dueño: cambiar contraseña, cambiar PIN de caja, código de recuperación y bitácora ------------- */
// Solo el dueño puede tocar estas claves, y cada cambio le pide su contraseña ACTUAL (aunque ya tenga el panel abierto).
const limSeguridad = L.limitar('seguridad', { max: 30, ventanaMs: H });
const ACCIONES_SEGURIDAD = ['CAMBIO_CLAVE_ADMIN', 'CAMBIO_PIN_CAJA', 'CODIGO_RECUPERACION_NUEVO', 'RECUPERACION_USADA', 'RECUPERACION_FALLIDA', 'RESET_ADMIN_PC', 'CREDENCIALES_INICIALES', 'EXCEL_COMPLETO', 'EXCEL_CODIGO_FALLIDO'];
const textoActual = req => String(req.body?.actual ?? '');
const POR_PAG = 10;
const paginar = (req, total) => {
  const paginas = Math.max(1, Math.ceil(total / POR_PAG));
  return { paginas, pag: Math.min(Math.max(parseInt(req.query.pag) || 1, 1), paginas) };
};

app.get('/api/admin/seguridad', soloAdmin, ah(async (req, res) => {
  const filtro = { accion: { $in: ACCIONES_SEGURIDAD } };
  const total = await auditoria.countDocuments(filtro);
  const { pag, paginas } = paginar(req, total);
  const [adm, caja, bit] = await Promise.all([
    C.obtener(credenciales, C.ID_ADMIN), C.obtener(credenciales, C.ID_CAJA),
    auditoria.find(filtro).sort({ fecha: -1 }).skip((pag - 1) * POR_PAG).limit(POR_PAG).toArray(),
  ]);
  res.json({
    ok: true, tiene_codigo: !!adm?.recuperacion, codigo_creado: adm?.recuperacion?.creado ?? null,
    clave_actualizada: adm?.actualizado ?? null, pin_caja_actualizado: caja?.actualizado ?? null,
    bitacora: bit.map(b => ({ fecha: b.fecha, accion: b.accion, ip: b.ip, detalle: b.detalle || '' })),
    pag, paginas, total,
  });
}));

app.post('/api/admin/cambiar-clave', limSeguridad, ah(async (req, res) => {
  if (!(await comprobar(req, res, textoActual(req), ['admin'], 'Tu contraseña actual no es correcta.'))) return;
  const nueva = String(req.body?.nueva ?? '');
  const v = C.validarClaveAdmin(nueva);
  if (!v.ok) return fallo(res, 400, v.error);
  if (nueva === textoActual(req)) return fallo(res, 400, 'La nueva contraseña debe ser distinta a la actual.');
  await C.fijarSecreto(credenciales, C.ID_ADMIN, nueva);
  await auditar(req, 'CAMBIO_CLAVE_ADMIN');
  res.json({ ok: true });
}));

app.post('/api/admin/cambiar-pin-caja', limSeguridad, ah(async (req, res) => {
  if (!(await comprobar(req, res, textoActual(req), ['admin'], 'Tu contraseña actual no es correcta.'))) return;
  const nuevo = String(req.body?.nuevo ?? '');
  const v = C.validarPinCaja(nuevo);
  if (!v.ok) return fallo(res, 400, v.error);
  await C.fijarSecreto(credenciales, C.ID_CAJA, nuevo);
  await auditar(req, 'CAMBIO_PIN_CAJA');
  res.json({ ok: true });
}));

// Recuperación SIN sesión: el dueño olvidó su contraseña. Con el código fija una nueva y recibe un código nuevo.
// Solo los intentos con código equivocado cuentan para el límite (equivocarse en las reglas de la contraseña no).
const VENTANA_REC = 15 * 60000, MAX_REC_IP = 5, MAX_REC_GLOBAL = 50;
app.post('/api/admin/recuperar', ah(async (req, res) => {
  const k = 'rec:' + req.ip;
  if (L.bloqueado(k, MAX_REC_IP) || L.bloqueado('rec:global', MAX_REC_GLOBAL))
    return fallo(res, 429, 'Demasiados intentos. Espera 15 minutos.');
  const nueva = String(req.body?.nueva ?? '');
  const v = C.validarClaveAdmin(nueva);
  if (!v.ok) return fallo(res, 400, v.error);                       // el código NO se gasta
  const r = await C.usarCodigo(credenciales, req.body?.codigo, nueva);
  if (!r.ok) {
    L.sumar(k, VENTANA_REC); L.sumar('rec:global', VENTANA_REC * 4);
    await auditar(req, 'RECUPERACION_FALLIDA', r.motivo);
    return fallo(res, 401, 'Código incorrecto o ya usado. Si lo perdiste, pídele a quien administra el sistema que ejecute «npm run reset-admin».');
  }
  L.limpiar(k);
  await auditar(req, 'RECUPERACION_USADA');
  res.json({ ok: true, codigo: r.codigo });
}));

// Lee de Mongo lo que ocurrió entre dos días (inclusive, hora de Bogotá) y lo resume
async function cargarPeriodo(ini, fin, bucket = 'dia') {
  const rango = { $gte: E.inicioDia(ini), $lt: E.inicioDia(E.sumarDias(fin, 1)) };
  const [registros, visitas, canjes, cals] = await Promise.all([
    clientes.find({ fecha_registro: rango }, { projection: { fecha_registro: 1 } }).toArray(),
    movimientos.find({ tipo: 'VISITA', fecha: rango }, { projection: { fecha: 1, id: 1 } }).toArray(),
    movimientos.countDocuments({ tipo: 'CANJE', fecha: rango }),
    calificaciones.find({ fecha: rango }, { projection: { estado: 1, vence: 1, general: 1, servicio: 1, comida: 1, lugar: 1 } }).toArray(),
  ]);
  return E.calcular({ ini, fin, bucket, registros, visitas, canjes, cals });
}

// 7a) Resumen general: ?rango=7d | 30d | 12m | todo
app.get('/api/admin/dashboard', soloAdmin, ah(async (req, res) => {
  const hoy = E.ymdDe(new Date());
  const rango = ['7d', '30d', '12m', 'todo'].includes(req.query.rango) ? req.query.rango : '7d';
  let ini;
  if (rango === '7d') ini = E.sumarDias(hoy, -6);
  else if (rango === '30d') ini = E.sumarDias(hoy, -29);
  else if (rango === '12m') { const d = new Date(hoy + 'T00:00:00Z'); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() - 11); ini = d.toISOString().slice(0, 10); }
  else {
    const [primero] = await clientes.find({}, { projection: { fecha_registro: 1 } }).sort({ fecha_registro: 1 }).limit(1).toArray();
    ini = primero ? E.ymdDe(primero.fecha_registro) : hoy;
  }
  const dias = Math.round((new Date(hoy) - new Date(ini)) / 86400000) + 1;
  const bucket = dias > 62 ? 'mes' : 'dia';                        // muchos días → barras por mes

  const [p, h, totalClientes] = await Promise.all([cargarPeriodo(ini, hoy, bucket), cargarPeriodo(hoy, hoy), clientes.countDocuments({})]);
  res.json({
    ok: true, rango: { ini, fin: hoy, bucket },
    total_clientes: totalClientes,
    hoy: { visitas: h.visitas, unicos: h.unicos, registros: h.registros },
    periodo: { registros: p.registros, visitas: p.visitas, unicos: p.unicos, canjes: p.canjes },
    activos: { con_visita: Math.min(p.unicos, totalClientes), sin_visita: Math.max(totalClientes - p.unicos, 0) },
    serie: p.serie, horas: p.horas, calif: p.calif,
  });
}));

// 7b) Lista de clientes con su calificación general promedio; ?q= para buscar (nombre, código, correo o WhatsApp)
app.get('/api/admin/clientes', soloAdmin, ah(async (req, res) => {
  const q = String(req.query.q || '').trim();
  const filtro = q ? filtroBusqueda(q) : {};
  const total = await clientes.countDocuments(filtro);
  const { pag, paginas } = paginar(req, total);                // 10 por página, también en la búsqueda
  const lista = await clientes.find(filtro, { projection: { nombre: 1 } })
    .sort({ nombre_norm: 1, _id: 1 }).skip((pag - 1) * POR_PAG).limit(POR_PAG).toArray();
  const medias = await calificaciones.aggregate([
    { $match: { id: { $in: lista.map(c => c._id) }, general: { $type: 'number' } } },
    { $group: { _id: '$id', general: { $avg: '$general' }, n: { $sum: 1 } } },
  ]).toArray();
  const m = new Map(medias.map(x => [x._id, x]));
  res.json({ ok: true, total, pag, paginas, clientes: lista.map(c => ({ id: c._id, nombre: c.nombre, general: E.redondear(m.get(c._id)?.general), n: m.get(c._id)?.n || 0 })) });
}));

// 7c) Detalle de un cliente: visitas, premios canjeados (con fecha), calificaciones y comentarios
app.get('/api/admin/cliente/:id', soloAdmin, ah(async (req, res) => {
  const id = idDe(req);
  const c = await clientes.findOne({ _id: id });
  if (!c) return fallo(res, 404, 'Cliente no encontrado.');
  const [movs, cals] = await Promise.all([
    movimientos.find({ id, tipo: { $in: ['VISITA', 'CANJE'] } }, { projection: { fecha: 1, tipo: 1 } }).sort({ fecha: 1 }).toArray(),
    calificaciones.find({ id }).sort({ fecha: -1 }).toArray(),
  ]);
  const visitas = movs.filter(x => x.tipo === 'VISITA'), canjes = movs.filter(x => x.tipo === 'CANJE');
  const ahora = new Date();
  const sinCalificar = cals.filter(k => k.estado === 'NO_CALIFICO' || (k.estado === 'PENDIENTE' && k.vence <= ahora)).length;
  res.json({
    ok: true,
    cliente: { ...completo(c), visitas_totales: visitas.length, primera_visita: visitas[0]?.fecha ?? null },
    canjes: canjes.map(x => x.fecha).reverse(),                    // el más reciente primero
    calif: { ...E.resumenCalificaciones(cals), sin_calificar: sinCalificar },
  });
}));

// 7d) Comparativa entre dos periodos: ?g=dia|semana|mes|anio&a=AAAA-MM-DD&b=AAAA-MM-DD
//     Cada fecha se convierte en el día / semana (lun-dom) / mes / año que la contiene.
app.get('/api/admin/comparar', soloAdmin, ah(async (req, res) => {
  const g = String(req.query.g || '');
  if (!['dia', 'semana', 'mes', 'anio'].includes(g)) return fallo(res, 400, 'Elige día, semana, mes o año.');
  const { a, b } = req.query;
  if (!E.ymdValido(a) || !E.ymdValido(b)) return fallo(res, 400, 'Elige las dos fechas a comparar.');
  const hoy = E.ymdDe(new Date());
  const armar = async ymd => {
    const p = E.periodo(g, ymd), r = await cargarPeriodo(p.ini, p.fin);
    return { ...p, en_curso: p.fin >= hoy, registros: r.registros, visitas: r.visitas, unicos: r.unicos, canjes: r.canjes, horas: r.horas, calif: r.calif };
  };
  const [A, B] = await Promise.all([armar(a), armar(b)]);
  res.json({ ok: true, g, a: A, b: B });
}));

/* Frontend: se sirve la carpeta ./public */
const PUBLIC = path.join(__dirname, 'public');
if (fs.existsSync(PUBLIC)) app.use(express.static(PUBLIC));

app.use('/api', (req, res) => fallo(res, 404, 'Ruta no encontrada.'));
app.use((err, req, res, next) => {           // JSON mal formado u otros errores
  if (err.type === 'entity.parse.failed') return fallo(res, 400, 'JSON inválido.');
  console.error(err);
  fallo(res, 500, 'Error interno del servidor.');
});

/* ================= Arranque ================= */
// Cifra automáticamente a los clientes que aún tienen sus datos en claro (versiones anteriores). Es seguro repetirla:
// solo toca a quienes no tienen todavía el hash (correo_h). Los datos ya cifrados no se modifican.
async function migrarCifrado() {
  const pendientes = await clientes.find({ correo_h: { $exists: false } }).toArray();
  for (const c of pendientes) {
    const whatsapp = K.descifrar(c.whatsapp, 'whatsapp'), correo = K.descifrar(c.correo, 'correo');
    const nacimiento = K.descifrar(c.fecha_nacimiento, 'fecha_nacimiento');
    if (!whatsapp || !correo) { console.warn(`⚠️  Cliente ${c._id} sin WhatsApp o correo: no se migró.`); continue; }
    await clientes.updateOne({ _id: c._id }, { $set: sensibles({ whatsapp, correo, nacimiento, nombre_norm: c.nombre_norm || sinTildes(c.nombre) }) });
  }
  if (pendientes.length) console.log(`🔐 Datos personales cifrados: ${pendientes.length} cliente(s) migrados.`);
  // Los índices únicos antiguos (sobre el dato en claro) ya no sirven
  for (const nombre of ['correo_1', 'whatsapp_1']) await clientes.dropIndex(nombre).catch(() => {});
}

// Primera vez: si la base aún no tiene contraseña del dueño o PIN de caja, se siembran desde el .env (ADMIN_PASSWORD / STAFF_PIN).
// Si el .env no trae valores válidos, el servidor no arranca y te dice cómo crearlos con «npm run reset-admin».
async function prepararCredenciales() {
  const [adm, caja] = await Promise.all([C.obtener(credenciales, C.ID_ADMIN), C.obtener(credenciales, C.ID_CAJA)]);
  const problemas = [], sembrados = [];
  if (!adm?.hash) {
    const v = C.validarClaveAdmin(SEMILLA_ADMIN);
    if (v.ok) { await C.fijarSecreto(credenciales, C.ID_ADMIN, SEMILLA_ADMIN); sembrados.push('contraseña del dueño'); }
    else problemas.push(SEMILLA_ADMIN ? 'ADMIN_PASSWORD del .env no sirve: ' + v.error : 'Falta la contraseña del dueño (ADMIN_PASSWORD).');
  }
  if (!caja?.hash) {
    const v = C.validarPinCaja(SEMILLA_CAJA);
    if (v.ok) { await C.fijarSecreto(credenciales, C.ID_CAJA, SEMILLA_CAJA); sembrados.push('PIN de caja'); }
    else problemas.push(SEMILLA_CAJA ? 'STAFF_PIN del .env no sirve: ' + v.error : 'Falta el PIN de caja (STAFF_PIN).');
  }
  if (problemas.length) {
    console.error('❌ No hay claves de acceso válidas todavía:\n   - ' + problemas.join('\n   - '));
    console.error('   Solución rápida (desde tu PC): npm run reset-admin   → crea la contraseña del dueño, el PIN de caja y el código de recuperación.');
    process.exit(1);
  }
  if (sembrados.length) {
    await auditoria.insertOne({ fecha: new Date(), accion: 'CREDENCIALES_INICIALES', ip: 'servidor', detalle: sembrados.join(', ') });
    console.log(`🔑 Claves iniciales guardadas con hash en la base (${sembrados.join(' y ')}).`);
  }
  if ((SEMILLA_ADMIN || SEMILLA_CAJA) && !sembrados.length)
    console.log('ℹ️  Las claves ya viven (con hash) en la base de datos. Puedes borrar STAFF_PIN y ADMIN_PASSWORD de tu .env: ya no se usan.');
}

const mongo = new MongoClient(MONGODB_URI);
(async () => {
  await mongo.connect();
  const db = mongo.db(MONGODB_DB);
  clientes = db.collection('clientes');
  movimientos = db.collection('movimientos');
  calificaciones = db.collection('calificaciones');
  auditoria = db.collection('auditoria');
  credenciales = db.collection('credenciales');
  await prepararCredenciales();
  await migrarCifrado();
  // Correo y WhatsApp repetidos se detectan por su hash (los campos reales están cifrados)
  await clientes.createIndex({ correo_h: 1 }, { unique: true, partialFilterExpression: { correo_h: { $type: 'string' } } });
  await clientes.createIndex({ whatsapp_h: 1 }, { unique: true, partialFilterExpression: { whatsapp_h: { $type: 'string' } } });
  await clientes.createIndex({ rec_h: 1 });
  await clientes.createIndex({ nombre_norm: 1 });
  await auditoria.createIndex({ fecha: -1 });
  await movimientos.createIndex({ fecha: -1 });
  await movimientos.createIndex({ id: 1, fecha: 1 });          // historial de un cliente (panel admin)
  await calificaciones.createIndex({ fecha: -1 });
  await calificaciones.createIndex({ id: 1, estado: 1 });
  console.log('🍃 Conectado a MongoDB Atlas');
  app.listen(PORT, () => console.log(`🔥 Puta Delicia BBQ API lista en http://localhost:${PORT}`));
})().catch(e => { console.error('❌ No se pudo conectar a MongoDB:', e.message); process.exit(1); });

process.on('SIGTERM', async () => { await mongo.close(); process.exit(0); });   // deploys en Render/Railway
