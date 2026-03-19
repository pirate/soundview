// Harmonics strip renderer.
// READS: store.harmonicAmplitudes, pitchSmooth, spectrumDb, spectralSlope, signalPresent
// DISPLAY: 32-row grid showing harmonic amplitudes, colored by harmonic number,
//          with brightness from amplitude and attack/decay dynamics

import { SPECTRUM_BINS } from '../../store/feature-store.js';
import { SAMPLE_RATE, FFT_SIZE } from '../../core/colormap.js';

const HARM_ROWS = 32;
const HARM_MAX = 16;
const prevHarmAmps = new Float32Array(HARM_ROWS);
let prevDomY = -1, prevDomRow = -1, domStableFrames = 0;

export const meta = { id: 'harmonics', label: 'harmonics', defaultHeight: 0.14, type: 'strip' };

// Multi-voice pitch detection (subharmonic summation)
const MAX_VOICES = 4;
let _dmpScores = null, _dmpBinHz, _dmpMinBin, _dmpMaxBin;

export function detectMultiPitch(spectrumDb) {
  if (!_dmpScores) {
    _dmpBinHz = SAMPLE_RATE / FFT_SIZE;
    _dmpMinBin = Math.floor(60 / _dmpBinHz);
    _dmpMaxBin = Math.min(Math.floor(2000 / _dmpBinHz), SPECTRUM_BINS - 1);
    _dmpScores = new Float32Array(_dmpMaxBin + 1);
  }
  const binHz = _dmpBinHz, minBin = _dmpMinBin, maxBin = _dmpMaxBin;
  const scores = _dmpScores;
  scores.fill(0);
  for (let b = minBin; b <= maxBin; b++) {
    let sum = 0, count = 0;
    for (let h = 1; h <= 8; h++) {
      const hBin = b * h;
      if (hBin >= SPECTRUM_BINS) break;
      const weight = 1 / h;
      sum += Math.pow(10, spectrumDb[hBin] / 20) * weight;
      count += weight;
    }
    scores[b] = count > 0 ? sum / count : 0;
  }
  const peaks = [];
  for (let b = minBin + 1; b < maxBin; b++) {
    if (scores[b] > scores[b - 1] && scores[b] > scores[b + 1] && scores[b] > 0.0001)
      peaks.push({ bin: b, score: scores[b], freq: b * binHz });
  }
  peaks.sort((a, b) => b.score - a.score);
  const voices = [];
  for (const peak of peaks) {
    if (voices.length >= MAX_VOICES) break;
    let isHarmonic = false;
    for (const v of voices) {
      const r1 = peak.freq / v.freq, n1 = Math.round(r1);
      if (n1 >= 2 && Math.abs(r1 - n1) < 0.08) { isHarmonic = true; break; }
      const r2 = v.freq / peak.freq, n2 = Math.round(r2);
      if (n2 >= 2 && Math.abs(r2 - n2) < 0.08) { isHarmonic = true; break; }
    }
    if (!isHarmonic) voices.push({ freq: peak.freq, strength: peak.score });
  }
  return voices;
}

