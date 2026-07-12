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
import { LandingVisionManager, type LandingVisionHealth } from './landing-vision.js';
import {
  NavigationMapManager,
  applyObstacleAvoidance,
  gpsGuidance,
  landingGuidance,
  landingPadDetection,
  rangeFieldFresh,
  resolveSemanticObservations,
  type GuidanceResult,
  type LandingPadDefinition,
  type NavigationMapState,
  type NavigationSettings,
  type RangeField,
  type RangeSectorName,
  type SemanticObservation,
} from './navigation.js';
import type { ObjectDetection, PerceptionSnapshot } from './perception.js';
import type { SafetyStatus } from './safety.js';
import type { DroneSnapshot, PilotingCommand } from './types.js';
import { ZERO_COMMAND } from './types.js';

const log = pino({ level: process.env.LOG_LEVEL ?? 'info' });
const controlPort = Number(process.env.PORT ?? 3000);
const autonomyPort = Number(process.env.AUTONOMY_PORT ?? controlPort + 1);
const autonomyHost = process.env.AUTONOMY_HOST ?? '127.0.0.1';
const controlUrl = process.env.AUTONOMY_CONTROL_WS_URL ?? `ws://127.0.0.1:${controlPort}/ws`;
const healthUrl = process.env.AUTONOMY_CONTROL_HEALTH_URL ?? `http://127.0.0.1:${controlPort}/api/health`;
const storagePath = process.env.AUTONOMY_SETTINGS_FILE ?? '.bebop/autonomy.json';
const navigationStoragePath = process.env.NAVIGATION_MAP_FILE ?? '.bebop/navigation-map.json';
const configuredMode = process.env.DRONE_MODE ?? 'simulated';

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
    configuredMode === 'bebop',
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
  takeoffPadId: process.env.AUTONOMY_TAKEOFF_PAD_ID ?? DEFAULT_AUTONOMY_SETTINGS.takeoffPadId,
  landingPadId: process.env.AUTONOMY_LANDING_PAD_ID ?? DEFAULT_AUTONOMY_SETTINGS.landingPadId,
  requireLandingMarker: envBoolean('AUTONOMY_REQUIRE_LANDING_MARKER', DEFAULT_AUTONOMY_SETTINGS.requireLandingMarker),
  navigationTimeoutSeconds: envNumber(
    'AUTONOMY_NAVIGATION_TIMEOUT_SECONDS',
    DEFAULT_AUTONOMY_SETTINGS.navigationTimeoutSeconds,
  ),
  landingSearchSeconds: envNumber('AUTONOMY_LANDING_SEARCH_SECONDS', DEFAULT_AUTONOMY_SETTINGS.landingSearchSeconds),
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

interface NavigationRuntimeStatus {
  map: NavigationMapState;
  rangeField: RangeField | null;
  rangeFresh: boolean;
  semanticObservations: SemanticObservation[];
  targetPad: LandingPadDefinition | null;
  guidanceReason: string | null;
  guidanceDistanceMeters: number | null;
  landingVision: LandingVisionHealth;
  perceptionPose: PerceptionSnapshot['pose'] | null;
  scaleSource: PerceptionSnapshot['scaleSource'] | null;
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
  navigation: NavigationRuntimeStatus;
  updatedAt: number;
}

const app = express();
app.use(express.json({ limit: '256kb' }));
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'content-type');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
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
let mode = configuredMode;
let drone: DroneSnapshot | null = null;
let safety: SafetyStatus | null = null;
let video: VideoHealth | null = null;
let perception: PerceptionHealth | null = null;
let perceptionSnapshot: PerceptionSnapshot | null = null;
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
let navigationHoldSince: number | null = null;
let markerLostSince: number | null = null;
let rangeField: RangeField | null = null;
let guidanceReason: string | null = null;
let guidanceDistanceMeters: number | null = null;
let finalStageAfterLanding: 'completed' | 'aborted' | 'fault' = 'completed';
let shuttingDown = false;

function isMissionActive(): boolean {
  return [
    'preflight',
    'acquiring-controls',
    'arming',
    'taking-off',
    'climbing',
    'executing',
    'navigating',
    'searching-landing-pad',
    'aligning-landing-pad',
    'landing',
  ].includes(stage);
}

const navigationManager = new NavigationMapManager(
  navigationStoragePath,
  Date.now,
  () => broadcastStatus(),
);

const landingVisionCommand = process.env.LANDING_VISION_COMMAND
  ?? (configuredMode === 'bebop' ? 'bash scripts/run-landing-vision-sidecar.sh' : '');
