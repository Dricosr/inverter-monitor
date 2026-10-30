#!/usr/bin/env python3
"""
inverter_monitor.py - leitura LOCAL (LAN) de inversores hibridos com dongle Eybond/DessMonitor.

Como funciona
-------------
O dongle WiFi desses inversores normalmente fica conectado ao servidor de nuvem
(ess.eybond.com). Ele aceita um comando UDP que o manda conectar em outro servidor:

    UDP <ip-do-dongle>:58899   ->  "set>server=<ip-local>:8899;"

Depois disso o dongle abre uma conexao TCP para nos e, por essa conexao, trafega
frames no formato Eybond:

    tid:u16  dev:u16  len:u16  addr:u8  fc:u8  payload
    (big-endian; len conta addr + fc + payload)

O fc=4 e' "transparente": o payload vai cru para o inversor e a resposta volta.
Com isso lemos o inversor direto, sem nuvem.

Protocolos encontrados nas maquinas desta instalacao:
  * pi30      -> comandos ASCII "QPIGS"/"QMOD" (familia Voltronic/Axpert-like)
  * modbus_a  -> Modbus RTU, mapa EG4 3000EHV (registradores 200-344)
  * modbus_b  -> Modbus RTU, mapa Anenji/Megarevo (bateria em 277-281)

Uso
---
  python inverter_monitor.py --probe 192.168.18.33      # testa um dongle
  python inverter_monitor.py --once                     # um ciclo, imprime JSON
  python inverter_monitor.py                            # servico + HTTP :8080
  python inverter_monitor.py --interval 10 --http 8080

API HTTP
--------
  GET /status         -> JSON com todos os inversores
  GET /status/<nome>  -> JSON de um inversor
  GET /health         -> 200 se o ultimo ciclo rodou
"""
from __future__ import annotations

import argparse
import json
import logging
import os
import socket
import struct
import sys
import threading
import time
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

DONGLE_UDP_PORT = 58899
LOCAL_TCP_PORT = 8899  # porta em que o dongle conecta de volta (fixa no firmware)
CLOUD_RECOVERY_DELAY = 1.5

__version__ = "1.2.0"

log = logging.getLogger("inverter")


# --------------------------------------------------------------------------- #
# CRC / framing
# --------------------------------------------------------------------------- #
def crc16_modbus(data: bytes) -> bytes:
    crc = 0xFFFF
    for b in data:
        crc ^= b
        for _ in range(8):
            crc = ((crc >> 1) ^ 0xA001) & 0xFFFF if crc & 1 else crc >> 1
    return struct.pack("<H", crc)


def crc16_pi30(data: bytes) -> bytes:
    """CRC-16/XMODEM (init 0) com a correcao dos bytes 0x28/0x0D/0x0A."""
    crc = 0x0000
    for b in data:
        crc ^= b << 8
        for _ in range(8):
            crc = ((crc << 1) ^ 0x1021) & 0xFFFF if crc & 0x8000 else (crc << 1) & 0xFFFF
    return bytes(x + 1 if x in (0x28, 0x0D, 0x0A) else x for x in struct.pack(">H", crc))


def pi30(payload: bytes) -> bytes:
    return payload + crc16_pi30(payload) + b"\r"


def rtu_read(slave: int, start: int, count: int) -> bytes:
    body = struct.pack(">BBHH", slave, 3, start, count)
    return body + crc16_modbus(body)


def eb_frame(tid: int, fc: int, payload: bytes, dev: int = 1, addr: int = 0xFF) -> bytes:
    return struct.pack(">HHHBB", tid, dev, len(payload) + 2, addr, fc) + payload


def s16(v: int) -> int:
    return v - 0x10000 if v >= 0x8000 else v


