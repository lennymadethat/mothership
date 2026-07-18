// Mothership PWA — core: state, hub connection, router, shared UI.
import * as sessions from './views/sessions.js';
import * as terminal from './views/terminal.js';
import * as files from './views/files.js';
import * as fleet from './views/fleet.js';
import * as machine from './views/machine.js';
import * as history from './views/history.js';
import * as settings from './views/settings.js';

/* ─────────── state ─────────── */
export const S = {
  token: localStorage.getItem('ms_token') || '', // optional; hub runs open unless a token is set
  machine: localStorage.getItem('ms_machine') || '',
  machines: [],
  online: false,          // selected machine's bridge online
  wsReady: false,
  info: null,             // machine info from snapshot
  stats: null,
  sessions: [],
  busy: new Set(),
  notifications: [],
  unread: 0,
  get defaultModel() { return localStorage.getItem('ms_model') || ''; },
};

export const fmtBytes = (n) => {
  if (!n && n !== 0) return '—';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0; while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(n >= 100 || i === 0 ? 0 : 1)} ${u[i]}`;
};
export const fmtAgo = (ts) => {
  if (!ts) return '—';
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 60) return `${s | 0}s ago`;
  if (s < 3600) return `${(s / 60) | 0}m ago`;
  if (s < 86400) return `${(s / 3600) | 0}h ago`;
  return new Date(ts).toLocaleDateString();
};
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const BLOCKED_TAGS = new Set(['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'FORM', 'LINK', 'META', 'BASE']);
function sanitizeHtml(html) {
  const tpl = document.createElement('template');
  tpl.innerHTML = html;
  const walk = (node) => {
    for (const el of [...node.querySelectorAll('*')]) {
      if (BLOCKED_TAGS.has(el.tagName)) { el.remove(); continue; }
      for (const attr of [...el.attributes]) {
        const n = attr.name.toLowerCase();
        if (n.startsWith('on') || ((n === 'href' || n === 'src') && /^\s*javascript:/i.test(attr.value))) el.removeAttribute(attr.name);
      }
    }
  };
  walk(tpl.content);
  return tpl.innerHTML;
}
export const md = (text) => {
  try { return sanitizeHtml(window.marked.parse(String(text ?? ''), { breaks: true, mangle: false, headerIds: false })); }
  catch { return `<p>${esc(text)}</p>`; }
};

/* ─────────── REST api ─────────── */
export async function api(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
  if (S.token) headers.Authorization = `Bearer ${S.token}`;
  const res = await fetch(path, { ...opts, headers });
  if (res.status === 401) throw new Error('unauthorized');
  return res.json();
}

/* ─────────── hub websocket ─────────── */
let ws = null;
let wsBackoff = 1000;
let reqId = 0;
const pending = new Map();   // id -> {resolve, timer}
const handlers = new Map();  // type -> Set<fn>

export function on(type, fn) {
  if (!handlers.has(type)) handlers.set(type, new Set());
  handlers.get(type).add(fn);
  return () => handlers.get(type).delete(fn);
}
function emit(type, msg) {
  (handlers.get(type) || []).forEach((fn) => { try { fn(msg); } catch (e) { console.error(e); } });
}

export function send(obj) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
}

export function req(type, payload = {}, timeoutMs = 25000) {
  return new Promise((resolve, reject) => {
    if (!ws || ws.readyState !== 1) return reject(new Error('not connected'));
    const id = `r${++reqId}`;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('timeout')); }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    ws.send(JSON.stringify({ type, id, ...payload }));
  });
}

export function connectWs() {
  if (!S.machine) return;
  if (ws) { try { ws.onclose = null; ws.close(); } catch {} }
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const q = S.token ? `?token=${encodeURIComponent(S.token)}` : '';
  ws = new WebSocket(`${proto}://${location.host}/api/machine/${S.machine}/ws${q}`);

  ws.onopen = () => {
    wsBackoff = 1000;
    S.wsReady = true;
    send({ type: 'client.hello' });
    updateConnDot();
  };

  ws.onmessage = (e) => {
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }
    if (msg.type === 'res' && msg.id && pending.has(msg.id)) {
      const p = pending.get(msg.id);
      pending.delete(msg.id); clearTimeout(p.timer);
      if (msg.error) p.reject(new Error(msg.error)); else p.resolve(msg);
      return;
    }
    switch (msg.type) {
      case 'hub.hello': S.online = msg.online; updateConnDot(); break;
      case 'machine.online': S.online = true; updateConnDot(); toast(`${S.machine} online`, 'ok'); send({ type: 'client.hello' }); break;
      case 'machine.offline': S.online = false; updateConnDot(); break;
      case 'snapshot':
        S.info = msg.info; S.stats = msg.stats; S.sessions = msg.sessions || [];
        S.busy = new Set(msg.busy || []); S.online = true; updateConnDot(); updateSessionsBadge();
        break;
      case 'sessions': S.sessions = msg.sessions || []; updateSessionsBadge(); break;
      case 'stats': S.stats = msg.stats; break;
      case 'notification':
        S.notifications.unshift(msg); S.unread++; updateBell();
        toast(`${msg.title}`, 'ok');
        break;
    }
    emit(msg.type, msg);
  };

  ws.onclose = () => {
    S.wsReady = false; updateConnDot();
    setTimeout(() => connectWs(), wsBackoff);
    wsBackoff = Math.min(wsBackoff * 2, 15000);
  };
}
document.addEventListener('visibilitychange', () => {
  if (document.hidden) return;
  // Phone wake-up: reset backoff and force a resync so the UI never shows stale
  // running/idle state after the tab was frozen mid-reconnect or missed events.
  wsBackoff = 1000;
  if (!ws || ws.readyState > 1) connectWs();
  else send({ type: 'client.hello' });
});

