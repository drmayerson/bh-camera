'use strict';
if (!window.ZGC_READY) throw new Error('Zwart gat camera: not started (see the message on screen)');

/* =====================================================================================
   Zwart gat camera — 09: photos and QR codes
   -------------------------------------------------------------------------------------
   A click in the picture (or an arrow key) takes a photo of what is on screen: only the
   black-hole image, without the settings. It can be saved on this computer (in Chrome/Edge
   in a chosen folder, without dialogs; otherwise via Downloads) and/or uploaded to the
   booth's own photo service (cloudflare/worker.js), which gives a QR code for the
   visitor's phone. Uploaded photos are deleted after 24 hours.

   Flow: takeShot() (optional countdown) -> flag shotPending -> the render loop draws a
   frame and calls grabShot() -> handleShot() saves and/or uploads -> showQR().
   (The click in the picture is handled in 07-background-removal.js, last section, because
   the same click also picks the green-screen colour.)
   ===================================================================================== */


// ---------- photo settings ----------

const shotsOn = el('shotsOn'), shotLocal = el('shotLocal'), shotQR = el('shotQR');
const qrBase = el('qrBase'), qrKey = el('qrKey');            // address and key of the photo service
const canPickDir = typeof window.showDirectoryPicker === 'function';   // Chrome/Edge: save in a chosen folder
// shotDir: the chosen folder (or null: Downloads); shotPending: grab the next frame;
// shotBusy: a photo is still being saved / uploaded
let shotDir = null, shotPending = false, shotBusy = false;

// show the options that apply, and the right notes
function updateShotUI(){
  document.body.classList.toggle('shots', shotsOn.checked);
  el('shotSub').hidden = !shotsOn.checked;
  el('shotLocalSub').hidden = !shotLocal.checked;
  el('shotQRSub').hidden = !shotQR.checked;
  el('shotDirName').textContent = shotDir ? shotDir.name : t('downloads');
  el('shotDirReset').hidden = !shotDir;
  el('shotDirBtn').hidden = !canPickDir;
  el('shotNote').textContent = canPickDir ? (shotDir ? t('shotNoteDir') : t('shotNoteDl'))
                                          : t('shotNoteNoPick');
  if (!qrNoteSticky) el('qrNote').textContent = qrConfigured() ? t('qrNoteOk') : t('qrNoteNeed');
  updateCamNote();
  updateQrAgain();
}
let qrNoteSticky = false;                 // the note shows a connection-test result: leave it
function qrConfigured(){ return /^https?:\/\/\S+$/.test(qrBase.value.trim()) && qrKey.value.length > 0; }

el('shotCount').addEventListener('change', save);
el('qrAgainOn').addEventListener('change', () => { updateQrAgain(); save(); });
[shotsOn, shotLocal, shotQR].forEach(c => c.addEventListener('change', () => { if (!shotsOn.checked || !shotQR.checked) hideQR(); updateShotUI(); save(); }));
[qrBase, qrKey].forEach(c => c.addEventListener('input', () => { qrNoteSticky = false; updateShotUI(); save(); }));

// choosing the photo folder (remembered in IndexedDB)
el('shotDirBtn').addEventListener('click', async () => {
  try {
    shotDir = await window.showDirectoryPicker({id: 'zwart-gat-fotos', mode: 'readwrite', startIn: 'downloads'});
    if (el('remember').checked) await idbSet('shotDir', shotDir).catch(e => console.warn('could not remember the folder', e));
  } catch (e) { if (e && e.name !== 'AbortError') console.warn(e); }
  updateShotUI();
});
el('shotDirReset').addEventListener('click', () => { shotDir = null; idbSet('shotDir', null).catch(() => {}); updateShotUI(); });
if (canPickDir) idbGet('shotDir').then(h => { if (h) { shotDir = h; updateShotUI(); } }).catch(() => {});


// ---------- taking a photo ----------

// short message at the bottom of the screen
let toastTimer = null;
function toast(t){
  const e = el('toast');
  e.textContent = t;
  e.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { e.hidden = true; }, 4000);
}

