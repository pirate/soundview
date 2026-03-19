// Boot sequence: audio engine → filterbank → compute pipeline → render engine → visual layers
// + speech recognition (Whisper) and note transcription (Basic Pitch) async init

import { initAudio } from './core/audio-engine.js';
import { createFilterbank } from './core/filterbank.js';
import { initPipeline, updatePipeline } from './core/pipeline.js';
import {
  initRenderer, setStrips, setOverlays, setPostStripRenderers, buildLabels, renderLoop,
  setPreRenderHook, setSensitivity, setScrollSpeed,
} from './core/render-engine.js';

// Render modules
import * as speechRender from './modules/speech/render.js';
import * as timbreRender from './modules/timbre/render.js';
import * as chromaRender from './modules/chroma/render.js';
import * as onsetRender from './modules/onset/render.js';
import * as harmonicsRender from './modules/harmonics/render.js';
import * as spectrumRender from './modules/spectrum/render.js';
import * as energyRender from './modules/energy/render.js';
import * as beatRender from './modules/beat/render.js';

// Async ML modules
import { init as initSpeech, feedAudio as feedSpeechAudio } from './modules/speech/compute.js';
import { init as initTranscription, feedAudio as feedTranscriptionAudio } from './modules/transcription/compute.js';

const overlay = document.getElementById('overlay');
const startBtn = document.getElementById('start-btn');

startBtn.addEventListener('click', async () => {
  try {
    // 1. Audio pipeline
    const { audioContext, inputGain, fullAnalyser } = await initAudio();
    createFilterbank(audioContext, inputGain);
    initPipeline(fullAnalyser, audioContext.sampleRate);

    // 2. Render engine
    initRenderer();

    // 3. Strip layout (top to bottom) — reorder these to rearrange the display
    setStrips([
      { id: 'speech',    label: 'speech',     height: 0.05, render: speechRender.render, buildLabels: null },
      { id: 'timbre',    label: 'timbre',     height: 0.07, render: timbreRender.render, buildLabels: null },
      { id: 'chroma',    label: 'notes',      height: 0.10, render: chromaRender.render, buildLabels: null },
      { id: 'onset',     label: 'onset/flux', height: 0.07, render: onsetRender.render, buildLabels: null },
      { id: 'harmonics', label: 'harmonics',  height: 0.14, render: harmonicsRender.render, buildLabels: null },
      { id: 'spectrum',  label: null,          height: 0.50, render: spectrumRender.render, buildLabels: spectrumRender.buildLabels },
      { id: 'energy',    label: 'volume',     height: 0.06, render: energyRender.render, buildLabels: null },
    ]);

    // 4. Post-strip renderers (on scrolling canvas, after all strips — beat columns)
    setPostStripRenderers([
      { render: (ctx, rightX, canvasH, env) => beatRender.renderBeatColumns(ctx, rightX, canvasH, env) },
    ]);

    // 5. Overlays (rendered on top of everything, on the fixed overlay canvas)
    setOverlays([
      { render: (oCtx, env) => beatRender.renderOverlay(oCtx, env) },
      { render: (oCtx, env) => speechRender.renderOverlay(oCtx, env) },
      { render: (oCtx, env) => spectrumRender.renderOverlay(oCtx, env) },
      { render: (oCtx, env) => chromaRender.renderOverlay(oCtx, env) },
      { render: (oCtx, env) => timbreRender.renderOverlay(oCtx, env) },
    ]);

    buildLabels();

    // 6. Time-domain buffer for feeding speech/transcription
    const tdBuffer = new Float32Array(fullAnalyser.fftSize);

    // 7. Pre-render hook: compute pipeline + feed ML models
    setPreRenderHook(() => {
      updatePipeline();
      fullAnalyser.getFloatTimeDomainData(tdBuffer);
      feedSpeechAudio(tdBuffer);
      feedTranscriptionAudio(tdBuffer, audioContext.sampleRate);
    });

    // 8. Control sliders
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

    // 8. Go
    renderLoop();
    overlay.classList.add('hidden');

    // 9. Load ML models in background (non-blocking)
    initSpeech(audioContext).catch(e => console.warn('Speech init:', e));
    initTranscription(audioContext).catch(e => console.warn('Transcription init:', e));

  } catch (err) {
    console.error('Failed to start:', err);
    startBtn.textContent = 'error: ' + err.message;
  }
});
