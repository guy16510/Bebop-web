import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import type { ObjectDetection } from './perception.js';

export type RecognitionState = 'unavailable' | 'unknown' | 'candidate' | 'confirmed';

export interface AppearanceTrackState {
  state: 'tentative' | 'confirmed';
  ageFrames: number;
  hits: number;
  misses: number;
}

export interface RecognitionMatch {
  state: RecognitionState;
  objectId: string | null;
  score: number | null;
  threshold: number | null;
  confirmations: number;
  sampleCount: number;
  margin: number | null;
}

export interface RecognizableDetection extends ObjectDetection {
  appearance?: number[];
  observed?: boolean;
  track?: AppearanceTrackState;
  recognition?: RecognitionMatch;
}

export interface RecognitionSample {
  id: string;
  descriptor: number[];
  capturedAt: number;
  sourceTrackId: string;
}

export interface RecognitionObject {
  id: string;
  name: string;
  labels: string[];
  enabled: boolean;
  threshold: number;
  minimumConfirmations: number;
  samples: RecognitionSample[];
  createdAt: number;
  updatedAt: number;
}

export interface RecognitionRegistryStatus {
  revision: number;
  updatedAt: number;
  storagePath: string | null;
  minimumSamples: number;
  objects: RecognitionObject[];
  metrics: {
    evaluated: number;
    confirmed: number;
    candidates: number;
    unknown: number;
    unavailable: number;
  };
}

interface TrackVote {
  objectId: string | null;
  confirmations: number;
  lastSeenAt: number;
}

interface RecognitionManagerOptions {
  storagePath?: string;
  minimumSamples?: number;
  maximumSamplesPerObject?: number;
  minimumMargin?: number;
  now?: () => number;
  onChange?: (status: RecognitionRegistryStatus) => void;
}

const finite = z.number().finite();
const descriptorSchema = z.array(finite.min(-1.0001).max(1.0001)).min(32).max(1024);
const sampleSchema = z.object({
  id: z.string().min(1).max(128),
  descriptor: descriptorSchema,
  capturedAt: z.number().int().nonnegative(),
  sourceTrackId: z.string().min(1).max(128),
});
const objectSchema = z.object({
  id: z.string().min(1).max(64),
  name: z.string().min(1).max(128),
  labels: z.array(z.string().min(1).max(128)).min(1).max(16),
  enabled: z.boolean(),
  threshold: finite.min(0.45).max(0.99),
  minimumConfirmations: z.number().int().min(1).max(12),
  samples: z.array(sampleSchema).max(128),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
});
const registrySchema = z.object({
  revision: z.number().int().nonnegative().default(0),
  updatedAt: z.number().int().nonnegative().default(0),
  objects: z.array(objectSchema).default([]),
});

function clone<T>(value: T): T {
  return structuredClone(value);
}

function cleanId(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64);
}

function cleanLabels(labels: string[]): string[] {
  return [...new Set(labels.map((label) => label.trim().toLowerCase()).filter(Boolean))].slice(0, 16);
}

function normalizedDescriptor(value: unknown): number[] {
  const parsed = descriptorSchema.parse(value);
  let norm = 0;
  for (const item of parsed) norm += item * item;
  norm = Math.sqrt(norm);
  if (!Number.isFinite(norm) || norm < 1e-8) throw new Error('Appearance descriptor has no usable signal');
  return parsed.map((item) => item / norm);
}

function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return -1;
  let result = 0;
  for (let index = 0; index < a.length; index += 1) result += a[index] * b[index];
  return Math.max(-1, Math.min(1, result));
}

function averageTop(values: number[], count: number): number {
  const top = [...values].sort((a, b) => b - a).slice(0, Math.max(1, count));
  return top.reduce((sum, value) => sum + value, 0) / top.length;
}

function descriptorFor(detection: RecognizableDetection): number[] {
  if (!detection.appearance) throw new Error(`Track ${detection.id} has no appearance descriptor`);
  return normalizedDescriptor(detection.appearance);
}

export class ObjectRecognitionManager {
  private readonly now: () => number;
  private readonly minimumSamples: number;
  private readonly maximumSamplesPerObject: number;
  private readonly minimumMargin: number;
  private readonly storagePath?: string;
  private objects: RecognitionObject[] = [];
  private revision = 0;
  private updatedAt = 0;
  private loadedMtimeMs = 0;
  private readonly votes = new Map<string, TrackVote>();
  private metrics = { evaluated: 0, confirmed: 0, candidates: 0, unknown: 0, unavailable: 0 };

