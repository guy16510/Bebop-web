import 'dotenv/config';
import express from 'express';
import { createServer } from 'node:http';
import { EventEmitter } from 'node:events';
import type { Readable } from 'node:stream';
import { WebSocketServer, WebSocket } from 'ws';
import { z } from 'zod';
import pino from 'pino';
import {
  clampCommand,
  ConnectionState,
  DroneAdapter,
  DroneSnapshot,
  FlyingState,
  PilotingCommand,
  ZERO_COMMAND,
} from './types.js';
import { MjpegVideoManager } from './video.js';
import { RawVideoManager, defaultCapturePath } from './raw-video.js';
import { DEFAULT_SAFETY_CONFIG, SafetyController } from './safety.js';

const log = pino({ level: process.env.LOG_LEVEL ?? 'info' });
const port = Number(process.env.PORT ?? 3000);
const commandTimeoutMs = Number(process.env.COMMAND_TIMEOUT_MS ?? 250);
const commandRateHz = Number(process.env.COMMAND_RATE_HZ ?? 20);
const maxCommand = Number(process.env.MAX_COMMAND_PERCENT ?? 35);

const safety = new SafetyController({
  armWindowMs: Number(process.env.ARM_WINDOW_MS ?? DEFAULT_SAFETY_CONFIG.armWindowMs),
  telemetryWarningMs: Number(process.env.TELEMETRY_WARNING_MS ?? DEFAULT_SAFETY_CONFIG.telemetryWarningMs),
  telemetryLockoutMs: Number(process.env.TELEMETRY_LOCKOUT_MS ?? DEFAULT_SAFETY_CONFIG.telemetryLockoutMs),
  minimumTakeoffBatteryPercent: Number(
    process.env.MINIMUM_TAKEOFF_BATTERY_PERCENT ?? DEFAULT_SAFETY_CONFIG.minimumTakeoffBatteryPercent,
  ),
  criticalBatteryPercent: Number(
    process.env.CRITICAL_BATTERY_PERCENT ?? DEFAULT_SAFETY_CONFIG.criticalBatteryPercent,
  ),
  maximumAltitudeMeters: Number(
    process.env.MAXIMUM_ALTITUDE_METERS ?? DEFAULT_SAFETY_CONFIG.maximumAltitudeMeters,
  ),
});

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

class SimulatedDrone extends EventEmitter implements DroneAdapter {
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

  async connect() {
    this.patch({ connectionState: 'connecting' });
    await new Promise((resolve) => setTimeout(resolve, 400));
    this.patch({ connectionState: 'connected' });
    this.timer = setInterval(() => this.tick(), 100);
  }

  async disconnect() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.command = ZERO_COMMAND;
    this.patch({ connectionState: 'disconnected', videoState: 'disabled' });
  }

  async takeoff() {
    this.requireConnected();
    this.snapshot.telemetry.flyingState = 'takingOff';
    this.emitSnapshot();
    setTimeout(() => {
      this.snapshot.telemetry.flyingState = 'hovering';
      this.snapshot.telemetry.altitude = 1;
      this.emitSnapshot();
    }, 900);
  }

  async land() {
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

  async emergency() {
    this.command = ZERO_COMMAND;
    this.snapshot.telemetry.flyingState = 'emergency';
    this.emitSnapshot();
  }

  setPilotingCommand(command: PilotingCommand) { this.command = command; }
  stopMovement() { this.command = ZERO_COMMAND; }
  async startVideo(): Promise<Readable> { throw new Error('Simulation video fixture is not configured'); }
  async stopVideo(): Promise<void> { this.patch({ videoState: 'disabled' }); }
  async startRawVideo(): Promise<Readable> { throw new Error('Simulation raw video fixture is not configured'); }
  async stopRawVideo(): Promise<void> {}
  getSnapshot() { return structuredClone(this.snapshot); }
  onChange(listener: (snapshot: DroneSnapshot) => void) {
    this.on('change', listener);
    return () => this.off('change', listener);
  }

  private tick() {
    const t = this.snapshot.telemetry;
    const airborne = !['landed', 'landing', 'emergency'].includes(t.flyingState);
    if (airborne) {
      t.flyingState = this.command.active ? 'flying' : 'hovering';
      t.speedX = this.command.pitch / 25;
      t.speedY = this.command.roll / 25;
      t.speedZ = this.command.gaz / 25;
      t.altitude = Math.max(0.2, Math.min(10, t.altitude + t.speedZ * 0.1));
      t.battery = Math.max(0, t.battery - 0.01);
    } else {
      t.speedX = t.speedY = t.speedZ = 0;
    }
    t.updatedAt = Date.now();
    this.emitSnapshot();
  }

  private requireConnected() {
    if (this.snapshot.connectionState !== 'connected') throw new Error('Drone is not connected');
  }
  private patch(patch: Partial<DroneSnapshot>) {
    this.snapshot = { ...this.snapshot, ...patch };
    this.emitSnapshot();
  }
  private emitSnapshot() { this.emit('change', this.getSnapshot()); }
}

