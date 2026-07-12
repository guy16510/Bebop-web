import 'dotenv/config';
import express from 'express';
import { createServer } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import { z } from 'zod';
import pino from 'pino';
import {
  AutonomySettingsManager,
  DEFAULT_AUTONOMY_SETTINGS,
  evaluateAutonomyReadiness,
  isAirborne,
  missionCommand,
  normalizeAutonomySettings,
  type AutonomyReadinessCheck,
  type AutonomySettings,
  type AutonomySettingsStatus,
  type AutonomyStage,
} from './autonomy.js';
import type { SafetyStatus } from './safety.js';
import type { DroneSnapshot, PilotingCommand } from './types.js';

const log = pino({ level: process.env.LOG_LEVEL ?? 'info' });
const controlPort = Number(process.env.PORT ?? 3000);
const autonomyPort = Number(process.env.AUTONOMY_PORT ?? controlPort + 1);
const autonomyHost = process.env.AUTONOMY_HOST ?? '127.0.0.1';
const controlUrl = process.env.AUTONOMY_CONTROL_WS_URL ?? `ws://127.0.0.1:${controlPort}/ws`;
const healthUrl = process.env.AUTONOMY_CONTROL_HEALTH_URL ?? `http://127.0.0.1:${controlPort}/api/health`;
const storagePath = process.env.AUTONOMY_SETTINGS_FILE ?? '.bebop/autonomy.json';

function envBoolean(name: string, fallback: boolean): boolean {
  const value = process.env[name];
  if (value === undefined) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

function envNumber(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  return Number.isFinite(value) ? value : fallback;
}

const defaults = normalizeAutonomySettings({
  ...DEFAULT_AUTONOMY_SETTINGS,
  enabled: envBoolean('AUTONOMY_ENABLED', DEFAULT_AUTONOMY_SETTINGS.enabled),
  allowPhysicalFlight: envBoolean('AUTONOMY_ALLOW_PHYSICAL_FLIGHT', DEFAULT_AUTONOMY_SETTINGS.allowPhysicalFlight),
  requireVideo: envBoolean(
    'AUTONOMY_REQUIRE_VIDEO',
    (process.env.DRONE_MODE ?? 'simulated') === 'bebop' ? true : false,
  ),
  requirePerceptionTracking: envBoolean(
    'AUTONOMY_REQUIRE_PERCEPTION_TRACKING',
    DEFAULT_AUTONOMY_SETTINGS.requirePerceptionTracking,
  ),
  minimumBatteryPercent: envNumber('AUTONOMY_MINIMUM_BATTERY_PERCENT', DEFAULT_AUTONOMY_SETTINGS.minimumBatteryPercent),
  reserveBatteryPercent: envNumber('AUTONOMY_RESERVE_BATTERY_PERCENT', DEFAULT_AUTONOMY_SETTINGS.reserveBatteryPercent),
  minimumSignalRssi: envNumber('AUTONOMY_MINIMUM_SIGNAL_RSSI', DEFAULT_AUTONOMY_SETTINGS.minimumSignalRssi),
  targetAltitudeMeters: envNumber('AUTONOMY_TARGET_ALTITUDE_METERS', DEFAULT_AUTONOMY_SETTINGS.targetAltitudeMeters),
  maximumAltitudeMeters: envNumber('AUTONOMY_MAXIMUM_ALTITUDE_METERS', DEFAULT_AUTONOMY_SETTINGS.maximumAltitudeMeters),
  maximumFlightSeconds: envNumber('AUTONOMY_MAXIMUM_FLIGHT_SECONDS', DEFAULT_AUTONOMY_SETTINGS.maximumFlightSeconds),
  telemetryTimeoutMs: envNumber('AUTONOMY_TELEMETRY_TIMEOUT_MS', DEFAULT_AUTONOMY_SETTINGS.telemetryTimeoutMs),
  commandPercent: envNumber('AUTONOMY_COMMAND_PERCENT', DEFAULT_AUTONOMY_SETTINGS.commandPercent),
  pattern: process.env.AUTONOMY_PATTERN ?? DEFAULT_AUTONOMY_SETTINGS.pattern,
  hoverSeconds: envNumber('AUTONOMY_HOVER_SECONDS', DEFAULT_AUTONOMY_SETTINGS.hoverSeconds),
  yawScanSeconds: envNumber('AUTONOMY_YAW_SCAN_SECONDS', DEFAULT_AUTONOMY_SETTINGS.yawScanSeconds),
});

interface PerceptionHealth {
  state: 'disabled' | 'stopped' | 'starting' | 'running' | 'fault';
  trackingState: 'disabled' | 'initializing' | 'tracking' | 'lost' | 'fault';
  lastError: string | null;
}

interface VideoHealth {
  state: 'disabled' | 'starting' | 'running' | 'fault';
  lastError?: string | null;
}

interface MissionStatus {
  stage: AutonomyStage;
  active: boolean;
  missionId: number;
  mode: string;
  controlLink: 'disconnected' | 'connecting' | 'connected';
  startedAt: number | null;
  stageStartedAt: number;
  deadlineAt: number | null;
  completedAt: number | null;
  lastError: string | null;
  abortReason: string | null;
  readiness: AutonomyReadinessCheck[];
  settings: AutonomySettingsStatus;
  telemetry: DroneSnapshot['telemetry'] | null;
  videoState: VideoHealth['state'] | null;
  perceptionState: PerceptionHealth['state'] | null;
  trackingState: PerceptionHealth['trackingState'] | null;
  updatedAt: number;
}

const app = express();
app.use(express.json());
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'content-type');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  next();
});