# --------------------------------------------------------------------------- #
# Link com o dongle
# --------------------------------------------------------------------------- #
class Dongle:
    """Abre o canal local: UDP notify -> aceita o callback -> fala Eybond."""

    def __init__(self, ip: str, connect_timeout: float = 25.0, reply_timeout: float = 8.0):
        self.ip = ip
        self.reply_timeout = reply_timeout
        self.tid = 0xE000
        self.buf = b""
        self.sock = None
        self._open(connect_timeout)

    def _local_ip(self) -> str:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            s.connect((self.ip, 9))
            return s.getsockname()[0]
        finally:
            s.close()

    def _open(self, connect_timeout: float) -> None:
        srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            srv.bind(("0.0.0.0", LOCAL_TCP_PORT))
        except OSError as exc:
            srv.close()
            raise RuntimeError(f"porta {LOCAL_TCP_PORT} ocupada (outra instancia rodando?)") from exc
        srv.listen(2)
        myip = self._local_ip()
        deadline = time.time() + connect_timeout
        conn = None
        while conn is None:
            u = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            try:
                u.sendto(f"set>server={myip}:{LOCAL_TCP_PORT};".encode(),
                         (self.ip, DONGLE_UDP_PORT))
            finally:
                u.close()
            srv.settimeout(min(3.0, max(0.5, deadline - time.time())))
            try:
                conn, addr = srv.accept()
            except socket.timeout:
                if time.time() >= deadline:
                    srv.close()
                    raise TimeoutError(f"{self.ip} nao conectou de volta em {connect_timeout:.0f}s")
        srv.close()
        if addr[0] != self.ip:
            log.warning("callback de %s (esperado %s)", addr[0], self.ip)
        self.sock = conn
        self.sock.settimeout(self.reply_timeout)

    def _next_tid(self) -> int:
        self.tid = 0xE000 + (self.tid + 1 - 0xE000) % 0x1000
        return self.tid

    def _recv_exact(self, n: int) -> bytes:
        while len(self.buf) < n:
            chunk = self.sock.recv(4096)
            if not chunk:
                raise ConnectionError("dongle fechou a conexao")
            self.buf += chunk
        out, self.buf = self.buf[:n], self.buf[n:]
        return out

    def ask(self, fc: int, payload: bytes, timeout: float | None = None) -> bytes:
        tid = self._next_tid()
        self.sock.sendall(eb_frame(tid, fc, payload))
        limit = timeout or self.reply_timeout
        self.sock.settimeout(limit)
        deadline = time.time() + limit
        while time.time() < deadline:
            rtid, _dev, length, _addr, _rfc = struct.unpack(">HHHBB", self._recv_exact(8))
            body = self._recv_exact(max(0, length - 2))
            if rtid == tid:
                return body
            log.debug("frame fora de ordem tid=%#06x", rtid)
        raise TimeoutError("sem resposta com o tid esperado")

    def close(self) -> None:
        if self.sock:
            try:
                self.sock.close()
            finally:
                self.sock = None
                time.sleep(CLOUD_RECOVERY_DELAY)


# --------------------------------------------------------------------------- #
# Leitura por protocolo
# --------------------------------------------------------------------------- #
MODES_MODBUS_A = {
    0: "Power On", 1: "Standby", 2: "Mains", 3: "Off-Grid",
    4: "Bypass", 5: "Charging", 6: "Fault",
}
MODES_MODBUS_B = MODES_MODBUS_A  # registrador 201 responde com o mesmo enum nos dois mapas
MODES_PI30 = {"L": "Line", "B": "Battery", "S": "Standby", "F": "Fault",
              "P": "Power On", "H": "Power Saving"}


MODBUS_GAP = 0.05  # respiro entre requisicoes: o dongle descarta respostas se for atropelado


def _modbus_block(link: Dongle, start: int, count: int, slave: int = 1) -> list[int]:
    time.sleep(MODBUS_GAP)
    body = link.ask(4, rtu_read(slave, start, count))
    if len(body) < 5 or body[1] & 0x80:
        raise ValueError(f"resposta Modbus invalida: {body.hex(' ')}")
    n = body[2] // 2
    return [body[3 + i * 2] << 8 | body[4 + i * 2] for i in range(n)]


def _required_block(link: Dongle, start: int, count: int, attempts: int = 2) -> list[int]:
    """Bloco essencial: tenta de novo uma vez antes de derrubar a leitura inteira."""
    for attempt in range(1, attempts + 1):
        try:
            return _modbus_block(link, start, count)
        except Exception:
            if attempt == attempts:
                raise
            time.sleep(0.15)
    raise RuntimeError("inalcancavel")


def _safe_block(link: Dongle, start: int, count: int) -> list[int]:
    """Leitura opcional: um fabricante/firmware pode nao expor o registrador."""
    try:
        return _modbus_block(link, start, count)
    except Exception as exc:
        log.debug("bloco %d+%d indisponivel: %s", start, count, exc)
        return []


# --------------------------------------------------------------------------- #
# Mapa 0925 (SMG/Megarevo) — o mesmo que o dongle usa para alimentar a nuvem.
#
# O `.106` responde PI30 em ASCII, mas o dongle tambem le esse mapa Modbus do
# inversor: e dele que sai o MPPT2, que o QPIGS nao carrega. Duas diferencas em
# relacao ao mapa B do `.59`:
#   * slave 5 (nao 1) e enderecos altos (4501+);
#   * os registradores vem com os bytes trocados (little-endian).
# --------------------------------------------------------------------------- #
SMG_SLAVE = 5
SMG_BASE = 4501
SMG_COUNT = 64


def _modbus_block_le(link: Dongle, start: int, count: int, slave: int) -> list[int]:
    """Bloco Modbus com os bytes de cada registrador invertidos."""
    time.sleep(MODBUS_GAP)
    body = link.ask(4, rtu_read(slave, start, count))
    if len(body) < 5 or body[1] & 0x80:
        raise ValueError(f"resposta Modbus invalida: {body.hex(' ')}")
    data = body[3:3 + body[2]]
    return [data[i] | (data[i + 1] << 8) for i in range(0, len(data) - 1, 2)]


