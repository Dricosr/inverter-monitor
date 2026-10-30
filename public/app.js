const state = { dashboard: null };

const elements = {
  summary: document.querySelector('#summary'),
  devices: document.querySelector('#devices'),
  integrations: document.querySelector('#integrations'),
  rules: document.querySelector('#rules'),
  chips: document.querySelector('#status-chips'),
  automationCard: document.querySelector('#automation-card'),
  automationTitle: document.querySelector('#automation-title'),
  automationDetail: document.querySelector('#automation-detail'),
  deviceDialog: document.querySelector('#device-dialog'),
  ruleDialog: document.querySelector('#rule-dialog'),
  ruleDialogTitle: document.querySelector('#rule-dialog-title'),
  ruleHint: document.querySelector('#rule-hint'),
  ruleIntensityField: document.querySelector('#rule-intensity-field'),
  rulePreview: document.querySelector('#rule-preview'),
  ruleError: document.querySelector('#rule-error'),
  toast: document.querySelector('#toast'),
};

const MODE_LABELS = {
  'Off-Grid': 'Fora da rede',
  Battery: 'Bateria',
  Line: 'Rede',
  Grid: 'Rede',
  Fault: 'Falha',
  Off: 'Desligado',
};

const MODE_HINTS = {
  'Off-Grid': 'Modo informado pelo próprio inversor: operando fora da rede da distribuidora.',
  Battery: 'Modo informado pelo próprio inversor: consumindo da bateria.',
  Line: 'Modo informado pelo próprio inversor: sincronizado à rede da distribuidora.',
  Grid: 'Modo informado pelo próprio inversor: sincronizado à rede da distribuidora.',
  Fault: 'O inversor está reportando falha.',
  Off: 'O inversor está desligado.',
};

const PROTOCOL_LABELS = {
  modbus_a: 'Modbus A',
  modbus_b: 'Modbus B',
  pi30: 'PI30',
  pi30_smg: 'PI30 + Modbus 0925',
};

const ACTION_HINTS = {
  gate_pause: {
    target: 'Gate',
    text: 'Pausa a fila do Gate. O job em execução termina; nenhum novo começa até o SOC subir.',
  },
  ep2_mining_reduce: {
    target: 'EP2',
    text: 'Reinicia o XMRig da EP2 com menos threads, na intensidade escolhida abaixo.',
  },
  ainode_mining_reduce: {
    target: 'ai-node',
    text: 'Limita a CPU do XMRig do ai-node por cgroup, na intensidade escolhida abaixo.',
  },
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
document.querySelector('#rule-action').addEventListener('change', syncRuleDialog);
document.querySelector('#rule-activate').addEventListener('input', syncRuleDialog);
document.querySelector('#rule-resume').addEventListener('input', syncRuleDialog);

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
  renderStatusChips(dashboard);
  renderAutomationCard(dashboard);
  renderSummary(dashboard);
  renderDevices(dashboard.devices);
  renderIntegrations(dashboard);
  renderRules(dashboard);
}

