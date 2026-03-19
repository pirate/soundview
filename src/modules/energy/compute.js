// Per-band energy extraction from filterbank analysers.
// READS: filterbank bands (time-domain buffers), store.centerFreqs
// DEPENDS ON: filterbank (must be initialized first)
// WRITES: store.bandEnergy, bandEnergySmooth, bandPeak, bandEnvelopeDelta,
//         bandPeriodicity, bandRoughness, bandHistory, historyIndex,
//         rms, rmsSmooth, overallLoudness, noiseFloor, signalAboveNoise,
//         signalPresent, modulationDepth, modulationRate
// DISPLAY: volume strip — green energy bar with RMS level line

import { NUM_BANDS, HISTORY_LEN, store } from '../../store/feature-store.js';
import { bands } from '../../core/filterbank.js';

const SMOOTH_ATTACK = 0.3;
const SMOOTH_RELEASE = 0.06;
const PEAK_DECAY = 0.97;
const RMS_SMOOTH_ATTACK = 0.25;
const RMS_SMOOTH_RELEASE = 0.04;
const NOISE_FLOOR_ADAPT = 0.002;
const MAX_ACF_LAGS = 32;

// Modulation estimation state
const envelopeHistory = new Float32Array(256); // ~4s at 60fps
let envHistIdx = 0;

// Full-spectrum buffers (set by init, used for RMS)
let fullAnalyser = null;
let fullTimeDomain = null;
let sampleRate = 44100;

export function init(analyser, sr) {
  fullAnalyser = analyser;
  sampleRate = sr;
  fullTimeDomain = new Float32Array(analyser.fftSize);
  store.noiseFloor = 0.01;
}

export function setAnalyser(analyser) {
  fullAnalyser = analyser;
}

export function update() {
  if (!fullAnalyser) return;

  let totalBandEnergy = 0;

  for (let i = 0; i < NUM_BANDS; i++) {
    const band = bands[i];
    if (!band) continue;

    band.analyser.getFloatTimeDomainData(band.timeDomainData);
    const data = band.timeDomainData;

    // RMS energy
    let sum = 0;
    for (let j = 0; j < data.length; j++) sum += data[j] * data[j];
    const rms = Math.sqrt(sum / data.length);
    store.bandEnergy[i] = rms;

    // Asymmetric smoothing
    const prev = store.bandEnergySmooth[i];
    const alpha = rms > prev ? SMOOTH_ATTACK : SMOOTH_RELEASE;
    store.bandEnergySmooth[i] = prev + alpha * (rms - prev);
    store.bandEnvelopeDelta[i] = store.bandEnergySmooth[i] - prev;

    // Peak hold
    store.bandPeak[i] = Math.max(store.bandPeak[i] * PEAK_DECAY, rms);

    // Per-band periodicity (subsampled autocorrelation)
    let maxAcf = 0;
    const minPeriod = Math.max(2, Math.floor(sampleRate / (store.centerFreqs[i] * 1.5)));
    const maxPeriod = Math.min(data.length >> 1, Math.ceil(sampleRate / (store.centerFreqs[i] * 0.667)));
    const lagRange = maxPeriod - minPeriod;
    const lagStep = lagRange > MAX_ACF_LAGS ? Math.ceil(lagRange / MAX_ACF_LAGS) : 1;

    for (let lag = minPeriod; lag < maxPeriod && lag < (data.length >> 1); lag += lagStep) {
      let acf = 0;
      for (let j = 0; j < data.length - lag; j++) acf += data[j] * data[j + lag];
      acf /= (data.length - lag);
      if (acf > maxAcf) maxAcf = acf;
    }
    const bandPower = sum / data.length;
    store.bandPeriodicity[i] = bandPower > 1e-8 ? Math.min(maxAcf / bandPower, 1) : 0;

    // Band roughness (amplitude variance)
    let ampSum = 0, ampSqSum = 0;
    for (let j = 0; j < data.length; j++) {
      const amp = Math.abs(data[j]);
      ampSum += amp;
      ampSqSum += amp * amp;
    }
    const ampMean = ampSum / data.length;
    store.bandRoughness[i] = Math.max(0, ampSqSum / data.length - ampMean * ampMean);

    // History
    store.bandHistory[i][store.historyIndex] = store.bandEnergySmooth[i];
    totalBandEnergy += rms;
  }

  // Full-signal RMS
  fullAnalyser.getFloatTimeDomainData(fullTimeDomain);
  let fullSum = 0;
  for (let i = 0; i < fullTimeDomain.length; i++) fullSum += fullTimeDomain[i] * fullTimeDomain[i];
  store.rms = Math.sqrt(fullSum / fullTimeDomain.length);

  const rmsAlpha = store.rms > store.rmsSmooth ? RMS_SMOOTH_ATTACK : RMS_SMOOTH_RELEASE;
  store.rmsSmooth += rmsAlpha * (store.rms - store.rmsSmooth);
  store.overallLoudness = totalBandEnergy / NUM_BANDS;

  // Noise floor estimation (asymmetric — fast down, very slow up)
  if (store.rms < store.noiseFloor) {
    store.noiseFloor += NOISE_FLOOR_ADAPT * 2 * (store.rms - store.noiseFloor);
  } else {
    store.noiseFloor += NOISE_FLOOR_ADAPT * 0.05 * (store.rms - store.noiseFloor);
  }
  store.noiseFloor = Math.max(store.noiseFloor, 1e-5);
  store.signalAboveNoise = store.rms / (store.noiseFloor + 1e-8);
  store.signalPresent = store.signalAboveNoise > 2.0;

  // Modulation depth + rate (envelope fluctuation over ~1s)
  envelopeHistory[envHistIdx] = store.rmsSmooth;
  envHistIdx = (envHistIdx + 1) % envelopeHistory.length;

  {
    const windowLen = 60;
    let sum = 0, sumSq = 0;
    for (let i = 0; i < windowLen; i++) {
      const idx = (envHistIdx - 1 - i + envelopeHistory.length) % envelopeHistory.length;
      const v = envelopeHistory[idx];
      sum += v;
      sumSq += v * v;
    }
    const mean = sum / windowLen;
    const variance = sumSq / windowLen - mean * mean;
    store.modulationDepth = mean > 1e-6 ? Math.min(Math.sqrt(Math.max(0, variance)) / mean, 1) : 0;
  }

  {
    const windowLen = 60;
    let crossings = 0, prevDelta = 0;
    for (let i = 1; i < windowLen; i++) {
      const idx = (envHistIdx - 1 - i + envelopeHistory.length) % envelopeHistory.length;
      const idxPrev = (idx - 1 + envelopeHistory.length) % envelopeHistory.length;
      const delta = envelopeHistory[idx] - envelopeHistory[idxPrev];
      if (prevDelta !== 0 && ((delta > 0 && prevDelta < 0) || (delta < 0 && prevDelta > 0))) crossings++;
      prevDelta = delta;
    }
    store.modulationRate = crossings * 0.5 * 60;
  }
}

export function reset() {
  store.bandEnergy.fill(0);
  store.bandEnergySmooth.fill(0);
  store.bandPeak.fill(0);
  store.bandEnvelopeDelta.fill(0);
  store.bandPeriodicity.fill(0);
  store.bandRoughness.fill(0);
  store.rms = 0;
  store.rmsSmooth = 0;
  store.noiseFloor = 0.01;
  store.signalPresent = false;
  envelopeHistory.fill(0);
  envHistIdx = 0;
}

// Expose time-domain buffer for other modules (pitch, spectrum)
export function getTimeDomain() { return fullTimeDomain; }