def read_modbus_smg(link: Dongle, slave: int = SMG_SLAVE) -> dict:
    """Mapa 0925 completo. Devolve os campos que interessam ao painel."""
    return parse_modbus_smg(_modbus_block_le(link, SMG_BASE, SMG_COUNT, slave))


def parse_modbus_smg(regs: list[int]) -> dict:
    """Decodifica o bloco 4501+ do mapa 0925 (registradores ja em ordem de leitura)."""

    def reg(address: int) -> int | None:
        offset = address - SMG_BASE
        return regs[offset] if 0 <= offset < len(regs) else None

    return {
        "pv1": _scaled(reg(4504), 10),
        "pv1_power": reg(4505),
        "pv2": _scaled(reg(4563), 10),
        "pv2_power": reg(4564),
        "battery_voltage": _scaled(reg(4506), 10),
        "soc": reg(4507),
        "charge_current": reg(4508),
        "discharge_current": reg(4509),
        "output_voltage": _scaled(reg(4510), 10),
        "output_frequency": _scaled(reg(4511), 10),
        "output_apparent_power": reg(4512),
        "output_active_power": reg(4513),
        "load_percent": reg(4514),
        "machine_type": reg(4517),
        "cpu_version": reg(4518),
        "nominal_power": reg(4522),
        "error_code": reg(4529),
        "alarm_code": reg(4530),
    }


def _scaled(value: int | None, divisor: float) -> float | None:
    return None if value is None else round(value / divisor, 1)


def _pv_power(voltage: float | None, current: float | None) -> float | None:
    """Potencia PV so existe quando tensao e corrente foram lidas de forma plausivel."""
    if voltage is None or current is None:
        return None
    if not (0 <= voltage <= 600 and 0 <= current <= 60):
        return None
    return round(voltage * current, 1)


def _pv_measured(value: int | None) -> float | None:
    """Potencia PV medida pelo inversor (registradores 353/391), em W."""
    if value is None:
        return None
    value = s16(value)
    return float(value) if 0 <= value <= 20000 else None


def _pv_input(index: int, voltage: float | None, current: float | None,
              power: float | None) -> dict:
    """Uma entrada PV: o que o inversor informou, sem inventar o que faltou."""
    entrada = {"mppt": index, "voltage": voltage, "current": current, "power": power}
    entrada["readable"] = any(v is not None for v in (voltage, current, power))
    return entrada


def _pv_input_unreadable(index: int, reason: str) -> dict:
    """Entrada que existe no hardware mas o firmware nao expoe."""
    return {"mppt": index, "voltage": None, "current": None, "power": None,
            "readable": False, "reason": reason}


def _ascii_from_regs(regs: list[int], count: int) -> str | None:
    """Le os primeiros `count` registradores como texto ASCII (2 caracteres cada).

    O `.59` guarda o serial nesse formato nos registradores 186-192: a leitura crua
    devolve `92B32504103913`, o mesmo SN que o app do fabricante mostra.
    """
    if len(regs) < count:
        return None
    texto = "".join(chr((r >> 8) & 0xFF) + chr(r & 0xFF) for r in regs[:count])
    texto = texto.split("\x00")[0].strip()
    if len(texto) < 8 or not all(32 <= ord(c) < 127 for c in texto):
        return None
    if not any(c.isdigit() for c in texto):
        return None
    return texto


def _signed_or_none(value: int | None) -> int | None:
    return None if value is None else s16(value)


def parse_modbus_a(r: list[int]) -> dict:
    """Decodifica o bloco de 45 registradores (200-244) do mapa EG4/Axpert."""
    g = lambda reg: r[reg - 200]
    return {
        "protocol": "modbus_a",
        "mode": MODES_MODBUS_A.get(g(201), f"desconhecido({g(201)})"),
        "battery": {
            "soc": g(229),
            "voltage": round(s16(g(215)) / 10, 1),
            "current": round(s16(g(232)) / 10, 1),
            "power": s16(g(217)),
        },
        "pv": {
            "voltage": round(s16(g(219)) / 10, 1),
            "current": round(s16(g(220)) / 10, 1),
            "power": s16(g(223)),
        },
        "grid": {
            "voltage": round(s16(g(202)) / 10, 1),
            "frequency": round(s16(g(203)) / 100, 2),
            "power": s16(g(204)),
        },
        "output": {
            "voltage": round(s16(g(210)) / 10, 1),
            "current": round(s16(g(211)) / 10, 1),
            "frequency": round(s16(g(212)) / 100, 2),
            "active_power": s16(g(213)),
            "apparent_power": s16(g(214)),
        },
        "load_percent": s16(g(225)),
        "temperature": {"dcdc": s16(g(226)), "inverter": s16(g(227))},
    }


def read_modbus_a(link: Dongle) -> dict:
    """Mapa EG4/Axpert (regs 200-244)."""
    return parse_modbus_a(_modbus_block(link, 200, 45))


