'use strict';
/**
 * Credenciales del local: contraseña del DUEÑO, PIN de CAJA y código de recuperación del dueño.
 *
 *  - Nada se guarda en claro: todo se guarda con scrypt (hash lento + sal aleatoria propia) en la colección «credenciales».
 *  - El .env solo sirve para sembrar la primera vez; después manda lo que hay en la base.
 *  - El código de recuperación sirve una sola vez: al usarlo se reemplaza (de forma atómica) por uno nuevo.
 */
const crypto = require('crypto');

const ID_ADMIN = 'admin', ID_CAJA = 'caja';

/* ================= Hash (scrypt) ================= */
const scrypt = (secreto, sal) => new Promise((ok, no) =>
  crypto.scrypt(String(secreto).normalize('NFKC'), sal, 64, { N: 16384, r: 8, p: 1 }, (e, k) => (e ? no(e) : ok(k))));

async function hashear(secreto) {
  const sal = crypto.randomBytes(16);
  return 's1$' + sal.toString('base64') + '$' + (await scrypt(secreto, sal)).toString('base64');
}
async function verificar(secreto, almacenado) {
  const p = String(almacenado || '').split('$');
  if (p.length !== 3 || p[0] !== 's1') return false;
  const esperado = Buffer.from(p[2], 'base64');
  const k = await scrypt(secreto, Buffer.from(p[1], 'base64'));
  return k.length === esperado.length && crypto.timingSafeEqual(k, esperado);
}

/* ================= Reglas ================= */
// Contraseña del dueño: mín. 10 caracteres, mayúscula, minúscula, número y símbolo. Sin repeticiones ni secuencias obvias.
const PALABRAS_OBVIAS = ['password', 'passw0rd', 'contrasena', 'qwerty', 'admin', 'letmein', 'welcome', 'bienvenid', '123456', 'abc123', 'iloveyou', 'dueno'];
const leet = t => t.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .replace(/0/g, 'o').replace(/[1!|]/g, 'i').replace(/3/g, 'e').replace(/4|@/g, 'a').replace(/5|\$/g, 's').replace(/7/g, 't');

// ¿Hay una escalera de `n` caracteres seguidos (1234, abcd, 4321, dcba)? Sirve para dígitos y letras.
function haySecuencia(t, n) {
  const s = t.toLowerCase();
  for (let i = 0; i + n <= s.length; i++) {
    let sube = true, baja = true;
    for (let j = 1; j < n; j++) {
      const d = s.charCodeAt(i + j) - s.charCodeAt(i + j - 1);
      if (d !== 1) sube = false;
      if (d !== -1) baja = false;
    }
    if (sube || baja) return true;
  }
  return false;
}
const hayRepetidos = (t, n) => new RegExp('(.)\\1{' + (n - 1) + ',}').test(t);

function validarClaveAdmin(c) {
  const s = typeof c === 'string' ? c : '';
  if (s.length < 10) return { ok: false, error: 'La contraseña debe tener al menos 10 caracteres.' };
  if (s.length > 128) return { ok: false, error: 'La contraseña es demasiado larga (máximo 128 caracteres).' };
  if (s !== s.trim()) return { ok: false, error: 'La contraseña no puede empezar ni terminar con espacios.' };
  if (!/[a-z]/.test(s) || !/[A-Z]/.test(s) || !/\d/.test(s) || !/[^A-Za-z0-9]/.test(s))
    return { ok: false, error: 'Usa mayúscula, minúscula, número y un símbolo (por ejemplo * _ - ! #).' };
  if (hayRepetidos(s, 3)) return { ok: false, error: 'Evita repetir el mismo carácter 3 veces seguidas (aaa, 111).' };
  if (haySecuencia(s, 4)) return { ok: false, error: 'Evita secuencias como 1234 o abcd.' };
  const n = leet(s);
  if (PALABRAS_OBVIAS.some(w => n.includes(w))) return { ok: false, error: 'Esa contraseña es demasiado común. Elige otra.' };
  return { ok: true };
}

// PIN de caja: solo dígitos, mínimo 6 (máximo 12) y sin combinaciones obvias.
const PINES_COMUNES = new Set(['123456', '1234567', '12345678', '123456789', '654321', '123123', '112233', '121212', '159753', '147258', '147258369',
  '696969', '123321', '101010', '202020', '111222', '123654', '456789', '789456', '000123', '654123', '987654', '102030', '112358', '520520', '246810']);
function validarPinCaja(p) {
  const s = typeof p === 'string' ? p : '';
  if (!/^\d+$/.test(s)) return { ok: false, error: 'El PIN de caja solo puede tener números.' };
  if (s.length < 6) return { ok: false, error: 'El PIN de caja debe tener al menos 6 dígitos.' };
  if (s.length > 12) return { ok: false, error: 'El PIN de caja es demasiado largo (máximo 12 dígitos).' };
  const obvio = { ok: false, error: 'Ese PIN es muy fácil de adivinar (repetidos, secuencias o combinaciones típicas). Elige otro.' };
  if (new Set(s).size < 3) return obvio;                                     // 121212, 000111
  if (haySecuencia(s, 4) || hayRepetidos(s, 4)) return obvio;                // 123456, 5555xx, 98765x
  if (PINES_COMUNES.has(s)) return obvio;
  if (s === [...s].reverse().join('')) return obvio;                         // capicúa: 123321
  for (let per = 1; per <= s.length / 2; per++)                              // patrón repetido: 123123, 4545 45
    if (s.length % per === 0 && s === s.slice(0, per).repeat(s.length / per)) return obvio;
  return { ok: true };
}

