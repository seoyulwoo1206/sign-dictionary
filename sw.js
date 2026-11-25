// 서비스 워커: 수달이 공부 알림(웹 푸시)을 받아서 보여 준다.
// 화면 파일은 저장(캐시)하지 않는다 — 사이트를 고치면 바로 새 버전이 보이게.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { body: e.data ? e.data.text() : '' }; }
  const url = new URL(d.url || './#/', self.registration.scope).href;
  e.waitUntil(self.registration.showNotification(d.title || '수달이가 기다려요 🦦', {
    body: d.body || '오늘 수어 한 단어 배워 볼까요?',
    icon: new URL('icons/icon-192.png', self.registration.scope).href,
    badge: new URL('icons/badge-96.png', self.registration.scope).href,
    tag: 'daily-reminder',
    renotify: true,
    lang: 'ko',
    data: { url },
  }));
});

// 알림을 누르면 열려 있는 창으로 가거나 새로 연다
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = e.notification.data?.url || self.registration.scope;
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const w of wins) {
      if (w.url.startsWith(self.registration.scope)) {
        await w.focus();
        if ('navigate' in w) { try { await w.navigate(url); } catch { /* 다른 출처면 무시 */ } }
        return;
      }
    }
    await self.clients.openWindow(url);
  })());
});
