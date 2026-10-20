#!/usr/bin/env node
// Measures a Flutter web app's time to first frame in Chrome: from the moment
// the browser starts navigating to the page until the app's first frame is
// on the screen, and where that time went. Then, since a first frame is often
// an empty screen still waiting on fonts or images, how long until the screen
// settled into what the app actually shows.
//
//   node tool/ttff.mjs http://localhost:8800/list/before/
//   node tool/ttff.mjs https://example.com/ --runs 10 --net slow-4g --cpu 4
//   node tool/ttff.mjs <url> <another url>     # compare them, loads interleaved
//
// Options:
//   --runs N             loads per URL (default 5)
//   --warm               repeat visits: one unmeasured load first, then each
//                        load in the same profile, so the browser's caches are
//                        warm (as far as the server's caching headers allow).
//                        Without it every load is a first visit, in a new
//                        profile with an empty cache and no service worker.
//   --net PRESET         network throttling: slow-4g, fast-4g, 3g, or
//                        down/up/latency as kbit/s/kbit/s/ms, e.g. 10000/2000/40
//   --cpu N              slow the CPU down N times (4 is a mid-range phone)
//   --viewport WxH[@DPR] page size and device pixel ratio, e.g. 412x915@2.6
//   --headed             a visible window instead of headless Chrome, so frames
//                        go through the real display (keep it uncovered)
//   --settle S           wait up to S seconds after the first frame for the
//                        screen to settle (default 10; 0 skips it)
//   --chrome PATH        the Chrome to run (default: the installed one, or
//                        $CHROME_PATH)
//   --timeout S          give up on a load after S seconds (default 60)
//   --out DIR            write results.json, and for each load what the
//                        screen showed at its first frame and once settled
//   --trace              with --out, also save each load's DevTools trace, to
//                        open in the Performance panel (recording it slows
//                        the page a little, so time those loads separately)
//
// The page needs no changes: web/flutter_ttff.js is injected before any of
// its scripts run, and times each step of Flutter's startup from inside the
// page. Chrome's trace adds what the page can't see, screenshots of what was
// actually on the screen:
//   first frame on screen   the first screenshot after Flutter presented its
//                           first frame that differs from what was there
//   screen settled          the last change on screen, once the app has drawn
//                           nothing and the network has been idle for 1 s
//
// Needs Node 22+ (built-in WebSocket).

import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// How long the app has to stay still, drawing nothing with nothing loading,
// to count as settled.
const QUIET = 1000;

// ---- Options ---------------------------------------------------------------

// Download and upload in kbit/s, latency in ms: DevTools' Slow 4G, Fast 4G
// and Slow 3G presets.
export const NETWORKS = {
  'slow-4g': { down: 1440, up: 675, latency: 562.5 },
  'fast-4g': { down: 8100, up: 1350, latency: 165 },
  '3g': { down: 400, up: 400, latency: 2000 },
};