const landingVision = new LandingVisionManager({
  command: landingVisionCommand,
  enabled: envBoolean('LANDING_VISION_ENABLED', configuredMode === 'bebop'),
  restartMs: envNumber('LANDING_VISION_RESTART_MS', 2_000),
  onUpdate: () => broadcastStatus(),
});

function syntheticRange(now = Date.now()): RangeField | null {
  if (mode === 'bebop') return null;
  return {
    source: 'simulation-clear-space',
    observedAt: now,
    receivedAt: now,
    sectors: {
      frontLeft: { distanceMeters: 20, confidence: 1 },
      front: { distanceMeters: 20, confidence: 1 },
      frontRight: { distanceMeters: 20, confidence: 1 },
      left: { distanceMeters: 20, confidence: 1 },
      right: { distanceMeters: 20, confidence: 1 },
      rear: { distanceMeters: 20, confidence: 1 },
      down: { distanceMeters: Math.max(0.2, drone?.telemetry.altitude ?? 0.2), confidence: 1 },
    },
  };
}

function activeRange(now = Date.now()): RangeField | null {
  return rangeField ?? syntheticRange(now);
}

function targetPad(settings = settingsManager.getStatus().settings): LandingPadDefinition | null {
  if (!settings.landingPadId) return null;
  return navigationManager.getState().landingPads.find((pad) => pad.id === settings.landingPadId) ?? null;
}

function syntheticLandingDetection(pad: LandingPadDefinition | null, now = Date.now()): ObjectDetection[] {
  if (mode === 'bebop' || !pad || !['searching-landing-pad', 'aligning-landing-pad'].includes(stage)) return [];
  return [{
    id: `apriltag-${pad.markerId}`,
    label: 'landing-pad',
    recognizedName: pad.name,
    confidence: 1,
    bbox: { x: 0.44, y: 0.44, width: 0.12, height: 0.12 },
    firstSeenAt: stageStartedAt,
    lastSeenAt: now,
  }];
}

function combinedDetections(now = Date.now()): ObjectDetection[] {
  const byId = new Map<string, ObjectDetection>();
  for (const detection of perceptionSnapshot?.detections ?? []) byId.set(detection.id, detection);
  for (const detection of landingVision.getSnapshot().detections) byId.set(detection.id, detection);
  for (const detection of syntheticLandingDetection(targetPad(), now)) byId.set(detection.id, detection);
  return [...byId.values()];
}

function semanticObservations(now = Date.now()): SemanticObservation[] {
  return resolveSemanticObservations(combinedDetections(now), navigationManager.getState().objects);
}

function navigationReadiness(settings: AutonomySettings, now = Date.now()): AutonomyReadinessCheck[] {
  const checks: AutonomyReadinessCheck[] = [];
  const navigation = navigationManager.getState();
  const pad = targetPad(settings);
  const needsPad = settings.pattern === 'pad-transfer' || settings.requireLandingMarker || Boolean(settings.landingPadId);
  const needsGpsTransfer = settings.pattern === 'pad-transfer';
  const metricRangeRequired = navigation.settings.obstacleAvoidanceEnabled && navigation.settings.requireMetricRange;
  const currentRange = activeRange(now);

  if (settings.takeoffPadId) {
    const takeoffPad = navigation.landingPads.find((item) => item.id === settings.takeoffPadId);
    checks.push({
      key: 'takeoff-pad',
      label: 'Takeoff pad',
      ok: Boolean(takeoffPad),
      detail: takeoffPad ? takeoffPad.name : `Unknown pad: ${settings.takeoffPadId}`,
    });
  }

  if (needsPad) {
    checks.push({
      key: 'landing-pad',
      label: 'Landing pad',
      ok: Boolean(pad),
      detail: pad ? `${pad.name}, AprilTag ${pad.markerId}` : 'Select a saved landing pad',
    });
  }

  if (needsGpsTransfer) {
    checks.push({
      key: 'landing-pad-gps',
      label: 'Landing-pad GPS',
      ok: Boolean(pad?.gps),
      detail: pad?.gps ? `${pad.gps.latitude.toFixed(6)}, ${pad.gps.longitude.toFixed(6)}` : 'Pad-transfer requires GPS coordinates',
    });
    const gpsReady = drone?.telemetry.gpsFix === true
      && typeof drone.telemetry.latitude === 'number'
      && typeof drone.telemetry.longitude === 'number'
      && typeof drone.telemetry.yaw === 'number';
    checks.push({
      key: 'gps-fix',
      label: 'GPS and heading',
      ok: gpsReady,
      detail: gpsReady
        ? `${drone?.telemetry.satellites ?? '?'} satellites, heading available`
        : 'Pad-transfer requires a current GPS fix and yaw telemetry',
    });
  }

  if (metricRangeRequired && (needsGpsTransfer || settings.requireLandingMarker)) {
    const fresh = rangeFieldFresh(currentRange, navigation.settings, now);
    checks.push({
      key: 'metric-range',
      label: 'Metric obstacle range',
      ok: fresh,
      detail: fresh
        ? `${currentRange?.source ?? 'unknown'}, fresh`
        : 'Post fresh multi-sector ToF or LiDAR ranges before autonomous translation',
    });
  }

  if (settings.requireLandingMarker && mode === 'bebop') {
    const vision = landingVision.getHealth();
    checks.push({
      key: 'landing-vision',
      label: 'AprilTag landing vision',
      ok: vision.state === 'running',
      detail: vision.state === 'running' ? 'AprilTag detector is receiving frames' : vision.lastError ?? vision.state,
    });
  }

  return checks;
}

