// script.js - approximate transcription (onset + pitch) and simple falling-note demo

const fileEl = document.getElementById('file');
const btn = document.getElementById('transcribeBtn');
const status = document.getElementById('status');

const canvas = document.getElementById('gameCanvas');
const ctx = canvas.getContext('2d');
const lanes = 8; // we'll map pitch into 8 lanes
const laneW = canvas.width / lanes;
let notes = [];

let audioBuffer = null;

fileEl.addEventListener('change', async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  status.textContent = `Loading "${f.name}"...`;
  audioBuffer = await readFileToAudioBuffer(f);
  status.textContent = `Loaded ${Math.round(audioBuffer.duration*10)/10}s. Ready to transcribe.`;
  btn.disabled = false;
});

btn.addEventListener('click', async () => {
  if (!audioBuffer) return;
  btn.disabled = true;
  status.textContent = 'Transcribing (approx)...';
  const seq = await transcribeBufferApprox(audioBuffer);
  status.textContent = `Found ${seq.length} notes. Playing and spawning...`;
  // spawn notes timed to audio playback
  playBufferWithNotes(audioBuffer, seq);
});

// ---------- Utilities: read file to AudioBuffer using AudioContext ----------
async function readFileToAudioBuffer(file) {
  return new Promise((res, rej) => {
    const fr = new FileReader();
    fr.onload = async () => {
      try {
        const ac = new (window.OfflineAudioContext || window.webkitOfflineAudioContext)(1, 1, 44100);
        const arrayBuffer = fr.result;
        const decodeAC = new (window.AudioContext || window.webkitAudioContext)();
        const buf = await decodeAC.decodeAudioData(arrayBuffer.slice(0));
        decodeAC.close && decodeAC.close();
        res(buf);
      } catch (err) { rej(err); }
    };
    fr.onerror = () => rej(fr.error);
    fr.readAsArrayBuffer(file);
  });
}

// ---------- Transcription pipeline ----------
async function transcribeBufferApprox(buffer) {
  // 1) Parameters
  const sampleRate = buffer.sampleRate;
  const channelData = buffer.getChannelData(0); // mono (use first channel)
  const frameSize = 2048;
  const hopSize = 512;
  const frames = [];
  // 2) compute magnitude spectrogram (frames)
  for (let i = 0; i + frameSize < channelData.length; i += hopSize) {
    const frame = channelData.subarray(i, i + frameSize);
    const win = applyHann(frame);
    const mags = fftMag(win);
    frames.push({ mags, time: i / sampleRate });
  }
  // 3) spectral flux onset detection
  const flux = new Float32Array(frames.length);
  for (let i = 1; i < frames.length; i++) {
    let sum = 0;
    const A = frames[i-1].mags;
    const B = frames[i].mags;
    for (let k = 0; k < B.length; k++) {
      const diff = Math.max(0, B[k] - (A[k]||0));
      sum += diff;
    }
    flux[i] = sum;
  }
  // normalize flux
  let maxF = 0; for (let v of flux) if (v> maxF) maxF = v;
  if (maxF > 0) for (let i=0;i<flux.length;i++) flux[i] /= maxF;
  // pick onsets: local peaks above threshold
  const onsets = [];
  const threshold = 0.2; // tweak
  for (let i = 2; i < flux.length-2; i++) {
    if (flux[i] > threshold && flux[i] > flux[i-1] && flux[i] >= flux[i+1]) {
      onsets.push(frames[i].time);
    }
  }
  // 4) For each onset, estimate pitch using autocorrelation on a short window
  const notes = [];
  for (let t of onsets) {
    const centerSample = Math.floor(t * sampleRate);
    const winSize = 2048;
    const start = Math.max(0, centerSample - Math.floor(winSize/2));
    const end = Math.min(channelData.length, start + winSize);
    const slice = channelData.subarray(start, end);
    const f0 = detectPitchAutocorr(slice, sampleRate);
    if (f0 && f0 > 80 && f0 < 2000) {
      const midi = freqToMidi(f0);
      notes.push({ time: t, pitch: midi });
    }
  }
  // 5) Merge close notes (de-duplicate)
  const merged = [];
  const minGap = 0.08; // seconds
  notes.sort((a,b)=>a.time-b.time);
  for (let n of notes) {
    if (merged.length===0 || n.time - merged[merged.length-1].time > minGap) merged.push(n);
  }
  // 6) Quantize times to nearest 16th note at estimated bpm (estimate BPM from autocorrelated inter-onset intervals)
  const ioi = [];
  for (let i=1;i<merged.length;i++) ioi.push(merged[i].time - merged[i-1].time);
  const estBPM = estimateBpmFromIOI(ioi) || 120;
  const beatSec = 60 / estBPM;
  // use 4 steps per beat (16th) => stepDur = beatSec/4
  const stepDur = beatSec / 4;
  const quantized = merged.map(n => ({
    startTime: Math.round(n.time / stepDur) * stepDur,
    pitch: n.pitch
  }));
  // compress repeats (keep earliest of duplicates)
  const out = [];
  for (let q of quantized) {
    if (out.length === 0 || Math.abs(q.startTime - out[out.length-1].startTime) > 0.0001) out.push(q);
  }
  // convert to simple NoteSequence-like array
  const seq = out.map(o => ({ startTime: o.startTime, pitch: o.pitch }));
  console.log('estBPM', estBPM, 'notes', seq.length);
  return seq;
}

