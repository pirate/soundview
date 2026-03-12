// Per-band modulation filterbank.
// Computes the modulation spectrum of each cochlear band's envelope
// using FFT of the envelope history buffer.
//
// Modulation bands (at 60fps, 64-sample window):
//   0: <1Hz      (bins 0-1)
//   1: 1-2Hz     (bins 1-2)
//   2: 2-4Hz     (bins 2-4)
//   3: 4-8Hz     (bins 5-8)
//   4: 8-16Hz    (bins 9-17)
//   5: 16-30Hz   (bins 17-32)
//   6: roughness (30-300Hz, from within-buffer amplitude variance)

import { NUM_BANDS, NUM_MOD_BANDS, HISTORY_LEN, store } from '../store/feature-store.js';

const FFT_N = 64;
const HALF_N = FFT_N >> 1;

// Pre-allocated FFT work buffers
const fftRe = new Float32Array(FFT_N);
const fftIm = new Float32Array(FFT_N);
const fftMag = new Float32Array(HALF_N);

// Hann window for envelope FFT
const hannWindow = new Float32Array(FFT_N);
for (let i = 0; i < FFT_N; i++) {
  hannWindow[i] = 0.5 * (1 - Math.cos(2 * Math.PI * i / (FFT_N - 1)));
}

// Modulation band bin ranges [startBin, endBin) — endBin exclusive
const MOD_BAND_RANGES = [
  [0, 2],    // <1Hz
  [1, 3],    // 1-2Hz
  [2, 5],    // 2-4Hz
  [5, 9],    // 4-8Hz
  [9, 18],   // 8-16Hz
  [18, HALF_N], // 16-30Hz
];

// Radix-2 Cooley-Tukey FFT (in-place)
function fft(re, im, N) {
  // Bit-reversal permutation
  for (let i = 1, j = 0; i < N; i++) {
    let bit = N >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let tmp = re[i]; re[i] = re[j]; re[j] = tmp;
      tmp = im[i]; im[i] = im[j]; im[j] = tmp;
    }
  }

  for (let len = 2; len <= N; len <<= 1) {
    const half = len >> 1;
    const angle = -2 * Math.PI / len;
    const wRe = Math.cos(angle);
    const wIm = Math.sin(angle);

    for (let i = 0; i < N; i += len) {
      let curRe = 1, curIm = 0;
      for (let j = 0; j < half; j++) {
        const uRe = re[i + j];
        const uIm = im[i + j];
        const vRe = re[i + j + half] * curRe - im[i + j + half] * curIm;
        const vIm = re[i + j + half] * curIm + im[i + j + half] * curRe;
        re[i + j] = uRe + vRe;
        im[i + j] = uIm + vIm;
        re[i + j + half] = uRe - vRe;
        im[i + j + half] = uIm - vIm;
        const newRe = curRe * wRe - curIm * wIm;
        curIm = curRe * wIm + curIm * wRe;
        curRe = newRe;
      }
    }
  }
}

let frameCounter = 0;

/**
 * Update modulation spectrum for all bands.
 * Called every frame, but only recomputes FFT every 4th frame.
 */
export function updateModulation() {
  frameCounter++;
  if (frameCounter % 4 !== 0) return;

  const histIdx = store.historyIndex;

  for (let band = 0; band < NUM_BANDS; band++) {
    const history = store.bandHistory[band];

    // Extract most recent 64 samples from ring buffer, apply Hann window
    for (let i = 0; i < FFT_N; i++) {
      const srcIdx = (histIdx - FFT_N + i + HISTORY_LEN) % HISTORY_LEN;
      fftRe[i] = history[srcIdx] * hannWindow[i];
      fftIm[i] = 0;
    }

    // Compute FFT
    fft(fftRe, fftIm, FFT_N);

    // Compute magnitude spectrum
    for (let i = 0; i < HALF_N; i++) {
      fftMag[i] = Math.sqrt(fftRe[i] * fftRe[i] + fftIm[i] * fftIm[i]);
    }

    // Sum energy into modulation bands
    const offset = band * NUM_MOD_BANDS;
    for (let mb = 0; mb < 6; mb++) {
      const [start, end] = MOD_BAND_RANGES[mb];
      let sum = 0;
      for (let b = start; b < end; b++) {
        sum += fftMag[b] * fftMag[b];
      }
      store.bandModulation[offset + mb] = Math.sqrt(sum / (end - start));
    }

    // Band 6: roughness — already computed per-band in features.js as bandRoughness
    store.bandModulation[offset + 6] = store.bandRoughness[band];
  }
}
