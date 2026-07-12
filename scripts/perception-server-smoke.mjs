import { spawn } from 'node:child_process';
import { WebSocket } from 'ws';

const port = 3217;
const baseUrl = `http://127.0.0.1:${port}`;
const diagnostics = [];
const server = spawn(process.execPath, ['dist/src/server.js'], {
  env: {
    ...process.env,
    PORT: String(port),
    DRONE_MODE: 'simulated',
    PERCEPTION_BACKEND: 'simulation',
    PERCEPTION_AUTO_START: 'true',
    LOG_LEVEL: 'warn',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

server.stdout.setEncoding('utf8');
server.stderr.setEncoding('utf8');
server.stdout.on('data', (chunk) => diagnostics.push(chunk));
server.stderr.on('data', (chunk) => diagnostics.push(chunk));

function fail(message) {
  const detail = diagnostics.join('').trim();
  throw new Error(detail ? `${message}\n${detail}` : message);
}

async function waitForHttp(path, predicate, timeoutMs = 6_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}${path}`);
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
      const value = await response.json();
      if (predicate(value)) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  fail(`Timed out waiting for ${path}${lastError ? `: ${lastError}` : ''}`);
}

function openSocket() {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const timer = setTimeout(() => reject(new Error('Timed out opening WebSocket')), 3_000);
    socket.once('open', () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.once('error', reject);
  });
}

function waitForSocketMessage(socket, predicate, timeoutMs = 3_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off('message', onMessage);
      reject(new Error('Timed out waiting for WebSocket perception status'));
    }, timeoutMs);
    const onMessage = (raw) => {
      const value = JSON.parse(raw.toString());
      if (!predicate(value)) return;
      clearTimeout(timer);
      socket.off('message', onMessage);
      resolve(value);
    };
    socket.on('message', onMessage);
  });
}

let socket;
try {
  const health = await waitForHttp('/api/health', (value) => value.ok === true);
  if (health.mode !== 'simulated') fail(`Expected simulated mode, got ${health.mode}`);
  if (health.perceptionBackend !== 'simulation') fail(`Expected simulation backend, got ${health.perceptionBackend}`);

  const status = await waitForHttp('/api/perception/status', (value) => (
    value.health?.state === 'running'
    && value.snapshot?.trackingState === 'tracking'
    && value.snapshot?.detections?.length >= 1
    && value.snapshot?.map?.landmarks?.length >= 50
    && value.snapshot?.trajectory?.length >= 3
  ));

  const dashboard = await fetch(`${baseUrl}/`).then((response) => response.text());
  for (const marker of ['id="slam-map"', 'id="detection-overlay"', 'src="/perception.js"']) {
    if (!dashboard.includes(marker)) fail(`Dashboard is missing ${marker}`);
  }

  socket = await openSocket();
  socket.send(JSON.stringify({ type: 'perception.reset' }));
  const reset = await waitForSocketMessage(socket, (message) => (
    message.type === 'perception.status'
    && message.snapshot?.trackingState === 'initializing'
  ));
  if (reset.snapshot.trajectory.length !== 0) fail('Reset did not clear the trajectory');

  socket.send(JSON.stringify({ type: 'perception.stop' }));
  await waitForSocketMessage(socket, (message) => (
    message.type === 'perception.status' && message.health?.state === 'stopped'
  ));

  socket.send(JSON.stringify({ type: 'perception.start' }));
  const restarted = await waitForSocketMessage(socket, (message) => (
    message.type === 'perception.status'
    && message.health?.state === 'running'
    && message.snapshot?.trackingState === 'tracking'
    && message.snapshot?.detections?.length >= 1
  ), 5_000);

  console.log(JSON.stringify({
    ok: true,
    backend: status.health.backend,
    initialSequence: status.snapshot.sequence,
    restartSequence: restarted.snapshot.sequence,
    detections: restarted.snapshot.detections.length,
    landmarks: restarted.snapshot.map.landmarks.length,
    trajectoryPoints: restarted.snapshot.trajectory.length,
  }, null, 2));
} finally {
  socket?.close();
  server.kill('SIGTERM');
  await new Promise((resolve) => {
    if (server.exitCode !== null) return resolve();
    const timer = setTimeout(() => {
      server.kill('SIGKILL');
      resolve();
    }, 2_000);
    server.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}
