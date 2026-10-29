const state = { dashboard: null };
const elements = {
  summary: document.querySelector('#summary'),
  devices: document.querySelector('#devices'),
  integrations: document.querySelector('#integrations'),
  rules: document.querySelector('#rules'),
  age: document.querySelector('#snapshot-age'),
  deviceDialog: document.querySelector('#device-dialog'),
  ruleDialog: document.querySelector('#rule-dialog'),
  toast: document.querySelector('#toast'),
};

document.querySelectorAll('.nav-item').forEach((button) => {
  button.addEventListener('click', () => {
    document.querySelectorAll('.nav-item').forEach((item) => item.classList.toggle('active', item === button));
    document.querySelectorAll('.view').forEach((view) => view.classList.remove('active'));
    document.querySelector(`#${button.dataset.view}-view`).classList.add('active');
  });
});

document.querySelector('#refresh-button').addEventListener('click', loadDashboard);
document.querySelector('#new-rule-button').addEventListener('click', () => openRule());
document.querySelector('#device-form').addEventListener('submit', saveDevice);
document.querySelector('#rule-form').addEventListener('submit', saveRule);

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers ?? {}) },
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || `Erro HTTP ${response.status}`);
  }
  return response.status === 204 ? null : response.json();
}

async function loadDashboard() {
  const button = document.querySelector('#refresh-button');
  button.disabled = true;
  try {
    state.dashboard = await api('/api/dashboard');
    render();
  } catch (error) {
    showToast(error.message);
  } finally {
    button.disabled = false;
  }
}

function render() {
  const dashboard = state.dashboard;
  renderAge(dashboard);
  renderSummary(dashboard);
  renderDevices(dashboard.devices);
  renderIntegrations(dashboard.integrations);
  renderRules(dashboard.rules, dashboard.intentions, dashboard.devices);
}

function renderAge(dashboard) {
  const age = dashboard.snapshotAgeSeconds;
  const timestamp = dashboard.snapshotTimestamp
    ? formatSnapshotTimestamp(dashboard.snapshotTimestamp)
    : null;
  elements.age.className = 'age-badge';
  if (age == null) {
    elements.age.textContent = 'Sem timestamp no snapshot';
  } else if (age <= dashboard.collector.staleAfterSeconds) {
    elements.age.classList.add('online');
    const source = dashboard.collectorSource === 'collector_api' ? 'AO VIVO' : 'snapshot local';
    elements.age.textContent = `${source} · ultimo snapshot ${timestamp} · ha ${formatAge(age)}`;
  } else {
    elements.age.classList.add('stale');
    elements.age.textContent = `Ultimo snapshot ${timestamp} · antigo ha ${formatAge(age)}`;
  }
  elements.age.title = dashboard.snapshotTimestamp
    ? `Timestamp original: ${dashboard.snapshotTimestamp}`
    : 'O snapshot nao possui timestamp';
}

