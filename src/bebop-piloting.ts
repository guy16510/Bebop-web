import type { PilotingCommand } from './types.js';

interface BebopPcmdState {
  flag: 0 | 1;
  roll: number;
  pitch: number;
  yaw: number;
  gaz: number;
  psi: number;
}

export interface BebopPilotingClient {
  stop(): void;
  forward(amount: number): void;
  backward(amount: number): void;
  right(amount: number): void;
  left(amount: number): void;
  clockwise(amount: number): void;
  counterClockwise(amount: number): void;
  up(amount: number): void;
  down(amount: number): void;
  PilotingSettings?: {
    bankedTurn?(value: 0 | 1): unknown;
  };
  _pcmd?: Partial<BebopPcmdState>;
}

const configuredClients = new WeakSet<object>();

function pcmdValue(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(-100, Math.min(100, Math.trunc(value)));
}

function configureForStationaryYaw(client: BebopPilotingClient): void {
  if (configuredClients.has(client)) return;
  client.PilotingSettings?.bankedTurn?.(0);
  configuredClients.add(client);
}

function pcmdFor(command: PilotingCommand): BebopPcmdState {
  if (!command.active) {
    return { flag: 0, roll: 0, pitch: 0, yaw: 0, gaz: 0, psi: 0 };
  }

  const roll = pcmdValue(command.roll);
  const pitch = pcmdValue(command.pitch);
  return {
    // Parrot's PCMD flag enables roll/pitch only. Yaw and gaz remain valid with flag 0.
    flag: roll !== 0 || pitch !== 0 ? 1 : 0,
    roll,
    pitch,
    yaw: pcmdValue(command.yaw),
    gaz: pcmdValue(command.gaz),
    psi: 0,
  };
}

export function applyBebopPilotingCommand(client: BebopPilotingClient, command: PilotingCommand): void {
  configureForStationaryYaw(client);
  const pcmd = pcmdFor(command);

  // node-bebop sends its mutable _pcmd state at 40 Hz. Replace it atomically so a
  // yaw-only command cannot inherit a progressive roll/pitch flag from its helpers.
  if (client._pcmd !== undefined) {
    client._pcmd = pcmd;
    return;
  }

  // Compatibility fallback for a node-bebop-like client that does not expose _pcmd.
  client.stop();
  if (!command.active) return;
  if (pcmd.pitch > 0) client.forward(pcmd.pitch);
  if (pcmd.pitch < 0) client.backward(-pcmd.pitch);
  if (pcmd.roll > 0) client.right(pcmd.roll);
  if (pcmd.roll < 0) client.left(-pcmd.roll);
  if (pcmd.yaw > 0) client.clockwise(pcmd.yaw);
  if (pcmd.yaw < 0) client.counterClockwise(-pcmd.yaw);
  if (pcmd.gaz > 0) client.up(pcmd.gaz);
  if (pcmd.gaz < 0) client.down(-pcmd.gaz);

  // Some clients create _pcmd lazily inside stop(). Correct the flag after using
  // their public helpers as well.
  const lazyPcmd = Reflect.get(client, '_pcmd') as Partial<BebopPcmdState> | undefined;
  if (lazyPcmd !== undefined) lazyPcmd.flag = pcmd.flag;
}
