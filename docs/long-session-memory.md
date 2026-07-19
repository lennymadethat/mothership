# Long-session memory (State Block + Recall)

Mothership keeps a chat **alive across context-window rollovers**. The phone UI shows one continuous thread; under the hood the bridge stitches many agent sessions into that thread.

This is **conversation continuity**, not long-term knowledge. Pair it with [persistent-memory](https://github.com/lennymadethat/persistent-memory) if you also want a vault the model can search forever.

## The problem

Agent context windows fill up. When they do, naive tools either:

- drop the oldest turns (silent amnesia), or
- summarize everything into a lossy blurb (confidently wrong details).

Neither is good enough for multi-hour / multi-day builds.

## The stack (cheapest first)

| Layer | What it is | Survives |
|---|---|---|
| **Native resume** | Provider session id (`claude -p --resume`, etc.) | Until the provider drops it |
| **Persistent State** | Lossy-resistant ledger in `<state>…</state>` | Every rollover, pinned on the card |
| **Verbatim tail** | Recent user/assistant turns from local JSONL | Every re-prime (budget-capped) |
| **Recall** | Keyword search over the full on-disk archive | Forever, on demand |

### 1. Persistent State (the State Block)

On automatic rollover the dying session is asked to emit a compact ledger between `<state>` and `</state>`:

- **PLANS** — named, with current step  
- **OPEN TODOS**  
- **DECISIONS** — dated  
- **KEY FILES/PATHS**  
- **POINTERS** — *where* a live value lives (env file, worker secret). **Never paste secrets.** A copied token goes stale and becomes a confidently wrong answer.  
- **DEAD ENDS** — what was tried and why abandoned  

Rules the wrap must follow:

1. Carry the prior state forward and **update** it.  
2. Never remove an item unless it is actually resolved.  
3. Stamp volatile facts with the part number; newer overrides older.

The bridge stores that string on the session (`persistentState`) and injects it at the top of every seamless continuation.

### 2. Verbatim recent transcript

Alongside the state, the bridge injects the **actual** recent conversation (not just a summary), walking newest → oldest until a char budget is hit. Details in the last few parts stay exact.

### 3. Recall (`bridge/recall.mjs`)

Everything older than the tail still lives in `bridge/data/transcripts/<sessionKey>.jsonl`. When a live session needs an exact quote, ID, path, or decision from part 3 of a 17-part chat, it runs:

```bash
node bridge/recall.mjs --key <sessionKey> --query "keywords"
# options: --any  --part N  --context N  --limit N  --list
```

No embeddings, no network, no spend. Exact keyword match with citations (`part · turn · date`).

## How rollover works

```
context ~92% full
        │
        ▼
 wrap run (old session): vault close-out + <state> + <brief>
        │
        ▼
 card: part++, clear native resume id, handoff=true, keep persistentState
        │
        ▼
 next user message → re-prime preamble:
   [SEAMLESS CONTINUATION]
   [PERSISTENT STATE]
   [brief]
   [VERBATIM RECENT TRANSCRIPT]
   [RECALL pointer]
   [user's newest message]
```

The user never sees a “new chat.” They keep typing.

## What this is *not*

- **Not a product brand** for “forever chat.” The product is **Mothership**. Long-session memory is a feature of the bridge.  
- **Not your knowledge vault.** State Block holds *this conversation’s* plans and decisions. Permanent notes, methodology, and project wiki pages belong in **persistent-memory** (or your own Markdown vault mirrored through it).  
- **Not a place for secrets.** Pointers only.

## Files

| File | Role |
|---|---|
| `bridge/bridge.js` | Rollover wrap, state capture, re-prime injection |
| `bridge/recall.mjs` | Exact archive search CLI |
| `bridge/data/transcripts/*.jsonl` | Local turn archive (created at runtime, not shipped) |

## Try it

1. Run a long Mothership chat until context approaches the limit (or force a wrap).  
2. Confirm the next message continues without a greeting / recap.  
3. From the machine:

```bash
cd bridge
node recall.mjs --list
node recall.mjs --key my-session-key --query "decision deploy"
```
