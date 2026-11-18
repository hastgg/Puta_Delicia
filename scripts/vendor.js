'use strict';
/**
 * Descarga qrcode, jsQR y Chart.js a public/vendor y cambia index.html para cargarlos desde tu propio servidor.
 * Así, si un CDN de terceros se compromete, su código no corre en la página donde el dueño escribe su PIN.
 * Uso (una sola vez, con internet):  npm run vendor
 * (Tailwind por CDN no se puede alojar así: para eso hace falta compilarlo con su CLI.)
 */
const fs = require('fs');
const path = require('path');

const LIBS = [
  ['https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js', 'qrcode.min.js'],
  ['https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.js', 'jsQR.js'],
  ['https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js', 'chart.umd.min.js'],
];
const PUB = path.join(__dirname, '..', 'public');

(async () => {
  fs.mkdirSync(path.join(PUB, 'vendor'), { recursive: true });
  let html = fs.readFileSync(path.join(PUB, 'index.html'), 'utf8');
  for (const [url, nombre] of LIBS) {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`No se pudo descargar ${url} (${r.status})`);
    const txt = await r.text();
    if (txt.length < 1000) throw new Error(`Respuesta sospechosamente corta para ${url}`);
    fs.writeFileSync(path.join(PUB, 'vendor', nombre), txt);
    html = html.split(`src="${url}"`).join(`src="vendor/${nombre}"`);
    console.log('✔', nombre);
  }
  fs.writeFileSync(path.join(PUB, 'index.html'), html);
  console.log('Listo: index.html ahora usa public/vendor.');
})().catch(e => { console.error('❌', e.message); process.exit(1); });
