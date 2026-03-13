// Key detection using chord-weighted Krumhansl-Schmuckler algorithm.
// Instead of correlating raw (noisy) chromagram, accumulates chord
// observations into a pitch class histogram and correlates that.
// This is much more accurate because chord detection already filters
// spectral noise into discrete musical events.

import { store } from '../store/feature-store.js';
import { NOTE_NAMES } from './chroma.js';

// Krumhansl-Kessler key profiles (from Krumhansl, 1990)
const MAJOR_PROFILE = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR_PROFILE = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

// Chord interval definitions: which pitch classes each chord quality contributes
const CHORD_INTERVALS = {
  'maj':  [0, 4, 7],
  'min':  [0, 3, 7],
  'dim':  [0, 3, 6],
  'aug':  [0, 4, 8],
  'sus2': [0, 2, 7],
  'sus4': [0, 5, 7],
  'maj7': [0, 4, 7, 11],
  'min7': [0, 3, 7, 10],
  '7':    [0, 4, 7, 10],
};

// Accumulated pitch class histogram from chord observations
const chordChroma = new Float64Array(12);
// ~15s half-life at 60fps: 0.5^(1/900) ≈ 0.99923
const DECAY = 0.99923;

// Smoothed per-key scores
const keyScores = new Float64Array(24); // 0-11 major, 12-23 minor
const SCORE_SMOOTH = 0.015;

function correlate(chroma, profile, root) {
  let sumX = 0, sumY = 0;
  for (let i = 0; i < 12; i++) {
    sumX += chroma[i];
    sumY += profile[i];
  }
  const meanX = sumX / 12;
  const meanY = sumY / 12;

  let num = 0, denX = 0, denY = 0;
  for (let i = 0; i < 12; i++) {
    const x = chroma[(i + root) % 12] - meanX;
    const y = profile[i] - meanY;
    num += x * y;
    denX += x * x;
    denY += y * y;
  }
  const den = Math.sqrt(denX * denY);
  return den > 1e-12 ? num / den : 0;
}

export function updateKeyDetection() {
  // Decay old chord evidence
  for (let i = 0; i < 12; i++) {
    chordChroma[i] *= DECAY;
  }

  // Add current chord observation to pitch class histogram
  if (store.chordConfidence > 0.2 && store.chordRoot >= 0 && store.chordQuality) {
    const intervals = CHORD_INTERVALS[store.chordQuality];
    if (intervals) {
      const w = store.chordConfidence;
      // Root gets extra weight (it's the most important note for key inference)
      chordChroma[store.chordRoot] += w * 2;
      for (let k = 1; k < intervals.length; k++) {
        chordChroma[(store.chordRoot + intervals[k]) % 12] += w;
      }
    }
  }

  // Check if we have enough accumulated evidence
  let total = 0;
  for (let i = 0; i < 12; i++) total += chordChroma[i];
  if (total < 3) {
    store.keyConfidence *= 0.99;
    return;
  }

  // Test all 24 keys, smooth scores
  for (let root = 0; root < 12; root++) {
    const majCorr = correlate(chordChroma, MAJOR_PROFILE, root);
    const minCorr = correlate(chordChroma, MINOR_PROFILE, root);
    keyScores[root] += SCORE_SMOOTH * (majCorr - keyScores[root]);
    keyScores[12 + root] += SCORE_SMOOTH * (minCorr - keyScores[12 + root]);
  }

  // Find best smoothed score
  let bestScore = -2;
  let bestIdx = 0;
  for (let i = 0; i < 24; i++) {
    if (keyScores[i] > bestScore) {
      bestScore = keyScores[i];
      bestIdx = i;
    }
  }

  const bestRoot = bestIdx % 12;
  const bestMode = bestIdx < 12 ? 'maj' : 'min';
  const confidence = Math.max(0, Math.min(1, (bestScore - 0.1) / 0.6));
  const candidateName = NOTE_NAMES[bestRoot] + (bestMode === 'min' ? 'm' : '');

  // Hysteresis: new key must beat current by significant margin
  if (store.keyName && candidateName !== store.keyName && store.keyRoot >= 0) {
    const curIdx = store.keyRoot + (store.keyMode === 'min' ? 12 : 0);
    if (curIdx < 24) {
      const margin = keyScores[bestIdx] - keyScores[curIdx];
      if (margin < 0.08) return;
    }
  }

  if (confidence > 0.1) {
    store.keyRoot = bestRoot;
    store.keyMode = bestMode;
    store.keyName = candidateName;
    store.keyConfidence = confidence;
  }
}
