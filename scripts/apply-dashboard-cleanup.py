from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    file = Path(path)
    text = file.read_text()
    if old not in text:
        raise SystemExit(f"Expected text not found in {path}: {old[:160]!r}")
    file.write_text(text.replace(old, new, 1))


Path('public/index.html').write_text(r'''<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Bebop Autonomous Flight</title>
  <link rel="stylesheet" href="/styles.css" />
  <link rel="stylesheet" href="/readiness.css" />
  <link rel="stylesheet" href="/altitude.css" />
  <link rel="stylesheet" href="/perception.css" />
  <link rel="stylesheet" href="/features.css" />
  <link rel="stylesheet" href="/dashboard.css" />
</head>
<body>
  <main>
    <header class="app-header">
      <div>
        <h1>Bebop Autonomous Flight</h1>
        <p>Mission control, safety status, and live video for Parrot Bebop 2</p>
      </div>
      <span id="connection" class="badge state-disconnected">disconnected</span>
    </header>

    <section class="video">
      <img id="video-feed" alt="Bebop live camera" />
      <canvas id="detection-overlay" aria-hidden="true"></canvas>
      <div id="video-placeholder" class="video-placeholder">
        <strong>Video stopped</strong>
        <span>Connect to the drone, then start video.</span>
      </div>
      <div class="video-stats">
        <span id="video-state">disabled</span>
        <span id="video-fps">0.0 fps</span>
        <span id="video-drops">0 dropped</span>
      </div>
    </section>

    <section class="toolbar primary-actions" aria-label="Primary flight actions">
      <button type="button" class="primary" data-action="connect">Connect drone</button>
      <button type="button" data-action="video-start">Start video</button>
      <button type="button" class="land" data-action="land">LAND NOW</button>
      <button type="button" class="danger" data-action="emergency">EMERGENCY, CUT MOTORS</button>
    </section>

    <section class="grid dashboard-grid">
      <article class="telemetry-card">
        <h2>Flight telemetry</h2>
        <dl>
          <div><dt>Battery</dt><dd id="battery">--</dd></div>
          <div><dt>Wi-Fi signal</dt><dd class="signal-reading"><span class="signal-bars" aria-hidden="true"><i></i><i></i><i></i><i></i></span><span id="signal">--</span></dd></div>
          <div><dt>Height above takeoff</dt><dd class="height-reading"><strong id="height-feet">--</strong><span id="altitude">--</span></dd></div>
          <div><dt>Flight state</dt><dd id="flight-state">--</dd></div>
          <div><dt>Telemetry age</dt><dd id="telemetry-age">--</dd></div>
        </dl>
        <div class="height-panel">
          <meter id="altitude-meter" min="0" max="120" value="0">0</meter>
          <div class="height-scale"><span>0 ft</span><span id="altitude-limit">--</span></div>
          <p class="altitude-note">Relative to takeoff point, not terrain-following AGL.</p>
        </div>
      </article>

      <article class="safety-card">
        <h2>Safety status</h2>
        <dl>
          <div><dt>Armed</dt><dd id="armed">No</dd></div>
          <div><dt>Arm expires</dt><dd id="arm-expires">--</dd></div>
          <div><dt>Controls allowed</dt><dd id="controls-allowed">No</dd></div>
          <div><dt>Takeoff allowed</dt><dd id="takeoff-allowed">No</dd></div>
          <div><dt>Altitude mode</dt><dd id="altitude-mode">--</dd></div>
          <div><dt>Height remaining</dt><dd id="altitude-remaining">--</dd></div>
        </dl>
        <ul id="safety-warnings"></ul>
      </article>

      <article class="controls-card flight-control-card dashboard-collapsible">
        <details>
          <summary class="dashboard-summary">
            <span><strong>Manual flight controls</strong><small>Use only for direct piloting, testing, or recovery.</small></span>
            <span id="pilot-status" class="status">Controls not acquired</span>
          </summary>
          <div class="details-body">
            <div class="toolbar secondary-actions" aria-label="Manual drone actions">
              <button type="button" data-action="disconnect">Disconnect</button>
              <button type="button" data-action="video-stop">Stop video</button>
              <button type="button" class="primary" data-action="acquire">Acquire controls</button>
              <button type="button" data-action="release" disabled>Release controls</button>
              <button type="button" data-action="arm">Arm 10s</button>
              <button type="button" data-action="disarm">Disarm</button>
              <button type="button" id="takeoff-button" data-action="takeoff" disabled>Take off</button>
            </div>
            <div id="control-availability" class="control-availability status-warning" role="status" aria-live="polite">Acquire controls to enable movement</div>
            <div class="control-settings"><label for="control-strength">Movement strength<span>Starts at a conservative 20%. The server enforces its configured maximum.</span></label><input id="control-strength" type="range" min="5" max="35" step="5" value="20" /><output id="control-strength-value" for="control-strength">20%</output></div>
            <button type="button" class="master-stop" data-control="stop" aria-label="Stop all movement" disabled>STOP MOVEMENT<small>Space or Escape</small></button>
            <pre id="command">roll 0  pitch 0  yaw 0  gaz 0</pre>
            <div class="flight-controls" aria-label="Drone movement controls">
              <div class="control-pad direction-pad">
                <button type="button" class="move forward" data-control="forward" aria-label="Move forward" aria-pressed="false" disabled>▲<small>Forward</small></button>
                <button type="button" class="move left" data-control="left" aria-label="Move left" aria-pressed="false" disabled>◀<small>Left</small></button>
                <button type="button" class="move stop" data-control="stop" aria-label="Stop all movement" disabled>STOP</button>
                <button type="button" class="move right" data-control="right" aria-label="Move right" aria-pressed="false" disabled>▶<small>Right</small></button>
                <button type="button" class="move backward" data-control="backward" aria-label="Move backward" aria-pressed="false" disabled>▼<small>Back</small></button>
              </div>
              <div class="control-column" aria-label="Altitude controls"><button type="button" class="move" data-control="up" aria-pressed="false" disabled>↑<small>Rise</small></button><button type="button" class="move" data-control="down" aria-pressed="false" disabled>↓<small>Descend</small></button></div>
              <div class="control-column" aria-label="Yaw controls"><button type="button" class="move" data-control="yaw-left" aria-pressed="false" disabled>↶<small>Yaw left</small></button><button type="button" class="move" data-control="yaw-right" aria-pressed="false" disabled>↷<small>Yaw right</small></button></div>
            </div>
          </div>
        </details>
      </article>

      <article class="feature-card controls-card dashboard-collapsible">
        <details>
          <summary class="dashboard-summary">
            <span><strong>System startup and display</strong><small>Automatic connection, video, perception, overlays, and map visibility.</small></span>
            <span id="feature-mode" class="status status-warning">loading</span>
          </summary>
          <div class="details-body">
            <div class="feature-toggle-grid">
              <label class="feature-toggle"><span><strong>Automatic connection</strong><small>Retry the Bebop Wi-Fi connection until available.</small></span><input type="checkbox" data-runtime-feature="autoConnect" disabled /></label>
              <label class="feature-toggle"><span><strong>Automatic video</strong><small>Start video after connection and recover stale frames.</small></span><input type="checkbox" data-runtime-feature="video" disabled /></label>
              <label class="feature-toggle"><span><strong>SLAM + recognition</strong><small>Run the ORB-SLAM3 and YOLOX sidecar.</small></span><input type="checkbox" data-runtime-feature="perception" disabled /></label>
              <label class="feature-toggle"><span><strong>Detection overlay</strong><small>Show object boxes and recognized tracks.</small></span><input type="checkbox" data-runtime-feature="showDetections" disabled /></label>
              <label class="feature-toggle"><span><strong>Map rendering</strong><small>Show trajectory and sparse landmarks.</small></span><input type="checkbox" data-runtime-feature="showMap" disabled /></label>
            </div>
            <dl class="feature-status-grid">
              <div><dt>Automation stage</dt><dd id="automation-stage">--</dd></div>
              <div><dt>Attempts</dt><dd id="automation-attempts">0</dd></div>
              <div><dt>Recoveries</dt><dd id="automation-recoveries">0</dd></div>
              <div><dt>Saved setting</dt><dd><span id="feature-revision">revision 0</span> · <span id="feature-updated-by">environment</span></dd></div>
            </dl>
            <p id="automation-error" hidden></p>
          </div>
        </details>
      </article>

      <article class="perception-card controls-card dashboard-collapsible">
        <details>
          <summary class="dashboard-summary">
            <span><strong>Perception and SLAM map</strong><small>Engineering view for tracking, detections, and map health.</small></span>
            <span id="perception-state" class="status status-warning">stopped</span>
          </summary>
          <div class="details-body">
            <div class="toolbar" aria-label="Perception actions">
              <button type="button" class="primary" data-perception-action="start">Start perception</button>
              <button type="button" data-perception-action="stop" disabled>Stop perception</button>
              <button type="button" data-perception-action="reset">Reset map</button>
            </div>
            <p id="perception-error" class="perception-error" hidden></p>
            <div class="perception-layout">
              <div class="map-column">
                <div class="map-toolbar" aria-label="Map controls">
                  <button type="button" id="map-fit">Fit map</button>
                  <button type="button" id="map-follow" aria-pressed="true">Follow drone</button>
                  <button type="button" id="map-export">Export JSON</button>
                  <label><input type="checkbox" data-map-layer="landmarks" checked /> Landmarks</label>
                  <label><input type="checkbox" data-map-layer="trajectory" checked /> Path</label>
                  <label><input type="checkbox" data-map-layer="objects" checked /> Objects</label>
                  <span id="map-zoom">100%</span>
                </div>
                <div class="map-frame">
                  <svg id="slam-map" role="img" aria-label="Interactive top-down SLAM map"></svg>
                  <div id="map-tooltip" role="status" hidden></div>
                  <div class="map-legend" aria-hidden="true"><span><i class="legend-landmark"></i>Landmark</span><span><i class="legend-path"></i>Trajectory</span><span><i class="legend-object"></i>Object</span><span><i class="legend-drone"></i>Drone</span></div>
                </div>
              </div>
              <div class="perception-side">
                <dl>
                  <div><dt>Backend</dt><dd id="perception-backend">--</dd></div>
                  <div><dt>Tracking</dt><dd id="perception-tracking">--</dd></div>
                  <div><dt>Scale</dt><dd id="perception-scale">--</dd></div>
                  <div><dt>Rates</dt><dd id="perception-fps">--</dd></div>
                  <div><dt>Latency</dt><dd id="perception-latency">--</dd></div>
                  <div><dt>Tracked features</dt><dd id="perception-features">--</dd></div>
                  <div><dt>Map points</dt><dd id="perception-map-points">--</dd></div>
                  <div><dt>Objects</dt><dd id="perception-objects">--</dd></div>
                  <div><dt>Keyframes</dt><dd id="perception-keyframes">--</dd></div>
                </dl>
                <div id="recognized-panel"><h3>Recognized objects</h3><p id="recognized-empty">No objects tracked.</p><ul id="recognized-objects"></ul></div>
              </div>
            </div>
          </div>
        </details>
      </article>

      <article class="controls-card diagnostics-card dashboard-collapsible">
        <details>
          <summary class="dashboard-summary">
            <span><strong>Control-link diagnostics</strong><small>Latency and server command acceptance, mainly for props-off validation.</small></span>
            <strong id="control-readiness" class="readiness-pending">NOT READY</strong>
          </summary>
          <div class="details-body">
            <div class="readiness-panel" aria-live="polite"><p id="control-readiness-detail">Run the 20-sample test, exercise one direction, release it, then press STOP.</p></div>
            <dl>
              <div><dt>WebSocket RTT</dt><dd id="ws-rtt">--</dd></div>
              <div><dt>WebSocket p95</dt><dd id="ws-p95">--</dd></div>
              <div><dt>Last command RTT</dt><dd id="command-rtt">--</dd></div>
              <div><dt>Last STOP RTT</dt><dd id="stop-rtt">--</dd></div>
              <div><dt>Server apply time</dt><dd id="server-apply">--</dd></div>
            </dl>
            <div class="toolbar"><button type="button" id="run-latency-test">Run 20-sample test</button><span id="latency-test-status" class="status">Not run</span></div>
            <p>Last server-applied command:</p>
            <pre id="server-command">No tracked command received</pre>
          </div>
        </details>
      </article>
    </section>

    <div id="message" role="status" aria-live="polite"></div>
  </main>
  <script type="module" src="/app.js"></script>
  <script type="module" src="/readiness.js"></script>
  <script type="module" src="/altitude.js"></script>
  <script type="module" src="/perception.js"></script>
  <script type="module" src="/features.js"></script>
</body>
</html>
''')

