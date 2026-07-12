import type { DroneSnapshot, PilotingCommand } from './types.js';

export const HARD_MAXIMUM_ALTITUDE_METERS = 120;

export interface SafetyConfig {
  armWindowMs: number;
  telemetryWarningMs: number;
  telemetryLockoutMs: number;
  minimumTakeoffBatteryPercent: number;
  criticalBatteryPercent: number;
  maximumAltitudeMeters: number;
}

export interface SafetyStatus {
  armed: boolean;
  armedUntil: number | null;
  telemetryAgeMs: number;
  telemetryFresh: boolean;
  controlAllowed: boolean;
  takeoffAllowed: boolean;
  altitudeMeters: number;
  maximumAltitudeMeters: number;
  altitudeRemainingMeters: number;
  altitudeRestricted: boolean;
  warnings: string[];
}

export const DEFAULT_SAFETY_CONFIG: SafetyConfig = {
  armWindowMs: 10_000,
  telemetryWarningMs: 1_000,
  telemetryLockoutMs: 3_000,
  minimumTakeoffBatteryPercent: 20,
  criticalBatteryPercent: 10,
  maximumAltitudeMeters: HARD_MAXIMUM_ALTITUDE_METERS,
};

function validateMaximumAltitudeMeters(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error('MAXIMUM_ALTITUDE_METERS must be a positive number');
  }
  if (value > HARD_MAXIMUM_ALTITUDE_METERS) {
    throw new Error(
      `MAXIMUM_ALTITUDE_METERS cannot exceed ${HARD_MAXIMUM_ALTITUDE_METERS} m `
      + '(approximately 394 ft)',
    );
  }
  return value;
}

export class SafetyController {
  private armedUntil: number | null = null;
  private readonly config: SafetyConfig;

  constructor(config: SafetyConfig = DEFAULT_SAFETY_CONFIG) {
    this.config = {
      ...config,
      maximumAltitudeMeters: validateMaximumAltitudeMeters(config.maximumAltitudeMeters),
    };
  }

  arm(snapshot: DroneSnapshot, now = Date.now()): SafetyStatus {
    const status = this.getStatus(snapshot, now);
    if (snapshot.connectionState !== 'connected') throw new Error('Cannot arm while drone is disconnected');
    if (!status.telemetryFresh) throw new Error('Cannot arm with stale telemetry');
    if (snapshot.telemetry.flyingState !== 'landed') throw new Error('Cannot arm unless the drone is landed');
    if (snapshot.telemetry.battery < this.config.minimumTakeoffBatteryPercent) {
      throw new Error(`Battery must be at least ${this.config.minimumTakeoffBatteryPercent}% to arm`);
    }
    this.armedUntil = now + this.config.armWindowMs;
    return this.getStatus(snapshot, now);
  }

  disarm(): void {
    this.armedUntil = null;
  }

  assertTakeoffAllowed(snapshot: DroneSnapshot, now = Date.now()): void {
    const status = this.getStatus(snapshot, now);
    if (!status.takeoffAllowed) {
      throw new Error(status.warnings[0] ?? 'Takeoff is not allowed');
    }
    this.disarm();
  }

  filterCommand(
    snapshot: DroneSnapshot,
    command: PilotingCommand,
    now = Date.now(),
  ): PilotingCommand | null {
    if (!command.active) return null;

    const status = this.getStatus(snapshot, now);
    if (!status.controlAllowed) return null;
    if (!status.altitudeRestricted) return command;

    const isPureDescent = command.gaz < 0
      && command.roll === 0
      && command.pitch === 0
      && command.yaw === 0;
    return isPureDescent ? command : null;
  }

  shouldRequestLanding(snapshot: DroneSnapshot): boolean {
    const flying = !['landed', 'landing', 'emergency'].includes(snapshot.telemetry.flyingState);
    return flying && snapshot.telemetry.battery <= this.config.criticalBatteryPercent;
  }

  getStatus(snapshot: DroneSnapshot, now = Date.now()): SafetyStatus {
    if (this.armedUntil !== null && now >= this.armedUntil) this.armedUntil = null;

    const telemetryAgeMs = Math.max(0, now - snapshot.telemetry.updatedAt);
    const telemetryFresh = telemetryAgeMs <= this.config.telemetryLockoutMs;
    const connected = snapshot.connectionState === 'connected';
    const altitudeMeters = Math.max(0, snapshot.telemetry.altitude);
    const altitudeRemainingMeters = Math.max(0, this.config.maximumAltitudeMeters - altitudeMeters);
    const altitudeRestricted = altitudeMeters >= this.config.maximumAltitudeMeters;
    const armed = this.armedUntil !== null;
    const warnings: string[] = [];

    if (!connected) warnings.push('Drone is disconnected');
    if (telemetryAgeMs > this.config.telemetryWarningMs) warnings.push(`Telemetry is ${telemetryAgeMs} ms old`);
    if (altitudeRestricted) {
      warnings.push(
        `Altitude ceiling of ${this.config.maximumAltitudeMeters} m reached, only descent is allowed`,
      );
    }
    if (snapshot.telemetry.battery <= this.config.criticalBatteryPercent) warnings.push('Battery is critical');
    else if (snapshot.telemetry.battery < this.config.minimumTakeoffBatteryPercent) warnings.push('Battery is too low for takeoff');
    if (!armed) warnings.push('Drone is not armed');
    if (snapshot.telemetry.flyingState !== 'landed') warnings.push('Drone is not landed');

    const controlAllowed = connected && telemetryFresh;
    const takeoffAllowed = controlAllowed
      && !altitudeRestricted
      && armed
      && snapshot.telemetry.flyingState === 'landed'
      && snapshot.telemetry.battery >= this.config.minimumTakeoffBatteryPercent;

    return {
      armed,
      armedUntil: this.armedUntil,
      telemetryAgeMs,
      telemetryFresh,
      controlAllowed,
      takeoffAllowed,
      altitudeMeters,
      maximumAltitudeMeters: this.config.maximumAltitudeMeters,
      altitudeRemainingMeters,
      altitudeRestricted,
      warnings,
    };
  }
}
