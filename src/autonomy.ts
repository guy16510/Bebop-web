import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { SafetyStatus } from './safety.js';
import type { DroneSnapshot, PilotingCommand } from './types.js';
import { ZERO_COMMAND } from './types.js';

export type AutonomyPattern = 'hover' | 'yaw-scan' | 'pad-transfer';
export type AutonomyStage =
  | 'disabled'
  | 'idle'
  | 'preflight'
  | 'acquiring-controls'
  | 'arming'
  | 'taking-off'
  | 'climbing'
  | 'executing'
  | 'navigating'
  | 'searching-landing-pad'
  | 'aligning-landing-pad'
  | 'landing'
  | 'completed'
  | 'aborted'
  | 'fault';

export interface AutonomySettings {
  enabled: boolean;
  allowPhysicalFlight: boolean;
  requireVideo: boolean;
  requirePerceptionTracking: boolean;
  minimumBatteryPercent: number;
  reserveBatteryPercent: number;
  minimumSignalRssi: number;
  targetAltitudeMeters: number;
  maximumAltitudeMeters: number;
  maximumHorizontalDistanceMeters: number;
  maximumFlightSeconds: number;
  telemetryTimeoutMs: number;
  commandPercent: number;
  pattern: AutonomyPattern;
  hoverSeconds: number;
  yawScanSeconds: number;
  takeoffPadId: string;
  landingPadId: string;
  requireLandingMarker: boolean;
  navigationTimeoutSeconds: number;
  landingSearchSeconds: number;
}

export interface AutonomySettingsStatus {
  settings: AutonomySettings;
  revision: number;
  updatedAt: number;
  updatedBy: 'environment' | 'web' | 'api';
}

export interface AutonomyReadinessInput {
  mode: string;
  serviceConnected: boolean;
  drone: DroneSnapshot | null;
  safety: SafetyStatus | null;
  videoState: 'disabled' | 'starting' | 'running' | 'fault' | null;
  perceptionState: 'disabled' | 'stopped' | 'starting' | 'running' | 'fault' | null;
  trackingState: 'disabled' | 'initializing' | 'tracking' | 'lost' | 'fault' | null;
  missionActive: boolean;
}

export interface AutonomyReadinessCheck {
  key: string;
  label: string;
  ok: boolean;
  detail: string;
}

export const DEFAULT_AUTONOMY_SETTINGS: AutonomySettings = {
  enabled: false,
  allowPhysicalFlight: false,
  requireVideo: true,
  requirePerceptionTracking: true,
  minimumBatteryPercent: 45,
  reserveBatteryPercent: 25,
  minimumSignalRssi: -75,
  targetAltitudeMeters: 1.2,
  maximumAltitudeMeters: 3,
  maximumHorizontalDistanceMeters: 30,
  maximumFlightSeconds: 90,
  telemetryTimeoutMs: 1_500,
  commandPercent: 12,
  pattern: 'yaw-scan',
  hoverSeconds: 10,
  yawScanSeconds: 12,
  takeoffPadId: '',
  landingPadId: '',
  requireLandingMarker: false,
  navigationTimeoutSeconds: 90,
  landingSearchSeconds: 20,
};

const AUTONOMY_KEYS = Object.keys(DEFAULT_AUTONOMY_SETTINGS) as Array<keyof AutonomySettings>;

function finiteNumber(value: unknown, fallback: number, minimum: number, maximum: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.max(minimum, Math.min(maximum, value));
}

function cleanPadId(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  return value.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64);
}

