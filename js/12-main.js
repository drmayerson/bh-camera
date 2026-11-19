'use strict';
if (!window.BHC_READY) throw new Error('Black hole camera: not started (see the message on screen)');

/* =====================================================================================
   Black hole camera — 12: render loop and start-up
   -------------------------------------------------------------------------------------
   - the render loop: every screen refresh, take the newest camera frame, run the
     background removal, and draw (computing the lens map again only after a change);
     at start it first measures the screen's refresh rate, which the automatic picture
     quality is judged against;
   - console helpers for staff: bhcStats(), bhcOffline();
   - the remaining settings: "Onthouden", camera on its side, picture quality, language;
   - start-up: the offline cache, then everything shown as it was left last time.
   ===================================================================================== */


// ---------- render loop ----------

let plateMs = 0;                          // time per frame of the background model (ms, smoothed)
// automatic picture quality: frame time (smoothed), since when it is too slow, and until
// when not to measure (just after a change)
let lastFrameT = 0, slowAvg = 16, slowSince = 0, settleUntil = 0;
// and its way back up: smooth since when, when it last went up, and no going up before
// (after going up made it too slow again, it waits 15 minutes)
let fastSince = 0, raisedAt = -1e9, noRaiseUntil = 0;

// The screen's own refresh interval (16.7 ms at 60 Hz, 20 at 50 Hz, 33 at 30 Hz), measured
// at start: the first CALIB_FRAMES refreshes draw nothing, so each takes exactly one
// refresh. "Too slow" and "smooth" are judged against it (never stricter than 60 Hz).
const CALIB_FRAMES = 40;
let calib = {left: CALIB_FRAMES, last: 0, dts: []};
let refreshMs = 1000/60;
const pace = () => Math.max(refreshMs, 1000/60);   // the frame time to aim for
function calibrate(now){
  if (document.visibilityState !== 'visible') { calib.last = 0; return; }   // (hidden: wait)
  if (calib.last) calib.dts.push(now - calib.last);
  calib.last = now;
  if (--calib.left > 0) return;
  // a quarter of the way up the sorted intervals: ignores the odd late refresh
  const d = calib.dts.filter(x => x > 4).sort((a, b) => a - b);
  if (d.length >= 10) refreshMs = d[Math.floor(d.length/4)];
  slowAvg = pace();
  calib = null;
}

// One screen refresh. The next one is requested first, and errors are caught, so that one
// error (in a photo, say) can never freeze the picture at an unattended booth.
// The same error in every frame for about 5 s is treated like a lost picture (pictureLost).
let frameErrors = 0;                      // errors in a row
function frame(now){
  requestAnimationFrame(frame);
  if (calib) { calibrate(now); return; }  // (the first refreshes: measuring the screen)
  try {
    drawFrame(now);
    frameErrors = 0;
  } catch (e) {
    if (++frameErrors <= 5) console.error('frame:', e);   // (log the first few only)
    shotPending = false; shotBusy = false;               // a photo that failed: ready for the next
    if (frameErrors === 300) pictureLost();
  }
}

// Automatic picture quality (setting "Automatisch"): from the time since the last frame,
// draw fewer pixels (autoScale, used by resize() in 04) while the picture is too slow, and
// more again after it has been smooth for a while. Frames just after a change (which
// recompute the lens map) are not measured.
function autoQuality(now){
  if (quality !== 'auto' || !lastFrameT || now <= settleUntil || document.visibilityState !== 'visible') return;
  const dt = now - lastFrameT;
  if (dt < 500) slowAvg = 0.9*slowAvg + 0.1*dt;
  // too slow: clearly slower than the screen shows (frames are skipped); at 60 Hz that is
  // 22.5 ms per frame, about 45 frames per second
  if (slowAvg > pace()*1.35 && canvas.width*canvas.height > minPx()*1.05) {
    fastSince = 0;
    if (!slowSince) slowSince = now;
    else if (now - slowSince > 3000) {     // too slow for 3 s: draw 30% fewer pixels
      autoScale *= 0.7;
      if (now - raisedAt < 30000) noRaiseUntil = now + 15*60000;   // going up did not work
      slowSince = 0; slowAvg = pace(); settleUntil = now + 2000;
    }
  } else {
    slowSince = 0;
    // smooth (at the screen's refresh rate) for 2 minutes: draw more pixels again
    if (slowAvg < pace()*1.1 && autoScale < 1 && now > noRaiseUntil) {
      if (!fastSince) fastSince = now;
      else if (now - fastSince > 120000) {
        autoScale = Math.min(1, autoScale/0.7);
        fastSince = 0; raisedAt = now; settleUntil = now + 2000;
      }
    } else fastSince = 0;
  }
}

