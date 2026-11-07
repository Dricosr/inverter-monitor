"""Testes do ciclo de coleta com um inversor fora do ar (sem rede)."""
import json
import os
import sys
import tempfile
import threading
import time
import unittest
from datetime import datetime
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
        # `last_ok` agora e publicado tambem quando o inversor responde: e a referencia
        # para a UI dizer ha quanto tempo um valor parou de ser atualizado.
        self.assertEqual(data["devices"]["vivo"]["last_ok"], last_ok["vivo"])

    def test_offline_nao_gera_automacao(self):
        data = self.run_poll()
        self.assertNotIn("automation", data["devices"]["morto"])


class TestUltimoValorValido(unittest.TestCase):
    """Leitura que falha nao apaga o painel: o valor anterior volta marcado como velho."""

    def poll(self, reader, history, last_ok=None):
        with mock.patch.object(im, "Dongle", FakeLink), \
                mock.patch.dict(im.READERS, {"modbus_a": reader}):
            return im.poll_once([{"name": "x", "ip": "10.0.0.9", "protocol": "modbus_a"}],
                                {}, {}, last_ok if last_ok is not None else {}, history)

    def test_ciclo_bom_enche_o_historico(self):
        history = {}
        self.poll(fake_reader_ok, history)
        self.assertIn("x", history)
        self.assertEqual(history["x"]["values"]["battery"]["soc"], 55)
        self.assertIn("battery.soc", history["x"]["fields_at"])
        self.assertNotIn("online", history["x"]["values"], "metadados do ciclo nao entram")

    def test_campo_nunca_lido_nao_vira_valor_velho(self):
        """`None` no cache nao e "ultimo valor valido": nao pode ganhar idade na UI."""
        history = {}
        parcial = {
            "protocol": "modbus_b",
            "battery": {"soc": 62, "voltage": 52.7},
            "grid": {"voltage": None, "frequency": None},
            "pv": {"power": 100.0},
            "output": {"active_power": 10},
        }

        def leitor(link):
            return json.loads(json.dumps(parcial))

        self.poll(leitor, history)
        depois = self.poll(leitor, history)
        self.assertNotIn("cache", depois["devices"]["x"], "nada foi reaproveitado")
        self.assertIsNone(depois["devices"]["x"]["grid"]["voltage"])

    def test_anotacao_nao_vira_valor_velho(self):
        """Anotar COMO um valor foi obtido nao pode envelhecer o MPPT inteiro.

        Caso real (31/10 15:56 → 01/11): num ciclo o ASCII do `.106` falhou e a leitura
        saiu so do mapa 0925, que anota `power_source`, `current_source` e
        `current_partial`. Essas chaves nao existem no regime normal, entao o cache as
        repunha todo ciclo — sempre com o carimbo de 15:56 — e o painel mostrava o MPPT1
        como "sem atualizacao ha 19 h" com o inversor lendo normalmente.
        """
        history = {}
        so_0925 = {
            "protocol": "pi30_smg",
            "battery": {"soc": 50, "voltage": 53.0},
            "pv": {
                "power": 500.0, "mppt": 1, "mppt_count": 2, "mppt_unreadable": [2],
                "power_source": "soma dos MPPT",
                "inputs": [
                    {"mppt": 1, "voltage": 300.0, "current": 1.7, "power": 500,
                     "readable": True, "power_source": "modbus 0925 (reg 4505)",
                     "current_source": "derivada (W ÷ V)"},
                    {"mppt": 2, "voltage": None, "current": None, "power": None,
                     "readable": False, "reason": "0935 mudo"},
                ],
            },
            "output": {"active_power": 200},
            "modbus_smg": True,
        }
        completo = {
            "protocol": "pi30_smg",
            "battery": {"soc": 50, "voltage": 53.0},
            "pv": {
                "power": 600.0, "mppt": 1, "mppt_count": 2, "mppt_unreadable": [],
                "inputs": [
                    {"mppt": 1, "voltage": 300.0, "current": 2.0, "power": 600, "readable": True},
                    {"mppt": 2, "voltage": 280.0, "current": 0.0, "power": 0, "readable": True},
                ],
            },
            "output": {"active_power": 200},
            "modbus_smg": True,
        }

        with mock.patch.object(im, "Dongle", FakeLink):
            with mock.patch.dict(im.READERS, {"pi30_smg": lambda link: json.loads(json.dumps(so_0925))}):
                im.poll_once([{"name": "x", "ip": "10.0.0.9", "protocol": "pi30_smg"}], {}, {}, {}, history)
            with mock.patch.dict(im.READERS, {"pi30_smg": lambda link: json.loads(json.dumps(completo))}):
                depois = im.poll_once([{"name": "x", "ip": "10.0.0.9", "protocol": "pi30_smg"}],
                                      {}, {}, {}, history)

        entrada = depois["devices"]["x"]
        self.assertNotIn("cache", entrada, "nada faltou: a leitura foi completa")
        self.assertNotIn("power_source", entrada["pv"])
        self.assertNotIn("current_source", entrada["pv"]["inputs"][0])
        self.assertEqual(entrada["pv"]["inputs"][0]["power"], 600)

        # E as anotacoes nunca entram no historico, senao voltam no ciclo seguinte.
        self.assertNotIn("modbus_smg", history["x"]["values"])
        self.assertNotIn("power_source", history["x"]["values"]["pv"])
        for path in history["x"]["fields_at"]:
            self.assertNotRegex(path, r"power_source|current_source|current_partial|modbus_smg")

    def test_offline_mantem_o_ultimo_valor_e_diz_a_idade(self):
        history = {}
        self.poll(fake_reader_ok, history)
        depois = self.poll(fake_reader_fail, history)
        entrada = depois["devices"]["x"]

        self.assertFalse(entrada["online"])
        self.assertIn("nao conectou", entrada["error"])
        self.assertEqual(entrada["battery"]["soc"], 55, "o ultimo SOC valido continua publicado")
        self.assertEqual(entrada["output"]["active_power"], 100)
        self.assertEqual(entrada["cache"]["at"], history["x"]["at"])
        self.assertIn("battery.soc", entrada["cache"]["fields"])
        self.assertIn("output.active_power", entrada["cache"]["fields"])
        self.assertNotIn("reason", entrada["cache"]["fields"])

    def test_falha_nao_estraga_o_historico(self):
        history = {}
        self.poll(fake_reader_ok, history)
        antes = json.dumps(history["x"], sort_keys=True)
        self.poll(fake_reader_fail, history)
        self.poll(fake_reader_fail, history)
        self.assertEqual(json.dumps(history["x"], sort_keys=True), antes,
                         "a idade continua contada desde a ultima leitura boa")

    def test_leitura_parcial_completa_so_o_que_faltou(self):
        history = {}
        self.poll(fake_reader_ok, history)

        parcial = {
            "protocol": "modbus_a",
            "battery": {"soc": 54, "voltage": 51.9},
            "pv": {"power": 25.0},
            "output": {},  # a saida nao veio neste ciclo
        }

        def leitor_parcial(link):
            return json.loads(json.dumps(parcial))

        depois = self.poll(leitor_parcial, history)
        entrada = depois["devices"]["x"]
        self.assertTrue(entrada["online"])
        self.assertEqual(entrada["battery"]["soc"], 54, "o que veio agora tem prioridade")
        self.assertEqual(entrada["output"]["active_power"], 100, "o que faltou vem do cache")
        stale = entrada["cache"]["fields"]
        self.assertIn("output.active_power", stale)
        self.assertNotIn("battery.soc", stale)
        # O que veio do cache continua contado desde a leitura de origem.
        self.assertEqual(stale["output.active_power"], history["x"]["fields_at"]["output.active_power"])

    def test_entrada_pv_do_cache_deixa_de_ser_nao_exposta(self):
        history = {}
        completo = {
            "protocol": "pi30_smg",
            "battery": {"soc": 60, "voltage": 53.4},
            "pv": {
                "power": 3455.0, "mppt_count": 2, "mppt_unreadable": [],
                "inputs": [
                    {"mppt": 1, "voltage": 48.9, "current": 0.0, "power": 0.0, "readable": True},
                    {"mppt": 2, "voltage": 301.0, "current": 11.5, "power": 3455,
                     "readable": True, "current_source": "derivada"},
                ],
            },
            "output": {"active_power": 829},
        }
        com_0925_mudo = {
            "protocol": "pi30_smg",
            "battery": {"soc": 60, "voltage": 53.4},
            "pv": {
                "power": 0.0, "mppt": 1, "mppt_count": 2, "mppt_unreadable": [2],
                "power_source": "PI30 (apenas o MPPT1)",
                "inputs": [
                    {"mppt": 1, "voltage": 48.9, "current": 0.0, "power": 0.0, "readable": True},
                    {"mppt": 2, "voltage": None, "current": None, "power": None,
                     "readable": False, "reason": "o firmware deste modelo não expõe o MPPT2"},
                ],
            },
            "output": {"active_power": 829},
        }

        with mock.patch.object(im, "Dongle", FakeLink):
            with mock.patch.dict(im.READERS, {"pi30_smg": lambda link: json.loads(json.dumps(completo))}):
                im.poll_once([{"name": "x", "ip": "10.0.0.9", "protocol": "pi30_smg"}],
                             {}, {}, {}, history)
            with mock.patch.dict(im.READERS, {"pi30_smg": lambda link: json.loads(json.dumps(com_0925_mudo))}):
                depois = im.poll_once([{"name": "x", "ip": "10.0.0.9", "protocol": "pi30_smg"}],
                                      {}, {}, {}, history)

        entrada = depois["devices"]["x"]
        mppt2 = entrada["pv"]["inputs"][1]
        self.assertTrue(mppt2["readable"], "o valor existe: nao pode aparecer como nao exposto")
        self.assertEqual(mppt2["power"], 3455)
        self.assertNotIn("reason", mppt2)
        self.assertEqual(entrada["pv"]["mppt_unreadable"], [])
        self.assertNotIn("power_source", entrada["pv"])
        self.assertIn("pv.inputs.1.power", entrada["cache"]["fields"])
        self.assertNotIn("pv.inputs.0.power", entrada["cache"]["fields"])


