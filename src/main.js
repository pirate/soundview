// Boot sequence: audio engine -> feature store -> scene engine -> visual layers

import { initAudio } from './audio/engine.js';
import { createFilterbank } from './audio/filterbank.js';
import { initPitch } from './audio/pitch.js';
import { initFeatures, updateFeatures } from './audio/features.js';
import { initScene, addLayer, setPreRenderHook, renderLoop } from './scene/engine.js';
import { createSpectrumWall, setSensitivity, setScrollSpeed } from './scene/layers/spectrum-wall.js';

const overlay = document.getElementById('overlay');
const startBtn = document.getElementById('start-btn');

startBtn.addEventListener('click', async () => {
  try {
    // 1. Audio pipeline
    const { audioContext, inputGain, fullAnalyser } = await initAudio();
    createFilterbank(audioContext, inputGain);
    initPitch(audioContext.sampleRate);
    initFeatures(fullAnalyser, audioContext.sampleRate);

    // 2. Scene (no canvas needed — spectrogram creates its own)
    initScene();

    // 3. Pre-render hook: extract audio features each frame
    setPreRenderHook(updateFeatures);

    // 4. Visual layers
    addLayer(createSpectrumWall());

    // 5. Control sliders
    const sensSlider = document.getElementById('sensitivity');
    const sensVal = document.getElementById('sensitivity-val');
    sensSlider.addEventListener('input', () => {
      const v = Number(sensSlider.value);
      setSensitivity(v);
      sensVal.textContent = v;
    });

    const speedSlider = document.getElementById('scroll-speed');
    const speedVal = document.getElementById('scroll-speed-val');
    speedSlider.addEventListener('input', () => {
      const v = Number(speedSlider.value);
      setScrollSpeed(v);
      speedVal.textContent = v;
    });

    // 6. Go
    renderLoop();
    overlay.classList.add('hidden');
  } catch (err) {
    console.error('Failed to start:', err);
    startBtn.textContent = 'error: ' + err.message;
  }
});