class BebopDrone extends EventEmitter implements DroneAdapter {
  private client: any;
  private mjpegStream?: Readable;
  private rawStream?: Readable;
  private snapshot: DroneSnapshot = new SimulatedDrone().getSnapshot();

  async connect() {
    if (this.snapshot.connectionState === 'connected') return;
    this.patchConnection('connecting');
    const module = await import('node-bebop');
    const bebop = (module as any).default ?? module;
    this.client = bebop.createClient();
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Bebop connection timed out')), 10000);
      this.client.connect(() => {
        clearTimeout(timeout);
        this.bindTelemetry();
        this.patchConnection('connected');
        resolve();
      });
    });
  }

  async disconnect() {
    await Promise.allSettled([this.stopVideo(), this.stopRawVideo()]);
    this.stopMovement();
    this.client?.disconnect?.();
    this.client = undefined;
    this.patchConnection('disconnected');
  }

  async takeoff() { this.requireClient(); this.client.takeOff(); }
  async land() { this.requireClient(); this.client.land(); }
  async emergency() { this.requireClient(); this.client.emergency(); }

  setPilotingCommand(command: PilotingCommand) {
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

  stopMovement() { this.client?.stop?.(); }

  async startVideo(): Promise<Readable> {
    this.requireClient();
    if (this.mjpegStream) return this.mjpegStream;
    this.patchVideo('starting');
    const stream: Readable = this.client.getMjpegStream();
    this.mjpegStream = stream;
    this.client.MediaStreaming.videoEnable(1);
    this.patchVideo('running');
    return stream;
  }

  async stopVideo(): Promise<void> {
    this.mjpegStream = undefined;
    if (!this.rawStream && this.client) this.client.MediaStreaming?.videoEnable?.(0);
    this.patchVideo('disabled');
  }

  async startRawVideo(): Promise<Readable> {
    this.requireClient();
    if (this.rawStream) return this.rawStream;
    const stream: Readable = this.client.getVideoStream();
    this.rawStream = stream;
    this.client.MediaStreaming.videoEnable(1);
    return stream;
  }

  async stopRawVideo(): Promise<void> {
    this.rawStream = undefined;
    if (!this.mjpegStream && this.client) this.client.MediaStreaming?.videoEnable?.(0);
  }

  getSnapshot() { return structuredClone(this.snapshot); }
  onChange(listener: (snapshot: DroneSnapshot) => void) {
    this.on('change', listener);
    return () => this.off('change', listener);
  }

  private bindTelemetry() {
    const update = () => {
      this.snapshot.telemetry.updatedAt = Date.now();
      this.emit('change', this.getSnapshot());
    };
    this.client.on('battery', (value: number) => { this.snapshot.telemetry.battery = value; update(); });
    this.client.on('altitude', (value: number) => { this.snapshot.telemetry.altitude = value; update(); });
    this.client.on('flyingState', (value: string) => {
      const state = normalizeFlyingState(value);
      if (!state) {
        log.warn({ value }, 'Ignored unknown Bebop flying state');
        return;
      }
      this.snapshot.telemetry.flyingState = state;
      update();
    });
  }

  private patchConnection(connectionState: ConnectionState) {
    this.snapshot.connectionState = connectionState;
    this.emit('change', this.getSnapshot());
  }
  private patchVideo(videoState: DroneSnapshot['videoState']) {
    this.snapshot.videoState = videoState;
    this.emit('change', this.getSnapshot());
  }
  private requireClient() {
    if (!this.client || this.snapshot.connectionState !== 'connected') throw new Error('Drone is not connected');
  }
}

