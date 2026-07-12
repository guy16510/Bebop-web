import { resolve } from 'node:path';
import { PerceptionManager } from '../dist/src/perception.js';

const command = `node ${JSON.stringify(resolve('scripts/mock-perception-backend.mjs'))}`;
let trackingSnapshots = 0;
const manager = new PerceptionManager({
  backend: 'external',
  command,
  onUpdate(snapshot) {
    if (snapshot.trackingState === 'tracking') trackingSnapshots += 1;
  },
});

await manager.start();
const deadline = Date.now() + 4_000;
while (trackingSnapshots < 3 && Date.now() < deadline) {
  await new Promise((resolveWait) => setTimeout(resolveWait, 25));
}

const snapshot = manager.getSnapshot();
const health = manager.getHealth();
await manager.stop();

if (trackingSnapshots < 3) throw new Error(`Expected at least 3 tracking snapshots, got ${trackingSnapshots}`);
if (snapshot.detections.length < 1) throw new Error('Expected simulated object detections');
if (snapshot.map.landmarks.length < 20) throw new Error('Expected simulated map landmarks');
if (snapshot.trajectory.length < 3) throw new Error('Expected simulated trajectory');
if (health.invalidUpdates !== 0) throw new Error(`Backend emitted ${health.invalidUpdates} invalid updates`);

console.log(JSON.stringify({
  ok: true,
  backend: health.backend,
  trackingSnapshots,
  detections: snapshot.detections.length,
  landmarks: snapshot.map.landmarks.length,
  trajectoryPoints: snapshot.trajectory.length,
  trackedFeatures: snapshot.metrics.trackedFeatures,
}, null, 2));