def _reg(block: list[int], start: int, reg: int) -> int | None:
    """Valor de um registrador absoluto dentro de um bloco iniciado em `start`."""
    offset = reg - start
    return block[offset] if 0 <= offset < len(block) else None


def read_modbus_b(link: Dongle) -> dict:
    """Mapa Anenji/Megarevo.

    Cinco requisicoes: cabecalho 200-236 (modo, rede e temperatura do modulo INV),
    bateria/PV total/temperaturas 277-305, saida 252-255, saida+PV1 342-353 e
    PV2 389-391. Blocos grandes reduzem a ida e volta pelo dongle.
    """
    head = _safe_block(link, 200, 37)
    # Bloco alinhado de 180 com 20 registradores: leituras curtas (186+7, 180+13) voltam
    # zeradas nesse dongle. O serial fica em 186-192 e vem como texto ASCII.
    serial_block = _safe_block(link, 180, 20)
    bat = _required_block(link, 277, 29)
    out = _required_block(link, 252, 4)
    acpv = _safe_block(link, 342, 12)
    pv2 = _safe_block(link, 389, 3)

    pv = {
        "pv1": _scaled(_reg(acpv, 342, 351), 10),
        "pv2": _scaled(_reg(pv2, 389, 389), 10),
        "pv1_current": _scaled(_reg(acpv, 342, 352), 10),
        "pv2_current": _scaled(_reg(pv2, 389, 390), 10),
        "pv1_power": _reg(acpv, 342, 353),
        "pv2_power": _reg(pv2, 389, 391),
    }
    load = _reg(acpv, 342, 350)
    return parse_modbus_b(
        bat[0:5], out,
        grid=head[2:4],
        ac=acpv[0:2],
        pv=pv,
        status=head[0:2],
        load_percent=[] if load is None else [load],
        temperatures={
            "inverter": _reg(head, 200, 231),
            "dcdc": _reg(bat, 277, 281),
            "pv": _reg(bat, 277, 305),
        },
        serial=_ascii_from_regs(serial_block[6:], 7),
    )


def parse_modbus_b(bat: list[int], out: list[int], grid: list[int],
                   ac: list[int], pv: dict,
                   status: list[int] | None = None,
                   load_percent: list[int] | None = None,
                   temperatures: dict | None = None,
                   serial: str | None = None) -> dict:
    """Decodifica os blocos do mapa Anenji/Megarevo."""
    status = status or []
    load_percent = load_percent or []
    temperatures = temperatures or {}

    grid_v = _scaled(s16(grid[0]), 10) if grid and grid[0] else None
    grid_f = round(s16(grid[1]) / 100, 2) if len(grid) > 1 and grid[1] else None
    mode_code = status[1] if len(status) > 1 else None

    pv1_v = pv.get("pv1")
    pv2_v = pv.get("pv2")
    pv1_i = pv.get("pv1_current")
    pv2_i = pv.get("pv2_current")
    # Potencia medida pelo proprio inversor (regs 353/391); V x I so como reserva.
    pv1_p = _pv_measured(pv.get("pv1_power"))
    if pv1_p is None:
        pv1_p = _pv_power(pv1_v, pv1_i)
    pv2_p = _pv_measured(pv.get("pv2_power"))
    if pv2_p is None:
        pv2_p = _pv_power(pv2_v, pv2_i)
    powers = [p for p in (pv1_p, pv2_p) if p is not None]
    currents = [i for i in (pv1_i, pv2_i) if i is not None]

    return {
        "protocol": "modbus_b",
        "mode": None if mode_code is None else MODES_MODBUS_B.get(mode_code, f"desconhecido({mode_code})"),
        "status_code": mode_code,
        "serial": serial,
        "battery": {
            "soc": bat[3],
            "voltage": round(bat[0] / 10, 1),
            "current": round(s16(bat[1]) / 10, 1),
            "power": s16(bat[2]),
        },
        "pv": {
            "voltage": pv1_v,
            "voltage2": pv2_v,
            "current": round(sum(currents), 1) if currents else None,
            "power": round(sum(powers), 1) if powers else None,
            "mppt_power": [pv1_p, pv2_p] if powers else None,
            "inputs": [_pv_input(1, pv1_v, pv1_i, pv1_p),
                       _pv_input(2, pv2_v, pv2_i, pv2_p)],
        },
        "grid": {"voltage": grid_v, "frequency": grid_f},
        "output": {
            "voltage": round(ac[0] / 10, 1) if ac else None,
            "current": round(s16(out[0]) / 10, 1),
            "frequency": round(out[1] / 100, 2),
            "active_power": s16(out[2]),
            "apparent_power": s16(out[3]),
        },
        "load_percent": load_percent[0] if load_percent else None,
        "temperature": {
            "inverter": _signed_or_none(temperatures.get("inverter")),
            "dcdc": _signed_or_none(temperatures.get("dcdc")),
            "pv": _signed_or_none(temperatures.get("pv")),
        },
    }


