'use strict';

/* =====================================================================================
   Black hole camera — 02: setup
   -------------------------------------------------------------------------------------
   Everything the other files build on:
     - languages: t('key') gives a text in the current language (texts in texts.js);
     - WebGL: the drawing context, the shader programs, the textures (camera picture,
       star sky, person mask, background picture);
     - the generated star sky and the demo picture (shown until the camera is switched on);
     - the lens map: a float texture holding the bending per pixel, so that it only has
       to be computed again when a setting changes.

   How the script files work together
     The files in js/ are plain scripts, loaded in order by index.html. Names declared at
     the top level of one file (const, let, function) are visible in all later files.
     If WebGL is missing, this file stops with a message on screen and does not set
     window.BHC_READY; every later file checks that flag first and then stops too.
     A top-level statement may only use what earlier files (or the same file, above it)
     declared; functions may refer to anything, since they only run after start-up.

   Where to find what (numbers are the files in js/)
     taking a photo:   click in the picture (07, last section), arrow keys or the photo
                       button (09), or a raised hand (10) -> takeShot() (09) -> drawFrame()
                       calls grabShot() (12) -> handleShot() (09): kept on this device
                       (keepLocally: folder, Downloads, or on a phone the share sheet)
                       and/or uploaded for a QR code
     physics points:   PROBE_PASS in the shader (01) measures the bending -> runProbe() (11),
                       called from drawFrame() (12) after the lens map changed
     the lens map:     a change sets `dirty` (03) -> drawFrame() redraws MAP_PASS into the
                       map (12); allocMap() (02); the physics itself in the shader (01)
     picture quality:  how many pixels: resize(), minPx() (04); automatic: autoQuality(),
                       measured screen refresh rate calibrate() (12); a lost picture:
                       pictureLost() (12)
     remembered:       restored at start and written by save() (03); language (02); camera
                       on / which camera (05); settings hidden (06); the PIN in its own key (06);
                       own background picture and photo folder in IndexedDB (08)
     texts:            texts.js; applyStaticText() (02); setLang() (12) redraws the texts
                       that the code itself makes

   Glossary
     bd...    backdrop: the background picture shown where the background is removed
     plate    a recorded (or learned) empty background, used to find the people in front
     dock     the tap controls at the right edge (spin, size, background picture); on an
              upright phone at the bottom
     keep...  the ticks "visible when the settings are hidden" (keepSpin, keepLang, ...)
     shot     a photo;  el(id) = document.getElementById(id) (03)
     background picture choice: 'stars' = star sky, 'own' = own picture, else a file in backgrounds/
   ===================================================================================== */

const KEY = 'bh-camera-settings';              // localStorage key of the remembered settings
const canvas = document.getElementById('c');
const msg = document.getElementById('msg');


// ---------- languages (all texts are in texts.js) ----------

const TXT = window.BHC_TEXT || {nl: {}};
// First visit: the browser's language when we have it (NL, EN, FR, DE), otherwise English.
let lang = (navigator.languages || [navigator.language || ''])
  .map(x => String(x).slice(0, 2).toLowerCase()).find(x => TXT[x]) || (TXT.en ? 'en' : 'nl');

// the language remembered from last time wins (read here already, so the first texts are right)
try {
  const s0 = JSON.parse(localStorage.getItem(KEY) || 'null');
  if (s0 && s0.remember !== false && TXT[s0.lang]) lang = s0.lang;
} catch (e) {}

// Text `k` in the current language (falls back to Dutch, then to the key itself).
// {name} placeholders are filled in from `v`, e.g. t('camN', {n: 2}).
// (So no JavaScript variable is called t: that would hide this function.)
function t(k, v){
  let s = TXT[lang] && TXT[lang][k] != null ? TXT[lang][k]
        : TXT.nl && TXT.nl[k] != null ? TXT.nl[k]
        : k;
  if (v) s = s.replace(/\{(\w+)\}/g, (m, n) => (n in v ? String(v[n]) : m));
  return s;
}