function readiness(now = Date.now()): AutonomyReadinessCheck[] {
  const settings = settingsManager.getStatus().settings;
  return [
    ...evaluateAutonomyReadiness(settings, {
      mode,
      serviceConnected: controlSocket?.readyState === WebSocket.OPEN,
      drone,
      safety,
      videoState: video?.state ?? null,
      perceptionState: perception?.state ?? null,
      trackingState: perception?.trackingState ?? null,
      missionActive: isMissionActive(),
    }, now),
    ...navigationReadiness(settings, now),
  ];
}

function navigationStatus(now = Date.now()): NavigationRuntimeStatus {
  const map = navigationManager.getState();
  const currentRange = activeRange(now);
  return {
    map,
    rangeField: currentRange,
    rangeFresh: rangeFieldFresh(currentRange, map.settings, now),
    semanticObservations: semanticObservations(now),
    targetPad: targetPad(),
    guidanceReason,
    guidanceDistanceMeters,
    landingVision: landingVision.getHealth(),
    perceptionPose: perceptionSnapshot?.pose ?? null,
    scaleSource: perceptionSnapshot?.scaleSource ?? null,
  };
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
    navigation: navigationStatus(now),
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
  navigationHoldSince = null;
  markerLostSince = null;
  guidanceReason = null;
  guidanceDistanceMeters = null;
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

function resetCamera(): void {
  if (pilotOwned) sendControl({ type: 'drone.camera', tilt: 0, pan: 0 });
}

function resetMissionTerminal(next: 'completed' | 'aborted' | 'fault'): void {
  stopMovement();
  resetCamera();
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

function beginPrecisionLanding(): void {
  const settings = settingsManager.getStatus().settings;
  const pad = targetPad(settings);
  if (!settings.requireLandingMarker || !pad) {
    beginLanding(null, 'completed');
    return;
  }
  stopMovement();
  sendControl({
    type: 'drone.camera',
    tilt: navigationManager.getState().settings.landingCameraTiltDegrees,
    pan: 0,
  });
  transition('searching-landing-pad');
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
  const checks = readiness().filter((check) => check.key !== 'mission-idle');
  const failed = checks.filter((check) => !check.ok);
  if (failed.length > 0) throw new Error(failed.map((check) => `${check.label}: ${check.detail}`).join('; '));

  missionId += 1;
  startedAt = Date.now();
  completedAt = null;
  deadlineAt = startedAt + settingsManager.getStatus().settings.maximumFlightSeconds * 1_000;
  lastError = null;
  abortReason = null;
  finalStageAfterLanding = 'completed';
  guidanceReason = null;
  guidanceDistanceMeters = null;
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
  else if (message.type === 'perception.status') {
    perception = message.health as PerceptionHealth;
    if (message.snapshot) perceptionSnapshot = message.snapshot as PerceptionSnapshot;
  } else if (message.type === 'pilot.granted') {
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

  if (stage === 'taking-off' && drone && ['hovering', 'flying'].includes(drone.telemetry.flyingState)) {
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
  pattern: z.enum(['hover', 'yaw-scan', 'pad-transfer']).optional(),
  hoverSeconds: z.number().optional(),
  yawScanSeconds: z.number().optional(),
  takeoffPadId: z.string().optional(),
  landingPadId: z.string().optional(),
  requireLandingMarker: z.boolean().optional(),
  navigationTimeoutSeconds: z.number().optional(),
  landingSearchSeconds: z.number().optional(),
}).strict().refine((value) => Object.keys(value).length > 0, {
  message: 'At least one autonomy setting is required',
});

const navigationSettingsSchema = z.object({
  obstacleAvoidanceEnabled: z.boolean().optional(),
  requireMetricRange: z.boolean().optional(),
  rangeTimeoutMs: z.number().optional(),
  stopDistanceMeters: z.number().optional(),
  cautionDistanceMeters: z.number().optional(),
  avoidanceYawPercent: z.number().optional(),
  cruiseCommandPercent: z.number().optional(),
  landingCommandPercent: z.number().optional(),
  landingDescentPercent: z.number().optional(),
  landingAlignmentTolerance: z.number().optional(),
  finalLandAltitudeMeters: z.number().optional(),
  markerLossTimeoutMs: z.number().optional(),
  landingRollSign: z.union([z.literal(1), z.literal(-1)]).optional(),
  landingPitchSign: z.union([z.literal(1), z.literal(-1)]).optional(),
  landingCameraTiltDegrees: z.number().optional(),
}).strict().refine((value) => Object.keys(value).length > 0, {
  message: 'At least one navigation setting is required',
});

const objectSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  labels: z.array(z.string()).default([]),
  markerIds: z.array(z.number().int().nonnegative()).default([]),
  behavior: z.enum(['obstacle', 'landmark', 'landing-pad', 'ignore']),
  clearanceMeters: z.number().nonnegative(),
  notes: z.string().default(''),
}).strict();

const positionSchema = z.object({ x: z.number(), y: z.number(), z: z.number() }).strict();
const gpsSchema = z.object({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  altitude: z.number().optional(),
}).strict();
const padSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  markerId: z.number().int().nonnegative(),
  markerSizeMeters: z.number().positive(),
  mapPosition: positionSchema.optional(),
  gps: gpsSchema.optional(),
  approachAltitudeMeters: z.number().positive(),
  arrivalRadiusMeters: z.number().positive(),
}).strict();