class TestMomentoDoTimestamp(unittest.TestCase):
    """O carimbo marca o FIM do ciclo: e quando o dado passa a existir."""

    def test_timestamp_marca_o_fim_e_nao_o_inicio(self):
        lento = {"protocol": "modbus_a", "battery": {"soc": 50, "voltage": 52.0}}

        def leitor_lento(link):
            time.sleep(1.6)
            return json.loads(json.dumps(lento))

        inicio = time.time()
        with mock.patch.object(im, "Dongle", FakeLink), \
                mock.patch.dict(im.READERS, {"modbus_a": leitor_lento}):
            data = im.poll_once([{"name": "x", "ip": "10.0.0.9", "protocol": "modbus_a"}], {}, {}, {})
        fim = time.time()

        # O carimbo trunca para segundos, entao a comparacao tem 1 s de folga. Se ele
        # fosse do inicio do ciclo viria em floor(inicio), abaixo de inicio + 0,5.
        marcado = datetime.fromisoformat(data["timestamp"]).timestamp()
        self.assertGreaterEqual(marcado, inicio + 0.5)
        self.assertLessEqual(marcado, fim + 1)

    def test_last_ok_do_inversor_nao_usa_o_carimbo_do_ciclo(self):
        last_ok = {}
        with mock.patch.object(im, "Dongle", FakeLink), \
                mock.patch.dict(im.READERS, {"modbus_a": fake_reader_ok}):
            data = im.poll_once([{"name": "vivo", "ip": "10.0.0.2", "protocol": "modbus_a"}],
                                {}, {}, last_ok)
        self.assertEqual(last_ok["vivo"], data["timestamp"])


