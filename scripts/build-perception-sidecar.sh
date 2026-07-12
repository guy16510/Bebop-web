#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
IMAGE_NAME=${PERCEPTION_IMAGE:-bebop-perception-sidecar:local}

docker build \
  --file "$ROOT_DIR/perception-sidecar/Dockerfile" \
  --tag "$IMAGE_NAME" \
  "$ROOT_DIR"

docker run --rm "$IMAGE_NAME" --self-test >/tmp/bebop-perception-sidecar-self-test.json
grep -q 'perception.snapshot' /tmp/bebop-perception-sidecar-self-test.json
echo "Built and self-tested $IMAGE_NAME"
