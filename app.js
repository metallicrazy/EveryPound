// EveryPound hosted shell: Google sign-in, household lookup, and a small adapter that gives the
// budget app (index.html) the same db API it had as a Claude artifact, backed by Firestore.
import { initializeApp } from 'https://www.gstatic.com/firebasejs/11.0.2/firebase-app.js';
import { getAuth, GoogleAuthProvider, onAuthStateChanged, signInWithPopup, signInWithRedirect, getRedirectResult, signOut }
  from 'https://www.gstatic.com/firebasejs/11.0.2/firebase-auth.js';
import { initializeFirestore, persistentLocalCache, persistentMultipleTabManager, collection, doc, query, where,
  getDocs, getDocsFromServer, addDoc, setDoc, deleteDoc, onSnapshot, writeBatch, serverTimestamp }
  from 'https://www.gstatic.com/firebasejs/11.0.2/firebase-firestore.js';
import { firebaseConfig } from './firebase-config.js';

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
let fs;
try { fs = initializeFirestore(app, { localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }) }); }
catch { fs = initializeFirestore(app, {}); } // private browsing etc: no offline cache

const EP = () => window.EP;
const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const G_ICON = '<svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true"><path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9.1 3.6l6.8-6.8C35.8 2.4 30.3 0 24 0 14.6 0 6.6 5.4 2.7 13.3l7.9 6.1C12.5 13.6 17.8 9.5 24 9.5z"/><path fill="#4285F4" d="M46.1 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.4c-.5 2.9-2.2 5.3-4.6 6.9l7.4 5.7c4.3-4 6.9-9.9 6.9-17.1z"/><path fill="#FBBC05" d="M10.6 28.6c-.5-1.4-.8-3-.8-4.6s.3-3.2.8-4.6l-7.9-6.1C1 16.6 0 20.2 0 24s1 7.4 2.7 10.7l7.9-6.1z"/><path fill="#34A853" d="M24 48c6.5 0 11.9-2.1 15.9-5.8l-7.4-5.7c-2.1 1.4-4.8 2.3-8.5 2.3-6.2 0-11.5-4.1-13.4-9.9l-7.9 6.1C6.6 42.6 14.6 48 24 48z"/></svg>';

function screen(html) {
  const el = $('stateScreen'); el.innerHTML = html; el.hidden = false;
  document.querySelector('header.top').hidden = true;
  $('app').hidden = true; $('tabbar').hidden = true;
}

// ---------- sign-in ----------
function showSignIn(msg) {
  screen(`<h2>EveryPound</h2><p>Sign in to open your budget. It syncs between your phone and computer.</p>
    <button class="btn" id="signInBtn" type="button">${G_ICON}Sign in with Google</button>
    ${msg ? `<p class="fine" style="color:var(--bad)">${esc(msg)}</p>` : ''}`);
  $('signInBtn').onclick = async () => {
    const provider = new GoogleAuthProvider();
    provider.setCustomParameters({ prompt: 'select_account' });
    try { await signInWithPopup(auth, provider); }
    catch (e) {
      if (e && (e.code === 'auth/popup-blocked' || e.code === 'auth/operation-not-supported-in-this-environment')) {
        try { await signInWithRedirect(auth, provider); } catch (e2) { showSignIn(niceAuthError(e2)); }
      } else if (e && e.code !== 'auth/popup-closed-by-user' && e.code !== 'auth/cancelled-popup-request') showSignIn(niceAuthError(e));
    }
  };
}
const niceAuthError = e => e && e.code === 'auth/network-request-failed' ? "Couldn't reach Google. Check your connection and try again."
  : e && e.code === 'auth/unauthorized-domain' ? 'This web address is not allowed to sign in yet.'
  : "Sign-in didn't work. Try again.";
getRedirectResult(auth).catch(e => showSignIn(niceAuthError(e)));

// ---------- household ----------
let H = null; // { id, data }
async function findHousehold(user) {
  const email = user.email;
  const q = query(collection(fs, 'households'), where('emails', 'array-contains', email));
  let snap;
  // Ask the server, never the offline cache: an empty cache must not create a second household
  try { snap = await getDocsFromServer(q); }
  catch (e) {
    // offline on a device that has signed in before: use the household we remember
    let last = null; try { last = localStorage.getItem('ep.household.' + user.uid); } catch {}
    if (last) return { id: last, data: {} };
    throw e;
  }
  if (!snap.empty) {
    // if somehow in more than one, prefer the one we own, then the oldest
    const docs = snap.docs.slice().sort((a, b) => (b.data().owner === user.uid) - (a.data().owner === user.uid));
    return { id: docs[0].id, data: docs[0].data() };
  }
  const ref = doc(collection(fs, 'households'));
  const data = { name: 'Home', owner: user.uid, emails: [email], created: serverTimestamp() };
  await setDoc(ref, data);
  return { id: ref.id, data };
}

