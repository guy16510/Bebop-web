import 'dotenv/config';
import express from 'express';
import { createServer } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { z } from 'zod';
import pino from 'pino';
import { createDroneAdapter } from './drone-adapters.js';
import { clampCommand, ZERO_COMMAND, type PilotingCommand } from './types.js';
import { MjpegVideoManager } from './video.js';
import { RawVideoManager, defaultCapturePath } from './raw-video.js';
import { DEFAULT_SAFETY_CONFIG, SafetyController } from './safety.js';

const log = pino({ level: process.env.LOG_LEVEL ?? 'info' });
const port = Number(process.env.PORT ?? 3000);
const commandTimeoutMs = Number(process.env.COMMAND_TIMEOUT_MS ?? 250);
const commandRateHz = Number(process.env.COMMAND_RATE_HZ ?? 20);
const maxCommand = Number(process.env.MAX_COMMAND_PERCENT ?? 35);

const safety = new SafetyController({
  armWindowMs: Number(process.env.ARM_WINDOW_MS ?? DEFAULT_SAFETY_CONFIG.armWindowMs),
  telemetryWarningMs: Number(process.env.TELEMETRY_WARNING_MS ?? DEFAULT_SAFETY_CONFIG.telemetryWarningMs),
  telemetryLockoutMs: Number(process.env.TELEMETRY_LOCKOUT_MS ?? DEFAULT_SAFETY_CONFIG.telemetryLockoutMs),
  minimumTakeoffBatteryPercent: Number(
    process.env.MINIMUM_TAKEOFF_BATTERY_PERCENT ?? DEFAULT_SAFETY_CONFIG.minimumTakeoffBatteryPercent,
  ),
  criticalBatteryPercent: Number(
    process.env.CRITICAL_BATTERY_PERCENT ?? DEFAULT_SAFETY_CONFIG.criticalBatteryPercent,
  ),
  maximumAltitudeMeters: Number(
    process.env.MAXIMUM_ALTITUDE_METERS ?? DEFAULT_SAFETY_CONFIG.maximumAltitudeMeters,
  ),
});

const adapter = createDroneAdapter(process.env.DRONE_MODE, log);
const video = new MjpegVideoManager(adapter);
const rawVideo = new RawVideoManager(adapter);
const app = express();

app.use(express.json());
app.use(express.static('public'));
app.get('/api/health', (_req, res) => res.json({ ok: true, mode: process.env.DRONE_MODE ?? 'simulated' }));
app.get('/api/state', (_req, res) => res.json(adapter.getSnapshot()));
app.get('/api/safety', (_req, res) => res.json(safety.getStatus(adapter.getSnapshot())));
app.get('/api/video/health', (_req, res) => res.json(video.getHealth()));
app.get('/api/raw-video/health', (_req, res) => res.json(rawVideo.getHealth()));
app.post('/api/video/start', async (_req, res) => {
  try {
    await video.start();
    res.json(video.getHealth());
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.error({ error: message }, 'Video start failed');
    res.status(500).json({ error: message });
  }
});
app.post('/api/video/stop', async (_req, res) => {
  await video.stop();
  res.json(video.getHealth());
});
app.post('/api/raw-video/start', async (req, res) => {
  try {
    const capture = req.body?.capture !== false;
    const inspectWithGstreamer = req.body?.inspectWithGstreamer === true;
    await rawVideo.start({
      capturePath: capture ? defaultCapturePath() : undefined,
      inspectWithGstreamer,
    });
    res.json(rawVideo.getHealth());
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.error({ error: message }, 'Raw video start failed');
    res.status(500).json({ error: message });
  }
});
app.post('/api/raw-video/stop', async (_req, res) => {
  await rawVideo.stop();
  res.json(rawVideo.getHealth());
});
app.get('/video.mjpeg', (_req, res) => video.attach(res));

const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });
let pilot: WebSocket | null = null;
let desiredCommand = ZERO_COMMAND;
let lastCommandAt = 0;
let criticalLandingRequested = false;
let shuttingDown = false;