const server = createServer(app);
const dashboardSockets = new WebSocketServer({ server, path: '/ws' });
let controlSocket: WebSocket | null = null;
let reconnectTimer: NodeJS.Timeout | undefined;
let mode = process.env.DRONE_MODE ?? 'simulated';
let drone: DroneSnapshot | null = null;
let safety: SafetyStatus | null = null;
let video: VideoHealth | null = null;
let perception: PerceptionHealth | null = null;
let stage: AutonomyStage = 'idle';
let stageStartedAt = Date.now();
let missionId = 0;
let startedAt: number | null = null;
let deadlineAt: number | null = null;
let completedAt: number | null = null;
let lastError: string | null = null;
let abortReason: string | null = null;
let pilotOwned = false;
let lastCommandActive = false;
let lowSignalSince: number | null = null;
let perceptionLostSince: number | null = null;
let finalStageAfterLanding: 'completed' | 'aborted' | 'fault' = 'completed';
let shuttingDown = false;

function isMissionActive(): boolean {
  return ['preflight', 'acquiring-controls', 'arming', 'taking-off', 'climbing', 'executing', 'landing'].includes(stage);
}

function readiness(now = Date.now()): AutonomyReadinessCheck[] {
  return evaluateAutonomyReadiness(settingsManager.getStatus().settings, {
    mode,
    serviceConnected: controlSocket?.readyState === WebSocket.OPEN,
    drone,
    safety,
    videoState: video?.state ?? null,
    perceptionState: perception?.state ?? null,
    trackingState: perception?.trackingState ?? null,
    missionActive: isMissionActive(),
  }, now);
}

function status(now = Date.now()): MissionStatus {
  return {
    stage: settingsManager.getStatus().settings.enabled ? stage : 'disabled',
    active: isMissionActive(),
    missionId,
    mode,
    controlLink: controlSocket?.readyState === WebSocket.OPEN
      ? 'connected'
      : controlSocket?.readyState === WebSocket.CONNECTING
        ? 'connecting'
        : 'disconnected',
    startedAt,
    stageStartedAt,
    deadlineAt,
    completedAt,
    lastError,
    abortReason,
    readiness: readiness(now),
    settings: settingsManager.getStatus(),
    telemetry: drone?.telemetry ?? null,
    videoState: video?.state ?? null,
    perceptionState: perception?.state ?? null,
    trackingState: perception?.trackingState ?? null,
    updatedAt: now,
  };
}

function broadcastStatus(): void {
  const payload = JSON.stringify({ type: 'autonomy.status', status: status() });
  for (const socket of dashboardSockets.clients) {
    if (socket.readyState === WebSocket.OPEN) socket.send(payload);
  }
}

const settingsManager = new AutonomySettingsManager(defaults, storagePath, Date.now, () => broadcastStatus());
if (!settingsManager.getStatus().settings.enabled) stage = 'disabled';

function transition(next: AutonomyStage, error: string | null = null): void {
  stage = next;
  stageStartedAt = Date.now();
  if (error) lastError = error;
  log.info({ stage: next, missionId, error }, 'Autonomy stage changed');
  broadcastStatus();
}

