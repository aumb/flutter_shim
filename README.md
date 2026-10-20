# flutter_shim

**120 Hz Flutter web on Android Chrome and on Safari, with one script tag.**

**Live demo: [shim.mathiewabbas.dev](https://shim.mathiewabbas.dev)**. Open it in Chrome on an Android phone with a 120 Hz screen, or in Safari on a 120 Hz Apple device, pick an app, and tap the badge in the corner to switch between Before and After.

Both browsers hold Flutter web to 60 frames per second on a 120 Hz screen, for different reasons, and `web/flutter_shim.js` lifts both. Your users don't change any settings, and the app's code doesn't change.

- **Chrome on Android** holds a page's own rendering to 60 on 120 Hz screens. Flutter does all of its rendering itself, so its scrolling and animations run at 60 while ordinary web pages scroll at 120. A worker's frame clock isn't limited, so the shim runs Flutter's frames on a worker's ticks.
- **Safari**, and so every browser on iOS, holds the page's whole rendering update to 60, worker clocks included. There is no faster clock to borrow, so the shim builds one out of timers. This path is [off by default](#iphone-ipad-and-safari); one line turns it on.

In both, Flutter's canvas is handed to an `OffscreenCanvas`, which is shown at the display's rate rather than the page's, and every frame is drawn outside the page's own frame callbacks, which is what lets it reach the screen on a refresh of its own.

On Android, measured on a Pixel 10 Pro XL (Chrome 154, Flutter 3.47.2). Each app was the same build, with and without the shim:

| App (renderer) | After lifting the finger | Slow-drag step variation* |
|---|---|---|
| Plain list (skwasm, single-threaded) | 57 → **113–120 fps** | 16–26% → **1–5%** |
| Material 3 demo (skwasm, single-threaded) | 56 → **111 fps** | 16–22% → **1–2%** |
| Flutter Gallery, Fortnightly (CanvasKit) | 57 → **114 fps** | 24–30% → **1–5%** |
| Wonderous (skwasm, single-threaded) | 59 → **113–120 fps** | 36% → **15%** |
| Wonderous (skwasm, multi-threaded) | 59 → **117 fps** | |

With the shim, 97–100% of frames reached the screen one refresh (8.3 ms) after the previous one. \*How much the per-frame movement of a steady, slow drag varies; lower is smoother.

These were measured with the shim's first design, in which the worker also showed the frames. The current one, where the worker only keeps time and the page shows the frames itself, reaches 119.7 fps after a fling in desktop Chrome with Android's limit switched on (see [Testing without a phone](#testing-without-a-phone)), but hasn't been on a phone yet.

And on Safari 26.6 (macOS 26.6, M3 Max, 120 Hz ProMotion display, Flutter 3.47.7), with a scripted drag scrolling each app, and one row measured after letting go of a fling. These count the frames that actually reached the screen, captured from outside the browser (`tool/presented.swift`). The first figure comes from the median time between one new frame and the next, which says how fast frames arrive when they do; the second is the average over the run, which also counts the moments a frame was missed:

| App | Before | With the shim |
|---|---|---|
| Plain list | 60.0 fps · 58 on average | **120.0 fps · 110 on average** |
| Plain list, after letting go of a fling | 59.9 fps | **119.4 fps** |
| Material 3 demo | 60.1 fps · 58 on average | **118.6 fps · 106 on average** |
| Flutter Gallery, Fortnightly | 60.0 fps · 59 on average | **116.2 fps · 95 on average** |

Each figure is one run of four to six seconds. Averages vary more from run to run than medians do: the Gallery's ranged from 95 to 114. The fling has no average, because the scripted flings pause between them. Safari runs CanvasKit for all four, including the `--wasm` builds. Wonderous is missing because the scripted drag doesn't scroll the screen it opens on, not because it behaved differently. An iPhone or iPad should behave the same way, since every Apple device runs this same engine, but none of these numbers were measured on one: see [iPhone, iPad and Safari](#iphone-ipad-and-safari).

## Use it in your app

1. Copy `web/flutter_shim.js` into your app's `web/` folder.
2. In `web/index.html`, load it before Flutter:
   ```html
   <script src="flutter_shim.js"></script>
   <script src="flutter_bootstrap.js" async></script>
   ```
3. Build as usual: `flutter build web --wasm` (or without `--wasm` for CanvasKit).

That switches it on in Chrome on Android, where it falls back to Flutter's normal path until its worker clock is running. To switch on the Safari path as well, say so before loading it:

```html
<script>window.flutterShimConfig = { webkit: true };</script>
<script src="flutter_shim.js"></script>
<script src="flutter_bootstrap.js" async></script>
```

That line is asked for rather than assumed because Safari tells a page nothing about the screen it is on, so a 120 Hz iPhone can't be told from a 60 Hz one; [below](#iphone-ipad-and-safari) is what that costs on a 60 Hz device. Everywhere else the script does nothing.

The same object takes the other options:

| Option | |
|---|---|
| `webkit: true` | Turn the Safari path on. |
| `fps: 120` | What the Safari path aims for (the default). It is rounded to a whole multiple of Safari's own frame rate, because Safari's frame callbacks are the only marks of where the screen's refreshes are. That rounding is also what keeps the shim from doubling a Safari whose own clock already runs at 120, as it does with "Prefer Page Rendering Updates near 60fps" turned off. |
| `touch: false` | Leave touch moves as the browser delivers them, instead of resampling them onto the shim's clock. |
| `anyPlatform: true` | Run the Chrome path in any Chromium browser, for testing. |

**Renderer, for now:** use single-threaded skwasm or CanvasKit on Flutter stable. Multi-threaded skwasm has a race that can crash with `memory access out of bounds` ([flutter/flutter#193439](https://github.com/flutter/flutter/issues/193439)), and running at 120 Hz makes it more likely. In a stress test of 5 loads × 60 flings, Flutter 3.47.2 crashed in 2 of 5 loads and Flutter master (3.49.0-1.0.pre, with [#190048](https://github.com/flutter/flutter/pull/190048) and [#191014](https://github.com/flutter/flutter/pull/191014)) in none. Multi-threaded skwasm is the better choice once those fixes reach stable. To keep skwasm single-threaded, either serve without cross-origin isolation headers, or set it in a custom `web/flutter_bootstrap.js`:

```js
{{flutter_js}}
{{flutter_build_config}}
_flutter.loader.load({ config: { forceSingleThreadedSkwasm: true } });
```

## How it works

Two findings make the shim work, and both hold in Chrome and in Safari. They come from `site/lab`, measured from outside the browser with `tool/presented.swift`:

1. **A handed-over canvas isn't held to 60.** Drawing into a canvas as a page normally does reaches the screen 59–60 times a second, however often it is drawn. Drawing into the same canvas after `transferControlToOffscreen` reaches it 109–116 times a second in Safari, and 119.9 in Chrome with Android's limit switched on. The limit is on the page's rendering update, not on showing a canvas.
2. **A frame has to be drawn in a task of its own.** A canvas drawn *inside* the page's `requestAnimationFrame` callback is shown as part of that rendering update, which is the thing held to 60, and a frame drawn in between is folded into it and never appears. Drawn inside the callback, the same canvas measures 61 frames a second in Safari and 60.7 in Chrome; drawn from a separate task, 112 and 119.9.

So the shim hands Flutter's canvas over and gives Flutter the context of the `OffscreenCanvas` that now owns its pixels, and runs Flutter's frames on a clock of its own, never inside the page's frame callbacks. Flutter presents through a `bitmaprenderer` context (skwasm, and CanvasKit in Chrome) or draws straight into WebGL (CanvasKit in Safari). It asks for that WebGL context with Emscripten's own options (`majorVersion`, `enableExtensionsByDefault`), which no ordinary page passes, so nothing else on the page is touched. A canvas can't be taken back once it is handed over, so the shim first checks that this browser gives an `OffscreenCanvas` the kind of context Flutter wants; if not, Flutter keeps its canvas and runs as it would without the shim.

The two browsers differ only in the clock.

### The clock in Chrome

Chrome on Android decides how often a page may start a frame (`kThrottleMainFrameTo60Hz`, on by default since Chrome 145, only on 120 Hz screens). It lifts the limit for frames triggered by touch movement, so dragging runs at 120, but a fling after you let go runs at 60. Normal web pages scroll on Chrome's compositor thread, which isn't limited; Flutter draws its scrolling itself on the main thread, which is.

A dedicated worker's `requestAnimationFrame` isn't limited. The shim keeps one ticking while Flutter wants frames, and runs Flutter's frame on each tick. Those ticks are the display's real refreshes, so they also say what its rate is: on a 60 Hz phone the shim simply runs at 60, as Flutter would. A tick that waited behind other main-thread work is skipped, so a backlog drains instead of running frames back to back.

The first version of the shim also had the worker *show* the frames, posting each one there as an `ImageBitmap` and queueing them. The lab shows the page can show them itself just as well (`wclock` 120.7 against `wbitmap` 120.5), so that machinery is gone.

### The clock in Safari

WebKit holds the page's rendering update to 60 (`FullSpeedFramesPerSecond = 60` in `AnimationFrameRate.h`), and unlike Chrome it does the same to workers. Measured on a 120 Hz ProMotion Mac where the display really was running at 120 (`tool/display_rate.swift` reads 119.5 ticks a second), Safari gave the page 60.2 callbacks a second and a worker 58.0, while Chrome on the same machine gave 119.7. There is no faster clock in the browser to borrow.

So the shim keeps one empty `requestAnimationFrame` running, never to draw on, only to timestamp Safari's own frames, and runs Flutter's frames from timers on a grid that divides each of those intervals evenly: two per interval with the default `fps: 120`, one if Safari's own clock already runs at 120. WebKit rounds a timer up to a 4 ms grid and adds about one more, so each tick asks for less than its wait; it only has to land somewhere inside the refresh it belongs to, because every frame carries the time it was drawn for, so motion stays right even when a tick is late. A tick never aims at the point it was just drawn for: an early timer used to, and drew the same frame twice.

Whether that grid lines up with the display's refreshes, rather than only landing near them, hasn't been isolated. Safari's callbacks aren't snapped to the refresh grid (one that overruns moves the next by exactly the overrun), so the grid can sit a few milliseconds off. What reaches the screen is measured either way.

### Touch

Browsers deliver touch moves in step with their own frames, not with the shim's clock, so some frames would see two moves and some none, and slow drags would stutter. The shim holds back touch moves on Flutter's view, and on each frame gives Flutter one move per finger, interpolated to a fixed short delay before the frame, as Android does for native apps. When the finger lifts, Flutter gets the final position before the up event, so flings keep their speed. Flutter takes a move's movement from its coalesced events, and an event the page makes itself has none, so each resampled move reports itself as its own only sample. `touch: false` turns all of this off.

### Status and tests

Status is at `window.flutterShim`: `active`, `path` (`worker` or `webkit`), `fps` (the rate it is running Flutter at), `frames`, and `error`, which also says when the shim found nothing to do, such as a browser that won't give a handed-over canvas the context Flutter needs, or a Flutter whose canvas it didn't recognise. To try the shim in desktop Chrome (see "Testing without a phone"), set `window.flutterShimConfig = { anyPlatform: true }` before loading it.

The arithmetic that decides pacing (frame times, the timer grid, touch resampling) has tests of its own: run `node --test` in this folder.

### Trade-offs

- **It relies on undocumented browser behavior.** Both paths do. If Chrome starts limiting worker frame clocks too, or WebKit starts showing a handed-over canvas only with the rendering update, the shim simply runs at 60, as Flutter does today. Chrome is also building an official opt-in for high frame rates, for fullscreen canvases, WebXR and pointer lock (`kHighFramerateRequestFromClient`, off by default in Chrome 154).
- **Battery.** While something animates, Flutter does twice the work per second. An idle page costs nothing: the clock stops a few refreshes after the last frame. On Safari this is the whole reason the path is off by default, since there the work may buy nothing at all: see [iPhone, iPad and Safari](#iphone-ipad-and-safari).
- **Scope.** It replaces `window.requestAnimationFrame` for the whole page, so any other script's animation also runs on the shim's clock. Touch moves on Flutter's view reach Flutter as re-dispatched events (`isTrusted` is false). Platform views (`HtmlElementView`, iframes) are left alone.
- **Flutter's canvas is no longer the page's.** In both browsers the shim hands it to an `OffscreenCanvas`, which is what takes it off the limited path. The canvas stays where it was and keeps its place in the layout, and writes to its `width` and `height` are passed on — that is how Flutter resizes it from 1×1 to the window at startup, and the apps above all render at the right size. But anything that reads pixels back through the element itself, such as `toDataURL`, no longer works on it.
- **Heavy frames still drop.** The shim gives Flutter every refresh, but a frame that takes longer than 8.3 ms still misses one. In the table above, most of Wonderous's remaining late frames come right after its own slow frames, such as large images or a new section appearing for the first time. With single-threaded skwasm, drawing happens on the main thread too.

### iPhone, iPad and Safari

The Safari path is off by default, and the reason is worth stating plainly: **Safari gives a page no way we have found to learn how fast the screen is.** On a 120 Hz Mac and on a 60 Hz one, `requestAnimationFrame` runs at 60 either way, so a page cannot tell them apart, and the shim cannot switch itself on only where it helps. What was tried, all of it on a Mac whose display was confirmed to be running at 120:

- **Worker clocks** run at 58 a second, slower than the page's 60.
- **Timers** land on a 4 ms grid (a chain of `setTimeout(8)` hops every 12 ms, `setTimeout(12)` every 16), which is WebKit's own grid and says nothing about the display.
- **Flooding a handed-over canvas** with frames runs at 550–730 a second: nothing pushes back at the display's rate.
- **Missing a frame deadline on purpose** just moves the next callback by as long as the overrun (a 20 ms overrun delays it 20 ms, a 28 ms one 28 ms), so the refresh interval doesn't show through there either.

So turning it on is a decision about your users' devices, and on a 60 Hz one it costs real work for frames that never appear. Scrolling the plain list on this Mac, Safari's processes went from about 35% of one core to about 64%, nearly all of the increase in `com.apple.WebKit.GPU`, which is the process that does the drawing. An idle page still costs nothing: the clock stops when nothing is animating.

**What was and wasn't measured.** Everything above was measured in Safari 26.6 on a 120 Hz ProMotion Mac, with its Safari settings as they ship. No frame rate has been measured on an iPhone or an iPad. iOS runs this same engine, and Safari's "Prefer Page Rendering Updates near 60fps" setting (Settings → Apps → Safari → Advanced on iOS, Advanced on a Mac) is the knob on the same limit, so the path should behave the same there — but "should" is doing real work in that sentence.

**What the iOS Simulator says** (iPhone 17 Pro, iOS 26.5, Safari, serving the demo from the Mac over `localhost`). A simulator draws on the Mac's own display, so it can say nothing at all about frames per second, and no number anywhere in this README comes from one. What it can answer is whether the path is *correct* on iOS — whether it works, not whether it helps — and the first question there is the one that would break the apps outright rather than merely leave them at 60: iOS WebKit does give a WebGL context on a canvas handed over with `transferControlToOffscreen`, and it does show what is drawn into it. Specifically:

- `window.flutterShim` reports `active: true`, `path: "webkit"`, `error: null`. (On a device with no debugger attached, open a demo page with `?log=http://<your-mac>:8800/log` and the badge beacons that state back to `tool/serve.py`, which prints it.)
- The plain list and the Material 3 demo render at full size, right way up, not blank and not stretched — pixel for pixel what the same pages show with `?webkit=0`. Flutter picks CanvasKit here, as it does in Safari on a Mac, and the shim's WebGL hook leaves CanvasKit's own 1×1 probe canvases alone.
- Rotating the device re-lays out both apps correctly in landscape and back again, and so does a pinch-zoom, which changes the device pixel ratio. The writes the shim intercepts on the page's canvas do reach the handed-over one.
- Scrolling, flinging and tapping all survive the touch resampling. A slow drag moves the list the same distance it does with the path off; flings carry well past the finger and settle; taps land once each, not twice; and a drag broken off by Safari's own chrome or by a second finger leaves nothing stuck — the clock goes back to idle and the next gesture works.

**What still needs a real device.** The point of the whole path, first: whether a handed-over canvas is actually presented at the display's rate on an iPhone's screen. Only an iPhone can answer that. Then touch, properly: the resampler interpolates between the samples in `getCoalescedEvents()`, and what a real 120 Hz digitizer puts in that list is exactly the input it has never been given — a simulator's injected touches are not a stand-in for a finger. And then the things a simulator does not have: Low Power Mode, which caps iOS to 60 on its own, thermal throttling, and what a second full-size canvas costs a phone's memory.

The demo site's **clock probe** (`/probe/`) is the way to find out. Open it on the device, leave it for ten seconds, and tap **Copy results**: it reports the page and worker clocks, and moves two stripes, one above the other, one drawn the way Flutter draws today and one the way the shim does, so you can see with your own eyes whether the second is smoother.

## The demo

Four apps, each served twice from the same build: **Before** as it ships, **After** with the shim. The two pages differ by one script tag. A badge in the corner shows frames per second; tap it to switch versions on the same screen.

```sh
python3 tool/setup.py   # fetch the example apps, fix them for current Flutter, build (a few minutes)
python3 tool/serve.py   # http://localhost:8800
```

Requirements: Flutter (3.47 or later), Python 3, git. `setup.py` takes example ids to build only some, and `--flutter <path>` to build with another Flutter, such as master.

| Example | Source | Notes |
|---|---|---|
| `list` | `examples/list` | 2,000 rows of text. Frames are cheap, so it shows the shim on its own. |
| `material_3_demo` | [flutter/samples](https://github.com/flutter/samples/tree/main/material_3_demo) | Built on its own instead of as part of the samples workspace. |
| `gallery` | [flutter/gallery](https://github.com/flutter/gallery) (archived) | Updated for current Flutter (localizations, two renamed APIs, `google_fonts` 8.2.1). JavaScript build only, so CanvasKit. Its analytics are removed. |
| `wonderous` | [gskinnerTeam/flutter-wonderous-app](https://github.com/gskinnerTeam/flutter-wonderous-app) | Unchanged. |

Third-party apps are cloned at a pinned commit into `.cache/` (see `examples/examples.json`), not copied into this repo; their own licenses apply. The fixes are in `tool/setup.py`.

On an example page, `?renderer=skwasm-st|skwasm|canvaskit` picks the renderer (the index page has a picker), `?hud=0` hides the badge, `?anyplatform` runs the Android path outside Android Chrome, `?webkit=0` turns the Safari path off (it is on in the demo, since a tester on an Apple device is here to see it), `?stress=drag|fling|wheel` makes the app drive itself, and `?inspect=1` reports how this browser's Flutter draws.

### On an Android phone

With USB or wireless debugging on:

```sh
tool/android.sh              # forwards the port and opens the index in Chrome
```

For numbers instead of impressions, `tool/measure.mjs` records the visible tab over adb and reports frames per second with a finger down and after release, frames on time, and slow-drag evenness. Add `--swipes flings` or `--swipes reading` for scripted gestures, or scroll yourself:

```sh
node tool/measure.mjs --swipes flings
```

### Testing without a phone

Desktop Chrome has the same 60 Hz limit, switched off. On a 120 Hz display (such as a ProMotion MacBook), launch a separate Chrome with it switched on:

```sh
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --user-data-dir=/tmp/chrome-60hz \
  --enable-features=ThrottleMainFrameTo60Hz,UrgentMainFrameForInput
```

The page clock is now 60 and a worker's is 120, as on the phone. Use DevTools device emulation (Android user agent, touch) or add `?anyplatform` to the example URL. The Android emulator isn't a substitute: Chrome in it renders Flutter web blank.

### Testing the Safari path on a Mac

A Mac with a 120 Hz screen runs the same engine as an iPhone, with the same limit, so the Safari path can be developed and measured there. Set the display to ProMotion (not a fixed 60 Hz) and turn Low Power Mode off, or everything measures 60 whatever the browser does.

Safari can't be driven from the outside the way Chrome can, so the pages report their own numbers and the frames are counted from outside the browser:

```sh
swift tool/display_rate.swift            # what the screen is doing right now, from the display server
python3 tool/safari.py                   # opens the clock battery in Safari and prints what it measures
python3 tool/safari.py --url "/lab/?test=mgl&hz=120&keep=1"      # one drawing path (site/lab lists them)
python3 tool/safari.py --url "/list/after/?stress=drag"          # an example app, driving itself
swift tool/presented.swift 4 --app Safari                        # frames that reached the screen, while that runs
sh tool/cpu.sh 6                                                 # what it costs the browser's processes
```

`tool/presented.swift` is this repo's answer to filming the screen with a slow-motion camera: ScreenCaptureKit hands over the window's pixels at up to 240 frames a second, and it counts the ones that differ from the frame before, so 8.3 ms between new frames means 120 Hz reached the screen. It needs Screen Recording permission, and it brings the window to the front first, since a browser window another app covers is throttled and would measure as a stalled page.

`?stress=drag` on an example page makes it scroll itself with synthetic touch events at the rate a touchscreen would deliver them (`?stress=fling` for repeated flings, `?stress=wheel` for a pointer). `?webkit=0` turns the Safari path off again for a Before/After comparison, and `?inspect=1` reports how this browser's Flutter draws and presents.

## Time to first frame

`tool/ttff.mjs` measures how long a Flutter web app takes to start in Chrome. It times everything from the moment the browser starts navigating to the page until the app's first frame is on the screen, then until the screen settles into what the app actually shows. It works on any URL, local or deployed, with no change to the app, and it splits the wait into the steps of Flutter's startup, so a slow start can be pinned on a download, the engine or the app.

```sh
node tool/ttff.mjs "http://localhost:8800/list/before/?hud=0"
node tool/ttff.mjs https://example.com/ --runs 10 --net slow-4g --cpu 4   # a mid-range phone on a slow network
node tool/ttff.mjs <url> <another url>                                    # side by side, loads interleaved
```

The plain list from this repo's demo server, in headless Chrome 155 on an M3 Max (`?hud=0` hides the demo's badge, which would otherwise be the first thing painted):

```
                                              median ms   min–max
  HTML received                                    1   1–2
    flutter_bootstrap.js downloaded               11   11–15
  Flutter loader started                          18   15–30
    main.dart.mjs downloaded                      21   18–33
    main.dart.wasm downloaded                     24   22–36
    skwasm.js (www.gstatic.com) downloaded       202   149–454
    skwasm.wasm (www.gstatic.com) downloaded     472   443–1012
  Dart entrypoint running                        482   453–1022
    2 fonts downloaded                           655   579–1167
  engine initialized                             658   583–1170
  <flutter-view> in the page                     660   586–1172
  app's main() returned                          663   589–1174
  first frame built                              708   636–1215
  first frame presented                          756   689–1268
  first-contentful-paint                         767   700–1279
  first frame on screen                          781   713–1292      ← time to first frame
  screen settled                                 781   713–1292

  Time to first frame: 781 ms (median of 5; 713–1292), on screen.
  Screen settled:      781 ms (median of 5; 713–1292), the last change on screen.
  Loaded before the first frame: 12 files, 2.9 MB over the network. Largest: main.dart.wasm 1.5 MB, skwasm.wasm (www.gstatic.com) 1.2 MB, ...
```

| Row | What happened by then |
|---|---|
| HTML received | the page's HTML finished downloading |
| Flutter loader started | `flutter_bootstrap.js` called `_flutter.loader.load()` |
| *file* downloaded | a file startup waits on arrived: Flutter's scripts, the app's `main.dart.js` or `.wasm`, the renderer (CanvasKit or skwasm), the fonts |
| Dart entrypoint running | the app's compiled code is running and has handed the loader its engine initializer |
| engine initialized | `initializeEngine()` is done: the renderer is downloaded and compiled, and the default fonts are in |
| app's main() returned | `runApp()` is done, and the first frame is scheduled |
| first frame built | the framework built its first frame (Flutter's own `flutter-first-frame` event) |
| first frame presented | that frame's pixels were handed to the page's canvas |
| first frame on screen | **the time to first frame**: the first screenshot in Chrome's trace that shows it |
| screen settled | the last change on screen, once the app has drawn nothing and the network has been idle for a second |
| first-contentful-paint | Chrome's own, listed only when it is the Flutter frame, that is when nothing else on the page painted first |

**Why there are two answers.** A first frame is often not the app yet. The Gallery's Fortnightly opens on a white page with only its Back button, and Wonderous on an empty dark screen; their real content appears 0.7–0.9 s later, as their fonts and images arrive. `--out DIR` saves, for every load, what the screen showed at its first frame and once it settled, so you can see what each number stands for. An app that keeps animating never settles, and the tool says so instead of giving a time.

**Where the time went, on these examples.** By default Flutter fetches its renderer (`canvaskit.wasm` or `skwasm.wasm`) from `www.gstatic.com`, and a dart2wasm app can't start until it arrives. In the run above that one file is the longest wait, and it is also the least predictable. In another run, one load of the plain list took 5.3 s instead of about 0.75, nearly all of the difference spent waiting on `skwasm.wasm`. `flutter build web --no-web-resources-cdn` serves the renderer from your own server instead. Once the entrypoint is running, the engine fetches its default font, Roboto, from `fonts.gstatic.com` and waits for it. That fetch is most of the 150–200 ms between "Dart entrypoint running" and "engine initialized". Run several loads either way (5 by default); the min–max column shows how much a single one can mislead.

**Options.**

- `--warm` measures repeat visits. Without it, each load is a first visit, in a new browser profile with an empty cache and no service worker. With it, one unmeasured load fills the cache first. `tool/serve.py` sends `Cache-Control: no-store`, so on the demo server only the files from Google's servers are cached.
- `--net slow-4g`, `fast-4g`, `3g` or `down/up/latency` (kbit/s, kbit/s, ms) throttles the network. The three presets are DevTools' Slow 4G, Fast 4G and Slow 3G. `--cpu 4` slows the CPU down four times, and `--viewport 412x915@2.6` sets the page size and pixel ratio.
- `--headed` uses a visible window instead of headless Chrome, so frames go through the real display. Keep the window uncovered.
- `--settle S` is how long to wait for the screen to settle (10 s by default; 0 skips it).
- `--out DIR --trace` also saves each load's DevTools trace, which opens in the Performance panel with the milestones as `flutter_ttff:*` marks. Recording it slows the page a little, so time those loads separately.

**How it measures.** `web/flutter_ttff.js` is injected into the page before any of its own scripts run. It catches `_flutter.loader` as `flutter.js` creates it and wraps each hand-over that follows (`didCreateEngineInitializer`, `initializeEngine`, `runApp`). It also listens for `flutter-first-frame` and watches the two ways a Flutter frame reaches the page's canvas: an `ImageBitmap` passed to a `bitmaprenderer` context (CanvasKit and skwasm in Chrome), or WebGL drawing into the canvas (CanvasKit in Safari). Both are still seen when the canvas was handed to an `OffscreenCanvas` first, as the shim does. Meanwhile Chrome records screenshots in its trace, each with the time its frame was expected on the display. A mark the probe makes in both clocks lines the two up, so "on screen" is the first screenshot after Flutter presented its frame that differs from what was there before. Without that, a frame the compositor already had in flight could be mistaken for Flutter's. How it picks those screenshots has tests of its own (`node --test`).

**Other browsers.** The probe works on its own in any browser. Load it before Flutter, as with the shim, and read `window.flutterTtff`, or the table it logs to the console (`window.flutterTtffConfig = { beacon: url }` also sends each report there):

```html
<script src="flutter_ttff.js"></script>
<script src="flutter_bootstrap.js" async></script>
```

It was checked in Safari 26.6 on the list, with and without the shim, and on the Gallery with it. There CanvasKit draws straight into a WebGL canvas, and "presented" came 1–5 ms before Safari's own first-contentful-paint. Without Chrome's trace there is no "on screen", and "settled" is only what the page can see: the last frame before a second in which no frame was drawn and no file finished loading.

## Hosting

`tool/serve.py --export site-export` writes the whole demo as static files. All links are relative, so it works at a domain root or under any path.

```
site-export/
  index.html, probe/, flutter_shim.js, demo.js, hud.js, apps.json
  <id>/app/       the build, shared by:
  <id>/before/    index.html only
  <id>/after/     index.html only, plus the shim
```

**Coolify (or any Docker host):** the `Dockerfile` builds the examples with Flutter 3.47.2, exports the site, and serves it with nginx (`deploy/nginx.conf`), which sends cross-origin isolation headers so multi-threaded skwasm works too. In Coolify, add the GitHub repo as a new resource, choose the **Dockerfile** build pack, set the exposed port to **80**, and give it a domain; Coolify's proxy provides HTTPS. Each push to the deployed branch rebuilds the site. The Flutter builds need about 4 GB of memory and take several minutes. To build or run it yourself:

```sh
docker build -t flutter-shim-demo .
docker run --rm -p 8080:80 flutter-shim-demo   # http://localhost:8080
```

**Any other web server:** export locally and copy the folder, for example `rsync -a --delete site-export/ you@server:/var/www/flutter-shim/`. For multi-threaded skwasm, send the same headers as `deploy/nginx.conf` (`Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: credentialless`), serve `.wasm` as `application/wasm` and `.mjs` as `text/javascript`, and use HTTPS.

**GitHub Pages:** `.github/workflows/pages.yml` builds and publishes the site when started from the Actions tab (set Settings → Pages → Source to "GitHub Actions" first). Pages from a private repo needs a paid GitHub plan, and Pages can't send cross-origin isolation headers, so skwasm runs single-threaded there.

## Layout

```
web/flutter_shim.js         the shim: one presenter, a worker clock for Chrome, a timer clock for Safari
web/flutter_ttff.js         times a Flutter app's startup from inside the page, in any browser
test/shim.test.mjs          tests for its timing arithmetic (node --test)
test/ttff.test.mjs          tests for how tool/ttff.mjs reads the screen
examples/examples.json      the example apps: source, pinned commit, start screen
examples/list/              the plain list app
examples/gallery/index.html replacement page for the Gallery
site/                       index page, badge (hud.js), loader options (demo.js)
site/probe/                 clock probe for any phone or browser, with the two stripes
site/clocks/                every clock a page can run an animation on, measured one at a time
site/lab/                   which drawing paths reach the screen at the display's rate
site/stress.js              scripted input, so a page can be measured without a hand on it
tool/setup.py               fetch, fix and build the examples
tool/serve.py               serve the demo, or export it as static files
tool/measure.mjs            measure a page on an Android phone over adb
tool/ttff.mjs               time to first frame in Chrome: each step of startup, and when the screen settled
tool/android.sh             open the demo on a phone over adb
tool/safari.py              run a probe page in Safari and print what it measured
tool/presented.swift        count the frames that reached the screen, from outside the browser
tool/display_rate.swift     what the Mac's display is doing, from the display server
tool/cpu.sh                 processor time a browser's page actually used
Dockerfile, deploy/         container image for Coolify or any Docker host
```

## License

MIT, see [LICENSE](LICENSE). The example apps fetched by `tool/setup.py` keep their own licenses.
