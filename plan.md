# Module Reorganization Plan

## Goal
Standardize all modules with a uniform interface, separate computation from rendering, make render strips reorderable, and ensure each module owns its own state.

## New Directory Structure

```
src/
  modules/
    energy/
      compute.js    — band energy, RMS, noise floor, signal detection, onset detection
      render.js     — volume strip (green energy bar)
    spectrum/
      compute.js    — full-spectrum extraction (spectrumDb, spectral shape descriptors)
      render.js     — cochleagram strip + overlays (pitch line, formants, harmonics, centroid, rolloff, noise fuzz)
    pitch/
      compute.js    — YIN autocorrelation pitch detection + smoothing + harmonic amplitudes
      render.js     — (no own strip — pitch renders as overlay on spectrum)
    chroma/
      compute.js    — chromagram folding, key detection, chord detection
      render.js     — notes/chords strip (12-row piano roll + chord text)
    timbre/
      compute.js    — MFCCs, tristimulus, inharmonicity
      render.js     — timbre-over-time strip + timbre space overlay (bottom-left)
    onset/
      compute.js    — spectral flux, onset strength, onset brightness/bandwidth
      render.js     — onset/flux strip
    harmonics/
      compute.js    — harmonic structure extraction, harmonicity ratio
      render.js     — harmonics strip (32 harmonic rows)
    formants/
      compute.js    — formant peak detection, sound classification, spectral flux
      render.js     — (renders as overlay on spectrum)
    beat/
      compute.js    — BTrack beat tracking, BPM estimation
      render.js     — beat column flashes (spans all strips), BPM text, beat indicator circle
    modulation/
      compute.js    — per-band envelope modulation spectrum
      render.js     — (no own strip currently — data is available for future use)
    speech/
      compute.js    — Whisper speech recognition
      render.js     — speech text strip
    transcription/
      compute.js    — Basic Pitch note transcription
      render.js     — (renders within chroma strip as note markers)
  core/
    audio-engine.js   — mic capture, AudioContext, fullAnalyser (renamed from audio/engine.js)
    filterbank.js     — 28-band cochlear filterbank creation (moved from audio/filterbank.js)
    render-engine.js  — render loop + strip layout manager (replaces scene/engine.js)
    colormap.js       — shared colormap LUT, pitch-class colors, freq mapping utils
  main.js             — boot sequence (wires everything together)
```

## Standard Module Interface

Every `compute.js` exports:

```js
// Module header comment:
// READS: store.spectrumDb, store.pitch, ...
// DEPENDS ON: spectrum (must run after spectrum.update)
// WRITES: store.chroma, store.detectedKey, store.detectedChord, ...
// DISPLAY: notes/chords strip — 12-row piano roll with pitch-class coloring

export const state = {
  // Module-owned state (typed arrays, scalars)
  // Other modules can read this directly via: import { state } from '../chroma/compute.js'
};

export function init(sampleRate, fftSize) { ... }

export function update() { ... }

export function reset() { ... }  // optional: clear accumulators on silence, etc.
```

Every `render.js` exports:

```js
// READS: own module's state + any other module states it needs
// STRIP: yes/no (whether this is a horizontal strip or an overlay)

export const meta = {
  name: 'chroma',           // unique id
  label: 'notes',           // human-readable label for the strip
  defaultHeight: 0.10,      // fraction of screen height
  type: 'strip',            // 'strip' | 'overlay' | 'widget'
};

export function render(ctx, x, y, w, h, scrollSpeed, dt, time) {
  // Draw into the given rectangle. No hardcoded positions.
}
```

## Core Render Engine (render-engine.js)

```js
const strips = [
  { module: 'speech',    height: 0.05, enabled: true },
  { module: 'timbre',    height: 0.07, enabled: true },
  { module: 'chroma',    height: 0.10, enabled: true },
  { module: 'onset',     height: 0.07, enabled: true },
  { module: 'harmonics', height: 0.14, enabled: true },
  { module: 'spectrum',  height: 0.50, enabled: true },
  { module: 'energy',    height: 0.06, enabled: true },
];

// Overlays render on top after all strips:
const overlays = [
  { module: 'beat' },     // full-height beat columns
  { module: 'timbre' },   // timbre space widget (bottom-left)
  { module: 'chroma' },   // circle of fifths widget (bottom-left)
];
```

