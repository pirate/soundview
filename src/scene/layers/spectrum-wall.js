// Fullscreen scrolling visualization — reorganized by conceptual hierarchy:
// Top (highest-level): speech → timbre-over-time → notes/chords → onset/flux → harmonics → spectrogram → volume
// Overlays: Circle of Fifths + timbre space (bottom-left), voice arrows (right)
// Beat/BPM rendered as columns spanning all strips, not its own strip.
// Pure 2D canvas rendering — no WebGL/Three.js.

import { SPECTRUM_BINS, NUM_BANDS, store as featureStore } from '../../store/feature-store.js';

// ── Multi-voice pitch detection (subharmonic summation) ──
const MAX_VOICES = 4;
let _dmpScores = null;
let _dmpBinHz, _dmpMinBin, _dmpMaxBin;

function detectMultiPitch(spectrumDb) {
  if (!_dmpScores) {
    _dmpBinHz = SAMPLE_RATE / FFT_SIZE;
    _dmpMinBin = Math.floor(60 / _dmpBinHz);
    _dmpMaxBin = Math.min(Math.floor(2000 / _dmpBinHz), SPECTRUM_BINS - 1);
    _dmpScores = new Float32Array(_dmpMaxBin + 1);
  }
  const binHz = _dmpBinHz, minBin = _dmpMinBin, maxBin = _dmpMaxBin;
  const scores = _dmpScores;
  scores.fill(0);
  for (let b = minBin; b <= maxBin; b++) {
    let sum = 0, count = 0;
    for (let h = 1; h <= 8; h++) {
      const hBin = b * h;
      if (hBin >= SPECTRUM_BINS) break;
      const weight = 1 / h;
      sum += Math.pow(10, spectrumDb[hBin] / 20) * weight;
      count += weight;
    }
    scores[b] = count > 0 ? sum / count : 0;
  }
  const peaks = [];
  for (let b = minBin + 1; b < maxBin; b++) {
    if (scores[b] > scores[b - 1] && scores[b] > scores[b + 1] && scores[b] > 0.0001)
      peaks.push({ bin: b, score: scores[b], freq: b * binHz });
  }
  peaks.sort((a, b) => b.score - a.score);
  const voices = [];
  for (const peak of peaks) {
    if (voices.length >= MAX_VOICES) break;
    let isHarmonic = false;
    for (const v of voices) {
      const r1 = peak.freq / v.freq, n1 = Math.round(r1);
      if (n1 >= 2 && Math.abs(r1 - n1) < 0.08) { isHarmonic = true; break; }
      const r2 = v.freq / peak.freq, n2 = Math.round(r2);
      if (n2 >= 2 && Math.abs(r2 - n2) < 0.08) { isHarmonic = true; break; }
    }
    if (!isHarmonic) voices.push({ freq: peak.freq, strength: peak.score });
  }
  return voices;
}

// ── Canvas & layout constants ──
const DPR = Math.min(window.devicePixelRatio || 1, 2);
const CANVAS_W = Math.round(window.innerWidth * DPR);
const CANVAS_H = Math.round(window.innerHeight * DPR);
const ARROW_W = Math.round(90 * DPR);
const SCROLL_W = CANVAS_W - ARROW_W;

// NEW LAYOUT (top to bottom): speech → timbre-time → notes/chords → onset/flux → harmonics → spectrogram → volume
const SPEECH_H = Math.round(CANVAS_H * 0.05);
const SPEECH_Y = 0;

const TIMBRE_TIME_H = Math.round(CANVAS_H * 0.07);
const TIMBRE_TIME_Y = SPEECH_Y + SPEECH_H;

const NOTE_H = Math.round(CANVAS_H * 0.10);
const NOTE_Y = TIMBRE_TIME_Y + TIMBRE_TIME_H;
const NOTE_ROWS = 12;

const ONSET_H = Math.round(CANVAS_H * 0.07);
const ONSET_Y = NOTE_Y + NOTE_H;

const HARM_H = Math.round(CANVAS_H * 0.14);
const HARM_Y = ONSET_Y + ONSET_H;
const HARM_ROWS = 32;
const HARM_MAX = 16;

const VOLUME_H = Math.round(CANVAS_H * 0.06);
const COCHLEA_H = CANVAS_H - SPEECH_H - TIMBRE_TIME_H - NOTE_H - ONSET_H - HARM_H - VOLUME_H;
const COCHLEA_Y = HARM_Y + HARM_H;
const VOLUME_Y = COCHLEA_Y + COCHLEA_H;

const NUM_FREQ_ROWS = COCHLEA_H;

const FREQ_LO = 50;
const FREQ_HI = 16000;
const SAMPLE_RATE = 44100;
const FFT_SIZE = 8192;
const BIN_HZ = SAMPLE_RATE / FFT_SIZE;

// Piecewise frequency mapping
const ZONE_LO_ROWS = Math.round(NUM_FREQ_ROWS * 0.07);
const ZONE_HI_ROWS = Math.round(NUM_FREQ_ROWS * 0.07);
const ZONE_MID_ROWS = NUM_FREQ_ROWS - ZONE_LO_ROWS - ZONE_HI_ROWS;
const ZONE_LO_FREQ = 200;
const ZONE_HI_FREQ = 8000;

function rowToFreq(r) {
  if (r < ZONE_LO_ROWS) return FREQ_LO * Math.pow(ZONE_LO_FREQ / FREQ_LO, r / (ZONE_LO_ROWS - 1));
  if (r < ZONE_LO_ROWS + ZONE_MID_ROWS) {
    const mr = r - ZONE_LO_ROWS;
    return ZONE_LO_FREQ * Math.pow(ZONE_HI_FREQ / ZONE_LO_FREQ, mr / (ZONE_MID_ROWS - 1));
  }
  const hr = r - ZONE_LO_ROWS - ZONE_MID_ROWS;
  return ZONE_HI_FREQ * Math.pow(FREQ_HI / ZONE_HI_FREQ, hr / (ZONE_HI_ROWS - 1));
}

function freqToRow(freq) {
  if (freq <= FREQ_LO) return 0;
  if (freq < ZONE_LO_FREQ) return (ZONE_LO_ROWS - 1) * Math.log(freq / FREQ_LO) / Math.log(ZONE_LO_FREQ / FREQ_LO);
  if (freq < ZONE_HI_FREQ) return ZONE_LO_ROWS + (ZONE_MID_ROWS - 1) * Math.log(freq / ZONE_LO_FREQ) / Math.log(ZONE_HI_FREQ / ZONE_LO_FREQ);
  if (freq < FREQ_HI) return ZONE_LO_ROWS + ZONE_MID_ROWS + (ZONE_HI_ROWS - 1) * Math.log(freq / ZONE_HI_FREQ) / Math.log(FREQ_HI / ZONE_HI_FREQ);
  return NUM_FREQ_ROWS - 1;
}

const rowBins = new Int32Array(NUM_FREQ_ROWS);
for (let r = 0; r < NUM_FREQ_ROWS; r++) rowBins[r] = Math.round(rowToFreq(r) / BIN_HZ);

