// Event bus. Everything that happens (new message, someone joins voice,
// etc.) is published here on a topic like "server:123" or "user:456", and
// the gateway delivers it to the right connected clients.
//
// Single node: events stay in memory.
// Multiple nodes: set BUS_HUB=host:port and run `node server/hub.js`. Every
// node connects to the hub, and the hub relays events between them, so a
// message posted on node A reaches users connected to node B.
'use strict';
const net = require('node:net');
const { EventEmitter } = require('node:events');
const { randomCode } = require('./ids');

class Bus extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(0);
    this.nodeTag = randomCode(6);
    this.hub = null;
    const target = process.env.BUS_HUB;
    if (target) this._connect(target);
  }

  // Deliver locally right away, then forward to other nodes.
  publish(topic, event) {
    this.emit('event', topic, event);
    if (this.hub && !this.hub.destroyed) {
      this.hub.write(JSON.stringify({ from: this.nodeTag, topic, event }) + '\n');
    }
  }

  _connect(target) {
    const [host, port] = target.split(':');
    const sock = net.connect(Number(port), host);
    let pending = '';
    sock.setEncoding('utf8');
    sock.on('connect', () => console.log(`[bus] connected to hub ${target}`));
    sock.on('data', (chunk) => {
      pending += chunk;
      let nl;
      while ((nl = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, nl);
        pending = pending.slice(nl + 1);
        try {
          const { from, topic, event } = JSON.parse(line);
          if (from !== this.nodeTag) this.emit('event', topic, event);
        } catch { /* ignore malformed line */ }
      }
    });
    sock.on('error', () => {});
    sock.on('close', () => {
      console.log('[bus] hub connection lost, retrying in 2s');
      this.hub = null;
      setTimeout(() => this._connect(target), 2000);
    });
    this.hub = sock;
  }
}

module.exports = new Bus();
