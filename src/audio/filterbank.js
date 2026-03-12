// Cochlear-style log-spaced filterbank: 28 bands from 30Hz–20kHz.

import { NUM_BANDS, store } from '../store/feature-store.js';

const MIN_FREQ = 30;
const MAX_FREQ = 20000;
const FFT_SIZE = 256;

export let bands = [];

export function createFilterbank(audioContext, inputNode) {
  bands = [];

  for (let i = 0; i < NUM_BANDS; i++) {
    const t = i / (NUM_BANDS - 1);
    const centerFreq = MIN_FREQ * Math.pow(MAX_FREQ / MIN_FREQ, t);
    store.centerFreqs[i] = centerFreq;

    // ~1/3 octave bandwidth
    const bandwidth = centerFreq * 0.2316;
    const Q = centerFreq / bandwidth;

    const filter = audioContext.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = centerFreq;
    filter.Q.value = Q;

    const analyser = audioContext.createAnalyser();
    analyser.fftSize = FFT_SIZE;
    analyser.smoothingTimeConstant = 0;

    inputNode.connect(filter);
    filter.connect(analyser);

    bands.push({
      filter,
      analyser,
      centerFreq,
      timeDomainData: new Float32Array(FFT_SIZE),
    });
  }

  return bands;
}
