// Cochleagram strip renderer + overlays (pitch, formants, centroid, harmonics, rolloff, noise fuzz).
// READS: store.spectrumDb, pitchSmooth, pitchConfidence, formant*Smooth, spectralCentroidSmooth,
//        spectralRolloff, harmonicAmplitudes, harmonicity, bandEnergySmooth, rmsSmooth, signalPresent
// DISPLAY: scrolling spectrogram with piecewise-log frequency scale, plus overlay lines

import { SPECTRUM_BINS, NUM_BANDS, store } from '../../store/feature-store.js';
import { cmapLUT, createFreqMapper, FREQ_LO, FREQ_HI, DB_FLOOR, DB_RANGE, GAMMA, BIN_HZ } from '../../core/colormap.js';
import { detectMultiPitch } from '../harmonics/render.js';

let freqMapper = null;
let colImg = null;
let prevGamma = null, curGamma = null;
let noiseGateSmooth = 0, prevCentroid = 0, centroidStable = 0;
let brightBinAvg = 0, transientCooldown = 0;

const VOICE_COLORS = [[255, 120, 0], [0, 170, 255], [70, 255, 70], [255, 70, 255]];

export const meta = { id: 'spectrum', label: null, defaultHeight: 0.50, type: 'strip' };

export function buildLabels(addLabel, y, h, canvasH) {
  if (!freqMapper) return;
  const freqs = [[50, '50'], [100, '100'], [200, '200'], [500, '500'], [1000, '1k'], [2000, '2k'], [4000, '4k'], [8000, '8k'], [16000, '16k']];
  for (const [hz, text] of freqs) {
    const row = freqMapper.freqToRow(hz);
    const py = y + h - (row + 1);
    addLabel(text, (py / canvasH) * 100, 'freq-label');
  }
}

function freqToCanvasY(freqHz, stripY, stripH) {
  return stripY + stripH - (freqMapper.freqToRow(freqHz) + 1);
}

