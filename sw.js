// Black hole camera: offline cache (service worker).
// After one visit with internet, the page also starts without internet: the page itself,
// the texts, the background pictures, the fonts, the QR library and (once they have been
// used) the person-recognition files are kept on this computer.
// - the page: fetched fresh when there is internet (so updates arrive), from the cache when
//   there is none or it takes longer than 4 s;
// - its texts, style sheets and scripts: from the same place as the page, so an old page
//   never gets new files or the other way round (fresh: they wait for the network, and the
//   cache is used only when there is no network at all);
// - everything else (pictures, fonts, fixed library versions, AI models): cache first.
// The photo service (QR codes) is never cached.
const CACHE = 'bhc-offline-v1';      // raise v1 when a picture in backgrounds/ changes (pictures are cache-first)
const SCOPE = new URL('./', self.location).pathname;          // /bh-camera/
// stored at installation; keep the js/ files in step with the <script> list in index.html
const CORE = [
  './', 'texts.js', 'style.css', 'fonts/fonts.css',
  'fonts/atkinson-hyperlegible-400-italic-latin-ext.woff2',
  'fonts/atkinson-hyperlegible-400-italic-latin.woff2',
  'fonts/atkinson-hyperlegible-400-latin-ext.woff2',
  'fonts/atkinson-hyperlegible-400-latin.woff2',
  'fonts/atkinson-hyperlegible-700-latin-ext.woff2',
  'fonts/atkinson-hyperlegible-700-latin.woff2',
  'fonts/jetbrains-mono-latin-ext.woff2',
  'fonts/jetbrains-mono-latin.woff2',
  'fonts/unbounded-latin-ext.woff2',
  'fonts/unbounded-latin.woff2',
  'js/01-lensing-shader.js', 'js/02-setup.js', 'js/03-settings.js', 'js/04-drawing.js', 'js/05-camera.js',
  'js/06-panel.js', 'js/07-background-removal.js', 'js/08-background-pictures.js', 'js/09-photos.js',
  'js/10-hand-photo.js', 'js/11-physics-points.js', 'js/12-main.js',
  'backgrounds/earth.jpg', 'backgrounds/earthrise.jpg', 'backgrounds/moon.jpg',
  'backgrounds/pillars.jpg', 'backgrounds/deep-field.jpg',
  'https://cdnjs.cloudflare.com/ajax/libs/qrcode-generator/1.4.4/qrcode.min.js'
];
const CDN = ['cdn.jsdelivr.net', 'cdnjs.cloudflare.com', 'storage.googleapis.com'];

// installation: store the CORE files (a file that fails is skipped, not fatal)
self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE)
    .then(c => Promise.all(CORE.map(u =>
      c.add(new Request(u, {mode: u.startsWith('http') ? 'cors' : 'same-origin', cache: 'reload'}))
        .catch(err => console.warn('offline cache: could not store', u, err)))))
    .then(() => self.skipWaiting()));
});

// activation: remove older versions of the cache (zgc-: its name before the move to English)
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => (k.startsWith('bhc-offline-') || k.startsWith('zgc-offline-')) && k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

// pages (browser tabs) that were served from the cache: their own files come from the cache too
const pagesFromCache = new Set();

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const own = url.origin === self.location.origin;
  if (own && !url.pathname.startsWith(SCOPE)) return;          // other pages of this site
  if (!own && !CDN.includes(url.hostname)) return;             // e.g. the photo service
  if (req.mode === 'navigate' || url.pathname === SCOPE || url.pathname.endsWith('/index.html')) e.respondWith(page(e));
  else if (own && /\.(js|css)$/.test(url.pathname)) e.respondWith(pagesFromCache.has(e.clientId) ? cacheThenNetwork(req) : networkThenCache(req));
  else e.respondWith(cacheFirst(req));
});

// The page: fresh from the network, but from the cache if that takes longer than 4 s or
// there is no network. (A late answer from the network still updates the cache.)
async function page(e){
  const req = e.request, c = await caches.open(CACHE);
  const net = fetch(req).then(r => { if (r.ok) c.put(stripSearch(req), r.clone()); return r; });
  try {
    return await Promise.race([net, new Promise((_, no) => setTimeout(() => no(new Error('slow')), 4000))]);
  } catch (err) {
    const hit = await c.match(req, {ignoreSearch: true});
    if (!hit) return net;                 // nothing stored yet: keep waiting for the network
    net.catch(() => {});
    if (e.resultingClientId) pagesFromCache.add(e.resultingClientId);
    return hit;
  }
}

// a file of a fresh page: from the network (however long it takes); from the cache only
// when there is no network at all
async function networkThenCache(req){
  const c = await caches.open(CACHE);
  try {
    const r = await fetch(req);
    if (r.ok) c.put(stripSearch(req), r.clone());
    return r;
  } catch (err) {
    const hit = await c.match(req, {ignoreSearch: true});
    if (hit) return hit;
    throw err;
  }
}

// a file of a page that came from the cache: from the cache as well
async function cacheThenNetwork(req){
  const c = await caches.open(CACHE);
  return (await c.match(req, {ignoreSearch: true})) || networkThenCache(req);
}

async function cacheFirst(req){
  const c = await caches.open(CACHE);
  const hit = await c.match(req);
  if (hit) return hit;
  const r = await fetch(req);
  if (r.ok || r.type === 'opaque') c.put(req, r.clone());
  return r;
}

// stored without ?v=, ?pinreset etc. (one copy per file), so it is found with any suffix
function stripSearch(req){
  const u = new URL(req.url); u.search = '';
  return u.href;
}
