'use strict';
/* Puta Delicia BBQ House — lógica del frontend (habla con la API del servidor) */
const GOAL = 8, $ = s => document.querySelector(s);

/* ================= API ================= */
// Mismo servidor por defecto. Si abres el archivo con doble clic (file://) apunta a localhost:3000.
const API = window.API_URL || (location.protocol === 'file:' ? 'http://localhost:3000' : '');
async function api(ruta, { method = 'GET', body, pin } = {}) {
  try {
    const r = await fetch(API + ruta, {
      method,
      headers: { ...(body && { 'Content-Type': 'application/json' }), ...(pin && { 'x-pin': encodeURIComponent(pin) }) },
      body: body ? JSON.stringify(body) : undefined
    });
    const data = await r.json().catch(() => ({}));
    return { ...data, ok: r.ok && data.ok !== false, status: r.status };
  } catch { return { ok: false, status: 0, error: 'No hay conexión con el servidor.' }; }
}

/* ================= Sesión (solo guarda el ID del cliente y el PIN de la sesión) ================= */
const Me = {
  get() { try { return localStorage.getItem('pd_me'); } catch { return null; } },
  set(id) { try { localStorage.setItem('pd_me', id); } catch {} },
  clear() { try { localStorage.removeItem('pd_me'); } catch {} }
};
let pin = sessionStorage.getItem('pd_pin') || '', staffId = null, qrFor = null, poll = null;

/* ================= Navegación ================= */
function tab(name) {
  document.querySelectorAll('.view').forEach(v => v.classList.toggle('active', v.id === 'view-' + name));
  document.querySelectorAll('.tab').forEach(t => {
    const on = t.dataset.tab === name || (['recuperar', 'terminos'].includes(name) && t.dataset.tab === 'registro') || (name === 'admin' && t.dataset.tab === 'caja');
    t.className = 'tab flex-1 py-4 border-b-2 transition-colors font-display text-xl tracking-wider font-normal ' + (on ? 'text-white border-fire' : 'text-[#A3A3A3] border-transparent hover:text-white');
  });
  clearInterval(poll);
  document.body.classList.toggle('wide', name === 'admin');   // el panel admin usa más ancho
  document.dispatchEvent(new Event('pd:tab'));     // el escáner se apaga al cambiar de pestaña
  if (name === 'tarjeta') { renderCard(); poll = setInterval(renderCard, 8000); } // refleja visitas sumadas en caja
  if (name === 'caja') showStaff(!!pin);
  if (name === 'admin') Admin.enter();
}
document.querySelectorAll('[data-tab],[data-go]').forEach(b => b.onclick = () => tab(b.dataset.tab || b.dataset.go));

$('#btn-enter').onclick = () => {
  const s = $('#splash'); s.classList.add('opacity-0', 'pointer-events-none');
  setTimeout(() => s.classList.add('hidden'), 700);
  tab(Me.get() ? 'tarjeta' : 'registro');
};
tab('registro');

/* ================= Sellos (8 casillas: 4 + 4) ================= */
function stamps(v, small) {
  const toro = `<svg viewBox="0 0 200 64.7" class="w-[84%]" aria-hidden="true"><use href="#toro"/></svg>`;
  return Array.from({ length: GOAL }, (_, i) => {
    const n = i + 1, gift = n === GOAL, on = v >= n, t = small ? 'text-xs' : 'text-sm';
    if (gift) return `<div class="stamp ${t} text-center leading-tight ${on ? 'bg-ember text-black shadow-[0_0_16px_rgba(245,158,11,.5)]' : 'border-2 border-dashed border-ember text-ember'}">CORTESÍA</div>`;
    return `<div class="stamp ${on ? 'bg-fire text-white shadow-[0_0_14px_rgba(230,46,45,.5)]' : 'border-2 border-dashed border-[#444] text-[#4a4a4a]'}">${toro}</div>`;
  }).join('');
}

/* ================= Registro ================= */
$('#form').addEventListener('submit', async e => {
  e.preventDefault();
  const f = e.target, d = new FormData(f), err = $('#form-error'), btn = f.querySelector('[type=submit]');
  err.textContent = '';
  if (!f.terms.checked) return err.textContent = 'Debes aceptar los términos y condiciones para unirte.';
  btn.disabled = true;
  const r = await api('/api/registro', { method: 'POST', body: {
    nombre: d.get('name'), whatsapp: d.get('phone'), correo: d.get('email'), fecha_nacimiento: d.get('birth'),
    acepta_terminos: f.terms.checked, acepta_notificaciones: f.consent.checked
  }});
  btn.disabled = false;
  if (!r.ok) return err.textContent = r.error || 'No se pudo completar el registro.';
  Me.set(r.cliente.id); f.reset();
  toast('¡Bienvenido al Club BBQ!'); tab('tarjeta');
});

/* ================= Recuperar tarjeta ================= */
$('#form-recuperar').addEventListener('submit', async e => {
  e.preventDefault();
  const f = e.target, d = new FormData(f), err = $('#rec-error'), btn = f.querySelector('[type=submit]');
  err.textContent = ''; btn.disabled = true;
  const r = await api('/api/recuperar', { method: 'POST', body: { nombre: d.get('nombre'), ultimos4: d.get('ultimos4') } });
  btn.disabled = false;
  if (!r.ok) return err.textContent = r.error || 'No se pudo recuperar la tarjeta.';
  Me.set(r.cliente.id); f.reset();
  toast('¡Qué bueno verte de nuevo, ' + r.cliente.nombre.split(' ')[0] + '!'); tab('tarjeta');
});

/* ================= Tarjeta VIP ================= */
async function renderCard() {
  const id = Me.get(), vacio = $('#card-empty'), cont = $('#card-content');
  if (!id) { vacio.classList.remove('hidden'); cont.classList.add('hidden'); return; }
  const r = await api('/api/cliente/' + encodeURIComponent(id));
  if (r.status === 404) { Me.clear(); return renderCard(); }
  if (!r.ok) { if (cont.classList.contains('hidden')) toast(r.error); return; }
  const c = r.cliente;
  vacio.classList.add('hidden'); cont.classList.remove('hidden');
  $('#c-name').textContent = c.nombre;
  $('#c-progress').textContent = `${c.puntos} / ${GOAL} VISITAS`;
  $('#c-stamps').innerHTML = stamps(c.puntos);
  $('#c-reward').classList.toggle('hidden', !c.premio_listo);
  Rate.sync(c);
  $('#c-code').textContent = c.id;
  if (qrFor !== c.id) {
    const q = $('#qr'); q.innerHTML = '';
    if (window.QRCode) new QRCode(q, { text: c.id, width: 170, height: 170, colorDark: '#000', colorLight: '#fff' });
    else q.textContent = 'QR no disponible sin conexión';
    qrFor = c.id;
  }
}

