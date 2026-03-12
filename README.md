# SoundView

Real-time audio visualizer that turns microphone input into a rich, multi-layered visual display intended to mimic the human auditory processing system and the features it provides for free.

In theory one could learn to read the live visual display to "hear" and intepret speech, music, and other ambient sound using your eyes.

**Live Site: https://pirate.github.io/soundview/**

<img width="3101" height="1735" alt="Screenshot 2026-03-12 at 3 49 24 PM" src="https://github.com/user-attachments/assets/351c893e-4f77-4f40-bfcd-395d5518fc0c" />

**Background / Inspiration:** This [💬 GPT-5.4 conversation](https://chatgpt.com/share/69b26006-a58c-8002-817b-08104eb92f4b) where I was asking about how human brains process sound.


### Related Projects & Resources

- ⭐️ https://pypi.org/project/mac-hardware-toys
- ⭐️ https://github.com/Yuan-ManX/audio-development-tools + https://github.com/BillyDM/awesome-audio-dsp
- ⭐️ https://www.adamstark.co.uk/research + https://github.com/adamstark/BTrack
- https://threejsdemos.com/demos/audio/visualizer
- https://essentia.upf.edu/ + https://github.com/MTG/essentia.js
- [YouTube | Real-Time 3D Audio Visualizer by Gabriel Dahl](https://www.youtube.com/watch?v=GbvyrPK2ulQ)
- https://github.com/Andrew32A/digital-concert
- https://github.com/Rudy9025/Rudys.ThreeJS.Audio.Visualizer
- https://tympanus.net/codrops/2025/06/18/coding-a-3d-audio-visualizer-with-three-js-gsap-web-audio-api/
- https://github.com/adamstark/Chord-Detector-and-Chromagram + https://github.com/chinmaykrishnroy/dechord
- https://github.com/aiXander/Realtime_PyAudio_FFT
- https://github.com/qlemaire22/real-time-audio-analysis
- https://github.com/magicat777/live-audio-analyzer
- https://timbreandorchestration.org/writings/project-reports/real-time-timbral-analysis
- ⭐️ https://cnmat.berkeley.edu/sites/default/files/attachments/2009_An_Exploration_of_Real-Time_Visualizations_of_Musical_Timbre.pdf
- [Timbre Analysis of Music Audio Signals with Convolutional Neural Networks](https://arxiv.org/pdf/1703.06697)
- https://ravinkumar.com/GenAiGuidebook/audio/audio_feature_extraction.html
- https://www.mdpi.com/2079-9292/12/8/1791
- https://transactions.ismir.net/articles/10.5334/tismir.198
- https://devopedia.org/audio-feature-extraction
- https://minimeters.app/
- https://www.sonicvisualiser.org/doc/reference/5.0.1/en/
- https://github.com/deezer/spleeter
- https://github.com/speechbrain/speechbrain
- https://github.com/libAudioFlux/audioFlux
- https://friture.org/features.html
- https://github.com/ybayle/awesome-deep-learning-music/issues/5
- https://github.com/BillyDM/awesome-audio-dsp/blob/main/sections/MORE_LISTS.md

---

## What It Shows

### Cochleagram (main spectrogram area, ~60% of screen)
A scrolling time-frequency display rendered at native Retina resolution. Each pixel column represents one frame (~16ms) of audio.

- **Vertical axis**: Frequency (50Hz at bottom, 16kHz at top), with a piecewise log scale that compresses the extremes and expands the 200-8000Hz speech/music range for maximum detail
- **Color**: Thermal colormap from black (silent) through blue, cyan, green, yellow, orange, red to white (loud)
- **Resolution**: FFT size 8192 gives ~5.4Hz per bin, with per-pixel rendering via ImageData
- **Sensitivity**: Adjustable via slider, with perceptual gamma compression (0.35) and a noise gate to suppress mic self-noise

### Overlay Lines on Cochleagram
- **White line**: Pitch (fundamental frequency) tracked via YIN-style autocorrelation. Snaps instantly on octave jumps instead of drawing diagonals
- **Pink line**: Spectral centroid (brightness/timbre), smoothed with jitter rejection — only shows when stable
- **Cyan line**: Spectral rolloff (frequency below which 85% of energy lives)
- **White voice lines**: Up to 4 simultaneous pitches detected via subharmonic summation
- **Green formant dots**: F1/F2/F3 vocal tract resonances at their frequency positions
- **Green harmonic dots**: Overtone series when pitch is detected

### Noise Fuzz (top of cochleagram)
Three rows of scattered pixels at the top, gated on aperiodic content only (suppressed during speech/music):
- **Top row**: High-frequency noise — cyan (hissy) or white (broadband)
- **Middle row**: Mid-frequency noise — pink (pink noise) or grey (balanced)
- **Bottom row**: Low-frequency noise — brown/red (rumble)

Density and opacity scale with noise loudness. Color indicates noise spectral tilt.

### Beat Detection (blue vertical lines)
BTrack-style beat tracker ([Adam Stark, 2014](https://github.com/adamstark/BTrack)):
1. Onset detection function from spectral flux feeds into a circular buffer
2. Autocorrelation estimates tempo period (60-164 BPM range) with Rayleigh weighting
3. Cumulative score array chains evidence backward by one beat period
4. Beat counter triggers when accumulated score peaks
5. Requires 6+ consecutive confirmed beats before showing (prevents false positives)
6. Every 10th beat displays the current BPM as a number

### Broadband Transient Lines (white dashed vertical)
Detects sudden broadband energy spikes (claps, thuds, impacts) by counting how many cochleagram rows are "bright" in the current frame vs the running average. Debounced at 250ms.

### Harmonic Profile Strip (~25% of screen)
32 rows showing the first 16 harmonics at 2x resolution with interpolation. Each row is color-coded by acoustic role:

| Harmonic | Color | Significance |
|---|---|---|
| H1 | White | Fundamental strength |
| H2 | Cyan | Breathiness indicator (H2/H1 ratio) |
| H3 | Orange | Power/projection |
| H5, H7 | Yellow | Odd-harmonic signature (nasal, reed, square wave) |
| H8-H10 | Magenta | Brilliance region (trained singer, brass) |
| Even (H4,H6...) | Blue | Even harmonics |
| H11+ | Gold | Upper partials |

Additional dimensions encoded:
- **Brightness**: Harmonic amplitude (dB-compressed for visibility)
- **Saturation**: Harmonic purity (peak vs surrounding noise floor)
- **Flash/dim**: Temporal derivative (brightens on attack, dims on decay)
- **White line**: Tracks the dominant non-fundamental harmonic when stable for 200ms+

Harmonics are computed from the store's autocorrelation-based pitch, with fallback to the strongest voice from multi-pitch detection (works for music through speakers, not just direct voice).

### Feature Strip (bottom ~15% of screen)

**Energy/Spread/Flux band** (3 rows):
- Background color: spectral spread mapped to blue (narrow) → green → yellow → red (wide), modulated by RMS energy as brightness
- White line: energy envelope (spectral flux, unsmoothed for fast transient response)
- Black line: derivative of flux (spikes on onsets, dips on releases)
- Blue squares: beat markers from the BTrack detector

**Top Frequencies band** (5 rows):
- Background: instrument classification color (green=vocal, red-orange=drums, gold=brass, purple=strings, blue=piano, grey=noise)
- Colored lines: top 3 detected frequencies via iterative peak picking with suppression and merge (same colors as voice arrows)

### Voice Arrows (right edge, overlay canvas)
Up to 4 simultaneously detected pitches shown as colored arrows pointing left from the right edge, with frequency labels. Drawn on a separate canvas that clears each frame (never scrolls). Black background strip keeps them readable.

Colors match between arrows and their corresponding lines on the cochleagram and top-freq band:
- Orange: strongest voice
- Blue: 2nd voice
- Green: 3rd voice
- Magenta: 4th voice

## Audio Analysis Pipeline

### `src/audio/engine.js`
Microphone capture with AGC/noise suppression/echo cancellation disabled. Creates an AnalyserNode with FFT size 8192.

### `src/audio/filterbank.js`
28 BiquadFilter bandpass filters from 30Hz to 20kHz (~1/3 octave spacing), each with its own AnalyserNode for per-band energy extraction.

### `src/audio/pitch.js`
YIN-style autocorrelation pitch detection on the first 2048 samples of the time-domain buffer. Collects all NSDF peaks, finds the global best, then accepts the first peak within 50% of the best (proper YIN heuristic). Range: 60-800Hz.

### `src/audio/features.js`
Per-frame feature extraction (~400 lines):
- Band energy, smoothing, peak tracking, delta, periodicity (autocorrelation with 32 lag limit), roughness
- Full spectrum copy (spectrumDb)
- RMS, noise floor estimation, signal-above-noise, signal presence detection
- Spectral shape: centroid (with smoothing + snap/jitter rejection), spread, flatness, slope, rolloff
- Noisiness decomposition (tonal vs noise energy)
- Pitch detection + smoothing (fast tracking with octave-jump snap)
- Harmonicity + 32 harmonic amplitudes (normalized to fundamental)
- Modulation depth/rate from envelope analysis
- Onset detection (spectral flux with adaptive median threshold)

### `src/audio/modulation.js`
Per-band modulation spectrum via 64-point FFT of envelope history. 7 modulation bands from <1Hz to roughness (30-300Hz). Runs every 4th frame.

### `src/audio/formants.js`
Spectral peak picking for F1/F2/F3 with:
- Wide smoothing window (~150Hz) to reveal formant envelope over individual harmonics
- Frequency-constrained assignment (F1: 200-1000Hz, F2: 600-2800Hz, F3: 1500-4500Hz)
- Hysteresis smoothing (fast on large jumps, slow on jitter)
- Rule-based sound classifier (silence/voiced harmonic/voiced noisy/fricative/plosive/nasal)

### `src/store/feature-store.js`
Shared typed-array data bus. All audio features written by the analysis pipeline, read by the renderer each frame.

### `src/scene/engine.js`
Minimal render loop using `performance.now()` for timing. No Three.js — pure 2D canvas.

### `src/scene/layers/spectrum-wall.js`
The main renderer (~1000 lines). Creates two canvases:
1. **Spectrogram canvas**: scrolling cochleagram + harmonics + feature strip, rendered with ImageData for pixel-perfect output
2. **Overlay canvas**: voice arrows, cleared each frame

Also contains:
- Multi-pitch detection via subharmonic summation
- Top-frequency extraction (iterative argmax with suppression + merge, ported from a Python visualizer)
- Simple instrument classifier
- BTrack beat tracker
- Noise fuzz renderer

---

## Development

```bash
pnpm install
pnpm dev

# deploy:
pnpm build
npx gh-pages -d dist
```

Click "click to start" to grant microphone access. Controls:
- **sens**: Sensitivity offset in dB (shifts the brightness curve)
- **speed**: Scroll speed in pixels per frame (1-20)

### Tech Stack

- Vanilla JS (no framework)
- Web Audio API (AnalyserNode, BiquadFilter, MediaStream)
- Canvas 2D (ImageData for cochleagram, fillRect for features, arc for voice circles)
- Vite for dev server and build

---

MIT License
