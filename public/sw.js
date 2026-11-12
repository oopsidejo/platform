// خدمة تطبيق لوحة التحكم: الشبكة أولاً (البيانات دايماً محدّثة)، وصفحة بديلة إذا انقطع النت
const C = 'admin-v1';
self.addEventListener('install', e => { e.waitUntil(caches.open(C).then(c => c.addAll(['/icons/icon-192.png'])).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(k => Promise.all(k.filter(x => x !== C).map(x => caches.delete(x)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', e => {
  const r = e.request; if (r.method !== 'GET' || r.mode !== 'navigate') return;
  e.respondWith(fetch(r).then(res => { const cp = res.clone(); caches.open(C).then(c => c.put('/admin', cp)); return res; })
    .catch(() => caches.match('/admin').then(m => m || new Response('<meta charset="utf-8"><body dir="rtl" style="font-family:sans-serif;text-align:center;padding-top:30vh">ما في إنترنت حالياً — جرّب بعد شوي</body>', { headers: { 'content-type': 'text/html; charset=utf-8' } }))));
});
