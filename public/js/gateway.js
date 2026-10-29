// Keeps the WebSocket connection to the server alive and reconnects with
// backoff if it drops.
export class Gateway extends EventTarget {
  constructor(getToken) {
    super();
    this.getToken = getToken;
    this.ws = null;
    this.retry = 0;
    this.stopped = false;
    this.heartbeat = null;
  }

  connect() {
    this.stopped = false;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/gateway`);
    this.ws = ws;
    ws.onopen = () => {
      ws.send(JSON.stringify({ op: 'IDENTIFY', token: this.getToken() }));
      clearInterval(this.heartbeat);
      this.heartbeat = setInterval(() => this.send({ op: 'HEARTBEAT' }), 30000);
    };
    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      if (msg.t === 'READY') this.retry = 0;
      this.dispatchEvent(new CustomEvent(msg.t, { detail: msg.d }));
      this.dispatchEvent(new CustomEvent('*', { detail: msg }));
    };
    ws.onclose = (e) => {
      clearInterval(this.heartbeat);
      this.dispatchEvent(new CustomEvent('DISCONNECTED', { detail: { code: e.code } }));
      if (e.code === 4004) { this.dispatchEvent(new CustomEvent('INVALID_SESSION')); return; }
      if (this.stopped) return;
      const delay = Math.min(15000, 500 * 2 ** this.retry++);
      setTimeout(() => this.connect(), delay);
    };
  }

  send(obj) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj));
  }

  close() {
    this.stopped = true;
    if (this.ws) this.ws.close();
  }

  on(type, fn) { this.addEventListener(type, (e) => fn(e.detail)); }
}
