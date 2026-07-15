import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { RecognitionVisionManager } from './recognition-vision.js';

function detection(id: string, confidence: number, state: 'tentative' | 'confirmed') {
  return {
    id,
    label: 'chair',
    confidence,
    bbox: { x: 0.2, y: 0.2, width: 0.3, height: 0.4 },
    firstSeenAt: 1_000,
    lastSeenAt: 1_100,
    appearance: Array.from({ length: 32 }, (_, index) => index === 0 ? 1 : 0),
    observed: true,
    track: { state, ageFrames: 4, hits: 4, misses: 0 },
  };
}

describe('RecognitionVisionManager', () => {
  it('preserves tentative and low-confidence detections for generic flight safety', async () => {
    const payload = JSON.stringify({
      type: 'recognition-vision.snapshot',
      timestamp: 1_100,
      source: 'test-sidecar',
      detections: [
        detection('chair-tentative', 0.95, 'tentative'),
        detection('chair-low', 0.3, 'confirmed'),
        detection('chair-ready', 0.9, 'confirmed'),
      ],
      metrics: {
        inputFps: 30,
        detectionFps: 10,
        inferenceMs: 40,
        endToEndLatencyMs: 55,
        activeTracks: 3,
      },
    });
    const command = `printf '%s\\n' '${payload}'; sleep 1`;
    const manager = new RecognitionVisionManager({ command, enabled: true });
    manager.start();

    const deadline = Date.now() + 1_000;
    while (manager.getHealth().state !== 'running' && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    expect(manager.getHealth().state).toBe('running');
    expect(manager.getHealth().activeTracks).toBe(3);
    expect(manager.getSnapshot().detections.map((item) => item.id)).toEqual([
      'chair-tentative',
      'chair-low',
      'chair-ready',
    ]);
    await manager.stop();
  });

  it('launches the recognition container with Python and preserves SLAM detection by default', () => {
    const recognitionScript = readFileSync('scripts/run-recognition-sidecar.sh', 'utf8');
    const perceptionScript = readFileSync('scripts/run-perception-sidecar.sh', 'utf8');
    expect(recognitionScript).toContain('--entrypoint python3');
    expect(recognitionScript).toContain('/work/perception-sidecar/scripts/recognition_stream.py');
    expect(perceptionScript).toContain('RECOGNITION_ENABLED:-false');
  });
});
