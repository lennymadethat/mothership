// Sessions list + chat-first Claude Code view (the centerpiece).
import { S, api, req, send, on, nav, toast, sheet, confirmSheet, esc, md, fmtAgo, fmtBytes, speak, isUnread, markRead } from '../app.js';

let unsubs = [];
let agoTimer = null;
const freshKeys = new Set(); // session keys whose NEXT send starts a fresh Claude context
const cleanup = () => {
  unsubs.forEach((u) => u()); unsubs = [];
  if (agoTimer) { clearInterval(agoTimer); agoTimer = null; }
  document.getElementById('app')?.classList.remove('wide');
};

export function destroy() { cleanup(); }

export function render(el, params) {
  if (params[0]) return renderChat(el, decodeURIComponent(params[0]));
  const mode = localStorage.getItem('ms_sview') || 'list';
  if (mode === 'pro') return renderPro(el, 'grid');
  if (mode === 'swipe') return renderPro(el, 'swipe');
  renderList(el);
}

const remount = (el) => { cleanup(); el.innerHTML = ''; render(el, []); };

const viewSegHtml = () => `
  <div class="seg" id="viewSeg">
    <button data-v="list" class="${(localStorage.getItem('ms_sview') || 'list') === 'list' ? 'active' : ''}">☰ List</button>
    <button data-v="pro" class="${localStorage.getItem('ms_sview') === 'pro' ? 'active' : ''}">⊞ Pro</button>
    <button data-v="swipe" class="${localStorage.getItem('ms_sview') === 'swipe' ? 'active' : ''}">⇆ Swipe</button>
  </div>`;
const wireViewSeg = (el) => {
  el.querySelectorAll('#viewSeg button').forEach((b) => b.onclick = () => {
    localStorage.setItem('ms_sview', b.dataset.v);
    remount(el);
  });
};

// chunked file upload phone/desktop → machine (shared by chat + pro panels)
async function uploadToMachine(file, onPct) {
  const begin = await req('upload.begin', { name: file.name, size: file.size });
  try {
    const CHUNK = 192 * 1024; // ~256 KB as base64, safely under the 1 MiB WS message cap
    for (let off = 0; off < file.size; off += CHUNK) {
      const bytes = new Uint8Array(await file.slice(off, off + CHUNK).arrayBuffer());
      let bin = '';
      for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
      await req('upload.chunk', { uploadId: begin.uploadId, data: btoa(bin) }, 30000);
      onPct?.(Math.min(99, Math.round(((off + CHUNK) / (file.size || 1)) * 100)));
    }
    return await req('upload.end', { uploadId: begin.uploadId }); // {path, size}
  } catch (e) {
    req('upload.abort', { uploadId: begin.uploadId }).catch(() => {});
    throw e;
  }
}
const attachPreamble = (paths) =>
  `[Attached files — uploaded to this machine, read them from these paths:\n${paths.map((p) => `- ${p}`).join('\n')}]\n\n`;

// composer drafts survive navigation — saved per machine+session as you type,
// restored on return, cleared only when the message actually sends
const draftKey = (key) => `ms_draft:${S.machine}:${key}`;
const saveDraft = (key, v) => { try { v ? localStorage.setItem(draftKey(key), v) : localStorage.removeItem(draftKey(key)); } catch {} };
const loadDraft = (key) => { try { return localStorage.getItem(draftKey(key)) || ''; } catch { return ''; } };

// spoken recap — 🔊 speaks the bridge-generated recap when one exists.
// The fallback reads the END of the reply, not the start: a long reply opens
// with scene-setting but closes with the actual wrap-up ("done, deployed,
// here's what I need from you") — that's the part worth hearing aloud.
const plainText = (t) => { const d = document.createElement('div'); d.innerHTML = md(t); return (d.textContent || '').replace(/\s+/g, ' ').trim(); };
const fallbackRecap = (t) => {
  const p = plainText(t);
  const sentences = p.match(/[^.!?]+[.!?]+(?=\s|$)/g);
  if (!sentences?.length) return p.slice(-260);
  let out = '';
  while (sentences.length && out.length < 140) out = `${sentences.pop().trim()} ${out}`;
  return out.trim().slice(0, 320);
};
const speakBtnHtml = (say) => say ? `<button class="speakbtn" data-say="${esc(say)}" title="Listen to recap">🔊</button>` : '';
const wireSpeak = (scope) => scope.querySelectorAll('.speakbtn').forEach((b) => {
  if (b._wired) return; b._wired = 1;
  b.onclick = (e) => { e.stopPropagation(); speak(b.dataset.say, b); };
});

// model + billing chips shared by list cards and pro banners
const modelLabel = (s) => (s.model || S.defaultModel || 'default').replace(/^claude-/, '');
// context meter + stitched-part ticks (bridge tracks usage per run; part
// counts the claude sessions rolled into this one continuous chat)
const ctxChip = (s) => {
  const c = s.ctx;
  if (!c) return '';
  const cls = c.pct >= 85 ? 'red' : c.pct >= 65 ? 'amber' : '';
  return `<span class="chip mini ${cls}" title="context window used — auto-rolls at 92%">🧠 ${c.pct}%</span>`;
};
const partTicks = (s) => (s.part || 1) > 1
  ? `<span class="chip mini blue" title="claude sessions stitched into this chat">⧉ ${s.part}</span>` : '';
const rolloverHtml = (part) =>
  `<div class="rollover">— 🧠 part ${(+part || 1)} · context archived to vault, chat continues —</div>`;
const authChip = (s) => {
  const a = s.auth || S.info?.auth;
  if (!a) return '<span class="chip mini" title="known after the next run">billing —</span>';
  return a === 'api'
    ? '<span class="chip mini blue" title="billed to the Anthropic API key">API</span>'
    : '<span class="chip mini green" title="runs on the claude.ai subscription">claude.ai</span>';
};

/* ───────────── list ───────────── */

// what archive/delete actually do — shown in every confirm so it's never a mystery
const DELETE_BODY = 'Removes the card and its Mothership chat history, and stops it if running. '
  + 'The underlying Claude Code conversation on the machine is NOT touched — it stays in ~/.claude '
  + 'and is still resumable from the terminal. Archive instead if you might come back to it.';

