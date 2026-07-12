import { autonomyOrigin } from './autonomy.js';

let lastStatus;
let saving = false;

const $ = (id) => document.getElementById(id);

function injectNavigationDashboard() {
  if ($('navigation-card')) return;
  const css = document.createElement('link');
  css.rel = 'stylesheet';
  css.href = '/navigation.css';
  document.head.append(css);

  const card = document.createElement('article');
  card.id = 'navigation-card';
  card.className = 'navigation-card';
  card.innerHTML = `
    <details>
      <summary class="dashboard-summary navigation-heading">
        <span><strong>Navigation and landing-pad setup</strong><small>Configure range sensors, named pads, object rules, and precision landing.</small></span>
        <span id="navigation-state" class="status status-warning">waiting</span>
      </summary>
      <div class="details-body">

    <section class="navigation-section">
      <h3>Obstacle avoidance</h3>
      <form id="navigation-settings-form" class="navigation-settings-grid">
        <label class="feature-toggle"><span><strong>Enable avoidance</strong><small>Filter autonomous translation through fresh range sectors.</small></span><input id="navigation-avoidance" type="checkbox" /></label>
        <label class="feature-toggle"><span><strong>Require metric range</strong><small>Block movement instead of guessing distance from a monocular image.</small></span><input id="navigation-require-range" type="checkbox" /></label>
        <label>Hard stop, m<input id="navigation-stop-distance" type="number" min="0.25" max="10" step="0.05" /></label>
        <label>Caution distance, m<input id="navigation-caution-distance" type="number" min="0.35" max="20" step="0.05" /></label>
        <label>Range timeout, ms<input id="navigation-range-timeout" type="number" min="100" max="5000" step="50" /></label>
        <label>Cruise command, %<input id="navigation-cruise-command" type="number" min="5" max="20" step="1" /></label>
        <label>Avoidance yaw, %<input id="navigation-avoidance-yaw" type="number" min="5" max="20" step="1" /></label>
        <label>Landing command, %<input id="navigation-landing-command" type="number" min="3" max="15" step="1" /></label>
        <label>Landing descent, %<input id="navigation-descent-command" type="number" min="3" max="12" step="1" /></label>
        <label>Final-land altitude, m<input id="navigation-final-altitude" type="number" min="0.2" max="1.5" step="0.05" /></label>
        <label>Marker alignment tolerance<input id="navigation-alignment" type="number" min="0.02" max="0.25" step="0.01" /></label>
        <label>Camera landing tilt<input id="navigation-camera-tilt" type="number" min="-100" max="100" step="1" /></label>
        <button type="submit">Save navigation limits</button>
      </form>
      <div class="range-panel">
        <div><span>Source</span><strong id="range-source">--</strong></div>
        <div><span>Fresh</span><strong id="range-fresh">No</strong></div>
        <div><span>Front left</span><strong id="range-front-left">--</strong></div>
        <div><span>Front</span><strong id="range-front">--</strong></div>
        <div><span>Front right</span><strong id="range-front-right">--</strong></div>
        <div><span>Left</span><strong id="range-left">--</strong></div>
        <div><span>Right</span><strong id="range-right">--</strong></div>
        <div><span>Rear</span><strong id="range-rear">--</strong></div>
        <div><span>Down</span><strong id="range-down">--</strong></div>
      </div>
      <p class="navigation-note">Range sensors post to <code>/api/navigation/ranges</code> on the autonomy port. The server stops autonomous translation when required data becomes stale.</p>
    </section>

    <section class="navigation-section navigation-two-column">
      <div>
        <h3>Named landing pads</h3>
        <form id="landing-pad-form" class="navigation-form">
          <label>ID<input id="pad-id" required placeholder="garage-pad" /></label>
          <label>Name<input id="pad-name" required placeholder="Garage pad" /></label>
          <label>AprilTag ID<input id="pad-marker" type="number" min="0" max="4096" required value="7" /></label>
          <label>Printed tag size, m<input id="pad-size" type="number" min="0.05" max="3" step="0.01" required value="0.30" /></label>
          <label>Latitude<input id="pad-latitude" type="number" min="-90" max="90" step="0.000001" /></label>
          <label>Longitude<input id="pad-longitude" type="number" min="-180" max="180" step="0.000001" /></label>
          <label>Approach altitude, m<input id="pad-approach" type="number" min="0.5" max="10" step="0.1" value="1.5" /></label>
          <label>GPS arrival radius, m<input id="pad-radius" type="number" min="0.3" max="10" step="0.1" value="1.5" /></label>
          <div class="navigation-button-row">
            <button id="pad-capture-gps" type="button">Use current GPS</button>
            <button id="pad-capture-map" type="button">Use current map pose</button>
            <button type="submit" class="primary">Save pad</button>
          </div>
          <p id="pad-map-position" class="navigation-note">No map position captured.</p>
        </form>
        <ul id="landing-pad-list" class="navigation-list"></ul>
      </div>
      <div>
        <h3>Object definitions</h3>
        <form id="semantic-object-form" class="navigation-form">
          <label>ID<input id="object-id" required placeholder="tool-cart" /></label>
          <label>Name<input id="object-name" required placeholder="Red tool cart" /></label>
          <label>YOLO labels, comma-separated<input id="object-labels" placeholder="chair, suitcase" /></label>
          <label>AprilTag IDs, comma-separated<input id="object-markers" placeholder="21" /></label>
          <label>Behavior<select id="object-behavior"><option value="obstacle">Obstacle</option><option value="landmark">Landmark</option><option value="landing-pad">Landing pad</option><option value="ignore">Ignore</option></select></label>
          <label>Clearance, m<input id="object-clearance" type="number" min="0" max="20" step="0.1" value="1.5" /></label>
          <label>Notes<textarea id="object-notes" rows="2"></textarea></label>
          <button type="submit" class="primary">Save object definition</button>
        </form>
        <ul id="semantic-object-list" class="navigation-list"></ul>
      </div>
    </section>

    <section class="navigation-section">
      <h3>Currently recognized</h3>
      <ul id="semantic-observations" class="navigation-list"></ul>
      <p class="navigation-note">Map positions are useful labels and visualization anchors. They are not used as physical meters while SLAM reports monocular scale. Different-pad physical flight requires GPS now, or a future metric VIO/UWB source indoors.</p>
    </section>
    <p id="navigation-error" class="autonomy-error" hidden></p>
      </div>
    </details>
  `;

  const autonomyCard = $('autonomy-card');
  if (autonomyCard) autonomyCard.insertAdjacentElement('afterend', card);
  else document.querySelector('.grid')?.prepend(card);
  bindControls();
}

