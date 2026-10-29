import { Router } from 'express';

export function createDashboardRouter(service) {
  const router = Router();
  router.use((request, response, next) => {
    response.setHeader('Cache-Control', 'no-store');
    next();
  });

  router.get('/dashboard', async (request, response, next) => {
    try {
      response.json(await service.getDashboard());
    } catch (error) {
      next(error);
    }
  });

  router.put('/devices/:id', async (request, response, next) => {
    try {
      const displayName = String(request.body?.displayName ?? '').trim().slice(0, 80);
      if (!displayName) return response.status(400).json({ error: 'displayName obrigatorio' });
      await service.updateDevice(request.params.id, displayName);
      response.json(await service.getDashboard());
    } catch (error) {
      next(error);
    }
  });

  router.post('/rules', async (request, response, next) => {
    try {
      response.status(201).json(await saveRule(response, service, request.body));
    } catch (error) {
      next(error);
    }
  });

  router.put('/rules/:id', async (request, response, next) => {
    try {
      response.json(await saveRule(response, service, { ...request.body, id: request.params.id }));
    } catch (error) {
      next(error);
    }
  });

  router.delete('/rules/:id', async (request, response, next) => {
    try {
      await service.deleteRule(request.params.id);
      response.status(204).end();
    } catch (error) {
      next(error);
    }
  });

  return router;
}

async function saveRule(response, service, candidate) {
  const allowedActions = new Set(['gate_pause', 'ep2_mining_reduce', 'ainode_mining_reduce']);
  if (!candidate?.id || !candidate.name?.trim()) {
    response.status(400);
    throw new Error('id e name sao obrigatorios');
  }
  if (!candidate.sourceDeviceId || !allowedActions.has(candidate.action)) {
    response.status(400);
    throw new Error('sourceDeviceId e action invalidos');
  }

  const activateBelow = Number(candidate.activateBelow);
  const resumeAbove = Number(candidate.resumeAbove);
  if (!Number.isFinite(activateBelow) || !Number.isFinite(resumeAbove)
    || activateBelow < 0 || activateBelow > 100 || resumeAbove < 0 || resumeAbove > 100
    || resumeAbove <= activateBelow) {
    response.status(400);
    throw new Error('Faixas invalidas: 0-100 e resumeAbove deve ser maior que activateBelow');
  }

  const rule = {
    id: String(candidate.id).slice(0, 80),
    name: String(candidate.name).trim().slice(0, 120),
    enabled: candidate.enabled === true,
    action: candidate.action,
    sourceDeviceId: String(candidate.sourceDeviceId),
    activateBelow,
    resumeAbove,
    desiredIntensity: candidate.desiredIntensity == null ? null : Math.min(100, Math.max(0, Number(candidate.desiredIntensity))),
  };
  await service.saveRule(rule);
  return rule;
}
