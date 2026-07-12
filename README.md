# Bebop Web

A local Node.js control, video, perception, and mapping console for the Parrot Bebop 2.

## Current status

Implemented:

- TypeScript Node.js server
- WebSocket flight-control API
- Fixed-rate 20 Hz command scheduler
- 250 ms stale-input watchdog
- Single-browser pilot ownership
- Keyboard controls
- Telemetry display
- Height display in feet and meters
- Simulation mode for safe development
- Initial `node-bebop` adapter
- Direct MJPEG browser preview
- Latest-frame-only fanout for slow browser clients
- Raw H.264 capture from `getVideoStream()`
- Optional supervised GStreamer decode diagnostics
- Server-enforced arm window and takeoff gating
- Telemetry freshness movement lockout
- Battery and altitude safety policy
- Descent-only recovery at the altitude ceiling
- One-shot critical-battery landing request
- Safety status API and browser diagnostics
- Deterministic object-detection and SLAM simulation
- Supervised external perception sidecar protocol
- Schema-validated poses, detections, tracks, landmarks, and metrics
- Camera detection overlay and top-down map rendering
- GitHub Actions checks for typecheck, tests, build, and perception smoke tests

Still pending:

- Physical Bebop camera calibration
- A packaged ORB-SLAM3 and YOLOX sidecar image
- Recorded-flight SLAM evaluation
- WebRTC browser delivery
- Hardware-tested telemetry event mapping
- Hold-to-confirm emergency control
- Measured glass-to-glass latency

## Requirements

- Node.js 20 or newer
- npm
- For GStreamer diagnostics, `gst-launch-1.0`, `h264parse`, and `avdec_h264`
- For real drone mode, a computer connected to the Bebop 2 Wi-Fi network
- For real perception, an external sidecar implementing the documented newline-delimited JSON protocol

## Run

```bash
cp .env.example .env
npm install
npm run dev
```

Open `http://localhost:3000`.

Simulation mode is the default. Set `DRONE_MODE=bebop` for the physical drone.

The deterministic perception simulation starts automatically in simulated drone mode. Physical Bebop mode defaults perception to `disabled`, so fake map data can never be mistaken for real tracking.

## Perception and SLAM

The dashboard renders:

- object detections and class recognition over the video feed
- persistent recognized tracks
- camera pose and heading
- trajectory history
- SLAM landmarks
- world-positioned recognized objects
- tracking, calibration, scale, latency, and frame-rate status

The real adapter targets ORB-SLAM3 for monocular fisheye SLAM and YOLOX exported to ONNX for object detection. Both run outside the flight-control process. Perception is read-only and cannot issue piloting commands.

The current Bebop adapter does not expose synchronized raw IMU samples or camera-to-IMU timing, so the real protocol requests monocular SLAM. It must not be described or configured as visual-inertial SLAM until that data and calibration path exists.

Full architecture, protocol, configuration, tradeoffs, and real-hardware acceptance gates are in [`docs/perception.md`](docs/perception.md).

Run the complete simulation checks:

```bash
npm run typecheck
npm run check:client
npm test
npm run perception:smoke
```

`perception:smoke` builds the application, launches an external mock sidecar, validates its map and detection stream, then launches the compiled Bebop Web server and verifies the HTTP API, WebSocket lifecycle, reset, stop, restart, detections, landmarks, trajectory, and dashboard assets.

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

Takeoff is rejected unless all of these are true:

- The drone is connected.
- Telemetry is fresh.
- The drone reports `landed`.
- Battery is above the configured minimum.
- The operator clicked **Arm** within the active arm window.

The arm state expires automatically and is consumed by a successful takeoff request. It is also cleared on disconnect, landing, emergency, pilot disconnect, and server shutdown.

Active movement commands are replaced with a zero command when telemetry becomes stale. At the configured altitude ceiling, climb, yaw, pitch, and roll are rejected while a pure descent remains available. At critical battery while airborne, the server sends one landing request and stops movement.

Safety status is available at:

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

`MAXIMUM_ALTITUDE_METERS` may be set lower than 120, but the application refuses to start if it is configured above 120 meters, approximately 394 feet. The dashboard-reported height is relative to the takeoff point and is not terrain-following above-ground-level data.

