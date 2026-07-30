/* ==========================================================================
   HUÉRFANOS POR AGENCIA  →  Excel
   --------------------------------------------------------------------------
   Créditos vivos cuyo campo "cobrador" NO coincide con ningún cobrador activo.
   Ese saldo sí está en la cartera, pero no aparece en el desempeño por cobrador
   ni en el semáforo.

   CÓMO SE USA
   1. Abrir  https://cobrapro.legaxia.uk/cobrapro.html  (con sesión iniciada)
   2. F12 → pestaña Console
   3. Pegar TODO este archivo y Enter
   4. Pide la contraseña de SUPER y descarga  huerfanos_por_agencia_AAAA-MM-DD.xlsx

   SOLO LEE. No escribe en la base, no toca su sesión ni el localStorage.
   No requiere el server nuevo: usa endpoints que ya existen hoy.
   ========================================================================== */
(async () => {
  const pass = prompt('Contraseña de SUPER:');
  if (!pass) { console.log('Cancelado.'); return; }

  const j = async (path, opt = {}, tk) => {
    const r = await fetch(path, {
      ...opt,
      headers: { 'Content-Type': 'application/json', ...(tk ? { Authorization: 'Bearer ' + tk } : {}), ...(opt.headers || {}) }
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error((d.error || ('HTTP ' + r.status)) + ' → ' + path);
    return d;
  };

  // Normaliza solo para DIAGNOSTICAR (acentos/espacios/mayúsculas). La detección
  // usa comparación exacta, igual que el server, para que los números cuadren.
  const norm = s => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
                     .replace(/\s+/g, ' ').trim().toUpperCase();

  // Distancia de edición: sirve para sugerir a qué cobrador se parece el nombre mal escrito.
  const lev = (a, b) => {
    a = norm(a); b = norm(b);
    const m = a.length, n = b.length;
    if (!m) return n; if (!n) return m;
    let prev = Array.from({ length: n + 1 }, (_, i) => i);
    for (let i = 1; i <= m; i++) {
      const cur = [i];
      for (let k = 1; k <= n; k++)
        cur[k] = Math.min(prev[k] + 1, cur[k - 1] + 1, prev[k - 1] + (a[i - 1] === b[k - 1] ? 0 : 1));
      prev = cur;
    }
    return prev[n];
  };

  const fnum  = v => Math.round((+v || 0) * 100) / 100;
  const fecha = v => { try { return v ? new Date(v).toLocaleDateString('es-MX') : ''; } catch (e) { return ''; } };

  /* Clasifica POR QUÉ el crédito quedó huérfano. De eso depende cómo se arregla. */
  function clasificar(prom, activos, bajas) {
    if (!String(prom || '').trim()) return { causa: 'Campo cobrador vacío', sug: '' };
    const n = norm(prom);
    const igual = activos.find(a => norm(a) === n);
    if (igual) return { causa: 'Solo difiere en mayúsculas o acentos', sug: igual };
    const baja = bajas.find(b => norm(b) === n);
    if (baja) return { causa: 'Cobrador dado de baja', sug: 'reasignar a un cobrador activo' };
    let best = null, bd = 99;
    activos.forEach(a => { const d = lev(prom, a); if (d < bd) { bd = d; best = a; } });
    const lim = Math.max(2, Math.floor(n.length * 0.34));
    if (best && bd <= lim) return { causa: 'Nombre mal escrito', sug: best + ' (difiere en ' + bd + ')' };
    return { causa: 'No existe ningún cobrador con ese nombre', sug: '' };
  }

  console.log('Entrando como SUPER…');
  const su = await j('/api/auth/login', { method: 'POST', body: JSON.stringify({ usuario: 'SUPER', password: pass }) });
  if (!su.super) throw new Error('Ese usuario no es superadmin.');
  const sTok = su.token;

  const tenants = (await j('/api/super/tenants', {}, sTok)).filter(t => t.activo !== false);
  console.log('Agencias a revisar:', tenants.map(t => t.nombre).join(' · '));

  const HDR = ['Sucursal', 'Cobrador escrito en el crédito', 'Causa', 'Sugerencia',
               'Cliente', 'Folio', 'Teléfono', 'Domicilio', 'Modalidad', 'Cuota', 'Saldo', 'Alta', 'Importado'];

  const resumen = [['Agencia', 'Créditos sin cobrador válido', 'Saldo fuera del control por cobrador', 'Nombres distintos a corregir']];
  const nombres = [['Agencia', 'Nombre escrito', 'Causa', 'Sugerencia', 'Créditos', 'Saldo']];
  const hojas = [];
  let granTotal = 0, granSaldo = 0;

  for (const t of tenants) {
    let ent;
    try { ent = await j('/api/super/enter/' + t.id, { method: 'POST' }, sTok); }
    catch (e) { console.warn('No se pudo entrar a', t.nombre, '→', e.message); continue; }
    const tk = ent.token;

    let sales, cobs, sucs, users = [];
    try {
      [sales, cobs, sucs] = await Promise.all([
        j('/api/sales', {}, tk), j('/api/cobradores', {}, tk), j('/api/sucursales', {}, tk)
      ]);
      users = await j('/api/users', {}, tk).catch(() => []);
    } catch (e) { console.warn('Error leyendo', t.nombre, '→', e.message); continue; }

    // Comparación EXACTA: el mismo criterio que usa el dashboard.
    const activosSet = new Set(cobs.map(c => c.nombre));
    const activos    = cobs.map(c => c.nombre);
    const bajas      = users.filter(u => u.rol === 'cobrador' && !u.activo).map(u => u.nombre);
    const sucMap = {}; sucs.forEach(s => sucMap[s.id] = s.nombre);

    const huerf = sales.filter(s => s.entregado !== false && (+s.saldo || 0) > 0.5 && !activosSet.has(s.prom));

    const porNombre = {};
    const aoa = [HDR];
    huerf.sort((a, b) => String(a.prom || '').localeCompare(String(b.prom || '')) || (b.saldo - a.saldo));
    huerf.forEach(s => {
      const c = clasificar(s.prom, activos, bajas);
      aoa.push([
        sucMap[s.sucursalId] || '—',
        s.prom || '(vacío)',
        c.causa,
        c.sug,
        s.cliente || '—',
        s.folio || '',
        s.tel || '',
        [s.calle, s.col].filter(Boolean).join(', '),
        s.tipo || '',
        fnum(s.cuota),
        fnum(s.saldo),
        fecha(s.createdAt),
        s.importado ? 'Sí' : 'No'
      ]);
      const k = s.prom || '(vacío)';
      if (!porNombre[k]) porNombre[k] = { n: 0, saldo: 0, causa: c.causa, sug: c.sug };
      porNombre[k].n++; porNombre[k].saldo += (+s.saldo || 0);
    });

    const saldoAg = huerf.reduce((a, s) => a + (+s.saldo || 0), 0);
    const distintos = Object.keys(porNombre).length;
    resumen.push([t.nombre, huerf.length, fnum(saldoAg), distintos]);
    granTotal += huerf.length; granSaldo += saldoAg;

    Object.keys(porNombre).sort().forEach(k => {
      const v = porNombre[k];
      nombres.push([t.nombre, k, v.causa, v.sug, v.n, fnum(v.saldo)]);
    });

    if (huerf.length) {
      const safe = String(t.nombre).replace(/[:\\/?*\[\]]/g, ' ').slice(0, 28) || ('Ag' + t.id);
      hojas.push({ name: safe, aoa });
    }
    console.log(t.nombre + ': ' + huerf.length + ' crédito(s), saldo ' + fnum(saldoAg).toLocaleString('es-MX'));
  }

  resumen.push([]);
  resumen.push(['TOTAL', granTotal, fnum(granSaldo), '']);
  resumen.push([]);
  resumen.push(['Nota: son créditos con saldo vivo cuyo campo "cobrador" no coincide con ningún cobrador activo.']);
  resumen.push(['Su saldo sí cuenta en la cartera, pero no aparece en el desempeño por cobrador ni en el semáforo.']);
  resumen.push(['Se corrige en Cartera de crédito → editar cliente, donde el cobrador es un desplegable.']);

  const sheets = [{ name: 'Resumen', aoa: resumen }, { name: 'Nombres a corregir', aoa: nombres }, ...hojas];
  const fn = 'huerfanos_por_agencia_' + new Date().toLocaleDateString('en-CA');

  // Descarga: usa el xlsxDL del panel si está; si no, SheetJS directo; si no, CSV.
  if (typeof xlsxDL === 'function') xlsxDL(fn, sheets);
  else if (window.XLSX) {
    const wb = XLSX.utils.book_new();
    sheets.forEach((s, i) => XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(s.aoa), (s.name || ('Hoja' + (i + 1))).slice(0, 31)));
    XLSX.writeFile(wb, fn + '.xlsx');
  } else {
    const csv = sheets.map(s => '### ' + s.name + '\n' + s.aoa.map(r => r.map(x => '"' + String(x == null ? '' : x).replace(/"/g, '""') + '"').join(',')).join('\n')).join('\n\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    a.download = fn + '.csv'; a.click();
  }

  console.log('LISTO → ' + granTotal + ' crédito(s) huérfano(s), saldo total ' + fnum(granSaldo).toLocaleString('es-MX'));
})();