/* ─────────── text-to-speech (recap playback) ─────────── */
let activeSpeakBtn = null;
const resetSpeakBtn = () => {
  if (activeSpeakBtn) { activeSpeakBtn.classList.remove('speaking'); activeSpeakBtn.textContent = '🔊'; activeSpeakBtn = null; }
};
export function speak(text, btn) {
  const synth = window.speechSynthesis;
  if (!synth) return toast('Speech not supported on this device', 'err');
  const wasThis = activeSpeakBtn === btn && synth.speaking;
  synth.cancel();
  resetSpeakBtn();
  if (wasThis) return; // second tap on the same button = stop
  const u = new SpeechSynthesisUtterance(String(text || '').trim());
  if (!u.text) return;
  const vs = synth.getVoices();
  u.voice = vs.find((v) => /^en/i.test(v.lang) && /natural|neural|google (us|uk)/i.test(v.name))
         || vs.find((v) => v.lang === 'en-US') || null;
  u.rate = 1.04;
  if (btn) {
    activeSpeakBtn = btn;
    btn.classList.add('speaking'); btn.textContent = '⏹';
    u.onend = u.onerror = resetSpeakBtn;
  }
  synth.speak(u);
}
// warm the voice list (some browsers populate it async)
window.speechSynthesis?.getVoices();
window.speechSynthesis?.addEventListener?.('voiceschanged', () => {});

/* ─────────── shared UI ─────────── */
export function toast(text, kind = '') {
  const host = document.getElementById('toastHost');
  const t = document.createElement('div');
  t.className = `toast ${kind}`;
  t.textContent = text;
  host.appendChild(t);
  setTimeout(() => { t.style.opacity = '0'; t.style.transition = 'opacity .3s'; setTimeout(() => t.remove(), 350); }, 2600);
}

export function sheet(html) {
  const host = document.getElementById('sheetHost');
  host.innerHTML = `<div class="sheet-back"></div><div class="sheet"><div class="grab"></div>${html}</div>`;
  const close = () => { host.innerHTML = ''; };
  host.querySelector('.sheet-back').onclick = close;
  return { el: host.querySelector('.sheet'), close };
}

