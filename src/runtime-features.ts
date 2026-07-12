import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export interface RuntimeFeatureSettings {
  autoConnect: boolean;
  video: boolean;
  perception: boolean;
  showDetections: boolean;
  showMap: boolean;
}

export interface RuntimeFeatureStatus {
  settings: RuntimeFeatureSettings;
  revision: number;
  updatedAt: number;
  updatedBy: 'environment' | 'web' | 'api';
}

export interface RuntimeFeatureManagerOptions {
  defaults: RuntimeFeatureSettings;
  storagePath?: string;
  now?: () => number;
  onChange?: (status: RuntimeFeatureStatus) => void;
}

const FEATURE_KEYS = [
  'autoConnect',
  'video',
  'perception',
  'showDetections',
  'showMap',
] as const;

type RuntimeFeatureKey = (typeof FEATURE_KEYS)[number];

function sanitize(value: unknown): Partial<RuntimeFeatureSettings> {
  if (!value || typeof value !== 'object') return {};
  const source = value as Record<string, unknown>;
  const result: Partial<RuntimeFeatureSettings> = {};
  if (typeof source.autoConnect === 'boolean') result.autoConnect = source.autoConnect;
  if (typeof source.video === 'boolean') result.video = source.video;
  if (typeof source.perception === 'boolean') result.perception = source.perception;
  if (typeof source.showDetections === 'boolean') result.showDetections = source.showDetections;
  if (typeof source.showMap === 'boolean') result.showMap = source.showMap;
  return result;
}

function normalize(
  current: RuntimeFeatureSettings,
  patch: Partial<RuntimeFeatureSettings>,
): RuntimeFeatureSettings {
  const sanitized = sanitize(patch);
  const next = { ...current, ...sanitized };

  // Perception requires decoded video. Turning perception on enables video.
  if (sanitized.perception === true) next.video = true;

  // Turning video off must stop the sidecar because it has no frame source.
  if (sanitized.video === false) next.perception = false;

  return next;
}

export class RuntimeFeatureManager {
  private readonly now: () => number;
  private readonly storagePath?: string;
  private readonly onChange?: RuntimeFeatureManagerOptions['onChange'];
  private status: RuntimeFeatureStatus;

  constructor(options: RuntimeFeatureManagerOptions) {
    this.now = options.now ?? Date.now;
    this.storagePath = options.storagePath;
    this.onChange = options.onChange;

    let persisted: Partial<RuntimeFeatureSettings> = {};
    if (this.storagePath) {
      try {
        persisted = sanitize(JSON.parse(readFileSync(this.storagePath, 'utf8')));
      } catch {
        // Missing or malformed state falls back to environment defaults.
      }
    }

    this.status = {
      settings: normalize(options.defaults, persisted),
      revision: 0,
      updatedAt: this.now(),
      updatedBy: 'environment',
    };
  }

  getStatus(): RuntimeFeatureStatus {
    return structuredClone(this.status);
  }

  update(
    patch: Partial<RuntimeFeatureSettings>,
    updatedBy: RuntimeFeatureStatus['updatedBy'] = 'web',
  ): RuntimeFeatureStatus {
    const settings = normalize(this.status.settings, patch);
    const changed = FEATURE_KEYS.some((key: RuntimeFeatureKey) => settings[key] !== this.status.settings[key]);
    if (!changed) return this.getStatus();

    this.status = {
      settings,
      revision: this.status.revision + 1,
      updatedAt: this.now(),
      updatedBy,
    };
    this.persist();
    const snapshot = this.getStatus();
    this.onChange?.(snapshot);
    return snapshot;
  }

  private persist(): void {
    if (!this.storagePath) return;
    mkdirSync(dirname(this.storagePath), { recursive: true });
    writeFileSync(this.storagePath, `${JSON.stringify(this.status.settings, null, 2)}\n`, 'utf8');
  }
}
