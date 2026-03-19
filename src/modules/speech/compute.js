// Real-time speech recognition using Whisper via Transformers.js.
// READS: time-domain audio buffer (fed externally via feedAudio)
// DEPENDS ON: nothing (runs async, independent of frame pipeline)
// WRITES: store.speechText, speechWords, speechLoading
// DISPLAY: speech strip — scrolling word display at top of screen

import { pipeline } from '@huggingface/transformers';
import { store } from '../../store/feature-store.js';

let transcriber = null;
let isTranscribing = false;
let audioBuffer = [];
let sampleRate = 16000;
let lastTranscribeTime = 0;
const CHUNK_DURATION = 3;
const MIN_INTERVAL = 2000;

export async function init(audioContext) {
  sampleRate = audioContext.sampleRate;
  store.speechLoading = true;

  try {
    transcriber = await pipeline(
      'automatic-speech-recognition',
      'onnx-community/whisper-tiny.en',
      { dtype: 'q8', device: 'wasm' }
    );
    store.speechLoading = false;
    console.log('Whisper model loaded');
  } catch (err) {
    console.error('Failed to load Whisper model:', err);
    store.speechLoading = false;
  }
}

export function feedAudio(timeDomainData) {
  if (!transcriber) return;

  const step = Math.max(1, Math.round(sampleRate / 16000));
  for (let i = 0; i < timeDomainData.length; i += step) {
    audioBuffer.push(timeDomainData[i]);
  }

  const maxSamples = 16000 * 10;
  if (audioBuffer.length > maxSamples) {
    audioBuffer = audioBuffer.slice(audioBuffer.length - maxSamples);
  }

  const now = performance.now();
  const bufferDuration = audioBuffer.length / 16000;

  if (bufferDuration >= CHUNK_DURATION && !isTranscribing && now - lastTranscribeTime > MIN_INTERVAL) {
    transcribeChunk();
  }
}

async function transcribeChunk() {
  if (isTranscribing || !transcriber) return;
  isTranscribing = true;
  lastTranscribeTime = performance.now();

  const samples = new Float32Array(audioBuffer);
  const overlapSamples = 16000 * 0.5;
  audioBuffer = audioBuffer.slice(Math.max(0, audioBuffer.length - overlapSamples));

  try {
    const result = await transcriber(samples, {
      return_timestamps: 'word',
      chunk_length_s: 5,
      stride_length_s: 1,
    });

    if (result && result.text) {
      const text = result.text.trim();
      if (text && text !== '[BLANK_AUDIO]' && text !== '[ Silence ]' &&
          !text.startsWith('[') && text.length > 0) {
        store.speechText = text;
        if (result.chunks) {
          const now = performance.now();
          store.speechWords = result.chunks
            .filter(c => c.text && c.text.trim().length > 0)
            .map(c => ({ word: c.text.trim(), timestamp: now }));
        }
      }
    }
  } catch (err) {
    console.error('Transcription error:', err);
  }

  isTranscribing = false;
}

export function reset() {
  audioBuffer = [];
  store.speechText = '';
  store.speechWords = [];
}
