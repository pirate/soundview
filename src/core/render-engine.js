// Central render loop and strip layout manager.
// Manages two canvas layers (scrolling + overlay), computes strip positions,
// and calls each module's render function with its allocated rectangle.
//
// To reorder strips, rearrange the strips array.
// To toggle a strip off, set enabled: false (remaining strips fill the space).

import { store } from '../store/feature-store.js';

const DPR = Math.min(typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1, 2);

let canvas, ctx, overlay, oCtx;
let CANVAS_W, CANVAS_H, SCROLL_W;
const ARROW_W_FRAC = 0.047; // fraction of width reserved for right-edge arrows

let scrollSpeed = 8;
let featGain = 25;
let sensitivity = -12;
let preRenderHook = null;
let startTime = 0;
let lastTime = 0;
let frameCount = 0;

// Strip layout: each strip has a module render, height fraction, and computed pixel bounds
let strips = [];
let overlayRenderers = [];
let postStripRenderers = []; // render on scrolling canvas after all strips (e.g. beat columns)
let computedLayout = []; // { y, h } per strip, in pixels

export function setSensitivity(db) { sensitivity = db; store._sensitivity = db; }
export function setScrollSpeed(px) { scrollSpeed = Math.max(1, Math.min(20, px)); }
export function setFeatGain(g) { featGain = Math.max(1, Math.min(50, g)); }
export function getScrollSpeed() { return scrollSpeed; }
export function getFeatGain() { return featGain; }
export function getSensitivity() { return sensitivity; }
export function getFrameCount() { return frameCount; }
export function getDPR() { return DPR; }
export function getCanvasSize() { return { w: CANVAS_W, h: CANVAS_H }; }
export function getScrollW() { return SCROLL_W; }
export function getArrowW() { return Math.round(CANVAS_W * ARROW_W_FRAC); }

export function setPreRenderHook(fn) { preRenderHook = fn; }

export function initRenderer() {
  CANVAS_W = Math.round(window.innerWidth * DPR);
  CANVAS_H = Math.round(window.innerHeight * DPR);
  SCROLL_W = CANVAS_W - Math.round(CANVAS_W * ARROW_W_FRAC);

  // Main scrolling canvas
  canvas = document.createElement('canvas');
  canvas.width = CANVAS_W;
  canvas.height = CANVAS_H;
  canvas.id = 'spectrogram';
  document.body.appendChild(canvas);

  ctx = canvas.getContext('2d', { willReadFrequently: false });
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

  // Overlay canvas (doesn't scroll)
  overlay = document.createElement('canvas');
  overlay.width = CANVAS_W;
  overlay.height = CANVAS_H;
  overlay.id = 'spectrogram-overlay';
  overlay.style.cssText = 'position:fixed;top:0;left:0;width:100vw;height:100vh;z-index:1;pointer-events:none';
  document.body.appendChild(overlay);

  oCtx = overlay.getContext('2d');

  startTime = performance.now() / 1000;
  lastTime = startTime;
}

export function setStrips(stripDefs) {
  strips = stripDefs;
  recomputeLayout();
}

export function setOverlays(overlayDefs) {
  overlayRenderers = overlayDefs;
}

export function setPostStripRenderers(defs) {
  postStripRenderers = defs;
}

function recomputeLayout() {
  const enabled = strips.filter(s => s.enabled !== false);
  const totalWeight = enabled.reduce((sum, s) => sum + s.height, 0);

  computedLayout = [];
  let y = 0;
  for (const strip of strips) {
    if (strip.enabled === false) {
      computedLayout.push({ y: 0, h: 0 });
      continue;
    }
    const h = Math.round((strip.height / totalWeight) * CANVAS_H);
    computedLayout.push({ y, h });
    y += h;
  }
  // Adjust last strip to fill remaining pixels
  if (computedLayout.length > 0) {
    const last = computedLayout[computedLayout.length - 1];
    last.h = CANVAS_H - last.y;
  }
}