export function render(ctx, x, y, w, h, env) {
  const { store: s, sensitivity, CANVAS_H } = env;
  const spectrum = s.spectrumDb;

  // Lazy init (needs strip height for freq mapper)
  if (!freqMapper || freqMapper.numRows !== h) {
    freqMapper = createFreqMapper(h);
    colImg = ctx.createImageData(1, h);
    prevGamma = new Float32Array(h);
    curGamma = new Float32Array(h);
  }

  const numRows = h;

  // Compute gamma-corrected column
  curGamma.fill(0);
  for (let r = 0; r < numRows; r++) {
    const bin = Math.min(SPECTRUM_BINS - 1, freqMapper.rowBins[r]);
    const raw = (spectrum[bin] + sensitivity - DB_FLOOR) / DB_RANGE;
    const gated = Math.max(0, raw - 0.08) / 0.92;
    curGamma[r] = Math.pow(Math.min(1, gated), GAMMA);
  }

  // Draw interpolated columns
  for (let px = 0; px < w; px++) {
    const t = w > 1 ? px / (w - 1) : 1;
    const data = colImg.data;
    for (let r = 0; r < numRows; r++) {
      const g = prevGamma[r] + (curGamma[r] - prevGamma[r]) * t;
      const cidx = Math.max(0, Math.min(255, Math.round(g * 255))) * 3;
      const pixIdx = (numRows - r - 1) * 4;
      data[pixIdx] = cmapLUT[cidx];
      data[pixIdx + 1] = cmapLUT[cidx + 1];
      data[pixIdx + 2] = cmapLUT[cidx + 2];
      data[pixIdx + 3] = 255;
    }
    ctx.putImageData(colImg, x + px, y);
  }
  prevGamma.set(curGamma);

  // Overlays on the cochleagram
  if (s.signalPresent) {
    // Pitch fundamental — white line
    if (s.pitchSmooth > FREQ_LO && s.pitchConfidence > 0.15) {
      const py = freqToCanvasY(s.pitchSmooth, y, h);
      const thick = Math.max(2, Math.round(h * 0.003));
      ctx.fillStyle = `rgba(255,255,255,${Math.min(0.95, s.pitchConfidence * 2)})`;
      ctx.fillRect(x, Math.round(py) - Math.floor(thick / 2), w, thick);
    }

    // Formants — green dots
    if (s.formant1Smooth > FREQ_LO) {
      ctx.fillStyle = 'rgba(0,255,80,0.8)';
      ctx.fillRect(x, Math.round(freqToCanvasY(s.formant1Smooth, y, h)) - 1, w, 3);
    }
    if (s.formant2Smooth > FREQ_LO) {
      ctx.fillStyle = 'rgba(0,255,80,0.6)';
      ctx.fillRect(x, Math.round(freqToCanvasY(s.formant2Smooth, y, h)) - 1, w, 3);
    }
    if (s.formant3Smooth > FREQ_LO) {
      ctx.fillStyle = 'rgba(0,255,80,0.4)';
      ctx.fillRect(x, Math.round(freqToCanvasY(s.formant3Smooth, y, h)) - 1, w, 3);
    }

    // Spectral centroid — pink line
    if (s.spectralCentroidSmooth > FREQ_LO && s.rmsSmooth > 0.003) {
      const centroidDelta = prevCentroid > 0
        ? Math.abs(s.spectralCentroidSmooth - prevCentroid) / prevCentroid : 1;
      prevCentroid = s.spectralCentroidSmooth;
      if (centroidDelta < 0.08) centroidStable = Math.min(10, centroidStable + 1);
      else centroidStable = Math.max(0, centroidStable - 2);
      if (centroidStable >= 3) {
        const cy = freqToCanvasY(s.spectralCentroidSmooth, y, h);
        const thick = Math.max(2, Math.round(h * 0.003));
        const fadeIn = Math.min(1, centroidStable / 6);
        ctx.fillStyle = `rgba(255,80,220,${Math.min(0.85, s.rmsSmooth * 40) * fadeIn})`;
        ctx.fillRect(x, Math.round(cy) - Math.floor(thick / 2), w, thick);
      }
    } else { prevCentroid = 0; centroidStable = 0; }

    // Spectral rolloff — cyan line
    if (s.spectralRolloff > FREQ_LO && s.rmsSmooth > 0.005) {
      ctx.fillStyle = 'rgba(0,220,255,0.5)';
      ctx.fillRect(x, Math.round(freqToCanvasY(s.spectralRolloff, y, h)), w, 2);
    }

    // Harmonic series overlay — green dots
    if (s.pitchSmooth > FREQ_LO && s.pitchConfidence > 0.25) {
      for (let hi = 1; hi < 32; hi++) {
        const hFreq = s.pitchSmooth * (hi + 1);
        if (hFreq > FREQ_HI) break;
        if (s.harmonicAmplitudes[hi] < 0.01) continue;
        const hy = freqToCanvasY(hFreq, y, h);
        if (hy < y || hy >= y + h) continue;
        ctx.fillStyle = `rgba(0,255,160,${Math.min(0.7, s.harmonicAmplitudes[hi] * 3)})`;
        ctx.fillRect(x, Math.round(hy), w, 2);
      }
    }
  }

  // Noise fuzz overlay at top
  const noiseGateRaw = Math.max(0, 1 - s.harmonicity * 2 - s.pitchConfidence * 1.5);
  noiseGateSmooth += 0.15 * (noiseGateRaw - noiseGateSmooth);
  let lowE = 0, midE = 0, hiE = 0;
  for (let i = 0; i < NUM_BANDS; i++) {
    const e = s.bandEnergySmooth[i];
    if (i < 7) lowE += e; else if (i < 19) midE += e; else hiE += e;
  }
  const totalE = lowE + midE + hiE;
  if (totalE > 0.001 && noiseGateSmooth > 0.15) {
    const gs = noiseGateSmooth * 6;
    const hiI = Math.min(1, hiE * gs);
    const fuzzRowH = Math.round(h * 0.05);
    if (hiI > 0.05) {
      const n = Math.round(hiI * 40 * w);
      for (let p = 0; p < n; p++) {
        const a = (0.3 + Math.random() * 0.5) * hiI;
        ctx.fillStyle = `rgba(120,230,250,${a})`;
        ctx.fillRect(x + Math.floor(Math.random() * w), y + Math.floor(Math.random() * fuzzRowH), 4, 4);
      }
    }
  }

  // Broadband transient detection
  let brightBins = 0;
  for (let r = 0; r < numRows; r++) { if (curGamma[r] > 0.5) brightBins++; }
  brightBinAvg = brightBinAvg * 0.95 + brightBins * 0.05;
  if (transientCooldown > 0) transientCooldown--;
  if (brightBins > brightBinAvg * 3 && brightBins > numRows * 0.3 && transientCooldown === 0) {
    transientCooldown = 15;
    const dashLen = Math.round(CANVAS_H * 0.008);
    const gapLen = Math.round(CANVAS_H * 0.006);
    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    for (let dy = 0; dy < CANVAS_H; dy += dashLen + gapLen)
      ctx.fillRect(x, dy, 1, Math.min(dashLen, CANVAS_H - dy));
  }
}

