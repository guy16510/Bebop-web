import type { DroneSnapshot } from './types.js';

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
  warnings: string[];
}

export const DEFAULT_SAFETY_CONFIG: SafetyConfig = {
  armWindowMs: 10_000,
  telemetryWarningMs: 1_000,
  telemetryLockoutMs: 3_000,
  minimumTakeoffBatteryPercent: 20,
  criticalBatteryPercent: 10,
  maximumAltitudeMeters: 10,
};

export class SafetyController {
  private armedUntil: number | null = null;

  constructor(private readonly config: SafetyConfig = DEFAULT_SAFETY_CONFIG) {}

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

  filterCommand(snapshot: DroneSnapshot, commandActive: boolean, now = Date.now()): boolean {
    if (!commandActive) return false;
    return this.getStatus(snapshot, now).controlAllowed;
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
    const belowAltitudeLimit = snapshot.telemetry.altitude <= this.config.maximumAltitudeMeters;
    const armed = this.armedUntil !== null;
    const warnings: string[] = [];

    if (!connected) warnings.push('Drone is disconnected');
    if (telemetryAgeMs > this.config.telemetryWarningMs) warnings.push(`Telemetry is ${telemetryAgeMs} ms old`);
    if (!belowAltitudeLimit) warnings.push(`Altitude limit of ${this.config.maximumAltitudeMeters} m reached`);
    if (snapshot.telemetry.battery <= this.config.criticalBatteryPercent) warnings.push('Battery is critical');
    else if (snapshot.telemetry.battery < this.config.minimumTakeoffBatteryPercent) warnings.push('Battery is too low for takeoff');
    if (!armed) warnings.push('Drone is not armed');
    if (snapshot.telemetry.flyingState !== 'landed') warnings.push('Drone is not landed');

    const controlAllowed = connected && telemetryFresh && belowAltitudeLimit;
    const takeoffAllowed = controlAllowed
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
      warnings,
    };
  }
}
