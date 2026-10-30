#!/usr/bin/env python3
"""Le um mapa de registradores de docs/maps e imprime os valores de um inversor.

Serve para quem quer conferir os mapas contra o proprio equipamento, ou para
descobrir o que mudou depois de uma atualizacao de firmware.

    python examples/dump_map.py --ip 192.168.18.59 --map docs/maps/modbus_b_anenji.json
    python examples/dump_map.py --ip 192.168.18.106 --map docs/maps/modbus_0925_smg.json --json

O mapa JSON e a fonte da verdade; este script nao tem nenhum endereco embutido.
"""
from __future__ import annotations

import argparse
import json
import os
import struct
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import inverter_monitor as im  # noqa: E402


def read_block(link: im.Dongle, slave: int, function: int, start: int, count: int,
               swap: bool, gap: float) -> list[int]:
    time.sleep(gap)
    body = struct.pack(">BBHH", slave, function, start, count)
    response = link.ask(4, body + im.crc16_modbus(body))
    if len(response) < 5 or response[1] & 0x80:
        raise ValueError(f"resposta Modbus invalida: {response.hex(' ')}")
    data = response[3:3 + response[2]]
    if swap:
        return [data[i] | (data[i + 1] << 8) for i in range(0, len(data) - 1, 2)]
    return [data[i] << 8 | data[i + 1] for i in range(0, len(data) - 1, 2)]


def decode(registers: list[int], base: int, spec: dict, swap: bool):
    address = spec["address"]
    offset = address - base
    if offset < 0 or offset >= len(registers):
        return None
    count = spec.get("count", 1)

    if spec.get("type") == "ascii":
        texto = "".join(chr((v >> 8) & 0xFF) + chr(v & 0xFF) for v in registers[offset:offset + count])
        return texto.split("\x00")[0].strip() or None

    if count > 1:
        return registers[offset:offset + count]

    value = registers[offset]
    if spec.get("signed"):
        value = im.s16(value)
    scale = spec.get("scale", 1)
    if spec.get("type") == "enum":
        return spec.get("enum", {}).get(str(value), value)
    return round(value * scale, 3) if scale != 1 else value


def main() -> int:
    parser = argparse.ArgumentParser(description="Le um mapa de registradores do repositorio")
    parser.add_argument("--ip", required=True, help="IP do dongle")
    parser.add_argument("--map", required=True, dest="mapfile", help="arquivo JSON do mapa")
    parser.add_argument("--json", action="store_true", help="saida em JSON")
    parser.add_argument("--connect-timeout", type=float, default=20.0)
    args = parser.parse_args()

    with open(args.mapfile, encoding="utf-8") as handle:
        definition = json.load(handle)

    transport = definition["transport"]
    if transport.get("kind") != "modbus_rtu":
        print(f"{definition['title']} nao e um mapa Modbus; veja docs/REGISTER-MAPS.md",
              file=sys.stderr)
        return 2

    slave = transport.get("slave", 1)
    function = transport.get("function_code", 3)
    swap = bool(transport.get("word_swap"))
    gap = transport.get("gap_between_reads_ms", 50) / 1000
    names = {read["key"]: read for read in transport["reads"]}

    link = im.Dongle(args.ip, connect_timeout=args.connect_timeout)
    blocos: dict = {}
    saida: dict = {}
    try:
        for spec in definition["registers"]:
            # usa o bloco que cobre o registrador
            bloco = next((read for read in names.values()
                          if read["start"] <= spec["address"] < read["start"] + read["count"]), None)
            if bloco is None:
                continue
            if bloco["key"] not in blocos:
                blocos[bloco["key"]] = read_block(link, slave, function, bloco["start"],
                                                  bloco["count"], swap, gap)
            valor = decode(blocos[bloco["key"]], bloco["start"], spec, swap)
            if valor is not None:
                saida[spec["key"]] = valor
    finally:
        link.close()

    if args.json:
        print(json.dumps(saida, indent=2, ensure_ascii=False))
        return 0

    print(f"\n{definition['title']}  ({args.ip}, slave {slave}, fc {function}, "
          f"{'bytes trocados' if swap else 'big-endian'})\n")
    for spec in definition["registers"]:
        if spec["key"] not in saida:
            continue
        unit = f" {spec['unit']}" if spec.get("unit") else ""
        evidencia = spec.get("evidence", "")
        print(f"  {spec['address']:>5}  {spec['name']:<38} {str(saida[spec['key']]) + unit:<16} [{evidencia}]")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
