const METERS_TO_FEET = 3.28084;
const blockedFlightKeys = new Set(['w', 's', 'a', 'd', 'q', 'e', 'r']);
let altitudeRestricted = false;

const $ = (id) => document.getElementById(id);
const socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);

function formatMeters(value, digits = 1) {
  return `${value.toFixed(digits)} m`;
}

function formatFeet(value, digits = 0) {
  return `${(value * METERS_TO_FEET).toFixed(digits)} ft`;
}

function releaseUnsafeInputs() {
  for (const key of blockedFlightKeys) {
    window.dispatchEvent(new KeyboardEvent('keyup', { key, bubbles: true }));
  }

  document.querySelectorAll('[data-control].is-active:not([data-control="down"])').forEach((button) => {
    const event = typeof PointerEvent === 'function'
      ? new PointerEvent('pointercancel', { bubbles: true })
      : new Event('pointercancel', { bubbles: true });
    button.dispatchEvent(event);
  });
}

function renderAltitude(status) {
  const altitude = Number(status.altitudeMeters);
  const limit = Number(status.maximumAltitudeMeters);
  const remaining = Number(status.altitudeRemainingMeters);
  if (![altitude, limit, remaining].every(Number.isFinite)) return;

  $('height-feet').textContent = formatFeet(altitude);
  $('altitude-limit').textContent = `${formatMeters(limit, 0)} / ${formatFeet(limit)}`;
  $('altitude-remaining').textContent = `${formatMeters(remaining)} / ${formatFeet(remaining)}`;

  const meter = $('altitude-meter');
  meter.max = limit;
  meter.value = Math.min(altitude, limit);

  const mode = $('altitude-mode');
  mode.textContent = status.altitudeRestricted ? 'DESCEND ONLY' : 'Normal';
  mode.classList.toggle('altitude-mode-restricted', status.altitudeRestricted);

  const wasRestricted = altitudeRestricted;
  altitudeRestricted = Boolean(status.altitudeRestricted);
  document.documentElement.classList.toggle('altitude-restricted', altitudeRestricted);

  document.querySelectorAll('[data-control]').forEach((button) => {
    const control = button.dataset.control;
    const blocked = altitudeRestricted && !['down', 'stop'].includes(control);
    button.setAttribute('aria-disabled', blocked ? 'true' : 'false');
  });

  if (altitudeRestricted && !wasRestricted) releaseUnsafeInputs();
}

socket.addEventListener('message', (event) => {
  const message = JSON.parse(event.data);
  if (message.type === 'safety.status') renderAltitude(message.status);
});

socket.addEventListener('close', () => {
  $('altitude-mode').textContent = 'Unavailable';
});

window.addEventListener('keydown', (event) => {
  if (!altitudeRestricted) return;
  const key = event.key.toLowerCase();
  if (!blockedFlightKeys.has(key)) return;
  event.preventDefault();
  event.stopImmediatePropagation();
}, true);

document.addEventListener('pointerdown', (event) => {
  if (!altitudeRestricted || !(event.target instanceof Element)) return;
  const button = event.target.closest('[data-control]');
  if (!button || ['down', 'stop'].includes(button.dataset.control)) return;
  event.preventDefault();
  event.stopImmediatePropagation();
}, true);
