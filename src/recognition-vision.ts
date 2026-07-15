import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { createInterface, type Interface as ReadlineInterface } from 'node:readline';
import type { Readable } from 'node:stream';
import { z } from 'zod';
import type { RecognizableDetection } from './object-recognition.js';

export type RecognitionVisionState = 'disabled' | 'stopped' | 'starting' | 'running' | 'fault';

export interface RecognitionVisionHealth {
  state: RecognitionVisionState;
  command: string | null;
  startedAt: number | null;
  lastUpdateAt: number | null;
  updates: number;
  invalidUpdates: number;
  restarts: number;
  lastError: string | null;
  inputFps: number;
  detectionFps: number;
  inferenceMs: number;
  endToEndLatencyMs: number;
  activeTracks: number;
}

export interface RecognitionVisionSnapshot {
  timestamp: number;
  source: string;
  detections: RecognizableDetection[];
}

export interface RecognitionVisionOptions {
  command?: string;
  enabled?: boolean;
  restartMs?: number;
  now?: () => number;
  onUpdate?: (snapshot: RecognitionVisionSnapshot, health: RecognitionVisionHealth) => void;
}

const finite = z.number().finite();
const bboxSchema = z.object({
  x: finite.min(0).max(1),
  y: finite.min(0).max(1),
  width: finite.positive().max(1),
  height: finite.positive().max(1),
}).refine((value) => value.x + value.width <= 1.0001 && value.y + value.height <= 1.0001);
const detectionSchema = z.object({
  id: z.string().min(1).max(128),
  label: z.string().min(1).max(128),
  confidence: finite.min(0).max(1),
  bbox: bboxSchema,
  firstSeenAt: z.number().int().nonnegative(),
  lastSeenAt: z.number().int().nonnegative(),
  appearance: z.array(finite.min(-1.0001).max(1.0001)).min(32).max(1024),
  observed: z.boolean().default(true),
  track: z.object({
    state: z.enum(['tentative', 'confirmed']),
    ageFrames: z.number().int().positive(),
    hits: z.number().int().positive(),
    misses: z.number().int().nonnegative(),
  }),
});
const messageSchema = z.object({
  type: z.literal('recognition-vision.snapshot'),
  timestamp: z.number().int().nonnegative(),
  source: z.string().min(1).max(128),
  detections: z.array(detectionSchema),
  metrics: z.object({
    inputFps: finite.nonnegative(),
    detectionFps: finite.nonnegative(),
    inferenceMs: finite.nonnegative(),
    endToEndLatencyMs: finite.nonnegative(),
    activeTracks: z.number().int().nonnegative(),
  }),
});

type RecognitionVisionProcess = ChildProcessByStdio<null, Readable, Readable>;

function environmentConfidence(): number {
  const value = Number(process.env.RECOGNITION_MINIMUM_CONFIDENCE ?? process.env.YOLOX_CONFIDENCE ?? 0.35);
  return Number.isFinite(value) ? Math.max(0.1, Math.min(0.99, value)) : 0.35;
}

export class RecognitionVisionManager {
  private readonly now: () => number;
  private readonly restartMs: number;
  private readonly minimumConfidence: number;
  private child?: RecognitionVisionProcess;
  private lines?: ReadlineInterface;
  private restartTimer?: NodeJS.Timeout;
  private stopping = false;
  private snapshot: RecognitionVisionSnapshot;
  private health: RecognitionVisionHealth;

  constructor(private readonly options: RecognitionVisionOptions) {
    this.now = options.now ?? Date.now;
    this.restartMs = Math.max(500, options.restartMs ?? 2_000);
    this.minimumConfidence = environmentConfidence();
    const enabled = options.enabled !== false && Boolean(options.command?.trim());
    this.snapshot = { timestamp: 0, source: enabled ? 'recognition-sidecar' : 'disabled', detections: [] };
    this.health = {
      state: enabled ? 'stopped' : 'disabled',
      command: options.command?.trim() || null,
      startedAt: null,
      lastUpdateAt: null,
      updates: 0,
      invalidUpdates: 0,
      restarts: 0,
      lastError: null,
      inputFps: 0,
      detectionFps: 0,
      inferenceMs: 0,
      endToEndLatencyMs: 0,
      activeTracks: 0,
    };
  }

  getSnapshot(): RecognitionVisionSnapshot {
    return structuredClone(this.snapshot);
  }

  getHealth(): RecognitionVisionHealth {
    return structuredClone(this.health);
  }

  start(): void {
    if (this.health.state === 'disabled' || this.child) return;
    this.stopping = false;
    this.launch();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = undefined;
    this.lines?.close();
    this.lines = undefined;
    const child = this.child;
    this.child = undefined;
    if (child && !child.killed) child.kill('SIGTERM');
    this.health.state = this.health.command ? 'stopped' : 'disabled';
    this.health.activeTracks = 0;
    this.snapshot.detections = [];
    this.emit();
  }

  private launch(): void {
    const command = this.health.command;
    if (!command || this.stopping) return;
    this.health.state = 'starting';
    this.health.startedAt ??= this.now();
    this.health.lastError = null;
    this.emit();
    const child: RecognitionVisionProcess = spawn('/bin/sh', ['-lc', command], {
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.child = child;
    this.lines = createInterface({ input: child.stdout });
    this.lines.on('line', (line) => this.handleLine(line));
    child.stderr.on('data', (chunk) => {
      const message = chunk.toString().trim();
      if (message) this.health.lastError = message.slice(-1_000);
    });
    child.once('error', (error) => this.handleExit(error.message));
    child.once('exit', (code, signal) => {
      if (this.child === child) this.child = undefined;
      this.lines?.close();
      this.lines = undefined;
      this.handleExit(`Recognition sidecar exited, code ${code ?? 'none'}, signal ${signal ?? 'none'}`);
    });
  }

  private handleLine(line: string): void {
    try {
      const parsed = messageSchema.parse(JSON.parse(line));
      this.snapshot = {
        timestamp: parsed.timestamp,
        source: parsed.source,
        detections: parsed.detections.filter((detection) => (
          detection.track.state === 'confirmed'
          && detection.confidence >= this.minimumConfidence
        )),
      };
      Object.assign(this.health, parsed.metrics);
      this.health.state = 'running';
      this.health.lastUpdateAt = this.now();
      this.health.updates += 1;
      this.health.lastError = null;
      this.emit();
    } catch (error) {
      this.health.invalidUpdates += 1;
      this.health.lastError = error instanceof Error ? error.message : String(error);
      this.emit();
    }
  }

  private handleExit(message: string): void {
    if (this.stopping || this.health.state === 'disabled') return;
    this.health.state = 'fault';
    this.health.lastError = message;
    this.health.activeTracks = 0;
    this.snapshot.detections = [];
    this.emit();
    if (this.restartTimer) return;
    this.restartTimer = setTimeout(() => {
      this.restartTimer = undefined;
      if (this.stopping) return;
      this.health.restarts += 1;
      this.launch();
    }, this.restartMs);
    this.restartTimer.unref();
  }

  private emit(): void {
    this.options.onUpdate?.(this.getSnapshot(), this.getHealth());
  }
}
