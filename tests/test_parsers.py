"""Testes offline dos parsers e do framing (nenhum acesso a rede).

Rodar:  python -m unittest discover -s tests -v
"""
import os
import struct
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import inverter_monitor as im  # noqa: E402


class TestCrc(unittest.TestCase):
    def test_modbus_crc_conhecido(self):
        # frame lido de um inversor real: 01 03 00 C8 00 28 + CRC
        self.assertEqual(im.crc16_modbus(bytes.fromhex("010300C80028")), bytes.fromhex("C42A"))

    def test_pi30_crc_de_qpigs(self):
        # QPIGS -> 51 50 49 47 53 B7 A9 0D (init 0x0000, nao 0xFFFF)
        self.assertEqual(im.pi30(b"QPIGS"), bytes.fromhex("5150494753B7A90D"))

    def test_pi30_crc_de_qmod(self):
        self.assertEqual(im.pi30(b"QMOD"), bytes.fromhex("514D4F4449C10D"))

    def test_correcao_dos_bytes_especiais(self):
        # a regra do PI30 soma 1 em 0x28, 0x0D e 0x0A no CRC
        for payload in (b"A", b"AB", b"ABC", b"QPIGS2"):
            for b in im.crc16_pi30(payload):
                self.assertNotIn(b, (0x28, 0x0D, 0x0A))


class TestFraming(unittest.TestCase):
    def test_frame_eybond(self):
        f = im.eb_frame(0xE101, 4, b"\x01\x02\x03")
        self.assertEqual(f[:8], bytes.fromhex("E10100010005FF04"))
        self.assertEqual(f[8:], b"\x01\x02\x03")

    def test_frame_campo_len(self):
        f = im.eb_frame(1, 4, b"abcdef")
        _, _, length, _, fc = struct.unpack(">HHHBB", f[:8])
        self.assertEqual(length, len(b"abcdef") + 2)
        self.assertEqual(fc, 4)

    def test_rtu_read(self):
        self.assertEqual(im.rtu_read(1, 200, 10), bytes.fromhex("010300C8000A4433"))


class TestParseModbusA(unittest.TestCase):
    """Bloco real capturado de um inversor (regs 200-244)."""

    REGS = [
        0xB000, 3, 2229, 5999, 0, 2302, 19, 5999, 15, 0,
        2302, 3, 5999, 5, 69, 531, 0, 0, 3700, 288,
        0, 0, 0, 0, 0, 1, 29, 30, 26, 52,
        0, 96, 0, 0, 0, 0, 0, 0, 0, 0,
        0, 0, 0, 0, 0,
    ]

    def test_campos_principais(self):
        d = im.parse_modbus_a(self.REGS)
        self.assertEqual(d["protocol"], "modbus_a")
        self.assertEqual(d["mode"], "Off-Grid")
        self.assertEqual(d["battery"]["soc"], 52)
        self.assertAlmostEqual(d["battery"]["voltage"], 53.1)
        self.assertAlmostEqual(d["grid"]["voltage"], 222.9)
        self.assertAlmostEqual(d["grid"]["frequency"], 59.99)
        self.assertAlmostEqual(d["output"]["voltage"], 230.2)
        self.assertEqual(d["temperature"], {"dcdc": 29, "inverter": 30})

    def test_modo_desconhecido_nao_quebra(self):
        regs = list(self.REGS)
        regs[1] = 99
        self.assertEqual(im.parse_modbus_a(regs)["mode"], "desconhecido(99)")


