// Chromagram computation + key/chord detection.
// Folds FFT spectrum into 12 pitch-class bins (HPCP), then matches against
// Krumhansl-Kessler key profiles and chord templates.
// READS: store.spectrumDb, store._sensitivity, store.signalPresent
// DEPENDS ON: spectrum (needs spectrumDb)
// WRITES: store.chroma, detectedKey, detectedKeyConfidence, detectedChord, detectedChordConfidence
// DISPLAY: notes/chords strip — 12-row piano roll with pitch-class coloring + circle of fifths overlay

import { SPECTRUM_BINS, store } from '../../store/feature-store.js';
import { dbFloor } from '../../core/sensitivity.js';

const CHROMA_DB_FLOOR = -80;
const CHROMA_DB_RANGE = 60;

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

const MAJOR_PROFILE = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR_PROFILE = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

const CHORD_TYPES = [
  { name: '',     bits: [1, 0, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0] },
  { name: 'm',    bits: [1, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0] },
  { name: 'dim',  bits: [1, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0] },
  { name: '7',    bits: [1, 0, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0] },
  { name: 'm7',   bits: [1, 0, 0, 1, 0, 0, 0, 1, 0, 0, 1, 0] },
  { name: 'sus4', bits: [1, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0, 0] },
  { name: 'aug',  bits: [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0] },
];

let sampleRate = 44100;
let fftSize = 8192;
let keyFrameCounter = 0;
const keyAccum = new Float32Array(24);
const detChroma = new Float32Array(12);

export function init(sr, fft) {
  sampleRate = sr;
  fftSize = fft;
}

export function update() {
  const binHz = sampleRate / fftSize;
  const numBins = Math.min(SPECTRUM_BINS, fftSize / 2);
  const rawChroma = new Float32Array(12);

  const minBin = Math.max(1, Math.floor(60 / binHz));
  const maxBin = Math.min(numBins - 1, Math.floor(5000 / binHz));

  for (let i = minBin; i <= maxBin; i++) {
    if (store.spectrumDb[i] < dbFloor(-90)) continue;
    const freq = i * binHz;
    const power = Math.pow(10, store.spectrumDb[i] / 10);
    const midi = 12 * Math.log2(freq / 440) + 69;
    const pc = ((Math.round(midi) % 12) + 12) % 12;
    rawChroma[pc] += power;
  }

  for (let i = 0; i < 12; i++) {
    const db = rawChroma[i] > 1e-15 ? 10 * Math.log10(rawChroma[i]) : -150;
    const norm = (db - CHROMA_DB_FLOOR) / CHROMA_DB_RANGE;
    rawChroma[i] = Math.max(0, Math.min(1, norm));
  }

  for (let i = 0; i < 12; i++) {
    const alpha = rawChroma[i] > store.chroma[i] ? 0.3 : 0.08;
    store.chroma[i] += alpha * (rawChroma[i] - store.chroma[i]);
  }

  // Harmonic leakage compensation for detection
  for (let i = 0; i < 12; i++) {
    const leak3rd = store.chroma[(i + 5) % 12];
    const leak5th = store.chroma[(i + 8) % 12];
    detChroma[i] = Math.max(0, store.chroma[i] - leak3rd * 0.35 - leak5th * 0.15);
  }

  keyFrameCounter++;
  if (keyFrameCounter >= 15 && store.signalPresent) {
    keyFrameCounter = 0;
    detectKey();
  }

  if (store.signalPresent) detectChord();
}

