'use strict';
if (!window.BHC_READY) throw new Error('Black hole camera: not started (see the message on screen)');

/* =====================================================================================
   Black hole camera — 05: camera and expo helpers
   -------------------------------------------------------------------------------------
   - the webcam: start (1080p where possible), choose between several cameras, reconnect
     after it was unplugged, go back to the demo picture;
   - a camera mounted on its side: helpers that turn its picture upright;
   - fixing exposure / white balance / focus (for background removal);
   - expo helpers: keep the screen on, full screen (button or F), hide the mouse pointer.
   ===================================================================================== */


// ---------- camera ----------

const video = document.createElement('video');
video.muted = true;
video.setAttribute('playsinline', '');
video.setAttribute('autoplay', '');

let useVideo = false, lastVideoTime = -1;      // camera running; time of the last frame used
// camWanted: the camera should be on; remembered, so it restarts by itself after a
// reload (the browser must have been allowed to use the camera on this site).
// camDeviceId: the chosen camera when there are several (remembered as well).
let camWanted = !!(remembered && remembered.camOn);
let camDeviceId = (remembered && remembered.camId) || '';
let camErr = null, camRetry = null;            // text key of the current camera problem; reconnect timer

// note under the camera buttons: the camera problem, or else the privacy note
function updateCamNote(){
  el('camNote').textContent = camErr ? t(camErr) : t((el('shotsOn').checked || el('handOn').checked) && el('shotQR').checked ? 'privacyQR' : 'privacy');
}

// "Camera aan" and "Voorbeeldbeeld" work as a pair: the active one is coloured in
function updateCamUI(){
  const camB = el('camBtn'), demoB = el('demoBtn');
  camB.textContent = t(useVideo ? 'camIsOn' : 'camOn');
  camB.disabled = useVideo;
  camB.classList.toggle('primary', useVideo);
  camB.setAttribute('aria-pressed', String(useVideo));
  demoB.classList.toggle('primary', !useVideo);
  demoB.setAttribute('aria-pressed', String(!useVideo));
  updateCamNote();
}

function stopStream(){
  if (video.srcObject) {
    video.srcObject.getTracks().forEach(tr => { tr.onended = null; tr.stop(); });
    video.srcObject = null;
  }
}

// Start the camera. `auto`: started by the page itself (after a reload or a reconnect),
// not by a click; only changes which message is shown when it fails. Returns success.
async function startCamera(auto){
  const md = navigator.mediaDevices;
  if (!md || !md.getUserMedia) { camErr = 'camNoAccess'; updateCamNote(); return false; }
  const size = {width: {ideal: 1920}, height: {ideal: 1080}};   // a 720p-only camera simply gives 720p
  let stream = null;
  try {
    stream = await md.getUserMedia({audio: false, video: Object.assign(camDeviceId ? {deviceId: {exact: camDeviceId}} : {facingMode: 'user'}, size)});
  } catch (e) {
    // the chosen camera is not there (unplugged?): take any camera instead
    if (camDeviceId) {
      try { stream = await md.getUserMedia({audio: false, video: Object.assign({facingMode: 'user'}, size)}); } catch (e2) {}
    }
  }
  if (!stream) { camErr = auto ? 'camAutoFail' : 'camFail'; updateCamNote(); return false; }

  stopStream();
  video.srcObject = stream;
  try { await video.play(); } catch (e) { console.warn(e); }
  const track = stream.getVideoTracks()[0];
  if (track) track.onended = cameraLost;
  useVideo = true;
  dirty = true;
  lastVideoTime = -1;
  camLocked = false;                             // (declared further down in this file)
  camWanted = true;
  camErr = null;
  clearInterval(camRetry); camRetry = null;
  plateValid = false; learnStartAt = 0;          // background removal (07) starts learning again
  updateCamUI(); listCams(); bgChanged();
  return true;
}

// camera unplugged, switched off or taken by another program: keep trying every 3 s
function cameraLost(){
  if (!camWanted) return;
  camErr = 'camLost'; updateCamNote();
  clearInterval(camRetry);
  camRetry = setInterval(async () => {
    if (!camWanted) { clearInterval(camRetry); camRetry = null; return; }
    if (await startCamera(true)) { clearInterval(camRetry); camRetry = null; }
    else { camErr = 'camLost'; updateCamNote(); }
  }, 3000);
}

// cameras to choose from (names are only known once the camera has been allowed)
async function listCams(){
  const md = navigator.mediaDevices;
  if (!md || !md.enumerateDevices) return;
  let devs = [];
  try { devs = (await md.enumerateDevices()).filter(d => d.kind === 'videoinput'); } catch (e) { return; }
  const sel = el('camPick'), tr = video.srcObject && video.srcObject.getVideoTracks()[0];
  const cur = camDeviceId && devs.some(d => d.deviceId === camDeviceId) ? camDeviceId
    : (tr && tr.getSettings && tr.getSettings().deviceId) || '';
  sel.innerHTML = '';
  devs.forEach((d, i) => {
    const o = document.createElement('option');
    o.value = d.deviceId;
    o.textContent = d.label || t('camN', {n: i + 1});
    sel.appendChild(o);
  });
  if (cur && devs.some(d => d.deviceId === cur)) sel.value = cur;
  el('camPickRow').hidden = devs.length < 2;        // only shown with two or more cameras
}

