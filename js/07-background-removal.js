'use strict';
if (!window.BHC_READY) throw new Error('Black hole camera: not started (see the message on screen)');

/* =====================================================================================
   Black hole camera — 07: background removal
   -------------------------------------------------------------------------------------
   The camera picture's background can be replaced by the star sky (or a background
   picture), so the visitor floats in front of the black hole. Modes (setting bgMode):
     off   : nothing removed;
     green : colour key (green screen); the colour is picked by clicking in the picture,
             the shader does the rest;
     booth : background model that learns by itself which pixels never change, guided by a
             person-recognition network (DeepLab, also run on zoomed-in tiles so that small,
             distant people are found). Anything that differs from the background is shown,
             at any distance; the network also fills holes (clothes the colour of the wall);
     ai    : person recognition only (MediaPipe selfie model), for one person close by;
     plate : background model from a recorded empty scene, no network (works offline).
   The networks run in a Web Worker so the black hole keeps running smoothly. The result is
   a person mask (1 = person) at PROC_W pixels wide, uploaded to the mask texture.

   Contents: 1. working buffers   2. recording an empty scene   3. background model per
   frame   4. mask clean-up helpers   5. person recognition (worker)   6. mode switching
   7. green screen: picking the colour (and the click that takes a photo)
   ===================================================================================== */

const usesPlate = () => bgMode.value === 'plate' || bgMode.value === 'booth';   // modes with a background model


// ---------- 1. working buffers ----------

const PROC_W = 320;                      // working resolution of the mask (width)
const proc = document.createElement('canvas');
const pctx = proc.getContext('2d', {willReadFrequently: true});
let maskReady = false, maskBytes = null;

// background model (planar RGB of the lightly blurred frame), scratch space:
//   BR, BG, BB   background colour per pixel        bVar   its noise variance
//   bCount       frames the background was learned  still  frames in a row without change
//   CR, CG, CB   the current frame                  T1, T2 scratch
//   pmask        soft mask (0..1)                   pnear  > 0 close to something that differs
//   pbin         hard mask (0/1)                    pseen, pstack, plist: scratch for cleanMask
let BR, BG, BB, bVar, bCount, CR, CG, CB, T1, T2, pmask, pnear, pbin, pseen, pstack, plist, still;
// aiMask: latest network mask (0..1); plateValid: there is a background model;
// learnStartAt: booth mode starts learning at this time; gA, gB: camera drift correction
let aiMask = null, plateValid = false, learnStartAt = 0, gA = [1, 1, 1], gB = [0, 0, 0];

// (Re)make the buffers when the camera picture's shape changed. Returns true if it did
// (everything learned so far is then forgotten).
function sizeProc(){
  const [uw, uh] = uprightSize();
  const w = PROC_W, h = Math.max(1, Math.round(PROC_W*uh/uw));
  if (proc.width === w && proc.height === h && BR) return false;
  proc.width = w; proc.height = h;
  const n = w*h, f = () => new Float32Array(n);
  BR = f(); BG = f(); BB = f(); bVar = f(); bCount = new Uint16Array(n);
  CR = f(); CG = f(); CB = f(); T1 = f(); T2 = f(); pmask = f(); pnear = f();
  pbin = new Uint8Array(n); pseen = new Uint8Array(n); pstack = new Int32Array(n); plist = new Int32Array(n);
  still = new Uint16Array(n);
  maskBytes = new Uint8Array(n); aiMask = null; plateValid = false; learnStartAt = 0; maskReady = false;
  return true;
}

// current camera frame (small, upright) into CR/CG/CB; counts unchanged pixels in `still`
function readFrame(){
  const w = proc.width, h = proc.height, n = w*h;
  // downscaling (about 4-6x, to PROC_W) already averages away most sensor noise
  pctx.imageSmoothingEnabled = true; pctx.imageSmoothingQuality = 'high';
  drawUpright(pctx, w, h);
  const px = pctx.getImageData(0, 0, w, h).data;
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    const r = px[j], g = px[j+1], b = px[j+2], dr = r - CR[i], dg = g - CG[i], db = b - CB[i];
    // frames in a row that this pixel did not change (beyond noise)
    if (dr*dr + dg*dg + db*db < 8*bVar[i] + 20) { if (still[i] < 65535) still[i]++; } else still[i] = 0;
    CR[i] = r; CG[i] = g; CB[i] = b;
  }
}
const VAR0 = 24, VAR_MIN = 12;            // noise variance (sum over r,g,b) of a working pixel


