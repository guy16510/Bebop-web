from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    file = Path(path)
    text = file.read_text()
    if old not in text:
        raise SystemExit(f"Expected text not found in {path}: {old[:160]!r}")
    file.write_text(text.replace(old, new, 1))


# Navigation settings and visual guard.
replace_once(
    "src/navigation.ts",
    """  obstacleAvoidanceEnabled: boolean;
  requireMetricRange: boolean;
  rangeTimeoutMs: number;""",
    """  obstacleAvoidanceEnabled: boolean;
  requireMetricRange: boolean;
  onboardVisionFallbackEnabled: boolean;
  visualDetectionTimeoutMs: number;
  visualMinimumConfidence: number;
  visualCautionAreaRatio: number;
  visualStopAreaRatio: number;
  visualCorridorWidth: number;
  onboardCruiseCommandPercent: number;
  rangeTimeoutMs: number;""",
)

replace_once(
    "src/navigation.ts",
    """  obstacleAvoidanceEnabled: true,
  requireMetricRange: true,
  rangeTimeoutMs: 750,""",
    """  obstacleAvoidanceEnabled: true,
  requireMetricRange: true,
  onboardVisionFallbackEnabled: true,
  visualDetectionTimeoutMs: 750,
  visualMinimumConfidence: 0.55,
  visualCautionAreaRatio: 0.035,
  visualStopAreaRatio: 0.09,
  visualCorridorWidth: 0.6,
  onboardCruiseCommandPercent: 6,
  rangeTimeoutMs: 750,""",
)

replace_once(
    "src/navigation.ts",
    """  const stopDistanceMeters = bounded(source.stopDistanceMeters, defaults.stopDistanceMeters, 0.25, 10);
  return {""",
    """  const stopDistanceMeters = bounded(source.stopDistanceMeters, defaults.stopDistanceMeters, 0.25, 10);
  const visualCautionAreaRatio = bounded(
    source.visualCautionAreaRatio,
    defaults.visualCautionAreaRatio,
    0.005,
    0.25,
  );
  return {""",
)

replace_once(
    "src/navigation.ts",
    """    requireMetricRange: typeof source.requireMetricRange === 'boolean'
      ? source.requireMetricRange
      : defaults.requireMetricRange,
    rangeTimeoutMs: bounded(source.rangeTimeoutMs, defaults.rangeTimeoutMs, 100, 5_000),""",
    """    requireMetricRange: typeof source.requireMetricRange === 'boolean'
      ? source.requireMetricRange
      : defaults.requireMetricRange,
    onboardVisionFallbackEnabled: typeof source.onboardVisionFallbackEnabled === 'boolean'
      ? source.onboardVisionFallbackEnabled
      : defaults.onboardVisionFallbackEnabled,
    visualDetectionTimeoutMs: bounded(
      source.visualDetectionTimeoutMs,
      defaults.visualDetectionTimeoutMs,
      200,
      2_000,
    ),
    visualMinimumConfidence: bounded(
      source.visualMinimumConfidence,
      defaults.visualMinimumConfidence,
      0.1,
      0.99,
    ),
    visualCautionAreaRatio,
    visualStopAreaRatio: bounded(
      source.visualStopAreaRatio,
      defaults.visualStopAreaRatio,
      visualCautionAreaRatio + 0.005,
      0.5,
    ),
    visualCorridorWidth: bounded(source.visualCorridorWidth, defaults.visualCorridorWidth, 0.2, 1),
    onboardCruiseCommandPercent: bounded(
      source.onboardCruiseCommandPercent,
      defaults.onboardCruiseCommandPercent,
      3,
      10,
    ),
    rangeTimeoutMs: bounded(source.rangeTimeoutMs, defaults.rangeTimeoutMs, 100, 5_000),""",
)

