// Settings — token, model default, snippets, scheduler, install kit, sign out.
import { S, esc, toast, confirmSheet, install, req } from '../app.js';

export function destroy() {}

export function render(el) {
  const model = localStorage.getItem('ms_model') || '';
  const installCmd = [
    `cd $env:USERPROFILE; iwr ${location.origin}/bridge.zip -OutFile ms-bridge.zip;`,
    `Expand-Archive ms-bridge.zip -DestinationPath mothership-bridge -Force;`,
    `cd mothership-bridge; .\\install.ps1 -HubUrl ${location.origin} -Machine <name>`,
  ].join(' ');

  const installState = install.isStandalone ? 'installed'
    : install.available() ? 'ready' : 'menu';

  el.innerHTML = `
    <div class="section-title">App</div>
    <div class="card">
      <div class="row">
        <div class="grow"><h3>Install Mothership</h3>
          <div class="sub">${installState === 'installed' ? 'Running as an installed app ✓'
            : installState === 'ready' ? 'Add to your home screen for full-screen + notifications'
            : 'Use your browser menu → Install app / Add to Home Screen'}</div></div>
        ${installState === 'installed' ? '<span class="chip green">installed</span>'
          : `<button class="btn small" id="installBtn">⬇ Install</button>`}
      </div>
    </div>

    <div class="card">
      <div class="row">
        <div class="grow"><h3>How Mothership works</h3>
          <div class="sub">The white paper — relay architecture, sessions, fleet, infographics</div></div>
        <a class="btn ghost small" href="/how-it-works" target="_blank">Read 🛸</a>
      </div>
    </div>

    <div class="section-title">Settings</div>

    <div class="card">
      <div class="field"><label>Default model for new prompts</label>
        <select id="setModel">
          <option value="">Account default</option>
          <option value="claude-fable-5">Fable 5</option>
          <option value="opus">Opus</option>
          <option value="sonnet">Sonnet</option>
          <option value="haiku">Haiku</option>
        </select></div>
      <div class="field"><label>Hub token (pre-load now; enforced when the hub secret is armed)</label>
        <input id="setToken" type="password" placeholder="not set" autocomplete="off"></div>
    </div>

    <div class="section-title">Install bridge on another machine</div>
    <div class="card">
      <p class="sub" style="white-space:normal">Run this in PowerShell on the target machine (e.g. my-desktop, work-laptop…). Just set the machine name.</p>
      <pre class="mono small" style="white-space:pre-wrap; background:#0b1018; padding:10px; border-radius:10px" id="installCmd">${esc(installCmd)}</pre>
      <button class="btn ghost small" id="copyInstall">Copy command</button>
    </div>

    <div class="section-title">⏰ Standing orders — scheduled Claude runs</div>
    <div class="card">
      <p class="sub" style="white-space:normal">Runs fire on ${esc(S.machine || 'the machine')} even while the app is closed — you get the push + spoken recap when they finish.</p>
      <div id="schedList"><div class="skeleton"></div></div>
      <div class="field" style="margin-top:10px"><label>Name</label><input id="scName" placeholder="Morning fleet check"></div>
      <div class="row" style="gap:8px">
        <div class="field grow"><label>Time</label><input id="scTime" type="time" value="07:30"></div>
        <div class="field grow"><label>Days</label>
          <select id="scDays">
            <option value="">Every day</option>
            <option value="12345" selected>Weekdays</option>
            <option value="06">Weekends</option>
          </select></div>
      </div>
      <div class="field"><label>Working folder (blank = home, full memory)</label><input id="scRepo" placeholder=""></div>
      <div class="field"><label>Prompt</label><textarea id="scPrompt" rows="3" placeholder="Run the morning fleet check: Sentinel status, overnight cron failures, summarize in 10 lines."></textarea></div>
      <button class="btn small" id="scAdd">＋ Add standing order</button>
    </div>

    <div class="section-title">Custom snippets</div>
    <div class="card">
      <p class="sub" style="white-space:normal">Shown in the / palette. One per line: <span class="mono">label :: prompt text</span></p>
      <textarea id="setSnips" rows="5" class="mono small"></textarea>
      <button class="btn ghost small" style="margin-top:8px" id="saveSnips">Save snippets</button>
    </div>

    <div class="small muted" style="text-align:center; padding:12px">Mothership Access Hub · ${esc(location.host)}</div>`;

  const installBtn = el.querySelector('#installBtn');
  if (installBtn) installBtn.onclick = () => install.prompt();

  const sel = el.querySelector('#setModel');
  sel.value = model;
  sel.onchange = () => { localStorage.setItem('ms_model', sel.value); toast('Model saved', 'ok'); };

  const tok = el.querySelector('#setToken');
  tok.value = S.token || '';
  tok.onchange = () => {
    S.token = tok.value.trim();
    if (S.token) localStorage.setItem('ms_token', S.token); else localStorage.removeItem('ms_token');
    toast('Token saved — reload to reconnect with it', 'ok');
  };

  el.querySelector('#copyInstall').onclick = async () => {
    try { await navigator.clipboard.writeText(installCmd); toast('Copied', 'ok'); } catch { toast('Copy blocked', 'err'); }
  };

  /* standing orders */
  const schedList = el.querySelector('#schedList');
  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const drawScheds = (schedules) => {
    schedList.innerHTML = (schedules || []).length ? schedules.map((sc) => `
      <div class="row" style="padding:6px 0;border-top:1px solid rgba(255,255,255,.06)">
        <div class="grow"><strong>${esc(sc.name || sc.id)}</strong>
          <div class="sub small">${esc(sc.time)} · ${(sc.days || []).length ? sc.days.map((d) => dayNames[d]).join(' ') : 'daily'} · ${esc(String(sc.prompt || '').slice(0, 60))}</div></div>
        <button class="btn small ghost" data-del="${esc(sc.id)}">🗑</button>
      </div>`).join('') : '<div class="sub">No standing orders yet.</div>';
    schedList.querySelectorAll('[data-del]').forEach((b) => b.onclick = async () => {
      try { const r = await req('sched.delete', { id: b.dataset.del }); drawScheds(r.schedules); toast('Deleted', 'ok'); }
      catch (e) { toast(e.message, 'err'); }
    });
  };
  if (S.online) req('sched.list').then((r) => drawScheds(r.schedules)).catch(() => { schedList.innerHTML = '<div class="sub">Machine offline</div>'; });
  else schedList.innerHTML = '<div class="sub">Machine offline</div>';
  el.querySelector('#scAdd').onclick = async () => {
    const days = (el.querySelector('#scDays').value || '').split('').map(Number);
    try {
      const r = await req('sched.save', { schedule: {
        name: el.querySelector('#scName').value.trim() || 'standing order',
        time: el.querySelector('#scTime').value,
        days,
        repo: el.querySelector('#scRepo').value.trim() || null,
        prompt: el.querySelector('#scPrompt').value.trim(),
      } });
      drawScheds(r.schedules);
      el.querySelector('#scPrompt').value = '';
      toast('Standing order saved ⏰', 'ok');
    } catch (e) { toast(e.message, 'err'); }
  };

  const snipEl = el.querySelector('#setSnips');
  try {
    snipEl.value = (JSON.parse(localStorage.getItem('ms_snippets') || '[]')).map((s) => `${s.label} :: ${s.text}`).join('\n');
  } catch {}
  el.querySelector('#saveSnips').onclick = () => {
    const arr = snipEl.value.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
      const i = l.indexOf('::');
      return i > 0 ? { label: l.slice(0, i).trim(), text: l.slice(i + 2).trim() } : { label: l.slice(0, 30), text: l };
    });
    localStorage.setItem('ms_snippets', JSON.stringify(arr));
    toast(`${arr.length} snippets saved`, 'ok');
  };

}
