// 앱 화면 파일을 캐시해 오프라인에서도 열리게 한다.
// 네트워크 우선: 새 버전이 있으면 바로 받고, 연결이 없을 때만 캐시를 쓴다.
const CACHE = 'shtodo-v7';
const SHELL = [
  './',
  './index.html',
  './css/style.css',
  './js/app.js',
  './js/util.js',
  './js/config.js',
  './js/holidays.js',
  './js/store-local.js',
  './js/store-supabase.js',
  './manifest.webmanifest',
  './icons/icon.svg',
  './icons/icon-192.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return; // Supabase 요청은 건드리지 않음
  // 브라우저 HTTP 캐시에 남은 옛 파일 대신 항상 서버에 최신 여부를 확인한다
  const req = e.request.mode === 'navigate' ? e.request : new Request(e.request, { cache: 'no-cache' });
  e.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
        return res;
      })
      .catch(() => caches.match(e.request).then((r) => r || caches.match('./index.html'))),
  );
});

// ---- 푸시 알림: 친구가 할 일을 완료했을 때 ----
self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { body: e.data?.text() }; }
  e.waitUntil(self.registration.showNotification(d.title || '공유 투두', {
    body: d.body || '',
    tag: d.tag,
    icon: 'icons/icon-192.png',
    badge: 'icons/icon-192.png',
    data: { url: self.registration.scope },
  }));
});

// 알림을 누르면 열려 있는 앱 창으로 가고, 없으면 새로 연다
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = e.notification.data?.url || self.registration.scope;
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
    const win = list.find((w) => w.url.startsWith(self.registration.scope));
    return win ? win.focus() : self.clients.openWindow(url);
  }));
});
