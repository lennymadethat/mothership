// System surface: stats, processes, power, file browsing, one-shot exec.
const os = require('os');
const fs = require('fs');
const path = require('path');
const { spawn, execFile } = require('child_process');

/* ---- CPU usage via os.cpus() sampling (no shell spawns) ---- */
let lastCpus = os.cpus();
function cpuPercent() {
  const cur = os.cpus();
  let idle = 0, total = 0;
  for (let i = 0; i < cur.length; i++) {
    const a = cur[i].times, b = lastCpus[i]?.times || a;
    const dIdle = a.idle - b.idle;
    const dTotal = Object.keys(a).reduce((s, k) => s + (a[k] - (b[k] || 0)), 0);
    idle += dIdle; total += dTotal;
  }
  lastCpus = cur;
  if (total <= 0) return 0;
  return Math.round((1 - idle / total) * 100);
}

/* ---- disk (cached, powershell) ---- */
let diskCache = { ts: 0, disks: [] };
function refreshDisk(cb) {
  if (Date.now() - diskCache.ts < 5 * 60_000) return cb(diskCache.disks);
  execFile('powershell.exe', ['-NoProfile', '-Command',
    'Get-PSDrive -PSProvider FileSystem | Where-Object {$_.Used -ne $null} | Select-Object Name,Used,Free | ConvertTo-Json -Compress'],
    { windowsHide: true }, (err, out) => {
      if (!err && out) {
        try {
          let rows = JSON.parse(out);
          if (!Array.isArray(rows)) rows = [rows];
          diskCache = { ts: Date.now(), disks: rows.map((r) => ({ name: r.Name, used: r.Used, free: r.Free })) };
        } catch { /* keep old cache */ }
      }
      cb(diskCache.disks);
    });
}

function stats(cb) {
  refreshDisk((disks) => {
    cb({
      cpu: cpuPercent(),
      memUsed: os.totalmem() - os.freemem(),
      memTotal: os.totalmem(),
      uptime: os.uptime(),
      hostname: os.hostname(),
      platform: `${os.platform()} ${os.release()}`,
      disks,
      ts: Date.now(),
    });
  });
}

function processes(cb) {
  execFile('powershell.exe', ['-NoProfile', '-Command',
    'Get-Process | Sort-Object -Descending WorkingSet64 | Select-Object -First 30 Id,ProcessName,CPU,WorkingSet64 | ConvertTo-Json -Compress'],
    { windowsHide: true }, (err, out) => {
      if (err) return cb({ error: err.message, processes: [] });
      try {
        let rows = JSON.parse(out);
        if (!Array.isArray(rows)) rows = [rows];
        cb({ processes: rows.map((r) => ({ pid: r.Id, name: r.ProcessName, cpu: Math.round((r.CPU || 0) * 10) / 10, mem: r.WorkingSet64 })) });
      } catch (e) { cb({ error: e.message, processes: [] }); }
    });
}

// Every Claude Code process on this machine — interactive terminals, headless
// Mothership runs, stray orphans — with enough context to triage and close.
function claudeProcs(cb) {
  execFile('powershell.exe', ['-NoProfile', '-Command',
    "Get-CimInstance Win32_Process -Filter \"Name='claude.exe'\" | Select-Object ProcessId,ParentProcessId,CommandLine,WorkingSetSize,@{N='Started';E={[System.Management.ManagementDateTimeConverter]::ToDateTime($_.CreationDate).ToUniversalTime().Subtract([datetime]'1970-01-01').TotalMilliseconds}} | ConvertTo-Json -Compress"],
    { windowsHide: true }, (err, out) => {
      if (err) return cb({ error: err.message, procs: [] });
      try {
        let rows = out.trim() ? JSON.parse(out) : [];
        if (!Array.isArray(rows)) rows = [rows];
        cb({
          procs: rows.map((r) => {
            const cl = r.CommandLine || '';
            return {
              pid: r.ProcessId,
              ppid: r.ParentProcessId,
              mem: r.WorkingSetSize,
              started: Math.round(r.Started || 0),
              headless: / -p | --print/.test(cl),
              cmd: cl.slice(0, 200),
            };
          }).sort((a, b) => a.started - b.started),
        });
      } catch (e) { cb({ error: e.message, procs: [] }); }
    });
}

function killPid(pid, cb) {
  if (!Number.isInteger(pid) || pid <= 4) return cb({ error: 'bad pid' });
  execFile('taskkill', ['/pid', String(pid), '/t', '/f'], { windowsHide: true }, (err, out, serr) =>
    cb(err ? { error: (serr || err.message).trim() } : { ok: true }));
}

const POWER = {
  shutdown: ['shutdown', ['/s', '/t', '10']],
  restart: ['shutdown', ['/r', '/t', '10']],
  cancel: ['shutdown', ['/a']],
  lock: ['rundll32.exe', ['user32.dll,LockWorkStation']],
};
function power(action, cb) {
  const p = POWER[action];
  if (!p) return cb({ error: 'unknown action' });
  execFile(p[0], p[1], { windowsHide: true }, (err) => cb(err ? { error: err.message } : { ok: true, action }));
}

function fsList(dirPath, cb) {
  try {
    const abs = path.resolve(dirPath || os.homedir());
    const items = fs.readdirSync(abs, { withFileTypes: true })
      .filter((d) => !d.name.startsWith('$'))
      .slice(0, 400)
      .map((d) => {
        let size = 0, mtime = 0;
        try { const st = fs.statSync(path.join(abs, d.name)); size = st.size; mtime = st.mtimeMs; } catch {}
        return { name: d.name, dir: d.isDirectory(), size, mtime };
      })
      .sort((a, b) => (b.dir - a.dir) || a.name.localeCompare(b.name));
    cb({ path: abs, parent: path.dirname(abs) !== abs ? path.dirname(abs) : null, items });
  } catch (e) { cb({ error: e.message, items: [] }); }
}

// One-shot PowerShell command, streamed. Arbitrary exec is the point of this
// product (authenticated owner controlling their own machine).
const execs = new Map();
function execStream(id, command, cwd, onData, onDone) {
  const child = spawn('powershell.exe', ['-NoProfile', '-Command', command],
    { cwd: cwd || os.homedir(), windowsHide: true });
  execs.set(id, child);
  child.stdout.on('data', (c) => onData(c.toString('utf8')));
  child.stderr.on('data', (c) => onData(c.toString('utf8')));
  child.on('close', (code) => { execs.delete(id); onDone(code); });
  child.on('error', (e) => { execs.delete(id); onData(`spawn error: ${e.message}\n`); onDone(-1); });
}
function execKill(id) {
  const c = execs.get(id);
  if (c) { try { execFile('taskkill', ['/pid', String(c.pid), '/t', '/f'], { windowsHide: true }, () => {}); } catch {} }
}

module.exports = { stats, processes, claudeProcs, killPid, power, fsList, execStream, execKill };
