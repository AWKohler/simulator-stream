// Single-host PoC orchestrator. Tracks one (or more) Host connections, a session
// registry, and an in-memory FIFO queue. Placement = "first host with a free slot."
// Scaling this to a fleet is just: replace `placeNext` with a smarter scorer and
// move the registry into a real store.

import { randomUUID, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  CAMERA_FRAME_VERSION,
  type AppStoreBuildEvent,
  type AppStoreBuildState,
  type AppStoreSigning,
  type BuildDiagnostic,
  type DeviceBuildState,
  type DeviceModel,
  type HostKind,
  type LogStream,
  type Orientation,
  type ResourceReport,
  type SessionState,
} from '@sim/shared';
import { log, warn } from './log.js';

export interface HostRecord {
  hostId: string;
  slots: number;
  deviceModels: DeviceModel[];
  /** Trust posture broadcast by the host on HELLO. Tenant sessions land on
   * `kind === 'vm'` hosts only, unless ALLOW_BARE_METAL_FALLBACK=1 is set on
   * the controller. Older agents that omit `kind` default to 'bare-metal'. */
  kind: HostKind;
  resources: ResourceReport;
  activeSessionIds: Set<string>;
  send: (msg: unknown) => void;
  /** Send a raw binary frame to the host (e.g. reverse-channel webcam frames).
   * Separate from `send`, which JSON-encodes. */
  sendRaw: (data: Buffer) => void;
  close: () => void;
  lastHeartbeat: number;
}

export interface SessionRecord {
  sessionId: string;
  /** Per-session capability secret, separate from the sessionId. Required (in
   * secured mode) on the browser-facing `/ws/session/:id` upgrade. The sessionId
   * travels through many channels (REST, DB, logs); this token travels only in
   * the WS connect URL and grants nothing but stream access to this one session,
   * so a leaked/guessed sessionId is no longer sufficient to hijack a stream. */
  streamToken: string;
  deviceModel: DeviceModel;
  /** Requested device orientation, threaded to the host at start/build. Absent
   * → host picks the model's natural default. Updated when the host reports
   * the live orientation after a rotate. */
  orientation?: Orientation;
  state: SessionState;
  hostId: string | null;
  createdAt: number;
  queuePosition: number | null;
  lastClientSeenAt: number | null;
  /** Updated on every user action (input, calibration, build/refresh). The
   * inactivity sweeper reaps sessions idle longer than SESSION_INACTIVITY_MS. */
  lastActivityAt: number;
  /** Reason attached to the most recent state transition (e.g. 'inactivity').
   * Relayed to the browser so the UI can explain why a session ended. */
  lastReason: string | null;
  /** When true, placement reserves a slot but does NOT send `start_session`.
   * The session waits for a `build_session` upload to kick off the host pipeline. */
  awaitBuild: boolean;
  /** Set to true once a build_session (or start_session) is sent to the host.
   * After this, releasing the session requires waiting for host-confirmed end. */
  hostStarted: boolean;
}

type SessionListener = (record: Readonly<SessionRecord>) => void;

export interface DeviceBuildLogLine {
  line: string;
  stream: LogStream;
  at: number;
}

export interface DeviceBuildRecord {
  buildId: string;
  state: DeviceBuildState;
  hostId: string | null;
  createdAt: number;
  updatedAt: number;
  scheme?: string;
  bundleId?: string;
  durationMs?: number;
  unsigned?: boolean;
  diagnostics: BuildDiagnostic[];
  logs: DeviceBuildLogLine[];
  error?: string;
  ipaData?: Buffer;
}

export interface AppStoreBuildRecord {
  buildId: string;
  state: AppStoreBuildState;
  hostId: string | null;
  createdAt: number;
  updatedAt: number;
  scheme?: string;
  bundleId?: string;
  marketingVersion?: string;
  buildNumber?: string;
  durationMs?: number;
  diagnostics: BuildDiagnostic[];
  logs: DeviceBuildLogLine[];
  error?: string;
}

