# Bebop Web

A local Node.js control, video, object-detection, and SLAM dashboard for the Parrot Bebop 2.

## Implemented

- WebSocket flight controls with a 20 Hz scheduler and 250 ms stale-input watchdog
- immediate STOP, Land, and Emergency paths independent of perception
- telemetry, battery, signal, and height display
- direct ARStream2 H.264 reception and low-latency MJPEG preview
- automatic drone connection, decoded-video startup, and SLAM startup
- native ORB-SLAM3 monocular sidecar
- YOLOX-Tiny ONNX object detection through OpenCV DNN
- persistent detection track IDs
- pose, trajectory, accumulated landmarks, and loop-change output
- interactive local SVG map with pan, zoom, fit, follow, layers, tooltips, and JSON export
- measured Bebop 2 bootstrap camera calibration at 428x240
- unit-specific camera calibration utility
- deterministic simulation and production sidecar replay tests

Perception is read-only. It cannot issue takeoff, movement, STOP, Land, or Emergency commands.

## Requirements

- Node.js 20 or newer
- npm
- Docker Desktop for the real ORB-SLAM3 and YOLOX sidecar
- FFmpeg
- a computer connected to the Bebop 2 Wi-Fi network for physical-drone mode
- Python 3 only when creating a unit-specific camera calibration

## Connect to Wi-Fi and map automatically

Build the sidecar once:

```bash
npm install
npm run perception:sidecar:build
npm run perception:sidecar:verify
```

Create the physical-drone configuration once:

```bash
cp .env.bebop.example .env
```

For each mapping session:

1. Power on the Bebop 2.
2. Connect the Mac to the Bebop Wi-Fi network.
3. Keep the propellers removed for the first physical validation.
4. Start Bebop Web:

```bash
npm run dev
```

5. Open `http://localhost:3000`.

The launcher automatically performs this sequence:

```text
connect to Bebop
  -> start ARStream2 reception
  -> wait for the first decoded JPEG frame
  -> start the ORB-SLAM3 and YOLOX container
  -> wait for ORB-SLAM3 tracking
  -> stream the map and detections to the dashboard
```

If decoded video stalls, the perception process faults, or ORB-SLAM3 cannot establish tracking within the configured timeout, the supervisor stops video and perception and retries. Flight controls remain isolated from this recovery loop.

The dashboard should progress through `initializing` to `tracking`. Move the drone by hand with the propellers removed and confirm that the path and landmarks change before attempting any propeller-on test.

## Bootstrap calibration

`.env.bebop.example` uses:

```text
config/perception/bebop2-upstream-428x240.yaml
```

This file is derived from the published 856x480 Bebop 2 camera calibration and scaled exactly by 0.5. The decoder is therefore fixed to 428x240 so the image geometry and intrinsics remain aligned.

This allows mapping to start immediately without a checkerboard session. It is a camera-family calibration, not a measurement of this specific drone. A unit-specific calibration can reduce reprojection error and drift.

## Unit-specific calibration

Start Bebop Web with video running, then use a printed chessboard with nine by six inner corners:

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

Then change `.env`:

```dotenv
PERCEPTION_CALIBRATION_FILE=config/perception/bebop2.yaml
```

Recalibrate whenever the stream resolution, stabilization, resize, or crop changes.

## Map scale

The Bebop path currently uses monocular ORB-SLAM3 without synchronized raw IMU samples. Monocular translation scale is arbitrary, so the dashboard labels horizontal coordinates as relative units (`u`), not meters. Altitude telemetry remains displayed separately in real units.

A future synchronized visual-inertial or externally scale-anchored path can report metric map coordinates.

## Interactive map

The dashboard renderer is local and has no runtime CDN dependency. It supports:

- drag to pan
- wheel or trackpad zoom around the pointer
- double-click or **Fit map** to reset
- **Follow drone** centering
- landmark, path, and mapped-object layers
- landmark and object tooltips
- JSON export

Object boxes are drawn over the camera preview. Monocular detections do not have reliable depth, so objects appear on the top-down map only when a world position is available. Approximate placement is opt-in with `OBJECT_POSITION_ESTIMATE=true`.

## Verify the complete perception stack

```bash
npm run perception:sidecar:verify
```

This command requires the Docker image and verifies:

- the native binaries load and link
- the ORB vocabulary and settings load
- deterministic 3D frames make ORB-SLAM3 reach tracking
- ORB-SLAM3 creates map points and tracks features
- YOLOX loads and completes CPU inference with finite output
- a synthetic AVI is processed through the production sidecar VideoCapture path
- production NDJSON snapshots contain tracked poses, trajectory growth, landmarks, and inference metrics

Run the Node and dashboard checks:

```bash
npm run typecheck
npm run check:client
npm test
npm run perception:smoke
```

## Safe simulation

```bash
cp .env.example .env
npm install
npm run dev
```

Open `http://localhost:3000`. Simulation mode starts deterministic perception automatically and exercises the same dashboard schema and renderer.

## Automatic mapping settings

The physical profile includes:

```dotenv
AUTO_START_MAPPING=true
AUTO_START_RETRY_MS=2000
AUTO_START_FRAME_TIMEOUT_MS=15000
AUTO_START_STALE_FRAME_MS=5000
AUTO_START_TRACKING_TIMEOUT_MS=30000
AUTO_START_POLL_MS=500
```

Set `AUTO_START_MAPPING=false` to return to manual Connect, Start video, and Start perception controls.

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

## Enforced flight safety

Takeoff is rejected unless:

- the drone is connected
- telemetry is fresh
- the drone reports `landed`
- battery is above the configured minimum
- the operator clicked **Arm** within the active arm window

The arm state expires and is cleared on disconnect, landing, emergency, pilot disconnect, and server shutdown. At the configured altitude ceiling, climb and lateral movement are rejected while pure descent remains available. Critical battery requests a landing and clears movement.

## APIs

```text
GET  /api/health
GET  /api/state
GET  /api/safety
GET  /api/video/health
POST /api/video/start
POST /api/video/stop
GET  /video.mjpeg
GET  /api/perception/status
POST /api/perception/start
POST /api/perception/stop
POST /api/perception/reset
```

## Architecture

```text
Browser
  | WebSocket controls, telemetry, safety, perception, and map state
  | multipart MJPEG preview plus object overlay
Node launcher
  | automatic connect/video/SLAM supervisor
Node server
  | command scheduler and watchdog
  | flight safety controller
  | latest-frame-only MJPEG fanout
  | perception schema validation and bounded fanout
DroneAdapter                       Perception sidecar container
  | node-bebop command channel       | ORB-SLAM3 monocular SLAM
  | ARStream2 H.264 receiver         | YOLOX-Tiny ONNX via OpenCV DNN
Parrot Bebop 2                      | pose, landmarks, trajectory, objects
```

Full perception design and protocol details are in [`docs/perception.md`](docs/perception.md).

## Physical acceptance gate

The automated and replay tests provide high confidence in the software path, but they cannot prove this individual drone's radio environment, exact optical calibration, or physical flight behavior. Keep the propellers removed while confirming real video, tracking, map direction, object overlay alignment, STOP latency under CPU load, and sidecar crash isolation. Only then perform a low-altitude open-area hover test. Do not use perception output for autonomous flight control.