const sequenceSchema = z.number().int().nonnegative().optional();
const messageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('diagnostic.ping'), id: z.number().int().nonnegative() }),
  z.object({ type: z.literal('pilot.acquire') }),
  z.object({ type: z.literal('pilot.release') }),
  z.object({ type: z.literal('pilot.stop'), sequence: sequenceSchema }),
  z.object({
    type: z.literal('pilot.command'),
    sequence: sequenceSchema,
    command: z.object({
      roll: z.number(),
      pitch: z.number(),
      yaw: z.number(),
      gaz: z.number(),
      active: z.boolean(),
    }),
  }),
  z.object({ type: z.literal('drone.connect') }),
  z.object({ type: z.literal('drone.disconnect') }),
  z.object({ type: z.literal('drone.arm') }),
  z.object({ type: z.literal('drone.disarm') }),
  z.object({ type: z.literal('drone.takeoff') }),
  z.object({ type: z.literal('drone.land') }),
  z.object({ type: z.literal('drone.emergency') }),
  z.object({ type: z.literal('video.start') }),
  z.object({ type: z.literal('video.stop') }),
  z.object({
    type: z.literal('raw-video.start'),
    capture: z.boolean().optional(),
    inspectWithGstreamer: z.boolean().optional(),
  }),
  z.object({ type: z.literal('raw-video.stop') }),
]);

function broadcast(payload: unknown): void {
  const data = JSON.stringify(payload);
  for (const socket of wss.clients) {
    if (socket.readyState === WebSocket.OPEN) socket.send(data);
  }
}

function broadcastSafety(): void {
  broadcast({ type: 'safety.status', status: safety.getStatus(adapter.getSnapshot()) });
}

function assertPilot(socket: WebSocket): void {
  if (pilot !== socket) throw new Error('Pilot control not acquired');
}

function stopPiloting(): void {
  desiredCommand = ZERO_COMMAND;
  lastCommandAt = 0;
  adapter.stopMovement();
}

function applyDesiredCommandNow(): number {
  if (adapter.getSnapshot().connectionState !== 'connected') throw new Error('Drone is not connected');
  adapter.setPilotingCommand(desiredCommand);
  return Date.now();
}

function sendPilotAck(
  socket: WebSocket,
  sequence: number | undefined,
  kind: 'command' | 'stop',
  command: PilotingCommand,
  accepted: boolean,
  serverReceivedAt: number,
  serverAppliedAt: number,
): void {
  if (sequence === undefined) return;
  socket.send(JSON.stringify({
    type: 'pilot.ack',
    sequence,
    kind,
    command,
    accepted,
    serverReceivedAt,
    serverAppliedAt,
  }));
}

adapter.onChange((snapshot) => {
  broadcast({ type: 'state', state: snapshot });
  broadcastSafety();
});

