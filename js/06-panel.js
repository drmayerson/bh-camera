'use strict';
if (!window.BHC_READY) throw new Error('Black hole camera: not started (see the message on screen)');

/* =====================================================================================
   Black hole camera — 06: settings panel and visitor controls
   -------------------------------------------------------------------------------------
   - opening and closing the settings (gear button bottom left);
   - the tap controls at the right edge (spin, size, background picture), shown while
     the settings are hidden;
   - the (i) explanation for visitors;
   - the PIN lock for unattended touch screens;
   - the banner at the top (instructions and the 3-2-1 while recording the empty scene,
     or while picking a colour).
   ===================================================================================== */


// ---------- panel and tap controls ----------

const panel = el('panel');
// own background picture of this session (also kept when not remembering); declared here
// because the tap controls count it among the pictures (see bdList)
let ownBlob = null;

// which of the tap controls and visitor buttons are visible: only while the settings are
// hidden, and only what is ticked under "Zichtbaar als de instellingen verborgen zijn"
function updateDock(){
  const hid = panel.classList.contains('hidden');
  const sp = keepSpin.checked && hid, ma = keepMass.checked && hid, bd = keepBd.checked && hid && bgMode.value !== 'off';
  el('dock').hidden = !(sp || ma || bd);
  el('dockSpin').hidden = !sp;
  el('dockMass').hidden = !ma;
  el('dockBd').hidden = !bd;
  el('dockReset').hidden = !(sp || ma);
  el('vLangs').hidden = !(keepLang.checked && hid);
  el('infoBtn').hidden = !(keepInfo.checked && hid);
  el('pointsBtn').hidden = !(keepPoints.checked && el('pointsOn').checked && hid);   // (the points: 11)
  updateBdVal();
}

function setPanelHidden(hide){
  panel.classList.toggle('hidden', hide);
  const g = el('gear'), label = t(hide ? 'showSettings' : 'hide');
  g.setAttribute('aria-expanded', String(!hide));
  g.setAttribute('aria-label', label);
  g.title = label;
  if (!hide) panelTouched();
  updateDock();
}

// the gear opens and closes (so a double tap opens and closes again); "Verbergen" closes
el('gear').addEventListener('click', () => {
  const hidden = panel.classList.contains('hidden');
  if (hidden && pinActive()) { openPinPad(); return; }   // locked: ask for the PIN first
  setPanelHidden(!hidden); save();
});
el('toggle').addEventListener('click', () => { setPanelHidden(true); save(); });

// arrows at the right edge: one step per tap, repeating while held (touch screen or mouse)
const STEP = {spin: 0.1, mass: 0.5};
function nudge(what, dir){
  if (what === 'bd') { stepBackdrop(dir); return; }
  const inp = what === 'spin' ? spin : mass, st = STEP[what];
  const v = Math.min(Number(inp.max), Math.max(Number(inp.min), Math.round((Number(inp.value) + dir*st)/st)*st));
  inp.value = v;
  changed();
}
document.querySelectorAll('.dock-btn[data-act]').forEach(b => {
  let timer = null, rep = null;
  const stop = () => { clearTimeout(timer); clearInterval(rep); timer = rep = null; };
  const go = () => nudge(b.dataset.act, Number(b.dataset.dir));
  b.addEventListener('pointerdown', e => {
    e.preventDefault(); stop(); go();
    if (b.dataset.act !== 'bd') timer = setTimeout(() => { rep = setInterval(go, 180); }, 450);   // pictures: one per tap
  });
  ['pointerup', 'pointerleave', 'pointercancel'].forEach(ev => b.addEventListener(ev, stop));
  b.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } });
});
el('dockReset').addEventListener('click', () => { spin.value = 0.9; mass.value = 3; changed(); });

// background pictures to step through: the built-in ones, plus your own if there is one
function bdList(){
  return Array.from(el('bdChoice').options).map(o => o.value).filter(v => v !== 'own' || ownBlob);
}
function stepBackdrop(dir){
  const list = bdList(), sel = el('bdChoice');
  let i = list.indexOf(sel.value);
  if (i < 0) i = 0;
  sel.value = list[(i + dir + list.length) % list.length];
  backdropChanged(); updateBdVal();
}
// "3/7" under the background-picture arrows
function updateBdVal(){
  const list = bdList(), i = list.indexOf(el('bdChoice').value);
  el('dockBdVal').textContent = (i < 0 ? 1 : i + 1) + '/' + list.length;
}


// ---------- explanation for visitors (i) ----------

// the "what do you see" text, closes by itself after a minute
let infoTimer = null;
function showInfo(){
  el('infoBox').hidden = false;
  clearTimeout(infoTimer);
  infoTimer = setTimeout(hideInfo, 60000);
}
function hideInfo(){ el('infoBox').hidden = true; clearTimeout(infoTimer); }
el('infoBtn').addEventListener('click', showInfo);
el('infoClose').addEventListener('click', hideInfo);
el('infoBox').addEventListener('click', e => { if (e.target === el('infoBox')) hideInfo(); });   // tap outside the card


// ---------- PIN lock ----------
// Stored apart from the other settings, so it also holds when "Onthouden" is off.
// Forgotten? Open the page with ?pinreset after the address.

