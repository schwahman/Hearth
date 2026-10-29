// Tiny 8-bit sound effects, synthesized on the fly (no audio files, all
// original). People can turn them off in their profile.
let ctx = null;
const enabled = () => { try { return localStorage.getItem('hearth_sfx') !== 'off'; } catch { return true; } };

const SOUNDS = {
  join:    [[523, .07], [659, .07], [784, .12]],   // C E G up
  leave:   [[784, .07], [659, .07], [523, .12]],   // G E C down
  peerIn:  [[659, .06], [880, .09]],
  peerOut: [[880, .06], [659, .09]],
  mute:    [[330, .06]],
  unmute:  [[660, .06]],
  ping:    [[988, .05], [1319, .1]],               // mention / DM
};

export function play(name) {
  if (!enabled() || !SOUNDS[name]) return;
  try {
    ctx = ctx || new AudioContext();
    if (ctx.state === 'suspended') ctx.resume();
    let t = ctx.currentTime + 0.01;
    for (const [freq, dur] of SOUNDS[name]) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'square';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(0.05, t + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t);
      osc.stop(t + dur + 0.02);
      t += dur;
    }
  } catch { /* audio not available */ }
}

export function setEnabled(on) {
  try { localStorage.setItem('hearth_sfx', on ? 'on' : 'off'); } catch { /* ignore */ }
}
export { enabled };