function numberValue(id) {
  return Number($(id).value);
}

function commaStrings(value) {
  return [...new Set(value.split(',').map((item) => item.trim().toLowerCase()).filter(Boolean))];
}

function commaNumbers(value) {
  return [...new Set(value.split(',').map((item) => Number(item.trim())).filter((item) => Number.isInteger(item) && item >= 0))];
}

async function request(path, options = {}) {
  const response = await fetch(`${autonomyOrigin}${path}`, {
    method: options.method || 'GET',
    headers: { 'content-type': 'application/json' },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const payload = await response.json();
  if (payload.status) lastStatus = payload.status;
  else if (payload.navigation) lastStatus = payload;
  render();
  if (!response.ok) throw new Error(payload.error || `Request failed with ${response.status}`);
  return payload;
}

function showError(error) {
  const element = $('navigation-error');
  element.textContent = error instanceof Error ? error.message : String(error);
  element.hidden = false;
}

function rangeText(range, name) {
  const value = range?.sectors?.[name]?.distanceMeters;
  return typeof value === 'number' ? `${value.toFixed(2)} m` : '--';
}

function populateSettings(settings) {
  $('navigation-avoidance').checked = settings.obstacleAvoidanceEnabled;
  $('navigation-require-range').checked = settings.requireMetricRange;
  $('navigation-stop-distance').value = settings.stopDistanceMeters;
  $('navigation-caution-distance').value = settings.cautionDistanceMeters;
  $('navigation-range-timeout').value = settings.rangeTimeoutMs;
  $('navigation-cruise-command').value = settings.cruiseCommandPercent;
  $('navigation-avoidance-yaw').value = settings.avoidanceYawPercent;
  $('navigation-landing-command').value = settings.landingCommandPercent;
  $('navigation-descent-command').value = settings.landingDescentPercent;
  $('navigation-final-altitude').value = settings.finalLandAltitudeMeters;
  $('navigation-alignment').value = settings.landingAlignmentTolerance;
  $('navigation-camera-tilt').value = settings.landingCameraTiltDegrees;
}

function deleteButton(label, handler) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'danger';
  button.textContent = label;
  button.addEventListener('click', handler);
  return button;
}

function renderPads(pads) {
  const list = $('landing-pad-list');
  if (!pads.length) {
    const empty = document.createElement('li');
    empty.textContent = 'No landing pads saved.';
    list.replaceChildren(empty);
    return;
  }
  list.replaceChildren(...pads.map((pad) => {
    const item = document.createElement('li');
    const detail = document.createElement('div');
    const gps = pad.gps ? `${pad.gps.latitude.toFixed(6)}, ${pad.gps.longitude.toFixed(6)}` : 'no GPS';
    const map = pad.mapPosition ? `map ${pad.mapPosition.x.toFixed(2)}, ${pad.mapPosition.y.toFixed(2)}` : 'no map anchor';
    detail.innerHTML = '<strong></strong><small></small>';
    detail.querySelector('strong').textContent = `${pad.name}, tag ${pad.markerId}`;
    detail.querySelector('small').textContent = `${gps}, ${map}`;
    item.append(detail, deleteButton('Delete', () => request(`/api/navigation/pads/${encodeURIComponent(pad.id)}`, { method: 'DELETE' }).catch(showError)));
    return item;
  }));
}

function renderObjects(objects) {
  const list = $('semantic-object-list');
  list.replaceChildren(...objects.map((object) => {
    const item = document.createElement('li');
    const detail = document.createElement('div');
    detail.innerHTML = '<strong></strong><small></small>';
    detail.querySelector('strong').textContent = `${object.name}, ${object.behavior}`;
    detail.querySelector('small').textContent = `labels: ${object.labels.join(', ') || 'none'}, tags: ${object.markerIds.join(', ') || 'none'}, clearance ${object.clearanceMeters} m`;
    item.append(detail, deleteButton('Delete', () => request(`/api/navigation/objects/${encodeURIComponent(object.id)}`, { method: 'DELETE' }).catch(showError)));
    return item;
  }));
}

function renderObservations(observations) {
  const list = $('semantic-observations');
  if (!observations.length) {
    const empty = document.createElement('li');
    empty.textContent = 'No current object or landing-pad observations.';
    list.replaceChildren(empty);
    return;
  }
  list.replaceChildren(...observations.map((observation) => {
    const item = document.createElement('li');
    const detail = document.createElement('div');
    detail.innerHTML = '<strong></strong><small></small>';
    detail.querySelector('strong').textContent = `${observation.name}, ${Math.round(observation.confidence * 100)}%`;
    detail.querySelector('small').textContent = `${observation.behavior}, track ${observation.trackId}${observation.markerId === null ? '' : `, AprilTag ${observation.markerId}`}`;
    item.append(detail);
    return item;
  }));
}

function render() {
  if (!lastStatus?.navigation) return;
  const navigation = lastStatus.navigation;
  const active = Boolean(lastStatus.active);
  $('navigation-state').textContent = navigation.rangeFresh ? 'range ready' : 'range unavailable';
  $('navigation-state').className = `status ${navigation.rangeFresh ? 'status-ready' : 'status-blocked'}`;
  if (!saving && !active) populateSettings(navigation.map.settings);

  $('range-source').textContent = navigation.rangeField?.source ?? '--';
  $('range-fresh').textContent = navigation.rangeFresh ? 'Yes' : 'No';
  $('range-front-left').textContent = rangeText(navigation.rangeField, 'frontLeft');
  $('range-front').textContent = rangeText(navigation.rangeField, 'front');
  $('range-front-right').textContent = rangeText(navigation.rangeField, 'frontRight');
  $('range-left').textContent = rangeText(navigation.rangeField, 'left');
  $('range-right').textContent = rangeText(navigation.rangeField, 'right');
  $('range-rear').textContent = rangeText(navigation.rangeField, 'rear');
  $('range-down').textContent = rangeText(navigation.rangeField, 'down');

  renderPads(navigation.map.landingPads);
  renderObjects(navigation.map.objects);
  renderObservations(navigation.semanticObservations);
  document.querySelectorAll('#navigation-card input, #navigation-card select, #navigation-card textarea, #navigation-card button').forEach((element) => {
    if (element.closest('.navigation-list')) element.disabled = active;
    else if (!['pad-capture-gps', 'pad-capture-map'].includes(element.id)) element.disabled = active || saving;
  });
}

function bindControls() {
  let capturedMapPosition;

  $('navigation-settings-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    saving = true;
    render();
    try {
      await request('/api/navigation/settings', {
        method: 'POST',
        body: {
          obstacleAvoidanceEnabled: $('navigation-avoidance').checked,
          requireMetricRange: $('navigation-require-range').checked,
          stopDistanceMeters: numberValue('navigation-stop-distance'),
          cautionDistanceMeters: numberValue('navigation-caution-distance'),
          rangeTimeoutMs: numberValue('navigation-range-timeout'),
          cruiseCommandPercent: numberValue('navigation-cruise-command'),
          avoidanceYawPercent: numberValue('navigation-avoidance-yaw'),
          landingCommandPercent: numberValue('navigation-landing-command'),
          landingDescentPercent: numberValue('navigation-descent-command'),
          finalLandAltitudeMeters: numberValue('navigation-final-altitude'),
          landingAlignmentTolerance: numberValue('navigation-alignment'),
          landingCameraTiltDegrees: numberValue('navigation-camera-tilt'),
        },
      });
    } catch (error) {
      showError(error);
    } finally {
      saving = false;
      render();
    }
  });

  $('pad-capture-gps').addEventListener('click', () => {
    const telemetry = lastStatus?.telemetry;
    if (typeof telemetry?.latitude !== 'number' || typeof telemetry?.longitude !== 'number') {
      showError(new Error('Current GPS coordinates are unavailable'));
      return;
    }
    $('pad-latitude').value = telemetry.latitude.toFixed(7);
    $('pad-longitude').value = telemetry.longitude.toFixed(7);
  });

  $('pad-capture-map').addEventListener('click', () => {
    const pose = lastStatus?.navigation?.perceptionPose;
    if (!pose) {
      showError(new Error('Current SLAM pose is unavailable'));
      return;
    }
    capturedMapPosition = { x: pose.x, y: pose.y, z: pose.z };
    $('pad-map-position').textContent = `Captured map pose ${pose.x.toFixed(2)}, ${pose.y.toFixed(2)}, ${pose.z.toFixed(2)} in ${lastStatus.navigation.scaleSource ?? 'unknown'} scale.`;
  });

  $('landing-pad-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const latitude = $('pad-latitude').value.trim();
    const longitude = $('pad-longitude').value.trim();
    const body = {
      id: $('pad-id').value,
      name: $('pad-name').value,
      markerId: numberValue('pad-marker'),
      markerSizeMeters: numberValue('pad-size'),
      approachAltitudeMeters: numberValue('pad-approach'),
      arrivalRadiusMeters: numberValue('pad-radius'),
      ...(capturedMapPosition ? { mapPosition: capturedMapPosition } : {}),
      ...(latitude && longitude ? { gps: { latitude: Number(latitude), longitude: Number(longitude) } } : {}),
    };
    try {
      await request('/api/navigation/pads', { method: 'POST', body });
      $('landing-pad-form').reset();
      $('pad-marker').value = '7';
      $('pad-size').value = '0.30';
      $('pad-approach').value = '1.5';
      $('pad-radius').value = '1.5';
      capturedMapPosition = undefined;
      $('pad-map-position').textContent = 'No map position captured.';
    } catch (error) {
      showError(error);
    }
  });

  $('semantic-object-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      await request('/api/navigation/objects', {
        method: 'POST',
        body: {
          id: $('object-id').value,
          name: $('object-name').value,
          labels: commaStrings($('object-labels').value),
          markerIds: commaNumbers($('object-markers').value),
          behavior: $('object-behavior').value,
          clearanceMeters: numberValue('object-clearance'),
          notes: $('object-notes').value,
        },
      });
      $('semantic-object-form').reset();
      $('object-clearance').value = '1.5';
    } catch (error) {
      showError(error);
    }
  });
}

globalThis.addEventListener('bebop-autonomy-status', (event) => {
  lastStatus = event.detail;
  render();
});

injectNavigationDashboard();
request('/api/autonomy').catch(showError);
setInterval(render, 1_000);