interface PendingBuild {
  tarballBase64: string;
  hints?: { scheme?: string; bundleId?: string };
}

export class Orchestrator {
  private hosts = new Map<string, HostRecord>();
  private sessions = new Map<string, SessionRecord>();
  private queue: string[] = [];
  private listeners = new Map<string, Set<SessionListener>>();
  // Tarballs uploaded BEFORE the session has a host attached. Replayed in
  // placeQueued() once the slot opens. Cleared when the session ends.
  private pendingBuilds = new Map<string, PendingBuild>();
  private deviceBuilds = new Map<string, DeviceBuildRecord>();
  private appStoreBuilds = new Map<string, AppStoreBuildRecord>();
  private readonly deviceBuildTtlMs = parseInt(
    process.env.DEVICE_BUILD_TTL_MS ?? '1800000',
    10,
  );
  private readonly maxDeviceBuildLogs = 500;
  // Sessions for which stop_session has been sent and we're waiting for the
  // host to confirm via session_event:ended. The slot is NOT released to
  // placeQueued until confirmation arrives — preventing the "No free slots"
  // race when a release is followed immediately by another session request.
  private pendingStops = new Map<string, NodeJS.Timeout>();
  /** Hard cap on how long we'll wait for a host-confirmed stop. */
  private readonly stopGraceMs = 8_000;

  // ── Inactivity reaper ──────────────────────────────────────────────────────
  // A session whose browser stays connected but receives no input/build for
  // SESSION_INACTIVITY_MS is reaped. This is distinct from the browser-
  // disconnect grace in the proxy (which only fires when the WS drops): a tab
  // left open in the background with no interaction would otherwise pin a
  // simulator forever.
  private readonly inactivityMs = parseInt(
    process.env.SESSION_INACTIVITY_MS ?? '180000',
    10,
  );
  private readonly inactivitySweep: NodeJS.Timeout = (() => {
    const t = setInterval(() => this.sweepInactiveSessions(), 30_000);
    t.unref();
    return t;
  })();

  private sweepInactiveSessions(): void {
    const now = Date.now();
    for (const s of this.sessions.values()) {
      // Only streaming sessions can be "inactive" — during queued/building/
      // starting there's legitimately no user input expected.
      if (s.state !== 'streaming') continue;
      if (this.pendingStops.has(s.sessionId)) continue;
      if (now - s.lastActivityAt > this.inactivityMs) {
        const mins = Math.round(this.inactivityMs / 60000);
        log(`Session ${s.sessionId.slice(0, 8)} inactive >${mins}m — reaping`);
        this.endSession(s.sessionId, 'inactivity');
      }
    }
  }

  // ── Host registry ─────────────────────────────────────────────────────────
  registerHost(host: HostRecord): void {
    const existing = this.hosts.get(host.hostId);
    if (existing) {
      // Reconnect — replace transport, mark queued sessions for placement.
      existing.close();
    }
    this.hosts.set(host.hostId, host);
    log(`Host registered: ${host.hostId} slots=${host.slots} kind=${host.kind}`);
    this.placeQueued();
  }

  unregisterHost(hostId: string, record?: HostRecord): void {
    const host = this.hosts.get(hostId);
    if (!host) return;
    // Reference-equality check: when a host reconnects, the OLD WS's close
    // handler fires AFTER the new WS has already replaced the record. Without
    // this guard the close handler would yank the freshly-registered host out
    // of the map, leaving the controller "hostless" until the next reconnect.
    if (record && host !== record) return;
    this.hosts.delete(hostId);
    log(`Host unregistered: ${hostId}`);
    // End any sessions tied to this host.
    for (const sid of host.activeSessionIds) {
      const s = this.sessions.get(sid);
      if (!s) continue;
      this.setSessionState(s, 'ended', { reason: 'host disconnected' });
      // Clear any pending stop timers — the host is gone, nothing to wait for.
      const timer = this.pendingStops.get(sid);
      if (timer) {
        clearTimeout(timer);
        this.pendingStops.delete(sid);
      }
    }
  }

