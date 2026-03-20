// Notes/chords strip + circle of fifths overlay.
// READS: store.chroma, detectedKey, detectedKeyConfidence, detectedChord,
//        detectedChordConfidence, signalPresent, noteEvents
// DISPLAY: 12-row piano roll with pitch-class coloring, chord text;
//          circle of fifths widget (bottom-left above timbre space)

import { PITCH_CLASS_COLORS, NOTE_LABELS } from '../../core/colormap.js';

const NOTE_ROWS = 12;
const chordNotes = new Uint8Array(12);

// Chord display smoothing
let displayKey = '', displayChord = '', pendingChord = '';
let keyHoldFrames = 0, chordHoldFrames = 0;

export const meta = { id: 'chroma', label: 'notes', defaultHeight: 0.10, type: 'strip' };

export function render(ctx, x, y, w, h, env) {
  const { store: s, frameCount } = env;

  // Key + chord display smoothing
  if (!s.signalPresent) {
    displayKey = ''; displayChord = '';
    keyHoldFrames = 0; chordHoldFrames = 0;
  } else {
    if (s.detectedKeyConfidence > 0.3 && s.detectedKey) displayKey = s.detectedKey;
    if (s.detectedChord && s.detectedChordConfidence > 0.3) {
      if (s.detectedChord === displayChord) { chordHoldFrames = 0; }
      else if (s.detectedChord === pendingChord) {
        chordHoldFrames++;
        if (chordHoldFrames > 8) { displayChord = pendingChord; chordHoldFrames = 0; }
      } else { pendingChord = s.detectedChord; chordHoldFrames = 1; }
    }
    if (!s.detectedChord || s.detectedChordConfidence < 0.1) {
      chordHoldFrames++;
      if (chordHoldFrames > 30) { displayChord = ''; chordHoldFrames = 0; }
    }
  }

  // Parse chord notes
  chordNotes.fill(0);
  if (s.signalPresent && s.detectedChordConfidence > 0.4 && displayChord) {
    let rootIdx = -1, chordSuffix = '';
    for (let ni = 0; ni < 12; ni++) {
      if (displayChord.startsWith(NOTE_LABELS[ni])) {
        if (NOTE_LABELS[ni].length > 1 || rootIdx < 0) {
          rootIdx = ni; chordSuffix = displayChord.slice(NOTE_LABELS[ni].length);
        }
      }
    }
    if (rootIdx >= 0) {
      if (chordSuffix === 'm' || chordSuffix === 'm7') {
        chordNotes[rootIdx % 12] = 1; chordNotes[(rootIdx + 3) % 12] = 1; chordNotes[(rootIdx + 7) % 12] = 1;
        if (chordSuffix === 'm7') chordNotes[(rootIdx + 10) % 12] = 1;
      } else if (chordSuffix === 'dim') {
        chordNotes[rootIdx % 12] = 1; chordNotes[(rootIdx + 3) % 12] = 1; chordNotes[(rootIdx + 6) % 12] = 1;
      } else if (chordSuffix === '7') {
        chordNotes[rootIdx % 12] = 1; chordNotes[(rootIdx + 4) % 12] = 1;
        chordNotes[(rootIdx + 7) % 12] = 1; chordNotes[(rootIdx + 10) % 12] = 1;
      } else {
        chordNotes[rootIdx % 12] = 1; chordNotes[(rootIdx + 4) % 12] = 1; chordNotes[(rootIdx + 7) % 12] = 1;
      }
    }
  }

  // Draw 12 pitch-class rows
  for (let row = 0; row < NOTE_ROWS; row++) {
    const energy = Math.max(0, s.chroma[row]);
    const isChordTone = chordNotes[row] === 1;
    const [cR, cG, cB] = PITCH_CLASS_COLORS[row];
    const yTop = y + Math.round((NOTE_ROWS - 1 - row) / NOTE_ROWS * h);
    const yBot = y + Math.round((NOTE_ROWS - row) / NOTE_ROWS * h);
    const noteOn = energy > 0.15 && s.signalPresent;

    if (noteOn && isChordTone) {
      const v = Math.min(1, energy * 1.5);
      ctx.fillStyle = `rgb(${Math.round(cR * v)},${Math.round(cG * v)},${Math.round(cB * v)})`;
    } else if (noteOn) {
      const v = Math.min(1, energy) * 0.25;
      ctx.fillStyle = `rgb(${Math.round(cR * v)},${Math.round(cG * v)},${Math.round(cB * v)})`;
    } else {
      ctx.fillStyle = 'rgb(4,4,8)';
    }
    ctx.fillRect(x, yTop, w, yBot - yTop);
    ctx.fillStyle = 'rgba(30,30,40,1)';
    ctx.fillRect(x, yBot - 1, w, 1);
  }

  // Chord text overlay
  if (displayChord && s.signalPresent && frameCount % 60 === 0) {
    const fontSize = Math.round(h * 0.28);
    ctx.font = `bold ${fontSize}px sans-serif`;
    ctx.fillStyle = 'rgba(255,255,200,0.8)';
    ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    ctx.fillText(displayChord, x - 4, y + h / 2);
    ctx.textAlign = 'left';
  }

  // Basic Pitch transcribed notes
  if (s.noteEvents && s.noteEvents.length > 0) {
    const now = performance.now();
    for (const note of s.noteEvents) {
      const age = (now - note.startTime) / 1000;
      if (age > 10) continue;
      const pc = note.pitchMidi % 12;
      const yTop = y + Math.round((NOTE_ROWS - 1 - pc) / NOTE_ROWS * h);
      const yBot = y + Math.round((NOTE_ROWS - pc) / NOTE_ROWS * h);
      const alpha = Math.min(0.9, note.amplitude * 1.2);
      ctx.fillStyle = `rgba(255,255,255,${alpha * 0.3})`;
      ctx.fillRect(x, yTop + 1, w, yBot - yTop - 2);
    }
  }
}

