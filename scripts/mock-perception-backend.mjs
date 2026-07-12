import { createInterface } from 'node:readline';

let timer;
let sequence = 0;
let trajectory = [];

function poseFor(step) {
  const angle = (step % 360) * Math.PI / 180;
  return {
    x: Math.cos(angle) * 4,
    y: Math.sin(angle) * 3,
    z: 1.2,
    roll: 0,
    pitch: 0,
    yaw: angle + Math.PI / 2,
  };
}

function snapshot() {
  sequence += 1;
  const timestamp = Date.now();
  const pose = poseFor(sequence);
  trajectory = [...trajectory, pose].slice(-900);
  const initializing = sequence < 4;
  return {
    sequence,
    timestamp,
    backend: 'external',
    source: 'mock-orb-slam3-yolox-sidecar',
    trackingState: initializing ? 'initializing' : 'tracking',
    calibrated: !initializing,
    scaleSource: initializing ? 'monocular' : 'telemetry',
    pose,
    trajectory,
    detections: initializing ? [] : [{
      id: 'person-1',
      label: 'person',
      recognizedName: 'Person',
      confidence: 0.93,
      bbox: { x: 0.2, y: 0.15, width: 0.22, height: 0.68 },
      worldPosition: { x: 1.8, y: 0.8, z: 0 },
      firstSeenAt: timestamp - 500,
      lastSeenAt: timestamp,
    }],
    map: {
      bounds: { minX: -6, maxX: 6, minY: -5, maxY: 5, minZ: 0, maxZ: 3 },
      landmarks: Array.from({ length: initializing ? sequence * 8 : 48 }, (_, index) => ({
        id: `mock-${index}`,
        position: { x: -5 + (index % 12), y: -4 + Math.floor(index / 12) * 2.5, z: 0.4 + (index % 5) * 0.3 },
        observations: 3 + sequence,
        quality: 0.8,
      })),
    },
    metrics: {
      inputFps: 30,
      slamFps: 26,
      detectionFps: 10,
      inferenceMs: 32,
      endToEndLatencyMs: 49,
      trackedFeatures: 280,
      keyframes: Math.floor(sequence / 5),
      loopClosures: 0,
    },
  };
}

function start() {
  clearInterval(timer);
  timer = setInterval(() => {
    process.stdout.write(`${JSON.stringify({ type: 'perception.snapshot', snapshot: snapshot() })}\n`);
  }, 50);
}

const input = createInterface({ input: process.stdin });
input.on('line', (line) => {
  const message = JSON.parse(line);
  if (message.type === 'start') start();
  if (message.type === 'reset') {
    sequence = 0;
    trajectory = [];
  }
  if (message.type === 'stop') {
    clearInterval(timer);
    process.exit(0);
  }
});

process.on('SIGTERM', () => {
  clearInterval(timer);
  process.exit(0);
});