  constructor(private readonly options: RecognitionManagerOptions = {}) {
    this.now = options.now ?? Date.now;
    this.minimumSamples = Math.max(2, Math.min(12, options.minimumSamples ?? 3));
    this.maximumSamplesPerObject = Math.max(this.minimumSamples, Math.min(128, options.maximumSamplesPerObject ?? 48));
    this.minimumMargin = Math.max(0.01, Math.min(0.25, options.minimumMargin ?? 0.04));
    this.storagePath = options.storagePath;
    this.reload(true);
  }

  getStatus(): RecognitionRegistryStatus {
    this.reload(false);
    return {
      revision: this.revision,
      updatedAt: this.updatedAt,
      storagePath: this.storagePath ?? null,
      minimumSamples: this.minimumSamples,
      objects: clone(this.objects),
      metrics: { ...this.metrics },
    };
  }

  recognize(detections: RecognizableDetection[], now = this.now()): RecognizableDetection[] {
    this.reload(false);
    this.metrics = { evaluated: 0, confirmed: 0, candidates: 0, unknown: 0, unavailable: 0 };
    const activeTracks = new Set(detections.map((detection) => detection.id));
    for (const [trackId, vote] of this.votes) {
      if (!activeTracks.has(trackId) && now - vote.lastSeenAt > 5_000) this.votes.delete(trackId);
    }
    return detections.map((detection) => this.recognizeOne(detection, now));
  }

  enroll(name: string, detection: RecognizableDetection): RecognitionObject {
    const cleanName = name.trim().slice(0, 128);
    if (!cleanName) throw new Error('A recognition name is required');
    const label = detection.label.trim().toLowerCase();
    const descriptor = descriptorFor(detection);
    const now = this.now();
    let id = cleanId(cleanName) || `object-${now}`;
    const base = id;
    let suffix = 2;
    while (this.objects.some((item) => item.id === id)) id = `${base}-${suffix++}`;
    const object: RecognitionObject = {
      id,
      name: cleanName,
      labels: [label],
      enabled: true,
      threshold: 0.78,
      minimumConfirmations: 3,
      samples: [{ id: `${id}-sample-1`, descriptor, capturedAt: now, sourceTrackId: detection.id }],
      createdAt: now,
      updatedAt: now,
    };
    this.objects.push(object);
    this.commit();
    return clone(object);
  }

  addSample(objectId: string, detection: RecognizableDetection): RecognitionObject {
    const object = this.requireObject(objectId);
    const label = detection.label.trim().toLowerCase();
    if (!object.labels.includes(label)) {
      throw new Error(`Track label ${label} does not match enrolled labels ${object.labels.join(', ')}`);
    }
    const descriptor = descriptorFor(detection);
    const duplicate = object.samples.some((sample) => cosine(sample.descriptor, descriptor) > 0.995);
    if (duplicate) throw new Error('This view is too similar to an existing sample, capture a different angle or distance');
    const now = this.now();
    object.samples.push({
      id: `${object.id}-sample-${now}`,
      descriptor,
      capturedAt: now,
      sourceTrackId: detection.id,
    });
    if (object.samples.length > this.maximumSamplesPerObject) object.samples.shift();
    object.updatedAt = now;
    this.commit();
    return clone(object);
  }

  update(objectId: string, patch: {
    name?: string;
    labels?: string[];
    enabled?: boolean;
    threshold?: number;
    minimumConfirmations?: number;
  }): RecognitionObject {
    const object = this.requireObject(objectId);
    if (patch.name !== undefined) {
      const name = patch.name.trim().slice(0, 128);
      if (!name) throw new Error('Recognition name cannot be empty');
      object.name = name;
    }
    if (patch.labels !== undefined) {
      const labels = cleanLabels(patch.labels);
      if (labels.length === 0) throw new Error('At least one detector label is required');
      object.labels = labels;
    }
    if (patch.enabled !== undefined) object.enabled = patch.enabled;
    if (patch.threshold !== undefined) object.threshold = Math.max(0.45, Math.min(0.99, patch.threshold));
    if (patch.minimumConfirmations !== undefined) {
      object.minimumConfirmations = Math.max(1, Math.min(12, Math.trunc(patch.minimumConfirmations)));
    }
    object.updatedAt = this.now();
    this.commit();
    return clone(object);
  }

  remove(objectId: string): void {
    const before = this.objects.length;
    this.objects = this.objects.filter((item) => item.id !== objectId);
    if (this.objects.length === before) throw new Error(`Recognition object ${objectId} was not found`);
    for (const [trackId, vote] of this.votes) if (vote.objectId === objectId) this.votes.delete(trackId);
    this.commit();
  }