// Draw one frame: new camera frame -> background removal -> lens map (only after a change)
// -> picture on screen; then a photo, and the physics points, if they are waiting.
function drawFrame(now){
  autoQuality(now);
  lastFrameT = now;
  resize();

  // a new camera frame: into the texture, and through the background removal
  if (useVideo && video.readyState >= 2 && video.videoWidth && video.currentTime !== lastVideoTime) {
    lastVideoTime = video.currentTime;
    upload(camTex, video);
    const [uw, uh] = uprightSize(), a = uh/uw;
    if (Math.abs(a - camAspect) > 1e-6) { camAspect = a; dirty = true; }
    const m = bgMode.value;
    try {
      if (usesPlate()) {
        const t0 = performance.now();
        plateStep();
        plateMs = 0.9*plateMs + 0.1*(performance.now() - t0);
      }
      else if (m === 'ai') sizeProc();
      if (worker && workerReady && !workerBusy && (m === 'ai' || m === 'booth')) sendAI();
    } catch (e) { console.error(e); }
  }

  // draw: plain camera picture (colour picking / mask view), via the lens map, or directly
  const W = canvas.width, H = canvas.height;
  gl.viewport(0, 0, W, H);
  if (picking || (showMask.checked && bgMode.value !== 'off')) {
    setUniforms(progRaw); bindTextures(); gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  } else if (progMap && allocMap(W, H)) {
    if (dirty) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, mapFbo);
      setUniforms(progMap); gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      dirty = false; settleUntil = performance.now() + 400;   // recomputing is not "slow drawing"
      probeDirty = true;                  // the physics points must be measured again (11)
    }
    setUniforms(progDisp); bindTextures(); gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  } else {
    setUniforms(progDirect); bindTextures(); gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  if (shotPending) grabShot();            // a photo: read the picture while it is still there
  // physics points (11): measure after a change; not in the first second, so the first
  // picture is not held up by compiling the measuring shader
  if (probeDirty && pointsOn.checked && !probeFailed && now > 1000) runProbe();
}


// ---------- console helpers for staff ----------

// timings for checking a booth computer (console: bhcStats())
let fpsCount = 0, fpsT0 = performance.now(), fpsNow = 0;
(function fpsTick(){
  fpsCount++;
  const now = performance.now();
  if (now - fpsT0 >= 2000) { fpsNow = Math.round(fpsCount*1000/(now - fpsT0)); fpsCount = 0; fpsT0 = now; }
  requestAnimationFrame(fpsTick);
})();
window.bhcStats = () => {
  const pct = (a, test) => a ? Math.round(100*a.reduce((s, v) => s + (test(v) ? 1 : 0), 0)/a.length) + '%' : '-';
  return {
    fps: fpsNow, screenHz: Math.round(1000/refreshMs), drawn: canvas.width + 'x' + canvas.height, quality,
    camera: video.videoWidth ? video.videoWidth + 'x' + video.videoHeight : '-', camRot,
    maskMs: +plateMs.toFixed(1), networkMs: +aiMs.toFixed(0), network: workerModel, on: aiDelegateNote, ready: workerReady, error: workerError,
    shownAsPerson: pct(pbin, v => v), networkPerson: pct(aiMask, v => v > 0.5), backgroundUnknown: pct(bCount, v => v < 3)
  };
};


// ---------- remember settings ----------

function updateRememberNote(){
  el('rememberNote').textContent = el('remember').checked ? t('rememberOn') : t('rememberOff');
}
el('remember').addEventListener('change', () => {
  if (el('remember').checked) {                 // keep what is set now
    save();
    if (ownBlob) idbSet('ownBackdrop', ownBlob).catch(() => {});
    if (shotDir) idbSet('shotDir', shotDir).catch(() => {});
  } else {                                      // forget what was stored (this session keeps working)
    save();
    idbSet('ownBackdrop', null).catch(() => {}); idbSet('shotDir', null).catch(() => {});
  }
  updateRememberNote();
});

// "Alles terugzetten": forget everything (also the PIN) and start again
el('resetAll').addEventListener('click', async () => {
  if (!confirm(t('resetConfirm'))) return;
  try { localStorage.removeItem(KEY); localStorage.removeItem(PIN_KEY); } catch (e) {}
  await idbSet('ownBackdrop', null).catch(() => {}); await idbSet('shotDir', null).catch(() => {});
  location.reload();
});
updateRememberNote();