// Optional countdown on screen before the photo (not in the photo itself). Esc cancels it.
// Resolves to true when the photo should be taken, false when cancelled.
let counting = false, countCancel = null;
function countdown(){
  return new Promise(resolve => {
    const box = el('count');
    let n = 3, timer = null;
    const show = (t, snap) => { box.innerHTML = '<span' + (snap ? ' class="snap"' : '') + '>' + t + '</span>'; };
    const done = ok => { clearTimeout(timer); countCancel = null; box.hidden = true; box.innerHTML = ''; resolve(ok); };
    countCancel = () => done(false);
    box.hidden = false; show(n);
    const tick = () => {
      n--;
      if (n > 0) { show(n); timer = setTimeout(tick, 1000); }
      else { show(t('snap'), true); timer = setTimeout(() => done(true), 350); }   // photo right after "klik!"
    };
    timer = setTimeout(tick, 1000);
  });
}

async function takeShot(){
  if (shotBusy || shotPending || counting) return;
  if (!shotLocal.checked && !shotQR.checked) { toast(t('chooseSave')); return; }
  hideQR();
  // ask for permission to write in the folder now, while the click still counts
  if (shotLocal.checked && shotDir) {
    try {
      let p = await shotDir.queryPermission({mode: 'readwrite'});
      if (p !== 'granted') p = await shotDir.requestPermission({mode: 'readwrite'});
      if (p !== 'granted') toast(t('noFolderPerm', {name: shotDir.name}));
    } catch (e) { console.warn(e); }
  }
  if (el('shotCount').checked) {
    counting = true;
    const ok = await countdown();
    counting = false;
    if (!ok) return;
  }
  shotPending = true;                     // grabbed right after the next frame is drawn
  const f = el('flash');
  f.classList.remove('go'); void f.offsetWidth; f.classList.add('go');   // (restart the flash animation)
}

// called in the render loop right after drawing, while the picture is still in the buffer
function grabShot(){
  shotPending = false; shotBusy = true;
  const W = canvas.width, H = canvas.height, px = new Uint8Array(W*H*4);
  gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const x = c.getContext('2d'), img = x.createImageData(W, H), row = W*4;
  for (let y = 0; y < H; y++) img.data.set(px.subarray((H - 1 - y)*row, (H - y)*row), y*row);   // GL rows are bottom-up
  x.putImageData(img, 0, 0);
  // small copy to show next to the QR code, so visitors recognise their own photo
  const t = document.createElement('canvas'), k = 320/Math.max(W, H);
  t.width = Math.max(1, Math.round(W*k)); t.height = Math.max(1, Math.round(H*k));
  t.getContext('2d').drawImage(c, 0, 0, t.width, t.height);
  const thumb = t.toDataURL('image/jpeg', 0.8);
  c.toBlob(b => handleShot(b, thumb).catch(e => console.error(e)).finally(() => { shotBusy = false; }), 'image/jpeg', 0.92);
}

// date and time for the file name, e.g. 2026-11-16_14-05-09
let lastStamp = '', stampCount = 0;
function stamp(){
  const d = new Date(), z = v => String(v).padStart(2, '0');
  const t = d.getFullYear() + '-' + z(d.getMonth() + 1) + '-' + z(d.getDate()) + '_' +
            z(d.getHours()) + '-' + z(d.getMinutes()) + '-' + z(d.getSeconds());
  // several photos within one second get -2, -3, ... so none is overwritten
  stampCount = t === lastStamp ? stampCount + 1 : 1;
  lastStamp = t;
  return stampCount > 1 ? t + '-' + stampCount : t;
}


// ---------- saving and uploading ----------

// Save and/or upload one photo. If the upload fails, the photo is saved on this computer
// instead (when that was not already chosen).
async function handleShot(blob, thumb){
  if (!blob) { toast(t('shotFail')); return; }
  const name = 'zwart-gat_' + stamp() + '.jpg';
  const wantLocal = shotLocal.checked, wantQR = shotQR.checked;
  const local = wantLocal ? saveLocal(blob, name) : null;
  if (wantQR) {
    showQRWaiting(thumb);
    try {
      if (!qrConfigured()) throw new Error(t('serviceNotSet'));
      const r = await uploadShot(blob, name);
      qrHistory.unshift({page: r.page, thumb, time: new Date(), expires: r.expires || Date.now() + 24*3600e3});
      if (qrHistory.length > 20) qrHistory.length = 20;
      await showQR(0);
    } catch (e) {
      console.warn('upload failed', e);
      hideQR();
      const why = e && e.name === 'AbortError' ? t('noAnswer') : (e && e.message) || t('error');
      if (!wantLocal) { await saveLocal(blob, name); toast(t('upFailSaved', {why})); }
      else toast(t('upFailAlso', {why}));
      return;
    }
  }
  if (local) {
    const msg = await local;
    if (!wantQR) toast(msg);
  }
}

