import 'dotenv/config';
import './server.js';
import { WebSocket } from 'ws';
import {
  MappingAutostartCoordinator,
  type MappingAutostartDesired,
  type MappingAutostartStatus,
} from './mapping-autostart.js';
import type { RuntimeFeatureSettings } from './runtime-features.js';

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

interface FeatureStatusMessage {
  type: 'features.status';
  status: { settings: RuntimeFeatureSettings };
}

interface ErrorMessage {
  type: 'error';
  message: string;
}

type ServerMessage =
  | DroneStateMessage
  | VideoHealthMessage
  | PerceptionStatusMessage
  | FeatureStatusMessage
  | ErrorMessage;
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
const autoMappingDefault = envBoolean(
  'AUTO_START_MAPPING',
  droneMode === 'bebop' && perceptionBackend === 'external',
);
const simulationPerceptionDefault = perceptionBackend === 'simulation'
  && envBoolean('PERCEPTION_AUTO_START', true);

let featureSettings: RuntimeFeatureSettings = {
  autoConnect: envBoolean('FEATURE_AUTO_CONNECT', autoMappingDefault),
  video: envBoolean('FEATURE_VIDEO_ENABLED', autoMappingDefault),
  perception: envBoolean('FEATURE_PERCEPTION_ENABLED', simulationPerceptionDefault || autoMappingDefault),
  showDetections: envBoolean('FEATURE_SHOW_DETECTIONS', true),
  showMap: envBoolean('FEATURE_SHOW_MAP', true),
};

let socket: WebSocket | undefined;
let socketPromise: Promise<WebSocket> | undefined;
let lastSocketError: string | null = null;
let lastCommandError: string | null = null;
let droneConnectionState = 'disconnected';
let coordinator: MappingAutostartCoordinator | undefined;
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

function desiredFrom(settings: RuntimeFeatureSettings): MappingAutostartDesired {
  return {
    autoConnect: settings.autoConnect,
    video: settings.video,
    perception: settings.perception,
  };
}

function connectSocket(): Promise<WebSocket> {
  if (socket?.readyState === WebSocket.OPEN) return Promise.resolve(socket);
  if (socketPromise) return socketPromise;

  socketPromise = new Promise<WebSocket>((resolve, reject) => {
    const candidate = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const timeout = setTimeout(() => {
      candidate.terminate();
      reject(new Error('Timed out connecting automatic startup supervisor to Bebop Web'));
    }, 5_000);

    candidate.once('open', () => {
      clearTimeout(timeout);
      socket = candidate;
      socketPromise = undefined;
      lastSocketError = null;
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
        else if (message.type === 'features.status') {
          featureSettings = message.status.settings;
          coordinator?.setDesired(desiredFrom(featureSettings));
        } else if (message.type === 'error') lastCommandError = message.message;
      } catch {
        // Ignore malformed status messages. The server validates commands independently.
      }
    });
  });

  return socketPromise;
}

async function maintainSupervisorConnection(): Promise<void> {
  try {
    await connectSocket();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message !== lastSocketError) {
      lastSocketError = message;
      console.error(JSON.stringify({ component: 'mapping-autostart', stage: 'waiting-for-server', error: message }));
    }
  }
}

async function sendMessage(message: unknown): Promise<void> {
  const activeSocket = await connectSocket();
  activeSocket.send(JSON.stringify(message));
}

async function sendCommand(type: string): Promise<void> {
  lastCommandError = null;
  await sendMessage({ type });
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

function reportAutomation(status: MappingAutostartStatus): void {
  void sendMessage({ type: 'automation.report', status }).catch(() => undefined);
  if (status.stage === 'fault' || status.stage === 'recovering') {
    console.error(JSON.stringify({ component: 'mapping-autostart', ...status }));
  } else if (
    status.stage === 'mapping'
    || status.stage === 'connecting'
    || status.stage === 'starting-video'
    || status.stage === 'starting-perception'
    || status.stage === 'video-only'
  ) {
    console.log(JSON.stringify({ component: 'mapping-autostart', ...status }));
  }
}

coordinator = new MappingAutostartCoordinator({
  desired: desiredFrom(featureSettings),
  retryMs: Number(process.env.AUTO_START_RETRY_MS ?? 2_000),
  frameTimeoutMs: Number(process.env.AUTO_START_FRAME_TIMEOUT_MS ?? 15_000),
  staleFrameMs: Number(process.env.AUTO_START_STALE_FRAME_MS ?? 5_000),
  trackingTimeoutMs: Number(process.env.AUTO_START_TRACKING_TIMEOUT_MS ?? 30_000),
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
    await sendCommand('video.stop').catch(() => undefined);
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
    await sendCommand('perception.stop').catch(() => undefined);
  },
  onUpdate: reportAutomation,
});

console.log(JSON.stringify({
  component: 'mapping-autostart',
  desired: desiredFrom(featureSettings),
  goal: 'apply dashboard feature settings to connection, video, ORB-SLAM3, and recognition startup',
}));

void maintainSupervisorConnection();
const connectionTimer = setInterval(() => void maintainSupervisorConnection(), 2_000);
connectionTimer.unref();
coordinator.start();
