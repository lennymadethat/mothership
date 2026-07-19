// Mothership Bridge — runs on each machine (desktop, laptop, ...).
// Dials OUT to the hub Worker over WebSocket; no inbound ports ever.
const fs = require('fs');
const path = require('path');
const os = require('os');
const WebSocket = require('ws');
const claude = require('./lib/claude');
const term = require('./lib/term');
const sys = require('./lib/system');
const history = require('./lib/history');

/* ---------------- config + data ---------------- */

const ROOT = __dirname;
const CONFIG_PATH = path.join(ROOT, 'config.json');
if (!fs.existsSync(CONFIG_PATH)) {
  console.error('No config.json — copy config.example.json and fill hubUrl/machine/token.');
  process.exit(1);
}
const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
const DATA = path.join(ROOT, 'data');
const TRANSCRIPTS = path.join(DATA, 'transcripts');
fs.mkdirSync(TRANSCRIPTS, { recursive: true });

const SESSIONS_PATH = path.join(DATA, 'sessions.json');
let sessions = {};
try { sessions = JSON.parse(fs.readFileSync(SESSIONS_PATH, 'utf8')); } catch {}
const saveSessions = () => fs.writeFileSync(SESSIONS_PATH, JSON.stringify(sessions, null, 2));

function appendTranscript(key, entry) {
  try { fs.appendFileSync(path.join(TRANSCRIPTS, `${key}.jsonl`), JSON.stringify(entry) + '\n'); } catch {}
}
function readTranscript(key, limit = 200) {
  try {
    const raw = fs.readFileSync(path.join(TRANSCRIPTS, `${key}.jsonl`), 'utf8');
    return raw.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean).slice(-limit);
  } catch { return []; }
}

/* Verbatim recent transcript for priming a rolled-over session.
   Lenny's call (2026-07-17): carry the ACTUAL conversation forward, not a
   lossy <brief> summary. The raw turns are cheap ("we're not writing that
   much") and keep every detail the successor needs. Walk from newest back,
   accumulating real user/assistant turns until the char budget is hit, so
   it's the most-recent slice and can't grow without bound across parts. */
const ROLLOVER_TAIL_BUDGET = 140_000; // ~35k tokens of verbatim tail
function buildRolloverTranscript(key, budget = ROLLOVER_TAIL_BUDGET) {
  const turns = readTranscript(key, 500);
  const out = [];
  let used = 0;
  for (let i = turns.length - 1; i >= 0; i--) {
    const t = turns[i];
    let line;
    if (t.role === 'user') line = `USER: ${(t.text || '').trim()}`;
    else if (t.role === 'assistant') line = `ASSISTANT: ${(t.text || '').trim()}`;
    else if (t.role === 'rollover') line = `— part ${t.part} —`;
    else continue;
    if (!line.slice(line.indexOf(' ') + 1)) continue; // skip empty turns
    used += line.length + 2;
    if (used > budget && out.length) break;
    out.push(line);
  }
  return out.reverse().join('\n\n');
}

const SAFE_KEY = /^[a-z0-9][a-z0-9-]{0,47}$/;

// Repo default + normalization: blank → the user's home folder (NOT C:\ root).
// Claude Code keys its persistent memory + project context off the session cwd;
// home matches Lenny's desk sessions so Mothership sessions share the same
// memory bank (Lenny's call 2026-07-17). A bare drive letter ("C:") would
// otherwise resolve to the *bridge's* cwd on Windows, so expand it to the root.
function normalizeRepo(repo) {
  const r = String(repo || '').trim();
  if (!r) return process.env.USERPROFILE || 'C:\\';
  if (/^[A-Za-z]:$/.test(r)) return r + '\\';
  return r;
}

/* ---------------- uploads (phone → machine, base64 chunks over WS) ---------------- */

const UPLOADS = path.join(DATA, 'uploads');
const MAX_UPLOAD = 200 * 1024 * 1024;
const uploads = new Map(); // uploadId -> {fd, path, received, timer}

function uploadCleanup(uploadId, removeFile) {
  const u = uploads.get(uploadId);
  if (!u) return;
  clearTimeout(u.timer);
  try { fs.closeSync(u.fd); } catch {}
  if (removeFile) { try { fs.unlinkSync(u.path); } catch {} }
  uploads.delete(uploadId);
}
function touchUpload(uploadId) {
  const u = uploads.get(uploadId);
  clearTimeout(u.timer);
  u.timer = setTimeout(() => uploadCleanup(uploadId, true), 120_000); // stalled → drop partial file
}

/* ---------------- file downloads (machine → phone, streamed via the DO) ---------------- */

