import type { Router, Request, Response, NextFunction } from 'express';
import express from 'express';
import { z } from 'zod';
import { DeviceModel, Orientation, type SessionSummary } from '@sim/shared';
import type { Orchestrator, SessionRecord } from '../orchestrator.js';
import { log, warn } from '../log.js';

const CreateSessionBody = z.object({
  deviceModel: DeviceModel.default('iPhone-16-Pro'),
  orientation: Orientation.optional(),
  awaitBuild: z.boolean().default(false),
});

export interface SessionRouterOptions {
  /** Shared secret required to upload a build. Falsy means anyone can. */
  platformToken: string | null;
  /** Max bytes for an uploaded tarball. */
  maxBuildBodyBytes: number;
}

export function sessionRouter(orch: Orchestrator, options: SessionRouterOptions): Router {
  const router = express.Router();

  const requirePlatformToken = (req: Request, res: Response, next: NextFunction): void => {
    if (!options.platformToken) {
      next();
      return;
    }
    const provided = req.header('x-platform-token');
    if (provided !== options.platformToken) {
      res.status(401).json({ error: 'invalid X-Platform-Token' });
      return;
    }
    next();
  };

  // Gate the ENTIRE session REST surface — not just /build. Session creation
  // spins up a real simulator on the Mac, so an open create endpoint behind the
  // public tunnel is a DoS / resource-abuse hole. All legitimate callers
  // (botflow's server) already send X-Platform-Token; browsers never hit this
  // surface directly. No-op when platformToken is unset (local dev).
  router.use(requirePlatformToken);

  router.post('/', express.json(), (req: Request, res: Response) => {
    const parsed = CreateSessionBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid request', details: parsed.error.format() });
      return;
    }
    // A device no connected host can run would wait in the queue for ever.
    if (!orch.supportsDeviceModel(parsed.data.deviceModel)) {
      res.status(409).json({
        error: `No simulator host here can run ${parsed.data.deviceModel}.`,
        code: 'device_unsupported',
      });
      return;
    }
    const session = orch.createSession(
      parsed.data.deviceModel,
      parsed.data.awaitBuild,
      parsed.data.orientation,
    );
    // streamToken is returned ONLY here (on create) so it stays out of the
    // GET/:id response surface. The caller (botflow server) appends it to the
    // browser's WS URL.
    res.status(201).json({ ...toSummary(session), streamToken: session.streamToken });
  });

  router.get('/:id', (req: Request<{ id: string }>, res: Response) => {
    const s = orch.getSession(req.params.id);
    if (!s) {
      res.status(404).json({ error: 'session not found' });
      return;
    }
    res.json(toSummary(s));
  });

  router.delete('/:id', (req: Request<{ id: string }>, res: Response) => {
    orch.endSession(req.params.id, 'released by client');
    res.status(204).end();
  });

  // ── Build upload — IDE-only endpoint ────────────────────────────────────────
  router.post(
    '/:id/build',
    express.raw({ type: '*/*', limit: options.maxBuildBodyBytes }),
    (req: Request<{ id: string }>, res: Response) => {
      const sessionId = req.params.id;
      const session = orch.getSession(sessionId);
      if (!session) {
        res.status(404).json({ error: 'session not found' });
        return;
      }
      const body = req.body;
      if (!Buffer.isBuffer(body) || body.length === 0) {
        res.status(400).json({ error: 'missing tarball body' });
        return;
      }
      const scheme = req.header('x-build-scheme') || undefined;
      const bundleId = req.header('x-build-bundle-id') || undefined;
      const tarballBase64 = body.toString('base64');
      const ok = orch.triggerBuild(sessionId, tarballBase64, { scheme, bundleId });
      if (!ok) {
        // triggerBuild only returns false when the session was already GC'd.
        res.status(404).json({ error: 'session not found or already ended' });
        return;
      }
      log(`Build triggered for ${sessionId.slice(0, 8)} (${body.length} bytes)`);
      res.status(202).json({ ok: true, bytes: body.length });
    },
  );

  // Express's default error handler returns HTML; for this API surface JSON is friendlier.
  router.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const status = (err as { status?: number; statusCode?: number }).status ??
      (err as { status?: number; statusCode?: number }).statusCode ??
      500;
    const message = (err as { message?: string }).message ?? 'internal error';
    if (status >= 500) warn(`route error: ${message}`);
    res.status(status).json({ error: message });
  });

  return router;
}

function toSummary(s: SessionRecord): SessionSummary {
  return {
    sessionId: s.sessionId,
    state: s.state,
    deviceModel: s.deviceModel,
    orientation: s.orientation,
    queuePosition: s.queuePosition,
    createdAt: s.createdAt,
    hostId: s.hostId,
  };
}