  recordHeartbeat(hostId: string, activeSessions: string[], resources: ResourceReport): void {
    const host = this.hosts.get(hostId);
    if (!host) return;
    host.lastHeartbeat = Date.now();
    host.resources = resources;
    host.activeSessionIds = new Set(activeSessions);
  }

  listHosts(): HostRecord[] {
    return [...this.hosts.values()];
  }

  // ── Physical-device build lifecycle ───────────────────────────────────────
  createDeviceBuild(
    tarballBase64: string,
    hints?: { scheme?: string; bundleId?: string },
  ): DeviceBuildRecord {
    const buildId = randomUUID();
    const record: DeviceBuildRecord = {
      buildId,
      state: 'queued',
      hostId: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      diagnostics: [],
      logs: [],
    };
    this.deviceBuilds.set(buildId, record);

    const host = this.pickDeviceBuildHost();
    if (!host) {
      record.state = 'failed';
      record.error = 'No host connected for device builds.';
      record.updatedAt = Date.now();
      this.scheduleDeviceBuildCleanup(buildId);
      return record;
    }

    record.hostId = host.hostId;
    try {
      host.send({
        type: 'build_device',
        buildId,
        tarballBase64,
        hints,
      });
      log(`Device build ${buildId.slice(0, 8)} queued on ${host.hostId}`);
    } catch (e) {
      record.state = 'failed';
      record.error = `Failed to send build to host: ${(e as Error).message}`;
      record.updatedAt = Date.now();
      this.scheduleDeviceBuildCleanup(buildId);
    }

    return record;
  }

  getDeviceBuild(buildId: string): DeviceBuildRecord | null {
    return this.deviceBuilds.get(buildId) ?? null;
  }

  getDeviceBuildArtifact(buildId: string): Buffer | null {
    return this.deviceBuilds.get(buildId)?.ipaData ?? null;
  }

  handleDeviceBuildEvent(msg: {
    buildId: string;
    event: 'started' | 'log' | 'diagnostic' | 'succeeded' | 'failed';
    line?: string;
    stream?: LogStream;
    scheme?: string;
    bundleId?: string;
    durationMs?: number;
    message?: string;
    unsigned?: boolean;
    ipaBase64?: string;
    diagnostic?: BuildDiagnostic;
    diagnostics?: BuildDiagnostic[];
  }): void {
    const record = this.deviceBuilds.get(msg.buildId);
    if (!record) return;
    record.updatedAt = Date.now();

    switch (msg.event) {
      case 'started':
        record.state = 'building';
        break;
      case 'log':
        if (msg.line) {
          record.logs.push({
            line: msg.line,
            stream: msg.stream ?? 'stdout',
            at: Date.now(),
          });
          if (record.logs.length > this.maxDeviceBuildLogs) {
            record.logs.splice(0, record.logs.length - this.maxDeviceBuildLogs);
          }
        }
        break;
      case 'diagnostic':
        if (msg.diagnostic) record.diagnostics.push(msg.diagnostic);
        break;
      case 'succeeded':
        record.state = 'succeeded';
        record.scheme = msg.scheme;
        record.bundleId = msg.bundleId;
        record.durationMs = msg.durationMs;
        record.unsigned = msg.unsigned;
        record.diagnostics = msg.diagnostics ?? record.diagnostics;
        if (msg.ipaBase64) record.ipaData = Buffer.from(msg.ipaBase64, 'base64');
        this.scheduleDeviceBuildCleanup(msg.buildId);
        break;
      case 'failed':
        record.state = 'failed';
        record.error = msg.message ?? 'Device build failed.';
        record.durationMs = msg.durationMs;
        record.diagnostics = msg.diagnostics ?? record.diagnostics;
        this.scheduleDeviceBuildCleanup(msg.buildId);
        break;
    }
  }

