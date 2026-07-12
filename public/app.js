const socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
const keys = new Set();
const heldControls = new Set();
const flightKeys = new Set(['w', 's', 'a', 'd', 'q', 'e', 'r', 'f']);
const pendingControls = new Map();
const pendingPings = new Map();
const commandLatencies = [];
const pingLatencies = [];
let pilot = false;
let lastState;
let safetyStatus;
let videoHealth;
let videoAttached = false;
let controlSequence = 0;
let pingSequence = 0;
let lastCommandRtt = null;
let lastStopRtt = null;
let lastServerApplyMs = null;
let latencyTestRemaining = 0;

const $ = (id) => document.getElementById(id);
const send = (message) => {
  if (socket.readyState !== WebSocket.OPEN) return false;
  socket.send(JSON.stringify(message));
  return true;
};

socket.addEventListener('message', (event) => {
  const message = JSON.parse(event.data);
  if (message.type === 'state') {
    lastState = message.state;
    render();
  }
  if (message.type === 'safety.status') {
    safetyStatus = message.status;
    renderSafety();
  }
  if (message.type === 'video.health') {
    videoHealth = message.health;
    renderVideo();
  }
  if (message.type === 'diagnostic.pong') handlePong(message);
  if (message.type === 'pilot.ack') handlePilotAck(message);
  if (message.type === 'pilot.granted') {
    pilot = true;
    $('pilot-status').textContent = 'Controls acquired';
    $('message').textContent = '';
    updateControlAvailability();
    renderSafety();
  }
  if (message.type === 'pilot.released') {
    pilot = false;
    clearControlState();
    $('pilot-status').textContent = 'Controls released';
    updateControlAvailability();
    renderSafety();
  }
  if (message.type === 'pilot.stopped') $('message').textContent = 'Movement stopped';
  if (message.type === 'pilot.denied') {
    pilot = false;
    clearControlState();
    $('message').textContent = 'Another browser owns controls';
    updateControlAvailability();
    renderSafety();
  }
  if (message.type === 'error') $('message').textContent = message.message;
});

socket.addEventListener('open', () => {
  updateControlAvailability();
  sendPing();
});
socket.addEventListener('close', () => {
  pilot = false;
  clearControlState();
  pendingControls.clear();
  pendingPings.clear();
  $('pilot-status').textContent = 'Connection closed';
  updateControlAvailability();
  renderSafety();
  updateDiagnostics();
});

function render() {
  if (!lastState) return;
  const telemetry = lastState.telemetry;
  $('connection').textContent = lastState.connectionState;
  $('battery').textContent = `${telemetry.battery.toFixed(0)}%`;
  renderSignal(telemetry.signalRssi);
  $('altitude').textContent = `${telemetry.altitude.toFixed(2)} m`;
  $('flight-state').textContent = telemetry.flyingState;
  $('telemetry-age').textContent = `${Date.now() - telemetry.updatedAt} ms`;
}

function renderSignal(rssi) {
  const value = typeof rssi === 'number' ? rssi : null;
  const strength = value === null ? 0 : value >= -50 ? 4 : value >= -60 ? 3 : value >= -70 ? 2 : 1;
  $('signal').textContent = value === null ? '--' : `${value.toFixed(0)} dBm`;
  document.querySelectorAll('.signal-bars i').forEach((bar, index) => {
    bar.classList.toggle('active', index < strength);
  });
}

function renderSafety() {
  if (!safetyStatus) return;
  $('armed').textContent = safetyStatus.armed ? 'Yes' : 'No';
  $('controls-allowed').textContent = safetyStatus.controlAllowed ? 'Yes' : 'No';
  $('takeoff-allowed').textContent = safetyStatus.takeoffAllowed ? 'Yes' : 'No';
  $('takeoff-button').disabled = !pilot || !safetyStatus.takeoffAllowed;

  if (safetyStatus.armedUntil) {
    const remaining = Math.max(0, safetyStatus.armedUntil - Date.now());
    $('arm-expires').textContent = `${(remaining / 1000).toFixed(1)} s`;
  } else {
    $('arm-expires').textContent = '--';
  }

  const warnings = $('safety-warnings');
  warnings.replaceChildren(...(safetyStatus.warnings ?? []).map((warning) => {
    const item = document.createElement('li');
    item.textContent = warning;
    return item;
  }));
}

