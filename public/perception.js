const socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
const $ = (id) => document.getElementById(id);
let latestSnapshot;
let latestHealth;
let renderQueued = false;

function send(type) {
  if (socket.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify({ type }));
}

socket.addEventListener('message', (event) => {
  const message = JSON.parse(event.data);
  if (message.type !== 'perception.status') return;
  latestSnapshot = message.snapshot;
  latestHealth = message.health;
  queueRender();
});

socket.addEventListener('close', () => {
  $('perception-state').textContent = 'connection closed';
  $('perception-state').className = 'status status-blocked';
  setButtons(true);
});

for (const button of document.querySelectorAll('[data-perception-action]')) {
  button.addEventListener('click', () => send(`perception.${button.dataset.perceptionAction}`));
}

function queueRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    renderStatus();
    drawMap();
    drawDetections();
  });
}

function renderStatus() {
  if (!latestSnapshot || !latestHealth) return;
  const tracking = latestSnapshot.trackingState;
  $('perception-backend').textContent = `${latestHealth.backend} / ${latestSnapshot.source}`;
  $('perception-tracking').textContent = tracking;
  $('perception-scale').textContent = latestSnapshot.scaleSource;
  $('perception-fps').textContent = `${latestSnapshot.metrics.slamFps.toFixed(1)} SLAM / ${latestSnapshot.metrics.detectionFps.toFixed(1)} detect`;
  $('perception-latency').textContent = `${latestSnapshot.metrics.endToEndLatencyMs.toFixed(0)} ms`;
  $('perception-features').textContent = latestSnapshot.metrics.trackedFeatures.toLocaleString();
  $('perception-map-points').textContent = latestSnapshot.map.landmarks.length.toLocaleString();
  $('perception-objects').textContent = latestSnapshot.detections.length.toString();
  $('perception-keyframes').textContent = latestSnapshot.metrics.keyframes.toString();

  const status = $('perception-state');
  status.textContent = `${latestHealth.state}: ${tracking}`;
  status.className = 'status';
  if (tracking === 'tracking') status.classList.add('status-ready');
  else if (tracking === 'fault' || latestHealth.state === 'fault') status.classList.add('status-blocked');
  else status.classList.add('status-warning');

  const error = $('perception-error');
  error.textContent = latestHealth.lastError ?? '';
  error.hidden = !latestHealth.lastError;
  setButtons(latestHealth.backend === 'disabled');
  renderObjectList();
}

function setButtons(disabledBackend) {
  const running = latestHealth?.state === 'running' || latestHealth?.state === 'starting';
  const start = document.querySelector('[data-perception-action="start"]');
  const stop = document.querySelector('[data-perception-action="stop"]');
  const reset = document.querySelector('[data-perception-action="reset"]');
  start.disabled = disabledBackend || running || socket.readyState !== WebSocket.OPEN;
  stop.disabled = disabledBackend || !running || socket.readyState !== WebSocket.OPEN;
  reset.disabled = disabledBackend || socket.readyState !== WebSocket.OPEN;
}

function renderObjectList() {
  const list = $('recognized-objects');
  const rows = (latestSnapshot?.detections ?? []).map((detection) => {
    const item = document.createElement('li');
    const label = document.createElement('strong');
    label.textContent = detection.recognizedName ?? detection.label;
    const details = document.createElement('span');
    details.textContent = `${(detection.confidence * 100).toFixed(0)}% · ${detection.id}`;
    item.append(label, details);
    return item;
  });
  list.replaceChildren(...rows);
  $('recognized-empty').hidden = rows.length > 0;
}

function prepareCanvas(canvas) {
  const rect = canvas.getBoundingClientRect();
  const ratio = Math.max(1, window.devicePixelRatio || 1);
  const width = Math.max(1, Math.round(rect.width * ratio));
  const height = Math.max(1, Math.round(rect.height * ratio));
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  const context = canvas.getContext('2d');
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  return { context, width: rect.width, height: rect.height };
}

