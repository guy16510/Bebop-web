#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
IMAGE_NAME=${PERCEPTION_IMAGE:-bebop-perception-sidecar:local}
CALIBRATION_FILE=${PERCEPTION_CALIBRATION_FILE:-$ROOT_DIR/config/perception/bebop2.yaml}

if [[ ! -s "$CALIBRATION_FILE" ]]; then
  echo "Missing measured camera calibration: $CALIBRATION_FILE" >&2
  echo "Run scripts/calibrate-bebop-camera.py before starting real perception." >&2
  exit 65
fi

exec docker run --rm -i \
  --name bebop-perception-sidecar \
  --add-host host.docker.internal:host-gateway \
  -e PERCEPTION_CAMERA_CALIBRATED=true \
  -e PERCEPTION_OUTPUT_HZ="${PERCEPTION_OUTPUT_HZ:-10}" \
  -e DETECTION_EVERY_N_FRAMES="${DETECTION_EVERY_N_FRAMES:-3}" \
  -e YOLOX_CONFIDENCE="${YOLOX_CONFIDENCE:-0.35}" \
  -e OBJECT_POSITION_ESTIMATE="${OBJECT_POSITION_ESTIMATE:-false}" \
  -v "$CALIBRATION_FILE:/config/bebop2.yaml:ro" \
  "$IMAGE_NAME"
