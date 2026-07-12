import { describe, expect, it } from 'vitest';
import {
  filterFreshDetections,
  pilotAckTimedOut,
  shouldRetryLanding,
  updateIsFresh,
} from './autonomy-hardening.js';

const detection = {
  id: 'apriltag-7',
  label: 'landing-pad',
  confidence: 1,
  bbox: { x: 0.4, y: 0.4, width: 0.2, height: 0.2 },
  firstSeenAt: 900,
  lastSeenAt: 1_000,
};

describe('autonomy hardening helpers', () => {
  it('rejects stale and future pipeline updates', () => {
    expect(updateIsFresh(1_000, 1_500, 750)).toBe(true);
    expect(updateIsFresh(1_000, 2_000, 750)).toBe(false);
    expect(updateIsFresh(2_000, 1_000, 750)).toBe(false);
  });

  it('removes stale landing detections', () => {
    expect(filterFreshDetections([detection], 1_500, 750)).toHaveLength(1);
    expect(filterFreshDetections([detection], 2_000, 750)).toHaveLength(0);
  });

  it('detects missing command acknowledgements only while moving', () => {
    expect(pilotAckTimedOut(true, 1_000, 1_800, 750)).toBe(true);
    expect(pilotAckTimedOut(false, 1_000, 1_800, 750)).toBe(false);
  });

  it('retries landing while airborne', () => {
    expect(shouldRetryLanding(true, 1_000, 1_600, 500)).toBe(true);
    expect(shouldRetryLanding(false, 1_000, 1_600, 500)).toBe(false);
  });
});
