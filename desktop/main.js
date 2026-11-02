// Hearth desktop app.
//
// A secure window around a Hearth server, plus things browsers can't do:
// tray icon, global mute/deafen hotkeys that work inside games, a screen
// and window picker with system audio, unread badge, launch at startup.
//
// Security follows Electron's official checklist: the web page has no
// access to Node.js or the computer, runs sandboxed with context isolation,
// may only navigate within the chosen Hearth server, and only that server
// may use the microphone, camera or screen capture.
'use strict';
const {
  app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, shell, session,
  globalShortcut, desktopCapturer, net,
} = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const configPath = path.join(app.getPath('userData'), 'config.json');
function readConfig() {
  try { return JSON.parse(fs.readFileSync(configPath, 'utf8')); } catch { return {}; }
}
function writeConfig(cfg) {
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2));
}

let config = readConfig();
const serverOrigin = (() => {
  try { return config.serverUrl ? new URL(config.serverUrl).origin : null; } catch { return null; }
})();

// Browsers only allow microphone/camera on HTTPS. Until a server has HTTPS,
// treat that one chosen server (and only it) as secure so testing works.
if (serverOrigin && serverOrigin.startsWith('http:')) {
  app.commandLine.appendSwitch('unsafely-treat-insecure-origin-as-secure', serverOrigin);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => showMain());
}

let mainWindow = null;
let tray = null;
let quitting = false;
const iconPath = path.join(__dirname, 'build', 'icon.png');

function isOurs(url) {
  try { return serverOrigin && new URL(url).origin === serverOrigin; } catch { return false; }
}

function openExternal(url) {
  // Only hand normal web links to the system browser.
  if (/^https?:\/\//i.test(url)) shell.openExternal(url);
}

// ---------- hardening for every web page the app creates ----------
app.on('web-contents-created', (_e, contents) => {
  contents.on('will-navigate', (e, url) => {
    if (contents.getURL().startsWith('file:') && url.startsWith('file:')) return;
    if (!isOurs(url)) { e.preventDefault(); openExternal(url); }
  });
  contents.on('will-attach-webview', (e) => e.preventDefault());
  contents.setWindowOpenHandler(({ url }) => { openExternal(url); return { action: 'deny' }; });
});

function setupPermissions() {
  const allowed = new Set(['media', 'display-capture', 'notifications', 'fullscreen', 'clipboard-sanitized-write']);
  session.defaultSession.setPermissionRequestHandler((wc, permission, callback, details) => {
    callback(allowed.has(permission) && isOurs(details.requestingUrl || wc.getURL()));
  });
  session.defaultSession.setPermissionCheckHandler((wc, permission, origin) =>
    allowed.has(permission) && isOurs(origin || (wc && wc.getURL())));

  // Screen sharing: show our own picker of screens and windows, and include
  // system audio on Windows so game sound comes through.
  session.defaultSession.setDisplayMediaRequestHandler(async (request, callback) => {
    if (!isOurs(request.securityOrigin || request.frame?.url)) return callback({});
    try {
      const sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 320, height: 180 }, fetchWindowIcons: true });
      const choice = await pickSource(sources);
      if (!choice) return callback({});
      const src = sources.find((s) => s.id === choice.id);
      callback(choice.audio && process.platform === 'win32' ? { video: src, audio: 'loopback' } : { video: src });
    } catch {
      callback({});
    }
  });
}

function pickSource(sources) {
  return new Promise((resolve) => {
    const win = new BrowserWindow({
      width: 760, height: 560, parent: mainWindow, modal: true, show: false, resizable: true,
      title: 'Share your screen', backgroundColor: '#1a1816', autoHideMenuBar: true,
      webPreferences: { preload: path.join(__dirname, 'picker-preload.js'), contextIsolation: true, sandbox: true, nodeIntegration: false },
    });
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); if (!win.isDestroyed()) win.close(); } };
    ipcMain.once('picker:choose', (_e, v) => finish(v));
    win.on('closed', () => finish(null));
    const list = sources.map((s) => ({
      id: s.id, name: s.name, kind: s.id.startsWith('screen') ? 'screen' : 'window',
      thumb: s.thumbnail.toDataURL(), icon: s.appIcon ? s.appIcon.toDataURL() : null,
    }));
    win.loadFile(path.join(__dirname, 'pages', 'picker.html'));
    win.webContents.once('did-finish-load', () => {
      win.webContents.send('picker:sources', { list, canAudio: process.platform === 'win32' });
      win.show();
    });
  });
}