function renderStatusChips(dashboard) {
  const chips = [];
  const age = dashboard.snapshotAgeSeconds;
  const staleAfter = dashboard.collector?.staleAfterSeconds ?? 120;

  if (age == null) {
    chips.push(chip('danger', 'Sem dados', 'O coletor ainda não gravou uma leitura'));
  } else if (age > staleAfter) {
    chips.push(chip('warn', 'Leitura atrasada', `Última leitura em ${formatSnapshotTimestamp(dashboard.snapshotTimestamp)}`));
    chips.push(chip('muted', `Há ${formatAge(age)}`));
  } else {
    chips.push(chip('ok', 'Ao vivo', dashboard.collectorSource === 'collector_api' ? 'Coletor consultado agora' : 'Leitura gravada pelo coletor'));
    chips.push(chip('muted', `Há ${formatAge(age)}`, 'Tempo desde a última leitura dos inversores'));
  }

  const online = dashboard.devices.filter((device) => device.online).length;
  const offline = dashboard.devices.filter((device) => !device.online);
  chips.push(chip(offline.length ? 'warn' : 'muted', `${online}/${dashboard.devices.length} online`,
    offline.length ? `Sem resposta: ${offline.map((device) => device.name).join(', ')}` : 'Inversores respondendo na LAN'));
  for (const device of offline.slice(0, 2)) {
    chips.push(chip('danger', `${device.name} sem resposta`, device.error ?? 'O dongle não respondeu na última leitura'));
  }

  const actions = Object.values(dashboard.execution?.actions ?? {});
  const failures = actions.filter((action) => action.outcome === 'erro').length;
  const conflicts = actions.filter((action) => action.outcome === 'conflito').length;
  if (failures) chips.push(chip('danger', failures === 1 ? '1 ação falhou' : `${failures} ações falharam`));
  else if (conflicts) chips.push(chip('warn', 'Fila pausada por outro comando'));

  elements.chips.innerHTML = chips.join('');
}

function renderAutomationCard(dashboard) {
  const enabled = dashboard.execution?.enabled === true;
  const activeRules = dashboard.rules.filter((rule) => rule.enabled);
  const failures = Object.values(dashboard.execution?.actions ?? {})
    .filter((action) => action.outcome === 'erro').length;
  const acting = activeRules.filter(
    (rule) => dashboard.execution?.actions?.[rule.id]?.mode === 'active',
  ).length;
  const waiting = activeRules.filter((rule) => {
    const source = dashboard.devices.find((device) => device.id === rule.sourceDeviceId);
    return source && source.online === false;
  }).length;

  elements.automationCard.className = `automation-card ${!enabled ? 'off' : failures || waiting ? 'warn' : 'ok'}`;
  elements.automationTitle.textContent = enabled ? 'Automação ativa' : 'Automação desligada';
  elements.automationDetail.textContent = !enabled
    ? 'Nenhuma ação é aplicada'
    : failures
      ? (failures === 1 ? '1 ação falhou' : `${failures} ações falharam`)
      : waiting
        ? `${waiting} ${waiting === 1 ? 'regra sem leitura' : 'regras sem leitura'}`
        : `${acting} de ${activeRules.length} ${activeRules.length === 1 ? 'regra atuando' : 'regras atuando'}`;
}

function renderSummary(dashboard) {
  const online = dashboard.devices.filter((device) => device.online).length;
  const socValues = dashboard.devices.map((device) => device.soc).filter(Number.isFinite);
  const average = socValues.length ? Math.round(socValues.reduce((total, value) => total + value, 0) / socValues.length) : null;
  const solar = solarTotal(dashboard.devices);
  const output = dashboard.devices.reduce((total, device) => total + (Number.isFinite(device.output.activePower) ? Math.max(0, device.output.activePower) : 0), 0);

  elements.summary.innerHTML = [
    summaryCard('Inversores online', `${online}/${dashboard.devices.length}`, 'Dispositivos respondendo na LAN'),
    summaryCard('SOC médio', average == null ? '—' : `${average}%`,
      online < dashboard.devices.length
        ? `Média dos ${online} inversores que responderam agora`
        : 'Média do estado de carga das baterias'),
    summaryCard(`Geração solar${solar.hiddenInputs ? ' (parcial)' : ''}`, formatW(solar.value), solarHintText(solar)),
    summaryCard('Potência de saída', formatW(output), 'Soma da potência entregue às cargas'),
  ].join('');
}

/**
 * Soma o PV medido de todas as entradas que os inversores expõem. Entrada que o
 * firmware esconde (multi-MPPT sem `QPIGS2`) deixa o total como piso.
 */
function solarTotal(devices) {
  let measured = 0;
  let any = false;
  let hiddenInputs = 0;
  let unmeasured = 0;
  for (const device of devices) {
    if (!device.online) continue;
    if (Number.isFinite(device.pv.power)) {
      measured += device.pv.power;
      any = true;
    } else {
      unmeasured += 1;
    }
    hiddenInputs += device.pv.inputs.filter((input) => !input.readable).length;
  }
  return { value: any ? measured : null, hiddenInputs, unmeasured };
}

