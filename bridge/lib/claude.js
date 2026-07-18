// Claude Code headless runner — spawns `claude -p` with stream-json output,
// maps raw events to simple UI events, accumulates transcripts.
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

let claudeCmd = null;
function resolveClaude() {
  if (claudeCmd) return claudeCmd;
  try {
    const out = execSync('where claude', { encoding: 'utf8' }).trim().split(/\r?\n/)[0];
    claudeCmd = out;
  } catch {
    claudeCmd = 'claude';
  }
  return claudeCmd;
}

const runs = new Map(); // key -> { child, runId }

function isBusy(key) { return runs.has(key); }

function stop(key) {
  const r = runs.get(key);
  if (!r) return false;
  try { r.child.kill('SIGTERM'); } catch {}
  try { execSync(`taskkill /pid ${r.child.pid} /t /f`, { stdio: 'ignore' }); } catch {}
  runs.delete(key);
  return true;
}

/**
 * Run one prompt against a session.
 * onEvent(ev) receives: {kind:'init'|'delta'|'tool'|'done'|'error', ...}
 * Returns runId immediately.
 */
function run({ key, prompt, cwd, model, resumeSessionId, onEvent }) {
  if (runs.has(key)) throw new Error('session busy');
  const runId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

  // Values arriving over the relay are validated against strict shapes before
  // touching the command line — quoting alone is not trustworthy on cmd.exe.
  if (model && !/^[a-zA-Z0-9._[\]-]{1,64}$/.test(model)) throw new Error('invalid model'); // allow the [1m] 1M-context suffix
  if (resumeSessionId && !/^[a-zA-Z0-9-]{8,64}$/.test(resumeSessionId)) throw new Error('invalid session id');

  const cmd = resolveClaude();
  let cmdline = `"${cmd}" -p --output-format stream-json --verbose --include-partial-messages --dangerously-skip-permissions`;
  // Browser power for headless sessions: Playwright + Chrome DevTools MCP servers
  // (the Claude-in-Chrome extension can't pair with -p sessions; this closes the gap).
  const mcpConfig = path.join(__dirname, '..', 'claude-mcp.json');
  if (fs.existsSync(mcpConfig)) cmdline += ` --mcp-config "${mcpConfig}"`;
  if (model) cmdline += ` --model ${model}`;
  if (resumeSessionId) cmdline += ` --resume ${resumeSessionId}`;

  const child = spawn(cmdline, { shell: true, cwd: cwd || process.env.USERPROFILE, windowsHide: true });
  runs.set(key, { child, runId });

  child.stdin.write(prompt);
  child.stdin.end();

  // delta throttling — flush text every 150ms instead of per-token
  let deltaBuf = '';
  let flushTimer = null;
  const flushDeltas = () => {
    if (deltaBuf) { onEvent({ kind: 'delta', text: deltaBuf }); deltaBuf = ''; }
    flushTimer = null;
  };
  const pushDelta = (t) => {
    deltaBuf += t;
    if (!flushTimer) flushTimer = setTimeout(flushDeltas, 150);
  };

  const state = { sessionId: null, text: '', tools: [], cost: null, durationMs: null, done: false };
  let lineBuf = '';
  let stderrTail = '';

  child.stdout.on('data', (chunk) => {
    lineBuf += chunk.toString('utf8');
    let idx;
    while ((idx = lineBuf.indexOf('\n')) >= 0) {
      const line = lineBuf.slice(0, idx).trim();
      lineBuf = lineBuf.slice(idx + 1);
      if (!line) continue;
      let ev;
      try { ev = JSON.parse(line); } catch { continue; }
      handleEvent(ev);
    }
  });
  child.stderr.on('data', (c) => { stderrTail = (stderrTail + c.toString('utf8')).slice(-2000); });

  function handleEvent(ev) {
    if (ev.type === 'system' && ev.subtype === 'init') {
      state.sessionId = ev.session_id;
      onEvent({ kind: 'init', sessionId: ev.session_id, model: ev.model, cwd: ev.cwd, apiKeySource: ev.apiKeySource });
    } else if (ev.type === 'stream_event') {
      const e = ev.event || {};
      if (e.type === 'content_block_delta' && e.delta?.type === 'text_delta') {
        state.text += e.delta.text;
        pushDelta(e.delta.text);
      } else if (e.type === 'content_block_start' && e.content_block?.type === 'tool_use') {
        const tool = { name: e.content_block.name };
        state.tools.push(tool);
        if (flushTimer) { clearTimeout(flushTimer); flushDeltas(); }
        onEvent({ kind: 'tool', name: tool.name });
      }
    } else if (ev.type === 'assistant' && ev.message?.content) {
      for (const block of ev.message.content) {
        if (block.type === 'tool_use' && block.input) {
          const last = state.tools.findLast?.((t) => t.name === block.name && !t.input) ||
            state.tools.slice().reverse().find((t) => t.name === block.name && !t.input);
          const preview = JSON.stringify(block.input).slice(0, 160);
          if (last) last.input = preview;
          onEvent({ kind: 'tool_input', name: block.name, input: preview });
        }
      }
    } else if (ev.type === 'result') {
      if (flushTimer) { clearTimeout(flushTimer); flushDeltas(); }
      state.done = true;
      state.cost = ev.total_cost_usd ?? null;
      state.durationMs = ev.duration_ms ?? null;
      if (ev.session_id) state.sessionId = ev.session_id;
      const ok = ev.subtype === 'success' && !ev.is_error;
      // result text is authoritative (includes text we may have missed)
      if (typeof ev.result === 'string' && ev.result.length > state.text.length) state.text = ev.result;
      onEvent({
        kind: 'done', ok, sessionId: state.sessionId, cost: state.cost,
        durationMs: state.durationMs, text: state.text, tools: state.tools,
        usage: ev.usage || null, modelUsage: ev.modelUsage || null,
        error: ok ? null : (ev.result || ev.subtype || 'unknown error'),
      });
    }
  }

  child.on('close', (code) => {
    runs.delete(key);
    if (!state.done) {
      if (flushTimer) { clearTimeout(flushTimer); flushDeltas(); }
      onEvent({
        kind: 'done', ok: false, sessionId: state.sessionId, cost: state.cost, durationMs: null,
        text: state.text, tools: state.tools,
        error: `claude exited (${code}) without result. ${stderrTail.slice(-400)}`,
      });
    }
  });
  child.on('error', (err) => {
    runs.delete(key);
    onEvent({ kind: 'done', ok: false, text: state.text, tools: state.tools, error: `spawn failed: ${err.message}` });
  });

  return runId;
}