// ---------- 2. recording an empty scene ----------
// (button), for 'plate' and as a clean start for 'booth': 3-2-1 on screen, then the
// average of CAP_FRAMES frames becomes the background

const CAP_FRAMES = 15;
let capTimer = null, cap = null;          // countdown timer; sums while recording
function cancelCapture(){
  if (capTimer) { clearInterval(capTimer); capTimer = null; hideBanner(); }
  cap = null;
}
el('plateBtn').addEventListener('click', () => {
  if (!useVideo) { updateNote(); return; }
  cancelCapture();
  let left = 3;
  showBanner(t('stepOut', {n: left}), {big: true, cancel: true});
  capTimer = setInterval(async () => {
    left--;
    if (left > 0) { showBanner(t('stepOut', {n: left}), {big: true, cancel: true}); return; }
    clearInterval(capTimer); capTimer = null;
    showBanner(t('capturing'), {big: true});
    if (lockCam.checked) await lockCamera(true);
    setTimeout(() => {
      sizeProc();
      const n = proc.width*proc.height;
      cap = {left: CAP_FRAMES, r: new Float32Array(n), g: new Float32Array(n), b: new Float32Array(n), q: new Float32Array(n)};
    }, 500);
  }, 1000);
});

// one frame of the recording (called from plateStep); the last one sets the background
function captureStep(){
  const n = proc.width*proc.height;
  for (let i = 0; i < n; i++) {
    cap.r[i] += CR[i]; cap.g[i] += CG[i]; cap.b[i] += CB[i];
    cap.q[i] += CR[i]*CR[i] + CG[i]*CG[i] + CB[i]*CB[i];
  }
  if (--cap.left > 0) return;
  const N = CAP_FRAMES;
  for (let i = 0; i < n; i++) {
    const r = cap.r[i]/N, g = cap.g[i]/N, b = cap.b[i]/N;
    BR[i] = r; BG[i] = g; BB[i] = b;
    bVar[i] = Math.max(VAR_MIN, cap.q[i]/N - r*r - g*g - b*b);
    bCount[i] = 600;
  }
  boxBlur(bVar, T1, proc.width, proc.height, 3);
  pmask.fill(0); gA = [1, 1, 1]; gB = [0, 0, 0]; plateValid = true; cap = null;
  showBanner(t('capDone'), {big: true}); setTimeout(hideBanner, 1800);
  updateNote();
}

// "Opnieuw leren": forget the background (booth mode)
el('relearnBtn').addEventListener('click', () => {
  plateValid = false; learnStartAt = 0;
  if (worker) worker.postMessage({type: 'reset'});
  updateNote();
});


// ---------- 3. one camera frame through the background model ----------
// Called by the render loop for every new camera frame in 'plate' and 'booth' mode.