function renderVideo() {
  if (!videoHealth) return;
  $('video-state').textContent = videoHealth.state;
  $('video-fps').textContent = `${videoHealth.fps.toFixed(1)} fps`;
  $('video-drops').textContent = `${videoHealth.droppedFrames} dropped`;

  const running = videoHealth.state === 'running';
  $('video-placeholder').hidden = running;
  $('video-feed').hidden = !running;

  if (running && !videoAttached) {
    $('video-feed').src = `/video.mjpeg?ts=${Date.now()}`;
    videoAttached = true;
  }
  if (!running && videoAttached) {
    $('video-feed').removeAttribute('src');
    videoAttached = false;
  }

  if (videoHealth.lastError) $('message').textContent = videoHealth.lastError;
}

function commandFromControls() {
  const amount = 30;
  const command = {
    pitch: ((keys.has('w') || heldControls.has('forward')) ? amount : 0)
      + ((keys.has('s') || heldControls.has('backward')) ? -amount : 0),
    roll: ((keys.has('d') || heldControls.has('right')) ? amount : 0)
      + ((keys.has('a') || heldControls.has('left')) ? -amount : 0),
    yaw: ((keys.has('e') || heldControls.has('yaw-right')) ? amount : 0)
      + ((keys.has('q') || heldControls.has('yaw-left')) ? -amount : 0),
    gaz: ((keys.has('r') || heldControls.has('up')) ? amount : 0)
      + ((keys.has('f') || heldControls.has('down')) ? -amount : 0),
    active: keys.size > 0 || heldControls.size > 0,
  };
  $('command').textContent = formatCommand(command);
  return command;
}

function formatCommand(command) {
  return `roll ${command.roll}  pitch ${command.pitch}  yaw ${command.yaw}  gaz ${command.gaz}`;
}

function clearControlState() {
  keys.clear();
  heldControls.clear();
  commandFromControls();
}

function sendCurrentCommand(track = false) {
  if (!pilot) return;
  const command = commandFromControls();
  if (!track) {
    send({ type: 'pilot.command', command });
    return;
  }

  const sequence = ++controlSequence;
  pendingControls.set(sequence, performance.now());
  send({ type: 'pilot.command', sequence, command });
}

function requestStop() {
  clearControlState();
  if (!pilot) return;
  const sequence = ++controlSequence;
  pendingControls.set(sequence, performance.now());
  send({ type: 'pilot.stop', sequence });
}

function sendPing(isTest = false) {
  if (socket.readyState !== WebSocket.OPEN) return;
  const id = ++pingSequence;
  pendingPings.set(id, { startedAt: performance.now(), isTest });
  send({ type: 'diagnostic.ping', id });
}

function handlePong(message) {
  const pending = pendingPings.get(message.id);
  if (pending === undefined) return;
  pendingPings.delete(message.id);
  recordSample(pingLatencies, performance.now() - pending.startedAt);
  if (pending.isTest && latencyTestRemaining > 0) {
    latencyTestRemaining -= 1;
    $('latency-test-status').textContent = latencyTestRemaining === 0
      ? '20-sample test complete'
      : `${latencyTestRemaining} samples remaining`;
  }
  updateDiagnostics();
}

function handlePilotAck(message) {
  const startedAt = pendingControls.get(message.sequence);
  if (startedAt !== undefined) {
    pendingControls.delete(message.sequence);
    const rtt = performance.now() - startedAt;
    recordSample(commandLatencies, rtt);
    if (message.kind === 'stop') lastStopRtt = rtt;
    else lastCommandRtt = rtt;
  }

  lastServerApplyMs = Math.max(0, message.serverAppliedAt - message.serverReceivedAt);
  $('server-command').textContent = `${message.accepted ? 'accepted' : 'blocked'}: ${formatCommand(message.command)}`;
  updateDiagnostics();
}

