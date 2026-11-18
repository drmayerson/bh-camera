'use strict';
if (!window.BHC_READY) throw new Error('Black hole camera: not started (see the message on screen)');

/* =====================================================================================
   Black hole camera — 11: physics explanation points
   -------------------------------------------------------------------------------------
   Four small pulsing rings on the picture; tapping one explains what the light did there:
     weak    a bit of bending (light that passed the black hole at a distance)
     n1      the broad starry ring: light bent so strongly that it came from beside or
             behind the camera (about half way round the black hole)
     uturn   a hairpin turn: light bent by about 180 degrees, from straight behind the
             camera. In this exhibit the camera picture also hangs behind the camera
             (mirrored), so this is the thin ring of "you" hugging the shadow; on the right
             of the equator
     n2      once all the way around: a ring of the camera picture even closer to the
             shadow, but usually far thinner than a pixel; on the left of the equator, and
             only shown when it is at least 1 pixel wide
     shadow  the light falls into the black hole
   Where these are depends on mass, spin, viewing angle and screen. So after every change
   of the lens map, the shader measures the bending along lines from the centre
   (PROBE_PASS in 01, read back here), and each point is put where its kind of light is.

   Settings: "Uitlegpunten in het beeld" (pointsOn) and the visitor button to hide them
   (keepPoints); hidden by a visitor, they come back by themselves after 2 minutes.
   ===================================================================================== */

const PROBE_N = 4096;                     // samples per probe line (4 lines per measurement)
const PROBE_ROWS = ['n1', 'uturn', 'n2', 'weak', 'shadow'];
const DEG = Math.PI/180;
const POINTS_BACK_MS = 120000;            // hidden by a visitor: back after 2 minutes

let progProbe = null, probeTex = null, probeFbo = null, probeBuf = null;
let probeFailed = false;                  // this computer cannot read the probe back
let probeDirty = true;                    // measure again (set by the render loop, 12-main.js)
let pointsHiddenUntil = 0;                // hidden by a visitor until this time
const pointInfo = {};                     // per point: {defl (radians), kind (1 camera / 2 sky)}

// ---------- measuring ----------

// Draw the probe pass into a small float texture (PROBE_N x 4) and read it back: line
// `row` goes in direction ang[row] (radians; 0 = right, counter-clockwise), with PROBE_N
// samples from distance from[row] to to[row] (lensing units). Returns the four lines of
// samples, or null when this computer cannot do that (the points then stay hidden).
function readProbe(ang, from, to){
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
  gl.uniform4f(progProbe.u.uProbeAng, ang[0], ang[1], ang[2], ang[3]);
  gl.uniform4f(progProbe.u.uProbeFrom, from[0], from[1], from[2], from[3]);
  gl.uniform4f(progProbe.u.uProbeTo, to[0], to[1], to[2], to[3]);
  gl.uniform1f(progProbe.u.uProbeN, PROBE_N);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  gl.readPixels(0, 0, PROBE_N, 4, gl.RGBA, gl.FLOAT, probeBuf);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  if (gl.getError() !== gl.NO_ERROR) return null;
  // each sample: bending (radians), kind (0 shadow, 1 camera picture, 2 sky), distance r, direction
  const lines = [];
  for (let row = 0; row < 4; row++) {
    const line = [];
    for (let i = 0; i < PROBE_N; i++) {
      const o = (row*PROBE_N + i)*4;
      line.push({defl: Math.abs(probeBuf[o]), kind: Math.round(probeBuf[o + 1]),
                 r: from[row] + (to[row] - from[row])*(i + 0.5)/PROBE_N, ang: ang[row]});
    }
    lines.push(line);
  }
  return lines;
}

// stretches of neighbouring samples that pass `test` (each: an array of samples)
function runsOf(line, test){
  const runs = [];
  let cur = null;
  for (const s of line) {
    if (test(s)) { if (!cur) runs.push(cur = []); cur.push(s); }
    else cur = null;
  }
  return runs;
}
const middleOf = run => run[Math.floor(run.length/2)];
const longest = runs => runs.reduce((a, b) => (b.length > (a ? a.length : 0) ? b : a), null);

