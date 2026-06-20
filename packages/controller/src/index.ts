import http from 'node:http';
import express from 'express';
import cors from 'cors';
import { Orchestrator } from './orchestrator.js';
import { SessionProxy } from './proxy.js';
import { sessionRouter } from './routes/sessions.js';
import { deviceBuildRouter } from './routes/device-builds.js';
import { appStoreBuildRouter } from './routes/app-store-builds.js';
import { attachWS } from './routes/ws.js';
import { log } from './log.js';

const PORT = parseInt(process.env.PORT ?? '8080', 10);
// Default to loopback: the controller is reached via the tunnel (which proxies
// to localhost) and the co-located host-agent (which dials 127.0.0.1). Binding
// to localhost keeps the raw :8080 off the LAN/tailnet. Set BIND_HOST=0.0.0.0
// only when the host-agent runs on a different machine than the controller.
const BIND_HOST = process.env.BIND_HOST ?? '127.0.0.1';
const HOST_TOKEN = process.env.HOST_TOKEN ?? 'dev-token';
const PLATFORM_TOKEN = process.env.SIM_PLATFORM_TOKEN ?? null;
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ?? '*').split(',').map((s) => s.trim());
const MAX_BUILD_BODY_BYTES = parseInt(process.env.MAX_BUILD_BODY_MB ?? '50', 10) * 1024 * 1024;

const orch = new Orchestrator();
const proxy = new SessionProxy();
// Auto-end a session whose browser has been gone for the configured grace
// window. This prevents a refresh-killed tab from holding a slot forever.
proxy.onSessionAbandoned = (sessionId) => {
  log(`Session ${sessionId.slice(0, 8)} abandoned by browser; auto-ending.`);
  orch.endSession(sessionId, 'browser disconnected');
  proxy.closeSession(sessionId);
};

const app = express();
app.use(
  cors({
    origin: ALLOWED_ORIGINS.includes('*') ? true : ALLOWED_ORIGINS,
    credentials: false,
    exposedHeaders: ['x-platform-token'],
  }),
);

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    hosts: orch.listHosts().map((h) => ({
      id: h.hostId,
      slots: h.slots,
      active: h.activeSessionIds.size,
      kind: h.kind,
      lastHeartbeat: h.lastHeartbeat,
    })),
  });
});

app.use(
  '/api/sessions',
  sessionRouter(orch, {
    platformToken: PLATFORM_TOKEN,
    maxBuildBodyBytes: MAX_BUILD_BODY_BYTES,
  }),
);

app.use(
  '/api/device-builds',
  deviceBuildRouter(orch, {
    platformToken: PLATFORM_TOKEN,
    maxBuildBodyBytes: MAX_BUILD_BODY_BYTES,
  }),
);

app.use(
  '/api/app-store-builds',
  appStoreBuildRouter(orch, {
    platformToken: PLATFORM_TOKEN,
    maxBuildBodyBytes: MAX_BUILD_BODY_BYTES,
  }),
);

const server = http.createServer(app);
attachWS(server, orch, proxy, {
  hostToken: HOST_TOKEN,
  allowedOrigins: ALLOWED_ORIGINS,
  // Secured mode = a platform token is configured. In that mode the browser WS
  // also requires a per-session stream token.
  requireSessionToken: PLATFORM_TOKEN !== null,
});

server.listen(PORT, BIND_HOST, () => {
  log(`Controller listening on http://${BIND_HOST}:${PORT}`);
  log(`  /api/sessions          — REST (token: ${PLATFORM_TOKEN ? 'required' : 'OPEN'})`);
  log(`  /api/sessions/:id/build — Build upload (token: ${PLATFORM_TOKEN ? 'required' : 'OPEN'})`);
  log(`  /api/device-builds      — Device IPA build upload (token: ${PLATFORM_TOKEN ? 'required' : 'OPEN'})`);
  log(`  /api/app-store-builds   — App Store signed build + upload (token: ${PLATFORM_TOKEN ? 'required' : 'OPEN'})`);
  log(`  /ws/host               — Host Agent connection (token: ${HOST_TOKEN === 'dev-token' ? 'DEV' : 'configured'})`);
  log(`  /ws/session/:id        — Browser stream (token: ${PLATFORM_TOKEN ? 'required' : 'OPEN'}, origins: ${ALLOWED_ORIGINS.join(',')})`);
});

const shutdown = (signal: NodeJS.Signals): void => {
  log(`Received ${signal}, shutting down...`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 3000).unref();
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
