// flutter_shim.js
//
// Lets Flutter web apps render at the display's full refresh rate (120 Hz on
// most recent phones) in Chrome on Android, without changing the app.
//
// Why: Chrome on Android limits main-thread rendering, requestAnimationFrame
// included, to 60 Hz on 120 Hz screens. It lifts the limit only for frames
// triggered by touch movement. Flutter does all its work in
// requestAnimationFrame and shows frames through a main-thread canvas, so
// once the finger lifts, flings and animations run at 60.
//
// How: a dedicated worker's requestAnimationFrame is not limited. This script
//  1. hands Flutter's on-screen canvas to a worker (transferControlToOffscreen)
//     and posts each finished frame there; the worker shows one per refresh,
//  2. runs window.requestAnimationFrame callbacks on the worker's ticks, and
//  3. gives Flutter one touch move per tick, resampled to the tick's time,
//     since Chrome delivers touch moves on its own schedule.
//
// Load it before flutter_bootstrap.js:
//   <script src="flutter_shim.js"></script>
// It does nothing in other browsers, and keeps the normal path until the
// worker's clock is running.
(() => {
  'use strict';

  const config = window.flutterShimConfig || {};
  const ua = navigator.userAgent;
  const supported = typeof Worker === 'function' && typeof OffscreenCanvas === 'function' &&
    'transferControlToOffscreen' in HTMLCanvasElement.prototype;
  if (!supported || !((/Android/.test(ua) && /Chrome\//.test(ua)) || config.anyPlatform)) return;

  // Read-only status, for debugging and overlays.
  const status = (window.flutterShim = { active: false, frames: 0, error: null });

  // ---------------------------------------------------------------------------
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

  // ---------------------------------------------------------------------------
  // Frame times. A tick can arrive late (the worker's first ticks after
  // waking, or a busy main thread). A stale time is moved up to the latest
  // refresh on its grid, and time never repeats or goes backwards, since
  // Flutter's animations and scroll physics jump when it does.
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

  const frameTime = (vsync) => {
    let time = vsync;
    const behind = performance.now() - time;
    if (behind > 1.5 * period) time += Math.floor(behind / period) * period;
    if (time <= lastFrameTime) time = lastFrameTime + period;
    return (lastFrameTime = time);
  };

  // ---------------------------------------------------------------------------
  // Touch. Chrome delivers touch moves in step with its own frames, not the
  // worker's ticks, so a tick would sometimes see two moves and sometimes
  // none, and a slow drag would move in uneven steps. Moves on Flutter's view
  // are held back instead, and each tick gives Flutter one move per finger,
  // at the position the finger had a short, fixed delay earlier (interpolated
  // between samples), the way Android resamples touch for native apps.
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
    // Flutter reads the time and the position relative to its view.
    Object.defineProperties(move, {
      timeStamp: { value: time },
      offsetX: { value: x + touch.offsetX },
      offsetY: { value: y + touch.offsetY },
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
  // Frame clock. Until the worker ticks with a Flutter canvas in hand, the
  // browser's own requestAnimationFrame is used.
  const nativeRaf = window.requestAnimationFrame.bind(window);
  const nativeCaf = window.cancelAnimationFrame.bind(window);
  let callbacks = new Map(), nextId = 1, awake = true, skippedLast = false, flutterCanvases = 0;

  const wake = () => {
    if (!awake) { awake = true; send({ type: 'wake' }); }
  };

  window.requestAnimationFrame = (callback) => {
    if (!status.active) return nativeRaf(callback);
    const id = -nextId++; // negative ids are ours, positive ones the browser's
    callbacks.set(id, callback);
    wake();
    return id;
  };
  window.cancelAnimationFrame = (id) => (id < 0 ? callbacks.delete(id) : nativeCaf(id));

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
    sendTouchMoves(vsync); // before the callbacks, so this frame sees the moves
    const run = callbacks;
    callbacks = new Map();
    if (run.size) {
      const time = frameTime(vsync);
      for (const callback of run.values()) {
        try { callback(time); } catch (error) { reportError(error); }
      }
    }
    if (!callbacks.size && !touches.size && awake) {
      awake = false;
      send({ type: 'sleep' });
    }
  };

  // ---------------------------------------------------------------------------
  // Canvases. Flutter shows each frame by calling transferFromImageBitmap on a
  // 'bitmaprenderer' context. Such a canvas is handed to the worker, and
  // Flutter gets a stand-in context that forwards its frames there.
  const contexts = new WeakMap();
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
    for (const prop of ['width', 'height']) {
      Object.defineProperty(this, prop, {
        configurable: true,
        get: () => size[prop],
        set: (value) => {
          if (value === size[prop]) return;
          size[prop] = value;
          send({ type: 'resize', id, prop, value });
        },
      });
    }
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
})();
