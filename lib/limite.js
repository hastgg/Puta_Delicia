'use strict';
/**
 * Limitador de intentos en memoria (sin dependencias).
 * Cada "cubeta" cuenta eventos por clave (normalmente la IP) dentro de una ventana de tiempo.
 * Nota: vive en la memoria del proceso; si reinicias el servidor se vacía. Para varios servidores, usa Redis.
 */
const cubetas = new Map(); // clave -> { n, hasta }

function bloqueado(clave, max) {
  const r = cubetas.get(clave);
  return !!r && Date.now() < r.hasta && r.n >= max;
}
function sumar(clave, ventanaMs) {
  const r = cubetas.get(clave);
  if (r && Date.now() < r.hasta) { r.n++; return r.n; }
  cubetas.set(clave, { n: 1, hasta: Date.now() + ventanaMs });
  return 1;
}
function limpiar(clave) { cubetas.delete(clave); }

/**
 * Middleware: máximo `max` peticiones por ventana y por IP.
 * Con { soloFallos: true } solo cuentan las respuestas con error (4xx), útil contra enumeración y fuerza bruta.
 */
function limitar(nombre, { max, ventanaMs, soloFallos = false, mensaje = 'Demasiadas solicitudes. Intenta de nuevo en unos minutos.' }) {
  return (req, res, next) => {
    const clave = `${nombre}:${req.ip}`;
    if (bloqueado(clave, max)) return res.status(429).json({ ok: false, error: mensaje });
    if (soloFallos) res.on('finish', () => { if (res.statusCode >= 400 && res.statusCode !== 429) sumar(clave, ventanaMs); });
    else sumar(clave, ventanaMs);
    next();
  };
}

// Evita que el mapa crezca sin fin
setInterval(() => { const t = Date.now(); for (const [k, v] of cubetas) if (t >= v.hasta) cubetas.delete(k); }, 60000).unref();

module.exports = { limitar, bloqueado, sumar, limpiar };
