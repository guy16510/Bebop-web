import 'dotenv/config';
import express from 'express';
import { createServer } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { z } from 'zod';
import pino from 'pino';
import { createDroneAdapter } from './drone-adapters.js';
import { PerceptionManager, type PerceptionBackend, type PerceptionSnapshot } from './perception.js';
import { clampCommand, ZERO_COMMAND, type PilotingCommand } from './types.js';
import { MjpegVideoManager } from './video.js';
import { RawVideoManager, defaultCapturePath } from './raw-video.js';
import { DEFAULT_SAFETY_CONFIG, SafetyController } from './safety.js';
import {
  RuntimeFeatureManager,
  type RuntimeFeatureSettings,
  type RuntimeFeatureStatus,
} from './runtime-features.js';
import type { MappingAutostartStatus } from './mapping-autostart.js';
import { ObjectRecognitionManager, type RecognizableDetection } from './object-recognition.js';
import { RecognitionVisionManager } from './recognition-vision.js';

const log = pino({ level: process.env.LOG_LEVEL ?? 'info' });
const port = Number(process.env.PORT ?? 3000);
const commandTimeoutMs = Number(process.env.COMMAND_TIMEOUT_MS ?? 250);
const commandRateHz = Number(process.env.COMMAND_RATE_HZ ?? 20);
const maxCommand = Number(process.env.MAX_COMMAND_PERCENT ?? 35);
const droneMode = process.env.DRONE_MODE ?? 'simulated';

function envBoolean(name: string, fallback: boolean): boolean {
  const value = process.env[name];
  if (value === undefined) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

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

function resolvePerceptionBackend(): PerceptionBackend {
  const fallback: PerceptionBackend = droneMode === 'bebop' ? 'disabled' : 'simulation';
  const value = process.env.PERCEPTION_BACKEND ?? fallback;
  if (value !== 'disabled' && value !== 'simulation' && value !== 'external') {
    throw new Error('PERCEPTION_BACKEND must be disabled, simulation, or external');
  }
  return value;
}

const perceptionBackend = resolvePerceptionBackend();
const adapter = createDroneAdapter(process.env.DRONE_MODE, log);
const video = new MjpegVideoManager(adapter);
const rawVideo = new RawVideoManager(adapter);
const app = express();

app.use(express.json());
app.use(express.static('public'));

const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });
let pilot: WebSocket | null = null;
let desiredCommand = ZERO_COMMAND;
let lastCommandAt = 0;
let criticalLandingRequested = false;
let shuttingDown = false;

function broadcast(payload: unknown): void {
  const data = JSON.stringify(payload);
  for (const socket of wss.clients) {
    if (socket.readyState === WebSocket.OPEN) socket.send(data);
  }
}

const objectRecognition = new ObjectRecognitionManager({
  storagePath: process.env.RECOGNITION_REGISTRY_FILE ?? '.bebop/recognition.json',
  minimumSamples: Number(process.env.RECOGNITION_MINIMUM_SAMPLES ?? 3),
  maximumSamplesPerObject: Number(process.env.RECOGNITION_MAXIMUM_SAMPLES ?? 48),
  minimumMargin: Number(process.env.RECOGNITION_MINIMUM_MARGIN ?? 0.04),
});
let latestRecognizedDetections: RecognizableDetection[] = [];
let latestRecognitionTimestamp = 0;
const recognitionVision = new RecognitionVisionManager({
  command: process.env.RECOGNITION_COMMAND ?? 'bash scripts/run-recognition-sidecar.sh',
  enabled: envBoolean('RECOGNITION_ENABLED', droneMode === 'bebop'),
  restartMs: Number(process.env.RECOGNITION_RESTART_MS ?? 2_000),
  onUpdate: (snapshot) => {
    latestRecognitionTimestamp = snapshot.timestamp;
    latestRecognizedDetections = objectRecognition.recognize(snapshot.detections, snapshot.timestamp);
    broadcastPerceptionStatus();
  },
});
const recognitionStaleMs = Number(process.env.RECOGNITION_STALE_MS ?? 1_500);

