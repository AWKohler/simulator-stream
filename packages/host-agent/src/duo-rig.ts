// Everything an iPhone Duo session needs beyond a single-panel one: a video
// stream per panel (cover and inner, at once), the hinge, and input that can
// reach either panel.
//
// What to know about the device:
//  - Its two panels are separate CoreSimulator displays, each with its own
//    framebuffer. iOS lights one of them according to the fold; the other
//    stays a black framebuffer. Both are captured the whole time, so the
//    client can show the device from any side and never waits for a stream to
//    start when the fold changes. A stream only sends a frame when its
//    picture changes, so the dark panel costs next to nothing.
//  - The inner panel's framebuffer is taller than wide, with the fold running
//    across its middle. Opened like a book, iOS draws its interface turned a
//    quarter turn inside that framebuffer. Clients place the picture on the
//    panel as it physically is; nothing here rotates it.
//  - CoreSimulator's own input path (which idb uses) reaches only the cover
//    and knows nothing of the hinge, so all input goes through a helper
//    running inside the simulator (duo-control).
import {
  DUO_DISPLAYS,
  MAX_GESTURE_MS,
  type DeviceOrientation,
  type DuoDisplay,
  type DuoState,
  type Input,
} from '@sim/shared';
import { DuoControl, duoDisplayUUIDs, type TouchPhase } from './duo-control.js';
import {
  listFramebufferDisplays,
  startFramebufferCapturer,
  type FramebufferCapturerHandle,
  type FramebufferVideoChunk,
  type FramebufferVideoConfig,
} from './framebuffer-capturer.js';
import { hidCodeForKey } from './idb.js';
import { textKeyStrokes } from './idb-hid.js';
import { sleep } from './util.js';
import { log, warn } from './log.js';

const envInt = (name: string, fallback: number): number => {
  const parsed = parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};
const envScale = (name: string): number => {
  const parsed = parseFloat(process.env[name] ?? '');
  return Number.isFinite(parsed) && parsed > 0.1 && parsed <= 1 ? parsed : 1;
};

const DUO_FPS = envInt('SIM_DUO_FPS', envInt('SIM_FRAMEBUFFER_FPS', 60));
// The inner panel has 1.9× the pixels of an iPhone's screen.
const BITRATE: Record<DuoDisplay, number> = {
  cover: envInt('SIM_DUO_COVER_BITRATE', 6_000_000),
  inner: envInt('SIM_DUO_INNER_BITRATE', 10_000_000),
};
const SCALE: Record<DuoDisplay, number> = {
  cover: envScale('SIM_DUO_COVER_SCALE'),
  inner: envScale('SIM_DUO_INNER_SCALE'),
};
/** Points → pixels on both panels. */
const DUO_UI_SCALE = 3;
/** Fold angle a session starts at: open flat, the inner screen showing. */
const START_ANGLE = Math.min(180, Math.max(0, envInt('SIM_DUO_START_ANGLE', 180)));
/** A finger left down by a client that went away is lifted after this long. */
const TOUCH_IDLE_MS = 8_000;
/** `duo_state` is sent at most this often while the hinge moves. */
const STATE_INTERVAL_MS = 33;
/**
 * A session's first moments are iOS's busiest: the app is still launching and
 * the system has only just moved to the inner screen. Folding or turning the
 * device right then has been seen to take down the simulated wallpaper process
 * and leave the app in the background. So the device is left alone until the
 * opening fold has come to rest, and a client's first posture (it may have one
 * ready the instant the stream starts) waits this long after that.
 */
const POSTURE_GRACE_MS = 900;
const MAX_QUEUED_GESTURES = 24;
const MAX_QUEUED_KEY_RUNS = 64;

export interface DuoRigEvents {
  onVideoConfig: (display: DuoDisplay, config: FramebufferVideoConfig) => void;
  onVideoChunk: (display: DuoDisplay, chunk: FramebufferVideoChunk) => void;
  onState: (state: DuoState) => void;
  /** Both streams are running. */
  onReady: () => void;
  /** Something the session cannot recover from. */
  onFatal: (message: string) => void;
}

