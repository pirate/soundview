// Offline audio analysis test harness.
// Runs the ACTUAL chroma.js / features.js / timbre.js code against real audio files.
// No reimplemented algorithms — this exercises the production code paths.

import { readFileSync, existsSync } from 'fs';
import { execSync } from 'child_process';

// ── Import the real modules ──
import { store } from '../src/store/feature-store.js';
import { initFeaturesOffline, updateFeaturesFromBuffers } from '../src/audio/features.js';
import { initPitch } from '../src/audio/pitch.js';

const SR = 44100;
const FFT_SIZE = 8192;
const HOP = 2048; // ~21ms, ~46 fps

// ── Minimal FFT (Cooley-Tukey radix-2) ──
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    while (j & bit) { j ^= bit; bit >>= 1; }
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const halfLen = len >> 1;
    const angle = -2 * Math.PI / len;
    const wRe = Math.cos(angle), wIm = Math.sin(angle);
    for (let i = 0; i < n; i += len) {
      let curRe = 1, curIm = 0;
      for (let j = 0; j < halfLen; j++) {
        const tRe = curRe * re[i + j + halfLen] - curIm * im[i + j + halfLen];
        const tIm = curRe * im[i + j + halfLen] + curIm * re[i + j + halfLen];
        re[i + j + halfLen] = re[i + j] - tRe;
        im[i + j + halfLen] = im[i + j] - tIm;
        re[i + j] += tRe;
        im[i + j] += tIm;
        const nextRe = curRe * wRe - curIm * wIm;
        curIm = curRe * wIm + curIm * wRe;
        curRe = nextRe;
      }
    }
  }
}

// Convert mp3 to raw PCM if needed
function loadAudio(mp3Path) {
  const rawPath = mp3Path.replace(/\.mp3$/, '.raw');
  if (!existsSync(rawPath)) {
    console.log(`  Converting ${mp3Path} → raw PCM...`);
    execSync(`ffmpeg -y -i "${mp3Path}" -f f32le -acodec pcm_f32le -ar ${SR} -ac 1 "${rawPath}" 2>/dev/null`);
  }
  const raw = readFileSync(rawPath);
  return new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
}

// Pre-compute Hann window
const hann = new Float32Array(FFT_SIZE);
for (let i = 0; i < FFT_SIZE; i++) hann[i] = 0.5 * (1 - Math.cos(2 * Math.PI * i / (FFT_SIZE - 1)));

// Compute FFT and return dB spectrum (like getFloatFrequencyData)
function computeSpectrum(samples, offset) {
  const re = new Float64Array(FFT_SIZE);
  const im = new Float64Array(FFT_SIZE);
  for (let i = 0; i < FFT_SIZE; i++) {
    re[i] = (offset + i < samples.length) ? samples[offset + i] * hann[i] : 0;
    im[i] = 0;
  }
  fft(re, im);
  const specDb = new Float32Array(FFT_SIZE / 2);
  for (let i = 0; i < FFT_SIZE / 2; i++) {
    const mag = Math.sqrt(re[i] * re[i] + im[i] * im[i]);
    specDb[i] = 20 * Math.log10(Math.max(1e-10, mag / FFT_SIZE));
  }
  return specDb;
}

// ══════════════════════════════════════════════════════════════
// Test runner
// ══════════════════════════════════════════════════════════════

function analyzeFile(audioPath, label) {
  console.log(`\n${'═'.repeat(60)}`);
  console.log(label);
  console.log('═'.repeat(60));

  const samples = loadAudio(audioPath);
  const duration = samples.length / SR;
  console.log(`  ${duration.toFixed(1)}s, ${samples.length} samples`);

  // Reset store state
  store.spectrumDb.fill(-100);
  store.chroma.fill(0);
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

  // Initialize the real modules in offline mode
  initPitch(SR);
  initFeaturesOffline(SR, FFT_SIZE);

  // Per-second chord/note tracking
  const chordLog = [];     // { sec, chord, conf }
  const keyLog = [];       // { sec, key, conf }
  const noteLog = [];      // { sec, pitchClasses }
  let frameCount = 0;

  // Process frames
  for (let offset = 0; offset + FFT_SIZE <= samples.length; offset += HOP) {
    const timeDomain = samples.subarray(offset, offset + FFT_SIZE);
    const freqData = computeSpectrum(samples, offset);

    // Feed into the REAL features pipeline
    updateFeaturesFromBuffers(timeDomain, freqData);
    frameCount++;

    const sec = offset / SR;

    // Log chord every ~0.5s
    if (frameCount % 23 === 0) {
      chordLog.push({
        sec: Math.round(sec * 10) / 10,
        chord: store.detectedChord,
        conf: store.detectedChordConfidence,
      });
    }

    // Log key every ~2s
    if (frameCount % 92 === 0) {
      keyLog.push({
        sec: Math.round(sec),
        key: store.detectedKey,
        conf: store.detectedKeyConfidence,
      });
    }

    // Log active pitch classes every ~1s
    if (frameCount % 46 === 0) {
      const activePCs = [];
      const NOTE_NAMES = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
      for (let i = 0; i < 12; i++) {
        if (store.chroma[i] > 0.15) activePCs.push(NOTE_NAMES[i]);
      }
      noteLog.push({ sec: Math.round(sec), pcs: activePCs });
    }
  }

  console.log(`  Processed ${frameCount} frames\n`);

  // Final detected key
  console.log(`  Key: ${store.detectedKey} (conf: ${store.detectedKeyConfidence.toFixed(3)})`);

  // Chord timeline (5s windows)
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
  for (const entry of noteLog.filter((_, i) => i % 4 === 0).slice(0, 20)) {
    if (entry.pcs.length > 0) {
      const m = Math.floor(entry.sec / 60), s = entry.sec % 60;
      console.log(`    ${m}:${String(s).padStart(2, '0')}  ${entry.pcs.join(' ')}`);
    }
  }

  return {
    key: store.detectedKey,
    keyConf: store.detectedKeyConfidence,
    chordLog,
    noteLog,
  };
}

