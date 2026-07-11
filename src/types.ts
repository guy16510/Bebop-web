export type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'fault';
export type FlyingState = 'landed' | 'takingOff' | 'hovering' | 'flying' | 'landing' | 'emergency';

export interface PilotingCommand {
  roll: number;
  pitch: number;
  yaw: number;
  gaz: number;
  active: boolean;
}

export interface DroneTelemetry {
  battery: number;
  altitude: number;
  speedX: number;
  speedY: number;
  speedZ: number;
  flyingState: FlyingState;
  updatedAt: number;
}

export interface DroneSnapshot {
  connectionState: ConnectionState;
  telemetry: DroneTelemetry;
  pilotConnected: boolean;
  videoState: 'disabled' | 'starting' | 'running' | 'fault';
}

export interface DroneAdapter {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  takeoff(): Promise<void>;
  land(): Promise<void>;
  emergency(): Promise<void>;
  setPilotingCommand(command: PilotingCommand): void;
  stopMovement(): void;
  getSnapshot(): DroneSnapshot;
  onChange(listener: (snapshot: DroneSnapshot) => void): () => void;
}

export const ZERO_COMMAND: PilotingCommand = {
  roll: 0,
  pitch: 0,
  yaw: 0,
  gaz: 0,
  active: false,
};

export function clampCommand(command: PilotingCommand, max = 35): PilotingCommand {
  const clamp = (value: number) => Math.max(-max, Math.min(max, Math.round(value)));
  return {
    roll: clamp(command.roll),
    pitch: clamp(command.pitch),
    yaw: clamp(command.yaw),
    gaz: clamp(command.gaz),
    active: command.active,
  };
}
