// Altius Chat Service Worker — handles background push notifications
const CACHE = 'altius-chat-v1';

self.addEventListener('install', e => {
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(clients.claim());
});

// Handle push events (when server sends a push)
self.addEventListener('push', e => {
  if (!e.data) return;
  try {
    const data = e.data.json();
    e.waitUntil(
      self.registration.showNotification(data.title || 'Altius Chat', {
        body: data.body || 'You have a new message',
        icon: data.icon || '/icon.png',
        badge: data.badge || '/icon.png',
        tag: data.tag || 'altius-msg',
        renotify: true,
        data: { convKey: data.convKey, url: data.url || '/' },
        actions: [{ action: 'open', title: 'Open' }],
        vibrate: [200, 100, 200],
      })
    );
  } catch(e) {}
});

// Handle notification click
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const convKey = e.notification.data?.convKey;
  const url = e.notification.data?.url || '/';
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      // If app is already open, focus it and navigate
      for (const client of list) {
        if (client.url.includes(self.location.origin)) {
          client.focus();
          client.postMessage({ type: 'OPEN_CONV', convKey });
          return;
        }
      }
      // App is closed — open it
      return clients.openWindow(url + (convKey ? '#conv=' + convKey : ''));
    })
  );
});

// Background sync — poll Supabase for new messages when app is closed
self.addEventListener('message', e => {
  if (e.data?.type === 'INIT_BG_POLL') {
    const { sbUrl, sbKey, userId, convKeys, lastTs } = e.data;
    startBgPoll(sbUrl, sbKey, userId, convKeys, lastTs);
  }
});

let bgPollInterval = null;

function startBgPoll(sbUrl, sbKey, userId, convKeys, lastTs) {
  if (bgPollInterval) clearInterval(bgPollInterval);
  // Poll every 15 seconds when app is in background
  bgPollInterval = setInterval(() => {
    checkNewMessages(sbUrl, sbKey, userId, convKeys, lastTs);
  }, 15000);
}

async function checkNewMessages(sbUrl, sbKey, userId, convKeys, lastTs) {
  if (!convKeys || !convKeys.length) return;
  try {
    const keyList = convKeys.map(k => '"' + k + '"').join(',');
    const since = lastTs || new Date(Date.now() - 60000).toISOString();
    const url = sbUrl + '/rest/v1/messages?conv_key=in.(' + keyList +
      ')&sender_id=neq.' + userId +
      '&created_at=gt.' + encodeURIComponent(since) +
      '&order=created_at.desc&limit=5';
    const r = await fetch(url, {
      headers: { 'apikey': sbKey, 'Authorization': 'Bearer ' + sbKey }
    });
    if (!r.ok) return;
    const msgs = await r.json();
    if (!msgs || !msgs.length) return;

    // Check if app is currently visible
    const allClients = await clients.matchAll({ type: 'window', includeUncontrolled: true });
    const appVisible = allClients.some(c => !c.hidden);
    if (appVisible) return; // App is open — don't notify

    // Group by conv_key — show one notification per conv
    const byConv = {};
    msgs.forEach(m => {
      if (!byConv[m.conv_key]) byConv[m.conv_key] = m;
    });

    for (const [ck, m] of Object.entries(byConv)) {
      const senderName = m.sender_id;
      const isGroup = ck.startsWith('g_');
      const title = isGroup ? 'Group: ' + ck.replace('g_','') : senderName;
      const body = m.content || '📎 Sent a file';
      const icon = 'data:image/svg+xml,' + encodeURIComponent(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">' +
        '<rect width="64" height="64" rx="16" fill="#e8a045"/>' +
        '<text x="32" y="44" font-size="30" text-anchor="middle" ' +
        'font-family="monospace" font-weight="bold" fill="#1a1000">AI</text></svg>'
      );
      await self.registration.showNotification(title, {
        body,
        icon,
        tag: ck,
        renotify: true,
        data: { convKey: ck, url: self.location.origin },
        vibrate: [200, 100, 200],
      });
    }
  } catch(e) {}
}
