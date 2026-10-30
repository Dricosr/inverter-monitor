export class StatusNormalizer {
  normalize(raw, devicesConfig) {
    const timestamp = raw?.timestamp ?? null;
    const deviceMap = raw?.devices && typeof raw.devices === 'object' ? raw.devices : {};
    const configured = Array.isArray(devicesConfig) ? devicesConfig : [];
    const ids = configured.map((device) => device.name).filter(Boolean);

    return ids.map((id) => {
      const device = deviceMap[id] ?? {};
      const settings = configured.find((item) => item.name === id) ?? {};
      const pv = this.#object(device.pv);
      const battery = this.#object(device.battery);
      const output = this.#object(device.output);
      const grid = this.#object(device.grid);

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
        online: device.online !== false,
        lastOk: device.last_ok ?? null,
        error: device.error ?? null,
        fresh: Boolean(timestamp),
        timestamp,
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
          inputs: this.#pvInputs(pv.inputs),
          voltage: this.#finite(pv.voltage, null),
          current: this.#finite(pv.current, null),
          power: this.#finite(pv.power, null),
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

  /** Uma entrada PV por MPPT: valores nulos continuam nulos (nao viram zero). */
  #pvInputs(value) {
    if (!Array.isArray(value)) return [];
    return value
      .filter((entry) => entry && typeof entry === 'object')
      .map((entry, index) => ({
        mppt: this.#finite(entry.mppt, index + 1),
        voltage: this.#finite(entry.voltage, null),
        current: this.#finite(entry.current, null),
        power: this.#finite(entry.power, null),
        readable: entry.readable !== false,
        reason: typeof entry.reason === 'string' ? entry.reason : null,
      }));
  }

  #finite(value, fallback = Number.NaN) {
    // Number(null) e Number('') valem 0: sem esta guarda um campo ausente viraria
    // "0 W" na tela, que e mentira (ausente != zero).
    if (value === null || value === undefined || value === '') return fallback;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }
}
