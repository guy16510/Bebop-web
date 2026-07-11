const socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
const keys = new Set();
let pilot = false;
let lastState;

const $ = (id) => document.getElementById(id);
const send = (message) => socket.readyState === WebSocket.OPEN && socket.send(JSON.stringify(message));

socket.addEventListener('message', (event) => {
  const message = JSON.parse(event.data);
  if (message.type === 'state') {
    lastState = message.state;
    render();
  }
  if (message.type === 'pilot.granted') {
    pilot = true;
    $('pilot-status').textContent = 'Controls acquired';
  }
  if (message.type === 'pilot.denied') $('message').textContent = 'Another browser owns controls';
  if (message.type === 'error') $('message').textContent = message.message;
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
    const actions = {
      connect: { type: 'drone.connect' },
      acquire: { type: 'pilot.acquire' },
      takeoff: { type: 'drone.takeoff' },
      land: { type: 'drone.land' },
      emergency: { type: 'drone.emergency' },
    };
    send(actions[button.dataset.action]);
  });
});
