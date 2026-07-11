const socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
const keys = new Set();
let pilot = false;
let lastState;
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
  $('altitude').textContent = `${telemetry.altitude.toFixed(2)} m`;
  $('flight-state').textContent = telemetry.flyingState;
  $('telemetry-age').textContent = `${Date.now() - telemetry.updatedAt} ms`;
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
    pitch: (keys.has('w') ? amount : 0) + (keys.has('s') ? -amount : 0),
    roll: (keys.has('d') ? amount : 0) + (keys.has('a') ? -amount : 0),
    yaw: (keys.has('e') ? amount : 0) + (keys.has('q') ? -amount : 0),
    gaz: (keys.has('r') ? amount : 0) + (keys.has('f') ? -amount : 0),
    active: keys.size > 0,
  };
  $('command').textContent = `roll ${command.roll}  pitch ${command.pitch}  yaw ${command.yaw}  gaz ${command.gaz}`;
  return command;
}

addEventListener('keydown', (event) => {
  if (event.target.matches('input, textarea')) return;
  if (event.code === 'Space') {
    event.preventDefault();
    keys.clear();
  } else keys.add(event.key.toLowerCase());
});
addEventListener('keyup', (event) => keys.delete(event.key.toLowerCase()));
addEventListener('blur', () => keys.clear());
document.addEventListener('visibilitychange', () => { if (document.hidden) keys.clear(); });

setInterval(() => {
  if (pilot) send({ type: 'pilot.command', command: commandFromKeys() });
  render();
}, 50);

document.querySelectorAll('[data-action]').forEach((button) => {
  button.addEventListener('click', () => {
    $('message').textContent = '';
    const actions = {
      connect: { type: 'drone.connect' },
      disconnect: { type: 'drone.disconnect' },
      acquire: { type: 'pilot.acquire' },
      takeoff: { type: 'drone.takeoff' },
      land: { type: 'drone.land' },
      emergency: { type: 'drone.emergency' },
      'video-start': { type: 'video.start' },
      'video-stop': { type: 'video.stop' },
    };
    send(actions[button.dataset.action]);
  });
});