function detectKey() {
  let bestCorr = -Infinity, bestRoot = 0, bestMode = 0;
  let secondCorr = -Infinity;

  for (let root = 0; root < 12; root++) {
    const corrMaj = pearson(detChroma, MAJOR_PROFILE, root);
    const corrMin = pearson(detChroma, MINOR_PROFILE, root);

    keyAccum[root] += 0.15 * (corrMaj - keyAccum[root]);
    keyAccum[12 + root] += 0.15 * (corrMin - keyAccum[12 + root]);

    if (keyAccum[root] > bestCorr) {
      secondCorr = bestCorr;
      bestCorr = keyAccum[root]; bestRoot = root; bestMode = 0;
    } else if (keyAccum[root] > secondCorr) {
      secondCorr = keyAccum[root];
    }
    if (keyAccum[12 + root] > bestCorr) {
      secondCorr = bestCorr;
      bestCorr = keyAccum[12 + root]; bestRoot = root; bestMode = 1;
    } else if (keyAccum[12 + root] > secondCorr) {
      secondCorr = keyAccum[12 + root];
    }
  }

  // Scale-fit disambiguation
  if (bestMode === 0) {
    const MAJOR_DEGREES = [0, 2, 4, 5, 7, 9, 11];
    let bestNonScale = 0, bestScaleE = 0;
    for (let i = 0; i < 12; i++) {
      if (MAJOR_DEGREES.includes((i - bestRoot + 12) % 12)) bestScaleE += detChroma[i];
      else bestNonScale += detChroma[i];
    }
    const subKey = (bestRoot + 5) % 12;
    const subCorr = keyAccum[subKey];
    let subNonScale = 0, subScaleE = 0;
    for (let i = 0; i < 12; i++) {
      if (MAJOR_DEGREES.includes((i - subKey + 12) % 12)) subScaleE += detChroma[i];
      else subNonScale += detChroma[i];
    }
    if (subCorr > bestCorr * 0.7 && subNonScale < bestNonScale * 0.6 && subScaleE > bestScaleE * 0.8) {
      bestRoot = subKey;
      bestCorr = subCorr;
    }
  }

  store.detectedKey = NOTE_NAMES[bestRoot] + (bestMode === 0 ? ' maj' : ' min');
  store.detectedKeyConfidence = Math.max(0, Math.min(1, bestCorr));
}

function detectChord() {
  let chMax = 0;
  for (let i = 0; i < 12; i++) { if (detChroma[i] > chMax) chMax = detChroma[i]; }
  const ACTIVE_THRESHOLD = chMax * 0.25;
  let activeCount = 0;
  for (let i = 0; i < 12; i++) { if (detChroma[i] > ACTIVE_THRESHOLD) activeCount++; }
  if (activeCount < 3) {
    store.detectedChord = '';
    store.detectedChordConfidence = 0;
    return;
  }

  let bestTriadCorr = -Infinity, bestTriadName = '', bestTriadRoot = 0;
  let bestCorr = -Infinity, bestName = '', bestChord = null, bestRoot = 0;

  for (const chord of CHORD_TYPES) {
    for (let root = 0; root < 12; root++) {
      const corr = pearson(detChroma, chord.bits, root);
      if (corr > bestCorr) {
        bestCorr = corr; bestName = NOTE_NAMES[root] + chord.name;
        bestChord = chord; bestRoot = root;
      }
      if ((chord.name === '' || chord.name === 'm') && corr > bestTriadCorr) {
        bestTriadCorr = corr; bestTriadName = NOTE_NAMES[root] + chord.name;
        bestTriadRoot = root;
      }
    }
  }

  if (bestCorr < 0.3) {
    store.detectedChord = '';
    store.detectedChordConfidence = 0;
    return;
  }

  // Extended chord validation
  if (bestChord && bestChord.name !== '' && bestChord.name !== 'm') {
    if (bestChord.name === 'dim' || bestChord.name === 'aug') {
      if (bestCorr < bestTriadCorr + 0.08) {
        bestName = bestTriadName; bestRoot = bestTriadRoot; bestCorr = bestTriadCorr;
      }
    }
    if (bestChord.name === 'sus4') {
      const fourthE = detChroma[(bestRoot + 5) % 12];
      const maj3rdE = detChroma[(bestRoot + 4) % 12];
      const min3rdE = detChroma[(bestRoot + 3) % 12];
      if (fourthE <= Math.max(maj3rdE, min3rdE) || bestCorr < bestTriadCorr + 0.05) {
        bestName = bestTriadName; bestRoot = bestTriadRoot; bestCorr = bestTriadCorr;
      }
    }
    if (bestChord.name === '7' || bestChord.name === 'm7') {
      const seventhEnergy = detChroma[(bestRoot + 10) % 12];
      const thirdIdx = bestChord.name === '7' ? 4 : 3;
      const triadAvg = (detChroma[bestRoot % 12] +
                        detChroma[(bestRoot + thirdIdx) % 12] +
                        detChroma[(bestRoot + 7) % 12]) / 3;
      if (seventhEnergy < triadAvg * 0.40) {
        bestName = NOTE_NAMES[bestRoot] + (bestChord.name === '7' ? '' : 'm');
      }
    }
  }

  store.detectedChord = bestName;
  store.detectedChordConfidence = Math.max(0, bestCorr);
}

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

export function reset() {
  keyAccum.fill(0);
  keyFrameCounter = 0;
  store.chroma.fill(0);
  store.detectedKey = '';
  store.detectedKeyConfidence = 0;
  store.detectedChord = '';
  store.detectedChordConfidence = 0;
}