export function parseOptions(argv) {
  const flags = new Set(['warm', 'headed', 'trace', 'help']);
  const raw = {};
  const urls = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '-h') raw.help = true;
    else if (arg.startsWith('--')) {
      const name = arg.slice(2);
      if (flags.has(name)) raw[name] = true;
      else if (i + 1 < argv.length) raw[name] = argv[++i];
      else throw new Error(`${arg} needs a value`);
    } else urls.push(arg);
  }
  const number = (name, fallback, min) => {
    const value = raw[name] === undefined ? fallback : Number(raw[name]);
    if (!(value >= min)) throw new Error(`--${name} needs a number, ${min} or more`);
    return value;
  };
  let network = null;
  if (raw.net) {
    const custom = raw.net.match(/^(\d+(?:\.\d+)?)\/(\d+(?:\.\d+)?)\/(\d+(?:\.\d+)?)$/);
    const spec = NETWORKS[raw.net] ?? (custom && { down: Number(custom[1]), up: Number(custom[2]), latency: Number(custom[3]) });
    if (!spec) throw new Error(`--net takes ${Object.keys(NETWORKS).join(', ')}, or down/up/latency in kbit/s/kbit/s/ms`);
    network = { name: raw.net, ...spec };
  }
  let viewport = null;
  if (raw.viewport) {
    const m = raw.viewport.match(/^(\d+)x(\d+)(?:@(\d+(?:\.\d+)?))?$/);
    if (!m) throw new Error('--viewport takes WxH or WxH@DPR, e.g. 412x915@2.6');
    viewport = { width: Number(m[1]), height: Number(m[2]), dpr: m[3] ? Number(m[3]) : 1 };
  }
  if (raw.trace && !raw.out) throw new Error('--trace needs --out DIR to save the traces in');
  const known = new Set([...flags, 'runs', 'net', 'cpu', 'viewport', 'settle', 'chrome', 'timeout', 'out']);
  for (const name of Object.keys(raw)) if (!known.has(name)) throw new Error(`Unknown option --${name}`);
  return {
    urls,
    help: !!raw.help,
    runs: number('runs', 5, 1),
    warm: !!raw.warm,
    network,
    cpu: number('cpu', 1, 1),
    viewport,
    headed: !!raw.headed,
    settle: number('settle', 10, 0) * 1000,
    chrome: raw.chrome ?? process.env.CHROME_PATH ?? null,
    timeout: number('timeout', 60, 1) * 1000,
    out: raw.out ?? null,
    trace: !!raw.trace,
  };
}

// ---- What the screen showed --------------------------------------------------

// The trace's screenshots, in the page's clock, oldest first. Each carries the
// time its frame was expected on the display, in the trace's clock; the
// probe's sync mark, recorded in both clocks, lines the two up.
export function screenshots(events) {
  const sync = events.find((e) => e.name === 'flutter_ttff:sync' && e.args?.data?.startTime != null);
  if (!sync) return [];
  const offset = sync.ts / 1000 - sync.args.data.startTime;
  return events
    .filter((e) => e.name === 'Screenshot' && e.args?.snapshot)
    .map((e) => ({ time: (e.args.expected_display_time ?? e.ts) / 1000 - offset, image: e.args.snapshot }))
    .sort((a, b) => a.time - b.time);
}

// When the first frame was handed to the page, or, if the probe couldn't see
// that, when Flutter built it.
export const firstFrameTime = (marks) => marks.presented ?? marks['first-frame'] ?? null;

// The first screenshot shown after Flutter presented its first frame that
// differs from what was on the screen before. A first frame that looks just
// like the page under it (white on white) changes nothing; then it is the
// first screenshot after it, marked `unchanged`.
export function findOnScreen(shots, presented) {
  if (presented == null) return null;
  const before = shots.filter((s) => s.time < presented).pop();
  const after = shots.filter((s) => s.time >= presented);
  const changed = after.find((s) => s.image !== before?.image);
  const shot = changed ?? after[0];
  return shot ? { time: shot.time, image: shot.image, unchanged: !changed } : null;
}

// The last change on screen from the first frame on: what the app settled
// into, and when.
export function findSettled(shots, onScreen) {
  if (!onScreen) return null;
  let last = onScreen;
  for (let i = 1; i < shots.length; i++) {
    if (shots[i].time > onScreen.time && shots[i].image !== shots[i - 1].image) last = shots[i];
  }
  return { time: last.time, image: last.image };
}

// ---- Statistics ----------------------------------------------------------------

export function quantile(values, q) {
  const sorted = [...values].sort((a, b) => a - b);
  const i = (sorted.length - 1) * q;
  const lo = Math.floor(i), hi = Math.ceil(i);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}
const median = (values) => quantile(values, 0.5);

// ---- Chrome ------------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const withTimeout = (promise, ms, what) => Promise.race([
  promise,
  sleep(ms).then(() => {
    throw new Error(`${what} took more than ${Math.round(ms / 1000)} s`);
  }),
]);

