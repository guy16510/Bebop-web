import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { Socket } from 'node:net';
import { PassThrough, Transform, type Readable, type TransformCallback } from 'node:stream';

export interface ArStream2DiscoveryResponse {
  status: number;
  c2d_port: number;
  arstream2_server_stream_port?: number;
  arstream2_server_control_port?: number;
  [key: string]: unknown;
}

export interface ArStream2DiscoveryOptions {
  streamPort: number;
  controlPort: number;
  timeoutMs?: number;
  controllerName?: string;
  onResponse?: (response: ArStream2DiscoveryResponse) => void;
}

export interface BebopArStream2VideoOptions {
  droneIp: string;
  streamPort: number;
  controlPort: number;
  ffmpegBin?: string;
  startTimeoutMs?: number;
  mjpegWidth?: number;
  mjpegHeight?: number;
  mjpegQuality?: number;
  enableVideo: () => void;
  disableVideo: () => void;
}

interface MjpegSession {
  decoder: ChildProcessWithoutNullStreams;
  raw: Readable;
  output: JpegFrameSplitter;
  stopping: boolean;
}

const DEFAULT_START_TIMEOUT_MS = 8000;
const MAX_SUBSCRIBER_BUFFER_BYTES = 4 * 1024 * 1024;
const H264_ANALYZE_DURATION_US = '5000000';
const H264_PROBE_SIZE_BYTES = '5000000';

export function createArStream2DiscoveryRequest(options: ArStream2DiscoveryOptions): string {
  return JSON.stringify({
    controller_type: 'computer',
    controller_name: options.controllerName ?? 'bebop-web',
    d2c_port: '43210',
    arstream2_client_stream_port: options.streamPort,
    arstream2_client_control_port: options.controlPort,
  });
}

export function installArStream2Discovery(client: any, options: ArStream2DiscoveryOptions): void {
  client.discover = (callback: (data: Buffer) => void) => {
    const socket = new Socket();
    const chunks: Buffer[] = [];
    let finished = false;

    const fail = (error: Error) => {
      if (finished) return;
      finished = true;
      client._arstream2DiscoveryError = error;
      socket.destroy();
    };

    const finish = () => {
      if (finished) return;
      const data = Buffer.concat(chunks);
      const text = data.toString('utf8').replace(/\0+$/u, '').trim();
      if (!text) return;

      let response: ArStream2DiscoveryResponse;
      try {
        response = JSON.parse(text) as ArStream2DiscoveryResponse;
      } catch {
        return;
      }

      if (response.status !== 0) {
        fail(new Error(`Bebop discovery rejected the controller with status ${response.status}`));
        return;
      }
      if (!Number.isInteger(response.c2d_port)) {
        fail(new Error('Bebop discovery response did not include c2d_port'));
        return;
      }

      finished = true;
      client.c2dPort = response.c2d_port;
      client._arstream2DiscoveryResponse = response;
      options.onResponse?.(response);
      socket.destroy();
      callback(data);
    };

    socket.setTimeout(options.timeoutMs ?? 5000, () => fail(new Error('Bebop discovery timed out')));
    socket.on('error', (error) => fail(error));
    socket.on('data', (chunk) => {
      chunks.push(Buffer.from(chunk));
      finish();
    });
    socket.on('end', finish);
    socket.connect(client.discoveryPort, client.ip, () => {
      socket.write(createArStream2DiscoveryRequest(options));
    });
  };
}

export function createArStream2Sdp(droneIp: string, streamPort: number): string {
  return [
    'v=0',
    'o=- 0 0 IN IP4 127.0.0.1',
    's=Parrot Bebop 2',
    `c=IN IP4 ${droneIp}`,
    't=0 0',
    `m=video ${streamPort} RTP/AVP 96`,
    'a=rtpmap:96 H264/90000',
    'a=recvonly',
    '',
  ].join('\r\n');
}

export class JpegFrameSplitter extends Transform {
  private pending = Buffer.alloc(0);

