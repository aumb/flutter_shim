// The badge on every example page: which version is running and how many
// frames per second reach the screen. Tap it to switch between Before and
// After on the same screen. Hide it with ?hud=0.
(() => {
  const params = new URLSearchParams(location.search);
  if (params.get('hud') === '0') return;
  const variant = document.currentScript?.dataset.variant ?? 'before';
  const other = variant === 'after' ? 'before' : 'after';

  // Frames drawn: on the normal path Flutter calls transferFromImageBitmap on
  // the page; with the shim active, the shim counts the frames it forwards.
  let drawn = 0;
  const proto = window.ImageBitmapRenderingContext?.prototype;
  if (proto) {
    const original = proto.transferFromImageBitmap;
    proto.transferFromImageBitmap = function (bitmap) {
      if (bitmap) drawn++;
      return original.call(this, bitmap);
    };
  }
  const frames = () => drawn + (window.flutterShim?.frames ?? 0);

  const badge = document.createElement('a');
  badge.href = '#';
  badge.setAttribute('aria-label', `Switch to ${other}`);
  badge.style.cssText = [
    'position:fixed', 'z-index:2147483647', 'top:calc(env(safe-area-inset-top) + 8px)', 'right:8px',
    'display:flex', 'align-items:center', 'gap:6px', 'padding:5px 10px', 'border-radius:999px',
    'background:rgba(12,12,14,.78)', 'color:#fff', 'text-decoration:none',
    'font:600 12px/1.2 system-ui,-apple-system,sans-serif', 'font-variant-numeric:tabular-nums',
    'box-shadow:0 1px 4px rgba(0,0,0,.3)', '-webkit-tap-highlight-color:transparent',
  ].join(';');
  const dot = document.createElement('span');
  dot.style.cssText = `width:8px;height:8px;border-radius:50%;background:${variant === 'after' ? '#4ade80' : '#fbbf24'}`;
  const label = document.createElement('span');
  label.textContent = variant === 'after' ? 'After' : 'Before';
  badge.append(dot, label);
  badge.addEventListener('click', (event) => {
    event.preventDefault();
    location.href = `../${other}/${location.search}${location.hash}`;
  });
  document.body.append(badge);

  let lastFrames = frames(), lastTime = performance.now();
  setInterval(() => {
    const now = performance.now(), count = frames();
    const fps = Math.round(((count - lastFrames) * 1000) / (now - lastTime));
    lastFrames = count;
    lastTime = now;
    const name = variant === 'after' ? 'After' : 'Before';
    const off = variant === 'after' && !window.flutterShim?.active ? ' · shim off' : '';
    label.textContent = `${name} · ${fps ? `${fps} fps` : 'idle'}${off}`;
  }, 500);
})();
