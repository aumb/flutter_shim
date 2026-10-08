#!/usr/bin/env node
// Measures how a Flutter page in Chrome on an Android phone renders, over adb.
//
//   adb forward tcp:9222 localabstract:chrome_devtools_remote
//   node tool/measure.mjs                     # 20 s; scroll the page yourself
//   node tool/measure.mjs --swipes flings     # scripted flings (adb input swipe)
//   node tool/measure.mjs --swipes reading    # scripted slow drags
//
// Options: --seconds N, --port 9222, --url <prefix of the tab's URL>.
// Records every Flutter frame and touch in the visible tab, then reports:
//  - frames per second while a finger is down and after it lifts,
//  - the share of frames that came one refresh (8.3 ms at 120 Hz) after the last,
//  - how evenly slow drags move (how much the per-frame step varies).
// Needs Node 22+ (built-in WebSocket).

import { execFileSync } from 'node:child_process';

const args = process.argv.slice(2);
const option = (name, fallback) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : fallback; };
const swipes = option('swipes');
const seconds = Number(option('seconds', swipes === 'reading' ? 15 : swipes ? 30 : 20));
const port = option('port', '9222');
const urlPrefix = option('url', '');

const adb = (...a) => execFileSync('adb', a, { encoding: 'utf8' });
const chromeInFront = () => /mCurrentFocus=.*com\.android\.chrome\/.*ChromeTabbedActivity/.test(adb('shell', 'dumpsys', 'window'));

// Find the visible tab.
const tabs = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).filter((t) => t.type === 'page' && t.url.startsWith(urlPrefix));
let ws, call;
for (const tab of tabs) {
  const socket = new WebSocket(tab.webSocketDebuggerUrl);
  const opened = await Promise.race([new Promise((r) => socket.addEventListener('open', () => r(true), { once: true })), new Promise((r) => setTimeout(() => r(false), 2000))]);
  if (!opened) continue;
  let id = 0;
  const evaluate = (expression, timeout = 3000) => Promise.race([
    new Promise((resolve) => {
      const i = ++id;
      socket.addEventListener('message', function onMessage(e) {
        const m = JSON.parse(e.data);
        if (m.id === i) { socket.removeEventListener('message', onMessage); resolve(m.result?.result?.value); }
      });
      socket.send(JSON.stringify({ id: i, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } }));
    }),
    new Promise((resolve) => setTimeout(() => resolve(null), timeout)),
  ]);
  if (await evaluate('document.visibilityState') === 'visible') { ws = socket; call = evaluate; console.log(`Tab: ${tab.url}`); break; }
  socket.close();
}
if (!ws) { console.error('No visible Chrome tab found. Is the phone unlocked with the page open, and the port forwarded?'); process.exit(1); }

// Record in the page.
const recording = call(`(async () => {
  const frames = [], pointers = []; let y = null;
  addEventListener('pointermove', (e) => { y = e.clientY; });
  for (const type of ['pointerdown', 'pointerup', 'pointercancel']) addEventListener(type, (e) => pointers.push([e.timeStamp, type]), true);
  const raf = window.requestAnimationFrame;
  window.requestAnimationFrame = (cb) => raf((t) => { const start = performance.now(); cb(t); frames.push([start, performance.now() - start, y]); });
  await new Promise((r) => setTimeout(r, ${seconds * 1000}));
  window.requestAnimationFrame = raf;
  return { frames, pointers, shim: window.flutterShim ? { ...window.flutterShim } : null };
})()`, seconds * 1000 + 5000);

if (swipes) {
  const [w, h] = adb('shell', 'wm', 'size').match(/(\d+)x(\d+)/).slice(1).map(Number);
  const x = Math.round(w / 2), at = (f) => Math.round(h * f);
  const sets = {
    flings: [[0.8, 0.2, 60], [0.8, 0.2, 60], [0.8, 0.2, 60], [0.25, 0.75, 60], [0.25, 0.75, 60], [0.75, 0.3, 2000], [0.3, 0.7, 2000], [0.8, 0.45, 180]],
    reading: [[0.72, 0.52, 3000], [0.52, 0.72, 3000], [0.72, 0.62, 3000], [0.75, 0.37, 2500]],
  };
  if (!sets[swipes]) { console.error(`Unknown --swipes ${swipes} (flings or reading)`); process.exit(1); }
  await new Promise((r) => setTimeout(r, 800));
  for (const [from, to, ms] of sets[swipes]) {
    if (!chromeInFront()) { console.error('Chrome is no longer in front; stopping the swipes.'); break; }
    adb('shell', 'input', 'swipe', String(x), String(at(from)), String(x), String(at(to)), String(ms));
    await new Promise((r) => setTimeout(r, swipes === 'flings' ? 900 : 400));
  }
}

const result = await recording;
ws.close();
if (!result) { console.error('Recording failed (the page may have reloaded).'); process.exit(1); }

// Report.
const VSYNC = 1000 / 120;
const touches = [];
let down = null;
for (const [t, type] of result.pointers.sort((a, b) => a[0] - b[0])) {
  if (type === 'pointerdown') down = t;
  else if (down !== null) { touches.push([down, t]); down = null; }
}
const touching = (t) => touches.some(([a, b]) => a <= t && t <= b);
const pct = (n, d) => (d ? `${Math.round((100 * n) / d)}%` : '–');

const phase = (name, frames) => {
  const gaps = frames.slice(1).map((f, i) => f[0] - frames[i][0]).filter((g) => g < 100);
  if (gaps.length < 3) { console.log(`  ${name}: too few frames`); return; }
  const active = gaps.reduce((a, b) => a + b, 0) / 1000;
  const onTime = gaps.filter((g) => g < 1.5 * VSYNC).length;
  const costs = frames.map((f) => f[1]).sort((a, b) => a - b);
  console.log(`  ${name.padEnd(14)} ${(gaps.length / active).toFixed(0).padStart(3)} fps | ${pct(onTime, gaps.length)} of frames one refresh after the last | Flutter frame cost p50 ${costs[costs.length >> 1].toFixed(1)} ms, max ${costs[costs.length - 1].toFixed(1)} ms`);
};
console.log(`\n${result.frames.length} frames, ${touches.length} touches${result.shim ? `, shim ${result.shim.active ? 'active' : 'inactive'}` : ', no shim'}`);
phase('finger down', result.frames.filter((f) => touching(f[0])));
phase('after release', result.frames.filter((f) => !touching(f[0])));

const steps = [];
for (const [a, b] of touches) {
  if (b - a < 1000) continue;
  const ys = result.frames.filter((f) => f[0] > a + 100 && f[0] < b - 50 && f[2] !== null).map((f) => f[2]);
  const d = ys.slice(1).map((y, i) => Math.abs(y - ys[i]));
  const median = [...d].sort((p, q) => p - q)[d.length >> 1];
  if (d.length > 20 && median > 0) steps.push(...d.map((s) => s / median));
}
if (steps.length) {
  const spread = Math.sqrt(steps.reduce((s, r) => s + (r - 1) ** 2, 0) / steps.length);
  console.log(`  slow drags     step variation ${Math.round(spread * 100)}% (lower is smoother) | ${pct(steps.filter((r) => Math.abs(r - 1) <= 0.25).length, steps.length)} of steps within 25% of typical`);
}
process.exit(0);
