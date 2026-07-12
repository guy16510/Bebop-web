const mainPort = Number(location.port || (location.protocol === 'https:' ? 443 : 80));
const configuredPort = Number(localStorage.getItem('bebop.autonomyPort') || mainPort + 1);
const autonomyOrigin = `${location.protocol}//${location.hostname}:${configuredPort}`;
const autonomyWsUrl = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.hostname}:${configuredPort}/ws`;
let autonomySocket;
let reconnectTimer;
let lastStatus;
let saving = false;

function $(id) {
  return document.getElementById(id);
}

function injectAutonomyDashboard() {
  if ($('autonomy-card')) return;
  const css = document.createElement('link');
  css.rel = 'stylesheet';
  css.href = '/autonomy.css';
  document.head.append(css);

  const card = document.createElement('article');
  card.id = 'autonomy-card';
  card.className = 'autonomy-card';
  card.innerHTML = `
    <div class="autonomy-heading">
      <div>
        <h2>Autonomous flight</h2>
        <p>Closed-loop takeoff altitude, hover or yaw survey, fail-safe landing, and persisted mission limits. Metric XY route following remains locked because monocular SLAM does not provide reliable scale.</p>
      </div>
      <span id="autonomy-stage" class="status status-warning">connecting</span>
    </div>
    <div id="autonomy-banner" class="autonomy-banner" role="status">Connecting to the autonomy service on port ${configuredPort}.</div>
    <form id="autonomy-form">
      <div class="autonomy-toggle-grid">
        <label class="feature-toggle autonomy-master"><span><strong>Enable autonomy</strong><small>Master gate. This does not automatically start a mission.</small></span><input id="autonomy-enabled" type="checkbox" /></label>
        <label class="feature-toggle autonomy-physical"><span><strong>Allow physical flight</strong><small>Simulation is allowed by default. Physical Bebop flight requires this persistent gate and typed confirmation for every launch.</small></span><input id="autonomy-physical" type="checkbox" /></label>
        <label class="feature-toggle"><span><strong>Require live video</strong><small>Block takeoff unless decoded video is running.</small></span><input id="autonomy-require-video" type="checkbox" /></label>
        <label class="feature-toggle"><span><strong>Require SLAM tracking</strong><small>Block takeoff and land if tracking remains lost for two seconds.</small></span><input id="autonomy-require-perception" type="checkbox" /></label>
      </div>
      <div class="autonomy-settings-grid">
        <label>Mission pattern<select id="autonomy-pattern"><option value="hover">Hover only</option><option value="yaw-scan">Hover + yaw scan</option></select></label>
        <label>Target altitude, m<input id="autonomy-target-altitude" type="number" min="0.5" max="10" step="0.1" /></label>
        <label>Autonomy ceiling, m<input id="autonomy-max-altitude" type="number" min="0.5" max="10" step="0.1" /></label>
        <label>Command strength, %<input id="autonomy-command" type="number" min="5" max="20" step="1" /></label>
        <label>Minimum takeoff battery, %<input id="autonomy-min-battery" type="number" min="20" max="100" step="1" /></label>
        <label>Landing reserve, %<input id="autonomy-reserve-battery" type="number" min="10" max="99" step="1" /></label>
        <label>Minimum signal, dBm<input id="autonomy-min-signal" type="number" min="-95" max="-35" step="1" /></label>
        <label>Telemetry timeout, ms<input id="autonomy-telemetry-timeout" type="number" min="500" max="5000" step="100" /></label>
        <label>Hover time, seconds<input id="autonomy-hover-seconds" type="number" min="2" max="60" step="1" /></label>
        <label>Yaw scan time, seconds<input id="autonomy-yaw-seconds" type="number" min="2" max="45" step="1" /></label>
        <label>Maximum flight time, seconds<input id="autonomy-max-seconds" type="number" min="20" max="300" step="5" /></label>
      </div>
      <div class="autonomy-save-row">
        <button id="autonomy-save" type="submit">Save mission settings</button>
        <span id="autonomy-revision">revision 0</span>
      </div>
    </form>
    <div class="autonomy-runtime-grid">
      <div><span>Mode</span><strong id="autonomy-mode">--</strong></div>
      <div><span>Control link</span><strong id="autonomy-link">--</strong></div>
      <div><span>Mission</span><strong id="autonomy-mission">--</strong></div>
      <div><span>Deadline</span><strong id="autonomy-deadline">--</strong></div>
    </div>
    <div class="autonomy-preflight">
      <h3>Preflight gates</h3>
      <ul id="autonomy-readiness"></ul>
    </div>
    <div class="autonomy-launch-row">
      <label class="autonomy-confirm">Physical-flight confirmation<input id="autonomy-confirmation" type="text" autocomplete="off" placeholder="START AUTONOMOUS FLIGHT" /></label>
      <button id="autonomy-start" type="button" class="primary">Start autonomous mission</button>
      <button id="autonomy-abort" type="button" class="land">Abort and land</button>
      <button id="autonomy-land" type="button">Land now</button>
      <button id="autonomy-emergency" type="button" class="danger">Emergency, cut motors</button>
    </div>
    <p id="autonomy-error" class="autonomy-error" hidden></p>
  `;

  const grid = document.querySelector('.grid');
  const featureCard = document.querySelector('.feature-card');
  if (grid && featureCard) featureCard.insertAdjacentElement('afterend', card);
  else grid?.prepend(card);

  bindAutonomyControls();
}

function settingValue(id) {
  const element = $(id);
  return element?.type === 'checkbox' ? element.checked : Number(element?.value);
}

function collectSettings() {
  return {
    enabled: settingValue('autonomy-enabled'),
    allowPhysicalFlight: settingValue('autonomy-physical'),
    requireVideo: settingValue('autonomy-require-video'),
    requirePerceptionTracking: settingValue('autonomy-require-perception'),
    minimumBatteryPercent: settingValue('autonomy-min-battery'),
    reserveBatteryPercent: settingValue('autonomy-reserve-battery'),
    minimumSignalRssi: settingValue('autonomy-min-signal'),
    targetAltitudeMeters: settingValue('autonomy-target-altitude'),
    maximumAltitudeMeters: settingValue('autonomy-max-altitude'),
    maximumFlightSeconds: settingValue('autonomy-max-seconds'),
    telemetryTimeoutMs: settingValue('autonomy-telemetry-timeout'),
    commandPercent: settingValue('autonomy-command'),
    pattern: $('autonomy-pattern').value,
    hoverSeconds: settingValue('autonomy-hover-seconds'),
    yawScanSeconds: settingValue('autonomy-yaw-seconds'),
  };
}

function populateSettings(settings) {
  $('autonomy-enabled').checked = settings.enabled;
  $('autonomy-physical').checked = settings.allowPhysicalFlight;
  $('autonomy-require-video').checked = settings.requireVideo;
  $('autonomy-require-perception').checked = settings.requirePerceptionTracking;
  $('autonomy-min-battery').value = settings.minimumBatteryPercent;
  $('autonomy-reserve-battery').value = settings.reserveBatteryPercent;
  $('autonomy-min-signal').value = settings.minimumSignalRssi;
  $('autonomy-target-altitude').value = settings.targetAltitudeMeters;
  $('autonomy-max-altitude').value = settings.maximumAltitudeMeters;
  $('autonomy-max-seconds').value = settings.maximumFlightSeconds;
  $('autonomy-telemetry-timeout').value = settings.telemetryTimeoutMs;
  $('autonomy-command').value = settings.commandPercent;
  $('autonomy-pattern').value = settings.pattern;
  $('autonomy-hover-seconds').value = settings.hoverSeconds;
  $('autonomy-yaw-seconds').value = settings.yawScanSeconds;
}

function durationUntil(timestamp) {
  if (!timestamp) return '--';
  const seconds = Math.max(0, Math.ceil((timestamp - Date.now()) / 1000));
  return `${seconds}s`;
}

function renderAutonomy() {
  if (!lastStatus) return;
  const active = lastStatus.active;
  const settings = lastStatus.settings.settings;
  const stage = lastStatus.stage;
  const stageElement = $('autonomy-stage');
  stageElement.textContent = stage;
  stageElement.className = `status ${['idle', 'completed'].includes(stage) ? 'status-ready' : ['fault', 'aborted'].includes(stage) ? 'status-blocked' : 'status-warning'}`;

  if (!saving && !active) populateSettings(settings);
  $('autonomy-revision').textContent = `revision ${lastStatus.settings.revision}, ${lastStatus.settings.updatedBy}`;
  $('autonomy-mode').textContent = lastStatus.mode;
  $('autonomy-link').textContent = lastStatus.controlLink;
  $('autonomy-mission').textContent = lastStatus.missionId ? `#${lastStatus.missionId}` : 'not started';
  $('autonomy-deadline').textContent = active ? durationUntil(lastStatus.deadlineAt) : '--';

  const readiness = $('autonomy-readiness');
  readiness.replaceChildren(...lastStatus.readiness.map((check) => {
    const item = document.createElement('li');
    item.className = check.ok ? 'ready' : 'blocked';
    item.innerHTML = `<span aria-hidden="true">${check.ok ? '✓' : '×'}</span><strong></strong><small></small>`;
    item.querySelector('strong').textContent = check.label;
    item.querySelector('small').textContent = check.detail;
    return item;
  }));

  document.querySelectorAll('#autonomy-form input, #autonomy-form select, #autonomy-save').forEach((element) => {
    element.disabled = active || saving;
  });
  $('autonomy-start').disabled = active || lastStatus.readiness.some((check) => !check.ok);
  $('autonomy-abort').disabled = !active;
  $('autonomy-land').disabled = lastStatus.telemetry?.flyingState === 'landed';
  $('autonomy-emergency').disabled = lastStatus.controlLink !== 'connected';
  $('autonomy-confirmation').disabled = active || lastStatus.mode !== 'bebop';

  const banner = $('autonomy-banner');
  banner.textContent = lastStatus.controlLink === 'connected'
    ? `Autonomy service online. Settings persist in .bebop/autonomy.json. Current mode: ${lastStatus.mode}.`
    : `Autonomy service unavailable on port ${configuredPort}. npm run dev starts it automatically.`;
  banner.className = `autonomy-banner ${lastStatus.controlLink === 'connected' ? 'ready' : 'blocked'}`;

  const error = $('autonomy-error');
  error.textContent = lastStatus.lastError || lastStatus.abortReason || '';
  error.hidden = !error.textContent;
}

