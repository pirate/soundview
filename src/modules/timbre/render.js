// Timbre-over-time strip + timbre space overlay widget.
// READS: store.tristimulus, rmsSmooth, spectralCentroidSmooth, mfcc, inharmonicity, signalPresent
// DISPLAY: scrolling strip colored by tristimulus, centroid line, MFCC[1] line;
//          bottom-left timbre space widget (centroid vs MFCC[1] scatter plot)

import { ampThreshold } from '../../core/sensitivity.js';

const TRAIL_LEN = 120;

// MFCC normalization — fixed range calibrated for typical audio.
// MFCC[1] (spectral tilt) typically ranges from about -30 to +10.
// The sensitivity slider shifts these bounds so the display adapts to the user's level.
const MFCC1_BASE_MIN = -30;
const MFCC1_BASE_MAX = 10;

// Timbre space trail
const timbreTrailX = new Float32Array(TRAIL_LEN);
const timbreTrailY = new Float32Array(TRAIL_LEN);
const timbreTrailR = new Uint8Array(TRAIL_LEN);
const timbreTrailG = new Uint8Array(TRAIL_LEN);
const timbreTrailB = new Uint8Array(TRAIL_LEN);
let trailIdx = 0, trailCount = 0;

export const meta = { id: 'timbre', label: 'timbre', defaultHeight: 0.07, type: 'strip' };

function mfcc1Norm(value, sensitivity) {
  const floor = MFCC1_BASE_MIN + sensitivity;
  const range = MFCC1_BASE_MAX - MFCC1_BASE_MIN;
  return Math.max(0, Math.min(1, (value - floor) / range));
}

export function render(ctx, x, y, w, h, env) {
  const { store: s, featGain, sensitivity } = env;

  const eB = Math.min(1, s.rmsSmooth * featGain * 0.5);
  const tR = Math.round(s.tristimulus[0] * 255 * eB);
  const tG = Math.round(s.tristimulus[1] * 255 * eB);
  const tB = Math.round(s.tristimulus[2] * 255 * eB);
  ctx.fillStyle = `rgb(${tR},${tG},${tB})`;
  ctx.fillRect(x, y, w, h);

  // Spectral centroid white line
  if (s.spectralCentroidSmooth > 0 && s.signalPresent) {
    const centroidNorm = Math.log(Math.max(200, Math.min(8000, s.spectralCentroidSmooth)) / 200) / Math.log(8000 / 200);
    const cy = y + (1 - centroidNorm) * h;
    ctx.fillStyle = 'rgba(255,255,255,0.7)';
    ctx.fillRect(x, Math.round(cy) - 1, w, 2);
  }

  // MFCC[1] line (sensitivity-scaled, no auto-gain)
  if (s.signalPresent) {
    const m1norm = mfcc1Norm(s.mfcc[1], sensitivity);
    const my = y + (1 - m1norm) * h;
    ctx.fillStyle = 'rgba(255,200,100,0.5)';
    ctx.fillRect(x, Math.round(my), w, 2);
  }

  // Inharmonicity indicator
  if (s.inharmonicity > ampThreshold(0.01)) {
    const barH = Math.round(Math.min(1, s.inharmonicity * 8) * h * 0.15);
    ctx.fillStyle = `rgba(255,100,0,${Math.min(0.7, s.inharmonicity * 4)})`;
    ctx.fillRect(x, y, w, barH);
  }
}