function solarHintText(solar) {
  if (solar.hiddenInputs === 1) {
    return 'Soma parcial: 1 entrada PV não é exposta pelo firmware — o card do inversor mostra qual';
  }
  if (solar.hiddenInputs > 1) {
    return `Soma parcial: ${solar.hiddenInputs} entradas PV não são expostas pelo firmware`;
  }
  if (solar.unmeasured) {
    return `Soma apenas dos inversores que informam PV — ${solar.unmeasured} não informa(m) esse dado`;
  }
  return 'Soma de todas as entradas PV agora';
}

function formatPower(value) {
  return formatW(value);
}

function summaryCard(label, value, hint) {
  return `<article class="summary-card" title="${escapeHtml(hint)}"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></article>`;
}

function renderDevices(devices) {
  elements.devices.innerHTML = devices.map((device) => {
    const soc = Number.isFinite(device.soc) ? device.soc : null;
    const level = soc == null ? '' : soc < 30 ? ' low' : soc < 60 ? ' mid' : '';
    const chips = [device.online
      ? chip('muted', device.mode ? (MODE_LABELS[device.mode] ?? device.mode) : 'Modo não informado',
        device.mode ? (MODE_HINTS[device.mode] ?? `Modo informado pelo inversor: ${device.mode}.`) : 'O inversor não informou o modo de operação.')
      : chip('danger', 'Sem resposta')];
    if (soc != null && soc < 30) chips.push(chip('warn', 'Bateria baixa'));

    return `
      <article class="device-card${device.online ? '' : ' offline'}">
        <div class="device-head">
          <div class="device-identity">
            <h3>${escapeHtml(device.name)}</h3>
            <span class="device-meta">${escapeHtml(device.ip || 'IP não informado')} · ${escapeHtml(PROTOCOL_LABELS[device.protocol] ?? device.protocol ?? 'protocolo não informado')}</span>
            ${identityLine(device)}
          </div>
          <button class="icon-button" title="Renomear inversor" data-edit-device="${escapeHtml(device.id)}">✎</button>
        </div>
        <div class="device-body">
          <div class="soc-top">
            <div class="soc-value">${soc ?? '—'}<small>${soc == null ? 'SOC' : '% SOC'}</small></div>
            <div class="device-chips">${chips.join('')}</div>
          </div>
          <div class="battery-slot">
            ${device.online
              ? `<div class="battery-track"><div class="battery-fill${level}" style="width:${soc ?? 0}%"></div></div>`
              : `<p class="device-alert" title="${escapeHtml(device.error ?? '')}">${escapeHtml(offlineReason(device))}</p>`}
          </div>
          <div class="metrics">
            ${metric('Potência de saída', formatW(device.output.activePower))}
            ${metric('Carga no inversor', device.loadPercent == null ? '—' : `${device.loadPercent}%`)}
            ${metric('Temperatura', device.temperature.inverter == null ? '—' : `${device.temperature.inverter} °C`)}
            ${metric('Temp. PV', device.temperature.pv == null ? '—' : `${device.temperature.pv} °C`, 'Temperatura do módulo fotovoltaico')}
            ${metric('Tensão da bateria', device.battery.voltage == null ? '—' : `${device.battery.voltage.toFixed(1)} V`)}
            ${metric(partialLabel('Carga da bateria', device), formatAmps(device.battery.chargeCurrent), currentHint(device, 'Carga da bateria'))}
            ${metric(partialLabel('Descarga da bateria', device), formatAmps(device.battery.dischargeCurrent), currentHint(device, 'Descarga da bateria'))}
          </div>
          ${pvBlock(device)}
          ${device.online ? balanceLine(device) : ''}
        </div>
      </article>`;
  }).join('');

  document.querySelectorAll('[data-edit-device]').forEach((button) => {
    button.addEventListener('click', () => openDevice(button.dataset.editDevice));
  });
}

