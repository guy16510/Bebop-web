import { describe, expect, it, vi } from 'vitest';
import { applyBebopPilotingCommand, type BebopPilotingClient } from '../src/bebop-piloting.js';
import type { PilotingCommand } from '../src/types.js';

function createClient(): BebopPilotingClient {
  return {
    stop: vi.fn(),
    forward: vi.fn(),
    backward: vi.fn(),
    right: vi.fn(),
    left: vi.fn(),
    clockwise: vi.fn(),
    counterClockwise: vi.fn(),
    up: vi.fn(),
    down: vi.fn(),
  };
}

const neutral: PilotingCommand = { roll: 0, pitch: 0, yaw: 0, gaz: 0, active: false };

const cases: Array<[string, PilotingCommand, keyof BebopPilotingClient, number]> = [
  ['forward', { ...neutral, pitch: 30, active: true }, 'forward', 30],
  ['backward', { ...neutral, pitch: -30, active: true }, 'backward', 30],
  ['right', { ...neutral, roll: 30, active: true }, 'right', 30],
  ['left', { ...neutral, roll: -30, active: true }, 'left', 30],
  ['clockwise', { ...neutral, yaw: 30, active: true }, 'clockwise', 30],
  ['counter-clockwise', { ...neutral, yaw: -30, active: true }, 'counterClockwise', 30],
  ['up', { ...neutral, gaz: 30, active: true }, 'up', 30],
  ['down', { ...neutral, gaz: -30, active: true }, 'down', 30],
];

describe('applyBebopPilotingCommand', () => {
  it.each(cases)('maps %s to the expected Bebop client method', (_name, command, method, amount) => {
    const client = createClient();
    applyBebopPilotingCommand(client, command);
    expect(client.stop).toHaveBeenCalledOnce();
    expect(client[method]).toHaveBeenCalledWith(amount);
  });

  it('sends only stop for a neutral command', () => {
    const client = createClient();
    applyBebopPilotingCommand(client, neutral);
    expect(client.stop).toHaveBeenCalledOnce();
    expect(client.forward).not.toHaveBeenCalled();
    expect(client.backward).not.toHaveBeenCalled();
    expect(client.right).not.toHaveBeenCalled();
    expect(client.left).not.toHaveBeenCalled();
    expect(client.clockwise).not.toHaveBeenCalled();
    expect(client.counterClockwise).not.toHaveBeenCalled();
    expect(client.up).not.toHaveBeenCalled();
    expect(client.down).not.toHaveBeenCalled();
  });

  it('supports combined axis commands after clearing the previous command', () => {
    const client = createClient();
    applyBebopPilotingCommand(client, { roll: -12, pitch: 18, yaw: 9, gaz: -7, active: true });
    const stopOrder = vi.mocked(client.stop).mock.invocationCallOrder[0];
    const forwardOrder = vi.mocked(client.forward).mock.invocationCallOrder[0];
    expect(stopOrder).toBeLessThan(forwardOrder);
    expect(client.forward).toHaveBeenCalledWith(18);
    expect(client.left).toHaveBeenCalledWith(12);
    expect(client.clockwise).toHaveBeenCalledWith(9);
    expect(client.down).toHaveBeenCalledWith(7);
  });
});
