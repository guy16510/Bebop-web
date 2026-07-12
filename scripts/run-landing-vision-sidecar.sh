#!/usr/bin/env bash
set -euo pipefail

IMAGE_NAME=${PERCEPTION_IMAGE:-bebop-perception-sidecar:local}
VIDEO_URL=${LANDING_VISION_VIDEO_URL:-http://host.docker.internal:${PORT:-3000}/video.mjpeg}

exec docker run --rm \
  --add-host host.docker.internal:host-gateway \
  --entrypoint python3 \
  -e LANDING_VISION_VIDEO_URL="$VIDEO_URL" \
  -e LANDING_VISION_OUTPUT_HZ="${LANDING_VISION_OUTPUT_HZ:-12}" \
  -e LANDING_VISION_RECONNECT_MS="${LANDING_VISION_RECONNECT_MS:-300}" \
  -e APRILTAG_EVERY_N_FRAMES="${APRILTAG_EVERY_N_FRAMES:-2}" \
  "$IMAGE_NAME" \
  /work/perception-sidecar/scripts/apriltag_stream.py
