import { EventEmitter } from 'node:events';
import type { Readable } from 'node:stream';
import {
  BebopArStream2Video,
  installArStream2Discovery,
  type ArStream2DiscoveryResponse,
} from './arstream2-video.js';
import type {
  ConnectionState,
  DroneAdapter,
  DroneSnapshot,
  FlyingState,
  PilotingCommand,
} from './types.js';
import { ZERO_COMMAND } from './types.js';

export interface AdapterLogger {
  info(bindings: unknown, message?: string): void;
  warn(bindings: unknown, message?: string): void;
  error(bindings: unknown, message?: string): void;
}

const flyingStates = new Set<FlyingState>([
  'landed',
  'takingOff',
  'hovering',
  'flying',
  'landing',
  'emergency',
]);

function normalizeFlyingState(value: string): FlyingState | null {
  return flyingStates.has(value as FlyingState) ? (value as FlyingState) : null;
}

export class SimulatedDrone extends EventEmitter implements DroneAdapter {
  private snapshot: DroneSnapshot = {
    connectionState: 'disconnected',
    pilotConnected: false,
    videoState: 'disabled',
    telemetry: {
      battery: 100,
      altitude: 0,
      speedX: 0,
      speedY: 0,
      speedZ: 0,
      flyingState: 'landed',
      updatedAt: Date.now(),
    },
  };
  private timer?: NodeJS.Timeout;
  private command = ZERO_COMMAND;

  async connect(): Promise<void> {
    this.patch({ connectionState: 'connecting' });
    await new Promise((resolve) => setTimeout(resolve, 400));
    this.patch({ connectionState: 'connected' });
    this.timer = setInterval(() => this.tick(), 100);
  }

  async disconnect(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.command = ZERO_COMMAND;
    this.patch({ connectionState: 'disconnected', videoState: 'disabled' });
  }

  async takeoff(): Promise<void> {
    this.requireConnected();
    this.snapshot.telemetry.flyingState = 'takingOff';
    this.emitSnapshot();
    setTimeout(() => {
      this.snapshot.telemetry.flyingState = 'hovering';
      this.snapshot.telemetry.altitude = 1;
      this.emitSnapshot();
    }, 900);
  }

  async land(): Promise<void> {
    this.requireConnected();
    this.command = ZERO_COMMAND;
    this.snapshot.telemetry.flyingState = 'landing';
    this.emitSnapshot();
    setTimeout(() => {
      this.snapshot.telemetry.flyingState = 'landed';
      this.snapshot.telemetry.altitude = 0;
      this.emitSnapshot();
    }, 900);
  }

  async emergency(): Promise<void> {
    this.command = ZERO_COMMAND;
    this.snapshot.telemetry.flyingState = 'emergency';
    this.emitSnapshot();
  }

  setPilotingCommand(command: PilotingCommand): void {
    this.command = command;
  }

  stopMovement(): void {
    this.command = ZERO_COMMAND;
  }

  async startVideo(): Promise<Readable> {
    throw new Error('Simulation video fixture is not configured');
  }

  async stopVideo(): Promise<void> {
    this.patch({ videoState: 'disabled' });
  }

  async startRawVideo(): Promise<Readable> {
    throw new Error('Simulation raw video fixture is not configured');
  }

  async stopRawVideo(): Promise<void> {}

  getSnapshot(): DroneSnapshot {
    return structuredClone(this.snapshot);
  }

  onChange(listener: (snapshot: DroneSnapshot) => void): () => void {
    this.on('change', listener);
    return () => this.off('change', listener);
  }