visual_guard = r'''

function visualCorridorOverlap(bbox: NormalizedBoundingBox, width: number): boolean {
  const left = 0.5 - width / 2;
  const right = 0.5 + width / 2;
  return bbox.x + bbox.width >= left && bbox.x <= right;
}

function capVisualAxis(value: number, maximum: number): number {
  return Math.sign(value) * Math.min(Math.abs(value), maximum);
}

export function applyOnboardVisionGuard(
  command: PilotingCommand,
  observations: SemanticObservation[],
  settings: NavigationSettings,
  now = Date.now(),
  allowLandingLateral = false,
): GuidanceResult {
  if (!command.active || !settings.obstacleAvoidanceEnabled || !settings.onboardVisionFallbackEnabled) {
    return { command, arrived: false, blocked: false, reason: null };
  }

  const translating = command.pitch !== 0 || command.roll !== 0;
  if (!translating) return { command, arrived: false, blocked: false, reason: null };
  if (command.pitch < 0) {
    return {
      command: ZERO_COMMAND,
      arrived: false,
      blocked: true,
      reason: 'Rear translation is disabled without a rear distance sensor',
    };
  }
  if (command.roll !== 0 && !allowLandingLateral) {
    return {
      command: ZERO_COMMAND,
      arrived: false,
      blocked: true,
      reason: 'Lateral translation is disabled outside precision landing without side distance sensors',
    };
  }

  const threats = observations
    .filter((observation) => observation.behavior !== 'ignore' && observation.behavior !== 'landing-pad')
    .filter((observation) => observation.confidence >= settings.visualMinimumConfidence)
    .filter((observation) => observation.lastSeenAt <= now + 250)
    .filter((observation) => now - observation.lastSeenAt <= settings.visualDetectionTimeoutMs)
    .filter((observation) => visualCorridorOverlap(observation.bbox, settings.visualCorridorWidth))
    .map((observation) => ({ observation, area: observation.bbox.width * observation.bbox.height }))
    .sort((a, b) => b.area - a.area);
  const threat = threats[0];

  if (threat && threat.area >= settings.visualStopAreaRatio) {
    return {
      command: ZERO_COMMAND,
      arrived: false,
      blocked: true,
      reason: `Visible ${threat.observation.name} occupies ${(threat.area * 100).toFixed(1)}% of the image corridor`,
    };
  }

  const cap = settings.onboardCruiseCommandPercent;
  const capped: PilotingCommand = {
    roll: capVisualAxis(command.roll, cap),
    pitch: capVisualAxis(command.pitch, cap),
    yaw: capVisualAxis(command.yaw, cap),
    gaz: command.gaz,
    active: command.active,
  };
  if (threat && threat.area >= settings.visualCautionAreaRatio) {
    capped.roll = Math.round(capped.roll * 0.4);
    capped.pitch = Math.round(capped.pitch * 0.4);
    capped.yaw = Math.round(capped.yaw * 0.4);
    capped.active = capped.roll !== 0 || capped.pitch !== 0 || capped.yaw !== 0 || capped.gaz !== 0;
    return {
      command: capped,
      arrived: false,
      blocked: false,
      reason: `Visible ${threat.observation.name} is approaching the image corridor, movement reduced`,
    };
  }

  return {
    command: capped,
    arrived: false,
    blocked: false,
    reason: 'Onboard camera guard active, no visible hazard in the flight corridor',
  };
}
'''
replace_once(
    "src/navigation.ts",
    "\nfunction wrapRadians(value: number): number {",
    visual_guard + "\nfunction wrapRadians(value: number): number {",
)

# Autonomy service integration and readiness.
replace_once(
    "src/autonomy-service.ts",
    """  NavigationMapManager,
  applyObstacleAvoidance,
  gpsGuidance,""",
    """  NavigationMapManager,
  applyObstacleAvoidance,
  applyOnboardVisionGuard,
  gpsGuidance,""",
)

