const fileEl = document.getElementById('file');
const btn = document.getElementById('transcribeBtn');
const status = document.getElementById('status');

const canvas = document.getElementById('gameCanvas');
const ctx = canvas.getContext('2d');

const laneKeys = ['a','s','k','l']; // 4 lanes
const lanes = laneKeys.length;
const laneW = canvas.width / lanes;
let notes = [];
let score = 0;

let audioBuffer = null;

// ---------- Load Audio ----------
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
  let seq = await transcribeBufferApprox(audioBuffer);

  // Reduce note density by merging close notes
  const minGap = 0.15; // seconds
  seq.sort((a,b)=>a.startTime-b.startTime);
  const filtered = [];
  for (let n of seq) {
    if (filtered.length===0 || n.startTime - filtered[filtered.length-1].startTime > minGap) filtered.push(n);
  }

  status.textContent = `Found ${filtered.length} notes. Playing and spawning...`;
  playBufferWithNotes(audioBuffer, filtered);
});

// ---------- Utilities ----------
async function readFileToAudioBuffer(file) {
  return new Promise((res, rej) => {
    const fr = new FileReader();
    fr.onload = async () => {
      try {
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

// ---------- Transcription ----------
async function transcribeBufferApprox(buffer) {
  const sampleRate = buffer.sampleRate;
  const channelData = buffer.getChannelData(0); // mono
  const frameSize = 2048;
  const hopSize = 512;
  const frames = [];

  for (let i = 0; i + frameSize < channelData.length; i += hopSize) {
    const frame = channelData.subarray(i, i + frameSize);
    const win = applyHann(frame);
    const mags = fftMag(win);
    frames.push({ mags, time: i / sampleRate });
  }

  const flux = new Float32Array(frames.length);
  for (let i = 1; i < frames.length; i++) {
    let sum = 0;
    const A = frames[i-1].mags;
    const B = frames[i].mags;
    for (let k = 0; k < B.length; k++) sum += Math.max(0, B[k] - (A[k]||0));
    flux[i] = sum;
  }

  let maxF = Math.max(...flux);
  if (maxF > 0) for (let i=0;i<flux.length;i++) flux[i] /= maxF;

  const onsets = [];
  const threshold = 0.2;
  for (let i = 2; i < flux.length-2; i++) {
    if (flux[i] > threshold && flux[i] > flux[i-1] && flux[i] >= flux[i+1]) {
      onsets.push(frames[i].time);
    }
  }

  const notesArr = [];
  for (let t of onsets) {
    const centerSample = Math.floor(t * sampleRate);
    const winSize = 2048;
    const start = Math.max(0, centerSample - Math.floor(winSize/2));
    const end = Math.min(channelData.length, start + winSize);
    const slice = channelData.subarray(start, end);
    const f0 = detectPitchAutocorr(slice, sampleRate);
    if (f0 && f0 > 80 && f0 < 2000) {
      const midi = freqToMidi(f0);
      // Map to 4 lanes
      const lane = Math.floor(((Math.max(40, Math.min(88, midi)) - 40) / (88 - 40)) * lanes);
      notesArr.push({ startTime: t, lane, y: -20, speed: 3 });
    }
  }

  return notesArr;
}

// ---------- Playback ----------
function playBufferWithNotes(buffer, seq) {
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  src.connect(ctx.destination);
  const startAt = ctx.currentTime + 0.5;
  src.start(startAt);

  notes = [];
  score = 0;

  seq.forEach(n => {
    const when = startAt + n.startTime;
    setTimeout(() => spawnVisualNote(n), Math.max(0, (when - ctx.currentTime - 0.5) * 1000));
  });

  lastTime = performance.now();
  requestAnimationFrame(visualLoop);
}

function spawnVisualNote(note) {
  notes.push(note);
}

// ---------- Visuals ----------
function draw() {
  ctx.clearRect(0,0,canvas.width,canvas.height);

  // Draw lanes
  for (let i=0;i<lanes;i++){
    ctx.fillStyle = '#111';
    ctx.fillRect(i*laneW,0,laneW-2,canvas.height);

    ctx.fillStyle = '#eee';
    ctx.font = '16px sans-serif';
    ctx.fillText(laneKeys[i].toUpperCase(), i*laneW + laneW/2 - 5, canvas.height - 10);
  }

  // Draw hit line
  const hitY = canvas.height - 60;
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(0, hitY);
  ctx.lineTo(canvas.width, hitY);
  ctx.stroke();

  // Draw notes
  notes.forEach(n=>{
    ctx.fillStyle = ['#e74c3c','#f1c40f','#2ecc71','#3498db'][n.lane];
    ctx.fillRect(n.lane*laneW + 6, n.y, laneW-12, 16);
    n.y += n.speed;
  });

  // Draw score
  ctx.fillStyle = '#fff';
  ctx.font = '20px sans-serif';
  ctx.fillText('Score: ' + score, 10, 25);
}

let lastTime = 0;
function visualLoop(ts) {
  lastTime = lastTime || ts;
  notes = notes.filter(n => n.y < canvas.height + 50);
  draw();
  requestAnimationFrame(visualLoop);
}

// ---------- Input ----------
window.addEventListener('keydown', e => {
  const key = e.key.toLowerCase();
  const lane = laneKeys.indexOf(key);
  if (lane === -1) return;

  for (let i=0;i<notes.length;i++) {
    const n = notes[i];
    if (n.lane === lane && n.y > canvas.height - 80 && n.y < canvas.height - 40) {
      notes.splice(i,1);
      score += 1;
      break;
    }
  }
});

// ---------- DSP helpers ----------
function applyHann(frame) {
  const out = new Float32Array(frame.length);
  for (let i=0;i<frame.length;i++) out[i] = frame[i]*0.5*(1 - Math.cos(2*Math.PI*i/(frame.length-1)));
  return out;
}

function fftMag(frame) {
  const N = 512;
  const mags = new Float32Array(N);
  for (let k = 0;k<N;k++){
    let re=0, im=0;
    for(let n=0;n<frame.length;n+=4){
      const v=frame[n];
      re += v*Math.cos(-2*Math.PI*k*n/frame.length);
      im += v*Math.sin(-2*Math.PI*k*n/frame.length);
    }
    mags[k] = Math.sqrt(re*re + im*im);
  }
  return mags;
}

function detectPitchAutocorr(buffer, sampleRate) {
  const x = new Float32Array(buffer.length);
  let rms=0;
  for(let i=0;i<buffer.length;i++){x[i]=buffer[i]; rms+=x[i]*x[i];}
  rms=Math.sqrt(rms/buffer.length);
  if(rms<0.002) return null;

  const maxLag=Math.floor(sampleRate/80);
  const minLag=Math.floor(sampleRate/1000);
  let bestLag=-1,bestCorr=0;
  for(let lag=minLag;lag<=maxLag;lag++){
    let corr=0;
    for(let i=0;i+lag<buffer.length;i++) corr+=x[i]*x[i+lag];
    if(corr>bestCorr){bestCorr=corr; bestLag=lag;}
  }
  if(bestLag<=0) return null;
  return sampleRate/bestLag;
}

function freqToMidi(freq){
  return Math.round(69+12*Math.log2(freq/440));
}