const MIME = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp',
  avif: 'image/avif', bmp: 'image/bmp', svg: 'image/svg+xml', ico: 'image/x-icon',
  mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', mkv: 'video/x-matroska',
  mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', ogg: 'audio/ogg', flac: 'audio/flac',
  pdf: 'application/pdf', txt: 'text/plain; charset=utf-8', md: 'text/plain; charset=utf-8',
  json: 'application/json', csv: 'text/csv', log: 'text/plain; charset=utf-8',
  html: 'text/html; charset=utf-8', css: 'text/css', js: 'text/javascript',
};
const fileSends = new Map(); // fileId -> {stream, timer}

function armFileTimer(fileId) {
  const f = fileSends.get(fileId);
  if (!f) return;
  clearTimeout(f.timer);
  // no ack for 60s = the DO/phone is gone — stop reading, release the handle
  f.timer = setTimeout(() => { try { f.stream.destroy(); } catch {} fileSends.delete(fileId); }, 60_000);
}

function startFileSend(msg) {
  const fileId = msg.fileId;
  let st;
  const abs = path.resolve(String(msg.path || ''));
  try { st = fs.statSync(abs); } catch (e) { return send({ type: 'file.meta', fileId, error: e.message }); }
  if (!st.isFile()) return send({ type: 'file.meta', fileId, error: 'not a file' });
  const ext = path.extname(abs).slice(1).toLowerCase();
  send({ type: 'file.meta', fileId, name: path.basename(abs), size: st.size, mime: MIME[ext] || 'application/octet-stream' });
  // 384KB binary → ~512KB base64, safely under the 1 MiB WS message cap.
  // One chunk in flight at a time: pause after each, resume on the DO's ack.
  const stream = fs.createReadStream(abs, { highWaterMark: 384 * 1024 });
  fileSends.set(fileId, { stream, timer: null });
  armFileTimer(fileId);
  stream.on('data', (buf) => {
    stream.pause();
    send({ type: 'file.chunk', fileId, data: buf.toString('base64') });
  });
  stream.on('end', () => {
    const f = fileSends.get(fileId);
    if (f) { clearTimeout(f.timer); fileSends.delete(fileId); }
    send({ type: 'file.chunk', fileId, done: true });
  });
  stream.on('error', (e) => {
    const f = fileSends.get(fileId);
    if (f) { clearTimeout(f.timer); fileSends.delete(fileId); }
    send({ type: 'file.chunk', fileId, error: e.message });
  });
}

/* ---------------- hub connection ---------------- */

const wsBase = `${cfg.hubUrl.replace(/^http/, 'ws').replace(/\/$/, '')}/api/bridge/${cfg.machine}`;
const wsUrl = cfg.token ? `${wsBase}?token=${encodeURIComponent(cfg.token)}` : wsBase;
let ws = null;
let backoff = 1000;

function send(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) { try { ws.send(JSON.stringify(obj)); } catch {} }
}
const reply = (msg, payload) => send({ type: 'res', id: msg.id, clientId: msg.clientId, ...payload });

function info() {
  return {
    hostname: os.hostname(),
    platform: `${os.platform()} ${os.release()}`,
    arch: os.arch(),
    node: process.version,
    claude: claude.claudeVersion(),
    pty: term.ptyAvailable(),
    bridgeVersion: require('./package.json').version,
    user: os.userInfo().username,
    // machine-level billing default: an API key in the env means API billing,
    // otherwise headless runs ride the logged-in claude.ai subscription
    auth: process.env.ANTHROPIC_API_KEY ? 'api' : 'subscription',
  };
}

function connect() {
  console.log(`[bridge] connecting → ${cfg.hubUrl} as "${cfg.machine}"`);
  ws = new WebSocket(wsUrl);

  // protocol-level heartbeat: CF answers ping frames at the edge without waking the DO,
  // so a missing pong means the link is actually dead — terminate to trigger fast reconnect
  let pongDeadline = null;
  const heartbeat = setInterval(() => {
    if (ws.readyState !== WebSocket.OPEN) return;
    try { ws.ping(); } catch {}
    if (!pongDeadline) pongDeadline = setTimeout(() => { console.log('[bridge] heartbeat lost — reconnecting'); try { ws.terminate(); } catch {} }, 15_000);
  }, 20_000);
  ws.on('pong', () => { clearTimeout(pongDeadline); pongDeadline = null; });

  ws.on('open', () => {
    backoff = 1000;
    console.log('[bridge] connected');
    send({ type: 'hello', info: info() });
  });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    try { dispatch(msg); } catch (e) {
      console.error('[bridge] dispatch error', msg.type, e.message);
      if (msg.id) reply(msg, { error: e.message });
    }
  });

  ws.on('close', () => {
    clearInterval(heartbeat);
    clearTimeout(pongDeadline);
    console.log(`[bridge] disconnected — retry in ${backoff / 1000}s`);
    setTimeout(connect, backoff);
    backoff = Math.min(backoff * 2, 60_000);
  });
  ws.on('error', (e) => console.error('[bridge] ws error:', e.message));
}

