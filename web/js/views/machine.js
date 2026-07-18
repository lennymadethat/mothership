// Machine — live stats, processes, power, file browser, one-shot exec.
import { S, req, on, nav, sheet, confirmSheet, toast, esc, fmtBytes, fmtAgo } from '../app.js';

let unsubs = [];
export function destroy() { unsubs.forEach((u) => u()); unsubs = []; }

const pct = (v) => `${Math.round(v)}%`;
const barClass = (v) => (v > 88 ? 'hot' : v > 70 ? 'warn' : '');

export function render(el) {
  el.innerHTML = `
    <div class="section-title">${esc(S.machine || '—')}</div>
    <div class="gauges" id="gauges"></div>
    <div class="section-title">Claude Code processes</div>
    <div class="card" id="claudeProcs"><div class="sub">loading…</div></div>
    <div class="section-title">Info</div>
    <div class="card" id="infoCard"><div class="sub">waiting for bridge…</div></div>
    <div class="section-title">Actions</div>
    <div class="card">
      <div class="row" style="flex-wrap:wrap; gap:8px">
        <button class="btn ghost small" id="actProcs">Processes</button>
        <button class="btn ghost small" id="actFiles">Files</button>
        <button class="btn ghost small" id="actLightsOn">💡 Lights</button>
        <button class="btn ghost small" id="actLightsOff">🌙 Dark</button>
        <button class="btn ghost small" id="actLock">Lock</button>
        <button class="btn danger small" id="actRestart">Restart</button>
        <button class="btn danger small" id="actShutdown">Shut down</button>
      </div>
    </div>
    <div class="section-title">Run command (PowerShell)</div>
    <div class="card">
      <div class="row"><input id="execCmd" class="mono" placeholder="Get-Process node | Select Id,CPU"><button class="btn small" id="execGo">Run</button></div>
      <pre id="execOut" class="mono small" style="white-space:pre-wrap; max-height:280px; overflow:auto; margin:10px 0 0; display:none"></pre>
    </div>`;

  const drawStats = () => {
    const s = S.stats;
    const g = el.querySelector('#gauges');
    if (!g) return;
    if (!s) { g.innerHTML = '<div class="skeleton"></div>'; return; }
    const memPct = (s.memUsed / s.memTotal) * 100;
    const diskC = (s.disks || []).find((d) => d.name === 'C');
    const diskPct = diskC ? (diskC.used / (diskC.used + diskC.free)) * 100 : 0;
    const up = s.uptime ? `${Math.floor(s.uptime / 86400)}d ${Math.floor((s.uptime % 86400) / 3600)}h` : '—';
    g.innerHTML = `
      <div class="gauge"><div class="label">CPU</div><div class="val">${pct(s.cpu)}</div><div class="bar"><i class="${barClass(s.cpu)}" style="width:${s.cpu}%"></i></div></div>
      <div class="gauge"><div class="label">Memory</div><div class="val">${fmtBytes(s.memUsed)}</div><div class="bar"><i class="${barClass(memPct)}" style="width:${memPct}%"></i></div><div class="small muted">of ${fmtBytes(s.memTotal)}</div></div>
      <div class="gauge"><div class="label">Disk C:</div><div class="val">${diskC ? fmtBytes(diskC.free) : '—'}<span class="small muted"> free</span></div><div class="bar"><i class="${barClass(diskPct)}" style="width:${diskPct}%"></i></div></div>
      <div class="gauge"><div class="label">Uptime</div><div class="val">${up}</div><div class="small muted">${esc(s.hostname || '')}</div></div>`;
  };
  const drawInfo = () => {
    const i = S.info;
    const c = el.querySelector('#infoCard');
    if (!c) return;
    if (!i) return;
    c.innerHTML = `
      <table class="data">
        <tr><td class="muted">Host</td><td>${esc(i.hostname)} (${esc(i.user || '')})</td></tr>
        <tr><td class="muted">OS</td><td>${esc(i.platform)} ${esc(i.arch || '')}</td></tr>
        <tr><td class="muted">Node</td><td>${esc(i.node)}</td></tr>
        <tr><td class="muted">Claude Code</td><td>${esc(i.claude || 'not found')}</td></tr>
        <tr><td class="muted">Terminal</td><td>${i.pty ? 'full PTY' : 'pipe fallback'}</td></tr>
        <tr><td class="muted">Bridge</td><td>v${esc(i.bridgeVersion || '?')}</td></tr>
      </table>`;
  };
  drawStats(); drawInfo();
  unsubs.push(on('stats', drawStats), on('snapshot', () => { drawStats(); drawInfo(); }));
  if (S.online) req('sys.stats').then((r) => { S.stats = r.stats; drawStats(); }).catch(() => {});

  /* claude code process manager — every open session on this machine */
  const cpCard = el.querySelector('#claudeProcs');
  const loadClaudeProcs = async () => {
    if (!S.online) { cpCard.innerHTML = '<div class="sub">machine offline</div>'; return; }
    try {
      const r = await req('claude.procs');
      const procs = r.procs || [];
      if (!procs.length) { cpCard.innerHTML = '<div class="sub">No Claude Code processes running. 🎉</div>'; return; }
      const totalMem = procs.reduce((s, p) => s + (p.mem || 0), 0);
      cpCard.innerHTML = `
        <div class="row" style="margin-bottom:8px">
          <div class="grow"><strong>${procs.length}</strong> running · ${fmtBytes(totalMem)} RAM</div>
          <button class="btn ghost small" id="cpReload">↻</button>
          <button class="btn danger small" id="cpKillSel" disabled>Close selected</button>
        </div>
        <table class="data"><tr><th><input type="checkbox" id="cpAll"></th><th>PID</th><th>Type</th><th>Started</th><th>Mem</th></tr>
        ${procs.map((p) => `
          <tr>
            <td><input type="checkbox" class="cpSel" value="${p.pid}"></td>
            <td class="mono">${p.pid}</td>
            <td>${p.headless ? '<span class="chip mini blue">headless (app/bridge)</span>' : '<span class="chip mini green">interactive</span>'}</td>
            <td class="muted small">${fmtAgo(p.started)}</td>
            <td>${fmtBytes(p.mem)}</td>
          </tr>`).join('')}</table>
        <div class="small muted" style="margin-top:6px">headless = spawned by Mothership or scripts; interactive = a terminal session. Closing an interactive one closes that terminal's Claude (history stays in ~/.claude, resumable).</div>`;
      const syncBtn = () => {
        const n = cpCard.querySelectorAll('.cpSel:checked').length;
        const b = cpCard.querySelector('#cpKillSel');
        b.disabled = !n; b.textContent = n ? `Close ${n} selected` : 'Close selected';
      };
      cpCard.querySelectorAll('.cpSel').forEach((c) => c.onchange = syncBtn);
      cpCard.querySelector('#cpAll').onchange = (e) => { cpCard.querySelectorAll('.cpSel').forEach((c) => { c.checked = e.target.checked; }); syncBtn(); };
      cpCard.querySelector('#cpReload').onclick = loadClaudeProcs;
      cpCard.querySelector('#cpKillSel').onclick = async () => {
        const pids = [...cpCard.querySelectorAll('.cpSel:checked')].map((c) => +c.value);
        if (!pids.length) return;
        if (!(await confirmSheet({ title: `Close ${pids.length} Claude process${pids.length > 1 ? 'es' : ''}?`, body: 'Each process tree is force-terminated. Conversation history stays on disk and is resumable.' }))) return;
        try {
          const r = await req('claude.procs.kill', { pids }, 60000);
          const killed = Object.values(r.results || {}).filter((v) => v === 'killed').length;
          toast(`Closed ${killed}/${pids.length}`, killed ? 'ok' : 'err');
        } catch (e) { toast(e.message, 'err'); }
        loadClaudeProcs();
      };
    } catch (e) { cpCard.innerHTML = `<div class="sub">${esc(e.message)}</div>`; }
  };
  loadClaudeProcs();
  unsubs.push(on('snapshot', loadClaudeProcs));

  /* processes */
  el.querySelector('#actProcs').onclick = async () => {
    const s = sheet(`<h2>Processes</h2><div id="procList"><div class="skeleton"></div></div>`);
    const load = async () => {
      try {
        const r = await req('sys.processes');
        s.el.querySelector('#procList').innerHTML = `
          <table class="data"><tr><th>Name</th><th>PID</th><th>Mem</th><th></th></tr>
          ${r.processes.map((p) => `<tr><td>${esc(p.name)}</td><td class="muted">${p.pid}</td><td>${fmtBytes(p.mem)}</td>
            <td><button class="btn danger small" data-pid="${p.pid}">kill</button></td></tr>`).join('')}</table>`;
        s.el.querySelectorAll('[data-pid]').forEach((b) => b.onclick = async () => {
          if (!(await confirmSheet({ title: `Kill PID ${b.dataset.pid}?`, body: 'The process tree will be force-terminated.' }))) return;
          try { await req('sys.kill', { pid: +b.dataset.pid }); toast('Killed', 'ok'); load(); } catch (e) { toast(e.message, 'err'); }
        });
      } catch (e) { s.el.querySelector('#procList').innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
    };
    load();
  };

  /* files — the real browser lives in its own tab now */
  el.querySelector('#actFiles').onclick = () => nav('files');

  /* RGB lights (SignalRGB on the machine; scheduled 8am–8pm, these override) */
  const rgb = async (uri, label) => {
    try { await req('exec', { command: `Start-Process "signalrgb://${uri}"` }, 30000); toast(label, 'ok'); }
    catch (e) { toast(e.message, 'err'); }
  };
  el.querySelector('#actLightsOn').onclick = () => rgb('effect/apply/Neon%20Shift?-silentlaunch-', '💡 Lights on');
  el.querySelector('#actLightsOff').onclick = () => rgb('effect/apply/Solid%20Color?color=%23000000&breathe=0&-silentlaunch-', '🌙 Lights off');

  /* power */
  const powerAction = (action, label) => async () => {
    if (!(await confirmSheet({ title: `${label} ${S.machine}?`, body: `This really will ${label.toLowerCase()} the machine. 10-second grace (Run "shutdown /a" to abort).` }))) return;
    if (action !== 'lock' && !(await confirmSheet({ title: 'Absolutely sure?', body: `${S.machine} will ${label.toLowerCase()} now.`, confirmText: `Yes, ${label.toLowerCase()}` }))) return;
    try { await req('sys.power', { action, confirm: true }); toast(`${label} sent`, 'ok'); } catch (e) { toast(e.message, 'err'); }
  };
  el.querySelector('#actLock').onclick = powerAction('lock', 'Lock');
  el.querySelector('#actRestart').onclick = powerAction('restart', 'Restart');
  el.querySelector('#actShutdown').onclick = powerAction('shutdown', 'Shut down');

  /* exec */
  const out = el.querySelector('#execOut');
  unsubs.push(on('exec.data', (m) => {
    out.style.display = 'block';
    out.textContent += m.data;
    out.scrollTop = out.scrollHeight;
  }));
  const runCmd = async () => {
    const cmd = el.querySelector('#execCmd').value.trim();
    if (!cmd) return;
    out.style.display = 'block'; out.textContent = `> ${cmd}\n`;
    try { const r = await req('exec', { command: cmd }, 120000); out.textContent += `\n[exit ${r.exitCode}]`; }
    catch (e) { out.textContent += `\n[${e.message}]`; }
  };
  el.querySelector('#execGo').onclick = runCmd;
  el.querySelector('#execCmd').onkeydown = (e) => { if (e.key === 'Enter') runCmd(); };
}
