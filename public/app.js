const socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
const keys = new Set();
const heldControls = new Set();
const flightKeys = new Set(['w', 's', 'a', 'd', 'q', 'e', 'r', 'f']);
let pilot = false;
let lastState;
let safetyStatus;
let videoHealth;
let videoAttached = false;

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

socket.addEventListener('open', () => updateControlAvailability());
socket.addEventListener('close', () => {
  pilot = false;
  clearControlState();
  $('pilot-status').textContent = 'Connection closed';
  updateControlAvailability();
  renderSafety();
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
  $('command').textContent = `roll ${command.roll}  pitch ${command.pitch}  yaw ${command.yaw}  gaz ${command.gaz}`;
  return command;
}

function clearControlState() {
  keys.clear();
  heldControls.clear();
  commandFromControls();
}

function sendCurrentCommand() {
  if (pilot) send({ type: 'pilot.command', command: commandFromControls() });
}

function requestStop() {
  clearControlState();
  if (pilot) send({ type: 'pilot.stop' });
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
  keys.add(key);
  sendCurrentCommand();
});

addEventListener('keyup', (event) => {
  const key = event.key.toLowerCase();
  if (!flightKeys.has(key)) return;
  keys.delete(key);
  sendCurrentCommand();
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
    sendCurrentCommand();
  };

  button.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    button.setPointerCapture(event.pointerId);
    heldControls.add(control);
    sendCurrentCommand();
  });
  button.addEventListener('pointerup', release);
  button.addEventListener('pointercancel', release);
  button.addEventListener('lostpointercapture', release);
});

setInterval(() => {
  if (pilot) sendCurrentCommand();
  render();
  renderSafety();
}, 50);

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