function findChrome() {
  const candidates = {
    darwin: [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
    ],
    win32: [
      `${process.env.PROGRAMFILES}\\Google\\Chrome\\Application\\chrome.exe`,
      `${process.env['PROGRAMFILES(X86)']}\\Google\\Chrome\\Application\\chrome.exe`,
      `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
    ],
  }[process.platform] ?? [];
  for (const path of candidates) if (existsSync(path)) return path;
  for (const name of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']) {
    try {
      return execFileSync('which', [name], { encoding: 'utf8' }).trim();
    } catch {}
  }
  return null;
}

// Starts Chrome on a throwaway profile, and returns a minimal DevTools
// protocol client for it: one socket for the browser, with each page reached
// through its own session on it.
async function launch({ chrome, headed }) {
  const executable = chrome ?? findChrome();
  if (!executable) throw new Error('Chrome not found: pass --chrome <path> or set CHROME_PATH.');
  const profile = mkdtempSync(join(tmpdir(), 'flutter-ttff-'));
  const child = spawn(executable, [
    `--user-data-dir=${profile}`,
    '--remote-debugging-port=0',
    ...(headed ? [] : ['--headless']),
    '--window-size=1280,800',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-default-apps',
    '--disable-extensions',
    '--disable-sync',
    '--disable-background-networking',
    '--disable-component-update',
    // A window that loses focus, or is covered, must not be throttled: that
    // would measure as a slow page.
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    // No macOS keychain prompt for a throwaway profile.
    '--use-mock-keychain',
    '--password-store=basic',
    'about:blank',
  ], { stdio: 'ignore' });
  const close = () => {
    child.kill();
    try {
      rmSync(profile, { recursive: true, force: true, maxRetries: 3 });
    } catch {}
  };

  // Chrome writes the port it picked, and the browser's DevTools path, here.
  let endpoint;
  for (let i = 0; i < 200 && !endpoint; i++) {
    await sleep(50);
    try {
      const [port, path] = readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').split('\n');
      if (port && path) endpoint = `ws://127.0.0.1:${port}${path}`;
    } catch {}
  }
  if (!endpoint) {
    close();
    throw new Error(`${executable} started but never opened its DevTools port.`);
  }

  const socket = new WebSocket(endpoint);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', () => reject(new Error('Could not connect to Chrome.')), { once: true });
  });
  let nextId = 0;
  const pending = new Map();
  const listeners = new Set();
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.id !== undefined) {
      const call = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) call?.reject(new Error(`${call.method}: ${message.error.message}`));
      else call?.resolve(message.result);
      return;
    }
    for (const listener of listeners) listener(message);
  });
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject, method });
    socket.send(JSON.stringify({ id, method, params, ...(sessionId && { sessionId }) }));
  });
  const on = (sessionId, method, handler) => {
    const listener = (m) => m.sessionId === sessionId && m.method === method && handler(m.params);
    listeners.add(listener);
    return () => listeners.delete(listener);
  };
  const { product } = await send('Browser.getVersion');
  return { send, on, close, product };
}

// ---- One load ----------------------------------------------------------------

const TRACE_CATEGORIES = ['disabled-by-default-devtools.screenshot', 'blink.user_timing'];
// What the DevTools Performance panel records, for --trace.
const DEVTOOLS_CATEGORIES = [
  ...TRACE_CATEGORIES, 'devtools.timeline', 'disabled-by-default-devtools.timeline',
  'disabled-by-default-devtools.timeline.frame', 'disabled-by-default-devtools.timeline.stack', 'toplevel',
  'blink.console', 'loading', 'latencyInfo', 'v8.execute', 'disabled-by-default-v8.cpu_profiler', 'rail',
];

// Opens a page in its own session, set up for measuring: the probe injected,
// throttling applied. Pages in one browser context share their caches.
async function openPage({ send }, browserContextId, options, probe) {
  const { targetId } = await send('Target.createTarget', { url: 'about:blank', browserContextId });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  await send('Page.enable', {}, sessionId);
  await send('Network.enable', {}, sessionId);
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: `window.flutterTtffConfig = { console: false, timeout: ${options.timeout}, settle: ${QUIET} };\n${probe}`,
  }, sessionId);
  const { network, cpu, viewport } = options;
  if (network) {
    await send('Network.emulateNetworkConditions', {
      offline: false,
      latency: network.latency,
      downloadThroughput: (network.down * 1000) / 8,
      uploadThroughput: (network.up * 1000) / 8,
    }, sessionId);
  }
  if (cpu > 1) await send('Emulation.setCPUThrottlingRate', { rate: cpu }, sessionId);
  if (viewport) {
    await send('Emulation.setDeviceMetricsOverride', {
      width: viewport.width, height: viewport.height, deviceScaleFactor: viewport.dpr, mobile: false,
    }, sessionId);
  }
  return { targetId, sessionId };
}

