// Beat renderer: full-height beat columns + BPM text + beat indicator circle.
// READS: store.isBeat, beatShowBeats, beatPhaseAccuracy, beatPulse, bpm
// DISPLAY: semi-transparent colored columns spanning all strips on beat detection,
//          BPM text at top, beat indicator circle (upper-right)

let beatFlash = 0;

// Overlay-only renderer (beats span all strips, not confined to one)
export function renderOverlay(oCtx, env) {
  const { store: s, CANVAS_W, CANVAS_H, DPR, scrollSpeed, SCROLL_W, frameCount } = env;

  if (s.isBeat && s.beatShowBeats) beatFlash = 5;

  // Beat indicator circle (upper-right)
  if (s.beatShowBeats) {
    const ARROW_W = Math.round(CANVAS_W * 0.047);
    const pad = Math.round(16 * DPR), circR = Math.round(14 * DPR);
    const bx = CANVAS_W - ARROW_W / 2, by = pad + circR;
    const pa = s.beatPhaseAccuracy;
    const cR = Math.round(pa < 0.5 ? 255 : 255 * (1 - (pa - 0.5) * 2));
    const cG = Math.round(pa < 0.5 ? pa * 2 * 180 : 80 + 175 * (pa - 0.5) * 2);
    const cB = Math.round(20 * (1 - pa));
    if (s.beatPulse > 0) {
      oCtx.beginPath();
      oCtx.arc(bx, by, Math.round(circR * (0.7 + 0.3 * s.beatPulse)), 0, Math.PI * 2);
      oCtx.fillStyle = `rgba(${cR},${cG},${cB},${s.beatPulse})`;
      oCtx.fill();
    }
  }
}

// Strip-level render: beat column flash on the scrolling canvas
export function renderBeatColumns(ctx, rightX, canvasH, env) {
  const { store: s, scrollSpeed } = env;

  if (!s.beatShowBeats) { beatFlash = 0; return; }
  if (beatFlash <= 0) return;

  beatFlash--;
  const pa = s.beatPhaseAccuracy;
  const bR = Math.round(pa < 0.5 ? 255 : 255 * (1 - (pa - 0.5) * 2));
  const bG = Math.round(pa < 0.5 ? pa * 2 * 180 : 80 + 175 * (pa - 0.5) * 2);
  const bB = Math.round(20 * (1 - pa));
  ctx.fillStyle = `rgba(${bR},${bG},${bB},${(beatFlash / 5) * 0.3})`;
  ctx.fillRect(rightX, 0, scrollSpeed, canvasH);

  if (beatFlash === 4 && s.bpm > 0) {
    const fontSize = Math.round(canvasH * 0.018);
    ctx.font = `bold ${fontSize}px sans-serif`;
    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    ctx.fillText(`${s.bpm}`, rightX - fontSize * 2, fontSize + 4);
  }
}
