import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.2/firebase-app.js";
import {
  getAuth, onAuthStateChanged, signInWithEmailAndPassword,
  createUserWithEmailAndPassword, signOut
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-auth.js";
import {
  getFirestore, collection, doc, setDoc, deleteDoc, getDoc,
  onSnapshot, query, orderBy
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-firestore.js";

import { firebaseConfig } from "./firebase-config.js";
import { num, parseGcode, calcQuote } from "./engine.js";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

const $ = (s, r = document) => r.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => Math.random().toString(36).slice(2, 10);
const todayISO = () => new Date().toISOString().slice(0, 10);
const addDays = n => { const d = new Date(); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };
const nf = (n, d = 1) => new Intl.NumberFormat('it-IT', { minimumFractionDigits: d, maximumFractionDigits: d }).format(n || 0);
const eur = n => new Intl.NumberFormat('it-IT', { style: 'currency', currency: 'EUR' }).format(n || 0);
const dshort = s => { if (!s) return '—'; const d = new Date(s + 'T00:00'); return isNaN(d) ? '—' : d.toLocaleDateString('it-IT', { day: 'numeric', month: 'short' }); };
const cap = s => s ? s.charAt(0).toUpperCase() + s.slice(1) : '';
const clone = o => JSON.parse(JSON.stringify(o));

const state = {
  settings: {
    energy: 0.30, prepMin: 5, prepRate: 15, postMin: 5, postRate: 15,
    markMat: 30, markEn: 0, markLab: 0, markMach: 20, markOther: 0, minPrice: 3, vat: 22
  },
  customers: [], printers: [], spools: [], orders: [], quotes: [], movements: [], files: []
};

let q = null;
let view = 'panoramica';
let isSignUp = false;
let userRole = 'user';
let activeModalCallback = null;
let unsubscribers = [];

const VIEWS = [
  ['panoramica', 'Panoramica'],
  ['preventivi', 'Preventivi'],
  ['ordini', 'Ordini'],
  ['clienti', 'Clienti'],
  ['produzione', 'Stampanti'],
  ['magazzino', 'Magazzino'],
  ['contabilita', 'Contabilità'],
  ['archivio', 'Archivio file']
];

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('on'), 2800);
}

/* ================= AUTHENTICATION ================= */
$('#auth-toggle-btn').addEventListener('click', () => {
  isSignUp = !isSignUp;
  $('#auth-error').style.display = 'none';
  $('#auth-success').style.display = 'none';
  $('#auth-title').textContent = isSignUp ? 'Crea un account ADLAB3D' : 'Accedi al gestionale cloud';
  $('#auth-submit').textContent = isSignUp ? 'Registrati ora' : 'Accedi';
  $('#auth-toggle-btn').textContent = isSignUp ? 'Hai già un account? Accedi' : 'Non hai un account? Registrati';
});

$('#auth-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = $('#auth-email').value.trim();
  const password = $('#auth-password').value;
  const errBox = $('#auth-error');
  const okBox = $('#auth-success');
  const btn = $('#auth-submit');

  errBox.style.display = 'none';
  okBox.style.display = 'none';
  btn.disabled = true;

  try {
    if (isSignUp) {
      const cred = await createUserWithEmailAndPassword(auth, email, password);
      await setDoc(doc(db, 'users', cred.user.uid), { email, role: 'user', createdAt: todayISO() });
      okBox.textContent = 'Account creato con successo!';
      okBox.style.display = 'block';
    } else {
      await signInWithEmailAndPassword(auth, email, password);
    }
  } catch (err) {
    errBox.textContent = err.message.replace('Firebase:', '').trim();
    errBox.style.display = 'block';
  } finally {
    btn.disabled = false;
  }
});

$('#logoutbtn').addEventListener('click', () => signOut(auth));

onAuthStateChanged(auth, async (user) => {
  unsubscribers.forEach(u => u());
  unsubscribers = [];

  if (!user) {
    $('#auth-screen').style.display = 'flex';
    $('#app-container').style.display = 'none';
    return;
  }

  $('#auth-screen').style.display = 'none';
  $('#app-container').style.display = 'block';
  $('#user-email-display').textContent = user.email;

  // Controllo ruolo Admin
  const userSnap = await getDoc(doc(db, 'users', user.uid));
  if (userSnap.exists()) {
    userRole = userSnap.data().role || 'user';
  } else {
    await setDoc(doc(db, 'users', user.uid), { email: user.email, role: 'user' });
  }

  if (userRole === 'admin' && !VIEWS.some(v => v[0] === 'impostazioni')) {
    VIEWS.push(['impostazioni', 'Impostazioni']);
  }

  startRealtimeSync();
  route();
});

/* ================= FIRESTORE REAL-TIME SYNC ================= */
function startRealtimeSync() {
  // Settings globali
  unsubscribers.push(onSnapshot(doc(db, 'settings', 'global'), (snap) => {
    if (snap.exists()) Object.assign(state.settings, snap.data());
    if (view === 'impostazioni') render();
  }));

  // Collezioni
  const colls = ['customers', 'printers', 'spools', 'orders', 'quotes', 'movements', 'files'];
  colls.forEach(c => {
    const qRef = query(collection(db, c), orderBy('createdAt', 'desc'));
    unsubscribers.push(onSnapshot(qRef, (snap) => {
      state[c] = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      render();
    }, () => {
      // Fallback senza orderBy se mancano campi createdAt su vecchi doc
      onSnapshot(collection(db, c), (snap) => {
        state[c] = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        render();
      });
    }));
  });
}

