const q = new URLSearchParams(location.search);
if (q.get('server')) document.getElementById('msg').textContent = `${q.get('server')} didn't respond. Check your internet connection or try again in a moment.`;
document.getElementById('retry').onclick = () => window.hearthDesktop.retry();
document.getElementById('change').onclick = () => window.hearthDesktop.changeServer();
let tries = 0;
setInterval(() => { if (navigator.onLine && ++tries <= 20) window.hearthDesktop.retry(); }, 15000);
