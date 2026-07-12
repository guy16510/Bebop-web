const socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
const keys = new Set();
const heldControls = new Set();
const flightKeys = new Set(['w', 's', 'a', 'd', 'q', 'e', 'r', 'f']);
const controlKeyMap = new Map([
  ['forward', 'w'],
  ['backward', 's'],
  ['left', 'a'],
  ['right', 'd'],
  ['yaw-left', 'q'],
  ['yaw-right', 'e'],
  ['up', 'r'],
  ['down', 'f'],
]);
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
let commandAmount = 20;

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
    clearControlState();
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
  if (message.type === 'error') {
    $('message').textContent = message.message;
    updateControlAvailability();
  }
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
  $('connection').classList.toggle('state-connected', lastState.connectionState === 'connected');
  $('connection').classList.toggle('state-disconnected', lastState.connectionState !== 'connected');
  $('battery').textContent = `${telemetry.battery.toFixed(0)}%`;
  renderSignal(telemetry.signalRssi);
  $('altitude').textContent = `${telemetry.altitude.toFixed(2)} m`;
  $('flight-state').textContent = telemetry.flyingState;
  $('telemetry-age').textContent = `${Date.now() - telemetry.updatedAt} ms`;
  updateControlAvailability();
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
  if (!safetyStatus) {
    updateControlAvailability();
    return;
  }
  $('armed').textContent = safetyStatus.armed ? 'Yes' : 'No';
  $('controls-allowed').textContent = safetyStatus.controlAllowed ? 'Yes' : 'No';
  $('takeoff-allowed').textContent = safetyStatus.takeoffAllowed ? 'Yes' : 'No';

  if (!safetyStatus.controlAllowed && (keys.size > 0 || heldControls.size > 0)) requestStop();

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
  updateControlAvailability();
}

function renderVideo() {
  if (!videoHealth) {
    updateControlAvailability();
    return;
  }
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
  updateControlAvailability();
}

function commandFromControls() {
  const command = {
    pitch: ((keys.has('w') || heldControls.has('forward')) ? commandAmount : 0)
      + ((keys.has('s') || heldControls.has('backward')) ? -commandAmount : 0),
    roll: ((keys.has('d') || heldControls.has('right')) ? commandAmount : 0)
      + ((keys.has('a') || heldControls.has('left')) ? -commandAmount : 0),
    yaw: ((keys.has('e') || heldControls.has('yaw-right')) ? commandAmount : 0)
      + ((keys.has('q') || heldControls.has('yaw-left')) ? -commandAmount : 0),
    gaz: ((keys.has('r') || heldControls.has('up')) ? commandAmount : 0)
      + ((keys.has('f') || heldControls.has('down')) ? -commandAmount : 0),
  };
  command.active = command.roll !== 0 || command.pitch !== 0 || command.yaw !== 0 || command.gaz !== 0;
  $('command').textContent = formatCommand(command);
  renderActiveControls();
  return command;
}

function formatCommand(command) {
  return `roll ${command.roll}  pitch ${command.pitch}  yaw ${command.yaw}  gaz ${command.gaz}`;
}

function renderActiveControls() {
  document.querySelectorAll('[data-control]').forEach((button) => {
    const control = button.dataset.control;
    const key = controlKeyMap.get(control);
    const active = control !== 'stop' && (heldControls.has(control) || (key && keys.has(key)));
    button.classList.toggle('is-active', Boolean(active));
    if (control !== 'stop') button.setAttribute('aria-pressed', active ? 'true' : 'false');
  });
  const strength = $('control-strength');
  if (strength) strength.disabled = keys.size > 0 || heldControls.size > 0;
}

function clearControlState() {
  keys.clear();
  heldControls.clear();
  commandFromControls();
}

function sendTracked(message, sequence) {
  pendingControls.set(sequence, performance.now());
  if (send(message)) return true;
  pendingControls.delete(sequence);
  return false;
}

function sendCurrentCommand(track = false) {
  if (!pilot) return;
  const command = commandFromControls();
  if (!track) {
    send({ type: 'pilot.command', command });
    return;
  }

  const sequence = ++controlSequence;
  sendTracked({ type: 'pilot.command', sequence, command }, sequence);
}

