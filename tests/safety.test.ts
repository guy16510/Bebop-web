import { describe, expect, it } from 'vitest';
import { SafetyController } from '../src/safety.js';
import type { DroneSnapshot, PilotingCommand } from '../src/types.js';

function snapshot(overrides: Partial<DroneSnapshot> = {}): DroneSnapshot {
  const base: DroneSnapshot = {
    connectionState: 'connected',
    pilotConnected: false,
    videoState: 'disabled',
    telemetry: {
      battery: 100,
      altitude: 0,
      speedX: 0,
      speedY: 0,
      speedZ: 0,
      flyingState: 'landed',
      updatedAt: 1_000,
    },
  };
  return {
    ...base,
    ...overrides,
    telemetry: { ...base.telemetry, ...overrides.telemetry },
  };
}

function command(overrides: Partial<PilotingCommand> = {}): PilotingCommand {
  return {
    roll: 0,
    pitch: 0,
    yaw: 0,
    gaz: 0,
    active: true,
    ...overrides,
  };
}

describe('SafetyController', () => {
  it('requires an explicit arm before takeoff', () => {
    const safety = new SafetyController();
    expect(() => safety.assertTakeoffAllowed(snapshot(), 1_000)).toThrow('Drone is not armed');
    safety.arm(snapshot(), 1_000);
    expect(() => safety.assertTakeoffAllowed(snapshot(), 1_001)).not.toThrow();
  });

  it('expires the arm window', () => {
    const safety = new SafetyController();
    safety.arm(snapshot(), 1_000);
    expect(safety.getStatus(snapshot(), 11_001).armed).toBe(false);
  });

  it('rejects stale telemetry', () => {
    const safety = new SafetyController();
    expect(() => safety.arm(snapshot(), 4_001)).toThrow('stale telemetry');
    expect(safety.filterCommand(snapshot(), command({ pitch: 20 }), 4_001)).toBeNull();
  });

  it('rejects takeoff with a low battery', () => {
    const safety = new SafetyController();
    expect(() => safety.arm(snapshot({ telemetry: { battery: 15 } as any }), 1_000)).toThrow('at least 20%');
  });

  it('requests landing when battery is critical during flight', () => {
    const safety = new SafetyController();
    expect(safety.shouldRequestLanding(snapshot({ telemetry: { battery: 10, flyingState: 'flying' } as any }))).toBe(true);
    expect(safety.shouldRequestLanding(snapshot({ telemetry: { battery: 10, flyingState: 'landed' } as any }))).toBe(false);
  });

  it('rejects configured ceilings above 120 meters', () => {
    expect(() => new SafetyController({
      armWindowMs: 10_000,
      telemetryWarningMs: 1_000,
      telemetryLockoutMs: 3_000,
      minimumTakeoffBatteryPercent: 20,
      criticalBatteryPercent: 10,
      maximumAltitudeMeters: 121,
    })).toThrow('cannot exceed 120 m');
  });

  it('allows only a pure descent after reaching the altitude ceiling', () => {
    const safety = new SafetyController();
    const atCeiling = snapshot({ telemetry: { altitude: 120, flyingState: 'hovering' } as any });

    expect(safety.getStatus(atCeiling, 1_000).altitudeRestricted).toBe(true);
    expect(safety.filterCommand(atCeiling, command({ gaz: -20 }), 1_000)).toEqual(command({ gaz: -20 }));
    expect(safety.filterCommand(atCeiling, command({ gaz: 20 }), 1_000)).toBeNull();
    expect(safety.filterCommand(atCeiling, command({ pitch: 20 }), 1_000)).toBeNull();
    expect(safety.filterCommand(atCeiling, command({ gaz: -20, yaw: 10 }), 1_000)).toBeNull();
  });
});
