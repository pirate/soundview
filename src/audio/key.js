// Key detection using Krumhansl-Schmuckler algorithm.
// Correlates accumulated chromagram distribution against major/minor key profiles.

import { store } from '../store/feature-store.js';
import { NOTE_NAMES } from './chroma.js';

// Krumhansl-Kessler key profiles (from Krumhansl, 1990)
const MAJOR_PROFILE = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR_PROFILE = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

// Long-term chroma accumulator with very slow decay
const chromaAccum = new Float64Array(12);
// ~10s half-life at 60fps: 0.5 = d^600, d = 0.5^(1/600) ≈ 0.99885
const DECAY = 0.99885;

// Per-key correlation scores, smoothed over time
const keyScores = new Float64Array(24); // 0-11 major, 12-23 minor
const SCORE_SMOOTH = 0.02; // very slow smoothing for score history

/**
 * Correlate a chroma distribution with a key profile rotated to a given root.
 */
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

/**
 * Update key detection from the current chromagram.
 * Call once per frame after chromagram is computed.
 */
export function updateKeyDetection() {
  const chroma = store.chromagramSmooth;

  // Weight chromagram by signal energy so loud/clear notes matter more
  const weight = store.signalPresent ? Math.min(1, store.rmsSmooth * 10) : 0;

  // Accumulate weighted chroma (decay old, add energy-weighted new)
  let hasEnergy = false;
  for (let i = 0; i < 12; i++) {
    chromaAccum[i] = chromaAccum[i] * DECAY + chroma[i] * weight;
    if (chromaAccum[i] > 0.5) hasEnergy = true;
  }

  if (!hasEnergy) {
    store.keyConfidence *= 0.99; // slow fade rather than instant drop
    return;
  }

  // Test all 24 keys and smooth the scores over time
  for (let root = 0; root < 12; root++) {
    const majCorr = correlate(chromaAccum, MAJOR_PROFILE, root);
    const minCorr = correlate(chromaAccum, MINOR_PROFILE, root);
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
  const confidence = Math.max(0, Math.min(1, (bestScore - 0.2) / 0.5));
  const candidateName = NOTE_NAMES[bestRoot] + (bestMode === 'min' ? 'm' : '');

  // Hysteresis: require the new key to beat the current key's score
  // by a significant margin before switching
  if (store.keyName && candidateName !== store.keyName) {
    const curIdx = store.keyRoot + (store.keyMode === 'min' ? 12 : 0);
    const margin = keyScores[bestIdx] - keyScores[curIdx];
    // Need >0.05 correlation advantage to switch keys
    if (margin < 0.05) return;
  }

  if (confidence > 0.15) {
    store.keyRoot = bestRoot;
    store.keyMode = bestMode;
    store.keyName = candidateName;
    store.keyConfidence = confidence;
  }
}
