import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { config as loadDotEnv } from 'dotenv';

const root = resolve(process.cwd());
const envPath = join(root, '.env');
const bebopProfile = join(root, '.env.bebop.example');

if (!existsSync(envPath)) {
  if (!existsSync(bebopProfile)) throw new Error('Missing .env and .env.bebop.example');
  copyFileSync(bebopProfile, envPath);
  console.log('[dev] Created .env from .env.bebop.example');
}

loadDotEnv({ path: envPath });

function envBoolean(name, fallback = false) {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw.toLowerCase());
}

function commandWorks(command, args) {
  const result = spawnSync(command, args, { stdio: 'ignore' });
  return !result.error && result.status === 0;
}

function collectFiles(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...collectFiles(path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

function perceptionSourceHash() {
  const hash = createHash('sha256');
  const roots = [
    join(root, 'perception-sidecar'),
    join(root, 'config', 'perception'),
  ];
  const files = roots.flatMap((directory) => collectFiles(directory)).sort();
  for (const file of files) {
    hash.update(relative(root, file));
    hash.update('\0');
    hash.update(readFileSync(file));
    hash.update('\0');
  }
  return hash.digest('hex');
}

function runOrThrow(command, args, label) {
  console.log(`[dev] ${label}`);
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', env: process.env });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${label} failed with exit code ${result.status}`);
}

const droneMode = process.env.DRONE_MODE ?? 'simulated';
const perceptionBackend = process.env.PERCEPTION_BACKEND ?? (droneMode === 'bebop' ? 'disabled' : 'simulation');
const externalPerception = perceptionBackend === 'external';
const image = process.env.PERCEPTION_IMAGE ?? 'bebop-perception-sidecar:local';
const dryRun = envBoolean('DEV_BOOTSTRAP_DRY_RUN');

if (droneMode === 'bebop' && !commandWorks('ffmpeg', ['-version'])) {
  throw new Error('FFmpeg is required for Bebop video. Install it before running npm run dev.');
}

let imageAction = 'not-required';
if (externalPerception) {
  if (!commandWorks('docker', ['info'])) {
    throw new Error('Docker Desktop must be running for ORB-SLAM3 and YOLOX.');
  }

  const sourceHash = perceptionSourceHash();
  const inspect = spawnSync(
    'docker',
    ['image', 'inspect', image, '--format', '{{ index .Config.Labels "com.bebop-web.source-hash" }}'],
    { encoding: 'utf8' },
  );
  const currentHash = inspect.status === 0 ? inspect.stdout.trim() : '';
  const rebuild = envBoolean('DEV_REBUILD_PERCEPTION') || currentHash !== sourceHash;

  if (rebuild) {
    imageAction = 'build';
    if (!dryRun) {
      runOrThrow(
        'docker',
        [
          'build',
          '--label',
          `com.bebop-web.source-hash=${sourceHash}`,
          '--file',
          join(root, 'perception-sidecar', 'Dockerfile'),
          '--tag',
          image,
          root,
        ],
        `Building ${image} because the native perception sources changed`,
      );
    }
  } else {
    imageAction = 'reuse';
    console.log(`[dev] Reusing current perception image ${image}`);
  }
}

const summary = {
  root: basename(root),
  droneMode,
  perceptionBackend,
  image,
  imageAction,
  url: `http://localhost:${process.env.PORT ?? 3000}`,
};
console.log(`[dev] ${JSON.stringify(summary)}`);

if (dryRun) process.exit(0);

const executable = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const child = spawn(executable, ['tsx', 'watch', 'src/launcher.ts'], {
  cwd: root,
  env: process.env,
  stdio: 'inherit',
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    if (!child.killed) child.kill(signal);
  });
}

child.once('error', (error) => {
  console.error(`[dev] Launcher failed: ${error.message}`);
  process.exitCode = 1;
});

child.once('exit', (code, signal) => {
  if (signal) console.log(`[dev] Launcher exited from ${signal}`);
  process.exitCode = code ?? 0;
});
