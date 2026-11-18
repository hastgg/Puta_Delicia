'use strict';
/**
 * Cifrado de datos personales (WhatsApp, correo, fecha de nacimiento).
 *
 *  - cifrar / descifrar: AES-256-GCM. Cada valor lleva su propio IV aleatorio y una etiqueta de integridad.
 *    El nombre del campo se usa como dato asociado (AAD): un valor cifrado de "correo" no se puede pasar a "whatsapp".
 *  - hash: HMAC-SHA256 con clave secreta ("blind index"). Sirve para buscar o detectar repetidos
 *    sin guardar el dato en claro (no se puede revertir sin la clave).
 *
 * La clave maestra (DATA_KEY, 32 bytes en base64) vive SOLO en las variables de entorno del servidor, nunca en la base de datos.
 * ⚠️ Si pierdes DATA_KEY no hay forma de recuperar los datos cifrados: guarda una copia en un gestor de contraseñas.
 */
const crypto = require('crypto');

const PREFIJO = 'v1:';
let kEnc = null, kHash = null;

function iniciar(claveBase64) {
  const raw = Buffer.from(String(claveBase64 || ''), 'base64');
  if (raw.length !== 32) throw new Error('DATA_KEY debe ser 32 bytes en base64. Genera una con: node scripts/generar-clave.js');
  // Dos claves distintas derivadas de la maestra (una para cifrar, otra para los hashes)
  kEnc = Buffer.from(crypto.hkdfSync('sha256', raw, Buffer.alloc(0), 'pd-cifrado-v1', 32));
  kHash = Buffer.from(crypto.hkdfSync('sha256', raw, Buffer.alloc(0), 'pd-hash-v1', 32));
}

const estaCifrado = v => typeof v === 'string' && v.startsWith(PREFIJO);

function cifrar(valor, campo) {
  if (valor === null || valor === undefined || valor === '') return valor ?? null;
  if (estaCifrado(valor)) return valor;
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', kEnc, iv);
  c.setAAD(Buffer.from(campo));
  const ct = Buffer.concat([c.update(String(valor), 'utf8'), c.final()]);
  return PREFIJO + Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64');
}

// Si el valor no está cifrado (datos antiguos) lo devuelve tal cual, así la migración puede ser gradual.
function descifrar(valor, campo) {
  if (!estaCifrado(valor)) return valor ?? null;
  const b = Buffer.from(valor.slice(PREFIJO.length), 'base64');
  const d = crypto.createDecipheriv('aes-256-gcm', kEnc, b.subarray(0, 12));
  d.setAAD(Buffer.from(campo));
  d.setAuthTag(b.subarray(12, 28));
  return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8');
}

const hash = (contexto, valor) =>
  crypto.createHmac('sha256', kHash).update(contexto + '\u0000' + String(valor)).digest('hex');

module.exports = { iniciar, cifrar, descifrar, hash, estaCifrado };
