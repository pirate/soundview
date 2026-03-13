// Key detection using Krumhansl-Schmuckler algorithm.
// Correlates accumulated chromagram distribution against major/minor key profiles.

import { store } from '../store/feature-store.js';
import { NOTE_NAMES } from './chroma.js';

// Krumhansl-Kessler key profiles (from Krumhansl, 1990)
// These represent the expected distribution of pitch classes in each key.
const MAJOR_PROFILE = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR_PROFILE = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

// Accumulator: long-term weighted chroma distribution
const chromaAccum = new Float64Array(12);
const DECAY = 0.995;  // slow decay per frame (~3.3s half-life at 60fps)

let prevKeyName = '';
let keyStableFrames = 0;
const MIN_STABLE = 30; // ~500ms before accepting a key change

/**
 * Correlate a chroma distribution with a key profile rotated to a given root.
 */
function correlate(chroma, profile, root) {
  // Compute Pearson correlation between chroma and rotated profile
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

  // Accumulate weighted chroma (decay old, add new)
  let hasEnergy = false;
  for (let i = 0; i < 12; i++) {
    chromaAccum[i] = chromaAccum[i] * DECAY + chroma[i];
    if (chromaAccum[i] > 0.1) hasEnergy = true;
  }

  if (!hasEnergy) {
    store.keyConfidence = 0;
    return;
  }

  // Test all 24 keys (12 major + 12 minor)
  let bestCorr = -2;
  let bestRoot = 0;
  let bestMode = 'maj';

  for (let root = 0; root < 12; root++) {
    const majCorr = correlate(chromaAccum, MAJOR_PROFILE, root);
    if (majCorr > bestCorr) {
      bestCorr = majCorr;
      bestRoot = root;
      bestMode = 'maj';
    }
    const minCorr = correlate(chromaAccum, MINOR_PROFILE, root);
    if (minCorr > bestCorr) {
      bestCorr = minCorr;
      bestRoot = root;
      bestMode = 'min';
    }
  }

  // Confidence from correlation strength (typically 0.3-0.9)
  const confidence = Math.max(0, Math.min(1, (bestCorr - 0.2) / 0.6));

  const candidateName = NOTE_NAMES[bestRoot] + (bestMode === 'min' ? 'm' : '');

  // Stability filter: require consistent detection before updating displayed key
  if (candidateName === prevKeyName) {
    keyStableFrames++;
  } else {
    keyStableFrames = 0;
    prevKeyName = candidateName;
  }

  if (keyStableFrames >= MIN_STABLE && confidence > 0.2) {
    store.keyRoot = bestRoot;
    store.keyMode = bestMode;
    store.keyName = candidateName;
    store.keyConfidence = confidence;
  }
}
