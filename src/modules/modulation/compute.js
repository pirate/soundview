// Per-band modulation filterbank.
// Computes the modulation spectrum of each cochlear band's envelope
// using FFT of the envelope history buffer.
// READS: store.bandHistory, store.historyIndex, store.bandRoughness
// DEPENDS ON: energy (needs bandHistory filled)
// WRITES: store.bandModulation
// DISPLAY: no dedicated strip (data available for future visualization)

import { NUM_BANDS, NUM_MOD_BANDS, HISTORY_LEN, store } from '../../store/feature-store.js';

const FFT_N = 64;
const HALF_N = FFT_N >> 1;

const fftRe = new Float32Array(FFT_N);
const fftIm = new Float32Array(FFT_N);
const fftMag = new Float32Array(HALF_N);

const hannWindow = new Float32Array(FFT_N);
for (let i = 0; i < FFT_N; i++) {
  hannWindow[i] = 0.5 * (1 - Math.cos(2 * Math.PI * i / (FFT_N - 1)));
}

const MOD_BAND_RANGES = [
  [0, 2], [1, 3], [2, 5], [5, 9], [9, 18], [18, HALF_N],
];

function fft(re, im, N) {
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
    const wRe = Math.cos(angle), wIm = Math.sin(angle);
    for (let i = 0; i < N; i += len) {
      let curRe = 1, curIm = 0;
      for (let j = 0; j < half; j++) {
        const uRe = re[i + j], uIm = im[i + j];
        const vRe = re[i + j + half] * curRe - im[i + j + half] * curIm;
        const vIm = re[i + j + half] * curIm + im[i + j + half] * curRe;
        re[i + j] = uRe + vRe; im[i + j] = uIm + vIm;
        re[i + j + half] = uRe - vRe; im[i + j + half] = uIm - vIm;
        const newRe = curRe * wRe - curIm * wIm;
        curIm = curRe * wIm + curIm * wRe;
        curRe = newRe;
      }
    }
  }
}

let frameCounter = 0;

export function init() {}

export function update() {
  frameCounter++;
  if (frameCounter % 4 !== 0) return;

  const histIdx = store.historyIndex;

  for (let band = 0; band < NUM_BANDS; band++) {
    const history = store.bandHistory[band];

    for (let i = 0; i < FFT_N; i++) {
      const srcIdx = (histIdx - FFT_N + i + HISTORY_LEN) % HISTORY_LEN;
      fftRe[i] = history[srcIdx] * hannWindow[i];
      fftIm[i] = 0;
    }

    fft(fftRe, fftIm, FFT_N);

    for (let i = 0; i < HALF_N; i++) {
      fftMag[i] = Math.sqrt(fftRe[i] * fftRe[i] + fftIm[i] * fftIm[i]);
    }

    const offset = band * NUM_MOD_BANDS;
    for (let mb = 0; mb < 6; mb++) {
      const [start, end] = MOD_BAND_RANGES[mb];
      let sum = 0;
      for (let b = start; b < end; b++) sum += fftMag[b] * fftMag[b];
      store.bandModulation[offset + mb] = Math.sqrt(sum / (end - start));
    }
    store.bandModulation[offset + 6] = store.bandRoughness[band];
  }
}

export function reset() {
  store.bandModulation.fill(0);
  frameCounter = 0;
}
