# AGENTS.md — what an agent inside a Mothership session should know

You are reading this because you are running as a chat session under a
Mothership bridge, or you are setting one up. Mothership is a relay: a phone or
laptop talks to a Cloudflare Worker, the Worker talks to a bridge process on a
real machine, and the bridge runs you (a coding agent CLI) as a chat and can
open a terminal, browse files, and control the machine.

## Where you are standing

- **The machine is real.** Commands you run through the terminal or a one-shot
  shell execute on the owner's computer, as the owner's user. Destructive
  actions (delete, format, restart, shutdown) are the owner's to decide;
  confirm before doing one they did not explicitly ask for this turn.
- **The bridge dials out; nothing is exposed inbound.** The only door is the
  hub, and the hub answers nothing without `HUB_TOKEN`. Do not suggest opening
  ports, tunnels, or a tokenless hub to "make it easier".
- **The token is a pointer, never a value.** When you write state, notes, or
  a handoff, refer to `HUB_TOKEN` by name ("the worker secret", "the value in
  `config.json`"). Never paste it. A copied secret goes stale and becomes a
  confidently wrong answer later.

## Long-session memory (the part that makes long work possible)

When your context window fills, the bridge rolls you into a fresh session and
primes it with three things. Help it do that well:

1. **The Persistent State block.** When asked for it, output a compact,
   lossless ledger between `<state>` and `</state>`: PLANS (named, current
   step), OPEN TODOS, DECISIONS (dated), KEY FILES/PATHS, POINTERS (where a
   live value lives, never the value), DEAD ENDS (what was tried and why it
   was abandoned). Carry the prior state forward and update it; remove an item
   only when it is actually resolved.
2. **The verbatim tail.** The last stretch of the transcript is replayed
   word for word. You do not need to restate it.
3. **Recall.** Anything older than the tail can be pulled back exactly from the
   on-disk archive with `recall.mjs` (`node recall.mjs "<phrase>"`). Reach for
   it before saying "I don't remember"; the archive does.

Design notes: `docs/long-session-memory.md`.

## Pairing with a Second Brain

Mothership keeps one long thread coherent. It is not a knowledge base. Facts
that should outlive the conversation (project state, decisions, rules) belong
in a [Second Brain](https://github.com/lennymadethat/second-brain) library, if
the owner runs one. Write there through its MCP tools; do not stuff durable
facts into the state block and hope.

## When the hub or bridge misbehaves

- `GET /api/machines` on the hub (with the token) lists what is online.
- The bridge logs to its own folder; `install.ps1` registers it as a scheduled
  task that restarts on crash.
- A machine missing from the list is a bridge that is not connected, not a hub
  bug. Check the task, the `hubUrl`, and the token in `config.json`, in that order.