// Build frequency-axis labels on the left edge
export function buildLabels() {
  const container = document.createElement('div');
  container.id = 'spectrogram-labels';
  document.body.appendChild(container);

  function addLabel(text, topPct, cls) {
    const el = document.createElement('span');
    el.className = `spec-label ${cls || 'feat-label'}`;
    el.textContent = text;
    el.style.top = `${topPct}%`;
    container.appendChild(el);
  }

  for (let i = 0; i < strips.length; i++) {
    if (strips[i].enabled === false) continue;
    const { y, h } = computedLayout[i];
    if (strips[i].label) {
      addLabel(strips[i].label, ((y + h / 2) / CANVAS_H) * 100, 'feat-label');
    }
    // Let strips add their own labels
    if (strips[i].buildLabels) {
      strips[i].buildLabels(addLabel, y, h, CANVAS_H);
    }
  }
}

// Get computed layout for a strip by its id
export function getStripLayout(id) {
  for (let i = 0; i < strips.length; i++) {
    if (strips[i].id === id) return computedLayout[i];
  }
  return null;
}

// Pre-allocated env objects to avoid GC pressure (reused every frame)
const stripEnv = { dt: 0, time: 0, store, scrollSpeed: 0, featGain: 0, sensitivity: 0, frameCount: 0, CANVAS_W: 0, CANVAS_H: 0, SCROLL_W: 0, DPR };
const overlayEnv = { dt: 0, time: 0, store, scrollSpeed: 0, featGain: 0, sensitivity: 0, frameCount: 0, CANVAS_W: 0, CANVAS_H: 0, SCROLL_W: 0, DPR, getStripLayout, computedLayout: null, strips: null };

function updateEnv(dt, time) {
  stripEnv.dt = dt; stripEnv.time = time; stripEnv.store = store;
  stripEnv.scrollSpeed = scrollSpeed; stripEnv.featGain = featGain;
  stripEnv.sensitivity = sensitivity; stripEnv.frameCount = frameCount;
  stripEnv.CANVAS_W = CANVAS_W; stripEnv.CANVAS_H = CANVAS_H; stripEnv.SCROLL_W = SCROLL_W;

  overlayEnv.dt = dt; overlayEnv.time = time; overlayEnv.store = store;
  overlayEnv.scrollSpeed = scrollSpeed; overlayEnv.featGain = featGain;
  overlayEnv.sensitivity = sensitivity; overlayEnv.frameCount = frameCount;
  overlayEnv.CANVAS_W = CANVAS_W; overlayEnv.CANVAS_H = CANVAS_H; overlayEnv.SCROLL_W = SCROLL_W;
  overlayEnv.computedLayout = computedLayout; overlayEnv.strips = strips;
}

export function renderLoop() {
  if (preRenderHook) preRenderHook();

  const now = performance.now() / 1000;
  const dt = now - lastTime;
  lastTime = now;
  const time = now - startTime;
  frameCount++;

  const rightX = SCROLL_W - scrollSpeed;
  updateEnv(dt, time);

  // Scroll canvas left
  ctx.drawImage(canvas, -scrollSpeed, 0);
  ctx.clearRect(rightX, 0, scrollSpeed + Math.round(CANVAS_W * ARROW_W_FRAC), CANVAS_H);

  // Render each strip
  for (let i = 0; i < strips.length; i++) {
    if (strips[i].enabled === false) continue;
    const { y, h } = computedLayout[i];
    if (strips[i].render) {
      strips[i].render(ctx, rightX, y, scrollSpeed, h, stripEnv);
    }
  }

  // Post-strip renderers (on scrolling canvas, after all strips — e.g. beat columns)
  for (const psr of postStripRenderers) {
    if (psr.render) psr.render(ctx, rightX, CANVAS_H, stripEnv);
  }

  // Clear overlay and render overlays
  oCtx.clearRect(0, 0, CANVAS_W, CANVAS_H);
  for (const ov of overlayRenderers) {
    if (ov.render) ov.render(oCtx, overlayEnv);
  }

  requestAnimationFrame(renderLoop);
}