async function saveDoc(coll, item) {
  if (!item.createdAt) item.createdAt = Date.now();
  await setDoc(doc(db, coll, item.id), item, { merge: true });
}

async function removeDoc(coll, id) {
  await deleteDoc(doc(db, coll, id));
}

/* ================= MODALI ================= */
function openModal(title, html, onSave) {
  $('#modal-title').textContent = title;
  $('#modal-body').innerHTML = html;
  activeModalCallback = onSave;
  $('#modal-overlay').classList.add('open');
}
function closeModal() {
  $('#modal-overlay').classList.remove('open');
  activeModalCallback = null;
}
$('#modal-close').addEventListener('click', closeModal);
$('#modal-cancel').addEventListener('click', closeModal);
$('#modal-save').addEventListener('click', () => { if (activeModalCallback) activeModalCallback(); });

/* ================= LOGICA PREVENTIVI ================= */
function newQuote() {
  const s = state.settings, p = state.printers[0], sp = state.spools[0];
  return {
    name: '', customerId: '', hours: 0, minutes: 0, grams: 0,
    spoolId: sp ? sp.id : '', spoolPrice: sp ? sp.price : 20, spoolWeight: sp ? sp.weight : 1000, markMat: s.markMat,
    printerId: p ? p.id : '', watts: p ? p.watts : 150, energy: s.energy, markEn: s.markEn,
    prepMin: s.prepMin, prepRate: s.prepRate, postMin: s.postMin, postRate: s.postRate, markLab: s.markLab,
    machPrice: p ? p.price : 600, years: p ? p.years : 4, hoursDay: p ? p.hoursDay : 8, repair: p ? p.repair : 10, markMach: s.markMach,
    extras: [], markOther: s.markOther, minPrice: s.minPrice, vat: s.vat
  };
}

const spoolLabel = s => `${s.material} ${s.colorName || ''}`.trim();
const cname = id => state.customers.find(x => x.id === id)?.name || '—';

const QS = [
  {
    id: 'info', t: 'Informazioni stampa', gcode: 1, f: [
      { k: 'name', l: 'Nome lavorazione', t: 'text', wide: 1 },
      { k: 'customerId', l: 'Cliente', t: 'select', o: () => [['', 'Nessun cliente']].concat(state.customers.map(c => [c.id, c.name])) },
      { k: 'printerId', l: 'Stampante', t: 'select', o: () => [['', 'Valori manuali']].concat(state.printers.map(p => [p.id, p.name])) },
      { k: 'hours', l: 'Ore di stampa', u: 'ore', t: 'number' },
      { k: 'minutes', l: 'Minuti', u: 'min', t: 'number' },
      { k: 'grams', l: 'Filamento stimato', u: 'g', t: 'number' }
    ]
  },
  {
    id: 'mat', t: 'Filamento', f: [
      { k: 'spoolId', l: 'Bobina a magazzino', t: 'select', o: () => [['', 'Valori manuali']].concat(state.spools.map(s => [s.id, `${spoolLabel(s)} · ${nf(s.residual, 0)}g`])) },
      { k: 'spoolPrice', l: 'Prezzo bobina', u: '€', t: 'number' },
      { k: 'spoolWeight', l: 'Peso bobina', u: 'g', t: 'number' },
      { k: 'markMat', l: 'Ricarico', u: '%', t: 'number' }
    ]
  },
  {
    id: 'en', t: 'Elettricità', f: [
      { k: 'watts', l: 'Consumo medio', u: 'W', t: 'number' },
      { k: 'energy', l: 'Costo kWh', u: '€/kWh', t: 'number' },
      { k: 'markEn', l: 'Ricarico', u: '%', t: 'number' }
    ]
  },
  {
    id: 'lab', t: 'Manodopera', f: [
      { k: 'prepMin', l: 'Preparazione/Slicing', u: 'min', t: 'number' },
      { k: 'prepRate', l: 'Tariffa prep.', u: '€/h', t: 'number' },
      { k: 'postMin', l: 'Post-processing', u: 'min', t: 'number' },
      { k: 'postRate', l: 'Tariffa post', u: '€/h', t: 'number' },
      { k: 'markLab', l: 'Ricarico', u: '%', t: 'number' }
    ]
  },
  {
    id: 'mach', t: 'Ammortamento Macchina', f: [
      { k: 'machPrice', l: 'Valore stampante', u: '€', t: 'number' },
      { k: 'years', l: 'Ammortamento', u: 'anni', t: 'number' },
      { k: 'hoursDay', l: 'Utilizzo medio', u: 'h/g', t: 'number' },
      { k: 'repair', l: 'Manutenzione', u: '%', t: 'number' },
      { k: 'markMach', l: 'Ricarico', u: '%', t: 'number' }
    ]
  },
  { id: 'oth', t: 'Inserti / Viteria / Extra', extras: 1, f: [{ k: 'markOther', l: 'Ricarico extra', u: '%', t: 'number' }] },
  {
    id: 'fin', t: 'Minimo e Fiscalità', nosub: 1, f: [
      { k: 'minPrice', l: 'Prezzo minimo imponibile', u: '€', t: 'number' },
      { k: 'vat', l: 'IVA (0% se Forfettario)', u: '%', t: 'number' }
    ]
  }
];