function sendControl(message: unknown): boolean {
  if (controlSocket?.readyState !== WebSocket.OPEN) return false;
  controlSocket.send(JSON.stringify(message));
  return true;
}

function stopMovement(): void {
  if (lastCommandActive && pilotOwned) sendControl({ type: 'pilot.stop' });
  lastCommandActive = false;
}

function sendCommand(command: PilotingCommand): void {
  if (!pilotOwned) return;
  if (!command.active) {
    stopMovement();
    return;
  }
  lastCommandActive = true;
  sendControl({ type: 'pilot.command', command });
}

function releasePilot(): void {
  stopMovement();
  if (pilotOwned) sendControl({ type: 'pilot.release' });
  pilotOwned = false;
}

function resetMissionTerminal(next: 'completed' | 'aborted' | 'fault'): void {
  stopMovement();
  releasePilot();
  completedAt = Date.now();
  deadlineAt = null;
  transition(next);
}

function beginLanding(reason: string | null, finalStage: 'completed' | 'aborted' | 'fault'): void {
  if (stage === 'landing') return;
  stopMovement();
  finalStageAfterLanding = finalStage;
  if (reason) {
    abortReason = reason;
    if (finalStage === 'fault') lastError = reason;
  }

  if (!isAirborne(drone)) {
    resetMissionTerminal(finalStage);
    return;
  }

  transition('landing');
  if (!sendControl({ type: 'drone.land' })) {
    lastError = 'Control link unavailable while requesting landing';
    finalStageAfterLanding = 'fault';
    broadcastStatus();
  }
}

function abortMission(reason = 'Operator requested abort'): void {
  if (!isMissionActive()) return;
  beginLanding(reason, 'aborted');
}

function emergencyStop(): void {
  stopMovement();
  sendControl({ type: 'drone.emergency' });
  abortReason = 'Emergency motor cut requested';
  resetMissionTerminal('aborted');
}

function missionExecutionDurationMs(settings: AutonomySettings): number {
  return (settings.hoverSeconds + (settings.pattern === 'yaw-scan' ? settings.yawScanSeconds : 0)) * 1_000;
}

function verifyStartConfirmation(confirmation: string | undefined): void {
  if (mode === 'bebop' && confirmation !== 'START AUTONOMOUS FLIGHT') {
    throw new Error('Type START AUTONOMOUS FLIGHT to confirm physical autonomous flight');
  }
}

function startMission(confirmation?: string): MissionStatus {
  if (isMissionActive()) throw new Error('An autonomous mission is already active');
  verifyStartConfirmation(confirmation);
  const checks = evaluateAutonomyReadiness(settingsManager.getStatus().settings, {
    mode,
    serviceConnected: controlSocket?.readyState === WebSocket.OPEN,
    drone,
    safety,
    videoState: video?.state ?? null,
    perceptionState: perception?.state ?? null,
    trackingState: perception?.trackingState ?? null,
    missionActive: false,
  });
  const failed = checks.filter((check) => !check.ok);
  if (failed.length > 0) throw new Error(failed.map((check) => check.detail).join('; '));

  missionId += 1;
  startedAt = Date.now();
  completedAt = null;
  deadlineAt = startedAt + settingsManager.getStatus().settings.maximumFlightSeconds * 1_000;
  lastError = null;
  abortReason = null;
  finalStageAfterLanding = 'completed';
  transition('preflight');
  transition('acquiring-controls');
  if (!sendControl({ type: 'pilot.acquire' })) throw new Error('Control link is not open');
  return status();
}

