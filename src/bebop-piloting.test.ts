import { describe, expect, it, vi } from 'vitest';
import { applyBebopPilotingCommand, type BebopPilotingClient } from './bebop-piloting.js';

function clientWithPcmd(): BebopPilotingClient {
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
    PilotingSettings: { bankedTurn: vi.fn() },
    _pcmd: {},
  };
}

describe('Bebop piloting command translation', () => {
  it('sends yaw-only movement with the progressive roll/pitch flag disabled', () => {
    const client = clientWithPcmd();

    applyBebopPilotingCommand(client, {
      roll: 0,
      pitch: 0,
      yaw: 12,
      gaz: 0,
      active: true,
    });

    expect(client.PilotingSettings?.bankedTurn).toHaveBeenCalledWith(0);
    expect(client._pcmd).toEqual({
      flag: 0,
      roll: 0,
      pitch: 0,
      yaw: 12,
      gaz: 0,
      psi: 0,
    });
    expect(client.clockwise).not.toHaveBeenCalled();
  });

  it('enables the progressive flag only when roll or pitch is commanded', () => {
    const client = clientWithPcmd();

    applyBebopPilotingCommand(client, {
      roll: -7,
      pitch: 10,
      yaw: 4,
      gaz: 2,
      active: true,
    });

    expect(client._pcmd).toEqual({
      flag: 1,
      roll: -7,
      pitch: 10,
      yaw: 4,
      gaz: 2,
      psi: 0,
    });
  });

  it('keeps vertical-only movement non-progressive and configures banked turns once', () => {
    const client = clientWithPcmd();

    applyBebopPilotingCommand(client, {
      roll: 0,
      pitch: 0,
      yaw: 0,
      gaz: 9,
      active: true,
    });
    applyBebopPilotingCommand(client, {
      roll: 0,
      pitch: 0,
      yaw: -5,
      gaz: 0,
      active: true,
    });

    expect(client._pcmd).toEqual({
      flag: 0,
      roll: 0,
      pitch: 0,
      yaw: -5,
      gaz: 0,
      psi: 0,
    });
    expect(client.PilotingSettings?.bankedTurn).toHaveBeenCalledTimes(1);
  });
});