// Measure and put the points in place. Called from the render loop after the lens map
// was computed again (so after a change of setting or screen size).
function runProbe(){
  probeDirty = false;
  const {xs, ys} = geom();
  const R = Math.hypot(xs, ys)/2;         // probe lines reach the corners
  const W = canvas.clientWidth, H = canvas.clientHeight, margin = 34;
  const screen = s => ({left: (s.r*Math.cos(s.ang)/xs + 0.5)*W, top: (0.5 - s.r*Math.sin(s.ang)/ys)*H});
  const onScreen = s => { const p = screen(s); return p.left > margin && p.left < W - margin && p.top > margin && p.top < H - margin; };
  const edgeOf = line => line.findIndex(s => s.kind !== 0);    // first sample outside the shadow

  const found = {};
  try {
    // 1. coarse: the equator to the right and to the left, and two lines in the upper half
    const A = readProbe([0, 180*DEG, 35*DEG, 145*DEG], [0, 0, 0, 0], [R, R, R, R]);
    if (!A) throw new Error('probe readback failed');

    // 2. the two thin rings of the camera picture right at the shadow are far thinner than
    //    one coarse sample, so measure again finely just outside the shadow, on both sides
    //    of the equator:
    //    - the hairpin turn (about 180 degrees): on the right;
    //    - once round (about 360 degrees): on the left, where it is widest for a spinning
    //      black hole, and only when it is at least 1 pixel wide (usually it is not).
    //    Always the same sides, so the points do not jump when a setting changes.
    const near = [0, 1].map(j => {
      const e = edgeOf(A[j]);
      return e > 0 ? [A[j][e - 1].r, A[j][Math.min(PROBE_N - 1, e + 24)].r] : [0, 0];
    });
    const B = readProbe([0, 180*DEG, 0, 0], [near[0][0], near[1][0], 0, 0], [near[0][1], near[1][1], 1, 1]);
    const n2side = 1;                     // which side of the equator: 0 right, 1 left
    let uturnSide = 0;
    if (B) {
      const camRun = (j, target) => near[j][1] > 0 ?
        longest(runsOf(B[j], s => s.kind === 1 && Math.abs(s.defl - target) < 1.0)) : null;
      const pxWide = (j, run) => run.length*(near[j][1] - near[j][0])/PROBE_N*W/xs;
      const n2 = camRun(1, 2*Math.PI);
      if (n2 && pxWide(1, n2) >= 1 && onScreen(middleOf(n2))) found.n2 = middleOf(n2);
      // the hairpin ring on the right; on the left only if there is none on the right (and
      // then not together with the once-round point, which would sit on top of it)
      const ut = [0, 1].map(j => camRun(j, Math.PI));
      uturnSide = ut[0] && onScreen(middleOf(ut[0])) ? 0 : 1;
      if (uturnSide === 1 && found.n2) found.n2 = null;
      if (ut[uturnSide] && onScreen(middleOf(ut[uturnSide]))) found.uturn = middleOf(ut[uturnSide]);
    }

    // 3. the broad starry ring, in the upper half on the other side: the widest stretch of
    //    sky that starts right next to strongly bent light (not the sky in the far corners),
    //    and the point in the middle of it
    const skyLine = A[n2side === 1 ? 2 : 3];
    const sky = longest(runsOf(skyLine, s => s.kind === 2).filter(run => run[0].defl > 1.5));
    if (sky && onScreen(middleOf(sky))) found.n1 = middleOf(sky);

    // 4. a little bending (about 11 degrees, on the camera picture): on the equator as well,
    //    on the left (the middle of the left edge has no buttons; the tap controls are on the
    //    right), far out on the line of the "once round" point. If that is off the screen (a
    //    large black hole on a narrow screen), the furthest spot that is still on it, as long
    //    as the bending there is small (below about 30 degrees).
    for (const line of [A[1], A[0]]) {
      let best = null, furthest = null;
      for (const s of line) {
        if (s.kind !== 1 || s.defl > 0.55 || !onScreen(s)) continue;
        if (!best || Math.abs(s.defl - 0.2) < Math.abs(best.defl - 0.2)) best = s;
        if (!furthest || s.r > furthest.r) furthest = s;
      }
      found.weak = best && Math.abs(best.defl - 0.2) < 0.05 ? best : furthest;
      if (found.weak) break;
    }

    // 5. two lines into the shadow: below the centre, and turned away from the hairpin point
    const shadowAng = [270*DEG, uturnSide === 0 ? 240*DEG : 300*DEG];
    const C = readProbe([shadowAng[0], shadowAng[1], 0, 0], [0, 0, 0, 0], [R, R, 1, 1]);
    if (C) {
      // the shadow: close to the centre (from 30% of the way to its edge outwards), at the
      // first spot whose ring stays clear of the other points; if there is none, the spot
      // with the most room, unless the rings would overlap badly (a very small black hole)
      const others = ['n1', 'uturn', 'n2', 'weak'].filter(k => found[k]).map(k => screen(found[k]));
      const room = s => { const p = screen(s); return Math.min(Infinity, ...others.map(o => Math.hypot(p.left - o.left, p.top - o.top))); };
      let sh = null, shRoom = -1;
      search: for (const row of [0, 1]) {
        const e = edgeOf(C[row]);
        if (e <= 8) continue;
        for (const frac of [0.3, 0.4, 0.5, 0.6]) {
          const s = C[row][Math.floor(e*frac)];
          if (s.kind !== 0 || !onScreen(s)) continue;
          const r = room(s);
          if (r > shRoom) { sh = s; shRoom = r; }
          if (r >= 40) break search;
        }
      }
      if (sh && shRoom >= 19) found.shadow = sh;   // (19 px: two rings of the smallest size, 16 px)
    }
  } catch (e) {
    console.warn('physics points:', e);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    probeFailed = true; updatePointsUI(); return;
  }

  // ring size: 34 px (times --ui on big screens, see style.css), smaller when points are
  // close together (a small black hole), so that they all still fit; at least 16 px
  const placed = PROBE_ROWS.filter(k => found[k]).map(k => screen(found[k]));
  let gap = Infinity;
  for (let i = 0; i < placed.length; i++)
    for (let j = i + 1; j < placed.length; j++)
      gap = Math.min(gap, Math.hypot(placed[i].left - placed[j].left, placed[i].top - placed[j].top));
  const ui = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--ui')) || 1;
  el('points').style.setProperty('--pt', Math.round(Math.max(16, Math.min(34*ui, gap*0.85))) + 'px');

  for (const k of PROBE_ROWS) {
    const b = document.querySelector('.pt[data-k="' + k + '"]'), s = found[k];
    pointInfo[k] = s;
    b.hidden = !s;
    if (s) { const p = screen(s); b.style.left = p.left.toFixed(1) + 'px'; b.style.top = p.top.toFixed(1) + 'px'; }
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


// ---------- the drawing on the card ----------

// The path of the light for point k, as a small picture: the camera on the left, the black
// hole in the middle, you (the camera picture) behind it on the right. The arrow shows
// where the light goes.
const POINT_RAYS = {
  // from you, past the black hole at a distance, into the camera: bent a little
  weak:   'M 264 70 C 220 40, 140 38, 50 72',
  // from the stars behind the camera, around the far side of the black hole, back to the camera
  n1:     'M 16 30 L 160 30 C 226 30, 232 120, 168 120 C 118 120, 78 96, 50 80',
  // from the mirror image of you behind the camera, a hairpin turn around the black hole
  uturn:  'M 24 34 L 160 34 C 222 34, 226 116, 168 116 C 120 116, 80 94, 50 80',
  // from you, once all the way around the black hole, then to the camera
  n2:     'M 264 74 L 170 50 A 25 25 0 1 0 170 100 A 25 25 0 1 0 170 50 C 128 50, 84 62, 50 74',
  // from you towards the camera, but too close to the black hole: it spirals in
  shadow: 'M 264 72 C 232 70, 206 58, 190 62 C 178 65, 182 82, 170 82 C 160 82, 158 70, 166 70'
};
function pointArt(k){
  const dots = [[62, 18], [98, 132], [128, 20], [232, 134], [250, 16], [292, 100], [206, 142], [114, 104], [292, 30]]
    .map(([x, y]) => '<circle cx="' + x + '" cy="' + y + '" r="1.2"/>').join('');
  const behind = k === 'n1' ? '<g fill="#fff"><circle cx="16" cy="30" r="3"/><circle cx="8" cy="52" r="1.7"/><circle cx="24" cy="12" r="1.5"/></g>'
               : k === 'uturn' ? '<g fill="#c3b6e0" opacity=".6"><circle cx="14" cy="34" r="6"/><path d="M3 62 C 3 44, 25 44, 25 62 z"/></g>'   // the mirror image of you
               : '';
  return '<svg viewBox="0 0 300 150" xmlns="http://www.w3.org/2000/svg">' +
    '<defs><marker id="ptArrow-' + k + '" viewBox="0 0 10 10" refX="7" refY="5" markerWidth="5" markerHeight="5" orient="auto">' +
      '<path d="M0 0 L10 5 L0 10 z" fill="#ff6c9c"/></marker></defs>' +
    '<g fill="#fff" opacity=".5">' + dots + '</g>' + behind +
    // black hole: a black disk, with a thin light outline so it shows on the dark card
    '<circle cx="170" cy="75" r="16" fill="#000" stroke="#c3b6e0" stroke-opacity=".7" stroke-width="1.2"/>' +
    // you (the camera picture, behind the black hole)
    '<g fill="#c3b6e0"><circle cx="276" cy="71" r="8"/><path d="M261 100 C 261 76, 291 76, 291 100 z"/></g>' +
    // the camera
    '<g fill="#f3ecff"><rect x="16" y="66" width="22" height="18" rx="3"/><path d="M38 70 L48 64 L48 86 L38 80 z"/></g>' +
    '<path class="ray" d="' + POINT_RAYS[k] + '" marker-end="url(#ptArrow-' + k + ')"/>' +
    '</svg>';
}


// ---------- the explanation of one point ----------

let pointTimer = null, pointShown = null;
function showPoint(k){
  pointShown = k;
  const s = pointInfo[k] || {};
  el('pointTitle').textContent = t('pt_' + k + 'T');
  // n1: the text says what is shown there: star sky, background picture, or camera picture
  const bdShown = bdReady && bdChoice.value !== 'stars' && bgMode.value !== 'off';
  const variant = k === 'n1' && bdShown ? 'Bd' : '';
  el('pointText').textContent = t('pt_' + k + variant);
  el('pointDefl').textContent = k === 'shadow' ? '' : t('ptBent', {d: Math.round(s.defl*180/Math.PI)});
  el('pointArt').innerHTML = pointArt(k);
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