el('camPick').addEventListener('change', async () => {
  camDeviceId = el('camPick').value; save();
  if (useVideo || camWanted) await startCamera(false);
});
if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) navigator.mediaDevices.addEventListener('devicechange', listCams);

el('camBtn').addEventListener('click', () => startCamera(false));

// "Demo": camera off, back to the demo picture
el('demoBtn').addEventListener('click', () => {
  stopStream();
  clearInterval(camRetry); camRetry = null;
  useVideo = false;
  upload(camTex, demo);
  camAspect = demo.height/demo.width;
  dirty = true;
  camWanted = false;
  camErr = null;
  updateCamUI();
  camLocked = false;
  cancelCapture(); bgChanged();
});


// ---------- camera on its side ----------

// the camera picture as it should stand (width/height swapped when the camera is on its side)
function uprightSize(){ return camRot ? [video.videoHeight, video.videoWidth] : [video.videoWidth, video.videoHeight]; }

// draw the current camera frame upright into a w x h canvas context
function drawUpright(ctx, w, h){
  const [vw, vh] = [video.videoWidth, video.videoHeight];
  ctx.save();
  if (camRot === 1) { ctx.scale(w/vh, h/vw); ctx.translate(vh, 0); ctx.rotate(Math.PI/2); }
  else if (camRot === 3) { ctx.scale(w/vh, h/vw); ctx.translate(0, vw); ctx.rotate(-Math.PI/2); }
  else ctx.scale(w/vw, h/vh);
  ctx.drawImage(video, 0, 0);
  ctx.restore();
}


// ---------- fixing the camera's automatic settings ----------

// Fix exposure, white balance and focus (where browser and camera allow it), so the
// picture doesn't change when someone walks in. The current values are kept.
let camLocked = false;
async function lockCamera(on){
  const t = video.srcObject && video.srcObject.getVideoTracks()[0];
  if (!t || !t.getCapabilities || on === camLocked) return;
  camLocked = on;
  const caps = t.getCapabilities(), st = t.getSettings ? t.getSettings() : {};
  const mode = on ? 'manual' : 'continuous';
  // [mode setting, value that goes with it]
  for (const [k, v] of [['exposureMode', 'exposureTime'], ['whiteBalanceMode', 'colorTemperature'], ['focusMode', 'focusDistance']]) {
    if (!Array.isArray(caps[k]) || !caps[k].includes(mode)) continue;
    const c = {[k]: mode};
    if (on && st[v] != null) c[v] = st[v];
    try { await t.applyConstraints({advanced: [c]}); } catch (e) { console.warn('camera lock', k, e); }
  }
}


// ---------- expo helpers: screen stays on, full screen, hidden mouse pointer ----------

let wakeLock = null;
async function keepAwake(){
  try {
    if ('wakeLock' in navigator && document.visibilityState === 'visible' && !wakeLock) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    }
  } catch (e) { /* not supported or not allowed: the computer's own power settings apply */ }
}
// the browser releases the lock when the page is hidden: ask again when it is back
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') keepAwake(); });
keepAwake();

// (iPhone Safari cannot show a web page full screen: there the button is not shown)
const canFullscreen = typeof document.documentElement.requestFullscreen === 'function';
function toggleFullscreen(){
  if (!canFullscreen) return;
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  else document.documentElement.requestFullscreen().catch(() => {});
}
el('fsBtn').hidden = !canFullscreen;
el('fsBtn').addEventListener('click', toggleFullscreen);
// the button is coloured in while the page is full screen (also when switched with F or Esc)
function updateFsBtn(){
  const on = !!document.fullscreenElement;
  el('fsBtn').classList.toggle('primary', on);
  el('fsBtn').setAttribute('aria-pressed', String(on));
}
document.addEventListener('fullscreenchange', updateFsBtn);
updateFsBtn();
document.addEventListener('keydown', e => {   // F: full screen (Esc leaves it)
  if ((e.key === 'f' || e.key === 'F') && !e.ctrlKey && !e.metaKey && !e.altKey && !e.repeat &&
      !(e.target && (e.target.isContentEditable || /^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName)))) toggleFullscreen();
});

// mouse pointer: hidden after 3 s without movement (class "idle" on the body)
let idleTimer = null;
function wake(){
  document.body.classList.remove('idle');
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => document.body.classList.add('idle'), 3000);
}
['mousemove', 'mousedown', 'touchstart', 'keydown'].forEach(ev => document.addEventListener(ev, wake, {passive: true}));
wake();