function claudeVersion() {
  try { return execSync(`"${resolveClaude()}" --version`, { encoding: 'utf8' }).trim(); } catch { return null; }
}

/**
 * Boil a finished reply down to a 1-2 sentence spoken recap via a cheap
 * haiku run. Fire-and-forget: cb(text|null), never throws.
 */
function recap(text, cb) {
  try {
    const child = spawn(`"${resolveClaude()}" -p --model haiku`, {
      shell: true, cwd: process.env.USERPROFILE, windowsHide: true,
    });
    let out = '';
    const timer = setTimeout(() => {
      try { execSync(`taskkill /pid ${child.pid} /t /f`, { stdio: 'ignore' }); } catch {}
    }, 60_000);
    child.stdout.on('data', (c) => { out += c.toString('utf8'); });
    child.on('close', () => {
      clearTimeout(timer);
      const r = out.trim().replace(/^["'\s]+|["'\s]+$/g, '');
      cb(r && r.length >= 15 && r.length <= 600 ? r : null);
    });
    child.on('error', () => { clearTimeout(timer); cb(null); });
    child.stdin.write(
      'Turn this assistant reply into a spoken recap: 1-2 plain sentences, max 40 words total, ' +
      'no markdown, no lists, no code, no file paths. Lead with the outcome; end with any action ' +
      'needed from the user, if there is one. Output ONLY the recap sentences.\n\n---\n' +
      String(text).slice(0, 12000),
    );
    child.stdin.end();
  } catch { cb(null); }
}

module.exports = { run, stop, isBusy, claudeVersion, recap };
