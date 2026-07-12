const socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
const $ = (id) => document.getElementById(id);
let featureStatus;
let automationStatus;

function send(message) {
  if (socket.readyState !== WebSocket.OPEN) return false;
  socket.send(JSON.stringify(message));
  return true;
}

function applyVisibility(settings) {
  const overlay = $('detection-overlay');
  if (overlay) overlay.hidden = !settings.showDetections;

  const recognized = $('recognized-panel');
  if (recognized) recognized.hidden = !settings.showDetections;

  const map = document.querySelector('.map-column');
  if (map) map.hidden = !settings.showMap;

  const layout = document.querySelector('.perception-layout');
  if (layout) layout.classList.toggle('map-hidden', !settings.showMap);
}

function renderFeatures() {
  if (!featureStatus) return;
  const settings = featureStatus.settings;
  for (const input of document.querySelectorAll('[data-runtime-feature]')) {
    input.checked = Boolean(settings[input.dataset.runtimeFeature]);
    input.disabled = socket.readyState !== WebSocket.OPEN;
  }

  applyVisibility(settings);
  $('feature-revision').textContent = `revision ${featureStatus.revision}`;
  $('feature-updated-by').textContent = featureStatus.updatedBy;
  $('feature-mode').textContent = settings.perception
    ? 'SLAM + recognition enabled'
    : settings.video
      ? 'video only'
      : settings.autoConnect
        ? 'connection only'
        : 'manual';
  $('feature-mode').className = settings.perception
    ? 'status status-ready'
    : 'status status-warning';
}

function renderAutomation() {
  if (!automationStatus) return;
  $('automation-stage').textContent = automationStatus.stage;
  $('automation-attempts').textContent = String(automationStatus.attempts);
  $('automation-recoveries').textContent = String(automationStatus.recoveries);
  const error = $('automation-error');
  error.textContent = automationStatus.lastError ?? '';
  error.hidden = !automationStatus.lastError;
}

socket.addEventListener('open', () => {
  for (const input of document.querySelectorAll('[data-runtime-feature]')) input.disabled = false;
});

socket.addEventListener('message', (event) => {
  const message = JSON.parse(event.data);
  if (message.type === 'features.status') {
    featureStatus = message.status;
    renderFeatures();
  }
  if (message.type === 'automation.status') {
    automationStatus = message.status;
    renderAutomation();
  }
});

socket.addEventListener('close', () => {
  for (const input of document.querySelectorAll('[data-runtime-feature]')) input.disabled = true;
  $('feature-mode').textContent = 'control link closed';
  $('feature-mode').className = 'status status-blocked';
});

for (const input of document.querySelectorAll('[data-runtime-feature]')) {
  input.addEventListener('change', () => {
    const key = input.dataset.runtimeFeature;
    if (!send({ type: 'features.set', settings: { [key]: input.checked } })) {
      input.checked = !input.checked;
    }
  });
}

import('./pad-map-bridge.js')
  .then(() => import('./autonomy.js'))
  .then(() => import('./navigation.js'))
  .catch((error) => {
    const message = $('message');
    if (message) message.textContent = `Autonomy dashboard failed to load: ${error.message}`;
  });
