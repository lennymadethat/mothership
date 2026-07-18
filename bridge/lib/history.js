// Native Claude Code session history — scans ~/.claude/projects/*/*.jsonl.
// This is the "persistent memory forever" layer: Claude Code already stores
// every session transcript on disk; we surface it.
const fs = require('fs');
const path = require('path');
const os = require('os');

const PROJECTS = path.join(os.homedir(), '.claude', 'projects');

function prettyProject(dirName) {
  // "C--Users-lenny-Documents-my-repo" → best-effort trailing segment
  const parts = dirName.split('-').filter(Boolean);
  return parts.length ? parts.slice(-2).join('-') : dirName;
}

function scanHead(file) {
  // one 64KB read captures both the preview text and the session's cwd —
  // cwd is what lets History cards be re-adopted as live phone sessions.
  let preview = '', cwd = '';
  try {
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(64 * 1024);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    for (const line of buf.toString('utf8', 0, n).split('\n')) {
      try {
        const j = JSON.parse(line);
        if (!cwd && j.cwd) cwd = j.cwd;
        if (!preview && j.type === 'user' && j.message) {
          const c = j.message.content;
          const text = typeof c === 'string' ? c : (Array.isArray(c) ? c.filter((b) => b.type === 'text').map((b) => b.text).join(' ') : '');
          if (text && !text.startsWith('<')) preview = text.slice(0, 140);
        }
        if (preview && cwd) break;
      } catch { /* partial last line of the read window */ }
    }
  } catch {}
  return { preview, cwd };
}

function list({ limit = 60 } = {}) {
  const out = [];
  let dirs = [];
  try { dirs = fs.readdirSync(PROJECTS); } catch { return { sessions: [] }; }
  for (const d of dirs) {
    const pd = path.join(PROJECTS, d);
    let files = [];
    try { files = fs.readdirSync(pd).filter((f) => f.endsWith('.jsonl')); } catch { continue; }
    for (const f of files) {
      try {
        const st = fs.statSync(path.join(pd, f));
        out.push({
          sessionId: f.replace('.jsonl', ''),
          projectDir: d,
          project: prettyProject(d),
          mtime: st.mtimeMs,
          size: st.size,
        });
      } catch {}
    }
  }
  out.sort((a, b) => b.mtime - a.mtime);
  const top = out.slice(0, limit);
  for (const s of top) {
    const h = scanHead(path.join(PROJECTS, s.projectDir, `${s.sessionId}.jsonl`));
    s.preview = h.preview;
    s.cwd = h.cwd;
  }
  return { sessions: top, total: out.length };
}

function read({ projectDir, sessionId, limit = 120 }) {
  if (!/^[A-Za-z0-9._-]+$/.test(projectDir || '') || !/^[A-Za-z0-9-]+$/.test(sessionId || '')) {
    return { error: 'bad ref', messages: [] };
  }
  const file = path.join(PROJECTS, projectDir, `${sessionId}.jsonl`);
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (e) { return { error: e.message, messages: [] }; }
  const messages = [];
  let cwd = '';
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let j;
    try { j = JSON.parse(line); } catch { continue; }
    if (!cwd && j.cwd) cwd = j.cwd;
    if (j.type !== 'user' && j.type !== 'assistant') continue;
    const c = j.message?.content;
    let text = '';
    const tools = [];
    if (typeof c === 'string') text = c;
    else if (Array.isArray(c)) {
      for (const b of c) {
        if (b.type === 'text') text += b.text;
        else if (b.type === 'tool_use') tools.push(b.name);
      }
    }
    if (!text && !tools.length) continue;
    if (j.type === 'user' && text.startsWith('<')) continue; // system-reminder noise
    messages.push({ role: j.type, text: text.slice(0, 4000), tools, ts: j.timestamp || null });
  }
  return { messages: messages.slice(-limit), sessionId, projectDir, cwd };
}

module.exports = { list, read };
