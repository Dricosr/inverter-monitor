#!/usr/bin/env python3
"""Exemplo de uso do inverter_monitor como biblioteca (sem a API HTTP).

    python examples/library_usage.py                 # todos os inversores
    python examples/library_usage.py 192.168.18.106  # um IP especifico
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import inverter_monitor as im  # noqa: E402


def ler(ip: str) -> None:
    print(f"\n=== {ip}")
    proto, dados = im.detect_protocol(ip)
    print(f"protocolo: {proto}")
    print(f"modo:      {dados.get('mode')}")
    bat = dados["battery"]
    print(f"bateria:   {bat['soc']}%  {bat['voltage']} V")
    if "current" in bat:
        print(f"corrente:  {bat['current']} A   potencia: {bat.get('power')} W")
    if "current_discharge" in bat:
        print(f"carga:     {bat['current_charge']} A   descarga: {bat['current_discharge']} A")
    saida = dados["output"]
    print(f"saida:     {saida['voltage']} V  {saida['active_power']} W")


if __name__ == "__main__":
    alvos = sys.argv[1:] or [ip for _, ip, _ in im.load_devices()[0]]
    for alvo in alvos:
        try:
            ler(alvo)
        except Exception as exc:
            print(f"{alvo}: {type(exc).__name__}: {exc}")
