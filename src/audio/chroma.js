// Chromagram computation + key/chord detection.
// Folds FFT spectrum into 12 pitch-class bins (HPCP), then matches against
// Krumhansl-Kessler key profiles and chord templates.

import { SPECTRUM_BINS, store } from '../store/feature-store.js';

// dB range for chroma log-scaling (matches cochleagram approach)
const CHROMA_DB_FLOOR = -80;   // absolute bottom — chroma sums many bins so floor is higher
const CHROMA_DB_RANGE = 60;    // usable dynamic range (dB)

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

// Krumhansl-Kessler key profiles (starting from the tonic)
const MAJOR_PROFILE = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR_PROFILE = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

// Chord templates — root-position triads + 7ths
const CHORD_TYPES = [
  { name: '',    bits: [1, 0, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0] }, // major
  { name: 'm',   bits: [1, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0] }, // minor
  { name: 'dim', bits: [1, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0] }, // diminished
  { name: '7',   bits: [1, 0, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0] }, // dominant 7th
  { name: 'm7',  bits: [1, 0, 0, 1, 0, 0, 0, 1, 0, 0, 1, 0] }, // minor 7th
];

let sampleRate = 44100;
let fftSize = 8192;
let keyFrameCounter = 0;
let silenceFrames = 0; // consecutive frames without signal
const keyAccum = new Float32Array(24); // smoothed correlations for 12 major + 12 minor

export function initChroma(sr, fft) {
  sampleRate = sr;
  fftSize = fft;
}

// Reset accumulated key/chord state so stale detections don't bleed across silence gaps.
// Called from features.js after sustained silence (not on every silent frame).
export function resetChroma() {
  keyAccum.fill(0);
  keyFrameCounter = 0;
  silenceFrames = 0;
  store.chroma.fill(0);
}

export function updateChroma() {
  const binHz = sampleRate / fftSize;
  const numBins = Math.min(SPECTRUM_BINS, fftSize / 2);
  const rawChroma = new Float32Array(12);

  // Fold FFT bins into 12 pitch classes (60Hz–5000Hz harmonic range)
  const minBin = Math.max(1, Math.floor(60 / binHz));
  const maxBin = Math.min(numBins - 1, Math.floor(5000 / binHz));

  // Fold ALL FFT bins into chroma — no spectral gating at the bin level.
  for (let i = minBin; i <= maxBin; i++) {
    if (store.spectrumDb[i] < -90) continue; // noise gate
    const freq = i * binHz;
    const power = Math.pow(10, store.spectrumDb[i] / 10);

    // MIDI note → pitch class (0=C, 1=C#, ..., 11=B)
    const midi = 12 * Math.log2(freq / 440) + 69;
    const pc = ((Math.round(midi) % 12) + 12) % 12;

    rawChroma[pc] += power;
  }

  // Log-scale then linearly rescale to 0-1 (no auto-ranging).
  // Sensitivity offset shifts the effective noise gate — higher sensitivity
  // lets quieter notes through into both detection and display.
  for (let i = 0; i < 12; i++) {
    const db = rawChroma[i] > 1e-15 ? 10 * Math.log10(rawChroma[i]) : -150;
    const norm = (db + store._sensitivity - CHROMA_DB_FLOOR) / CHROMA_DB_RANGE;
    rawChroma[i] = Math.max(0, Math.min(1, norm));
  }

  // No chroma-level whitening needed — Pearson correlation (used by both
  // detectKey and detectChord) inherently subtracts the mean, so uniform
  // broadband energy from drums is already cancelled mathematically.

  // Smooth into store — asymmetric attack/release keeps onsets responsive
  // while letting chroma bins decay slowly for stable chord/key detection
  for (let i = 0; i < 12; i++) {
    const alpha = rawChroma[i] > store.chroma[i] ? 0.3 : 0.08;
    store.chroma[i] += alpha * (rawChroma[i] - store.chroma[i]);
  }

  // Key detection — update every 15 frames (~4× per second) for stability
  keyFrameCounter++;
  if (keyFrameCounter >= 15 && store.signalPresent) {
    keyFrameCounter = 0;
    detectKey();
  }

  // Chord detection — every frame for responsiveness
  if (store.signalPresent) {
    detectChord();
  }

}

function detectKey() {
  let bestCorr = -Infinity, bestRoot = 0, bestMode = 0;

  for (let root = 0; root < 12; root++) {
    const corrMaj = pearson(store.chroma, MAJOR_PROFILE, root);
    const corrMin = pearson(store.chroma, MINOR_PROFILE, root);

    // Slow accumulator for key stability
    keyAccum[root] += 0.15 * (corrMaj - keyAccum[root]);
    keyAccum[12 + root] += 0.15 * (corrMin - keyAccum[12 + root]);

    if (keyAccum[root] > bestCorr) {
      bestCorr = keyAccum[root]; bestRoot = root; bestMode = 0;
    }
    if (keyAccum[12 + root] > bestCorr) {
      bestCorr = keyAccum[12 + root]; bestRoot = root; bestMode = 1;
    }
  }

  store.detectedKey = NOTE_NAMES[bestRoot] + (bestMode === 0 ? ' maj' : ' min');
  store.detectedKeyConfidence = Math.max(0, Math.min(1, bestCorr));
}

function detectChord() {
  // Require at least 3 active pitch classes — a chord needs multiple notes.
  // Threshold is relative to the max chroma value so it works at any volume.
  let chMax = 0;
  for (let i = 0; i < 12; i++) {
    if (store.chroma[i] > chMax) chMax = store.chroma[i];
  }
  const ACTIVE_THRESHOLD = chMax * 0.2; // 20% of max
  let activeCount = 0;
  for (let i = 0; i < 12; i++) {
    if (store.chroma[i] > ACTIVE_THRESHOLD) activeCount++;
  }
  if (activeCount < 3) {
    store.detectedChord = '';
    store.detectedChordConfidence = 0;
    return;
  }

  let bestCorr = -Infinity, bestName = '';

  for (const chord of CHORD_TYPES) {
    for (let root = 0; root < 12; root++) {
      // Use Pearson correlation (same as key detection) instead of cosine
      // similarity. Pearson subtracts the mean, so energy in non-chord-tone
      // bins actively hurts the score — cosine ignores it, which causes
      // random jumping with spectrally busy signals like house music.
      const corr = pearson(store.chroma, chord.bits, root);
      if (corr > bestCorr) {
        bestCorr = corr;
        bestName = NOTE_NAMES[root] + chord.name;
      }
    }
  }

  // Require meaningful correlation — below this the match is noise
  if (bestCorr < 0.25) {
    store.detectedChord = '';
    store.detectedChordConfidence = 0;
    return;
  }

  store.detectedChord = bestName;
  store.detectedChordConfidence = Math.max(0, bestCorr);
}

// Pearson correlation between chroma (rotated by `rotation`) and a key profile
function pearson(chroma, profile, rotation) {
  let sA = 0, sB = 0, sAB = 0, sA2 = 0, sB2 = 0;
  for (let i = 0; i < 12; i++) {
    const a = chroma[(i + rotation) % 12];
    const b = profile[i];
    sA += a; sB += b; sAB += a * b;
    sA2 += a * a; sB2 += b * b;
  }
  const num = 12 * sAB - sA * sB;
  const den = Math.sqrt((12 * sA2 - sA * sA) * (12 * sB2 - sB * sB));
  return den > 1e-10 ? num / den : 0;
}
