#!/usr/bin/env bash
set -euo pipefail

FILE="${1:-}"
if [[ -z "$FILE" || ! -f "$FILE" ]]; then
  echo "Usage: npm run video:inspect -- captures/file.h264" >&2
  exit 1
fi

GST_LAUNCH_BIN="${GST_LAUNCH_BIN:-gst-launch-1.0}"

exec "$GST_LAUNCH_BIN" -v \
  filesrc location="$FILE" \
  ! h264parse \
  ! avdec_h264 \
  ! fpsdisplaysink video-sink=fakesink text-overlay=false sync=false
