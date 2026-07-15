#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
IMAGE_NAME=${PERCEPTION_IMAGE:-bebop-perception-sidecar:local}
CALIBRATION_FILE=${PERCEPTION_CALIBRATION_FILE:-config/perception/bebop2-upstream-428x240.yaml}
YOLOX_MODEL_PATH=/models/yolox_tiny.onnx
if [[ "${RECOGNITION_ENABLED:-true}" == "true" ]]; then
  YOLOX_MODEL_PATH=/models/disabled-in-slam-sidecar.onnx
fi

if [[ "$CALIBRATION_FILE" != /* ]]; then
  CALIBRATION_FILE="$ROOT_DIR/$CALIBRATION_FILE"
fi

if [[ ! -s "$CALIBRATION_FILE" ]]; then
  echo "Missing camera calibration: $CALIBRATION_FILE" >&2
  echo "Use config/perception/bebop2-upstream-428x240.yaml or run scripts/calibrate-bebop-camera.py." >&2
  exit 65
fi

exec docker run --rm -i \
  --add-host host.docker.internal:host-gateway \
  -e PERCEPTION_CAMERA_CALIBRATED=true \
  -e PERCEPTION_OUTPUT_HZ="${PERCEPTION_OUTPUT_HZ:-10}" \
  -e DETECTION_EVERY_N_FRAMES="${DETECTION_EVERY_N_FRAMES:-3}" \
  -e YOLOX_CONFIDENCE="${YOLOX_CONFIDENCE:-0.35}" \
  -e YOLOX_MODEL="$YOLOX_MODEL_PATH" \
  -e OBJECT_POSITION_ESTIMATE="${OBJECT_POSITION_ESTIMATE:-false}" \
  -v "$CALIBRATION_FILE:/config/bebop2.yaml:ro" \
  "$IMAGE_NAME"