function renderList(el) {
  const selected = new Set();
  let selecting = false;

  const archiveKeys = async (keys) => {
    let n = 0;
    for (const k of keys) { try { await req('session.archive', { key: k }); n++; } catch (e) { toast(e.message, 'err'); } }
    if (n) toast(n > 1 ? `Archived ${n} sessions` : 'Archived — restorable from 🗂 Archived below', 'ok');
  };
  const deleteKeys = async (keys) => {
    const ok = await confirmSheet({
      title: keys.length > 1 ? `Delete ${keys.length} sessions?` : 'Delete session?',
      body: DELETE_BODY, confirmText: 'Delete',
    });
    if (!ok) return false;
    for (const k of keys) { try { await req('session.delete', { key: k }); } catch (e) { toast(e.message, 'err'); } }
    toast('Deleted', 'ok');
    return true;
  };

  const cardHtml = (s) => `
    <div class="swipe-wrap" data-key="${esc(s.key)}">
      <div class="swipe-under archive">🗂 Archive</div>
      <div class="swipe-under delete">Delete 🗑</div>
      <div class="card tap ${selected.has(s.key) ? 'selected' : ''}">
        <div class="row">
          ${selecting ? `<span class="selmark">${selected.has(s.key) ? '☑' : '☐'}</span>` : ''}
          <div class="grow"><h3>${esc(s.name)}</h3>
            <div class="sub">${esc(s.repo || 'home directory')}</div></div>
          ${S.busy.has(s.key) ? '<span class="chip amber">● running</span>' : isUnread(s) ? '<span class="chip mini blue">● new reply</span>' : '<span class="chip">idle</span>'}
        </div>
        ${s.summary ? `<div class="sub" style="margin-top:6px">${esc(s.summary)}</div>` : ''}
        <div class="small muted" style="margin-top:5px">${fmtAgo(s.lastUsed)}${s.model ? ` · ${esc(s.model)}` : ''} ${ctxChip(s)} ${partTicks(s)}</div>
      </div>
    </div>`;

  const draw = () => {
    const items = S.sessions;
    for (const k of [...selected]) if (!items.some((s) => s.key === k)) selected.delete(k);
    if (!items.length) selecting = false;
    el.innerHTML = `
      <div class="viewbar">
        ${selecting ? `
          <button class="iconbtn" id="selCancel">✕</button>
          <div class="section-title" style="margin:0">${selected.size} selected</div>
          <span class="grow"></span>
          <button class="btn small ghost" id="selAll">All</button>
          <button class="btn small ghost" id="selArchive" ${selected.size ? '' : 'disabled'}>🗂 Archive</button>
          <button class="btn small danger" id="selDelete" ${selected.size ? '' : 'disabled'}>🗑 Delete</button>
        ` : `
          <div class="section-title" style="margin:0">Claude sessions on ${esc(S.machine || '—')}</div>
          <span class="grow"></span>
          ${viewSegHtml()}
        `}
      </div>
      <div id="sessList">${items.length ? items.map(cardHtml).join('') :
        (S.online ? '<div class="empty"><div class="big">💬</div>No sessions yet.<br>Tap + to open one.</div>'
                  : '<div class="empty"><div class="big">🛸</div>Machine offline — sessions appear when the bridge connects.</div>')}
      </div>
      <button class="linklike" id="archivedLink">🗂 Archived sessions</button>
      <button class="fab" id="newSess">+</button>`;
    el.querySelectorAll('.swipe-wrap').forEach(wireCard);
    el.querySelector('#newSess').onclick = openNewSession;
    el.querySelector('#archivedLink').onclick = openArchived;
    if (selecting) {
      el.querySelector('#selCancel').onclick = () => { selecting = false; selected.clear(); draw(); };
      el.querySelector('#selAll').onclick = () => { S.sessions.forEach((s) => selected.add(s.key)); draw(); };
      el.querySelector('#selArchive').onclick = async () => { const keys = [...selected]; selecting = false; selected.clear(); await archiveKeys(keys); draw(); };
      el.querySelector('#selDelete').onclick = async () => { if (await deleteKeys([...selected])) { selecting = false; selected.clear(); } draw(); };
    } else {
      wireViewSeg(el);
    }
  };

  // long-press = multi-select; swipe right = archive, swipe left = delete
  function wireCard(w) {
    const key = w.dataset.key;
    const card = w.querySelector('.card');
    let startX = 0, startY = 0, dx = 0, swiping = null, lpTimer = null, suppress = false;

    const cancelLP = () => { if (lpTimer) { clearTimeout(lpTimer); lpTimer = null; } };
    const startLP = () => {
      if (selecting) return;
      cancelLP();
      lpTimer = setTimeout(() => {
        lpTimer = null; suppress = true;
        try { navigator.vibrate?.(15); } catch {}
        selecting = true; selected.add(key); draw();
      }, 450);
    };

    card.addEventListener('touchstart', (e) => {
      const t = e.touches[0]; startX = t.clientX; startY = t.clientY; dx = 0; swiping = null;
      startLP();
    }, { passive: true });
    card.addEventListener('touchmove', (e) => {
      const t = e.touches[0];
      const mx = t.clientX - startX, my = t.clientY - startY;
      if (Math.abs(mx) > 8 || Math.abs(my) > 8) cancelLP();
      if (selecting) return;
      if (swiping === null && (Math.abs(mx) > 14 || Math.abs(my) > 14)) swiping = Math.abs(mx) > Math.abs(my);
      if (!swiping) return;
      dx = Math.max(-140, Math.min(140, mx));
      card.style.transition = 'none';
      card.style.transform = `translateX(${dx}px)`;
      w.classList.toggle('show-archive', dx > 0);
      w.classList.toggle('show-delete', dx < 0);
    }, { passive: true });
    card.addEventListener('touchend', () => {
      cancelLP();
      if (swiping) {
        suppress = true;
        const commit = Math.abs(dx) > 80;
        card.style.transition = 'transform .18s';
        card.style.transform = '';
        w.classList.remove('show-archive', 'show-delete');
        if (commit && dx > 0) archiveKeys([key]);
        else if (commit && dx < 0) deleteKeys([key]);
      }
      swiping = null; dx = 0;
      setTimeout(() => { suppress = false; }, 350);
    });

    // mouse fallback (desktop shell): hold to select
    card.addEventListener('mousedown', startLP);
    card.addEventListener('mouseup', cancelLP);
    card.addEventListener('mouseleave', cancelLP);

    card.onclick = () => {
      if (suppress) { suppress = false; return; }
      if (selecting) {
        selected.has(key) ? selected.delete(key) : selected.add(key);
        draw();
        return;
      }
      nav(`sessions/${encodeURIComponent(key)}`);
    };
  }

  // archived drawer — restore or permanently delete
  async function openArchived() {
    const s = sheet(`
      <h2>Archived sessions</h2>
      <div class="sub muted" style="margin-bottom:10px">Hidden, not gone — restore brings the card back with its history and full Claude context.</div>
      <div id="archList"><div class="skeleton"></div></div>
      <div class="actions"><button class="btn ghost" id="archClose">Close</button></div>`);
    s.el.querySelector('#archClose').onclick = s.close;
    const list = s.el.querySelector('#archList');
    const load = () => req('session.list', { archived: true }).then((r) => {
      const items = r.sessions || [];
      list.innerHTML = items.length ? items.map((a) => `
        <div class="row arch-row" data-key="${esc(a.key)}">
          <div class="grow"><strong>${esc(a.name)}</strong>
            <div class="sub small muted">${esc(a.repo || 'home')} · ${fmtAgo(a.lastUsed)}</div></div>
          <button class="btn small ghost" data-act="restore">Restore</button>
          <button class="btn small danger" data-act="del">🗑</button>
        </div>`).join('') : '<div class="empty small">Nothing archived.</div>';
      list.querySelectorAll('.arch-row').forEach((row) => {
        const key = row.dataset.key;
        row.querySelector('[data-act=restore]').onclick = async () => {
          try { await req('session.unarchive', { key }); toast('Restored', 'ok'); load(); } catch (e) { toast(e.message, 'err'); }
        };
        row.querySelector('[data-act=del]').onclick = async () => { if (await deleteKeys([key])) load(); };
      });
    }).catch((e) => { list.innerHTML = `<div class="empty small">${esc(e.message)}</div>`; });
    load();
  }

  draw();
  unsubs.push(on('sessions', draw), on('snapshot', draw),
    on('claude.event', (m) => { if (m.ev?.kind === 'done' || m.ev?.kind === 'init') { m.ev.kind === 'done' ? S.busy.delete(m.key) : S.busy.add(m.key); draw(); } }));
}

