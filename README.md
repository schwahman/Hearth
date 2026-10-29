# Hearth

A self-hosted chat platform: servers, text and voice channels, roles and permissions, invites, DMs, file sharing, reactions, replies, voice, video and screen sharing.

Written from scratch. **Zero third-party packages**: the server uses only what ships with Node.js (HTTP, crypto, built-in SQLite), and the client is plain JavaScript using the browser's built-in WebRTC. The WebSocket protocol, event bus, permission system, ID generator and voice signaling are all hand-written in this repo.

"Hearth" is a working name. Rename it anywhere you like.

---

## Run it

Requires **Node.js 22.13 or newer**, and nothing else.

```
cd hearth
npm start
```

Open http://localhost:8080, register, and create a server. The first person to register is just a normal user; whoever creates a server owns it.

Run the test suite (starts a throwaway server and drives two fake users through everything):

```
npm test
```

### On a Windows Server / Hyper-V VM

```powershell
winget install OpenJS.NodeJS.LTS      # or install Node 22+ from nodejs.org
cd C:\Hearth
$env:PORT = "8080"
npm start
```

To run it as a Windows service, use Task Scheduler ("At startup", run `node C:\Hearth\server\index.js`, "Run whether user is logged on or not"), or any service wrapper you already use.

### On a Linux VM (systemd)

```ini
# /etc/systemd/system/hearth.service
[Service]
WorkingDirectory=/opt/hearth
ExecStart=/usr/bin/node --no-warnings server/index.js
Environment=PORT=8080
Restart=always
User=hearth
[Install]
WantedBy=multi-user.target
```

---

## HTTPS (needed for voice/video from other computers)

Browsers only allow the microphone and camera on `https://` pages or on `localhost`. Text chat works over plain HTTP; voice and video need HTTPS once anyone connects from another machine.

**Option A: certificate files**
```
TLS_CERT=/path/fullchain.pem TLS_KEY=/path/privkey.pem npm start
```

**Option B: a Windows .pfx** (e.g. exported from your internal CA, or a self-signed one for testing):
```powershell
$cert = New-SelfSignedCertificate -DnsName "chat.yourdomain.com" -CertStoreLocation Cert:\LocalMachine\My
$pw = ConvertTo-SecureString "changeme" -AsPlainText -Force
Export-PfxCertificate -Cert $cert -FilePath C:\Hearth\cert.pfx -Password $pw
$env:TLS_PFX = "C:\Hearth\cert.pfx"; $env:TLS_PFX_PASS = "changeme"; $env:PORT = "443"
npm start
```
Self-signed certificates show a browser warning; a real certificate (internal CA or public) avoids it.

**Option C: a reverse proxy or tunnel** that terminates HTTPS in front of Hearth (IIS ARR, Cloudflare Tunnel, etc.). Make sure it passes WebSocket upgrades on `/gateway`.

---

## Settings

All optional, set as environment variables.

| Variable | Default | What it does |
|---|---|---|
| `PORT` | `8080` | Port to listen on |
| `HOST` | `0.0.0.0` | Interface to bind |
| `DATA_DIR` | `./data` | Database and uploaded files |
| `MAX_UPLOAD_MB` | `25` | Largest file people can upload |
| `OPEN_REGISTRATION` | `true` | Set `false` to stop new sign-ups once you've created your accounts |
| `TLS_CERT` / `TLS_KEY` | | PEM certificate and key for HTTPS |
| `TLS_PFX` / `TLS_PFX_PASS` | | Or a .pfx file and its password |
| `ICE_SERVERS` | `[]` | JSON list of STUN/TURN servers for voice (see below) |
| `NODE_ID` | `0` | Unique number per node when running several (0–1023) |
| `BUS_HUB` | | `host:port` of the event hub when running several nodes |

**Back up** the `DATA_DIR` folder. That's everything: accounts, servers, messages and files.

---

## Voice and video: what works today

- **On your LAN / VPN:** works out of the box. Calls are peer-to-peer, so audio and video go directly between people's computers and never touch the server.
- **Over the internet:** people behind home routers usually need a STUN server to find each other, and some need a TURN relay. Set `ICE_SERVERS`, e.g. `[{"urls":"stun:your-stun-host:3478"}]`. Building our own STUN/TURN server is on the roadmap.
- **Call size:** each person sends their stream to every other person ("mesh"). That's great up to about **6–8 people with cameras**, or more with audio only. Bigger calls need a relay server (an SFU), which is the next big piece to build (see roadmap).

---

## Scaling

**One node** handles a lot: hundreds of simultaneous users is comfortable on a modest VM.

**Several nodes:** run the event hub once, then start each node pointing at it with its own `NODE_ID` and port. Put a load balancer in front (sticky sessions not required).

```
HUB_PORT=7070 npm run hub
PORT=8081 NODE_ID=1 BUS_HUB=127.0.0.1:7070 npm start
PORT=8082 NODE_ID=2 BUS_HUB=127.0.0.1:7070 npm start
```

A message posted on node 1 reaches people connected to node 2 instantly. Nodes on the **same machine** can share one `DATA_DIR`. Nodes on **different machines** need a shared database; the next step for that is a database server (all queries live in `server/db.js`, so it's a contained swap). Keep the hub on a private network: it has no authentication.

---

## How it fits together

```
browser ── HTTPS ──▶ REST API (server/api.js) ──▶ SQLite (server/db.js)
   │                        │
   │                        └─ publishes events ─▶ event bus (server/bus.js) ◀─▶ hub (other nodes)
   │                                                     │
   └── WebSocket ──▶ gateway (server/gateway.js) ◀───────┘   pushes events to the right people
   │
   └── WebRTC (peer-to-peer audio/video; gateway relays the setup messages)
```

| File | Purpose |
|---|---|
| `server/websocket.js` | WebSocket protocol (RFC 6455) from scratch: handshake, frames, ping/pong |
| `server/gateway.js` | Live connection per user: login, initial state, presence, typing, voice state, call signaling |
| `server/api.js` | Every action: accounts, servers, channels, messages, invites, roles, uploads |
| `server/permissions.js` | Permission flags and how roles combine |
| `server/bus.js`, `server/hub.js` | Event delivery within a node and between nodes |
| `server/ids.js` | Time-sortable unique IDs that work across nodes |
| `public/js/voice.js` | WebRTC calls, camera, screen share, speaking detection |
| `public/js/app.js` | The whole web interface |

---

## Roadmap

1. **Own STUN/TURN server** so calls connect across the internet without any outside service
2. **SFU (media relay)** for large voice/video channels (20+ people with cameras)
3. **Desktop app** wrapping the web client, with push-to-talk and global hotkeys
4. **Per-channel permission overrides** (private channels, read-only announcements)
5. Message search, pinned messages, threads, @mentions with notifications, custom emoji
6. **Multi-machine database** for full horizontal scaling
7. **Mobile apps**
8. Optional end-to-end encryption for DMs