  // ── App Store build lifecycle ─────────────────────────────────────────────
  // Mirrors the device-build flow, with two differences: the signing payload
  // is PASSED THROUGH to the host and never stored on the record, and there is
  // no IPA artifact to retain — the host uploads straight to App Store Connect.
  createAppStoreBuild(
    tarballBase64: string,
    signing: AppStoreSigning,
    hints?: { scheme?: string; bundleId?: string },
  ): AppStoreBuildRecord {
    const buildId = randomUUID();
    const record: AppStoreBuildRecord = {
      buildId,
      state: 'queued',
      hostId: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      bundleId: signing.bundleId,
      marketingVersion: signing.marketingVersion,
      buildNumber: signing.buildNumber,
      diagnostics: [],
      logs: [],
    };
    this.appStoreBuilds.set(buildId, record);

    const host = this.pickDeviceBuildHost();
    if (!host) {
      record.state = 'failed';
      record.error = 'No host connected for App Store builds.';
      record.updatedAt = Date.now();
      this.scheduleAppStoreBuildCleanup(buildId);
      return record;
    }

    record.hostId = host.hostId;
    try {
      host.send({
        type: 'build_app_store',
        buildId,
        tarballBase64,
        signing,
        hints,
      });
      log(`App Store build ${buildId.slice(0, 8)} queued on ${host.hostId}`);
    } catch (e) {
      record.state = 'failed';
      record.error = `Failed to send build to host: ${(e as Error).message}`;
      record.updatedAt = Date.now();
      this.scheduleAppStoreBuildCleanup(buildId);
    }

    return record;
  }

  getAppStoreBuild(buildId: string): AppStoreBuildRecord | null {
    return this.appStoreBuilds.get(buildId) ?? null;
  }

  handleAppStoreBuildEvent(msg: {
    buildId: string;
    event: AppStoreBuildEvent;
    line?: string;
    stream?: LogStream;
    scheme?: string;
    bundleId?: string;
    durationMs?: number;
    message?: string;
    diagnostic?: BuildDiagnostic;
    diagnostics?: BuildDiagnostic[];
  }): void {
    const record = this.appStoreBuilds.get(msg.buildId);
    if (!record) return;
    record.updatedAt = Date.now();

    switch (msg.event) {
      case 'started':
        record.state = 'building';
        break;
      case 'exporting':
        record.state = 'exporting';
        break;
      case 'uploading':
        record.state = 'uploading';
        break;
      case 'log':
        if (msg.line) {
          record.logs.push({
            line: msg.line,
            stream: msg.stream ?? 'stdout',
            at: Date.now(),
          });
          if (record.logs.length > this.maxDeviceBuildLogs) {
            record.logs.splice(0, record.logs.length - this.maxDeviceBuildLogs);
          }
        }
        break;
      case 'diagnostic':
        if (msg.diagnostic) record.diagnostics.push(msg.diagnostic);
        break;
      case 'succeeded':
        record.state = 'succeeded';
        record.scheme = msg.scheme;
        if (msg.bundleId) record.bundleId = msg.bundleId;
        record.durationMs = msg.durationMs;
        record.diagnostics = msg.diagnostics ?? record.diagnostics;
        this.scheduleAppStoreBuildCleanup(msg.buildId);
        break;
      case 'failed':
        record.state = 'failed';
        record.error = msg.message ?? 'App Store build failed.';
        record.durationMs = msg.durationMs;
        record.diagnostics = msg.diagnostics ?? record.diagnostics;
        this.scheduleAppStoreBuildCleanup(msg.buildId);
        break;
    }
  }

  private scheduleAppStoreBuildCleanup(buildId: string): void {
    const timer = setTimeout(() => {
      this.appStoreBuilds.delete(buildId);
    }, this.deviceBuildTtlMs);
    timer.unref();
  }

