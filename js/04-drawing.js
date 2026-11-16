'use strict';
if (!window.ZGC_READY) throw new Error('Zwart gat camera: not started (see the message on screen)');

/* =====================================================================================
   Zwart gat camera — 04: drawing size and shader inputs
   -------------------------------------------------------------------------------------
   - picture size: how many pixels are drawn (picture quality), kept up to date with the
     window size;
   - geometry: how big the screen and the camera picture are in "lensing units";
   - setUniforms() / bindTextures(): hand all settings and textures to a shader program
     (used by the render loop in 10-main.js).
   ===================================================================================== */


// ---------- size ----------

// D: distance from the black hole to the viewpoint (must equal CAM_D in the shader);
// XSCALE: the shorter screen side. Both in lensing units, as in the exhibit.
const D = 200, XSCALE = D*Math.cos(0.3);

// Picture quality: how many pixels are drawn.
//  normal: at most 2.4 million (a laptop screen; enlarged on bigger screens)
//  high:   the screen's full resolution (up to about 4K)
//  auto:   full resolution, stepping down while the picture is too slow (frame rate below
//          ~45 for a few seconds), but never below "normal"
const NORMAL_PX = 2.4e6, HARD_PX = 9e6;    // HARD_PX: absolute limit, about 4K (3840 x 2160 = 8.3 million)
// largest picture this GPU can draw
const MAX_DIM = Math.min(gl.getParameter(gl.MAX_TEXTURE_SIZE), gl.getParameter(gl.MAX_RENDERBUFFER_SIZE) || 1e9,
                         ...Array.from(gl.getParameter(gl.MAX_VIEWPORT_DIMS)));
let autoScale = 1;                      // "auto" quality: fraction of the full pixel count (lowered by the render loop)

// Set the canvas to the number of pixels to draw. Called every frame (cheap when nothing
// changed); a new size makes the lens map be computed again.
function resize(){
  // device pixel ratio, capped at 2 (normal) or 3
  const dpr = Math.min(window.devicePixelRatio || 1, quality === 'normal' ? 2 : 3);
  let w = Math.round(canvas.clientWidth*dpr), h = Math.round(canvas.clientHeight*dpr);
  const full = w*h;
  let target = quality === 'normal' ? NORMAL_PX
             : quality === 'high' ? full
             : Math.max(NORMAL_PX, full*autoScale);
  target = Math.min(target, full, HARD_PX);
  const k = Math.min(1, Math.sqrt(target/full), MAX_DIM/Math.max(w, h));
  w = Math.max(1, Math.round(w*k)); h = Math.max(1, Math.round(h*k));
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w; canvas.height = h;
    dirty = true;
    updateQualityNote();
  }
}

// "Now drawn at w × h pixels" under the quality setting
function updateQualityNote(){
  const n = document.getElementById('qualityNote');
  if (!n || typeof t !== 'function') return;          // (t always exists by now: a harmless extra check)
  n.textContent = (quality === 'auto' ? t('qualityAuto') + ' ' : '') + t('qualityNow', {w: canvas.width, h: canvas.height});
}

window.addEventListener('resize', resize);
resize();


// ---------- geometry ----------

// Screen and camera-image size in lensing units.
function geom(){
  // Same geometry as the exhibit: the shorter screen side spans XSCALE lensing units
  // (the kiosk's portrait width); the corners must stay within the camera distance D.
  const W = canvas.width, H = canvas.height;
  let xs, ys;
  if (W <= H) { xs = XSCALE; ys = XSCALE*H/W; } else { ys = XSCALE; xs = XSCALE*W/H; }
  const half = Math.hypot(xs, ys)/2, lim = 195;      // 195: just inside D = 200 (the shader takes asin(b/CAM_D))
  if (half > lim) { xs *= lim/half; ys *= lim/half; }
  // camera image "covers" the screen without stretching
  const cw = Math.max(xs, ys/camAspect), ch = cw*camAspect;
  return {W, H, xs, ys, cw, ch};
}

// background removal currently in effect: 0 off, 1 colour key, 2 person mask
function activeBgMode(){
  const m = bgMode.value;
  if (m === 'green') return 1;
  if (m !== 'off' && useVideo && maskReady) return 2;
  return 0;
}


// ---------- shader inputs ----------

// Activate program P (from program() in 02-setup.js) and set all its uniforms.
// A uniform the program does not use is skipped (P.u has no entry for it).
// (picking is defined in 07, bdReady / bdChoice / bdAspect in 08; this only runs after start-up)
function setUniforms(P){
  gl.useProgram(P.p);
  const {W, H, xs, ys, cw, ch} = geom();
  const set1 = (n, v) => { if (P.u[n]) gl.uniform1f(P.u[n], v); };

  // screen, camera picture and black hole
  if (P.u.uResolution) gl.uniform2f(P.u.uResolution, W, H);
  if (P.u.uScreen) gl.uniform2f(P.u.uScreen, xs, ys);
  if (P.u.uCamScale) gl.uniform2f(P.u.uCamScale, cw, ch);
  set1('M', Number(mass.value)); set1('PsiScale', 1.0);
  set1('uSpin', Number(spin.value)); set1('uInclination', Number(incl.value)*Math.PI/180);

  // Starry zone: circle of half the shorter side (as in the exhibit). Outside it the camera
  // image fills the screen wherever the bending is small; that threshold scales with the
  // size of the black hole (weak-field bending 4M/b at the circle's edge, plus margin), so
  // no stray ring of stars appears at any size or screen shape.
  const Rfov = 0.5*Math.min(xs, ys), Mv = Number(mass.value);
  set1('uRing', 0.5); set1('uTol', 1.3*4*Mv/Rfov);

  // background removal and camera orientation
  set1('uBgMode', activeBgMode()); set1('uKeyTol', Number(keyTol.value));
  set1('uShowMask', showMask.checked && !picking ? 1 : 0);
  set1('uCamRot', useVideo ? camRot : 0);

  // background picture: cover the camera image, keep the picture's proportions
  set1('uUseBackdrop', bdReady && bdChoice.value !== 'sterren' && bgMode.value !== 'off' ? 1 : 0);
  if (P.u.uBdScale) {
    const r = bdAspect/camAspect;
    gl.uniform2f(P.u.uBdScale, r > 1 ? 1 : r, r > 1 ? 1/r : 1);
  }
  if (P.u.uBackdrop) gl.uniform1i(P.u.uBackdrop, 4);
  if (P.u.uKey) gl.uniform3f(P.u.uKey, keyRGB[0]/255, keyRGB[1]/255, keyRGB[2]/255);

  // texture units (must match bindTextures)
  if (P.u.textureft) gl.uniform1i(P.u.textureft, 0);
  if (P.u.texturebg) gl.uniform1i(P.u.texturebg, 1);
  if (P.u.uLensMap) gl.uniform1i(P.u.uLensMap, 2);
  if (P.u.uMask) gl.uniform1i(P.u.uMask, 3);
}

function bindTextures(){
  gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, camTex);
  gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, skyTex);
  gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, mapTex);
  gl.activeTexture(gl.TEXTURE3); gl.bindTexture(gl.TEXTURE_2D, maskTex);
  gl.activeTexture(gl.TEXTURE4); gl.bindTexture(gl.TEXTURE_2D, bdTex);
  gl.activeTexture(gl.TEXTURE0);
}