export function normalizeAutonomySettings(
  value: unknown,
  defaults: AutonomySettings = DEFAULT_AUTONOMY_SETTINGS,
): AutonomySettings {
  const source = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const pattern: AutonomyPattern = source.pattern === 'hover'
    || source.pattern === 'yaw-scan'
    || source.pattern === 'pad-transfer'
    ? source.pattern
    : defaults.pattern;
  const maximumAltitudeMeters = finiteNumber(source.maximumAltitudeMeters, defaults.maximumAltitudeMeters, 0.5, 10);
  const targetAltitudeMeters = finiteNumber(
    source.targetAltitudeMeters,
    defaults.targetAltitudeMeters,
    0.5,
    maximumAltitudeMeters,
  );
  const minimumBatteryPercent = finiteNumber(source.minimumBatteryPercent, defaults.minimumBatteryPercent, 20, 100);
  const reserveBatteryPercent = finiteNumber(
    source.reserveBatteryPercent,
    defaults.reserveBatteryPercent,
    10,
    Math.max(10, minimumBatteryPercent - 1),
  );

  return {
    enabled: typeof source.enabled === 'boolean' ? source.enabled : defaults.enabled,
    allowPhysicalFlight: typeof source.allowPhysicalFlight === 'boolean'
      ? source.allowPhysicalFlight
      : defaults.allowPhysicalFlight,
    requireVideo: typeof source.requireVideo === 'boolean' ? source.requireVideo : defaults.requireVideo,
    requirePerceptionTracking: typeof source.requirePerceptionTracking === 'boolean'
      ? source.requirePerceptionTracking
      : defaults.requirePerceptionTracking,
    minimumBatteryPercent,
    reserveBatteryPercent,
    minimumSignalRssi: finiteNumber(source.minimumSignalRssi, defaults.minimumSignalRssi, -95, -35),
    targetAltitudeMeters,
    maximumAltitudeMeters,
    maximumHorizontalDistanceMeters: finiteNumber(
      source.maximumHorizontalDistanceMeters,
      defaults.maximumHorizontalDistanceMeters,
      2,
      100,
    ),
    maximumFlightSeconds: finiteNumber(source.maximumFlightSeconds, defaults.maximumFlightSeconds, 20, 300),
    telemetryTimeoutMs: finiteNumber(source.telemetryTimeoutMs, defaults.telemetryTimeoutMs, 500, 5_000),
    commandPercent: finiteNumber(source.commandPercent, defaults.commandPercent, 5, 20),
    pattern,
    hoverSeconds: finiteNumber(source.hoverSeconds, defaults.hoverSeconds, 2, 60),
    yawScanSeconds: finiteNumber(source.yawScanSeconds, defaults.yawScanSeconds, 2, 45),
    takeoffPadId: cleanPadId(source.takeoffPadId, defaults.takeoffPadId),
    landingPadId: cleanPadId(source.landingPadId, defaults.landingPadId),
    requireLandingMarker: typeof source.requireLandingMarker === 'boolean'
      ? source.requireLandingMarker
      : defaults.requireLandingMarker,
    navigationTimeoutSeconds: finiteNumber(
      source.navigationTimeoutSeconds,
      defaults.navigationTimeoutSeconds,
      10,
      600,
    ),
    landingSearchSeconds: finiteNumber(source.landingSearchSeconds, defaults.landingSearchSeconds, 5, 120),
  };
}

export class AutonomySettingsManager {
  private status: AutonomySettingsStatus;

  constructor(
    defaults: AutonomySettings = DEFAULT_AUTONOMY_SETTINGS,
    private readonly storagePath?: string,
    private readonly now: () => number = Date.now,
    private readonly onChange?: (status: AutonomySettingsStatus) => void,
  ) {
    let persisted: unknown = {};
    if (storagePath) {
      try {
        persisted = JSON.parse(readFileSync(storagePath, 'utf8'));
      } catch {
        persisted = {};
      }
    }
    this.status = {
      settings: normalizeAutonomySettings(persisted, defaults),
      revision: 0,
      updatedAt: now(),
      updatedBy: 'environment',
    };
  }

  getStatus(): AutonomySettingsStatus {
    return structuredClone(this.status);
  }

