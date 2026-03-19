// Shared typed-array data bus between audio modules and renderers.
// Every module writes its outputs here; other modules and renderers read directly.
// The dependency order in the pipeline guarantees reads see fresh data each frame.

export const NUM_BANDS = 28;       // 30Hz–20kHz, ~1/3 octave
export const HISTORY_LEN = 128;    // frames of history (~2.1s at 60fps)
export const SPECTRUM_BINS = 4096; // half of FFT size 8192
export const NUM_MOD_BANDS = 7;    // 6 envelope-rate bands + 1 roughness band

export const store = {
  // ── Per-band data (owned by energy module) ──
  bandEnergy: new Float32Array(NUM_BANDS),
  bandEnergySmooth: new Float32Array(NUM_BANDS),
  bandPeak: new Float32Array(NUM_BANDS),
  bandEnvelopeDelta: new Float32Array(NUM_BANDS),
  bandPeriodicity: new Float32Array(NUM_BANDS),
  bandRoughness: new Float32Array(NUM_BANDS),
  bandHistory: Array.from({ length: NUM_BANDS }, () => new Float32Array(HISTORY_LEN)),
  historyIndex: 0,
  centerFreqs: new Float32Array(NUM_BANDS),

  // ── Per-band modulation spectrum (owned by modulation module) ──
  bandModulation: new Float32Array(NUM_BANDS * NUM_MOD_BANDS),

  // ── Full spectrum (owned by spectrum module) ──
  spectrumDb: new Float32Array(SPECTRUM_BINS).fill(-100),

  // ── Spectral shape (owned by spectrum module) ──
  spectralCentroid: 0,
  spectralCentroidSmooth: 0,
  spectralSpread: 0,
  spectralFlatness: 0,
  spectralSlope: 0,
  spectralRolloff: 0,

  // ── Dynamics (owned by energy module) ──
  rms: 0,
  rmsSmooth: 0,
  overallLoudness: 0,
  noiseFloor: 0,
  signalAboveNoise: 0,
  signalPresent: false,

  // ── Modulation (owned by energy module) ──
  modulationDepth: 0,
  modulationRate: 0,

  // ── Noisiness (owned by spectrum module) ──
  noisiness: 0,
  noiseEnergy: 0,
  tonalEnergy: 0,

  // ── Pitch (owned by pitch module) ──
  pitch: 0,
  pitchConfidence: 0,
  pitchSmooth: 0,
  pitchHistory: new Float32Array(HISTORY_LEN),
  pitchHistoryIndex: 0,

  // ── Harmonics (owned by harmonics module) ──
  harmonicity: 0,
  harmonicAmplitudes: new Float32Array(32),
  harmonicAmplitudesRaw: new Float32Array(32),

  // ── Onsets (owned by onset module) ──
  onsetStrength: 0,
  isOnset: false,
  onsetBrightness: 0,
  onsetBandwidth: 0,

  // ── Beat / BPM (owned by beat module) ──
  bpm: 0,
  beatPhaseAccuracy: 0,
  isBeat: false,
  beatShowBeats: false,
  beatPulse: 0,

  // ── Formants (owned by formants module) ──
  formant1: 0,
  formant2: 0,
  formant3: 0,
  formant1Smooth: 0,
  formant2Smooth: 0,
  formant3Smooth: 0,
  soundClass: 0,
  _plosiveHold: 0,

  // ── Spectral flux (owned by formants module) ──
  spectralFlux: 0,
  spectralFluxSmooth: 0,

  // ── Chroma / Key / Chord (owned by chroma module) ──
  chroma: new Float32Array(12),
  detectedKey: '',
  detectedKeyConfidence: 0,
  detectedChord: '',
  detectedChordConfidence: 0,

  // ── Timbre (owned by timbre module) ──
  mfcc: new Float32Array(13),
  tristimulus: new Float32Array(3),
  inharmonicity: 0,

  // ── Speech (owned by speech module) ──
  speechText: '',
  speechWords: [],
  speechLoading: true,

  // ── Transcription (owned by transcription module) ──
  activeNotes: [],
  noteEvents: [],
  transcriptionLoading: true,

  // ── UI controls ──
  _sensitivity: -12,
};