setInterval(() => {
  sys.stats((s) => send({ type: 'ping', stats: s }));
}, 30_000);

/* ---------------- claude session plumbing ---------------- */

function sessionList() {
  return Object.values(sessions)
    .filter((s) => !s.archived)
    .sort((a, b) => (b.lastUsed || 0) - (a.lastUsed || 0));
}
function archivedList() {
  return Object.values(sessions)
    .filter((s) => s.archived)
    .sort((a, b) => (b.lastUsed || 0) - (a.lastUsed || 0));
}

// prompts sent while a run is active queue here and feed the NEXT run
// (mirrors the CLI: keep typing + Enter, Claude reads them when it's free)
const queues = {}; // key -> [{prompt, model}]

/* ---- context tracking + seamless rollover ----
   Every run's result carries token usage. When a session crosses
   ROLLOVER_PCT we auto-run the wrap-it-up close-out in the OLD context
   (vault save + PERSISTENT STATE ledger + continuation brief), then the next
   user message silently starts a FRESH claude session primed with:
     1) the lossless PERSISTENT STATE (plans/todos/decisions/paths/pointers/dead-ends)
     2) a short orientation brief
     3) the VERBATIM recent transcript tail
     4) a RECALL pointer so anything older can be pulled back exactly
   The Mothership transcript is ours (per-key JSONL), so the chat scrolls
   seamlessly across parts — s.part counts the stitched sessions (the ticks).
   See docs/long-session-memory.md for the design. */

const ROLLOVER_PCT = 92; // fire before the CLI's own ~95% auto-compact beats us to it

/** True if this card has anything worth re-priming after a lost native resume id. */
function hasPrimableHistory(key) {
  const s = sessions[key];
  if (!s || s.archived) return false;
  if (s.persistentState || s.pendingBrief || s.handoff) return true;
  if (s.part && s.part > 1) return true;
  return readTranscript(key, 5).some((t) => t.role === 'user' || t.role === 'assistant');
}

function computeCtx(ev) {
  const u = ev.usage;
  if (!u) return null;
  const used = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0)
    + (u.cache_creation_input_tokens || 0) + (u.output_tokens || 0);
  if (!used) return null;
  let limit = 200_000;
  const entries = ev.modelUsage ? Object.values(ev.modelUsage) : [];
  const main = entries.sort((a, b) =>
    ((b.inputTokens || 0) + (b.cacheReadInputTokens || 0)) - ((a.inputTokens || 0) + (a.cacheReadInputTokens || 0)))[0];
  if (main?.contextWindow) limit = main.contextWindow;
  return { used, limit, pct: Math.min(100, Math.round((used / limit) * 100)) };
}

function drainQueue(key) {
  const q = queues[key];
  if (!q || !q.length) return;
  const items = q.splice(0, q.length);
  const combined = items.map((i) => i.prompt).join('\n\n');
  const mdl = items.map((i) => i.model).filter(Boolean).pop();
  setTimeout(() => {
    try { startRun(key, combined, { model: mdl }); }
    catch (e) { send({ type: 'claude.event', key, ev: { kind: 'done', ok: false, error: `queued run failed: ${e.message}` } }); }
  }, 300);
}