Path('public/dashboard.css').write_text(r'''.app-header p {
  margin: 6px 0 0;
  color: #94a3b8;
}

.primary-actions {
  position: sticky;
  top: 0;
  z-index: 20;
  padding: 12px;
  border: 1px solid #334155;
  border-radius: 12px;
  background: rgba(15, 23, 42, 0.96);
  backdrop-filter: blur(10px);
}

.primary-actions button {
  min-height: 48px;
}

.primary-actions .danger {
  margin-left: auto;
}

.dashboard-grid > #autonomy-card,
.dashboard-grid > #navigation-card,
.dashboard-grid > .controls-card,
.dashboard-grid > .perception-card {
  grid-column: 1 / -1;
}

#autonomy-card { order: 0; }
.telemetry-card, .safety-card { order: 10; }
#navigation-card { order: 20; }
.flight-control-card { order: 30; }
.perception-card { order: 40; }
.feature-card { order: 50; }
.diagnostics-card { order: 60; }

.dashboard-collapsible {
  padding: 0 !important;
  overflow: hidden;
}

.dashboard-collapsible > details > summary,
.navigation-card > details > summary,
.embedded-details > summary {
  list-style: none;
  cursor: pointer;
}

.dashboard-collapsible > details > summary::-webkit-details-marker,
.navigation-card > details > summary::-webkit-details-marker,
.embedded-details > summary::-webkit-details-marker {
  display: none;
}

.dashboard-summary {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 18px;
  min-height: 72px;
  padding: 18px;
}

.dashboard-summary > span:first-child {
  display: grid;
  gap: 4px;
}

.dashboard-summary strong {
  font-size: 18px;
}

.dashboard-summary small {
  color: #94a3b8;
}

.dashboard-summary::after {
  content: 'Show';
  color: #93c5fd;
  font-size: 12px;
  font-weight: 800;
}

details[open] > .dashboard-summary::after {
  content: 'Hide';
}

.dashboard-summary > .status,
.dashboard-summary > #control-readiness {
  margin-left: auto;
}

.details-body {
  padding: 0 18px 18px;
  border-top: 1px solid #1f2937;
}

.secondary-actions {
  margin-top: 18px;
}

.embedded-details {
  margin: 16px 0;
  border: 1px solid #334155;
  border-radius: 12px;
  background: #0f172a;
}

.embedded-details > summary {
  padding: 14px 16px;
  color: #cbd5e1;
  font-weight: 800;
}

.embedded-details > summary::after {
  content: ' +';
  color: #93c5fd;
}

.embedded-details[open] > summary::after {
  content: ' −';
}

.embedded-details > div {
  padding: 0 14px 14px;
}

.autonomy-primary-settings {
  margin-top: 16px;
}

.navigation-card {
  padding: 0 !important;
  overflow: hidden;
}

.navigation-card .navigation-heading {
  margin: 0;
}

@media (max-width: 700px) {
  .primary-actions {
    position: static;
  }

  .primary-actions .danger {
    margin-left: 0;
  }

  .dashboard-summary {
    align-items: flex-start;
    flex-wrap: wrap;
  }

  .dashboard-summary > .status,
  .dashboard-summary > #control-readiness {
    margin-left: 0;
  }
}
''')

