// Fleet — machines (bridges) + Cloudflare workers overview.
import { S, api, esc, fmtAgo, toast } from '../app.js';

export function destroy() {}

export function render(el) {
  el.innerHTML = `
    <div class="section-title">Machines</div>
    <div id="fleetMachines"><div class="skeleton"></div></div>
    <div class="row"><div class="grow section-title">Cloudflare workers</div>
      <button class="btn ghost small" id="fleetRefresh">↻</button></div>
    <div id="fleetWorkers"><div class="skeleton"></div><div class="skeleton"></div></div>`;

  const drawMachines = async () => {
    try {
      const { machines } = await api('/api/machines');
      S.machines = machines;
      el.querySelector('#fleetMachines').innerHTML = machines.length ? machines.map((m) => `
        <div class="card"><div class="row">
          <span class="dot ${m.online ? 'on' : ''}"></span>
          <div class="grow"><h3>${esc(m.name)}</h3>
            <div class="sub">${esc(m.info?.hostname || '?')} · ${esc(m.info?.platform || '')} · claude ${esc(m.info?.claude || '?')}</div></div>
          <span class="chip ${m.online ? 'green' : ''}">${m.online ? 'online' : fmtAgo(m.lastSeen)}</span>
        </div></div>`).join('')
        : '<div class="empty">No bridges installed yet.</div>';
    } catch (e) { toast(e.message, 'err'); }
  };

  const fmtN = (n) => n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n);
  const fmtCost = (c) => c >= 0.995 ? `$${c.toFixed(2)}` : c >= 0.01 ? `${Math.round(c * 100)}¢` : '<1¢';

  const drawWorkers = async () => {
    const host = el.querySelector('#fleetWorkers');
    try {
      const [fleet, met] = await Promise.all([
        api('/api/fleet'),
        api('/api/fleet/metrics').catch(() => ({ metrics: {} })),
      ]);
      if (fleet.error) { host.innerHTML = `<div class="empty">${esc(fleet.error)}</div>`; return; }
      const metrics = met.metrics || {};
      host.innerHTML = `
        <div class="small muted" style="margin-bottom:8px">${fleet.workers.length} workers · cached ${fmtAgo(fleet.fetched)}${met.error ? ` · <span style="color:var(--amber)">metrics: ${esc(met.error)}</span>` : ' · cost/errors = last 7 days'}</div>
        ${fleet.workers.map((w) => {
          const m = metrics[w.name];
          return `
          <div class="card"><div class="row">
            <div class="grow"><h3 class="mono" style="font-size:13.5px">${esc(w.name)}</h3>
              <div class="sub">deployed ${w.modified ? fmtAgo(Date.parse(w.modified)) : '—'}${m ? ` · ${fmtN(m.requests)} req` : ''}</div></div>
            ${m && m.errors ? `<span class="chip red">✗ ${fmtN(m.errors)}</span>` : ''}
            ${m ? `<span class="chip ${m.costUsd >= 1 ? 'amber' : 'green'}">${fmtCost(m.costUsd)}</span>` : ''}
            ${w.crons.length ? `<span class="chip blue">⏱ ${w.crons.length} cron${w.crons.length > 1 ? 's' : ''}</span>` : ''}
          </div>
          ${w.crons.length ? `<div class="small muted mono" style="margin-top:4px">${w.crons.map(esc).join(' · ')}</div>` : ''}
          </div>`;
        }).join('')}`;
    } catch (e) { host.innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
  };

  el.querySelector('#fleetRefresh').onclick = drawWorkers;
  drawMachines();
  drawWorkers();
}