function fieldHTML(f) {
  const v = q[f.k];
  let ctl = '';
  if (f.t === 'select') {
    ctl = `<select id="q_${f.k}" data-qk="${f.k}">${f.o().map(o => `<option value="${esc(o[0])}"${o[0] === v ? ' selected' : ''}>${esc(o[1])}</option>`).join('')}</select>`;
  } else if (f.t === 'number') {
    ctl = `<div class="unit"><input id="q_${f.k}" data-qk="${f.k}" type="number" step="any" min="0" value="${esc(v)}">${f.u ? `<span>${f.u}</span>` : ''}</div>`;
  } else {
    ctl = `<input id="q_${f.k}" data-qk="${f.k}" type="text" value="${esc(v)}">`;
  }
  return `<label class="fld${f.wide ? ' wide' : ''}"><span class="lbl">${f.l}</span>${ctl}</label>`;
}

function extrasHTML() {
  const rows = q.extras.map((x, i) => `
    <div class="exrow">
      <input type="text" placeholder="Es. Inserti ottone M3" data-ex="${i}" data-f="label" value="${esc(x.label)}">
      <div class="unit"><input type="number" step="any" min="0" data-ex="${i}" data-f="amount" value="${esc(x.amount)}"><span>€</span></div>
      <button class="btn ghost sm" type="button" data-action="delx" data-i="${i}">✕</button>
    </div>`).join('');
  return `${rows}<div class="acts" style="margin-bottom:12px"><button class="btn sm" type="button" data-action="addx">+ Aggiungi voce extra</button></div>`;
}

function sectionsHTML() {
  return QS.map(s => `
    <section class="sec">
      <div class="sec-h"><h3>${s.t}</h3>${s.nosub ? '' : `<span class="subt" data-sub="${s.id}"></span>`}</div>
      ${s.extras ? `<div id="extras">${extrasHTML()}</div>` : ''}
      <div class="fgrid">${s.f.map(fieldHTML).join('')}</div>
      ${s.gcode ? `<label class="drop" for="gcode"><input id="gcode" type="file" accept=".gcode,.gco,.nc,.txt"><span><b>Carica file .gcode</b><small id="gmsg">Estrae automaticamente tempo e grammi dallo slicer.</small></span></label>` : ''}
    </section>`).join('');
}

function updateSummary() {
  const el = $('#summary');
  if (!el || !q) return;
  const r = calcQuote(q);
  r.rows.forEach(x => { const s = document.querySelector(`[data-sub="${x.id}"]`); if (s) s.textContent = eur(x.price); });
  const bar = r.sub > 0 ? r.rows.map(x => `<i class="seg-${x.id}" style="flex:${(x.price / r.sub).toFixed(4)} 1 0"></i>`).join('') : '';
  const margin = r.net - r.cost;

  el.innerHTML = `
    <p class="eyebrow">Totale Preventivo</p>
    <div class="big">${eur(r.total)}</div>
    <p class="muted">IVA ${nf(num(q.vat), 0)}% incl. · Imponibile ${eur(r.net)}</p>
    <div class="bar">${bar}</div>
    <dl class="tot">
      <dt>Costo vivo produzione</dt><dd class="mono">${eur(r.cost)}</dd>
      <dt>Margine netto</dt><dd class="mono" style="color:var(--ok)">${eur(margin)}</dd>
      <dt>Totale cliente</dt><dd class="mono strong">${eur(r.total)}</dd>
    </dl>
    <div class="sum-acts">
      <button class="btn" type="button" data-action="copyq">Copia testo per cliente</button>
      <button class="btn" type="button" data-action="saveq">Salva nello storico</button>
      <button class="btn pri" type="button" data-action="mkorder">Converti in Ordine</button>
    </div>`;
}

/* ================= VISTE ================= */
const ST = ['nuovo', 'da avviare', 'in stampa', 'pronto', 'consegnato'];
const stClass = s => 'st-' + String(s).replace(/ /g, '-');
const pill = s => `<span class="pill ${stClass(s)}">${esc(cap(s))}</span>`;
const head = (t, s, acts = '') => `<header class="ph"><div><h1>${t}</h1><p>${s}</p></div><div class="acts">${acts}</div></header>`;

function nextOrderNumber() {
  const y = new Date().getFullYear();
  let max = 0;
  state.orders.forEach(o => {
    const m = String(o.number || '').match(new RegExp(`^AD-${y}-(\\d+)$`));
    if (m) max = Math.max(max, parseInt(m[1], 10) || 0);
  });
  return `AD-${y}-${String(max + 1).padStart(3, '0')}`;
}