/* ================= Calificación (aparece cuando caja suma una visita) ================= */
const STAR = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2.5l2.9 6.1 6.6.9-4.8 4.6 1.2 6.6L12 17.4l-5.9 3.3 1.2-6.6L2.5 9.5l6.6-.9z"/></svg>';
const ETIQUETAS = ['', 'Muy mala', 'Mejorable', 'Buena', 'Muy buena', '¡Excelente!'];
const CATS = ['servicio', 'comida', 'lugar'];
// Misma ponderación que el servidor (el servidor es quien manda; esto es solo la vista previa)
const PESOS = { servicio: 1, comida: 1, lugar: 1 };
const Rate = {
  vals: {}, id: null, descartada: false,
  // Crea 5 estrellas dentro de `box`; llama a onPick(n) al elegir. Se puede cambiar de opinión.
  build(box, onPick) {
    box.innerHTML = '';
    for (let n = 1; n <= 5; n++) {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'star'; b.innerHTML = STAR;
      b.setAttribute('role', 'radio'); b.setAttribute('aria-checked', 'false');
      b.setAttribute('aria-label', n + (n === 1 ? ' estrella' : ' estrellas'));
      b.onclick = () => { onPick(n); box.querySelectorAll('.star').forEach((s, i) => {
        s.classList.toggle('on', i < n); s.setAttribute('aria-checked', String(i + 1 === n)); }); };
      box.append(b);
    }
  },
  // Calificación general = promedio ponderado de las 3; se recalcula al instante
  general() {
    const hechas = CATS.filter(k => this.vals[k]);
    if (hechas.length < CATS.length) return null;
    const pt = CATS.reduce((a, k) => a + PESOS[k], 0);
    return Math.round(CATS.reduce((a, k) => a + this.vals[k] * PESOS[k], 0) / pt * 10) / 10;
  },
  pintarGeneral() {
    const g = this.general();
    $('#rate-general-fill').style.width = g ? (g / 5 * 100) + '%' : '0';
    $('#rate-general-num').textContent = g ? g.toFixed(1) : '';
    $('#rate-general-label').textContent = g ? ETIQUETAS[Math.round(g)] : '';
    $('#rate-general').setAttribute('aria-label', g ? `Calificación general: ${g.toFixed(1)} de 5` : 'Calificación general: sin calificar');
    $('#rate-send').disabled = !g;
  },
  reset() {
    this.vals = {};
    $('#rate-comment').value = ''; $('#rate-count').textContent = '0'; $('#rate-error').textContent = '';
    for (const id of ['#rate-general .gstars-base', '#rate-general-fill']) $(id).innerHTML = STAR.repeat(5);
    this.pintarGeneral();
    document.querySelectorAll('#rate-form .stars').forEach(box => this.build(box, n => { this.vals[box.dataset.key] = n; this.pintarGeneral(); }));
  },
  open() {
    if (!$('#rate').classList.contains('show')) { this.reset(); $('#rate').classList.add('show'); }
  },
  close() { $('#rate').classList.remove('show'); },
  // Se llama cada vez que se refresca la tarjeta: muestra el formulario solo si hay una visita por calificar
  sync(c) {
    if (this.id !== c.id) { this.id = c.id; this.descartada = false; }
    const pend = !!c.calificacion_pendiente;
    $('#c-rate').classList.toggle('hidden', !(pend && this.descartada));
    if (!pend) { this.descartada = false; this.close(); return; }
    if (!this.descartada) {
      $('#rate-name').textContent = (c.nombre.split(' ')[0]) + ', tu opinión nos ayuda a mejorar';
      const v = c.calificacion_vence ? new Date(c.calificacion_vence) : null;
      $('#rate-vence').textContent = v ? 'Puedes calificar hasta las ' + v.toLocaleTimeString('es-CO', { hour: 'numeric', minute: '2-digit' }) : '';
      this.open();
    }
  }
};
$('#rate-skip').onclick = () => { Rate.descartada = true; Rate.close(); $('#c-rate').classList.remove('hidden'); };
$('#c-rate').onclick = () => { Rate.descartada = false; $('#c-rate').classList.add('hidden'); Rate.open(); };
$('#rate-comment').oninput = e => { $('#rate-count').textContent = e.target.value.length; };
$('#rate-form').addEventListener('submit', async e => {
  e.preventDefault();
  if (Rate.general() === null) return $('#rate-error').textContent = 'Califica servicio, comida y lugar.';
  const btn = $('#rate-send'), err = $('#rate-error'); btn.disabled = true; err.textContent = '';
  const r = await api('/api/calificar', { method: 'POST', body: { id: Me.get(), servicio: Rate.vals.servicio, comida: Rate.vals.comida, lugar: Rate.vals.lugar, comentario: $('#rate-comment').value } });
  if (!r.ok && r.status !== 409) { btn.disabled = false; return err.textContent = r.error || 'No se pudo enviar. Intenta de nuevo.'; }
  Rate.close(); $('#c-rate').classList.add('hidden'); Rate.descartada = false;
  toast(r.ok ? '¡Gracias por tu opinión!' : r.error);
  renderCard();
});

/* ================= Caja / Staff ================= */
function showStaff(open) {
  $('#s-lock').classList.toggle('hidden', open);
  $('#s-main').classList.toggle('hidden', !open);
  if (open && staffId) cargarStaff(staffId);
}
$('#s-unlock').onclick = async () => {
  const p = $('#s-pin').value.trim(); if (!p) return;
  const r = await api('/api/verificar-pin', { method: 'POST', pin: p });
  if (!r.ok) return toast(r.error || 'PIN incorrecto');
  pin = p; sessionStorage.setItem('pd_pin', p); $('#s-pin').value = ''; showStaff(true);
};
$('#s-close').onclick = () => { pin = ''; staffId = null; sessionStorage.removeItem('pd_pin'); pintarStaff(null); showStaff(false); };
$('#s-pin').onkeydown = e => { if (e.key === 'Enter') $('#s-unlock').click(); };
$('#s-code').onkeydown = e => { if (e.key === 'Enter') $('#s-search').click(); };

