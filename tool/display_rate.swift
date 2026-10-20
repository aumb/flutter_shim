// Prints what the Mac's display is actually doing, as the display server sees
// it: the mode's nominal rate, the highest the screen can do, and the rate the
// display link ticks at right now. On a ProMotion screen the last number is
// the one that matters, because the refresh rate follows the content: if a
// browser animates at 120 the link ticks at 120, and if everything on screen
// is at 60 it ticks at 60.
//
//   swift tool/display_rate.swift [seconds]
//
// Run it while the page being measured is in front and animating.

import AppKit
import QuartzCore

let seconds = Double(CommandLine.arguments.dropFirst().first ?? "") ?? 3

final class Counter: NSObject {
    var times: [CFTimeInterval] = []
    @objc func tick(_ link: CADisplayLink) {
        times.append(link.timestamp)
    }
}

guard let screen = NSScreen.main else {
    print("no main screen (is this running without a window server connection?)")
    exit(1)
}

let mode = CGDisplayCopyDisplayMode(CGMainDisplayID())
print("screen: \(screen.localizedName)")
print("mode:   \(mode.map { String(format: "%.0f x %.0f @ %.2f Hz", Double($0.width), Double($0.height), $0.refreshRate) } ?? "unknown")")
print("screen maximumFramesPerSecond: \(screen.maximumFramesPerSecond)")
print("minimum refresh interval: \(String(format: "%.3f ms", screen.minimumRefreshInterval * 1000)), maximum: \(String(format: "%.3f ms", screen.maximumRefreshInterval * 1000))")

let counter = Counter()
let link = screen.displayLink(target: counter, selector: #selector(Counter.tick(_:)))
// Ask for everything the screen can give, so the link itself is never the limit.
link.preferredFrameRateRange = CAFrameRateRange(minimum: 1, maximum: Float(screen.maximumFramesPerSecond), preferred: Float(screen.maximumFramesPerSecond))
link.add(to: .main, forMode: .default)

print("\nmeasuring for \(String(format: "%.0f", seconds))s…")
RunLoop.main.run(until: Date().addingTimeInterval(seconds))
link.invalidate()

let times = counter.times
guard times.count > 1 else {
    print("no display link ticks")
    exit(1)
}
let gaps = zip(times.dropFirst(), times).map { ($0 - $1) * 1000 }.sorted()
let rate = Double(times.count - 1) / (times.last! - times.first!)
func quantile(_ p: Double) -> Double { gaps[min(gaps.count - 1, Int(p * Double(gaps.count)))] }
print(String(format: "display link: %.1f ticks/s  (p50 %.2f ms, p10 %.2f, p90 %.2f, %d ticks)",
             rate, quantile(0.5), quantile(0.1), quantile(0.9), times.count))