// save on this computer; returns a message for the user
async function saveLocal(blob, name){
  // in the chosen folder, if the browser still has permission
  if (shotDir) {
    try {
      if (await shotDir.queryPermission({mode: 'readwrite'}) === 'granted') {
        let fname = name;                 // never overwrite a photo already in the folder:
        // while the name exists, try name_2.jpg, name_3.jpg, ...
        for (let k = 2; await shotDir.getFileHandle(fname).then(() => true, () => false); k++) fname = name.replace('.jpg', '_' + k + '.jpg');
        const fh = await shotDir.getFileHandle(fname, {create: true}), w = await fh.createWritable();
        await w.write(blob); await w.close();
        return t('savedIn', {dir: shotDir.name, file: fname});
      }
    } catch (e) { console.warn('saving in the folder failed', e); }
  }
  // otherwise as a download
  const a = document.createElement('a'), url = URL.createObjectURL(blob);
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
  return t('savedDl', {file: name});
}

// the photo service (cloudflare/worker.js): POST /upload, GET /check; 25 s time limit
function serviceUrl(path){ return qrBase.value.trim().replace(/\/+$/, '') + path; }
async function callService(path, opts){
  const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 25000);
  try {
    const r = await fetch(serviceUrl(path), Object.assign({signal: ctl.signal}, opts));
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || (t('error') + ' ' + r.status));
    return j;
  } finally { clearTimeout(timer); }
}
function uploadShot(blob, name){
  return callService('/upload', {method: 'POST', body: blob,
    headers: {'Content-Type': 'image/jpeg', 'X-Booth-Key': qrKey.value, 'X-Photo-Name': name}});
}

// "Verbinding testen"
el('qrTest').addEventListener('click', async () => {
  qrNoteSticky = true;
  const note = el('qrNote');
  if (!qrConfigured()) { note.textContent = t('needUrl'); return; }
  note.textContent = t('testing');
  try {
    const j = await callService('/check', {headers: {'X-Booth-Key': qrKey.value}});
    note.textContent = t('connOk', {h: j.keepHours || 24});
  } catch (e) {
    note.textContent = t('connFail', {why: (e && e.name === 'AbortError'          ? t('noAnswer')
                                          : e && e.message === 'Failed to fetch' ? t('unreachable')
                                          : (e && e.message) || t('error'))});
  }
});


// ---------- QR code on screen ----------
// Shown until the next photo, at most the time set with the slider (the last slider
// step: no time limit); Q or the "QR" button shows recent ones again (pressing again
// goes further back).

const qrSec = el('qrSec');
function qrSeconds(){ const v = Number(qrSec.value); return v > 120 ? Infinity : v; }
function qrSecLabel(){ el('qrSecVal').textContent = qrSeconds() === Infinity ? t('qrSecUntil') : qrSeconds() + ' s'; }
qrSec.addEventListener('input', () => { qrSecLabel(); save(); });
qrSecLabel();

// qrHistory: recent uploads, newest first; qrShown: index shown now (-1: none)
let qrHistory = [], qrShown = -1, qrTimer = null, qrLib = null;

// the QR library is only loaded when it is first needed
function loadQrLib(){
  if (!qrLib) qrLib = new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = 'https://cdnjs.cloudflare.com/ajax/libs/qrcode-generator/1.4.4/qrcode.min.js';
    s.integrity = 'sha384-mZT2gIty7ZDdOGkxfP6joZcYdMW1Jvj9dRlfpTmaJAKKXTqzygtB22k7FLe+KZC1';
    s.crossOrigin = 'anonymous';
    s.onload = () => res(window.qrcode);
    s.onerror = () => { qrLib = null; rej(new Error('QR-bibliotheek niet geladen')); };   // (Dutch only: not in teksten.js)
    document.head.appendChild(s);
  });
  return qrLib;
}

