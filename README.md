# flutter_shim

**120 Hz Flutter web on Android Chrome, with one script tag.**

Chrome on Android holds a page's own rendering to 60 frames per second on 120 Hz screens. Flutter web does all of its rendering itself, so its scrolling and animations run at 60 while ordinary web pages scroll at 120. `web/flutter_shim.js` moves Flutter's frame clock and its on-screen canvas to a worker, which Chrome doesn't limit. Your users don't change any settings, and the app's code doesn't change.

Measured on a Pixel 10 Pro XL (Chrome 154, Flutter 3.47.2). Each app was the same build, with and without the shim:

| App (renderer) | After lifting the finger | Slow-drag step variation* |
|---|---|---|
| Plain list (skwasm, single-threaded) | 57 → **113–120 fps** | 16–26% → **1–5%** |
| Material 3 demo (skwasm, single-threaded) | 56 → **111 fps** | 16–22% → **1–2%** |
| Flutter Gallery, Fortnightly (CanvasKit) | 57 → **114 fps** | 24–30% → **1–5%** |
| Wonderous (skwasm, single-threaded) | 59 → **113–120 fps** | 36% → **15%** |
| Wonderous (skwasm, multi-threaded) | 59 → **117 fps** | |

With the shim, 97–100% of frames reached the screen one refresh (8.3 ms) after the previous one. \*How much the per-frame movement of a steady, slow drag varies; lower is smoother.

## Use it in your app

1. Copy `web/flutter_shim.js` into your app's `web/` folder.
2. In `web/index.html`, load it before Flutter:
   ```html
   <script src="flutter_shim.js"></script>
   <script src="flutter_bootstrap.js" async></script>
   ```
3. Build as usual: `flutter build web --wasm` (or without `--wasm` for CanvasKit).

It only switches on in Chrome on Android, and falls back to Flutter's normal path until its worker clock is running. Everywhere else it does nothing.

**Renderer, for now:** use single-threaded skwasm or CanvasKit on Flutter stable. Multi-threaded skwasm has a race that can crash with `memory access out of bounds` ([flutter/flutter#193439](https://github.com/flutter/flutter/issues/193439)), and running at 120 Hz makes it more likely. In a stress test of 5 loads × 60 flings, Flutter 3.47.2 crashed in 2 of 5 loads and Flutter master (3.49.0-1.0.pre, with [#190048](https://github.com/flutter/flutter/pull/190048) and [#191014](https://github.com/flutter/flutter/pull/191014)) in none. Multi-threaded skwasm is the better choice once those fixes reach stable. To keep skwasm single-threaded, either serve without cross-origin isolation headers, or set it in a custom `web/flutter_bootstrap.js`:

```js
{{flutter_js}}
{{flutter_build_config}}
_flutter.loader.load({ config: { forceSingleThreadedSkwasm: true } });
```

## How it works

Chrome on Android decides how often a page may start a frame (`kThrottleMainFrameTo60Hz`, on by default since Chrome 145, only on 120 Hz screens). It lifts the limit for frames triggered by touch movement, so dragging runs at 120, but a fling after you let go runs at 60. Normal web pages scroll on Chrome's compositor thread, which isn't limited; Flutter draws its scrolling itself on the main thread, which is.

A worker that owns a canvas (`transferControlToOffscreen`) gets its own frame clock straight from the compositor, and that clock isn't limited. The shim uses it in three ways:

1. **Display.** Flutter shows each frame by passing an `ImageBitmap` to a `bitmaprenderer` canvas. The shim hands that canvas to a worker and gives Flutter a stand-in context, which forwards each frame to the worker. The worker shows frames oldest first, one per refresh.
2. **Clock.** `window.requestAnimationFrame` callbacks run on the worker's ticks. Frame times are made strictly increasing and snapped to the refresh grid, because Flutter's animations and scroll physics jump if time stalls or goes backwards.
3. **Touch.** Chrome delivers touch moves in step with its own frames, not the worker's ticks, so some ticks would see two moves and some none, and slow drags would stutter. The shim holds back touch moves on Flutter's view, and on each tick gives Flutter one move per finger, interpolated to a fixed short delay before the tick, as Android does for native apps. When the finger lifts, Flutter gets the final position before the up event, so flings keep their speed.

Status is at `window.flutterShim` (`active`, `frames`, `error`). To try the shim in desktop Chrome (see "Testing without a phone"), set `window.flutterShimConfig = { anyPlatform: true }` before loading it.

### Trade-offs

- **It relies on undocumented Chrome behavior.** If Chrome starts limiting worker frame clocks too, the shim simply runs at 60, as Flutter does today. Chrome is also building an official opt-in for high frame rates, for fullscreen canvases, WebXR and pointer lock (`kHighFramerateRequestFromClient`, off by default in Chrome 154).
- **Battery.** While something animates, Flutter does twice the work per second. An idle page costs nothing: the worker clock stops a few refreshes after the last frame.
- **Scope.** It replaces `window.requestAnimationFrame` for the whole page, so any other script's animation also runs on the worker clock. Touch moves on Flutter's view reach Flutter as re-dispatched events (`isTrusted` is false). Platform views (`HtmlElementView`, iframes) are left alone.
- **Heavy frames still drop.** The shim gives Flutter every refresh, but a frame that takes longer than 8.3 ms still misses one. In the table above, most of Wonderous's remaining late frames come right after its own slow frames, such as large images or a new section appearing for the first time. With single-threaded skwasm, drawing happens on the main thread too.

### iPhone and iPad

No, as Safari works today. Every iOS browser uses Safari's engine (WebKit), and its 60 fps setting ("Prefer Page Rendering Updates near 60fps") is on by default. WebKit does give workers `requestAnimationFrame`, but it runs on a fixed 15 ms timer ([`WorkerAnimationController.cpp`](https://github.com/WebKit/WebKit/blob/main/Source/WebCore/workers/WorkerAnimationController.cpp)), at most about 66 per second and not in step with the screen, so there's no faster clock to borrow. The iOS 26.5 simulator measured about 60 for the page and about 50 for a worker.

The demo site's **clock probe** (`/probe/`) measures this on any device. Testers open it, wait 10 seconds, and tap **Copy results**. If a future Safari gives workers a faster clock than the page, the probe will show it.

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

On an example page, `?renderer=skwasm-st|skwasm|canvaskit` picks the renderer (the index page has a picker), `?hud=0` hides the badge, and `?anyplatform` runs the shim outside Android Chrome.

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
web/flutter_shim.js         the shim
examples/examples.json      the example apps: source, pinned commit, start screen
examples/list/              the plain list app
examples/gallery/index.html replacement page for the Gallery
site/                       index page, badge (hud.js), loader options (demo.js), clock probe
tool/setup.py               fetch, fix and build the examples
tool/serve.py               serve the demo, or export it as static files
tool/measure.mjs            measure a page on an Android phone over adb
tool/android.sh             open the demo on a phone over adb
Dockerfile, deploy/         container image for Coolify or any Docker host
```