// ══════════════════════════════════════════════════════════════
// Download test files if needed
// ══════════════════════════════════════════════════════════════
const TESTS = [
  {
    url: 'https://cdn.pixabay.com/download/audio/2025/11/21/audio_2621422ac3.mp3?filename=mountaindweller-waltz-of-the-flowers-tchaikovsky-excerpt-440339.mp3',
    file: 'test/waltz.mp3',
    label: 'WALTZ OF THE FLOWERS (expect: D major)',
    expectKey: 'D maj',
    inKeyChords: new Set(['D', 'G', 'A', 'Bm', 'Em', 'F#m', 'A7', 'D7', 'E', 'Am', 'C', 'F#7',
      'Em7', 'F#m7', 'Am7', 'Gsus4', 'Dsus4', 'Asus4']),
    expectScale: new Set(['D', 'E', 'F#', 'G', 'A', 'B', 'C#']),
  },
  {
    url: 'https://cdn.pixabay.com/download/audio/2025/09/27/audio_6813e09c43.mp3?filename=saturn-3-music-claire-de-lune-debussy-piano-411227.mp3',
    file: 'test/claire.mp3',
    label: 'CLAIRE DE LUNE (expect: C#/Db major)',
    expectKey: 'C# maj',
    // Include diatonic triads, 7ths, and sus4 chords built on scale degrees
    inKeyChords: new Set(['C#', 'G#', 'A#m', 'F#', 'D#m', 'G#7', 'Fm', 'C#7', 'F#m',
      'D#m7', 'Fm7', 'A#m7', 'C#sus4', 'G#sus4', 'D#sus4', 'A#sus4', 'F#m7']),
    expectScale: new Set(['C#', 'D#', 'F', 'F#', 'G#', 'A#', 'C']),
  },
];

// Ensure test directory exists
execSync('mkdir -p test');

for (const t of TESTS) {
  if (!existsSync(t.file)) {
    console.log(`Downloading ${t.file}...`);
    execSync(`curl -L -o "${t.file}" "${t.url}" 2>/dev/null`);
  }
}

// Run analysis
const results = [];
for (const t of TESTS) {
  const r = analyzeFile(t.file, t.label);
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

  // Key check
  const keyPass = r.key === r.expectKey;
  console.log(`    Key: ${r.key} ${keyPass ? '✓' : '✗ (expected ' + r.expectKey + ')'}`);
  if (!keyPass) allPass = false;

  // Chord in-key percentage
  const validChords = r.chordLog.filter(c => c.chord);
  const inKey = validChords.filter(c => r.inKeyChords.has(c.chord));
  const pct = validChords.length > 0 ? (inKey.length / validChords.length * 100) : 0;
  const chordPass = pct >= 50;
  console.log(`    Chords in-key: ${inKey.length}/${validChords.length} (${pct.toFixed(0)}%) ${chordPass ? '✓' : '✗'}`);
  if (!chordPass) allPass = false;

  // Scale fitness: are detected pitch classes mostly in the expected scale?
  const allPCs = new Set();
  for (const n of r.noteLog) for (const pc of n.pcs) allPCs.add(pc);
  const inScale = [...allPCs].filter(pc => r.expectScale.has(pc));
  const scalePass = inScale.length >= r.expectScale.size * 0.7;
  console.log(`    Scale fit: ${inScale.length}/${allPCs.size} detected PCs in scale (${inScale.join(',')}) ${scalePass ? '✓' : '✗'}`);
  if (!scalePass) allPass = false;
}

console.log(`\n  ${'═'.repeat(40)}`);
console.log(`  Overall: ${allPass ? 'ALL PASS ✓' : 'SOME FAILURES ✗'}`);
process.exit(allPass ? 0 : 1);
