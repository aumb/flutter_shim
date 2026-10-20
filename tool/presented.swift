// Counts how many times a second the screen's content actually changes, which
// is the only honest way to tell whether a browser's animation reaches the
// display at 120 Hz or at 60. It replaces filming the screen with a
// slow-motion camera: ScreenCaptureKit hands over a frame only when the
// captured region changed, so changed frames a second is the rate that
// reached the screen.
//
//   swift tool/presented.swift [seconds] [--window <title substring>] [--rect x,y,w,h]
//
// With --window it captures that window alone, so nothing else moving on the
// screen is counted; the lab pages title themselves "Frame Lab: <test>".
// Otherwise it captures a band across the middle of the main display, where
// the lab pages move their stripe. Keep the page in front and the pointer
// still either way.
//
// Needs Screen Recording permission for whichever app runs it; macOS asks the
// first time, and the capture then starts working without a restart.

import AppKit
import AVFoundation
import CoreGraphics
import ScreenCaptureKit

// ScreenCaptureKit asks CoreGraphics about windows, which asserts unless the
// process has connected to the window server. Touching NSApplication does it.
_ = NSApplication.shared

let arguments = Array(CommandLine.arguments.dropFirst())
let seconds = Double(arguments.first { Double($0) != nil } ?? "") ?? 3
var requestedRect: CGRect?
if let i = arguments.firstIndex(of: "--rect"), i + 1 < arguments.count {
    let n = arguments[i + 1].split(separator: ",").compactMap { Double($0) }
    if n.count == 4 { requestedRect = CGRect(x: n[0], y: n[1], width: n[2], height: n[3]) }
}
var windowMatch: String?
if let i = arguments.firstIndex(of: "--window"), i + 1 < arguments.count { windowMatch = arguments[i + 1] }
var appMatch: String?
if let i = arguments.firstIndex(of: "--app"), i + 1 < arguments.count { appMatch = arguments[i + 1] }
if windowMatch == nil && appMatch != nil { windowMatch = "" }

final class Collector: NSObject, SCStreamOutput, SCStreamDelegate {
    private let lock = NSLock()
    private(set) var changed: [Double] = [] // presentation time of each frame whose pixels differed
    private(set) var captured = 0
    private var previousHash: UInt64 = 0

