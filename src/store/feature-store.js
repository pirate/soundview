// Shared typed-array data bus between audio engine and scene renderer.

export const NUM_BANDS = 28;       // 30Hz–20kHz, ~1/3 octave
export const HISTORY_LEN = 128;    // frames of history (~2.1s at 60fps)
export const SPECTRUM_BINS = 4096; // half of FFT size 8192
export const NUM_MOD_BANDS = 7;    // 6 envelope-rate bands + 1 roughness band

export const store = {
  // ── Per-band data ──
  bandEnergy: new Float32Array(NUM_BANDS),
  bandEnergySmooth: new Float32Array(NUM_BANDS),
  bandPeak: new Float32Array(NUM_BANDS),
  bandEnvelopeDelta: new Float32Array(NUM_BANDS),
  bandPeriodicity: new Float32Array(NUM_BANDS),
  bandRoughness: new Float32Array(NUM_BANDS),    // amplitude variance within buffer
  bandHistory: Array.from({ length: NUM_BANDS }, () => new Float32Array(HISTORY_LEN)),
  historyIndex: 0,
  centerFreqs: new Float32Array(NUM_BANDS),

  // ── Per-band modulation spectrum (NUM_BANDS × NUM_MOD_BANDS) ──
  // Bands: [<1Hz, 1-2Hz, 2-4Hz, 4-8Hz, 8-16Hz, 16-30Hz, roughness(30-300Hz)]
  bandModulation: new Float32Array(NUM_BANDS * NUM_MOD_BANDS),

  // ── Full spectrum (for spectrum wall + analysis) ──
  spectrumDb: new Float32Array(SPECTRUM_BINS).fill(-100),

  // ── Pitch ──
  pitch: 0,
  pitchConfidence: 0,
  pitchSmooth: 0,
  pitchHistory: new Float32Array(HISTORY_LEN),
  pitchHistoryIndex: 0,

  // ── Timbral shape ──
  spectralCentroid: 0,
  spectralCentroidSmooth: 0,
  spectralSpread: 0,
  spectralFlatness: 0,
  spectralSlope: 0,
  spectralRolloff: 0,
  harmonicity: 0,

  // ── Dynamics ──
  rms: 0,
  rmsSmooth: 0,
  overallLoudness: 0,
  noiseFloor: 0,
  signalAboveNoise: 0,
  signalPresent: false,

  // ── Modulation (global) ──
  modulationDepth: 0,
  modulationRate: 0,

  // ── Noisiness decomposition ──
  noisiness: 0,
  noiseEnergy: 0,
  tonalEnergy: 0,

  // ── Onsets ──
  onsetStrength: 0,
  isOnset: false,
  onsetBrightness: 0,
  onsetBandwidth: 0,

  // ── Harmonic structure ──
  harmonicAmplitudes: new Float32Array(32),
  harmonicAmplitudesRaw: new Float32Array(32),  // raw power (before normalization)

  // ── Formants ──
  formant1: 0,           // F1 frequency (Hz), 0 = not detected
  formant2: 0,           // F2 frequency (Hz), 0 = not detected
  formant3: 0,           // F3 frequency (Hz), 0 = not detected
  formant1Smooth: 0,     // smoothed for display
  formant2Smooth: 0,
  formant3Smooth: 0,

  // ── Sound classification ──
  // 0=silence, 1=voiced_harmonic (vowel), 2=voiced_noisy, 3=fricative, 4=plosive, 5=nasal
  soundClass: 0,
  _plosiveHold: 0,

  // ── Spectral flux ──
  spectralFlux: 0,       // rate of spectral change (0-1)
  spectralFluxSmooth: 0,

  // ── Sensitivity (set by UI, shared with chroma for consistent brightness) ──
  _sensitivity: -12,

  // ── Chroma / Key / Chord ──
  chroma: new Float32Array(12),        // 12 pitch-class energies (C, C#, D, ..., B), normalized 0-1
  detectedKey: '',                     // e.g. "A min", "C maj"
  detectedKeyConfidence: 0,
  detectedChord: '',                   // e.g. "Am", "C", "G7"
  detectedChordConfidence: 0,

  // ── Timbre (MFCCs + Tristimulus + Inharmonicity) ──
  mfcc: new Float32Array(13),          // 13 mel-frequency cepstral coefficients
  tristimulus: new Float32Array(3),    // T1 (fundamental), T2 (H2-H4), T3 (H5+)
  inharmonicity: 0,                    // deviation of partials from harmonic series
};
