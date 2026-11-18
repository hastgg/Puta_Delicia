'use strict';
/**
 * Genera la clave maestra que cifra los datos personales.
 *   node scripts/generar-clave.js            → solo la muestra
 *   node scripts/generar-clave.js --agregar  → la agrega a tu .env (sin mostrarla en pantalla)
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const clave = crypto.randomBytes(32).toString('base64');

if (!process.argv.includes('--agregar')) {
  console.log('\nCopia esta línea en tu archivo .env (y guarda una copia en un lugar seguro):\n');
  console.log('DATA_KEY=' + clave);
} else {
  const ruta = path.join(__dirname, '..', '.env');
  const actual = fs.existsSync(ruta) ? fs.readFileSync(ruta, 'utf8') : '';
  if (/^DATA_KEY=\S+/m.test(actual)) {
    console.error('\n❌ Tu .env ya tiene una DATA_KEY. No la reemplazo: cambiarla dejaría ilegibles los datos ya cifrados.\n');
    process.exit(1);
  }
  const base = actual.replace(/^DATA_KEY=\s*$/m, '').replace(/\s*$/, '');          // quita una línea vacía "DATA_KEY=" si existe
  fs.writeFileSync(ruta, (base ? base + '\n\n' : '') + '# Clave que cifra WhatsApp, correo y fecha de nacimiento (no la pierdas)\nDATA_KEY=' + clave + '\n');
  console.log('\n✔ DATA_KEY agregada a tu .env.');
}
console.log('\n⚠️  Guarda una copia de DATA_KEY en un gestor de contraseñas: si la pierdes, los datos cifrados no se pueden recuperar.');
console.log('    No la subas a GitHub ni la compartas.\n');
