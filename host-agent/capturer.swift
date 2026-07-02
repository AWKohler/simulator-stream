// capturer.swift — ScreenCaptureKit companion for expo-stream
// stdout protocol: [4-byte big-endian length][JPEG bytes]  (repeated)
// stderr:          human-readable status lines
//
// Usage: capturer <title-filter> [--fps=N] [--quality=Q] [--window-id=W]

import ScreenCaptureKit
import CoreGraphics
import ImageIO
import Foundation
import AppKit

// ── Config ────────────────────────────────────────────────────────────────────

struct Config {
    var titleFilter: String = "iPhone"
    var fps: Int = 30
    var quality: Double = 0.75
    var windowID: CGWindowID? = nil
}

func parseArgs() -> Config {
    var cfg = Config()
    for arg in CommandLine.arguments.dropFirst() {
        if arg.hasPrefix("--fps="),        let v = Int(arg.dropFirst(6))    { cfg.fps = v }
        else if arg.hasPrefix("--quality="), let v = Double(arg.dropFirst(10)) { cfg.quality = v }
        else if arg.hasPrefix("--window-id="), let v = UInt32(arg.dropFirst(12)) { cfg.windowID = CGWindowID(v) }
        else if !arg.hasPrefix("--") { cfg.titleFilter = arg }
    }
    return cfg
}

// ── Frame writer ──────────────────────────────────────────────────────────────

// Serial write queue — guarantees frames arrive in order on the other end
let writeQueue = DispatchQueue(label: "expo.capturer.write", qos: .userInteractive)
let stdoutHandle = FileHandle.standardOutput

func writeFrame(_ jpeg: Data) {
    writeQueue.async {
        var len = UInt32(jpeg.count).bigEndian
        let header = Data(bytes: &len, count: 4)
        stdoutHandle.write(header)
        stdoutHandle.write(jpeg)
    }
}

func log(_ s: String) { fputs(s + "\n", stderr) }

// ── Capturer delegate ─────────────────────────────────────────────────────────

class Capturer: NSObject, SCStreamOutput, SCStreamDelegate {

    // Serial encode queue — one JPEG in flight at a time, preventing CPU spikes.
    let encodeQueue = DispatchQueue(label: "expo.capturer.encode", qos: .userInteractive)

    let quality: Double
    var frameCount = 0

    init(quality: Double) { self.quality = quality }

    func stream(_ stream: SCStream,
                didOutputSampleBuffer sb: CMSampleBuffer,
                of type: SCStreamOutputType) {
        guard type == .screen else { return }
        guard let pixelBuffer = CMSampleBufferGetImageBuffer(sb) else { return }

        frameCount += 1

        // ── Raw pixel copy — fastest possible pool buffer release ──
        // Lock, memcpy, unlock. The CVPixelBuffer is returned to SCK's pool
        // in microseconds, preventing pool exhaustion at any frame rate.
        CVPixelBufferLockBaseAddress(pixelBuffer, .readOnly)
        let width      = CVPixelBufferGetWidth(pixelBuffer)
        let height     = CVPixelBufferGetHeight(pixelBuffer)
        let bytesPerRow = CVPixelBufferGetBytesPerRow(pixelBuffer)
        guard let base = CVPixelBufferGetBaseAddress(pixelBuffer) else {
            CVPixelBufferUnlockBaseAddress(pixelBuffer, .readOnly)
            return
        }
        let rawBytes = Data(bytes: base, count: height * bytesPerRow)
        CVPixelBufferUnlockBaseAddress(pixelBuffer, .readOnly)
        // ── Pool buffer released. SCK can immediately reuse it. ──

        let q = self.quality

        encodeQueue.async {
            // Build a CGImage directly from the raw BGRA bytes (no CIContext overhead).
            // pixelFormat = kCVPixelFormatType_32BGRA
            let bitmapInfo = CGBitmapInfo(rawValue:
                CGImageAlphaInfo.premultipliedFirst.rawValue |
                CGBitmapInfo.byteOrder32Little.rawValue)
            guard let provider = CGDataProvider(data: rawBytes as CFData),
                  let cg = CGImage(
                      width: width, height: height,
                      bitsPerComponent: 8, bitsPerPixel: 32,
                      bytesPerRow: bytesPerRow,
                      space: CGColorSpaceCreateDeviceRGB(),
                      bitmapInfo: bitmapInfo,
                      provider: provider,
                      decode: nil,
                      shouldInterpolate: false,
                      intent: .defaultIntent)
            else { return }

            let buf = NSMutableData()
            guard let dest = CGImageDestinationCreateWithData(
                    buf as CFMutableData, "public.jpeg" as CFString, 1, nil)
            else { return }
            CGImageDestinationAddImage(dest, cg,
                [kCGImageDestinationLossyCompressionQuality: q] as CFDictionary)
            guard CGImageDestinationFinalize(dest) else { return }

            writeFrame(buf as Data)
        }
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        log("STREAM_ERROR: \(error.localizedDescription)")
        exit(1)
    }
}

