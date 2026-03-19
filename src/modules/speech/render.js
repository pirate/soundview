// Speech strip renderer.
// READS: store.speechText, speechWords, speechLoading
// DISPLAY: dark strip with scrolling recognized words

let lastSpeechText = '';
let speechDisplayWords = [];

export const meta = { id: 'speech', label: 'speech', defaultHeight: 0.05, type: 'strip' };

export function render(ctx, x, y, w, h, env) {
  const { store: s, frameCount, SCROLL_W, scrollSpeed } = env;

  // Dark background
  ctx.fillStyle = 'rgb(8,8,16)';
  ctx.fillRect(x, y, w, h);

  // Check for new speech text
  if (s.speechText && s.speechText !== lastSpeechText) {
    lastSpeechText = s.speechText;
    const words = s.speechText.split(/\s+/);
    const fontSize = Math.round(h * 0.55);
    for (let i = 0; i < words.length; i++) {
      speechDisplayWords.push({ word: words[i], x: SCROLL_W + i * fontSize * 3, opacity: 1 });
    }
  }

  // Loading indicator
  if (s.speechLoading && frameCount % 120 < 60) {
    ctx.fillStyle = 'rgba(100,100,120,0.5)';
    const dotW = Math.round(h * 0.15);
    for (let i = 0; i < 3; i++) {
      ctx.fillRect(x - dotW * 2 * (i + 1), y + h / 2 - dotW / 2, dotW, dotW);
    }
  }
}

// Overlay: scrolling word display
export function renderOverlay(oCtx, env) {
  const { store: s, SCROLL_W, DPR, scrollSpeed, getStripLayout } = env;
  const layout = getStripLayout('speech');
  if (!layout) return;
  const { y, h } = layout;

  const fontSize = Math.round(h * 0.55);
  oCtx.font = `bold ${fontSize}px sans-serif`;
  oCtx.textAlign = 'left';
  oCtx.textBaseline = 'middle';

  const newWords = [];
  for (const w of speechDisplayWords) {
    w.x -= scrollSpeed;
    if (w.x > -fontSize * 10) {
      const alpha = Math.min(1, Math.max(0.1, 1 - Math.abs(w.x - SCROLL_W / 2) / (SCROLL_W / 2)));
      oCtx.fillStyle = `rgba(220,230,255,${alpha * 0.9})`;
      oCtx.fillText(w.word, w.x, y + h / 2);
      newWords.push(w);
    }
  }
  speechDisplayWords = newWords;

  if (s.speechLoading) {
    oCtx.fillStyle = 'rgba(100,120,150,0.5)';
    oCtx.font = `${Math.round(fontSize * 0.6)}px sans-serif`;
    oCtx.fillText('loading speech model...', 60 * DPR, y + h / 2);
  }
}
