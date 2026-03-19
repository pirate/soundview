// Real-time speech recognition using Whisper via Transformers.js
// Accumulates audio chunks and transcribes them in the background.

import { pipeline } from '@huggingface/transformers';
import { store } from '../store/feature-store.js';

let transcriber = null;
let isTranscribing = false;
let audioBuffer = [];
let sampleRate = 16000;
let lastTranscribeTime = 0;
const CHUNK_DURATION = 3; // seconds of audio to accumulate before transcribing
const MIN_INTERVAL = 2000; // ms between transcription attempts

// Downsample Float32Array from sourceSR to targetSR
function downsample(buffer, sourceSR, targetSR) {
  if (sourceSR === targetSR) return buffer;
  const ratio = sourceSR / targetSR;
  const newLen = Math.round(buffer.length / ratio);
  const result = new Float32Array(newLen);
  for (let i = 0; i < newLen; i++) {
    const srcIdx = i * ratio;
    const lo = Math.floor(srcIdx);
    const hi = Math.min(lo + 1, buffer.length - 1);
    const frac = srcIdx - lo;
    result[i] = buffer[lo] * (1 - frac) + buffer[hi] * frac;
  }
  return result;
}

export async function initSpeech(audioContext) {
  sampleRate = audioContext.sampleRate;
  store.speechLoading = true;

  try {
    // Use whisper-tiny for speed; runs in-browser via WASM/WebGPU
    transcriber = await pipeline(
      'automatic-speech-recognition',
      'onnx-community/whisper-tiny.en',
      {
        dtype: 'q8',
        device: 'wasm',
      }
    );
    store.speechLoading = false;
    console.log('Whisper model loaded');
  } catch (err) {
    console.error('Failed to load Whisper model:', err);
    store.speechLoading = false;
  }
}

// Call this each frame with time-domain samples from the analyser
export function feedSpeechAudio(timeDomainData) {
  if (!transcriber) return;

  // Accumulate samples (take every Nth sample for rough 16kHz downsampling)
  const step = Math.max(1, Math.round(sampleRate / 16000));
  for (let i = 0; i < timeDomainData.length; i += step) {
    audioBuffer.push(timeDomainData[i]);
  }

  // Limit buffer to ~10 seconds of 16kHz audio
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

  // Take the current buffer
  const samples = new Float32Array(audioBuffer);
  // Keep only the last 0.5s for overlap
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

        // Extract word-level timestamps if available
        if (result.chunks) {
          const now = performance.now();
          store.speechWords = result.chunks
            .filter(c => c.text && c.text.trim().length > 0)
            .map(c => ({
              word: c.text.trim(),
              timestamp: now,
            }));
        }
      }
    }
  } catch (err) {
    console.error('Transcription error:', err);
  }

  isTranscribing = false;
}
