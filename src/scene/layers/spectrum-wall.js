// Fullscreen scrolling cochleagram + harmonic profile + MIDI note strip + feature strip +
// MFCC strip + overlays (Circle of Fifths, timbre space, voice arrows).
// Pure 2D canvas rendering — no WebGL/Three.js.

import { SPECTRUM_BINS, NUM_BANDS, store as featureStore } from '../../store/feature-store.js';

// ── Multi-voice pitch detection (subharmonic summation) ──
const MAX_VOICES = 4;

function detectMultiPitch(spectrumDb, sampleRate, fftSize) {
  const binHz = sampleRate / fftSize;
  const minF0 = 60, maxF0 = 2000;
  const minBin = Math.floor(minF0 / binHz);
  const maxBin = Math.min(Math.floor(maxF0 / binHz), SPECTRUM_BINS - 1);
  const numHarmonics = 8;

  const scores = new Float32Array(maxBin + 1);

  for (let b = minBin; b <= maxBin; b++) {
    let sum = 0;
    let count = 0;
    for (let h = 1; h <= numHarmonics; h++) {
      const hBin = b * h;
      if (hBin >= SPECTRUM_BINS) break;
      const weight = 1 / h;
      const db = spectrumDb[hBin];
      const power = Math.pow(10, db / 20);
      sum += power * weight;
      count += weight;
    }
    scores[b] = count > 0 ? sum / count : 0;
  }

  const peaks = [];
  for (let b = minBin + 1; b < maxBin; b++) {
    if (scores[b] > scores[b - 1] && scores[b] > scores[b + 1] && scores[b] > 0.0001) {
      peaks.push({ bin: b, score: scores[b], freq: b * binHz });
    }
  }
  peaks.sort((a, b) => b.score - a.score);

  const voices = [];
  for (const peak of peaks) {
    if (voices.length >= MAX_VOICES) break;
    let isHarmonic = false;
    for (const v of voices) {
      const ratio = peak.freq / v.freq;
      const nearestInt = Math.round(ratio);
      if (nearestInt >= 2 && Math.abs(ratio - nearestInt) < 0.08) {
        isHarmonic = true;
        break;
      }
      const ratio2 = v.freq / peak.freq;
      const nearestInt2 = Math.round(ratio2);
      if (nearestInt2 >= 2 && Math.abs(ratio2 - nearestInt2) < 0.08) {
        isHarmonic = true;
        break;
      }
    }
    if (!isHarmonic) {
      voices.push({ freq: peak.freq, strength: peak.score });
    }
  }

  return voices;
}

const DPR = Math.min(window.devicePixelRatio || 1, 2);
const CANVAS_W = Math.round(window.innerWidth * DPR);
const CANVAS_H = Math.round(window.innerHeight * DPR);
const ARROW_W = Math.round(90 * DPR); // reserved for voice arrows on right
const SCROLL_W = CANVAS_W - ARROW_W;  // scrolling area stops before arrows
const FREQ_ROW_PX = 1;
// Layout: cochleagram → harmonics → notes (MIDI roll) → features → mfcc
// Overlays: voice arrows (right), Circle of Fifths + timbre space (bottom-left)
const COCHLEA_H = Math.round(CANVAS_H * 0.48);
const NUM_FREQ_ROWS = COCHLEA_H; // 1 row per pixel
const HARM_ROWS = 32;
const HARM_MAX = 16; // only display first 16 harmonics, spread across 32 rows
const HARM_H = Math.round(CANVAS_H * 0.17);
const HARM_ROW_PX = Math.round(HARM_H / HARM_ROWS);
const HARM_Y = COCHLEA_H;
const NOTE_ROWS = 12;
const NOTE_H = Math.round(CANVAS_H * 0.07);
const NOTE_ROW_PX = Math.round(NOTE_H / NOTE_ROWS);
const NOTE_Y = HARM_Y + HARM_H;
const MFCC_ROWS = 13;
const MFCC_H = Math.round(CANVAS_H * 0.08);
const MFCC_ROW_PX = Math.round(MFCC_H / MFCC_ROWS);
const FEAT_H = CANVAS_H - COCHLEA_H - HARM_H - NOTE_H - MFCC_H;
const FEAT_ROW_PX = Math.round(FEAT_H / 8);
const FEAT_Y = NOTE_Y + NOTE_H;
const MFCC_Y = FEAT_Y + FEAT_H;

const FREQ_LO = 50;
const FREQ_HI = 16000;
const SAMPLE_RATE = 44100;
const FFT_SIZE = 8192;
const BIN_HZ = SAMPLE_RATE / FFT_SIZE;

// Piecewise frequency mapping: compress extremes, expand 200-8000Hz
// 30 rows for 50-200Hz | 240 rows for 200-8000Hz | 30 rows for 8000-16000Hz
const ZONE_LO_ROWS = Math.round(NUM_FREQ_ROWS * 0.07);
const ZONE_HI_ROWS = Math.round(NUM_FREQ_ROWS * 0.07);
const ZONE_MID_ROWS = NUM_FREQ_ROWS - ZONE_LO_ROWS - ZONE_HI_ROWS;
const ZONE_LO_FREQ = 200;
const ZONE_HI_FREQ = 8000;

function rowToFreq(r) {
  if (r < ZONE_LO_ROWS) {
    return FREQ_LO * Math.pow(ZONE_LO_FREQ / FREQ_LO, r / (ZONE_LO_ROWS - 1));
  } else if (r < ZONE_LO_ROWS + ZONE_MID_ROWS) {
    const mr = r - ZONE_LO_ROWS;
    return ZONE_LO_FREQ * Math.pow(ZONE_HI_FREQ / ZONE_LO_FREQ, mr / (ZONE_MID_ROWS - 1));
  } else {
    const hr = r - ZONE_LO_ROWS - ZONE_MID_ROWS;
    return ZONE_HI_FREQ * Math.pow(FREQ_HI / ZONE_HI_FREQ, hr / (ZONE_HI_ROWS - 1));
  }
}

function freqToRow(freq) {
  if (freq <= FREQ_LO) return 0;
  if (freq < ZONE_LO_FREQ) {
    return (ZONE_LO_ROWS - 1) * Math.log(freq / FREQ_LO) / Math.log(ZONE_LO_FREQ / FREQ_LO);
  } else if (freq < ZONE_HI_FREQ) {
    return ZONE_LO_ROWS + (ZONE_MID_ROWS - 1) * Math.log(freq / ZONE_LO_FREQ) / Math.log(ZONE_HI_FREQ / ZONE_LO_FREQ);
  } else if (freq < FREQ_HI) {
    return ZONE_LO_ROWS + ZONE_MID_ROWS + (ZONE_HI_ROWS - 1) * Math.log(freq / ZONE_HI_FREQ) / Math.log(FREQ_HI / ZONE_HI_FREQ);
  }
  return NUM_FREQ_ROWS - 1;
}

// Pre-compute FFT bin indices for each frequency row
const rowBins = new Int32Array(NUM_FREQ_ROWS);
for (let r = 0; r < NUM_FREQ_ROWS; r++) {
  rowBins[r] = Math.round(rowToFreq(r) / BIN_HZ);
}

// ── Perceptual compression settings ──
// spectrumSmooth values are dB (typically -100 to 0 from getFloatFrequencyData).
// We normalize to 0-1, apply strong gamma compression so quiet details are
// visible and loud signals don't saturate. One "sensitivity" offset shifts
// the entire curve up/down.
let sensitivity = -12;  // dB offset (positive = brighter, negative = dimmer)
const DB_FLOOR = -100;  // absolute bottom of dB range
const DB_RANGE = 100;   // total range (maps -100..0 to 0..1)
const GAMMA = 0.35;     // strong compression — expands quiet, compresses loud

let scrollSpeed = 8;
let featGain = 25;

export function setSensitivity(db) {
  sensitivity = db;
  featureStore._sensitivity = db;  // share with chroma analysis module
}

export function setScrollSpeed(px) {
  scrollSpeed = Math.max(1, Math.min(20, px));
}

export function setFeatGain(g) {
  featGain = Math.max(1, Math.min(50, g));
}

// ── Full-spectrum colormap (black → blue → cyan → yellow → red → magenta → green → white) ──
const CSTOPS = [
  [0.00, 0, 0, 0],
  [0.12, 0, 0, 150],
  [0.24, 0, 120, 220],
  [0.36, 0, 210, 180],
  [0.48, 200, 220, 0],
  [0.60, 240, 120, 0],
  [0.72, 220, 0, 60],
  [0.84, 180, 0, 220],
  [0.92, 0, 220, 80],
  [1.00, 255, 255, 255],
];

const cmapLUT = new Uint8Array(256 * 3);
for (let i = 0; i < 256; i++) {
  const t = i / 255;
  let lo = CSTOPS[0], hi = CSTOPS[CSTOPS.length - 1];
  for (let s = 0; s < CSTOPS.length - 1; s++) {
    if (t >= CSTOPS[s][0] && t <= CSTOPS[s + 1][0]) {
      lo = CSTOPS[s];
      hi = CSTOPS[s + 1];
      break;
    }
  }
  const span = hi[0] - lo[0];
  const f = span > 0 ? (t - lo[0]) / span : 0;
  cmapLUT[i * 3] = Math.round(lo[1] + (hi[1] - lo[1]) * f);
  cmapLUT[i * 3 + 1] = Math.round(lo[2] + (hi[2] - lo[2]) * f);
  cmapLUT[i * 3 + 2] = Math.round(lo[3] + (hi[3] - lo[3]) * f);
}

