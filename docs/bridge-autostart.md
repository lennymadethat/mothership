# Bridge autostart — how it comes back after a reboot

`install.ps1` registers a `MothershipBridge` scheduled task with **two** triggers:

| Trigger | Fires | Runs as |
|---|---|---|
| `AtStartup` | machine boots, nobody logged in | your account, S4U logon |
| `AtLogOn` | you sign in | your account |

The task runs `wscript.exe run-hidden.vbs`, and the VBS supervises `node bridge.js`
in a loop — no console window, respawn 5s after a crash, log rotated at 10 MB into
`data\bridge.log`. Because the supervisor is the thing the task owns, stopping the
task stops the bridge.

## "The machine is offline and all my sessions are gone"

They aren't gone. The session list in the PWA is served **by the bridge**, live from
the machine's own disk:

| What | Where |
|---|---|
| Session cards (name, key, repo, last used) | `bridge/data/sessions.json` |
| Full transcripts, one file per session | `bridge/data/transcripts/<key>.jsonl` |

Both are gitignored and local to that machine. No bridge connected → the PWA has
nothing to list → **"no sessions"**. It is an offline symptom, not deletion. When the
bridge reconnects, every session comes back exactly as it was.

## Why a reboot can leave it dark

`AtStartup` fires **before anyone logs on**, so the task only inherits the *machine*
environment. If Node was installed per-user — nvm-windows, fnm, scoop, `winget` in
user scope — then `node` lives on the **user** PATH, which does not exist yet at that
point. A bare `node bridge.js` resolves to nothing, `cmd` exits immediately, the
supervisor respawns it 5 seconds later, forever.

The trap is that everything *looks* healthy: Task Scheduler shows `MothershipBridge`
as **Running**, because the supervisor really is running. Only the log tells you:

```powershell
Get-Content $env:USERPROFILE\mothership-bridge\data\bridge.log -Tail 20
```

`'node' is not recognized...` or `[supervisor] node.exe not found` is this failure.

This is also why the problem only ever shows up after a real restart — `AtLogOn` and
`Start-ScheduledTask` both run with your full user environment, so the bridge works
fine right up until the first boot that has to stand on its own.

### Fix

`install.ps1` resolves node's absolute path at install time and pins it to
`data\node-path.txt`; `run-hidden.vbs` reads that first, then checks the usual install
locations, then walks both the machine and user PATH out of the registry. Re-running
the installer is enough:

```powershell
cd $env:USERPROFILE\mothership-bridge
.\install.ps1 -HubUrl https://mothership-hub.YOUR_SUBDOMAIN.workers.dev -Token <HUB_TOKEN> -Machine my-desktop
```

Or pin it by hand and restart the task:

```powershell
(Get-Command node).Source | Set-Content .\data\node-path.txt -NoNewline
Restart-ScheduledTask -TaskName MothershipBridge
```

## Getting back online right now

To bring the machine up immediately, without waiting on any of the above:

```powershell
cd $env:USERPROFILE\mothership-bridge
node bridge.js
```

It connects within seconds and your sessions reappear in the PWA. Leave the window
open — closing it stops the bridge — then fix the task properly and it survives the
next reboot on its own.

## Checking the task

```powershell
Get-ScheduledTask MothershipBridge | Get-ScheduledTaskInfo   # last run time + result
Get-ScheduledTask MothershipBridge | Select-Object -Expand Triggers
Start-ScheduledTask MothershipBridge
```

`LastTaskResult` of `267009` means "currently running" — expected, and remember it says
nothing about whether node itself launched. Trust `data\bridge.log` over the task state.