replace_once(
    "src/autonomy-service.ts",
    """  rangeFresh: boolean;
  semanticObservations: SemanticObservation[];""",
    """  rangeFresh: boolean;
  avoidanceSource: 'metric-range' | 'onboard-vision' | 'none';
  semanticObservations: SemanticObservation[];""",
)

helper = r'''

function onboardVisionHealthy(now = Date.now()): boolean {
  return perception?.state === 'running'
    && perception.trackingState === 'tracking'
    && updateIsFresh(perception.lastUpdateAt, now, pipelineFreshnessMs);
}

function activeAvoidanceSource(now = Date.now()): NavigationRuntimeStatus['avoidanceSource'] {
  const navigation = navigationManager.getState().settings;
  if (!navigation.obstacleAvoidanceEnabled) return 'none';
  if (rangeFieldFresh(activeRange(now), navigation, now)) return 'metric-range';
  return navigation.onboardVisionFallbackEnabled && onboardVisionHealthy(now) ? 'onboard-vision' : 'none';
}
'''
replace_once(
    "src/autonomy-service.ts",
    "\nfunction navigationReadiness(settings: AutonomySettings, now = Date.now()): AutonomyReadinessCheck[] {",
    helper + "\nfunction navigationReadiness(settings: AutonomySettings, now = Date.now()): AutonomyReadinessCheck[] {",
)

replace_once(
    "src/autonomy-service.ts",
    """  const metricRangeRequired = navigation.settings.obstacleAvoidanceEnabled && navigation.settings.requireMetricRange;
  const currentRange = activeRange(now);""",
    """  const currentRange = activeRange(now);""",
)

replace_once(
    "src/autonomy-service.ts",
    """  if (metricRangeRequired && (needsGpsTransfer || settings.requireLandingMarker)) {
    const fresh = rangeFieldFresh(currentRange, navigation.settings, now);
    checks.push({
      key: 'metric-range',
      label: 'Metric obstacle range',
      ok: fresh,
      detail: fresh
        ? `${currentRange?.source ?? 'unknown'}, fresh`
        : 'Post fresh multi-sector ToF or LiDAR ranges before autonomous translation',
    });
  }""",
    """  if (navigation.settings.obstacleAvoidanceEnabled && (needsGpsTransfer || settings.requireLandingMarker)) {
    const metricReady = rangeFieldFresh(currentRange, navigation.settings, now);
    const visionReady = navigation.settings.onboardVisionFallbackEnabled && onboardVisionHealthy(now);
    checks.push({
      key: 'obstacle-avoidance-source',
      label: 'Obstacle-avoidance source',
      ok: metricReady || visionReady,
      detail: metricReady
        ? `${currentRange?.source ?? 'metric range'}, fresh`
        : visionReady
          ? 'Onboard camera and SLAM guard active, visible forward hazards only'
          : navigation.settings.onboardVisionFallbackEnabled
            ? 'Need fresh video and SLAM tracking for onboard-only guarding'
            : 'Connect fresh ToF or LiDAR range sectors',
    });
  }""",
)

replace_once(
    "src/autonomy-service.ts",
    """    rangeField: currentRange,
    rangeFresh: rangeFieldFresh(currentRange, map.settings, now),
    semanticObservations: semanticObservations(now),""",
    """    rangeField: currentRange,
    rangeFresh: rangeFieldFresh(currentRange, map.settings, now),
    avoidanceSource: activeAvoidanceSource(now),
    semanticObservations: semanticObservations(now),""",
)

replace_once(
    "src/autonomy-service.ts",
    """  const settings = navigationManager.getState().settings;
  const avoided = applyObstacleAvoidance(result.command, activeRange(now), settings, now);""",
    """  const settings = navigationManager.getState().settings;
  const currentRange = activeRange(now);
  const avoided = rangeFieldFresh(currentRange, settings, now)
    ? applyObstacleAvoidance(result.command, currentRange, settings, now)
    : settings.onboardVisionFallbackEnabled
      ? applyOnboardVisionGuard(
        result.command,
        semanticObservations(now),
        settings,
        now,
        stage === 'aligning-landing-pad',
      )
      : applyObstacleAvoidance(result.command, currentRange, settings, now);""",
)

