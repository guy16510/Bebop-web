# Bebop Web

A local Node.js control, video, perception, and mapping console for the Parrot Bebop 2.

## Current status

Implemented:

- TypeScript Node.js server
- WebSocket flight-control API
- fixed-rate 20 Hz command scheduler
- 250 ms stale-input watchdog
- single-browser pilot ownership
- keyboard and dashboard flight controls
- telemetry and height display
- deterministic drone and perception simulation
- initial `node-bebop` adapter
- direct MJPEG browser preview
- latest-frame-only fanout for slow browser clients
- raw H.264 capture and GStreamer diagnostics
- server-enforced arm window and takeoff gating
- telemetry freshness, battery, and altitude safety policy
- supervised external perception process protocol
- native ORB-SLAM3 monocular fisheye sidecar
- YOLOX-Tiny ONNX object detection through OpenCV DNN
- persistent detection track IDs
- camera pose, trajectory, sparse landmarks, and loop-change output
- interactive SVG map with pan, zoom, fit, follow, layers, tooltips, and export
- camera calibration utility and hard calibration gate
- Docker build and linked-native self-test in GitHub Actions

Still requires physical validation:

- measured calibration of the exact stabilized Bebop video stream
- recorded-flight drift, relocalization, and loop-closure evaluation
- hardware-tested telemetry event mapping
- measured perception CPU impact and glass-to-glass latency
- WebRTC browser delivery
- hold-to-confirm emergency control

## Requirements

- Node.js 20 or newer
- npm
- Docker for real ORB-SLAM3 and YOLOX processing
- Python 3 for camera calibration
- FFmpeg for MJPEG conversion
- optional GStreamer diagnostics: `gst-launch-1.0`, `h264parse`, and `avdec_h264`
- for real drone mode, a computer connected to the Bebop 2 Wi-Fi network

## Run the safe simulation

```bash
cp .env.example .env
npm install
npm run dev
```

Open `http://localhost:3000`.

Simulation mode is the default. It starts deterministic object detection and SLAM automatically. The dashboard renders detection boxes, persistent tracks, pose, trajectory, landmarks, mapped objects, and tracking metrics.

Run all Node-side checks:

```bash
npm run typecheck
npm run check:client
npm test
npm run perception:smoke
```

`perception:smoke` builds the application, launches a separate external mock process, validates the map and detection stream, launches the compiled server, and verifies HTTP, WebSocket lifecycle, reset, stop, restart, dashboard assets, interactive map controls, detections, landmarks, and trajectory.

## Build the real ORB-SLAM3 and YOLOX sidecar

```bash
npm run perception:sidecar:build
```

The Docker image pins ORB-SLAM3 and Pangolin, compiles the native C++ sidecar, downloads the official YOLOX-Tiny ONNX model, and executes the linked protocol self-test.

```bash
npm run perception:sidecar:self-test
```

## Calibrate the Bebop camera stream

Real perception refuses to run without a measured calibration file.

Start Bebop Web with the physical drone connected, perception disabled, and MJPEG video active. Then:

```bash
python3 -m venv .venv-calibration
source .venv-calibration/bin/activate
pip install -r perception-sidecar/requirements-calibration.txt
python3 scripts/calibrate-bebop-camera.py \
  --source http://127.0.0.1:3000/video.mjpeg \
  --board-cols 9 \
  --board-rows 6 \
  --square-size 0.024 \
  --output config/perception/bebop2.yaml
```

Use a printed chessboard with nine by six inner corners. Capture varied angles, distances, and positions across the full image. Recalibrate whenever the stream resolution, stabilization, resize, or crop changes.

## Run real perception

Set `.env`:

```dotenv
DRONE_MODE=bebop
PERCEPTION_BACKEND=external
PERCEPTION_AUTO_START=false
PERCEPTION_COMMAND=bash scripts/run-perception-sidecar.sh
PERCEPTION_VIDEO_URL=http://host.docker.internal:3000/video.mjpeg
PERCEPTION_STATE_URL=http://host.docker.internal:3000/api/state
PERCEPTION_CALIBRATION_FILE=config/perception/bebop2.yaml
```

Then:

```bash
npm run dev
```

With propellers removed:

1. Connect to the drone.
2. Start video and confirm `/api/video/health` reports frames.
3. Start perception.
4. Wait for `tracking` status.
5. Move the drone by hand and inspect the map direction, heading, trajectory, and object boxes.

Full design, protocol, calibration, and acceptance details are in [`docs/perception.md`](docs/perception.md).

## Interactive map

The dashboard map is rendered locally with SVG, without a runtime CDN dependency. It supports:

- drag to pan
- wheel or trackpad zoom around the pointer
- double-click or **Fit map** to reset
- **Follow drone** centering
- landmark, path, and mapped-object layer controls
- landmark and object tooltips
- map JSON export

Object detections always appear over the camera. The sidecar does not invent object depth by default, so an object appears on the top-down map only when a world position exists. Approximate monocular object placement can be enabled with `OBJECT_POSITION_ESTIMATE=true`.

## Keyboard controls

| Key | Action |
| --- | --- |
| W / S | Pitch forward / backward |
| A / D | Roll left / right |
| Q / E | Yaw left / right |
| R / F | Rise / descend |
| Space | Stop movement |
| Escape | Stop movement |

The browser sends desired state at 20 Hz. The server owns the actual command frequency and resets movement after 250 ms without input.

## Enforced safety behavior

Takeoff is rejected unless:

- the drone is connected
- telemetry is fresh
- the drone reports `landed`
- battery is above the configured minimum
- the operator clicked **Arm** within the active arm window

The arm state expires automatically and is consumed by successful takeoff. It is cleared on disconnect, landing, emergency, pilot disconnect, and server shutdown.

Active movement is replaced with zero when telemetry becomes stale. At the altitude ceiling, climb and lateral movement are rejected while pure descent remains available. At critical battery while airborne, the server sends one landing request and stops movement.

Safety status:

```text
GET /api/safety
```

Configuration:

```dotenv
ARM_WINDOW_MS=10000
TELEMETRY_WARNING_MS=1000
TELEMETRY_LOCKOUT_MS=3000
MINIMUM_TAKEOFF_BATTERY_PERCENT=20
CRITICAL_BATTERY_PERCENT=10
MAXIMUM_ALTITUDE_METERS=120
```

The application refuses to start if `MAXIMUM_ALTITUDE_METERS` exceeds 120 meters, approximately 394 feet. Height is relative to takeoff and is not terrain-following AGL data. These safeguards do not replace firmware limits, the original controller, airspace checks, or normal flight precautions.

## Perception endpoints

```text
GET  /api/perception/status
POST /api/perception/start
POST /api/perception/stop
POST /api/perception/reset
```

Configuration:

```dotenv
PERCEPTION_BACKEND=simulation
PERCEPTION_AUTO_START=true
PERCEPTION_COMMAND=
PERCEPTION_UPDATE_HZ=10
PERCEPTION_MAX_TRAJECTORY_POINTS=900
PERCEPTION_MAX_LANDMARKS=2500
PERCEPTION_VIDEO_URL=http://127.0.0.1:3000/video.mjpeg
PERCEPTION_STATE_URL=http://127.0.0.1:3000/api/state
```

For `DRONE_MODE=bebop`, perception defaults to `disabled`, never simulated. Set `external` and the real Docker launcher explicitly.

## Video endpoints

```text
POST /api/video/start
POST /api/video/stop
GET  /api/video/health
GET  /video.mjpeg
```

MJPEG defaults to `480x276` and quality `5`. Slow viewers drop old frames instead of accumulating latency. Override with `VIDEO_MJPEG_WIDTH`, `VIDEO_MJPEG_HEIGHT`, and `VIDEO_MJPEG_QUALITY`.

Raw H.264 capture:

```bash
curl -X POST http://localhost:3000/api/raw-video/start \
  -H 'content-type: application/json' \
  -d '{"capture":true,"inspectWithGstreamer":true}'

curl http://localhost:3000/api/raw-video/health
curl -X POST http://localhost:3000/api/raw-video/stop
npm run video:inspect -- captures/bebop-<timestamp>.h264
```

## Architecture

```text
Browser
  | WebSocket controls, telemetry, safety, perception, and map state
  | multipart MJPEG preview plus object overlay
Node.js server
  | fixed-rate scheduler and command watchdog
  | flight safety controller
  | latest-frame-only MJPEG fanout
  | raw H.264 capture and process supervision
  | perception schema validation and bounded fanout
  | external sidecar lifecycle supervision
DroneAdapter                       Perception sidecar container
  | simulated or node-bebop          | ORB-SLAM3 monocular fisheye SLAM
Parrot Bebop 2                      | YOLOX-Tiny ONNX via OpenCV DNN
                                    | pose, sparse map, trajectory, objects
```

Node supervises media and perception processes. Full frame decoding and inference never run on the flight-control event loop. Perception output is read-only.

## Real-hardware acceptance gate

Keep the propellers removed until calibration, recorded replay, relocalization, loop closure, axis direction, object overlay alignment, STOP latency under load, and sidecar crash isolation have all passed. Only then perform a low-altitude open-area hover test. Do not use perception output for autonomous control yet.
