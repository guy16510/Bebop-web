#!/usr/bin/env bash
set -euo pipefail

if [[ "${1:-}" == "--self-test" ]]; then
  exec /usr/local/bin/bebop-perception-sidecar --self-test
fi

if [[ ! -s "${ORB_VOCABULARY:-/opt/ORB_SLAM3/Vocabulary/ORBvoc.txt}" ]]; then
  echo "ORB-SLAM3 vocabulary is missing" >&2
  exit 64
fi

if [[ ! -s "${ORB_SETTINGS:-/config/bebop2.yaml}" ]]; then
  cat >&2 <<'EOF'
The calibrated Bebop camera settings file is missing.
Mount it at /config/bebop2.yaml or set ORB_SETTINGS to its path.
Use scripts/calibrate-bebop-camera.py to create it from the exact MJPEG stream resolution and crop used by the sidecar.
EOF
  exit 65
fi

exec /usr/local/bin/bebop-perception-sidecar "$@"
