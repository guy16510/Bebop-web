const recognitionOrigin = globalThis.location.origin;
let recognitionStatus = null;
let recognitionError = null;
let recognitionBusy = false;

function request(path, options = {}) {
  return fetch(`${recognitionOrigin}${path}`, {
    method: options.method ?? 'GET',
    headers: options.body ? { 'content-type': 'application/json' } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined,
  }).then(async (response) => {
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error ?? `${response.status} ${response.statusText}`);
    return payload;
  });
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function injectDashboard() {
  const grid = document.querySelector('.dashboard-grid');
  if (!grid || document.getElementById('recognition-card')) return;
  const article = document.createElement('article');
  article.id = 'recognition-card';
  article.className = 'recognition-card controls-card dashboard-collapsible';
  article.innerHTML = `
    <details>
      <summary class="dashboard-summary">
        <span><strong>Named object recognition</strong><small>Enroll specific objects, collect diverse views, and reject unknown matches.</small></span>
        <span id="recognition-state" class="status status-warning">stopped</span>
      </summary>
      <div class="details-body recognition-body">
        <p class="recognition-warning">Recognition adds names to stable tracks. It does not certify a clear path and never replaces metric obstacle range.</p>
        <div class="recognition-metrics" id="recognition-metrics"></div>
        <section><h3>Live tracks</h3><p id="recognition-live-empty">No appearance-enabled tracks are available.</p><div id="recognition-live" class="recognition-list"></div></section>
        <section><h3>Enrolled objects</h3><p id="recognition-enrolled-empty">No named objects enrolled.</p><div id="recognition-enrolled" class="recognition-list"></div></section>
        <p id="recognition-error" class="recognition-error" hidden></p>
      </div>
    </details>`;
  grid.append(article);
}

function percent(value) {
  return typeof value === 'number' && Number.isFinite(value) ? `${(value * 100).toFixed(1)}%` : '--';
}

function liveTrack(detection, objects) {
  const match = detection.recognition ?? {};
  const options = objects
    .filter((object) => object.labels.includes(detection.label))
    .map((object) => `<option value="${escapeHtml(object.id)}">${escapeHtml(object.name)}</option>`)
    .join('');
  const sample = options ? `<select data-recognition-object>${options}</select><button type="button" data-recognition-sample="${escapeHtml(detection.id)}">Add sample</button>` : '';
  return `<article class="recognition-item">
    <div><strong>${escapeHtml(detection.recognizedName ?? detection.label)}</strong>
      <small>${escapeHtml(detection.id)} · ${escapeHtml(detection.track?.state ?? 'unknown track')} · detector ${percent(detection.confidence)}</small>
      <small>recognition ${escapeHtml(match.state ?? 'unavailable')} · score ${percent(match.score)} · confirmations ${match.confirmations ?? 0}</small></div>
    <div class="recognition-actions"><button type="button" data-recognition-enroll="${escapeHtml(detection.id)}">Enroll as new object</button>${sample}</div>
  </article>`;
}

function enrolledObject(object, minimumSamples) {
  const ready = object.enabled && object.samples.length >= minimumSamples;
  return `<article class="recognition-item">
    <div><strong>${escapeHtml(object.name)}</strong>
      <small>${escapeHtml(object.labels.join(', '))} · ${object.samples.length} samples · threshold ${percent(object.threshold)}</small>
      <small>${ready ? 'eligible for recognition' : `needs ${Math.max(0, minimumSamples - object.samples.length)} more sample(s)`} · ${object.enabled ? 'enabled' : 'disabled'}</small></div>
    <div class="recognition-actions">
      <button type="button" data-recognition-toggle="${escapeHtml(object.id)}" data-enabled="${object.enabled}">${object.enabled ? 'Disable' : 'Enable'}</button>
      <button type="button" data-recognition-rename="${escapeHtml(object.id)}">Rename</button>
      <button type="button" class="danger" data-recognition-delete="${escapeHtml(object.id)}">Delete</button>
    </div>
  </article>`;
}

