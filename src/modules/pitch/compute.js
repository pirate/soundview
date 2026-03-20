// Autocorrelation-based pitch detection (simplified YIN).
// READS: time-domain buffer from energy module
// DEPENDS ON: energy (needs time-domain data + signalPresent)
// WRITES: store.pitch, pitchConfidence, pitchSmooth, pitchHistory, pitchHistoryIndex
// DISPLAY: white line overlay on cochleagram at detected fundamental frequency

import { HISTORY_LEN, store } from '../../store/feature-store.js';
import { getTimeDomain } from '../energy/compute.js';
import { ampThreshold } from '../../core/sensitivity.js';

const MIN_FREQ = 60;
const MAX_FREQ = 800;
const PITCH_SMOOTH = 0.6;

let nsdf = null;
let sampleRate = 44100;

export function init(sr) {
  sampleRate = sr;
  const maxLag = Math.ceil(sampleRate / MIN_FREQ);
  nsdf = new Float32Array(maxLag);
}

function detectPitch(buffer) {
  const bufLen = Math.min(buffer.length, 2048);
  const minLag = Math.floor(sampleRate / MAX_FREQ);
  const maxLag = Math.min(Math.ceil(sampleRate / MIN_FREQ), bufLen >> 1);

  if (!nsdf || nsdf.length < maxLag) nsdf = new Float32Array(maxLag);

  // Normalized square difference function (YIN core)
  for (let tau = minLag; tau < maxLag; tau++) {
    let acf = 0, e1 = 0, e2 = 0;
    const len = bufLen - tau;
    for (let i = 0; i < len; i++) {
      acf += buffer[i] * buffer[i + tau];
      e1 += buffer[i] * buffer[i];
      e2 += buffer[i + tau] * buffer[i + tau];
    }
    const denom = e1 + e2;
    nsdf[tau] = denom > 0 ? (2 * acf) / denom : 0;
  }

  // Collect peaks
  const threshold = 0.5;
  const allPeaks = [];
  let inPositive = false, peakLag = 0, peakVal = 0;

  for (let tau = minLag; tau < maxLag - 1; tau++) {
    if (nsdf[tau] > 0) {
      if (!inPositive) { inPositive = true; peakLag = tau; peakVal = nsdf[tau]; }
      if (nsdf[tau] > peakVal) { peakLag = tau; peakVal = nsdf[tau]; }
    } else if (inPositive) {
      if (peakVal > 0.2) allPeaks.push({ lag: peakLag, val: peakVal });
      inPositive = false;
    }
  }
  if (inPositive && peakVal > 0.2) allPeaks.push({ lag: peakLag, val: peakVal });

  // Accept first peak >= threshold * globalBest (YIN key insight)
  let bestLag = 0, bestVal = -1;
  if (allPeaks.length > 0) {
    const globalBest = Math.max(...allPeaks.map(p => p.val));
    const acceptThresh = globalBest * threshold;
    for (const p of allPeaks) {
      if (p.val >= acceptThresh) { bestLag = p.lag; bestVal = p.val; break; }
    }
  }

  if (bestLag === 0 || bestVal < threshold) return { freq: 0, confidence: 0 };

  // Parabolic interpolation for sub-sample accuracy
  const a = nsdf[bestLag - 1] || 0;
  const b = nsdf[bestLag];
  const c = nsdf[bestLag + 1] || 0;
  const shift = (a - c) / (2 * (a - 2 * b + c) || 1);

  return { freq: sampleRate / (bestLag + shift), confidence: Math.min(bestVal, 1) };
}

export function update() {
  const timeDomain = getTimeDomain();
  if (!timeDomain) return;

  const result = detectPitch(timeDomain);

  if (result.confidence > ampThreshold(0.4) && store.signalPresent) {
    store.pitch = result.freq;
    store.pitchConfidence = result.confidence;
  } else {
    store.pitch = 0;
    store.pitchConfidence *= 0.85;
  }

  // Smooth pitch for display
  if (store.pitch > 0 && store.pitchConfidence > ampThreshold(0.3)) {
    if (store.pitchSmooth === 0) {
      store.pitchSmooth = store.pitch;
    } else {
      const ratio = store.pitch / store.pitchSmooth;
      if (ratio > 1.3 || ratio < 0.7) {
        store.pitchSmooth = store.pitch;
      } else {
        store.pitchSmooth += PITCH_SMOOTH * (store.pitch - store.pitchSmooth);
      }
    }
  } else if (store.pitchConfidence < 0.1) {
    store.pitchSmooth = 0;
  }

  store.pitchHistory[store.pitchHistoryIndex] = store.pitchSmooth;
  store.pitchHistoryIndex = (store.pitchHistoryIndex + 1) % HISTORY_LEN;
}

export function reset() {
  store.pitch = 0;
  store.pitchConfidence = 0;
  store.pitchSmooth = 0;
  store.pitchHistory.fill(0);
  store.pitchHistoryIndex = 0;
}
