import os from 'node:os';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Session } from './session.js';
import { CameraServer } from './camera-server.js';
import {
  ensurePool,
  eraseSimulator,
  recreatePoolDevice,
  shutdownAndErasePoolDevices,
  resolveDeviceType,
  deviceTypeMatchesModel,
} from './simulator.js';
import type { DeviceModel, Orientation } from '@sim/shared';
import { detect, hasIDB, stopAllCompanions } from './idb.js';
import { ensureCompiled } from './capturer.js';
import { ensureFramebufferCapturer } from './framebuffer-capturer.js';
import { runAppStoreBuild, runDeviceBuild, type AppStoreSigningInput } from './build.js';
import { selectedBuildBackend } from './build-runner.js';
import { runVmAppStoreBuild, runVmDeviceBuild } from './vm-build-runner.js';
import { ControllerClient, type ControllerToHostCmd } from './controller-client.js';
import { log, warn } from './log.js';

const CONTROLLER_URL = process.env.CONTROLLER_URL ?? 'ws://127.0.0.1:8080/ws/host';
const HOST_TOKEN = process.env.HOST_TOKEN ?? 'dev-token';
const HOST_ID = process.env.HOST_ID ?? `${os.hostname()}-${process.pid}`;
const HOST_SLOTS = Math.max(1, parseInt(process.env.HOST_SLOTS ?? '2', 10));
const CAPTURE_MODE = (process.env.SIM_CAPTURE_MODE ?? 'sck').toLowerCase();
// HOST_KIND broadcasts the host's isolation posture to the controller so it
// can refuse to place tenant sessions on bare-metal hosts (Phase 1+). 'vm'
// when this agent runs inside a tart VM; 'bare-metal' (default) otherwise.
const HOST_KIND = ((): 'vm' | 'bare-metal' => {
  const raw = (process.env.HOST_KIND ?? 'bare-metal').toLowerCase();
  return raw === 'vm' ? 'vm' : 'bare-metal';
})();

// session.id → Session, udid pool
const sessions = new Map<string, Session>();
const claimedUdids = new Set<string>();
let pool: string[] = [];

/**
 * Replace a UDID in the pool with a different one (used when erase fails and
 * we recreate the simulator). Keeps the pool's *slot count* stable so the
 * controller-side capacity claim doesn't drift.
 */
function swapPoolUdid(oldUdid: string, newUdid: string): void {
  const idx = pool.indexOf(oldUdid);
  if (idx >= 0) pool[idx] = newUdid;
}

/**
 * Claim a pool UDID for a session, AND erase it before handing it back.
 * This is the belt-and-suspenders for tenant isolation: we erase on session
 * release AND on claim, so even if one path fails (crash, exception, race)
 * the next tenant gets a clean device. If erase fails, we recreate the
 * device entirely (poison-and-replace) and reuse the new UDID.
 *
 * Async because erase + potential recreate take real time. Returns null if
 * no slot is free, or if every recovery attempt failed.
 */
async function claimUdid(deviceModel: DeviceModel = 'iPhone-16-Pro'): Promise<string | null> {
  for (const udid of pool) {
    if (claimedUdids.has(udid)) continue;
    claimedUdids.add(udid);

    // Retype the slot if it isn't already the requested device family (e.g.
    // iPhone → iPad). A recreate yields a clean device, so no separate erase
    // is needed in that case — it subsumes the defensive wipe.
    if (!deviceTypeMatchesModel(udid, deviceModel)) {
      log(`claim: retyping slot ${udid.slice(0, 8)} → ${deviceModel}`);
      const retyped = await recreatePoolDevice(udid, resolveDeviceType(deviceModel));
      claimedUdids.delete(udid);
      if (!retyped) {
        warn(`claim: retype to ${deviceModel} failed for ${udid.slice(0, 8)}, dropping slot`);
        continue;
      }
      swapPoolUdid(udid, retyped);
      claimedUdids.add(retyped);
      return retyped;
    }

    // Same family — defensive erase before returning the UDID. If the prior
    // session's cleanup erased successfully this is a fast no-op.
    const erased = await eraseSimulator(udid);
    if (erased) return udid;
    // Erase failed — poison-and-replace (keeps current device type).
    warn(`claim: erase failed for ${udid.slice(0, 8)}, recreating pool device`);
    const newUdid = await recreatePoolDevice(udid);
    claimedUdids.delete(udid);
    if (!newUdid) {
      warn(`claim: recreate failed for ${udid.slice(0, 8)}, dropping slot`);
      // Don't reuse — better to lose a slot than serve a dirty session.
      // The slot is recoverable by restarting the host (ensurePool recreates).
      continue;
    }
    swapPoolUdid(udid, newUdid);
    claimedUdids.add(newUdid);
    return newUdid;
  }
  return null;
}

