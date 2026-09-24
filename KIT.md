# KIT.md — paste this into your agent

Copy everything below the line into Claude Code, Codex, Cursor, or any agent
with a shell on the machine you want to reach from your phone. It deploys the
hub, installs the bridge, and proves the round trip. Budget: about 15 minutes.
Cost: a Cloudflare account (the free tier is enough for one person).

---

You are setting up **Mothership** (your machines, in your pocket) from
https://github.com/lennymadethat/mothership. Work through every step, verify
each one, and stop only when you need a value from me. Never paste a secret
into a committed file; secrets go in with `wrangler secret put` and into the
bridge's git-ignored `config.json`.

**1. Clone**

```
git clone https://github.com/lennymadethat/mothership.git
cd mothership
```

Read `README.md` → Security first. The hub answers nothing without a token, and
there must be exactly one deployed copy of the hub.

**2. The hub (Cloudflare Worker)**

```
cd worker
npx wrangler@4 login
npx wrangler@4 kv namespace create HUB_KV
```

Put the returned id into `wrangler.jsonc` (`YOUR_KV_NAMESPACE_ID`) and my
account id (`YOUR_CLOUDFLARE_ACCOUNT_ID`; `npx wrangler whoami` shows it). Then:

```
npx wrangler@4 secret put HUB_TOKEN      # generate: openssl rand -hex 32; keep it, the bridge needs it
npx wrangler@4 deploy
```

Verify: `curl https://<hub>.workers.dev/api/machines` with no token returns
401, and with `-H "Authorization: Bearer <token>"` returns an empty list.
If the no-token call returns anything else, stop; the hub is not gated.

Optional: `secret put VAPID_PRIVATE_JWK` and `VAPID_PUBLIC_KEY` for push
notifications (`scripts/generate-icons.ps1` has nothing to do with this;
generate VAPID keys with `npx web-push generate-vapid-keys`).

**3. The bridge (on this machine)**

Needs Node 20+ and, for the chat feature, the coding agent CLI installed
(Claude Code by default). From the repo root:

```
cd bridge
npm install
.\install.ps1 -HubUrl https://<hub>.workers.dev -Token <HUB_TOKEN> -Machine <short-name>
```

This writes `config.json`, registers a `MothershipBridge` scheduled task
(auto-start at logon, restart on crash), and starts it. Verify with
`Get-ScheduledTask MothershipBridge` and then `curl /api/machines` with the
token: this machine should be listed online within a few seconds.

**4. The phone**

Open the hub URL in the phone's browser, enter the token, install to home
screen. Open a chat session and send "what machine am I on?". Confirm the
reply names this machine.

**5. Prove long-session memory (optional but worth it)**

In the same chat, ask for the persistent state block (`<state>…</state>`),
then run `node bridge/recall.mjs "what machine"` on this machine and confirm
it returns the earlier turn verbatim.

**6. Report**

Tell me: the hub URL, the machine name, whether push is on, and the three
proofs (401 without token, machine online, chat answered). Remind me the token
is the key to every machine on the hub and I rotate it with
`wrangler secret put HUB_TOKEN` followed by re-running `install.ps1` on each
machine.
