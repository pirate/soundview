// Offline audio analysis test harness.
// Uses node-web-audio-api to run the EXACT same code path as the browser.
// No mocks, no polyfills, no separate offline implementations.
// Audio is fed through OfflineAudioContext → AnalyserNode → the real features pipeline.

import { readFileSync, existsSync } from 'fs';
import { execSync } from 'child_process';
import { OfflineAudioContext } from 'node-web-audio-api';

// ── Import the real modules (same ones the browser uses) ──
import { store } from '../src/store/feature-store.js';
import { initPipeline, setAnalyser, updatePipeline } from '../src/core/pipeline.js';
import { createFilterbank } from '../src/core/filterbank.js';

const SR = 44100;
const FFT_SIZE = 8192;

async function analyzeFile(audioPath, label) {
  console.log(`\n${'═'.repeat(60)}`);
  console.log(label);
  console.log('═'.repeat(60));

  const rawPath = audioPath.replace(/\.mp3$/, '.raw');
  if (!existsSync(rawPath)) {
    execSync(`ffmpeg -y -i "${audioPath}" -f f32le -acodec pcm_f32le -ar ${SR} -ac 1 "${rawPath}" 2>/dev/null`);
  }
  const raw = readFileSync(rawPath);
  const samples = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
  const duration = samples.length / SR;
  console.log(`  ${duration.toFixed(1)}s, ${samples.length} samples`);

  const HOP = 2048;
  const numFrames = Math.floor((samples.length - FFT_SIZE) / HOP);
  console.log(`  Processing ${numFrames} frames (HOP=${HOP})...`);

  // Reset store
  store.spectrumDb.fill(-100);
  store.chroma.fill(0);
  store.bandEnergy.fill(0);
  store.bandEnergySmooth.fill(0);
  store.bandPeak.fill(0);
  store.bandEnvelopeDelta.fill(0);
  store.bandPeriodicity.fill(0);
  store.bandRoughness.fill(0);
  store.detectedKey = '';
  store.detectedKeyConfidence = 0;
  store.detectedChord = '';
  store.detectedChordConfidence = 0;
  store.rms = 0;
  store.rmsSmooth = 0;
  store.noiseFloor = 0.01;
  store.signalPresent = false;
  store.pitch = 0;
  store.pitchSmooth = 0;
  store.pitchConfidence = 0;
  store.harmonicAmplitudes.fill(0);
  store.harmonicAmplitudesRaw.fill(0);
  store.mfcc.fill(0);
  store.tristimulus.fill(0);
  store.inharmonicity = 0;
  store.spectralFlux = 0;
  store.spectralFluxSmooth = 0;
  store.historyIndex = 0;
  store.bpm = 0;
  store.beatPhaseAccuracy = 0;

  const chordLog = [];
  const noteLog = [];
  let frameCount = 0;

  for (let frame = 0; frame < numFrames; frame++) {
    const offset = frame * HOP;

    const ctx = new OfflineAudioContext(1, FFT_SIZE, SR);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = FFT_SIZE;
    analyser.smoothingTimeConstant = 0;

    if (frame === 0) {
      const inputGain = ctx.createGain();
      inputGain.gain.value = 1.0;

      const buf = ctx.createBuffer(1, FFT_SIZE, SR);
      buf.copyToChannel(samples.subarray(offset, offset + FFT_SIZE), 0);
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(inputGain);
      inputGain.connect(analyser);
      analyser.connect(ctx.destination);

      createFilterbank(ctx, inputGain);
      initPipeline(analyser, SR);

      src.start();
      await ctx.startRendering();
    } else {
      const buf = ctx.createBuffer(1, FFT_SIZE, SR);
      buf.copyToChannel(samples.subarray(offset, offset + FFT_SIZE), 0);
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(analyser);
      analyser.connect(ctx.destination);
      src.start();
      await ctx.startRendering();
    }

    setAnalyser(analyser);
    updatePipeline();
    frameCount++;

    const sec = offset / SR;

    if (frameCount % 10 === 0) {
      chordLog.push({
        sec: Math.round(sec * 10) / 10,
        chord: store.detectedChord,
        conf: store.detectedChordConfidence,
      });
    }

    if (frameCount % 40 === 0) {
      const NOTE_NAMES = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
      const activePCs = [];
      for (let i = 0; i < 12; i++) {
        if (store.chroma[i] > 0.15) activePCs.push(NOTE_NAMES[i]);
      }
      noteLog.push({ sec: Math.round(sec), pcs: activePCs });
    }
  }

  console.log(`  Processed ${frameCount} frames`);

  console.log(`\n  Key: ${store.detectedKey} (conf: ${store.detectedKeyConfidence.toFixed(3)})`);
  console.log(`  BPM: ${store.bpm}`);

  // Chord timeline
  console.log('\n  Chord timeline:');
  const totalSec = Math.floor(duration);
  for (let t = 0; t < totalSec; t += 5) {
    const window = chordLog.filter(c => c.sec >= t && c.sec < t + 5 && c.chord);
    if (!window.length) continue;
    const counts = {};
    for (const c of window) counts[c.chord] = (counts[c.chord] || 0) + 1;
    const top = Object.entries(counts).sort((a, b) => b[1] - a[1]);
    const m = Math.floor(t / 60), s = t % 60;
    console.log(`    ${m}:${String(s).padStart(2, '0')}  ${top.map(([c, n]) => `${c}(${n})`).join(' ')}`);
  }

  // Note activity
  console.log('\n  Active pitch classes (sampled):');
  for (const entry of noteLog.filter((_, i) => i % 2 === 0).slice(0, 15)) {
    if (entry.pcs.length > 0) {
      const m = Math.floor(entry.sec / 60), s = entry.sec % 60;
      console.log(`    ${m}:${String(s).padStart(2, '0')}  ${entry.pcs.join(' ')}`);
    }
  }

  return {
    key: store.detectedKey,
    keyConf: store.detectedKeyConfidence,
    bpm: store.bpm,
    chordLog,
    noteLog,
  };
}

