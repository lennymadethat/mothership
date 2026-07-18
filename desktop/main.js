// Mothership Desktop — thin Electron shell around the hub PWA.
// The hub URL is baked in; override with MOTHERSHIP_URL for the dev hub.
const { app, BrowserWindow, shell } = require('electron');

const HUB_URL = process.env.MOTHERSHIP_URL || 'https://mothership.your-domain.com';

function createWindow() {
  const win = new BrowserWindow({
    width: 460,
    height: 880,
    minWidth: 360,
    minHeight: 560,
    autoHideMenuBar: true,
    backgroundColor: '#0b0f16',
    title: 'Mothership',
    webPreferences: { nodeIntegration: false, contextIsolation: true },
  });
  win.loadURL(HUB_URL);
  // external links (docs, repos) open in the real browser, not inside the shell
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

app.whenReady().then(createWindow);
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
app.on('window-all-closed', () => app.quit());
