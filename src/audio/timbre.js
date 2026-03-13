// Timbre descriptors: MFCCs, tristimulus, inharmonicity.
// MFCCs computed via mel filterbank → log compression → DCT-II.
// Tristimulus from existing harmonic amplitudes.
// Inharmonicity from deviation of partials from perfect harmonic series.

import { SPECTRUM_BINS, store } from '../store/feature-store.js';

const NUM_MEL_BANDS = 26;
const NUM_MFCC = 13;

let sampleRate = 44100;
let fftSize = 8192;
let melFilters = null;  // sparse triangular filters
let dctCoeffs = null;   // [NUM_MFCC][NUM_MEL_BANDS]

// Pre-allocated work buffer
const melEnergies = new Float32Array(NUM_MEL_BANDS);

function hzToMel(hz) { return 2595 * Math.log10(1 + hz / 700); }
function melToHz(mel) { return 700 * (Math.pow(10, mel / 2595) - 1); }

export function initTimbre(sr, fft) {
  sampleRate = sr;
  fftSize = fft;

  const binHz = sr / fft;
  const numBins = Math.min(SPECTRUM_BINS, fft / 2);

  // ── Build mel filterbank (26 triangular filters, 60Hz–Nyquist) ──
  const melLo = hzToMel(60);
  const melHi = hzToMel(sr / 2);
  const melPts = new Float32Array(NUM_MEL_BANDS + 2);
  for (let i = 0; i < NUM_MEL_BANDS + 2; i++) {
    melPts[i] = melLo + (melHi - melLo) * i / (NUM_MEL_BANDS + 1);
  }

  const binPts = new Int32Array(NUM_MEL_BANDS + 2);
  for (let i = 0; i < NUM_MEL_BANDS + 2; i++) {
    binPts[i] = Math.min(numBins - 1, Math.round(melToHz(melPts[i]) / binHz));
  }

  melFilters = [];
  for (let m = 0; m < NUM_MEL_BANDS; m++) {
    melFilters.push({ lo: binPts[m], mid: binPts[m + 1], hi: binPts[m + 2] });
  }

  // ── Build DCT-II matrix ──
  dctCoeffs = [];
  for (let k = 0; k < NUM_MFCC; k++) {
    const row = new Float32Array(NUM_MEL_BANDS);
    for (let n = 0; n < NUM_MEL_BANDS; n++) {
      row[n] = Math.cos(Math.PI * k * (n + 0.5) / NUM_MEL_BANDS);
    }
    dctCoeffs.push(row);
  }
}

export function updateTimbre() {
  if (!melFilters) return;

  const binHz = sampleRate / fftSize;
  const numBins = Math.min(SPECTRUM_BINS, fftSize / 2);

  // ══════════════════════════════════════════════════
  // 1. MFCCs
  // ══════════════════════════════════════════════════
  // Apply mel filterbank to power spectrum
  for (let m = 0; m < NUM_MEL_BANDS; m++) {
    const { lo, mid, hi } = melFilters[m];
    let energy = 0;

    // Rising slope
    for (let b = lo; b <= mid && b < numBins; b++) {
      const w = mid > lo ? (b - lo) / (mid - lo) : 1;
      energy += Math.pow(10, store.spectrumDb[b] / 10) * w;
    }
    // Falling slope
    for (let b = mid + 1; b <= hi && b < numBins; b++) {
      const w = hi > mid ? (hi - b) / (hi - mid) : 1;
      energy += Math.pow(10, store.spectrumDb[b] / 10) * w;
    }

    melEnergies[m] = Math.log(Math.max(energy, 1e-10));
  }

  // DCT to get cepstral coefficients
  for (let k = 0; k < NUM_MFCC; k++) {
    let sum = 0;
    for (let n = 0; n < NUM_MEL_BANDS; n++) {
      sum += dctCoeffs[k][n] * melEnergies[n];
    }
    store.mfcc[k] = sum;
  }

  // ══════════════════════════════════════════════════
  // 2. TRISTIMULUS
  // ══════════════════════════════════════════════════
  // T1 = H1/total, T2 = (H2+H3+H4)/total, T3 = (H5+...+Hn)/total
  // Use raw (un-normalized) harmonic amplitudes for tristimulus and inharmonicity
  // so that absolute magnitudes are preserved for proper weighting
  const rawAmps = store.harmonicAmplitudesRaw;

  if (store.pitch > 0 && store.pitchConfidence > 0.3) {
    let total = 0;
    for (let h = 0; h < 32; h++) total += rawAmps[h];

    if (total > 1e-6) {
      store.tristimulus[0] = rawAmps[0] / total;
      store.tristimulus[1] = (rawAmps[1] + rawAmps[2] + rawAmps[3]) / total;

      let rest = 0;
      for (let h = 4; h < 32; h++) rest += rawAmps[h];
      store.tristimulus[2] = rest / total;
    }
  } else {
    // Decay tristimulus toward zero when no pitch detected
    store.tristimulus[0] *= 0.95;
    store.tristimulus[1] *= 0.95;
    store.tristimulus[2] *= 0.95;
  }

  // ══════════════════════════════════════════════════
  // 3. INHARMONICITY
  // ══════════════════════════════════════════════════
  // Weighted deviation of actual partial frequencies from perfect harmonic series
  if (store.pitch > 0 && store.pitchConfidence > 0.3) {
    const f0 = store.pitch;
    let totalDev = 0, totalW = 0;

    for (let h = 1; h < 16; h++) {
      const expected = f0 * (h + 1);
      if (expected > sampleRate / 2) break;

      const eBin = Math.round(expected / binHz);
      if (eBin >= numBins) break;

      // Find actual peak near expected position (±3% of frequency)
      let bestBin = eBin, bestPow = -200;
      const r = Math.max(2, Math.round(expected * 0.03 / binHz));
      for (let b = Math.max(1, eBin - r); b <= Math.min(numBins - 1, eBin + r); b++) {
        if (store.spectrumDb[b] > bestPow) {
          bestPow = store.spectrumDb[b];
          bestBin = b;
        }
      }

      const dev = Math.abs(bestBin * binHz - expected) / expected;
      const w = rawAmps[h];
      totalDev += dev * w;
      totalW += w;
    }

    store.inharmonicity = totalW > 1e-6 ? totalDev / totalW : 0;
  } else {
    store.inharmonicity *= 0.95; // decay when no pitch
  }
}