  update(
    patch: Partial<AutonomySettings>,
    updatedBy: AutonomySettingsStatus['updatedBy'] = 'web',
  ): AutonomySettingsStatus {
    const next = normalizeAutonomySettings({ ...this.status.settings, ...patch }, this.status.settings);
    const changed = AUTONOMY_KEYS.some((key) => next[key] !== this.status.settings[key]);
    if (!changed) return this.getStatus();
    this.status = {
      settings: next,
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

export function evaluateAutonomyReadiness(
  settings: AutonomySettings,
  input: AutonomyReadinessInput,
  now = Date.now(),
): AutonomyReadinessCheck[] {
  const drone = input.drone;
  const telemetry = drone?.telemetry;
  const signal = telemetry?.signalRssi;
  const physicalAllowed = input.mode !== 'bebop' || settings.allowPhysicalFlight;
  const landed = telemetry?.flyingState === 'landed';
  const telemetryAge = telemetry ? Math.max(0, now - telemetry.updatedAt) : Number.POSITIVE_INFINITY;

  return [
    {
      key: 'enabled',
      label: 'Autonomy enabled',
      ok: settings.enabled,
      detail: settings.enabled ? 'Enabled' : 'Enable autonomy to permit mission start',
    },
    {
      key: 'physical-gate',
      label: 'Physical-flight gate',
      ok: physicalAllowed,
      detail: input.mode === 'bebop'
        ? settings.allowPhysicalFlight ? 'Physical flight explicitly allowed' : 'Physical flight remains locked'
        : 'Simulation mode',
    },
    {
      key: 'control-link',
      label: 'Control service link',
      ok: input.serviceConnected,
      detail: input.serviceConnected ? 'Connected' : 'Waiting for Bebop Web control server',
    },
    {
      key: 'drone-connected',
      label: 'Drone connected',
      ok: drone?.connectionState === 'connected',
      detail: drone?.connectionState ?? 'No state received',
    },
    {
      key: 'landed',
      label: 'Landed start state',
      ok: landed,
      detail: telemetry?.flyingState ?? 'No flight state',
    },
    {
      key: 'telemetry',
      label: 'Fresh telemetry',
      ok: Boolean(input.safety?.telemetryFresh) && telemetryAge <= settings.telemetryTimeoutMs,
      detail: Number.isFinite(telemetryAge) ? `${telemetryAge} ms old` : 'No telemetry',
    },
    {
      key: 'battery',
      label: 'Takeoff battery',
      ok: typeof telemetry?.battery === 'number' && telemetry.battery >= settings.minimumBatteryPercent,
      detail: typeof telemetry?.battery === 'number'
        ? `${telemetry.battery.toFixed(0)}%, minimum ${settings.minimumBatteryPercent}%`
        : 'No battery telemetry',
    },
    {
      key: 'signal',
      label: 'Wi-Fi signal',
      ok: signal === null || signal === undefined || signal >= settings.minimumSignalRssi,
      detail: signal === null || signal === undefined
        ? 'Signal telemetry unavailable, not blocking'
        : `${signal.toFixed(0)} dBm, minimum ${settings.minimumSignalRssi} dBm`,
    },
    {
      key: 'video',
      label: 'Video stream',
      ok: !settings.requireVideo || input.videoState === 'running',
      detail: settings.requireVideo ? input.videoState ?? 'No video state' : 'Not required',
    },
    {
      key: 'perception',
      label: 'SLAM tracking',
      ok: !settings.requirePerceptionTracking
        || (input.perceptionState === 'running' && input.trackingState === 'tracking'),
      detail: settings.requirePerceptionTracking
        ? `${input.perceptionState ?? 'unknown'} / ${input.trackingState ?? 'unknown'}`
        : 'Not required',
    },
    {
      key: 'mission-idle',
      label: 'Mission controller idle',
      ok: !input.missionActive,
      detail: input.missionActive ? 'A mission is already active' : 'Idle',
    },
  ];
}

export function missionCommand(
  settings: AutonomySettings,
  stage: AutonomyStage,
  snapshot: DroneSnapshot | null,
  stageElapsedMs: number,
): PilotingCommand {
  if (!snapshot) return ZERO_COMMAND;
  const altitude = snapshot.telemetry.altitude;
  const strength = settings.commandPercent;

  if (stage === 'climbing') {
    if (altitude < settings.targetAltitudeMeters - 0.12) {
      return { roll: 0, pitch: 0, yaw: 0, gaz: strength, active: true };
    }
    if (altitude > settings.targetAltitudeMeters + 0.2) {
      return { roll: 0, pitch: 0, yaw: 0, gaz: -strength, active: true };
    }
    return ZERO_COMMAND;
  }

  if (stage === 'executing' && settings.pattern === 'yaw-scan') {
    const hoverMs = settings.hoverSeconds * 1_000;
    const yawEndMs = hoverMs + settings.yawScanSeconds * 1_000;
    if (stageElapsedMs >= hoverMs && stageElapsedMs < yawEndMs) {
      return { roll: 0, pitch: 0, yaw: strength, gaz: 0, active: true };
    }
  }

  return ZERO_COMMAND;
}

export function isAirborne(snapshot: DroneSnapshot | null): boolean {
  return Boolean(snapshot && !['landed', 'landing', 'emergency'].includes(snapshot.telemetry.flyingState));
}
