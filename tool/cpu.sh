#!/bin/sh
# How much processor time a browser's page spends over a few seconds: the
# busiest web content process, measured as the CPU time it actually used, not
# the lifetime average that ps prints by default.
#
#   tool/cpu.sh [seconds] [process name]
#
# Run it while a page is animating. The number is the share of one core.
seconds=${1:-5}
match=${2:-WebKit.WebContent}

snapshot() {
  ps -A -o pid=,time=,comm= | grep "$match" | awk '{ split($2, t, ":"); print $1, (t[1] * 60) + t[2] }'
}

before=$(snapshot)
sleep "$seconds"
after=$(snapshot)

echo "$before" | while read -r pid start; do
  end=$(echo "$after" | awk -v p="$pid" '$1 == p { print $2 }')
  [ -n "$end" ] || continue
  awk -v s="$start" -v e="$end" -v w="$seconds" -v p="$pid" \
    'BEGIN { used = e - s; if (used > 0.05) printf "  pid %s: %.0f%% of one core (%.2fs of CPU in %ss)\n", p, used / w * 100, used, w }'
done | sort -t: -k2 -rn | head -3
