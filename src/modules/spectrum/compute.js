// Full-spectrum extraction and spectral shape descriptors.
// READS: fullAnalyser (frequency data), store.bandEnergy, store.centerFreqs, store.rmsSmooth
// DEPENDS ON: energy (needs bandEnergy for centroid/spread)
// WRITES: store.spectrumDb, spectralCentroid, spectralCentroidSmooth, spectralSpread,
//         spectralFlatness, spectralSlope, spectralRolloff, noisiness, noiseEnergy, tonalEnergy
// DISPLAY: cochleagram strip — scrolling spectrogram with piecewise-log frequency scale

import { NUM_BANDS, SPECTRUM_BINS, store } from '../../store/feature-store.js';

let fullAnalyser = null;
let fullFreqData = null;
let sampleRate = 44100;

export function init(analyser, sr) {
  fullAnalyser = analyser;
  sampleRate = sr;
  fullFreqData = new Float32Array(analyser.frequencyBinCount);
}

export function setAnalyser(analyser) {
  fullAnalyser = analyser;
}

export function update() {
  if (!fullAnalyser) return;

  fullAnalyser.getFloatFrequencyData(fullFreqData);

  // Copy spectrum (clamp to avoid -Infinity)
  for (let i = 0; i < SPECTRUM_BINS && i < fullFreqData.length; i++) {
    store.spectrumDb[i] = Math.max(-150, fullFreqData[i]);
  }

  // Spectral shape descriptors from power spectrum
  let totalPower = 0, logPowerSum = 0, validBins = 0;
  const freqPerBin = sampleRate / fullAnalyser.fftSize;

  for (let i = 1; i < SPECTRUM_BINS && i < fullFreqData.length; i++) {
    const power = Math.pow(10, fullFreqData[i] / 10);
    totalPower += power;
    if (power > 1e-15) {
      logPowerSum += Math.log(power);
      validBins++;
    }
  }

  // Spectral centroid (from bands for perceptual relevance)
  let totalBandEnergy = 0, weightedFreqSum = 0, weightedFreqSqSum = 0;
  for (let i = 0; i < NUM_BANDS; i++) {
    const e = store.bandEnergy[i];
    totalBandEnergy += e;
    weightedFreqSum += e * store.centerFreqs[i];
    weightedFreqSqSum += e * store.centerFreqs[i] * store.centerFreqs[i];
  }

  store.spectralCentroid = totalBandEnergy > 1e-6 ? weightedFreqSum / totalBandEnergy : 0;

  // Smooth centroid — snap on large jumps
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

  // Spectral spread
  if (totalBandEnergy > 1e-6) {
    const meanFreqSq = weightedFreqSqSum / totalBandEnergy;
    store.spectralSpread = Math.sqrt(Math.max(0, meanFreqSq - store.spectralCentroid * store.spectralCentroid));
  } else {
    store.spectralSpread = 0;
  }

  // Spectral flatness (Wiener entropy)
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
      sumX += i; sumY += fullFreqData[i];
      sumXY += i * fullFreqData[i]; sumXX += i * i;
    }
    store.spectralSlope = (n * sumXY - sumX * sumY) / (n * sumXX - sumX * sumX + 1e-10);
  }

  // Spectral rolloff (85% cumulative energy)
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

  // Noisiness decomposition
  store.noisiness = store.signalPresent ? store.spectralFlatness : 0;
  store.noiseEnergy = store.rmsSmooth * store.noisiness;
  store.tonalEnergy = store.rmsSmooth * (1 - store.noisiness);
}

export function reset() {
  store.spectrumDb.fill(-100);
  store.spectralCentroid = 0;
  store.spectralCentroidSmooth = 0;
}
