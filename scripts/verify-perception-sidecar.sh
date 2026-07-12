#!/usr/bin/env bash
set -euo pipefail

IMAGE_NAME=${PERCEPTION_IMAGE:-bebop-perception-sidecar:local}
WORK_DIR=$(mktemp -d "${TMPDIR:-/tmp}/bebop-perception-verify.XXXXXX")
trap 'rm -rf "$WORK_DIR"' EXIT

mkdir -p "$WORK_DIR/replay"

docker run --rm "$IMAGE_NAME" --self-test > "$WORK_DIR/sidecar-self-test.json"

docker run --rm \
  --entrypoint /usr/local/bin/bebop-perception-engine-self-test \
  -e ORB_SETTINGS=/config/bebop2.example.yaml \
  -e SYNTHETIC_VIDEO_OUT=/replay/synthetic.avi \
  -v "$WORK_DIR/replay:/replay" \
  "$IMAGE_NAME" > "$WORK_DIR/engine-self-test.json"

cat > "$WORK_DIR/replay/start.ndjson" <<'EOF'
{"type":"start","protocolVersion":1,"videoUrl":"/replay/synthetic.avi","stateUrl":"","slam":{"library":"ORB-SLAM3","sensorMode":"monocular","cameraModel":"pinhole","requireCalibration":true},"detector":{"runtime":"OpenCV DNN","modelFamily":"YOLOX"}}
EOF

docker run --rm -i \
  --entrypoint /usr/local/bin/bebop-perception-sidecar \
  -e ORB_SETTINGS=/config/bebop2.example.yaml \
  -e PERCEPTION_CAMERA_CALIBRATED=true \
  -e PERCEPTION_OUTPUT_HZ=30 \
  -e DETECTION_EVERY_N_FRAMES=10 \
  -v "$WORK_DIR/replay:/replay:ro" \
  "$IMAGE_NAME" \
  < "$WORK_DIR/replay/start.ndjson" \
  > "$WORK_DIR/production-replay.ndjson"

python3 - "$WORK_DIR" <<'PY'
import json
import sys
from pathlib import Path

root = Path(sys.argv[1])
protocol = json.loads((root / 'sidecar-self-test.json').read_text())
assert protocol['type'] == 'perception.snapshot'
snapshot = protocol['snapshot']
assert snapshot['backend'] == 'external'
assert snapshot['trackingState'] == 'tracking'
assert snapshot['calibrated'] is True

engines = json.loads((root / 'engine-self-test.json').read_text())
assert engines['ok'] is True
assert engines['orbSlam3']['vocabularyLoaded'] is True
assert engines['orbSlam3']['systemConstructed'] is True
assert engines['orbSlam3']['framesSubmitted'] == 120
assert engines['orbSlam3']['trackingReached'] is True
assert engines['orbSlam3']['maxTrackedPoints'] > 0
assert engines['orbSlam3']['maxTrackedFeatures'] >= 40
assert engines['orbSlam3']['syntheticVideoWritten'] is True
assert (root / 'replay' / 'synthetic.avi').stat().st_size > 0
assert engines['yolox']['modelLoaded'] is True
assert engines['yolox']['inferenceExecuted'] is True
assert engines['yolox']['outputElements'] > 0

replay = [
    json.loads(line)['snapshot']
    for line in (root / 'production-replay.ndjson').read_text().splitlines()
    if line.strip()
]
assert len(replay) >= 3
assert all(item['backend'] == 'external' for item in replay)
assert all(item['calibrated'] is True for item in replay)
assert any(item['trackingState'] == 'tracking' for item in replay)
assert max(len(item['trajectory']) for item in replay) >= 5
assert max(len(item['map']['landmarks']) for item in replay) > 0
assert max(item['metrics']['trackedFeatures'] for item in replay) >= 40
assert any(item['metrics']['inferenceMs'] > 0 for item in replay)
assert any('yolox' in item['source'] for item in replay)

print(json.dumps({
    'ok': True,
    'framesSubmitted': engines['orbSlam3']['framesSubmitted'],
    'maxLandmarks': max(len(item['map']['landmarks']) for item in replay),
    'maxTrajectory': max(len(item['trajectory']) for item in replay),
    'maxTrackedFeatures': max(item['metrics']['trackedFeatures'] for item in replay),
    'yoloxOutputElements': engines['yolox']['outputElements'],
    'productionSnapshots': len(replay),
}))
PY