/* ───────────── pro view — multi-column live feeds ───────────── */

function renderPro(el, layout = 'grid') {
  document.getElementById('app')?.classList.add('wide');
  const panels = new Map(); // key -> {root, feed, input, sendBtn, stream, ago}
  const swipe = layout === 'swipe';
  let keysSig = '';

  const cols = () => localStorage.getItem('ms_procols') || '0';
  const applyCols = () => {
    if (swipe) return;
    const grid = el.querySelector('#proGrid');
    if (!grid) return;
    const n = +cols();
    grid.style.gridTemplateColumns = n ? `repeat(${n}, minmax(0, 1fr))` : '';
    el.querySelectorAll('#colSeg button').forEach((b) => b.classList.toggle('active', b.dataset.c === cols()));
  };

  /* swipe-mode pips: one dot per session — blue = where you are, amber = running */
  const renderPips = () => {
    const pips = el.querySelector('#swipePips');
    if (!pips) return;
    pips.innerHTML = S.sessions.map((s) => `<i data-k="${esc(s.key)}"></i>`).join('');
    pips.querySelectorAll('i').forEach((p, i) => p.onclick = () => {
      const deck = el.querySelector('#proGrid');
      deck.scrollTo({ left: i * (deck.clientWidth + 10), behavior: 'smooth' });
    });
    updatePips();
  };
  const updatePips = () => {
    const deck = el.querySelector('#proGrid');
    const pips = [...el.querySelectorAll('#swipePips i')];
    if (!deck || !pips.length) return;
    const idx = Math.max(0, Math.min(pips.length - 1, Math.round(deck.scrollLeft / (deck.clientWidth + 10))));
    pips.forEach((p, i) => {
      p.classList.toggle('on', i === idx);
      const k = S.sessions[i]?.key;
      p.classList.toggle('busy', k ? S.busy.has(k) : false);
    });
    try { localStorage.setItem('ms_swipe_idx', String(idx)); } catch {}
  };

  const shell = () => {
    el.innerHTML = `
      <div class="viewbar">
        <div class="section-title" style="margin:0">Claude desk · ${esc(S.machine || '—')}</div>
        <span class="grow"></span>
        ${swipe ? '' : `<div class="seg" id="colSeg" title="Columns">
          <button data-c="0">Auto</button><button data-c="2">2</button><button data-c="3">3</button>
          <button data-c="4">4</button><button data-c="5">5</button>
        </div>`}
        ${viewSegHtml()}
      </div>
      ${swipe ? '<div class="swipe-pips" id="swipePips"></div>' : ''}
      <div class="${swipe ? 'swipe-deck' : 'pro-grid'}" id="proGrid"></div>
      <button class="fab" id="newSess">+</button>`;
    el.querySelector('#newSess').onclick = openNewSession;
    el.querySelectorAll('#colSeg button').forEach((b) => b.onclick = () => {
      localStorage.setItem('ms_procols', b.dataset.c); applyCols();
    });
    wireViewSeg(el);
    applyCols();
    if (swipe) {
      const deck = el.querySelector('#proGrid');
      deck.onscroll = () => requestAnimationFrame(updatePips);
    }
  };

  const bannerMeta = (p, s) => {
    p.root.querySelector('.pname').textContent = s.name;
    p.root.querySelector('.prepo').textContent = s.repo || 'home';
    p.root.querySelector('.pmodel').textContent = modelLabel(s);
    p.root.querySelector('.pauth').innerHTML = authChip(s);
    p.root.querySelector('.pctx').innerHTML = `${ctxChip(s)} ${partTicks(s)}`;
    updateAgo(p, s);
  };

  const updateAgo = (p, s) => {
    const busy = S.busy.has(s.key);
    p.root.classList.toggle('running', busy);
    p.ago.innerHTML = busy
      ? '<span class="chip mini amber">● running</span>'
      : `<span class="chip mini">idle</span> <span class="muted small">replied ${fmtAgo(s.lastUsed)}</span>`;
    const send = p.root.querySelector('.psend');
    const stopMode = busy && !p.root.querySelector('textarea').value.trim();
    send.textContent = stopMode ? '◼' : '➤';
    send.classList.toggle('stop', stopMode);
    setPanelStatus(p, busy);
    if (swipe) updatePips();
  };

  // same done/working word as the full chat, next to the 🔊 on the newest reply
  const setPanelStatus = (p, busy) => {
    const state = busy ? 'working' : 'done';
    const metas = p.feed.querySelectorAll('.msg.ai .meta-line');
    const meta = metas[metas.length - 1];
    const cur = p.feed.querySelector('.statuschip');
    if (cur && cur.parentElement === meta && cur.dataset.state === state) return;
    p.feed.querySelectorAll('.statuschip').forEach((c) => c.remove());
    if (!meta) return;
    meta.insertAdjacentHTML('beforeend', busy
      ? '<span class="chip mini amber statuschip working" data-state="working">● working…</span>'
      : '<span class="chip mini green statuschip" data-state="done">✓ done</span>');
  };

  const panelHtml = (s) => `
    <div class="pro-panel" data-panel="${esc(s.key)}">
      <div class="pro-banner">
        <div class="pro-brow">
          <span class="pdot"></span>
          <strong class="pname tap" title="Open full chat"></strong>
          <span class="chip mini pmodel"></span>
          <span class="pauth"></span>
          <span class="pctx"></span>
          <span class="grow"></span>
          <span class="pro-ago"></span>
          <button class="iconbtn pexpand" title="Open full chat">⤢</button>
        </div>
        <div class="pro-brow small muted mono">📁 <span class="prepo"></span></div>
      </div>
      <div class="pro-feed"><div class="skeleton"></div></div>
      <div class="pro-attach attach-row" hidden></div>
      <div class="pro-composer">
        <button class="pattach" title="Attach files">＋</button>
        <textarea rows="1" placeholder="Message ${esc(s.name)}…"></textarea>
        <button class="psend">➤</button>
        <input type="file" class="pfiles" multiple hidden>
      </div>
    </div>`;

  const atBottom = (feed) => feed.scrollHeight - feed.scrollTop - feed.clientHeight < 100;
  const stick = (feed) => { feed.scrollTop = feed.scrollHeight; };

  const aiMsgHtml = (t) => `
    <div class="msg ai">
      ${(t.tools || []).length ? `<div class="toolchips">${t.tools.slice(0, 12).map((x) => `<span class="chip mini blue">🛠 ${esc(x.name || x)}</span>`).join('')}${t.tools.length > 12 ? `<span class="chip mini">+${t.tools.length - 12}</span>` : ''}</div>` : ''}
      <div class="bubble">${md(t.text || t.error || '')}</div>
      <div class="meta-line">${t.cost != null ? `$${Number(t.cost).toFixed(4)} · ` : ''}${fmtAgo(t.ts)} ${speakBtnHtml(fallbackRecap(t.text || ''))}</div>
    </div>`;

  const addUser = (p, text) => {
    p.feed.insertAdjacentHTML('beforeend', `<div class="msg user"><div class="bubble">${esc(text)}</div></div>`);
    stick(p.feed);
  };
  const startAI = (p) => {
    p.feed.insertAdjacentHTML('beforeend',
      `<div class="msg ai"><div class="toolchips"></div><div class="bubble streaming"></div><div class="meta-line"></div></div>`);
    const m = p.feed.lastElementChild;
    p.stream = { root: m, bubble: m.querySelector('.bubble'), chips: m.querySelector('.toolchips'), text: '' };
    stick(p.feed);
    return p.stream;
  };

  const loadFeed = (p, key) => {
    req('session.transcript', { key }).then((r) => {
      p.feed.innerHTML = '';
      let lastAI = null;
      for (const t of (r.transcript || []).slice(-40)) {
        if (t.role === 'user') p.feed.insertAdjacentHTML('beforeend', `<div class="msg user"><div class="bubble">${esc(t.text)}</div></div>`);
        else if (t.role === 'rollover') p.feed.insertAdjacentHTML('beforeend', rolloverHtml(t.part));
        else if (t.role === 'recap') {
          const b = lastAI?.querySelector('.speakbtn');
          if (b) b.dataset.say = t.text;
        } else {
          p.feed.insertAdjacentHTML('beforeend', aiMsgHtml(t));
          lastAI = p.feed.lastElementChild;
        }
      }
      wireSpeak(p.feed);
      if (!p.feed.children.length) p.feed.innerHTML = '<div class="empty small">Fresh session — say the word.</div>';
      if (r.busy) S.busy.add(key); else S.busy.delete(key);
      const s = S.sessions.find((x) => x.key === key);
      if (s) updateAgo(p, s);
      stick(p.feed);
    }).catch((e) => { p.feed.innerHTML = `<div class="empty small">${esc(e.message)}</div>`; });
  };

  const wirePanel = (p, key) => {
    const open = () => nav(`sessions/${encodeURIComponent(key)}`);
    p.root.querySelector('.pname').onclick = open;
    p.root.querySelector('.pexpand').onclick = open;
    const input = p.root.querySelector('textarea');
    const sendBtn = p.root.querySelector('.psend');
    const sess = () => S.sessions.find((x) => x.key === key);
    input.value = loadDraft(key);
    input.oninput = () => { saveDraft(key, input.value); const s = sess(); if (s) updateAgo(p, s); };

    // per-panel attachments (photos/files → this machine, paths injected into the prompt)
    const attachments = [];
    const attachRow = p.root.querySelector('.pro-attach');
    const fileInput = p.root.querySelector('.pfiles');
    const drawAtt = () => {
      attachRow.hidden = attachments.length === 0;
      attachRow.innerHTML = attachments.map((a, i) => `
        <span class="chip mini ${a.failed ? 'red' : a.done ? 'blue' : 'amber'}" data-att="${i}">
          📎 ${esc(a.name)}${a.done ? '' : a.failed ? ' · failed' : ` · ${a.pct || 0}%`} ✕
        </span>`).join('');
      attachRow.querySelectorAll('[data-att]').forEach((c) => c.onclick = () => { attachments.splice(+c.dataset.att, 1); drawAtt(); });
    };
    p.root.querySelector('.pattach').onclick = () => fileInput.click();
    fileInput.onchange = async () => {
      const files = [...fileInput.files];
      fileInput.value = '';
      for (const f of files) {
        const att = { name: f.name, pct: 0, done: false, failed: false };
        attachments.push(att); drawAtt();
        try { const end = await uploadToMachine(f, (pct) => { att.pct = pct; drawAtt(); }); att.path = end.path; att.done = true; }
        catch (e) { att.failed = true; toast(`Upload failed: ${e.message}`, 'err'); }
        drawAtt();
      }
    };

    const doSend = async () => {
      const typed = input.value.trim();
      const ready = attachments.filter((a) => a.done);
      if (attachments.some((a) => !a.done && !a.failed)) return toast('Still uploading…', '');
      if (!typed && !ready.length) return;
      let text = typed || 'Take a look at the attached file(s).';
      if (ready.length) text = attachPreamble(ready.map((a) => a.path)) + text;
      input.value = '';
      const s0 = sess(); if (s0) updateAgo(p, s0);
      try {
        const r = await req('claude.send', { sessionKey: key, prompt: text, model: localStorage.getItem('ms_model') || undefined });
        if (r.queued) toast(`${sess()?.name || key}: queued (#${r.position})`, '');
        saveDraft(key, '');
        attachments.length = 0; drawAtt();
      } catch (e) { toast(e.message, 'err'); input.value = typed; }
    };
    input.onkeydown = (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); doSend(); }
    };
    sendBtn.onclick = async () => {
      if (input.value.trim()) return doSend();
      if (S.busy.has(key)) { try { await req('claude.stop', { sessionKey: key }); } catch (e) { toast(e.message, 'err'); } }
    };
  };

  const draw = () => {
    const items = S.sessions;
    const sig = items.map((s) => s.key).join('|');
    if (sig !== keysSig) {
      keysSig = sig;
      const grid = el.querySelector('#proGrid');
      panels.clear();
      grid.innerHTML = items.length ? items.map(panelHtml).join('') :
        (S.online ? '<div class="empty"><div class="big">💬</div>No sessions yet.<br>Tap + to open one.</div>'
                  : '<div class="empty"><div class="big">🛸</div>Machine offline — sessions appear when the bridge connects.</div>');
      for (const s of items) {
        const root = grid.querySelector(`[data-panel="${CSS.escape(s.key)}"]`);
        const p = { root, feed: root.querySelector('.pro-feed'), ago: root.querySelector('.pro-ago'), stream: null };
        panels.set(s.key, p);
        bannerMeta(p, s);
        wirePanel(p, s.key);
        loadFeed(p, s.key);
      }
      if (swipe) {
        renderPips();
        const deck = el.querySelector('#proGrid');
        const saved = Math.min(items.length - 1, Math.max(0, +(localStorage.getItem('ms_swipe_idx') || 0)));
        if (saved > 0) requestAnimationFrame(() => { deck.scrollLeft = saved * (deck.clientWidth + 10); updatePips(); });
      }
    } else {
      for (const s of items) { const p = panels.get(s.key); if (p) bannerMeta(p, s); }
      if (swipe) updatePips();
    }
  };

  shell();
  draw();

  // live events routed to the owning panel
  unsubs.push(on('claude.event', (m) => {
    const p = panels.get(m.key);
    const ev = m.ev || {};
    if (ev.kind === 'init') S.busy.add(m.key);
    if (ev.kind === 'done' || ev.kind === 'stopped') S.busy.delete(m.key);
    if (!p) return;
    if (ev.kind === 'user') {
      if (p.feed.querySelector('.empty')) p.feed.innerHTML = '';
      addUser(p, ev.text);
      if (ev.queued) {
        p.feed.lastElementChild.insertAdjacentHTML('beforeend',
          '<div class="meta-line" style="text-align:right">⏳ queued</div>');
      } else { startAI(p); S.busy.add(m.key); }
    } else if (ev.kind === 'delta') {
      const st = p.stream || startAI(p);
      st.text += ev.text;
      st.bubble.textContent = st.text;
      if (atBottom(p.feed)) stick(p.feed);
    } else if (ev.kind === 'tool') {
      const st = p.stream || startAI(p);
      st.chips.insertAdjacentHTML('beforeend', `<span class="chip mini blue">🛠 ${esc(ev.name)}</span>`);
      if (atBottom(p.feed)) stick(p.feed);
    } else if (ev.kind === 'done') {
      const st = p.stream || startAI(p);
      st.text = ev.text || st.text;
      st.bubble.classList.remove('streaming');
      st.bubble.innerHTML = md(st.text || (ev.ok ? '(no output)' : ''));
      const bits = [];
      if (ev.error) bits.push(`<span class="chip mini red">✗ ${esc(String(ev.error).slice(0, 60))}</span>`);
      if (ev.durationMs) bits.push(`${Math.round(ev.durationMs / 1000)}s`);
      if (ev.cost != null) bits.push(`$${Number(ev.cost).toFixed(4)}`);
      st.root.querySelector('.meta-line').innerHTML = `${bits.join(' · ')} ${speakBtnHtml(fallbackRecap(st.text || ''))}`;
      wireSpeak(st.root);
      p.lastDone = st.root;
      p.stream = null;
      if (atBottom(p.feed)) stick(p.feed);
    } else if (ev.kind === 'recap') {
      const b = p.lastDone?.querySelector('.speakbtn');
      if (b) b.dataset.say = ev.text;
    } else if (ev.kind === 'rollover.start') {
      p.feed.insertAdjacentHTML('beforeend', '<div class="rollover">🧠 context full — archiving to vault…</div>');
      if (atBottom(p.feed)) stick(p.feed);
    } else if (ev.kind === 'rollover.done') {
      p.feed.insertAdjacentHTML('beforeend', rolloverHtml(ev.part));
      if (atBottom(p.feed)) stick(p.feed);
    } else if (ev.kind === 'stopped') {
      if (p.stream) { p.stream.bubble.classList.remove('streaming'); p.stream = null; }
      p.feed.insertAdjacentHTML('beforeend', '<div class="small muted" style="text-align:center">— stopped —</div>');
    }
    const s = S.sessions.find((x) => x.key === m.key);
    if (s) updateAgo(p, s);
  }), on('sessions', draw), on('snapshot', draw));

  // tick the "replied Xs ago" labels
  agoTimer = setInterval(() => {
    for (const s of S.sessions) { const p = panels.get(s.key); if (p) updateAgo(p, s); }
  }, 15000);
}