  private tick(): void {
    const telemetry = this.snapshot.telemetry;
    const airborne = !['landed', 'landing', 'emergency'].includes(telemetry.flyingState);
    if (airborne) {
      telemetry.flyingState = this.command.active ? 'flying' : 'hovering';
      telemetry.speedX = this.command.pitch / 25;
      telemetry.speedY = this.command.roll / 25;
      telemetry.speedZ = this.command.gaz / 25;
      telemetry.altitude = Math.max(0.2, Math.min(10, telemetry.altitude + telemetry.speedZ * 0.1));
      telemetry.battery = Math.max(0, telemetry.battery - 0.01);
    } else {
      telemetry.speedX = telemetry.speedY = telemetry.speedZ = 0;
    }
    telemetry.updatedAt = Date.now();
    this.emitSnapshot();
  }

  private requireConnected(): void {
    if (this.snapshot.connectionState !== 'connected') throw new Error('Drone is not connected');
  }

  private patch(patch: Partial<DroneSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    this.emitSnapshot();
  }

  private emitSnapshot(): void {
    this.emit('change', this.getSnapshot());
  }
}

export class BebopDrone extends EventEmitter implements DroneAdapter {
  private client: any;
  private connectPromise?: Promise<void>;
  private media?: BebopArStream2Video;
  private mjpegStream?: Readable;
  private rawStream?: Readable;
  private snapshot: DroneSnapshot = new SimulatedDrone().getSnapshot();

  constructor(private readonly log: AdapterLogger) {
    super();
  }

  async connect(): Promise<void> {
    if (this.snapshot.connectionState === 'connected') return;
    if (this.connectPromise) return this.connectPromise;

    this.connectPromise = this.connectInternal();
    try {
      await this.connectPromise;
    } catch (error) {
      await this.media?.stop().catch(() => undefined);
      this.media = undefined;
      this.client = undefined;
      this.patchConnection('fault');
      throw error;
    } finally {
      this.connectPromise = undefined;
    }
  }

  async disconnect(): Promise<void> {
    await Promise.allSettled([this.stopVideo(), this.stopRawVideo()]);
    await this.media?.stop().catch(() => undefined);
    this.media = undefined;
    this.stopMovement();
    this.client?.disconnect?.();
    this.client = undefined;
    this.patchConnection('disconnected');
  }

  async takeoff(): Promise<void> {
    this.requireClient();
    this.client.takeOff();
  }

  async land(): Promise<void> {
    this.requireClient();
    this.client.land();
  }

  async emergency(): Promise<void> {
    this.requireClient();
    this.client.emergency();
  }

  setPilotingCommand(command: PilotingCommand): void {
    this.requireClient();
    this.client.stop();
    if (!command.active) return;
    if (command.pitch > 0) this.client.forward(command.pitch);
    if (command.pitch < 0) this.client.backward(-command.pitch);
    if (command.roll > 0) this.client.right(command.roll);
    if (command.roll < 0) this.client.left(-command.roll);
    if (command.yaw > 0) this.client.clockwise(command.yaw);
    if (command.yaw < 0) this.client.counterClockwise(-command.yaw);
    if (command.gaz > 0) this.client.up(command.gaz);
    if (command.gaz < 0) this.client.down(-command.gaz);
  }

  stopMovement(): void {
    this.client?.stop?.();
  }

  async startVideo(): Promise<Readable> {
    this.requireClient();
    if (this.mjpegStream) return this.mjpegStream;
    this.patchVideo('starting');
    try {
      const stream = await this.requireMedia().acquireMjpeg();
      this.mjpegStream = stream;
      this.patchVideo('running');
      return stream;
    } catch (error) {
      this.patchVideo('fault');
      throw error;
    }
  }

  async stopVideo(): Promise<void> {
    const stream = this.mjpegStream;
    this.mjpegStream = undefined;
    await this.media?.releaseMjpeg(stream);
    this.patchVideo('disabled');
  }

  async startRawVideo(): Promise<Readable> {
    this.requireClient();
    if (this.rawStream) return this.rawStream;
    const stream = await this.requireMedia().acquireRaw();
    this.rawStream = stream;
    return stream;
  }

  async stopRawVideo(): Promise<void> {
    const stream = this.rawStream;
    this.rawStream = undefined;
    await this.media?.releaseRaw(stream);
  }

