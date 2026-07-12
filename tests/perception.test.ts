import { describe, expect, it } from 'vitest';
import {
  PerceptionManager,
  generateSimulationSnapshot,
  parsePerceptionSnapshot,
} from '../src/perception.js';

describe('perception simulation', () => {
  it('transitions from initialization to tracked map with detections', () => {
    const initializing = generateSimulationSnapshot(3, 1_000);
    const tracking = generateSimulationSnapshot(20, 2_000, [initializing.pose!]);

    expect(initializing.trackingState).toBe('initializing');
    expect(initializing.detections).toHaveLength(0);
    expect(tracking.trackingState).toBe('tracking');
    expect(tracking.calibrated).toBe(true);
    expect(tracking.scaleSource).toBe('telemetry');
    expect(tracking.detections.map((item) => item.label)).toContain('person');
    expect(tracking.map.landmarks.length).toBeGreaterThan(50);
    expect(tracking.metrics.trackedFeatures).toBeGreaterThan(250);
  });

  it('keeps generated snapshots inside normalized image and map bounds', () => {
    for (let sequence = 1; sequence <= 500; sequence += 1) {
      const snapshot = parsePerceptionSnapshot(generateSimulationSnapshot(sequence, sequence * 100));
      const bounds = snapshot.map.bounds;
      expect(snapshot.pose!.x).toBeGreaterThanOrEqual(bounds.minX);
      expect(snapshot.pose!.x).toBeLessThanOrEqual(bounds.maxX);
      expect(snapshot.pose!.y).toBeGreaterThanOrEqual(bounds.minY);
      expect(snapshot.pose!.y).toBeLessThanOrEqual(bounds.maxY);
      for (const detection of snapshot.detections) {
        expect(detection.bbox.x + detection.bbox.width).toBeLessThanOrEqual(1.0001);
        expect(detection.bbox.y + detection.bbox.height).toBeLessThanOrEqual(1.0001);
      }
    }
  });

  it('rejects malformed external output instead of rendering it', () => {
    const manager = new PerceptionManager({ backend: 'external', command: 'unused' });
    manager.ingestExternalMessage({ sequence: 1, trackingState: 'tracking' });
    expect(manager.getHealth().invalidUpdates).toBe(1);
    expect(manager.getHealth().state).toBe('fault');
  });

  it('bounds externally supplied trajectory and map data', () => {
    const manager = new PerceptionManager({
      backend: 'external',
      command: 'unused',
      maxTrajectoryPoints: 10,
      maxLandmarks: 12,
    });
    const snapshot = generateSimulationSnapshot(20, 2_000);
    manager.ingestExternalMessage({
      ...snapshot,
      backend: 'external',
      trajectory: Array.from({ length: 50 }, (_, index) => ({ ...snapshot.pose!, x: index })),
      map: {
        ...snapshot.map,
        landmarks: Array.from({ length: 40 }, (_, index) => ({
          id: `point-${index}`,
          position: { x: index, y: 0, z: 1 },
          observations: 3,
          quality: 0.8,
        })),
      },
    });
    expect(manager.getSnapshot().trajectory).toHaveLength(10);
    expect(manager.getSnapshot().map.landmarks).toHaveLength(12);
  });
});
