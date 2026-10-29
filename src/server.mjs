import express from 'express';
import path from 'node:path';
import { config, rootDir } from './config.mjs';
import { DashboardService } from './services/dashboard.service.mjs';
import { createDashboardRouter } from './routes/dashboard.routes.mjs';

const app = express();
const dashboardService = new DashboardService({
  devicesFile: config.devicesFile,
  snapshotFile: config.snapshotFile,
  collectorUrl: config.collectorUrl,
  dashboardFile: config.dashboardFile,
  gateUrl: config.gateUrl,
  ep2XmrigUrl: config.ep2XmrigUrl,
  ep2XmrigConfig: config.ep2XmrigConfig,
  ep2XmrigToken: config.ep2XmrigToken,
});

app.disable('x-powered-by');
app.use(express.json({ limit: '64kb' }));
app.use(express.static(path.join(rootDir, 'public')));
app.get('/health', (request, response) => response.json({ ok: true, port: config.port, automationEnabled: false }));
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
});

server.on('error', (error) => {
  console.error(`Inverter monitor UI: nao foi possivel ouvir na porta ${config.port}: ${error.message}`);
  process.exitCode = 1;
});