function render() {
  if (!recognitionStatus) return;
  const state = document.getElementById('recognition-state');
  const health = recognitionStatus.vision;
  state.textContent = health.state;
  state.className = `status ${health.state === 'running' ? 'status-ready' : health.state === 'fault' ? 'status-blocked' : 'status-warning'}`;

  const registry = recognitionStatus.registry;
  document.getElementById('recognition-metrics').innerHTML = `
    <span>input ${health.inputFps.toFixed(1)} fps</span><span>detection ${health.detectionFps.toFixed(1)} fps</span>
    <span>inference ${health.inferenceMs.toFixed(0)} ms</span><span>latency ${health.endToEndLatencyMs.toFixed(0)} ms</span>
    <span>${health.activeTracks} active tracks</span><span>${registry.metrics.confirmed} confirmed</span><span>${registry.metrics.unknown} unknown</span>`;

  const live = recognitionStatus.liveDetections ?? [];
  document.getElementById('recognition-live').innerHTML = live.map((item) => liveTrack(item, registry.objects)).join('');
  document.getElementById('recognition-live-empty').hidden = live.length > 0;
  document.getElementById('recognition-enrolled').innerHTML = registry.objects.map((item) => enrolledObject(item, registry.minimumSamples)).join('');
  document.getElementById('recognition-enrolled-empty').hidden = registry.objects.length > 0;

  const error = document.getElementById('recognition-error');
  const message = recognitionError ?? health.lastError;
  error.hidden = !message;
  error.textContent = message ?? '';
}

async function refresh() {
  try {
    recognitionStatus = await request('/api/recognition/status');
    recognitionError = null;
  } catch (error) {
    recognitionError = error.message;
  }
  render();
}

async function mutate(operation) {
  if (recognitionBusy) return;
  recognitionBusy = true;
  try {
    await operation();
    recognitionError = null;
    await refresh();
  } catch (error) {
    recognitionError = error.message;
    render();
  } finally {
    recognitionBusy = false;
  }
}

document.addEventListener('click', (event) => {
  const button = event.target.closest('button');
  if (!button) return;
  const enroll = button.dataset.recognitionEnroll;
  if (enroll) {
    const name = globalThis.prompt('Name this specific object');
    if (name?.trim()) void mutate(() => request('/api/recognition/objects', { method: 'POST', body: { name: name.trim(), trackId: enroll } }));
    return;
  }
  const sample = button.dataset.recognitionSample;
  if (sample) {
    const select = button.parentElement.querySelector('[data-recognition-object]');
    if (select?.value) void mutate(() => request(`/api/recognition/objects/${encodeURIComponent(select.value)}/samples`, { method: 'POST', body: { trackId: sample } }));
    return;
  }
  const toggle = button.dataset.recognitionToggle;
  if (toggle) {
    void mutate(() => request(`/api/recognition/objects/${encodeURIComponent(toggle)}`, { method: 'POST', body: { enabled: button.dataset.enabled !== 'true' } }));
    return;
  }
  const rename = button.dataset.recognitionRename;
  if (rename) {
    const current = recognitionStatus.registry.objects.find((object) => object.id === rename)?.name ?? '';
    const name = globalThis.prompt('New recognition name', current);
    if (name?.trim()) void mutate(() => request(`/api/recognition/objects/${encodeURIComponent(rename)}`, { method: 'POST', body: { name: name.trim() } }));
    return;
  }
  const remove = button.dataset.recognitionDelete;
  if (remove && globalThis.confirm('Delete this enrollment and all stored descriptors?')) {
    void mutate(() => request(`/api/recognition/objects/${encodeURIComponent(remove)}`, { method: 'DELETE' }));
  }
});

injectDashboard();
void refresh();
setInterval(refresh, 1_000);
