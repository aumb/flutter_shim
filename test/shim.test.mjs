// The shim's arithmetic: when to draw, what time to tell Flutter, and where a
// finger was. These are the parts that decide frame pacing, and they can be
// checked without a browser.
//
//   node --test        (from the repository root)
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const { createFrameTimes, createPeriodMeter, framesPerInterval, nextTickTime, positionAt } =
  require('../web/flutter_shim.js');

const REFRESH_60 = 1000 / 60;
const REFRESH_120 = 1000 / 120;
const close = (actual, expected, message) => assert.ok(Math.abs(actual - expected) < 1e-9, `${message}: ${actual} ≠ ${expected}`);

test('two frames per interval when Safari holds its own clock to 60', () => {
  assert.equal(framesPerInterval(REFRESH_60, 120), 2);
});

test('one frame per interval when the browser already runs at 120', () => {
  // The bug this guards against: doubling a clock that was already at the
  // display's rate drew 240 frames a second, half of which nobody could see.
  assert.equal(framesPerInterval(REFRESH_120, 120), 1);
});

test('frames per interval is the nearest whole number, and never less than one', () => {
  assert.equal(framesPerInterval(REFRESH_60, 60), 1);
  assert.equal(framesPerInterval(REFRESH_60, 10), 1);
  assert.equal(framesPerInterval(REFRESH_60, 240), 4);
  assert.equal(framesPerInterval(REFRESH_60, 100), 2); // 1.67 rounds to 2
});

test('the next tick is the next point on the grid the last refresh sits on', () => {
  const cadence = REFRESH_120;
  close(nextTickTime(1000, cadence, 1003), 1000 + cadence, 'just after a refresh');
  close(nextTickTime(1000, cadence, 1010), 1000 + 2 * cadence, 'past the first point');
});

test('a point too close to aim for is passed over', () => {
  const cadence = REFRESH_120;
  // 0.33 ms ahead of 1000 + cadence: too close for a timer to land on.
  close(nextTickTime(1000, cadence, 1008), 1000 + 2 * cadence, 'less than 2 ms ahead');
  close(nextTickTime(1000, cadence, 1000), 1000 + cadence, 'exactly on a refresh');
});

test('a timer that fires early does not draw the same point twice', () => {
  // The bug this guards against: aiming only at "the next point after now",
  // a tick that fired 4.7 ms before the point it was drawn for aimed straight
  // back at that point, so Safari drew 95 frames a second when asked for 60.
  const cadence = REFRESH_60;
  const drawnFor = 1000 + cadence;
  const firedAt = drawnFor - 4.7;
  close(nextTickTime(1000, cadence, firedAt), drawnFor, 'without the point last drawn: the same point again');
  close(nextTickTime(1000, cadence, firedAt, drawnFor), drawnFor + cadence, 'with it: the next point');
});

test('ticks can be scheduled before any refresh has been seen', () => {
  const tick = nextTickTime(0, REFRESH_120, 500);
  assert.ok(tick > 500 && tick - 500 <= REFRESH_120 + 2, `${tick} should be the next grid point after 500`);
});

test('frame times on time pass through unchanged', () => {
  const next = createFrameTimes();
  assert.equal(next(100, REFRESH_120, 100), 100);
  close(next(100 + REFRESH_120, REFRESH_120, 100 + REFRESH_120), 100 + REFRESH_120, 'second frame');
});

test('frame times never repeat or go backwards', () => {
  const next = createFrameTimes();
  const first = next(100, REFRESH_120, 100);
  const again = next(100, REFRESH_120, 100);
  const earlier = next(90, REFRESH_120, 100);
  assert.ok(again > first, 'a repeated time moves on');
  assert.ok(earlier > again, 'an earlier time moves on');
  close(again - first, REFRESH_120, 'by one step');
});

test('a late tick is moved up to the latest point on its grid', () => {
  const next = createFrameTimes();
  // Drawn 30 ms after it was due, on an 8.33 ms grid: three whole steps late.
  close(next(100, REFRESH_120, 130), 100 + 3 * REFRESH_120, 'moved up by whole steps');
});

test('a slightly late tick is left alone', () => {
  const next = createFrameTimes();
  assert.equal(next(100, REFRESH_120, 110), 100); // 10 ms is under 1.5 steps
});

test('the period meter takes the median and ignores intervals that are not refreshes', () => {
  const meter = createPeriodMeter();
  let t = 0;
  for (const gap of [16.7, 16.6, 50, 16.7, 1, 16.6, 16.7]) meter.add((t += gap));
  close(meter.period, 16.7, 'median of the plausible intervals');
  assert.equal(meter.last, t);
});

test('a finger is interpolated between the samples around a time', () => {
  const samples = [{ t: 0, x: 0, y: 0 }, { t: 10, x: 100, y: 50 }];
  assert.deepEqual(positionAt(samples, 5), { x: 50, y: 25 });
});

test('a finger is extrapolated a little past its newest sample, and no further', () => {
  const samples = [{ t: 0, x: 0, y: 0 }, { t: 10, x: 100, y: 0 }];
  assert.deepEqual(positionAt(samples, 14), { x: 140, y: 0 }, '4 ms ahead');
  assert.deepEqual(positionAt(samples, 20), { x: 180, y: 0 }, 'capped at 8 ms ahead');
});

test('a finger that stopped stays where it stopped', () => {
  const samples = [{ t: 0, x: 0, y: 0 }, { t: 10, x: 100, y: 0 }];
  assert.deepEqual(positionAt(samples, 30), samples[1]);
});

test('a time before the first sample gives the first sample', () => {
  const samples = [{ t: 10, x: 5, y: 5 }, { t: 20, x: 15, y: 5 }];
  assert.deepEqual(positionAt(samples, 0), samples[0]);
});
