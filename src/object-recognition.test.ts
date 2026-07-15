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

function detection(id: string, label: string, appearance: number[], timestamp = 1_000): RecognizableDetection {
  return {
    id,
    label,
    confidence: 0.9,
    bbox: { x: 0.2, y: 0.2, width: 0.3, height: 0.4 },
    firstSeenAt: timestamp - 100,
    lastSeenAt: timestamp,
    appearance,
    observed: true,
    track: { state: 'confirmed', ageFrames: 8, hits: 8, misses: 0 },
  };
}

describe('ObjectRecognitionManager', () => {
  it('requires diverse enrollment samples and repeated confirmations', () => {
    let now = 1_000;
    const manager = new ObjectRecognitionManager({ now: () => now, minimumSamples: 3 });
    const first = detection('chair-1', 'chair', vector(1));
    const object = manager.enroll('Red chair', first);
    manager.addSample(object.id, detection('chair-1', 'chair', vector(1, 0.15), ++now));
    manager.addSample(object.id, detection('chair-1', 'chair', vector(1, -0.15), ++now));

    const candidate = detection('chair-22', 'chair', vector(1, 0.05), ++now);
    expect(manager.recognize([candidate], now)[0].recognition?.state).toBe('candidate');
    expect(manager.recognize([candidate], ++now)[0].recognition?.state).toBe('candidate');
    const confirmed = manager.recognize([candidate], ++now)[0];
    expect(confirmed.recognition?.state).toBe('confirmed');
    expect(confirmed.recognizedName).toBe('Red chair');
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

  it('persists normalized samples and reloads them', () => {
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

      const reloaded = new ObjectRecognitionManager({ storagePath: path, now: () => now });
      expect(reloaded.getStatus().objects[0].name).toBe('Desk chair');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