function recordSample(samples, value) {
  samples.push(value);
  if (samples.length > 100) samples.shift();
}

function percentile(samples, ratio) {
  if (samples.length === 0) return null;
  const sorted = [...samples].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1);
  return sorted[Math.max(0, index)];
}

function displayMs(value) {
  return value === null ? '--' : `${value.toFixed(1)} ms`;
}

function updateDiagnostics() {
  $('ws-rtt').textContent = displayMs(pingLatencies.at(-1) ?? null);
  $('ws-p95').textContent = displayMs(percentile(pingLatencies, 0.95));
  $('command-rtt').textContent = displayMs(lastCommandRtt);
  $('stop-rtt').textContent = displayMs(lastStopRtt);
  $('server-apply').textContent = displayMs(lastServerApplyMs);
}

function updateControlAvailability() {
  document.querySelectorAll('[data-control]').forEach((button) => {
    button.disabled = !pilot;
  });
  const armButton = document.querySelector('[data-action="arm"]');
  if (armButton) armButton.disabled = !pilot;
  if (safetyStatus) $('takeoff-button').disabled = !pilot || !safetyStatus.takeoffAllowed;
}

addEventListener('keydown', (event) => {
  if (event.target instanceof Element && event.target.matches('input, textarea, button')) return;
  if (event.code === 'Space') {
    event.preventDefault();
    requestStop();
    return;
  }

  const key = event.key.toLowerCase();
  if (!flightKeys.has(key)) return;
  event.preventDefault();
  if (keys.has(key)) return;
  keys.add(key);
  sendCurrentCommand(true);
});

addEventListener('keyup', (event) => {
  const key = event.key.toLowerCase();
  if (!flightKeys.has(key)) return;
  keys.delete(key);
  sendCurrentCommand(true);
});
addEventListener('blur', requestStop);
addEventListener('pagehide', requestStop);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) requestStop();
});

document.querySelectorAll('[data-control]').forEach((button) => {
  const control = button.dataset.control;
  if (control === 'stop') {
    button.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      requestStop();
    });
    return;
  }

  const release = () => {
    if (!heldControls.delete(control)) return;
    sendCurrentCommand(true);
  };

  button.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    button.setPointerCapture(event.pointerId);
    heldControls.add(control);
    sendCurrentCommand(true);
  });
  button.addEventListener('pointerup', release);
  button.addEventListener('pointercancel', release);
  button.addEventListener('lostpointercapture', release);
});

setInterval(() => {
  if (pilot) sendCurrentCommand(false);
  render();
  renderSafety();
}, 50);

setInterval(sendPing, 1000);

$('run-latency-test').addEventListener('click', () => {
  pingLatencies.length = 0;
  pendingPings.clear();
  latencyTestRemaining = 20;
  $('latency-test-status').textContent = '20 samples remaining';
  for (let index = 0; index < 20; index += 1) {
    setTimeout(() => sendPing(true), index * 75);
  }
});

document.querySelectorAll('[data-action]').forEach((button) => {
  button.addEventListener('click', () => {
    $('message').textContent = '';
    const actionName = button.dataset.action;
    if (['disconnect', 'disarm', 'land', 'emergency'].includes(actionName)) clearControlState();

    const actions = {
      connect: { type: 'drone.connect' },
      disconnect: { type: 'drone.disconnect' },
      acquire: { type: 'pilot.acquire' },
      arm: { type: 'drone.arm' },
      disarm: { type: 'drone.disarm' },
      takeoff: { type: 'drone.takeoff' },
      land: { type: 'drone.land' },
      emergency: { type: 'drone.emergency' },
      'video-start': { type: 'video.start' },
      'video-stop': { type: 'video.stop' },
    };
    const action = actions[actionName];
    if (action) send(action);
  });
});

updateControlAvailability();
updateDiagnostics();
