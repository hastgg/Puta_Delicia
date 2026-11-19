'use strict';
/**
 * Base de datos simulada en memoria (solo para las pruebas): imita lo mínimo del driver de MongoDB que usa el proyecto.
 * Soporta filtros por igualdad, rutas con punto ('recuperacion.rid'), $in, $exists, $type, $or; $set; upsert; sort/skip/limit.
 */
const get = (o, ruta) => ruta.split('.').reduce((a, k) => (a == null ? undefined : a[k]), o);
function set(o, ruta, v) { const p = ruta.split('.'); let a = o; for (const k of p.slice(0, -1)) a = a[k] ??= {}; a[p.at(-1)] = v; }
const clon = x => (x === undefined ? x : structuredClone(x));

function coincide(doc, filtro = {}) {
  return Object.entries(filtro).every(([k, cond]) => {
    if (k === '$or') return cond.some(f => coincide(doc, f));
    const v = get(doc, k);
    if (cond && typeof cond === 'object' && !(cond instanceof Date) && !Array.isArray(cond)) {
      if ('$in' in cond) return cond.$in.includes(v);
      if ('$exists' in cond) return (v !== undefined) === cond.$exists;
      if ('$type' in cond) return typeof v === cond.$type;
      if ('$regex' in cond) return typeof v === 'string' && new RegExp(cond.$regex).test(v);
    }
    return v instanceof Date && cond instanceof Date ? +v === +cond : v === cond;
  });
}

class Coleccion {
  constructor() { this.docs = []; }
  async findOne(f) { return clon(this.docs.find(d => coincide(d, f))) ?? null; }
  find(f) {
    let r = this.docs.filter(d => coincide(d, f)), o = null, l = Infinity, sk = 0;
    const cur = {
      sort(s) { o = s; return cur; }, limit(n) { l = n; return cur; }, skip(n) { sk = n; return cur; },
      async toArray() {
        if (o) { const [k, dir] = Object.entries(o)[0]; r = [...r].sort((a, b) => (a[k] > b[k] ? 1 : a[k] < b[k] ? -1 : 0) * dir); }
        return r.slice(sk, sk + l).map(clon);
      },
    };
    return cur;
  }
  async insertOne(d) { this.docs.push(clon({ _id: d._id ?? 'oid' + this.docs.length + Math.random().toString(36).slice(2), ...d })); return { acknowledged: true }; }
  async updateOne(f, u, { upsert = false } = {}) {
    let d = this.docs.find(x => coincide(x, f));
    if (!d) {
      if (!upsert) return { matchedCount: 0, modifiedCount: 0 };
      d = {}; for (const [k, v] of Object.entries(f)) if (!k.includes('.') && !k.startsWith('$') && typeof v !== 'object') d[k] = v;
      this.docs.push(d);
    }
    for (const [k, v] of Object.entries(u.$set || {})) set(d, k, clon(v));
    return { matchedCount: 1, modifiedCount: 1 };
  }
  async deleteOne(f) { const i = this.docs.findIndex(d => coincide(d, f)); if (i < 0) return { deletedCount: 0 }; this.docs.splice(i, 1); return { deletedCount: 1 }; }
  async deleteMany(f) { const n = this.docs.length; this.docs = this.docs.filter(d => !coincide(d, f)); return { deletedCount: n - this.docs.length }; }
  async countDocuments(f) { return this.docs.filter(d => coincide(d, f)).length; }
  async createIndex() { return 'ok'; }
  async dropIndex() { return {}; }
}

class BaseFalsa {
  constructor() { this.cols = {}; }
  collection(n) { return (this.cols[n] ??= new Coleccion()); }
}
// Imita MongoClient: siempre entrega la misma base (así el test puede mirar lo que guardó el servidor)
const compartida = new BaseFalsa();
class MongoClientFalso {
  async connect() {} async close() {}
  db() { return compartida; }
}
module.exports = { BaseFalsa, MongoClientFalso, compartida };
