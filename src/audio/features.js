// Per-frame feature extraction: energy, spectral shape, pitch, harmonicity,
// modulation, onsets, roughness. Reads from filterbank analysers + full-spectrum analyser.

import { NUM_BANDS, HISTORY_LEN, SPECTRUM_BINS, NUM_MOD_BANDS, store } from '../store/feature-store.js';
import { bands } from './filterbank.js';
import { detectPitch } from './pitch.js';
import { updateModulation } from './modulation.js';
import { initFormants, detectFormants } from './formants.js';
import { initChroma, updateChroma, resetChroma } from './chroma.js';
import { initTimbre, updateTimbre } from './timbre.js';

// ── Smoothing constants ──
const SMOOTH_ATTACK = 0.3;
const SMOOTH_RELEASE = 0.06;
const PEAK_DECAY = 0.97;
const PITCH_SMOOTH = 0.6;
const RMS_SMOOTH_ATTACK = 0.25;
const RMS_SMOOTH_RELEASE = 0.04;
const NOISE_FLOOR_ADAPT = 0.002; // very slow adaptation

// ── Autocorrelation performance cap ──
const MAX_ACF_LAGS = 32;

// ── Onset detection state ──
const prevEnergy = new Float32Array(NUM_BANDS);
let onsetMedian = 0;

// ── Modulation estimation state ──
const envelopeHistory = new Float32Array(256); // ~4s at 60fps
let envHistIdx = 0;

// ── Full-spectrum buffers ──
let fullAnalyser = null;
let fullTimeDomain = null;
let fullFreqData = null;
let sampleRate = 44100;

export function initFeatures(analyser, sr) {
  fullAnalyser = analyser;
  sampleRate = sr;
  fullTimeDomain = new Float32Array(analyser.fftSize);
  fullFreqData = new Float32Array(analyser.frequencyBinCount);

  // Initialize noise floor high so it adapts down
  store.noiseFloor = 0.01;

  initFormants(sr, analyser.fftSize);
  initChroma(sr, analyser.fftSize);
  initTimbre(sr, analyser.fftSize);
}