interface Panel {
  display: DuoDisplay;
  screenID: number;
  uuid: string;
  /** Framebuffer size: the frame touches are fractions of. */
  width: number;
  height: number;
  lit: boolean;
  capturer: FramebufferCapturerHandle | null;
  configured: boolean;
  /** Fingers this panel has down, by index. */
  fingersDown: Set<number>;
  scroll: { dx: number; dy: number; x: number; y: number; timer: NodeJS.Timeout | null };
}

/** Screen ids, when the Mac's CoreSimulator numbers them differently. */
function screenIDOverride(display: DuoDisplay): number | null {
  const raw = display === 'inner' ? process.env.SIM_DUO_INNER_SCREEN_ID : process.env.SIM_DUO_COVER_SCREEN_ID;
  const id = Number(raw);
  return raw !== undefined && Number.isSafeInteger(id) && id >= 0 ? id : null;
}

export class DuoRig {
  private control: DuoControl | null = null;
  private panels = {} as Record<DuoDisplay, Panel>;
  private hinge = { angle: 0, moving: false };
  private orientation: DeviceOrientation = 'portrait';
  private stopped = false;
  private ready = false;
  private stateTimer: NodeJS.Timeout | null = null;
  private lastStateAt = 0;
  private touchIdleTimer: NodeJS.Timeout | null = null;
  /** Taps and swipes are replayed one after another, never interleaved. */
  private gestureQueue: Promise<void> = Promise.resolve();
  /** Replayed gestures waiting or running. Past the limit new ones are dropped:
   * each can last seconds, and nothing a person does queues this many. */
  private gesturesQueued = 0;
  /** Typed text and keys, sent one run after another (see typeKeys). */
  private keyQueue: Promise<void> = Promise.resolve();
  private keysQueued = 0;
  /** Posture inputs are held until this time (see POSTURE_GRACE_MS). */
  private postureAt = Number.POSITIVE_INFINITY;
  private heldPosture: { hinge?: { angle: number; instant: boolean }; orientation?: DeviceOrientation } = {};
  private postureTimer: NodeJS.Timeout | null = null;
  /** Resolves the wait for the opening fold to come to rest. */
  private hingeRest: (() => void) | null = null;

  private constructor(
    private readonly udid: string,
    private readonly events: DuoRigEvents,
  ) {}

  /** A rig that has not started yet. Hold on to it, then `start()` it: that
   * way it can be stopped at any point of a start-up that takes seconds. */
  static create(udid: string, events: DuoRigEvents): DuoRig {
    return new DuoRig(udid, events);
  }

  private assertRunning(): void {
    if (this.stopped) throw new Error('Session ended while the iPhone Duo was starting.');
  }

  /**
   * Find both panels, open the control helper, fold to the starting angle and
   * start a capturer per panel. Resolves once the helper is up and the
   * capturers are started; `onReady` follows when both have a stream. If
   * `stop()` is called meanwhile it stops at the next step and rejects, with
   * nothing left running.
   */
  async start(): Promise<void> {
    const rig = this;
    const udid = this.udid;
    try {
      await rig.resolvePanels();
      rig.assertRunning();
      const control = await DuoControl.open(udid);
      if (rig.stopped) {
        control.close();
        rig.assertRunning();
      }
      rig.control = control;
      control.onHinge = (report) => {
        rig.hinge = { angle: report.angle, moving: report.moving };
        if (!report.moving) rig.hingeRest?.();
        rig.scheduleState();
      };
      control.onExit = (reason) => {
        if (!rig.stopped) rig.events.onFatal(reason);
      };
      // The simulator boots shut. Say so first (the helper cannot read the
      // hinge), then ease to the starting angle so iOS sees a fold it can follow.
      // A reused simulator may have been left turned by its last session.
      await control.orientation('portrait');
      rig.assertRunning();
      await control.setHinge(0, true);
      rig.assertRunning();
      if (START_ANGLE > 0) {
        // Wait for the fold to arrive (and iOS to light the inner screen)
        // before streaming, so the first picture a client sees is the right one.
        const rested = new Promise<void>((resolve) => {
          rig.hingeRest = resolve;
        });
        await control.setHinge(START_ANGLE);
        await Promise.race([rested, sleep(2500)]);
        rig.hingeRest = null;
        rig.assertRunning();
        await sleep(350);
      }
      rig.assertRunning();
      rig.startCapture();
    } catch (e) {
      const ended = rig.stopped;
      rig.stop();
      throw ended ? new Error('Session ended while the iPhone Duo was starting.') : e;
    }
  }