// Fill in every fixed text of the page. In index.html:
//   data-t="key"                 the element's text
//   data-t-html="key"            the element's HTML (texts with <b> etc.)
//   data-t-attr="attr:key;..."   attributes such as aria-label and title
function applyStaticText(){
  document.documentElement.lang = lang;
  document.title = t('title');
  const md = document.querySelector('meta[name="description"]');
  if (md) md.content = t('metaDesc');
  document.querySelectorAll('[data-t]').forEach(e => { e.textContent = t(e.dataset.t); });
  document.querySelectorAll('[data-t-html]').forEach(e => { e.innerHTML = t(e.dataset.tHtml); });
  document.querySelectorAll('[data-t-attr]').forEach(e => e.dataset.tAttr.split(';').forEach(pair => {
    const [a, k] = pair.split(':');
    e.setAttribute(a, t(k));
  }));
  document.querySelectorAll('.langs [data-lang]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.lang === lang)));
}
applyStaticText();

// full-screen message for problems the page cannot work around
// (the settings and the gear are put away, so they do not cover the message)
function fail(m){
  msg.textContent = m;
  msg.classList.add('show');
  document.getElementById('panel').classList.add('hidden');
  document.getElementById('gear').hidden = true;
}


// ---------- WebGL ----------

let gl = canvas.getContext('webgl2', {antialias:false, premultipliedAlpha:false});
const isGL2 = !!gl;
if (!gl) gl = canvas.getContext('webgl', {antialias:false, premultipliedAlpha:false});
if (!gl) { fail(t('noWebGL')); throw new Error('Black hole camera: no WebGL'); }


// ---------- shaders ----------

const fragSrc = FRAG_SRC;                     // the lensing shader, from 01-lensing-shader.js
const vertSrc = 'attribute vec2 pos; void main(){ gl_Position = vec4(pos, 0.0, 1.0); }';

function compile(type, src){
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
  return s;
}

// One shader program; `defs` (e.g. '#define MAP_PASS\n') selects which pass it is.
// Returns {p: the program, u: its uniform locations by name}.
function program(defs){
  const p = gl.createProgram();
  gl.attachShader(p, compile(gl.VERTEX_SHADER, vertSrc));
  gl.attachShader(p, compile(gl.FRAGMENT_SHADER, defs + fragSrc));
  gl.bindAttribLocation(p, 0, 'pos');
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
  const u = {};
  const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < n; i++) {
    const a = gl.getActiveUniform(p, i);
    u[a.name] = gl.getUniformLocation(p, a.name);
  }
  return {p, u};
}

// progRaw: the plain camera picture without black hole (colour picking, mask view).
// progMap / progDisp (lens map + display) are made in setupMap() below, when the GPU can
// render to a float texture; otherwise progDirect draws everything directly.
let progDirect, progRaw, progMap = null, progDisp = null;
try {
  progDirect = program('');
  progRaw = program('#define RAW_PASS\n');
}
catch (e) { console.error(e); fail(t('glFail')); throw new Error('Black hole camera: shaders did not compile'); }

// one rectangle covering the whole screen: the fragment shader does all the work
const buf = gl.createBuffer();
gl.bindBuffer(gl.ARRAY_BUFFER, buf);
gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 1,-1, -1,1, 1,1]), gl.STATIC_DRAW);
gl.enableVertexAttribArray(0);
gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);


// ---------- textures ----------
// texture units (see bindTextures() in 04-drawing.js):
//   0 camera picture   1 star sky   2 lens map   3 person mask   4 background picture

function makeTex(wrapS){
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrapS);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return tex;
}
const camTex = makeTex(gl.CLAMP_TO_EDGE);
const skyTex = makeTex(gl.REPEAT);     // power-of-two, wraps around in longitude
const maskTex = makeTex(gl.CLAMP_TO_EDGE);

function uploadMask(bytes, w, h){        // one byte per pixel, rows top-down, 255 = person
  gl.bindTexture(gl.TEXTURE_2D, maskTex);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.LUMINANCE, w, h, 0, gl.LUMINANCE, gl.UNSIGNED_BYTE, bytes);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
}
uploadMask(new Uint8Array([255]), 1, 1);       // until there is a mask: everything is "person"

