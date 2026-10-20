// Loaded first on every example page (added by tool/serve.py, before Flutter).
//  - ?renderer=skwasm-st | skwasm | canvaskit picks Flutter's renderer, if the
//    build has it.
//  - ?anyplatform lets flutter_shim.js run outside Android Chrome, for
//    experiments such as desktop Chrome with its 60 Hz limit switched on.
//  - Flutter's deprecated service worker is skipped, so switching between
//    builds never serves stale files.
(() => {
  const params = new URLSearchParams(location.search);
  // ?anyplatform runs the Android path anywhere; ?webkit=0 turns the Safari
  // path off again. The demo turns it on, since a tester on an Apple device
  // is here to see what it does.
  window.flutterShimConfig = {
    anyPlatform: params.has('anyplatform'),
    webkit: params.get('webkit') !== '0',
  };

  // ?inspect=1 reports how this browser's Flutter draws and presents: which
  // canvas contexts it asks for, and where those canvases end up. The shim
  // has to hook whatever that turns out to be, and it differs by browser.
  if (params.has('inspect')) {
    const seen = [];
    const getContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (type, options) {
      seen.push({
        type, size: `${this.width}x${this.height}`, connected: this.isConnected,
        html: this.outerHTML.slice(0, 120), options: options ? { ...options } : null,
        flutterUp: !!document.querySelector('flutter-view'),
      });
      return getContext.call(this, type, options);
    };
    const offscreenGetContext = window.OffscreenCanvas?.prototype.getContext;
    if (offscreenGetContext) {
      OffscreenCanvas.prototype.getContext = function (type, options) {
        seen.push({ type: `offscreen:${type}`, size: `${this.width}x${this.height}` });
        return offscreenGetContext.call(this, type, options);
      };
    }

    // Count the drawing Flutter actually does, so "the app produced 120
    // frames" can be told apart from "120 callbacks ran and drew 60 frames".
    // Calls that fall in one burst are one frame.
    const drawTimes = [];
    for (const proto of [window.WebGL2RenderingContext?.prototype, window.WebGLRenderingContext?.prototype]) {
      for (const method of ['drawArrays', 'drawElements', 'clear']) {
        const original = proto?.[method];
        if (!original) continue;
        proto[method] = function (...args) {
          drawTimes.push(performance.now());
          return original.apply(this, args);
        };
      }
    }
    const log = params.get('log');
    setInterval(() => {
      const times = drawTimes.splice(0);
      const frames = times.filter((t, i) => i === 0 || t - times[i - 1] > 3);
      const gaps = frames.slice(1).map((t, i) => t - frames[i]).sort((a, b) => a - b);
      const q = (p) => (gaps.length ? gaps[Math.min(gaps.length - 1, Math.floor(p * gaps.length))] : 0);
      const message = {
        run: params.get('run'), name: 'drawn by Flutter (GL bursts)',
        rate: frames.length, p50: q(0.5), p10: q(0.1), p90: q(0.9),
        note: `${times.length} GL calls`,
      };
      if (log) navigator.sendBeacon(log, JSON.stringify(message));
    }, 1000);
    setTimeout(() => {
      const describe = (el) => `${el.tagName.toLowerCase()}${el.className ? '.' + String(el.className).split(' ').join('.') : ''}`;
      const canvases = [...document.querySelectorAll('canvas')].map(describe);
      const inShadow = [...document.querySelectorAll('flt-glass-pane')]
        .flatMap((p) => [...(p.shadowRoot?.querySelectorAll('canvas') ?? [])].map(describe));
      const report = {
        renderer: window.flutterCanvasKit ? 'canvaskit' : window._flutter?.buildConfig?.builds?.map((b) => b.renderer).join('+') ?? 'unknown',
        contexts: [...new Set(seen.map((s) => s.type))],
        seen: seen.slice(0, 12),
        canvasesInDocument: canvases,
        canvasesInGlassPane: inShadow,
      };
      if (log) navigator.sendBeacon(log, JSON.stringify({ run: params.get('run'), name: 'inspect', rate: 0, p50: 0, p10: 0, p90: 0, note: JSON.stringify(report) }));
      console.log('[inspect]', report);
    }, 8000);
  }

  window.flutterShimDemo = {
    load(options = {}) {
      const { serviceWorkerSettings, ...rest } = options;
      const config = { ...rest.config };
      const renderer = params.get('renderer');
      const wanted = renderer === 'skwasm-st' ? 'skwasm' : renderer;
      if (wanted && _flutter.buildConfig?.builds?.some((b) => b.renderer === wanted)) {
        config.renderer = wanted;
        if (renderer === 'skwasm-st') config.forceSingleThreadedSkwasm = true;
      }
      return _flutter.loader.load({ ...rest, config });
    },
  };
})();
