const canvas = document.getElementById("gameCanvas");
const ctx = canvas.getContext("2d");
const startBtn = document.getElementById("startBtn");
const statusText = document.getElementById("statusText");

const lanes = 4;
const laneWidth = canvas.width / lanes;
let notes = [];

const rnn = new mm.MusicRNN(
  "https://storage.googleapis.com/magentadata/js/checkpoints/music_rnn/drum_kit_rnn"
);

// ✅ Initialize the Magenta RNN
async function initModel() {
  statusText.textContent = "Loading AI model... (this may take ~10s)";
  await rnn.initialize();
  statusText.textContent = "✅ Model ready!";
}

// 🧠 Define a quantized rhythm seed
const seed = {
  notes: [
    { pitch: 36, quantizedStartStep: 0, quantizedEndStep: 1 },
    { pitch: 38, quantizedStartStep: 2, quantizedEndStep: 3 },
  ],
  quantizationInfo: { stepsPerQuarter: 4 },
  totalQuantizedSteps: 4,
};

// 🎵 Generate new rhythm sequence
async function generateRhythm() {
  statusText.textContent = "🤖 Generating AI rhythm...";
  const steps = 32;
  const temperature = 1.1;
  const result = await rnn.continueSequence(seed, steps, temperature);
  statusText.textContent = "🎶 Rhythm ready!";
  console.log("AI notes:", result.notes);
  return result.notes;
}

// 🟩 Convert AI rhythm to falling notes
function spawnFromAI(aiNotes) {
  notes = aiNotes.map(n => ({
    lane: n.pitch % lanes,
    y: -n.quantizedStartStep * 50,
    speed: 2,
  }));
}

// 🎨 Draw the falling notes
function drawNotes() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  notes.forEach(n => {
    ctx.fillStyle = ["#f33", "#3f3", "#33f", "#ff3"][n.lane];
    ctx.fillRect(n.lane * laneWidth + 10, n.y, laneWidth - 20, 15);
    n.y += n.speed;
  });
  requestAnimationFrame(drawNotes);
}

// ▶️ Start button event
startBtn.onclick = async () => {
  startBtn.disabled = true;
  await initModel();
  const aiNotes = await generateRhythm();
  spawnFromAI(aiNotes);
  drawNotes();
  statusText.textContent = "🎵 Playing AI rhythm sequence!";
};
