import { describe, expect, it } from 'vitest';
import { SafetyController } from '../src/safety.js';
import type { DroneSnapshot } from '../src/types.js';

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
    expect(safety.filterCommand(snapshot(), true, 4_001)).toBe(false);
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
});
