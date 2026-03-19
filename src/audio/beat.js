// Beat tracker based on BTrack (Adam Stark, 2014).
// Uses cumulative score with Gaussian-weighted lookback for tempo estimation.
// Extracted from spectrum-wall.js so it can be used by both the renderer and tests.

import { store } from '../store/feature-store.js';

const BT_BUF_LEN = 512;
const BT_MIN_LAG = 22;  // ~164 BPM at 60fps
const BT_MAX_LAG = 60;  // ~60 BPM at 60fps

const btOdf = new Float32Array(BT_BUF_LEN);
const btCumScore = new Float32Array(BT_BUF_LEN);
const btACorrBuf = new Float32Array(BT_MAX_LAG + 2);

let btIdx = 0;
let btPeriod = 0;
let btCounter = 999;
let btOdfEnergy = 0;
let btConfirmedBeats = 0;
let btShowBeats = false;
let btSilenceTimer = 0;
let btFrameCount = 0;
let btBeatCount = 0;
let btShowBpm = 0;
let btLastBeatTime = 0;
let btPhaseAccuracy = 0;
let btTempoCounter = 0;
let beatPulse = 0;

function btGaussWeight(dist, period) {
  const sigma = period * 0.15;
  return Math.exp(-0.5 * (dist * dist) / (sigma * sigma));
}

function btEstimateTempo() {
  for (let lag = BT_MIN_LAG; lag <= BT_MAX_LAG; lag++) {
    let corr = 0;
    const n = BT_BUF_LEN - lag;
    for (let i = 0; i < n; i++) {
      const a = (btIdx - 1 - i + BT_BUF_LEN) % BT_BUF_LEN;
      const b = (a - lag + BT_BUF_LEN) % BT_BUF_LEN;
      corr += btOdf[a] * btOdf[b];
    }
    btACorrBuf[lag] = corr;
  }
  let bestLag = BT_MIN_LAG;
  for (let lag = BT_MIN_LAG + 1; lag <= BT_MAX_LAG; lag++) {
    if (btACorrBuf[lag] > btACorrBuf[bestLag]) bestLag = lag;
  }
  // Compound time resolution (6/8, 9/8, 12/8)
  const compoundLag = Math.round(bestLag * 1.5);
  if (compoundLag >= BT_MIN_LAG && compoundLag <= BT_MAX_LAG) {
    const isLocalPeak = compoundLag > BT_MIN_LAG && compoundLag < BT_MAX_LAG &&
      btACorrBuf[compoundLag] > btACorrBuf[compoundLag - 1] &&
      btACorrBuf[compoundLag] > btACorrBuf[compoundLag + 1];
    if (isLocalPeak && btACorrBuf[compoundLag] > btACorrBuf[bestLag] * 0.6) bestLag = compoundLag;
  }
  // Double-time: prefer slower tempo
  const doubleLag = bestLag * 2;
  if (doubleLag >= BT_MIN_LAG && doubleLag <= BT_MAX_LAG) {
    const dl = Math.round(doubleLag);
    if (dl > BT_MIN_LAG && dl < BT_MAX_LAG) {
      const isLocalPeak = btACorrBuf[dl] > btACorrBuf[dl - 1] && btACorrBuf[dl] > btACorrBuf[dl + 1];
      if (isLocalPeak && btACorrBuf[dl] > btACorrBuf[bestLag] * 0.5) bestLag = dl;
    }
  }
  // Half-time: prefer faster if strong
  const halfLag = Math.round(bestLag / 2);
  if (halfLag >= BT_MIN_LAG + 2 && halfLag <= BT_MAX_LAG - 2) {
    const isLocalPeak = btACorrBuf[halfLag] > btACorrBuf[halfLag - 1] && btACorrBuf[halfLag] > btACorrBuf[halfLag + 1];
    if (isLocalPeak && btACorrBuf[halfLag] > btACorrBuf[bestLag] * 0.75) bestLag = halfLag;
  }
  // Parabolic interpolation
  if (bestLag > BT_MIN_LAG && bestLag < BT_MAX_LAG) {
    const prev = btACorrBuf[bestLag - 1], curr = btACorrBuf[bestLag], next = btACorrBuf[bestLag + 1];
    const denom = prev - 2 * curr + next;
    if (denom < -1e-12) {
      const shift = 0.5 * (prev - next) / denom;
      return bestLag + Math.max(-0.5, Math.min(0.5, shift));
    }
  }
  return bestLag;
}