// ---------- offline cache (sw.js) ----------
// after one visit with internet, the page also starts without it

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch(e => console.warn('offline cache not available', e));
}
// console: bhcOffline() lists what is kept for offline use
window.bhcOffline = async () => {
  if (!window.caches) return 'no offline cache in this browser';
  const out = {};
  for (const k of await caches.keys()) {
    const reqs = await (await caches.open(k)).keys();
    out[k] = reqs.map(r => r.url.replace(location.origin, '').replace(/^https:\/\//, '').slice(0, 90));
  }
  return out;
};


// ---------- camera on its side, picture quality ----------

el('camRot').value = String(camRot);
el('quality').value = quality;

function updateCamRotHint(){
  // portrait screen + landscape camera: suggest mounting the camera on its side
  const portrait = innerHeight > innerWidth, landscapeCam = useVideo && video.videoWidth > video.videoHeight;
  const show = portrait && landscapeCam && !camRot;
  el('camRotHint').hidden = !show && !camRot;
  el('camRotHint').textContent = show ? t('camRotPortrait') : camRot ? t('camRotHint') : '';
}
el('camRot').addEventListener('change', () => {
  camRot = Number(el('camRot').value); dirty = true; lastVideoTime = -1;
  plateValid = false; learnStartAt = 0; maskReady = false;     // the background must be learned again
  if (worker) worker.postMessage({type: 'reset'});
  updateCamRotHint(); save();
});
el('quality').addEventListener('change', () => {
  quality = el('quality').value; autoScale = 1; slowSince = 0; slowAvg = pace();
  try { sessionStorage.removeItem(LOW_KEY); } catch (e) {}   // staff chose: no forced low quality
  resize(); updateQualityNote(); save();
});
window.addEventListener('resize', updateCamRotHint);
video.addEventListener('loadedmetadata', updateCamRotHint);
setInterval(updateCamRotHint, 3000);   // the camera's size is only known once it runs


// ---------- language buttons: redraw every text ----------

function setLang(l){
  if (!TXT[l] || l === lang) return;
  lang = l;
  applyStaticText();                      // the fixed texts of the page (02)
  // texts that are made by the code: a new text set by code needs its update function here too
  labels();                               // slider values (03)
  updateNote();                           // background-removal note (07)
  updateShotUI();                         // photo notes (09)
  qrSecLabel();                           // QR time (09)
  updateRememberNote();                   // (12)
  updateCamUI();                          // camera button and note (05)
  updatePinUI();                          // PIN note (06)
  updateQualityNote();                    // picture size (04)
  updateHandNote();                       // raise-a-hand note (10)
  if (pointShown) showPoint(pointShown);  // an open physics explanation (11)
  updateCamRotHint();                     // (12)
  setPanelHidden(panel.classList.contains('hidden'));   // gear label (06)
  if (bdNoteFn) bdNote(bdNoteFn);         // background-picture note (08)
  listCams();                             // camera names "Camera 1", ... (05)
  demo = makeDemo(); if (!useVideo) upload(camTex, demo);   // demo picture text (02)
  save();
}
document.querySelectorAll('.langs [data-lang]').forEach(b => b.addEventListener('click', () => setLang(b.dataset.lang)));


// ---------- start-up ----------

// the picture can be lost (graphics driver reset, laptop waking up): start again, with
// the same settings (they are remembered)
// Repeated losses (a weak GPU that cannot keep up) are counted in this tab: the restart then
// begins with fewer pixels (04-drawing.js), and after 3 losses within 3 minutes the page
// stops restarting and says so, instead of reloading forever; an unattended booth then
// tries again by itself after 5 minutes, at the lowest quality.
canvas.addEventListener('webglcontextlost', e => { e.preventDefault(); pictureLost(); });
let lostHandled = false;
function pictureLost(){
  if (lostHandled) return;
  lostHandled = true;
  const now = Date.now();
  let lost = [];
  try { lost = JSON.parse(sessionStorage.getItem(LOST_KEY) || '[]').filter(x => now - x < 180000); } catch (err) {}
  lost.push(now);
  try { sessionStorage.setItem(LOST_KEY, JSON.stringify(lost)); } catch (err) {}
  if (lost.length >= 3) {
    fail(t('glLoop'));
    try { sessionStorage.setItem(LOW_KEY, '1'); } catch (err) {}
    setTimeout(() => location.reload(), 5*60000);
    return;
  }
  fail(t('glLost'));
  setTimeout(() => location.reload(), 1500);
}

// the demo text is drawn on a canvas, so redraw it once the web font has arrived
if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => {
  demo = makeDemo(); if (!useVideo) upload(camTex, demo);
}).catch(() => {});

// show everything as it was left, start the camera if it was on, start drawing
updateCamUI(); listCams(); updateQualityNote(); updateCamRotHint();
bgChanged(); backdropChanged(); updateShotUI();
if (camWanted) startCamera(true);               // camera was on last time
requestAnimationFrame(frame);