async function openNewSession() {
  const s = sheet(`
    <h2>New session</h2>
    <div class="field"><label>Name</label><input id="nsName" placeholder="RIR audit, PlayLetter fix…" autofocus></div>
    <div class="field"><label>Repo / working folder</label>
      <input id="nsRepo" list="repoList" value="" placeholder="blank = home (full memory bank)">
      <datalist id="repoList"></datalist></div>
    <div class="field"><label>Model</label>
      <select id="nsModel">
        <option value="">Default (account setting)</option>
        <option value="claude-fable-5">Fable 5</option>
        <option value="opus">Opus</option>
        <option value="sonnet">Sonnet</option>
        <option value="haiku">Haiku</option>
      </select></div>
    <div class="actions"><button class="btn ghost" id="nsCancel">Cancel</button><button class="btn" id="nsGo">Open session</button></div>`);
  // repo suggestions = folders in Documents
  req('fs.list', { path: 'C:\\Users\\lenny\\Documents' }).then((r) => {
    const dl = s.el.querySelector('#repoList');
    if (dl && r.items) dl.innerHTML = r.items.filter((i) => i.dir).map((i) => `<option value="${esc(r.path)}\\${esc(i.name)}">`).join('');
  }).catch(() => {});
  const model = localStorage.getItem('ms_model') || '';
  if (model) s.el.querySelector('#nsModel').value = model;
  s.el.querySelector('#nsCancel').onclick = s.close;
  s.el.querySelector('#nsGo').onclick = async () => {
    const name = s.el.querySelector('#nsName').value.trim() || 'session';
    const key = (name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'session').slice(0, 40) + '-' + Date.now().toString(36).slice(-4);
    try {
      await req('session.create', {
        key, name,
        repo: s.el.querySelector('#nsRepo').value.trim() || null,
        model: s.el.querySelector('#nsModel').value || null,
      });
      s.close();
      nav(`sessions/${encodeURIComponent(key)}`);
    } catch (e) { toast(e.message, 'err'); }
  };
}

