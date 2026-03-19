// Onset/flux strip renderer.
// READS: store.rmsSmooth, spectralSpread, spectralFlux, isOnset
// DISPLAY: colored strip (spread→hue), white flux line, black flux derivative, onset markers

let prevFluxY = -1, prevDerivY = -1, prevFlux = 0;

export const meta = { id: 'onset', label: 'onset/flux', defaultHeight: 0.07, type: 'strip' };

export function render(ctx, x, y, w, h, env) {
  const { store: s, featGain } = env;

  const eB = Math.min(s.rmsSmooth * featGain, 1);
  const sprdLog = s.spectralSpread > 10
    ? Math.log(s.spectralSpread / 10) / Math.log(4000 / 10) : 0;
  const sprdV = Math.max(0, Math.min(1, sprdLog));

  let esR, esG, esB;
  if (sprdV < 0.33) {
    const t = sprdV / 0.33;
    esR = 30 * (1 - t); esG = 80 + t * 175; esB = 200 * (1 - t) + t * 80;
  } else if (sprdV < 0.66) {
    const t = (sprdV - 0.33) / 0.33;
    esR = t * 230; esG = 255 - t * 30; esB = 80 * (1 - t);
  } else {
    const t = (sprdV - 0.66) / 0.34;
    esR = 230 + t * 25; esG = 225 * (1 - t) + t * 50; esB = t * 30;
  }
  ctx.fillStyle = `rgb(${Math.round(esR * eB)},${Math.round(esG * eB)},${Math.round(esB * eB)})`;
  ctx.fillRect(x, y, w, h);

  // Flux line (white)
  const fluxRaw = Math.min(1, s.spectralFlux * 0.3);
  const fluxYPos = y + h - 2 - Math.round(fluxRaw * (h - 4));
  if (prevFluxY >= 0) {
    const yMin = Math.min(prevFluxY, fluxYPos) - 2;
    const yMax = Math.max(prevFluxY, fluxYPos) + 4;
    ctx.fillStyle = `rgba(255,255,255,${Math.min(0.9, Math.max(fluxRaw, 0.15) * 3)})`;
    ctx.fillRect(x, yMin, w, yMax - yMin);
  }
  prevFluxY = fluxYPos;

  // Flux derivative (dark line)
  const fluxDeriv = s.spectralFlux - prevFlux;
  prevFlux = s.spectralFlux;
  const derivAbs = Math.min(1, Math.abs(fluxDeriv) * 0.8);
  const mid = y + Math.round(h / 2);
  const derivY = fluxDeriv > 0
    ? mid - Math.round(derivAbs * (h / 2 - 2))
    : mid + Math.round(derivAbs * (h / 2 - 2));
  if (prevDerivY >= 0) {
    const yMin = Math.min(prevDerivY, derivY) - 2;
    const yMax = Math.max(prevDerivY, derivY) + 4;
    ctx.fillStyle = `rgba(0,0,0,${Math.min(0.9, Math.max(derivAbs, 0.15) * 3)})`;
    ctx.fillRect(x, yMin, w, yMax - yMin);
  }
  prevDerivY = derivY;

  // Onset markers
  if (s.isOnset) {
    ctx.fillStyle = 'rgba(255,255,255,0.6)';
    ctx.fillRect(x, y, w, 3);
    ctx.fillRect(x, y + h - 3, w, 3);
  }
}