/* ================= Generadores ================= */
const ALFABETO_CODIGO = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';   // 32 caracteres, sin 0/O/1/I (no se confunden al copiar a mano)
function generarCodigo() {
  const b = crypto.randomBytes(16);
  let t = '';
  for (let i = 0; i < 16; i++) t += ALFABETO_CODIGO[b[i] & 31];
  return t.match(/.{4}/g).join('-');                          // XXXX-XXXX-XXXX-XXXX (80 bits)
}
const normalizarCodigo = c => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const codigoValido = c => normalizarCodigo(c).length === 16 && [...normalizarCodigo(c)].every(x => ALFABETO_CODIGO.includes(x));

function generarClaveAdmin() {
  const L = 'abcdefghjkmnpqrstuvwxyz', U = 'ABCDEFGHJKMNPQRSTUVWXYZ', D = '23456789', S = '!#$%*+-=?@_';
  const pick = set => set[crypto.randomInt(set.length)];
  for (;;) {
    const ch = [pick(L), pick(U), pick(D), pick(S)];
    const todo = L + U + D + S;
    while (ch.length < 16) ch.push(pick(todo));
    for (let i = ch.length - 1; i > 0; i--) { const j = crypto.randomInt(i + 1); [ch[i], ch[j]] = [ch[j], ch[i]]; }
    const c = ch.join('');
    if (validarClaveAdmin(c).ok) return c;
  }
}
function generarPinCaja() {
  for (;;) {
    const p = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    if (validarPinCaja(p).ok) return p;
  }
}

/* ================= Base de datos (colección «credenciales») ================= */
// Documentos: { _id:'admin', hash, actualizado, recuperacion:{ hash, rid, creado } }  y  { _id:'caja', hash, actualizado }
const obtener = (col, id) => col.findOne({ _id: id });

async function fijarSecreto(col, id, secreto) {
  await col.updateOne({ _id: id }, { $set: { hash: await hashear(secreto), actualizado: new Date() } }, { upsert: true });
}
// Crea (o reemplaza) el código de recuperación del dueño y devuelve el código en claro (la única vez que existe en claro).
async function nuevoCodigo(col) {
  const codigo = generarCodigo();
  const rec = { hash: await hashear(normalizarCodigo(codigo)), rid: crypto.randomBytes(8).toString('hex'), creado: new Date() };
  await col.updateOne({ _id: ID_ADMIN }, { $set: { recuperacion: rec } }, { upsert: true });
  return codigo;
}
/**
 * Usa el código de recuperación: si es correcto, fija la nueva contraseña y entrega un código NUEVO.
 * El cambio es atómico (condicionado al «rid» del código vigente): dos usos simultáneos del mismo código no pasan los dos.
 * Devuelve { ok:true, codigo } o { ok:false, motivo: 'sin_codigo' | 'incorrecto' | 'usado' }
 */
async function usarCodigo(col, codigoIngresado, nuevaClave) {
  const doc = await obtener(col, ID_ADMIN);
  if (!doc?.recuperacion) return { ok: false, motivo: 'sin_codigo' };
  if (!codigoValido(codigoIngresado) || !(await verificar(normalizarCodigo(codigoIngresado), doc.recuperacion.hash))) return { ok: false, motivo: 'incorrecto' };
  const codigo = generarCodigo();
  const rec = { hash: await hashear(normalizarCodigo(codigo)), rid: crypto.randomBytes(8).toString('hex'), creado: new Date() };
  const r = await col.updateOne(
    { _id: ID_ADMIN, 'recuperacion.rid': doc.recuperacion.rid },
    { $set: { hash: await hashear(nuevaClave), actualizado: new Date(), recuperacion: rec } });
  if (!r.matchedCount) return { ok: false, motivo: 'usado' };
  return { ok: true, codigo };
}

// Comprueba el código SIN gastarlo (lo usa el Excel completo). El código sigue siendo el mismo.
async function verificarCodigo(col, codigoIngresado) {
  const doc = await obtener(col, ID_ADMIN);
  if (!doc?.recuperacion?.hash || !codigoValido(codigoIngresado)) return false;
  return verificar(normalizarCodigo(codigoIngresado), doc.recuperacion.hash);
}

module.exports = {
  ID_ADMIN, ID_CAJA, hashear, verificar, validarClaveAdmin, validarPinCaja, generarCodigo, generarClaveAdmin, generarPinCaja,
  normalizarCodigo, codigoValido, obtener, fijarSecreto, nuevoCodigo, usarCodigo, verificarCodigo,
};