  getSnapshot(): DroneSnapshot {
    return structuredClone(this.snapshot);
  }

  onChange(listener: (snapshot: DroneSnapshot) => void): () => void {
    this.on('change', listener);
    return () => this.off('change', listener);
  }

  private async connectInternal(): Promise<void> {
    this.patchConnection('connecting');
    const module = await import('node-bebop');
    const bebop = (module as any).default ?? module;
    this.client = bebop.createClient();

    const streamPort = numberFromEnv('BEBOP_ARSTREAM2_STREAM_PORT', 55004);
    const controlPort = numberFromEnv('BEBOP_ARSTREAM2_CONTROL_PORT', 55005);
    const startTimeoutMs = numberFromEnv('VIDEO_START_TIMEOUT_MS', 8000);
    const droneIp = String(this.client.ip ?? process.env.BEBOP_IP ?? '192.168.42.1');

    installArStream2Discovery(this.client, {
      streamPort,
      controlPort,
      onResponse: (response) => this.logDiscovery(response),
    });

    this.media = new BebopArStream2Video({
      droneIp,
      streamPort,
      controlPort,
      ffmpegBin: process.env.FFMPEG_BIN ?? 'ffmpeg',
      startTimeoutMs,
      enableVideo: () => this.client?.MediaStreaming?.videoEnable?.(1),
      disableVideo: () => this.client?.MediaStreaming?.videoEnable?.(0),
    });

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        const discoveryError = this.client?._arstream2DiscoveryError;
        reject(discoveryError instanceof Error ? discoveryError : new Error('Bebop connection timed out'));
      }, 10000);
      this.client.connect(() => {
        clearTimeout(timeout);
        this.bindTelemetry();
        this.patchConnection('connected');
        resolve();
      });
    });
  }

  private bindTelemetry(): void {
    const update = () => {
      this.snapshot.telemetry.updatedAt = Date.now();
      this.emit('change', this.getSnapshot());
    };
    const setFlyingState = (state: FlyingState) => {
      this.snapshot.telemetry.flyingState = state;
      update();
    };

    this.client.on('battery', (value: number) => {
      this.snapshot.telemetry.battery = value;
      update();
    });
    this.client.on('altitude', (value: number) => {
      this.snapshot.telemetry.altitude = value;
      update();
    });
    this.client.on('flyingState', (value: string) => {
      const state = normalizeFlyingState(value);
      if (!state) {
        this.log.warn({ value }, 'Ignored unknown Bebop flying state');
        return;
      }
      setFlyingState(state);
    });

    for (const state of flyingStates) {
      this.client.on(state, () => setFlyingState(state));
    }
  }

  private logDiscovery(response: ArStream2DiscoveryResponse): void {
    this.log.info({
      c2dPort: response.c2d_port,
      serverStreamPort: response.arstream2_server_stream_port,
      serverControlPort: response.arstream2_server_control_port,
    }, 'Bebop ARStream2 discovery completed');
  }

  private patchConnection(connectionState: ConnectionState): void {
    this.snapshot.connectionState = connectionState;
    this.emit('change', this.getSnapshot());
  }

  private patchVideo(videoState: DroneSnapshot['videoState']): void {
    this.snapshot.videoState = videoState;
    this.emit('change', this.getSnapshot());
  }

  private requireClient(): void {
    if (!this.client || this.snapshot.connectionState !== 'connected') throw new Error('Drone is not connected');
  }

  private requireMedia(): BebopArStream2Video {
    if (!this.media) throw new Error('Bebop ARStream2 media transport is not initialized');
    return this.media;
  }
}

export function createDroneAdapter(mode: string | undefined, log: AdapterLogger): DroneAdapter {
  return mode === 'bebop' ? new BebopDrone(log) : new SimulatedDrone();
}

function numberFromEnv(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value <= 0 || value > 65535) {
    throw new Error(`${name} must be a valid TCP/UDP port`);
  }
  return value;
}