wss.on('connection', (socket) => {
  socket.send(JSON.stringify({ type: 'state', state: adapter.getSnapshot() }));
  socket.send(JSON.stringify({ type: 'safety.status', status: safety.getStatus(adapter.getSnapshot()) }));
  socket.send(JSON.stringify({ type: 'video.health', health: video.getHealth() }));
  socket.send(JSON.stringify({ type: 'raw-video.health', health: rawVideo.getHealth() }));

  socket.on('message', async (raw) => {
    try {
      const message = messageSchema.parse(JSON.parse(raw.toString()));
      switch (message.type) {
        case 'diagnostic.ping':
          socket.send(JSON.stringify({ type: 'diagnostic.pong', id: message.id }));
          break;
        case 'pilot.acquire':
          if (!pilot || pilot.readyState !== WebSocket.OPEN) {
            stopPiloting();
            pilot = socket;
          }
          socket.send(JSON.stringify({ type: pilot === socket ? 'pilot.granted' : 'pilot.denied' }));
          break;
        case 'pilot.release':
          if (pilot === socket) {
            stopPiloting();
            safety.disarm();
            pilot = null;
            socket.send(JSON.stringify({ type: 'pilot.released' }));
            broadcastSafety();
          }
          break;
        case 'pilot.stop': {
          assertPilot(socket);
          const serverReceivedAt = Date.now();
          stopPiloting();
          sendPilotAck(socket, message.sequence, 'stop', ZERO_COMMAND, true, serverReceivedAt, Date.now());
          socket.send(JSON.stringify({ type: 'pilot.stopped' }));
          break;
        }
        case 'pilot.command': {
          assertPilot(socket);
          const serverReceivedAt = Date.now();
          const candidate = clampCommand(message.command, maxCommand);
          if (!candidate.active) {
            stopPiloting();
            sendPilotAck(socket, message.sequence, 'command', ZERO_COMMAND, true, serverReceivedAt, Date.now());
            break;
          }

          const allowedCommand = safety.filterCommand(adapter.getSnapshot(), candidate);
          if (!allowedCommand) {
            stopPiloting();
            sendPilotAck(socket, message.sequence, 'command', ZERO_COMMAND, false, serverReceivedAt, Date.now());
            break;
          }

          desiredCommand = allowedCommand;
          lastCommandAt = Date.now();
          const serverAppliedAt = applyDesiredCommandNow();
          sendPilotAck(socket, message.sequence, 'command', desiredCommand, true, serverReceivedAt, serverAppliedAt);
          break;
        }
        case 'drone.connect':
          await adapter.connect();
          criticalLandingRequested = false;
          break;
        case 'drone.disconnect':
          safety.disarm();
          stopPiloting();
          await Promise.allSettled([video.stop(), rawVideo.stop()]);
          await adapter.disconnect();
          broadcastSafety();
          break;
        case 'drone.arm':
          assertPilot(socket);
          safety.arm(adapter.getSnapshot());
          broadcastSafety();
          break;
        case 'drone.disarm':
          safety.disarm();
          stopPiloting();
          broadcastSafety();
          break;
        case 'drone.takeoff':
          assertPilot(socket);
          safety.assertTakeoffAllowed(adapter.getSnapshot());
          await adapter.takeoff();
          broadcastSafety();
          break;
        case 'drone.land':
          safety.disarm();
          stopPiloting();
          await adapter.land();
          broadcastSafety();
          break;
        case 'drone.emergency':
          safety.disarm();
          stopPiloting();
          await adapter.emergency();
          broadcastSafety();
          break;
        case 'video.start':
          await video.start();
          break;
        case 'video.stop':
          await video.stop();
          break;
        case 'raw-video.start':
          await rawVideo.start({
            capturePath: message.capture === false ? undefined : defaultCapturePath(),
            inspectWithGstreamer: message.inspectWithGstreamer === true,
          });
          break;
        case 'raw-video.stop':
          await rawVideo.stop();
          break;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      socket.send(JSON.stringify({ type: 'error', message }));
      log.warn({ error: message }, 'WebSocket command rejected');
    }
  });

  socket.on('close', () => {
    if (pilot === socket) {
      pilot = null;
      safety.disarm();
      stopPiloting();
      broadcastSafety();
    }
  });
});

setInterval(() => {
  const snapshot = adapter.getSnapshot();
  const timedOut = !pilot || Date.now() - lastCommandAt > commandTimeoutMs;
  const blocked = desiredCommand.active && !safety.filterCommand(snapshot, desiredCommand);

  if ((timedOut || blocked) && desiredCommand.active) {
    stopPiloting();
    return;
  }

  if (snapshot.connectionState !== 'connected' || !desiredCommand.active) return;

  try {
    adapter.setPilotingCommand(desiredCommand);
  } catch (error) {
    stopPiloting();
    log.error({ error }, 'Failed to refresh piloting command');
  }
}, Math.round(1000 / commandRateHz));

setInterval(async () => {
  const snapshot = adapter.getSnapshot();
  const shouldLand = safety.shouldRequestLanding(snapshot);
  if (shouldLand && !criticalLandingRequested && snapshot.connectionState === 'connected') {
    criticalLandingRequested = true;
    stopPiloting();
    log.warn({ battery: snapshot.telemetry.battery }, 'Critical battery, requesting landing');
    await adapter.land().catch((error) => log.error({ error }, 'Critical-battery landing failed'));
  }
  if (!shouldLand && snapshot.telemetry.flyingState === 'landed') criticalLandingRequested = false;

  broadcast({ type: 'video.health', health: video.getHealth() });
  broadcast({ type: 'raw-video.health', health: rawVideo.getHealth() });
  broadcastSafety();
}, 1000);

server.listen(port, () => {
  log.info({ port, mode: process.env.DRONE_MODE ?? 'simulated' }, 'Bebop web server started');
});

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info({ signal }, 'Shutting down Bebop web server');
  safety.disarm();
  stopPiloting();
  await Promise.allSettled([video.stop(), rawVideo.stop()]);
  await adapter.disconnect().catch(() => undefined);
  server.close(() => process.exit(0));
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