function pintarStaff(c) {
  $('#s-results').innerHTML = '';
  $('#s-panel').classList.toggle('hidden', !c);
  $('#s-empty').classList.toggle('hidden', !!c);
  if (!c) return;
  staffId = c.id;
  $('#s-name').textContent = c.nombre;
  $('#s-contact').textContent = `${c.id} · ${c.whatsapp} · ${c.correo}`;
  $('#s-visits').textContent = c.puntos;
  $('#s-stamps').innerHTML = stamps(c.puntos, true);
  $('#s-add').disabled = c.puntos >= GOAL;
  $('#s-redeem').disabled = !c.premio_listo;
}
async function cargarStaff(id) {
  const r = await api('/api/cliente/' + encodeURIComponent(id), { pin });
  r.ok ? pintarStaff(r.cliente) : toast(r.error);
}
$('#s-search').onclick = async () => {
  const q = $('#s-code').value.trim(); if (!q) return;
  const r = await api('/api/buscar?q=' + encodeURIComponent(q), { pin });
  if (r.status === 401) { $('#s-close').click(); return toast('El PIN ya no es válido. Ingrésalo de nuevo.'); }
  if (!r.ok) return toast(r.error);
  if (!r.resultados.length) return toast('No se encontró ningún cliente');
  if (r.resultados.length === 1) return pintarStaff(r.resultados[0]);
  const lista = $('#s-results'); lista.innerHTML = '';
  r.resultados.forEach(c => {                       // varios resultados: elegir uno (textContent evita inyección HTML)
    const b = document.createElement('button');
    b.className = 'btn !text-left !font-semibold bg-ink border border-[#333] hover:border-fire !py-3 px-4';
    b.textContent = `${c.nombre} · ${c.id}`;
    b.onclick = () => pintarStaff(c);
    lista.append(b);
  });
};
/* ================= Escáner de QR con la cámara (caja) ================= */
// Usa el lector nativo del navegador (BarcodeDetector) y, si no existe, la librería jsQR.
// La cámara solo funciona con HTTPS (o localhost): es una regla del navegador.
const Scan = {
  stream: null, raf: 0, on: false, det: null, canvas: null, ultimo: 0, aviso: 0,
  msg(t) { $('#scan-msg').textContent = t || ''; },
  async open() {
    if (this.on) return;
    if (!navigator.mediaDevices?.getUserMedia) return toast('La cámara requiere conexión segura (https). Escribe el código a mano.');
    this.on = true; this.msg('');
    $('#scan').classList.add('show');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
      if (!this.on) { stream.getTracks().forEach(t => t.stop()); return; }     // lo cerraron mientras pedía permiso
      this.stream = stream;
      const v = $('#scan-video'); v.srcObject = stream; await v.play();
    } catch (e) {
      this.close();
      return toast(e.name === 'NotAllowedError' ? 'Permiso de cámara denegado. Actívalo en el navegador.' : 'No se pudo abrir la cámara.');
    }
    if ('BarcodeDetector' in window) { try { this.det = new BarcodeDetector({ formats: ['qr_code'] }); } catch { this.det = null; } }
    if (!this.det && !window.jsQR) { this.close(); return toast('No se pudo cargar el lector de QR. Revisa la conexión.'); }
    this.loop();
  },
  close() {
    this.on = false; cancelAnimationFrame(this.raf);
    this.stream?.getTracks().forEach(t => t.stop()); this.stream = null;
    const v = $('#scan-video'); v.pause(); v.srcObject = null;
    $('#scan').classList.remove('show');
  },
  loop() {
    if (!this.on) return;
    this.raf = requestAnimationFrame(async () => {
      const v = $('#scan-video'), ahora = performance.now();
      if (v.readyState >= 2 && ahora - this.ultimo > 120) {      // ~8 lecturas por segundo
        this.ultimo = ahora;
        const texto = await this.leer(v).catch(() => '');
        if (texto && this.on) return this.encontrado(texto);
      }
      this.loop();
    });
  },
  async leer(v) {
    if (this.det) { const r = await this.det.detect(v); return r[0]?.rawValue || ''; }
    const w = v.videoWidth, h = v.videoHeight; if (!w) return '';
    const k = Math.min(1, 640 / w), cw = Math.round(w * k), ch = Math.round(h * k);
    const c = this.canvas ||= document.createElement('canvas'); c.width = cw; c.height = ch;
    const x = c.getContext('2d', { willReadFrequently: true }); x.drawImage(v, 0, 0, cw, ch);
    return window.jsQR(x.getImageData(0, 0, cw, ch).data, cw, ch, { inversionAttempts: 'dontInvert' })?.data || '';
  },
  encontrado(texto) {
    const m = /PD-[0-9A-Z]{6}/i.exec(texto);
    if (!m) {                                                   // un QR que no es de la tarjeta: se ignora y se sigue buscando
      this.msg('Ese QR no es de una tarjeta Puta Delicia');
      clearTimeout(this.aviso); this.aviso = setTimeout(() => this.msg(''), 2000);
      return this.loop();
    }
    navigator.vibrate?.(80);
    this.close();
    $('#s-code').value = m[0].toUpperCase();
    $('#s-search').click();
  }
};
$('#s-scan').onclick = () => Scan.open();
$('#scan-close').onclick = () => Scan.close();
document.addEventListener('pd:tab', () => Scan.close());
document.addEventListener('keydown', e => { if (e.key === 'Escape' && Scan.on) Scan.close(); });

async function accion(ruta, mensaje) {
  if (!staffId) return;
  $('#s-add').disabled = $('#s-redeem').disabled = true;     // evita doble toque
  const r = await api(ruta, { method: 'POST', body: { id: staffId }, pin });
  if (!r.ok) { toast(r.error || 'No se pudo completar la acción'); return cargarStaff(staffId); }
  pintarStaff(r.cliente); toast(mensaje(r));
}
$('#s-add').onclick = () => accion('/api/sumar-punto', r => r.premio_listo ? '¡Cortesía desbloqueada!' : 'Visita sumada');
$('#s-redeem').onclick = () => accion('/api/canjear-premio', () => 'Cortesía canjeada. Tarjeta reiniciada');

$('#s-delete').onclick = async () => {
  if (!staffId) return;
  if (!confirm('¿Eliminar a este cliente y todo su historial? No se puede deshacer.')) return;
  const p = prompt('Contraseña del dueño'); if (!p) return;
  const r = await api('/api/eliminar-cliente', { method: 'POST', body: { id: staffId }, pin: p });
  if (!r.ok) return toast(r.status === 401 ? 'Contraseña del dueño incorrecta' : (r.error || 'No se pudo eliminar'));
  staffId = null; pintarStaff(null); toast('Cliente eliminado');
};

$('#s-admin').onclick = () => tab('admin');

/* ================= Aviso flotante ================= */
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.remove('translate-y-24');
  clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.add('translate-y-24'), 2300);
}

/* ================= Acceso oculto a Caja ================= */
function mostrarCaja(on) {
  $('#tab-caja').hidden = !on;
  $('#toro-secreto').classList.toggle('text-fire', on);
$('#toro-secreto').classList.toggle('text-[#2b2b2b]', !on);
  try { on ? localStorage.setItem('pd_caja', '1') : localStorage.removeItem('pd_caja'); } catch {}
}
$('#toro-secreto').onclick = () => {
  const estabaVisible = !$('#tab-caja').hidden;
  mostrarCaja(!estabaVisible);
  if (estabaVisible && ($('#view-caja').classList.contains('active') || $('#view-admin').classList.contains('active'))) tab('registro');
};
try { mostrarCaja(localStorage.getItem('pd_caja') === '1'); } catch {}