function recognitionFresh(now = Date.now()): boolean {
  const health = recognitionVision.getHealth();
  return health.state === 'running'
    && health.lastUpdateAt !== null
    && now - health.lastUpdateAt <= recognitionStaleMs;
}

function enrichedPerceptionSnapshot(base: PerceptionSnapshot): PerceptionSnapshot {
  return { ...base, detections: recognitionFresh() ? latestRecognizedDetections : base.detections };
}

const perception = new PerceptionManager({
  backend: perceptionBackend,
  command: process.env.PERCEPTION_COMMAND,
  updateHz: Number(process.env.PERCEPTION_UPDATE_HZ ?? 10),
  maxTrajectoryPoints: Number(process.env.PERCEPTION_MAX_TRAJECTORY_POINTS ?? 900),
  maxLandmarks: Number(process.env.PERCEPTION_MAX_LANDMARKS ?? 2_500),
  videoUrl: process.env.PERCEPTION_VIDEO_URL ?? `http://127.0.0.1:${port}/video.mjpeg`,
  stateUrl: process.env.PERCEPTION_STATE_URL ?? `http://127.0.0.1:${port}/api/state`,
  onUpdate: (snapshot, health) => broadcast({
    type: 'perception.status',
    snapshot: enrichedPerceptionSnapshot(snapshot),
    health,
    recognition: recognitionStatus(),
  }),
});

function recognitionStatus() {
  return {
    registry: objectRecognition.getStatus(),
    vision: recognitionVision.getHealth(),
    sourceTimestamp: latestRecognitionTimestamp,
    fresh: recognitionFresh(),
    liveDetections: structuredClone(latestRecognizedDetections),
  };
}

function perceptionStatus() {
  return {
    snapshot: enrichedPerceptionSnapshot(perception.getSnapshot()),
    health: perception.getHealth(),
    recognition: recognitionStatus(),
  };
}

function broadcastPerceptionStatus(): void {
  broadcast({ type: 'perception.status', ...perceptionStatus() });
}

function currentRecognitionTrack(trackId: string): RecognizableDetection {
  const detection = recognitionVision.getSnapshot().detections.find((item) => item.id === trackId);
  if (!detection) throw new Error(`Live recognition track ${trackId} was not found`);
  if (Date.now() - detection.lastSeenAt > recognitionStaleMs) throw new Error(`Live recognition track ${trackId} is stale`);
  return detection;
}

function refreshRecognitionMatches(): void {
  const snapshot = recognitionVision.getSnapshot();
  latestRecognitionTimestamp = snapshot.timestamp;
  objectRecognition.resetTrackConfirmations();
  latestRecognizedDetections = objectRecognition.recognize(snapshot.detections, snapshot.timestamp || Date.now());
  broadcastPerceptionStatus();
}

async function runPerceptionAction(
  action: 'start' | 'stop' | 'reset',
): Promise<ReturnType<typeof perceptionStatus>> {
  if (action === 'start') {
    await perception.start();
    recognitionVision.start();
  } else if (action === 'stop') {
    await Promise.all([perception.stop(), recognitionVision.stop()]);
  } else {
    perception.reset();
    objectRecognition.resetTrackConfirmations();
    await recognitionVision.stop();
    recognitionVision.start();
  }
  return perceptionStatus();
}

const autoMappingDefault = envBoolean(
  'AUTO_START_MAPPING',
  droneMode === 'bebop' && perceptionBackend === 'external',
);
const featureDefaults: RuntimeFeatureSettings = {
  autoConnect: envBoolean('FEATURE_AUTO_CONNECT', autoMappingDefault),
  video: envBoolean('FEATURE_VIDEO_ENABLED', autoMappingDefault),
  perception: envBoolean(
    'FEATURE_PERCEPTION_ENABLED',
    autoMappingDefault && perceptionBackend !== 'disabled',
  ),
  showDetections: envBoolean('FEATURE_SHOW_DETECTIONS', true),
  showMap: envBoolean('FEATURE_SHOW_MAP', true),
};

const features = new RuntimeFeatureManager({
  defaults: featureDefaults,
  storagePath: process.env.RUNTIME_FEATURES_FILE ?? '.bebop/runtime-features.json',
  onChange: (status) => broadcast({ type: 'features.status', status }),
});