const sectorReadingSchema = z.union([
  z.number().positive(),
  z.object({ distanceMeters: z.number().positive(), confidence: z.number().min(0).max(1).optional() }).strict(),
]);
const rangeSchema = z.object({
  source: z.string().min(1).max(128),
  observedAt: z.number().int().nonnegative().optional(),
  sectors: z.object({
    frontLeft: sectorReadingSchema.optional(),
    front: sectorReadingSchema.optional(),
    frontRight: sectorReadingSchema.optional(),
    left: sectorReadingSchema.optional(),
    right: sectorReadingSchema.optional(),
    rear: sectorReadingSchema.optional(),
    down: sectorReadingSchema.optional(),
  }).strict(),
}).strict();

const startSchema = z.object({ confirmation: z.string().optional() }).strict();

function normalizeRange(body: z.infer<typeof rangeSchema>): RangeField {
  const sectors: RangeField['sectors'] = {};
  for (const [name, reading] of Object.entries(body.sectors)) {
    if (reading === undefined) continue;
    sectors[name as RangeSectorName] = typeof reading === 'number'
      ? { distanceMeters: reading, confidence: 1 }
      : { distanceMeters: reading.distanceMeters, confidence: reading.confidence ?? 1 };
  }
  if (Object.keys(sectors).length === 0) throw new Error('At least one range sector is required');
  return {
    source: body.source,
    observedAt: body.observedAt ?? Date.now(),
    receivedAt: Date.now(),
    sectors,
  };
}

function rejectChangesWhileFlying(): void {
  if (isMissionActive()) throw new Error('Navigation configuration cannot change during an active mission');
}

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

app.get('/api/navigation', (_req, res) => res.json(navigationStatus()));
app.post('/api/navigation/settings', (req, res) => {
  try {
    rejectChangesWhileFlying();
    navigationManager.updateSettings(navigationSettingsSchema.parse(req.body) as Partial<NavigationSettings>, 'api');
    res.json(status());
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res.status(400).json({ error: message, status: status() });
  }
});
app.post('/api/navigation/objects', (req, res) => {
  try {
    rejectChangesWhileFlying();
    navigationManager.upsertObject(objectSchema.parse(req.body), 'api');
    res.json(status());
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res.status(400).json({ error: message, status: status() });
  }
});
app.delete('/api/navigation/objects/:id', (req, res) => {
  try {
    rejectChangesWhileFlying();
    navigationManager.deleteObject(req.params.id, 'api');
    res.json(status());
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res.status(400).json({ error: message, status: status() });
  }
});
app.post('/api/navigation/pads', (req, res) => {
  try {
    rejectChangesWhileFlying();
    navigationManager.upsertLandingPad(padSchema.parse(req.body), 'api');
    res.json(status());
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res.status(400).json({ error: message, status: status() });
  }
});
app.delete('/api/navigation/pads/:id', (req, res) => {
  try {
    rejectChangesWhileFlying();
    navigationManager.deleteLandingPad(req.params.id, 'api');
    res.json(status());
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res.status(400).json({ error: message, status: status() });
  }
});
app.post('/api/navigation/ranges', (req, res) => {
  try {
    rangeField = normalizeRange(rangeSchema.parse(req.body));
    broadcastStatus();
    res.json({ ok: true, rangeField, rangeFresh: rangeFieldFresh(rangeField, navigationManager.getState().settings) });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res.status(400).json({ error: message });
  }
});