const V = {
  panoramica() {
    const activeOrders = state.orders.filter(o => o.status !== 'consegnato');
    const entrate = state.movements.filter(m => m.type === 'entrata').reduce((a, b) => a + num(b.amount), 0);
    const uscite = state.movements.filter(m => m.type === 'uscita').reduce((a, b) => a + num(b.amount), 0);
    const lowSpools = state.spools.filter(s => s.weight > 0 && (s.residual / s.weight) < 0.25);

    return head('Panoramica ADLAB3D', 'Stato operativo in tempo reale su Firebase.') + `
      <div class="kpis">
        <div class="kpi"><small>Ordini in lavorazione</small><b>${activeOrders.length}</b></div>
        <div class="kpi"><small>Bobine sotto il 25%</small><b style="color:${lowSpools.length ? 'var(--warn)' : 'inherit'}">${lowSpools.length}</b></div>
        <div class="kpi"><small>Entrate totali</small><b style="color:var(--ok)">${eur(entrate)}</b></div>
        <div class="kpi"><small>Bilancio netto</small><b>${eur(entrate - uscite)}</b></div>
      </div>
      <div class="two">
        <div class="card">
          <h3>Prossime consegne</h3>
          ${activeOrders.length ? activeOrders.slice(0, 5).map(o => `
            <div class="al">
              <div><b>${esc(o.name)}</b><br><small class="muted">${esc(o.number)} · ${esc(cname(o.customerId))} · Scad. ${dshort(o.due)}</small></div>
              ${pill(o.status)}
            </div>`).join('') : '<p class="muted">Nessun ordine attivo.</p>'}
        </div>
        <div class="card">
          <h3>Allarmi Magazzino Filamenti</h3>
          ${lowSpools.length ? lowSpools.map(s => `
            <div class="al">
              <div><span class="swatch" style="background:${esc(s.color || '#888')}"></span><b>${esc(spoolLabel(s))}</b><br><small class="muted">Rimasti ${nf(s.residual, 0)} g su ${nf(s.weight, 0)} g</small></div>
              <span class="pill st-uscita">Scorta bassa</span>
            </div>`).join('') : '<p class="muted">Tutte le bobine hanno scorta sufficiente.</p>'}
        </div>
      </div>`;
  },

  preventivi() {
    if (!q) q = newQuote();
    const hist = !state.quotes.length
      ? '<div class="empty">Nessun preventivo salvato nello storico.</div>'
      : `<div class="tw"><table><thead><tr><th>Data</th><th>Lavorazione</th><th>Cliente</th><th>Totale</th><th></th></tr></thead><tbody>
          ${state.quotes.map(r => `<tr>
            <td>${dshort(r.date)}</td>
            <td>${esc(r.q?.name || '—')}</td>
            <td>${esc(cname(r.q?.customerId))}</td>
            <td class="mono">${eur(r.total)}</td>
            <td class="act">
              <button class="btn ghost sm" data-action="loadq" data-id="${r.id}">Riapri</button>
              <button class="btn ghost sm" data-action="del" data-coll="quotes" data-id="${r.id}">Elimina</button>
            </td>
          </tr>`).join('')}
        </tbody></table></div>`;

    return head('Calcolatore Preventivi', 'Importa il G-code o imposta i parametri manualmente.', '<button class="btn" type="button" data-action="newq">Azzera campi</button>') +
      `<div class="qgrid"><form class="qform" id="qform">${sectionsHTML()}</form><aside class="sum" id="summary"></aside></div>` +
      `<h2 class="h2">Storico Preventivi</h2>${hist}`;
  },

  ordini() {
    if (!state.orders.length) return head('Ordini', 'Gestione commesse e scarico automatico bobine.', '<button class="btn pri" data-action="modal-order">+ Nuovo Ordine</button>') + '<div class="empty">Nessun ordine registrato.</div>';
    return head('Ordini', 'Impostando lo stato su Pronto o Consegnato viene scalato il filamento.', '<button class="btn pri" data-action="modal-order">+ Nuovo Ordine</button>') + `
      <div class="tw"><table><thead><tr><th>Codice</th><th>Lavorazione</th><th>Cliente</th><th>Bobina</th><th>Grammi</th><th>Scadenza</th><th>Imponibile</th><th>Stato</th><th></th></tr></thead><tbody>
        ${state.orders.map(o => `<tr>
          <td class="mono">${esc(o.number)}</td>
          <td><input type="text" data-coll="orders" data-id="${o.id}" data-key="name" value="${esc(o.name)}"></td>
          <td>${esc(cname(o.customerId))}</td>
          <td>${esc(spoolLabel(state.spools.find(s => s.id === o.spoolId) || { material: '—' }))}</td>
          <td class="mono">${nf(o.grams, 0)} g</td>
          <td><input type="date" data-coll="orders" data-id="${o.id}" data-key="due" value="${esc(o.due)}"></td>
          <td class="mono">${eur(o.net)}</td>
          <td><select class="st ${stClass(o.status)}" data-coll="orders" data-id="${o.id}" data-key="status" data-pill="1">
            ${ST.map(s => `<option value="${s}"${s === o.status ? ' selected' : ''}>${cap(s)}</option>`).join('')}
          </select></td>
          <td class="act">
            ${!o.booked ? `<button class="btn sm" title="Registra incasso in contabilità" data-action="book-order" data-id="${o.id}">€ Incassa</button>` : '<span class="muted" style="font-size:12px;margin-right:8px">Incassato</span>'}
            <button class="btn ghost sm" data-action="del" data-coll="orders" data-id="${o.id}">✕</button>
          </td>
        </tr>`).join('')}
      </tbody></table></div>`;
  },

  clienti() {
    return head('Clienti', 'Rubrica clienti condivisa.', '<button class="btn pri" data-action="modal-customer">+ Nuovo Cliente</button>') +
      (!state.customers.length ? '<div class="empty">Nessun cliente in anagrafica.</div>' : `
      <div class="tw"><table><thead><tr><th>Nome / Azienda</th><th>Telefono</th><th>Email</th><th>Note</th><th></th></tr></thead><tbody>
        ${state.customers.map(c => `<tr>
          <td><input type="text" data-coll="customers" data-id="${c.id}" data-key="name" value="${esc(c.name)}"></td>
          <td><input type="text" data-coll="customers" data-id="${c.id}" data-key="phone" value="${esc(c.phone || '')}"></td>
          <td><input type="text" data-coll="customers" data-id="${c.id}" data-key="email" value="${esc(c.email || '')}"></td>
          <td><input type="text" data-coll="customers" data-id="${c.id}" data-key="note" value="${esc(c.note || '')}"></td>
          <td class="act"><button class="btn ghost sm" data-action="del" data-coll="customers" data-id="${c.id}">Elimina</button></td>
        </tr>`).join('')}
      </tbody></table></div>`);
  },

  produzione() {
    return head('Parco Stampanti', 'Parametri di consumo e ammortamento macchine.', '<button class="btn pri" data-action="modal-printer">+ Nuova Stampante</button>') +
      (!state.printers.length ? '<div class="empty">Nessuna stampante configurata.</div>' : `
      <div class="tw"><table><thead><tr><th>Modello</th><th>Consumo (W)</th><th>Prezzo (€)</th><th>Anni ammort.</th><th>Ore/giorno</th><th>Manut. (%)</th><th></th></tr></thead><tbody>
        ${state.printers.map(p => `<tr>
          <td><input type="text" data-coll="printers" data-id="${p.id}" data-key="name" value="${esc(p.name)}"></td>
          <td><input type="number" data-coll="printers" data-id="${p.id}" data-key="watts" data-t="number" value="${esc(p.watts)}"></td>
          <td><input type="number" data-coll="printers" data-id="${p.id}" data-key="price" data-t="number" value="${esc(p.price)}"></td>
          <td><input type="number" data-coll="printers" data-id="${p.id}" data-key="years" data-t="number" value="${esc(p.years)}"></td>
          <td><input type="number" data-coll="printers" data-id="${p.id}" data-key="hoursDay" data-t="number" value="${esc(p.hoursDay)}"></td>
          <td><input type="number" data-coll="printers" data-id="${p.id}" data-key="repair" data-t="number" value="${esc(p.repair)}"></td>
          <td class="act"><button class="btn ghost sm" data-action="del" data-coll="printers" data-id="${p.id}">Elimina</button></td>
        </tr>`).join('')}
      </tbody></table></div>`);
  },

  magazzino() {
    return head('Magazzino Bobine', 'Inventario filamenti con scarico automatico.', '<button class="btn pri" data-action="modal-spool">+ Aggiungi Bobina</button>') +
      (!state.spools.length ? '<div class="empty">Magazzino vuoto.</div>' : `
      <div class="tw"><table><thead><tr><th>Materiale</th><th>Colore</th><th>Livello</th><th>Residuo (g)</th><th>Peso Iniz. (g)</th><th>Prezzo (€)</th><th></th></tr></thead><tbody>
        ${state.spools.map(s => {
          const pct = s.weight > 0 ? Math.max(0, Math.min(100, (s.residual / s.weight) * 100)) : 0;
          return `<tr>
            <td><b>${esc(s.material)}</b></td>
            <td><span class="swatch" style="background:${esc(s.color || '#888')}"></span>${esc(s.colorName || '—')}</td>
            <td><span class="rbar ${pct < 25 ? 'low' : ''}"><i style="width:${pct}%"></i></span><span class="mono">${nf(pct, 0)}%</span></td>
            <td><input type="number" data-coll="spools" data-id="${s.id}" data-key="residual" data-t="number" value="${esc(s.residual)}"></td>
            <td class="mono">${nf(s.weight, 0)} g</td>
            <td><input type="number" step="any" data-coll="spools" data-id="${s.id}" data-key="price" data-t="number" value="${esc(s.price)}"></td>
            <td class="act"><button class="btn ghost sm" data-action="del" data-coll="spools" data-id="${s.id}">Elimina</button></td>
          </tr>`;
        }).join('')}
      </tbody></table></div>`);
  },

  contabilita() {
    const entrate = state.movements.filter(m => m.type === 'entrata').reduce((a, b) => a + num(b.amount), 0);
    const uscite = state.movements.filter(m => m.type === 'uscita').reduce((a, b) => a + num(b.amount), 0);
    return head('Contabilità', 'Registro prima nota e margini ADLAB3D.', '<button class="btn pri" data-action="modal-movement">+ Registra Movimento</button>') + `
      <div class="kpis">
        <div class="kpi"><small>Entrate</small><b style="color:var(--ok)">${eur(entrate)}</b></div>
        <div class="kpi"><small>Uscite (Bobine, Ricambi, ecc.)</small><b style="color:var(--bad)">${eur(uscite)}</b></div>
        <div class="kpi"><small>Utile Netto</small><b>${eur(entrate - uscite)}</b></div>
      </div>` +
      (!state.movements.length ? '<div class="empty">Nessun movimento registrato.</div>' : `
      <div class="tw"><table><thead><tr><th>Data</th><th>Tipo</th><th>Descrizione</th><th>Importo</th><th></th></tr></thead><tbody>
        ${state.movements.map(m => `<tr>
          <td>${dshort(m.date)}</td>
          <td><span class="pill st-${m.type}">${cap(m.type)}</span></td>
          <td>${esc(m.label)}</td>
          <td class="mono">${m.type === 'uscita' ? '-' : '+'}${eur(m.amount)}</td>
          <td class="act"><button class="btn ghost sm" data-action="del" data-coll="movements" data-id="${m.id}">Elimina</button></td>
        </tr>`).join('')}
      </tbody></table></div>`);
  },

  archivio() {
    return head('Archivio Link & File 3D', 'Riferimenti a modelli STL, STEP e cartelle Drive.', '<button class="btn pri" data-action="modal-file">+ Aggiungi Riferimento</button>') +
      (!state.files.length ? '<div class="empty">Nessun file archiviato.</div>' : `
      <div class="tw"><table><thead><tr><th>Nome File / Progetto</th><th>Tipo</th><th>Link Cloud</th><th>Note</th><th></th></tr></thead><tbody>
        ${state.files.map(f => `<tr>
          <td><b>${esc(f.name)}</b></td>
          <td><span class="pill st-bozza">${esc(f.kind || 'STL')}</span></td>
          <td>${f.url ? `<a href="${esc(f.url)}" target="_blank" rel="noopener">Apri link ↗</a>` : '—'}</td>
          <td>${esc(f.note || '')}</td>
          <td class="act"><button class="btn ghost sm" data-action="del" data-coll="files" data-id="${f.id}">Elimina</button></td>
        </tr>`).join('')}
      </tbody></table></div>`);
  },

  impostazioni() {
    const F = [
      ['energy', 'Costo energia', '€/kWh'], ['prepMin', 'Preparazione default', 'min'], ['prepRate', 'Tariffa prep.', '€/h'],
      ['postMin', 'Post-processing default', 'min'], ['postRate', 'Tariffa post', '€/h'], ['markMat', 'Ricarico filamento', '%'],
      ['markEn', 'Ricarico elettricità', '%'], ['markLab', 'Ricarico manodopera', '%'], ['markMach', 'Ricarico macchina', '%'],
      ['markOther', 'Ricarico extra', '%'], ['minPrice', 'Prezzo minimo', '€'], ['vat', 'Aliquota IVA', '%']
    ];
    return head('Impostazioni Globali', 'Valori predefiniti per tutti gli utenti (Solo Admin).') + `
      <section class="sec"><div class="fgrid">
        ${F.map(f => `<label class="fld"><span class="lbl">${f[1]}</span><div class="unit"><input type="number" step="any" data-st="${f[0]}" value="${esc(state.settings[f[0]])}"><span>${f[2]}</span></div></label>`).join('')}
      </div></section>`;
  }
};

