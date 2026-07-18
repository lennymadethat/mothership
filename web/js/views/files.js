// Files — a window into the machine's folders from the phone.
// Shortcut chips (Documents, Downloads, …), thumbnail grid for images,
// fullscreen viewer with swipe-between-images, inline video/audio playback,
// text preview, and real downloads. Media rides the HTTP lane
// (/api/machine/<m>/file?path=…) so <img>/<video> work natively.
import { S, req, on, toast, sheet, esc, fmtAgo, fmtBytes } from '../app.js';

let unsubs = [];
let lb = null; // open lightbox overlay

export function destroy() { unsubs.forEach((u) => u()); unsubs = []; closeLb(); }

// svg deliberately absent: the worker refuses to serve active content inline
const IMG = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'avif', 'bmp']);
const VID = new Set(['mp4', 'm4v', 'webm', 'mov', 'mkv']);
const AUD = new Set(['mp3', 'wav', 'm4a', 'ogg', 'flac']);
const TXT = new Set(['txt', 'md', 'markdown', 'json', 'log', 'csv', 'js', 'ts', 'py', 'html', 'css',
  'ps1', 'bat', 'sh', 'yml', 'yaml', 'toml', 'xml', 'ini']);
const ext = (n) => { const i = n.lastIndexOf('.'); return i > 0 ? n.slice(i + 1).toLowerCase() : ''; };
const kindOf = (n) => {
  const e = ext(n);
  return IMG.has(e) ? 'img' : VID.has(e) ? 'vid' : AUD.has(e) ? 'aud' : e === 'pdf' ? 'pdf' : TXT.has(e) ? 'txt' : 'file';
};
const ICON = { img: '🖼️', vid: '🎬', aud: '🎵', pdf: '📕', txt: '📝', file: '📄' };

const fileUrl = (p, dl) =>
  `/api/machine/${encodeURIComponent(S.machine)}/file?path=${encodeURIComponent(p)}` +
  `${dl ? '&dl=1' : ''}${S.token ? `&token=${encodeURIComponent(S.token)}` : ''}`;

const homedir = () => `C:\\Users\\${S.info?.user || 'lenny'}`;
const shortcuts = () => [
  { label: '📄 Documents', path: `${homedir()}\\Documents` },
  { label: '⬇️ Downloads', path: `${homedir()}\\Downloads` },
  { label: '🖼️ Pictures', path: `${homedir()}\\Pictures` },
  { label: '🖥️ Desktop', path: `${homedir()}\\Desktop` },
  { label: '🧠 Vault output', path: 'G:\\My Drive\\vault\\output' },
  { label: '📎 Phone uploads', path: `${homedir()}\\Documents\\mothership-access-hub\\bridge\\data\\uploads` },
];

