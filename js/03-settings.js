'use strict';
if (!window.BHC_READY) throw new Error('Black hole camera: not started (see the message on screen)');

/* =====================================================================================
   Black hole camera — 03: settings
   -------------------------------------------------------------------------------------
   The controls of the settings panel that the drawing depends on, the remembered
   settings (read at start, written by save() after every change), and the value labels
   next to the sliders.
   ===================================================================================== */

const el = id => document.getElementById(id);

// controls used in many places
const spin = el('spin'), incl = el('incl'), mass = el('mass');
const keepSpin = el('keepSpin'), keepMass = el('keepMass'), showLogo = el('showLogo');
const keepBd = el('keepBd'), keepLang = el('keepLang'), keepInfo = el('keepInfo'), keepPoints = el('keepPoints');
const bgMode = el('bgMode'), keyTol = el('keyTol'), plateSens = el('plateSens');
const shadows = el('shadows'), lockCam = el('lockCam'), showMask = el('showMask');
let keyRGB = [0, 177, 64];               // typical chroma-key green until one is picked


// ---------- remembered settings ----------
// Settings are kept in this browser (localStorage; the own background picture and the
// photo folder in IndexedDB), unless "Onthouden" is switched off.

let remembered = null;                   // what was stored last time (null: nothing / not remembering)
let camRot = 0, quality = 'auto';        // camera on its side (0, 1 or 3) and picture quality

// put the stored values back into the controls (an unknown or missing value keeps the default)
try {
  const s = JSON.parse(localStorage.getItem(KEY) || 'null');
  if (s && s.remember === false) el('remember').checked = false;
  else if (s) {
    remembered = s;
    spin.value = s.spin; incl.value = s.incl; mass.value = s.mass;
    if (s.keepSpin != null) keepSpin.checked = !!s.keepSpin;
    if (s.keepMass != null) keepMass.checked = !!s.keepMass;
    if (s.keepBd != null) keepBd.checked = !!s.keepBd;
    if (s.keepLang != null) keepLang.checked = !!s.keepLang;
    if (s.keepInfo != null) keepInfo.checked = !!s.keepInfo;
    if (s.showLogo != null) showLogo.checked = !!s.showLogo;
    if (s.bgMode && bgMode.querySelector('option[value="' + s.bgMode + '"]')) bgMode.value = s.bgMode;
    if (s.keyTol != null) keyTol.value = s.keyTol;
    if (s.plateSens != null) plateSens.value = s.plateSens;
    if (s.shadows != null) shadows.checked = !!s.shadows;
    if (s.lockCam != null) lockCam.checked = !!s.lockCam;
    if (s.backdrop && el('bdChoice').querySelector('option[value="' + s.backdrop + '"]')) el('bdChoice').value = s.backdrop;
    if (s.shotsOn != null) el('shotsOn').checked = !!s.shotsOn;
    if (s.shotLocal != null) el('shotLocal').checked = !!s.shotLocal;
    if (s.shotQR != null) el('shotQR').checked = !!s.shotQR;
    if (typeof s.qrBase === 'string') el('qrBase').value = s.qrBase;
    if (typeof s.qrKey === 'string') el('qrKey').value = s.qrKey;
    if (s.qrSec != null) el('qrSec').value = s.qrSec;
    if ([0, 1, 3].includes(Number(s.camRot))) camRot = Number(s.camRot);
    if (['auto', 'normal', 'high'].includes(s.quality)) quality = s.quality;
    if (s.shotCount != null) el('shotCount').checked = !!s.shotCount;
    if (s.qrAgainOn != null) el('qrAgainOn').checked = !!s.qrAgainOn;
    if (s.handOn != null) el('handOn').checked = !!s.handOn;
    if (s.pointsOn != null) el('pointsOn').checked = !!s.pointsOn;
    if (s.keepPoints != null) keepPoints.checked = !!s.keepPoints;
    if (Array.isArray(s.key) && s.key.length === 3) keyRGB = s.key.map(Number);
  }
} catch (e) {}

// Store all settings (or only "don't remember"). Called after every change.
// (Some values live in later files: camWanted, camDeviceId, panel — they exist by the
// time anything is changed.)
// To add a remembered setting: restore it in the try-block above, add it here, and call
// save() from its change listener.
function save(){
  try {
    if (!el('remember').checked) { localStorage.setItem(KEY, JSON.stringify({remember: false})); return; }
    localStorage.setItem(KEY, JSON.stringify({
      remember: true, lang, camOn: camWanted, camId: camDeviceId, panelHidden: panel.classList.contains('hidden'),
      keepMass: keepMass.checked, showLogo: showLogo.checked, keepBd: keepBd.checked, keepLang: keepLang.checked, keepInfo: keepInfo.checked,
      spin: spin.value, incl: incl.value, mass: mass.value,
      keepSpin: keepSpin.checked, bgMode: bgMode.value, keyTol: keyTol.value, plateSens: plateSens.value,
      shadows: shadows.checked, lockCam: lockCam.checked, key: keyRGB,
      backdrop: el('bdChoice').value, shotsOn: el('shotsOn').checked,
      shotLocal: el('shotLocal').checked, shotQR: el('shotQR').checked, qrBase: el('qrBase').value.trim(), qrKey: el('qrKey').value,
      qrSec: el('qrSec').value, camRot, quality, shotCount: el('shotCount').checked, qrAgainOn: el('qrAgainOn').checked,
      handOn: el('handOn').checked, pointsOn: el('pointsOn').checked, keepPoints: keepPoints.checked
    }));
  } catch (e) {}
}


// ---------- value labels next to the sliders (and in the tap controls) ----------

function spinText(v){ return Number(v) === 0 ? t('spinStill') : Number(v).toFixed(2) + ' (max. 1)'; }

function labels(){
  el('spinVal').textContent = spinText(spin.value);
  el('dockSpinVal').textContent = Number(spin.value).toFixed(2);
  el('dockMassVal').textContent = Number(mass.value).toFixed(1);
  el('inclVal').textContent = incl.value + '°' + (Number(incl.value) === 90 ? t('inclSide') : Number(incl.value) === 0 ? t('inclAxis') : '');
  el('massVal').textContent = Number(mass.value).toFixed(1);
  el('keyTolVal').textContent = Math.round(Number(keyTol.value)*100);
  el('plateSensVal').textContent = Number(plateSens.value).toFixed(1).replace('.0', '') + (Number(plateSens.value) === 5 ? t('normal') : '');
  el('swatch').style.background = 'rgb(' + keyRGB.join(',') + ')';
}


// ---------- reacting to changes ----------

// dirty: the lens map must be computed again (black-hole setting, screen or camera size changed)
let dirty = true;
function changed(){ labels(); dirty = true; save(); }

// (some of the functions used here are defined in later files; they only run after start-up)
[spin, incl, mass].forEach(i => i.addEventListener('input', changed));
[keyTol, plateSens].forEach(i => i.addEventListener('input', () => { labels(); save(); }));
shadows.addEventListener('change', save);
lockCam.addEventListener('change', () => { lockCamera(lockCam.checked && usesPlate() && plateValid); save(); });
[keepSpin, keepMass, keepBd, keepLang, keepInfo, keepPoints].forEach(c => c.addEventListener('change', () => { updateDock(); save(); }));

// the Einstein Telescope logo (top left) can be switched off
function updateLogo(){
  el('brand').hidden = !showLogo.checked;
  document.body.classList.toggle('nologo', !showLogo.checked);
}
showLogo.addEventListener('change', () => { updateLogo(); save(); });

updateLogo();
labels();