// ---------- windows ----------
function createMain() {
  const state = config.window || { width: 1280, height: 800 };
  mainWindow = new BrowserWindow({
    ...state, minWidth: 420, minHeight: 500, show: false, title: 'Hearth',
    backgroundColor: '#080d0a', icon: iconPath, autoHideMenuBar: true,
    webPreferences: {
      // First run gets the server-setup bridge; afterwards the page gets
      // only the small hearthDesktop bridge.
      preload: path.join(__dirname, serverOrigin ? 'preload.js' : 'setup-preload.js'),
      contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true, spellcheck: true,
    },
  });
  Menu.setApplicationMenu(null);
  mainWindow.once('ready-to-show', () => { if (!process.argv.includes('--hidden')) mainWindow.show(); });

  if (serverOrigin) {
    mainWindow.loadURL(config.serverUrl);
    mainWindow.webContents.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
      if (isMainFrame && code !== -3) mainWindow.loadFile(path.join(__dirname, 'pages', 'offline.html'), { query: { server: config.serverUrl, error: desc } });
    });
  } else {
    mainWindow.loadFile(path.join(__dirname, 'pages', 'setup.html'));
  }

  // Closing hides to the tray, like other chat apps.
  mainWindow.on('close', (e) => {
    config.window = mainWindow.getBounds();
    writeConfig(config);
    if (!quitting && config.closeToTray !== false && serverOrigin) { e.preventDefault(); mainWindow.hide(); }
  });
}

function showMain() {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function createTray() {
  const img = nativeImage.createFromPath(path.join(__dirname, 'build', 'tray.png'));
  tray = new Tray(img);
  tray.setToolTip('Hearth');
  const menu = () => Menu.buildFromTemplate([
    { label: 'Open Hearth', click: showMain },
    { type: 'separator' },
    { label: 'Mute / unmute   (Ctrl+Shift+M)', click: () => send('desktop:toggle-mute') },
    { label: 'Deafen / undeafen   (Ctrl+Shift+D)', click: () => send('desktop:toggle-deafen') },
    { type: 'separator' },
    {
      label: 'Start Hearth when I sign in', type: 'checkbox', checked: app.getLoginItemSettings().openAtLogin,
      click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked, args: ['--hidden'] }),
    },
    { label: 'Change server…', click: changeServer },
    { type: 'separator' },
    { label: 'Quit Hearth', click: () => { quitting = true; app.quit(); } },
  ]);
  tray.setContextMenu(menu());
  tray.on('click', showMain);
}

function send(channel) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel);
}

function changeServer() {
  config.serverUrl = null;
  writeConfig(config);
  app.relaunch();
  quitting = true;
  app.quit();
}