// ── Pitch-class colors for MIDI note view (one hue per semitone, cycling the color wheel) ──
const PITCH_CLASS_COLORS = [
  [255, 60, 60],    // C  - red
  [255, 130, 40],   // C# - orange
  [240, 200, 40],   // D  - yellow
  [160, 230, 50],   // D# - yellow-green
  [60, 210, 70],    // E  - green
  [40, 200, 150],   // F  - teal
  [40, 180, 220],   // F# - cyan
  [60, 120, 240],   // G  - blue
  [110, 70, 230],   // G# - indigo
  [170, 60, 220],   // A  - purple
  [220, 60, 180],   // A# - magenta
  [240, 60, 120],   // B  - pink
];
const NOTE_LABELS = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

// ── Timbre space constants ──
const TIMBRE_SZ = Math.round(Math.min(CANVAS_H * 0.09, CANVAS_W * 0.10));
const TRAIL_LEN = 120; // 2 seconds at 60fps

// Band thresholds for energy ratio features
const HIGH_FREQ_BAND = 19; // ~3kHz with 28 bands from 30-20kHz

// Extract top N frequencies from spectrum via iterative argmax + suppression + merge
function extractTopFreqs(spectrumDb, binHz, n, minHz, maxHz) {
  const minBin = Math.max(1, Math.floor(minHz / binHz));
  const maxBin = Math.min(SPECTRUM_BINS - 1, Math.floor(maxHz / binHz));
  // Copy relevant dB values to work array
  const vals = new Float32Array(maxBin - minBin + 1);
  for (let i = 0; i < vals.length; i++) vals[i] = spectrumDb[minBin + i];

  // Iterative peak picking with suppression
  const raw = [];
  const suppressBins = Math.max(1, Math.round(15 / binHz)); // suppress ±15Hz
  for (let iter = 0; iter < n * 4 && iter < 32; iter++) {
    let bestIdx = 0, bestVal = -200;
    for (let i = 0; i < vals.length; i++) {
      if (vals[i] > bestVal) { bestVal = vals[i]; bestIdx = i; }
    }
    if (bestVal < -120) break;
    const freq = (minBin + bestIdx) * binHz;
    raw.push({ freq, db: bestVal });
    // Suppress nearby bins
    const lo = Math.max(0, bestIdx - suppressBins);
    const hi = Math.min(vals.length - 1, bestIdx + suppressBins);
    for (let i = lo; i <= hi; i++) vals[i] = -200;
  }

  // Merge nearby peaks (within 15% of frequency)
  raw.sort((a, b) => a.freq - b.freq);
  const merged = [];
  for (const p of raw) {
    if (merged.length > 0) {
      const last = merged[merged.length - 1];
      if (Math.abs(p.freq - last.freq) < last.freq * 0.15) {
        if (p.db > last.db) merged[merged.length - 1] = p;
        continue;
      }
    }
    merged.push(p);
  }

  // Return top N by dB
  merged.sort((a, b) => b.db - a.db);
  return merged.slice(0, n);
}

// Simple instrument classifier based on spectral shape
function classifyInstrument(topFreqs, pitchHz, pitchConf, spectralCentroid, spectralFlatness, harmonicity, rms) {
  if (rms < 0.005) return { name: 'silence', r: 0, g: 0, b: 0 };

  // Drums: high flatness, no pitch, broadband
  if (spectralFlatness > 0.15 && pitchConf < 0.2) {
    return { name: 'drums', r: 180, g: 50, b: 30 };
  }
  // Vocal: pitch present, moderate centroid (200-3000Hz), moderate harmonicity
  if (pitchConf > 0.3 && harmonicity > 0.15 && pitchHz > 70 && pitchHz < 500 &&
      spectralCentroid > 300 && spectralCentroid < 3500) {
    return { name: 'vocal', r: 50, g: 140, b: 50 };
  }
  // Brass: high centroid, strong harmonics, bright
  if (pitchConf > 0.25 && spectralCentroid > 2000 && harmonicity > 0.3) {
    return { name: 'brass', r: 170, g: 130, b: 20 };
  }
  // Strings: moderate centroid, moderate harmonicity, smooth
  if (pitchConf > 0.2 && harmonicity > 0.15 && spectralFlatness < 0.08 &&
      spectralCentroid > 500 && spectralCentroid < 3000) {
    return { name: 'strings', r: 120, g: 60, b: 140 };
  }
  // Piano: pitch + percussive onset, moderate harmonicity
  if (pitchConf > 0.2 && harmonicity > 0.1 && spectralCentroid > 400) {
    return { name: 'piano', r: 60, g: 100, b: 150 };
  }
  // Noise/other
  if (spectralFlatness > 0.08) {
    return { name: 'noise', r: 80, g: 80, b: 80 };
  }
  return { name: 'other', r: 40, g: 40, b: 60 };
}

function freqToCanvasY(freqHz) {
  const r = freqToRow(freqHz);
  return COCHLEA_H - (r + 1) * FREQ_ROW_PX;
}

function buildLabels() {
  const container = document.createElement('div');
  container.id = 'spectrogram-labels';
  document.body.appendChild(container);

  // Frequency labels for the cochleagram
  const freqs = [
    [50, '50'], [100, '100'], [200, '200'], [500, '500'],
    [1000, '1k'], [2000, '2k'], [4000, '4k'], [8000, '8k'], [16000, '16k'],
  ];
  for (const [hz, text] of freqs) {
    const y = freqToCanvasY(hz);
    const pct = (y / CANVAS_H) * 100;
    const label = document.createElement('span');
    label.className = 'spec-label freq-label';
    label.textContent = text;
    label.style.top = `${pct}%`;
    container.appendChild(label);
  }

  // Harmonic profile labels
  const harmLabel = document.createElement('span');
  harmLabel.className = 'spec-label feat-label';
  harmLabel.textContent = 'harmonics';
  harmLabel.style.top = `${((HARM_Y + HARM_H / 2) / CANVAS_H) * 100}%`;
  container.appendChild(harmLabel);

  // h1/h16 markers
  const h1Label = document.createElement('span');
  h1Label.className = 'spec-label feat-label';
  h1Label.textContent = 'h1';
  h1Label.style.top = `${((HARM_Y + HARM_H - HARM_ROW_PX / 2) / CANVAS_H) * 100}%`;
  h1Label.style.left = '38px';
  container.appendChild(h1Label);

  const h16Label = document.createElement('span');
  h16Label.className = 'spec-label feat-label';
  h16Label.textContent = 'h32';
  h16Label.style.top = `${((HARM_Y + HARM_ROW_PX / 2) / CANVAS_H) * 100}%`;
  h16Label.style.left = '38px';
  container.appendChild(h16Label);

  // Chroma strip label
  const chromaLabel = document.createElement('span');
  chromaLabel.className = 'spec-label feat-label';
  chromaLabel.textContent = 'notes';
  chromaLabel.style.top = `${((NOTE_Y + NOTE_H / 2) / CANVAS_H) * 100}%`;
  container.appendChild(chromaLabel);

  // Feature row labels
  const featLabels = [
    'E/flux/sprd', '', '', 'top freq', '', '', '', '',
  ];
  for (let i = 0; i < featLabels.length; i++) {
    const y = FEAT_Y + i * FEAT_ROW_PX + FEAT_ROW_PX / 2;
    const pct = (y / CANVAS_H) * 100;
    const label = document.createElement('span');
    label.className = 'spec-label feat-label';
    label.textContent = featLabels[i];
    label.style.top = `${pct}%`;
    container.appendChild(label);
  }

  // MFCC strip label
  const mfccLabel = document.createElement('span');
  mfccLabel.className = 'spec-label feat-label';
  mfccLabel.textContent = 'mfcc';
  mfccLabel.style.top = `${((MFCC_Y + MFCC_H / 2) / CANVAS_H) * 100}%`;
  container.appendChild(mfccLabel);
}

