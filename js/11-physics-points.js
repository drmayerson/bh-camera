'use strict';
if (!window.BHC_READY) throw new Error('Black hole camera: not started (see the message on screen)');

/* =====================================================================================
   Black hole camera — 11: physics explanation points
   -------------------------------------------------------------------------------------
   Four small pulsing rings on the picture; tapping one explains what the light did there:
     weak    a bit of bending (light that passed the black hole at a distance)
     n1      half way around: light that came from behind the camera (bent by more than
             90 degrees); the broad starry ring around the shadow is this light
     n2      once all the way around (a very thin ring close to the shadow)
     shadow  the light falls into the black hole
   Where these are depends on mass, spin, viewing angle and screen. So after every change
   of the lens map, the shader measures the bending along four lines from the centre
   (PROBE_PASS in 01, read back here), and each point is put where its kind of light is.

   Settings: "Uitlegpunten in het beeld" (pointsOn) and the visitor button to hide them
   (keepPoints); hidden by a visitor, they come back by themselves after 2 minutes.
   ===================================================================================== */

const PROBE_N = 4096;                     // samples per probe line
// direction of each probe line (degrees, 0 = right, counter-clockwise), one per point
const PROBE_ROWS = ['n1', 'n2', 'weak', 'shadow'];
const PROBE_ANG = [20, 160, 55, 250].map(d => d*Math.PI/180);
const POINTS_BACK_MS = 120000;            // hidden by a visitor: back after 2 minutes

let progProbe = null, probeTex = null, probeFbo = null, probeBuf = null;
let probeFailed = false;                  // this computer cannot read the probe back
let probeDirty = true;                    // measure again (set by the render loop, 12-main.js)
let pointsHiddenUntil = 0;                // hidden by a visitor until this time
const pointInfo = {};                     // per point: {defl (radians), kind (1 camera / 2 sky)}

// ---------- measuring ----------

