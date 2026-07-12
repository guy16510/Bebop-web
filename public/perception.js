const socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
const $ = (id) => document.getElementById(id);
const SVG_NS = 'http://www.w3.org/2000/svg';
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
    slamMap.render(latestSnapshot);
    drawDetections();
  });
}

function mapUnitInfo(snapshot) {
  const metric = snapshot?.scaleSource === 'telemetry' || snapshot?.scaleSource === 'imu';
  return metric
    ? { suffix: 'm', description: `${snapshot.scaleSource} metric scale` }
    : { suffix: 'u', description: 'monocular relative scale' };
}

function renderStatus() {
  if (!latestSnapshot || !latestHealth) return;
  const tracking = latestSnapshot.trackingState;
  $('perception-backend').textContent = `${latestHealth.backend} / ${latestSnapshot.source}`;
  $('perception-tracking').textContent = tracking;
  $('perception-scale').textContent = mapUnitInfo(latestSnapshot).description;
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
    const mapState = detection.worldPosition ? 'mapped' : 'image only';
    details.textContent = `${(detection.confidence * 100).toFixed(0)}% · ${mapState} · ${detection.id}`;
    item.append(label, details);
    return item;
  });
  list.replaceChildren(...rows);
  $('recognized-empty').hidden = rows.length > 0;
}

function svgElement(name, className) {
  const element = document.createElementNS(SVG_NS, name);
  if (className) element.setAttribute('class', className);
  return element;
}

function niceStep(span, targetLines = 10) {
  if (!Number.isFinite(span) || span <= 0) return 1;
  const rough = span / targetLines;
  const power = 10 ** Math.floor(Math.log10(rough));
  const normalized = rough / power;
  if (normalized <= 1) return power;
  if (normalized <= 2) return power * 2;
  if (normalized <= 5) return power * 5;
  return power * 10;
}

class InteractiveSlamMap {
  constructor(svg) {
    this.svg = svg;
    this.background = svgElement('rect', 'slam-map-background');
    this.viewport = svgElement('g', 'slam-map-viewport');
    this.grid = svgElement('g', 'slam-map-grid');
    this.landmarks = svgElement('path', 'slam-landmark');
    this.trajectory = svgElement('path', 'slam-trajectory');
    this.start = svgElement('circle', 'slam-trajectory-start');
    this.objects = svgElement('g', 'slam-objects');
    this.navigationPadsLayer = svgElement('g', 'slam-navigation-pads');
    this.drone = svgElement('g', 'slam-drone-group');
    this.droneHeading = svgElement('line', 'slam-drone-heading');
    this.droneShape = svgElement('path', 'slam-drone');
    this.empty = svgElement('text', 'slam-map-empty');
    this.empty.textContent = 'Waiting for SLAM landmarks and pose';
    this.droneHeading.setAttribute('x1', '0');
    this.droneHeading.setAttribute('y1', '0');
    this.droneHeading.setAttribute('x2', '28');
    this.droneHeading.setAttribute('y2', '0');
    this.droneShape.setAttribute('d', 'M 13 0 L -9 -8 L -5 0 L -9 8 Z');
    this.drone.append(this.droneHeading, this.droneShape);
    this.viewport.append(
      this.grid,
      this.landmarks,
      this.trajectory,
      this.start,
      this.objects,
      this.navigationPadsLayer,
      this.drone,
    );
    svg.replaceChildren(this.background, this.viewport, this.empty);

    this.scale = 1;
    this.translateX = 0;
    this.translateY = 0;
    this.following = true;
    this.dragging = false;
    this.dragOrigin = null;
    this.layers = { landmarks: true, trajectory: true, objects: true };
    this.width = 1;
    this.height = 1;
    this.project = null;
    this.projectedLandmarks = [];
    this.projectedObjects = [];
    this.navigationPads = [];
    this.lastSnapshot = null;
    this.bindEvents();
  }

