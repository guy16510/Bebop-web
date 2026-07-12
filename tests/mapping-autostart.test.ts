import { describe, expect, it, vi } from 'vitest';
import { MappingAutostartCoordinator } from '../src/mapping-autostart.js';

type VideoHealth = {
  state: 'disabled' | 'starting' | 'running' | 'fault';
  frames: number;
  lastFrameAt: number | null;
  lastError: string | null;
};

type PerceptionHealth = {
  state: 'disabled' | 'stopped' | 'starting' | 'running' | 'fault';
  trackingState: 'disabled' | 'initializing' | 'tracking' | 'lost' | 'fault';
  lastError: string | null;
};

function makeHarness() {
  let now = 1_000;
  let connectionState = 'disconnected';
  let video: VideoHealth = {
    state: 'disabled',
    frames: 0,
    lastFrameAt: null,
    lastError: null,
  };
  let perception: PerceptionHealth = {
    state: 'stopped',
    trackingState: 'disabled',
    lastError: null,
  };
  const connect = vi.fn(async () => {
    connectionState = 'connected';
  });
  const startVideo = vi.fn(async () => {
    video = { ...video, state: 'running' };
  });
  const stopVideo = vi.fn(async () => {
    video = { ...video, state: 'disabled', lastFrameAt: null };
  });
  const startPerception = vi.fn(async () => {
    perception = { state: 'running', trackingState: 'initializing', lastError: null };
  });
  const stopPerception = vi.fn(async () => {
    perception = { state: 'stopped', trackingState: 'disabled', lastError: null };
  });
  const coordinator = new MappingAutostartCoordinator({
    desired: { autoConnect: true, video: true, perception: true },
    now: () => now,
    retryMs: 500,
    frameTimeoutMs: 1_000,
    staleFrameMs: 1_000,
    connect,
    getConnectionState: () => connectionState,
    getVideoHealth: () => video,
    startVideo,
    stopVideo,
    getPerceptionHealth: () => perception,
    startPerception,
    stopPerception,
  });
  return {
    coordinator,
    connect,
    startVideo,
    stopVideo,
    startPerception,
    stopPerception,
    setConnectionState: (state: string) => { connectionState = state; },
    advance: (ms: number) => { now += ms; },
    setFrame: () => {
      video = { ...video, state: 'running', frames: video.frames + 1, lastFrameAt: now, lastError: null };
    },
    setVideoFault: (message = 'video fault') => {
      video = { ...video, state: 'fault', lastError: message };
    },
    setTracking: () => {
      perception = { state: 'running', trackingState: 'tracking', lastError: null };
    },
  };
}

describe('MappingAutostartCoordinator', () => {
  it('connects, starts video, waits for a frame, then starts SLAM', async () => {
    const harness = makeHarness();
    await harness.coordinator.tick();
    expect(harness.connect).toHaveBeenCalledTimes(1);

    await harness.coordinator.tick();
    expect(harness.startVideo).toHaveBeenCalledTimes(1);

    await harness.coordinator.tick();
    expect(harness.startPerception).not.toHaveBeenCalled();
    expect(harness.coordinator.getStatus().stage).toBe('waiting-for-video');

    harness.setFrame();
    await harness.coordinator.tick();
    expect(harness.startPerception).toHaveBeenCalledTimes(1);
    expect(harness.coordinator.getStatus().stage).toBe('initializing');

    harness.setTracking();
    await harness.coordinator.tick();
    expect(harness.coordinator.getStatus().stage).toBe('mapping');
  });

  it('waits for a manual connection when auto-connect is disabled', async () => {
    const harness = makeHarness();
    harness.coordinator.setDesired({ autoConnect: false, video: true, perception: true });
    await harness.coordinator.tick();
    expect(harness.connect).not.toHaveBeenCalled();
    expect(harness.coordinator.getStatus().stage).toBe('waiting-for-drone');

    harness.setConnectionState('connected');
    await harness.coordinator.tick();
    expect(harness.startVideo).toHaveBeenCalledTimes(1);
  });

  it('keeps video running while perception is toggled off', async () => {
    const harness = makeHarness();
    await harness.coordinator.tick();
    await harness.coordinator.tick();
    harness.setFrame();
    await harness.coordinator.tick();
    harness.setTracking();
    await harness.coordinator.tick();

    harness.coordinator.setDesired({ autoConnect: true, video: true, perception: false });
    await harness.coordinator.tick();
    expect(harness.stopPerception).toHaveBeenCalledTimes(1);
    expect(harness.stopVideo).not.toHaveBeenCalled();
    expect(harness.coordinator.getStatus().stage).toBe('video-only');
  });

  it('stops perception and video when automatic video is toggled off', async () => {
    const harness = makeHarness();
    await harness.coordinator.tick();
    await harness.coordinator.tick();
    harness.setFrame();
    await harness.coordinator.tick();

    harness.coordinator.setDesired({ autoConnect: true, video: false, perception: false });
    await harness.coordinator.tick();
    expect(harness.stopPerception).toHaveBeenCalledTimes(1);
    expect(harness.stopVideo).toHaveBeenCalledTimes(1);
    expect(harness.coordinator.getStatus().stage).toBe('connected');
  });

  it('recovers video and perception together after a video fault', async () => {
    const harness = makeHarness();
    await harness.coordinator.tick();
    await harness.coordinator.tick();
    harness.setFrame();
    await harness.coordinator.tick();
    harness.setTracking();
    await harness.coordinator.tick();

    harness.setVideoFault('decoder exited');
    await harness.coordinator.tick();
    expect(harness.stopPerception).toHaveBeenCalledTimes(1);
    expect(harness.stopVideo).toHaveBeenCalledTimes(1);
    expect(harness.coordinator.getStatus().stage).toBe('recovering');
    expect(harness.coordinator.getStatus().recoveries).toBe(1);
  });

  it('restarts when video runs without producing a fresh frame', async () => {
    const harness = makeHarness();
    await harness.coordinator.tick();
    await harness.coordinator.tick();
    harness.advance(1_100);
    await harness.coordinator.tick();
    expect(harness.stopVideo).toHaveBeenCalledTimes(1);
    expect(harness.coordinator.getStatus().recoveries).toBe(1);
  });

  it('stays stopped after an explicit disable', async () => {
    const harness = makeHarness();
    harness.coordinator.setEnabled(false);
    await harness.coordinator.tick();
    expect(harness.connect).not.toHaveBeenCalled();
    expect(harness.coordinator.getStatus().stage).toBe('disabled');
  });
});