function metric(label, value, hint) {
  const title = hint ? ` title="${escapeHtml(hint)}"` : ` title="${escapeHtml(value)}"`;
  return `<div class="metric"><span>${escapeHtml(label)}</span><strong${title}>${escapeHtml(value)}</strong></div>`;
}

function formatAmps(value) {
  return Number.isFinite(value) ? `${value.toFixed(1)} A` : '—';
}

/**
 * PN e SN do aparelho. O PN vem do `devices.json` (o inversor nao o expoe pela LAN);
 * o SN so aparece quando o proprio aparelho o informa de forma confiavel.
 */
function identityLine(device) {
  const parts = [];
  if (device.pn) parts.push(`PN ${device.pn}`);
  if (device.serial && device.serialTrusted) parts.push(`SN ${device.serial}`);
  if (!parts.length) return '';
  const text = parts.join(' · ');
  const hint = device.serial && !device.serialTrusted
    ? 'O serial informado por este firmware não corresponde ao do fabricante e foi omitido'
    : text;
  return `<span class="device-ids" title="${escapeHtml(hint)}">${escapeHtml(text)}</span>`;
}

/**
 * Entradas PV: um visor por MPPT com tensao, corrente e potencia, mais a soma das
 * entradas legiveis. Entrada que o firmware esconde aparece como "nao exposto" em
 * vez de herdar o numero da outra — e o que fazia a UI mentir.
 */
function pvBlock(device) {
  if (!device.online) return '';
  const inputs = device.pv.inputs;
  if (!inputs.length) {
    return `<div class="pv-block">
      <div class="pv-head"><span>Entradas PV</span><strong>${escapeHtml(formatW(device.pv.power))}</strong></div>
      <p class="pv-empty">Este inversor não informa quantas entradas PV tem — só a potência total.</p>
    </div>`;
  }

  const readable = inputs.filter((input) => input.readable && Number.isFinite(input.power));
  const total = readable.reduce((sum, input) => sum + input.power, 0);
  const hidden = inputs.length - readable.length;
  const totalLabel = Number.isFinite(device.pv.power) && !hidden ? device.pv.power : (readable.length ? total : null);
  const hint = hidden
    ? `Soma de ${readable.length} de ${inputs.length} entradas: ${hidden} não é exposta pelo firmware`
    : `Soma das ${inputs.length} entradas PV`;

  return `<div class="pv-block">
    <div class="pv-head" title="${escapeHtml(hint)}">
      <span>Entradas PV${hidden ? ` · ${readable.length}/${inputs.length}` : ''}</span>
      <strong>${escapeHtml(formatW(totalLabel))}</strong>
    </div>
    <div class="mppt-grid">${inputs.map(mpptCard).join('')}</div>
  </div>`;
}

function mpptCard(input) {
  const label = `MPPT${input.mppt}`;
  if (!input.readable) {
    const reason = input.reason || 'o firmware não expõe esta entrada';
    return `<div class="mppt mppt--unknown" title="${escapeHtml(`${label}: ${reason}`)}">
      <span>${escapeHtml(label)}</span>
      <strong>não exposto</strong>
      <small>${escapeHtml(reason)}</small>
    </div>`;
  }
  const volts = Number.isFinite(input.voltage) ? `${input.voltage.toFixed(1)} V` : '—';
  const amps = Number.isFinite(input.current) ? `${input.current.toFixed(1)} A` : null;
  const detail = amps ? `${volts} · ${amps}` : volts;
  return `<div class="mppt" title="${escapeHtml(`${label}: ${detail}`)}">
    <span>${escapeHtml(label)}</span>
    <strong>${escapeHtml(formatW(input.power))}</strong>
    <small>${escapeHtml(detail)}</small>
  </div>`;
}