function startRollover(key) {
  const s = sessions[key];
  if (!s || s.rolling || claude.isBusy(key)) return;
  s.rolling = true;
  const nextPart = (s.part || 1) + 1;
  send({ type: 'claude.event', key, ev: { kind: 'rollover.start', part: nextPart } });
  const wrapPrompt =
    `[AUTOMATIC CONTEXT ROLLOVER — this conversation is at ~${s.ctx?.pct ?? ROLLOVER_PCT}% of its context window. Do ALL THREE steps now:]\n`
    + `1. Wrap it up: run the full close-out per your project rules (project page, log entry, chat summary — whatever your workflow uses).\n`
    + `2. Output the PERSISTENT STATE between <state> and </state> tags — a compact LOSSLESS ledger that survives EVERY future rollover, so nothing important can silently drop. Carry the prior persistent state forward and UPDATE it; never remove an item unless it's actually resolved. Headings: PLANS (named, with current step), OPEN TODOS, DECISIONS (dated), KEY FILES/PATHS, POINTERS (where a live value lives — e.g. "token: read from .env / the worker" — NEVER paste the value; a copied secret goes stale and becomes a confidently-wrong answer), DEAD ENDS (what was tried + why abandoned, so it isn't retried). Stamp volatile facts "as of part ${nextPart - 1}"; a newer fact overrides an older one.\n`
    + `3. Output the continuation brief between <brief> and </brief> tags: the project, repo/paths, the exact current task and its state, decisions made, in-flight work, next steps, and gotchas. `
    + `Everything the next session needs to continue mid-stride. No greetings, nothing outside the tags.`;
  // If native resume is gone, prime the wrap itself from persistentState +
  // transcript so a multi-part chat never rolls over into an empty brain.
  let wrapFinal = wrapPrompt;
  let wrapResume = s.claudeSessionId;
  if (!wrapResume && hasPrimableHistory(key)) {
    const tail = buildRolloverTranscript(key);
    wrapFinal =
      (s.persistentState ? `[PERSISTENT STATE — current truth for this wrap:]\n${s.persistentState}\n\n` : '')
      + (tail ? `[VERBATIM RECENT TRANSCRIPT:]\n${tail}\n[End transcript.]\n\n` : '')
      + wrapPrompt;
  }
  try {
    claude.run({
      key, prompt: wrapFinal, cwd: s.repo, model: s.model,
      resumeSessionId: wrapResume,
      onEvent: (ev) => {
        if (ev.kind !== 'done') return; // wrap runs silently — no UI streaming
        s.rolling = false;
        const text = ev.text || '';
        // Persistent State — lossless ledger, pinned on every future re-prime.
        // Kept on the session across ALL parts; only replaced when the wrap
        // emits a fresh one (a failed/state-less wrap preserves the last good one).
        const ms = text.match(/<state>([\s\S]*?)<\/state>/);
        const st = ms && ms[1].trim().slice(0, 14_000);
        if (st) s.persistentState = st;
        const m = text.match(/<brief>([\s\S]*?)<\/brief>/);
        s.pendingBrief = (m ? m[1] : text).trim().slice(0, 24_000) || null;
        s.part = nextPart;
        s.claudeSessionId = null; // next run starts a fresh claude session
        s.handoff = true; // force re-prime of the next user turn with state + tail
        s.ctx = null;
        saveSessions();
        appendTranscript(key, { role: 'rollover', part: s.part, ok: ev.ok, ts: Date.now() });
        send({ type: 'claude.event', key, ev: { kind: 'rollover.done', part: s.part, ok: ev.ok } });
        send({ type: 'sessions', sessions: sessionList() });
        send({
          type: 'notify', title: `🧠 ${s.name}: rolled into part ${s.part}`,
          body: 'Context archived — keep talking, the chat continues seamlessly.',
          tag: `roll-${key}`,
        });
        drainQueue(key); // anything typed during the wrap runs now, on the fresh context
      },
    });
  } catch (e) {
    s.rolling = false;
    send({ type: 'claude.event', key, ev: { kind: 'rollover.done', part: s.part || 1, ok: false, error: e.message } });
    drainQueue(key);
  }
}

