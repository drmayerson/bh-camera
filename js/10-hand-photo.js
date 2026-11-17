'use strict';
if (!window.BHC_READY) throw new Error('Black hole camera: not started (see the message on screen)');

/* =====================================================================================
   Black hole camera — 10: raise a hand for a photo (no touching)
   -------------------------------------------------------------------------------------
   With "Hand opsteken" ticked under Foto's (and the camera on), a visitor holds an open
   hand up to the camera for a moment: the photo is taken (after the countdown, if that is
   ticked) and its QR code shown, as with a click.

   The hand recognition is MediaPipe's gesture recogniser (the same library as the person
   recognition in 07), in its own Web Worker on the processor, a few times per second.
   A hand counts as open when the recogniser calls it an open palm, or when four fingers
   are stretched out. Every other look zooms into the middle and upper part of the picture
   (where raised hands are), so hands further from the camera are found too.

   Photos are only taken while the settings are closed and no photo is being taken; after
   a photo it waits a few seconds, so one raised hand gives one photo. While the settings
   are open it keeps looking, and the note under the option says what it sees (for testing).
   ===================================================================================== */

const handOn = el('handOn');
const HAND_MODEL = 'https://storage.googleapis.com/mediapipe-models/gesture_recognizer/gesture_recognizer/float16/1/gesture_recognizer.task';
const HAND_EVERY = 200;                   // ms between two looks
const HAND_NEED = 2, HAND_WINDOW = 1500;  // an open hand in 2 looks within 1.5 s: take a photo
const HAND_PAUSE = 8000;                  // ms after a photo before a hand counts again
const HAND_ZOOM = [0.15, 0, 0.7, 0.7];    // every other look: this part of the picture (x, y, w, h)

// The worker's own code. Messages:
//   in:  {type: 'init', lib, model}    load MediaPipe and the gesture model
//        {type: 'frame', bitmap}       look at one camera frame
//   out: {type: 'ready'} / {type: 'error', message} / {type: 'result', hands, open}
const HAND_SRC = `
let rec = null;
async function loadLib(base){
  // same loading trick as the person recognition (07-background-removal.js)
  const txt = await (await fetch(base + '/vision_bundle.cjs')).text();
  self.module = {exports: {}}; self.exports = self.module.exports;
  importScripts(URL.createObjectURL(new Blob([txt], {type: 'text/javascript'})));
  return self.module.exports;
}
// four fingers stretched out: each fingertip clearly further from the wrist than the
// finger's middle joint (hand landmarks: 0 wrist, 6/10/14/18 joints, 8/12/16/20 tips)
function fingersOpen(lm){
  const d = (a, b) => Math.hypot(lm[a].x - lm[b].x, lm[a].y - lm[b].y);
  let n = 0;
  for (const [tip, pip] of [[8, 6], [12, 10], [16, 14], [20, 18]]) if (d(tip, 0) > 1.15*d(pip, 0)) n++;
  return n >= 4;
}
self.onmessage = async e => {
  const d = e.data;
  if (d.type === 'init') {
    try {
      const mp = await loadLib(d.lib);
      const files = await mp.FilesetResolver.forVisionTasks(d.lib + '/wasm');
      rec = await mp.GestureRecognizer.createFromOptions(files, {
        baseOptions: {modelAssetPath: d.model, delegate: 'CPU'}, runningMode: 'IMAGE', numHands: 4,
        minHandDetectionConfidence: 0.35, minHandPresenceConfidence: 0.35});
      self.postMessage({type: 'ready'});
    } catch (err) { self.postMessage({type: 'error', message: String(err && err.message || err)}); }
  } else if (d.type === 'frame') {
    let hands = 0, open = 0;
    try {
      const res = rec.recognize(d.bitmap);
      const lms = res.landmarks || [], gs = res.gestures || [];
      hands = lms.length;
      for (let i = 0; i < hands; i++) {
        const g = gs[i] && gs[i][0];
        if ((g && g.categoryName === 'Open_Palm' && g.score > 0.5) || fingersOpen(lms[i])) open++;
      }
    } catch (err) { self.postMessage({type: 'error', message: String(err && err.message || err)}); return; }
    finally { d.bitmap.close(); }
    self.postMessage({type: 'result', hands, open});
  }
};`;