// ---------- db adapter (same shape the artifact build used) ----------
function makeDb(hid) {
  const base = 'households/' + hid + '/';
  return {
    collection(path) {
      const ref = collection(fs, base + path);
      return {
        onSnapshot: (cb, err) => onSnapshot(ref, { includeMetadataChanges: true }, cb, err),
        add: body => addDoc(ref, body),
      };
    },
    doc(path) {
      const ref = doc(fs, base + path);
      return {
        set: body => setDoc(ref, body),
        update: patch => setDoc(ref, patch, { merge: true }), // patches are nested maps: merge deeply
        delete: () => deleteDoc(ref),
      };
    },
  };
}

// ---------- backup: export + import ----------
const COLS = ['debts', 'debtTx', 'reminders', 'remState'];
async function exportBackup() {
  const base = 'households/' + H.id + '/';
  const out = { app: 'EveryPound', version: 1, exported: new Date().toISOString(), budgets: {} };
  const budgets = await getDocs(collection(fs, base + 'budgets'));
  for (const b of budgets.docs) {
    const tx = await getDocs(collection(fs, base + 'budgets/' + b.id + '/txns'));
    out.budgets[b.id] = { ...b.data(), txns: Object.fromEntries(tx.docs.map(t => [t.id, t.data()])) };
  }
  for (const c of COLS) {
    const snap = await getDocs(collection(fs, base + c));
    out[c] = Object.fromEntries(snap.docs.map(d => [d.id, d.data()]));
  }
  return out;
}
function download(name, text) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  a.download = name; document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

async function importBackup(data, progress) {
  if (!data || typeof data.budgets !== 'object') throw new Error('That file is not an EveryPound backup.');
  const base = 'households/' + H.id + '/';
  const writes = [];
  for (const [id, b] of Object.entries(data.budgets)) {
    const { txns, ...body } = b;
    // Firestore can't store arrays of arrays: keep history transactions as small maps
    if (Array.isArray(body.txs)) body.txs = body.txs.map(t => Array.isArray(t) ? { l: t[0], d: t[1], p: t[2], a: t[3] } : t);
    writes.push([base + 'budgets/' + id, body]);
    for (const [tid, t] of Object.entries(txns || {})) writes.push([base + 'budgets/' + id + '/txns/' + tid, t]);
  }
  for (const c of COLS) for (const [id, d] of Object.entries(data[c] || {})) writes.push([base + c + '/' + id, d]);
  for (let i = 0; i < writes.length; i += 400) {
    const batch = writeBatch(fs);
    for (const [path, body] of writes.slice(i, i + 400)) batch.set(doc(fs, path), body);
    await batch.commit();
    progress && progress(Math.min(i + 400, writes.length), writes.length);
  }
  return writes.length;
}

// Empty household: offer to bring a backup across
// ---------- first run: start fresh, or bring a backup across ----------
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const iso = d => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
const fromIso = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
// A budget runs from its start date to the day before the same date next month (same rule as "Plan next")
function periodFrom(startIso) {
  const s = fromIso(startIso), e = new Date(s.getFullYear(), s.getMonth() + 1, s.getDate() - 1);
  return { start: iso(s), end: iso(e), id: iso(e).slice(0, 7), label: MONTHS[e.getMonth()] + ' ' + e.getFullYear() };
}
const fmt = s => fromIso(s).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
// Starter buckets and lines, all at £0, for someone with nothing to import
function starterDoc(per) {
  const groups = {
    income: { name: 'Income', kind: 'income', color: 'slate', order: 0 },
    bills: { name: 'Bills', kind: 'expense', color: 'blue', order: 1 },
    spending: { name: 'Spending', kind: 'expense', color: 'red', order: 2 },
    savings: { name: 'Savings', kind: 'expense', color: 'green', order: 3 },
    debt: { name: 'Debt', kind: 'debt', color: 'purple', order: 4 },
  };
  const lines = {};
  const add = (groupId, names) => names.forEach((name, i) => { lines['l-' + groupId + i] = { name, planned: 0, groupId, order: i }; });
  add('income', ['Salary']);
  add('bills', ['Rent or mortgage', 'Council Tax', 'Gas and electric', 'Water', 'Phone', 'Broadband']);
  add('spending', ['Food shopping', 'Fuel', 'Fun money']);
  add('savings', ['Emergency fund']);
  return { label: per.label, start: per.start, end: per.end, groups, lines, skip: {} };
}

