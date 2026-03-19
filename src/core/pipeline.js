// Compute pipeline: calls all module update() functions in dependency order.
// This replaces the monolithic features.js orchestrator.
//
// Dependency order (hardcoded — no DAG resolver needed):
//   1. energy     — reads filterbank → bandEnergy, RMS, noise floor
//   2. spectrum   — reads fullAnalyser → spectrumDb, spectral descriptors
//   3. pitch      — reads time-domain → pitch, pitchConfidence
//   4. harmonics  — reads pitch + spectrumDb → harmonicAmplitudes
//   5. onset      — reads bandEnergy → onsetStrength, isOnset
//   6. formants   — reads spectrumDb → formants, spectralFlux, soundClass
//   7. beat       — reads spectralFlux → bpm, isBeat
//   8. chroma     — reads spectrumDb → chroma, key, chord
//   9. timbre     — reads spectrumDb + harmonicAmplitudes → mfcc, tristimulus
//  10. modulation — reads bandHistory → bandModulation
//  11. (history index advance)

import { store, HISTORY_LEN } from '../store/feature-store.js';

import * as energy from '../modules/energy/compute.js';
import * as spectrum from '../modules/spectrum/compute.js';
import * as pitch from '../modules/pitch/compute.js';
import * as harmonics from '../modules/harmonics/compute.js';
import * as onset from '../modules/onset/compute.js';
import * as formants from '../modules/formants/compute.js';
import * as beat from '../modules/beat/compute.js';
import * as chroma from '../modules/chroma/compute.js';
import * as timbre from '../modules/timbre/compute.js';
import * as modulation from '../modules/modulation/compute.js';

// All compute modules in dependency order
const modules = [energy, spectrum, pitch, harmonics, onset, formants, beat, chroma, timbre, modulation];

export function initPipeline(analyser, sr) {
  const fftSize = analyser.fftSize;

  energy.init(analyser, sr);
  spectrum.init(analyser, sr);
  pitch.init(sr);
  harmonics.init(sr, fftSize);
  onset.init();
  formants.init(sr, fftSize);
  beat.init();
  chroma.init(sr, fftSize);
  timbre.init(sr, fftSize);
  modulation.init();
}

// Swap the analyser node (used by offline tests)
export function setAnalyser(analyser) {
  energy.setAnalyser(analyser);
  spectrum.setAnalyser(analyser);
}

let silenceFrames = 0;

export function updatePipeline(time) {
  // Run all modules in dependency order
  energy.update();
  spectrum.update();
  pitch.update();
  harmonics.update();
  onset.update();
  formants.update();
  beat.update(time || 0);
  chroma.update();
  timbre.update();

  // Reset key/chord after sustained silence (~2s at 60fps)
  if (!store.signalPresent) {
    silenceFrames++;
    if (silenceFrames > 120) {
      chroma.reset();
    }
  } else {
    silenceFrames = 0;
  }

  // Advance history index
  store.historyIndex = (store.historyIndex + 1) % HISTORY_LEN;

  // Modulation runs after history advance
  modulation.update();
}

export function resetPipeline() {
  for (const m of modules) m.reset();
  silenceFrames = 0;
}
