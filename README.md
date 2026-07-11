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
- Video health endpoints
- GitHub Actions checks for typecheck, tests, and build

Still pending:

- WebRTC browser delivery
- Hardware-tested telemetry event mapping
- Arm and confirmation safety state machine
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

The browser sends desired state at 20 Hz. The server owns the actual drone command frequency and resets movement after 250 ms without input.

## Real Bebop validation

1. Remove the propellers.
2. Connect the host to the Bebop Wi-Fi network.
3. Start the server with `DRONE_MODE=bebop npm run dev`.
4. Click **Connect** and confirm telemetry.
5. Start MJPEG preview and inspect `/api/video/health`.
6. Capture raw H.264 using the endpoint below.
7. Inspect the saved fixture with GStreamer.
8. Reinstall propellers only after control and disconnect behavior are verified.

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

This verifies whether the raw stream is decodable without involving the browser or flight-control loop.

## Architecture

```text
Browser
  | WebSocket controls and telemetry
  | multipart MJPEG preview
Node.js server
  | fixed-rate scheduler and watchdog
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

## Safety limitations

This is experimental software. It does not replace the Bebop firmware failsafes or the original controller. Current code has a movement watchdog and disconnect stop, but it does not yet have complete arm, battery, altitude, telemetry-staleness, and emergency-confirmation protections.

## Next milestone

1. Validate raw capture format against the physical Bebop 2.
2. Add a real GStreamer WebRTC pipeline.
3. Add SDP and ICE signaling through the existing WebSocket server.
4. Measure MJPEG versus WebRTC latency.
5. Add full safety-state enforcement before flight testing.
