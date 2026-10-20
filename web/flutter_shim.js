// flutter_shim.js
//
// Lets Flutter web apps render at the display's full refresh rate (120 Hz on
// most recent phones and on ProMotion Macs), without changing the app.
//
// Chrome on Android and Safari both hold a page's rendering to 60 frames a
// second on a 120 Hz screen. Flutter does all of its drawing itself, inside
// requestAnimationFrame, so its scrolling and animations run at 60 while an
// ordinary page scrolls at 120. Two things get past that, in both browsers
// (site/lab measures each of them):
//
//  1. A canvas handed over with transferControlToOffscreen is shown at the
//     screen's rate, outside the page's limited rendering update. So Flutter's
//     canvas is handed over, and Flutter is given the context of the
//     OffscreenCanvas that now owns its pixels.
//  2. Each frame has to be drawn in a task of its own, never inside the page's
//     own requestAnimationFrame callback. A canvas drawn there is shown as part
//     of that limited rendering update, and a frame drawn in between is folded
//     into it and never appears: 61 frames a second instead of 120.
//
// What differs between the browsers is the clock that says when to draw:
//
//  - Chrome: a dedicated worker's requestAnimationFrame isn't limited, so it
//    ticks at the display's real rate, and in doing so says what that rate is.
//    The page draws on each of its ticks.
//  - Safari, and every browser on iOS (all of them WebKit): workers are
//    limited too, and nothing tells a page how fast its screen is. So the
//    page's own requestAnimationFrame is kept running only to say where the
//    refreshes are, and timers draw on a grid that divides each of its
//    intervals evenly.
//
// Load it before flutter_bootstrap.js:
//   <script src="flutter_shim.js"></script>
//
// window.flutterShimConfig, read when this script runs:
//   webkit: true       turn the Safari path on. It is off by default because
//                      Safari can't tell a page whether its screen is 60 Hz or
//                      120 Hz, and on a 60 Hz one the extra frames are wasted.
//   fps: 120           what the Safari path aims for, rounded to a whole
//                      multiple of Safari's own frame rate (default 120)
//   touch: false       leave touch moves as the browser delivers them
//   anyPlatform: true  run the Chrome path in any Chromium browser, for testing
//
// Status, for debugging and overlays, is at window.flutterShim:
//   { active, path, fps, frames, error }
(() => {
  'use strict';

  // ===========================================================================
  // The parts that are only arithmetic. They touch no browser API, so
  // test/shim.test.mjs can load this file in Node and check them directly.

  // Frame times have to be strictly increasing, because Flutter's animations
  // and scroll physics jump when time stalls or goes backwards. A tick that
  // arrives late is moved up to the latest point on its grid.
  const createFrameTimes = () => {
    let last = -Infinity;
    return (time, step, now) => {
      let t = time;
      const behind = now - t;
      if (behind > 1.5 * step) t += Math.floor(behind / step) * step;
      if (t <= last) t = last + step;
      return (last = t);
    };
  };

  // The interval between a clock's ticks: the median of the recent ones,
  // ignoring any too short or too long to be a refresh.
  const createPeriodMeter = () => {
    const intervals = [];
    const meter = { period: 1000 / 60, last: 0 };
    meter.add = (time) => {
      const interval = time - meter.last;
      meter.last = time;
      if (interval > 3 && interval < 40) {
        intervals.push(interval);
        if (intervals.length > 32) intervals.shift();
        meter.period = [...intervals].sort((a, b) => a - b)[intervals.length >> 1];
      }
      return meter.period;
    };
    return meter;
  };

  // How many frames to draw in each interval of the browser's own clock: the
  // whole number closest to the frame rate asked for, and never fewer than
  // one. It has to be whole, because the browser's ticks are the only marks of
  // where the screen's refreshes are, and a grid that didn't divide them
  // evenly would drift against the screen. It is also what keeps a clock that
  // already runs at the display's rate from being doubled.
  const framesPerInterval = (nativePeriod, targetFps) =>
    Math.max(1, Math.round((targetFps * nativePeriod) / 1000));

  // When the next tick should land: the first point on the grid that starts
  // at the last known refresh and steps by `cadence`, after `now` and after
  // the point last drawn for, passing over one too close to aim for. The
  // second condition matters because timers are coarse: one that fires a few
  // milliseconds early would otherwise aim straight back at the point it was
  // just drawn for, and draw it twice.
  const nextTickTime = (lastRefresh, cadence, now, lastDrawn = -Infinity, minimumLead = 2) => {
    const from = Math.max(now, lastDrawn + cadence / 2);
    let target = lastRefresh + Math.ceil((from - lastRefresh) / cadence) * cadence;
    if (target - now < minimumLead) target += cadence;
    return target;
  };

  // Where a finger was at `time`, from its samples ({ t, x, y }, oldest
  // first): interpolated between the two around it, or extrapolated a little
  // past the newest, unless the finger had stopped.
  const positionAt = (samples, time) => {
    const last = samples[samples.length - 1];
    if (time >= last.t) {
      if (time - last.t > 12 || samples.length < 2) return last;
      let i = samples.length - 2;
      while (i > 0 && last.t - samples[i].t < 4) i--;
      const from = samples[i], span = last.t - from.t, ahead = Math.min(time - last.t, 8);
      if (span <= 0) return last;
      return { x: last.x + ((last.x - from.x) / span) * ahead, y: last.y + ((last.y - from.y) / span) * ahead };
    }
    let j = samples.length - 1;
    while (j > 0 && samples[j - 1].t > time) j--;
    if (j === 0) return samples[0];
    const a = samples[j - 1], b = samples[j], k = (time - a.t) / (b.t - a.t || 1);
    return { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k };
  };

  if (typeof window === 'undefined') {
    if (typeof module === 'object') module.exports = { createFrameTimes, createPeriodMeter, framesPerInterval, nextTickTime, positionAt };
    return;
  }

  // ===========================================================================
  // Which path, if any.

  const config = window.flutterShimConfig || {};
  const ua = navigator.userAgent;
  const canHandOver = typeof OffscreenCanvas === 'function' &&
    'transferControlToOffscreen' in HTMLCanvasElement.prototype;
  // Every browser on iOS is WebKit, whatever its name says; GestureEvent is
  // WebKit's alone.
  const isWebKit = typeof window.GestureEvent === 'function' || navigator.vendor === 'Apple Computer, Inc.';
  const isAndroidChrome = /Android/.test(ua) && /Chrome\//.test(ua);

  const path = !canHandOver ? null
    : (isAndroidChrome || config.anyPlatform) && typeof Worker === 'function' ? 'worker'
    : isWebKit && config.webkit ? 'webkit'
    : null;
  if (!path) return;

  const status = (window.flutterShim = { active: false, path, fps: 0, frames: 0, error: null });
  const fail = (message) => {
    if (status.error) return;
    status.error = message;
    console.warn(`flutter_shim: ${message}`);
  };

  // ===========================================================================
  // Frame callbacks. window.requestAnimationFrame is replaced for the whole
  // page: until a Flutter canvas has been handed over the browser's own is
  // used, and from then on every callback runs on the shim's clock.

  const nativeRaf = window.requestAnimationFrame.bind(window);
  const nativeCaf = window.cancelAnimationFrame.bind(window);
  let callbacks = new Map(), nextId = 1;
  let clock = null; // { wake() }, made once the path is known
  let touch = null; // the resampler, unless config.touch is false

  window.requestAnimationFrame = (callback) => {
    if (!status.active) return nativeRaf(callback);
    const id = -nextId++; // negative ids are ours, positive ones the browser's
    callbacks.set(id, callback);
    clock.wake();
    return id;
  };
  window.cancelAnimationFrame = (id) => (id < 0 ? callbacks.delete(id) : nativeCaf(id));

  const frameTime = createFrameTimes();
  const busy = () => callbacks.size > 0 || !!touch?.active;

  // One frame: the touch moves it should see, then the callbacks waiting on
  // it. `cadence` is how far apart this clock's frames are.
  const runFrame = (vsync, cadence) => {
    touch?.beforeFrame(vsync);
    const run = callbacks;
    callbacks = new Map();
    if (!run.size) return;
    const time = frameTime(vsync, cadence, performance.now());
    for (const callback of run.values()) {
      try { callback(time); } catch (error) { reportError(error); }
    }
    status.frames++;
  };

  // ===========================================================================
  // Chrome's clock: a worker that does nothing but tick. It runs while the
  // page wants frames, and a few refreshes beyond, since restarting costs one.

  function clockWorker() {
    let wanted = false, running = false, idle = 0;
    const tick = (time) => {
      postMessage({ vsync: performance.timeOrigin + time, sent: performance.timeOrigin + performance.now() });
      idle = wanted ? 0 : idle + 1;
      if (idle < 8) requestAnimationFrame(tick);
      else running = false;
    };
    onmessage = ({ data }) => {
      wanted = data === 'wake';
      if (!wanted || running) return;
      if (typeof requestAnimationFrame !== 'function') {
        postMessage({ error: 'workers have no requestAnimationFrame here' });
        return;
      }
      running = true;
      requestAnimationFrame(tick);
    };
  }

  const createWorkerClock = () => {
    const worker = new Worker(URL.createObjectURL(new Blob([`(${clockWorker})()`], { type: 'text/javascript' })));
    const meter = createPeriodMeter();
    let awake = false, skippedLast = false;
    worker.onerror = (event) => fail(event.message || 'the clock worker failed');
    worker.onmessage = ({ data }) => {
      if (data.error) { fail(data.error); return; }
      const vsync = data.vsync - performance.timeOrigin;
      meter.add(vsync);
      status.fps = Math.round(1000 / meter.period);
      // A tick that waited behind other main-thread work has a newer one
      // right behind it: skip it so the backlog drains (never twice in a row).
      if (!skippedLast && performance.now() - (data.sent - performance.timeOrigin) > 1.5 * meter.period) {
        skippedLast = true;
        return;
      }
      skippedLast = false;
      runFrame(vsync, meter.period);
      if (!busy() && awake) {
        awake = false;
        worker.postMessage('sleep');
      }
    };
    return {
      wake() {
        if (awake) return;
        awake = true;
        worker.postMessage('wake');
      },
    };
  };

  // ===========================================================================
  // WebKit's clock: one empty requestAnimationFrame at a time, purely to
  // timestamp a refresh, and timers that draw on a grid dividing each of its
  // intervals evenly. A tick only has to land inside the refresh it belongs
  // to: every frame carries the time it was drawn for, so motion stays right
  // even when a tick is a little late.

  const createTimerClock = (targetFps) => {
    const meter = createPeriodMeter();
    let cadence = meter.period, phasePending = false, timer = 0, nextTick = 0, lastDrawn = -Infinity;

    const keepPhase = () => {
      if (phasePending) return;
      phasePending = true;
      nativeRaf((time) => {
        phasePending = false;
        meter.add(time);
        cadence = meter.period / framesPerInterval(meter.period, targetFps);
        status.fps = Math.round(1000 / cadence);
        if (busy()) keepPhase();
      });
    };

    const schedule = () => {
      if (timer) return;
      const now = performance.now();
      nextTick = nextTickTime(meter.last, cadence, now, lastDrawn);
      // WebKit rounds a timer up to a 4 ms grid and adds about one more, so
      // this asks for less than the wait: landing early inside the right
      // refresh is better than landing in the next one.
      timer = setTimeout(onTick, Math.max(0, nextTick - now - 5));
    };

    const onTick = () => {
      timer = 0;
      lastDrawn = nextTick;
      runFrame(nextTick, cadence);
      if (busy()) {
        keepPhase();
        schedule();
      }
    };

    return {
      wake() {
        keepPhase();
        schedule();
      },
    };
  };

  try {
    clock = path === 'worker' ? createWorkerClock() : createTimerClock(Number(config.fps) || 120);
  } catch (error) {
    // No worker (a Content-Security-Policy can forbid them): nothing to do.
    fail(String(error));
    return;
  }

  // ===========================================================================
  // Touch. Browsers deliver touch moves in step with their own frames, not
  // with this clock, so a frame would sometimes see two moves and sometimes
  // none, and a slow drag would move in uneven steps. Moves on Flutter's view
  // are held back instead, and each frame gives Flutter one move per finger,
  // at the position the finger had a short, fixed delay earlier, the way
  // Android resamples touch for native apps.

  const createTouchResampler = () => {
    const touches = new Map(); // pointerId -> touch state
    const sampleAges = []; // how old the newest sample was at each frame
    let delay = 12; // ms, fixed for the length of a touch
    let dispatching = false;

    const onFlutterView = (el) =>
      !!el?.closest?.('flutter-view, flt-glass-pane') && !el.closest('flt-platform-view');

    const updateDelay = () => {
      if (sampleAges.length < 8) return;
      const sorted = [...sampleAges].sort((a, b) => a - b);
      delay = Math.min(25, sorted[sorted.length >> 1]);
    };

    const dispatchMove = (touch, x, y, time) => {
      const e = touch.event;
      const move = new PointerEvent('pointermove', {
        bubbles: true, cancelable: true, composed: true,
        pointerId: e.pointerId, pointerType: e.pointerType, isPrimary: e.isPrimary,
        clientX: x, clientY: y, screenX: e.screenX + x - e.clientX, screenY: e.screenY + y - e.clientY,
        buttons: e.buttons, button: -1, pressure: e.pressure, width: e.width, height: e.height,
        tiltX: e.tiltX, tiltY: e.tiltY, twist: e.twist,
      });
      // Flutter reads the time and the position relative to its view, and
      // takes a move's movement from its coalesced events: an event made here
      // has none of its own, so it stands in as its only sample.
      Object.defineProperties(move, {
        timeStamp: { value: time },
        offsetX: { value: x + touch.offsetX },
        offsetY: { value: y + touch.offsetY },
        getCoalescedEvents: { value: () => [move] },
      });
      touch.x = x;
      touch.y = y;
      dispatching = true;
      try { touch.target.dispatchEvent(move); } finally { dispatching = false; }
    };

    addEventListener('pointerdown', (e) => {
      if (e.pointerType !== 'touch' || !status.active || !onFlutterView(e.target)) return;
      if (!touches.size) updateDelay();
      touches.set(e.pointerId, {
        samples: [{ t: e.timeStamp, x: e.clientX, y: e.clientY }],
        event: e, target: e.target, offsetX: e.offsetX - e.clientX, offsetY: e.offsetY - e.clientY,
        x: e.clientX, y: e.clientY, moved: false,
      });
      clock.wake();
    }, { capture: true, passive: true });

    addEventListener('pointermove', (e) => {
      const touch = !dispatching && touches.get(e.pointerId);
      if (!touch) return;
      e.stopImmediatePropagation();
      const samples = touch.samples;
      for (const c of e.getCoalescedEvents?.() ?? []) samples.push({ t: c.timeStamp, x: c.clientX, y: c.clientY });
      if (samples[samples.length - 1].t < e.timeStamp) samples.push({ t: e.timeStamp, x: e.clientX, y: e.clientY });
      Object.assign(touch, {
        event: e, target: e.target, offsetX: e.offsetX - e.clientX, offsetY: e.offsetY - e.clientY, moved: true,
      });
    }, { capture: true });

    const lift = (e) => {
      const touch = touches.get(e.pointerId);
      if (!touch) return;
      touches.delete(e.pointerId);
      // Catch up to where the finger lifted, so Flutter sees the whole drag
      // (and computes the fling from it) before the up event.
      const last = touch.samples[touch.samples.length - 1];
      if (last.x !== touch.x || last.y !== touch.y) dispatchMove(touch, last.x, last.y, last.t);
    };
    addEventListener('pointerup', lift, { capture: true, passive: true });
    addEventListener('pointercancel', lift, { capture: true, passive: true });

    return {
      get active() { return touches.size > 0; },
      beforeFrame(vsync) {
        const time = vsync - delay;
        for (const touch of touches.values()) {
          if (!touch.moved) continue;
          const samples = touch.samples;
          const age = vsync - samples[samples.length - 1].t;
          if (age < 100) {
            sampleAges.push(age);
            if (sampleAges.length > 120) sampleAges.shift();
          }
          const p = positionAt(samples, time);
          if (Math.abs(p.x - touch.x) > 0.01 || Math.abs(p.y - touch.y) > 0.01) dispatchMove(touch, p.x, p.y, time);
          // Keep about 100 ms of samples, plus one older one to interpolate from.
          const keep = samples.findIndex((s) => s.t > time - 100);
          if (keep > 1) samples.splice(0, keep - 1);
        }
      },
    };
  };

  if (config.touch !== false) touch = createTouchResampler();

  // ===========================================================================
  // Flutter's canvas. Flutter shows its frames either through a
  // 'bitmaprenderer' context (skwasm everywhere, CanvasKit in Chrome) or by
  // drawing straight into a WebGL canvas (CanvasKit in Safari). Either kind is
  // handed over, and Flutter gets the context of the OffscreenCanvas that now
  // owns its pixels, which it then draws into from the shim's clock.
  //
  // CanvasKit asks for WebGL with Emscripten's own options, which no ordinary
  // page passes, so every other canvas on the page is left alone.

  const isFlutterCanvas = (type, options) =>
    type === 'bitmaprenderer' ||
    ((type === 'webgl2' || type === 'webgl') && !!options &&
      'majorVersion' in options && 'enableExtensionsByDefault' in options);

  // A canvas can't be taken back once handed over, so first make sure this
  // browser gives an OffscreenCanvas this kind of context at all. Otherwise
  // Flutter keeps its canvas and runs exactly as it would without the shim.
  const offscreenSupport = new Map();
  const offscreenSupports = (type) => {
    if (!offscreenSupport.has(type)) {
      let context = null;
      try { context = new OffscreenCanvas(1, 1).getContext(type); } catch {}
      context?.getExtension?.('WEBGL_lose_context')?.loseContext(); // a probe shouldn't hold a GL context
      offscreenSupport.set(type, !!context);
    }
    return offscreenSupport.get(type);
  };

  const contexts = new WeakMap();
  let handedOver = 0;
  const getContext = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (type, options) {
    if (!isFlutterCanvas(type, options)) return getContext.call(this, type, options);
    const existing = contexts.get(this);
    if (existing) return existing;
    if (!offscreenSupports(type)) {
      fail(`this browser won't give a handed-over canvas a ${type} context, so Flutter runs at the browser's own rate`);
      return getContext.call(this, type, options);
    }
    let offscreen;
    try {
      offscreen = this.transferControlToOffscreen();
    } catch {
      return getContext.call(this, type, options); // e.g. the canvas already has a context
    }
    const context = offscreen.getContext(type, options);
    if (!context) {
      // The probe said yes and this said no: nothing left to fall back to.
      fail(`a handed-over canvas gave no ${type} context`);
      return null;
    }
    // The canvas in the page keeps its place in the layout; its size now
    // belongs to the canvas that owns its pixels.
    for (const prop of ['width', 'height']) {
      Object.defineProperty(this, prop, {
        configurable: true,
        get: () => offscreen[prop],
        set: (value) => { offscreen[prop] = value; },
      });
    }
    contexts.set(this, context);
    if (!handedOver++) {
      status.active = true;
      clock.wake();
    }
    return context;
  };

  // If Flutter's view comes up and none of its canvases has been handed over,
  // the shim is doing nothing, and that should be said rather than left for
  // someone to notice in a frame-rate counter. A Flutter version that asks
  // for its canvas differently would end up here.
  // Five seconds after the view appears, checked every half second, for at
  // most two minutes from load.
  let checks = 0, viewSeenAt = 0;
  const watch = () => {
    if (handedOver || status.error || ++checks > 240) return;
    if (!viewSeenAt && document.querySelector('flutter-view, flt-glass-pane')) viewSeenAt = checks;
    if (viewSeenAt && checks - viewSeenAt >= 10) {
      fail("Flutter's view is up but none of its canvases was handed over, so the shim isn't doing anything");
      return;
    }
    setTimeout(watch, 500);
  };
  setTimeout(watch, 500);
})();
