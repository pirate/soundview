// Central sensitivity scaling for all modules.
//
// The sensitivity slider is a dB offset (default -12, range -12 to +40).
// Higher values = more sensitive = detect quieter signals.
// All modules use these helpers instead of hardcoding thresholds.
//
// Usage:
//   import { ampThreshold, dbFloor, snrThreshold } from '../../core/sensitivity.js';
//   if (rms > ampThreshold(0.003)) { /* signal present */ }
//   if (spectrumDb[i] < dbFloor(-90)) continue; /* noise gate */

import { store } from '../store/feature-store.js';

// The default sensitivity is -12 dB. All base thresholds are calibrated for this.
const DEFAULT_SENS = -12;

// Linear gain factor relative to default sensitivity.
// At -12 dB (default): 1.0
// At  0 dB: ~4.0 (4× more sensitive)
// At +40 dB: ~180× more sensitive
function gainFactor() {
  return Math.pow(10, (store._sensitivity - DEFAULT_SENS) / 20);
}

// Scale an amplitude threshold inversely with sensitivity.
// Higher sensitivity → lower threshold → detects quieter signals.
// Base values are calibrated for the default -12 dB setting.
export function ampThreshold(base) {
  return base / gainFactor();
}

// Shift a dB floor by the sensitivity offset.
// Higher sensitivity → lower floor → includes quieter bins.
export function dbFloor(base) {
  return base - (store._sensitivity - DEFAULT_SENS);
}

// Scale an SNR threshold inversely with sensitivity.
// Higher sensitivity → lower required SNR → triggers on quieter signals.
export function snrThreshold(base) {
  return base / Math.sqrt(gainFactor());
}

// Return the raw sensitivity dB value (for modules that need it directly).
export function sensitivityDb() {
  return store._sensitivity;
}
