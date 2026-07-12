import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AutonomySettingsManager,
  DEFAULT_AUTONOMY_SETTINGS,
  evaluateAutonomyReadiness,
  missionCommand,
  normalizeAutonomySettings,
} from './autonomy.js';
import type { DroneSnapshot } from './types.js';

const snapshot: DroneSnapshot = {
  connectionState: 'connected',
  pilotConnected: false,
  videoState: 'running',
  telemetry: {
    battery: 80,
    signalRssi: -55,
    altitude: 1,
    speedX: 0,
    speedY: 0,
    speedZ: 0,
    flyingState: 'landed',
    updatedAt: 1_000,
  },
};

const safety = {
  armed: false,
  armedUntil: null,
  telemetryAgeMs: 0,
  telemetryFresh: true,
  controlAllowed: true,
  takeoffAllowed: false,
  altitudeMeters: 0,
  maximumAltitudeMeters: 120,
  altitudeRemainingMeters: 120,
  altitudeRestricted: false,
  warnings: [],
};

describe('autonomy settings', () => {
  it('caps physical mission limits to conservative bounds', () => {
    const settings = normalizeAutonomySettings({
      maximumAltitudeMeters: 500,
      targetAltitudeMeters: 200,
      commandPercent: 80,
      maximumFlightSeconds: 10_000,
    });
    expect(settings.maximumAltitudeMeters).toBe(10);
    expect(settings.targetAltitudeMeters).toBe(10);
    expect(settings.commandPercent).toBe(20);
    expect(settings.maximumFlightSeconds).toBe(300);
  });

  it('persists dashboard settings', () => {
    const directory = mkdtempSync(join(tmpdir(), 'bebop-autonomy-'));
    const path = join(directory, 'autonomy.json');
    const manager = new AutonomySettingsManager(DEFAULT_AUTONOMY_SETTINGS, path, () => 123);
    manager.update({ enabled: true, targetAltitudeMeters: 2.5 }, 'web');
    const persisted = JSON.parse(readFileSync(path, 'utf8'));
    expect(persisted.enabled).toBe(true);
    expect(persisted.targetAltitudeMeters).toBe(2.5);
    expect(manager.getStatus().revision).toBe(1);
  });
});

describe('autonomy readiness', () => {
  it('requires explicit physical-flight enablement', () => {
    const checks = evaluateAutonomyReadiness(
      { ...DEFAULT_AUTONOMY_SETTINGS, enabled: true, requireVideo: false },
      {
        mode: 'bebop',
        serviceConnected: true,
        drone: snapshot,
        safety,
        videoState: 'running',
        perceptionState: 'running',
        trackingState: 'tracking',
        missionActive: false,
      },
      1_000,
    );
    expect(checks.find((check) => check.key === 'physical-gate')?.ok).toBe(false);
  });

  it('passes simulation preflight when telemetry and tracking are healthy', () => {
    const checks = evaluateAutonomyReadiness(
      { ...DEFAULT_AUTONOMY_SETTINGS, enabled: true, requireVideo: false },
      {
        mode: 'simulated',
        serviceConnected: true,
        drone: snapshot,
        safety,
        videoState: 'disabled',
        perceptionState: 'running',
        trackingState: 'tracking',
        missionActive: false,
      },
      1_000,
    );
    expect(checks.every((check) => check.ok)).toBe(true);
  });
});

describe('mission commands', () => {
  it('uses altitude feedback during climb', () => {
    expect(missionCommand(DEFAULT_AUTONOMY_SETTINGS, 'climbing', snapshot, 0)).toEqual({
      roll: 0,
      pitch: 0,
      yaw: 0,
      gaz: DEFAULT_AUTONOMY_SETTINGS.commandPercent,
      active: true,
    });
  });

  it('waits through hover time before yawing', () => {
    const airborne = structuredClone(snapshot);
    airborne.telemetry.flyingState = 'hovering';
    airborne.telemetry.altitude = DEFAULT_AUTONOMY_SETTINGS.targetAltitudeMeters;
    expect(missionCommand(DEFAULT_AUTONOMY_SETTINGS, 'executing', airborne, 1_000).active).toBe(false);
    expect(missionCommand(
      DEFAULT_AUTONOMY_SETTINGS,
      'executing',
      airborne,
      DEFAULT_AUTONOMY_SETTINGS.hoverSeconds * 1_000 + 1,
    ).yaw).toBe(DEFAULT_AUTONOMY_SETTINGS.commandPercent);
  });
});
