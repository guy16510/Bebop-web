import { createWriteStream, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';

export interface RawVideoSource {
  startRawVideo(): Promise<Readable>;
  stopRawVideo(): Promise<void>;
}

export interface RawVideoHealth {
  state: 'disabled' | 'starting' | 'running' | 'fault';
  bytes: number;
  chunks: number;
  startedAt: number | null;
  lastChunkAt: number | null;
  capturePath: string | null;
  gstreamerEnabled: boolean;
  gstreamerPid: number | null;
  gstreamerRestarts: number;
  lastError: string | null;
}

export class RawVideoManager {
  private stream?: Readable;
  private capture?: ReturnType<typeof createWriteStream>;
  private gst?: ChildProcessWithoutNullStreams;
  private stopping = false;
  private blockedOutputs = 0;
  private health: RawVideoHealth = {
    state: 'disabled',
    bytes: 0,
    chunks: 0,
    startedAt: null,
    lastChunkAt: null,
    capturePath: null,
    gstreamerEnabled: false,
    gstreamerPid: null,
    gstreamerRestarts: 0,
    lastError: null,
  };

  constructor(private readonly source: RawVideoSource) {}

  getHealth(): RawVideoHealth {
    return { ...this.health };
  }

  async start(options: { capturePath?: string; inspectWithGstreamer?: boolean } = {}): Promise<void> {
    if (this.health.state === 'running' || this.health.state === 'starting') return;
    this.stopping = false;
    this.blockedOutputs = 0;
    this.health = {
      ...this.health,
      state: 'starting',
      bytes: 0,
      chunks: 0,
      startedAt: Date.now(),
      lastChunkAt: null,
      lastError: null,
      capturePath: null,
      gstreamerEnabled: Boolean(options.inspectWithGstreamer),
      gstreamerPid: null,
    };

    try {
      if (options.capturePath) {
        const path = resolve(options.capturePath);
        mkdirSync(dirname(path), { recursive: true });
        this.capture = createWriteStream(path, { flags: 'w' });
        this.capture.on('error', this.fail);
        this.health.capturePath = path;
      }

      if (options.inspectWithGstreamer) this.startGstreamer();

      this.stream = await this.source.startRawVideo();
      this.stream.on('data', this.onChunk);
      this.stream.once('error', this.fail);
      this.stream.once('end', this.onEnd);
      this.health.state = 'running';
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.stop().catch(() => undefined);
      this.health.state = 'fault';
      this.health.lastError = message;
      throw error;
    }
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.stream) {
      this.stream.off('data', this.onChunk);
      this.stream.off('error', this.fail);
      this.stream.off('end', this.onEnd);
      this.stream.pause();
      this.stream = undefined;
    }
    await this.source.stopRawVideo();
    this.capture?.end();
    this.capture = undefined;
    if (this.gst && !this.gst.killed) {
      this.gst.stdin.end();
      this.gst.kill('SIGTERM');
    }
    this.gst = undefined;
    this.blockedOutputs = 0;
    this.health.state = 'disabled';
    this.health.gstreamerPid = null;
  }

  private startGstreamer(): void {
    const binary = process.env.GST_LAUNCH_BIN ?? 'gst-launch-1.0';
    const args = [
      '-q',
      'fdsrc', 'fd=0',
      '!', 'queue', 'max-size-buffers=2', 'leaky=downstream',
      '!', 'h264parse',
      '!', 'avdec_h264',
      '!', 'fakesink', 'sync=false',
    ];
    this.gst = spawn(binary, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    this.health.gstreamerPid = this.gst.pid ?? null;
    this.gst.stderr.on('data', (chunk) => {
      const text = String(chunk).trim();
      if (text) this.health.lastError = `GStreamer: ${text.slice(-500)}`;
    });
    this.gst.once('error', this.fail);
    this.gst.once('exit', (code, signal) => {
      this.health.gstreamerPid = null;
      if (!this.stopping && code !== 0) {
        this.health.gstreamerRestarts += 1;
        this.health.state = 'fault';
        this.health.lastError = `GStreamer exited with code ${code ?? 'null'}, signal ${signal ?? 'none'}`;
      }
    });
  }

  private writeWithBackpressure(output: Writable | undefined, buffer: Buffer): void {
    if (!output?.writable) return;
    if (output.write(buffer)) return;
    this.blockedOutputs += 1;
    this.stream?.pause();
    output.once('drain', () => {
      this.blockedOutputs = Math.max(0, this.blockedOutputs - 1);
      if (this.blockedOutputs === 0 && !this.stopping) this.stream?.resume();
    });
  }

  private onChunk = (chunk: Buffer | Uint8Array): void => {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    this.health.bytes += buffer.length;
    this.health.chunks += 1;
    this.health.lastChunkAt = Date.now();
    this.writeWithBackpressure(this.capture, buffer);
    this.writeWithBackpressure(this.gst?.stdin, buffer);
  };

  private fail = (error: unknown): void => {
    this.health.state = 'fault';
    this.health.lastError = error instanceof Error ? error.message : String(error);
  };

  private onEnd = (): void => {
    if (!this.stopping) {
      this.health.state = 'fault';
      this.health.lastError = 'Raw video stream ended unexpectedly';
    }
  };
}

export function defaultCapturePath(): string {
  const configured = process.env.VIDEO_CAPTURE_PATH;
  if (configured) return configured;
  const directory = resolve(process.env.VIDEO_CAPTURE_DIR ?? 'captures');
  if (!existsSync(directory)) mkdirSync(directory, { recursive: true });
  return resolve(directory, `bebop-${new Date().toISOString().replaceAll(':', '-')}.h264`);
}