export function render(el) {
  let cur = localStorage.getItem(`ms_fpath:${S.machine}`) || `${homedir()}\\Documents`;
  let sort = localStorage.getItem('ms_fsort') || 'new';
  let mode = localStorage.getItem('ms_fmode') || 'grid';
  let listing = null;

  const shell = () => {
    el.innerHTML = `
      <div class="viewbar">
        <div class="section-title" style="margin:0">Files on ${esc(S.machine || '—')}</div>
        <span class="grow"></span>
        <div class="seg" id="fSort">
          <button data-s="new" class="${sort === 'new' ? 'active' : ''}">Newest</button>
          <button data-s="name" class="${sort === 'name' ? 'active' : ''}">A–Z</button>
        </div>
        <div class="seg" id="fMode">
          <button data-m="grid" class="${mode === 'grid' ? 'active' : ''}">⊞</button>
          <button data-m="list" class="${mode === 'list' ? 'active' : ''}">☰</button>
        </div>
      </div>
      <div class="chips-scroll">${shortcuts().map((s, i) => `<button class="chip" data-i="${i}">${s.label}</button>`).join('')}</div>
      <div class="pathbar">
        <button class="iconbtn" id="fUp" title="Up one folder">‹</button>
        <span class="mono small grow" id="fPathTxt"></span>
        <button class="iconbtn" id="fRefresh" title="Refresh">⟳</button>
      </div>
      <div id="fList"><div class="skeleton"></div></div>`;
    el.querySelectorAll('.chips-scroll .chip').forEach((c) => c.onclick = () => go(shortcuts()[+c.dataset.i].path));
    el.querySelector('#fUp').onclick = () => { if (listing?.parent) go(listing.parent); };
    el.querySelector('#fRefresh').onclick = () => go(cur);
    el.querySelectorAll('#fSort button').forEach((b) => b.onclick = () => {
      sort = b.dataset.s; localStorage.setItem('ms_fsort', sort); shell(); go(cur);
    });
    el.querySelectorAll('#fMode button').forEach((b) => b.onclick = () => {
      mode = b.dataset.m; localStorage.setItem('ms_fmode', mode); shell(); go(cur);
    });
  };

  const go = async (p) => {
    cur = p;
    const list = el.querySelector('#fList');
    list.innerHTML = '<div class="skeleton"></div>';
    try {
      const r = await req('fs.list', { path: p });
      listing = r;
      cur = r.path;
      localStorage.setItem(`ms_fpath:${S.machine}`, cur);
      el.querySelector('#fPathTxt').textContent = r.path;
      drawList();
    } catch (e) {
      list.innerHTML = `<div class="empty">${esc(e.message)}${S.online ? '' : '<br><span class="small muted">machine offline</span>'}</div>`;
    }
  };

  const fullPath = (n) => `${listing.path.replace(/\\$/, '')}\\${n}`;

  const drawList = () => {
    const list = el.querySelector('#fList');
    const items = [...(listing.items || [])];
    const key = sort === 'name'
      ? (a, b) => a.name.localeCompare(b.name)
      : (a, b) => (b.mtime || 0) - (a.mtime || 0);
    items.sort((a, b) => (b.dir - a.dir) || key(a, b));
    if (!items.length) { list.innerHTML = '<div class="empty small">Empty folder.</div>'; return; }

    if (mode === 'grid') {
      list.innerHTML = `<div class="files-grid">${items.map((i) => {
        const k = i.dir ? 'dir' : kindOf(i.name);
        const thumb = i.dir ? '<div class="fthumb">📁</div>'
          : k === 'img' ? `<div class="fthumb"><img loading="lazy" src="${esc(fileUrl(fullPath(i.name)))}" alt=""></div>`
          : `<div class="fthumb">${ICON[k]}</div>`;
        return `<div class="ftile tap" data-n="${esc(i.name)}" data-dir="${i.dir ? 1 : ''}">${thumb}<div class="fname">${esc(i.name)}</div></div>`;
      }).join('')}</div>`;
    } else {
      list.innerHTML = items.map((i) => {
        const k = i.dir ? 'dir' : kindOf(i.name);
        const mini = i.dir ? '📁'
          : k === 'img' ? `<img loading="lazy" src="${esc(fileUrl(fullPath(i.name)))}" alt="">`
          : ICON[k];
        return `<div class="card frow tap" data-n="${esc(i.name)}" data-dir="${i.dir ? 1 : ''}">
          <div class="row"><div class="fmini">${mini}</div>
            <div class="grow"><div class="fname2">${esc(i.name)}</div>
              <div class="small muted">${i.dir ? 'folder' : fmtBytes(i.size)} · ${fmtAgo(i.mtime)}</div></div>
          </div></div>`;
      }).join('');
    }
    list.querySelectorAll('[data-n]').forEach((t) => t.onclick = () => {
      const name = t.dataset.n;
      if (t.dataset.dir) return go(fullPath(name));
      openFile(name, items);
    });
  };

  const openFile = (name, items) => {
    const k = kindOf(name);
    const p = fullPath(name);
    if (k === 'img' || k === 'vid' || k === 'aud') {
      // the whole folder's media becomes a swipeable deck
      const media = items.filter((i) => !i.dir && ['img', 'vid', 'aud'].includes(kindOf(i.name)))
        .map((i) => ({ path: fullPath(i.name), name: i.name, kind: kindOf(i.name) }));
      return openLb(media, Math.max(0, media.findIndex((m) => m.name === name)));
    }
    if (k === 'pdf') return void window.open(fileUrl(p), '_blank');
    const sz = items.find((i) => i.name === name)?.size || 0;
    if (k === 'txt' && sz < 400_000) return openText(p, name, sz);
    fileSheet(p, name, sz);
  };

  const openText = async (p, name, sz) => {
    const s = sheet(`<h2 class="ellip">${esc(name)}</h2><pre class="fpre" id="fpre">loading…</pre>
      <div class="actions">
        <a class="btn ghost" href="${esc(fileUrl(p, true))}" download>⬇ Download</a>
        <button class="btn" id="fpClose">Close</button>
      </div>`);
    s.el.querySelector('#fpClose').onclick = s.close;
    try {
      // header auth here (unlike <img>/<video>, fetch can carry it) — keeps the
      // token out of this URL entirely
      const bare = `/api/machine/${encodeURIComponent(S.machine)}/file?path=${encodeURIComponent(p)}`;
      const r = await fetch(bare, S.token ? { headers: { Authorization: `Bearer ${S.token}` } } : undefined);
      if (!r.ok) throw new Error(`load failed (${r.status})`);
      s.el.querySelector('#fpre').textContent = await r.text();
    } catch (e) { s.el.querySelector('#fpre').textContent = e.message; }
  };

  const fileSheet = (p, name, sz) => {
    const s = sheet(`<h2 class="ellip">${esc(name)}</h2>
      <div class="sub muted" style="margin-bottom:14px">${fmtBytes(sz)} · <span class="mono small">${esc(p)}</span></div>
      <div class="actions">
        <a class="btn ghost" href="${esc(fileUrl(p))}" target="_blank">Open in tab</a>
        <a class="btn" href="${esc(fileUrl(p, true))}" download>⬇ Download</a>
      </div>`);
    s.el.querySelectorAll('a').forEach((a) => a.addEventListener('click', () => setTimeout(s.close, 300)));
  };

  shell();
  go(cur);
  // machine came online / reconnected while we were staring at an error
  unsubs.push(on('snapshot', () => go(cur)));
}