function drawMap() {
  const canvas = $('slam-map');
  const { context, width, height } = prepareCanvas(canvas);
  context.clearRect(0, 0, width, height);
  context.fillStyle = '#020617';
  context.fillRect(0, 0, width, height);
  drawGrid(context, width, height);
  if (!latestSnapshot) return;

  const bounds = latestSnapshot.map.bounds;
  const padding = 24;
  const project = (point) => ({
    x: padding + ((point.x - bounds.minX) / (bounds.maxX - bounds.minX)) * (width - padding * 2),
    y: height - padding - ((point.y - bounds.minY) / (bounds.maxY - bounds.minY)) * (height - padding * 2),
  });

  context.fillStyle = 'rgba(148, 163, 184, 0.55)';
  for (const landmark of latestSnapshot.map.landmarks) {
    const point = project(landmark.position);
    const radius = 1 + landmark.quality * 1.5;
    context.beginPath();
    context.arc(point.x, point.y, radius, 0, Math.PI * 2);
    context.fill();
  }

  const trajectory = latestSnapshot.trajectory;
  if (trajectory.length > 1) {
    context.strokeStyle = '#38bdf8';
    context.lineWidth = 2;
    context.beginPath();
    trajectory.forEach((pose, index) => {
      const point = project(pose);
      if (index === 0) context.moveTo(point.x, point.y);
      else context.lineTo(point.x, point.y);
    });
    context.stroke();
  }

  for (const detection of latestSnapshot.detections) {
    if (!detection.worldPosition) continue;
    const point = project(detection.worldPosition);
    context.fillStyle = '#f59e0b';
    context.beginPath();
    context.arc(point.x, point.y, 5, 0, Math.PI * 2);
    context.fill();
    context.fillStyle = '#fde68a';
    context.font = '12px system-ui';
    context.fillText(detection.recognizedName ?? detection.label, point.x + 8, point.y - 7);
  }

  if (latestSnapshot.pose) drawDrone(context, project(latestSnapshot.pose), latestSnapshot.pose.yaw);
  context.fillStyle = '#94a3b8';
  context.font = '12px system-ui';
  context.fillText('Top-down metric map, meters', 12, 18);
}

function drawGrid(context, width, height) {
  context.strokeStyle = 'rgba(51, 65, 85, 0.55)';
  context.lineWidth = 1;
  for (let x = 0; x <= width; x += 40) {
    context.beginPath();
    context.moveTo(x, 0);
    context.lineTo(x, height);
    context.stroke();
  }
  for (let y = 0; y <= height; y += 40) {
    context.beginPath();
    context.moveTo(0, y);
    context.lineTo(width, y);
    context.stroke();
  }
}

function drawDrone(context, point, yaw) {
  context.save();
  context.translate(point.x, point.y);
  context.rotate(-yaw);
  context.fillStyle = '#22c55e';
  context.beginPath();
  context.moveTo(13, 0);
  context.lineTo(-9, -8);
  context.lineTo(-5, 0);
  context.lineTo(-9, 8);
  context.closePath();
  context.fill();
  context.restore();
}

function drawDetections() {
  const canvas = $('detection-overlay');
  const { context, width, height } = prepareCanvas(canvas);
  context.clearRect(0, 0, width, height);
  if (!latestSnapshot || latestSnapshot.trackingState !== 'tracking') return;

  for (const detection of latestSnapshot.detections) {
    const box = detection.bbox;
    const x = box.x * width;
    const y = box.y * height;
    const boxWidth = box.width * width;
    const boxHeight = box.height * height;
    const text = `${detection.recognizedName ?? detection.label} ${(detection.confidence * 100).toFixed(0)}%`;
    context.strokeStyle = '#22c55e';
    context.lineWidth = 2;
    context.strokeRect(x, y, boxWidth, boxHeight);
    context.font = 'bold 12px system-ui';
    const textWidth = context.measureText(text).width + 10;
    context.fillStyle = 'rgba(5, 46, 22, 0.9)';
    context.fillRect(x, Math.max(0, y - 22), textWidth, 22);
    context.fillStyle = '#bbf7d0';
    context.fillText(text, x + 5, Math.max(15, y - 7));
  }
}

window.addEventListener('resize', queueRender);
setButtons(false);
queueRender();