function plateStep(){
  const booth = bgMode.value === 'booth';
  if (sizeProc()) updateNote();
  const w = proc.width, h = proc.height, n = w*h;
  readFrame();
  if (cap) { captureStep(); return; }

  // 0. no background yet
  if (!plateValid) {
    if (!booth) return;                   // 'plate' needs a recorded empty scene
    // booth: start learning from the current frame (after locking the camera)
    const now = performance.now();
    if (!learnStartAt) { learnStartAt = now + (lockCam.checked ? 800 : 0); if (lockCam.checked) lockCamera(true); }
    if (now < learnStartAt) return;
    // wait (up to 15 s) for the network, so people standing in view now are not learned
    if (worker && !workerError && !aiMask && now < learnStartAt + 15000) return;
    BR.set(CR); BG.set(CG); BB.set(CB); bVar.fill(VAR0); bCount.fill(1); pmask.fill(0);
    if (aiMask) {                         // where people are, the background is still unknown
      T2.set(aiMask); boxBlur(T2, T1, w, h, 4);
      for (let i = 0; i < n; i++) if (T2[i] > 0.05) bCount[i] = 0;
    }
    gA = [1, 1, 1]; gB = [0, 0, 0]; plateValid = true; updateNote();
  }

  // 1. exposure / white-balance drift of the camera: per colour channel
  //    current = a*background + b, fitted over pixels that were clearly background
  const C = [CR, CG, CB], Bk = [BR, BG, BB];
  for (let ch = 0; ch < 3; ch++) {
    const X = Bk[ch], Y = C[ch];
    let cnt = 0, sx = 0, sy = 0, sxx = 0, sxy = 0;
    for (let i = 0; i < n; i += 2) if (pmask[i] < 0.1 && bCount[i] >= 3) {
      const x = X[i], y = Y[i]; cnt++; sx += x; sy += y; sxx += x*x; sxy += x*y;
    }
    if (cnt < 0.025*n) continue;
    const mx = sx/cnt, my = sy/cnt, vx = sxx/cnt - mx*mx;
    let A = vx > 100 ? (sxy/cnt - mx*my)/vx : my/Math.max(1, mx);
    A = Math.min(2, Math.max(0.5, A));
    const B = Math.min(60, Math.max(-60, my - A*mx));
    gA[ch] = 0.8*gA[ch] + 0.2*A; gB[ch] = 0.8*gB[ch] + 0.2*B;
  }
  const g0 = gA[0], g1 = gA[1], g2 = gA[2], o0 = gB[0], o1 = gB[1], o2 = gB[2];

  // 2. difference with the background, in units of the local noise level
  const f = Math.pow(2, (5 - Number(plateSens.value))/2.5), shadow = shadows.checked;
  for (let i = 0; i < n; i++) {
    const r = g0*BR[i] + o0, g = g1*BG[i] + o1, b = g2*BB[i] + o2, cr = CR[i], cg = CG[i], cb = CB[i];
    const dr = cr - r, dg = cg - g, db = cb - b;
    let d2 = dr*dr + dg*dg + db*db;
    if (shadow) {                         // darker but same colour: a shadow, not a person
      const bb = r*r + g*g + b*b;
      if (bb > 400) {
        const al = (cr*r + cg*g + cb*b)/bb;
        if (al > 0.45 && al < 1.0) {
          const er = cr - al*r, eg = cg - al*g, eb = cb - al*b;
          d2 = Math.min(d2, 2*(er*er + eg*eg + eb*eb));
        }
      }
    }
    T2[i] = Math.sqrt(d2)/(f*(6 + 3*Math.sqrt(bVar[i])));
  }
  boxBlur(T2, T1, w, h, 1);
  for (let i = 0; i < n; i++) { pbin[i] = T2[i] > 1 ? 1 : 0; pnear[i] = pbin[i]; }
  boxBlur(pnear, T1, w, h, 6);            // pnear > 0: close to something that differs

  // 3. booth: the network fills holes in people the background model already sees, and
  //    covers pixels whose background is not known yet
  const ai = booth ? aiMask : null;
  if (ai) for (let i = 0; i < n; i++) if (ai[i] > 0.5 && (pnear[i] > 0.01 || bCount[i] < 3)) pbin[i] = 1;
  cleanMask(pbin, w, h);

  // 4. learn the background
  if (ai) { T2.set(ai); boxBlur(T2, T1, w, h, 4); }   // T2: people according to the network, widened
  const kSlow = booth ? 1/600 : 1/1500;   // ~20 s resp. ~50 s at 30 frames per second
  // Something that differs but has not moved for a few seconds, where the network sees
  // nobody (a moved chair, the spot where someone stood at the start), is absorbed quickly.
  const ABSORB = 0.03;
  for (let i = 0; i < n; i++) {
    const c = bCount[i], base = Math.max(kSlow, 1/(c + 1));
    // k: how fast this pixel's background follows the current frame (0 = not at all)
    let k;
    if (!booth) k = pnear[i] > 0.02 ? 0 : base;           // never near something that differs
    // (a "person" that has not moved at all for a minute is a poster or a statue)
    else if (ai) k = T2[i] > 0.05   ? (still[i] > 1800 ? ABSORB : 0)   // the network sees a person
                   : !pbin[i]       ? base                             // background
                   : still[i] > 90  ? ABSORB                           // differs, but still and nobody there
                   :                  0.25*base;
    else k = !pbin[i]       ? (pnear[i] > 0.02 ? 0.3*base : base)       // no network: background
           : still[i] > 300 ? ABSORB                                    // differs, but has not moved
           :                  0.1*base;
    if (!k) continue;
    const er = (CR[i] - o0)/g0 - BR[i], eg = (CG[i] - o1)/g1 - BG[i], eb = (CB[i] - o2)/g2 - BB[i];
    BR[i] += k*er; BG[i] += k*eg; BB[i] += k*eb;
    if (!pbin[i] && c > 0) {
      const v = bVar[i];
      bVar[i] = Math.max(VAR_MIN, v + k*(Math.min(er*er + eg*eg + eb*eb, 4*v) - v));
    }
    if (c < 65535) bCount[i] = c + 1;
  }

  // 5. soft edge, upload
  for (let i = 0; i < n; i++) pmask[i] = pbin[i];
  boxBlur(pmask, T1, w, h, 2);
  for (let i = 0; i < n; i++) maskBytes[i] = pmask[i]*255;
  uploadMask(maskBytes, w, h); maskReady = true;
}


