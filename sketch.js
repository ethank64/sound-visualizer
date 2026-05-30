// Sound Visualizer
// Buttons map to keyboard keys (1-9, 0, then q w e r t ...).
// Slider 1: base frequency of the first button.
// Slider 2: number of intervals/buttons. The last button is one octave
// (2x) above the first, with every button an even division in between.

// Keyboard order, matching a physical keyboard layout.
const KEY_ORDER = [
  '1', '2', '3', '4', '5', '6', '7', '8', '9', '0',
  'q', 'w', 'e', 'r', 't', 'y', 'u', 'i', 'o', 'p',
  'a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l',
  'z', 'x', 'c', 'v', 'b', 'n', 'm'
];

const CANVAS_W = 960;
const CANVAS_H = 700;
const VIZ_TOP = 0;
const VIZ_BOTTOM = 220;
const BTN_TOP = 250;
const BTN_BOTTOM = 510;
const SLIDER_TOP = 540;

// Horizontal centers of the two control columns.
const LEFT_CX = CANVAS_W * 0.25;
const RIGHT_CX = CANVAS_W * 0.75;
const SLIDER_W = 300;
const INPUT_W = 90;

const FREQ_MIN = 50, FREQ_MAX = 1000;

// Just-intonation major scale ratios over one octave (exact at N = 8).
const JI_RATIOS = [1, 9 / 8, 5 / 4, 4 / 3, 3 / 2, 5 / 3, 15 / 8, 2];

// Closest simple fraction "p/q" to x with denominator <= maxDen.
// Reproduces the exact JI fractions at N = 8.
function ratioFraction(x, maxDen) {
  let bestN = 1, bestD = 1, bestErr = Infinity;
  for (let d = 1; d <= maxDen; d++) {
    const nu = Math.round(x * d);
    const err = Math.abs(x - nu / d);
    if (err < bestErr - 1e-9) { bestErr = err; bestN = nu; bestD = d; }
  }
  const g = gcd(bestN, bestD);
  return (bestN / g) + '/' + (bestD / g);
}

function gcd(a, b) { return b === 0 ? a : gcd(b, a % b); }

let cnv;
let freqSlider, intervalSlider;
let freqInput, intervalInput;
let modeSelect;
let currentMode = 'just'; // 'equal' | 'linear' | 'just'
let fft;

let buttons = [];          // {key, freq, x, y, w, h, index}
let activeNotes = {};       // key -> {osc, env, freq, index}
let recentEnergy = 0;       // for subtle background pulse

function setup() {
  cnv = createCanvas(CANVAS_W, CANVAS_H);
  cnv.parent(document.body);

  if (typeof p5.FFT !== 'undefined') {
    fft = new p5.FFT(0.85, 1024);
  }

  // Frequency of the first (lowest) button.
  freqSlider = createSlider(FREQ_MIN, FREQ_MAX, 220, 1);
  freqSlider.style('width', SLIDER_W + 'px');

  // Number of intervals / buttons. Last button = one octave up.
  intervalSlider = createSlider(2, KEY_ORDER.length, 8, 1);
  intervalSlider.style('width', SLIDER_W + 'px');

  // Text inputs that mirror the sliders.
  freqInput = createInput(String(freqSlider.value()), 'number');
  intervalInput = createInput(String(intervalSlider.value()), 'number');
  styleInput(freqInput);
  styleInput(intervalInput);

  // Slider -> input (live while dragging).
  freqSlider.input(() => freqInput.value(freqSlider.value()));
  intervalSlider.input(() => intervalInput.value(intervalSlider.value()));

  // Input -> slider. On 'input' we update live; on 'change' we also
  // normalize the field to the clamped value (e.g. on Enter / blur).
  freqInput.input(() => freqSlider.value(clampFreq(freqInput.value())));
  freqInput.changed(() => {
    const v = clampFreq(freqInput.value());
    freqSlider.value(v); freqInput.value(v);
  });
  intervalInput.input(() => intervalSlider.value(clampIntervals(intervalInput.value())));
  intervalInput.changed(() => {
    const v = clampIntervals(intervalInput.value());
    intervalSlider.value(v); intervalInput.value(v);
  });

  // Tuning-mode selector.
  modeSelect = createSelect();
  modeSelect.option('Equal Temperament (2^(i/n))', 'equal');
  modeSelect.option('Linear / Harmonic (Hz steps)', 'linear');
  modeSelect.option('Just Intonation (pure ratios)', 'just');
  modeSelect.selected(currentMode);
  styleInput(modeSelect);
  modeSelect.style('width', '260px');
  modeSelect.changed(() => {
    currentMode = modeSelect.value();
    buildButtons();
    // Retune any held notes to the new tuning.
    for (const k in activeNotes) {
      const note = activeNotes[k];
      const btn = buttons.find(b => b.key === k);
      if (btn) { note.freq = btn.freq; note.osc.freq(btn.freq); }
    }
  });

  positionControls();
  buildButtons();

  textFont('monospace');
  textAlign(CENTER, CENTER);
}

