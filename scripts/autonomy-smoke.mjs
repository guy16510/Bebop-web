import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const port = 34_000 + (process.pid % 500);
const autonomyPort = port + 1;
const directory = mkdtempSync(join(tmpdir(), 'bebop-autonomy-smoke-'));
const settingsPath = join(directory, 'autonomy.json');
const logs = [];

const child = spawn(process.execPath, ['dist/src/autonomy-launcher.js'], {
  env: {
    ...process.env,
    DRONE_MODE: 'simulated',
    PORT: String(port),
    AUTONOMY_PORT: String(autonomyPort),
    AUTONOMY_HOST: '127.0.0.1',
    AUTONOMY_SETTINGS_FILE: settingsPath,
    AUTONOMY_ENABLED: 'true',
    AUTONOMY_ALLOW_PHYSICAL_FLIGHT: 'false',
    AUTONOMY_REQUIRE_VIDEO: 'false',
    AUTONOMY_REQUIRE_PERCEPTION_TRACKING: 'false',
    AUTONOMY_MINIMUM_BATTERY_PERCENT: '20',
    AUTONOMY_RESERVE_BATTERY_PERCENT: '10',
    AUTONOMY_TARGET_ALTITUDE_METERS: '1.2',
    AUTONOMY_MAXIMUM_ALTITUDE_METERS: '3',
    AUTONOMY_MAXIMUM_FLIGHT_SECONDS: '20',
    AUTONOMY_TELEMETRY_TIMEOUT_MS: '1500',
    AUTONOMY_COMMAND_PERCENT: '12',
    AUTONOMY_PATTERN: 'hover',
    AUTONOMY_HOVER_SECONDS: '2',
    FEATURE_AUTO_CONNECT: 'true',
    FEATURE_VIDEO_ENABLED: 'false',
    FEATURE_PERCEPTION_ENABLED: 'false',
    PERCEPTION_BACKEND: 'simulation',
    PERCEPTION_AUTO_START: 'false',
    AUTO_START_POLL_MS: '100',
    AUTO_START_RETRY_MS: '250',
    LOG_LEVEL: 'warn',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

for (const stream of [child.stdout, child.stderr]) {
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => logs.push(chunk));
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function jsonRequest(url, options) {
  const response = await fetch(url, options);
  const body = await response.json();
  if (!response.ok) throw new Error(`${url} returned ${response.status}: ${JSON.stringify(body)}`);
  return body;
}

async function waitFor(url, predicate, description, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Launcher exited early with ${child.exitCode}`);
    try {
      last = await jsonRequest(url);
      if (predicate(last)) return last;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await delay(100);
  }
  throw new Error(`Timed out waiting for ${description}. Last result: ${JSON.stringify(last)}`);
}

async function stopChild() {
  if (child.exitCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    delay(3_000).then(() => child.kill('SIGKILL')),
  ]);
}

try {
  await waitFor(
    `http://127.0.0.1:${port}/api/health`,
    (health) => health.ok === true,
    'the main server',
  );
  await waitFor(
    `http://127.0.0.1:${autonomyPort}/api/health`,
    (health) => health.ok === true,
    'the autonomy service',
  );

  const ready = await waitFor(
    `http://127.0.0.1:${autonomyPort}/api/autonomy`,
    (status) => status.stage === 'idle' && status.readiness.every((check) => check.ok),
    'all autonomous preflight gates',
  );
  if (ready.mode !== 'simulated') throw new Error(`Expected simulated mode, received ${ready.mode}`);

  await jsonRequest(`http://127.0.0.1:${autonomyPort}/api/autonomy/start`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });

  const completed = await waitFor(
    `http://127.0.0.1:${autonomyPort}/api/autonomy`,
    (status) => status.stage === 'completed' && status.telemetry?.flyingState === 'landed',
    'the autonomous takeoff, altitude, hover, and landing mission',
    25_000,
  );

  if (completed.missionId !== 1) throw new Error(`Expected mission 1, received ${completed.missionId}`);
  if (completed.lastError) throw new Error(`Mission completed with error: ${completed.lastError}`);

  console.log(JSON.stringify({
    ok: true,
    missionId: completed.missionId,
    stage: completed.stage,
    flyingState: completed.telemetry.flyingState,
    altitude: completed.telemetry.altitude,
  }));
} catch (error) {
  console.error(logs.join(''));
  throw error;
} finally {
  await stopChild();
  rmSync(directory, { recursive: true, force: true });
}
