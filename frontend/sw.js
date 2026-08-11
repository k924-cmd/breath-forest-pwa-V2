const CACHE_NAME = 'breath-forest-ui-v33';
const CORE_ASSETS = [
  './', './index.html', './styles.css?v=20260808-7', './manifest.webmanifest', './src/main.js?v=20260808-7',
  './src/config.js?v=20260808-7', './src/app/state.js?v=20260808-7', './src/components/icons.js?v=20260808-7', './src/components/message-cards.js?v=20260808-7', './src/presentation.js?v=20260808-7', './src/utils/html.js?v=20260808-7',
  './src/pages/home.js?v=20260808-7', './src/pages/devices.js?v=20260808-7', './src/pages/chat.js?v=20260808-7', './src/pages/profile.js?v=20260808-7',
  './src/services/conversation-service.js?v=20260808-7', './src/services/device-service.js?v=20260808-7', './src/services/environment-service.js?v=20260808-7',
  './src/services/asr-service.js?v=20260808-7', './src/services/easter-service.js?v=20260808-7', './src/utils/audio.js?v=20260808-7', './src/utils/feedback.js?v=20260808-7', './src/utils/play-audio.js?v=20260808-7',
  './src/mocks/conversation.js?v=20260808-7', './src/mocks/devices.js?v=20260808-7', './src/mocks/environment.js?v=20260808-7',
  './vendor/lottie-web.js', './assets/robot.json', './assets/start-robot.json', './assets/ai-flow.json',
  './icons/app-512.png', './icons/app-192.png', './icons/apple-icon.png',
  './assets/breath-forest-living-room.webp',
  './assets/device-fan.webp', './assets/device-fresh.webp', './assets/device-hood.webp',
  './assets/device-humidifier.webp', './assets/device-purifier.webp', './assets/device-window.webp'
];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(CORE_ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  event.respondWith(fetch(event.request).then(response => {
    const copy = response.clone();
    caches.open(CACHE_NAME).then(cache => cache.put(event.request, copy));
    return response;
  }).catch(() => caches.match(event.request).then(cached => cached || caches.match('./index.html'))));
});