/* ================= Admin / Dashboard ================= */
// Pantalla del dueño: resumen con gráficas, comparativas, ficha de cada cliente y descarga del Excel.
// Pide la CONTRASEÑA del dueño (el PIN de caja no sirve) y la guarda solo mientras la pestaña esté abierta.
const Admin = (() => {
  const TZ = 'America/Bogota';
  const FIRE = '#E62E2D', EMBER = '#F59E0B', GRIS = '#A3A3A3';
  const ESTRELLAS = ['#7F1D1D', '#E62E2D', '#F59E0B', '#FCD34D', '#FFFFFF'];     // 1★ oscuro → 5★ brillante
  const CAMPOS = [['servicio', 'Servicio', FIRE], ['comida', 'Comida', EMBER], ['lugar', 'Lugar', GRIS]];
  let pinA = sessionStorage.getItem('pd_admin') || '', modo = 'resumen', rango = '7d', gran = 'semana';
  let tokR = 0, tokC = 0, tokB = 0, tokL = 0, comparado = false;

  /* ---------- utilidades ---------- */
  const esc = t => String(t ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const num = (n, d = 1) => (n == null ? '–' : Number(n).toFixed(d));
  const plural = (n, s, p) => `${n} ${n === 1 ? s : p}`;
  const hoyBogota = () => new Date().toLocaleDateString('sv-SE', { timeZone: TZ });
  const hora12 = h => `${h % 12 || 12}${h < 12 ? 'am' : 'pm'}`;
  const fFecha = iso => new Date(iso).toLocaleDateString('es-CO', { timeZone: TZ, day: 'numeric', month: 'short', year: 'numeric' });
  const fFechaHora = iso => new Date(iso).toLocaleString('es-CO', { timeZone: TZ, day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' });
  const ymd = (s, o) => new Date(s + 'T00:00:00Z').toLocaleDateString('es-CO', { timeZone: 'UTC', ...o });
  const corto = t => t.replace(/ de /g, ' ').replace('.', '');                      // "16 de nov" → "16 nov"
  const etqBarra = (k, bucket) => corto(bucket === 'mes' ? ymd(k + '-01', { month: 'short', year: '2-digit' }) : ymd(k, { day: 'numeric', month: 'short' }));
  const etqPeriodo = (g, ini, fin) =>
    g === 'dia' ? ymd(ini, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
    : g === 'semana' ? corto(`${ymd(ini, { day: 'numeric', month: 'short' })} – ${ymd(fin, { day: 'numeric', month: 'short', year: 'numeric' })}`)
    : g === 'mes' ? ymd(ini, { month: 'long', year: 'numeric' }) : ini.slice(0, 4);
  const etqCorta = (g, ini, fin) =>
    g === 'dia' ? corto(ymd(ini, { day: 'numeric', month: 'short' })) : g === 'semana' ? corto(`${ymd(ini, { day: 'numeric', month: 'short' })}–${ymd(fin, { day: 'numeric', month: 'short' })}`)
    : g === 'mes' ? corto(ymd(ini, { month: 'short', year: '2-digit' })) : ini.slice(0, 4);
  const pico = horas => { const m = Math.max(...horas); return m ? { h: horas.indexOf(m), n: m } : null; };
  // Rango de horas que vale la pena dibujar (se recortan las horas sin visitas en los extremos)
  function rangoHoras(...arrs) {
    let ini = 24, fin = -1;
    for (const a of arrs) a.forEach((v, h) => { if (v > 0) { ini = Math.min(ini, h); fin = Math.max(fin, h); } });
    if (fin < 0) return null;
    ini = Math.max(0, ini - 1); fin = Math.min(23, fin + 1);
    while (fin - ini < 5) { if (ini > 0) ini--; if (fin - ini < 5 && fin < 23) fin++; }
    return [ini, fin];
  }
  function seg(sel, attr, fn) {                                    // grupo de botones tipo "pestañas"
    $(sel).addEventListener('click', e => {
      const b = e.target.closest('button'); if (!b) return;
      $(sel).querySelectorAll('button').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
      fn(b.dataset[attr]);
    });
  }

  /* ---------- acceso y llamadas ---------- */
  const vista = abierta => { $('#a-lock').classList.toggle('hidden', abierta); $('#a-main').classList.toggle('hidden', !abierta); };
  function salir() { pinA = ''; sessionStorage.removeItem('pd_admin'); vista(false); }
  async function pedir(ruta) {
    const r = await api(ruta, { pin: pinA });
    if (r.status === 401) { salir(); toast('Ingresa de nuevo la contraseña del dueño'); return null; }
    if (!r.ok) { toast(r.error || 'No se pudo cargar la información'); return null; }
    return r;
  }
  $('#a-unlock').onclick = async () => {
    const p = $('#a-pin').value.trim(); if (!p) return;
    const r = await api('/api/verificar-admin', { method: 'POST', pin: p });
    if (!r.ok) return toast(r.status === 401 ? 'Contraseña del dueño incorrecta' : (r.error || 'No se pudo verificar'));
    pinA = p; sessionStorage.setItem('pd_admin', p); $('#a-pin').value = ''; entrar();
  };
  $('#a-pin').onkeydown = e => { if (e.key === 'Enter') $('#a-unlock').click(); };
  $('#a-salir').onclick = () => { salir(); tab('caja'); };


  /* ---------- Seguridad: contraseña, PIN de caja, código de recuperación y bitácora ---------- */
  const ACCIONES = {
    CAMBIO_CLAVE_ADMIN: 'Cambio de contraseña del dueño', CAMBIO_PIN_CAJA: 'Cambio del PIN de caja',
    CODIGO_RECUPERACION_NUEVO: 'Código de recuperación generado', RECUPERACION_USADA: 'Contraseña restablecida con el código',
    RECUPERACION_FALLIDA: 'Intento fallido con el código de recuperación', RESET_ADMIN_PC: 'Reinicio desde el computador (reset-admin)',
    CREDENCIALES_INICIALES: 'Claves iniciales creadas',
  };
  const msg = (sel, texto, bien = false) => { const e = $(sel); e.textContent = texto || ''; e.className = 'text-sm min-h-[1.25rem] mt-2 ' + (bien ? 'text-green-400' : 'text-fire'); };

  // Copia al portapapeles (con plan B para cuando el navegador no deja usar la API moderna)
  async function copiar(texto) {
    try { await navigator.clipboard.writeText(texto); return true; } catch {}
    try {
      const t = Object.assign(document.createElement('textarea'), { value: texto });
      t.style.cssText = 'position:fixed;opacity:0'; document.body.append(t); t.select();
      const ok = document.execCommand('copy'); t.remove(); return ok;
    } catch { return false; }
  }
  // Ventana del código: se muestra UNA vez, con botón para copiar todo de un toque; no se cierra hasta confirmar que se guardó
  function mostrarCodigo(codigo, alCerrar) {
    const m = $('#cod-modal'), btn = $('#cod-copiar');
    $('#cod-valor').textContent = codigo; $('#cod-ok').checked = false; $('#cod-listo').disabled = true; btn.textContent = 'COPIAR CÓDIGO';
    m.classList.remove('hidden'); m.classList.add('flex');
    btn.onclick = async () => { btn.textContent = (await copiar(codigo)) ? '✔ ¡COPIADO!' : 'No se pudo copiar: toca el código y cópialo a mano'; };
    $('#cod-ok').onchange = e => { $('#cod-listo').disabled = !e.target.checked; };
    $('#cod-listo').onclick = () => {
      $('#cod-valor').textContent = ''; m.classList.add('hidden'); m.classList.remove('flex'); alCerrar?.();
    };
  }

  async function cargarSeguridad() {
    const r = await pedir('/api/admin/seguridad'); if (!r) return;
    $('#as-estado').textContent = [
      r.clave_actualizada ? 'Contraseña cambiada el ' + fFechaHora(r.clave_actualizada) : 'Contraseña sin cambios desde su creación',
      r.pin_caja_actualizado ? 'PIN de caja cambiado el ' + fFechaHora(r.pin_caja_actualizado) : null,
      r.tiene_codigo ? 'Código de recuperación creado el ' + fFechaHora(r.codigo_creado) : '⚠ Aún no tienes código de recuperación',
    ].filter(Boolean).join(' · ');
    $('#as-bit').innerHTML = r.bitacora.length ? r.bitacora.map(b =>
      `<li class="bg-card border border-[#2a2a2a] rounded-xl px-3 py-2 flex flex-wrap justify-between gap-x-4"><span>${esc(ACCIONES[b.accion] || b.accion)}${b.detalle ? ` <span class="text-[#6b6b6b]">(${esc(b.detalle)})</span>` : ''}</span><span class="text-xs text-[#A3A3A3]">${esc(fFechaHora(b.fecha))} · IP ${esc(b.ip)}</span></li>`).join('')
      : '<li class="text-[#A3A3A3]">Todavía no hay eventos.</li>';
    $('#a-aviso').classList.toggle('hidden', r.tiene_codigo);
  }
  async function avisoCodigo() {                      // al entrar: avisa si todavía no hay código de recuperación
    const r = await api('/api/admin/seguridad', { pin: pinA });
    $('#a-aviso').classList.toggle('hidden', !(r.ok && !r.tiene_codigo));
  }
  function verSeguridad(on) {
    $('#a-seg').classList.toggle('hidden', !on); $('#a-home').classList.toggle('hidden', on); $('#a-cli').classList.add('hidden');
    if (on) { ['#sc-actual', '#sc-nueva', '#sc-nueva2', '#sp-actual', '#sp-nuevo', '#sp-nuevo2', '#sk-actual'].forEach(i => { $(i).value = ''; }); ['#sc-msg', '#sp-msg', '#sk-msg'].forEach(i => msg(i, '')); cargarSeguridad(); }
  }
  $('#a-seg-btn').onclick = () => verSeguridad(true);
  $('#a-aviso-ir').onclick = () => verSeguridad(true);
  $('#as-back').onclick = () => { verSeguridad(false); avisoCodigo(); };

  async function enviarSeg(ruta, body, sel) {         // 401 aquí = contraseña actual mal escrita (no cierra la sesión)
    const r = await api(ruta, { method: 'POST', body });
    if (!r.ok) { msg(sel, r.error || 'No se pudo completar'); return null; }
    return r;
  }
  $('#sc-form').onsubmit = async e => {
    e.preventDefault();
    const actual = $('#sc-actual').value, nueva = $('#sc-nueva').value;
    if (!actual) return msg('#sc-msg', 'Escribe tu contraseña actual.');
    if (nueva !== $('#sc-nueva2').value) return msg('#sc-msg', 'Las dos contraseñas nuevas no coinciden.');
    if (!await enviarSeg('/api/admin/cambiar-clave', { actual, nueva }, '#sc-msg')) return;
    pinA = nueva; sessionStorage.setItem('pd_admin', nueva);        // la sesión sigue abierta con la clave nueva
    ['#sc-actual', '#sc-nueva', '#sc-nueva2'].forEach(i => { $(i).value = ''; });
    msg('#sc-msg', '✔ Contraseña cambiada.', true); cargarSeguridad();
  };
  $('#sp-form').onsubmit = async e => {
    e.preventDefault();
    const actual = $('#sp-actual').value, nuevo = $('#sp-nuevo').value.trim();
    if (!actual) return msg('#sp-msg', 'Escribe tu contraseña de dueño.');
    if (nuevo !== $('#sp-nuevo2').value.trim()) return msg('#sp-msg', 'Los dos PIN nuevos no coinciden.');
    if (!await enviarSeg('/api/admin/cambiar-pin-caja', { actual, nuevo }, '#sp-msg')) return;
    ['#sp-actual', '#sp-nuevo', '#sp-nuevo2'].forEach(i => { $(i).value = ''; });
    msg('#sp-msg', '✔ PIN de caja cambiado. Avísale al personal: el anterior ya no sirve.', true); cargarSeguridad();
  };
  $('#sk-form').onsubmit = async e => {
    e.preventDefault();
    const actual = $('#sk-actual').value; if (!actual) return msg('#sk-msg', 'Escribe tu contraseña de dueño.');
    const r = await enviarSeg('/api/admin/generar-codigo', { actual }, '#sk-msg'); if (!r) return;
    $('#sk-actual').value = ''; msg('#sk-msg', '');
    mostrarCodigo(r.codigo, () => { msg('#sk-msg', '✔ Código guardado. El anterior ya no sirve.', true); cargarSeguridad(); });
  };

  /* ---------- «¿Olvidaste tu contraseña?»: restablecer con el código de recuperación ---------- */
  const verRecuperar = on => { $('#a-login').classList.toggle('hidden', on); $('#a-recup').classList.toggle('hidden', !on); $('#r-error').textContent = ''; if (on) $('#r-codigo').focus(); };
  $('#a-olvide').onclick = () => verRecuperar(true);
  $('#r-cancelar').onclick = () => verRecuperar(false);
  $('#a-ver').onchange = e => { $('#a-pin').type = e.target.checked ? 'text' : 'password'; };
  $('#a-recup').onsubmit = async e => {
    e.preventDefault();
    const codigo = $('#r-codigo').value.trim(), nueva = $('#r-nueva').value, err = t => { $('#r-error').textContent = t; };
    if (!codigo) return err('Escribe tu código de recuperación.');
    if (nueva !== $('#r-nueva2').value) return err('Las dos contraseñas nuevas no coinciden.');
    const r = await api('/api/admin/recuperar', { method: 'POST', body: { codigo, nueva } });
    if (!r.ok) return err(r.error || 'No se pudo restablecer');
    pinA = nueva; sessionStorage.setItem('pd_admin', nueva);
    ['#r-codigo', '#r-nueva', '#r-nueva2'].forEach(i => { $(i).value = ''; });
    mostrarCodigo(r.codigo, () => { verRecuperar(false); entrar(); toast('Contraseña restablecida'); });   // el código nuevo se entrega aquí, una sola vez
  };

  /* ---------- gráficas (Chart.js) ---------- */
  const charts = {};
  let listo = false;
  function preparar() {
    if (listo || !window.Chart) return;
    listo = true;
    const D = Chart.defaults;
    D.color = GRIS; D.font.family = 'Inter, sans-serif'; D.borderColor = '#262626'; D.maintainAspectRatio = false;
    D.plugins.legend.labels.boxWidth = 12; D.plugins.legend.labels.boxHeight = 12;
    Object.assign(D.plugins.tooltip, { backgroundColor: '#1A1A1A', borderColor: '#333', borderWidth: 1, padding: 10 });
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) D.animation = false;
  }
  function dibujar(id, cfg, vacio) {                               // vacio = true → muestra el aviso "sin datos"
    const cv = $('#' + id), caja = cv.parentElement, aviso = caja.querySelector('.chart-empty');
    charts[id]?.destroy(); delete charts[id];
    preparar();
    if (!vacio && !window.Chart) { vacio = true; aviso.textContent = 'No se pudieron cargar las gráficas. Revisa tu conexión.'; }
    caja.classList.toggle('is-empty', !!vacio);
    if (!vacio) charts[id] = new Chart(cv, cfg);
  }
  const ejes = (y = {}) => ({ x: { grid: { display: false }, ticks: { maxRotation: 0, autoSkip: true } }, y: { beginAtZero: true, ticks: { precision: 0 }, ...y } });
  const barras = (labels, datasets, { y, legend = true } = {}) => ({
    type: 'bar',
    data: { labels, datasets: datasets.map(d => ({ borderRadius: 4, maxBarThickness: 38, ...d })) },
    options: { scales: ejes(y), plugins: { legend: { display: legend, position: 'bottom' } } },
  });
  const torta = (labels, data, colores) => ({
    type: 'doughnut',
    data: { labels, datasets: [{ data, backgroundColor: colores, borderColor: '#121212', borderWidth: 2 }] },
    options: { cutout: '55%', plugins: { legend: { position: 'bottom' }, tooltip: { callbacks: { label: c => {
      const t = c.dataset.data.reduce((a, b) => a + b, 0); return ` ${c.label}: ${c.parsed} (${t ? Math.round(c.parsed / t * 100) : 0}%)`; } } } } },
  });
  const ETQ_ESTRELLAS = [1, 2, 3, 4, 5].map(n => n + ' ★');
  const sumaDe = a => a.reduce((x, y) => x + y, 0);
  const tortaEstrellas = id => (dist, n) => dibujar(id, torta(ETQ_ESTRELLAS, dist, ESTRELLAS), !n);

  /* ---------- Resumen ---------- */
  async function cargarResumen() {
    const t = ++tokR;
    const r = await pedir('/api/admin/dashboard?rango=' + rango);
    if (!r || t !== tokR) return;
    const { periodo: p, hoy: h, calif: c } = r;
    $('#k-total').textContent = r.total_clientes;
    $('#k-total-s').textContent = p.registros ? `+${p.registros} en el periodo` : 'ninguno nuevo en el periodo';
    $('#k-hoy').textContent = h.visitas;
    $('#k-hoy-s').textContent = plural(h.unicos, 'cliente distinto', 'clientes distintos');
    $('#k-vis').textContent = p.visitas;
    $('#k-vis-s').textContent = plural(p.unicos, 'cliente distinto', 'clientes distintos');
    $('#k-canj').textContent = p.canjes;
    $('#k-cal').innerHTML = c.general == null ? '–' : `${num(c.general)}<em>★</em>`;
    $('#k-cal-s').textContent = c.n ? plural(c.n, 'calificación', 'calificaciones') : 'sin calificaciones';
    $('#c-resp').textContent = c.tasa_respuesta == null ? 'De 1 a 5 estrellas' : `De 1 a 5 · ${Math.round(c.tasa_respuesta * 100)}% de las visitas fue calificada`;

    // Clientes nuevos y clientes que vinieron, por día (o por mes en periodos largos)
    const s = r.serie;
    dibujar('ch-serie', barras(s.map(x => etqBarra(x.k, r.rango.bucket)), [
      { label: 'Clientes nuevos', data: s.map(x => x.registros), backgroundColor: EMBER },
      { label: 'Clientes que vinieron', data: s.map(x => x.unicos), backgroundColor: FIRE },
    ]), !s.some(x => x.registros || x.unicos));

    dibujar('ch-activos', torta(['Con visita', 'Sin visita'], [r.activos.con_visita, r.activos.sin_visita], [FIRE, '#3a3a3a']), !r.total_clientes);

    // Horas pico
    const hr = rangoHoras(r.horas), pk = pico(r.horas);
    $('#h-pico').textContent = pk ? `Hora más llena: ${hora12(pk.h)} (${plural(pk.n, 'visita', 'visitas')})` : 'Visitas por hora del día';
    if (hr) {
      const hs = Array.from({ length: hr[1] - hr[0] + 1 }, (_, i) => hr[0] + i);
      dibujar('ch-horas', barras(hs.map(hora12), [{ label: 'Visitas', data: hs.map(x => r.horas[x]), backgroundColor: hs.map(x => (x === pk.h ? FIRE : 'rgba(230,46,45,.35)')) }], { legend: false }));
    } else dibujar('ch-horas', {}, true);

    // Calificaciones: general (torta) y por aspecto (barras + promedios)
    tortaEstrellas('ch-cal-pie')(c.dist.general, c.n);
    $('#c-medias').innerHTML = CAMPOS.map(([k, nombre, col]) =>
      `<div class="avg" style="--w:${(c[k] || 0) / 5 * 100}%;--c:${col}"><span>${nombre}</span><b>${num(c[k])}</b><i></i></div>`).join('');
    dibujar('ch-cal-bar', barras(ETQ_ESTRELLAS, CAMPOS.map(([k, nombre, col]) => ({ label: nombre, data: c.dist[k], backgroundColor: col }))), !c.n);
  }

  /* ---------- Lista de clientes y lupa ---------- */
  const filaCliente = c => `<button type="button" class="crow" data-id="${esc(c.id)}">
      <span class="nm">${esc(c.nombre)}<small>${esc(c.id)}</small></span>
      <span class="rt${c.general == null ? ' none' : ''}">${c.general == null ? 'Sin calificar' : num(c.general) + ' ★'}${c.n ? `<small>(${c.n})</small>` : ''}</span></button>`;
  async function cargarLista() {
    const t = ++tokL;
    const r = await pedir('/api/admin/clientes');
    if (!r || t !== tokL) return;
    $('#l-total').textContent = plural(r.total, 'cliente', 'clientes');
    $('#l-lista').innerHTML = r.clientes.length ? r.clientes.map(filaCliente).join('') : '<p class="vacio">Aún no hay clientes registrados.</p>';
    const nota = $('#l-nota');
    nota.classList.toggle('hidden', r.total <= r.clientes.length);
    nota.textContent = `Mostrando ${r.clientes.length} de ${r.total}. Usa la lupa para buscar a alguien en particular.`;
  }
  $('#l-lista').onclick = e => { const id = e.target.closest('.crow')?.dataset.id; if (id) abrirCliente(id); };

  const q = $('#a-q'), sug = $('#a-sug');
  function lupa(abrir) {
    const caja = $('#a-searchbox');
    abrir = abrir ?? !caja.classList.contains('open');
    caja.classList.toggle('open', abrir); q.tabIndex = abrir ? 0 : -1;
    $('#a-lupa').setAttribute('aria-expanded', String(abrir));
    if (abrir) setTimeout(() => q.focus(), 60); else { q.value = ''; sug.classList.add('hidden'); sug.innerHTML = ''; }
  }
  $('#a-lupa').onclick = () => lupa();
  q.onkeydown = e => {
    if (e.key === 'Escape') { lupa(false); $('#a-lupa').focus(); }
    if (e.key === 'Enter') sug.querySelector('.crow')?.click();
  };
  q.oninput = () => {
    clearTimeout(q.t);
    const v = q.value.trim();
    if (v.length < 2) { sug.classList.add('hidden'); return; }
    q.t = setTimeout(async () => {
      const t = ++tokB;
      const r = await pedir('/api/admin/clientes?q=' + encodeURIComponent(v));
      if (!r || t !== tokB || q.value.trim() !== v) return;
      sug.innerHTML = r.clientes.length ? r.clientes.map(filaCliente).join('') : '<p class="vacio">No se encontró a nadie con ese dato.</p>';
      sug.classList.remove('hidden');
    }, 250);
  };
  sug.onclick = e => { const id = e.target.closest('.crow')?.dataset.id; if (id) abrirCliente(id); };

  /* ---------- Ficha de un cliente ---------- */
  async function abrirCliente(id) {
    const r = await pedir('/api/admin/cliente/' + encodeURIComponent(id));
    if (!r) return;
    const c = r.cliente, k = r.calif;
    lupa(false);
    $('#a-home').classList.add('hidden'); $('#a-seg').classList.add('hidden'); $('#a-cli').classList.remove('hidden');
    $('#ac-name').textContent = c.nombre;
    $('#ac-meta').textContent = `${c.id} · ${c.whatsapp} · ${c.correo} · miembro desde ${fFecha(c.fecha_registro)}`;
    $('#ac-vis').textContent = c.visitas_totales;
    $('#ac-vis-s').textContent = c.visitas_totales ? `Primera: ${fFecha(c.primera_visita)}${c.ultima_visita ? ' · Última: ' + fFecha(c.ultima_visita) : ''}` : 'Aún no ha venido';
    const canjes = Math.max(c.canjes || 0, r.canjes.length);
    $('#ac-can').textContent = canjes;
    $('#ac-can-s').textContent = r.canjes.length ? `Último: ${fFecha(r.canjes[0])}` : 'Aún no ha canjeado';
    $('#ac-tar').innerHTML = `${c.puntos}<em>/ ${GOAL}</em>`;
    $('#ac-cal').innerHTML = k.general == null ? '–' : `${num(k.general)}<em>★</em>`;
    $('#ac-cal-s').textContent = (k.n ? plural(k.n, 'calificación', 'calificaciones') : 'sin calificaciones') + (k.sin_calificar ? ` · ${k.sin_calificar} sin calificar` : '');
    $('#ac-canjes').innerHTML = r.canjes.length
      ? r.canjes.map(f => `<li class="flex items-baseline justify-between gap-3"><span>Cortesía canjeada</span><span class="text-[#A3A3A3] text-right">${fFechaHora(f)}</span></li>`).join('')
      : '<li class="text-[#6b6b6b]">Aún no ha canjeado ninguna cortesía.</li>';

    tortaEstrellas('ac-pie')(k.dist.general, k.n);
    dibujar('ac-bar', barras(CAMPOS.map(([key, nombre]) => `${nombre} · ${num(k[key])}`),
      [{ label: 'Promedio', data: CAMPOS.map(([key]) => k[key] ?? 0), backgroundColor: CAMPOS.map(x => x[2]) }],
      { legend: false, y: { max: 5, ticks: { stepSize: 1, precision: 0 } } }), !k.n);

    // Comentarios: la sección arranca cerrada y solo se muestran si el dueño la abre
    $('#ac-com').open = false;
    const n = k.comentarios.length;
    $('#ac-com-t').textContent = n ? `Comentarios (${n})` : 'Sin comentarios';
    $('#ac-com-l').innerHTML = k.comentarios.map(m => `<li><small>${fFechaHora(m.fecha)} · ${num(m.general)} ★ (servicio ${m.servicio} · comida ${m.comida} · lugar ${m.lugar})</small><p>${esc(m.comentario)}</p></li>`).join('');
    window.scrollTo({ top: 0 });
  }
  $('#ac-back').onclick = () => {
    $('#a-cli').classList.add('hidden'); $('#a-home').classList.remove('hidden');
    Object.values(charts).forEach(c => c.resize());
  };

  /* ---------- Comparar ---------- */
  function porDefecto(g) {                                         // A = periodo actual, B = el inmediatamente anterior
    const hoy = hoyBogota(), d = new Date(hoy + 'T00:00:00Z');
    if (g === 'dia') d.setUTCDate(d.getUTCDate() - 1);
    else if (g === 'semana') d.setUTCDate(d.getUTCDate() - 7);
    else if (g === 'mes') { d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() - 1); }
    else d.setUTCFullYear(d.getUTCFullYear() - 1);
    return { a: hoy, b: d.toISOString().slice(0, 10) };
  }
  function cambio(a, b, tipo) {                                    // → [texto, clase]
    if (tipo === 'h' || a == null || b == null) return ['', 'eq'];
    if (tipo === 'r') { const d = Math.round((a - b) * 10) / 10; return d === 0 ? ['=', 'eq'] : d > 0 ? ['▲ +' + num(d), 'up'] : ['▼ ' + num(d), 'down']; }
    if (b === 0) return a === 0 ? ['=', 'eq'] : ['nuevo', 'up'];
    const p = Math.round((a - b) / b * 100);
    return p === 0 ? ['=', 'eq'] : p > 0 ? [`▲ +${p}%`, 'up'] : [`▼ ${p}%`, 'down'];
  }
  async function cargarComparar() {
    const a = $('#a-fa').value, b = $('#a-fb').value;
    if (!a || !b) return;
    const t = ++tokC;
    const r = await pedir(`/api/admin/comparar?g=${gran}&a=${a}&b=${b}`);
    if (!r || t !== tokC) return;
    const A = r.a, B = r.b;
    $('#a-ta').textContent = etqPeriodo(gran, A.ini, A.fin) + (A.en_curso ? ' (en curso)' : '');
    $('#a-tb').textContent = etqPeriodo(gran, B.ini, B.fin) + (B.en_curso ? ' (en curso)' : '');

    const horaTxt = e => { const p = pico(e.horas); return p ? `${hora12(p.h)} (${p.n})` : '–'; };
    const filas = [
      ['Clientes nuevos', e => e.registros, 'n'], ['Visitas', e => e.visitas, 'n'], ['Clientes distintos', e => e.unicos, 'n'],
      ['Premios canjeados', e => e.canjes, 'n'], ['Calificación general', e => e.calif.general, 'r'],
      ['Servicio', e => e.calif.servicio, 'r'], ['Comida', e => e.calif.comida, 'r'], ['Lugar', e => e.calif.lugar, 'r'],
      ['Hora más llena', horaTxt, 'h'],
    ];
    $('#a-tabla').innerHTML = filas.map(([nombre, f, tipo]) => {
      const va = f(A), vb = f(B), [txt, cls] = cambio(va, vb, tipo);
      const ver = v => (tipo === 'r' ? (v == null ? '–' : num(v) + ' ★') : v);
      return `<tr><td>${nombre}</td><td>${ver(va)}</td><td>${ver(vb)}</td><td class="dl ${cls}">${txt}</td></tr>`;
    }).join('');

    const nA = 'A · ' + etqCorta(gran, A.ini, A.fin), nB = 'B · ' + etqCorta(gran, B.ini, B.fin);
    const dos = (fa, fb, col = [FIRE, EMBER]) => [{ label: nA, data: fa, backgroundColor: col[0] }, { label: nB, data: fb, backgroundColor: col[1] }];
    const act = e => [e.registros, e.visitas, e.unicos, e.canjes];
    dibujar('ch-cmp-act', barras(['Nuevos', 'Visitas', 'Distintos', 'Canjes'], dos(act(A), act(B))), !sumaDe(act(A)) && !sumaDe(act(B)));
    const cal = e => ['general', 'servicio', 'comida', 'lugar'].map(k => e.calif[k] ?? 0);
    dibujar('ch-cmp-cal', barras(['General', 'Servicio', 'Comida', 'Lugar'], dos(cal(A), cal(B)), { y: { max: 5, ticks: { stepSize: 1, precision: 0 } } }), !A.calif.n && !B.calif.n);
    const hr = rangoHoras(A.horas, B.horas);
    if (hr) {
      const hs = Array.from({ length: hr[1] - hr[0] + 1 }, (_, i) => hr[0] + i);
      dibujar('ch-cmp-hor', barras(hs.map(hora12), dos(hs.map(x => A.horas[x]), hs.map(x => B.horas[x]))));
    } else dibujar('ch-cmp-hor', {}, true);
  }
  function fijarGran(g) {
    gran = g; comparado = true;
    $('#a-gran').querySelectorAll('button').forEach(x => x.setAttribute('aria-pressed', String(x.dataset.gran === g)));
    const d = porDefecto(g); $('#a-fa').value = d.a; $('#a-fb').value = d.b;
    cargarComparar();
  }
  seg('#a-gran', 'gran', fijarGran);
  $('#a-fa').onchange = $('#a-fb').onchange = cargarComparar;

  /* ---------- Modos y arranque ---------- */
  function setModo(m) {
    modo = m;
    $('#a-resumen').classList.toggle('hidden', m !== 'resumen');
    $('#a-comparar').classList.toggle('hidden', m !== 'comparar');
    $('#a-rangos').classList.toggle('hidden', m !== 'resumen');
    if (m === 'resumen') { cargarResumen(); cargarLista(); }
    else if (!comparado) fijarGran(gran); else cargarComparar();
  }
  seg('#a-modos', 'modo', setModo);
  seg('#a-rangos', 'rango', r => { rango = r; cargarResumen(); });

  function entrar() {
    if (!pinA) { vista(false); $('#a-pin').focus(); return; }
    vista(true);
    $('#a-cli').classList.add('hidden'); $('#a-seg').classList.add('hidden'); $('#a-home').classList.remove('hidden');
    setModo(modo);
    avisoCodigo();
  }

  /* ---------- Excel (dueño): ahora vive dentro del panel ---------- */
  // Por defecto el Excel sale con los datos de contacto ocultos; «Excel completo» los incluye (queda anotado en la bitácora)
  async function bajarExcel(completo) {
    if (completo && !confirm('Este Excel incluye WhatsApp, correo y fecha de nacimiento completos de tus clientes. Guárdalo en un lugar seguro y no lo envíes por chat. ¿Descargar?')) return;
    try {
      const r = await fetch(API + '/api/descargar-excel' + (completo ? '?completo=1' : ''), { headers: { 'x-pin': encodeURIComponent(pinA) } });
      if (r.status === 401) { salir(); return toast('Ingresa de nuevo la contraseña del dueño'); }
      if (r.status === 429) return toast('Demasiadas descargas. Intenta más tarde.');
      if (!r.ok) return toast('No se pudo descargar');
      const url = URL.createObjectURL(await r.blob());
      const a = Object.assign(document.createElement('a'), { href: url, download: completo ? 'clientes_putadelicia_COMPLETO.xlsx' : 'clientes_putadelicia.xlsx' });
      document.body.append(a); a.click(); a.remove(); URL.revokeObjectURL(url);
    } catch { toast('No hay conexión con el servidor.'); }
  }
  $('#a-excel').onclick = () => bajarExcel(false);
  $('#a-excel-full').onclick = () => bajarExcel(true);

  return { enter: entrar };
})();
