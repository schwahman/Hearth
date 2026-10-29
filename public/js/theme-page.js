// Applies the saved palette and Dark/Grey/Light choice on standalone pages.
try {
  const mode = localStorage.getItem('hearth_theme') || 'dark';
  const light = window.matchMedia('(prefers-color-scheme: light)').matches;
  document.documentElement.dataset.theme = mode === 'system' ? (light ? 'light' : 'dark') : mode;
  document.documentElement.dataset.palette = localStorage.getItem('hearth_palette') || 'phosphor';
} catch { /* defaults */ }