export function confirmSheet({ title, body, confirmText = 'Confirm', danger = true }) {
  return new Promise((resolve) => {
    const s = sheet(`
      <h2>${esc(title)}</h2>
      <p class="muted">${esc(body)}</p>
      <div class="actions">
        <button class="btn ghost" data-x="no">Cancel</button>
        <button class="btn ${danger ? 'danger' : ''}" data-x="yes">${esc(confirmText)}</button>
      </div>`);
    s.el.querySelector('[data-x=no]').onclick = () => { s.close(); resolve(false); };
    s.el.querySelector('[data-x=yes]').onclick = () => { s.close(); resolve(true); };
  });
}

function updateConnDot() {
  const dot = document.getElementById('connDot');
  if (!dot) return;
  dot.className = 'dot ' + (S.online && S.wsReady ? 'on' : S.wsReady ? 'mid' : '');
  document.getElementById('machineName').textContent = S.machine || '—';
}
function updateBell() {
  const b = document.getElementById('bellBadge');
  b.hidden = S.unread === 0;
  b.textContent = S.unread > 9 ? '9+' : S.unread;
}

/* ─────────── unread session markers ─────────── */
const readKey = (key) => `ms_read:${S.machine}:${key}`;
export function markRead(key) {
  localStorage.setItem(readKey(key), String(Date.now()));
  updateSessionsBadge();
}
export function isUnread(s) {
  const t = +(localStorage.getItem(readKey(s.key)) || 0);
  return (s.lastUsed || 0) > t && !S.busy.has(s.key);
}
export function updateSessionsBadge() {
  const b = document.getElementById('sessBadge');
  if (!b) return;
  const n = (S.sessions || []).filter(isUnread).length;
  b.hidden = n === 0;
  b.textContent = n > 9 ? '9+' : n;
}

/* ─────────── notifications drawer ─────────── */
async function openBell() {
  S.unread = 0; updateBell();
  const s = sheet(`<h2>Notifications</h2><div id="notifList"><div class="skeleton"></div></div>
    <div class="actions"><button class="btn ghost" id="pushEnable">Enable push</button><button class="btn ghost" id="pushTest">Test push</button></div>`);
  try {
    const { notifications } = await api('/api/notifications');
    S.notifications = notifications || [];
    const el = s.el.querySelector('#notifList');
    el.innerHTML = S.notifications.length ? S.notifications.slice(0, 40).map((n) => `
      <div class="card"><div class="row"><div class="grow">
        <h3>${esc(n.title)}</h3><div class="sub">${esc(n.body || '')}</div>
      </div><span class="chip">${esc(n.machine || '')}</span></div>
      <div class="small muted" style="margin-top:4px">${fmtAgo(n.ts)}</div></div>`).join('')
      : '<div class="empty"><div class="big">🔕</div>Nothing yet</div>';
  } catch (e) { toast(e.message, 'err'); }
  s.el.querySelector('#pushEnable').onclick = enablePush;
  s.el.querySelector('#pushTest').onclick = async () => { await api('/api/push/test', { method: 'POST' }); toast('Test push sent', 'ok'); };
}

async function enablePush() {
  try {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) return toast('Push not supported here', 'err');
    const reg = await navigator.serviceWorker.ready;
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') return toast('Permission denied', 'err');
    const { vapidPublicKey } = await api('/api/config');
    if (!vapidPublicKey) return toast('Hub missing VAPID keys', 'err');
    const raw = Uint8Array.from(atob(vapidPublicKey.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
    const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: raw });
    await api('/api/push/subscribe', { method: 'POST', body: JSON.stringify(sub.toJSON()) });
    toast('Push enabled on this device', 'ok');
  } catch (e) { toast(`Push failed: ${e.message}`, 'err'); }
}

/* ─────────── machine switcher ─────────── */
async function openMachinePicker() {
  const s = sheet(`<h2>Machines</h2><div id="mList"><div class="skeleton"></div></div>`);
  try {
    const { machines } = await api('/api/machines');
    S.machines = machines;
    const el = s.el.querySelector('#mList');
    el.innerHTML = machines.length ? machines.map((m) => `
      <div class="card tap" data-m="${esc(m.name)}"><div class="row">
        <span class="dot ${m.online ? 'on' : ''}"></span>
        <div class="grow"><h3>${esc(m.name)}</h3>
        <div class="sub">${esc(m.info?.hostname || '')} · ${m.online ? 'online' : `last seen ${fmtAgo(m.lastSeen)}`}</div></div>
        ${m.name === S.machine ? '<span class="chip blue">current</span>' : ''}
      </div></div>`).join('')
      : '<div class="empty"><div class="big">🛸</div>No machines yet.<br>Install the bridge on one (Settings → Install kit).</div>';
    el.querySelectorAll('[data-m]').forEach((c) => c.onclick = () => {
      S.machine = c.dataset.m;
      localStorage.setItem('ms_machine', S.machine);
      s.close(); S.sessions = []; S.info = null; connectWs(); route();
      updateConnDot();
    });
  } catch (e) { toast(e.message, 'err'); }
}

