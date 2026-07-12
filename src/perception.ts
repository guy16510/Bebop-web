import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface, type Interface as ReadlineInterface } from 'node:readline';
import { z } from 'zod';

export type PerceptionBackend = 'disabled' | 'simulation' | 'external';
export type PerceptionRuntimeState = 'disabled' | 'stopped' | 'starting' | 'running' | 'fault';
export type SlamTrackingState = 'disabled' | 'initializing' | 'tracking' | 'lost' | 'fault';

export interface Vector3 {
  x: number;
  y: number;
  z: number;
}

export interface Pose3D extends Vector3 {
  roll: number;
  pitch: number;
  yaw: number;
}

export interface NormalizedBoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ObjectDetection {
  id: string;
  label: string;
  recognizedName?: string;
  confidence: number;
  bbox: NormalizedBoundingBox;
  worldPosition?: Vector3;
  firstSeenAt: number;
  lastSeenAt: number;
}

export interface MapLandmark {
  id: string;
  position: Vector3;
  observations: number;
  quality: number;
}

export interface MapBounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  minZ: number;
  maxZ: number;
}

export interface PerceptionMetrics {
  inputFps: number;
  slamFps: number;
  detectionFps: number;
  inferenceMs: number;
  endToEndLatencyMs: number;
  trackedFeatures: number;
  keyframes: number;
  loopClosures: number;
}

export interface PerceptionSnapshot {
  sequence: number;
  timestamp: number;
  backend: PerceptionBackend;
  source: string;
  trackingState: SlamTrackingState;
  calibrated: boolean;
  scaleSource: 'none' | 'monocular' | 'telemetry' | 'imu';
  pose: Pose3D | null;
  trajectory: Pose3D[];
  detections: ObjectDetection[];
  map: {
    bounds: MapBounds;
    landmarks: MapLandmark[];
  };
  metrics: PerceptionMetrics;
}

export interface PerceptionHealth {
  backend: PerceptionBackend;
  state: PerceptionRuntimeState;
  trackingState: SlamTrackingState;
  startedAt: number | null;
  lastUpdateAt: number | null;
  updates: number;
  invalidUpdates: number;
  restarts: number;
  lastError: string | null;
  command: string | null;
}

export interface PerceptionTelemetry {
  altitude: number;
  speedX: number;
  speedY: number;
  speedZ: number;
  updatedAt: number;
}

export interface PerceptionManagerOptions {
  backend: PerceptionBackend;
  command?: string;
  updateHz?: number;
  maxTrajectoryPoints?: number;
  maxLandmarks?: number;
  videoUrl?: string;
  stateUrl?: string;
  now?: () => number;
  onUpdate?: (snapshot: PerceptionSnapshot, health: PerceptionHealth) => void;
}