function requestStop() {
  clearControlState();
  if (!pilot) return;
  const sequence = ++controlSequence;
  sendTracked({ type: 'pilot.stop', sequence }, sequence);
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
  updateControlAvailability();
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
  if (!message.accepted) $('message').textContent = 'Command blocked by the safety controller';
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

function setActionDisabled(actionName, disabled) {
  document.querySelectorAll(`[data-action="${actionName}"]`).forEach((button) => {
    button.disabled = disabled;
  });
}

function setControlAvailabilityStatus(socketOpen, connected, movementAllowed) {
  const status = $('control-availability');
  if (!status) return;
  status.classList.remove('status-ready', 'status-warning', 'status-blocked');

  if (!socketOpen) {
    status.textContent = 'Control link unavailable';
    status.classList.add('status-blocked');
  } else if (!pilot) {
    status.textContent = 'Acquire controls to enable movement';
    status.classList.add('status-warning');
  } else if (!connected) {
    status.textContent = 'Controls owned, connect the drone';
    status.classList.add('status-warning');
  } else if (!movementAllowed) {
    status.textContent = 'Movement locked by telemetry or safety state';
    status.classList.add('status-blocked');
  } else {
    status.textContent = 'Movement controls ready';
    status.classList.add('status-ready');
  }
}

function updateControlAvailability() {
  const socketOpen = socket.readyState === WebSocket.OPEN;
  const connectionState = lastState?.connectionState ?? 'disconnected';
  const connected = connectionState === 'connected';
  const flyingState = lastState?.telemetry?.flyingState;
  const movementAllowed = socketOpen && pilot && Boolean(safetyStatus?.controlAllowed);
  const videoState = videoHealth?.state ?? 'disabled';

  document.querySelectorAll('[data-control]').forEach((button) => {
    const isStop = button.dataset.control === 'stop';
    button.disabled = isStop ? !(socketOpen && pilot) : !movementAllowed;
  });

  setActionDisabled('connect', !socketOpen || ['connected', 'connecting'].includes(connectionState));
  setActionDisabled('disconnect', !socketOpen || connectionState === 'disconnected');
  setActionDisabled('acquire', !socketOpen || pilot);
  setActionDisabled('release', !socketOpen || !pilot);
  setActionDisabled(
    'arm',
    !socketOpen
      || !pilot
      || !connected
      || !safetyStatus?.telemetryFresh
      || safetyStatus?.armed
      || flyingState !== 'landed',
  );
  setActionDisabled('disarm', !socketOpen || !safetyStatus?.armed);
  setActionDisabled('takeoff', !socketOpen || !pilot || !safetyStatus?.takeoffAllowed);
  setActionDisabled('land', !socketOpen || !connected || ['landed', 'landing'].includes(flyingState));
  setActionDisabled('emergency', !socketOpen || !connected);
  setActionDisabled('video-start', !socketOpen || !connected || ['starting', 'running'].includes(videoState));
  setActionDisabled('video-stop', !socketOpen || videoState === 'disabled');

  const latencyButton = $('run-latency-test');
  if (latencyButton) latencyButton.disabled = !socketOpen || latencyTestRemaining > 0;
  setControlAvailabilityStatus(socketOpen, connected, movementAllowed);
  renderActiveControls();
}

addEventListener('keydown', (event) => {
  if (event.code === 'Space' || event.key === 'Escape') {
    event.preventDefault();
    requestStop();
    return;
  }
  if (event.target instanceof Element && event.target.matches('input, textarea, button, select')) return;

  const key = event.key.toLowerCase();
  if (!flightKeys.has(key) || !pilot || !safetyStatus?.controlAllowed) return;
  event.preventDefault();
  if (keys.has(key)) return;
  keys.add(key);
  sendCurrentCommand(true);
});

addEventListener('keyup', (event) => {
  const key = event.key.toLowerCase();
  if (!flightKeys.has(key)) return;
  if (!keys.delete(key)) return;
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

const strengthInput = $('control-strength');
const strengthOutput = $('control-strength-value');
function updateStrength() {
  commandAmount = Math.max(5, Math.min(35, Number(strengthInput?.value ?? 20)));
  if (strengthInput) strengthInput.value = String(commandAmount);
  if (strengthOutput) strengthOutput.textContent = `${commandAmount}%`;
}
if (strengthInput) strengthInput.addEventListener('input', updateStrength);
updateStrength();

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
  updateControlAvailability();
  for (let index = 0; index < 20; index += 1) {
    setTimeout(() => sendPing(true), index * 75);
  }
});

document.querySelectorAll('[data-action]').forEach((button) => {
  button.addEventListener('click', () => {
    $('message').textContent = '';
    const actionName = button.dataset.action;
    if (['disconnect', 'release', 'disarm', 'land', 'emergency'].includes(actionName)) clearControlState();

    const actions = {
      connect: { type: 'drone.connect' },
      disconnect: { type: 'drone.disconnect' },
      acquire: { type: 'pilot.acquire' },
      release: { type: 'pilot.release' },
      arm: { type: 'drone.arm' },
      disarm: { type: 'drone.disarm' },
      takeoff: { type: 'drone.takeoff' },
      land: { type: 'drone.land' },
      emergency: { type: 'drone.emergency' },
      'video-start': { type: 'video.start' },
      'video-stop': { type: 'video.stop' },
    };
    const action = actions[actionName];
    if (action && send(action)) $('message').textContent = `${button.textContent.trim()} requested`;
  });
});

updateControlAvailability();
updateDiagnostics();
