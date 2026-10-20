// flutter_ttff.js
//
// Measures a Flutter web app's time to first frame: how long from the moment
// the browser started navigating to the page until Flutter's first frame was
// handed to the page to show, and every step in between, so a slow start can
// be pinned on the download, the engine or the app. Then, since a first frame
// is often an empty screen waiting on fonts or images, how long until the
// app stopped drawing.
//
// tool/ttff.mjs injects this into any page in Chrome, with no change to the
// app, and adds what only the browser can see from outside: when those
// frames actually reached the screen. To use it on its own, in any browser,
// load it before Flutter:
//   <script src="flutter_ttff.js"></script>
//   <script src="flutter_bootstrap.js" async></script>
// and read window.flutterTtff, or the tables it logs to the console.
//
// Times are milliseconds since navigation start (performance.now()), and each
// milestone is also a performance.mark('flutter_ttff:<name>'), so it shows up
// in a DevTools performance recording:
//   loader        flutter_bootstrap.js called _flutter.loader.load()
//   entrypoint    main.dart.js / main.dart.wasm is running and handed over
//                 its engine initializer
//   engine        the engine is initialized (the renderer is downloaded and
//                 compiled, and the default fonts are in, by now)
//   app           the app's main() has returned
//   view          Flutter's <flutter-view> is in the page
//   first-frame   the framework built its first frame and handed it to the
//                 engine (Flutter's own 'flutter-first-frame' event)
//   presented     that frame's pixels were handed to the page's canvas: the
//                 page shows it at its next rendering update. Missing if the
//                 app draws some way this can't see (in a worker, say)
//   settled       the last frame before the app went still: no new frame,
//                 and no file finished loading, for `settle` ms
//
// window.flutterTtff:
//   marks     the milestones so far
//   frames    { count, last }: frames presented so far, and when the last was
//   done      resolves with report() once the first frame is presented (or
//             built, if its presenting can't be seen, after 2 s)
//   settled   resolves with report() once the app has gone still
//   report()  everything measured so far, with the page's resource timings
//   stop()    stop watching frames (it stops by itself after `timeout`)
//
// window.flutterTtffConfig, read when this script runs:
//   { timeout: 60000 }  stop waiting for a first frame, and watching frames
//                       after it, after this long (ms)
//   { settle: 1000 }    how long the app has to stay still to count as settled
//   { console: false }  don't log the tables to the console
//   { beacon: url }     also send each report there (navigator.sendBeacon),
//                       for a browser with no debugger attached
(() => {
  'use strict';

  if (window.flutterTtff) return;
  const config = window.flutterTtffConfig || {};
  const timeout = config.timeout ?? 60000;
  const settleAfter = config.settle ?? 1000;
  const PREFIX = 'flutter_ttff:';

  const marks = {};
  const errors = [];
  let presentedVia = null;

  const mark = (name, time = performance.now()) => {
    if (name in marks) return;
    marks[name] = time;
    try {
      performance.mark(PREFIX + name, { startTime: time });
    } catch {}
  };

  addEventListener('error', (e) => errors.length < 5 && errors.push(String(e.message || e.error)));
  addEventListener('unhandledrejection', (e) => errors.length < 5 && errors.push(String(e.reason?.message || e.reason)));

  // ---- The loader ----------------------------------------------------------
  //
  // flutter.js creates window._flutter.loader; the app's entrypoint later
  // calls loader.didCreateEngineInitializer(initializer), and the loader's
  // default handler runs initializer.initializeEngine() then runApp(). Each
  // is caught as it is set, and wrapped, so nothing about the page's own
  // bootstrap has to change.

  const wrapRunner = (runner) => {
    mark('engine');
    if (typeof runner?.runApp !== 'function') return runner;
    return new Proxy(runner, {
      get(target, key) {
        const value = Reflect.get(target, key);
        if (key === 'runApp') {
          return async (...args) => {
            const result = await value.apply(target, args);
            mark('app');
            return result;
          };
        }
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  };

  const wrapInitializer = (initializer) => {
    if (!initializer || typeof initializer !== 'object') return initializer;
    return new Proxy(initializer, {
      get(target, key) {
        const value = Reflect.get(target, key);
        if (key === 'initializeEngine' && typeof value === 'function') {
          return async (...args) => wrapRunner(await value.apply(target, args));
        }
        if (key === 'autoStart' && typeof value === 'function') {
          return async (...args) => {
            const result = await value.apply(target, args);
            mark('app');
            return result;
          };
        }
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  };

  // The handler is only watched once load() has been called. The engine
  // takes the mere presence of didCreateEngineInitializer as "the page wants
  // to start me itself", so defining it any earlier could stall a page that
  // runs main.dart.js without the loader.
  const watchEntrypoint = (loader) => {
    if (Object.getOwnPropertyDescriptor(loader, 'didCreateEngineInitializer')?.get) return;
    let handler = loader.didCreateEngineInitializer;
    try {
      Object.defineProperty(loader, 'didCreateEngineInitializer', {
        configurable: true,
        enumerable: true,
        get: () => handler && ((initializer) => {
          mark('entrypoint');
          return handler(wrapInitializer(initializer));
        }),
        set: (fn) => {
          handler = fn;
        },
      });
    } catch {}
  };

  const hookLoader = (loader) => {
    if (!loader || typeof loader !== 'object' || loader.__flutterTtff) return;
    loader.__flutterTtff = true;
    for (const name of ['load', 'loadEntrypoint']) {
      const original = loader[name];
      if (typeof original !== 'function') continue;
      loader[name] = function (...args) {
        mark('loader');
        watchEntrypoint(this);
        return original.apply(this, args);
      };
    }
  };

  const hookFlutter = (flutter) => {
    if (!flutter || typeof flutter !== 'object') return;
    let loader = flutter.loader;
    try {
      Object.defineProperty(flutter, 'loader', {
        configurable: true,
        enumerable: true,
        get: () => loader,
        set: (value) => {
          loader = value;
          hookLoader(value);
        },
      });
    } catch {}
    hookLoader(loader);
  };

  let flutterGlobal = window._flutter;
  try {
    Object.defineProperty(window, '_flutter', {
      configurable: true,
      enumerable: true,
      get: () => flutterGlobal,
      set: (value) => {
        flutterGlobal = value;
        hookFlutter(value);
      },
    });
  } catch {}
  hookFlutter(flutterGlobal);

  // ---- The page ------------------------------------------------------------

  // A mutation observer runs after the task that added the view, so this is
  // also asked directly by anything that needs to know sooner.
  const viewReady = () => {
    if ('view' in marks) return true;
    if (!document.querySelector('flutter-view, flt-glass-pane')) return false;
    mark('view');
    viewObserver.disconnect();
    return true;
  };
  const viewObserver = new MutationObserver(viewReady);
  viewObserver.observe(document, { childList: true, subtree: true });

  addEventListener('flutter-first-frame', () => {
    mark('first-frame');
    // A frame presented some way this script can't see still ends the wait.
    setTimeout(afterFirstFrame, 2000);
  }, { once: true });

  // The browser's own paint timing. A canvas Flutter has drawn into counts as
  // contentful, so on a page with nothing else to show, first-contentful-paint
  // is the first Flutter frame as the browser itself saw it painted.
  const paints = {};
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) paints[entry.name] = entry.startTime;
    }).observe({ type: 'paint', buffered: true });
  } catch {}

  // ---- Frames --------------------------------------------------------------
  //
  // Where a frame's pixels are handed to the page depends on the renderer and
  // the browser, so each way is watched:
  //  - an ImageBitmap passed to a bitmaprenderer canvas (CanvasKit and skwasm
  //    in Chromium and Firefox),
  //  - WebGL drawing straight into a canvas in the page (CanvasKit in Safari):
  //    a frame's draw calls are made in one go, and it is shown once they
  //    are done.
  // flutter_shim.js also counts the frames it runs. That says when a frame
  // starts, not when it is shown, so it is only taken as a sign the app is
  // still drawing.
  // Only frames drawn once Flutter's view is in the page count: the renderers
  // draw into small canvases of their own while they start up.

  const frames = { count: 0, last: null };
  let watching = true;
  const present = (via) => {
    if (!watching || !viewReady()) return;
    frames.count++;
    frames.last = performance.now();
    if ('presented' in marks) return;
    presentedVia = via;
    mark('presented');
    afterFirstFrame();
  };

  const restores = [];
  const hook = (proto, name, after) => {
    const original = proto?.[name];
    if (typeof original !== 'function') return;
    const wrapper = function (...args) {
      const result = original.apply(this, args);
      try {
        after.call(this, args, result);
      } catch {}
      return result;
    };
    proto[name] = wrapper;
    restores.push(() => {
      if (proto[name] === wrapper) proto[name] = original;
    });
  };
  const stop = () => {
    watching = false;
    for (const restore of restores.splice(0)) restore();
  };

  // A page canvas can hand its pixels to an OffscreenCanvas
  // (transferControlToOffscreen), as flutter_shim.js does with Flutter's:
  // drawing into that one is drawing into the page.
  const placeholders = new WeakMap();
  hook(HTMLCanvasElement.prototype, 'transferControlToOffscreen', function (args, offscreen) {
    if (offscreen) placeholders.set(offscreen, this);
  });
  const onPage = (canvas) => {
    const element = canvas instanceof HTMLCanvasElement ? canvas : placeholders.get(canvas);
    return !!element?.isConnected && canvas.width * canvas.height > 1;
  };

  hook(window.ImageBitmapRenderingContext?.prototype, 'transferFromImageBitmap', function ([bitmap]) {
    if (bitmap && onPage(this.canvas)) present('bitmaprenderer');
  });

  const pageGl = new WeakSet();
  const watchGl = function ([type], context) {
    if (context && /webgl/.test(type)) pageGl.add(context);
  };
  hook(HTMLCanvasElement.prototype, 'getContext', watchGl);
  hook(window.OffscreenCanvas?.prototype, 'getContext', function (args, context) {
    if (placeholders.has(this)) watchGl(args, context);
  });
  // A frame is many draw calls made in one go: count it once, as they end.
  let drawing = false;
  const drawn = () => {
    drawing = false;
    present('webgl');
  };
  for (const proto of [window.WebGL2RenderingContext?.prototype, window.WebGLRenderingContext?.prototype]) {
    for (const name of ['drawElements', 'drawArrays', 'drawElementsInstanced', 'drawArraysInstanced', 'drawRangeElements']) {
      hook(proto, name, function () {
        if (drawing || !pageGl.has(this) || !onPage(this.canvas)) return;
        drawing = true;
        queueMicrotask(drawn);
      });
    }
  }

  const watchShim = (status) => {
    if (!status || typeof status !== 'object') return;
    let count = status.frames;
    try {
      Object.defineProperty(status, 'frames', {
        configurable: true,
        enumerable: true,
        get: () => count,
        set: (value) => {
          count = value;
          if (value > 0 && watching && viewReady()) frames.last = performance.now();
        },
      });
    } catch {}
  };
  let shimStatus = window.flutterShim;
  try {
    Object.defineProperty(window, 'flutterShim', {
      configurable: true,
      enumerable: true,
      get: () => shimStatus,
      set: (value) => {
        shimStatus = value;
        watchShim(value);
      },
    });
  } catch {}
  watchShim(shimStatus);

  // ---- The report ----------------------------------------------------------

  const shortName = (url) => {
    try {
      const { pathname, hostname } = new URL(url);
      const file = pathname.split('/').filter(Boolean).pop() || '/';
      return hostname === location.hostname ? file : `${file} (${hostname})`;
    } catch {
      return url;
    }
  };

  let gpuName;
  const gpu = () => {
    if (gpuName !== undefined) return gpuName;
    gpuName = null;
    try {
      const gl = document.createElement('canvas').getContext('webgl2') || document.createElement('canvas').getContext('webgl');
      if (gl) {
        const info = gl.getExtension('WEBGL_debug_renderer_info');
        gpuName = gl.getParameter(info ? info.UNMASKED_RENDERER_WEBGL : gl.RENDERER);
        gl.getExtension('WEBGL_lose_context')?.loseContext();
      }
    } catch {}
    return gpuName;
  };

  const report = () => {
    const nav = performance.getEntriesByType('navigation')[0];
    const resources = performance.getEntriesByType('resource').map((r) => ({
      name: shortName(r.name),
      url: r.name,
      type: r.initiatorType,
      start: r.startTime,
      end: r.responseEnd,
      // 0 for a cached response, and for another origin's that sends no
      // Timing-Allow-Origin header.
      transferSize: r.transferSize,
      bodySize: r.decodedBodySize,
    }));
    const fetched = (pattern) => resources.some((r) => pattern.test(r.name));
    const skwasm = window._flutter_skwasmInstance;
    let sync = null;
    try {
      // Lines this page's clock up with a DevTools trace, which records the
      // same mark in its own.
      sync = performance.mark(PREFIX + 'sync').startTime;
    } catch {}
    return {
      url: location.href,
      userAgent: navigator.userAgent,
      timeOrigin: performance.timeOrigin,
      marks: {
        ...(nav && { html: nav.responseEnd, domContentLoaded: nav.domContentLoadedEventEnd }),
        ...marks,
      },
      paints: { ...paints },
      frames: { ...frames },
      presentedVia,
      renderer: skwasm ? 'skwasm' : window.flutterCanvasKit ? 'canvaskit' : null,
      compileTarget: fetched(/^main\.dart\.wasm/) ? 'dart2wasm' : fetched(/^main\.dart\.js/) ? 'dart2js' : null,
      multiThreaded: skwasm ? typeof SharedArrayBuffer === 'function' && skwasm.wasmMemory?.buffer instanceof SharedArrayBuffer : null,
      gpu: gpu(),
      viewport: { width: innerWidth, height: innerHeight, devicePixelRatio },
      resources,
      errors: [...errors],
      timedOut: !('presented' in marks || 'first-frame' in marks),
      sync,
    };
  };

  const send = (result) => {
    if (!config.beacon) return;
    try {
      navigator.sendBeacon(config.beacon, JSON.stringify(result));
    } catch {}
  };
  const table = (result) => {
    if (config.console === false) return;
    const rows = Object.entries({ ...result.marks, 'first-contentful-paint': result.paints['first-contentful-paint'] })
      .filter(([, ms]) => ms != null)
      .sort((a, b) => a[1] - b[1])
      .map(([milestone, ms]) => ({ milestone, ms: Math.round(ms) }));
    const label = result.timedOut
      ? `no first frame within ${Math.round(timeout / 1000)} s`
      : 'settled' in result.marks
        ? `settled at ${Math.round(result.marks.settled)} ms after ${result.frames.count} frames`
        : 'presented' in result.marks
          ? `first frame presented at ${Math.round(result.marks.presented)} ms`
          : `first frame built at ${Math.round(result.marks['first-frame'])} ms; how it was presented couldn't be seen`;
    console.log(`[flutter_ttff] ${label} (${[result.renderer, result.compileTarget].filter(Boolean).join(', ') || 'renderer unknown'})`);
    console.table(rows);
  };

  let resolveDone, resolveSettled;
  const done = new Promise((resolve) => (resolveDone = resolve));
  const settled = new Promise((resolve) => (resolveSettled = resolve));
  const finish = (resolve) => {
    const result = report();
    send(result);
    table(result);
    resolve(result);
    return result;
  };

  // No first frame at all: both promises resolve with what there is.
  const giveUp = setTimeout(() => {
    stop();
    const result = finish(resolveDone);
    resolveSettled(result);
  }, timeout);

  let started = false;
  function afterFirstFrame() {
    if (started) return;
    started = true;
    clearTimeout(giveUp);
    setTimeout(stop, timeout);

    // A frame is presented a little before its paint is reported, and the
    // framework's event can come either side of it; give both a moment.
    const presented = performance.now();
    const waitForPaint = () => {
      if (('first-frame' in marks && 'first-contentful-paint' in paints) || performance.now() - presented > 1000) finish(resolveDone);
      else setTimeout(waitForPaint, 20);
    };
    setTimeout(waitForPaint, 0);

    // Settled: no frame, and no file finished loading, for `settleAfter` ms.
    // The page can't see a download that is still going, only one that has
    // ended, so tool/ttff.mjs also waits for the network to go quiet.
    const lastLoad = () => {
      const entries = performance.getEntriesByType('resource');
      return entries.length ? entries[entries.length - 1].responseEnd : 0;
    };
    const waitForStill = () => {
      const now = performance.now();
      const lastFrame = frames.last ?? marks['first-frame'];
      if (!watching) return finish(resolveSettled);
      if (now - Math.max(lastFrame, lastLoad()) >= settleAfter) {
        mark('settled', lastFrame);
        return finish(resolveSettled);
      }
      setTimeout(waitForStill, 100);
    };
    setTimeout(waitForStill, 100);
  }

  window.flutterTtff = { marks, frames, done, settled, report, stop };
})();
