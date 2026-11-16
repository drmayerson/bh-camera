'use strict';
if (!window.ZGC_READY) throw new Error('Zwart gat camera: not started (see the message on screen)');

/* =====================================================================================
   Zwart gat camera — 08: background pictures
   -------------------------------------------------------------------------------------
   - a small key-value store in IndexedDB, for things too large or too special for
     localStorage: the own background picture and the chosen photo folder;
   - the background picture shown where the background was removed: the star sky, one of
     the pictures in achtergronden/, or your own picture.
   ===================================================================================== */


// ---------- small key-value store (IndexedDB): own background picture, photo folder ----------

function idbOpen(){
  return new Promise((res, rej) => {
    const r = indexedDB.open('zwart-gat-camera', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}

async function idbGet(k){
  const db = await idbOpen();
  return new Promise((res, rej) => {
    const q = db.transaction('kv').objectStore('kv').get(k);
    q.onsuccess = () => res(q.result);
    q.onerror = () => rej(q.error);
  });
}

// store v under k (v = null removes it)
async function idbSet(k, v){
  const db = await idbOpen();
  return new Promise((res, rej) => {
    const t = db.transaction('kv', 'readwrite'), st = t.objectStore('kv');
    if (v == null) st.delete(k); else st.put(v, k);
    t.oncomplete = () => res();
    t.onerror = () => rej(t.error);
  });
}


// ---------- background picture ----------
// The removed background shows either the star sky (each ray's own direction, as around
// the black hole) or a picture that hangs where your room was, lensed together with you.

const BACKDROPS = {
  'aarde':       {src: 'achtergronden/aarde.jpg'},
  'aardopgang':  {src: 'achtergronden/aardopgang.jpg'},
  'maan':        {src: 'achtergronden/maan.jpg'},
  'pilaren':     {src: 'achtergronden/pilaren.jpg'},
  'diep-heelal': {src: 'achtergronden/diep-heelal.jpg'},
};
const bdChoice = el('bdChoice');          // 'sterren' (star sky), a key of BACKDROPS, or 'eigen' (own picture)
// bdReady: the picture is in the texture; bdAspect: its height/width;
// bdLoadId: number of the latest request (an older picture that arrives late is ignored)
let bdReady = false, bdAspect = 1, bdLoadId = 0;

// note under the choice; kept as a function so it can be redrawn in another language
let bdNoteFn = null;
function bdNote(fn){ bdNoteFn = fn || null; el('bdNote').textContent = fn ? fn() : ''; }

function setBackdrop(img){
  // keep the texture modest (and within every GPU's limits)
  const MAX = 2048, k = Math.min(1, MAX/Math.max(img.width, img.height));
  let src = img;
  if (k < 1) {
    src = document.createElement('canvas');
    src.width = Math.round(img.width*k); src.height = Math.round(img.height*k);
    src.getContext('2d').drawImage(img, 0, 0, src.width, src.height);
  }
  upload(bdTex, src);
  bdAspect = src.height/src.width;
  bdReady = true;
}

function loadImage(url){
  return new Promise((res, rej) => {
    const im = new Image();
    im.onload = () => res(im);
    im.onerror = rej;
    im.src = url;
  });
}

// load the chosen picture (asynchronously; until it is there, the star sky is shown)
async function backdropChanged(){
  const c = bdChoice.value, id = ++bdLoadId;
  el('bdOwnRow').hidden = c !== 'eigen';
  bdReady = false;
  if (c === 'sterren') { bdNote(() => t('bdStarsNote')); save(); return; }
  try {
    if (c === 'eigen') {
      const blob = ownBlob || await idbGet('ownBackdrop').catch(() => null);
      if (blob) ownBlob = blob;
      if (!blob) { bdNote(() => t('bdOwnNeed')); save(); return; }
      const url = URL.createObjectURL(blob);
      try {
        const im = await loadImage(url);
        if (id === bdLoadId) setBackdrop(im);
      } finally { URL.revokeObjectURL(url); }
      bdNote(() => t('bdOwnNote') + ' ' + t('lensed'));
    } else {
      bdNote(() => t('loading'));
      const im = await loadImage(BACKDROPS[c].src);
      if (id !== bdLoadId) return;
      setBackdrop(im);
      bdNote(() => t('cr_' + c) + ' ' + t('lensed'));     // with the picture's credit line
    }
  } catch (e) { console.error(e); if (id === bdLoadId) bdNote(() => t('bdFail')); }
  save();
}

// choosing "own picture" without having one opens the file chooser right away
bdChoice.addEventListener('change', () => {
  backdropChanged();
  if (bdChoice.value === 'eigen' && !ownBlob) idbGet('ownBackdrop').then(b => {
    if (!b) el('bdFile').click();
  }).catch(() => el('bdFile').click());
});
el('bdFileBtn').addEventListener('click', () => el('bdFile').click());

// a picture file was chosen
el('bdFile').addEventListener('change', async e => {
  const f = e.target.files && e.target.files[0];
  e.target.value = '';
  if (!f) return;
  try {
    // store a reduced copy, so it is still there next time (also on a booth computer)
    const url = URL.createObjectURL(f), im = await loadImage(url);
    URL.revokeObjectURL(url);
    const k = Math.min(1, 2048/Math.max(im.width, im.height)), c = document.createElement('canvas');
    c.width = Math.round(im.width*k); c.height = Math.round(im.height*k);
    c.getContext('2d').drawImage(im, 0, 0, c.width, c.height);
    const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.9));
    ownBlob = blob;
    if (el('remember').checked) await idbSet('ownBackdrop', blob).catch(err => console.warn('could not keep the picture', err));
    bdChoice.value = 'eigen'; setBackdrop(c); bdLoadId++;
    el('bdOwnRow').hidden = false;
    bdNote(() => t('bdOwnNote') + ' ' + t('lensed'));
    save();
  } catch (err) { console.error(err); bdNote(() => t('bdBadFile')); }
});
