/* ============================================================================
   Service Worker · G.H. Champions26/27
   Estrategia CONSERVADORA:
   - Cachea solo el "cascarón" estático (HTML, JS propio, iconos, escudos).
   - NUNCA cachea Supabase ni ninguna API: esas peticiones van SIEMPRE a la red
     (datos frescos, login intacto).
   - Al publicar una versión nueva, sube el número de CACHE y se limpia lo viejo.
   ============================================================================ */
const CACHE = 'ghc-2026-v3';

// Cascarón mínimo. Rutas RELATIVAS (GitHub Pages sirve el repo en un subdirectorio).
const SHELL = [
  './',
  './index.html',
  './login.html',
  './porra-champions.html',
  './admin.html',
  './resultados.html',
  './ayuda.html',
  './puntuacion.js',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './icon-512-maskable.png',
  './apple-touch-icon.png'
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  const url = new URL(req.url);

  // Solo gestionamos GET del mismo origen. Todo lo demás (Supabase, CDNs, POST…) → red directa.
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;

  // Nunca cachear llamadas a APIs por si acaso.
  if (url.pathname.includes('/rest/') || url.pathname.includes('/auth/')) return;

  // Navegaciones (abrir una página): red primero, y si no hay conexión, versión cacheada.
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req).then(res => {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(req, copy)).catch(()=>{});
        return res;
      }).catch(() => caches.match(req).then(r => r || caches.match('./index.html')))
    );
    return;
  }

  // Estáticos (js, iconos, escudos, css): cache primero, y si no está, red (y se guarda).
  e.respondWith(
    caches.match(req).then(hit => hit || fetch(req).then(res => {
      if (res.ok && (res.type === 'basic')) {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(req, copy)).catch(()=>{});
      }
      return res;
    }).catch(() => hit))
  );
});