// ── Main ──────────────────────────────────────────────────────────────────────

// Module-level references keep both objects alive after run() returns.
// SCStream holds its delegate and output WEAKLY — if these local variables
// go out of scope when run() exits, SCK has no one to call and stops after
// delivering whatever frames were already in-flight.
var liveStream: SCStream? = nil
var liveCapturer: Capturer? = nil

// JSON listing mode: prints `[{id, title, x, y, w, h}, ...]` for every Simulator
// window to stdout and exits. Used by the host-agent to discover which window
// belongs to a newly-booted device (diff before/after `simctl boot`).
func listWindowsJSONAndExit() async -> Never {
    let content: SCShareableContent
    do {
        content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
    } catch {
        let err: [String: Any] = ["error": error.localizedDescription]
        let data = try! JSONSerialization.data(withJSONObject: err)
        FileHandle.standardOutput.write(data)
        exit(2)
    }
    let sims = content.windows.filter {
        $0.owningApplication?.bundleIdentifier == "com.apple.iphonesimulator"
    }
    let payload: [[String: Any]] = sims.map { w in
        [
            "id": w.windowID,
            "title": w.title ?? "",
            "x": Int(w.frame.origin.x),
            "y": Int(w.frame.origin.y),
            "w": Int(w.frame.width),
            "h": Int(w.frame.height),
        ]
    }
    let data = try! JSONSerialization.data(withJSONObject: payload)
    FileHandle.standardOutput.write(data)
    exit(0)
}

func run() async {
    if CommandLine.arguments.contains("--list-windows-json") {
        await listWindowsJSONAndExit()
    }

    let cfg = parseArgs()

    // Requesting shareable content triggers the Screen Recording permission prompt
    // the very first time this binary is run.
    let content: SCShareableContent
    do {
        content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
    } catch {
        log("ERROR: Cannot access screen content: \(error.localizedDescription)")
        log("ERROR: Go to System Settings → Privacy & Security → Screen Recording")
        log("ERROR: and add the Terminal app (or whatever launched this process).")
        exit(1)
    }

    // List every simulator window to stderr for diagnostics
    let simWindows = content.windows.filter {
        $0.owningApplication?.bundleIdentifier == "com.apple.iphonesimulator"
    }
    log("DEBUG: \(simWindows.count) simulator window(s) found:")
    for w in simWindows {
        log("DEBUG:   id=\(w.windowID) title='\(w.title ?? "nil")' frame=\(w.frame)")
    }

    // Match target window
    let target: SCWindow?
    if let wid = cfg.windowID {
        target = simWindows.first { $0.windowID == wid }
    } else {
        target = simWindows.first { $0.title == cfg.titleFilter }
            ?? simWindows.first { $0.title?.contains(cfg.titleFilter) == true }
            ?? simWindows.first  // last resort: first sim window
    }

    guard let window = target else {
        log("ERROR: No simulator window found matching '\(cfg.titleFilter)'")
        exit(1)
    }

    let frame = window.frame
    let scale = NSScreen.main?.backingScaleFactor ?? 2.0
    let outW = Int((frame.width  * scale).rounded())
    let outH = Int((frame.height * scale).rounded())

    // Emit window geometry for Node.js coordinate mapping
    log("WINDOW_INFO: id=\(window.windowID) x=\(Int(frame.origin.x)) y=\(Int(frame.origin.y)) w=\(Int(frame.width)) h=\(Int(frame.height)) scale=\(scale) title=\(window.title ?? "")")

    // Stream configuration
    let streamCfg = SCStreamConfiguration()
    streamCfg.width  = outW
    streamCfg.height = outH
    streamCfg.minimumFrameInterval = CMTime(value: 1, timescale: CMTimeScale(cfg.fps))
    // Keep pool small: with a serial encode queue we only ever have 1 buffer in-flight.
    streamCfg.queueDepth = 3
    streamCfg.showsCursor = false
    streamCfg.pixelFormat = kCVPixelFormatType_32BGRA

    // desktopIndependentWindow: captures this window regardless of position or occlusion.
    // Works even if the Simulator window is behind other windows.
    let filter = SCContentFilter(desktopIndependentWindow: window)
    let capturer = Capturer(quality: cfg.quality)
    liveCapturer = capturer  // retain — SCStream holds delegate/output weakly

    do {
        let stream = SCStream(filter: filter, configuration: streamCfg, delegate: capturer)
        try stream.addStreamOutput(capturer, type: .screen,
                                   sampleHandlerQueue: .global(qos: .userInteractive))
        try await stream.startCapture()
        liveStream = stream  // retain — keeps SCStream alive after run() returns
        log("STREAM_STARTED: \(outW)x\(outH) @\(cfg.fps)fps quality=\(cfg.quality)")
    } catch {
        log("ERROR: Stream start failed: \(error.localizedDescription)")
        exit(1)
    }
    // run() returns here; liveStream keeps the SCStream retained, RunLoop.main.run() keeps
    // the process alive, and SCK continues delivering frames on the sample handler queue.
}

Task { await run() }
RunLoop.main.run()
