// Volume / energy strip renderer.
// READS: store.rmsSmooth
// DISPLAY: green gradient strip with energy bar and RMS level line

export const meta = { id: 'energy', label: 'volume', defaultHeight: 0.06, type: 'strip' };

export function render(ctx, x, y, w, h, env) {
  const { store: s, featGain } = env;

  const eNorm = Math.min(1, s.rmsSmooth * featGain);
  const vR = Math.round(20 + eNorm * 40);
  const vG = Math.round(40 + eNorm * 200);
  const vB = Math.round(20 + eNorm * 30);
  ctx.fillStyle = `rgb(${vR},${vG},${vB})`;
  ctx.fillRect(x, y, w, h);

  // Energy bar from bottom
  const barH = Math.round(eNorm * h);
  ctx.fillStyle = `rgba(255,255,255,${eNorm * 0.4})`;
  ctx.fillRect(x, y + h - barH, w, barH);

  // RMS level line
  const rmsY = y + h - Math.round(eNorm * (h - 2)) - 1;
  ctx.fillStyle = 'rgba(255,255,255,0.8)';
  ctx.fillRect(x, rmsY, w, 2);
}