function startRun(key, prompt, { model, fresh } = {}) {
  const s = sessions[key];
  const startedAt = Date.now();
  let finalPrompt = prompt;
  let resume = fresh ? null : s.claudeSessionId;
  if (fresh) { s.pendingBrief = null; s.persistentState = null; s.handoff = false; }
  // Re-prime rule: if there's no native resume id but the card has history
  // (multi-part chat, persistentState, transcript), always inject state +
  // verbatim tail + recall pointer. handoff / pendingBrief still force
  // re-prime even WITH a resume id (model switch / rollover).
  const needsReprime = !fresh && (
    s.pendingBrief || s.handoff
    || (!resume && hasPrimableHistory(key))
  );
  if (needsReprime) {
    const tail = buildRolloverTranscript(key);
    const recallCmd = `node "${path.join(ROOT, 'recall.mjs')}" --key "${key}" --query "<keywords>"`;
    finalPrompt =
      `[SEAMLESS CONTINUATION — part ${(s.part || 1)} of one ongoing conversation. `
      + `The user sees a single continuous chat: do NOT greet, recap, or mention any rollover${s.handoff ? ' or model switch' : ''}.]\n`
      + (s.persistentState ? `[PERSISTENT STATE — a lossless ledger carried across ALL parts; treat as current truth. Any value here is a POINTER: read the live copy at its source, never trust a pasted secret/token as current.]\n${s.persistentState}\n\n` : '')
      + (s.pendingBrief ? `[Summary of earlier context, orientation only:]\n${s.pendingBrief}\n\n` : '')
      + (tail ? `[VERBATIM RECENT TRANSCRIPT — the actual conversation so far; continue from where it leaves off:]\n${tail}\n[End transcript.]\n\n` : '')
      + `[RECALL — every earlier turn of this whole conversation is archived on disk. If you need an exact detail from BEFORE the transcript above, don't guess or say you forgot — run: ${recallCmd} (add --any to widen, --part N to scope). It returns the past turns verbatim with citations.]\n\n`
      + `[The user's newest message follows — just continue.]\n\n${prompt}`;
    resume = null;
  }
  s.pendingBrief = null;
  s.handoff = false;
  saveSessions();
  const runId = claude.run({
    key,
    prompt: finalPrompt,
    cwd: s.repo,
    model: model || s.model,
    resumeSessionId: resume,
    onEvent: (ev) => {
      if (ev.kind === 'done') {
        const ctx = computeCtx(ev);
        if (ctx) { s.ctx = ctx; ev.ctx = ctx; }
        ev.part = s.part || 1;
      }
      send({ type: 'claude.event', key, runId, ev });
      if (ev.kind === 'init' && ev.sessionId) {
        s.claudeSessionId = ev.sessionId;
        if (ev.apiKeySource !== undefined) s.auth = ev.apiKeySource && ev.apiKeySource !== 'none' ? 'api' : 'subscription';
        saveSessions();
      }
      if (ev.kind === 'done') {
        s.lastUsed = Date.now();
        if (ev.sessionId) s.claudeSessionId = ev.sessionId;
        s.summary = (ev.text || '').slice(0, 160);
        saveSessions();
        appendTranscript(key, {
          role: 'assistant', text: ev.text, tools: ev.tools, ok: ev.ok,
          error: ev.error, cost: ev.cost, durationMs: ev.durationMs, ts: Date.now(),
        });
        const secs = Math.round((Date.now() - startedAt) / 1000);
        send({
          type: 'notify',
          title: ev.ok ? `✓ ${s.name} finished (${secs}s)` : `✗ ${s.name} failed`,
          body: (ev.text || ev.error || '').slice(0, 140),
          tag: `claude-${key}`,
        });
        // spoken recap: cheap haiku pass boils the essay down to 1-2
        // sentences; stored in the transcript + pushed live for the 🔊 button
        if (ev.ok && (ev.text || '').length > 350) {
          claude.recap(ev.text, (rec) => {
            if (!rec) return;
            appendTranscript(key, { role: 'recap', text: rec, ts: Date.now() });
            send({ type: 'claude.event', key, ev: { kind: 'recap', text: rec } });
          });
        }
        // context nearly full → wrap + roll BEFORE draining the queue
        // (queued prompts run after the rollover, on the fresh context)
        if (ev.ok && s.ctx && s.ctx.pct >= ROLLOVER_PCT && !s.rolling) {
          setTimeout(() => startRollover(key), 500);
        } else {
          drainQueue(key);
        }
      }
    },
  });
  return runId;
}

function runPrompt(msg) {
  const key = msg.sessionKey;
  const s = sessions[key];
  if (!s) return reply(msg, { error: 'unknown session' });

  const prompt = String(msg.prompt || '').slice(0, 100_000);
  if (!prompt.trim()) return reply(msg, { error: 'empty prompt' });

  const queued = claude.isBusy(key);
  appendTranscript(key, { role: 'user', text: prompt, queued: queued || undefined, ts: Date.now() });
  send({ type: 'claude.event', key, ev: { kind: 'user', text: prompt, queued: queued || undefined } });

  if (queued) {
    (queues[key] ||= []).push({ prompt, model: msg.model });
    s.lastUsed = Date.now();
    saveSessions();
    return reply(msg, { ok: true, queued: true, position: queues[key].length });
  }

  let runId;
  try { runId = startRun(key, prompt, { model: msg.model, fresh: msg.fresh }); }
  catch (e) { return reply(msg, { error: e.message }); }
  s.lastUsed = Date.now();
  saveSessions();
  reply(msg, { ok: true, runId });
}

/* ---------------- scheduler — standing orders ----------------
   [{id, name, time:"07:30", days:[1,2,3,4,5], repo, model, prompt, enabled, lastFired}]
   Fires through the normal run pipeline, so completion notifications, spoken
   recaps, queueing, and context rollover all apply. Wakes Lenny up with answers. */
const SCHEDULES_PATH = path.join(DATA, 'schedules.json');
let schedules = [];
try { schedules = JSON.parse(fs.readFileSync(SCHEDULES_PATH, 'utf8')); } catch {}
const saveSchedules = () => fs.writeFileSync(SCHEDULES_PATH, JSON.stringify(schedules, null, 2));

