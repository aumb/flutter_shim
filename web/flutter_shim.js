// flutter_shim.js
//
// Lets Flutter web apps render at the display's full refresh rate (120 Hz on
// most recent phones and on ProMotion Macs), without changing the app.
//
// Two browsers hold Flutter to 60, for different reasons, so there are two
// paths. Both end in the same place: Flutter's frame clock ticks at the
// display's rate, and its canvas reaches the screen through a path the limit
// doesn't gate.
//
//  - Chrome on Android limits main-thread rendering, requestAnimationFrame
//    included, to 60 Hz on 120 Hz screens, lifting it only for frames caused
//    by touch movement. A dedicated worker's requestAnimationFrame is not
//    limited, so the worker is given Flutter's canvas and its clock drives
//    the page.
//
//  - Safari (and every browser on iOS, which all use WebKit) holds the page's
//    whole rendering update to 60, worker clocks included, so there is no
//    faster clock to borrow. But a canvas whose control has been handed to an
//    OffscreenCanvas is presented outside that limit: it reaches the screen at
//    the display's rate. So the clock is built instead, from the page's own
//    60 Hz callbacks (which are in step with the screen) plus one tick
//    halfway between two of them.
//
// Load it before flutter_bootstrap.js:
//   <script src="flutter_shim.js"></script>
// It does nothing in other browsers, and keeps the normal path until its own
// clock is running.
//
// window.flutterShimConfig, read when this script runs:
//   { webkit: true }      turn the Safari path on (off by default: see below)
//   { anyPlatform: true } run the Android path anywhere, for testing
//
// The Safari path is off by default because Safari gives a page no way to
// learn the display's refresh rate (tool/safari.py measures the lot), so a
// 60 Hz iPhone or Mac can't be told from a 120 Hz one. Turning it on there
// costs twice the frame work while something animates, for frames that never
// reach the screen. Turn it on if your users' devices have 120 Hz screens.
(() => {
  'use strict';

  const config = window.flutterShimConfig || {};
  const ua = navigator.userAgent;
  const canHandOver = typeof OffscreenCanvas === 'function' &&
    'transferControlToOffscreen' in HTMLCanvasElement.prototype;

  // Every browser on iOS is WebKit, whatever its name says; GestureEvent is
  // WebKit's alone.
  const isWebKit = typeof window.GestureEvent === 'function' || navigator.vendor === 'Apple Computer, Inc.';
  const isAndroidChrome = /Android/.test(ua) && /Chrome\//.test(ua);

  const path = !canHandOver ? null
    : isAndroidChrome || config.anyPlatform ? 'worker'
    : isWebKit && config.webkit ? 'webkit'
    : null;
  if (!path) return;

  // Read-only status, for debugging and overlays.
  const status = (window.flutterShim = { active: false, frames: 0, path, error: null });

  // ---------------------------------------------------------------------------
  // Frame times. A tick can arrive late (a worker's first ticks after waking,
  // or a busy main thread). A stale time is moved up to the latest refresh on
  // its grid, and time never repeats or goes backwards, since Flutter's
  // animations and scroll physics jump when it does.
  let period = 1000 / 60, previousVsync = 0, lastFrameTime = -Infinity;
  const intervals = [];

  const measurePeriod = (vsync) => {
    const interval = vsync - previousVsync;
    previousVsync = vsync;
    if (interval <= 3 || interval >= 40) return;
    intervals.push(interval);
    if (intervals.length > 32) intervals.shift();
    period = [...intervals].sort((a, b) => a - b)[intervals.length >> 1];
  };

  // `step` is how far apart this path's frames are: a refresh on the worker
  // path, half of one between the page's callbacks on the WebKit path.
  const frameTime = (vsync, step) => {
    let time = vsync;
    const behind = performance.now() - time;
    if (behind > 1.5 * period) time += Math.floor(behind / period) * period;
    if (time <= lastFrameTime) time = lastFrameTime + step;
    return (lastFrameTime = time);
  };

  // ---------------------------------------------------------------------------
  // Touch. Browsers deliver touch moves in step with their own frames, not
  // with the clock driving Flutter here, so a tick would sometimes see two
  // moves and sometimes none, and a slow drag would move in uneven steps.
  // Moves on Flutter's view are held back instead, and each tick gives
  // Flutter one move per finger, at the position the finger had a short,
  // fixed delay earlier (interpolated between samples), the way Android
  // resamples touch for native apps.
  const touches = new Map(); // pointerId -> touch state
  const sampleAges = []; // how old the newest sample was at each tick
  let delay = 12; // ms, fixed for the length of a touch
  let dispatching = false;

  const onFlutterView = (el) =>
    !!el?.closest?.('flutter-view, flt-glass-pane') && !el.closest('flt-platform-view');

  const updateDelay = () => {
    if (sampleAges.length < 8) return;
    const sorted = [...sampleAges].sort((a, b) => a - b);
    delay = Math.min(25, sorted[sorted.length >> 1]);
  };

  const positionAt = (samples, time) => {
    const last = samples[samples.length - 1];
    if (time >= last.t) {
      // Past the newest sample: extrapolate a little, unless the finger stopped.
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

  const dispatchMove = (touch, x, y, time) => {
    const e = touch.event;
    const move = new PointerEvent('pointermove', {
      bubbles: true, cancelable: true, composed: true,
      pointerId: e.pointerId, pointerType: e.pointerType, isPrimary: e.isPrimary,
      clientX: x, clientY: y, screenX: e.screenX + x - e.clientX, screenY: e.screenY + y - e.clientY,
      buttons: e.buttons, button: -1, pressure: e.pressure, width: e.width, height: e.height,
      tiltX: e.tiltX, tiltY: e.tiltY, twist: e.twist,
    });
    // Flutter reads the time and the position relative to its view, and takes
    // a move's movement from its coalesced events: an event made here has
    // none of its own, so it stands in as its only sample.
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

  const sendTouchMoves = (vsync) => {
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
  };

  addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'touch' || !status.active || !onFlutterView(e.target)) return;
    if (!touches.size) updateDelay();
    touches.set(e.pointerId, {
      samples: [{ t: e.timeStamp, x: e.clientX, y: e.clientY }],
      event: e, target: e.target, offsetX: e.offsetX - e.clientX, offsetY: e.offsetY - e.clientY,
      x: e.clientX, y: e.clientY, moved: false,
    });
    wake();
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

  // ---------------------------------------------------------------------------
  // Frame clock. Until this script's own clock is running, the browser's
  // requestAnimationFrame is used.
  const nativeRaf = window.requestAnimationFrame.bind(window);
  const nativeCaf = window.cancelAnimationFrame.bind(window);
  let callbacks = new Map(), nextId = 1, flutterCanvases = 0;
  let wake = () => {}; // set by whichever path is running

  window.requestAnimationFrame = (callback) => {
    if (!status.active) return nativeRaf(callback);
    const id = -nextId++; // negative ids are ours, positive ones the browser's
    callbacks.set(id, callback);
    wake();
    return id;
  };
  window.cancelAnimationFrame = (id) => (id < 0 ? callbacks.delete(id) : nativeCaf(id));

  // One tick: the moves this frame should see, then the frame itself.
  const tick = (vsync, step) => {
    sendTouchMoves(vsync); // before the callbacks, so this frame sees the moves
    const run = callbacks;
    callbacks = new Map();
    if (!run.size) return false;
    const time = frameTime(vsync, step);
    for (const callback of run.values()) {
      try { callback(time); } catch (error) { reportError(error); }
    }
    return true;
  };

  // ---------------------------------------------------------------------------
  // Canvases. Flutter shows each frame either by calling transferFromImageBitmap
  // on a 'bitmaprenderer' context (Chromium) or by drawing straight into a
  // WebGL canvas (CanvasKit in Safari). Either way the canvas is handed over
  // with transferControlToOffscreen, which is what takes it off the limited
  // path, and the size the page writes is passed on to the canvas that now
  // owns those pixels.
  const contexts = new WeakMap();

  // CanvasKit is an Emscripten build, and asks for its WebGL context with
  // Emscripten's own options. No ordinary page does, so this picks out
  // Flutter's canvas without touching anyone else's.
  const isFlutterGl = (type, options) =>
    (type === 'webgl2' || type === 'webgl') && !!options &&
    'majorVersion' in options && 'enableExtensionsByDefault' in options;

  const trackSize = (el, read, write) => {
    for (const prop of ['width', 'height']) {
      Object.defineProperty(el, prop, {
        configurable: true,
        get: () => read(prop),
        set: (value) => write(prop, value),
      });
    }
  };

  // ---------------------------------------------------------------------------
  if (path === 'worker') {
    // The worker owns the on-screen canvases, shows queued frames one per
    // refresh, and reports every refresh (vsync) to the page.
    function workerMain() {
      const canvases = new Map(); // id -> { canvas, context, queue }
      let running = false, wanted = true, idleTicks = 0;

      const tick = (time) => {
        let shown = false, waiting = false;
        for (const c of canvases.values()) {
          const frame = c.queue.shift();
          if (!frame) continue;
          c.context.transferFromImageBitmap(frame);
          shown = true;
          if (c.queue.length) waiting = true;
        }
        postMessage({ vsync: performance.timeOrigin + time, sent: performance.timeOrigin + performance.now() });
        // Keep ticking while the page wants frames or a frame is waiting, and a
        // few refreshes beyond, since restarting costs a refresh. An idle page
        // costs nothing.
        idleTicks = shown ? 0 : idleTicks + 1;
        if (wanted || waiting || idleTicks < 8) requestAnimationFrame(tick);
        else running = false;
      };
      const start = () => {
        if (!running) { running = true; requestAnimationFrame(tick); }
      };

      onmessage = ({ data }) => {
        const c = canvases.get(data.id);
        switch (data.type) {
          case 'canvas':
            if (typeof requestAnimationFrame !== 'function') {
              postMessage({ error: 'requestAnimationFrame is not available in workers' });
              return;
            }
            canvases.set(data.id, {
              canvas: data.canvas,
              context: data.canvas.getContext(data.present ? 'bitmaprenderer' : '2d'),
              queue: [],
            });
            start();
            break;
          case 'wake':
            wanted = true;
            start();
            break;
          case 'sleep':
            wanted = false;
            break;
          case 'frame':
            if (!c) { data.frame.close(); return; }
            // Oldest first, one per refresh: a frame that arrives just after a
            // refresh waits for the next one instead of replacing the frame
            // before it. At most two wait; beyond that, latency matters more.
            c.queue.push(data.frame);
            if (c.queue.length > 2) c.queue.shift().close();
            start();
            break;
          case 'resize':
            if (!c) return;
            for (const frame of c.queue.splice(0)) frame.close(); // drawn at the old size
            c.canvas[data.prop] = data.value;
            break;
        }
      };
    }

    let worker;
    try {
      worker = new Worker(URL.createObjectURL(new Blob([`(${workerMain})()`], { type: 'text/javascript' })));
    } catch (error) {
      status.error = String(error);
      return;
    }
    const send = (message, transfer) => worker.postMessage(message, transfer);

    let awake = true;
    wake = () => {
      if (!awake) { awake = true; send({ type: 'wake' }); }
    };

    let skippedLast = false;
    worker.onerror = (event) => { status.error = event.message || 'worker failed'; };
    worker.onmessage = ({ data }) => {
      if (data.error) { status.error = data.error; return; }
      if (!flutterCanvases) return;
      status.active = true;
      const vsync = data.vsync - performance.timeOrigin;
      measurePeriod(vsync);
      // A tick that waited behind other main-thread work has a newer one right
      // behind it: skip it so the backlog drains (never twice in a row).
      if (!skippedLast && performance.now() - (data.sent - performance.timeOrigin) > 1.5 * period) {
        skippedLast = true;
        return;
      }
      skippedLast = false;
      tick(vsync, period);
      if (!callbacks.size && !touches.size && awake) {
        awake = false;
        send({ type: 'sleep' });
      }
    };

    let nextCanvasId = 0;
    const handOver = (el, present) => {
      const canvas = el.transferControlToOffscreen();
      const id = ++nextCanvasId;
      send({ type: 'canvas', id, canvas, present }, [canvas]);
      return id;
    };

    // A 1 px canvas of our own keeps the worker's clock independent of
    // Flutter's canvases coming and going.
    const startClock = () => {
      const el = document.createElement('canvas');
      el.width = el.height = 1;
      el.setAttribute('aria-hidden', 'true');
      el.style.cssText = 'position:fixed;left:0;bottom:0;width:1px;height:1px;opacity:0.01;pointer-events:none;z-index:-1';
      (document.body || document.documentElement).appendChild(el);
      handOver(el, false);
    };

    const getContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (type, options) {
      if (type !== 'bitmaprenderer') return getContext.call(this, type, options);
      const existing = contexts.get(this);
      if (existing) return existing;
      let id;
      try {
        id = handOver(this, true);
      } catch {
        return getContext.call(this, type, options); // e.g. the canvas already has a context
      }
      if (!flutterCanvases++) startClock();
      // The canvas's size now belongs to the worker's copy.
      const size = { width: this.width, height: this.height };
      trackSize(this, (prop) => size[prop], (prop, value) => {
        if (value === size[prop]) return;
        size[prop] = value;
        send({ type: 'resize', id, prop, value });
      });
      const context = {
        canvas: this,
        transferFromImageBitmap(frame) {
          if (!frame) return;
          status.frames++;
          send({ type: 'frame', id, frame }, [frame]);
        },
      };
      contexts.set(this, context);
      return context;
    };
    return;
  }

  // ---------------------------------------------------------------------------
  // WebKit. Two things have to hold at once here, and the second one decides
  // the whole design: frames have to be produced at the display's rate, and
  // each one has to be drawn in a task of its own.
  //
  // A canvas drawn inside a requestAnimationFrame callback is shown as part
  // of that rendering update, and the rendering update is the thing held to
  // 60: a frame drawn in between is then folded into the next one and never
  // appears. Drawn from a timer instead, each frame is shown on its own
  // refresh. (site/lab compares the two: 61 frames a second against 112.)
  //
  // So the page's own clock is used only to learn where the refreshes are,
  // never to draw on, and the frames are drawn by a timer chain locked to
  // that phase. A tick only has to land inside the refresh it belongs to:
  // every frame carries the time it was drawn for, so motion stays right even
  // when a tick is a little late.
  let phasePending = false, tickTimer = 0, nextTick = 0;

  const needsFrames = () => callbacks.size > 0 || touches.size > 0;

  // One empty requestAnimationFrame at a time, purely to timestamp a refresh.
  const keepPhase = () => {
    if (phasePending) return;
    phasePending = true;
    nativeRaf((time) => {
      phasePending = false;
      measurePeriod(time);
      if (status.active && needsFrames()) keepPhase();
    });
  };

  const scheduleTick = () => {
    if (tickTimer) return;
    const half = period / 2;
    const now = performance.now();
    // The next point on the half-refresh grid that the last known refresh
    // sits on, far enough ahead to still be worth aiming for.
    let target = previousVsync + Math.ceil((now - previousVsync) / half) * half;
    if (target - now < 2) target += half;
    nextTick = target;
    // WebKit rounds a timer up to a 4 ms grid and adds about one more, so ask
    // for less than the wait: landing early inside the right refresh is
    // better than landing in the next one.
    tickTimer = setTimeout(onTick, Math.max(0, target - now - 5));
  };

  const onTick = () => {
    tickTimer = 0;
    if (!status.active) return;
    if (tick(nextTick, period / 2)) status.frames++;
    if (needsFrames()) {
      keepPhase();
      scheduleTick();
    }
  };

  wake = () => {
    if (!status.active) return;
    keepPhase();
    scheduleTick();
  };

  const getContext = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (type, options) {
    const flutterGl = isFlutterGl(type, options);
    if (type !== 'bitmaprenderer' && !flutterGl) return getContext.call(this, type, options);
    const existing = contexts.get(this);
    if (existing) return existing;
    let offscreen, context;
    try {
      offscreen = this.transferControlToOffscreen();
      context = offscreen.getContext(type, options);
      if (!context) throw new Error(`no ${type} context on a handed-over canvas`);
    } catch (error) {
      // Anything unexpected (a canvas that already has a context, a context
      // type this browser won't give an OffscreenCanvas) falls back to the
      // normal path, which is simply Flutter as it is today.
      if (!offscreen) return getContext.call(this, type, options);
      status.error = String(error);
      return null;
    }
    flutterCanvases++;
    status.active = true;
    // The pixels belong to the handed-over canvas now; the one in the page
    // keeps its place in the layout, and its size is passed on.
    trackSize(this, (prop) => offscreen[prop], (prop, value) => { offscreen[prop] = value; });
    contexts.set(this, context);
    wake();
    return context;
  };
})();