function freqToCanvasY(freqHz) {
  return COCHLEA_Y + COCHLEA_H - (freqToRow(freqHz) + 1);
}

// ── Perceptual compression ──
let sensitivity = -12;
const DB_FLOOR = -100, DB_RANGE = 100, GAMMA = 0.35;
let scrollSpeed = 8;
let featGain = 25;

export function setSensitivity(db) { sensitivity = db; featureStore._sensitivity = db; }
export function setScrollSpeed(px) { scrollSpeed = Math.max(1, Math.min(20, px)); }
export function setFeatGain(g) { featGain = Math.max(1, Math.min(50, g)); }

// ── Colormap LUT ──
const CSTOPS = [
  [0.00,0,0,0],[0.12,0,0,150],[0.24,0,120,220],[0.36,0,210,180],
  [0.48,200,220,0],[0.60,240,120,0],[0.72,220,0,60],[0.84,180,0,220],
  [0.92,0,220,80],[1.00,255,255,255],
];
const cmapLUT = new Uint8Array(256 * 3);
for (let i = 0; i < 256; i++) {
  const t = i / 255;
  let lo = CSTOPS[0], hi = CSTOPS[CSTOPS.length - 1];
  for (let s = 0; s < CSTOPS.length - 1; s++) {
    if (t >= CSTOPS[s][0] && t <= CSTOPS[s + 1][0]) { lo = CSTOPS[s]; hi = CSTOPS[s + 1]; break; }
  }
  const span = hi[0] - lo[0], f = span > 0 ? (t - lo[0]) / span : 0;
  cmapLUT[i * 3] = Math.round(lo[1] + (hi[1] - lo[1]) * f);
  cmapLUT[i * 3 + 1] = Math.round(lo[2] + (hi[2] - lo[2]) * f);
  cmapLUT[i * 3 + 2] = Math.round(lo[3] + (hi[3] - lo[3]) * f);
}

// ── Pitch-class colors ──
const PITCH_CLASS_COLORS = [
  [255,60,60],[255,130,40],[240,200,40],[160,230,50],[60,210,70],[40,200,150],
  [40,180,220],[60,120,240],[110,70,230],[170,60,220],[220,60,180],[240,60,120],
];
const NOTE_LABELS = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];

// ── Timbre space overlay constants ──
const TIMBRE_SZ = Math.round(Math.min(CANVAS_H * 0.09, CANVAS_W * 0.10));
const TRAIL_LEN = 120;


// ── Label builder ──
function buildLabels() {
  const container = document.createElement('div');
  container.id = 'spectrogram-labels';
  document.body.appendChild(container);

  function addLabel(text, topPct, cls) {
    const el = document.createElement('span');
    el.className = `spec-label ${cls || 'feat-label'}`;
    el.textContent = text;
    el.style.top = `${topPct}%`;
    container.appendChild(el);
  }

  // Strip labels
  addLabel('speech', ((SPEECH_Y + SPEECH_H / 2) / CANVAS_H) * 100, 'feat-label');
  addLabel('timbre', ((TIMBRE_TIME_Y + TIMBRE_TIME_H / 2) / CANVAS_H) * 100, 'feat-label');
  addLabel('notes', ((NOTE_Y + NOTE_H / 2) / CANVAS_H) * 100, 'feat-label');
  addLabel('onset/flux', ((ONSET_Y + ONSET_H / 2) / CANVAS_H) * 100, 'feat-label');
  addLabel('harmonics', ((HARM_Y + HARM_H / 2) / CANVAS_H) * 100, 'feat-label');
  addLabel('volume', ((VOLUME_Y + VOLUME_H / 2) / CANVAS_H) * 100, 'feat-label');

  // Frequency labels on cochleagram
  const freqs = [[50,'50'],[100,'100'],[200,'200'],[500,'500'],[1000,'1k'],[2000,'2k'],[4000,'4k'],[8000,'8k'],[16000,'16k']];
  for (const [hz, text] of freqs) {
    const y = freqToCanvasY(hz);
    addLabel(text, (y / CANVAS_H) * 100, 'freq-label');
  }
}