dashboardSockets.on('connection', (socket) => {
  socket.send(JSON.stringify({ type: 'autonomy.status', status: status() }));
});

function applyGuidance(result: GuidanceResult, now: number): void {
  guidanceReason = result.reason;
  guidanceDistanceMeters = result.distanceMeters ?? null;
  const settings = navigationManager.getState().settings;
  const avoided = applyObstacleAvoidance(result.command, activeRange(now), settings, now);
  guidanceReason = avoided.reason ?? guidanceReason;
  guidanceDistanceMeters = avoided.distanceMeters ?? guidanceDistanceMeters;
  if (avoided.blocked && !avoided.command.active) {
    stopMovement();
    navigationHoldSince ??= now;
    if (now - navigationHoldSince >= 2_000) {
      beginLanding(avoided.reason ?? 'Navigation remained blocked', 'aborted');
    }
    return;
  }
  navigationHoldSince = null;
  sendCommand(avoided.command);
}

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
        if (settings.pattern === 'pad-transfer') transition('navigating');
        else transition('executing');
      }
    }
  } else if (stage === 'executing') {
    if (stageElapsedMs >= missionExecutionDurationMs(settings)) {
      beginPrecisionLanding();
    } else {
      sendCommand(missionCommand(settings, stage, drone, stageElapsedMs));
    }
  } else if (stage === 'navigating') {
    const pad = targetPad(settings);
    if (!drone || !pad) {
      beginLanding('Selected landing pad is unavailable', 'fault');
    } else if (stageElapsedMs >= settings.navigationTimeoutSeconds * 1_000) {
      beginLanding('Timed out navigating to landing pad', 'aborted');
    } else {
      const result = gpsGuidance(drone, pad, navigationManager.getState().settings);
      if (result.arrived) beginPrecisionLanding();
      else if (result.blocked) beginLanding(result.reason ?? 'GPS guidance unavailable', 'fault');
      else applyGuidance(result, now);
    }
  } else if (stage === 'searching-landing-pad') {
    const pad = targetPad(settings);
    if (!pad) {
      beginLanding('Landing pad definition disappeared', 'fault');
    } else if (stageElapsedMs >= settings.landingSearchSeconds * 1_000) {
      beginLanding(`AprilTag ${pad.markerId} was not found before the landing-search timeout`, 'aborted');
    } else {
      const detection = landingPadDetection(combinedDetections(now), pad.markerId);
      if (detection) {
        transition('aligning-landing-pad');
      } else {
        guidanceReason = `Searching for AprilTag ${pad.markerId}`;
        sendCommand({ roll: 0, pitch: 0, yaw: 5, gaz: 0, active: true });
      }
    }
  } else if (stage === 'aligning-landing-pad') {
    const pad = targetPad(settings);
    const detection = pad ? landingPadDetection(combinedDetections(now), pad.markerId) : null;
    if (!pad) {
      beginLanding('Landing pad definition disappeared', 'fault');
    } else if (!detection) {
      stopMovement();
      markerLostSince ??= now;
      guidanceReason = `AprilTag ${pad.markerId} temporarily lost`;
      if (now - markerLostSince >= navigationManager.getState().settings.markerLossTimeoutMs) {
        transition('searching-landing-pad');
      }
    } else if (!drone) {
      beginLanding('Drone telemetry unavailable during landing alignment', 'fault');
    } else {
      markerLostSince = null;
      const result = landingGuidance(detection, drone.telemetry.altitude, navigationManager.getState().settings);
      if (result.arrived) beginLanding(null, 'completed');
      else applyGuidance(result, now);
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
  log.info({ autonomyHost, autonomyPort, controlUrl, storagePath, navigationStoragePath }, 'Autonomy service started');
});

connectControl();
landingVision.start();

function shutdown(): void {
  if (shuttingDown) return;
  shuttingDown = true;
  stopMovement();
  if (isAirborne(drone)) sendControl({ type: 'drone.land' });
  resetCamera();
  releasePilot();
  if (reconnectTimer) clearTimeout(reconnectTimer);
  controlSocket?.close();
  void landingVision.stop();
  server.close();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
