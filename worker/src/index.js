// Mothership Hub — Cloudflare Worker
// Serves the PWA + relays WebSockets between browser clients and machine bridges
// via one MachineRelay Durable Object per machine. Everything under /api/* is
// gated by HUB_TOKEN (Authorization: Bearer or ?token=).

const enc = new TextEncoder();

/* ---------------- auth ---------------- */

async function sha256hex(s) {
  const d = await crypto.subtle.digest('SHA-256', enc.encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function extractToken(request, url) {
  const h = request.headers.get('Authorization') || '';
  if (h.startsWith('Bearer ')) return h.slice(7).trim();
  return url.searchParams.get('token') || '';
}

async function authed(request, url, env) {
  if (!env.HUB_TOKEN) return true; // open mode — no token configured; the unguessable URL is the only gate
  const t = extractToken(request, url);
  if (!t) return false;
  return (await sha256hex(t)) === (await sha256hex(env.HUB_TOKEN));
}

/* ---------------- helpers ---------------- */

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });

const MACHINE_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

function b64url(buf) {
  return btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/* ---------------- web push (VAPID, payload-free) ---------------- */

async function vapidJwt(env, audience) {
  const jwk = JSON.parse(env.VAPID_PRIVATE_JWK);
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const header = b64url(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const payload = b64url(enc.encode(JSON.stringify({
    aud: audience,
    exp: Math.floor(Date.now() / 1000) + 12 * 3600,
    sub: env.VAPID_SUBJECT || 'mailto:you@example.com',
  })));
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(`${header}.${payload}`));
  return `${header}.${payload}.${b64url(sig)}`;
}

export async function sendPushToAll(env) {
  const list = await env.HUB_KV.list({ prefix: 'push:sub:' });
  await Promise.all(list.keys.map(async ({ name }) => {
    try {
      const sub = JSON.parse(await env.HUB_KV.get(name));
      const aud = new URL(sub.endpoint).origin;
      const jwt = await vapidJwt(env, aud);
      const res = await fetch(sub.endpoint, {
        method: 'POST',
        headers: {
          Authorization: `vapid t=${jwt}, k=${env.VAPID_PUBLIC_KEY}`,
          TTL: '300',
          Urgency: 'high',
        },
      });
      if (res.status === 404 || res.status === 410) await env.HUB_KV.delete(name);
    } catch { /* one bad subscription must not block the rest */ }
  }));
}

export async function recordNotification(env, notif) {
  const key = 'notifications';
  const cur = JSON.parse((await env.HUB_KV.get(key)) || '[]');
  cur.unshift({ ...notif, ts: Date.now() });
  await env.HUB_KV.put(key, JSON.stringify(cur.slice(0, 100)));
}

/* ---------------- fleet (Cloudflare API) ---------------- */

async function getFleet(env) {
  const cached = await env.HUB_KV.get('fleet:cache');
  if (cached) return JSON.parse(cached);
  if (!env.CF_API_TOKEN) return { error: 'CF_API_TOKEN not configured', workers: [] };
  const api = `https://api.cloudflare.com/client/v4/accounts/${env.ACCOUNT_ID}/workers`;
  const hdrs = { Authorization: `Bearer ${env.CF_API_TOKEN}` };
  const res = await fetch(`${api}/scripts`, { headers: hdrs });
  const body = await res.json();
  if (!body.success) return { error: 'CF API error', detail: body.errors, workers: [] };
  const scripts = body.result || [];
  const workers = [];
  // schedules in batches of 10 to stay polite on subrequests
  for (let i = 0; i < scripts.length; i += 10) {
    const batch = scripts.slice(i, i + 10);
    const rows = await Promise.all(batch.map(async (s) => {
      let crons = [];
      try {
        const r = await fetch(`${api}/scripts/${s.id}/schedules`, { headers: hdrs });
        const j = await r.json();
        crons = (j.result?.schedules || []).map((c) => c.cron);
      } catch { /* schedules are optional decoration */ }
      return { name: s.id, modified: s.modified_on, created: s.created_on, crons };
    }));
    workers.push(...rows);
  }
  workers.sort((a, b) => (b.modified || '').localeCompare(a.modified || ''));
  const fleet = { fetched: Date.now(), workers };
  await env.HUB_KV.put('fleet:cache', JSON.stringify(fleet), { expirationTtl: 600 });
  return fleet;
}

/* ---------------- fleet metrics (CF GraphQL analytics, 7 days) ---------------- */

async function getFleetMetrics(env) {
  const cached = await env.HUB_KV.get('fleet:metrics');
  if (cached) return JSON.parse(cached);
  const token = env.CF_ANALYTICS_TOKEN || env.CF_API_TOKEN;
  if (!token) return { error: 'analytics token not configured', metrics: {} };
  const day = 86_400_000;
  const d = (ts) => new Date(ts).toISOString().slice(0, 10);
  const query = `query { viewer { accounts(filter: {accountTag: "${env.ACCOUNT_ID}"}) {
    workersInvocationsAdaptive(limit: 1000, filter: {date_geq: "${d(Date.now() - 7 * day)}", date_leq: "${d(Date.now())}"}) {
      sum { requests errors subrequests }
      quantiles { cpuTimeP50 }
      dimensions { scriptName }
    } } } }`;
  const res = await fetch('https://api.cloudflare.com/client/v4/graphql', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  const body = await res.json();
  const rows = body?.data?.viewer?.accounts?.[0]?.workersInvocationsAdaptive;
  if (!rows) return { error: 'CF GraphQL error', detail: body?.errors || null, metrics: {} };
  const metrics = {};
  for (const r of rows) {
    const name = r.dimensions?.scriptName;
    if (!name || name === '__unknown__') continue;
    const m = metrics[name] || (metrics[name] = { requests: 0, errors: 0, subrequests: 0, cpuMs: 0 });
    m.requests += r.sum?.requests || 0;
    m.errors += r.sum?.errors || 0;
    m.subrequests += r.sum?.subrequests || 0;
    m.cpuMs += ((r.sum?.requests || 0) * (r.quantiles?.cpuTimeP50 || 0)) / 1000; // p50 µs × requests ≈ total ms
  }
  // Workers Standard marginal pricing: $0.30/M requests + $0.02/M CPU-ms (ignores plan-included allowances)
  for (const m of Object.values(metrics)) {
    m.cpuMs = Math.round(m.cpuMs);
    m.costUsd = (m.requests * 0.30 + m.cpuMs * 0.02) / 1e6;
  }
  const out = { fetched: Date.now(), days: 7, metrics };
  await env.HUB_KV.put('fleet:metrics', JSON.stringify(out), { expirationTtl: 600 });
  return out;
}

/* ---------------- Durable Object: one per machine ---------------- */

export class MachineRelay {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.lastKvWrite = 0;
  }

  machineName() {
    return this.ctx.storage.get('machine'); // promise
  }

  async fetch(request) {
    const url = new URL(request.url);
    const role = request.headers.get('X-MS-Role');
    const machine = request.headers.get('X-MS-Machine');
    if (role === 'file') return this.fileFetch(url);
    if (request.headers.get('Upgrade') !== 'websocket') return json({ error: 'expected websocket' }, 400);
    await this.ctx.storage.put('machine', machine);

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    if (role === 'bridge') {
      // replace any previous bridge socket
      for (const ws of this.ctx.getWebSockets('bridge')) { try { ws.close(1012, 'replaced'); } catch {} }
      this.ctx.acceptWebSocket(server, ['bridge']);
      server.serializeAttachment({ role: 'bridge', machine });
    } else {
      const clientId = crypto.randomUUID();
      this.ctx.acceptWebSocket(server, ['client', `c:${clientId}`]);
      server.serializeAttachment({ role: 'client', machine, clientId });
      const online = this.ctx.getWebSockets('bridge').length > 0;
      server.send(JSON.stringify({ type: 'hub.hello', machine, online, clientId }));
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  /* ---- file streaming: GET /api/machine/<m>/file?path=… → bridge streams
     base64 chunks over its WS, we pipe decoded bytes into a real HTTP response
     so <img>/<video> on the phone work natively. Ack-per-chunk = flow control:
     the bridge never runs ahead of what the phone has actually consumed. ---- */

  async fileFetch(url) {
    const bridge = this.bridgeSocket();
    if (!bridge) return json({ error: 'machine offline' }, 503);
    const p = url.searchParams.get('path') || '';
    if (!p) return json({ error: 'path required' }, 400);
    const fileId = crypto.randomUUID();
    this.files ||= new Map();
    const { readable, writable } = new TransformStream();
    const st = { writer: writable.getWriter(), chain: Promise.resolve(), timer: null, onMeta: null };
    this.files.set(fileId, st);
    st.bump = () => {
      clearTimeout(st.timer);
      st.timer = setTimeout(() => this.fileAbort(fileId, 'stalled'), 30_000);
    };
    st.bump();
    const metaP = new Promise((res) => { st.onMeta = res; setTimeout(() => res(null), 15_000); });
    try { bridge.send(JSON.stringify({ type: 'file.fetch', fileId, path: p })); }
    catch { clearTimeout(st.timer); this.files.delete(fileId); return json({ error: 'bridge unreachable' }, 502); }
    const meta = await metaP;
    if (!meta) { this.fileAbort(fileId, 'no meta'); return json({ error: 'machine did not answer' }, 504); }
    if (meta.error) { clearTimeout(st.timer); this.files.delete(fileId); return json({ error: meta.error }, 404); }
    const name = String(meta.name || 'file').replace(/[^\w.\- ()[\]]/g, '_');
    // never render active content (HTML/SVG/XML) inline on the app origin —
    // force download instead; the sandbox CSP defangs anything that slips through
    const mime = String(meta.mime || 'application/octet-stream');
    const dangerous = /^(text\/html|application\/xhtml\+xml|image\/svg\+xml|application\/xml|text\/xml)/i.test(mime);
    const headers = {
      'Content-Type': dangerous ? 'application/octet-stream' : mime,
      'Content-Disposition': `${(url.searchParams.get('dl') || dangerous) ? 'attachment' : 'inline'}; filename="${name}"`,
      'Content-Security-Policy': "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:; media-src data:;",
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Cache-Control': 'private, max-age=300',
    };
    if (Number.isFinite(meta.size)) headers['Content-Length'] = String(meta.size);
    return new Response(readable, { headers });
  }

  fileAbort(fileId, reason) {
    const st = this.files?.get(fileId);
    if (!st) return;
    clearTimeout(st.timer);
    this.files.delete(fileId);
    if (st.onMeta) { const f = st.onMeta; st.onMeta = null; f(null); }
    try { st.writer.abort(reason || 'aborted'); } catch {}
    const b = this.bridgeSocket();
    if (b) { try { b.send(JSON.stringify({ type: 'file.cancel', fileId })); } catch {} }
  }

  broadcastClients(msgStr) {
    for (const ws of this.ctx.getWebSockets('client')) { try { ws.send(msgStr); } catch {} }
  }

  sendToClient(clientId, msgStr) {
    for (const ws of this.ctx.getWebSockets(`c:${clientId}`)) { try { ws.send(msgStr); } catch {} }
  }

  bridgeSocket() {
    return this.ctx.getWebSockets('bridge')[0] || null;
  }

  async updateRegistry(machine, patch) {
    const now = Date.now();
    if (patch.online === undefined && now - this.lastKvWrite < 25_000) return;
    this.lastKvWrite = now;
    const key = `machines:${machine}`;
    const cur = JSON.parse((await this.env.HUB_KV.get(key)) || '{}');
    await this.env.HUB_KV.put(key, JSON.stringify({ ...cur, name: machine, lastSeen: now, ...patch }));
  }

  async webSocketMessage(ws, message) {
    let msg;
    try { msg = JSON.parse(message); } catch { return; }
    const att = ws.deserializeAttachment() || {};
    const machine = att.machine;

    if (att.role === 'bridge') {
      switch (msg.type) {
        case 'hello':
          await this.updateRegistry(machine, { online: true, info: msg.info || {} });
          this.broadcastClients(JSON.stringify({ type: 'machine.online', machine, info: msg.info || {} }));
          return;
        case 'ping':
          await this.updateRegistry(machine, {});
          if (msg.stats) this.broadcastClients(JSON.stringify({ type: 'stats', machine, stats: msg.stats }));
          try { ws.send(JSON.stringify({ type: 'pong' })); } catch {}
          return;
        case 'notify': {
          const notif = { machine, title: msg.title || 'Mothership', body: msg.body || '', tag: msg.tag || '' };
          await recordNotification(this.env, notif);
          this.broadcastClients(JSON.stringify({ type: 'notification', ...notif, ts: Date.now() }));
          // push only matters when nobody is watching live
          if (this.ctx.getWebSockets('client').length === 0 || msg.forcePush) await sendPushToAll(this.env);
          return;
        }
        case 'file.meta': {
          const st = this.files?.get(msg.fileId);
          if (st?.onMeta) { const f = st.onMeta; st.onMeta = null; f(msg); }
          return;
        }
        case 'file.chunk': {
          const st = this.files?.get(msg.fileId);
          if (!st) return;
          st.bump();
          if (msg.error) return this.fileAbort(msg.fileId, msg.error);
          if (msg.data) {
            // chain (not await): a slow phone must not block other WS traffic;
            // the ack only goes out once the bytes are truly consumed
            st.chain = st.chain
              .then(() => st.writer.write(Uint8Array.from(atob(msg.data), (c) => c.charCodeAt(0))))
              .then(() => { try { ws.send(JSON.stringify({ type: 'file.ack', fileId: msg.fileId })); } catch {} })
              .catch(() => this.fileAbort(msg.fileId, 'client gone'));
          }
          if (msg.done) {
            st.chain = st.chain.then(() => {
              clearTimeout(st.timer);
              this.files.delete(msg.fileId);
              return st.writer.close();
            }).catch(() => {});
          }
          return;
        }
        default:
          if (msg.clientId) this.sendToClient(msg.clientId, JSON.stringify(msg));
          else this.broadcastClients(JSON.stringify(msg));
          return;
      }
    }

    // client → bridge
    const bridge = this.bridgeSocket();
    msg.clientId = att.clientId;
    if (!bridge) {
      const err = { type: 'res', id: msg.id, error: 'machine offline' };
      try { ws.send(JSON.stringify(err)); } catch {}
      try { ws.send(JSON.stringify({ type: 'machine.offline', machine })); } catch {}
      return;
    }
    try { bridge.send(JSON.stringify(msg)); } catch {}
  }

  async webSocketClose(ws) {
    const att = ws.deserializeAttachment() || {};
    if (att.role === 'bridge') {
      await this.updateRegistry(att.machine, { online: false });
      this.lastKvWrite = 0;
      this.broadcastClients(JSON.stringify({ type: 'machine.offline', machine: att.machine }));
    } else if (att.role === 'client') {
      const bridge = this.bridgeSocket();
      if (bridge) { try { bridge.send(JSON.stringify({ type: 'client.gone', clientId: att.clientId })); } catch {} }
    }
  }

  async webSocketError(ws) { return this.webSocketClose(ws); }
}

/* ---------------- worker fetch ---------------- */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (!path.startsWith('/api/')) return env.ASSETS.fetch(request);

    if (!(await authed(request, url, env))) return json({ error: 'unauthorized' }, 401);

    // WebSocket + file endpoints → route to the machine's DO
    let m;
    if ((m = path.match(/^\/api\/bridge\/([a-z0-9-]+)$/)) || (m = path.match(/^\/api\/machine\/([a-z0-9-]+)\/(ws|file)$/))) {
      const machine = m[1];
      if (!MACHINE_RE.test(machine)) return json({ error: 'bad machine name' }, 400);
      const role = path.startsWith('/api/bridge/') ? 'bridge' : (m[2] === 'file' ? 'file' : 'client');
      const id = env.MACHINES.idFromName(machine);
      const stub = env.MACHINES.get(id);
      const fwd = new Request(request);
      fwd.headers.set('X-MS-Role', role);
      fwd.headers.set('X-MS-Machine', machine);
      return stub.fetch(fwd);
    }

    if (path === '/api/config') {
      return json({ vapidPublicKey: env.VAPID_PUBLIC_KEY || null });
    }

    if (path === '/api/machines') {
      const list = await env.HUB_KV.list({ prefix: 'machines:' });
      const machines = await Promise.all(list.keys.map(async ({ name }) => JSON.parse((await env.HUB_KV.get(name)) || '{}')));
      const now = Date.now();
      for (const mc of machines) mc.online = !!mc.online && now - (mc.lastSeen || 0) < 75_000;
      machines.sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0));
      return json({ machines });
    }

    if (path === '/api/fleet') return json(await getFleet(env));

    if (path === '/api/fleet/metrics') return json(await getFleetMetrics(env));

    if (path === '/api/notifications') {
      return json({ notifications: JSON.parse((await env.HUB_KV.get('notifications')) || '[]') });
    }

    if (path === '/api/push/subscribe' && request.method === 'POST') {
      const sub = await request.json();
      if (!sub?.endpoint) return json({ error: 'bad subscription' }, 400);
      await env.HUB_KV.put(`push:sub:${await sha256hex(sub.endpoint)}`, JSON.stringify(sub));
      return json({ ok: true });
    }

    if (path === '/api/push/unsubscribe' && request.method === 'POST') {
      const sub = await request.json();
      if (sub?.endpoint) await env.HUB_KV.delete(`push:sub:${await sha256hex(sub.endpoint)}`);
      return json({ ok: true });
    }

    if (path === '/api/push/test' && request.method === 'POST') {
      await recordNotification(env, { machine: 'hub', title: 'Test notification', body: 'Push pipeline works.' });
      await sendPushToAll(env);
      return json({ ok: true });
    }

    return json({ error: 'not found' }, 404);
  },
};
