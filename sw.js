// Black hole camera: offline cache (service worker).
// After one visit with internet, the page also starts without internet: the page itself,
// the texts, the background pictures, the fonts, the QR library and (once they have been
// used) the person-recognition files are kept on this computer.
// - page, texts, style sheet and scripts: fetched fresh when there is internet (so updates
//   arrive), from the cache when there is none or it takes longer than 4 s;
// - everything else (pictures, fonts, fixed library versions, AI models): cache first.
// The photo service (QR codes) is never cached.
const CACHE = 'bhc-offline-v1';      // raise v1 when a picture in backgrounds/ changes (pictures are cache-first)
const SCOPE = new URL('./', self.location).pathname;          // /bh-camera/
// stored at installation; keep the js/ files in step with the <script> list in index.html
const CORE = [
  './', 'texts.js', 'style.css',
  'js/01-lensing-shader.js', 'js/02-setup.js', 'js/03-settings.js', 'js/04-drawing.js', 'js/05-camera.js',
  'js/06-panel.js', 'js/07-background-removal.js', 'js/08-background-pictures.js', 'js/09-photos.js', 'js/10-main.js',
  'backgrounds/earth.jpg', 'backgrounds/earthrise.jpg', 'backgrounds/moon.jpg',
  'backgrounds/pillars.jpg', 'backgrounds/deep-field.jpg',
  'https://cdnjs.cloudflare.com/ajax/libs/qrcode-generator/1.4.4/qrcode.min.js'
];
const CDN = ['fonts.googleapis.com', 'fonts.gstatic.com', 'cdn.jsdelivr.net', 'cdnjs.cloudflare.com', 'storage.googleapis.com'];

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

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const own = url.origin === self.location.origin;
  if (own && !url.pathname.startsWith(SCOPE)) return;          // other pages of this site
  if (!own && !CDN.includes(url.hostname)) return;             // e.g. the photo service
  const fresh = own && (req.mode === 'navigate' || url.pathname === SCOPE ||
                        url.pathname.endsWith('/index.html') || /\.(js|css)$/.test(url.pathname));
  e.respondWith(fresh ? networkFirst(req) : cacheFirst(req));
});

async function networkFirst(req){
  const c = await caches.open(CACHE);
  try {
    const r = await Promise.race([fetch(req), new Promise((_, no) => setTimeout(() => no(new Error('slow')), 4000))]);
    if (r.ok) c.put(stripSearch(req), r.clone());
    return r;
  } catch (err) {
    const hit = await c.match(req, {ignoreSearch: true});
    if (hit) return hit;
    throw err;
  }
}

async function cacheFirst(req){
  const c = await caches.open(CACHE);
  const hit = await c.match(req);
  if (hit) return hit;
  const r = await fetch(req);
  if (r.ok || r.type === 'opaque') c.put(req, r.clone());
  return r;
}

// the page is stored without ?pinreset etc., so it is found again with any address suffix
function stripSearch(req){
  const u = new URL(req.url); u.search = '';
  return u.href;
}