export function updateFeatures() {
  if (!fullAnalyser) return;

  // ══════════════════════════════════════════════════
  // 1. PER-BAND ENERGY FROM FILTERBANK
  // ══════════════════════════════════════════════════
  let totalBandEnergy = 0;
  let weightedFreqSum = 0;
  let weightedFreqSqSum = 0;

  for (let i = 0; i < NUM_BANDS; i++) {
    const band = bands[i];
    if (!band) continue;

    band.analyser.getFloatTimeDomainData(band.timeDomainData);

    // RMS energy
    let sum = 0;
    const data = band.timeDomainData;
    for (let j = 0; j < data.length; j++) {
      sum += data[j] * data[j];
    }
    const rms = Math.sqrt(sum / data.length);
    store.bandEnergy[i] = rms;

    // Asymmetric smoothing
    const prev = store.bandEnergySmooth[i];
    const alpha = rms > prev ? SMOOTH_ATTACK : SMOOTH_RELEASE;
    store.bandEnergySmooth[i] = prev + alpha * (rms - prev);

    // Envelope delta
    store.bandEnvelopeDelta[i] = store.bandEnergySmooth[i] - prev;

    // Peak hold
    store.bandPeak[i] = Math.max(store.bandPeak[i] * PEAK_DECAY, rms);

    // Per-band periodicity: ratio of peak autocorrelation to energy
    // Subsample the lag range to limit to MAX_ACF_LAGS evaluations
    let maxAcf = 0;
    const minPeriod = Math.max(2, Math.floor(sampleRate / (store.centerFreqs[i] * 1.5)));
    const maxPeriod = Math.min(data.length >> 1, Math.ceil(sampleRate / (store.centerFreqs[i] * 0.667)));
    const lagRange = maxPeriod - minPeriod;
    const lagStep = lagRange > MAX_ACF_LAGS ? Math.ceil(lagRange / MAX_ACF_LAGS) : 1;

    for (let lag = minPeriod; lag < maxPeriod && lag < (data.length >> 1); lag += lagStep) {
      let acf = 0;
      for (let j = 0; j < data.length - lag; j++) {
        acf += data[j] * data[j + lag];
      }
      acf /= (data.length - lag);
      if (acf > maxAcf) maxAcf = acf;
    }
    const bandPower = sum / data.length;
    store.bandPeriodicity[i] = bandPower > 1e-8 ? Math.min(maxAcf / bandPower, 1) : 0;

    // Band roughness: amplitude variance within this band's time-domain buffer
    // Compute instantaneous amplitude envelope (absolute values), then variance
    let ampSum = 0;
    let ampSqSum = 0;
    for (let j = 0; j < data.length; j++) {
      const amp = Math.abs(data[j]);
      ampSum += amp;
      ampSqSum += amp * amp;
    }
    const ampMean = ampSum / data.length;
    const ampVariance = ampSqSum / data.length - ampMean * ampMean;
    store.bandRoughness[i] = Math.max(0, ampVariance);

    // History
    store.bandHistory[i][store.historyIndex] = store.bandEnergySmooth[i];

    totalBandEnergy += rms;
    weightedFreqSum += rms * store.centerFreqs[i];
    weightedFreqSqSum += rms * store.centerFreqs[i] * store.centerFreqs[i];
  }

  // ══════════════════════════════════════════════════
  // 2. FULL-SPECTRUM ANALYSIS
  // ══════════════════════════════════════════════════
  fullAnalyser.getFloatTimeDomainData(fullTimeDomain);
  fullAnalyser.getFloatFrequencyData(fullFreqData);

  // Copy spectrum (clamp to avoid -Infinity → NaN)
  for (let i = 0; i < SPECTRUM_BINS && i < fullFreqData.length; i++) {
    store.spectrumDb[i] = Math.max(-150, fullFreqData[i]);
  }

  // Overall RMS from full signal
  let fullSum = 0;
  for (let i = 0; i < fullTimeDomain.length; i++) {
    fullSum += fullTimeDomain[i] * fullTimeDomain[i];
  }
  store.rms = Math.sqrt(fullSum / fullTimeDomain.length);

  // Smooth RMS
  const rmsAlpha = store.rms > store.rmsSmooth ? RMS_SMOOTH_ATTACK : RMS_SMOOTH_RELEASE;
  store.rmsSmooth += rmsAlpha * (store.rms - store.rmsSmooth);

  store.overallLoudness = totalBandEnergy / NUM_BANDS;

  // ══════════════════════════════════════════════════
  // 3. NOISE FLOOR ESTIMATION
  // ══════════════════════════════════════════════════
  // Slowly adapt toward current RMS (tracks ambient level)
  if (store.rms < store.noiseFloor * 1.5) {
    store.noiseFloor += NOISE_FLOOR_ADAPT * (store.rms - store.noiseFloor);
  } else {
    // Signal is well above noise floor, decay very slowly
    store.noiseFloor *= (1 - NOISE_FLOOR_ADAPT * 0.1);
  }
  store.noiseFloor = Math.max(store.noiseFloor, 1e-5);

  store.signalAboveNoise = store.rms / (store.noiseFloor + 1e-8);
  store.signalPresent = store.signalAboveNoise > 2.0;

  // ══════════════════════════════════════════════════
  // 4. SPECTRAL SHAPE DESCRIPTORS
  // ══════════════════════════════════════════════════
  // Convert dB spectrum to linear power for statistics
  let totalPower = 0;
  let logPowerSum = 0;
  let validBins = 0;
  const freqPerBin = sampleRate / (fullAnalyser.fftSize);

  for (let i = 1; i < SPECTRUM_BINS && i < fullFreqData.length; i++) {
    const dbVal = fullFreqData[i];
    const power = Math.pow(10, dbVal / 10);
    totalPower += power;
    if (power > 1e-15) {
      logPowerSum += Math.log(power);
      validBins++;
    }
  }

  // Spectral centroid (from bands for perceptual relevance)
  store.spectralCentroid = totalBandEnergy > 1e-6 ? weightedFreqSum / totalBandEnergy : 0;

  // Smooth centroid — snap on large jumps, smooth small changes
  if (store.spectralCentroid > 0 && store.signalPresent) {
    if (store.spectralCentroidSmooth === 0) {
      store.spectralCentroidSmooth = store.spectralCentroid;
    } else {
      const ratio = store.spectralCentroid / store.spectralCentroidSmooth;
      if (ratio > 1.3 || ratio < 0.7) {
        store.spectralCentroidSmooth = store.spectralCentroid;
      } else {
        store.spectralCentroidSmooth += 0.6 * (store.spectralCentroid - store.spectralCentroidSmooth);
      }
    }
  } else if (!store.signalPresent) {
    store.spectralCentroidSmooth = 0;
  }

  // Spectral spread (standard deviation around centroid)
  if (totalBandEnergy > 1e-6) {
    const meanFreqSq = weightedFreqSqSum / totalBandEnergy;
    const centroidSq = store.spectralCentroid * store.spectralCentroid;
    store.spectralSpread = Math.sqrt(Math.max(0, meanFreqSq - centroidSq));
  } else {
    store.spectralSpread = 0;
  }

  // Spectral flatness (Wiener entropy): geometric mean / arithmetic mean of power spectrum
  // 1.0 = white noise, 0.0 = pure tone
  if (validBins > 0 && totalPower > 1e-15) {
    const geoMean = Math.exp(logPowerSum / validBins);
    const ariMean = totalPower / validBins;
    store.spectralFlatness = Math.min(geoMean / (ariMean + 1e-15), 1);
  } else {
    store.spectralFlatness = 0;
  }

  // Spectral slope (linear regression of log-magnitude vs frequency)
  if (totalPower > 1e-15) {
    let sumX = 0, sumY = 0, sumXY = 0, sumXX = 0;
    const n = Math.min(SPECTRUM_BINS, fullFreqData.length);
    for (let i = 1; i < n; i++) {
      const x = i;
      const y = fullFreqData[i];
      sumX += x;
      sumY += y;
      sumXY += x * y;
      sumXX += x * x;
    }
    store.spectralSlope = (n * sumXY - sumX * sumY) / (n * sumXX - sumX * sumX + 1e-10);
  }

  // Spectral rolloff (frequency below which 85% of energy lives)
  {
    const target = totalPower * 0.85;
    let cumPower = 0;
    store.spectralRolloff = sampleRate / 2;
    for (let i = 1; i < SPECTRUM_BINS && i < fullFreqData.length; i++) {
      cumPower += Math.pow(10, fullFreqData[i] / 10);
      if (cumPower >= target) {
        store.spectralRolloff = i * freqPerBin;
        break;
      }
    }
  }

  // ══════════════════════════════════════════════════
  // 5. NOISINESS DECOMPOSITION
  // ══════════════════════════════════════════════════
  // Use spectral flatness + signal presence
  store.noisiness = store.signalPresent ? store.spectralFlatness : 0;
  store.noiseEnergy = store.rmsSmooth * store.noisiness;
  store.tonalEnergy = store.rmsSmooth * (1 - store.noisiness);

  // ══════════════════════════════════════════════════
  // 6. PITCH DETECTION
  // ══════════════════════════════════════════════════
  const pitchResult = detectPitch(fullTimeDomain);

  // Debug: log pitch values every 30 frames
  if (typeof detectPitch._dbg === 'undefined') detectPitch._dbg = 0;
  if (++detectPitch._dbg % 30 === 0 && pitchResult.freq > 0) {
    console.log('pitch:', Math.round(pitchResult.freq), 'Hz, conf:', pitchResult.confidence.toFixed(2), 'pitchSmooth:', Math.round(store.pitchSmooth));
  }

  if (pitchResult.confidence > 0.4 && store.signalPresent) {
    store.pitch = pitchResult.freq;
    store.pitchConfidence = pitchResult.confidence;
  } else {
    store.pitch = 0;
    store.pitchConfidence *= 0.85; // decay
  }

  // Smooth pitch for display (only when confident)
  if (store.pitch > 0 && store.pitchConfidence > 0.3) {
    if (store.pitchSmooth === 0) {
      store.pitchSmooth = store.pitch;
    } else {
      // Snap instantly on large jumps (octave/harmonic shifts), smooth small changes
      const ratio = store.pitch / store.pitchSmooth;
      if (ratio > 1.3 || ratio < 0.7) {
        store.pitchSmooth = store.pitch; // snap — no diagonal line
      } else {
        store.pitchSmooth += PITCH_SMOOTH * (store.pitch - store.pitchSmooth);
      }
    }
  } else if (store.pitchConfidence < 0.1) {
    store.pitchSmooth = 0;
  }

  // Pitch history
  store.pitchHistory[store.pitchHistoryIndex] = store.pitchSmooth;
  store.pitchHistoryIndex = (store.pitchHistoryIndex + 1) % HISTORY_LEN;

  // ══════════════════════════════════════════════════
  // 7. HARMONICITY + HARMONIC AMPLITUDES
  // ══════════════════════════════════════════════════
  store.harmonicity = 0;
  store.harmonicAmplitudes.fill(0);

  if (store.pitch > 0 && store.pitchConfidence > 0.3) {
    const f0 = store.pitch;
    let harmonicPower = 0;
    let totalSpecPower = 0;
    const binWidth = freqPerBin;
    const numBins = Math.min(SPECTRUM_BINS, fullFreqData.length);

    // Check each harmonic
    for (let h = 1; h <= 32; h++) {
      const hFreq = f0 * h;
      if (hFreq > sampleRate / 2 - binWidth) break;

      const centerBin = Math.round(hFreq / binWidth);
      const searchRadius = Math.max(1, Math.round(binWidth * 0.5 / binWidth));

      // Find peak near expected harmonic position
      let peakPower = 0;
      for (let b = Math.max(1, centerBin - searchRadius); b <= Math.min(numBins - 1, centerBin + searchRadius); b++) {
        const power = Math.pow(10, fullFreqData[b] / 10);
        if (power > peakPower) peakPower = power;
      }

      store.harmonicAmplitudes[h - 1] = peakPower;
      harmonicPower += peakPower;
    }

    // Total power in the spectrum
    for (let i = 1; i < numBins; i++) {
      totalSpecPower += Math.pow(10, fullFreqData[i] / 10);
    }

    store.harmonicity = totalSpecPower > 1e-15
      ? Math.min(harmonicPower / totalSpecPower, 1)
      : 0;

    // Save raw amplitudes before normalization (for timbre analysis)
    store.harmonicAmplitudesRaw.set(store.harmonicAmplitudes);

    // Normalize harmonic amplitudes relative to fundamental
    const fundAmp = store.harmonicAmplitudes[0];
    if (fundAmp > 1e-15) {
      for (let h = 0; h < 32; h++) {
        store.harmonicAmplitudes[h] = Math.min(store.harmonicAmplitudes[h] / fundAmp, 1);
      }
    }
  }

  // ══════════════════════════════════════════════════
  // 8. MODULATION ESTIMATION
  // ══════════════════════════════════════════════════
  // Track envelope fluctuation depth and approximate rate
  envelopeHistory[envHistIdx] = store.rmsSmooth;
  envHistIdx = (envHistIdx + 1) % envelopeHistory.length;

  // Modulation depth: coefficient of variation over recent window (~1s = 60 frames)
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
    store.modulationDepth = mean > 1e-6 ? Math.sqrt(Math.max(0, variance)) / mean : 0;
    store.modulationDepth = Math.min(store.modulationDepth, 1);
  }

  // Approximate modulation rate: count zero-crossings of envelope derivative
  {
    const windowLen = 60;
    let crossings = 0;
    let prevDelta = 0;
    for (let i = 1; i < windowLen; i++) {
      const idx = (envHistIdx - 1 - i + envelopeHistory.length) % envelopeHistory.length;
      const idxPrev = (idx - 1 + envelopeHistory.length) % envelopeHistory.length;
      const delta = envelopeHistory[idx] - envelopeHistory[idxPrev];
      if (prevDelta !== 0 && ((delta > 0 && prevDelta < 0) || (delta < 0 && prevDelta > 0))) {
        crossings++;
      }
      prevDelta = delta;
    }
    // Each zero-crossing of derivative = half a modulation cycle
    // windowLen frames at 60fps = 1 second
    store.modulationRate = crossings * 0.5 * 60; // Hz (approx)
  }

  // ══════════════════════════════════════════════════
  // 9. ONSET DETECTION
  // ══════════════════════════════════════════════════
  let flux = 0;
  let onsetWeightedFreq = 0;
  let onsetTotalDelta = 0;

  for (let i = 0; i < NUM_BANDS; i++) {
    const diff = store.bandEnergy[i] - prevEnergy[i];
    if (diff > 0) {
      flux += diff;
      onsetWeightedFreq += diff * store.centerFreqs[i];
      onsetTotalDelta += diff;
    }
    prevEnergy[i] = store.bandEnergy[i];
  }

  onsetMedian += 0.02 * (flux - onsetMedian);
  const threshold = onsetMedian * 2.0 + 0.005;

  store.onsetStrength = Math.min(flux / (threshold + 0.001), 1.0);
  store.isOnset = flux > threshold && store.signalPresent;

  if (store.isOnset) {
    store.onsetBrightness = onsetTotalDelta > 1e-6
      ? onsetWeightedFreq / onsetTotalDelta
      : store.spectralCentroid;
    // Onset bandwidth: how many bands had positive flux
    let activeBands = 0;
    for (let i = 0; i < NUM_BANDS; i++) {
      if (store.bandEnergy[i] - prevEnergy[i] > 0.001) activeBands++;
    }
    store.onsetBandwidth = activeBands / NUM_BANDS;
  }

  // ══════════════════════════════════════════════════
  // 10. FORMANT DETECTION + SOUND CLASSIFICATION
  // ══════════════════════════════════════════════════
  detectFormants();

  // ══════════════════════════════════════════════════
  // 11. CHROMA + KEY/CHORD DETECTION
  // ══════════════════════════════════════════════════
  updateChroma();

  // ══════════════════════════════════════════════════
  // 12. TIMBRE DESCRIPTORS (MFCCs, tristimulus, inharmonicity)
  // ══════════════════════════════════════════════════
  updateTimbre();

  // Reset key/chord detector state after sustained silence (~2s at 60fps)
  // so stale detections don't bleed through when signal returns.
  // Brief gaps (common with browser audio) should NOT nuke the accumulator
  // since it takes hundreds of frames to rebuild key detection state.
  if (!store.signalPresent) {
    store._silenceFrames = (store._silenceFrames || 0) + 1;
    if (store._silenceFrames > 120) {
      resetChroma();
      store.detectedKey = '';
      store.detectedKeyConfidence = 0;
    }
    store.detectedChord = '';
    store.detectedChordConfidence = 0;
  } else {
    store._silenceFrames = 0;
  }

  // ══════════════════════════════════════════════════
  // 13. ADVANCE HISTORY INDEX
  // ══════════════════════════════════════════════════
  store.historyIndex = (store.historyIndex + 1) % HISTORY_LEN;

  // ══════════════════════════════════════════════════
  // 14. PER-BAND MODULATION SPECTRUM
  // ══════════════════════════════════════════════════
  updateModulation();
}
