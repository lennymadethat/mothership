// /beam — hand the CURRENT terminal Claude Code session to the Mothership hub.
// Run from inside the session's working directory:
//   node <repo>\bridge\beam.js --name "Deadly Build" [--cwd C:\path] [--session <uuid>]
// Finds the session's jsonl in ~/.claude/projects/<cwd-slug>/ (newest = the live
// one), then registers it with the bridge via the hub (session.adopt).
const fs = require('fs');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');

const args = {};
for (let i = 2; i < process.argv.length; i += 2) args[process.argv[i].replace(/^--/, '')] = process.argv[i + 1];

const cwd = path.resolve(args.cwd || process.cwd());
const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));

let sessionId = args.session || null;
if (!sessionId) {
  const slug = cwd.replace(/[:\\/.]/g, '-');
  const projDir = path.join(os.homedir(), '.claude', 'projects', slug);
  if (!fs.existsSync(projDir)) { console.error(`No Claude project dir for ${cwd} (${projDir})`); process.exit(1); }
  const newest = fs.readdirSync(projDir)
    .filter((f) => /^[0-9a-f-]{36}\.jsonl$/.test(f))
    .map((f) => ({ f, m: fs.statSync(path.join(projDir, f)).mtimeMs }))
    .sort((a, b) => b.m - a.m)[0];
  if (!newest) { console.error('No sessions found in', projDir); process.exit(1); }
  sessionId = newest.f.replace('.jsonl', '');
  console.log(`current session: ${sessionId} (modified ${Math.round((Date.now() - newest.m) / 1000)}s ago)`);
}

const name = args.name || `${path.basename(cwd) || 'session'} (beamed)`;
const key = (name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'beam').slice(0, 40) + '-' + Date.now().toString(36).slice(-4);

const wsUrl = `${cfg.hubUrl.replace(/^http/, 'ws').replace(/\/$/, '')}/api/machine/${cfg.machine}/ws${cfg.token ? `?token=${encodeURIComponent(cfg.token)}` : ''}`;
const ws = new WebSocket(wsUrl);
const die = (m) => { console.error(m); process.exit(1); };
setTimeout(() => die('timeout talking to the hub'), 20000);

ws.on('error', (e) => die(`hub connection failed: ${e.message}`));
ws.on('open', () => ws.send(JSON.stringify({ type: 'client.hello' })));
ws.on('message', (raw) => {
  const m = JSON.parse(raw.toString());
  if (m.type === 'snapshot') {
    ws.send(JSON.stringify({ type: 'session.adopt', id: 'beam1', key, name, repo: cwd, claudeSessionId: sessionId }));
  }
  if (m.type === 'res' && m.id === 'beam1') {
    if (m.error) die(`adopt failed: ${m.error}`);
    console.log(`🛸 beamed aboard as "${name}"`);
    console.log(`   open ${cfg.hubUrl} → Sessions → ${name}`);
    console.log('   (finish or stop the terminal turn before prompting from the phone — one surface at a time)');
    process.exit(0);
  }
});
