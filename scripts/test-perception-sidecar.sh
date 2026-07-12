#!/usr/bin/env bash
set -euo pipefail

IMAGE_NAME=${PERCEPTION_IMAGE:-bebop-perception-sidecar:local}
TMP_DIR=$(mktemp -d)
trap 'rm -rf "$TMP_DIR"' EXIT

docker run --rm "$IMAGE_NAME" --self-test > "$TMP_DIR/protocol.json"
docker run --rm \
  --entrypoint /usr/local/bin/bebop-perception-engine-self-test \
  -e ORB_SETTINGS=/config/bebop2.example.yaml \
  "$IMAGE_NAME" > "$TMP_DIR/engines.json"

python3 - "$TMP_DIR/protocol.json" "$TMP_DIR/engines.json" <<'PY'
import json
import sys
from pathlib import Path

protocol = json.loads(Path(sys.argv[1]).read_text())
engines = json.loads(Path(sys.argv[2]).read_text())

snapshot = protocol['snapshot']
assert protocol['type'] == 'perception.snapshot'
assert snapshot['backend'] == 'external'
assert snapshot['trackingState'] == 'tracking'
assert engines['ok'] is True
assert engines['orbSlam3']['systemConstructed'] is True
assert engines['orbSlam3']['framesSubmitted'] == 120
assert engines['orbSlam3']['trackingReached'] is True
assert engines['orbSlam3']['maxTrackedPoints'] > 0
assert engines['orbSlam3']['maxTrackedFeatures'] >= 40
assert engines['yolox']['modelLoaded'] is True
assert engines['yolox']['inferenceExecuted'] is True
assert engines['yolox']['outputElements'] > 0

print(json.dumps({
    'ok': True,
    'source': snapshot['source'],
    'framesSubmitted': engines['orbSlam3']['framesSubmitted'],
    'maxTrackedPoints': engines['orbSlam3']['maxTrackedPoints'],
    'maxTrackedFeatures': engines['orbSlam3']['maxTrackedFeatures'],
    'yoloxOutputElements': engines['yolox']['outputElements'],
}, indent=2))
PY