// ---------- Playback + spawn notes ----------
function playBufferWithNotes(buffer, seq) {
  // create real AudioContext to play
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  src.connect(ctx.destination);
  const startAt = ctx.currentTime + 0.5;
  src.start(startAt);
  // schedule spawn of notes relative to startAt
  notes = []; // reset visual notes
  seq.forEach(n => {
    const when = startAt + n.startTime;
    const lane = pitchToLane(n.pitch);
    // spawn slightly ahead (so it falls into view)
    setTimeout(() => {
      spawnVisualNote(lane);
    }, Math.max(0, (when - ctx.currentTime - 0.5) * 1000)); // schedule with small prebuffer
  });
  // start visual loop
  lastTime = performance.now();
  requestAnimationFrame(visualLoop);
}

// ---------- Visual note helpers ----------
function spawnVisualNote(lane) {
  notes.push({ lane, y: -20, speed: 2 + Math.random()*1.5 });
}
function draw() {
  ctx.clearRect(0,0,canvas.width,canvas.height);
  // draw lanes
  for (let i=0;i<lanes;i++) {
    ctx.fillStyle = '#111';
    ctx.fillRect(i*laneW, 0, laneW-2, canvas.height);
  }
  // draw notes
  notes.forEach(n=>{
    ctx.fillStyle = ['#e74c3c','#f1c40f','#2ecc71','#3498db','#9b59b6','#1abc9c','#e67e22','#ecf0f1'][n.lane%8];
    ctx.fillRect(n.lane*laneW + 6, n.y, laneW-12, 16);
    n.y += n.speed;
  });
}
let lastTime = 0;
function visualLoop(ts) {
  const dt = (ts - lastTime) / 16;
  lastTime = ts;
  // remove offscreen
  notes = notes.filter(n => n.y < canvas.height + 50);
  draw();
  requestAnimationFrame(visualLoop);
}

// ---------- DSP helpers ----------

function applyHann(frame) {
  const out = new Float32Array(frame.length);
  for (let i=0;i<frame.length;i++) {
    const w = 0.5*(1 - Math.cos(2*Math.PI*i/(frame.length-1)));
    out[i] = frame[i]*w;
  }
  return out;
}

// rudimentary FFT mag (using WebAudio Analyser via offline context is faster in many cases,
// but we implement simple FFT using library-free approach: use built-in FFT via OfflineAudioContext trick)
function fftMag(frame) {
  // Use JS FFT via creating OfflineAudioContext and AnalyserNode is heavy; as an approximation,
  // compute DFT magnitude for low resolution: take small number of bins via simple DFT
  const N = 512; // bins to compute
  const mags = new Float32Array(N);
  for (let k=0;k<N;k++) {
    let re = 0, im = 0;
    for (let n=0;n<frame.length;n+=4) { // downsample to reduce compute
      const v = frame[n];
      re += v * Math.cos(-2*Math.PI*k*n/frame.length);
      im += v * Math.sin(-2*Math.PI*k*n/frame.length);
    }
    mags[k] = Math.sqrt(re*re + im*im);
  }
  return mags;
}

// autocorrelation pitch detection (simple)
function detectPitchAutocorr(buffer, sampleRate) {
  // normalize
  const x = new Float32Array(buffer.length);
  let rms = 0;
  for (let i=0;i<buffer.length;i++){ x[i]=buffer[i]; rms+=x[i]*x[i]; }
  rms = Math.sqrt(rms/buffer.length);
  if (rms < 0.002) return null; // too quiet
  // autocorrelation
  const maxLag = Math.floor(sampleRate / 80); // lowest 80 Hz
  const minLag = Math.floor(sampleRate / 1000); // highest 1000 Hz
  let bestLag = -1;
  let bestCorr = 0;
  for (let lag = minLag; lag <= maxLag; lag++) {
    let corr = 0;
    for (let i=0;i+lag<buffer.length;i+=1) corr += x[i]*x[i+lag];
    if (corr > bestCorr) { bestCorr = corr; bestLag = lag; }
  }
  if (bestLag <= 0) return null;
  const freq = sampleRate / bestLag;
  return freq;
}

function freqToMidi(freq) {
  return Math.round(69 + 12*Math.log2(freq/440));
}

// map MIDI pitch to lane (simple linear)
function pitchToLane(midi) {
  // clamp typical piano range 48..84
  const min = 40, max = 88;
  const c = Math.max(min, Math.min(max, midi));
  const t = (c - min) / (max - min);
  return Math.floor(t * (lanes - 1));
}

// estimate BPM using histogram of IOIs
function estimateBpmFromIOI(ioiArr) {
  if (!ioiArr || ioiArr.length < 2) return null;
  // convert IOIs to BPM suggestions (60/ioi)
  const bpmCounts = {};
  for (let dt of ioiArr) {
    if (dt <= 0.02) continue;
    const bpm = 60 / dt;
    // normalize to [60,180] by scaling octaves
    let b = bpm;
    while (b < 60) b *= 2;
    while (b > 180) b /= 2;
    const key = Math.round(b);
    bpmCounts[key] = (bpmCounts[key] || 0) + 1;
  }
  let best = null, bestCount = 0;
  for (const k in bpmCounts) {
    if (bpmCounts[k] > bestCount) { best = parseInt(k); bestCount = bpmCounts[k]; }
  }
  return best;
}