/** O QPIGS de um inversor de dois MPPTs so mede as correntes do SCC1. */
function partialLabel(label, device) {
  return device.battery.currentPartial ? `${label} (parcial)` : label;
}

function currentHint(device, label) {
  if (device.battery.currentPartial) {
    return `${label}: o inversor só reporta o SCC1 — a corrente do MPPT2 não entra nesta medição`;
  }
  return label === 'Carga da bateria' ? 'Corrente entrando na bateria' : 'Corrente saindo da bateria';
}

/** Complemento do bloco PV: quando falta uma entrada, mostra o balanco DC como piso. */
function balanceLine(device) {
  if (!Number.isFinite(device.pv.dcBalance)) return '';
  const hidden = device.pv.inputs.filter((input) => !input.readable);
  if (!hidden.length) return '';
  const hint = device.battery.currentPartial
    ? 'A corrente da bateria é parcial, então o balanço DC é um piso: a geração real é maior'
    : 'O firmware não expõe a segunda entrada PV, então a geração real é maior que a soma acima';
  const names = hidden.map((input) => `MPPT${input.mppt}`).join(' e ');
  return `<p class="device-diag" title="${escapeHtml(hint)}">Com ${escapeHtml(names)} fora da leitura, a geração real é maior que a soma acima. Balanço DC (saída + carga da bateria): ≥ ${escapeHtml(formatW(device.pv.dcBalance))}</p>`;
}

function offlineReason(device) {
  const when = device.lastOk ? formatClock(device.lastOk) : null;
  if (when) return `Sem resposta desde a última leitura, às ${when}`;
  const age = device.lastOk ? null : 'sem leitura desde que o coletor iniciou';
  return `Sem resposta · ${age}`;
}

function renderIntegrations(dashboard) {
  const gate = dashboard.integrations?.gate ?? {};
  const ep2 = dashboard.integrations?.ep2Mining ?? {};
  const ai = dashboard.integrations?.aiNodeMining ?? {};
  const ep2Rule = dashboard.rules.find((rule) => rule.action === 'ep2_mining_reduce');
  const aiRule = dashboard.rules.find((rule) => rule.action === 'ainode_mining_reduce');

  elements.integrations.innerHTML = [
    gateCard(gate),
    miningCard({
      title: 'Mineração EP2',
      data: ep2,
      rule: ep2Rule,
      action: dashboard.execution?.actions?.[ep2Rule?.id],
      reducedFoot: (intensity) => `Alvo de ${intensity}% das threads`,
    }),
    miningCard({
      title: 'Mineração ai-node',
      data: ai,
      rule: aiRule,
      action: dashboard.execution?.actions?.[aiRule?.id],
      reducedFoot: (intensity) => `Alvo de ${intensity}% de 1 CPU`,
      governor: ai.governor,
    }),
  ].join('');
}

function gateCard(gate) {
  if (!gate.online) {
    return cardShell('Fila do Gate', chip('danger', 'Sem resposta'), '', gate.error ?? 'Sem dados recentes.');
  }
  const paused = gate.paused === true;
  const pending = Number.isFinite(gate.pending) ? gate.pending : null;
  const metrics = `
    <dl class="integration-metrics">
      <div><dt>Na fila</dt><dd>${pending == null ? '—' : pending}</dd></div>
      <div><dt>Pausa</dt><dd>${paused ? originLabel(gate.pausedBy) : 'nenhuma'}</dd></div>
      <div><dt>Novos jobs</dt><dd>${paused ? 'retidos' : 'aceitando'}</dd></div>
    </dl>`;
  const foot = paused
    ? 'Enquanto pausada, nenhum job novo começa; o que já roda termina.'
    : 'Aceitando novos jobs normalmente.';
  return cardShell('Fila do Gate', chip(paused ? 'warn' : 'ok', paused ? 'Pausada' : 'Executando'), metrics, foot);
}