const PIN_KEY = KEY + '-pin';
let pinCfg = {on: false, code: ''};
try {
  const v = JSON.parse(localStorage.getItem(PIN_KEY) || 'null');
  if (v) pinCfg = {on: !!v.on, code: String(v.code || '')};
} catch (e) {}
if (/[?&]pinreset\b/.test(location.search)) {
  pinCfg = {on: false, code: ''};
  try { localStorage.removeItem(PIN_KEY); } catch (e) {}
  history.replaceState(null, '', location.pathname);     // remove ?pinreset from the address
}
el('pinOn').checked = pinCfg.on;
el('pinCode').value = pinCfg.code;

// the lock only counts with a PIN of 4 to 8 digits
function pinActive(){ return pinCfg.on && /^\d{4,8}$/.test(pinCfg.code); }

function updatePinUI(){
  el('pinRow').hidden = !el('pinOn').checked;
  el('pinNote').textContent = !el('pinOn').checked ? '' : pinActive() ? t('pinNoteOn') : t('pinTooShort');
}
function savePin(){
  pinCfg = {on: el('pinOn').checked, code: el('pinCode').value.replace(/\D/g, '').slice(0, 8)};
  try { localStorage.setItem(PIN_KEY, JSON.stringify(pinCfg)); } catch (e) {}
  updatePinUI();
}
el('pinOn').addEventListener('change', savePin);
el('pinCode').addEventListener('input', () => { el('pinCode').value = el('pinCode').value.replace(/\D/g, '').slice(0, 8); savePin(); });

// the keypad
let pinEntry = '', pinTimer = null;
function pinDotsDraw(){ el('pinDots').innerHTML = '<i></i>'.repeat(pinEntry.length); }
function openPinPad(){ pinEntry = ''; pinDotsDraw(); el('pinPad').hidden = false; armPinTimer(); }
function closePinPad(){ el('pinPad').hidden = true; pinEntry = ''; clearTimeout(pinTimer); }
function armPinTimer(){ clearTimeout(pinTimer); pinTimer = setTimeout(closePinPad, 20000); }   // nobody typing: close

// one key of the keypad: a digit, 'del' or 'ok'; checks by itself once enough digits are in
function pinKey(k){
  armPinTimer();
  if (k === 'ok') { checkPin(true); return; }
  if (k === 'del') pinEntry = pinEntry.slice(0, -1);
  else if (pinEntry.length < 8) pinEntry += k;
  pinDotsDraw();
  if (pinEntry.length === pinCfg.code.length) checkPin(false);
}
// right: open the settings; wrong: shake the dots and start again
// (the true/false that pinKey passes is not used)
function checkPin(){
  if (pinEntry === pinCfg.code) { closePinPad(); setPanelHidden(false); save(); return; }
  const d = el('pinDots');
  d.classList.remove('wrong'); void d.offsetWidth; d.classList.add('wrong');   // (restart the animation)
  pinEntry = '';
  setTimeout(pinDotsDraw, 350);
}
document.querySelectorAll('.pin-keys button').forEach(b => b.addEventListener('click', () => pinKey(b.dataset.k)));
el('pinCancel').addEventListener('click', closePinPad);
el('pinPad').addEventListener('click', e => { if (e.target === el('pinPad')) closePinPad(); });
document.addEventListener('keydown', e => {          // a keyboard works on the keypad too
  if (el('pinPad').hidden) return;
  if (/^\d$/.test(e.key)) pinKey(e.key);
  else if (e.key === 'Backspace') pinKey('del');
  else if (e.key === 'Enter') pinKey('ok');
  else if (e.key === 'Escape') closePinPad();
  else return;
  e.preventDefault(); e.stopImmediatePropagation();   // (no photo, full screen etc. while typing the PIN)
}, true);

// with the lock on, open settings close by themselves after 2 minutes without use
let panelLastUse = performance.now();
function panelTouched(){ panelLastUse = performance.now(); }
['pointerdown', 'keydown', 'input', 'scroll', 'wheel'].forEach(ev => panel.addEventListener(ev, panelTouched, {passive: true, capture: true}));
setInterval(() => {
  if (pinActive() && !panel.classList.contains('hidden') && performance.now() - panelLastUse > 120000) { setPanelHidden(true); save(); }
}, 5000);

// at start: settings closed when locked, otherwise as they were left
setPanelHidden(pinActive() || !!(remembered && remembered.panelHidden));
updatePinUI();

// touch screen: no long-press menu on the picture and buttons
document.addEventListener('contextmenu', e => { if (!(e.target && /^(INPUT|TEXTAREA)$/.test(e.target.tagName))) e.preventDefault(); });


// ---------- banner (instructions, recording countdown) ----------

const banner = el('banner');
// opts.big: large text (the 3-2-1 while recording the empty scene);
// opts.cancel: show the "Annuleren" button
function showBanner(text, opts){
  el('bannerText').textContent = text;
  banner.classList.toggle('big', !!(opts && opts.big));
  el('bannerCancel').hidden = !(opts && opts.cancel);
  banner.hidden = false;
}
function hideBanner(){ banner.hidden = true; }
el('bannerCancel').addEventListener('click', () => { stopPicking(); cancelCapture(); });
