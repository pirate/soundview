// Formant detection via spectral peak picking.
// Finds the 2-3 most prominent peaks in the 200-4000Hz range of the smoothed spectrum.

import { SPECTRUM_BINS, NUM_BANDS, store } from '../store/feature-store.js';

let sampleRate = 44100;
let fftSize = 8192;
let binHz = sampleRate / fftSize;

// Pre-allocated buffers (sized to max possible bins in formant range)
const MAX_ENV = 2048;
const spectralEnv = new Float32Array(MAX_ENV);
const prevSpectrum = new Float32Array(MAX_ENV);

export function initFormants(sr, fft) {
  sampleRate = sr;
  fftSize = fft;
  binHz = sr / fft;
}

export function detectFormants() {
  const minBin = Math.max(1, Math.floor(150 / binHz));
  const maxBin = Math.min(Math.floor(5000 / binHz), SPECTRUM_BINS - 1, MAX_ENV - 1);

  // Step 1: Smooth spectral envelope with wider window (~150Hz)
  // Wider window smooths out individual harmonics to reveal formant peaks
  const smoothW = Math.max(3, Math.round(75 / binHz)); // ±75Hz
  for (let i = minBin; i <= maxBin; i++) {
    let sum = 0;
    let count = 0;
    const lo = Math.max(0, i - smoothW);
    const hi = Math.min(SPECTRUM_BINS - 1, i + smoothW);
    for (let j = lo; j <= hi; j++) {
      sum += Math.pow(10, store.spectrumDb[j] / 20);
      count++;
    }
    spectralEnv[i] = sum / count;
  }

  // Step 2: Spectral flux
  let flux = 0;
  let maxEnv = 0;
  for (let i = minBin; i <= maxBin; i++) {
    const diff = spectralEnv[i] - prevSpectrum[i];
    if (diff > 0) flux += diff;
    if (spectralEnv[i] > maxEnv) maxEnv = spectralEnv[i];
    prevSpectrum[i] = spectralEnv[i];
  }
  store.spectralFlux = maxEnv > 1e-6 ? Math.min(flux / (maxEnv * 10), 1) : 0;
  store.spectralFluxSmooth += 0.2 * (store.spectralFlux - store.spectralFluxSmooth);

  // Step 3: Find peaks — use wider neighborhood for the larger FFT
  const peaks = [];
  const noiseFloor = maxEnv * 0.03;
  const peakRadius = Math.max(2, Math.round(30 / binHz)); // ±30Hz for local max check
  const valleyRadius = Math.max(8, Math.round(150 / binHz)); // ±150Hz for prominence

  for (let i = minBin + peakRadius; i <= maxBin - peakRadius; i++) {
    const val = spectralEnv[i];
    if (val < noiseFloor) continue;

    // Must be local max over ±peakRadius
    let isMax = true;
    for (let j = 1; j <= peakRadius; j++) {
      if (spectralEnv[i - j] >= val || spectralEnv[i + j] >= val) {
        isMax = false;
        break;
      }
    }
    if (!isMax) continue;

    // Prominence: valley depth on each side
    let leftMin = val, rightMin = val;
    for (let j = 1; j <= valleyRadius && i - j >= minBin; j++) {
      if (spectralEnv[i - j] < leftMin) leftMin = spectralEnv[i - j];
    }
    for (let j = 1; j <= valleyRadius && i + j <= maxBin; j++) {
      if (spectralEnv[i + j] < rightMin) rightMin = spectralEnv[i + j];
    }
    const prominence = val - Math.max(leftMin, rightMin);

    if (prominence > noiseFloor * 0.3) {
      peaks.push({ bin: i, amplitude: val, prominence });
    }
  }

  // Sort by prominence
  peaks.sort((a, b) => b.prominence - a.prominence);

  // Take top 3, sorted by frequency
  const topPeaks = peaks.slice(0, 3).sort((a, b) => a.bin - b.bin);

  // Step 4: Assign formants with frequency range constraints
  // F1: 200-1000Hz, F2: 600-2800Hz, F3: 1500-4500Hz
  let f1Raw = 0, f2Raw = 0, f3Raw = 0;
  const candidates = topPeaks.map(p => p.bin * binHz);

  if (candidates.length >= 1) {
    // Find best F1 candidate (lowest, 200-1000Hz)
    const f1c = candidates.filter(f => f >= 200 && f <= 1000);
    if (f1c.length > 0) f1Raw = f1c[0];
    else if (candidates[0] >= 150) f1Raw = candidates[0];
  }
  if (candidates.length >= 2) {
    // F2: next peak above F1, in 600-2800Hz
    const f2c = candidates.filter(f => f > (f1Raw || 400) * 1.2 && f >= 600 && f <= 2800);
    if (f2c.length > 0) f2Raw = f2c[0];
    else if (candidates.length >= 2) f2Raw = candidates[1];
  }
  if (candidates.length >= 3) {
    const f3c = candidates.filter(f => f > (f2Raw || 1000) * 1.1 && f >= 1500 && f <= 4500);
    if (f3c.length > 0) f3Raw = f3c[0];
    else f3Raw = candidates[2];
  }

  store.formant1 = f1Raw;
  store.formant2 = f2Raw;
  store.formant3 = f3Raw;

  // Smooth formants — fast tracking with hysteresis to prevent jitter
  // Large jumps (>20%) track fast, small changes track slow (noise rejection)
  function smoothFormant(current, raw) {
    if (raw <= 0 || !store.signalPresent) return current;
    const diff = Math.abs(raw - current);
    const relDiff = current > 0 ? diff / current : 1;
    // Big jump → fast track (0.5), small wobble → slow track (0.08)
    const rate = relDiff > 0.2 ? 0.5 : 0.08;
    return current + rate * (raw - current);
  }
  store.formant1Smooth = smoothFormant(store.formant1Smooth, f1Raw);
  store.formant2Smooth = smoothFormant(store.formant2Smooth, f2Raw);
  store.formant3Smooth = smoothFormant(store.formant3Smooth, f3Raw);

  // Step 5: Sound classification — more nuanced thresholds
  // 0=silence, 1=voiced harmonic, 2=voiced noisy, 3=fricative, 4=plosive, 5=nasal

  // Hold plosive class for a few frames so it's visible
  if (store.isOnset && store.onsetBandwidth > 0.3 && store.spectralFlux > 0.15) {
    store.soundClass = 4;
    store._plosiveHold = 6; // hold for 6 frames
  } else if (store._plosiveHold > 0) {
    store._plosiveHold--;
    store.soundClass = 4;
  } else if (!store.signalPresent) {
    store.soundClass = 0;
  } else if (store.pitchConfidence < 0.2 && store.spectralFlatness > 0.08) {
    // Unvoiced + noisy = fricative (s, sh, f, th)
    store.soundClass = 3;
  } else if (store.pitchConfidence > 0.25) {
    // Voiced sounds — distinguish subtypes
    const lowCutBand = Math.floor(NUM_BANDS * 0.35);
    let lowE = 0, highE = 0;
    for (let i = 0; i < lowCutBand; i++) lowE += store.bandEnergySmooth[i];
    for (let i = lowCutBand; i < NUM_BANDS; i++) highE += store.bandEnergySmooth[i];

    if (store.spectralFlatness > 0.06 && store.harmonicity < 0.4) {
      // Voiced + noisy = voiced fricative (z, v, zh)
      store.soundClass = 2;
    } else if (lowE > highE * 2.5 && store.spectralRolloff < 2500) {
      // Voiced + low-freq dominant = nasal (m, n, ng)
      store.soundClass = 5;
    } else {
      // Clean voiced harmonic = vowel
      store.soundClass = 1;
    }
  } else {
    // Ambiguous — weak signal or transitional
    store.soundClass = store.spectralFlatness > 0.05 ? 3 : 0;
  }
}