function miningCard({ title, data, rule, action, reducedFoot, governor }) {
  if (!data?.online) {
    return cardShell(title, chip('danger', 'Sem resposta'), '', data?.error ?? 'Sem dados recentes.');
  }

  const stopped = data.running === false;
  // A contagem real de threads manda mais que o registro da automacao: se alguem
  // reiniciar o minerador por fora, o painel precisa mostrar a verdade.
  const threadsReduced = Number.isFinite(data.threads)
    && Number.isFinite(data.maxThreads)
    && data.threads < data.maxThreads;
  const reduced = threadsReduced || (action?.mode === 'active' && action.applied === true);
  const governorAi = governor?.mode === 'ai';

  let status;
  if (stopped) status = chip('danger', 'Parada');
  else if (reduced) status = chip('warn', 'Reduzida');
  else if (governorAi) status = chip('warn', 'Cedendo à IA');
  else status = chip('ok', 'Máxima');

  const metrics = `
    <dl class="integration-metrics">
      <div><dt>Agora</dt><dd>${formatHashrate(data.hashrate)}</dd></div>
      <div><dt>1 min</dt><dd>${formatHashrate(data.hashrate60s)}</dd></div>
      <div><dt>15 min</dt><dd>${formatHashrate(data.hashrate15m)}</dd></div>
    </dl>`;

  const notes = [];
  const intensity = Number(rule?.desiredIntensity);
  if (threadsReduced) notes.push(`${data.threads} de ${data.maxThreads} threads`);
  else if (reduced && Number.isFinite(intensity)) notes.push(reducedFoot(intensity));
  if (rule && !rule.enabled) notes.push('regra de redução desligada');
  if (reduced && !rule?.enabled) notes.push('redução fora da automação');
  if (governor?.mode) notes.push(`governador do Gate: ${governor.mode}`);
  if (!notes.length) notes.push('Sem redução por bateria');

  return cardShell(title, status, metrics, notes.join(' · '));
}

function cardShell(title, status, metrics, foot) {
  return `<article class="integration-card">
      <div class="integration-head"><h3>${escapeHtml(title)}</h3>${status}</div>
      ${metrics}
      <p class="integration-foot">${escapeHtml(foot ?? '')}</p>
    </article>`;
}

function renderRules(dashboard) {
  const rules = dashboard.rules ?? [];

  elements.rules.innerHTML = rules.length ? rules.map((rule) => {
    const execution = dashboard.execution?.actions?.[rule.id] ?? {};
    const source = dashboard.devices.find((device) => device.id === rule.sourceDeviceId);
    const status = ruleState(rule, execution, source);

    return `<article class="rule-card">
        <div class="rule-main">
          <div class="rule-head">
            <h3>${escapeHtml(rule.name)}</h3>
            <span class="chip chip--muted">${escapeHtml(actionTarget(rule.action))}</span>
          </div>
          <p class="rule-range">Liga abaixo de <strong>${rule.activateBelow}%</strong> · desliga acima de <strong>${rule.resumeAbove}%</strong></p>
        </div>
        <div class="rule-status">
          <span class="chip chip--${status.tone}">${escapeHtml(status.label)}</span>
          <span class="rule-note"${status.title ? ` title="${escapeHtml(status.title)}"` : ''}>${escapeHtml(status.note)}</span>
        </div>
        <div class="rule-actions">
          <button class="button secondary" data-edit-rule="${escapeHtml(rule.id)}">Editar</button>
          <button class="button danger" data-delete-rule="${escapeHtml(rule.id)}">Excluir</button>
        </div>
      </article>`;
  }).join('') : `<div class="notice"><strong>Nenhuma regra criada</strong><span>Crie uma regra para ligar e desligar uma ação pelo SOC de um inversor.</span></div>`;

  document.querySelectorAll('[data-edit-rule]').forEach((button) => button.addEventListener('click', () => openRule(button.dataset.editRule)));
  document.querySelectorAll('[data-delete-rule]').forEach((button) => button.addEventListener('click', () => deleteRule(button.dataset.deleteRule)));
}