def parse_qpigs(raw: str, mode_letter: str = "?", serial: str | None = None) -> dict:
    """Decodifica a resposta QPIGS (ASCII) em campos nomeados."""
    if not (raw.startswith("(") and raw.endswith("\r")):
        raise ValueError(f"resposta QPIGS inesperada: {raw!r}")
    body = raw[1:-3]
    if body.startswith("NAK"):
        raise ValueError("inversor respondeu NAK (comando nao suportado)")
    f = body.split()

    def num(i, default=0.0):
        try:
            return float(f[i])
        except (IndexError, ValueError):
            return default

    battery_voltage = num(8)
    pv_voltage = num(13)
    pv_current = num(12)
    charge_current = num(9)
    discharge_current = num(15)
    output_active = int(num(5))

    # Este inversor tem DOIS MPPTs, mas o `QPIGS` so carrega o MPPT1: o dongle/inversor
    # nao implementa `QPIGS2` (responde NAK). Confirmado contra a nuvem do fabricante
    # no mesmo instante: QPIGS traz 47,3 V / 0 W (MPPT1, sem paineis) enquanto o app
    # mostra PV1 47,3 V / 0 W e PV2 256,4 V / 512 W. Ou seja: os campos 12/13 estao
    # corretos, mas descrevem apenas a entrada 1.
    pv_power = _pv_power(round(pv_voltage, 1), round(pv_current, 1))

    # Balanco no lado DC: potencia de saida mais o que entra/sai da bateria. E uma
    # grandeza medida, util para diagnostico — NAO e a potencia de entrada PV.
    balance = output_active + (charge_current - discharge_current) * battery_voltage
    dc_balance = round(balance, 1)

    return {
        "protocol": "pi30",
        "mode": MODES_PI30.get(mode_letter, mode_letter),
        "serial": serial,
        "battery": {
            "soc": int(num(10)),
            "voltage": battery_voltage,
            "current_charge": charge_current,
            "current_discharge": discharge_current,
            "power": round(battery_voltage * (charge_current - discharge_current), 1),
            "voltage_scc": num(14),
            # As correntes do QPIGS ficam abaixo do real quando o MPPT2 gera: com 1083 W
            # no PV2 e 331 W de saida o inversor reportou 5 A de carga, enquanto a nuvem
            # do fabricante mostrava 12 A no mesmo minuto. Sao parciais.
            "current_partial": True,
        },
        "pv": {
            "mppt": 1,
            "mppt_count": 2,
            "mppt_unreadable": [2],
            "voltage": round(pv_voltage, 1),
            "current": round(pv_current, 1),
            "power": pv_power,
            "dc_balance": dc_balance,
            "inputs": [
                _pv_input(1, round(pv_voltage, 1), round(pv_current, 1), pv_power),
                # QPIGS2 e as 25 variantes testadas respondem NAK: o firmware nao
                # expoe a segunda entrada, nem por ASCII nem por Modbus RTU.
                _pv_input_unreadable(2, "o firmware deste modelo não expõe o MPPT2"),
            ],
        },
        "grid": {"voltage": num(0), "frequency": num(1)},
        "output": {
            "voltage": num(2),
            "frequency": num(3),
            "apparent_power": int(num(4)),
            "active_power": output_active,
        },
        "load_percent": int(num(6)),
        "bus_voltage": int(num(7)),
        "temperature": {"inverter": int(num(11))},
    }


def _pi30_ask(link: Dongle, command: bytes, timeout: float, attempts: int = 3) -> str:
    """Envia um comando ASCII e devolve o texto da resposta.

    O `.106` responde `(NAKss` de forma intermitente quando o dongle esta atendendo a
    nuvem e o inversor ao mesmo tempo, e a leitura seguinte ja voltava boa. Repetir sai
    mais barato do que marcar o inversor como offline por um NAK passageiro.
    """
    last: Exception | None = None
    for attempt in range(1, attempts + 1):
        try:
            return link.ask(4, pi30(command), timeout=timeout).decode("ascii", "replace")
        except Exception as exc:  # noqa: BLE001 - timeout tambem merece nova tentativa
            last = exc
            if attempt < attempts:
                time.sleep(0.25)
    raise last if last else RuntimeError("sem resposta")


def read_pi30(link: Dongle) -> dict:
    """Familia PI30 (ASCII): QPIGS + QMOD + QID."""
    raw = _pi30_ask(link, b"QPIGS", timeout=12)
    try:
        mode_letter = _pi30_ask(link, b"QMOD", timeout=6, attempts=2)[1:2]
    except Exception:
        mode_letter = "?"
    try:
        serial = _pi30_ask(link, b"QID", timeout=6, attempts=2)[1:-3]
    except Exception:
        serial = None
    return parse_qpigs(raw, mode_letter, serial)