function clampFreq(v) {
  const n = parseInt(v, 10);
  if (isNaN(n)) return freqSlider.value();
  return constrain(n, FREQ_MIN, FREQ_MAX);
}

function clampIntervals(v) {
  const n = parseInt(v, 10);
  if (isNaN(n)) return intervalSlider.value();
  return constrain(n, 2, KEY_ORDER.length);
}

function styleInput(inp) {
  inp.style('width', INPUT_W + 'px');
  inp.style('box-sizing', 'border-box');
  inp.style('background', '#1d2029');
  inp.style('color', '#e6e8ee');
  inp.style('border', '1px solid #3a3f4d');
  inp.style('border-radius', '6px');
  inp.style('padding', '4px 6px');
  inp.style('font-family', 'monospace');
  inp.style('font-size', '14px');
  inp.style('text-align', 'center');
}

// DOM controls use page coordinates, but the canvas is centered by CSS.
// Anchor everything to the canvas's actual on-page position and center
// each slider + input under its label.
function positionControls() {
  const cx = cnv.elt.offsetLeft;
  const cy = cnv.elt.offsetTop;
  const sliderY = cy + SLIDER_TOP + 35;
  const inputY = cy + SLIDER_TOP + 72;
  freqSlider.position(cx + LEFT_CX - SLIDER_W / 2, sliderY);
  intervalSlider.position(cx + RIGHT_CX - SLIDER_W / 2, sliderY);
  freqInput.position(cx + LEFT_CX - INPUT_W / 2, inputY);
  intervalInput.position(cx + RIGHT_CX - INPUT_W / 2, inputY);
  // Tuning selector, top-center over the visualizer panel.
  modeSelect.position(cx + CANVAS_W / 2 - 130, cy + 14);
}

function windowResized() {
  positionControls();
}

// Compute the N frequencies spanning one octave (last button = 2 * base).
//   'equal'  Equal temperament: equal *ratio* steps, 2^(i/(n-1)).
//            Sounds like even musical steps.
//   'linear' Equal *Hz* steps, base + i*(base/(n-1)). This is a slice of
//            the harmonic series and sounds out of tune in the middle.
//   'just'   Just intonation, pure whole-number ratios. Exact major scale
//            at n=8; for other n the ratio curve is log-interpolated.
function computeFrequencies(base, n, mode) {
  const freqs = [];
  if (n === 1) return [base];

  for (let i = 0; i < n; i++) {
    const t = i / (n - 1); // 0..1 across the octave
    let ratio;
    if (mode === 'linear') {
      ratio = 1 + t; // 1 .. 2 linearly
    } else if (mode === 'just') {
      // Resample the diatonic ratio table to n points (log domain).
      const pos = t * (JI_RATIOS.length - 1);
      const lo = Math.floor(pos);
      const hi = Math.min(JI_RATIOS.length - 1, lo + 1);
      const frac = pos - lo;
      ratio = Math.exp((1 - frac) * Math.log(JI_RATIOS[lo]) +
                       frac * Math.log(JI_RATIOS[hi]));
    } else {
      ratio = Math.pow(2, t); // equal temperament
    }
    freqs.push(base * ratio);
  }
  return freqs;
}

