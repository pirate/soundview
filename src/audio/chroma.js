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

// Chord templates — root-position triads + 7ths + sus4 + aug
const CHORD_TYPES = [
  { name: '',    bits: [1, 0, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0] }, // major
  { name: 'm',   bits: [1, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0] }, // minor
  { name: 'dim', bits: [1, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0] }, // diminished
  { name: '7',   bits: [1, 0, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0] }, // dominant 7th
  { name: 'm7',  bits: [1, 0, 0, 1, 0, 0, 0, 1, 0, 0, 1, 0] }, // minor 7th
  { name: 'sus4',bits: [1, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0, 0] }, // sus4
  { name: 'aug', bits: [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0] }, // augmented
];

let sampleRate = 44100;
let fftSize = 8192;
let keyFrameCounter = 0;
let silenceFrames = 0; // consecutive frames without signal
const keyAccum = new Float32Array(24); // smoothed correlations for 12 major + 12 minor
const detChroma = new Float32Array(12); // harmonic-compensated chroma for detection

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

  // Harmonic leakage compensation for detection (not display).
  // A note's harmonics bleed into other pitch classes:
  //   2nd harmonic → +12 semitones (same pitch class, no leakage)
  //   3rd harmonic → +19 semitones = +7 semitones mod 12 (perfect 5th up)
  //   5th harmonic → +28 semitones = +4 semitones mod 12 (major 3rd up)
  // This causes false energy in related pitch classes, confusing keys.
  // Subtract leaked energy before detection.
  for (let i = 0; i < 12; i++) {
    const leak3rd = store.chroma[(i + 5) % 12]; // bin whose 3rd harmonic falls here
    const leak5th = store.chroma[(i + 8) % 12]; // bin whose 5th harmonic falls here
    detChroma[i] = Math.max(0, store.chroma[i] - leak3rd * 0.35 - leak5th * 0.15);
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
  let secondCorr = -Infinity, secondRoot = 0, secondMode = 0;

  for (let root = 0; root < 12; root++) {
    const corrMaj = pearson(detChroma, MAJOR_PROFILE, root);
    const corrMin = pearson(detChroma, MINOR_PROFILE, root);

    // Slow accumulator for key stability
    keyAccum[root] += 0.15 * (corrMaj - keyAccum[root]);
    keyAccum[12 + root] += 0.15 * (corrMin - keyAccum[12 + root]);

    if (keyAccum[root] > bestCorr) {
      secondCorr = bestCorr; secondRoot = bestRoot; secondMode = bestMode;
      bestCorr = keyAccum[root]; bestRoot = root; bestMode = 0;
    } else if (keyAccum[root] > secondCorr) {
      secondCorr = keyAccum[root]; secondRoot = root; secondMode = 0;
    }
    if (keyAccum[12 + root] > bestCorr) {
      secondCorr = bestCorr; secondRoot = bestRoot; secondMode = bestMode;
      bestCorr = keyAccum[12 + root]; bestRoot = root; bestMode = 1;
    } else if (keyAccum[12 + root] > secondCorr) {
      secondCorr = keyAccum[12 + root]; secondRoot = root; secondMode = 1;
    }
  }

  // Scale-fit disambiguation: Pearson correlation can be misled when a dominant
  // chord has more energy than the tonic (e.g. harp cadenza on A7 in D major).
  // Cross-check: the correct key should have LOW energy on non-scale tones.
  // Compare the detected key with neighboring keys on the circle of fifths.
  if (bestMode === 0) {
    const MAJOR_DEGREES = [0, 2, 4, 5, 7, 9, 11]; // semitone intervals
    let bestNonScale = 0, bestScaleE = 0;
    for (let i = 0; i < 12; i++) {
      if (MAJOR_DEGREES.includes((i - bestRoot + 12) % 12)) bestScaleE += detChroma[i];
      else bestNonScale += detChroma[i];
    }
    // Check the key a 5th below (most common confusion: dominant → tonic)
    const subKey = (bestRoot + 5) % 12;
    const subCorr = keyAccum[subKey];
    let subNonScale = 0, subScaleE = 0;
    for (let i = 0; i < 12; i++) {
      if (MAJOR_DEGREES.includes((i - subKey + 12) % 12)) subScaleE += detChroma[i];
      else subNonScale += detChroma[i];
    }
    // Prefer the key with less non-scale energy (better scale fit)
    // Only switch if the sub key has notably better scale fit AND reasonable correlation
    if (subCorr > bestCorr * 0.7 && subNonScale < bestNonScale * 0.6 && subScaleE > bestScaleE * 0.8) {
      bestRoot = subKey;
      bestCorr = subCorr;
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
    if (detChroma[i] > chMax) chMax = detChroma[i];
  }
  const ACTIVE_THRESHOLD = chMax * 0.25; // 25% of max — stricter to avoid noise chords
  let activeCount = 0;
  for (let i = 0; i < 12; i++) {
    if (detChroma[i] > ACTIVE_THRESHOLD) activeCount++;
  }
  if (activeCount < 3) {
    store.detectedChord = '';
    store.detectedChordConfidence = 0;
    return;
  }

  // Compare each chord type+root, but give preference to simpler chords (triads)
  // by requiring extended chords (7ths, dim) to beat the best triad by a margin.
  let bestTriadCorr = -Infinity, bestTriadName = '', bestTriadRoot = 0;
  let bestCorr = -Infinity, bestName = '', bestChord = null, bestRoot = 0;

  for (const chord of CHORD_TYPES) {
    for (let root = 0; root < 12; root++) {
      const corr = pearson(detChroma, chord.bits, root);
      if (corr > bestCorr) {
        bestCorr = corr; bestName = NOTE_NAMES[root] + chord.name;
        bestChord = chord; bestRoot = root;
      }
      // Track best triad (major or minor) separately
      if ((chord.name === '' || chord.name === 'm') && corr > bestTriadCorr) {
        bestTriadCorr = corr; bestTriadName = NOTE_NAMES[root] + chord.name;
        bestTriadRoot = root;
      }
    }
  }

  // Require meaningful correlation — below this the match is noise
  if (bestCorr < 0.3) {
    store.detectedChord = '';
    store.detectedChordConfidence = 0;
    return;
  }

  // Extended chord validation: prefer simple triads unless the extension is
  // clearly present. This avoids false 7th/dim/sus/aug in noise or ambiguous passages
  // while still allowing them when the evidence is clear (important for jazz, R&B).
  if (bestChord && bestChord.name !== '' && bestChord.name !== 'm') {
    // For dim/aug: require them to beat best triad by a margin
    if (bestChord.name === 'dim' || bestChord.name === 'aug') {
      if (bestCorr < bestTriadCorr + 0.08) {
        bestName = bestTriadName;
        bestRoot = bestTriadRoot;
        bestCorr = bestTriadCorr;
      }
    }
    // For sus4: require 4th to actually be stronger than the 3rd (both major & minor)
    // Otherwise it's just a passing tone triggering a false sus4
    if (bestChord.name === 'sus4') {
      const fourthE = detChroma[(bestRoot + 5) % 12];
      const maj3rdE = detChroma[(bestRoot + 4) % 12];
      const min3rdE = detChroma[(bestRoot + 3) % 12];
      if (fourthE <= Math.max(maj3rdE, min3rdE) || bestCorr < bestTriadCorr + 0.05) {
        bestName = bestTriadName;
        bestRoot = bestTriadRoot;
        bestCorr = bestTriadCorr;
      }
    }
    // For 7th chords: verify the 7th note is actually audible
    if (bestChord.name === '7' || bestChord.name === 'm7') {
      const seventhEnergy = detChroma[(bestRoot + 10) % 12];
      const thirdIdx = bestChord.name === '7' ? 4 : 3;
      const triadAvg = (detChroma[bestRoot % 12] +
                        detChroma[(bestRoot + thirdIdx) % 12] +
                        detChroma[(bestRoot + 7) % 12]) / 3;
      // Require 7th at least 40% of triad average
      if (seventhEnergy < triadAvg * 0.40) {
        bestName = NOTE_NAMES[bestRoot] + (bestChord.name === '7' ? '' : 'm');
      }
    }
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