/* ───────────── chat ───────────── */

let stream = null; // {key, bubbleEl, chipsEl, text}

function renderChat(el, key) {
  const sess = () => S.sessions.find((x) => x.key === key) || { key, name: key };
  el.innerHTML = `
    <div class="chat">
      <div class="chat-head">
        <button class="back" id="chatBack">‹</button>
        <div class="grow"><strong id="chatName">${esc(sess().name)}</strong>
          <div class="meta">${esc(sess().repo || 'home')}${sess().model ? ` · ${esc(sess().model)}` : ''}</div></div>
        <button class="iconbtn" id="chatMenu">⋯</button>
      </div>
      <div class="ctxrow" id="ctxRow" hidden></div>
      <div class="chat-scroll" id="chatScroll"><div class="skeleton"></div></div>
      <div class="attach-row" id="attachRow" hidden></div>
      <div class="composer">
        <button class="mic" id="chatAttach" title="Attach files">＋</button>
        <textarea id="chatInput" rows="1" placeholder="Message Claude on ${esc(S.machine)}… ( / for commands )"></textarea>
        <button class="send" id="chatSend">➤</button>
        <input type="file" id="chatFiles" multiple hidden>
      </div>
    </div>`;

  const scroll = el.querySelector('#chatScroll');
  const input = el.querySelector('#chatInput');
  const sendBtn = el.querySelector('#chatSend');
  el.querySelector('#chatBack').onclick = () => nav('sessions');
  el.querySelector('#chatMenu').onclick = () => sessionMenu(key);
  refreshSkills(); // so "/" surfaces the machine's real skills, not just snippets

  // always-visible context meter + part ticks — the "how full is this
  // session's brain" gauge; auto-rollover fires at 92% bridge-side
  const drawCtx = () => {
    const s = sess();
    const c = s.ctx;
    const part = s.part || 1;
    const row = el.querySelector('#ctxRow');
    if (!c && part === 1) { row.hidden = true; return; }
    const pct = c?.pct ?? 0;
    const cls = pct >= 85 ? 'red' : pct >= 65 ? 'amber' : '';
    row.hidden = false;
    row.innerHTML = `
      <div class="ctxbar ${cls}"><i style="width:${pct}%"></i></div>
      <span class="small muted">${c ? `${pct}% of context` : 'fresh context'}</span>
      <span class="grow"></span>
      <span class="ticks" title="claude sessions stitched into this chat">${
        Array.from({ length: part }, (_, i) => `<i class="${i === part - 1 ? 'on' : ''}">${i + 1}</i>`).join('')}</span>`;
  };
  drawCtx();
  unsubs.push(on('sessions', drawCtx));

  const atBottom = () => scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 120;
  const stick = () => { scroll.scrollTop = scroll.scrollHeight; };

  const addUser = (text) => {
    scroll.insertAdjacentHTML('beforeend',
      `<div class="msg user"><div class="bubble">${esc(text)}</div></div>`);
    stick();
  };
  const startAI = () => {
    scroll.insertAdjacentHTML('beforeend',
      `<div class="msg ai"><div class="toolchips"></div><div class="bubble streaming"></div><div class="meta-line"></div></div>`);
    const m = scroll.lastElementChild;
    stream = { key, root: m, bubble: m.querySelector('.bubble'), chips: m.querySelector('.toolchips'), text: '' };
    stick();
    return stream;
  };
  let lastDoneEl = null;
  const finalizeAI = (ev) => {
    const st = stream && stream.key === key ? stream : startAI();
    st.text = ev.text || st.text;
    st.bubble.classList.remove('streaming');
    st.bubble.innerHTML = md(st.text || (ev.ok ? '(no output)' : ''));
    const bits = [];
    if (ev.error) bits.push(`<span class="chip red">✗ ${esc(String(ev.error).slice(0, 80))}</span>`);
    if (ev.durationMs) bits.push(`${Math.round(ev.durationMs / 1000)}s`);
    if (ev.cost != null) bits.push(`$${Number(ev.cost).toFixed(4)}`);
    if ((ev.tools || []).length) bits.push(`${ev.tools.length} tool calls`);
    st.root.querySelector('.meta-line').innerHTML = `${bits.join(' · ')} ${speakBtnHtml(fallbackRecap(st.text || ''))}`;
    wireSpeak(st.root);
    lastDoneEl = st.root;
    stream = null;
    setBusy(false);
    if (atBottom()) stick();
  };
  // ➤ sends (queues while busy, like the CLI); ◼ stop only when the box is empty
  const syncSendBtn = () => {
    const stopMode = S.busy.has(key) && !input.value.trim();
    sendBtn.textContent = stopMode ? '◼' : '➤';
    sendBtn.classList.toggle('stop', stopMode);
  };
  // the done/working word next to the 🔊 on the newest reply — so you can tell
  // from inside the chat whether Claude is finished, without backing out to the deck
  const setStatusChip = (state) => {
    const metas = scroll.querySelectorAll('.msg.ai .meta-line');
    const meta = metas[metas.length - 1];
    const cur = scroll.querySelector('.statuschip');
    if (cur && cur.parentElement === meta && cur.dataset.state === state) return;
    scroll.querySelectorAll('.statuschip').forEach((c) => c.remove());
    if (!meta) return;
    meta.insertAdjacentHTML('beforeend',
      state === 'working' ? '<span class="chip amber statuschip working" data-state="working">● still working…</span>'
      : state === 'stopped' ? '<span class="chip statuschip" data-state="stopped">◼ stopped</span>'
      : '<span class="chip green statuschip" data-state="done">✓ done</span>');
  };
  const setBusy = (b) => {
    if (b) S.busy.add(key); else S.busy.delete(key);
    syncSendBtn();
    setStatusChip(b ? 'working' : 'done');
  };

  // transcript
  req('session.transcript', { key }).then((r) => {
    scroll.innerHTML = '';
    let lastAI = null;
    for (const t of r.transcript || []) {
      if (t.role === 'user') addUser(t.text);
      else if (t.role === 'rollover') scroll.insertAdjacentHTML('beforeend', rolloverHtml(t.part));
      else if (t.role === 'recap') {
        const b = lastAI?.querySelector('.speakbtn');
        if (b) b.dataset.say = t.text;
      } else {
        scroll.insertAdjacentHTML('beforeend', `
          <div class="msg ai">
            ${(t.tools || []).length ? `<div class="toolchips">${t.tools.map((x) => `<span class="chip blue">🛠 ${esc(x.name || x)}</span>`).join('')}</div>` : ''}
            <div class="bubble">${md(t.text || t.error || '')}</div>
            <div class="meta-line">${t.cost != null ? `$${Number(t.cost).toFixed(4)} · ` : ''}${fmtAgo(t.ts)} ${speakBtnHtml(fallbackRecap(t.text || ''))}</div>
          </div>`);
        lastAI = scroll.lastElementChild;
      }
    }
    wireSpeak(scroll);
    if (!scroll.children.length) scroll.innerHTML = `<div class="empty"><div class="big">🤖</div>Fresh session — say the word.</div>`;
    setBusy(r.busy);
    markRead(key);
    stick();
  }).catch((e) => { scroll.innerHTML = `<div class="empty">${esc(e.message)}</div>`; });

  // live events
  unsubs.push(on('claude.event', (m) => {
    if (m.key !== key) return;
    const ev = m.ev || {};
    if (ev.kind === 'user') {
      if (scroll.querySelector('.empty')) scroll.innerHTML = '';
      addUser(ev.text);
      if (ev.queued) {
        scroll.lastElementChild.insertAdjacentHTML('beforeend',
          '<div class="meta-line" style="text-align:right">⏳ queued — runs when Claude is free</div>');
      } else { startAI(); setBusy(true); }
    } else if (ev.kind === 'init') {
      setBusy(true);
    } else if (ev.kind === 'delta') {
      const st = stream && stream.key === key ? stream : startAI();
      st.text += ev.text;
      st.bubble.textContent = st.text;
      if (atBottom()) stick();
    } else if (ev.kind === 'tool') {
      const st = stream && stream.key === key ? stream : startAI();
      st.chips.insertAdjacentHTML('beforeend', `<span class="chip blue">🛠 ${esc(ev.name)}</span>`);
      if (atBottom()) stick();
    } else if (ev.kind === 'done') {
      finalizeAI(ev);
      markRead(key);
      const s = sess();
      if (ev.ctx) s.ctx = ev.ctx;
      if (ev.part) s.part = ev.part;
      drawCtx();
    } else if (ev.kind === 'rollover.start') {
      scroll.insertAdjacentHTML('beforeend', '<div class="rollover">🧠 context full — wrapping up &amp; archiving to vault…</div>');
      stick();
    } else if (ev.kind === 'rollover.done') {
      const s = sess();
      s.part = ev.part; s.ctx = null;
      scroll.insertAdjacentHTML('beforeend', rolloverHtml(ev.part));
      drawCtx();
      stick();
    } else if (ev.kind === 'recap') {
      const b = lastDoneEl?.querySelector('.speakbtn');
      if (b) b.dataset.say = ev.text;
    } else if (ev.kind === 'stopped') {
      setBusy(false);
      setStatusChip('stopped');
      if (stream) { stream.bubble.classList.remove('streaming'); stream = null; }
      scroll.insertAdjacentHTML('beforeend', `<div class="small muted" style="text-align:center">— stopped —</div>`);
    }
  }));

  // composer
  input.value = loadDraft(key);
  input.oninput = () => {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 130) + 'px';
    saveDraft(key, input.value);
    syncSendBtn();
    if (input.value.startsWith('/')) openPalette(input);
    else closePalette();
  };
  if (input.value) input.dispatchEvent(new Event('input'));
  input.onkeydown = (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); doSend(); }
  };
  sendBtn.onclick = () => {
    if (input.value.trim()) doSend();
    else if (S.busy.has(key)) doStop();
  };

  // (no in-app dictation — WhisperFlow types straight into the box)

  // attachments — ＋ picks files, each streams to the machine in base64 chunks;
  // the sent prompt then references the saved paths so Claude can read them
  const attachments = []; // {name, path, size, done, failed}
  const attachRow = el.querySelector('#attachRow');
  const fileInput = el.querySelector('#chatFiles');
  el.querySelector('#chatAttach').onclick = () => fileInput.click();

  const drawAttachments = () => {
    attachRow.hidden = attachments.length === 0;
    attachRow.innerHTML = attachments.map((a, i) => `
      <span class="chip ${a.failed ? 'red' : a.done ? 'blue' : 'amber'}" data-att="${i}">
        📎 ${esc(a.name)}${a.done ? ` · ${fmtBytes(a.size)}` : a.failed ? ' · failed' : ` · ${a.pct || 0}%`} ✕
      </span>`).join('');
    attachRow.querySelectorAll('[data-att]').forEach((c) => c.onclick = () => {
      attachments.splice(+c.dataset.att, 1);
      drawAttachments();
    });
  };

  async function uploadFile(file, att) {
    const end = await uploadToMachine(file, (pct) => { att.pct = pct; drawAttachments(); });
    att.path = end.path; att.size = end.size; att.done = true;
  }

  fileInput.onchange = async () => {
    const files = [...fileInput.files];
    fileInput.value = '';
    for (const f of files) {
      const att = { name: f.name, pct: 0, done: false, failed: false };
      attachments.push(att);
      drawAttachments();
      try { await uploadFile(f, att); }
      catch (e) { att.failed = true; toast(`Upload failed: ${e.message}`, 'err'); }
      drawAttachments();
    }
  };

  async function doSend() {
    const typed = input.value.trim();
    const ready = attachments.filter((a) => a.done);
    if (attachments.some((a) => !a.done && !a.failed)) return toast('Still uploading…', '');
    if (!typed && !ready.length) return;
    let text = typed || 'Take a look at the attached file(s).';
    if (ready.length) {
      text = `[Attached files — uploaded to this machine, read them from these paths:\n${ready.map((a) => `- ${a.path}`).join('\n')}]\n\n${text}`;
    }
    closePalette();
    input.value = ''; input.style.height = 'auto';
    syncSendBtn();
    const fresh = freshKeys.has(key);
    try {
      const r = await req('claude.send', { sessionKey: key, prompt: text, model: localStorage.getItem('ms_model') || undefined, fresh: fresh || undefined });
      if (r.queued) toast(`Queued (#${r.position}) — runs when Claude is free`, '');
      freshKeys.delete(key);
      saveDraft(key, '');
      attachments.length = 0;
      drawAttachments();
    } catch (e) { toast(e.message, 'err'); input.value = typed; syncSendBtn(); }
  }
  async function doStop() {
    try { await req('claude.stop', { sessionKey: key }); } catch (e) { toast(e.message, 'err'); }
  }
}