  /** The panels' framebuffers appear a little after boot; wait for both. */
  private async resolvePanels(): Promise<void> {
    const deadline = Date.now() + 45_000;
    let lastError = 'the simulator has no displays yet';
    while (Date.now() < deadline && !this.stopped) {
      try {
        const displays = (await listFramebufferDisplays(this.udid)).filter((d) => d.width > 0 && d.height > 0);
        const uuids = await duoDisplayUUIDs(this.udid);
        // The inner panel is the larger of the two framebuffers.
        const bySize = [...displays].sort((a, b) => b.width * b.height - a.width * a.height);
        const pick = (display: DuoDisplay) => {
          const override = screenIDOverride(display);
          if (override !== null) return displays.find((d) => d.screenID === override);
          return display === 'inner' ? bySize[0] : bySize[1];
        };
        const inner = pick('inner');
        const cover = pick('cover');
        if (inner && cover && inner.screenID !== cover.screenID) {
          const innerUUID = uuids.get(inner.screenID);
          const coverUUID = uuids.get(cover.screenID);
          if (innerUUID && coverUUID) {
            const panel = (display: DuoDisplay, d: typeof inner, uuid: string): Panel => ({
              display,
              screenID: d.screenID,
              uuid,
              width: d.width,
              height: d.height,
              lit: d.lit,
              capturer: null,
              configured: false,
              fingersDown: new Set(),
              scroll: { dx: 0, dy: 0, x: 0.5, y: 0.5, timer: null },
            });
            this.panels = { cover: panel('cover', cover, coverUUID), inner: panel('inner', inner, innerUUID) };
            log(
              `Duo ${this.udid.slice(0, 8)} panels: cover screen ${cover.screenID} ${cover.width}x${cover.height}, ` +
                `inner screen ${inner.screenID} ${inner.width}x${inner.height}`,
            );
            return;
          }
          lastError = 'a panel has no display id';
        } else {
          lastError = `found ${displays.length} display(s), need the cover and the inner panel`;
        }
      } catch (e) {
        lastError = (e as Error).message;
      }
      await sleep(1000);
    }
    this.assertRunning();
    throw new Error(`iPhone Duo displays did not come up: ${lastError}`);
  }

  private startCapture(): void {
    const watchdog = setTimeout(() => {
      if (!this.stopped && !this.ready) this.events.onFatal('Capture did not start (no framebuffer surface).');
    }, 45_000);
    for (const display of DUO_DISPLAYS) {
      const panel = this.panels[display];
      panel.capturer = startFramebufferCapturer(
        {
          udid: this.udid,
          screenID: panel.screenID,
          fps: DUO_FPS,
          bitrate: BITRATE[display],
          keyframeInterval: DUO_FPS,
          scale: SCALE[display],
          skipUnchanged: true,
          reportLit: true,
        },
        {
          onConfig: (config) => {
            if (this.stopped) return;
            panel.configured = true;
            this.events.onVideoConfig(display, config);
            if (!this.ready && DUO_DISPLAYS.every((d) => this.panels[d].configured)) {
              this.ready = true;
              this.postureAt = Date.now() + POSTURE_GRACE_MS;
              clearTimeout(watchdog);
              this.emitState();
              this.events.onReady();
            }
          },
          onChunk: (chunk) => {
            if (!this.stopped) this.events.onVideoChunk(display, chunk);
          },
          onLit: (lit) => {
            if (this.stopped || panel.lit === lit) return;
            panel.lit = lit;
            this.scheduleState();
          },
          onError: (message) => {
            if (this.stopped) return;
            warn(`duo ${display} capturer: ${message}`);
            if (!panel.configured) {
              clearTimeout(watchdog);
              this.events.onFatal(message);
            }
          },
          onExit: (reason) => {
            if (this.stopped) return;
            clearTimeout(watchdog);
            this.events.onFatal(`${display} capturer stopped: ${reason}`);
          },
        },
      );
    }
  }