function qrTime(d){ return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); }

// the bar under the QR code shrinks until it disappears
function startQrTimer(){
  clearTimeout(qrTimer);
  const bar = el('qrBar');
  bar.style.transition = 'none'; bar.style.transform = 'scaleX(1)'; void bar.offsetWidth;
  const s = qrSeconds();
  bar.parentElement.hidden = s === Infinity;   // no countdown bar without a time limit
  if (s === Infinity) return;
  bar.style.transition = 'transform ' + s + 's linear'; bar.style.transform = 'scaleX(0)';
  qrTimer = setTimeout(hideQR, s*1000);
}

// while uploading: the photo with "please wait"
function showQRWaiting(thumb){
  el('qrThumb').src = thumb;
  el('qrCode').innerHTML = '<span class="wait">Foto wordt klaargezet…</span>';   // (Dutch only: not in teksten.js)
  el('qrTitle').textContent = t('wait');
  el('qrInfo').textContent = '';
  el('qrBox').hidden = false; qrShown = -1;
  clearTimeout(qrTimer); el('qrBar').style.transition = 'none'; el('qrBar').style.transform = 'scaleX(1)';
}

// show the QR code of qrHistory[i]; `again`: shown again on request (with time and number)
async function showQR(i, again){
  qrHistory = qrHistory.filter(h => h.expires > Date.now());
  const h = qrHistory[i];
  if (!h) { hideQR(); return; }
  let qrcode;
  try { qrcode = await loadQrLib(); } catch (e) { hideQR(); toast(t('qrFail', {url: h.page})); return; }
  // the visitor page uses the phone's language, or else the language of the booth
  const qr = qrcode(0, 'M');
  qr.addData(h.page + (h.page.includes('?') ? '&' : '?') + 'l=' + lang);
  qr.make();
  // (the alt text is Dutch only: not in teksten.js)
  el('qrCode').innerHTML = '<img alt="QR-code met de link naar je foto" src="' + qr.createDataURL(8, 4) + '">';
  el('qrThumb').src = h.thumb;
  el('qrTitle').textContent = t('scan');
  el('qrInfo').textContent = (again ? t('photoOf', {t: qrTime(h.time), i: i + 1, n: qrHistory.length}) : '') + t('kept24');
  el('qrBox').hidden = false; qrShown = i;
  startQrTimer(); updateQrAgain();
}

function hideQR(){ clearTimeout(qrTimer); el('qrBox').hidden = true; qrShown = -1; }

// Q / the "QR" button: the newest QR code, then each time one further back
function showQrAgain(){
  qrHistory = qrHistory.filter(h => h.expires > Date.now());
  if (!qrHistory.length) { toast(t('noRecent')); updateQrAgain(); return; }
  showQR(qrShown < 0 ? 0 : (qrShown + 1) % qrHistory.length, true);
}

// re-showing earlier QR codes can be switched off: without staff, anyone could open earlier visitors' photos
function updateQrAgain(){ el('qrAgain').hidden = !(shotsOn.checked && shotQR.checked && el('qrAgainOn').checked && qrHistory.length); }
el('qrAgain').addEventListener('click', showQrAgain);
el('qrClose').addEventListener('click', hideQR);


// ---------- keys ----------
// Arrow keys also take a photo (handy with a presenter remote or a big button at a booth);
// Q shows recent QR codes again; Escape hides the QR code. Not while a slider, menu or
// text field has the focus: there these keys keep their usual job.

document.addEventListener('keydown', e => {
  if (!shotsOn.checked || picking || e.repeat || e.altKey || e.ctrlKey || e.metaKey || !el('pinPad').hidden) return;
  const t = e.target;
  if (t && (t.isContentEditable || /^(INPUT|SELECT|TEXTAREA)$/.test(t.tagName))) return;
  // arrow keys, and PageUp/PageDown, which is what most presenter remotes send
  if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown'].includes(e.key)) { e.preventDefault(); takeShot(); }
  else if ((e.key === 'q' || e.key === 'Q') && shotQR.checked && el('qrAgainOn').checked) { e.preventDefault(); showQrAgain(); }
  else if (e.key === 'Escape') { hideQR(); hideInfo(); if (countCancel) countCancel(); }
});