replace_once(
    "src/autonomy-service.ts",
    """    const perceptionHealthy = perception?.state === 'running'
      && perception.trackingState === 'tracking'
      && updateIsFresh(perception.lastUpdateAt, now, pipelineFreshnessMs);
    if (settings.requirePerceptionTracking && !perceptionHealthy) {""",
    """    const perceptionHealthy = onboardVisionHealthy(now);
    const navigationSettings = navigationManager.getState().settings;
    const onboardGuardRequired = navigationSettings.obstacleAvoidanceEnabled
      && navigationSettings.onboardVisionFallbackEnabled
      && !rangeFieldFresh(activeRange(now), navigationSettings, now)
      && ['navigating', 'aligning-landing-pad'].includes(stage);
    if ((settings.requirePerceptionTracking || onboardGuardRequired) && !perceptionHealthy) {""",
)

replace_once(
    "src/autonomy-service.ts",
    """  requireMetricRange: z.boolean().optional(),
  rangeTimeoutMs: z.number().optional(),""",
    """  requireMetricRange: z.boolean().optional(),
  onboardVisionFallbackEnabled: z.boolean().optional(),
  visualDetectionTimeoutMs: z.number().optional(),
  visualMinimumConfidence: z.number().optional(),
  visualCautionAreaRatio: z.number().optional(),
  visualStopAreaRatio: z.number().optional(),
  visualCorridorWidth: z.number().optional(),
  onboardCruiseCommandPercent: z.number().optional(),
  rangeTimeoutMs: z.number().optional(),""",
)

# Dashboard controls and source status.
replace_once(
    "public/navigation.js",
    """        <label class="feature-toggle"><span><strong>Enable avoidance</strong><small>Filter autonomous translation through fresh range sectors.</small></span><input id="navigation-avoidance" type="checkbox" /></label>
        <label class="feature-toggle"><span><strong>Require metric range</strong><small>Block movement instead of guessing distance from a monocular image.</small></span><input id="navigation-require-range" type="checkbox" /></label>
        <label>Hard stop, m<input id="navigation-stop-distance" type="number" min="0.25" max="10" step="0.05" /></label>""",
    """        <label class="feature-toggle"><span><strong>Enable avoidance</strong><small>Use metric range when connected, otherwise use the conservative onboard-camera guard.</small></span><input id="navigation-avoidance" type="checkbox" /></label>
        <label class="feature-toggle"><span><strong>Prefer metric range</strong><small>Metric range overrides vision whenever fresh sensor sectors are available.</small></span><input id="navigation-require-range" type="checkbox" /></label>
        <label class="feature-toggle"><span><strong>Use onboard camera fallback</strong><small>Slow or stop for visible recognized hazards. This cannot see behind, above, glass, wires, or unknown objects.</small></span><input id="navigation-onboard-vision" type="checkbox" /></label>
        <label>Onboard max cruise, %<input id="navigation-onboard-cruise" type="number" min="3" max="10" step="1" /></label>
        <label>Visual minimum confidence<input id="navigation-visual-confidence" type="number" min="0.1" max="0.99" step="0.05" /></label>
        <label>Visual caution image ratio<input id="navigation-visual-caution" type="number" min="0.005" max="0.25" step="0.005" /></label>
        <label>Visual stop image ratio<input id="navigation-visual-stop" type="number" min="0.01" max="0.5" step="0.005" /></label>
        <label>Visual corridor width<input id="navigation-visual-corridor" type="number" min="0.2" max="1" step="0.05" /></label>
        <label>Hard stop, m<input id="navigation-stop-distance" type="number" min="0.25" max="10" step="0.05" /></label>""",
)