// Loads `url` in the page and returns what the probe and the trace saw.
async function measure({ send, on }, { sessionId }, url, options, fullTrace) {
  await send('Page.navigate', { url: 'about:blank' }, sessionId);
  const evaluate = async (expression, awaitPromise = false) => {
    const { result, exceptionDetails } = await send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true }, sessionId);
    if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
    return result.value;
  };

  // Response sizes, which the page itself can't see for another origin's
  // files unless that origin sends Timing-Allow-Origin, and what is still
  // loading, which it can't see at all.
  const requests = new Map();
  const inFlight = new Set();
  let lastNetwork = Date.now();
  const activity = (id, busy) => {
    lastNetwork = Date.now();
    if (busy) inFlight.add(id);
    else inFlight.delete(id);
  };
  const stops = [
    on(sessionId, 'Network.requestWillBeSent', (p) => {
      requests.set(p.requestId, { url: p.request.url, cached: false });
      // A worker's blob: or data: script is reported starting here and
      // finishing in the worker's own session, if at all; it isn't a download.
      if (/^https?:/.test(p.request.url)) activity(p.requestId, true);
    }),
    on(sessionId, 'Network.requestServedFromCache', (p) => requests.has(p.requestId) && (requests.get(p.requestId).cached = true)),
    on(sessionId, 'Network.responseReceived', (p) => {
      const r = requests.get(p.requestId);
      if (r && (p.response.fromDiskCache || p.response.fromPrefetchCache || p.response.fromServiceWorker)) r.cached = true;
    }),
    on(sessionId, 'Network.loadingFinished', (p) => {
      if (requests.has(p.requestId)) requests.get(p.requestId).bytes = p.encodedDataLength;
      activity(p.requestId, false);
    }),
    on(sessionId, 'Network.loadingFailed', (p) => activity(p.requestId, false)),
  ];

  const events = [];
  let traceComplete;
  const traced = new Promise((resolve) => (traceComplete = resolve));
  stops.push(
    on(sessionId, 'Tracing.dataCollected', (p) => events.push(...p.value)),
    on(sessionId, 'Tracing.tracingComplete', () => traceComplete()),
  );
  await send('Tracing.start', {
    transferMode: 'ReportEvents',
    traceConfig: { includedCategories: fullTrace ? DEVTOOLS_CATEGORIES : TRACE_CATEGORIES, excludedCategories: ['*'] },
  }, sessionId);

  let navigated;
  const committed = new Promise((resolve) => (navigated = resolve));
  stops.push(on(sessionId, 'Page.frameNavigated', (p) => !p.frame.parentId && p.frame.url !== 'about:blank' && navigated()));

  let report, error, still = null, loading = [];
  try {
    const result = await send('Page.navigate', { url }, sessionId);
    if (result.errorText) throw new Error(`${url}: ${result.errorText}`);
    await withTimeout(committed, options.timeout, 'Loading the page');
    const first = await withTimeout(evaluate('window.flutterTtff ? window.flutterTtff.done : null', true), options.timeout + 10000, 'Waiting for the first frame');
    if (!first) throw new Error('the page has no window.flutterTtff (did it navigate away?)');

    // Settling: wait until the app has drawn nothing, and nothing has been
    // loading, for a second.
    if (!first.timedOut && options.settle > 0) {
      const start = Date.now();
      let lastFrame = first.frames.last, lastDraw = Date.now();
      still = 'drawing';
      while (Date.now() - start < options.settle) {
        const frame = await evaluate('window.flutterTtff.frames.last');
        if (frame !== lastFrame) {
          lastFrame = frame;
          lastDraw = Date.now();
        }
        if (!inFlight.size && Date.now() - Math.max(lastDraw, lastNetwork) >= QUIET) {
          still = null;
          break;
        }
        await sleep(100);
      }
      if (still && Date.now() - lastDraw >= QUIET) still = 'loading';
      if (still === 'loading') loading = [...inFlight].map((id) => requests.get(id)?.url).filter(Boolean);
    }
    await evaluate('window.flutterTtff.stop()');
    report = await evaluate('window.flutterTtff.report()');
    // The screenshot of a frame just presented is taken as it reaches the
    // screen, a refresh or two later.
    await sleep(300);
  } catch (e) {
    error = e.message;
  }
  await send('Tracing.end', {}, sessionId);
  await withTimeout(traced, 30000, 'Collecting the trace').catch(() => {});
  for (const stop of stops) stop();
  if (error) return { error };

  // Sizes go with the page's own timings, matched by URL.
  const byUrl = new Map();
  for (const r of requests.values()) {
    if (!byUrl.has(r.url)) byUrl.set(r.url, []);
    byUrl.get(r.url).push(r);
  }
  for (const resource of report.resources) {
    const match = byUrl.get(resource.url)?.shift();
    resource.bytes = match?.bytes ?? resource.transferSize ?? 0;
    resource.cached = match?.cached ?? resource.transferSize === 0;
  }

  const shots = screenshots(events);
  const onScreen = findOnScreen(shots, firstFrameTime(report.marks));
  const settled = options.settle > 0 ? findSettled(shots, onScreen) : null;
  return { report, onScreen, settled, still, loading, events: fullTrace ? events : null };
}