# Put autonomous mission control first and split primary settings from advanced tuning.
autonomy_path = Path('public/autonomy.js')
autonomy = autonomy_path.read_text()
start = autonomy.index('  card.innerHTML = `')
end = autonomy.index('  `;\n\n  const grid', start) + len('  `;')
autonomy_markup = r'''  card.innerHTML = `
    <div class="autonomy-heading">
      <div>
        <h2>Autonomous mission</h2>
        <p>Configure, validate, launch, and safely abort a closed-loop mission.</p>
      </div>
      <span id="autonomy-stage" class="status status-warning">connecting</span>
    </div>
    <div id="autonomy-banner" class="autonomy-banner" role="status">Connecting to the autonomy service on port ${configuredPort}.</div>
    <form id="autonomy-form">
      <div class="autonomy-toggle-grid">
        <label class="feature-toggle autonomy-master"><span><strong>Enable autonomy</strong><small>Master mission gate.</small></span><input id="autonomy-enabled" type="checkbox" /></label>
        <label class="feature-toggle autonomy-physical"><span><strong>Allow physical flight</strong><small>Requires typed confirmation for every launch.</small></span><input id="autonomy-physical" type="checkbox" /></label>
        <label class="feature-toggle"><span><strong>Require live video</strong><small>Block takeoff and land on stale frames.</small></span><input id="autonomy-require-video" type="checkbox" /></label>
        <label class="feature-toggle"><span><strong>Require SLAM tracking</strong><small>Block takeoff and land if tracking is lost.</small></span><input id="autonomy-require-perception" type="checkbox" /></label>
        <label class="feature-toggle"><span><strong>Require landing marker</strong><small>Align to the selected pad's AprilTag.</small></span><input id="autonomy-require-marker" type="checkbox" /></label>
      </div>
      <div class="autonomy-settings-grid autonomy-primary-settings">
        <label>Mission<select id="autonomy-pattern"><option value="hover">Hover only</option><option value="yaw-scan">Hover + yaw scan</option><option value="pad-transfer">Fly to named pad</option></select></label>
        <label>Takeoff pad<select id="autonomy-takeoff-pad"><option value="">Unspecified</option></select></label>
        <label>Landing pad<select id="autonomy-landing-pad"><option value="">Immediate landing</option></select></label>
        <label>Target altitude, m<input id="autonomy-target-altitude" type="number" min="0.5" max="10" step="0.1" /></label>
        <label>Horizontal geofence, m<input id="autonomy-max-distance" type="number" min="2" max="100" step="1" /></label>
        <label>Maximum flight time, s<input id="autonomy-max-seconds" type="number" min="20" max="300" step="5" /></label>
      </div>
      <details class="embedded-details">
        <summary>Advanced safety and mission tuning</summary>
        <div class="autonomy-settings-grid">
          <label>Autonomy ceiling, m<input id="autonomy-max-altitude" type="number" min="0.5" max="10" step="0.1" /></label>
          <label>Command strength, %<input id="autonomy-command" type="number" min="5" max="20" step="1" /></label>
          <label>Minimum takeoff battery, %<input id="autonomy-min-battery" type="number" min="20" max="100" step="1" /></label>
          <label>Landing reserve, %<input id="autonomy-reserve-battery" type="number" min="10" max="99" step="1" /></label>
          <label>Minimum signal, dBm<input id="autonomy-min-signal" type="number" min="-95" max="-35" step="1" /></label>
          <label>Minimum GPS satellites<input id="autonomy-min-satellites" type="number" min="4" max="20" step="1" /></label>
          <label>GPS coordinate timeout, ms<input id="autonomy-gps-timeout" type="number" min="1000" max="10000" step="250" /></label>
          <label>Telemetry timeout, ms<input id="autonomy-telemetry-timeout" type="number" min="500" max="5000" step="100" /></label>
          <label>Hover time, s<input id="autonomy-hover-seconds" type="number" min="2" max="60" step="1" /></label>
          <label>Yaw scan time, s<input id="autonomy-yaw-seconds" type="number" min="2" max="45" step="1" /></label>
          <label>Navigation timeout, s<input id="autonomy-navigation-seconds" type="number" min="10" max="600" step="5" /></label>
          <label>Marker search timeout, s<input id="autonomy-search-seconds" type="number" min="5" max="120" step="1" /></label>
        </div>
      </details>
      <div class="autonomy-save-row"><button id="autonomy-save" type="submit">Save mission settings</button><span id="autonomy-revision">revision 0</span></div>
    </form>
    <div class="autonomy-runtime-grid">
      <div><span>Mode</span><strong id="autonomy-mode">--</strong></div>
      <div><span>Control link</span><strong id="autonomy-link">--</strong></div>
      <div><span>Mission</span><strong id="autonomy-mission">--</strong></div>
      <div><span>Deadline</span><strong id="autonomy-deadline">--</strong></div>
      <div><span>Target pad</span><strong id="autonomy-target-pad">--</strong></div>
      <div><span>Guidance</span><strong id="autonomy-guidance">--</strong></div>
    </div>
    <div class="autonomy-preflight"><h3>Preflight gates</h3><ul id="autonomy-readiness"></ul></div>
    <div class="autonomy-launch-row">
      <label class="autonomy-confirm">Physical-flight confirmation<input id="autonomy-confirmation" type="text" autocomplete="off" placeholder="START AUTONOMOUS FLIGHT" /></label>
      <button id="autonomy-start" type="button" class="primary">Start autonomous mission</button>
      <button id="autonomy-abort" type="button" class="land">Abort and land</button>
      <button id="autonomy-land" type="button">Land now</button>
      <button id="autonomy-emergency" type="button" class="danger">Emergency, cut motors</button>
    </div>
    <p id="autonomy-error" class="autonomy-error" hidden></p>
  `;'''