The 120-meter application ceiling is intentionally below 400 feet. The dashboard cannot verify terrain changes, controlled airspace authorization, proximity to structures, temporary flight restrictions, or other operating conditions. These safeguards do not replace the drone firmware, the original controller, airspace checks, or normal flight precautions.

## Real Bebop validation

1. Remove the propellers.
2. Connect the host to the Bebop Wi-Fi network.
3. Start the server with `DRONE_MODE=bebop npm run dev`.
4. Click **Connect** and confirm telemetry.
5. Click **Acquire controls**.
6. Click **Arm** and confirm the countdown appears.
7. Confirm **Take off** becomes enabled only while the safety checks pass.
8. Let the arm window expire and verify takeoff becomes disabled.
9. Start MJPEG preview and inspect `/api/video/health`.
10. Capture raw H.264 and validate it with GStreamer.
11. Verify browser disconnect immediately stops movement and disarms.
12. Verify the configured altitude ceiling blocks rise and lateral movement but still permits descent.
13. Configure the external perception sidecar and replay recorded video before live tracking.
14. Confirm a sidecar crash does not affect STOP, Land, Emergency, or the command watchdog.
15. Reinstall propellers only after all no-propeller tests pass.

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

Use `PERCEPTION_BACKEND=external` and set `PERCEPTION_COMMAND` for the real sidecar. Use `disabled` to remove perception entirely.

## MJPEG endpoints

```text
POST /api/video/start
POST /api/video/stop
GET  /api/video/health
GET  /video.mjpeg
```

MJPEG is the compatibility preview. Each browser has an effective one-frame buffer, so slow viewers drop old frames rather than accumulating latency.

The preview defaults to `480x276` with FFmpeg MJPEG quality `5` to keep encoding latency low. Override these with `VIDEO_MJPEG_WIDTH`, `VIDEO_MJPEG_HEIGHT`, and `VIDEO_MJPEG_QUALITY` (1 is highest quality, 31 is fastest/lowest quality).

## Raw H.264 capture

Start capture and optionally pipe the same stream through GStreamer:

```bash
curl -X POST http://localhost:3000/api/raw-video/start \
  -H 'content-type: application/json' \
  -d '{"capture":true,"inspectWithGstreamer":true}'
```

Check health:

```bash
curl http://localhost:3000/api/raw-video/health
```

Stop capture:

```bash
curl -X POST http://localhost:3000/api/raw-video/stop
```

Captures are written to `captures/` by default and intentionally ignored by Git. Override the path with `VIDEO_CAPTURE_PATH` or the directory with `VIDEO_CAPTURE_DIR`.

Replay and inspect a saved capture:

```bash
npm run video:inspect -- captures/bebop-<timestamp>.h264
```

The diagnostic GStreamer pipeline is:

```text
fdsrc -> bounded leaky queue -> h264parse -> avdec_h264 -> fakesink
```

## Architecture

```text
Browser
  | WebSocket controls, telemetry, safety, perception, and map state
  | multipart MJPEG preview plus object overlay
Node.js server
  | fixed-rate scheduler and command watchdog
  | flight safety controller
  | altitude-aware command filter
  | latest-frame-only MJPEG fanout
  | raw H.264 capture and process supervision
  | perception schema validation and bounded fanout
  | external sidecar lifecycle supervision
DroneAdapter                       Perception sidecar
  | simulated or node-bebop          | ORB-SLAM3 monocular fisheye SLAM
Parrot Bebop 2                      | YOLOX ONNX object detection
```

The intended final media path remains:

```text
Bebop H.264 -> supervised media process -> WebRTC -> Browser
                 |
                 +-> ORB-SLAM3 + YOLOX sidecar -> validated map and detections
```

Node.js supervises and signals media and perception processes. It does not decode full frames or run inference on the flight-control event loop.

## Next milestone

1. Calibrate the exact stabilized Bebop camera stream and publish the calibration file.
2. Package a pinned ORB-SLAM3 and YOLOX sidecar container.
3. Replay recorded indoor and outdoor sequences and measure drift, relocalization, loop closure, detection accuracy, and latency.
4. Validate perception process failure while measuring STOP and command scheduler latency.
5. Add a GStreamer WebRTC pipeline and signaling.
