// Harmonic structure extraction: identifies partials relative to detected pitch.
// READS: store.pitch, pitchConfidence, spectrumDb, signalPresent
// DEPENDS ON: pitch (needs detected f0), spectrum (needs spectrumDb)
// WRITES: store.harmonicity, harmonicAmplitudes, harmonicAmplitudesRaw
// DISPLAY: harmonics strip — 32 harmonic rows colored by harmonic number

import { SPECTRUM_BINS, store } from '../../store/feature-store.js';
import { ampThreshold } from '../../core/sensitivity.js';

let sampleRate = 44100;
let fftSize = 8192;

export function init(sr, fft) {
  sampleRate = sr;
  fftSize = fft;
}

export function update() {
  store.harmonicity = 0;
  store.harmonicAmplitudes.fill(0);

  if (store.pitch <= 0 || store.pitchConfidence <= ampThreshold(0.3)) return;

  const f0 = store.pitch;
  const binWidth = sampleRate / fftSize;
  const numBins = Math.min(SPECTRUM_BINS, fftSize / 2);

  let harmonicPower = 0;

  for (let h = 1; h <= 32; h++) {
    const hFreq = f0 * h;
    if (hFreq > sampleRate / 2 - binWidth) break;

    const centerBin = Math.round(hFreq / binWidth);
    const searchRadius = Math.max(1, Math.round(binWidth * 0.5 / binWidth));

    let peakPower = 0;
    for (let b = Math.max(1, centerBin - searchRadius); b <= Math.min(numBins - 1, centerBin + searchRadius); b++) {
      const power = Math.pow(10, store.spectrumDb[b] / 10);
      if (power > peakPower) peakPower = power;
    }

    store.harmonicAmplitudes[h - 1] = peakPower;
    harmonicPower += peakPower;
  }

  // Total power in the spectrum
  let totalSpecPower = 0;
  for (let i = 1; i < numBins; i++) totalSpecPower += Math.pow(10, store.spectrumDb[i] / 10);

  store.harmonicity = totalSpecPower > 1e-15 ? Math.min(harmonicPower / totalSpecPower, 1) : 0;

  // Save raw amplitudes before normalization (for timbre analysis)
  store.harmonicAmplitudesRaw.set(store.harmonicAmplitudes);

  // Normalize relative to fundamental
  const fundAmp = store.harmonicAmplitudes[0];
  if (fundAmp > 1e-15) {
    for (let h = 0; h < 32; h++) {
      store.harmonicAmplitudes[h] = Math.min(store.harmonicAmplitudes[h] / fundAmp, 1);
    }
  }
}

export function reset() {
  store.harmonicity = 0;
  store.harmonicAmplitudes.fill(0);
  store.harmonicAmplitudesRaw.fill(0);
}
