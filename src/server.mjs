import express from 'express';
import path from 'node:path';
import { config, rootDir } from './config.mjs';
import { DashboardService } from './services/dashboard.service.mjs';
import { createDashboardRouter } from './routes/dashboard.routes.mjs';
import { createAutomationService } from './services/automation/automationService.mjs';

const app = express();
const automationService = createAutomationService({
  enabled: config.automationEnabled,
  stateFile: config.automationStateFile,
  dashboardFile: config.dashboardFile,
  devicesFile: config.devicesFile,
  snapshotFile: config.snapshotFile,
  collectorUrl: config.collectorUrl,
  pollMs: config.pollMs,
  gateUrl: config.gateUrl,
  ep2XmrigUrl: config.ep2XmrigUrl,
  ep2XmrigConfig: config.ep2XmrigConfig,
  ep2XmrigToken: config.ep2XmrigToken,
  ep2BaseThreads: config.ep2MiningBaseThreads,
  aiNode: config.aiNode,
  snapshotStaleAfterSeconds: config.snapshotStaleAfterSeconds,
  // O Gate roda no proprio ai-node: se ele foi desligado, pausar a fila nao tem como
  // funcionar — melhor mostrar "bloqueada" do que "falha".
  actionHosts: buildActionHosts(config),
});

function buildActionHosts(config) {
  const hosts = {
    ainode_power_off: config.aiNode.host,
    ainode_mining_reduce: config.aiNode.host,
  };
  try {
    if (new URL(config.gateUrl).hostname === config.aiNode.address) {
      hosts.gate_pause = config.aiNode.host;
    }
  } catch {
    // Gate URL invalida: fica sem host associado, como antes.
  }
  return hosts;
}

const dashboardService = new DashboardService({
  devicesFile: config.devicesFile,
  snapshotFile: config.snapshotFile,
  collectorUrl: config.collectorUrl,
  collectorRefreshUrl: config.collectorRefreshUrl,
  dashboardFile: config.dashboardFile,
  gateUrl: config.gateUrl,
  ep2XmrigUrl: config.ep2XmrigUrl,
  ep2XmrigConfig: config.ep2XmrigConfig,
  ep2XmrigToken: config.ep2XmrigToken,
  ep2BaseThreads: config.ep2MiningBaseThreads,
  automationEnabled: config.automationEnabled,
  automationService,
});

app.disable('x-powered-by');
app.use(express.json({ limit: '64kb' }));
app.use(express.static(path.join(rootDir, 'public')));
app.get('/health', (request, response) => response.json({ ok: true, port: config.port, automationEnabled: config.automationEnabled }));
app.use('/api', createDashboardRouter(dashboardService));
app.use((request, response, next) => {
  if (request.path.startsWith('/api/')) return next();
  response.sendFile(path.join(rootDir, 'public', 'index.html'));
});
app.use((error, request, response, next) => {
  console.error(error);
  if (response.headersSent) return next(error);
  response.status(response.statusCode >= 400 ? response.statusCode : 500).json({ error: error.message });
});

const server = app.listen(config.port, config.host, () => {
  console.log(`Inverter monitor UI: http://0.0.0.0:${config.port}`);
  automationService.start();
});

server.on('error', (error) => {
  console.error(`Inverter monitor UI: nao foi possivel ouvir na porta ${config.port}: ${error.message}`);
  process.exit(1);
});