const adapter: DroneAdapter = process.env.DRONE_MODE === 'bebop' ? new BebopDrone() : new SimulatedDrone();
const video = new MjpegVideoManager(adapter);
const rawVideo = new RawVideoManager(adapter);
const app = express();
app.use(express.json());
app.use(express.static('public'));
app.get('/api/health', (_req, res) => res.json({ ok: true, mode: process.env.DRONE_MODE ?? 'simulated' }));
app.get('/api/state', (_req, res) => res.json(adapter.getSnapshot()));
app.get('/api/safety', (_req, res) => res.json(safety.getStatus(adapter.getSnapshot())));
app.get('/api/video/health', (_req, res) => res.json(video.getHealth()));
app.get('/api/raw-video/health', (_req, res) => res.json(rawVideo.getHealth()));
app.post('/api/video/start', async (_req, res) => {
  try { await video.start(); res.json(video.getHealth()); }
  catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.error({ error: message }, 'Video start failed');
    res.status(500).json({ error: message });
  }
});
app.post('/api/video/stop', async (_req, res) => { await video.stop(); res.json(video.getHealth()); });
app.post('/api/raw-video/start', async (req, res) => {
  try {
    const capture = req.body?.capture !== false;
    const inspectWithGstreamer = req.body?.inspectWithGstreamer === true;
    await rawVideo.start({
      capturePath: capture ? defaultCapturePath() : undefined,
      inspectWithGstreamer,
    });
    res.json(rawVideo.getHealth());
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.error({ error: message }, 'Raw video start failed');
    res.status(500).json({ error: message });
  }
});
app.post('/api/raw-video/stop', async (_req, res) => { await rawVideo.stop(); res.json(rawVideo.getHealth()); });
app.get('/video.mjpeg', (_req, res) => video.attach(res));

const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });
let pilot: WebSocket | null = null;
let desiredCommand = ZERO_COMMAND;
let lastCommandAt = 0;
let criticalLandingRequested = false;

const messageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('pilot.acquire') }),
  z.object({ type: z.literal('pilot.release') }),
  z.object({ type: z.literal('pilot.command'), command: z.object({
    roll: z.number(), pitch: z.number(), yaw: z.number(), gaz: z.number(), active: z.boolean(),
  }) }),
  z.object({ type: z.literal('drone.connect') }),
  z.object({ type: z.literal('drone.disconnect') }),
  z.object({ type: z.literal('drone.arm') }),
  z.object({ type: z.literal('drone.disarm') }),
  z.object({ type: z.literal('drone.takeoff') }),
  z.object({ type: z.literal('drone.land') }),
  z.object({ type: z.literal('drone.emergency') }),
  z.object({ type: z.literal('video.start') }),
  z.object({ type: z.literal('video.stop') }),
  z.object({ type: z.literal('raw-video.start'), capture: z.boolean().optional(), inspectWithGstreamer: z.boolean().optional() }),
  z.object({ type: z.literal('raw-video.stop') }),
]);

function broadcast(payload: unknown) {
  const data = JSON.stringify(payload);
  for (const socket of wss.clients) if (socket.readyState === WebSocket.OPEN) socket.send(data);
}

function broadcastSafety(): void {
  broadcast({ type: 'safety.status', status: safety.getStatus(adapter.getSnapshot()) });
}

adapter.onChange((snapshot) => {
  broadcast({ type: 'state', state: snapshot });
  broadcastSafety();
});