class TestRunCycle(unittest.TestCase):
    def test_publica_estado_e_grava_arquivo(self):
        with tempfile.TemporaryDirectory() as directory:
            alvo = os.path.join(directory, "latest.json")
            im._State.cycle = None
            with mock.patch.object(im, "Dongle", FakeLink), \
                    mock.patch.dict(im.READERS, {"modbus_a": fake_reader_ok}):
                data = im.run_cycle([{"name": "vivo", "ip": "10.0.0.2", "protocol": "modbus_a"}],
                                    {}, {}, {}, alvo)
            self.assertTrue(data["devices"]["vivo"]["online"])
            self.assertEqual(im._State.latest["timestamp"], data["timestamp"])
            with open(alvo, encoding="utf-8") as fh:
                self.assertEqual(json.load(fh)["devices"]["vivo"]["battery"]["soc"], 55)

    def test_ciclos_nao_se_sobrepoem(self):
        """Dois ciclos simultaneos brigariam pela porta 8899 do dongle."""
        dentro = {"atual": 0, "maximo": 0}
        trava = threading.Lock()

        def leitor_espiao(link):
            with trava:
                dentro["atual"] += 1
                dentro["maximo"] = max(dentro["maximo"], dentro["atual"])
            time.sleep(0.2)
            with trava:
                dentro["atual"] -= 1
            return json.loads(json.dumps(OK_READING))

        aparelho = [{"name": "vivo", "ip": "10.0.0.2", "protocol": "modbus_a"}]
        with mock.patch.object(im, "Dongle", FakeLink), \
                mock.patch.dict(im.READERS, {"modbus_a": leitor_espiao}):
            fios = [threading.Thread(target=im.run_cycle, args=(aparelho, {}, {}, {}, None))
                    for _ in range(3)]
            for fio in fios:
                fio.start()
            for fio in fios:
                fio.join()
        self.assertEqual(dentro["maximo"], 1)