replace_once(
    "public/navigation.js",
    """        <div><span>Source</span><strong id="range-source">--</strong></div>""",
    """        <div><span>Active guard</span><strong id="range-source">--</strong></div>""",
)
replace_once(
    "public/navigation.js",
    """      <p class="navigation-note">Range sensors post to <code>/api/navigation/ranges</code> on the autonomy port. The server stops autonomous translation when required data becomes stale.</p>""",
    """      <p class="navigation-note">Fresh ToF or LiDAR data is preferred. Without it, the onboard camera guard only reacts to visible recognized hazards in the forward image corridor and caps translation speed.</p>""",
)

replace_once(
    "public/navigation.js",
    """  $('navigation-require-range').checked = settings.requireMetricRange;
  $('navigation-stop-distance').value = settings.stopDistanceMeters;""",
    """  $('navigation-require-range').checked = settings.requireMetricRange;
  $('navigation-onboard-vision').checked = settings.onboardVisionFallbackEnabled;
  $('navigation-onboard-cruise').value = settings.onboardCruiseCommandPercent;
  $('navigation-visual-confidence').value = settings.visualMinimumConfidence;
  $('navigation-visual-caution').value = settings.visualCautionAreaRatio;
  $('navigation-visual-stop').value = settings.visualStopAreaRatio;
  $('navigation-visual-corridor').value = settings.visualCorridorWidth;
  $('navigation-stop-distance').value = settings.stopDistanceMeters;""",
)

replace_once(
    "public/navigation.js",
    """  $('navigation-state').textContent = navigation.rangeFresh ? 'range ready' : 'range unavailable';
  $('navigation-state').className = `status ${navigation.rangeFresh ? 'status-ready' : 'status-blocked'}`;""",
    """  const source = navigation.avoidanceSource ?? (navigation.rangeFresh ? 'metric-range' : 'none');
  const sourceReady = source !== 'none';
  $('navigation-state').textContent = source === 'metric-range'
    ? 'metric guard'
    : source === 'onboard-vision'
      ? 'onboard vision guard'
      : 'avoidance unavailable';
  $('navigation-state').className = `status ${sourceReady ? 'status-ready' : 'status-blocked'}`;""",
)

replace_once(
    "public/navigation.js",
    """  $('range-source').textContent = navigation.rangeField?.source ?? '--';""",
    """  $('range-source').textContent = source === 'metric-range'
    ? navigation.rangeField?.source ?? 'metric range'
    : source === 'onboard-vision'
      ? 'onboard camera + SLAM'
      : '--';""",
)

replace_once(
    "public/navigation.js",
    """          obstacleAvoidanceEnabled: $('navigation-avoidance').checked,
          requireMetricRange: $('navigation-require-range').checked,
          stopDistanceMeters: numberValue('navigation-stop-distance'),""",
    """          obstacleAvoidanceEnabled: $('navigation-avoidance').checked,
          requireMetricRange: $('navigation-require-range').checked,
          onboardVisionFallbackEnabled: $('navigation-onboard-vision').checked,
          onboardCruiseCommandPercent: numberValue('navigation-onboard-cruise'),
          visualMinimumConfidence: numberValue('navigation-visual-confidence'),
          visualCautionAreaRatio: numberValue('navigation-visual-caution'),
          visualStopAreaRatio: numberValue('navigation-visual-stop'),
          visualCorridorWidth: numberValue('navigation-visual-corridor'),
          stopDistanceMeters: numberValue('navigation-stop-distance'),""",
)

# Regression tests.
replace_once(
    "src/navigation.test.ts",
    """  DEFAULT_NAVIGATION_SETTINGS,
  applyObstacleAvoidance,
  gpsGuidance,""",
    """  DEFAULT_NAVIGATION_SETTINGS,
  applyObstacleAvoidance,
  applyOnboardVisionGuard,
  gpsGuidance,""",
)
replace_once(
    "src/navigation.test.ts",
    """  type LandingPadDefinition,
  type RangeField,""",
    """  type LandingPadDefinition,
  type RangeField,
  type SemanticObservation,""",
)