  _transform(chunk: Buffer | Uint8Array, _encoding: BufferEncoding, callback: TransformCallback): void {
    const input = Buffer.from(chunk);
    this.pending = this.pending.length === 0 ? input : Buffer.concat([this.pending, input]);

    try {
      this.extractFrames();
      callback();
    } catch (error) {
      callback(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private extractFrames(): void {
    while (this.pending.length > 0) {
      const start = this.pending.indexOf(Buffer.from([0xff, 0xd8]));
      if (start < 0) {
        this.pending = this.pending.subarray(Math.max(0, this.pending.length - 1));
        return;
      }

      const end = this.pending.indexOf(Buffer.from([0xff, 0xd9]), start + 2);
      if (end < 0) {
        if (start > 0) this.pending = this.pending.subarray(start);
        if (this.pending.length > 8 * 1024 * 1024) throw new Error('MJPEG decoder exceeded the frame buffer limit');
        return;
      }

      this.push(this.pending.subarray(start, end + 2));
      this.pending = this.pending.subarray(end + 2);
    }
  }
}

export class BebopArStream2Video {
  private readonly ffmpegBin: string;
  private readonly startTimeoutMs: number;
  private readonly rawSubscribers = new Set<PassThrough>();
  private readonly mjpegSessions = new Map<Readable, MjpegSession>();
  private rawProcess?: ChildProcessWithoutNullStreams;
  private rawStartPromise?: Promise<void>;
  private rawStarted = false;
  private rawStderr = '';

  constructor(private readonly options: BebopArStream2VideoOptions) {
    this.ffmpegBin = options.ffmpegBin ?? 'ffmpeg';
    this.startTimeoutMs = options.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS;
  }

  async acquireRaw(): Promise<Readable> {
    const output = new PassThrough({ highWaterMark: 1024 * 1024 });
    this.rawSubscribers.add(output);
    output.once('close', () => {
      this.rawSubscribers.delete(output);
      void this.stopRawWhenIdle();
    });

    try {
      await this.ensureRawStarted();
      return output;
    } catch (error) {
      this.rawSubscribers.delete(output);
      output.destroy();
      await this.stopRawWhenIdle();
      throw error;
    }
  }

  async releaseRaw(stream: Readable | undefined): Promise<void> {
    if (!stream) return;
    const output = stream as PassThrough;
    this.rawSubscribers.delete(output);
    output.destroy();
    await this.stopRawWhenIdle();
  }

  async acquireMjpeg(): Promise<Readable> {
    const raw = await this.acquireRaw();
    const decoder = spawn(this.ffmpegBin, this.mjpegArgs(), { stdio: ['pipe', 'pipe', 'pipe'] });
    const output = new JpegFrameSplitter();
    const session: MjpegSession = { decoder, raw, output, stopping: false };
    let stderr = '';

    raw.pipe(decoder.stdin);
    decoder.stdout.pipe(output);
    decoder.stderr.on('data', (chunk) => {
      stderr = appendDiagnostic(stderr, chunk);
    });

    decoder.once('error', (error) => output.destroy(error));
    decoder.once('exit', (code, signal) => {
      if (session.stopping) return;
      const detail = stderr ? `: ${stderr}` : '';
      output.destroy(new Error(`MJPEG decoder exited with code ${code ?? 'null'}, signal ${signal ?? 'none'}${detail}`));
      void this.cleanupMjpegSession(session);
    });

    try {
      await waitForReadable(output, this.startTimeoutMs, () => {
        const detail = stderr ? `: ${stderr}` : '';
        return new Error(`Timed out waiting for the first MJPEG frame${detail}`);
      });
      this.mjpegSessions.set(output, session);
      return output;
    } catch (error) {
      await this.cleanupMjpegSession(session);
      throw error;
    }
  }

  async releaseMjpeg(stream: Readable | undefined): Promise<void> {
    if (!stream) return;
    const session = this.mjpegSessions.get(stream);
    if (!session) {
      stream.destroy();
      return;
    }
    this.mjpegSessions.delete(stream);
    await this.cleanupMjpegSession(session);
  }

  async stop(): Promise<void> {
    const sessions = [...this.mjpegSessions.values()];
    this.mjpegSessions.clear();
    await Promise.allSettled(sessions.map((session) => this.cleanupMjpegSession(session)));

    for (const subscriber of this.rawSubscribers) subscriber.destroy();
    this.rawSubscribers.clear();
    await this.stopRawProcess();
  }

  private async ensureRawStarted(): Promise<void> {
    if (this.rawStarted && this.rawProcess) return;
    if (!this.rawStartPromise) {
      this.rawStartPromise = this.startRawProcess().finally(() => {
        this.rawStartPromise = undefined;
      });
    }
    await this.rawStartPromise;
  }

  private async startRawProcess(): Promise<void> {
    this.rawStderr = '';

    // ARStream2 can remain enabled after a previous consumer disconnects. In
    // that case a new receiver joins between keyframes and sees slices before
    // the SPS/PPS needed to decode them. Reset streaming before opening the
    // receiver so enabling it below starts a fresh H.264 sequence.
    try {
      this.options.disableVideo();
      // MediaStreaming commands are sent over UDP. Give the drone time to
      // apply the disable before sending the later enable; back-to-back
      // commands can otherwise be observed out of order.
      await delay(200);
    } catch {
      // The first start may occur before the command channel is fully ready.
    }

    const process = spawn(this.ffmpegBin, this.rawArgs(), { stdio: ['pipe', 'pipe', 'pipe'] });
    this.rawProcess = process;
    this.rawStarted = false;

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        const detail = this.rawStderr ? `: ${this.rawStderr}` : '';
        fail(new Error(`Timed out waiting for ARStream2 RTP video on UDP ${this.options.streamPort}${detail}`));
      }, this.startTimeoutMs);

      const succeed = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.rawStarted = true;
        resolve();
      };

      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      };

