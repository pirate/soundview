// Minimal render loop — no Three.js, just drives 2D canvas layers.

import { store } from '../store/feature-store.js';

let layers = [];
let preRenderHook = null;
let startTime = 0;
let lastTime = 0;

export function setPreRenderHook(fn) {
  preRenderHook = fn;
}

export function initScene() {
  startTime = performance.now() / 1000;
  lastTime = startTime;
}

export function addLayer(layer) {
  layers.push(layer);
}

export function renderLoop() {
  if (preRenderHook) preRenderHook();

  const now = performance.now() / 1000;
  const dt = now - lastTime;
  lastTime = now;
  const time = now - startTime;

  for (const layer of layers) {
    layer.update(store, dt, time);
  }

  requestAnimationFrame(renderLoop);
}
