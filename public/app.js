const socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
const keys = new Set();
const heldControls = new Set();
let pilot = false;
let lastState;
let safetyStatus;
let videoHealth;
let videoAttached = false;

const $ = (id) => document.getElementById(id);
const send = (message) => socket.readyState === WebSocket.OPEN && socket.send(JSON.stringify(message));

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
  }
  if (message.type === 'pilot.denied') $('message').textContent = 'Another browser owns controls';
  if (message.type === 'error') $('message').textContent = message.message;
});

socket.addEventListener('close', () => {
  pilot = false;
  keys.clear();
  $('pilot-status').textContent = 'Connection closed';
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
  $('takeoff-button').disabled = !safetyStatus.takeoffAllowed;

  if (safetyStatus.armedUntil) {
    const remaining = Math.max(0, safetyStatus.armedUntil - Date.now());
    $('arm-expires').textContent = `${(remaining / 1000).toFixed(1)} s`;
  } else {
    $('arm-expires').textContent = '--';
  }

  const warnings = $('safety-warnings');
  warnings.replaceChildren(...safetyStatus.warnings.map((warning) => {
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

function commandFromKeys() {
  const amount = 30;
  const command = {
    pitch: ((keys.has('w') || heldControls.has('forward')) ? amount : 0) + ((keys.has('s') || heldControls.has('backward')) ? -amount : 0),
    roll: ((keys.has('d') || heldControls.has('right')) ? amount : 0) + ((keys.has('a') || heldControls.has('left')) ? -amount : 0),
    yaw: ((keys.has('e') || heldControls.has('yaw-right')) ? amount : 0) + ((keys.has('q') || heldControls.has('yaw-left')) ? -amount : 0),
    gaz: ((keys.has('r') || heldControls.has('up')) ? amount : 0) + ((keys.has('f') || heldControls.has('down')) ? -amount : 0),
    active: keys.size > 0 || heldControls.size > 0,
  };
  $('command').textContent = `roll ${command.roll}  pitch ${command.pitch}  yaw ${command.yaw}  gaz ${command.gaz}`;
  return command;
}

addEventListener('keydown', (event) => {
  if (event.target.matches('input, textarea, button')) return;
  if (event.code === 'Space') {
    event.preventDefault();
    keys.clear();
  } else keys.add(event.key.toLowerCase());
});
addEventListener('keyup', (event) => keys.delete(event.key.toLowerCase()));
addEventListener('blur', () => keys.clear());
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    keys.clear();
    heldControls.clear();
  }
});

document.querySelectorAll('[data-control]').forEach((button) => {
  const control = button.dataset.control;
  if (control === 'stop') {
    button.addEventListener('click', () => {
      keys.clear();
      heldControls.clear();
      if (pilot) send({ type: 'pilot.command', command: commandFromKeys() });
    });
    return;
  }

  const release = () => heldControls.delete(control);
  button.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    button.setPointerCapture(event.pointerId);
    heldControls.add(control);
  });
  button.addEventListener('pointerup', release);
  button.addEventListener('pointercancel', release);
  button.addEventListener('lostpointercapture', release);
});

setInterval(() => {
  if (pilot) send({ type: 'pilot.command', command: commandFromKeys() });
  render();
  renderSafety();
}, 50);

document.querySelectorAll('[data-action]').forEach((button) => {
  button.addEventListener('click', () => {
    $('message').textContent = '';
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
    const action = actions[button.dataset.action];
    if (action) send(action);
  });
});