function fireSchedule(sc) {
  const key = sc.id;
  if (!sessions[key]) {
    sessions[key] = {
      key, name: `⏰ ${sc.name || 'schedule'}`.slice(0, 60),
      repo: normalizeRepo(sc.repo), model: sc.model || null,
      claudeSessionId: null, created: Date.now(), lastUsed: Date.now(), archived: false,
    };
    saveSessions();
    send({ type: 'sessions', sessions: sessionList() });
  }
  const queued = claude.isBusy(key);
  appendTranscript(key, { role: 'user', text: sc.prompt, queued: queued || undefined, ts: Date.now() });
  send({ type: 'claude.event', key, ev: { kind: 'user', text: sc.prompt, queued: queued || undefined } });
  if (queued) { (queues[key] ||= []).push({ prompt: sc.prompt, model: sc.model }); return; }
  try { startRun(key, sc.prompt, { model: sc.model }); } catch (e) {
    send({ type: 'notify', title: `⏰ ${sc.name || key} failed to start`, body: String(e.message || e).slice(0, 120), tag: `claude-${key}` });
  }
  sessions[key].lastUsed = Date.now();
  saveSessions();
}

function checkSchedules() {
  const now = new Date();
  const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  const stamp = `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`;
  for (const sc of schedules) {
    if (sc.enabled === false || !sc.prompt) continue;
    if (sc.time !== hhmm) continue;
    if (Array.isArray(sc.days) && sc.days.length && !sc.days.includes(now.getDay())) continue;
    if (sc.lastFired === stamp) continue;
    sc.lastFired = stamp;
    saveSchedules();
    try { fireSchedule(sc); } catch { /* never let one bad schedule kill the loop */ }
  }
}
setInterval(checkSchedules, 30_000);

/* ---------------- dispatch ---------------- */

