// Onset detection via per-band spectral flux.
// READS: store.bandEnergy, store.centerFreqs, store.signalPresent, store.spectralCentroid
// DEPENDS ON: energy (needs bandEnergy)
// WRITES: store.onsetStrength, isOnset, onsetBrightness, onsetBandwidth
// DISPLAY: onset/flux strip — spectral flux line + onset markers

import { NUM_BANDS, store } from '../../store/feature-store.js';
import { ampThreshold } from '../../core/sensitivity.js';

const prevEnergy = new Float32Array(NUM_BANDS);
let onsetMedian = 0;

export function init() {}

export function update() {
  let flux = 0, onsetWeightedFreq = 0, onsetTotalDelta = 0;

  for (let i = 0; i < NUM_BANDS; i++) {
    const diff = store.bandEnergy[i] - prevEnergy[i];
    if (diff > 0) {
      flux += diff;
      onsetWeightedFreq += diff * store.centerFreqs[i];
      onsetTotalDelta += diff;
    }
    prevEnergy[i] = store.bandEnergy[i];
  }

  onsetMedian += 0.02 * (flux - onsetMedian);
  const threshold = onsetMedian * 2.0 + ampThreshold(0.005);

  store.onsetStrength = Math.min(flux / (threshold + 0.001), 1.0);
  store.isOnset = flux > threshold && store.signalPresent;

  if (store.isOnset) {
    store.onsetBrightness = onsetTotalDelta > 1e-6
      ? onsetWeightedFreq / onsetTotalDelta
      : store.spectralCentroid;
    let activeBands = 0;
    for (let i = 0; i < NUM_BANDS; i++) {
      if (store.bandEnergy[i] - prevEnergy[i] > ampThreshold(0.001)) activeBands++;
    }
    store.onsetBandwidth = activeBands / NUM_BANDS;
  }
}

export function reset() {
  prevEnergy.fill(0);
  onsetMedian = 0;
  store.onsetStrength = 0;
  store.isOnset = false;
}