// ---------- messages from the pages ----------
ipcMain.handle('setup:save', async (_e, input) => {
  let url;
  try {
    url = new URL(/^https?:\/\//i.test(input) ? input : `http://${input}`);
  } catch { return { error: 'That doesn’t look like a web address.' }; }
  if (!/^https?:$/.test(url.protocol)) return { error: 'Use an http:// or https:// address.' };
  try {
    const res = await net.fetch(new URL('/api/config', url.origin).toString());
    if (!res.ok) throw new Error();
    await res.json();
  } catch {
    return { error: 'Couldn’t reach a Hearth server at that address.' };
  }
  config.serverUrl = url.origin;
  writeConfig(config);
  app.relaunch();
  quitting = true;
  app.quit();
  return { ok: true };
});

ipcMain.on('desktop:badge', (_e, count) => {
  const n = Math.max(0, Number(count) | 0);
  app.setBadgeCount(n);
  if (mainWindow && process.platform === 'win32') {
    mainWindow.setOverlayIcon(n ? nativeImage.createFromPath(path.join(__dirname, 'build', 'tray.png')) : null, n ? `${n} unread` : '');
  }
  if (tray) tray.setToolTip(n ? `Hearth — ${n} unread` : 'Hearth');
});

ipcMain.on('desktop:flash', () => {
  if (mainWindow && !mainWindow.isFocused()) mainWindow.flashFrame(true);
});

ipcMain.on('desktop:retry', () => { if (mainWindow) mainWindow.loadURL(config.serverUrl); });
ipcMain.on('desktop:change-server', changeServer);

// ---------- updates ----------
// The app asks its own Hearth server whether a newer desktop app has been
// published. If so, the page shows an "Update now" bar; on Windows the new
// installer is downloaded (only from that server), checked against the size
// and SHA-256 the server published, then run, and the app restarts.
let pendingUpdate = null;
const newer = (a, b) => {
  const x = String(a).split('.').map(Number); const y = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) { if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0); }
  return false;
};
async function checkForUpdate() {
  if (!serverOrigin) return;
  try {
    const res = await net.fetch(`${serverOrigin}/api/desktop/latest?platform=win`);
    if (!res.ok) return;
    const info = await res.json();
    if (!info.version || !/^\d+\.\d+\.\d+$/.test(info.version) || !newer(info.version, app.getVersion())) return;
    pendingUpdate = { version: info.version, notes: String(info.notes || '').slice(0, 300), size: Number(info.size), sha256: String(info.sha256 || '') };
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('desktop:update-available', { version: pendingUpdate.version, notes: pendingUpdate.notes });
  } catch { /* offline: try again later */ }
}
ipcMain.handle('desktop:version', () => app.getVersion());
ipcMain.handle('desktop:get-update', () => (pendingUpdate ? { version: pendingUpdate.version, notes: pendingUpdate.notes } : null));
let installing = false;
ipcMain.handle('desktop:install-update', async () => {
  if (!pendingUpdate) return { error: 'No update is waiting.' };
  if (process.platform !== 'win32') { shell.openExternal(`${serverOrigin}/download/desktop/win`); return { ok: true }; }
  if (installing) return { error: 'Already updating\u2026' };
  installing = true;
  const u = pendingUpdate;
  const file = path.join(app.getPath('temp'), `Hearth-Setup-${u.version}.exe`);
  try {
    const res = await net.fetch(`${serverOrigin}/download/desktop/win`);
    if (!res.ok || !res.body) throw new Error('download failed');
    const hash = crypto.createHash('sha256');
    const out = fs.createWriteStream(file);
    let got = 0; let lastSent = 0;
    for await (const chunk of res.body) {
      const b = Buffer.from(chunk);
      got += b.length; hash.update(b); out.write(b);
      if (got > u.size + 1024) throw new Error('too large');
      if (Date.now() - lastSent > 250) { lastSent = Date.now(); if (mainWindow) mainWindow.webContents.send('desktop:update-progress', u.size ? got / u.size : 0); }
    }
    await new Promise((r, j) => out.end((e) => (e ? j(e) : r())));
    const head = Buffer.alloc(2); const fd = fs.openSync(file, 'r'); fs.readSync(fd, head, 0, 2, 0); fs.closeSync(fd);
    if (got !== u.size || hash.digest('hex') !== u.sha256 || head.toString('latin1') !== 'MZ') throw new Error('check failed');
  } catch {
    installing = false;
    fs.rmSync(file, { force: true });
    return { error: 'The update couldn\u2019t be downloaded safely. Try again later.' };
  }
  // Run the installer on its own and quit so it can replace the app. It
  // starts Hearth again when it's done.
  spawn(file, [], { detached: true, stdio: 'ignore' }).unref();
  setTimeout(() => { quitting = true; app.quit(); }, 500);
  return { ok: true };
});

// ---------- start ----------
app.whenReady().then(() => {
  app.setAppUserModelId('app.hearth.desktop');
  setupPermissions();
  createMain();
  if (serverOrigin) {
    createTray();
    // Global hotkeys work even while a game has focus.
    globalShortcut.register('CommandOrControl+Shift+M', () => send('desktop:toggle-mute'));
    globalShortcut.register('CommandOrControl+Shift+D', () => send('desktop:toggle-deafen'));
    setTimeout(checkForUpdate, 15 * 1000);
    setInterval(checkForUpdate, 4 * 3600 * 1000);
  }
});

app.on('before-quit', () => { quitting = true; });
app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', showMain);