export function createSpectrumWall() {
  const canvas = document.createElement('canvas');
  canvas.width = CANVAS_W; canvas.height = CANVAS_H;
  canvas.id = 'spectrogram';
  document.body.appendChild(canvas);
  buildLabels();

  const ctx = canvas.getContext('2d', { willReadFrequently: false });
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

  // Overlay canvas (doesn't scroll)
  const overlay = document.createElement('canvas');
  overlay.width = CANVAS_W; overlay.height = CANVAS_H;
  overlay.id = 'spectrogram-overlay';
  overlay.style.cssText = 'position:fixed;top:0;left:0;width:100vw;height:100vh;z-index:1;pointer-events:none';
  document.body.appendChild(overlay);
  const oCtx = overlay.getContext('2d');

  // ── Beat rendering state (beat detection now runs in features pipeline via beat.js) ──
  let btFrameCount = 0;
  let beatFlash = 0;

  // ── Pre-allocated buffers ──
  const colImg = ctx.createImageData(1, COCHLEA_H);
  const prevHarmAmps = new Float32Array(HARM_ROWS);
  const prevGamma = new Float32Array(NUM_FREQ_ROWS);
  const curGamma = new Float32Array(NUM_FREQ_ROWS);
  const chordNotes = new Uint8Array(12);
  let noiseGateSmooth = 0, prevCentroid = 0, centroidStable = 0;
  let prevDomY = -1, prevDomRow = -1, domStableFrames = 0;
  let transientCooldown = 0, brightBinAvg = 0;
  let prevFluxY = -1, prevDerivY = -1;

  // ── MFCC adaptive normalization (for timbre space) ──
  const mfccMin = new Float32Array(13).fill(0);
  const mfccMax = new Float32Array(13).fill(1);
  let mfccInitFrames = 0;

  // ── Timbre space trail ──
  const timbreTrailX = new Float32Array(TRAIL_LEN);
  const timbreTrailY = new Float32Array(TRAIL_LEN);
  const timbreTrailR = new Uint8Array(TRAIL_LEN);
  const timbreTrailG = new Uint8Array(TRAIL_LEN);
  const timbreTrailB = new Uint8Array(TRAIL_LEN);
  let trailIdx = 0, trailCount = 0;

  // ── Key/chord display smoothing ──
  let displayKey = '', displayChord = '', pendingChord = '';
  let keyHoldFrames = 0, chordHoldFrames = 0;

  // ── Speech display state ──
  let lastSpeechText = '';
  let speechDisplayWords = []; // { word, x } scrolling word positions

  const VOICE_COLORS = [[255,120,0],[0,170,255],[70,255,70],[255,70,255]];


  return {
    mesh: null,
    update(storeRef, dt, time) {
      ctx.drawImage(canvas, -scrollSpeed, 0);
      ctx.clearRect(SCROLL_W - scrollSpeed, 0, scrollSpeed, CANVAS_H);

      const spectrum = storeRef.spectrumDb;
      const s = storeRef;
      const rightX = SCROLL_W - scrollSpeed;

      // ════════════════════════════════════════
      // STRIP 1: SPEECH (top of screen)
      // ════════════════════════════════════════
      // Dark background for speech strip
      ctx.fillStyle = 'rgb(8,8,16)';
      ctx.fillRect(rightX, SPEECH_Y, scrollSpeed, SPEECH_H);

      // Check for new speech text
      if (s.speechText && s.speechText !== lastSpeechText) {
        lastSpeechText = s.speechText;
        // Add new words at the right edge
        const words = s.speechText.split(/\s+/);
        const fontSize = Math.round(SPEECH_H * 0.55);
        for (let i = 0; i < words.length; i++) {
          speechDisplayWords.push({
            word: words[i],
            x: SCROLL_W + i * fontSize * 3,
            opacity: 1,
          });
        }
      }

      // Render speech words on overlay (they scroll with the spectrogram)
      // We'll draw them later in the overlay section

      // Loading indicator
      if (s.speechLoading) {
        if (btFrameCount % 120 < 60) {
          ctx.fillStyle = 'rgba(100,100,120,0.5)';
          const dotW = Math.round(SPEECH_H * 0.15);
          for (let i = 0; i < 3; i++) {
            ctx.fillRect(rightX - dotW * 2 * (i + 1), SPEECH_Y + SPEECH_H / 2 - dotW / 2, dotW, dotW);
          }
        }
      }

      // ════════════════════════════════════════
      // STRIP 2: TIMBRE OVER TIME
      // ════════════════════════════════════════
      // Visualize spectral centroid (X brightness), MFCC[1] (Y warmth), tristimulus (color)
      // as a scrolling strip — like the timbre space preview but unrolled over time
      {
        // Background brightness = overall energy
        const eB = Math.min(1, s.rmsSmooth * featGain * 0.5);

        // Color from tristimulus (T1=red=fundamental, T2=green=mid, T3=blue=upper)
        const tR = Math.round(s.tristimulus[0] * 255 * eB);
        const tG = Math.round(s.tristimulus[1] * 255 * eB);
        const tB = Math.round(s.tristimulus[2] * 255 * eB);
        ctx.fillStyle = `rgb(${tR},${tG},${tB})`;
        ctx.fillRect(rightX, TIMBRE_TIME_Y, scrollSpeed, TIMBRE_TIME_H);

        // Spectral centroid as a white line within the strip
        if (s.spectralCentroidSmooth > 0 && s.signalPresent) {
          const centroidNorm = Math.log(Math.max(200, Math.min(8000, s.spectralCentroidSmooth)) / 200) / Math.log(8000 / 200);
          const cy = TIMBRE_TIME_Y + (1 - centroidNorm) * TIMBRE_TIME_H;
          ctx.fillStyle = 'rgba(255,255,255,0.7)';
          ctx.fillRect(rightX, Math.round(cy) - 1, scrollSpeed, 2);
        }

        // MFCC[1] (spectral tilt) as a horizontal position indicator
        const m1range = mfccMax[1] - mfccMin[1];
        if (m1range > 1e-6 && s.signalPresent) {
          const m1norm = (s.mfcc[1] - mfccMin[1]) / m1range;
          const my = TIMBRE_TIME_Y + (1 - m1norm) * TIMBRE_TIME_H;
          ctx.fillStyle = 'rgba(255,200,100,0.5)';
          ctx.fillRect(rightX, Math.round(my), scrollSpeed, 2);
        }

        // Inharmonicity indicator at top edge
        if (s.inharmonicity > 0.01) {
          const barH = Math.round(Math.min(1, s.inharmonicity * 8) * TIMBRE_TIME_H * 0.15);
          ctx.fillStyle = `rgba(255,100,0,${Math.min(0.7, s.inharmonicity * 4)})`;
          ctx.fillRect(rightX, TIMBRE_TIME_Y, scrollSpeed, barH);
        }
      }

      // ════════════════════════════════════════
      // STRIP 3: NOTES + CHORDS (score strip)
      // ════════════════════════════════════════
      // Key + chord display smoothing
      if (!s.signalPresent) {
        displayKey = ''; displayChord = '';
        keyHoldFrames = 0; chordHoldFrames = 0;
      } else {
        if (s.detectedKeyConfidence > 0.3 && s.detectedKey) displayKey = s.detectedKey;
        if (s.detectedChord && s.detectedChordConfidence > 0.3) {
          if (s.detectedChord === displayChord) { chordHoldFrames = 0; }
          else if (s.detectedChord === pendingChord) {
            chordHoldFrames++;
            if (chordHoldFrames > 8) { displayChord = pendingChord; chordHoldFrames = 0; }
          } else { pendingChord = s.detectedChord; chordHoldFrames = 1; }
        }
        if (!s.detectedChord || s.detectedChordConfidence < 0.1) {
          chordHoldFrames++;
          if (chordHoldFrames > 30) { displayChord = ''; chordHoldFrames = 0; }
        }
      }

      // Parse chord notes
      chordNotes.fill(0);
      if (s.signalPresent && s.detectedChordConfidence > 0.4 && displayChord) {
        let rootIdx = -1, chordSuffix = '';
        for (let ni = 0; ni < 12; ni++) {
          if (displayChord.startsWith(NOTE_LABELS[ni])) {
            if (NOTE_LABELS[ni].length > 1 || rootIdx < 0) {
              rootIdx = ni; chordSuffix = displayChord.slice(NOTE_LABELS[ni].length);
            }
          }
        }
        if (rootIdx >= 0) {
          if (chordSuffix === 'm' || chordSuffix === 'm7') {
            chordNotes[rootIdx % 12] = 1; chordNotes[(rootIdx + 3) % 12] = 1; chordNotes[(rootIdx + 7) % 12] = 1;
            if (chordSuffix === 'm7') chordNotes[(rootIdx + 10) % 12] = 1;
          } else if (chordSuffix === 'dim') {
            chordNotes[rootIdx % 12] = 1; chordNotes[(rootIdx + 3) % 12] = 1; chordNotes[(rootIdx + 6) % 12] = 1;
          } else if (chordSuffix === '7') {
            chordNotes[rootIdx % 12] = 1; chordNotes[(rootIdx + 4) % 12] = 1;
            chordNotes[(rootIdx + 7) % 12] = 1; chordNotes[(rootIdx + 10) % 12] = 1;
          } else {
            chordNotes[rootIdx % 12] = 1; chordNotes[(rootIdx + 4) % 12] = 1; chordNotes[(rootIdx + 7) % 12] = 1;
          }
        }
      }

      // Draw 12 pitch-class rows (chroma piano roll)
      for (let row = 0; row < NOTE_ROWS; row++) {
        const energy = Math.max(0, s.chroma[row]);
        const isChordTone = chordNotes[row] === 1;
        const [cR, cG, cB] = PITCH_CLASS_COLORS[row];
        const yTop = NOTE_Y + Math.round((NOTE_ROWS - 1 - row) / NOTE_ROWS * NOTE_H);
        const yBot = NOTE_Y + Math.round((NOTE_ROWS - row) / NOTE_ROWS * NOTE_H);
        const noteOn = energy > 0.15 && s.signalPresent;

        if (noteOn && isChordTone) {
          const v = Math.min(1, energy * 1.5);
          ctx.fillStyle = `rgb(${Math.round(cR*v)},${Math.round(cG*v)},${Math.round(cB*v)})`;
        } else if (noteOn) {
          const v = Math.min(1, energy) * 0.25;
          ctx.fillStyle = `rgb(${Math.round(cR*v)},${Math.round(cG*v)},${Math.round(cB*v)})`;
        } else {
          ctx.fillStyle = 'rgb(4,4,8)';
        }
        ctx.fillRect(rightX, yTop, scrollSpeed, yBot - yTop);
        ctx.fillStyle = 'rgba(30,30,40,1)';
        ctx.fillRect(rightX, yBot - 1, scrollSpeed, 1);
      }

      // Chord text overlay on note strip
      if (displayChord && s.signalPresent && btFrameCount % 60 === 0) {
        const fontSize = Math.round(NOTE_H * 0.28);
        ctx.font = `bold ${fontSize}px sans-serif`;
        ctx.fillStyle = 'rgba(255,255,200,0.8)';
        ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
        ctx.fillText(displayChord, rightX - 4, NOTE_Y + NOTE_H / 2);
        ctx.textAlign = 'left';
      }

      // Also render Basic Pitch transcribed notes if available
      if (s.noteEvents && s.noteEvents.length > 0) {
        const now = performance.now();
        for (const note of s.noteEvents) {
          const age = (now - note.startTime) / 1000;
          if (age > 10) continue;
          const midi = note.pitchMidi;
          const pc = midi % 12;  // pitch class
          const [nR, nG, nB] = PITCH_CLASS_COLORS[pc];
          const yTop = NOTE_Y + Math.round((NOTE_ROWS - 1 - pc) / NOTE_ROWS * NOTE_H);
          const yBot = NOTE_Y + Math.round((NOTE_ROWS - pc) / NOTE_ROWS * NOTE_H);
          // Draw a brighter marker for transcribed notes
          const alpha = Math.min(0.9, note.amplitude * 1.2);
          ctx.fillStyle = `rgba(255,255,255,${alpha * 0.3})`;
          ctx.fillRect(rightX, yTop + 1, scrollSpeed, yBot - yTop - 2);
        }
      }


      // ════════════════════════════════════════
      // STRIP 4: ONSET / OFFSET / FLUX
      // ════════════════════════════════════════
      {
        const comboH = ONSET_H;
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
        ctx.fillRect(rightX, ONSET_Y, scrollSpeed, comboH);

        // Flux line (white)
        const fluxRaw = Math.min(1, s.spectralFlux * 0.3);
        const fluxYPos = ONSET_Y + comboH - 2 - Math.round(fluxRaw * (comboH - 4));
        if (prevFluxY >= 0) {
          const yMin = Math.min(prevFluxY, fluxYPos) - 2;
          const yMax = Math.max(prevFluxY, fluxYPos) + 4;
          ctx.fillStyle = `rgba(255,255,255,${Math.min(0.9, Math.max(fluxRaw, 0.15) * 3)})`;
          ctx.fillRect(rightX, yMin, scrollSpeed, yMax - yMin);
        }
        prevFluxY = fluxYPos;

        // Flux derivative (dark line)
        const fluxDeriv = s.spectralFlux - prevFlux;
        prevFlux = s.spectralFlux;
        const derivAbs = Math.min(1, Math.abs(fluxDeriv) * 0.8);
        const mid = ONSET_Y + Math.round(comboH / 2);
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

        // Onset markers — bright flash
        if (s.isOnset) {
          ctx.fillStyle = 'rgba(255,255,255,0.6)';
          ctx.fillRect(rightX, ONSET_Y, scrollSpeed, 3);
          ctx.fillRect(rightX, ONSET_Y + comboH - 3, scrollSpeed, 3);
        }
      }

      // ════════════════════════════════════════
      // STRIP 5: HARMONICS
      // ════════════════════════════════════════
      const voices = s.signalPresent ? detectMultiPitch(spectrum) : [];
      let f0 = s.pitchSmooth > 0 ? s.pitchSmooth : 0;
      if (f0 === 0 && voices.length > 0) f0 = voices[0].freq;
      const binHz = SAMPLE_RATE / FFT_SIZE;

      let dominantRow = -1, dominantAmp = 0;
      for (let row = 0; row < HARM_ROWS; row++) {
        const hFloat = row / HARM_ROWS * HARM_MAX;
        const h = Math.min(HARM_MAX - 1, Math.floor(hFloat));
        const hFrac = hFloat - h;
        const h2 = Math.min(HARM_MAX - 1, h + 1);

        let amp = s.harmonicAmplitudes[h] * (1 - hFrac) + s.harmonicAmplitudes[h2] * hFrac;
        if (amp < 1e-6 && f0 > 0) {
          const hFreq1 = f0 * (h + 1), hFreq2 = f0 * (h2 + 1);
          const bin1 = Math.round(hFreq1 / binHz), bin2 = Math.round(hFreq2 / binHz);
          if (bin1 > 0 && bin1 < SPECTRUM_BINS && bin2 > 0 && bin2 < SPECTRUM_BINS) {
            amp = Math.pow(10, spectrum[bin1] / 20) * (1 - hFrac) + Math.pow(10, spectrum[bin2] / 20) * hFrac;
          }
        }
        const v = amp > 1e-6 ? Math.max(0, Math.min(1, 1 + Math.log10(amp) / 5)) : 0;
        if (amp > dominantAmp && h > 0) { dominantAmp = amp; dominantRow = row; }

        // Spectral slope hue
        let slopeHue = 0.5;
        if (f0 > 0) {
          const hFreq = f0 * (hFloat + 1);
          const centerBin = Math.round(hFreq / binHz);
          if (centerBin > 3 && centerBin < SPECTRUM_BINS - 3) {
            const here = spectrum[centerBin];
            const below = (spectrum[centerBin - 3] + spectrum[centerBin - 2]) / 2;
            const above = (spectrum[centerBin + 2] + spectrum[centerBin + 3]) / 2;
            slopeHue = Math.max(0, Math.min(1, 0.5 + (here - (below + above) / 2) / 20));
          }
        }

        // Purity
        let purity = 0.5;
        if (f0 > 0) {
          const hFreq = f0 * (hFloat + 1);
          const centerBin = Math.round(hFreq / binHz);
          if (centerBin > 5 && centerBin < SPECTRUM_BINS - 5) {
            let noiseSum = 0, noiseCnt = 0;
            for (let nb = -5; nb <= 5; nb++) {
              if (Math.abs(nb) >= 2) { noiseSum += spectrum[centerBin + nb]; noiseCnt++; }
            }
            purity = Math.max(0, Math.min(1, (spectrum[centerBin] - (noiseCnt > 0 ? noiseSum / noiseCnt : spectrum[centerBin])) / 15));
          }
        }

        const delta = amp - prevHarmAmps[row];
        const attackBoost = Math.max(0, delta * 4), decayDim = Math.max(0, -delta * 2);
        prevHarmAmps[row] = amp;

        const hNum = Math.round(hFloat) + 1;
        let baseR, baseG, baseB;
        if (hNum === 1)       { baseR = 255; baseG = 255; baseB = 255; }
        else if (hNum === 2)  { baseR = 60;  baseG = 220; baseB = 240; }
        else if (hNum === 3)  { baseR = 255; baseG = 160; baseB = 40;  }
        else if (hNum === 5 || hNum === 7) { baseR = 255; baseG = 230; baseB = 50; }
        else if (hNum >= 8 && hNum <= 10) { baseR = 230; baseG = 80; baseB = 220; }
        else if (hNum % 2 === 0) { baseR = 80; baseG = 140; baseB = 230; }
        else { baseR = 200; baseG = 170; baseB = 80; }

        let r = Math.round(v * baseR), g = Math.round(v * baseG), b = Math.round(v * baseB);
        const sat = Math.max(0.8, purity);
        const grey = Math.round((r + g + b) / 3);
        r = Math.round(grey + (r - grey) * sat);
        g = Math.round(grey + (g - grey) * sat);
        b = Math.round(grey + (b - grey) * sat);
        const boost = Math.min(1, attackBoost);
        r = Math.max(0, Math.min(255, Math.round(r + boost * (255 - r) * 0.5 - decayDim * r * 0.3)));
        g = Math.max(0, Math.min(255, Math.round(g + boost * (255 - g) * 0.5 - decayDim * g * 0.3)));
        b = Math.max(0, Math.min(255, Math.round(b + boost * (255 - b) * 0.5 - decayDim * b * 0.3)));

        ctx.fillStyle = `rgb(${r},${g},${b})`;
        const yTop = HARM_Y + Math.round((HARM_ROWS - 1 - row) / HARM_ROWS * HARM_H);
        const yBot = HARM_Y + Math.round((HARM_ROWS - row) / HARM_ROWS * HARM_H);
        ctx.fillRect(rightX, yTop, scrollSpeed, yBot - yTop);
      }

      // Dominant harmonic line
      if (dominantRow >= 0 && dominantAmp > 1e-4) {
        if (Math.abs(dominantRow - prevDomRow) <= 1) domStableFrames++;
        else domStableFrames = 0;
        prevDomRow = dominantRow;
        if (domStableFrames >= 12) {
          const dTop = HARM_Y + Math.round((HARM_ROWS - 1 - dominantRow) / HARM_ROWS * HARM_H);
          const dBot = HARM_Y + Math.round((HARM_ROWS - dominantRow) / HARM_ROWS * HARM_H);
          const dMid = Math.round((dTop + dBot) / 2);
          if (prevDomY >= 0) {
            ctx.fillStyle = 'rgba(255,255,255,0.9)';
            ctx.fillRect(rightX, Math.min(prevDomY, dMid) - 2, scrollSpeed, Math.abs(dMid - prevDomY) + 5);
          }
          prevDomY = dMid;
        } else { prevDomY = -1; }
      } else { prevDomRow = -1; domStableFrames = 0; prevDomY = -1; }


      // ════════════════════════════════════════
      // STRIP 6: SPECTROGRAM (cochleagram)
      // ════════════════════════════════════════
      curGamma.fill(0);
      for (let r = 0; r < NUM_FREQ_ROWS; r++) {
        const bin = Math.min(SPECTRUM_BINS - 1, rowBins[r]);
        const raw = (spectrum[bin] + sensitivity - DB_FLOOR) / DB_RANGE;
        const gated = Math.max(0, raw - 0.08) / 0.92;
        curGamma[r] = Math.pow(Math.min(1, gated), GAMMA);
      }

      for (let px = 0; px < scrollSpeed; px++) {
        const t = scrollSpeed > 1 ? px / (scrollSpeed - 1) : 1;
        const data = colImg.data;
        for (let r = 0; r < NUM_FREQ_ROWS; r++) {
          const g = prevGamma[r] + (curGamma[r] - prevGamma[r]) * t;
          const cidx = Math.max(0, Math.min(255, Math.round(g * 255))) * 3;
          const pixIdx = (COCHLEA_H - r - 1) * 4;
          data[pixIdx] = cmapLUT[cidx];
          data[pixIdx + 1] = cmapLUT[cidx + 1];
          data[pixIdx + 2] = cmapLUT[cidx + 2];
          data[pixIdx + 3] = 255;
        }
        ctx.putImageData(colImg, SCROLL_W - scrollSpeed + px, COCHLEA_Y);
      }
      prevGamma.set(curGamma);

      // ── Cochleagram overlays (pitch, formants, centroid, etc.) ──
      if (s.signalPresent) {
        // Pitch fundamental — white line
        if (s.pitchSmooth > FREQ_LO && s.pitchConfidence > 0.15) {
          const py = freqToCanvasY(s.pitchSmooth);
          const thick = Math.max(2, Math.round(COCHLEA_H * 0.003));
          ctx.fillStyle = `rgba(255,255,255,${Math.min(0.95, s.pitchConfidence * 2)})`;
          ctx.fillRect(rightX, Math.round(py) - Math.floor(thick / 2), scrollSpeed, thick);
        }

        // Formants — green dots
        if (s.formant1Smooth > FREQ_LO) {
          ctx.fillStyle = 'rgba(0,255,80,0.8)';
          ctx.fillRect(rightX, Math.round(freqToCanvasY(s.formant1Smooth)) - 1, scrollSpeed, 3);
        }
        if (s.formant2Smooth > FREQ_LO) {
          ctx.fillStyle = 'rgba(0,255,80,0.6)';
          ctx.fillRect(rightX, Math.round(freqToCanvasY(s.formant2Smooth)) - 1, scrollSpeed, 3);
        }
        if (s.formant3Smooth > FREQ_LO) {
          ctx.fillStyle = 'rgba(0,255,80,0.4)';
          ctx.fillRect(rightX, Math.round(freqToCanvasY(s.formant3Smooth)) - 1, scrollSpeed, 3);
        }

        // Spectral centroid — pink line
        if (s.spectralCentroidSmooth > FREQ_LO && s.rmsSmooth > 0.003) {
          const centroidDelta = prevCentroid > 0
            ? Math.abs(s.spectralCentroidSmooth - prevCentroid) / prevCentroid : 1;
          prevCentroid = s.spectralCentroidSmooth;
          if (centroidDelta < 0.08) centroidStable = Math.min(10, centroidStable + 1);
          else centroidStable = Math.max(0, centroidStable - 2);
          if (centroidStable >= 3) {
            const cy = freqToCanvasY(s.spectralCentroidSmooth);
            const thick = Math.max(2, Math.round(COCHLEA_H * 0.003));
            const fadeIn = Math.min(1, centroidStable / 6);
            ctx.fillStyle = `rgba(255,80,220,${Math.min(0.85, s.rmsSmooth * 40) * fadeIn})`;
            ctx.fillRect(rightX, Math.round(cy) - Math.floor(thick / 2), scrollSpeed, thick);
          }
        } else { prevCentroid = 0; centroidStable = 0; }

        // Voice frequency lines
        for (let i = 0; i < voices.length; i++) {
          const v = voices[i];
          if (v.freq > FREQ_LO && v.freq < FREQ_HI) {
            const vy = freqToCanvasY(v.freq);
            const thick = Math.max(2, Math.round(COCHLEA_H * 0.003));
            ctx.fillStyle = `rgba(255,255,255,${Math.min(0.85, v.strength * 500)})`;
            ctx.fillRect(rightX, Math.round(vy) - Math.floor(thick / 2), scrollSpeed, thick);
          }
        }

        // Spectral rolloff — cyan line
        if (s.spectralRolloff > FREQ_LO && s.rmsSmooth > 0.005) {
          ctx.fillStyle = 'rgba(0,220,255,0.5)';
          ctx.fillRect(rightX, Math.round(freqToCanvasY(s.spectralRolloff)), scrollSpeed, 2);
        }

        // Harmonic series overlay — green dots
        if (s.pitchSmooth > FREQ_LO && s.pitchConfidence > 0.25) {
          for (let h = 1; h < 32; h++) {
            const hFreq = s.pitchSmooth * (h + 1);
            if (hFreq > FREQ_HI) break;
            const amp = s.harmonicAmplitudes[h];
            if (amp < 0.01) continue;
            const hy = freqToCanvasY(hFreq);
            if (hy < COCHLEA_Y || hy >= COCHLEA_Y + COCHLEA_H) continue;
            ctx.fillStyle = `rgba(0,255,160,${Math.min(0.7, amp * 3)})`;
            ctx.fillRect(rightX, Math.round(hy), scrollSpeed, 2);
          }
        }
      }

      // Noise fuzz overlay at top of cochleagram
      const noiseGateRaw = Math.max(0, 1 - s.harmonicity * 2 - s.pitchConfidence * 1.5);
      noiseGateSmooth += 0.15 * (noiseGateRaw - noiseGateSmooth);
      let lowE = 0, midE = 0, hiE = 0;
      for (let i = 0; i < NUM_BANDS; i++) {
        const e = s.bandEnergySmooth[i];
        if (i < 7) lowE += e; else if (i < 19) midE += e; else hiE += e;
      }
      const totalE = lowE + midE + hiE;
      if (totalE > 0.001 && noiseGateSmooth > 0.15) {
        const gs = noiseGateSmooth * 6;
        const hiI = Math.min(1, hiE * gs);
        const fuzzRowH = Math.round(COCHLEA_H * 0.05);
        if (hiI > 0.05) {
          const n = Math.round(hiI * 40 * scrollSpeed);
          for (let p = 0; p < n; p++) {
            const a = (0.3 + Math.random() * 0.5) * hiI;
            ctx.fillStyle = `rgba(120,230,250,${a})`;
            ctx.fillRect(rightX + Math.floor(Math.random() * scrollSpeed),
              COCHLEA_Y + Math.floor(Math.random() * fuzzRowH), 4, 4);
          }
        }
      }

      // ════════════════════════════════════════
      // STRIP 7: VOLUME / ENERGY (bottom)
      // ════════════════════════════════════════
      {
        const eNorm = Math.min(1, s.rmsSmooth * featGain);
        // Green gradient based on energy level
        const vR = Math.round(20 + eNorm * 40);
        const vG = Math.round(40 + eNorm * 200);
        const vB = Math.round(20 + eNorm * 30);
        ctx.fillStyle = `rgb(${vR},${vG},${vB})`;
        ctx.fillRect(rightX, VOLUME_Y, scrollSpeed, VOLUME_H);

        // Energy bar from bottom
        const barH = Math.round(eNorm * VOLUME_H);
        ctx.fillStyle = `rgba(255,255,255,${eNorm * 0.4})`;
        ctx.fillRect(rightX, VOLUME_Y + VOLUME_H - barH, scrollSpeed, barH);

        // RMS level line
        const rmsY = VOLUME_Y + VOLUME_H - Math.round(eNorm * (VOLUME_H - 2)) - 1;
        ctx.fillStyle = 'rgba(255,255,255,0.8)';
        ctx.fillRect(rightX, rmsY, scrollSpeed, 2);
      }


      // ════════════════════════════════════════
      // BEAT RENDERING (reads from store, computed in features pipeline)
      // ════════════════════════════════════════
      btFrameCount++;

      // Beat flash on detected beat
      if (s.isBeat && s.beatShowBeats) {
        beatFlash = 5;
      }

      // Draw beat columns spanning all strips
      if (beatFlash > 0 && s.beatShowBeats) {
        beatFlash--;
        const pa = s.beatPhaseAccuracy;
        const bR = Math.round(pa < 0.5 ? 255 : 255 * (1 - (pa - 0.5) * 2));
        const bG = Math.round(pa < 0.5 ? pa * 2 * 180 : 80 + 175 * (pa - 0.5) * 2);
        const bB = Math.round(20 * (1 - pa));
        ctx.fillStyle = `rgba(${bR},${bG},${bB},${(beatFlash / 5) * 0.3})`;
        ctx.fillRect(rightX, 0, scrollSpeed, CANVAS_H);

        if (beatFlash === 4 && s.bpm > 0) {
          const fontSize = Math.round(CANVAS_H * 0.018);
          ctx.font = `bold ${fontSize}px sans-serif`;
          ctx.fillStyle = 'rgba(255,255,255,0.9)';
          ctx.fillText(`${s.bpm}`, rightX - fontSize * 2, SPEECH_Y + SPEECH_H - 4);
        }
      } else if (!s.beatShowBeats) { beatFlash = 0; }

      // Broadband transient detection
      let brightBins = 0;
      for (let r = 0; r < NUM_FREQ_ROWS; r++) { if (curGamma[r] > 0.5) brightBins++; }
      brightBinAvg = brightBinAvg * 0.95 + brightBins * 0.05;
      if (transientCooldown > 0) transientCooldown--;
      if (brightBins > brightBinAvg * 3 && brightBins > NUM_FREQ_ROWS * 0.3 && transientCooldown === 0) {
        transientCooldown = 15;
        const dashLen = Math.round(CANVAS_H * 0.008);
        const gapLen = Math.round(CANVAS_H * 0.006);
        ctx.fillStyle = 'rgba(255,255,255,0.9)';
        for (let dy = 0; dy < CANVAS_H; dy += dashLen + gapLen)
          ctx.fillRect(rightX, dy, 1, Math.min(dashLen, CANVAS_H - dy));
      }


      // ════════════════════════════════════════
      // OVERLAY CANVAS (fixed, cleared each frame)
      // ════════════════════════════════════════
      oCtx.clearRect(0, 0, CANVAS_W, CANVAS_H);

      // ── Speech words on overlay ──
      {
        const fontSize = Math.round(SPEECH_H * 0.55);
        oCtx.font = `bold ${fontSize}px sans-serif`;
        oCtx.textAlign = 'left';
        oCtx.textBaseline = 'middle';
        // Scroll and render speech words
        const newWords = [];
        for (const w of speechDisplayWords) {
          w.x -= scrollSpeed;
          if (w.x > -fontSize * 10) {
            const alpha = Math.min(1, Math.max(0.1, 1 - Math.abs(w.x - SCROLL_W / 2) / (SCROLL_W / 2)));
            oCtx.fillStyle = `rgba(220,230,255,${alpha * 0.9})`;
            oCtx.fillText(w.word, w.x, SPEECH_Y + SPEECH_H / 2);
            newWords.push(w);
          }
        }
        speechDisplayWords = newWords;

        // Loading indicator text
        if (s.speechLoading) {
          oCtx.fillStyle = 'rgba(100,120,150,0.5)';
          oCtx.font = `${Math.round(fontSize * 0.6)}px sans-serif`;
          oCtx.fillText('loading speech model...', 60 * DPR, SPEECH_Y + SPEECH_H / 2);
        }
      }

      // ── Voice arrows (right edge) ──
      {
        const fontSize = Math.round(CANVAS_H * 0.01);
        const textZoneW = Math.round(fontSize * 4);
        const arrowZoneW = Math.round(30 * DPR);
        oCtx.font = `${fontSize}px sans-serif`;
        oCtx.textAlign = 'right';
        oCtx.textBaseline = 'middle';
        const arrowRight = CANVAS_W - textZoneW;
        for (let i = 0; i < voices.length; i++) {
          const v = voices[i];
          const cy = freqToCanvasY(v.freq);
          const sz = Math.max(8, Math.round(10 * DPR + v.strength * 3000));
          const alpha = Math.min(0.9, v.strength * 500);
          if (alpha > 0.05) {
            const c = VOICE_COLORS[i];
            const tipX = arrowRight - sz * 1.5, tailX = arrowRight, halfH = sz * 0.6;
            oCtx.beginPath(); oCtx.moveTo(tipX - 3, cy); oCtx.lineTo(tailX, cy - halfH - 3); oCtx.lineTo(tailX, cy + halfH + 3); oCtx.closePath();
            oCtx.fillStyle = `rgba(0,0,0,${alpha})`; oCtx.fill();
            oCtx.beginPath(); oCtx.moveTo(tipX - 1, cy); oCtx.lineTo(tailX, cy - halfH - 1); oCtx.lineTo(tailX, cy + halfH + 1); oCtx.closePath();
            oCtx.fillStyle = `rgba(255,255,255,${alpha})`; oCtx.fill();
            oCtx.beginPath(); oCtx.moveTo(tipX, cy); oCtx.lineTo(tailX, cy - halfH); oCtx.lineTo(tailX, cy + halfH); oCtx.closePath();
            oCtx.fillStyle = `rgba(${c[0]},${c[1]},${c[2]},${alpha})`; oCtx.fill();
            const freqText = v.freq >= 1000 ? `${(v.freq / 1000).toFixed(1)}k` : `${Math.round(v.freq)}`;
            oCtx.fillStyle = `rgba(255,255,255,${alpha * 0.7})`;
            oCtx.fillText(freqText, CANVAS_W - 4, cy);
          }
        }
      }

      // ── Beat indicator circle (upper-right) ──
      if (s.beatShowBeats) {
        const pad = Math.round(16 * DPR), circR = Math.round(14 * DPR);
        const bx = CANVAS_W - ARROW_W / 2, by = pad + circR;
        const pa = s.beatPhaseAccuracy;
        const cR = Math.round(pa < 0.5 ? 255 : 255 * (1 - (pa - 0.5) * 2));
        const cG = Math.round(pa < 0.5 ? pa * 2 * 180 : 80 + 175 * (pa - 0.5) * 2);
        const cB = Math.round(20 * (1 - pa));
        if (s.beatPulse > 0) {
          oCtx.beginPath(); oCtx.arc(bx, by, Math.round(circR * (0.7 + 0.3 * s.beatPulse)), 0, Math.PI * 2);
          oCtx.fillStyle = `rgba(${cR},${cG},${cB},${s.beatPulse})`; oCtx.fill();
        }
      }


      // ── Circle of Fifths (bottom-left, above timbre map) ──
      {
        const pad = Math.round(8 * DPR);
        const cofSize = Math.round(Math.min(CANVAS_H * 0.12, CANVAS_W * 0.12));
        const cofX = pad, cofY = CANVAS_H - TIMBRE_SZ - cofSize - pad * 3;
        const cofCx = cofX + cofSize / 2, cofCy = cofY + cofSize / 2;
        const outerR = cofSize / 2;
        const COF_MAJOR = ['C','G','D','A','E','B','F#','C#','G#','D#','A#','F'];
        const COF_MINOR = ['Am','Em','Bm','F#m','C#m','G#m','D#m','A#m','Fm','Cm','Gm','Dm'];

        let detKeyIdx = -1, detKeyIsMajor = true;
        if (displayKey) {
          const parts = displayKey.split(' ');
          if (parts[1] === 'maj') { detKeyIdx = COF_MAJOR.indexOf(parts[0]); detKeyIsMajor = true; }
          else if (parts[1] === 'min') { detKeyIdx = COF_MINOR.indexOf(parts[0] + 'm'); detKeyIsMajor = false; }
        }

        oCtx.beginPath(); oCtx.arc(cofCx, cofCy, outerR, 0, Math.PI * 2);
        oCtx.fillStyle = 'rgba(0,0,0,0.65)'; oCtx.fill();

        const majorR = outerR * 0.85, minorR = outerR * 0.52, innerR = outerR * 0.35;
        oCtx.beginPath(); oCtx.arc(cofCx, cofCy, outerR * 0.68, 0, Math.PI * 2);
        oCtx.strokeStyle = 'rgba(60,60,60,0.5)'; oCtx.lineWidth = 1; oCtx.stroke();
        oCtx.beginPath(); oCtx.arc(cofCx, cofCy, innerR, 0, Math.PI * 2);
        oCtx.strokeStyle = 'rgba(60,60,60,0.4)'; oCtx.stroke();

        for (let i = 0; i < 12; i++) {
          const angle = (i * 30 - 90 - 15) * Math.PI / 180;
          oCtx.beginPath();
          oCtx.moveTo(cofCx + innerR * Math.cos(angle), cofCy + innerR * Math.sin(angle));
          oCtx.lineTo(cofCx + outerR * Math.cos(angle), cofCy + outerR * Math.sin(angle));
          oCtx.strokeStyle = 'rgba(50,50,50,0.4)'; oCtx.lineWidth = 1; oCtx.stroke();
        }

        if (detKeyIdx >= 0 && s.signalPresent) {
          const startAngle = (detKeyIdx * 30 - 90 - 15) * Math.PI / 180;
          const endAngle = (detKeyIdx * 30 - 90 + 15) * Math.PI / 180;
          const hlR = detKeyIsMajor ? outerR : outerR * 0.68;
          const hlInner = detKeyIsMajor ? outerR * 0.68 : innerR;
          oCtx.beginPath();
          oCtx.arc(cofCx, cofCy, hlR, startAngle, endAngle);
          oCtx.arc(cofCx, cofCy, hlInner, endAngle, startAngle, true);
          oCtx.closePath(); oCtx.fillStyle = 'rgba(80,180,255,0.45)'; oCtx.fill();
        }

        const majFontSz = Math.max(6, Math.round(cofSize * 0.08));
        const minFontSz = Math.max(5, Math.round(cofSize * 0.065));
        for (let i = 0; i < 12; i++) {
          const angle = (i * 30 - 90) * Math.PI / 180;
          const mx = cofCx + majorR * Math.cos(angle), my = cofCy + majorR * Math.sin(angle);
          oCtx.font = `${detKeyIdx === i && detKeyIsMajor ? 'bold ' : ''}${majFontSz}px sans-serif`;
          oCtx.textAlign = 'center'; oCtx.textBaseline = 'middle';
          oCtx.fillStyle = detKeyIdx === i && detKeyIsMajor ? 'rgba(140,220,255,0.95)' : 'rgba(180,180,180,0.6)';
          oCtx.fillText(COF_MAJOR[i], mx, my);
          const nx = cofCx + minorR * Math.cos(angle), ny = cofCy + minorR * Math.sin(angle);
          oCtx.font = `${detKeyIdx === i && !detKeyIsMajor ? 'bold ' : ''}${minFontSz}px sans-serif`;
          oCtx.fillStyle = detKeyIdx === i && !detKeyIsMajor ? 'rgba(140,220,255,0.95)' : 'rgba(140,140,140,0.5)';
          oCtx.fillText(COF_MINOR[i], nx, ny);
        }

        if (displayChord && s.signalPresent) {
          oCtx.font = `bold ${Math.max(7, Math.round(cofSize * 0.12))}px sans-serif`;
          oCtx.textAlign = 'center'; oCtx.textBaseline = 'middle';
          oCtx.fillStyle = 'rgba(255,255,200,0.9)';
          oCtx.fillText(displayChord, cofCx, cofCy);
        }

        oCtx.beginPath(); oCtx.arc(cofCx, cofCy, outerR, 0, Math.PI * 2);
        oCtx.strokeStyle = 'rgba(100,100,100,0.5)'; oCtx.lineWidth = 1; oCtx.stroke();
      }


      // ── Timbre space overlay (bottom-left corner) ──
      {
        const pad = Math.round(8 * DPR);
        const boxX = pad, boxY = CANVAS_H - TIMBRE_SZ - pad;
        const boxW = TIMBRE_SZ, boxH = TIMBRE_SZ;

        oCtx.fillStyle = 'rgba(0,0,0,0.6)';
        oCtx.fillRect(boxX, boxY, boxW, boxH);
        oCtx.strokeStyle = 'rgba(100,100,100,0.5)'; oCtx.lineWidth = 1;
        oCtx.strokeRect(boxX, boxY, boxW, boxH);

        const cx = boxX + boxW / 2, cy2 = boxY + boxH / 2;
        oCtx.strokeStyle = 'rgba(60,60,60,0.6)';
        oCtx.beginPath(); oCtx.moveTo(boxX, cy2); oCtx.lineTo(boxX + boxW, cy2);
        oCtx.moveTo(cx, boxY); oCtx.lineTo(cx, boxY + boxH); oCtx.stroke();

        // MFCC adaptive normalization
        mfccInitFrames++;
        for (let k = 0; k < 13; k++) {
          const v = s.mfcc[k];
          if (mfccInitFrames < 30) {
            mfccMin[k] = Math.min(mfccMin[k], v);
            mfccMax[k] = Math.max(mfccMax[k], v);
          } else {
            mfccMin[k] += 0.002 * (v - mfccMin[k]);
            mfccMax[k] -= 0.002 * (mfccMax[k] - v);
            mfccMin[k] = Math.min(mfccMin[k], v);
            mfccMax[k] = Math.max(mfccMax[k], v);
          }
        }

        const centroidLog = s.spectralCentroidSmooth > 0
          ? Math.log(Math.max(200, Math.min(8000, s.spectralCentroidSmooth)) / 200) / Math.log(8000 / 200)
          : 0.5;
        const mfcc1range = mfccMax[1] - mfccMin[1];
        const mfcc1norm = mfcc1range > 1e-6 ? (s.mfcc[1] - mfccMin[1]) / mfcc1range : 0.5;
        const dotX = boxX + centroidLog * boxW;
        const dotY = boxY + (1 - mfcc1norm) * boxH;

        if (s.signalPresent && s.rmsSmooth > 0.003) {
          timbreTrailX[trailIdx] = dotX; timbreTrailY[trailIdx] = dotY;
          timbreTrailR[trailIdx] = Math.round(s.tristimulus[0] * 255);
          timbreTrailG[trailIdx] = Math.round(s.tristimulus[1] * 255);
          timbreTrailB[trailIdx] = Math.round(s.tristimulus[2] * 255);
          trailIdx = (trailIdx + 1) % TRAIL_LEN;
          if (trailCount < TRAIL_LEN) trailCount++;
        }

        for (let i = 0; i < trailCount; i++) {
          const idx = (trailIdx - 1 - i + TRAIL_LEN) % TRAIL_LEN;
          const age = i / TRAIL_LEN;
          const alpha = (1 - age) * 0.4;
          if (alpha < 0.02) continue;
          oCtx.fillStyle = `rgba(${timbreTrailR[idx]},${timbreTrailG[idx]},${timbreTrailB[idx]},${alpha})`;
          const sz = Math.max(2, Math.round(3 * DPR * (1 - age * 0.5)));
          oCtx.fillRect(timbreTrailX[idx] - sz / 2, timbreTrailY[idx] - sz / 2, sz, sz);
        }

        if (s.signalPresent && s.rmsSmooth > 0.003) {
          const tR = Math.min(255, Math.round(s.tristimulus[0] * 300 + 60));
          const tG = Math.min(255, Math.round(s.tristimulus[1] * 300 + 60));
          const tB = Math.min(255, Math.round(s.tristimulus[2] * 300 + 60));
          const dotSz = Math.round(5 * DPR);
          oCtx.fillStyle = 'rgba(255,255,255,0.9)';
          oCtx.fillRect(dotX - dotSz / 2 - 1, dotY - dotSz / 2 - 1, dotSz + 2, dotSz + 2);
          oCtx.fillStyle = `rgb(${tR},${tG},${tB})`;
          oCtx.fillRect(dotX - dotSz / 2, dotY - dotSz / 2, dotSz, dotSz);
        }

        const lblSz = Math.round(CANVAS_H * 0.008);
        oCtx.font = `${lblSz}px sans-serif`;
        oCtx.textAlign = 'left'; oCtx.textBaseline = 'bottom';
        oCtx.fillStyle = 'rgba(180,180,180,0.6)';
        oCtx.fillText('bright →', boxX + 2, boxY + boxH - 2);
        oCtx.save();
        oCtx.translate(boxX + lblSz, boxY + boxH - lblSz);
        oCtx.rotate(-Math.PI / 2);
        oCtx.fillText('warm →', 0, 0);
        oCtx.restore();

        if (s.inharmonicity > 0.001) {
          const barW = Math.round(Math.min(1, s.inharmonicity * 10) * boxW);
          oCtx.fillStyle = `rgba(255,160,40,${Math.min(0.8, s.inharmonicity * 5)})`;
          oCtx.fillRect(boxX, boxY + boxH - 3, barW, 3);
        }
      }
    },
  };
}