def merge_modbus_smg(data: dict, smg: dict) -> dict:
    """Completa um leitor PI30 com o que o mapa 0925 informa melhor.

    O `QPIGS` carrega apenas o MPPT1 e subnotifica as correntes da bateria: numa
    leitura pareada o mapa 0925 dizia 7 A de carga com 869 W no PV2 e 417 W de saida
    (balanco pede 8,5 A, o que fecha com as perdas), enquanto o `QPIGS` dizia 2 A.
    Por isso o 0925 tem prioridade em PV, bateria, saida e carga — e o PI30 fica
    com o que ele e o unico a informar: temperatura, tensao do barramento e modo.
    """
    if not smg or (smg.get("pv2") is None and smg.get("pv2_power") is None):
        return data

    pv = data.setdefault("pv", {})
    inputs = pv.get("inputs") or []
    if len(inputs) >= 2:
        inputs[1] = _pv_input(2, smg.get("pv2"), None, smg.get("pv2_power"))
        inputs[1]["power_source"] = "modbus 0925 (reg 4564)"
        pv["inputs"] = inputs
        pv["voltage2"] = smg.get("pv2")
        pv["power2"] = smg.get("pv2_power")
        pv["mppt_unreadable"] = []
        pv["mppt_count"] = 2
        pv["mppt_power"] = [inputs[0].get("power"), inputs[1].get("power")]
        measured = [v for v in (inputs[0].get("power"), inputs[1].get("power"))
                    if v is not None]
        if measured:
            pv["power"] = round(sum(measured), 1)

    battery = data.setdefault("battery", {})
    voltage = smg.get("battery_voltage")
    charge = smg.get("charge_current")
    discharge = smg.get("discharge_current")
    if smg.get("soc") is not None:
        battery["soc"] = smg["soc"]
    if voltage is not None:
        battery["voltage"] = voltage
    if charge is not None:
        battery["current_charge"] = float(charge)
    if discharge is not None:
        battery["current_discharge"] = float(discharge)
    if voltage is not None and charge is not None and discharge is not None:
        battery["power"] = round(voltage * (charge - discharge), 1)
    # O 0925 le a corrente da bateria de fato; o rotulo "(parcial)" deixa de valer.
    battery.pop("current_partial", None)

    output = data.setdefault("output", {})
    for key, value in (("voltage", smg.get("output_voltage")),
                       ("frequency", smg.get("output_frequency")),
                       ("apparent_power", smg.get("output_apparent_power")),
                       ("active_power", smg.get("output_active_power"))):
        if value is not None:
            output[key] = value
    if smg.get("load_percent") is not None:
        data["load_percent"] = smg["load_percent"]

    active = output.get("active_power")
    if isinstance(active, (int, float)) and voltage is not None:
        charge_w = max(0.0, (charge or 0.0) * voltage)
        discharge_w = max(0.0, (discharge or 0.0) * voltage)
        data.setdefault("pv", {})["dc_balance"] = round(active + charge_w - discharge_w, 1)

    data["smg"] = {k: smg.get(k) for k in
                   ("machine_type", "cpu_version", "nominal_power", "error_code", "alarm_code")}
    data["modbus_smg"] = True
    data["protocol"] = "pi30_smg"
    return data


def read_pi30_smg(link: Dongle) -> dict:
    """PI30 (ASCII) + mapa 0925. O 0925 e opcional: sem ele, volta ao PI30 puro."""
    data = read_pi30(link)
    try:
        smg = read_modbus_smg(link)
    except Exception as exc:  # noqa: BLE001
        log.debug("mapa 0925 indisponivel: %s", exc)
        return data
    return merge_modbus_smg(data, smg)


READERS = {"modbus_a": read_modbus_a, "modbus_b": read_modbus_b,
           "pi30_smg": read_pi30_smg, "pi30": read_pi30}


def _plausible(data: dict) -> bool:
    """Evita aceitar um protocolo que respondeu, mas com valores sem sentido."""
    bat = data.get("battery", {})
    soc = bat.get("soc")
    volts = bat.get("voltage")
    if soc is None or volts is None:
        return False
    return 0 <= soc <= 100 and 8.0 <= float(volts) <= 80.0


def detect_protocol(ip: str) -> tuple[str, dict]:
    """Descobre qual leitor funciona para o dongle informado (uma conexao so)."""
    errors = {}
    for proto in ("modbus_a", "modbus_b", "pi30_smg", "pi30"):
        link = None
        try:
            link = Dongle(ip, connect_timeout=25, reply_timeout=10)
            data = READERS[proto](link)
            if not _plausible(data):
                errors[proto] = f"respondeu mas valores implausiveis ({data.get('battery')})"
                continue
            return proto, data
        except Exception as exc:
            errors[proto] = str(exc)
        finally:
            if link:
                link.close()
    raise RuntimeError(f"nenhum protocolo conhecido respondeu em {ip}: {errors}")


