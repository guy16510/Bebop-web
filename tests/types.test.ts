import { describe, expect, it } from 'vitest';
import { clampCommand, ZERO_COMMAND } from '../src/types.js';

describe('clampCommand', () => {
  it('clamps and rounds every flight axis', () => {
    expect(clampCommand({ roll: 99.7, pitch: -80.2, yaw: 12.6, gaz: -12.6, active: true }, 35)).toEqual({
      roll: 35,
      pitch: -35,
      yaw: 13,
      gaz: -13,
      active: true,
    });
  });

  it('does not mutate the shared zero command', () => {
    const result = clampCommand(ZERO_COMMAND);
    expect(result).toEqual(ZERO_COMMAND);
    expect(result).not.toBe(ZERO_COMMAND);
  });
});
