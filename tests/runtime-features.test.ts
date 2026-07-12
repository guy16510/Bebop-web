import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { RuntimeFeatureManager } from '../src/runtime-features.js';

const defaults = {
  autoConnect: true,
  video: true,
  perception: true,
  showDetections: true,
  showMap: true,
};

describe('RuntimeFeatureManager', () => {
  it('enables video when perception is enabled', () => {
    const manager = new RuntimeFeatureManager({
      defaults: { ...defaults, video: false, perception: false },
    });
    const status = manager.update({ perception: true }, 'web');
    expect(status.settings.video).toBe(true);
    expect(status.settings.perception).toBe(true);
  });

  it('stops perception when video is disabled', () => {
    const manager = new RuntimeFeatureManager({ defaults });
    const status = manager.update({ video: false }, 'web');
    expect(status.settings.video).toBe(false);
    expect(status.settings.perception).toBe(false);
  });

  it('persists dashboard choices and reloads them', () => {
    const directory = mkdtempSync(join(tmpdir(), 'bebop-features-'));
    const storagePath = join(directory, 'runtime-features.json');
    const onChange = vi.fn();
    const manager = new RuntimeFeatureManager({ defaults, storagePath, onChange, now: () => 1234 });
    const status = manager.update({ autoConnect: false, showMap: false }, 'web');

    expect(status.revision).toBe(1);
    expect(status.updatedBy).toBe('web');
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(JSON.parse(readFileSync(storagePath, 'utf8'))).toMatchObject({
      autoConnect: false,
      showMap: false,
    });

    const reloaded = new RuntimeFeatureManager({ defaults, storagePath });
    expect(reloaded.getStatus().settings.autoConnect).toBe(false);
    expect(reloaded.getStatus().settings.showMap).toBe(false);
  });

  it('ignores malformed persisted values', () => {
    const manager = new RuntimeFeatureManager({ defaults });
    const status = manager.update({ showDetections: false }, 'api');
    expect(status.settings.showDetections).toBe(false);
    expect(status.updatedBy).toBe('api');
  });
});
