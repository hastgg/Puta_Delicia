'use strict';
/**
 * Reinicio de emergencia del dueño — se ejecuta SOLO desde tu PC (necesita el .env con MONGODB_URI).
 *
 *   npm run reset-admin                  → contraseña nueva del dueño + código de recuperación nuevo
 *   npm run reset-admin -- --caja        → además, PIN de caja nuevo
 *   npm run reset-admin -- --clave="Mi*Clave_2026x"   → usa tu propia contraseña en vez de una aleatoria
 *   npm run reset-admin -- --si          → no pide confirmación
 *
 * Lo que se muestra en pantalla aparece UNA sola vez: entrégaselo al dueño en persona. Queda anotado en la bitácora (fecha y equipo).
 */
const os = require('os');
const C = require('../lib/credenciales');

async function reiniciar(db, { conCaja = false, clave = null, pin = null } = {}) {
  const credenciales = db.collection('credenciales'), auditoria = db.collection('auditoria');
  const cajaActual = await C.obtener(credenciales, C.ID_CAJA);
  const nuevaClave = clave || C.generarClaveAdmin();
  const v = C.validarClaveAdmin(nuevaClave);
  if (!v.ok) throw new Error(v.error);
  const hacerCaja = conCaja || !cajaActual?.hash;                       // si la caja no tiene PIN todavía, se crea de una vez
  const nuevoPin = hacerCaja ? (pin || C.generarPinCaja()) : null;
  if (nuevoPin) { const p = C.validarPinCaja(nuevoPin); if (!p.ok) throw new Error(p.error); }

  await C.fijarSecreto(credenciales, C.ID_ADMIN, nuevaClave);
  if (nuevoPin) await C.fijarSecreto(credenciales, C.ID_CAJA, nuevoPin);
  const codigo = await C.nuevoCodigo(credenciales);                       // el código anterior (si existía) deja de servir
  let quien = 'PC local';
  try { quien = `PC local (${os.userInfo().username}@${os.hostname()})`; } catch {}
  await auditoria.insertOne({ fecha: new Date(), accion: 'RESET_ADMIN_PC', ip: quien, detalle: 'contraseña del dueño + código' + (nuevoPin ? ' + PIN de caja' : '') });
  return { clave: nuevaClave, codigo, pin: nuevoPin };
}

async function cli() {
  try { require('@dotenvx/dotenvx').config({ quiet: true }); } catch { require('dotenv').config(); }
  const { MongoClient } = require('mongodb');
  const args = process.argv.slice(2);
  const val = n => { const a = args.find(x => x.startsWith('--' + n + '=')); return a ? a.slice(n.length + 3) : null; };
  if (!process.env.MONGODB_URI) { console.error('❌ Falta MONGODB_URI en tu .env (este comando se conecta a la misma base que el servidor).'); process.exit(1); }

  if (!args.includes('--si')) {
    const rl = require('readline').createInterface({ input: process.stdin, output: process.stdout });
    const r = await new Promise(ok => rl.question('Esto reemplaza la contraseña del dueño y su código de recuperación actuales. ¿Continuar? (s/N) ', ok));
    rl.close();
    if (!/^s/i.test(r.trim())) { console.log('Cancelado. No se cambió nada.'); return; }
  }
  const mongo = new MongoClient(process.env.MONGODB_URI);
  try {
    await mongo.connect();
    const r = await reiniciar(mongo.db(process.env.MONGODB_DB || 'putadelicia'), { conCaja: args.includes('--caja'), clave: val('clave'), pin: val('pin') });
    console.log('\n✔ Listo. Entrégale esto al dueño (se muestra UNA sola vez, no queda guardado en claro en ningún lado):\n');
    console.log('   Contraseña del dueño : ' + r.clave);
    console.log('   Código de recuperación: ' + r.codigo);
    if (r.pin) console.log('   PIN de caja           : ' + r.pin);
    console.log('\n   Recomiéndale cambiar la contraseña desde el panel (Admin → Seguridad).\n');
  } finally { await mongo.close(); }
}

if (require.main === module) cli().catch(e => { console.error('❌ ' + e.message); process.exit(1); });
module.exports = { reiniciar };