/* ─────────── router ─────────── */
const views = { sessions, terminal, files, fleet, machine, history, settings };
let activeView = null;

export function nav(hash) { location.hash = `#/${hash}`; }

function route() {
  const parts = (location.hash.replace(/^#\//, '') || 'sessions').split('/');
  const name = views[parts[0]] ? parts[0] : 'sessions';
  const el = document.getElementById('view');
  if (activeView?.destroy) { try { activeView.destroy(); } catch {} }
  activeView = views[name];
  document.querySelectorAll('#tabbar button').forEach((b) => b.classList.toggle('active', b.dataset.route === name));
  el.innerHTML = '';
  activeView.render(el, parts.slice(1));
}

/* ─────────── boot ─────────── */
async function boot() {
  document.getElementById('topbar').hidden = false;
  document.getElementById('tabbar').hidden = false;
  document.getElementById('machinePill').onclick = openMachinePicker;
  document.getElementById('bellBtn').onclick = openBell;
  document.getElementById('gearBtn').onclick = () => nav('settings');
  document.getElementById('installChip').onclick = () => install.prompt();
  updateInstallChip();
  document.querySelectorAll('#tabbar button').forEach((b) => b.onclick = () => nav(b.dataset.route));
  updateConnDot();
  // auto-pick a machine (prefer an online one) so there's no gate at all
  if (!S.machine) {
    try {
      const { machines } = await api('/api/machines');
      S.machines = machines;
      const pick = machines.find((m) => m.online) || machines[0];
      if (pick) { S.machine = pick.name; localStorage.setItem('ms_machine', S.machine); }
    } catch {}
  }
  updateConnDot();
  connectWs();
  if (!S.machine) openMachinePicker();
  route();
}

/* ─────────── install (PWA) ─────────── */
export const install = {
  deferred: null,
  get isStandalone() {
    return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
  },
  get isIOS() { return /iphone|ipad|ipod/i.test(navigator.userAgent) && !window.MSStream; },
  available() { return !!this.deferred || (this.isIOS && !this.isStandalone); },
  async prompt() {
    if (this.deferred) {
      this.deferred.prompt();
      const { outcome } = await this.deferred.userChoice;
      this.deferred = null;
      updateInstallChip();
      return outcome;
    }
    if (this.isIOS) {
      sheet(`<h2>Install on iPhone</h2>
        <p class="muted" style="white-space:normal">Tap the <strong>Share</strong> button in Safari (the square with an up-arrow), then choose <strong>“Add to Home Screen.”</strong> Mothership will open full-screen like a native app.</p>
        <div class="actions"><button class="btn" onclick="document.getElementById('sheetHost').innerHTML=''">Got it</button></div>`);
      return 'ios-instructions';
    }
    toast('Use your browser menu → Install app', '');
    return 'unavailable';
  },
};

function updateInstallChip() {
  const chip = document.getElementById('installChip');
  if (!chip) return;
  chip.hidden = install.isStandalone || !install.available();
}

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  install.deferred = e;
  updateInstallChip();
});
window.addEventListener('appinstalled', () => { install.deferred = null; toast('Installed 🎉', 'ok'); updateInstallChip(); });

window.addEventListener('hashchange', route);
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
  // Deep-link from a notification tap: the SW posts the target route.
  navigator.serviceWorker.addEventListener('message', (e) => {
    if (e.data?.navigate) location.hash = e.data.navigate.replace(/^\/?#?/, '#');
  });
}
boot();
