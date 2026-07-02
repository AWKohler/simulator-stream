import os from 'node:os';
import { Session } from './session.js';
import { ensurePool } from './simulator.js';
import { detect, hasIDB, stopAllCompanions } from './idb.js';
import { ensureCompiled } from './capturer.js';
import { ensureFramebufferCapturer } from './framebuffer-capturer.js';
import { ControllerClient, type ControllerToHostCmd } from './controller-client.js';
import { log, warn } from './log.js';

const CONTROLLER_URL = process.env.CONTROLLER_URL ?? 'ws://127.0.0.1:8080/ws/host';
const HOST_TOKEN = process.env.HOST_TOKEN ?? 'dev-token';
const HOST_ID = process.env.HOST_ID ?? `${os.hostname()}-${process.pid}`;
const HOST_SLOTS = Math.max(1, parseInt(process.env.HOST_SLOTS ?? '2', 10));
const CAPTURE_MODE = (process.env.SIM_CAPTURE_MODE ?? 'sck').toLowerCase();

// session.id → Session, udid pool
const sessions = new Map<string, Session>();
const claimedUdids = new Set<string>();
let pool: string[] = [];

function claimUdid(): string | null {
  for (const udid of pool) {
    if (!claimedUdids.has(udid)) {
      claimedUdids.add(udid);
      return udid;
    }
  }
  return null;
}

function releaseUdid(udid: string): void {
  claimedUdids.delete(udid);
}

async function main(): Promise<void> {
  log(`Host ${HOST_ID} starting (slots=${HOST_SLOTS}, capture=${CAPTURE_MODE}, idb=${hasIDB()})`);

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

  const client = new ControllerClient(
    {
      url: CONTROLLER_URL,
      hostId: HOST_ID,
      hostToken: HOST_TOKEN,
      slots: HOST_SLOTS,
    },
    { onCommand: handleCommand },
    () => [...sessions.keys()],
  );

  function handleCommand(cmd: ControllerToHostCmd): void {
    switch (cmd.type) {
      case 'start_session':
        void startSession(cmd.sessionId);
        break;
      case 'stop_session':
        void stopSession(cmd.sessionId);
        break;
      case 'build_session':
        void startBuild(cmd.sessionId, cmd.tarballBase64, cmd.hints);
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
  ): Promise<void> {
    let session = sessions.get(sessionId);
    if (!session) {
      // First build_session for this session: create the Session lazily, claim
      // a slot. The controller has already reserved the slot via placement.
      const udid = claimUdid();
      if (!udid) {
        client.send({
          type: 'session_event',
          sessionId,
          event: 'error',
          payload: { message: 'No free slots on host.' },
        });
        return;
      }
      session = new Session({ sessionId, udid });
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

  async function startSession(sessionId: string): Promise<void> {
    if (sessions.has(sessionId)) return;
    const udid = claimUdid();
    if (!udid) {
      client.send({
        type: 'session_event',
        sessionId,
        event: 'error',
        payload: { message: 'No free slots on host.' },
      });
      return;
    }

    const session = new Session({ sessionId, udid });
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
      releaseUdid(udid);
    }
  }

  async function stopSession(sessionId: string): Promise<void> {
    const session = sessions.get(sessionId);
    if (!session) return;
    sessions.delete(sessionId);
    const udid = session.udid;
    try {
      await session.stop();
    } finally {
      releaseUdid(udid);
    }
  }

  client.start();

  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    log(`Received ${signal}, shutting down...`);
    client.close();
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