function handleControlMessage(raw: WebSocket.RawData): void {
  let message: any;
  try {
    message = JSON.parse(raw.toString());
  } catch {
    return;
  }

  if (message.type === 'state') drone = message.state as DroneSnapshot;
  else if (message.type === 'safety.status') safety = message.status as SafetyStatus;
  else if (message.type === 'video.health') video = message.health as VideoHealth;
  else if (message.type === 'perception.status') perception = message.health as PerceptionHealth;
  else if (message.type === 'pilot.granted') {
    pilotOwned = true;
    if (stage === 'acquiring-controls') {
      transition('arming');
      sendControl({ type: 'drone.arm' });
    } else if (stage === 'landing' && isAirborne(drone)) {
      sendControl({ type: 'drone.land' });
    }
  } else if (message.type === 'pilot.denied') {
    pilotOwned = false;
    beginLanding('Another browser owns flight controls', 'fault');
  } else if (message.type === 'pilot.released') {
    pilotOwned = false;
  } else if (message.type === 'error') {
    lastError = String(message.message ?? 'Autonomy command rejected');
    if (isMissionActive()) beginLanding(lastError, 'fault');
  }

  if (stage === 'arming' && safety?.armed) {
    transition('taking-off');
    sendControl({ type: 'drone.takeoff' });
  }

  if (stage === 'taking-off' && drone && ['takingOff', 'hovering', 'flying'].includes(drone.telemetry.flyingState)) {
    transition('climbing');
  }

  if (stage === 'landing' && drone?.telemetry.flyingState === 'landed') {
    resetMissionTerminal(finalStageAfterLanding);
  }

  broadcastStatus();
}

async function refreshMode(): Promise<void> {
  try {
    const response = await fetch(healthUrl);
    if (!response.ok) return;
    const health = await response.json() as { mode?: string };
    if (typeof health.mode === 'string') mode = health.mode;
  } catch {
    // The WebSocket reconnect loop will keep trying while the main server starts.
  }
}

function scheduleReconnect(): void {
  if (reconnectTimer || shuttingDown) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = undefined;
    connectControl();
  }, 1_000);
  reconnectTimer.unref();
}

function connectControl(): void {
  if (shuttingDown || controlSocket?.readyState === WebSocket.OPEN || controlSocket?.readyState === WebSocket.CONNECTING) return;
  const socket = new WebSocket(controlUrl);
  controlSocket = socket;
  broadcastStatus();

  socket.on('open', () => {
    log.info({ controlUrl }, 'Autonomy connected to Bebop Web control server');
    void refreshMode().finally(() => broadcastStatus());
    if (stage === 'landing' && isAirborne(drone)) sendControl({ type: 'drone.land' });
  });
  socket.on('message', handleControlMessage);
  socket.on('close', () => {
    if (controlSocket === socket) controlSocket = null;
    pilotOwned = false;
    stopMovement();
    if (isMissionActive() && isAirborne(drone)) {
      lastError = 'Autonomy lost the control-server connection while airborne';
      finalStageAfterLanding = 'fault';
      stage = 'landing';
      stageStartedAt = Date.now();
    }
    broadcastStatus();
    scheduleReconnect();
  });
  socket.on('error', (error) => {
    log.warn({ error: error.message }, 'Autonomy control connection failed');
  });
}

const settingsPatchSchema = z.object({
  enabled: z.boolean().optional(),
  allowPhysicalFlight: z.boolean().optional(),
  requireVideo: z.boolean().optional(),
  requirePerceptionTracking: z.boolean().optional(),
  minimumBatteryPercent: z.number().optional(),
  reserveBatteryPercent: z.number().optional(),
  minimumSignalRssi: z.number().optional(),
  targetAltitudeMeters: z.number().optional(),
  maximumAltitudeMeters: z.number().optional(),
  maximumFlightSeconds: z.number().optional(),
  telemetryTimeoutMs: z.number().optional(),
  commandPercent: z.number().optional(),
  pattern: z.enum(['hover', 'yaw-scan']).optional(),
  hoverSeconds: z.number().optional(),
  yawScanSeconds: z.number().optional(),
}).strict().refine((value) => Object.keys(value).length > 0, {
  message: 'At least one autonomy setting is required',
});

const startSchema = z.object({ confirmation: z.string().optional() }).strict();

app.get('/api/health', (_req, res) => res.json({ ok: true, controlUrl, mode, status: status() }));
app.get('/api/autonomy', (_req, res) => res.json(status()));
app.post('/api/autonomy/settings', (req, res) => {
  try {
    const patch = settingsPatchSchema.parse(req.body);
    if (isMissionActive()) throw new Error('Autonomy settings cannot change during an active mission');
    const result = settingsManager.update(patch, 'api');
    if (!result.settings.enabled) stage = 'disabled';
    else if (stage === 'disabled') transition('idle');
    res.json(status());
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res.status(400).json({ error: message, status: status() });
  }
});
app.post('/api/autonomy/start', (req, res) => {
  try {
    const { confirmation } = startSchema.parse(req.body ?? {});
    res.json(startMission(confirmation));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    lastError = message;
    res.status(400).json({ error: message, status: status() });
    broadcastStatus();
  }
});
app.post('/api/autonomy/abort', (_req, res) => {
  abortMission();
  res.json(status());
});
app.post('/api/autonomy/land', (_req, res) => {
  beginLanding('Operator requested landing', 'aborted');
  res.json(status());
});
app.post('/api/autonomy/emergency', (_req, res) => {
  emergencyStop();
  res.json(status());
});

