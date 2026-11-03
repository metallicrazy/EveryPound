// EveryPound hosted shell: Google sign-in, household lookup, and a small adapter that gives the
// budget app (index.html) the same db API it had as a Claude artifact, backed by Firestore.
import { initializeApp } from 'https://www.gstatic.com/firebasejs/11.0.2/firebase-app.js';
import { getAuth, GoogleAuthProvider, onAuthStateChanged, signInWithPopup, signInWithRedirect, getRedirectResult, signOut }
  from 'https://www.gstatic.com/firebasejs/11.0.2/firebase-auth.js';
import { initializeFirestore, persistentLocalCache, persistentMultipleTabManager, collection, doc, query, where,
  getDoc, getDocs, getDocsFromServer, getDocsFromCache, addDoc, setDoc, deleteDoc, onSnapshot, writeBatch, serverTimestamp, limit }
  from 'https://www.gstatic.com/firebasejs/11.0.2/firebase-firestore.js';
import { firebaseConfig } from './firebase-config.js';

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
let fs;
try { fs = initializeFirestore(app, { localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }) }); }
catch { fs = initializeFirestore(app, {}); } // private browsing etc: no offline cache

const EP = () => window.EP;
// Demo mode (?demo): no sign-in, starts empty, everything lives in memory and vanishes on reload
const DEMO = new URLSearchParams(location.search).has('demo');
const mem = { docs: {}, subs: [] };
const clone = v => v === undefined ? v : JSON.parse(JSON.stringify(v));
const isMap = v => v && typeof v === 'object' && !Array.isArray(v);
const mergeDeep = (a, b) => { for (const [k, v] of Object.entries(b)) { if (isMap(v) && isMap(a[k])) mergeDeep(a[k], v); else a[k] = clone(v); } return a; };
const memCol = col => Object.keys(mem.docs).filter(k => k.startsWith(col + '/') && !k.slice(col.length + 1).includes('/'))
  .map(k => ({ id: k.slice(col.length + 1), data: () => clone(mem.docs[k]) }));
const memFire = () => setTimeout(() => mem.subs.forEach(([col, cb]) => cb({ docs: memCol(col), metadata: { fromCache: false } })));
const memSet = (path, body, merge) => { mem.docs[path] = merge ? mergeDeep(mem.docs[path] || {}, body) : clone(body); memFire(); };
// The few raw reads and writes outside the adapter go through these, so demo mode never touches Firestore
const writeDoc = async (path, body, merge) => DEMO ? memSet(path, body, merge) : setDoc(doc(fs, path), body, merge ? { merge: true } : undefined);
const readDoc = async path => { if (DEMO) return clone(mem.docs[path]) || null; try { const d = await getDoc(doc(fs, path)); return d.exists() ? d.data() : null; } catch { return null; } };
const readCol = async path => DEMO ? memCol(path) : (await getDocs(collection(fs, path))).docs;
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
if (!DEMO) getRedirectResult(auth).catch(e => showSignIn(niceAuthError(e)));

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
    const owned = snap.docs.find(d => d.data().owner === user.uid), invited = snap.docs.find(d => d.data().owner !== user.uid);
    // Someone who signed in before being invited has an empty household of their own: use the shared one
    if (owned && invited) {
      let empty = false;
      try { empty = (await getDocsFromServer(query(collection(fs, 'households/' + owned.id + '/budgets'), limit(1)))).empty; } catch {}
      const pick = empty ? invited : owned; return { id: pick.id, data: pick.data() };
    }
    const pick = owned || invited; return { id: pick.id, data: pick.data() };
  }
  const ref = doc(collection(fs, 'households'));
  const data = { name: 'Home', owner: user.uid, emails: [email.toLowerCase()], created: serverTimestamp() };
  await setDoc(ref, data);
  return { id: ref.id, data };
}

