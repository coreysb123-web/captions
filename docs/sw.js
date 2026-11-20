// Service worker: keeps a copy of the app so it opens instantly and shows a proper
// screen (instead of a browser error) when the phone has no signal.
//
// Network first: when online, the newest version is always used, so updating the
// site updates every phone the next time the app is opened.

const CACHE = 'captions-v2';
const SHELL = [
  './',
  'index.html',
  'css/app.css',
  'js/app.js',
  'js/audio.js',
  'js/history.js',
  'js/pcm-worklet.js',
  'js/session.js',
  'js/store.js',
  'js/view.js',
  'js/wake.js',
  'js/engines/demo.js',
  'js/engines/elevenlabs.js',
  'manifest.webmanifest',
  'icons/icon-180.png',
  'icons/icon-192.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

function fetchWithTimeout(request, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), ms);
    fetch(request, { cache: 'no-cache' }).then(
      (response) => {
        clearTimeout(timer);
        resolve(response);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return;
  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      try {
        const fresh = await fetchWithTimeout(request, 4000);
        if (fresh && fresh.ok) cache.put(request, fresh.clone());
        return fresh;
      } catch (error) {
        const stored = (await cache.match(request, { ignoreSearch: true })) || (await cache.match('index.html'));
        if (stored) return stored;
        throw error;
      }
    })()
  );
});
