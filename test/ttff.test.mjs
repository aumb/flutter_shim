// tool/ttff.mjs's reading of a load: lining the trace's screenshots up with
// the page's clock, and picking out the first frame on screen and the screen
// it settled into. These decide the numbers it reports, and they can be
// checked without a browser.
//
//   node --test        (from the repository root)
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { findOnScreen, findSettled, firstFrameTime, parseOptions, quantile, screenshots } from '../tool/ttff.mjs';

// A trace whose clock runs 5,000 ms ahead of the page's: the sync mark was
// recorded at page time 100, trace time 5,100 (in µs, as traces count).
const sync = { name: 'flutter_ttff:sync', ts: 5100 * 1000, args: { data: { startTime: 100 } } };
const shot = (displayMs, image, tsMs = displayMs - 2) => ({
  name: 'Screenshot',
  ts: (5000 + tsMs) * 1000,
  args: { snapshot: image, expected_display_time: (5000 + displayMs) * 1000 },
});
const at = (time, image) => ({ time, image });

test('screenshots are put on the page clock, at their expected display time, oldest first', () => {
  const shots = screenshots([shot(300, 'b'), sync, shot(200, 'a'), { name: 'Other', ts: 1 }]);
  assert.deepEqual(shots, [at(200, 'a'), at(300, 'b')]);
});

test('a screenshot with no expected display time falls back to when it was taken', () => {
  const event = shot(250, 'a');
  delete event.args.expected_display_time;
  assert.deepEqual(screenshots([sync, event]), [at(248, 'a')]);
});

test('without the sync mark nothing can be lined up', () => {
  assert.deepEqual(screenshots([shot(200, 'a')]), []);
});

test('the first frame on screen is the first change after it was presented', () => {
  const shots = [at(100, 'blank'), at(500, 'blank'), at(520, 'app'), at(540, 'app2')];
  assert.deepEqual(findOnScreen(shots, 510), { time: 520, image: 'app', unchanged: false });
});

test('a frame shown just after presenting, but drawn before it, is passed over', () => {
  // The screenshot at 512 is still the old screen: the compositor was showing
  // a frame it had before Flutter's arrived.
  const shots = [at(100, 'blank'), at(512, 'blank'), at(529, 'app')];
  assert.equal(findOnScreen(shots, 510).time, 529);
});

test('a first frame that looks like the page under it counts as the next screenshot', () => {
  const shots = [at(100, 'white'), at(520, 'white'), at(540, 'white')];
  assert.deepEqual(findOnScreen(shots, 510), { time: 520, image: 'white', unchanged: true });
});

test('no screenshot after the first frame, or no first frame, means no time on screen', () => {
  assert.equal(findOnScreen([at(100, 'blank')], 510), null);
  assert.equal(findOnScreen([at(100, 'blank')], null), null);
});

test('the screen settles at its last change', () => {
  const shots = [at(100, 'blank'), at(520, 'empty app'), at(900, 'with fonts'), at(1400, 'with images'), at(1420, 'with images')];
  const onScreen = findOnScreen(shots, 510);
  assert.deepEqual(findSettled(shots, onScreen), { time: 1400, image: 'with images' });
});

test('a first frame that is already complete is also where the screen settled', () => {
  const shots = [at(100, 'blank'), at(520, 'app'), at(800, 'app')];
  const onScreen = findOnScreen(shots, 510);
  assert.deepEqual(findSettled(shots, onScreen), { time: 520, image: 'app' });
});

test('changes before the first frame have no say in where the screen settled', () => {
  const shots = [at(50, 'splash 1'), at(100, 'splash 2'), at(520, 'app')];
  assert.equal(findSettled(shots, findOnScreen(shots, 510)).time, 520);
  assert.equal(findSettled(shots, null), null);
});

test('when presenting could not be seen, the first frame is when it was built', () => {
  assert.equal(firstFrameTime({ 'first-frame': 400, presented: 450 }), 450);
  assert.equal(firstFrameTime({ 'first-frame': 400 }), 400);
  assert.equal(firstFrameTime({}), null);
});

test('quantiles interpolate between loads', () => {
  assert.equal(quantile([3, 1, 2], 0.5), 2);
  assert.equal(quantile([1, 2, 3, 4], 0.5), 2.5);
  assert.equal(quantile([10], 0.9), 10);
});

test('options have defaults a first run can use', () => {
  const options = parseOptions(['http://localhost:8800/list/before/']);
  assert.deepEqual(options.urls, ['http://localhost:8800/list/before/']);
  assert.equal(options.runs, 5);
  assert.equal(options.warm, false);
  assert.equal(options.network, null);
  assert.equal(options.cpu, 1);
  assert.equal(options.settle, 10000);
  assert.equal(options.timeout, 60000);
});

test('network presets and custom networks', () => {
  assert.deepEqual(parseOptions(['u', '--net', 'slow-4g']).network, { name: 'slow-4g', down: 1440, up: 675, latency: 562.5 });
  assert.deepEqual(parseOptions(['u', '--net', '10000/2000/40']).network, { name: '10000/2000/40', down: 10000, up: 2000, latency: 40 });
  assert.throws(() => parseOptions(['u', '--net', 'dialup']), /--net takes/);
});

test('viewports, with and without a pixel ratio', () => {
  assert.deepEqual(parseOptions(['u', '--viewport', '412x915@2.6']).viewport, { width: 412, height: 915, dpr: 2.6 });
  assert.deepEqual(parseOptions(['u', '--viewport', '1280x800']).viewport, { width: 1280, height: 800, dpr: 1 });
  assert.throws(() => parseOptions(['u', '--viewport', 'big']), /--viewport takes/);
});

test('options that would measure nothing, or the wrong thing, are refused', () => {
  assert.throws(() => parseOptions(['u', '--runs', '0']), /--runs/);
  assert.throws(() => parseOptions(['u', '--cpu', 'fast']), /--cpu/);
  assert.throws(() => parseOptions(['u', '--trace']), /--trace needs --out/);
  assert.throws(() => parseOptions(['u', '--frobnicate', '1']), /Unknown option --frobnicate/);
  assert.throws(() => parseOptions(['u', '--runs']), /--runs needs a value/);
  assert.equal(parseOptions(['u', '--settle', '0']).settle, 0);
});
