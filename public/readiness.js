const LIMITS = {
  wsP95: { good: 50, warning: 100 },
  commandRtt: { good: 75, warning: 125 },
  stopRtt: { good: 75, warning: 125 },
  serverApply: { good: 5, warning: 15 },
};

const metricDefinitions = [
  { id: 'ws-p95', label: 'WebSocket p95', limits: LIMITS.wsP95 },
  { id: 'command-rtt', label: 'Command RTT', limits: LIMITS.commandRtt },
  { id: 'stop-rtt', label: 'STOP RTT', limits: LIMITS.stopRtt },
  { id: 'server-apply', label: 'Server apply time', limits: LIMITS.serverApply },
];

const readinessClasses = ['readiness-pending', 'readiness-good', 'readiness-warning', 'readiness-bad'];

function parseMilliseconds(element) {
  if (!element) return null;
  const value = Number.parseFloat(element.textContent ?? '');
  return Number.isFinite(value) ? value : null;
}

function classify(value, limits) {
  if (value === null) return 'pending';
  if (value <= limits.good) return 'good';
  if (value <= limits.warning) return 'warning';
  return 'bad';
}

function setReadinessClass(element, state) {
  if (!element) return;
  element.classList.remove(...readinessClasses);
  element.classList.add(`readiness-${state}`);
}

function setText(element, value) {
  if (element && element.textContent !== value) element.textContent = value;
}

function stopCommandIsNeutral() {
  const text = document.getElementById('server-command')?.textContent ?? '';
  return text.startsWith('accepted:')
    && text.includes('roll 0')
    && text.includes('pitch 0')
    && text.includes('yaw 0')
    && text.includes('gaz 0');
}

function updateReadiness() {
  const verdict = document.getElementById('control-readiness');
  const detail = document.getElementById('control-readiness-detail');
  if (!verdict || !detail) return;

  const results = metricDefinitions.map((definition) => {
    const element = document.getElementById(definition.id);
    const value = parseMilliseconds(element);
    const state = classify(value, definition.limits);
    setReadinessClass(element, state);
    return { ...definition, value, state };
  });

  const latencyTestComplete = (document.getElementById('latency-test-status')?.textContent ?? '')
    .includes('20-sample test complete');
  const missing = results.filter((result) => result.state === 'pending');
  const failed = results.filter((result) => result.state === 'bad');
  const warnings = results.filter((result) => result.state === 'warning');

  let state = 'pending';
  let headline = 'NOT READY';
  let message = 'Run the 20-sample test, exercise one direction, release it, then press STOP.';

  if (latencyTestComplete && missing.length === 0) {
    if (failed.length > 0) {
      state = 'bad';
      headline = 'NO-GO';
      message = `${failed.map((result) => result.label).join(', ')} exceeds the bench-test limit.`;
    } else if (!stopCommandIsNeutral()) {
      state = 'warning';
      headline = 'NOT READY';
      message = 'Latency is measured, but STOP has not yet been verified as an accepted all-zero command.';
    } else if (warnings.length > 0) {
      state = 'warning';
      headline = 'CAUTION';
      message = `${warnings.map((result) => result.label).join(', ')} is usable but not consistently low.`;
    } else {
      state = 'good';
      headline = 'SOFTWARE PATH READY';
      message = 'Latency and STOP meet the props-off bench thresholds. Continue with motor, Land, Emergency, and watchdog checks.';
    }
  }

  setText(verdict, headline);
  setText(detail, message);
  setReadinessClass(verdict, state);
}

setInterval(updateReadiness, 250);
updateReadiness();
