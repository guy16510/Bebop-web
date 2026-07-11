# Bebop Web

A minimal local Node.js control console for the Parrot Bebop 2.

## Current status

Implemented:

- TypeScript Node.js server
- WebSocket flight-control API
- Fixed-rate 20 Hz command scheduler
- 250 ms stale-input watchdog
- Single-browser pilot ownership
- Keyboard controls
- Telemetry display
- Simulation mode for safe development
- Initial `node-bebop` adapter
- Direct MJPEG browser preview
- Latest-frame-only fanout for slow browser clients
- Raw H.264 capture from `getVideoStream()`
- Optional supervised GStreamer decode diagnostics
- Server-enforced arm window and takeoff gating
- Telemetry freshness movement lockout
- Battery and altitude safety policy
- One-shot critical-battery landing request
- Safety status API and browser diagnostics
- GitHub Actions checks for typecheck, tests, and build

Still pending:

- WebRTC browser delivery
- Hardware-tested telemetry event mapping
- Hold-to-confirm emergency control
- Measured glass-to-glass latency

## Requirements

- Node.js 20 or newer
- npm
- For GStreamer diagnostics, `gst-launch-1.0`, `h264parse`, and `avdec_h264`
- For real drone mode, a computer connected to the Bebop 2 Wi-Fi network

## Run

```bash
cp .env.example .env
npm install
npm run dev
```

Open `http://localhost:3000`.

Simulation mode is the default. Set `DRONE_MODE=bebop` for the physical drone.

## Keyboard controls

| Key | Action |
| --- | --- |
| W / S | Pitch forward / backward |
| A / D | Roll left / right |
| Q / E | Yaw left / right |
| R / F | Rise / descend |
| Space | Stop movement |

The browser sends desired state at 20 Hz. The server owns the actual command frequency and resets movement after 250 ms without input.

## Enforced safety behavior

Takeoff is rejected unless all of these are true:

- The drone is connected.
- Telemetry is fresh.
- The drone reports `landed`.
- Battery is above the configured minimum.
- The operator clicked **Arm** within the active arm window.

The arm state expires automatically and is consumed by a successful takeoff request. It is also cleared on disconnect, landing, emergency, pilot disconnect, and server shutdown.

Active movement commands are replaced with a zero command when telemetry becomes stale or the configured altitude limit is exceeded. At critical battery while airborne, the server sends one landing request and stops movement.

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
MAXIMUM_ALTITUDE_METERS=10
```

These application safeguards do not replace the drone firmware, the original controller, or normal flight precautions.

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
12. Reinstall propellers only after all no-propeller tests pass.

## MJPEG endpoints

```text
POST /api/video/start
POST /api/video/stop
GET  /api/video/health
GET  /video.mjpeg
```

MJPEG is the compatibility preview. Each browser has an effective one-frame buffer, so slow viewers drop old frames rather than accumulating latency.

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
  | WebSocket controls, telemetry, and safety status
  | multipart MJPEG preview
Node.js server
  | fixed-rate scheduler and command watchdog
  | flight safety controller
  | latest-frame-only MJPEG fanout
  | raw H.264 capture and process supervision
DroneAdapter
  | simulated or node-bebop
Parrot Bebop 2
```

The intended final media path remains:

```text
Bebop H.264 -> supervised GStreamer -> WebRTC -> Browser
```

Node.js supervises and signals the media process. It does not decode full frames on the flight-control event loop.

## Next milestone

1. Verify CI after the live safety integration.
2. Validate telemetry and raw capture against the physical Bebop 2.
3. Add hold-to-confirm emergency handling.
4. Add a GStreamer WebRTC pipeline and signaling.
5. Measure MJPEG versus WebRTC latency.
