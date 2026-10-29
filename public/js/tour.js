// Spotlight walkthrough: dims the page, highlights one part of the screen at
// a time, and explains it in a small card with Back / Next / Skip.
import { el } from './util.js';

export function startTour(steps, { onDone, onStepEnter } = {}) {
  const usable = steps.filter((s) => !s.when || s.when());
  if (!usable.length) return;
  let i = 0;
  const shade = el('div', { class: 'tour-shade' });
  const ring = el('div', { class: 'tour-ring' });
  const card = el('div', { class: 'tour-card', role: 'dialog', 'aria-live': 'polite' });
  const root = el('div', { class: 'tour' }, shade, ring, card);
  document.body.append(root);

  const finish = (completed) => {
    window.removeEventListener('resize', place);
    document.removeEventListener('keydown', keys);
    root.remove();
    onDone && onDone(completed);
  };
  const keys = (e) => {
    if (e.key === 'Escape') finish(false);
    if (e.key === 'ArrowRight' || e.key === 'Enter') { e.preventDefault(); go(1); }
    if (e.key === 'ArrowLeft') go(-1);
  };
  document.addEventListener('keydown', keys);
  window.addEventListener('resize', () => place());

  function target() {
    const s = usable[i];
    const t = typeof s.target === 'function' ? s.target() : s.target ? document.querySelector(s.target) : null;
    if (!t) return null;
    const r = t.getBoundingClientRect();
    return r.width && r.height ? r : null;
  }

  function place() {
    const r = target();
    const pad = 6;
    if (r) {
      ring.style.display = 'block';
      Object.assign(ring.style, { left: `${r.left - pad}px`, top: `${r.top - pad}px`, width: `${r.width + pad * 2}px`, height: `${r.height + pad * 2}px` });
      shade.classList.add('clear');
    } else {
      ring.style.display = 'none';
      shade.classList.remove('clear');
    }
    // Put the card beside the highlight where there's room, else centered.
    const vw = window.innerWidth; const vh = window.innerHeight;
    const cw = Math.min(340, vw - 24);
    card.style.width = `${cw}px`;
    const ch = card.offsetHeight;
    let left; let top;
    if (!r) { left = (vw - cw) / 2; top = (vh - ch) / 2; }
    else if (r.right + 16 + cw < vw) { left = r.right + 16; top = r.top; }
    else if (r.left - 16 - cw > 0) { left = r.left - 16 - cw; top = r.top; }
    else if (r.bottom + 16 + ch < vh) { left = r.left; top = r.bottom + 16; }
    else { left = r.left; top = r.top - 16 - ch; }
    card.style.left = `${Math.max(12, Math.min(left, vw - cw - 12))}px`;
    card.style.top = `${Math.max(12, Math.min(top, vh - ch - 12))}px`;
  }

  function render() {
    const s = usable[i];
    onStepEnter && onStepEnter(s);
    card.replaceChildren(...[
      el('div', { class: 'tour-step' }, `${i + 1} / ${usable.length}`),
      el('h3', {}, s.title),
      el('p', {}, s.text),
      s.tip ? el('p', { class: 'tour-tip' }, s.tip) : null,
      el('div', { class: 'tour-actions' },
        el('button', { class: 'btn', onclick: () => finish(false) }, i === usable.length - 1 ? 'Close' : 'Skip tour'),
        el('span', { class: 'spacer' }),
        i > 0 ? el('button', { class: 'btn', onclick: () => go(-1) }, 'Back') : null,
        el('button', { class: 'btn primary', onclick: () => go(1) }, i === usable.length - 1 ? (s.finishLabel || 'Done') : 'Next')),
    ].filter(Boolean));
    // Let layout settle (e.g. a menu sliding open) before measuring.
    requestAnimationFrame(() => setTimeout(place, s.delay || 0));
  }

  function go(d) {
    const next = i + d;
    if (next >= usable.length) {
      const last = usable[i];
      finish(true);
      if (last.onFinish) last.onFinish();
      return;
    }
    if (next < 0) return;
    i = next;
    render();
  }

  render();
}