export function createSpectrumWall() {
  const canvas = document.createElement('canvas');
  canvas.width = CANVAS_W;
  canvas.height = CANVAS_H;
  canvas.id = 'spectrogram';
  document.body.appendChild(canvas);
  buildLabels();

  const ctx = canvas.getContext('2d', { willReadFrequently: false });
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

  // Overlay canvas for voice circles (doesn't scroll)
  const overlay = document.createElement('canvas');
  overlay.width = CANVAS_W;
  overlay.height = CANVAS_H;
  overlay.id = 'spectrogram-overlay';
  overlay.style.cssText = 'position:fixed;top:0;left:0;width:100vw;height:100vh;z-index:1;pointer-events:none';
  document.body.appendChild(overlay);
  const oCtx = overlay.getContext('2d');

  // ── BTrack beat tracker (Adam Stark, 2014) — proper implementation ──
  // Uses cumulative score ARRAY that chains evidence backward by one period.
  const BT_BUF_LEN = 512;
  const BT_MIN_LAG = 22;  // ~164 BPM at 60fps
  const BT_MAX_LAG = 60;  // ~60 BPM at 60fps
  const btOdf = new Float32Array(BT_BUF_LEN);
  const btCumScore = new Float32Array(BT_BUF_LEN);
  let btIdx = 0;
  let btPeriod = 0;        // 0 = no tempo detected yet
  let btCounter = 999;     // won't fire until period is set
  let btOdfEnergy = 0;
  let btConfirmedBeats = 0;  // consecutive beats with strong ODF at predicted time
  let btShowBeats = false;   // only true after enough confirmed beats
  let btSilenceTimer = 0;    // frames since last confirmed beat
  let btFrameCount = 0;
  let beatFlash = 0;
  let btBeatCount = 0;
  let btShowBpm = 0;
  let btLastBeatTime = 0; // timestamp of last emitted beat
  let prevFlux = 0;
  let brightBinAvg = 0;
  let prevDomY = -1;
  let prevDomRow = -1;
  let domStableFrames = 0;
  let transientCooldown = 0;
  let noiseGateSmooth = 0; // smoothed noise gate to prevent jitter
  let prevCentroid = 0;
  let centroidStable = 0; // counts stable frames
  let prevFluxY = -1;
  let prevDerivY = -1;
  let btTempoCounter = 0;

  // ── MFCC adaptive normalization state ──
  const mfccMin = new Float32Array(13).fill(0);
  const mfccMax = new Float32Array(13).fill(1);
  let mfccInitFrames = 0;

  // ── Timbre space trail ──
  const timbreTrailX = new Float32Array(TRAIL_LEN);
  const timbreTrailY = new Float32Array(TRAIL_LEN);
  const timbreTrailR = new Uint8Array(TRAIL_LEN);
  const timbreTrailG = new Uint8Array(TRAIL_LEN);
  const timbreTrailB = new Uint8Array(TRAIL_LEN);
  let trailIdx = 0;
  let trailCount = 0;

  // ── Key/chord display smoothing ──
  let displayKey = '';
  let displayChord = '';
  let keyHoldFrames = 0;
  let chordHoldFrames = 0;

  // Gaussian weight lookup for ±period window
  function btGaussWeight(dist, period) {
    const sigma = period * 0.15;
    return Math.exp(-0.5 * (dist * dist) / (sigma * sigma));
  }

  function btEstimateTempo() {
    // Compute autocorrelation energy at lag 0 for normalization
    let bestLag = 0, bestCorr = -1;
    for (let lag = BT_MIN_LAG; lag <= BT_MAX_LAG; lag++) {
      let corr = 0;
      const n = BT_BUF_LEN - lag;
      for (let i = 0; i < n; i++) {
        const a = (btIdx - 1 - i + BT_BUF_LEN) % BT_BUF_LEN;
        const b = (a - lag + BT_BUF_LEN) % BT_BUF_LEN;
        corr += btOdf[a] * btOdf[b];
      }
      // Rayleigh weighting centered ~120 BPM (lag 30)
      const r = lag / 30;
      corr *= r * Math.exp(-0.5 * r * r);
      if (corr > bestCorr) { bestCorr = corr; bestLag = lag; }
    }
    return bestLag;
  }

  // Pre-allocate ImageData column buffer for pixel-perfect cochleagram rendering
  const colImg = ctx.createImageData(1, COCHLEA_H);
  // Track previous harmonic amplitudes for temporal derivative
  const prevHarmAmps = new Float32Array(HARM_ROWS);
  const prevGamma = new Float32Array(NUM_FREQ_ROWS);

  return {
    mesh: null,

    update(storeRef, dt, time) {
      ctx.drawImage(canvas, -scrollSpeed, 0);
      ctx.clearRect(SCROLL_W - scrollSpeed, 0, scrollSpeed, CANVAS_H);

      const spectrum = storeRef.spectrumDb;
      const s = storeRef;

      // ── Cochleagram via ImageData (pixel-perfect, no fillRect overhead) ──
      const curGamma = new Float32Array(NUM_FREQ_ROWS);
      for (let r = 0; r < NUM_FREQ_ROWS; r++) {
        const bin = Math.min(SPECTRUM_BINS - 1, rowBins[r]);
        const raw = (spectrum[bin] + sensitivity - DB_FLOOR) / DB_RANGE;
        const gated = Math.max(0, raw - 0.08) / 0.92;
        curGamma[r] = Math.pow(Math.min(1, gated), GAMMA);
      }

      // Paint each pixel column with interpolated data
      for (let px = 0; px < scrollSpeed; px++) {
        const t = scrollSpeed > 1 ? px / (scrollSpeed - 1) : 1;
        const data = colImg.data;
        for (let r = 0; r < NUM_FREQ_ROWS; r++) {
          const g = prevGamma[r] + (curGamma[r] - prevGamma[r]) * t;
          const cidx = Math.max(0, Math.min(255, Math.round(g * 255))) * 3;
          // Row r maps to canvas Y = COCHLEA_H - r - 1 (high freq at top)
          const pixIdx = (COCHLEA_H - r - 1) * 4;
          data[pixIdx] = cmapLUT[cidx];
          data[pixIdx + 1] = cmapLUT[cidx + 1];
          data[pixIdx + 2] = cmapLUT[cidx + 2];
          data[pixIdx + 3] = 255;
        }
        ctx.putImageData(colImg, SCROLL_W - scrollSpeed + px, 0);
      }

      prevGamma.set(curGamma);

      const rightX = SCROLL_W - scrollSpeed;

      // ── Noise fuzz overlay — only for noisy/aperiodic content ──
      // Gate: suppress when harmonicity or pitch confidence is high (tonal sound)
      const noiseGateRaw = Math.max(0, 1 - s.harmonicity * 2 - s.pitchConfidence * 1.5);
      noiseGateSmooth += 0.15 * (noiseGateRaw - noiseGateSmooth); // smooth the gate itself
      const noiseGate = noiseGateSmooth;
      let lowE = 0, midE = 0, hiE = 0;
      for (let i = 0; i < NUM_BANDS; i++) {
        const e = s.bandEnergySmooth[i];
        if (i < 7) lowE += e;
        else if (i < 19) midE += e;
        else hiE += e;
      }
      const totalE = lowE + midE + hiE;
      if (totalE > 0.001 && noiseGate > 0.15) {
        const gs = noiseGate * 6; // scale by how noisy it is
        const lowI = Math.min(1, lowE * gs);
        const midI = Math.min(1, midE * gs);
        const hiI = Math.min(1, hiE * gs);
        const lowR = lowE / totalE, hiR = hiE / totalE;

        const fuzzPx = 4;
        const fuzzRowH = Math.round(COCHLEA_H * 0.05); // ~5% of cochleagram per row
        // 3 rows at the very top of the cochleagram: high / mid / low

        // Row 1 (top): High freq — cyan if hissy, white if balanced
        if (hiI > 0.05) {
          const n = Math.round(hiI * 40 * scrollSpeed);
          const hissy = hiR > 0.4;
          const cr = hissy ? 120 : 240, cg = hissy ? 230 : 240, cb = 250;
          for (let p = 0; p < n; p++) {
            const a = (0.3 + Math.random() * 0.5) * hiI;
            ctx.fillStyle = `rgba(${cr},${cg},${cb},${a})`;
            ctx.fillRect(rightX + Math.floor(Math.random() * scrollSpeed),
              Math.floor(Math.random() * fuzzRowH), fuzzPx, fuzzPx);
          }
        }
        // Row 2: Mid freq — pink or grey
        if (midI > 0.05) {
          const n = Math.round(midI * 40 * scrollSpeed);
          const pink = lowR > 0.35;
          const cr = pink ? 220 : 200, cg = pink ? 100 : 200, cb = pink ? 160 : 200;
          for (let p = 0; p < n; p++) {
            const a = (0.3 + Math.random() * 0.5) * midI;
            ctx.fillStyle = `rgba(${cr},${cg},${cb},${a})`;
            ctx.fillRect(rightX + Math.floor(Math.random() * scrollSpeed),
              fuzzRowH + Math.floor(Math.random() * fuzzRowH), fuzzPx, fuzzPx);
          }
        }
        // Row 3: Low freq — brown/red
        if (lowI > 0.05) {
          const n = Math.round(lowI * 40 * scrollSpeed);
          for (let p = 0; p < n; p++) {
            const a = (0.3 + Math.random() * 0.5) * lowI;
            ctx.fillStyle = `rgba(180,70,30,${a})`;
            ctx.fillRect(rightX + Math.floor(Math.random() * scrollSpeed),
              fuzzRowH * 2 + Math.floor(Math.random() * fuzzRowH), fuzzPx, fuzzPx);
          }
        }
      }

      // Detect voices once — used for cochleagram lines, top-freq band, and arrows
      const voices = s.signalPresent
        ? detectMultiPitch(spectrum, SAMPLE_RATE, FFT_SIZE)
        : [];
      const VOICE_COLORS = [
        [255, 120, 0],
        [0, 170, 255],
        [70, 255, 70],
        [255, 70, 255],
      ];

      // ── Feature markers overlaid on cochleagram at actual freq positions ──
      // Only draw when there's actual signal — smoothed values linger after sound stops
      if (s.signalPresent) {

      // All overlay colors chosen to contrast against inferno colormap
      // (inferno = black→purple→red→orange→yellow→white)
      // Best contrast: bright green, bright cyan, white

      // Pitch fundamental — white line
      if (s.pitchSmooth > FREQ_LO && s.pitchConfidence > 0.15) {
        const py = freqToCanvasY(s.pitchSmooth);
        const thick = Math.round(Math.max(2, COCHLEA_H * 0.003));
        ctx.fillStyle = `rgba(255,255,255,${Math.min(0.95, s.pitchConfidence * 2)})`;
        ctx.fillRect(rightX, Math.round(py) - Math.floor(thick / 2), scrollSpeed, thick);
      }

      // Formants — bright green dots (F1 brighter, F2/F3 dimmer)
      if (s.formant1Smooth > FREQ_LO) {
        const fy = freqToCanvasY(s.formant1Smooth);
        ctx.fillStyle = 'rgba(0,255,80,0.8)';
        ctx.fillRect(rightX, Math.round(fy) - 1, scrollSpeed, 3);
      }
      if (s.formant2Smooth > FREQ_LO) {
        const fy = freqToCanvasY(s.formant2Smooth);
        ctx.fillStyle = 'rgba(0,255,80,0.6)';
        ctx.fillRect(rightX, Math.round(fy) - 1, scrollSpeed, 3);
      }
      if (s.formant3Smooth > FREQ_LO) {
        const fy = freqToCanvasY(s.formant3Smooth);
        ctx.fillStyle = 'rgba(0,255,80,0.4)';
        ctx.fillRect(rightX, Math.round(fy) - 1, scrollSpeed, 3);
      }

      // Spectral centroid — pink line, only when stable (not jumping wildly)
      if (s.spectralCentroidSmooth > FREQ_LO && s.rmsSmooth > 0.003) {
        const centroidDelta = prevCentroid > 0
          ? Math.abs(s.spectralCentroidSmooth - prevCentroid) / prevCentroid : 1;
        prevCentroid = s.spectralCentroidSmooth;
        if (centroidDelta < 0.08) {
          centroidStable = Math.min(10, centroidStable + 1);
        } else {
          centroidStable = Math.max(0, centroidStable - 2);
        }
        if (centroidStable >= 3) {
          const cy = freqToCanvasY(s.spectralCentroidSmooth);
          const thick = Math.round(Math.max(2, COCHLEA_H * 0.003));
          const fadeIn = Math.min(1, centroidStable / 6);
          ctx.fillStyle = `rgba(255,80,220,${Math.min(0.85, s.rmsSmooth * 40) * fadeIn})`;
          ctx.fillRect(rightX, Math.round(cy) - Math.floor(thick / 2), scrollSpeed, thick);
        }
      } else {
        prevCentroid = 0;
        centroidStable = 0;
      }

      // Voice frequency lines on cochleagram — thick white like pitch line
      for (let i = 0; i < voices.length; i++) {
        const v = voices[i];
        if (v.freq > FREQ_LO && v.freq < FREQ_HI) {
          const vy = freqToCanvasY(v.freq);
          const thick = Math.round(Math.max(2, COCHLEA_H * 0.003));
          const alpha = Math.min(0.85, v.strength * 500);
          ctx.fillStyle = `rgba(255,255,255,${alpha})`;
          ctx.fillRect(rightX, Math.round(vy) - Math.floor(thick / 2), scrollSpeed, thick);
        }
      }

      // Spectral rolloff — cyan line on cochleagram
      if (s.spectralRolloff > FREQ_LO && s.rmsSmooth > 0.005) {
        const ry = freqToCanvasY(s.spectralRolloff);
        ctx.fillStyle = 'rgba(0,220,255,0.5)';
        ctx.fillRect(rightX, Math.round(ry), scrollSpeed, 2);
      }

      // (broadband transient lines drawn after all sections below)

      // Plosive burst markers — bright white ticks at active frequency bands
      if (s.soundClass === 4 || (s.isOnset && s.onsetBandwidth > 0.4)) {
        const maxBandE = Math.max(...s.bandEnergySmooth);
        if (maxBandE > 0.001) {
          for (let i = 0; i < NUM_BANDS; i++) {
            const relE = s.bandEnergySmooth[i] / maxBandE;
            if (relE < 0.15) continue;
            const bandFreq = 30 * Math.pow(20000 / 30, i / (NUM_BANDS - 1));
            if (bandFreq < FREQ_LO || bandFreq > FREQ_HI) continue;
            const by = freqToCanvasY(bandFreq);
            ctx.fillStyle = `rgba(255,255,255,${Math.min(0.8, relE)})`;
            ctx.fillRect(rightX, Math.round(by) - 1, scrollSpeed, 3);
          }
        }
      }

      // Fricative markers — bright cyan dashes at high-freq bands
      if (s.soundClass === 3) {
        for (let i = HIGH_FREQ_BAND; i < NUM_BANDS; i++) {
          const bandFreq = 30 * Math.pow(20000 / 30, i / (NUM_BANDS - 1));
          if (bandFreq < FREQ_LO || bandFreq > FREQ_HI) continue;
          const by = freqToCanvasY(bandFreq);
          if (s.bandEnergySmooth[i] < 0.001) continue;
          ctx.fillStyle = 'rgba(0,255,200,0.5)';
          ctx.fillRect(rightX, Math.round(by), scrollSpeed, 2);
        }
      }

      // Harmonic series overlay — bright green dots at each overtone
      if (s.pitchSmooth > FREQ_LO && s.pitchConfidence > 0.25) {
        for (let h = 1; h < 32; h++) {
          const hFreq = s.pitchSmooth * (h + 1);
          if (hFreq > FREQ_HI) break;
          const amp = s.harmonicAmplitudes[h];
          if (amp < 0.01) continue;
          const hy = freqToCanvasY(hFreq);
          if (hy < 0 || hy >= COCHLEA_H) continue;
          ctx.fillStyle = `rgba(0,255,160,${Math.min(0.7, amp * 3)})`;
          ctx.fillRect(rightX, Math.round(hy), scrollSpeed, 2);
        }
      }

      } // end signalPresent gate for overlay markers

      // ── Harmonic profile strip ──
      // 5 visual dimensions per harmonic:
      //   Brightness = amplitude (sqrt compressed)
      //   Hue = spectral envelope slope at this harmonic:
      //     warm red/orange = formant peak (energy peaks here)
      //     cool blue/cyan = formant valley (energy dips here)
      //   Saturation = harmonic purity (peak vs surrounding noise)
      //     vivid = clean harmonic, grey = noisy/breathy
      //   Intensity boost = temporal derivative (attack flash / decay dim)
      //   Odd/even tint = structural timbre signature

      // Use autocorrelation pitch if available, otherwise strongest voice from multi-pitch
      let f0 = s.pitchSmooth > 0 ? s.pitchSmooth : 0;
      if (f0 === 0 && voices.length > 0) {
        f0 = voices[0].freq;
      }
      const binHz = SAMPLE_RATE / FFT_SIZE;

      let dominantRow = -1, dominantAmp = 0;
      for (let row = 0; row < HARM_ROWS; row++) {
        // Map 32 rows to 16 harmonics (2 rows per harmonic, interpolated)
        const hFloat = row / HARM_ROWS * HARM_MAX;
        const h = Math.min(HARM_MAX - 1, Math.floor(hFloat));
        const hFrac = hFloat - h;
        const h2 = Math.min(HARM_MAX - 1, h + 1);

        // Use store harmonicAmplitudes if available, otherwise compute from spectrum
        let amp = s.harmonicAmplitudes[h] * (1 - hFrac) + s.harmonicAmplitudes[h2] * hFrac;
        if (amp < 1e-6 && f0 > 0) {
          // Compute directly from spectrum at expected harmonic frequency
          const hFreq1 = f0 * (h + 1);
          const hFreq2 = f0 * (h2 + 1);
          const bin1 = Math.round(hFreq1 / binHz);
          const bin2 = Math.round(hFreq2 / binHz);
          if (bin1 > 0 && bin1 < SPECTRUM_BINS && bin2 > 0 && bin2 < SPECTRUM_BINS) {
            const db1 = spectrum[bin1];
            const db2 = spectrum[bin2];
            const pow1 = Math.pow(10, db1 / 20);
            const pow2 = Math.pow(10, db2 / 20);
            amp = pow1 * (1 - hFrac) + pow2 * hFrac;
          }
        }
        // dB compression: amp=1→1, 0.01→0.6, 0.001→0.4, 0.0001→0.2, 0.00001→0.0
        const v = amp > 1e-6 ? Math.max(0, Math.min(1, 1 + Math.log10(amp) / 5)) : 0;
        if (amp > dominantAmp && h > 0) { dominantAmp = amp; dominantRow = row; } // skip h0 (fundamental always loudest)

        // ── Spectral slope at this harmonic (formant peak vs valley) ──
        let slopeHue = 0.5; // neutral
        if (f0 > 0) {
          const hFreq = f0 * (hFloat + 1);
          const centerBin = Math.round(hFreq / binHz);
          if (centerBin > 3 && centerBin < SPECTRUM_BINS - 3) {
            const here = spectrum[centerBin];
            const below = (spectrum[centerBin - 3] + spectrum[centerBin - 2]) / 2;
            const above = (spectrum[centerBin + 2] + spectrum[centerBin + 3]) / 2;
            const avgSurround = (below + above) / 2;
            const prominence = (here - avgSurround) / 20;
            slopeHue = Math.max(0, Math.min(1, 0.5 + prominence));
          }
        }

        // ── Harmonic purity (peak vs local noise floor) ──
        let purity = 0.5;
        if (f0 > 0) {
          const hFreq = f0 * (hFloat + 1);
          const centerBin = Math.round(hFreq / binHz);
          if (centerBin > 5 && centerBin < SPECTRUM_BINS - 5) {
            const peak = spectrum[centerBin];
            // Noise floor from bins away from harmonics
            let noiseSum = 0;
            let noiseCnt = 0;
            for (let nb = -5; nb <= 5; nb++) {
              if (Math.abs(nb) >= 2) { // skip the peak itself
                noiseSum += spectrum[centerBin + nb];
                noiseCnt++;
              }
            }
            const noiseFloor = noiseCnt > 0 ? noiseSum / noiseCnt : peak;
            purity = Math.max(0, Math.min(1, (peak - noiseFloor) / 15));
          }
        }

        // ── Temporal derivative (attack/decay) ──
        const delta = amp - prevHarmAmps[row];
        const attackBoost = Math.max(0, delta * 4);
        const decayDim = Math.max(0, -delta * 2);
        prevHarmAmps[row] = amp;

        // ── Compose color — harmonic-specific base hues ──
        // H1=white(fundamental), H2=cyan(breathiness), H3=orange(power),
        // H4=blue, H5=yellow(odd/nasal), H6=blue, H7=yellow,
        // H8-10=magenta(brilliance), H11+=grey(upper partials)
        const hNum = Math.round(hFloat) + 1; // 1-based harmonic number
        // Base RGB per harmonic role (before brightness/slope modulation)
        let baseR, baseG, baseB;
        if (hNum === 1)       { baseR = 255; baseG = 255; baseB = 255; } // white — fundamental
        else if (hNum === 2)  { baseR = 60;  baseG = 220; baseB = 240; } // cyan — breathiness
        else if (hNum === 3)  { baseR = 255; baseG = 160; baseB = 40;  } // orange — power
        else if (hNum === 5 || hNum === 7) { baseR = 255; baseG = 230; baseB = 50; } // yellow — odd/nasal
        else if (hNum >= 8 && hNum <= 10) { baseR = 230; baseG = 80; baseB = 220; } // magenta — brilliance
        else if (hNum % 2 === 0) { baseR = 80; baseG = 140; baseB = 230; } // blue — even harmonics
        else { baseR = 200; baseG = 170; baseB = 80; } // warm gold — upper odd partials

        // Brightness from amplitude, slight warmth shift in formant peaks
        let r = Math.round(v * baseR);
        let g = Math.round(v * baseG);
        let b = Math.round(v * baseB);

        // Desaturate by purity — keep minimum 80% saturation so colors pop
        const sat = Math.max(0.8, purity);
        const grey = Math.round((r + g + b) / 3);
        r = Math.round(grey + (r - grey) * sat);
        g = Math.round(grey + (g - grey) * sat);
        b = Math.round(grey + (b - grey) * sat);

        // Attack flash (add white) / decay dim (darken)
        const boost = Math.min(1, attackBoost);
        r = Math.min(255, Math.round(r + boost * (255 - r) * 0.5 - decayDim * r * 0.3));
        g = Math.min(255, Math.round(g + boost * (255 - g) * 0.5 - decayDim * g * 0.3));
        b = Math.min(255, Math.round(b + boost * (255 - b) * 0.5 - decayDim * b * 0.3));

        r = Math.max(0, Math.min(255, r));
        g = Math.max(0, Math.min(255, g));
        b = Math.max(0, Math.min(255, b));

        ctx.fillStyle = `rgb(${r},${g},${b})`;
        // Evenly distribute rows across full HARM_H (h=0 at bottom, h=31 at top)
        const yTop = HARM_Y + Math.round((HARM_ROWS - 1 - row) / HARM_ROWS * HARM_H);
        const yBot = HARM_Y + Math.round((HARM_ROWS - row) / HARM_ROWS * HARM_H);
        ctx.fillRect(rightX, yTop, scrollSpeed, yBot - yTop);
      }

      // Thick white line over the dominant harmonic — only when stable ~200ms
      if (dominantRow >= 0 && dominantAmp > 1e-4) {
        // Track stability: same row (±1) for consecutive frames
        if (Math.abs(dominantRow - prevDomRow) <= 1) {
          domStableFrames++;
        } else {
          domStableFrames = 0;
        }
        prevDomRow = dominantRow;

        if (domStableFrames >= 12) { // ~200ms at 60fps
          const dTop = HARM_Y + Math.round((HARM_ROWS - 1 - dominantRow) / HARM_ROWS * HARM_H);
          const dBot = HARM_Y + Math.round((HARM_ROWS - dominantRow) / HARM_ROWS * HARM_H);
          const dMid = Math.round((dTop + dBot) / 2);
          if (prevDomY >= 0) {
            const yMin = Math.min(prevDomY, dMid) - 2;
            const yMax = Math.max(prevDomY, dMid) + 2;
            ctx.fillStyle = 'rgba(255,255,255,0.9)';
            ctx.fillRect(rightX, yMin, scrollSpeed, yMax - yMin + 1);
          }
          prevDomY = dMid;
        } else {
          prevDomY = -1;
        }
      } else {
        prevDomRow = -1;
        domStableFrames = 0;
        prevDomY = -1;
      }

      // ── MIDI note view (12 rows — scrolling piano roll of detected chord notes) ──
      // Parse chord to get active pitch classes
      const chordNotes = new Uint8Array(12); // 1 = chord tone, 0 = not
      if (s.signalPresent && s.detectedChordConfidence > 0.4 && displayChord) {
        // Find root note index
        let rootIdx = -1;
        let chordSuffix = '';
        // Try two-char root first (e.g. C#, Db)
        for (let ni = 0; ni < 12; ni++) {
          if (displayChord.startsWith(NOTE_LABELS[ni])) {
            if (NOTE_LABELS[ni].length > 1 || rootIdx < 0) {
              rootIdx = ni;
              chordSuffix = displayChord.slice(NOTE_LABELS[ni].length);
            }
          }
        }
        if (rootIdx >= 0) {
          // Apply chord template intervals
          if (chordSuffix === 'm' || chordSuffix === 'm7') {
            // minor: root, m3, P5
            chordNotes[(rootIdx) % 12] = 1;
            chordNotes[(rootIdx + 3) % 12] = 1;
            chordNotes[(rootIdx + 7) % 12] = 1;
            if (chordSuffix === 'm7') chordNotes[(rootIdx + 10) % 12] = 1;
          } else if (chordSuffix === 'dim') {
            chordNotes[(rootIdx) % 12] = 1;
            chordNotes[(rootIdx + 3) % 12] = 1;
            chordNotes[(rootIdx + 6) % 12] = 1;
          } else if (chordSuffix === '7') {
            chordNotes[(rootIdx) % 12] = 1;
            chordNotes[(rootIdx + 4) % 12] = 1;
            chordNotes[(rootIdx + 7) % 12] = 1;
            chordNotes[(rootIdx + 10) % 12] = 1;
          } else {
            // major: root, M3, P5
            chordNotes[(rootIdx) % 12] = 1;
            chordNotes[(rootIdx + 4) % 12] = 1;
            chordNotes[(rootIdx + 7) % 12] = 1;
          }
        }
      }

      for (let row = 0; row < NOTE_ROWS; row++) {
        const energy = Math.max(0, s.chroma[row]);
        const isChordTone = chordNotes[row] === 1;
        const [cR, cG, cB] = PITCH_CLASS_COLORS[row];
        const yTop = NOTE_Y + Math.round((NOTE_ROWS - 1 - row) / NOTE_ROWS * NOTE_H);
        const yBot = NOTE_Y + Math.round((NOTE_ROWS - row) / NOTE_ROWS * NOTE_H);

        // Threshold: note is "on" if energy > 0.15
        const noteOn = energy > 0.15 && s.signalPresent;

        if (noteOn && isChordTone) {
          // Chord tone — pitch-class color at full brightness, boosted by energy
          const v = Math.min(1, energy * 1.5);
          ctx.fillStyle = `rgb(${Math.round(cR * v)},${Math.round(cG * v)},${Math.round(cB * v)})`;
        } else if (noteOn) {
          // Active but not a chord tone — dim version of pitch-class color
          const v = Math.min(1, energy) * 0.25;
          ctx.fillStyle = `rgb(${Math.round(cR * v)},${Math.round(cG * v)},${Math.round(cB * v)})`;
        } else {
          // Inactive — very dark
          ctx.fillStyle = 'rgb(4,4,8)';
        }
        ctx.fillRect(rightX, yTop, scrollSpeed, yBot - yTop);

        // Thin separator line between rows
        ctx.fillStyle = 'rgba(30,30,40,1)';
        ctx.fillRect(rightX, yBot - 1, scrollSpeed, 1);
      }

      // Key + chord hold smoothing (for Circle of Fifths overlay)
      // Clear cached display values when signal/confidence drops so stale
      // detections don't persist through silence into the next signal.
      if (!s.signalPresent) {
        displayKey = '';
        displayChord = '';
        keyHoldFrames = 0;
        chordHoldFrames = 0;
      } else {
        if (s.detectedKeyConfidence > 0.3) {
          if (s.detectedKey !== displayKey) {
            keyHoldFrames++;
            if (keyHoldFrames > 30) {
              displayKey = s.detectedKey;
              keyHoldFrames = 0;
            }
          } else {
            keyHoldFrames = 0;
          }
        }
        if (s.detectedChordConfidence > 0.5) {
          if (s.detectedChord !== displayChord) {
            chordHoldFrames++;
            if (chordHoldFrames > 10) {
              displayChord = s.detectedChord;
              chordHoldFrames = 0;
            }
          } else {
            chordHoldFrames = 0;
          }
        }
      }
      // Chord text overlay on the note strip — only when signal is present
      if (displayChord && s.signalPresent && btFrameCount % 60 === 0) {
        const fontSize = Math.round(NOTE_H * 0.38);
        ctx.font = `bold ${fontSize}px sans-serif`;
        ctx.fillStyle = 'rgba(255,255,200,0.8)';
        ctx.textAlign = 'right';
        ctx.textBaseline = 'middle';
        ctx.fillText(displayChord, rightX - 4, NOTE_Y + NOTE_H / 2);
        ctx.textAlign = 'left'; // reset
      }

      // ── Feature strip (8 rows) ──
      // No signalPresent gating — each feature stands on its own values.
      const fY = FEAT_Y;

      // Row 1: Combined energy/spread/flux — triple height
      const comboH = FEAT_ROW_PX * 3;
      const eB = Math.min(s.rmsSmooth * featGain, 1);
      const sprdLog = s.spectralSpread > 10
        ? Math.log(s.spectralSpread / 10) / Math.log(4000 / 10) : 0;
      const sprdV = Math.max(0, Math.min(1, sprdLog));
      let esR, esG, esB;
      if (sprdV < 0.33) {
        const t = sprdV / 0.33;
        esR = 30 * (1 - t); esG = 80 + t * 175; esB = 200 * (1 - t) + t * 80;
      } else if (sprdV < 0.66) {
        const t = (sprdV - 0.33) / 0.33;
        esR = t * 230; esG = 255 - t * 30; esB = 80 * (1 - t);
      } else {
        const t = (sprdV - 0.66) / 0.34;
        esR = 230 + t * 25; esG = 225 * (1 - t) + t * 50; esB = t * 30;
      }
      ctx.fillStyle = `rgb(${Math.round(esR * eB)},${Math.round(esG * eB)},${Math.round(esB * eB)})`;
      ctx.fillRect(rightX, fY, scrollSpeed, comboH);
      // Energy envelope line — log-scaled so music doesn't peg at max
      // Use spectral flux directly (not RMS) — spikes on every note onset
      // Flux line (white) — continuous, no gaps
      const fluxRaw = Math.min(1, s.spectralFlux * 0.3);
      const fluxYPos = fY + comboH - 2 - Math.round(fluxRaw * (comboH - 4));
      if (prevFluxY >= 0) {
        const yMin = Math.min(prevFluxY, fluxYPos) - 2;
        const yMax = Math.max(prevFluxY, fluxYPos) + 4;
        ctx.fillStyle = `rgba(255,255,255,${Math.min(0.9, Math.max(fluxRaw, 0.15) * 3)})`;
        ctx.fillRect(rightX, yMin, scrollSpeed, yMax - yMin);
      }
      prevFluxY = fluxYPos;

      // Flux derivative (pink) — continuous, no gaps
      const fluxDeriv = s.spectralFlux - prevFlux;
      prevFlux = s.spectralFlux;
      const derivAbs = Math.min(1, Math.abs(fluxDeriv) * 0.8);
      const mid = fY + Math.round(comboH / 2);
      const derivY = fluxDeriv > 0
        ? mid - Math.round(derivAbs * (comboH / 2 - 2))
        : mid + Math.round(derivAbs * (comboH / 2 - 2));
      if (prevDerivY >= 0) {
        const yMin = Math.min(prevDerivY, derivY) - 2;
        const yMax = Math.max(prevDerivY, derivY) + 4;
        ctx.fillStyle = `rgba(0,0,0,${Math.min(0.9, Math.max(derivAbs, 0.15) * 3)})`;
        ctx.fillRect(rightX, yMin, scrollSpeed, yMax - yMin);
      }
      prevDerivY = derivY;

      // (voices and VOICE_COLORS already computed above)

      // Top frequencies + instrument classification section
      const tfH = FEAT_ROW_PX * 5;
      const tfY = fY + FEAT_ROW_PX * 3;
      const TF_LO = 30, TF_HI = 8000;
      const TF_LOG_RANGE = Math.log(TF_HI / TF_LO);

      // Instrument classification → background color
      const inst = classifyInstrument(
        null, s.pitchSmooth, s.pitchConfidence,
        s.spectralCentroid, s.spectralFlatness, s.harmonicity, s.rmsSmooth
      );
      const instEnergy = s.signalPresent ? Math.min(1, s.rmsSmooth * 15) : 0;
      ctx.fillStyle = `rgb(${Math.round(inst.r * instEnergy)},${Math.round(inst.g * instEnergy)},${Math.round(inst.b * instEnergy)})`;
      ctx.fillRect(rightX, tfY, scrollSpeed, tfH);

      // Map freq to Y within this section
      function tfMapY(freq) {
        const norm = Math.log(Math.max(TF_LO, freq) / TF_LO) / TF_LOG_RANGE;
        return tfY + (1 - Math.max(0, Math.min(1, norm))) * (tfH - 1);
      }

      // Draw top voices as lines (same colors as arrows)
      if (s.signalPresent) {
        const maxLines = Math.min(3, voices.length);
        for (let i = 0; i < maxLines; i++) {
          const ty = tfMapY(voices[i].freq);
          const c = VOICE_COLORS[i];
          const alpha = Math.min(0.9, voices[i].strength * 500);
          ctx.fillStyle = `rgba(${c[0]},${c[1]},${c[2]},${Math.max(0.3, alpha)})`;
          ctx.fillRect(rightX, Math.round(ty) - 1, scrollSpeed, 3);
        }

      }

      // ── MFCC strip (13 rows — MFCC[0] at bottom, MFCC[12] at top) ──
      // Adaptive normalization: track running min/max per coefficient
      mfccInitFrames++;
      for (let k = 0; k < 13; k++) {
        const v = s.mfcc[k];
        if (mfccInitFrames < 30) {
          // Bootstrap: expand range quickly
          mfccMin[k] = Math.min(mfccMin[k], v);
          mfccMax[k] = Math.max(mfccMax[k], v);
        } else {
          // Slow adaptation
          mfccMin[k] += 0.002 * (v - mfccMin[k]);
          mfccMax[k] -= 0.002 * (mfccMax[k] - v);
          mfccMin[k] = Math.min(mfccMin[k], v);
          mfccMax[k] = Math.max(mfccMax[k], v);
        }
      }

      for (let row = 0; row < MFCC_ROWS; row++) {
        const range = mfccMax[row] - mfccMin[row];
        // Normalize to [-1, 1] centered on midpoint
        let norm = 0;
        if (range > 1e-6) {
          const mid2 = (mfccMax[row] + mfccMin[row]) / 2;
          norm = (s.mfcc[row] - mid2) / (range / 2);
          norm = Math.max(-1, Math.min(1, norm));
        }

        // Diverging colormap: blue (negative) → dark → orange (positive)
        let mr, mg, mb;
        if (norm < 0) {
          const t = Math.min(1, -norm);
          mr = Math.round(15 * (1 - t));
          mg = Math.round(40 * t + 15 * (1 - t));
          mb = Math.round(200 * t + 15 * (1 - t));
        } else {
          const t = Math.min(1, norm);
          mr = Math.round(220 * t + 15 * (1 - t));
          mg = Math.round(110 * t + 15 * (1 - t));
          mb = Math.round(15 * (1 - t));
        }

        ctx.fillStyle = `rgb(${mr},${mg},${mb})`;
        // row 0 (MFCC[0]) at bottom, row 12 (MFCC[12]) at top
        const yTop = MFCC_Y + Math.round((MFCC_ROWS - 1 - row) / MFCC_ROWS * MFCC_H);
        const yBot = MFCC_Y + Math.round((MFCC_ROWS - row) / MFCC_ROWS * MFCC_H);
        ctx.fillRect(rightX, yTop, scrollSpeed, yBot - yTop);
      }

      // ── BTrack beat detection ──
      btFrameCount++;
      const odfVal = s.spectralFlux;

      // Store ODF value
      btOdf[btIdx] = odfVal;

      // Compute cumulative score: current ODF + best weighted past score from ~1 period ago
      // Look backward in the score buffer around [period/2, 2*period] for max weighted score
      const lookStart = Math.round(btPeriod * 0.5);
      const lookEnd = Math.round(btPeriod * 2);
      let maxWeighted = 0;
      for (let i = lookStart; i <= lookEnd; i++) {
        const pastIdx = (btIdx - i + BT_BUF_LEN) % BT_BUF_LEN;
        const dist = Math.abs(i - Math.round(btPeriod));
        const w = btGaussWeight(dist, btPeriod);
        const val = btCumScore[pastIdx] * w;
        if (val > maxWeighted) maxWeighted = val;
      }
      btCumScore[btIdx] = odfVal + maxWeighted;

      btIdx = (btIdx + 1) % BT_BUF_LEN;

      // Beat counter: counts down each frame
      btCounter--;
      if (btCounter <= 0) {
        // Time to check for a beat. Find the max cumulative score in the recent window.
        const searchBack = Math.round(btPeriod);
        let bestScore = 0, bestOffset = 0;
        for (let i = 0; i < searchBack; i++) {
          const idx = (btIdx - 1 - i + BT_BUF_LEN) % BT_BUF_LEN;
          if (btCumScore[idx] > bestScore) {
            bestScore = btCumScore[idx];
            bestOffset = i;
          }
        }

        // Track whether this beat had real energy at the predicted time
        const beatHadEnergy = bestScore > 0.01 && btOdfEnergy > 0.01;
        if (beatHadEnergy && btPeriod > 0) {
          btConfirmedBeats++;
          btSilenceTimer = 0;
          // Require 6+ consecutive confirmed beats before showing (~3-4 seconds of steady beat)
          if (btConfirmedBeats >= 6) btShowBeats = true;
          if (btShowBeats) {
            beatFlash = 5;
            btLastBeatTime = time;
            btBeatCount++;
            if (btBeatCount % 10 === 0) {
              btShowBpm = Math.round(3600 / btPeriod);
            }
          }
        } else {
          btConfirmedBeats = Math.max(0, btConfirmedBeats - 1);
        }

        // Reset counter: next beat expected in ~period frames
        // Phase correct: if the peak was recent (small offset), we're on time
        // If peak was further back, nudge the counter shorter
        btCounter = Math.round(btPeriod) - Math.round(bestOffset * 0.2);
        btCounter = Math.max(Math.round(btPeriod * 0.7), btCounter);
      }

      // Track ODF energy for gating (smooth average of spectral flux variance)
      btOdfEnergy = btOdfEnergy * 0.99 + odfVal * odfVal * 0.01;

      // Re-estimate tempo every ~1 second (always runs)
      btTempoCounter++;
      if (btTempoCounter >= 60) {
        btTempoCounter = 0;
        const newPeriod = btEstimateTempo();
        if (newPeriod >= BT_MIN_LAG && newPeriod <= BT_MAX_LAG) {
          if (btPeriod === 0) {
            btPeriod = newPeriod;
            btCounter = newPeriod;
          } else {
            btPeriod += 0.12 * (newPeriod - btPeriod);
          }
        }
      }

      // Hide beats after 10 seconds of no confirmed beats
      btSilenceTimer++;
      if (btShowBeats && btSilenceTimer > 600) { // ~10 seconds at 60fps
        btShowBeats = false;
        btConfirmedBeats = 0;
        btBeatCount = 0;
        btShowBpm = 0;
        btPeriod = 0;
        btCounter = 999;
      }

      // Draw blue vertical beat line — only when btShowBeats is true
      if (beatFlash > 0 && btShowBeats) {
        beatFlash--;
        ctx.fillStyle = `rgba(60,140,255,${(beatFlash / 5) * 0.3})`;
        ctx.fillRect(rightX, 0, scrollSpeed, CANVAS_H);
        if (beatFlash === 4 && btShowBpm > 0) {
          const fontSize = Math.round(CANVAS_H * 0.018);
          ctx.font = `bold ${fontSize}px sans-serif`;
          ctx.fillStyle = 'rgba(255,255,255,0.9)';
          ctx.fillText(`${btShowBpm}`, rightX - fontSize * 2, fontSize + 4);
          btShowBpm = 0;
        }
      } else if (!btShowBeats) {
        beatFlash = 0;
      }

      // Broadband transient — count how many cochleagram rows are "bright" this frame
      // If way more than usual, it's a visible vertical blob → draw dashed line
      let brightBins = 0;
      for (let r = 0; r < NUM_FREQ_ROWS; r++) {
        if (curGamma[r] > 0.5) brightBins++;
      }
      brightBinAvg = brightBinAvg * 0.95 + brightBins * 0.05;
      if (transientCooldown > 0) transientCooldown--;
      if (brightBins > brightBinAvg * 3 && brightBins > NUM_FREQ_ROWS * 0.3 && transientCooldown === 0) {
        transientCooldown = 15; // ~250ms cooldown at 60fps
        const dashLen = Math.round(CANVAS_H * 0.008);
        const gapLen = Math.round(CANVAS_H * 0.006);
        ctx.fillStyle = 'rgba(255,255,255,0.9)';
        for (let dy = 0; dy < CANVAS_H; dy += dashLen + gapLen) {
          ctx.fillRect(rightX, dy, 1, Math.min(dashLen, CANVAS_H - dy));
        }
      }

      // ── Voice arrows on overlay (reuse `voices` + `VOICE_COLORS` from above) ──
      oCtx.clearRect(0, 0, CANVAS_W, CANVAS_H);
      const fontSize = Math.round(CANVAS_H * 0.01);
      const textZoneW = Math.round(fontSize * 4); // space for "1.2k" etc
      const arrowZoneW = Math.round(30 * DPR);
      const totalW = textZoneW + arrowZoneW;
      // Arrow zone background is solid black on main canvas (SCROLL_W to CANVAS_W)
      oCtx.font = `${fontSize}px sans-serif`;
      oCtx.textAlign = 'right';
      oCtx.textBaseline = 'middle';
      const arrowRight = CANVAS_W - textZoneW; // arrows go up to here
      for (let i = 0; i < voices.length; i++) {
        const v = voices[i];
        const cy = freqToCanvasY(v.freq);
        const sz = Math.max(8, Math.round(10 * DPR + v.strength * 3000));
        const alpha = Math.min(0.9, v.strength * 500);
        if (alpha > 0.05) {
          const c = VOICE_COLORS[i];
          const tipX = arrowRight - sz * 1.5;
          const tailX = arrowRight;
          const halfH = sz * 0.6;
          // Black border arrow
          oCtx.beginPath();
          oCtx.moveTo(tipX - 3, cy);
          oCtx.lineTo(tailX, cy - halfH - 3);
          oCtx.lineTo(tailX, cy + halfH + 3);
          oCtx.closePath();
          oCtx.fillStyle = `rgba(0,0,0,${alpha})`;
          oCtx.fill();
          // White border arrow
          oCtx.beginPath();
          oCtx.moveTo(tipX - 1, cy);
          oCtx.lineTo(tailX, cy - halfH - 1);
          oCtx.lineTo(tailX, cy + halfH + 1);
          oCtx.closePath();
          oCtx.fillStyle = `rgba(255,255,255,${alpha})`;
          oCtx.fill();
          // Colored fill arrow
          oCtx.beginPath();
          oCtx.moveTo(tipX, cy);
          oCtx.lineTo(tailX, cy - halfH);
          oCtx.lineTo(tailX, cy + halfH);
          oCtx.closePath();
          oCtx.fillStyle = `rgba(${c[0]},${c[1]},${c[2]},${alpha})`;
          oCtx.fill();
          // Frequency label to the right of arrow
          const freqText = v.freq >= 1000
            ? `${(v.freq / 1000).toFixed(1)}k`
            : `${Math.round(v.freq)}`;
          oCtx.fillStyle = `rgba(255,255,255,${alpha * 0.7})`;
          oCtx.fillText(freqText, CANVAS_W - 4, cy);
        }
      }

      // ── Circle of Fifths key overlay (bottom-left, above timbre map) ──
      {
        const pad = Math.round(8 * DPR);
        const cofSize = Math.round(Math.min(CANVAS_H * 0.12, CANVAS_W * 0.12));
        const cofX = pad;
        const cofY = CANVAS_H - TIMBRE_SZ - cofSize - pad * 3;
        const cofCx = cofX + cofSize / 2;
        const cofCy = cofY + cofSize / 2;
        const outerR = cofSize / 2;

        // Circle of fifths order (starting from top = C)
        const COF_MAJOR = ['C', 'G', 'D', 'A', 'E', 'B', 'F#', 'C#', 'G#', 'D#', 'A#', 'F'];
        const COF_MINOR = ['Am', 'Em', 'Bm', 'F#m', 'C#m', 'G#m', 'D#m', 'A#m', 'Fm', 'Cm', 'Gm', 'Dm'];

        // Parse detected key into CoF index
        let detKeyIdx = -1;
        let detKeyIsMajor = true;
        if (displayKey) {
          // displayKey is like "C maj", "A min"
          const parts = displayKey.split(' ');
          const root = parts[0];
          const mode = parts[1];
          if (mode === 'maj') {
            detKeyIdx = COF_MAJOR.indexOf(root);
            detKeyIsMajor = true;
          } else if (mode === 'min') {
            detKeyIdx = COF_MINOR.indexOf(root + 'm');
            detKeyIsMajor = false;
          }
        }

        // Semi-transparent background circle
        oCtx.beginPath();
        oCtx.arc(cofCx, cofCy, outerR, 0, Math.PI * 2);
        oCtx.fillStyle = 'rgba(0,0,0,0.65)';
        oCtx.fill();

        // Radius ratios for concentric rings
        const majorR = outerR * 0.85;
        const minorR = outerR * 0.52;
        const innerR = outerR * 0.35;

        // Dividing circle between major and minor rings
        oCtx.beginPath();
        oCtx.arc(cofCx, cofCy, outerR * 0.68, 0, Math.PI * 2);
        oCtx.strokeStyle = 'rgba(60,60,60,0.5)';
        oCtx.lineWidth = 1;
        oCtx.stroke();

        // Inner circle
        oCtx.beginPath();
        oCtx.arc(cofCx, cofCy, innerR, 0, Math.PI * 2);
        oCtx.strokeStyle = 'rgba(60,60,60,0.4)';
        oCtx.stroke();

        // Segment dividers (12 segments, 30° each)
        for (let i = 0; i < 12; i++) {
          const angle = (i * 30 - 90 - 15) * Math.PI / 180;
          oCtx.beginPath();
          oCtx.moveTo(cofCx + innerR * Math.cos(angle), cofCy + innerR * Math.sin(angle));
          oCtx.lineTo(cofCx + outerR * Math.cos(angle), cofCy + outerR * Math.sin(angle));
          oCtx.strokeStyle = 'rgba(50,50,50,0.4)';
          oCtx.lineWidth = 1;
          oCtx.stroke();
        }

        // Highlight detected key segment
        if (detKeyIdx >= 0 && s.signalPresent) {
          const startAngle = (detKeyIdx * 30 - 90 - 15) * Math.PI / 180;
          const endAngle = (detKeyIdx * 30 - 90 + 15) * Math.PI / 180;
          const hlR = detKeyIsMajor ? outerR : outerR * 0.68;
          const hlInner = detKeyIsMajor ? outerR * 0.68 : innerR;

          oCtx.beginPath();
          oCtx.arc(cofCx, cofCy, hlR, startAngle, endAngle);
          oCtx.arc(cofCx, cofCy, hlInner, endAngle, startAngle, true);
          oCtx.closePath();
          oCtx.fillStyle = 'rgba(80,180,255,0.45)';
          oCtx.fill();
        }

        // Key labels
        const majFontSz = Math.max(6, Math.round(cofSize * 0.08));
        const minFontSz = Math.max(5, Math.round(cofSize * 0.065));

        for (let i = 0; i < 12; i++) {
          const angle = (i * 30 - 90) * Math.PI / 180;

          // Major key label (outer ring)
          const mx = cofCx + majorR * Math.cos(angle);
          const my = cofCy + majorR * Math.sin(angle);
          oCtx.font = `${detKeyIdx === i && detKeyIsMajor ? 'bold ' : ''}${majFontSz}px sans-serif`;
          oCtx.textAlign = 'center';
          oCtx.textBaseline = 'middle';
          oCtx.fillStyle = detKeyIdx === i && detKeyIsMajor
            ? 'rgba(140,220,255,0.95)'
            : 'rgba(180,180,180,0.6)';
          oCtx.fillText(COF_MAJOR[i], mx, my);

          // Minor key label (inner ring)
          const nx = cofCx + minorR * Math.cos(angle);
          const ny = cofCy + minorR * Math.sin(angle);
          oCtx.font = `${detKeyIdx === i && !detKeyIsMajor ? 'bold ' : ''}${minFontSz}px sans-serif`;
          oCtx.fillStyle = detKeyIdx === i && !detKeyIsMajor
            ? 'rgba(140,220,255,0.95)'
            : 'rgba(140,140,140,0.5)';
          oCtx.fillText(COF_MINOR[i], nx, ny);
        }

        // Center: show detected chord
        if (displayChord && s.signalPresent) {
          const chordFontSz = Math.max(7, Math.round(cofSize * 0.12));
          oCtx.font = `bold ${chordFontSz}px sans-serif`;
          oCtx.textAlign = 'center';
          oCtx.textBaseline = 'middle';
          oCtx.fillStyle = 'rgba(255,255,200,0.9)';
          oCtx.fillText(displayChord, cofCx, cofCy);
        }

        // Outer ring border
        oCtx.beginPath();
        oCtx.arc(cofCx, cofCy, outerR, 0, Math.PI * 2);
        oCtx.strokeStyle = 'rgba(100,100,100,0.5)';
        oCtx.lineWidth = 1;
        oCtx.stroke();
      }

      // ── Timbre space overlay (bottom-left corner on overlay canvas) ──
      // X = spectral centroid (brightness), Y = MFCC[1] (spectral tilt)
      // Dot color = tristimulus (T1=R, T2=G, T3=B)
      {
        const pad = Math.round(8 * DPR);
        const boxX = pad;
        const boxY = CANVAS_H - TIMBRE_SZ - pad;
        const boxW = TIMBRE_SZ;
        const boxH = TIMBRE_SZ;

        // Semi-transparent background
        oCtx.fillStyle = 'rgba(0,0,0,0.6)';
        oCtx.fillRect(boxX, boxY, boxW, boxH);
        oCtx.strokeStyle = 'rgba(100,100,100,0.5)';
        oCtx.lineWidth = 1;
        oCtx.strokeRect(boxX, boxY, boxW, boxH);

        // Crosshair at center
        const cx = boxX + boxW / 2;
        const cy2 = boxY + boxH / 2;
        oCtx.strokeStyle = 'rgba(60,60,60,0.6)';
        oCtx.beginPath();
        oCtx.moveTo(boxX, cy2);
        oCtx.lineTo(boxX + boxW, cy2);
        oCtx.moveTo(cx, boxY);
        oCtx.lineTo(cx, boxY + boxH);
        oCtx.stroke();

        // Compute normalized position
        // X: spectral centroid — log scale, 200Hz=left, 8000Hz=right
        const centroidLog = s.spectralCentroidSmooth > 0
          ? Math.log(Math.max(200, Math.min(8000, s.spectralCentroidSmooth)) / 200) / Math.log(8000 / 200)
          : 0.5;
        // Y: MFCC[1] — normalized adaptively (larger = warmer = bottom)
        const mfcc1range = mfccMax[1] - mfccMin[1];
        const mfcc1norm = mfcc1range > 1e-6
          ? (s.mfcc[1] - mfccMin[1]) / mfcc1range
          : 0.5;

        const dotX = boxX + centroidLog * boxW;
        const dotY = boxY + (1 - mfcc1norm) * boxH; // invert so "warm" is at bottom

        // Update trail
        if (s.signalPresent && s.rmsSmooth > 0.003) {
          timbreTrailX[trailIdx] = dotX;
          timbreTrailY[trailIdx] = dotY;
          timbreTrailR[trailIdx] = Math.round(s.tristimulus[0] * 255);
          timbreTrailG[trailIdx] = Math.round(s.tristimulus[1] * 255);
          timbreTrailB[trailIdx] = Math.round(s.tristimulus[2] * 255);
          trailIdx = (trailIdx + 1) % TRAIL_LEN;
          if (trailCount < TRAIL_LEN) trailCount++;
        }

        // Draw trail (fading dots)
        for (let i = 0; i < trailCount; i++) {
          const idx = (trailIdx - 1 - i + TRAIL_LEN) % TRAIL_LEN;
          const age = i / TRAIL_LEN;
          const alpha = (1 - age) * 0.4;
          if (alpha < 0.02) continue;

          // Color from stored tristimulus at time of recording
          oCtx.fillStyle = `rgba(${timbreTrailR[idx]},${timbreTrailG[idx]},${timbreTrailB[idx]},${alpha})`;

          const sz = Math.max(2, Math.round(3 * DPR * (1 - age * 0.5)));
          oCtx.fillRect(timbreTrailX[idx] - sz / 2, timbreTrailY[idx] - sz / 2, sz, sz);
        }

        // Current dot (bright, larger)
        if (s.signalPresent && s.rmsSmooth > 0.003) {
          const tR = Math.min(255, Math.round(s.tristimulus[0] * 300 + 60));
          const tG = Math.min(255, Math.round(s.tristimulus[1] * 300 + 60));
          const tB = Math.min(255, Math.round(s.tristimulus[2] * 300 + 60));
          const dotSz = Math.round(5 * DPR);
          // White border
          oCtx.fillStyle = 'rgba(255,255,255,0.9)';
          oCtx.fillRect(dotX - dotSz / 2 - 1, dotY - dotSz / 2 - 1, dotSz + 2, dotSz + 2);
          // Colored fill
          oCtx.fillStyle = `rgb(${tR},${tG},${tB})`;
          oCtx.fillRect(dotX - dotSz / 2, dotY - dotSz / 2, dotSz, dotSz);
        }

        // Axis labels
        const lblSz = Math.round(CANVAS_H * 0.008);
        oCtx.font = `${lblSz}px sans-serif`;
        oCtx.textAlign = 'left';
        oCtx.textBaseline = 'bottom';
        oCtx.fillStyle = 'rgba(180,180,180,0.6)';
        oCtx.fillText('bright →', boxX + 2, boxY + boxH - 2);
        oCtx.save();
        oCtx.translate(boxX + lblSz, boxY + boxH - lblSz);
        oCtx.rotate(-Math.PI / 2);
        oCtx.fillText('warm →', 0, 0);
        oCtx.restore();

        // Inharmonicity indicator — small bar at the bottom of the box
        if (s.inharmonicity > 0.001) {
          const barW = Math.round(Math.min(1, s.inharmonicity * 10) * boxW);
          oCtx.fillStyle = `rgba(255,160,40,${Math.min(0.8, s.inharmonicity * 5)})`;
          oCtx.fillRect(boxX, boxY + boxH - 3, barW, 3);
        }
      }
    },
  };
}