class TestReinicio(unittest.TestCase):
    """Reiniciar o coletor nao pode apagar o painel."""

    def test_recupera_estado_do_snapshot_anterior(self):
        with tempfile.TemporaryDirectory() as directory:
            alvo = os.path.join(directory, "latest.json")
            with mock.patch.object(im, "Dongle", FakeLink), \
                    mock.patch.dict(im.READERS, {"modbus_a": fake_reader_ok}):
                anterior = im.poll_once(
                    [{"name": "x", "ip": "10.0.0.9", "protocol": "modbus_a"}], {}, {}, {})
            im.write_json_atomic(alvo, anterior)

            last_ok, history = im.history_from_snapshot(alvo)
            self.assertIn("x", history)
            self.assertEqual(last_ok["x"], anterior["devices"]["x"]["last_ok"])
            self.assertEqual(history["x"]["values"]["battery"]["soc"], 55)
            self.assertNotIn("online", history["x"]["values"])
            self.assertIn("output.active_power", history["x"]["fields_at"])

            # Primeiro ciclo apos o reinicio falha: o painel mantem o que veio do disco.
            with mock.patch.object(im, "Dongle", FakeLink), \
                    mock.patch.dict(im.READERS, {"modbus_a": fake_reader_fail}):
                primeiro = im.poll_once(
                    [{"name": "x", "ip": "10.0.0.9", "protocol": "modbus_a"}],
                    {}, {}, last_ok, history)
            entrada = primeiro["devices"]["x"]
            self.assertFalse(entrada["online"])
            self.assertEqual(entrada["battery"]["soc"], 55)
            self.assertIn("battery.soc", entrada["cache"]["fields"])

    def test_arquivo_ausente_ou_corrompido_nao_quebra(self):
        with tempfile.TemporaryDirectory() as directory:
            self.assertEqual(im.history_from_snapshot(os.path.join(directory, "nao.json")), ({}, {}))
            quebrado = os.path.join(directory, "quebrado.json")
            with open(quebrado, "w", encoding="utf-8") as fh:
                fh.write("{ isso nao e json")
            self.assertEqual(im.history_from_snapshot(quebrado), ({}, {}))

    def test_limpa_temporarios_de_escrita_abortada(self):
        with tempfile.TemporaryDirectory() as directory:
            alvo = os.path.join(directory, "latest.json")
            im.write_json_atomic(alvo, {"devices": {}})
            restos = [os.path.join(directory, f"latest.json.{pid}.tmp") for pid in (111, 222)]
            for path in restos:
                with open(path, "w", encoding="utf-8") as fh:
                    fh.write('{"devices": {"x": {"onl')
            sobras = im.cleanup_tmp_files(alvo)
            self.assertEqual(len(sobras), 2, "os restos sao reportados no log")
            self.assertEqual([p for p in os.listdir(directory) if p.endswith(".tmp")], [])
            self.assertTrue(os.path.exists(alvo), "o snapshot bom continua intacto")