function ruleState(rule, execution, source) {
  const soc = Number.isFinite(execution?.soc) ? `SOC ${Math.round(execution.soc)}%` : null;
  const name = source?.name ?? null;
  const where = soc && name ? `${soc} (${name})` : soc ?? name ?? 'sem leitura';
  const when = execution?.updatedAt ? `Atualizado às ${formatClock(execution.updatedAt)}` : '';
  const detail = typeof execution?.detail?.detail === 'string' ? execution.detail.detail : '';
  const title = [when, detail].filter(Boolean).join(' · ') || undefined;
  const holding = execution?.mode === 'active' && execution.applied;

  if (!rule.enabled) return { tone: 'muted', label: 'Desligada', note: 'A regra não executa' };
  if (execution?.outcome === 'erro') {
    return { tone: 'danger', label: 'Falha', note: detail || 'não foi possível aplicar', title };
  }
  if (execution?.outcome === 'conflito') {
    return { tone: 'warn', label: 'Conflito', note: `Fila pausada por outro comando · ${where}`, title };
  }
  // Inversor de referencia fora do ar: sem SOC nao se decide nada, e o estado atual
  // e mantido de proposito (nao libera nem intensifica as cegas).
  if (source && source.online === false) {
    return {
      tone: 'warn',
      label: holding ? 'Mantida' : 'Sem leitura',
      note: holding
        ? `${name} sem resposta · a redução continua aplicada`
        : `${name} sem resposta · nenhuma ação aplicada`,
      title,
    };
  }
  if (holding) {
    return { tone: 'warn', label: activeLabel(rule.action), note: `${activeNote(rule)} · ${where}`, title };
  }
  if (execution?.outcome === 'liberada') {
    return { tone: 'ok', label: 'Liberada', note: 'Recursos devolvidos ao máximo', title };
  }
  return { tone: 'muted', label: 'Normal', note: `${where} · ação não ativa`, title };
}

function activeLabel(action) {
  return action === 'gate_pause' ? 'Pausado' : 'Reduzido';
}

function activeNote(rule) {
  if (rule.action === 'gate_pause') return 'Fila pausada';
  const intensity = Number(rule.desiredIntensity);
  return Number.isFinite(intensity) ? `Minerador em ${intensity}%` : 'Minerador reduzido';
}

function actionTarget(action) {
  return { gate_pause: 'Gate', ep2_mining_reduce: 'EP2', ainode_mining_reduce: 'ai-node' }[action] ?? action;
}

function originLabel(pausedBy) {
  return { manual: 'manual', descarregar: 'ao descarregar', shutdown: 'desligamento' }[pausedBy] ?? pausedBy ?? 'ativa';
}

function chip(tone, label, hint) {
  const title = hint ? ` title="${escapeHtml(hint)}"` : '';
  return `<span class="chip chip--${tone}"${title}>${escapeHtml(label)}</span>`;
}

function formatHashrate(value) {
  return Number.isFinite(value) ? `${Math.round(value).toLocaleString('pt-BR')} H/s` : '—';
}

function formatW(value) {
  return Number.isFinite(value) ? `${Math.round(value).toLocaleString('pt-BR')} W` : '—';
}

function formatAge(seconds) {
  if (seconds < 60) return `${seconds} s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min`;
  return `${Math.floor(seconds / 3600)} h`;
}

