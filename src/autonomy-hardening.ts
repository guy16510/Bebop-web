import type { ObjectDetection } from './perception.js';

export function updateIsFresh(
  lastUpdateAt: number | null | undefined,
  now: number,
  maximumAgeMs: number,
): boolean {
  return typeof lastUpdateAt === 'number'
    && lastUpdateAt <= now + 250
    && now - lastUpdateAt <= maximumAgeMs;
}

export function filterFreshDetections(
  detections: ObjectDetection[],
  now: number,
  maximumAgeMs: number,
): ObjectDetection[] {
  return detections.filter((detection) => (
    detection.lastSeenAt <= now + 250
    && now - detection.lastSeenAt <= maximumAgeMs
  ));
}

export function pilotAckTimedOut(
  commandActive: boolean,
  lastAckAt: number | null,
  now: number,
  timeoutMs: number,
): boolean {
  return commandActive && lastAckAt !== null && now - lastAckAt > timeoutMs;
}

export function shouldRetryLanding(
  airborne: boolean,
  lastRequestAt: number,
  now: number,
  retryMs: number,
): boolean {
  return airborne && now - lastRequestAt >= retryMs;
}
