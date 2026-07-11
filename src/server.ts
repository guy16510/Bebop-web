import 'dotenv/config';
import express from 'express';
import { createServer } from 'node:http';
import { EventEmitter } from 'node:events';
import { WebSocketServer, WebSocket } from 'ws';
import { z } from 'zod';
import pino from 'pino';
import {
  clampCommand,
  ConnectionState,
  DroneAdapter,
  DroneSnapshot,
  PilotingCommand,
  ZERO_COMMAND,
} from './types.js';

const log = pino({ level: process.env.LOG_LEVEL ?? 'info' });
const port = Number(process.env.PORT ?? 3000);
const commandTimeoutMs = Number(process.env.COMMAND_TIMEOUT_MS ?? 250);
const commandRateHz = Number(process.env.COMMAND_RATE_HZ ?? 20);
const maxCommand = Number(process.env.MAX_COMMAND_PERCENT ?? 35);

class SimulatedDrone extends EventEmitter implements DroneAdapter {
  private snapshot: DroneSnapshot = {
    connectionState: 'disconnected',
    pilotConnected: false,
    videoState: 'disabled',
    telemetry: {
      battery: 100,
      altitude: 0,
      speedX: 0,
      speedY: 0,
      speedZ: 0,
      flyingState: 'landed',
      updatedAt: Date.now(),
    },
  };
  private timer?: NodeJS.Timeout;
  private command = ZERO_COMMAND;

  async connect() {
    this.patch({ connectionState: 'connecting' });
    await new Promise((resolve) => setTimeout(resolve, 400));
    this.patch({ connectionState: 'connected' });
    this.timer = setInterval(() => this.tick(), 100);
  }

  async disconnect() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.command = ZERO_COMMAND;
    this.patch({ connectionState: 'disconnected' });
  }

  async takeoff() {
    this.requireConnected();
    this.snapshot.telemetry.flyingState = 'takingOff';
    this.emitSnapshot();
    setTimeout(() => {
      this.snapshot.telemetry.flyingState = 'hovering';
      this.snapshot.telemetry.altitude = 1;
      this.emitSnapshot();
    }, 900);
  }

  async land() {
    this.requireConnected();
    this.command = ZERO_COMMAND;
    this.snapshot.telemetry.flyingState = 'landing';
    this.emitSnapshot();
    setTimeout(() => {
      this.snapshot.telemetry.flyingState = 'landed';
      this.snapshot.telemetry.altitude = 0;
      this.emitSnapshot();
    }, 900);
  }

  async emergency() {
    this.command = ZERO_COMMAND;
    this.snapshot.telemetry.flyingState = 'emergency';
    this.emitSnapshot();
  }

  setPilotingCommand(command: PilotingCommand) {
    this.command = command;
  }

  stopMovement() {
    this.command = ZERO_COMMAND;
  }

  getSnapshot() {
    return structuredClone(this.snapshot);
  }

  onChange(listener: (snapshot: DroneSnapshot) => void) {
    this.on('change', listener);
    return () => this.off('change', listener);
  }

  private tick() {
    const t = this.snapshot.telemetry;
    const airborne = !['landed', 'landing', 'emergency'].includes(t.flyingState);
    if (airborne) {
      t.flyingState = this.command.active ? 'flying' : 'hovering';
      t.speedX = this.command.pitch / 25;
      t.speedY = this.command.roll / 25;
      t.speedZ = this.command.gaz / 25;
      t.altitude = Math.max(0.2, Math.min(10, t.altitude + t.speedZ * 0.1));
      t.battery = Math.max(0, t.battery - 0.01);
    } else {
      t.speedX = t.speedY = t.speedZ = 0;
    }
    t.updatedAt = Date.now();
    this.emitSnapshot();
  }

  private requireConnected() {
    if (this.snapshot.connectionState !== 'connected') throw new Error('Drone is not connected');
  }

  private patch(patch: Partial<DroneSnapshot>) {
    this.snapshot = { ...this.snapshot, ...patch };
    this.emitSnapshot();
  }

  private emitSnapshot() {
    this.emit('change', this.getSnapshot());
  }
}

class BebopDrone extends EventEmitter implements DroneAdapter {
  private client: any;
  private snapshot: DroneSnapshot = new SimulatedDrone().getSnapshot();