  isReady(): boolean {
    return this.ready;
  }

  /** The panel shown when the device is open: used for the legacy single-screen fields. */
  primaryPanelSize(): { width: number; height: number; scale: number } {
    const inner = this.panels.inner;
    return { width: inner.width, height: inner.height, scale: DUO_UI_SCALE };
  }

  state(): DuoState {
    const panel = (display: DuoDisplay) => {
      const p = this.panels[display];
      return { width: p.width, height: p.height, scale: DUO_UI_SCALE, lit: p.lit };
    };
    return {
      hingeAngle: this.hinge.angle,
      hingeMoving: this.hinge.moving,
      orientation: this.orientation,
      cover: panel('cover'),
      inner: panel('inner'),
    };
  }

  private emitState(): void {
    if (this.stopped || !this.ready) return;
    this.lastStateAt = Date.now();
    this.events.onState(this.state());
  }

  /** Coalesce bursts (the hinge reports sixty angles a second while it moves). */
  private scheduleState(): void {
    if (this.stopped || this.stateTimer) return;
    const wait = Math.max(0, STATE_INTERVAL_MS - (Date.now() - this.lastStateAt));
    this.stateTimer = setTimeout(() => {
      this.stateTimer = null;
      this.emitState();
    }, wait);
  }

  // ── Input ──────────────────────────────────────────────────────────────────
  // Coordinates are fractions of the addressed panel's framebuffer.

  /** The panel an input without `display` is meant for: the one that is lit. */
  private panelFor(display: DuoDisplay | undefined): Panel {
    if (display) return this.panels[display];
    return this.panels.inner.lit || !this.panels.cover.lit ? this.panels.inner : this.panels.cover;
  }

  async handleInput(input: Input): Promise<void> {
    const control = this.control;
    if (!control || this.stopped) return;
    try {
      switch (input.kind) {
        case 'hinge':
          if (this.holdPosture({ hinge: { angle: input.angle, instant: input.instant === true } })) break;
          await control.setHinge(input.angle, input.instant === true);
          break;
        case 'device_orientation':
          if (this.holdPosture({ orientation: input.orientation })) break;
          await this.applyOrientation(input.orientation);
          break;
        case 'touch':
          // Not awaited: the helper's pipe keeps a touch stream in order.
          this.liveTouch(this.panelFor(input.display), input.phase, input.normX, input.normY, input.finger ?? 0);
          break;
        case 'tap': {
          const panel = this.panelFor(input.display);
          await this.gesture(panel, async () => {
            await control.touch(panel.uuid, 'down', input.normX, input.normY);
            await sleep(Math.min(MAX_GESTURE_MS, input.durationMs ?? 60));
            await control.touch(panel.uuid, 'up', input.normX, input.normY);
          });
          break;
        }
        case 'swipe': {
          const panel = this.panelFor(input.display);
          await this.swipe(panel, input.startX, input.startY, input.endX, input.endY, input.durationMs, input.endHoldMs);
          break;
        }
        case 'scroll':
          this.scroll(this.panelFor(input.display), input.normX, input.normY, input.deltaX, input.deltaY);
          break;
        case 'button': {
          await control.button(input.button, true);
          await sleep(90);
          await control.button(input.button, false);
          break;
        }
        case 'text': {
          const strokes = textKeyStrokes(input.text);
          if (strokes) await this.typeKeys(strokes);
          else warn('duo: text has a character with no key mapping; dropped');
          break;
        }
        case 'key': {
          const code = hidCodeForKey(input.key);
          if (code !== null) await this.typeKeys([[code, true], [code, false]]);
          break;
        }
      }
    } catch (e) {
      if (!this.stopped) warn(`duo input ${input.kind} failed: ${(e as Error).message}`);
    }
  }

