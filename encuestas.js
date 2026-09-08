/* ===================== ANEXO · ENCUESTAS =====================================
   Motor de encuestas internas. Cada agencia arma sus PROPIAS plantillas desde el
   panel (secciones, preguntas, opciones) sin tocar código y sin soporte externo.

   Cómo se contesta: el admin emite una liga por persona. La liga NO pide login
   (el promotor está en campo, con celular), así que el token trae el número de
   agencia al frente para poder resolver el blob sin sesión: "3-a1b2c3…".
   Un token = una persona = un uso. Caduca.

   Identificación: la respuesta SÍ queda con nombre. Es a propósito: si alguien
   dice que le falta capacitación, hay que saber quién es para atenderlo.
   El único candado es la bandera "privada" a nivel pregunta: las preguntas que
   califican al jefe se marcan privadas y su DETALLE por persona solo lo ve el
   rol admin. Supervisor y sucursal ven de esas nada más el promedio.

   Se monta igual que el anexo grupal, y guarda dentro del blob de la agencia
   (son textos cortos, no fotos: no hay riesgo de inflar el estado).
============================================================================= */
const crypto = require('crypto');

module.exports.montar = function (app, ctx) {
  const { als, db, saveDB, nextId, auth, rol, getTenant } = ctx;
  const logOp = ctx.logOp || function () {};

  /* ---------- utilidades ---------- */
  const TIPOS = ['opcion', 'escala', 'nps', 'abierta', 'texto'];
  const MAX_ABIERTA = 1200;

  function _s(v, max) { return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max || 200); }
  function _sml(v, max) { return String(v == null ? '' : v).trim().slice(0, max || MAX_ABIERTA); }
  function _col(n) { if (!Array.isArray(db[n])) db[n] = []; return db[n]; }
  function encOn(blob) {
    const l = blob && blob.config && blob.config.modulosOff;
    return !(Array.isArray(l) && l.includes('encuestas'));
  }
  function encGuard(req, res, next) {
    return encOn(db) ? next() : res.status(403).json({ error: 'El módulo de encuestas no está activo en esta agencia' });
  }
  function esAdmin(req) { return req.user && req.user.rol === 'admin'; }
  function nuevoToken(tid) { return tid + '-' + crypto.randomBytes(10).toString('hex'); }
  function ahora() { return new Date().toISOString(); }
  function plantDe(id) { return _col('encuestas').find(p => p.id === +id) || null; }
  function sucNombre(id) {
    const s = (db.sucursales || []).find(x => x.id === +id);
    return s ? (s.nombre || ('Sucursal ' + s.id)) : '—';
  }

  /* Normaliza la plantilla que manda el panel. Los ids de pregunta se CONSERVAN al
     editar: si se renumeraran, las respuestas ya capturadas dejarían de casar. */
  function normPlantilla(entrada, previa) {
    const usados = new Set();
    (((previa || {}).secciones) || []).forEach(sec => (sec.preguntas || []).forEach(p => usados.add(p.id)));
    let seq = 0;
    function nuevoPid() { let id; do { seq++; id = 'p' + seq; } while (usados.has(id)); usados.add(id); return id; }

    const secciones = (Array.isArray(entrada.secciones) ? entrada.secciones : []).slice(0, 20).map(sec => ({
      titulo: _s(sec.titulo, 120),
      preguntas: (Array.isArray(sec.preguntas) ? sec.preguntas : []).slice(0, 40).map(p => {
        const tipo = TIPOS.includes(p.tipo) ? p.tipo : 'opcion';
        const pid = (p.id && /^p\d+$/.test(p.id)) ? p.id : nuevoPid();
        usados.add(pid);
        const q = {
          id: pid,
          tipo,
          texto: _s(p.texto, 300),
          requerida: !!p.requerida,
          privada: !!p.privada
        };
        if (tipo === 'opcion') {
          q.opciones = (Array.isArray(p.opciones) ? p.opciones : [])
            .map(o => _s(o, 120)).filter(Boolean).slice(0, 15);
          if (!q.opciones.length) q.opciones = ['Sí', 'No'];
        }
        return q;
      }).filter(q => q.texto)
    })).filter(sec => sec.preguntas.length);

    return { nombre: _s(entrada.nombre, 120), descripcion: _s(entrada.descripcion, 400), secciones };
  }

  function preguntasDe(pl) {
    const out = [];
    (pl.secciones || []).forEach(sec => (sec.preguntas || []).forEach(p => out.push(Object.assign({ seccion: sec.titulo }, p))));
    return out;
  }

  /* ---------- PLANTILLAS ---------- */

  app.get('/api/encuestas/plantillas', auth, encGuard, rol('admin', 'supervisor'), (req, res) => {
    const envios = _col('encuestasEnvios');
    res.json(_col('encuestas').map(p => {
      const e = envios.filter(x => x.plantillaId === p.id);
      return {
        id: p.id, nombre: p.nombre, descripcion: p.descripcion, activa: p.activa !== false,
        secciones: p.secciones, createdAt: p.createdAt, createdBy: p.createdBy,
        emitidos: e.length,
        contestados: e.filter(x => x.contestadoAt).length,
        preguntas: preguntasDe(p).length
      };
    }));
  });

  app.post('/api/encuestas/plantillas', auth, encGuard, rol('admin'), (req, res) => {
    const lista = _col('encuestas');
    const previa = req.body && req.body.id ? plantDe(req.body.id) : null;
    if (req.body && req.body.id && !previa) return res.status(404).json({ error: 'Plantilla no encontrada' });

    const n = normPlantilla(req.body || {}, previa);
    if (!n.nombre) return res.status(400).json({ error: 'Ponle nombre a la encuesta' });
    if (!n.secciones.length) return res.status(400).json({ error: 'La encuesta necesita al menos una pregunta con texto' });

    if (previa) {
      previa.nombre = n.nombre; previa.descripcion = n.descripcion; previa.secciones = n.secciones;
      previa.updatedAt = ahora(); previa.updatedBy = req.user.nombre;
      saveDB(); logOp('encuesta_editar', previa.id, { nombre: previa.nombre });
      return res.json({ ok: true, id: previa.id });
    }
    const nueva = {
      id: nextId('encuestas'), nombre: n.nombre, descripcion: n.descripcion, secciones: n.secciones,
      activa: true, createdAt: ahora(), createdBy: req.user.nombre
    };
    lista.push(nueva); saveDB(); logOp('encuesta_crear', nueva.id, { nombre: nueva.nombre });
    res.status(201).json({ ok: true, id: nueva.id });
  });

  app.patch('/api/encuestas/plantillas/:id', auth, encGuard, rol('admin'), (req, res) => {
    const p = plantDe(req.params.id);
    if (!p) return res.status(404).json({ error: 'Plantilla no encontrada' });
    if (req.body && req.body.activa != null) p.activa = !!req.body.activa;
    saveDB(); res.json({ ok: true, activa: p.activa !== false });
  });

  app.delete('/api/encuestas/plantillas/:id', auth, encGuard, rol('admin'), (req, res) => {
    const id = +req.params.id;
    const p = plantDe(id);
    if (!p) return res.status(404).json({ error: 'Plantilla no encontrada' });
    if (_col('encuestasEnvios').some(e => e.plantillaId === id))
      return res.status(409).json({ error: 'Esta encuesta ya se envió: no se borra para no perder las respuestas. Desactívala.' });
    db.encuestas = _col('encuestas').filter(x => x.id !== id);
    saveDB(); logOp('encuesta_borrar', id, { nombre: p.nombre });
    res.json({ ok: true });
  });

  /* ---------- CANDIDATOS A ENCUESTAR ---------- */
  /* Los encuestados son los usuarios reales de la agencia. `dias` filtra por antigüedad
     de alta del usuario, que es lo más cercano a la fecha de ingreso de la persona. */
  app.get('/api/encuestas/candidatos', auth, encGuard, rol('admin', 'supervisor'), (req, res) => {
    const dias = req.query.dias ? +req.query.dias : 0;
    const fRol = _s(req.query.rol, 30);
    const fSuc = req.query.sucursalId ? +req.query.sucursalId : null;
    const plantillaId = req.query.plantillaId ? +req.query.plantillaId : null;
    const corte = dias > 0 ? Date.now() - dias * 86400000 : null;
    const envios = _col('encuestasEnvios');

    const out = (db.users || []).filter(u => u.activo !== false && u.rol !== 'admin').filter(u => {
      if (fRol && u.rol !== fRol) return false;
      if (fSuc != null && String(u.sucursalId) !== String(fSuc)) return false;
      if (corte && !(u.createdAt && new Date(u.createdAt).getTime() >= corte)) return false;
      return true;
    }).map(u => {
      const prev = plantillaId ? envios.find(e => e.plantillaId === plantillaId && e.userId === u.id) : null;
      return {
        id: u.id, nombre: u.nombre, usuario: u.usuario, rol: u.rol,
        sucursalId: u.sucursalId, sucursal: u.sucursalId ? sucNombre(u.sucursalId) : '—',
        alta: u.createdAt || null,
        antiguedadDias: u.createdAt ? Math.floor((Date.now() - new Date(u.createdAt).getTime()) / 86400000) : null,
        yaEmitido: !!prev, yaContesto: !!(prev && prev.contestadoAt)
      };
    });
    out.sort((a, b) => (a.antiguedadDias == null ? 1e9 : a.antiguedadDias) - (b.antiguedadDias == null ? 1e9 : b.antiguedadDias));
    res.json(out);
  });

  /* ---------- EMISIÓN ---------- */
  app.post('/api/encuestas/emitir', auth, encGuard, rol('admin', 'supervisor'), (req, res) => {
    const tid = (als.getStore() || {}).tenantId;
    const pl = plantDe((req.body || {}).plantillaId);
    if (!pl) return res.status(404).json({ error: 'Plantilla no encontrada' });
    if (pl.activa === false) return res.status(409).json({ error: 'Esa encuesta está desactivada' });

    const ids = Array.isArray(req.body.userIds) ? req.body.userIds.map(Number).filter(Boolean) : [];
    if (!ids.length) return res.status(400).json({ error: 'Selecciona al menos a una persona' });
    const vig = Math.min(60, Math.max(1, +req.body.diasVigencia || 7));
    const reemitir = !!req.body.reemitir;

    const envios = _col('encuestasEnvios');
    const nuevos = [], omitidos = [];
    ids.forEach(uid => {
      const u = (db.users || []).find(x => x.id === uid);
      if (!u) return;
      const prev = envios.find(e => e.plantillaId === pl.id && e.userId === uid);
      if (prev && prev.contestadoAt) { omitidos.push(u.nombre + ' (ya contestó)'); return; }
      if (prev && !reemitir) { omitidos.push(u.nombre + ' (ya tiene liga)'); return; }
      const caduca = new Date(Date.now() + vig * 86400000).toISOString();
      if (prev) {
        prev.token = nuevoToken(tid); prev.caducaAt = caduca; prev.abiertoAt = null;
        prev.emitidoAt = ahora(); prev.emitidoPor = req.user.nombre;
        nuevos.push(prev);
      } else {
        const e = {
          id: nextId('encuestasEnvios'), plantillaId: pl.id, userId: uid,
          nombre: u.nombre, usuario: u.usuario, rolUsuario: u.rol, sucursalId: u.sucursalId == null ? null : u.sucursalId,
          token: nuevoToken(tid), emitidoAt: ahora(), emitidoPor: req.user.nombre,
          caducaAt: caduca, abiertoAt: null, contestadoAt: null
        };
        envios.push(e); nuevos.push(e);
      }
    });
    saveDB();
    logOp('encuesta_emitir', pl.id, { n: nuevos.length });
    const base = (req.headers['x-forwarded-proto'] || req.protocol || 'https') + '://' + req.get('host');
    res.json({
      ok: true, omitidos,
      ligas: nuevos.map(e => ({
        envioId: e.id, userId: e.userId, nombre: e.nombre,
        sucursal: e.sucursalId ? sucNombre(e.sucursalId) : '—',
        caducaAt: e.caducaAt, url: base + '/encuesta.html?t=' + e.token
      }))
    });
  });

  /* ---------- SEGUIMIENTO ---------- */
  app.get('/api/encuestas/envios', auth, encGuard, rol('admin', 'supervisor'), (req, res) => {
    const pid = req.query.plantillaId ? +req.query.plantillaId : null;
    const base = (req.headers['x-forwarded-proto'] || req.protocol || 'https') + '://' + req.get('host');
    const hoy = Date.now();
    const lista = _col('encuestasEnvios').filter(e => pid == null || e.plantillaId === pid).map(e => ({
      id: e.id, plantillaId: e.plantillaId, userId: e.userId, nombre: e.nombre, usuario: e.usuario,
      rolUsuario: e.rolUsuario, sucursal: e.sucursalId ? sucNombre(e.sucursalId) : '—',
      emitidoAt: e.emitidoAt, abiertoAt: e.abiertoAt, contestadoAt: e.contestadoAt, caducaAt: e.caducaAt,
      vencida: !e.contestadoAt && e.caducaAt && new Date(e.caducaAt).getTime() < hoy,
      estado: e.contestadoAt ? 'contestada' : (e.caducaAt && new Date(e.caducaAt).getTime() < hoy ? 'vencida' : (e.abiertoAt ? 'abierta' : 'pendiente')),
      url: e.contestadoAt ? null : base + '/encuesta.html?t=' + e.token
    }));
    lista.sort((a, b) => String(b.emitidoAt).localeCompare(String(a.emitidoAt)));
    res.json(lista);
  });

  app.post('/api/encuestas/envios/:id/renovar', auth, encGuard, rol('admin', 'supervisor'), (req, res) => {
    const tid = (als.getStore() || {}).tenantId;
    const e = _col('encuestasEnvios').find(x => x.id === +req.params.id);
    if (!e) return res.status(404).json({ error: 'Envío no encontrado' });
    if (e.contestadoAt) return res.status(409).json({ error: 'Esa persona ya contestó' });
    const vig = Math.min(60, Math.max(1, +((req.body || {}).diasVigencia) || 7));
    e.token = nuevoToken(tid); e.abiertoAt = null;
    e.caducaAt = new Date(Date.now() + vig * 86400000).toISOString();
    e.emitidoAt = ahora(); e.emitidoPor = req.user.nombre;
    saveDB();
    const base = (req.headers['x-forwarded-proto'] || req.protocol || 'https') + '://' + req.get('host');
    res.json({ ok: true, url: base + '/encuesta.html?t=' + e.token, caducaAt: e.caducaAt });
  });

  app.delete('/api/encuestas/envios/:id', auth, encGuard, rol('admin'), (req, res) => {
    const e = _col('encuestasEnvios').find(x => x.id === +req.params.id);
    if (!e) return res.status(404).json({ error: 'Envío no encontrado' });
    if (e.contestadoAt) return res.status(409).json({ error: 'Ya contestó: cancelar la liga no borra la respuesta' });
    db.encuestasEnvios = _col('encuestasEnvios').filter(x => x.id !== e.id);
    saveDB(); res.json({ ok: true });
  });

  /* ---------- RESULTADOS ---------- */
  /* Reglas de visibilidad:
       admin      → todo, con nombre, incluidas las preguntas privadas.
       supervisor → todo salvo el DETALLE de las privadas; de esas solo el promedio. */
  app.get('/api/encuestas/resultados', auth, encGuard, rol('admin', 'supervisor'), (req, res) => {
    const pl = plantDe(req.query.plantillaId);
    if (!pl) return res.status(404).json({ error: 'Plantilla no encontrada' });
    const verPrivadas = esAdmin(req);
    const fSuc = req.query.sucursalId ? +req.query.sucursalId : null;

    const envios = _col('encuestasEnvios').filter(e => e.plantillaId === pl.id);
    let resp = _col('encuestasResp').filter(r => r.plantillaId === pl.id);
    if (fSuc != null) resp = resp.filter(r => String(r.sucursalId) === String(fSuc));

    const preguntas = preguntasDe(pl);
    const agregados = preguntas.map(q => {
      const vals = resp.map(r => (r.r || {})[q.id]).filter(v => v !== undefined && v !== null && v !== '');
      const o = { id: q.id, seccion: q.seccion, texto: q.texto, tipo: q.tipo, privada: !!q.privada, n: vals.length };
      if (q.tipo === 'opcion') {
        o.conteo = {};
        (q.opciones || []).forEach(op => { o.conteo[op] = 0; });
        vals.forEach(v => { o.conteo[v] = (o.conteo[v] || 0) + 1; });
      } else if (q.tipo === 'escala' || q.tipo === 'nps') {
        const nums = vals.map(Number).filter(v => !isNaN(v));
        o.n = nums.length;
        o.promedio = nums.length ? Math.round((nums.reduce((a, b) => a + b, 0) / nums.length) * 10) / 10 : null;
        o.bajos = nums.filter(v => v <= 5).length;
        if (q.tipo === 'nps') {
          const pro = nums.filter(v => v >= 9).length, det = nums.filter(v => v <= 6).length;
          o.nps = nums.length ? Math.round(((pro - det) / nums.length) * 100) : null;
          o.promotores = pro; o.detractores = det; o.pasivos = nums.length - pro - det;
        }
      } else {
        // abiertas: el texto solo sale si el rol puede verlo
        o.textos = (q.privada && !verPrivadas) ? [] : resp
          .filter(r => (r.r || {})[q.id])
          .map(r => ({ nombre: r.nombre, sucursal: r.sucursalId ? sucNombre(r.sucursalId) : '—', texto: (r.r || {})[q.id] }));
        o.oculto = q.privada && !verPrivadas;
      }
      return o;
    });

    // detalle persona por persona (las privadas se recortan si no es admin)
    const detalle = resp.map(r => {
      const rr = {};
      preguntas.forEach(q => {
        if (q.privada && !verPrivadas) return;
        if ((r.r || {})[q.id] !== undefined) rr[q.id] = r.r[q.id];
      });
      return {
        id: r.id, nombre: r.nombre, usuario: r.usuario,
        sucursal: r.sucursalId ? sucNombre(r.sucursalId) : '—',
        rolUsuario: r.rolUsuario, fecha: r.fecha, antiguedadDias: r.antiguedadDias, r: rr
      };
    }).sort((a, b) => String(b.fecha).localeCompare(String(a.fecha)));

    // promedio por sucursal de las escalas (esto sí lo ve supervisor aunque sea privada)
    const porSucursal = {};
    resp.forEach(r => {
      const k = r.sucursalId == null ? '0' : String(r.sucursalId);
      porSucursal[k] = porSucursal[k] || { sucursal: r.sucursalId ? sucNombre(r.sucursalId) : '—', n: 0, escalas: {} };
      porSucursal[k].n++;
      preguntas.filter(q => q.tipo === 'escala' || q.tipo === 'nps').forEach(q => {
        const v = Number((r.r || {})[q.id]);
        if (isNaN(v)) return;
        const acc = porSucursal[k].escalas[q.id] = porSucursal[k].escalas[q.id] || { s: 0, n: 0 };
        acc.s += v; acc.n++;
      });
    });
    Object.values(porSucursal).forEach(s => {
      Object.keys(s.escalas).forEach(k => {
        s.escalas[k] = Math.round((s.escalas[k].s / s.escalas[k].n) * 10) / 10;
      });
    });

    res.json({
      plantilla: { id: pl.id, nombre: pl.nombre, descripcion: pl.descripcion, secciones: pl.secciones },
      verPrivadas,
      resumen: {
        emitidos: envios.length,
        contestados: envios.filter(e => e.contestadoAt).length,
        pendientes: envios.filter(e => !e.contestadoAt).length,
        tasa: envios.length ? Math.round((envios.filter(e => e.contestadoAt).length / envios.length) * 100) : 0
      },
      agregados, detalle, porSucursal: Object.values(porSucursal)
    });
  });

  /* ============ PÚBLICO · sin sesión ============ */
  async function conTenant(token, res, fn) {
    const m = String(token || '').match(/^(\d+)-([a-f0-9]{16,80})$/);
    if (!m) return res.status(404).json({ error: 'Liga inválida' });
    const blob = await getTenant(+m[1]);
    if (!blob) return res.status(404).json({ error: 'Liga inválida' });
    if (!encOn(blob)) return res.status(403).json({ error: 'Esta encuesta no está disponible' });
    return als.run({ tenantId: +m[1], db: blob }, fn);
  }

  app.get('/api/enc/:token', (req, res) => conTenant(req.params.token, res, () => {
    const e = _col('encuestasEnvios').find(x => x.token === req.params.token);
    if (!e) return res.status(404).json({ error: 'Liga inválida o ya usada' });
    if (e.contestadoAt) return res.status(409).json({ error: 'Esta encuesta ya fue contestada. Gracias.' });
    if (e.caducaAt && new Date(e.caducaAt).getTime() < Date.now())
      return res.status(410).json({ error: 'La liga venció. Pídele una nueva a tu administrador.' });
    const pl = plantDe(e.plantillaId);
    if (!pl || pl.activa === false) return res.status(404).json({ error: 'Encuesta no disponible' });
    if (!e.abiertoAt) { e.abiertoAt = ahora(); saveDB(); }
    res.json({
      nombre: e.nombre,
      marca: (db.config && db.config.brand && db.config.brand.nombre) || 'CobraPro',
      encuesta: { nombre: pl.nombre, descripcion: pl.descripcion, secciones: pl.secciones }
    });
  }));

  app.post('/api/enc/:token', (req, res) => conTenant(req.params.token, res, () => {
    const e = _col('encuestasEnvios').find(x => x.token === req.params.token);
    if (!e) return res.status(404).json({ error: 'Liga inválida o ya usada' });
    if (e.contestadoAt) return res.status(409).json({ error: 'Esta encuesta ya fue contestada. Gracias.' });
    if (e.caducaAt && new Date(e.caducaAt).getTime() < Date.now())
      return res.status(410).json({ error: 'La liga venció. Pídele una nueva a tu administrador.' });
    const pl = plantDe(e.plantillaId);
    if (!pl) return res.status(404).json({ error: 'Encuesta no disponible' });

    const entrada = (req.body && req.body.respuestas) || {};
    const limpio = {}, faltan = [];
    preguntasDe(pl).forEach(q => {
      let v = entrada[q.id];
      if (v === undefined || v === null || String(v).trim() === '') { if (q.requerida) faltan.push(q.texto); return; }
      if (q.tipo === 'opcion') {
        v = _s(v, 120);
        if (!(q.opciones || []).includes(v)) { if (q.requerida) faltan.push(q.texto); return; }
      } else if (q.tipo === 'escala' || q.tipo === 'nps') {
        const n = Math.round(Number(v));
        const min = q.tipo === 'nps' ? 0 : 1;
        if (isNaN(n) || n < min || n > 10) { if (q.requerida) faltan.push(q.texto); return; }
        v = n;
      } else if (q.tipo === 'texto') {
        v = _s(v, 300);
      } else {
        v = _sml(v, MAX_ABIERTA);
      }
      limpio[q.id] = v;
    });
    if (faltan.length) return res.status(400).json({ error: 'Faltan respuestas obligatorias', faltan });

    const u = (db.users || []).find(x => x.id === e.userId);
    _col('encuestasResp').push({
      id: nextId('encuestasResp'), plantillaId: pl.id, envioId: e.id, userId: e.userId,
      nombre: e.nombre, usuario: e.usuario, rolUsuario: e.rolUsuario, sucursalId: e.sucursalId,
      antiguedadDias: (u && u.createdAt) ? Math.floor((Date.now() - new Date(u.createdAt).getTime()) / 86400000) : null,
      fecha: ahora(), r: limpio
    });
    e.contestadoAt = ahora();
    e.token = 'usado-' + e.id + '-' + crypto.randomBytes(4).toString('hex'); // quema el token
    saveDB();
    res.json({ ok: true });
  }));

  console.log('📝 Anexo de encuestas montado');
};