function releaseUdid(udid: string): void {
  claimedUdids.delete(udid);
}

async function main(): Promise<void> {
  log(`Host ${HOST_ID} starting (slots=${HOST_SLOTS}, kind=${HOST_KIND}, capture=${CAPTURE_MODE}, idb=${hasIDB()})`);

  // Capability detection up-front so the first session doesn't pay these costs.
  const detected = detect();
  log(`idb detected: ${detected.hasIDB}, companion: ${detected.companionBin ?? 'none'}`);

  const compiled = await ensureCompiled();
  if (!compiled) {
    warn('Capturer binary not available — streaming will not work. Check Xcode/swiftc.');
  }
  if (CAPTURE_MODE === 'framebuffer') {
    try {
      await ensureFramebufferCapturer();
    } catch (e) {
      warn(`Native framebuffer capturer unavailable: ${(e as Error).message}`);
    }
  }

  log(`Ensuring simulator pool of ${HOST_SLOTS} iPhone 16 Pro devices...`);
  pool = await ensurePool(HOST_SLOTS);
  log(`Pool ready: ${pool.length} UDIDs.`);

  // Cold-start cleanup. Any pool device is an orphan from a prior run
  // (crash, hot-reload, manual restart) and MUST be erased before this
  // process serves a tenant — the previous run's installed apps would
  // otherwise be visible on the next session's home screen. Devices that
  // fail erase get recreated; the pool array is updated to reflect new UDIDs.
  const remap = await shutdownAndErasePoolDevices();
  pool = pool.map((u) => remap.get(u) ?? u);
  log(`Pool cleansed on startup (${pool.length} devices erased/recreated).`);

  // Loopback bridge that streams the browser webcam into the simulator's camera
  // shim. Started before the controller connects so a session can be injected
  // the moment it's placed.
  const cameraServer = new CameraServer();
  try {
    await cameraServer.start();
  } catch (e) {
    warn(`Camera server failed to start (camera feature disabled): ${(e as Error).message}`);
  }

  const client = new ControllerClient(
    {
      url: CONTROLLER_URL,
      hostId: HOST_ID,
      hostToken: HOST_TOKEN,
      slots: HOST_SLOTS,
      kind: HOST_KIND,
    },
    {
      onCommand: handleCommand,
      onCameraFrame: (sessionId, timestampMs, jpeg) =>
        cameraServer.pushFrame(sessionId, timestampMs, jpeg),
    },
    () => [...sessions.keys()],
  );

  // When the shim attaches/detaches (app started/stopped its capture session),
  // tell the controller so it can prompt the browser to start/stop the webcam.
  cameraServer.onCameraRequest((sessionId, active) => {
    client.send({ type: 'camera_request', sessionId, active });
  });

  /** Mint a per-session camera token + injection config (null if no shim dylib). */
  function prepareCamera(sessionId: string) {
    return cameraServer.prepareInjection(sessionId, randomBytes(32).toString('base64url'));
  }

  function handleCommand(cmd: ControllerToHostCmd): void {
    switch (cmd.type) {
      case 'start_session':
        void startSession(cmd.sessionId, cmd.deviceModel, cmd.orientation);
        break;
      case 'stop_session':
        void stopSession(cmd.sessionId);
        break;
      case 'build_session':
        void startBuild(cmd.sessionId, cmd.tarballBase64, cmd.hints, cmd.deviceModel, cmd.orientation);
        break;
      case 'set_orientation': {
        const s = sessions.get(cmd.sessionId);
        if (s) void s.setOrientation(cmd.orientation);
        break;
      }
      case 'build_device':
        void startDeviceBuild(cmd.buildId, cmd.tarballBase64, cmd.hints);
        break;
      case 'build_app_store':
        void startAppStoreBuild(cmd.buildId, cmd.tarballBase64, cmd.signing, cmd.hints);
        break;
      case 'input': {
        const s = sessions.get(cmd.sessionId);
        if (s) void s.handleInput(cmd.input);
        break;
      }
      case 'set_calibration': {
        const s = sessions.get(cmd.sessionId);
        if (s) s.setCalibration(cmd.screenRect);
        break;
      }
      case 'reset_calibration': {
        const s = sessions.get(cmd.sessionId);
        if (s) s.resetCalibration();
        break;
      }
      case 'ping':
        // handled in the client
        break;
    }
  }

  async function startBuild(
    sessionId: string,
    tarballBase64: string,
    hints?: { scheme?: string; bundleId?: string },
    deviceModel: DeviceModel = 'iPhone-16-Pro',
    orientation?: Orientation,
  ): Promise<void> {
    let session = sessions.get(sessionId);
    if (!session) {
      // First build_session for this session: create the Session lazily, claim
      // a slot of the requested device family (retyping the slot if needed).
      // The controller has already reserved the slot via placement.
      const udid = await claimUdid(deviceModel);
      if (!udid) {
        client.send({
          type: 'session_event',
          sessionId,
          event: 'error',
          payload: { message: 'No free slots on host.' },
        });
        return;
      }
      session = new Session({
        sessionId,
        udid,
        deviceModel,
        orientation,
        camera: prepareCamera(sessionId),
      });
      sessions.set(sessionId, session);
      wireSessionEvents(session);
    }

    const tarballBuf = Buffer.from(tarballBase64, 'base64');
    try {
      await session.runBuildAndLaunch(tarballBuf, hints);
    } catch (e) {
      warn(`runBuildAndLaunch ${sessionId} threw: ${(e as Error).message}`);
      client.send({
        type: 'build_event',
        sessionId,
        event: 'failed',
        message: (e as Error).message,
      });
    }
  }

  async function startDeviceBuild(
    buildId: string,
    tarballBase64: string,
    hints?: { scheme?: string; bundleId?: string },
  ): Promise<void> {
    const startedAt = Date.now();
    client.send({
      type: 'device_build_event',
      buildId,
      event: 'started',
    });

    const tarballBuf = Buffer.from(tarballBase64, 'base64');
    try {
      const startDeviceBuild =
        selectedBuildBackend() === 'vm-queue' ? runVmDeviceBuild : runDeviceBuild;
      const build = startDeviceBuild({
        buildId,
        tarballBuf,
        hints,
        onLog: (line, stream) => {
          client.send({
            type: 'device_build_event',
            buildId,
            event: 'log',
            line,
            stream,
          });
        },
      });
      const result = await build.done;
      const ipaBase64 = readFileSync(result.ipaPath).toString('base64');
      client.send({
        type: 'device_build_event',
        buildId,
        event: 'succeeded',
        scheme: result.scheme,
        bundleId: result.bundleId,
        durationMs: result.durationMs,
        diagnostics: result.diagnostics,
        unsigned: result.unsigned,
        ipaBase64,
      });
    } catch (e) {
      const error = e as Error & { diagnostics?: unknown };
      warn(`runDeviceBuild ${buildId} threw: ${error.message}`);
      client.send({
        type: 'device_build_event',
        buildId,
        event: 'failed',
        message: error.message,
        durationMs: Date.now() - startedAt,
        diagnostics: Array.isArray(error.diagnostics) ? error.diagnostics : undefined,
      });
    }
  }

  async function startAppStoreBuild(
    buildId: string,
    tarballBase64: string,
    signing: AppStoreSigningInput,
    hints?: { scheme?: string; bundleId?: string },
  ): Promise<void> {
    const startedAt = Date.now();
    client.send({
      type: 'app_store_build_event',
      buildId,
      event: 'started',
    });

    const tarballBuf = Buffer.from(tarballBase64, 'base64');
    try {
      const startAppStoreBuild =
        selectedBuildBackend() === 'vm-queue' ? runVmAppStoreBuild : runAppStoreBuild;
      const build = startAppStoreBuild({
        buildId,
        tarballBuf,
        signing,
        hints,
        onLog: (line, stream) => {
          client.send({
            type: 'app_store_build_event',
            buildId,
            event: 'log',
            line,
            stream,
          });
        },
        onPhase: (phase) => {
          client.send({
            type: 'app_store_build_event',
            buildId,
            event: phase,
          });
        },
      });
      const result = await build.done;
      client.send({
        type: 'app_store_build_event',
        buildId,
        event: 'succeeded',
        scheme: result.scheme,
        bundleId: result.bundleId,
        durationMs: result.durationMs,
        diagnostics: result.diagnostics,
      });
    } catch (e) {
      const error = e as Error & { diagnostics?: unknown };
      warn(`runAppStoreBuild ${buildId} threw: ${error.message}`);
      client.send({
        type: 'app_store_build_event',
        buildId,
        event: 'failed',
        message: error.message,
        durationMs: Date.now() - startedAt,
        diagnostics: Array.isArray(error.diagnostics) ? error.diagnostics : undefined,
      });
    }
  }

  function wireSessionEvents(session: Session): void {
    const sessionId = session.sessionId;
    session.on('frame', (jpeg) => {
      client.send({
        type: 'session_frame',
        sessionId,
        jpegBase64: jpeg.toString('base64'),
      });
    });

    session.on('videoConfig', (config) => {
      client.send({
        type: 'video_config',
        sessionId,
        ...config,
      });
    });

    session.on('videoChunk', (chunk) => {
      client.sendBinary(encodeHostVideoChunk(sessionId, chunk.timestampMs, chunk.keyframe, chunk.data));
    });

    session.on('orientation', (orientation) => {
      client.send({ type: 'orientation', sessionId, orientation });
    });

    session.on('build', (b) => {
      client.send({
        type: 'build_event',
        sessionId,
        event: b.event,
        line: b.line,
        stream: b.stream,
        exitCode: b.exitCode,
        scheme: b.scheme,
        bundleId: b.bundleId,
        durationMs: b.durationMs,
        message: b.message,
        diagnostic: b.diagnostic,
        diagnostics: b.diagnostics,
      });
    });

    session.on('phase', (phase, payload) => {
      // 'building' is signaled separately via build_event so the controller can
      // hold the session in `state: 'building'` instead of `'starting'`.
      if (phase === 'booting' || phase === 'capturing' || phase === 'installing') {
        client.send({ type: 'session_event', sessionId, event: 'starting' });
      } else if (phase === 'ready' && payload && 'windowInfo' in payload) {
        client.send({
          type: 'session_event',
          sessionId,
          event: 'ready',
          payload: {
            windowInfo: payload.windowInfo,
            screenRect: payload.screenRect,
            deviceLogical: payload.deviceLogical,
          },
        });
      } else if (phase === 'error') {
        const message = payload && 'message' in payload ? payload.message : 'unknown error';
        client.send({ type: 'session_event', sessionId, event: 'error', payload: { message } });
        // Self-cleanup on error: don't wait for the controller's stop_session
        // round-trip. Releasing the slot here means the next queued session
        // can be placed immediately instead of starving behind a dead one.
        void stopSession(sessionId);
      } else if (phase === 'ended') {
        client.send({ type: 'session_event', sessionId, event: 'ended' });
      }
    });
  }

  async function startSession(
    sessionId: string,
    deviceModel: DeviceModel = 'iPhone-16-Pro',
    orientation?: Orientation,
  ): Promise<void> {
    if (sessions.has(sessionId)) return;
    const udid = await claimUdid(deviceModel);
    if (!udid) {
      client.send({
        type: 'session_event',
        sessionId,
        event: 'error',
        payload: { message: 'No free slots on host.' },
      });
      return;
    }

    const session = new Session({
      sessionId,
      udid,
      deviceModel,
      orientation,
      camera: prepareCamera(sessionId),
    });
    sessions.set(sessionId, session);
    wireSessionEvents(session);

    try {
      await session.start();
    } catch (e) {
      warn(`startSession ${sessionId} threw: ${(e as Error).message}`);
      client.send({
        type: 'session_event',
        sessionId,
        event: 'error',
        payload: { message: (e as Error).message },
      });
      sessions.delete(sessionId);
      cameraServer.releaseSession(sessionId);
      releaseUdid(udid);
    }
  }

  async function stopSession(sessionId: string): Promise<void> {
    const session = sessions.get(sessionId);
    if (!session) return;
    sessions.delete(sessionId);
    cameraServer.releaseSession(sessionId);
    const udid = session.udid;
    try {
      await session.stop();
    } finally {
      releaseUdid(udid);
      // If session.stop() found the UDID dirty (erase failed during
      // tear-down), recreate the device proactively rather than letting the
      // next claim discover it. Trades ~2s here for a faster, predictable
      // next claim. If recreate fails, the UDID stays in the pool and the
      // claim path's own poison-and-replace will catch it as a backstop.
      if (session.udidDirty) {
        warn(`stopSession: recreating dirty udid ${udid.slice(0, 8)}`);
        const newUdid = await recreatePoolDevice(udid);
        if (newUdid) swapPoolUdid(udid, newUdid);
      }
    }
  }

  client.start();

  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    log(`Received ${signal}, shutting down...`);
    client.close();
    cameraServer.stop();
    for (const session of sessions.values()) {
      await session.stop().catch(() => undefined);
    }
    stopAllCompanions();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

function encodeHostVideoChunk(
  sessionId: string,
  timestampMs: number,
  keyframe: boolean,
  payload: Buffer,
): Buffer {
  const sid = Buffer.from(sessionId, 'utf8');
  const header = Buffer.alloc(12 + sid.length);
  header.writeUInt8(1, 0); // protocol version
  header.writeUInt8(keyframe ? 1 : 0, 1);
  header.writeUInt16BE(sid.length, 2);
  header.writeBigUInt64BE(BigInt(Math.max(0, Math.floor(timestampMs))), 4);
  sid.copy(header, 12);
  return Buffer.concat([header, payload]);
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error('[host-agent] fatal:', e);
  process.exit(1);
});
