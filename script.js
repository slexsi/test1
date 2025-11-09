const canvas = document.getElementById("gameCanvas");
const ctx = canvas.getContext("2d");
const startBtn = document.getElementById("startBtn");

const lanes = 4;
const laneWidth = canvas.width / lanes;
let notes = [];
let lastTime = 0;

const rnn = new mm.MusicRNN(
  "https://storage.googleapis.com/magentadata/js/checkpoints/music_rnn/drum_kit_rnn"
);

async function initModel() {
  await rnn.initialize();
  console.log("✅ Magenta model ready");
}

// ---- Correct Quantized Seed ----
const seed = {
  notes: [
    { pitch: 36, quantizedStartStep: 0, quantizedEndStep: 1 },
    { pitch: 38, quantizedStartStep: 2, quantizedEndStep: 3 },
  ],
  quantizationInfo: { stepsPerQuarter: 4 },
  totalQuantizedSteps: 4,
};

// ---- Generate Rhythm (quantized) ----
async function generateRhythm() {
  const steps = 32;
  const temperature = 1.1;
  const result = await rnn.continueSequence(seed, steps, temperature);
  console.log("AI notes:", result.notes);
  return result.notes;
}


// Convert Magenta notes → game notes
function spawnFromAI(aiNotes) {
  notes = aiNotes.map(n => ({
    lane: n.pitch % lanes,
    y: -n.startTime * 600, // higher startTime → later spawn
    speed: 1.5,
  }));
}

// Draw notes
function drawNotes() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  notes.forEach(n => {
    ctx.fillStyle = ["#f33", "#3f3", "#33f", "#ff3"][n.lane];
    ctx.fillRect(n.lane * laneWidth + 10, n.y, laneWidth - 20, 15);
    n.y += n.speed;
  });
  requestAnimationFrame(drawNotes);
}

// Start button
startBtn.onclick = async () => {
  startBtn.disabled = true;
  await initModel();
  const aiNotes = await generateRhythm();
  spawnFromAI(aiNotes);
  drawNotes();
};