# --------------------------------------------------------------------------- #
# Coleta
# --------------------------------------------------------------------------- #
DEFAULT_CONNECT_TIMEOUT = 10.0  # curto de proposito: um dongle fora do ar nao pode
# travar o ciclo inteiro. Com 25 s o ciclo de 15 s virava 32 s e os inversores que
# estavam respondendo apareciam atrasados na UI.


def _device_fields(spec) -> tuple[str, str, str | None, float]:
    if isinstance(spec, dict):
        timeout = spec.get("connect_timeout")
        return (spec["name"], spec["ip"], spec.get("protocol"),
                float(timeout) if timeout else DEFAULT_CONNECT_TIMEOUT)
    name, ip, proto = spec
    return name, ip, proto, DEFAULT_CONNECT_TIMEOUT


def poll_once(devices: list,
              rules: dict[str, dict] | None = None,
              state: dict[str, bool] | None = None,
              last_ok: dict[str, str] | None = None) -> dict:
    rules = rules or {}
    state = state if state is not None else {}
    last_ok = last_ok if last_ok is not None else {}
    result = {
        "timestamp": datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds"),
        "devices": {},
    }
    for spec in devices:
        name, ip, proto, connect_timeout = _device_fields(spec)
        entry: dict = {"ip": ip, "protocol": proto, "online": False}
        link = None
        try:
            if proto is None:
                proto, data = detect_protocol(ip)
                entry["protocol"] = proto
                entry.update(data)
            else:
                link = Dongle(ip, connect_timeout=connect_timeout)
                entry.update(READERS[proto](link))
            entry["online"] = True
            last_ok[name] = result["timestamp"]
        except Exception as exc:
            entry["error"] = f"{type(exc).__name__}: {exc}"
            log.warning("%s (%s): %s", name, ip, entry["error"])
        finally:
            if link:
                link.close()

        # O PN nao sai por nenhum comando local: vem do `devices.json`, com o mesmo valor
        # que o app do fabricante mostra. O serial so e publicado quando o proprio
        # aparelho o informa de forma confiavel (o `QID` do PI30 devolve um placeholder).
        pn = spec.get("pn") if isinstance(spec, dict) else None
        if pn:
            entry["pn"] = pn
        if entry.get("serial") and str(entry.get("protocol", "")).startswith("pi30"):
            entry["serial_trusted"] = False

        if not entry["online"]:
            # Mantem a hora da ultima leitura boa para a UI explicar o que aconteceu.
            entry["last_ok"] = last_ok.get(name)

        rule = rules.get(name)
        if rule and entry.get("online"):
            soc = entry.get("battery", {}).get("soc")
            if soc is not None:
                on, off = rule.get("soc_on", 60), rule.get("soc_off", 45)
                prev = state.get(name)
                if soc >= on:
                    state[name] = True
                elif soc <= off:
                    state[name] = False
                else:
                    state[name] = bool(prev) if prev is not None else False
                entry["automation"] = {
                    "should_run": state[name],
                    "soc_on": on,
                    "soc_off": off,
                    "reason": ("soc>=on" if soc >= on else
                               "soc<=off" if soc <= off else "histerese"),
                }
        result["devices"][name] = entry
    return result



# --------------------------------------------------------------------------- #
# Servidor HTTP
# --------------------------------------------------------------------------- #
class _State:
    latest: dict = {"devices": {}}
    last_ok: float = 0.0
    lock = threading.Lock()


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def _send(self, obj, code=200):
        body = json.dumps(obj, indent=1, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path = self.path.rstrip("/") or "/"
        if path == "/health":
            ok = (time.time() - _State.last_ok) < 120
            self._send({"ok": ok}, 200 if ok else 503)
        elif path == "/status":
            with _State.lock:
                self._send(_State.latest)
        elif path.startswith("/status/"):
            name = path[len("/status/"):]
            with _State.lock:
                dev = _State.latest.get("devices", {}).get(name)
                names = list(_State.latest.get("devices", {}))
            if dev is None:
                self._send({"error": "desconhecido", "disponiveis": names}, 404)
            else:
                self._send(dev)
        else:
            self._send({"endpoints": ["/status", "/status/<nome>", "/health"]}, 404)


class _HttpServer(ThreadingHTTPServer):
    """Sem SO_REUSEADDR: no Windows ele permite varios binds na mesma porta e dois
    coletores passariam a disputar o mesmo dongle. Aqui a segunda instancia falha."""

    allow_reuse_address = False

    def server_bind(self):
        if hasattr(socket, "SO_EXCLUSIVEADDRUSE"):
            self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        super().server_bind()


def start_http(port: int) -> None:
    try:
        srv = _HttpServer(("0.0.0.0", port), Handler)
    except OSError as exc:
        raise SystemExit(
            f"porta {port} ja esta em uso: outra instancia do coletor esta rodando ({exc})"
        ) from exc
    threading.Thread(target=srv.serve_forever, daemon=True, name="http").start()
    log.info("HTTP em http://0.0.0.0:%d/status", port)


# --------------------------------------------------------------------------- #
# main
# --------------------------------------------------------------------------- #
def load_devices() -> tuple[list[dict], dict[str, dict]]:
    """(lista de dispositivos, regras de automacao). Le devices.json se existir."""
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "devices.json")
    if os.path.exists(path):
        with open(path, encoding="utf-8") as fh:
            data = json.load(fh)
    else:
        data = [
            {"name": "anenji-6k2", "ip": "192.168.18.33", "protocol": "modbus_a"},
            {"name": "inversor-59", "ip": "192.168.18.59", "protocol": "modbus_b"},
            {"name": "inversor-106", "ip": "192.168.18.106", "protocol": "pi30"},
        ]
    devices = [
        {"name": d["name"], "ip": d["ip"], "protocol": d.get("protocol"),
         "connect_timeout": d.get("connect_timeout"), "pn": d.get("pn")}
        for d in data
    ]
    rules = {d["name"]: d for d in data if "soc_on" in d or "soc_off" in d}
    return devices, rules


