// Real-time music note transcription using Spotify's Basic Pitch.
// Processes audio chunks and outputs MIDI note events.

import { BasicPitch, noteFramesToTime, addPitchBendsToNoteEvents, outputToNotesPoly } from '@spotify/basic-pitch';
import { store } from '../store/feature-store.js';

let basicPitch = null;
let audioContext = null;
let isProcessing = false;
let audioChunks = [];
let lastProcessTime = 0;
const CHUNK_DURATION = 2; // seconds between processing
const MIN_INTERVAL = 1500;

export async function initTranscription(ctx) {
  audioContext = ctx;
  store.transcriptionLoading = true;

  try {
    basicPitch = new BasicPitch('/basic-pitch-model/');
    store.transcriptionLoading = false;
    console.log('Basic Pitch model loaded');
  } catch (err) {
    // Basic Pitch may need a model URL or bundled model
    console.warn('Basic Pitch init (will retry on first use):', err.message);
    store.transcriptionLoading = false;
  }
}

// Feed audio samples each frame
export function feedTranscriptionAudio(timeDomainData, sampleRate) {
  if (!basicPitch) return;

  // Accumulate raw samples
  audioChunks.push(new Float32Array(timeDomainData));

  // Calculate total duration
  let totalSamples = 0;
  for (const chunk of audioChunks) totalSamples += chunk.length;
  const duration = totalSamples / sampleRate;

  const now = performance.now();
  if (duration >= CHUNK_DURATION && !isProcessing && now - lastProcessTime > MIN_INTERVAL) {
    processChunk(sampleRate);
  }

  // Limit accumulation
  if (duration > 10) {
    const keepSamples = sampleRate * 5;
    let keep = 0;
    let startIdx = audioChunks.length - 1;
    for (let i = audioChunks.length - 1; i >= 0; i--) {
      keep += audioChunks[i].length;
      startIdx = i;
      if (keep >= keepSamples) break;
    }
    audioChunks = audioChunks.slice(startIdx);
  }
}

async function processChunk(sampleRate) {
  if (isProcessing || !basicPitch) return;
  isProcessing = true;
  lastProcessTime = performance.now();

  // Concatenate chunks
  let totalLen = 0;
  for (const c of audioChunks) totalLen += c.length;
  const combined = new Float32Array(totalLen);
  let offset = 0;
  for (const c of audioChunks) {
    combined.set(c, offset);
    offset += c.length;
  }

  // Keep 0.5s overlap
  const overlapSamples = sampleRate * 0.5;
  const lastChunks = [];
  let kept = 0;
  for (let i = audioChunks.length - 1; i >= 0 && kept < overlapSamples; i--) {
    lastChunks.unshift(audioChunks[i]);
    kept += audioChunks[i].length;
  }
  audioChunks = lastChunks;

  try {
    // Create an offline audio context to resample to 22050Hz (Basic Pitch requirement)
    const targetSR = 22050;
    const offlineCtx = new OfflineAudioContext(1, Math.ceil(combined.length * targetSR / sampleRate), targetSR);
    const buffer = offlineCtx.createBuffer(1, combined.length, sampleRate);
    buffer.getChannelData(0).set(combined);
    const source = offlineCtx.createBufferSource();
    source.buffer = buffer;
    source.connect(offlineCtx.destination);
    source.start();
    const rendered = await offlineCtx.startRendering();
    const resampled = rendered.getChannelData(0);

    // Run Basic Pitch
    const frames = [];
    const onsets = [];
    const contours = [];
    await basicPitch.evaluateModel(resampled, (f, o, c) => {
      frames.push(...f);
      onsets.push(...o);
      contours.push(...c);
    }, (pct) => {});

    const notes = noteFramesToTime(frames, onsets, contours);
    const notesWithBends = addPitchBendsToNoteEvents(contours, notes);
    const polyNotes = outputToNotesPoly(frames, onsets, contours, 0.5, 0.3, 5);

    // Update store with active notes
    const now = performance.now();
    store.activeNotes = polyNotes.map(n => ({
      pitchMidi: n.pitchMidi,
      startTime: now - (combined.length / sampleRate - n.startTimeSeconds) * 1000,
      endTime: n.endTimeSeconds ? now - (combined.length / sampleRate - n.endTimeSeconds) * 1000 : null,
      amplitude: n.amplitude || 0.8,
    }));

    // Keep recent note events for the score strip (last 10 seconds)
    store.noteEvents = store.activeNotes.filter(n => now - n.startTime < 10000);

  } catch (err) {
    console.error('Transcription processing error:', err);
  }

  isProcessing = false;
}