// ---- Output ------------------------------------------------------------------

const ms = (v) => `${Math.round(v)}`;
const size = (bytes) => (bytes >= 1e6 ? `${(bytes / 1e6).toFixed(1)} MB` : bytes >= 1e3 ? `${Math.round(bytes / 1e3)} kB` : `${bytes} B`);

const MILESTONES = {
  html: 'HTML received',
  loader: 'Flutter loader started',
  entrypoint: 'Dart entrypoint running',
  engine: 'engine initialized',
  view: '<flutter-view> in the page',
  app: "app's main() returned",
  'first-frame': 'first frame built',
  presented: 'first frame presented',
  onScreen: 'first frame on screen',
  fcp: 'first-contentful-paint',
  settled: 'screen settled',
};

// The files worth a row of their own: the ones Flutter's startup waits on.
const CORE = /^(flutter(_bootstrap)?\.js|main\.dart\.(js|mjs|wasm)|canvaskit\.(js|wasm)|skwasm(_heavy)?\.(js|wasm)|wimp\.(js|wasm))\b/;
const FONT = /\.(ttf|otf|woff2?)\b/;

// The milestones of one load, as { key: [label, ms] }.
function timeline({ report, onScreen, settled, still }) {
  const rows = {};
  for (const [key, time] of Object.entries(report.marks)) {
    if (MILESTONES[key] && key !== 'settled' && time != null) rows[key] = [MILESTONES[key], time];
  }
  if (onScreen) rows.onScreen = [MILESTONES.onScreen, onScreen.time];
  if (settled && !still) rows.settled = [MILESTONES.settled, settled.time];
  // Chrome's own first paint of content is the Flutter frame only when
  // nothing else in the page painted first.
  const fcp = report.paints['first-contentful-paint'];
  if (fcp != null && report.marks.view != null && fcp >= report.marks.view) rows.fcp = [MILESTONES.fcp, fcp];
  const firstFrame = firstFrameTime(report.marks) ?? Infinity;
  for (const r of report.resources) {
    if (CORE.test(r.name) && r.end <= firstFrame) rows[`file:${r.name}`] = [`  ${r.name} downloaded`, r.end];
  }
  const fonts = report.resources.filter((r) => FONT.test(r.name) && r.end <= firstFrame);
  if (fonts.length) {
    rows.fonts = [`  ${fonts.length === 1 ? fonts[0].name : `${fonts.length} fonts`} downloaded`, Math.max(...fonts.map((r) => r.end))];
  }
  return rows;
}

