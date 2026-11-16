'use strict';
if (!window.BHC_READY) throw new Error('Black hole camera: not started (see the message on screen)');

/* =====================================================================================
   Black hole camera — 10: raise a hand for a photo (no touching)
   -------------------------------------------------------------------------------------
   With "Hand opsteken" ticked under Foto's (and the camera on), a visitor holds
   an open hand up to the camera for about half a second: the photo countdown starts, and
   the photo is taken (and its QR code shown) as with a click.

   The hand recognition is MediaPipe's gesture recogniser (the same library as the person
   recognition in 07), in its own Web Worker on the processor, a few times per second.
   It only looks while the settings are closed and no photo is being taken; after a photo
   it waits a few seconds, so one raised hand gives one photo.
   ===================================================================================== */

const handOn = el('handOn');
const HAND_MODEL = 'https://storage.googleapis.com/mediapipe-models/gesture_recognizer/gesture_recognizer/float16/1/gesture_recognizer.task';
const HAND_EVERY = 200;                   // ms between two looks
const HAND_NEED = 3, HAND_WINDOW = 1200;  // open hand seen in 3 looks within 1.2 s: take a photo
const HAND_PAUSE = 8000;                  // ms after a photo before a hand counts again

// The worker's own code. Messages:
//   in:  {type: 'init', lib, model}    load MediaPipe and the gesture model
//        {type: 'frame', bitmap}       look at one camera frame
//   out: {type: 'ready'} / {type: 'error', message} / {type: 'result', palms}
const HAND_SRC = `
let rec = null;
async function loadLib(base){
  // same loading trick as the person recognition (07-background-removal.js)
  const txt = await (await fetch(base + '/vision_bundle.cjs')).text();
  self.module = {exports: {}}; self.exports = self.module.exports;
  importScripts(URL.createObjectURL(new Blob([txt], {type: 'text/javascript'})));
  return self.module.exports;
}
self.onmessage = async e => {
  const d = e.data;
  if (d.type === 'init') {
    try {
      const mp = await loadLib(d.lib);
      const files = await mp.FilesetResolver.forVisionTasks(d.lib + '/wasm');
      rec = await mp.GestureRecognizer.createFromOptions(files, {
        baseOptions: {modelAssetPath: d.model, delegate: 'CPU'}, runningMode: 'IMAGE', numHands: 4});
      self.postMessage({type: 'ready'});
    } catch (err) { self.postMessage({type: 'error', message: String(err && err.message || err)}); }
  } else if (d.type === 'frame') {
    let palms = 0;
    try {
      const res = rec.recognize(d.bitmap);
      for (const g of res.gestures || []) if (g[0] && g[0].categoryName === 'Open_Palm' && g[0].score > 0.6) palms++;
    } catch (err) { self.postMessage({type: 'error', message: String(err && err.message || err)}); return; }
    finally { d.bitmap.close(); }
    self.postMessage({type: 'result', palms});
  }
};`;

let handWorker = null;                    // the running worker (or null)
let handReady = false;                    // model loaded
let handBusy = false;                     // a frame is being looked at
let handError = null;                     // why it does not work (shown in the note)
let palmTimes = [];                       // times (ms) of recent looks that saw an open hand
let handPauseUntil = 0;                   // no new photo by hand before this time
const handCanvas = document.createElement('canvas');   // scratch, for a camera on its side

function startHand(){
  handError = null; handReady = false; handBusy = false;
  try {
    handWorker = new Worker(URL.createObjectURL(new Blob([HAND_SRC], {type: 'text/javascript'})));
  } catch (e) { handError = String(e); handWorker = null; return; }
  handWorker.onmessage = e => {
    const d = e.data;
    if (d.type === 'ready') { handReady = true; updateHandNote(); }
    else if (d.type === 'error') { console.error('hand recognition:', d.message); handError = d.message; stopHand(true); updateHandNote(); }
    else if (d.type === 'result') { handBusy = false; handResult(d.palms); }
  };
  handWorker.onerror = e => { handError = e.message || 'worker'; stopHand(true); updateHandNote(); };
  handWorker.postMessage({type: 'init', lib: MP, model: HAND_MODEL});
  updateHandNote();
}

function stopHand(keepError){
  if (handWorker) handWorker.terminate();
  handWorker = null; handReady = false; handBusy = false; palmTimes = [];
  if (!keepError) handError = null;
}

// may a raised hand take a photo right now?
function handLooking(){
  return panel.classList.contains('hidden') && el('pinPad').hidden && el('infoBox').hidden &&
         !picking && !counting && !shotPending && !shotBusy && performance.now() > handPauseUntil;
}

// the result of one look
function handResult(palms){
  const now = performance.now();
  if (palms > 0) palmTimes.push(now);
  palmTimes = palmTimes.filter(t => now - t < HAND_WINDOW);
  el('handHint').classList.toggle('seen', palmTimes.length > 0);
  if (palmTimes.length >= HAND_NEED && handLooking()) {
    palmTimes = [];
    handPauseUntil = now + HAND_PAUSE;
    el('handHint').classList.remove('seen');
    takeShot(true);                       // always with countdown: time to lower the hand
  }
}

// send the current camera frame (upright) to the worker
async function sendHand(){
  handBusy = true;
  try {
    let bm;
    if (camRot) {
      const [uw, uh] = uprightSize();
      handCanvas.width = uw; handCanvas.height = uh;
      drawUpright(handCanvas.getContext('2d'), uw, uh);
      bm = await createImageBitmap(handCanvas);
    } else bm = await createImageBitmap(video);
    if (!handWorker) { bm.close(); handBusy = false; return; }
    handWorker.postMessage({type: 'frame', bitmap: bm}, [bm]);
  } catch (e) { handBusy = false; }
}

// note under the setting
function updateHandNote(){
  const n = el('handNote');
  const txt = !useVideo ? t('handNoteCam') : handError ? t('handNoteFail') : !handReady ? t('handNoteLoading') : t('handNoteOk');
  n.hidden = !handOn.checked;
  if (n.textContent !== txt) n.textContent = txt;   // (called often: only touch the page on a change)
}

// the hint for visitors at the bottom of the screen
function updateHandHint(){
  el('handHint').hidden = !(handReady && handOn.checked && useVideo &&
                            panel.classList.contains('hidden') && !counting && el('qrBox').hidden);
}

// every HAND_EVERY ms: start or stop the worker as needed, and send a frame when free
setInterval(() => {
  const want = handOn.checked && useVideo;
  if (want && !handWorker && !handError) startHand();
  else if (!want && handWorker) { stopHand(); updateHandNote(); }
  updateHandNote();
  updateHandHint();
  if (handWorker && handReady && !handBusy && handLooking() && video.readyState >= 2 && video.videoWidth) sendHand();
}, HAND_EVERY);

handOn.addEventListener('change', () => {
  if (!handOn.checked) stopHand();
  else handError = null;                  // try again
  if (!photosOn() || !shotQR.checked) hideQR();
  updateHandNote(); updateShotUI(); save();
});
updateHandNote();