// ---------- 4. mask clean-up helpers ----------

// Remove small specks of foreground and fill small holes inside foreground (4-connected).
function cleanMask(bin, w, h){
  const n = w*h, minBlob = Math.max(20, n*0.0015), maxHole = n*0.015;
  for (let pass = 0; pass < 2; pass++) {
    const v = pass === 0 ? 1 : 0;         // pass 0: specks of foreground; pass 1: holes
    pseen.fill(0);
    for (let s0 = 0; s0 < n; s0++) {
      if (bin[s0] !== v || pseen[s0]) continue;
      // flood fill from s0: collect the connected region in plist
      let top = 0, cnt = 0, border = false;
      pstack[top++] = s0; pseen[s0] = 1;
      while (top) {
        const p = pstack[--top]; plist[cnt++] = p;
        const x = p % w;
        if (x === 0 || x === w - 1 || p < w || p >= n - w) border = true;
        if (x > 0     && bin[p - 1] === v && !pseen[p - 1]) { pseen[p - 1] = 1; pstack[top++] = p - 1; }
        if (x < w - 1 && bin[p + 1] === v && !pseen[p + 1]) { pseen[p + 1] = 1; pstack[top++] = p + 1; }
        if (p >= w    && bin[p - w] === v && !pseen[p - w]) { pseen[p - w] = 1; pstack[top++] = p - w; }
        if (p < n - w && bin[p + w] === v && !pseen[p + w]) { pseen[p + w] = 1; pstack[top++] = p + w; }
      }
      // too small (and, for a hole, not touching the edge): flip it
      if (pass === 0 ? cnt < minBlob : (!border && cnt < maxHole))
        for (let k = 0; k < cnt; k++) bin[plist[k]] = 1 - v;
    }
  }
}

// separable box blur of radius r, in place (tmp is scratch space of the same size)
function boxBlur(a, tmp, w, h, r){
  const inv = 1/(2*r + 1);
  // horizontal: a -> tmp (running sum)
  for (let y = 0; y < h; y++) {
    const o = y*w; let s = 0;
    for (let x = -r; x <= r; x++) s += a[o + Math.min(w - 1, Math.max(0, x))];
    for (let x = 0; x < w; x++) {
      tmp[o + x] = s*inv;
      s += a[o + Math.min(w - 1, x + r + 1)] - a[o + Math.max(0, x - r)];
    }
  }
  // vertical: tmp -> a
  for (let x = 0; x < w; x++) {
    let s = 0;
    for (let y = -r; y <= r; y++) s += tmp[Math.min(h - 1, Math.max(0, y))*w + x];
    for (let y = 0; y < h; y++) {
      a[y*w + x] = s*inv;
      s += tmp[Math.min(h - 1, y + r + 1)*w + x] - tmp[Math.max(0, y - r)*w + x];
    }
  }
}


// ---------- 5. person recognition in a Web Worker ----------

const MP = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14';
const MODELS = {
  // MediaPipe selfie segmenter: one or a few people close to the camera
  selfie:  {url: 'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/1/selfie_segmenter.tflite', cls: -1, inW: 320, prefer: 'GPU', gapMs: 0},
  // DeepLab v3 (PASCAL VOC, class 15 = person): people anywhere in a scene
  deeplab: {url: 'https://storage.googleapis.com/mediapipe-models/image_segmenter/deeplab_v3/float32/1/deeplab_v3.tflite', cls: 15, inW: 513, prefer: 'CPU', gapMs: 150},
};
// overlapping quarter tiles (fractions of the frame); one is analysed per round, next to
// the whole frame, so distant people are seen about 1.7x larger by the network
const TILES = [[0, 0, 0.6, 0.6], [0.4, 0, 0.6, 0.6], [0, 0.4, 0.6, 0.6], [0.4, 0.4, 0.6, 0.6]];