  private async applyOrientation(orientation: DeviceOrientation): Promise<void> {
    if (!this.control || orientation === this.orientation) return;
    await this.control.orientation(orientation);
    this.orientation = orientation;
    log(`Duo ${this.udid.slice(0, 8)} held ${orientation}`);
    this.scheduleState();
  }

  /**
   * During the grace period after start-up, keep a posture input (the latest
   * of each kind) for later instead of applying it. Returns whether it was kept.
   */
  private holdPosture(posture: { hinge?: { angle: number; instant: boolean }; orientation?: DeviceOrientation }): boolean {
    const wait = this.postureAt - Date.now();
    if (wait <= 0 && !this.postureTimer) return false;
    Object.assign(this.heldPosture, posture);
    if (!this.postureTimer) {
      this.postureTimer = setTimeout(() => {
        this.postureTimer = null;
        const held = this.heldPosture;
        this.heldPosture = {};
        const control = this.control;
        if (!control || this.stopped) return;
        void (async () => {
          try {
            if (held.hinge) await control.setHinge(held.hinge.angle, held.hinge.instant);
            if (held.orientation) await this.applyOrientation(held.orientation);
          } catch (e) {
            if (!this.stopped) warn(`duo posture after start failed: ${(e as Error).message}`);
          }
        })();
      }, Math.max(0, wait));
    }
    return true;
  }

  /**
   * Keys go to the helper strictly in the order they were typed. A long paste
   * is sent in pieces, and inputs are handled as they arrive: without this an
   * Enter pressed during the paste would land in the middle of it.
   */
  private typeKeys(strokes: Array<[number, boolean]>): Promise<void> {
    if (this.keysQueued >= MAX_QUEUED_KEY_RUNS) {
      warn(`${strokes.length} key events dropped: ${this.keysQueued} runs of typing are already waiting.`);
      return Promise.resolve();
    }
    this.keysQueued++;
    const run = this.keyQueue
      .catch(() => undefined)
      .then(() => (this.stopped || !this.control ? undefined : this.control.keys(strokes)))
      .finally(() => {
        this.keysQueued--;
      });
    this.keyQueue = run;
    return run;
  }

  private gesture(panel: Panel, run: () => Promise<void>): Promise<void> {
    if (this.gesturesQueued >= MAX_QUEUED_GESTURES) return Promise.resolve();
    this.gesturesQueued++;
    this.gestureQueue = this.gestureQueue
      .catch(() => undefined)
      .then(async () => {
        if (this.stopped) return;
        try {
          await run();
        } catch (e) {
          // Half a gesture must not leave a finger on the glass.
          await this.control?.release(panel.uuid).catch(() => undefined);
          throw e;
        }
      })
      .finally(() => {
        this.gesturesQueued--;
      });
    return this.gestureQueue;
  }