/* fullscreen media viewer — swipe left/right between items, swipe down to close */
function closeLb() { lb?.remove(); lb = null; }
function openLb(items, idx) {
  closeLb();
  if (!items.length) return;
  lb = document.createElement('div');
  lb.className = 'lightbox';
  document.body.appendChild(lb);

  const draw = () => {
    const it = items[idx];
    lb.innerHTML = `
      <div class="lb-top">
        <span class="lb-name">${esc(it.name)}${items.length > 1 ? ` · ${idx + 1}/${items.length}` : ''}</span>
        <span class="grow"></span>
        <a class="iconbtn" href="${esc(fileUrl(it.path, true))}" download title="Download to phone">⬇</a>
        <button class="iconbtn" id="lbClose">✕</button>
      </div>
      <div class="lb-body">${
        it.kind === 'img' ? `<img src="${esc(fileUrl(it.path))}" alt="">`
        : it.kind === 'vid' ? `<video src="${esc(fileUrl(it.path))}" controls autoplay playsinline></video>`
        : `<audio src="${esc(fileUrl(it.path))}" controls autoplay></audio>`}</div>
      ${items.length > 1 ? '<button class="lb-nav prev">‹</button><button class="lb-nav next">›</button>' : ''}`;
    lb.querySelector('#lbClose').onclick = closeLb;
    lb.querySelector('.prev')?.addEventListener('click', (e) => { e.stopPropagation(); goLb(-1); });
    lb.querySelector('.next')?.addEventListener('click', (e) => { e.stopPropagation(); goLb(1); });
    // preload neighbours so swiping feels instant
    for (const d of [-1, 1]) {
      const n = items[(idx + d + items.length) % items.length];
      if (n?.kind === 'img') { const im = new Image(); im.src = fileUrl(n.path); }
    }
  };
  const goLb = (d) => { idx = (idx + d + items.length) % items.length; draw(); };

  let sx = 0, sy = 0;
  lb.addEventListener('touchstart', (e) => { sx = e.touches[0].clientX; sy = e.touches[0].clientY; }, { passive: true });
  lb.addEventListener('touchend', (e) => {
    const dx = e.changedTouches[0].clientX - sx, dy = e.changedTouches[0].clientY - sy;
    if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5 && items.length > 1) goLb(dx < 0 ? 1 : -1);
    else if (dy > 90 && Math.abs(dy) > Math.abs(dx)) closeLb();
  });
  draw();
}