export function render(ctx, x, y, w, h, env) {
  const { store: s } = env;
  const spectrum = s.spectrumDb;
  const binHz = SAMPLE_RATE / FFT_SIZE;

  let f0 = s.pitchSmooth > 0 ? s.pitchSmooth : 0;
  const voices = s.signalPresent ? detectMultiPitch(spectrum) : [];
  if (f0 === 0 && voices.length > 0) f0 = voices[0].freq;

  let dominantRow = -1, dominantAmp = 0;
  for (let row = 0; row < HARM_ROWS; row++) {
    const hFloat = row / HARM_ROWS * HARM_MAX;
    const hi = Math.min(HARM_MAX - 1, Math.floor(hFloat));
    const hFrac = hFloat - hi;
    const h2 = Math.min(HARM_MAX - 1, hi + 1);

    let amp = s.harmonicAmplitudes[hi] * (1 - hFrac) + s.harmonicAmplitudes[h2] * hFrac;
    if (amp < 1e-6 && f0 > 0) {
      const hFreq1 = f0 * (hi + 1), hFreq2 = f0 * (h2 + 1);
      const bin1 = Math.round(hFreq1 / binHz), bin2 = Math.round(hFreq2 / binHz);
      if (bin1 > 0 && bin1 < SPECTRUM_BINS && bin2 > 0 && bin2 < SPECTRUM_BINS) {
        amp = Math.pow(10, spectrum[bin1] / 20) * (1 - hFrac) + Math.pow(10, spectrum[bin2] / 20) * hFrac;
      }
    }
    const v = amp > 1e-6 ? Math.max(0, Math.min(1, 1 + Math.log10(amp) / 5)) : 0;
    if (amp > dominantAmp && hi > 0) { dominantAmp = amp; dominantRow = row; }

    // Spectral slope hue
    let purity = 0.5;
    if (f0 > 0) {
      const hFreq = f0 * (hFloat + 1);
      const centerBin = Math.round(hFreq / binHz);
      if (centerBin > 5 && centerBin < SPECTRUM_BINS - 5) {
        let noiseSum = 0, noiseCnt = 0;
        for (let nb = -5; nb <= 5; nb++) {
          if (Math.abs(nb) >= 2) { noiseSum += spectrum[centerBin + nb]; noiseCnt++; }
        }
        purity = Math.max(0, Math.min(1, (spectrum[centerBin] - (noiseCnt > 0 ? noiseSum / noiseCnt : spectrum[centerBin])) / 15));
      }
    }

    const delta = amp - prevHarmAmps[row];
    const attackBoost = Math.max(0, delta * 4), decayDim = Math.max(0, -delta * 2);
    prevHarmAmps[row] = amp;

    const hNum = Math.round(hFloat) + 1;
    let baseR, baseG, baseB;
    if (hNum === 1)       { baseR = 255; baseG = 255; baseB = 255; }
    else if (hNum === 2)  { baseR = 60;  baseG = 220; baseB = 240; }
    else if (hNum === 3)  { baseR = 255; baseG = 160; baseB = 40;  }
    else if (hNum === 5 || hNum === 7) { baseR = 255; baseG = 230; baseB = 50; }
    else if (hNum >= 8 && hNum <= 10) { baseR = 230; baseG = 80; baseB = 220; }
    else if (hNum % 2 === 0) { baseR = 80; baseG = 140; baseB = 230; }
    else { baseR = 200; baseG = 170; baseB = 80; }

    let r = Math.round(v * baseR), g = Math.round(v * baseG), b = Math.round(v * baseB);
    const sat = Math.max(0.8, purity);
    const grey = Math.round((r + g + b) / 3);
    r = Math.round(grey + (r - grey) * sat);
    g = Math.round(grey + (g - grey) * sat);
    b = Math.round(grey + (b - grey) * sat);
    const boost = Math.min(1, attackBoost);
    r = Math.max(0, Math.min(255, Math.round(r + boost * (255 - r) * 0.5 - decayDim * r * 0.3)));
    g = Math.max(0, Math.min(255, Math.round(g + boost * (255 - g) * 0.5 - decayDim * g * 0.3)));
    b = Math.max(0, Math.min(255, Math.round(b + boost * (255 - b) * 0.5 - decayDim * b * 0.3)));

    ctx.fillStyle = `rgb(${r},${g},${b})`;
    const yTop = y + Math.round((HARM_ROWS - 1 - row) / HARM_ROWS * h);
    const yBot = y + Math.round((HARM_ROWS - row) / HARM_ROWS * h);
    ctx.fillRect(x, yTop, w, yBot - yTop);
  }

  // Dominant harmonic line
  if (dominantRow >= 0 && dominantAmp > 1e-4) {
    if (Math.abs(dominantRow - prevDomRow) <= 1) domStableFrames++;
    else domStableFrames = 0;
    prevDomRow = dominantRow;
    if (domStableFrames >= 12) {
      const dTop = y + Math.round((HARM_ROWS - 1 - dominantRow) / HARM_ROWS * h);
      const dBot = y + Math.round((HARM_ROWS - dominantRow) / HARM_ROWS * h);
      const dMid = Math.round((dTop + dBot) / 2);
      if (prevDomY >= 0) {
        ctx.fillStyle = 'rgba(255,255,255,0.9)';
        ctx.fillRect(x, Math.min(prevDomY, dMid) - 2, w, Math.abs(dMid - prevDomY) + 5);
      }
      prevDomY = dMid;
    } else { prevDomY = -1; }
  } else { prevDomRow = -1; domStableFrames = 0; prevDomY = -1; }
}