test_block = r'''

describe('onboard camera obstacle guard', () => {
  const visible = (bbox: SemanticObservation['bbox'], name = 'Person'): SemanticObservation => ({
    trackId: name.toLowerCase(),
    semanticId: null,
    name,
    label: name.toLowerCase(),
    behavior: 'obstacle',
    confidence: 0.9,
    bbox,
    clearanceMeters: 2,
    markerId: null,
    firstSeenAt: now - 100,
    lastSeenAt: now,
  });

  it('caps forward speed when only onboard vision is available', () => {
    const result = applyOnboardVisionGuard(
      { ...forward, pitch: 18 },
      [],
      DEFAULT_NAVIGATION_SETTINGS,
      now,
    );
    expect(result.blocked).toBe(false);
    expect(result.command.pitch).toBe(DEFAULT_NAVIGATION_SETTINGS.onboardCruiseCommandPercent);
  });

  it('stops for a large visible hazard in the forward corridor', () => {
    const result = applyOnboardVisionGuard(
      forward,
      [visible({ x: 0.3, y: 0.2, width: 0.4, height: 0.5 })],
      DEFAULT_NAVIGATION_SETTINGS,
      now,
    );
    expect(result.blocked).toBe(true);
    expect(result.command.active).toBe(false);
  });

  it('does not allow blind reverse translation', () => {
    const result = applyOnboardVisionGuard(
      { ...forward, pitch: -6 },
      [],
      DEFAULT_NAVIGATION_SETTINGS,
      now,
    );
    expect(result.blocked).toBe(true);
    expect(result.reason).toContain('Rear translation');
  });

  it('ignores a small hazard outside the configured image corridor', () => {
    const result = applyOnboardVisionGuard(
      forward,
      [visible({ x: 0.01, y: 0.1, width: 0.08, height: 0.08 }, 'Chair')],
      DEFAULT_NAVIGATION_SETTINGS,
      now,
    );
    expect(result.blocked).toBe(false);
    expect(result.command.pitch).toBe(DEFAULT_NAVIGATION_SETTINGS.onboardCruiseCommandPercent);
  });
});
'''
replace_once(
    "src/navigation.test.ts",
    "\ndescribe('GPS guidance', () => {",
    test_block + "\ndescribe('GPS guidance', () => {",
)

Path("docs/onboard-only-autonomy.md").write_text(
    """# Onboard-only autonomous flight

The Bebop 2 can run a constrained onboard-only guard using its forward camera, object recognition, SLAM tracking, firmware altitude estimate, GPS, IMU, and AprilTag landing detector. This mode is not equivalent to LiDAR or multi-direction ToF.

## Enforced behavior

- Fresh live video and SLAM tracking are required whenever the onboard guard is the active avoidance source.
- Forward translation is capped at a low command percentage.
- Large recognized hazards inside the center image corridor stop movement.
- Smaller visible hazards reduce speed.
- Reverse translation is blocked.
- Sideways translation is blocked except during low-speed AprilTag landing alignment.
- Stale vision while translating causes a controlled landing.

## Blind spots

The front monocular camera cannot provide dependable metric distance for unknown objects. It cannot guarantee detection of glass, wires, thin branches, textureless walls, objects outside the frame, obstacles behind the drone, or obstacles directly above it. Use this mode only in a clear, controlled test area with a low altitude, low speed, short geofence, and an independent operator override.
"""
)

Path(".github/workflows/apply-onboard-vision.yml").unlink(missing_ok=True)
Path(".github/workflows/run-onboard-vision-pr.yml").unlink(missing_ok=True)
Path(".github/workflows/diagnose-onboard-vision.yml").unlink(missing_ok=True)
Path(".onboard-vision-trigger").unlink(missing_ok=True)
Path(".onboard-vision-error.txt").unlink(missing_ok=True)
Path(__file__).unlink(missing_ok=True)