autonomy = autonomy[:start] + autonomy_markup + autonomy[end:]
autonomy = autonomy.replace("  const grid = document.querySelector('.grid');\n  const featureCard = document.querySelector('.feature-card');\n  if (grid && featureCard) featureCard.insertAdjacentElement('afterend', card);\n  else grid?.prepend(card);", "  document.querySelector('.grid')?.prepend(card);")
autonomy = autonomy.replace("    minimumSignalRssi: settingValue('autonomy-min-signal'),", "    minimumSignalRssi: settingValue('autonomy-min-signal'),\n    minimumGpsSatellites: settingValue('autonomy-min-satellites'),\n    gpsTimeoutMs: settingValue('autonomy-gps-timeout'),")
autonomy = autonomy.replace("  $('autonomy-min-signal').value = settings.minimumSignalRssi;", "  $('autonomy-min-signal').value = settings.minimumSignalRssi;\n  $('autonomy-min-satellites').value = settings.minimumGpsSatellites;\n  $('autonomy-gps-timeout').value = settings.gpsTimeoutMs;")
autonomy_path.write_text(autonomy)

# Collapse the full navigation editor by default while retaining all capabilities.
replace_once('public/navigation.js', r'''    <div class="navigation-heading">
      <div>
        <h2>Semantic navigation and landing pads</h2>
        <p>The wide-angle camera recognizes objects and tags. Metric ToF or LiDAR ranges make collision decisions. GPS performs coarse pad transfer, AprilTags perform final landing alignment.</p>
      </div>
      <span id="navigation-state" class="status status-warning">waiting</span>
    </div>
''', r'''    <details>
      <summary class="dashboard-summary navigation-heading">
        <span><strong>Navigation and landing-pad setup</strong><small>Configure range sensors, named pads, object rules, and precision landing.</small></span>
        <span id="navigation-state" class="status status-warning">waiting</span>
      </summary>
      <div class="details-body">
''')
replace_once('public/navigation.js', r'''    <p id="navigation-error" class="autonomy-error" hidden></p>
  `;''', r'''    <p id="navigation-error" class="autonomy-error" hidden></p>
      </div>
    </details>
  `;''')

