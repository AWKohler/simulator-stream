// gRPC client for idb_companion's `video_stream` RPC.
//
// Why this exists: idb_companion can stream the simulator's device framebuffer
// as a persistent MJPEG/H264 stream at 30fps — far better than spawning
// `simctl io screenshot` per frame. The official idb Python client that would
// drive this has a broken grpclib on modern Python, so we talk to the
// companion's gRPC endpoint directly over its Unix domain socket.
//
// Capture source is the device framebuffer (same as `simctl screenshot`) — NOT
// a macOS window — so there's no title bar / occlusion / Mission Control jank.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { log, warn } from './log.js';

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROTO_PATH = path.join(PKG_ROOT, 'proto', 'idb-video.proto');

export type IdbVideoFormat = 'MJPEG' | 'H264';

export interface IdbVideoStreamOptions {
  /** Unix domain socket the companion is bound to. */
  socketPath: string;
  fps?: number;
  format?: IdbVideoFormat;
  /** 0..1 — JPEG quality for MJPEG, ignored for H264. */
  compressionQuality?: number;
  /** 0..1 — downscale factor; 1 = native device resolution. */
  scaleFactor?: number;
}

export interface IdbVideoStreamEvents {
  /** A complete encoded frame. For MJPEG this is one JPEG; for H264, a chunk. */
  onFrame: (data: Buffer) => void;
  onError: (message: string) => void;
  onExit: (reason: string) => void;
}

export interface IdbVideoStreamHandle {
  stop: () => void;
}

// ── proto loading (once per process) ────────────────────────────────────────
interface CompanionServiceClient extends grpc.Client {
  video_stream: () => grpc.ClientDuplexStream<unknown, VideoStreamResponse>;
}
interface VideoStreamResponse {
  log_output?: Buffer;
  payload?: { data?: Buffer; file_path?: string; url?: string };
}

let CompanionService: grpc.ServiceClientConstructor | null = null;

function loadService(): grpc.ServiceClientConstructor {
  if (CompanionService) return CompanionService;
  const def = protoLoader.loadSync(PROTO_PATH, {
    keepCase: true, // keep snake_case field names exactly as in the proto
    longs: Number,
    enums: String, // accept/emit enum values as their string names
    defaults: true,
    oneofs: true,
  });
  const pkg = grpc.loadPackageDefinition(def) as unknown as {
    idb: { CompanionService: grpc.ServiceClientConstructor };
  };
  CompanionService = pkg.idb.CompanionService;
  return CompanionService;
}

/**
 * Open a video stream against the companion at `socketPath`. Frames are
 * delivered via `events.onFrame`. Call the returned handle's `stop()` to end
 * the stream cleanly (sends a Stop control message, then closes).
 */
export function startIdbVideoStream(
  options: IdbVideoStreamOptions,
  events: IdbVideoStreamEvents,
): IdbVideoStreamHandle {
  const {
    socketPath,
    fps = 30,
    format = 'MJPEG',
    compressionQuality = 0.7,
    scaleFactor = 1,
  } = options;

  const Service = loadService();
  // grpc-js Unix-socket target syntax: `unix://` + absolute path.
  const target = `unix://${socketPath}`;
  const client = new Service(
    target,
    grpc.credentials.createInsecure(),
  ) as unknown as CompanionServiceClient;

  const call = client.video_stream();
  const demux = format === 'MJPEG' ? new MjpegDemuxer() : null;
  let stopped = false;
  let firstFrameLogged = false;

  call.on('data', (resp: VideoStreamResponse) => {
    if (resp.log_output && resp.log_output.length > 0) {
      // Companion-side diagnostic text — surface at debug level only.
      return;
    }
    const data = resp.payload?.data;
    if (!data || data.length === 0) return;
    if (demux) {
      for (const frame of demux.push(data)) {
        if (!firstFrameLogged) {
          firstFrameLogged = true;
          log(`idb video-stream: first MJPEG frame ${frame.length} bytes`);
        }
        events.onFrame(frame);
      }
    } else {
      // H264: pass chunks straight through — the consumer reassembles.
      if (!firstFrameLogged) {
        firstFrameLogged = true;
        log(`idb video-stream: first H264 chunk ${data.length} bytes`);
      }
      events.onFrame(Buffer.from(data));
    }
  });

  call.on('error', (e: grpc.ServiceError) => {
    // grpc CANCELLED is expected when WE call stop() — don't surface it.
    if (stopped && e.code === grpc.status.CANCELLED) return;
    events.onError(`idb video-stream gRPC error: ${e.message}`);
  });

  call.on('end', () => {
    events.onExit(stopped ? 'stopped' : 'companion ended stream');
  });

  // Kick off the stream.
  call.write({
    start: {
      file_path: '',
      fps,
      format,
      compression_quality: compressionQuality,
      scale_factor: scaleFactor,
      avg_bitrate: 0,
    },
  });
  log(
    `idb video-stream started (socket=${socketPath}, fps=${fps}, format=${format}, q=${compressionQuality})`,
  );

  return {
    stop: () => {
      if (stopped) return;
      stopped = true;
      try {
        call.write({ stop: {} });
        call.end();
      } catch (e) {
        warn(`idb video-stream stop error: ${(e as Error).message}`);
      }
      // Give the companion a beat to flush, then force-close the client.
      setTimeout(() => {
        try {
          call.cancel();
        } catch {
          /* ignore */
        }
        client.close();
      }, 250);
    },
  };
}

/**
 * Splits a byte stream of concatenated JPEGs into discrete frames.
 *
 * JPEG framing: each image is `FF D8` (SOI) … `FF D9` (EOI). Within entropy-
 * coded scan data a literal `FF` is byte-stuffed as `FF 00`, and restart
 * markers are `FF D0`–`FF D7` — so a bare `FF D9` is unambiguously the EOI.
 * We scan for SOI, then the next EOI, emit `[SOI..EOI]`, and continue.
 */
class MjpegDemuxer {
  private buf: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): Buffer[] {
    this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk]);
    const frames: Buffer[] = [];

    for (;;) {
      const soi = this.indexOfMarker(0xd8, 0);
      if (soi < 0) {
        // No start marker yet — keep only a trailing partial 0xFF so we don't
        // miss an SOI split across chunks.
        if (this.buf.length > 0 && this.buf[this.buf.length - 1] !== 0xff) {
          this.buf = Buffer.alloc(0);
        }
        break;
      }
      const eoi = this.indexOfMarker(0xd9, soi + 2);
      if (eoi < 0) {
        // Incomplete frame — retain from SOI onward for the next chunk.
        if (soi > 0) this.buf = this.buf.subarray(soi);
        break;
      }
      frames.push(this.buf.subarray(soi, eoi + 2));
      this.buf = this.buf.subarray(eoi + 2);
    }

    // Guard against unbounded growth if the stream is malformed.
    if (this.buf.length > 16 * 1024 * 1024) {
      this.buf = Buffer.alloc(0);
    }
    return frames;
  }

  private indexOfMarker(marker: number, from: number): number {
    for (let i = from; i < this.buf.length - 1; i++) {
      if (this.buf[i] === 0xff && this.buf[i + 1] === marker) return i;
    }
    return -1;
  }
}