let handWorker = null;                    // the running worker (or null)
let handReady = false;                    // model loaded
let handBusy = false;                     // a frame is being looked at
let handError = null;                     // why it does not work (shown in the note)
let handTurn = 0;                         // counts looks: odd ones zoom in (HAND_ZOOM)
let palmTimes = [];                       // times (ms) of recent looks that saw an open hand
let handPauseUntil = 0;                   // no new photo by hand before this time
let handSeen = null;                      // what is seen now: {hands, open, at}, for the note
let handLast = [{hands: 0, open: 0}, {hands: 0, open: 0}];   // the last two looks
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
    else if (d.type === 'result') { handBusy = false; handResult(d.hands, d.open); }
  };
  handWorker.onerror = e => { handError = e.message || 'worker'; stopHand(true); updateHandNote(); };
  handWorker.postMessage({type: 'init', lib: MP, model: HAND_MODEL});
  updateHandNote();
}

function stopHand(keepError){
  if (handWorker) handWorker.terminate();
  handWorker = null; handReady = false; handBusy = false; palmTimes = []; handSeen = null;
  handLast = [{hands: 0, open: 0}, {hands: 0, open: 0}];
  if (!keepError) handError = null;
}

const settingsOpen = () => !panel.classList.contains('hidden');

// may a raised hand take a photo right now?
function handLooking(){
  return !settingsOpen() && el('pinPad').hidden && el('infoBox').hidden &&
         !picking && !counting && !shotPending && !shotBusy && performance.now() > handPauseUntil;
}

// the result of one look
function handResult(hands, open){
  const now = performance.now();
  // what is seen, for the note while the settings are open: the larger counts of the last
  // two looks (one of the whole picture, one zoomed in)
  handLast = [{hands, open}, handLast[0]];
  handSeen = {hands: Math.max(hands, handLast[1].hands), open: Math.max(open, handLast[1].open), at: now};
  if (settingsOpen()) updateHandNote();
  if (open > 0) palmTimes.push(now);
  palmTimes = palmTimes.filter(t => now - t < HAND_WINDOW);
  el('handHint').classList.toggle('seen', palmTimes.length > 0);
  if (palmTimes.length >= HAND_NEED && handLooking()) {
    palmTimes = [];
    handPauseUntil = now + HAND_PAUSE;
    el('handHint').classList.remove('seen');
    takeShot();                           // (with the countdown if that is ticked)
  }
}

// send the current camera frame (upright; every other time only the HAND_ZOOM part) to the worker
async function sendHand(){
  handBusy = true;
  try {
    let src = video, sw = video.videoWidth, sh = video.videoHeight;
    if (camRot) {
      [sw, sh] = uprightSize();
      handCanvas.width = sw; handCanvas.height = sh;
      drawUpright(handCanvas.getContext('2d'), sw, sh);
      src = handCanvas;
    }
    const z = handTurn++ % 2 ? HAND_ZOOM : [0, 0, 1, 1];
    const bm = await createImageBitmap(src, Math.round(z[0]*sw), Math.round(z[1]*sh), Math.round(z[2]*sw), Math.round(z[3]*sh));
    if (!handWorker) { bm.close(); handBusy = false; return; }
    handWorker.postMessage({type: 'frame', bitmap: bm}, [bm]);
  } catch (e) { handBusy = false; }
}

// note under the setting; while the settings are open it also says what is seen right now
function updateHandNote(){
  const n = el('handNote');
  let txt = !useVideo ? t('handNoteCam') : handError ? t('handNoteFail') : !handReady ? t('handNoteLoading') : t('handNoteOk');
  if (useVideo && handReady && !handError && settingsOpen() && handSeen && performance.now() - handSeen.at < 1500)
    txt += ' ' + t('handLive', {hands: handSeen.hands, open: handSeen.open});
  n.hidden = !handOn.checked;
  if (n.textContent !== txt) n.textContent = txt;   // (called often: only touch the page on a change)
}

// the hint for visitors at the bottom of the screen
function updateHandHint(){
  el('handHint').hidden = !(handReady && handOn.checked && useVideo &&
                            !settingsOpen() && !counting && el('qrBox').hidden);
}

// every HAND_EVERY ms: start or stop the worker as needed, and send a frame when free
// (also while the settings are open, for the note; photos only when handLooking())
setInterval(() => {
  const want = handOn.checked && useVideo;
  if (want && !handWorker && !handError) startHand();
  else if (!want && handWorker) { stopHand(); updateHandNote(); }
  updateHandNote();
  updateHandHint();
  if (handWorker && handReady && !handBusy && (handLooking() || settingsOpen()) && video.readyState >= 2 && video.videoWidth) sendHand();
}, HAND_EVERY);

handOn.addEventListener('change', () => {
  if (!handOn.checked) stopHand();
  else handError = null;                  // try again
  if (!photosOn() || !shotQR.checked) hideQR();
  updateHandNote(); updateShotUI(); save();
});
updateHandNote();
