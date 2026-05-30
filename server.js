/* ============================================================
   CobraPro · Backend (Express + JWT + almacén JSON)
   Sistema NUEVO e independiente. No tiene relación con CelExpress.
   Arranque local:  npm install && node server.js
   Sirve el front desde ./public y expone la API en /api/*
   ============================================================ */
const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 5000;
const JWT_SECRET = process.env.JWT_SECRET || 'cobrapro_dev_secret_cambiame';
const DB_FILE = path.join(__dirname, 'db.json');

app.use(cors({ origin: true, credentials: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

/* ---------- Almacén: PostgreSQL si hay DATABASE_URL (Render), si no archivo JSON (local) ---------- */
const USE_PG = !!process.env.DATABASE_URL;
let pool = null;
if (USE_PG) { const { Pool } = require('pg'); pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { require: true, rejectUnauthorized: false } }); }

async function loadDB() {
  if (USE_PG) {
    await pool.query('CREATE TABLE IF NOT EXISTS cobrapro_state (id INT PRIMARY KEY, data JSONB)');
    const r = await pool.query('SELECT data FROM cobrapro_state WHERE id = 1');
    return r.rows[0] ? r.rows[0].data : null;
  }
  try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch { return null; }
}
function saveDB() {
  if (USE_PG) {
    pool.query('INSERT INTO cobrapro_state (id, data) VALUES (1, $1) ON CONFLICT (id) DO UPDATE SET data = $1', [db])
      .catch(e => console.error('❌ Error al guardar en Postgres:', e.message));
  } else {
    fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
  }
}
function nextId(coll) { return (db[coll] || []).reduce((m, x) => Math.max(m, x.id), 0) + 1; }

/* ---------- Motor de cálculo real (factores Credia) ---------- */
const PROD = {
  diario:  [{ p: 10, f: 1.17, fijo: 30 }, { p: 20, f: 1.23, fijo: 60 }, { p: 30, f: 1.33, fijo: 90 }],
  semanal: [{ p: 4, f: 1.35, fijo: 60 }, { p: 8, f: 1.43, fijo: 120 }, { p: 12, f: 1.53, fijo: 180 }, { p: 16, f: 1.63, fijo: 240 }, { p: 20, f: 1.83, fijo: 300 }],
  p17:     [{ p: 17, f: 1.73, fijo: 270 }],
};
function calcCredito(tipo, plazo, monto, dias) {
  if (tipo === 'unico') { const tap = monto + (dias || 15) * (2 + monto * 0.0183); return { total: tap, pagos: 1, cuota: tap }; }
  const arr = PROD[tipo] || PROD.semanal; const it = arr.find(x => x.p === plazo) || arr[0];
  const total = monto * it.f + it.fijo; return { total, pagos: it.p, cuota: total / it.p };
}
function genPassword() { const c = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; let p = ''; for (let i = 0; i < 8; i++) p += c[Math.floor(Math.random() * c.length)]; return p; }
function saldoDe(saleId) { return db.movimientos.filter(m => m.saleId === saleId).reduce((s, m) => s + (m.cargo || 0) - (m.abono || 0), 0); }

/* ---------- Semilla inicial ---------- */
function seed() {
  db = { users: [], sucursales: [], clients: [], sales: [], movimientos: [], caja: {}, porEntregar: [], _idem: {} };
  db.sucursales = ['Amecameca', 'Chalco', 'Ozumba', 'Tláhuac', 'Tepetlixpa', 'Juchitepec'].map((n, i) => ({ id: i + 1, nombre: n }));
  db.users = [
    { id: 1, nombre: 'Administrador', usuario: 'admin', rol: 'admin', sucursalId: null, passwordHash: bcrypt.hashSync('admin123', 8), activo: true, createdAt: new Date().toISOString() },
  ];
  // 2 clientes demo con su crédito
  const c1 = calcCredito('semanal', 12, 6000);
  const c2 = calcCredito('diario', 20, 3000);
  db.clients = [
    { id: 1, nombre: 'María González', tel: '5544120098', calle: 'Calle Hidalgo 24', col: 'Centro', sucursalId: 1, prom: 'Ana Reyes' },
    { id: 2, nombre: 'Pedro Jiménez', tel: '5544120134', calle: 'Av. Juárez 110', col: 'San Miguel', sucursalId: 1, prom: 'Ana Reyes' },
  ];
  db.sales = [
    { id: 1, folio: 'F-1042', clientId: 1, tipo: 'semanal', plazo: 12, monto: 6000, cuota: c1.cuota, total: c1.total, prom: 'Ana Reyes', sucursalId: 1, createdAt: new Date().toISOString() },
    { id: 2, folio: 'F-1043', clientId: 2, tipo: 'diario', plazo: 20, monto: 3000, cuota: c2.cuota, total: c2.total, prom: 'Ana Reyes', sucursalId: 1, createdAt: new Date().toISOString() },
  ];
  db.movimientos = [
    { id: 1, saleId: 1, fecha: '05/03/2026', concepto: 'Disposición de crédito', origen: 'Sucursal Amecameca', cargo: c1.total, abono: 0 },
    { id: 2, saleId: 1, fecha: '12/03/2026', concepto: 'Abono semana 1', origen: 'Ruta · A. Reyes', cargo: 0, abono: c1.cuota, forma: 'efectivo' },
    { id: 3, saleId: 2, fecha: '06/03/2026', concepto: 'Disposición de crédito', origen: 'Sucursal Amecameca', cargo: c2.total, abono: 0 },
  ];
  db.caja = { '1': { inicial: 2000, efectivo: 0, banco: 0, entregas: 0 } };
  db.porEntregar = [{ id: 1, sucursalId: 1, prom: 'Ana Reyes', monto: 8400 }];
  saveDB();
}
let db = null;

/* ---------- Auth ---------- */
function auth(req, res, next) {
  const t = (req.headers.authorization || '').replace('Bearer ', '');
  try { req.user = jwt.verify(t, JWT_SECRET); next(); }
  catch { res.status(401).json({ error: 'No autorizado' }); }
}
function rol(...roles) { return (req, res, next) => roles.includes(req.user.rol) ? next() : res.status(403).json({ error: 'Permiso insuficiente' }); }
function idem(req, res, next) {
  const k = req.body && req.body.idempotencyKey;
  if (k && db._idem[k]) return res.json({ ok: true, duplicado: true });
  req._idemKey = k; next();
}
function markIdem(req) { if (req._idemKey) { db._idem[req._idemKey] = true; } }

app.post('/api/auth/login', (req, res) => {
  const { usuario, password } = req.body;
  const u = db.users.find(x => x.usuario === (usuario || '').toLowerCase().trim() && x.activo);
  if (!u || !bcrypt.compareSync(password || '', u.passwordHash)) return res.status(401).json({ error: 'Usuario o contraseña inválidos' });
  const token = jwt.sign({ id: u.id, rol: u.rol, nombre: u.nombre, sucursalId: u.sucursalId }, JWT_SECRET, { expiresIn: '12h' });
  res.json({ token, user: { id: u.id, nombre: u.nombre, rol: u.rol, sucursalId: u.sucursalId, usuario: u.usuario } });
});
app.get('/api/auth/me', auth, (req, res) => res.json(req.user));

/* ---------- Usuarios (panel de alta de usuarios y contraseñas) ---------- */
app.get('/api/users', auth, rol('admin', 'supervisor'), (req, res) => {
  res.json(db.users.map(u => ({ id: u.id, nombre: u.nombre, usuario: u.usuario, rol: u.rol, sucursalId: u.sucursalId, activo: u.activo, createdAt: u.createdAt })));
});
app.post('/api/users', auth, rol('admin'), (req, res) => {
  const { nombre, usuario, rol: r, sucursalId, password } = req.body;
  if (!nombre || !usuario || !r) return res.status(400).json({ error: 'nombre, usuario y rol son obligatorios' });
  const uname = usuario.toLowerCase().trim();
  if (db.users.some(u => u.usuario === uname)) return res.status(409).json({ error: 'Ese usuario ya existe' });
  const plain = (password && password.length >= 4) ? password : genPassword();
  const u = { id: nextId('users'), nombre, usuario: uname, rol: r, sucursalId: sucursalId || null, passwordHash: bcrypt.hashSync(plain, 8), activo: true, createdAt: new Date().toISOString() };
  db.users.push(u); saveDB();
  res.status(201).json({ id: u.id, nombre: u.nombre, usuario: u.usuario, rol: u.rol, sucursalId: u.sucursalId, passwordGenerada: plain });
});
app.patch('/api/users/:id', auth, rol('admin'), (req, res) => {
  const u = db.users.find(x => x.id == req.params.id);
  if (!u) return res.status(404).json({ error: 'Usuario no encontrado' });
  if (typeof req.body.activo === 'boolean') u.activo = req.body.activo;
  let nueva = null;
  if (req.body.resetPassword) { nueva = genPassword(); u.passwordHash = bcrypt.hashSync(nueva, 8); }
  saveDB();
  res.json({ ok: true, passwordGenerada: nueva });
});

/* ---------- Catálogos ---------- */
app.get('/api/sucursales', auth, (req, res) => res.json(db.sucursales));

/* ---------- Clientes / cartera ---------- */
app.get('/api/clients', auth, (req, res) => {
  const q = (req.query.search || '').toLowerCase();
  const out = db.clients.filter(c => !q || [c.nombre, c.tel, c.calle, c.col, c.prom].join(' ').toLowerCase().includes(q))
    .map(c => ({ ...c, creditos: db.sales.filter(s => s.clientId === c.id).map(s => ({ ...s, saldo: saldoDe(s.id) })) }));
  res.json(out);
});
app.get('/api/sales', auth, (req, res) => {
  res.json(db.sales.map(s => ({ ...s, saldo: saldoDe(s.id), cliente: (db.clients.find(c => c.id === s.clientId) || {}).nombre })));
});
app.post('/api/sales', auth, rol('admin', 'supervisor', 'sucursal'), (req, res) => {
  const { nombre, tel, calle, col, sucursalId, prom, tipo, plazo, monto, dias } = req.body;
  if (!nombre || !calle || !col) return res.status(400).json({ error: 'Domicilio (calle y colonia) obligatorio en la venta' });
  const r = calcCredito(tipo, +plazo, +monto, +dias);
  const client = { id: nextId('clients'), nombre, tel: tel || '', calle, col, sucursalId: sucursalId || req.user.sucursalId || 1, prom: prom || '' };
  db.clients.push(client);
  const folio = 'F-' + (1100 + nextId('sales'));
  const sale = { id: nextId('sales'), folio, clientId: client.id, tipo, plazo: +plazo, monto: +monto, cuota: r.cuota, total: r.total, prom: client.prom, sucursalId: client.sucursalId, createdAt: new Date().toISOString() };
  db.sales.push(sale);
  db.movimientos.push({ id: nextId('movimientos'), saleId: sale.id, fecha: new Date().toLocaleDateString('es-MX'), concepto: 'Disposición de crédito', origen: 'Sucursal', cargo: r.total, abono: 0 });
  saveDB();
  res.status(201).json({ ...sale, saldo: saldoDe(sale.id) });
});

/* ---------- Estado de cuenta (libro de cargos y abonos) ---------- */
app.get('/api/sales/:id/movimientos', auth, (req, res) => {
  const id = +req.params.id;
  let saldo = 0;
  const rows = db.movimientos.filter(m => m.saleId === id).map(m => { saldo += (m.cargo || 0) - (m.abono || 0); return { ...m, saldo }; });
  res.json({ movimientos: rows, saldo });
});

/* ---------- Pago (idempotente, con forma de pago) ---------- */
app.post('/api/sales/:id/pago', auth, idem, (req, res) => {
  const id = +req.params.id; const { monto, forma } = req.body;
  if (!(monto > 0)) return res.status(400).json({ error: 'Monto inválido' });
  const sale = db.sales.find(s => s.id === id); if (!sale) return res.status(404).json({ error: 'Crédito no encontrado' });
  db.movimientos.push({ id: nextId('movimientos'), saleId: id, fecha: new Date().toLocaleDateString('es-MX'), concepto: 'Abono', origen: req.user.nombre, cargo: 0, abono: +monto, forma: forma || 'efectivo' });
  markIdem(req); saveDB();
  res.status(201).json({ ok: true, saldo: saldoDe(id) });
});

/* ---------- Supervisor: cargo / abono / condonación ---------- */
app.post('/api/sales/:id/cargo', auth, rol('admin', 'supervisor'), idem, (req, res) => {
  const id = +req.params.id; const { monto, concepto } = req.body;
  db.movimientos.push({ id: nextId('movimientos'), saleId: id, fecha: new Date().toLocaleDateString('es-MX'), concepto: concepto || 'Cargo manual', origen: 'Supervisor: ' + req.user.nombre, cargo: +monto, abono: 0 });
  markIdem(req); saveDB(); res.json({ ok: true, saldo: saldoDe(id) });
});
app.post('/api/sales/:id/abono', auth, rol('admin', 'supervisor'), idem, (req, res) => {
  const id = +req.params.id;
  db.movimientos.push({ id: nextId('movimientos'), saleId: id, fecha: new Date().toLocaleDateString('es-MX'), concepto: 'Abono manual', origen: 'Supervisor: ' + req.user.nombre, cargo: 0, abono: +req.body.monto });
  markIdem(req); saveDB(); res.json({ ok: true, saldo: saldoDe(id) });
});
app.post('/api/sales/:id/condonar', auth, rol('admin', 'supervisor'), idem, (req, res) => {
  const id = +req.params.id;
  db.movimientos.push({ id: nextId('movimientos'), saleId: id, fecha: new Date().toLocaleDateString('es-MX'), concepto: 'Condonación: ' + (req.body.motivo || 'ajuste'), origen: 'Supervisor: ' + req.user.nombre, cargo: 0, abono: +req.body.monto });
  markIdem(req); saveDB(); res.json({ ok: true, saldo: saldoDe(id) });
});
app.post('/api/sales/:id/aplicar-mora', auth, (req, res) => {
  const id = +req.params.id; const monto = +req.body.monto || 25;
  db.movimientos.push({ id: nextId('movimientos'), saleId: id, fecha: new Date().toLocaleDateString('es-MX'), concepto: 'Moratorio automático', origen: 'Sistema', cargo: monto, abono: 0, auto: true });
  saveDB(); res.json({ ok: true, saldo: saldoDe(id) });
});

/* ---------- Caja de sucursal ---------- */
app.get('/api/caja/hoy', auth, (req, res) => {
  const sid = String(req.user.sucursalId || req.query.sucursalId || 1);
  const c = db.caja[sid] || { inicial: 0, efectivo: 0, banco: 0, entregas: 0 };
  const pe = db.porEntregar.filter(p => String(p.sucursalId) === sid);
  res.json({ caja: c, efectivoReal: c.inicial + c.efectivo + c.entregas, porEntregar: pe });
});
app.post('/api/caja/entrega', auth, (req, res) => {
  const pe = db.porEntregar.find(p => p.id == req.body.porEntregarId);
  if (!pe) return res.status(404).json({ error: 'No encontrado' });
  const sid = String(pe.sucursalId); db.caja[sid] = db.caja[sid] || { inicial: 0, efectivo: 0, banco: 0, entregas: 0 };
  db.caja[sid].entregas += pe.monto;
  db.porEntregar = db.porEntregar.filter(p => p.id !== pe.id);
  saveDB(); res.json({ ok: true });
});

/* ---------- Dashboard / reportes ---------- */
app.get('/api/dashboard', auth, (req, res) => {
  const cartera = db.sales.reduce((s, x) => s + saldoDe(x.id), 0);
  const abonos = db.movimientos.filter(m => m.abono > 0).reduce((s, m) => s + m.abono, 0);
  res.json({ creditosActivos: db.sales.length, cartera, cobradoTotal: abonos, sucursales: db.sucursales.length, usuarios: db.users.length });
});
app.get('/api/reports/pagos', auth, rol('admin', 'supervisor'), (req, res) => {
  res.json(db.movimientos.filter(m => m.abono > 0).map(m => {
    const s = db.sales.find(x => x.id === m.saleId) || {}; const c = db.clients.find(x => x.id === s.clientId) || {};
    return { fecha: m.fecha, cliente: c.nombre, folio: s.folio, por: m.origen, forma: m.forma || 'efectivo', monto: m.abono };
  }));
});

app.get('/api/health', (req, res) => res.json({ ok: true, ts: Date.now() }));

/* ---------- Arranque ---------- */
(async () => {
  db = await loadDB();
  if (!db) { seed(); console.log('🌱 Base sembrada (admin / admin123).'); }
  app.listen(PORT, () => console.log('🚀 CobraPro backend en puerto ' + PORT + (USE_PG ? ' (PostgreSQL)' : ' (archivo local)') + '  ·  login admin / admin123'));
})().catch(e => { console.error('❌ Error fatal al iniciar:', e); process.exit(1); });
