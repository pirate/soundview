// Chord detection via template matching against chromagram.
// Adapted from Adam Stark's Chord-Detector-and-Chromagram.

import { NOTE_NAMES } from './chroma.js';

const NUM_CHROMA = 12;

// ── Chord quality definitions ──
// Each entry: [name, suffix for display, semitone intervals, bias]
const QUALITIES = [
  { name: 'maj',  suffix: '',      intervals: [0, 4, 7],       bias: 1.06 },
  { name: 'min',  suffix: 'm',     intervals: [0, 3, 7],       bias: 1.06 },
  { name: 'dim',  suffix: 'dim',   intervals: [0, 3, 6],       bias: 1.06 },
  { name: 'aug',  suffix: 'aug',   intervals: [0, 4, 8],       bias: 1.06 },
  { name: 'sus2', suffix: 'sus2',  intervals: [0, 2, 7],       bias: 1.0 },
  { name: 'sus4', suffix: 'sus4',  intervals: [0, 5, 7],       bias: 1.0 },
  { name: 'maj7', suffix: 'maj7',  intervals: [0, 4, 7, 11],   bias: 1.0 },
  { name: 'min7', suffix: 'm7',    intervals: [0, 3, 7, 10],   bias: 1.0 },
  { name: '7',    suffix: '7',     intervals: [0, 4, 7, 10],   bias: 1.0 },
];

// ── Build 108 chord profiles (12 roots × 9 qualities) ──
// Each profile is a 12-element binary vector
const profiles = [];
for (const q of QUALITIES) {
  for (let root = 0; root < NUM_CHROMA; root++) {
    const profile = new Float64Array(NUM_CHROMA);
    for (const interval of q.intervals) {
      profile[(root + interval) % NUM_CHROMA] = 1;
    }
    profiles.push({
      root,
      quality: q.name,
      suffix: q.suffix,
      profile,
      numNotes: q.intervals.length,
      bias: q.bias,
    });
  }
}

// Scratch array for preprocessed chroma
const processed = new Float64Array(NUM_CHROMA);

/**
 * Detect chord from a 12-bin chromagram vector.
 * @param {Float32Array} chromagram - normalized chroma vector (12 bins, max ~1.0)
 * @returns {{ root: number, quality: string, name: string, confidence: number }}
 */
export function detectChord(chromagram) {
  // Preprocess: reduce the 5th (7 semitones above each note) by 10%
  // This helps disambiguate root from fifth
  for (let i = 0; i < NUM_CHROMA; i++) {
    processed[i] = chromagram[i];
  }
  for (let i = 0; i < NUM_CHROMA; i++) {
    const fifthIdx = (i + 7) % NUM_CHROMA;
    processed[fifthIdx] *= 0.9;
  }

  // Score each profile — lower = better match
  let bestScore = Infinity;
  let secondBest = Infinity;
  let bestIdx = 0;

  for (let p = 0; p < profiles.length; p++) {
    const { profile, numNotes, bias } = profiles[p];

    // Stark's formula: sqrt(sum((1 - profile[i]) * chroma[i]^2)) / ((12 - N) * bias)
    // Measures energy in non-chord bins (penalizes energy outside the chord template)
    let sum = 0;
    for (let i = 0; i < NUM_CHROMA; i++) {
      const weight = 1 - profile[i];
      sum += weight * processed[i] * processed[i];
    }
    const score = Math.sqrt(sum) / ((NUM_CHROMA - numNotes) * bias);

    if (score < bestScore) {
      secondBest = bestScore;
      bestScore = score;
      bestIdx = p;
    } else if (score < secondBest) {
      secondBest = score;
    }
  }

  const best = profiles[bestIdx];

  // Confidence: combine ratio of best vs second-best with how well the
  // chord template matches (energy in chord bins vs outside)
  let confidence = 0;
  if (secondBest > 1e-8 && bestScore < secondBest) {
    // Ratio component: how much better is best vs second-best
    const ratio = 1 - bestScore / secondBest;
    // Fit component: how much energy falls on chord tones vs off them
    const { profile, numNotes } = profiles[bestIdx];
    let onChord = 0, offChord = 0;
    for (let i = 0; i < NUM_CHROMA; i++) {
      if (profile[i] > 0.5) onChord += processed[i];
      else offChord += processed[i];
    }
    const total = onChord + offChord;
    const fit = total > 1e-8 ? onChord / total : 0;
    // Combine: ratio gives discrimination, fit gives absolute quality
    confidence = Math.min(1, ratio * 3) * 0.4 + fit * 0.6;
  }

  // Attenuate in near-silence (chromagram is normalized, so check raw sum)
  let totalEnergy = 0;
  for (let i = 0; i < NUM_CHROMA; i++) totalEnergy += chromagram[i];
  if (totalEnergy < 1.0) confidence *= totalEnergy;

  const name = NOTE_NAMES[best.root] + best.suffix;

  return {
    root: best.root,
    quality: best.quality,
    name,
    confidence,
  };
}