function describeSetup({ report }, options, product) {
  const browser = `${product.replace('/', ' ').replace(/\.\d+\.\d+\.\d+$/, '')}${options.headed ? '' : ' headless'}`;
  const cache = options.warm ? 'warm cache (repeat visits)' : 'cold cache (first visits)';
  const { network, cpu } = options;
  const net = network ? `network ${network.name} (${network.down}/${network.up} kbit/s, ${network.latency} ms)` : 'no network throttling';
  const cpuText = cpu > 1 ? `CPU ${cpu}× slower` : 'no CPU throttling';
  const { width, height, devicePixelRatio } = report.viewport;
  const renderer = [report.renderer ?? 'renderer unknown', report.compileTarget, report.multiThreaded == null ? null : report.multiThreaded ? 'multi-threaded' : 'single-threaded'];
  return [
    `${browser} · ${cache} · ${net} · ${cpuText} · ${width}×${height} @${Number(devicePixelRatio.toFixed(2))}x`,
    `${renderer.filter(Boolean).join(', ')} · GPU: ${report.gpu ?? 'none'}`,
  ];
}

const loaded = (report, until) => {
  const files = report.resources.filter((r) => r.end <= until);
  return { files, bytes: files.reduce((sum, r) => sum + (r.cached ? 0 : r.bytes), 0), cached: files.filter((r) => r.cached).length };
};

function summarize(label, loads, options, product) {
  const good = loads.filter((l) => !l.error && !l.report.timedOut);
  console.log(`\n${label}`);
  for (const load of loads.filter((l) => l.error || l.report?.timedOut)) {
    if (load.error) {
      console.log(`  load ${load.run}: ${load.error}`);
      continue;
    }
    // How far it got says where to look.
    const { marks, errors } = load.report;
    const reached = Object.keys(MILESTONES).filter((key) => key !== 'html' && marks[key] != null).pop();
    const where = reached ? `got as far as "${MILESTONES[reached]}"` : "Flutter's loader never started: is this a Flutter web app?";
    console.log(`  load ${load.run}: no first frame within ${options.timeout / 1000} s; ${where}${errors.length ? ` Errors: ${errors.join('; ')}` : ''}`);
  }
  if (!good.length) return null;
  for (const line of describeSetup(good[0], options, product)) console.log(`  ${line}`);

  const rows = new Map();
  for (const load of good) {
    for (const [key, [name, time]] of Object.entries(timeline(load))) {
      if (!rows.has(key)) rows.set(key, { name, times: [] });
      rows.get(key).times.push(time);
    }
  }
  const table = [...rows.entries()]
    .map(([key, { name, times }]) => ({ key, name, times, median: median(times) }))
    .sort((a, b) => a.median - b.median || (a.key.startsWith('file:') ? -1 : 1));
  const width = Math.max(...table.map((r) => r.name.length)) + 2;
  const many = good.length > 1;
  console.log(`\n  ${''.padEnd(width)}${many ? 'median ms   min–max' : '    ms'}`);
  for (const row of table) {
    const value = ms(row.median).padStart(6);
    const range = many ? `   ${`${ms(Math.min(...row.times))}–${ms(Math.max(...row.times))}`.padEnd(12)}` : '';
    const partial = row.times.length < good.length ? ` (${row.times.length} of ${good.length} loads)` : '';
    const arrow = row.key === 'onScreen' ? '  ← time to first frame' : '';
    console.log(`  ${row.name.padEnd(width)}${value}${range}${partial}${arrow}`.trimEnd());
  }

  const stat = (key) => {
    const times = rows.get(key).times;
    return `${ms(median(times))} ms${many ? ` (median of ${times.length}; ${ms(Math.min(...times))}–${ms(Math.max(...times))})` : ''}`;
  };
  console.log('');
  if (rows.has('onScreen')) console.log(`  Time to first frame: ${stat('onScreen')}, on screen.`);
  else if (rows.has('presented')) console.log(`  Time to first frame: ${stat('presented')}, presented. No screenshot showed it reaching the screen.`);
  else console.log(`  Time to first frame: ${stat('first-frame')}, built. Neither its presenting nor a screenshot of it could be seen.`);
  if (rows.has('settled')) console.log(`  Screen settled:      ${stat('settled')}, the last change on screen.`);

  const unchanged = good.filter((l) => l.onScreen?.unchanged).length;
  if (unchanged) console.log(`  In ${unchanged} load(s) the first frame looked the same as the page under it, so "on screen" is the first screenshot after it.`);
  for (const reason of ['drawing', 'loading']) {
    const still = good.filter((l) => l.still === reason);
    if (!still.length) continue;
    const what = reason === 'drawing' ? 'drawing (an animation?)' : `loading (${[...new Set(still.flatMap((l) => l.loading))].slice(0, 3).join(', ')})`;
    console.log(`  In ${still.length} load(s) the app was still ${what} ${options.settle / 1000} s after its first frame, so it has no settled time; --settle waits longer.`);
  }
  const fcp = good.map((l) => l.report.paints['first-contentful-paint']).filter((t) => t != null);
  if (fcp.length && !rows.has('fcp')) console.log(`  Chrome's first-contentful-paint (${ms(median(fcp))} ms) came from the page before Flutter's view existed, so it isn't the app's.`);

  // What had to arrive first, from the median load.
  const key = (l) => l.onScreen?.time ?? firstFrameTime(l.report.marks);
  const typical = [...good].sort((a, b) => key(a) - key(b))[good.length >> 1];
  const before = loaded(typical.report, firstFrameTime(typical.report.marks));
  const largest = [...before.files].sort((a, b) => b.bytes - a.bytes).filter((r) => r.bytes > 0).slice(0, 4);
  console.log(`  Loaded before the first frame: ${before.files.length} files, ${size(before.bytes)} over the network${before.cached ? ` (${before.cached} from cache)` : ''}. Largest: ${largest.map((r) => `${r.name} ${size(r.bytes)}${r.cached ? ' (cached)' : ''}`).join(', ')}.`);
  if (typical.settled && !typical.still) {
    const after = loaded(typical.report, typical.settled.time);
    if (after.files.length > before.files.length) console.log(`  And by the time it settled: ${after.files.length} files, ${size(after.bytes)}.`);
  }
  const errors = [...new Set(good.flatMap((l) => l.report.errors))];
  if (errors.length) console.log(`  Errors on the page: ${errors.join('; ')}`);
  return { table };
}

