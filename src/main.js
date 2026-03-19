// Boot sequence: audio engine -> feature store -> scene engine -> visual layers
// + speech recognition (Whisper) and note transcription (Basic Pitch) async init

import { initAudio, getFullAnalyser } from './audio/engine.js';
import { createFilterbank } from './audio/filterbank.js';
import { initPitch } from './audio/pitch.js';
import { initFeatures, updateFeatures } from './audio/features.js';
import { initScene, addLayer, setPreRenderHook, renderLoop } from './scene/engine.js';
import { createSpectrumWall, setSensitivity, setScrollSpeed } from './scene/layers/spectrum-wall.js';
import { initSpeech, feedSpeechAudio } from './audio/speech.js';
import { initTranscription, feedTranscriptionAudio } from './audio/transcribe.js';

const overlay = document.getElementById('overlay');
const startBtn = document.getElementById('start-btn');

startBtn.addEventListener('click', async () => {
  try {
    // 1. Audio pipeline
    const { audioContext, inputGain, fullAnalyser } = await initAudio();
    createFilterbank(audioContext, inputGain);
    initPitch(audioContext.sampleRate);
    initFeatures(fullAnalyser, audioContext.sampleRate);

    // 2. Scene
    initScene();

    // 3. Time-domain buffer for feeding speech/transcription
    const tdBuffer = new Float32Array(fullAnalyser.fftSize);

    // 4. Pre-render hook: extract features + feed speech/transcription
    setPreRenderHook(() => {
      updateFeatures();
      // Feed time-domain data to speech and transcription (every few frames for perf)
      fullAnalyser.getFloatTimeDomainData(tdBuffer);
      feedSpeechAudio(tdBuffer);
      feedTranscriptionAudio(tdBuffer, audioContext.sampleRate);
    });

    // 5. Visual layers
    addLayer(createSpectrumWall());

    // 6. Control sliders
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

    // 7. Go
    renderLoop();
    overlay.classList.add('hidden');

    // 8. Load ML models in background (non-blocking)
    initSpeech(audioContext).catch(e => console.warn('Speech init:', e));
    initTranscription(audioContext).catch(e => console.warn('Transcription init:', e));

  } catch (err) {
    console.error('Failed to start:', err);
    startBtn.textContent = 'error: ' + err.message;
  }
});
