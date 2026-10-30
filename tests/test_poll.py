"""Testes do ciclo de coleta com um inversor fora do ar (sem rede)."""
import json
import os
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import inverter_monitor as im  # noqa: E402

OK_READING = {
    "protocol": "modbus_a",
    "mode": "Off-Grid",
    "battery": {"soc": 55, "voltage": 52.0},
    "pv": {"voltage": 30.0, "current": 1.0, "power": 30.0},
    "output": {"active_power": 100, "apparent_power": 120},
}


class FakeLink:
    def __init__(self, *args, **kwargs):
        pass

    def close(self):
        pass


def fake_reader_ok(link):
    return json.loads(json.dumps(OK_READING))


def fake_reader_fail(link):
    raise TimeoutError("192.168.18.33 nao conectou de volta em 10s")


class TestPollComInversorOffline(unittest.TestCase):
    def devices(self):
        return [
            {"name": "morto", "ip": "10.0.0.1", "protocol": "modbus_a", "connect_timeout": 10},
            {"name": "vivo", "ip": "10.0.0.2", "protocol": "modbus_a", "connect_timeout": 10},
        ]

    def run_poll(self, last_ok=None, state=None):
        readers = {"modbus_a": fake_reader_fail}

        def reader_for(name):
            return fake_reader_ok if name == "vivo" else fake_reader_fail

        original = im.Dongle
        try:
            with mock.patch.object(im, "Dongle", FakeLink):
                results = {}
                for device in self.devices():
                    im.READERS["modbus_a"] = reader_for(device["name"])
                    partial = im.poll_once([device], {}, state, last_ok)
                    results.update(partial["devices"])
                return {"timestamp": "2026-10-30T08:00:00-03:00", "devices": results}
        finally:
            im.READERS["modbus_a"] = readers["modbus_a"]
            im.Dongle = original

    def test_inversor_morto_nao_impede_os_outros(self):
        data = self.run_poll()
        self.assertFalse(data["devices"]["morto"]["online"])
        self.assertTrue(data["devices"]["vivo"]["online"])
        self.assertEqual(data["devices"]["vivo"]["battery"]["soc"], 55)

    def test_offline_traz_motivo_e_ultima_leitura(self):
        data = self.run_poll()
        morto = data["devices"]["morto"]
        self.assertIn("error", morto)
        self.assertIn("nao conectou de volta", morto["error"])
        self.assertIn("last_ok", morto)
        self.assertIsNone(morto["last_ok"])

    def test_ultima_leitura_boa_e_preservada(self):
        last_ok = {"morto": "2026-10-30T07:59:00-03:00"}
        data = self.run_poll(last_ok=last_ok)
        self.assertEqual(data["devices"]["morto"]["last_ok"], "2026-10-30T07:59:00-03:00")

    def test_online_atualiza_o_last_ok(self):
        last_ok = {}
        data = self.run_poll(last_ok=last_ok)
        self.assertIn("vivo", last_ok)
        self.assertNotIn("last_ok", data["devices"]["vivo"])

    def test_offline_nao_gera_automacao(self):
        data = self.run_poll()
        self.assertNotIn("automation", data["devices"]["morto"])


class TestEscritaAtomica(unittest.TestCase):
    def test_grava_json_valido_e_sem_temporario(self):
        with tempfile.TemporaryDirectory() as directory:
            target = os.path.join(directory, "latest.json")
            im.write_json_atomic(target, {"devices": {"x": {"online": True}}})
            with open(target, encoding="utf-8") as fh:
                self.assertEqual(json.load(fh)["devices"]["x"]["online"], True)
            leftovers = [n for n in os.listdir(directory) if n.endswith(".tmp")]
            self.assertEqual(leftovers, [])


if __name__ == "__main__":
    unittest.main()
