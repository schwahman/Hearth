// A from-scratch WebSocket server (RFC 6455) on top of Node's raw sockets.
// Handles the HTTP upgrade handshake, frame parsing (including fragmented
// and masked frames), ping/pong keepalive and the close handshake.
'use strict';
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const OP = { CONT: 0x0, TEXT: 0x1, BINARY: 0x2, CLOSE: 0x8, PING: 0x9, PONG: 0xa };
const MAX_PAYLOAD = 1024 * 1024; // 1 MB per message; files go over HTTP
const PING_EVERY_MS = 25000;

class WebSocketConnection extends EventEmitter {
  constructor(socket, req) {
    super();
    this.socket = socket;
    this.req = req;
    this.open = true;
    this.buffer = Buffer.alloc(0);
    this.fragments = [];
    this.fragmentOp = 0;
    this.alive = true;

    socket.setNoDelay(true);
    socket.on('data', (chunk) => this._onData(chunk));
    socket.on('close', () => this._finish(1006, 'socket closed'));
    socket.on('error', () => this._finish(1006, 'socket error'));

    this.pinger = setInterval(() => {
      if (!this.alive) return this.terminate();
      this.alive = false;
      this._sendFrame(OP.PING, Buffer.alloc(0));
    }, PING_EVERY_MS);
  }

  send(data) {
    if (!this.open) return;
    const isText = typeof data === 'string';
    this._sendFrame(isText ? OP.TEXT : OP.BINARY, isText ? Buffer.from(data) : data);
  }

  sendJSON(obj) { this.send(JSON.stringify(obj)); }

  close(code = 1000, reason = '') {
    if (!this.open) return;
    const r = Buffer.from(reason).subarray(0, 123);
    const payload = Buffer.alloc(2 + r.length);
    payload.writeUInt16BE(code, 0);
    r.copy(payload, 2);
    this._sendFrame(OP.CLOSE, payload);
    this.socket.end();
    this._finish(code, reason);
  }

  terminate() {
    this.socket.destroy();
    this._finish(1006, 'terminated');
  }

  _finish(code, reason) {
    if (!this.open) return;
    this.open = false;
    clearInterval(this.pinger);
    this.emit('close', code, reason);
  }

  _sendFrame(opcode, payload) {
    if (this.socket.destroyed) return;
    const len = payload.length;
    let header;
    if (len < 126) {
      header = Buffer.alloc(2);
      header[1] = len;
    } else if (len < 65536) {
      header = Buffer.alloc(4);
      header[1] = 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }
    header[0] = 0x80 | opcode; // FIN + opcode; servers never mask
    this.socket.write(Buffer.concat([header, payload]));
  }

  _onData(chunk) {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    while (this.open) {
      const frame = this._parseFrame();
      if (!frame) break;
      this._handleFrame(frame);
    }
  }

  // Returns one complete frame from the buffer, or null if more bytes are needed.
  _parseFrame() {
    const b = this.buffer;
    if (b.length < 2) return null;
    const fin = (b[0] & 0x80) !== 0;
    const rsv = b[0] & 0x70;
    const opcode = b[0] & 0x0f;
    const masked = (b[1] & 0x80) !== 0;
    let len = b[1] & 0x7f;
    let offset = 2;

    if (rsv) { this.close(1002, 'reserved bits set'); return null; }
    if (!masked) { this.close(1002, 'client frames must be masked'); return null; }

    if (len === 126) {
      if (b.length < 4) return null;
      len = b.readUInt16BE(2);
      offset = 4;
    } else if (len === 127) {
      if (b.length < 10) return null;
      const big = b.readBigUInt64BE(2);
      if (big > BigInt(MAX_PAYLOAD)) { this.close(1009, 'message too big'); return null; }
      len = Number(big);
      offset = 10;
    }
    if (len > MAX_PAYLOAD) { this.close(1009, 'message too big'); return null; }
    if (b.length < offset + 4 + len) return null;

    const mask = b.subarray(offset, offset + 4);
    const payload = Buffer.from(b.subarray(offset + 4, offset + 4 + len));
    for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];

    this.buffer = b.subarray(offset + 4 + len);
    return { fin, opcode, payload };
  }

  _handleFrame({ fin, opcode, payload }) {
    switch (opcode) {
      case OP.TEXT:
      case OP.BINARY:
        if (this.fragments.length) return this.close(1002, 'expected continuation');
        if (fin) return this._deliver(opcode, payload);
        this.fragmentOp = opcode;
        this.fragments = [payload];
        return;
      case OP.CONT: {
        if (!this.fragments.length) return this.close(1002, 'unexpected continuation');
        this.fragments.push(payload);
        const total = this.fragments.reduce((n, f) => n + f.length, 0);
        if (total > MAX_PAYLOAD) return this.close(1009, 'message too big');
        if (fin) {
          const whole = Buffer.concat(this.fragments);
          this.fragments = [];
          this._deliver(this.fragmentOp, whole);
        }
        return;
      }
      case OP.PING:
        return this._sendFrame(OP.PONG, payload);
      case OP.PONG:
        this.alive = true;
        return;
      case OP.CLOSE: {
        const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
        return this.close(code === 1005 ? 1000 : code);
      }
      default:
        return this.close(1002, 'unknown opcode');
    }
  }

  _deliver(opcode, payload) {
    this.alive = true;
    this.emit('message', opcode === OP.TEXT ? payload.toString('utf8') : payload);
  }
}

// Attach to an http/https server. onConnection(ws, req) is called for each
// successful upgrade on the given path.
function attachWebSocketServer(httpServer, pathname, onConnection) {
  httpServer.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://x');
    const key = req.headers['sec-websocket-key'];
    const upgrade = (req.headers.upgrade || '').toLowerCase();
    if (url.pathname !== pathname || upgrade !== 'websocket' || !key ||
        req.headers['sec-websocket-version'] !== '13') {
      socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
      return;
    }
    const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`);
    const ws = new WebSocketConnection(socket, req);
    onConnection(ws, req);
    if (head && head.length) ws._onData(head);
  });
}

module.exports = { attachWebSocketServer, WebSocketConnection };