const bdTex = makeTex(gl.CLAMP_TO_EDGE);     // chosen background picture

// copy an image, canvas or video frame into a texture
function upload(tex, src){
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
}


// ---------- star sky and demo picture ----------

// Generated star sky (equirectangular, 4096 x 2048): faint nebula + stars,
// built from directions on the sphere so it has no seams and no pole stretching.

// small seeded random generator, so the sky is the same every time
function rng(seed){
  return function(){ seed = (seed*16807) % 2147483647; return (seed - 1)/2147483646; };
}

// the star sky as a canvas (uploaded into skyTex)
function makeSky(){
  const W = 4096, H = 2048, r = rng(20261029);

  // 1. nebula: a few dozen soft coloured blobs, computed on a small canvas and enlarged
  const sw = 512, sh = 256, small = document.createElement('canvas');
  small.width = sw; small.height = sh;
  const sctx = small.getContext('2d'), img = sctx.createImageData(sw, sh);
  const blobs = [];
  for (let i = 0; i < 46; i++) {
    const z = 2*r() - 1, ph = 2*Math.PI*r(), s = Math.sqrt(1 - z*z);
    const hue = r();
    blobs.push({x: s*Math.cos(ph), y: z, z: s*Math.sin(ph), k: 4 + 30*r(), a: 0.35 + 0.65*r(),
      c: hue < 0.55 ? [40, 80, 190] : hue < 0.8 ? [120, 50, 150] : [170, 70, 60]});
  }
  for (let j = 0; j < sh; j++) {
    const th = (j + 0.5)/sh*Math.PI, ny = Math.cos(th), st = Math.sin(th);
    for (let i = 0; i < sw; i++) {
      const lo = ((i + 0.5)/sw - 0.5)*2*Math.PI, nx = st*Math.sin(lo), nz = st*Math.cos(lo);
      let R = 6, G = 8, B = 22;
      for (const b of blobs) {
        const w = b.a*Math.exp(b.k*(b.x*nx + b.y*ny + b.z*nz - 1));
        R += w*b.c[0]*0.45; G += w*b.c[1]*0.45; B += w*b.c[2]*0.45;
      }
      const o = 4*(j*sw + i);
      img.data[o] = Math.min(255, R); img.data[o+1] = Math.min(255, G); img.data[o+2] = Math.min(255, B); img.data[o+3] = 255;
    }
  }
  sctx.putImageData(img, 0, 0);
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(small, 0, 0, W, H);

  // 2. stars: uniform on the sphere, drawn as ellipses widened by 1/sin(theta)
  for (let i = 0; i < 9000; i++) {
    const z = 2*r() - 1, lo = 2*Math.PI*r(), th = Math.acos(z);
    const x = lo/(2*Math.PI)*W, y = th/Math.PI*H, st = Math.max(Math.sin(th), 0.03);
    const m = Math.pow(r(), 6), rad = 0.7 + 2.6*m, al = 0.35 + 0.65*Math.sqrt(m);
    const tint = r(), col = tint < 0.15 ? '255,210,170' : tint < 0.35 ? '190,215,255' : '255,255,250';
    ctx.fillStyle = 'rgba(' + col + ',' + al.toFixed(3) + ')';
    for (const dx of [0, -W, W]) {             // also drawn one width left and right: no seam
      ctx.beginPath();
      ctx.ellipse(x + dx, y, Math.min(rad/st, W/4), rad, 0, 0, 2*Math.PI);
      ctx.fill();
    }
  }
  return c;
}