// The worker's own code (it runs separately, from this text). Messages:
//   in:  {type: 'init', lib, model, cls, prefer}   load MediaPipe and the model
//        {type: 'frame', bitmap, rects, outW, outH, inW}   analyse these regions
//        {type: 'reset'}                           forget the stored masks
//   out: {type: 'ready', delegate} / {type: 'error', message} / {type: 'mask', mask, w, h, ms}
const WORKER_SRC = `
let seg = null, cls = -1;
const store = {};                         // latest mask per image region
async function loadLib(base){
  // the CommonJS build works in a classic worker (the ES module build needs importScripts,
  // which module workers lack); the CDN serves it with a non-script MIME type, hence the blob
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
      const opts = delegate => ({baseOptions: {modelAssetPath: d.model, delegate}, runningMode: 'IMAGE',
        outputCategoryMask: false, outputConfidenceMasks: true});
      // the large model runs on the processor: on the graphics chip it competes with
      // drawing the black hole (measured: 60 -> 12 frames per second on a laptop)
      const order = d.prefer === 'CPU' ? ['CPU', 'GPU'] : ['GPU', 'CPU'];
      let delegate = order[0];
      try { seg = await mp.ImageSegmenter.createFromOptions(files, opts(order[0])); }
      catch (err) { delegate = order[1]; seg = await mp.ImageSegmenter.createFromOptions(files, opts(order[1])); }
      cls = d.cls;
      self.postMessage({type: 'ready', delegate});
    } catch (err) { self.postMessage({type: 'error', message: String(err && err.message || err)}); }
  } else if (d.type === 'reset') {
    for (const k in store) delete store[k];
  } else if (d.type === 'frame') {
    const t0 = performance.now(), bm = d.bitmap, W = bm.width, H = bm.height, oW = d.outW, oH = d.outH;
    try {
      for (const reg of d.rects) {
        const r = reg.r, sw = r[2]*W, sh = r[3]*H;
        const crop = await createImageBitmap(bm, r[0]*W, r[1]*H, sw, sh,
          {resizeWidth: d.inW, resizeHeight: Math.max(1, Math.round(d.inW*sh/sw)), resizeQuality: 'medium'});
        seg.segment(crop, res => {
          const ms = res.confidenceMasks, m = cls < 0 ? ms[ms.length - 1] : ms[cls];
          const f = m.getAsFloat32Array(), mw = m.width, mh = m.height;
          const x0 = Math.floor(r[0]*oW), y0 = Math.floor(r[1]*oH);
          const x1 = Math.min(oW, Math.ceil((r[0] + r[2])*oW)), y1 = Math.min(oH, Math.ceil((r[1] + r[3])*oH));
          const data = new Float32Array((x1 - x0)*(y1 - y0));
          for (let y = y0; y < y1; y++) {
            const v = Math.min(mh - 1, Math.max(0, Math.floor(((y + 0.5)/oH - r[1])/r[3]*mh)));
            for (let x = x0; x < x1; x++) {
              const u = Math.min(mw - 1, Math.max(0, Math.floor(((x + 0.5)/oW - r[0])/r[2]*mw)));
              data[(y - y0)*(x1 - x0) + (x - x0)] = f[v*mw + u];
            }
          }
          store[reg.id] = {oW, oH, x0, y0, x1, y1, data};
        });
        crop.close();
      }
    } catch (err) { self.postMessage({type: 'error', message: String(err && err.message || err)}); return; }
    finally { bm.close(); }
    const out = new Uint8Array(oW*oH);
    for (const k in store) {
      const s = store[k];
      if (s.oW !== oW || s.oH !== oH) continue;
      const sw = s.x1 - s.x0;
      for (let y = s.y0; y < s.y1; y++) for (let x = s.x0; x < s.x1; x++) {
        const v = s.data[(y - s.y0)*sw + (x - s.x0)]*255, o = y*oW + x;
        if (v > out[o]) out[o] = v;
      }
    }
    self.postMessage({type: 'mask', mask: out, w: oW, h: oH, ms: performance.now() - t0}, [out.buffer]);
  }
};`;

