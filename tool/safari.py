#!/usr/bin/env python3
"""Runs a probe page in Safari and prints what it measured.

    python3 tool/safari.py                       # the clock battery
    python3 tool/safari.py --url /probe/         # any page on the demo site
    python3 tool/safari.py --seconds 5           # longer measuring windows

Safari can't be driven from the outside the way Chrome can, so the page
reports its own numbers: this script serves the demo site, opens the page in
Safari with ?log=<this server>/log, and prints each measurement the page
beacons back. Safari is brought to the front because a background tab is
throttled; keep the window visible until the script says it is done.

The display matters as much as the browser: on a Mac with ProMotion, check
that System Settings > Displays is set to ProMotion (not a fixed 60 Hz) and
that Low Power Mode is off, or everything measures 60.
"""

import argparse
import http.server
import json
import subprocess
import sys
import threading
import time
import urllib.parse
import uuid

import serve  # same folder


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--url', default='/clocks/', help='page to open (default: the clock battery)')
    parser.add_argument('--seconds', type=int, default=3, help='measuring window per clock')
    parser.add_argument('--port', type=int, default=8801)
    parser.add_argument('--timeout', type=float, default=120, help='give up waiting for results')
    parser.add_argument('--browser', default='Safari', help='application to open the page in')
    parser.add_argument('--json', action='store_true', help='print the raw beacons instead of a table')
    args = parser.parse_args()

    run = uuid.uuid4().hex[:8]
    received, done = [], threading.Event()

    class Handler(serve.Handler):
        def do_POST(self):
            if urllib.parse.urlparse(self.path).path != '/log':
                self.send_error(404)
                return
            body = self.rfile.read(int(self.headers.get('Content-Length') or 0))
            self.send_response(204)
            self.send_header('Content-Length', '0')
            self.end_headers()
            try:
                message = json.loads(body)
            except ValueError:
                return
            if message.get('run') != run:
                return  # a page left open from an earlier run
            if message.get('name') == 'done':
                print(f"\n{message.get('verdict', '')}")
                done.set()
                return
            received.append(message)
            if args.json:
                print(json.dumps(message), flush=True)
                return
            # Pages beacon whatever they measure, so only a name and a rate
            # are assumed here.
            name = str(message.get('name') or message.get('test') or 'result')
            rate = message.get('rate') or 0
            spread = ''
            if rate and message.get('p50') is not None:
                spread = 'p50 %.2f ms (%.2f-%.2f)' % (message['p50'], message.get('p10', 0), message.get('p90', 0))
            print(f"  {name:<58} {rate:>6.1f}/s  {spread or message.get('note') or ''}", flush=True)

    server = http.server.ThreadingHTTPServer(('127.0.0.1', args.port), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()

    # The examples open on a screen of their own, given as a fragment, so the
    # query this adds has to go in front of it.
    page, _, fragment = args.url.partition('#')
    join = '&' if '?' in page else '?'
    query = f'{join}log=http://127.0.0.1:{args.port}/log&run={run}&seconds={args.seconds}'
    url = f'http://127.0.0.1:{args.port}{page}{query}{"#" + fragment if fragment else ""}'
    print(f'Opening in {args.browser}: {url}')
    print('Keep the window in front; measuring…\n')
    subprocess.run(['open', '-a', args.browser, url], check=True)

    deadline = time.time() + args.timeout
    while not done.is_set() and time.time() < deadline:
        done.wait(0.5)
    if not done.is_set():
        print(f'\nNo "done" after {args.timeout:.0f}s; {len(received)} result(s) above.', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