    // The capture delivers a frame every display refresh whether or not the
    // window drew anything, and its "complete" status says the frame is
    // valid, not that it changed. So the pixels decide: a hash over a strided
    // sample of them is enough to tell one drawn frame from the next, as long
    // as the page keeps something moving.
    private func hash(_ buffer: CVPixelBuffer) -> UInt64 {
        CVPixelBufferLockBaseAddress(buffer, .readOnly)
        defer { CVPixelBufferUnlockBaseAddress(buffer, .readOnly) }
        guard let base = CVPixelBufferGetBaseAddress(buffer) else { return 0 }
        let bytesPerRow = CVPixelBufferGetBytesPerRow(buffer)
        let width = CVPixelBufferGetWidth(buffer), height = CVPixelBufferGetHeight(buffer)
        var h: UInt64 = 0xcbf29ce484222325
        for y in 0..<height {
            let row = base.advanced(by: y * bytesPerRow).assumingMemoryBound(to: UInt8.self)
            for x in stride(from: 0, to: width * 4, by: 4) {
                h = (h ^ UInt64(row[x])) &* 0x100000001b3
            }
        }
        return h
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .screen,
              let attachments = CMSampleBufferGetSampleAttachmentsArray(sampleBuffer, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
              let raw = attachments.first?[.status] as? Int,
              SCFrameStatus(rawValue: raw) == .complete,
              let buffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
        let time = CMSampleBufferGetPresentationTimeStamp(sampleBuffer).seconds
        let h = hash(buffer)
        lock.lock()
        captured += 1
        if h != previousHash {
            previousHash = h
            changed.append(time)
        }
        lock.unlock()
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        FileHandle.standardError.write("stream stopped: \(error.localizedDescription)\n".data(using: .utf8)!)
    }
}

let done = DispatchSemaphore(value: 0)
let collector = Collector()

Task {
    do {
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
        if arguments.contains("--list") {
            for window in content.windows where (window.title ?? "").isEmpty == false {
                print("\(window.owningApplication?.applicationName ?? "?"): \(window.title ?? "")")
            }
            exit(0)
        }
        let config = SCStreamConfiguration()
        config.scalesToFit = false
        config.showsCursor = false
        config.queueDepth = 8
        // Faster than any display, so the capture is never the limit.
        config.minimumFrameInterval = CMTime(value: 1, timescale: 240)
        config.pixelFormat = kCVPixelFormatType_32BGRA

        var filter: SCContentFilter
        var what: String
        if let match = windowMatch {
            guard let window = content.windows.first(where: {
                (match.isEmpty || ($0.title ?? "").localizedCaseInsensitiveContains(match)) &&
                (appMatch == nil || ($0.owningApplication?.applicationName ?? "").localizedCaseInsensitiveContains(appMatch!))
            }) else {
                print("no window matching \"\(match)\"\(appMatch.map { " in \($0)" } ?? "") (is the page open and on screen?)")
                exit(1)
            }
            // A browser window that another app covers is throttled, and a
            // page in it may stop animating altogether, so the measurement
            // would be of a stalled page. Bring its app forward first.
            if let bundleID = window.owningApplication?.bundleIdentifier,
               let app = NSRunningApplication.runningApplications(withBundleIdentifier: bundleID).first {
                for _ in 0..<5 {
                    if NSWorkspace.shared.frontmostApplication?.bundleIdentifier == bundleID { break }
                    app.activate(options: [])
                    try await Task.sleep(nanoseconds: 400_000_000)
                }
                if NSWorkspace.shared.frontmostApplication?.bundleIdentifier != bundleID {
                    print("warning: \(NSWorkspace.shared.frontmostApplication?.localizedName ?? "another app") stays in front; the page is throttled and these numbers mean nothing.")
                }
            }
            filter = SCContentFilter(desktopIndependentWindow: window)
            // A patch in the middle of the window, at one pixel per point:
            // small enough to hash at 120 frames a second, and not scaled
            // down, which would hide the one-pixel steps of a slow scroll.
            let size = requestedRect ?? CGRect(x: window.frame.width / 2 - 200, y: window.frame.height / 2 - 150, width: 400, height: 300)
            config.sourceRect = size
            config.width = Int(size.width)
            config.height = Int(size.height)
            what = "window \"\(window.title ?? "untitled")\" (\(Int(window.frame.width))x\(Int(window.frame.height)))"
        } else {
            guard let display = content.displays.first(where: { $0.displayID == CGMainDisplayID() }) ?? content.displays.first else {
                print("no display to capture")
                exit(1)
            }
            // A band across the middle, in points, unless one was given.
            let rect = requestedRect ?? CGRect(x: Double(display.width) / 2 - 200, y: Double(display.height) / 2 - 40, width: 400, height: 80)
            config.sourceRect = rect
            config.width = Int(rect.width)
            config.height = Int(rect.height)
            filter = SCContentFilter(display: display, excludingWindows: [])
            what = "\(Int(rect.width))x\(Int(rect.height)) at (\(Int(rect.origin.x)),\(Int(rect.origin.y))) of display \(display.width)x\(display.height)"
        }

        let stream = SCStream(filter: filter, configuration: config, delegate: collector)
        try stream.addStreamOutput(collector, type: .screen, sampleHandlerQueue: DispatchQueue(label: "capture"))
        print("capturing \(what) for \(Int(seconds))s…")
        try await stream.startCapture()
        try await Task.sleep(nanoseconds: UInt64(seconds * 1e9))
        try await stream.stopCapture()
        done.signal()
    } catch {
        print("capture failed: \(error.localizedDescription)")
        print("If this is a permission error, grant Screen Recording to the app that runs this, then try again.")
        exit(1)
    }
}

done.wait()

let times = collector.changed
guard times.count > 1 else {
    print("nothing in that window changed (\(collector.captured) frames captured)")
    exit(1)
}
let gaps = zip(times.dropFirst(), times).map { ($0 - $1) * 1000 }.sorted()
func quantile(_ p: Double) -> Double { gaps[min(gaps.count - 1, Int(p * Double(gaps.count)))] }
// The headline is the median gap between new frames, not their average rate:
// whenever the captured patch happens to hold still (a stripe that has moved
// on, a list that has stopped), the average counts that as slowness, while
// the median still says how fast frames arrive when they do.
let median = quantile(0.5)
let rate = median > 0 ? 1000 / median : 0
let mean = Double(times.count - 1) / (times.last! - times.first!)
print(String(format: "reached the screen: %.1f new frames/s  (p50 %.2f ms, p10 %.2f, p90 %.2f; %d new of %d captured, %.1f/s on average)",
             rate, median, quantile(0.1), quantile(0.9), times.count, collector.captured, mean))
print(rate > 90 ? "→ full rate (120 Hz class)" : rate > 45 ? "→ about 60 Hz" : "→ slower than 60")
if let front = NSWorkspace.shared.frontmostApplication?.localizedName, let wanted = appMatch, !front.localizedCaseInsensitiveContains(wanted) {
    print("warning: \(front) was in front, not \(wanted): the page may have been throttled as a hidden window.")
}