const finiteNumber = z.number().finite();
const vectorSchema = z.object({ x: finiteNumber, y: finiteNumber, z: finiteNumber });
const poseSchema = vectorSchema.extend({
  roll: finiteNumber,
  pitch: finiteNumber,
  yaw: finiteNumber,
});
const bboxSchema = z.object({
  x: finiteNumber.min(0).max(1),
  y: finiteNumber.min(0).max(1),
  width: finiteNumber.positive().max(1),
  height: finiteNumber.positive().max(1),
}).refine((value) => value.x + value.width <= 1.0001 && value.y + value.height <= 1.0001, {
  message: 'Bounding box must fit inside normalized image coordinates',
});
const detectionSchema = z.object({
  id: z.string().min(1).max(128),
  label: z.string().min(1).max(128),
  recognizedName: z.string().min(1).max(128).optional(),
  confidence: finiteNumber.min(0).max(1),
  bbox: bboxSchema,
  worldPosition: vectorSchema.optional(),
  firstSeenAt: z.number().int().nonnegative(),
  lastSeenAt: z.number().int().nonnegative(),
});
const landmarkSchema = z.object({
  id: z.string().min(1).max(128),
  position: vectorSchema,
  observations: z.number().int().nonnegative(),
  quality: finiteNumber.min(0).max(1),
});
const boundsSchema = z.object({
  minX: finiteNumber,
  maxX: finiteNumber,
  minY: finiteNumber,
  maxY: finiteNumber,
  minZ: finiteNumber,
  maxZ: finiteNumber,
}).refine((value) => value.minX < value.maxX && value.minY < value.maxY && value.minZ < value.maxZ, {
  message: 'Map bounds must have positive volume',
});
const metricsSchema = z.object({
  inputFps: finiteNumber.nonnegative(),
  slamFps: finiteNumber.nonnegative(),
  detectionFps: finiteNumber.nonnegative(),
  inferenceMs: finiteNumber.nonnegative(),
  endToEndLatencyMs: finiteNumber.nonnegative(),
  trackedFeatures: z.number().int().nonnegative(),
  keyframes: z.number().int().nonnegative(),
  loopClosures: z.number().int().nonnegative(),
});
const snapshotSchema = z.object({
  sequence: z.number().int().nonnegative(),
  timestamp: z.number().int().nonnegative(),
  backend: z.enum(['disabled', 'simulation', 'external']),
  source: z.string().min(1).max(256),
  trackingState: z.enum(['disabled', 'initializing', 'tracking', 'lost', 'fault']),
  calibrated: z.boolean(),
  scaleSource: z.enum(['none', 'monocular', 'telemetry', 'imu']),
  pose: poseSchema.nullable(),
  trajectory: z.array(poseSchema),
  detections: z.array(detectionSchema),
  map: z.object({ bounds: boundsSchema, landmarks: z.array(landmarkSchema) }),
  metrics: metricsSchema,
});

const DEFAULT_BOUNDS: MapBounds = {
  minX: -6,
  maxX: 6,
  minY: -5,
  maxY: 5,
  minZ: 0,
  maxZ: 3,
};

const EMPTY_METRICS: PerceptionMetrics = {
  inputFps: 0,
  slamFps: 0,
  detectionFps: 0,
  inferenceMs: 0,
  endToEndLatencyMs: 0,
  trackedFeatures: 0,
  keyframes: 0,
  loopClosures: 0,
};

export function createEmptyPerceptionSnapshot(
  backend: PerceptionBackend,
  timestamp = Date.now(),
): PerceptionSnapshot {
  return {
    sequence: 0,
    timestamp,
    backend,
    source: backend === 'disabled' ? 'disabled' : backend,
    trackingState: 'disabled',
    calibrated: false,
    scaleSource: 'none',
    pose: null,
    trajectory: [],
    detections: [],
    map: { bounds: { ...DEFAULT_BOUNDS }, landmarks: [] },
    metrics: { ...EMPTY_METRICS },
  };
}

