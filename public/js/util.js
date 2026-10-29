// DOM and formatting helpers.

// el('div', { class: 'x', onclick: fn }, child, 'text', ...)
export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (k === 'class') node.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
    else if (k === 'html') node.innerHTML = v;
    else if (v === true) node.setAttribute(k, '');
    else node.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

export const $ = (id) => document.getElementById(id);

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Minimal, safe markdown: ```code```, `code`, **bold**, *italic*, ~~strike~~, links.
export function renderMarkdown(text) {
  const blocks = [];
  let s = escapeHtml(text);
  s = s.replace(/```(?:[a-zA-Z0-9]*\n)?([\s\S]*?)```/g, (_, code) => {
    blocks.push(`<pre><code>${code.replace(/^\n+|\n+$/g, '')}</code></pre>`);
    return `\u0000${blocks.length - 1}\u0000`;
  });
  s = s.replace(/`([^`\n]+)`/g, (_, code) => {
    blocks.push(`<code>${code}</code>`);
    return `\u0000${blocks.length - 1}\u0000`;
  });
  s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/~~([^~\n]+)~~/g, '<del>$1</del>')
    .replace(/\bhttps?:\/\/[^\s<]+[^\s<.,;:!?)\]'"]/g, (url) =>
      `<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`);
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => blocks[Number(i)]);
}

export function initials(name) {
  return (name || '?').trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
}

// Stable color per user id.
export function colorFor(id) {
  const palette = ['#c2410c', '#b45309', '#4d7c0f', '#0f766e', '#1d4ed8', '#7c3aed', '#be185d', '#9f1239'];
  let h = 0;
  for (const ch of String(id)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return palette[h % palette.length];
}

export function fmtTime(ts) {
  const d = new Date(ts);
  const now = new Date();
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (d.toDateString() === now.toDateString()) return `Today at ${time}`;
  const y = new Date(now); y.setDate(now.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return `Yesterday at ${time}`;
  return `${d.toLocaleDateString()} ${time}`;
}

export function fmtDay(ts) {
  return new Date(ts).toLocaleDateString([], { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
}

export function fmtSize(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

let toastTimer;
export function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 3200);
}

// Opens a modal; returns { root, close }.
export function modal(content, { wide = false, onClose } = {}) {
  const box = el('div', { class: 'modal' + (wide ? ' wide' : ''), role: 'dialog' }, content);
  const backdrop = el('div', { class: 'modal-backdrop' }, box);
  const close = () => { backdrop.remove(); document.removeEventListener('keydown', esc); onClose && onClose(); };
  const esc = (e) => { if (e.key === 'Escape') close(); };
  backdrop.addEventListener('mousedown', (e) => { if (e.target === backdrop) close(); });
  document.addEventListener('keydown', esc);
  $('modal-root').append(backdrop);
  const first = box.querySelector('input, textarea, select');
  if (first) setTimeout(() => first.focus(), 30);
  return { root: box, close };
}

export function confirmDialog(title, text, okLabel = 'Confirm') {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; m.close(); resolve(v); } };
    const m = modal([
      el('h2', {}, title),
      el('p', { class: 'muted' }, text),
      el('div', { class: 'row' },
        el('button', { class: 'btn', onclick: () => finish(false) }, 'Cancel'),
        el('button', { class: 'btn danger', onclick: () => finish(true) }, okLabel)),
    ], { onClose: () => { if (!done) { done = true; resolve(false); } } });
  });
}