function formatSnapshotTimestamp(timestamp) {
  const parsed = new Date(timestamp);
  if (Number.isNaN(parsed.getTime())) return '—';
  return parsed.toLocaleString('pt-BR', {
    day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

function formatClock(timestamp) {
  const parsed = new Date(timestamp);
  return Number.isNaN(parsed.getTime())
    ? ''
    : parsed.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
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
    showToast('Nome atualizado');
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

  elements.ruleDialogTitle.textContent = id ? 'Editar regra' : 'Nova regra';
  document.querySelector('#rule-id').value = rule.id;
  document.querySelector('#rule-name').value = rule.name;
  document.querySelector('#rule-action').value = rule.action;
  document.querySelector('#rule-activate').value = rule.activateBelow;
  document.querySelector('#rule-resume').value = rule.resumeAbove;
  document.querySelector('#rule-intensity').value = rule.desiredIntensity ?? '';

  const source = document.querySelector('#rule-source');
  source.innerHTML = state.dashboard.devices
    .map((device) => `<option value="${escapeHtml(device.id)}">${escapeHtml(device.name)} (${escapeHtml(device.ip || 'sem IP')})</option>`)
    .join('');
  source.value = rule.sourceDeviceId;

  document.querySelector('#rule-enabled').checked = rule.enabled === true;
  elements.ruleError.textContent = '';
  syncRuleDialog();
  elements.ruleDialog.showModal();
}

function syncRuleDialog() {
  const action = document.querySelector('#rule-action').value;
  const hint = ACTION_HINTS[action];
  elements.ruleHint.innerHTML = `<span class="chip chip--muted">${escapeHtml(hint.target)}</span><p>${escapeHtml(hint.text)}</p>`;

  const usesIntensity = action !== 'gate_pause';
  elements.ruleIntensityField.hidden = !usesIntensity;
  elements.ruleIntensityField.closest('.form-grid').classList.toggle('two', !usesIntensity);

  const activate = Number(document.querySelector('#rule-activate').value);
  const resume = Number(document.querySelector('#rule-resume').value);
  const valid = Number.isFinite(activate) && Number.isFinite(resume) && resume > activate;

  elements.rulePreview.classList.toggle('invalid', !valid);
  elements.rulePreview.textContent = valid
    ? `Abaixo de ${activate}% liga · entre ${activate}% e ${resume}% mantém · a partir de ${resume}% desliga.`
    : 'O limite de desligar precisa ser maior que o de ligar.';
}

async function saveRule(event) {
  if (event.submitter?.value === 'cancel') return;
  event.preventDefault();

  const id = document.querySelector('#rule-id').value;
  const existing = state.dashboard.rules.some((rule) => rule.id === id);
  const rule = {
    id,
    name: document.querySelector('#rule-name').value.trim(),
    sourceDeviceId: document.querySelector('#rule-source').value,
    action: document.querySelector('#rule-action').value,
    activateBelow: Number(document.querySelector('#rule-activate').value),
    resumeAbove: Number(document.querySelector('#rule-resume').value),
    desiredIntensity: document.querySelector('#rule-intensity').value === ''
      ? null
      : Number(document.querySelector('#rule-intensity').value),
    enabled: document.querySelector('#rule-enabled').checked,
  };

  if (!rule.name) return showRuleError('Dê um nome para a regra.');
  if (!Number.isFinite(rule.activateBelow) || !Number.isFinite(rule.resumeAbove)) {
    return showRuleError('Informe os dois limites de SOC.');
  }
  if (rule.resumeAbove <= rule.activateBelow) {
    return showRuleError('O limite de desligar precisa ser maior que o de ligar.');
  }

  try {
    await api(existing ? `/api/rules/${encodeURIComponent(id)}` : '/api/rules', {
      method: existing ? 'PUT' : 'POST',
      body: JSON.stringify(rule),
    });
    elements.ruleDialog.close();
    await loadDashboard();
    showToast(existing ? 'Regra atualizada' : 'Regra criada');
  } catch (error) {
    showRuleError(error.message);
  }
}

function showRuleError(message) {
  elements.ruleError.textContent = message;
}

async function deleteRule(id) {
  const rule = state.dashboard.rules.find((item) => item.id === id);
  const label = rule ? `"${rule.name}"` : 'esta regra';
  if (!window.confirm(`Excluir ${label}? Se ela estiver atuando agora, o recurso será liberado.`)) return;
  try {
    await api(`/api/rules/${encodeURIComponent(id)}`, { method: 'DELETE' });
    await loadDashboard();
    showToast('Regra excluída');
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