# Add explicit GPS freshness and satellite quality to telemetry.
replace_once('src/types.ts', "  satellites?: number | null;\n", "  satellites?: number | null;\n  gpsUpdatedAt?: number | null;\n")
replace_once('src/drone-adapters.ts', "      satellites: 12,\n", "      satellites: 12,\n      gpsUpdatedAt: Date.now(),\n")
replace_once('src/drone-adapters.ts', "      satellites: null,\n", "      satellites: null,\n      gpsUpdatedAt: null,\n")
replace_once('src/drone-adapters.ts', "      if (typeof telemetry.latitude === 'number' && typeof telemetry.longitude === 'number') {\n        telemetry.latitude += north * 0.1 / 111_132.92;", "      if (typeof telemetry.latitude === 'number' && typeof telemetry.longitude === 'number') {\n        telemetry.latitude += north * 0.1 / 111_132.92;\n        telemetry.gpsUpdatedAt = Date.now();")
replace_once('src/drone-adapters.ts', "      if (altitude !== null && altitude !== 500) this.snapshot.telemetry.gpsAltitude = altitude;\n      update();", "      if (altitude !== null && altitude !== 500) this.snapshot.telemetry.gpsAltitude = altitude;\n      if (typeof this.snapshot.telemetry.latitude === 'number' && typeof this.snapshot.telemetry.longitude === 'number') {\n        this.snapshot.telemetry.gpsUpdatedAt = Date.now();\n      }\n      update();")