let aiCanvas = null;                      // scratch canvas for a camera on its side
let worker = null,                        // the running Web Worker (or null)
    workerModel = null,                   // 'selfie' or 'deeplab'
    workerReady = false,                  // model loaded
    workerBusy = false,                   // a frame is being analysed (plus the pause after it)
    workerError = null,                   // why the network failed (shown in the note)
    tileTurn = 0,                         // which of the TILES is analysed next
    aiMs = 0,                             // time per round (ms, smoothed), for bhcStats()
    aiDelegateNote = '';                  // 'GPU' or 'CPU': where the network runs, for bhcStats()

function startWorker(model){
  if (worker && workerModel === model) return;
  stopWorker();
  workerModel = model; workerError = null;
  try {
    worker = new Worker(URL.createObjectURL(new Blob([WORKER_SRC], {type: 'text/javascript'})));
  } catch (e) { workerError = String(e); worker = null; updateNote(); return; }
  worker.onmessage = onWorker;
  worker.onerror = e => { workerError = e.message || 'worker'; stopWorker(true); updateNote(); };
  worker.postMessage({type: 'init', lib: MP, model: MODELS[model].url, cls: MODELS[model].cls, prefer: MODELS[model].prefer});
}

function stopWorker(keepError){
  if (worker) worker.terminate();
  worker = null; workerReady = false; workerBusy = false; aiMask = null;
  if (!keepError) { workerModel = null; workerError = null; }
}

// a message from the worker
function onWorker(e){
  const d = e.data;
  if (d.type === 'ready') { workerReady = true; aiDelegateNote = d.delegate || ''; updateNote(); }
  else if (d.type === 'error') { console.error('person recognition:', d.message); workerError = d.message; stopWorker(true); updateNote(); }
  else if (d.type === 'mask') {
    aiMs = 0.7*aiMs + 0.3*d.ms;
    // a short pause between rounds leaves room for drawing (booth mode)
    const gap = workerModel ? MODELS[workerModel].gapMs : 0;
    if (gap) setTimeout(() => { workerBusy = false; }, gap); else workerBusy = false;
    if (!BR || d.w !== proc.width || d.h !== proc.height) return;   // made for an older picture size
    const n = d.w*d.h;
    if (!aiMask || aiMask.length !== n) aiMask = new Float32Array(n);
    if (bgMode.value === 'ai') {                 // used directly: smooth a little over time
      for (let i = 0; i < n; i++) { aiMask[i] = 0.3*aiMask[i] + 0.7*d.mask[i]/255; maskBytes[i] = aiMask[i]*255; }
      uploadMask(maskBytes, d.w, d.h); maskReady = true;
    } else {
      for (let i = 0; i < n; i++) aiMask[i] = d.mask[i]/255;
    }
  }
}

// send the current camera frame to the worker (the render loop calls this when it is free)
async function sendAI(){
  workerBusy = true;
  const m = MODELS[workerModel], rects = [{id: 'full', r: [0, 0, 1, 1]}];
  if (workerModel === 'deeplab') { const t = tileTurn++ % TILES.length; rects.push({id: 'tile' + t, r: TILES[t]}); }
  try {
    // the networks need people upright: turn a sideways camera picture first
    let bm;
    if (camRot) {
      const [uw, uh] = uprightSize(), c = aiCanvas || (aiCanvas = document.createElement('canvas'));
      c.width = uw; c.height = uh; drawUpright(c.getContext('2d'), uw, uh);
      bm = await createImageBitmap(c);
    } else bm = await createImageBitmap(video);
    if (!worker) { bm.close(); return; }
    worker.postMessage({type: 'frame', bitmap: bm, rects, outW: proc.width, outH: proc.height, inW: m.inW}, [bm]);
  } catch (e) { workerBusy = false; }
}


// ---------- 6. mode switching and explanations ----------

function bgNote(t){ el('bgNote').textContent = t || ''; }
function aiStatus(){
  if (workerError) return t('aiFail');
  if (!workerReady) return t('aiLoading');
  return '';
}

