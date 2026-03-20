// Formant detection via spectral peak picking + sound classification.
// READS: store.spectrumDb, signalPresent, isOnset, onsetBandwidth, spectralFlux,
//        pitchConfidence, spectralFlatness, harmonicity, spectralRolloff, bandEnergySmooth
// DEPENDS ON: spectrum (needs spectrumDb), onset (needs isOnset), pitch (needs pitchConfidence)
// WRITES: store.formant1/2/3, formant1/2/3Smooth, spectralFlux, spectralFluxSmooth,
//         soundClass, _plosiveHold
// DISPLAY: green formant lines overlaid on cochleagram

import { SPECTRUM_BINS, NUM_BANDS, store } from '../../store/feature-store.js';
import { ampThreshold } from '../../core/sensitivity.js';

let sampleRate = 44100;
let fftSize = 8192;
let binHz = sampleRate / fftSize;

const MAX_ENV = 2048;
const spectralEnv = new Float32Array(MAX_ENV);
const prevSpectrum = new Float32Array(MAX_ENV);

export function init(sr, fft) {
  sampleRate = sr;
  fftSize = fft;
  binHz = sr / fft;
}

export function update() {
  const minBin = Math.max(1, Math.floor(150 / binHz));
  const maxBin = Math.min(Math.floor(5000 / binHz), SPECTRUM_BINS - 1, MAX_ENV - 1);

  // Smooth spectral envelope (~150Hz window)
  const smoothW = Math.max(3, Math.round(75 / binHz));
  for (let i = minBin; i <= maxBin; i++) {
    let sum = 0, count = 0;
    const lo = Math.max(0, i - smoothW);
    const hi = Math.min(SPECTRUM_BINS - 1, i + smoothW);
    for (let j = lo; j <= hi; j++) { sum += Math.pow(10, store.spectrumDb[j] / 20); count++; }
    spectralEnv[i] = sum / count;
  }

  // Spectral flux
  let flux = 0, maxEnv = 0;
  for (let i = minBin; i <= maxBin; i++) {
    const diff = spectralEnv[i] - prevSpectrum[i];
    if (diff > 0) flux += diff;
    if (spectralEnv[i] > maxEnv) maxEnv = spectralEnv[i];
    prevSpectrum[i] = spectralEnv[i];
  }
  store.spectralFlux = maxEnv > 1e-6 ? Math.min(flux / (maxEnv * 10), 1) : 0;
  store.spectralFluxSmooth += 0.2 * (store.spectralFlux - store.spectralFluxSmooth);

  // Find peaks
  const peaks = [];
  const noiseFloor = maxEnv * 0.03;
  const peakRadius = Math.max(2, Math.round(30 / binHz));
  const valleyRadius = Math.max(8, Math.round(150 / binHz));

  for (let i = minBin + peakRadius; i <= maxBin - peakRadius; i++) {
    const val = spectralEnv[i];
    if (val < noiseFloor) continue;

    let isMax = true;
    for (let j = 1; j <= peakRadius; j++) {
      if (spectralEnv[i - j] >= val || spectralEnv[i + j] >= val) { isMax = false; break; }
    }
    if (!isMax) continue;

    let leftMin = val, rightMin = val;
    for (let j = 1; j <= valleyRadius && i - j >= minBin; j++) {
      if (spectralEnv[i - j] < leftMin) leftMin = spectralEnv[i - j];
    }
    for (let j = 1; j <= valleyRadius && i + j <= maxBin; j++) {
      if (spectralEnv[i + j] < rightMin) rightMin = spectralEnv[i + j];
    }
    const prominence = val - Math.max(leftMin, rightMin);
    if (prominence > noiseFloor * 0.3) peaks.push({ bin: i, amplitude: val, prominence });
  }

  peaks.sort((a, b) => b.prominence - a.prominence);
  const topPeaks = peaks.slice(0, 3).sort((a, b) => a.bin - b.bin);

  // Assign formants with frequency range constraints
  let f1Raw = 0, f2Raw = 0, f3Raw = 0;
  const candidates = topPeaks.map(p => p.bin * binHz);

  if (candidates.length >= 1) {
    const f1c = candidates.filter(f => f >= 200 && f <= 1000);
    f1Raw = f1c.length > 0 ? f1c[0] : (candidates[0] >= 150 ? candidates[0] : 0);
  }
  if (candidates.length >= 2) {
    const f2c = candidates.filter(f => f > (f1Raw || 400) * 1.2 && f >= 600 && f <= 2800);
    f2Raw = f2c.length > 0 ? f2c[0] : candidates[1];
  }
  if (candidates.length >= 3) {
    const f3c = candidates.filter(f => f > (f2Raw || 1000) * 1.1 && f >= 1500 && f <= 4500);
    f3Raw = f3c.length > 0 ? f3c[0] : candidates[2];
  }

  store.formant1 = f1Raw;
  store.formant2 = f2Raw;
  store.formant3 = f3Raw;

  function smoothFormant(current, raw) {
    if (raw <= 0 || !store.signalPresent) return current;
    const relDiff = current > 0 ? Math.abs(raw - current) / current : 1;
    const rate = relDiff > 0.2 ? 0.5 : 0.08;
    return current + rate * (raw - current);
  }
  store.formant1Smooth = smoothFormant(store.formant1Smooth, f1Raw);
  store.formant2Smooth = smoothFormant(store.formant2Smooth, f2Raw);
  store.formant3Smooth = smoothFormant(store.formant3Smooth, f3Raw);

  // Sound classification
  if (store.isOnset && store.onsetBandwidth > 0.3 && store.spectralFlux > ampThreshold(0.15)) {
    store.soundClass = 4; store._plosiveHold = 6;
  } else if (store._plosiveHold > 0) {
    store._plosiveHold--; store.soundClass = 4;
  } else if (!store.signalPresent) {
    store.soundClass = 0;
  } else if (store.pitchConfidence < ampThreshold(0.2) && store.spectralFlatness > 0.08) {
    store.soundClass = 3;
  } else if (store.pitchConfidence > 0.25) {
    const lowCutBand = Math.floor(NUM_BANDS * 0.35);
    let lowE = 0, highE = 0;
    for (let i = 0; i < lowCutBand; i++) lowE += store.bandEnergySmooth[i];
    for (let i = lowCutBand; i < NUM_BANDS; i++) highE += store.bandEnergySmooth[i];

    if (store.spectralFlatness > 0.06 && store.harmonicity < 0.4) store.soundClass = 2;
    else if (lowE > highE * 2.5 && store.spectralRolloff < 2500) store.soundClass = 5;
    else store.soundClass = 1;
  } else {
    store.soundClass = store.spectralFlatness > 0.05 ? 3 : 0;
  }
}

export function reset() {
  prevSpectrum.fill(0);
  store.formant1 = 0; store.formant2 = 0; store.formant3 = 0;
  store.formant1Smooth = 0; store.formant2Smooth = 0; store.formant3Smooth = 0;
  store.spectralFlux = 0; store.spectralFluxSmooth = 0;
  store.soundClass = 0;
}
