document.getElementById('f').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = document.getElementById('go');
  const err = document.getElementById('err');
  btn.disabled = true; btn.textContent = 'Connecting…'; err.textContent = '';
  const res = await window.setup.save(document.getElementById('url').value.trim());
  if (res && res.error) { err.textContent = res.error; btn.disabled = false; btn.textContent = 'Connect'; }
});