window.EP_EMPTY = () => {
  const today = new Date(), first = iso(new Date(today.getFullYear(), today.getMonth(), 1));
  screen(`<h2>Let's set up your budget</h2>
    <p>Pick the day your budget month starts. Most people use payday or the 1st.</p>
    <div class="startbox"><label for="startDate">Starts on</label><input type="date" id="startDate" value="${first}"><p class="fine" id="startRange"></p></div>
    <div class="btnrow startrow"><label class="btn ghost" for="importFile">Import a backup</label><button class="btn" type="button" id="startBtn">Start budget</button></div>
    <input type="file" id="importFile" accept=".json,application/json">
    <p class="fine" id="importMsg"></p>`);
  const showRange = () => { const v = $('startDate').value; $('startRange').textContent = v ? 'Runs ' + fmt(v) + ' – ' + fmt(periodFrom(v).end) + ', then the same dates each month' : ''; };
  $('startDate').oninput = showRange; showRange();
  $('startBtn').onclick = async () => {
    const v = $('startDate').value, msg = $('importMsg'); if (!v) { $('startDate').focus(); return; }
    const per = periodFrom(v); $('startBtn').disabled = true; msg.style.color = ''; msg.textContent = 'Setting up…';
    try { await setDoc(doc(fs, 'households/' + H.id + '/budgets/' + per.id), starterDoc(per)); document.querySelector('header.top').hidden = false; }
    catch { $('startBtn').disabled = false; msg.style.color = 'var(--bad)'; msg.textContent = "That didn't save. Check your connection and try again."; }
  };
  $('importFile').onchange = async ev => {
    const f = ev.target.files[0]; if (!f) return;
    const msg = $('importMsg'); msg.style.color = '';
    try {
      const data = JSON.parse(await f.text());
      const n = Object.keys(data.budgets || {}).length;
      msg.textContent = 'Importing ' + n + ' budgets…';
      const total = await importBackup(data, (d, t) => { msg.textContent = 'Importing… ' + Math.round(d / t * 100) + '%'; });
      msg.textContent = 'Done: ' + n + ' budgets, ' + total + ' records. Opening…';
      setTimeout(() => location.reload(), 1200);
    } catch (e) { msg.style.color = 'var(--bad)'; msg.textContent = e && e.message && !e.code ? e.message : "Import didn't finish. Check your connection and try again."; }
  };
};

// ---------- account card (Summary) ----------
window.EP_ACCOUNT = () => {
  const u = auth.currentUser; if (!u) return '';
  const pic = u.photoURL ? `<img src="${esc(u.photoURL)}" alt="" referrerpolicy="no-referrer">` : `<span class="av">${esc((u.displayName || u.email || '?')[0].toUpperCase())}</span>`;
  return `<div class="card acct"><div class="who">${pic}<div><strong>${esc(u.displayName || 'Signed in')}</strong><span>${esc(u.email)}</span></div></div>
    <div class="btnrow"><button class="btn ghost" type="button" data-ep-signout>Sign out</button><button class="btn ghost" type="button" data-ep-backup>Download backup</button></div></div>`;
};
document.addEventListener('click', async e => {
  const t = e.target.closest('[data-ep-signout],[data-ep-backup]'); if (!t) return;
  if (t.hasAttribute('data-ep-signout')) { await signOut(auth); location.reload(); return; }
  t.disabled = true; const was = t.textContent; t.textContent = 'Preparing…';
  try {
    const data = await exportBackup();
    download('everypound-backup-' + new Date().toISOString().slice(0, 10) + '.json', JSON.stringify(data));
    EP().toast('Backup downloaded');
  } catch { EP().toast("Backup didn't finish. Check your connection."); }
  finally { t.disabled = false; t.textContent = was; }
});

// ---------- start ----------
let booted = false;
onAuthStateChanged(auth, async user => {
  if (!user) { if (booted) location.reload(); else showSignIn(); return; }
  if (booted) return;
  screen('<h2>Loading your budget</h2><p>Fetching your groups and transactions.</p>');
  try {
    H = await findHousehold(user);
    try { localStorage.setItem('ep.household.' + user.uid, H.id); } catch {}
    booted = true;
    document.querySelector('header.top').hidden = false;
    EP().boot(makeDb(H.id));
  } catch (e) {
    screen(`<h2>Can't open your budget</h2><p>${e && e.code === 'permission-denied' ? 'This account does not have access yet.' : 'Check your connection, then reload the page.'}</p>
      <button class="btn ghost" type="button" data-ep-signout>Sign out</button>`);
  }
});

// ---------- offline app shell ----------
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