if (perceptionBackend === 'disabled' && features.getStatus().settings.perception) {
  features.update({ perception: false }, 'environment');
}

const initialDesired = features.getStatus().settings;
let automationStatus: MappingAutostartStatus = {
  enabled: initialDesired.autoConnect || initialDesired.video || initialDesired.perception,
  desired: {
    autoConnect: initialDesired.autoConnect,
    video: initialDesired.video,
    perception: initialDesired.perception,
  },
  stage: initialDesired.autoConnect || initialDesired.video || initialDesired.perception
    ? 'waiting-for-drone'
    : 'disabled',
  attempts: 0,
  recoveries: 0,
  lastError: null,
  updatedAt: Date.now(),
};

const runtimeFeaturePatchSchema = z.object({
  autoConnect: z.boolean().optional(),
  video: z.boolean().optional(),
  perception: z.boolean().optional(),
  showDetections: z.boolean().optional(),
  showMap: z.boolean().optional(),
}).strict().refine((value) => Object.keys(value).length > 0, {
  message: 'At least one feature setting is required',
});

const automationStatusSchema = z.object({
  enabled: z.boolean(),
  desired: z.object({
    autoConnect: z.boolean(),
    video: z.boolean(),
    perception: z.boolean(),
  }),
  stage: z.enum([
    'disabled',
    'waiting-for-drone',
    'connecting',
    'connected',
    'starting-video',
    'waiting-for-video',
    'video-only',
    'starting-perception',
    'initializing',
    'mapping',
    'recovering',
    'fault',
  ]),
  attempts: z.number().int().nonnegative(),
  recoveries: z.number().int().nonnegative(),
  lastError: z.string().nullable(),
  updatedAt: z.number().int().nonnegative(),
});

function updateFeatures(
  patch: Partial<RuntimeFeatureSettings>,
  source: RuntimeFeatureStatus['updatedBy'],
): RuntimeFeatureStatus {
  if (patch.perception === true && perceptionBackend === 'disabled') {
    throw new Error('Perception cannot be enabled while PERCEPTION_BACKEND is disabled');
  }
  return features.update(patch, source);
}

app.get('/api/health', (_req, res) => res.json({
  ok: true,
  mode: droneMode,
  perceptionBackend,
  features: features.getStatus(),
  recognition: recognitionStatus(),
}));
app.get('/api/state', (_req, res) => res.json(adapter.getSnapshot()));
app.get('/api/safety', (_req, res) => res.json(safety.getStatus(adapter.getSnapshot())));
app.get('/api/video/health', (_req, res) => res.json(video.getHealth()));
app.get('/api/raw-video/health', (_req, res) => res.json(rawVideo.getHealth()));
app.get('/api/features', (_req, res) => res.json(features.getStatus()));
app.get('/api/automation', (_req, res) => res.json(automationStatus));
app.post('/api/features', (req, res) => {
  try {
    const patch = runtimeFeaturePatchSchema.parse(req.body);
    res.json(updateFeatures(patch, 'api'));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res.status(400).json({ error: message, status: features.getStatus() });
  }
});
app.post('/api/video/start', async (_req, res) => {
  try {
    await video.start();
    res.json(video.getHealth());
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.error({ error: message }, 'Video start failed');
    res.status(500).json({ error: message });
  }
});
app.post('/api/video/stop', async (_req, res) => {
  await video.stop();
  res.json(video.getHealth());
});
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
app.post('/api/raw-video/stop', async (_req, res) => {
  await rawVideo.stop();
  res.json(rawVideo.getHealth());
});
app.get('/video.mjpeg', (_req, res) => video.attach(res));

const perceptionActionSchema = z.enum(['start', 'stop', 'reset']);
app.get('/api/perception/status', (_req, res) => res.json(perceptionStatus()));
app.post('/api/perception/:action', async (req, res) => {
  try {
    const action = perceptionActionSchema.parse(req.params.action);
    res.json(await runPerceptionAction(action));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.error({ action: req.params.action, error: message }, 'Perception action failed');
    res.status(500).json({ error: message, ...perceptionStatus() });
  }
});

