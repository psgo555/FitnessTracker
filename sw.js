// 離線快取：頁面先試網路（3 秒逾時就用快取，健身房訊號差也能開），其他檔案先用快取
const CACHE = 'fitlog-v3';
const ASSETS = ['./', 'index.html', 'app.js', 'coach.js', 'manifest.webmanifest', 'icon.svg', 'icon-192.png', 'icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
function fromNetwork(req) {
  return fetch(req).then(res => {
    if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
    return res;
  });
}
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  if (req.mode === 'navigate') {
    e.respondWith(new Promise(resolve => {
      let done = false;
      const fallback = () => caches.match(req).then(hit => hit || caches.match('index.html'));
      const timer = setTimeout(() => fallback().then(hit => { if (hit && !done) { done = true; resolve(hit); } }), 3000);
      fromNetwork(req).then(res => { clearTimeout(timer); if (!done) { done = true; resolve(res); } })
        .catch(() => { clearTimeout(timer); if (!done) { done = true; fallback().then(resolve); } });
    }));
    return;
  }
  e.respondWith(caches.match(req).then(hit => hit || fromNetwork(req)));
});
