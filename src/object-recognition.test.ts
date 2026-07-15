import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ObjectRecognitionManager, type RecognizableDetection } from './object-recognition.js';

function vector(seed: number, drift = 0): number[] {
  const raw = Array.from({ length: 64 }, (_, index) => {
    const position = index + 1;
    return Math.sin(seed * position * 1.731)
      + Math.cos((seed + 3) * position * 0.713)
      + drift * Math.sin(position * 2.17);
  });
  const norm = Math.sqrt(raw.reduce((sum, value) => sum + value * value, 0));
  return raw.map((value) => value / norm);
}

function detection(
  id: string,
  label: string,
  appearance: number[],
  timestamp = 1_000,
  options: { confidence?: number; state?: 'tentative' | 'confirmed' } = {},
): RecognizableDetection {
  return {
    id,
    label,
    confidence: options.confidence ?? 0.9,
    bbox: { x: 0.2, y: 0.2, width: 0.3, height: 0.4 },
    firstSeenAt: timestamp - 100,
    lastSeenAt: timestamp,
    appearance,
    observed: true,
    track: { state: options.state ?? 'confirmed', ageFrames: 8, hits: 8, misses: 0 },
  };
}

describe('ObjectRecognitionManager', () => {
  it('requires diverse samples and distinct detector observations before confirmation', () => {
    let now = 1_000;
    const manager = new ObjectRecognitionManager({ now: () => now, minimumSamples: 3 });
    const object = manager.enroll('Red chair', detection('chair-1', 'chair', vector(1), now));
    expect('descriptor' in object.samples[0]).toBe(false);
    manager.addSample(object.id, detection('chair-1', 'chair', vector(1, 0.15), ++now));
    manager.addSample(object.id, detection('chair-1', 'chair', vector(1, -0.15), ++now));

    const firstObservation = detection('chair-22', 'chair', vector(1, 0.05), ++now);
    const first = manager.recognize([firstObservation], now)[0];
    expect(first.recognition?.state).toBe('candidate');
    expect(first.recognition?.confirmations).toBe(1);
    expect(first.appearance).toBeUndefined();

    const repeated = manager.recognize([firstObservation], ++now)[0];
    expect(repeated.recognition?.state).toBe('candidate');
    expect(repeated.recognition?.confirmations).toBe(1);

    const second = manager.recognize([
      detection('chair-22', 'chair', vector(1, 0.04), ++now),
    ], now)[0];
    expect(second.recognition?.state).toBe('candidate');
    expect(second.recognition?.confirmations).toBe(2);

    const confirmed = manager.recognize([
      detection('chair-22', 'chair', vector(1, 0.03), ++now),
    ], now)[0];
    expect(confirmed.recognition?.state).toBe('confirmed');
    expect(confirmed.recognizedName).toBe('Red chair');
    expect(confirmed.appearance).toBeUndefined();
  });

  it('rejects tentative and low-confidence enrollment tracks', () => {
    const manager = new ObjectRecognitionManager({ minimumEnrollmentConfidence: 0.5 });
    expect(() => manager.enroll(
      'Tentative chair',
      detection('chair-1', 'chair', vector(1), 1_000, { state: 'tentative' }),
    )).toThrow(/not confirmed/);
    expect(() => manager.enroll(
      'Weak chair',
      detection('chair-2', 'chair', vector(1), 1_000, { confidence: 0.3 }),
    )).toThrow(/below the enrollment minimum/);
  });

  it('rejects wrong labels and visually different unknown objects', () => {
    let now = 5_000;
    const manager = new ObjectRecognitionManager({ now: () => now, minimumSamples: 3 });
    const object = manager.enroll('Toolbox', detection('suitcase-1', 'suitcase', vector(2), now));
    manager.addSample(object.id, detection('suitcase-1', 'suitcase', vector(2, 0.15), ++now));
    manager.addSample(object.id, detection('suitcase-1', 'suitcase', vector(2, -0.15), ++now));

    expect(() => manager.addSample(object.id, detection('chair-1', 'chair', vector(2), ++now))).toThrow(/does not match/);
    const unknown = manager.recognize([detection('suitcase-9', 'suitcase', vector(19), ++now)], now)[0];
    expect(unknown.recognition?.state).toBe('unknown');
    expect(unknown.recognizedName).toBeUndefined();
  });

  it('persists descriptors while exposing only sample metadata', () => {
    const directory = mkdtempSync(join(tmpdir(), 'bebop-recognition-'));
    const path = join(directory, 'recognition.json');
    try {
      let now = 10_000;
      const manager = new ObjectRecognitionManager({ storagePath: path, now: () => now });
      const object = manager.enroll('Desk chair', detection('chair-1', 'chair', vector(3), now));
      manager.addSample(object.id, detection('chair-1', 'chair', vector(3, 0.15), ++now));
      manager.addSample(object.id, detection('chair-1', 'chair', vector(3, -0.15), ++now));
      const raw = JSON.parse(readFileSync(path, 'utf8'));
      expect(raw.objects[0].samples).toHaveLength(3);
      expect(raw.objects[0].samples[0].descriptor).toHaveLength(64);

      const reloaded = new ObjectRecognitionManager({ storagePath: path, now: () => now });
      const status = reloaded.getStatus();
      expect(status.objects[0].name).toBe('Desk chair');
      expect('descriptor' in status.objects[0].samples[0]).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
