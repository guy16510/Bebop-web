import type { Response } from 'express';
import type { Readable } from 'node:stream';

export interface VideoHealth {
  state: 'disabled' | 'starting' | 'running' | 'fault';
  frames: number;
  bytes: number;
  viewers: number;
  droppedFrames: number;
  fps: number;
  lastFrameAt: number | null;
  lastError: string | null;
}

export interface VideoSource {
  startVideo(): Promise<Readable>;
  stopVideo(): Promise<void>;
}

interface Viewer {
  response: Response;
  writable: boolean;
}

const BOUNDARY = 'bebop-frame';

export class MjpegVideoManager {
  private sourceStream?: Readable;
  private viewers = new Set<Viewer>();
  private latestFrame?: Buffer;
  private startedAt = 0;
  private health: VideoHealth = {
    state: 'disabled',
    frames: 0,
    bytes: 0,
    viewers: 0,
    droppedFrames: 0,
    fps: 0,
    lastFrameAt: null,
    lastError: null,
  };

  constructor(private readonly source: VideoSource) {}

  async start(): Promise<void> {
    if (this.health.state === 'running' || this.health.state === 'starting') return;

    this.health.state = 'starting';
    this.health.lastError = null;
    this.startedAt = Date.now();

    try {
      const stream = await this.source.startVideo();
      this.sourceStream = stream;
      stream.on('data', this.onFrame);
      stream.once('error', this.onError);
      stream.once('end', this.onEnd);
      this.health.state = 'running';
    } catch (error) {
      this.onError(error);
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (this.sourceStream) {
      this.sourceStream.off('data', this.onFrame);
      this.sourceStream.off('error', this.onError);
      this.sourceStream.off('end', this.onEnd);
      this.sourceStream = undefined;
    }
    await this.source.stopVideo();
    this.health.state = 'disabled';
    this.latestFrame = undefined;
  }

  attach(response: Response): void {
    response.writeHead(200, {
      'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
      Connection: 'close',
      Pragma: 'no-cache',
      'Content-Type': `multipart/x-mixed-replace; boundary=${BOUNDARY}`,
      'X-Accel-Buffering': 'no',
    });

    const viewer: Viewer = { response, writable: true };
    this.viewers.add(viewer);
    this.health.viewers = this.viewers.size;

    response.on('drain', () => {
      viewer.writable = true;
      if (this.latestFrame) this.writeFrame(viewer, this.latestFrame);
    });

    response.on('close', () => {
      this.viewers.delete(viewer);
      this.health.viewers = this.viewers.size;
    });

    if (this.latestFrame) this.writeFrame(viewer, this.latestFrame);
  }

  getHealth(): VideoHealth {
    const elapsedSeconds = Math.max(1, (Date.now() - this.startedAt) / 1000);
    return {
      ...this.health,
      viewers: this.viewers.size,
      fps: this.health.frames / elapsedSeconds,
    };
  }

  private onFrame = (chunk: Buffer | Uint8Array): void => {
    const frame = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (!isJpeg(frame)) {
      this.health.droppedFrames += 1;
      return;
    }

    this.latestFrame = frame;
    this.health.frames += 1;
    this.health.bytes += frame.length;
    this.health.lastFrameAt = Date.now();

    for (const viewer of this.viewers) {
      if (!viewer.writable) {
        this.health.droppedFrames += 1;
        continue;
      }
      this.writeFrame(viewer, frame);
    }
  };

  private writeFrame(viewer: Viewer, frame: Buffer): void {
    if (viewer.response.destroyed) return;
    const header = Buffer.from(
      `--${BOUNDARY}\r\nContent-Type: image/jpeg\r\nContent-Length: ${frame.length}\r\n\r\n`,
    );
    viewer.writable = viewer.response.write(Buffer.concat([header, frame, Buffer.from('\r\n')]));
  }

  private onError = (error: unknown): void => {
    this.health.state = 'fault';
    this.health.lastError = error instanceof Error ? error.message : String(error);
  };

  private onEnd = (): void => {
    if (this.health.state !== 'disabled') {
      this.health.state = 'fault';
      this.health.lastError = 'Video source ended unexpectedly';
    }
  };
}

function isJpeg(frame: Buffer): boolean {
  return frame.length > 4 && frame[0] === 0xff && frame[1] === 0xd8 && frame.at(-2) === 0xff && frame.at(-1) === 0xd9;
}
