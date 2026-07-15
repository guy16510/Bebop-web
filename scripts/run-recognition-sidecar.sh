#!/usr/bin/env bash
set -euo pipefail

IMAGE_NAME=${PERCEPTION_IMAGE:-bebop-perception-sidecar:local}
VIDEO_URL=${RECOGNITION_VIDEO_URL:-http://host.docker.internal:${PORT:-3000}/video.mjpeg}

exec docker run --rm \
  --add-host host.docker.internal:host-gateway \
  -e RECOGNITION_VIDEO_URL="$VIDEO_URL" \
  -e RECOGNITION_OUTPUT_HZ="${RECOGNITION_OUTPUT_HZ:-10}" \
  -e RECOGNITION_EVERY_N_FRAMES="${RECOGNITION_EVERY_N_FRAMES:-2}" \
  -e RECOGNITION_RECONNECT_MS="${RECOGNITION_RECONNECT_MS:-300}" \
  -e RECOGNITION_TRACK_MAX_MISSES="${RECOGNITION_TRACK_MAX_MISSES:-12}" \
  -e YOLOX_CONFIDENCE="${YOLOX_CONFIDENCE:-0.35}" \
  -e YOLOX_LOW_CONFIDENCE="${YOLOX_LOW_CONFIDENCE:-0.20}" \
  "$IMAGE_NAME" \
  python3 /work/perception-sidecar/scripts/recognition_stream.py
