// Raw terminal tab — persistent xterm session that survives view switches.
import { S, req, send, on, toast, esc } from '../app.js';

let term = null, fit = null, container = null, termId = null, opened = false, unsub = null, mode = null;

export function destroy() {
  // keep the terminal alive across tabs; just stop listening for layout
  window.removeEventListener('resize', onResize);
}

function onResize() {
  if (fit && container?.isConnected) { try { fit.fit(); pushSize(); } catch {} }
}
function pushSize() {
  if (term && opened) send({ type: 'term.resize', termId, cols: term.cols, rows: term.rows });
}

export function render(el) {
  el.innerHTML = `
    <div class="termwrap">
      <div class="row" style="padding:2px 0 8px">
        <div class="grow section-title" style="margin:0">Terminal — ${esc(S.machine || '—')} ${mode ? `<span class="chip ${mode === 'pty' ? 'green' : 'amber'}">${mode}</span>` : ''}</div>
        <button class="btn ghost small" id="termNew">↻ restart</button>
      </div>
      <div id="termHost"></div>
      <div class="quickkeys">
        <button data-k="">Esc</button>
        <button data-k="\t">Tab</button>
        <button data-k="">Ctrl+C</button>
        <button data-k="[A">↑</button>
        <button data-k="[B">↓</button>
        <button id="qkPaste">Paste</button>
        <button id="qkClear">Clear</button>
      </div>
    </div>`;

  const host = el.querySelector('#termHost');

  if (!term) {
    term = new window.Terminal({
      fontFamily: 'ui-monospace, Cascadia Code, Consolas, monospace',
      fontSize: 13,
      theme: { background: '#0b0f16', foreground: '#d7e0ee', cursor: '#5b9dff', selectionBackground: 'rgba(91,157,255,.3)' },
      cursorBlink: true,
      scrollback: 4000,
    });
    fit = new window.FitAddon.FitAddon();
    term.loadAddon(fit);
    container = document.createElement('div');
    container.style.height = '100%';
    term.open(container);
    term.onData((d) => { if (opened) send({ type: 'term.input', termId, data: d }); });
  }
  host.appendChild(container);
  setTimeout(() => { try { fit.fit(); pushSize(); } catch {} }, 30);
  window.addEventListener('resize', onResize);

  if (!unsub) {
    unsub = on('term.data', (m) => { if (m.termId === termId && term) term.write(m.data); });
    on('term.exit', (m) => {
      if (m.termId === termId && term) { term.writeln('\r\n\x1b[31m[terminal exited]\x1b[0m'); opened = false; }
    });
    on('machine.offline', () => { opened = false; });
  }

  const openTerm = async (fresh = false) => {
    if (opened && !fresh) return;
    termId = `t${Date.now().toString(36)}`;
    try {
      const r = await req('term.open', { termId, cols: term.cols, rows: term.rows });
      mode = r.mode; opened = true;
      if (fresh) term.reset();
      if (r.mode === 'pipe') term.writeln('\x1b[33m[pipe mode — PTY unavailable on this machine; line-based only]\x1b[0m');
      el.querySelector('.section-title').innerHTML = `Terminal — ${esc(S.machine)} <span class="chip ${mode === 'pty' ? 'green' : 'amber'}">${mode}</span>`;
    } catch (e) { term.writeln(`\x1b[31m[${e.message}]\x1b[0m`); }
  };
  if (S.online) openTerm();
  else term.writeln('\x1b[33m[machine offline — connect the bridge first]\x1b[0m');

  el.querySelector('#termNew').onclick = () => { send({ type: 'term.close', termId }); opened = false; openTerm(true); };
  el.querySelectorAll('.quickkeys [data-k]').forEach((b) => b.onclick = () => { if (opened) send({ type: 'term.input', termId, data: b.dataset.k }); term.focus(); });
  el.querySelector('#qkClear').onclick = () => term.clear();
  el.querySelector('#qkPaste').onclick = async () => {
    try { const t = await navigator.clipboard.readText(); if (t && opened) send({ type: 'term.input', termId, data: t }); } catch { toast('Clipboard blocked', 'err'); }
  };
}