// Overlay: timbre space widget (bottom-left)
export function renderOverlay(oCtx, env) {
  const { store: s, CANVAS_W, CANVAS_H, DPR, sensitivity } = env;

  const TIMBRE_SZ = Math.round(Math.min(CANVAS_H * 0.09, CANVAS_W * 0.10));
  const pad = Math.round(8 * DPR);
  const boxX = pad, boxY = CANVAS_H - TIMBRE_SZ - pad;
  const boxW = TIMBRE_SZ, boxH = TIMBRE_SZ;

  oCtx.fillStyle = 'rgba(0,0,0,0.6)';
  oCtx.fillRect(boxX, boxY, boxW, boxH);
  oCtx.strokeStyle = 'rgba(100,100,100,0.5)';
  oCtx.lineWidth = 1;
  oCtx.strokeRect(boxX, boxY, boxW, boxH);

  const cx = boxX + boxW / 2, cy2 = boxY + boxH / 2;
  oCtx.strokeStyle = 'rgba(60,60,60,0.6)';
  oCtx.beginPath();
  oCtx.moveTo(boxX, cy2); oCtx.lineTo(boxX + boxW, cy2);
  oCtx.moveTo(cx, boxY); oCtx.lineTo(cx, boxY + boxH);
  oCtx.stroke();

  // Map timbre position using sensitivity-scaled normalization (no auto-gain)
  const centroidLog = s.spectralCentroidSmooth > 0
    ? Math.log(Math.max(200, Math.min(8000, s.spectralCentroidSmooth)) / 200) / Math.log(8000 / 200)
    : 0.5;
  const m1norm = mfcc1Norm(s.mfcc[1], sensitivity);
  const dotX = boxX + centroidLog * boxW;
  const dotY = boxY + (1 - m1norm) * boxH;

  if (s.signalPresent && s.rmsSmooth > ampThreshold(0.003)) {
    timbreTrailX[trailIdx] = dotX; timbreTrailY[trailIdx] = dotY;
    timbreTrailR[trailIdx] = Math.round(s.tristimulus[0] * 255);
    timbreTrailG[trailIdx] = Math.round(s.tristimulus[1] * 255);
    timbreTrailB[trailIdx] = Math.round(s.tristimulus[2] * 255);
    trailIdx = (trailIdx + 1) % TRAIL_LEN;
    if (trailCount < TRAIL_LEN) trailCount++;
  }

  for (let i = 0; i < trailCount; i++) {
    const idx = (trailIdx - 1 - i + TRAIL_LEN) % TRAIL_LEN;
    const age = i / TRAIL_LEN;
    const alpha = (1 - age) * 0.4;
    if (alpha < 0.02) continue;
    oCtx.fillStyle = `rgba(${timbreTrailR[idx]},${timbreTrailG[idx]},${timbreTrailB[idx]},${alpha})`;
    const sz = Math.max(2, Math.round(3 * DPR * (1 - age * 0.5)));
    oCtx.fillRect(timbreTrailX[idx] - sz / 2, timbreTrailY[idx] - sz / 2, sz, sz);
  }

  if (s.signalPresent && s.rmsSmooth > ampThreshold(0.003)) {
    const tR = Math.min(255, Math.round(s.tristimulus[0] * 300 + 60));
    const tG = Math.min(255, Math.round(s.tristimulus[1] * 300 + 60));
    const tB = Math.min(255, Math.round(s.tristimulus[2] * 300 + 60));
    const dotSz = Math.round(5 * DPR);
    oCtx.fillStyle = 'rgba(255,255,255,0.9)';
    oCtx.fillRect(dotX - dotSz / 2 - 1, dotY - dotSz / 2 - 1, dotSz + 2, dotSz + 2);
    oCtx.fillStyle = `rgb(${tR},${tG},${tB})`;
    oCtx.fillRect(dotX - dotSz / 2, dotY - dotSz / 2, dotSz, dotSz);
  }

  const lblSz = Math.round(CANVAS_H * 0.008);
  oCtx.font = `${lblSz}px sans-serif`;
  oCtx.textAlign = 'left'; oCtx.textBaseline = 'bottom';
  oCtx.fillStyle = 'rgba(180,180,180,0.6)';
  oCtx.fillText('bright →', boxX + 2, boxY + boxH - 2);
  oCtx.save();
  oCtx.translate(boxX + lblSz, boxY + boxH - lblSz);
  oCtx.rotate(-Math.PI / 2);
  oCtx.fillText('warm →', 0, 0);
  oCtx.restore();

  if (s.inharmonicity > ampThreshold(0.001)) {
    const barW = Math.round(Math.min(1, s.inharmonicity * 10) * boxW);
    oCtx.fillStyle = `rgba(255,160,40,${Math.min(0.8, s.inharmonicity * 5)})`;
    oCtx.fillRect(boxX, boxY + boxH - 3, barW, 3);
  }
}