  private liveTouch(panel: Panel, phase: TouchPhase, x: number, y: number, finger: number): void {
    const control = this.control;
    if (!control) return;
    if (phase === 'down') panel.fingersDown.add(finger);
    else if (phase === 'up') panel.fingersDown.delete(finger);
    control.touch(panel.uuid, phase, x, y, finger).catch(() => undefined);
    // A client that vanishes mid-touch must not leave a finger on the glass.
    if (this.touchIdleTimer) clearTimeout(this.touchIdleTimer);
    this.touchIdleTimer = null;
    if (DUO_DISPLAYS.some((d) => this.panels[d].fingersDown.size > 0)) {
      this.touchIdleTimer = setTimeout(() => {
        this.touchIdleTimer = null;
        for (const d of DUO_DISPLAYS) this.panels[d].fingersDown.clear();
        control.release().catch(() => undefined);
      }, TOUCH_IDLE_MS);
    }
  }

  /** A finger drawn from start to end over `durationMs`, resting `endHoldMs` before it lifts. */
  private swipe(
    panel: Panel,
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    durationMs = 250,
    endHoldMs = 0,
  ): Promise<void> {
    const control = this.control;
    if (!control) return Promise.resolve();
    const duration = Math.min(MAX_GESTURE_MS, Math.max(30, durationMs));
    const steps = Math.max(4, Math.min(120, Math.round(duration / 12)));
    return this.gesture(panel, async () => {
      await control.touch(panel.uuid, 'down', x1, y1);
      for (let i = 1; i <= steps; i++) {
        await sleep(duration / steps);
        const t = i / steps;
        await control.touch(panel.uuid, 'move', x1 + (x2 - x1) * t, y1 + (y2 - y1) * t);
      }
      if (endHoldMs > 0) await sleep(Math.min(1000, endHoldMs));
      await control.touch(panel.uuid, 'up', x2, y2);
    });
  }

  /**
   * Wheel deltas, along the framebuffer's own axes (the client turns them to
   * match however the panel is facing). Gathered for 80 ms and replayed as one
   * swipe, as on the single-panel devices.
   */
  private scroll(panel: Panel, x: number, y: number, deltaX: number, deltaY: number): void {
    const acc = panel.scroll;
    acc.dx += deltaX;
    acc.dy += deltaY;
    acc.x = x;
    acc.y = y;
    if (acc.timer) return;
    // Nobody awaits a wheel scroll: a failure (the session ending mid-swipe,
    // the helper going away) must end here, not as an unhandled rejection.
    const scrollFailed = (e: unknown): void => {
      if (!this.stopped) warn(`duo scroll failed: ${(e as Error).message}`);
    };
    acc.timer = setTimeout(() => {
      acc.timer = null;
      if (this.stopped) return;
      const { dx, dy, x: ax, y: ay } = acc;
      acc.dx = 0;
      acc.dy = 0;
      const logicalW = panel.width / DUO_UI_SCALE;
      const logicalH = panel.height / DUO_UI_SCALE;
      const SPEED = 3;
      const distX = Math.min(400, Math.abs(dx) * SPEED);
      const distY = Math.min(400, Math.abs(dy) * SPEED);
      if (distX < 5 && distY < 5) return;
      const clamp = (v: number): number => Math.min(0.98, Math.max(0.02, v));
      if (distY >= distX) {
        const dir = dy > 0 ? -1 : 1;
        const half = (dir * distY) / logicalH / 2;
        this.swipe(panel, ax, clamp(ay - half), ax, clamp(ay + half)).catch(scrollFailed);
      } else {
        const dir = dx > 0 ? -1 : 1;
        const half = (dir * distX) / logicalW / 2;
        this.swipe(panel, clamp(ax - half), ay, clamp(ax + half), ay).catch(scrollFailed);
      }
    }, 80);
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.stateTimer) clearTimeout(this.stateTimer);
    if (this.touchIdleTimer) clearTimeout(this.touchIdleTimer);
    if (this.postureTimer) clearTimeout(this.postureTimer);
    this.hingeRest?.();
    for (const display of DUO_DISPLAYS) {
      const panel = this.panels[display];
      if (!panel) continue;
      if (panel.scroll.timer) clearTimeout(panel.scroll.timer);
      panel.capturer?.stop();
      panel.capturer = null;
    }
    this.control?.close();
    this.control = null;
  }
}