def write_json_atomic(path: str, value) -> None:
    """Grava em arquivo temporario e troca de uma vez.

    Sem isso um leitor (a UI) pode pegar o arquivo no meio da escrita e receber JSON
    truncado, justo quando algum inversor esta offline e o ciclo fica mais lento.
    """
    temporary = f"{path}.{os.getpid()}.tmp"
    with open(temporary, "w", encoding="utf-8") as fh:
        json.dump(value, fh, indent=1, ensure_ascii=False)
        fh.flush()
        os.fsync(fh.fileno())
    os.replace(temporary, path)



def main() -> int:
    ap = argparse.ArgumentParser(description="Leitor local dos inversores (dongle Eybond)")
    ap.add_argument("--probe", metavar="IP", help="testa um dongle e mostra o que responde")
    ap.add_argument("--once", action="store_true", help="um ciclo e sai")
    ap.add_argument("--interval", type=float, default=10.0, help="segundos entre ciclos (padrao 10)")
    ap.add_argument("--http", type=int, default=8080, help="porta da API HTTP (0 desliga)")
    ap.add_argument("--out", default="data/latest.json", help="arquivo JSON de saida")
    ap.add_argument("--connect-timeout", type=float, default=DEFAULT_CONNECT_TIMEOUT,
                    help=f"segundos esperando o dongle conectar de volta (padrao {DEFAULT_CONNECT_TIMEOUT:.0f})")
    ap.add_argument("-v", "--verbose", action="store_true")
    ap.add_argument("--version", action="version", version=f"inverter-monitor {__version__}")
    args = ap.parse_args()

    logging.basicConfig(level=logging.DEBUG if args.verbose else logging.INFO,
                        format="%(asctime)s %(levelname)-7s %(message)s", datefmt="%H:%M:%S")

    if args.probe:
        proto, data = detect_protocol(args.probe)
        data["protocol_detectado"] = proto
        print(json.dumps(data, indent=2, ensure_ascii=False))
        return 0

    devices, rules = load_devices()
    for device in devices:
        device["connect_timeout"] = device.get("connect_timeout") or args.connect_timeout
    base = os.path.dirname(os.path.abspath(__file__))
    out_path = os.path.join(base, args.out)
    os.makedirs(os.path.dirname(out_path), exist_ok=True)

    if args.once:
        data = poll_once(devices, rules)
        print(json.dumps(data, indent=2, ensure_ascii=False))
        write_json_atomic(out_path, data)
        return 0 if all(d.get("online") for d in data["devices"].values()) else 1

    if args.http:
        start_http(args.http)

    automation_state: dict[str, bool] = {}
    last_ok: dict[str, str] = {}
    log.info("monitorando %d inversores a cada %.0fs (timeout %0.fs por dongle)",
             len(devices), args.interval, args.connect_timeout)
    try:
        while True:
            t0 = time.time()
            data = poll_once(devices, rules, automation_state, last_ok)
            with _State.lock:
                _State.latest = data
                _State.last_ok = time.time()
            write_json_atomic(out_path, data)
            for name, d in data["devices"].items():
                if d.get("online"):
                    b = d.get("battery", {})
                    auto = d.get("automation")
                    suffix = ""
                    if auto is not None:
                        suffix = "  -> %s" % ("LIGAR" if auto["should_run"] else "DESLIGAR")
                    log.info("%-14s %-9s SOC %3s%%  %5.1fV  %-8s%s",
                             name, d["protocol"], b.get("soc"), b.get("voltage", 0),
                             d.get("mode") or "", suffix)
                else:
                    log.warning("%-14s offline: %s", name, d.get("error"))
            time.sleep(max(1.0, args.interval - (time.time() - t0)))
    except KeyboardInterrupt:
        log.info("encerrando")
    return 0


if __name__ == "__main__":
    sys.exit(main())
