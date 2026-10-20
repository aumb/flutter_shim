// Drives an example app with scripted input, so its frame rate can be
// measured without a hand on the screen. Safari can't be driven from the
// outside the way Chrome can over the DevTools protocol, so the page does it
// to itself.
//
//   ?stress=fling   a fast drag, released, then the fling animates out (repeats)
//   ?stress=drag    one slow steady drag, up and down forever
//   ?stress=wheel   wheel events, for a pointer device
//
// The events are synthetic, so isTrusted is false; Flutter handles them like
// any other, which is also what the shim's own resampled moves rely on.
// Loaded before flutter_shim.js, so the browser's own frame clock is kept
// here for pacing input at the rate a touchscreen would deliver it.
(() => {
  'use strict';

  const params = new URLSearchParams(location.search);
  const mode = params.get('stress');
  if (!mode) return;

  const nativeRaf = window.requestAnimationFrame.bind(window);
  const inputHz = Number(params.get('inputhz')) || 60;

  const view = () => document.querySelector('flutter-view') || document.querySelector('flt-glass-pane');
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // With ?log=<url>, say how much input is going in, so a run that measures
  // no frames can be told apart from one that drove no input.
  const log = params.get('log');
  let sent = 0;
  if (log) {
    let last = 0;
    setInterval(() => {
      const rate = sent - last;
      last = sent;
      navigator.sendBeacon(log, JSON.stringify({
        run: params.get('run'), name: `stress:${mode} events`, rate, p50: 0, p10: 0, p90: 0,
        note: view() ? null : 'no flutter view found',
      }));
    }, 1000);
  }

  // Paces callbacks with the browser's own clock, which is what a real
  // touchscreen is tied to, thinned to inputHz if that is slower.
  const everyFrame = (fn) => {
    let last = 0;
    const step = (time) => {
      if (time - last >= 1000 / inputHz - 1) { last = time; fn(time); }
      nativeRaf(step);
    };
    nativeRaf(step);
  };

  const send = (type, x, y, extra = {}) => {
    const target = document.elementFromPoint(x, y) ?? view();
    if (!target) return;
    const event = new PointerEvent(type, {
      bubbles: true, cancelable: true, composed: true,
      pointerId: 1, pointerType: 'touch', isPrimary: true,
      clientX: x, clientY: y, screenX: x, screenY: y,
      buttons: type === 'pointerup' ? 0 : 1, button: type === 'pointermove' ? -1 : 0,
      pressure: type === 'pointerup' ? 0 : 0.5, width: 20, height: 20,
      ...extra,
    });
    // Flutter reads a move's coalesced events and uses only those, and an
    // event the page made itself has none, so the move would count for
    // nothing. Report the event as its own only sample.
    if (type === 'pointermove' && params.get('coalesced') !== '0') {
      Object.defineProperty(event, 'getCoalescedEvents', { value: () => [event] });
    }
    target.dispatchEvent(event);
    sent++;
  };

  const start = async () => {
    const centre = () => [Math.round(innerWidth / 2), Math.round(innerHeight / 2)];

    if (mode === 'wheel') {
      let direction = 1, travelled = 0;
      everyFrame(() => {
        const [x, y] = centre();
        const target = document.elementFromPoint(x, y) ?? view();
        target?.dispatchEvent(new WheelEvent('wheel', {
          bubbles: true, cancelable: true, composed: true,
          clientX: x, clientY: y, deltaY: 24 * direction, deltaMode: 0,
        }));
        travelled += 24;
        if (travelled > 1200) { travelled = 0; direction = -direction; }
      });
      return;
    }

    if (mode === 'drag') {
      // A slow, steady drag: every frame moves the same small distance, which
      // is what makes uneven frame pacing visible.
      const [x] = centre();
      let y = innerHeight * 0.75, direction = -1;
      const step = Number(params.get('dragpx')) || 6;
      send('pointerdown', x, y);
      everyFrame(() => {
        y += step * direction;
        if (y < innerHeight * 0.25 || y > innerHeight * 0.75) direction = -direction;
        send('pointermove', x, y);
      });
      return;
    }

    // fling: drag fast, let go, and leave the scroll physics to animate it out.
    for (;;) {
      const [x] = centre();
      const from = innerHeight * 0.75, to = innerHeight * 0.3;
      let y = from;
      send('pointerdown', x, y);
      await new Promise((done) => {
        let last = 0;
        const step = (time) => {
          if (time - last >= 1000 / inputHz - 1) {
            last = time;
            y -= (from - to) / 8; // eight moves to cover the drag: a fast flick
            send('pointermove', x, Math.round(y));
            if (y <= to) { send('pointerup', x, Math.round(y)); done(); return; }
          }
          nativeRaf(step);
        };
        nativeRaf(step);
      });
      await sleep(1400); // the fling animates, and is what gets measured
    }
  };

  // Wait for Flutter's view, then give the first screen a moment to settle.
  const waitForView = async () => {
    for (let i = 0; i < 200 && !view(); i++) await sleep(100);
    if (!view()) return;
    await sleep(1500);
    start();
  };
  waitForView();
})();