// Draw the probe pass into a small float texture (PROBE_N x 4) and read it back: for each
// line `row`, PROBE_N samples from distance from[row] to to[row]. Returns a copy of the
// result, or null when this computer cannot do that (the points then stay hidden).
function readProbe(from, to){
  if (!mapType) return null;
  if (!progProbe) progProbe = program('#define PROBE_PASS\n');
  if (!probeTex) {
    probeTex = gl.createTexture(); probeFbo = gl.createFramebuffer();
    gl.bindTexture(gl.TEXTURE_2D, probeTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texImage2D(gl.TEXTURE_2D, 0, mapType.internal, PROBE_N, 4, 0, gl.RGBA, mapType.type, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, probeFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, probeTex, 0);
    probeBuf = new Float32Array(PROBE_N*4*4);
  }
  gl.getError();                          // (clear an older error, so the check below is ours)
  gl.bindFramebuffer(gl.FRAMEBUFFER, probeFbo);
  gl.viewport(0, 0, PROBE_N, 4);
  setUniforms(progProbe);
  gl.uniform4f(progProbe.u.uProbeAng, PROBE_ANG[0], PROBE_ANG[1], PROBE_ANG[2], PROBE_ANG[3]);
  gl.uniform4f(progProbe.u.uProbeFrom, from[0], from[1], from[2], from[3]);
  gl.uniform4f(progProbe.u.uProbeTo, to[0], to[1], to[2], to[3]);
  gl.uniform1f(progProbe.u.uProbeN, PROBE_N);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  gl.readPixels(0, 0, PROBE_N, 4, gl.RGBA, gl.FLOAT, probeBuf);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  return gl.getError() === gl.NO_ERROR ? probeBuf.slice() : null;
}

// Measure and put the points in place. Called from the render loop after the lens map
// was computed again (so after a change of setting or screen size).
function runProbe(){
  probeDirty = false;
  const {xs, ys} = geom();
  const R = Math.hypot(xs, ys)/2;         // probe lines reach the corners
  const W = canvas.clientWidth, H = canvas.clientHeight, margin = 34;

  // a probe result as samples: bending, kind (0 shadow, 1 camera, 2 sky), screen position
  const lineOf = (buf, row, from, to) => {
    const out = [];
    for (let i = 0; i < PROBE_N; i++) {
      const o = (row*PROBE_N + i)*4, r = from + (to - from)*(i + 0.5)/PROBE_N, a = PROBE_ANG[row];
      const left = (r*Math.cos(a)/xs + 0.5)*W, top = (0.5 - r*Math.sin(a)/ys)*H;
      out.push({defl: Math.abs(buf[o]), kind: Math.round(buf[o + 1]), r, left, top,
                onScreen: left > margin && left < W - margin && top > margin && top < H - margin});
    }
    return out;
  };
  // the sample whose bending is closest to `target` (within `tol`), on screen, passing `test`
  const closest = (line, target, tol, test) => {
    let best = null, bestD = tol;
    for (const s of line) {
      if (s.kind === 0 || !s.onScreen || (test && !test(s))) continue;
      const d = Math.abs(s.defl - target);
      if (d < bestD) { bestD = d; best = s; }
    }
    return best;
  };

  let coarse = null, fine = null;
  try {
    // 1. all four lines, from the centre to the corners
    coarse = readProbe([0, 0, 0, 0], [R, R, R, R]);
    // 2. the "once round" ring is far thinner than one coarse sample: measure again, finely,
    //    just outside the edge of the shadow on its line
    if (coarse) {
      const line = lineOf(coarse, 1, 0, R), e = line.findIndex(s => s.kind !== 0);
      if (e > 0) {
        const r0 = line[e - 1].r, r1 = line[Math.min(PROBE_N - 1, e + 6)].r;
        fine = {from: r0, to: r1, buf: readProbe([r0, r0, r0, r0], [r1, r1, r1, r1])};
      }
    }
  } catch (e) { console.warn('physics points:', e); gl.bindFramebuffer(gl.FRAMEBUFFER, null); }
  if (!coarse) { probeFailed = true; updatePointsUI(); return; }

  const found = {};
  // half way around: in the middle of the starry ring (about 130 degrees, at least 95);
  // otherwise wherever the bending is closest to 180 degrees
  const l0 = lineOf(coarse, 0, 0, R);
  found.n1 = closest(l0, 2.3, 0.6, s => s.kind === 2 && s.defl > 1.65) || closest(l0, Math.PI, 0.7);
  // once all the way around: the camera picture once more, bent by about 360 degrees
  found.n2 = fine && fine.buf ? closest(lineOf(fine.buf, 1, fine.from, fine.to), 2*Math.PI, 0.7, s => s.kind === 1) : null;
  // a bit of bending: about 11 degrees, on the camera picture
  found.weak = closest(lineOf(coarse, 2, 0, R), 0.2, 0.2, s => s.kind === 1);
  // shadow: half way out to the edge of the shadow along its line
  const l3 = lineOf(coarse, 3, 0, R), edge = l3.findIndex(s => s.kind !== 0);
  const sh = edge > 8 ? l3[Math.floor(edge*0.5)] : null;
  found.shadow = sh && sh.kind === 0 && sh.onScreen ? sh : null;

  for (const k of PROBE_ROWS) {
    const b = document.querySelector('.pt[data-k="' + k + '"]'), s = found[k];
    pointInfo[k] = s;
    b.hidden = !s;
    if (s) { b.style.left = s.left.toFixed(1) + 'px'; b.style.top = s.top.toFixed(1) + 'px'; }
  }
  updatePointsUI();
}


// ---------- showing ----------

const pointsOn = el('pointsOn');

// the points are visible when switched on, not hidden by a visitor, and the normal
// picture is shown (not while picking a colour or showing the mask)
function updatePointsUI(){
  const now = performance.now();
  const show = pointsOn.checked && !probeFailed && now > pointsHiddenUntil && !picking &&
               !(showMask.checked && bgMode.value !== 'off');
  el('points').hidden = !show;
  el('pointsBtn').setAttribute('aria-pressed', String(now > pointsHiddenUntil));
  el('pointsNote').hidden = !(pointsOn.checked && probeFailed);
}
setInterval(updatePointsUI, 500);

// visitor button: hide the points (they come back after 2 minutes), or show them again
el('pointsBtn').addEventListener('click', () => {
  pointsHiddenUntil = performance.now() > pointsHiddenUntil ? performance.now() + POINTS_BACK_MS : 0;
  updatePointsUI();
});
pointsOn.addEventListener('change', () => { probeDirty = true; updateDock(); updatePointsUI(); save(); });


// ---------- the explanation of one point ----------

let pointTimer = null, pointShown = null;
function showPoint(k){
  pointShown = k;
  const s = pointInfo[k] || {};
  el('pointTitle').textContent = t('pt_' + k + 'T');
  // n1: the text says what is shown there: star sky, background picture, or camera picture
  const bdShown = bdReady && bdChoice.value !== 'stars' && bgMode.value !== 'off';
  const variant = k !== 'n1' ? '' : s.kind === 1 ? 'Cam' : bdShown ? 'Bd' : '';
  el('pointText').textContent = t('pt_' + k + variant);
  el('pointDefl').textContent = k === 'shadow' ? '' : t('ptBent', {d: Math.round(s.defl*180/Math.PI)});
  document.querySelectorAll('.point-art svg[data-k]').forEach(svg => { svg.hidden = svg.dataset.k !== k; });
  el('pointBox').hidden = false;
  clearTimeout(pointTimer);
  pointTimer = setTimeout(hidePoint, 60000);    // closes by itself after a minute
}
function hidePoint(){ el('pointBox').hidden = true; pointShown = null; clearTimeout(pointTimer); }

document.querySelectorAll('.pt').forEach(b => b.addEventListener('click', () => showPoint(b.dataset.k)));
el('pointClose').addEventListener('click', hidePoint);
el('pointBox').addEventListener('click', e => { if (e.target === el('pointBox')) hidePoint(); });   // tap outside the card
document.addEventListener('keydown', e => { if (e.key === 'Escape') hidePoint(); });
updatePointsUI();