To reorder strips, just rearrange the array. To toggle a strip, set `enabled: false`.
Heights are normalized (sum to 1.0) so removing a strip redistributes space.

Each frame:
1. Call all compute.update() in dependency order
2. Calculate strip Y positions from the ordered list
3. Call each enabled strip's render(ctx, x, y, w, h, ...)
4. Call each overlay's render

## Dependency Order (hardcoded)

```
1. energy.update()      — reads filterbank analysers → bandEnergy, RMS, noise floor
2. spectrum.update()    — reads fullAnalyser → spectrumDb, spectral descriptors
3. pitch.update()       — reads fullTimeDomain → pitch, pitchConfidence
4. harmonics.update()   — reads pitch + spectrumDb → harmonicAmplitudes, harmonicity
5. formants.update()    — reads spectrumDb → formants, spectralFlux, soundClass
6. onset.update()       — reads bandEnergy → onsetStrength, isOnset
7. beat.update()        — reads spectralFlux → bpm, isBeat
8. chroma.update()      — reads spectrumDb → chroma, key, chord
9. timbre.update()      — reads spectrumDb + harmonicAmplitudes → mfcc, tristimulus
10. modulation.update() — reads bandHistory → bandModulation
```

This is just the order array in the pipeline — no DAG resolver needed.

## State Ownership

Each module's `state` object owns its outputs. The shared `feature-store.js` is kept as a flat namespace that all modules write into (for backwards compat and simplicity), but each module's `compute.js` clearly documents which fields it owns.

Other modules read from the store directly — no event system, no pub/sub. The dependency order guarantees reads see fresh data.

## Migration Strategy (incremental, one module at a time)

### Phase 1: Extract compute modules
Move computation code from features.js into individual module compute.js files.
features.js becomes a thin orchestrator that calls them in order.

1. energy/compute.js — extract band energy loop + RMS + noise floor + modulation estimation from features.js
2. spectrum/compute.js — extract full-spectrum analysis + spectral descriptors
3. pitch/compute.js — already exists as audio/pitch.js, just move + add state
4. harmonics/compute.js — extract harmonic structure section from features.js
5. onset/compute.js — extract onset detection section from features.js
6. formants/compute.js — already exists as audio/formants.js, move
7. beat/compute.js — already exists as audio/beat.js, move
8. chroma/compute.js — already exists as audio/chroma.js, move
9. timbre/compute.js — already exists as audio/timbre.js, move
10. modulation/compute.js — already exists as audio/modulation.js, move
11. speech/compute.js — already exists as audio/speech.js, move
12. transcription/compute.js — already exists as audio/transcribe.js, move

### Phase 2: Extract render modules
Split spectrum-wall.js into per-module render.js files.

1. energy/render.js — volume strip (lines 729-747)
2. spectrum/render.js — cochleagram + overlays (lines 603-724)
3. chroma/render.js — notes strip + circle of fifths overlay (lines 343-440, 870-939)
4. onset/render.js — onset/flux strip (lines 443-499)
5. harmonics/render.js — harmonics strip (lines 501-601)
6. timbre/render.js — timbre-over-time strip + timbre space overlay (lines 302-341, 942-1027)
7. beat/render.js — beat columns + indicator (lines 750-791, 855-867)
8. speech/render.js — speech text strip + overlay (lines 267-300, 798-823)

### Phase 3: Build render engine
Create render-engine.js with strip layout system.
spectrum-wall.js is deleted; main.js registers strips in desired order.

### Phase 4: Update test harness
test-analysis.mjs imports individual compute modules and calls them in order.
Can test any module in isolation by only importing its compute.js.

### Phase 5: Add module header docs
Each compute.js and render.js gets a standardized header comment documenting
READS, DEPENDS ON, WRITES, and DISPLAY.
