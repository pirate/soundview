// Shared color utilities: colormap LUT, pitch-class colors, note labels,
// frequency ↔ row mapping for the piecewise-log cochleagram.
// Used by multiple render modules to maintain visual consistency.

// ── Colormap LUT (10-stop gradient) ──
const CSTOPS = [
  [0.00, 0, 0, 0], [0.12, 0, 0, 150], [0.24, 0, 120, 220], [0.36, 0, 210, 180],
  [0.48, 200, 220, 0], [0.60, 240, 120, 0], [0.72, 220, 0, 60], [0.84, 180, 0, 220],
  [0.92, 0, 220, 80], [1.00, 255, 255, 255],
];

export const cmapLUT = new Uint8Array(256 * 3);
for (let i = 0; i < 256; i++) {
  const t = i / 255;
  let lo = CSTOPS[0], hi = CSTOPS[CSTOPS.length - 1];
  for (let s = 0; s < CSTOPS.length - 1; s++) {
    if (t >= CSTOPS[s][0] && t <= CSTOPS[s + 1][0]) { lo = CSTOPS[s]; hi = CSTOPS[s + 1]; break; }
  }
  const span = hi[0] - lo[0], f = span > 0 ? (t - lo[0]) / span : 0;
  cmapLUT[i * 3] = Math.round(lo[1] + (hi[1] - lo[1]) * f);
  cmapLUT[i * 3 + 1] = Math.round(lo[2] + (hi[2] - lo[2]) * f);
  cmapLUT[i * 3 + 2] = Math.round(lo[3] + (hi[3] - lo[3]) * f);
}

// ── Pitch-class colors (chromatic circle) ──
export const PITCH_CLASS_COLORS = [
  [255, 60, 60], [255, 130, 40], [240, 200, 40], [160, 230, 50], [60, 210, 70], [40, 200, 150],
  [40, 180, 220], [60, 120, 240], [110, 70, 230], [170, 60, 220], [220, 60, 180], [240, 60, 120],
];

export const NOTE_LABELS = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

// ── Piecewise-log frequency mapping ──
// Three zones: low exponential (50–200Hz), mid linear-log (200–8kHz), high exponential (8–16kHz)

export const FREQ_LO = 50;
export const FREQ_HI = 16000;
export const SAMPLE_RATE = 44100;
export const FFT_SIZE = 8192;
export const BIN_HZ = SAMPLE_RATE / FFT_SIZE;

// Perceptual constants
export const DB_FLOOR = -100;
export const DB_RANGE = 100;
export const GAMMA = 0.35;

// Layout is computed at init time by the render engine and passed to each strip.
// These functions are parameterized by the cochlea strip height so renderers
// don't need to know about other strips' sizes.

export function createFreqMapper(numRows) {
  const ZONE_LO_ROWS = Math.round(numRows * 0.07);
  const ZONE_HI_ROWS = Math.round(numRows * 0.07);
  const ZONE_MID_ROWS = numRows - ZONE_LO_ROWS - ZONE_HI_ROWS;
  const ZONE_LO_FREQ = 200;
  const ZONE_HI_FREQ = 8000;

  function rowToFreq(r) {
    if (r < ZONE_LO_ROWS) return FREQ_LO * Math.pow(ZONE_LO_FREQ / FREQ_LO, r / (ZONE_LO_ROWS - 1));
    if (r < ZONE_LO_ROWS + ZONE_MID_ROWS) {
      const mr = r - ZONE_LO_ROWS;
      return ZONE_LO_FREQ * Math.pow(ZONE_HI_FREQ / ZONE_LO_FREQ, mr / (ZONE_MID_ROWS - 1));
    }
    const hr = r - ZONE_LO_ROWS - ZONE_MID_ROWS;
    return ZONE_HI_FREQ * Math.pow(FREQ_HI / ZONE_HI_FREQ, hr / (ZONE_HI_ROWS - 1));
  }

  function freqToRow(freq) {
    if (freq <= FREQ_LO) return 0;
    if (freq < ZONE_LO_FREQ) return (ZONE_LO_ROWS - 1) * Math.log(freq / FREQ_LO) / Math.log(ZONE_LO_FREQ / FREQ_LO);
    if (freq < ZONE_HI_FREQ) return ZONE_LO_ROWS + (ZONE_MID_ROWS - 1) * Math.log(freq / ZONE_LO_FREQ) / Math.log(ZONE_HI_FREQ / ZONE_LO_FREQ);
    if (freq < FREQ_HI) return ZONE_LO_ROWS + ZONE_MID_ROWS + (ZONE_HI_ROWS - 1) * Math.log(freq / ZONE_HI_FREQ) / Math.log(FREQ_HI / ZONE_HI_FREQ);
    return numRows - 1;
  }

  // Pre-compute row → FFT bin mapping
  const rowBins = new Int32Array(numRows);
  for (let r = 0; r < numRows; r++) rowBins[r] = Math.round(rowToFreq(r) / BIN_HZ);

  return { rowToFreq, freqToRow, rowBins, numRows };
}