// ══════════════════════════════════════════════════════════════
// Test definitions
// ══════════════════════════════════════════════════════════════
const TESTS = [
  {
    url: 'https://cdn.pixabay.com/download/audio/2025/11/21/audio_2621422ac3.mp3?filename=mountaindweller-waltz-of-the-flowers-tchaikovsky-excerpt-440339.mp3',
    file: 'test/waltz.mp3',
    label: 'WALTZ OF THE FLOWERS (expect: D major)',
    expectKey: 'D maj',
    expectBpm: 180,
    bpmTolerance: 30,
    inKeyChords: new Set(['D', 'G', 'A', 'Bm', 'Em', 'F#m', 'A7', 'D7', 'E', 'Am', 'C', 'F#7',
      'Em7', 'F#m7', 'Am7', 'Gsus4', 'Dsus4', 'Asus4']),
    expectScale: new Set(['D', 'E', 'F#', 'G', 'A', 'B', 'C#']),
  },
  {
    url: 'https://cdn.pixabay.com/download/audio/2025/09/27/audio_6813e09c43.mp3?filename=saturn-3-music-claire-de-lune-debussy-piano-411227.mp3',
    file: 'test/claire.mp3',
    label: 'CLAIRE DE LUNE (expect: C#/Db major)',
    expectKey: 'C# maj',
    expectBpm: 73.5,
    bpmTolerance: 15,
    inKeyChords: new Set(['C#', 'G#', 'A#m', 'F#', 'D#m', 'G#7', 'Fm', 'C#7', 'F#m',
      'D#m7', 'Fm7', 'A#m7', 'C#sus4', 'G#sus4', 'D#sus4', 'A#sus4', 'F#m7']),
    expectScale: new Set(['C#', 'D#', 'F', 'F#', 'G#', 'A#', 'C']),
  },
  {
    url: null,
    file: 'test/maple-leaf.mp3',
    label: 'MAPLE LEAF RAG (expect: G# maj = Ab major)',
    expectKey: 'G# maj',
    expectBpm: 92,
    bpmTolerance: 15,
    inKeyChords: new Set(['G#', 'A#m', 'C#', 'D#', 'Fm', 'D#7', 'G#7', 'C#7',
      'Cm', 'Cdim', 'D#m', 'F#', 'A#m7', 'Fm7', 'G#sus4', 'D#sus4',
      'C#sus4', 'F', 'A#', 'Gm', 'Bdim']),
    expectScale: new Set(['G#', 'A#', 'C', 'C#', 'D#', 'F', 'G']),
  },
];

// Download test files if needed
execSync('mkdir -p test');
for (const t of TESTS) {
  if (!existsSync(t.file) && t.url) {
    console.log(`Downloading ${t.file}...`);
    execSync(`curl -L -o "${t.file}" "${t.url}" 2>/dev/null`);
  }
}

// Run analysis
const results = [];
for (const t of TESTS) {
  const r = await analyzeFile(t.file, t.label);
  results.push({ ...t, ...r });
}

// ══════════════════════════════════════════════════════════════
// Verification
// ══════════════════════════════════════════════════════════════
console.log('\n' + '═'.repeat(60));
console.log('VERIFICATION');
console.log('═'.repeat(60));

let allPass = true;

for (const r of results) {
  console.log(`\n  ${r.label.split('(')[0].trim()}:`);

  const keyPass = r.key === r.expectKey;
  console.log(`    Key: ${r.key} ${keyPass ? '✓' : '✗ (expected ' + r.expectKey + ')'}`);
  if (!keyPass) allPass = false;

  if (r.expectBpm) {
    const bpmErr = Math.abs(r.bpm - r.expectBpm);
    const halfErr = Math.abs(r.bpm - r.expectBpm / 2);
    const dblErr = Math.abs(r.bpm - r.expectBpm * 2);
    const bpmPass = bpmErr <= r.bpmTolerance || halfErr <= r.bpmTolerance || dblErr <= r.bpmTolerance;
    console.log(`    BPM: ${r.bpm} (expect ~${r.expectBpm}) ${bpmPass ? '✓' : '✗'}`);
    if (!bpmPass) allPass = false;
  }

  const validChords = r.chordLog.filter(c => c.chord);
  const inKey = validChords.filter(c => r.inKeyChords.has(c.chord));
  const pct = validChords.length > 0 ? (inKey.length / validChords.length * 100) : 0;
  const chordPass = pct >= 50;
  console.log(`    Chords in-key: ${inKey.length}/${validChords.length} (${pct.toFixed(0)}%) ${chordPass ? '✓' : '✗'}`);
  if (!chordPass) allPass = false;

  const allPCs = new Set();
  for (const n of r.noteLog) for (const pc of n.pcs) allPCs.add(pc);
  const inScale = [...allPCs].filter(pc => r.expectScale.has(pc));
  const scalePass = inScale.length >= r.expectScale.size * 0.7;
  console.log(`    Scale fit: ${inScale.length}/${allPCs.size} PCs in scale ${scalePass ? '✓' : '✗'}`);
  if (!scalePass) allPass = false;
}

console.log(`\n  ${'═'.repeat(40)}`);
console.log(`  Overall: ${allPass ? 'ALL PASS ✓' : 'SOME FAILURES ✗'}`);
process.exit(allPass ? 0 : 1);