/* palette */
const DEFAULT_SNIPPETS = [
  { label: 'Where are we at?', text: 'where are we at? read the vault project page and give me: phase, last session, open items, top 3 next steps.' },
  { label: 'Wrap it up', text: 'wrap it up — full vault save, session summary, continuation prompt.' },
  { label: 'Ship to dev', text: 'commit and push this to dev, confirm the dev site deployed, give me the URL.' },
  { label: 'Run checks', text: 'run the syntax checks / tests for what we changed and report honestly.' },
  { label: 'What broke?', text: 'read the latest logs and tell me what broke, root cause first, no code yet.' },
];
let skillSnips = [];      // real skills from the machine, fetched once per view
let skillSnipsAt = 0;
function refreshSkills() {
  if (Date.now() - skillSnipsAt < 300000) return; // 5-min cache
  skillSnipsAt = Date.now();
  req('skills.list').then((r) => {
    skillSnips = (r.skills || []).map((s) => ({ label: `/${s.name}`, text: `/${s.name}`, desc: s.description }));
  }).catch(() => {});
}
function getSnippets() {
  try { return [...JSON.parse(localStorage.getItem('ms_snippets') || '[]'), ...skillSnips, ...DEFAULT_SNIPPETS]; }
  catch { return [...skillSnips, ...DEFAULT_SNIPPETS]; }
}
function openPalette(input) {
  closePalette();
  const q = input.value.slice(1).toLowerCase();
  const items = getSnippets().filter((s) => !q || s.label.toLowerCase().includes(q) || s.text.toLowerCase().includes(q));
  if (!items.length) return;
  const p = document.createElement('div');
  p.className = 'palette'; p.id = 'cmdPalette';
  p.innerHTML = items.slice(0, 8).map((s, i) => `<div class="item" data-i="${i}"><strong>${esc(s.label)}</strong><div class="sub">${esc((s.desc || s.text).slice(0, 90))}</div></div>`).join('');
  document.body.appendChild(p);
  p.querySelectorAll('.item').forEach((it) => it.onclick = () => {
    input.value = items[+it.dataset.i].text;
    input.dispatchEvent(new Event('input'));
    closePalette(); input.focus();
  });
}
function closePalette() { document.getElementById('cmdPalette')?.remove(); }

