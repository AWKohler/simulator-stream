// App Store build routes — accept a project tarball + distribution-signing
// credentials, dispatch to a host for archive → sign → export → upload to
// App Store Connect, and expose build status for polling.
//
// SECURITY: the signing credentials (ASC key id/issuer/p8) arrive in headers,
// are forwarded to the host once, and are NEVER stored on the build record,
// echoed in summaries, or logged. Mirrors routes/device-builds.ts otherwise.

import type { Router, Request, Response, NextFunction } from 'express';
import express from 'express';
import type { AppStoreBuildSummary, AppStoreSigning } from '@sim/shared';
import type { AppStoreBuildRecord, Orchestrator } from '../orchestrator.js';
import { log, warn } from '../log.js';

export interface AppStoreBuildRouterOptions {
  platformToken: string | null;
  maxBuildBodyBytes: number;
}

export function appStoreBuildRouter(
  orch: Orchestrator,
  options: AppStoreBuildRouterOptions,
): Router {
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

  router.use(requirePlatformToken);

  router.post(
    '/',
    express.raw({ type: '*/*', limit: options.maxBuildBodyBytes }),
    (req: Request, res: Response) => {
      const body = req.body;
      if (!Buffer.isBuffer(body) || body.length === 0) {
        res.status(400).json({ error: 'missing tarball body' });
        return;
      }

      const required = (name: string): string | null => {
        const v = req.header(name);
        return v && v.trim().length > 0 ? v.trim() : null;
      };
      const teamId = required('x-team-id');
      const keyId = required('x-asc-key-id');
      const issuerId = required('x-asc-issuer-id');
      const p8Base64 = required('x-asc-p8');
      const ascAppId = required('x-asc-app-id');
      const bundleId = required('x-bundle-id');
      const marketingVersion = required('x-marketing-version');
      const buildNumber = required('x-build-number');

      const missing = Object.entries({
        'x-team-id': teamId,
        'x-asc-key-id': keyId,
        'x-asc-issuer-id': issuerId,
        'x-asc-p8': p8Base64,
        'x-asc-app-id': ascAppId,
        'x-bundle-id': bundleId,
        'x-marketing-version': marketingVersion,
        'x-build-number': buildNumber,
      })
        .filter(([, v]) => v === null)
        .map(([k]) => k);
      if (missing.length > 0) {
        res.status(400).json({ error: `missing required header(s): ${missing.join(', ')}` });
        return;
      }

      const signing: AppStoreSigning = {
        teamId: teamId!,
        keyId: keyId!,
        issuerId: issuerId!,
        p8Base64: p8Base64!,
        ascAppId: ascAppId!,
        bundleId: bundleId!,
        marketingVersion: marketingVersion!,
        buildNumber: buildNumber!,
      };
      const scheme = req.header('x-build-scheme') || undefined;
      const build = orch.createAppStoreBuild(body.toString('base64'), signing, {
        scheme,
        bundleId: signing.bundleId,
      });
      log(
        `App Store build requested ${build.buildId.slice(0, 8)} ` +
          `(${body.length} bytes, ${signing.bundleId} v${signing.marketingVersion}#${signing.buildNumber})`,
      );
      res.status(202).json(toSummary(build));
    },
  );

  router.get('/:id', (req: Request<{ id: string }>, res: Response) => {
    const build = orch.getAppStoreBuild(req.params.id);
    if (!build) {
      res.status(404).json({ error: 'app store build not found' });
      return;
    }
    res.json(toSummary(build));
  });

  router.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const status = (err as { status?: number; statusCode?: number }).status ??
      (err as { status?: number; statusCode?: number }).statusCode ??
      500;
    const message = (err as { message?: string }).message ?? 'internal error';
    if (status >= 500) warn(`app store build route error: ${message}`);
    res.status(status).json({ error: message });
  });

  return router;
}

function toSummary(build: AppStoreBuildRecord): AppStoreBuildSummary {
  return {
    buildId: build.buildId,
    state: build.state,
    createdAt: build.createdAt,
    updatedAt: build.updatedAt,
    hostId: build.hostId,
    scheme: build.scheme,
    bundleId: build.bundleId,
    marketingVersion: build.marketingVersion,
    buildNumber: build.buildNumber,
    durationMs: build.durationMs,
    diagnostics: build.diagnostics,
    logs: build.logs,
    error: build.error,
  };
}