// Overlay: Circle of Fifths
export function renderOverlay(oCtx, env) {
  const { store: s, CANVAS_W, CANVAS_H, DPR, getStripLayout } = env;

  const TIMBRE_SZ = Math.round(Math.min(CANVAS_H * 0.09, CANVAS_W * 0.10));
  const pad = Math.round(8 * DPR);
  const cofSize = Math.round(Math.min(CANVAS_H * 0.12, CANVAS_W * 0.12));
  const cofX = pad, cofY = CANVAS_H - TIMBRE_SZ - cofSize - pad * 3;
  const cofCx = cofX + cofSize / 2, cofCy = cofY + cofSize / 2;
  const outerR = cofSize / 2;

  const COF_MAJOR = ['C', 'G', 'D', 'A', 'E', 'B', 'F#', 'C#', 'G#', 'D#', 'A#', 'F'];
  const COF_MINOR = ['Am', 'Em', 'Bm', 'F#m', 'C#m', 'G#m', 'D#m', 'A#m', 'Fm', 'Cm', 'Gm', 'Dm'];

  let detKeyIdx = -1, detKeyIsMajor = true;
  if (displayKey) {
    const parts = displayKey.split(' ');
    if (parts[1] === 'maj') { detKeyIdx = COF_MAJOR.indexOf(parts[0]); detKeyIsMajor = true; }
    else if (parts[1] === 'min') { detKeyIdx = COF_MINOR.indexOf(parts[0] + 'm'); detKeyIsMajor = false; }
  }

  oCtx.beginPath(); oCtx.arc(cofCx, cofCy, outerR, 0, Math.PI * 2);
  oCtx.fillStyle = 'rgba(0,0,0,0.65)'; oCtx.fill();

  const majorR = outerR * 0.85, minorR = outerR * 0.52, innerR = outerR * 0.35;
  oCtx.beginPath(); oCtx.arc(cofCx, cofCy, outerR * 0.68, 0, Math.PI * 2);
  oCtx.strokeStyle = 'rgba(60,60,60,0.5)'; oCtx.lineWidth = 1; oCtx.stroke();
  oCtx.beginPath(); oCtx.arc(cofCx, cofCy, innerR, 0, Math.PI * 2);
  oCtx.strokeStyle = 'rgba(60,60,60,0.4)'; oCtx.stroke();

  for (let i = 0; i < 12; i++) {
    const angle = (i * 30 - 90 - 15) * Math.PI / 180;
    oCtx.beginPath();
    oCtx.moveTo(cofCx + innerR * Math.cos(angle), cofCy + innerR * Math.sin(angle));
    oCtx.lineTo(cofCx + outerR * Math.cos(angle), cofCy + outerR * Math.sin(angle));
    oCtx.strokeStyle = 'rgba(50,50,50,0.4)'; oCtx.lineWidth = 1; oCtx.stroke();
  }

  if (detKeyIdx >= 0 && s.signalPresent) {
    const startAngle = (detKeyIdx * 30 - 90 - 15) * Math.PI / 180;
    const endAngle = (detKeyIdx * 30 - 90 + 15) * Math.PI / 180;
    const hlR = detKeyIsMajor ? outerR : outerR * 0.68;
    const hlInner = detKeyIsMajor ? outerR * 0.68 : innerR;
    oCtx.beginPath();
    oCtx.arc(cofCx, cofCy, hlR, startAngle, endAngle);
    oCtx.arc(cofCx, cofCy, hlInner, endAngle, startAngle, true);
    oCtx.closePath(); oCtx.fillStyle = 'rgba(80,180,255,0.45)'; oCtx.fill();
  }

  const majFontSz = Math.max(6, Math.round(cofSize * 0.08));
  const minFontSz = Math.max(5, Math.round(cofSize * 0.065));
  for (let i = 0; i < 12; i++) {
    const angle = (i * 30 - 90) * Math.PI / 180;
    const mx = cofCx + majorR * Math.cos(angle), my = cofCy + majorR * Math.sin(angle);
    oCtx.font = `${detKeyIdx === i && detKeyIsMajor ? 'bold ' : ''}${majFontSz}px sans-serif`;
    oCtx.textAlign = 'center'; oCtx.textBaseline = 'middle';
    oCtx.fillStyle = detKeyIdx === i && detKeyIsMajor ? 'rgba(140,220,255,0.95)' : 'rgba(180,180,180,0.6)';
    oCtx.fillText(COF_MAJOR[i], mx, my);
    const nx = cofCx + minorR * Math.cos(angle), ny = cofCy + minorR * Math.sin(angle);
    oCtx.font = `${detKeyIdx === i && !detKeyIsMajor ? 'bold ' : ''}${minFontSz}px sans-serif`;
    oCtx.fillStyle = detKeyIdx === i && !detKeyIsMajor ? 'rgba(140,220,255,0.95)' : 'rgba(140,140,140,0.5)';
    oCtx.fillText(COF_MINOR[i], nx, ny);
  }

  if (displayChord && s.signalPresent) {
    oCtx.font = `bold ${Math.max(7, Math.round(cofSize * 0.12))}px sans-serif`;
    oCtx.textAlign = 'center'; oCtx.textBaseline = 'middle';
    oCtx.fillStyle = 'rgba(255,255,200,0.9)';
    oCtx.fillText(displayChord, cofCx, cofCy);
  }

  oCtx.beginPath(); oCtx.arc(cofCx, cofCy, outerR, 0, Math.PI * 2);
  oCtx.strokeStyle = 'rgba(100,100,100,0.5)'; oCtx.lineWidth = 1; oCtx.stroke();
}
