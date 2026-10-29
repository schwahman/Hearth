let sources = [];
let kind = 'window';
let selected = null;
const grid = document.getElementById('grid');
const go = document.getElementById('go');

function draw() {
  grid.replaceChildren();
  for (const s of sources.filter((x) => x.kind === kind)) {
    const card = document.createElement('div');
    card.className = 'src' + (selected === s.id ? ' sel' : '');
    const t = document.createElement('img'); t.className = 't'; t.src = s.thumb; t.alt = '';
    const n = document.createElement('div'); n.className = 'n';
    if (s.icon) { const i = document.createElement('img'); i.src = s.icon; i.alt = ''; n.append(i); }
    n.append(document.createTextNode(s.name));
    card.append(t, n);
    card.onclick = () => { selected = s.id; go.disabled = false; draw(); };
    card.ondblclick = () => window.picker.choose(s.id, document.getElementById('audio').checked);
    grid.append(card);
  }
}

window.picker.onSources(({ list, canAudio }) => {
  sources = list;
  if (!canAudio) document.getElementById('audioWrap').style.visibility = 'hidden';
  if (!sources.some((s) => s.kind === 'window')) kind = 'screen';
  document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('on', b.dataset.k === kind));
  draw();
});
document.querySelectorAll('.tab').forEach((b) => { b.onclick = () => { kind = b.dataset.k; document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('on', x === b)); draw(); }; });
go.onclick = () => window.picker.choose(selected, document.getElementById('audio').checked);
document.getElementById('cancel').onclick = () => window.picker.choose(null);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') window.picker.choose(null); });