// ---------- db adapter (same shape the artifact build used) ----------
function makeDb(hid) {
  const base = 'households/' + hid + '/';
  if (DEMO) return {
    collection(path) {
      const col = base + path;
      return {
        onSnapshot: cb => { mem.subs.push([col, cb]); setTimeout(() => cb({ docs: memCol(col), metadata: { fromCache: false } })); return () => {}; },
        add: async body => { const id = Math.random().toString(36).slice(2, 12); memSet(col + '/' + id, body); return { id, delete: async () => { delete mem.docs[col + '/' + id]; memFire(); } }; },
      };
    },
    doc(path) {
      const p = base + path;
      return { set: async b => memSet(p, b), update: async b => memSet(p, b, true), delete: async () => { delete mem.docs[p]; memFire(); } };
    },
  };
  return {
    collection(path) {
      const ref = collection(fs, base + path);
      if (path === 'budgets') return { onSnapshot: (cb, err) => splitListener(ref, 'start', 'budgets', cb, err, rememberCutoff), add: body => addDoc(ref, body) };
      if (path === 'debtTx') return { onSnapshot: (cb, err) => splitListener(ref, 'date', 'debtTx', cb, err), add: body => addDoc(ref, body) };
      return {
        onSnapshot: (cb, err) => onSnapshot(ref, { includeMetadataChanges: path === 'debts' || path === 'debtTx' }, cb, err),
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

// Only last month's budget, this month's and any already planned ahead are kept live, and the same for
// debt payments (from the start of last month's budget). Older ones almost never change, so they come from
// the phone's own copy and are refreshed from the server once a week. The app still gets one combined list.
const cutKey = () => 'ep.cutoff.' + (H && H.id);
function liveCutoff() {
  const today = iso(new Date());
  let c = iso(new Date(Date.now() - 62 * 864e5)); // first open: a safe two-month guess
  try { const v = localStorage.getItem(cutKey()); if (v && v <= today) c = v; } catch {}
  return c;
}
function rememberCutoff(docs) { // where last month's budget starts, for next time
  const today = iso(new Date());
  const ps = docs.map(d => d.data()).filter(p => p.start && p.end).sort((a, b) => a.start.localeCompare(b.start));
  const i = ps.findIndex(p => p.start <= today && today <= p.end); if (i < 1) return;
  try { localStorage.setItem(cutKey(), ps[i - 1].start); } catch {}
}
function splitListener(ref, field, name, cb, err, onAll) {
  const cutoff = liveCutoff();
  const liveQ = query(ref, where(field, '>=', cutoff)), histQ = query(ref, where(field, '<', cutoff));
  const key = 'ep.histAt.' + name + '.' + (H && H.id);
  let hist = [], live = null, meta = { fromCache: true }, histReady = false;
  // until the older part has loaded the list counts as "not from the server yet", so nothing
  // (like the automatic debt payment sync) acts on a partial list
  const emit = () => { if (!live) return; const all = [...hist, ...live]; if (onAll) onAll(all); cb({ docs: all, metadata: histReady ? meta : { ...meta, fromCache: true } }); };
  (async () => {
    let stale = true; try { stale = Date.now() - Number(localStorage.getItem(key) || 0) > 7 * 864e5; } catch {}
    try { if (!stale) hist = (await getDocsFromCache(histQ)).docs; } catch { stale = true; }
    if (stale || !hist.length) {
      try { hist = (await getDocsFromServer(histQ)).docs; try { localStorage.setItem(key, String(Date.now())); } catch {} }
      catch { try { hist = (await getDocsFromCache(histQ)).docs; } catch {} }
    }
    histReady = true; emit();
  })();
  return onSnapshot(liveQ, { includeMetadataChanges: true }, async snap => {
    live = snap.docs; meta = snap.metadata;
    // pick up this device's own edits to older records (the local copy has them straight away)
    try { const h = (await getDocsFromCache(histQ)).docs; if (h.length) hist = h; } catch {}
    emit();
  }, err);
}

// ---------- backup: export + import ----------
const COLS = ['debts', 'debtTx', 'reminders', 'remState'];
async function exportBackup() {
  const base = 'households/' + H.id + '/';
  const out = { app: 'EveryPound', version: 1, exported: new Date().toISOString(), budgets: {} };
  for (const b of await readCol(base + 'budgets')) {
    const tx = await readCol(base + 'budgets/' + b.id + '/txns');
    out.budgets[b.id] = { ...b.data(), txns: Object.fromEntries(tx.map(t => [t.id, t.data()])) };
  }
  for (const c of COLS) out[c] = Object.fromEntries((await readCol(base + c)).map(d => [d.id, d.data()]));
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
  if (DEMO) { writes.forEach(([path, body]) => memSet(path, body)); return writes.length; }
  for (let i = 0; i < writes.length; i += 400) {
    const batch = writeBatch(fs);
    for (const [path, body] of writes.slice(i, i + 400)) batch.set(doc(fs, path), body);
    await batch.commit();
    progress && progress(Math.min(i + 400, writes.length), writes.length);
  }
  return writes.length;
}

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
    try { await writeDoc('households/' + H.id + '/budgets/' + per.id, starterDoc(per)); META.setup = { checklist: 'active' }; writeDoc(metaPath('setup'), META.setup).catch(() => {}); document.querySelector('header.top').hidden = false; }
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
      if (DEMO) document.querySelector('header.top').hidden = false; else setTimeout(() => location.reload(), 1200);
    } catch (e) { msg.style.color = 'var(--bad)'; msg.textContent = e && e.message && !e.code ? e.message : "Import didn't finish. Check your connection and try again."; }
  };
};

// ---------- account card (Summary) ----------
const daysAgo = isoTime => Math.floor((Date.now() - new Date(isoTime).getTime()) / 864e5);
const agoText = d => d <= 0 ? 'today' : d === 1 ? 'yesterday' : d < 14 ? d + ' days ago' : Math.round(d / 7) + ' weeks ago';
function backupNudge() {
  const at = META.backup && META.backup.at;
  const created = H && H.data && H.data.created && H.data.created.toMillis ? H.data.created.toMillis() : null;
  if (at ? daysAgo(at) < 30 : !(created && Date.now() - created > 14 * 864e5)) return '';
  return `<div class="card nudge"><div><strong>${at ? 'Last backup ' + agoText(daysAgo(at)) : 'No backup yet'}</strong><span>Worth keeping a copy of your budget, just in case.</span></div><button class="btn" type="button" data-ep-backup>Download</button></div>`;
}
window.EP_ACCOUNT = () => {
  const tipsBtn = '<button class="btn ghost" type="button" data-ep-tips>Show tips again</button>';
  if (DEMO) return `<div class="card acct"><div class="who"><span class="av">D</span><div><strong>Demo mode</strong><span>Nothing here is saved. Reload to start again.</span></div></div>
    <div class="btnrow"><a class="btn ghost" href="./">Leave demo</a>${tipsBtn}</div></div>`;
  const u = auth.currentUser; if (!u) return '';
  const pic = u.photoURL ? `<img src="${esc(u.photoURL)}" alt="" referrerpolicy="no-referrer">` : `<span class="av">${esc((u.displayName || u.email || '?')[0].toUpperCase())}</span>`;
  const at = META.backup && META.backup.at, others = ((H && H.data && H.data.emails) || []).filter(e => e !== (u.email || '').toLowerCase());
  return backupNudge() + `<div class="card acct"><div class="who">${pic}<div><strong>${esc(u.displayName || 'Signed in')}</strong><span>${esc(u.email)}</span></div></div>
    <p class="acct-meta">${others.length ? 'Shared with ' + others.map(esc).join(', ') + ' · ' : ''}${at ? 'Last backup ' + agoText(daysAgo(at)) : 'No backup yet'}</p>
    <div class="btnrow"><button class="btn ghost" type="button" data-ep-signout>Sign out</button>${tipsBtn}${isOwner() ? '<button class="btn ghost" type="button" data-ep-share>Share</button>' : ''}<button class="btn ghost" type="button" data-ep-backup>Download backup</button></div></div>`;
};
document.addEventListener('click', async e => {
  const t = e.target.closest('[data-ep-signout],[data-ep-backup],[data-ep-tips],[data-ep-share]'); if (!t) return;
  if (t.hasAttribute('data-ep-signout')) { await signOut(auth); location.reload(); return; }
  if (t.hasAttribute('data-ep-tips')) { resetTips(); return; }
  if (t.hasAttribute('data-ep-share')) { openShare(); return; }
  t.disabled = true; const was = t.textContent; t.textContent = 'Preparing…';
  try {
    const data = await exportBackup();
    download('everypound-backup-' + new Date().toISOString().slice(0, 10) + '.json', JSON.stringify(data));
    META.backup = { at: new Date().toISOString(), by: DEMO ? 'demo' : (auth.currentUser || {}).email || '' };
    writeDoc(metaPath('backup'), META.backup).catch(() => {});
    EP().toast('Backup downloaded'); EP().render();
  } catch { EP().toast("Backup didn't finish. Check your connection."); }
  finally { t.disabled = false; t.textContent = was; }
});

// ---------- per-account tips state, household setup + backup info ----------
let UID = null;
const META = { tips: {}, setup: null, backup: null };
const metaPath = name => 'households/' + H.id + '/meta/' + name;
const tipsPath = () => 'households/' + H.id + '/members/' + UID;
async function loadMeta(uid) {
  UID = uid;
  const [me, setup, backup] = await Promise.all([readDoc(tipsPath()), readDoc(metaPath('setup')), readDoc(metaPath('backup'))]);
  META.tips = (me && me.tips) || {}; META.setup = setup; META.backup = backup;
}
const isOwner = () => !DEMO && !!(H && H.data && auth.currentUser && H.data.owner === auth.currentUser.uid);

// ---------- sharing the household ----------
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
function modal(html) {
  closeModal();
  document.body.insertAdjacentHTML('beforeend', `<div class="ep-modal" id="epModal" role="dialog" aria-modal="true"><div class="ep-sheet">${html}</div></div>`);
  $('epModal').addEventListener('click', e => { if (e.target.id === 'epModal' || e.target.closest('[data-ep-close]')) closeModal(); });
}
const closeModal = () => { const m = $('epModal'); if (m) m.remove(); };
function openShare() {
  const me = (auth.currentUser.email || '').toLowerCase(), emails = (H.data.emails || []).slice();
  const row = e => `<li><span>${esc(e)}${e === me ? ' <small>(you)</small>' : ''}</span>${e === me ? '' : `<button type="button" class="linkbtn" data-ep-unshare="${esc(e)}">Remove</button>`}</li>`;
  modal(`<div class="ep-head"><h2>Share this budget</h2><button class="iconbtn" type="button" data-ep-close aria-label="Close">✕</button></div>
    <p class="muted">Anyone added here signs in with that Google account and sees the same budget. Changes sync both ways.</p>
    <ul class="ep-list">${emails.map(row).join('')}</ul>
    <form id="shareForm" class="ep-add" novalidate><input id="shareEmail" type="email" autocomplete="email" placeholder="their.email@gmail.com"><button class="btn" type="submit">Add</button></form>
    <p class="err" id="shareErr" hidden></p>`);
  $('shareForm').onsubmit = async ev => {
    ev.preventDefault();
    const v = $('shareEmail').value.trim().toLowerCase(), err = $('shareErr');
    if (!EMAIL_RE.test(v)) { err.textContent = 'Enter their email address, like name@gmail.com.'; err.hidden = false; return; }
    if (emails.includes(v)) { err.textContent = 'They already have access.'; err.hidden = false; return; }
    await saveEmails([...emails, v], 'Shared with ' + v);
  };
  document.querySelectorAll('[data-ep-unshare]').forEach(b => b.onclick = () => saveEmails(emails.filter(e => e !== b.dataset.epUnshare), 'Removed ' + b.dataset.epUnshare));
}
async function saveEmails(list, msg) {
  try { await setDoc(doc(fs, 'households/' + H.id), { emails: list }, { merge: true }); H.data.emails = list; EP().toast(msg); openShare(); EP().render(); }
  catch { const err = $('shareErr'); if (err) { err.textContent = "That didn't save. Check your connection and try again."; err.hidden = false; } }
}

// ---------- setup checklist (brand-new budgets only) ----------
let checklistClosing = false;
window.EP_LEDGER_TOP = c => {
  if (!META.setup || META.setup.checklist !== 'active') return '';
  const S = EP().S, p = EP().period(); if (!p || p.archive || S.readOnly) return '';
  const items = [
    ['Add your income', c.incomePlanned > 0],
    ['Plan every pound', c.incomePlanned > 0 && c.expPlanned > 0 && c.toBudget === 0],
    ['Log your first spend', S.txns.length > 0 || S.debtTx.some(t => t.periodId === p.id)],
  ];
  const done = items.filter(x => x[1]).length;
  if (done === items.length && !checklistClosing) {
    checklistClosing = true;
    setTimeout(() => { META.setup = { checklist: 'done' }; writeDoc(metaPath('setup'), META.setup).catch(() => {}); EP().toast("You're all set up"); EP().render(); }, 1800);
  }
  return `<div class="card checklist"><div class="ck-head"><strong>Get set up</strong><span class="muted">${done} of ${items.length}</span><button class="iconbtn" type="button" data-ep-cklose aria-label="Hide checklist">✕</button></div>
    <ol>${items.map(([t, ok]) => `<li class="${ok ? 'ok' : ''}"><span class="ck" aria-hidden="true">${ok ? '✓' : ''}</span>${t}${ok ? '<span class="sr-only"> (done)</span>' : ''}</li>`).join('')}</ol></div>`;
};
document.addEventListener('click', e => {
  if (!e.target.closest('[data-ep-cklose]')) return;
  META.setup = { checklist: 'done' }; writeDoc(metaPath('setup'), META.setup).catch(() => {}); EP().render();
});

// ---------- page tips: a few short tips the first time each place is opened ----------
const visible = el => !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
const q = sel => [...document.querySelectorAll(sel)].find(visible) || null;
const TOUCH = matchMedia('(hover: none)').matches;
const appOpen = () => !$('app').hidden && $('stateScreen').hidden;
const drawerShown = () => visible($('drawer'));
const tab = () => $('app').dataset.tab;
const TOURS = [
  ['edit', () => visible($('editForm')), [
    ['#edBucket', 'Pick another bucket to move this line, say if a direct debit moves bank. Budgets you’ve already planned ahead move too.'],
    ['#edDD', 'Tick direct debit and you can swipe this line as Paid from the budget, with or without a date.', el => el.closest('label') || el],
    ['#edDue', 'Add a due date to see when it leaves. For direct debits due on a weekend or bank holiday, it shows the next working day instead.'],
  ]],
  ['line', () => drawerShown() && visible($('txAmt')), [
    ['#txAmt', 'Log spending here: the amount, where you spent it, then Add. Tap a shop to fill it in.', el => el.closest('form') || el],
    ['#refundPill', 'Got money back? Switch on Refund first and it goes back into this line.'],
    ['#moveBox summary', 'Short here but spare elsewhere? Move money shifts budget between lines, just for this month.'],
    ['[data-editpage]', 'The pencil edits the name, plan, due date, bucket and direct debit.'],
  ]],
  ['reminders', () => !!q('[data-tour=reminders]'), [
    ['[data-tour=reminders]', 'Birthdays, renewals and other once-a-year costs. Each one shows up in the budget it lands in, with a banner to add or skip it.'],
  ]],
  ['budget', () => appOpen() && !drawerShown() && (tab() === 'budget' || matchMedia('(min-width: 861px)').matches) && !!q('.row[data-line]'), [
    ['.group.income .l-plan', TOUCH ? 'Start with your income. Press and hold the amount to type what’s coming in this month.' : 'Start with your income. Click the amount to type what’s coming in this month.'],
    ['.group:not(.income) .row[data-line] .l-plan', (TOUCH ? 'Press and hold any amount to plan it, or tap a line to open it.' : 'Click any amount to plan it.') + ' Keep going until every pound has a job and the banner turns green.'],
    [() => q('.row[data-canpay="1"]') || q('.group:not(.income) .row[data-line]'), null, null, 'swipe'],
    ['#pTitleBtn', (TOUCH ? 'Tap' : 'Click') + ' the month to jump to any budget, past or future.'],
  ]],
  ['summary', () => appOpen() && !drawerShown() && visible($('side')) && !!q('.ring-wrap'), [
    ['.ring-wrap', 'Where your income goes, split by bucket.'],
    ['.seg[aria-label="Summary view"]', 'Switch between what’s planned, what’s been spent and what’s left.'],
    ['.remcard', 'Yearly reminders keep birthdays, renewals and other once-a-year costs from catching you out.'],
    ['.acct', 'Share the budget, download a backup or bring these tips back.'],
  ]],
  ['activity', () => appOpen() && tab() === 'activity' && !matchMedia('(min-width: 861px)').matches && !!q('.activity-card'), [
    ['.activity-card', 'Everything logged in this budget, newest first. Add transaction logs against any line.'],
  ]],
  ['plan', () => appOpen() && !drawerShown() && visible($('planNext')), [
    ['#planNext', 'Ready for next month? Tap this to create next month’s budget as a copy of this one, with due dates moved on. Then make any changes in the new month. This month stays as it is.'],
  ]],
];
let tourOn = false, tipsTimer = null, tipsObs = null;
const allTipsSeen = () => TOURS.every(([k]) => META.tips[k]);
function startTips() {
  if (allTipsSeen() || tipsObs) return; // nothing left to show: no page watching at all
  tipsObs = new MutationObserver(scheduleTips);
  tipsObs.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['hidden', 'data-tab'] });
  window.addEventListener('resize', scheduleTips);
  scheduleTips();
}
function stopTips() { if (tipsObs) { tipsObs.disconnect(); tipsObs = null; } window.removeEventListener('resize', scheduleTips); clearTimeout(tipsTimer); }
function scheduleTips() { if (tourOn) return; clearTimeout(tipsTimer); tipsTimer = setTimeout(checkTips, 700); }
function checkTips() {
  if (tourOn || document.body.classList.contains('typing') || $('epModal')) return;
  const ae = document.activeElement; if (ae && ae.id !== 'txAmt' && ae.matches('input:not([type=checkbox]):not([type=date]), textarea')) return;
  for (const [key, when, steps] of TOURS) if (!META.tips[key] && when()) { runTour(key, steps, when); return; }
}
function markSeen(key) {
  META.tips[key] = true;
  if (allTipsSeen()) stopTips();
  if (UID) writeDoc(tipsPath(), { tips: { [key]: true } }, true).catch(() => {});
}
function resetTips() {
  const off = Object.fromEntries(TOURS.map(([k]) => [k, false]));
  META.tips = { ...off };
  if (UID) writeDoc(tipsPath(), { tips: off }, true).catch(() => {});
  EP().toast('Tips will show again as you go'); startTips();
}
function swipeStep() {
  const row = q('.row[data-canpay="1"]') || q('.group:not(.income) .row[data-line]'); if (!row) return null;
  const paid = row.dataset.canpay === '1';
  const text = TOUCH
    ? (paid ? 'Swipe a line left to mark it Paid, or right to delete it.' : 'Swipe a line right to delete it. Direct debits also swipe left to mark them Paid.') + ' Press and hold a name to rename it.'
    : 'Hover over a line for Delete and, on direct debits, Paid. Click a name to rename it.';
  return { el: row, text, peek: TOUCH ? (paid ? 'swiped-paid' : 'swiped-del') : null };
}
// The spotlit element stays usable (try it, then Next); everything around it is dimmed and blocked.
function runTour(key, steps, when) {
  const resolve = ([sel, text, pick, kind]) => {
    if (kind === 'swipe') return swipeStep();
    const el = typeof sel === 'function' ? sel() : q(sel); if (!el) return null;
    return { el: pick ? pick(el) : el, text };
  };
  if (!steps.some(resolve)) return;
  tourOn = true;
  if (document.activeElement) document.activeElement.blur();
  document.body.insertAdjacentHTML('beforeend', `<div class="tour" id="tour"><div class="tour-hole" id="tourHole"></div>
    <div class="tour-block" data-b="t"></div><div class="tour-block" data-b="b"></div><div class="tour-block" data-b="l"></div><div class="tour-block" data-b="r"></div>
    <div class="tour-bubble" id="tourBubble" role="dialog" aria-live="polite"><p id="tourText"></p>
    <div class="tour-foot"><button type="button" class="btn ghost" id="tourSkip">Skip</button><span id="tourCount"></span><button type="button" class="btn" id="tourNext">Next</button></div></div></div>`);
  let i = -1, st = null, peekT = null, lastRect = null;
  const place = () => {
    // follow the element if the app re-draws it (e.g. after you change an amount)
    if (st && !st.el.isConnected) { const again = resolve(steps[i]); if (again) st.el = again.el; }
    if (!st) return;
    // while you're typing into something the step opened (e.g. the amount box), light that up too
    const ae = document.activeElement, typing = ae && !ae.closest('#tour') && ae.matches('input, select, textarea') ? ae : null;
    const rects = [st.el.isConnected && visible(st.el) ? st.el : null, typing].filter(Boolean).map(e => e.getBoundingClientRect());
    if (!rects.length) return;
    const pad = 6, r = { left: Math.min(...rects.map(x => x.left)), top: Math.min(...rects.map(x => x.top)), right: Math.max(...rects.map(x => x.right)), bottom: Math.max(...rects.map(x => x.bottom)) };
    r.width = r.right - r.left; r.height = r.bottom - r.top;
    const h = { l: r.left - pad, t: r.top - pad, w: r.width + pad * 2, h: r.height + pad * 2 }; lastRect = h;
    Object.assign($('tourHole').style, { left: h.l + 'px', top: h.t + 'px', width: h.w + 'px', height: h.h + 'px' });
    const set = (k, o) => Object.assign(document.querySelector(`.tour-block[data-b="${k}"]`).style, o);
    set('t', { left: 0, top: 0, width: '100%', height: Math.max(0, h.t) + 'px' });
    set('b', { left: 0, top: h.t + h.h + 'px', width: '100%', bottom: 0 });
    set('l', { left: 0, top: h.t + 'px', width: Math.max(0, h.l) + 'px', height: h.h + 'px' });
    set('r', { left: h.l + h.w + 'px', top: h.t + 'px', right: 0, height: h.h + 'px' });
    const bub = $('tourBubble'), bw = Math.min(340, innerWidth - 32); bub.style.width = bw + 'px';
    const below = r.bottom + 14 + bub.offsetHeight < innerHeight - 8;
    bub.style.top = (below ? r.bottom + 14 : Math.max(8, r.top - 14 - bub.offsetHeight)) + 'px';
    bub.style.left = Math.min(Math.max(16, r.left + r.width / 2 - bw / 2), innerWidth - bw - 16) + 'px';
  };
  const go = () => {
    // next step whose target is on screen right now (something you did may have changed the page)
    while (++i < steps.length) { st = resolve(steps[i]); if (st) break; }
    if (i >= steps.length) { end(); return; }
    st.el.scrollIntoView({ block: 'center', behavior: 'instant' });
    $('tourText').textContent = st.text;
    $('tourCount').textContent = steps.length > 1 ? (i + 1) + ' of ' + steps.length : '';
    $('tourNext').textContent = steps.slice(i + 1).some(resolve) ? 'Next' : 'Got it';
    requestAnimationFrame(place); setTimeout(place, 120);
    clearTimeout(peekT);
    if (st.peek) { // slide the row open briefly so the swipe is seen, not just described
      const row = st.el; peekT = setTimeout(() => { row.classList.add(st.peek); setTimeout(() => row.classList.remove(st.peek), 1100); }, 500);
    }
  };
  // keeps the spotlight on the element while you use it; if the page changes under the tips
  // (a line opened, a tab switched) they close quietly and come back next time you're here
  const tick = setInterval(() => { if (when && !when()) end(false); else place(); }, 250);
  // a plain tap on the spotlit item mustn't open the line: on phones only press-and-hold edits
  const guard = e => {
    if (!st || !st.el.contains(e.target)) return;
    const t = e.target.closest('[data-open], [data-plan], [data-rename]'); if (!t) return;
    if (t.matches('[data-open]') || TOUCH) { e.preventDefault(); e.stopPropagation(); }
  };
  document.addEventListener('click', guard, true);
  const end = (seen = true) => {
    clearTimeout(peekT); clearInterval(tick); document.removeEventListener('click', guard, true);
    removeEventListener('resize', place); removeEventListener('scroll', place, true); removeEventListener('keydown', onKey);
    const t = $('tour'); if (t) t.remove(); tourOn = false; if (seen) markSeen(key); scheduleTips();
  };
  const onKey = e => { if (e.key === 'Escape' && !document.body.classList.contains('typing') && !(document.activeElement && document.activeElement.matches('input'))) end(); };
  $('tourSkip').onclick = () => end();
  $('tourNext').onclick = () => { if (document.activeElement && document.activeElement.matches('input')) document.activeElement.blur(); go(); };
  addEventListener('resize', place); addEventListener('scroll', place, true); addEventListener('keydown', onKey);
  go();
}

// ---------- start ----------
let booted = false;
if (DEMO) {
  H = { id: 'demo', data: {} }; booted = true; UID = 'demo';
  document.body.insertAdjacentHTML('afterbegin', '<div class="demo-bar">Demo: nothing is saved <a href="./">Leave</a></div>');
  EP().boot(makeDb(H.id));
  startTips();
} else onAuthStateChanged(auth, async user => {
  if (!user) { if (booted) location.reload(); else showSignIn(); return; }
  if (booted) return;
  screen('<h2>Loading your budget</h2><p>Fetching your buckets and transactions.</p>');
  try {
    H = await findHousehold(user);
    try { localStorage.setItem('ep.household.' + user.uid, H.id); } catch {}
    booted = true;
    await loadMeta(user.uid);
    document.querySelector('header.top').hidden = false;
    EP().boot(makeDb(H.id));
    startTips();
  } catch (e) {
    screen(`<h2>Can't open your budget</h2><p>${e && e.code === 'permission-denied' ? 'This account does not have access yet.' : 'Check your connection, then reload the page.'}</p>
      <button class="btn ghost" type="button" data-ep-signout>Sign out</button>`);
  }
});

// ---------- offline app shell ----------
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
