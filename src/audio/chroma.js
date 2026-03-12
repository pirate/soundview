// Chromagram computation — maps FFT spectrum to 12 pitch classes.
// Adapted from Adam Stark's Chord-Detector-and-Chromagram.
// Writes directly to store.chromagram / store.chromagramSmooth.

import { store, SPECTRUM_BINS } from '../store/feature-store.js';

const NUM_CHROMA = 12;
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

// Reference: C3 = 130.81 Hz (matches Stark's reference)
const REF_FREQ = 130.81278265;

// Precompute note frequencies for 12 pitch classes (one octave starting at C3)
const noteFrequencies = new Float64Array(NUM_CHROMA);
for (let i = 0; i < NUM_CHROMA; i++) {
  noteFrequencies[i] = REF_FREQ * Math.pow(2, i / 12);
}

// Number of octaves to span above the reference octave
const NUM_OCTAVES = 5; // C3 (~131Hz) through C7 (~4186Hz)
// Number of harmonics to include per note
const NUM_HARMONICS = 2;

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
  // How many bins to search around expected frequency (±2 bins for peak finding)
  const searchRadius = 2;

  rawChroma.fill(0);

  for (let note = 0; note < NUM_CHROMA; note++) {
    for (let octave = 1; octave <= NUM_OCTAVES; octave++) {
      for (let harmonic = 1; harmonic <= NUM_HARMONICS; harmonic++) {
        const freq = noteFrequencies[note] * octave * harmonic;
        const centerBin = Math.round(freq / binHz);

        if (centerBin < 1 || centerBin >= numBins - 1) continue;

        // Find peak magnitude in search window (like Stark's approach)
        const lo = Math.max(1, centerBin - searchRadius * harmonic);
        const hi = Math.min(numBins - 1, centerBin + searchRadius * harmonic);
        let maxDb = -150;
        for (let b = lo; b <= hi; b++) {
          if (spectrumDb[b] > maxDb) maxDb = spectrumDb[b];
        }

        // Convert dB to linear power, then double-sqrt compression (Stark's method)
        const power = Math.pow(10, maxDb / 20);
        const compressed = Math.sqrt(Math.sqrt(power));

        // Weight by 1/harmonic to emphasize fundamentals
        rawChroma[note] += compressed / harmonic;
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

  // Asymmetric EMA smoothing (fast attack, slow release)
  for (let i = 0; i < NUM_CHROMA; i++) {
    const raw = store.chromagram[i];
    const prev = store.chromagramSmooth[i];
    const alpha = raw > prev ? 0.4 : 0.1;
    store.chromagramSmooth[i] = prev + alpha * (raw - prev);
  }
}

export { NOTE_NAMES };
