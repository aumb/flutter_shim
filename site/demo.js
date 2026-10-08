// Loaded first on every example page (added by tool/serve.py, before Flutter).
//  - ?renderer=skwasm-st | skwasm | canvaskit picks Flutter's renderer, if the
//    build has it.
//  - ?anyplatform lets flutter_shim.js run outside Android Chrome, for
//    experiments such as desktop Chrome with its 60 Hz limit switched on.
//  - Flutter's deprecated service worker is skipped, so switching between
//    builds never serves stale files.
(() => {
  const params = new URLSearchParams(location.search);
  if (params.has('anyplatform')) window.flutterShimConfig = { anyPlatform: true };

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
