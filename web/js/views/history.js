// History — every native Claude Code session on the machine, forever.
import { S, req, sheet, esc, fmtAgo, fmtBytes, md, toast, nav } from '../app.js';

export function destroy() {}

let cache = null;

export function render(el) {
  el.innerHTML = `
    <div class="section-title">Claude Code history on ${esc(S.machine || '—')}</div>
    <input id="histSearch" placeholder="Search sessions…" style="margin-bottom:12px">
    <div id="histList"><div class="skeleton"></div><div class="skeleton"></div></div>`;

  const list = el.querySelector('#histList');
  const draw = (items) => {
    list.innerHTML = items.length ? items.map((s) => `
      <div class="card tap" data-sid="${esc(s.sessionId)}" data-dir="${esc(s.projectDir)}">
        <div class="row"><div class="grow">
          <h3 style="font-size:14px">${esc(s.preview || '(no prompt captured)')}</h3>
          <div class="sub">${esc(s.project)}</div></div></div>
        <div class="small muted" style="margin-top:5px">${fmtAgo(s.mtime)} · ${fmtBytes(s.size)}</div>
      </div>`).join('') : '<div class="empty"><div class="big">🕘</div>No sessions found</div>';
    list.querySelectorAll('[data-sid]').forEach((c) => c.onclick = () => {
      const item = (cache || []).find((x) => x.sessionId === c.dataset.sid) || {};
      openTranscript(c.dataset.dir, c.dataset.sid, item);
    });
  };

  const load = async () => {
    if (!S.online) { list.innerHTML = '<div class="empty">Machine offline</div>'; return; }
    try {
      const r = await req('history.list', { limit: 80 });
      cache = r.sessions || [];
      draw(cache);
      const total = r.total || cache.length;
      if (total > cache.length) list.insertAdjacentHTML('beforeend', `<div class="small muted" style="text-align:center;padding:8px">showing ${cache.length} of ${total}</div>`);
    } catch (e) { list.innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
  };
  load();

  el.querySelector('#histSearch').oninput = (e) => {
    const q = e.target.value.toLowerCase();
    draw((cache || []).filter((s) => !q || (s.preview || '').toLowerCase().includes(q) || (s.project || '').toLowerCase().includes(q)));
  };
}

async function openTranscript(projectDir, sessionId, item = {}) {
  const s = sheet(`<h2>Transcript</h2><div class="small muted mono">${esc(sessionId)}</div>
    <div class="actions" style="margin-top:10px"><button class="btn" id="contHere">🛸 Continue here</button></div>
    <div id="trList" style="margin-top:12px"><div class="skeleton"></div></div>`);
  let cwd = item.cwd || '';
  try {
    const r = await req('history.read', { projectDir, sessionId, limit: 120 });
    if (r.cwd) cwd = r.cwd;
    s.el.querySelector('#trList').innerHTML = (r.messages || []).map((m) => m.role === 'user'
      ? `<div class="msg user" style="max-width:100%"><div class="bubble">${esc(m.text)}</div></div>`
      : `<div class="msg ai" style="max-width:100%;margin:8px 0">
          ${m.tools?.length ? `<div class="toolchips">${m.tools.map((t) => `<span class="chip blue">🛠 ${esc(t)}</span>`).join('')}</div>` : ''}
          ${m.text ? `<div class="bubble">${md(m.text)}</div>` : ''}
        </div>`).join('') || '<div class="empty">Empty transcript</div>';
  } catch (e) { toast(e.message, 'err'); }
  // Reverse-beam: adopt any desk session ever run as a live phone chat —
  // same claudeSessionId, so Claude resumes with its full prior context.
  s.el.querySelector('#contHere').onclick = async () => {
    const name = (item.preview || item.project || 'history').slice(0, 40);
    const key = (name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'history').slice(0, 40) + '-' + sessionId.slice(0, 4);
    try {
      await req('session.adopt', { key, name, claudeSessionId: sessionId, repo: cwd || null });
      s.close();
      nav(`sessions/${encodeURIComponent(key)}`);
      toast('Session continued from history 🛸', 'ok');
    } catch (e) { toast(e.message, 'err'); }
  };
}
