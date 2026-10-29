// Voice, video and screen sharing over WebRTC.
//
// Each pair of people in a call has one direct peer connection (a "mesh").
// The server only relays the setup messages (offer, answer, ICE candidates);
// the audio and video themselves go straight between browsers.
//
// Every peer connection carries three slots that never change:
//   0 = microphone, 1 = camera, 2 = screen share
// Turning the camera or screen on/off just swaps the track in that slot,
// so no renegotiation is needed.
const SLOT = { AUDIO: 0, CAM: 1, SCREEN: 2 };

export class Voice extends EventTarget {
  constructor(gateway) {
    super();
    this.gw = gateway;
    this.iceServers = [];
    this.sessionId = null;
    this.channelId = null;
    this.peers = new Map(); // sessionId -> peer
    this.mic = null;        // MediaStream
    this.cam = null;
    this.screen = null;
    this.muted = false;
    this.deafened = false;
    this.audioCtx = null;
    this.meters = new Map(); // key -> { analyser, data, userId }
    this.speaking = new Set();
    this.meterTimer = null;
  }

  get active() { return !!this.channelId; }

  async join(channelId) {
    if (this.channelId === channelId) return;
    if (this.channelId) this.leave();
    try {
      this.mic = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch (err) {
      throw new Error(window.isSecureContext
        ? 'Microphone access was blocked. Allow it in your browser and try again.'
        : 'Voice needs HTTPS (or localhost). See the README for enabling HTTPS.');
    }
    this.channelId = channelId;
    this.mic.getAudioTracks().forEach((t) => { t.enabled = !this.muted; });
    this.audioCtx = new AudioContext();
    this._meter('local', this.mic, null);
    this.meterTimer = setInterval(() => this._pollMeters(), 120);
    this.gw.send({ op: 'VOICE_JOIN', channelId, mute: this.muted, deaf: this.deafened });
    this._changed();
  }

  leave() {
    if (!this.channelId) return;
    this.gw.send({ op: 'VOICE_LEAVE' });
    this._teardown();
  }

  // Called when the server says we were moved out (joined elsewhere).
  forceLeave() { this._teardown(); }

  _teardown() {
    for (const id of [...this.peers.keys()]) this._closePeer(id);
    for (const s of [this.mic, this.cam, this.screen]) s && s.getTracks().forEach((t) => t.stop());
    this.mic = this.cam = this.screen = null;
    clearInterval(this.meterTimer);
    this.meters.clear();
    this.speaking.clear();
    if (this.audioCtx) this.audioCtx.close();
    this.audioCtx = null;
    this.channelId = null;
    this._changed();
  }

  setMuted(muted) {
    this.muted = muted;
    if (this.mic) this.mic.getAudioTracks().forEach((t) => { t.enabled = !muted && !this.deafened; });
    this._sendState();
  }

  setDeafened(deaf) {
    this.deafened = deaf;
    for (const p of this.peers.values()) if (p.audioEl) p.audioEl.muted = deaf;
    if (this.mic) this.mic.getAudioTracks().forEach((t) => { t.enabled = !this.muted && !deaf; });
    this._sendState();
  }

  async toggleCamera() {
    if (this.cam) {
      this.cam.getTracks().forEach((t) => t.stop());
      this.cam = null;
    } else {
      this.cam = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
      });
    }
    this._setSlotTrack(SLOT.CAM, this.cam ? this.cam.getVideoTracks()[0] : null);
    this._sendState();
  }

  async toggleScreen() {
    if (this.screen) {
      this._stopScreen();
      return;
    }
    if (!navigator.mediaDevices.getDisplayMedia) throw new Error('Screen sharing is not supported on this device.');
    this.screen = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 30 } }, audio: false });
    const track = this.screen.getVideoTracks()[0];
    track.contentHint = 'detail';
    track.onended = () => this._stopScreen();
    this._setSlotTrack(SLOT.SCREEN, track);
    this._sendState();
  }

  _stopScreen() {
    if (!this.screen) return;
    this.screen.getTracks().forEach((t) => t.stop());
    this.screen = null;
    this._setSlotTrack(SLOT.SCREEN, null);
    this._sendState();
  }

  _sendState() {
    if (!this.channelId) return;
    this.gw.send({ op: 'VOICE_STATE', mute: this.muted, deaf: this.deafened, video: !!this.cam, screen: !!this.screen });
    this._changed();
  }

  _setSlotTrack(slot, track) {
    for (const p of this.peers.values()) {
      const t = p.pc.getTransceivers()[slot];
      if (t) t.sender.replaceTrack(track).catch(() => {});
    }
    this._changed();
  }

  _localTrack(slot) {
    if (slot === SLOT.AUDIO) return this.mic ? this.mic.getAudioTracks()[0] : null;
    if (slot === SLOT.CAM) return this.cam ? this.cam.getVideoTracks()[0] : null;
    if (slot === SLOT.SCREEN) return this.screen ? this.screen.getVideoTracks()[0] : null;
    return null;
  }

  // The app calls this whenever the list of people in our channel changes.
  sync(states) {
    if (!this.channelId) return;
    const present = new Set();
    for (const s of states) {
      if (s.sessionId === this.sessionId) continue;
      present.add(s.sessionId);
      if (!this.peers.has(s.sessionId)) this._createPeer(s.sessionId, s.userId);
    }
    for (const id of [...this.peers.keys()]) if (!present.has(id)) this._closePeer(id);
  }

  _createPeer(sessionId, userId) {
    const initiator = this.sessionId < sessionId; // exactly one side starts
    const pc = new RTCPeerConnection({ iceServers: this.iceServers });
    const peer = {
      pc, userId, initiator, pendingIce: [],
      streams: [new MediaStream(), new MediaStream(), new MediaStream()],
      audioEl: null,
    };
    this.peers.set(sessionId, peer);

    pc.onicecandidate = (e) => {
      if (e.candidate) this._signal(sessionId, { type: 'candidate', candidate: e.candidate.toJSON() });
    };
    pc.ontrack = (e) => {
      const slot = pc.getTransceivers().indexOf(e.transceiver);
      if (slot < 0) return;
      const stream = new MediaStream([e.track]);
      peer.streams[slot] = stream;
      if (slot === SLOT.AUDIO) {
        if (!peer.audioEl) {
          peer.audioEl = document.createElement('audio');
          peer.audioEl.autoplay = true;
          document.getElementById('audio-sinks').appendChild(peer.audioEl);
        }
        peer.audioEl.srcObject = stream;
        peer.audioEl.muted = this.deafened;
        peer.audioEl.play().catch(() => {});
        this._meter(sessionId, stream, userId);
      }
      e.track.onunmute = () => this._changed();
      this._changed();
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed' && initiator) pc.restartIce();
      this._changed();
    };

    if (initiator) {
      pc.addTransceiver(this._localTrack(SLOT.AUDIO) || 'audio', { direction: 'sendrecv' });
      pc.addTransceiver('video', { direction: 'sendrecv' });
      pc.addTransceiver('video', { direction: 'sendrecv' });
      const tx = pc.getTransceivers();
      for (const slot of [SLOT.CAM, SLOT.SCREEN]) {
        const track = this._localTrack(slot);
        if (track) tx[slot].sender.replaceTrack(track);
      }
      pc.onnegotiationneeded = async () => {
        try {
          await pc.setLocalDescription(await pc.createOffer());
          this._signal(sessionId, { type: 'offer', sdp: pc.localDescription.sdp });
        } catch (err) { console.warn('offer failed', err); }
      };
    }
    return peer;
  }

  async handleSignal({ fromSession, fromUser, data }) {
    if (!this.channelId) return;
    let peer = this.peers.get(fromSession) || this._createPeer(fromSession, fromUser);
    const pc = peer.pc;
    try {
      if (data.type === 'offer') {
        await pc.setRemoteDescription({ type: 'offer', sdp: data.sdp });
        pc.getTransceivers().forEach((t, slot) => {
          t.direction = 'sendrecv';
          t.sender.replaceTrack(this._localTrack(slot)).catch(() => {});
        });
        await pc.setLocalDescription(await pc.createAnswer());
        this._signal(fromSession, { type: 'answer', sdp: pc.localDescription.sdp });
        await this._flushIce(peer);
      } else if (data.type === 'answer') {
        await pc.setRemoteDescription({ type: 'answer', sdp: data.sdp });
        await this._flushIce(peer);
      } else if (data.type === 'candidate') {
        if (pc.remoteDescription) await pc.addIceCandidate(data.candidate);
        else peer.pendingIce.push(data.candidate);
      }
    } catch (err) {
      console.warn('signal error', err);
    }
  }

  async _flushIce(peer) {
    const list = peer.pendingIce.splice(0);
    for (const c of list) { try { await peer.pc.addIceCandidate(c); } catch { /* stale */ } }
  }

  _signal(toSession, data) {
    this.gw.send({ op: 'VOICE_SIGNAL', toSession, data });
  }

  _closePeer(sessionId) {
    const p = this.peers.get(sessionId);
    if (!p) return;
    p.pc.close();
    if (p.audioEl) p.audioEl.remove();
    this.meters.delete(sessionId);
    this.peers.delete(sessionId);
    this._changed();
  }

  // Remote video stream for a user's camera or screen, if any.
  remoteStream(sessionId, kind) {
    const p = this.peers.get(sessionId);
    if (!p) return null;
    return p.streams[kind === 'screen' ? SLOT.SCREEN : SLOT.CAM];
  }

  // ---- speaking indicator ----
  _meter(key, stream, userId) {
    if (!this.audioCtx || !stream.getAudioTracks().length) return;
    const src = this.audioCtx.createMediaStreamSource(stream);
    const analyser = this.audioCtx.createAnalyser();
    analyser.fftSize = 512;
    src.connect(analyser);
    this.meters.set(key, { analyser, data: new Uint8Array(analyser.fftSize), userId });
  }

  _pollMeters() {
    const now = new Set();
    for (const [key, m] of this.meters) {
      m.analyser.getByteTimeDomainData(m.data);
      let sum = 0;
      for (const v of m.data) { const x = (v - 128) / 128; sum += x * x; }
      const rms = Math.sqrt(sum / m.data.length);
      const muted = key === 'local' && (this.muted || this.deafened);
      if (rms > 0.02 && !muted) now.add(key === 'local' ? 'me' : m.userId);
    }
    const changed = now.size !== this.speaking.size || [...now].some((k) => !this.speaking.has(k));
    if (changed) {
      this.speaking = now;
      this.dispatchEvent(new CustomEvent('speaking', { detail: now }));
    }
  }

  _changed() { this.dispatchEvent(new Event('change')); }
}
