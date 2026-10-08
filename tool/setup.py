#!/usr/bin/env python3
"""Fetches and builds the example apps.

    python3 tool/setup.py                  # all examples
    python3 tool/setup.py list wonderous   # some of them
    python3 tool/setup.py --flutter ~/flutter-master/bin/flutter

Each app is built once, unmodified apart from the fixes below, into
build/examples/<id>/. tool/serve.py then serves it twice: as it is ("before")
and with the shim ("after").

Third-party apps are cloned at the commit pinned in examples/examples.json into
.cache/examples/<id>/, so their source isn't copied into this repo.
"""

import argparse
import json
import re
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CACHE = ROOT / '.cache' / 'examples'
OUT = ROOT / 'build' / 'examples'


def run(cmd, cwd):
    print('  $', ' '.join(str(c) for c in cmd), flush=True)
    subprocess.run(cmd, cwd=cwd, check=True)


def edit(path, change):
    text = path.read_text()
    new = change(text)
    if new != text:
        path.write_text(new)


def fetch(example):
    """Clones the example's repo at its pinned commit; returns the app's directory."""
    repo_dir = CACHE / example['id']
    if not (repo_dir / '.git').exists():
        run(['git', 'clone', '--filter=blob:none', '--no-checkout', example['repo'], repo_dir], ROOT)
        if example.get('sparse'):
            run(['git', 'sparse-checkout', 'set', *example['sparse']], repo_dir)
    run(['git', 'checkout', '--force', example['commit']], repo_dir)
    return repo_dir / example['path']


# Fixes that let older apps build with current Flutter. Each runs on a fresh
# checkout and is safe to run again.

def fix_material_3_demo(app):
    # The samples repo is a pub workspace; build this one sample on its own.
    edit(app / 'pubspec.yaml', lambda s: s.replace('resolution: workspace\n', ''))


def fix_gallery(app):
    # Localizations: Flutter no longer generates the synthetic flutter_gen
    # package, so generate them into lib/ and import them from there.
    edit(app / 'l10n.yaml', lambda s: s if 'output-dir:' in s else s + 'output-dir: lib/gen_l10n\n')
    for dart in list((app / 'lib').rglob('*.dart')) + list((app / 'test').rglob('*.dart')):
        edit(dart, lambda s: s.replace('package:flutter_gen/gen_l10n/', 'package:gallery/gen_l10n/')
             .replace('BottomAppBarTheme(', 'BottomAppBarThemeData(')
             .replace('GoogleFonts.robotoCondensed(', 'GoogleFonts.roboto('))
    # google_fonts 6.1 no longer compiles; 9.0 needs a newer Flutter.
    edit(app / 'pubspec.yaml', lambda s: re.sub(r'(?m)^  google_fonts: .*$', '  google_fonts: 8.2.1', s))
    # Its page used the old loader API and included analytics.
    shutil.copy(ROOT / 'examples' / 'gallery' / 'index.html', app / 'web' / 'index.html')


FIXES = {'material_3_demo': fix_material_3_demo, 'gallery': fix_gallery}


def build(example, flutter):
    print(f"\n== {example['title']} ({example['id']})", flush=True)
    app = ROOT / example['local'] if 'local' in example else fetch(example)
    if example['id'] in FIXES:
        FIXES[example['id']](app)
    out = OUT / example['id']
    run([flutter, 'pub', 'get'], app)
    run([flutter, 'build', 'web', '--release', *(['--wasm'] if example['wasm'] else []), '--output', out], app)


def main():
    examples = json.loads((ROOT / 'examples' / 'examples.json').read_text())
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('ids', nargs='*', help=f"examples to build (default: all of {', '.join(e['id'] for e in examples)})")
    parser.add_argument('--flutter', default='flutter', help='flutter executable to build with')
    args = parser.parse_args()

    unknown = set(args.ids) - {e['id'] for e in examples}
    if unknown:
        sys.exit(f"Unknown example: {', '.join(sorted(unknown))}")
    failed = []
    for example in examples:
        if args.ids and example['id'] not in args.ids:
            continue
        try:
            build(example, args.flutter)
        except subprocess.CalledProcessError:
            failed.append(example['id'])
    print('\nBuilt into', OUT.relative_to(ROOT))
    if failed:
        sys.exit(f"Failed: {', '.join(failed)}")
    print('Next: python3 tool/serve.py')


if __name__ == '__main__':
    main()