function sessionMenu(key) {
  const fresh = freshKeys.has(key);
  const s = sheet(`
    <h2>Session</h2>
    <div class="field"><label>Rename</label><input id="smName" value="${esc((S.sessions.find((x) => x.key === key) || {}).name || '')}"></div>
    <div class="field"><label>Model (switch if one is maxed out — e.g. Fable at 100%)</label>
      <select id="smModel">
        <option value="">Account default</option>
        <option value="opus[1m]">Opus 4.8 (1M context)</option>
        <option value="opus">Opus 4.8</option>
        <option value="claude-fable-5">Fable 5</option>
        <option value="sonnet">Sonnet</option>
        <option value="haiku">Haiku</option>
      </select></div>
    <button class="btn ghost" id="smFresh" style="width:100%;margin-bottom:10px">${fresh ? '✓ Fresh context on next message — tap to cancel' : '🧠 New chat (fresh context on next message)'}</button>
    <div class="actions">
      <button class="btn ghost" id="smSave">Save</button>
      <button class="btn ghost" id="smArchive">🗂 Archive</button>
      <button class="btn danger" id="smDelete">🗑 Delete</button>
    </div>
    <div class="sub muted small" style="margin-top:10px">Archive hides the card (restorable from 🗂 Archived on the list). Delete also removes its chat history here — the Claude Code session on the machine itself is never touched.</div>`);
  s.el.querySelector('#smFresh').onclick = () => {
    if (freshKeys.has(key)) {
      freshKeys.delete(key);
      toast('Fresh context cancelled — next message resumes', '');
    } else {
      freshKeys.add(key);
      toast('Next message starts a fresh Claude context', 'ok');
      document.getElementById('chatScroll')?.insertAdjacentHTML('beforeend',
        `<div class="small muted" style="text-align:center">— next message starts a fresh context —</div>`);
    }
    s.close();
  };
  s.el.querySelector('#smModel').value = (S.sessions.find((x) => x.key === key) || {}).model || '';
  s.el.querySelector('#smModel').onchange = async (e) => {
    try { await req('session.setmodel', { key, model: e.target.value || null }); toast(`Model → ${e.target.value || 'default'}`, 'ok'); }
    catch (err) { toast(err.message, 'err'); }
  };
  s.el.querySelector('#smSave').onclick = async () => {
    try { await req('session.rename', { key, name: s.el.querySelector('#smName').value }); s.close(); } catch (e) { toast(e.message, 'err'); }
  };
  s.el.querySelector('#smArchive').onclick = async () => {
    try { await req('session.archive', { key }); s.close(); nav('sessions'); } catch (e) { toast(e.message, 'err'); }
  };
  s.el.querySelector('#smDelete').onclick = async () => {
    s.close();
    const ok = await confirmSheet({ title: 'Delete session?', body: DELETE_BODY, confirmText: 'Delete' });
    if (!ok) return;
    try { await req('session.delete', { key }); nav('sessions'); } catch (e) { toast(e.message, 'err'); }
  };
}
