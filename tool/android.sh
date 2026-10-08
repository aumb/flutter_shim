#!/bin/sh
# Opens the demo in Chrome on an Android phone connected with adb (USB or
# wireless debugging), with the local server's port forwarded to the phone.
#   tool/android.sh                 # the index
#   tool/android.sh list/after/     # a page
PORT=${PORT:-8800}
adb reverse tcp:$PORT tcp:$PORT >/dev/null || exit 1
adb forward tcp:9222 localabstract:chrome_devtools_remote >/dev/null  # for tool/measure.mjs
adb shell am start -a android.intent.action.VIEW -d "'http://localhost:$PORT/${1:-}'" -p com.android.chrome >/dev/null
echo "Opened http://localhost:$PORT/${1:-} on the phone."
