import { describe, expect, it } from 'vitest';
import {
  DEFAULT_NAVIGATION_SETTINGS,
  applyObstacleAvoidance,
  gpsGuidance,
  gpsOffsetMeters,
  landingGuidance,
  markerIdFromDetection,
  resolveSemanticObservations,
  type LandingPadDefinition,
  type RangeField,
} from './navigation.js';
import type { DroneSnapshot } from './types.js';

const now = 10_000;
const forward = { roll: 0, pitch: 10, yaw: 0, gaz: 0, active: true };

function field(distance: number): RangeField {
  return {
    source: 'test',
    observedAt: now,
    receivedAt: now,
    sectors: {
      frontLeft: { distanceMeters: distance, confidence: 1 },
      front: { distanceMeters: distance, confidence: 1 },
      frontRight: { distanceMeters: distance, confidence: 1 },
      left: { distanceMeters: 4, confidence: 1 },
      right: { distanceMeters: 4, confidence: 1 },
    },
  };
}

function drone(overrides: Partial<DroneSnapshot['telemetry']> = {}): DroneSnapshot {
  return {
    connectionState: 'connected',
    pilotConnected: true,
    videoState: 'running',
    telemetry: {
      battery: 80,
      altitude: 1.5,
      speedX: 0,
      speedY: 0,
      speedZ: 0,
      flyingState: 'hovering',
      updatedAt: now,
      latitude: 42,
      longitude: -71,
      gpsFix: true,
      yaw: 0,
      ...overrides,
    },
  };
}

const pad: LandingPadDefinition = {
  id: 'north-pad',
  name: 'North pad',
  markerId: 7,
  markerSizeMeters: 0.3,
  gps: { latitude: 42.0001, longitude: -71 },
  approachAltitudeMeters: 1.5,
  arrivalRadiusMeters: 1,
};

describe('semantic observations', () => {
  it('recognizes AprilTag-backed landing pads and user names', () => {
    const detection = {
      id: 'apriltag-7',
      label: 'landing-pad',
      recognizedName: 'AprilTag 7',
      confidence: 1,
      bbox: { x: 0.4, y: 0.4, width: 0.2, height: 0.2 },
      firstSeenAt: now,
      lastSeenAt: now,
    };
    expect(markerIdFromDetection(detection)).toBe(7);
    const observations = resolveSemanticObservations([detection], [{
      id: 'dock',
      name: 'Charging dock',
      labels: [],
      markerIds: [7],
      behavior: 'landing-pad',
      clearanceMeters: 0.2,
      notes: '',
    }]);
    expect(observations[0]).toMatchObject({ semanticId: 'dock', name: 'Charging dock', markerId: 7 });
  });
});

describe('obstacle avoidance', () => {
  it('stops or turns when a forward obstacle is inside the hard stop distance', () => {
    const result = applyObstacleAvoidance(forward, field(0.7), DEFAULT_NAVIGATION_SETTINGS, now);
    expect(result.blocked).toBe(true);
    expect(result.command.pitch).toBe(0);
  });

  it('slows movement inside the caution distance', () => {
    const result = applyObstacleAvoidance(forward, field(1.6), DEFAULT_NAVIGATION_SETTINGS, now);
    expect(result.blocked).toBe(false);
    expect(result.command.pitch).toBeGreaterThan(0);
    expect(result.command.pitch).toBeLessThan(10);
  });

  it('blocks movement when required range data is stale', () => {
    const stale = field(5);
    stale.receivedAt = 0;
    const result = applyObstacleAvoidance(forward, stale, DEFAULT_NAVIGATION_SETTINGS, now);
    expect(result.blocked).toBe(true);
    expect(result.command.active).toBe(false);
  });
});

describe('GPS guidance', () => {
  it('converts nearby coordinates to a useful local offset', () => {
    const offset = gpsOffsetMeters({ latitude: 42, longitude: -71 }, { latitude: 42.0001, longitude: -71 });
    expect(offset.north).toBeGreaterThan(10);
    expect(offset.distance).toBeLessThan(12);
  });

  it('generates forward guidance when the drone is facing the target', () => {
    const result = gpsGuidance(drone(), pad, DEFAULT_NAVIGATION_SETTINGS);
    expect(result.blocked).toBe(false);
    expect(result.command.pitch).toBeGreaterThan(0);
  });

  it('requires a GPS fix', () => {
    const result = gpsGuidance(drone({ gpsFix: false }), pad, DEFAULT_NAVIGATION_SETTINGS);
    expect(result.blocked).toBe(true);
  });
});

describe('landing guidance', () => {
  it('descends only after the marker is centered', () => {
    const result = landingGuidance({
      id: 'apriltag-7',
      label: 'landing-pad',
      confidence: 1,
      bbox: { x: 0.45, y: 0.45, width: 0.1, height: 0.1 },
      firstSeenAt: now,
      lastSeenAt: now,
    }, 1.2, DEFAULT_NAVIGATION_SETTINGS);
    expect(result.command.gaz).toBeLessThan(0);
  });

  it('requests final landing near the ground', () => {
    const result = landingGuidance({
      id: 'apriltag-7',
      label: 'landing-pad',
      confidence: 1,
      bbox: { x: 0.45, y: 0.45, width: 0.1, height: 0.1 },
      firstSeenAt: now,
      lastSeenAt: now,
    }, 0.4, DEFAULT_NAVIGATION_SETTINGS);
    expect(result.arrived).toBe(true);
  });
});
