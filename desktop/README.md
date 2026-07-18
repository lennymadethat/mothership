# Mothership Desktop

Thin Electron shell around the hub PWA — same app, its own window and taskbar icon.

```
cd desktop
npm install
npm start                 # run against production (mothership.your-domain.com)
```

Point it at the dev hub instead:

```powershell
$env:MOTHERSHIP_URL = 'https://mothership-hub.YOUR_SUBDOMAIN.workers.dev'; npm start
```

Build a portable `.exe` (lands in `desktop/dist/`):

```
npm run dist
```

`dist/` and `node_modules/` are gitignored — the exe is a local build artifact, not a committed file.
