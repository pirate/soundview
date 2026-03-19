// Core audio engine: mic capture, AudioContext, and full-spectrum analyser.
// READS: nothing
// WRITES: creates AudioContext, inputGain node, fullAnalyser node
// DEPENDS ON: nothing (first in boot sequence)

let audioContext = null;
let sourceNode = null;
let inputGain = null;
let fullAnalyser = null;

export async function initAudio() {
  audioContext = new AudioContext({ latencyHint: 'interactive' });

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    },
  });

  sourceNode = audioContext.createMediaStreamSource(stream);
  inputGain = audioContext.createGain();
  inputGain.gain.value = 1.0;
  sourceNode.connect(inputGain);

  fullAnalyser = audioContext.createAnalyser();
  fullAnalyser.fftSize = 8192;
  fullAnalyser.smoothingTimeConstant = 0;
  inputGain.connect(fullAnalyser);

  return { audioContext, inputGain, fullAnalyser };
}

export function getAudioContext() { return audioContext; }
export function getFullAnalyser() { return fullAnalyser; }