  async connect() {
    this.patchConnection('connecting');
    const module = await import('node-bebop');
    const bebop = (module as any).default ?? module;
    this.client = bebop.createClient();
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Bebop connection timed out')), 10000);
      this.client.connect(() => {
        clearTimeout(timeout);
        this.bindTelemetry();
        this.patchConnection('connected');
        resolve();
      });
    });
  }

  async disconnect() {
    this.stopMovement();
    this.client?.disconnect?.();
    this.patchConnection('disconnected');
  }

  async takeoff() { this.requireClient(); this.client.takeOff(); }
  async land() { this.requireClient(); this.client.land(); }
  async emergency() { this.requireClient(); this.client.emergency(); }

  setPilotingCommand(command: PilotingCommand) {
    this.requireClient();
    this.client.stop();
    if (!command.active) return;
    if (command.pitch > 0) this.client.forward(command.pitch);
    if (command.pitch < 0) this.client.backward(-command.pitch);
    if (command.roll > 0) this.client.right(command.roll);
    if (command.roll < 0) this.client.left(-command.roll);
    if (command.yaw > 0) this.client.clockwise(command.yaw);
    if (command.yaw < 0) this.client.counterClockwise(-command.yaw);
    if (command.gaz > 0) this.client.up(command.gaz);
    if (command.gaz < 0) this.client.down(-command.gaz);
  }

  stopMovement() { this.client?.stop?.(); }
  getSnapshot() { return structuredClone(this.snapshot); }
  onChange(listener: (snapshot: DroneSnapshot) => void) {
    this.on('change', listener);
    return () => this.off('change', listener);
  }

  private bindTelemetry() {
    const update = () => {
      this.snapshot.telemetry.updatedAt = Date.now();
      this.emit('change', this.getSnapshot());
    };
    this.client.on('battery', (value: number) => { this.snapshot.telemetry.battery = value; update(); });
    this.client.on('altitude', (value: number) => { this.snapshot.telemetry.altitude = value; update(); });
    this.client.on('flyingState', (value: string) => { this.snapshot.telemetry.flyingState = value; update(); });
  }

  private patchConnection(connectionState: ConnectionState) {
    this.snapshot.connectionState = connectionState;
    this.emit('change', this.getSnapshot());
  }
  private requireClient() { if (!this.client) throw new Error('Drone is not connected'); }
}

const adapter: DroneAdapter = process.env.DRONE_MODE === 'bebop' ? new BebopDrone() : new SimulatedDrone();
const app = express();
app.use(express.json());
app.use(express.static('public'));
app.get('/api/health', (_req, res) => res.json({ ok: true, mode: process.env.DRONE_MODE ?? 'simulated' }));
app.get('/api/state', (_req, res) => res.json(adapter.getSnapshot()));

const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });
let pilot: WebSocket | null = null;
let desiredCommand = ZERO_COMMAND;
let lastCommandAt = 0;

const messageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('pilot.acquire') }),
  z.object({ type: z.literal('pilot.release') }),
  z.object({ type: z.literal('pilot.command'), command: z.object({
    roll: z.number(), pitch: z.number(), yaw: z.number(), gaz: z.number(), active: z.boolean(),
  }) }),
  z.object({ type: z.literal('drone.connect') }),
  z.object({ type: z.literal('drone.disconnect') }),
  z.object({ type: z.literal('drone.takeoff') }),
  z.object({ type: z.literal('drone.land') }),
  z.object({ type: z.literal('drone.emergency') }),
]);

function broadcast(payload: unknown) {
  const data = JSON.stringify(payload);
  for (const socket of wss.clients) if (socket.readyState === WebSocket.OPEN) socket.send(data);
}

adapter.onChange((snapshot) => broadcast({ type: 'state', state: snapshot }));

wss.on('connection', (socket) => {
  socket.send(JSON.stringify({ type: 'state', state: adapter.getSnapshot() }));
  socket.on('message', async (raw) => {
    try {
      const message = messageSchema.parse(JSON.parse(raw.toString()));
      switch (message.type) {
        case 'pilot.acquire':
          if (!pilot || pilot.readyState !== WebSocket.OPEN) pilot = socket;
          socket.send(JSON.stringify({ type: pilot === socket ? 'pilot.granted' : 'pilot.denied' }));
          break;
        case 'pilot.release':
          if (pilot === socket) { pilot = null; desiredCommand = ZERO_COMMAND; adapter.stopMovement(); }
          break;
        case 'pilot.command':
          if (pilot !== socket) throw new Error('Pilot control not acquired');
          desiredCommand = clampCommand(message.command, maxCommand);
          lastCommandAt = Date.now();
          break;
        case 'drone.connect': await adapter.connect(); break;
        case 'drone.disconnect': await adapter.disconnect(); break;
        case 'drone.takeoff': await adapter.takeoff(); break;
        case 'drone.land': await adapter.land(); break;
        case 'drone.emergency': await adapter.emergency(); break;
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
      desiredCommand = ZERO_COMMAND;
      adapter.stopMovement();
    }
  });
});

setInterval(() => {
  if (!pilot || Date.now() - lastCommandAt > commandTimeoutMs) {
    desiredCommand = ZERO_COMMAND;
  }
  adapter.setPilotingCommand(desiredCommand);
}, Math.round(1000 / commandRateHz));

server.listen(port, () => log.info({ port, mode: process.env.DRONE_MODE ?? 'simulated' }, 'Bebop web server started'));

process.on('SIGINT', async () => {
  adapter.stopMovement();
  await adapter.disconnect().catch(() => undefined);
  server.close(() => process.exit(0));
});