function buildButtons() {
  const n = intervalSlider.value();
  const base = freqSlider.value();
  const freqs = computeFrequencies(base, n, currentMode);

  buttons = [];

  // Lay buttons out in a wrapping grid.
  const perRow = Math.min(n, 10);
  const rows = Math.ceil(n / perRow);
  const areaH = BTN_BOTTOM - BTN_TOP;
  const gap = 12;
  const cellH = (areaH - gap * (rows - 1)) / rows;

  for (let i = 0; i < n; i++) {
    const row = Math.floor(i / perRow);
    const col = i % perRow;
    // Number of items in this particular row (last row may be shorter).
    const itemsThisRow = Math.min(perRow, n - row * perRow);
    const cellW = (CANVAS_W - 80 - gap * (itemsThisRow - 1)) / itemsThisRow;
    const x = 40 + col * (cellW + gap);
    const y = BTN_TOP + row * (cellH + gap);
    // Ratio labels, shown in Just Intonation mode: the pure fraction
    // (exact at N = 8, nearest simple fraction otherwise) plus the decimal
    // multiple of the base, so e.g. 5/4 reads as "x1.250" (220 x 1.25 = 275).
    let ratioLabel = '';
    let multLabel = '';
    if (currentMode === 'just') {
      // Pure fractions only make sense for the 8-note diatonic scale.
      ratioLabel = (n === JI_RATIOS.length) ? ratioFraction(freqs[i] / base, 16) : '';
      multLabel = '\u00D7' + (freqs[i] / base).toFixed(3);
    }
    buttons.push({
      key: KEY_ORDER[i],
      freq: freqs[i],
      ratioLabel,
      multLabel,
      index: i,
      x, y, w: cellW, h: cellH
    });
  }
}

function draw() {
  background(20, 22, 28);

  // Keep DOM controls anchored to the (CSS-centered) canvas.
  positionControls();

  // Rebuild buttons live if either slider changed.
  const n = intervalSlider.value();
  const base = freqSlider.value();
  if (buttons.length !== n || (buttons.length && Math.abs(buttons[0].freq - base) > 0.001)) {
    buildButtons();
    // Update frequencies of any currently held notes.
    for (const k in activeNotes) {
      const note = activeNotes[k];
      const btn = buttons.find(b => b.key === k);
      if (btn) {
        note.freq = btn.freq;
        note.index = btn.index;
        note.osc.freq(btn.freq);
      }
    }
  }

  drawVisualizer();
  drawIntervalReadout();
  drawButtons();
  drawSliders();
}

// Names for the 13 chromatic intervals within an octave (0..12 semitones).
const INTERVAL_NAMES = [
  'Unison', 'Minor 2nd', 'Major 2nd', 'Minor 3rd', 'Major 3rd',
  'Perfect 4th', 'Tritone', 'Perfect 5th', 'Minor 6th', 'Major 6th',
  'Minor 7th', 'Major 7th', 'Octave'
];

// Recognizable chords keyed by their reduced integer ratio.
const CHORD_NAMES = {
  '4:5:6': 'Major triad',
  '10:12:15': 'Minor triad',
  '5:6:7': 'Diminished triad',
  '16:20:25': 'Augmented triad',
  '4:5:6:7': 'Dominant 7th',
  '8:10:12:15': 'Major 7th',
  '10:12:15:18': 'Minor 7th',
  '4:5:6:8': 'Major triad (+oct)',
  '2:3': 'Perfect 5th',
};

// Express a set of frequencies as the smallest integer ratio a:b:c...
// by scaling the normalized ratios until they all land near integers.
// Returns { ints, exact, fundamental } or null if no simple set is found.
function integerRatio(freqs) {
  const f0 = freqs[0];
  const rs = freqs.map(f => f / f0);
  const maxM = 32, tol = 0.05;
  for (let m = 1; m <= maxM; m++) {
    let worst = 0;
    for (const r of rs) {
      const v = r * m;
      worst = Math.max(worst, Math.abs(v - Math.round(v)));
    }
    if (worst <= tol) {
      let ints = rs.map(r => Math.round(r * m));
      const g = ints.reduce((a, b) => gcd(a, b));
      ints = ints.map(x => x / g);
      return { ints, exact: worst < 1e-4, fundamental: f0 / ints[0] };
    }
  }
  return null;
}