// Overlay: voice arrows (right edge)
export function renderOverlay(oCtx, env) {
  const { store: s, CANVAS_W, CANVAS_H, DPR, getStripLayout } = env;
  const layout = getStripLayout('spectrum');
  if (!layout || !freqMapper) return;
  const { y, h } = layout;

  const voices = s.signalPresent ? detectMultiPitch(s.spectrumDb) : [];
  const ARROW_W = Math.round(CANVAS_W * 0.047);
  const fontSize = Math.round(CANVAS_H * 0.01);
  const textZoneW = Math.round(fontSize * 4);
  oCtx.font = `${fontSize}px sans-serif`;
  oCtx.textAlign = 'right';
  oCtx.textBaseline = 'middle';
  const arrowRight = CANVAS_W - textZoneW;

  for (let i = 0; i < voices.length; i++) {
    const v = voices[i];
    if (v.freq > FREQ_LO && v.freq < FREQ_HI) {
      const cy = freqToCanvasY(v.freq, y, h);
      const sz = Math.max(8, Math.round(10 * DPR + v.strength * 3000));
      const alpha = Math.min(0.9, v.strength * 500);
      if (alpha > 0.05) {
        const c = VOICE_COLORS[i];
        const tipX = arrowRight - sz * 1.5, tailX = arrowRight, halfH = sz * 0.6;
        oCtx.beginPath(); oCtx.moveTo(tipX - 3, cy); oCtx.lineTo(tailX, cy - halfH - 3); oCtx.lineTo(tailX, cy + halfH + 3); oCtx.closePath();
        oCtx.fillStyle = `rgba(0,0,0,${alpha})`; oCtx.fill();
        oCtx.beginPath(); oCtx.moveTo(tipX - 1, cy); oCtx.lineTo(tailX, cy - halfH - 1); oCtx.lineTo(tailX, cy + halfH + 1); oCtx.closePath();
        oCtx.fillStyle = `rgba(255,255,255,${alpha})`; oCtx.fill();
        oCtx.beginPath(); oCtx.moveTo(tipX, cy); oCtx.lineTo(tailX, cy - halfH); oCtx.lineTo(tailX, cy + halfH); oCtx.closePath();
        oCtx.fillStyle = `rgba(${c[0]},${c[1]},${c[2]},${alpha})`; oCtx.fill();
        const freqText = v.freq >= 1000 ? `${(v.freq / 1000).toFixed(1)}k` : `${Math.round(v.freq)}`;
        oCtx.fillStyle = `rgba(255,255,255,${alpha * 0.7})`;
        oCtx.fillText(freqText, CANVAS_W - 4, cy);
      }
    }
  }
}
