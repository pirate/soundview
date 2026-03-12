// Chromagram computation — maps FFT spectrum to 12 pitch classes.
// Adapted from Adam Stark's Chord-Detector-and-Chromagram.
// Writes directly to store.chromagram / store.chromagramSmooth.

import { store, SPECTRUM_BINS } from '../store/feature-store.js';
import { getSensitivity } from '../scene/layers/spectrum-wall.js';

const NUM_CHROMA = 12;
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

// Build note frequency table: C2 (~65Hz) through B5 (~988Hz)
// This is the fundamental range — we only use 1 harmonic (fundamental)
// to avoid cross-contamination between pitch classes.
// 4 octaves × 12 notes = 48 entries
const MIN_OCTAVE = 2;
const MAX_OCTAVE = 5;

const noteTable = [];
for (let octave = MIN_OCTAVE; octave <= MAX_OCTAVE; octave++) {
  for (let pc = 0; pc < NUM_CHROMA; pc++) {
    const midi = 12 * (octave + 1) + pc;
    const freq = 440 * Math.pow(2, (midi - 69) / 12);
    noteTable.push({ pc, freq });
  }
}

const rawChroma = new Float64Array(NUM_CHROMA);

/**
 * Compute chromagram from the existing spectrumDb data.
 * Uses peak-minus-noise approach: only count energy that sticks above
 * the local spectral noise floor, so broadband noise doesn't wash out
 * the pitch class distinctions.
 */
export function updateChromagram(spectrumDb, sampleRate, fftSize) {
  const binHz = sampleRate / fftSize;
  const numBins = SPECTRUM_BINS;
  // Sensitivity shifts the effective floor: higher sensitivity = detect quieter signals
  const sens = getSensitivity();
  const absFloor = -100 - sens; // bins below this absolute level are ignored

  rawChroma.fill(0);

  for (const { pc, freq } of noteTable) {
    const centerBin = Math.round(freq / binHz);
    if (centerBin < 5 || centerBin >= numBins - 5) continue;

    // Find peak in tight window (±1 bin) around expected note frequency
    let peakDb = -150;
    for (let b = centerBin - 1; b <= centerBin + 1; b++) {
      if (spectrumDb[b] > peakDb) peakDb = spectrumDb[b];
    }

    // Skip bins below effective floor (respects sensitivity slider)
    if (peakDb < absFloor) continue;

    // Estimate local noise floor from nearby non-adjacent bins
    let noiseSum = 0;
    let noiseCnt = 0;
    for (let b = centerBin - 5; b <= centerBin + 5; b++) {
      if (b < 0 || b >= numBins) continue;
      if (Math.abs(b - centerBin) >= 3) {  // skip ±2 bins around peak
        noiseSum += spectrumDb[b];
        noiseCnt++;
      }
    }
    const noiseFloor = noiseCnt > 0 ? noiseSum / noiseCnt : -100;

    // Prominence: how much the peak sticks above the noise floor (in dB)
    const prominence = peakDb - noiseFloor;

    // Only count peaks that are meaningfully above noise
    if (prominence > 3) {  // at least 3 dB above noise
      // Convert prominence to linear scale (preserves relative differences)
      const energy = Math.pow(10, prominence / 20);
      rawChroma[pc] += energy;
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