// the explanation under the background-removal setting
function updateNote(){
  const m = bgMode.value;
  if (m === 'off') bgNote('');
  else if (m === 'green') bgNote(t('greenNote'));
  else if (!useVideo) bgNote(t('camFirst'));
  else if (m === 'booth') bgNote(t('boothNote') + ' ' + (aiStatus() || t('aiHelps')) +
    (workerError ? ' ' + t('boothOnlyLearned') : '') + (plateValid ? '' : ' ' + t('starting')));
  else if (m === 'ai') bgNote((aiStatus() ? aiStatus() + ' ' : '') + (workerError ? t('aiTryPlate') : t('aiNote')));
  else if (m === 'plate') bgNote(plateValid ? t('plateOk') : t('plateNeed'));
}

// after a change of mode (or camera): show the right options, start or stop the network
function bgChanged(){
  const m = bgMode.value;
  el('subGreen').hidden = m !== 'green';
  el('subBackdrop').hidden = m === 'off';
  updateDock();
  el('subPlate').hidden = !usesPlate();
  el('relearnBtn').hidden = m !== 'booth';
  el('showMaskRow').hidden = m === 'off';
  if (m === 'off') showMask.checked = false;
  maskReady = false;
  if (!usesPlate()) { cancelCapture(); lockCamera(false); }
  else if (plateValid && lockCam.checked) lockCamera(true);
  const model = !useVideo ? null : m === 'booth' ? 'deeplab' : m === 'ai' ? 'selfie' : null;
  if (!model) stopWorker();
  else if (workerModel !== model || (!worker && !workerError)) startWorker(model);
  updateNote(); save();
}
bgMode.addEventListener('change', () => { if (workerError) stopWorker(); bgChanged(); });


// ---------- 7. green screen: pick the key colour by clicking on the plain camera image ----------

let picking = false;                      // waiting for a click on the colour
const pickCan = document.createElement('canvas');
function startPicking(){
  picking = true;
  document.body.classList.add('picking');
  showBanner(t('pickBanner'), {cancel: true});
}
function stopPicking(){
  if (!picking) return;
  picking = false;
  document.body.classList.remove('picking');
  hideBanner();
}
el('pickBtn').addEventListener('click', startPicking);
document.addEventListener('keydown', e => { if (e.key === 'Escape') { stopPicking(); cancelCapture(); } });

// A click in the picture: picks the colour while picking, otherwise takes a photo (if on;
// shotsOn and takeShot are in 09-photos.js).
canvas.addEventListener('click', e => {
  if (!picking) { if (shotsOn.checked) takeShot(); return; }
  const r = canvas.getBoundingClientRect();
  const {xs, ys, cw, ch} = geom();
  // same mapping as the RAW_PASS shader (screen -> mirrored camera coordinate)
  const x = xs*((e.clientX - r.left)/r.width - 0.5), y = ys*(0.5 - (e.clientY - r.top)/r.height);
  const u = 0.5 - x/cw, v = 0.5 + y/ch;           // texture coordinate, v up
  const src = useVideo ? video : demo;
  const sw = useVideo ? video.videoWidth : demo.width, sh = useVideo ? video.videoHeight : demo.height;
  if (!sw || !sh) return;
  // same turn as camTC() in the shader, for a camera on its side
  const [ru, rv] = !useVideo || !camRot ? [u, v] : camRot === 1 ? [1 - v, u] : [v, 1 - u];
  // average colour of a 9 x 9 pixel square around the click
  const cx = Math.round(ru*sw), cy = Math.round((1 - rv)*sh), R = 4;
  pickCan.width = 2*R + 1; pickCan.height = 2*R + 1;
  const c = pickCan.getContext('2d', {willReadFrequently: true});
  c.drawImage(src, cx - R, cy - R, 2*R + 1, 2*R + 1, 0, 0, 2*R + 1, 2*R + 1);
  const d = c.getImageData(0, 0, 2*R + 1, 2*R + 1).data;
  let s = [0, 0, 0], k = 0;
  for (let i = 0; i < d.length; i += 4) if (d[i+3] > 0) { s[0] += d[i]; s[1] += d[i+1]; s[2] += d[i+2]; k++; }
  if (k) { keyRGB = s.map(t => Math.round(t/k)); labels(); save(); }
  stopPicking();
});