# Add persisted GPS quality settings.
replace_once('src/autonomy.ts', "  minimumSignalRssi: number;\n", "  minimumSignalRssi: number;\n  minimumGpsSatellites: number;\n  gpsTimeoutMs: number;\n")
replace_once('src/autonomy.ts', "  minimumSignalRssi: -75,\n", "  minimumSignalRssi: -75,\n  minimumGpsSatellites: 6,\n  gpsTimeoutMs: 3_000,\n")
replace_once('src/autonomy.ts', "    minimumSignalRssi: finiteNumber(source.minimumSignalRssi, defaults.minimumSignalRssi, -95, -35),\n", "    minimumSignalRssi: finiteNumber(source.minimumSignalRssi, defaults.minimumSignalRssi, -95, -35),\n    minimumGpsSatellites: finiteNumber(source.minimumGpsSatellites, defaults.minimumGpsSatellites, 4, 20),\n    gpsTimeoutMs: finiteNumber(source.gpsTimeoutMs, defaults.gpsTimeoutMs, 1_000, 10_000),\n")

replace_once('src/autonomy-service.ts', "  minimumSignalRssi: envNumber('AUTONOMY_MINIMUM_SIGNAL_RSSI', DEFAULT_AUTONOMY_SETTINGS.minimumSignalRssi),\n", "  minimumSignalRssi: envNumber('AUTONOMY_MINIMUM_SIGNAL_RSSI', DEFAULT_AUTONOMY_SETTINGS.minimumSignalRssi),\n  minimumGpsSatellites: envNumber('AUTONOMY_MINIMUM_GPS_SATELLITES', DEFAULT_AUTONOMY_SETTINGS.minimumGpsSatellites),\n  gpsTimeoutMs: envNumber('AUTONOMY_GPS_TIMEOUT_MS', DEFAULT_AUTONOMY_SETTINGS.gpsTimeoutMs),\n")
replace_once('src/autonomy-service.ts', "let geofenceViolationSince: number | null = null;\n", "let geofenceViolationSince: number | null = null;\nlet gpsUnhealthySince: number | null = null;\n")
replace_once('src/autonomy-service.ts', "  minimumSignalRssi: z.number().optional(),\n", "  minimumSignalRssi: z.number().optional(),\n  minimumGpsSatellites: z.number().optional(),\n  gpsTimeoutMs: z.number().optional(),\n")

