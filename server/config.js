// All settings come from environment variables with sensible defaults.
'use strict';
const path = require('node:path');

const root = path.join(__dirname, '..');

module.exports = {
  port: Number(process.env.PORT || 8080),
  host: process.env.HOST || '0.0.0.0',
  dataDir: process.env.DATA_DIR || path.join(root, 'data'),
  publicDir: path.join(root, 'public'),
  // Unique per server process. Each node in a cluster needs a different one
  // (0-1023) so generated IDs never collide.
  nodeId: Number(process.env.NODE_ID || 0),
  maxUploadBytes: Number(process.env.MAX_UPLOAD_MB || 25) * 1024 * 1024,
  maxMessageLength: 4000,
  // Optional HTTPS. Browsers only allow microphone/camera on https:// or
  // localhost, so set these when people connect from other machines.
  tlsCert: process.env.TLS_CERT || '',
  tlsKey: process.env.TLS_KEY || '',
  // Or a single .pfx file (what Windows certificate tools export).
  tlsPfx: process.env.TLS_PFX || '',
  tlsPfxPass: process.env.TLS_PFX_PASS || '',
  // ICE servers handed to clients for voice/video. Empty works on a LAN.
  // For callers across the internet, point this at a STUN/TURN server.
  iceServers: process.env.ICE_SERVERS ? JSON.parse(process.env.ICE_SERVERS) : [],
  // Set to "false" to stop new people signing up (invite-only community).
  openRegistration: process.env.OPEN_REGISTRATION !== 'false',
};
