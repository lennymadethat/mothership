# Mothership

**Your machines, in your pocket.** A mobile-first PWA that remote-controls your always-on computers — run Claude Code as chat, open a real terminal, watch live system stats, browse files, and lock/restart/shut down — through a single Cloudflare Worker relay. **No open ports, no VPN, no tunnels.**

```
 Phone / laptop PWA  ──wss──▶  Cloudflare Worker (Durable Object per machine)  ◀──wss──  Bridge agent on each machine
```

The bridge on each machine dials **out** to the hub; your browser connects to the same hub; a Durable Object relays messages both ways. One bearer token (`HUB_TOKEN`) gates everything. Because each machine only makes outbound connections, there's nothing to expose to the internet.

## What you get
- **Claude Code as chat** — streaming replies, markdown, tool-call chips, session resume (`claude -p --resume` under the hood). Multiple named sessions per machine, switch instantly, transcripts persist.
- **Real terminal** — full PTY (ConPTY on Windows) in xterm.js with mobile quick-keys, pipe-mode fallback.
- **Fleet view** — every machine (online dots, host info) plus every Cloudflare Worker with its cron schedules.
- **Machine control** — live CPU/RAM/disk gauges, process kill, lock/restart/shutdown (double-confirmed), file browser, one-shot shell.
- **History** — every native Claude Code session ever run on the machine, searchable, with a transcript viewer.
- **Push notifications** — your phone buzzes when a run finishes or a machine acts up (VAPID web push, payload-free by design).
- **PWA** — install to home screen, offline shell, dark, fast.

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
npx wrangler@4 secret put HUB_TOKEN            # a long random string — your master key
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

- **Token mode is the default and the recommended way to run.** Set `HUB_TOKEN` on the worker; every bridge and every browser must present it. Anyone without the token gets nothing.
- **Use a long, random token** (32+ bytes). Rotate it by changing the worker secret and re-running the bridge installer with the new value.
- **Open mode exists for trusted-LAN use only.** If you run without a token, the only thing protecting your machines is the secrecy of your hub URL — that is *not* real security. Don't run open mode on a public hub URL.
- Nothing here needs inbound ports; keep it that way. The bridge is outbound-only.
- Push notifications are payload-free — no session content ever leaves in a push.

## Configuration
See `bridge/config.example.json` for the bridge config shape and `worker/wrangler.jsonc` for the hub bindings (KV namespace, Durable Object, account id, route). Replace every `YOUR_*` placeholder with your own values.

## License
MIT — see [LICENSE](LICENSE). Use it, fork it, ship your own fleet.


---

<sub>Built by [lennymadethat](https://lennymadethat.com).</sub>