function dispatch(msg) {
  switch (msg.type) {
    case 'pong': return;

    case 'client.hello':
      return sys.stats((stats) => send({
        type: 'snapshot', clientId: msg.clientId,
        machine: cfg.machine, info: info(), stats,
        sessions: sessionList(),
        busy: sessionList().filter((s) => claude.isBusy(s.key)).map((s) => s.key),
      }));

    case 'client.gone':
      return term.closeOwnedBy(msg.clientId);

    /* ---- claude sessions ---- */
    case 'session.create': {
      const key = String(msg.key || '').toLowerCase();
      if (!SAFE_KEY.test(key)) return reply(msg, { error: 'bad key' });
      if (sessions[key]) return reply(msg, { error: 'key exists' });
      sessions[key] = {
        key, name: String(msg.name || key).slice(0, 60),
        repo: normalizeRepo(msg.repo),
        model: msg.model || null,
        claudeSessionId: null, created: Date.now(), lastUsed: Date.now(), archived: false,
      };
      saveSessions();
      send({ type: 'sessions', sessions: sessionList() }); // broadcast to every device
      return reply(msg, { ok: true, session: sessions[key] });
    }
    case 'session.adopt': {
      // /beam — hand a native terminal Claude Code session to the hub so it
      // continues on the phone with full context (resumes the same session id)
      const key = String(msg.key || '').toLowerCase();
      if (!SAFE_KEY.test(key)) return reply(msg, { error: 'bad key' });
      const sid = String(msg.claudeSessionId || '');
      if (!/^[a-zA-Z0-9-]{8,64}$/.test(sid)) return reply(msg, { error: 'bad session id' });
      const existing = sessions[key];
      sessions[key] = {
        key, name: String(msg.name || key).slice(0, 60),
        repo: normalizeRepo(msg.repo),
        model: msg.model || existing?.model || null,
        claudeSessionId: sid,
        created: existing?.created || Date.now(), lastUsed: Date.now(), archived: false,
      };
      saveSessions();
      appendTranscript(key, {
        role: 'assistant', ok: true, ts: Date.now(),
        text: `🛸 **Beamed aboard** from the terminal (\`${sessions[key].repo}\`). Full context carried over — earlier turns are in the History tab; just keep talking.`,
      });
      send({ type: 'sessions', sessions: sessionList() });
      send({ type: 'notify', title: `🛸 ${sessions[key].name} beamed aboard`, body: 'Terminal session handed off — open Mothership to continue.', tag: `beam-${key}`, forcePush: true });
      return reply(msg, { ok: true, session: sessions[key] });
    }
    case 'session.setmodel': {
      // Change a session's model so a maxed-out model (e.g. Fable at 100%) can't
      // trap a session — the next message spawns with the new --model.
      const s = sessions[msg.key];
      if (!s) return reply(msg, { error: 'unknown session' });
      const m = msg.model || null;
      if (m && !/^[a-zA-Z0-9._[\]-]{1,64}$/.test(m)) return reply(msg, { error: 'bad model' });
      s.model = m;
      saveSessions();
      send({ type: 'sessions', sessions: sessionList() });
      return reply(msg, { ok: true, model: m });
    }
    case 'session.list': return reply(msg, { sessions: msg.archived ? archivedList() : sessionList() });
    case 'session.rename': {
      const s = sessions[msg.key];
      if (!s) return reply(msg, { error: 'unknown session' });
      s.name = String(msg.name || s.name).slice(0, 60);
      if (msg.repo !== undefined) s.repo = normalizeRepo(msg.repo);
      if (msg.model !== undefined) s.model = msg.model || null;
      saveSessions();
      send({ type: 'sessions', sessions: sessionList() });
      return reply(msg, { ok: true });
    }
    case 'session.archive': {
      const s = sessions[msg.key];
      if (!s) return reply(msg, { error: 'unknown session' });
      delete queues[msg.key];
      claude.stop(msg.key);
      s.archived = true;
      saveSessions();
      send({ type: 'sessions', sessions: sessionList() });
      return reply(msg, { ok: true });
    }
    case 'session.unarchive': {
      const s = sessions[msg.key];
      if (!s) return reply(msg, { error: 'unknown session' });
      s.archived = false;
      s.lastUsed = Date.now();
      saveSessions();
      send({ type: 'sessions', sessions: sessionList() });
      return reply(msg, { ok: true });
    }
    case 'session.delete': {
      // removes the card + the Mothership transcript file. The native Claude
      // Code conversation (~/.claude/projects) is untouched — still resumable
      // from the terminal and visible in the History tab.
      const key = String(msg.key || '');
      const s = SAFE_KEY.test(key) ? sessions[key] : null;
      if (!s) return reply(msg, { error: 'unknown session' });
      delete queues[key];
      claude.stop(key);
      delete sessions[key];
      try { fs.unlinkSync(path.join(TRANSCRIPTS, `${key}.jsonl`)); } catch {}
      saveSessions();
      send({ type: 'sessions', sessions: sessionList() });
      return reply(msg, { ok: true });
    }
    case 'session.transcript':
      return reply(msg, { transcript: readTranscript(msg.key), busy: claude.isBusy(msg.key) });

    case 'claude.send': return runPrompt(msg);
    case 'claude.stop': {
      delete queues[msg.sessionKey]; // stop means stop — pending queue dies too
      const stopped = claude.stop(msg.sessionKey);
      send({ type: 'claude.event', key: msg.sessionKey, ev: { kind: 'stopped' } });
      return reply(msg, { ok: stopped });
    }

    /* ---- native history ---- */
    case 'history.list': return reply(msg, history.list({ limit: msg.limit || 60 }));
    case 'history.read': return reply(msg, history.read(msg));

    /* ---- scheduler ---- */
    case 'sched.list': return reply(msg, { schedules });
    case 'sched.save': {
      const sc = { ...(msg.schedule || {}) };
      if (!/^\d{2}:\d{2}$/.test(sc.time || '')) return reply(msg, { error: 'bad time (use HH:MM)' });
      if (!String(sc.prompt || '').trim()) return reply(msg, { error: 'prompt required' });
      if (!sc.id) sc.id = ('sched-' + String(sc.name || 'job').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')).slice(0, 40) + '-' + Date.now().toString(36).slice(-4);
      if (!SAFE_KEY.test(sc.id)) return reply(msg, { error: 'bad id' });
      const i = schedules.findIndex((x) => x.id === sc.id);
      if (i >= 0) schedules[i] = { ...schedules[i], ...sc }; else schedules.push(sc);
      saveSchedules();
      return reply(msg, { ok: true, schedules });
    }
    case 'sched.delete': {
      schedules = schedules.filter((x) => x.id !== msg.id);
      saveSchedules();
      return reply(msg, { ok: true, schedules });
    }

    /* ---- skills → one-tap "/" palette on the phone ---- */
    case 'skills.list': {
      const skills = [];
      try {
        const dir = path.join(os.homedir(), '.claude', 'skills');
        for (const d of fs.readdirSync(dir)) {
          try {
            const raw = fs.readFileSync(path.join(dir, d, 'SKILL.md'), 'utf8').slice(0, 2000);
            const desc = /description:\s*([^\n]+)/i.exec(raw)?.[1] || '';
            skills.push({ name: d, description: desc.replace(/^['"]|['"]$/g, '').slice(0, 110) });
          } catch { /* not a skill dir */ }
        }
      } catch { /* no skills dir on this machine */ }
      return reply(msg, { skills });
    }

    /* ---- terminal ---- */
    case 'term.open': {
      const termId = String(msg.termId || '');
      const r = term.open({
        termId, cwd: msg.cwd, cols: msg.cols, rows: msg.rows, owner: msg.clientId,
        onData: (d) => send({ type: 'term.data', termId, data: d, clientId: msg.clientId }),
        onExit: (code) => send({ type: 'term.exit', termId, code, clientId: msg.clientId }),
      });
      return reply(msg, { ok: true, mode: r.mode });
    }
    case 'term.input': return term.input(msg.termId, msg.data);
    case 'term.resize': return term.resize(msg.termId, msg.cols, msg.rows);
    case 'term.close': return term.close(msg.termId);

    /* ---- claude process manager ---- */
    case 'claude.procs': return sys.claudeProcs((r) => reply(msg, r));
    case 'claude.procs.kill': {
      const pids = (Array.isArray(msg.pids) ? msg.pids : []).filter((p) => Number.isInteger(p) && p > 4).slice(0, 200);
      if (!pids.length) return reply(msg, { error: 'no valid pids' });
      let left = pids.length;
      const results = {};
      for (const pid of pids) {
        sys.killPid(pid, (r) => {
          results[pid] = r.ok ? 'killed' : (r.error || 'failed');
          if (--left === 0) reply(msg, { ok: true, results });
        });
      }
      return;
    }

    /* ---- system ---- */
    case 'sys.stats': return sys.stats((s) => reply(msg, { stats: s }));
    case 'sys.processes': return sys.processes((r) => reply(msg, r));
    case 'sys.kill': return sys.killPid(msg.pid, (r) => reply(msg, r));
    case 'sys.power': {
      if (!msg.confirm) return reply(msg, { error: 'confirmation required' });
      return sys.power(msg.action, (r) => {
        send({ type: 'notify', title: `⚡ Power: ${msg.action}`, body: `${cfg.machine} received ${msg.action}`, forcePush: true });
        reply(msg, r);
      });
    }
    case 'fs.list': return sys.fsList(msg.path, (r) => reply(msg, r));

    /* ---- file downloads (DO-initiated, no req/reply) ---- */
    case 'file.fetch': return startFileSend(msg);
    case 'file.ack': {
      armFileTimer(msg.fileId);
      fileSends.get(msg.fileId)?.stream.resume();
      return;
    }
    case 'file.cancel': {
      const f = fileSends.get(msg.fileId);
      if (f) { clearTimeout(f.timer); try { f.stream.destroy(); } catch {} fileSends.delete(msg.fileId); }
      return;
    }

    /* ---- uploads ---- */
    case 'upload.begin': {
      // sanitize: strip separators/devices, no dot-only names, and verify the
      // resolved destination stays inside UPLOADS (defense in depth)
      let name = path.basename(String(msg.name || 'file')).replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').replace(/[. ]+$/, '').slice(0, 120);
      if (!name || /^\.+$/.test(name) || /^(CON|PRN|AUX|NUL|COM\d|LPT\d)(\..*)?$/i.test(name)) name = 'file';
      if ((msg.size || 0) > MAX_UPLOAD) return reply(msg, { error: 'file too large (200 MB cap)' });
      fs.mkdirSync(UPLOADS, { recursive: true });
      const ext = path.extname(name);
      const base = path.basename(name, ext);
      let dest = path.join(UPLOADS, name);
      if (!path.resolve(dest).startsWith(path.resolve(UPLOADS) + path.sep)) return reply(msg, { error: 'bad name' });
      for (let n = 2; fs.existsSync(dest); n++) dest = path.join(UPLOADS, `${base}-${n}${ext}`);
      const uploadId = `u${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
      uploads.set(uploadId, { fd: fs.openSync(dest, 'w'), path: dest, received: 0, timer: null });
      touchUpload(uploadId);
      return reply(msg, { ok: true, uploadId, path: dest });
    }
    case 'upload.chunk': {
      const u = uploads.get(msg.uploadId);
      if (!u) return reply(msg, { error: 'unknown or expired upload' });
      const buf = Buffer.from(String(msg.data || ''), 'base64');
      if (u.received + buf.length > MAX_UPLOAD) {
        uploadCleanup(msg.uploadId, true);
        return reply(msg, { error: 'file too large (200 MB cap)' });
      }
      fs.writeSync(u.fd, buf);
      u.received += buf.length;
      touchUpload(msg.uploadId);
      return reply(msg, { ok: true, received: u.received });
    }
    case 'upload.end': {
      const u = uploads.get(msg.uploadId);
      if (!u) return reply(msg, { error: 'unknown or expired upload' });
      const done = { path: u.path, size: u.received };
      uploadCleanup(msg.uploadId, false);
      return reply(msg, { ok: true, ...done });
    }
    case 'upload.abort':
      uploadCleanup(msg.uploadId, true);
      return reply(msg, { ok: true });

    case 'exec': {
      const id = msg.id;
      return sys.execStream(id, String(msg.command || ''), msg.cwd,
        (data) => send({ type: 'exec.data', id, clientId: msg.clientId, data }),
        (code) => reply(msg, { exitCode: code }));
    }
    case 'exec.kill': return sys.execKill(msg.execId);

    default:
      if (msg.id) reply(msg, { error: `unknown type ${msg.type}` });
  }
}

/* ---------------- boot ---------------- */

console.log(`[bridge] Mothership bridge v${require('./package.json').version} on ${os.hostname()} (pty: ${term.ptyAvailable()})`);
connect();