  // ── Session lifecycle ─────────────────────────────────────────────────────
  createSession(
    deviceModel: DeviceModel,
    awaitBuild = false,
    orientation?: Orientation,
  ): SessionRecord {
    const sessionId = randomUUID();
    const record: SessionRecord = {
      sessionId,
      streamToken: randomBytes(32).toString('base64url'),
      deviceModel,
      orientation,
      state: 'queued',
      hostId: null,
      createdAt: Date.now(),
      queuePosition: null,
      lastClientSeenAt: null,
      lastActivityAt: Date.now(),
      lastReason: null,
      awaitBuild,
      hostStarted: false,
    };
    this.sessions.set(sessionId, record);
    this.queue.push(sessionId);
    this.updateQueuePositions();
    log(`Session created ${sessionId.slice(0, 8)} (${deviceModel}${orientation ? `/${orientation}` : ''}${awaitBuild ? ', awaitBuild' : ''})`);
    this.placeQueued();
    return this.sessions.get(sessionId)!;
  }

  getSession(sessionId: string): SessionRecord | null {
    return this.sessions.get(sessionId) ?? null;
  }

  /** Record the orientation the host most recently reported for a session. */
  setSessionOrientation(sessionId: string, orientation: Orientation): void {
    const s = this.sessions.get(sessionId);
    if (s) s.orientation = orientation;
  }

  /**
   * Constant-time check that `token` is the stream capability for `sessionId`.
   * Returns false for unknown sessions or absent/mismatched tokens. Used to gate
   * the browser-facing WS upgrade so a bare sessionId can't open a stream.
   */
  verifyStreamToken(sessionId: string, token: string | null | undefined): boolean {
    const s = this.sessions.get(sessionId);
    if (!s || !token) return false;
    const expected = Buffer.from(s.streamToken);
    const provided = Buffer.from(token);
    // timingSafeEqual throws on length mismatch — guard first (length isn't secret).
    if (expected.length !== provided.length) return false;
    return timingSafeEqual(expected, provided);
  }

  endSession(sessionId: string, reason?: string): void {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    if (this.pendingStops.has(sessionId)) return; // already in flight
    this.pendingBuilds.delete(sessionId);

    const wasOnHost = !!s.hostId && this.hosts.has(s.hostId);
    // `hostStarted` is the precise signal — flipped on the same call that
    // sends build_session/start_session. `state !== 'queued'` would race: the
    // host can be mid-build before its first state update reaches us.
    const hadHostSideWork = wasOnHost && s.hostStarted;

    if (!hadHostSideWork) {
      // Either no host bound, or never sent build_session — no host-side
      // tear-down to wait for. Release synchronously.
      if (s.hostId) {
        const host = this.hosts.get(s.hostId);
        if (host) host.activeSessionIds.delete(sessionId);
      }
      this.queue = this.queue.filter((id) => id !== sessionId);
      this.setSessionState(s, 'ended', { reason });
      this.updateQueuePositions();
      setTimeout(() => this.sessions.delete(sessionId), 30_000);
      this.placeQueued();
      return;
    }

    // Has host-side state. Send stop, mark "pending stop", wait for the
    // host's session_event:ended (or timeout) before freeing the slot.
    const host = this.hosts.get(s.hostId!)!;
    try {
      host.send({ type: 'stop_session', sessionId });
    } catch {
      /* ignore */
    }
    this.setSessionState(s, 'ended', { reason });

    const timer = setTimeout(() => {
      warn(`Stop confirmation timeout for ${sessionId.slice(0, 8)}; force-releasing slot`);
      this.confirmEndSession(sessionId);
    }, this.stopGraceMs);
    timer.unref();
    this.pendingStops.set(sessionId, timer);
  }

  /**
   * Called when the host confirms a session is fully torn down OR when the
   * stop-confirmation timeout fires. Releases the slot and runs placeQueued.
   */
  confirmEndSession(sessionId: string): void {
    const timer = this.pendingStops.get(sessionId);
    if (timer) {
      clearTimeout(timer);
      this.pendingStops.delete(sessionId);
    }
    const s = this.sessions.get(sessionId);
    if (s?.hostId) {
      const host = this.hosts.get(s.hostId);
      if (host) host.activeSessionIds.delete(sessionId);
    }
    setTimeout(() => this.sessions.delete(sessionId), 30_000);
    this.placeQueued();
  }

  markStarting(sessionId: string): void {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    this.setSessionState(s, 'starting');
  }

  markBuilding(sessionId: string): void {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    this.setSessionState(s, 'building');
  }

