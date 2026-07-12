import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { BebopDrone } from './drone-adapters.js';

const logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

function telemetryHarness(): { drone: BebopDrone; client: EventEmitter } {
  const drone = new BebopDrone(logger);
  const client = new EventEmitter();
  (drone as any).client = client;
  (drone as any).bindTelemetry();
  return { drone, client };
}

describe('Bebop telemetry bindings', () => {
  it('reads the raw node-bebop AltitudeChanged payload', () => {
    const { drone, client } = telemetryHarness();
    client.emit('AltitudeChanged', { altitude: 1.75 });
    expect(drone.getSnapshot().telemetry.altitude).toBe(1.75);
  });

  it('keeps numeric lowercase altitude compatibility', () => {
    const { drone, client } = telemetryHarness();
    client.emit('altitude', 2.25);
    expect(drone.getSnapshot().telemetry.altitude).toBe(2.25);
  });
});