async function request(path, options = {}) {
  const response = await fetch(`${autonomyOrigin}${path}`, {
    method: options.method || 'GET',
    headers: { 'content-type': 'application/json' },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const payload = await response.json();
  if (payload.status) lastStatus = payload.status;
  else if (!payload.error) lastStatus = payload;
  renderAutonomy();
  if (!response.ok) throw new Error(payload.error || `Request failed with ${response.status}`);
  return payload;
}

function showError(error) {
  const message = error instanceof Error ? error.message : String(error);
  $('autonomy-error').textContent = message;
  $('autonomy-error').hidden = false;
}

function bindAutonomyControls() {
  $('autonomy-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    saving = true;
    renderAutonomy();
    try {
      await request('/api/autonomy/settings', { method: 'POST', body: collectSettings() });
    } catch (error) {
      showError(error);
    } finally {
      saving = false;
      renderAutonomy();
    }
  });

  $('autonomy-start').addEventListener('click', async () => {
    try {
      await request('/api/autonomy/start', {
        method: 'POST',
        body: { confirmation: $('autonomy-confirmation').value.trim() },
      });
      $('autonomy-confirmation').value = '';
    } catch (error) {
      showError(error);
    }
  });
  $('autonomy-abort').addEventListener('click', () => request('/api/autonomy/abort', { method: 'POST', body: {} }).catch(showError));
  $('autonomy-land').addEventListener('click', () => request('/api/autonomy/land', { method: 'POST', body: {} }).catch(showError));
  $('autonomy-emergency').addEventListener('click', () => {
    if (!confirm('Emergency cuts the motors immediately. Continue?')) return;
    request('/api/autonomy/emergency', { method: 'POST', body: {} }).catch(showError);
  });
}

function connectAutonomySocket() {
  clearTimeout(reconnectTimer);
  autonomySocket = new WebSocket(autonomyWsUrl);
  autonomySocket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.type === 'autonomy.status') {
      lastStatus = message.status;
      renderAutonomy();
    }
  });
  autonomySocket.addEventListener('open', () => request('/api/autonomy').catch(showError));
  autonomySocket.addEventListener('close', () => {
    if (lastStatus) {
      lastStatus.controlLink = 'disconnected';
      renderAutonomy();
    }
    reconnectTimer = setTimeout(connectAutonomySocket, 1_000);
  });
  autonomySocket.addEventListener('error', () => autonomySocket.close());
}

injectAutonomyDashboard();
connectAutonomySocket();
setInterval(renderAutonomy, 1_000);