const recognitionEnrollSchema = z.object({ name: z.string().trim().min(1).max(128), trackId: z.string().min(1).max(128) });
const recognitionSampleSchema = z.object({ trackId: z.string().min(1).max(128) });
const recognitionUpdateSchema = z.object({
  name: z.string().trim().min(1).max(128).optional(),
  labels: z.array(z.string().trim().min(1).max(128)).min(1).max(16).optional(),
  enabled: z.boolean().optional(),
  threshold: z.number().finite().min(0.45).max(0.99).optional(),
  minimumConfirmations: z.number().int().min(1).max(12).optional(),
}).strict().refine((value) => Object.keys(value).length > 0, { message: 'At least one update is required' });
app.get('/api/recognition/status', (_req, res) => res.json(recognitionStatus()));
app.post('/api/recognition/objects', (req, res) => {
  try {
    const input = recognitionEnrollSchema.parse(req.body);
    const object = objectRecognition.enroll(input.name, currentRecognitionTrack(input.trackId));
    refreshRecognitionMatches();
    res.status(201).json({ object, ...recognitionStatus() });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error), ...recognitionStatus() });
  }
});
app.post('/api/recognition/objects/:objectId/samples', (req, res) => {
  try {
    const input = recognitionSampleSchema.parse(req.body);
    const object = objectRecognition.addSample(req.params.objectId, currentRecognitionTrack(input.trackId));
    refreshRecognitionMatches();
    res.json({ object, ...recognitionStatus() });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error), ...recognitionStatus() });
  }
});
app.post('/api/recognition/objects/:objectId', (req, res) => {
  try {
    const object = objectRecognition.update(req.params.objectId, recognitionUpdateSchema.parse(req.body));
    refreshRecognitionMatches();
    res.json({ object, ...recognitionStatus() });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error), ...recognitionStatus() });
  }
});
app.delete('/api/recognition/objects/:objectId', (req, res) => {
  try {
    objectRecognition.remove(req.params.objectId);
    refreshRecognitionMatches();
    res.json(recognitionStatus());
  } catch (error) {
    res.status(404).json({ error: error instanceof Error ? error.message : String(error), ...recognitionStatus() });
  }
});

const sequenceSchema = z.number().int().nonnegative().optional();
const messageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('diagnostic.ping'), id: z.number().int().nonnegative() }),
  z.object({ type: z.literal('pilot.acquire') }),
  z.object({ type: z.literal('pilot.release') }),
  z.object({ type: z.literal('pilot.stop'), sequence: sequenceSchema }),
  z.object({
    type: z.literal('pilot.command'),
    sequence: sequenceSchema,
    command: z.object({
      roll: z.number(),
      pitch: z.number(),
      yaw: z.number(),
      gaz: z.number(),
      active: z.boolean(),
    }),
  }),
  z.object({ type: z.literal('drone.connect') }),
  z.object({ type: z.literal('drone.disconnect') }),
  z.object({ type: z.literal('drone.arm') }),
  z.object({ type: z.literal('drone.disarm') }),
  z.object({ type: z.literal('drone.takeoff') }),
  z.object({ type: z.literal('drone.land') }),
  z.object({ type: z.literal('drone.emergency') }),
  z.object({
    type: z.literal('drone.camera'),
    tilt: z.number().finite().min(-100).max(100),
    pan: z.number().finite().min(-100).max(100),
  }),
  z.object({ type: z.literal('video.start') }),
  z.object({ type: z.literal('video.stop') }),
  z.object({
    type: z.literal('raw-video.start'),
    capture: z.boolean().optional(),
    inspectWithGstreamer: z.boolean().optional(),
  }),
  z.object({ type: z.literal('raw-video.stop') }),
  z.object({ type: z.literal('perception.start') }),
  z.object({ type: z.literal('perception.stop') }),
  z.object({ type: z.literal('perception.reset') }),
  z.object({ type: z.literal('features.set'), settings: runtimeFeaturePatchSchema }),
  z.object({ type: z.literal('automation.report'), status: automationStatusSchema }),
]);

function broadcastSafety(): void {
  broadcast({ type: 'safety.status', status: safety.getStatus(adapter.getSnapshot()) });
}

function assertPilot(socket: WebSocket): void {
  if (pilot !== socket) throw new Error('Pilot control not acquired');
}