      process.stderr.on('data', (chunk) => {
        this.rawStderr = appendDiagnostic(this.rawStderr, chunk);
      });
      process.stdout.on('data', (chunk: Buffer) => {
        this.fanoutRaw(chunk);
        succeed();
      });
      process.once('error', fail);
      process.once('exit', (code, signal) => {
        const detail = this.rawStderr ? `: ${this.rawStderr}` : '';
        const error = new Error(`ARStream2 receiver exited with code ${code ?? 'null'}, signal ${signal ?? 'none'}${detail}`);
        if (!this.rawStarted) fail(error);
        else this.failRawSubscribers(error);
        if (this.rawProcess === process) {
          this.rawProcess = undefined;
          this.rawStarted = false;
        }
      });

      process.stdin.end(createArStream2Sdp(this.options.droneIp, this.options.streamPort));
      // Let FFmpeg parse the SDP and bind RTP/RTCP before the drone starts
      // sending. This avoids losing the initial SPS/PPS packets.
      setTimeout(() => {
        if (settled) return;
        try {
          this.options.enableVideo();
        } catch (error) {
          fail(error instanceof Error ? error : new Error(String(error)));
        }
      }, 200);
    }).catch(async (error) => {
      await this.stopRawProcess();
      throw error;
    });
  }

  private fanoutRaw(chunk: Buffer): void {
    for (const subscriber of this.rawSubscribers) {
      if (subscriber.destroyed) {
        this.rawSubscribers.delete(subscriber);
        continue;
      }
      if (subscriber.writableLength > MAX_SUBSCRIBER_BUFFER_BYTES) {
        this.rawSubscribers.delete(subscriber);
        subscriber.destroy(new Error('Raw video consumer fell too far behind'));
        continue;
      }
      subscriber.write(chunk);
    }
  }

  private failRawSubscribers(error: Error): void {
    for (const subscriber of this.rawSubscribers) subscriber.destroy(error);
    this.rawSubscribers.clear();
    try {
      this.options.disableVideo();
    } catch {
      // The command connection may already be gone.
    }
  }

  private async cleanupMjpegSession(session: MjpegSession): Promise<void> {
    if (session.stopping) return;
    session.stopping = true;
    session.raw.unpipe(session.decoder.stdin);
    session.decoder.stdin.end();
    if (!session.decoder.killed) session.decoder.kill('SIGTERM');
    session.output.destroy();
    await this.releaseRaw(session.raw);
  }

  private async stopRawWhenIdle(): Promise<void> {
    if (this.rawSubscribers.size === 0) await this.stopRawProcess();
  }

  private async stopRawProcess(): Promise<void> {
    const process = this.rawProcess;
    this.rawProcess = undefined;
    this.rawStarted = false;
    this.rawStartPromise = undefined;
    try {
      this.options.disableVideo();
    } catch {
      // The command connection may already be gone.
    }
    if (process && process.exitCode === null && process.signalCode === null) {
      process.kill('SIGTERM');
      await waitForProcessExit(process, 1_000);
      if (process.exitCode === null && process.signalCode === null) {
        process.kill('SIGKILL');
        await waitForProcessExit(process, 1_000);
      }
    }
  }

  private rawArgs(): string[] {
    return [
      '-hide_banner',
      '-loglevel', 'warning',
      '-protocol_whitelist', 'file,udp,rtp,pipe',
      '-fflags', 'nobuffer',
      '-flags', 'low_delay',
      // A Bebop receiver may attach between keyframes. Give FFmpeg enough
      // input to reach the next SPS/PPS instead of failing with dimensions not
      // set after the first undecodable slices.
      '-analyzeduration', H264_ANALYZE_DURATION_US,
      '-probesize', H264_PROBE_SIZE_BYTES,
      '-f', 'sdp',
      '-i', 'pipe:0',
      '-map', '0:v:0',
      '-an',
      '-c:v', 'copy',
      '-f', 'h264',
      'pipe:1',
    ];
  }

  private mjpegArgs(): string[] {
    const width = this.options.mjpegWidth ?? 480;
    const height = this.options.mjpegHeight ?? 276;
    const quality = this.options.mjpegQuality ?? 5;
    return [
      '-hide_banner',
      '-loglevel', 'warning',
      '-fflags', 'nobuffer',
      '-flags', 'low_delay',
      '-analyzeduration', H264_ANALYZE_DURATION_US,
      '-probesize', H264_PROBE_SIZE_BYTES,
      '-f', 'h264',
      '-i', 'pipe:0',
      '-map', '0:v:0',
      '-an',
      '-sws_flags', 'fast_bilinear',
      '-vf', `scale=${width}:${height}`,
      '-c:v', 'mjpeg',
      '-q:v', String(quality),
      // Do not let FFmpeg's guessed input rate silently reduce the number of
      // frames delivered by the drone.
      '-fps_mode', 'passthrough',
      '-f', 'image2pipe',
      'pipe:1',
    ];
  }
}

async function waitForProcessExit(process: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<void> {
  if (process.exitCode !== null || process.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(finish, timeoutMs);
    const onExit = () => finish();
    function finish() {
      clearTimeout(timer);
      process.off('exit', onExit);
      resolve();
    }
    process.once('exit', onExit);
  });
}

function delay(timeoutMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, timeoutMs));
}

function appendDiagnostic(current: string, chunk: Buffer | Uint8Array): string {
  const next = `${current}\n${Buffer.from(chunk).toString('utf8').trim()}`.trim();
  return next.slice(-2000);
}

function waitForReadable(stream: Readable, timeoutMs: number, timeoutError: () => Error): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(() => reject(timeoutError())), timeoutMs);
    const onReadable = () => finish(resolve);
    const onError = (error: Error) => finish(() => reject(error));
    const onEnd = () => finish(() => reject(new Error('Video stream ended before the first frame')));

    const finish = (callback: () => void) => {
      clearTimeout(timer);
      stream.off('readable', onReadable);
      stream.off('error', onError);
      stream.off('end', onEnd);
      callback();
    };

    stream.once('readable', onReadable);
    stream.once('error', onError);
    stream.once('end', onEnd);
  });
}