class TestEscritaAtomica(unittest.TestCase):
    def test_grava_json_valido_e_sem_temporario(self):
        with tempfile.TemporaryDirectory() as directory:
            target = os.path.join(directory, "latest.json")
            im.write_json_atomic(target, {"devices": {"x": {"online": True}}})
            with open(target, encoding="utf-8") as fh:
                self.assertEqual(json.load(fh)["devices"]["x"]["online"], True)
            leftovers = [n for n in os.listdir(directory) if n.endswith(".tmp")]
            self.assertEqual(leftovers, [])

class TestReconexaoEBackoff(unittest.TestCase):
    """Sessao contaminada se resolve trocando de sessao; falha persistente ganha espera.

    Medido no `.106` (07/11/2026): insistir na MESMA sessao nunca funcionava — as
    falhas vinham como `(NAKss` em 435 ms ou frame vazio em 8,1 s. Reabrir a conexao
    entregava leitura completa (QPIGS em 860 ms + Modbus de 64 registradores).
    """

    def test_read_device_troca_de_sessao_e_da_certo_na_segunda(self):
        tentativas = {"n": 0}

        def leitor(link):
            tentativas["n"] += 1
            if tentativas["n"] == 1:
                raise TimeoutError("frame vazio")
            return json.loads(json.dumps(OK_READING))

        with mock.patch.object(im, "Dongle", FakeLink), \
                mock.patch.object(im, "_read_once", lambda proto, ip, tmo: leitor(None)):
            dados = im.read_device("modbus_a", "10.0.0.9", 5, attempts=3, settle=0)
        self.assertEqual(tentativas["n"], 2, "trocou de sessao uma vez")
        self.assertEqual(dados["battery"]["soc"], 55)

    def test_read_device_desiste_depois_das_tentativas(self):
        chamadas = {"n": 0}

        def sempre_falha(proto, ip, tmo):
            chamadas["n"] += 1
            raise TimeoutError("sem resposta")

        with mock.patch.object(im, "_read_once", sempre_falha):
            with self.assertRaises(TimeoutError):
                im.read_device("modbus_a", "10.0.0.9", 5, attempts=3, settle=0)
        self.assertEqual(chamadas["n"], 3)

    def test_falha_agenda_backoff_crescente(self):
        backoff = {}
        aparelho = [{"name": "x", "ip": "10.0.0.9", "protocol": "modbus_a"}]

        def ciclo():
            # Zera o relogio da espera para este ciclo realmente tentar ler de novo.
            if "x" in backoff:
                backoff["x"]["until"] = 0.0
            with mock.patch.object(im, "Dongle", FakeLink), \
                    mock.patch.dict(im.READERS, {"modbus_a": fake_reader_fail}):
                return im.poll_once(aparelho, {}, {}, {}, {}, backoff)

        self.assertEqual(ciclo()["devices"]["x"]["backoffSeconds"], 15)
        self.assertEqual(ciclo()["devices"]["x"]["backoffSeconds"], 30, "espera dobra")
        self.assertEqual(ciclo()["devices"]["x"]["backoffSeconds"], 60)
        self.assertEqual(ciclo()["devices"]["x"]["backoffSeconds"], 60, "teto de 1 min")

    def test_durante_o_backoff_o_inversor_nao_e_lido_e_mantem_o_ultimo_valor(self):
        backoff = {}
        aparelho = [{"name": "x", "ip": "10.0.0.9", "protocol": "modbus_a"}]
        history = {}
        with mock.patch.object(im, "Dongle", FakeLink), \
                mock.patch.dict(im.READERS, {"modbus_a": fake_reader_ok}):
            im.poll_once(aparelho, {}, {}, {}, history, backoff)
        self.assertEqual(history["x"]["values"]["battery"]["soc"], 55)

        # Agora falha: agenda a espera.
        with mock.patch.object(im, "Dongle", FakeLink), \
                mock.patch.dict(im.READERS, {"modbus_a": fake_reader_fail}):
            im.poll_once(aparelho, {}, {}, {}, history, backoff)

        # No ciclo seguinte, ainda em espera: nao tenta ler e devolve o cache.
        tentou = {"n": 0}

        def espiao(link):
            tentou["n"] += 1
            return json.loads(json.dumps(OK_READING))

        with mock.patch.object(im, "Dongle", FakeLink), \
                mock.patch.dict(im.READERS, {"modbus_a": espiao}):
            durante = im.poll_once(aparelho, {}, {}, {}, history, backoff)

        entrada = durante["devices"]["x"]
        self.assertEqual(tentou["n"], 0, "nao insiste enquanto espera")
        self.assertTrue(entrada["backoff"])
        self.assertIn("aguardando recuperacao", entrada["error"])
        self.assertEqual(entrada["battery"]["soc"], 55, "painel nao fica vazio")
        self.assertIn("battery.soc", entrada["cache"]["fields"])

    def test_sucesso_zera_o_backoff(self):
        backoff = {"x": {"fails": 3, "until": 0.0}}
        aparelho = [{"name": "x", "ip": "10.0.0.9", "protocol": "modbus_a"}]
        with mock.patch.object(im, "Dongle", FakeLink), \
                mock.patch.dict(im.READERS, {"modbus_a": fake_reader_ok}):
            dados = im.poll_once(aparelho, {}, {}, {}, {}, backoff)
        self.assertTrue(dados["devices"]["x"]["online"])
        self.assertEqual(backoff["x"]["fails"], 0)
        self.assertEqual(backoff["x"]["until"], 0.0)


