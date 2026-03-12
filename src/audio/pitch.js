// Autocorrelation-based pitch detection (simplified YIN).
// Operates on time-domain buffer from the full-spectrum analyser.

const MIN_FREQ = 60;   // Hz
const MAX_FREQ = 800;   // Hz — human voice tops out ~500Hz, instruments ~800Hz

// Pre-allocated buffers
let nsdf = null;        // normalized square difference function
let sampleRate = 44100;

export function initPitch(sr) {
  sampleRate = sr;
  const maxLag = Math.ceil(sampleRate / MIN_FREQ);
  nsdf = new Float32Array(maxLag);
}

/**
 * Detect pitch from time-domain audio buffer.
 * Returns { freq, confidence } where freq=0 means no pitch detected.
 */
export function detectPitch(buffer) {
  // Use at most 2048 samples — more doesn't improve pitch accuracy
  // and causes performance issues + false detections with large FFT buffers
  const bufLen = Math.min(buffer.length, 2048);
  const minLag = Math.floor(sampleRate / MAX_FREQ);
  const maxLag = Math.min(Math.ceil(sampleRate / MIN_FREQ), bufLen >> 1);

  if (!nsdf || nsdf.length < maxLag) {
    nsdf = new Float32Array(maxLag);
  }

  // Compute normalized square difference function (NSDF)
  // This is the core of the YIN algorithm
  for (let tau = minLag; tau < maxLag; tau++) {
    let acf = 0;  // autocorrelation
    let e1 = 0;   // energy term 1
    let e2 = 0;   // energy term 2
    const len = bufLen - tau;

    for (let i = 0; i < len; i++) {
      acf += buffer[i] * buffer[i + tau];
      e1 += buffer[i] * buffer[i];
      e2 += buffer[i + tau] * buffer[i + tau];
    }

    const denom = e1 + e2;
    nsdf[tau] = denom > 0 ? (2 * acf) / denom : 0;
  }

  // Find the best peak of NSDF — collect all peaks, pick the first one
  // above threshold * bestOverall (YIN key insight: accept first peak
  // that's within some fraction of the global best)
  const threshold = 0.5;
  const allPeaks = []; // {lag, val}
  let inPositive = false;
  let peakLag = 0;
  let peakVal = 0;

  for (let tau = minLag; tau < maxLag - 1; tau++) {
    if (nsdf[tau] > 0) {
      if (!inPositive) {
        inPositive = true;
        peakLag = tau;
        peakVal = nsdf[tau];
      }
      if (nsdf[tau] > peakVal) {
        peakLag = tau;
        peakVal = nsdf[tau];
      }
    } else if (inPositive) {
      if (peakVal > 0.2) {
        allPeaks.push({ lag: peakLag, val: peakVal });
      }
      inPositive = false;
    }
  }
  if (inPositive && peakVal > 0.2) {
    allPeaks.push({ lag: peakLag, val: peakVal });
  }

  // Find global best, then accept first peak >= threshold * globalBest
  let bestLag = 0;
  let bestVal = -1;
  if (allPeaks.length > 0) {
    const globalBest = Math.max(...allPeaks.map(p => p.val));
    const acceptThresh = globalBest * threshold;
    for (const p of allPeaks) {
      if (p.val >= acceptThresh) {
        bestLag = p.lag;
        bestVal = p.val;
        break;
      }
    }
  }

  if (bestLag === 0 || bestVal < threshold) {
    return { freq: 0, confidence: 0 };
  }

  // Parabolic interpolation around the peak for sub-sample accuracy
  const a = nsdf[bestLag - 1] || 0;
  const b = nsdf[bestLag];
  const c = nsdf[bestLag + 1] || 0;
  const shift = (a - c) / (2 * (a - 2 * b + c) || 1);
  const refinedLag = bestLag + shift;

  const freq = sampleRate / refinedLag;
  const confidence = Math.min(bestVal, 1);

  return { freq, confidence };
}