// Show the harmony between the held notes: a two-note interval (ratio +
// name + cents) or, for chords, the reduced integer ratio + chord name +
// implied (virtual) fundamental.
function drawIntervalReadout() {
  const notes = Object.values(activeNotes);
  if (notes.length < 2) return;

  const freqs = notes.map(n => n.freq).sort((a, b) => a - b);

  let big, small;
  if (freqs.length === 2) {
    const ratio = freqs[1] / freqs[0];
    const cents = 1200 * Math.log(ratio) / Math.log(2);
    const name = INTERVAL_NAMES[constrain(Math.round(cents / 100), 0, 12)];
    const frac = ratioFraction(ratio, 16).split('/');
    const p = +frac[0], q = +frac[1];
    const exact = Math.abs(ratio - p / q) < 1e-4;
    big = (exact ? '' : '\u2248 ') + p + ' : ' + q;
    small = name + '   \u2022   ' + ratio.toFixed(3) + '\u00D7   \u2022   ' +
            Math.round(cents) + '\u00A2';
  } else {
    const r = integerRatio(freqs);
    if (r) {
      big = (r.exact ? '' : '\u2248 ') + r.ints.join(' : ');
      const name = CHORD_NAMES[r.ints.join(':')];
      small = (name ? name + '   \u2022   ' : '') +
              'fundamental ' + r.fundamental.toFixed(1) + ' Hz';
    } else {
      big = '\u2248 ' + freqs.map(f => (f / freqs[0]).toFixed(2)).join(' : ');
      small = 'complex / inharmonic \u2014 no simple ratio';
    }
  }

  push();
  textAlign(CENTER, CENTER);
  noStroke();
  fill(255);
  textSize(min(38, (CANVAS_W - 80) / (big.length * 0.62)));
  text(big, CANVAS_W / 2, 150);
  textSize(16);
  fill(180, 200, 220);
  text(small, CANVAS_W / 2, 188);
  pop();
}

function drawVisualizer() {
  // Panel background.
  noStroke();
  fill(12, 14, 19);
  rect(0, VIZ_TOP, CANVAS_W, VIZ_BOTTOM);

  if (!fft) {
    fill(180);
    textSize(14);
    text('(sound library not loaded — buttons still shown)', CANVAS_W / 2, (VIZ_TOP + VIZ_BOTTOM) / 2);
    return;
  }

  const waveform = fft.waveform();
  fft.analyze(); // populates the spectrum used by getEnergy() below

  const midY = (VIZ_TOP + VIZ_BOTTOM) / 2;

  // Spectrum bars (lower half, dim). Sample energy on a logarithmic
  // frequency scale (50 Hz -> 8 kHz) so musical pitches spread evenly
  // across the width instead of bunching up at the far left.
  const bars = 96;
  const barW = CANVAS_W / bars;
  const minF = 50;
  const maxF = 8000;
  colorMode(HSB, 360, 100, 100, 100);
  for (let i = 0; i < bars; i++) {
    const f = minF * Math.pow(maxF / minF, i / (bars - 1));
    const amp = fft.getEnergy(f);
    const h = map(amp, 0, 255, 0, (VIZ_BOTTOM - VIZ_TOP) / 2);
    const hue = map(i, 0, bars, 180, 320);
    fill(hue, 70, 90, 35);
    rect(i * barW, VIZ_BOTTOM - h, barW - 1, h);
  }
  colorMode(RGB, 255);

  // Waveform line (centered).
  noFill();
  stroke(120, 220, 255);
  strokeWeight(2);
  beginShape();
  for (let i = 0; i < waveform.length; i++) {
    const x = map(i, 0, waveform.length, 0, CANVAS_W);
    const y = midY + waveform[i] * (VIZ_BOTTOM - VIZ_TOP) * 0.45;
    vertex(x, y);
  }
  endShape();
  strokeWeight(1);

  // Center line.
  stroke(60, 65, 80);
  line(0, midY, CANVAS_W, midY);
  noStroke();
}

