#!/usr/bin/env python3
"""Serves the demo site locally, or exports it as static files for hosting.

    python3 tool/serve.py                  # http://localhost:8800
    python3 tool/serve.py --host 0.0.0.0   # also reachable from your network
    python3 tool/serve.py --export site    # static folder for GitHub Pages or any web server

Site layout (the same whether served or exported):
  index.html            the examples, each with Before and After links
  probe/                clock probe for any phone or browser (no Flutter)
  <id>/app/             the example's build, shared by both pages below
  <id>/before/          the example as it ships
  <id>/after/           the same build with flutter_shim.js added
  flutter_shim.js       the shim

The before and after pages differ by one script tag; every other file is the
shared build in <id>/app/. All links are relative, so the site works under any
sub-path (https://you.github.io/flutter_shim/, https://example.com/demo/, ...).

Query parameters on an example page:
  renderer=skwasm-st | skwasm | canvaskit   Flutter renderer to use
  hud=0                                     hide the frame-rate badge
  anyplatform                               run the shim outside Android Chrome

This server sends cross-origin isolation headers, so multi-threaded skwasm is
available. GitHub Pages can't send them, so there skwasm runs single-threaded,
which is what Flutter stable needs for now anyway (see README).
"""

import argparse
import http.server
import json
import os
import re
import shutil
import urllib.parse
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BUILDS = ROOT / 'build' / 'examples'
SITE = ROOT / 'site'
SHIM = ROOT / 'web' / 'flutter_shim.js'
VARIANTS = ('before', 'after')
TYPES = {'.wasm': 'application/wasm', '.mjs': 'text/javascript', '.js': 'text/javascript',
         '.json': 'application/json', '.html': 'text/html; charset=utf-8', '.css': 'text/css',
         '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ttf': 'font/ttf', '.otf': 'font/otf'}


def examples():
    listed = json.loads((ROOT / 'examples' / 'examples.json').read_text())
    keys = ('id', 'title', 'description', 'start', 'note', 'wasm')
    return [{**{k: e.get(k) for k in keys}, 'built': (BUILDS / e['id'] / 'index.html').exists()} for e in listed]


def use_demo_loader(text):
    # Route Flutter's loader through site/demo.js, which applies ?renderer=.
    return text.replace('_flutter.loader.load(', 'flutterShimDemo.load(')


def variant_page(example_id, variant):
    """<id>/<variant>/index.html: the build's page, loading everything from ../app/."""
    html = (BUILDS / example_id / 'index.html').read_text()
    html = re.sub(r'<base href="[^"]*">', '<base href="../app/">', html, count=1)
    # Relative to the base, ../../ is the site root.
    tags = ['<script src="../../demo.js"></script>']
    if variant == 'after':
        tags.append('<script src="../../flutter_shim.js"></script>')
    tags.append(f'<script src="../../hud.js" data-variant="{variant}" defer></script>')
    block = '\n  '.join(tags) + '\n  '
    i = html.find('<script')
    html = html[:i] + block + html[i:] if i >= 0 else html.replace('</body>', block + '</body>')
    return use_demo_loader(html)


def resolve(path):
    """Maps a URL path to ('file', Path) | ('bytes', bytes, suffix) | ('redirect', path) | None."""
    parts = [p for p in path.split('/') if p]
    if parts == ['apps.json']:
        return ('bytes', json.dumps(examples()).encode(), '.json')
    if parts == ['flutter_shim.js']:
        return ('file', SHIM)
    ids = {e['id'] for e in examples() if e['built']}
    if parts and parts[0] in ids:
        if len(parts) == 1:
            return ('redirect', f'/{parts[0]}/after/')
        if parts[1] in VARIANTS and parts[2:] in ([], ['index.html']):
            if len(parts) == 2 and not path.endswith('/'):
                return ('redirect', path + '/')
            return ('bytes', variant_page(parts[0], parts[1]).encode(), '.html')
        if parts[1] == 'app' and len(parts) > 2:
            build = (BUILDS / parts[0]).resolve()
            file = (build / '/'.join(parts[2:])).resolve()
            if build not in file.parents or not file.is_file():
                return None
            if file.name == 'flutter_bootstrap.js':
                return ('bytes', use_demo_loader(file.read_text()).encode(), '.js')
            return ('file', file)
        return None
    file = (SITE / '/'.join(parts)).resolve()
    if file.is_dir():
        if parts and not path.endswith('/'):
            return ('redirect', path + '/')
        file = file / 'index.html'
    site = SITE.resolve()
    if (file.parent == site or site in file.parents) and file.is_file():
        return ('file', file)
    return None


class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        url = urllib.parse.urlparse(self.path)
        found = resolve(url.path)
        if found is None:
            self.send_error(404)
            return
        if found[0] == 'redirect':
            self.send_response(301)
            self.send_header('Location', found[1] + (f'?{url.query}' if url.query else ''))
            self.end_headers()
            return
        body, suffix = (found[1].read_bytes(), found[1].suffix) if found[0] == 'file' else found[1:]
        self.send_response(200)
        self.send_header('Content-Type', TYPES.get(suffix, 'application/octet-stream'))
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        # Cross-origin isolation, for multi-threaded skwasm.
        self.send_header('Cross-Origin-Opener-Policy', 'same-origin')
        self.send_header('Cross-Origin-Embedder-Policy', 'credentialless')
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


def export(out):
    """Writes the site as static files under `out`."""
    out = Path(out).resolve()
    if out.exists():
        shutil.rmtree(out)
    shutil.copytree(SITE, out)
    shutil.copy(SHIM, out / 'flutter_shim.js')
    (out / 'apps.json').write_text(json.dumps(examples()))
    (out / '.nojekyll').write_text('')  # GitHub Pages: serve files as they are
    for example in examples():
        if not example['built']:
            continue
        build = BUILDS / example['id']
        for file in build.rglob('*'):
            if not file.is_file():
                continue
            target = out / example['id'] / 'app' / file.relative_to(build)
            target.parent.mkdir(parents=True, exist_ok=True)
            if file.name == 'flutter_bootstrap.js':
                target.write_text(use_demo_loader(file.read_text()))
                continue
            try:
                os.link(file, target)  # hard link: no extra disk space
            except OSError:
                shutil.copy2(file, target)
        for variant in VARIANTS:
            page = out / example['id'] / variant / 'index.html'
            page.parent.mkdir(parents=True, exist_ok=True)
            page.write_text(variant_page(example['id'], variant))
    size = sum(f.stat().st_size for f in out.rglob('*') if f.is_file()) / 1e6
    print(f'Exported to {out} ({size:.0f} MB). Publish that folder as-is; see README, "Hosting".')


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--port', type=int, default=8800)
    parser.add_argument('--host', default='127.0.0.1', help='0.0.0.0 to allow other devices on your network')
    parser.add_argument('--export', metavar='DIR', help='write the site as static files instead of serving it')
    args = parser.parse_args()
    if args.export:
        export(args.export)
        return
    built = [e['id'] for e in examples() if e['built']]
    if not built:
        print('No examples built yet: run python3 tool/setup.py first.')
    print(f'Serving on http://localhost:{args.port}  (built: {", ".join(built) or "none"})')
    print(f'Android phone over adb: adb reverse tcp:{args.port} tcp:{args.port}, then open the same URL in Chrome.')
    http.server.ThreadingHTTPServer((args.host, args.port), Handler).serve_forever()


if __name__ == '__main__':
    main()
