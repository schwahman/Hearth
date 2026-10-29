// Applies the saved Dark/Grey/Light choice on standalone pages (privacy, terms).
try {
  const pref = localStorage.getItem('hearth_theme') || 'dark';
  const light = window.matchMedia('(prefers-color-scheme: light)').matches;
  document.documentElement.dataset.theme = pref === 'system' ? (light ? 'light' : 'dark') : pref;
} catch { /* default dark */ }
