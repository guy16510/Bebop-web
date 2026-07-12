import type { PilotingCommand } from './types.js';

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
}

export function applyBebopPilotingCommand(client: BebopPilotingClient, command: PilotingCommand): void {
  client.stop();
  if (!command.active) return;
  if (command.pitch > 0) client.forward(command.pitch);
  if (command.pitch < 0) client.backward(-command.pitch);
  if (command.roll > 0) client.right(command.roll);
  if (command.roll < 0) client.left(-command.roll);
  if (command.yaw > 0) client.clockwise(command.yaw);
  if (command.yaw < 0) client.counterClockwise(-command.yaw);
  if (command.gaz > 0) client.up(command.gaz);
  if (command.gaz < 0) client.down(-command.gaz);
}