function render() {
  $('#nav').innerHTML = VIEWS.map(v => {
    const badge = v[0] === 'ordini' ? `<span class="bdg">${state.orders.filter(o => o.status !== 'consegnato').length}</span>` : '';
    return `<a href="#${v[0]}" class="${v[0] === view ? 'on' : ''}">${v[1]}${badge}</a>`;
  }).join('');
  $('#view').innerHTML = V[view]();
  if (view === 'preventivi') updateSummary();
}

function route() {
  let h = location.hash.slice(1);
  if (h === 'impostazioni' && userRole !== 'admin') { h = 'panoramica'; location.hash = '#panoramica'; }
  view = VIEWS.some(v => v[0] === h) ? h : 'panoramica';
  render();
}

/* ================= AZIONI & EVENTI ================= */
const ACTIONS = {
  theme() {
    const th = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', th);
    localStorage.setItem('adlab3d-theme', th);
  },
  newq() { q = newQuote(); render(); toast('Preventivo azzerato'); },
  addx() { q.extras.push({ label: '', amount: 0 }); $('#extras').innerHTML = extrasHTML(); updateSummary(); },
  delx(b) { q.extras.splice(+b.dataset.i, 1); $('#extras').innerHTML = extrasHTML(); updateSummary(); },
  async saveq() {
    const r = calcQuote(q);
    await saveDoc('quotes', { id: uid(), date: todayISO(), q: clone(q), net: r.net, total: r.total });
    toast('Preventivo salvato su Firebase');
  },
  loadq(b) {
    const found = state.quotes.find(x => x.id === b.dataset.id);
    if (found) { q = clone(found.q); render(); toast('Preventivo caricato'); }
  },
  copyq() {
    const r = calcQuote(q);
    const txt = `Preventivo ADLAB3D - ${q.name || 'Stampa 3D'}\n` +
      `• Tempo stimato: ${q.hours}h ${q.minutes}m\n` +
      `• Materiale: ${nf(q.grams, 0)}g\n` +
      `• Imponibile: ${eur(r.net)}\n` +
      `• Totale (IVA ${q.vat}% incl.): ${eur(r.total)}`;
    navigator.clipboard.writeText(txt);
    toast('Riepilogo copiato negli appunti');
  },
  async mkorder() {
    const r = calcQuote(q);
    await saveDoc('orders', {
      id: uid(), number: nextOrderNumber(), customerId: q.customerId || '',
      spoolId: q.spoolId || '', name: q.name || 'Lavorazione 3D', status: 'nuovo',
      due: addDays(7), net: r.net, grams: num(q.grams), deducted: false, booked: false
    });
    toast('Ordine creato!');
    location.hash = '#ordini';
  },
  async bookOrder(b) {
    const o = state.orders.find(x => x.id === b.dataset.id);
    if (!o || o.booked) return;
    await saveDoc('movements', { id: uid(), date: todayISO(), type: 'entrata', label: `Incasso Ordine ${o.number} - ${o.name}`, amount: num(o.net) });
    await saveDoc('orders', { id: o.id, booked: true });
    toast('Incasso registrato in contabilità');
  },
  async del(b) {
    await removeDoc(b.dataset.coll, b.dataset.id);
    toast('Elemento eliminato');
  },
  modalCustomer() {
    openModal('Nuovo Cliente', `
      <label class="fld"><span class="lbl">Nome / Ragione Sociale</span><input type="text" id="m-name"></label>
      <label class="fld"><span class="lbl">Telefono</span><input type="text" id="m-phone"></label>
      <label class="fld"><span class="lbl">Email</span><input type="email" id="m-email"></label>
      <label class="fld"><span class="lbl">Note</span><input type="text" id="m-note"></label>
    `, async () => {
      await saveDoc('customers', { id: uid(), name: $('#m-name').value || 'Nuovo Cliente', phone: $('#m-phone').value, email: $('#m-email').value, note: $('#m-note').value });
      closeModal(); toast('Cliente salvato');
    });
  },
  modalPrinter() {
    openModal('Nuova Stampante 3D', `
      <label class="fld"><span class="lbl">Nome Stampante (es. Bambu Lab P1S)</span><input type="text" id="m-name"></label>
      <label class="fld"><span class="lbl">Consumo medio (W)</span><input type="number" id="m-watts" value="150"></label>
      <label class="fld"><span class="lbl">Costo acquisto (€)</span><input type="number" id="m-price" value="700"></label>
    `, async () => {
      await saveDoc('printers', { id: uid(), name: $('#m-name').value || 'Stampante 3D', watts: num($('#m-watts').value), price: num($('#m-price').value), years: 4, hoursDay: 8, repair: 10 });
      closeModal(); toast('Stampante aggiunta');
    });
  },
  modalSpool() {
    openModal('Aggiungi Bobina a Magazzino', `
      <label class="fld"><span class="lbl">Materiale</span><select id="m-mat"><option>PLA</option><option>PLA Silk</option><option>PLA Matte</option><option>PETG</option><option>TPU</option><option>ABS</option><option>ASA</option></select></label>
      <label class="fld"><span class="lbl">Nome Colore</span><input type="text" id="m-cname" placeholder="Es. Nero Opaco"></label>
      <label class="fld"><span class="lbl">Colore visivo</span><input type="color" id="m-color" value="#1a1d24"></label>
      <label class="fld"><span class="lbl">Peso netto (g)</span><input type="number" id="m-weight" value="1000"></label>
      <label class="fld"><span class="lbl">Prezzo (€)</span><input type="number" step="any" id="m-price" value="20"></label>
    `, async () => {
      const w = num($('#m-weight').value) || 1000;
      await saveDoc('spools', { id: uid(), material: $('#m-mat').value, colorName: $('#m-cname').value, color: $('#m-color').value, weight: w, residual: w, price: num($('#m-price').value) });
      closeModal(); toast('Bobina aggiunta');
    });
  },
  modalOrder() {
    openModal('Nuovo Ordine Diretto', `
      <label class="fld"><span class="lbl">Lavorazione</span><input type="text" id="m-name" placeholder="Es. 10x Portachiavi personalizzati"></label>
      <label class="fld"><span class="lbl">Cliente</span><select id="m-cust"><option value="">Nessuno</option>${state.customers.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}</select></label>
      <label class="fld"><span class="lbl">Bobina usata</span><select id="m-spool"><option value="">Nessuna</option>${state.spools.map(s => `<option value="${s.id}">${esc(spoolLabel(s))}</option>`).join('')}</select></label>
      <label class="fld"><span class="lbl">Filamento necessario (g)</span><input type="number" id="m-grams" value="50"></label>
      <label class="fld"><span class="lbl">Imponibile concordato (€)</span><input type="number" step="any" id="m-net" value="15"></label>
    `, async () => {
      await saveDoc('orders', { id: uid(), number: nextOrderNumber(), name: $('#m-name').value || 'Ordine', customerId: $('#m-cust').value, spoolId: $('#m-spool').value, grams: num($('#m-grams').value), net: num($('#m-net').value), status: 'nuovo', due: addDays(7), deducted: false, booked: false });
      closeModal(); toast('Ordine creato');
    });
  },
  modalMovement() {
    openModal('Registra Movimento Contabile', `
      <label class="fld"><span class="lbl">Tipo</span><select id="m-type"><option value="entrata">Entrata (+)</option><option value="uscita">Uscita (-)</option></select></label>
      <label class="fld"><span class="lbl">Descrizione</span><input type="text" id="m-label" placeholder="Es. Acquisto 3 bobine Bambu Lab"></label>
      <label class="fld"><span class="lbl">Importo (€)</span><input type="number" step="any" id="m-amount"></label>
      <label class="fld"><span class="lbl">Data</span><input type="date" id="m-date" value="${todayISO()}"></label>
    `, async () => {
      await saveDoc('movements', { id: uid(), type: $('#m-type').value, label: $('#m-label').value || 'Movimento', amount: num($('#m-amount').value), date: $('#m-date').value });
      closeModal(); toast('Movimento registrato');
    });
  },
  modalFile() {
    openModal('Nuovo Riferimento File 3D', `
      <label class="fld"><span class="lbl">Nome modello / progetto</span><input type="text" id="m-name"></label>
      <label class="fld"><span class="lbl">Formato</span><select id="m-kind"><option>STL</option><option>STEP</option><option>3MF</option><option>F3D</option></select></label>
      <label class="fld"><span class="lbl">Link Google Drive / Cloud</span><input type="text" id="m-url" placeholder="https://..."></label>
      <label class="fld"><span class="lbl">Note</span><input type="text" id="m-note"></label>
    `, async () => {
      await saveDoc('files', { id: uid(), name: $('#m-name').value || 'Modello 3D', kind: $('#m-kind').value, url: $('#m-url').value, note: $('#m-note').value });
      closeModal(); toast('File archiviato');
    });
  }
};

