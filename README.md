# Mothership

**Your machines, in your pocket.** A mobile-first PWA that remote-controls your always-on computers — run Claude Code as chat, open a real terminal, watch live system stats, browse files, and lock/restart/shut down — through a single Cloudflare Worker relay. **No open ports, no VPN, no tunnels.**

```
 Phone / laptop PWA  ──wss──▶  Cloudflare Worker (Durable Object per machine)  ◀──wss──  Bridge agent on each machine
```

The bridge on each machine dials **out** to the hub; your browser connects to the same hub; a Durable Object relays messages both ways. One bearer token (`HUB_TOKEN`) gates everything. Because each machine only makes outbound connections, there's nothing to expose to the internet.

## What you get
- **Claude Code as chat** — streaming replies, markdown, tool-call chips, session resume (`claude -p --resume` under the hood). Multiple named sessions per machine, switch instantly, transcripts persist.
- **Long-session memory** — when a context window fills up, the chat does **not** die. The bridge rolls into a fresh agent session primed with a **Persistent State** ledger (plans, todos, decisions, paths, pointers, dead ends), a short orientation brief, the **verbatim** recent transcript, and a **Recall** CLI so any older turn can be pulled back word-for-word from the on-disk archive. One continuous thread on your phone; many stitched parts under the hood. Design notes: [`docs/long-session-memory.md`](docs/long-session-memory.md).
- **Real terminal** — full PTY (ConPTY on Windows) in xterm.js with mobile quick-keys, pipe-mode fallback.
- **Fleet view** — every machine (online dots, host info) plus every Cloudflare Worker with its cron schedules.
- **Machine control** — live CPU/RAM/disk gauges, process kill, lock/restart/shutdown (double-confirmed), file browser, one-shot shell.
- **History** — every native Claude Code session ever run on the machine, searchable, with a transcript viewer.
- **Push notifications** — your phone buzzes when a run finishes or a machine acts up (VAPID web push, payload-free by design).
- **PWA** — install to home screen, offline shell, dark, fast.

### Memory layers (how this pairs with Second Brain)

| Layer | Product | Job |
|---|---|---|
| Conversation continuity | **Mothership** (this repo) | State Block + verbatim tail + `recall.mjs` across rollovers |
| Long-term knowledge | **[Second Brain](https://github.com/lennymadethat/second-brain)** | Persistent memory for any agent: rulebook + MCP memory server + hosted vector library |

Ship the machine; keep your private diary out of git.

## How it fits together
| Piece | What it is | Where it runs |
|---|---|---|
| `worker/` | The hub — a Cloudflare Worker + one Durable Object per machine; serves the PWA and relays WebSocket traffic | Cloudflare edge |
| `bridge/` | The agent that dials out from each of your machines and exposes it to the hub | Each computer you own |
| `web/` | The PWA (vanilla JS, no framework) | Served by the worker |
| `desktop/` | Optional Electron wrapper | Your desktop |

## Quick start

### 1. Deploy the hub (Cloudflare Worker)
```bash
cd worker
# edit wrangler.jsonc: set your account id, KV namespace ids, and route/domain
npx wrangler@4 kv namespace create HUB_KV      # paste the id into wrangler.jsonc
npx wrangler@4 secret put HUB_TOKEN            # required — a long random string; the hub answers nothing without it
npx wrangler@4 secret put VAPID_PRIVATE_JWK    # optional: for push notifications
npx wrangler@4 secret put VAPID_PUBLIC_KEY     # optional
npx wrangler@4 deploy
```

### 2. Install the bridge on a machine
PowerShell on the target machine (needs Node 20+ and, for the chat feature, Claude Code installed):
```powershell
cd $env:USERPROFILE
iwr https://mothership-hub.YOUR_SUBDOMAIN.workers.dev/bridge.zip -OutFile ms-bridge.zip
Expand-Archive ms-bridge.zip -DestinationPath mothership-bridge -Force
cd mothership-bridge
.\install.ps1 -HubUrl https://mothership-hub.YOUR_SUBDOMAIN.workers.dev -Token <HUB_TOKEN> -Machine my-desktop
```
This installs deps, writes `config.json`, registers a `MothershipBridge` scheduled task (auto-start at logon, auto-restart on crash), and starts it. The machine shows up in the PWA within seconds.

### 3. Open the PWA
Visit your hub URL, enter your `HUB_TOKEN`, install to home screen. Done.

## Security — read this before you deploy

Mothership can run terminal commands and shut down your computers, so treat `HUB_TOKEN` like the keys to your house.

- **The hub fails closed.** With no `HUB_TOKEN` set, the worker answers nothing: no machines, no relay, no files. There is no open mode. Set the secret before the first bridge connects.
- **Use a long, random token** (32+ bytes). Rotate it by changing the worker secret and re-running the bridge installer with the new value.
- **One worker, one URL.** Do not keep a second "dev" copy of the hub deployed on the same account with the same bindings; a forgotten copy without a token is an open door to every machine. If you need a staging hub, give it its own KV namespace and its own token.
- Nothing here needs inbound ports; keep it that way. The bridge is outbound-only.
- Push notifications are payload-free — no session content ever leaves in a push.

## Configuration
See `bridge/config.example.json` for the bridge config shape and `worker/wrangler.jsonc` for the hub bindings (KV namespace, Durable Object, account id, optional custom domain). Replace every `YOUR_*` placeholder with your own values. [`KIT.md`](KIT.md) is a paste-prompt that walks an agent through the whole setup; [`AGENTS.md`](AGENTS.md) tells an agent running inside a Mothership session what it is standing on.

## Siblings
- [Second Brain](https://github.com/lennymadethat/second-brain): the long-term memory the chat can search.
- [Ingester](https://github.com/lennymadethat/ingester): drop a file, get a memory.
- [Harvester](https://github.com/lennymadethat/harvester): paste a link, get the lessons.

## License
MIT — see [LICENSE](LICENSE). Use it, fork it, ship your own fleet.


---

<sub>Built by [lennymadethat](https://lennymadethat.com).</sub>