wss.on('connection', (socket) => {
  socket.send(JSON.stringify({ type: 'state', state: adapter.getSnapshot() }));
  socket.send(JSON.stringify({ type: 'safety.status', status: safety.getStatus(adapter.getSnapshot()) }));
  socket.send(JSON.stringify({ type: 'video.health', health: video.getHealth() }));
  socket.send(JSON.stringify({ type: 'raw-video.health', health: rawVideo.getHealth() }));
  socket.on('message', async (raw) => {
    try {
      const message = messageSchema.parse(JSON.parse(raw.toString()));
      switch (message.type) {
        case 'pilot.acquire':
          if (!pilot || pilot.readyState !== WebSocket.OPEN) pilot = socket;
          socket.send(JSON.stringify({ type: pilot === socket ? 'pilot.granted' : 'pilot.denied' }));
          break;
        case 'pilot.release':
          if (pilot === socket) { pilot = null; desiredCommand = ZERO_COMMAND; adapter.stopMovement(); }
          break;
        case 'pilot.command': {
          if (pilot !== socket) throw new Error('Pilot control not acquired');
          const candidate = clampCommand(message.command, maxCommand);
          desiredCommand = safety.filterCommand(adapter.getSnapshot(), candidate.active) ? candidate : ZERO_COMMAND;
          lastCommandAt = Date.now();
          break;
        }
        case 'drone.connect':
          await adapter.connect();
          criticalLandingRequested = false;
          break;
        case 'drone.disconnect':
          safety.disarm();
          desiredCommand = ZERO_COMMAND;
          await Promise.allSettled([video.stop(), rawVideo.stop()]);
          await adapter.disconnect();
          break;
        case 'drone.arm':
          safety.arm(adapter.getSnapshot());
          broadcastSafety();
          break;
        case 'drone.disarm':
          safety.disarm();
          broadcastSafety();
          break;
        case 'drone.takeoff':
          safety.assertTakeoffAllowed(adapter.getSnapshot());
          await adapter.takeoff();
          broadcastSafety();
          break;
        case 'drone.land':
          safety.disarm();
          desiredCommand = ZERO_COMMAND;
          adapter.stopMovement();
          await adapter.land();
          broadcastSafety();
          break;
        case 'drone.emergency':
          safety.disarm();
          desiredCommand = ZERO_COMMAND;
          adapter.stopMovement();
          await adapter.emergency();
          broadcastSafety();
          break;
        case 'video.start': await video.start(); break;
        case 'video.stop': await video.stop(); break;
        case 'raw-video.start':
          await rawVideo.start({
            capturePath: message.capture === false ? undefined : defaultCapturePath(),
            inspectWithGstreamer: message.inspectWithGstreamer === true,
          });
          break;
        case 'raw-video.stop': await rawVideo.stop(); break;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      socket.send(JSON.stringify({ type: 'error', message }));
      log.warn({ error: message }, 'WebSocket command rejected');
    }
  });
  socket.on('close', () => {
    if (pilot === socket) {
      pilot = null;
      desiredCommand = ZERO_COMMAND;
      safety.disarm();
      adapter.stopMovement();
      broadcastSafety();
    }
  });
});

setInterval(() => {
  const snapshot = adapter.getSnapshot();
  if (!pilot || Date.now() - lastCommandAt > commandTimeoutMs) desiredCommand = ZERO_COMMAND;
  if (!safety.filterCommand(snapshot, desiredCommand.active)) desiredCommand = ZERO_COMMAND;
  if (snapshot.connectionState === 'connected') adapter.setPilotingCommand(desiredCommand);
}, Math.round(1000 / commandRateHz));

setInterval(async () => {
  const snapshot = adapter.getSnapshot();
  const shouldLand = safety.shouldRequestLanding(snapshot);
  if (shouldLand && !criticalLandingRequested && snapshot.connectionState === 'connected') {
    criticalLandingRequested = true;
    desiredCommand = ZERO_COMMAND;
    adapter.stopMovement();
    log.warn({ battery: snapshot.telemetry.battery }, 'Critical battery, requesting landing');
    await adapter.land().catch((error) => log.error({ error }, 'Critical-battery landing failed'));
  }
  if (!shouldLand && snapshot.telemetry.flyingState === 'landed') criticalLandingRequested = false;

  broadcast({ type: 'video.health', health: video.getHealth() });
  broadcast({ type: 'raw-video.health', health: rawVideo.getHealth() });
  broadcastSafety();
}, 1000);

server.listen(port, () => log.info({ port, mode: process.env.DRONE_MODE ?? 'simulated' }, 'Bebop web server started'));

process.on('SIGINT', async () => {
  safety.disarm();
  adapter.stopMovement();
  await Promise.allSettled([video.stop(), rawVideo.stop()]);
  await adapter.disconnect().catch(() => undefined);
  server.close(() => process.exit(0));
});