  bindEvents() {
    this.svg.addEventListener('wheel', (event) => {
      event.preventDefault();
      this.following = false;
      this.updateFollowButton();
      const point = this.localPoint(event);
      const factor = Math.exp(-event.deltaY * 0.0015);
      const nextScale = Math.min(20, Math.max(0.35, this.scale * factor));
      this.translateX = point.x - ((point.x - this.translateX) * nextScale) / this.scale;
      this.translateY = point.y - ((point.y - this.translateY) * nextScale) / this.scale;
      this.scale = nextScale;
      this.applyTransform();
    }, { passive: false });

    this.svg.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      this.following = false;
      this.updateFollowButton();
      this.dragging = true;
      this.dragOrigin = { x: event.clientX, y: event.clientY, tx: this.translateX, ty: this.translateY };
      this.svg.classList.add('is-panning');
      this.svg.setPointerCapture(event.pointerId);
      this.hideTooltip();
    });

    this.svg.addEventListener('pointermove', (event) => {
      if (this.dragging && this.dragOrigin) {
        this.translateX = this.dragOrigin.tx + event.clientX - this.dragOrigin.x;
        this.translateY = this.dragOrigin.ty + event.clientY - this.dragOrigin.y;
        this.applyTransform();
        return;
      }
      this.updateTooltip(event);
    });

    const stopDragging = (event) => {
      this.dragging = false;
      this.dragOrigin = null;
      this.svg.classList.remove('is-panning');
      if (this.svg.hasPointerCapture(event.pointerId)) this.svg.releasePointerCapture(event.pointerId);
    };
    this.svg.addEventListener('pointerup', stopDragging);
    this.svg.addEventListener('pointercancel', stopDragging);
    this.svg.addEventListener('pointerleave', () => this.hideTooltip());
    this.svg.addEventListener('dblclick', () => this.fit());

    $('map-fit').addEventListener('click', () => this.fit());
    $('map-follow').addEventListener('click', () => {
      this.following = !this.following;
      this.updateFollowButton();
      this.render(this.lastSnapshot);
    });
    $('map-export').addEventListener('click', () => this.exportSnapshot());
    for (const input of document.querySelectorAll('[data-map-layer]')) {
      input.addEventListener('change', () => {
        this.layers[input.dataset.mapLayer] = input.checked;
        this.applyLayerVisibility();
      });
    }
  }

  localPoint(event) {
    const rect = this.svg.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  fit() {
    this.following = false;
    this.scale = 1;
    this.translateX = 0;
    this.translateY = 0;
    this.updateFollowButton();
    this.applyTransform();
  }

  updateFollowButton() {
    const button = $('map-follow');
    button.setAttribute('aria-pressed', String(this.following));
    button.textContent = this.following ? 'Following drone' : 'Follow drone';
  }

  applyTransform() {
    this.viewport.setAttribute('transform', `translate(${this.translateX} ${this.translateY}) scale(${this.scale})`);
    $('map-zoom').textContent = `${Math.round(this.scale * 100)}%`;
  }

  applyLayerVisibility() {
    this.landmarks.style.display = this.layers.landmarks ? '' : 'none';
    this.trajectory.style.display = this.layers.trajectory ? '' : 'none';
    this.start.style.display = this.layers.trajectory ? '' : 'none';
    this.objects.style.display = this.layers.objects ? '' : 'none';
  }

  setNavigationPads(pads) {
    this.navigationPads = Array.isArray(pads) ? pads : [];
    this.renderNavigationPads();
  }

  render(snapshot) {
    this.lastSnapshot = snapshot;
    const rect = this.svg.getBoundingClientRect();
    this.width = Math.max(1, rect.width);
    this.height = Math.max(1, rect.height);
    this.svg.setAttribute('viewBox', `0 0 ${this.width} ${this.height}`);
    this.background.setAttribute('width', String(this.width));
    this.background.setAttribute('height', String(this.height));
    this.empty.setAttribute('x', String(this.width / 2));
    this.empty.setAttribute('y', String(this.height / 2));

    if (!snapshot) {
      this.empty.style.display = '';
      this.viewport.style.display = 'none';
      return;
    }
    this.empty.style.display = 'none';
    this.viewport.style.display = '';

    const bounds = snapshot.map.bounds;
    const padding = 34;
    const spanX = Math.max(0.001, bounds.maxX - bounds.minX);
    const spanY = Math.max(0.001, bounds.maxY - bounds.minY);
    const usableWidth = Math.max(1, this.width - padding * 2);
    const usableHeight = Math.max(1, this.height - padding * 2);
    const fitScale = Math.min(usableWidth / spanX, usableHeight / spanY);
    const contentWidth = spanX * fitScale;
    const contentHeight = spanY * fitScale;
    const left = (this.width - contentWidth) / 2;
    const top = (this.height - contentHeight) / 2;
    this.project = (point) => ({
      x: left + (point.x - bounds.minX) * fitScale,
      y: top + (bounds.maxY - point.y) * fitScale,
    });

    this.renderGrid(bounds, fitScale, left, top);
    this.renderLandmarks(snapshot.map.landmarks);
    this.renderTrajectory(snapshot.trajectory);
    this.renderObjects(snapshot.detections);
    this.renderNavigationPads();
    this.renderDrone(snapshot.pose);
    this.applyLayerVisibility();

    if (this.following && snapshot.pose) {
      const point = this.project(snapshot.pose);
      this.translateX = this.width / 2 - point.x * this.scale;
      this.translateY = this.height / 2 - point.y * this.scale;
    }
    this.applyTransform();
  }

  renderGrid(bounds, fitScale, left, top) {
    this.grid.replaceChildren();
    const unit = mapUnitInfo(this.lastSnapshot);
    const step = niceStep(Math.max(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY));
    const xStart = Math.ceil(bounds.minX / step) * step;
    const yStart = Math.ceil(bounds.minY / step) * step;
    for (let x = xStart; x <= bounds.maxX + step * 0.001; x += step) {
      const start = this.project({ x, y: bounds.minY });
      const end = this.project({ x, y: bounds.maxY });
      const line = svgElement('line');
      line.setAttribute('x1', String(start.x));
      line.setAttribute('y1', String(start.y));
      line.setAttribute('x2', String(end.x));
      line.setAttribute('y2', String(end.y));
      this.grid.append(line);
      const label = svgElement('text');
      label.setAttribute('x', String(start.x + 3 / Math.max(1, this.scale)));
      label.setAttribute('y', String(top + 12 / Math.max(1, this.scale)));
      label.textContent = `${Number(x.toFixed(2))}${unit.suffix}`;
      this.grid.append(label);
    }
    for (let y = yStart; y <= bounds.maxY + step * 0.001; y += step) {
      const start = this.project({ x: bounds.minX, y });
      const end = this.project({ x: bounds.maxX, y });
      const line = svgElement('line');
      line.setAttribute('x1', String(start.x));
      line.setAttribute('y1', String(start.y));
      line.setAttribute('x2', String(end.x));
      line.setAttribute('y2', String(end.y));
      this.grid.append(line);
      const label = svgElement('text');
      label.setAttribute('x', String(left + 4 / Math.max(1, this.scale)));
      label.setAttribute('y', String(start.y - 4 / Math.max(1, this.scale)));
      label.textContent = `${Number(y.toFixed(2))}${unit.suffix}`;
      this.grid.append(label);
    }
    this.grid.dataset.unitsPerPixel = String(1 / fitScale);
    this.grid.dataset.unit = unit.suffix;
  }

  renderLandmarks(landmarks) {
    const maxRendered = 2500;
    const selected = landmarks.length <= maxRendered
      ? landmarks
      : [...landmarks].sort((a, b) => b.quality - a.quality).slice(0, maxRendered);
    this.projectedLandmarks = selected.map((landmark) => ({ ...this.project(landmark.position), landmark }));
    const path = this.projectedLandmarks.map(({ x, y }) => `M${x.toFixed(2)},${y.toFixed(2)}h0`).join('');
    this.landmarks.setAttribute('d', path);
    this.landmarks.setAttribute('fill', 'none');
    this.landmarks.setAttribute('stroke', '#94a3b8');
    this.landmarks.setAttribute('stroke-width', '3');
    this.landmarks.setAttribute('stroke-linecap', 'round');
  }

  renderTrajectory(trajectory) {
    if (trajectory.length === 0) {
      this.trajectory.removeAttribute('d');
      this.start.style.display = 'none';
      return;
    }
    const points = trajectory.map((pose) => this.project(pose));
    this.trajectory.setAttribute('d', points.map((point, index) => `${index === 0 ? 'M' : 'L'}${point.x.toFixed(2)},${point.y.toFixed(2)}`).join(' '));
    this.start.setAttribute('cx', String(points[0].x));
    this.start.setAttribute('cy', String(points[0].y));
    this.start.setAttribute('r', '4');
    this.start.style.display = this.layers.trajectory ? '' : 'none';
  }

  renderObjects(detections) {
    const mapped = detections.filter((detection) => detection.worldPosition);
    this.projectedObjects = mapped.map((detection) => ({ ...this.project(detection.worldPosition), detection }));
    const groups = this.projectedObjects.map(({ x, y, detection }) => {
      const group = svgElement('g', 'slam-object');
      group.setAttribute('transform', `translate(${x} ${y})`);
      const circle = svgElement('circle');
      circle.setAttribute('r', '6');
      const text = svgElement('text');
      text.setAttribute('x', '9');
      text.setAttribute('y', '-8');
      text.textContent = detection.recognizedName ?? detection.label;
      group.append(circle, text);
      return group;
    });
    this.objects.replaceChildren(...groups);
  }

  renderNavigationPads() {
    if (!this.project) {
      this.navigationPadsLayer.replaceChildren();
      return;
    }
    const groups = this.navigationPads
      .filter((pad) => pad?.mapPosition)
      .map((pad) => {
        const point = this.project(pad.mapPosition);
        const group = svgElement('g', 'slam-navigation-pad');
        group.setAttribute('transform', `translate(${point.x} ${point.y})`);
        const ring = svgElement('circle');
        ring.setAttribute('r', '10');
        const center = svgElement('circle');
        center.setAttribute('r', '3');
        const text = svgElement('text');
        text.setAttribute('x', '13');
        text.setAttribute('y', '-9');
        text.textContent = `${pad.name}, tag ${pad.markerId}`;
        group.append(ring, center, text);
        return group;
      });
    this.navigationPadsLayer.replaceChildren(...groups);
  }

  renderDrone(pose) {
    if (!pose) {
      this.drone.style.display = 'none';
      return;
    }
    this.drone.style.display = '';
    const point = this.project(pose);
    const angle = (-pose.yaw * 180) / Math.PI;
    this.drone.setAttribute('transform', `translate(${point.x} ${point.y}) rotate(${angle})`);
  }

  updateTooltip(event) {
    if (!this.project || !this.lastSnapshot) return;
    const local = this.localPoint(event);
    const base = {
      x: (local.x - this.translateX) / this.scale,
      y: (local.y - this.translateY) / this.scale,
    };
    let best = null;
    const threshold = 12 / this.scale;
    for (const item of this.projectedObjects) {
      const distance = Math.hypot(item.x - base.x, item.y - base.y);
      if (distance <= threshold && (!best || distance < best.distance)) {
        best = {
          distance,
          text: `${item.detection.recognizedName ?? item.detection.label}\n${(item.detection.confidence * 100).toFixed(0)}% confidence\n${item.detection.id}`,
        };
      }
    }
    const unit = mapUnitInfo(this.lastSnapshot);
    for (const item of this.projectedLandmarks) {
      const distance = Math.hypot(item.x - base.x, item.y - base.y);
      if (distance <= threshold && (!best || distance < best.distance)) {
        const p = item.landmark.position;
        best = {
          distance,
          text: `Landmark ${item.landmark.id}\n${p.x.toFixed(2)}, ${p.y.toFixed(2)}, ${p.z.toFixed(2)} ${unit.suffix}\n${item.landmark.observations} observations`,
        };
      }
    }
    if (!best) {
      this.hideTooltip();
      return;
    }
    const tooltip = $('map-tooltip');
    const frame = this.svg.parentElement.getBoundingClientRect();
    tooltip.textContent = best.text;
    tooltip.style.whiteSpace = 'pre-line';
    tooltip.style.left = `${Math.min(frame.width - 180, local.x + 12)}px`;
    tooltip.style.top = `${Math.max(6, local.y - 12)}px`;
    tooltip.hidden = false;
  }

  hideTooltip() {
    $('map-tooltip').hidden = true;
  }

  exportSnapshot() {
    if (!this.lastSnapshot) return;
    const blob = new Blob([JSON.stringify(this.lastSnapshot, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `bebop-slam-map-${new Date().toISOString().replaceAll(':', '-')}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
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

const slamMap = new InteractiveSlamMap($('slam-map'));
globalThis.addEventListener('bebop-navigation-pads', (event) => {
  slamMap.setNavigationPads(event.detail);
});
window.addEventListener('resize', queueRender);
setButtons(false);
slamMap.updateFollowButton();
queueRender();
