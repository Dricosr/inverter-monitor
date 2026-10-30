export class StatusNormalizer {
  /**
   * @param {object} raw snapshot do coletor
   * @param {Array} devicesConfig `devices.json`
   * @param {object} [options] `snapshotAgeSeconds` e `staleAfterSeconds`
   */
  normalize(raw, devicesConfig, options = {}) {
    const timestamp = raw?.timestamp ?? null;
    const deviceMap = raw?.devices && typeof raw.devices === 'object' ? raw.devices : {};
    const configured = Array.isArray(devicesConfig) ? devicesConfig : [];
    const ids = configured.map((device) => device.name).filter(Boolean);
    const staleAfterSeconds = Number.isFinite(options.staleAfterSeconds) ? options.staleAfterSeconds : 120;
    const snapshotAge = Number.isFinite(options.snapshotAgeSeconds)
      ? options.snapshotAgeSeconds
      : this.#age(timestamp);
    // Snapshot velho invalida o arquivo inteiro: nao adianta marcar so o que faltou
    // neste ciclo. Sem isto o painel mostrava "Leitura atrasada" no topo e numeros
    // com cara de frescos nos cards — mentira de 5 minutos de idade.
    const snapshotStale = snapshotAge != null && snapshotAge > staleAfterSeconds;

    return ids.map((id) => {
      const device = deviceMap[id] ?? {};
      const settings = configured.find((item) => item.name === id) ?? {};
      const pv = this.#object(device.pv);
      const battery = this.#object(device.battery);
      const output = this.#object(device.output);
      const grid = this.#object(device.grid);
      const online = device.online !== false;

      // O coletor devolve `cache.fields` com o instante de cada folha que veio da
      // ultima leitura boa. Aqui vira idade em segundos — e e o que a UI usa para
      // pintar o valor em cinza em vez de trocar por "nao exposto".
      const staleFields = this.#staleFields(device.cache);
      const wholeAge = snapshotStale ? snapshotAge : null;
      const inputs = this.#pvInputs(pv.inputs, staleFields, wholeAge);
      const staleSince = this.#object(device.cache).at ?? null;
      let pvPower = this.#finite(pv.power, null);

      // Com uma entrada vinda do cache, o total medido do ciclo nao vale: ele soma
      // so as entradas frescas e passaria a contradizer os visores. O total vira a
      // soma do que esta na tela, marcado como velho junto com a entrada.
      const staleInputs = inputs.filter((input) => input.staleSeconds != null);
      if (staleInputs.length) {
        const sum = inputs
          .map((input) => input.power)
          .filter((value) => Number.isFinite(value))
          .reduce((total, value) => total + value, 0);
        pvPower = Math.round(sum * 10) / 10;
        staleFields['pv.power'] = Math.max(...staleInputs.map((input) => input.staleSeconds));
      }

      const soc = this.#finite(battery.soc, null);
      const activePower = this.#finite(output.active_power, null);
      const batteryPower = this.#finite(battery.power, null);
      const batteryVoltage = this.#finite(battery.voltage, null);

      // `modbus_*` informa corrente unica com sinal; `pi30` separa carga e descarga.
      const chargeCurrent = this.#finite(battery.current_charge, null)
        ?? (Number.isFinite(this.#finite(battery.current, null)) && battery.current > 0
          ? this.#finite(battery.current, null)
          : null);
      const dischargeCurrent = this.#finite(battery.current_discharge, null)
        ?? (Number.isFinite(this.#finite(battery.current, null)) && battery.current < 0
          ? Math.abs(this.#finite(battery.current, null))
          : null);
      const chargePower = Number.isFinite(chargeCurrent) && Number.isFinite(batteryVoltage)
        ? Math.round(chargeCurrent * batteryVoltage * 10) / 10
        : null;
      const dischargePower = Number.isFinite(dischargeCurrent) && Number.isFinite(batteryVoltage)
        ? Math.round(dischargeCurrent * batteryVoltage * 10) / 10
        : null;

      return {
        id,
        name: settings.displayName || settings.name || id,
        ip: device.ip ?? settings.ip ?? null,
        protocol: device.protocol ?? settings.protocol ?? null,
        pn: device.pn ?? settings.pn ?? null,
        serial: device.serial ?? null,
        serialTrusted: Boolean(device.serial) && device.serial_trusted !== false,
        online,
        lastOk: device.last_ok ?? null,
        lastOkAgeSeconds: this.#age(device.last_ok),
        error: device.error ?? null,
        fresh: Boolean(timestamp),
        timestamp,
        stale: {
          whole: snapshotStale || (!online && Object.keys(staleFields).length > 0),
          since: staleSince ?? (snapshotStale ? timestamp : null),
          ageSeconds: wholeAge ?? this.#age(staleSince),
          fields: staleFields,
        },
        snapshotAgeSeconds: snapshotAge,
        snapshotStale,
        mode: device.mode ?? null,
        soc,
        battery: {
          voltage: batteryVoltage,
          current: this.#finite(battery.current, null),
          power: batteryPower,
          chargeCurrent,
          dischargeCurrent,
          chargePower,
          dischargePower,
          currentPartial: battery.current_partial === true,
          temperature: this.#finite(battery.temperature, this.#finite(this.#object(device.temperature).battery, null)),
        },
        pv: {
          mppt: this.#finite(pv.mppt, null),
          mpptCount: this.#finite(pv.mppt_count, null),
          mpptUnreadable: Array.isArray(pv.mppt_unreadable) ? pv.mppt_unreadable : [],
          mpptPower: Array.isArray(pv.mppt_power)
            ? pv.mppt_power.map((value) => this.#finite(value, null))
            : [],
          inputs,
          voltage: this.#finite(pv.voltage, null),
          current: this.#finite(pv.current, null),
          power: pvPower,
          dcBalance: this.#finite(pv.dc_balance, null),
        },
        grid: {
          voltage: this.#finite(grid.voltage, null),
          frequency: this.#finite(grid.frequency, null),
          power: this.#finite(grid.power, null),
        },
        output: {
          voltage: this.#finite(output.voltage, null),
          current: this.#finite(output.current, null),
          frequency: this.#finite(output.frequency, null),
          activePower,
          apparentPower: this.#finite(output.apparent_power, null),
        },
        loadPercent: this.#finite(device.load_percent, null),
        temperature: {
          inverter: this.#finite(this.#object(device.temperature).inverter, null),
          dcdc: this.#finite(this.#object(device.temperature).dcdc, null),
          pv: this.#finite(this.#object(device.temperature).pv, null),
        },
      };
    });
  }

  #object(value) {
    return value && typeof value === 'object' ? value : {};
  }

  /** `cache.fields` (caminho -> instante) vira caminho -> idade em segundos. */
  #staleFields(cache) {
    const fields = this.#object(this.#object(cache).fields);
    const result = {};
    for (const [path, at] of Object.entries(fields)) {
      const age = this.#age(at);
      if (age != null) result[path] = age;
    }
    return result;
  }

  #age(timestamp) {
    if (!timestamp) return null;
    const parsed = Date.parse(timestamp);
    return Number.isFinite(parsed) ? Math.max(0, Math.floor((Date.now() - parsed) / 1000)) : null;
  }

  /**
   * Uma entrada PV por MPPT: valores nulos continuam nulos (nao viram zero).
   * `staleFields` diz quais entradas vieram do cache e ha quanto tempo;
   * `wholeAge` marca todas quando o snapshot inteiro esta velho.
   */
  #pvInputs(value, staleFields = {}, wholeAge = null) {
    if (!Array.isArray(value)) return [];
    return value
      .map((entry, index) => ({ entry, index }))
      .filter(({ entry }) => entry && typeof entry === 'object')
      .map(({ entry, index }) => {
        const ages = Object.entries(staleFields)
          .filter(([path]) => path.startsWith(`pv.inputs.${index}.`))
          .map(([, age]) => age);
        if (wholeAge != null) ages.push(wholeAge);
        return {
          mppt: this.#finite(entry.mppt, index + 1),
          voltage: this.#finite(entry.voltage, null),
          current: this.#finite(entry.current, null),
          power: this.#finite(entry.power, null),
          readable: entry.readable !== false,
          reason: typeof entry.reason === 'string' ? entry.reason : null,
          currentSource: typeof entry.current_source === 'string' ? entry.current_source : null,
          staleSeconds: ages.length ? Math.max(...ages) : null,
        };
      });
  }

  #finite(value, fallback = Number.NaN) {
    // Number(null) e Number('') valem 0: sem esta guarda um campo ausente viraria
    // "0 W" na tela, que e mentira (ausente != zero).
    if (value === null || value === undefined || value === '') return fallback;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }
}