// ---- Main ----------------------------------------------------------------------

async function main() {
  let options;
  try {
    options = parseOptions(process.argv.slice(2));
  } catch (e) {
    console.error(e.message);
    return 1;
  }
  if (options.help || !options.urls.length) {
    const usage = readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1);
    console.log(usage.slice(0, usage.findIndex((l) => !l.startsWith('//'))).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
    return options.help ? 0 : 1;
  }
  const { urls, runs, warm } = options;
  const probe = readFileSync(join(ROOT, 'web', 'flutter_ttff.js'), 'utf8');

  let browser;
  try {
    browser = await launch(options);
  } catch (e) {
    console.error(e.message);
    return 1;
  }
  process.on('SIGINT', () => {
    browser.close();
    process.exit(130);
  });
  const { send } = browser;

  const labels = urls.map((url) => {
    try {
      const u = new URL(url);
      return `${u.host}${u.pathname}${u.search}${u.hash}`;
    } catch {
      return url;
    }
  });
  const tag = (i) => String.fromCharCode(65 + i);
  console.log(`Measuring time to first frame: ${runs} ${warm ? 'repeat' : 'first'} visit${runs > 1 ? 's' : ''} per URL${urls.length > 1 ? ', interleaved' : ''}.`);

  const results = urls.map(() => []);
  try {
    // Repeat visits share one profile per URL, primed with a load that isn't
    // counted. First visits each get a new one.
    const pages = [];
    if (warm) {
      for (const url of urls) {
        const { browserContextId } = await send('Target.createBrowserContext');
        const page = await openPage(browser, browserContextId, options, probe);
        pages.push(page);
        const primed = await measure(browser, page, url, options, false);
        if (primed.error) throw new Error(primed.error);
      }
    }
    for (let run = 1; run <= runs; run++) {
      for (const [i, url] of urls.entries()) {
        let page = pages[i], browserContextId;
        if (!warm) {
          ({ browserContextId } = await send('Target.createBrowserContext'));
          page = await openPage(browser, browserContextId, options, probe);
        }
        const load = { run, ...(await measure(browser, page, url, options, options.trace)) };
        if (!warm) {
          await send('Target.closeTarget', { targetId: page.targetId }).catch(() => {});
          await send('Target.disposeBrowserContext', { browserContextId }).catch(() => {});
        }
        results[i].push(load);
        const first = load.onScreen?.time ?? (load.report && firstFrameTime(load.report.marks));
        const settled = load.settled && !load.still ? `, settled ${ms(load.settled.time)} ms` : '';
        console.log(`  ${labels[i]}  load ${run}: ${load.error ? `failed (${load.error})` : first != null ? `first frame ${ms(first)} ms${settled}` : 'no first frame'}`);
      }
    }
  } catch (e) {
    console.error(`\n${e.message}`);
    browser.close();
    return 1;
  }

  const summaries = urls.map((url, i) => summarize(labels[i], results[i], options, browser.product));
  const failed = summaries.some((s) => !s);

  if (urls.length > 1 && summaries.every(Boolean)) {
    // Side by side, for the milestones every URL reached.
    const shared = Object.keys(MILESTONES).filter((key) => summaries.every((s) => s.table.some((r) => r.key === key)));
    const two = urls.length === 2;
    console.log(`\nCompared (median ms; ${urls.map((u, i) => `${tag(i)} = ${labels[i]}`).join(', ')})`);
    const width = Math.max(...shared.map((k) => MILESTONES[k].length)) + 2;
    console.log(`  ${''.padEnd(width)}${urls.map((_, i) => tag(i).padStart(7)).join('')}${two ? 'B−A'.padStart(9) : ''}`);
    for (const key of shared) {
      const values = summaries.map((s) => s.table.find((r) => r.key === key).median);
      const diff = values[1] - values[0];
      console.log(`  ${MILESTONES[key].padEnd(width)}${values.map((v) => ms(v).padStart(7)).join('')}${two ? `${diff >= 0 ? '+' : ''}${ms(diff)}`.padStart(9) : ''}`);
    }
  }

  if (options.out) {
    mkdirSync(options.out, { recursive: true });
    const loads = [];
    for (const [i, list] of results.entries()) {
      for (const load of list) {
        const name = `${urls.length > 1 ? `${tag(i)}-` : ''}${load.run}`;
        if (load.onScreen) writeFileSync(join(options.out, `${name}-first-frame.jpg`), Buffer.from(load.onScreen.image, 'base64'));
        if (load.settled) writeFileSync(join(options.out, `${name}-settled.jpg`), Buffer.from(load.settled.image, 'base64'));
        if (load.events) writeFileSync(join(options.out, `${name}.trace.json`), JSON.stringify({ traceEvents: load.events }));
        loads.push({
          url: urls[i],
          run: load.run,
          error: load.error ?? null,
          onScreen: load.onScreen ? { time: load.onScreen.time, unchanged: load.onScreen.unchanged } : null,
          settled: load.settled ? { time: load.settled.time, still: load.still } : null,
          ...(load.report && { report: load.report }),
        });
      }
    }
    const { network, cpu, viewport, headed, settle } = options;
    writeFileSync(join(options.out, 'results.json'), JSON.stringify({
      browser: browser.product, headless: !headed, cache: warm ? 'warm' : 'cold', network, cpu, viewport, settle, loads,
    }, null, 2));
    const extras = ["each load's screen at its first frame and once settled", options.trace && 'a DevTools trace per load'].filter(Boolean);
    console.log(`\nWrote ${join(options.out, 'results.json')}, with ${extras.join(', and ')}.`);
  }

  browser.close();
  return failed ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
  process.exit();
}