  resetTrackConfirmations(): void {
    this.votes.clear();
  }

  private recognizeOne(detection: RecognizableDetection, now: number): RecognizableDetection {
    this.metrics.evaluated += 1;
    if (!detection.appearance || detection.observed === false) {
      this.metrics.unavailable += 1;
      return {
        ...detection,
        recognizedName: undefined,
        recognition: {
          state: 'unavailable', objectId: null, score: null, threshold: null,
          confirmations: 0, sampleCount: 0, margin: null,
        },
      };
    }

    let descriptor: number[];
    try {
      descriptor = normalizedDescriptor(detection.appearance);
    } catch {
      this.metrics.unavailable += 1;
      return {
        ...detection,
        recognizedName: undefined,
        recognition: {
          state: 'unavailable', objectId: null, score: null, threshold: null,
          confirmations: 0, sampleCount: 0, margin: null,
        },
      };
    }

    const candidates = this.objects
      .filter((object) => object.enabled)
      .filter((object) => object.labels.includes(detection.label.toLowerCase()))
      .filter((object) => object.samples.length >= this.minimumSamples)
      .map((object) => ({
        object,
        score: averageTop(object.samples.map((sample) => cosine(descriptor, sample.descriptor)), 3),
      }))
      .sort((a, b) => b.score - a.score);

    const best = candidates[0];
    const second = candidates[1];
    const margin = best ? best.score - (second?.score ?? 0) : null;
    const acceptable = Boolean(best && best.score >= best.object.threshold && (margin ?? 0) >= this.minimumMargin);
    const prior = this.votes.get(detection.id);
    const confirmations = acceptable
      ? prior?.objectId === best?.object.id ? prior.confirmations + 1 : 1
      : 0;
    this.votes.set(detection.id, {
      objectId: acceptable ? best?.object.id ?? null : null,
      confirmations,
      lastSeenAt: now,
    });

    if (!acceptable || !best) {
      this.metrics.unknown += 1;
      return {
        ...detection,
        recognizedName: undefined,
        recognition: {
          state: 'unknown',
          objectId: null,
          score: best?.score ?? null,
          threshold: best?.object.threshold ?? null,
          confirmations: 0,
          sampleCount: best?.object.samples.length ?? 0,
          margin,
        },
      };
    }

    const confirmed = confirmations >= best.object.minimumConfirmations;
    if (confirmed) this.metrics.confirmed += 1;
    else this.metrics.candidates += 1;
    return {
      ...detection,
      recognizedName: confirmed ? best.object.name : undefined,
      recognition: {
        state: confirmed ? 'confirmed' : 'candidate',
        objectId: best.object.id,
        score: best.score,
        threshold: best.object.threshold,
        confirmations,
        sampleCount: best.object.samples.length,
        margin,
      },
    };
  }

  private requireObject(objectId: string): RecognitionObject {
    this.reload(false);
    const object = this.objects.find((item) => item.id === objectId);
    if (!object) throw new Error(`Recognition object ${objectId} was not found`);
    return object;
  }

  private reload(force: boolean): void {
    if (!this.storagePath || !existsSync(this.storagePath)) return;
    const mtimeMs = statSync(this.storagePath).mtimeMs;
    if (!force && mtimeMs <= this.loadedMtimeMs) return;
    const parsed = registrySchema.parse(JSON.parse(readFileSync(this.storagePath, 'utf8')));
    this.revision = parsed.revision;
    this.updatedAt = parsed.updatedAt;
    this.objects = parsed.objects.map((object) => ({
      ...object,
      labels: cleanLabels(object.labels),
      samples: object.samples.map((sample) => ({ ...sample, descriptor: normalizedDescriptor(sample.descriptor) })),
    }));
    this.loadedMtimeMs = mtimeMs;
  }

  private commit(): void {
    this.revision += 1;
    this.updatedAt = this.now();
    if (this.storagePath) {
      mkdirSync(dirname(this.storagePath), { recursive: true });
      const temporary = `${this.storagePath}.tmp`;
      writeFileSync(temporary, `${JSON.stringify({
        revision: this.revision,
        updatedAt: this.updatedAt,
        objects: this.objects,
      }, null, 2)}\n`, 'utf8');
      renameSync(temporary, this.storagePath);
      this.loadedMtimeMs = statSync(this.storagePath).mtimeMs;
    }
    this.options.onChange?.(this.getStatus());
  }
}