function stopPiloting(): void {
  desiredCommand = ZERO_COMMAND;
  lastCommandAt = 0;
  adapter.stopMovement();
}

function applyDesiredCommandNow(): number {
  if (adapter.getSnapshot().connectionState !== 'connected') throw new Error('Drone is not connected');
  adapter.setPilotingCommand(desiredCommand);
  return Date.now();
}

function sendPilotAck(
  socket: WebSocket,
  sequence: number | undefined,
  kind: 'command' | 'stop',
  command: PilotingCommand,
  accepted: boolean,
  serverReceivedAt: number,
  serverAppliedAt: number,
): void {
  if (sequence === undefined) return;
  socket.send(JSON.stringify({
    type: 'pilot.ack',
    sequence,
    kind,
    command,
    accepted,
    serverReceivedAt,
    serverAppliedAt,
  }));
}

adapter.onChange((snapshot) => {
  perception.updateTelemetry(snapshot.telemetry);
  broadcast({ type: 'state', state: snapshot });
  broadcastSafety();
});

wss.on('connection', (socket) => {
  socket.send(JSON.stringify({ type: 'state', state: adapter.getSnapshot() }));
  socket.send(JSON.stringify({ type: 'safety.status', status: safety.getStatus(adapter.getSnapshot()) }));
  socket.send(JSON.stringify({ type: 'video.health', health: video.getHealth() }));
  socket.send(JSON.stringify({ type: 'raw-video.health', health: rawVideo.getHealth() }));
  socket.send(JSON.stringify({ type: 'perception.status', ...perceptionStatus() }));
  socket.send(JSON.stringify({ type: 'features.status', status: features.getStatus() }));
  socket.send(JSON.stringify({ type: 'automation.status', status: automationStatus }));

  socket.on('message', async (raw) => {
    try {
      const message = messageSchema.parse(JSON.parse(raw.toString()));
      switch (message.type) {
        case 'diagnostic.ping':
          socket.send(JSON.stringify({ type: 'diagnostic.pong', id: message.id }));
          break;
        case 'pilot.acquire':
          if (!pilot || pilot.readyState !== WebSocket.OPEN) {
            stopPiloting();
            pilot = socket;
          }
          socket.send(JSON.stringify({ type: pilot === socket ? 'pilot.granted' : 'pilot.denied' }));
          break;
        case 'pilot.release':
          if (pilot === socket) {
            stopPiloting();
            safety.disarm();
            pilot = null;
            socket.send(JSON.stringify({ type: 'pilot.released' }));
            broadcastSafety();
          }
          break;
        case 'pilot.stop': {
          assertPilot(socket);
          const serverReceivedAt = Date.now();
          stopPiloting();
          sendPilotAck(socket, message.sequence, 'stop', ZERO_COMMAND, true, serverReceivedAt, Date.now());
          socket.send(JSON.stringify({ type: 'pilot.stopped' }));
          break;
        }
        case 'pilot.command': {
          assertPilot(socket);
          const serverReceivedAt = Date.now();
          const candidate = clampCommand(message.command, maxCommand);
          if (!candidate.active) {
            stopPiloting();
            sendPilotAck(socket, message.sequence, 'command', ZERO_COMMAND, true, serverReceivedAt, Date.now());
            break;
          }

          const allowedCommand = safety.filterCommand(adapter.getSnapshot(), candidate);
          if (!allowedCommand) {
            stopPiloting();
            sendPilotAck(socket, message.sequence, 'command', ZERO_COMMAND, false, serverReceivedAt, Date.now());
            break;
          }

          desiredCommand = allowedCommand;
          lastCommandAt = Date.now();
          const serverAppliedAt = applyDesiredCommandNow();
          sendPilotAck(socket, message.sequence, 'command', desiredCommand, true, serverReceivedAt, serverAppliedAt);
          break;
        }
        case 'drone.connect':
          await adapter.connect();
          criticalLandingRequested = false;
          break;
        case 'drone.disconnect':
          safety.disarm();
          stopPiloting();
          await Promise.allSettled([video.stop(), rawVideo.stop(), perception.stop(), recognitionVision.stop()]);
          await adapter.disconnect();
          broadcastSafety();
          break;
        case 'drone.arm':
          assertPilot(socket);
          safety.arm(adapter.getSnapshot());
          broadcastSafety();
          break;
        case 'drone.disarm':
          safety.disarm();
          stopPiloting();
          broadcastSafety();
          break;
        case 'drone.takeoff':
          assertPilot(socket);
          safety.assertTakeoffAllowed(adapter.getSnapshot());
          await adapter.takeoff();
          broadcastSafety();
          break;
        case 'drone.land':
          safety.disarm();
          stopPiloting();
          await adapter.land();
          broadcastSafety();
          break;
        case 'drone.emergency':
          safety.disarm();
          stopPiloting();
          await adapter.emergency();
          broadcastSafety();
          break;
        case 'drone.camera':
          assertPilot(socket);
          adapter.setCameraOrientation(message.tilt, message.pan);
          break;
        case 'video.start':
          await video.start();
          break;
        case 'video.stop':
          await video.stop();
          break;
        case 'raw-video.start':
          await rawVideo.start({
            capturePath: message.capture === false ? undefined : defaultCapturePath(),
            inspectWithGstreamer: message.inspectWithGstreamer === true,
          });
          break;
        case 'raw-video.stop':
          await rawVideo.stop();
          break;
        case 'perception.start':
          await perception.start();
          recognitionVision.start();
          break;
        case 'perception.stop':
          await Promise.all([perception.stop(), recognitionVision.stop()]);
          break;
        case 'perception.reset':
          perception.reset();
          objectRecognition.resetTrackConfirmations();
          await recognitionVision.stop();
          recognitionVision.start();
          break;
        case 'features.set':
          updateFeatures(message.settings, 'web');
          break;
        case 'automation.report':
          automationStatus = message.status;
          broadcast({ type: 'automation.status', status: automationStatus });
          break;
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
      safety.disarm();
      stopPiloting();
      broadcastSafety();
    }
  });
});

setInterval(() => {
  const snapshot = adapter.getSnapshot();
  const timedOut = !pilot || Date.now() - lastCommandAt > commandTimeoutMs;
  const blocked = desiredCommand.active && !safety.filterCommand(snapshot, desiredCommand);

  if ((timedOut || blocked) && desiredCommand.active) {
    stopPiloting();
    return;
  }

  if (snapshot.connectionState !== 'connected' || !desiredCommand.active) return;

  try {
    adapter.setPilotingCommand(desiredCommand);
  } catch (error) {
    stopPiloting();
    log.error({ error }, 'Failed to refresh piloting command');
  }
}, Math.round(1000 / commandRateHz));

setInterval(async () => {
  const snapshot = adapter.getSnapshot();
  const shouldLand = safety.shouldRequestLanding(snapshot);
  if (shouldLand && !criticalLandingRequested && snapshot.connectionState === 'connected') {
    criticalLandingRequested = true;
    stopPiloting();
    log.warn({ battery: snapshot.telemetry.battery }, 'Critical battery, requesting landing');
    await adapter.land().catch((error) => log.error({ error }, 'Critical-battery landing failed'));
  }
  if (!shouldLand && snapshot.telemetry.flyingState === 'landed') criticalLandingRequested = false;

  broadcast({ type: 'video.health', health: video.getHealth() });
  broadcast({ type: 'raw-video.health', health: rawVideo.getHealth() });
  broadcastSafety();
}, 1000);

server.listen(port, () => {
  log.info({ port, mode: droneMode, perceptionBackend, features: features.getStatus().settings }, 'Bebop web server started');
  if (
    perceptionBackend === 'simulation'
    && process.env.PERCEPTION_AUTO_START !== 'false'
    && features.getStatus().settings.perception
  ) {
    void perception.start().catch((error) => log.error({ error }, 'Perception auto-start failed'));
  }
});

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info({ signal }, 'Shutting down Bebop web server');
  safety.disarm();
  stopPiloting();
  await Promise.allSettled([video.stop(), rawVideo.stop(), perception.stop(), recognitionVision.stop()]);
  await adapter.disconnect().catch(() => undefined);
  server.close(() => process.exit(0));
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
