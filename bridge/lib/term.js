// Terminal sessions. Prefers a real PTY (ConPTY via prebuilt node-pty) so the
// PWA gets a genuine interactive shell; degrades to pipe mode (line-based
// PowerShell) if the optional dep failed to install.
const os = require('os');
const { spawn, execFile } = require('child_process');

let pty = null;
try { pty = require('@homebridge/node-pty-prebuilt-multiarch'); } catch { /* pipe fallback */ }

const terms = new Map(); // termId -> {mode, proc, owner, lastUsed}
const IDLE_MS = 30 * 60_000;

setInterval(() => {
  const now = Date.now();
  for (const [id, t] of terms) if (now - t.lastUsed > IDLE_MS) close(id);
}, 60_000).unref();

function ptyAvailable() { return !!pty; }

function open({ termId, cwd, cols = 80, rows = 24, owner, onData, onExit }) {
  if (terms.has(termId)) close(termId);
  const dir = cwd || os.homedir();
  if (pty) {
    const proc = pty.spawn('powershell.exe', ['-NoLogo'], {
      name: 'xterm-256color', cols, rows, cwd: dir, env: process.env,
    });
    proc.onData((d) => { const t = terms.get(termId); if (t) t.lastUsed = Date.now(); onData(d); });
    proc.onExit(({ exitCode }) => { terms.delete(termId); onExit(exitCode); });
    terms.set(termId, { mode: 'pty', proc, owner, lastUsed: Date.now() });
    return { mode: 'pty' };
  }
  const proc = spawn('powershell.exe', ['-NoLogo', '-NoProfile'], { cwd: dir, windowsHide: true });
  proc.stdout.on('data', (c) => { const t = terms.get(termId); if (t) t.lastUsed = Date.now(); onData(c.toString('utf8')); });
  proc.stderr.on('data', (c) => onData(c.toString('utf8')));
  proc.on('close', (code) => { terms.delete(termId); onExit(code); });
  terms.set(termId, { mode: 'pipe', proc, owner, lastUsed: Date.now() });
  return { mode: 'pipe' };
}

function input(termId, data) {
  const t = terms.get(termId);
  if (!t) return;
  t.lastUsed = Date.now();
  if (t.mode === 'pty') t.proc.write(data);
  else t.proc.stdin.write(data.replace(/\r/g, '\r\n')); // pipe mode is line-based
}

function resize(termId, cols, rows) {
  const t = terms.get(termId);
  if (t && t.mode === 'pty') { try { t.proc.resize(cols, rows); } catch {} }
}

function close(termId) {
  const t = terms.get(termId);
  if (!t) return;
  terms.delete(termId);
  try {
    if (t.mode === 'pty') t.proc.kill();
    else execFile('taskkill', ['/pid', String(t.proc.pid), '/t', '/f'], { windowsHide: true }, () => {});
  } catch {}
}

function closeOwnedBy(owner) {
  for (const [id, t] of terms) if (t.owner === owner) close(id);
}

module.exports = { open, input, resize, close, closeOwnedBy, ptyAvailable };
