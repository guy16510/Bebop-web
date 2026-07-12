import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const port = 34_000 + (process.pid % 500);
const autonomyPort = port + 1;
const directory = mkdtempSync(join(tmpdir(), 'bebop-autonomy-smoke-'));
const settingsPath = join(directory, 'autonomy.json');
const navigationPath = join(directory, 'navigation.json');
const logs = [];
let rangeTimer;

const child = spawn(process.execPath, ['dist/src/autonomy-launcher.js'], {
  env: {
    ...process.env,
    DRONE_MODE: 'simulated',
    PORT: String(port),
    AUTONOMY_PORT: String(autonomyPort),
    AUTONOMY_HOST: '127.0.0.1',
    AUTONOMY_SETTINGS_FILE: settingsPath,
    NAVIGATION_MAP_FILE: navigationPath,
    AUTONOMY_ENABLED: 'true',
    AUTONOMY_ALLOW_PHYSICAL_FLIGHT: 'false',
    AUTONOMY_REQUIRE_VIDEO: 'false',
    AUTONOMY_REQUIRE_PERCEPTION_TRACKING: 'false',
    AUTONOMY_MINIMUM_BATTERY_PERCENT: '20',
    AUTONOMY_RESERVE_BATTERY_PERCENT: '10',
    AUTONOMY_TARGET_ALTITUDE_METERS: '1.2',
    AUTONOMY_MAXIMUM_ALTITUDE_METERS: '3',
    AUTONOMY_MAXIMUM_FLIGHT_SECONDS: '30',
    AUTONOMY_TELEMETRY_TIMEOUT_MS: '1500',
    AUTONOMY_COMMAND_PERCENT: '12',
    AUTONOMY_PATTERN: 'hover',
    AUTONOMY_HOVER_SECONDS: '2',
    LANDING_VISION_ENABLED: 'false',
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

async function post(path, body) {
  return jsonRequest(`http://127.0.0.1:${autonomyPort}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function waitFor(url, predicate, description, timeoutMs = 20_000, onSample) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Launcher exited early with ${child.exitCode}`);
    try {
      last = await jsonRequest(url);
      onSample?.(last);
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

const clearRange = {
  source: 'smoke-clear-space',
  sectors: {
    frontLeft: 20,
    front: 20,
    frontRight: 20,
    left: 20,
    right: 20,
    rear: 20,
    down: 2,
  },
};

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

  await post('/api/autonomy/start', {});
  const hoverCompleted = await waitFor(
    `http://127.0.0.1:${autonomyPort}/api/autonomy`,
    (status) => status.stage === 'completed' && status.telemetry?.flyingState === 'landed',
    'the autonomous takeoff, altitude, hover, and landing mission',
    25_000,
  );
  if (hoverCompleted.missionId !== 1) throw new Error(`Expected mission 1, received ${hoverCompleted.missionId}`);

  const latitude = hoverCompleted.telemetry.latitude;
  const longitude = hoverCompleted.telemetry.longitude;
  if (typeof latitude !== 'number' || typeof longitude !== 'number') throw new Error('Simulation GPS telemetry is missing');

  await post('/api/navigation/objects', {
    id: 'charging-dock',
    name: 'Charging dock',
    labels: [],
    markerIds: [7],
    behavior: 'landing-pad',
    clearanceMeters: 0.3,
    notes: 'Autonomy smoke-test destination',
  });
  await post('/api/navigation/pads', {
    id: 'north-pad',
    name: 'North pad',
    markerId: 7,
    markerSizeMeters: 0.3,
    gps: { latitude: latitude + 0.000018, longitude },
    approachAltitudeMeters: 1.2,
    arrivalRadiusMeters: 0.6,
  });
  await post('/api/navigation/ranges', clearRange);
  rangeTimer = setInterval(() => {
    void post('/api/navigation/ranges', clearRange).catch((error) => logs.push(String(error)));
  }, 250);
  await post('/api/autonomy/settings', {
    pattern: 'pad-transfer',
    landingPadId: 'north-pad',
    requireLandingMarker: true,
    navigationTimeoutSeconds: 20,
    landingSearchSeconds: 8,
    maximumFlightSeconds: 30,
  });

  await waitFor(
    `http://127.0.0.1:${autonomyPort}/api/autonomy`,
    (status) => status.stage === 'completed' && status.readiness.every((check) => check.ok),
    'named-pad mission readiness',
  );

  const stages = new Set();
  let semanticSeen = false;
  await post('/api/autonomy/start', {});
  const transferCompleted = await waitFor(
    `http://127.0.0.1:${autonomyPort}/api/autonomy`,
    (status) => status.stage === 'completed' && status.missionId === 2 && status.telemetry?.flyingState === 'landed',
    'GPS transfer, AprilTag alignment, and precision landing mission',
    35_000,
    (status) => {
      stages.add(status.stage);
      if (status.navigation.semanticObservations.some((item) => item.semanticId === 'charging-dock')) {
        semanticSeen = true;
      }
    },
  );

  for (const expected of ['navigating', 'searching-landing-pad', 'aligning-landing-pad', 'landing']) {
    if (!stages.has(expected)) throw new Error(`Pad-transfer mission never reached ${expected}: ${[...stages].join(', ')}`);
  }
  if (transferCompleted.lastError) throw new Error(`Mission completed with error: ${transferCompleted.lastError}`);
  if (!semanticSeen) throw new Error('AprilTag observation was not resolved through the semantic object registry');

  console.log(JSON.stringify({
    ok: true,
    missions: transferCompleted.missionId,
    finalStage: transferCompleted.stage,
    flyingState: transferCompleted.telemetry.flyingState,
    stages: [...stages],
    semanticSeen,
    targetPad: transferCompleted.navigation.targetPad?.name,
  }));
} catch (error) {
  console.error(logs.join(''));
  throw error;
} finally {
  if (rangeTimer) clearInterval(rangeTimer);
  await stopChild();
  rmSync(directory, { recursive: true, force: true });
}