dashboardSockets.on('connection', (socket) => {
  socket.send(JSON.stringify({ type: 'autonomy.status', status: status() }));
});

setInterval(() => {
  const now = Date.now();
  const settings = settingsManager.getStatus().settings;

  if (!settings.enabled) {
    if (isMissionActive()) beginLanding('Autonomy was disabled', 'aborted');
    if (!isMissionActive() && stage !== 'disabled') transition('disabled');
    broadcastStatus();
    return;
  }
  if (stage === 'disabled') transition('idle');

  if (isMissionActive()) {
    if (deadlineAt !== null && now >= deadlineAt) beginLanding('Maximum flight time reached', 'aborted');

    const telemetryAge = drone ? now - drone.telemetry.updatedAt : Number.POSITIVE_INFINITY;
    if (telemetryAge > settings.telemetryTimeoutMs) beginLanding('Telemetry became stale', 'fault');
    if (drone && drone.telemetry.battery <= settings.reserveBatteryPercent) {
      beginLanding(`Battery reached ${drone.telemetry.battery.toFixed(0)}% reserve`, 'aborted');
    }
    if (drone && drone.telemetry.altitude > settings.maximumAltitudeMeters) {
      beginLanding('Autonomous altitude ceiling exceeded', 'fault');
    }

    const signal = drone?.telemetry.signalRssi;
    if (typeof signal === 'number' && signal < settings.minimumSignalRssi) {
      lowSignalSince ??= now;
      if (now - lowSignalSince >= 2_000) beginLanding('Wi-Fi signal remained below the mission minimum', 'aborted');
    } else {
      lowSignalSince = null;
    }

    const perceptionHealthy = perception?.state === 'running' && perception.trackingState === 'tracking';
    if (settings.requirePerceptionTracking && !perceptionHealthy) {
      perceptionLostSince ??= now;
      if (now - perceptionLostSince >= 2_000) beginLanding('SLAM tracking was lost', 'aborted');
    } else {
      perceptionLostSince = null;
    }
  }

  const stageElapsedMs = now - stageStartedAt;
  if (stage === 'acquiring-controls' && stageElapsedMs > 5_000) beginLanding('Timed out acquiring controls', 'fault');
  if (stage === 'arming' && stageElapsedMs > 5_000) beginLanding('Timed out arming', 'fault');
  if (stage === 'taking-off' && stageElapsedMs > 10_000) beginLanding('Timed out waiting for takeoff', 'fault');
  if (stage === 'climbing') {
    if (stageElapsedMs > 15_000) {
      beginLanding('Timed out reaching target altitude', 'fault');
    } else {
      const command = missionCommand(settings, stage, drone, stageElapsedMs);
      sendCommand(command);
      if (!command.active && drone && Math.abs(drone.telemetry.altitude - settings.targetAltitudeMeters) <= 0.2) {
        stopMovement();
        transition('executing');
      }
    }
  } else if (stage === 'executing') {
    if (stageElapsedMs >= missionExecutionDurationMs(settings)) {
      beginLanding(null, 'completed');
    } else {
      sendCommand(missionCommand(settings, stage, drone, stageElapsedMs));
    }
  } else if (!['taking-off', 'landing'].includes(stage)) {
    stopMovement();
  }

  if (stage === 'landing' && drone?.telemetry.flyingState === 'landed') {
    resetMissionTerminal(finalStageAfterLanding);
  }

  broadcastStatus();
}, 100).unref();

server.listen(autonomyPort, autonomyHost, () => {
  log.info({ autonomyHost, autonomyPort, controlUrl, storagePath }, 'Autonomy service started');
});

connectControl();

function shutdown(): void {
  if (shuttingDown) return;
  shuttingDown = true;
  stopMovement();
  if (isAirborne(drone)) sendControl({ type: 'drone.land' });
  releasePilot();
  if (reconnectTimer) clearTimeout(reconnectTimer);
  controlSocket?.close();
  server.close();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
