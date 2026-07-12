import 'dotenv/config';
import './server.js';
import { WebSocket } from 'ws';
import { MappingAutostartCoordinator } from './mapping-autostart.js';

interface DroneStateMessage {
  type: 'state';
  state: { connectionState: string };
}

interface VideoHealthMessage {
  type: 'video.health';
  health: {
    state: 'disabled' | 'starting' | 'running' | 'fault';
    frames: number;
    lastFrameAt: number | null;
    lastError: string | null;
  };
}

interface PerceptionStatusMessage {
  type: 'perception.status';
  health: {
    state: 'disabled' | 'stopped' | 'starting' | 'running' | 'fault';
    trackingState: 'disabled' | 'initializing' | 'tracking' | 'lost' | 'fault';
    lastError: string | null;
  };
}

interface ErrorMessage {
  type: 'error';
  message: string;
}

type ServerMessage = DroneStateMessage | VideoHealthMessage | PerceptionStatusMessage | ErrorMessage;
type VideoHealth = VideoHealthMessage['health'];
type PerceptionHealth = PerceptionStatusMessage['health'];

function envBoolean(name: string, fallback: boolean): boolean {
  const value = process.env[name];
  if (value === undefined) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

const port = Number(process.env.PORT ?? 3000);
const droneMode = process.env.DRONE_MODE ?? 'simulated';
const perceptionBackend = process.env.PERCEPTION_BACKEND ?? (droneMode === 'bebop' ? 'disabled' : 'simulation');
const autoMappingEnabled = envBoolean(
  'AUTO_START_MAPPING',
  droneMode === 'bebop' && perceptionBackend === 'external',
);

let socket: WebSocket | undefined;
let socketPromise: Promise<WebSocket> | undefined;
let lastCommandError: string | null = null;
let droneConnectionState = 'disconnected';
let videoHealth: VideoHealth = {
  state: 'disabled',
  frames: 0,
  lastFrameAt: null,
  lastError: null,
};
let perceptionHealth: PerceptionHealth = {
  state: 'stopped',
  trackingState: 'disabled',
  lastError: null,
};

function connectSocket(): Promise<WebSocket> {
  if (socket?.readyState === WebSocket.OPEN) return Promise.resolve(socket);
  if (socketPromise) return socketPromise;

  socketPromise = new Promise<WebSocket>((resolve, reject) => {
    const candidate = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const timeout = setTimeout(() => {
      candidate.terminate();
      reject(new Error('Timed out connecting automatic mapping supervisor to Bebop Web'));
    }, 5_000);

    candidate.once('open', () => {
      clearTimeout(timeout);
      socket = candidate;
      socketPromise = undefined;
      resolve(candidate);
    });
    candidate.once('error', (error) => {
      clearTimeout(timeout);
      socketPromise = undefined;
      reject(error);
    });
    candidate.on('close', () => {
      if (socket === candidate) socket = undefined;
    });
    candidate.on('message', (raw) => {
      try {
        const message = JSON.parse(raw.toString()) as ServerMessage;
        if (message.type === 'state') droneConnectionState = message.state.connectionState;
        else if (message.type === 'video.health') videoHealth = message.health;
        else if (message.type === 'perception.status') perceptionHealth = message.health;
        else if (message.type === 'error') lastCommandError = message.message;
      } catch {
        // Ignore malformed status messages. The server validates commands independently.
      }
    });
  });

  return socketPromise;
}

async function sendCommand(type: string): Promise<void> {
  lastCommandError = null;
  const activeSocket = await connectSocket();
  activeSocket.send(JSON.stringify({ type }));
}

async function waitFor(predicate: () => boolean, timeoutMs: number, description: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (lastCommandError) throw new Error(lastCommandError);
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${description}`);
}

const coordinator = new MappingAutostartCoordinator({
  enabled: autoMappingEnabled,
  retryMs: Number(process.env.AUTO_START_RETRY_MS ?? 2_000),
  frameTimeoutMs: Number(process.env.AUTO_START_FRAME_TIMEOUT_MS ?? 15_000),
  staleFrameMs: Number(process.env.AUTO_START_STALE_FRAME_MS ?? 5_000),
  intervalMs: Number(process.env.AUTO_START_POLL_MS ?? 500),
  getConnectionState: () => droneConnectionState,
  connect: async () => {
    await sendCommand('drone.connect');
    await waitFor(() => droneConnectionState === 'connected', 15_000, 'drone connection');
  },
  getVideoHealth: () => videoHealth,
  startVideo: async () => {
    await sendCommand('video.start');
    await waitFor(
      () => videoHealth.state === 'running' && videoHealth.lastFrameAt !== null,
      Number(process.env.AUTO_START_FRAME_TIMEOUT_MS ?? 15_000),
      'the first decoded video frame',
    );
  },
  stopVideo: async () => {
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'video.stop' }));
  },
  getPerceptionHealth: () => perceptionHealth,
  startPerception: async () => {
    await sendCommand('perception.start');
    await waitFor(
      () => perceptionHealth.state === 'running' && perceptionHealth.trackingState !== 'fault',
      10_000,
      'the perception process to start',
    );
  },
  stopPerception: async () => {
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'perception.stop' }));
  },
  onUpdate: (status) => {
    if (status.stage === 'fault' || status.stage === 'recovering') {
      console.error(JSON.stringify({ component: 'mapping-autostart', ...status }));
    } else if (
      status.stage === 'mapping'
      || status.stage === 'connecting'
      || status.stage === 'starting-video'
      || status.stage === 'starting-perception'
    ) {
      console.log(JSON.stringify({ component: 'mapping-autostart', ...status }));
    }
  },
});

if (autoMappingEnabled) {
  console.log(JSON.stringify({
    component: 'mapping-autostart',
    enabled: true,
    goal: 'connect drone, start decoded video, then start ORB-SLAM3 automatically',
  }));
  coordinator.start();
}