old_gps = r'''    const gpsReady = drone?.telemetry.gpsFix === true
      && typeof drone.telemetry.latitude === 'number'
      && typeof drone.telemetry.longitude === 'number'
      && typeof drone.telemetry.yaw === 'number';
    checks.push({
      key: 'gps-fix',
      label: 'GPS and heading',
      ok: gpsReady,
      detail: gpsReady
        ? `${drone?.telemetry.satellites ?? '?'} satellites, heading available`
        : 'Pad-transfer requires a current GPS fix and yaw telemetry',
    });'''
new_gps = r'''    const gpsAge = typeof drone?.telemetry.gpsUpdatedAt === 'number'
      ? Math.max(0, now - drone.telemetry.gpsUpdatedAt)
      : Number.POSITIVE_INFINITY;
    const satellites = drone?.telemetry.satellites;
    const gpsReady = drone?.telemetry.gpsFix === true
      && typeof drone.telemetry.latitude === 'number'
      && typeof drone.telemetry.longitude === 'number'
      && typeof drone.telemetry.yaw === 'number'
      && typeof satellites === 'number'
      && satellites >= settings.minimumGpsSatellites
      && gpsAge <= settings.gpsTimeoutMs;
    checks.push({
      key: 'gps-fix',
      label: 'GPS quality and heading',
      ok: gpsReady,
      detail: gpsReady
        ? `${satellites} satellites, coordinates ${gpsAge} ms old`
        : `Need ${settings.minimumGpsSatellites}+ satellites, fresh coordinates, and heading`,
    });'''
