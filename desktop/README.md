# Hearth desktop app

A secure window around a Hearth server with desktop extras:

- Tray icon; closing the window keeps Hearth running in the tray
- Global hotkeys that work inside games: **Ctrl+Shift+M** mute, **Ctrl+Shift+D** deafen
- Screen/window picker with **game audio** (Windows)
- Unread count on the taskbar, flashing for DMs and @mentions, desktop notifications
- Launch at sign-in (tray menu), server picker on first run

Security follows Electron's checklist: sandboxed renderer, context isolation,
no Node.js in the page, navigation locked to the chosen server, and only that
server may use the microphone, camera and screen capture.

## Build

```
cd desktop
npm install
npm run dist:win     # Windows installer -> dist/Hearth-Setup-<version>.exe
npm start            # run without installing
```

Building the Windows installer on Linux needs `wine` (64- and 32-bit).
Unsigned builds show a Windows SmartScreen warning; a code-signing
certificate removes it.