  markStreaming(sessionId: string): void {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    this.setSessionState(s, 'streaming');
  }

  /**
   * Queue a build for this session. If a host is already bound, the
   * `build_session` is sent immediately. Otherwise the tarball is held and
   * dispatched as soon as placement happens. Returns false only when the
   * session no longer exists (caller should 404).
   */
  triggerBuild(
    sessionId: string,
    tarballBase64: string,
    hints?: { scheme?: string; bundleId?: string },
  ): boolean {
    const s = this.sessions.get(sessionId);
    if (!s) return false;
    s.lastActivityAt = Date.now(); // a build/refresh counts as activity
    this.pendingBuilds.set(sessionId, { tarballBase64, hints });
    this.flushPendingBuild(sessionId);
    return true;
  }

  private flushPendingBuild(sessionId: string): void {
    const pending = this.pendingBuilds.get(sessionId);
    if (!pending) return;
    const s = this.sessions.get(sessionId);
    if (!s || !s.hostId) return;
    const host = this.hosts.get(s.hostId);
    if (!host) return;
    host.activeSessionIds.add(sessionId);
    host.send({
      type: 'build_session',
      sessionId,
      deviceModel: s.deviceModel,
      orientation: s.orientation,
      tarballBase64: pending.tarballBase64,
      hints: pending.hints,
    });
    s.hostStarted = true;
    this.pendingBuilds.delete(sessionId);
  }

  // ── Input routing ─────────────────────────────────────────────────────────
  sendToHost(sessionId: string, message: unknown): boolean {
    const s = this.sessions.get(sessionId);
    if (!s || !s.hostId) return false;
    const host = this.hosts.get(s.hostId);
    if (!host) return false;
    host.send(message);
    return true;
  }

  /**
   * Forward a webcam frame from the browser to the session's host (reverse media
   * channel). Re-frames the browser's headerless JPEG into the controller→host
   * binary layout with the sessionId embedded so a multi-session host can route
   * it to the right shim. Best-effort: drops silently if no host is bound.
   */
  sendCameraFrameToHost(sessionId: string, timestampMs: number, jpeg: Buffer): boolean {
    const s = this.sessions.get(sessionId);
    if (!s || !s.hostId) return false;
    const host = this.hosts.get(s.hostId);
    if (!host) return false;
    const sid = Buffer.from(sessionId, 'utf8');
    const header = Buffer.alloc(12);
    header.writeUInt8(CAMERA_FRAME_VERSION, 0);
    header.writeUInt8(0, 1); // reserved
    header.writeUInt16BE(sid.length, 2);
    header.writeBigUInt64BE(BigInt(Math.max(0, Math.floor(timestampMs))), 4);
    try {
      host.sendRaw(Buffer.concat([header, sid, jpeg]));
    } catch {
      return false;
    }
    return true;
  }

  // ── Listeners (for /ws/session/:id) ───────────────────────────────────────
  onSessionEvent(sessionId: string, listener: SessionListener): () => void {
    let set = this.listeners.get(sessionId);
    if (!set) {
      set = new Set();
      this.listeners.set(sessionId, set);
    }
    set.add(listener);
    return () => {
      const cur = this.listeners.get(sessionId);
      if (!cur) return;
      cur.delete(listener);
      if (cur.size === 0) this.listeners.delete(sessionId);
    };
  }

  private fire(sessionId: string): void {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    const listeners = this.listeners.get(sessionId);
    if (!listeners) return;
    for (const l of listeners) {
      try {
        l(s);
      } catch (e) {
        warn(`session listener threw: ${(e as Error).message}`);
      }
    }
  }

  private setSessionState(
    s: SessionRecord,
    state: SessionState,
    extra?: { reason?: string },
  ): void {
    s.state = state;
    if (state !== 'queued') s.queuePosition = null;
    if (extra?.reason) {
      s.lastReason = extra.reason;
      log(`Session ${s.sessionId.slice(0, 8)} → ${state} (${extra.reason})`);
    } else {
      log(`Session ${s.sessionId.slice(0, 8)} → ${state}`);
    }
    this.fire(s.sessionId);
  }