class TestParseModbusB(unittest.TestCase):
    """Blocos reais capturados (bateria 277-281, saida 252-255)."""

    BAT = [521, 0xFFD6, 0xFF26, 54, 33]     # 52.1 V, -4.2 A, -218 W, 54%, 33 C
    OUT = [12, 6000, 179, 287]
    GRID = [0, 0]
    AC = [2400, 49]
    PV = {"pv1": 33.5, "pv2": 32.8}

    def test_bateria(self):
        d = im.parse_modbus_b(self.BAT, self.OUT, self.GRID, self.AC, self.PV)
        self.assertEqual(d["battery"]["soc"], 54)
        self.assertAlmostEqual(d["battery"]["voltage"], 52.1)
        self.assertAlmostEqual(d["battery"]["current"], -4.2)
        self.assertEqual(d["battery"]["power"], -218)

    def test_saida_e_pv(self):
        d = im.parse_modbus_b(self.BAT, self.OUT, self.GRID, self.AC, self.PV)
        self.assertAlmostEqual(d["output"]["voltage"], 240.0)
        self.assertAlmostEqual(d["output"]["current"], 1.2)
        self.assertAlmostEqual(d["output"]["frequency"], 60.0)
        self.assertEqual(d["output"]["active_power"], 179)
        self.assertAlmostEqual(d["pv"]["voltage"], 33.5)
        self.assertAlmostEqual(d["pv"]["voltage2"], 32.8)

    def test_rede_ausente_vira_none(self):
        d = im.parse_modbus_b(self.BAT, self.OUT, [0, 0], self.AC, self.PV)
        self.assertIsNone(d["grid"]["voltage"])
        self.assertIsNone(d["grid"]["frequency"])

    def test_modo_temperatura_e_carga(self):
        d = im.parse_modbus_b(self.BAT, self.OUT, self.GRID, self.AC, self.PV,
                              status=[0xB000, 3], load_percent=[3])
        self.assertEqual(d["mode"], "Off-Grid")
        self.assertEqual(d["status_code"], 3)
        self.assertEqual(d["temperature"]["inverter"], 49)
        self.assertEqual(d["load_percent"], 3)

    def test_sem_registradores_opcionais_nao_quebra(self):
        d = im.parse_modbus_b(self.BAT, self.OUT, self.GRID, self.AC, self.PV)
        self.assertIsNone(d["mode"])
        self.assertIsNone(d["status_code"])
        self.assertIsNone(d["load_percent"])

    def test_potencia_pv_somando_as_duas_entradas(self):
        pv = {"pv1": 25.6, "pv2": 24.6, "pv1_current": 2.0, "pv2_current": 1.0}
        d = im.parse_modbus_b(self.BAT, self.OUT, self.GRID, self.AC, pv)
        self.assertAlmostEqual(d["pv"]["current"], 3.0)
        self.assertAlmostEqual(d["pv"]["power"], 75.8)  # 25.6*2 + 24.6*1

    def test_potencia_pv_sem_corrente_fica_none(self):
        d = im.parse_modbus_b(self.BAT, self.OUT, self.GRID, self.AC, self.PV)
        self.assertIsNone(d["pv"]["power"])
        self.assertIsNone(d["pv"]["current"])

    def test_corrente_pv_implausivel_e_descartada(self):
        pv = {"pv1": 25.6, "pv2": None, "pv1_current": 999.0, "pv2_current": None}
        d = im.parse_modbus_b(self.BAT, self.OUT, self.GRID, self.AC, pv)
        self.assertIsNone(d["pv"]["power"])