replace_once('src/autonomy-service.ts', old_gps, new_gps)

runtime_anchor = r'''    const perceptionHealthy = perception?.state === 'running'
      && perception.trackingState === 'tracking'
      && updateIsFresh(perception.lastUpdateAt, now, pipelineFreshnessMs);'''
runtime_insert = r'''    if (settings.pattern === 'pad-transfer') {
      const gpsAge = typeof drone?.telemetry.gpsUpdatedAt === 'number'
        ? Math.max(0, now - drone.telemetry.gpsUpdatedAt)
        : Number.POSITIVE_INFINITY;
      const gpsHealthy = drone?.telemetry.gpsFix === true
        && typeof drone.telemetry.latitude === 'number'
        && typeof drone.telemetry.longitude === 'number'
        && typeof drone.telemetry.yaw === 'number'
        && typeof drone.telemetry.satellites === 'number'
        && drone.telemetry.satellites >= settings.minimumGpsSatellites
        && gpsAge <= settings.gpsTimeoutMs;
      if (!gpsHealthy) {
        gpsUnhealthySince ??= now;
        if (now - gpsUnhealthySince >= 2_000) beginLanding('GPS quality or coordinates became stale', 'aborted');
      } else {
        gpsUnhealthySince = null;
      }
    } else {
      gpsUnhealthySince = null;
    }

    const perceptionHealthy = perception?.state === 'running'
      && perception.trackingState === 'tracking'
      && updateIsFresh(perception.lastUpdateAt, now, pipelineFreshnessMs);'''
replace_once('src/autonomy-service.ts', runtime_anchor, runtime_insert)
replace_once('src/autonomy-service.ts', "  geofenceViolationSince = null;\n  lastPilotAckAt = null;", "  geofenceViolationSince = null;\n  gpsUnhealthySince = null;\n  lastPilotAckAt = null;")

# Environment documentation.
for env_path in ['.env.example', '.env.bebop.example']:
    file = Path(env_path)
    text = file.read_text()
    if 'AUTONOMY_MINIMUM_GPS_SATELLITES=' not in text:
        text += '\n# Pad-transfer GPS quality gates\nAUTONOMY_MINIMUM_GPS_SATELLITES=6\nAUTONOMY_GPS_TIMEOUT_MS=3000\n'
        file.write_text(text)

# Regression coverage for settings and physical telemetry defaults.
replace_once('src/autonomy.test.ts', "      maximumFlightSeconds: 10_000,\n", "      maximumFlightSeconds: 10_000,\n      minimumGpsSatellites: 100,\n      gpsTimeoutMs: 50_000,\n")
replace_once('src/autonomy.test.ts', "    expect(settings.maximumFlightSeconds).toBe(300);\n", "    expect(settings.maximumFlightSeconds).toBe(300);\n    expect(settings.minimumGpsSatellites).toBe(20);\n    expect(settings.gpsTimeoutMs).toBe(10_000);\n")
replace_once('src/drone-adapters.test.ts', "    expect(snapshot.telemetry.altitude).toBe(2.4);\n", "    expect(snapshot.telemetry.altitude).toBe(2.4);\n    expect(snapshot.telemetry.gpsUpdatedAt).toBeNull();\n")

# Remove this migration and its workflow from the final changeset.
Path('scripts/apply-dashboard-cleanup.py').unlink(missing_ok=True)
Path('.github/workflows/apply-dashboard-cleanup.yml').unlink(missing_ok=True)
