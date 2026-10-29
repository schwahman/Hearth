// Event hub for running more than one Hearth node. Each node connects here
// over TCP and sends one JSON event per line; the hub relays every line to
// all the other nodes. Keep it on a private network: it has no auth.
//
//   HUB_PORT=7070 node server/hub.js
'use strict';
const net = require('node:net');

const port = Number(process.env.HUB_PORT || 7070);
const host = process.env.HUB_HOST || '127.0.0.1';
const nodes = new Set();

net.createServer((sock) => {
  nodes.add(sock);
  console.log(`[hub] node connected (${nodes.size} total)`);
  let pending = '';
  sock.setEncoding('utf8');
  sock.on('data', (chunk) => {
    pending += chunk;
    let nl;
    while ((nl = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, nl + 1);
      pending = pending.slice(nl + 1);
      for (const other of nodes) if (other !== sock) other.write(line);
    }
  });
  const drop = () => { nodes.delete(sock); };
  sock.on('close', drop);
  sock.on('error', drop);
}).listen(port, host, () => console.log(`[hub] listening on ${host}:${port}`));