function formatAge(seconds) {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min`;
  return `${Math.floor(seconds / 3600)} h`;
}

function formatSnapshotTimestamp(timestamp) {
  const parsed = new Date(timestamp);
  if (Number.isNaN(parsed.getTime())) return timestamp;
  return parsed.toLocaleString('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function renderSummary(dashboard) {
  const online = dashboard.devices.filter((device) => device.online).length;
  const socValues = dashboard.devices.map((device) => device.soc).filter(Number.isFinite);
  const pv = dashboard.devices.reduce((sum, device) => sum + (Number.isFinite(device.pv.power) ? device.pv.power : 0), 0);
  const load = dashboard.devices.reduce((sum, device) => sum + (Number.isFinite(device.output.activePower) ? Math.max(0, device.output.activePower) : 0), 0);
  elements.summary.innerHTML = `
    ${summaryCard('Inversores online', `${online}/${dashboard.devices.length}`)}
    ${summaryCard('SOC medio', socValues.length ? `${Math.round(socValues.reduce((a, b) => a + b, 0) / socValues.length)}%` : '—')}
    ${summaryCard('Geracao PV', `${formatW(pv)}`)}
    ${summaryCard('Carga ativa', `${formatW(load)}`)}
  `;
}

function summaryCard(label, value) {
  return `<article class="summary-card"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></article>`;
}

function renderDevices(devices) {
  elements.devices.innerHTML = devices.map((device) => {
    const soc = Number.isFinite(device.soc) ? device.soc : null;
    const batteryClass = device.online ? '' : ' offline';
    return `
      <article class="device-card${batteryClass}">
        <div class="device-head">
          <div><h3>${escapeHtml(device.name)}</h3><span class="device-meta">${escapeHtml(device.id)} · ${escapeHtml(device.ip || 'IP nao informado')}</span></div>
          <button class="icon-button" title="Renomear" data-edit-device="${escapeHtml(device.id)}">✎</button>
        </div>
        <div class="soc-panel">
          <div class="soc-value">${soc == null ? '—' : soc}<small>% SOC</small></div>
          <div class="battery-track"><div class="battery-fill" style="width:${soc ?? 0}%"></div></div>
        </div>
        <div class="metrics">
          ${metric('Estado', device.mode || 'Indisponivel')}
          ${metric('Saida ativa', formatW(device.output.activePower))}
          ${metric('Carga', device.loadPercent == null ? '—' : `${device.loadPercent}%`)}
          ${metric('PV', formatW(device.pv.power))}
          ${metric('Bateria', device.battery.voltage == null ? '—' : `${device.battery.voltage.toFixed(1)} V`)}
          ${metric('Temperatura', device.temperature.inverter == null ? '—' : `${device.temperature.inverter} °C`)}
        </div>
      </article>`;
  }).join('');

  document.querySelectorAll('[data-edit-device]').forEach((button) => {
    button.addEventListener('click', () => openDevice(button.dataset.editDevice));
  });
}

function metric(label, value) {
  return `<div class="metric"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`;
}

function formatW(value) {
  return Number.isFinite(value) ? `${Math.round(value).toLocaleString('pt-BR')} W` : '—';
}

function renderIntegrations(integrations) {
  const items = [
    { name: 'Gate · ai-node', data: integrations?.gate ?? {}, detail: pausedText(integrations?.gate?.paused) },
    { name: 'Mineracao EP2', data: integrations?.ep2Mining ?? {}, detail: miningDetail(integrations?.ep2Mining) },
    { name: 'Mineracao ai-node', data: integrations?.aiNodeMining ?? {}, detail: miningDetail(integrations?.aiNodeMining) },
  ];
  elements.integrations.innerHTML = items.map((item) => {
    const online = item.data?.online === true;
    return `<article class="integration-card ${online ? 'online' : 'offline'}">
      <h3>${escapeHtml(item.name)}</h3>
      <span class="status-pill">${online ? 'Online' : 'Indisponivel'}</span>
      <div class="integration-detail">${escapeHtml(item.detail || item.data?.error || 'Sem dados recentes')}</div>
    </article>`;
  }).join('');
}

function pausedText(paused) {
  return paused == null ? 'Estado da fila nao informado' : paused ? 'Fila pausada' : 'Fila executando normalmente';
}

function miningDetail(data) {
  if (!data?.online) return null;
  const hashrate = Number.isFinite(data.hashrate) ? `${data.hashrate.toLocaleString('pt-BR')} H/s` : 'Hashrate indisponivel';
  const governor = data.governor?.mode ? ` · modo ${data.governor.mode}` : '';
  const state = data.running === false ? ' · mineracao parada' : '';
  const windows = Number.isFinite(data.hashrate60s) && Number.isFinite(data.hashrate15m)
    ? ` · 60 s ${data.hashrate60s.toLocaleString('pt-BR')} · 15 min ${data.hashrate15m.toLocaleString('pt-BR')}`
    : '';
  return `${hashrate}${windows}${governor}${state}`;
}

function renderRules(rules, intentions, devices) {
  elements.rules.innerHTML = rules.length ? rules.map((rule) => {
    const intention = intentions.find((item) => item.ruleId === rule.id);
    const source = devices.find((device) => device.id === rule.sourceDeviceId);
    const active = intention?.wouldExecute;
    return `<article class="rule-card">
      <div><h3>${escapeHtml(rule.name)}</h3><small>${escapeHtml(actionName(rule.action))}</small></div>
      <div><small>Referência</small><strong>${escapeHtml(source?.name || rule.sourceDeviceId)}</strong></div>
      <div><small>Faixa SOC</small><strong>${rule.activateBelow}% a ${rule.resumeAbove}%</strong></div>
      <div class="rule-state ${active ? 'active' : ''}">${active ? 'INTENÇÃO ATIVA · não executada' : intentionState(intention?.state)}</div>
      <div class="rule-actions">
        <button class="button secondary" data-edit-rule="${escapeHtml(rule.id)}">Editar</button>
        <button class="button danger" data-delete-rule="${escapeHtml(rule.id)}">Excluir</button>
      </div>
    </article>`;
  }).join('') : '<div class="notice"><strong>Nenhuma regra configurada</strong><span>Crie uma intenção para acompanhar o SOC.</span></div>';
  document.querySelectorAll('[data-edit-rule]').forEach((button) => button.addEventListener('click', () => openRule(button.dataset.editRule)));
  document.querySelectorAll('[data-delete-rule]').forEach((button) => button.addEventListener('click', () => deleteRule(button.dataset.deleteRule)));
}

function actionName(action) {
  return {
    gate_pause: 'Pausar fila do Gate',
    ep2_mining_reduce: 'Reduzir mineracao EP2',
    ainode_mining_reduce: 'Reduzir mineracao ai-node',
  }[action] || action;
}

function intentionState(state) {
  return { active: 'Faixa ativa', inactive: 'Faixa normal', hysteresis: 'Histerese', indeterminate: 'SOC indisponivel' }[state] || 'Aguardando';
}

function openDevice(id) {
  const device = state.dashboard.devices.find((item) => item.id === id);
  document.querySelector('#device-id').value = device.id;
  document.querySelector('#device-name').value = device.name;
  elements.deviceDialog.showModal();
}

async function saveDevice(event) {
  if (event.submitter?.value === 'cancel') return;
  event.preventDefault();
  try {
    await api(`/api/devices/${encodeURIComponent(document.querySelector('#device-id').value)}`, {
      method: 'PUT',
      body: JSON.stringify({ displayName: document.querySelector('#device-name').value }),
    });
    elements.deviceDialog.close();
    await loadDashboard();
    showToast('Nome salvo');
  } catch (error) {
    showToast(error.message);
  }
}

function openRule(id) {
  const rule = id ? state.dashboard.rules.find((item) => item.id === id) : {
    id: `rule-${Date.now()}`,
    name: '',
    sourceDeviceId: state.dashboard.devices[0]?.id ?? '',
    action: 'gate_pause',
    activateBelow: 50,
    resumeAbove: 55,
    desiredIntensity: 25,
    enabled: false,
  };
  document.querySelector('#rule-id').value = rule.id;
  document.querySelector('#rule-name').value = rule.name;
  document.querySelector('#rule-action').value = rule.action;
  document.querySelector('#rule-activate').value = rule.activateBelow;
  document.querySelector('#rule-resume').value = rule.resumeAbove;
  document.querySelector('#rule-intensity').value = rule.desiredIntensity ?? '';
  document.querySelector('#rule-enabled').checked = rule.enabled === true;
  const source = document.querySelector('#rule-source');
  source.innerHTML = state.dashboard.devices.map((device) => `<option value="${escapeHtml(device.id)}">${escapeHtml(device.name)}</option>`).join('');
  source.value = rule.sourceDeviceId;
  elements.ruleDialog.showModal();
}

async function saveRule(event) {
  if (event.submitter?.value === 'cancel') return;
  event.preventDefault();
  const id = document.querySelector('#rule-id').value;
  const existing = state.dashboard.rules.some((rule) => rule.id === id);
  const rule = {
    id,
    name: document.querySelector('#rule-name').value,
    sourceDeviceId: document.querySelector('#rule-source').value,
    action: document.querySelector('#rule-action').value,
    activateBelow: Number(document.querySelector('#rule-activate').value),
    resumeAbove: Number(document.querySelector('#rule-resume').value),
    desiredIntensity: document.querySelector('#rule-intensity').value === '' ? null : Number(document.querySelector('#rule-intensity').value),
    enabled: document.querySelector('#rule-enabled').checked,
  };
  try {
    await api(existing ? `/api/rules/${encodeURIComponent(id)}` : '/api/rules', {
      method: existing ? 'PUT' : 'POST',
      body: JSON.stringify(rule),
    });
    elements.ruleDialog.close();
    await loadDashboard();
    showToast('Regra salva');
  } catch (error) {
    showToast(error.message);
  }
}

async function deleteRule(id) {
  if (!window.confirm('Excluir esta regra?')) return;
  try {
    await api(`/api/rules/${encodeURIComponent(id)}`, { method: 'DELETE' });
    await loadDashboard();
    showToast('Regra excluida');
  } catch (error) {
    showToast(error.message);
  }
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' })[char]);
}

let toastTimer;
function showToast(message) {
  elements.toast.textContent = message;
  elements.toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => elements.toast.classList.remove('show'), 2600);
}

loadDashboard();
setInterval(loadDashboard, 10_000);