// Reset beat tracker state (e.g. for new analysis run)
export function resetBeat() {
  btOdf.fill(0);
  btCumScore.fill(0);
  btACorrBuf.fill(0);
  btIdx = 0;
  btPeriod = 0;
  btCounter = 999;
  btOdfEnergy = 0;
  btConfirmedBeats = 0;
  btShowBeats = false;
  btSilenceTimer = 0;
  btFrameCount = 0;
  btBeatCount = 0;
  btShowBpm = 0;
  btLastBeatTime = 0;
  btPhaseAccuracy = 0;
  btTempoCounter = 0;
  beatPulse = 0;
  store.bpm = 0;
  store.beatPhaseAccuracy = 0;
}

// Call once per frame with the current onset detection function value.
// Returns { isBeat, bpm, phaseAccuracy, beatPulse } for the renderer.
export function updateBeat(odfVal, time) {
  btFrameCount++;

  btOdf[btIdx] = odfVal;

  if (btPeriod > 0) {
    const lookStart = Math.max(1, Math.round(btPeriod * 0.5));
    const lookEnd = Math.round(btPeriod * 2);
    let maxWeighted = 0;
    for (let i = lookStart; i <= lookEnd; i++) {
      const pastIdx = (btIdx - i + BT_BUF_LEN) % BT_BUF_LEN;
      const dist = Math.abs(i - Math.round(btPeriod));
      const val = btCumScore[pastIdx] * btGaussWeight(dist, btPeriod);
      if (val > maxWeighted) maxWeighted = val;
    }
    btCumScore[btIdx] = odfVal + maxWeighted;
  } else {
    btCumScore[btIdx] = odfVal;
  }

  btIdx = (btIdx + 1) % BT_BUF_LEN;

  let isBeat = false;
  btCounter--;
  if (btCounter <= 0) {
    const searchBack = Math.round(btPeriod);
    let bestScore = 0, bestOffset = 0;
    for (let i = 0; i < searchBack; i++) {
      const idx = (btIdx - 1 - i + BT_BUF_LEN) % BT_BUF_LEN;
      if (btCumScore[idx] > bestScore) { bestScore = btCumScore[idx]; bestOffset = i; }
    }
    const beatHadEnergy = bestScore > 0.01 && btOdfEnergy > 0.01;
    if (beatHadEnergy && btPeriod > 0) {
      btConfirmedBeats++;
      btSilenceTimer = 0;
      const phaseHit = 1 - Math.min(1, bestOffset / (btPeriod * 0.5));
      btPhaseAccuracy = btPhaseAccuracy * 0.7 + phaseHit * 0.3;
      if (btConfirmedBeats >= 6) btShowBeats = true;
      if (btShowBeats) {
        isBeat = true;
        beatPulse = 1;
        btLastBeatTime = time;
        btBeatCount++;
        if (btBeatCount % 10 === 0) btShowBpm = Math.round(3600 / btPeriod);
      }
    } else {
      btConfirmedBeats = Math.max(0, btConfirmedBeats - 1);
    }
    btCounter = Math.round(btPeriod) - Math.round(bestOffset * 0.2);
    btCounter = Math.max(Math.round(btPeriod * 0.7), btCounter);
  }

  btOdfEnergy = btOdfEnergy * 0.99 + odfVal * odfVal * 0.01;

  // Re-estimate tempo every ~0.5s
  btTempoCounter++;
  if (btTempoCounter >= 30) {
    btTempoCounter = 0;
    const newPeriod = btEstimateTempo();
    if (newPeriod >= BT_MIN_LAG && newPeriod <= BT_MAX_LAG) {
      if (btPeriod === 0) {
        btPeriod = newPeriod;
        btCounter = newPeriod;
      } else {
        const err = Math.abs(newPeriod - btPeriod) / btPeriod;
        const alpha = err > 0.15 ? 0.5 : err > 0.05 ? 0.3 : 0.15;
        btPeriod += alpha * (newPeriod - btPeriod);
      }
    }
  }

  btSilenceTimer++;
  if (btShowBeats && btSilenceTimer > 600) {
    btShowBeats = false;
    btConfirmedBeats = 0;
    btBeatCount = 0;
    btShowBpm = 0;
    btPeriod = 0;
    btCounter = 999;
  }

  // Decay beat pulse
  beatPulse *= 0.88;
  if (beatPulse < 0.01) beatPulse = 0;

  // Update store
  if (btPeriod > 0) {
    store.bpm = Math.round(3600 / btPeriod);
  }
  store.beatPhaseAccuracy = btPhaseAccuracy;
  store.isBeat = isBeat;
  store.beatShowBeats = btShowBeats;
  store.beatPulse = beatPulse;

  return {
    isBeat,
    bpm: btPeriod > 0 ? Math.round(3600 / btPeriod) : 0,
    showBeats: btShowBeats,
    showBpm: isBeat ? btShowBpm : 0,
    phaseAccuracy: btPhaseAccuracy,
    beatPulse,
    frameCount: btFrameCount,
  };
}
