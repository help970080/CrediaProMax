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
app.use(express.json({ limit: '12mb' }));
const PUBLIC_DIR = path.join(__dirname, 'public');
app.use(express.static(PUBLIC_DIR, {
  setHeaders: (res, path) => {
    if (path.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    }
  }
}));

/* ---------- Almacén multitenant: una FILA por agencia (id=0 = registro del sistema) ----------
   - PostgreSQL si hay DATABASE_URL (Render); si no, archivo JSON local.
   - Cada tenant tiene su propio blob completo (users, clients, sales, ...).
   - id=0 guarda el "sistema": lista de agencias, superadmins e índice usuario→agencia.
   - El acceso por petición se aísla con AsyncLocalStorage; `db` apunta al blob de la agencia
     del request en curso, así el resto del código (db.users, db.sales, ...) no cambia. */
const { AsyncLocalStorage } = require('async_hooks');
const als = new AsyncLocalStorage();
const USE_PG = !!process.env.DATABASE_URL;
let pool = null;
if (USE_PG) { const { Pool } = require('pg'); pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { require: true, rejectUnauthorized: false } }); }

let SYS = null;                 // registro del sistema (fila id=0)
const tenantCache = {};         // {tid: blob} en memoria

async function loadRow(id) {
  if (USE_PG) {
    await pool.query('CREATE TABLE IF NOT EXISTS cobrapro_state (id INT PRIMARY KEY, data JSONB)');
    const r = await pool.query('SELECT data FROM cobrapro_state WHERE id = $1', [id]);
    return r.rows[0] ? r.rows[0].data : null;
  }
  try { const all = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); return all[id] != null ? all[id] : null; } catch { return null; }
}
function saveRow(id, data) {
  if (USE_PG) {
    pool.query('INSERT INTO cobrapro_state (id, data) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET data = $2', [id, data])
      .catch(e => console.error('❌ Error al guardar fila ' + id + ':', e.message));
  } else {
    let all = {}; try { all = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch {}
    all[id] = data; fs.writeFileSync(DB_FILE, JSON.stringify(all, null, 2));
  }
}
const loadSystem = () => loadRow(0);
const saveSystem = () => saveRow(0, SYS);

// blob en blanco para una agencia nueva (con su admin inicial y branding)
function blankTenant(brandNombre, adminUser, adminPass, adminNombre) {
  return {
    users: [{ id: 1, nombre: adminNombre || 'Administrador', usuario: (adminUser || 'admin').toLowerCase(), rol: 'admin', sucursalId: null, passwordHash: bcrypt.hashSync(adminPass || 'admin123', 8), activo: true, createdAt: new Date().toISOString() }],
    sucursales: [], clients: [], sales: [], movimientos: [], caja: {}, porEntregar: [],
    gestiones: [], cortes: [], transferencias: [], recolecciones: [], jcEntregas: [], jcCierres: [], asignaciones: [], contactos: [],
    objetivos: { suc: {}, cob: {} },
    config: { corteAutoHora: '19:00', corteAutoDias: [1, 2, 3, 4, 5, 6], semanaInicio: 4, brand: { nombre: brandNombre || 'CobraPro' }, tarifas: JSON.parse(JSON.stringify(DEFAULT_TARIFAS)) }, _idem: {}
  };
}
function normalizeTenant(b) {
  b.cortes = b.cortes || []; b.gestiones = b.gestiones || []; b.transferencias = b.transferencias || [];
  b.recolecciones = b.recolecciones || []; b.caja = b.caja || {}; b.porEntregar = b.porEntregar || [];
  b.jcEntregas = b.jcEntregas || []; b.jcCierres = b.jcCierres || [];
  b.asignaciones = b.asignaciones || [];
  b.contactos = b.contactos || [];
  b.objetivos = b.objetivos || { suc: {}, cob: {} }; b.objetivos.suc = b.objetivos.suc || {}; b.objetivos.cob = b.objetivos.cob || {};
  b.flujo = b.flujo || [];
  b.config = b.config || {}; if (!b.config.corteAutoHora) b.config.corteAutoHora = '19:00';
  if (!b.config.corteAutoDias) b.config.corteAutoDias = [1, 2, 3, 4, 5, 6];
  if (b.config.semanaInicio == null) b.config.semanaInicio = 4;
  b.config.brand = b.config.brand || { nombre: 'CobraPro' };
  b.config.tarifas = b.config.tarifas || JSON.parse(JSON.stringify(DEFAULT_TARIFAS));
  if (!b.config.tarifas.s16) b.config.tarifas.s16 = JSON.parse(JSON.stringify(DEFAULT_TARIFAS.s16));
  if (!b.config.tarifas.s17) b.config.tarifas.s17 = JSON.parse(JSON.stringify(DEFAULT_TARIFAS.s17));
  if (!b.config.tarifas.s21) b.config.tarifas.s21 = JSON.parse(JSON.stringify(DEFAULT_TARIFAS.s21));
  if (!b.config.tarifas.s31) b.config.tarifas.s31 = JSON.parse(JSON.stringify(DEFAULT_TARIFAS.s31));
  b._idem = b._idem || {};
  (b.cortes || []).forEach(c => { if (c.estado === 'pendiente' && !(c.totalEfectivo > 0)) { c.estado = 'recibido'; c.recibidoAt = c.recibidoAt || new Date().toISOString(); c.recibidoBy = c.recibidoBy || 'sin efectivo'; } });
  return b;
}
async function getTenant(tid) {
  tid = +tid;
  if (tenantCache[tid]) return tenantCache[tid];
  const blob = await loadRow(tid);
  if (!blob) return null;
  tenantCache[tid] = normalizeTenant(blob);
  return tenantCache[tid];
}
// `db` apunta dinámicamente al blob de la agencia del request (vía AsyncLocalStorage)
const db = new Proxy({}, {
  get(_, p) { const s = als.getStore(); return s && s.db ? s.db[p] : undefined; },
  set(_, p, v) { const s = als.getStore(); if (s && s.db) s.db[p] = v; return true; },
  has(_, p) { const s = als.getStore(); return s && s.db ? (p in s.db) : false; },
  deleteProperty(_, p) { const s = als.getStore(); if (s && s.db) delete s.db[p]; return true; },
  ownKeys() { const s = als.getStore(); return s && s.db ? Reflect.ownKeys(s.db) : []; },
  getOwnPropertyDescriptor(_, p) { const s = als.getStore(); return s && s.db ? Object.getOwnPropertyDescriptor(s.db, p) : undefined; }
});
function saveDB() { const s = als.getStore(); if (s && s.tenantId != null) saveRow(s.tenantId, s.db); }
function nextId(coll) { return (db[coll] || []).reduce((m, x) => Math.max(m, x.id), 0) + 1; }

/* ---------- Motor de cálculo real (factores Credia) ---------- */
const DEFAULT_TARIFAS = {
  diario:  [{ p: 10, f: 1.17, fijo: 30 }, { p: 20, f: 1.23, fijo: 60 }, { p: 30, f: 1.33, fijo: 90 }],
  semanal: [{ p: 4, f: 1.35, fijo: 60 }, { p: 8, f: 1.43, fijo: 120 }, { p: 12, f: 1.53, fijo: 180 }, { p: 16, f: 1.63, fijo: 240 }, { p: 20, f: 1.83, fijo: 300 }],
  p17:     [{ p: 17, f: 1.73, fijo: 270 }],
  s16:     { factor: 1.6, fijo: 100, ppFactor: 0.1, ppFijo: 100, pagos: 16 },
  s17:     { factor: 1.7, fijo: 200, ppFactor: 0.1, ppFijo: 200, pagos: 17 },
  s21:     { factor: 1.785, fijo: 200, ppFactor: 0.085, ppFijo: 200, pagos: 21 },
  s31:     { factor: 1.86, fijo: 200, ppFactor: 0.06, ppFijo: 200, pagos: 31 },
  unico:   { base: 2, factor: 0.0183 }
};
function tarifasActuales() { return (db && db.config && db.config.tarifas) ? db.config.tarifas : DEFAULT_TARIFAS; }
function calcCredito(tipo, plazo, monto, dias) {
  const T = tarifasActuales();
  if (tipo === 's16' || tipo === 's17' || tipo === 's21' || tipo === 's31') {
    const c = T[tipo] || DEFAULT_TARIFAS[tipo];
    const r2 = x => Math.round(x * 100) / 100;
    const total = r2(monto * c.factor + c.fijo);
    const pagos = c.pagos;
    const primerPago = r2(monto * c.ppFactor + c.ppFijo);
    const cuota = r2((total - primerPago) / (pagos - 1)); // pagos 2..N (Tarifa 2)
    return { total, pagos, cuota, primerPago, descuentaPP: true, entregaCliente: r2(monto - primerPago) };
  }
  if (tipo === 'unico') { const u = T.unico || DEFAULT_TARIFAS.unico; const tap = monto + (dias || 15) * ((u.base||0) + monto * (u.factor||0)); return { total: tap, pagos: 1, cuota: tap }; }
  const arr = T[tipo] || T.semanal || DEFAULT_TARIFAS.semanal; const it = arr.find(x => x.p === plazo) || arr[0];
  const total = monto * it.f + it.fijo; return { total, pagos: it.p, cuota: total / it.p };
}
function genPassword() { const c = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; let p = ''; for (let i = 0; i < 8; i++) p += c[Math.floor(Math.random() * c.length)]; return p; }
function saldoDe(saleId) { return db.movimientos.filter(m => m.saleId === saleId).reduce((s, m) => s + (m.cargo || 0) - (m.abono || 0), 0); }

/* ---------- Semilla de agencia DEMO (datos de ejemplo, solo para la primera agencia migrada si está vacía) ---------- */
function seedDemo(brandNombre) {
  const b = blankTenant(brandNombre || 'CobraPro', 'admin', 'admin123', 'Administrador');
  b.sucursales = ['Amecameca', 'Chalco', 'Ozumba', 'Tláhuac', 'Tepetlixpa', 'Juchitepec'].map((n, i) => ({ id: i + 1, nombre: n }));
  const c1 = calcCredito('semanal', 12, 6000);
  const c2 = calcCredito('diario', 20, 3000);
  b.clients = [
    { id: 1, nombre: 'María González', tel: '5544120098', calle: 'Calle Hidalgo 24', col: 'Centro', sucursalId: 1, prom: 'Ana Reyes' },
    { id: 2, nombre: 'Pedro Jiménez', tel: '5544120134', calle: 'Av. Juárez 110', col: 'San Miguel', sucursalId: 1, prom: 'Ana Reyes' },
  ];
  b.sales = [
    { id: 1, folio: 'F-1042', clientId: 1, tipo: 'semanal', plazo: 12, monto: 6000, cuota: c1.cuota, total: c1.total, prom: 'Ana Reyes', sucursalId: 1, createdAt: new Date().toISOString() },
    { id: 2, folio: 'F-1043', clientId: 2, tipo: 'diario', plazo: 20, monto: 3000, cuota: c2.cuota, total: c2.total, prom: 'Ana Reyes', sucursalId: 1, createdAt: new Date().toISOString() },
  ];
  b.movimientos = [
    { id: 1, saleId: 1, fecha: '05/03/2026', concepto: 'Disposición de crédito', origen: 'Sucursal Amecameca', cargo: c1.total, abono: 0 },
    { id: 2, saleId: 1, fecha: '12/03/2026', concepto: 'Abono semana 1', origen: 'Ruta · A. Reyes', cargo: 0, abono: c1.cuota, forma: 'efectivo' },
    { id: 3, saleId: 2, fecha: '06/03/2026', concepto: 'Disposición de crédito', origen: 'Sucursal Amecameca', cargo: c2.total, abono: 0 },
  ];
  b.caja = { '1': { inicial: 2000, efectivo: 0, banco: 0, entregas: 0, retiros: 0 } };
  b.porEntregar = [{ id: 1, sucursalId: 1, prom: 'Ana Reyes', monto: 8400 }];
  return b;
}

/* ---------- Auth (multitenant) ---------- */
async function auth(req, res, next) {
  const t = (req.headers.authorization || '').replace('Bearer ', '');
  let payload;
  try { payload = jwt.verify(t, JWT_SECRET); } catch { return res.status(401).json({ error: 'No autorizado' }); }
  req.user = payload;
  if (payload.tenantId != null) {
    const blob = await getTenant(payload.tenantId);
    if (!blob) return res.status(401).json({ error: 'Agencia no encontrada' });
    return als.run({ tenantId: +payload.tenantId, db: blob }, () => next());
  }
  // superadmin sin agencia seleccionada (solo endpoints /api/super/*)
  return next();
}
function rol(...roles) { return (req, res, next) => roles.includes(req.user.rol) ? next() : res.status(403).json({ error: 'Permiso insuficiente' }); }
function superOnly(req, res, next) { return req.user && req.user.super ? next() : res.status(403).json({ error: 'Solo superadmin' }); }
function idem(req, res, next) {
  const k = req.body && req.body.idempotencyKey;
  if (k && db._idem[k]) return res.json({ ok: true, duplicado: true });
  req._idemKey = k; next();
}
function markIdem(req) { if (req._idemKey) { db._idem[req._idemKey] = true; } }

app.post('/api/auth/login', async (req, res) => {
  const usuario = (req.body.usuario || '').toLowerCase().trim();
  const password = req.body.password || '';
  // ¿superadmin?
  const su = (SYS.superUsers || []).find(x => x.usuario === usuario);
  if (su && bcrypt.compareSync(password, su.passwordHash)) {
    const token = jwt.sign({ super: true, nombre: su.nombre, usuario: su.usuario }, JWT_SECRET, { expiresIn: '12h' });
    return res.json({ token, super: true, user: { nombre: su.nombre, usuario: su.usuario, rol: 'super' }, brand: { nombre: 'CobraPro · Panel maestro' } });
  }
  // usuario de agencia: el índice global dice a qué agencia pertenece
  const tid = SYS.userIndex ? SYS.userIndex[usuario] : null;
  if (tid == null) return res.status(401).json({ error: 'Usuario o contraseña inválidos' });
  const tnt = (SYS.tenants || []).find(t => t.id === +tid);
  if (tnt && tnt.activo === false) return res.status(403).json({ error: 'Esta agencia está suspendida. Contacta a soporte.' });
  const blob = await getTenant(tid);
  const u = blob && blob.users.find(x => x.usuario === usuario && x.activo);
  if (!u || !bcrypt.compareSync(password, u.passwordHash)) return res.status(401).json({ error: 'Usuario o contraseña inválidos' });
  const brand = (blob.config && blob.config.brand) || { nombre: 'CobraPro' };
  const token = jwt.sign({ id: u.id, rol: u.rol, nombre: u.nombre, sucursalId: u.sucursalId, tenantId: +tid }, JWT_SECRET, { expiresIn: '12h' });
  res.json({ token, user: { id: u.id, nombre: u.nombre, rol: u.rol, sucursalId: u.sucursalId, usuario: u.usuario }, brand });
});
app.get('/api/auth/me', auth, (req, res) => res.json(req.user));
app.get('/api/brand', auth, (req, res) => {
  if (req.user.tenantId != null) return res.json((db.config && db.config.brand) || { nombre: 'CobraPro' });
  res.json({ nombre: 'CobraPro · Panel maestro' });
});

/* ---------- SUPERADMIN: gestión de agencias ---------- */
app.get('/api/super/tenants', auth, superOnly, (req, res) => {
  const list = (SYS.tenants || []).map(t => {
    const b = tenantCache[t.id];
    return { id: t.id, nombre: t.nombre, activo: t.activo !== false, createdAt: t.createdAt,
      stats: b ? { usuarios: (b.users || []).length, sucursales: (b.sucursales || []).length, clientes: (b.clients || []).length } : null };
  });
  res.json(list);
});
app.post('/api/super/tenants', auth, superOnly, async (req, res) => {
  const { nombre, adminUsuario, adminPassword, adminNombre } = req.body;
  if (!nombre || !adminUsuario) return res.status(400).json({ error: 'Nombre de agencia y usuario admin son obligatorios' });
  const uname = adminUsuario.toLowerCase().trim();
  if (SYS.userIndex && SYS.userIndex[uname] != null) return res.status(409).json({ error: 'Ese usuario admin ya está en uso por otra agencia' });
  SYS.seqTenant = (SYS.seqTenant || 0) + 1;
  const tid = SYS.seqTenant;
  const pass = (adminPassword && adminPassword.length >= 4) ? adminPassword : genPassword();
  const blob = blankTenant(nombre, uname, pass, adminNombre || 'Administrador');
  tenantCache[tid] = blob; saveRow(tid, blob);
  SYS.tenants.push({ id: tid, nombre, activo: true, createdAt: new Date().toISOString() });
  SYS.userIndex = SYS.userIndex || {}; SYS.userIndex[uname] = tid;
  saveSystem();
  res.status(201).json({ id: tid, nombre, adminUsuario: uname, adminPassword: pass });
});
app.patch('/api/super/tenants/:id', auth, superOnly, (req, res) => {
  const t = (SYS.tenants || []).find(x => x.id === +req.params.id);
  if (!t) return res.status(404).json({ error: 'Agencia no encontrada' });
  if (typeof req.body.activo === 'boolean') t.activo = req.body.activo;
  if (req.body.nombre) { t.nombre = req.body.nombre; const b = tenantCache[t.id]; if (b) { b.config = b.config || {}; b.config.brand = b.config.brand || {}; b.config.brand.nombre = req.body.nombre; saveRow(t.id, b); } }
  saveSystem();
  res.json({ ok: true });
});
// el superadmin "entra" a una agencia para dar soporte (token con rol admin acotado a ese tenant)
app.post('/api/super/enter/:id', auth, superOnly, async (req, res) => {
  const tid = +req.params.id;
  const blob = await getTenant(tid);
  if (!blob) return res.status(404).json({ error: 'Agencia no encontrada' });
  const t = (SYS.tenants || []).find(x => x.id === tid);
  const token = jwt.sign({ id: 0, rol: 'admin', nombre: 'Soporte (superadmin)', sucursalId: null, tenantId: tid, super: true }, JWT_SECRET, { expiresIn: '6h' });
  res.json({ token, user: { id: 0, nombre: 'Soporte', rol: 'admin', sucursalId: null, usuario: 'soporte' }, brand: (blob.config && blob.config.brand) || { nombre: t ? t.nombre : 'CobraPro' } });
});

/* ---------- Usuarios (panel de alta de usuarios y contraseñas) ---------- */
app.get('/api/users', auth, rol('admin', 'supervisor'), (req, res) => {
  res.json(db.users.map(u => ({ id: u.id, nombre: u.nombre, usuario: u.usuario, rol: u.rol, sucursalId: u.sucursalId, activo: u.activo, createdAt: u.createdAt })));
});
app.post('/api/users', auth, rol('admin'), (req, res) => {
  const { nombre, usuario, rol: r, sucursalId, password } = req.body;
  if (!nombre || !usuario || !r) return res.status(400).json({ error: 'nombre, usuario y rol son obligatorios' });
  const uname = usuario.toLowerCase().trim();
  if (db.users.some(u => u.usuario === uname)) return res.status(409).json({ error: 'Ese usuario ya existe' });
  if (SYS.userIndex && SYS.userIndex[uname] != null) return res.status(409).json({ error: 'Ese usuario ya está en uso (debe ser único en todo el sistema)' });
  const plain = (password && password.length >= 4) ? password : genPassword();
  const u = { id: nextId('users'), nombre, usuario: uname, rol: r, sucursalId: sucursalId || null, passwordHash: bcrypt.hashSync(plain, 8), activo: true, createdAt: new Date().toISOString() };
  db.users.push(u); saveDB();
  // registra el usuario en el índice global para que pueda iniciar sesión
  const tid = als.getStore().tenantId;
  SYS.userIndex = SYS.userIndex || {}; SYS.userIndex[uname] = tid; saveSystem();
  res.status(201).json({ id: u.id, nombre: u.nombre, usuario: u.usuario, rol: u.rol, sucursalId: u.sucursalId, passwordGenerada: plain });
});
app.patch('/api/users/:id', auth, rol('admin'), (req, res) => {
  const u = db.users.find(x => x.id == req.params.id);
  if (!u) return res.status(404).json({ error: 'Usuario no encontrado' });
  if (typeof req.body.activo === 'boolean') u.activo = req.body.activo;
  if (req.body.nombre) u.nombre = String(req.body.nombre).trim();
  if (req.body.rol && ['admin','supervisor','sucursal','cobrador','jc'].includes(req.body.rol)) u.rol = req.body.rol;
  if (req.body.sucursalId !== undefined) {
    const sid = req.body.sucursalId === null || req.body.sucursalId === '' ? null : +req.body.sucursalId;
    if ((u.rol === 'cobrador' || u.rol === 'sucursal' || u.rol === 'jc') && !sid) return res.status(400).json({ error: 'Un cobrador, JC o usuario de sucursal debe tener una sucursal asignada.' });
    u.sucursalId = sid;
  }
  let nueva = null;
  if (req.body.resetPassword) { nueva = genPassword(); u.passwordHash = bcrypt.hashSync(nueva, 8); }
  saveDB();
  res.json({ ok: true, passwordGenerada: nueva, usuario: { id: u.id, nombre: u.nombre, rol: u.rol, sucursalId: u.sucursalId } });
});

/* ---------- Catálogos ---------- */
app.get('/api/sucursales', auth, (req, res) => res.json(db.sucursales.filter(s => s.activo !== false)));
app.post('/api/sucursales', auth, rol('admin'), (req, res) => {
  const nombre = (req.body.nombre || '').trim();
  if (!nombre) return res.status(400).json({ error: 'Nombre de sucursal requerido' });
  if (db.sucursales.find(s => s.activo !== false && (s.nombre || '').toLowerCase() === nombre.toLowerCase()))
    return res.status(409).json({ error: 'Ya existe una sucursal con ese nombre' });
  const suc = { id: nextId('sucursales'), nombre };
  db.sucursales.push(suc); saveDB();
  res.status(201).json(suc);
});
app.patch('/api/sucursales/:id', auth, rol('admin'), (req, res) => {
  const s = db.sucursales.find(x => x.id === +req.params.id);
  if (!s) return res.status(404).json({ error: 'Sucursal no encontrada' });
  const nombre = (req.body.nombre || '').trim();
  if (!nombre) return res.status(400).json({ error: 'Nombre requerido' });
  s.nombre = nombre; saveDB();
  res.json(s);
});
app.delete('/api/sucursales/:id', auth, rol('admin'), (req, res) => {
  const id = +req.params.id;
  const s = db.sucursales.find(x => x.id === id);
  if (!s) return res.status(404).json({ error: 'Sucursal no encontrada' });
  const activos = new Set(db.clients.filter(c => c.activo !== false).map(c => c.id));
  const credAct = db.sales.filter(x => x.sucursalId === id && activos.has(x.clientId) && saldoDe(x.id) > 0);
  if (credAct.length) return res.status(409).json({ error: `No se puede eliminar "${s.nombre}": tiene ${credAct.length} crédito(s) activo(s). Transfiérelos a otra sucursal primero.` });
  const usuarios = db.users.filter(u => u.activo && u.sucursalId === id);
  if (usuarios.length) return res.status(409).json({ error: `No se puede eliminar "${s.nombre}": tiene ${usuarios.length} usuario(s) asignado(s). Reasígnalos primero.` });
  s.activo = false; s.bajaAt = new Date().toISOString(); saveDB();
  res.json({ ok: true });
});

/* ---------- Clientes / cartera ---------- */
app.get('/api/clients', auth, (req, res) => {
  const q = (req.query.search || '').toLowerCase();
  const prom = req.query.prom;
  const out = db.clients.filter(c => c.activo !== false)
    .filter(c => !prom || c.prom === prom)
    .filter(c => !q || [c.nombre, c.tel, c.calle, c.col, c.prom].join(' ').toLowerCase().includes(q))
    .map(c => ({ ...c, creditos: db.sales.filter(s => s.clientId === c.id).map(s => ({ ...s, saldo: saldoDe(s.id) })) }));
  res.json(out);
});
app.get('/api/sales', auth, (req, res) => {
  const activos = new Set(db.clients.filter(c => c.activo !== false).map(c => c.id));
  const miSuc = (req.user.rol === 'sucursal') ? Number(req.user.sucursalId || 0) : null;
  res.json(db.sales.filter(s => activos.has(s.clientId) && (miSuc == null || s.sucursalId === miSuc)).map(s => {
    const c = db.clients.find(x => x.id === s.clientId) || {};
    const { entrega, ...rest } = s;
    return { ...rest, saldo: saldoDe(s.id), cliente: c.nombre, tel: c.tel || '', calle: c.calle || '', col: c.col || '', tieneEvidencia: !!entrega };
  }));
});
/* ---------- Mapa de clientes ---------- */
app.get('/api/mapa', auth, rol('admin', 'supervisor'), (req, res) => {
  const sucMap = {}; db.sucursales.forEach(s => sucMap[s.id] = s.nombre);
  const activos = db.clients.filter(c => c.activo !== false);
  const out = []; let pendientes = 0, sumLat = 0, sumLng = 0, nLoc = 0;
  for (const c of activos) {
    const sales = db.sales.filter(s => s.clientId === c.id);
    const saldo = sales.reduce((a, s) => a + Math.max(0, saldoDe(s.id)), 0);
    let maxAtraso = 0, cuotaRef = 1;
    sales.forEach(s => { if (saldoDe(s.id) > 0) { const at = calcAtraso(s); if (at.montoAtraso > maxAtraso) maxAtraso = at.montoAtraso; cuotaRef = s.cuota || cuotaRef; } });
    let estado = 'corriente';
    if (saldo <= 0) estado = 'liquidado';
    else if (maxAtraso <= 0) estado = 'corriente';
    else estado = maxAtraso > cuotaRef * 3 ? 'vencido' : 'atraso';
    const has = typeof c.lat === 'number' && typeof c.lng === 'number';
    if (has) { sumLat += c.lat; sumLng += c.lng; nLoc++; } else pendientes++;
    out.push({ id: c.id, nombre: c.nombre, tel: c.tel || '', dir: [c.calle, c.col].filter(Boolean).join(', '),
      sucursal: sucMap[c.sucursalId] || '—', cobrador: c.prom || '—', saldo, estado,
      lat: has ? c.lat : null, lng: has ? c.lng : null });
  }
  const centro = nLoc ? [sumLat / nLoc, sumLng / nLoc] : [19.4326, -99.1332];
  res.json({ clientes: out, pendientes, ubicados: nLoc, total: activos.length, centro });
});
app.post('/api/clients/:id/ubicar', auth, rol('admin', 'supervisor'), (req, res) => {
  const c = db.clients.find(x => x.id == req.params.id);
  if (!c) return res.status(404).json({ error: 'Cliente no encontrado' });
  const { lat, lng, src } = req.body;
  if (typeof lat !== 'number' || typeof lng !== 'number') return res.status(400).json({ error: 'lat/lng requeridos' });
  c.lat = lat; c.lng = lng; c.geoSrc = src || 'manual'; saveDB();
  res.json({ ok: true });
});

/* ---------- Geocodificación masiva por dirección (corre en el servidor) ----------
   El navegador NO puede geocodificar 914 direcciones contra Nominatim: no puede
   mandar User-Agent (header prohibido) y OSM bloquea el uso masivo => 0 ubicados.
   Aquí se hace en el backend con User-Agent válido, 1 req/seg, guardando el avance
   cada 10 clientes (reanudable si Render reinicia). ----------------------------- */
function _limpiaSuc(n) { return String(n || '').replace(/\s*\b(I{1,3}|IV|V|VI|\d+)\b\s*$/i, '').trim(); }
function _normMuni(s) { return String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim(); }
// Coordenadas fijas de respaldo por municipio (cuando Nominatim falla, nadie se queda sin pin)
const MUNI_COORDS = {
  'puebla': { lat: 19.0414, lng: -98.2063 },
  'apizaco': { lat: 19.4131, lng: -98.1453 },
  'cholula': { lat: 19.0630, lng: -98.3030 },
  'san pedro cholula': { lat: 19.0633, lng: -98.3072 },
  'san andres cholula': { lat: 19.0530, lng: -98.3010 },
  'cuautla': { lat: 18.8125, lng: -98.9536 },
  'tlaxcala': { lat: 19.3139, lng: -98.2404 }
};
function _muniFijo(muni) {
  const k = _normMuni(muni);
  if (MUNI_COORDS[k]) return MUNI_COORDS[k];
  for (const m in MUNI_COORDS) { if (k.includes(m) || m.includes(k)) return MUNI_COORDS[m]; }
  return null;
}
async function _geocode(q) {
  try {
    const url = 'https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=mx&q=' + encodeURIComponent(q);
    const r = await fetch(url, { headers: { 'User-Agent': 'CobraPro/1.0 (soporte@legaxia.uk)', 'Accept': 'application/json', 'Accept-Language': 'es' } });
    if (!r.ok) return null;
    const a = await r.json();
    if (a && a[0] && a[0].lat) return { lat: parseFloat(a[0].lat), lng: parseFloat(a[0].lon) };
  } catch (e) {}
  return null;
}
function _extraeColonia(s) {
  s = String(s || '');
  const m = s.match(/\b(?:col(?:onia)?\.?|barrio|barr?\.?|fracc(?:ionamiento)?\.?|u\.?\s?h\.?|unidad\s+hab\w*|ampliaci[oó]n|secc(?:i[oó]n)?\.?)\s+([^,;]+)/i);
  if (m && m[1]) return m[1].replace(/\s+\d.*$/, '').trim();          // "Col Centro 12" -> "Centro"
  const parts = s.split(',').map(x => x.trim()).filter(Boolean);
  if (parts.length >= 2) { const last = parts[parts.length - 1]; if (last && !/^\d/.test(last)) return last; }
  return '';
}
function _zonaKey(col, muni) { return (String(col || '') + '|' + String(muni || '')).toLowerCase(); }
function _gruposPendientes() {
  const sucMap = {}; (db.sucursales || []).forEach(s => sucMap[s.id] = s.nombre);
  const grupos = {};
  for (const c of (db.clients || [])) {
    if (c.activo === false || typeof c.lat === 'number') continue;
    if (![c.calle, c.col, c.ciudad].filter(Boolean).length) continue;
    const muni = _limpiaSuc(sucMap[c.sucursalId] || '');
    const col = c.col || _extraeColonia(c.calle);
    const key = _zonaKey(col, muni);
    (grupos[key] = grupos[key] || { col, muni, clientes: [] }).clientes.push(c);
  }
  return grupos;
}
function _asignaZona(clientes, r) {
  let n = 0;
  for (const c of clientes) {
    c.lat = r.lat + (Math.random() - 0.5) * 0.006;   // ~±300 m para que no se encimen
    c.lng = r.lng + (Math.random() - 0.5) * 0.006;
    c.geoSrc = 'zona'; n++;
  }
  return n;
}
// Paso 1: coloca al instante las zonas ya cacheadas y devuelve las que faltan por geocodificar
app.post('/api/mapa/geocode/preparar', auth, rol('admin', 'supervisor'), (req, res) => {
  db.geoCache = db.geoCache || {};
  const grupos = _gruposPendientes();
  const zonas = []; let yaUbicados = 0;
  for (const key of Object.keys(grupos)) {
    const g = grupos[key]; const r = db.geoCache[key];
    if (r) yaUbicados += _asignaZona(g.clientes, r);
    else zonas.push({ col: g.col, muni: g.muni, count: g.clientes.length });
  }
  if (yaUbicados) saveDB();
  res.json({ yaUbicados, zonas, totalZonas: Object.keys(grupos).length });
});
// Paso 2: geocodifica UNA zona (User-Agent del servidor) y la reparte a sus clientes pendientes
app.post('/api/mapa/geocode/zona', auth, rol('admin', 'supervisor'), async (req, res) => {
  const { col, muni } = req.body || {};
  db.geoCache = db.geoCache || {};
  const key = _zonaKey(col, muni);
  let r = db.geoCache[key];
  if (!r) {
    r = await _geocode([col, muni, 'México'].filter(Boolean).join(', '));
    if (!r && muni) r = await _geocode([muni, 'México'].join(', '));   // fallback al municipio (Nominatim)
    if (!r && muni) r = _muniFijo(muni);                                // último recurso: tabla fija
    if (r) db.geoCache[key] = r;
  }
  if (!r) return res.json({ ok: false, ubicados: 0 });
  const g = _gruposPendientes()[key];
  const n = g ? _asignaZona(g.clientes, r) : 0;
  saveDB();
  res.json({ ok: true, ubicados: n });
});

// Respaldo: descarga TODO el estado de la agencia como JSON (para no depender solo de Render)
app.get('/api/admin/backup', auth, rol('admin'), (req, res) => {
  const s = als.getStore();
  const blob = (s && s.db) ? s.db : {};
  const brand = (blob.config && blob.config.brand && blob.config.brand.nombre) || 'cobrapro';
  const fecha = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
  const nombre = ('respaldo_' + brand + '_' + fecha).replace(/[^a-zA-Z0-9_-]/g, '_') + '.json';
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="' + nombre + '"');
  res.send(JSON.stringify(blob, null, 2));
});

/* ---------- Flujo JC (Jefe de Crédito): efectivo y entrega de créditos ---------- */
function jcCajaDe(jcId) {
  const recibido = db.jcEntregas.filter(e => e.jcId == jcId && e.estado === 'recibido').reduce((a, e) => a + (e.monto || 0), 0);
  const entregado = db.sales.filter(s => s.entrega && s.entrega.jcId == jcId).reduce((a, s) => a + (s.entregaMonto != null ? s.entregaMonto : (s.monto || 0)), 0);
  const recolectado = (db.recolecciones || []).filter(r => r.tipo === 'jc' && r.ref == jcId).reduce((a, r) => a + (r.monto || 0), 0);
  const asign = asignNeto('jc', jcId);
  return { recibido, entregado, recolectado, asign, saldo: recibido - entregado - recolectado + asign };
}
// ===== Posición de efectivo de quien entrega (nadie usa dinero propio: usa lo recibido/dotado) =====
function entregaMontoDe(s) { return s.entregaMonto != null ? s.entregaMonto : (s.monto || 0); }
function cajaRealDe(sid) { const c = db.caja[String(sid)] || {}; return (c.inicial || 0) + (c.efectivo || 0) + (c.entregas || 0) - (c.retiros || 0); }
function supervisorCajaDe(uid) {
  const dot = (db.flujo || []).filter(m => m.clase === 'dotacion' && m.destino && m.destino.tipo === 'supervisor' && m.destino.id == uid).reduce((a, m) => a + m.monto, 0);
  const entregado = db.sales.filter(s => s.entrega && s.entrega.por && s.entrega.por.rol === 'supervisor' && s.entrega.por.id == uid).reduce((a, s) => a + entregaMontoDe(s), 0);
  return dot - entregado + asignNeto('supervisor', uid);
}
// ===== Asignaciones de efectivo entre puestos (confirmadas mueven caja; el promotor solo envía) =====
function asignEntrada(tipo, id) { return (db.asignaciones || []).filter(a => a.estado === 'recibido' && a.toTipo === tipo && (tipo === 'admin' || String(a.toId) === String(id))).reduce((s, a) => s + (a.monto || 0), 0); }
function asignSalidaViva(tipo, id) { return (db.asignaciones || []).filter(a => (a.estado === 'pendiente' || a.estado === 'recibido') && a.fromTipo === tipo && (tipo === 'admin' || String(a.fromId) === String(id))).reduce((s, a) => s + (a.monto || 0), 0); }
function asignNeto(tipo, id) { return asignEntrada(tipo, id) - asignSalidaViva(tipo, id); }
function sucDeUser(user) { const me = db.users.find(u => u.id === user.id); return me ? me.sucursalId : (user.sucursalId || null); }
function posicionCash(user) {
  if (user.rol === 'admin') return flujoSaldo();
  if (user.rol === 'supervisor') return supervisorCajaDe(user.id);
  if (user.rol === 'jc') return jcCajaDe(user.id).saldo;
  if (user.rol === 'sucursal') return cajaRealDe(sucDeUser(user));
  return 0;
}
function reservadoPor(user) {
  return db.sales.filter(s => s.entregado !== true && s.tomadoPor && s.tomadoPor.rol === user.rol && s.tomadoPor.id === user.id).reduce((a, s) => a + entregaMontoDe(s), 0);
}
function disponibleEntrega(user) { return posicionCash(user) - reservadoPor(user); }
function scopeSucDe(user) { return (user.rol === 'admin' || user.rol === 'supervisor') ? null : sucDeUser(user); }
// Entregas: TODO el personal (sucursal/JC/supervisor/admin) ve y opera créditos por entregar de CUALQUIER sucursal.
function scopeEntregas(user) { return null; }
// JC disponibles en la sucursal (para que el cobrador elija a quién entregar)
app.get('/api/jc/lista', auth, (req, res) => {
  let jcs = db.users.filter(u => u.rol === 'jc' && u.activo);
  if (req.user.rol === 'cobrador' || req.user.rol === 'sucursal') {
    const me = db.users.find(u => u.id === req.user.id);
    if (me && me.sucursalId) jcs = jcs.filter(j => j.sucursalId === me.sucursalId);
  }
  res.json(jcs.map(j => ({ id: j.id, nombre: j.nombre })));
});
// Cobrador asigna efectivo a un JC (queda pendiente de que el JC lo reciba)
app.post('/api/jc-entregas', auth, rol('cobrador', 'sucursal'), (req, res) => {
  const { jcId, monto, nota } = req.body;
  const m = +monto;
  if (!jcId || !(m > 0)) return res.status(400).json({ error: 'Selecciona un JC e indica un monto válido' });
  const jc = db.users.find(u => u.id == jcId && u.rol === 'jc' && u.activo);
  if (!jc) return res.status(404).json({ error: 'JC no encontrado' });
  const me = db.users.find(u => u.id === req.user.id);
  // El efectivo sale de lo que el promotor trae en mano (su "por entregar").
  if (req.user.rol === 'cobrador') {
    const mis = db.porEntregar.filter(p => p.prom === req.user.nombre);
    const disp = mis.reduce((a, p) => a + p.monto, 0);
    if (m > disp + 0.5) return res.status(409).json({ error: `Solo traes $${Math.round(disp).toLocaleString('es-MX')} en efectivo por entregar; no puedes asignar $${Math.round(m).toLocaleString('es-MX')} al JC.` });
    let restante = m;
    for (const pe of mis) { if (restante <= 0) break; const take = Math.min(pe.monto, restante); pe.monto -= take; restante -= take; }
    db.porEntregar = db.porEntregar.filter(p => p.monto > 0.5);
  } else if (req.user.rol === 'sucursal') {
    // sale de la caja física de la sucursal
    const sid = String(me ? me.sucursalId : (req.user.sucursalId || 1));
    db.caja[sid] = db.caja[sid] || { inicial: 0, efectivo: 0, banco: 0, entregas: 0, retiros: 0 };
    const disp = (db.caja[sid].inicial || 0) + (db.caja[sid].efectivo || 0) + (db.caja[sid].entregas || 0) - (db.caja[sid].retiros || 0);
    if (m > disp + 0.5) return res.status(409).json({ error: `La caja solo tiene $${Math.round(disp).toLocaleString('es-MX')} en efectivo; no puedes asignar $${Math.round(m).toLocaleString('es-MX')} al JC.` });
    db.caja[sid].retiros = (db.caja[sid].retiros || 0) + m;
  }
  const ent = { id: nextId('jcEntregas'), cobradorId: req.user.id, cobradorNombre: req.user.nombre, jcId: jc.id, jcNombre: jc.nombre, monto: m, nota: nota || '', estado: 'pendiente', sucursalId: me ? me.sucursalId : null, fechaDDMM: fechaMxHoyDDMM(), creadoEn: new Date().toISOString() };
  db.jcEntregas.push(ent); saveDB();
  res.status(201).json(ent);
});
// Listado de entregas (cobrador ve las suyas; JC las dirigidas a él; admin todas)
app.get('/api/jc-entregas', auth, (req, res) => {
  let list = db.jcEntregas;
  if (req.user.rol === 'cobrador') list = list.filter(e => e.cobradorId === req.user.id);
  else if (req.user.rol === 'jc') list = list.filter(e => e.jcId === req.user.id);
  res.json(list.slice().reverse());
});
// JC confirma que recibió el efectivo → entra a su caja
app.post('/api/jc-entregas/:id/recibir', auth, rol('jc'), (req, res) => {
  const e = db.jcEntregas.find(x => x.id == req.params.id);
  if (!e) return res.status(404).json({ error: 'Entrega no encontrada' });
  if (e.jcId !== req.user.id) return res.status(403).json({ error: 'Esa entrega no es para ti' });
  if (e.estado === 'recibido') return res.status(409).json({ error: 'Ya estaba recibida' });
  e.estado = 'recibido'; e.recibidoEn = new Date().toISOString(); saveDB();
  res.json({ ok: true, caja: jcCajaDe(req.user.id) });
});

/* ===== Asignación de efectivo entre puestos (con confirmación del que recibe) ===== */
function puestoDe(user) {
  if (user.rol === 'sucursal') return { tipo: 'sucursal', id: sucDeUser(user) };
  if (user.rol === 'supervisor') return { tipo: 'supervisor', id: user.id };
  if (user.rol === 'jc') return { tipo: 'jc', id: user.id };
  if (user.rol === 'admin') return { tipo: 'admin', id: user.id };
  if (user.rol === 'cobrador') return { tipo: 'cobrador', id: user.id };
  return null;
}
function porEntregarDe(nombre) { return db.porEntregar.filter(p => p.prom === nombre).reduce((a, p) => a + (p.monto || 0), 0); }
function disponibleAsignar(user) { return user.rol === 'cobrador' ? porEntregarDe(user.nombre) : posicionCash(user); }
function nombrePuesto(tipo, id) {
  if (tipo === 'sucursal') { const s = db.sucursales.find(x => x.id == id); return 'Sucursal ' + (s ? s.nombre : id); }
  const u = db.users.find(x => x.id == id);
  return (tipo === 'jc' ? 'JC ' : tipo === 'supervisor' ? 'Supervisor ' : tipo === 'admin' ? 'Admin ' : '') + (u ? u.nombre : id);
}
function esMiPuesto(user, tipo, id) { const p = puestoDe(user); if (!p) return false; if (tipo === 'admin') return p.tipo === 'admin'; return p.tipo === tipo && String(p.id) === String(id); }

app.get('/api/asignaciones/destinos', auth, (req, res) => {
  const me = puestoDe(req.user);
  const out = [];
  db.sucursales.filter(s => s.activo !== false).forEach(s => out.push({ tipo: 'sucursal', id: s.id, nombre: 'Sucursal ' + s.nombre, caja: Math.round(cajaRealDe(s.id)) }));
  db.users.filter(u => u.rol === 'jc' && u.activo).forEach(u => out.push({ tipo: 'jc', id: u.id, nombre: 'JC ' + u.nombre, caja: Math.round(jcCajaDe(u.id).saldo) }));
  db.users.filter(u => u.rol === 'supervisor' && u.activo).forEach(u => out.push({ tipo: 'supervisor', id: u.id, nombre: 'Supervisor ' + u.nombre, caja: Math.round(supervisorCajaDe(u.id)) }));
  db.users.filter(u => u.rol === 'admin' && u.activo).forEach(u => out.push({ tipo: 'admin', id: u.id, nombre: 'Admin ' + u.nombre }));
  const destinos = out.filter(d => !(me && d.tipo === me.tipo && String(d.id) === String(me.id)));
  res.json({ disponible: Math.round(disponibleAsignar(req.user)), puesto: me, destinos });
});

app.post('/api/asignaciones', auth, (req, res) => {
  const { toTipo, toId, nota } = req.body; const monto = +req.body.monto;
  if (!(monto > 0)) return res.status(400).json({ error: 'Monto inválido' });
  if (!['sucursal', 'supervisor', 'jc', 'admin'].includes(toTipo)) return res.status(400).json({ error: 'Destino inválido. No se puede asignar a un promotor.' });
  // validar que el destino existe
  if (toTipo === 'sucursal') { if (!db.sucursales.find(s => s.id == toId)) return res.status(404).json({ error: 'Sucursal no encontrada' }); }
  else { if (!db.users.find(u => u.id == toId && u.rol === toTipo && u.activo)) return res.status(404).json({ error: 'Destino no encontrado' }); }
  const from = puestoDe(req.user);
  if (from && from.tipo === toTipo && String(from.id) === String(toId)) return res.status(400).json({ error: 'No puedes asignarte a ti mismo' });
  const disp = disponibleAsignar(req.user);
  if (monto > disp + 0.5) return res.status(409).json({ error: `Solo tienes $${Math.round(disp).toLocaleString('es-MX')} disponible; no puedes asignar $${Math.round(monto).toLocaleString('es-MX')}.` });
  // Débito inmediato del que envía:
  if (req.user.rol === 'cobrador') {
    // consume su efectivo en mano (por entregar), como al entregar al JC
    let restante = monto; const mis = db.porEntregar.filter(p => p.prom === req.user.nombre);
    for (const pe of mis) { if (restante <= 0) break; const take = Math.min(pe.monto, restante); pe.monto -= take; restante -= take; }
    db.porEntregar = db.porEntregar.filter(p => p.monto > 0.5);
  } else if (req.user.rol === 'sucursal') {
    const sid = String(sucDeUser(req.user)); db.caja[sid] = db.caja[sid] || { inicial: 0, efectivo: 0, banco: 0, entregas: 0, retiros: 0 };
    db.caja[sid].retiros = (db.caja[sid].retiros || 0) + monto;
  } // jc/supervisor/admin: el débito se refleja vía asignSalidaViva en su posición
  const a = { id: nextId('asignaciones'), fromTipo: from.tipo, fromId: from.id, fromNombre: req.user.nombre, toTipo, toId: toTipo === 'admin' ? toId : (+toId), toNombre: nombrePuesto(toTipo, toId), monto: Math.round(monto), nota: nota || '', estado: 'pendiente', fecha: fechaMxHoyDDMM(), creadoEn: new Date().toISOString() };
  db.asignaciones.push(a); saveDB();
  res.status(201).json(a);
});

app.get('/api/asignaciones', auth, (req, res) => {
  const all = db.asignaciones || [];
  const porConfirmar = all.filter(a => a.estado === 'pendiente' && esMiPuesto(req.user, a.toTipo, a.toId)).reverse();
  const enviadas = all.filter(a => { const p = puestoDe(req.user); return p && a.fromTipo === p.tipo && String(a.fromId) === String(p.id); }).slice(-40).reverse();
  const recibidas = all.filter(a => a.estado === 'recibido' && esMiPuesto(req.user, a.toTipo, a.toId)).slice(-40).reverse();
  res.json({ porConfirmar, enviadas, recibidas, disponible: Math.round(disponibleAsignar(req.user)) });
});

app.post('/api/asignaciones/:id/recibir', auth, (req, res) => {
  const a = (db.asignaciones || []).find(x => x.id == req.params.id);
  if (!a) return res.status(404).json({ error: 'Asignación no encontrada' });
  if (a.estado !== 'pendiente') return res.status(409).json({ error: 'Esa asignación ya no está pendiente' });
  if (!esMiPuesto(req.user, a.toTipo, a.toId)) return res.status(403).json({ error: 'Esa asignación no es para ti' });
  a.estado = 'recibido'; a.recibidoEn = new Date().toISOString(); a.recibidoPor = req.user.nombre;
  // crédito al que recibe:
  if (a.toTipo === 'sucursal') {
    const sid = String(a.toId); db.caja[sid] = db.caja[sid] || { inicial: 0, efectivo: 0, banco: 0, entregas: 0, retiros: 0 };
    db.caja[sid].inicial = (db.caja[sid].inicial || 0) + a.monto;
  } // jc/supervisor/admin: el crédito se refleja vía asignEntrada en su posición
  saveDB();
  res.json({ ok: true });
});

app.post('/api/asignaciones/:id/rechazar', auth, (req, res) => {
  const a = (db.asignaciones || []).find(x => x.id == req.params.id);
  if (!a) return res.status(404).json({ error: 'Asignación no encontrada' });
  if (a.estado !== 'pendiente') return res.status(409).json({ error: 'Esa asignación ya no está pendiente' });
  const p = puestoDe(req.user);
  const soyDestino = esMiPuesto(req.user, a.toTipo, a.toId);
  const soyOrigen = p && a.fromTipo === p.tipo && String(a.fromId) === String(p.id);
  if (!soyDestino && !soyOrigen) return res.status(403).json({ error: 'No puedes rechazar esta asignación' });
  a.estado = 'rechazado'; a.rechazadoEn = new Date().toISOString();
  // reembolso al que envió:
  if (a.fromTipo === 'cobrador') {
    const u = db.users.find(x => x.id == a.fromId);
    db.porEntregar.push({ id: nextId('porEntregar'), sucursalId: u ? u.sucursalId : null, prom: a.fromNombre, monto: a.monto });
  } else if (a.fromTipo === 'sucursal') {
    const sid = String(a.fromId); db.caja[sid] = db.caja[sid] || { inicial: 0, efectivo: 0, banco: 0, entregas: 0, retiros: 0 };
    db.caja[sid].retiros = Math.max(0, (db.caja[sid].retiros || 0) - a.monto);
  } // jc/supervisor/admin: al quedar 'rechazado' deja de contar en asignSalidaViva
  saveDB();
  res.json({ ok: true });
});
// Panel del JC
app.get('/api/jc/panel', auth, rol('jc'), (req, res) => {
  const me = db.users.find(u => u.id === req.user.id);
  const sucId = me ? me.sucursalId : null;
  const sucMap = {}; db.sucursales.forEach(s => sucMap[s.id] = s.nombre);
  const pendientes = db.jcEntregas.filter(e => e.jcId === req.user.id && e.estado === 'pendiente').reverse();
  const recibidas = db.jcEntregas.filter(e => e.jcId === req.user.id && e.estado === 'recibido').reverse();
  // créditos por entregar: de su sucursal, no entregados
  const porEntregar = db.sales.filter(s => s.entregado === false && (!s.tomadoPor || (s.tomadoPor.rol === 'jc' && s.tomadoPor.id === req.user.id))).map(s => {
    const cli = db.clients.find(c => c.id === s.clientId) || {};
    return { id: s.id, folio: s.folio, cliente: cli.nombre, tel: cli.tel || '', dir: [cli.calle, cli.col].filter(Boolean).join(', '), monto: s.monto, cobrador: s.prom, sucursal: sucMap[s.sucursalId] || '—', createdAt: s.createdAt };
  }).reverse();
  const entregados = db.sales.filter(s => s.entrega && s.entrega.jcId === req.user.id).map(s => {
    const cli = db.clients.find(c => c.id === s.clientId) || {};
    return { id: s.id, folio: s.folio, cliente: cli.nombre, monto: s.monto, fecha: s.entrega.fecha, lat: s.entrega.lat, lng: s.entrega.lng, fotoCasa: s.entrega.fotoCasa, fotoCliente: s.entrega.fotoCliente };
  }).reverse();
  res.json({ caja: jcCajaDe(req.user.id), sucursal: (db.sucursales.find(s => s.id === sucId) || {}).nombre || null, pendientes, recibidas: recibidas.slice(0, 30), porEntregar, entregados: entregados.slice(0, 30) });
});
// Reenviar un crédito existente a la cola de entrega del JC (para reconciliar)
app.post('/api/sales/:id/pendiente-entrega', auth, rol('admin', 'supervisor', 'sucursal'), (req, res) => {
  const s = db.sales.find(x => x.id == req.params.id);
  if (!s) return res.status(404).json({ error: 'Crédito no encontrado' });
  if (req.user.rol === 'sucursal') { const me = db.users.find(u => u.id === req.user.id); if (!me || s.sucursalId !== me.sucursalId) return res.status(403).json({ error: 'Ese crédito no es de tu sucursal' }); }
  s.entregado = false; if (s.entrega) delete s.entrega;
  saveDB();
  res.json({ ok: true });
});
// JC entrega un crédito al cliente con evidencia
app.post('/api/sales/:id/entregar', auth, rol('admin', 'supervisor', 'sucursal', 'jc'), (req, res) => {
  const s = db.sales.find(x => x.id == req.params.id);
  if (!s) return res.status(404).json({ error: 'Crédito no encontrado' });
  if (s.entregado === true || s.entrega) return res.status(409).json({ error: 'Ese crédito ya fue entregado' });
  const { lat, lng, fotoCasa, fotoCliente, firma } = req.body;
  if (!fotoCasa || !fotoCliente) return res.status(400).json({ error: 'Sube la foto de la casa y la foto del cliente' });
  if (!firma) return res.status(400).json({ error: 'Falta la firma del pagaré del cliente' });
  const esJefe = req.user.rol === 'admin' || req.user.rol === 'supervisor';
  // si lo tomó alguien más, no permitir entregarlo (salvo admin/supervisor)
  if (s.tomadoPor && !(s.tomadoPor.rol === req.user.rol && s.tomadoPor.id === req.user.id) && !esJefe)
    return res.status(409).json({ error: 'Ese crédito lo tomó ' + s.tomadoPor.nombre });
  const scope = scopeEntregas(req.user);
  if (scope != null && s.sucursalId !== scope) return res.status(403).json({ error: 'Ese crédito no es de tu sucursal' });
  const monto = entregaMontoDe(s);
  // efectivo disponible (liberando la reserva de ESTE crédito si ya lo tenías tomado)
  let disp = posicionCash(req.user) - reservadoPor(req.user);
  if (s.tomadoPor && s.tomadoPor.rol === req.user.rol && s.tomadoPor.id === req.user.id) disp += monto;
  if (disp < monto - 0.5) return res.status(409).json({ error: `No tienes suficiente efectivo para entregar este crédito. Disponible $${Math.round(disp).toLocaleString('es-MX')}, este crédito entrega $${Math.round(monto).toLocaleString('es-MX')} al cliente. Pide que te doten o recibe efectivo de un promotor.` });
  const cli = db.clients.find(c => c.id === s.clientId) || {};
  s.entregado = true;
  s.entrega = {
    por: { rol: req.user.rol, id: req.user.id, nombre: req.user.nombre },
    jcId: req.user.rol === 'jc' ? req.user.id : null, jcNombre: req.user.nombre,
    fecha: new Date().toISOString(), lat: typeof lat === 'number' ? lat : null, lng: typeof lng === 'number' ? lng : null, fotoCasa, fotoCliente, firma
  };
  delete s.tomadoPor;
  // descuento por posición del que entrega (el JC y el supervisor se descuentan solos vía jcCajaDe / supervisorCajaDe)
  if (req.user.rol === 'sucursal') {
    const sid = String(sucDeUser(req.user));
    db.caja[sid] = db.caja[sid] || { inicial: 0, efectivo: 0, banco: 0, entregas: 0, retiros: 0 };
    db.caja[sid].retiros = (db.caja[sid].retiros || 0) + monto;
  } else if (req.user.rol === 'admin') {
    flujoAgregar('salida', 'entrega', `Entrega de crédito ${s.folio} · ${cli.nombre || ''}`, monto, null, req.user.nombre);
  }
  if (cli && (typeof cli.lat !== 'number') && typeof lat === 'number') { cli.lat = lat; cli.lng = lng; cli.geoSrc = 'entrega'; }
  saveDB();
  res.json({ ok: true, posicion: Math.round(posicionCash(req.user)), caja: req.user.rol === 'jc' ? jcCajaDe(req.user.id) : undefined });
});
// ===== BANDEJA DE ENTREGAS (cola común; todos menos el promotor) =====
app.get('/api/entregas/bandeja', auth, rol('admin', 'supervisor', 'sucursal', 'jc'), (req, res) => {
  const scope = scopeEntregas(req.user);
  const sucMap = {}; db.sucursales.forEach(s => sucMap[s.id] = s.nombre);
  const map = s => { const c = db.clients.find(x => x.id === s.clientId) || {}; return { saleId: s.id, folio: s.folio, cliente: c.nombre || '—', dir: [c.calle, c.col, c.ciudad].filter(Boolean).join(', '), tel: c.tel || '', prom: s.prom, sucursal: sucMap[s.sucursalId] || '—', tipo: s.tipo, monto: s.monto, entregaMonto: entregaMontoDe(s), createdAt: s.createdAt, tomadoPor: s.tomadoPor || null }; };
  const pend = db.sales.filter(s => s.entregado !== true && (scope == null || s.sucursalId === scope));
  const mine = s => s.tomadoPor && s.tomadoPor.rol === req.user.rol && s.tomadoPor.id === req.user.id;
  res.json({
    rol: req.user.rol, posicion: Math.round(posicionCash(req.user)), disponible: Math.round(disponibleEntrega(req.user)),
    bandeja: pend.filter(s => !s.tomadoPor).map(map).reverse(),
    mias: pend.filter(mine).map(map).reverse(),
    deOtros: pend.filter(s => s.tomadoPor && !mine(s)).map(map).reverse()
  });
});
app.post('/api/entregas/:id/tomar', auth, rol('admin', 'supervisor', 'sucursal', 'jc'), (req, res) => {
  const s = db.sales.find(x => x.id == req.params.id);
  if (!s) return res.status(404).json({ error: 'Crédito no encontrado' });
  if (s.entregado === true) return res.status(409).json({ error: 'Ese crédito ya fue entregado' });
  if (s.tomadoPor && !(s.tomadoPor.rol === req.user.rol && s.tomadoPor.id === req.user.id)) return res.status(409).json({ error: 'Ese crédito ya lo tomó ' + s.tomadoPor.nombre });
  const scope = scopeEntregas(req.user);
  if (scope != null && s.sucursalId !== scope) return res.status(403).json({ error: 'Ese crédito no es de tu sucursal' });
  const monto = entregaMontoDe(s);
  if (disponibleEntrega(req.user) < monto - 0.5) return res.status(409).json({ error: `No tienes suficiente efectivo para tomar este crédito. Disponible $${Math.round(disponibleEntrega(req.user)).toLocaleString('es-MX')}, entrega $${Math.round(monto).toLocaleString('es-MX')}. Pide que te doten o recibe efectivo de un promotor.` });
  s.tomadoPor = { rol: req.user.rol, id: req.user.id, nombre: req.user.nombre, at: new Date().toISOString() };
  saveDB();
  res.json({ ok: true });
});
app.post('/api/entregas/:id/soltar', auth, rol('admin', 'supervisor', 'sucursal', 'jc'), (req, res) => {
  const s = db.sales.find(x => x.id == req.params.id);
  if (!s) return res.status(404).json({ error: 'Crédito no encontrado' });
  if (!s.tomadoPor) return res.json({ ok: true });
  const mine = s.tomadoPor.rol === req.user.rol && s.tomadoPor.id === req.user.id;
  const esJefe = req.user.rol === 'admin' || req.user.rol === 'supervisor';
  if (!mine && !esJefe) return res.status(403).json({ error: 'Ese crédito lo tomó ' + s.tomadoPor.nombre });
  delete s.tomadoPor; saveDB();
  res.json({ ok: true });
});
// JC hace su cierre del día (deja registro; el efectivo puede quedarse o recolectarse aparte)
app.post('/api/jc/cierre', auth, rol('jc'), (req, res) => {
  const hoy = fechaMxHoyISO();
  const ddmm = fechaMxHoyDDMM();
  const recibidoHoy = db.jcEntregas.filter(e => e.jcId === req.user.id && e.estado === 'recibido' && e.fechaDDMM === ddmm).reduce((a, e) => a + e.monto, 0);
  const entregadoHoy = db.sales.filter(s => s.entrega && s.entrega.jcId === req.user.id && s.entrega.fecha && fechaMxDeISO(s.entrega.fecha) === ddmm).reduce((a, s) => a + s.monto, 0);
  const caja = jcCajaDe(req.user.id);
  const cierre = { id: nextId('jcCierres'), jcId: req.user.id, jcNombre: req.user.nombre, fecha: hoy, recibidoHoy, entregadoHoy, saldoFinal: caja.saldo, creadoEn: new Date().toISOString() };
  db.jcCierres = db.jcCierres || []; db.jcCierres.push(cierre); saveDB();
  res.json({ ok: true, cierre });
});
// Ver evidencia de entrega de un crédito (admin/supervisor todos; cobrador solo sus clientes)
app.get('/api/sales/:id/entrega', auth, (req, res) => {
  const s = db.sales.find(x => x.id == req.params.id);
  if (!s) return res.status(404).json({ error: 'Crédito no encontrado' });
  const role = req.user.rol;
  const allowed = ['admin', 'supervisor', 'jc', 'sucursal'].includes(role) || (role === 'cobrador' && s.prom === req.user.nombre);
  if (!allowed) return res.status(403).json({ error: 'Sin permiso' });
  const cli = db.clients.find(c => c.id === s.clientId) || {};
  res.json({ entrega: s.entrega || null, cliente: cli.nombre, folio: s.folio });
});
// Datos para el pagaré (cliente + importe), usado por sucursal (PDF) y JC (firma)
app.get('/api/sales/:id/pagare', auth, (req, res) => {
  const s = db.sales.find(x => x.id == req.params.id);
  if (!s) return res.status(404).json({ error: 'Crédito no encontrado' });
  const role = req.user.rol;
  const allowed = ['admin', 'supervisor', 'jc', 'sucursal'].includes(role) || (role === 'cobrador' && s.prom === req.user.nombre);
  if (!allowed) return res.status(403).json({ error: 'Sin permiso' });
  const c = db.clients.find(x => x.id === s.clientId) || {};
  const brand = (db.config && db.config.brand && db.config.brand.nombre) || 'CobraPro';
  const suc = db.sucursales.find(x => x.id === s.sucursalId);
  const freq = s.tipo === 'diario' ? 'diarios' : (s.tipo === 'unico' ? 'único' : 'semanales');
  const pagos = s.tipo === 'unico' ? 1 : s.plazo;
  res.json({
    folio: s.folio, fecha: s.createdAt, acreedor: brand,
    lugar: [c.ciudad, c.estado].filter(Boolean).join(', ') || (suc ? suc.nombre : ''),
    cliente: { nombre: c.nombre || '—', domicilio: [c.calle, c.col, c.ciudad, c.estado].filter(Boolean).join(', ') || '—', curp: c.curp || '', tel: c.tel || '' },
    monto: s.monto, total: s.total, cuota: s.cuota, pagos, freq, tipo: s.tipo,
    primerPago: s.primerPago || 0, descuentaPP: !!s.descuentaPP, entregaMonto: s.entregaMonto != null ? s.entregaMonto : s.monto,
    articulos: s.articulos || [],
    firma: !!(s.entrega && s.entrega.firma)
  });
});
// Resumen para admin
app.get('/api/jc/resumen', auth, rol('admin', 'supervisor'), (req, res) => {
  const jcs = db.users.filter(u => u.rol === 'jc');
  const sucMap = {}; db.sucursales.forEach(s => sucMap[s.id] = s.nombre);
  res.json(jcs.map(j => ({ id: j.id, nombre: j.nombre, sucursal: sucMap[j.sucursalId] || '—', caja: jcCajaDe(j.id),
    pendientesRecibir: db.jcEntregas.filter(e => e.jcId === j.id && e.estado === 'pendiente').length,
    entregados: db.sales.filter(s => s.entrega && s.entrega.jcId === j.id).length })));
});

app.delete('/api/clients/:id', auth, rol('admin', 'supervisor'), (req, res) => {
  const id = +req.params.id;
  const c = db.clients.find(x => x.id === id);
  if (!c) return res.status(404).json({ error: 'Cliente no encontrado' });
  c.activo = false; c.bajaAt = new Date().toISOString(); c.bajaBy = req.user.nombre;
  saveDB();
  res.json({ ok: true });
});
app.patch('/api/clients/:id', auth, rol('admin', 'supervisor'), (req, res) => {
  const id = +req.params.id;
  const c = db.clients.find(x => x.id === id);
  if (!c) return res.status(404).json({ error: 'Cliente no encontrado' });
  const { nombre, tel, calle, col, ciudad, estado, curp, prom, sucursalId } = req.body;
  if (ciudad !== undefined) c.ciudad = ciudad;
  if (estado !== undefined) c.estado = estado;
  if (curp !== undefined) {
    const cn = String(curp || '').trim().toUpperCase();
    if (cn && !/^[A-Z]{4}\d{6}[A-Z0-9]{8}$/.test(cn)) return res.status(400).json({ error: 'La CURP no tiene formato válido (18 caracteres).' });
    if (cn) { const dupC = db.clients.find(x => x.id !== id && x.activo !== false && (x.curp || '').trim().toUpperCase() === cn); if (dupC) return res.status(409).json({ error: `La CURP ${cn} ya pertenece a "${dupC.nombre}".` }); }
    c.curp = cn;
  }
  // si cambia el teléfono, validar que no choque con otro cliente activo
  if (tel !== undefined && tel !== c.tel) {
    const telNorm = String(tel || '').replace(/\D/g, '');
    if (telNorm.length >= 10) {
      const dup = db.clients.find(x => x.id !== id && x.activo !== false && (x.tel || '').replace(/\D/g, '') === telNorm);
      if (dup) return res.status(409).json({ error: `El teléfono ${tel} ya pertenece a "${dup.nombre}"` });
    }
  }
  const antesNombre = c.nombre;
  if (nombre !== undefined) c.nombre = nombre;
  if (tel !== undefined) c.tel = tel;
  if (calle !== undefined) c.calle = calle;
  if (col !== undefined) c.col = col;
  if (sucursalId !== undefined) c.sucursalId = +sucursalId;
  // si cambia el cobrador, propaga a sus créditos vigentes (reasignación de cartera)
  if (prom !== undefined && prom !== c.prom) {
    c.prom = prom;
    db.sales.filter(s => s.clientId === id && saldoDe(s.id) > 0).forEach(s => { s.prom = prom; if (sucursalId !== undefined) s.sucursalId = +sucursalId; });
  } else if (sucursalId !== undefined) {
    db.sales.filter(s => s.clientId === id && saldoDe(s.id) > 0).forEach(s => { s.sucursalId = +sucursalId; });
  }
  c.editadoAt = new Date().toISOString(); c.editadoBy = req.user.nombre;
  saveDB();
  res.json({ ok: true, cliente: c });
});
app.post('/api/sales', auth, rol('admin', 'supervisor', 'sucursal'), (req, res) => {
  const { nombre, tel, calle, col, ciudad, estado, curp, sucursalId, prom, tipo, plazo, monto, dias, force, clienteExistenteId, articulos } = req.body;

  let client;
  if (clienteExistenteId) {
    // Agregar un crédito ADICIONAL a un cliente que ya existe (sin duplicar la persona)
    client = db.clients.find(c => c.id === +clienteExistenteId && c.activo !== false);
    if (!client) return res.status(404).json({ error: 'Cliente existente no encontrado' });
    if (req.user.rol === 'sucursal' && client.sucursalId !== req.user.sucursalId)
      return res.status(403).json({ error: `Ese cliente pertenece a otra sucursal. No puedes agregarle créditos desde aquí.` });
  } else {
    if (!nombre || !calle || !col) return res.status(400).json({ error: 'Domicilio (calle y colonia) obligatorio en la venta' });
    const curpNorm = String(curp || '').trim().toUpperCase();
    // Validación por CURP: evita registrar dos veces a la misma persona
    if (curpNorm && !force) {
      if (!/^[A-Z]{4}\d{6}[A-Z0-9]{8}$/.test(curpNorm))
        return res.status(400).json({ error: 'curp_invalida', detalle: 'La CURP no tiene el formato válido (18 caracteres del INE). Verifícala.' });
      const dupC = db.clients.find(c => c.activo !== false && (c.curp || '').trim().toUpperCase() === curpNorm);
      if (dupC) {
        const sucDup = db.sucursales.find(s => s.id === dupC.sucursalId);
        const credAct = db.sales.find(s => s.clientId === dupC.id && saldoDe(s.id) > 0);
        const mismaSuc = String(dupC.sucursalId) === String(sucursalId || req.user.sucursalId || 1);
        return res.status(409).json({
          error: 'cliente_duplicado', porCurp: true,
          detalle: `La CURP ${curpNorm} ya está registrada a nombre de "${dupC.nombre}"${sucDup ? ' (sucursal ' + sucDup.nombre + ')' : ''}.` +
            (credAct ? ` Tiene un crédito ACTIVO ${credAct.folio} con saldo $${Math.round(saldoDe(credAct.id))}${!mismaSuc ? ' en OTRA sucursal' : ''}.` : ' Sin crédito activo.'),
          clienteExistente: { id: dupC.id, nombre: dupC.nombre, sucursalId: dupC.sucursalId, sucursal: sucDup ? sucDup.nombre : null, tieneCreditoActivo: !!credAct, folioActivo: credAct ? credAct.folio : null, otraSucursal: !mismaSuc, mismaSucursal: mismaSuc },
          puedeForzar: req.user.rol === 'admin' || req.user.rol === 'supervisor',
          puedeAgregar: req.user.rol !== 'sucursal' || mismaSuc
        });
      }
    }
    // Validación: teléfono ya ocupado por otro cliente / crédito activo
    const telNorm = String(tel || '').replace(/\D/g, '');
    if (telNorm.length >= 10 && !force) {
      const dup = db.clients.find(c => c.activo !== false && (c.tel || '').replace(/\D/g, '') === telNorm);
      if (dup) {
        const sucDup = db.sucursales.find(s => s.id === dup.sucursalId);
        const credAct = db.sales.find(s => s.clientId === dup.id && saldoDe(s.id) > 0);
        const mismaSuc = String(dup.sucursalId) === String(sucursalId || req.user.sucursalId || 1);
        return res.status(409).json({
          error: 'cliente_duplicado',
          detalle: `El teléfono ${tel} ya pertenece a "${dup.nombre}"${sucDup ? ' (sucursal ' + sucDup.nombre + ')' : ''}.` +
            (credAct ? ` Tiene un crédito ACTIVO ${credAct.folio} con saldo $${Math.round(saldoDe(credAct.id))}${!mismaSuc ? ' en OTRA sucursal' : ''}.` : ' Sin crédito activo.'),
          clienteExistente: { id: dup.id, nombre: dup.nombre, sucursalId: dup.sucursalId, sucursal: sucDup ? sucDup.nombre : null, tieneCreditoActivo: !!credAct, folioActivo: credAct ? credAct.folio : null, otraSucursal: !mismaSuc, mismaSucursal: mismaSuc },
          puedeForzar: req.user.rol === 'admin' || req.user.rol === 'supervisor',
          puedeAgregar: req.user.rol !== 'sucursal' || mismaSuc   // se le puede colgar un 2º crédito
        });
      }
    }
    const sucFinal = req.user.rol === 'sucursal' ? (req.user.sucursalId || 1) : (sucursalId || req.user.sucursalId || 1);
    client = { id: nextId('clients'), nombre, tel: tel || '', calle, col, ciudad: ciudad || '', estado: estado || '', curp: String(curp || '').trim().toUpperCase(), sucursalId: sucFinal, prom: prom || '' };
    db.clients.push(client);
  }

  const r = calcCredito(tipo, +plazo, +monto, +dias);
  const folio = 'F-' + (1100 + nextId('sales'));
  const promFinal = prom || client.prom || '';
  const sucCred = req.user.rol === 'sucursal' ? (req.user.sucursalId || 1) : (clienteExistenteId ? client.sucursalId : (sucursalId || req.user.sucursalId || 1));
  const sale = { id: nextId('sales'), folio, clientId: client.id, tipo, plazo: +plazo, monto: +monto, cuota: r.cuota, total: r.total, prom: promFinal, sucursalId: sucCred, entregado: false, createdAt: new Date().toISOString() };
  const artLimpios = Array.isArray(articulos) ? articulos.map(x => String(x || '').trim()).filter(Boolean).slice(0, 30) : [];
  if (artLimpios.length) sale.articulos = artLimpios;
  if (r.descuentaPP) { sale.primerPago = r.primerPago; sale.descuentaPP = true; sale.entregaMonto = r.entregaCliente; }
  db.sales.push(sale);
  db.movimientos.push({ id: nextId('movimientos'), saleId: sale.id, fecha: fechaMxHoyDDMM(), concepto: 'Disposición de crédito', origen: 'Sucursal', cargo: r.total, abono: 0 });
  // Productos que descuentan el primer pago: se registra de inmediato como abono (el cliente recibe monto − primer pago)
  if (r.descuentaPP && r.primerPago > 0) {
    db.movimientos.push({ id: nextId('movimientos'), saleId: sale.id, fecha: fechaMxHoyDDMM(), concepto: 'Primer pago descontado al inicio', origen: 'Origen del crédito', cargo: 0, abono: r.primerPago, forma: 'descuento', sucursalCobro: sucCred, sucursalCredito: sucCred });
  }
  saveDB();
  const nCreditos = db.sales.filter(s => s.clientId === client.id).length;
  res.status(201).json({ ...sale, saldo: saldoDe(sale.id), cliente: client.nombre, agregadoAExistente: !!clienteExistenteId, totalCreditosCliente: nCreditos });
});

/* ---------- Estado de cuenta (libro de cargos y abonos) ---------- */
app.get('/api/sales/:id/movimientos', auth, (req, res) => {
  const id = +req.params.id;
  let saldo = 0;
  const rows = db.movimientos.filter(m => m.saleId === id).map(m => { saldo += (m.cargo || 0) - (m.abono || 0); return { ...m, saldo }; });
  res.json({ movimientos: rows, saldo });
});

/* ---------- Pago (idempotente, con forma de pago) ---------- */
function calcAtraso(sale){
  const cuota = sale.cuota || 0;
  // ancla del calendario: si hubo reestructura, el reloj se reinicia desde esa fecha
  const anchor = sale.reestructuraAt ? new Date(sale.reestructuraAt) : (sale.createdAt ? new Date(sale.createdAt) : new Date());
  const dias = Math.max(0, Math.floor((Date.now() - anchor.getTime())/86400000));
  let cuotasDebidas = 0;
  if (sale.tipo === 'diario') cuotasDebidas = Math.min(sale.plazo || 0, dias);
  else if (sale.tipo === 'semanal') cuotasDebidas = Math.min(sale.plazo || 0, Math.floor(dias/7));
  else if (sale.tipo === 's16' || sale.tipo === 's17' || sale.tipo === 's21' || sale.tipo === 's31') cuotasDebidas = Math.min(sale.plazo || 0, Math.floor(dias/7));
  else if (sale.tipo === 'unico') cuotasDebidas = dias >= (sale.plazo || 0) ? 1 : 0;
  else if (sale.tipo === 'p17') cuotasDebidas = Math.min(17, Math.floor(dias / ((sale.plazo || 270)/17)));
  // saldo base: total original, o el saldo reprogramado si hubo reestructura
  const saldoBase = sale.saldoBaseReestructura != null ? sale.saldoBaseReestructura : (sale.total || 0);
  const saldoActual = saldoDe(sale.id);
  const expectedSaldo = Math.max(0, saldoBase - cuotasDebidas * cuota);
  const montoAtraso = Math.max(0, saldoActual - expectedSaldo);
  const cuotasAtraso = cuota > 0 ? Math.round(montoAtraso / cuota) : 0;
  const cuotasPagadas = cuota > 0 ? Math.max(0, Math.round((saldoBase - saldoActual)/cuota)) : 0;
  const diasAtraso = sale.tipo === 'diario' ? cuotasAtraso
                   : (sale.tipo === 'semanal' || sale.tipo === 's16' || sale.tipo === 's17' || sale.tipo === 's21' || sale.tipo === 's31') ? cuotasAtraso*7
                   : sale.tipo === 'unico' ? Math.max(0, dias - (sale.plazo||0))
                   : cuotasAtraso * Math.round((sale.plazo||270)/17);
  return { cuotasDebidas, cuotasPagadas, cuotasAtraso, montoAtraso, diasAtraso };
}

app.post('/api/sales/:id/pago', auth, idem, (req, res) => {
  const id = +req.params.id; const { monto, forma } = req.body;
  if (!(monto > 0)) return res.status(400).json({ error: 'Monto inválido' });
  if (forma === 'ajuste' && req.user.rol !== 'admin' && req.user.rol !== 'supervisor') {
    return res.status(403).json({ error: 'Solo administrador o supervisor pueden registrar ajustes' });
  }
  const sale = db.sales.find(s => s.id === id); if (!sale) return res.status(404).json({ error: 'Crédito no encontrado' });
  const f = forma || 'efectivo';
  // No se permite abonar a un crédito ya liquidado ni exceder el saldo (evita saldos negativos).
  if (f !== 'ajuste') {
    const saldoVigente = saldoDe(id);
    if (saldoVigente <= 0) return res.status(409).json({ error: 'Este crédito ya está liquidado (saldo $0). No admite más abonos.' });
    if (+monto > saldoVigente + 1) return res.status(409).json({ error: `El abono ($${Math.round(+monto)}) excede el saldo pendiente. El máximo a pagar es $${Math.round(saldoVigente)}.` });
  }
  // Regla: tras entregar su corte del día, el cobrador no puede registrar más cobros.
  if (req.user.rol === 'cobrador' && corteHechoHoy(req.user.nombre)) {
    return res.status(423).json({ error: 'Ya entregaste tu corte de hoy. No puedes registrar más cobros hasta mañana. Si recibiste dinero después del corte, repórtalo a tu sucursal.' });
  }
  const sidCredito = String(sale.sucursalId || 1);
  // El dinero FÍSICO entra a la caja de QUIEN RECIBE el pago (no a la del crédito).
  const sidCobro = String(req.user.sucursalId || sidCredito);
  db.movimientos.push({ id: nextId('movimientos'), saleId: id, fecha: fechaMxHoyDDMM(), concepto: 'Abono', origen: req.user.nombre, cargo: 0, abono: +monto, forma: f, sucursalCobro: +sidCobro, sucursalCredito: +sidCredito });
  db.caja[sidCobro] = db.caja[sidCobro] || { inicial: 0, efectivo: 0, banco: 0, entregas: 0 };
  if (req.user.rol === 'cobrador') {
    // cobro en ruta: el efectivo NO entra a caja, va a "por entregar" a nombre del cobrador en SU sucursal
    if (f === 'efectivo') {
      let pe = db.porEntregar.find(p => p.prom === req.user.nombre && String(p.sucursalId) === sidCobro);
      if (pe) pe.monto += +monto; else db.porEntregar.push({ id: nextId('porEntregar'), sucursalId: +sidCobro, prom: req.user.nombre, monto: +monto });
    } else if (f === 'transferencia' || f === 'deposito') { db.caja[sidCobro].banco += +monto; }
  } else {
    // ventanilla / admin / supervisor: el dinero entra a la caja de la sucursal que lo recibió
    if (f === 'efectivo') db.caja[sidCobro].efectivo += +monto;
    else if (f === 'transferencia' || f === 'deposito') db.caja[sidCobro].banco += +monto;
  }
  markIdem(req); saveDB();
  res.status(201).json({ ok: true, saldo: saldoDe(id), cobroCruzado: sidCobro !== sidCredito });
});

/* ---------- REFIN: liquida el saldo del crédito viejo y genera uno nuevo ---------- */
app.post('/api/sales/:id/refin', auth, rol('admin','supervisor','sucursal'), idem, (req, res) => {
  const id = +req.params.id;
  const old = db.sales.find(s => s.id === id);
  if (!old) return res.status(404).json({ error: 'Crédito no encontrado' });
  const saldoActual = saldoDe(id);
  if (saldoActual <= 0) return res.status(400).json({ error: 'Este crédito ya está liquidado, no aplica REFIN' });

  const { nuevoMonto, nuevoTipo, nuevoPlazo, nuevoDias, nuevoProm } = req.body;
  const monto = +nuevoMonto;
  if (!monto || monto <= 0) return res.status(400).json({ error: 'Nuevo monto inválido' });
  if (monto < saldoActual) return res.status(400).json({ error: `El nuevo monto ($${monto}) debe ser ≥ al saldo pendiente ($${Math.round(saldoActual)})` });

  const tipo = nuevoTipo || old.tipo || 'semanal';
  const plazo = +nuevoPlazo || old.plazo || 12;
  const prom = nuevoProm || old.prom;
  const r = calcCredito(tipo, plazo, monto, +nuevoDias || plazo);

  const hoy = fechaMxHoyDDMM();
  // 1. liquida el viejo con un abono forma=refin
  db.movimientos.push({
    id: nextId('movimientos'), saleId: id, fecha: hoy,
    concepto: 'Liquidación por REFIN',
    origen: req.user.nombre + ' (REFIN ventanilla)',
    cargo: 0, abono: saldoActual, forma: 'refin'
  });
  // 2. nuevo crédito
  const folio = 'F-' + (1100 + nextId('sales'));
  const nuevo = {
    id: nextId('sales'), folio, clientId: old.clientId,
    tipo, plazo, monto, cuota: r.cuota, total: r.total,
    prom, sucursalId: old.sucursalId,
    refinDe: old.id, entregado: true,
    createdAt: new Date().toISOString(), createdBy: req.user.nombre,
  };
  if (r.descuentaPP) { nuevo.primerPago = r.primerPago; nuevo.descuentaPP = true; nuevo.entregaMonto = r.entregaCliente; }
  db.sales.push(nuevo);
  // 3. disposición del nuevo crédito
  db.movimientos.push({
    id: nextId('movimientos'), saleId: nuevo.id, fecha: hoy,
    concepto: `Disposición REFIN (descuenta $${Math.round(saldoActual)} del crédito ${old.folio})`,
    origen: 'Sucursal: ' + req.user.nombre,
    cargo: r.total, abono: 0
  });
  // 3b. primer pago descontado al inicio (no se considera cobranza; forma=descuento)
  if (r.descuentaPP && r.primerPago > 0) {
    db.movimientos.push({ id: nextId('movimientos'), saleId: nuevo.id, fecha: hoy, concepto: 'Primer pago descontado al inicio', origen: 'Origen del crédito (REFIN)', cargo: 0, abono: r.primerPago, forma: 'descuento', sucursalCobro: old.sucursalId, sucursalCredito: old.sucursalId });
  }

  const primerPago = (r.descuentaPP && r.primerPago > 0) ? r.primerPago : 0;
  const neto = monto - saldoActual - primerPago;
  markIdem(req); saveDB();
  res.status(201).json({
    ok: true,
    oldFolio: old.folio, saldoLiquidado: saldoActual,
    nuevoFolio: nuevo.folio, nuevoSaleId: nuevo.id,
    nuevoMonto: monto, nuevoTotal: r.total, nuevoCuota: r.cuota, primerPago,
    saldoNuevo: saldoDe(nuevo.id), neto
  });
});

/* ---------- Reestructura: cambia el modelo de pago + cargo, SIN liquidar (no genera ingreso ficticio) ---------- */
app.post('/api/sales/:id/reestructura', auth, rol('admin', 'supervisor'), (req, res) => {
  const id = +req.params.id;
  const sale = db.sales.find(s => s.id === id);
  if (!sale) return res.status(404).json({ error: 'Crédito no encontrado' });
  const saldoActual = saldoDe(id);
  if (saldoActual <= 0) return res.status(400).json({ error: 'Este crédito ya está liquidado, no aplica reestructura' });

  const { nuevoTipo, nuevoPlazo, cargoExtra, motivo } = req.body;
  const tipo = nuevoTipo || sale.tipo;
  const plazo = +nuevoPlazo;
  const cargo = Math.max(0, +cargoExtra || 0);
  if (!plazo || plazo <= 0) return res.status(400).json({ error: 'Plazo inválido' });

  const hoy = fechaMxHoyDDMM();
  // 1. cargo real sobre el saldo insoluto (NO es abono, no infla cobranza)
  if (cargo > 0) {
    db.movimientos.push({
      id: nextId('movimientos'), saleId: id, fecha: hoy,
      concepto: 'Cargo por reestructura' + (motivo ? ' — ' + motivo : ''),
      origen: 'Supervisor: ' + req.user.nombre,
      cargo: cargo, abono: 0, forma: 'reestructura'
    });
  }
  // 2. nuevo saldo base y cuota reprogramada (sin factor: se reparte el saldo insoluto + cargo)
  const nuevoSaldoBase = saldoActual + cargo;
  const nuevaCuota = Math.round(nuevoSaldoBase / plazo);
  // 3. cambia el modelo EN EL MISMO crédito; reinicia el reloj del calendario
  const tipoAnt = sale.tipo, plazoAnt = sale.plazo, cuotaAnt = sale.cuota;
  sale.tipo = tipo; sale.plazo = plazo; sale.cuota = nuevaCuota;
  sale.saldoBaseReestructura = nuevoSaldoBase;
  sale.reestructuraAt = new Date().toISOString();
  sale.historialReestructura = sale.historialReestructura || [];
  sale.historialReestructura.push({
    fecha: sale.reestructuraAt, por: req.user.nombre,
    de: { tipo: tipoAnt, plazo: plazoAnt, cuota: cuotaAnt },
    a: { tipo, plazo, cuota: nuevaCuota }, cargo, saldoAntes: saldoActual, motivo: motivo || ''
  });
  saveDB();
  res.json({
    ok: true, folio: sale.folio,
    saldoAntes: saldoActual, cargo, nuevoSaldo: saldoDe(id),
    de: { tipo: tipoAnt, plazo: plazoAnt, cuota: cuotaAnt },
    a: { tipo, plazo, cuota: nuevaCuota }
  });
});

/* ---------- Supervisor: cargo / abono / condonación ---------- */
app.post('/api/sales/:id/cargo', auth, rol('admin', 'supervisor'), idem, (req, res) => {
  const id = +req.params.id; const { monto, concepto } = req.body;
  db.movimientos.push({ id: nextId('movimientos'), saleId: id, fecha: fechaMxHoyDDMM(), concepto: concepto || 'Cargo manual', origen: 'Supervisor: ' + req.user.nombre, cargo: +monto, abono: 0 });
  markIdem(req); saveDB(); res.json({ ok: true, saldo: saldoDe(id) });
});
app.post('/api/sales/:id/abono', auth, rol('admin', 'supervisor'), idem, (req, res) => {
  const id = +req.params.id;
  db.movimientos.push({ id: nextId('movimientos'), saleId: id, fecha: fechaMxHoyDDMM(), concepto: 'Abono manual', origen: 'Supervisor: ' + req.user.nombre, cargo: 0, abono: +req.body.monto });
  markIdem(req); saveDB(); res.json({ ok: true, saldo: saldoDe(id) });
});
app.post('/api/sales/:id/condonar', auth, rol('admin', 'supervisor'), idem, (req, res) => {
  const id = +req.params.id;
  db.movimientos.push({ id: nextId('movimientos'), saleId: id, fecha: fechaMxHoyDDMM(), concepto: 'Condonación: ' + (req.body.motivo || 'ajuste'), origen: 'Supervisor: ' + req.user.nombre, cargo: 0, abono: +req.body.monto });
  markIdem(req); saveDB(); res.json({ ok: true, saldo: saldoDe(id) });
});
app.post('/api/sales/:id/aplicar-mora', auth, (req, res) => {
  const id = +req.params.id; const monto = +req.body.monto || 25;
  db.movimientos.push({ id: nextId('movimientos'), saleId: id, fecha: fechaMxHoyDDMM(), concepto: 'Moratorio automático', origen: 'Sistema', cargo: monto, abono: 0, auto: true });
  saveDB(); res.json({ ok: true, saldo: saldoDe(id) });
});

/* ---------- Caja de sucursal ---------- */
app.get('/api/caja/hoy', auth, (req, res) => {
  const sid = String(req.user.sucursalId || req.query.sucursalId || 1);
  const c = db.caja[sid] || { inicial: 0, efectivo: 0, banco: 0, entregas: 0 };
  const pe = db.porEntregar.filter(p => String(p.sucursalId) === sid);
  res.json({ caja: c, efectivoReal: c.inicial + c.efectivo + c.entregas - (c.retiros||0), porEntregar: pe });
});
app.post('/api/caja/entrega', auth, (req, res) => {
  const pe = db.porEntregar.find(p => p.id == req.body.porEntregarId);
  if (!pe) return res.status(404).json({ error: 'No encontrado' });
  const sid = String(pe.sucursalId); db.caja[sid] = db.caja[sid] || { inicial: 0, efectivo: 0, banco: 0, entregas: 0 };
  db.caja[sid].entregas += pe.monto;
  db.porEntregar = db.porEntregar.filter(p => p.id !== pe.id);
  saveDB(); res.json({ ok: true });
});

/* ---------- Cobrador en ruta ---------- */
app.get('/api/mi-ruta', auth, (req, res) => {
  const ventas = db.sales.filter(s => s.prom === req.user.nombre && s.entregado !== false);
  const hoy = fechaMxHoyDDMM();
  res.json(ventas.map(s => {
    const c = db.clients.find(x => x.id === s.clientId) || {};
    if (c.activo === false) return null;
    const totalAbonado = db.movimientos.filter(m => m.saleId === s.id && m.abono > 0).reduce((a,m)=>a+m.abono,0);
    const at = calcAtraso(s, totalAbonado);
    // Lo que ESTE cobrador cobró hoy a este cliente (para que su panel no se reinicie al re-entrar)
    const movsHoy = db.movimientos.filter(m => m.saleId === s.id && m.abono > 0 && m.forma !== 'descuento' && m.fecha === hoy && m.origen === req.user.nombre);
    const cobradoHoy = movsHoy.reduce((a,m)=>a+m.abono,0);
    const formaHoy = movsHoy.length ? (movsHoy[movsHoy.length-1].forma || 'efectivo') : null;
    return { id: s.id, folio: s.folio, nombre: c.nombre || '—', dir: [c.calle, c.col].filter(Boolean).join(', '), tel: c.tel || '', tipo: s.tipo, cuota: s.cuota, saldo: saldoDe(s.id),
      cobradoHoy, formaHoy,
      atraso: at.montoAtraso, diasAtraso: at.diasAtraso, cuotasAtraso: at.cuotasAtraso, cuotasDebidas: at.cuotasDebidas, cuotasPagadas: at.cuotasPagadas, tieneEvidencia: !!s.entrega };
  }).filter(Boolean));
});
// Evidencias de entrega del cobrador (incluye clientes dados de baja)
app.get('/api/mi-evidencias', auth, rol('cobrador'), (req, res) => {
  const out = db.sales.filter(s => s.prom === req.user.nombre && s.entrega).map(s => {
    const c = db.clients.find(x => x.id === s.clientId) || {};
    return { saleId: s.id, folio: s.folio, cliente: c.nombre || '—', activo: c.activo !== false, fecha: s.entrega.fecha };
  }).sort((a, b) => (b.fecha || '').localeCompare(a.fecha || ''));
  res.json(out);
});
app.get('/api/cobradores', auth, (req, res) => {
  const sucMap = {}; db.sucursales.forEach(s => sucMap[s.id] = s.nombre);
  // Una encargada de sucursal solo ve a SUS cobradores (los dados de alta en su sucursal).
  const esSucursal = req.user.rol === 'sucursal';
  const users = db.users.filter(u => u.rol === 'cobrador' && u.activo && (!esSucursal || u.sucursalId === req.user.sucursalId));
  const lista = users.map(u => ({ id: u.id, nombre: u.nombre, sucursal: sucMap[u.sucursalId] || null, esUsuario: true }));
  if (req.query.conCartera && !esSucursal) {
    const activos = new Set(db.clients.filter(c => c.activo !== false).map(c => c.id));
    const nombresUsuario = new Set(users.map(u => u.nombre));
    const promsCartera = {};
    db.sales.filter(s => activos.has(s.clientId) && saldoDe(s.id) > 0 && s.prom).forEach(s => {
      if (nombresUsuario.has(s.prom)) return;
      promsCartera[s.prom] = promsCartera[s.prom] || { nombre: s.prom, sucursal: sucMap[s.sucursalId] || null, clientes: new Set() };
      promsCartera[s.prom].clientes.add(s.clientId);
    });
    Object.values(promsCartera).forEach(p => lista.push({ nombre: p.nombre, sucursal: p.sucursal, esUsuario: false, nClientes: p.clientes.size }));
  }
  lista.sort((a, b) => (a.nombre || '').localeCompare(b.nombre || ''));
  res.json(lista);
});
app.post('/api/sales/:id/gestion', auth, idem, (req, res) => {
  db.gestiones.push({ id: nextId('gestiones'), saleId: +req.params.id, fecha: new Date().toISOString(), tipo: req.body.tipo || 'nopago', detalle: req.body.detalle || '', por: req.user.nombre });
  markIdem(req); saveDB(); res.json({ ok: true });
});

/* ---------- Dashboard agregado ---------- */
function _parseFechaMx(s){ if(!s) return 0; const [d,m,y]=s.split('/'); return new Date(+y,+m-1,+d).getTime(); }
function _desdePeriodo(periodo){
  const now=new Date();
  if(periodo==='hoy') return new Date(now.getFullYear(),now.getMonth(),now.getDate()).getTime();
  if(periodo==='mes') return new Date(now.getFullYear(),now.getMonth(),1).getTime();
  // semana: usa el día de inicio configurable (ciclo de la agencia)
  return _inicioCiclo(Date.now());
}
app.get('/api/dashboard', auth, (req,res)=>{
  const periodo=req.query.periodo||'semana';
  const desde=_desdePeriodo(periodo);
  const miSuc = (req.user.rol==='sucursal') ? Number(req.user.sucursalId||0) : null;
  const activeClients=db.clients.filter(c=>c.activo!==false);
  const activeClientIds=new Set(activeClients.map(c=>c.id));
  const sales=db.sales.filter(s=>activeClientIds.has(s.clientId) && s.entregado!==false && (miSuc==null || s.sucursalId===miSuc)), clients=activeClients, sucursales=db.sucursales.filter(s=>s.activo!==false && (miSuc==null || s.id===miSuc));
  const _saleIds=new Set(sales.map(s=>s.id));
  const abonos=db.movimientos.filter(m=>m.abono>0 && _parseFechaMx(m.fecha)>=desde && _saleIds.has(m.saleId));
  const nuevos=sales.filter(s=>s.createdAt && new Date(s.createdAt).getTime()>=desde);
  // atraso acumulado por sale
  function atrasoDe(s){
    const totAb=db.movimientos.filter(m=>m.saleId===s.id && m.abono>0).reduce((a,m)=>a+m.abono,0);
    return calcAtraso(s,totAb);
  }
  const por_sucursal=sucursales.map(suc=>{
    const ventas_suc=sales.filter(s=>s.sucursalId===suc.id);
    const abonos_suc=abonos.filter(m=>{ const s=sales.find(x=>x.id===m.saleId); return s && s.sucursalId===suc.id; });
    const recuperado=abonos_suc.reduce((a,m)=>a+m.abono,0);
    const comisionable=abonos_suc.filter(m=>m.forma!=='descuento').reduce((a,m)=>a+m.abono,0);
    const nuevos_suc=nuevos.filter(s=>s.sucursalId===suc.id);
    const caja=db.caja[String(suc.id)]||{inicial:0,efectivo:0,banco:0,entregas:0};
    const enc=db.users.find(u=>u.rol==='sucursal' && u.sucursalId===suc.id);
    let atraso_monto=0, atraso_clientes=0, esperado_acum=0;
    ventas_suc.forEach(s=>{ if(saldoDe(s.id)<=0)return; const at=atrasoDe(s); esperado_acum+=at.cuotasDebidas*s.cuota; if(at.montoAtraso>0){ atraso_monto+=at.montoAtraso; atraso_clientes++; } });
    // Clientes sin pago en el periodo (riesgo): vigente, no único, no nuevo del periodo, sin abono en el periodo
    const pagaronSuc=new Set(abonos_suc.map(m=>{const s=sales.find(x=>x.id===m.saleId); return s?s.clientId:null;}).filter(v=>v!=null));
    const nopagoSuc=new Set();
    ventas_suc.forEach(s=>{ if(saldoDe(s.id)<=0||s.tipo==='unico')return; const ct=s.createdAt?new Date(s.createdAt).getTime():0; if(ct>=desde)return; if(!pagaronSuc.has(s.clientId)) nopagoSuc.add(s.clientId); });
    return {id:suc.id, nombre:suc.nombre, encargada:enc?enc.nombre:'—',
      pagos_recibidos:recuperado, comisionable, npagos:abonos_suc.length, nopago:nopagoSuc.size,
      creditos_captados:nuevos_suc.length, colocado:nuevos_suc.reduce((a,s)=>a+s.monto,0),
      efectivo_caja:(caja.inicial||0)+(caja.efectivo||0)+(caja.entregas||0)-(caja.retiros||0), banco:caja.banco||0,
      por_entregar:db.porEntregar.filter(p=>p.sucursalId===suc.id).reduce((a,p)=>a+p.monto,0),
      cartera:ventas_suc.reduce((a,s)=>a+saldoDe(s.id),0), creditos:ventas_suc.length,
      atraso_monto, atraso_clientes, esperado_acum };
  });
  const cobradores=db.users.filter(u=>u.rol==='cobrador'&&u.activo && (miSuc==null || Number(u.sucursalId)===miSuc));
  const por_cobrador=cobradores.map(c=>{
    const sus_sales=sales.filter(s=>s.prom===c.nombre);
    const sus_abonos=abonos.filter(m=>{ const s=sales.find(x=>x.id===m.saleId); return s && s.prom===c.nombre; });
    const recuperado=sus_abonos.reduce((a,m)=>a+m.abono,0);
    const comisionable=sus_abonos.filter(m=>m.forma!=='descuento').reduce((a,m)=>a+m.abono,0);
    const cartera=sus_sales.reduce((a,s)=>a+saldoDe(s.id),0);
    const por_entregar=db.porEntregar.filter(p=>p.prom===c.nombre).reduce((a,p)=>a+p.monto,0);
    const suc=sucursales.find(s=>s.id===c.sucursalId);
    let atraso_monto=0, atraso_clientes=0, esperado_acum=0;
    sus_sales.forEach(s=>{ if(saldoDe(s.id)<=0)return; const at=atrasoDe(s); esperado_acum+=at.cuotasDebidas*s.cuota; if(at.montoAtraso>0){ atraso_monto+=at.montoAtraso; atraso_clientes++; } });
    // Clientes sin pago en el periodo (riesgo): vigente, no único, no nuevo del periodo, sin abono en el periodo
    const pagaronCob=new Set(sus_abonos.map(m=>{const s=sales.find(x=>x.id===m.saleId); return s?s.clientId:null;}).filter(v=>v!=null));
    const nopagoCob=new Set();
    sus_sales.forEach(s=>{ if(saldoDe(s.id)<=0||s.tipo==='unico')return; const ct=s.createdAt?new Date(s.createdAt).getTime():0; if(ct>=desde)return; if(!pagaronCob.has(s.clientId)) nopagoCob.add(s.clientId); });
    // Ranking + objetivos al 100%: unidades nuevas del periodo, débito esperado, clientes vigentes y clientes cobrados
    const unidades = nuevos.filter(s=>s.prom===c.nombre).length;
    const vigentes = sus_sales.filter(s=>saldoDe(s.id)>0);
    const debito = vigentes.reduce((a,s)=>a+(s.cuota||0),0);
    const clientes_vigentes = new Set(vigentes.map(s=>s.clientId)).size;
    const clientes_cobrados = pagaronCob.size;
    const pct_cob = debito>0 ? Math.round(comisionable/debito*100) : 0;
    // Crecimiento de clientes en el periodo: altas (créditos nuevos) − bajas (liquidados en el periodo)
    let bajas=0;
    sus_sales.forEach(s=>{
      const ms=db.movimientos.filter(m=>m.saleId===s.id);
      const saldoIni=ms.filter(m=>_parseFechaMx(m.fecha)<desde).reduce((a,m)=>a+(m.cargo||0)-(m.abono||0),0);
      if(saldoIni>0.5 && saldoDe(s.id)<=0.5) bajas++;
    });
    const crecimiento = unidades - bajas;
    return {id:c.id, nombre:c.nombre, sucursal:suc?suc.nombre:'—', sucursalId:c.sucursalId,
      clientes:sus_sales.length, cartera, pagos_recibidos:recuperado, comisionable, npagos:sus_abonos.length, nopago:nopagoCob.size, por_entregar,
      unidades, debito, clientes_vigentes, clientes_cobrados, pct_cob, bajas, crecimiento,
      atraso_monto, atraso_clientes, esperado_acum };
  });
  const pagos_recientes=abonos.slice(-40).reverse().map(m=>{
    const s=sales.find(x=>x.id===m.saleId)||{}; const c=clients.find(x=>x.id===s.clientId)||{};
    const suc=sucursales.find(x=>x.id===s.sucursalId);
    return {fecha:m.fecha, cliente:c.nombre||'—', folio:s.folio, prom:s.prom||'—', forma:m.forma||'efectivo', monto:m.abono, sucursal:suc?suc.nombre:'—'};
  });
  const totales={
    creditos_activos: sales.filter(s=>saldoDe(s.id)>0).length,
    creditos_totales: sales.length,
    monto_colocado_total: sales.reduce((a,s)=>a+s.monto,0),
    saldo_pendiente: sales.reduce((a,s)=>a+saldoDe(s.id),0),
    recuperado_periodo: abonos.reduce((a,m)=>a+m.abono,0),
    npagos_periodo: abonos.length,
    nuevos_creditos_periodo: nuevos.length,
    monto_colocado_periodo: nuevos.reduce((a,s)=>a+s.monto,0),
    cobrado_periodo: abonos.filter(m=>m.forma!=='descuento').reduce((a,m)=>a+m.abono,0),
    utilidad_periodo: Math.round(abonos.filter(m=>m.forma!=='descuento').reduce((a,m)=>{ const s=sales.find(x=>x.id===m.saleId); return a + (s&&s.total>0 ? m.abono*((s.total-s.monto)/s.total) : 0); },0)),
    en_caja_efectivo: (miSuc==null?Object.values(db.caja):[db.caja[String(miSuc)]||{}]).reduce((a,c)=>a+((c.inicial||0)+(c.efectivo||0)+(c.entregas||0)-(c.retiros||0)),0),
    en_caja_banco: (miSuc==null?Object.values(db.caja):[db.caja[String(miSuc)]||{}]).reduce((a,c)=>a+(c.banco||0),0),
    por_entregar: db.porEntregar.filter(p=>miSuc==null||p.sucursalId===miSuc).reduce((a,p)=>a+p.monto,0),
    atraso_total: por_cobrador.reduce((a,c)=>a+c.atraso_monto,0),
    clientes_atrasados: por_cobrador.reduce((a,c)=>a+c.atraso_clientes,0),
  };
  res.json({periodo, desde:new Date(desde).toISOString(), totales, por_sucursal, por_cobrador, pagos_recientes});
});
app.get('/api/reports/pagos', auth, (req,res)=>{
  const {desde,hasta,forma,prom,sucursalId}=req.query;
  const t1=desde?new Date(desde).getTime():0, t2=hasta?new Date(hasta).getTime():Number.MAX_SAFE_INTEGER;
  const out=db.movimientos.filter(m=>m.abono>0).filter(m=>{
    const t=_parseFechaMx(m.fecha); if(!(t>=t1&&t<=t2)) return false;
    const s=db.sales.find(x=>x.id===m.saleId)||{};
    if(forma && (m.forma||'efectivo')!==forma) return false;
    if(prom && s.prom!==prom) return false;
    if(sucursalId && String(s.sucursalId)!==String(sucursalId)) return false;
    return true;
  }).map(m=>{
    const s=db.sales.find(x=>x.id===m.saleId)||{}; const c=db.clients.find(x=>x.id===s.clientId)||{};
    const suc=db.sucursales.find(x=>x.id===s.sucursalId);
    return {fecha:m.fecha, cliente:c.nombre||'—', folio:s.folio, prom:s.prom||'—', forma:m.forma||'efectivo', monto:m.abono, sucursal:suc?suc.nombre:'—', sucursalId:s.sucursalId};
  });
  res.json(out);
});

/* ---------- No pagos (riesgo): un crédito tiene "cobro esperado" hoy / esta semana ---------- */
// Fechas programadas de cobro para semanal / celulares-17 (los diarios se evalúan por rango).
function _fechasProgSrv(s){
  const out=[]; const P=s.plazo||0; if(!s.createdAt) return out; const created=new Date(s.createdAt);
  const semanal = (s.tipo==='semanal'||s.tipo==='s16'||s.tipo==='s17'||s.tipo==='s21'||s.tipo==='s31');
  if(semanal){ for(let i=1;i<=P;i++){ const d=new Date(created); d.setDate(d.getDate()+i*7); out.push(d.getTime()); } }
  else if(s.tipo==='p17'){ const iv=Math.max(1,Math.round((P||270)/17)); for(let i=1;i<=17;i++){ const d=new Date(created); d.setDate(d.getDate()+i*iv); out.push(d.getTime()); } }
  return out;
}
// ¿Se esperaba un cobro de este crédito en el día [dStart,dEnd)? (no cuenta la venta nueva del día)
function _esperaCobroDia(s, dStart, dEnd){
  const c = s.createdAt ? new Date(s.createdAt).getTime() : 0;
  if(!c || c >= dStart) return false;                       // creado hoy o después: es venta nueva, no se le exige cobro hoy
  if(s.tipo==='unico'){ const d=new Date(s.createdAt); d.setDate(d.getDate()+(s.plazo||0)); const t=d.getTime(); return t>=dStart && t<dEnd; }
  if(s.tipo==='diario'){
    if(new Date(dStart).getDay()===0) return false;         // domingo: no se cobra (cuadra con débito = cuota x 6)
    const fin=new Date(s.createdAt); fin.setDate(fin.getDate()+(s.plazo||0));
    return dStart <= fin.getTime();                         // dentro del plazo
  }
  // semanal / cel-17: solo el día que les toca
  return _fechasProgSrv(s).some(t=> t>=dStart && t<dEnd);
}

/* ---------- Números diarios (scoreboard de cobranza por gerencia/sucursal) ---------- */
app.get('/api/reports/numeros-diarios', auth, rol('admin','supervisor'), (req,res)=>{
  const diaISO = req.query.dia || fechaMxHoyISO();
  const dStart = new Date(diaISO+'T00:00:00').getTime();
  const dEnd = dStart + 86400000;
  const inicioDia = (req.query.inicio!=null && req.query.inicio!=='') ? Math.min(6,Math.max(0,+req.query.inicio)) : _diaSemanaInicio();
  const wkStart = _inicioCiclo(dStart, inicioDia);
  const wkFinTs = wkStart + 7*86400000;            // fin (exclusivo) del ciclo completo
  // Acumulado = toda la semana transcurrida hasta HOY (o la semana completa si es pasada). NO se corta por el día elegido.
  const wkEnd = Math.min(Date.now(), wkFinTs);
  const wkFin = wkFinTs - 1;                        // para mostrar "Termina"
  const activos = new Set(db.clients.filter(c=>c.activo!==false).map(c=>c.id));
  const sales = db.sales.filter(s=>activos.has(s.clientId) && s.entregado!==false);
  const sucursales = db.sucursales.filter(s=>s.activo!==false);
  const abonos = db.movimientos.filter(m=>m.abono>0 && m.forma!=='descuento');
  const saleSuc = {}; sales.forEach(s=>{ saleSuc[s.id]={suc:s.sucursalId, cli:s.clientId}; });
  // Avance de contactos (no pagos de la semana inmediata anterior) — para que admin/supervisor lo vean aquí
  const prevIso = _isoDe(_inicioCiclo(wkStart - 86400000, inicioDia));
  const contactosPrev = _listaContactos(prevIso);
  const _avSuc = sid => { const r=contactosPrev.filter(x=>x.sucursalId===sid); return { total:r.length, gestionados:r.filter(x=>x.gestion&&(x.gestion.resultado||x.gestion.tieneEvidencia)).length, validados:r.filter(x=>x.gestion&&x.gestion.validado).length }; };
  const rows = sucursales.map(suc=>{
    const activeVs = sales.filter(s=>s.sucursalId===suc.id && saldoDe(s.id)>0);
    const clientes_totales = new Set(activeVs.map(s=>s.clientId)).size;
    const debito_total = activeVs.reduce((a,s)=>a+(s.cuota||0),0);
    let diaColl=0, acumColl=0; const diaCli=new Set(), acumCli=new Set();
    for(const m of abonos){ const ref=saleSuc[m.saleId]; if(!ref||ref.suc!==suc.id) continue; const t=_parseFechaMx(m.fecha);
      if(t>=wkStart && t<wkEnd){ acumColl+=m.abono; acumCli.add(ref.cli); }
      if(t>=dStart && t<dEnd){ diaColl+=m.abono; diaCli.add(ref.cli); } }
    // No pagos (riesgo): clientes con cobro esperado que NO abonaron (día y acumulado de la semana)
    const espDia=new Set(), espSem=new Set();
    activeVs.forEach(s=>{
      const ct = s.createdAt ? new Date(s.createdAt).getTime() : 0;
      if(_esperaCobroDia(s, dStart, dEnd)) espDia.add(s.clientId);
      if(s.tipo!=='unico' && !(ct>=wkStart && ct<wkEnd)) espSem.add(s.clientId); // esperado en la semana (= reporte semanal)
    });
    const dia_nopago=[...espDia].filter(id=>!diaCli.has(id)).length;
    const acum_nopago=[...espSem].filter(id=>!acumCli.has(id)).length;
    return { id:suc.id, gerencia:suc.nombre, clientes_totales, debito_total,
      dia_clientes:diaCli.size, dia_coll:diaColl, dia_nopago,
      acum_clientes:acumCli.size, acum_coll:acumColl, acum_nopago,
      contactos:_avSuc(suc.id),
      objetivo: db.objetivos.suc[String(suc.id)] || null };
  });
  const total = rows.reduce((a,r)=>({clientes_totales:a.clientes_totales+r.clientes_totales, debito_total:a.debito_total+r.debito_total, dia_clientes:a.dia_clientes+r.dia_clientes, dia_coll:a.dia_coll+r.dia_coll, dia_nopago:a.dia_nopago+r.dia_nopago, acum_clientes:a.acum_clientes+r.acum_clientes, acum_coll:a.acum_coll+r.acum_coll, acum_nopago:a.acum_nopago+r.acum_nopago, contactos:{total:a.contactos.total+r.contactos.total, gestionados:a.contactos.gestionados+r.contactos.gestionados, validados:a.contactos.validados+r.contactos.validados}}), {clientes_totales:0,debito_total:0,dia_clientes:0,dia_coll:0,dia_nopago:0,acum_clientes:0,acum_coll:0,acum_nopago:0,contactos:{total:0,gestionados:0,validados:0}});
  res.json({ dia:diaISO, semanaInicioDia:inicioDia, semanaDesdeISO:_isoDe(wkStart), semanaHastaISO:_isoDe(wkFin), semanaDesde:new Date(wkStart).toISOString(), semanaContactos:prevIso, rows, total });
});

/* ---------- Objetivos (metas por sucursal y por cobrador) ---------- */
app.get('/api/objetivos', auth, (req,res)=>{
  res.json({ suc: db.objetivos.suc || {}, cob: db.objetivos.cob || {} });
});
app.post('/api/objetivos/suc', auth, rol('admin','supervisor'), (req,res)=>{
  const { sucursalId, clientes, debito } = req.body;
  const sid = String(sucursalId);
  if(!db.sucursales.find(s=>String(s.id)===sid)) return res.status(404).json({ error:'Sucursal no encontrada' });
  db.objetivos.suc[sid] = { clientes: Math.max(0, +clientes||0), debito: Math.max(0, +debito||0), actualizado: new Date().toISOString() };
  saveDB(); res.json({ ok:true, objetivo: db.objetivos.suc[sid] });
});
app.post('/api/objetivos/cob', auth, rol('admin','supervisor','sucursal'), (req,res)=>{
  const { cobrador, clientes, cobranza } = req.body;
  const nombre = String(cobrador||'').trim();
  if(!nombre) return res.status(400).json({ error:'Falta el cobrador' });
  const u = db.users.find(x=>x.rol==='cobrador' && x.nombre===nombre);
  if(!u) return res.status(404).json({ error:'Cobrador no encontrado' });
  if(req.user.rol==='sucursal' && Number(u.sucursalId)!==Number(req.user.sucursalId)) return res.status(403).json({ error:'Ese cobrador no es de tu sucursal' });
  db.objetivos.cob[nombre] = { clientes: Math.max(0, +clientes||0), cobranza: Math.max(0, +cobranza||0), actualizado: new Date().toISOString() };
  saveDB(); res.json({ ok:true, objetivo: db.objetivos.cob[nombre] });
});

/* ---------- CONTACTOS: clientes que NO pagaron la semana inmediata anterior ---------- */
// Día de inicio de semana configurable por agencia (0=dom..6=sáb; default 4=jueves → ciclo jue→mié)
function _diaSemanaInicio(){ const c=db.config&&db.config.semanaInicio; return (c==null?4:Math.min(6,Math.max(0,+c))); }
function _isoDe(ts){ const d=new Date(ts); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; }
// Inicio (00:00 hora local) de la semana-ciclo que contiene refTs, según el día de inicio
function _inicioCiclo(refTs, inicioDia){
  inicioDia = (inicioDia==null) ? _diaSemanaInicio() : Math.min(6,Math.max(0,+inicioDia));
  const d=new Date(refTs); const base=new Date(d.getFullYear(),d.getMonth(),d.getDate());
  const diff=((base.getDay()-inicioDia)+7)%7;
  base.setDate(base.getDate()-diff);
  return base.getTime();
}
// Límites de la semana (ciclo) que contiene refTs
function _semanaCiclo(refTs, inicioDia){
  const start=_inicioCiclo(refTs, inicioDia);
  const endD=new Date(start); endD.setDate(endD.getDate()+7);
  return { start, end:endD.getTime(), iso:_isoDe(start) };
}
function _semanaDesdeISO(iso){ const [y,mo,d]=iso.split('-').map(Number); const start=new Date(y,mo-1,d); start.setHours(0,0,0,0); const end=new Date(start); end.setDate(end.getDate()+7); return { start:start.getTime(), end:end.getTime(), iso }; }
// ISO de inicio de la semana inmediata anterior a hoy (según el ciclo configurado)
function _semanaAnteriorISO(){ const ini=_inicioCiclo(Date.now()); return _isoDe(_inicioCiclo(ini-86400000)); }
// Última fecha de pago (dd/mm/aaaa) del cliente, o null
function _ultimaFechaPago(clientId){
  const ids=new Set(db.sales.filter(s=>s.clientId===clientId).map(s=>s.id));
  let best=0, str=null;
  for(const m of db.movimientos){ if(m.abono>0 && ids.has(m.saleId)){ const t=_parseFechaMx(m.fecha); if(t>best){ best=t; str=m.fecha; } } }
  return str;
}
// Lista de clientes que NO pagaron en la semana (iso). Se une con la gestión guardada.
function _listaContactos(iso){
  const wb=_semanaDesdeISO(iso);
  const activos=new Set(db.clients.filter(c=>c.activo!==false).map(c=>c.id));
  const sales=db.sales.filter(s=>activos.has(s.clientId) && s.entregado!==false && saldoDe(s.id)>0);
  const saleCli={}; sales.forEach(s=>saleCli[s.id]=s.clientId);
  const pagoSemana=new Set();
  for(const m of db.movimientos){ if(m.abono>0 && saleCli[m.saleId]!=null){ const t=_parseFechaMx(m.fecha); if(t>=wb.start && t<wb.end) pagoSemana.add(saleCli[m.saleId]); } }
  const espCli=new Map();
  sales.forEach(s=>{ if(s.tipo==='unico')return; const ct=s.createdAt?new Date(s.createdAt).getTime():0; if(ct>=wb.end)return; if(!espCli.has(s.clientId)) espCli.set(s.clientId, s); });
  const rows=[];
  espCli.forEach((s,clientId)=>{
    if(pagoSemana.has(clientId)) return; // sí pagó esa semana → no es contacto
    const c=db.clients.find(x=>x.id===clientId)||{};
    let atraso=0; db.sales.filter(x=>x.clientId===clientId && saldoDe(x.id)>0).forEach(x=>{ atraso+=calcAtraso(x).montoAtraso; });
    const rec=db.contactos.find(k=>k.semana===iso && k.clientId===clientId)||null;
    rows.push({ clientId, saleId:s.id, sucursalId:s.sucursalId, cobrador:s.prom||'—',
      nombre:c.nombre||'—', direccion:[c.calle,c.col,c.ciudad].filter(Boolean).join(', '), tel:c.tel||'',
      monto_atraso:Math.round(atraso), ultima_fecha_pago:_ultimaFechaPago(clientId),
      gestion: rec? { id:rec.id, resultado:rec.resultado||'', nota:rec.nota||'', tieneEvidencia:!!rec.evidencia, por:rec.por||null, fecha:rec.fecha||null, validado:!!rec.validado, validadoPor:rec.validadoPor||null, validadoFecha:rec.validadoFecha||null } : null });
  });
  return rows;
}
// Resumen de avance (total / gestionados / validados) opcionalmente por sucursal
function _avanceContactos(iso, sucursalId){
  let rows=_listaContactos(iso);
  if(sucursalId!=null) rows=rows.filter(r=>r.sucursalId===sucursalId);
  const total=rows.length;
  const gestionados=rows.filter(r=>r.gestion && (r.gestion.resultado || r.gestion.tieneEvidencia)).length;
  const validados=rows.filter(r=>r.gestion && r.gestion.validado).length;
  return { total, gestionados, validados };
}
// Listado de contactos (sucursal ve los suyos; admin/supervisor todos)
app.get('/api/contactos', auth, rol('admin','supervisor','sucursal','cobrador'), (req,res)=>{
  const iso = req.query.semana || _semanaAnteriorISO();
  let rows=_listaContactos(iso);
  if(req.user.rol==='sucursal') rows=rows.filter(r=>Number(r.sucursalId)===Number(req.user.sucursalId));
  else if(req.user.rol==='cobrador') rows=rows.filter(r=>r.cobrador===req.user.nombre);
  const resumen={ total:rows.length, gestionados:rows.filter(r=>r.gestion&&(r.gestion.resultado||r.gestion.tieneEvidencia)).length, validados:rows.filter(r=>r.gestion&&r.gestion.validado).length };
  res.json({ semana:iso, rows, resumen });
});
// Guardar gestión / evidencia de un contacto (queda pendiente de validar)
app.post('/api/contactos', auth, rol('admin','supervisor','sucursal','cobrador'), (req,res)=>{
  const { semana, clientId, resultado, nota, evidencia } = req.body;
  const iso = semana || _semanaAnteriorISO();
  const cid = +clientId;
  if(!cid) return res.status(400).json({ error:'Falta el cliente' });
  // alcance: sucursal/cobrador solo su cartera
  const venta = db.sales.find(s=>s.clientId===cid);
  if(req.user.rol==='sucursal' && venta && Number(venta.sucursalId)!==Number(req.user.sucursalId)) return res.status(403).json({ error:'Ese cliente no es de tu sucursal' });
  if(req.user.rol==='cobrador' && venta && venta.prom!==req.user.nombre) return res.status(403).json({ error:'Ese cliente no es de tu ruta' });
  let rec=db.contactos.find(k=>k.semana===iso && k.clientId===cid);
  if(!rec){ rec={ id:nextId('contactos'), semana:iso, clientId:cid }; db.contactos.push(rec); }
  if(resultado!=null) rec.resultado=String(resultado).slice(0,80);
  if(nota!=null) rec.nota=String(nota).slice(0,500);
  if(evidencia!=null) rec.evidencia=evidencia;     // dataURL base64
  rec.por=req.user.nombre; rec.fecha=new Date().toISOString();
  rec.validado=false; rec.validadoPor=null; rec.validadoFecha=null;   // toda gestión nueva entra sin validar
  saveDB(); res.json({ ok:true, id:rec.id });
});
// Ver evidencia/nota de un contacto
app.get('/api/contactos/:id/evidencia', auth, rol('admin','supervisor','sucursal','cobrador'), (req,res)=>{
  const rec=db.contactos.find(k=>k.id==req.params.id);
  if(!rec) return res.status(404).json({ error:'Contacto no encontrado' });
  res.json({ evidencia:rec.evidencia||null, nota:rec.nota||'', resultado:rec.resultado||'', por:rec.por||null, validado:!!rec.validado, validadoPor:rec.validadoPor||null });
});
// Validar (o rechazar) un contacto — solo admin/supervisor
app.post('/api/contactos/:id/validar', auth, rol('admin','supervisor'), (req,res)=>{
  const rec=db.contactos.find(k=>k.id==req.params.id);
  if(!rec) return res.status(404).json({ error:'Contacto no encontrado' });
  rec.validado = req.body.validado!==false;
  rec.validadoPor = req.user.nombre; rec.validadoFecha=new Date().toISOString();
  saveDB(); res.json({ ok:true, validado:rec.validado });
});
// Hora de México (CDMX/Edomex = UTC-6 todo el año desde 2023, sin horario de verano)
function nowMx(){ return new Date(Date.now() - 6*3600*1000); }function fechaMxHoyDDMM(){ const d=nowMx(); return `${String(d.getUTCDate()).padStart(2,'0')}/${String(d.getUTCMonth()+1).padStart(2,'0')}/${d.getUTCFullYear()}`; }
function fechaMxDeISO(iso){ const d=new Date(new Date(iso).getTime() - 6*3600*1000); return `${String(d.getUTCDate()).padStart(2,'0')}/${String(d.getUTCMonth()+1).padStart(2,'0')}/${d.getUTCFullYear()}`; }
function fechaMxHoyISO(){ const d=nowMx(); return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`; }
function horaMxHHMM(){ const d=nowMx(); let h=d.getUTCHours(); const m=String(d.getUTCMinutes()).padStart(2,'0'); const ap=h<12?'a.m.':'p.m.'; h=h%12||12; return `${String(h).padStart(2,'0')}:${m} ${ap}`; }
// ¿el cobrador ya entregó su corte de hoy? (para bloquear cobros posteriores)
function corteHechoHoy(nombre){ return !!db.cortes.find(c => c.prom === nombre && c.fecha === fechaMxHoyISO()); }
function generarCorte(user, isAuto){
  if (!user || !user.nombre) return { error: 'Usuario inválido' };
  const fecha = fechaMxHoyISO();
  if (db.cortes.find(c => c.prom === user.nombre && c.fecha === fecha)) return { duplicate: true };
  const hoy = fechaMxHoyDDMM();
  const pagos = db.movimientos.filter(m => m.abono > 0 && m.origen === user.nombre && m.fecha === hoy);
  const efectivoBruto = pagos.filter(m => (m.forma||'efectivo') === 'efectivo').reduce((a,m)=>a+m.abono,0);
  const banco = pagos.filter(m => m.forma === 'transferencia' || m.forma === 'deposito').reduce((a,m)=>a+m.abono,0);
  // descontar el efectivo que el promotor ya entregó al JC hoy (no lo debe entregar dos veces)
  const aJC = db.jcEntregas.filter(e => e.cobradorId === user.id && e.fechaDDMM === hoy).reduce((a,e)=>a+e.monto,0);
  const efectivo = Math.max(0, efectivoBruto - aJC);
  const tieneEfectivo = efectivo > 0;
  const corte = {
    id: nextId('cortes'), prom: user.nombre, sucursalId: user.sucursalId || null,
    fecha, totalEfectivo: efectivo, efectivoBruto, entregadoAlJC: aJC, totalBanco: banco, npagos: pagos.length,
    items: pagos.map(m => ({ saleId: m.saleId, monto: m.abono, forma: m.forma||'efectivo' })),
    horaEntrega: horaMxHHMM(),
    auto: !!isAuto, by: isAuto ? 'sistema' : 'cobrador',
    // si no hay efectivo que entregar, el corte se cierra solo (no hay nada que el admin reciba)
    estado: tieneEfectivo ? 'pendiente' : 'recibido',
    recibidoAt: tieneEfectivo ? null : new Date().toISOString(),
    recibidoBy: tieneEfectivo ? null : 'sin efectivo',
    createdAt: new Date().toISOString()
  };
  db.cortes.push(corte); saveDB();
  return { corte };
}
function checkAutoCorte(){
  for (const t of (SYS && SYS.tenants ? SYS.tenants : [])) {
    if (t.activo === false) continue;
    const blob = tenantCache[t.id];
    if (!blob || !blob.config) continue;
    als.run({ tenantId: t.id, db: blob }, () => {
      const now = nowMx();
      const [hh, mm] = (db.config.corteAutoHora || '19:00').split(':').map(Number);
      const dow = now.getUTCDay();
      const dayList = db.config.corteAutoDias || [1,2,3,4,5,6];
      if (!dayList.includes(dow)) return;
      if (now.getUTCHours() < hh || (now.getUTCHours() === hh && now.getUTCMinutes() < mm)) return;
      db.users.filter(u => u.rol === 'cobrador' && u.activo).forEach(u => generarCorte(u, true));
    });
  }
}
setInterval(checkAutoCorte, 60_000);

app.post('/api/corte', auth, (req, res) => {
  let user = req.user;
  if (req.body.prom && (req.user.rol === 'admin' || req.user.rol === 'supervisor')) {
    const u = db.users.find(x => x.nombre === req.body.prom);
    if (!u) return res.status(404).json({ error: 'Cobrador no encontrado' });
    user = u;
  }
  if (user.rol !== 'cobrador') return res.status(400).json({ error: 'El usuario no es cobrador' });
  const r = generarCorte(user, false);
  if (r.duplicate) return res.status(409).json({ error: 'Ya hay un corte registrado hoy para ' + user.nombre });
  res.json({ ok: true, corte: r.corte });
});
app.get('/api/mi-corte', auth, (req, res) => {
  const fecha = fechaMxHoyISO();
  const corte = db.cortes.find(c => c.prom === req.user.nombre && c.fecha === fecha);
  res.json({ corte: corte || null });
});
// Cierre de caja de la SUCURSAL: cierra el corte, manda el efectivo al admin y deja la caja en ceros
app.post('/api/caja/cierre', auth, rol('sucursal'), (req, res) => {
  const me = db.users.find(u => u.id === req.user.id);
  const sid = String(me ? me.sucursalId : (req.user.sucursalId || 1));
  const suc = db.sucursales.find(s => String(s.id) === sid);
  const c = db.caja[sid] || { inicial: 0, efectivo: 0, banco: 0, entregas: 0, retiros: 0 };
  c.retiros = c.retiros || 0;
  const efectivoReal = Math.max(0, (c.inicial || 0) + (c.efectivo || 0) + (c.entregas || 0) - c.retiros);
  const banco = c.banco || 0;
  const fecha = fechaMxHoyISO();
  const tiene = efectivoReal > 0;
  const corte = {
    id: nextId('cortes'), tipo: 'sucursal', prom: (suc ? suc.nombre : 'Sucursal'), sucursalId: +sid,
    fecha, totalEfectivo: efectivoReal, efectivoBruto: efectivoReal, entregadoAlJC: 0, totalBanco: banco, npagos: 0,
    horaEntrega: horaMxHHMM(), by: 'sucursal',
    estado: tiene ? 'pendiente' : 'recibido',
    recibidoAt: tiene ? null : new Date().toISOString(), recibidoBy: tiene ? null : 'sin efectivo',
    createdAt: new Date().toISOString()
  };
  db.cortes.push(corte);
  // dejar la caja en ceros (el efectivo cerrado ya quedó en el corte para el admin)
  db.caja[sid] = { inicial: 0, efectivo: 0, banco: 0, entregas: 0, retiros: 0 };
  saveDB();
  res.json({ ok: true, corte, efectivoCerrado: efectivoReal, banco });
});
// El admin/supervisor recibe (confirma) un corte pendiente — sirve para cobradores y sucursales
app.post('/api/cortes/:id/recibir', auth, rol('admin', 'supervisor'), (req, res) => {
  const c = db.cortes.find(x => x.id == req.params.id);
  if (!c) return res.status(404).json({ error: 'Corte no encontrado' });
  if (c.estado === 'recibido') return res.status(409).json({ error: 'Ese corte ya estaba recibido' });
  c.estado = 'recibido'; c.recibidoAt = new Date().toISOString(); c.recibidoBy = req.user.nombre;
  if (c.tipo === 'sucursal' && c.totalEfectivo > 0) flujoAgregar('entrada', 'cierre', `Cierre de caja · ${c.prom}`, c.totalEfectivo, null, req.user.nombre);
  saveDB();
  res.json({ ok: true });
});
app.get('/api/cortes', auth, (req, res) => {
  const { fecha, prom } = req.query;
  let out = db.cortes;
  if (fecha) out = out.filter(c => c.fecha === fecha);
  if (prom) out = out.filter(c => c.prom === prom);
  if (req.user.rol === 'cobrador') out = out.filter(c => c.prom === req.user.nombre);
  res.json(out.sort((a,b) => (b.createdAt||'').localeCompare(a.createdAt||'')));
});
app.delete('/api/cortes/:id', auth, rol('admin','supervisor'), (req, res) => {
  const id = +req.params.id;
  const i = db.cortes.findIndex(c => c.id === id);
  if (i < 0) return res.status(404).json({ error: 'Corte no encontrado' });
  db.cortes.splice(i, 1); saveDB();
  res.json({ ok: true });
});
app.get('/api/config', auth, (req, res) => res.json(db.config || {}));
app.get('/api/tarifas', auth, (req, res) => res.json((db.config && db.config.tarifas) || DEFAULT_TARIFAS));
app.get('/api/config/comisiones', auth, (req, res) => {
  const c = (db.config && db.config.comisiones) || {};
  res.json({
    cob: c.cob != null ? c.cob : ((db.config && db.config.tasaCobrador) || 5),
    meta: c.meta != null ? c.meta : 85,
    bono: c.bono != null ? c.bono : 600,
    mora: c.mora != null ? c.mora : 1.5,
    coloc: c.coloc != null ? c.coloc : 80
  });
});
app.put('/api/config/comisiones', auth, rol('admin'), (req, res) => {
  const { cob, meta, bono, mora, coloc } = req.body || {};
  db.config = db.config || {};
  db.config.comisiones = { cob: +cob || 0, meta: +meta || 0, bono: +bono || 0, mora: +mora || 0, coloc: +coloc || 0 };
  db.config.tasaCobrador = +cob || 0; // el reporte de comisiones usa esto
  saveDB();
  res.json({ ok: true, comisiones: db.config.comisiones });
});
app.put('/api/tarifas', auth, rol('admin'), (req, res) => {
  const t = req.body || {};
  // validación mínima de estructura
  const okArr = a => Array.isArray(a) && a.every(x => typeof x.p === 'number' && typeof x.f === 'number' && typeof x.fijo === 'number');
  if (!okArr(t.diario) || !okArr(t.semanal) || !okArr(t.p17) || !t.unico || typeof t.unico.base !== 'number' || typeof t.unico.factor !== 'number')
    return res.status(400).json({ error: 'Estructura de tarifas inválida' });
  const okPP = s => s && typeof s.factor === 'number' && typeof s.fijo === 'number' && typeof s.ppFactor === 'number' && typeof s.ppFijo === 'number' && typeof s.pagos === 'number';
  db.config = db.config || {};
  db.config.tarifas = { diario: t.diario, semanal: t.semanal, p17: t.p17, unico: { base: t.unico.base, factor: t.unico.factor },
    s16: okPP(t.s16) ? t.s16 : DEFAULT_TARIFAS.s16, s17: okPP(t.s17) ? t.s17 : DEFAULT_TARIFAS.s17,
    s21: okPP(t.s21) ? t.s21 : DEFAULT_TARIFAS.s21, s31: okPP(t.s31) ? t.s31 : DEFAULT_TARIFAS.s31 };
  saveDB();
  res.json(db.config.tarifas);
});
app.post('/api/tarifas/reset', auth, rol('admin'), (req, res) => {
  db.config = db.config || {};
  db.config.tarifas = JSON.parse(JSON.stringify(DEFAULT_TARIFAS));
  saveDB(); res.json(db.config.tarifas);
});
app.patch('/api/config', auth, rol('admin','supervisor'), (req, res) => {
  db.config = db.config || {};
  if (req.body.corteAutoHora) db.config.corteAutoHora = req.body.corteAutoHora;
  if (Array.isArray(req.body.corteAutoDias)) db.config.corteAutoDias = req.body.corteAutoDias;
  if (req.body.semanaInicio != null) db.config.semanaInicio = Math.min(6, Math.max(0, +req.body.semanaInicio));
  if (req.body.brandNombre && req.user.rol === 'admin') {
    db.config.brand = db.config.brand || {};
    db.config.brand.nombre = String(req.body.brandNombre).trim();
    const t = (SYS.tenants || []).find(x => x.id === als.getStore().tenantId);
    if (t) { t.nombre = db.config.brand.nombre; saveSystem(); }
  }
  saveDB(); res.json(db.config);
});
app.get('/api/config/semana', auth, (req, res) => {
  res.json({ semanaInicio: _diaSemanaInicio() });
});

/* ---------- Reporte de cartera por cobrador ---------- */
function _tipoLblSrv(t){ return ({diario:'Diario',semanal:'Semanal',unico:'Pago único',p17:'Celulares 17'})[t] || t; }
function _ultimas16Cuotas(sale, abonos){
  const created = sale.createdAt ? new Date(sale.createdAt) : new Date();
  const ahora = new Date();
  const cuota = sale.cuota || 0;
  let fechas = [];
  if (sale.tipo === 'diario')    for (let i=1; i<=(sale.plazo||0); i++) { const d=new Date(created); d.setDate(d.getDate()+i); fechas.push(d); }
  else if (sale.tipo === 'semanal') for (let i=1; i<=(sale.plazo||0); i++) { const d=new Date(created); d.setDate(d.getDate()+i*7); fechas.push(d); }
  else if (sale.tipo === 'unico') { const d=new Date(created); d.setDate(d.getDate()+(sale.plazo||0)); fechas.push(d); }
  else if (sale.tipo === 'p17') { const iv=Math.max(1, Math.round((sale.plazo||270)/17)); for (let i=1; i<=17; i++) { const d=new Date(created); d.setDate(d.getDate()+i*iv); fechas.push(d); } }
  const estados = fechas.map((fecha, i) => {
    if (fecha > ahora) return 'x';
    const cutoff = new Date(fecha); cutoff.setDate(cutoff.getDate()+1);
    const acumPagado = abonos.filter(m => _parseFechaMx(m.fecha) <= cutoff.getTime()).reduce((a,m)=>a+m.abono, 0);
    return acumPagado >= (i+1)*cuota ? 'p' : 'n';
  });
  let u = estados.slice(-16); while (u.length < 16) u.unshift('x');
  return u;
}
/* ---------- Reportes nuevos: colocación, REFIN, comisiones ---------- */
app.get('/api/reports/colocacion', auth, rol('admin','supervisor'), (req, res) => {
  const bucket = (req.query.bucket || 'dia').toLowerCase(); // dia | semana
  const dias = Math.max(1, Math.min(180, +req.query.dias || 30));
  const ahora = new Date();
  const desde = new Date(); desde.setDate(desde.getDate() - dias);
  const activos = new Set(db.clients.filter(c => c.activo !== false).map(c => c.id));
  const ventas = db.sales.filter(s => s.createdAt && activos.has(s.clientId) && new Date(s.createdAt) >= desde);
  const buckets = {};
  ventas.forEach(s => {
    const d = new Date(s.createdAt);
    let key;
    if (bucket === 'semana') {
      const monday = new Date(d); monday.setDate(d.getDate() - ((d.getDay()+6) % 7));
      key = monday.toISOString().slice(0,10);
    } else { key = d.toISOString().slice(0,10); }
    buckets[key] = buckets[key] || { fecha: key, creditos: 0, monto: 0 };
    buckets[key].creditos++; buckets[key].monto += s.monto || 0;
  });
  // serie completa con ceros donde no hubo nada
  const serie = [];
  if (bucket === 'semana') {
    const start = new Date(desde); start.setDate(start.getDate() - ((start.getDay()+6)%7));
    for (let d = new Date(start); d <= ahora; d.setDate(d.getDate()+7)) {
      const k = d.toISOString().slice(0,10);
      serie.push(buckets[k] || { fecha: k, creditos: 0, monto: 0 });
    }
  } else {
    for (let d = new Date(desde); d <= ahora; d.setDate(d.getDate()+1)) {
      const k = d.toISOString().slice(0,10);
      serie.push(buckets[k] || { fecha: k, creditos: 0, monto: 0 });
    }
  }
  // breakdowns por sucursal y por cobrador
  const porSucursal = db.sucursales.map(suc => {
    const vs = ventas.filter(s => s.sucursalId === suc.id);
    return { id: suc.id, nombre: suc.nombre, creditos: vs.length, monto: vs.reduce((a,s)=>a+(s.monto||0),0) };
  }).filter(s => s.creditos > 0).sort((a,b)=>b.monto-a.monto);
  const cobs = {};
  ventas.forEach(s => { if (!s.prom) return; cobs[s.prom] = cobs[s.prom] || { nombre: s.prom, creditos: 0, monto: 0 }; cobs[s.prom].creditos++; cobs[s.prom].monto += s.monto||0; });
  const porCobrador = Object.values(cobs).sort((a,b)=>b.monto-a.monto);
  res.json({
    bucket, dias,
    serie,
    totales: { creditos: ventas.length, monto: ventas.reduce((a,s)=>a+(s.monto||0),0) },
    porSucursal, porCobrador,
  });
});

app.get('/api/reports/refin', auth, rol('admin','supervisor'), (req, res) => {
  const desde = req.query.desde ? new Date(req.query.desde) : new Date(Date.now() - 30*86400000);
  const hasta = req.query.hasta ? new Date(req.query.hasta) : new Date();
  const refins = db.movimientos.filter(m => m.forma === 'refin' && m.abono > 0).map(m => {
    const fechaMs = _parseFechaMx(m.fecha);
    if (fechaMs < desde.getTime() || fechaMs > hasta.getTime()+86400000) return null;
    const oldSale = db.sales.find(s => s.id === m.saleId);
    if (!oldSale) return null;
    const cliente = db.clients.find(c => c.id === oldSale.clientId) || {};
    const suc = db.sucursales.find(s => s.id === oldSale.sucursalId);
    const nuevo = db.sales.find(s => s.refinDe === oldSale.id);
    return {
      fecha: m.fecha,
      cliente: cliente.nombre || '—',
      cobrador: oldSale.prom || '—',
      sucursal: suc ? suc.nombre : '—',
      oldFolio: oldSale.folio, saldoLiquidado: m.abono,
      nuevoFolio: nuevo ? nuevo.folio : null,
      nuevoMonto: nuevo ? nuevo.monto : 0,
      neto: nuevo ? (nuevo.monto - m.abono) : 0,
      operador: m.origen
    };
  }).filter(Boolean).sort((a,b)=>_parseFechaMx(b.fecha)-_parseFechaMx(a.fecha));
  const totales = {
    n: refins.length,
    saldoLiquidado: refins.reduce((a,r)=>a+r.saldoLiquidado,0),
    nuevoMonto: refins.reduce((a,r)=>a+r.nuevoMonto,0),
    neto: refins.reduce((a,r)=>a+r.neto,0),
  };
  res.json({ desde: desde.toISOString(), hasta: hasta.toISOString(), refins, totales });
});

app.get('/api/reports/recoleccion', auth, rol('admin', 'supervisor'), (req, res) => {
  const sucMap = {}; db.sucursales.forEach(s => sucMap[s.id] = s.nombre);
  const porCobrador = (db.porEntregar || []).filter(p => p.monto > 0).map(p => ({
    tipo: 'cobrador', ref: p.prom, cobrador: p.prom, sucursal: sucMap[p.sucursalId] || '—', monto: p.monto
  })).sort((a, b) => b.monto - a.monto);
  const porSucursal = db.sucursales.map(s => {
    const caja = db.caja[String(s.id)] || {};
    // recolectable = efectivo cobrado + entregas de cobradores − lo ya recolectado (NO incluye el fondo inicial)
    const efectivo = Math.max(0, (caja.efectivo || 0) + (caja.entregas || 0) - (caja.retiros || 0));
    const enc = db.users.find(u => u.rol === 'sucursal' && u.sucursalId === s.id);
    return { tipo: 'sucursal', ref: s.id, sucursalId: s.id, sucursal: s.nombre, encargada: enc ? enc.nombre : '—', efectivo };
  }).filter(s => s.efectivo > 0).sort((a, b) => b.efectivo - a.efectivo);
  const porJC = db.users.filter(u => u.rol === 'jc' && u.activo).map(j => {
    const caja = jcCajaDe(j.id);
    return { tipo: 'jc', ref: j.id, jc: j.nombre, sucursal: sucMap[j.sucursalId] || '—', monto: caja.saldo, recibido: caja.recibido, entregado: caja.entregado };
  }).filter(j => j.monto > 0).sort((a, b) => b.monto - a.monto);
  res.json({
    generadoEn: new Date().toISOString(),
    porCobrador, porSucursal, porJC,
    totalCobradores: porCobrador.reduce((a, c) => a + c.monto, 0),
    totalSucursales: porSucursal.reduce((a, s) => a + s.efectivo, 0),
    totalJC: porJC.reduce((a, j) => a + j.monto, 0),
    totalGeneral: porCobrador.reduce((a, c) => a + c.monto, 0) + porSucursal.reduce((a, s) => a + s.efectivo, 0) + porJC.reduce((a, j) => a + j.monto, 0),
  });
});
// ===== TESORERÍA / FLUJO DEL ADMIN =====
function flujoAgregar(tipo, clase, concepto, monto, destino, by) {
  db.flujo = db.flujo || [];
  db.flujo.push({ id: nextId('flujo'), fecha: new Date().toISOString(), fechaTxt: fechaMxHoyDDMM(), tipo, clase, concepto, monto: Math.round(monto), destino: destino || null, by: by || 'admin' });
}
function flujoSaldo() { return (db.flujo || []).reduce((a, m) => a + (m.tipo === 'entrada' ? m.monto : -m.monto), 0) + asignNeto('admin', null); }
app.get('/api/flujo', auth, rol('admin', 'supervisor'), (req, res) => {
  const movs = (db.flujo || []).slice().sort((a, b) => new Date(a.fecha) - new Date(b.fecha));
  let run = 0; const conSaldo = movs.map(m => { run += (m.tipo === 'entrada' ? m.monto : -m.monto); return { ...m, saldo: run }; }).reverse();
  const T = { recibido: 0, inyectado: 0, dotado: 0, egresos: 0 };
  (db.flujo || []).forEach(m => {
    if (m.clase === 'recoleccion' || m.clase === 'cierre') T.recibido += m.monto;
    else if (m.clase === 'inyeccion') T.inyectado += m.monto;
    else if (m.clase === 'dotacion') T.dotado += m.monto;
    else if (m.clase === 'egreso') T.egresos += m.monto;
  });
  const dotadoPor = {};
  (db.flujo || []).filter(m => m.clase === 'dotacion' && m.destino).forEach(m => { const k = m.destino.tipo + ':' + m.destino.id; dotadoPor[k] = (dotadoPor[k] || 0) + m.monto; });
  const sucursales = db.sucursales.filter(s => s.activo !== false).map(s => { const c = db.caja[String(s.id)] || {}; return { id: s.id, nombre: s.nombre, caja: Math.round((c.inicial || 0) + (c.efectivo || 0) + (c.entregas || 0) - (c.retiros || 0)), dotado: dotadoPor['sucursal:' + s.id] || 0 }; });
  const jcs = db.users.filter(u => u.rol === 'jc' && u.activo).map(u => ({ id: u.id, nombre: u.nombre, caja: Math.round(jcCajaDe(u.id).saldo), dotado: dotadoPor['jc:' + u.id] || 0 }));
  const supervisores = db.users.filter(u => u.rol === 'supervisor' && u.activo).map(u => ({ id: u.id, nombre: u.nombre, dotado: dotadoPor['supervisor:' + u.id] || 0 }));
  res.json({ saldo: flujoSaldo(), totales: T, destinos: { sucursales, jcs, supervisores }, movimientos: conSaldo.slice(0, 120) });
});
app.post('/api/flujo/inyeccion', auth, rol('admin'), (req, res) => {
  const monto = +req.body.monto; if (!(monto > 0)) return res.status(400).json({ error: 'Monto inválido' });
  flujoAgregar('entrada', 'inyeccion', 'Inyección de capital' + (req.body.nota ? ' · ' + req.body.nota : ''), monto, null, req.user.nombre);
  saveDB(); res.json({ ok: true, saldo: flujoSaldo() });
});
app.post('/api/flujo/egreso', auth, rol('admin'), (req, res) => {
  const monto = +req.body.monto; if (!(monto > 0)) return res.status(400).json({ error: 'Monto inválido' });
  const tipos = { nomina_empleados: 'Nómina empleados', nomina_admin: 'Nómina ADMIN', otro: 'Otro gasto' };
  const base = tipos[req.body.tipo] || 'Otro gasto';
  const concepto = base + (req.body.detalle ? ' · ' + req.body.detalle : '');
  flujoAgregar('salida', 'egreso', concepto, monto, null, req.user.nombre);
  saveDB(); res.json({ ok: true, saldo: flujoSaldo() });
});
app.post('/api/flujo/dotacion', auth, rol('admin'), (req, res) => {
  const monto = +req.body.monto; const { destinoTipo, destinoId, nota } = req.body;
  if (!(monto > 0)) return res.status(400).json({ error: 'Monto inválido' });
  if (destinoTipo === 'cobrador') return res.status(403).json({ error: 'No se puede asignar dinero a un promotor. El promotor solo entrega efectivo, nunca lo recibe.' });
  let nombre = '', destino = null;
  if (destinoTipo === 'sucursal') {
    const s = db.sucursales.find(x => x.id == destinoId); if (!s) return res.status(404).json({ error: 'Sucursal no encontrada' });
    const sid = String(s.id); db.caja[sid] = db.caja[sid] || { inicial: 0, efectivo: 0, banco: 0, entregas: 0, retiros: 0 };
    db.caja[sid].inicial = (db.caja[sid].inicial || 0) + monto;
    nombre = s.nombre; destino = { tipo: 'sucursal', id: s.id, nombre };
  } else if (destinoTipo === 'jc') {
    const jc = db.users.find(u => u.id == destinoId && u.rol === 'jc'); if (!jc) return res.status(404).json({ error: 'JC no encontrado' });
    db.jcEntregas.push({ id: nextId('jcEntregas'), cobradorId: req.user.id, cobradorNombre: 'Admin · dotación', jcId: jc.id, jcNombre: jc.nombre, monto: Math.round(monto), nota: nota || '', estado: 'recibido', sucursalId: jc.sucursalId || null, fechaDDMM: fechaMxHoyDDMM(), creadoEn: new Date().toISOString(), origen: 'dotacion-admin', recibidoEn: new Date().toISOString() });
    nombre = jc.nombre; destino = { tipo: 'jc', id: jc.id, nombre };
  } else if (destinoTipo === 'supervisor') {
    const sv = db.users.find(u => u.id == destinoId && u.rol === 'supervisor'); if (!sv) return res.status(404).json({ error: 'Supervisor no encontrado' });
    nombre = sv.nombre; destino = { tipo: 'supervisor', id: sv.id, nombre };
  } else return res.status(400).json({ error: 'Destino inválido' });
  flujoAgregar('salida', 'dotacion', `Dotación a ${destino.tipo === 'jc' ? 'JC ' : destino.tipo === 'supervisor' ? 'Supervisor ' : ''}${nombre}` + (nota ? ' · ' + nota : ''), monto, destino, req.user.nombre);
  saveDB(); res.json({ ok: true, saldo: flujoSaldo(), destino });
});
// ===== REPORTE DE ENTREGAS (de todos) =====
app.get('/api/reports/entregas', auth, rol('admin', 'supervisor', 'sucursal'), (req, res) => {
  const scope = scopeSucDe(req.user);
  const r = _rangoReporte(req.query);
  const sucMap = {}; db.sucursales.forEach(s => sucMap[s.id] = s.nombre);
  const rolLbl = { admin: 'Admin', supervisor: 'Supervisor', sucursal: 'Sucursal', jc: 'JC' };
  let ent = db.sales.filter(s => s.entrega && (scope == null || s.sucursalId === scope));
  ent = ent.filter(s => { const t = new Date(s.entrega.fecha).getTime(); return (!r.desde || t >= r.desde) && (!r.hasta || t <= r.hasta); });
  const lista = ent.map(s => {
    const c = db.clients.find(x => x.id === s.clientId) || {};
    const por = s.entrega.por || { rol: 'jc', nombre: s.entrega.jcNombre || '—' };
    return { folio: s.folio, cliente: c.nombre || '—', sucursal: sucMap[s.sucursalId] || '—', ruta: s.prom || '—', entregadoPor: por.nombre, rolEntrega: rolLbl[por.rol] || por.rol, fecha: s.entrega.fecha, monto: entregaMontoDe(s), tieneEvidencia: !!(s.entrega.fotoCasa || s.entrega.firma), saleId: s.id };
  }).sort((a, b) => new Date(b.fecha) - new Date(a.fecha));
  const porPersona = {};
  lista.forEach(e => { const k = e.entregadoPor + ' (' + e.rolEntrega + ')'; porPersona[k] = porPersona[k] || { quien: e.entregadoPor, rol: e.rolEntrega, n: 0, monto: 0 }; porPersona[k].n++; porPersona[k].monto += e.monto; });
  res.json({ total: lista.length, montoTotal: lista.reduce((a, e) => a + e.monto, 0), porPersona: Object.values(porPersona).sort((a, b) => b.monto - a.monto), entregas: lista.slice(0, 300) });
});
// ===== ALERTA: QUIÉN NO HA VENDIDO =====
app.get('/api/reports/sin-ventas', auth, rol('admin', 'supervisor', 'sucursal'), (req, res) => {
  const scope = scopeSucDe(req.user);
  const inicio = (req.query.inicio != null && req.query.inicio !== '') ? Math.min(Math.max(+req.query.inicio, 0), 6) : 4;
  const sem = _ultimasSemanas(4, inicio); // últimas 4 semanas operativas
  const sucMap = {}; db.sucursales.forEach(s => sucMap[s.id] = s.nombre);
  let cobs = db.users.filter(u => u.rol === 'cobrador' && u.activo && (scope == null || u.sucursalId === scope));
  const lista = cobs.map(u => {
    const ventas = db.sales.filter(s => s.prom === u.nombre && s.sucursalId === u.sucursalId);
    const porSemana = sem.map(w => ventas.filter(s => { const t = new Date(s.createdAt).getTime(); return t >= w.desde && t <= w.hasta; }).length);
    const ultima = ventas.length ? Math.max(...ventas.map(s => new Date(s.createdAt).getTime())) : null;
    // semanas consecutivas sin vender (desde la más reciente hacia atrás)
    let sinVender = 0; for (let i = porSemana.length - 1; i >= 0; i--) { if (porSemana[i] === 0) sinVender++; else break; }
    return { cobrador: u.nombre, sucursal: sucMap[u.sucursalId] || '—', ventasSemana: porSemana[porSemana.length - 1], porSemana, semanasSinVender: sinVender, ultimaVenta: ultima ? new Date(ultima).toISOString() : null, totalVentas: ventas.length };
  }).sort((a, b) => b.semanasSinVender - a.semanasSinVender);
  res.json({ semanas: sem.map(w => ({ label: w.label, rango: w.rango })), inicio, cobradores: lista, sinVenderEstaSemana: lista.filter(c => c.ventasSemana === 0).length, total: lista.length });
});
// ===== RASTREO DE EQUIPO (ubicación de la gente en campo) =====
app.post('/api/ubicacion/ping', auth, rol('cobrador', 'jc', 'sucursal', 'supervisor'), (req, res) => {
  const lat = +req.body.lat, lng = +req.body.lng;
  if (!isFinite(lat) || !isFinite(lng)) return res.status(400).json({ error: 'coords inválidas' });
  db.ubicaciones = db.ubicaciones || {};
  const me = db.users.find(u => u.id === req.user.id) || {};
  db.ubicaciones[req.user.id] = { userId: req.user.id, nombre: req.user.nombre, rol: req.user.rol, sucursalId: me.sucursalId || null, lat, lng, at: new Date().toISOString() };
  saveDB();
  res.json({ ok: true });
});
app.get('/api/ubicacion/equipo', auth, rol('admin', 'supervisor'), (req, res) => {
  db.ubicaciones = db.ubicaciones || {};
  const sucMap = {}; db.sucursales.forEach(s => sucMap[s.id] = s.nombre);
  const rolLbl = { cobrador: 'Promotor', jc: 'JC', sucursal: 'Sucursal', supervisor: 'Supervisor' };
  const ahora = Date.now();
  const gente = Object.values(db.ubicaciones).map(u => ({ ...u, sucursal: sucMap[u.sucursalId] || '—', rolLbl: rolLbl[u.rol] || u.rol, minutos: Math.round((ahora - new Date(u.at).getTime()) / 60000) }))
    .filter(u => isFinite(u.lat) && isFinite(u.lng))
    .sort((a, b) => a.minutos - b.minutos);
  res.json({ gente });
});

// ===== REPORTE DE ENTREGAS (de todos) — fin =====
// Limpia los datos de PRUEBA de la agencia actual (conserva usuarios, sucursales y configuración)
app.post('/api/admin/reset-datos', auth, rol('admin'), (req, res) => {
  if (req.body.confirmar !== 'BORRAR') return res.status(400).json({ error: "Para confirmar envía { confirmar: 'BORRAR' }" });
  db.clients = [];
  db.sales = [];
  db.movimientos = [];
  db.caja = {};
  db.porEntregar = [];
  db.cortes = [];
  db.recolecciones = [];
  db.jcEntregas = [];
  db.jcCierres = [];
  db.flujo = [];
  db.transferencias = [];
  db.ubicaciones = {};
  saveDB();
  res.json({ ok: true, mensaje: 'Datos de prueba borrados. Se conservaron usuarios, sucursales y configuración.' });
});
// ===== IMPORTACIÓN MASIVA (migración de base existente) =====
// body: { commit:bool, confirmar:'IMPORTAR', password:'cobra2026', items:[{suc,sucCode,ruta,nombre,tel,domicilio,monto,total,cuota,saldo}] }
function _slug(s) { return String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, ''); }
app.post('/api/admin/import-bulk', auth, rol('admin'), (req, res) => {
  const items = Array.isArray(req.body.items) ? req.body.items : [];
  if (!items.length) return res.status(400).json({ error: 'No se recibieron registros (items vacío).' });
  const sucNames = [...new Set(items.map(i => i.suc).filter(Boolean))];
  const rutas = [...new Set(items.map(i => i.suc + '||' + i.ruta))];
  const sumaSaldo = items.reduce((a, i) => a + (+i.saldo || 0), 0);
  const sucNuevas = sucNames.filter(n => !db.sucursales.find(s => (s.nombre || '').toLowerCase() === n.toLowerCase()));

  if (!req.body.commit) {
    return res.json({
      preview: true,
      sucursales: sucNames.length, sucursalesNuevas: sucNuevas.length,
      cobradores: rutas.length, creditos: items.length, sumaSaldo,
      porSucursal: sucNames.map(n => ({ sucursal: n, creditos: items.filter(i => i.suc === n).length, saldo: items.filter(i => i.suc === n).reduce((a, i) => a + (+i.saldo || 0), 0) })),
      muestra: items.slice(0, 3)
    });
  }
  if (req.body.confirmar !== 'IMPORTAR') return res.status(400).json({ error: "Para ejecutar envía commit:true y confirmar:'IMPORTAR'." });
  const pass = (req.body.password && req.body.password.length >= 4) ? req.body.password : 'cobra2026';
  const tid = als.getStore().tenantId;
  SYS.userIndex = SYS.userIndex || {};

  // 1) sucursales (find-or-create)
  const sucId = {};
  sucNames.forEach(n => {
    let s = db.sucursales.find(x => (x.nombre || '').toLowerCase() === n.toLowerCase());
    if (!s) { s = { id: nextId('sucursales'), nombre: n }; db.sucursales.push(s); }
    sucId[n] = s.id;
  });
  // 2) cobradores (uno por ruta) — reutiliza si ya existe (permite carga por lotes)
  const usados = new Set(Object.keys(SYS.userIndex).concat(db.users.map(u => u.usuario)));
  const logins = [];
  rutas.forEach(key => {
    const [suc, ruta] = key.split('||');
    let u = db.users.find(x => x.rol === 'cobrador' && x.nombre === ruta && x.sucursalId === sucId[suc]);
    if (!u) {
      let base = 'lf_' + _slug(ruta); let usuario = base, k = 1;
      while (usados.has(usuario)) { usuario = base + (++k); }
      usados.add(usuario);
      u = { id: nextId('users'), nombre: ruta, usuario, rol: 'cobrador', sucursalId: sucId[suc], passwordHash: bcrypt.hashSync(pass, 8), activo: true, createdAt: new Date().toISOString() };
      db.users.push(u); SYS.userIndex[usuario] = tid;
    }
    logins.push({ ruta, sucursal: suc, usuario: u.usuario });
  });
  // 3) clientes + créditos + saldo de apertura (folio continúa donde quedó por sucursal)
  const seq = {}; let creados = 0;
  const hoy = fechaMxHoyDDMM();
  items.forEach(it => {
    const sid = sucId[it.suc];
    const client = { id: nextId('clients'), nombre: it.nombre, tel: it.tel || '', calle: it.domicilio || '—', col: '', ciudad: '', estado: '', curp: '', sucursalId: sid, prom: it.ruta };
    db.clients.push(client);
    const code = it.sucCode || 'GEN';
    if (seq[code] == null) seq[code] = db.sales.filter(s => String(s.folio || '').startsWith('IMP-' + code + '-')).length;
    seq[code]++;
    const folio = 'IMP-' + code + '-' + String(seq[code]).padStart(4, '0');
    const cuota = +it.cuota || 0, total = +it.total || +it.saldo || 0, saldo = +it.saldo || 0;
    const plazo = cuota > 0 ? Math.max(1, Math.round(total / cuota)) : 1;
    const sale = { id: nextId('sales'), folio, clientId: client.id, tipo: 'semanal', plazo, monto: +it.monto || 0, cuota, total, prom: it.ruta, sucursalId: sid, entregado: true, importado: true, createdAt: new Date().toISOString() };
    db.sales.push(sale);
    // saldo de apertura = saldo actual (snapshot). saldoDe() = cargo - abono = saldo
    db.movimientos.push({ id: nextId('movimientos'), saleId: sale.id, fecha: hoy, concepto: 'Saldo inicial (migración)', origen: 'Importación', cargo: saldo, abono: 0 });
    creados++;
  });
  saveDB(); saveSystem();
  res.json({ ok: true, sucursales: sucNames.length, cobradores: rutas.length, creditos: creados, sumaSaldo, passwordCobradores: pass, logins });
});

app.post('/api/recoleccion', auth, rol('admin', 'supervisor'), (req, res) => {
  const { tipo, ref, motivo } = req.body;
  const fecha = new Date().toISOString();
  let monto = 0, nombre = '';
  if (tipo === 'cobrador') {
    const entries = db.porEntregar.filter(p => p.prom === ref);
    monto = entries.reduce((a, p) => a + p.monto, 0);
    if (monto <= 0) return res.status(400).json({ error: 'Ese cobrador no trae efectivo por recolectar' });
    db.porEntregar = db.porEntregar.filter(p => p.prom !== ref);
    nombre = ref;
    // el "check" del administrador cierra los cortes pendientes de ese cobrador
    (db.cortes || []).filter(c => c.prom === ref && c.estado !== 'recibido').forEach(c => {
      c.estado = 'recibido'; c.recibidoAt = fecha; c.recibidoBy = req.user.nombre;
    });
  } else if (tipo === 'sucursal') {
    const sid = String(ref);
    const c = db.caja[sid] || { inicial: 0, efectivo: 0, banco: 0, entregas: 0, retiros: 0 };
    c.retiros = c.retiros || 0;
    const disponible = Math.max(0, (c.efectivo || 0) + (c.entregas || 0) - c.retiros);
    if (disponible <= 0) return res.status(400).json({ error: 'Esa sucursal no tiene efectivo por recolectar' });
    c.retiros += disponible; db.caja[sid] = c; monto = disponible;
    const suc = db.sucursales.find(s => s.id === +sid); nombre = suc ? suc.nombre : ('Sucursal ' + sid);
  } else if (tipo === 'jc') {
    const jc = db.users.find(u => u.id == ref && u.rol === 'jc');
    if (!jc) return res.status(404).json({ error: 'JC no encontrado' });
    const caja = jcCajaDe(jc.id);
    if (caja.saldo <= 0) return res.status(400).json({ error: 'Ese JC no trae efectivo por recolectar' });
    monto = caja.saldo; nombre = jc.nombre;
    // el registro de recolección (abajo) lo descuenta de su caja vía jcCajaDe
  } else return res.status(400).json({ error: 'Tipo inválido' });
  db.recolecciones = db.recolecciones || [];
  const reg = { id: nextId('recolecciones'), tipo, ref, nombre, monto, fecha, por: req.user.nombre, motivo: motivo || '' };
  db.recolecciones.push(reg);
  flujoAgregar('entrada', 'recoleccion', `Recolección · ${nombre} (${tipo})`, monto, null, req.user.nombre);
  saveDB();
  res.json({ ok: true, registro: reg });
});
app.get('/api/recolecciones', auth, rol('admin', 'supervisor'), (req, res) => {
  res.json((db.recolecciones || []).slice().reverse());
});

app.get('/api/reports/comisiones', auth, rol('admin','supervisor'), (req, res) => {
  const periodo = req.query.periodo || 'semana';
  const desdeMs = _desdePeriodo(periodo);
  const tasa = (db.config && db.config.tasaCobrador) || 5; // % por defecto
  const cobradores = db.users.filter(u => u.rol === 'cobrador' && u.activo);
  const sucActivos = new Set(db.clients.filter(c => c.activo !== false).map(c => c.id));
  const out = cobradores.map(c => {
    const sus_sales = db.sales.filter(s => s.prom === c.nombre && sucActivos.has(s.clientId));
    const sus_movs = db.movimientos.filter(m => {
      const s = sus_sales.find(x => x.id === m.saleId);
      return s && m.abono > 0 && m.forma !== 'descuento' && _parseFechaMx(m.fecha) >= desdeMs;
    });
    const efe = sus_movs.filter(m => !m.forma || m.forma === 'efectivo').reduce((a,m)=>a+m.abono,0);
    const tra = sus_movs.filter(m => m.forma === 'transferencia').reduce((a,m)=>a+m.abono,0);
    const dep = sus_movs.filter(m => m.forma === 'deposito').reduce((a,m)=>a+m.abono,0);
    const ref = sus_movs.filter(m => m.forma === 'refin').reduce((a,m)=>a+m.abono,0);
    const total = efe + tra + dep + ref;
    const suc = db.sucursales.find(s => s.id === c.sucursalId);
    return { nombre: c.nombre, sucursal: suc?suc.nombre:'—', efectivo:efe, transferencia:tra, deposito:dep, refin:ref, total, comision: total * tasa/100 };
  }).sort((a,b)=>b.total-a.total);
  res.json({ periodo, tasa, cobradores: out, totales: {
    efectivo: out.reduce((a,c)=>a+c.efectivo,0),
    transferencia: out.reduce((a,c)=>a+c.transferencia,0),
    deposito: out.reduce((a,c)=>a+c.deposito,0),
    refin: out.reduce((a,c)=>a+c.refin,0),
    total: out.reduce((a,c)=>a+c.total,0),
    comision: out.reduce((a,c)=>a+c.comision,0),
  }});
});

/* ---------- Reporte gerencial (rollup por niveles, con rango y utilidad) ---------- */
function _rangoReporte(q) {
  // desde/hasta en YYYY-MM-DD tienen prioridad; si no, usa periodo
  if (q.desde || q.hasta) {
    const d = q.desde ? new Date(q.desde + 'T00:00:00') : new Date(2000, 0, 1);
    const h = q.hasta ? new Date(q.hasta + 'T23:59:59') : new Date();
    return { desde: d.getTime(), hasta: h.getTime(), modo: 'rango', label: `${q.desde || '—'} a ${q.hasta || 'hoy'}` };
  }
  const periodo = q.periodo || 'semana';
  return { desde: _desdePeriodo(periodo), hasta: Date.now(), modo: periodo, label: periodo };
}
function _kpisVentas(sales, desde, hasta) {
  let cartera = 0, creditosAct = 0, atrasoMonto = 0, atrasoCli = 0, colocado = 0, ncoloc = 0, cobrado = 0, npagos = 0, utilidad = 0;
  const cliSet = new Set(), ratio = {};
  function atrasoDe(s) { const totAb = db.movimientos.filter(m => m.saleId === s.id && m.abono > 0).reduce((a, m) => a + m.abono, 0); return calcAtraso(s, totAb); }
  sales.forEach(s => {
    ratio[s.id] = s.total > 0 ? (s.total - s.monto) / s.total : 0;
    const saldo = saldoDe(s.id);
    if (saldo > 0) { cartera += saldo; creditosAct++; cliSet.add(s.clientId); const at = atrasoDe(s); if (at.montoAtraso > 0) { atrasoMonto += at.montoAtraso; atrasoCli++; } }
    if (s.createdAt) { const t = new Date(s.createdAt).getTime(); if (t >= desde && t <= hasta) { colocado += s.monto; ncoloc++; } }
  });
  const ids = new Set(sales.map(s => s.id));
  db.movimientos.filter(m => m.abono > 0 && m.forma !== 'descuento' && ids.has(m.saleId)).forEach(m => {
    const t = _parseFechaMx(m.fecha); if (t >= desde && t <= hasta) { cobrado += m.abono; npagos++; utilidad += m.abono * (ratio[m.saleId] || 0); }
  });
  return { cartera, clientes: cliSet.size, creditosActivos: creditosAct, atrasoMonto, vencido: atrasoMonto, atrasoClientes: atrasoCli,
    morosidad: cartera > 0 ? +(atrasoMonto / cartera * 100).toFixed(1) : 0, colocado, ncoloc, cobrado, npagos, utilidad: Math.round(utilidad) };
}
app.get('/api/reports/gerencial', auth, rol('admin', 'supervisor', 'sucursal'), (req, res) => {
  const { desde, hasta, label, modo } = _rangoReporte(req.query);
  const activos = new Set(db.clients.filter(c => c.activo !== false).map(c => c.id));
  const esGerente = req.user.rol === 'sucursal';
  const miSuc = esGerente ? (db.users.find(u => u.id === req.user.id) || {}).sucursalId : null;
  let sucursales = db.sucursales.filter(s => s.activo !== false);
  if (esGerente) sucursales = sucursales.filter(s => s.id === miSuc);
  const kp = sales => _kpisVentas(sales, desde, hasta);
  const porSucursal = sucursales.map(suc => {
    const ventasSuc = db.sales.filter(s => s.sucursalId === suc.id && activos.has(s.clientId));
    const enc = db.users.find(u => u.rol === 'sucursal' && u.sucursalId === suc.id);
    const cobradores = db.users.filter(u => u.rol === 'cobrador' && u.activo && u.sucursalId === suc.id);
    const promotores = cobradores.map(cob => ({ promotor: cob.nombre, ...kp(ventasSuc.filter(s => s.prom === cob.nombre)) }));
    return { id: suc.id, sucursal: suc.nombre, gerente: enc ? enc.nombre : '—', ...kp(ventasSuc), promotores };
  });
  const todas = db.sales.filter(s => (esGerente ? s.sucursalId === miSuc : true) && activos.has(s.clientId));
  res.json({ periodo: modo, rango: label, generado: new Date().toISOString(), nivel: esGerente ? 'sucursal' : 'empresa', empresa: kp(todas), sucursales: porSucursal });
});
// Drill-down: clientes de una sucursal o de un promotor (con cobrado/vencido en el rango)
app.get('/api/reports/gerencial-clientes', auth, rol('admin', 'supervisor', 'sucursal'), (req, res) => {
  const { desde, hasta } = _rangoReporte(req.query);
  const sucursalId = req.query.sucursalId ? +req.query.sucursalId : null;
  const promotor = req.query.promotor || null;
  if (req.user.rol === 'sucursal') { const me = db.users.find(u => u.id === req.user.id); if (!me || (sucursalId && sucursalId !== me.sucursalId)) return res.status(403).json({ error: 'Fuera de tu sucursal' }); }
  const activos = new Set(db.clients.filter(c => c.activo !== false).map(c => c.id));
  let sales = db.sales.filter(s => activos.has(s.clientId));
  if (sucursalId) sales = sales.filter(s => s.sucursalId === sucursalId);
  if (promotor) sales = sales.filter(s => s.prom === promotor);
  const sucMap = {}; db.sucursales.forEach(s => sucMap[s.id] = s.nombre);
  const rows = sales.map(s => {
    const c = db.clients.find(x => x.id === s.clientId) || {};
    const totAb = db.movimientos.filter(m => m.saleId === s.id && m.abono > 0).reduce((a, m) => a + m.abono, 0);
    const at = calcAtraso(s, totAb);
    const cobradoPeriodo = db.movimientos.filter(m => m.abono > 0 && m.forma !== 'descuento' && m.saleId === s.id && _parseFechaMx(m.fecha) >= desde && _parseFechaMx(m.fecha) <= hasta).reduce((a, m) => a + m.abono, 0);
    const saldo = saldoDe(s.id);
    return { saleId: s.id, folio: s.folio, cliente: c.nombre || '—', tel: c.tel || '', prom: s.prom, sucursal: sucMap[s.sucursalId] || '—',
      monto: s.monto, total: s.total, saldo, cobradoPeriodo, vencido: at.montoAtraso, diasAtraso: at.diasAtraso,
      estado: saldo <= 0 ? 'liquidado' : (at.montoAtraso > 0 ? (at.diasAtraso > 30 ? 'vencido' : 'atraso') : 'corriente') };
  }).sort((a, b) => b.saldo - a.saldo);
  res.json({ total: rows.length, sumSaldo: Math.round(rows.reduce((a, r) => a + r.saldo, 0)), sumCobrado: Math.round(rows.reduce((a, r) => a + r.cobradoPeriodo, 0)), clientes: rows });
});

// ===== DESGLOSE DE CARTERA SEMANAL (modelo de control por sucursal/promotor) =====
function _isoWeek(ms) {
  const d = new Date(ms); const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7; t.setUTCDate(t.getUTCDate() + 4 - day);
  const yStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  return Math.ceil((((t - yStart) / 86400000) + 1) / 7);
}
function _ultimasSemanas(n, inicioDia) {
  inicioDia = (inicioDia == null ? 4 : inicioDia); // 0=dom..6=sab · 4=jueves (ciclo típico jue→mié)
  const now = nowMx();
  const base = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const day = new Date(base).getUTCDay();
  const diff = (day - inicioDia + 7) % 7;
  const iniEsta = base - diff * 86400000;
  const meses = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
  const dias = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'];
  const out = [];
  for (let i = n - 1; i >= 0; i--) {
    const ini = iniEsta - i * 7 * 86400000;
    const fin = ini + 7 * 86400000 - 1;
    const di = new Date(ini), df = new Date(fin);
    out.push({ iso: _isoWeek(ini), desde: ini, hasta: fin, label: 'Sem ' + _isoWeek(ini), fecha: `${dias[di.getUTCDay()]} ${String(di.getUTCDate()).padStart(2, '0')} ${meses[di.getUTCMonth()]}`, rango: `${String(di.getUTCDate()).padStart(2,'0')}/${String(di.getUTCMonth()+1).padStart(2,'0')}–${String(df.getUTCDate()).padStart(2,'0')}/${String(df.getUTCMonth()+1).padStart(2,'0')}` });
  }
  return out;
}
app.get('/api/reports/desglose', auth, rol('admin', 'supervisor', 'sucursal'), (req, res) => {
  const n = Math.min(Math.max(+req.query.semanas || 12, 1), 26);
  const inicio = (req.query.inicio != null && req.query.inicio !== '') ? Math.min(Math.max(+req.query.inicio, 0), 6) : 4;
  const semanas = _ultimasSemanas(n, inicio);
  const esGerente = req.user.rol === 'sucursal';
  const miSuc = esGerente ? (db.users.find(u => u.id === req.user.id) || {}).sucursalId : null;
  let sucursales = db.sucursales.filter(s => s.activo !== false).map(s => ({ id: s.id, nombre: s.nombre }));
  if (esGerente) sucursales = sucursales.filter(s => s.id === miSuc);
  const qSuc = req.query.sucursalId ? +req.query.sucursalId : null;
  if (esGerente && qSuc && qSuc !== miSuc) return res.status(403).json({ error: 'Fuera de tu sucursal' });
  // admin/supervisor sin sucursal elegida => nivel EMPRESA (todas las sucursales juntas)
  const empresa = !esGerente && !qSuc;
  const sucursalId = esGerente ? miSuc : qSuc;
  const promotor = req.query.promotor || null;
  let suc = null, promotores = [], sales;
  if (empresa) {
    sales = db.sales.slice();
  } else {
    suc = db.sucursales.find(s => s.id === sucursalId) || { id: sucursalId, nombre: '—' };
    const cobs = db.users.filter(u => u.rol === 'cobrador' && u.sucursalId === sucursalId).map(u => u.nombre);
    const enVentas = [...new Set(db.sales.filter(s => s.sucursalId === sucursalId).map(s => s.prom).filter(Boolean))];
    promotores = [...new Set([...cobs, ...enVentas])].sort();
    sales = db.sales.filter(s => s.sucursalId === sucursalId);
    if (promotor) sales = sales.filter(s => s.prom === promotor);
  }
  const nivel = empresa ? 'empresa' : (promotor ? 'promotor' : 'sucursal');
  // precomputar movimientos por venta con timestamp
  const movsPorVenta = new Map();
  sales.forEach(s => {
    const ms = db.movimientos.filter(m => m.saleId === s.id).map(m => ({ ts: _parseFechaMx(m.fecha), cargo: m.cargo || 0, abono: m.abono || 0, forma: m.forma }));
    movsPorVenta.set(s.id, ms);
  });
  const clienteActivo = id => { const c = db.clients.find(x => x.id === id); return c ? c.activo !== false : true; };
  const expSemanal = s => s.tipo === 'diario' ? (s.cuota || 0) * 6 : (s.tipo === 'unico' ? 0 : (s.cuota || 0));

  const F = {
    valorCartera: [], debito: [], totalClientes: [], sinPago: [], pctSinPago: [], debitoSinPago: [], pctDebitoSinPago: [],
    carteraSinPago: [], pctCarteraSinPago: [], liquidados: [], eliminados: [], ventas: [], valorVentas: [], debitoVentas: [], cobranza: [], pctCobranzaDebito: []
  };
  semanas.forEach(w => {
    let valorCartera = 0, debito = 0, totalClientes = 0, sinPago = 0, debitoSinPago = 0, carteraSinPago = 0, liquidados = 0, ventas = 0, valorVentas = 0, debitoVentas = 0, cobranza = 0;
    sales.forEach(s => {
      const createdTs = new Date(s.createdAt).getTime();
      const existed = createdTs <= w.hasta;
      const createdEsta = createdTs >= w.desde && createdTs <= w.hasta;
      const ms = movsPorVenta.get(s.id) || [];
      let saldoIni = 0, saldoFin = 0, abonoSem = 0;
      ms.forEach(m => {
        if (m.ts < w.desde) saldoIni += m.cargo - m.abono;
        if (m.ts <= w.hasta) saldoFin += m.cargo - m.abono;
        if (m.ts >= w.desde && m.ts <= w.hasta && m.forma !== 'descuento') abonoSem += m.abono;
      });
      // cobranza: todo abono real de la semana sobre créditos existentes
      if (existed) cobranza += abonoSem;
      // ventas de la semana
      if (createdEsta) { ventas++; valorVentas += s.monto || 0; debitoVentas += s.cuota || 0; }
      const vigente = existed && (saldoIni > 0.5 || createdEsta) && clienteActivo(s.clientId);
      if (vigente) {
        totalClientes++;
        valorCartera += Math.max(0, saldoFin);
        const exp = expSemanal(s);
        debito += exp;
        // sin pago: vigente que NO es venta nueva de la semana, con cobro esperado, y no abonó
        if (!createdEsta && exp > 0 && abonoSem < 0.5) { sinPago++; debitoSinPago += exp; carteraSinPago += Math.max(0, saldoFin); }
      }
      // liquidados: tenía saldo al inicio y quedó en cero esta semana
      if (existed && saldoIni > 0.5 && saldoFin < 0.5) liquidados++;
    });
    const eliminados = 0; // sin fecha de baja por crédito; se reporta 0 hasta tener marca temporal
    F.valorCartera.push(Math.round(valorCartera));
    F.debito.push(Math.round(debito));
    F.totalClientes.push(totalClientes);
    F.sinPago.push(sinPago);
    F.pctSinPago.push(totalClientes ? sinPago / totalClientes : 0);
    F.debitoSinPago.push(Math.round(debitoSinPago));
    F.pctDebitoSinPago.push(debito ? debitoSinPago / debito : 0);
    F.carteraSinPago.push(Math.round(carteraSinPago));
    F.pctCarteraSinPago.push(valorCartera ? carteraSinPago / valorCartera : 0);
    F.liquidados.push(liquidados);
    F.eliminados.push(eliminados);
    F.ventas.push(ventas);
    F.valorVentas.push(Math.round(valorVentas));
    F.debitoVentas.push(Math.round(debitoVentas));
    F.cobranza.push(Math.round(cobranza));
    F.pctCobranzaDebito.push(debito ? cobranza / debito : 0);
  });
  const filas = [
    { k: 'valorCartera', lbl: 'Valor de la cartera', fmt: 'money' },
    { k: 'debito', lbl: 'Débito (cobranza esperada)', fmt: 'money' },
    { k: 'totalClientes', lbl: 'Total de clientes', fmt: 'int' },
    { k: 'sinPago', lbl: 'Clientes sin pago', fmt: 'int' },
    { k: 'pctSinPago', lbl: '% de clientes sin pago', fmt: 'pct' },
    { k: 'debitoSinPago', lbl: 'Débito clientes sin pago', fmt: 'money' },
    { k: 'pctDebitoSinPago', lbl: '% débito no pagos', fmt: 'pct' },
    { k: 'carteraSinPago', lbl: 'Cartera clientes sin pago', fmt: 'money' },
    { k: 'pctCarteraSinPago', lbl: '% cartera sin pago', fmt: 'pct' },
    { k: 'liquidados', lbl: 'Clientes liquidados', fmt: 'int' },
    { k: 'eliminados', lbl: 'Clientes eliminados', fmt: 'int' },
    { k: 'ventas', lbl: 'Número de ventas', fmt: 'int' },
    { k: 'valorVentas', lbl: 'Valor de ventas', fmt: 'money' },
    { k: 'debitoVentas', lbl: 'Débito de ventas', fmt: 'money' },
    { k: 'cobranza', lbl: 'Cobranza total', fmt: 'money' },
    { k: 'pctCobranzaDebito', lbl: 'Cobranza / débito', fmt: 'pct' }
  ].map(f => ({ ...f, vals: F[f.k] }));
  res.json({
    nivel, sucursal: suc ? { id: suc.id, nombre: suc.nombre } : null, sucursales, promotores,
    scope: empresa ? 'EMPRESA' : (promotor || 'TOTAL'), generado: new Date().toISOString(),
    semanas: semanas.map(w => ({ label: w.label, fecha: w.fecha, iso: w.iso, rango: w.rango })), filas
  });
});

app.get('/api/reports/cartera-cobrador', auth, rol('admin','supervisor'), (req, res) => {
  const promFilter = req.query.prom;
  const cobradores = db.users.filter(u => u.rol === 'cobrador' && u.activo);
  const sel = (promFilter && promFilter !== 'all') ? cobradores.filter(c => c.nombre === promFilter) : cobradores;
  const activos = new Set(db.clients.filter(c => c.activo !== false).map(c => c.id));
  const reportes = sel.map(cob => {
    const suc = db.sucursales.find(s => s.id === cob.sucursalId);
    const enc = db.users.find(u => u.rol === 'sucursal' && u.sucursalId === cob.sucursalId);
    const sus_sales = db.sales.filter(s => s.prom === cob.nombre && activos.has(s.clientId));
    const clientes = sus_sales.map(s => {
      const c = db.clients.find(x => x.id === s.clientId) || {};
      const abonos = db.movimientos.filter(m => m.saleId === s.id && m.abono > 0);
      return {
        nombre: c.nombre || '—',
        dir: [c.calle, c.col].filter(Boolean).join(', ') || '—',
        tel: c.tel || '',
        folio: s.folio,
        modalidad: _tipoLblSrv(s.tipo),
        saldo: saldoDe(s.id), cuota: s.cuota,
        estados: _ultimas16Cuotas(s, abonos),
      };
    });
    const totalP = clientes.reduce((a,c)=>a+c.estados.filter(e=>e==='p').length, 0);
    const totalN = clientes.reduce((a,c)=>a+c.estados.filter(e=>e==='n').length, 0);
    return {
      cobrador: cob.nombre, sucursal: suc ? suc.nombre : '—', encargada: enc ? enc.nombre : '—',
      kpis: {
        clientes: clientes.length,
        cartera: clientes.reduce((a,x)=>a+x.saldo, 0),
        atrasoMonto: clientes.filter(c=>c.estados.includes('n')).reduce((a,c)=>a+c.saldo, 0),
        atrasoClientes: clientes.filter(c=>c.estados.includes('n')).length,
        eficiencia: (totalP+totalN)>0 ? (totalP/(totalP+totalN)*100) : 0,
        totalP, totalN
      },
      clientes
    };
  });
  res.json({ generadoEn: new Date().toISOString(), reportes });
});

app.get('/api/health', (req, res) => res.json({ ok: true, version: 'numdiarios-v4', importBulk: true, geoZonas: true, muniFallback: true, backup: true, s21s31: true, comisConfig: true, articulos: true, ppNoComis: true, rutaCobradoHoy: true, porCobrarFiltro: true, entregasAgencia: true, asignaciones: true, sucScope: true, numerosDiarios: true, noPagos: true, contactos: true, ranking: true, objetivos100: true, semanaConfig: true, crecimiento: true, ts: Date.now() }));

/* ---------- Transferencias de cliente entre cobradores ---------- */
app.post('/api/transferencias', auth, rol('admin', 'supervisor'), (req, res) => {
  const { clientId, nuevoProm, nuevaSucursalId, motivo } = req.body;
  const c = db.clients.find(x => x.id === +clientId);
  if (!c) return res.status(404).json({ error: 'Cliente no encontrado' });
  if (!nuevoProm) return res.status(400).json({ error: 'Indica el cobrador destino' });
  const deProm = c.prom || '—';
  if (nuevoProm === deProm && (!nuevaSucursalId || +nuevaSucursalId === c.sucursalId)) {
    return res.status(400).json({ error: 'El cliente ya está asignado a ese cobrador' });
  }
  const fecha = new Date().toISOString();
  // reasigna el cliente y TODOS sus créditos vigentes (saldo > 0); el historial de movimientos queda intacto (van por saleId)
  const activosSales = db.sales.filter(s => s.clientId === c.id && saldoDe(s.id) > 0);
  activosSales.forEach(s => {
    s.historialCobrador = s.historialCobrador || [];
    s.historialCobrador.push({ de: s.prom || '—', a: nuevoProm, fecha, por: req.user.nombre });
    s.prom = nuevoProm;
    if (nuevaSucursalId) s.sucursalId = +nuevaSucursalId;
  });
  c.prom = nuevoProm;
  if (nuevaSucursalId) c.sucursalId = +nuevaSucursalId;
  db.transferencias = db.transferencias || [];
  const reg = {
    id: nextId('transferencias'), clientId: c.id, cliente: c.nombre,
    de: deProm, a: nuevoProm, nCreditos: activosSales.length,
    fecha, por: req.user.nombre, motivo: motivo || ''
  };
  db.transferencias.push(reg);
  saveDB();
  res.status(201).json({ ok: true, transferidos: activosSales.length, registro: reg });
});
app.get('/api/transferencias', auth, rol('admin', 'supervisor'), (req, res) => {
  const log = (db.transferencias || []).slice().reverse();
  res.json(log);
});
app.post('/api/transferencias/lote', auth, rol('admin', 'supervisor'), (req, res) => {
  const { clientIds, nuevoProm, nuevaSucursalId, motivo } = req.body;
  if (!Array.isArray(clientIds) || !clientIds.length) return res.status(400).json({ error: 'Selecciona al menos un cliente' });
  if (!nuevoProm) return res.status(400).json({ error: 'Indica el cobrador destino' });
  const fecha = new Date().toISOString();
  let totalClientes = 0, totalCreditos = 0;
  const fuentes = new Set(); const detalles = [];
  clientIds.forEach(cid => {
    const c = db.clients.find(x => x.id === +cid);
    if (!c) return;
    if (c.prom === nuevoProm && (!nuevaSucursalId || +nuevaSucursalId === c.sucursalId)) return;
    const deProm = c.prom || '—'; fuentes.add(deProm);
    const activos = db.sales.filter(s => s.clientId === c.id && saldoDe(s.id) > 0);
    activos.forEach(s => {
      s.historialCobrador = s.historialCobrador || [];
      s.historialCobrador.push({ de: s.prom || '—', a: nuevoProm, fecha, por: req.user.nombre });
      s.prom = nuevoProm;
      if (nuevaSucursalId) s.sucursalId = +nuevaSucursalId;
    });
    c.prom = nuevoProm;
    if (nuevaSucursalId) c.sucursalId = +nuevaSucursalId;
    totalClientes++; totalCreditos += activos.length;
    detalles.push({ cliente: c.nombre, de: deProm, nCreditos: activos.length });
  });
  if (!totalClientes) return res.status(400).json({ error: 'Ningún cliente requería transferencia (ya estaban asignados al destino)' });
  db.transferencias = db.transferencias || [];
  const deTxt = fuentes.size === 1 ? [...fuentes][0] : `${fuentes.size} cobradores`;
  const reg = {
    id: nextId('transferencias'), clientId: null,
    cliente: `Lote · ${totalClientes} cliente(s)`, de: deTxt, a: nuevoProm,
    nCreditos: totalCreditos, fecha, por: req.user.nombre, motivo: motivo || '', lote: true, detalles
  };
  db.transferencias.push(reg);
  saveDB();
  res.status(201).json({ ok: true, totalClientes, totalCreditos, registro: reg });
});

// Sirve el portal (index.html) en "/" y en cualquier ruta que NO sea /api
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api')) return next();
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

/* ---------- Arranque (multitenant) ---------- */
(async () => {
  const hayIndex = fs.existsSync(path.join(PUBLIC_DIR, 'index.html'));
  console.log('📁 Carpeta public:', PUBLIC_DIR);
  console.log('📄 index.html encontrado:', hayIndex ? 'SÍ' : 'NO  ← revisa que public/ esté junto a server.js');

  SYS = await loadSystem();
  if (!SYS) {
    // Primer arranque del modelo multitenant: crear el sistema y migrar datos existentes.
    SYS = { tenants: [], superUsers: [], userIndex: {}, seqTenant: 0 };
    SYS.superUsers.push({ nombre: 'Super Admin', usuario: 'super', passwordHash: bcrypt.hashSync(process.env.SUPER_PASS || 'super123', 8) });

    const existing = await loadRow(1); // datos previos del sistema mono-tenant (si los hay)
    if (existing && existing.users) {
      // migra los datos actuales como Agencia #1, conservando todo
      existing.config = existing.config || {};
      existing.config.brand = existing.config.brand || { nombre: 'LeGaXi / Credia' };
      normalizeTenant(existing);
      tenantCache[1] = existing; saveRow(1, existing);
      SYS.seqTenant = 1;
      SYS.tenants.push({ id: 1, nombre: existing.config.brand.nombre, activo: true, createdAt: new Date().toISOString() });
      (existing.users || []).forEach(u => { if (u.usuario) SYS.userIndex[u.usuario] = 1; });
      console.log('🔄 Datos existentes migrados a la Agencia #1 (' + existing.config.brand.nombre + ').');
    } else {
      // instalación nueva y limpia: una agencia DEMO de ejemplo
      const demo = seedDemo('CobraPro Demo');
      tenantCache[1] = demo; saveRow(1, demo);
      SYS.seqTenant = 1;
      SYS.tenants.push({ id: 1, nombre: 'CobraPro Demo', activo: true, createdAt: new Date().toISOString() });
      (demo.users || []).forEach(u => { if (u.usuario) SYS.userIndex[u.usuario] = 1; });
      console.log('🌱 Agencia DEMO creada (admin / admin123).');
    }
    saveSystem();
    console.log('🛡  Superadmin creado (super / ' + (process.env.SUPER_PASS || 'super123') + ').');
  } else {
    // precarga las agencias en memoria (para login rápido y cron)
    SYS.userIndex = SYS.userIndex || {};
    for (const t of (SYS.tenants || [])) { try { await getTenant(t.id); } catch (e) {} }
  }
  app.listen(PORT, () => console.log('🚀 CobraPro multitenant en puerto ' + PORT + (USE_PG ? ' (PostgreSQL)' : ' (archivo local)')));
})().catch(e => { console.error('❌ Error fatal al iniciar:', e); process.exit(1); });