class TestBlocoLeTruncado(unittest.TestCase):
    """`_modbus_block_le` nao pode devolver lista curta em silencio."""

    def test_bloco_curto_levanta(self):
        class Link:
            def ask(self, fc, payload, timeout=None):  # noqa: ARG002
                # cabecalho anuncia 4 bytes (2 registradores) mas pedimos 64
                return bytes([5, 3, 4, 0xC5, 0x01, 0x00, 0x00])

        with self.assertRaises(ValueError) as ctx:
            im._modbus_block_le(Link(), im.SMG_BASE, im.SMG_COUNT, im.SMG_SLAVE, attempts=1)
        self.assertIn("truncado", str(ctx.exception))

    def test_bloco_completo_passa(self):
        class Link:
            def ask(self, fc, payload, timeout=None):  # noqa: ARG002
                dados = b"".join(bytes([i & 0xFF, 0x00]) for i in range(4))
                return bytes([5, 3, len(dados)]) + dados

        regs = im._modbus_block_le(Link(), 4501, 4, 5, attempts=1)
        self.assertEqual(regs, [0, 1, 2, 3])



class TestBackoffNaoVaza(unittest.TestCase):
    """`backoff` e estado do coletor, nao leitura: nao pode ser herdado do cache.

    Sem isso, depois de uma falha o ciclo seguinte (bem-sucedido) recebia
    `backoff: True` do historico e o painel mostrava o inversor online **e**
    "recuperando" ao mesmo tempo.
    """

    def test_ciclo_bom_depois_de_falha_nao_carrega_backoff(self):
        backoff = {}
        history = {}
        aparelho = [{"name": "x", "ip": "10.0.0.9", "protocol": "modbus_a"}]

        with mock.patch.object(im, "Dongle", FakeLink), \
                mock.patch.dict(im.READERS, {"modbus_a": fake_reader_fail}):
            im.poll_once(aparelho, {}, {}, {}, history, backoff)

        # Ciclo seguinte: o coletor tenta de novo (espera vencida) e da certo.
        backoff["x"]["until"] = 0.0
        with mock.patch.object(im, "Dongle", FakeLink), \
                mock.patch.dict(im.READERS, {"modbus_a": fake_reader_ok}):
            depois = im.poll_once(aparelho, {}, {}, {}, history, backoff)

        entrada = depois["devices"]["x"]
        self.assertTrue(entrada["online"])
        self.assertNotIn("backoff", entrada, "estado de espera nao e dado do inversor")
        self.assertNotIn("backoff", history["x"]["values"])
        self.assertNotIn("cache", entrada, "nada faltou: nao ha o que herdar")


if __name__ == "__main__":
    unittest.main()