document.addEventListener('click', e => {
  const b = e.target.closest('[data-action]');
  if (!b) return;
  const map = {
    'book-order': ACTIONS.bookOrder,
    'modal-customer': ACTIONS.modalCustomer,
    'modal-printer': ACTIONS.modalPrinter,
    'modal-spool': ACTIONS.modalSpool,
    'modal-order': ACTIONS.modalOrder,
    'modal-movement': ACTIONS.modalMovement,
    'modal-file': ACTIONS.modalFile
  };
  const fn = map[b.dataset.action] || ACTIONS[b.dataset.action];
  if (fn) fn(b);
});

// Input live preventivo & extra
$('#view').addEventListener('input', e => {
  const t = e.target;
  if (t.dataset.qk !== undefined) {
    q[t.dataset.qk] = t.type === 'number' ? num(t.value) : t.value;
    updateSummary();
  } else if (t.dataset.ex !== undefined) {
    q.extras[+t.dataset.ex][t.dataset.f] = t.dataset.f === 'amount' ? num(t.value) : t.value;
    updateSummary();
  }
});

// Cambio select stampante/bobina, upload G-code e modifiche tabelle
$('#view').addEventListener('change', async e => {
  const t = e.target;

  // Upload G-Code
  if (t.id === 'gcode' && t.files[0]) {
    const txt = await t.files[0].text();
    const parsed = parseGcode(txt);
    if (parsed.minutes) {
      q.hours = Math.floor(parsed.minutes / 60);
      q.minutes = parsed.minutes % 60;
      $('#q_hours').value = q.hours;
      $('#q_minutes').value = q.minutes;
    }
    if (parsed.grams) {
      q.grams = parsed.grams;
      $('#q_grams').value = q.grams;
    }
    if (!q.name) {
      q.name = t.files[0].name.replace(/\.[^.]+$/, '');
      $('#q_name').value = q.name;
    }
    $('#gmsg').textContent = `Caricato: ${t.files[0].name} (${q.hours}h ${q.minutes}m · ${q.grams}g)`;
    updateSummary();
    toast('Parametri estratti dal G-code!');
    return;
  }

  // Selezione stampante o bobina nel preventivo
  if (t.dataset.qk === 'printerId') {
    const p = state.printers.find(x => x.id === t.value);
    if (p) {
      Object.assign(q, { watts: p.watts, machPrice: p.price, years: p.years, hoursDay: p.hoursDay, repair: p.repair });
      render();
    }
    return;
  }
  if (t.dataset.qk === 'spoolId') {
    const s = state.spools.find(x => x.id === t.value);
    if (s) {
      Object.assign(q, { spoolPrice: s.price, spoolWeight: s.weight });
      render();
    }
    return;
  }

  // Impostazioni Admin
  if (t.dataset.st && userRole === 'admin') {
    state.settings[t.dataset.st] = num(t.value);
    await setDoc(doc(db, 'settings', 'global'), state.settings, { merge: true });
    toast('Impostazione salvata');
    return;
  }

  // Modifica inline nelle tabelle + Scarico magazzino automatico
  if (t.dataset.coll) {
    const coll = t.dataset.coll;
    const it = state[coll].find(x => x.id === t.dataset.id);
    if (!it) return;
    const val = t.dataset.t === 'number' ? num(t.value) : t.value;
    it[t.dataset.key] = val;

    if (coll === 'orders' && t.dataset.key === 'status' && (val === 'pronto' || val === 'consegnato') && !it.deducted && it.spoolId && it.grams > 0) {
      const sp = state.spools.find(s => s.id === it.spoolId);
      if (sp) {
        const newRes = Math.max(0, num(sp.residual) - num(it.grams));
        await saveDoc('spools', { id: sp.id, residual: newRes });
        it.deducted = true;
        toast(`Scalati ${it.grams}g da ${spoolLabel(sp)}`);
      }
    }
    await saveDoc(coll, it);
  }
});

window.addEventListener('hashchange', route);
const savedTheme = localStorage.getItem('adlab3d-theme');
if (savedTheme) document.documentElement.setAttribute('data-theme', savedTheme);