  /** Record user activity (input, calibration, build). Resets the inactivity
   * clock. No-op for unknown/ended sessions. */
  recordActivity(sessionId: string): void {
    const s = this.sessions.get(sessionId);
    if (s) s.lastActivityAt = Date.now();
  }

  // ── Placement ─────────────────────────────────────────────────────────────
  private placeQueued(): void {
    while (this.queue.length > 0) {
      const host = this.pickHost();
      if (!host) break;
      const sessionId = this.queue.shift()!;
      const s = this.sessions.get(sessionId);
      if (!s || s.state !== 'queued') continue;
      s.hostId = host.hostId;
      host.activeSessionIds.add(sessionId);

      if (s.awaitBuild) {
        // Reserve the slot; the build endpoint will send `build_session` later.
        // Keep the session in `queued` until then so the UI shows "waiting for build".
        log(`Session ${sessionId.slice(0, 8)} placed on ${host.hostId} awaiting build.`);
        // Replay a tarball that was uploaded BEFORE placement happened.
        this.flushPendingBuild(sessionId);
        continue;
      }

      try {
        host.send({
          type: 'start_session',
          sessionId,
          deviceModel: s.deviceModel,
          orientation: s.orientation,
        });
        s.hostStarted = true;
      } catch (e) {
        warn(`Failed to send start_session: ${(e as Error).message}`);
        host.activeSessionIds.delete(sessionId);
        s.hostId = null;
        this.queue.unshift(sessionId);
        break;
      }
      this.setSessionState(s, 'starting');
    }
    this.updateQueuePositions();
  }

  /**
   * Set to true via ALLOW_BARE_METAL_FALLBACK=1 on the controller env. When
   * false (default), tenant sessions are NEVER placed on bare-metal hosts —
   * a bare-metal agent can stay alive for internal smoke tests without
   * accidentally serving real users. When true, bare-metal is allowed only
   * if no VM host has a free slot.
   */
  private readonly allowBareMetalFallback =
    (process.env.ALLOW_BARE_METAL_FALLBACK ?? '').toLowerCase() === '1' ||
    (process.env.ALLOW_BARE_METAL_FALLBACK ?? '').toLowerCase() === 'true';

  private pickHost(): HostRecord | null {
    // Two-pass: prefer kind='vm' hosts (the isolation boundary). Only fall
    // back to bare-metal if the operator opted in AND no VM has capacity.
    const pick = (predicate: (h: HostRecord) => boolean): HostRecord | null => {
      let best: HostRecord | null = null;
      for (const h of this.hosts.values()) {
        if (!predicate(h)) continue;
        const free = h.slots - h.activeSessionIds.size;
        if (free <= 0) continue;
        if (!best) {
          best = h;
          continue;
        }
        const bestFree = best.slots - best.activeSessionIds.size;
        // Best-fit: prefer host with the FEWEST free slots (densest packing).
        if (free < bestFree) best = h;
      }
      return best;
    };

    const vmPick = pick((h) => h.kind === 'vm');
    if (vmPick) return vmPick;
    if (this.allowBareMetalFallback) return pick((h) => h.kind === 'bare-metal');
    return null;
  }

  private pickDeviceBuildHost(): HostRecord | null {
    let best: HostRecord | null = null;
    for (const host of this.hosts.values()) {
      if (!best || host.activeSessionIds.size < best.activeSessionIds.size) {
        best = host;
      }
    }
    return best;
  }

  private scheduleDeviceBuildCleanup(buildId: string): void {
    const timer = setTimeout(() => {
      this.deviceBuilds.delete(buildId);
    }, this.deviceBuildTtlMs);
    timer.unref();
  }

  private updateQueuePositions(): void {
    this.queue.forEach((sid, idx) => {
      const s = this.sessions.get(sid);
      if (s && s.state === 'queued') {
        s.queuePosition = idx + 1;
        this.fire(sid);
      }
    });
  }
}
