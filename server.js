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
const PUBLIC_DIR = path.join(__dirname, 'public');
app.use(express.static(PUBLIC_DIR));

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
  db = { users: [], sucursales: [], clients: [], sales: [], movimientos: [], caja: {}, porEntregar: [], gestiones: [], cortes: [], config: { corteAutoHora: '19:00', corteAutoDias: [1,2,3,4,5,6] }, _idem: {} };
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
  const out = db.clients.filter(c => c.activo !== false).filter(c => !q || [c.nombre, c.tel, c.calle, c.col, c.prom].join(' ').toLowerCase().includes(q))
    .map(c => ({ ...c, creditos: db.sales.filter(s => s.clientId === c.id).map(s => ({ ...s, saldo: saldoDe(s.id) })) }));
  res.json(out);
});
app.get('/api/sales', auth, (req, res) => {
  const activos = new Set(db.clients.filter(c => c.activo !== false).map(c => c.id));
  res.json(db.sales.filter(s => activos.has(s.clientId)).map(s => ({ ...s, saldo: saldoDe(s.id), cliente: (db.clients.find(c => c.id === s.clientId) || {}).nombre })));
});
app.delete('/api/clients/:id', auth, rol('admin', 'supervisor'), (req, res) => {
  const id = +req.params.id;
  const c = db.clients.find(x => x.id === id);
  if (!c) return res.status(404).json({ error: 'Cliente no encontrado' });
  c.activo = false; c.bajaAt = new Date().toISOString(); c.bajaBy = req.user.nombre;
  saveDB();
  res.json({ ok: true });
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
function calcAtraso(sale, totalAbonado){
  const cuota = sale.cuota || 0;
  const created = sale.createdAt ? new Date(sale.createdAt) : new Date();
  const dias = Math.max(0, Math.floor((Date.now() - created.getTime())/86400000));
  let cuotasDebidas = 0;
  if (sale.tipo === 'diario') cuotasDebidas = Math.min(sale.plazo || 0, dias);
  else if (sale.tipo === 'semanal') cuotasDebidas = Math.min(sale.plazo || 0, Math.floor(dias/7));
  else if (sale.tipo === 'unico') cuotasDebidas = dias >= (sale.plazo || 0) ? 1 : 0;
  else if (sale.tipo === 'p17') cuotasDebidas = Math.min(17, Math.floor(dias / ((sale.plazo || 270)/17)));
  const cuotasPagadas = cuota > 0 ? Math.floor(totalAbonado/cuota) : 0;
  const cuotasAtraso = Math.max(0, cuotasDebidas - cuotasPagadas);
  const montoAtraso = cuotasAtraso * cuota;
  const diasAtraso = sale.tipo === 'diario' ? cuotasAtraso
                   : sale.tipo === 'semanal' ? cuotasAtraso*7
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
  db.movimientos.push({ id: nextId('movimientos'), saleId: id, fecha: new Date().toLocaleDateString('es-MX'), concepto: 'Abono', origen: req.user.nombre, cargo: 0, abono: +monto, forma: forma || 'efectivo' });
  const sid = String(sale.sucursalId || 1); const f = forma || 'efectivo';
  db.caja[sid] = db.caja[sid] || { inicial: 0, efectivo: 0, banco: 0, entregas: 0 };
  if (req.user.rol === 'cobrador') {
    // cobro en ruta: el efectivo NO entra a caja, va a "por entregar" a nombre del cobrador
    if (f === 'efectivo') {
      let pe = db.porEntregar.find(p => p.prom === req.user.nombre && String(p.sucursalId) === sid);
      if (pe) pe.monto += +monto; else db.porEntregar.push({ id: nextId('porEntregar'), sucursalId: +sid, prom: req.user.nombre, monto: +monto });
    } else if (f === 'transferencia' || f === 'deposito') { db.caja[sid].banco += +monto; }
  } else {
    if (f === 'efectivo') db.caja[sid].efectivo += +monto;
    else if (f === 'transferencia' || f === 'deposito') db.caja[sid].banco += +monto;
  }
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

/* ---------- Cobrador en ruta ---------- */
app.get('/api/mi-ruta', auth, (req, res) => {
  const ventas = db.sales.filter(s => s.prom === req.user.nombre);
  res.json(ventas.map(s => {
    const c = db.clients.find(x => x.id === s.clientId) || {};
    if (c.activo === false) return null;
    const totalAbonado = db.movimientos.filter(m => m.saleId === s.id && m.abono > 0).reduce((a,m)=>a+m.abono,0);
    const at = calcAtraso(s, totalAbonado);
    return { id: s.id, folio: s.folio, nombre: c.nombre || '—', dir: [c.calle, c.col].filter(Boolean).join(', '), tel: c.tel || '', tipo: s.tipo, cuota: s.cuota, saldo: saldoDe(s.id),
      atraso: at.montoAtraso, diasAtraso: at.diasAtraso, cuotasAtraso: at.cuotasAtraso, cuotasDebidas: at.cuotasDebidas, cuotasPagadas: at.cuotasPagadas };
  }).filter(Boolean));
});
app.get('/api/cobradores', auth, (req, res) => res.json(db.users.filter(u => u.rol === 'cobrador' && u.activo).map(u => ({ id: u.id, nombre: u.nombre }))));
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
  // semana (lunes)
  const day=now.getDay(); const diff=(day===0?6:day-1);
  return new Date(now.getFullYear(),now.getMonth(),now.getDate()-diff).getTime();
}
app.get('/api/dashboard', auth, (req,res)=>{
  const periodo=req.query.periodo||'semana';
  const desde=_desdePeriodo(periodo);
  const activeClients=db.clients.filter(c=>c.activo!==false);
  const activeClientIds=new Set(activeClients.map(c=>c.id));
  const sales=db.sales.filter(s=>activeClientIds.has(s.clientId)), clients=activeClients, sucursales=db.sucursales;
  const abonos=db.movimientos.filter(m=>m.abono>0 && _parseFechaMx(m.fecha)>=desde);
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
    const nuevos_suc=nuevos.filter(s=>s.sucursalId===suc.id);
    const caja=db.caja[String(suc.id)]||{inicial:0,efectivo:0,banco:0,entregas:0};
    const enc=db.users.find(u=>u.rol==='sucursal' && u.sucursalId===suc.id);
    let atraso_monto=0, atraso_clientes=0, esperado_acum=0;
    ventas_suc.forEach(s=>{ if(saldoDe(s.id)<=0)return; const at=atrasoDe(s); esperado_acum+=at.cuotasDebidas*s.cuota; if(at.montoAtraso>0){ atraso_monto+=at.montoAtraso; atraso_clientes++; } });
    return {id:suc.id, nombre:suc.nombre, encargada:enc?enc.nombre:'—',
      pagos_recibidos:recuperado, npagos:abonos_suc.length,
      creditos_captados:nuevos_suc.length, colocado:nuevos_suc.reduce((a,s)=>a+s.monto,0),
      efectivo_caja:(caja.inicial||0)+(caja.efectivo||0)+(caja.entregas||0), banco:caja.banco||0,
      por_entregar:db.porEntregar.filter(p=>p.sucursalId===suc.id).reduce((a,p)=>a+p.monto,0),
      cartera:ventas_suc.reduce((a,s)=>a+saldoDe(s.id),0), creditos:ventas_suc.length,
      atraso_monto, atraso_clientes, esperado_acum };
  });
  const cobradores=db.users.filter(u=>u.rol==='cobrador'&&u.activo);
  const por_cobrador=cobradores.map(c=>{
    const sus_sales=sales.filter(s=>s.prom===c.nombre);
    const sus_abonos=abonos.filter(m=>{ const s=sales.find(x=>x.id===m.saleId); return s && s.prom===c.nombre; });
    const recuperado=sus_abonos.reduce((a,m)=>a+m.abono,0);
    const cartera=sus_sales.reduce((a,s)=>a+saldoDe(s.id),0);
    const por_entregar=db.porEntregar.filter(p=>p.prom===c.nombre).reduce((a,p)=>a+p.monto,0);
    const suc=sucursales.find(s=>s.id===c.sucursalId);
    let atraso_monto=0, atraso_clientes=0, esperado_acum=0;
    sus_sales.forEach(s=>{ if(saldoDe(s.id)<=0)return; const at=atrasoDe(s); esperado_acum+=at.cuotasDebidas*s.cuota; if(at.montoAtraso>0){ atraso_monto+=at.montoAtraso; atraso_clientes++; } });
    return {id:c.id, nombre:c.nombre, sucursal:suc?suc.nombre:'—', sucursalId:c.sucursalId,
      clientes:sus_sales.length, cartera, pagos_recibidos:recuperado, npagos:sus_abonos.length, por_entregar,
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
    en_caja_efectivo: Object.values(db.caja).reduce((a,c)=>a+((c.inicial||0)+(c.efectivo||0)+(c.entregas||0)),0),
    en_caja_banco: Object.values(db.caja).reduce((a,c)=>a+(c.banco||0),0),
    por_entregar: db.porEntregar.reduce((a,p)=>a+p.monto,0),
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

/* ---------- Cortes de cobrador ---------- */
function fechaMxHoyDDMM(){ const d=new Date(); return `${String(d.getDate()).padStart(2,'0')}/${String(d.getMonth()+1).padStart(2,'0')}/${d.getFullYear()}`; }
function fechaMxHoyISO(){ const d=new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; }
function generarCorte(user, isAuto){
  if (!user || !user.nombre) return { error: 'Usuario inválido' };
  const fecha = fechaMxHoyISO();
  if (db.cortes.find(c => c.prom === user.nombre && c.fecha === fecha)) return { duplicate: true };
  const hoy = fechaMxHoyDDMM();
  const pagos = db.movimientos.filter(m => m.abono > 0 && m.origen === user.nombre && m.fecha === hoy);
  const efectivo = pagos.filter(m => (m.forma||'efectivo') === 'efectivo').reduce((a,m)=>a+m.abono,0);
  const banco = pagos.filter(m => m.forma === 'transferencia' || m.forma === 'deposito').reduce((a,m)=>a+m.abono,0);
  const corte = {
    id: nextId('cortes'), prom: user.nombre, sucursalId: user.sucursalId || null,
    fecha, totalEfectivo: efectivo, totalBanco: banco, npagos: pagos.length,
    items: pagos.map(m => ({ saleId: m.saleId, monto: m.abono, forma: m.forma||'efectivo' })),
    horaEntrega: new Date().toLocaleTimeString('es-MX', { hour:'2-digit', minute:'2-digit' }),
    auto: !!isAuto, by: isAuto ? 'sistema' : 'cobrador', estado: 'pendiente', createdAt: new Date().toISOString()
  };
  db.cortes.push(corte); saveDB();
  return { corte };
}
function checkAutoCorte(){
  if (!db || !db.config) return;
  const now = new Date();
  const [hh, mm] = (db.config.corteAutoHora || '19:00').split(':').map(Number);
  const dow = now.getDay();
  const dayList = db.config.corteAutoDias || [1,2,3,4,5,6];
  if (!dayList.includes(dow)) return;
  if (now.getHours() < hh || (now.getHours() === hh && now.getMinutes() < mm)) return;
  db.users.filter(u => u.rol === 'cobrador' && u.activo).forEach(u => generarCorte(u, true));
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
app.patch('/api/config', auth, rol('admin','supervisor'), (req, res) => {
  db.config = db.config || {};
  if (req.body.corteAutoHora) db.config.corteAutoHora = req.body.corteAutoHora;
  if (Array.isArray(req.body.corteAutoDias)) db.config.corteAutoDias = req.body.corteAutoDias;
  saveDB(); res.json(db.config);
});

app.get('/api/health', (req, res) => res.json({ ok: true, ts: Date.now() }));

// Sirve el portal (index.html) en "/" y en cualquier ruta que NO sea /api
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api')) return next();
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

/* ---------- Arranque ---------- */
(async () => {
  const hayIndex = fs.existsSync(path.join(PUBLIC_DIR, 'index.html'));
  console.log('📁 Carpeta public:', PUBLIC_DIR);
  console.log('📄 index.html encontrado:', hayIndex ? 'SÍ' : 'NO  ← revisa que public/ esté en el repo junto a server.js');
  db = await loadDB();
  if (!db) { seed(); console.log('🌱 Base sembrada (admin / admin123).'); }
  else {
    // normalización para DBs ya existentes con esquema previo
    db.cortes = db.cortes || [];
    db.gestiones = db.gestiones || [];
    db.config = db.config || { corteAutoHora: '19:00', corteAutoDias: [1,2,3,4,5,6] };
    db._idem = db._idem || {};
  }
  app.listen(PORT, () => console.log('🚀 CobraPro backend en puerto ' + PORT + (USE_PG ? ' (PostgreSQL)' : ' (archivo local)') + '  ·  login admin / admin123'));
})().catch(e => { console.error('❌ Error fatal al iniciar:', e); process.exit(1); });
