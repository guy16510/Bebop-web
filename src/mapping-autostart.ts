export type MappingAutostartStage =
  | 'disabled'
  | 'waiting-for-drone'
  | 'connecting'
  | 'starting-video'
  | 'waiting-for-video'
  | 'starting-perception'
  | 'initializing'
  | 'mapping'
  | 'recovering'
  | 'fault';

export interface MappingAutostartStatus {
  enabled: boolean;
  stage: MappingAutostartStage;
  attempts: number;
  recoveries: number;
  lastError: string | null;
  updatedAt: number;
}

export interface MappingAutostartOptions {
  enabled: boolean;
  getConnectionState: () => string;
  connect: () => Promise<void>;
  getVideoHealth: () => {
    state: 'disabled' | 'starting' | 'running' | 'fault';
    frames: number;
    lastFrameAt: number | null;
    lastError: string | null;
  };
  startVideo: () => Promise<void>;
  stopVideo: () => Promise<void>;
  getPerceptionHealth: () => {
    state: 'disabled' | 'stopped' | 'starting' | 'running' | 'fault';
    trackingState: 'disabled' | 'initializing' | 'tracking' | 'lost' | 'fault';
    lastError: string | null;
  };
  startPerception: () => Promise<void>;
  stopPerception: () => Promise<void>;
  retryMs?: number;
  frameTimeoutMs?: number;
  staleFrameMs?: number;
  trackingTimeoutMs?: number;
  intervalMs?: number;
  now?: () => number;
  onUpdate?: (status: MappingAutostartStatus) => void;
}

export class MappingAutostartCoordinator {
  private readonly now: () => number;
  private readonly retryMs: number;
  private readonly frameTimeoutMs: number;
  private readonly staleFrameMs: number;
  private readonly trackingTimeoutMs: number;
  private readonly intervalMs: number;
  private enabled: boolean;
  private busy = false;
  private timer?: NodeJS.Timeout;
  private nextAttemptAt = 0;
  private videoAttemptStartedAt: number | null = null;
  private trackingAttemptStartedAt: number | null = null;
  private status: MappingAutostartStatus;

  constructor(private readonly options: MappingAutostartOptions) {
    this.now = options.now ?? Date.now;
    this.retryMs = Math.max(250, options.retryMs ?? 2_000);
    this.frameTimeoutMs = Math.max(1_000, options.frameTimeoutMs ?? 15_000);
    this.staleFrameMs = Math.max(1_000, options.staleFrameMs ?? 5_000);
    this.trackingTimeoutMs = Math.max(5_000, options.trackingTimeoutMs ?? 30_000);
    this.intervalMs = Math.max(100, options.intervalMs ?? 500);
    this.enabled = options.enabled;
    this.status = {
      enabled: this.enabled,
      stage: this.enabled ? 'waiting-for-drone' : 'disabled',
      attempts: 0,
      recoveries: 0,
      lastError: null,
      updatedAt: this.now(),
    };
  }

  getStatus(): MappingAutostartStatus {
    return { ...this.status };
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    this.timer.unref();
    void this.tick();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.setEnabled(false);
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    this.nextAttemptAt = 0;
    this.videoAttemptStartedAt = null;
    this.trackingAttemptStartedAt = null;
    this.update(enabled ? 'waiting-for-drone' : 'disabled', null);
  }

  async tick(): Promise<void> {
    if (!this.enabled || this.busy) return;
    this.busy = true;
    try {
      await this.reconcile();
    } finally {
      this.busy = false;
    }
  }

  private async reconcile(): Promise<void> {
    const now = this.now();
    const connectionState = this.options.getConnectionState();
    if (connectionState !== 'connected') {
      this.videoAttemptStartedAt = null;
      this.trackingAttemptStartedAt = null;
      if (now < this.nextAttemptAt || connectionState === 'connecting') {
        this.update(connectionState === 'connecting' ? 'connecting' : 'waiting-for-drone');
        return;
      }
      this.status.attempts += 1;
      this.update('connecting');
      try {
        await this.options.connect();
        this.nextAttemptAt = 0;
        this.update('starting-video', null);
      } catch (error) {
        this.fail(error);
      }
      return;
    }

    if (now < this.nextAttemptAt) return;

    const video = this.options.getVideoHealth();
    const freshFrame = video.lastFrameAt !== null && now - video.lastFrameAt <= this.staleFrameMs;
    if (video.state === 'fault') {
      await this.recover(video.lastError ?? 'Video pipeline fault');
      return;
    }
    if (video.state === 'disabled') {
      this.status.attempts += 1;
      this.update('starting-video');
      this.videoAttemptStartedAt = now;
      try {
        await this.options.startVideo();
        this.update('waiting-for-video', null);
      } catch (error) {
        this.fail(error);
      }
      return;
    }
    if (!freshFrame) {
      if (video.frames > 0 && video.lastFrameAt !== null && now - video.lastFrameAt > this.staleFrameMs) {
        await this.recover('Decoded video stopped producing fresh frames');
        return;
      }
      this.update('waiting-for-video', video.lastError);
      const waitingSince = this.videoAttemptStartedAt ?? now;
      this.videoAttemptStartedAt = waitingSince;
      if (now - waitingSince >= this.frameTimeoutMs) {
        await this.recover('Video started but no fresh frame arrived before the timeout');
      }
      return;
    }
    this.videoAttemptStartedAt = null;

    const perception = this.options.getPerceptionHealth();
    if (perception.state === 'fault' || perception.trackingState === 'fault') {
      await this.recover(perception.lastError ?? 'Perception process fault');
      return;
    }
    if (perception.state === 'disabled') {
      this.fail(new Error('Perception backend is disabled'));
      return;
    }
    if (perception.state === 'stopped') {
      this.status.attempts += 1;
      this.update('starting-perception');
      this.trackingAttemptStartedAt = now;
      try {
        await this.options.startPerception();
        this.nextAttemptAt = 0;
        this.update('initializing', null);
      } catch (error) {
        this.fail(error);
      }
      return;
    }
    if (perception.trackingState === 'tracking') {
      this.trackingAttemptStartedAt = null;
      this.update('mapping', null);
      return;
    }

    const trackingSince = this.trackingAttemptStartedAt ?? now;
    this.trackingAttemptStartedAt = trackingSince;
    if (now - trackingSince >= this.trackingTimeoutMs) {
      await this.recover('ORB-SLAM3 did not establish or recover tracking before the timeout');
      return;
    }
    this.update('initializing', perception.lastError);
  }

  private async recover(reason: string): Promise<void> {
    this.status.recoveries += 1;
    this.update('recovering', reason);
    await Promise.allSettled([this.options.stopPerception(), this.options.stopVideo()]);
    this.videoAttemptStartedAt = null;
    this.trackingAttemptStartedAt = null;
    this.nextAttemptAt = this.now() + this.retryMs;
  }

  private fail(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.nextAttemptAt = this.now() + this.retryMs;
    this.update('fault', message);
  }

  private update(stage: MappingAutostartStage, error = this.status.lastError): void {
    this.status = {
      ...this.status,
      enabled: this.enabled,
      stage,
      lastError: error,
      updatedAt: this.now(),
    };
    this.options.onUpdate?.(this.getStatus());
  }
}