export function parsePerceptionSnapshot(value: unknown): PerceptionSnapshot {
  return snapshotSchema.parse(value);
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function makeSimulationLandmarks(sequence: number): MapLandmark[] {
  const landmarks: MapLandmark[] = [];
  for (let index = 0; index < 72; index += 1) {
    const wall = index % 4;
    const offset = ((index * 37) % 100) / 100;
    let x = -5 + offset * 10;
    let y = -4 + offset * 8;
    if (wall === 0) y = -4;
    if (wall === 1) x = 5;
    if (wall === 2) y = 4;
    if (wall === 3) x = -5;
    landmarks.push({
      id: `landmark-${index}`,
      position: { x, y, z: 0.25 + ((index * 17) % 22) / 10 },
      observations: 2 + Math.floor(sequence / 4) + (index % 7),
      quality: 0.62 + (index % 9) * 0.04,
    });
  }
  return landmarks;
}

function simulationDetections(sequence: number, timestamp: number): ObjectDetection[] {
  const sway = Math.sin(sequence / 12) * 0.025;
  const detections: ObjectDetection[] = [
    {
      id: 'person-1',
      label: 'person',
      recognizedName: 'Person',
      confidence: 0.94,
      bbox: { x: clamp(0.18 + sway, 0, 0.72), y: 0.16, width: 0.2, height: 0.68 },
      worldPosition: { x: 1.8, y: 0.8, z: 0 },
      firstSeenAt: timestamp - Math.min(sequence * 100, 8_000),
      lastSeenAt: timestamp,
    },
    {
      id: 'chair-1',
      label: 'chair',
      recognizedName: 'Desk chair',
      confidence: 0.89,
      bbox: { x: 0.58, y: 0.46, width: 0.24, height: 0.4 },
      worldPosition: { x: -1.4, y: 2.2, z: 0 },
      firstSeenAt: timestamp - Math.min(sequence * 100, 6_000),
      lastSeenAt: timestamp,
    },
    {
      id: 'bottle-1',
      label: 'bottle',
      recognizedName: 'Bottle',
      confidence: 0.82,
      bbox: { x: 0.46, y: 0.39, width: 0.07, height: 0.24 },
      worldPosition: { x: 0.4, y: -1.6, z: 0.75 },
      firstSeenAt: timestamp - Math.min(sequence * 100, 4_000),
      lastSeenAt: timestamp,
    },
  ];
  return sequence % 55 < 44 ? detections : detections.slice(1);
}

export function generateSimulationSnapshot(
  sequence: number,
  timestamp: number,
  trajectory: Pose3D[] = [],
): PerceptionSnapshot {
  const angle = (sequence % 360) * (Math.PI / 180);
  const pose: Pose3D = {
    x: Math.cos(angle) * 4,
    y: Math.sin(angle) * 3,
    z: 1.2 + Math.sin(angle * 2) * 0.12,
    roll: Math.sin(angle * 3) * 0.02,
    pitch: Math.cos(angle * 2) * 0.03,
    yaw: angle + Math.PI / 2,
  };
  const initializing = sequence < 8;
  return {
    sequence,
    timestamp,
    backend: 'simulation',
    source: 'deterministic-room-simulation',
    trackingState: initializing ? 'initializing' : 'tracking',
    calibrated: !initializing,
    scaleSource: initializing ? 'monocular' : 'telemetry',
    pose,
    trajectory,
    detections: initializing ? [] : simulationDetections(sequence, timestamp),
    map: {
      bounds: { ...DEFAULT_BOUNDS },
      landmarks: initializing ? makeSimulationLandmarks(sequence).slice(0, sequence * 6) : makeSimulationLandmarks(sequence),
    },
    metrics: {
      inputFps: 30,
      slamFps: initializing ? 12 : 27.5,
      detectionFps: initializing ? 0 : 9.8,
      inferenceMs: initializing ? 0 : 31 + Math.abs(Math.sin(angle)) * 7,
      endToEndLatencyMs: initializing ? 14 : 47 + Math.abs(Math.cos(angle)) * 8,
      trackedFeatures: initializing ? 18 + sequence * 22 : 286 + (sequence % 31),
      keyframes: Math.max(0, Math.floor((sequence - 5) / 8)),
      loopClosures: sequence >= 180 ? 1 : 0,
    },
  };
}

export class PerceptionManager {
  private readonly now: () => number;
  private readonly updateIntervalMs: number;
  private readonly maxTrajectoryPoints: number;
  private readonly maxLandmarks: number;
  private readonly onUpdate?: PerceptionManagerOptions['onUpdate'];
  private readonly videoUrl: string;
  private readonly stateUrl: string;
  private snapshot: PerceptionSnapshot;
  private health: PerceptionHealth;
  private timer?: NodeJS.Timeout;
  private child?: ChildProcessWithoutNullStreams;
  private childLines?: ReadlineInterface;
  private stopping = false;
  private latestTelemetry?: PerceptionTelemetry;

  constructor(private readonly options: PerceptionManagerOptions) {
    this.now = options.now ?? Date.now;
    const updateHz = options.updateHz ?? 10;
    if (!Number.isFinite(updateHz) || updateHz <= 0 || updateHz > 60) {
      throw new Error('Perception updateHz must be between 0 and 60');
    }
    this.updateIntervalMs = Math.round(1000 / updateHz);
    this.maxTrajectoryPoints = options.maxTrajectoryPoints ?? 900;
    this.maxLandmarks = options.maxLandmarks ?? 2_500;
    this.onUpdate = options.onUpdate;
    this.videoUrl = options.videoUrl ?? 'http://127.0.0.1:3000/video.mjpeg';
    this.stateUrl = options.stateUrl ?? 'http://127.0.0.1:3000/api/state';
    this.snapshot = createEmptyPerceptionSnapshot(options.backend, this.now());
    this.health = {
      backend: options.backend,
      state: options.backend === 'disabled' ? 'disabled' : 'stopped',
      trackingState: 'disabled',
      startedAt: null,
      lastUpdateAt: null,
      updates: 0,
      invalidUpdates: 0,
      restarts: 0,
      lastError: null,
      command: options.command ?? null,
    };
  }

  getSnapshot(): PerceptionSnapshot {
    return structuredClone(this.snapshot);
  }

  getHealth(): PerceptionHealth {
    return { ...this.health };
  }

  async start(): Promise<void> {
    if (this.options.backend === 'disabled') throw new Error('Perception backend is disabled');
    if (this.health.state === 'running' || this.health.state === 'starting') return;
    this.stopping = false;
    this.health.state = 'starting';
    this.health.startedAt = this.now();
    this.health.lastError = null;
    this.health.restarts += this.health.updates > 0 ? 1 : 0;

    if (this.options.backend === 'simulation') {
      this.resetState('initializing');
      this.health.state = 'running';
      this.tickSimulation();
      this.timer = setInterval(() => this.tickSimulation(), this.updateIntervalMs);
      return;
    }

    await this.startExternal();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.childLines?.close();
    this.childLines = undefined;

    const child = this.child;
    this.child = undefined;
    if (child && !child.killed) {
      this.sendExternal({ type: 'stop' }, child);
      child.kill('SIGTERM');
      const forceTimer = setTimeout(() => child.kill('SIGKILL'), 1_500);
      forceTimer.unref();
    }

    this.health.state = this.options.backend === 'disabled' ? 'disabled' : 'stopped';
    this.health.trackingState = 'disabled';
    this.snapshot.trackingState = 'disabled';
    this.emitUpdate();
  }

  reset(): void {
    const running = this.health.state === 'running';
    this.resetState(running ? 'initializing' : 'disabled');
    if (this.options.backend === 'external' && this.child) this.sendExternal({ type: 'reset' });
    this.emitUpdate();
  }

  updateTelemetry(telemetry: PerceptionTelemetry): void {
    this.latestTelemetry = { ...telemetry };
    if (this.options.backend === 'external' && this.child && this.health.state === 'running') {
      this.sendExternal({ type: 'telemetry', telemetry: this.latestTelemetry });
    }
  }

  ingestExternalMessage(value: unknown): void {
    try {
      const candidate = isSnapshotEnvelope(value) ? value.snapshot : value;
      const parsed = parsePerceptionSnapshot(candidate);
      this.acceptSnapshot({ ...parsed, backend: 'external' });
      this.health.state = 'running';
      this.health.lastError = null;
    } catch (error) {
      this.health.invalidUpdates += 1;
      this.health.lastError = error instanceof Error ? error.message : String(error);
      if (this.health.updates === 0) this.health.state = 'fault';
      this.emitUpdate();
    }
  }

  private tickSimulation(): void {
    const nextSequence = this.snapshot.sequence + 1;
    const base = generateSimulationSnapshot(nextSequence, this.now());
    const trajectory = [...this.snapshot.trajectory, base.pose as Pose3D].slice(-this.maxTrajectoryPoints);
    this.acceptSnapshot({ ...base, trajectory });
  }

  private acceptSnapshot(snapshot: PerceptionSnapshot): void {
    const trajectory = snapshot.trajectory.slice(-this.maxTrajectoryPoints);
    const landmarks = snapshot.map.landmarks.slice(-this.maxLandmarks);
    this.snapshot = {
      ...snapshot,
      trajectory,
      detections: snapshot.detections.slice(0, 100),
      map: { ...snapshot.map, landmarks },
    };
    this.health.state = 'running';
    this.health.trackingState = snapshot.trackingState;
    this.health.lastUpdateAt = snapshot.timestamp;
    this.health.updates += 1;
    this.emitUpdate();
  }

  private resetState(trackingState: SlamTrackingState): void {
    const timestamp = this.now();
    this.snapshot = {
      ...createEmptyPerceptionSnapshot(this.options.backend, timestamp),
      source: this.options.backend === 'simulation' ? 'deterministic-room-simulation' : 'orb-slam3-yolox-sidecar',
      trackingState,
    };
    this.health.trackingState = trackingState;
    this.health.lastUpdateAt = timestamp;
  }

  private async startExternal(): Promise<void> {
    const command = this.options.command?.trim();
    if (!command) {
      this.health.state = 'fault';
      this.health.lastError = 'PERCEPTION_COMMAND is required for the external backend';
      this.emitUpdate();
      throw new Error(this.health.lastError);
    }

    const child = spawn(command, [], { shell: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child = child;
    this.childLines = createInterface({ input: child.stdout });
    this.childLines.on('line', (line) => {
      if (!line.trim()) return;
      try {
        this.ingestExternalMessage(JSON.parse(line));
      } catch (error) {
        this.health.invalidUpdates += 1;
        this.health.lastError = `Invalid backend JSON: ${error instanceof Error ? error.message : String(error)}`;
        this.emitUpdate();
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      const text = chunk.trim();
      if (text) this.health.lastError = text.slice(-1_000);
    });
    child.once('error', (error) => this.onExternalFailure(error));
    child.once('exit', (code, signal) => {
      this.child = undefined;
      if (!this.stopping && code !== 0) {
        this.onExternalFailure(new Error(`Perception backend exited with code ${code ?? 'null'} signal ${signal ?? 'none'}`));
      }
    });

    this.resetState('initializing');
    this.health.state = 'running';
    this.sendExternal({
      type: 'start',
      protocolVersion: 1,
      videoUrl: this.videoUrl,
      stateUrl: this.stateUrl,
      slam: {
        library: 'ORB-SLAM3',
        sensorMode: 'monocular',
        cameraModel: 'fisheye',
        requireCalibration: true,
      },
      detector: {
        runtime: 'ONNX Runtime',
        modelFamily: 'YOLOX',
      },
    });
    this.emitUpdate();
  }

  private sendExternal(message: unknown, child = this.child): void {
    if (!child?.stdin.writable) return;
    child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private onExternalFailure(error: unknown): void {
    this.health.state = 'fault';
    this.health.trackingState = 'fault';
    this.health.lastError = error instanceof Error ? error.message : String(error);
    this.snapshot.trackingState = 'fault';
    this.emitUpdate();
  }

  private emitUpdate(): void {
    this.onUpdate?.(this.getSnapshot(), this.getHealth());
  }
}

function isSnapshotEnvelope(value: unknown): value is { type: 'perception.snapshot'; snapshot: unknown } {
  return Boolean(value && typeof value === 'object' && 'type' in value && (value as { type?: unknown }).type === 'perception.snapshot' && 'snapshot' in value);
}