function drawButtons() {
  colorMode(HSB, 360, 100, 100, 100);
  textSize(14);
  for (const b of buttons) {
    const isActive = activeNotes.hasOwnProperty(b.key);
    const hue = map(b.index, 0, Math.max(1, buttons.length - 1), 200, 360);

    if (isActive) {
      fill(hue, 80, 95);
      stroke(0, 0, 100);
      strokeWeight(2);
    } else {
      fill(hue, 55, 45);
      stroke(hue, 40, 70);
      strokeWeight(1);
    }
    rect(b.x, b.y, b.w, b.h, 8);

    // Key label.
    noStroke();
    fill(0, 0, 100);
    textSize(min(28, b.h * 0.35));
    text(b.key.toUpperCase(), b.x + b.w / 2, b.y + b.h * 0.40);

    // Ratio labels (Just Intonation mode only): pure fraction + x multiple.
    if (b.ratioLabel) {
      textSize(min(20, b.w * 0.22));
      fill(0, 0, 100);
      text(b.ratioLabel, b.x + b.w / 2, b.y + b.h * 0.58);
    }
    if (b.multLabel) {
      textSize(min(15, b.w * 0.16));
      fill(0, 0, 95, 90);
      text(b.multLabel, b.x + b.w / 2, b.y + b.h * 0.72);
    }

    // Frequency label.
    textSize(min(13, b.w * 0.14));
    fill(0, 0, 85, 80);
    text(b.freq.toFixed(1) + ' Hz', b.x + b.w / 2, b.y + b.h * 0.86);
  }
  colorMode(RGB, 255);
  strokeWeight(1);
}

function drawSliders() {
  noStroke();
  fill(230);
  textAlign(CENTER, CENTER);
  textSize(16);
  text('Base Frequency: ' + freqSlider.value() + ' Hz', LEFT_CX, SLIDER_TOP + 12);
  text('Intervals / Buttons: ' + intervalSlider.value(), RIGHT_CX, SLIDER_TOP + 12);
}

// ---- Sound ----

function startNote(key) {
  if (activeNotes[key]) return;
  const btn = buttons.find(b => b.key === key);
  if (!btn) return;
  if (typeof p5.Oscillator === 'undefined') return;

  userStartAudio();

  const osc = new p5.Oscillator('sine');
  const env = new p5.Envelope();
  // attack time, attack level, decay time, sustain level
  env.setADSR(0.01, 0.12, 0.25, 0.6);
  env.setRange(0.6, 0);

  osc.freq(btn.freq);
  osc.amp(env);
  osc.start();
  env.triggerAttack(osc);

  activeNotes[key] = { osc, env, freq: btn.freq, index: btn.index };
}

function stopNote(key) {
  const note = activeNotes[key];
  if (!note) return;
  note.env.triggerRelease(note.osc);
  // Stop & dispose the oscillator after the release tail finishes.
  setTimeout(() => {
    note.osc.stop();
  }, 800);
  delete activeNotes[key];
}

// True when the user is typing into one of the text inputs, so we
// don't trigger notes while they edit the frequency / interval fields.
function typingInInput() {
  const el = document.activeElement;
  return el && el.tagName === 'INPUT';
}

function keyPressed() {
  if (typingInInput()) return;
  const k = key.toLowerCase();
  if (KEY_ORDER.includes(k)) {
    startNote(k);
  }
}

function keyReleased() {
  if (typingInInput()) return;
  const k = key.toLowerCase();
  if (KEY_ORDER.includes(k)) {
    stopNote(k);
  }
}

// Mouse support: click a button to play it briefly.
function mousePressed() {
  for (const b of buttons) {
    if (mouseX >= b.x && mouseX <= b.x + b.w &&
        mouseY >= b.y && mouseY <= b.y + b.h) {
      startNote(b.key);
      mouseHeldKey = b.key;
      return;
    }
  }
}

let mouseHeldKey = null;
function mouseReleased() {
  if (mouseHeldKey) {
    stopNote(mouseHeldKey);
    mouseHeldKey = null;
  }
}