class TestParsePi30(unittest.TestCase):
    """Resposta QPIGS real, com CRC e CR no fim."""

    RAW = ("(000.0 00.0 231.3 60.0 1175 0983 013 414 52.20 000 040 0047 "
           "00.0 000.0 52.20 00022 00010000 00 00 00000 010\xbe\xac\r")

    def test_campos(self):
        d = im.parse_qpigs(self.RAW, "B", "55355535553555")
        self.assertEqual(d["protocol"], "pi30")
        self.assertEqual(d["mode"], "Battery")
        self.assertEqual(d["serial"], "55355535553555")
        self.assertEqual(d["battery"]["soc"], 40)
        self.assertAlmostEqual(d["battery"]["voltage"], 52.20)
        self.assertAlmostEqual(d["battery"]["current_discharge"], 22.0)
        self.assertAlmostEqual(d["output"]["voltage"], 231.3)
        self.assertEqual(d["output"]["apparent_power"], 1175)
        self.assertEqual(d["output"]["active_power"], 983)
        self.assertEqual(d["load_percent"], 13)
        self.assertEqual(d["bus_voltage"], 414)
        self.assertEqual(d["temperature"]["inverter"], 47)

    def test_resposta_invalida(self):
        with self.assertRaises(ValueError):
            im.parse_qpigs("(NAKss\r")

    def test_potencia_pv_calculada(self):
        raw = ("(000.0 00.0 231.3 60.0 1175 0983 013 414 52.20 000 040 0047 "
               "02.5 320.0 52.20 00022 00010000 00 00 00000 010\xbe\xac\r")
        d = im.parse_qpigs(raw, "B")
        self.assertAlmostEqual(d["pv"]["voltage"], 320.0)
        self.assertAlmostEqual(d["pv"]["current"], 2.5)
        self.assertAlmostEqual(d["pv"]["power"], 800.0)
        self.assertIsNone(d["pv"]["power_estimated"])

    def test_pv_sem_corrente_usa_estimativa_pelo_balanco(self):
        # leitura real do MPS 10.2: corrente PV sempre 00.0, carga em 9 A
        raw = ("(000.0 00.0 229.8 60.0 0482 0310 005 436 52.80 009 046 0061 "
               "00.0 045.2 52.80 00000 00010110 00 00 00000 010\xd8\x7e\r")
        d = im.parse_qpigs(raw, "B")
        self.assertAlmostEqual(d["pv"]["voltage"], 45.2)
        self.assertEqual(d["pv"]["current"], 0.0)
        self.assertIsNone(d["pv"]["power"], "nao pode afirmar 0 W sem corrente")
        # 310 W de saida + 9 A * 52,8 V de carga = 785,2 W
        self.assertAlmostEqual(d["pv"]["power_estimated"], 785.2)
        self.assertAlmostEqual(d["battery"]["power"], 475.2)

    def test_estimativa_desconta_descarga(self):
        raw = ("(000.0 00.0 229.8 60.0 0482 0300 005 436 52.00 000 046 0061 "
               "00.0 040.0 52.00 00010 00010110 00 00 00000 010\xd8\x7e\r")
        d = im.parse_qpigs(raw, "B")
        # 300 W de saida - 10 A * 52 V vindos da bateria = -220 -> piso em 0
        self.assertAlmostEqual(d["pv"]["power_estimated"], 0.0)

    def test_sem_sol_nao_estima(self):
        raw = ("(000.0 00.0 229.8 60.0 0482 0300 005 436 52.00 000 046 0061 "
               "00.0 000.0 52.00 00000 00010110 00 00 00000 010\xd8\x7e\r")
        d = im.parse_qpigs(raw, "B")
        self.assertEqual(d["pv"]["power"], 0.0)
        self.assertIsNone(d["pv"]["power_estimated"])

    def test_potencia_da_bateria_calculada(self):
        d = im.parse_qpigs(self.RAW, "B")
        # 52.20 V * (0 A carga - 22 A descarga) = -1148.4 W
        self.assertAlmostEqual(d["battery"]["power"], -1148.4)

    def test_campos_faltando_nao_quebram(self):
        d = im.parse_qpigs("(000.0 00.0 231.3 60.0\r")
        self.assertAlmostEqual(d["output"]["voltage"], 231.3)
        self.assertEqual(d["battery"]["soc"], 0)


class TestPlausibilidade(unittest.TestCase):
    def test_valores_ok(self):
        self.assertTrue(im._plausible({"battery": {"soc": 50, "voltage": 52.0}}))

    def test_leitura_zerada_e_rejeitada(self):
        # o mapa "errado" costuma responder tudo zero
        self.assertFalse(im._plausible({"battery": {"soc": 0, "voltage": 0.0}}))

    def test_sem_campos(self):
        self.assertFalse(im._plausible({}))


if __name__ == "__main__":
    unittest.main()