// Demo picture, used until the camera is switched on: four coloured quarters with a grid
// (so the bending is easy to see) and a title.
function makeDemo(){
  const W = 1280, H = 960, c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d');
  const cols = ['#e0485e', '#3fae5a', '#3d6fe0', '#e8c43c'];
  for (let q = 0; q < 4; q++) {
    ctx.fillStyle = cols[q];
    ctx.fillRect((q % 2)*W/2, (q < 2 ? 0 : 1)*H/2, W/2, H/2);
  }
  ctx.strokeStyle = 'rgba(255,255,255,.9)'; ctx.lineWidth = 6;
  for (let x = 0; x <= W; x += 80) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke(); }
  for (let y = 0; y <= H; y += 80) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }
  ctx.fillStyle = '#fff'; ctx.strokeStyle = 'rgba(0,0,0,.35)'; ctx.lineWidth = 8;
  ctx.font = '700 104px Unbounded, Helvetica, Arial, sans-serif';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.strokeText(t('demoTitle'), W/2, H*0.2); ctx.fillText(t('demoTitle'), W/2, H*0.2);
  ctx.font = '700 64px "Atkinson Hyperlegible", Helvetica, Arial, sans-serif';
  ctx.strokeText(t('demoSub'), W/2, H*0.82); ctx.fillText(t('demoSub'), W/2, H*0.82);
  // image is mirrored on screen (like a mirror), so flip the text once here
  const m = document.createElement('canvas');
  m.width = W; m.height = H;
  const mc = m.getContext('2d');
  mc.translate(W, 0); mc.scale(-1, 1);
  mc.drawImage(c, 0, 0);
  return m;
}

upload(skyTex, makeSky());
let demo = makeDemo();
upload(camTex, demo);
let camAspect = demo.height/demo.width;       // height/width of the (upright) camera picture
// (the demo is drawn again once the web fonts have arrived: see the start-up in 12-main.js)


// ---------- lens map (precomputed once per setting) ----------
// Each lens-map pixel (written by MAP_PASS, read by DISPLAY_PASS):
//   z = 0  shadow (black)
//   z = 1  camera picture: xy = camera coordinate, w = n.z
//   z = 2  sky:            xy = n.x, n.y,          w = n.z     (n = direction the ray came from)
// Recomputed in frame() (12-main.js) while `dirty` (03-settings.js).

// mapType: {type, internal} of the float texture format, or null (then draw directly)
let mapTex = null, mapFbo = null, mapType = null, mapW = 0, mapH = 0;

// Can this GPU render into a float (or else half-float) texture? Then make the two
// programs for the lens map; otherwise everything is drawn directly (slower).
(function setupMap(){
  let type = null, internal = gl.RGBA;
  if (isGL2) {
    if (gl.getExtension('EXT_color_buffer_float')) { type = gl.FLOAT; internal = gl.RGBA32F; }
    else if (gl.getExtension('EXT_color_buffer_half_float')) { type = gl.HALF_FLOAT; internal = gl.RGBA16F; }
  } else if (gl.getExtension('OES_texture_float') && gl.getExtension('WEBGL_color_buffer_float')) { type = gl.FLOAT; }
  else {
    const h = gl.getExtension('OES_texture_half_float');
    if (h && gl.getExtension('EXT_color_buffer_half_float')) type = h.HALF_FLOAT_OES;
  }
  if (!type) return;
  try {
    progMap = program('#define MAP_PASS\n');
    progDisp = program('#define DISPLAY_PASS\n');
    mapType = {type, internal};
  } catch (e) { console.warn('lens map unavailable, direct rendering', e); progMap = progDisp = null; }
})();

// (Re)make the lens-map texture at w x h pixels. Returns false if there is none, so the
// render loop draws directly instead.
function allocMap(w, h){
  if (!mapType) return false;
  if (mapTex && mapW === w && mapH === h) return true;
  if (!mapTex) { mapTex = gl.createTexture(); mapFbo = gl.createFramebuffer(); }
  gl.bindTexture(gl.TEXTURE_2D, mapTex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(gl.TEXTURE_2D, 0, mapType.internal, w, h, 0, gl.RGBA, mapType.type, null);
  gl.bindFramebuffer(gl.FRAMEBUFFER, mapFbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, mapTex, 0);
  const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  if (!ok) { mapType = null; return false; }
  mapW = w; mapH = h;
  return true;
}


// all set: the next files may run (each of them checks this first)
window.BHC_READY = true;
