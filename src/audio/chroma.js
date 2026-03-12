// Chromagram computation — maps FFT spectrum to 12 pitch classes.
// Adapted from Adam Stark's Chord-Detector-and-Chromagram.
// Writes directly to store.chromagram / store.chromagramSmooth.

import { store, SPECTRUM_BINS } from '../store/feature-store.js';

const NUM_CHROMA = 12;
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

// Precompute all note frequencies we care about:
// C2 (~65Hz) through B6 (~1976Hz) for fundamentals,
// plus harmonics 2 & 3 which can reach higher.
// A4 = 440Hz, C4 = 261.63Hz, C2 = 65.41Hz
// MIDI note 36 = C2, note number = 12 * octave + pitchClass
// freq = 440 * 2^((midi - 69) / 12)
const MIN_OCTAVE = 2;
const MAX_OCTAVE = 6; // C2 through B6

// Build a table of [pitchClass, frequency] for all notes we want to check
const noteTable = [];
for (let octave = MIN_OCTAVE; octave <= MAX_OCTAVE; octave++) {
  for (let pc = 0; pc < NUM_CHROMA; pc++) {
    const midi = 12 * (octave + 1) + pc; // C2=36 (octave+1 because MIDI octave -1 starts at 0)
    const freq = 440 * Math.pow(2, (midi - 69) / 12);
    noteTable.push({ pc, freq });
  }
}

const NUM_HARMONICS = 3; // check fundamental + harmonics 2 & 3
const rawChroma = new Float64Array(NUM_CHROMA);

/**
 * Compute chromagram from the existing spectrumDb data.
 * @param {Float32Array} spectrumDb - dB magnitude spectrum (SPECTRUM_BINS long)
 * @param {number} sampleRate - audio sample rate (e.g. 44100)
 * @param {number} fftSize - FFT size (e.g. 8192)
 */
export function updateChromagram(spectrumDb, sampleRate, fftSize) {
  const binHz = sampleRate / fftSize;
  const numBins = SPECTRUM_BINS;
  const nyquist = sampleRate / 2;

  rawChroma.fill(0);

  for (const { pc, freq } of noteTable) {
    for (let h = 1; h <= NUM_HARMONICS; h++) {
      const hFreq = freq * h;
      if (hFreq >= nyquist) break;

      const centerBin = Math.round(hFreq / binHz);
      if (centerBin < 1 || centerBin >= numBins - 1) continue;

      // Search ±2 bins around expected position for peak
      const lo = Math.max(1, centerBin - 2);
      const hi = Math.min(numBins - 1, centerBin + 2);
      let maxDb = -150;
      for (let b = lo; b <= hi; b++) {
        if (spectrumDb[b] > maxDb) maxDb = spectrumDb[b];
      }

      // Convert dB to linear amplitude, then double-sqrt compression (Stark's method)
      // spectrumDb is from getFloatFrequencyData, values typically -150 to 0 dB
      if (maxDb > -100) {
        const amplitude = Math.pow(10, maxDb / 20);
        const compressed = Math.sqrt(Math.sqrt(amplitude));
        rawChroma[pc] += compressed / h;
      }
    }
  }

  // Normalize so max = 1.0
  let maxVal = 0;
  for (let i = 0; i < NUM_CHROMA; i++) {
    if (rawChroma[i] > maxVal) maxVal = rawChroma[i];
  }
  if (maxVal > 1e-8) {
    for (let i = 0; i < NUM_CHROMA; i++) {
      store.chromagram[i] = rawChroma[i] / maxVal;
    }
  } else {
    store.chromagram.fill(0);
  }

  // Asymmetric EMA smoothing (fast attack, moderate release)
  for (let i = 0; i < NUM_CHROMA; i++) {
    const raw = store.chromagram[i];
    const prev = store.chromagramSmooth[i];
    const alpha = raw > prev ? 0.6 : 0.15;
    store.chromagramSmooth[i] = prev + alpha * (raw - prev);
  }
}

export { NOTE_NAMES };
